const TEXT = new TextEncoder();
const VISION_AAD = TEXT.encode("reuse-os:vision:v1");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function visionKey(secret) {
  if (!secret) throw new Error("ENCRYPTION_SECRET_NOT_CONFIGURED");
  const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT.encode("vision-key:" + secret)));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptVisionPayload(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await visionKey(secret);
  const plaintext = TEXT.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: VISION_AAD },
    key,
    plaintext
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv)
  };
}

async function decryptVisionPayload(ciphertext, iv, secret) {
  const key = await visionKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: VISION_AAD },
    key,
    base64UrlToBytes(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function loadVisionRecord(env) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT ciphertext,iv FROM connector_secrets WHERE provider='GOOGLE_VISION' LIMIT 1"
  ).first();
  if (!row) return null;
  try {
    return await decryptVisionPayload(row.ciphertext, row.iv, env.ADMIN_TOKEN);
  } catch {
    throw new Error("VISION_SECRET_DECRYPT_FAILED");
  }
}

async function saveVisionRecord(env, value) {
  if (!env.DB) throw new Error("D1_NOT_CONFIGURED");
  const encrypted = await encryptVisionPayload(value, env.ADMIN_TOKEN);
  await env.DB.prepare(
    `INSERT INTO connector_secrets (provider,ciphertext,iv,updated_at)
     VALUES ('GOOGLE_VISION',?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       ciphertext=excluded.ciphertext,
       iv=excluded.iv,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(encrypted.ciphertext, encrypted.iv).run();
}

async function resolveVisionApiKey(env) {
  const workerKey = clean(env.GOOGLE_VISION_API_KEY);
  if (workerKey) return { key: workerKey, source: "worker_secret" };

  const record = await loadVisionRecord(env);
  const d1Key = clean(record && record.api_key);
  if (d1Key) return { key: d1Key, source: "encrypted_d1" };

  return { key: null, source: null };
}

export async function saveVisionConfig(request, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, 503);
  if (!env.DB) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "INVALID_JSON_BODY" }, 400);
  }

  const apiKey = clean(body.api_key);
  if (!apiKey) return json({ ok: false, error: "VISION_API_KEY_REQUIRED" }, 400);

  await saveVisionRecord(env, { api_key: apiKey });
  return json({ ok: true, configured: true, source: "encrypted_d1" });
}

export async function visionStatus(request, env) {
  try {
    const resolved = await resolveVisionApiKey(env);
    return json({
      ok: true,
      configured: !!resolved.key,
      source: resolved.source
    });
  } catch (error) {
    return json({ ok: false, error: error.message || "VISION_STATUS_FAILED" }, 500);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + size, bytes.length))));
  }
  return btoa(chunks.join(""));
}

function scoreEntity(entity) {
  const score = Number(entity?.score);
  return Number.isFinite(score) ? score : 0;
}

export function normalizeVisionAnnotation(annotation) {
  const web = annotation?.webDetection || {};
  const bestGuess = Array.isArray(web.bestGuessLabels)
    ? web.bestGuessLabels.map((x) => clean(x?.label)).filter(Boolean)
    : [];
  const webEntities = Array.isArray(web.webEntities)
    ? web.webEntities
        .filter((x) => clean(x?.description))
        .sort((a, b) => scoreEntity(b) - scoreEntity(a))
        .slice(0, 10)
        .map((x) => ({ description: clean(x.description), score: scoreEntity(x) }))
    : [];

  const fullText = clean(
    annotation?.fullTextAnnotation?.text ||
    annotation?.textAnnotations?.[0]?.description ||
    ""
  );
  const ocrLines = fullText
    ? fullText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20)
    : [];

  const logos = Array.isArray(annotation?.logoAnnotations)
    ? annotation.logoAnnotations
        .map((x) => ({ description: clean(x?.description), score: Number(x?.score) || 0 }))
        .filter((x) => x.description)
        .slice(0, 8)
    : [];

  const pages = Array.isArray(web.pagesWithMatchingImages)
    ? web.pagesWithMatchingImages
        .map((x) => ({ url: clean(x?.url), page_title: clean(x?.pageTitle) }))
        .filter((x) => x.url)
        .slice(0, 8)
    : [];

  return {
    best_guess_labels: bestGuess,
    web_entities: webEntities,
    ocr_lines: ocrLines,
    logos,
    matching_pages: pages
  };
}

function compactVisionText(value) {
  return clean(value)
    .replace(/\s+/g, " ")
    .replace(/\s*[|｜]\s*(Discogs|Spotify|Apple Music|Bandcamp|Amazon.*)$/i, "")
    .replace(/\s*[-–—]\s*(Discogs|Wikipedia|YouTube)$/i, "")
    .trim();
}

function visionTokens(value) {
  return compactVisionText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((x) => x.length >= 2);
}

function containsAllWords(haystack, needle) {
  const h = new Set(visionTokens(haystack));
  const n = visionTokens(needle);
  return n.length > 0 && n.every((x) => h.has(x));
}

function looksLikeCatalogNumber(value) {
  const s = compactVisionText(value);
  return /^[A-Z0-9]{1,8}[-_. ]?[A-Z0-9]{2,10}$/i.test(s) && /\d/.test(s);
}

function uniqueVisionQueries(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const q = compactVisionText(value).slice(0, 180);
    if (!q || q.length < 3) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out.slice(0, 6);
}

export function buildVisionQueryCandidates(normalized) {
  const best = compactVisionText(normalized?.best_guess_labels?.find(Boolean) || "");
  const entities = (normalized?.web_entities || [])
    .filter((x) => clean(x?.description) && Number(x?.score || 0) >= 0.25)
    .map((x) => compactVisionText(x.description))
    .filter(Boolean);
  const ocr = (normalized?.ocr_lines || []).map(compactVisionText).filter(Boolean);
  const pages = (normalized?.matching_pages || [])
    .map((x) => compactVisionText(x?.page_title))
    .filter(Boolean);

  const candidates = [];

  // Matching page titles often contain the full "Artist - Release" identity.
  for (const page of pages) {
    if (best && containsAllWords(page, best)) candidates.push(page);
    else if (/\s[-–—:]\s/.test(page)) candidates.push(page);
  }

  // Join a strong web entity with the generic best guess ("Still Life" -> "Opeth Still Life").
  for (const entity of entities.slice(0, 4)) {
    if (best && !containsAllWords(entity, best) && !containsAllWords(best, entity)) {
      candidates.push(entity + " " + best);
    }
  }

  // OCR often contains artist/title/catalog number. Pair useful lines with the visual guess.
  const usefulOcr = ocr.filter((line) => line.length >= 3 && line.length <= 80);
  for (const line of usefulOcr.slice(0, 6)) {
    if (best && !containsAllWords(line, best) && !containsAllWords(best, line)) {
      candidates.push(line + " " + best);
    }
  }

  const catalog = usefulOcr.find(looksLikeCatalogNumber);
  if (best && catalog) candidates.push(best + " " + catalog);

  if (entities.length >= 2) candidates.push(entities.slice(0, 3).join(" "));
  if (best) candidates.push(best);
  if (usefulOcr.length >= 2) candidates.push(usefulOcr.slice(0, 3).join(" "));

  return uniqueVisionQueries(candidates);
}

export function suggestVisionQuery(normalized) {
  return buildVisionQueryCandidates(normalized)[0] || null;
}

export async function analyzeHunterImage(request, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, 503);

  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(type)) {
    return json({ ok: false, error: "UNSUPPORTED_IMAGE_TYPE" }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    return json({ ok: false, error: "IMAGE_TOO_LARGE", max_bytes: MAX_IMAGE_BYTES }, 413);
  }

  let resolved;
  try {
    resolved = await resolveVisionApiKey(env);
  } catch (error) {
    return json({ ok: false, error: error.message || "VISION_CONFIG_READ_FAILED" }, 500);
  }
  if (!resolved.key) return json({ ok: false, error: "VISION_NOT_CONFIGURED" }, 409);

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) return json({ ok: false, error: "IMAGE_REQUIRED" }, 400);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return json({ ok: false, error: "IMAGE_TOO_LARGE", max_bytes: MAX_IMAGE_BYTES }, 413);
  }

  const body = {
    requests: [{
      image: { content: arrayBufferToBase64(buffer) },
      features: [
        { type: "WEB_DETECTION", maxResults: 12 },
        { type: "TEXT_DETECTION" },
        { type: "LOGO_DETECTION", maxResults: 8 }
      ]
    }]
  };

  const response = await fetch(
    "https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(resolved.key),
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    }
  );

  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

  if (!response.ok) {
    return json({
      ok: false,
      error: "VISION_API_FAILED",
      status: response.status,
      provider_error: payload?.error?.message || null
    }, response.status >= 400 && response.status < 600 ? response.status : 502);
  }

  const annotation = payload?.responses?.[0] || {};
  if (annotation.error) {
    return json({
      ok: false,
      error: "VISION_ANNOTATION_FAILED",
      provider_error: annotation.error.message || null
    }, 502);
  }

  const normalized = normalizeVisionAnnotation(annotation);
  const candidateQueries = buildVisionQueryCandidates(normalized);
  const suggestedQuery = candidateQueries[0] || null;

  return json({
    ok: true,
    source: resolved.source,
    suggested_query: suggestedQuery,
    candidate_queries: candidateQueries,
    vision: normalized
  });
}
