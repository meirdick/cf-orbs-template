// Shell scripts run inside the orb container with exec(["bash", "-c", SCRIPT], { env }).
// D9 (bootstrap), D10 (connected check), D14 (quiesce). Tested by worker/test/scripts.docker.test.ts.
//
// Rules for every script:
// - Exec env is not inherited from start(); the caller passes HOME=/home/user, USER, LANG, PATH and inputs.
// - Safe to run twice. An exec timeout only aborts the request; the script keeps running, so every wait is bounded.
// - ORB_TOKEN is never written to disk or argv. The state file keeps only ORB_TOKEN_SHA (16 hex).
// - Every log tail goes through redact (same rules as the TS redact() below).
//
// State file $HOME/.cf-orbs/bootstrap, one line: "<pid> <boot_id> <token_sha> <cli_log_offset> [<amp_id>]".
// It is on the root disk, so it survives snapshots; boot_id tells a restore apart from a retry. amp_id (size.mtime
// of the amp binary at launch) is absent in files from older code.
// Amp version record $HOME/.cf-orbs/amp-version, one line: "<amp_id> <version>". Written at a project pause, so
// it is in the project snapshot; spawn compares it with the binary after amp connects (projectSnapshotRefresh).
//
// Template literals: "\${" is a literal "${" for bash; "\\" is one backslash.

/** Redaction rules shared by the Worker (redact) and the scripts (redact shell function). Order matters. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/aop_live_[A-Za-z0-9_-]+/g, "aop_live_<redacted>"],
  [/orb_[A-Za-z0-9_-]{16,}/g, "orb_<redacted>"],
  [/Bearer [A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>"],
  [/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9._-]+/g, "<redacted-jwt>"],
  [/[A-Za-z0-9+/=]{48,}/g, "<redacted>"],
];

/**
 * Remove secrets from a log line or block. Exact values in `secrets` (for example the ORB_TOKEN of the
 * current op) go first, then the pattern rules: aop_live_ keys, orb_ tokens, Bearer values, JWTs and
 * runs of 48+ base64/hex characters (no - or _, so snapshot ids and uuids stay readable).
 */
export function redact(s: string, secrets: readonly string[] = []): string {
  let out = s;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("<redacted>");
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

// CPU pin (R7). Measured in an orb with 2 vCPU (custom 2/6/20): /proc/cpuinfo and cpu/online list 8 CPUs,
// cpuset.cpus.effective is 0-7, but sched affinity (Cpus_allowed_list) is 0-1 and nproc is 2. Amp's orb
// metrics count os.cpus() (cpuinfo), so they showed "8 cores", and self-hosted billing uses the CPUs the
// orb reports. Offlining the CPUs outside the affinity list makes cpuinfo and os.cpus() show 2.
// The microVM is new on every spawn (disk-only snapshots), so the bootstrap does this every time.
// Exported for tests. Env (tests only): CPU_SYS, CPU_STATUS, CPU_CPUSET.
export const PIN_CPUS = `
# Offline every online CPU outside this process's affinity list. Never cpu0. Never fails; prints one line.
# Skip when the cgroup cpuset equals the affinity list: then the limit is a container cpuset on a shared
# host, and offlining would change the host.
pin_cpus() {
  local sys=\${CPU_SYS:-/sys/devices/system/cpu} st=\${CPU_STATUS:-/proc/self/status}
  local cs=\${CPU_CPUSET:-/sys/fs/cgroup/cpuset.cpus.effective}
  local -a todo=()
  local k v list="" cset="" part a b i allowed=" " nallowed=0 online=0 ntodo=0 off=0 bad=0 f c s
  while IFS=$': \\t' read -r k v _; do
    if [ "$k" = Cpus_allowed_list ]; then list=$v; break; fi
  done 2>/dev/null < "$st"
  for part in \${list//,/ }; do
    case "$part" in *-*) a=\${part%-*} b=\${part#*-} ;; *) a=$part b=$part ;; esac
    case "$a$b" in ''|*[!0-9]*) list="" ; break ;; esac
    if [ "$((10#$b - 10#$a))" -gt 4096 ]; then list=""; break; fi
    for ((i = 10#$a; i <= 10#$b; i++)); do allowed="$allowed$i "; nallowed=$((nallowed + 1)); done
  done
  if [ -z "$list" ] || [ "$nallowed" -eq 0 ]; then echo "cpus: no Cpus_allowed_list; skipped"; return 0; fi
  for f in "$sys"/cpu[0-9]*; do
    c=\${f##*/cpu}
    case "$c" in ''|*[!0-9]*) continue ;; esac
    s=1
    if [ -r "$f/online" ]; then read -r s 2>/dev/null < "$f/online" || s=1; fi
    [ "$s" = 1 ] || continue
    online=$((online + 1))
    [ "$c" = 0 ] && continue
    case "$allowed" in *" $c "*) continue ;; esac
    [ -e "$f/online" ] || continue
    todo+=("$f"); ntodo=$((ntodo + 1))
  done
  if [ "$ntodo" -eq 0 ]; then echo "cpus: already $nallowed"; return 0; fi
  read -r cset 2>/dev/null < "$cs" || cset=""
  if [ "$cset" = "$list" ]; then echo "cpus: $nallowed allowed of $online online; limit is a cgroup cpuset, skipped"; return 0; fi
  # One sudo for all CPUs: each sudo costs a process start and a PAM round.
  off=$(sudo -n sh -c 'n=0; for f in "$@"; do echo 0 2>/dev/null > "$f/online" && n=$((n + 1)); done; echo "$n"' _ "\${todo[@]}" 2>/dev/null) || true
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  bad=$((ntodo - off))
  if [ "$bad" -gt 0 ]; then echo "cpus: $nallowed allowed of $online online; offlined $off; could not offline $bad (sudo?)"
  else echo "cpus: $nallowed allowed of $online online; offlined $off"; fi
  return 0
}
`;

// Memory and disk speed. The microVM kernel has transparent huge pages [never], and
// each new 4 KB page is slow, so large writes of new data are slow (512 MB: 1.33 s in the work bench). THP
// "always" cuts allocation 3-4x. A tmpfs with huge=always writes 512 MB in 0.06-0.21 s. The settings are lost
// on every spawn (new microVM), so the bootstrap sets them each time. Exported for tests.
// Env: HUGE_PAGES (1 = on), FAST_TMPFS_GB (0 = off). Tests only: THP_FILE, FAST_DIR, FAST_MOUNTS.
export const FAST_MEMORY = `
# Set transparent huge pages to always. Never fails; prints one line.
huge_pages() {
  local f=\${THP_FILE:-/sys/kernel/mm/transparent_hugepage/enabled} cur=""
  [ "\${HUGE_PAGES:-0}" = 1 ] || return 0
  read -r cur 2>/dev/null < "$f" || cur=""
  case "$cur" in *"[always]"*) echo "thp: always"; return 0 ;; esac
  if echo always | sudo -n tee "$f" >/dev/null 2>&1; then echo "thp: always"
  else echo "thp: unchanged (sudo?)"; fi
  return 0
}

# Mount a tmpfs with huge pages at /mnt/fast, FAST_TMPFS_GB GiB. Not in snapshots. Never fails; prints one line.
fast_tmpfs() {
  local n=\${FAST_TMPFS_GB:-0} dir=\${FAST_DIR:-/mnt/fast} m=\${FAST_MOUNTS:-/proc/self/mounts} dev mp
  case "$n" in ''|*[!0-9]*) return 0 ;; esac
  n=$((10#$n))
  [ "$n" -gt 0 ] || return 0
  while read -r dev mp _; do
    if [ "$mp" = "$dir" ]; then echo "tmpfs: already mounted"; return 0; fi
  done 2>/dev/null < "$m"
  # One sudo for both steps.
  if sudo -n sh -c 'mkdir -p "$1" && mount -t tmpfs -o "size=$2g,huge=always,mode=1777" tmpfs "$1"' _ "$dir" "$n" >/dev/null 2>&1; then
    echo "tmpfs: $dir $n GiB"
  else echo "tmpfs: mount failed"; fi
  return 0
}
`;

// amp version record and self-update check (projectSnapshotRefresh, docs/01 "amp binary"). amp updates itself on
// launch when a newer release exists (4-5 s, before it connects). A project snapshot keeps the old binary, so every
// thread restored from it pays that again. Uses $D, $CLI, $AMPB and $AMPV from the prelude. Exported for tests.
export const AMP_VERSION_FNS = `
# Identity of the amp binary: size and mtime. One stat. amp replaces the file when it updates itself.
amp_id() { stat -Lc '%s.%Y' "$AMPB" 2>/dev/null || echo none; }

# amp version (first word of amp --version), or nothing. Takes 0.2-0.6 s on a restored disk.
amp_ver() {
  local v
  v=$(AMP_SKIP_UPDATE_CHECK=1 timeout 10 "$AMPB" --version 2>/dev/null | head -n 1 | cut -d' ' -f1)
  case "$v" in ''|*[!0-9A-Za-z._+-]*) return 0 ;; esac
  printf '%s\\n' "$v"
}

# Write the version record: amp_save <amp_id> <version>.
amp_save() {
  [ -n "$2" ] || return 0
  mkdir -p "$D" && echo "$1 $2" > "$AMPV.tmp" && mv -f "$AMPV.tmp" "$AMPV"
}

# Record the amp version for a project snapshot. One line: "amp: version <v>" or "amp: version unknown".
amp_record() {
  local id v
  id=$(amp_id); v=$(amp_ver)
  amp_save "$id" "$v" 2>/dev/null || true
  echo "amp: version \${v:-unknown}"
}

# Did amp update itself since launch? $1 = cli.log offset at launch, $2 = amp_id at launch (may be empty).
# One line, never fails: "amp: updated <old> -> <new>" or "amp: current <version>".
# Updated = the binary changed since launch (or since the version record when $2 is empty), or cli.log after
# the offset says "Binary updated successfully" (amp flushes cli.log late, so that is the slow path).
amp_check() {
  local off=$1 base=\${2:-} now c_id="" c_ver="" v old=unknown size
  now=$(amp_id)
  if [ -f "$AMPV" ]; then read -r c_id c_ver _ < "$AMPV" || true; fi
  [ -n "$base" ] || base=$c_id
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  size=$(stat -c %s "$CLI" 2>/dev/null || echo 0)
  if [ "$off" -gt "$size" ]; then off=0; fi
  if { [ -n "$base" ] && [ "$base" != "$now" ]; } || tail -c +"$((off + 1))" "$CLI" 2>/dev/null | grep -q 'Binary updated successfully'; then
    if [ -n "$c_ver" ] && [ "$c_id" = "$base" ] && [ "$c_id" != "$now" ]; then old=$c_ver; fi
    v=$(amp_ver)
    amp_save "$now" "$v" 2>/dev/null || true
    echo "amp: updated $old -> \${v:-unknown}"
    return 0
  fi
  if [ -n "$c_ver" ] && [ "$c_id" = "$now" ]; then echo "amp: current $c_ver"; return 0; fi
  v=$(amp_ver)
  amp_save "$now" "$v" 2>/dev/null || true
  echo "amp: current \${v:-unknown}"
}
`;

/**
 * R19. Mask token shapes in the log files before a snapshot, so a paused disk (kept 30 days, shared by project
 * snapshots) holds no secret. Each match is replaced by x of the same length, so byte offsets in the file
 * (the state file keeps one for cli.log) stay valid. The file is rewritten in place (cat > keeps the inode
 * and the append mode of a running amp). Patterns: aop_live_ keys, orb_ tokens, Bearer values, JWTs.
 */
export const SCRUB_LOGS = `
scrub_logs() {
  local f t n=0
  for f in "$BLOG" "$HOME"/.cache/amp/logs/*.log; do
    [ -f "$f" ] || continue
    grep -qE 'aop_live_|orb_[A-Za-z0-9_-]{16}|Bearer |eyJ[A-Za-z0-9_-]*[.]' "$f" 2>/dev/null || continue
    t=$(mktemp) || continue
    if perl -pe 's/(aop_live_[A-Za-z0-9_-]+|orb_[A-Za-z0-9_-]{16,}|(?<=Bearer )[A-Za-z0-9._~+\\/=-]+|eyJ[A-Za-z0-9_-]*[.][A-Za-z0-9._-]+)/"x" x length($1)/ge' "$f" > "$t" && cat "$t" > "$f"; then n=$((n + 1)); fi
    rm -f "$t"
  done
  echo "scrubbed $n log file(s)"
}
`;

// Shared prelude. Defines paths, the current boot id, state parsing, the liveness check and redact.
const PRELUDE = `
set -u
umask 077
D="$HOME/.cf-orbs"
STATE="$D/bootstrap"
BLOG="$D/bootstrap.log"
CLI="$HOME/.cache/amp/logs/cli.log"
HLOG="$HOME/.cache/amp/logs/headless.log"
# The amp binary. Split so this text never holds slash-dot-amp-slash: QUIESCE_SH finds amp processes with
# pgrep -f on that pattern, and this prelude is in the command line of every script and its subshells.
AMPB="$HOME/.amp""/bin/amp"
AMPV="$D/amp-version"
BOOT=$(cat /proc/sys/kernel/random/boot_id)
S_PID="" S_BOOT="" S_SHA="" S_OFF="" S_AMP=""

# Microseconds since the epoch into the variable named $1. Bash 5 EPOCHREALTIME: no fork.
now_us() {
  local t=\${EPOCHREALTIME:-}
  t=\${t/[.,]/}
  case "$t" in ''|*[!0-9]*) t=$(( $(date +%s%N) / 1000 )) ;; esac
  printf -v "$1" '%s' "$t"
}

# Load the state file into S_*. Returns 1 if there is none.
read_state() {
  S_PID="" S_BOOT="" S_SHA="" S_OFF="" S_AMP=""
  [ -f "$STATE" ] || return 1
  read -r S_PID S_BOOT S_SHA S_OFF S_AMP _ < "$STATE" || true
  return 0
}

# True if $1 is a numeric pid > 0 that exists and is not a zombie.
alive() {
  case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*|'') return 1 ;; esac
  return 0
}

# True if $1 is alive and runs "amp orb bootstrap".
# Callers check the boot id first: a pid from another boot means nothing.
is_bootstrap() {
  alive "$1" || return 1
  case " $(ps -o args= -p "$1" 2>/dev/null) " in *" orb bootstrap "*) return 0 ;; esac
  return 1
}

# True if the state file names a live bootstrap started on this boot.
state_alive() {
  read_state && [ "$S_BOOT" = "$BOOT" ] && is_bootstrap "$S_PID"
}

${PIN_CPUS}
${FAST_MEMORY}
${SCRUB_LOGS}
${AMP_VERSION_FNS}
# Replace secrets in stdin. Same rules as redact() in scripts.ts.
redact() {
  local s
  s=$(cat)
  if [ -n "\${ORB_TOKEN:-}" ] && [ "\${#ORB_TOKEN}" -ge 4 ]; then s=\${s//"$ORB_TOKEN"/<redacted>}; fi
  printf '%s\\n' "$s" | sed -E \\
    -e 's#aop_live_[A-Za-z0-9_-]+#aop_live_<redacted>#g' \\
    -e 's#orb_[A-Za-z0-9_-]{16,}#orb_<redacted>#g' \\
    -e 's#Bearer [A-Za-z0-9._~+/=-]+#Bearer <redacted>#g' \\
    -e 's#eyJ[A-Za-z0-9_-]*[.][A-Za-z0-9._-]+#<redacted-jwt>#g' \\
    -e 's#[A-Za-z0-9+/=]{48,}#<redacted>#g' | cut -c1-400
}

# Print the last $2 lines of bootstrap.log and of cli.log written after byte offset $1, redacted.
tail_logs() {
  local off=$1 n=$2 size
  echo "== bootstrap.log"
  tail -n "$n" "$BLOG" 2>/dev/null | redact
  echo "== cli.log"
  size=$(stat -c %s "$CLI" 2>/dev/null || echo 0)
  if [ "$off" -gt "$size" ]; then off=0; fi
  tail -c +"$((off + 1))" "$CLI" 2>/dev/null | tail -n "$n" | redact
}

# True if bootstrap pid $1 has claimed Amp's pid file on this boot (Amp writes it synchronously, right
# before it connects). Builtins only (no fork), so a wait loop can run it often.
pid_file_connected() {
  local pid=\${1:-} c="" pf="$HOME/.cache/amp/pids/headless-bootstrap.pid"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -f "$pf" ] || return 1
  IFS= read -r -d '' c < "$pf" 2>/dev/null || true
  case "$c" in *"\\"pid\\":$pid,"*|*"\\"pid\\":$pid}"*) ;; *) return 1 ;; esac
  case "$c" in *"$BOOT"*) return 0 ;; esac
  return 1
}

# True if bootstrap pid $2 has claimed Amp's pid file on this boot, or cli.log has the connected marker
# after byte offset $1 (amp flushes cli.log late, so this is the slow path).
connected_since() {
  local off=$1 pid=\${2:-} size
  if pid_file_connected "$pid"; then return 0; fi
  size=$(stat -c %s "$CLI" 2>/dev/null || echo 0)
  if [ "$off" -gt "$size" ]; then off=0; fi
  tail -c +"$((off + 1))" "$CLI" 2>/dev/null | grep -q '"message":"Connected to thread actor'
}
`;

/**
 * Start `amp orb bootstrap` (D9). Env: ORB_TOKEN (required), ORB_TOKEN_SHA (16 hex; computed if absent),
 * AMP_URL (optional), ALIVE_SECONDS (default 10), HUGE_PAGES and FAST_TMPFS_GB (see FAST_MEMORY), HOME.
 * Exit 0: "bootstrap running (pid N)" or "bootstrap already running (pid N)". Exit 1: bootstrap exited early,
 * redacted log tail follows. Exit 2: bad input or lock timeout.
 */
export const BOOTSTRAP_SH = `T0=\${EPOCHREALTIME:-}
${PRELUDE}
case "\${T0/[.,]/}" in ''|*[!0-9]*) now_us T0 ;; *) T0=\${T0/[.,]/} ;; esac
if [ -z "\${ORB_TOKEN:-}" ]; then echo "Failed: ORB_TOKEN not set — fix: run spawn with a token from Amp"; exit 2; fi
SHA=\${ORB_TOKEN_SHA:-}
if [ -z "$SHA" ]; then SHA=$(printf '%s' "$ORB_TOKEN" | sha256sum | cut -c1-16); fi
case "$SHA" in *[!0-9a-f]*|'') echo "Failed: ORB_TOKEN_SHA is not hex — fix: pass the first 16 hex of sha256(ORB_TOKEN)"; exit 2 ;; esac
if [ -z "\${AMP_URL:-}" ]; then unset AMP_URL; fi
ALIVE=\${ALIVE_SECONDS:-10}
case "$ALIVE" in ''|*[!0-9]*) ALIVE=10 ;; esac
mkdir -p "$D"

# One bootstrap at a time. fd 9 is closed in the child so amp does not hold the lock.
exec 9>"$D/lock"
if ! flock -w 20 9; then echo "Failed: another bootstrap holds $D/lock — fix: retry spawn"; exit 2; fi
now_us TL

if read_state; then
  if [ "$S_BOOT" = "$BOOT" ]; then
    if is_bootstrap "$S_PID"; then
      if [ "$S_SHA" = "$SHA" ]; then echo "bootstrap already running (pid $S_PID)"; exit 0; fi
      echo "replacing bootstrap pid $S_PID (new token)"
      kill -TERM -- "-$S_PID" 2>/dev/null || kill -TERM "$S_PID" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do is_bootstrap "$S_PID" || break; sleep 0.5; done
      if is_bootstrap "$S_PID"; then kill -KILL -- "-$S_PID" 2>/dev/null || kill -KILL "$S_PID" 2>/dev/null || true; sleep 0.2; fi
    fi
  else
    # Restored from a snapshot: amp pid files name processes of another boot and block a new bootstrap.
    echo "restored disk (boot changed); removing stale amp pid files"
    rm -f "$HOME"/.cache/amp/pids/*.pid "$HOME"/.amp/http-headless*.pid 2>/dev/null || true
  fi
fi

# The deployed hostname is 64 hex chars and is not in /etc/hosts, so sudo warns and lookups can stall.
# /etc/hosts is read-only after a snapshot restore; "localhost" is already there, so use that name.
H=$(hostname)
if ! grep -qE "[[:space:]]$H([[:space:]]|$)" /etc/hosts 2>/dev/null; then
  sudo -n hostname localhost >/dev/null 2>&1 || true
fi
now_us TH

# Show only the vCPUs we get (R7). See PIN_CPUS. Never fails the bootstrap.
pin_cpus 2>/dev/null || true
now_us TC
# Faster new memory and an optional tmpfs. Never fail the bootstrap.
huge_pages 2>/dev/null || true
fast_tmpfs 2>/dev/null || true
now_us TM

# Keep the log small: trim to the last 1 MB once it passes 5 MB.
if [ "$(stat -c %s "$BLOG" 2>/dev/null || echo 0)" -gt 5000000 ]; then
  tail -c 1000000 "$BLOG" > "$BLOG.tmp" && mv -f "$BLOG.tmp" "$BLOG"
fi

OFF=$(stat -c %s "$CLI" 2>/dev/null || echo 0)
AMPID=$(amp_id)
echo "=== spawn $(date -u +%FT%TZ) boot=$BOOT sha=$SHA" >> "$BLOG"
cd "$HOME" || exit 2
# setsid -f: new session (pgid = pid) and not a background job, so SIGINT is not ignored.
# The child reports its pid through a file, then execs a login shell that execs amp (same pid).
rm -f "$D/pid.new"
setsid -f bash -c 'umask 022; echo "$$" > "$1.tmp" && mv -f "$1.tmp" "$1"; exec bash -lc "exec amp orb bootstrap"' \\
  _ "$D/pid.new" 9>&- </dev/null >>"$BLOG" 2>&1
# The child writes the file within a few ms: check every 10 ms, at most 5 s.
PID=""
for ((n = 0; n < 500; n++)); do
  if [ -s "$D/pid.new" ]; then read -r PID < "$D/pid.new"; break; fi
  sleep 0.01
done
rm -f "$D/pid.new"
case "$PID" in ''|*[!0-9]*) echo "Failed: amp orb bootstrap did not start — fix: check setsid and bash in the image"; exit 1 ;; esac
echo "$PID $BOOT $SHA $OFF $AMPID" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
now_us T1

# Wait until connected, or ALIVE seconds alive. Exit early if it dies. Amp's pid file every 20 ms
# (builtins only); liveness and the cli.log marker (they fork) every 100 ms and before "connected".
i=0
C=""
while [ "$i" -lt "$((ALIVE * 50))" ]; do
  sleep 0.02
  i=$((i + 1))
  if ! pid_file_connected "$PID" && [ "$((i % 5))" -ne 0 ]; then continue; fi
  if ! alive "$PID"; then
    echo "Failed: amp orb bootstrap exited within $(( i / 50 + 1 ))s — fix: read the log below; a rejected token needs a new spawn from Amp"
    tail_logs "$OFF" 25
    exit 1
  fi
  if connected_since "$OFF" "$PID"; then C=1; break; fi
done
now_us T2
ms() { echo $(( ($2 - $1) / 1000 )); }
echo "timing: script to launch $(ms "$T0" "$T1") ms (prelude $(ms "$T0" "$TL"), state+host $(ms "$TL" "$TH"), cpus $(ms "$TH" "$TC"), memory $(ms "$TC" "$TM"), start $(ms "$TM" "$T1")); launch to $([ -n "$C" ] && echo connected || echo "still waiting") $(ms "$T1" "$T2") ms"
echo "bootstrap running (pid $PID)"
`;

/** BOOTSTRAP_SH saw the bootstrap alive and connected (D10): its timing line. Group 1: launch → connected ms. */
export const BOOT_CONNECTED_RE = /^timing: .*; launch to connected (\d+) ms$/m;

/**
 * Wait for the connected marker (D10) in cli.log bytes written after this bootstrap's launch.
 * Env: WAIT_SECONDS (default 60), HOME, ORB_TOKEN optional (only for redaction), AMP_CHECK (1 = after connect,
 * print one amp_check line: "amp: updated <old> -> <new>" or "amp: current <version>").
 * Exit 0: "connected after Ns". Exit 1: "not connected; last log lines:", redacted tail, then "reason: …".
 */
export const WAIT_CONNECTED_SH = `${PRELUDE}
W=\${WAIT_SECONDS:-60}
case "$W" in ''|*[!0-9]*) W=60 ;; esac
fail() {
  echo "not connected; last log lines:"
  tail_logs "\${S_OFF:-0}" 25
  echo "reason: $1"
  exit 1
}
if ! read_state; then fail "no bootstrap state file"; fi
case "$S_OFF" in ''|*[!0-9]*) S_OFF=0 ;; esac
if [ "$S_BOOT" != "$BOOT" ]; then fail "bootstrap state is from another boot"; fi
start=$(date +%s)
while :; do
  if ! is_bootstrap "$S_PID"; then fail "bootstrap pid $S_PID exited"; fi
  if connected_since "$S_OFF" "$S_PID"; then
    echo "connected after $(( $(date +%s) - start ))s"
    if [ "\${AMP_CHECK:-0}" = 1 ]; then amp_check "$S_OFF" "$S_AMP" 2>/dev/null || true; fi
    exit 0
  fi
  if [ "$(( $(date +%s) - start ))" -ge "$W" ]; then fail "timeout after \${W}s"; fi
  sleep 0.1
done
`;

/**
 * Reuse the bootstrap of a warm orb (paused by Amp, container kept running). Env: ORB_TOKEN_SHA (16 hex of the
 * new spawn's token), HUGE_PAGES and FAST_TMPFS_GB (see FAST_MEMORY), HOME. The bootstrap keeps the token it
 * started with; the state file takes the new sha, so a retry of this spawn sees "already running" and does not
 * restart it.
 * Exit 0: "warm bootstrap pid N still connected". Exit 1: last line "reason: <why>" (caller starts a new one).
 */
export const RESUME_SH = `${PRELUDE}
SHA=\${ORB_TOKEN_SHA:-}
case "$SHA" in *[!0-9a-f]*|'') echo "reason: ORB_TOKEN_SHA is not hex"; exit 1 ;; esac
exec 9>"$D/lock"
if ! flock -w 5 9; then echo "reason: another bootstrap holds $D/lock"; exit 1; fi
if ! read_state; then echo "reason: no bootstrap state file"; exit 1; fi
case "$S_OFF" in ''|*[!0-9]*) S_OFF=0 ;; esac
if [ "$S_BOOT" != "$BOOT" ]; then echo "reason: bootstrap state is from another boot"; exit 1; fi
if ! is_bootstrap "$S_PID"; then echo "reason: bootstrap pid $S_PID exited"; exit 1; fi
if ! connected_since "$S_OFF" "$S_PID"; then echo "reason: bootstrap pid $S_PID is not connected"; exit 1; fi
echo "$S_PID $S_BOOT $SHA $S_OFF\${S_AMP:+ $S_AMP}" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
echo "=== resume $(date -u +%FT%TZ) warm pid=$S_PID sha=$SHA" >> "$BLOG"
# Same VM as the bootstrap, so both are usually set already: no sudo then.
huge_pages 2>/dev/null || true
fast_tmpfs 2>/dev/null || true
echo "warm bootstrap pid $S_PID still connected"
`;

/**
 * Bootstrap status, boot_id guarded. First line: "alive <pid>" | "dead" | "none".
 * Second line when a state file exists: "sha <token_sha> boot <current|other>".
 * Third line: "act <bytes>", the size of bootstrap.log + cli.log (activity marker for checkpoints).
 * Fourth line: "use <n>", the number of messages Amp's headless executor saw added to the thread
 * (headless.log). It grows when Amp uses a warm orb without a spawn; executor re-auth lines do not count.
 */
export const STATUS_SH = `${PRELUDE}
if ! read_state; then echo "none"; exit 0; fi
if [ "$S_BOOT" = "$BOOT" ] && is_bootstrap "$S_PID"; then echo "alive $S_PID"; else echo "dead"; fi
if [ "$S_BOOT" = "$BOOT" ]; then b=current; else b=other; fi
echo "sha \${S_SHA:-unknown} boot $b"
# Activity marker for opt-in checkpoints: grows while amp writes logs.
a=$(stat -c %s "$BLOG" 2>/dev/null || echo 0); c=$(stat -c %s "$CLI" 2>/dev/null || echo 0)
echo "act $((a + c))"
u=$(grep -cF '"message":"[observer] onMessageAdded"' "$HLOG" 2>/dev/null) || u=0
echo "use \${u:-0}"
`;

/**
 * Stop amp before a snapshot (D14). TERM the bootstrap group (same boot, numeric pid, cmdline check),
 * wait up to 10 s, TERM every remaining amp process of this user, wait up to 5 s, KILL leftovers, sync.
 * Never signals PID 1 or this script's own process chain. Last line: "quiesced; remaining amp processes: N".
 * Env AMP_VERSION=1 (project pause): first write the amp version record and print "amp: version <v>".
 */
export const QUIESCE_SH = `${PRELUDE}
if [ "\${AMP_VERSION:-0}" = 1 ]; then amp_record 2>/dev/null || true; fi
ME=$(id -u)
SKIP=" 1 "
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do SKIP="$SKIP$p "; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); done

# amp processes of this user: the amp binary, and anything run from ~/.amp (headless supervisor).
# "[.]amp" keeps this script's own command line from matching.
amp_pids() {
  local q
  for q in $( { pgrep -u "$ME" -x amp; pgrep -u "$ME" -f '/[.]amp/'; } 2>/dev/null | sort -un); do
    case "$SKIP" in *" $q "*) continue ;; esac
    alive "$q" && echo "$q"
  done
}

if read_state; then
  if [ "$S_BOOT" != "$BOOT" ]; then
    echo "state file is from another boot; not signalling pid $S_PID"
  elif is_bootstrap "$S_PID"; then
    echo "stopping bootstrap pid $S_PID"
    kill -TERM -- "-$S_PID" 2>/dev/null || kill -TERM "$S_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do is_bootstrap "$S_PID" || break; sleep 0.5; done
  fi
fi

left=$(amp_pids)
if [ -n "$left" ]; then
  echo "stopping amp processes: $(echo "$left" | tr '\\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $left 2>/dev/null || true
  for _ in $(seq 1 10); do [ -n "$(amp_pids)" ] || break; sleep 0.5; done
  left=$(amp_pids)
  # shellcheck disable=SC2086
  if [ -n "$left" ]; then kill -KILL $left 2>/dev/null || true; sleep 0.5; fi
fi
scrub_logs
sync
echo "quiesced; remaining amp processes: $(amp_pids | grep -c . || true)"
`;

/**
 * Redacted tail of bootstrap.log and cli.log. Env: LINES (default 50, max 1000), HOME,
 * ORB_TOKEN optional (only for redaction).
 */
export const LOGTAIL_SH = `${PRELUDE}
N=\${LINES:-50}
case "$N" in ''|*[!0-9]*) N=50 ;; esac
if [ "$N" -gt 1000 ]; then N=1000; fi
tail_logs 0 "$N"
`;

/** Mask token shapes in the logs of a warm orb (amp keeps running) before its snapshot. R19. */
export const SCRUB_SH = `${PRELUDE}
scrub_logs
sync
`;
