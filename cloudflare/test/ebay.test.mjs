import test from "node:test";
import assert from "node:assert/strict";
import {
  EBAY_SCOPES,
  ebayHosts,
  encryptEbayPayload,
  decryptEbayPayload,
  signEbayState,
  verifyEbayState,
  classifyEbayCallback,
  verifyStoredEbayState
} from "../src/ebay.js";

test("eBay scopes cover listing, account policies and fulfillment without buy/PII scopes", () => {
  assert.deepEqual(EBAY_SCOPES, [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment"
  ]);
  assert.equal(EBAY_SCOPES.some((scope) => /buy|identity|commerce\.identity/.test(scope)), false);
});

test("eBay hosts fail safe to sandbox unless production is explicit", () => {
  assert.equal(ebayHosts().environment, "sandbox");
  assert.equal(ebayHosts("sandbox").api, "https://api.sandbox.ebay.com");
  assert.equal(ebayHosts("PRODUCTION").api, "https://api.ebay.com");
  assert.equal(ebayHosts("typo").environment, "sandbox");
});

test("OAuth state is signed and expires", async () => {
  const secret = "admin-secret-for-test";
  const now = 1_800_000_000_000;
  const state = await signEbayState(secret, now, "nonce-1");

  const valid = await verifyEbayState(state, secret, now + 30_000);
  assert.equal(valid.ok, true);
  assert.equal(valid.nonce, "nonce-1");

  const tampered = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");
  assert.equal((await verifyEbayState(tampered, secret, now + 30_000)).ok, false);
  assert.equal((await verifyEbayState(state, secret, now + 11 * 60_000)).error, "STATE_EXPIRED");
});

test("eBay connector payload encrypts and decrypts without plaintext storage", async () => {
  const secret = "admin-secret-for-test";
  const source = {
    client_id: "sandbox-client",
    client_secret: "sandbox-cert",
    runame: "sandbox-runame",
    tokens: { refresh_token: "refresh-secret" }
  };

  const encrypted = await encryptEbayPayload(source, secret);
  assert.equal(encrypted.ciphertext.includes("refresh-secret"), false);
  assert.equal(encrypted.ciphertext.includes("sandbox-cert"), false);

  const restored = await decryptEbayPayload(encrypted.ciphertext, encrypted.iv, secret);
  assert.deepEqual(restored, source);

  await assert.rejects(
    () => decryptEbayPayload(encrypted.ciphertext, encrypted.iv, "wrong-secret")
  );
});


test("eBay callback classifier distinguishes OAuth, direct callback, and legacy Auth'n'Auth", () => {
  const oauth = classifyEbayCallback("https://example.test/cb?code=abc&state=xyz");
  assert.equal(oauth.ok, true);
  assert.equal(oauth.type, "oauth");

  const direct = classifyEbayCallback("https://example.test/cb");
  assert.equal(direct.ok, false);
  assert.equal(direct.type, "missing");
  assert.equal(direct.error, "OAUTH_CODE_OR_STATE_MISSING");

  const legacy = classifyEbayCallback("https://example.test/cb?isAuthSuccessful=true&ebaytkn=legacy");
  assert.equal(legacy.ok, false);
  assert.equal(legacy.type, "legacy_authnauth");
  assert.equal(legacy.error, "LEGACY_AUTHNAUTH_CALLBACK");
});


test("callback classifier reports a missing query without exposing values", () => {
  const result = classifyEbayCallback("https://example.test/oauth/ebay/callback");
  assert.equal(result.ok, false);
  assert.equal(result.type, "missing");
  assert.deepEqual(result.keys, []);
});


test("server-stored OAuth state accepts exact fresh UUID and rejects mismatch/expiry", () => {
  const now = 1_800_000_000_000;
  const record = { pending_oauth: { state: "abc-123", created_at: now } };

  assert.deepEqual(verifyStoredEbayState(record, "abc-123", now + 30_000), { ok: true });
  assert.equal(verifyStoredEbayState(record, "wrong", now + 30_000).error, "INVALID_STATE");
  assert.equal(verifyStoredEbayState(record, "abc-123", now + 11 * 60_000).error, "STATE_EXPIRED");
  assert.equal(verifyStoredEbayState({}, "abc-123", now).error, "OAUTH_STATE_NOT_STARTED");
});
