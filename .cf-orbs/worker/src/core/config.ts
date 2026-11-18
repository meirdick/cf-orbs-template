// Parse CF_ORBS_CONFIG (JSON string written by `cf-orbs deploy` from cf-orbs.config.jsonc) into ProviderConfig.
// Missing fields take DEFAULT_CONFIG. Unknown fields (providerHost, debugSsh, ...) are ignored: the CLI uses them.
// Instance rules: https://developers.cloudflare.com/containers/platform/limits/#custom-instance-types
import {
  DEFAULT_CONFIG,
  type InstanceSpec,
  MAX_PREWARM,
  type OrbInstanceSpec,
  type ProjectSnapshotRefresh,
  type ProviderConfig,
} from "./types";

const FIX = "fix: edit cf-orbs.config.jsonc and run cf-orbs deploy";
const NAMED = ["standard-1", "standard-2", "standard-3", "standard-4"] as const;
/** Smallest disk that leaves room for the orb image (~2.4 GB used) plus a repo. Same as standard-1. */
export const MIN_ORB_DISK_MB = 8000;

function fail(cause: string, fix = FIX): never {
  throw new Error(`Failed: ${cause} — ${fix}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, name: string, min: number, max: number, integer = true): number {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (integer && !Number.isInteger(v)) ||
    v < min ||
    v > max
  ) {
    fail(
      `${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

export function validateInstance(v: unknown): OrbInstanceSpec {
  if (typeof v === "string") {
    if ((NAMED as readonly string[]).includes(v)) return v as OrbInstanceSpec;
    if (v === "lite" || v === "basic" || v === "dev") {
      fail(
        `instance ${v} is too small for the orb image`,
        `fix: set instance to standard-1 or larger in cf-orbs.config.jsonc`,
      );
    }
    fail(`unknown instance ${JSON.stringify(v)}; use standard-1..4 or {vcpu, memoryMib, diskMb}`);
  }
  if (!isObj(v))
    fail(`instance must be standard-1..4 or {vcpu, memoryMib, diskMb}, got ${JSON.stringify(v)}`);
  const vcpu = num(v.vcpu, "instance.vcpu", 1, 4, false);
  const memoryMib = num(v.memoryMib, "instance.memoryMib", 1, 12 * 1024);
  const diskMb = num(v.diskMb, "instance.diskMb", MIN_ORB_DISK_MB, 20_000);
  if (memoryMib < vcpu * 3072)
    fail(`instance.memoryMib ${memoryMib} is below 3 GiB per vCPU (${vcpu * 3072} for ${vcpu} vCPU)`);
  return { vcpu, memoryMib, diskMb };
}

/** Memory of an instance in MiB. */
export function instanceMemoryMib(i: InstanceSpec): number {
  if (typeof i === "object") return i.memoryMib;
  return { lite: 256, "standard-1": 4096, "standard-2": 6144, "standard-3": 8192, "standard-4": 12288 }[i];
}

/** fastTmpfsGb: 0-8, and at most the orb memory minus 3 GiB (Amp and the build need the rest). */
export function validateFastTmpfs(v: unknown, instance: InstanceSpec): number {
  const n = num(v, "fastTmpfsGb", 0, 8);
  const gib = Math.floor(instanceMemoryMib(instance) / 1024);
  const max = Math.max(0, gib - 3);
  if (n > max)
    fail(
      `fastTmpfsGb ${n} leaves less than 3 GiB of the orb's ${gib} GiB memory`,
      `fix: set fastTmpfsGb to ${max} or less in cf-orbs.config.jsonc and run cf-orbs deploy`,
    );
  return n;
}

/** projectSnapshotRefresh: "off" (default) or "on-change". */
export function validateSnapshotRefresh(v: unknown): ProjectSnapshotRefresh {
  if (v === "off" || v === "on-change") return v;
  fail(`projectSnapshotRefresh must be "off" or "on-change", got ${JSON.stringify(v)}`);
}

export function parseConfig(envValue: string | undefined): ProviderConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  if (envValue === undefined || envValue.trim() === "") return base;
  let raw: unknown;
  try {
    raw = JSON.parse(envValue);
  } catch {
    fail("CF_ORBS_CONFIG is not valid JSON", "fix: run cf-orbs deploy to regenerate it");
  }
  if (!isObj(raw)) fail("CF_ORBS_CONFIG must be a JSON object", "fix: run cf-orbs deploy to regenerate it");

  const out = base;
  if (raw.instance !== undefined) out.instance = validateInstance(raw.instance);
  if (raw.maxRunning !== undefined) out.maxRunning = num(raw.maxRunning, "maxRunning", 1, 1000);
  if (raw.maxAwakeHours !== undefined)
    out.maxAwakeHours = num(raw.maxAwakeHours, "maxAwakeHours", 1, 24 * 30, false);
  if (raw.checkpointMinutes !== undefined) {
    const c = num(raw.checkpointMinutes, "checkpointMinutes", 0, 24 * 60);
    if (c !== 0 && c < 15) fail(`checkpointMinutes must be 0 (off) or at least 15, got ${c}`);
    out.checkpointMinutes = c;
  }
  if (raw.warmMinutes !== undefined) out.warmMinutes = num(raw.warmMinutes, "warmMinutes", 0, 120);
  if (raw.inactivityTimeoutMinutes !== undefined) {
    out.inactivityTimeoutMinutes = num(raw.inactivityTimeoutMinutes, "inactivityTimeoutMinutes", 5, 360);
  }
  if (raw.alarmSeconds !== undefined) out.alarmSeconds = num(raw.alarmSeconds, "alarmSeconds", 10, 3600);
  if (out.alarmSeconds * 1000 >= out.inactivityTimeoutMinutes * 60_000) {
    fail(
      `alarmSeconds ${out.alarmSeconds} must be shorter than inactivityTimeoutMinutes ${out.inactivityTimeoutMinutes}`,
    );
  }
  if (raw.debugExec !== undefined) {
    if (typeof raw.debugExec !== "boolean") fail("debugExec must be true or false");
    out.debugExec = raw.debugExec;
  }
  if (raw.hugePages !== undefined) {
    if (typeof raw.hugePages !== "boolean") fail("hugePages must be true or false");
    out.hugePages = raw.hugePages;
  }
  if (raw.fastTmpfsGb !== undefined) out.fastTmpfsGb = validateFastTmpfs(raw.fastTmpfsGb, out.instance);
  if (raw.prewarm !== undefined) out.prewarm = num(raw.prewarm, "prewarm", 0, MAX_PREWARM);
  if (raw.projectSnapshotRefresh !== undefined)
    out.projectSnapshotRefresh = validateSnapshotRefresh(raw.projectSnapshotRefresh);
  if (raw.images !== undefined) {
    if (!isObj(raw.images)) fail("images must be an object of image ref → image key");
    const images: Record<string, string> = {};
    for (const [ref, key] of Object.entries(raw.images)) {
      if (typeof key !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(key)) {
        fail(
          `images[${JSON.stringify(ref)}] must be an image key like "my-image", got ${JSON.stringify(key)}`,
        );
      }
      images[ref] = key;
    }
    out.images = images;
  }
  if (raw.ampImageDigest !== undefined) {
    if (typeof raw.ampImageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.ampImageDigest)) {
      fail(`ampImageDigest must look like sha256:<64 hex>, got ${JSON.stringify(raw.ampImageDigest)}`);
    }
    out.ampImageDigest = raw.ampImageDigest;
  }
  return out;
}
