const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';

global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.PropertiesService = { getScriptProperties: () => ({ getProperties: () => ({}), getProperty: () => null, setProperty: () => {} }) };

const srcCfg = fs.readFileSync('' + SRC_DIR + 'config.gs', 'utf8');
const srcImpl = fs.readFileSync('' + SRC_DIR + 'phase0-implementation.gs', 'utf8');
const srcRouter = fs.readFileSync('' + SRC_DIR + 'channel-router.gs', 'utf8');

const testCode = `
const currentYear = new Date().getFullYear();

// Case 1: old CD (25y) -> Etsy eligible
const r1 = new CanonicalProductRecord();
r1.product.category = 'MUSIC';
r1.product.year = currentYear - 25;
attachChannelRouting_(r1);
console.log('--- 25-year-old ---');
console.log(r1.content.channelSummary);
console.log(JSON.stringify(r1.content.channelEligibility, null, 2));

const etsyCheck1 = r1.content.channelEligibility.find(c => c.channel === 'ETSY');
if (!etsyCheck1.eligible) throw new Error('Expected Etsy eligible for 25yr old item');

// Case 2: new CD (5y) -> Etsy NOT eligible
const r2 = new CanonicalProductRecord();
r2.product.category = 'MUSIC';
r2.product.year = currentYear - 5;
attachChannelRouting_(r2);
console.log('--- 5-year-old ---');
console.log(r2.content.channelSummary);
const etsyCheck2 = r2.content.channelEligibility.find(c => c.channel === 'ETSY');
if (etsyCheck2.eligible) throw new Error('Expected Etsy NOT eligible for 5yr old item');

// Case 3: exactly at boundary (20y) -> eligible (>=20)
const r3 = new CanonicalProductRecord();
r3.product.category = 'MUSIC';
r3.product.year = currentYear - 20;
attachChannelRouting_(r3);
const etsyCheck3 = r3.content.channelEligibility.find(c => c.channel === 'ETSY');
if (!etsyCheck3.eligible) throw new Error('Expected Etsy eligible at exactly 20yr boundary');
console.log('--- exactly 20-year boundary --- eligible:', etsyCheck3.eligible);

// Case 4: unknown year -> not eligible, graceful reason
const r4 = new CanonicalProductRecord();
r4.product.category = 'MUSIC';
r4.product.year = null;
attachChannelRouting_(r4);
const etsyCheck4 = r4.content.channelEligibility.find(c => c.channel === 'ETSY');
if (etsyCheck4.eligible) throw new Error('Expected Etsy NOT eligible when year unknown');
console.log('--- unknown year --- reason:', etsyCheck4.reason);

// eBay should always be eligible regardless of year
[r1, r2, r3, r4].forEach((r, i) => {
  const ebay = r.content.channelEligibility.find(c => c.channel === 'EBAY');
  if (!ebay.eligible) throw new Error('eBay should always be eligible, case ' + i);
});

// Manual-copy channels should always be present and flagged manual_copy
[r1, r2].forEach((r) => {
  ['MERCARI', 'RAKUMA', 'YAHOO_AUCTION'].forEach(ch => {
    const c = r.content.channelEligibility.find(x => x.channel === ch);
    if (c.mode !== 'manual_copy') throw new Error(ch + ' should be manual_copy mode');
  });
});

console.log('\\n\u2705 ALL CHANNEL ROUTER ASSERTIONS PASSED');
`;

eval(srcCfg + '\n' + srcImpl + '\n' + srcRouter + '\n' + testCode);
