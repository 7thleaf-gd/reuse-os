import test from "node:test";
import assert from "node:assert/strict";
import { discogsHeaders, requireAdmin } from "../src/worker.js";

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
