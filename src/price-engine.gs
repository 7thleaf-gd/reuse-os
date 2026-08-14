/**
 * Price Engine（追加ファイル）
 *
 * 【役割】商品特定(resolveProduct) の後に、実際の相場データで
 * record.pricing を埋める。現時点で実装できているのは MUSIC（Discogs）のみ。
 *
 * 【設置方法】既存の Apps Script プロジェクトに、
 * phase0-implementation.gs / phase0-batch-runner.gs と並ぶ
 * 3つ目のファイルとして追加してください。
 *
 * 【正直な現状（推測で誤魔化さない）】
 * - 第一候補: Discogs の /marketplace/price_suggestions/{release_id}
 *   コンディション別の実売相場が取れる、最も精度が高い経路。
 *   ただし実機検証の結果 HTTP 401 で失敗することを確認済み。
 *   Discogsにセラー（出品者）プロフィールが未設定だと使えない
 *   （PayPal認証・住所確認・配送ポリシー登録まで必要な「本格的な出品者登録」で、
 *   相場を見るためだけに今すぐやる必要はないと判断し、いったん保留）
 * - 第二候補（今回採用）: 公開の /releases/{release_id} エンドポイント。
 *   認証・セラー登録不要で lowest_price（現在の最安出品額）と
 *   num_for_sale（出品数）が取得できることを実機で確認済み。
 *   コンディション別ではなく「今出品されている中の最安値」という、
 *   やや粗い代わりに万人が使える指標
 * - 通貨は不明。Discogsの公式ドキュメントに lowest_price の通貨説明が
 *   見当たらないため、円換算はせず「通貨未確認（推定USD）」と明記して渡す
 * - price_suggestions は将来セラー登録した場合に備えて実装を残してあり、
 *   成功すればそちらを優先的に使う（より精度が高いため）
 * - BOOK / GEAR / CAMERA の相場データソースは未着手（BLOCKER のまま）
 */

const PRICE_ENGINE = {
  // 相場の代表値として採用するコンディション。
  // 自動的な状態判定（傷・汚れの画像診断）は行っていないため、
  // 「中古品として一般的な状態」を仮定した固定選択です。
  // 実際の商品状態が良ければ下記より高く、悪ければ低く出品すべきです。
  DEFAULT_CONDITION: 'Very Good Plus (VG+)',

  // 万一 DEFAULT_CONDITION が返ってこなかった場合に、次に試す順序
  CONDITION_FALLBACK_ORDER: [
    'Very Good Plus (VG+)',
    'Very Good (VG)',
    'Near Mint (NM or M-)',
    'Good Plus (G+)',
    'Mint (M)',
    'Good (G)',
    'Fair (F)',
    'Poor (P)'
  ],

  DISCOGS_WAIT_MS: 1100  // Discogs 推奨レート：1秒1リクエスト
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// レート制御（resolveDiscogs 側とも共有）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var __lastDiscogsCallAt = 0;

/**
 * Discogs への直近の呼び出しから 1.1 秒空ける。
 * search（resolveDiscogs）と price_suggestions（本ファイル）の
 * 両方から呼ばれるため、1商品あたり2回 Discogs を叩く場合は
 * 合計で約2.2秒かかる計算になる。300件なら最大 11分程度。
 */
function discogsRateLimit_() {
  const elapsed = Date.now() - __lastDiscogsCallAt;
  const wait = PRICE_ENGINE.DISCOGS_WAIT_MS - elapsed;
  if (wait > 0) Utilities.sleep(wait);
  __lastDiscogsCallAt = Date.now();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 本体
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * MUSIC カテゴリの record に実際の相場を付与する。
 * 呼び出し元（phase0-batch-runner.gs の identifyOneImage_）が
 * record.product.category === 'MUSIC' && record.database.dbId
 * の場合にだけ呼ぶ想定。
 */
function attachPriceSuggestions_(record) {
  if (!record || !record.database || !record.database.dbId) {
    setPriceUnavailable_(record, '商品DBの release_id が無いため相場を取得できません');
    return record;
  }

  // 第一候補: price_suggestions（コンディション別・高精度）
  const suggestions = fetchDiscogsPriceSuggestions_(record.database.dbId);

  if (suggestions.success) {
    const picked = pickCondition_(suggestions.byCondition);
    if (picked) {
      record.pricing.estimatedPrice = picked.value;
      record.pricing.currency = picked.currency;
      record.pricing.priceConfidence = 70;  // 実データ由来。ただし条件は仮定なので中程度に設定
      record.pricing.priceSource = 'discogs_price_suggestions';
      record.pricing.priceUnavailableReason = null;
      record.pricing.byCondition = suggestions.byCondition;
      record.pricing.marketplaceSource = 'discogs';
      return record;
    }
    // 成功はしたがコンディション別データが空 → フォールバックへ
  }

  const firstFailureReason = suggestions.reason;

  // 第二候補: 公開の /releases/{id} エンドポイント（lowest_price・認証/セラー登録不要）
  const fallback = fetchDiscogsReleaseLowestPrice_(record.database.dbId);

  if (!fallback.success) {
    setPriceUnavailable_(
      record,
      'price_suggestions失敗（' + firstFailureReason + '）／ 代替のlowest_priceも失敗（' + fallback.reason + '）'
    );
    return record;
  }

  record.pricing.estimatedPrice = fallback.value;
  record.pricing.currency = fallback.currency;  // '不明（推定USD）'
  record.pricing.priceConfidence = 40;  // 「今出品中の最安値」であり条件別ではないため、price_suggestionsより低め
  record.pricing.priceSource = 'discogs_lowest_price_fallback';
  record.pricing.priceUnavailableReason =
    'price_suggestionsが使えないため代替値（現在の最安出品額・通貨未確認）を使用：' + firstFailureReason;
  record.pricing.byCondition = null;
  record.pricing.marketplaceSource = 'discogs';
  record.pricing.numForSale = fallback.numForSale;

  return record;
}

function setPriceUnavailable_(record, reason) {
  if (!record || !record.pricing) return;
  record.pricing.estimatedPrice = null;
  record.pricing.priceConfidence = 0;
  record.pricing.priceSource = 'unavailable';
  record.pricing.priceUnavailableReason = reason;
}

function pickCondition_(byCondition) {
  for (const name of PRICE_ENGINE.CONDITION_FALLBACK_ORDER) {
    if (byCondition[name]) return byCondition[name];
  }
  // フォールバック順に無ければ、返ってきた中の最初の1件を使う
  const keys = Object.keys(byCondition);
  return keys.length ? byCondition[keys[0]] : null;
}

/**
 * Discogs price_suggestions を1回叩く。
 * 成功: { success: true, byCondition: {条件名: {currency, value}} }
 * 失敗: { success: false, reason: '人が読める理由' }
 */
function fetchDiscogsPriceSuggestions_(releaseId) {
  discogsRateLimit_();

  const url = 'https://api.discogs.com/marketplace/price_suggestions/' + releaseId +
    '?token=' + CONFIG.DISCOGS_TOKEN;

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'User-Agent': 'Reuse-Intake-AI/1.0' },
      muteHttpExceptions: true
    });
  } catch (e) {
    return { success: false, reason: 'HTTPリクエスト自体が失敗: ' + e.message };
  }

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code === 401 || code === 403) {
    return {
      success: false,
      reason: 'HTTP ' + code + '：認証エラー。Discogsにセラープロフィールが' +
        '未設定の可能性が高い（要 https://www.discogs.com/settings/seller で確認）'
    };
  }
  if (code === 404) {
    return { success: false, reason: 'HTTP 404：このrelease_idの相場データが存在しません' };
  }
  if (code !== 200) {
    return { success: false, reason: 'HTTP ' + code + '：' + body.substring(0, 200) };
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return { success: false, reason: 'レスポンスがJSONとして解析できません: ' + body.substring(0, 200) };
  }

  if (!json || typeof json !== 'object' || Object.keys(json).length === 0) {
    return { success: false, reason: 'レスポンスが空でした（相場データなしの可能性）' };
  }

  // 期待する形： { "Very Good Plus (VG+)": { "currency": "EUR", "value": 8.5 }, ... }
  const byCondition = {};
  Object.keys(json).forEach(function (key) {
    const v = json[key];
    if (v && typeof v.value === 'number' && v.currency) {
      byCondition[key] = { currency: v.currency, value: v.value };
    }
  });

  if (Object.keys(byCondition).length === 0) {
    return { success: false, reason: '想定と異なるレスポンス形式でした: ' + body.substring(0, 200) };
  }

  return { success: true, byCondition: byCondition };
}

/**
 * 【フォールバック経路】公開の /releases/{release_id} エンドポイントから
 * lowest_price（現在の最安出品額）と num_for_sale（出品数）を取得する。
 * 認証・セラー登録は不要。price_suggestions が使えない場合の代替。
 *
 * 【通貨についての実機検証結果（重要・鵜呑み厳禁）】
 * Discogs公式ドキュメントには curr_abbr パラメータ（?curr_abbr=JPY 等で
 * 通貨指定できる）が記載されているが、実際に無認証で
 * https://api.discogs.com/releases/249504 と
 * https://api.discogs.com/releases/249504?curr_abbr=JPY
 * を叩き比べたところ、返ってきた lowest_price は 0.64 で完全に同一だった。
 * → 無認証時は curr_abbr が無視されている（＝JPY指定してもJPYになっていない）
 *   ことを実機で確認済み。0.64という値の大きさからしても、JPYとは考えにくい
 *   （USDかEURの可能性が高いが、これも未確認＝推測）。
 * このコードでは token 付きかつ curr_abbr=JPY 付きでリクエストしている
 * （ドキュメント上は「認証ユーザーの通貨設定がデフォルトになる」とあるため、
 * token を渡すことで挙動が変わる可能性がある）が、これが実際に
 * 円換算された値を返すかどうかは GAS 側の実機テスト（testPriceEngine）で
 * 目視確認が必要。確認が取れるまでは通貨は「未確認」として扱うこと。
 */
function fetchDiscogsReleaseLowestPrice_(releaseId) {
  discogsRateLimit_();

  const url = 'https://api.discogs.com/releases/' + releaseId +
    '?curr_abbr=JPY&token=' + CONFIG.DISCOGS_TOKEN;

  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'User-Agent': 'Reuse-Intake-AI/1.0' },
      muteHttpExceptions: true
    });
  } catch (e) {
    return { success: false, reason: 'HTTPリクエスト自体が失敗: ' + e.message };
  }

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    return { success: false, reason: 'HTTP ' + code + '：' + body.substring(0, 200) };
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    return { success: false, reason: 'レスポンスがJSONとして解析できません: ' + body.substring(0, 200) };
  }

  if (json.lowest_price === null || json.lowest_price === undefined) {
    return { success: false, reason: '現在この release_id の出品がありません（lowest_price が空）' };
  }

  return {
    success: true,
    value: json.lowest_price,
    numForSale: typeof json.num_for_sale === 'number' ? json.num_for_sale : null,
    // 実機検証で curr_abbr=JPY が無視されるケースを確認済みのため、断定しない
    currency: '未確認（curr_abbr=JPY指定済みだが反映される保証なし。実額を必ず目視確認すること）'
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事前検証（本番投入前に必ず実行する）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Price Engine が実際に動くかを確認する。
 * King Crimson「In the Court of the Crimson King」の実在 release_id を使用。
 * price_suggestions → 失敗したら releases フォールバック、の順に両方試す。
 */
function testPriceEngine() {
  const KNOWN_RELEASE_ID = 249504;  // King Crimson - In the Court of the Crimson King (CD)

  Logger.log('── ① price_suggestions（コンディション別・第一候補）を試行 ──');
  const result = fetchDiscogsPriceSuggestions_(KNOWN_RELEASE_ID);

  if (result.success) {
    Logger.log('✅ 成功。取得したコンディション別相場:');
    Object.keys(result.byCondition).forEach(function (cond) {
      const p = result.byCondition[cond];
      Logger.log('  ' + cond + ': ' + p.value + ' ' + p.currency);
    });
    const picked = pickCondition_(result.byCondition);
    Logger.log('→ デフォルト採用コンディション(' + PRICE_ENGINE.DEFAULT_CONDITION + '相当): ' +
      picked.value + ' ' + picked.currency);
    Logger.log('（① が成功したのでこちらが本採用されます。② のテストは省略）');
    return;
  }

  Logger.log('❌ ① 失敗: ' + result.reason);
  Logger.log('→ https://www.discogs.com/settings/seller でセラープロフィールの状態を確認してください（想定内の失敗です）');

  Logger.log('');
  Logger.log('── ② releases/{id} の lowest_price（フォールバック・第二候補）を試行 ──');
  const fallback = fetchDiscogsReleaseLowestPrice_(KNOWN_RELEASE_ID);

  if (!fallback.success) {
    Logger.log('❌ ② も失敗: ' + fallback.reason);
    Logger.log('→ ①②とも失敗。ネットワーク／トークン設定を確認してください');
    return;
  }

  Logger.log('✅ ② 成功。lowest_price = ' + fallback.value + '　num_for_sale = ' + fallback.numForSale);
  Logger.log('⚠️ 通貨は' + fallback.currency);
  Logger.log('⚠️ 目視確認のお願い：このアルバムのVG+相当の実勢価格はだいたい数百〜数千円程度のはずです。');
  Logger.log('　　　返ってきた値 ' + fallback.value + ' がその感覚と大きくズレる場合、');
  Logger.log('　　　JPYではなく別通貨（USD/EURなど）の可能性が高いです。');
}
