/*
 * Enterprise Document Intelligence — service worker (PWA offline support).
 *
 * Strategy:
 *  - App shell (html/js/css/manifest/icons): network-first, cache fallback —
 *    updates always win when online, the app still opens offline.
 *  - library/ + UNICEF Reports/ : cache-first — immutable ground truth,
 *    precached in full at install (~2.5 MB of text) so Browse, the report
 *    reader, citation verification and the Dashboard all work offline.
 *  - Cross-origin requests (the Claude API) are NEVER intercepted — Ask
 *    features simply require a connection.
 *
 * Bump CACHE_VERSION when shipping changes to the precached set.
 */
const CACHE_VERSION = "cao-v14";
const SHELL = [
  "./",
  "index.html",
  "app.js",
  "styles.css",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(SHELL);
    // Precache the verified index, vocabulary and every report it lists.
    const res = await fetch("library/index.json");
    const index = JSON.parse(await res.clone().text());
    await cache.put("library/index.json", res);
    const files = ["library/vocabulary.json",
      ...index.map(r => "UNICEF Reports/" + encodeURIComponent(r.file))];
    await cache.addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE_VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // API calls pass through untouched

  const isData = url.pathname.includes("/library/") || url.pathname.includes("/UNICEF%20Reports/");
  e.respondWith(isData ? cacheFirst(e.request) : networkFirst(e.request));
});

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE_VERSION)).put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}
