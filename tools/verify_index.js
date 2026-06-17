#!/usr/bin/env node
/*
 * verify_index.js — backward verification of the CAO Audit Navigator index (CLAUDE.md rule A4/P7).
 *
 * Checks, for every record in library/index.json:
 *   1. The source report file exists and the record's year matches the filename.
 *   2. Required fields are present (id, file, title, year, type, overall_conclusion, observations).
 *   3. EVERY quote (overall conclusion, observation summaries, agreed actions, noteworthy practices)
 *      is a verbatim substring of the source report after normalization.
 *   4. Every topic/risk tag exists in library/vocabulary.json.
 *   5. Ratings use only the canonical values; redacted observations may have null quote/rating;
 *      observations marked "informational" may have null rating.
 *
 * Normalization (both sides): strip ALL whitespace (the source files are PDF extractions with
 * broken intra-word spacing), and map curly quotes/dashes to ASCII. If an exact match fails,
 * a digit-stripped comparison is tried to tolerate page numbers/footnote markers embedded
 * mid-sentence in the PDF extraction; such matches are reported as "artifact-tolerant", not failures.
 * No other transformation is allowed — a quote that fails both checks FAILS the build.
 *
 * Usage: node tools/verify_index.js   (from the app root)
 * Exit code 0 only when every check passes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'UNICEF Reports');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'index.json'), 'utf8'));
const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, 'library', 'vocabulary.json'), 'utf8'));

const topicIds = new Set(vocab.topics.map(t => t.id));
const riskIds = new Set(vocab.risks.map(r => r.id));
const RATINGS = new Set(['High', 'Medium', 'Low']);
const CONCLUSIONS = new Set([
  'Satisfactory',
  'Partially Satisfactory, Improvement Needed',
  'Partially Satisfactory, Major Improvement Needed',
  'Unsatisfactory',
]);
const TYPES = new Set(['country_office', 'thematic', 'regional']);

// MUST stay in sync with normChar()/normQuote() in app.js — this is the
// citation-verification contract (curly quotes/dashes/NB-hyphen/minus → ASCII,
// ellipsis → "...", strip ALL whitespace incl. NBSP).
const norm = s => s
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—‑−]/g, '-')
  .replace(/…/g, '...')
  .replace(/ /g, '')
  .replace(/\s+/g, '');
const noDigits = s => s.replace(/\d+/g, '');

let failures = 0, total = 0, artifactTolerant = 0;
const fail = msg => { failures++; console.error('FAIL  ' + msg); };

const seenIds = new Set();
for (const rec of index) {
  const ctx = rec.id || rec.file || '(unknown record)';
  for (const f of ['id', 'file', 'title', 'year', 'type', 'overall_conclusion', 'observations', 'source_pdf_url']) {
    if (rec[f] === undefined || rec[f] === null) fail(`${ctx}: missing required field "${f}"`);
  }
  if (seenIds.has(rec.id)) fail(`${ctx}: duplicate id`);
  seenIds.add(rec.id);
  if (!TYPES.has(rec.type)) fail(`${ctx}: invalid type "${rec.type}"`);
  if (rec.type === 'country_office' && !rec.region) fail(`${ctx}: country_office record missing region`);

  const srcPath = path.join(REPORTS_DIR, rec.file);
  if (!fs.existsSync(srcPath)) { fail(`${ctx}: source file not found: ${rec.file}`); continue; }
  if (!rec.file.startsWith(String(rec.year))) fail(`${ctx}: year ${rec.year} does not match filename`);

  const srcRaw = fs.readFileSync(srcPath, 'utf8');
  const src = norm(srcRaw);
  const srcND = noDigits(src);

  const checkQuote = (label, quote) => {
    total++;
    const q = norm(quote);
    if (src.includes(q)) return;
    if (srcND.includes(noDigits(q))) { artifactTolerant++; return; }
    fail(`${ctx} ${label}: quote not found verbatim in source:\n      "${quote.slice(0, 100)}..."`);
  };

  if (!CONCLUSIONS.has(rec.overall_conclusion.rating)) {
    fail(`${ctx}: invalid overall conclusion rating "${rec.overall_conclusion.rating}"`);
  }
  checkQuote('overall_conclusion', rec.overall_conclusion.quote);

  for (const obs of rec.observations) {
    const octx = `obs ${obs.n} (${obs.title})`;
    if (obs.redacted || obs.informational) {
      if (obs.rating !== null && obs.rating !== undefined && !RATINGS.has(obs.rating)) {
        fail(`${ctx} ${octx}: invalid rating "${obs.rating}"`);
      }
    } else if (!RATINGS.has(obs.rating)) {
      fail(`${ctx} ${octx}: invalid/missing rating "${obs.rating}"`);
    }
    if (obs.summary_quote) checkQuote(octx, obs.summary_quote);
    else if (!obs.redacted) fail(`${ctx} ${octx}: missing summary_quote on non-redacted observation`);
    for (const t of obs.topics || []) if (!topicIds.has(t)) fail(`${ctx} ${octx}: unknown topic tag "${t}"`);
    for (const k of obs.risks || []) if (!riskIds.has(k)) fail(`${ctx} ${octx}: unknown risk tag "${k}"`);
    if (!obs.locator) fail(`${ctx} ${octx}: missing locator`);
  }

  const obsNums = new Set(rec.observations.map(o => o.n));
  for (const act of rec.agreed_actions || []) {
    if (!obsNums.has(act.observation)) fail(`${ctx}: agreed action references unknown observation ${act.observation}`);
    checkQuote(`action (obs ${act.observation})`, act.quote);
    if (!act.locator) fail(`${ctx}: agreed action obs ${act.observation} missing locator`);
  }
  for (const [i, np] of (rec.noteworthy_practices || []).entries()) {
    checkQuote(`noteworthy_practice ${i + 1}`, np.quote);
  }
}

console.log(`\n${index.length} records, ${total} quotes checked: ` +
  `${total - failures - artifactTolerant} exact, ${artifactTolerant} artifact-tolerant (page numbers), ${failures} FAILED`);
if (failures > 0) { console.error('\nVERIFICATION FAILED — the index must not ship.'); process.exit(1); }
console.log('VERIFICATION PASSED');
