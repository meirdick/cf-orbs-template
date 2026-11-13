// OrbSession DO (D2, D8, D11, D13, D15): one per orb, named `orb:<orbId>`.
// RPC surface = OrbSessionApi (api.ts) + alarm(). Ops run in the background in one ExclusiveQueue;
// callers long-poll getOp. Op logic lives in spawn/pause/delete/alarm; the journal glue is
// runOpWithJournal so it is testable without a DO.
import { DurableObject } from "cloudflare:workers";
import type { OrbSessionApi } from "../api";
import { parseConfig } from "../core/config";
import { type Clock, type KV, realClock, wrapContainer, wrapStorage } from "../core/container-port";
import {
  DEFAULT_CONFIG,
  JOB_DEADLINE_MS,
  type OpRecord,
  type OpRequest,
  type OrbStatus,
  type ProviderConfig,
  type RegistryClient,
  WARM_JOB_TIMEOUT_MS,
  type WarmResult,
} from "../core/types";
import type { Env } from "../env";
import { REGISTRY_DO_NAME } from "../env";
import { runAlarm } from "./alarm";
import {
  BENCH_LEASE_MS,
  BENCH_ORB_RE,
  type BenchDeps,
  type BenchStartRequest,
  benchDestroy,
  benchSnapshot,
  benchSnapshotName,
  benchStart,
} from "./bench";
import type { OrbContext } from "./context";
import { runDelete } from "./delete";
import { ExclusiveQueue } from "./exclusive";
import {
  appendProgress,
  diskImageState,
  errText,
  finishOp,
  handleExpiresAt,
  iso,
  loadOrb,
  markRunning,
  newOrbRecord,
  openOp,
  pruneOps,
  getOp as readOp,
  recoverInflight,
  redactLine,
  redactWith,
} from "./journal";
import { runPause } from "./pause";
import { isWarmOrbId, queueWarmJob, runWarmAlarm } from "./prewarm";
import { LOGTAIL_SH, STATUS_SH } from "./scripts";
import { runSpawn, SCRIPT_ENV, sh } from "./spawn";

/** Loose result shapes so each op module can return a richer type. */
export interface OpRunners {
  runSpawn(
    ctx: OrbContext,
    req: OpRequest,
  ): Promise<{ ok: boolean; error?: string; source?: unknown; wakeMs?: number }>;
  runPause(ctx: OrbContext, req: OpRequest): Promise<{ ok: boolean; error?: string; handle?: unknown }>;
  runDelete(ctx: OrbContext): Promise<unknown>;
}

export const REAL_OPS: OpRunners = { runSpawn, runPause, runDelete };

/** OrbContext without the per-op parts. */
export type OrbBase = Omit<OrbContext, "say" | "deadline">;

/** Wakes long-polls when an op changes. In-memory; a restart only costs one poll interval. */
export class OpNotifier {
  private waiters = new Map<string, Set<() => void>>();
  notify(opId: string): void {
    const set = this.waiters.get(opId);
    if (!set) return;
    this.waiters.delete(opId);
    for (const f of set) f();
  }
  /** Resolves on the next notify(opId). Call cancel() if you stop waiting. */
  next(opId: string): { promise: Promise<void>; cancel: () => void } {
    let f: () => void = () => {};
    const promise = new Promise<void>((r) => {
      f = r;
    });
    let set = this.waiters.get(opId);
    if (!set) {
      set = new Set();
      this.waiters.set(opId, set);
    }
    set.add(f);
    return {
      promise,
      cancel: () => {
        this.waiters.get(opId)?.delete(f);
      },
    };
  }
}

export interface OpRuntime {
  /** Container work queue. One per DO; shared by ops and alarm (D13). */
  queue: ExclusiveQueue;
  /** Serializes openOp so two identical submits cannot both create an op. */
  openLock: ExclusiveQueue;
  notifier: OpNotifier;
  /** DO log line (already redacted). */
  log: (line: string) => void;
}

export function newRuntime(log: (line: string) => void = () => {}): OpRuntime {
  return { queue: new ExclusiveQueue(), openLock: new ExclusiveQueue(), notifier: new OpNotifier(), log };
}

const TERMINAL = new Set(["succeeded", "failed"]);
export const isTerminal = (r: OpRecord) => TERMINAL.has(r.phase);

function asFailed(err: string, orbId: string): string {
  const line = err.replace(/\s*\n\s*/g, " ").trim() || "unknown error";
  return line.startsWith("Failed:")
    ? line
    : `Failed: ${line} — fix: retry the message; run cf-orbs logs ${orbId}`;
}

/**
 * Open (or attach to) an op in the journal and, if new, run it in the queue.
 * `done` settles with the final record; it never rejects.
 */
export async function runOpWithJournal(
  base: OrbBase,
  kv: KV,
  req: OpRequest,
  ops: OpRunners,
  rt: OpRuntime = newRuntime(),
): Promise<{ opId: string; attached: boolean; done: Promise<OpRecord | undefined> }> {
  const { record, attached } = await rt.openLock.run(() =>
    openOp(kv, base.orbId, req, iso(base.clock.now())),
  );
  const opId = record.opId;
  if (attached) {
    rt.log(`${req.op} ${opId}: attached to in-flight op`);
    return { opId, attached, done: Promise.resolve(record) };
  }
  rt.log(`${req.op} ${opId}: queued`);
  rt.notifier.notify(opId);
  const startedMs = Date.parse(record.startedAt);
  const deadline = startedMs + JOB_DEADLINE_MS;

  // say() is sync for ops; appends are chained so lines keep their order and finish waits for them.
  let chain: Promise<void> = Promise.resolve();
  const append = (line: string, wake: boolean) => {
    const secs = ((base.clock.now() - startedMs) / 1000).toFixed(1);
    const clean = redactWith(req.token, `${secs}s ${line}`);
    rt.log(`${req.op} ${opId}: ${clean}`);
    chain = chain
      .then(() => appendProgress(kv, opId, clean))
      .then(() => {
        if (wake) rt.notifier.notify(opId);
      })
      .catch(() => {});
  };
  const say = (line: string) => append(line, true);
  const ctx: OrbContext = { ...base, say, deadline };

  const work = async (): Promise<OpRecord | undefined> => {
    let phase: "succeeded" | "failed" = "failed";
    let patch: Partial<OpRecord> = {};
    try {
      await markRunning(kv, opId);
      rt.notifier.notify(opId);
      if (req.op === "spawn") {
        const r = await ops.runSpawn(ctx, req);
        if (r.ok) {
          phase = "succeeded";
          patch = { result: { source: r.source, wakeMs: r.wakeMs } };
        } else patch = { error: asFailed(r.error ?? "spawn failed", base.orbId) };
      } else if (req.op === "pause") {
        const r = await ops.runPause(ctx, req);
        if (r.ok) {
          phase = "succeeded";
          patch = r.handle === undefined ? {} : { result: { handle: r.handle } };
        } else patch = { error: asFailed(r.error ?? "pause failed", base.orbId) };
      } else {
        await ops.runDelete(ctx);
        phase = "succeeded";
      }
    } catch (e) {
      patch = { error: asFailed(errText(e), base.orbId) };
    }
    // No wake for the last line: the poll wakes once, on the final record, with this line in it.
    if (phase === "succeeded") append(`${req.op} done`, false);
    await chain;
    if (patch.error) patch.error = redactWith(req.token, patch.error);
    try {
      await finishOp(kv, opId, phase, { ...patch, finishedAt: iso(base.clock.now()) });
    } catch (e) {
      rt.log(`${req.op} ${opId}: could not record result: ${redactLine(errText(e))}`);
    }
    rt.log(`${req.op} ${opId}: ${phase}${patch.error ? ` ${patch.error}` : ""}`);
    rt.notifier.notify(opId);
    return readOp(kv, opId).catch(() => undefined);
  };

  const done = rt.queue.run(work).catch((e: unknown) => {
    rt.log(`${req.op} ${opId}: runner crashed: ${redactLine(errText(e))}`);
    return undefined;
  });
  return { opId, attached: false, done };
}

/**
 * Long-poll: return when the op is terminal, its progress is longer than `since`
 * (default: its length now), or waitMs passes. undefined = unknown op.
 */
export async function waitForOp(
  kv: KV,
  opId: string,
  waitMs: number,
  since: number | undefined,
  clock: Clock,
  notifier: OpNotifier,
): Promise<OpRecord | undefined> {
  // Take the waiter before each read: a notify while the read is in flight then still wakes this poll.
  let w = notifier.next(opId);
  try {
    let rec = await readOp(kv, opId);
    if (!rec) return undefined;
    const base = since ?? rec.progress.length;
    const until = clock.now() + Math.max(0, Math.min(waitMs, 25_000));
    while (!isTerminal(rec) && rec.progress.length <= base && clock.now() < until) {
      await Promise.race([w.promise, clock.sleep(Math.min(1000, until - clock.now()))]);
      w.cancel();
      w = notifier.next(opId);
      rec = (await readOp(kv, opId)) ?? rec;
    }
    return rec;
  } finally {
    w.cancel();
  }
}

const LOG_RING = 200;
const OP_RETENTION_MS = 24 * 3600_000;

export class OrbSession extends DurableObject<Env> implements OrbSessionApi {
  private readonly kv: KV;
  private config: ProviderConfig = structuredClone(DEFAULT_CONFIG);
  private configError?: string;
  private readonly ring: string[] = [];
  private readonly rt: OpRuntime;
  private orbIdCache?: string;
  /** A DO does not move while it is alive: look its colo up once (retry only after a failed lookup). */
  private doColoP?: Promise<string | undefined>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.kv = wrapStorage(ctx.storage);
    this.rt = newRuntime((line) => this.note(line));
    try {
      this.config = parseConfig(env.CF_ORBS_CONFIG);
    } catch (e) {
      this.configError = errText(e);
      this.note(this.configError);
    }
    void ctx.blockConcurrencyWhile(async () => {
      // D8: the inactivity timeout does not survive a DO restart; alarms do.
      if (ctx.container?.running) {
        await ctx.container
          .setInactivityTimeout(this.config.inactivityTimeoutMinutes * 60_000)
          .catch((e: unknown) => this.note(`setInactivityTimeout failed: ${errText(e)}`));
      }
      // D13: no op survives a restart; fail the ones left in flight so callers stop waiting.
      const failed = await recoverInflight(this.kv, iso(Date.now()));
      for (const op of failed) this.note(`recovered ${op.op} ${op.opId}: failed after restart`);
      // The alarm that the lost op would have armed never comes. Arm it here so a running or
      // half-started container still gets keep-alive, heartbeat, watchdog and lost-detection (D15).
      const st = (await loadOrb(this.kv))?.state;
      const live = st === "starting" || st === "awake" || st === "pausing" || st === "warm";
      if (ctx.container?.running || failed.length > 0 || live) {
        await this.armAlarmSoon().catch((e: unknown) => this.note(`setAlarm failed: ${errText(e)}`));
      }
    });
  }

  // ---- RPC ----

  async submitOp(req: OpRequest): Promise<{ opId: string; attached: boolean }> {
    if (this.configError) throw new Error(this.configError);
    const base = await this.base();
    if (isWarmOrbId(base.orbId))
      throw new Error("Failed: warm-* orb ids are for prewarm only — fix: use the ORB_ID from Amp");
    const r = await runOpWithJournal(base, this.kv, req, REAL_OPS, this.rt);
    if (!r.attached) {
      this.ctx.waitUntil(
        r.done.then(async () => {
          await this.armAlarmSoon();
          await pruneOps(this.kv, iso(Date.now() - OP_RETENTION_MS)).catch(() => 0);
        }),
      );
    }
    return { opId: r.opId, attached: r.attached };
  }

  async getOp(opId: string, waitMs: number, since?: number): Promise<OpRecord | null> {
    return (await waitForOp(this.kv, opId, waitMs, since, realClock, this.rt.notifier)) ?? null;
  }

  async status(): Promise<OrbStatus> {
    const orbId = (await this.orbId()) ?? "unknown";
    const now = Date.now();
    const orb = (await loadOrb(this.kv)) ?? newOrbRecord(orbId, this.config, iso(now));
    const running = this.ctx.container?.running ?? false;
    const out: OrbStatus = { orb, containerRunning: running };
    const inflight = (await this.kv.get<string[]>("ops:inflight")) ?? [];
    for (const id of inflight) {
      const op = await readOp(this.kv, id);
      if (op && !isTerminal(op)) {
        out.inFlightOp = { opId: op.opId, op: op.op, phase: op.phase, startedAt: op.startedAt };
        break;
      }
    }
    if (orb.handle) {
      out.snapshotExpiresAt = iso(handleExpiresAt(orb.handle));
      const disk = diskImageState(orb.handle, this.ctx.container?.images ?? {});
      if (disk.imageRef) out.diskImageRef = disk.imageRef;
      if (disk.currentImageRef) out.currentImageRef = disk.currentImageRef;
      if (disk.stale) out.diskImageStale = true;
    }
    if (running) out.bootstrap = await this.bootstrapAlive();
    const colo = await this.colo();
    if (colo) out.doColo = colo;
    return out;
  }

  /** Debug/bench route. Off unless cf-orbs.config.jsonc has "debugExec": true. */
  async exec(cmd: string[], timeoutMs: number): Promise<unknown> {
    if (!this.config.debugExec)
      throw new Error(
        'Failed: exec is disabled — fix: set "debugExec": true in cf-orbs.config.jsonc and run cf-orbs deploy',
      );
    if (!this.ctx.container?.running) return { error: "container not running" };
    const t0 = Date.now();
    try {
      const r = await wrapContainer(this.container()).exec(cmd, { env: { ...SCRIPT_ENV }, timeoutMs });
      return {
        ...r,
        stdout: redactLine(r.stdout),
        stderr: redactLine(r.stderr),
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return { error: errText(e), durationMs: Date.now() - t0 };
    }
  }

  /**
   * Bench routes. Same gate as exec. Only for bench-* orbs with no Amp orb record; they never
   * write the orb record or take a run slot. The alarm stops a leaked bench container after BENCH_LEASE_MS.
   */
  async benchStart(req: BenchStartRequest): Promise<unknown> {
    const d = await this.benchDeps();
    const r = await this.rt.queue.run(() => benchStart(d, req));
    if (r.ready) await this.ctx.storage.setAlarm(Date.now() + BENCH_LEASE_MS);
    return { ...r, doColo: r.ready ? await this.colo() : undefined };
  }

  async benchSnapshot(name: string): Promise<unknown> {
    const d = await this.benchDeps();
    return this.rt.queue.run(() => benchSnapshot(d, benchSnapshotName(d.orbId, name, Date.now())));
  }

  async benchDestroy(): Promise<unknown> {
    const d = await this.benchDeps();
    const r = await this.rt.queue.run(() => benchDestroy(d));
    await this.ctx.storage.deleteAlarm().catch(() => undefined);
    return r;
  }

  /** Prewarm job (warm-* orbs only, no orb record). Stores the job; the alarm runs it. Returns at once. */
  async warmStart(runId: string): Promise<{ orbId: string; queued: boolean }> {
    if (this.configError) throw new Error(this.configError);
    const orbId = (await this.orbId()) ?? "";
    if (await loadOrb(this.kv))
      throw new Error("Failed: this orb has an Amp orb record — fix: use a new warm-* orb id");
    await queueWarmJob(this.kv, orbId, runId, Date.now());
    await this.ctx.storage.setAlarm(Date.now());
    return { orbId, queued: true };
  }

  async logs(lines: number): Promise<{ containerRunning: boolean; log: string }> {
    const n = Math.max(1, Math.min(1000, Math.floor(lines) || 100));
    const running = this.ctx.container?.running ?? false;
    let tail = "container not running; no orb logs (state is in cf-orbs status)";
    if (running) {
      try {
        const [cmd, opts] = sh(LOGTAIL_SH, { LINES: String(n) });
        const r = await wrapContainer(this.container()).exec(cmd, { ...opts, timeoutMs: 15_000 });
        tail = r.stdout + (r.exitCode === 0 ? "" : `\n(logtail exit ${r.exitCode})`);
      } catch (e) {
        tail = `could not read orb logs: ${errText(e)}`;
      }
    }
    const control = this.ring.slice(-n).join("\n");
    const log = `${tail
      .split("\n")
      .map((l) => redactLine(l))
      .join("\n")
      .trimEnd()}\n== control plane\n${control}`;
    return { containerRunning: running, log };
  }

  /** D15: one alarm per orb. runAlarm decides what to do and when to come back. */
  override async alarm(): Promise<void> {
    if (this.configError) return;
    const base = await this.base().catch(() => undefined);
    if (!base) return;
    if (isWarmOrbId(base.orbId)) return this.warmAlarm(base);
    let rearm: number | null;
    try {
      const say = (line: string) => this.note(`alarm: ${redactLine(line)}`);
      const r = await this.rt.queue.run(() =>
        runAlarm({ ...base, say, deadline: Date.now() + JOB_DEADLINE_MS }),
      );
      rearm = r.rearmInMs;
    } catch (e) {
      this.note(`alarm failed: ${redactLine(errText(e))}`);
      rearm = this.ctx.container?.running ? this.config.alarmSeconds * 1000 : null;
    }
    if (rearm !== null) await this.ctx.storage.setAlarm(Date.now() + Math.max(1000, rearm));
  }

  // ---- internals ----

  /** Prewarm alarm: run the job, then the normal alarm stops anything left (no orb record → destroy). */
  private async warmAlarm(base: OrbBase): Promise<void> {
    const say = (line: string) => this.note(`alarm: ${redactLine(line)}`);
    // Backstop: if this DO dies during the job, this alarm finds the job started and destroys the container.
    await this.ctx.storage.setAlarm(Date.now() + WARM_JOB_TIMEOUT_MS + 60_000);
    try {
      await this.rt.queue.run(async () => {
        await runWarmAlarm({
          ...base,
          say,
          report: (runId: string, r: WarmResult) =>
            (
              this.env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as {
                recordWarmResult(runId: string, orbId: string, r: WarmResult): Promise<boolean>;
              }
            ).recordWarmResult(runId, base.orbId, r),
        });
        await runAlarm({ ...base, say, deadline: Date.now() + JOB_DEADLINE_MS });
      });
    } catch (e) {
      say(`prewarm alarm failed: ${errText(e)}`);
    }
    if (this.ctx.container?.running) {
      await this.ctx.storage.setAlarm(Date.now() + this.config.alarmSeconds * 1000);
      return;
    }
    // Done: drop the alarm and the little this DO stored.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private async benchDeps(): Promise<BenchDeps> {
    if (!this.config.debugExec)
      throw new Error(
        'Failed: bench is disabled — fix: set "debugExec": true in cf-orbs.config.jsonc and run cf-orbs deploy',
      );
    const orbId = await this.orbId();
    if (!orbId || !BENCH_ORB_RE.test(orbId))
      throw new Error(
        "Failed: bench ops run only on bench-* orbs — fix: use an orb id that starts with bench-",
      );
    if (await loadOrb(this.kv))
      throw new Error("Failed: this orb has an Amp orb record — fix: use a new bench-* orb id");
    return { container: wrapContainer(this.container()), clock: realClock, config: this.config, orbId };
  }

  private colo(): Promise<string | undefined> {
    this.doColoP ??= doColo().then((c) => {
      if (!c) this.doColoP = undefined;
      return c;
    });
    return this.doColoP;
  }

  private note(line: string): void {
    const l = `${new Date().toISOString()} ${redactLine(line)}`;
    this.ring.push(l);
    if (this.ring.length > LOG_RING) this.ring.splice(0, this.ring.length - LOG_RING);
    console.log(`[${this.orbIdCache ?? "orb"}] ${redactLine(line)}`);
  }

  private container(): Container {
    const c = this.ctx.container;
    if (!c)
      throw new Error(
        "Failed: OrbSession has no container — fix: check wrangler.jsonc containers and run cf-orbs deploy",
      );
    return c;
  }

  /** orb id from the DO name `orb:<id>`; stored once so alarms work even if the name is not exposed. */
  private async orbId(): Promise<string | undefined> {
    if (this.orbIdCache) return this.orbIdCache;
    const name = this.ctx.id.name;
    if (name?.startsWith("orb:")) {
      this.orbIdCache = name.slice(4);
      if ((await this.kv.get<string>("orbId")) !== this.orbIdCache)
        await this.kv.put("orbId", this.orbIdCache);
      return this.orbIdCache;
    }
    this.orbIdCache = (await this.kv.get<string>("orbId")) ?? (await loadOrb(this.kv))?.orbId;
    return this.orbIdCache;
  }

  private async base(): Promise<OrbBase> {
    const orbId = await this.orbId();
    if (!orbId)
      throw new Error(
        "Failed: orb id unknown for this Durable Object — fix: address orbs by name orb:<ORB_ID>",
      );
    return {
      orbId,
      container: wrapContainer(this.container()),
      kv: this.kv,
      clock: realClock,
      config: this.config,
      registry: this.env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as RegistryClient,
    };
  }

  /** After an op, make sure the D15 alarm runs within alarmSeconds (runAlarm sets the real cadence). */
  private async armAlarmSoon(): Promise<void> {
    const target = Date.now() + this.config.alarmSeconds * 1000;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > target) await this.ctx.storage.setAlarm(target);
  }

  private async bootstrapAlive(): Promise<OrbStatus["bootstrap"]> {
    try {
      const [cmd, opts] = sh(STATUS_SH);
      const r = await wrapContainer(this.container()).exec(cmd, { ...opts, timeoutMs: 5_000 });
      const m = /^alive (\d+)/.exec(r.stdout.trim());
      return m ? { alive: true, pid: Number(m[1]) } : { alive: false };
    } catch {
      return undefined;
    }
  }
}

/** Colo this DO runs in: a subrequest from the DO leaves from its colo. Best effort, never throws. */
async function doColo(): Promise<string | undefined> {
  try {
    const r = await fetch("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(3000) });
    return /^colo=([A-Z]{3})$/m.exec(await r.text())?.[1];
  } catch {
    return undefined;
  }
}
