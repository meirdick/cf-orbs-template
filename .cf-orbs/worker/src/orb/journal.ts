// Op journal (D11, D13) plus the orb record and handle helpers every op shares.
// Keys: "op:<opId>" (OpRecord), "ops:inflight" (opId[]), "orb" (OrbRecord).
import type { KV } from "../core/container-port";
import {
  type OpRecord,
  type OpRequest,
  type OrbRecord,
  type ProviderConfig,
  SNAPSHOT_TTL_MS,
  type SnapshotHandle,
} from "../core/types";
import { redact } from "./scripts";

const INFLIGHT = "ops:inflight";
const MAX_PROGRESS = 200;
export const PROGRESS_CAPPED = "(more progress lines dropped; see cf-orbs logs <orb>)";
const opKey = (opId: string) => `op:${opId}`;

export async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First 16 hex of sha256(token). The only form of a token that is ever stored. */
export async function tokenSha(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 16);
}

/** sha256(op, snapshotId, image, tokenSha). Identical in-flight inputs share one op. */
export async function hashInputs(req: OpRequest): Promise<string> {
  const ts = req.token ? await tokenSha(req.token) : "";
  return sha256Hex(JSON.stringify([req.op, req.snapshotId ?? "", req.image ?? "", ts]));
}

/** Redact aop_live_ keys, orb_ tokens, Bearer values, JWTs and long opaque runs. Same rules as the scripts (D9). */
export function redactLine(s: string): string {
  return redact(s);
}

/** Redact the exact token value first, then the generic patterns. */
export function redactWith(token: string | undefined, s: string): string {
  return redact(s, token ? [token] : []);
}

async function inflightIds(kv: KV): Promise<string[]> {
  return (await kv.get<string[]>(INFLIGHT)) ?? [];
}

export async function getOp(kv: KV, opId: string): Promise<OpRecord | undefined> {
  return kv.get<OpRecord>(opKey(opId));
}

/** Attach to an in-flight op with the same inputs, or create a queued one. */
export async function openOp(
  kv: KV,
  orbId: string,
  req: OpRequest,
  now: string,
): Promise<{ record: OpRecord; attached: boolean }> {
  const inputsHash = await hashInputs(req);
  const live: string[] = [];
  for (const id of await inflightIds(kv)) {
    const op = await getOp(kv, id);
    if (!op || op.phase === "succeeded" || op.phase === "failed") continue;
    live.push(id);
    if (op.inputsHash === inputsHash && op.orbId === orbId) {
      return { record: op, attached: true };
    }
  }
  const record: OpRecord = {
    v: 1,
    opId: `${orbId}:${crypto.randomUUID()}`,
    orbId,
    op: req.op,
    inputsHash,
    phase: "queued",
    startedAt: now,
    progress: [],
  };
  await kv.put(opKey(record.opId), record);
  await kv.put(INFLIGHT, [...live, record.opId]);
  return { record, attached: false };
}

export async function markRunning(kv: KV, opId: string): Promise<void> {
  const op = await getOp(kv, opId);
  if (op?.phase !== "queued") return;
  op.phase = "running";
  await kv.put(opKey(opId), op);
}

export async function finishOp(
  kv: KV,
  opId: string,
  phase: "succeeded" | "failed",
  patch: Partial<OpRecord>,
): Promise<void> {
  const op = await getOp(kv, opId);
  if (op) {
    const next: OpRecord = {
      ...op,
      ...patch,
      opId: op.opId,
      orbId: op.orbId,
      phase,
      finishedAt: patch.finishedAt ?? new Date().toISOString(),
    };
    if (next.error) next.error = redactLine(next.error.replace(/\s*\n\s*/g, " "));
    await kv.put(opKey(opId), next);
  }
  const ids = await inflightIds(kv);
  if (ids.includes(opId))
    await kv.put(
      INFLIGHT,
      ids.filter((i) => i !== opId),
    );
}

export async function appendProgress(kv: KV, opId: string, line: string): Promise<void> {
  const op = await getOp(kv, opId);
  if (!op) return;
  // Append-only: dispatch.sh prints lines by index, so lines must never shift. At the cap, write one
  // marker and drop later lines; the final error still goes in record.error.
  if (op.progress.length >= MAX_PROGRESS) return;
  op.progress.push(op.progress.length === MAX_PROGRESS - 1 ? PROGRESS_CAPPED : redactLine(line));
  await kv.put(opKey(opId), op);
}

/** After a DO restart no op is still executing: fail every queued or running op. */
export async function recoverInflight(kv: KV, nowIso: string): Promise<OpRecord[]> {
  const out: OpRecord[] = [];
  for (const id of await inflightIds(kv)) {
    const op = await getOp(kv, id);
    if (!op || op.phase === "succeeded" || op.phase === "failed") continue;
    op.phase = "failed";
    op.finishedAt = nowIso;
    op.error = `Failed: control plane restarted during ${op.op}; the job will be retried by Amp — fix: none needed; if it repeats run cf-orbs logs ${op.orbId}`;
    await kv.put(opKey(id), op);
    out.push(op);
  }
  await kv.put(INFLIGHT, []);
  return out;
}

/** Drop finished op records older than beforeIso. Returns the count removed. */
export async function pruneOps(kv: KV, beforeIso: string): Promise<number> {
  const live = new Set(await inflightIds(kv));
  let n = 0;
  for (const [k, op] of await kv.list<OpRecord>("op:")) {
    if (live.has(op.opId)) continue;
    if ((op.finishedAt ?? op.startedAt) < beforeIso) {
      await kv.delete(k);
      n++;
    }
  }
  return n;
}

// ---- orb record ----

/** Kept as an alias: SnapshotHandle now carries lastRestoredAt (D7). */
export type Handle = SnapshotHandle;

/** Cloudflare keeps a snapshot 30 d from creation or last restore. */
export function handleExpiresAt(h: Handle): number {
  const created = Date.parse(h.createdAt);
  const restored = h.lastRestoredAt ? Date.parse(h.lastRestoredAt) : 0;
  return Math.max(created, restored) + SNAPSHOT_TTL_MS;
}

/**
 * Image state of an orb disk: the deployed ref for the handle's image key now, and whether the disk came
 * from an older ref under that key (a deploy or upgrade with a new digest). A handle from older code has no
 * imageRef, so it cannot be called stale.
 */
export function diskImageState(
  h: SnapshotHandle,
  images: Record<string, string>,
): { imageRef?: string; currentImageRef?: string; stale: boolean } {
  const currentImageRef = images[h.imageKey];
  return {
    ...(h.imageRef ? { imageRef: h.imageRef } : {}),
    ...(currentImageRef ? { currentImageRef } : {}),
    stale: Boolean(h.imageRef && currentImageRef && h.imageRef !== currentImageRef),
  };
}

export function newOrbRecord(orbId: string, config: ProviderConfig, nowIso: string): OrbRecord {
  return { v: 1, orbId, state: "none", imageKey: "orb", instance: config.instance, updatedAt: nowIso };
}

export async function loadOrb(kv: KV): Promise<OrbRecord | undefined> {
  return kv.get<OrbRecord>("orb");
}

export async function saveOrb(kv: KV, rec: OrbRecord, nowIso: string): Promise<void> {
  rec.updatedAt = nowIso;
  await kv.put("orb", rec);
}

/** Last activity marker from STATUS_SH ("act <bytes>": size of bootstrap.log + cli.log). */
export const ACTIVITY_KEY = "activity";
/** Warm orb: STATUS_SH "use <n>" at the pause. A different value means Amp used the orb without a spawn. */
export const WARM_USE_KEY = "warmUse";

/** Parse STATUS_SH output. */
export function parseStatus(stdout: string): { alive: boolean; act?: string; use?: string } {
  return {
    alive: (stdout.trim().split("\n")[0] ?? "").startsWith("alive"),
    act: /^act (\d+)$/m.exec(stdout)?.[1],
    use: /^use (\d+)$/m.exec(stdout)?.[1],
  };
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\s*\n\s*/g, " ").slice(0, 300);
}
