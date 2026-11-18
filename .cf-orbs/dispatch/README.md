# dispatch

`dispatch.sh` is the program that `amp orb provider` runs once per job. It sends the job to the cf-orbs control plane and prints progress until the job ends. It is POSIX `sh` and needs only `curl` and `sleep` (and `date` on a system with no `/proc/uptime`). It starts few processes on purpose (2 for a job that is already done), because the provider container has little CPU. It does not need `jq` or Node.

## Use

The CF-hosted provider (`provider/`) runs it as `/app/dispatch.sh`, so you do not run it yourself.

In external mode (the provider runs on your own host), run this from your project directory:

```sh
export AMP_ORB_PROVIDER_TOKEN=aop_live_...
export CF_ORBS_URL=https://cf-orbs.<you>.workers.dev
export CF_ORBS_CONTROL_TOKEN_FILE=$PWD/.cf-orbs/control-token
amp orb provider .cf-orbs/dispatch/dispatch.sh
```

`cf-orbs init --provider external` prints these lines with your values. For a service, see [provider/README.md](../provider/README.md).

## Environment

| Variable | Set by | Use |
| --- | --- | --- |
| `ORB_OPERATION` | Amp | `spawn`, `pause` or `delete`. Other values fail with exit 2. |
| `ORB_ID` | Amp | Must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. Else exit 2. |
| `ORB_SNAPSHOT_ID` | Amp | Sent as `snapshotId` when set. |
| `ORB_IMAGE`, `ORB_TOKEN`, `AMP_URL` | Amp | Sent as `image`, `token`, `ampUrl` on spawn only, when set. |
| `CF_ORBS_URL` | cf-orbs | Control plane base URL. Default `http://control.internal` (CF-hosted provider). Must be `https://`, except for the hosts `control.internal`, `localhost` and `127.0.0.1`. Characters allowed: `A-Za-z0-9._:/~%-`. Else exit 2. |
| `CF_ORBS_CONTROL_TOKEN` | you | Bearer for the public `/v1` API (external mode): the contents of `.cf-orbs/control-token`. Characters allowed: `A-Za-z0-9._~+/=-`. |
| `CF_ORBS_CONTROL_TOKEN_FILE` | you | File with the bearer (first line). Used when `CF_ORBS_CONTROL_TOKEN` is unset. |
| `CF_ORBS_DEADLINE_SECONDS` | tests | Give up after this many seconds, 1-3600. Default 270 (Amp's job limit is 300). |

When the URL host is `control.internal`, no bearer is sent: the Worker intercepts that host inside the provider container and routes it to the `ControlApi` entrypoint, which needs no auth. Any other host needs the bearer, and without one the script exits 2.

## Protocol

1. `POST $CF_ORBS_URL/v1/orbs/$ORB_ID/ops?format=text` with body `{op, snapshotId?, image?, token?, ampUrl?}`. Reply (2xx): `{opId, attached}`. `attached: true` means an identical op was already running; the script prints `attaching to running <op> <opId>`.
2. `GET $CF_ORBS_URL/v1/ops/$opId?wait=20&since=<lines printed so far>&format=text` until the deadline. The server answers when the op ends, when `progress` has more than `since` lines, or when the wait passes (capped at 25 s). Reply (200): an op record with top-level `phase` (`queued|running|succeeded|failed`), `progress` (the whole array of strings, append-only, capped at about 200 lines) and `error` (string, when failed). The script prints each progress line once. A 404 means the op is unknown; the script fails with "retry the message".
3. `succeeded` → exit 0. `failed` → `Failed: <error>`, exit 1. Deadline → `Failed: control plane did not finish <op> within 270 s — fix: cf-orbs logs <orbId>`, exit 1.

With `?format=text` the Worker sends the same replies as `key=value` lines, which the script reads with shell builtins: `opId=` and `attached=` for the POST; `phase=`, `total=`, `error=` and one `progress=` line for each line after `since` for the GET; `error=` for an error. Without `format=text` the replies are JSON (used by scripts from before 0.2.5). The new script needs a Worker from 0.2.5 or later.

Error replies (4xx/5xx) may carry `{"error": "<one line>"}`; the script prints it. Curl errors, 408, 429 and 5xx are retried: 3 attempts, 2 s apart.

## Output

- First line: `cf-orbs: <op> <orbId>`.
- Then `started <op> <opId>`, or `attaching to running <op> <opId>`.
- Then one line per progress line from the server.
- On a retried request: `control plane: <cause>, retry <n> of 2`.
- On success, a last line `cf-orbs: <op> <orbId> done in <n> s`.

Amp shows these lines in the thread setup log.
- On failure, one final line `Failed: <cause> — fix: <command>` on stdout and on stderr.
- Exit codes: 0 ok, 1 failure, 2 bad input.

## Secrets

- No secret is in argv. `curl` reads its URL, auth header and body as a config file on stdin (`curl -q -K -`).
- Every printed line is redacted: the exact `ORB_TOKEN` and control token values, `aop_live_*`, long `orb_*` tokens, JWT-shaped strings and `Bearer <value>`.
- The script never prints its environment.

## Tests

```sh
npx vitest run dispatch                      # contract tests against a node:http mock (dispatch/test/mock-server.ts)
DISPATCH_SHELL=dash npx vitest run dispatch  # same tests under another shell
npx shellcheck@latest -s sh dispatch/dispatch.sh
```

To test in the provider base image (dash, mawk, curl 7.88):

```sh
docker run --rm -v "$PWD":/repo -w /repo node:24-bookworm-slim sh -c \
  'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && npx vitest run dispatch'
```
