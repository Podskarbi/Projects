# TESTLOG — CAO Audit Navigator

Format per BUILD_PLAN.md step 7: question/check · expected · actual · pass/fail.

## 2026-06-10 — v1 build verification (automated, in-browser via preview harness)

App served from the project root (`python3 -m http.server 8765`), tested in Chromium preview.

### Step 2 — Browse

| Check | Expected | Actual | Result |
|---|---|---|---|
| Init | 39 reports · 280 observations in header | 39 · 280 | ✅ |
| Facet "Topic: psea + Year: 2025" | exact reproducible count, equal to independent JS recount | 11 of 39, recount 11 | ✅ |
| Facet counts sum | type chips 32 CO + 5 thematic + 2 regional = 39 | 39 | ✅ |
| Zero state | "No reports match" box, never empty white box | rendered | ✅ |
| Delegated listeners | one listener per container (facet pane, results, cards, document) | code-reviewed | ✅ |

### Step 3 — Single-report view

| Check | Expected | Actual | Result |
|---|---|---|---|
| Albania 2025 | 5 cards, 3 observation cards, full text loads (31,317 chars) | as expected | ✅ |
| Card quote click | highlights right passage in full-text pane | `<mark>` placed on conclusion passage despite PDF-extraction broken spacing | ✅ |
| Egypt 2024 | redaction banner + obs 1 "Redacted per Executive Board decision" placeholder | both rendered | ✅ |
| Construction 2024 obs 4 | "No rating — informational" badge | rendered | ✅ |
| All 651 index quotes locatable | `findQuoteRange` finds raw offsets for every quote (deep-link contract) | 651/651 located | ✅ |

### Step 4 — Citation renderer + verifier (`window.__testCitations()`)

| Check | Expected | Actual | Result |
|---|---|---|---|
| Real quote | verified chip (✓) | 1 chip ok | ✅ |
| Fabricated quote | ⚠ quarantine chip + claim visually muted | 1 chip bad, 1 claim muted | ✅ |
| Uncited claim in Facts block | dotted-underline flag (A1 policing) | 1 flagged | ✅ |
| Synthesis section | distinct labeled container (A5) | rendered | ✅ |
| In-browser verifier ≡ tools/verify_index.js | 650 exact + 1 artifact-tolerant + 0 fail on all 651 index quotes | identical | ✅ |
| Citation deep link | opens report, switches to text tab, scrolls + highlights passage | works (Ukraine RRR) | ✅ |
| Streaming marker buffering | partial `{{cite` never rendered as text | mock stream split markers mid-chunk; clean render | ✅ |

### Steps 5–6 — Chat pipelines (Claude API **mocked** in-page; live calls not yet run)

| Check | Expected | Actual | Result |
|---|---|---|---|
| Single-report system prompt | 3 system blocks (rules, full report text, index record), all `cache_control: ephemeral` | 3 blocks, 3 cached | ✅ |
| Single-report answer render | facts + synthesis + verified/quarantined chips; history retained | all present, 2 turns kept | ✅ |
| Repo routing call | slim index in cached system block, strict-JSON parsed | parsed | ✅ |
| Repo local compute (A6) | "PSEA observations in 2025" → exact table from index, model never counts | 11 rows = independent recount 11; caption states computed in-app | ✅ |
| Index table survives streaming | table not overwritten by streamed answer | fixed during build (own container), retested | ✅ |
| Progress trail | Routing → Computing → Reading n → Answering, all ✓ | 4 steps done | ✅ |
| Answer system blocks | VERIFIED INDEX DATA note + `=== REPORT id: … ===` text blocks | both present | ✅ |

### Step 7 — Hygiene greps

| Check | Result |
|---|---|
| No color literals outside `styles.css` `:root` | ✅ none in app.js / index.html |
| `MODEL_ID` referenced exactly once outside declaration | ✅ (single `apiBody()` builder) |
| No real API key in tracked files | ✅ (`config.js` gitignored; example file empty) |
| All 14 `innerHTML` sites escape interpolated data | ✅ audited (escHtml / renderAnswer escape-first) |
| Console errors after full session | ✅ none |

## 2026-06-10 — v1.0.2: fix for frequent "⚠ unverified" citations in repo-wide answers

User-reported: repository-wide questions produced quarantined citations. Root causes found and fixed:

1. **Source files contain Unicode the model silently normalizes when copying quotes** — non-breaking hyphen U+2011 (38×), ellipsis U+2026, minus U+2212. Normalization contract extended on BOTH sides (`normChar()` in app.js + `norm()` in tools/verify_index.js): U+2011/U+2212 → "-", "…" → "...".
2. **Index-only answer path had nothing to quote from** — the model was required to emit verbatim quotes but received only titles/ratings, so it approximated quotes → all quarantined. `facetResultForModel()` now ships each matched observation's verbatim `summary_quote` + locator, with the instruction to copy them exactly.
3. **Prompt hardening** — explicit ban on "..."-spliced quotes, mid-quote omissions, and quoting from memory; warning that every quote is programmatically checked.
4. **Auto-repair pass** — quarantined citations trigger one best-effort API call with the implicated report texts attached; replacements are accepted ONLY if they pass the same programmatic verification, otherwise quarantine stays (a spliced quote can hide a "not" — no fragment-matching shortcuts).

| Check | Expected | Actual | Result |
|---|---|---|---|
| Full 651-quote index verification under extended normalization | unchanged: 650 exact + 1 artifact + 0 fail | identical | ✅ |
| Quote written with ASCII "-" where source has U+2011 (Chad 2026) | verifies + deep-link highlights | both | ✅ |
| Spliced quote → repair (mocked API) | quarantined first, then verified chip "auto-corrected", claim un-muted | as expected | ✅ |
| Repair returns another bad quote | quarantine + muting stay | as expected | ✅ |
| `__testCitations()` console hook | zero API calls (repair disabled) | 0 calls | ✅ |

## 2026-06-10 — v1.0.3: Dashboard view

New "Dashboard" nav item: metric cards, observations by year × rating, topic × year heatmap (top 10 / all toggle), agreed actions by stated due quarter. All figures computed in JS from the verified index (A6); every element deep-links into filtered Browse. The due-date chart explicitly notes that implementation status is not tracked in published reports (gray bars = stated date passed, nothing more).

| Check | Expected | Actual | Result |
|---|---|---|---|
| Metric cards | 39 / 280 / 76 High / 202 Medium / 271 actions | exact | ✅ |
| Heatmap cell Risk management × 2025 → click | Browse filtered, counts reconcile | cell 15 → "14 of 39 reports (15 matching observations)" | ✅ |
| Metric "Rated High" → click | header shows 76 matching observations | "28 of 39 reports (76 matching observations)" | ✅ |
| Bar segment 2025 High → click | 39 matching observations | "11 of 39 reports (39 matching observations)" | ✅ |
| Topics toggle | 10 ↔ 27 rows | works | ✅ |
| Past-due styling | quarters before 2026 Q2 gray | 9 gray bars | ✅ |
| Console errors | none | none | ✅ |

## 2026-06-11 — v1.0.4: mobile layout + PWA

Responsive pass (breakpoint 720px) + installable PWA: `manifest.webmanifest`, `sw.js` (network-first shell, cache-first data, precaches index + vocabulary + all 39 reports; never intercepts Claude API calls), generated icons (`icon-512/192.png`, `apple-touch-icon.png`), iOS meta tags. Facets become a slide-in drawer behind a "Filters · n" button; report view stacks; 16px chat inputs prevent iOS focus-zoom; due-date chart scrolls horizontally.

| Check | Expected | Actual | Result |
|---|---|---|---|
| 375px browse | full-width cards, Filters button, condensed header | as designed | ✅ |
| Filter drawer | opens, multi-select keeps it open, Done + backdrop close, badge "Filters · 1" | all paths | ✅ |
| 375px dashboard | metric grid 2-up, bars/heatmap fit, due chart scrolls | as designed | ✅ |
| 375px report view | stacked layout, quote→highlight works, 16px inputs | all | ✅ |
| ≥720px regression | static sidebar, no drawer chrome, all counts unchanged | unchanged | ✅ |
| Service worker (localhost) | registered, active, cache "cao-v1" | 51 entries incl. all 39 reports | ✅ |
| manifest + icons | HTTP 200 | 200 | ✅ |
| Console errors | none | none | ✅ |

Note: offline caching requires a secure context (localhost or HTTPS). Over plain LAN http the registration silently no-ops — Add to Home Screen still works, app is online-only.

## 2026-06-11 — v1.0.5: stale service-worker self-cleanup

User-reported: after CAO moved from port 8765 to 8801, its service worker remained registered for `localhost:8765` and resurrected the cached CAO shell on DAMA's port. Fix: when `library/index.json` fails to load (the telltale that this origin now serves a different app), `init()` calls `selfDestructStaleWorker()` — unregisters all SWs and deletes all caches on that origin, and the error banner says to reload.

| Check | Expected | Actual | Result |
|---|---|---|---|
| Normal boot | unaffected; SW + cache present | 39 rows, SW active, 1 cache | ✅ |
| Simulated foreign port (index 404) | SW unregistered, caches emptied, banner updated | swAfter=false, caches 1→0, banner includes cleanup note | ✅ |

The pre-v1.0.5 ghost on a port requires one-time manual cleanup (the cached copy predates this code): on that origin run in the console
`navigator.serviceWorker.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>caches.keys()).then(ks=>Promise.all(ks.map(k=>caches.delete(k)))).then(()=>location.reload())`

## 2026-06-12 — v1.0.6: Guide (virtual assistant)

New "✦ Guide" view (`#/guide`): question-card flow — objective → scope-narrowing (years → regions, + topics for board prep) → deterministic output. The guide is a router, not a generator: briefing and board pack are computed in JS from the verified index (A6) with every figure deep-linked; chat handoffs PRE-FILL the question in Ask all reports and never auto-send. First-visit dismissible hint banner in Browse (`cao_guide_seen` in localStorage).

| Check | Expected | Actual | Result |
|---|---|---|---|
| Board flow, scope 2025 + West and Central Africa | scope line + pack; High count = independent recount | "5 reports", High 23 = recount 23 | ✅ |
| Board pack with topic scope (2025 + PSEA) | High obs restricted to tagged observations; scoped question texts | 3 High, questions carry scope phrase | ✅ |
| Chat handoff | question pre-filled in #/ask, zero messages sent, zero API calls | prefilled, nothing sent | ✅ |
| Briefing 2026 | 10 reports = recount; topic links open Browse with scope chips active | "2026" + "Governance & accountability" chips, 6 reports | ✅ |
| Topic/location flow | focus chip → 3 destinations; region → filtered Browse | South Asia → 4 reports | ✅ |
| Free-text flow | text lands in repo chat input for review | as designed | ✅ |
| Back / Start over | previous step / objective step | both correct | ✅ |
| First-visit hint | shown when flag absent; hidden after dismiss or visiting guide | both paths | ✅ |
| Console errors | none | none | ✅ |

## PENDING — live adversarial pass (requires API key, run in-app)

Record results here when run:

- Single report (Albania): "What is this country's GDP?" → expect "Not covered in this report."
- Single report (Albania): "How many programmatic visits were sampled?" → expect 12 of 49 with verified citation.
- Repo: "How many PSEA observations in 2025 and what were they?" → count must equal the in-app index table (11).
- Repo: "Has the assessment of cash-transfer controls improved 2024→2026?" → facts per year + labeled synthesis (A5).
- Repo: "Are there controls rated differently across offices?" → both sides cited, no side picked (A7).
- Repo: "What does OIAI say about Bitcoin?" → "Not covered in the reports in scope."
- Hand-inject a fake marker (edit a question to ask the model to quote something invented) → quarantine styling.

## 2026-06-11 — provider abstraction (Claude ↔ local OpenAI-compatible) + usage meter

Goal: demonstrate the app running against an on-prem model (Ollama/vLLM/LiteLLM) with a
live cloud↔local toggle in Settings, and measure real token traffic for a cost-savings
pitch. All provider logic is confined to the "Model API" + "Usage meter" sections of
app.js; the rest of the app is provider-blind. Verified in-browser via preview harness:

| Check | Expected | Actual | Result |
|---|---|---|---|
| Anthropic body unchanged | `{model, max_tokens, system[], messages}`, cache_control preserved | exact match, model `claude-sonnet-4-6` | ✅ |
| OpenAI body | system blocks flattened to one `role:"system"` msg, `stream_options.include_usage` on streams, local model name | as expected | ✅ |
| URL routing | provider anthropic → api.anthropic.com; openai → saved endpoint | both correct | ✅ |
| Provider toggle (click path) | select + field visibility + header badge follow saved provider, both directions | both correct | ✅ |
| Save path | provider/url/model/key persisted to localStorage, badge updates, modal closes | all persisted | ✅ |
| Usage parsers | anthropic `usage.{input,output,cache_*}_tokens`; openai `usage.{prompt,completion}_tokens` | mapped to `{in,out,cw,cr}` | ✅ |
| Cost formula | $3 in + $15 out + $3.75 cache-write + $0.30 cache-read per 1M (sonnet-4-6) | 1M of each = $22.05 | ✅ |
| recordUsage | accumulates into active provider's bucket, calls counter increments | stored correctly | ✅ |
| Usage panel | per-provider rows; cloud shows "cost ≈", local shows "saved ≈ vs Claude" | rendered for both | ✅ |
| Console | no errors/warnings on load or through the flows | clean | ✅ |

Not yet tested live: an actual Ollama/vLLM endpoint (none running). The OpenAI streaming
parser follows the standard SSE shape (`choices[0].delta.content`, `[DONE]`, usage in the
final chunk under `stream_options.include_usage`); verify against a real local server and
record here. Ollama notes for that session: set `OLLAMA_ORIGINS` for CORS and a large
`num_ctx` — repo-wide questions ship full report texts and silently truncate otherwise.
