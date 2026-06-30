# Piotr Paklerski — project portfolio

A portfolio of working Gen AI / enterprise data-product demos: natural-language interfaces over governed data, deterministic logic paired with LLM narration, and citation/evidence handling that's defensible to a non-technical reviewer. Plain HTML/CSS/JS across the board — no framework, no build step.

**Live portfolio: https://podskarbi.pages.dev/**

The root page is a portfolio home that links out to each demo; it is also a working app in its own right (see Enterprise Document Intelligence below).

## Projects

### Enterprise Document Intelligence (EDI)

Natural-language interrogation over 39 public UNICEF OIAI reports, with deterministic dashboards, scoped retrieval, and verified verbatim citations.

- **Live:** [`#/browse`](https://podskarbi.pages.dev/#/browse) on the portfolio home · **Local:** `http://localhost:8801/#/browse`
- Routes questions to relevant reports before reading full text, instead of dumping the whole corpus into context.
- Separates exact counts (computed from a verified index) from model-generated narrative synthesis — the two are never mixed in one paragraph.
- Every factual claim is backed by a verbatim quote that is programmatically verified against the source report text; a quote that doesn't match is flagged `⚠ unverified`, never silently shown as fact.
- 39 reports · 280 observations · 651 verified quotes.

Full detail — accuracy rules, data model, build history — is in EDI's own docs: [CLAUDE.md](CLAUDE.md), [BUILD_PLAN.md](BUILD_PLAN.md), [TESTLOG.md](TESTLOG.md). Not an official UNICEF product; a public-data demonstration only, not intended for operational audit decisions.

### P2P Continuous Controls Monitoring (CCM)

An interactive compliance sandbox testing ten classic procure-to-pay (P2P) audit control rules against synthetic transaction ledgers.

- **Live:** [`P2P CCA App/`](https://podskarbi.pages.dev/P2P%20CCA%20App/) on the portfolio home · **Local:** `http://localhost:8801/P2P CCA App/index.html`
- You configure a scenario (which rules to plant cases for, and how many), generate synthetic data in the browser, and run detection.
- Detection is entirely deterministic JavaScript — the LLM (Claude Haiku) never decides whether a row is an exception. It only narrates the rows the code already flagged, one consolidated plain-language paragraph per rule.
- "Planted vs. detected" reconciles exactly every run across all 10 rules — the credibility centerpiece of the demo.
- A built-in chat assistant (same keyless Cloudflare Worker proxy pattern as EDI) lets you ask questions about the current ledger, rules, and exceptions.
- 10 rules · 100% planted/detected match · 0 false positives.

Build notes: [`P2P CCA App/P2P_CCM_build_brief.md`](<P2P CCA App/P2P_CCM_build_brief.md>). This is an openly synthetic sandbox — not real fraud detection, not production software.

## What ties them together

Both apps follow the same governing idea: **let the model explain, never let it decide the facts.** Counts, detection, and citation matching are deterministic code; the LLM is scoped to narration and synthesis, and its output is checked or reconciled against ground truth before it's trusted. Both also default to a rate-limited, keyless Cloudflare Worker proxy so reviewers can try them with zero setup, with a Settings panel to switch to your own API key or a local/open-source endpoint for stronger demos.

## Quickstart

```sh
./serve.sh            # serves on http://localhost:8801  (./serve.sh 9000 for another port)
```

Open http://localhost:8801 — the portfolio home links to both apps, or jump straight to `#/browse` (EDI) or `P2P CCA App/index.html` (CCM). New browsers default to the built-in demo proxy:
`https://edi-demo-proxy.podskarbi.workers.dev/api/messages`. It uses a low-cost Claude Haiku model, has rate/spend limits, may not always be available, and can be less capable on complex synthesis.

For stronger or private demos, switch provider in **⚙ Settings** (shared between both apps via the same `localStorage` keys) to your own Claude API key or your own OpenAI-compatible open-source/local endpoint (Ollama / vLLM / LiteLLM).

> Port 8801 is the default because 8765 belongs to the DAMA app. The API key, usage meter, and offline cache are per-origin — they don't follow you across ports.

## iPhone / PWA

EDI is installable: on the same Wi-Fi, open `http://<your-mac>.local:8801` in Safari → Share → **Add to Home Screen**. On localhost (and any HTTPS origin) a service worker precaches EDI's index and all reports, so browsing and reading work offline; the Ask features always need a connection. CCM is not currently a PWA — it's a lighter single-page sandbox with no offline cache and no persisted session data (ledger state lives in memory only and resets on reload; only the Settings/proxy URL persist, shared with EDI).

## Documentation map

- [DEPLOY.md](DEPLOY.md) — how the site and the shared demo proxy ship to Cloudflare (auto-deploy on push to `main`, manual commands, the `ALLOWED_ORIGINS` CORS gotcha).
- [CLAUDE.md](CLAUDE.md) — EDI's constitution: product stance, accuracy rules A1–A8, data model, tech decisions.
- [BUILD_PLAN.md](BUILD_PLAN.md) — EDI's implementation companion: per-step specs and acceptance checks.
- [TESTLOG.md](TESTLOG.md) — EDI's verification record for every release (expected vs. actual).
- [`P2P CCA App/P2P_CCM_build_brief.md`](<P2P CCA App/P2P_CCM_build_brief.md>) — CCM's build brief: the ten detection rules, planting/reconciliation design, and hard architectural rules (detection in code, narration only from the LLM).
- `library/index.json` / `library/vocabulary.json` — EDI's verified index (39 records, 280 observations, 651 evidence quotes, checked by `tools/verify_index.js`) and controlled topic/risk vocabulary. Curation caveats: [library/INDEX_NOTES.md](library/INDEX_NOTES.md).
