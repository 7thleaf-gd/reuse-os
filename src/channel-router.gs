/**
 * Channel Router（追加ファイル）
 *
 * 【役割】1つの record について「どの販路に、どういうやり方で出せるか」を
 * 機械的に判定する。ユーザーからの2つの質問への回答をコードにしたもの：
 *
 * ① 「CDは20年前以前のもの以外は非活性にできないか？」
 *    → Etsy はハンドメイド／ヴィンテージ(製造から20年以上)／クラフト素材限定の
 *      出品ポリシーのため、対象外の商品を機械的に判定して弾く
 *      （isEtsyVintageEligible_）
 *
 * ② 「公式APIが無い販路の出品フローは絶対無理か？」
 *    → 無理ではない。ただし「自動出品」と「出品用テキストを人が手でコピペする」は
 *      全く別物。後者はそもそも各社の利用規約が禁止している「サービスへの
 *      自動アクセス」に該当しない（人間が公式アプリ/サイトを普通に操作するだけ）。
 *      メルカリ（個人）・ラクマ・ヤフオク！は現状これしか安全な道が無いため、
 *      mode: 'manual_copy' として明示的に「コピペ支援」に倒す設計にした。
 *
 * 【意図的にやっていないこと】
 * - ブラウザ自動操作（Selenium/Playwright等でフォームに自動入力→自動送信）は
 *   実装しない。理由：
 *     - ヤフオク！は利用規約で明文禁止（「自動的に出品するツール...の利用」を
 *       出品者の禁止行為として明記。運営の個別許可がある場合を除く）
 *     - メルカリは「弊社が提供するインターフェイスとは別の手法でのアクセス」を
 *       禁止事項としており、本人操作か否かを区別する文言が無い（グレー）
 *     - ラクマは該当条項を発見できず（未確認＝安全とは言えない）
 *   → REUSE開発方針「自動出品は公式API/正当な手段のみ、規約違反の自動化はしない」
 *     に従い、この3社は「コピペ支援」までに留める
 */

const CHANNEL_POLICY = {
  EBAY: {
    label: 'eBay',
    mode: 'api',               // 公式Inventory APIで自動出品・自動停止とも可能（withdrawOffer確認済み）
    categoryRestriction: null,
    note: '公式APIが個人セラーにも開放されている。中古メディア全般OK。出品停止(withdrawOffer)・売却検知(Platform Notifications)とも公式に確認済み'
  },
  ETSY: {
    label: 'Etsy',
    mode: 'api_vintage_gated', // 公式APIはあるが、出品ポリシー上「ヴィンテージ品のみ」
    categoryRestriction: 'vintage_20y',
    note: '公式Open API v3。出品ポリシーがハンドメイド/ヴィンテージ(20年以上)/クラフト限定。停止はupdateListing(state=deactivated)で確認済み'
  },
  MERCARI_SHOPS: {
    label: 'メルカリShops（法人）',
    mode: 'api_contract_gated', // トークン自体はショップ管理画面から自己発行できるが、
                                 // API呼び出しに必須のAPI_CLIENT_NAMEはMercariとの契約時に発行される
    categoryRestriction: null,
    note: '公式GraphQL APIあり。Personal API Access Tokenは自己発行可能だが、API_CLIENT_NAMEは契約時にMercariから付与されるため実質契約が必要。古物商許可も別途必要。停止はdeleteProductで確認済み（ただし在庫0だけでは売り抜けた実例が公式サポートに記載あり、要注意）'
  },
  YAHOO_SHOPPING: {
    label: 'Yahoo!ショッピング（ストア）',
    mode: 'api_store_approval_gated', // API自体は現役で商品登録・在庫更新が可能だが、
                                       // 使うには出店審査を通ったストアである必要がある
    categoryRestriction: null,
    note: '商品登録API(editItem)・在庫更新API(setStock)とも現役（2026年も更新あり）。ただし出店審査を通ったストアであることが前提。Webhookが無くポーリングのみ、フロント反映も別処理と明記されており停止の即時性は弱い'
  },
  MERCARI: {
    label: 'メルカリ（個人）',
    mode: 'manual_copy',       // 自動アクセスを禁ずる利用規約があるためコピペ支援のみ
    categoryRestriction: null,
    note: '公式出品APIなし。利用規約が「弊社提供インターフェイス以外でのアクセス」を禁止事項としており自動化は非推奨'
  },
  RAKUMA: {
    label: 'ラクマ',
    mode: 'manual_copy',
    categoryRestriction: null,
    note: '公式出品APIの存在を確認できず。自動化の可否条項も未確認のためコピペ支援に留める'
  },
  YAHOO_AUCTION: {
    label: 'ヤフオク！（個人）',
    mode: 'manual_copy',
    categoryRestriction: null,
    note: '個人向け出品APIは2018年・2020年に相次いで提供終了、現存しない。利用規約でも「自動的に出品するツールの利用」を明確に禁止（運営の個別許可がある場合を除く）。コピペ支援のみ'
  }
};

const ETSY_VINTAGE_MIN_AGE_YEARS = 20;

/**
 * Etsyのヴィンテージ規定（製造から20年以上）を満たすかを判定する。
 *
 * 【重要な限界（誤魔化さない）】
 * record.product.year は Discogs 等 DB とのマッチ結果から来ており、
 * バーコードで正確な盤（プレス）まで特定できていれば「そのプレスの発売年」を
 * 反映しているはずだが、これは「今回撮影した現物が実際にいつ製造されたか」の
 * 完全な証明にはならない（同一カタログ番号で再プレスされているケースは
 * 判定できない）。あくまで機械的な一次判定であり、Etsy出品前には
 * 人間の目視確認を必須とする。
 */
function isEtsyVintageEligible_(record) {
  const year = record && record.product ? record.product.year : null;

  if (!year || typeof year !== 'number') {
    return {
      eligible: false,
      reason: '年式が不明なため判定不可（手動確認が必要）',
      ageYears: null
    };
  }

  const currentYear = new Date().getFullYear();
  const ageYears = currentYear - year;

  if (ageYears >= ETSY_VINTAGE_MIN_AGE_YEARS) {
    return {
      eligible: true,
      reason: '発売年(' + year + ')から' + ageYears + '年経過。Etsyのヴィンテージ基準(20年以上)を満たす（※現物が同一プレスである前提の一次判定、出品前に目視確認推奨）',
      ageYears: ageYears
    };
  }

  return {
    eligible: false,
    reason: '発売年(' + year + ')から' + ageYears + '年しか経過していない（Etsyのヴィンテージ基準20年未満のため対象外）',
    ageYears: ageYears
  };
}

/**
 * record 1件について、各販路のOK/NGと理由を判定する。
 * 戻り値: [{ channel, label, mode, eligible, reason }, ...]
 */
function evaluateChannels_(record) {
  const results = [];

  Object.keys(CHANNEL_POLICY).forEach(function (key) {
    const policy = CHANNEL_POLICY[key];
    let eligible = true;
    let reason = policy.note;

    if (policy.categoryRestriction === 'vintage_20y') {
      const check = isEtsyVintageEligible_(record);
      eligible = check.eligible;
      reason = check.reason;
    }

    results.push({
      channel: key,
      label: policy.label,
      mode: policy.mode,
      eligible: eligible,
      reason: reason
    });
  });

  return results;
}

/**
 * evaluateChannels_() の結果を、Sheetの1セルに収まる短い要約文にする。
 * 例："eBay:OK(自動) / Etsy:NG(ヴィンテージ基準未満) / メルカリ・ラクマ・ヤフオク:コピペ出品可"
 */
function buildChannelSummaryText_(channels) {
  const apiOk = [];       // すぐ自動出品・自動停止できる
  const apiGated = [];    // APIはあるが契約/審査待ちで今は使えない
  const apiNg = [];       // 対象外（ヴィンテージ基準未満など）
  const manualCopy = [];  // コピペ出品のみ

  channels.forEach(function (c) {
    if (c.mode === 'api' && c.eligible) {
      apiOk.push(c.label);
    } else if (c.mode === 'api_vintage_gated') {
      if (c.eligible) {
        apiOk.push(c.label + '(ヴィンテージ該当)');
      } else {
        apiNg.push(c.label);
      }
    } else if (c.mode === 'api_contract_gated' || c.mode === 'api_store_approval_gated') {
      apiGated.push(c.label);
    } else if (c.mode === 'manual_copy') {
      manualCopy.push(c.label);
    }
  });

  const parts = [];
  if (apiOk.length) parts.push('自動出品可:' + apiOk.join('/'));
  if (apiGated.length) parts.push('要契約/審査:' + apiGated.join('/'));
  if (apiNg.length) parts.push('対象外:' + apiNg.join('/'));
  if (manualCopy.length) parts.push('コピペ出品可:' + manualCopy.join('/'));

  return parts.join(' / ');
}

/**
 * record に channelSummary / channelEligibility を書き込む。
 * identifyOneImage_（phase0-batch-runner.gs）から
 * generateListingCopy_ の直後に呼ぶ想定。
 */
function attachChannelRouting_(record) {
  const channels = evaluateChannels_(record);
  record.content.channelEligibility = channels;
  record.content.channelSummary = buildChannelSummaryText_(channels);
  return record;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動作確認（外部APIを叩かない）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testChannelRouter() {
  const currentYear = new Date().getFullYear();

  const oldRecord = new CanonicalProductRecord();
  oldRecord.product.category = 'MUSIC';
  oldRecord.product.year = currentYear - 25;  // 25年前 → Etsy対象

  const newRecord = new CanonicalProductRecord();
  newRecord.product.category = 'MUSIC';
  newRecord.product.year = currentYear - 5;   // 5年前 → Etsy対象外

  const unknownRecord = new CanonicalProductRecord();
  unknownRecord.product.category = 'MUSIC';
  unknownRecord.product.year = null;          // 年式不明

  [
    ['25年前の盤', oldRecord],
    ['5年前の盤', newRecord],
    ['年式不明', unknownRecord]
  ].forEach(function (pair) {
    const label = pair[0];
    const record = pair[1];
    attachChannelRouting_(record);
    Logger.log('── ' + label + ' ──');
    Logger.log(record.content.channelSummary);
    record.content.channelEligibility.forEach(function (c) {
      Logger.log('  ' + c.label + ': ' + (c.eligible ? 'OK' : 'NG') + ' (' + c.reason + ')');
    });
  });
}
