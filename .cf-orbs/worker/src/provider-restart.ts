// Restart the ProviderHost container for a new provider image (POST /v1/provider/restart, the cron).
// Separate from provider.ts so api.ts can use it without the cloudflare:workers import.
//
// A DO that holds a running container keeps the code and the images of the deploy that built it (R17).
// So the caller sends its deploy's provider build. A DO on an older build stops its container and answers
// "reset"; this function then resets the DO and asks again, and the new DO starts the new image.
// A DO from before this code has no restart method: the route stops it, so it can unload and load new code.
import { type Env, PROVIDER_DO_NAME } from "./env";
import type { ProviderRestartResult, ProviderStatus, ProviderTrigger } from "./provider";

interface ProviderHostRpc {
  restart(o: { ifImageChanged?: boolean; build?: string }): Promise<ProviderRestartResult>;
  reset(): Promise<void>;
  ensureRunning(trigger?: ProviderTrigger): Promise<ProviderStatus>;
  stop(): Promise<void>;
}

export interface RestartOptions {
  ifImageChanged: boolean;
  /** A DO on code from before restart(): "ensure" keeps the old cron behavior, "stop" stops it. */
  onOldCode: "ensure" | "stop";
}

/** The RPC error when the DO class of the running instance has no such method. */
export function isMissingMethod(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /does not implement the method|is not a function|no such method|method .* not found/i.test(m);
}

export const OLD_CODE_REASON =
  "the provider Durable Object ran cf-orbs code from before provider restarts; stopped it so it loads the new code";

export async function restartProvider(
  env: Pick<Env, "PROVIDER" | "CF_ORBS_PROVIDER_BUILD">,
  o: RestartOptions,
): Promise<ProviderRestartResult> {
  const stub = () => env.PROVIDER.getByName(PROVIDER_DO_NAME) as unknown as ProviderHostRpc;
  const req = { ifImageChanged: o.ifImageChanged, build: env.CF_ORBS_PROVIDER_BUILD };
  const host = stub();
  let r: ProviderRestartResult;
  try {
    r = await host.restart(req);
  } catch (e) {
    if (!isMissingMethod(e)) throw e;
    if (o.onOldCode === "ensure") {
      const st = await host.ensureRunning("alarm");
      return { ...st, action: "keep", reason: "provider DO runs older code", restarted: false };
    }
    await host.stop();
    return {
      running: false,
      restarts: 0,
      stopped: true,
      logTail: [],
      action: "stopped-old-code",
      reason: OLD_CODE_REASON,
      restarted: false,
    };
  }
  if (r.action !== "reset") return r;
  try {
    await host.reset();
  } catch {
    // reset() aborts the DO, so the call fails by design.
  }
  const r2 = await stub().restart(req);
  if (r2.action === "reset") {
    throw new Error(
      "Failed: the provider Durable Object still runs the old deploy after a reset — fix: wait 2 min, then run cf-orbs deploy again",
    );
  }
  return { ...r2, reason: r.reason, restarted: r2.action === "start" || r2.action === "restart" };
}
