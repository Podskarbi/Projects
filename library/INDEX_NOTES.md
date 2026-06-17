# Index build notes — for spot-check (2026-06-10)

Built per CLAUDE.md (rules A1–A8). 39 reports → 39 records, 280 observations, 651 evidence quotes.
`node tools/verify_index.js` passes: 650 exact verbatim matches, 1 artifact-tolerant (a page number embedded mid-sentence in the PDF extraction), 0 failures.

## Repository profile (exact counts from the index)

- Overall conclusions: 30 × Partially Satisfactory, Improvement Needed · 7 × Partially Satisfactory, Major Improvement Needed (Afghanistan 2024, Lesotho, Burkina Faso, Cameroon, Haiti, Chad, Travel Management 2026) · 1 × Unsatisfactory (DRC 2025) · 1 × Satisfactory (Kyrgyzstan 2025).
- Observation ratings: 76 High, 202 Medium, 2 unrated (see caveat 4).
- Types: 33 country office, 4 thematic (PSEA, AAP, Institutional Service Contracts, Construction 2024; Travel Management 2026), 2 regional (Ukraine Regional Refugee Response 2024, MENARO 2025).

## Curation decisions to spot-check

1. **Region** is curated metadata (UNICEF's seven regions assigned per country). It is usually, but not always, supported by an explicit quote in the report; the verifier does not quote-check it. Treat as navigation metadata, not audit evidence.
2. **Implementation dates (`due`)** were aligned from "Implementation Date:" markers in document order to the following observation heading. Where alignment was ambiguous the field is null/omitted — never guessed (A3): Mauritania obs 2, Construction thematic obs 4, Egypt obs 1, Haiti obs 9. Dates given only as month/quarter in the source are stored as such.
3. **Redactions** (official, per Executive Board decision EB2012/12-13): Egypt 2024 (obs 1), Haiti 2025 (obs 9 Security), Chile 2026 (obs 3 PSFR), Colombia 2026 (obs 4 PSFR), Rwanda 2026 (minor). Marked `"redacted": true` with null quote — the redaction itself is the fact.
4. **Unrated observations** (`rating: null, informational: true`): Construction thematic obs 4 ("The findings did not indicate any systemic problems affecting the wider organization") and MENARO "Regional Office Accountabilities" (recommendations addressed to HQ under the Future Focus Initiative, not to MENARO).
5. **Ukraine RRR "Technology in emergencies"** is numbered 14 in the report body but is Observation 13 per the contents and the executive summary table; recorded as 13 with a locator note.
6. **`agreed_actions` quotes are representative excerpts** (typically the first key action per observation), not the complete action list. The chat layer reads the full report text for complete actions. AAP thematic obs 4 has no separately stated agreed action in the executive summary table.
7. **Quote normalization**: the verifier strips all whitespace and maps curly quotes/dashes to ASCII before matching, because the source .md files are PDF extractions with broken intra-word spacing ("o bservations"). No other transformation is permitted. Typos in the source (e.g. Albania's "strenthening") are preserved verbatim in quotes.
8. **Vocabulary**: 27 topics, 27 risks (library/vocabulary.json). Rare risk tags were consolidated into broader entries during curation (e.g. ghost-workers → fraud-waste-abuse) per the controlled-vocabulary decision; every tag remains defensible by the quote in its record.

## Suggested spot-checks

- Pick 2–3 records (e.g. `2025-drc-co`, `2025-albania-co`, `2026-travel-management-thematic`) and compare quotes/ratings against the source .md.
- Re-run verification yourself: `cd "Audit Report App" && node tools/verify_index.js`.
