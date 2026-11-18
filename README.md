# cf-orbs: run Amp orbs on your Cloudflare account

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meirdick/cf-orbs-template)

Deploy [cf-orbs](https://github.com/meirdick/cf-orbs), a self-hosted [Amp](https://ampcode.com) orb provider on Cloudflare Containers, to your own Cloudflare account in one click. The button clones this repo into your GitHub or GitLab account and deploys it from there.

Community project, not affiliated with Cloudflare or Amp.

## What you need

| You need | Where |
| --- | --- |
| A Cloudflare account on **Workers Paid** ($5/month; Containers need it) | Dashboard → Workers & Pages → Plans |
| An Amp provider token (`aop_live_…`) | Amp → Settings → Orbs → Add Provider. Note the provider name you type there |

You do not need Node, Docker, wrangler or a terminal.

## 1. Click the button

On the Cloudflare setup page:

| Setting | What to pick |
| --- | --- |
| **Project name** | Any name. The Worker and its containers take it |
| **AMP_ORB_PROVIDER_TOKEN** | Your Amp provider token. It is the only secret the page asks for |
| **Enable Preview builds** | Off. This Worker gets no preview URL, so a branch build only uses build minutes |
| **Create private Git repository** | Your choice. The repo holds no secrets; they live on the Worker |

The page may say *"No Wrangler configuration detected"*. That is expected: the config is at `.cf-orbs/wrangler.jsonc` and the deploy finds it. Leave the advanced settings as they are.

The first build takes 10-15 min. When it finishes, the provider starts by itself within 5 min and registers with Amp. There is nothing else to set up.

For a second install in the same Cloudflare account, click the button again and pick another project name.

## 2. Try it

In Amp, start a thread on your provider (this spends Amp credits):

```
amp -ox "hello from cf-orbs" --orb-provider <the provider name from Amp Settings>
```

The first orb on each Cloudflare host pulls the 1.8 GB orb image (40-50 s).

## After that

- **Changes and upgrades**: Workers Builds redeploys this repo on every push to `main`. Edit `image/Dockerfile` to change the orb image.
- **Token rotation**: Cloudflare dashboard → your Worker → Settings → Variables and Secrets. Paste a new `aop_live_…` there.
- **Costs**: [cf-orbs costs](https://github.com/meirdick/cf-orbs#costs). A paused orb has no compute charge; the provider container is always on.
- **Docs**: the [one-click install guide](https://cf-orbs.system3inference.dev/docs/guides/install-button/) and the [cf-orbs docs](https://cf-orbs.system3inference.dev/docs/).

## Optional: the cf-orbs CLI

You never need the CLI. Add it if you want `status`, `logs`, `doctor` or `upgrade` from a terminal, or to change `cf-orbs.config.jsonc` (orb size, caps, prewarm). In a clone of the repo the button made:

```sh
npx wrangler login          # once, to the account you deployed to
npx cf-orbs init --no-deploy --adopt --name <your project name>
```

It sets up the CLI's access to your Worker and updates the generated files to the CLI's version; commit and push them. It asks for the Amp token: press Enter to keep the one you already set. It also prints Workers Builds dashboard steps; the button already did those.
