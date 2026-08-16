const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';
global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.Utilities = { sleep: () => {} };

class FakeSheet {
  constructor(){ this.rows=[]; }
  getLastColumn(){ return this.rows.length?this.rows[0].length:0; }
  getLastRow(){ return this.rows.length; }
  setFrozenRows(){}
  appendRow(v){ this.rows.push(v.slice()); }
  getDataRange(){ const s=this; return { getValues(){ return s.rows.map(r=>r.slice()); } }; }
  getRange(r,c,nr,nc){ const s=this; return {
    setValues(v){ for(let i=0;i<v.length;i++){ while(s.rows.length<r+i) s.rows.push([]);
      for(let j=0;j<v[i].length;j++) s.rows[r+i-1][c+j-1]=v[i][j]; } return this; },
    getValues(){ const o=[]; for(let i=0;i<(nr||1);i++){ const row=s.rows[r+i-1]||[]; const sl=[];
      for(let j=0;j<(nc||1);j++) sl.push(row[c+j-1]); o.push(sl); } return o; },
    getValue(){ return (s.rows[r-1]||[])[c-1]; },
    setValue(v){ while(s.rows.length<r) s.rows.push([]); s.rows[r-1][c-1]=v; return this; },
    setFontWeight(){ return this; } }; }
}
let sheets={};
global.SpreadsheetApp={ openById:()=>({ getSheetByName:n=>sheets[n]||null,
  insertSheet:n=>{sheets[n]=new FakeSheet();return sheets[n];} }), flush:()=>{} };
let props={};
global.PropertiesService={ getScriptProperties:()=>({ getProperties:()=>Object.assign({},props),
  getProperty:k=>(k in props?props[k]:null), setProperty:(k,v)=>{props[k]=v;} }) };
global.LockService={ getScriptLock:()=>({ waitLock(){}, releaseLock(){} }) };
global.UrlFetchApp={ fetch(){throw new Error('no http')}, fetchAll(){throw new Error('no http')} };

const src = ['config','phase0-implementation','listing-generator','channel-router',
             'channel-adapters','inventory-manager','manual-listing-helper']
  .map(f=>fs.readFileSync(SRC_DIR+f+'.gs','utf8')).join('\n');

const testCode = `
function assert(c,m){ if(!c) throw new Error('ASSERT FAILED: '+m); }

// ── 1. 文字数カウント（ヤフオクの全角換算）
assert(countZenkaku_('あいう') === 3, '全角3文字は3.0');
assert(countZenkaku_('abcdef') === 3, '半角6文字は3.0');
assert(countZenkaku_('あabc') === 2.5, '混在: 1 + 1.5 = 2.5, got ' + countZenkaku_('あabc'));
console.log('✅ 全角換算OK');

// ── 2. タイトルが上限に収まるか + 落とした要素が見えるか
var longName = 'In the Court of the Crimson King (An Observation By King Crimson) 50th Anniversary';
var mer = buildTitleForChannel_([longName, '[Vinyl]'], 'MERCARI');
console.log('メルカリ:', mer.count + '/' + mer.limit, '| needsManualTrim:', mer.needsManualTrim);
assert(mer.limit === 40, 'メルカリ上限40');
// 商品名だけで上限超のケース：勝手に切らず、商品名をそのまま返して手動トリムを促す
assert(mer.title === longName, '商品名は切らずそのまま返すはず');
assert(mer.needsManualTrim === true, '手動トリム要フラグが立つはず');

// 収まるケースでは副次要素まで積む
var fits = buildTitleForChannel_(['In the Court of the Crimson King', '[Vinyl]'], 'MERCARI');
console.log('メルカリ(収まる):', fits.title, fits.count + '/' + fits.limit);
assert(fits.count <= 40, '収まる場合は40文字以内, got ' + fits.count);
assert(fits.needsManualTrim === false, '収まる場合はトリム不要');
assert(fits.title.indexOf('[Vinyl]') !== -1, '余裕があれば形式も付ける');

var rak = buildTitleForChannel_(['King Crimson', '[Vinyl]'], 'RAKUMA');
console.log('ラクマ:', rak.title, rak.count + '/' + rak.limit);
assert(rak.limit === 65, 'ラクマ上限65（2026年7月に40→65）');
assert(rak.dropped.length === 0, '短いタイトルは何も落ちないはず');

var yah = buildTitleForChannel_(['あいうえお', '[Vinyl]'], 'YAHOO_AUCTION');
console.log('ヤフオク:', yah.title, yah.count + '/' + yah.limit);
assert(yah.limit === 65, 'ヤフオク上限65');
console.log('✅ タイトル調整OK');

// ── 3. 途中で機械的に切っていないこと（これが一番大事）
var over = buildTitleForChannel_(['ABCDEFGHIJ'.repeat(10), '[Vinyl]'], 'MERCARI');
assert(over.title === 'ABCDEFGHIJ'.repeat(10), '商品名が長すぎても切らずそのまま返すはず, got: ' + over.title);
assert(over.needsManualTrim === true, '手動トリム要フラグが立つはず');
assert(over.overflow === true, 'overflowフラグが立つはず');
assert(over.title.indexOf('[Vinyl]') === -1, '副次要素は付けない');
console.log('✅ 上限超でも途中で切らず、手動トリム要として返す:', over.count + '/' + over.limit);

var useless = buildTitleForChannel_([longName, '[Vinyl]'], 'MERCARI');
assert(useless.title !== '[Vinyl]', 'タイトルが[Vinyl]だけになってはいけない, got: ' + useless.title);
assert(useless.needsManualTrim === true, '商品名が入らない場合はneedsManualTrim');
console.log('✅ 「[Vinyl]だけのタイトル」バグを修正');

// ── 4. 説明文の上限は未設定（勝手に切らない）
['MERCARI','RAKUMA','YAHOO_AUCTION'].forEach(function(ch){
  assert(MANUAL_CHANNEL_SPEC[ch].descLimit === null, ch + ' の説明文上限はnull（公式未確認のため）');
});
console.log('✅ 説明文は上限未設定＝切り詰めなし');

// ── 5. E2E: 在庫登録 → キューに出る → コピペ本文がフルで取れる
var r = new CanonicalProductRecord();
r.product.category='MUSIC'; r.product.brand='King Crimson';
r.product.productName='In the Court of the Crimson King';
r.product.format='Vinyl'; r.product.year=1969;
r.identifiers.barcode='4988007123457'; r.identifiers.barcodeType='JAN_13';
r.pricing.priceSource='discogs_price_suggestions';
r.pricing.estimatedPrice=8400; r.pricing.currency='JPY';
r.database.dbMatch={url:'https://www.discogs.com/release/249504'};
var copy = generateListingCopy_(r);
r.content.title=copy.title; r.content.description=copy.description; r.content.listingWarnings=copy.warnings;
attachChannelRouting_(r);

var sku = registerInventoryItem(r, 2500);
console.log('SKU:', sku);

var saved = getListingCopy_(sku);
assert(saved, 'listing_copy に保存されているはず');
assert(saved.description.length > 120, 'フル本文が保存されるはず（120文字プレビューではなく）。len=' + saved.description.length);
assert(saved.description.indexOf('【参考相場】') !== -1, '説明文末尾まで残っているはず');
console.log('✅ フル説明文を保存（' + saved.description.length + '文字）');

var q = getManualListingQueue();
console.log('出品待ち:', q.length, '件');
assert(q.length === 1, '1件出るはず');
assert(q[0].channels.length === 3, 'メルカリ/ラクマ/ヤフオクの3販路が出るはず, got ' + q[0].channels.length);
assert(q[0].description.length > 120, 'キューにもフル本文が乗るはず');
q[0].channels.forEach(function(c){
  console.log('  ', c.label, '| title', c.titleCount + '/' + c.titleLimit, '| dropped:', c.dropped.length);
  assert(c.verifiedNote, '各販路に「何が公式確認済みか」の注記があるはず');
});
console.log('✅ キュー生成OK');

// ── 6. 出品したら次から出てこない
markListedFromUI(sku, 'MERCARI', 'm-123');
var q2 = getManualListingQueue();
assert(q2[0].channels.length === 2, '出品済みは消えるはず, got ' + q2[0].channels.length);
console.log('✅ 出品記録するとキューから外れる');

// ── 7. 削除キュー
var chSheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
var row = findChannelListingRow_(chSheet, sku, 'RAKUMA');
updateChannelListing_(row.rowIndex, LISTING_STATUS.MANUAL_REQUIRED, 'テスト');
var cq = getManualCleanupQueue();
console.log('要削除:', cq.length, '件 ->', cq.map(function(x){return x.label;}).join(','));
assert(cq.length === 1, '1件出るはず');
assert(cq[0].urgent === false, 'MANUAL_REQUIREDは緊急ではない');

var row2 = findChannelListingRow_(chSheet, sku, 'YAHOO_AUCTION');
updateChannelListing_(row2.rowIndex, LISTING_STATUS.STOP_UNVERIFIED, 'テスト');
var cq2 = getManualCleanupQueue();
var urgent = cq2.filter(function(x){return x.urgent;});
assert(urgent.length === 1, 'STOP_UNVERIFIEDは緊急扱いになるはず');
console.log('✅ 削除キューOK（緊急フラグも動作）');

// ── 8. 「消した」で片付く
markCleanupDoneFromUI(sku, 'RAKUMA');
var cq3 = getManualCleanupQueue();
assert(cq3.length === 1, '1件片付いて残り1件のはず, got ' + cq3.length);
console.log('✅ 消した記録OK');

console.log('\\n\u2705\u2705 ALL MANUAL LISTING HELPER TESTS PASSED');
`;

eval(src + '\n' + testCode);
