# CLAUDE.md — CAO Audit Navigator

Instructions for building the **CAO Audit Navigator**: a web app that lets a Chief Audit Officer browse, read, and interrogate an organisation's internal audit reports. The mock-up repository is the 40 UNICEF OIAI reports (2024–2026) in `UNICEF Reports/`. This folder is greenfield — this file describes the product to build; update it as the implementation lands.

> **Language:** UI, code, and this file are in **English** (matches the reports; vault-global Polish rule deliberately excepted).

---

## What this is

A reading and interrogation surface for a CAO, in one experience:

1. **Browse** — navigate the audit universe by facets: Year · Report type (country office / thematic / regional) · Region · Overall conclusion rating · Topic · Risk area · Observation rating.
2. **Read** — open one report into a CAO-oriented view: overall conclusion, key findings (observations with ratings), agreed actions, noteworthy practices, context.
3. **Ask** — chat scoped to the open report, or across the whole repository ("how many cyber-related observations in 2025?", "are the same controls rated differently across offices?").

Two navigation layers sit on top: a **Dashboard** (index-computed charts, every figure click-through to evidence) and a **Guide** (objective → scope → routed destination; a router, not a generator). Both are described under "The app".

It is **not** a search engine or a general chatbot. The AI layer answers **only from the reports**. No open-web answering, no general audit advice, no re-rating of what auditors concluded.

---

## Accuracy constitution (non-negotiable)

Internal audit is fact-based; the app must be too. These rules are adapted from the LIBER evidence principles (`Liber/LIBER_PIPELINE_PLAYBOOK_EN_v1.md` §2) and bind the index pipeline, the chat prompts, and the renderer. Any output violating them is a bug.

- **A1 — No source = not used** (P2). Every factual claim shown to the CAO carries a citation to a specific report passage. A claim that cannot be cited is deleted, not hedged.
- **A2 — Quote first, verbatim** (P3). Citations carry the **exact wording** from the report plus a locator (section/observation). Paraphrase never substitutes for the quote. Quotes are never translated or "cleaned up".
- **A3 — Never guess** (P6). Information absent from the reports → answer `Not covered in the reports in scope.` Listing what *was* covered nearby is allowed; inventing is not.
- **A4 — Backward verification** (P7). After generating an answer, every citation is checked **programmatically**: the renderer string-matches each quote against the source report text (whitespace-normalized). A quote that doesn't match is flagged `⚠ unverified` and visually quarantined — never silently shown as fact.
- **A5 — Facts first, synthesis labeled** (P9/P10). Judgment questions ("has my cyber assessment improved?") are answered in two blocks: first the sourced facts (counts, ratings, findings — each cited), then a visually separate block headed **"Synthesis — interpretation, not from reports"**. Facts and interpretation are never mixed in one paragraph.
- **A6 — Quantify, don't characterize** (P5). "3 of 12 sampled visits lacked evidence (source)" — not "many visits had issues". Counts come from the verified index, not from the model's impression.
- **A7 — Contradictions are data** (P11). When reports disagree (e.g. the same control rated differently in two offices), show both sides with both citations. Don't average, don't pick.
- **A8 — Reports are the only ground truth** (P8). If this spec, the index, or a prompt ever conflicts with report text, the report wins; fix the index.

---

## Data model — the verified index

Browse facets and cross-report routing run on a **pre-built index** (`library/index.json`), extracted offline from the reports and human-spot-checkable. The index is *evidence-carrying*: every extracted field that states a fact embeds the verbatim quote it came from.

Per report:

```json
{
  "id": "2025-albania-co",
  "file": "2025_OIAI_Audit_Report_of_Albania_Country_Office.md",
  "title": "2025 OIAI Audit Report of Albania Country Office",
  "year": 2025,
  "report_no": "2025/06",
  "type": "country_office",            // country_office | thematic | regional
  "region": "Europe and Central Asia", // null for thematic
  "period_covered": "January 2024 – February 2025",
  "source_pdf_url": "https://www.unicef.org/...",
  "overall_conclusion": {
    "rating": "Partially Satisfactory, Improvement Needed",
    "quote": "OIAI concluded that the assessed governance, risk management, or control processes were Partially Satisfactory, Improvement Needed...",
    "locator": "Executive Summary — Overall conclusion"
  },
  "observations": [
    {
      "n": 1,
      "title": "Programme monitoring",
      "rating": "Medium",              // High | Medium (Low not in reports)
      "topics": ["programme-monitoring", "supply-end-user-monitoring"],
      "risks": ["third-party-delivery"],
      "summary_quote": "Quality assurance over programmatic visit reports needs strengthening...",
      "locator": "Observation 1"
    }
  ],
  "agreed_actions": [
    { "observation": 1, "quote": "Develop and implement an offline monitoring checklist/template...", "due": "2025-07-31", "locator": "Observation 1 — Agreed actions" }
  ],
  "noteworthy_practices": [ { "quote": "...", "locator": "Executive Summary" } ]
}
```

**Controlled vocabulary.** `topics` and `risks` use a curated, normalized list kept in `library/vocabulary.json` (id, label, definition, synonyms). Seed from what the reports actually contain: `psea`, `programme-monitoring`, `cash-transfers-hact`, `procurement`, `service-contracts`, `governance-accountability`, `risk-management`, `ict-cybersecurity`, `supply-construction`, `human-resources`, `fundraising`, `emergency-response` — extend only when a report doesn't fit, never speculatively. Every tag assignment in the index must be defensible by a quote in the same record; a tag with no supporting quote is invalid.

**Index build rules** (offline, by Claude in a working session — not at app runtime):

1. Read each report in full before extracting (P1). One report = one index record.
2. Quotes verbatim, with locator. No paraphrase in the index.
3. After building, run `tools/verify_index.js` (write it): for every quote, confirm exact match in the source file; for every tag, confirm a supporting quote exists; report failures. The index ships only when verification passes clean.
4. The index never contains conclusions the reports didn't draw. Ratings come from report text, not inference.

---

## The app

### Guide

`#/guide` — "What is your objective today?" question-cards: overview briefing, topic/location focus, audit-board pack, or free text. Scope-narrowing steps (years → regions, + topics for board prep) feed deterministic outputs computed from the verified index, with every figure deep-linked into Browse/Dashboard. **The guide is a router, not a generator**: it writes no factual prose itself, and chat handoffs pre-fill the question in "Ask all reports" but never auto-send (zero API cost until the user presses Ask). First visit shows a dismissible hint banner in Browse (`cao_guide_seen`).

### Browse

Faceted navigation over the index: filter chips for Year, Type, Region, Overall rating, Topic, Risk, Observation rating — combinable, with live counts. Result list shows title, year, rating badge, topic tags. Counts are computed from the index (A6), so they're exact, not model-generated. On phones (≤720px) the facet pane becomes a slide-in drawer behind a "Filters · n" button.

### Dashboard

`#/dash` — metric cards, observations by year × rating, topic × year heatmap, agreed actions by stated due quarter. All figures computed in JS from the verified index (A6); every element deep-links into filtered Browse. No composite scores, no model-generated charts (the app never re-rates). The due-date chart states explicitly that implementation status is not tracked in published reports.

### Single-report view

Header: title, year, report no., period covered, fieldwork dates, link to original UNICEF PDF. Then cards:

- **Overall conclusion** — rating badge + the verbatim conclusion paragraph.
- **Key findings** — one card per observation: title, rating, summary quote, root causes.
- **Agreed actions** — per observation: actions, responsible staff, implementation date. (Gives the CAO the follow-up trail.)
- **Noteworthy practices** — when present.
- **Context** — audited period, scope areas, expenditure highlights as stated.

Every card is sourced from report text rendered as-is; cards for absent sections simply don't render (degrade gracefully).

### Ask — single report

Scope: the full text of the open report sent as (cached) system context. The assistant answers only from it; anything else → A3 response. Same pattern as Liber's "Ask About This Topic".

### Ask — repository-wide

Pipeline per question:

1. **Route** — send the question + the index (it's small) to Claude; it returns the set of relevant report ids and, where computable, exact counts straight from index data.
2. **Read** — load the full text of the selected reports into context (batch if >~10 reports; aggregate batch results, carrying citations through).
3. **Answer** — facts with per-report citations, then the labeled synthesis block (A5). If the routing step finds nothing relevant: A3 response, no reading step.

### Citations — the rendering contract

The model emits claims with structured markers: `{{cite report-id | verbatim quote | locator}}`. The renderer:

1. Verifies the quote against the report file (A4). Match → render; no match → `⚠ unverified` quarantine styling.
2. Renders each citation as: the quote inline (collapsible when long) + report name + locator, as a **deep link** that opens the report in-app, scrolled to and highlighting the passage.
3. Adds the original UNICEF PDF link in the citation popover.
4. A claim sentence with no citation marker in a "facts" block gets flagged visually — the UI itself polices A1.

**Normalization contract** (must be identical in `normChar()`/`normQuote()` in app.js and `norm()` in tools/verify_index.js): curly quotes → ASCII, en/em dash + non-breaking hyphen (U+2011) + minus (U+2212) → `-`, ellipsis → `...`, strip ALL whitespace incl. NBSP. Nothing else — looser matching could hide a dropped "not".

**Auto-repair (one attempt, A4-gated).** A quarantined citation triggers a single repair call with the implicated report texts attached, asking for the exact contiguous passage; the replacement is accepted **only if it passes the same programmatic verification**, otherwise the quarantine stays. No fragment-matching of "..."-spliced quotes — a splice can hide a negation.

---

## Tech stack (decided)

- **Vanilla JS, no framework, no build step** — same stance as Liber/DAMA. Static files over `python3 -m http.server` (not `file://` — `fetch()` breaks).
- CDN libs: `marked` only (reports are Markdown). Add others only with a clear reason.
- Claude API direct from browser: `anthropic-dangerous-direct-browser-access`, prompt caching on report context. Model id in **one** constant at the top of `app.js`.
- **Provider toggle (2026-06-11):** Settings can switch to any OpenAI-compatible endpoint (Ollama/vLLM/LiteLLM) for local/on-prem demos. All provider-specific code lives in the "Model API" section of `app.js` (`getProvider`, `apiBody`, `callClaude`, `streamClaude`); the rest of the app is provider-blind. OpenAI mode flattens system blocks into one `role:"system"` message (no caching). A **usage meter** accumulates exact `usage` token counts per provider in `localStorage` (`cao_usage`) and prices them at `claude-sonnet-4-6` list rates — local traffic displays as "saved vs Claude". Settings keys: `cao_provider`, `cao_local_url`, `cao_local_model`, `cao_local_key`.
- API key: in-app Settings modal → `localStorage`. Ship `config.example.js` with an empty key; **never** commit a real key — if a commit would, stop and flag to Piotr.
- Cap retained chat turns.
- **Mobile + PWA (2026-06-11):** responsive at ≤720px (facet drawer, stacked report view, 16px inputs against iOS focus-zoom). Installable via `manifest.webmanifest` + iOS meta tags; `sw.js` precaches shell + index + all 39 reports (network-first shell, cache-first data, **never** intercepts API calls). Offline needs a secure context (localhost/HTTPS) — over plain LAN http the app is installable but online-only. If the app boots on an origin whose server no longer has `library/index.json` (port handed to another app), it unregisters its own SW and clears caches (`selfDestructStaleWorker`).
- **Port:** `./serve.sh [port]`, default **8801** — 8765 belongs to the DAMA app. localStorage (API key, usage) and SW caches are per-origin, so they don't follow port changes.

```
Audit Report App/
├── CLAUDE.md            ← this file (constitution)
├── BUILD_PLAN.md        ← implementation companion: per-step specs + acceptance checks
├── README.md            ← quickstart + feature overview (entry point for humans)
├── TESTLOG.md           ← verification record per release (question · expected · actual)
├── index.html           ← shell: guide + browse + dashboard + reader + chat
├── app.js               ← all logic; ─── Section ─── banners (State, Init, Browse,
│                          Dashboard, Guide, Report View, Citations, Verification,
│                          Chat (single report), Routing, Chat (repository-wide),
│                          Model API, Usage meter, UI State, Utilities, Event Listeners)
├── styles.css           ← :root custom properties; no scattered color literals
├── config.example.js
├── serve.sh             ← ./serve.sh [port] — default 8801 (8765 belongs to DAMA)
├── manifest.webmanifest ← PWA install metadata (+ icon-512/192.png, apple-touch-icon.png)
├── sw.js                ← service worker: offline shell + report cache; never touches API calls
├── tools/
│   └── verify_index.js  ← quote/tag verification for the index
├── library/
│   ├── index.json
│   ├── vocabulary.json
│   └── INDEX_NOTES.md   ← curation caveats for spot-checking the index
└── UNICEF Reports/      ← source reports (read-only ground truth; never edit)
```

## Code conventions

Same as Liber: plain DOM APIs; delegated event listeners; **always `escHtml()` interpolated data** before `innerHTML`; `marked.parse()` only on local trusted Markdown; module-level state `let`s reset on navigation; reuse shared card/badge classes.

## What this is NOT (via negativa)

- Not a general audit advisor — it never recommends actions beyond what reports state ("orient, don't decide").
- Not a re-rating engine — ratings shown are OIAI's, verbatim; the app never assigns its own.
- Not open-web — the assistant never answers from outside the repository, even when asked.
- Not an editor — report files are immutable ground truth.

## Build order

Step-by-step coding instructions (file layout, function-level guidance, acceptance checks per step): see **`BUILD_PLAN.md`**. This file remains the constitution; BUILD_PLAN.md is the implementation companion.

1. ✅ DONE (2026-06-10) — Index pipeline: `library/vocabulary.json` + `library/index.json` built from all 39 reports; `tools/verify_index.js` passes (39 records, 280 observations, 651 quotes verified; see `library/INDEX_NOTES.md` for curation caveats).
2. ✅ DONE (2026-06-10) — Shell + browse (facets, counts, result list).
3. ✅ DONE (2026-06-10) — Single-report view (cards + full text pane with quote highlighting).
4. ✅ DONE (2026-06-10) — Citation renderer + in-browser verifier (`window.__testCitations()` console hook; in-browser verifier reproduces verify_index.js exactly: 650 exact + 1 artifact-tolerant on all 651 index quotes).
5. ✅ DONE (2026-06-10) — Single-report chat (cached system blocks; pipeline tested with mocked API — see `TESTLOG.md`).
6. ✅ DONE (2026-06-10) — Repository-wide chat (route → compute-from-index → read → answer, with batching; tested with mocked API).
7. ◐ PARTIAL — automated checks recorded in `TESTLOG.md` (facet counts, highlighting, citation verify/quarantine/uncited-flag paths, hygiene greps). PENDING: live adversarial A1–A8 question sets (needs an API key) — run the step-5/step-6 sets from BUILD_PLAN.md and append results to `TESTLOG.md`.
8. ✅ DONE (2026-06-10) — Dashboard view (`#/dash`): metric cards, observations by year × rating, topic × year heatmap, agreed actions by stated due quarter. All figures computed in JS from the verified index (A6), every element deep-links into filtered Browse; no composite scores, no model-generated charts (the app never re-rates).
9. ✅ DONE (2026-06-11) — Local-model provider + usage meter: Settings toggle between Claude cloud and any OpenAI-compatible endpoint (Ollama/vLLM/LiteLLM) for on-prem demos; exact per-provider token accounting priced at sonnet-4-6 rates ("saved vs Claude" for local traffic). Spec + acceptance: BUILD_PLAN.md step 9. PENDING: one live run against a real local endpoint to confirm the OpenAI streaming parser.
10. ✅ DONE (2026-06-12) — Guide (`#/guide`): objective question-cards → scope-narrowing steps (years/regions/topics) → deterministic briefing or board pack computed from the verified index, all deep-linked; chat handoffs pre-fill but never auto-send. The guide is a router, not a generator (writes no factual prose itself).

Marked is not loaded: report bodies must never be markdown-parsed (PDF extractions) and model answers are untrusted, so chat output goes through the app's own escape-first mini renderer in `renderAnswer()`. Add `marked` back only if app-authored Markdown content appears.

## Before large changes

This folder sits in an Obsidian vault. For any bulk operation (>5 files): state the plan in bullets, show a 1–2 file example, wait for confirmation, then offer a `git commit`. Don't delete files — archive instead.
