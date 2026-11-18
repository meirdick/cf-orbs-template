// Shared types for cf-orbs. Every module imports from here; nothing here imports runtime APIs.

/** Amp dispatch operations. See docs/01. */
export type AmpOp = "spawn" | "pause" | "delete";

/** Body of POST /v1/orbs/:orbId/ops, built by dispatch/dispatch.sh from ORB_* env. */
export interface OpRequest {
  op: AmpOp;
  /** ORB_SNAPSHOT_ID: project snapshot to boot from (spawn) or to save (pause). */
  snapshotId?: string;
  /** ORB_IMAGE (spawn only). Mapped to an image key by images.ts. */
  image?: string;
  /** ORB_TOKEN (spawn only). Never persisted; only its sha256 prefix is stored. */
  token?: string;
  /** AMP_URL (spawn only). */
  ampUrl?: string;
}

export type OpPhase = "queued" | "running" | "succeeded" | "failed";

/** Persisted op journal entry (D13). Progress lines are what the dispatch program prints into the setup log. */
export interface OpRecord {
  /** Schema version (D13). Old and new Worker code share storage; a missing v reads as 1. */
  v?: 1;
  opId: string; // `${orbId}:${uuid}`
  orbId: string;
  op: AmpOp;
  inputsHash: string; // sha256(op, snapshotId, image, tokenSha) → identical in-flight inputs share an op
  phase: OpPhase;
  startedAt: string; // ISO
  finishedAt?: string;
  progress: string[]; // human lines, redacted, max ~200
  error?: string; // one line: "<cause> — fix: <command>" when known
  result?: Record<string, unknown>;
}

export type OrbState =
  | "none" // never started
  | "starting"
  | "awake"
  | "pausing"
  | "warm" // paused by Amp: disk saved, container and amp kept running until warmUntil (warmMinutes)
  | "paused" // snapshot handle valid
  | "paused-stale" // container stopped without a fresh snapshot; handle may be old
  | "lost" // container found not running while we thought it was awake
  | "deleted";

export interface SnapshotHandle {
  id: string; // Cloudflare snapshot id
  size: number; // bytes reported by snapshotContainer
  imageKey: string; // key in images map the snapshot was taken from
  /** Deployed image ref (with digest) the disk came from, at pause time. Absent in handles from older code. */
  imageRef?: string;
  instance: OrbInstanceSpec;
  createdAt: string; // ISO
  lastRestoredAt?: string; // ISO; set on every successful restore. Expiry = max(createdAt, lastRestoredAt) + 30 d (D7)
  name?: string;
}

/** Where a spawn got its disk from. */
export type WakeSource = "warm" | "running" | "per-orb-snapshot" | "project-snapshot" | "image";

/** One spawn op, kept in OrbRecord.spawns (benchmarks and debugging). No secrets. */
export interface SpawnEntry {
  at: string; // ISO, when the spawn op started
  source?: WakeSource; // unknown when the spawn failed before a container came up
  ms: number; // wall time of the op
  ok: boolean;
  error?: string; // one redacted line
}

/** OrbRecord.spawns keeps this many entries, oldest first. */
export const SPAWN_HISTORY = 10;

/** Any Cloudflare Containers instance size. "lite" (1/16 vCPU, 256 MiB) is used only by the provider container. */
export type InstanceSpec =
  | "lite"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { vcpu: number; memoryMib: number; diskMb: number };

/** An orb size. "lite" is too small for the orb image, so config validation rejects it. */
export type OrbInstanceSpec = Exclude<InstanceSpec, "lite">;

/** Per-orb record in OrbSession storage under key "orb". */
export interface OrbRecord {
  /** Schema version (D13). Old and new Worker code share storage; a missing v reads as 1. */
  v?: 1;
  orbId: string;
  state: OrbState;
  imageKey: string;
  instance: OrbInstanceSpec;
  handle?: SnapshotHandle; // per-orb snapshot (last pause or checkpoint)
  bootstrapTokenSha?: string; // first 16 hex of sha256(ORB_TOKEN) for the running bootstrap
  awakeSince?: string;
  /** State warm: the alarm stops the container at this time (ISO). */
  warmUntil?: string;
  lastStop?: { at: string; reason: string };
  lastSpawnMs?: number; // wall time of last successful spawn op
  lastWakeSource?: WakeSource;
  spawns?: SpawnEntry[]; // last SPAWN_HISTORY spawn ops, successful or not, oldest first
  deletedAt?: string; // tombstone
  dirtySince?: string; // first exec/bootstrap activity since last snapshot (for opt-in checkpoints)
  updatedAt: string;
}

/** Why a project snapshot is out of date, and what cf-orbs did (projectSnapshotRefresh). */
export interface ProjectSnapshotStale {
  reason: string; // one line, for example "amp updated 0.0.1 -> 0.0.2"
  at: string; // ISO, first detection
  /** true: spawn ignores the mapping (forgotten). false: kept, because a forget for this project ran < 24 h ago. */
  forgotten: boolean;
}

/** Project snapshot mapping kept in the Registry DO. */
export interface ProjectSnapshotMapping {
  snapshotId: string; // Amp ORB_SNAPSHOT_ID
  handle: SnapshotHandle;
  sourceOrbId: string;
  createdAt: string;
  lastUsedAt: string;
  /** Deployed image ref (with digest) the disk came from, at pause time. Absent in mappings from older code. */
  imageRef?: string;
  /** `amp --version` in the orb at pause time. Absent when unknown. */
  ampVersion?: string;
  /** Set by spawn when projectSnapshotRefresh found the disk out of date. A new pause with this id clears it. */
  stale?: ProjectSnapshotStale;
}

/** Result of RegistryClient.markProjectSnapshotStale. */
export interface StaleMarkResult {
  /** true: the mapping is now forgotten; the next spawn with this id boots the image. */
  forgotten: boolean;
  /** One line for the setup log: why it was or was not forgotten. */
  note: string;
}

/** projectSnapshotRefresh: "off" = never act; "on-change" = forget a project snapshot made stale by an amp or image change. */
export type ProjectSnapshotRefresh = "off" | "on-change";

/** Provider-level configuration, derived from cf-orbs.config.jsonc and passed as Worker vars (JSON string in CF_ORBS_CONFIG). */
export interface ProviderConfig {
  instance: OrbInstanceSpec; // default { vcpu: 4, memoryMib: 12288, diskMb: 20000 }
  maxRunning: number; // default 20
  maxAwakeHours: number; // default 12
  checkpointMinutes: number; // default 0 = off
  /** After an Amp pause, keep the container and amp running this long (disk saved first). 0 = stop at once. */
  warmMinutes: number; // default 10
  inactivityTimeoutMinutes: number; // default 15
  alarmSeconds: number; // default 60
  /** Extra image refs → image keys (the default Amp image maps to "orb" automatically). */
  images: Record<string, string>;
  /** Pinned Amp orb image digest the "orb" image was built from; used for log lines only. */
  ampImageDigest: string;
  /** Allow POST /v1/orbs/:id/exec (debugging and benchmarks). Default false. */
  debugExec: boolean;
  /** Bootstrap sets transparent huge pages to "always" (the guest default is never). Default true. */
  hugePages: boolean;
  /** GiB of tmpfs (huge=always) the bootstrap mounts at /mnt/fast. 0 = off. Max memory GiB − 3, and 8. */
  fastTmpfsGb: number;
  /** Throwaway instances started from the current image after each deploy, to pull it onto hosts. 0-5; 0 = off. */
  prewarm: number;
  /** "on-change": after a restore from a project snapshot, forget it when amp self-updated or the image changed. */
  projectSnapshotRefresh: ProjectSnapshotRefresh;
}

export const DEFAULT_CONFIG: ProviderConfig = {
  instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
  maxRunning: 20,
  maxAwakeHours: 12,
  checkpointMinutes: 0,
  warmMinutes: 10,
  inactivityTimeoutMinutes: 15,
  alarmSeconds: 60,
  images: {},
  ampImageDigest: "sha256:378c5e2188f00960eca36dc806aa04e1cacd92c2341665bcdf4692326c462d6d",
  debugExec: false,
  hugePages: true,
  fastTmpfsGb: 0,
  prewarm: 2,
  projectSnapshotRefresh: "off",
};

export const AMP_DEFAULT_IMAGE_REPO = "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb";
export const SNAPSHOT_TTL_MS = 30 * 24 * 3600_000; // Cloudflare: 30 days from creation or last restore
export const PROJECT_MAP_TTL_MS = 72 * 3600_000; // Amp reuses a project snapshot id for up to 72 h
/** projectSnapshotRefresh forgets at most one project snapshot per project in this window. */
export const STALE_FORGET_INTERVAL_MS = 24 * 3600_000;
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600_000;
export const JOB_DEADLINE_MS = 4.5 * 60_000; // dispatch gives up at 4 min 30 s; Amp's limit is 5 min

/** Prewarm (config prewarm): at most this many instances per run. */
export const MAX_PREWARM = 5;
/** A prewarm instance that is not ready in this time is destroyed and counts as failed. */
export const WARM_JOB_TIMEOUT_MS = 3 * 60_000;
/** Prewarm orb ids `warm-<n>-<ts>`. Amp sends `amp-<thread id>`, so they cannot collide with a real orb. */
export const WARM_ORB_RE = /^warm-[1-9]-[0-9]{1,16}$/;
export const warmOrbId = (n: number, ts: number): string => `warm-${n}-${ts}`;

/** Result of one prewarm instance. */
export interface WarmResult {
  ok: boolean;
  /** start() → first exec(["true"]) OK, or time until the failure. */
  ms: number;
  error?: string;
}

/** One prewarm instance in the last run (Registry key "warm:last"). */
export interface WarmJobEntry {
  orbId: string;
  state: "pending" | "ready" | "failed";
  ms?: number;
  error?: string;
  finishedAt?: string;
}

/** Last prewarm run, as the Registry stores it. */
export interface WarmRun {
  runId: string;
  at: string; // ISO
  count: number;
  jobs: WarmJobEntry[];
}

/** GET /v1/warm and /v1/status "prewarm": the last run with totals. */
export interface WarmRunView extends WarmRun {
  ok: number;
  failed: number;
  pending: number;
  /** Ready times of the instances that became ready, in job order. */
  msPerInstance: number[];
}

/** Status returned by GET /v1/orbs/:orbId (and used by `cf-orbs status`). No secrets. */
export interface OrbStatus {
  orb: OrbRecord;
  containerRunning: boolean;
  bootstrap?: { alive: boolean; pid?: number };
  inFlightOp?: Pick<OpRecord, "opId" | "op" | "phase" | "startedAt">;
  snapshotExpiresAt?: string;
  /** Deployed image ref (with digest) the orb's disk came from. Absent in handles from older code. */
  diskImageRef?: string;
  /** Deployed image ref for the orb's image key now. Absent when that key is not deployed. */
  currentImageRef?: string;
  /** True when both refs are known and differ: the disk came from an older image under the same key. */
  diskImageStale?: boolean;
  /** Colo the orb's Durable Object runs in (from /cdn-cgi/trace). Best effort. */
  doColo?: string;
}

/** What OrbSession needs from the Registry DO (implemented as DO RPC in registry.ts, faked in tests). */
export interface RegistryClient {
  getProjectSnapshot(snapshotId: string): Promise<ProjectSnapshotMapping | undefined>;
  putProjectSnapshot(m: ProjectSnapshotMapping): Promise<void>;
  touchProjectSnapshot(snapshotId: string, usedAt: string): Promise<void>;
  dropProjectSnapshot(snapshotId: string): Promise<void>;
  /**
   * Mark a project snapshot stale. Forgets it (spawn then ignores it) unless a forget for the same project
   * ran in the last 24 h. Data stays in Cloudflare until its TTL; nothing on Amp's side changes.
   */
  markProjectSnapshotStale(snapshotId: string, reason: string, at: string): Promise<StaleMarkResult>;
  /** The stale mark of a mapping, also of a forgotten one (getProjectSnapshot hides those). */
  projectSnapshotStale(snapshotId: string): Promise<ProjectSnapshotStale | undefined>;
  /** Index of every snapshot ever created (there is no list/delete API on Cloudflare). */
  recordSnapshot(handle: SnapshotHandle, orbId: string): Promise<void>;
  /** Delete op: the orb has no disk from `at` on, so prune may delete its older snapshots. */
  orbDeleted(orbId: string, at: string): Promise<void>;
  /** Called by spawn before starting a container. Enforces maxRunning. */
  acquireRunSlot(orbId: string): Promise<{ ok: boolean; running: number; max: number }>;
  releaseRunSlot(orbId: string): Promise<void>;
  /** Called from the orb alarm while awake; stale heartbeats (> 3 alarm intervals) free the slot. */
  heartbeat(orbId: string): Promise<void>;
}
