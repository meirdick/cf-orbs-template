// Substrate bench ops. Reached only through POST /v1/orbs/bench-*/bench, which needs
// config.debugExec. Bench orbs are not Amp orbs: these ops never write the orb record, never take a run slot
// and never touch the Registry. A leaked bench container is stopped by the DO alarm (no orb record → destroy).
import { validateInstance } from "../core/config";
import type { Clock, ContainerPort } from "../core/container-port";
import type { InstanceSpec, ProviderConfig } from "../core/types";
import { JOB_DEADLINE_MS } from "../core/types";
import { errText } from "./journal";
import { waitReady } from "./spawn";

/** Bench orb ids. Amp sends `amp-<thread id>`, so this prefix cannot collide with a real orb. */
export const BENCH_ORB_RE = /^bench-[A-Za-z0-9_-]{1,120}$/;
/** Backstop: the alarm stops a bench container this long after its last start. */
export const BENCH_LEASE_MS = 30 * 60_000;
/** Short inactivity timeout so a leaked bench container also stops on its own. */
export const BENCH_INACTIVITY_MS = 10 * 60_000;

export type BenchSource = "image" | { snapshotId: string };

export interface BenchStartRequest {
  source: BenchSource;
  instance?: InstanceSpec;
}

export interface BenchStartResult {
  ready: boolean;
  /** start() → first exec(["true"]) OK, measured in the DO. */
  readyMs: number;
  source: "image" | "snapshot";
  instance: InstanceSpec;
  error?: string;
}

export interface BenchDeps {
  container: ContainerPort;
  clock: Clock;
  config: ProviderConfig;
  orbId: string;
}

/** Validate a bench body. Returns the request or a one-line cause. */
export function parseBenchStart(body: Record<string, unknown>): BenchStartRequest | string {
  const s = body.source;
  let source: BenchSource;
  if (s === "image") source = "image";
  else if (
    typeof s === "object" &&
    s !== null &&
    typeof (s as { snapshotId?: unknown }).snapshotId === "string" &&
    /^[A-Za-z0-9._:-]{1,256}$/.test((s as { snapshotId: string }).snapshotId)
  )
    source = { snapshotId: (s as { snapshotId: string }).snapshotId };
  else return 'source must be "image" or {snapshotId}';
  if (body.instance === undefined) return { source };
  try {
    return { source, instance: validateInstance(body.instance) };
  } catch (e) {
    return errText(e)
      .replace(/^Failed: /, "")
      .replace(/ — fix: .*$/, "");
  }
}

export async function benchStart(d: BenchDeps, req: BenchStartRequest): Promise<BenchStartResult> {
  const instance = req.instance ?? d.config.instance;
  const kind = req.source === "image" ? "image" : "snapshot";
  const out = (ready: boolean, readyMs: number, error?: string): BenchStartResult => ({
    ready,
    readyMs,
    source: kind,
    instance,
    ...(error ? { error } : {}),
  });
  if (d.container.running) return out(false, 0, "container already running; send action destroy first");
  let source: { image: string } | { snapshotId: string };
  if (req.source === "image") {
    const image = d.container.images().orb;
    if (!image) return out(false, 0, "image key orb is not deployed");
    source = { image };
  } else source = { snapshotId: req.source.snapshotId };
  const t0 = d.clock.now();
  try {
    d.container.start({ source, instance, enableInternet: true, labels: { orb: d.orbId, bench: "1" } });
  } catch (e) {
    return out(false, d.clock.now() - t0, `start failed: ${errText(e)}`);
  }
  const r = await waitReady({ container: d.container, clock: d.clock, deadline: t0 + JOB_DEADLINE_MS });
  if (r.kind === "ready") {
    await d.container.setInactivityTimeout(BENCH_INACTIVITY_MS).catch(() => undefined);
    return out(true, r.ms);
  }
  const ms = d.clock.now() - t0;
  if (d.container.running) await d.container.destroy().catch(() => undefined);
  if (r.kind === "timeout") return out(false, ms, "not ready before the cap");
  return out(false, ms, r.msg);
}

export async function benchSnapshot(
  d: BenchDeps,
  name: string,
): Promise<{ id?: string; size?: number; ms: number; syncMs: number; error?: string }> {
  if (!d.container.running) return { ms: 0, syncMs: 0, error: "container not running" };
  const t0 = d.clock.now();
  try {
    await d.container.exec(["sync"], { timeoutMs: 120_000 });
  } catch (e) {
    return { ms: 0, syncMs: d.clock.now() - t0, error: `sync failed: ${errText(e)}` };
  }
  const t1 = d.clock.now();
  try {
    const s = await d.container.snapshot(name);
    return { id: s.id, size: s.size, ms: d.clock.now() - t1, syncMs: t1 - t0 };
  } catch (e) {
    return { ms: d.clock.now() - t1, syncMs: t1 - t0, error: `snapshot failed: ${errText(e)}` };
  }
}

export async function benchDestroy(d: BenchDeps): Promise<{ ms: number; wasRunning: boolean }> {
  const wasRunning = d.container.running;
  const t0 = d.clock.now();
  if (wasRunning) await d.container.destroy();
  return { ms: d.clock.now() - t0, wasRunning };
}

/** Snapshot names: letters, digits, - and _, max 100. */
export function benchSnapshotName(orbId: string, raw: unknown, now: number): string {
  const s = typeof raw === "string" ? raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100) : "";
  return s || `${orbId}-${now}`.slice(0, 100);
}
