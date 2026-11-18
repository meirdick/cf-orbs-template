// Delete op (D13): destroy, forget the per-orb disk, write a tombstone. Project maps stay (other threads use them).
// Snapshot data stays until its 30-day TTL or `cf-orbs snapshots prune`. The Registry marks the orb deleted,
// so prune knows its newest snapshot is no longer a disk.
import type { OrbContext } from "./context";
import { iso, loadOrb, newOrbRecord, saveOrb } from "./journal";

export async function runDelete(ctx: OrbContext): Promise<{ ok: true }> {
  const { container, clock, kv, registry, orbId } = ctx;
  const now = () => iso(clock.now());
  const rec = (await loadOrb(kv)) ?? newOrbRecord(orbId, ctx.config, now());

  if (container.running) {
    await container.destroy();
    ctx.say("container destroyed");
  }
  if (rec.handle) ctx.say(`forgot orb disk snapshot ${rec.handle.id} (Cloudflare drops it after 30 d)`);
  rec.handle = undefined;
  rec.state = "deleted";
  rec.awakeSince = undefined;
  rec.warmUntil = undefined;
  rec.dirtySince = undefined;
  rec.bootstrapTokenSha = undefined;
  if (rec.deletedAt) ctx.say(`orb already deleted at ${rec.deletedAt}`);
  else {
    rec.deletedAt = now();
    rec.lastStop = { at: rec.deletedAt, reason: "deleted by Amp" };
  }
  await saveOrb(kv, rec, now());
  // Not fatal: without the marker, prune keeps the orb's newest snapshot until its TTL.
  await registry.orbDeleted(orbId, now()).catch(() => undefined);
  await registry.releaseRunSlot(orbId);
  return { ok: true };
}
