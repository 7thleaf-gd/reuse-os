const TEXT = new TextEncoder();
const EBAY_AAD = TEXT.encode("reuse-os:ebay:v1");
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const ACCESS_REFRESH_MARGIN_MS = 60 * 1000;

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
];

export function ebayHosts(environment = "sandbox") {
  const production = String(environment || "").toLowerCase() === "production";
  return production
    ? { auth: "https://auth.ebay.com", api: "https://api.ebay.com", environment: "production" }
    : { auth: "https://auth.sandbox.ebay.com", api: "https://api.sandbox.ebay.com", environment: "sandbox" };
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

async function derivedKeyBytes(secret, purpose) {
  if (!secret) throw new Error("ENCRYPTION_SECRET_NOT_CONFIGURED");
  return new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT.encode(purpose + ":" + secret)));
}

async function aesKey(secret) {
  const raw = await derivedKeyBytes(secret, "ebay-token");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function hmacKey(secret) {
  const raw = await derivedKeyBytes(secret, "ebay-state");
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function encryptEbayPayload(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const plaintext = TEXT.encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: EBAY_AAD },
    key,
    plaintext
  );
  return {
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
    iv: bytesToBase64Url(iv)
  };
}

export async function decryptEbayPayload(ciphertext, iv, secret) {
  const key = await aesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(iv), additionalData: EBAY_AAD },
    key,
    base64UrlToBytes(ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

export async function signEbayState(secret, now = Date.now(), nonce = crypto.randomUUID()) {
  const payload = bytesToBase64Url(TEXT.encode(JSON.stringify({ t: now, n: nonce })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), TEXT.encode(payload));
  return payload + "." + bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyEbayState(state, secret, now = Date.now()) {
  const parts = String(state || "").split(".");
  if (parts.length !== 2) return { ok: false, error: "INVALID_STATE" };

  const [payload, signature] = parts;
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    return { ok: false, error: "INVALID_STATE" };
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    base64UrlToBytes(signature),
    TEXT.encode(payload)
  );
  if (!valid) return { ok: false, error: "INVALID_STATE" };
  if (!Number.isFinite(parsed.t) || now - parsed.t < -60_000 || now - parsed.t > STATE_MAX_AGE_MS) {
    return { ok: false, error: "STATE_EXPIRED" };
  }
  return { ok: true, issued_at: parsed.t, nonce: parsed.n };
}

function connectorDbReady(env) {
  return !!(env && env.DB);
}

async function loadRecord(env) {
  if (!connectorDbReady(env)) throw new Error("D1_NOT_CONFIGURED");
  const row = await env.DB.prepare(
    "SELECT ciphertext,iv FROM connector_secrets WHERE provider='EBAY' LIMIT 1"
  ).first();
  if (!row) return null;
  try {
    return await decryptEbayPayload(row.ciphertext, row.iv, env.ADMIN_TOKEN);
  } catch {
    throw new Error("EBAY_SECRET_DECRYPT_FAILED");
  }
}

async function saveRecord(env, value) {
  if (!connectorDbReady(env)) throw new Error("D1_NOT_CONFIGURED");
  const encrypted = await encryptEbayPayload(value, env.ADMIN_TOKEN);
  await env.DB.prepare(
    `INSERT INTO connector_secrets (provider,ciphertext,iv,updated_at)
     VALUES ('EBAY',?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(provider) DO UPDATE SET
       ciphertext=excluded.ciphertext,
       iv=excluded.iv,
       updated_at=CURRENT_TIMESTAMP`
  ).bind(encrypted.ciphertext, encrypted.iv).run();
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeEnvironment(value) {
  return String(value || "").toLowerCase() === "production" ? "production" : "sandbox";
}

function connectorPublicStatus(record, request) {
  const origin = new URL(request.url).origin;
  const tokens = record && record.tokens ? record.tokens : null;
  const now = Date.now();
  return {
    ok: true,
    configured: !!(record && record.client_id && record.client_secret && record.runame),
    connected: !!(tokens && tokens.refresh_token),
    environment: safeEnvironment(record && record.environment),
    callback_url: origin + "/oauth/ebay/callback",
    scopes: EBAY_SCOPES,
    client_id_tail: record && record.client_id ? String(record.client_id).slice(-8) : null,
    runame: record && record.runame ? record.runame : null,
    access_token_valid: !!(tokens && tokens.access_token && Number(tokens.access_expires_at || 0) > now),
    access_expires_at: tokens && tokens.access_expires_at ? tokens.access_expires_at : null,
    refresh_expires_at: tokens && tokens.refresh_expires_at ? tokens.refresh_expires_at : null
  };
}

export async function saveEbayConfig(request, env) {
  if (!connectorDbReady(env)) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "INVALID_JSON_BODY" }, 400);
  }

  const current = await loadRecord(env).catch(() => null);
  const clientId = clean(body.client_id) || clean(current && current.client_id);
  const clientSecret = clean(body.client_secret) || clean(current && current.client_secret);
  const runame = clean(body.runame) || clean(current && current.runame);
  const environment = safeEnvironment(body.environment || (current && current.environment));

  if (!clientId) return json({ ok: false, error: "EBAY_CLIENT_ID_REQUIRED" }, 400);
  if (!clientSecret) return json({ ok: false, error: "EBAY_CLIENT_SECRET_REQUIRED" }, 400);
  if (!runame) return json({ ok: false, error: "EBAY_RUNAME_REQUIRED" }, 400);

  const changed = !current ||
    current.client_id !== clientId ||
    current.client_secret !== clientSecret ||
    current.runame !== runame ||
    safeEnvironment(current.environment) !== environment;

  const next = {
    client_id: clientId,
    client_secret: clientSecret,
    runame,
    environment,
    tokens: changed ? null : (current.tokens || null)
  };
  await saveRecord(env, next);

  return json({
    ok: true,
    configured: true,
    connected: !!(next.tokens && next.tokens.refresh_token),
    reauthorization_required: changed,
    environment,
    callback_url: new URL(request.url).origin + "/oauth/ebay/callback",
    scopes: EBAY_SCOPES
  });
}

export async function ebayOAuthStatus(request, env) {
  if (!connectorDbReady(env)) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);
  try {
    const record = await loadRecord(env);
    return json(connectorPublicStatus(record, request));
  } catch (error) {
    return json({ ok: false, error: error.message || "EBAY_STATUS_FAILED" }, 500);
  }
}

export async function ebayOAuthStart(request, env) {
  if (!connectorDbReady(env)) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" }, 503);

  let record;
  try {
    record = await loadRecord(env);
  } catch (error) {
    return json({ ok: false, error: error.message || "EBAY_CONFIG_READ_FAILED" }, 500);
  }

  if (!record || !record.client_id || !record.client_secret || !record.runame) {
    return json({ ok: false, error: "EBAY_NOT_CONFIGURED" }, 409);
  }

  const hosts = ebayHosts(record.environment);
  const state = await signEbayState(env.ADMIN_TOKEN);
  const params = new URLSearchParams({
    client_id: record.client_id,
    redirect_uri: record.runame,
    response_type: "code",
    scope: EBAY_SCOPES.join(" "),
    state,
    prompt: "login"
  });

  return json({
    ok: true,
    environment: hosts.environment,
    auth_url: hosts.auth + "/oauth2/authorize?" + params.toString(),
    callback_url: new URL(request.url).origin + "/oauth/ebay/callback",
    scopes: EBAY_SCOPES
  });
}

async function ebayTokenRequest(record, payload) {
  const hosts = ebayHosts(record.environment);
  const basic = btoa(record.client_id + ":" + record.client_secret);
  const response = await fetch(hosts.api + "/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(payload).toString()
  });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body && (body.error_description || body.error) ? (body.error_description || body.error) : "EBAY_TOKEN_REQUEST_FAILED"
    };
  }
  return { ok: true, status: response.status, body };
}

function callbackHtml(result) {
  const ok = !!result.ok;
  const color = ok ? "#0a6b2b" : "#b00020";
  const title = ok ? "eBay接続完了" : "eBay接続エラー";
  const note = String(result.note || result.error || "").replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[ch]);
  return new Response(
    '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><body style="font-family:system-ui,sans-serif;padding:32px;max-width:640px;margin:auto">' +
    '<h1 style="color:' + color + '">' + title + '</h1><p>' + note + '</p>' +
    '<p><a href="/" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;border-radius:10px;text-decoration:none">Reuse OSへ戻る</a></p>' +
    '</body></html>',
    { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export function classifyEbayCallback(urlLike) {
  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike));
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  if (denied) {
    return {
      ok: false,
      type: "denied",
      error: url.searchParams.get("error_description") || denied,
      code,
      state
    };
  }

  if (code && state) return { ok: true, type: "oauth", code, state };

  const keys = [...new Set([...url.searchParams.keys()])].sort();
  const legacy = keys.some((key) => [
    "isAuthSuccessful",
    "ebaytkn",
    "tkn",
    "username"
  ].includes(key));

  return {
    ok: false,
    type: legacy ? "legacy_authnauth" : "missing",
    error: legacy ? "LEGACY_AUTHNAUTH_CALLBACK" : "OAUTH_CODE_OR_STATE_MISSING",
    keys
  };
}

export async function ebayOAuthCallback(request, env) {
  if (!connectorDbReady(env)) return callbackHtml({ ok: false, error: "D1_NOT_CONFIGURED" });
  if (!env.ADMIN_TOKEN) return callbackHtml({ ok: false, error: "ADMIN_TOKEN_NOT_CONFIGURED" });

  const url = new URL(request.url);
  const callback = classifyEbayCallback(url);

  if (!callback.ok) {
    if (callback.type === "denied") return callbackHtml({ ok: false, error: callback.error });

    const suffix = callback.keys && callback.keys.length
      ? " (received: " + callback.keys.join(", ") + ")"
      : "";

    const note = callback.type === "legacy_authnauth"
      ? "旧Auth'n'Authの戻り値を受信しました。eBay DevelopersでOAuth (new security)を選択・保存後、Reuse OSの「eBayと接続」からやり直してください。" + suffix
      : "OAuth code/stateがありません。このURLを直接開かず、Reuse OSの「eBayと接続」から認可を開始してください。" + suffix;

    return callbackHtml({ ok: false, error: note });
  }

  const { code, state } = callback;

  const stateCheck = await verifyEbayState(state, env.ADMIN_TOKEN);
  if (!stateCheck.ok) return callbackHtml(stateCheck);

  let record;
  try {
    record = await loadRecord(env);
  } catch (error) {
    return callbackHtml({ ok: false, error: error.message || "EBAY_CONFIG_READ_FAILED" });
  }
  if (!record) return callbackHtml({ ok: false, error: "EBAY_NOT_CONFIGURED" });

  const exchanged = await ebayTokenRequest(record, {
    grant_type: "authorization_code",
    code,
    redirect_uri: record.runame
  });
  if (!exchanged.ok) return callbackHtml(exchanged);

  const body = exchanged.body || {};
  if (!body.refresh_token || !body.access_token) {
    return callbackHtml({ ok: false, error: "EBAY_TOKEN_RESPONSE_INCOMPLETE" });
  }

  const now = Date.now();
  record.tokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires_at: now + Number(body.expires_in || 7200) * 1000,
    refresh_expires_at: now + Number(body.refresh_token_expires_in || 0) * 1000,
    scope: EBAY_SCOPES
  };
  await saveRecord(env, record);

  return callbackHtml({
    ok: true,
    note: "Sandbox OAuthをReuse OSへ保存しました。以後の短命アクセストークンは自動更新します。"
  });
}

async function getEbayAccessToken(env) {
  const record = await loadRecord(env);
  if (!record || !record.tokens || !record.tokens.refresh_token) {
    return { ok: false, error: "EBAY_NOT_CONNECTED" };
  }

  const now = Date.now();
  if (record.tokens.access_token &&
      Number(record.tokens.access_expires_at || 0) - ACCESS_REFRESH_MARGIN_MS > now) {
    return { ok: true, token: record.tokens.access_token, record };
  }

  const refreshed = await ebayTokenRequest(record, {
    grant_type: "refresh_token",
    refresh_token: record.tokens.refresh_token,
    scope: EBAY_SCOPES.join(" ")
  });
  if (!refreshed.ok) return refreshed;

  const body = refreshed.body || {};
  if (!body.access_token) return { ok: false, error: "EBAY_REFRESH_RESPONSE_INCOMPLETE" };

  record.tokens.access_token = body.access_token;
  record.tokens.access_expires_at = now + Number(body.expires_in || 7200) * 1000;
  record.tokens.scope = EBAY_SCOPES;
  await saveRecord(env, record);

  return { ok: true, token: body.access_token, record, refreshed: true };
}

export async function ebayPrivileges(request, env) {
  if (!connectorDbReady(env)) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);

  let auth;
  try {
    auth = await getEbayAccessToken(env);
  } catch (error) {
    return json({ ok: false, error: error.message || "EBAY_TOKEN_READ_FAILED" }, 500);
  }
  if (!auth.ok) return json({ ok: false, error: auth.error || "EBAY_AUTH_FAILED" }, auth.status || 409);

  const hosts = ebayHosts(auth.record.environment);
  const response = await fetch(hosts.api + "/sell/account/v1/privilege/", {
    headers: {
      Authorization: "Bearer " + auth.token,
      Accept: "application/json"
    }
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }

  return json({
    ok: response.ok,
    status: response.status,
    environment: hosts.environment,
    privilege: response.ok ? body : null,
    error: response.ok ? null : (body && (body.errors || body.error) ? (body.errors || body.error) : "EBAY_PRIVILEGE_CHECK_FAILED"),
    access_token_refreshed: !!auth.refreshed
  }, response.ok ? 200 : response.status);
}

export async function disconnectEbay(request, env) {
  if (!connectorDbReady(env)) return json({ ok: false, error: "D1_NOT_CONFIGURED" }, 503);
  try {
    const record = await loadRecord(env);
    if (!record) return json({ ok: true, connected: false });
    record.tokens = null;
    await saveRecord(env, record);
    return json({ ok: true, connected: false, reauthorization_required: true });
  } catch (error) {
    return json({ ok: false, error: error.message || "EBAY_DISCONNECT_FAILED" }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
