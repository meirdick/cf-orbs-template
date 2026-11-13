// cf-orbs Worker entry. Public fetch = /v1 API (external mode, bearer). ControlApi = same API without auth,
// reached only from the provider container through interceptOutboundHttp("control.internal", ctx.exports.ControlApi).
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleApi } from "./api";
import type { Env } from "./env";
import { ensureProviderRunning } from "./provider";

export { OrbSession } from "./orb/session";
export { ProviderHost } from "./provider";
export { Registry } from "./registry";

export class ControlApi extends WorkerEntrypoint<Env> {
  override fetch(req: Request): Promise<Response> {
    return handleApi(req, this.env, { internal: true });
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleApi(req, env, { internal: false });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      ensureProviderRunning(env).catch((e: unknown) => {
        console.error(`provider check failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
