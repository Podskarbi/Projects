# Enterprise Document Intelligence

A portfolio demo showing how Gen AI can help enterprise users **browse, read, and interrogate** a governed document collection with verifiable citations. The demo uses 39 public UNICEF OIAI reports (2024–2026) purely for demonstration purposes; no confidential, client, or proprietary data is included. Plain HTML/CSS/JS, no framework, no build step.

Public portfolio URL: https://podskarbi.pages.dev/

This is not an official UNICEF product and is not intended for operational audit decisions. It is a public-data demonstration of document intelligence patterns: verified retrieval, evidence-carrying metadata, scoped chat, deterministic dashboards, and citation quarantine.

The defining property: **every factual claim the app shows is backed by a verbatim quote that is programmatically verified against the source report text.** A quote that doesn't match is publicly flagged `⚠ unverified`, never silently shown as fact. The full rules (A1–A8) are in [CLAUDE.md](CLAUDE.md) — the project constitution.

## Quickstart

```sh
./serve.sh            # serves on http://localhost:8801  (./serve.sh 9000 for another port)
```

Open http://localhost:8801. The root page is a portfolio homepage; open the featured app from there or jump straight to `http://localhost:8801/#/browse`. New browsers default to the built-in demo proxy:
`https://edi-demo-proxy.podskarbi.workers.dev/api/messages`. It uses a low-cost Claude Haiku model through a Cloudflare Worker, has rate/spend limits, may not always be available, and can be less capable on complex synthesis.

For stronger or private demos, switch provider in **⚙ Settings** to your own Claude API key or your own OpenAI-compatible open-source/local endpoint (Ollama / vLLM / LiteLLM).

> Port 8801 is the default because 8765 belongs to the DAMA app. The API key, usage meter, and offline cache are per-origin — they don't follow you across ports.

## What's inside

| Surface | What it does |
|---|---|
| **Projects home** | Portfolio hub for sharing several demos from one URL. Enterprise Document Intelligence is the first live project. |
| **✦ Guide** | "What is your objective today?" — scoped briefing, topic/location focus, an audit-board pack, or free text. A router, not a generator: it computes from the verified index and pre-fills chat questions without sending them. |
| **Browse** | Faceted navigation (year, type, region, conclusion, topic, risk, observation rating) with exact live counts. |
| **Dashboard** | Observations by year × rating, topic × year heatmap, agreed actions by stated due date — every figure computed in JS and clickable through to the evidence. |
| **Report view** | Structured cards (conclusion, findings, agreed actions, noteworthy practices) beside the full report text; clicking any quote highlights the exact passage. |
| **Ask this report** | Chat scoped to the open report. Answers only from its text; absent topics get "Not covered in this report." |
| **Ask all reports** | Route → compute-from-index → read → answer pipeline with a visible progress trail. Facts come cited per report; interpretation appears only in a separately labeled Synthesis block. |

Citations render as chips: ✓ verified (deep link highlights the passage in the report), or ⚠ quarantined when the quote doesn't match the source — with one automatic, verification-gated repair attempt.

## iPhone / PWA

On the same Wi-Fi, open `http://<your-mac>.local:8801` in Safari → Share → **Add to Home Screen**. The app installs standalone with its own icon. On localhost (and any HTTPS origin) a service worker precaches the index and all reports, so browsing and reading work offline; the Ask features always need a connection. Over plain LAN http the app is installable but online-only (browsers require a secure context for offline caching).

## Data

- `library/index.json` — the verified index: 39 records, 280 observations, 651 evidence quotes, built offline and checked by `tools/verify_index.js` (650 exact matches + 1 page-number-artifact tolerance, 0 failures). Curation caveats: [library/INDEX_NOTES.md](library/INDEX_NOTES.md).
- `library/vocabulary.json` — controlled topic/risk vocabulary (27 + 27 entries); every tag is defensible by a quote in its record.
- `UNICEF Reports/` — source `.md` files (PDF extractions). Read-only ground truth; never edited.

## Documentation map

- [CLAUDE.md](CLAUDE.md) — the constitution: product stance, accuracy rules A1–A8, data model, tech decisions.
- [BUILD_PLAN.md](BUILD_PLAN.md) — implementation companion: per-step specs and acceptance checks.
- [TESTLOG.md](TESTLOG.md) — verification record for every release (expected vs. actual). Still pending there: the live adversarial A1–A8 question sets, which need an API key.

## What this is NOT

Not a general audit advisor, not a re-rating engine, not open-web, not an editor of the reports. The assistant answers **only** from the repository — "What is this country's GDP?" gets "Not covered in this report."
