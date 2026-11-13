#!/usr/bin/env node
// Runs as npm's postinstall in the template repo: Workers Builds installs dependencies before
// every deploy, so this runs right before each `wrangler deploy`. It warns when the container
// application names that deploy will use — `<name>-orbsession` and `<name>-providerhost`, from
// "name" in .cf-orbs/wrangler.jsonc — already exist in the Cloudflare account:
//
//   - an update of the Worker that owns them deploys fine;
//   - a second, separate install (a different project name) fails at the last step with
//     "Container application settings were not fully applied" (workers-sdk#15827), and no retry
//     can fix it — the names are taken.
//
// Best effort by design: without an API token in the environment (a local clone, or a build
// token that cannot read the Containers API) it stays silent, and any error exits 0 so the
// check can never break an install.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const DOCS =
  "https://github.com/meirdick/cf-orbs/blob/main/docs/install-button.md#why-the-worker-is-named-after-the-repo";

/** The config's top-level `name`: the first `"name":` key in the (JSONC) file. */
export function parseWorkerName(text) {
  return /^\s*"name"\s*:\s*"([^"]+)"/m.exec(text)?.[1];
}

/**
 * The warning the install step prints when the account already has container applications for
 * `name`. Named so a later deploy failure is recognizable as the thing it warned about.
 */
export function formatWarning(name, conflicts) {
  return [
    "⚠️  cf-orbs name check — printed by the install step; read it before the deploy step.",
    "",
    `Container applications using the name "${name}" already exist in this Cloudflare account:`,
    ...conflicts.map((c) => `    ${c.app}${c.worker ? `, owned by the Worker "${c.worker}"` : ""}`),
    "",
    "This deploy reuses those names, so what happens next depends on what this build is:",
    "    - Updating that same Worker (you pushed changes to its repo): the deploy SUCCEEDS.",
    "      Ignore this warning.",
    "    - A second, separate install with a different project name: the deploy FAILS at the last",
    '      step with "Container application settings were not fully applied" — the same message a',
    "      failed build shows — and no retry can fix it: the name is taken.",
    "",
    'Second install? Change "name" in .cf-orbs/wrangler.jsonc to a name nothing else in this',
    'account uses (the GitHub web editor, no CLI) and set the same "name" in cf-orbs.config.jsonc,',
    "so a later `cf-orbs init` regeneration keeps it. Commit, and build again.",
    `Why: ${DOCS}`,
  ].join("\n");
}

/** GET one page of a list endpoint, already unwrapped; throws on HTTP or API errors. */
async function page(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.success !== true || !Array.isArray(body.result)) throw new Error("unexpected API shape");
  return body;
}

/** Every entry of a list endpoint, following result_info pagination. */
async function collect(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  const first = await page(`${path}${sep}per_page=100`, token);
  const out = [...first.result];
  const pages = Number(first.result_info?.total_pages ?? 1);
  for (let p = 2; p <= pages; p++) out.push(...(await page(`${path}${sep}page=${p}`, token)).result);
  return out;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!token) return; // local npm install: no build token, nothing to check
  const config = await readFile(".cf-orbs/wrangler.jsonc", "utf8"); // cwd is the repo root
  const name = parseWorkerName(config);
  if (!name) return;
  const accounts = await collect("/accounts", token);
  for (const account of accounts) {
    // A build token scoped to the account's containers: a 403 here means "cannot check", not "clear".
    const apps = await collect(`/accounts/${account.id}/containers/applications`, token).catch(() => []);
    const wanted = new Set([`${name}-orbsession`, `${name}-providerhost`]);
    const hits = apps.filter((a) => wanted.has(a.name));
    if (hits.length === 0) continue;
    const namespaces = await collect(
      `/accounts/${account.id}/workers/durable_objects/namespaces`,
      token,
    ).catch(() => []);
    const workerOf = new Map(namespaces.map((n) => [n.id, n.script]));
    const conflicts = hits
      .map((a) => ({ app: a.name, worker: workerOf.get(a.durable_objects?.namespace_id) }))
      .filter((c) => c.app);
    if (conflicts.length > 0) process.stdout.write(`\n${formatWarning(name, conflicts)}\n`);
  }
}

let invoked = false;
try {
  invoked = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
} catch {}
if (invoked) {
  try {
    await main();
  } catch {
    // best effort by design: a failed check must never break npm install
  }
}
