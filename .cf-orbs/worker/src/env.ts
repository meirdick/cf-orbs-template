// Worker bindings. wrangler.jsonc must match.

export interface Env {
  /** OrbSession DO, one per orb, named `orb:<orbId>`. */
  ORB: DurableObjectNamespace;
  /** Registry DO, single instance named `registry`. */
  REGISTRY: DurableObjectNamespace;
  /** ProviderHost DO, single instance named `provider`. */
  PROVIDER: DurableObjectNamespace;
  /** ProviderConfig as a JSON string. Parsed by core/config.ts. */
  CF_ORBS_CONFIG: string;
  /** Hash of the provider image inputs (provider/Dockerfile, entry.sh, dispatch.sh). Set by cf-orbs deploy. */
  CF_ORBS_PROVIDER_BUILD?: string;
  /** Bearer token for the public /v1 API (external provider mode). Unset → public routes return 404. */
  CONTROL_TOKEN?: string;
  /** Amp provider token (aop_live_…). Only the ProviderHost container gets it. Never log it. */
  AMP_ORB_PROVIDER_TOKEN?: string;
}

/** DO name for an orb. The `orb:` prefix keeps orb ids from naming other DOs (D2). */
export function orbDoName(orbId: string): string {
  return `orb:${orbId}`;
}

export const REGISTRY_DO_NAME = "registry";
export const PROVIDER_DO_NAME = "provider";
