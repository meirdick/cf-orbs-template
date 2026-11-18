// Spawn op (D6-D10, D13). Order: tombstone → run slot → start (or reuse) → readiness → bootstrap → connected.
// A warm orb (paused by Amp, container kept running) reuses its connected bootstrap: no restart.
import type { ExecOptions } from "../core/container-port";
import type {
  OpRequest,
  OrbRecord,
  OrbState,
  ProjectSnapshotMapping,
  ProviderConfig,
  SpawnEntry,
  WakeSource,
} from "../core/types";
import { SNAPSHOT_TTL_MS, SPAWN_HISTORY, TOMBSTONE_TTL_MS } from "../core/types";
import type { OrbContext } from "./context";
import { resolveImageKey } from "./images";
import {
  errText,
  type Handle,
  handleExpiresAt,
  iso,
  loadOrb,
  newOrbRecord,
  redactWith,
  saveOrb,
  tokenSha,
} from "./journal";
import { BOOT_CONNECTED_RE, BOOTSTRAP_SH, LOGTAIL_SH, RESUME_SH, WAIT_CONNECTED_SH } from "./scripts";

export type SpawnResult =
  | { ok: true; source: OrbRecord["lastWakeSource"]; wakeMs: number }
  | { ok: false; error: string };

export const NOT_FOUND = /Snapshot ".*" was not found/;
export const READY_CAP_MS = 90_000;
export const CONNECT_CAP_MS = 180_000;
export const SAFETY_MS = 10_000;
const LOG_LINES = 50;
/** One WAIT_CONNECTED_SH exec waits at most this long, so the run slot gets a heartbeat between execs. */
const CONNECT_STEP_MS = 60_000;
/** The amp binary. A restored disk pages it in lazily; reading it once in parallel with the bootstrap prelude helps. */
export const AMP_BIN = "/home/user/.amp/bin/amp";
export const PREFETCH_CMD = ["sh", "-c", `cat ${AMP_BIN} > /dev/null 2>&1; true`];

/** Env for every script exec. exec does not inherit image env, only PATH and a few shell vars. */
export const SCRIPT_ENV = { HOME: "/home/user", USER: "user", LANG: "C.UTF-8" } as const;

/** Env for BOOTSTRAP_SH and RESUME_SH from the config: huge pages and the /mnt/fast tmpfs (FAST_MEMORY). */
export function memoryEnv(config: ProviderConfig): Record<string, string> {
  return { HUGE_PAGES: config.hugePages ? "1" : "0", FAST_TMPFS_GB: String(config.fastTmpfsGb) };
}

export function sh(script: string, env: Record<string, string> = {}): [string[], ExecOptions] {
  return [["bash", "-c", script], { env: { ...SCRIPT_ENV, ...env } }];
}

export const deadlineError = (orbId: string) =>
  `Failed: spawn did not finish in 4 min 30 s — fix: retry the message; check cf-orbs status ${orbId}`;

type Plan =
  | { kind: "image"; imageKey: string; why: string }
  | { kind: "per-orb"; handle: Handle }
  | { kind: "project"; snapshotId: string; handle: Handle; mapping: ProjectSnapshotMapping };

/** What WAIT_CONNECTED_SH reported about amp after connect (AMP_CHECK=1). */
export type AmpCheck = { kind: "updated"; from: string; to: string } | { kind: "current"; version: string };

/** Parse the amp_check line: "amp: updated <old> -> <new>" or "amp: current <version>". */
export function parseAmpCheck(out: string): AmpCheck | undefined {
  const u = /^amp: updated (\S+) -> (\S+)\s*$/m.exec(out);
  if (u) return { kind: "updated", from: u[1] as string, to: u[2] as string };
  const c = /^amp: current (\S+)\s*$/m.exec(out);
  if (c) return { kind: "current", version: c[1] as string };
  return undefined;
}

/** "sha256:0123456789ab" from an image ref with a digest, else the tag or the ref. For log lines. */
export function shortImage(ref: string): string {
  const d = /@(sha256:[0-9a-f]{1,12})/.exec(ref);
  if (d) return d[1] as string;
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/**
 * projectSnapshotRefresh: why a restored project snapshot is out of date, or undefined when it is not (or we
 * cannot tell). (1) amp updated itself after the restore; (2) the image ORB_IMAGE maps to now differs from the
 * image the disk came from (a cf-orbs deploy with a new digest). Mappings from older code have no imageRef.
 */
export function staleReason(
  m: Pick<ProjectSnapshotMapping, "imageRef">,
  amp: AmpCheck | undefined,
  currentImageRef: string | undefined,
): string | undefined {
  const why: string[] = [];
  if (amp?.kind === "updated") why.push(`amp updated ${amp.from} -> ${amp.to}`);
  if (m.imageRef && currentImageRef && m.imageRef !== currentImageRef)
    why.push(`image changed ${shortImage(m.imageRef)} -> ${shortImage(currentImageRef)}`);
  return why.length > 0 ? why.join("; ") : undefined;
}

/** Setup-log hint after a forget: Amp may keep its cached snapshot and send the same id again. */
export const AMP_DELETE_HINT =
  "if new threads keep running setup, delete the cached snapshot in Amp → Orb Settings → Snapshots";

export type Ready =
  | { kind: "ready"; ms: number }
  | { kind: "not-found"; msg: string }
  | { kind: "timeout"; byDeadline: boolean }
  | { kind: "error"; msg: string };

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** What spawnOnce learned, for the spawn history entry. */
interface SpawnTrace {
  source?: WakeSource;
  ms?: number;
}

/** Spawn op. Every op that leaves an orb record adds one entry to OrbRecord.spawns (last SPAWN_HISTORY). */
export async function runSpawn(ctx: OrbContext, req: OpRequest): Promise<SpawnResult> {
  const t0 = ctx.clock.now();
  const trace: SpawnTrace = {};
  const r = await spawnOnce(ctx, req, trace);
  const entry: SpawnEntry = {
    at: iso(t0),
    ms: trace.ms ?? ctx.clock.now() - t0,
    ok: r.ok,
  };
  const source = r.ok ? r.source : trace.source;
  if (source) entry.source = source;
  if (!r.ok) entry.error = r.error.replace(/\s*\n\s*/g, " ").slice(0, 200);
  await recordSpawn(ctx, entry).catch(() => undefined);
  return r;
}

async function recordSpawn(ctx: OrbContext, entry: SpawnEntry): Promise<void> {
  const rec = await loadOrb(ctx.kv);
  if (!rec || rec.deletedAt) return; // no record (failed before the first save) or a tombstone
  rec.spawns = [...(rec.spawns ?? []), entry].slice(-SPAWN_HISTORY);
  await saveOrb(ctx.kv, rec, iso(ctx.clock.now()));
}

async function spawnOnce(ctx: OrbContext, req: OpRequest, trace: SpawnTrace): Promise<SpawnResult> {
  const { container, clock, kv, registry, orbId } = ctx;
  const token = req.token ?? "";
  const say = (s: string) => ctx.say(redactWith(token, s));
  const t0 = clock.now();
  const now = () => iso(clock.now());
  const left = () => ctx.deadline - clock.now() - SAFETY_MS;
  let slotHeld = false;

  const fail = (error: string): SpawnResult => ({ ok: false, error: redactWith(token, error) });

  if (!token)
    return fail("Failed: spawn job has no ORB_TOKEN — fix: update the amp CLI on the provider host");

  let rec = await loadOrb(kv);
  if (rec?.deletedAt) {
    if (clock.now() - Date.parse(rec.deletedAt) < TOMBSTONE_TTL_MS) {
      say(`orb was deleted at ${rec.deletedAt}; refusing to start it again`);
      return fail(`Failed: orb was deleted at ${rec.deletedAt} — fix: start a new thread`);
    }
    rec = undefined; // tombstone expired: treat as a new orb
  }
  rec ??= newOrbRecord(orbId, ctx.config, now());
  const prevState = rec.state;

  try {
    let source: NonNullable<OrbRecord["lastWakeSource"]>;
    let wakeMs = 0;
    /** Set when this spawn restored a project snapshot (D6 case 3). */
    let project: ProjectRestore | undefined;

    if (container.running && rec.state === "warm") {
      const w = await resumeWarm(ctx, token);
      if (w.ok) {
        for (const l of w.lines) say(`resume: ${l}`);
        trace.source = "warm";
        await Promise.all([
          container.setInactivityTimeout(ctx.config.inactivityTimeoutMinutes * 60_000),
          beat(ctx),
        ]);
        const ts = now();
        rec.state = "awake";
        rec.warmUntil = undefined;
        rec.awakeSince ??= ts;
        rec.lastWakeSource = "warm";
        rec.bootstrapTokenSha = w.sha;
        rec.dirtySince ??= ts;
        rec.lastSpawnMs = clock.now() - t0;
        trace.ms = rec.lastSpawnMs;
        await saveOrb(kv, rec, ts);
        say(
          `orb ready: amp kept running since the pause (warm); spawn took ${(rec.lastSpawnMs / 1000).toFixed(1)} s`,
        );
        return { ok: true, source: "warm", wakeMs: 0 };
      }
      say(`warm orb: ${w.reason}; starting amp again`);
    }

    if (container.running) {
      source = "running";
      say(`container already running (state ${rec.state}); reusing it`);
    } else {
      const plan = await choosePlan(ctx, rec, req, say);
      if ("error" in plan) return fail(plan.error);

      const slot = await registry.acquireRunSlot(orbId);
      if (!slot.ok) {
        const e = (slot as { error?: string }).error;
        say(`run slot refused: ${slot.running}/${slot.max} orbs running`);
        return fail(
          e ??
            `Failed: ${slot.running}/${slot.max} orbs already running — fix: raise maxRunning in cf-orbs.config.jsonc or pause idle threads`,
        );
      }
      slotHeld = true;
      rec.state = "starting";
      await saveOrb(kv, rec, now());

      const r = await startWithFallback(ctx, rec, plan, req, say);
      if (!r.ok) {
        slotHeld = false;
        if (r.alreadyRunning) return fail(r.error); // another job owns the container, its slot and the record
        await settleFailedStart(ctx, rec, prevState);
        await registry.releaseRunSlot(orbId);
        return fail(r.error);
      }
      if (r.alreadyRunning) rec = (await loadOrb(kv)) ?? rec; // the other job updated the record
      source = r.source;
      wakeMs = r.ms;
      project = r.project;
    }

    trace.source = source;
    await Promise.all([
      container.setInactivityTimeout(ctx.config.inactivityTimeoutMinutes * 60_000),
      beat(ctx),
    ]);

    // From here the container is up and ours: keep it for the watchdog even if bootstrap fails (D10).
    const ts = now();
    const kept = source === "running" && (rec.state === "awake" || rec.state === "warm");
    if (!kept || !rec.awakeSince) rec.awakeSince = ts;
    rec.warmUntil = undefined;
    rec.state = "awake";
    rec.lastWakeSource = source;
    rec.dirtySince ??= ts;
    rec.lastStop = undefined;
    await saveOrb(kv, rec, ts);
    slotHeld = false;
    if (left() <= 0) return fail(deadlineError(orbId));

    // D9: launch amp orb bootstrap. The token is only in exec env, never on disk or in logs.
    const sha = await tokenSha(token);
    const env: Record<string, string> = { ORB_TOKEN: token, ORB_TOKEN_SHA: sha, ...memoryEnv(ctx.config) };
    if (req.ampUrl) env.AMP_URL = req.ampUrl;
    const [cmd, opts] = sh(BOOTSTRAP_SH, env);
    let boot: { exitCode: number; stdout: string; stderr: string };
    try {
      boot = await container.exec(cmd, { ...opts, timeoutMs: Math.min(60_000, left()) });
    } catch (e) {
      boot = { exitCode: -1, stdout: "", stderr: errText(e) };
    }
    for (const l of tail(`${boot.stdout}\n${boot.stderr}`, 5)) say(`bootstrap: ${l}`);

    rec.bootstrapTokenSha = sha;
    await Promise.all([saveOrb(kv, rec, now()), beat(ctx)]);

    if (boot.exitCode !== 0) {
      await sayLogTail(ctx, say, token);
      return fail(
        `Failed: amp orb bootstrap did not start (exit ${boot.exitCode}${lastLine(boot) ? `: ${lastLine(boot)}` : ""}) — fix: see the log lines above; run cf-orbs logs ${orbId}`,
      );
    }

    // D10: success only when bootstrap is alive and has connected to the thread. BOOTSTRAP_SH checks both
    // while it waits (ALIVE_SECONDS); only a retry, a slow connect or the projectSnapshotRefresh amp check
    // needs the separate wait.
    const check = project !== undefined && ctx.config.projectSnapshotRefresh === "on-change";
    const seen = check ? null : BOOT_CONNECTED_RE.exec(boot.stdout);
    const conn: Conn = seen
      ? { kind: "connected", ms: Number(seen[1]) }
      : await waitConnected(ctx, Math.min(CONNECT_CAP_MS, left()), check);
    if (conn.kind !== "connected") {
      await sayLogTail(ctx, say, token);
      if (conn.kind === "dead")
        return fail(
          `Failed: amp orb bootstrap stopped before it connected (${conn.reason}) — fix: see the log lines above; run cf-orbs logs ${orbId}`,
        );
      if (left() <= 0) return fail(deadlineError(orbId));
      return fail(
        `Failed: amp orb bootstrap did not connect in ${Math.round(conn.waitedMs / 1000)} s — fix: check that no other provider uses this token; run cf-orbs logs ${orbId}`,
      );
    }

    rec.lastSpawnMs = clock.now() - t0;
    trace.ms = rec.lastSpawnMs;
    await saveOrb(kv, rec, now());
    say(
      `orb ready: connected to Amp in ${(conn.ms / 1000).toFixed(1)} s; spawn took ${(rec.lastSpawnMs / 1000).toFixed(1)} s (from ${source})`,
    );
    if (check && project) await refreshProjectSnapshot(ctx, req, project, conn.amp, say);
    return { ok: true, source, wakeMs };
  } catch (e) {
    if (slotHeld) {
      if (container.running) await container.destroy().catch(() => undefined);
      await registry.releaseRunSlot(orbId).catch(() => undefined);
    }
    say(`spawn error: ${errText(e)}`);
    return fail(`Failed: spawn error: ${errText(e)} — fix: retry the message; run cf-orbs logs ${orbId}`);
  }
}

/** Warm orb: reuse the bootstrap if it is alive and connected (RESUME_SH). One exec, no token in env. */
async function resumeWarm(
  ctx: OrbContext,
  token: string,
): Promise<{ ok: true; sha: string; lines: string[] } | { ok: false; reason: string }> {
  const sha = await tokenSha(token);
  try {
    const [cmd, opts] = sh(RESUME_SH, { ORB_TOKEN_SHA: sha, ...memoryEnv(ctx.config) });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 15_000 });
    if (r.exitCode === 0) return { ok: true, sha, lines: r.stdout.match(/^(thp|tmpfs): .*$/gm) ?? [] };
    const reason = /^reason: (.*)$/m.exec(r.stdout)?.[1] ?? `resume check exit ${r.exitCode}`;
    return { ok: false, reason };
  } catch (e) {
    return { ok: false, reason: `resume check failed: ${errText(e)}` };
  }
}

/** D6 precedence for a stopped container: per-orb handle → project snapshot (new orb only) → image. */
async function choosePlan(
  ctx: OrbContext,
  rec: OrbRecord,
  req: OpRequest,
  say: (s: string) => void,
): Promise<Plan | { error: string }> {
  const nowMs = ctx.clock.now();
  const h = rec.handle as Handle | undefined;
  if (h) {
    if (handleExpiresAt(h) > nowMs) {
      if (req.snapshotId) say(`ignoring ORB_SNAPSHOT_ID ${req.snapshotId}: this orb has its own disk`);
      if (rec.state === "paused-stale" || rec.state === "lost")
        say(`restoring disk from ${h.createdAt}; changes after that are lost (orb stopped without a pause)`);
      return { kind: "per-orb", handle: h };
    }
    say(`orb disk snapshot from ${h.createdAt} expired (30 d); Amp will set up the repo again`);
    rec.handle = undefined;
  }
  const neverWoke = !rec.lastWakeSource && !h;
  if (req.snapshotId && neverWoke) {
    const m = await ctx.registry.getProjectSnapshot(req.snapshotId);
    const ph = m?.handle as Handle | undefined;
    if (m && ph) {
      const exp = Math.max(handleExpiresAt(ph), Date.parse(m.lastUsedAt) + SNAPSHOT_TTL_MS);
      if (exp > nowMs) return { kind: "project", snapshotId: req.snapshotId, handle: ph, mapping: m };
      say(`project snapshot ${req.snapshotId} expired; booting the image (Amp runs setup)`);
      await notFatal(say, "project snapshot drop", () =>
        ctx.registry.dropProjectSnapshot(req.snapshotId as string),
      );
    } else {
      const stale = await ctx.registry.projectSnapshotStale(req.snapshotId).catch(() => undefined);
      if (stale?.forgotten)
        say(
          `project snapshot ${req.snapshotId} was forgotten as stale at ${stale.at} (${stale.reason}); booting the image (Amp runs setup); ${AMP_DELETE_HINT}`,
        );
      else say(`project snapshot ${req.snapshotId} is not known here; booting the image (Amp runs setup)`);
    }
  } else if (req.snapshotId && !h) {
    say(`ignoring ORB_SNAPSHOT_ID ${req.snapshotId}: this orb already ran; booting the image`);
  }
  const img = resolveImageKey(req.image, ctx.config, ctx.container.images());
  if ("error" in img) return img;
  if (img.note) say(img.note);
  return { kind: "image", imageKey: img.key, why: "image" };
}

/** A spawn that restored a project snapshot: what projectSnapshotRefresh needs after connect. */
interface ProjectRestore {
  snapshotId: string;
  mapping: ProjectSnapshotMapping;
}

type StartOk = {
  ok: true;
  source: NonNullable<OrbRecord["lastWakeSource"]>;
  ms: number;
  alreadyRunning?: boolean;
  project?: ProjectRestore;
};
type StartFail = { ok: false; error: string; alreadyRunning?: boolean };

async function startWithFallback(
  ctx: OrbContext,
  rec: OrbRecord,
  first: Plan,
  req: OpRequest,
  say: (s: string) => void,
): Promise<StartOk | StartFail> {
  let plan = first;
  // Image for a D7 fallback: the orb's own image for a per-orb disk, else what ORB_IMAGE maps to.
  const fallbackKey = (): { key: string } | { error: string } => {
    if (plan.kind === "per-orb" && ctx.container.images()[rec.imageKey]) return { key: rec.imageKey };
    return resolveImageKey(req.image, ctx.config, ctx.container.images());
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctx.deadline - ctx.clock.now() - SAFETY_MS <= 0)
      return { ok: false, error: deadlineError(ctx.orbId) };
    const instance = plan.kind === "per-orb" ? plan.handle.instance : (rec.instance ?? ctx.config.instance);
    let image: string | undefined;
    if (plan.kind === "image") {
      image = ctx.container.images()[plan.imageKey];
      if (!image)
        return {
          ok: false,
          error: `Failed: image key ${plan.imageKey} is not deployed — fix: run cf-orbs deploy`,
        };
      say(`starting from image ${plan.imageKey} (${describeInstance(instance)})`);
    } else {
      const h = plan.handle;
      say(
        plan.kind === "per-orb"
          ? `starting from orb disk snapshot ${h.id} (${mb(h.size)}, saved ${h.createdAt})`
          : `starting from project snapshot ${plan.snapshotId} (${mb(h.size)}, saved ${h.createdAt})`,
      );
    }
    const t = ctx.clock.now();
    try {
      ctx.container.start({
        source: image ? { image } : { snapshotId: (plan as { handle: Handle }).handle.id },
        instance,
        enableInternet: true,
        labels: { orb: ctx.orbId },
      });
    } catch (e) {
      const msg = errText(e);
      if (/already running/i.test(msg)) {
        // D7: another start won the race. Wait for it; never destroy or drop its disk.
        say("container already starting from another job; waiting for it");
        const r = await waitReady(ctx);
        if (r.kind === "ready") return { ok: true, source: "running", ms: r.ms, alreadyRunning: true };
        return { ok: false, error: readyError(ctx, r), alreadyRunning: true };
      }
      return {
        ok: false,
        error: `Failed: container start error: ${msg} — fix: retry the message; run cf-orbs logs ${ctx.orbId}`,
      };
    }
    const r = await waitReady(ctx);
    if (r.kind === "ready") {
      // Page in the amp binary while the bootstrap prelude runs. Best effort, not awaited.
      void ctx.container.exec(PREFETCH_CMD, { timeoutMs: 30_000 }).catch(() => undefined);
      say(`container ready in ${(r.ms / 1000).toFixed(1)} s`);
      const ts = iso(ctx.clock.now());
      rec.instance = instance;
      if (plan.kind === "per-orb") {
        plan.handle.lastRestoredAt = ts;
        rec.handle = plan.handle;
        // The restore refreshed the 30-day TTL; the Registry index must see it or GC drops the entry early.
        const restored = plan.handle;
        await notFatal(say, "snapshot index update", () => ctx.registry.recordSnapshot(restored, ctx.orbId));
        return { ok: true, source: "per-orb-snapshot", ms: ctx.clock.now() - t };
      }
      if (plan.kind === "project") {
        rec.imageKey = plan.handle.imageKey;
        const sid = plan.snapshotId;
        await notFatal(say, "project snapshot touch", () => ctx.registry.touchProjectSnapshot(sid, ts));
        return {
          ok: true,
          source: "project-snapshot",
          ms: ctx.clock.now() - t,
          project: { snapshotId: sid, mapping: plan.mapping },
        };
      }
      rec.imageKey = plan.imageKey;
      return { ok: true, source: "image", ms: ctx.clock.now() - t };
    }
    if (r.kind !== "not-found" || plan.kind === "image") return { ok: false, error: readyError(ctx, r) };

    // D7 fallback: only a missing snapshot drops the handle and boots the image.
    if (ctx.container.running) await ctx.container.destroy().catch(() => undefined);
    if (plan.kind === "per-orb") {
      say(
        `snapshot ${plan.handle.id} was not found: orb disk expired or lost; Amp will set up the repo again`,
      );
      rec.handle = undefined;
    } else {
      say(
        `project snapshot ${plan.snapshotId} was not found; dropping it; booting the image (Amp runs setup)`,
      );
      const sid = plan.snapshotId;
      await notFatal(say, "project snapshot drop", () => ctx.registry.dropProjectSnapshot(sid));
    }
    const img = fallbackKey();
    await saveOrb(ctx.kv, rec, iso(ctx.clock.now()));
    if ("error" in img) return { ok: false, error: img.error };
    plan = { kind: "image", imageKey: img.key, why: "fallback" };
  }
  return { ok: false, error: deadlineError(ctx.orbId) };
}

function readyError(ctx: OrbContext, r: Ready): string {
  if (r.kind === "timeout")
    return r.byDeadline
      ? deadlineError(ctx.orbId)
      : `Failed: container did not become ready in ${READY_CAP_MS / 1000} s — fix: retry the message; check cf-orbs status ${ctx.orbId}`;
  const msg = r.kind === "ready" ? "" : r.msg;
  return `Failed: container did not start: ${msg} — fix: retry the message; run cf-orbs logs ${ctx.orbId}`;
}

/** First retry of the readiness probe; it doubles up to 1 s. */
const READY_RETRY_MS = 100;

/**
 * D7: race exec(["true"]) (retried after 0.1, 0.2, 0.4, 0.8 s, then every 1 s) against monitor().
 * Also used by the bench routes and prewarm. The wait is capped at min(capMs, deadline − now − 10 s).
 */
export async function waitReady(
  ctx: Pick<OrbContext, "container" | "clock" | "deadline">,
  capMs = READY_CAP_MS,
): Promise<Ready> {
  const { container, clock } = ctx;
  const t0 = clock.now();
  const budget = ctx.deadline - t0 - SAFETY_MS;
  const cap = Math.min(capMs, budget);
  const until = t0 + Math.max(0, cap);
  let done = false;
  let monitorResult: Ready | undefined;
  const mon = container.monitor().then(
    (): Ready => ({ kind: "error", msg: "container exited during start" }),
    (e): Ready => {
      const msg = errText(e);
      return NOT_FOUND.test(msg) ? { kind: "not-found", msg } : { kind: "error", msg };
    },
  );
  void mon.then((r) => {
    monitorResult = r;
  });
  const probe = (async (): Promise<Ready> => {
    let pause = READY_RETRY_MS;
    for (;;) {
      if (done) return { kind: "timeout", byDeadline: false };
      if (monitorResult) return monitorResult;
      try {
        const r = await container.exec(["true"], {
          timeoutMs: Math.max(1000, Math.min(5000, until - clock.now())),
        });
        if (r.exitCode === 0) return { kind: "ready", ms: clock.now() - t0 };
      } catch (e) {
        const msg = errText(e);
        if (NOT_FOUND.test(msg)) return { kind: "not-found", msg };
      }
      if (monitorResult) return monitorResult;
      const rest = until - clock.now();
      if (rest <= 0) return { kind: "timeout", byDeadline: cap < capMs };
      await clock.sleep(Math.min(pause, rest));
      pause = Math.min(1000, pause * 2);
    }
  })();
  const r = await Promise.race([mon, probe]);
  done = true;
  return r;
}

type Conn =
  | { kind: "connected"; ms: number; amp?: AmpCheck }
  | { kind: "dead"; reason: string }
  | { kind: "timeout"; waitedMs: number };

/**
 * D10: run WAIT_CONNECTED_SH (it waits WAIT_SECONDS itself). exit 0 = connected; "reason: timeout…" = retry.
 * ampCheck: the script also prints one amp_check line after connect (projectSnapshotRefresh).
 */
async function waitConnected(ctx: OrbContext, capMs: number, ampCheck = false): Promise<Conn> {
  const { container, clock } = ctx;
  const t0 = clock.now();
  const until = t0 + Math.max(0, capMs);
  for (;;) {
    const rest = until - clock.now();
    if (rest <= 0) return { kind: "timeout", waitedMs: clock.now() - t0 };
    const step = Math.min(rest, CONNECT_STEP_MS);
    const env: Record<string, string> = { WAIT_SECONDS: String(Math.max(1, Math.floor(step / 1000))) };
    if (ampCheck) env.AMP_CHECK = "1";
    const [cmd, opts] = sh(WAIT_CONNECTED_SH, env);
    try {
      // amp_check can run amp --version (≤ 10 s) after connect.
      const r = await container.exec(cmd, { ...opts, timeoutMs: step + (ampCheck ? 15_000 : 5000) });
      if (r.exitCode === 0) {
        const amp = ampCheck ? parseAmpCheck(r.stdout) : undefined;
        return amp
          ? { kind: "connected", ms: clock.now() - t0, amp }
          : { kind: "connected", ms: clock.now() - t0 };
      }
      // exit 1 ends with "reason: <why>"; anything but a timeout means the bootstrap is gone.
      const reason = /^reason: (.*)$/m.exec(r.stdout)?.[1] ?? "";
      if (reason && !reason.startsWith("timeout")) return { kind: "dead", reason };
    } catch {
      if (!container.running) return { kind: "dead", reason: "container stopped" };
    }
    await beat(ctx);
    const after = until - clock.now();
    if (after <= 0) return { kind: "timeout", waitedMs: clock.now() - t0 };
    await clock.sleep(Math.min(1000, after));
  }
}

/**
 * projectSnapshotRefresh "on-change", after a spawn that restored a project snapshot and connected. Decide whether
 * the snapshot is stale; if so, mark it and forget it (Registry rate limit: one forget per project per 24 h).
 * Never fails the spawn. Every decision goes to the setup log and the provider log (say).
 */
async function refreshProjectSnapshot(
  ctx: OrbContext,
  req: OpRequest,
  p: ProjectRestore,
  amp: AmpCheck | undefined,
  say: (s: string) => void,
): Promise<void> {
  const sid = p.snapshotId;
  const img = resolveImageKey(req.image, ctx.config, ctx.container.images());
  const current = "key" in img ? ctx.container.images()[img.key] : undefined;
  const reason = staleReason(p.mapping, amp, current);
  if (!reason) {
    const ampText = amp ? (amp.kind === "current" ? amp.version : amp.to) : "unknown";
    const imgText = p.mapping.imageRef ? "same image" : "image not recorded";
    say(`project snapshot ${sid}: up to date (amp ${ampText}, ${imgText}); kept`);
    return;
  }
  try {
    const r = await ctx.registry.markProjectSnapshotStale(sid, reason, iso(ctx.clock.now()));
    say(
      r.forgotten
        ? `project snapshot ${sid} is stale (${reason}): ${r.note}. The next new thread boots the image and Amp runs setup; ${AMP_DELETE_HINT}`
        : `project snapshot ${sid} is stale (${reason}): ${r.note}`,
    );
  } catch (e) {
    say(`project snapshot ${sid} is stale (${reason}); mark failed (not fatal): ${errText(e)}`);
  }
}

/** Refresh the run slot during a long op. The alarm cannot: it waits in the same queue. */
export async function beat(ctx: Pick<OrbContext, "registry" | "orbId">): Promise<void> {
  await ctx.registry.heartbeat(ctx.orbId).catch(() => undefined);
}

/** Registry bookkeeping after the disk is safe: a failure is logged, never fatal. */
async function notFatal(say: (s: string) => void, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    say(`${what} failed (not fatal): ${errText(e)}`);
  }
}

/** Put the last 50 redacted bootstrap log lines into the setup log. */
export async function sayLogTail(ctx: OrbContext, say: (s: string) => void, token?: string): Promise<void> {
  try {
    const [cmd, opts] = sh(LOGTAIL_SH, { LINES: String(LOG_LINES) });
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 15_000 });
    const lines = tail(r.stdout, LOG_LINES);
    say(`--- last ${lines.length} bootstrap log lines`);
    for (const l of lines) say(redactWith(token, l));
    say("--- end of bootstrap log");
  } catch (e) {
    say(`could not read the bootstrap log: ${errText(e)}`);
  }
}

/** A start that never became ready: destroy it (nothing ran there) and restore a stopped state. */
async function settleFailedStart(ctx: OrbContext, rec: OrbRecord, prev: OrbState): Promise<void> {
  if (ctx.container.running) await ctx.container.destroy().catch(() => undefined);
  let next: OrbState;
  if (prev === "none") next = "none";
  else if (prev === "paused" && rec.handle) next = "paused";
  else if (prev === "lost") next = "lost";
  else next = "paused-stale";
  rec.state = next;
  await saveOrb(ctx.kv, rec, iso(ctx.clock.now()));
}

function tail(s: string, n: number): string[] {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .slice(-n);
}

function lastLine(r: { stdout: string; stderr: string }): string {
  return (tail(`${r.stdout}\n${r.stderr}`, 1)[0] ?? "").slice(0, 200);
}

export function describeInstance(i: OrbRecord["instance"]): string {
  return typeof i === "string"
    ? i
    : `${i.vcpu} vCPU, ${Math.round(i.memoryMib / 1024)} GiB, ${Math.round(i.diskMb / 1000)} GB disk`;
}
