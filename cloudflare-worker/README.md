# Demo Proxy (shared by both apps)

Cloudflare Worker that keeps the Anthropic API key server-side and exposes a limited `/api/messages` endpoint for the built-in demo provider. **Both portfolio apps — Enterprise Document Intelligence (EDI) and P2P Continuous Controls Monitoring (CCM) — point at this one Worker by default**, so reviewers can use their AI features with zero setup. Project-wide deployment notes: [`../DEPLOY.md`](../DEPLOY.md).

## Setup

```sh
cd cloudflare-worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

After deploy, Cloudflare prints a URL like:

```text
https://edi-demo-proxy.<your-subdomain>.workers.dev
```

In the app, set the built-in proxy URL to:

```text
https://edi-demo-proxy.<your-subdomain>.workers.dev/api/messages
```

For local testing, add your local app origin to `ALLOWED_ORIGINS` in `wrangler.jsonc`.

## Redeploys

```sh
npx wrangler@4 deploy --keep-vars
```

- **`--keep-vars`** preserves vars/secrets already on the live Worker (the `ANTHROPIC_API_KEY` secret lives in Cloudflare, never in the repo, and survives deploys).
- Needs a Cloudflare API token with **Workers Scripts: Edit**.
- In this project's setup, a push to `main` that touches `cloudflare-worker/**` redeploys the Worker automatically.

## Notes

- The Worker forces `MODEL_ID` and caps `MAX_TOKENS`.
- The browser never receives the Anthropic key.
- `REQUESTS_PER_MINUTE` is an in-memory soft limit per Worker isolate. For public traffic, pair this with Anthropic spend limits and Cloudflare dashboard monitoring.
- **`ALLOWED_ORIGINS` must list every origin the apps are served from** (e.g. `https://podskarbi.pages.dev`). It's a `var`, so `wrangler deploy` overwrites the live value with whatever is in `wrangler.jsonc` — if an origin is missing here, that app's AI calls get a `401`/CORS failure and fall back to offline templates.
