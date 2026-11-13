#!/usr/bin/env bash
# cf-orbs provider entry. Runs `amp orb provider <dispatch>` in a loop.
# Output is redacted, then written to stdout and to the log file. The log is capped.
# Env:
#   AMP_ORB_PROVIDER_TOKEN  required. Read by amp; never printed.
#   CF_ORBS_URL             control plane URL for dispatch.sh (default http://control.internal)
# Test and tuning knobs (defaults are for the container):
#   CF_ORBS_PROVIDER_LOG    log file (default /var/log/cf-orbs-provider.log)
#   CF_ORBS_LOG_MAX_BYTES   cap (default 5 MB); on overflow keep the last fifth
#   CF_ORBS_AMP_BIN         amp binary (default amp)
#   CF_ORBS_DISPATCH        dispatch program (default /app/dispatch.sh)
#   CF_ORBS_ONCE=1          run amp once and exit with its code
#   CF_ORBS_REDACT_ONLY=1   redact stdin to stdout and exit
set -uo pipefail

LOG=${CF_ORBS_PROVIDER_LOG:-/var/log/cf-orbs-provider.log}
MAX_BYTES=${CF_ORBS_LOG_MAX_BYTES:-5242880}
AMP_BIN=${CF_ORBS_AMP_BIN:-amp}
DISPATCH=${CF_ORBS_DISPATCH:-/app/dispatch.sh}
export CF_ORBS_URL=${CF_ORBS_URL:-http://control.internal}

# Escape a literal for a sed -E pattern.
sed_literal() { printf '%s' "$1" | sed -e 's/[][\/.^$*+?(){}|]/\\&/g'; }

TOKEN_EXPR=()
tok=${AMP_ORB_PROVIDER_TOKEN:-}
if [ "${#tok}" -ge 8 ]; then
  TOKEN_EXPR=(-e "s/$(sed_literal "$tok")/[redacted]/g")
fi

# One redaction for every line: the exact token, aop_live_*, orb_*, JWTs, long base64/hex runs.
redact() {
  sed -u -E "${TOKEN_EXPR[@]}" \
    -e 's/aop_live_[A-Za-z0-9_-]+/aop_live_[redacted]/g' \
    -e 's/orb_[A-Za-z0-9_-]{16,}/orb_[redacted]/g' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[redacted-jwt]/g' \
    -e 's/[A-Za-z0-9+=_]{40,}/[redacted]/g'
}

if [ "${CF_ORBS_REDACT_ONLY:-0}" = 1 ]; then
  redact
  exit 0
fi

ts() { date -u +%FT%TZ; }
say() { printf '%s cf-orbs-provider: %s\n' "$(ts)" "$1" | redact | tee -a "$LOG"; }

# Keep the last fifth of the log when it passes the cap. Truncate in place so open
# O_APPEND writers keep working.
cap_log() {
  local size
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_BYTES" ]; then
    local tmp="$LOG.cap"
    tail -c $((MAX_BYTES / 5)) "$LOG" >"$tmp" && cat "$tmp" >"$LOG"
    rm -f "$tmp"
    printf '%s cf-orbs-provider: log passed %s bytes; kept the last %s\n' "$(ts)" "$MAX_BYTES" $((MAX_BYTES / 5)) >>"$LOG"
  fi
}

mkdir -p "$(dirname "$LOG")"
touch "$LOG"

if [ -z "${AMP_ORB_PROVIDER_TOKEN:-}" ]; then
  say "Failed: AMP_ORB_PROVIDER_TOKEN is not set — fix: run cf-orbs init with AMP_ORB_PROVIDER_TOKEN set (it puts the secret and restarts the provider)"
  exit 1
fi
case "$AMP_ORB_PROVIDER_TOKEN" in
  aop_live_*) ;;
  *) say "warning: AMP_ORB_PROVIDER_TOKEN does not start with aop_live_; Amp will likely reject it" ;;
esac
if [ ! -x "$DISPATCH" ]; then
  say "Failed: dispatch program $DISPATCH is missing or not executable — fix: rebuild the provider image with cf-orbs deploy"
  exit 1
fi

child=0
watcher=0
stop() {
  say "stopping (signal)"
  [ "$child" -gt 0 ] && kill -TERM "$child" 2>/dev/null && wait "$child" 2>/dev/null
  [ "$watcher" -gt 0 ] && kill "$watcher" 2>/dev/null
  exit 0
}
trap stop TERM INT

if [ "${CF_ORBS_ONCE:-0}" != 1 ]; then
  (while sleep 60; do cap_log; done) &
  watcher=$!
fi

say "starting; amp $("$AMP_BIN" --version 2>/dev/null | head -n1 | redact); dispatch $DISPATCH; control $CF_ORBS_URL"

delay=5
while :; do
  cap_log
  t0=$(date +%s)
  "$AMP_BIN" orb provider "$DISPATCH" > >(redact | tee -a "$LOG") 2>&1 &
  child=$!
  wait "$child"
  rc=$?
  child=0
  # Let the redact/tee process substitution flush before the next line.
  sleep 0.2
  ran=$(($(date +%s) - t0))
  if [ "${CF_ORBS_ONCE:-0}" = 1 ]; then
    say "amp orb provider exited with code $rc after ${ran}s"
    exit "$rc"
  fi
  # Back off on fast failures (bad token, no network): 5 s doubling to 5 min.
  if [ "$ran" -ge 60 ]; then delay=5; fi
  say "amp orb provider exited with code $rc after ${ran}s; restarting in ${delay}s"
  sleep "$delay" &
  wait $! 2>/dev/null
  if [ "$ran" -lt 60 ]; then delay=$((delay * 2 > 300 ? 300 : delay * 2)); fi
done
