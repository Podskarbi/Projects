# Enterprise Document Intelligence Demo Proxy

Cloudflare Worker that keeps the Anthropic API key server-side and exposes a limited `/api/messages` endpoint for the app's built-in demo provider.

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

## Notes

- The Worker forces `MODEL_ID` and caps `MAX_TOKENS`.
- The browser never receives the Anthropic key.
- `REQUESTS_PER_MINUTE` is an in-memory soft limit per Worker isolate. For public traffic, pair this with Anthropic spend limits and Cloudflare dashboard monitoring.
