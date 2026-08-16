const fs = require('fs');
const path = require('path');
// リポジトリ内の src/ を見る（環境に依存しないように）
const SRC_DIR = path.join(__dirname, '..', 'src') + '/';
global.Logger = { log: (...a) => console.log('[LOG]', ...a) };
global.Utilities = {
  sleep: () => {},
  base64Encode: (s) => Buffer.from(String(s)).toString('base64'),
  getUuid: () => 'uuid-fixed-1234'
};
let props = {};
global.PropertiesService = { getScriptProperties: () => ({
  getProperties: () => Object.assign({}, props),
  getProperty: k => (k in props ? props[k] : null),
  setProperty: (k, v) => { props[k] = v; },
  setProperties: (o) => { Object.assign(props, o); },
  deleteProperty: (k) => { delete props[k]; }
})};
global.LockService = { getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) };
global.SpreadsheetApp = { getActiveSpreadsheet: () => null };
global.getWebAppUrl = () => 'https://script.google.com/macros/s/EXAMPLE/exec';

let fetches = [];
let handler = () => ({ getResponseCode: () => 200, getContentText: () => '{}' });
global.UrlFetchApp = { fetch: (url, opts) => { fetches.push({ url, opts }); return handler(url, opts); } };
global.__setHandler = h => { handler = h; };
global.__fetches = () => fetches;
global.__reset = () => { props = {}; fetches = []; };

const src = ['config', 'ebay-auth']
  .map(f => fs.readFileSync(SRC_DIR + f + '.gs', 'utf8')).join('\n');

const testCode = `
function assert(c,m){ if(!c) throw new Error('ASSERT FAILED: '+m); }

// ── 1. 未接続なら明確に失敗する
__reset(); refreshConfig();
var t0 = getEbayAccessToken_();
assert(t0.ok === false, '未接続では失敗すべき');
assert(t0.note.indexOf('接続') !== -1, '接続を促すメッセージが出るはず: ' + t0.note);
console.log('✅ 未接続の扱いOK:', t0.note);

// ── 2. sandbox / production のホスト切り替え
__reset(); CONFIG.EBAY_ENV = 'sandbox';
assert(ebayApiBase_().indexOf('api.sandbox.ebay.com') !== -1, 'sandboxホストになるはず: ' + ebayApiBase_());
CONFIG.EBAY_ENV = '';
assert(ebayApiBase_() === 'https://api.ebay.com/sell/inventory/v1', '本番ホストになるはず: ' + ebayApiBase_());
console.log('✅ 環境切り替えOK');

// ── 3. 認可URLの組み立て（redirect_uriがRuNameであること）
__reset();
CONFIG.EBAY_CLIENT_ID = 'app-id-1'; CONFIG.EBAY_RUNAME = 'Tokky-app-RU-xyz'; CONFIG.EBAY_ENV = 'sandbox';
var au = buildEbayAuthUrl();
assert(au.ok, '認可URLが作れるはず: ' + au.note);
assert(au.url.indexOf('auth.sandbox.ebay.com') !== -1, 'sandboxの認可ホスト');
assert(au.url.indexOf('redirect_uri=Tokky-app-RU-xyz') !== -1, 'redirect_uriはRuName（URLではない）: ' + au.url);
assert(au.url.indexOf('response_type=code') !== -1, 'response_type=code');
assert(au.url.indexOf(encodeURIComponent('https://api.ebay.com/oauth/api_scope/sell.inventory')) !== -1, 'sell.inventoryスコープ');
assert(au.url.indexOf('state=') !== -1, 'stateを含む');
console.log('✅ 認可URLOK');

// ── 4. state不一致は拒否する（CSRF対策）
var bad = exchangeEbayCode_('somecode', 'wrong-state');
assert(bad.ok === false, 'state不一致は拒否すべき');
assert(bad.note.indexOf('state') !== -1, 'state不一致の説明が出る');
console.log('✅ state検証OK');

// ── 5. 認可コード → リフレッシュトークン
__reset();
// 本番同様、プロパティ側に保存する（setter経由だとrefreshConfig()で消えるため）
PropertiesService.getScriptProperties().setProperties({
  EBAY_CLIENT_ID:'id', EBAY_CLIENT_SECRET:'sec', EBAY_RUNAME:'RU' });
refreshConfig();
buildEbayAuthUrl();  // stateを保存
__setHandler(function(){ return { getResponseCode:()=>200, getContentText:()=>JSON.stringify({
  access_token:'AT-1', expires_in:7200, refresh_token:'RT-1', refresh_token_expires_in:47304000 })};});
var ex = exchangeEbayCode_('thecode', 'uuid-fixed-1234');
assert(ex.ok, '交換成功すべき: ' + ex.note);
assert(/[0-9]{3}日間有効/.test(ex.note), '有効日数が出るはず: ' + ex.note);
assert(CONFIG.EBAY_REFRESH_TOKEN === 'RT-1', 'リフレッシュトークンが保存される');
assert(CONFIG.EBAY_ACCESS_TOKEN === 'AT-1', 'アクセストークンが保存される');
var f = __fetches()[__fetches().length-1];
assert(f.opts.payload.indexOf('grant_type=authorization_code') !== -1, 'authorization_codeで交換');
assert(f.opts.headers.Authorization.indexOf('Basic ') === 0, 'Basic認証を使う');
console.log('✅ コード交換OK（' + ex.note + '）');

// ── 6. 有効なうちは再取得しない
var before = __fetches().length;
var t1 = getEbayAccessToken_();
assert(t1.ok && t1.token === 'AT-1', '既存トークンを返す');
assert(__fetches().length === before, '期限内なら通信しない');
console.log('✅ キャッシュOK（無駄な通信なし）');

// ── 7. 期限切れなら自動更新
PropertiesService.getScriptProperties().setProperty('EBAY_ACCESS_TOKEN_EXPIRES_AT', String(Date.now() - 1000));
refreshConfig();
__setHandler(function(){ return { getResponseCode:()=>200, getContentText:()=>JSON.stringify({
  access_token:'AT-2', expires_in:7200 })};});
var t2 = getEbayAccessToken_();
assert(t2.ok && t2.token === 'AT-2', '新しいトークンに更新されるはず: ' + JSON.stringify(t2));
assert(t2.refreshed === true, '更新フラグが立つ');
var f2 = __fetches()[__fetches().length-1];
assert(f2.opts.payload.indexOf('grant_type=refresh_token') !== -1, 'refresh_tokenで更新');
console.log('✅ 自動更新OK（2時間で切れても止まらない）');

// ── 8. リフレッシュトークン失効は分かりやすく伝える
PropertiesService.getScriptProperties().setProperty('EBAY_ACCESS_TOKEN_EXPIRES_AT', String(Date.now() - 1000));
refreshConfig();
__setHandler(function(){ return { getResponseCode:()=>400, getContentText:()=>'{"error":"invalid_grant"}' };});
var t3 = getEbayAccessToken_();
assert(t3.ok === false, '失効なら失敗');
assert(t3.note.indexOf('接続し直') !== -1, '再接続を促すはず: ' + t3.note);
console.log('✅ 失効時の案内OK');

// ── 9. 手動トークンは上書きとして機能する（動作確認用の逃げ道）
__reset(); CONFIG.EBAY_OAUTH_TOKEN = 'MANUAL-1';
var t4 = getEbayAccessToken_();
assert(t4.ok && t4.token === 'MANUAL-1' && t4.manual === true, '手動トークンが優先されるはず');
console.log('✅ 手動トークンOK');

// ── 10. 接続解除
__reset();
PropertiesService.getScriptProperties().setProperties({EBAY_REFRESH_TOKEN:'R',EBAY_ACCESS_TOKEN:'A'});
refreshConfig();
disconnectEbay();
assert(!CONFIG.EBAY_REFRESH_TOKEN, 'リフレッシュトークンが消える');
console.log('✅ 接続解除OK');

// ── 11. 状態表示に秘密情報が混ざらない
__reset();
PropertiesService.getScriptProperties().setProperties({
  EBAY_CLIENT_ID:'id', EBAY_CLIENT_SECRET:'SUPERSECRET', EBAY_RUNAME:'RU', EBAY_REFRESH_TOKEN:'RTSECRET'});
refreshConfig();
var st = getEbayAuthStatus();
var dump = JSON.stringify(st);
assert(dump.indexOf('SUPERSECRET') === -1, '状態にsecretが混ざってはいけない: ' + dump);
assert(dump.indexOf('RTSECRET') === -1, '状態にリフレッシュトークンが混ざってはいけない');
assert(st.connected === true && st.hasApp === true, '接続済みと判定されるはず');
console.log('✅ 状態表示に秘密情報の混入なし');

console.log('\\n\u2705\u2705 ALL EBAY AUTH TESTS PASSED');
`;

eval(src + '\n' + testCode);
