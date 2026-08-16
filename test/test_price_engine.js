const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';

// Stub GAS globals
global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.Utilities = { sleep: () => {} };
global.PropertiesService = { getScriptProperties: () => ({ getProperties: () => ({ DISCOGS_TOKEN: 'FAKE_TOKEN' }), getProperty: () => null, setProperty: () => {} }) };

let callLog = [];
global.UrlFetchApp = {
  fetch: (url, opts) => {
    callLog.push(url);
    if (url.includes('price_suggestions')) {
      return {
        getResponseCode: () => 401,
        getContentText: () => 'Unauthorized'
      };
    }
    if (url.includes('/releases/')) {
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ lowest_price: 1234, num_for_sale: 42 })
      };
    }
    throw new Error('unexpected url ' + url);
  }
};

const srcCfg = fs.readFileSync('' + SRC_DIR + 'config.gs', 'utf8');
const src1 = fs.readFileSync('' + SRC_DIR + 'price-engine.gs', 'utf8');
const src2 = fs.readFileSync('' + SRC_DIR + 'phase0-implementation.gs', 'utf8');
const src3 = fs.readFileSync('' + SRC_DIR + 'listing-generator.gs', 'utf8');

const testCode = `
const record = new CanonicalProductRecord();
record.product.category = 'MUSIC';
record.product.brand = 'King Crimson';
record.product.productName = 'In the Court of the Crimson King';
record.product.format = 'CD';
record.product.year = 1969;
record.database.dbId = 249504;

attachPriceSuggestions_(record);
console.log('PRICING RESULT:', JSON.stringify(record.pricing, null, 2));

const copy = generateListingCopy_(record);
console.log('--- TITLE ---');
console.log(copy.title);
console.log('--- DESCRIPTION ---');
console.log(copy.description);
console.log('--- WARNINGS ---');
console.log(copy.warnings);

console.log('--- CALL LOG (order) ---');
console.log(callLog);

if (record.pricing.priceSource !== 'discogs_lowest_price_fallback') {
  throw new Error('Expected fallback source, got: ' + record.pricing.priceSource);
}
if (record.pricing.estimatedPrice !== 1234) {
  throw new Error('Expected estimatedPrice 1234, got: ' + record.pricing.estimatedPrice);
}
if (record.pricing.numForSale !== 42) {
  throw new Error('Expected numForSale 42, got: ' + record.pricing.numForSale);
}
if (callLog.length !== 2 || !callLog[0].includes('price_suggestions') || !callLog[1].includes('/releases/')) {
  throw new Error('Expected price_suggestions call then releases call, got: ' + JSON.stringify(callLog));
}
console.log('\\n\u2705 ALL ASSERTIONS PASSED (fallback path)');

callLog = [];
global.UrlFetchApp.fetch = (url) => {
  callLog.push(url);
  return { getResponseCode: () => 500, getContentText: () => 'Server Error' };
};
const record2 = new CanonicalProductRecord();
record2.database.dbId = 249504;
attachPriceSuggestions_(record2);
console.log('\\nPRICING RESULT (both fail):', JSON.stringify(record2.pricing, null, 2));
if (record2.pricing.priceSource !== 'unavailable') {
  throw new Error('Expected unavailable, got: ' + record2.pricing.priceSource);
}
if (!record2.pricing.priceUnavailableReason.includes('price_suggestions失敗') || !record2.pricing.priceUnavailableReason.includes('lowest_priceも失敗')) {
  throw new Error('Reason string missing expected parts: ' + record2.pricing.priceUnavailableReason);
}
console.log('\u2705 ALL ASSERTIONS PASSED (both-fail path)');

callLog = [];
global.UrlFetchApp.fetch = (url) => {
  callLog.push(url);
  if (url.includes('price_suggestions')) {
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ 'Very Good Plus (VG+)': { currency: 'EUR', value: 8.5 } })
    };
  }
  throw new Error('should not call fallback when first succeeds: ' + url);
};
const record3 = new CanonicalProductRecord();
record3.database.dbId = 249504;
attachPriceSuggestions_(record3);
console.log('\\nPRICING RESULT (first succeeds):', JSON.stringify(record3.pricing, null, 2));
if (record3.pricing.priceSource !== 'discogs_price_suggestions') {
  throw new Error('Expected discogs_price_suggestions, got: ' + record3.pricing.priceSource);
}
if (callLog.length !== 1) {
  throw new Error('Fallback should not have been called, callLog: ' + JSON.stringify(callLog));
}
console.log('\u2705 ALL ASSERTIONS PASSED (first-succeeds path, fallback correctly skipped)');
`;

eval(srcCfg + '\n' + src2 + '\n' + src1 + '\n' + src3 + '\n' + testCode);
