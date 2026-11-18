# Provider host

The provider is the process that takes orb jobs from Amp.

`amp orb provider` pulls orb jobs from Amp and runs `dispatch.sh` once per job, and `dispatch.sh` sends the job to the cf-orbs control plane. You run one provider per provider token, in one of two places:

| | Cloudflare-hosted (default) | External host |
| --- | --- | --- |
| Where `amp orb provider` runs | `ProviderHost` container (`lite`) in your Worker | A machine you run (VM, server, laptop) |
| Where the Amp token lives | Worker secret `AMP_ORB_PROVIDER_TOKEN`; passed only to the provider container env | An env file on your host. Never in Cloudflare |
| How dispatch reaches the control plane | `http://control.internal`, routed inside Cloudflare to the `ControlApi` entrypoint. The public `/v1` API is also on, with bearer `CONTROL_TOKEN` (the CLI uses it) | `https://<worker>.workers.dev/v1` with bearer `CONTROL_TOKEN` |
| Restart on failure | Entry loop (5 s, backing off to 5 min) + DO alarm every 5 min + cron | systemd `Restart=always` |
| Config | `"providerHost": "cloudflare"` + Worker secret `AMP_ORB_PROVIDER_TOKEN` | `"providerHost": "external"`; no `AMP_ORB_PROVIDER_TOKEN` secret |

## Cloudflare-hosted mode

`cf-orbs init` sets this up. Here is what runs:

- Image: `provider/Dockerfile` (`node:24-bookworm-slim` by digest, `@ampcode/cli` pinned by `ARG AMP_CLI_VERSION=0.0.1793390435-g08e9ec`, `curl`, `tini`, `/app/dispatch.sh`, `/app/entry.sh`). Wrangler builds it as the named image `provider`. In an installed project, `cf-orbs deploy` copies `provider/` and `dispatch/` into `.cf-orbs/` and generates this entry in `.cf-orbs/wrangler.jsonc` (build context `.cf-orbs/`, which mirrors the repo root):

  ```jsonc
  { "class_name": "ProviderHost", "scheduling_policy": "durable_object",
    "images": { "provider": { "dockerfile": "provider/Dockerfile", "build_context": "." } } }
  ```

  In this repo, `worker/wrangler.jsonc` uses `"../provider/Dockerfile"` with build context `".."`.

- `ProviderHost` DO (single name `provider`) starts the container with `instance: "lite"`, `enableInternet: true` and env `AMP_ORB_PROVIDER_TOKEN`, `CF_ORBS_URL=http://control.internal`. It routes `control.internal` to `ctx.exports.ControlApi` with `interceptOutboundHttp`, sets a 6 h inactivity timeout, and arms an alarm every 5 min. The alarm restarts a dead container and refreshes the timeout. The Worker cron calls the same check.
- `entry.sh` runs `amp orb provider /app/dispatch.sh` in a loop. Output is redacted (`aop_live_…`, the exact token, JWTs, long base64/hex runs) and written to stdout and `/var/log/cf-orbs-provider.log` (capped at 5 MB).

Check it:

```sh
cf-orbs status            # provider: running, startedAt, restarts, last log line
cf-orbs logs --provider   # provider log tail (redacted)
cf-orbs doctor            # fails on a missing token secret or two providers on one token
```

The Worker runs the provider only while the secret `AMP_ORB_PROVIDER_TOKEN` exists. It does not read `providerHost` (only the CLI does).

The `ProviderHost` DO keeps its container running all the time, so it can keep old Worker code after a deploy for a long time (Cloudflare: a DO that holds a running container keeps the code it loaded). The start, restart and stop checks below work in old and new code, but check the result with `cf-orbs status` and `cf-orbs doctor` after a change.

`Error: Amp rejected the orb provider token` in the log means the secret is wrong or revoked. Set a new one (see Rotate), and the next check restarts the provider.

## External mode

Use this when you want the Amp token to stay off Cloudflare, or when the CF provider does not fit (for example, `lite` runs out of memory).

1. Run `cf-orbs init --provider external` (or set `"providerHost": "external"` in `cf-orbs.config.jsonc` and run `cf-orbs deploy`). In external mode every deploy deletes the Worker secret `AMP_ORB_PROVIDER_TOKEN` and re-sends `CONTROL_TOKEN`. Within 5 min the `ProviderHost` alarm sees no token and stops the CF provider. Do not start the external one before that: Amp makes a second provider on the same token wait for the first. `cf-orbs doctor` fails while the CF provider still runs.
2. On the host: Node 22 or later, `curl`. Copy `dispatch.sh` from your project (`.cf-orbs/dispatch/dispatch.sh`; in a clone, `dispatch/dispatch.sh`):

   ```sh
   sudo npm install -g @ampcode/cli@0.0.1793390435-g08e9ec
   sudo install -d -m 0755 /opt/cf-orbs
   sudo install -m 0755 .cf-orbs/dispatch/dispatch.sh /opt/cf-orbs/dispatch.sh
   sudo useradd --system --home /var/lib/cf-orbs --create-home cf-orbs
   ```

   Use the same `@ampcode/cli` version as `provider/Dockerfile`. `init --provider external` also prints the env values and the command for a quick manual run.

3. Env file `/etc/cf-orbs/provider.env`, mode `0600`, owner `root`:

   ```sh
   AMP_ORB_PROVIDER_TOKEN=aop_live_...
   CF_ORBS_URL=https://cf-orbs.<your-subdomain>.workers.dev
   CF_ORBS_CONTROL_TOKEN=<contents of .cf-orbs/control-token>
   AMP_SKIP_UPDATE_CHECK=1
   ```

4. Unit `/etc/systemd/system/cf-orbs-provider.service`:

   ```ini
   [Unit]
   Description=cf-orbs Amp orb provider
   Wants=network-online.target
   After=network-online.target

   [Service]
   User=cf-orbs
   EnvironmentFile=/etc/cf-orbs/provider.env
   ExecStart=/usr/bin/env amp orb provider /opt/cf-orbs/dispatch.sh
   Restart=always
   RestartSec=5
   # Amp makes a new provider wait for the old one to stop; give it time to exit.
   KillSignal=SIGTERM
   TimeoutStopSec=30
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadWritePaths=/var/lib/cf-orbs

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now cf-orbs-provider
   journalctl -u cf-orbs-provider -f
   ```

   You can also run `provider/entry.sh` as `ExecStart` to get the same redaction and log file as CF mode; set `CF_ORBS_DISPATCH=/opt/cf-orbs/dispatch.sh` and `CF_ORBS_PROVIDER_LOG=/var/lib/cf-orbs/provider.log`.

## One provider per token

Run exactly one provider for each token. A second provider on the same token logs "Another amp orb provider is connected… Waiting for it to stop" and takes no jobs until the first stops. Do not pass `--allow-multiple`. One provider handles all jobs, so a second adds nothing.

One provider serves one orb size (Amp sends no size). For a second size, make a second provider token and a second install.

## Rotate the provider token

1. In Amp: Settings → Orbs → your provider → create a new token. Keep the old one for now.
2. Set the new token:
   - CF mode: write the new token to a file (mode 600), then `cf-orbs init --token-file <file>` (or `npx wrangler secret put AMP_ORB_PROVIDER_TOKEN --config .cf-orbs/wrangler.jsonc`). `init` calls `POST /v1/provider/start`; that check, or the next cron or alarm (≤ 5 min), sees a different token hash, stops the old container and starts a new one. If `cf-orbs status` still shows the old start time after 10 min, see the note on old Worker code above and report it: this path is not yet tested on a live install.
   - External mode: edit `/etc/cf-orbs/provider.env`, then `sudo systemctl restart cf-orbs-provider`.
3. Check `cf-orbs status` (or the journal) for a clean start with no "rejected" line.
4. Revoke the old token in Amp.

Jobs that arrive during the restart wait in Amp, which offers unclaimed jobs again. Orb state lives in the Worker, so none is lost.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Provider image. Build context = repo root (in a project: `.cf-orbs/`): `docker build -f provider/Dockerfile .` |
| `entry.sh` | Loop + redaction + log cap. Env knobs are documented at the top of the file |
| `../dispatch/dispatch.sh` | Dispatch program (one run per job) |
| `../worker/src/provider.ts` | `ProviderHost` DO and `ensureProviderRunning()` |

Local smoke test (expects `Error: Amp rejected the orb provider token`, then a restart line):

```sh
docker build -f provider/Dockerfile -t cf-orbs-provider .
docker run --rm -e AMP_ORB_PROVIDER_TOKEN=aop_live_bad cf-orbs-provider
```
