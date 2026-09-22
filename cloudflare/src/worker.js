import {
  saveEbayConfig,
  ebayOAuthStatus,
  ebayOAuthStart,
  ebayOAuthCallback,
  ebayPrivileges,
  disconnectEbay,
  importEbaySandboxToken
} from "./ebay.js";
import {
  saveVisionConfig,
  visionStatus,
  analyzeHunterImage
} from "./vision.js";
import {
  hunterSearchMusicBrainz
} from "./musicbrainz.js";

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
const LISTING_STATUSES = new Set(["LISTED", "DRAFT", "PAUSED", "SOLD", "ENDED", "ERROR"]);

export function normalizeListingStatus(value) {
  const raw = asTrimmedString(value || "LISTED").toUpperCase();
  if (raw === "FOR SALE" || raw === "FOR_SALE" || raw === "ACTIVE") return { ok: true, value: "LISTED" };
  if (!LISTING_STATUSES.has(raw)) return { ok: false, error: "invalid listing_status" };
  return { ok: true, value: raw };
}

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

  const retryAfterRaw = response.headers.get("retry-after");
  const retryAfter = retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;
  const remainingRaw = response.headers.get("x-discogs-ratelimit-remaining");
  const remaining = remainingRaw && /^\d+$/.test(remainingRaw) ? Number(remainingRaw) : null;

  return {
    ok: response.ok,
    status: response.status,
    body,
    rate_limit: {
      remaining,
      retry_after: retryAfter
    }
  };
}

export async function discogsIdentity(env) {
  return discogsRequest(env, "/oauth/identity");
}
export function normalizeHunterSearchResult(result) {
  const format = Array.isArray(result?.format)
    ? result.format.join(", ")
    : (result?.format || null);
  const barcode = Array.isArray(result?.barcode)
    ? (result.barcode[0] || null)
    : (result?.barcode || null);
  const labels = Array.isArray(result?.label) ? result.label : [];
  const uri = result?.uri
    ? (String(result.uri).startsWith("http") ? String(result.uri) : "https://www.discogs.com" + String(result.uri))
    : null;

  return {
    release_id: result?.id == null ? null : String(result.id),
    title: result?.title || null,
    year: result?.year == null ? null : Number(result.year) || null,
    country: result?.country || null,
    format,
    label: labels[0] || null,
    catno: result?.catno || null,
    barcode,
    thumb: result?.thumb || null,
    cover_image: result?.cover_image || null,
    uri
  };
}

export async function hunterSearchDiscogs(env, query) {
  const raw = asTrimmedString(query);
  if (!raw) return { ok: false, status: 400, error: "HUNTER_QUERY_REQUIRED" };
  if (raw.length > 200) return { ok: false, status: 400, error: "HUNTER_QUERY_TOO_LONG" };

  const compact = raw.replace(/[\s-]/g, "");
  const isBarcode = /^\d{8,14}$/.test(compact);
  const params = new URLSearchParams({ type: "release", per_page: "12", page: "1" });
  if (isBarcode) params.set("barcode", compact);
  else params.set("q", raw);

  const result = await discogsRequest(env, "/database/search?" + params.toString());
  if (!result.ok) return result;

  const items = Array.isArray(result.body?.results)
    ? result.body.results.map(normalizeHunterSearchResult).filter((x) => x.release_id && x.title)
    : [];

  return {
    ok: true,
    status: result.status,
    rate_limit: result.rate_limit,
    body: {
      query: raw,
      barcode: isBarcode ? compact : null,
      count: items.length,
      items
    }
  };
}

export function scoreHunterDiscogsCandidate(item, identity = {}) {
  const norm = (value) => asTrimmedString(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const digits = (value) => asTrimmedString(value).replace(/\D/g, "");
  let score = 0;
  const reasons = [];
  const wantedBarcode = digits(identity.barcode);
  const itemBarcode = digits(item?.barcode);
  if (wantedBarcode && itemBarcode && wantedBarcode === itemBarcode) { score += 100; reasons.push("barcode"); }
  const wantedCatno = norm(identity.catno);
  const itemCatno = norm(item?.catno);
  if (wantedCatno && itemCatno && wantedCatno === itemCatno) { score += 70; reasons.push("catno"); }
  const wantedTitle = norm(identity.title || [identity.artist, identity.release_title].filter(Boolean).join(" "));
  const itemTitle = norm(item?.title);
  if (wantedTitle && itemTitle && (itemTitle.includes(wantedTitle) || wantedTitle.includes(itemTitle))) { score += 30; reasons.push("title"); }
  const wantedFormat = norm(identity.format);
  const itemFormat = norm(item?.format);
  if (wantedFormat && itemFormat && (itemFormat.includes(wantedFormat) || wantedFormat.includes(itemFormat))) { score += 10; reasons.push("format"); }
  return { score, reasons };
}

export async function hunterMatchDiscogs(env, identity = {}) {
  const barcode = asTrimmedString(identity.barcode).replace(/[\s-]/g, "");
  const catno = asTrimmedString(identity.catno);
  const artist = asTrimmedString(identity.artist);
  const releaseTitle = asTrimmedString(identity.release_title);
  const title = asTrimmedString(identity.title);
  const params = new URLSearchParams({ type: "release", per_page: "12", page: "1" });
  let queryKind = "text";
  if (/^\d{8,14}$/.test(barcode)) {
    params.set("barcode", barcode);
    queryKind = "barcode";
  } else if (catno) {
    params.set("catno", catno);
    queryKind = "catno";
  } else {
    if (artist) params.set("artist", artist);
    if (releaseTitle) params.set("release_title", releaseTitle);
    if (!artist && !releaseTitle && title) params.set("q", title);
  }
  if (![...params.keys()].some((key) => !["type","per_page","page"].includes(key))) {
    return { ok: false, status: 400, error: "HUNTER_MARKET_IDENTITY_REQUIRED" };
  }
  const result = await discogsRequest(env, "/database/search?" + params.toString());
  if (!result.ok) return result;
  const items = (Array.isArray(result.body?.results) ? result.body.results : [])
    .map(normalizeHunterSearchResult)
    .filter((x) => x.release_id && x.title)
    .map((item) => ({ ...item, match: scoreHunterDiscogsCandidate(item, identity) }))
    .sort((a, b) => b.match.score - a.match.score);
  return {
    ok: true, status: result.status, rate_limit: result.rate_limit,
    body: { provider: "DISCOGS", query_kind: queryKind, count: items.length, items }
  };
}

export function calculateHunterEconomics(input = {}) {
  const cost = Number(input.cost_jpy || 0);
  const price = Number(input.price_jpy || 0);
  const feeRate = Number(input.fee_rate_pct || 0);
  const shipping = Number(input.shipping_jpy || 0);
  const packaging = Number(input.packaging_jpy || 0);
  const fee = Math.round(price * feeRate / 100);
  return { fee_jpy: fee, estimated_profit_jpy: price - cost - fee - shipping - packaging };
}

export async function hunterDiscogsStats(env, releaseId) {
  const id = asTrimmedString(releaseId);
  if (!/^\d+$/.test(id)) return { ok: false, status: 400, error: "INVALID_RELEASE_ID" };

  const result = await discogsRequest(
    env,
    "/marketplace/stats/" + encodeURIComponent(id) + "?curr_abbr=JPY"
  );
  if (!result.ok) return result;

  const lowest = Number(result.body?.lowest_price?.value);
  return {
    ok: true,
    status: result.status,
    rate_limit: result.rate_limit,
    body: {
      release_id: id,
      lowest_price_jpy: Number.isFinite(lowest) ? Math.max(0, Math.round(lowest)) : null,
      num_for_sale: Number.isFinite(Number(result.body?.num_for_sale))
        ? Number(result.body.num_for_sale)
        : null
    }
  };
}

export function validateHunterAdd(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid JSON body" };
  }

  const releaseId = asTrimmedString(body.release_id);
  const title = asTrimmedString(body.title);
  const provider = asTrimmedString(body.provider || "MUSICBRAINZ").toUpperCase();
  if (!/^[A-Za-z0-9-]{6,64}$/.test(releaseId)) return { ok: false, error: "release_id required" };
  if (!title) return { ok: false, error: "title required" };
  if (!new Set(["MUSICBRAINZ","DISCOGS"]).has(provider)) return { ok: false, error: "invalid provider" };

  const cost = asInteger(body.cost_jpy == null ? 0 : body.cost_jpy, "cost_jpy", { min: 0 });
  if (!cost.ok) return cost;
  const price = asInteger(body.price_jpy, "price_jpy", { min: 0, nullable: true });
  if (!price.ok) return price;
  const lowest = asInteger(body.lowest_market_jpy, "lowest_market_jpy", { min: 0, nullable: true });
  if (!lowest.ok) return lowest;
  const quantity = asInteger(body.quantity == null ? 1 : body.quantity, "quantity", { min: 1 });
  if (!quantity.ok) return quantity;
  const feeRate = Number(body.fee_rate_pct == null || body.fee_rate_pct === "" ? 0 : body.fee_rate_pct);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 100) return { ok: false, error: "fee_rate_pct must be 0..100" };
  const shipping = asInteger(body.shipping_jpy == null ? 0 : body.shipping_jpy, "shipping_jpy", { min: 0 });
  if (!shipping.ok) return shipping;
  const packaging = asInteger(body.packaging_jpy == null ? 0 : body.packaging_jpy, "packaging_jpy", { min: 0 });
  if (!packaging.ok) return packaging;
  const marketNum = asInteger(body.market_num_for_sale, "market_num_for_sale", { min: 0, nullable: true });
  if (!marketNum.ok) return marketNum;

  const sourceUrl = asOptionalString(body.source_url);
  const barcode = asOptionalString(body.barcode);

  return {
    ok: true,
    value: {
      release_id: releaseId,
      provider,
      title,
      format: asOptionalString(body.format),
      cost_jpy: cost.value,
      price_jpy: price.value,
      location: asOptionalString(body.location),
      quantity: quantity.value,
      source_url: sourceUrl,
      query_text: asOptionalString(body.query_text),
      barcode,
      lowest_market_jpy: lowest.value,
      fee_rate_pct: feeRate,
      shipping_jpy: shipping.value,
      packaging_jpy: packaging.value,
      market_provider: asOptionalString(body.market_provider),
      market_source_id: asOptionalString(body.market_source_id),
      market_source_url: asOptionalString(body.market_source_url),
      market_num_for_sale: marketNum.value,
      market_fetched_at: asOptionalString(body.market_fetched_at)
    }
  };
}

async function hunterAddToInventory(request, env) {
  const parsed = validateHunterAdd(await request.json().catch(() => null));
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const v = parsed.value;
  const sku = "HUNT-" + v.release_id + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();
  const economics = calculateHunterEconomics(v);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO inventory
         (sku,status,sync_state,category,product_name,format,cost_jpy,price_jpy,location,quantity,updated_at)
         VALUES (?,'AVAILABLE','HUNTER','MUSIC',?,?,?,?,?,?,CURRENT_TIMESTAMP)`
      ).bind(
        sku,
        v.title,
        v.format,
        v.cost_jpy,
        v.price_jpy,
        v.location,
        v.quantity
      ),
      env.DB.prepare(
        `INSERT INTO hunter_intake
         (sku,provider,source_id,source_url,query_text,barcode,lowest_market_jpy)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(
        sku, v.provider, v.release_id, v.source_url, v.query_text, v.barcode, v.lowest_market_jpy
      ),
      env.DB.prepare(
        `INSERT INTO hunter_economics
         (sku,fee_rate_pct,fee_jpy,shipping_jpy,packaging_jpy,estimated_profit_jpy,market_provider,market_source_id,market_source_url,market_num_for_sale,market_fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        sku, v.fee_rate_pct, economics.fee_jpy, v.shipping_jpy, v.packaging_jpy, economics.estimated_profit_jpy,
        v.market_provider, v.market_source_id, v.market_source_url, v.market_num_for_sale, v.market_fetched_at
      )
    ]);
  } catch (error) {
    return json({
      ok: false,
      error: "HUNTER_INVENTORY_WRITE_FAILED",
      detail: String(error?.message || error).slice(0, 240)
    }, 500);
  }

  return json({
    ok: true,
    sku,
    item: await inventoryDetail(env, sku),
    source: {
      provider: v.provider,
      release_id: v.release_id,
      source_url: v.source_url
    }
  }, 201);
}


export function normalizeDiscogsListing(listing) {
  const release = listing?.release || {};
  const price = listing?.price || {};
  const quantityRaw = Number(listing?.quantity ?? 1);
  const quantity = Number.isInteger(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
  const format = Array.isArray(release?.format)
    ? release.format.join(", ")
    : (release?.format || null);

  return {
    listing_id: listing?.id == null ? null : String(listing.id),
    release_id: release?.id == null ? null : String(release.id),
    external_id: listing?.external_id == null ? null : String(listing.external_id),
    title: release?.description || release?.title || listing?.title || null,
    format,
    media_condition: listing?.condition || null,
    sleeve_condition: listing?.sleeve_condition || null,
    price: Number.isFinite(Number(price?.value)) ? Number(price.value) : null,
    currency: price?.currency || null,
    quantity,
    status: listing?.status || null,
    location: listing?.location || null,
    comments: listing?.comments || null,
    uri: listing?.uri || null
  };
}

async function discogsInventoryPage(env, username, { page = 1, perPage = 50 } = {}) {
  const safePage = Math.max(1, Math.min(10000, Number(page) || 1));
  const safePerPage = Math.max(1, Math.min(100, Number(perPage) || 50));
  const path = `/users/${encodeURIComponent(username)}/inventory?status=For%20Sale&page=${safePage}&per_page=${safePerPage}`;
  const result = await discogsRequest(env, path);
  if (!result.ok) return result;

  return {
    ok: true,
    status: result.status,
    rate_limit: result.rate_limit,
    body: {
      username,
      pagination: result.body?.pagination || null,
      listings: Array.isArray(result.body?.listings)
        ? result.body.listings.map(normalizeDiscogsListing)
        : []
    }
  };
}

export async function discogsForSale(env, { page = 1, perPage = 50 } = {}) {
  const identity = await discogsIdentity(env);
  if (!identity.ok) return identity;

  const username = identity.body?.username;
  if (!username) return { ok: false, status: 502, error: "DISCOGS_IDENTITY_USERNAME_MISSING" };

  return discogsInventoryPage(env, username, { page, perPage });
}

function discogsSku(listing) {
  const external = asTrimmedString(listing?.external_id);
  if (external && /^[A-Za-z0-9._:-]{1,80}$/.test(external)) return external;
  return listing?.listing_id ? `DISC-${listing.listing_id}` : null;
}

export function discogsImportPlan(listing) {
  const sku = discogsSku(listing);
  const title = asTrimmedString(listing?.title);
  const listingId = asTrimmedString(listing?.listing_id);

  if (!sku) return { ok: false, error: "DISCOGS_LISTING_ID_MISSING" };
  if (!listingId) return { ok: false, error: "DISCOGS_LISTING_ID_MISSING" };
  if (!title) return { ok: false, error: "DISCOGS_TITLE_MISSING", listing_id: listingId };

  const currency = asTrimmedString(listing?.currency).toUpperCase();
  const priceJpy = currency === "JPY" && Number.isFinite(Number(listing?.price))
    ? Math.max(0, Math.round(Number(listing.price)))
    : null;
  const quantityRaw = Number(listing?.quantity ?? 1);
  const quantity = Number.isInteger(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;
  const normalizedStatus = normalizeListingStatus(listing?.status);
  const listingStatus = normalizedStatus.ok ? normalizedStatus.value : "ERROR";

  return {
    ok: true,
    value: {
      sku,
      inventory: {
        category: "MUSIC",
        product_name: title,
        format: asOptionalString(listing?.format),
        media_condition: asOptionalString(listing?.media_condition),
        sleeve_condition: asOptionalString(listing?.sleeve_condition),
        price_jpy: priceJpy,
        location: asOptionalString(listing?.location),
        quantity
      },
      channel: {
        channel: "DISCOGS",
        external_id: listingId,
        listing_status: listingStatus,
        listing_url: asOptionalString(listing?.uri),
        price_jpy: priceJpy,
        quantity,
        last_note: [
          listing?.release_id ? `release_id=${listing.release_id}` : null,
          currency && currency !== "JPY" ? `source_currency=${currency}` : null,
          listing?.comments ? `comments=${String(listing.comments).slice(0, 160)}` : null
        ].filter(Boolean).join(" | ") || null
      }
    }
  };
}

async function syncDiscogsForSale(env, { maxPages = 20, perPage = 100, apply = false } = {}) {
  const safeMaxPages = Math.max(1, Math.min(20, Number(maxPages) || 20));
  const safePerPage = Math.max(1, Math.min(100, Number(perPage) || 100));

  const identity = await discogsIdentity(env);
  if (!identity.ok) return identity;

  const username = identity.body?.username;
  if (!username) return { ok: false, status: 502, error: "DISCOGS_IDENTITY_USERNAME_MISSING" };

  const first = await discogsInventoryPage(env, username, { page: 1, perPage: safePerPage });
  if (!first.ok) return first;

  const pages = Math.max(1, Math.min(
    safeMaxPages,
    Number(first.body?.pagination?.pages || 1) || 1
  ));
  const all = [...(first.body?.listings || [])];

  for (let page = 2; page <= pages; page += 1) {
    const next = await discogsInventoryPage(env, username, { page, perPage: safePerPage });
    if (!next.ok) return next;
    all.push(...(next.body?.listings || []));
  }

  const plans = all.map(discogsImportPlan);
  const invalid = plans.filter((plan) => !plan.ok);
  const valid = plans.filter((plan) => plan.ok).map((plan) => plan.value);

  if (!apply) {
    return {
      ok: true,
      status: 200,
      body: {
        mode: "dry-run",
        username,
        pages_read: pages,
        listings_seen: all.length,
        valid: valid.length,
        invalid: invalid.length,
        plans: valid.map((plan) => ({
          sku: plan.sku,
          product_name: plan.inventory.product_name,
          external_id: plan.channel.external_id,
          listing_status: plan.channel.listing_status,
          price_jpy: plan.channel.price_jpy,
          quantity: plan.channel.quantity
        })),
        errors: invalid
      }
    };
  }

  let created = 0;
  let linked = 0;
  let updated = 0;
  const conflicts = [];

  for (const plan of valid) {
    const existingListing = await env.DB.prepare(
      "SELECT id,sku FROM channel_listings WHERE channel='DISCOGS' AND external_id=? LIMIT 1"
    ).bind(plan.channel.external_id).first();

    if (existingListing) {
      await env.DB.prepare(
        `UPDATE channel_listings
            SET listing_status=?,listing_url=?,price_jpy=?,quantity=?,last_note=?,last_synced_at=CURRENT_TIMESTAMP
          WHERE id=?`
      ).bind(
        plan.channel.listing_status,
        plan.channel.listing_url,
        plan.channel.price_jpy,
        plan.channel.quantity,
        plan.channel.last_note,
        existingListing.id
      ).run();
      updated += 1;
      continue;
    }

    let item = await env.DB.prepare(
      "SELECT sku FROM inventory WHERE sku=? LIMIT 1"
    ).bind(plan.sku).first();

    if (!item) {
      await env.DB.prepare(
        `INSERT INTO inventory
         (sku,category,product_name,format,media_condition,sleeve_condition,cost_jpy,price_jpy,location,quantity,sync_state,updated_at)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,CURRENT_TIMESTAMP)`
      ).bind(
        plan.sku,
        plan.inventory.category,
        plan.inventory.product_name,
        plan.inventory.format,
        plan.inventory.media_condition,
        plan.inventory.sleeve_condition,
        plan.inventory.price_jpy,
        plan.inventory.location,
        plan.inventory.quantity,
        "SYNCED"
      ).run();
      created += 1;
      item = { sku: plan.sku };
    }

    try {
      await env.DB.prepare(
        `INSERT INTO channel_listings
         (sku,channel,external_id,listing_status,listing_url,price_jpy,quantity,last_note,last_synced_at)
         VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
      ).bind(
        item.sku,
        plan.channel.channel,
        plan.channel.external_id,
        plan.channel.listing_status,
        plan.channel.listing_url,
        plan.channel.price_jpy,
        plan.channel.quantity,
        plan.channel.last_note
      ).run();
      linked += 1;
    } catch (error) {
      conflicts.push({
        sku: item.sku,
        external_id: plan.channel.external_id,
        error: String(error?.message || error).slice(0, 240)
      });
    }
  }

  return {
    ok: conflicts.length === 0,
    status: conflicts.length === 0 ? 200 : 409,
    body: {
      mode: "apply",
      username,
      pages_read: pages,
      listings_seen: all.length,
      valid: valid.length,
      invalid: invalid.length,
      inventory_created: created,
      listings_linked: linked,
      listings_updated: updated,
      conflicts,
      errors: invalid
    }
  };
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

export function shouldClearStopPending(status, syncState, listedCount) {
  return status === "SOLD" && syncState === "STOP_PENDING" && Number(listedCount || 0) === 0;
}

async function refreshStopPending(env, sku) {
  const item = await env.DB.prepare(
    "SELECT status,sync_state FROM inventory WHERE sku=? LIMIT 1"
  ).bind(sku).first();

  if (!item) return false;

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM channel_listings WHERE sku=? AND listing_status='LISTED'"
  ).bind(sku).first();

  if (!shouldClearStopPending(item.status, item.sync_state, row?.count)) return false;

  await env.DB.prepare(
    "UPDATE inventory SET sync_state='SYNCED',updated_at=CURRENT_TIMESTAMP WHERE sku=?"
  ).bind(sku).run();
  return true;
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

  const normalizedStatus = normalizeListingStatus(body.listing_status);
  if (!normalizedStatus.ok) return json({ ok: false, error: normalizedStatus.error }, 400);
  const status = normalizedStatus.value;
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

  const syncCleared = status !== "LISTED" ? await refreshStopPending(env, sku) : false;
  const item = await inventoryDetail(env, sku);
  return json({
    ok: true,
    listing: item.listings.find((x) => x.channel === channel && x.external_id === externalId) || null,
    sync_state: item.sync_state,
    stop_pending_cleared: syncCleared
  }, existing ? 200 : 201);
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

    if (pathname === "/oauth/ebay/callback" && request.method === "GET") {
      return ebayOAuthCallback(request, env);
    }

    if (pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "reuse-os-core-v0",
        version: "0.2.0",
        bindings: { d1: !!env.DB, r2: !!env.MEDIA },
        connectors: { discogs: !!env.DISCOGS_TOKEN, musicbrainz: true, ebay: true, vision_secret: !!env.GOOGLE_VISION_API_KEY },
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
    if (pathname === "/api/connectors/vision/config" && request.method === "POST") {
      return saveVisionConfig(request, env);
    }

    if (pathname === "/api/connectors/vision/status" && request.method === "GET") {
      return visionStatus(request, env);
    }

    if (pathname === "/api/hunter/vision" && request.method === "POST") {
      return analyzeHunterImage(request, env);
    }

    if (pathname === "/api/hunter/search" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const r = await hunterSearchMusicBrainz(env, body?.query);
      return json(
        {
          ok: r.ok,
          status: r.status,
          data: r.ok ? r.body : null,
          error: r.ok ? null : r.error || r.body,
          retry_after: r.retry_after || null
        },
        r.ok ? 200 : r.status || 502
      );
    }

    if (pathname === "/api/hunter/market" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const r = await hunterMatchDiscogs(env, body || {});
      return json(
        { ok: r.ok, status: r.status, data: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body, rate_limit: r.rate_limit || null },
        r.ok ? 200 : r.status || 502
      );
    }

    const hunterStats = pathname.match(/^\/api\/hunter\/stats\/([^/]+)$/);
    if (hunterStats && request.method === "GET") {
      const r = await hunterDiscogsStats(env, decodeURIComponent(hunterStats[1]));
      return json(
        { ok: r.ok, status: r.status, data: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body, rate_limit: r.rate_limit || null },
        r.ok ? 200 : r.status || 502
      );
    }

    if (pathname === "/api/hunter/add" && request.method === "POST") {
      return hunterAddToInventory(request, env);
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

    if (pathname === "/api/connectors/ebay/config" && request.method === "POST") {
      return saveEbayConfig(request, env);
    }

    if (pathname === "/api/connectors/ebay/oauth/status" && request.method === "GET") {
      return ebayOAuthStatus(request, env);
    }

    if (pathname === "/api/connectors/ebay/oauth/start" && request.method === "GET") {
      return ebayOAuthStart(request, env);
    }

    if (pathname === "/api/connectors/ebay/tokens/import" && request.method === "POST") {
      return importEbaySandboxToken(request, env);
    }

    if (pathname === "/api/connectors/ebay/privileges" && request.method === "GET") {
      return ebayPrivileges(request, env);
    }

    if (pathname === "/api/connectors/ebay/disconnect" && request.method === "POST") {
      return disconnectEbay(request, env);
    }

    if (pathname === "/api/connectors/discogs/identity" && request.method === "GET") {
      const r = await discogsIdentity(env);
      return json(
        { ok: r.ok, status: r.status, identity: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body },
        r.ok ? 200 : r.status || 502
      );
    }
    if (pathname === "/api/connectors/discogs/listings" && request.method === "GET") {
      const page = Number(url.searchParams.get("page") || 1);
      const perPage = Number(url.searchParams.get("per_page") || 50);
      const r = await discogsForSale(env, { page, perPage });
      return json(
        { ok: r.ok, status: r.status, data: r.ok ? r.body : null, error: r.ok ? null : r.error || r.body, rate_limit: r.rate_limit || null },
        r.ok ? 200 : r.status || 502
      );
    }

    if (pathname === "/api/connectors/discogs/sync" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const r = await syncDiscogsForSale(env, {
        maxPages: body?.max_pages,
        perPage: body?.per_page,
        apply: body?.apply === true
      });
      return json(
        { ok: r.ok, status: r.status, data: r.body || null, error: r.ok ? null : r.error || null },
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
