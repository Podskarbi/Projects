"use strict";
/*
 * Enterprise Document Intelligence — all app logic.
 * Constitution: CLAUDE.md (accuracy rules A1–A8). Implementation spec: BUILD_PLAN.md.
 * Sections: State · Init · Browse · Report View · Citations · Verification ·
 *           Chat · Routing · Claude API · UI State · Utilities · Event Listeners
 */

/* ───────────────────────── Global constants ───────────────────────── */

const MODEL_ID = "claude-sonnet-4-6"; // one constant, nowhere else
const REPORTS_PATH = "UNICEF Reports/";
const MAX_CHAT_TURNS = 12; // retained turns, cap context
const RATING_ORDER = ["Satisfactory", "Partially Satisfactory, Improvement Needed",
  "Partially Satisfactory, Major Improvement Needed", "Unsatisfactory"];
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const DEFAULT_PROXY_URL = "https://edi-demo-proxy.podskarbi.workers.dev/api/messages";
const MAX_READ_REPORTS = 15;     // repo-wide: cap reports loaded per question (never silently — a notice is shown)
const BATCH_CHAR_LIMIT = 80000;  // repo-wide: chars of report text per API call before batching.
                                 // ~20k tokens — sized so one call + system prompt fits a 30k
                                 // input-tokens/minute org limit (Anthropic tier 1).
const BATCH_REPORT_LIMIT = 5;    // repo-wide: reports per batch call
const QUOTE_COLLAPSE_LEN = 300;  // citation quotes longer than this render collapsed

/* ───────────────────────── State ───────────────────────── */

const state = {
  index: [],            // library/index.json records
  vocab: null,          // library/vocabulary.json
  topicLabel: {},       // topic id -> label
  riskLabel: {},        // risk id -> label
  filters: emptyFilters(),
  browseNlMode: "or",       // natural-language bridge: topic/risk relation, "or" favors recall
  expandedFacets: new Set(),  // facet keys showing all values
  reportCache: new Map(),     // file -> raw text
  normMaps: new Map(),        // file -> {norm, map, normND, mapND}
  currentReportId: null,
  pendingHighlight: null,     // quote to highlight once report text loads
  citeStore: new Map(),       // cid -> {id, quote, locator}
  citeSeq: 0,
  dashAllTopics: false,       // heatmap: top 10 vs all topics
  guide: null,                // guide flow state {objective, step, years, regions, topics, focus}
  guideAsks: [],              // questions offered by the current guide screen
  pendingAsk: null,           // question to pre-fill (not send) in repo chat
  pendingAskAutoSend: false,  // browse handoff submits after navigation
  pendingAskScope: null,      // browse filter scope to apply to the next repo chat
  repoScope: null,            // active repo chat scope {ids, label}
  reportChat: [],             // [{role, content}] — reset on report change
  repoChat: [],               // [{role, content}] — retained transcript (capped for API)
  slimIndex: null,            // cached slim index JSON string for routing
  busy: false,
};

function emptyFilters() {
  return { year: new Set(), type: new Set(), region: new Set(), conclusion: new Set(),
           topic: new Set(), risk: new Set(), obsRating: new Set() };
}

/* ───────────────────────── Init ───────────────────────── */

async function init() {
  try {
    const [idxRes, vocRes] = await Promise.all([
      fetch("library/index.json"), fetch("library/vocabulary.json"),
    ]);
    if (!idxRes.ok) throw new Error(`library/index.json → HTTP ${idxRes.status}`);
    if (!vocRes.ok) throw new Error(`library/vocabulary.json → HTTP ${vocRes.status}`);
    state.index = await idxRes.json();
    state.vocab = await vocRes.json();
  } catch (e) {
    const el = $("#fatalError");
    el.hidden = false;
    el.textContent = "Failed to load the verified index: " + e.message +
      " — serve this folder over HTTP (python3 -m http.server), not file://.";
    // Self-cleanup: if this shell was resurrected by a stale service worker on a
    // port that now serves a DIFFERENT app, unregister ourselves and clear our
    // caches from this origin so the rightful app loads on the next reload.
    const cleaned = await selfDestructStaleWorker();
    if (cleaned) el.textContent += " Stale offline cache from a previous app on this port was removed — reload this page.";
    return;
  }
  for (const t of state.vocab.topics) state.topicLabel[t.id] = t.label;
  for (const r of state.vocab.risks) state.riskLabel[r.id] = r.label;
  const obsTotal = state.index.reduce((s, r) => s + r.observations.length, 0);
  state.brandStats = `${state.index.length} OIAI reports · ${obsTotal} observations`;
  $("#brandSub").textContent = "portfolio hub";
  $("#askRepoCount").textContent = String(state.index.length);
  renderBrowse();
  syncFacetDrawerState(false);
  if (!localStorage.getItem("cao_guide_seen")) $("#guideHint").hidden = false;
  route();
  // PWA: offline caching of the app shell + reports. Requires a secure context
  // (localhost or HTTPS) — over plain LAN http the registration silently no-ops
  // and the app simply stays online-only.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

// Remove this app's service worker + caches from the current origin. Used when
// the verified index is missing — the telltale sign that this origin (port) now
// belongs to another app and we are only here via a stale offline cache.
async function selfDestructStaleWorker() {
  let cleaned = false;
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { await r.unregister(); cleaned = true; }
    }
    if (window.caches) {
      for (const k of await caches.keys()) { await caches.delete(k); cleaned = true; }
    }
  } catch (_) { /* best-effort */ }
  return cleaned;
}

// Mobile facet drawer
function isFacetDrawerMode() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function syncFacetDrawerState(open) {
  const drawer = $("#facetDrawer");
  const backdrop = $("#facetBackdrop");
  const drawerMode = isFacetDrawerMode();
  const hidden = drawerMode && !open;
  drawer.setAttribute("aria-hidden", hidden ? "true" : "false");
  drawer.inert = hidden;
  backdrop.hidden = drawerMode ? !open : true;
  $("#filtersBtn").setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleFacets(open, restoreFocus = true) {
  const drawer = $("#facetDrawer");
  drawer.classList.toggle("open", open);
  syncFacetDrawerState(open);
  if (open && isFacetDrawerMode()) $("#facetsDone").focus();
  else if (restoreFocus && isFacetDrawerMode()) $("#filtersBtn").focus();
}

/* Hash routing: #/home · #/browse · #/report/<id> · #/dash · #/ask · #/guide */
function route() {
  const h = location.hash;
  if (!h || h === "#/" || h === "#/home") {
    showView("home");
  } else if (h.startsWith("#/report/")) {
    showReport(decodeURIComponent(h.slice("#/report/".length)));
  } else if (h === "#/ask") {
    showView("ask");
    if (state.pendingAskScope) {
      state.repoScope = state.pendingAskScope;
      state.pendingAskScope = null;
    }
    updateRepoScopeNotice();
    updateRepoAskEmpty();
    if (state.pendingAsk) { // guide handoff: pre-filled, never auto-sent
      const input = $("#repoChatInput");
      input.value = state.pendingAsk;
      const autoSend = state.pendingAskAutoSend;
      state.pendingAsk = null;
      state.pendingAskAutoSend = false;
      input.focus();
      if (autoSend) {
        if (canCallApi()) setTimeout(() => $("#repoChatForm").requestSubmit(), 0);
        else openSettings();
      }
    }
  } else if (h === "#/dash") {
    renderDashboard();
    showView("dash");
  } else if (h === "#/guide") {
    renderGuide();
    showView("guide");
  } else {
    showView("home");
  }
}

/* ───────────────────────── Browse ───────────────────────── */

// Facet definitions. Report-level facets filter records directly; observation-level
// facets (obsLevel) match a report when ≥1 observation satisfies ALL active obs-level
// facets (OR within each facet, AND across facets).
const FACETS = [
  { key: "year", title: "Year", values: r => [String(r.year)] },
  { key: "type", title: "Report type", values: r => [r.type],
    label: v => ({ country_office: "Country office", thematic: "Thematic", regional: "Regional" }[v] || v) },
  { key: "region", title: "Region", values: r => r.region ? [r.region] : [] },
  { key: "conclusion", title: "Overall conclusion", values: r => [r.overall_conclusion.rating],
    label: ratingShort, order: v => RATING_ORDER.indexOf(v) },
  { key: "topic", title: "Topic", obsLevel: true, values: o => o.topics || [],
    label: v => state.topicLabel[v] || v, collapsible: true },
  { key: "risk", title: "Risk area", obsLevel: true, values: o => o.risks || [],
    label: v => state.riskLabel[v] || v, collapsible: true },
  { key: "obsRating", title: "Observation rating", obsLevel: true,
    values: o => o.rating ? [o.rating] : [] },
];

function obsMatchesFilters(obs, f) {
  if (f.topic.size && !(obs.topics || []).some(t => f.topic.has(t))) return false;
  if (f.risk.size && !(obs.risks || []).some(r => f.risk.has(r))) return false;
  if (f.obsRating.size && !(obs.rating && f.obsRating.has(obs.rating))) return false;
  return true;
}

function reportMatchesFilters(rec, f) {
  if (f.year.size && !f.year.has(String(rec.year))) return false;
  if (f.type.size && !f.type.has(rec.type)) return false;
  if (f.region.size && !(rec.region && f.region.has(rec.region))) return false;
  if (f.conclusion.size && !f.conclusion.has(rec.overall_conclusion.rating)) return false;
  if ((f.topic.size || f.risk.size || f.obsRating.size) &&
      !rec.observations.some(o => obsMatchesFilters(o, f))) return false;
  return true;
}

function computeMatches(f) {
  const obsFacetsActive = f.topic.size || f.risk.size || f.obsRating.size;
  return state.index
    .filter(rec => reportMatchesFilters(rec, f))
    .map(rec => ({
      rec,
      matchedObs: obsFacetsActive ? rec.observations.filter(o => obsMatchesFilters(o, f)) : null,
    }));
}

// Count for chip value v of facet `key`: results if this facet held ONLY {v},
// with every other facet as currently selected (standard facet-count semantics, A6: exact, in JS).
function facetValueCount(key, v) {
  const f = {};
  for (const k of Object.keys(state.filters)) f[k] = (k === key) ? new Set([v]) : state.filters[k];
  return computeMatches(f).length;
}

function collectFacetValues(facet) {
  const seen = new Map(); // value -> raw occurrence count (for sorting)
  for (const rec of state.index) {
    const sources = facet.obsLevel ? rec.observations : [rec];
    const vals = new Set();
    for (const s of sources) for (const v of facet.values(s)) vals.add(v);
    for (const v of vals) seen.set(v, (seen.get(v) || 0) + 1);
  }
  let entries = [...seen.entries()];
  if (facet.order) entries.sort((a, b) => facet.order(a[0]) - facet.order(b[0]));
  else if (facet.key === "year") entries.sort((a, b) => b[0].localeCompare(a[0]));
  else entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return entries.map(([v]) => v);
}

function renderBrowse() {
  renderFacets();
  renderResults();
}

function renderFacets() {
  const pane = $("#facetPane");
  let html = "";
  for (const facet of FACETS) {
    const values = collectFacetValues(facet);
    const active = state.filters[facet.key];
    const expanded = state.expandedFacets.has(facet.key);
    const limit = facet.collapsible && !expanded ? 8 : Infinity;
    let chips = "", shown = 0, hidden = 0;
    for (const v of values) {
      const cnt = facetValueCount(facet.key, v);
      const isActive = active.has(v);
      if (!isActive && cnt === 0) continue; // hide dead-end chips unless active
      if (shown >= limit && !isActive) { hidden++; continue; }
      shown++;
      const label = facet.label ? facet.label(v) : v;
      chips += `<button type="button" class="chip${isActive ? " active" : ""}${cnt === 0 ? " zero" : ""}"
        data-facet="${escHtml(facet.key)}" data-value="${escHtml(v)}" title="${escHtml(label)}">
        <span class="chip-label">${escHtml(label)}</span><span class="cnt">${cnt}</span></button>`;
    }
    if (hidden > 0) {
      chips += `<button type="button" class="facet-more" data-expand="${escHtml(facet.key)}">+ ${hidden} more</button>`;
    } else if (facet.collapsible && expanded) {
      chips += `<button type="button" class="facet-more" data-expand="${escHtml(facet.key)}">show fewer</button>`;
    }
    html += `<div class="facet-group"><h3 class="facet-title">${escHtml(facet.title)}</h3>
      <div class="facet-chips">${chips}</div></div>`;
  }
  pane.innerHTML = html;
}

function renderResults() {
  const matches = computeMatches(state.filters);
  const anyFilter = Object.values(state.filters).some(s => s.size);
  const matchedObs = matches.reduce((s, m) => s + (m.matchedObs ? m.matchedObs.length : 0), 0);
  renderBrowseHome(matches, matchedObs, anyFilter);
  $("#resultsCount").textContent =
    `${matches.length} of ${state.index.length} reports` + (anyFilter ? " match the selected filters" : "") +
    (matchedObs ? ` (${matchedObs} matching observation${matchedObs === 1 ? "" : "s"})` : "");
  const nActive = Object.values(state.filters).reduce((s, set) => s + set.size, 0);
  $("#filtersBtn").textContent = nActive ? `Filters · ${nActive}` : "Filters";
  $("#clearFilters").hidden = !anyFilter;
  renderBrowseNaturalLanguage(anyFilter, matches, matchedObs);

  const list = $("#resultsList");
  if (!matches.length) {
    list.innerHTML = `<div class="zero-state">No reports match the selected filters.</div>`;
    return;
  }
  let html = "";
  for (const { rec, matchedObs } of matches) {
    const high = rec.observations.filter(o => o.rating === "High").length;
    const med = rec.observations.filter(o => o.rating === "Medium").length;
    const topics = [...new Set(rec.observations.flatMap(o => o.topics || []))];
    const tagHtml = topics.slice(0, 5).map(t => `<span class="tag">${escHtml(state.topicLabel[t] || t)}</span>`).join("")
      + (topics.length > 5 ? `<span class="tag">+${topics.length - 5}</span>` : "");
    let matchedHtml = "";
    if (matchedObs && matchedObs.length < rec.observations.length) {
      const rows = matchedObs.slice(0, 3).map(o =>
        `<div>→ Obs ${o.n}: ${escHtml(o.title)} ${o.rating ? `<span class="badge ${ratingClass(o.rating)}">${escHtml(o.rating)}</span>` : ""}</div>`).join("");
      const more = matchedObs.length > 3 ? `<div>… +${matchedObs.length - 3} more matching observations</div>` : "";
      matchedHtml = `<div class="matched-obs">${rows}${more}</div>`;
    }
    html += `<a class="result-row" href="#/report/${encodeURIComponent(rec.id)}">
      <div class="result-row-top">
        <div class="result-title">${escHtml(rec.title)}</div>
        <span class="badge ${ratingClass(rec.overall_conclusion.rating)}">${escHtml(ratingShort(rec.overall_conclusion.rating))}</span>
      </div>
      <div class="result-meta">
        <span>${rec.year}</span>
        <span>${escHtml(typeLabel(rec.type))}${rec.region ? " · " + escHtml(rec.region) : ""}</span>
        <span>${rec.observations.length} observations (${high} High / ${med} Medium)</span>
      </div>
      <div class="result-tags">${tagHtml}</div>${matchedHtml}</a>`;
  }
  list.innerHTML = html;
}

function currentBrowseScope(matches = computeMatches(state.filters), anyFilter = Object.values(state.filters).some(s => s.size)) {
  return {
    ids: matches.map(m => m.rec.id),
    label: anyFilter ? browseScopeLabel() : "All reports",
    hasFilters: anyFilter,
  };
}

function browseScopeLabel() {
  const bits = [];
  const add = (key, label, values = filterLabels(key).sort()) => {
    if (values.length) bits.push(`${label}: ${joinNatural(values, "or")}`);
  };
  add("year", "Year", filterValues("year").sort((a, b) => Number(a) - Number(b)));
  add("type", "Type");
  add("region", "Region", filterValues("region").sort());
  add("conclusion", "Conclusion");
  add("topic", "Topic");
  add("risk", "Risk");
  add("obsRating", "Observation rating");
  return bits.length ? bits.join(" · ") : "All reports";
}

function renderBrowseHome(matches, matchedObs, anyFilter) {
  const scope = currentBrowseScope(matches, anyFilter);
  $("#browseAskScope").textContent = scope.label;
  const reportUnit = scope.ids.length === 1 ? "report" : "reports";
  $("#browseScopePill").textContent = `${scope.ids.length} ${reportUnit}` +
    (matchedObs ? ` · ${matchedObs} observation${matchedObs === 1 ? "" : "s"}` : "");
}

function filterValues(key) {
  return [...state.filters[key]];
}

function filterLabels(key, values = filterValues(key)) {
  const labelers = {
    type: typeLabel,
    topic: v => state.topicLabel[v] || v,
    risk: v => state.riskLabel[v] || v,
    conclusion: ratingShort,
    obsRating: v => `${v}-rated`,
  };
  const label = labelers[key] || (v => v);
  return values.map(label);
}

function joinNatural(items, joiner = "or") {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} ${joiner} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${joiner} ${items[items.length - 1]}`;
}

function buildBrowseQuestion() {
  const parts = [];
  const years = filterValues("year").sort((a, b) => Number(a) - Number(b));
  const regions = filterValues("region").sort();
  const types = filterLabels("type").sort();
  const conclusions = filterLabels("conclusion").sort();
  const obsRatings = filterLabels("obsRating").sort();
  const topics = filterLabels("topic").sort();
  const risks = filterLabels("risk").sort();
  const topicRisk = [...topics.map(v => `${v} topic`), ...risks.map(v => `${v} risk`)];
  const topicRiskJoin = state.browseNlMode === "and" ? "and" : "or";
  const hasTopicsAndRisks = topics.length && risks.length;

  if (years.length) parts.push(`reported in ${joinNatural(years, "or")}`);
  if (regions.length) parts.push(`for ${joinNatural(regions, "or")}`);
  if (types.length) parts.push(`in ${joinNatural(types, "or")} reports`);
  if (conclusions.length) parts.push(`where the overall conclusion is ${joinNatural(conclusions, "or")}`);
  if (obsRatings.length) parts.push(`with ${joinNatural(obsRatings, "or")} observations`);
  if (topicRisk.length) {
    const relation = state.browseNlMode === "and" && hasTopicsAndRisks ? "that match all of" : "related to any of";
    parts.push(`${relation} ${joinNatural(topicRisk, topicRiskJoin)}`);
  }

  const subject = topicRisk.length || obsRatings.length
    ? "observations"
    : "reports";
  const scope = parts.length ? ` ${parts.join(" ")}` : "";
  const logicHint = hasTopicsAndRisks
    ? ` Use ${state.browseNlMode.toUpperCase()} logic across selected topic/risk categories.`
    : "";
  return `Find ${subject}${scope}.${logicHint} Return the exact count and list the matching ${subject} with verified citations.`;
}

function renderBrowseNaturalLanguage(anyFilter, matches, matchedObs) {
  const panel = $("#browseNlPanel");
  if (!anyFilter) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const hasTopicRisk = state.filters.topic.size && state.filters.risk.size;
  const question = buildBrowseQuestion();
  const unit = matchedObs ? "observations in the exact Browse filter" : "reports in the exact Browse filter";
  const exactCount = matchedObs || matches.length;
  panel.hidden = false;
  panel.innerHTML = `<div class="browse-nl-head">
    <div>
      <h2>Natural-language query</h2>
      <p>Use the selected filters as a question. The Ask view can broaden broad terms and will label caveats.</p>
    </div>
    <div class="segmented" role="group" aria-label="Topic and risk logic">
      <button type="button" class="${state.browseNlMode === "or" ? "active" : ""}" data-browse-nl-mode="or"
        ${hasTopicRisk ? "" : "disabled"}>OR</button>
      <button type="button" class="${state.browseNlMode === "and" ? "active" : ""}" data-browse-nl-mode="and"
        ${hasTopicRisk ? "" : "disabled"}>AND</button>
    </div>
  </div>
  <div class="browse-nl-query">${escHtml(question)}</div>
  <div class="browse-nl-meta">Exact Browse preview: ${exactCount} ${escHtml(unit)}. ${state.browseNlMode === "or"
    ? "OR favors recall in natural-language search."
    : "AND asks for stricter overlap."}</div>
  <div class="browse-nl-actions">
    <button type="button" class="send-btn" id="browseAskBtn">Use in Ask all reports</button>
    <button type="button" class="link-btn" id="browseCopyQuestion">Copy question</button>
  </div>`;
}

/* ───────────────────────── Dashboard ─────────────────────────
 * Every figure is computed HERE, in JS, from the verified index (A6) —
 * never by the model. Every element deep-links into the filtered Browse
 * view, so charts are navigation into evidence, not free-floating claims. */

// Apply a filter set and jump to Browse (empty parts = clear filters, show all).
function dashGo(parts) {
  state.filters = emptyFilters();
  for (const [k, vals] of Object.entries(parts)) for (const v of vals) state.filters[k].add(v);
  renderBrowse();
  if (location.hash === "#/browse" || location.hash === "" ) showView("browse");
  else location.hash = "#/browse";
}

// "2025-07-31" / "2025-07" / "Q1 2026" / "2025-10 / Q1 2026" → earliest stated {y, q}; null if unparseable.
function parseDueQuarter(due) {
  if (!due) return null;
  let m = due.match(/(\d{4})-(\d{2})/);
  if (m) return { y: +m[1], q: Math.floor((+m[2] - 1) / 3) + 1 };
  m = due.match(/Q([1-4])\s*(\d{4})/i);
  if (m) return { y: +m[2], q: +m[1] };
  return null;
}

function renderDashboard() {
  const idx = state.index;
  const years = [...new Set(idx.map(r => r.year))].sort();

  // ── Metric cards ──
  let high = 0, med = 0, nObs = 0, nActions = 0;
  for (const r of idx) {
    nObs += r.observations.length;
    nActions += (r.agreed_actions || []).length;
    for (const o of r.observations) {
      if (o.rating === "High") high++;
      else if (o.rating === "Medium") med++;
    }
  }
  let html = `<div class="dash-metrics">
    <button type="button" class="metric" data-go="all"><span class="metric-label">Reports</span><span class="metric-n">${idx.length}</span></button>
    <button type="button" class="metric" data-go="all"><span class="metric-label">Observations</span><span class="metric-n">${nObs}</span></button>
    <button type="button" class="metric" data-rating="High"><span class="metric-label">Rated High</span><span class="metric-n n-high">${high}</span></button>
    <button type="button" class="metric" data-rating="Medium"><span class="metric-label">Rated Medium</span><span class="metric-n n-medium">${med}</span></button>
    <button type="button" class="metric" data-go="all" title="Excerpts — one or more key actions per observation"><span class="metric-label">Agreed actions</span><span class="metric-n">${nActions}</span></button>
  </div>`;

  // ── Observations by year × rating ──
  const yearStats = years.map(y => {
    const obs = idx.filter(r => r.year === y).flatMap(r => r.observations);
    return { y, high: obs.filter(o => o.rating === "High").length,
                med: obs.filter(o => o.rating === "Medium").length };
  });
  const maxTotal = Math.max(...yearStats.map(s => s.high + s.med));
  html += `<div class="card dash-card"><h2>Observations by year and rating</h2>` +
    yearStats.map(s => `<div class="bar-row">
      <button type="button" class="bar-label" data-year="${s.y}" title="All ${s.y} reports">${s.y}</button>
      <div class="bar-track">
        ${s.high ? `<button type="button" class="bar-seg seg-high" style="width:${Math.round(s.high / maxTotal * 100)}%"
          data-year="${s.y}" data-rating="High" title="${s.high} High-rated observations in ${s.y} — click to list">${s.high}</button>` : ""}
        ${s.med ? `<button type="button" class="bar-seg seg-med" style="width:${Math.round(s.med / maxTotal * 100)}%"
          data-year="${s.y}" data-rating="Medium" title="${s.med} Medium-rated observations in ${s.y} — click to list">${s.med}</button>` : ""}
      </div></div>`).join("") +
    `<div class="dash-note">Rated observations only (unrated/informational not shown). Click a segment to open the filtered list.</div></div>`;

  // ── Topic × year heatmap ──
  const topicTotal = new Map(), cellCount = new Map();
  for (const r of idx) for (const o of r.observations) for (const t of new Set(o.topics || [])) {
    topicTotal.set(t, (topicTotal.get(t) || 0) + 1);
    const key = t + "|" + r.year;
    cellCount.set(key, (cellCount.get(key) || 0) + 1);
  }
  const sortedTopics = [...topicTotal.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shownTopics = state.dashAllTopics ? sortedTopics : sortedTopics.slice(0, 10);
  const maxCell = Math.max(...cellCount.values());
  html += `<div class="card dash-card"><h2>Observations by topic and year</h2>
    <div class="hm-grid" style="grid-template-columns: minmax(0, 2.4fr) repeat(${years.length}, minmax(0, 1fr));">
      <div></div>
      ${years.map(y => `<button type="button" class="hm-year" data-year="${y}" title="All ${y} reports">${y}</button>`).join("")}
      ${shownTopics.map(([t]) => {
        const label = escHtml(state.topicLabel[t] || t);
        return `<div class="hm-topic" title="${label}">${label}</div>` + years.map(y => {
          const v = cellCount.get(t + "|" + y) || 0;
          if (!v) return `<div class="hm-cell hm-zero">·</div>`;
          const b = Math.min(3, Math.ceil(v / maxCell * 4) - 1);
          return `<button type="button" class="hm-cell hm-${b}" data-year="${y}" data-topic="${escHtml(t)}"
            title="${v} observations · ${label} · ${y} — click to list">${v}</button>`;
        }).join("");
      }).join("")}
    </div>
    ${sortedTopics.length > 10 ? `<button type="button" class="link-btn" id="dashTopicsToggle" style="margin-top:8px">
      ${state.dashAllTopics ? "Show top 10 only" : `Show all ${sortedTopics.length} topics`}</button>` : ""}
    <div class="dash-note">An observation can carry several topics. Click a cell to open those observations in Browse.</div></div>`;

  // ── Agreed actions by stated due date ──
  const qCount = new Map();
  let unparsed = 0;
  for (const r of idx) for (const a of r.agreed_actions || []) {
    const pq = parseDueQuarter(a.due);
    if (!pq) { unparsed++; continue; }
    const key = pq.y + " Q" + pq.q;
    qCount.set(key, (qCount.get(key) || 0) + 1);
  }
  const qKeys = [...qCount.keys()].sort();
  const maxQ = Math.max(...qCount.values());
  const now = new Date();
  const curQ = now.getFullYear() + " Q" + (Math.floor(now.getMonth() / 3) + 1);
  html += `<div class="card dash-card"><h2>Agreed actions by stated implementation due date</h2>
    <div class="q-scroll"><div class="q-chart">` + qKeys.map(k => {
      const v = qCount.get(k);
      return `<div class="q-col" title="${v} agreed actions with earliest stated due date in ${k}">
        <span class="q-n">${v}</span>
        <div class="q-bar${k < curQ ? " past" : ""}" style="height:${Math.max(4, Math.round(v / maxQ * 120))}px"></div>
        <span class="q-label">${escHtml(k)}</span>
      </div>`;
    }).join("") + `</div></div>
    <div class="dash-note">Earliest stated due date per agreed-action excerpt${unparsed ? ` (${unparsed} actions without a parseable date are not shown)` : ""}.
      Published reports state due dates only — implementation status is not tracked, so gray (past-date) bars mean
      "the stated date has passed", nothing more.</div></div>`;

  $("#dashRoot").innerHTML = `<div class="dash-wrap">${html}</div>`;
}

/* ───────────────────────── Guide ─────────────────────────
 * Question-card flow ("What is your objective today?"). The guide is a ROUTER,
 * not a generator: every step is deterministic JS over the verified index, every
 * figure deep-links into Browse/Dashboard, and chat handoffs are PRE-FILLED but
 * never auto-sent. The guide itself writes no factual prose the index can't back. */

const GUIDE_FLOWS = {
  overview: ["objective", "years", "regions", "briefing"],
  topic:    ["objective", "focus", "destination"],
  board:    ["objective", "years", "regions", "topics", "board"],
  other:    ["objective", "free"],
};

function freshGuide() {
  return { objective: null, step: "objective",
           years: new Set(), regions: new Set(), topics: new Set(), focus: null };
}

// Reports matching the guide's year/region scope.
function guideScopeReports(g) {
  return state.index.filter(r =>
    (!g.years.size || g.years.has(String(r.year))) &&
    (!g.regions.size || (r.region && g.regions.has(r.region))));
}

function guideScopeLabel(g) {
  const parts = [];
  parts.push(g.years.size ? [...g.years].sort().join(", ") : "all years");
  parts.push(g.regions.size ? [...g.regions].sort().join(" · ") : "all regions");
  if (g.topics.size) parts.push([...g.topics].map(t => state.topicLabel[t] || t).join(" · "));
  return parts.join(" — ");
}

// Scope phrase for pre-filled chat questions, e.g. " in 2025 in West and Central Africa".
function guideScopePhrase(g) {
  let s = "";
  if (g.years.size) s += " in " + [...g.years].sort().join(" and ");
  if (g.regions.size) s += " in " + [...g.regions].sort().join(" and ");
  return s;
}

function renderGuide() {
  if (!state.guide) state.guide = freshGuide();
  localStorage.setItem("cao_guide_seen", "1");
  $("#guideHint").hidden = true;
  const g = state.guide;
  state.guideAsks = [];

  let body;
  switch (g.step) {
    case "objective":   body = guideStepObjective(); break;
    case "years":       body = guideStepMulti(g, "years"); break;
    case "regions":     body = guideStepMulti(g, "regions"); break;
    case "topics":      body = guideStepMulti(g, "topics"); break;
    case "focus":       body = guideStepFocus(g); break;
    case "destination": body = guideStepDestination(g); break;
    case "briefing":    body = guideBriefing(g); break;
    case "board":       body = guideBoardPack(g); break;
    case "free":        body = guideStepFree(); break;
    default:            body = guideStepObjective();
  }

  const showScope = g.objective && g.step !== "objective";
  const canGoBack = g.step !== "objective";
  $("#guideRoot").innerHTML = `<div class="guide-wrap">
    <div class="guide-head"><span class="guide-kicker">✦ Guide</span>
      <span class="guide-nav">
        ${canGoBack ? `<button type="button" class="link-btn" data-g-back>← Back</button>` : ""}
        ${g.objective ? `<button type="button" class="link-btn" data-g-restart>Start over</button>` : ""}
      </span></div>
    ${g.objective ? guideProgress(g) : ""}
    ${showScope && (g.years.size || g.regions.size || g.topics.size)
      ? `<div class="guide-scope">Scope so far: ${escHtml(guideScopeLabel(g))}</div>` : ""}
    ${body}</div>`;
}

function guideStepObjective() {
  return `<h1 class="guide-q">What is your objective today?</h1>
  <div class="g-options">
    <button type="button" class="g-option" data-g-obj="overview">I'm new here — give me an overview of the control landscape
      <span class="g-sub">A short briefing computed from the verified index, scoped to the years and regions you pick</span></button>
    <button type="button" class="g-option" data-g-obj="topic">I'm interested in a specific topic or location
      <span class="g-sub">Pick from the actual topics and regions in the reports, then browse, chart or ask</span></button>
    <button type="button" class="g-option" data-g-obj="board">I need to prepare for a conversation with the audit board
      <span class="g-sub">A board pack: worst conclusions, High-rated findings, actions coming due — plus ready-made questions</span></button>
    <button type="button" class="g-option" data-g-obj="other">Something else — let me describe it
      <span class="g-sub">Free text, answered by the repository-wide assistant with verified citations</span></button>
  </div>`;
}

function guideProgress(g) {
  const flow = GUIDE_FLOWS[g.objective] || ["objective"];
  const labels = {
    objective: "Objective", years: "Years", regions: "Regions", topics: "Topics",
    focus: "Focus", destination: "Destination", briefing: "Briefing", board: "Board pack", free: "Question",
  };
  const cur = Math.max(0, flow.indexOf(g.step));
  return `<div class="guide-progress" aria-label="Guide progress">${flow.map((step, i) =>
    `<span class="guide-step ${i < cur ? "done" : i === cur ? "current" : ""}">${escHtml(labels[step] || step)}</span>`
  ).join("")}</div>`;
}

function guidePreview(g, label) {
  const reports = guideScopeReports(g).length;
  const scope = guideScopeLabel(g);
  return `<div class="guide-preview"><strong>${escHtml(label)}</strong><span>${escHtml(scope)}</span><span>${reports} matching report${reports === 1 ? "" : "s"}</span></div>`;
}

// Multi-select scoping step (years / regions / topics). Empty selection = all.
function guideStepMulti(g, kind) {
  const scoped = guideScopeReports({ ...g, [kind]: new Set() }); // counts within prior selections
  let title, values; // [value, label, count]
  if (kind === "years") {
    title = "Which years matter for this?";
    const ys = [...new Set(state.index.map(r => String(r.year)))].sort().reverse();
    values = ys.map(y => [y, y, state.index.filter(r => String(r.year) === y).length]);
  } else if (kind === "regions") {
    title = "Which regions or locations?";
    const rs = [...new Set(scoped.map(r => r.region).filter(Boolean))].sort();
    values = rs.map(rg => [rg, rg, scoped.filter(r => r.region === rg).length]);
  } else {
    title = "Any particular topics?";
    const counts = new Map();
    for (const r of scoped) for (const o of r.observations)
      for (const t of new Set(o.topics || [])) counts.set(t, (counts.get(t) || 0) + 1);
    values = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => [t, state.topicLabel[t] || t, n]);
  }
  const sel = g[kind];
  const chips = values.map(([v, label, n]) =>
    `<button type="button" class="chip${sel.has(v) ? " active" : ""}" data-g-toggle="${escHtml(kind)}"
      data-value="${escHtml(v)}"><span class="chip-label">${escHtml(label)}</span><span class="cnt">${n}</span></button>`).join("");
  const unit = kind === "topics" ? "observations" : "reports";
  return `<h1 class="guide-q">${escHtml(title)}</h1>
    ${guidePreview(g, "Building scope")}
    <div class="g-chips">${chips}</div>
    <button type="button" class="send-btn" data-g-continue>
      ${sel.size ? "Continue with selection" : `Continue — all ${kind}`}</button>
    <div class="g-note">Pick any number, or continue without picking to keep all ${kind}. Counts are ${unit} within your scope so far.</div>`;
}

function guideStepFocus(g) {
  const topicCounts = new Map();
  for (const r of state.index) for (const o of r.observations)
    for (const t of new Set(o.topics || [])) topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
  const topics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
  const regions = [...new Set(state.index.map(r => r.region).filter(Boolean))].sort()
    .map(rg => [rg, state.index.filter(r => r.region === rg).length]);
  return `<h1 class="guide-q">Which topic or location?</h1>
    <div class="g-topic-group">Topics (observation counts)</div>
    <div class="g-chips">${topics.map(([t, n]) =>
      `<button type="button" class="chip" data-g-focus="topic" data-value="${escHtml(t)}">
        <span class="chip-label">${escHtml(state.topicLabel[t] || t)}</span><span class="cnt">${n}</span></button>`).join("")}</div>
    <div class="g-topic-group">Regions (report counts)</div>
    <div class="g-chips">${regions.map(([rg, n]) =>
      `<button type="button" class="chip" data-g-focus="region" data-value="${escHtml(rg)}">
        <span class="chip-label">${escHtml(rg)}</span><span class="cnt">${n}</span></button>`).join("")}</div>`;
}

function guideStepDestination(g) {
  const isTopic = g.focus.kind === "topic";
  const label = isTopic ? (state.topicLabel[g.focus.value] || g.focus.value) : g.focus.value;
  const q = isTopic
    ? `What did OIAI find about ${label} across the repository, and how has it changed between 2024 and 2026?`
    : `What did OIAI find in the ${label} region? Summarize the key findings per office, with each office's overall conclusion.`;
  state.guideAsks = [q];
  return `<h1 class="guide-q">${escHtml(label)} — how do you want to look at it?</h1>
  <div class="g-options">
    <button type="button" class="g-option" data-g-dest="browse">Browse the reports
      <span class="g-sub">Filtered list with rating badges and matching observations</span></button>
    <button type="button" class="g-option" data-g-dest="dash">See it on the Dashboard
      <span class="g-sub">Counts by year, rating and topic — every figure clickable</span></button>
    <button type="button" class="g-option" data-g-ask-idx="0">Ask the repository
      <span class="g-sub">Pre-fills: “${escHtml(q)}” — you review and send it yourself</span></button>
  </div>`;
}

function guideStepFree() {
  return `<h1 class="guide-q">What do you need?</h1>
    <form class="guide-free" id="guideFreeForm">
      <textarea id="guideFreeInput" rows="3" placeholder="e.g. Were there fraud-related findings in offices with construction activities?"></textarea>
      <div class="g-actions-row"><button type="submit" class="send-btn">Continue to Ask all reports</button></div>
    </form>
    <div class="g-note">Your question is placed in the repository chat for review — nothing is sent until you press Ask there. Answers carry verified verbatim citations; anything the reports don't cover is answered with “Not covered in the reports in scope.”</div>`;
}

/* ── Briefing (overview objective) — every figure computed here, every line linked ── */
function guideBriefing(g) {
  const reports = guideScopeReports(g);
  const excludedThematic = g.regions.size ? state.index.filter(r =>
    (!g.years.size || g.years.has(String(r.year))) && !r.region).length : 0;
  if (!reports.length) {
    return `<h1 class="guide-q">No reports in this scope</h1>
      <p>There are no reports matching ${escHtml(guideScopeLabel(g))}. Go back and widen the scope.</p>`;
  }
  const byRating = new Map();
  for (const r of reports) {
    const k = r.overall_conclusion.rating;
    byRating.set(k, (byRating.get(k) || 0) + 1);
  }
  const worst = reports.filter(r => RATING_ORDER.indexOf(r.overall_conclusion.rating) >= 2);
  const allObs = reports.flatMap(r => r.observations.map(o => ({ r, o })));
  const high = allObs.filter(x => x.o.rating === "High");
  const topicCounts = new Map();
  for (const { o } of allObs) for (const t of new Set(o.topics || []))
    topicCounts.set(t, (topicCounts.get(t) || 0) + 1);
  const topTopics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const actions = reports.flatMap(r => r.agreed_actions || []);
  const now = new Date();
  const curQn = now.getFullYear() * 4 + Math.floor(now.getMonth() / 3);
  let duePast = 0, dueSoon = 0;
  for (const a of actions) {
    const pq = parseDueQuarter(a.due);
    if (!pq) continue;
    const qn = pq.y * 4 + (pq.q - 1);
    if (qn < curQn) duePast++;
    else if (qn <= curQn + 1) dueSoon++;
  }
  const scopePhrase = guideScopePhrase(g);
  state.guideAsks = [
    `What are the most significant weaknesses OIAI reported${scopePhrase}, per report?`,
    `What noteworthy practices did OIAI highlight${scopePhrase}?`,
  ];
  const ratingLine = RATING_ORDER.filter(rt => byRating.get(rt))
    .map(rt => `<span class="badge ${ratingClass(rt)}">${escHtml(ratingShort(rt))}</span> ${byRating.get(rt)}`)
    .join(" &nbsp; ");
  return `<h1 class="guide-q">Your briefing — ${reports.length} reports (${escHtml(guideScopeLabel(g))})</h1>
  ${excludedThematic ? `<div class="g-note">Note: ${excludedThematic} thematic report(s) have no region and are excluded by the region filter.</div>` : ""}
  <div class="guide-metrics">
    <span><strong>${reports.length}</strong> reports</span>
    <span><strong>${allObs.length}</strong> observations</span>
    <span><strong>${high.length}</strong> High</span>
    <span><strong>${actions.length}</strong> agreed actions</span>
  </div>
  <div class="card"><h2>Overall conclusions <span class="g-count">${reports.length} reports</span></h2>
    <p>${ratingLine}</p>
    ${worst.length ? `<p>Needing the most attention:</p><ul class="g-list">${worst.map(r =>
      `<li><a class="cite-link" href="#/report/${encodeURIComponent(r.id)}">${escHtml(shortName(r))}</a>
        <span class="badge ${ratingClass(r.overall_conclusion.rating)}">${escHtml(ratingShort(r.overall_conclusion.rating))}</span></li>`).join("")}</ul>`
      : `<p>No report in this scope was rated worse than “Partially Satisfactory, Improvement Needed”.</p>`}
  </div>
  <div class="card"><h2>Observations <span class="g-count">${allObs.length} total · ${high.length} High</span></h2>
    <p>Most frequent topics in this scope:</p>
    <ul class="g-list">${topTopics.map(([t, n]) =>
      `<li><button type="button" class="link-btn" data-g-browse-topic="${escHtml(t)}">${escHtml(state.topicLabel[t] || t)}</button> — ${n} observations</li>`).join("")}</ul>
  </div>
  <div class="card"><h2>Agreed actions <span class="g-count">${actions.length}</span></h2>
    <p>${duePast} have a stated due date that has already passed (implementation status is not tracked in published reports); ${dueSoon} fall due this quarter or next.</p>
    <div class="g-actions-row"><a class="link-btn" href="#/dash">See the due-date timeline on the Dashboard →</a></div>
  </div>
  <div class="card"><h2>Where to go next</h2>
    <div class="g-actions-row">
      <button type="button" class="nav-btn" data-g-dest="browse">Browse these ${reports.length} reports</button>
      <a class="nav-btn" href="#/dash">Open the Dashboard</a>
    </div>
    <p style="margin-top:10px">Or start a question (pre-filled for your review):</p>
    <div class="g-options">${state.guideAsks.map((q, i) =>
      `<button type="button" class="g-ask" data-g-ask-idx="${i}">${escHtml(q)}<span class="g-sub">Opens in Ask all reports — you press send</span></button>`).join("")}</div>
  </div>`;
}

/* ── Board pack (audit-board objective) ── */
function guideBoardPack(g) {
  const reports = guideScopeReports(g);
  if (!reports.length) {
    return `<h1 class="guide-q">No reports in this scope</h1>
      <p>There are no reports matching ${escHtml(guideScopeLabel(g))}. Go back and widen the scope.</p>`;
  }
  const obsInTopics = o => !g.topics.size || (o.topics || []).some(t => g.topics.has(t));
  const worst = reports.filter(r => RATING_ORDER.indexOf(r.overall_conclusion.rating) >= 2);
  const high = reports.flatMap(r => r.observations
    .filter(o => o.rating === "High" && obsInTopics(o)).map(o => ({ r, o })));
  const byTopic = new Map();
  for (const x of high) {
    const ts = (x.o.topics || []).filter(t => !g.topics.size || g.topics.has(t));
    const key = ts[0] || "(untagged)";
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(x);
  }
  const now = new Date();
  const curQn = now.getFullYear() * 4 + Math.floor(now.getMonth() / 3);
  const dueSoon = [];
  for (const r of reports) for (const a of r.agreed_actions || []) {
    const pq = parseDueQuarter(a.due);
    if (!pq) continue;
    const qn = pq.y * 4 + (pq.q - 1);
    if (qn >= curQn && qn <= curQn + 1) dueSoon.push({ r, a, label: `${pq.y} Q${pq.q}` });
  }
  const scopePhrase = guideScopePhrase(g);
  const topicPhrase = g.topics.size ? " regarding " + [...g.topics].map(t => state.topicLabel[t] || t).join(" and ") : "";
  state.guideAsks = [
    `Which controls or topics were rated differently across offices${scopePhrase}${topicPhrase}? Show both sides with citations.`,
    `Summarize the High-rated observations${scopePhrase}${topicPhrase} and the root causes the reports give for them.`,
    `Which agreed actions${scopePhrase}${topicPhrase} are the most significant for the organisation, and when are they due?`,
    `What positive developments or noteworthy practices can I mention to the board${scopePhrase}?`,
  ];
  const DUE_LIMIT = 12;
  return `<h1 class="guide-q">Board pack — ${reports.length} reports (${escHtml(guideScopeLabel(g))})</h1>
  <div class="guide-metrics">
    <span><strong>${worst.length}</strong> conclusions needing attention</span>
    <span><strong>${high.length}</strong> High observations</span>
    <span><strong>${dueSoon.length}</strong> actions due soon</span>
  </div>
  <div class="card"><h2>Conclusions needing attention <span class="g-count">${worst.length}</span></h2>
    ${worst.length ? `<ul class="g-list">${worst.map(r =>
      `<li><a class="cite-link" href="#/report/${encodeURIComponent(r.id)}">${escHtml(shortName(r))}</a>
        <span class="badge ${ratingClass(r.overall_conclusion.rating)}">${escHtml(ratingShort(r.overall_conclusion.rating))}</span></li>`).join("")}</ul>`
      : `<p>No report in this scope was rated worse than “Partially Satisfactory, Improvement Needed”.</p>`}
  </div>
  <div class="card"><h2>High-rated observations <span class="g-count">${high.length}</span></h2>
    ${high.length ? [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length).map(([t, xs]) =>
      `<div class="g-topic-group">${escHtml(state.topicLabel[t] || t)} (${xs.length})</div>
       <ul class="g-list">${xs.map(({ r, o }) =>
        `<li><a class="cite-link" href="#/report/${encodeURIComponent(r.id)}">${escHtml(shortName(r))}</a> — Obs ${o.n}: ${escHtml(o.title)}</li>`).join("")}</ul>`).join("")
      : `<p>No High-rated observations in this scope.</p>`}
  </div>
  <div class="card"><h2>Actions due this quarter or next <span class="g-count">${dueSoon.length}</span></h2>
    ${dueSoon.length ? `<ul class="g-list">${dueSoon.slice(0, DUE_LIMIT).map(({ r, a, label }) =>
      `<li>${escHtml(label)} — <a class="cite-link" href="#/report/${encodeURIComponent(r.id)}">${escHtml(shortName(r))}</a> (Obs ${a.observation})</li>`).join("")}</ul>
      ${dueSoon.length > DUE_LIMIT ? `<div class="g-note">Showing ${DUE_LIMIT} of ${dueSoon.length} — the full timeline is on the <a class="cite-link" href="#/dash">Dashboard</a>.</div>` : ""}`
      : `<p>No agreed actions with stated due dates in this quarter or the next.</p>`}
  </div>
  <div class="card"><h2>Questions to take into the conversation</h2>
    <div class="g-options">${state.guideAsks.map((q, i) =>
      `<button type="button" class="g-ask" data-g-ask-idx="${i}">${escHtml(q)}<span class="g-sub">Opens in Ask all reports — you press send</span></button>`).join("")}</div>
    <div class="g-note">Answers separate sourced facts from labeled interpretation, and every quote is verified against the report text.</div>
  </div>`;
}

// Apply the guide's scope (and optional focus) to Browse and navigate there.
function guideToBrowse(g, extraTopic) {
  const f = {};
  if (g.years.size) f.year = [...g.years];
  if (g.regions.size) f.region = [...g.regions];
  const topics = extraTopic ? [extraTopic] : (g.topics.size ? [...g.topics] : null);
  if (topics) f.topic = topics;
  if (g.focus) {
    if (g.focus.kind === "topic") f.topic = [g.focus.value];
    else f.region = [g.focus.value];
  }
  dashGo(f);
}

/* ───────────────────────── Report View ───────────────────────── */

function showReport(id) {
  const rec = byId(id);
  if (!rec) { location.hash = "#/browse"; return; }
  const changed = state.currentReportId !== id;
  state.currentReportId = id;
  showView("report");
  $("#reportCrumb").textContent = rec.title;
  if (changed) {
    state.reportChat = []; // reset chat state on navigation
    $("#reportChatMsgs").querySelectorAll(".msg").forEach(m => m.remove());
    renderReportCards(rec);
    switchReportTab("text");
    const pane = $("#reportTextPane");
    pane.textContent = "Loading report text…";
    fetchReport(rec.file).then(raw => {
      if (state.currentReportId !== id) return;
      pane.textContent = raw;
      if (state.pendingHighlight) { const q = state.pendingHighlight; state.pendingHighlight = null; highlightQuote(q); }
    }).catch(e => { pane.textContent = "Failed to load report text: " + e.message; });
  } else if (state.pendingHighlight) {
    const q = state.pendingHighlight; state.pendingHighlight = null; highlightQuote(q);
  }
}

function quoteBlock(quote, locator) {
  // Evidence quote: verbatim, serif italic, click → highlight in full text (data-quote holds the raw string).
  return `<blockquote class="q" data-quote="${escHtml(quote)}" title="Click to locate in report text">${escHtml(quote)}</blockquote>
    ${locator ? `<div class="locator">${escHtml(locator)}</div>` : ""}`;
}

function renderReportCards(rec) {
  let html = "";

  // 1. Header
  const kv = [];
  if (rec.report_no) kv.push(["Report no.", rec.report_no]);
  if (rec.date_issued) kv.push(["Date issued", rec.date_issued]);
  if (rec.period_covered) kv.push(["Period covered", rec.period_covered]);
  if (rec.fieldwork) kv.push(["Fieldwork", rec.fieldwork]);
  kv.push(["Type", typeLabel(rec.type) + (rec.region ? " — " + rec.region : "")]);
  const hasActions = (rec.agreed_actions || []).length;
  const hasPractices = (rec.noteworthy_practices || []).length;
  html += `<div class="report-section-nav" aria-label="Report sections">
    <button type="button" class="section-jump" data-report-section="report-summary">Summary</button>
    <button type="button" class="section-jump" data-report-section="report-conclusion">Conclusion</button>
    ${rec.observations.length ? `<button type="button" class="section-jump" data-report-section="report-findings">Findings</button>` : ""}
    ${hasActions ? `<button type="button" class="section-jump" data-report-section="report-actions">Actions</button>` : ""}
    ${hasPractices ? `<button type="button" class="section-jump" data-report-section="report-practices">Practices</button>` : ""}
    <button type="button" class="section-jump" data-report-tab="chat">Ask</button>
  </div>`;
  html += `<div class="card" id="report-summary">
    <h1 class="report-h1">${escHtml(rec.title)}</h1>
    <dl class="kv">${kv.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join("")}</dl>
    ${rec.source_pdf_url ? `<p><a class="link-btn" href="${escHtml(rec.source_pdf_url)}" target="_blank" rel="noopener">Official UNICEF PDF ↗</a></p>` : ""}
    ${rec.redactions ? `<div class="redaction-banner">⚠ This report contains official redactions per UNICEF Executive Board decision — redacted passages are absent from the source text.</div>` : ""}
  </div>`;

  // 2. Overall conclusion
  const oc = rec.overall_conclusion;
  html += `<div class="card" id="report-conclusion"><h2>Overall conclusion</h2>
    <p><span class="badge ${ratingClass(oc.rating)}">${escHtml(oc.rating)}</span></p>
    ${quoteBlock(oc.quote, oc.locator)}</div>`;

  // 3. Key findings — one block per observation
  if (rec.observations.length) {
    html += `<div class="card" id="report-findings"><h2>Key findings — ${rec.observations.length} observations</h2>`;
    for (const o of rec.observations) {
      const badge = o.redacted
        ? `<span class="badge r-info">Redacted</span>`
        : o.rating
          ? `<span class="badge ${ratingClass(o.rating)}">${escHtml(o.rating)}</span>`
          : `<span class="badge r-info">No rating — informational</span>`;
      const tags = [...(o.topics || []).map(t => state.topicLabel[t] || t),
                    ...(o.risks || []).map(r => state.riskLabel[r] || r)];
      html += `<div class="obs-card">
        <div class="obs-head"><span class="obs-n">Obs ${o.n}</span><h3>${escHtml(o.title)}</h3>${badge}</div>
        ${tags.length ? `<div class="obs-tags">${tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join("")}</div>` : ""}
        ${o.redacted
          ? `<div class="redacted-obs">Redacted per Executive Board decision — the observation text is not in the published report.</div>`
          : o.summary_quote ? quoteBlock(o.summary_quote, o.locator) : ""}
      </div>`;
    }
    html += `</div>`;
  }

  // 4. Agreed actions
  if (hasActions) {
    const rows = rec.agreed_actions.map(a => `<tr>
      <td>Obs ${a.observation}</td>
      <td><blockquote class="q" data-quote="${escHtml(a.quote)}" title="Click to locate in report text">${escHtml(a.quote)}</blockquote>
          <div class="locator">${escHtml(a.locator || "")}</div></td>
      <td>${escHtml(a.due || "—")}</td></tr>`).join("");
    html += `<div class="card" id="report-actions"><h2>Agreed actions</h2>
      <table class="actions"><thead><tr><th>Obs</th><th>Action (verbatim excerpt)</th><th>Due</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="table-note">Excerpts — full action lists are in the report text.</div></div>`;
  }

  // 5. Noteworthy practices
  if (hasPractices) {
    html += `<div class="card" id="report-practices"><h2>Noteworthy practices</h2>
      ${rec.noteworthy_practices.map(np => quoteBlock(np.quote, np.locator)).join("")}</div>`;
  }

  $("#reportCards").innerHTML = html;
}

function switchReportTab(tab) {
  $$("#reportTabs .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tab-text").hidden = tab !== "text";
  $("#tab-chat").hidden = tab !== "chat";
}

// Locate `quote` in the current report's raw text, render a <mark>, scroll to it.
function highlightQuote(quote) {
  const rec = byId(state.currentReportId);
  if (!rec) return;
  const raw = state.reportCache.get(rec.file);
  if (raw == null) { state.pendingHighlight = quote; return; } // applied after fetch
  switchReportTab("text");
  const range = findQuoteRange(rec.file, quote);
  const pane = $("#reportTextPane");
  if (!range) {
    pane.textContent = raw;
    return;
  }
  pane.innerHTML = escHtml(raw.slice(0, range.start)) +
    `<mark class="hl">` + escHtml(raw.slice(range.start, range.end)) + `</mark>` +
    escHtml(raw.slice(range.end));
  const mark = pane.querySelector("mark.hl");
  if (mark) mark.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ───────────────────────── Citations ─────────────────────────
 * The model emits {{cite report-id | verbatim quote | locator}} markers.
 * renderAnswer() turns answer text into safe HTML with citation chips;
 * verifyCitations() then checks every quote against the source (A4). */

const CITE_RE = /\{\{cite\s+([^|{}]+?)\s*\|\s*([\s\S]+?)\s*\|\s*([^|{}]*?)\s*\}\}/g;

// During streaming, hold back an unterminated trailing marker so partial
// {{cite … never renders as text.
function stripPartialMarker(text) {
  const i = text.lastIndexOf("{{");
  if (i >= 0 && text.indexOf("}}", i) < 0) return text.slice(0, i);
  return text;
}

// Replace markers with placeholder tokens, registering each citation in citeStore.
function tokenizeCitations(text) {
  return text.replace(CITE_RE, (_, id, quote, locator) => {
    const cid = "c" + (++state.citeSeq);
    state.citeStore.set(cid, { id: id.trim(), quote: quote.trim(), locator: locator.trim() });
    return `\uE000${cid}\uE000`;
  });
}

function citeChipHtml(cid) {
  const c = state.citeStore.get(cid);
  if (!c) return "";
  const rec = byId(c.id);
  const name = rec ? shortName(rec) : c.id;
  const long = c.quote.length > QUOTE_COLLAPSE_LEN;
  const qText = long ? c.quote.slice(0, 160) : c.quote;
  return `<span class="cite pending" data-cid="${escHtml(cid)}">` +
    `<q class="cite-quote${long ? " long collapsed" : ""}" data-cid="${escHtml(cid)}">${escHtml(qText)}</q>` +
    `<span class="cite-src">(<a class="cite-link" data-cid="${escHtml(cid)}" title="Open report at this passage">${escHtml(name)}${c.locator ? " — " + escHtml(c.locator) : ""}</a>` +
    (rec && rec.source_pdf_url ? ` <a class="cite-pdf" href="${escHtml(rec.source_pdf_url)}" target="_blank" rel="noopener" title="Official UNICEF PDF">PDF</a>` : "") +
    `)</span><span class="cite-status"></span></span>`;
}

/* Minimal safe renderer for model answers: everything escaped first, then
 * headings / lists / tables / bold re-introduced. marked is NOT used on model
 * output (untrusted) nor on report bodies (PDF extractions). */
function renderAnswer(text) {
  const tokenized = tokenizeCitations(text);
  const lines = tokenized.split("\n");
  const blocks = [];
  let para = [], list = null, table = null;
  const flush = () => {
    if (para.length) { blocks.push({ t: "p", text: para.join(" ") }); para = []; }
    if (list) { blocks.push(list); list = null; }
    if (table) { blocks.push(table); table = null; }
  };
  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); blocks.push({ t: "h", depth: h[1].length, text: h[2] }); continue; }
    if (/^\|.*\|$/.test(trimmed)) {
      if (para.length || list) flush();
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // separator row
      const cells = trimmed.slice(1, -1).split("|").map(c => c.trim());
      if (!table) table = { t: "table", rows: [] };
      table.rows.push(cells);
      continue;
    }
    const li = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (para.length || table) flush();
      if (!list) list = { t: "ul", items: [] };
      list.items.push(li[1]);
      continue;
    }
    if (list || table) flush();
    para.push(trimmed);
  }
  flush();

  const inline = s => escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\uE000(c\d+)\uE000/g, (_, cid) => citeChipHtml(cid));

  // Sectioning: Facts block (A1 policing) and Synthesis block (A5 labeling).
  let html = "", section = null; // null | 'facts' | 'synthesis'
  const closeSection = () => { if (section) { html += "</div>"; section = null; } };
  for (const b of blocks) {
    if (b.t === "h") {
      const txt = b.text.replace(/\uE000c\d+\uE000/g, "").trim();
      if (/^facts\b/i.test(txt)) {
        closeSection(); section = "facts";
        html += `<div class="facts"><h3>${inline(b.text)}</h3>`;
        continue;
      }
      if (/synthesis/i.test(txt)) {
        closeSection(); section = "synthesis";
        html += `<div class="synthesis"><div class="synthesis-label">Synthesis — interpretation, not from reports</div>`;
        continue;
      }
      if (b.depth <= 2) closeSection();
      html += `<h${Math.min(b.depth + 2, 5)}>${inline(b.text)}</h${Math.min(b.depth + 2, 5)}>`;
    } else if (b.t === "ul") {
      html += `<ul>${b.items.map(i => `<li>${inline(i)}</li>`).join("")}</ul>`;
    } else if (b.t === "table") {
      const [head, ...rest] = b.rows;
      html += `<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rest.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    } else {
      html += `<p>${inline(b.text)}</p>`;
    }
  }
  closeSection();
  return html;
}

/* ───────────────────────── Verification ─────────────────────────
 * A4 backward verification: every rendered citation chip is checked
 * programmatically against the source report text. */

async function verifyCitations(container) {
  const chips = container.querySelectorAll(".cite.pending[data-cid]");
  for (const chip of chips) {
    const c = state.citeStore.get(chip.dataset.cid);
    if (!c) { markChip(chip, false); continue; }
    const rec = byId(c.id);
    if (!rec) { markChip(chip, false); continue; }
    try {
      await fetchReport(rec.file);
      const nm = getNormMap(rec.file);
      const q = normQuote(c.quote);
      const ok = q.length > 0 && (nm.norm.includes(q) || nm.normND.includes(noDigits(q)));
      markChip(chip, ok);
    } catch (e) {
      markChip(chip, false);
    }
  }
}

function markChip(chip, ok) {
  chip.classList.remove("pending");
  chip.classList.add(ok ? "ok" : "bad");
  if (!ok) {
    // Quarantine: visually mute the claim this citation supports (A4).
    const claim = chip.closest("p, li, td");
    if (claim) claim.classList.add("claim-unverified");
  }
}

// A1 policing: inside a Facts block, flag sentences/items with no citation marker.
function flagUncitedClaims(container) {
  for (const el of container.querySelectorAll(".facts p, .facts li")) {
    if (el.querySelector(".cite")) continue;
    const txt = el.textContent.trim();
    if (txt.length < 50) continue; // headers-in-prose, connectives — not factual claims
    el.classList.add("uncited");
    el.title = "Uncited claim — no source citation was provided (rule A1)";
  }
}

async function finalizeAnswer(container, opts) {
  await verifyCitations(container);
  if (!opts || opts.repair !== false) {
    try { await repairCitations(container); } catch (_) { /* best-effort; quarantine stays */ }
  }
  flagUncitedClaims(container);
}

/* Auto-repair (A4 second chance): for each quarantined citation, ask the model —
 * with the source report text attached — for the exact contiguous verbatim passage.
 * A replacement is accepted ONLY if it passes the same programmatic verification;
 * otherwise the quarantine styling stays. One attempt, no recursion. */
const REPAIR_RULES = `You fix citation quotes for Enterprise Document Intelligence. Each numbered item is a citation whose quote FAILED exact verbatim verification against its report file. In the attached report text, find the single CONTIGUOUS verbatim passage that best supports the same point and re-emit the citation.
Output EXACTLY one line per item, in the same order. Each line is either a {{cite REPORT_ID | verbatim quote | locator}} marker — quote copied character-for-character from the attached text, never spliced with "..." — or the single word NONE when no supporting passage exists. No other text, no commentary.`;

async function repairCitations(container) {
  if (!canCallApi()) return;
  const items = [];
  for (const chip of container.querySelectorAll(".cite.bad[data-cid]")) {
    const c = state.citeStore.get(chip.dataset.cid);
    if (c && byId(c.id)) items.push({ chip, c });
  }
  if (!items.length) return;

  // Attach the source text of every implicated report (within one call's budget).
  const blocks = [], included = new Set();
  let chars = 0;
  for (const { c } of items) {
    if (included.has(c.id)) continue;
    const rec = byId(c.id);
    const text = await fetchReport(rec.file);
    if (chars + text.length > BATCH_CHAR_LIMIT) continue;
    chars += text.length;
    included.add(c.id);
    blocks.push({ type: "text", text: `=== REPORT id: ${c.id} ===\n\n${text}` });
  }
  const work = items.filter(({ c }) => included.has(c.id));
  if (!work.length) return;

  const resp = await callClaude({
    system: [{ type: "text", text: REPAIR_RULES }, ...blocks],
    messages: [{ role: "user", content: "Failed citations:\n" + work.map(({ c }, i) =>
      `${i + 1}. {{cite ${c.id} | ${c.quote} | ${c.locator}}}`).join("\n") }],
    maxTokens: 2500,
  });

  const lines = resp.split("\n").map(l => l.trim())
    .filter(l => l.includes("{{cite") || /^(\d+[.)]\s*)?NONE$/.test(l));
  for (let i = 0; i < work.length && i < lines.length; i++) {
    const m = new RegExp(CITE_RE.source).exec(lines[i]);
    if (!m) continue; // NONE or unparseable → quarantine stays
    const id = m[1].trim(), quote = m[2].trim(), locator = m[3].trim();
    if (id !== work[i].c.id || !byId(id)) continue;
    const nm = getNormMap(byId(id).file);
    const q = normQuote(quote);
    if (!q || !(nm.norm.includes(q) || nm.normND.includes(noDigits(q)))) continue; // still unverifiable
    // Verified replacement — update the store and swap the chip in place.
    const cid = work[i].chip.dataset.cid;
    state.citeStore.set(cid, { id, quote, locator: locator || work[i].c.locator });
    const tmp = document.createElement("span");
    tmp.innerHTML = citeChipHtml(cid);
    const fresh = tmp.firstElementChild;
    const claim = work[i].chip.closest("p, li, td");
    work[i].chip.replaceWith(fresh);
    markChip(fresh, true);
    fresh.title = "Quote auto-corrected to the exact source wording (verified)";
    if (claim && !claim.querySelector(".cite.bad")) claim.classList.remove("claim-unverified");
  }
}

/* ───────────────────────── Chat (single report) ───────────────────────── */

const ACCURACY_RULES = `You are the analysis assistant inside Enterprise Document Intelligence, a public-data demonstration where an enterprise user reads UNICEF OIAI internal audit reports. You answer ONLY from the report text provided in this conversation. These rules are absolute:

1. NO SOURCE = NOT USED. Every factual claim must end with a citation marker in EXACTLY this format: {{cite REPORT_ID | verbatim quote | locator}}. The quote must be ONE contiguous passage copied character-for-character from the report text provided in THIS conversation — do not fix typos, do not translate, do not clean up the broken spacing that comes from PDF extraction (e.g. "o bservations" stays as-is). NEVER splice a quote with "..." or omit words from its middle — if you need two passages, emit two separate markers. Never quote from memory or general knowledge: if you cannot see the passage in the provided text, the claim does not exist. The locator names the section or observation, e.g. "Observation 2" or "Executive Summary — Overall conclusion". A claim you cannot cite must be deleted, not hedged. Every quote is programmatically checked against the source file; a quote that is not an exact contiguous copy will be publicly flagged as unverified.
2. NEVER GUESS. Never use outside knowledge, general audit knowledge, or estimates. Never state a number that is not written in the report text.
3. QUANTIFY, DON'T CHARACTERIZE. Write "3 of 12 sampled visits lacked evidence {{cite ...}}", never "many visits had issues".
4. NEVER RE-RATE OR ADVISE. Ratings and conclusions are OIAI's, quoted verbatim. Do not assign your own ratings and do not recommend actions beyond what the reports state.
5. Keep quotes reasonably short (the key sentence or phrase, not whole paragraphs) but always verbatim and long enough to be unambiguous.
6. Facts and your own interpretation must never be mixed in one paragraph.`;

function reportChatSystem(rec, reportText) {
  return [
    { type: "text", text: ACCURACY_RULES + `

You are answering about ONE report. Its REPORT_ID for citation markers is exactly: ${rec.id}
If the report does not contain the answer, reply exactly: Not covered in this report.
You may then add one short sentence naming related sections the report DOES cover. Never answer from outside this report.`,
      cache_control: { type: "ephemeral" } },
    { type: "text", text: `FULL REPORT TEXT (id: ${rec.id}):\n\n${reportText}`,
      cache_control: { type: "ephemeral" } },
    { type: "text", text: `VERIFIED INDEX RECORD (metadata for this report):\n${JSON.stringify(rec, null, 1)}`,
      cache_control: { type: "ephemeral" } },
  ];
}

async function askReport(question) {
  const rec = byId(state.currentReportId);
  if (!rec || state.busy) return;
  if (!requireApiKey()) return;
  setBusy(true);
  const msgs = $("#reportChatMsgs");
  appendMsg(msgs, "user", question);
  state.reportChat.push({ role: "user", content: question });
  const el = appendMsg(msgs, "assistant", "");
  el.classList.add("cursor-blink");
  try {
    const reportText = await fetchReport(rec.file);
    const turns = state.reportChat.slice(-MAX_CHAT_TURNS);
    const full = await streamClaude({
      system: reportChatSystem(rec, reportText),
      messages: turns,
      maxTokens: 3000,
      onDelta: t => { el.innerHTML = renderAnswer(stripPartialMarker(t)); msgs.scrollTop = msgs.scrollHeight; },
    });
    state.reportChat.push({ role: "assistant", content: full });
    el.classList.remove("cursor-blink");
    el.innerHTML = renderAnswer(full);
    await finalizeAnswer(el);
  } catch (e) {
    el.classList.remove("cursor-blink");
    el.classList.add("error");
    el.textContent = "Request failed: " + e.message;
    state.reportChat.pop(); // keep history consistent on failure
  } finally {
    setBusy(false);
    msgs.scrollTop = msgs.scrollHeight;
  }
}

/* ───────────────────────── Routing (repository-wide chat) ───────────────────────── */

function buildSlimIndex() {
  if (state.slimIndex) return state.slimIndex;
  const slim = state.index.map(r => ({
    id: r.id, title: r.title, year: r.year, type: r.type, region: r.region || null,
    overall_rating: r.overall_conclusion.rating,
    observations: r.observations.map(o => ({
      n: o.n, title: o.title, rating: o.rating || null,
      topics: o.topics || [], risks: o.risks || [],
      ...(o.redacted ? { redacted: true } : {}), ...(o.informational ? { informational: true } : {}),
    })),
  }));
  state.slimIndex = JSON.stringify(slim);
  return state.slimIndex;
}

function routerSystem() {
  const topicIds = state.vocab.topics.map(t => `${t.id} (${t.label})`).join(", ");
  const riskIds = state.vocab.risks.map(r => `${r.id} (${r.label})`).join(", ");
  return [
    { type: "text", text: `You are the ROUTING stage of Enterprise Document Intelligence. You receive a question about a repository of UNICEF OIAI audit reports plus the verified index of all reports. Decide which reports are needed and whether the question is answerable as a count/list straight from index fields.

Return STRICT JSON only — no markdown fences, no commentary — with exactly this shape:
{"relevant_report_ids": string[], "computable_from_index": boolean, "facet_query": object|null, "reason": string}

- relevant_report_ids: ids of reports whose FULL TEXT is genuinely needed to answer. Be selective (each report is long). Empty array if the question is outside the repository's scope (then say so in reason) or fully answerable from the index alone.
- computable_from_index: true when the question is a count or list filterable by index fields (year, type, region, overall rating, observation rating, topics, risks).
- facet_query: when computable_from_index, the filter (arrays; empty array = no constraint):
  {"year": number[], "type": string[], "region": string[], "conclusion": string[], "topics": string[], "risks": string[], "obs_rating": string[]}
  type ∈ country_office|thematic|regional. obs_rating ∈ High|Medium. conclusion uses the full official wording.
  topics must use vocabulary ids: ${topicIds}
  risks must use vocabulary ids: ${riskIds}
- Natural-language domain terms are recall-oriented. If a broad user phrase plausibly maps to both a topic and a risk, include both. The app will compute the exact query first and, when that is empty, show related results with a visible caveat unless the user explicitly asked for an intersection.
- For questions needing report content (what was found, why, details, comparisons of wording), also list the relevant_report_ids — the index alone has no narrative.

THE VERIFIED INDEX:
${buildSlimIndex()}`,
      cache_control: { type: "ephemeral" } },
  ];
}

function parseRouterJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("router returned no JSON");
  const obj = JSON.parse(text.slice(start, end + 1));
  return {
    ids: Array.isArray(obj.relevant_report_ids) ? obj.relevant_report_ids.filter(id => byId(id)) : [],
    computable: !!obj.computable_from_index,
    facetQuery: obj.facet_query && typeof obj.facet_query === "object" ? obj.facet_query : null,
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
}

// A6: counts/lists by facet are computed HERE, in JS, from the verified index —
// the model formats, it does not count.
function computeFacetQuery(fq) {
  const arr = v => Array.isArray(v) ? v : [];
  const years = new Set(arr(fq.year).map(Number));
  const types = new Set(arr(fq.type));
  const regions = new Set(arr(fq.region));
  const conclusions = new Set(arr(fq.conclusion));
  const topics = new Set(arr(fq.topics));
  const risks = new Set(arr(fq.risks));
  const obsRatings = new Set(arr(fq.obs_rating));
  const obsLevel = topics.size || risks.size || obsRatings.size;

  const rows = [];
  for (const rec of state.index) {
    if (years.size && !years.has(rec.year)) continue;
    if (types.size && !types.has(rec.type)) continue;
    if (regions.size && !(rec.region && regions.has(rec.region))) continue;
    if (conclusions.size && !conclusions.has(rec.overall_conclusion.rating)) continue;
    if (!obsLevel) { rows.push({ rec, obs: null }); continue; }
    for (const o of rec.observations) {
      if (topics.size && !(o.topics || []).some(t => topics.has(t))) continue;
      if (risks.size && !(o.risks || []).some(r => risks.has(r))) continue;
      if (obsRatings.size && !(o.rating && obsRatings.has(o.rating))) continue;
      rows.push({ rec, obs: o });
    }
  }
  return { rows, obsLevel: !!obsLevel };
}

function exactOnlyQuestion(question) {
  return /\b(strict|strictly|only|both|intersection|intersect|simultaneously|and logic|all selected|all of)\b/i.test(question);
}

function topicRiskOrQuestion(question) {
  return /\b(or logic|any of|either|topic OR risk|topics OR risks|related to any)\b/i.test(question);
}

function rowKey(row) {
  return row.obs ? `${row.rec.id}|${row.obs.n}` : row.rec.id;
}

function unionResults(results) {
  const byKey = new Map();
  for (const result of results) {
    for (const row of result.rows) byKey.set(rowKey(row), row);
  }
  return { rows: [...byKey.values()], obsLevel: results.some(r => r.obsLevel) };
}

function facetConstraints(fq) {
  return Object.entries(fq)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => `${k}: ${v.join(" | ")}`).join(" · ");
}

function broadenZeroFacetQuery(fq, question) {
  const arr = v => Array.isArray(v) ? v : [];
  if (exactOnlyQuestion(question)) return null;

  const hasTopics = arr(fq.topics).length;
  const hasRisks = arr(fq.risks).length;
  const hasObsRating = arr(fq.obs_rating).length;
  const hasYears = arr(fq.year).length;

  if (hasTopics && hasRisks) {
    const result = unionResults([
      computeFacetQuery({ ...fq, risks: [] }),
      computeFacetQuery({ ...fq, topics: [] }),
    ]);
    if (result.rows.length) {
      return {
        result,
        queryLabel: `${facetConstraints({ ...fq, topics: [], risks: [] }) || "no constraints"} · topics OR risks: ${[...arr(fq.topics), ...arr(fq.risks)].join(" | ")}`,
        note: "The exact topic+risk intersection had no matches. Because the question is phrased broadly, the app is showing related observations that match either the selected topic or the selected risk.",
      };
    }
  }

  if (hasObsRating && (hasTopics || hasRisks)) {
    const relaxed = { ...fq, obs_rating: [] };
    const result = computeFacetQuery(relaxed);
    if (result.rows.length) {
      return {
        result,
        queryLabel: facetConstraints(relaxed),
        note: "The exact observation-rating filter had no matches. The app is showing related observations regardless of rating so the absence is visible instead of hidden.",
      };
    }
  }

  if (hasYears && (hasTopics || hasRisks)) {
    const base = { ...fq, year: [] };
    const result = hasTopics && hasRisks
      ? unionResults([
        computeFacetQuery({ ...base, risks: [] }),
        computeFacetQuery({ ...base, topics: [] }),
      ])
      : computeFacetQuery(base);
    if (result.rows.length) {
      return {
        result,
        queryLabel: hasTopics && hasRisks
          ? `${facetConstraints({ ...base, topics: [], risks: [] }) || "no constraints"} · topics OR risks: ${[...arr(fq.topics), ...arr(fq.risks)].join(" | ")}`
          : facetConstraints(base),
        note: "The exact year-scoped query had no matches. The app is showing related observations from other years as context, not as matches for the requested year.",
      };
    }
  }

  return null;
}

function topicRiskOrQuery(fq, question) {
  const arr = v => Array.isArray(v) ? v : [];
  if (!arr(fq.topics).length || !arr(fq.risks).length) return null;
  if (!topicRiskOrQuestion(question) || exactOnlyQuestion(question)) return null;
  const result = unionResults([
    computeFacetQuery({ ...fq, risks: [] }),
    computeFacetQuery({ ...fq, topics: [] }),
  ]);
  if (!result.rows.length) return null;
  return {
    result,
    queryLabel: `${facetConstraints({ ...fq, topics: [], risks: [] }) || "no constraints"} · topics OR risks: ${[...arr(fq.topics), ...arr(fq.risks)].join(" | ")}`,
    note: "The question asks for OR logic across topic/risk categories, so the app is showing observations that match either the selected topic or the selected risk.",
  };
}

function restrictResultToScope(result, scopeIds) {
  if (!scopeIds || !scopeIds.size) return result;
  return { ...result, rows: result.rows.filter(row => scopeIds.has(row.rec.id)) };
}

function facetResultHtml(result, fq, note = null, exactFq = null, queryLabel = null) {
  const { rows, obsLevel } = result;
  const constraints = queryLabel || facetConstraints(fq);
  if (!rows.length) {
    return `<div class="index-table-wrap"><div class="index-table-caption">Verified index query (${escHtml(constraints || "no constraints")}) → <strong>0 matches</strong>.</div></div>`;
  }
  let table;
  if (obsLevel) {
    table = `<table class="index-table"><thead><tr><th>Report</th><th>Year</th><th>Obs</th><th>Observation</th><th>Rating</th></tr></thead><tbody>` +
      rows.map(({ rec, obs }) => `<tr>
        <td><a class="cite-link" href="#/report/${encodeURIComponent(rec.id)}">${escHtml(shortName(rec))}</a></td>
        <td>${rec.year}</td><td>${obs.n}</td><td>${escHtml(obs.title)}</td>
        <td>${obs.rating ? `<span class="badge ${ratingClass(obs.rating)}">${escHtml(obs.rating)}</span>` : `<span class="badge r-info">${obs.redacted ? "Redacted" : "Informational"}</span>`}</td></tr>`).join("") +
      `</tbody></table>`;
  } else {
    table = `<table class="index-table"><thead><tr><th>Report</th><th>Year</th><th>Type</th><th>Overall conclusion</th></tr></thead><tbody>` +
      rows.map(({ rec }) => `<tr>
        <td><a class="cite-link" href="#/report/${encodeURIComponent(rec.id)}">${escHtml(shortName(rec))}</a></td>
        <td>${rec.year}</td><td>${escHtml(typeLabel(rec.type))}</td>
        <td><span class="badge ${ratingClass(rec.overall_conclusion.rating)}">${escHtml(ratingShort(rec.overall_conclusion.rating))}</span></td></tr>`).join("") +
      `</tbody></table>`;
  }
  const caption = exactFq
    ? `Exact verified index query (${escHtml(facetConstraints(exactFq) || "no constraints")}) → <strong>0 matches</strong>. Related index query (${escHtml(constraints || "no constraints")}) → <strong>${rows.length} ${obsLevel ? "observations" : "reports"}</strong>.`
    : `Verified index query (${escHtml(constraints || "no constraints")}) →
    <strong>${rows.length} ${obsLevel ? "observations" : "reports"}</strong>. Computed in-app from the verified index, not by the model.`;
  return `<div class="index-table-wrap">
    <div class="index-table-caption">${caption}</div>
    ${note ? `<div class="index-table-caption">${escHtml(note)}</div>` : ""}
    ${table}</div>`;
}

function facetResultForModel(result, note = null) {
  // Compact, citable summary of the locally-computed result, given to the answer stage.
  // Each row carries its verbatim summary quote + locator so the model can emit
  // citations that pass backward verification (A4) even without full report text.
  const { rows, obsLevel } = result;
  const lines = rows.slice(0, 80).map(({ rec, obs }) =>
    obsLevel ? `- ${rec.id} (${rec.year}) Obs ${obs.n}: ${obs.title} [${obs.rating || (obs.redacted ? "redacted" : "informational")}]` +
               (obs.summary_quote ? `\n  verbatim quote: ${obs.summary_quote}\n  locator: ${obs.locator}` : "")
             : `- ${rec.id} (${rec.year}): ${rec.overall_conclusion.rating}` +
               `\n  verbatim quote: ${rec.overall_conclusion.quote}\n  locator: ${rec.overall_conclusion.locator}`);
  return `VERIFIED INDEX DATA (computed in-app from the verified index — use these exact counts and items; do NOT recount or extend):
${note ? `Query note: ${note}\n` : ""}
Total: ${rows.length} ${obsLevel ? "observations" : "reports"} match.
${lines.join("\n")}${rows.length > 80 ? `\n…and ${rows.length - 80} more (already counted in the total).` : ""}

When citing an item from this list, copy its "verbatim quote" field EXACTLY as the citation quote, with the given locator. Do not write any quote that is not either in this list or in an attached === REPORT === block.`;
}

/* ───────────────────────── Chat (repository-wide) ───────────────────────── */

const REPO_ANSWER_CONTRACT = `
OUTPUT FORMAT (mandatory):
## Facts
Organized per report/year. EVERY claim ends with a {{cite report-id | verbatim quote | locator}} marker using the correct report id as given in the report headers below. Quote ONLY from the attached === REPORT === blocks or from the "verbatim quote" fields of the VERIFIED INDEX DATA — never from memory. Where reports disagree, present both sides with both citations — never average, never pick one (contradictions are data).
## Synthesis — interpretation, not from reports
Optional second section: a short plain-language reading of the facts above, phrased as orientation, not verdict. No new factual claims here, no citations needed here.

If nothing in the provided material answers the question, output ONLY this single line and nothing else: Not covered in the reports in scope.`;

function repoAnswerSystem(reportBlocks, indexDataNote) {
  const blocks = [
    { type: "text", text: ACCURACY_RULES + "\n" + REPO_ANSWER_CONTRACT, cache_control: { type: "ephemeral" } },
  ];
  if (indexDataNote) blocks.push({ type: "text", text: indexDataNote });
  for (const b of reportBlocks) blocks.push(b);
  if (blocks.length > 1) blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return blocks;
}

function trailStep(trail, label) {
  const div = document.createElement("div");
  div.className = "trail-step run";
  div.innerHTML = `<span class="ico">…</span><span class="lbl">${escHtml(label)}</span> <span class="trail-detail"></span>`;
  trail.appendChild(div);
  return {
    el: div,
    detail(t) { div.querySelector(".trail-detail").textContent = t; },
    done(t) { div.className = "trail-step done"; div.querySelector(".ico").textContent = "✓"; if (t) this.detail(t); },
    fail(t) { div.className = "trail-step fail"; div.querySelector(".ico").textContent = "✗"; if (t) this.detail(t); },
  };
}

async function askRepository(question) {
  if (state.busy) return;
  if (!requireApiKey()) return;
  setBusy(true);
  const msgs = $("#repoChatMsgs");
  appendMsg(msgs, "user", question);
  updateRepoAskEmpty();
  state.repoChat.push({ role: "user", content: question });

  const wrap = appendMsg(msgs, "assistant", "");
  const trail = document.createElement("div");
  trail.className = "trail";
  wrap.appendChild(trail);
  const indexBox = document.createElement("div"); // locally-computed index tables — never overwritten by streaming
  wrap.appendChild(indexBox);
  const body = document.createElement("div");
  wrap.appendChild(body);
  const scroll = () => { msgs.scrollTop = msgs.scrollHeight; };

  try {
    const scope = state.repoScope;
    const scopeIds = scope && scope.ids && scope.ids.length ? new Set(scope.ids) : null;
    // ── Stage 1: route ──
    const s1 = trailStep(trail, "Routing — selecting relevant reports from the index");
    scroll();
    // Give the router short conversational context for follow-up questions.
    const prior = state.repoChat.slice(-5, -1).map(m => `${m.role}: ${m.content.slice(0, 500)}`).join("\n");
    const scopeText = scopeIds
      ? `Browse scope (hard limit): answer only from these ${scope.ids.length} selected report ids: ${scope.ids.join(", ")}. Scope label: ${scope.label}.\n\n`
      : "";
    const routerUser = (prior ? `Conversation so far (for context):\n${prior}\n\n` : "") + scopeText + `Question: ${question}`;
    const routeText = await callClaude({
      system: routerSystem(),
      messages: [{ role: "user", content: routerUser }],
      maxTokens: 1500,
    });
    let routing;
    try { routing = parseRouterJson(routeText); }
    catch (e) { s1.fail("could not parse routing decision"); throw new Error("Routing stage returned unparseable output. Please retry."); }
    if (scopeIds && routing.ids.length) routing.ids = routing.ids.filter(id => scopeIds.has(id));
    if (scopeIds && !routing.ids.length && !routing.computable) routing.ids = scope.ids.slice();
    s1.done(routing.ids.length ? `${routing.ids.length} report(s) selected` : "no report text needed");

    // ── Stage 2: compute locally what is computable (A6) ──
    let indexDataNote = null;
    if (routing.computable && routing.facetQuery) {
      let result = computeFacetQuery(routing.facetQuery);
      let resultNote = null;
      let displayQuery = routing.facetQuery;
      let exactQuery = null;
      let queryLabel = null;
      const forcedOr = topicRiskOrQuery(routing.facetQuery, question);
      if (forcedOr) {
        result = forcedOr.result;
        resultNote = forcedOr.note;
        exactQuery = routing.facetQuery;
        queryLabel = forcedOr.queryLabel;
      }
      if (!result.rows.length) {
        const broadened = broadenZeroFacetQuery(routing.facetQuery, question);
        if (broadened) {
          result = broadened.result;
          resultNote = broadened.note;
          displayQuery = routing.facetQuery;
          exactQuery = routing.facetQuery;
          queryLabel = broadened.queryLabel;
        }
      }
      result = restrictResultToScope(result, scopeIds);
      const s2 = trailStep(trail, "Computing exact counts from the verified index");
      indexBox.insertAdjacentHTML("beforeend", facetResultHtml(result, displayQuery, resultNote, exactQuery, queryLabel));
      // 0 rows = nothing citable; a null note lets the A3 short-circuit below fire
      // instead of sending the model an empty list it can only hallucinate around.
      indexDataNote = result.rows.length ? facetResultForModel(result, resultNote) : null;
      s2.done(`${result.rows.length} match(es)`);
      scroll();
    }

    // Nothing relevant at all → A3, skip reading.
    if (!routing.ids.length && !indexDataNote) {
      body.insertAdjacentHTML("beforeend", `<p>Not covered in the reports in scope.</p>` +
        (routing.reason ? `<p class="locator">${escHtml(routing.reason)}</p>` : ""));
      state.repoChat.push({ role: "assistant", content: "Not covered in the reports in scope." });
      return;
    }

    // ── Stage 3: read selected reports ──
    let ids = routing.ids;
    if (ids.length > MAX_READ_REPORTS) {
      appendMsg(msgs, "notice",
        `Routing selected ${ids.length} reports; reading the first ${MAX_READ_REPORTS} to stay within context limits. Narrow the question (e.g. by year or region) for full coverage.`);
      ids = ids.slice(0, MAX_READ_REPORTS);
    }
    let answer;
    if (ids.length) {
      const s3 = trailStep(trail, `Reading ${ids.length} report(s)`);
      scroll();
      const texts = [];
      for (const id of ids) {
        const rec = byId(id);
        s3.detail(shortName(rec));
        texts.push({ rec, text: await fetchReport(rec.file) });
      }
      s3.done(texts.map(t => shortName(t.rec)).join(" · "));

      // Batch when the combined text is too large for one call.
      const totalChars = texts.reduce((s, t) => s + t.text.length, 0);
      const batches = [];
      if (totalChars > BATCH_CHAR_LIMIT || texts.length > BATCH_REPORT_LIMIT) {
        let cur = [], curChars = 0;
        for (const t of texts) {
          if (cur.length && (cur.length >= BATCH_REPORT_LIMIT || curChars + t.text.length > BATCH_CHAR_LIMIT)) {
            batches.push(cur); cur = []; curChars = 0;
          }
          cur.push(t); curChars += t.text.length;
        }
        if (cur.length) batches.push(cur);
      } else {
        batches.push(texts);
      }

      const blockFor = t => ({ type: "text", text: `=== REPORT id: ${t.rec.id} | ${t.rec.title} ===\n\n${t.text}` });
      const s4 = trailStep(trail, batches.length > 1
        ? `Answering — ${batches.length} batches, then merging`
        : "Answering from report text");
      scroll();

      if (batches.length === 1) {
        answer = await streamClaude({
          system: repoAnswerSystem(batches[0].map(blockFor), indexDataNote),
          messages: [{ role: "user", content: question }],
          maxTokens: 4000,
          onDelta: t => { body.innerHTML = renderAnswer(stripPartialMarker(t)); scroll(); },
        });
      } else {
        const parts = [];
        for (let i = 0; i < batches.length; i++) {
          s4.detail(`batch ${i + 1} of ${batches.length}`);
          parts.push(await callClaude({
            system: repoAnswerSystem(batches[i].map(blockFor), indexDataNote),
            messages: [{ role: "user", content:
              `Extract ALL facts from the attached reports that are relevant to this question, as a bullet list. Every bullet ends with a {{cite ...}} marker. No synthesis, no introduction. If nothing is relevant in these reports, output exactly: (nothing relevant in this batch)\n\nQuestion: ${question}` }],
            maxTokens: 4000,
          }));
        }
        s4.detail("merging batch results");
        answer = await streamClaude({
          system: [{ type: "text", text: ACCURACY_RULES + "\n" + REPO_ANSWER_CONTRACT + `

You are the MERGE stage. The fact lists below were extracted from the reports, with verified citation markers. Compose the final answer ONLY by reorganizing these facts — never add facts, numbers or citations that are not in the lists. Keep every {{cite ...}} marker exactly as written.` }],
          messages: [{ role: "user", content:
            (indexDataNote ? indexDataNote + "\n\n" : "") +
            `Question: ${question}\n\nExtracted facts:\n\n` + parts.map((p, i) => `--- batch ${i + 1} ---\n${p}`).join("\n\n") }],
          maxTokens: 4000,
          onDelta: t => { body.innerHTML = renderAnswer(stripPartialMarker(t)); scroll(); },
        });
      }
      s4.done();
      body.innerHTML = renderAnswer(answer);
      await finalizeAnswer(body);
    } else {
      // Index-only answer: have the model narrate the computed table (it formats, it doesn't count).
      const s4 = trailStep(trail, "Answering from the verified index");
      answer = await streamClaude({
        system: repoAnswerSystem([], indexDataNote),
        messages: [{ role: "user", content: question }],
        maxTokens: 1500,
        onDelta: t => { body.innerHTML = renderAnswer(stripPartialMarker(t)); scroll(); },
      });
      s4.done();
      body.innerHTML = renderAnswer(answer);
      await finalizeAnswer(body);
    }
    state.repoChat.push({ role: "assistant", content: answer });
  } catch (e) {
    const err = document.createElement("div");
    err.className = "msg error";
    err.textContent = "Request failed: " + e.message;
    body.appendChild(err);
    if (state.repoChat[state.repoChat.length - 1]?.role === "user") state.repoChat.pop();
  } finally {
    setBusy(false);
    scroll();
  }
}

/* ───────────────────────── Model API (Claude / local / built-in proxy) ─────────────────────────
 * Three providers behind one {system, messages, maxTokens} interface:
 *   "anthropic" — Claude cloud with a user-provided Anthropic key.
 *   "openai"    — any OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM …) for
 *                 local / on-prem demos. System blocks are flattened into one
 *                 role:"system" message; cache_control is dropped (no caching).
 *   "proxy"     — built-in hosted demo proxy. No browser key; request body stays
 *                 Anthropic-compatible and the server injects its own limited key.
 * Every response's exact `usage` token counts are accumulated (see Usage meter)
 * so cloud cost vs. local savings can be shown from real numbers, not estimates. */

function getProvider() {
  const p = localStorage.getItem("cao_provider");
  return ["anthropic", "openai", "proxy"].includes(p) ? p : "proxy";
}

function getApiKey() {
  return localStorage.getItem("cao_api_key") || (window.CONFIG && window.CONFIG.apiKey) || "";
}

function getLocalUrl() {
  return localStorage.getItem("cao_local_url") || "http://localhost:11434/v1/chat/completions";
}

function getLocalModel() {
  return localStorage.getItem("cao_local_model") || "";
}

function getLocalKey() {
  return localStorage.getItem("cao_local_key") || "";
}

function getProxyUrl() {
  return localStorage.getItem("cao_proxy_url") || (window.CONFIG && window.CONFIG.proxyUrl) || DEFAULT_PROXY_URL;
}

// Provider-aware readiness: Claude needs a key; local needs a model name; proxy is keyless.
function canCallApi() {
  const p = getProvider();
  if (p === "openai") return !!getLocalModel();
  if (p === "proxy") return !!getProxyUrl();
  return !!getApiKey();
}

function requireApiKey() {
  if (canCallApi()) return true;
  openSettings();
  return false;
}

function apiHeaders() {
  const provider = getProvider();
  if (provider === "openai") {
    const h = { "content-type": "application/json" };
    if (getLocalKey()) h["authorization"] = "Bearer " + getLocalKey();
    return h;
  }
  if (provider === "proxy") return { "content-type": "application/json" };
  return {
    "content-type": "application/json",
    "x-api-key": getApiKey(),
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function apiError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j.error && j.error.message) msg += ` — ${j.error.message}`;
  } catch (_) { /* body not JSON */ }
  return new Error(msg);
}

/* Rate-limit handling: 429 (and 529/5xx) are retried with the server's
 * retry-after when readable, else exponential backoff capped at the 60s
 * TPM window. A countdown toast keeps the wait visible — without it a
 * 30s+ pause looks like a frozen app. */
const API_MAX_RETRIES = 3;

function apiToast(msg) {
  let el = $("#apiToast");
  if (!msg) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "apiToast";
    el.className = "api-toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
}

function retryDelayMs(res, attempt) {
  const ra = Number(res.headers.get("retry-after")); // may be CORS-hidden → NaN
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra, 90) * 1000;
  return Math.min(15 * 2 ** attempt, 60) * 1000; // 15s → 30s → 60s
}

async function waitWithCountdown(ms, label) {
  for (let left = Math.ceil(ms / 1000); left > 0; left--) {
    apiToast(`${label} — retrying in ${left}s…`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function apiFetch(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(apiUrl(), { method: "POST", headers: apiHeaders(), body });
    if (res.ok) { apiToast(null); return res; }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= API_MAX_RETRIES) { apiToast(null); throw await apiError(res); }
    const label = res.status === 429
      ? `Rate limit reached (attempt ${attempt + 1} of ${API_MAX_RETRIES})`
      : `API unavailable, HTTP ${res.status} (attempt ${attempt + 1} of ${API_MAX_RETRIES})`;
    await waitWithCountdown(retryDelayMs(res, attempt), label);
  }
}

// Anthropic system blocks → one OpenAI system message (text joined, cache_control dropped).
function flattenSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter(b => b.type === "text").map(b => b.text).join("\n\n");
}

function apiBody({ system, messages, maxTokens, stream }) {
  const provider = getProvider();
  if (provider === "openai") {
    const sys = flattenSystem(system);
    return JSON.stringify({
      model: getLocalModel(),
      max_tokens: maxTokens || 2000,
      messages: [...(sys ? [{ role: "system", content: sys }] : []), ...messages],
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }
  return JSON.stringify({ model: MODEL_ID, max_tokens: maxTokens || 2000, system, messages,
    ...(stream ? { stream: true } : {}) });
}

function apiUrl() {
  const provider = getProvider();
  if (provider === "openai") return getLocalUrl();
  if (provider === "proxy") return getProxyUrl();
  return API_URL;
}

async function callClaude({ system, messages, maxTokens }) {
  const res = await apiFetch(apiBody({ system, messages, maxTokens }));
  const data = await res.json();
  if (getProvider() === "openai") {
    recordUsage(openaiUsage(data.usage));
    return (data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content) || "";
  }
  recordUsage(anthropicUsage(data.usage));
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

async function streamClaude({ system, messages, maxTokens, onDelta }) {
  const res = await apiFetch(apiBody({ system, messages, maxTokens, stream: true }));
  const openai = getProvider() === "openai";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  const u = { in: 0, out: 0, cw: 0, cr: 0 }; // usage gathered across stream events
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (_) { continue; }
      if (openai) {
        const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (delta && typeof delta.content === "string") {
          full += delta.content;
          if (onDelta) onDelta(full);
        }
        if (ev.usage) { // final chunk (stream_options.include_usage)
          u.in = ev.usage.prompt_tokens || 0;
          u.out = ev.usage.completion_tokens || 0;
        }
      } else if (ev.type === "message_start" && ev.message && ev.message.usage) {
        const mu = ev.message.usage;
        u.in = mu.input_tokens || 0;
        u.cw = mu.cache_creation_input_tokens || 0;
        u.cr = mu.cache_read_input_tokens || 0;
      } else if (ev.type === "message_delta" && ev.usage) {
        u.out = ev.usage.output_tokens || 0; // cumulative; last event wins
      } else if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta.text === "string") {
        full += ev.delta.text;
        if (onDelta) onDelta(full);
      } else if (ev.type === "error") {
        throw new Error(ev.error && ev.error.message || "stream error");
      }
    }
  }
  recordUsage(u);
  return full;
}

/* ───────────────────────── Usage meter ─────────────────────────
 * Real token counts from API `usage` fields, accumulated per provider in
 * localStorage. Cloud cost is computed at claude-sonnet-4-6 list prices; for
 * the local provider the same formula = money that traffic would have cost on
 * Claude (the "saved" figure). USD per 1M tokens. */
const PRICING = { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 };

function anthropicUsage(usage) {
  if (!usage) return { in: 0, out: 0, cw: 0, cr: 0 };
  return {
    in: usage.input_tokens || 0,
    out: usage.output_tokens || 0,
    cw: usage.cache_creation_input_tokens || 0,
    cr: usage.cache_read_input_tokens || 0,
  };
}

function openaiUsage(usage) {
  if (!usage) return { in: 0, out: 0, cw: 0, cr: 0 };
  return { in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, cw: 0, cr: 0 };
}

function loadUsage() {
  let u;
  try { u = JSON.parse(localStorage.getItem("cao_usage") || "{}"); } catch (_) { u = {}; }
  for (const p of ["anthropic", "openai", "proxy"]) {
    if (!u[p]) u[p] = { calls: 0, in: 0, out: 0, cw: 0, cr: 0 };
  }
  return u;
}

function recordUsage(tokens) {
  const all = loadUsage();
  const u = all[getProvider()];
  u.calls += 1;
  u.in += tokens.in; u.out += tokens.out; u.cw += tokens.cw; u.cr += tokens.cr;
  localStorage.setItem("cao_usage", JSON.stringify(all));
}

// What this traffic costs (cloud) / would have cost (local) at Claude prices.
function cloudCostUsd(u) {
  return (u.in * PRICING.input + u.out * PRICING.output
        + u.cw * PRICING.cacheWrite + u.cr * PRICING.cacheRead) / 1e6;
}

function fmtTokens(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}

/* ───────────────────────── UI State ───────────────────────── */

function showView(name) {
  for (const v of ["home", "browse", "report", "ask", "dash", "guide"]) $(`#view-${v}`).hidden = v !== name;
  $$(".nav-btn[data-nav]").forEach(b =>
    b.classList.toggle("active", b.dataset.nav === name || (name === "report" && b.dataset.nav === "browse")));
  $("#brandSub").textContent = name === "home" ? "portfolio hub" : state.brandStats;
  if (name !== "browse" && $("#facetDrawer").classList.contains("open")) toggleFacets(false, false);
}

function setBusy(b) {
  state.busy = b;
  $("#reportChatSend").disabled = b;
  $("#repoChatSend").disabled = b;
}

function appendMsg(container, role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (text) div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function updateRepoAskEmpty() {
  const empty = $("#repoAskEmpty");
  if (!empty) return;
  empty.hidden = $$("#repoChatMsgs .msg").length > 0;
}

function updateRepoScopeNotice() {
  const el = $("#repoScopeNotice");
  if (!el) return;
  const scope = state.repoScope;
  if (!scope || !scope.ids || !scope.ids.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const unit = scope.ids.length === 1 ? "report" : "reports";
  el.hidden = false;
  el.innerHTML = `<strong>Scope:</strong> ${escHtml(scope.label)} · ${scope.ids.length} ${unit}
    <button type="button" class="link-btn" id="clearRepoScope">Clear scope</button>`;
}

function openSettings() {
  const dlg = $("#settingsModal");
  $("#apiKeyInput").value = localStorage.getItem("cao_api_key") || "";
  $("#providerSelect").value = getProvider();
  $("#localUrlInput").value = getLocalUrl();
  $("#localModelInput").value = getLocalModel();
  $("#localKeyInput").value = getLocalKey();
  $("#proxyUrlInput").value = getProxyUrl();
  toggleProviderFields();
  renderUsagePanel();
  dlg.showModal();
}

function toggleProviderFields() {
  const provider = $("#providerSelect").value;
  $("#anthropicFields").hidden = provider !== "anthropic";
  $("#localFields").hidden = provider !== "openai";
  $("#proxyFields").hidden = provider !== "proxy";
}

function updateProviderBadge() {
  const provider = getProvider();
  const btn = $("#settingsBtn");
  const labels = {
    anthropic: { full: "⚙ Claude key", title: "Claude API key settings" },
    openai: { full: "⚙ Open model", title: "Open source model API settings" },
    proxy: { full: "⚙ Built-in API", title: "Built-in API proxy settings" },
  };
  const label = labels[provider] || labels.anthropic;
  btn.title = label.title;
  btn.setAttribute("aria-label", btn.title);
  const full = btn.querySelector(".nav-full");
  const short = btn.querySelector(".nav-short");
  if (full) full.textContent = label.full;
  if (short) short.textContent = "⚙";
}

function renderUsagePanel() {
  const all = loadUsage();
  const rows = [];
  for (const [p, label] of [
    ["anthropic", "Claude API"],
    ["openai", "Open source model API"],
    ["proxy", "Built-in API proxy"],
  ]) {
    const u = all[p];
    if (!u.calls) continue;
    const cost = cloudCostUsd(u);
    const costLine = p === "openai"
      ? `saved ≈ $${cost.toFixed(2)} vs Claude`
      : `estimated sponsor cost ≈ $${cost.toFixed(2)}`;
    rows.push(`<div class="usage-row"><strong>${escHtml(label)}</strong> — ${u.calls} calls · ` +
      `in ${fmtTokens(u.in)}${u.cr ? ` (+${fmtTokens(u.cr)} cached)` : ""} · out ${fmtTokens(u.out)} · ${costLine}</div>`);
  }
  $("#usageStats").innerHTML = rows.length
    ? rows.join("")
    : `<div class="usage-row">No API calls recorded yet.</div>`;
}

/* ───────────────────────── Utilities ───────────────────────── */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Quote normalization — the citation-verification contract.
 * MUST stay in sync with tools/verify_index.js: map curly quotes/dashes/
 * non-breaking hyphen/minus to ASCII, ellipsis to "...", strip ALL whitespace
 * (incl. NBSP). Nothing else. */
function normChar(c) {
  if (c === "‘" || c === "’") return "'";
  if (c === "“" || c === "”") return '"';
  if (c === "–" || c === "—" || c === "‑" || c === "−") return "-"; // en/em dash, NB hyphen U+2011, minus U+2212
  if (c === "…") return "...";
  if (/\s/.test(c)) return ""; // \s covers NBSP in JS
  return c;
}
function normQuote(s) {
  let out = "";
  for (const c of String(s)) out += normChar(c);
  return out;
}
function noDigits(s) { return s.replace(/\d+/g, ""); }

// Per-report normalization maps: normalized text + normalized-index → raw-offset arrays.
// Built once per report (raw text must already be in reportCache).
function getNormMap(file) {
  let nm = state.normMaps.get(file);
  if (nm) return nm;
  const raw = state.reportCache.get(file);
  if (raw == null) throw new Error("report text not loaded: " + file);
  let norm = "", normND = "";
  const map = [], mapND = [];
  for (let i = 0; i < raw.length; i++) {
    const mapped = normChar(raw[i]);
    for (const c of mapped) { // normChar may emit several chars (e.g. "…" → "...")
      norm += c; map.push(i);
      if (!/\d/.test(c)) { normND += c; mapND.push(i); }
    }
  }
  nm = { norm, map, normND, mapND };
  state.normMaps.set(file, nm);
  return nm;
}

// Locate a quote in the raw report text via normalized matching; returns {start, end} raw offsets.
// Falls back to digit-stripped matching (page-number artifacts in the PDF extraction).
function findQuoteRange(file, quote) {
  const nm = getNormMap(file);
  let q = normQuote(quote);
  if (q) {
    const i = nm.norm.indexOf(q);
    if (i >= 0) return { start: nm.map[i], end: nm.map[i + q.length - 1] + 1 };
  }
  q = noDigits(q);
  if (q) {
    const i = nm.normND.indexOf(q);
    if (i >= 0) return { start: nm.mapND[i], end: nm.mapND[i + q.length - 1] + 1 };
  }
  return null;
}

async function fetchReport(file) {
  if (state.reportCache.has(file)) return state.reportCache.get(file);
  const res = await fetch(REPORTS_PATH + encodeURIComponent(file));
  if (!res.ok) throw new Error(`${file} → HTTP ${res.status}`);
  const text = await res.text();
  state.reportCache.set(file, text);
  return text;
}

function byId(id) { return state.index.find(r => r.id === id); }

function typeLabel(t) {
  return { country_office: "Country office", thematic: "Thematic", regional: "Regional" }[t] || t;
}

function ratingClass(r) {
  switch (r) {
    case "Satisfactory": return "r-sat";
    case "Partially Satisfactory, Improvement Needed": return "r-psin";
    case "Partially Satisfactory, Major Improvement Needed": return "r-psmin";
    case "Unsatisfactory": return "r-unsat";
    case "High": return "r-high";
    case "Medium": return "r-medium";
    default: return "r-info";
  }
}

function ratingShort(r) {
  switch (r) {
    case "Partially Satisfactory, Improvement Needed": return "PS — Improvement Needed";
    case "Partially Satisfactory, Major Improvement Needed": return "PS — Major Improvement Needed";
    default: return r;
  }
}

function shortName(rec) {
  let n = rec.title
    .replace(/^\d{4}\s+(OIAI\s+)?(Internal\s+)?(Audit\s+)?Reports?\s+(of|on)\s+(the\s+)?/i, "")
    .replace(/^\d{4}\s+Internal\s+Audit\s+of\s+/i, "")
    .replace(/\s+Country Office$/i, " CO");
  return `${n} (${rec.year})`;
}

/* ───────────────────────── Event Listeners ───────────────────────── */

window.addEventListener("hashchange", route);

// Facet pane: chip toggles + expand/collapse (delegated)
$("#facetPane").addEventListener("click", e => {
  const expand = e.target.closest("[data-expand]");
  if (expand) {
    const k = expand.dataset.expand;
    state.expandedFacets.has(k) ? state.expandedFacets.delete(k) : state.expandedFacets.add(k);
    renderFacets();
    return;
  }
  const chip = e.target.closest(".chip[data-facet]");
  if (!chip) return;
  const set = state.filters[chip.dataset.facet];
  const v = chip.dataset.value;
  set.has(v) ? set.delete(v) : set.add(v);
  renderBrowse();
});

$("#clearFilters").addEventListener("click", () => {
  state.filters = emptyFilters();
  renderBrowse();
});

$("#browseNlPanel").addEventListener("click", async e => {
  const mode = e.target.closest("[data-browse-nl-mode]");
  if (mode && !mode.disabled) {
    state.browseNlMode = mode.dataset.browseNlMode === "and" ? "and" : "or";
    renderBrowse();
    return;
  }
  if (e.target.closest("#browseAskBtn")) {
    state.pendingAsk = buildBrowseQuestion();
    location.hash = "#/ask";
    return;
  }
  if (e.target.closest("#browseCopyQuestion")) {
    const question = buildBrowseQuestion();
    try {
      await navigator.clipboard.writeText(question);
      e.target.textContent = "Copied";
      setTimeout(() => { e.target.textContent = "Copy question"; }, 1200);
    } catch {
      state.pendingAsk = question;
      location.hash = "#/ask";
    }
  }
});

// Mobile facet drawer open/close
$("#filtersBtn").addEventListener("click", () => toggleFacets(true));
$("#facetsDone").addEventListener("click", () => toggleFacets(false));
$("#facetBackdrop").addEventListener("click", () => toggleFacets(false));
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#facetDrawer").classList.contains("open")) toggleFacets(false);
});
window.addEventListener("resize", () => syncFacetDrawerState($("#facetDrawer").classList.contains("open")));

// First-visit hint for the Guide
$("#guideHintDismiss").addEventListener("click", () => {
  localStorage.setItem("cao_guide_seen", "1");
  $("#guideHint").hidden = true;
});

// Guide flow (delegated)
$("#guideRoot").addEventListener("click", e => {
  const g = state.guide;
  const obj = e.target.closest("[data-g-obj]");
  if (obj) {
    state.guide = freshGuide();
    state.guide.objective = obj.dataset.gObj;
    state.guide.step = GUIDE_FLOWS[obj.dataset.gObj][1];
    renderGuide();
    return;
  }
  if (!g) return;
  if (e.target.closest("[data-g-restart]")) { state.guide = freshGuide(); renderGuide(); return; }
  if (e.target.closest("[data-g-back]")) {
    const flow = GUIDE_FLOWS[g.objective] || ["objective"];
    const i = flow.indexOf(g.step);
    g.step = i > 0 ? flow[i - 1] : "objective";
    if (g.step === "objective") state.guide = freshGuide();
    renderGuide();
    return;
  }
  const toggle = e.target.closest("[data-g-toggle]");
  if (toggle) {
    const set = g[toggle.dataset.gToggle];
    const v = toggle.dataset.value;
    set.has(v) ? set.delete(v) : set.add(v);
    renderGuide();
    return;
  }
  if (e.target.closest("[data-g-continue]")) {
    const flow = GUIDE_FLOWS[g.objective];
    g.step = flow[flow.indexOf(g.step) + 1];
    renderGuide();
    return;
  }
  const focus = e.target.closest("[data-g-focus]");
  if (focus) {
    g.focus = { kind: focus.dataset.gFocus, value: focus.dataset.value };
    g.step = "destination";
    renderGuide();
    return;
  }
  const browseTopic = e.target.closest("[data-g-browse-topic]");
  if (browseTopic) { guideToBrowse(g, browseTopic.dataset.gBrowseTopic); return; }
  const dest = e.target.closest("[data-g-dest]");
  if (dest) {
    if (dest.dataset.gDest === "browse") guideToBrowse(g);
    else location.hash = "#/dash";
    return;
  }
  const ask = e.target.closest("[data-g-ask-idx]");
  if (ask) {
    state.pendingAsk = state.guideAsks[Number(ask.dataset.gAskIdx)] || "";
    location.hash = "#/ask";
  }
});
$("#guideRoot").addEventListener("submit", e => {
  if (e.target.id !== "guideFreeForm") return;
  e.preventDefault();
  const q = $("#guideFreeInput").value.trim();
  if (!q) return;
  state.pendingAsk = q;
  location.hash = "#/ask";
});

// Dashboard: every chart element deep-links into filtered Browse (delegated)
$("#dashRoot").addEventListener("click", e => {
  const tgl = e.target.closest("#dashTopicsToggle");
  if (tgl) {
    state.dashAllTopics = !state.dashAllTopics;
    renderDashboard();
    return;
  }
  const el = e.target.closest("[data-go], [data-year], [data-rating], [data-topic]");
  if (!el) return;
  const f = {};
  if (el.dataset.year) f.year = [el.dataset.year];
  if (el.dataset.rating) f.obsRating = [el.dataset.rating];
  if (el.dataset.topic) f.topic = [el.dataset.topic];
  dashGo(f); // data-go="all" → empty set → clear filters, show everything
});

// Report view: card quotes → highlight; tabs (delegated)
$("#reportCards").addEventListener("click", e => {
  const section = e.target.closest("[data-report-section]");
  if (section) {
    const target = document.getElementById(section.dataset.reportSection);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const tabBtn = e.target.closest("[data-report-tab]");
  if (tabBtn) {
    switchReportTab(tabBtn.dataset.reportTab);
    return;
  }
  const q = e.target.closest("blockquote.q[data-quote]");
  if (q) highlightQuote(q.dataset.quote);
});
$("#reportTabs").addEventListener("click", e => {
  const tab = e.target.closest(".tab[data-tab]");
  if (tab) switchReportTab(tab.dataset.tab);
});

// Citation chips: deep link → open report highlighted; long quotes expand (delegated, document-wide)
document.addEventListener("click", e => {
  const link = e.target.closest(".cite-link[data-cid]");
  if (link) {
    const c = state.citeStore.get(link.dataset.cid);
    if (!c) return;
    const rec = byId(c.id);
    if (!rec) return;
    state.pendingHighlight = c.quote;
    if (state.currentReportId === c.id) {
      showReport(c.id); // already open — just highlight
    } else {
      location.hash = "#/report/" + encodeURIComponent(c.id);
    }
    return;
  }
  const lq = e.target.closest(".cite-quote.long.collapsed");
  if (lq) {
    const c = state.citeStore.get(lq.dataset.cid);
    if (c) { lq.textContent = c.quote; lq.classList.remove("collapsed"); }
  }
});

// Chat forms
function bindChatForm(formSel, inputSel, handler) {
  const form = $(formSel), input = $(inputSel);
  form.addEventListener("submit", e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || state.busy) return;
    input.value = "";
    handler(q);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
}
bindChatForm("#reportChatForm", "#reportChatInput", askReport);
bindChatForm("#repoChatForm", "#repoChatInput", askRepository);

$("#browseAskForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("#browseAskInput");
  const q = input.value.trim();
  if (!q || state.busy) return;
  const matches = computeMatches(state.filters);
  const anyFilter = Object.values(state.filters).some(s => s.size);
  const scope = currentBrowseScope(matches, anyFilter);
  if (!scope.ids.length) {
    input.value = "";
    input.placeholder = "No selected reports. Adjust filters and ask again.";
    return;
  }
  state.pendingAsk = q;
  state.pendingAskScope = scope.hasFilters ? scope : null;
  if (!scope.hasFilters) state.repoScope = null;
  state.pendingAskAutoSend = true;
  input.value = "";
  location.hash = "#/ask";
});

$("#repoAskEmpty").addEventListener("click", e => {
  const prompt = e.target.closest("[data-prompt]");
  if (!prompt) return;
  const input = $("#repoChatInput");
  input.value = prompt.dataset.prompt;
  input.focus();
});

$("#repoScopeNotice").addEventListener("click", e => {
  if (!e.target.closest("#clearRepoScope")) return;
  state.repoScope = null;
  updateRepoScopeNotice();
});

// Settings
$("#settingsBtn").addEventListener("click", openSettings);
$("#settingsCancel").addEventListener("click", () => $("#settingsModal").close());
$("#providerSelect").addEventListener("change", toggleProviderFields);
$("#usageReset").addEventListener("click", () => {
  localStorage.removeItem("cao_usage");
  renderUsagePanel();
});
$("#settingsForm").addEventListener("submit", () => {
  const set = (key, value) => {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  };
  localStorage.setItem("cao_provider", $("#providerSelect").value);
  set("cao_api_key", $("#apiKeyInput").value.trim());
  set("cao_local_url", $("#localUrlInput").value.trim());
  set("cao_local_model", $("#localModelInput").value.trim());
  set("cao_local_key", $("#localKeyInput").value.trim());
  set("cao_proxy_url", $("#proxyUrlInput").value.trim());
  updateProviderBadge();
});
updateProviderBadge();

/* ───────────────────────── Console test hook (step 4 acceptance) ─────────────────────────
 * Run window.__testCitations() in the console: renders a real, a fabricated and an
 * artifact-spanning citation through the full pipeline (verified / quarantined). */
window.__testCitations = async function () {
  const rec = state.index[0];
  await fetchReport(rec.file);
  const raw = state.reportCache.get(rec.file);
  const real = raw.replace(/\s+/g, " ").slice(2000, 2120).trim();
  const sample = `## Facts
- Real quote test {{cite ${rec.id} | ${real} | console test}}
- Fabricated quote test {{cite ${rec.id} | This sentence was never written in any audit report whatsoever. | console test}}
- This factual-looking sentence deliberately has no citation marker attached to it at all.
## Synthesis — interpretation, not from reports
This synthesis block should render in the labeled container.`;
  const div = appendMsg($("#repoChatMsgs") || document.body, "assistant", "");
  div.innerHTML = renderAnswer(sample);
  await finalizeAnswer(div, { repair: false }); // no API calls from the console test
  console.log("Rendered test message appended — expect: 1 ✓ verified chip, 1 ⚠ quarantined chip, 1 dotted-underline uncited claim, 1 synthesis container.");
  return div;
};

init();
