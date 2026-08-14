/**
 * Listing Generator（追加ファイル）
 *
 * 【役割】CanonicalProductRecord から出品タイトル・説明文を生成する。
 * AIによる自然文生成ではなく、確定的なテンプレートです（REUSE開発方針の
 * 「最短実装案：テンプレート文字列生成から始める」に対応）。
 *
 * 【設置方法】既存プロジェクトに4つ目のファイルとして追加してください。
 *
 * 【意図的にやっていないこと】
 * - 商品状態（傷・汚れ）の自動判定 → 撮影画像からの状態診断は未実装。
 *   説明文には「状態は現物確認のうえ出品前にご確認ください」と明記する
 * - 多言語対応 → 日本語のみ。eBay等海外出品には英語版が別途必要（未着手）
 */

/**
 * record からタイトルと説明文を生成する。
 * 戻り値: { title: string, description: string, warnings: string[] }
 */
function generateListingCopy_(record) {
  const warnings = [];
  const p = record.product;
  const pricing = record.pricing;

  const title = buildTitle_(record, warnings);
  const description = buildDescription_(record, warnings);

  // resolveProduct() 側で検出したフォーマット食い違いの注意（record.content.listingWarnings
  // は呼び出し元で丸ごと上書きされるため、ここで生成するwarnings配列に必ず含める）
  if (record.product.formatConfidenceNote) {
    warnings.push(record.product.formatConfidenceNote);
  }

  return { title: title, description: description, warnings: warnings };
}

function buildTitle_(record, warnings) {
  const p = record.product;
  const parts = [];

  if (p.category === 'MUSIC') {
    if (p.brand) parts.push(p.brand);
    if (p.productName) parts.push(p.productName);
    const meta = [];
    if (p.format) meta.push(p.format);
    if (p.year) meta.push(String(p.year));
    if (meta.length) parts.push('[' + meta.join(' / ') + ']');
  } else if (p.category === 'BOOK') {
    if (p.productName) parts.push(p.productName);
    if (p.brand) parts.push('/ ' + p.brand);  // brand = 出版社（resolveGoogleBooksでは maker が出版社なので注意）
  } else {
    if (p.brand) parts.push(p.brand);
    if (p.productName) parts.push(p.productName);
    if (p.modelName) parts.push(p.modelName);
  }

  if (parts.length === 0) {
    warnings.push('タイトルに使える情報が無く、空タイトルになっています。手動で入力してください');
    return '（要手動入力）';
  }

  const title = parts.join(' ').trim();

  // 主要マーケットプレイスの一般的なタイトル文字数上限（80文字）を意識
  if (title.length > 80) {
    warnings.push('タイトルが80文字を超えています（' + title.length + '文字）。短縮を検討してください');
  }

  return title;
}

function buildDescription_(record, warnings) {
  const p = record.product;
  const pricing = record.pricing;
  const lines = [];

  lines.push('【商品名】' + (p.productName || '不明'));
  if (p.brand) lines.push('【アーティスト/ブランド】' + p.brand);
  if (p.format) lines.push('【形式】' + p.format);
  if (p.year) lines.push('【年式】' + p.year);
  if (record.identifiers.barcode) {
    lines.push('【バーコード】' + record.identifiers.barcode +
      (record.identifiers.barcodeType ? '（' + record.identifiers.barcodeType + '）' : ''));
  }

  lines.push('');
  lines.push('【状態】中古品です。状態は現物確認のうえ、出品前に必ず加筆・修正してください。');
  lines.push('　　　　（本文は自動生成のため、傷・汚れ等の実際の状態は反映されていません）');

  lines.push('');
  if (pricing.priceSource === 'discogs_price_suggestions') {
    lines.push('【参考相場】' + pricing.estimatedPrice + ' ' + pricing.currency +
      '（Discogs実売相場・コンディション「Very Good Plus (VG+)」相当を仮定）');
    lines.push('　　　　　　※実際の商品状態に応じて価格を調整してください');
    if (pricing.currency && pricing.currency !== 'JPY') {
      lines.push('　　　　　　※通貨は ' + pricing.currency + ' のままです。円換算は未実装です');
      warnings.push('通貨が JPY ではなく ' + pricing.currency + ' です（円換算は未実装）');
    }
  } else if (pricing.priceSource === 'discogs_lowest_price_fallback') {
    lines.push('【参考相場（簡易値・要確認）】' + pricing.estimatedPrice +
      '（コンディション別ではなく「現在の最安出品額」。通貨は未確認です）');
    if (typeof pricing.numForSale === 'number') {
      lines.push('　　　　　　（現在の出品数：' + pricing.numForSale + '件）');
    }
    lines.push('　　　　　　⚠️ この数字をそのまま出品価格にしないでください。通貨・条件とも未確認の目安です');
    warnings.push('相場は簡易フォールバック値（通貨未確認・コンディション未考慮）。出品前に必ず金額を目視確認すること');
  } else {
    lines.push('【参考相場】取得できませんでした（理由：' +
      (pricing.priceUnavailableReason || '不明') + '）。手動で相場を確認してください');
    warnings.push('相場データなし：' + (pricing.priceUnavailableReason || '不明'));
  }

  if (record.database.dbMatch && record.database.dbMatch.url) {
    lines.push('');
    lines.push('【DB参照】' + record.database.dbMatch.url);
  }

  return lines.join('\n');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動作確認
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * ダミーの record で生成結果を確認する（外部APIを叩かない）
 */
function testListingGenerator() {
  const record = new CanonicalProductRecord();
  record.product.category = 'MUSIC';
  record.product.brand = 'King Crimson';
  record.product.productName = 'In the Court of the Crimson King';
  record.product.format = 'CD';
  record.product.year = 1969;
  record.identifiers.barcode = '4988007123457';
  record.identifiers.barcodeType = 'JAN_13';
  record.database.dbMatch = { url: 'https://www.discogs.com/release/249504' };
  record.pricing.priceSource = 'discogs_price_suggestions';
  record.pricing.estimatedPrice = 9.35;
  record.pricing.currency = 'EUR';

  const copy = generateListingCopy_(record);
  Logger.log('── タイトル ──');
  Logger.log(copy.title);
  Logger.log('── 説明文 ──');
  Logger.log(copy.description);
  if (copy.warnings.length) {
    Logger.log('── 警告 ──');
    copy.warnings.forEach(function (w) { Logger.log('⚠️ ' + w); });
  }
}
