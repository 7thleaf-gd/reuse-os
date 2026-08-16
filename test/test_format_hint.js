const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';
global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.Utilities = { sleep: () => {} };
global.PropertiesService = { getScriptProperties: () => ({ getProperties: () => ({}), getProperty: () => null, setProperty: () => {} }) };

const srcCfg = fs.readFileSync('' + SRC_DIR + 'config.gs', 'utf8');
const srcImpl = fs.readFileSync('' + SRC_DIR + 'phase0-implementation.gs', 'utf8');
const srcPrice = fs.readFileSync('' + SRC_DIR + 'price-engine.gs', 'utf8');

const testCode = `
CONFIG.DISCOGS_TOKEN = 'FAKE';
let lastUrl = null;
global.UrlFetchApp = {
  fetch: (url, opts) => {
    lastUrl = url;
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        results: [{
          id: 249504,
          title: 'King Crimson - In The Court Of The Crimson King',
          uri: '/release/249504',
          basic_information: { formats: [{ name: 'Cassette' }] },
          community: { have: 100, want: 50 }
        }]
      })
    };
  }
};

// Sanity: confirm the fixed URL no longer hardcodes format=CD
const dbMatch = resolveDiscogs('King Crimson\\nIn the Court of the Crimson King');
if (lastUrl.includes('format=CD')) throw new Error('BUG STILL PRESENT: search URL still hardcodes format=CD: ' + lastUrl);
console.log('Search URL (no format filter):', lastUrl);
if (!dbMatch || dbMatch.format !== 'Cassette') throw new Error('Expected format Cassette from DB match, got: ' + JSON.stringify(dbMatch));
console.log('✅ resolveDiscogs format=CD bug fix confirmed, and dynamic format extraction works (Cassette)');

// Case: OCR says "Vinyl" but DB match says Cassette -> mismatch note expected
const record1 = resolveProduct('MUSIC', 'KING CRIMSON\\nVinyl LP 33 1/3', null, 'img1');
console.log('Mismatch note (OCR=Vinyl, DB=Cassette):', record1.product.formatConfidenceNote);
if (!record1.product.formatConfidenceNote) throw new Error('Expected a format mismatch warning when OCR says Vinyl but DB says Cassette');

// Case: OCR text has no format hint at all -> no note (can't false-positive)
const record2 = resolveProduct('MUSIC', 'KING CRIMSON ALBUM', null, 'img2');
console.log('No-hint case note (should be null):', record2.product.formatConfidenceNote);
if (record2.product.formatConfidenceNote) throw new Error('Expected no mismatch note when OCR gives no format hint, got: ' + record2.product.formatConfidenceNote);

console.log('\\n\u2705 ALL FORMAT-HINT ASSERTIONS PASSED');
`;

eval(srcCfg + '\n' + srcImpl + '\n' + srcPrice + '\n' + testCode);
