const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) {
    return { ok: false, response: json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, 503) };
  }
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

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value) {
  if (value == null || value === "") return null;
  return typeof value === "string" ? value.trim() : String(value).trim();
}

function asInteger(value, field, { min = null, nullable = false } = {}) {
  if (value == null || value === "") {
    if (nullable) return { ok: true, value: null };
    return { ok: false, error: `${field} required` };
  }
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, error: `${field} must be an integer` };
  if (min != null && n < min) return { ok: false, error: `${field} must be >= ${min}` };
  return { ok: true, value: n };
}

const INVENTORY_STATUSES = new Set(["AVAILABLE", "RESERVED", "SOLD"]);
const INVENTORY_CATEGORIES = new Set(["MUSIC", "BOOK", "GAME", "INSTRUMENT", "CAMERA", "APPAREL", "OTHER"]);

export function validateInventoryCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON body" };
  }

  const productName = asTrimmedString(body.product_name);
  if (!productName) return { ok: false, error: "product_name required" };
  if (productName.length > 300) return { ok: false, error: "product_name too long" };

  const category = asTrimmedString(body.category || "MUSIC").toUpperCase();
  if (!INVENTORY_CATEGORIES.has(category)) return { ok: false, error: "invalid category" };

  const quantity = asInteger(body.quantity == null ? 1 : body.quantity, "quantity", { min: 1 });
  if (!quantity.ok) return quantity;

  const cost = asInteger(body.cost_jpy == null ? 0 : body.cost_jpy, "cost_jpy", { min: 0 });
  if (!cost.ok) return cost;

  const price = asInteger(body.price_jpy, "price_jpy", { min: 0, nullable: true });
  if (!price.ok) return price;

  const rawSku = asTrimmedString(body.sku);
  if (rawSku && !/^[A-Za-z0-9._:-]{1,80}$/.test(rawSku)) {
    return { ok: false, error: "invalid sku" };
  }

  return {
    ok: true,
    value: {
      sku: rawSku || null,
      category,
      product_name: productName,
      format: asOptionalString(body.format),
      media_condition: asOptionalString(body.media_condition),
      sleeve_condition: asOptionalString(body.sleeve_condition),
      cost_jpy: cost.value,
      price_jpy: price.value,
      location: asOptionalString(body.location),
      quantity: quantity.value
    }
  };
}

export function validateInventoryPatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON body" };
  }

  const out = {};
  const allowed = new Set([
    "status", "sync_state", "category", "product_name", "format",
    "media_condition", "sleeve_condition", "cost_jpy", "price_jpy",
    "location", "quantity"
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return { ok: false, error: `field not editable: ${key}` };
  }

  if ("status" in body) {
    const status = asTrimmedString(body.status).toUpperCase();
    if (!INVENTORY_STATUSES.has(status)) return { ok: false, error: "invalid status" };
    out.status = status;
  }
  if ("category" in body) {
    const category = asTrimmedString(body.category).toUpperCase();
    if (!INVENTORY_CATEGORIES.has(category)) return { ok: false, error: "invalid category" };
    out.category = category;
  }
  if ("product_name" in body) {
    const name = asTrimmedString(body.product_name);
    if (!name) return { ok: false, error: "product_name required" };
    if (name.length > 300) return { ok: false, error: "product_name too long" };
    out.product_name = name;
  }
  if ("quantity" in body) {
    const q = asInteger(body.quantity, "quantity", { min: 0 });
    if (!q.ok) return q;
    out.quantity = q.value;
  }
  if ("cost_jpy" in body) {
    const n = asInteger(body.cost_jpy, "cost_jpy", { min: 0 });
    if (!n.ok) return n;
    out.cost_jpy = n.value;
  }
  if ("price_jpy" in body) {
    const n = asInteger(body.price_jpy, "price_jpy", { min: 0, nullable: true });
    if (!n.ok) return n;
    out.price_jpy = n.value;
  }

  for (const key of ["sync_state", "format", "media_condition", "sleeve_condition", "location"]) {
    if (key in body) out[key] = asOptionalString(body[key]);
  }

  if (!Object.keys(out).length) return { ok: false, error: "no editable fields" };
  return { ok: true, value: out };
}

export function validateSaleEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON body" };
  }

  const eventId = asTrimmedString(body.event_id);
  const sku = asTrimmedString(body.sku);
  const channel = asTrimmedString(body.channel).toUpperCase();

  if (!eventId) return { ok: false, error: "event_id required" };
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(eventId)) return { ok: false, error: "invalid event_id" };
  if (!sku) return { ok: false, error: "sku required" };
  if (!channel) return { ok: false, error: "channel required" };

  const salePrice = asInteger(body.sale_price_jpy, "sale_price_jpy", { min: 0, nullable: true });
  if (!salePrice.ok) return salePrice;

  return {
    ok: true,
    value: {
      event_id: eventId,
      sku,
      channel,
      order_id: asOptionalString(body.order_id),
      sale_price_jpy: salePrice.value,
      final_state: asOptionalString(body.final_state) || "PAID",
      note: asOptionalString(body.note)
    }
  };
}

export function nextInventoryAfterSale(quantity) {
  const q = Math.max(0, Number(quantity || 0));
  const nextQuantity = Math.max(0, q - 1);
  return {
    quantity: nextQuantity,
    status: nextQuantity === 0 ? "SOLD" : "AVAILABLE",
    sync_state: nextQuantity === 0 ? "STOP_PENDING" : "SYNC_PENDING"
  };
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
  if (!(stopped.ok || stopped.status === 404)) return { ok: false, phase: "stop", ...stopped };

  const verify = await discogsRequest(env, `/marketplace/listings/${encodeURIComponent(listingId)}`);
  if (verify.status === 404) return { ok: true, verified: true, status: 404, note: "listing absent" };
  if (!verify.ok) return { ok: false, verified: null, phase: "verify", ...verify };

  const status = verify.body && verify.body.status ? String(verify.body.status) : "";
  if (status === "For Sale") return { ok: false, verified: false, status: 200, note: "still for sale", body: verify.body };
  if (["Draft", "Expired", "Sold"].includes(status)) return { ok: true, verified: true, status: 200, note: status, body: verify.body };
  return { ok: false, verified: null, status: 200, note: `unknown status: ${status || "empty"}`, body: verify.body };
}

function dbRequired(env) {
  return env.DB ? null : json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);
}

async function listInventory(env) {
  const result = await env.DB.prepare(
    `SELECT sku,status,sync_state,category,product_name,format,media_condition,sleeve_condition,
            cost_jpy,price_jpy,location,quantity,created_at,updated_at
       FROM inventory
      ORDER BY updated_at DESC
      LIMIT 200`
  ).run();
  return result.results || [];
}

async function inventoryDetail(env, sku) {
  const item = await env.DB.prepare(
    `SELECT sku,status,sync_state,category,product_name,format,media_condition,sleeve_condition,
            cost_jpy,price_jpy,location,quantity,created_at,updated_at
       FROM inventory WHERE sku=? LIMIT 1`
  ).bind(sku).first();

  if (!item) return null;

  const [listings, media] = await Promise.all([
    env.DB.prepare(
      `SELECT channel,external_id,listing_status,listing_url,price_jpy,quantity,last_note,last_synced_at,created_at
         FROM channel_listings WHERE sku=? ORDER BY channel,created_at DESC`
    ).bind(sku).all(),
    env.DB.prepare(
      "SELECT r2_key,content_type,created_at FROM inventory_media WHERE sku=? ORDER BY created_at DESC"
    ).bind(sku).all()
  ]);

  return {
    ...item,
    listings: listings.results || [],
    media: media.results || []
  };
}

async function createInventory(request, env) {
  const parsed = validateInventoryCreate(await request.json().catch(() => null));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const v = parsed.value;
  const sku = v.sku || makeSku(v.category === "BOOK" ? "BOOK" : "AUDIO");

  try {
    await env.DB.prepare(
      `INSERT INTO inventory
       (sku,category,product_name,format,media_condition,sleeve_condition,cost_jpy,price_jpy,location,quantity,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    ).bind(
      sku, v.category, v.product_name, v.format, v.media_condition, v.sleeve_condition,
      v.cost_jpy, v.price_jpy, v.location, v.quantity
    ).run();
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes("UNIQUE") || message.includes("inventory.sku")) {
      return json({ ok: false, error: "SKU_EXISTS", sku }, 409);
    }
    throw error;
  }

  return json({ ok: true, sku, item: await inventoryDetail(env, sku) }, 201);
}

async function patchInventory(request, env, sku) {
  const current = await env.DB.prepare("SELECT sku FROM inventory WHERE sku=? LIMIT 1").bind(sku).first();
  if (!current) return json({ ok: false, error: "SKU_NOT_FOUND" }, 404);

  const parsed = validateInventoryPatch(await request.json().catch(() => null));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const entries = Object.entries(parsed.value);
  const setSql = entries.map(([key]) => `${key}=?`).join(",");
  const values = entries.map(([, value]) => value);

  await env.DB.prepare(
    `UPDATE inventory SET ${setSql}, updated_at=CURRENT_TIMESTAMP WHERE sku=?`
  ).bind(...values, sku).run();

  return json({ ok: true, item: await inventoryDetail(env, sku) });
}

async function upsertChannelListing(request, env, sku) {
  const exists = await env.DB.prepare("SELECT sku FROM inventory WHERE sku=? LIMIT 1").bind(sku).first();
  if (!exists) return json({ ok: false, error: "SKU_NOT_FOUND" }, 404);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  const channel = asTrimmedString(body.channel).toUpperCase();
  const externalId = asTrimmedString(body.external_id);
  if (!channel) return json({ ok: false, error: "channel required" }, 400);
  if (!externalId) return json({ ok: false, error: "external_id required" }, 400);

  const existing = await env.DB.prepare(
    "SELECT id,sku FROM channel_listings WHERE channel=? AND external_id=? LIMIT 1"
  ).bind(channel, externalId).first();

  if (existing && existing.sku !== sku) {
    return json({ ok: false, error: "EXTERNAL_ID_IN_USE", sku: existing.sku }, 409);
  }

  const status = asTrimmedString(body.listing_status || "LISTED").toUpperCase();
  const price = asInteger(body.price_jpy, "price_jpy", { min: 0, nullable: true });
  if (!price.ok) return json({ ok: false, error: price.error }, 400);
  const quantity = asInteger(body.quantity == null ? 1 : body.quantity, "quantity", { min: 0 });
  if (!quantity.ok) return json({ ok: false, error: quantity.error }, 400);

  if (existing) {
    await env.DB.prepare(
      `UPDATE channel_listings
          SET listing_status=?,listing_url=?,price_jpy=?,quantity=?,last_note=?,last_synced_at=CURRENT_TIMESTAMP
        WHERE id=?`
    ).bind(
      status,
      asOptionalString(body.listing_url),
      price.value,
      quantity.value,
      asOptionalString(body.last_note),
      existing.id
    ).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO channel_listings
       (sku,channel,external_id,listing_status,listing_url,price_jpy,quantity,last_note,last_synced_at)
       VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    ).bind(
      sku, channel, externalId, status, asOptionalString(body.listing_url),
      price.value, quantity.value, asOptionalString(body.last_note)
    ).run();
  }

  const item = await inventoryDetail(env, sku);
  return json({ ok: true, listing: item.listings.find((x) => x.channel === channel && x.external_id === externalId) || null }, existing ? 200 : 201);
}

async function listSaleEvents(env) {
  const result = await env.DB.prepare(
    `SELECT event_id,sku,channel,order_id,sale_price_jpy,final_state,note,detected_at,completed_at
       FROM sale_events
       ORDER BY detected_at DESC
       LIMIT 200`
  ).all();
  return result.results || [];
}

async function recordSaleEvent(request, env) {
  const parsed = validateSaleEvent(await request.json().catch(() => null));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
  const v = parsed.value;

  const existingEvent = await env.DB.prepare(
    "SELECT event_id,sku,channel,detected_at FROM sale_events WHERE event_id=? LIMIT 1"
  ).bind(v.event_id).first();

  if (existingEvent) {
    return json({
      ok: true,
      idempotent: true,
      event: existingEvent,
      item: await inventoryDetail(env, existingEvent.sku)
    });
  }

  const item = await env.DB.prepare(
    "SELECT sku,quantity,status FROM inventory WHERE sku=? LIMIT 1"
  ).bind(v.sku).first();

  if (!item) return json({ ok: false, error: "SKU_NOT_FOUND" }, 404);
  if (Number(item.quantity || 0) <= 0 || item.status === "SOLD") {
    return json({ ok: false, error: "INVENTORY_ALREADY_SOLD", sku: v.sku }, 409);
  }

  const next = nextInventoryAfterSale(item.quantity);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sale_events
       (event_id,sku,channel,order_id,sale_price_jpy,final_state,note)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      v.event_id, v.sku, v.channel, v.order_id,
      v.sale_price_jpy, v.final_state, v.note
    ),
    env.DB.prepare(
      `UPDATE inventory
          SET quantity=?,status=?,sync_state=?,updated_at=CURRENT_TIMESTAMP
        WHERE sku=?`
    ).bind(next.quantity, next.status, next.sync_state, v.sku)
  ]);

  const stopTargets = next.sync_state === "STOP_PENDING"
    ? await env.DB.prepare(
        `SELECT channel,external_id,listing_status,listing_url
           FROM channel_listings
          WHERE sku=? AND listing_status='LISTED'
          ORDER BY channel`
      ).bind(v.sku).all()
    : { results: [] };

  return json({
    ok: true,
    idempotent: false,
    event_id: v.event_id,
    inventory: next,
    stop_targets: stopTargets.results || [],
    destructive_actions_executed: false
  }, 201);
}

async function stopQueue(env) {
  const result = await env.DB.prepare(
    `SELECT
        i.sku,i.product_name,i.status,i.sync_state,
        l.channel,l.external_id,l.listing_status,l.listing_url
       FROM inventory i
       JOIN channel_listings l ON l.sku=i.sku
      WHERE i.sync_state='STOP_PENDING' AND l.listing_status='LISTED'
      ORDER BY i.updated_at ASC,l.channel ASC`
  ).all();
  return result.results || [];
}

async function dashboardSummary(env) {
  const [inventory, listings, sync] = await Promise.all([
    env.DB.prepare(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='AVAILABLE' THEN 1 ELSE 0 END) AS available,
          SUM(CASE WHEN status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
          SUM(CASE WHEN status='SOLD' THEN 1 ELSE 0 END) AS sold
       FROM inventory`
    ).first(),
    env.DB.prepare(
      `SELECT channel,listing_status,COUNT(*) AS count
       FROM channel_listings
       GROUP BY channel,listing_status
       ORDER BY channel,listing_status`
    ).all(),
    env.DB.prepare(
      `SELECT
          SUM(CASE WHEN sync_state='STOP_PENDING' THEN 1 ELSE 0 END) AS stop_pending,
          SUM(CASE WHEN sync_state='SYNC_PENDING' THEN 1 ELSE 0 END) AS sync_pending
       FROM inventory`
    ).first()
  ]);

  return {
    inventory: inventory || { total: 0, available: 0, reserved: 0, sold: 0 },
    listings: listings.results || [],
    sync: sync || { stop_pending: 0, sync_pending: 0 }
  };
}

async function uploadMedia(request, env, sku) {
  if (!env.MEDIA) return json({ ok: false, error: "R2_NOT_CONFIGURED" }, 503);

  const exists = await env.DB.prepare("SELECT sku FROM inventory WHERE sku=? LIMIT 1").bind(sku).first();
  if (!exists) return json({ ok: false, error: "SKU_NOT_FOUND" }, 404);

  const type = request.headers.get("content-type") || "application/octet-stream";
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedTypes.has(type)) return json({ ok: false, error: "UNSUPPORTED_MEDIA_TYPE" }, 415);

  const length = Number(request.headers.get("content-length") || 0);
  if (length > 15 * 1024 * 1024) return json({ ok: false, error: "MEDIA_TOO_LARGE" }, 413);

  const ext = type === "image/jpeg" ? "jpg" : type === "image/png" ? "png" : "webp";
  const key = `${sku}/${crypto.randomUUID()}.${ext}`;

  await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: type } });
  await env.DB.prepare("INSERT INTO inventory_media (sku,r2_key,content_type) VALUES (?,?,?)")
    .bind(sku, key, type).run();

  return json({ ok: true, key }, 201);
}

async function fetchMedia(env, key) {
  if (!env.MEDIA) return json({ ok: false, error: "R2_NOT_CONFIGURED" }, 503);

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
        version: "0.1.0",
        bindings: { d1: !!env.DB, r2: !!env.MEDIA },
        connectors: { discogs: !!env.DISCOGS_TOKEN, ebay: !!env.EBAY_CLIENT_ID },
        admin: { configured: !!env.ADMIN_TOKEN }
      });
    }

    if (pathname.startsWith("/api/")) {
      const auth = requireAdmin(request, env);
      if (!auth.ok) return auth.response;

      const dbError = dbRequired(env);
      if (dbError && !pathname.startsWith("/api/connectors/")) return dbError;
    }

    if (pathname === "/api/dashboard" && request.method === "GET") {
      return json({ ok: true, summary: await dashboardSummary(env) });
    }
    if (pathname === "/api/sales/events" && request.method === "GET") {
      return json({ ok: true, events: await listSaleEvents(env) });
    }

    if (pathname === "/api/sales/events" && request.method === "POST") {
      return recordSaleEvent(request, env);
    }

    if (pathname === "/api/stop-queue" && request.method === "GET") {
      return json({ ok: true, items: await stopQueue(env), destructive_actions_executed: false });
    }


    if (pathname === "/api/inventory" && request.method === "GET") {
      return json({ ok: true, items: await listInventory(env) });
    }

    if (pathname === "/api/inventory" && request.method === "POST") {
      return createInventory(request, env);
    }

    const inventoryItem = pathname.match(/^\/api\/inventory\/([^/]+)$/);
    if (inventoryItem && request.method === "GET") {
      const sku = decodeURIComponent(inventoryItem[1]);
      const item = await inventoryDetail(env, sku);
      return item ? json({ ok: true, item }) : json({ ok: false, error: "SKU_NOT_FOUND" }, 404);
    }

    if (inventoryItem && request.method === "PATCH") {
      return patchInventory(request, env, decodeURIComponent(inventoryItem[1]));
    }

    const listingRoute = pathname.match(/^\/api\/inventory\/([^/]+)\/listings$/);
    if (listingRoute && request.method === "POST") {
      return upsertChannelListing(request, env, decodeURIComponent(listingRoute[1]));
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
      return json(
        { ok: r.ok, status: r.status, identity: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body },
        r.ok ? 200 : r.status || 502
      );
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
