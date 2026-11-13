// Pause op (D14): quiesce → snapshot (retried) → store handle + Registry index (+ project map) → destroy.
// Warm pause (warmMinutes > 0, Amp pause without ORB_SNAPSHOT_ID, bootstrap alive): sync → snapshot → store
// handle → keep the container and amp running; state warm until warmUntil. The alarm stops it later.
// On final snapshot failure the instance stays up and the op fails; the alarm watchdog is the backstop.
import type { OpRequest, OrbRecord, SnapshotHandle } from "../core/types";
import type { OrbContext } from "./context";
import {
  ACTIVITY_KEY,
  errText,
  type Handle,
  iso,
  loadOrb,
  newOrbRecord,
  parseStatus,
  redactWith,
  saveOrb,
  WARM_USE_KEY,
} from "./journal";
import { QUIESCE_SH, SCRUB_SH, STATUS_SH } from "./scripts";
import { beat, sh } from "./spawn";

export type PauseResult = { ok: boolean; error?: string; handle?: SnapshotHandle };

export interface PauseOptions {
  /** Always quiesce, snapshot and destroy (alarm self-pause, end of a warm period). */
  cold?: boolean;
}

/** Snapshot retries stop this long before the op deadline, leaving time for destroy and the reply. */
const SNAPSHOT_RESERVE_MS = 30_000;
const QUIESCE_TIMEOUT_MS = 30_000;

/** reason goes to lastStop; the alarm passes its own (watchdog, maxAwakeHours). */
export async function runPause(
  ctx: OrbContext,
  req: OpRequest,
  reason = "paused by Amp",
  opts: PauseOptions = {},
): Promise<PauseResult> {
  const { container, clock, kv, registry, orbId } = ctx;
  const say = (s: string) => ctx.say(redactWith(undefined, s));
  const now = () => iso(clock.now());
  const t0 = clock.now();

  const found = await loadOrb(kv);
  if (found?.deletedAt) {
    say(`orb was deleted at ${found.deletedAt}; pause is a no-op`);
    return { ok: true };
  }
  const rec: OrbRecord = found ?? newOrbRecord(orbId, ctx.config, now());

  if (!container.running) {
    if (req.snapshotId) {
      // A replay of a pause that already succeeded (Amp re-offers a job whose claim timed out).
      if (rec.state === "paused" && rec.handle) {
        const m = await registry.getProjectSnapshot(req.snapshotId).catch(() => undefined);
        if (m && m.sourceOrbId === orbId && m.handle.id === rec.handle.id) {
          say(`orb already paused; project snapshot ${req.snapshotId} is ${rec.handle.id}`);
          return { ok: true, handle: rec.handle };
        }
      }
      say(`container is not running; project snapshot ${req.snapshotId} not saved`);
      return {
        ok: false,
        error:
          "Failed: orb not running, project snapshot not saved — fix: none needed; the next thread runs setup again",
      };
    }
    if (rec.state === "warm" && rec.handle) {
      // The disk was saved when the orb went warm.
      rec.state = "paused";
      rec.lastStop ??= { at: now(), reason: "container stopped while warm" };
      clearAwake(rec);
      await saveOrb(kv, rec, now());
      say(`container already stopped; next wake restores the disk from ${rec.handle.createdAt}`);
    } else if (
      rec.state === "awake" ||
      rec.state === "starting" ||
      rec.state === "pausing" ||
      rec.state === "warm" ||
      rec.state === "lost"
    ) {
      rec.state = "paused-stale";
      rec.lastStop ??= { at: now(), reason: "container stopped before pause" };
      clearAwake(rec);
      await saveOrb(kv, rec, now());
      say(
        rec.handle
          ? `container already stopped; next wake restores the disk from ${rec.handle.createdAt}`
          : "container already stopped and no disk snapshot exists; next wake boots the image",
      );
    } else say(`container not running (state ${rec.state}); nothing to pause`);
    await registry.releaseRunSlot(orbId);
    return { ok: true };
  }

  // Warm only for a plain Amp pause. A project snapshot (ORB_SNAPSHOT_ID) must be a quiesced disk.
  const warmMs = opts.cold || req.snapshotId ? 0 : ctx.config.warmMinutes * 60_000;
  let warm = false;
  let st: { alive: boolean; act?: string; use?: string } = { alive: false };
  if (warmMs > 0) {
    st = await bootstrapStatus(ctx);
    warm = st.alive;
    if (!warm) say("amp bootstrap is not running; pausing cold (snapshot and stop)");
  }
  if (warm && rec.state === "warm" && rec.handle) {
    // Amp can use a warm orb without a spawn. Only a pause after such use needs a new snapshot.
    const used = st.use !== undefined && st.use !== (await kv.get<string>(WARM_USE_KEY));
    if (!used) {
      say(`orb already warm until ${rec.warmUntil ?? "unknown"}; disk saved as ${rec.handle.id}`);
      return { ok: true, handle: rec.handle };
    }
    say("Amp used the warm orb since the last pause; saving the disk again");
  }

  rec.state = "pausing";
  await saveOrb(kv, rec, now());
  await beat(ctx);
  let ampVersion: string | undefined;

  if (warm) {
    // amp keeps running: mask token shapes in its logs (R19), flush its writes, do not stop it.
    try {
      const [cmd, sopts] = sh(SCRUB_SH, {});
      const r = await container.exec(cmd, { ...sopts, timeoutMs: QUIESCE_TIMEOUT_MS });
      say(`scrub: ${r.stdout.trim().split("\n").at(0) || `exit ${r.exitCode}`}`);
    } catch (e) {
      say(`scrub/sync failed (snapshot anyway): ${errText(e)}`);
    }
  } else {
    // Stop amp so the snapshot does not capture torn files. A failure here is logged, not fatal.
    // A project pause first records the amp version in the disk and the mapping (projectSnapshotRefresh, status).
    try {
      const [cmd, qopts] = sh(QUIESCE_SH, req.snapshotId ? { AMP_VERSION: "1" } : {});
      const q = await container.exec(cmd, { ...qopts, timeoutMs: QUIESCE_TIMEOUT_MS });
      const v = /^amp: version (\S+)\s*$/m.exec(q.stdout)?.[1];
      if (req.snapshotId) say(`amp version ${v ?? "unknown"}`);
      if (v && v !== "unknown") ampVersion = v;
      const last = q.stdout.trim().split("\n").at(-1) ?? "";
      say(`quiesce: ${last || `exit ${q.exitCode}`}`);
    } catch (e) {
      say(`quiesce failed (snapshot anyway): ${errText(e)}`);
    }
  }

  const until = ctx.deadline - SNAPSHOT_RESERVE_MS;
  let snap: { id: string; size: number } | undefined;
  let lastErr = "";
  let attempt = 0;
  let lastAttemptMs = 0;
  for (;;) {
    attempt++;
    await beat(ctx);
    const ts = clock.now();
    try {
      snap = await container.snapshot(`pause-${orbId}-${ts}`);
      say(
        `snapshot ${snap.id}: ${Math.round(snap.size / 1e6)} MB in ${((clock.now() - ts) / 1000).toFixed(1)} s`,
      );
      break;
    } catch (e) {
      lastErr = errText(e);
      lastAttemptMs = clock.now() - ts;
      say(`snapshot attempt ${attempt} failed: ${lastErr}`);
      if (!container.running) break;
    }
    // Retry only when another attempt as slow as the last one still ends before the reserve.
    const wait = Math.min(2000 * attempt, 10_000);
    if (clock.now() + wait + lastAttemptMs >= until) break;
    await clock.sleep(wait);
  }

  if (!snap) {
    rec.state = container.running ? "awake" : "lost";
    rec.warmUntil = undefined;
    if (rec.state === "lost") rec.lastStop = { at: now(), reason: "container stopped during pause" };
    await saveOrb(kv, rec, now());
    const kept = container.running ? "orb left running" : "container stopped";
    return {
      ok: false,
      error: `Failed: snapshot failed after ${attempt} attempts (${lastErr}); ${kept} — fix: retry the pause; check cf-orbs status ${orbId}`,
    };
  }

  const createdAt = now();
  const imageRef = container.images()[rec.imageKey];
  const handle: Handle = {
    id: snap.id,
    size: snap.size,
    imageKey: rec.imageKey,
    ...(imageRef ? { imageRef } : {}),
    instance: rec.instance,
    createdAt,
    name: `pause-${orbId}`,
  };
  // Store the handle before anything else can fail: the disk is safe from here on.
  rec.handle = handle;
  await saveOrb(kv, rec, now());
  try {
    await registry.recordSnapshot(handle, orbId);
  } catch (e) {
    say(`snapshot index update failed (not fatal): ${errText(e)}`);
  }
  if (req.snapshotId) {
    try {
      // imageRef holds the deployed digest: spawn compares it with the current image (projectSnapshotRefresh).
      await registry.putProjectSnapshot({
        snapshotId: req.snapshotId,
        handle,
        sourceOrbId: orbId,
        createdAt,
        lastUsedAt: createdAt,
        ...(imageRef ? { imageRef } : {}),
        ...(ampVersion ? { ampVersion } : {}),
      });
      say(`project snapshot ${req.snapshotId} saved as ${snap.id}`);
    } catch (e) {
      rec.state = "awake";
      rec.warmUntil = undefined;
      await saveOrb(kv, rec, now());
      return {
        ok: false,
        error: `Failed: project snapshot ${req.snapshotId} not saved (${errText(e)}); orb left running — fix: retry the pause; check cf-orbs status ${orbId}`,
      };
    }
  }

  if (warm) {
    // The run slot stays held (the alarm keeps the heartbeat). awakeSince stays: maxAwakeHours still applies.
    rec.state = "warm";
    rec.warmUntil = iso(clock.now() + warmMs);
    rec.dirtySince = undefined;
    await saveOrb(kv, rec, now());
    // Activity after this marker opens a dirty window: the alarm then snapshots again before it stops the orb.
    if (st.act !== undefined) await kv.put(ACTIVITY_KEY, st.act);
    if (st.use !== undefined) await kv.put(WARM_USE_KEY, st.use);
    else await kv.delete(WARM_USE_KEY);
    say(
      `orb paused warm in ${((clock.now() - t0) / 1000).toFixed(1)} s: disk saved, amp kept running until ${rec.warmUntil} (warmMinutes ${ctx.config.warmMinutes})`,
    );
    return { ok: true, handle };
  }

  await container.destroy();
  await registry.releaseRunSlot(orbId);
  rec.state = "paused";
  rec.lastStop = { at: now(), reason };
  clearAwake(rec);
  rec.dirtySince = undefined;
  await saveOrb(kv, rec, now());
  say(`orb paused in ${((clock.now() - t0) / 1000).toFixed(1)} s (${reason})`);
  return { ok: true, handle };
}

function clearAwake(rec: OrbRecord): void {
  rec.awakeSince = undefined;
  rec.warmUntil = undefined;
  rec.bootstrapTokenSha = undefined;
}

/** STATUS_SH: bootstrap alive on this boot, activity and use markers. An exec error reads as not alive. */
async function bootstrapStatus(ctx: OrbContext): Promise<{ alive: boolean; act?: string; use?: string }> {
  try {
    const [cmd, opts] = sh(STATUS_SH);
    const r = await ctx.container.exec(cmd, { ...opts, timeoutMs: 10_000 });
    return parseStatus(r.stdout);
  } catch {
    return { alive: false };
  }
}
