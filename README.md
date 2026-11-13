# cf-orbs: run Amp orbs on your Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meirdick/cf-orbs-template)

Deploy [cf-orbs](https://github.com/meirdick/cf-orbs) — a self-hosted [Amp](https://ampcode.com) orb provider on Cloudflare Containers — to your own Cloudflare account in one click. This repo is the cf-orbs install template: the button clones it into your GitHub account and deploys it there.

Community project, not affiliated with Cloudflare or Amp.

## What you need

| You need | Where |
| --- | --- |
| A Cloudflare account on **Workers Paid** ($5/month; Containers need it) | Dashboard → Workers & Pages → Plans |
| An Amp provider token (`aop_live_…`) | Amp → Settings → Orbs → Add Provider. Note the provider name you type there |

You do not need Node, Docker, wrangler or this repo's CLI. The install is set-it-and-forget-it: no terminal at any point.

## 1. Click the button

The Cloudflare page clones this repo into your GitHub or GitLab account and asks for:

| Setting | What to pick |
| --- | --- |
| **Project name** | Keep the default `cf-orbs-template` — it matches `"name"` in `.cf-orbs/wrangler.jsonc`, so the Worker and its container applications all take that name. Any other name works for a first install; see the naming note below |
| **AMP_ORB_PROVIDER_TOKEN** | Your Amp provider token (`aop_live_…`) from Amp → Settings → Orbs → Add Provider — the only secret asked for |
| **Enable Preview builds** | **Off** — a Containers Worker gets no preview URL, so a branch push would only burn build minutes uploading an unreleased Worker version (never edit the non-production branch command to `wrangler deploy`) |
| **Protect with Cloudflare Access** | Off (default) |
| **Create private Git repository** | Either; private is tidy. The repo holds no secrets — they live on the Worker |

The setup page may say *"No Wrangler configuration detected"* — that is expected: the config lives at `.cf-orbs/wrangler.jsonc` and a committed `.wrangler/deploy/config.json` redirects the deploy to it. Leave Path `/` and the API token as they are.

**Different project name, or a second install in the same Cloudflare account?** The project name renames the Worker, but wrangler still names the container applications from `"name"` in `.cf-orbs/wrangler.jsonc` — the project name cannot reach that file from the setup page ([workers-sdk#15827](https://github.com/cloudflare/workers-sdk/issues/15827)). A first install works under any project name. A second install in the same account must first edit that `"name"` to the project name it will use — one line in `.cf-orbs/wrangler.jsonc` (the file the deploy reads), and the same `"name"` in `cf-orbs.config.jsonc` so a later `cf-orbs init` regeneration keeps the edit — no CLI needed — or the deploy fails at the last step with *"Container application settings were not fully applied"* (a name collision with the first install's applications) that no retry can fix. When your account already holds container applications under the name, the build's install step prints a **cf-orbs name check** warning: an update of the same Worker will succeed, a second install will fail with that exact message — it says which and how to fix it.

Cloudflare then builds both container images with Workers Builds and deploys the Worker with your token as a secret. The first build takes about 10-15 min. When it finishes the provider starts by itself (within 5 min) and registers with Amp. Nothing else to do.

## 2. Try it

In Amp, start a thread on your provider (this spends Amp credits):

```
amp -ox "hello from cf-orbs" --orb-provider <the provider name from Amp Settings>
```

The first spawn on each Cloudflare host pulls the 1.8 GB orb image (40-50 s).

## Optional: the cf-orbs CLI

You never need the CLI. Add it only if you want `status`, `logs`, `doctor` or `upgrade` from a terminal, in a clone of the repo the button made for you:

```sh
git clone <the repo the button made> && cd <it>
npx wrangler login          # once, to the account you deployed to
npx cf-orbs init --no-deploy --adopt
```

`init --adopt` generates the control token, sets it as a Worker secret and writes `.cf-orbs/state.json`. It asks for the Amp token again — press Enter to keep the one the deploy set. It prints Workers Builds dashboard steps that the button already did — ignore those.

## After that

- **Upgrades and config**: edit `image/Dockerfile` or `cf-orbs.config.jsonc` (orb size, caps, prewarm), run `npx cf-orbs init --no-deploy` to regenerate `.cf-orbs/wrangler.jsonc`, commit, push. Workers Builds builds and deploys on each push. Without the CLI: Workers Builds redeploys this repo whenever it changes (the [cf-orbs docs](https://github.com/meirdick/cf-orbs#readme) describe what the files do).
- **Token rotation**: Worker → Settings → Variables and Secrets in the Cloudflare dashboard; paste a new `aop_live_…` there.
- **Costs**: [cf-orbs costs](https://github.com/meirdick/cf-orbs#costs). A paused orb has no compute charge; the provider container is always on.
- **Docs**: the [button install guide](https://github.com/meirdick/cf-orbs/blob/main/docs/install-button.md), the [Workers Builds caveats](https://github.com/meirdick/cf-orbs/blob/main/docs/install-workers-builds.md#caveats) (this deploy uses the same machinery) and the [cf-orbs docs](https://cf-orbs-site.mdick85.workers.dev/docs/).

This repo was generated by `npx cf-orbs template` and is safe to regenerate: user-owned files keep their edits.
