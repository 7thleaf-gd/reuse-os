const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return { ok: false, response: json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, 503) };
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return { ok: false, response: json({ ok: false, error: "UNAUTHORIZED" }, 401) };
  }
  return { ok: true };
}

export function makeSku(prefix = "AUDIO") {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

export function discogsHeaders(env) {
  return {
    Authorization: `Discogs token=${env.DISCOGS_TOKEN || ""}`,
    "User-Agent": "7thleaf-ReuseOS/0.1 +https://github.com/7thleaf-gd/reuse-os"
  };
}

async function discogsRequest(env, path, init = {}) {
  if (!env.DISCOGS_TOKEN) return { ok: false, status: 503, error: "DISCOGS_TOKEN_NOT_CONFIGURED" };
  const response = await fetch(`https://api.discogs.com${path}`, {
    ...init,
    headers: { ...discogsHeaders(env), ...(init.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: response.ok, status: response.status, body };
}

export async function discogsIdentity(env) {
  return discogsRequest(env, "/oauth/identity");
}

export async function discogsStopListing(env, listingId) {
  const stopped = await discogsRequest(env, `/marketplace/listings/${encodeURIComponent(listingId)}`, { method: "DELETE" });
  if (!(stopped.ok || stopped.status === 404)) {
    return { ok: false, phase: "stop", ...stopped };
  }
  const verify = await discogsRequest(env, `/marketplace/listings/${encodeURIComponent(listingId)}`);
  if (verify.status === 404) return { ok: true, verified: true, status: 404, note: "listing absent" };
  if (!verify.ok) return { ok: false, verified: null, phase: "verify", ...verify };
  const status = verify.body && verify.body.status ? String(verify.body.status) : "";
  if (status === "For Sale") return { ok: false, verified: false, status: 200, note: "still for sale", body: verify.body };
  if (["Draft", "Expired", "Sold"].includes(status)) return { ok: true, verified: true, status: 200, note: status, body: verify.body };
  return { ok: false, verified: null, status: 200, note: `unknown status: ${status || "empty"}`, body: verify.body };
}

async function listInventory(env) {
  const result = await env.DB.prepare(
    "SELECT sku,status,sync_state,category,product_name,format,media_condition,sleeve_condition,price_jpy,location,quantity,updated_at FROM inventory ORDER BY updated_at DESC LIMIT 200"
  ).run();
  return result.results || [];
}

async function createInventory(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.product_name) return json({ ok: false, error: "product_name required" }, 400);
  const sku = body.sku || makeSku(body.category === "BOOK" ? "BOOK" : "AUDIO");
  await env.DB.prepare(
    `INSERT INTO inventory
     (sku,category,product_name,format,media_condition,sleeve_condition,cost_jpy,price_jpy,location,quantity,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
  ).bind(
    sku,
    body.category || "MUSIC",
    body.product_name,
    body.format || null,
    body.media_condition || null,
    body.sleeve_condition || null,
    Number(body.cost_jpy || 0),
    body.price_jpy == null ? null : Number(body.price_jpy),
    body.location || null,
    Math.max(1, Number(body.quantity || 1))
  ).run();
  return json({ ok: true, sku }, 201);
}

async function uploadMedia(request, env, sku) {
  const exists = await env.DB.prepare("SELECT sku FROM inventory WHERE sku=? LIMIT 1").bind(sku).first();
  if (!exists) return json({ ok: false, error: "SKU_NOT_FOUND" }, 404);
  const type = request.headers.get("content-type") || "application/octet-stream";
  const ext = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : type === "image/webp" ? "webp" : "bin";
  const key = `${sku}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare("INSERT INTO inventory_media (sku,r2_key,content_type) VALUES (?,?,?)")
    .bind(sku, key, type).run();
  return json({ ok: true, key }, 201);
}

async function fetchMedia(env, key) {
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=300");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "reuse-os-core-v0",
        version: "0.0.1",
        bindings: { d1: !!env.DB, r2: !!env.MEDIA },
        connectors: { discogs: !!env.DISCOGS_TOKEN, ebay: !!env.EBAY_CLIENT_ID }
      });
    }

    if (pathname.startsWith("/api/")) {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return auth.response;
    }

    if (pathname === "/api/inventory" && request.method === "GET") {
      return json({ ok: true, items: await listInventory(env) });
    }

    if (pathname === "/api/inventory" && request.method === "POST") {
      return createInventory(request, env);
    }

    const mediaUpload = pathname.match(/^\/api\/inventory\/([^/]+)\/media$/);
    if (mediaUpload && request.method === "POST") {
      return uploadMedia(request, env, decodeURIComponent(mediaUpload[1]));
    }

    const mediaGet = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaGet && request.method === "GET") {
      return fetchMedia(env, decodeURIComponent(mediaGet[1]));
    }

    if (pathname === "/api/connectors/discogs/identity" && request.method === "GET") {
      const r = await discogsIdentity(env);
      return json({ ok: r.ok, status: r.status, identity: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body }, r.ok ? 200 : r.status || 502);
    }

    const discogsStop = pathname.match(/^\/api\/connectors\/discogs\/listings\/([^/]+)\/stop$/);
    if (discogsStop && request.method === "POST") {
      const r = await discogsStopListing(env, decodeURIComponent(discogsStop[1]));
      return json(r, r.ok ? 200 : 409);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};
