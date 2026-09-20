import test from "node:test";
import assert from "node:assert/strict";
import {
  discogsHeaders,
  requireAdmin,
  validateInventoryCreate,
  validateInventoryPatch,
  validateSaleEvent,
  nextInventoryAfterSale
} from "../src/worker.js";

test("Discogs auth header is built from secret without logging it", () => {
  const h = discogsHeaders({ DISCOGS_TOKEN: "secret-token" });
  assert.equal(h.Authorization, "Discogs token=secret-token");
  assert.match(h["User-Agent"], /7thleaf-ReuseOS/);
});

test("admin guard fails closed when secret is missing", async () => {
  const req = new Request("https://example.test/api/inventory");
  const result = requireAdmin(req, {});
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 503);
});

test("admin guard accepts exact bearer token", () => {
  const req = new Request("https://example.test/api/inventory", {
    headers: { authorization: "Bearer abc" }
  });
  const result = requireAdmin(req, { ADMIN_TOKEN: "abc" });
  assert.equal(result.ok, true);
});

test("inventory create normalizes valid fields", () => {
  const result = validateInventoryCreate({
    product_name: "  Test CD  ",
    category: "music",
    quantity: "2",
    cost_jpy: "100",
    price_jpy: "1800",
    location: " A-01 "
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    sku: null,
    category: "MUSIC",
    product_name: "Test CD",
    format: null,
    media_condition: null,
    sleeve_condition: null,
    cost_jpy: 100,
    price_jpy: 1800,
    location: "A-01",
    quantity: 2
  });
});

test("inventory create rejects invalid category and negative values", () => {
  assert.equal(validateInventoryCreate({ product_name: "x", category: "ALIEN" }).ok, false);
  assert.equal(validateInventoryCreate({ product_name: "x", cost_jpy: -1 }).ok, false);
  assert.equal(validateInventoryCreate({ product_name: "x", quantity: 0 }).ok, false);
});

test("inventory create rejects unsafe sku characters", () => {
  const result = validateInventoryCreate({ product_name: "x", sku: "../oops" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid sku");
});

test("inventory patch is whitelist-only", () => {
  const result = validateInventoryPatch({ status: "sold", quantity: 0, location: null });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { status: "SOLD", quantity: 0, location: null });

  const denied = validateInventoryPatch({ sku: "rewrite-me" });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /not editable/);
});

test("inventory patch rejects empty body", () => {
  const result = validateInventoryPatch({});
  assert.equal(result.ok, false);
  assert.equal(result.error, "no editable fields");
});


test("sale event validation requires stable id, sku and channel", () => {
  const valid = validateSaleEvent({
    event_id: "discogs:order-123",
    sku: "AUDIO-1",
    channel: "discogs",
    sale_price_jpy: "1500"
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.channel, "DISCOGS");
  assert.equal(valid.value.sale_price_jpy, 1500);

  assert.equal(validateSaleEvent({ sku: "AUDIO-1", channel: "DISCOGS" }).ok, false);
  assert.equal(validateSaleEvent({ event_id: "../bad", sku: "AUDIO-1", channel: "DISCOGS" }).ok, false);
});

test("sale state decrements stock without destructive action", () => {
  assert.deepEqual(nextInventoryAfterSale(1), {
    quantity: 0,
    status: "SOLD",
    sync_state: "STOP_PENDING"
  });
  assert.deepEqual(nextInventoryAfterSale(3), {
    quantity: 2,
    status: "AVAILABLE",
    sync_state: "SYNC_PENDING"
  });
});
