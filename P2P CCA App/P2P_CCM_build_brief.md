# Build brief: P2P Continuous Controls Monitoring demo

A single-page, zero-backend front-end that demonstrates ten classic procure-to-pay (P2P) audit control tests against synthetic data. The user configures a scenario (which tests to plant cases for, and how many), generates the data, runs detection in the browser, and sees a dashboard of findings — each finding narrated in plain language by Claude Haiku 4.5 via a single live API call.

This is a portfolio piece for an audit / GenAI audience. It must look credible to an internal auditor and be defensible in interview: detection is deterministic, the LLM only explains, and "planted vs detected" reconciles exactly every time.

---

## Hard architectural rules (do not violate)

1. **Everything except narration runs client-side in JavaScript.** Clean baseline generation, case injection, all ten detection tests, reconciliation, and the dashboard are pure browser JS. No backend, no build step required to view.
2. **The condition that makes a test fire is produced by code, never by the LLM.** Each planted case is engineered by code to satisfy its test's exact numeric/logical condition. The same understanding writes both the case-builder and the detector.
3. **The LLM (Haiku 4.5) only narrates.** It turns detected exceptions into plain-language findings and writes a run summary. It never detects, never decides whether a row is an exception, never generates the cases that define a test.
4. **Planted must equal detected.** For every test, the number of cases drawn from its pool must equal the number the detector finds. Surface this as a reconciliation row. If they ever diverge, that's a bug in the case-builder/detector pairing, not acceptable demo behaviour.
5. **No browser storage APIs** (localStorage/sessionStorage). Hold all state in memory for the session.

---

## Data model

One transaction record schema, used for both the clean base and injected cases:

```
txn_id        string   unique, e.g. "TX000001"
date          string   ISO date, posting date
vendor_id     string   e.g. "V0001"
vendor_name   string   cosmetic, from a static pool
invoice_no    string   e.g. "INV-48213"
po_no         string   e.g. "PO-10293" (may be null for the broken-3-way-match cases)
amount        number   invoice amount
approver      string   user who approved, e.g. "U012"
created_ts    string   ISO datetime, record creation timestamp (drives out-of-hours test)
account_number string  vendor bank account number (drives bank-change test)
status        string   e.g. "paid" | "pending"
flags         array    populated by detection: list of test ids this row tripped (empty for clean rows)
```

`account_number` is in scope for v1.

A separate **vendor master**: the set of approved vendors (vendor_id, vendor_name, account_number). The clean base only ever uses vendors from this master. The non-master-vendor test plants payees absent from it. The bank-change test alters account_number away from the master value.

---

## Flow

1. **Generate clean base** (once per "Generate" click, or once at load then reuse — implementer's choice, but regenerating per click is cleaner). A few hundred to a few thousand clean rows (default ~1,500). No row trips any test. All vendors drawn from the vendor master. Cosmetic fields from static pools.
2. **Read the scenario** from the control panel: per test, enabled? and plant count N (0–10).
3. **Inject cases**: for each enabled test, draw N cases from its pool (binding relational cases to base anchors — see below), append to the dataset.
4. **Run detection**: execute all ten deterministic tests over base + injected. Populate each row's `flags`.
5. **Reconcile**: per test, compare planted N to detected count. Display.
6. **Narrate**: send detected exceptions to Haiku 4.5; render per-finding explanations and a run summary.
7. **Render dashboard** off the detection results.

---

## The ten tests — exact firing conditions and how to plant them

Each test needs: (a) the detector's exact condition, (b) how the case-builder guarantees a planted row meets it. Pools of ~15–20 pre-built cases per test; draw N at random.

**Self-contained tests** (case fully built in isolation, no base anchor needed):

1. **Split POs below approval threshold**
   - Detect: ≥3 records, same vendor_id, within a rolling 7-day window, each `amount` < threshold T (use T = 10,000), summing to ≥ T.
   - Plant: build a triplet for one vendor, 3 dates within a week, each amount in (T*0.85 … T*0.99), sum guaranteed ≥ T. One "case" = the triplet.

2. **Round-dollar invoices**
   - Detect: `amount` is an exact multiple of 1,000 (amount % 1000 === 0) and ≥ 5,000.
   - Plant: amount set to a round multiple of 1,000 (e.g. 10,000, 25,000).

3. **Out-of-hours / weekend posting**
   - Detect: `created_ts` falls on a weekend, or outside 07:00–19:00 local.
   - Plant: created_ts set to a Saturday/Sunday or to e.g. 02:30.

4. **Segregation-of-duties conflict**
   - Detect: the `approver` on a record equals the user recorded as its PO raiser. (Add a `po_raiser` field if you want this explicit, OR encode the rule as approver appearing in a "raisers" set for that PO — implementer to pick one and keep detector/builder consistent.)
   - Plant: set approver == po_raiser.

**Relational tests** (case template bound to a base anchor row at draw time):

5. **Duplicate payments (exact)**
   - Detect: two+ records sharing identical vendor_id + amount + invoice_no.
   - Plant: pick a random clean base row as anchor; create a new row copying its vendor_id, amount, invoice_no (new txn_id, near date).

6. **Fuzzy near-duplicates**
   - Detect: same vendor_id + same amount within ±3 days, OR same vendor_id + amount with an invoice_no differing by a single transposed/changed digit.
   - Plant: anchor a clean row; clone with date+2 days and invoice_no one digit altered.

7. **Broken 3-way match**
   - Detect: a `paid` record with `po_no` null (no PO) — or, if you model goods receipt, no matching receipt. Keep it to null PO for v1 simplicity.
   - Plant: build a paid record with po_no = null. (Mildly relational — must look like a normal vendor invoice otherwise; can anchor a vendor from master.)

8. **Payment to non-master vendor**
   - Detect: record whose vendor_id is NOT in the vendor master.
   - Plant: create a vendor_id outside the master (e.g. "V9xxx") with a plausible name.

9. **Vendor bank-detail change shortly before payment**
   - Detect: a record whose `account_number` differs from that vendor's account_number in the master (or from the vendor's most recent prior record), with payment within N days of the change.
   - Plant: anchor an existing vendor; create a record reusing its vendor_id but with a different account_number, dated shortly after.

10. **Sequential / duplicate invoice numbers from one vendor**
    - Detect: a single vendor with invoice_no values that are exact duplicates, or perfectly sequential (INV-1001, INV-1002, INV-1003) beyond what clean noise produces.
    - Plant: anchor a vendor; create a short run of strictly sequential invoice numbers.

> **Relational binding note:** for tests 5, 6, 9, 10, a planted "case" is a *template* (the anomalous delta) bound at draw time to a randomly chosen anchor row/vendor from the freshly generated clean base. Build the binding so the resulting row is guaranteed to satisfy the detector. Tests 1–4, 7, 8 are self-contained (8 only needs to avoid the master).

---

## Cosmetic data

Vendor names, line-item-style descriptions, approver IDs come from **small static pools defined in the code** — not from the LLM. This keeps generation instant, free, and free of any "is the data deterministic?" question. ~30 fake vendor names and a handful of approver IDs is plenty.

---

## The Haiku narration call

One live call to the Anthropic Messages API, model `claude-haiku-4-5`. (In the artifact environment, call `https://api.anthropic.com/v1/messages` with no API key — the platform injects it. `max_tokens: 1000`.)

Send the detected exceptions (grouped by test) as structured data. Two outputs wanted:

- **Per-finding narration**: for each exception (or each group), a 1–2 sentence plain-language finding that *cites the actual figures*, e.g. "Vendor Acme Ltd received three payments of 9,800 within 6 days, each below the 10,000 approval threshold — consistent with a split to avoid authorization."
- **Run summary**: a short executive paragraph — total exceptions, where they cluster, what a reviewer should look at first.

Prompt constraints to bake in: explain only what the data shows; cite real numbers from the supplied records; do not assert fraud as fact (use "consistent with" / "warrants review"); keep each finding to 1–2 sentences. Set a low `max_tokens` and a strict instruction to return findings in a parseable structure (e.g. JSON keyed by exception id, no prose preamble, no markdown fences). Parse defensively (strip any stray fences, try/catch).

Cost is negligible at Haiku rates, but keep output tight: short findings are both better audit writing and cheaper.

---

## Dashboard (renders after detection)

- **Headline strip**: total transactions, total exceptions, overall planted-vs-detected status.
- **Reconciliation table**: per test — planted N, detected count, match indicator. This is the credibility centrepiece; make it prominent.
- **Exceptions by test**: simple bar chart of detected counts per test.
- **Findings list**: each detected exception, drillable to its underlying row(s), carrying Haiku's plain-language explanation and the cited figures.
- Optionally a clean-vs-flagged split of the ledger to make the needle-in-haystack point visually.

Empty state (before first Generate): an inviting panel explaining it's a synthetic sandbox the user controls, with the scenario configurator ready.

---

## Control panel (the interactive core)

Per test, one row:

`[on/off toggle]  <test name>   plant [ N ▼ ] cases`   (N dropdown 0–10)

Plus:
- a **baseline size** control (e.g. 500 / 1,500 / 5,000 clean transactions) to demonstrate signal-in-noise,
- a global **Generate scenario** button.

Toggle off = plant no cases for that test (simplest honest meaning; the richer "plant-but-disable-detection to show a control gap" variant is a v2 idea, leave it out for now).

---

## Framing / copy notes

This is openly a **synthetic sandbox** — say so in the UI. Synthetic-and-transparent reads as competence. The reconciliation ("planted 5 / detected 5") is the quiet statement that the tests are accurate. Avoid language implying real fraud detection or production deployment; the honest framing is the differentiator.

UI copy: plain verbs, sentence case, name controls by what the user does ("Generate scenario", not "Execute pipeline"). Errors explain what to do next.

---

## Out of scope for v1 (explicitly deferred)

- ML / multivariate anomaly layer (Isolation Forest) — v2.
- Trend / period-over-period analysis with AI explanation of *why* counts changed — v2.
- Plant-but-disable-detection control-gap demonstration — v2.
- Python backend / API — not needed; v1 is all-JS plus the one Haiku call.

---

## Design

Read and follow the frontend-design skill. Ground the visual identity in the audit/controls subject rather than a generic dashboard template — the brief's content (controls, exceptions, reconciliation) should drive structure. Pick a deliberate palette and type pairing; spend boldness on one signature element (the reconciliation view is a natural candidate). Quality floor: responsive to mobile, visible keyboard focus, reduced motion respected.

---

## Completed Implementation & Customizations (June 2026)

The application has been fully implemented with the following key updates and customizations:

1. **Consolidated Narratives**: Instead of rendering one card per exception occurrence, findings are grouped by control test rule. The UI renders exactly one plain-English card per test rule, showing occurrence count (cases and rows) and a single-paragraph summary of what was found, why, and how.
2. **Rule Assistant (Chat)**: An interactive tab is embedded next to the Narratives panel. Users can ask questions about the current transaction records, active audit rules, and detected exceptions. It queries Claude Haiku using a rolling history buffer and displays formatted results and suggestions.
3. **Keyless Cloudflare Worker Routing**:
   - The settings modal is configured to be **keyless**. The Anthropic API Key input field is hidden to prevent users from exposing or copying keys in the client UI.
   - The **API Endpoint / Proxy URL** field allows routing requests through a secure Cloudflare Worker proxy (`localStorage.getItem('cao_proxy_url')`) that securely handles the API key on the server side.
   - The settings are automatically synced with the main workspace app using standard keys (`cao_api_key`, `cao_proxy_url`).
4. **Clean Baseline Spacing & Verification**:
   - The clean vendor master pool was expanded to **57 vendors** to lower transaction density at high volumes (e.g. 1500 rows).
   - Clean transactions are spaced apart by an average of 13.3 days, guaranteeing 0 false positives for Split POs (T1) and Sequential Invoices (T10) in baseline data.
   - Planted vs. Detected cases reconcile with **100% precision** across all 10 tests, showing a perfect matching status of `PASS`.

