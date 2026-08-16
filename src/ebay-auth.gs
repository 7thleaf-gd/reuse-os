/**
 * eBay OAuth（認証まわり）
 *
 * 【なぜ専用ファイルが必要か】
 * eBayのアクセストークンは **2時間で失効する**（公式ドキュメントで
 * expires_in = 7200 秒と明記）。つまり「トークンを1個貼って終わり」では、
 * 貼った日の午後には全てのAPI呼び出しが401で止まる。
 *
 * 一方リフレッシュトークンは **約18ヶ月**（refresh_token_expires_in =
 * 47304000 秒）有効なので、こちらを保存しておき、
 * アクセストークンは必要になるたびに自動で取り直す。
 * これで一度つないだら1年半は放置できる。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【公式ドキュメントで確認した仕様】
 *
 * ■ 必要なトークン種別
 *   Sell Inventory API は「特定の出品者のデータ」を扱うため、
 *   User access token（認可コードフロー）が必要。
 *   Application access token（client credentials）では呼べない。
 *
 * ■ 有効期限
 *   User access token         7,200秒（2時間）
 *   Refresh token        47,304,000秒（約547日 ≒ 18ヶ月）
 *
 * ■ リフレッシュ
 *   POST /identity/v1/oauth2/token
 *   Authorization: Basic base64(client_id:client_secret)
 *   grant_type=refresh_token&refresh_token=...
 *   → 新しい access_token が返る。
 *     リフレッシュトークンは再発行されないので同じものを使い続ける。
 *
 * ■ redirect_uri には URL ではなく RuName を渡す
 *   これはeBay独自の仕様で、間違えやすい。
 *   実際のコールバックURLは eBay Developer の RuName 設定画面の
 *   「Auth Accepted URL」に登録する。
 *
 * ■ 必要なスコープ
 *   https://api.ebay.com/oauth/api_scope/sell.inventory
 *   （読み取り専用の .../sell.inventory.readonly では出品・停止ができない）
 *
 * ■ ホスト
 *                    本番                          サンドボックス
 *   認可画面   auth.ebay.com/oauth2/authorize   auth.sandbox.ebay.com/oauth2/authorize
 *   トークン   api.ebay.com/identity/v1/...     api.sandbox.ebay.com/identity/v1/...
 *   在庫API    api.ebay.com/sell/inventory/v1   api.sandbox.ebay.com/sell/inventory/v1
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * 【つなぎ方（利用者の手順）】
 * 1. eBay Developer でアプリを作り、App ID / Cert ID を取得
 * 2. 同じ画面で RuName を作り、「Auth Accepted URL」に
 *    このウェブアプリのURLを登録する（セットアップ画面に表示されます）
 * 3. セットアップ画面に App ID / Cert ID / RuName を入れる
 * 4. 「eBayと接続」ボタンを押す → eBayの同意画面 → 自動で戻ってくる
 * 5. 以降は自動更新。1年半ほど放置できる
 */

const EBAY_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory';

/** 期限のこれくらい手前で先に更新する（通信の往復ぶんの余裕） */
const EBAY_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function ebayIsSandbox_() {
  return String(CONFIG.EBAY_ENV || '').toLowerCase() === 'sandbox';
}

function ebayHosts_() {
  return ebayIsSandbox_()
    ? { auth: 'https://auth.sandbox.ebay.com', api: 'https://api.sandbox.ebay.com' }
    : { auth: 'https://auth.ebay.com',         api: 'https://api.ebay.com' };
}

/** Sell Inventory API のベースURL。channel-adapters.gs から使う */
function ebayApiBase_() {
  return ebayHosts_().api + '/sell/inventory/v1';
}

function ebayBasicAuth_() {
  return 'Basic ' + Utilities.base64Encode(CONFIG.EBAY_CLIENT_ID + ':' + CONFIG.EBAY_CLIENT_SECRET);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 認可（初回だけ）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * eBayの同意画面のURLを組み立てる。
 * 【注意】redirect_uri に渡すのは RuName であってURLではない（eBay独自仕様）。
 */
function buildEbayAuthUrl() {
  const missing = [];
  if (!CONFIG.EBAY_CLIENT_ID) missing.push('App ID (Client ID)');
  if (!CONFIG.EBAY_RUNAME) missing.push('RuName');
  if (missing.length) {
    return { ok: false, note: '先に ' + missing.join(' と ') + ' を保存してください' };
  }

  // stateはCSRF対策。戻ってきたときに突き合わせる
  const state = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('EBAY_OAUTH_STATE', state);

  const url = ebayHosts_().auth + '/oauth2/authorize' +
    '?client_id=' + encodeURIComponent(CONFIG.EBAY_CLIENT_ID) +
    '&redirect_uri=' + encodeURIComponent(CONFIG.EBAY_RUNAME) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent(EBAY_SCOPE) +
    '&state=' + encodeURIComponent(state);

  return { ok: true, url: url, sandbox: ebayIsSandbox_() };
}

/**
 * eBayから戻ってきた認可コードを、リフレッシュトークンに交換する。
 * web-router.gs のコールバック処理から呼ばれる。
 */
function exchangeEbayCode_(code, state) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('EBAY_OAUTH_STATE');

  if (!expected || state !== expected) {
    return { ok: false, note: 'stateが一致しません。認証をやり直してください（第三者による割り込みを防ぐための確認です）' };
  }
  props.deleteProperty('EBAY_OAUTH_STATE');

  const res = UrlFetchApp.fetch(ebayHosts_().api + '/identity/v1/oauth2/token', {
    method: 'post',
    headers: { Authorization: ebayBasicAuth_() },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=authorization_code' +
             '&code=' + encodeURIComponent(code) +
             '&redirect_uri=' + encodeURIComponent(CONFIG.EBAY_RUNAME),
    muteHttpExceptions: true
  });

  const codeNum = res.getResponseCode();
  const body = res.getContentText();
  if (codeNum !== 200) {
    return { ok: false, note: 'トークン交換に失敗 HTTP' + codeNum + '：' + body.substring(0, 250) };
  }

  let json;
  try { json = JSON.parse(body); } catch (e) {
    return { ok: false, note: 'レスポンスを解析できません: ' + body.substring(0, 200) };
  }
  if (!json.refresh_token) {
    return { ok: false, note: 'リフレッシュトークンが返りませんでした: ' + body.substring(0, 200) };
  }

  props.setProperties({
    EBAY_REFRESH_TOKEN: json.refresh_token,
    EBAY_ACCESS_TOKEN: json.access_token || '',
    EBAY_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + (Number(json.expires_in || 0) * 1000))
  }, false);
  refreshConfig();

  const days = json.refresh_token_expires_in
    ? Math.round(Number(json.refresh_token_expires_in) / 86400) : null;

  return {
    ok: true,
    note: 'eBayと接続できました' + (days ? '（この接続は約' + days + '日間有効です）' : '')
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 実利用時のトークン取得（自動更新）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 有効なアクセストークンを返す。期限が近ければ自動で取り直す。
 * eBayを叩く処理は必ずこれを経由すること。
 *
 * 戻り値: { ok: true, token } / { ok: false, note }
 */
function getEbayAccessToken_() {
  // 手動で貼ったトークンがあればそれを優先（動作確認用の逃げ道。2時間で切れる）
  if (CONFIG.EBAY_OAUTH_TOKEN) {
    return { ok: true, token: CONFIG.EBAY_OAUTH_TOKEN, manual: true };
  }

  const expiresAt = Number(CONFIG.EBAY_ACCESS_TOKEN_EXPIRES_AT || 0);
  if (CONFIG.EBAY_ACCESS_TOKEN && expiresAt - EBAY_REFRESH_MARGIN_MS > Date.now()) {
    return { ok: true, token: CONFIG.EBAY_ACCESS_TOKEN };
  }

  if (!CONFIG.EBAY_REFRESH_TOKEN) {
    return { ok: false, note: 'eBayと接続されていません。セットアップ画面の「eBayと接続」から認証してください' };
  }
  if (!CONFIG.EBAY_CLIENT_ID || !CONFIG.EBAY_CLIENT_SECRET) {
    return { ok: false, note: 'App ID / Cert ID が未設定のためトークンを更新できません' };
  }

  // 複数の処理が同時に更新しにいかないようにする
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) {
    return { ok: false, note: 'トークン更新の順番待ちに失敗しました' };
  }

  try {
    // 待っている間に他の処理が更新済みかもしれないので 読み直す
    refreshConfig();
    const again = Number(CONFIG.EBAY_ACCESS_TOKEN_EXPIRES_AT || 0);
    if (CONFIG.EBAY_ACCESS_TOKEN && again - EBAY_REFRESH_MARGIN_MS > Date.now()) {
      return { ok: true, token: CONFIG.EBAY_ACCESS_TOKEN };
    }
    return refreshEbayAccessToken_();
  } finally {
    lock.releaseLock();
  }
}

function refreshEbayAccessToken_() {
  const res = UrlFetchApp.fetch(ebayHosts_().api + '/identity/v1/oauth2/token', {
    method: 'post',
    headers: { Authorization: ebayBasicAuth_() },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=refresh_token' +
             '&refresh_token=' + encodeURIComponent(CONFIG.EBAY_REFRESH_TOKEN) +
             '&scope=' + encodeURIComponent(EBAY_SCOPE),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code === 400 || code === 401) {
    return {
      ok: false,
      note: 'HTTP' + code + '：リフレッシュトークンが無効か期限切れです（約18ヶ月で切れます）。' +
            'セットアップ画面から接続し直してください。詳細: ' + body.substring(0, 200)
    };
  }
  if (code !== 200) {
    return { ok: false, note: 'トークン更新に失敗 HTTP' + code + '：' + body.substring(0, 200) };
  }

  let json;
  try { json = JSON.parse(body); } catch (e) {
    return { ok: false, note: 'レスポンスを解析できません' };
  }
  if (!json.access_token) {
    return { ok: false, note: 'アクセストークンが返りませんでした: ' + body.substring(0, 200) };
  }

  PropertiesService.getScriptProperties().setProperties({
    EBAY_ACCESS_TOKEN: json.access_token,
    EBAY_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + (Number(json.expires_in || 7200) * 1000))
  }, false);
  refreshConfig();

  return { ok: true, token: json.access_token, refreshed: true };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状態表示
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** セットアップ画面に出す接続状況 */
function getEbayAuthStatus() {
  const hasApp = !!(CONFIG.EBAY_CLIENT_ID && CONFIG.EBAY_CLIENT_SECRET && CONFIG.EBAY_RUNAME);
  const connected = !!CONFIG.EBAY_REFRESH_TOKEN;
  const expiresAt = Number(CONFIG.EBAY_ACCESS_TOKEN_EXPIRES_AT || 0);
  const validNow = !!CONFIG.EBAY_ACCESS_TOKEN && expiresAt > Date.now();

  let note;
  if (CONFIG.EBAY_OAUTH_TOKEN) {
    note = '手動で貼ったトークンを使用中です。eBayのトークンは2時間で失効するため、本番運用では「eBayと接続」で自動更新にしてください';
  } else if (!hasApp) {
    note = 'App ID / Cert ID / RuName を入れると接続できるようになります';
  } else if (!connected) {
    note = '「eBayと接続」を押すと、eBayの同意画面が開きます';
  } else {
    note = '接続済み。アクセストークンは自動更新されます' +
           (validNow ? '（現在のトークンはあと約' + Math.max(0, Math.round((expiresAt - Date.now()) / 60000)) + '分有効）' : '');
  }

  return {
    env: ebayIsSandbox_() ? 'sandbox' : 'production',
    hasApp: hasApp,
    connected: connected,
    manualToken: !!CONFIG.EBAY_OAUTH_TOKEN,
    note: note,
    callbackUrl: getWebAppUrl()
  };
}

/** 接続を解除する（別アカウントにつなぎ直したいとき用） */
function disconnectEbay() {
  PropertiesService.getScriptProperties().deleteProperty('EBAY_REFRESH_TOKEN');
  PropertiesService.getScriptProperties().deleteProperty('EBAY_ACCESS_TOKEN');
  PropertiesService.getScriptProperties().deleteProperty('EBAY_ACCESS_TOKEN_EXPIRES_AT');
  refreshConfig();
  return { ok: true, note: 'eBayとの接続を解除しました' };
}
