# Deployment

Everything runs on Cloudflare. The portfolio site is plain static files (no build
step); the demo proxy is a Cloudflare Worker. **Pushing to `main` auto-deploys
both** — the site every push, the Worker only when its own files change. The
manual commands below reproduce the same result from any checkout.

## Portfolio site → Cloudflare Pages

- Pages project **`podskarbi`**, live at <https://podskarbi.pages.dev>, production branch **`main`**.
- No build step — the repository root *is* the deploy output (`index.html` at root,
  the CCM app under `P2P CCA App/`).

Manual deploy:

```sh
npx wrangler@4 pages deploy . --project-name=podskarbi --branch=main --commit-dirty=true
```

`--branch=main` is what makes it a **production** deploy; any other branch name
produces a *preview* deployment instead (the public URL won't change).

## Demo proxy → Cloudflare Worker

Source in [`cloudflare-worker/`](cloudflare-worker/) (see its
[README](cloudflare-worker/README.md)). **Both apps — EDI and CCM — call this one
Worker** as their built-in keyless demo provider, so it must stay deployed for the
AI features to work without a user-supplied key.

Manual deploy:

```sh
cd cloudflare-worker
npx wrangler@4 deploy --keep-vars
```

- **`--keep-vars`** preserves vars/secrets already set on the live Worker —
  most importantly the `ANTHROPIC_API_KEY` secret, which is **never** in the repo.
- Deploying the Worker needs a Cloudflare API token with **Workers Scripts: Edit**
  (the Pages deploy only needs **Pages: Edit** — broaden the token if you reuse one).

## CORS / allowed origins — read before changing domains

The Worker answers a request only if its `Origin` is listed in `ALLOWED_ORIGINS`
in [`cloudflare-worker/wrangler.jsonc`](cloudflare-worker/wrangler.jsonc). Because
`wrangler deploy` pushes the config's `vars` live, **`ALLOWED_ORIGINS` must list
every origin the apps are served from**, or their AI features get a `401` /
CORS failure and silently fall back to offline rules-based templates.

Current value includes `https://podskarbi.pages.dev` (production) and
`http://localhost:8801` (local dev). **Add any new origin** (custom domain,
preview URL, alternate local port) to that comma-separated list before relying on it.

## Credentials

The deploy step receives `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as
environment variables; neither is committed. For one-off local deploys,
`npx wrangler login` (interactive OAuth) works instead.
