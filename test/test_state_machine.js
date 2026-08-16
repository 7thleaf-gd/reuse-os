const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';

global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.Utilities = {
  sleep: () => {},
  base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
  getUuid: () => 'test-uuid-0000'
};
global.getWebAppUrl = () => 'https://example.test/exec';

// ---------- Fake Spreadsheet ----------
class FakeSheet {
  constructor() { this.rows = []; }
  getLastColumn() { return this.rows.length ? this.rows[0].length : 0; }
  getLastRow() { return this.rows.length; }
  setFrozenRows() {}
  appendRow(vals) { this.rows.push(vals.slice()); }
  getDataRange() {
    const self = this;
    return { getValues() { return self.rows.map(r => r.slice()); } };
  }
  getRange(r, c, numRows, numCols) {
    const self = this;
    return {
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          while (self.rows.length < r + i) self.rows.push([]);
          for (let j = 0; j < vals[i].length; j++) self.rows[r + i - 1][c + j - 1] = vals[i][j];
        }
        return this;
      },
      getValues() {
        const out = [];
        for (let i = 0; i < (numRows || 1); i++) {
          const row = self.rows[r + i - 1] || [];
          const slice = [];
          for (let j = 0; j < (numCols || 1); j++) slice.push(row[c + j - 1]);
          out.push(slice);
        }
        return out;
      },
      getValue() { const row = self.rows[r - 1] || []; return row[c - 1]; },
      setValue(v) {
        while (self.rows.length < r) self.rows.push([]);
        self.rows[r - 1][c - 1] = v;
        return this;
      },
      setFontWeight() { return this; }
    };
  }
}

let sheets = {};
global.SpreadsheetApp = {
  openById: () => ({
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = new FakeSheet(); return sheets[n]; }
  }),
  flush: () => {}
};

let props = {};
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperties: () => Object.assign({}, props),
    getProperty: (k) => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = v; }
  })
};

let lockCount = 0;
global.LockService = {
  getScriptLock: () => ({ waitLock: () => { lockCount++; }, releaseLock: () => {} })
};

// Controlled by each scenario
let fetchHandler = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
let fetchAllLog = [];
global.UrlFetchApp = {
  fetch: () => { throw new Error('fetch() not expected'); },
  fetchAll: (reqs) => {
    fetchAllLog.push(reqs.map(r => r.url + ' [' + (r.method || 'get') + ']'));
    return reqs.map(fetchHandler);
  }
};

const src = ['config', 'phase0-implementation', 'channel-router', 'ebay-auth', 'channel-adapters', 'inventory-manager']
  .map(f => fs.readFileSync(SRC_DIR + f + '.gs', 'utf8')).join('\n');

function reset() { sheets = {}; props = {}; fetchAllLog = []; }
global.__reset = reset;
global.__setFetch = (h) => { fetchHandler = h; };
global.__fetchAllLog = () => fetchAllLog;

const testCode = `
function newRecord() {
  const r = new CanonicalProductRecord();
  r.product.category = 'MUSIC';
  r.product.productName = 'In the Court of the Crimson King';
  r.product.format = 'Vinyl';
  r.product.year = 1969;   // >20yr so Etsy is eligible
  r.pricing.estimatedPrice = 9.35;
  r.pricing.currency = 'EUR';
  attachChannelRouting_(r);
  return r;
}
function cfgEbayOnly() {
  CONFIG.EBAY_OAUTH_TOKEN = 'tok';
  CONFIG.ETSY_API_KEY = ''; CONFIG.ETSY_OAUTH_TOKEN = ''; CONFIG.ETSY_SHOP_ID = '';
  CONFIG.MERCARI_SHOPS_ACCESS_TOKEN = ''; CONFIG.MERCARI_SHOPS_CLIENT_NAME = '';
  CONFIG.YAHOO_SHOPPING_ACCESS_TOKEN = ''; CONFIG.YAHOO_SHOPPING_SELLER_ID = '';
}
function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }

// ══════════ SCENARIO 1: happy path — eBay stop succeeds and verify confirms ══════════
__reset(); cfgEbayOnly();
__setFetch(function (req) {
  if (req.url.indexOf('/withdraw') !== -1) return { getResponseCode: () => 200, getContentText: () => '{}' };
  // getOffer verify
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 'UNPUBLISHED' }) };
});
var sku = registerInventoryItem(newRecord(), 3000);
console.log('SKU:', sku);
assert(/^AUDIO-\\d{6}$/.test(sku), 'SKU format');

assert(markAsListed(sku, 'EBAY', 'offer-123').ok, 'markAsListed EBAY should succeed');
var r1 = handleSaleEvent(sku, 'MERCARI', 'ORDER-001', 8000, 'JPY');
console.log('S1 result:', JSON.stringify({ ok: r1.ok, syncState: r1.syncState, gp: r1.grossProfit, actions: r1.actionItems }, null, 2));
assert(r1.ok, 'S1 should succeed');
assert(r1.syncState === 'SYNCED', 'S1 expected SYNCED, got ' + r1.syncState);
assert(r1.grossProfit === 5000, 'S1 grossProfit');
var l1 = getChannelListings_(sku).filter(function(l){return l.channel==='EBAY';})[0];
assert(l1.status === 'STOPPED', 'S1 eBay should be STOPPED, got ' + l1.status);
// 2 fetchAll rounds: 1 stop + 1 verify
assert(__fetchAllLog().length === 2, 'S1 expected 2 fetchAll calls (stop+verify), got ' + __fetchAllLog().length);
console.log('✅ S1 happy path OK');

// ══════════ SCENARIO 2: idempotency ══════════
var r2 = handleSaleEvent(sku, 'MERCARI', 'ORDER-001', 8000, 'JPY');
assert(r2.duplicated === true, 'S2 should be flagged duplicated');
console.log('✅ S2 idempotency OK:', r2.note);

// ══════════ SCENARIO 3: RESERVED/SOLD blocks new listing ══════════
var blocked = markAsListed(sku, 'ETSY', 'listing-999');
assert(blocked.ok === false, 'S3 listing a SOLD sku must be rejected');
console.log('✅ S3 RESERVED/SOLD guard OK:', blocked.note);

// ══════════ SCENARIO 4: verify says still active -> STOP_FAILED + PARTIAL_FAILURE ══════════
__reset(); cfgEbayOnly();
__setFetch(function (req) {
  if (req.url.indexOf('/withdraw') !== -1) return { getResponseCode: () => 200, getContentText: () => '{}' };
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 'PUBLISHED' }) };
});
var sku4 = registerInventoryItem(newRecord(), 1000);
markAsListed(sku4, 'EBAY', 'offer-4');
var r4 = handleSaleEvent(sku4, 'MERCARI', 'ORDER-004', 5000, 'JPY');
console.log('S4 syncState:', r4.syncState, '| actions:', r4.actionItems);
assert(r4.syncState === 'PARTIAL_FAILURE', 'S4 expected PARTIAL_FAILURE, got ' + r4.syncState);
assert(r4.actionItems.join(' ').indexOf('まだ購入可能') !== -1, 'S4 should warn still-purchasable');
console.log('✅ S4 verify-says-active correctly NOT treated as success');

// ══════════ SCENARIO 5: stop API fails -> PARTIAL_FAILURE, then retry succeeds ══════════
__reset(); cfgEbayOnly();
var failFirst = true;
__setFetch(function (req) {
  if (req.url.indexOf('/withdraw') !== -1) {
    if (failFirst) return { getResponseCode: () => 500, getContentText: () => 'Server Error' };
    return { getResponseCode: () => 200, getContentText: () => '{}' };
  }
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 'UNPUBLISHED' }) };
});
var sku5 = registerInventoryItem(newRecord(), 2000);
markAsListed(sku5, 'EBAY', 'offer-5');
var r5 = handleSaleEvent(sku5, 'MERCARI', 'ORDER-005', 9000, 'JPY');
assert(r5.syncState === 'PARTIAL_FAILURE', 'S5 expected PARTIAL_FAILURE, got ' + r5.syncState);
var l5 = getChannelListings_(sku5).filter(function(l){return l.channel==='EBAY';})[0];
assert(l5.status === 'STOP_FAILED', 'S5 eBay should be STOP_FAILED, got ' + l5.status);
console.log('S5 after failure:', l5.status, '| attempts:', l5.attemptCount);

failFirst = false;
var retry = retryFailedStops(sku5);
console.log('S5 retry:', JSON.stringify({retried: retry.retried, stillFailing: retry.stillFailing}));
assert(retry.retried === 1, 'S5 should retry exactly 1 channel');
assert(retry.stillFailing.length === 0, 'S5 retry should clear the failure');
var l5b = getChannelListings_(sku5).filter(function(l){return l.channel==='EBAY';})[0];
assert(l5b.status === 'STOPPED', 'S5 after retry should be STOPPED, got ' + l5b.status);
console.log('✅ S5 retry queue OK (only failed channel re-run)');

// ══════════ SCENARIO 6: manual channel produces ACTION_REQUIRED, no HTTP ══════════
__reset(); cfgEbayOnly();
__setFetch(function () { throw new Error('no HTTP expected in S6'); });
var sku6 = registerInventoryItem(newRecord(), 500);
markAsListed(sku6, 'RAKUMA', 'rakuma-xyz');
var r6 = handleSaleEvent(sku6, 'MERCARI', 'ORDER-006', 3000, 'JPY');
console.log('S6 syncState:', r6.syncState);
console.log('S6 actions:', r6.actionItems);
assert(r6.syncState === 'MANUAL_ACTION_REQUIRED', 'S6 expected MANUAL_ACTION_REQUIRED, got ' + r6.syncState);
assert(r6.actionItems.join(' ').indexOf('ラクマ') !== -1, 'S6 should name Rakuma');
assert(__fetchAllLog().length === 0, 'S6 must issue zero HTTP calls for manual channels');
console.log('✅ S6 manual channel OK (0 HTTP calls)');

// ══════════ SCENARIO 7: unconfigured channel is skipped, does not break others ══════════
__reset(); cfgEbayOnly();
__setFetch(function (req) {
  if (req.url.indexOf('/withdraw') !== -1) return { getResponseCode: () => 200, getContentText: () => '{}' };
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 'UNPUBLISHED' }) };
});
var sku7 = registerInventoryItem(newRecord(), 1500);
markAsListed(sku7, 'EBAY', 'offer-7');
markAsListed(sku7, 'YAHOO_SHOPPING', 'code-7');   // NOT configured
var r7 = handleSaleEvent(sku7, 'MERCARI', 'ORDER-007', 6000, 'JPY');
var yl = getChannelListings_(sku7).filter(function(l){return l.channel==='YAHOO_SHOPPING';})[0];
var el = getChannelListings_(sku7).filter(function(l){return l.channel==='EBAY';})[0];
console.log('S7 eBay:', el.status, '| Yahoo:', yl.status, '| syncState:', r7.syncState);
assert(el.status === 'STOPPED', 'S7 eBay should still succeed despite Yahoo unconfigured');
assert(yl.status === 'STOP_FAILED', 'S7 Yahoo should be STOP_FAILED (unconfigured), got ' + yl.status);
console.log('✅ S7 one unconfigured channel does not block the others');

// ══════════ SCENARIO 8: Etsy uses literal "inactive" not "deactivated" ══════════
__reset();
CONFIG.ETSY_API_KEY='k'; CONFIG.ETSY_OAUTH_TOKEN='t'; CONFIG.ETSY_SHOP_ID='s1';
var steps = EtsyAdapter.buildStopSteps('L1');
var payload = JSON.parse(steps[0].request.payload);
console.log('S8 Etsy stop payload:', JSON.stringify(payload));
assert(payload.state === 'inactive', 'S8 Etsy must send state=inactive (literal), got ' + payload.state);
assert(steps[0].request.method === 'patch', 'S8 Etsy must use PATCH');
console.log('✅ S8 Etsy literal state value OK');

// ══════════ SCENARIO 9: Mercari Shops = 2-step (stock 0 -> delete) ══════════
CONFIG.MERCARI_SHOPS_ACCESS_TOKEN='t'; CONFIG.MERCARI_SHOPS_CLIENT_NAME='client';
var msSteps = MercariShopsAdapter.buildStopSteps('prod1:var1');
console.log('S9 Mercari steps:', msSteps.map(function(s){return s.name;}).join(' -> '));
assert(msSteps.length === 2, 'S9 expected 2 steps');
assert(msSteps[0].name.indexOf('stock=0') !== -1, 'S9 step1 must zero the stock first');
assert(msSteps[1].name === 'deleteProduct', 'S9 step2 must delete');
// GraphQL errors on HTTP 200 must be treated as failure
var gqlErr = MercariShopsAdapter.interpretStop('deleteProduct', 200,
  JSON.stringify({ errors: [{ message: 'x', extensions: { errorCode: 'PRODUCT_DIFFERENCE_FOUND' } }] }));
assert(gqlErr.success === false, 'S9 GraphQL errors on HTTP200 must be failure');
assert(gqlErr.retryable === true, 'S9 PRODUCT_DIFFERENCE_FOUND must be retryable');
console.log('✅ S9 Mercari Shops 2-step + GraphQL-error-on-200 handling OK');

// ══════════ SCENARIO 10: verify=null must NOT be rounded up to success ══════════
__reset(); cfgEbayOnly();
__setFetch(function (req) {
  if (req.url.indexOf('/withdraw') !== -1) return { getResponseCode: () => 200, getContentText: () => '{}' };
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ somethingElse: 1 }) }; // no status field
});
var sku10 = registerInventoryItem(newRecord(), 100);
markAsListed(sku10, 'EBAY', 'offer-10');
var r10 = handleSaleEvent(sku10, 'MERCARI', 'ORDER-010', 900, 'JPY');
var l10 = getChannelListings_(sku10).filter(function(l){return l.channel==='EBAY';})[0];
console.log('S10 eBay status:', l10.status, '| syncState:', r10.syncState);
assert(l10.status === 'STOP_UNVERIFIED', 'S10 unknown verify must be STOP_UNVERIFIED, got ' + l10.status);
assert(r10.syncState === 'MANUAL_ACTION_REQUIRED', 'S10 must escalate to MANUAL_ACTION_REQUIRED');
console.log('✅ S10 verify=null correctly NOT treated as success');

// ══════════ SCENARIO 11: releaseReservation ══════════
__reset(); cfgEbayOnly();
__setFetch(function () { return { getResponseCode: () => 200, getContentText: () => '{}' }; });
var sku11 = registerInventoryItem(newRecord(), 100);
var invS = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
var inv11 = findInventoryRow_(invS, sku11);
invS.getRange(inv11.rowIndex, headerMap_(invS)['Status']).setValue('RESERVED');
var rel = releaseReservation(sku11, 'テスト: 注文キャンセル');
assert(rel.ok, 'S11 release should succeed');
assert(assertListable_(sku11).ok, 'S11 after release the SKU must be listable again');
console.log('✅ S11 releaseReservation OK');

console.log('\\n\u2705\u2705 ALL STATE MACHINE SCENARIOS PASSED (11/11)');
`;

eval(src + '\n' + testCode);
