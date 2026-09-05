/**
 * Setup UI（サーバー側）
 *
 * Reuse OSの商品本体は Inventory / Listing / SOLD同期。
 * Hunterは仲間内専用のPrivate Toolとして商品セットアップから分離する。
 */

const SETUP_FIELDS = [
  {
    key: 'SHEET_ID',
    label: 'スプレッドシートID',
    group: 'basic',
    required: true,
    secret: false,
    help: '中央在庫・出品状態・売却イベントを保持する正本シート。紐づけスクリプトなら自動入力できます。',
    linkText: null, linkUrl: null,
    test: 'testSheet'
  },
  {
    key: 'DRIVE_FOLDER_ID',
    label: 'Driveフォルダ ID（商品画像）',
    group: 'basic',
    required: true,
    secret: false,
    help: '商品画像を置くGoogle Driveフォルダ。フォルダURL末尾のIDを使います。',
    linkText: 'Google Drive を開く', linkUrl: 'https://drive.google.com/',
    test: 'testDrive'
  },

  // Private Hunter専用。顧客向けReuse OSの必須設定・通常セットアップには出さない。
  {
    key: 'VISION_API_KEY',
    label: 'Google Cloud APIキー（Private Hunter）',
    group: 'hunter_private',
    required: false,
    secret: true,
    help: '仲間内専用Hunterの画像OCR用。Reuse OS商品本体には不要。',
    linkText: 'Google Cloud の認証情報ページ', linkUrl: 'https://console.cloud.google.com/apis/credentials',
    test: 'testVision'
  },
  {
    key: 'GOOGLE_API_KEY',
    label: 'Google APIキー（Private Hunter）',
    group: 'hunter_private',
    required: false,
    secret: true,
    help: '仲間内専用Hunterの検索用。Reuse OS商品本体には不要。',
    linkText: null, linkUrl: null,
    test: 'testBooks'
  },
  {
    key: 'DISCOGS_TOKEN',
    label: 'Discogs トークン（Private Hunter）',
    group: 'hunter_private',
    required: false,
    secret: true,
    help: '仲間内専用Hunterの音楽商品の特定・相場参照用。Reuse OS商品本体には不要。',
    linkText: 'Discogs の開発者設定', linkUrl: 'https://www.discogs.com/settings/developers',
    test: 'testDiscogs'
  },

  // 販路（使うものだけ）
  { key: 'EBAY_ENV', label: '環境（sandbox / production）', group: 'channel', platform: 'EBAY',
    required: false, secret: false, test: null, linkText: null, linkUrl: null,
    help: '最初は sandbox を推奨。空欄なら本番です。' },
  { key: 'EBAY_CLIENT_ID', label: 'App ID (Client ID)', group: 'channel', platform: 'EBAY',
    required: false, secret: false, test: null,
    linkText: 'eBay Developer のキー一覧', linkUrl: 'https://developer.ebay.com/my/keys', help: '' },
  { key: 'EBAY_CLIENT_SECRET', label: 'Cert ID (Client Secret)', group: 'channel', platform: 'EBAY',
    required: false, secret: true, test: null, linkText: null, linkUrl: null, help: '' },
  { key: 'EBAY_RUNAME', label: 'RuName', group: 'channel', platform: 'EBAY',
    required: false, secret: false, test: null, linkText: null, linkUrl: null,
    help: 'Developer画面で作成し、そのAuth Accepted URLへ画面に表示されるコールバックURLを登録してください。' },
  { key: 'EBAY_OAUTH_TOKEN', label: 'アクセストークンを直接貼る（動作確認用）', group: 'channel', platform: 'EBAY',
    required: false, secret: true, test: 'testEbay', linkText: null, linkUrl: null,
    help: '短命トークン。恒久運用は「eBayと接続」を使います。' },

  { key: 'ETSY_API_KEY', label: 'APIキー (keystring)', group: 'channel', platform: 'ETSY',
    required: false, secret: true, test: null, linkText: 'Etsy Developers', linkUrl: 'https://www.etsy.com/developers', help: '' },
  { key: 'ETSY_OAUTH_TOKEN', label: 'アクセストークン', group: 'channel', platform: 'ETSY',
    required: false, secret: true, test: null, linkText: null, linkUrl: null, help: '' },
  { key: 'ETSY_SHOP_ID', label: 'ショップID', group: 'channel', platform: 'ETSY',
    required: false, secret: false, test: null, linkText: null, linkUrl: null, help: '' },
  { key: 'MERCARI_SHOPS_ACCESS_TOKEN', label: 'アクセストークン', group: 'channel', platform: 'MERCARI_SHOPS',
    required: false, secret: true, test: null, linkText: null, linkUrl: null, help: 'ショップ管理画面から発行。' },
  { key: 'MERCARI_SHOPS_CLIENT_NAME', label: 'クライアント名 (API_CLIENT_NAME)', group: 'channel', platform: 'MERCARI_SHOPS',
    required: false, secret: false, test: null, linkText: null, linkUrl: null, help: 'API契約時に発行される値。' },
  { key: 'YAHOO_SHOPPING_ACCESS_TOKEN', label: 'アクセストークン', group: 'channel', platform: 'YAHOO_SHOPPING',
    required: false, secret: true, test: null, linkText: null, linkUrl: null, help: '' },
  { key: 'YAHOO_SHOPPING_SELLER_ID', label: 'セラーID', group: 'channel', platform: 'YAHOO_SHOPPING',
    required: false, secret: false, test: null, linkText: null, linkUrl: null, help: '' }
];

const PLATFORM_GUIDE = {
  EBAY: {
    label: 'eBay', availability: 'ready',
    summary: 'Phase 1の実チャネル。App ID / Cert ID / RuNameを1回だけ入れ、あとは「eBayと接続」でOAuthします。',
    steps: [
      'eBay DeveloperでApp ID / Cert ID / RuNameを準備',
      'Auth Accepted URLへこの画面のコールバックURLを登録',
      '3項目を保存',
      '「eBayと接続」を押して同意'
    ]
  },
  ETSY: { label:'Etsy', availability:'limited', summary:'ヴィンテージ等の対象商品のみ。Phase 1必須ではありません。', steps:['必要になった時だけ接続'] },
  MERCARI_SHOPS: { label:'メルカリShops', availability:'contract', summary:'API契約が必要。Phase 1必須ではありません。', steps:['必要になった時だけ契約・接続'] },
  YAHOO_SHOPPING: { label:'Yahoo!ショッピング', availability:'review', summary:'ストア審査が必要。Phase 1必須ではありません。', steps:['必要になった時だけ接続'] }
};

function maskForUI_(key, value, isSecret) {
  if (!value) return '';
  if (!isSecret) return String(value);
  const s = String(value);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

function getSetupStatus() {
  const fields = SETUP_FIELDS.filter(function(f){ return f.group !== 'hunter_private'; }).map(function (f) {
    const v = CONFIG[f.key];
    return {
      key: f.key, label: f.label, group: f.group,
      required: f.required, secret: f.secret,
      help: f.help, linkText: f.linkText, linkUrl: f.linkUrl,
      hasTest: !!f.test,
      platform: f.platform || null,
      isSet: !!v,
      display: maskForUI_(f.key, v, f.secret)
    };
  });

  const required = fields.filter(function (f) { return f.required; });
  const doneCount = required.filter(function (f) { return f.isSet; }).length;

  return {
    fields: fields,
    requiredTotal: required.length,
    requiredDone: doneCount,
    allRequiredDone: doneCount === required.length,
    activeSheetId: getActiveSpreadsheetId_(),
    webAppUrl: getWebAppUrl(),
    platforms: Object.keys(PLATFORM_GUIDE).map(function (k) {
      const g = PLATFORM_GUIDE[k];
      return { key: k, label: g.label, availability: g.availability, summary: g.summary, steps: g.steps };
    }),
    ebay: (typeof getEbayAuthStatus === 'function') ? getEbayAuthStatus() : null
  };
}

function saveSetupValue(key, value) {
  const def = SETUP_FIELDS.find(function (f) { return f.key === key; });
  if (!def) return { ok: false, note: '未定義の設定項目です' };
  const props = PropertiesService.getScriptProperties();
  const v = String(value == null ? '' : value).trim();
  if (!v) props.deleteProperty(key); else props.setProperty(key, v);
  return { ok: true, note: v ? '保存しました' : '設定を削除しました' };
}

function runSetupTest(key) {
  const def = SETUP_FIELDS.find(function (f) { return f.key === key; });
  if (!def || !def.test || typeof this[def.test] !== 'function') return { ok: false, note: '接続テストはありません' };
  return this[def.test]();
}

function getActiveSpreadsheetId_() {
  try { return SpreadsheetApp.getActiveSpreadsheet().getId(); } catch (e) { return ''; }
}

function useActiveSpreadsheet() {
  const id = getActiveSpreadsheetId_();
  if (!id) return { ok: false, note: '紐づいているスプレッドシートを取得できませんでした' };
  PropertiesService.getScriptProperties().setProperty('SHEET_ID', id);
  return { ok: true, note: '現在のスプレッドシートを設定しました' };
}

function testSheet() {
  try { const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID); return { ok:true, note:'接続OK: ' + ss.getName() }; }
  catch(e){ return { ok:false, note:'接続できません: ' + e.message }; }
}
function testDrive() {
  try { const f = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID); return { ok:true, note:'接続OK: ' + f.getName() }; }
  catch(e){ return { ok:false, note:'接続できません: ' + e.message }; }
}
function testVision() { return { ok: !!CONFIG.VISION_API_KEY, note: CONFIG.VISION_API_KEY ? 'キー設定済み' : '未設定' }; }
function testBooks() { return { ok: !!CONFIG.GOOGLE_API_KEY, note: CONFIG.GOOGLE_API_KEY ? 'キー設定済み' : '未設定' }; }
function testDiscogs() { return { ok: !!CONFIG.DISCOGS_TOKEN, note: CONFIG.DISCOGS_TOKEN ? 'トークン設定済み' : '未設定' }; }
function testEbay() { return { ok: !!CONFIG.EBAY_OAUTH_TOKEN, note: CONFIG.EBAY_OAUTH_TOKEN ? 'トークン設定済み' : '未設定' }; }
