const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "Origin",
  };
}

function clientKey(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")
    || "unknown";
}

const buckets = new Map();

function checkRateLimit(request, env) {
  const limit = Number(env.REQUESTS_PER_MINUTE || 8);
  const key = clientKey(request);
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = buckets.get(key) || { start: now, count: 0 };
  if (now - bucket.start >= windowMs) {
    bucket.start = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket.count <= limit;
}

function sanitizeBody(body, env) {
  if (!Array.isArray(body.messages)) throw new Error("messages must be an array");
  if (!body.system) throw new Error("system is required");
  return {
    model: env.MODEL_ID || "claude-3-5-haiku-latest",
    max_tokens: Math.min(Number(body.max_tokens || 1000), Number(env.MAX_TOKENS || 1500)),
    system: body.system,
    messages: body.messages,
    ...(body.stream ? { stream: true } : {}),
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return cors
        ? new Response(null, { status: 204, headers: cors })
        : new Response(null, { status: 403 });
    }

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return json({
        ok: true,
        configured: !!env.ANTHROPIC_API_KEY,
        model: env.MODEL_ID || "claude-3-5-haiku-latest",
      }, 200, cors || {});
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Use POST /api/messages" } }, 405, cors || {});
    }
    if (!cors) {
      return json({ error: { message: "Origin is not allowed for this demo proxy." } }, 403);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: { message: "Demo proxy is not configured yet." } }, 503, cors);
    }
    if (!checkRateLimit(request, env)) {
      return json({ error: { message: "Demo proxy rate limit reached. Try again later." } }, 429, cors);
    }

    let outbound;
    try {
      outbound = sanitizeBody(await request.json(), env);
    } catch (e) {
      return json({ error: { message: e.message } }, 400, cors);
    }

    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": env.ANTHROPIC_VERSION || "2023-06-01",
      },
      body: JSON.stringify(outbound),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        "content-type": upstream.headers.get("content-type") || "application/json",
      },
    });
  },
};
