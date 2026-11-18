#!/usr/bin/env node
// Lets this repo deploy under any project name.
//
// Workers Builds passes the project name picked on the setup page to the build as
// WRANGLER_CI_OVERRIDE_NAME. wrangler deploys the Worker under that name, but it names the
// container applications from "name" in the config file (workers-sdk#15827). This script writes
// the project name into .cf-orbs/wrangler.jsonc in the build's checkout, so the Worker and its
// container applications share one name and two installs in one account cannot collide.
//
// Nothing is committed. Outside Workers Builds the variable is unset and this does nothing.
// package.json runs it from postinstall, build and deploy, so it runs in whichever build step
// sees the variable; a second run finds the name already set. It never fails a build.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONFIG = ".cf-orbs/wrangler.jsonc"; // npm runs scripts in the repo root
const NAME_LINE = /^(\s*"name"\s*:\s*)"([^"]*)"/m; // the config's top-level name is its first key
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The config text with its top-level name set to `name`, or undefined when there is nothing to change. */
export function withName(text, name) {
  const found = NAME_LINE.exec(text);
  if (!found || found[2] === name || !WORKER_NAME.test(name)) return undefined;
  return text.replace(NAME_LINE, `$1${JSON.stringify(name)}`);
}

async function main() {
  const name = process.env.WRANGLER_CI_OVERRIDE_NAME;
  if (!name) return;
  const next = withName(await readFile(CONFIG, "utf8"), name);
  if (next === undefined) return;
  await writeFile(CONFIG, next);
  const step = process.env.npm_lifecycle_event ?? "direct run";
  process.stdout.write(`cf-orbs: this build deploys as "${name}", the project name (set in ${CONFIG} by ${step})\n`);
}

let invoked = false;
try {
  invoked = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
} catch {}
if (invoked) await main().catch(() => {});
