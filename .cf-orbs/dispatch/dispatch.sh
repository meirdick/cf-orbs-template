#!/bin/sh
# cf-orbs dispatch program. `amp orb provider` runs it once per job.
#
# Input (env, from Amp): ORB_OPERATION ORB_ID ORB_IMAGE ORB_SNAPSHOT_ID ORB_TOKEN AMP_URL
# Input (env, from cf-orbs):
#   CF_ORBS_URL                 control plane base URL (default http://control.internal)
#   CF_ORBS_CONTROL_TOKEN       bearer for the public /v1 API (external mode only)
#   CF_ORBS_CONTROL_TOKEN_FILE  file that holds the bearer (used when CF_ORBS_CONTROL_TOKEN is unset)
#   CF_ORBS_DEADLINE_SECONDS    give up after this many seconds (default 270)
# Flow: POST /v1/orbs/<orb>/ops, then long-poll GET /v1/ops/<opId>?wait=20 and print new progress lines.
# Exit: 0 ok, 1 failure, 2 bad input.
#
# Few processes on purpose. The provider container has little CPU, and each process start costs CPU.
# Text work (JSON body, reply parsing, redaction) is done with shell builtins; the Worker answers
# ?format=text as key=value lines. The clock is /proc/uptime (date where that file does not exist). A job
# that is already done starts 2 processes: curl for the POST and curl for one GET.
# Needs only sh, curl, sleep (and date on a host with no /proc/uptime). No secret goes on a command line: curl reads its config (URL, auth
# header, body) from stdin. The Worker redacts progress and error lines; this script also removes the
# exact ORB_TOKEN and control token from every line it prints.
set -u
umask 077
LC_ALL=C
export LC_ALL

NL='
'
CR=$(printf '\r')
TAB=$(printf '\t')

# --- text helpers (shell builtins only) -----------------------------------------------------

# rep <string> <from> <to>: replace every <from>. Result in R.
rep() {
  R=
  _rs=$1
  while :; do
    case $_rs in
      *"$2"*)
        R=$R${_rs%%"$2"*}$3
        _rs=${_rs#*"$2"}
        ;;
      *)
        R=$R$_rs
        return 0
        ;;
    esac
  done
}

# jesc <string>: JSON string content (no quotes around it). Result in Q. Any byte string round-trips.
jesc() {
  case $1 in
    *[\\\"]* | *[[:cntrl:]]*) ;;
    *)
      Q=$1
      return 0
      ;;
  esac
  Q=
  _js=$1
  while [ -n "$_js" ]; do
    _jr=${_js#?}
    _jc=${_js%"$_jr"}
    _js=$_jr
    case $_jc in
      \\) Q=$Q\\\\ ;;
      \") Q=$Q\\\" ;;
      "$NL") Q=$Q\\n ;;
      "$CR") Q=$Q\\r ;;
      "$TAB") Q=$Q\\t ;;
      [[:cntrl:]]) Q=$Q$(printf '\\u%04x' "'$_jc") ;;
      *) Q=$Q$_jc ;;
    esac
  done
}

# clean <string>: printable, bounded form of an untrusted value for messages. Result in C.
clean() {
  C=
  _cs=$1
  _cn=0
  while [ -n "$_cs" ] && [ "$_cn" -lt 64 ]; do
    _cr=${_cs#?}
    _cc=${_cs%"$_cr"}
    _cs=$_cr
    _cn=$((_cn + 1))
    case $_cc in
      [A-Za-z0-9._:/-]) C=$C$_cc ;;
      *) C="$C?" ;;
    esac
  done
}

# --- output helpers -------------------------------------------------------------------------

CTL_TOKEN=
ORB_SECRET=${ORB_TOKEN:-}

# redact_line <line>: remove the exact secrets this script holds. Result in L.
redact_line() {
  L=$1
  if [ "${#ORB_SECRET}" -ge 4 ]; then
    case $L in *"$ORB_SECRET"*)
      rep "$L" "$ORB_SECRET" "[redacted]"
      L=$R
      ;;
    esac
  fi
  if [ "${#CTL_TOKEN}" -ge 4 ]; then
    case $L in *"$CTL_TOKEN"*)
      rep "$L" "$CTL_TOKEN" "[redacted]"
      L=$R
      ;;
    esac
  fi
}

say() {
  redact_line "$*"
  printf '%s\n' "$L"
}

# fail <message> [exit code]. One final line on stdout and stderr. Worker errors already start
# with "Failed: "; drop it so the line has one prefix.
fail() {
  msg=$1
  while :; do
    case $msg in "Failed: "*) msg=${msg#"Failed: "} ;; *) break ;; esac
  done
  redact_line "Failed: $msg"
  printf '%s\n' "$L"
  printf '%s\n' "$L" >&2
  exit "${2:-1}"
}

# Seconds on a clock that only goes forward, in NOW. /proc/uptime is read with a builtin (no process);
# other systems use date.
tick() {
  if [ -r /proc/uptime ] && IFS=' .' read -r NOW _ </proc/uptime; then
    case $NOW in "" | *[!0-9]*) NOW=$(date +%s) ;; esac
  else
    NOW=$(date +%s)
  fi
}

# --- input checks ---------------------------------------------------------------------------

OP=${ORB_OPERATION:-}
ORB=${ORB_ID:-}
clean "$OP"
C_OP=$C
clean "$ORB"
C_ORB=$C
say "cf-orbs: $C_OP $C_ORB"

case $OP in
  spawn | pause | delete) ;;
  *) fail "unknown ORB_OPERATION '$C_OP' — fix: update cf-orbs (npx cf-orbs@latest deploy)" 2 ;;
esac

# Same rule as the server: ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$
orb_ok=1
case $ORB in
  "" | [!A-Za-z0-9]* | *[!A-Za-z0-9_-]*) orb_ok=0 ;;
esac
[ "${#ORB}" -le 128 ] || orb_ok=0
[ "$orb_ok" = 1 ] || fail "invalid orb id '$C_ORB' — fix: check ORB_ID from Amp" 2

BASE=${CF_ORBS_URL:-http://control.internal}
while :; do
  case $BASE in */) BASE=${BASE%/} ;; *) break ;; esac
done
clean "$BASE"
C_BASE=$C
case $BASE in
  http://?* | https://?*) ;;
  *) fail "CF_ORBS_URL '$C_BASE' is not an http(s) URL — fix: set CF_ORBS_URL to the Worker URL" 2 ;;
esac
case $BASE in
  *[!A-Za-z0-9._:/~%-]*) fail "CF_ORBS_URL has characters outside [A-Za-z0-9._:/~%-] — fix: set CF_ORBS_URL to the Worker URL" 2 ;;
esac
host=${BASE#*://}
host=${host%%/*}
host=${host%%:*}

# The body carries ORB_TOKEN and the header the control token: plain http only on the internal
# hostname or this machine.
case $BASE in
  http://*)
    case $host in
      control.internal | localhost | 127.0.0.1) ;;
      *)
        clean "$host"
        fail "CF_ORBS_URL must use https for $C — fix: set CF_ORBS_URL to https://<your Worker host>" 2
        ;;
    esac
    ;;
esac

if [ "$host" != control.internal ]; then
  CTL_TOKEN=${CF_ORBS_CONTROL_TOKEN:-}
  if [ -z "$CTL_TOKEN" ] && [ -n "${CF_ORBS_CONTROL_TOKEN_FILE:-}" ]; then
    [ -r "$CF_ORBS_CONTROL_TOKEN_FILE" ] ||
      fail "cannot read CF_ORBS_CONTROL_TOKEN_FILE — fix: check the file path and its permissions" 2
    IFS= read -r CTL_TOKEN <"$CF_ORBS_CONTROL_TOKEN_FILE" || [ -n "$CTL_TOKEN" ]
    CTL_TOKEN=${CTL_TOKEN%"$CR"}
  fi
  [ -n "$CTL_TOKEN" ] ||
    fail "no control token for $host — fix: set CF_ORBS_CONTROL_TOKEN or CF_ORBS_CONTROL_TOKEN_FILE to the Worker CONTROL_TOKEN" 2
  case $CTL_TOKEN in
    *[!A-Za-z0-9._~+/=-]*) fail "control token has characters outside [A-Za-z0-9._~+/=-] — fix: set a new CONTROL_TOKEN with cf-orbs deploy" 2 ;;
  esac
fi

LIMIT=${CF_ORBS_DEADLINE_SECONDS:-270}
case $LIMIT in
  "" | *[!0-9]*)
    clean "$LIMIT"
    fail "CF_ORBS_DEADLINE_SECONDS '$C' is not a number — fix: unset it (default 270)" 2
    ;;
esac
if [ "$LIMIT" -lt 1 ] || [ "$LIMIT" -gt 3600 ]; then
  fail "CF_ORBS_DEADLINE_SECONDS must be 1..3600 — fix: unset it (default 270)" 2
fi
tick
START=$NOW
DEADLINE=$((START + LIMIT))

# --- HTTP -----------------------------------------------------------------------------------

# curl config on stdin: URL, auth header and body never appear in argv.
curl_config() {
  printf 'url = "%s"\n' "$1"
  if [ -n "$CTL_TOKEN" ]; then printf 'header = "Authorization: Bearer %s"\n' "$CTL_TOKEN"; fi
  if [ -n "$2" ]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data-binary = "%s"\n' "$2"
  fi
}

curl_cause() {
  case $1 in
    6) CAUSE="cannot resolve host" ;;
    7) CAUSE="connection refused" ;;
    28) CAUSE="timed out" ;;
    35 | 51 | 58 | 60) CAUSE="TLS error" ;;
    52) CAUSE="empty reply" ;;
    55 | 56) CAUSE="connection reset" ;;
    *) CAUSE="curl exit $1" ;;
  esac
}

# request <url> <config-escaped body or empty> <max seconds>
# Sets CODE, RESP and TOOK (ms the request took, from curl). Retries curl errors, 408, 429 and 5xx:
# 3 attempts, 2 s apart, within the deadline. Returns 1 when no HTTP response came back (CAUSE says why).
request() {
  attempt=1
  while :; do
    out=$(curl_config "$1" "$2" | curl -q -sS -g -K - -m "$3" -w '\n%{http_code} %{time_total}' 2>/dev/null)
    rc=$?
    last=${out##*"$NL"}
    RESP=${out%"$NL"*}
    [ "$out" = "$last" ] && RESP=
    CODE=${last%% *}
    # time_total is seconds with 6 decimals ("0.123456"). Read it as ms without leading-zero octal.
    took=${last#* }
    sec=${took%%[.,]*}
    frac=${took#*[.,]}000
    frac=${frac%"${frac#???}"}
    case $sec$frac in "" | *[!0-9]*) TOOK=0 ;; *) TOOK=$((sec * 1000 + 1$frac - 1000)) ;; esac
    if [ "$rc" -eq 0 ]; then
      case $CODE in
        408 | 429 | 5??) CAUSE="HTTP $CODE" ;;
        *) return 0 ;;
      esac
    else
      curl_cause "$rc"
      CODE=000
    fi
    tick
    if [ "$attempt" -ge 3 ] || [ $((NOW + 2)) -ge "$DEADLINE" ]; then
      [ "$CODE" = 000 ] && return 1
      return 0
    fi
    say "control plane: $CAUSE, retry $attempt of 2"
    attempt=$((attempt + 1))
    sleep 2
  done
}

# read_reply [print]: read the key=value lines in RESP into P_PHASE, P_ERROR, P_OPID, P_ATTACHED.
# With "print", print each progress= line and count them in P_NEW.
read_reply() {
  P_PHASE=
  P_ERROR=
  P_OPID=
  P_ATTACHED=
  P_NEW=0
  while IFS= read -r _l || [ -n "$_l" ]; do
    _l=${_l%"$CR"}
    case $_l in
      phase=*) P_PHASE=${_l#phase=} ;;
      error=*) P_ERROR=${_l#error=} ;;
      opId=*) P_OPID=${_l#opId=} ;;
      attached=*) P_ATTACHED=${_l#attached=} ;;
      progress=*)
        if [ "${1:-}" = print ]; then
          redact_line "${_l#progress=}"
          printf '%s\n' "$L"
          P_NEW=$((P_NEW + 1))
        fi
        ;;
    esac
  done <<EOF
$RESP
EOF
}

# Message for a non-2xx answer. Uses the server error text when present.
http_error() {
  read_reply
  err=$P_ERROR
  case $CODE in
    401 | 403) fail "control plane rejected the control token (HTTP $CODE) — fix: set CF_ORBS_CONTROL_TOKEN to the Worker CONTROL_TOKEN" ;;
  esac
  if [ -n "$err" ]; then
    case $err in
      *"fix:"*) fail "$err" ;;
      *) fail "$err (HTTP $CODE) — fix: $1" ;;
    esac
  fi
  case $CODE in
    404) fail "control plane answered 404 for $2 — fix: check CF_ORBS_URL; in external mode set CONTROL_TOKEN on the Worker" ;;
  esac
  fail "control plane answered HTTP $CODE for $2 — fix: $1"
}

# --- post the op ----------------------------------------------------------------------------

# The op request body (OpRequest in worker/src/core/types.ts). Empty values are omitted.
jesc "$OP"
BODY="{\"op\":\"$Q\""
add() {
  [ -n "$2" ] || return 0
  jesc "$2"
  BODY="$BODY,\"$1\":\"$Q\""
}
add snapshotId "${ORB_SNAPSHOT_ID:-}"
if [ "$OP" = spawn ]; then
  add image "${ORB_IMAGE:-}"
  add token "${ORB_TOKEN:-}"
  add ampUrl "${AMP_URL:-}"
fi
BODY="$BODY}"
# Escape for a quoted curl config value.
rep "$BODY" "\\" "\\\\"
rep "$R" '"' '\"'
BODY_CFG=$R

request "$BASE/v1/orbs/$ORB/ops?format=text" "$BODY_CFG" 30 ||
  fail "control plane unreachable at $BASE ($CAUSE, 3 attempts) — fix: run cf-orbs status; check the Worker is deployed"
case $CODE in
  2??) ;;
  *) http_error "cf-orbs logs $ORB" "POST /v1/orbs/$ORB/ops" ;;
esac

read_reply
OPID=$P_OPID
case $OPID in
  "") fail "control plane sent an unreadable reply to POST ops — fix: run cf-orbs deploy so the Worker and dispatch.sh match; check cf-orbs logs $ORB" ;;
  *[!A-Za-z0-9._:-]*) fail "control plane sent no valid opId — fix: update cf-orbs; check cf-orbs logs $ORB" ;;
esac
if [ "$P_ATTACHED" = true ]; then
  say "attaching to running $OP $OPID"
else
  say "started $OP $OPID"
fi

# --- long-poll ------------------------------------------------------------------------------

PRINTED=0
while :; do
  tick
  left=$((DEADLINE - NOW))
  [ "$left" -gt 0 ] || fail "control plane did not finish $OP within $LIMIT s — fix: cf-orbs logs $ORB"
  pollwait=20
  [ "$left" -le 20 ] && pollwait=$((left - 1))
  maxt=$((pollwait + 10))
  [ "$maxt" -gt "$left" ] && maxt=$left
  [ "$maxt" -lt 2 ] && maxt=2

  request "$BASE/v1/ops/$OPID?wait=$pollwait&since=$PRINTED&format=text" "" "$maxt" ||
    fail "control plane unreachable at $BASE while waiting for $OP ($CAUSE) — fix: cf-orbs logs $ORB"
  case $CODE in
    200) ;;
    404) fail "op $OPID is unknown to the control plane — fix: retry the message; cf-orbs logs $ORB" ;;
    *) http_error "cf-orbs logs $ORB" "GET /v1/ops/$OPID" ;;
  esac

  read_reply print
  PRINTED=$((PRINTED + P_NEW))

  case $P_PHASE in
    succeeded)
      tick
      say "cf-orbs: $OP $ORB done in $((NOW - START)) s"
      exit 0
      ;;
    failed)
      err=$P_ERROR
      [ -n "$err" ] || err="$OP failed"
      case $err in
        *"fix:"*) fail "$err" ;;
        *) fail "$err — fix: cf-orbs logs $ORB" ;;
      esac
      ;;
    queued | running) ;;
    "") fail "control plane sent an unreadable op status — fix: run cf-orbs deploy so the Worker and dispatch.sh match; check cf-orbs logs $ORB" ;;
    *)
      clean "$P_PHASE"
      fail "control plane sent unknown op phase '$C' — fix: update cf-orbs"
      ;;
  esac

  # A server that answers at once (no long-poll) must not make this a busy loop. A reply with new lines
  # is a long-poll wake-up: poll again at once, or the end of the op can wait up to 1 s here.
  [ "$P_NEW" -gt 0 ] || [ "$TOOK" -ge 1000 ] || sleep 1
done
