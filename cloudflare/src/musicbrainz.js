const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "7thleaf-ReuseOS/0.4 (https://github.com/7thleaf-gd/reuse-os)";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let lastRequestAt = 0;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonSafeParse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeLucenePhrase(value) {
  return clean(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/([+\-!(){}\[\]^~*?:\/])/g, "\\$1");
}

function isBarcode(value) {
  return /^\d{8,14}$/.test(clean(value).replace(/[\s-]/g, ""));
}

function looksLikeCatno(value) {
  const s = clean(value);
  return s.length <= 32 &&
    /[A-Za-z]/.test(s) &&
    /\d/.test(s) &&
    /^[A-Za-z0-9._\-\s/]+$/.test(s);
}

export function buildMusicBrainzQuery(raw) {
  const value = clean(raw);
  if (!value) return null;

  const compact = value.replace(/[\s-]/g, "");
  if (isBarcode(value)) return {
    query: `barcode:"${compact}"`,
    barcode: compact,
    kind: "barcode"
  };

  const q = escapeLucenePhrase(value);
  const fields = [
    `artist:"${q}"`,
    `release:"${q}"`
  ];
  if (looksLikeCatno(value)) fields.unshift(`catno:"${q}"`);

  return {
    query: fields.join(" OR "),
    barcode: null,
    kind: looksLikeCatno(value) ? "catalog" : "text"
  };
}

function artistCreditText(credit) {
  if (!Array.isArray(credit)) return null;
  const out = [];
  for (const part of credit) {
    const name = clean(part?.name || part?.artist?.name);
    if (name) out.push(name);
    if (part?.joinphrase) out.push(String(part.joinphrase));
  }
  return out.join("").trim() || null;
}

function firstLabelInfo(info) {
  if (!Array.isArray(info) || !info.length) return { label: null, catno: null };
  const row = info.find((x) => x?.label?.name || x?.["catalog-number"]) || info[0];
  return {
    label: clean(row?.label?.name) || null,
    catno: clean(row?.["catalog-number"]) || null
  };
}

function mediaFormat(media) {
  if (!Array.isArray(media)) return null;
  const formats = [...new Set(media.map((x) => clean(x?.format)).filter(Boolean))];
  return formats.join(", ") || null;
}

export function normalizeMusicBrainzRelease(release) {
  const id = clean(release?.id);
  const title = clean(release?.title);
  const artist = artistCreditText(release?.["artist-credit"]);
  const label = firstLabelInfo(release?.["label-info"]);
  const format = mediaFormat(release?.media);
  const scoreRaw = Number(release?.score);

  return {
    provider: "MUSICBRAINZ",
    release_id: id || null,
    title: artist && title ? `${artist} - ${title}` : (title || artist || null),
    release_title: title || null,
    artist,
    year: clean(release?.date).slice(0, 4) || null,
    date: clean(release?.date) || null,
    country: clean(release?.country) || null,
    format,
    label: label.label,
    catno: label.catno,
    barcode: clean(release?.barcode) || null,
    primary_type: clean(release?.["release-group"]?.["primary-type"]) || null,
    score: Number.isFinite(scoreRaw) ? scoreRaw : null,
    thumb: id ? `https://coverartarchive.org/release/${encodeURIComponent(id)}/front-250` : null,
    cover_image: id ? `https://coverartarchive.org/release/${encodeURIComponent(id)}/front-500` : null,
    uri: id ? `https://musicbrainz.org/release/${encodeURIComponent(id)}` : null,
    discogs_release_id: null
  };
}

async function cacheGet(env, key) {
  if (!env?.DB) return null;
  const row = await env.DB.prepare(
    "SELECT payload,expires_at FROM hunter_cache WHERE cache_key=? LIMIT 1"
  ).bind(key).first();
  if (!row || Number(row.expires_at || 0) <= Date.now()) return null;
  return jsonSafeParse(row.payload);
}

async function cachePut(env, key, payload) {
  if (!env?.DB) return;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO hunter_cache (cache_key,provider,payload,fetched_at,expires_at)
     VALUES (?,'MUSICBRAINZ',?,?,?)
     ON CONFLICT(cache_key) DO UPDATE SET
       provider='MUSICBRAINZ',
       payload=excluded.payload,
       fetched_at=excluded.fetched_at,
       expires_at=excluded.expires_at`
  ).bind(key, JSON.stringify(payload), now, now + CACHE_TTL_MS).run();
}

async function musicBrainzFetch(path) {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 1100) await sleep(1100 - elapsed);
  lastRequestAt = Date.now();

  const response = await fetch(MB_BASE + path, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT
    }
  });
  const text = await response.text();
  const body = jsonSafeParse(text);

  return {
    ok: response.ok,
    status: response.status,
    body,
    retry_after: Number(response.headers.get("retry-after") || 0) || null
  };
}

export async function hunterSearchMusicBrainz(env, rawQuery) {
  const raw = clean(rawQuery);
  if (!raw) return { ok: false, status: 400, error: "HUNTER_QUERY_REQUIRED" };
  if (raw.length > 200) return { ok: false, status: 400, error: "HUNTER_QUERY_TOO_LONG" };

  const built = buildMusicBrainzQuery(raw);
  const cacheKey = "mb:release-search:" + raw.toLowerCase().replace(/\s+/g, " ");
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    return { ok: true, status: 200, body: { ...cached, cache: "HIT" } };
  }

  const params = new URLSearchParams({
    query: built.query,
    fmt: "json",
    limit: "12"
  });
  const result = await musicBrainzFetch("/release/?" + params.toString());
  if (!result.ok) {
    return {
      ok: false,
      status: result.status || 502,
      error: "MUSICBRAINZ_SEARCH_FAILED",
      provider_error: result.body?.error || null,
      retry_after: result.retry_after
    };
  }

  const items = Array.isArray(result.body?.releases)
    ? result.body.releases.map(normalizeMusicBrainzRelease).filter((x) => x.release_id && x.title)
    : [];

  const body = {
    provider: "MUSICBRAINZ",
    query: raw,
    query_kind: built.kind,
    barcode: built.barcode,
    count: items.length,
    items,
    cache: "MISS"
  };
  await cachePut(env, cacheKey, body);
  return { ok: true, status: 200, body };
}
