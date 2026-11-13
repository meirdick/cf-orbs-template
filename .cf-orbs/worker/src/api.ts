// HTTP routing for the control plane (D11, D18).
// - Internal (ControlApi entrypoint, reached from the provider container via control.internal): no auth.
// - Public (Worker fetch): bearer CONTROL_TOKEN. If CONTROL_TOKEN is unset, every public route is 404.
// Responses never carry stack traces. Errors are one line: "Failed: <cause> — fix: <action>".
import { parseConfig } from "./core/config";
import { PRUNE_DEFAULT_AGE_MS } from "./core/registry-core";
import { replyText } from "./core/text";
import {
  type AmpOp,
  type OpRecord,
  type OpRequest,
  type OrbStatus,
  WARM_ORB_RE,
  type WarmResult,
  type WarmRun,
  type WarmRunView,
} from "./core/types";
import { type Env, orbDoName, PROVIDER_DO_NAME, REGISTRY_DO_NAME } from "./env";
import { BENCH_ORB_RE, type BenchStartRequest, parseBenchStart } from "./orb/bench";
import { redactLine } from "./orb/journal";
import { restartProvider } from "./provider-restart";

/** Text-mode long-poll: after new progress lines, wait this long for more before the reply. */
export const TEXT_LINGER_MS = 400;

function isRunning(rec: OpRecord): boolean {
  return rec.phase === "queued" || rec.phase === "running";
}

export const API_VERSION = "0.2.5";

/** D2. Amp sends `amp-<thread id>`. Never starts with `_` or `.`, so it cannot look like an internal name. */
export const ORB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OP_UUID_RE = /^[A-Za-z0-9-]{1,64}$/;
const OPS: readonly AmpOp[] = ["spawn", "pause", "delete"];
export const MAX_WAIT_MS = 25_000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_LOG_LINES = 1000;

/** What api.ts calls on an OrbSession stub. OrbSession implements it. */
export interface OrbSessionApi {
  submitOp(req: OpRequest): Promise<{ opId: string; attached: boolean }>;
  /** Long-poll: returns when the op is terminal, progress.length > since, or waitMs passes. null = unknown op. */
  getOp(opId: string, waitMs: number, since?: number): Promise<OpRecord | null>;
  status(): Promise<OrbStatus>;
  logs(lines: number): Promise<{ containerRunning: boolean; log: string }>;
  /** Debug/bench only; the DO refuses unless config.debugExec is true. */
  exec(cmd: string[], timeoutMs: number): Promise<unknown>;
  /** Bench only (bench-* orbs, debugExec). start + readiness race; no orb record, no run slot. */
  benchStart(req: BenchStartRequest): Promise<unknown>;
  benchSnapshot(name: string): Promise<unknown>;
  benchDestroy(): Promise<unknown>;
  /** Prewarm only (warm-* orbs). Stores the job and returns; the DO alarm runs it. */
  warmStart(runId: string): Promise<{ orbId: string; queued: boolean }>;
}

/** What api.ts calls on the Registry stub for /v1/warm. Registry implements it. */
interface WarmAdmin {
  startWarmRun(count: number): Promise<WarmRun>;
  recordWarmResult(runId: string, orbId: string, r: WarmResult): Promise<boolean>;
  warmStatus(): Promise<WarmRunView | null>;
}

interface StatusSource {
  status(): Promise<unknown>;
}

/** What api.ts calls on the Registry stub for /v1/project-snapshots. Registry implements it. */
interface ProjectSnapshotAdmin {
  listProjectSnapshots(): Promise<unknown[]>;
  forgetProjectSnapshot(snapshotId: string): Promise<boolean>;
  status(): Promise<unknown>;
}

/** What api.ts calls on the Registry stub for /v1/snapshots (`cf-orbs snapshots prune`). */
interface SnapshotIndexAdmin {
  listSnapshots(): Promise<unknown[]>;
  pruneCandidates(olderThanMs: number): Promise<unknown>;
  forgetSnapshots(ids: string[]): Promise<unknown>;
  status(): Promise<unknown>;
}

/** Max ids in one POST /v1/snapshots/forget-many. */
export const MAX_FORGET_IDS = 1000;
/** Cloudflare snapshot id as the index stores it. */
export const CF_SNAPSHOT_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;

/** Amp ORB_SNAPSHOT_ID as stored by spawn/pause: 1-256 chars (see parseOpRequest), no control chars, no '/'. */
export function isProjectSnapshotId(id: string): boolean {
  if (id.length < 1 || id.length > 256) return false;
  for (const ch of id) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "/") return false;
  }
  return true;
}

interface ProviderStarter {
  ensureRunning(): Promise<unknown>;
}

export interface ApiOptions {
  internal: boolean;
}

export async function handleApi(req: Request, env: Env, opts: ApiOptions): Promise<Response> {
  const res = await handleJson(req, env, opts);
  const q = new URL(req.url).searchParams;
  if (q.get("format") !== "text") return res;
  return asText(res, clampInt(q.get("since"), 0, 1_000_000, 0));
}

/** ?format=text: the same reply as key=value lines (core/text.ts). Status is kept. */
async function asText(res: Response, since: number): Promise<Response> {
  let v: unknown;
  try {
    v = await res.json();
  } catch {
    v = undefined;
  }
  return new Response(replyText(v, since, redactLine), {
    status: res.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleJson(req: Request, env: Env, opts: ApiOptions): Promise<Response> {
  try {
    if (!opts.internal) {
      const denied = await checkAuth(req, env);
      if (denied) return denied;
    }
    return await route(req, env, opts.internal);
  } catch (e) {
    const msg = oneLine(e, 400);
    console.error(`api ${req.method} ${new URL(req.url).pathname}: ${msg}`);
    // Errors that already carry fix text (bad config, missing container) pass through as they are.
    if (msg.startsWith("Failed:")) return json(500, { error: msg });
    return fail(
      500,
      `internal error: ${msg}`,
      "retry; if it repeats, run cf-orbs logs and check Worker logs",
    );
  }
}

async function checkAuth(req: Request, env: Env): Promise<Response | null> {
  const want = env.CONTROL_TOKEN;
  if (!want) return notFound(req);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m?.[1] || !(await timingSafeEqualStr(m[1], want))) {
    return fail(
      401,
      "missing or wrong bearer token",
      "set CF_ORBS_CONTROL_TOKEN to the CONTROL_TOKEN secret",
    );
  }
  return null;
}

async function route(req: Request, env: Env, internal: boolean): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "v1") return notFound(req);
  const [, a, b, c, ...rest] = parts;
  if (rest.length > 0) return notFound(req);
  const method = req.method.toUpperCase();

  if (a === "health" && b === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    return json(200, { ok: true, name: "cf-orbs", version: API_VERSION });
  }

  if (a === "status" && b === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    return json(200, await providerStatus(env));
  }

  // Used by `cf-orbs init` so it need not wait for the 5-min cron (D18).
  if (a === "provider" && b === "start" && c === undefined) {
    if (method !== "POST") return methodNotAllowed(method, url.pathname);
    if (!env.AMP_ORB_PROVIDER_TOKEN) {
      return fail(
        409,
        "AMP_ORB_PROVIDER_TOKEN is not set, so the provider runs outside Cloudflare (external mode)",
        "start your external provider, or set AMP_ORB_PROVIDER_TOKEN and run cf-orbs init --provider cloudflare",
      );
    }
    const host = env.PROVIDER.getByName(PROVIDER_DO_NAME) as unknown as ProviderStarter;
    return json(200, await host.ensureRunning());
  }

  // `cf-orbs deploy` calls it with ifImageChanged=1. Public only: the provider must not restart itself.
  if (a === "provider" && b === "restart" && c === undefined && !internal) {
    if (method !== "POST") return methodNotAllowed(method, url.pathname);
    if (!env.AMP_ORB_PROVIDER_TOKEN) {
      return fail(
        409,
        "AMP_ORB_PROVIDER_TOKEN is not set, so the provider runs outside Cloudflare (external mode)",
        "restart your external provider yourself",
      );
    }
    const ifImageChanged = url.searchParams.get("ifImageChanged") === "1";
    return json(200, await restartProvider(env, { ifImageChanged, onOldCode: "stop" }));
  }

  // Prewarm after a deploy (`cf-orbs deploy` and `init` call POST). Best effort; returns at once.
  if (a === "warm" && b === undefined) {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as WarmAdmin;
    if (method === "GET") {
      const cfg = configOrNull(env);
      return json(200, { prewarm: cfg?.prewarm ?? null, last: await reg.warmStatus() });
    }
    if (method !== "POST") return methodNotAllowed(method, url.pathname);
    return json(200, await startPrewarm(env, reg));
  }

  // `cf-orbs snapshots list|forget`. Forget drops only the mapping; Cloudflare keeps the data until its TTL.
  if (a === "project-snapshots" && c === undefined) {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as ProjectSnapshotAdmin;
    if (b === undefined) {
      if (method !== "GET") return methodNotAllowed(method, url.pathname);
      const [projectSnapshots, summary] = await Promise.all([reg.listProjectSnapshots(), reg.status()]);
      return json(200, { projectSnapshots, summary });
    }
    if (method !== "DELETE") return methodNotAllowed(method, url.pathname);
    const id = decodeSegment(b);
    if (id === null || !isProjectSnapshotId(id))
      return fail(
        400,
        `invalid project snapshot id ${clip(b)}`,
        "pass the Amp snapshot id from cf-orbs snapshots list",
      );
    return json(200, { snapshotId: id, forgotten: await reg.forgetProjectSnapshot(id) });
  }

  // `cf-orbs snapshots prune`. The CLI deletes the data with wrangler, then calls forget-many.
  if (a === "snapshots" && c === undefined) {
    const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME) as unknown as SnapshotIndexAdmin;
    if (b === undefined) {
      if (method !== "GET") return methodNotAllowed(method, url.pathname);
      if (url.searchParams.get("candidates") === "1") {
        const raw = url.searchParams.get("olderThan");
        const olderThan = raw === null ? PRUNE_DEFAULT_AGE_MS / 1000 : Number(raw);
        if (!Number.isInteger(olderThan) || olderThan < 0 || olderThan > 365 * 24 * 3600)
          return fail(400, `invalid olderThan ${clip(String(raw))}`, "pass whole seconds, 0 to 31536000");
        return json(200, await reg.pruneCandidates(olderThan * 1000));
      }
      const [snapshots, summary] = await Promise.all([reg.listSnapshots(), reg.status()]);
      return json(200, { snapshots, summary });
    }
    if (b !== "forget-many") return notFound(req);
    if (method !== "POST") return methodNotAllowed(method, url.pathname);
    const body = await readJson(req);
    const ids = typeof body === "object" && body !== null ? (body as { ids?: unknown }).ids : undefined;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_FORGET_IDS ||
      !ids.every((x) => typeof x === "string" && CF_SNAPSHOT_ID_RE.test(x))
    )
      return fail(
        400,
        typeof body === "string"
          ? body
          : `forget-many needs {ids: string[]} with at most ${MAX_FORGET_IDS} snapshot ids`,
        "pass the ids from GET /v1/snapshots?candidates=1",
      );
    return json(200, await reg.forgetSnapshots(ids as string[]));
  }

  if (a === "ops" && b !== undefined && c === undefined) {
    if (method !== "GET") return methodNotAllowed(method, url.pathname);
    const opId = decodeSegment(b);
    const parsed = opId === null ? null : splitOpId(opId);
    if (!parsed)
      return fail(400, `invalid op id ${clip(b)}`, "use the opId returned by POST /v1/orbs/<orb>/ops");
    const waitMs = clampSeconds(url.searchParams.get("wait"), 0, MAX_WAIT_MS);
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null ? undefined : clampInt(sinceRaw, 0, 1_000_000, 0);
    const stub = orbStub(env, parsed.orbId);
    let rec = await stub.getOp(opId as string, waitMs, since);
    // dispatch.sh (text mode) polls again after each reply with new lines, and each poll starts a process
    // in the provider container. Progress lines come in groups, so wait a moment and send the group in one reply.
    if (rec && waitMs > 0 && url.searchParams.get("format") === "text" && isRunning(rec)) {
      if (rec.progress.length > (since ?? 0)) {
        await new Promise((r) => setTimeout(r, TEXT_LINGER_MS));
        rec = (await stub.getOp(opId as string, 0, since)) ?? rec;
      }
    }
    if (!rec) return fail(404, `op ${opId} not found`, "start the op again with POST /v1/orbs/<orb>/ops");
    return json(200, rec);
  }

  if (a === "orbs" && b !== undefined) {
    const orbId = decodeSegment(b);
    if (orbId === null || !ORB_ID_RE.test(orbId)) {
      return fail(
        400,
        `invalid orb id ${clip(b)}`,
        "check ORB_ID from Amp (letters, digits, - and _, max 128)",
      );
    }
    if (c === undefined) {
      if (method !== "GET") return methodNotAllowed(method, url.pathname);
      return json(200, await orbStub(env, orbId).status());
    }
    if (c === "logs") {
      if (method !== "GET") return methodNotAllowed(method, url.pathname);
      const lines = clampInt(url.searchParams.get("lines"), 1, MAX_LOG_LINES, 100);
      return json(200, await orbStub(env, orbId).logs(lines));
    }
    if (c === "exec") {
      if (method !== "POST") return methodNotAllowed(method, url.pathname);
      if (!debugExecOn(env)) return debugOff(req, "exec");
      const body = await readJson(req);
      if (
        typeof body === "string" ||
        !Array.isArray((body as any).cmd) ||
        !(body as any).cmd.every((x: unknown) => typeof x === "string")
      )
        return fail(400, "exec needs {cmd: string[], timeoutMs?}", "send a JSON body");
      const t = clampInt(String((body as any).timeoutMs ?? ""), 1000, 600_000, 60_000);
      return json(200, await orbStub(env, orbId).exec((body as any).cmd, t));
    }
    if (c === "bench") {
      if (method !== "POST") return methodNotAllowed(method, url.pathname);
      if (!debugExecOn(env)) return debugOff(req, "bench");
      if (!BENCH_ORB_RE.test(orbId))
        return fail(
          400,
          `bench needs an orb id that starts with bench-, got ${clip(orbId)}`,
          "use bench-<run>-<n>",
        );
      const body = await readJson(req);
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return fail(400, typeof body === "string" ? body : "body must be a JSON object", BENCH_FIX);
      const b = body as Record<string, unknown>;
      const stub = orbStub(env, orbId);
      const workerColo = (req as { cf?: { colo?: unknown } }).cf?.colo;
      const tag = (r: unknown) => json(200, { ...(r as object), workerColo });
      if (b.action === "start") {
        const parsed = parseBenchStart(b);
        if (typeof parsed === "string") return fail(400, parsed, BENCH_FIX);
        return tag(await stub.benchStart(parsed));
      }
      if (b.action === "snapshot")
        return tag(await stub.benchSnapshot(typeof b.name === "string" ? b.name : ""));
      if (b.action === "destroy") return tag(await stub.benchDestroy());
      return fail(400, `unknown bench action ${clip(String(b.action))}`, BENCH_FIX);
    }
    if (c === "ops") {
      if (method !== "POST") return methodNotAllowed(method, url.pathname);
      if (WARM_ORB_RE.test(orbId))
        return fail(
          400,
          `orb id ${clip(orbId)} is reserved for prewarm`,
          "use the ORB_ID from Amp (amp-<thread id>)",
        );
      const body = await readJson(req);
      if (typeof body === "string")
        return fail(400, body, "send a JSON body {op, snapshotId?, image?, token?, ampUrl?}");
      const op = parseOpRequest(body);
      if (typeof op === "string") return fail(400, op, "update cf-orbs so dispatch.sh and the Worker match");
      return json(200, await orbStub(env, orbId).submitOp(op));
    }
  }
  return notFound(req);
}

const BENCH_FIX =
  'send {action: "start", source: "image" | {snapshotId}, instance?}, {action: "snapshot", name?} or {action: "destroy"}';

/**
 * Record a new run in the Registry, then queue one job per warm-* OrbSession. Queuing is fast (store + alarm);
 * the jobs run in the DO alarms. A job that cannot be queued is recorded as failed at once.
 */
async function startPrewarm(
  env: Env,
  reg: WarmAdmin,
): Promise<{ count: number; started: number; orbIds: string[]; runId?: string; errors?: string[] }> {
  const count = parseConfig(env.CF_ORBS_CONFIG).prewarm;
  if (count === 0) return { count: 0, started: 0, orbIds: [] };
  const run = await reg.startWarmRun(count);
  const errors: string[] = [];
  await Promise.all(
    run.jobs.map(async (j) => {
      try {
        await orbStub(env, j.orbId).warmStart(run.runId);
      } catch (e) {
        const error = `could not queue the job: ${oneLine(e)}`;
        errors.push(`${j.orbId}: ${error}`);
        await reg.recordWarmResult(run.runId, j.orbId, { ok: false, ms: 0, error }).catch(() => false);
      }
    }),
  );
  return {
    runId: run.runId,
    count: run.count,
    started: run.count - errors.length,
    orbIds: run.jobs.map((j) => j.orbId),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function configOrNull(env: Env): ReturnType<typeof parseConfig> | null {
  try {
    return parseConfig(env.CF_ORBS_CONFIG);
  } catch {
    return null;
  }
}

/** exec and bench are debug routes (D21). The API checks the newest config; the DO checks its own. */
function debugExecOn(env: Env): boolean {
  try {
    return parseConfig(env.CF_ORBS_CONFIG).debugExec;
  } catch {
    return false;
  }
}

function debugOff(req: Request, what: string): Response {
  return fail(
    404,
    `${what} is disabled on ${clip(new URL(req.url).pathname)} (debugExec is false)`,
    'set "debugExec": true in cf-orbs.config.jsonc and run cf-orbs deploy',
  );
}

async function providerStatus(env: Env): Promise<{ registry: unknown; provider: unknown; prewarm: unknown }> {
  const reg = env.REGISTRY.getByName(REGISTRY_DO_NAME);
  const [registry, provider, prewarm] = await Promise.all([
    safeStatus(() => (reg as unknown as StatusSource).status()),
    safeStatus(() => (env.PROVIDER.getByName(PROVIDER_DO_NAME) as unknown as StatusSource).status()),
    safeStatus(() => (reg as unknown as WarmAdmin).warmStatus()),
  ]);
  return { registry, provider, prewarm };
}

async function safeStatus(f: () => Promise<unknown>): Promise<unknown> {
  try {
    return await f();
  } catch (e) {
    return { error: `Failed: status not available: ${oneLine(e)} — fix: run cf-orbs deploy` };
  }
}

function orbStub(env: Env, orbId: string): OrbSessionApi {
  return env.ORB.getByName(orbDoName(orbId)) as unknown as OrbSessionApi;
}

/** opId = `<orbId>:<uuid>`. orbId cannot contain ':', so split at the first one. */
export function splitOpId(opId: string): { orbId: string; uuid: string } | null {
  const i = opId.indexOf(":");
  if (i <= 0) return null;
  const orbId = opId.slice(0, i);
  const uuid = opId.slice(i + 1);
  if (!ORB_ID_RE.test(orbId) || !OP_UUID_RE.test(uuid)) return null;
  return { orbId, uuid };
}

/** Validate the POST body. Returns the request, or a one-line cause. Unknown fields are dropped. */
export function parseOpRequest(body: unknown): OpRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.op !== "string" || !(OPS as readonly string[]).includes(b.op)) {
    return `unknown op ${clip(String(b.op))}; expected spawn, pause or delete`;
  }
  const out: OpRequest = { op: b.op as AmpOp };
  const fields: Array<[keyof OpRequest, number]> = [
    ["snapshotId", 256],
    ["image", 512],
    ["token", 8192],
    ["ampUrl", 2048],
  ];
  for (const [k, max] of fields) {
    const v = b[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string") return `${k} must be a string`;
    if (v.length > max) return `${k} is longer than ${max} characters`;
    (out as unknown as Record<string, string>)[k] = v;
  }
  if (out.op === "spawn" && !out.token) return "spawn needs ORB_TOKEN";
  return out;
}

async function readJson(req: Request): Promise<unknown | string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return `body larger than ${MAX_BODY_BYTES} bytes`;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return `body larger than ${MAX_BODY_BYTES} bytes`;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return "body is not valid JSON";
  }
}

/** Seconds from a query value → ms, clamped. Missing or bad → min. */
export function clampSeconds(v: string | null, minMs: number, maxMs: number): number {
  const n = v === null ? Number.NaN : Number(v);
  if (!Number.isFinite(n)) return minMs;
  return Math.min(maxMs, Math.max(minMs, Math.round(n * 1000)));
}

export function clampInt(v: string | null, min: number, max: number, dflt: number): number {
  const n = v === null ? Number.NaN : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Constant-time compare: hash both sides so length and content leak nothing through timing. */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** One line, no stack, no token-shaped strings. */
export function oneLine(e: unknown, max = 300): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = (msg.split("\n")[0] ?? "").replace(/\b(aop_live_|orb_)[A-Za-z0-9_-]+/g, "$1<redacted>");
  return clip(line, max);
}

function clip(s: string, max = 140): string {
  let t = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    t += c < 0x20 || c === 0x7f ? "?" : ch;
  }
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status: number, cause: string, fix: string): Response {
  return json(status, { error: `Failed: ${cause} — fix: ${fix}` });
}

function notFound(req: Request): Response {
  return fail(
    404,
    `no route ${req.method} ${clip(new URL(req.url).pathname)}`,
    "check the cf-orbs URL and version",
  );
}

function methodNotAllowed(method: string, path: string): Response {
  return fail(405, `${method} not allowed on ${clip(path)}`, "check the cf-orbs CLI version");
}
