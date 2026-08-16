/**
 * Setup UI（サーバー側）
 *
 * 【役割】これまで「Apps Scriptの設定画面でスクリプトプロパティを手入力」
 * だった作業を、画面から行えるようにする。
 * 入力 → 保存 → その場で接続テスト、までを1画面で完結させる。
 *
 * 【なぜ必要か】
 * Google CloudのAPIキー取得、Discogsトークン取得、Sheet ID、Driveフォルダ…と
 * 設定項目が多く、どれか1つ欠けても動かない。しかも「動かない理由」が
 * 実行ログの奥に出るため、慣れていないと原因に辿り着けない。
 * 特にSheetをコピーして他の人に使ってもらう場合、この画面が無いと詰む。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【配布形態についての設計判断（重要・将来変更する可能性あり）】
 *
 * 現在は PropertiesService.getScriptProperties() を使っている。
 * これは「スクリプト単位」の保管場所で、そのスクリプトを使う全員で共有される。
 *
 * ■ 今の想定（Sheetごとコピーして配る）
 *   コピーされた側は別のスクリプトになるため、設定も別々になる。
 *   よって getScriptProperties のままで問題ない。
 *
 * ■ 将来SaaS化する場合（1つのウェブアプリを複数の顧客が使う）
 *   getScriptProperties だと A社のAPIキーが B社から見えてしまう。
 *   その時は getUserProperties へ変更し、在庫データも顧客ごとに
 *   分離する必要がある。config.gs の load_() 内の1行が変更点になる。
 *
 * 現時点では前者。切り替えが必要になったらここのコメントを参照すること。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

/**
 * 画面に出す設定項目の定義。
 * ここに1行足せば画面にも項目が増える。
 */
const SETUP_FIELDS = [
  {
    key: 'SHEET_ID',
    label: 'スプレッドシートID',
    group: 'basic',
    required: true,
    secret: false,
    help: 'このスクリプトがデータを書き込むスプレッドシート。下の「今開いているシートを使う」で自動入力できます。',
    linkText: null, linkUrl: null,
    test: 'testSheet'
  },
  {
    key: 'DRIVE_FOLDER_ID',
    label: 'Driveフォルダ ID（写真置き場）',
    group: 'basic',
    required: true,
    secret: false,
    help: '撮影した商品画像を入れるGoogle Driveのフォルダ。フォルダを開いたときのURLの、末尾の文字列がIDです。',
    linkText: 'Google Drive を開く', linkUrl: 'https://drive.google.com/',
    test: 'testDrive'
  },
  {
    key: 'VISION_API_KEY',
    label: 'Google Cloud APIキー（画像の文字読み取り用）',
    group: 'basic',
    required: true,
    secret: true,
    help: 'Google Cloudで「Cloud Vision API」と「Books API」を有効にし、APIキーを1つ作ってください。無料枠は月1,000枚です。',
    linkText: 'Google Cloud の認証情報ページ', linkUrl: 'https://console.cloud.google.com/apis/credentials',
    test: 'testVision'
  },
  {
    key: 'GOOGLE_API_KEY',
    label: '同じAPIキー（本の検索用）',
    group: 'basic',
    required: true,
    secret: true,
    help: '上と同じキーで構いません。「上のキーをコピー」ボタンで入ります。',
    linkText: null, linkUrl: null,
    test: 'testBooks'
  },
  {
    key: 'DISCOGS_TOKEN',
    label: 'Discogs トークン（CD・レコードの特定と相場）',
    group: 'basic',
    required: true,
    secret: true,
    help: 'Discogsにログインし、開発者設定ページで個人用トークンを作ってください。出品者登録は不要です。',
    linkText: 'Discogs の開発者設定', linkUrl: 'https://www.discogs.com/settings/developers',
    test: 'testDiscogs'
  },

  // ── 販路（使うものだけ。無くても基本機能は動く）
  {
    key: 'EBAY_OAUTH_TOKEN', label: 'eBay アクセストークン', group: 'channel',
    required: false, secret: true,
    help: 'eBayへの自動出品・自動停止に使います。未設定でもeBay以外の機能は動きます。',
    linkText: 'eBay Developer', linkUrl: 'https://developer.ebay.com/my/keys',
    test: 'testEbay'
  },
  { key: 'ETSY_API_KEY', label: 'Etsy APIキー', group: 'channel', required: false, secret: true,
    help: 'Etsyはヴィンテージ（製造から20年以上）のみ出品可能です。', linkText: 'Etsy Developers', linkUrl: 'https://www.etsy.com/developers', test: null },
  { key: 'ETSY_OAUTH_TOKEN', label: 'Etsy アクセストークン', group: 'channel', required: false, secret: true, help: '', linkText: null, linkUrl: null, test: null },
  { key: 'ETSY_SHOP_ID', label: 'Etsy ショップID', group: 'channel', required: false, secret: false, help: '', linkText: null, linkUrl: null, test: null },
  { key: 'MERCARI_SHOPS_ACCESS_TOKEN', label: 'メルカリShops アクセストークン', group: 'channel', required: false, secret: true,
    help: 'ショップ管理画面から自分で発行できます。ただし下のクライアント名が無いとAPIは呼べません。', linkText: null, linkUrl: null, test: null },
  { key: 'MERCARI_SHOPS_CLIENT_NAME', label: 'メルカリShops クライアント名', group: 'channel', required: false, secret: false,
    help: 'これはメルカリとの契約時に先方から発行される値です。自分では作れません。', linkText: null, linkUrl: null, test: null },
  { key: 'YAHOO_SHOPPING_ACCESS_TOKEN', label: 'Yahoo!ショッピング アクセストークン', group: 'channel', required: false, secret: true, help: 'ストア出店審査を通っている必要があります。', linkText: null, linkUrl: null, test: null },
  { key: 'YAHOO_SHOPPING_SELLER_ID', label: 'Yahoo!ショッピング セラーID', group: 'channel', required: false, secret: false, help: '', linkText: null, linkUrl: null, test: null }
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状態の取得
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 秘密情報は末尾4文字だけ返す。値そのものは画面へ送らない */
function maskForUI_(key, value, isSecret) {
  if (!value) return '';
  if (!isSecret) return String(value);
  const s = String(value);
  return s.length <= 4 ? '****' : '****' + s.slice(-4);
}

/**
 * 画面表示用の設定状況を返す。
 * 【重要】秘密情報の実値は絶対にここから返さない（末尾4文字のみ）。
 */
function getSetupStatus() {
  const fields = SETUP_FIELDS.map(function (f) {
    const v = CONFIG[f.key];
    return {
      key: f.key, label: f.label, group: f.group,
      required: f.required, secret: f.secret,
      help: f.help, linkText: f.linkText, linkUrl: f.linkUrl,
      hasTest: !!f.test,
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
    webAppUrl: getWebAppUrl()
  };
}

/**
 * このスクリプトがスプレッドシートに紐づいている場合、そのIDを返す。
 * Sheetごとコピーして配る運用だと、これで自動入力できるので
 * 「IDをURLからコピーする」手順を丸ごと省ける。
 */
function getActiveSpreadsheetId_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return ss ? ss.getId() : '';
  } catch (e) {
    return '';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 保存
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 1項目だけ保存する。空文字を渡すとその項目を削除する。
 * 【設計】まとめて保存にしないのは、1つ入れるたびに接続テストして
 * 進められるようにするため。どこで失敗したかが分かりやすい。
 */
function saveSetupValue(key, value) {
  const field = SETUP_FIELDS.filter(function (f) { return f.key === key; })[0];
  if (!field) return { ok: false, note: '不明な設定項目です: ' + key };

  const props = PropertiesService.getScriptProperties();
  const v = String(value == null ? '' : value).trim();

  if (v === '') {
    props.deleteProperty(key);
    refreshConfig();
    return { ok: true, note: field.label + ' を削除しました' };
  }

  props.setProperty(key, v);
  refreshConfig();
  // 値そのものは戻さない
  return { ok: true, note: field.label + ' を保存しました', display: maskForUI_(key, v, field.secret) };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 接続テスト
// 【注意】ここは実際に外部APIを叩きます。画面のボタンを押したときだけ実行されます。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function runSetupTest(key) {
  const field = SETUP_FIELDS.filter(function (f) { return f.key === key; })[0];
  if (!field || !field.test) return { ok: false, note: 'この項目に接続テストはありません' };
  try {
    return SETUP_TESTS[field.test]();
  } catch (e) {
    return { ok: false, note: 'テスト中にエラー: ' + e.message };
  }
}

const SETUP_TESTS = {

  testSheet: function () {
    if (!CONFIG.SHEET_ID) return { ok: false, note: '未設定です' };
    try {
      const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
      return { ok: true, note: '「' + ss.getName() + '」を開けました' };
    } catch (e) {
      return { ok: false, note: '開けません。IDが違うか、権限がありません（' + e.message + '）' };
    }
  },

  testDrive: function () {
    if (!CONFIG.DRIVE_FOLDER_ID) return { ok: false, note: '未設定です' };
    try {
      const folder = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
      const files = folder.getFiles();
      let n = 0;
      while (files.hasNext() && n < 100) { files.next(); n++; }
      return { ok: true, note: '「' + folder.getName() + '」を開けました（ファイル' + (n >= 100 ? '100件以上' : n + '件') + '）' };
    } catch (e) {
      return { ok: false, note: '開けません。IDが違うか、権限がありません（' + e.message + '）' };
    }
  },

  testVision: function () {
    if (!CONFIG.VISION_API_KEY) return { ok: false, note: '未設定です' };
    // 1x1の透明PNG。文字は無いので結果は空になるが、キーが有効なら200が返る。
    // 課金は1ユニット（無料枠 月1,000）。
    const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = UrlFetchApp.fetch(
      'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(CONFIG.VISION_API_KEY),
      {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ requests: [{ image: { content: TINY_PNG }, features: [{ type: 'TEXT_DETECTION' }] }] }),
        muteHttpExceptions: true
      });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code === 200 && body.indexOf('"error"') === -1) {
      return { ok: true, note: 'Vision APIに接続できました（テスト画像1枚を消費）' };
    }
    if (code === 403) {
      return { ok: false, note: 'HTTP403：キーは通ったがCloud Vision APIが有効化されていない可能性があります。Google Cloudで「Cloud Vision API」を有効にしてください' };
    }
    if (code === 400 && body.indexOf('API key not valid') !== -1) {
      return { ok: false, note: 'APIキーが正しくありません' };
    }
    return { ok: false, note: 'HTTP' + code + '：' + body.substring(0, 180) };
  },

  testBooks: function () {
    if (!CONFIG.GOOGLE_API_KEY) return { ok: false, note: '未設定です' };
    const res = UrlFetchApp.fetch(
      'https://www.googleapis.com/books/v1/volumes?q=isbn:9784101010014&key=' + encodeURIComponent(CONFIG.GOOGLE_API_KEY),
      { muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) return { ok: true, note: 'Books APIに接続できました' };
    if (code === 403) return { ok: false, note: 'HTTP403：Books APIが有効化されていない可能性があります' };
    return { ok: false, note: 'HTTP' + code + '：' + res.getContentText().substring(0, 180) };
  },

  testDiscogs: function () {
    if (!CONFIG.DISCOGS_TOKEN) return { ok: false, note: '未設定です' };
    const res = UrlFetchApp.fetch(
      'https://api.discogs.com/database/search?q=nirvana&type=release&per_page=1&token=' + encodeURIComponent(CONFIG.DISCOGS_TOKEN),
      { headers: { 'User-Agent': 'Reuse-Intake-AI/1.0' }, muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) return { ok: true, note: 'Discogsに接続できました' };
    if (code === 401) return { ok: false, note: 'HTTP401：トークンが正しくありません' };
    return { ok: false, note: 'HTTP' + code + '：' + res.getContentText().substring(0, 180) };
  },

  testEbay: function () {
    if (!CONFIG.EBAY_OAUTH_TOKEN) return { ok: false, note: '未設定です' };
    const res = UrlFetchApp.fetch(
      'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=1',
      { headers: { Authorization: 'Bearer ' + CONFIG.EBAY_OAUTH_TOKEN }, muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200 || code === 204) return { ok: true, note: 'eBayに接続できました' };
    if (code === 401) return { ok: false, note: 'HTTP401：トークンが無効か期限切れです。eBayのアクセストークンは有効期限が短いため、切れていないか確認してください' };
    if (code === 403) return { ok: false, note: 'HTTP403：トークンは有効ですが、この操作の権限（スコープ）が足りません' };
    return { ok: false, note: 'HTTP' + code + '：' + res.getContentText().substring(0, 180) };
  }
};

/** 「今開いているシートを使う」ボタン用 */
function useActiveSpreadsheet() {
  const id = getActiveSpreadsheetId_();
  if (!id) {
    return { ok: false, note: 'このスクリプトはスプレッドシートに紐づいていません。IDを手で入力してください' };
  }
  return saveSetupValue('SHEET_ID', id);
}

/** 「上のキーをコピー」ボタン用（Vision → Books） */
function copyVisionKeyToBooks() {
  if (!CONFIG.VISION_API_KEY) return { ok: false, note: '先に上のAPIキーを保存してください' };
  return saveSetupValue('GOOGLE_API_KEY', CONFIG.VISION_API_KEY);
}
