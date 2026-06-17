# BUILD_PLAN.md — CAO Audit Navigator, coding instructions

Implementation companion to `CLAUDE.md` (the constitution — product stance, accuracy rules A1–A8, data model). Read CLAUDE.md first; when this file and CLAUDE.md disagree, CLAUDE.md wins. Step 1 (verified index) is **done**: `library/index.json`, `library/vocabulary.json`, `tools/verify_index.js` all pass.

Work one step per session, in order. Each step ends with its acceptance checks green before moving on. Update CLAUDE.md's structure section as files land.

---

## Files to create

```
index.html          shell: header, three views (browse / report / chat panel)
styles.css          :root custom properties, card/badge classes
app.js              all logic, ─── Section ─── banners:
                    State · Init · Browse · Report View · Citations ·
                    Verification · Chat · Routing · Claude API · UI State ·
                    Utilities · Event Listeners
config.example.js   `const CONFIG = { apiKey: "" };` (never commit a real key)
```

No build step, no framework. CDN: `marked` only. Serve with `python3 -m http.server` from the app root (fetch of `library/` and `UNICEF Reports/` requires HTTP). `.gitignore`: `config.js`.

## Global constants (top of app.js)

```js
const MODEL_ID = "claude-sonnet-4-6";        // one constant, nowhere else
const REPORTS_PATH = "UNICEF Reports/";
const MAX_CHAT_TURNS = 12;                    // retained turns, cap context
const RATING_ORDER = ["Satisfactory", "Partially Satisfactory, Improvement Needed",
  "Partially Satisfactory, Major Improvement Needed", "Unsatisfactory"];
```

## Shared utilities (write first, used everywhere)

- `escHtml(s)` — always applied to interpolated data before `innerHTML`.
- `normQuote(s)` — the exact normalization from `tools/verify_index.js`: map `‘’→'`, `“”→"`, `–—→-`, non-breaking hyphen U+2011 and minus U+2212 `→-`, `…→...`, strip ALL whitespace (incl. NBSP). Keep the two implementations in sync — this is the citation-verification contract (extended 2026-06-11: the PDF extractions contain U+2011/U+2026/U+2212 that models silently normalize when copying quotes). Nothing looser — fragment-matching a "..."-spliced quote could hide a dropped "not".
- `normQuoteND(s)` — `normQuote` + strip digits (page-artifact tolerance).
- `findQuoteRange(reportText, quote)` — locate the quote in raw report text by walking the normalized string back to raw offsets (build an index map raw→normalized once per report; needed for highlight). Returns `{start, end}` or null.
- `fetchReport(file)` — fetch + cache report text in a `Map` (state).

---

## Step 2 — Shell + faceted browse

**Data:** load `library/index.json` + `library/vocabulary.json` at init; fail loudly if missing.

**Facets (chips with live counts):** Year · Type · Region · Overall conclusion · Topic · Risk · Observation rating. Combinable; AND across facets, OR within a facet. Counts are computed from the index in JS — never by the model (A6).

**Result list:** one row per report — title, year, type/region, overall-rating badge (color per rating, reuse one badge class set), topic tags, observation count with High/Medium split. Click → report view. A small "matched observations" hint when topic/risk/rating facets are active (show which observations matched).

**Acceptance:** counts always sum correctly when toggling facets; "Topic: psea + Year: 2025" style queries give exact, reproducible numbers; zero-state shows "No reports match" (never an empty white box); rendering uses delegated listeners (one per container).

## Step 3 — Single-report view

Two-pane layout: structured cards (from the index record) + full report text (fetched, rendered read-only).

Cards, in order — render only when data exists (degrade gracefully):
1. **Header** — title, report no., date issued, period covered, fieldwork, region/type, link to official PDF (`source_pdf_url`), redaction banner when `redactions: true`.
2. **Overall conclusion** — rating badge + verbatim quote + locator.
3. **Key findings** — one card per observation: n, title, rating badge, topics/risks chips, `summary_quote` (verbatim, quotation-marked), locator. Redacted observations show a "Redacted per Executive Board decision" placeholder. `informational: true` → "No rating — informational" badge.
4. **Agreed actions** — table: observation, action quote, due, locator. Note under the table: "Excerpts — full action lists are in the report text."
5. **Noteworthy practices** — quotes + locators.

Every quote in a card is clickable → scrolls the full-text pane to the passage and highlights it (use `findQuoteRange` + a `<mark>` span). The full report text is rendered as escaped preformatted prose (the .md files are PDF extractions, not real Markdown — do NOT run `marked` on report bodies; `marked` is only for any app-authored content).

**Acceptance:** clicking any card quote highlights the right passage in all spot-checked reports incl. one with page-number artifacts; redacted/informational observations render correctly (Egypt, Haiti, Construction, MENARO records).

## Step 4 — Citation renderer + in-browser verifier (BEFORE any chat)

The model must emit citations as markers: `{{cite report-id | verbatim quote | locator}}`.

Renderer pipeline for every model answer:
1. Parse markers; split answer into sentences/claims.
2. For each marker: fetch the report, check `normQuote(quote)` is a substring of `normQuote(reportText)`; fallback `normQuoteND`. Match → render citation chip: locator + report short-name, quote inline (collapse if >300 chars), deep link to the passage in the report view, PDF link in a popover. No match → render the chip in **quarantine style** (red, "⚠ unverified — quote not found in source") and visually mute the claim it supports.
3. Any sentence inside a "Facts" block with no citation marker → flag with a dotted underline + tooltip "uncited claim" (the UI polices A1).
4. Synthesis blocks (see step 6) are rendered in a visually distinct container labeled **"Synthesis — interpretation, not from reports"** and are exempt from per-sentence citation flags.

Markers must also survive streaming: buffer until a closing `}}` before rendering a chip.

**Acceptance:** unit-test in console with (a) a real quote, (b) a fabricated quote, (c) a quote spanning a page-number artifact — must render verified / quarantined / artifact-verified respectively.

## Step 5 — Single-report chat ("Ask this report")

- API: direct browser call, header `anthropic-dangerous-direct-browser-access: true`, key from Settings modal → `localStorage` (prompt on first use; never in committed files). Prompt caching: mark the system blocks with `cache_control: {type: "ephemeral"}`.
- System prompt = three cached blocks: (1) accuracy instructions, (2) the full report text, (3) the report's index record (for metadata). Then conversation turns (cap at `MAX_CHAT_TURNS`).
- Accuracy instructions must state, imperatively: answer ONLY from the attached report; every factual claim ends with a `{{cite ...}}` marker whose quote is copied verbatim from the report; if the report does not contain the answer reply exactly "Not covered in this report." and optionally name nearby sections; never use outside knowledge, never estimate numbers not present; quotes must never be translated or corrected.
- UI: chat panel inside the report view; reset state on report change.

**Acceptance:** adversarial set — "What is this country's GDP?" → not-covered response; "How many programmatic visits were sampled?" (Albania: 12 of 49) → exact number with verified citation; a question whose answer the model would *like* to embellish stays within report text.

## Step 6 — Repository-wide chat ("Ask all reports")

Three-stage pipeline (visible to the user as a progress trail: Routing → Reading n reports → Answering):

1. **Route.** Call Claude with the question + a slim index (id, title, year, type, region, rating, per-observation: n/title/rating/topics/risks). Ask it to return strict JSON: `{relevant_report_ids: [], relevant_observations: {...}, computable_from_index: bool, reason}`. Parse defensively.
2. **Compute locally what is computable.** Counts/lists by facet (e.g. "how many cyber-related observations in 2025") are computed in JS from the index and rendered as an exact table with per-row links — the model formats, it does not count (A6).
3. **Read & answer.** Fetch full text of selected reports. If total > ~150k chars, batch (group by report, ≤5 reports per call), each batch call returns facts-with-citations; a final call merges batch outputs (instruct: only reorganize, never add facts). System prompt = same accuracy instructions as step 5 + "Facts/Synthesis" output contract:
   - Part 1 `## Facts` — every claim cited with `{{cite ...}}`, organized per report/year.
   - Part 2 `## Synthesis — interpretation, not from reports` — optional, plain-language reading of the facts above; no new factual claims, no new citations needed; phrased as orientation, not verdict (A5/P10).
   - If nothing relevant: "Not covered in the reports in scope." and stop (skip reading stage).
4. Render through the step-4 citation pipeline.

**Acceptance:** the six CAO test questions, including: "How many PSEA observations in 2025 and what were they?" (index says: count must match exactly); "Has the assessment of cash-transfer controls improved 2024→2026?" (facts table per year + labeled synthesis); "Are there controls rated differently across offices?" (contradiction surfaced with both citations, no side picked — A7); "What does OIAI say about Bitcoin?" (not-covered).

## Step 7 — Verification pass

- `node tools/verify_index.js` still green.
- Re-run the step 5 + step 6 adversarial sets; record results in `TESTLOG.md` (question, expected, actual, pass/fail).
- Manual: every citation chip in 10 random answers deep-links to a highlighted passage; quarantine path tested by hand-injecting a fake marker.
- Grep the codebase: no color literals outside `styles.css` `:root`, no `innerHTML` without `escHtml`, `MODEL_ID` referenced exactly once outside its declaration, no real API key in any tracked file.

---

## Step 8 — Dashboard ✅ DONE (2026-06-10)

`#/dash`: metric cards (reports / observations / High / Medium / agreed actions) · observations by year × rating (stacked bars) · topic × year heatmap (top 10 + show-all toggle) · agreed actions by stated due quarter (`parseDueQuarter`: first `YYYY-MM` or `Qn YYYY` in the string; unparseable dates counted and disclosed, never guessed).

Rules: every figure computed in JS from the verified index (A6); every element deep-links into filtered Browse (`dashGo`); no composite scores, no model-generated charts; quarters whose date passed are gray with an explicit "implementation status is not tracked" note (A3). Plain HTML/CSS bars + heatmap — no chart library.

**Acceptance** (recorded in `TESTLOG.md`): every clickable figure equals the Browse result-header count after click-through (e.g. heatmap cell 15 → "14 of 39 reports (15 matching observations)").

## Step 9 — Local-model provider + usage meter ✅ DONE (2026-06-11)

Goal: demonstrate the same app running against an **on-prem model** (data never leaves the
premises) and quantify the **cost saved** vs the cloud model — both for the sales pitch.
The app can now talk to any OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, a rented
GPU box standing in for customer hardware) with a live toggle in Settings.

**Architecture rule:** every provider-specific line lives in the *"Model API"* and
*"Usage meter"* sections of `app.js` — the rest of the app stays provider-blind. The
internal call interface `{system, messages, maxTokens}` is unchanged; chat, routing,
citation repair and the A1–A8 pipeline do not know which backend answered. (The A4
verifier is the safety story for weaker local models: a paraphrased quote gets
quarantined, never shown as fact.)

**Provider layer** (`getProvider`, `apiHeaders`, `apiBody`, `apiUrl`, `callClaude`, `streamClaude`):
- `"anthropic"` (default) — wire format byte-identical to step 5 (incl. `cache_control`).
- `"openai"` — system blocks flattened into one `role:"system"` message (`flattenSystem`;
  `cache_control` dropped — meaningless locally), body `{model, max_tokens, messages}`,
  response parsed from `choices[0].message.content`, SSE deltas from
  `choices[0].delta.content` with `[DONE]` terminator. Optional bearer key for vLLM/proxies.
- `requireApiKey()` is provider-aware via `canCallApi()`: cloud needs a key, local needs a
  model name. `repairCitations` gates on `canCallApi()` too.

**Usage meter** (no estimation — exact counts from API responses):
- Anthropic: `usage.input_tokens / output_tokens / cache_creation_input_tokens /
  cache_read_input_tokens`; on streams from the `message_start` + `message_delta` events.
- OpenAI: `usage.prompt_tokens / completion_tokens`; on streams request
  `stream_options: {include_usage: true}` and read the final chunk.
- Accumulated per provider in `localStorage["cao_usage"]` as `{calls, in, out, cw, cr}`;
  priced via `PRICING` (claude-sonnet-4-6 list: $3 in / $15 out / $3.75 cache-write /
  $0.30 cache-read per 1M tokens). Cloud rows show "cost ≈ $X"; local rows show
  "saved ≈ $X vs Claude" — same formula, that traffic just didn't go to the cloud.

**Settings modal** — provider `<select>` (fields toggle per provider), endpoint URL,
model name, optional local key; "Token usage & cost" panel with reset. Header button
doubles as a provider badge (`⚙ Claude` / `⚙ Local model`) for live demos.
localStorage keys: `cao_provider`, `cao_local_url`, `cao_local_model`, `cao_local_key`,
`cao_usage`.

**Local-server prerequisites** (also stated in the modal): Ollama needs
`OLLAMA_ORIGINS=*` (CORS — the browser origin differs from the model server) and a large
`num_ctx` — repo-wide questions ship full report texts and Ollama **silently truncates**
at its default window, which then violates A3/A1 in spirit. Single-report chat is the
low-VRAM demo mode; repo-wide is the "bigger box" story.

**Acceptance** (run 2026-06-11, recorded in `TESTLOG.md`): anthropic body unchanged ·
openai body flattened correctly with `stream_options` · URL/badge/field-visibility follow
the toggle both ways through the real click path · save path persists all keys · usage
parsers map both shapes to `{in,out,cw,cr}` · 1M of each token type prices to $22.05 ·
clean console. **Still pending:** one live session against a real Ollama/vLLM endpoint to
confirm the OpenAI streaming parser end-to-end; record in `TESTLOG.md` when run.


## Step 10 — Guide ✅ DONE (2026-06-12)

`#/guide`: question-card flow — "What is your objective today?" → overview | topic/location | board prep | free text. Scope-narrowing multi-select steps with live counts (years → regions; board prep adds topics; empty selection = all). Flow definitions in `GUIDE_FLOWS`; state in `state.guide`; all rendering delegated through `#guideRoot`.

Outputs (all deterministic JS over the verified index, A6):
- **Briefing** (overview): conclusion distribution + worst-rated reports, observation totals + top-5 topics, agreed-actions due summary — every line deep-linked with the scope carried into Browse.
- **Board pack**: worst conclusions, High observations grouped by topic (restricted to scoped topics), actions due this quarter + next (capped at 12 with explicit "showing n of m"), four scope-parameterized board questions.
- **Topic/location focus**: one chip → Browse / Dashboard / suggested question.
- **Free text** → repo chat.

Hard rules: the guide is a **router, not a generator** — it writes no factual prose the index can't back; chat handoffs set `state.pendingAsk` and PRE-FILL `#/ask` — never auto-send (zero API cost inside the guide). First-visit hint banner in Browse, dismissible, keyed `cao_guide_seen`.

**Acceptance** (recorded in `TESTLOG.md`): pack counts equal independent recounts; handoff leaves chat input filled and message list empty; back/start-over navigate the flow arrays correctly.

## Unnumbered increments (see TESTLOG.md per version)

- **v1.0.2** — citation hardening: normalization contract extended (see Shared utilities); index-only answers ship verbatim `summary_quote`s so citations can verify; prompts forbid spliced/shortened quotes; **auto-repair**: a quarantined citation triggers ONE repair call with source texts attached, replacement accepted only if it passes the same verification.
- **v1.0.4** — mobile layout (≤720px: facet drawer, stacked report view, 16px inputs) + PWA (`manifest.webmanifest`, `sw.js`: network-first shell / cache-first data / precaches all reports / never intercepts API calls, icons). Offline requires secure context.
- **v1.0.5** — stale-SW self-cleanup: booting on an origin without `library/index.json` unregisters the app's service worker and clears its caches (port handed to another app).

---

## Style & layout quick spec

- Look: calm, dense, "audit dashboard" — neutral background, one accent color, rating badge colors: Satisfactory = green, PS-IN = amber, PS-MIN = orange, Unsatisfactory = red, High = red outline, Medium = amber outline.
- Typography: system font stack; quotes in serif italic to visually separate evidence from UI text.
- All vocabulary labels come from `vocabulary.json` (`label` field) — never hardcode topic/risk names in UI copy.
