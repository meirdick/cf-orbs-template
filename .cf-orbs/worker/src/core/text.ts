// ?format=text replies. dispatch.sh reads them with the shell alone (no JSON parser, no awk), so one job
// starts few processes. That matters on the provider container, which has little CPU.

/** One value on one line: control characters become spaces. */
function textLine(v: unknown, redact: (s: string) => string): string {
  let t = "";
  for (const ch of String(v)) {
    const c = ch.charCodeAt(0);
    t += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return redact(t);
}

/**
 * A JSON reply body as key=value lines, each ended by "\n".
 * - Op status ({phase, progress, error?}): phase, total (all progress lines), error if any, then one
 *   progress= line for each progress line after `since`.
 * - Error ({error}): one error= line.
 * - Op reply ({opId, attached}): opId and attached.
 * Anything else gives no lines. `redact` runs on every value that can hold log text.
 */
export function replyText(body: unknown, since: number, redact: (s: string) => string): string {
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const out: string[] = [];
  if (typeof o.phase === "string") {
    const progress = Array.isArray(o.progress) ? o.progress : [];
    out.push(`phase=${textLine(o.phase, redact)}`, `total=${progress.length}`);
    if (typeof o.error === "string") out.push(`error=${textLine(o.error, redact)}`);
    for (const l of progress.slice(Math.max(0, since))) out.push(`progress=${textLine(l, redact)}`);
  } else if (typeof o.error === "string") out.push(`error=${textLine(o.error, redact)}`);
  else if (typeof o.opId === "string")
    out.push(`opId=${textLine(o.opId, (s) => s)}`, `attached=${o.attached === true}`);
  return out.map((l) => `${l}\n`).join("");
}
