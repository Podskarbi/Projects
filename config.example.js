// Copy to config.js and add your Anthropic API key (or use the in-app Settings modal,
// which stores the key in localStorage and takes precedence). The proxy URL below
// is public and contains no secret; the Worker keeps the real API key server-side.
// NEVER commit a real key.
const CONFIG = {
  apiKey: "",
  proxyUrl: "https://edi-demo-proxy.podskarbi.workers.dev/api/messages"
};
