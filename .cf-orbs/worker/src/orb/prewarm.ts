// Prewarm (config prewarm): after a deploy, start a few throwaway instances from the current image so that
// Cloudflare pulls it onto hosts before the first real spawn. Best effort: placement is Cloudflare's.
// Each job runs in its own OrbSession DO named `orb:warm-<n>-<ts>` (only that class has the orb container).
// These are not Amp orbs: no orb record, no run slot, no snapshot. The job runs in the DO alarm:
// start → readiness (exec true, cap 3 min) → destroy, always. A job found started after a DO restart is
// not run again: its container is destroyed and the job reports a failure. With no job left, the normal
// alarm path (runAlarm, no orb record) stops anything still running.
import type { Clock, ContainerPort, KV } from "../core/container-port";
import { type ProviderConfig, WARM_JOB_TIMEOUT_MS, WARM_ORB_RE, type WarmResult } from "../core/types";
import { errText, iso } from "./journal";
import { SAFETY_MS, waitReady } from "./spawn";

/** DO storage key of the queued or running job. */
export const WARM_JOB_KEY = "warmJob";

export interface WarmJobRecord {
  runId: string;
  queuedAt: string; // ISO
  /** Set when the alarm starts the container. A record with startedAt at alarm time was interrupted. */
  startedAt?: string;
}

export interface WarmDeps {
  orbId: string;
  container: ContainerPort;
  clock: Clock;
  config: ProviderConfig;
  kv: KV;
  /** Send the result to the Registry. */
  report: (runId: string, r: WarmResult) => Promise<unknown>;
  say: (line: string) => void;
}

export function isWarmOrbId(orbId: string): boolean {
  return WARM_ORB_RE.test(orbId);
}

/** Store the job. The caller sets the alarm. */
export async function queueWarmJob(kv: KV, orbId: string, runId: string, now: number): Promise<void> {
  if (!isWarmOrbId(orbId))
    throw new Error(
      `Failed: prewarm runs only on warm-<n>-<ts> orbs, got ${orbId} — fix: start prewarm with POST /v1/warm`,
    );
  await kv.put<WarmJobRecord>(WARM_JOB_KEY, { runId, queuedAt: iso(now) });
}

/** Start one instance from the orb image, wait until it answers exec, destroy it. Never throws. */
export async function runWarmJob(
  d: Pick<WarmDeps, "orbId" | "container" | "clock" | "config">,
): Promise<WarmResult> {
  const { container, clock } = d;
  const image = container.images().orb;
  if (!image) return { ok: false, ms: 0, error: "image key orb is not deployed" };
  if (container.running) await container.destroy().catch(() => undefined);
  const t0 = clock.now();
  try {
    container.start({
      source: { image },
      instance: d.config.instance,
      // The image pull is all that matters here; the instance needs no network.
      enableInternet: false,
      labels: { orb: d.orbId, prewarm: "1" },
    });
  } catch (e) {
    return { ok: false, ms: clock.now() - t0, error: `start failed: ${errText(e)}` };
  }
  let out: WarmResult;
  try {
    // Backstop if this DO dies before the destroy below.
    await container.setInactivityTimeout(WARM_JOB_TIMEOUT_MS).catch(() => undefined);
    const r = await waitReady(
      { container, clock, deadline: t0 + WARM_JOB_TIMEOUT_MS + SAFETY_MS },
      WARM_JOB_TIMEOUT_MS,
    );
    const ms = clock.now() - t0;
    // From start(): setInactivityTimeout can wait for the container, so r.ms alone misses the start.
    if (r.kind === "ready") out = { ok: true, ms };
    else if (r.kind === "timeout")
      out = { ok: false, ms, error: `not ready in ${WARM_JOB_TIMEOUT_MS / 60_000} min` };
    else out = { ok: false, ms, error: r.msg };
  } catch (e) {
    out = { ok: false, ms: clock.now() - t0, error: errText(e) };
  }
  try {
    if (container.running) await container.destroy();
  } catch (e) {
    // The alarm path tries again: the caller sees container.running.
    out = { ...out, error: `${out.error ? `${out.error}; ` : ""}destroy failed: ${errText(e)}` };
  }
  return out;
}

/** Alarm work for a warm-* orb. Returns true when it ran or cleaned up a job. */
export async function runWarmAlarm(d: WarmDeps): Promise<boolean> {
  const job = await d.kv.get<WarmJobRecord>(WARM_JOB_KEY);
  if (!job) return false;
  const report = async (r: WarmResult) => {
    try {
      await d.report(job.runId, r);
    } catch (e) {
      d.say(`prewarm: could not report the result: ${errText(e)}`);
    }
  };
  if (job.startedAt) {
    if (d.container.running) await d.container.destroy().catch(() => undefined);
    d.say("prewarm: job was interrupted (Durable Object restart); container destroyed");
    await report({ ok: false, ms: 0, error: "interrupted by a Durable Object restart" });
    await d.kv.delete(WARM_JOB_KEY);
    return true;
  }
  job.startedAt = iso(d.clock.now());
  await d.kv.put(WARM_JOB_KEY, job);
  const r = await runWarmJob(d);
  d.say(
    r.ok
      ? `prewarm: instance ready in ${(r.ms / 1000).toFixed(1)} s; destroyed`
      : `prewarm: failed after ${(r.ms / 1000).toFixed(1)} s: ${r.error ?? "unknown"}`,
  );
  await report(r);
  await d.kv.delete(WARM_JOB_KEY);
  return true;
}
