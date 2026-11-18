// ProviderHost (D18): one DO, named "provider", that keeps `amp orb provider` running in its own container.
// The container reaches the control plane at http://control.internal; the DO routes that host to the
// ControlApi WorkerEntrypoint with interceptOutboundHttp. The Amp provider token goes only into start() env.
//
// How the DO gets a Fetcher for ControlApi: `this.ctx.exports.ControlApi` (loopback service binding for a
// top-level WorkerEntrypoint export; on by default for compatibility_date >= 2025-11-17). Documented in
// /containers/configuration/outbound-traffic/ ("Direct API") and /workers/runtime-apis/context/#exports.
// Intercepts last until the container stops; registering again is harmless, so every check re-registers.
import { DurableObject } from "cloudflare:workers";
import { type Clock, type KV, realClock, wrapStorage } from "./core/container-port";
import type { InstanceSpec } from "./core/types";
import type { Env } from "./env";
import { tokenSha } from "./orb/journal";
import { restartProvider } from "./provider-restart";

export const PROVIDER_IMAGE_KEY = "provider";
/**
 * Sizes the provider container can have. "lite" (1/16 vCPU, 256 MiB) is the default: the provider only holds
 * the `amp orb provider` connection and starts dispatch.sh, which starts 2 processes for a job. Measured on
 * Cloudflare: 10 spawns at once and 200 jobs in 15 min with no slowdown. start() does not accept "basic".
 */
export const PROVIDER_INSTANCES = ["lite", "standard-1", "standard-2"] as const;
export type ProviderInstance = (typeof PROVIDER_INSTANCES)[number];
export const DEFAULT_PROVIDER_INSTANCE: ProviderInstance = "lite";

/** providerInstance from CF_ORBS_CONFIG. Anything else than a known size gives the default. */
export function providerInstanceOf(configJson: string | undefined): ProviderInstance {
  try {
    const v = (JSON.parse(configJson ?? "{}") as { providerInstance?: unknown }).providerInstance;
    if ((PROVIDER_INSTANCES as readonly unknown[]).includes(v)) return v as ProviderInstance;
  } catch {
    // Bad config JSON is reported by the orb paths; the provider keeps the default size.
  }
  return DEFAULT_PROVIDER_INSTANCE;
}

export const CONTROL_HOST = "control.internal";
export const CONTROL_URL = `http://${CONTROL_HOST}`;
export const PROVIDER_LOG = "/var/log/cf-orbs-provider.log";
/** status() gives the log read this long. A slow container must not block /v1/status. */
export const PROVIDER_LOG_TAIL_MS = 5_000;
/**
 * Watchdog (the 5-min alarm): a provider container that runs but does not answer `true` in PROVIDER_PROBE_MS
 * is slow or stuck, and Amp jobs then run late. After PROVIDER_SLOW_CHECKS such checks in a row it is restarted.
 * No probe in the first PROVIDER_GRACE_MS after a start (amp starts slowly on "lite"), and at most one watchdog
 * restart in PROVIDER_WATCHDOG_GAP_MS, so a provider under real load is not restarted in a loop.
 */
export const PROVIDER_PROBE_MS = 5_000;
export const PROVIDER_SLOW_CHECKS = 2;
export const PROVIDER_GRACE_MS = 10 * 60_000;
export const PROVIDER_WATCHDOG_GAP_MS = 30 * 60_000;
export const PROVIDER_INACTIVITY_MS = 6 * 3600_000; // 21600000
export const PROVIDER_ALARM_MS = 5 * 60_000;
export const STATE_KEY = "provider";

/**
 * Persisted under STATE_KEY. No secrets: only the token's sha256 prefix.
 * v 2 adds image and build. A stop recorded by v 1 code is not a user stop: v 1 code had no stop caller
 * except the restart route, which stops a provider whose DO runs v 1 code so the DO can load new code.
 */
export interface ProviderState {
  v: 1 | 2;
  startedAt?: string; // ISO, last start
  starts: number;
  restarts: number; // starts after the first
  lastCheck?: string; // ISO, last ensure or alarm
  lastStop?: { at: string; reason: string };
  lastError?: string; // one line, "Failed: … — fix: …"
  tokenSha?: string; // first 16 hex of sha256(token) given to the running container
  stopped?: boolean; // set by stop(); the alarm does not restart a stopped provider
  image?: string; // image ref the running container started from (images().provider)
  build?: string; // CF_ORBS_PROVIDER_BUILD the running container started from
  slowChecks?: number; // watchdog: alarm checks in a row with no answer from the container
  watchdogRestartAt?: string; // ISO, last restart by the watchdog
}

export interface ProviderStatus {
  running: boolean;
  startedAt?: string;
  restarts: number;
  lastCheck?: string;
  lastStop?: { at: string; reason: string };
  lastError?: string;
  stopped: boolean;
  /** Image ref and provider build the running container started from. */
  image?: string;
  build?: string;
  /** Image ref and provider build of the deploy this DO runs. They differ from image/build until a restart. */
  deployedImage?: string;
  deployedBuild?: string;
  /** Last 20 lines of the provider log, redacted. Empty when not running. */
  logTail: string[];
}

/** POST /v1/provider/restart result. "reset": this DO runs an older deploy; the caller resets it. */
export interface ProviderRestartResult extends ProviderStatus {
  action: ProviderAction | "reset" | "stopped-old-code";
  reason: string;
  restarted: boolean;
}

export type ProviderAction = "start" | "restart" | "keep" | "none";
export type ProviderTrigger = "ensure" | "alarm";

export interface ProviderDecisionInput {
  trigger: ProviderTrigger;
  running: boolean;
  hasToken: boolean;
  tokenSha?: string; // sha of the token in the Worker now
  runningTokenSha?: string; // sha of the token the running container got
  build?: string; // CF_ORBS_PROVIDER_BUILD of this deploy
  runningBuild?: string; // build the running container started from (undefined: started by older code)
  force?: boolean; // POST /v1/provider/restart without ifImageChanged
  stopped: boolean;
}

/** Pure decision for ensure/alarm. */
export function decideProvider(i: ProviderDecisionInput): { action: ProviderAction; reason: string } {
  if (!i.hasToken)
    return { action: "none", reason: "no AMP_ORB_PROVIDER_TOKEN in the Worker (external provider mode)" };
  if (i.trigger === "alarm" && i.stopped) return { action: "none", reason: "provider was stopped" };
  if (!i.running) return { action: "start", reason: "container not running" };
  if (i.runningTokenSha && i.tokenSha && i.runningTokenSha !== i.tokenSha) {
    return { action: "restart", reason: "provider token changed" };
  }
  if (i.build && i.runningBuild !== i.build) {
    return {
      action: "restart",
      reason: `provider image changed (build ${i.runningBuild ?? "unknown"} -> ${i.build})`,
    };
  }
  if (i.force) return { action: "restart", reason: "restart requested" };
  return { action: "keep", reason: "running" };
}

/** First 8 hex of an image ref's sha256 digest, else its last 8 characters. */
export function short8(ref: string | undefined): string {
  if (!ref) return "none";
  const d = /@sha256:([0-9a-f]{8})/.exec(ref);
  return d ? (d[1] as string) : ref.slice(-8);
}

export function shouldStart(i: ProviderDecisionInput): boolean {
  const a = decideProvider(i).action;
  return a === "start" || a === "restart";
}

export function nextAlarm(now: number): number {
  return now + PROVIDER_ALARM_MS;
}

/** Same rules as provider/entry.sh redact(): exact token, aop_live_*, orb_*, JWTs, long base64/hex runs. */
export function redactLine(line: string, secrets: string[] = []): string {
  let s = line;
  for (const v of secrets) if (v && v.length >= 8) s = s.split(v).join("[redacted]");
  return s
    .replace(/aop_live_[A-Za-z0-9_-]+/g, "aop_live_[redacted]")
    .replace(/orb_[A-Za-z0-9_-]{16,}/g, "orb_[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/[A-Za-z0-9+=_]{40,}/g, "[redacted]");
}

/** First 16 hex of sha256(token). Same helper the orb ops use. */
export const tokenSha16: (token: string) => Promise<string> = tokenSha;

/** The slice of ctx.container ProviderHost uses. Start takes env, unlike ContainerPort (orbs pass none). */
export interface ProviderContainerPort {
  readonly running: boolean;
  images(): Record<string, string>;
  start(o: {
    image: string;
    instance: InstanceSpec;
    enableInternet: boolean;
    env: Record<string, string>;
    labels?: Record<string, string>;
  }): void;
  interceptOutboundHttp(host: string, target: Fetcher): Promise<void>;
  exec(cmd: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy(): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
}

export function wrapProviderContainer(c: Container): ProviderContainerPort {
  const td = new TextDecoder();
  return {
    get running() {
      return c.running;
    },
    images: () => c.images,
    start: (o) => c.start({ ...o, instance: o.instance as any }),
    interceptOutboundHttp: (host, target) => c.interceptOutboundHttp(host, target),
    async exec(cmd, timeoutMs) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const p = await c.exec(cmd, { signal: ac.signal, stdout: "pipe", stderr: "pipe" });
        const out = await p.output();
        return { exitCode: out.exitCode, stdout: td.decode(out.stdout), stderr: td.decode(out.stderr) };
      } finally {
        clearTimeout(t);
      }
    },
    destroy: () => c.destroy(),
    setInactivityTimeout: (ms) => c.setInactivityTimeout(ms),
  };
}

export interface ProviderDeps {
  container: ProviderContainerPort;
  kv: KV;
  clock: Clock;
  token?: string;
  /** Container size (providerInstance in the config). Default "lite". */
  instance?: InstanceSpec;
  /** CF_ORBS_PROVIDER_BUILD of the deploy this DO runs: a hash of the provider image inputs. */
  build?: string;
  /** Log sink for the one-line image change record (console.log in the DO). */
  log?: (line: string) => void;
  /** Returns the ControlApi Fetcher; throws a Failed: line when it is not exported. */
  controlApi: () => Fetcher;
  setAlarm: (at: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
}

/** p, or an Error(message) after ms. An exec in a starved container can outlast its own abort signal. */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  p.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function oneLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0] ?? m;
}

/** All ProviderHost logic, behind ports so it is unit-testable. Calls are serialized. */
export class ProviderController {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private d: ProviderDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async load(): Promise<ProviderState> {
    const s = await this.d.kv.get<ProviderState>(STATE_KEY);
    return { v: 1, starts: 0, restarts: 0, ...(s ?? {}) };
  }

  private iso(): string {
    return new Date(this.d.clock.now()).toISOString();
  }

  private async save(s: ProviderState): Promise<void> {
    s.v = 2;
    await this.d.kv.put(STATE_KEY, s);
  }

  /** Start the provider if needed, then (re)register the intercept, refresh the timeout and arm the alarm. */
  async ensure(trigger: ProviderTrigger): Promise<ProviderState> {
    return (await this.check(trigger)).state;
  }

  /**
   * ensure() that also says what it did. force: restart a running provider (POST /v1/provider/restart).
   * A running container from another provider build is always restarted.
   */
  check(
    trigger: ProviderTrigger,
    force = false,
  ): Promise<{ action: ProviderAction; reason: string; state: ProviderState }> {
    return this.exclusive(async () => {
      const s = await this.load();
      const c = this.d.container;
      const token = this.d.token;
      const tokenSha = token ? await tokenSha16(token) : undefined;
      const dec = decideProvider({
        trigger,
        running: c.running,
        hasToken: !!token,
        tokenSha,
        runningTokenSha: s.tokenSha,
        build: this.d.build,
        runningBuild: s.build,
        force,
        // A stop written by v 1 code is the restart route's stop for a DO on old code (see ProviderState).
        stopped: !!s.stopped && s.v >= 2,
      });
      s.lastCheck = this.iso();
      if (trigger === "alarm" && dec.action === "keep" && (await this.unresponsive(s))) {
        dec.action = "restart";
        dec.reason = `provider container did not answer ${PROVIDER_SLOW_CHECKS} checks in a row (slow or stuck)`;
        s.watchdogRestartAt = this.iso();
        this.d.log?.(`provider: ${dec.reason}; restarting`);
      }
      if (dec.action === "none") {
        // No token now means external-host mode. A CF provider left running would hold the token's slot
        // and the external provider would wait for it forever, so stop it.
        if (!token && c.running) {
          await c.destroy();
          s.lastStop = { at: this.iso(), reason: "no provider token in the Worker (external mode)" };
        }
        await this.d.deleteAlarm();
        await this.save(s);
        if (!token) {
          throw new Error(
            "Failed: AMP_ORB_PROVIDER_TOKEN is not set in the Worker — fix: run cf-orbs init with AMP_ORB_PROVIDER_TOKEN set, or run the provider on your own host (provider/README.md)",
          );
        }
        return { ...dec, state: s };
      }
      try {
        if (dec.action === "restart") {
          await c.destroy();
          s.lastStop = { at: this.iso(), reason: dec.reason };
        }
        // Not running, not stopped by us, and no stop recorded since the last start: it died or was evicted.
        if (
          dec.action === "start" &&
          s.startedAt &&
          !s.stopped &&
          !(s.lastStop && s.lastStop.at >= s.startedAt)
        ) {
          s.lastStop = { at: this.iso(), reason: "found not running" };
        }
        if (dec.action === "start" || dec.action === "restart") {
          const image = c.images()[PROVIDER_IMAGE_KEY];
          if (!image) {
            throw new Error(
              `Failed: image "${PROVIDER_IMAGE_KEY}" is not in this deploy — fix: run cf-orbs deploy (wrangler.jsonc needs the provider container image)`,
            );
          }
          const prevImage = s.image;
          try {
            c.start({
              image,
              instance: this.d.instance ?? DEFAULT_PROVIDER_INSTANCE,
              enableInternet: true,
              env: { AMP_ORB_PROVIDER_TOKEN: token as string, CF_ORBS_URL: CONTROL_URL },
              labels: { role: "provider" },
            });
            if (s.starts > 0) s.restarts++;
            s.starts++;
            s.startedAt = this.iso();
            s.tokenSha = tokenSha;
            s.image = image;
            s.build = this.d.build;
            s.stopped = false;
            s.slowChecks = 0;
            if (prevImage && prevImage !== image)
              this.d.log?.(`provider: image changed ${short8(prevImage)} -> ${short8(image)}; restarted`);
          } catch (e) {
            // Another path started it between the check and now: keep it.
            if (!/already running/i.test(oneLine(e))) throw e;
          }
        }
        await c.interceptOutboundHttp(CONTROL_HOST, this.d.controlApi());
        await c.setInactivityTimeout(PROVIDER_INACTIVITY_MS);
        s.lastError = undefined;
      } catch (e) {
        const m = redactLine(oneLine(e), token ? [token] : []);
        s.lastError = m.startsWith("Failed:") ? m : `Failed: ${m} — fix: run cf-orbs doctor`;
        await this.save(s);
        // Keep the alarm armed so a transient failure is retried.
        await this.d.setAlarm(nextAlarm(this.d.clock.now()));
        throw new Error(s.lastError);
      }
      await this.save(s);
      await this.d.setAlarm(nextAlarm(this.d.clock.now()));
      return { ...dec, state: s };
    });
  }

  /** Watchdog probe (see PROVIDER_PROBE_MS). Counts in s.slowChecks. True: restart the container now. */
  private async unresponsive(s: ProviderState): Promise<boolean> {
    const now = this.d.clock.now();
    if (s.startedAt && now - Date.parse(s.startedAt) < PROVIDER_GRACE_MS) return false;
    try {
      const r = await within(
        this.d.container.exec(["true"], PROVIDER_PROBE_MS),
        PROVIDER_PROBE_MS,
        "no answer",
      );
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      s.slowChecks = 0;
      return false;
    } catch {
      s.slowChecks = (s.slowChecks ?? 0) + 1;
    }
    if (s.slowChecks < PROVIDER_SLOW_CHECKS) return false;
    if (s.watchdogRestartAt && now - Date.parse(s.watchdogRestartAt) < PROVIDER_WATCHDOG_GAP_MS) return false;
    return true;
  }

  /**
   * This DO runs an older deploy than the caller (build differs), so it cannot start the new image:
   * images() is the old deploy's. Destroy the container and record why; the caller then resets the DO.
   * Does not set stopped, so the next check of the new code starts the provider.
   */
  stopForReset(want: string): Promise<string> {
    return this.exclusive(async () => {
      const s = await this.load();
      const reason = `provider image changed (build ${s.build ?? this.d.build ?? "unknown"} -> ${want})`;
      if (this.d.container.running) {
        await this.d.container.destroy();
        s.lastStop = { at: this.iso(), reason };
      }
      await this.save(s);
      return reason;
    });
  }

  /** Alarm handler body: never throws (a throwing alarm is retried with backoff, then dropped). */
  async alarm(): Promise<void> {
    try {
      await this.ensure("alarm");
    } catch {
      // ensure() stored lastError and re-armed (or deliberately disarmed when there is no token).
    }
  }

  /** withLog: also read the log tail with exec (skip right after a start: the container may not be ready). */
  status(withLog = true): Promise<ProviderStatus> {
    return this.exclusive(async () => {
      const s = await this.load();
      const c = this.d.container;
      let logTail: string[] = [];
      if (withLog && c.running) {
        try {
          const r = await within(
            c.exec(["tail", "-n", "20", PROVIDER_LOG], PROVIDER_LOG_TAIL_MS),
            PROVIDER_LOG_TAIL_MS,
            `the provider container did not answer in ${PROVIDER_LOG_TAIL_MS / 1000} s; it can be overloaded`,
          );
          const secrets = this.d.token ? [this.d.token] : [];
          logTail = r.stdout
            .split("\n")
            .filter((l) => l.length > 0)
            .map((l) => redactLine(l, secrets));
        } catch (e) {
          logTail = [`(log unavailable: ${redactLine(oneLine(e))})`];
        }
      }
      return {
        running: c.running,
        startedAt: s.startedAt,
        restarts: s.restarts,
        lastCheck: s.lastCheck,
        lastStop: s.lastStop,
        lastError: s.lastError,
        stopped: !!s.stopped,
        image: s.image,
        build: s.build,
        deployedImage: c.images()[PROVIDER_IMAGE_KEY],
        deployedBuild: this.d.build,
        logTail,
      };
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      const s = await this.load();
      s.stopped = true;
      s.lastStop = { at: this.iso(), reason: "stopped by request" };
      await this.d.deleteAlarm();
      if (this.d.container.running) await this.d.container.destroy();
      await this.save(s);
    });
  }
}

export class ProviderHost extends DurableObject<Env> {
  private readonly ctl: ProviderController;
  private readonly build?: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("Failed: ProviderHost has no container — fix: run cf-orbs deploy");
    // Alarms are durable; only the inactivity timeout needs re-setting after a DO restart.
    if (container.running)
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(PROVIDER_INACTIVITY_MS));
    this.ctl = new ProviderController({
      container: wrapProviderContainer(container),
      kv: wrapStorage(ctx.storage),
      clock: realClock,
      token: env.AMP_ORB_PROVIDER_TOKEN,
      instance: providerInstanceOf(env.CF_ORBS_CONFIG),
      build: env.CF_ORBS_PROVIDER_BUILD,
      log: (l) => console.log(l),
      controlApi: () => {
        const api = (ctx.exports as unknown as Record<string, Fetcher | undefined>).ControlApi;
        if (!api) {
          throw new Error(
            "Failed: ControlApi entrypoint is not exported — fix: export class ControlApi from the Worker entry and run cf-orbs deploy",
          );
        }
        return api;
      },
      setAlarm: (at) => ctx.storage.setAlarm(at),
      deleteAlarm: () => ctx.storage.deleteAlarm(),
    });
    this.build = env.CF_ORBS_PROVIDER_BUILD;
  }

  /**
   * POST /v1/provider/restart and the cron. build: CF_ORBS_PROVIDER_BUILD of the caller's deploy.
   * ifImageChanged: restart only for a new provider image (respects stop()); else always restart.
   */
  async restart(o: { ifImageChanged?: boolean; build?: string } = {}): Promise<ProviderRestartResult> {
    if (o.build && this.build && o.build !== this.build) {
      // A DO that held a running container keeps its deploy's code and images (R17). Stop the container;
      // the caller then calls reset() so the next request builds this DO from the new deploy.
      const reason = await this.ctl.stopForReset(o.build);
      return { action: "reset", reason, restarted: false, ...(await this.ctl.status(false)) };
    }
    const r = await this.ctl.check(o.ifImageChanged ? "alarm" : "ensure", !o.ifImageChanged);
    return {
      action: r.action,
      reason: r.reason,
      restarted: r.action === "restart",
      ...(await this.ctl.status(false)),
    };
  }

  /** Drop this DO instance so the next request runs the newest deploy. The call itself fails. */
  async reset(): Promise<void> {
    this.ctx.abort("provider image changed; loading the new deploy");
  }

  /** "ensure" (POST /v1/provider/start) starts even a stopped provider; "alarm" (cron) respects stop(). */
  async ensureRunning(trigger: ProviderTrigger = "ensure"): Promise<ProviderStatus> {
    await this.ctl.ensure(trigger);
    return this.ctl.status(false);
  }

  async alarm(): Promise<void> {
    await this.ctl.alarm();
  }

  async status(): Promise<ProviderStatus> {
    return this.ctl.status();
  }

  async stop(): Promise<void> {
    await this.ctl.stop();
  }
}

/** Called from the Worker's cron. No-op in external-host mode (no token in the Worker). */
export async function ensureProviderRunning(
  env: Pick<Env, "PROVIDER" | "AMP_ORB_PROVIDER_TOKEN" | "CF_ORBS_PROVIDER_BUILD">,
): Promise<void> {
  if (!env.AMP_ORB_PROVIDER_TOKEN) return;
  // The cron must not undo stop(): ifImageChanged uses the alarm trigger, which keeps a stopped provider stopped.
  const r = await restartProvider(env, { ifImageChanged: true, onOldCode: "ensure" });
  if (r.restarted) console.log(`provider: ${r.reason}; restarted by the cron`);
}
