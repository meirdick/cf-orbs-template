// ORB_IMAGE → image key (D5). The runtime cannot pull arbitrary images; only keys deployed in
// wrangler.jsonc exist. Any ref to the Amp orb repo maps to the pinned "orb" image.
import { AMP_DEFAULT_IMAGE_REPO, type ProviderConfig } from "../core/types";

export type ImageResolution = { key: string; note?: string } | { error: string };

/** Split "repo[:tag][@digest]" into parts. A ":" before the last "/" is a registry port, not a tag. */
export function parseImageRef(ref: string): { repo: string; tag?: string; digest?: string } {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { repo: rest, tag, digest };
}

export function resolveImageKey(
  ref: string | undefined,
  config: ProviderConfig,
  images: Record<string, string>,
): ImageResolution {
  const r = ref?.trim();
  if (!r || parseImageRef(r).repo === AMP_DEFAULT_IMAGE_REPO) {
    if (!images.orb) return { error: "Failed: image key orb is not deployed — fix: run cf-orbs deploy" };
    const digest = r ? parseImageRef(r).digest : undefined;
    if (digest && digest !== config.ampImageDigest) {
      return {
        key: "orb",
        note: `ORB_IMAGE digest ${digest.slice(0, 19)}… differs from the pinned ${config.ampImageDigest.slice(0, 19)}…; using the pinned orb image (run cf-orbs upgrade to move the pin)`,
      };
    }
    return { key: "orb" };
  }
  const key = config.images[r];
  if (key && images[key]) return { key };
  return {
    error: `Failed: image ${r} is not registered — fix: add it to cf-orbs.config.jsonc "images" and run cf-orbs deploy`,
  };
}
