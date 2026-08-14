/**
 * Phase 0 バッチ実行エンジン（追加ファイル）
 *
 * 【役割】
 * phase0-implementation.gs は「1枚を処理する部品」しか持っていません。
 * このファイルが、Drive フォルダの写真を1枚ずつ取り出して
 * OCR → 商品特定 → Sheet 記録 まで自動で回します。
 *
 * 【設置方法】
 * phase0-implementation.gs と「同じ Apps Script プロジェクト内」に
 * 新しいファイルとして追加してください（左メニューのファイル ＋ → スクリプト）。
 * CONFIG は phase0-implementation.gs のものを共有するので、設定は不要です。
 *
 * 【使い方】
 *   1. Drive の Phase0-Images フォルダに写真をアップロード
 *   2. 関数 startBatchProcessing を選んで ▶ 実行
 *      → 5分ごとに自動で処理が続き、全部終わると自動停止します
 *   3. 進捗を見たいときは checkProgress を実行
 *   4. 止めたいときは stopBatchProcessing を実行
 *
 * 【設計上の注意】
 * ・GAS は1回の実行が6分まで。4分30秒で安全に中断し、次のトリガーが続きを処理します
 * ・処理済みの写真は _processed フォルダへ移動するので、二重処理が起きません
 * ・Discogs は 1秒1リクエストが上限のため、待機を入れています
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// バッチ設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BATCH = {
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,  // 4分30秒で安全に中断（GAS上限6分）
  TRIGGER_INTERVAL_MIN: 5,          // 次の実行までの間隔（分）
  DISCOGS_WAIT_MS: 1100,            // Discogs レート制限対策（1秒1リクエスト）
  PROCESSED_FOLDER: '_processed',   // 処理済み写真の移動先
  FAILED_FOLDER: '_failed',         // 処理に失敗した写真の移動先
  SHEET_PENDING: 'pending_approval',
  SHEET_ERROR: 'error_log'
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 入口：これを実行する
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * バッチ処理を開始する。
 * 5分ごとの自動実行トリガーを仕掛けたうえで、すぐ1回目を実行します。
 */
function startBatchProcessing() {
  removeBatchTriggers_();

  ScriptApp.newTrigger('processDriveImages')
    .timeBased()
    .everyMinutes(BATCH.TRIGGER_INTERVAL_MIN)
    .create();

  Logger.log('▶ バッチ処理を開始しました（' + BATCH.TRIGGER_INTERVAL_MIN + '分ごとに自動継続）');
  processDriveImages();
}

/**
 * バッチ処理を停止する（途中でやめたいとき）
 */
function stopBatchProcessing() {
  removeBatchTriggers_();
  Logger.log('■ バッチ処理を停止しました');
}

/**
 * 進捗を確認する
 */
function checkProgress() {
  const root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const remaining = countImages_(root);
  const done = countImages_(getSubFolder_(root, BATCH.PROCESSED_FOLDER));
  const failed = countImages_(getSubFolder_(root, BATCH.FAILED_FOLDER));
  const total = remaining + done + failed;

  const sheet = SpreadsheetApp.openById(CONFIG.SHEET_ID).getSheetByName(BATCH.SHEET_PENDING);
  const rows = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;

  Logger.log(
    '─── 進捗 ───\n' +
    '未処理:   ' + remaining + ' 枚\n' +
    '処理済み: ' + done + ' 枚\n' +
    '失敗:     ' + failed + ' 枚\n' +
    '合計:     ' + total + ' 枚' + (total > 0 ? '（' + Math.round(done / total * 100) + '% 完了）' : '') + '\n' +
    'Sheet 記録行数: ' + rows + ' 行'
  );

  return { remaining: remaining, done: done, failed: failed, total: total, sheetRows: rows };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 本体：Drive の写真を順に処理する
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function processDriveImages() {
  const startedAt = Date.now();
  const root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const processedFolder = getOrCreateSubFolder_(root, BATCH.PROCESSED_FOLDER);
  const failedFolder = getOrCreateSubFolder_(root, BATCH.FAILED_FOLDER);

  ensurePendingSheet_();

  let processed = 0;
  let failed = 0;
  let hitTimeLimit = false;

  const files = root.getFiles();

  while (files.hasNext()) {
    if (Date.now() - startedAt > BATCH.MAX_RUNTIME_MS) {
      hitTimeLimit = true;
      break;
    }

    const file = files.next();
    if (!isImage_(file)) continue;

    try {
      const record = identifyOneImage_(file);
      appendRecordRow_(record, file.getName());
      file.moveTo(processedFolder);
      processed++;
      Logger.log('✅ ' + file.getName() + ' → ' +
        (record.product.productName || '(特定できず)') +
        ' [' + record.product.category + ' / 確信度 ' + record.metadata.confidenceScore + '%]');
    } catch (e) {
      failed++;
      logError_(file.getName(), e);
      try { file.moveTo(failedFolder); } catch (_) {}
      Logger.log('⚠️ ' + file.getName() + ' の処理に失敗: ' + e.message);
    }
  }

  const remaining = countImages_(root);

  Logger.log('── この実行の結果 ──');
  Logger.log('処理: ' + processed + ' 枚 / 失敗: ' + failed + ' 枚 / 残り: ' + remaining + ' 枚');

  if (remaining === 0) {
    removeBatchTriggers_();
    Logger.log('🎉 全ての写真の処理が完了しました。Sheet の pending_approval を確認してください。');
  } else if (hitTimeLimit) {
    Logger.log('⏱ 実行時間の上限に達したため中断しました。' +
      BATCH.TRIGGER_INTERVAL_MIN + '分後に自動で続きを処理します。');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1枚を処理する
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 画像1枚から Canonical Product Record を作る。
 * Vision API は OCR とバーコードを1回のリクエストにまとめて呼びます
 * （HTTP往復が半分になり、処理時間が短くなります）。
 */
function identifyOneImage_(file) {
  const vision = analyzeImageWithVision_(file.getBlob());

  const ocrResult = {
    success: !!vision.rawText,
    rawText: vision.rawText,
    confidence: 0.85
  };
  const barcodeResult = {
    success: vision.barcodes.length > 0,
    barcodes: vision.barcodes
  };

  const routed = routeCategory(barcodeResult, ocrResult);

  // 【注意】Discogsのレート制限（1秒1リクエスト）は、実際にDiscogsを叩く
  // resolveDiscogs() / fetchDiscogsPriceSuggestions_() の内部で
  // discogsRateLimit_() として一元管理している（price-engine.gs）。
  // ここで一律に待機を入れると、BOOK（Google Books＝無関係なAPI）まで
  // 不要に待たされるため、ここでは待たない。

  const record = resolveProduct(
    routed.category,
    ocrResult.rawText,
    barcodeResult.success ? barcodeResult.barcodes[0] : null,
    file.getId()
  );

  // カテゴリ自体が判定できなかった場合も記録は残す（後で人が直せるように）
  if (routed.category === 'UNKNOWN') {
    record.product.category = 'UNKNOWN';
    record.identifiers.ocrText = [ocrResult.rawText];
    record.approval.status = 'pending';
  }

  // Price Engine：現時点で実データが取れるのは MUSIC（Discogs）のみ
  if (record.product.category === 'MUSIC' && record.database.dbId) {
    attachPriceSuggestions_(record);
  }

  // Listing Generator：カテゴリ不明でもタイトル無し扱いで生成は試みる
  const copy = generateListingCopy_(record);
  record.content.title = copy.title;
  record.content.description = copy.description;
  record.content.listingWarnings = copy.warnings;

  // Channel Router：どの販路にOK/NGか（Etsyのヴィンテージ判定・
  // メルカリ/ラクマ/ヤフオクはコピペ出品のみ、等）を付与
  attachChannelRouting_(record);

  return record;
}

/**
 * Vision API を1回呼び、OCR テキストを取得する。
 * バーコードは OCR テキストから数字列を抽出して復元する。
 *
 * 【重要】Cloud Vision API に BARCODE_DETECTION という feature type は存在しません。
 * 公式の Feature.Type は次の13種のみです：
 *   TYPE_UNSPECIFIED / FACE_DETECTION / LANDMARK_DETECTION / LOGO_DETECTION /
 *   LABEL_DETECTION / TEXT_DETECTION / DOCUMENT_TEXT_DETECTION /
 *   SAFE_SEARCH_DETECTION / IMAGE_PROPERTIES / CROP_HINTS / WEB_DETECTION /
 *   PRODUCT_SEARCH / OBJECT_LOCALIZATION
 *   出典: https://docs.cloud.google.com/vision/docs/reference/rest/v1/Feature
 *
 * バーコードの下には必ず数字が印字されているため、OCR でその数字を読み取れば
 * JAN / EAN / ISBN として利用できます。縞模様のデコードは行いません。
 * 縞模様そのものを読む必要がある場合は ML Kit（端末側）や
 * ブラウザの BarcodeDetector API を使う必要があり、GAS 単体では不可能です。
 */
function analyzeImageWithVision_(blob) {
  const payload = {
    requests: [{
      image: { content: Utilities.base64Encode(blob.getBytes()) },
      features: [
        { type: 'TEXT_DETECTION' }
      ]
    }]
  };

  const url = 'https://vision.googleapis.com/v1/images:annotate?key=' + CONFIG.VISION_API_KEY;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code !== 200) {
    throw new Error('Vision API エラー (HTTP ' + code + '): ' + body.substring(0, 300));
  }

  const result = JSON.parse(body);
  const r = (result.responses && result.responses[0]) || {};

  if (r.error) {
    throw new Error('Vision API エラー: ' + r.error.message);
  }

  const rawText = (r.textAnnotations && r.textAnnotations[0] && r.textAnnotations[0].description) || '';

  return { rawText: rawText, barcodes: extractBarcodesFromText_(rawText) };
}

/**
 * OCR テキストから JAN / EAN / ISBN を抽出する。
 * チェックディジット検証を通ったものだけを返すので、
 * 「たまたま13桁だった数字」を誤ってバーコードと見なしません。
 */
function extractBarcodesFromText_(text) {
  if (!text) return [];

  const found = [];
  const seen = {};
  const src = String(text);

  function consider(code) {
    if (seen[code]) return;
    if (code.length !== 13 && code.length !== 12 && code.length !== 10) return;
    if (!isValidBarcode_(code)) return;
    seen[code] = true;
    found.push({ rawValue: code, format: barcodeFormat_(code) });
  }

  // ① 区切りのない数字の連続。桁数が完全一致するものだけを採用する。
  //    長い数字列の一部を切り出すと、価格や管理番号を誤ってバーコードと
  //    判定してしまうため、部分一致は取らない。
  (src.match(/\d+/g) || []).forEach(consider);

  // ② ハイフン区切りの ISBN 表記（978-4-10-100115-9 など）
  (src.match(/\d[\d-]{9,18}\d/g) || []).forEach(function (raw) {
    if (raw.indexOf('-') === -1) return;   // ①で処理済み
    consider(raw.replace(/-/g, ''));
  });

  // ③ 末尾が X の ISBN-10（4-10-100115-X など）
  (src.match(/\d[\d-]{7,14}[Xx]/g) || []).forEach(function (raw) {
    consider(raw.replace(/-/g, '').toUpperCase());
  });

  return found;
}

function isValidBarcode_(code) {
  if (/^0+$/.test(code)) return false;
  if (code.length === 13 || code.length === 12) return isValidEan_(code);
  if (code.length === 10) return isValidIsbn10_(code);
  return false;
}

/** EAN-13 / UPC-A のチェックディジット検証 */
function isValidEan_(code) {
  const d = code.split('').map(Number);
  const check = d.pop();
  d.reverse();
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    sum += d[i] * (i % 2 === 0 ? 3 : 1);
  }
  return ((10 - (sum % 10)) % 10) === check;
}

/** ISBN-10 のチェックディジット検証（末尾 X は10として扱う） */
function isValidIsbn10_(code) {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (!/\d/.test(code[i])) return false;
    sum += (10 - i) * Number(code[i]);
  }
  const last = code[9].toUpperCase();
  sum += (last === 'X') ? 10 : Number(last);
  return sum % 11 === 0;
}

function barcodeFormat_(code) {
  if (code.length === 10) return 'ISBN_10';
  if (code.length === 12) return 'UPC_A';
  if (/^97[89]/.test(code)) return 'ISBN_13';
  if (/^4[59]/.test(code)) return 'JAN_13';
  return 'EAN_13';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sheet への記録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 【注意】列の並び順を変えないこと。既存シート（testIdentificationFlow で
// 作られたものを含む）への追記は「末尾に足りない列を追加する」方式のみで
// 移行するため、途中に列を挿し込むと過去データとずれます。
// 新しい情報は必ず配列の末尾に追加してください。
const PENDING_HEADERS = [
  'Status', 'Category', 'Brand', 'Product', 'Model', 'Barcode',
  'Year', 'Format', 'DB ID', 'Confidence %', 'Est. Price ¥',
  'User OK?', 'User Notes', 'Created', 'Image',
  // ここから Price Engine / Listing Generator 追加分（末尾に追加）
  'Currency', 'Price Source', 'Title', 'Description Preview', 'Listing Warnings',
  // ここから Channel Router 追加分（末尾に追加）
  'Channels'
];

function ensurePendingSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(BATCH.SHEET_PENDING);

  if (!sheet) {
    sheet = ss.insertSheet(BATCH.SHEET_PENDING);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, PENDING_HEADERS.length).setValues([PENDING_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, PENDING_HEADERS.length).setFontWeight('bold');
    return sheet;
  }

  // 既存シートに無い列だけを、末尾に順番通り追加する（既存データは一切動かさない）
  const lastCol = sheet.getLastColumn();
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = PENDING_HEADERS.filter(function (h) { return existing.indexOf(h) === -1; });

  if (missing.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold');
  }

  return sheet;
}

function appendRecordRow_(record, imageName) {
  const sheet = ensurePendingSheet_();

  // 説明文は長いのでプレビューだけ（先頭120文字）。全文は Listing Generator を
  // 再実行すれば同じ内容が得られる（record は保存していないため）
  const descPreview = record.content.description
    ? record.content.description.replace(/\n/g, ' / ').substring(0, 120)
    : '';

  sheet.appendRow([
    record.approval.status,
    record.product.category,
    record.product.brand,
    record.product.productName,
    record.product.modelName,
    record.identifiers.barcode,
    record.product.year,
    record.product.format,
    record.database.dbId,
    record.metadata.confidenceScore,
    record.pricing.estimatedPrice,
    '',                       // User OK?（人が入力する列）
    '',                       // User Notes
    new Date().toISOString(),
    imageName,
    record.pricing.currency || '',
    record.pricing.priceSource || '',
    record.content.title || '',
    descPreview,
    (record.content.listingWarnings || []).join(' / '),
    record.content.channelSummary || ''
  ]);
}

function logError_(imageName, err) {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    let sheet = ss.getSheetByName(BATCH.SHEET_ERROR);
    if (!sheet) {
      sheet = ss.insertSheet(BATCH.SHEET_ERROR);
      sheet.getRange(1, 1, 1, 4)
        .setValues([['Timestamp', 'Image', 'Error', 'Stack']])
        .setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date().toISOString(),
      imageName,
      String(err && err.message ? err.message : err),
      String((err && err.stack) || '').substring(0, 1000)
    ]);
  } catch (_) {
    // エラーログの記録に失敗しても本処理は止めない
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘルパー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function isImage_(file) {
  const type = file.getMimeType();
  return type === MimeType.JPEG || type === MimeType.PNG ||
         type === 'image/heic' || type === 'image/webp';
}

function countImages_(folder) {
  if (!folder) return 0;
  let n = 0;
  const files = folder.getFiles();
  while (files.hasNext()) {
    if (isImage_(files.next())) n++;
  }
  return n;
}

function getSubFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function getOrCreateSubFolder_(parent, name) {
  return getSubFolder_(parent, name) || parent.createFolder(name);
}

function removeBatchTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processDriveImages') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事前テスト（本番前に必ず1回やる）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 写真を3〜5枚だけ入れた状態で実行し、
 * Vision API・Discogs・Sheet 記録が全て通るか確認する。
 * トリガーは仕掛けないので、その場で1回だけ動きます。
 */
function testWithFewImages() {
  const root = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const count = countImages_(root);

  if (count === 0) {
    Logger.log('⚠️ フォルダに画像がありません。テスト用に3〜5枚アップロードしてから実行してください。');
    return;
  }
  if (count > 10) {
    Logger.log('⚠️ ' + count + ' 枚あります。テストは3〜5枚で行ってください（本番は startBatchProcessing）。');
    return;
  }

  Logger.log('🧪 テスト実行：' + count + ' 枚を処理します');
  processDriveImages();
  checkProgress();
}

/**
 * Vision API のキーが正しく動くかだけを確認する（画像不要・1ユニット消費）
 */
function testVisionApiKey() {
  // 1x1 の白い PNG
  const tiny = Utilities.base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  );
  try {
    analyzeImageWithVision_(Utilities.newBlob(tiny, 'image/png', 'test.png'));
    Logger.log('✅ Vision API キーは正常です');
  } catch (e) {
    Logger.log('❌ Vision API でエラー: ' + e.message);
  }
}

/**
 * Discogs トークンが正しく動くかだけを確認する
 */
function testDiscogsToken() {
  const result = resolveDiscogs('King Crimson\nIn the Court of the Crimson King');
  if (result) {
    Logger.log('✅ Discogs は正常です → ' + result.title + '（' + result.year + '）');
  } else {
    Logger.log('❌ Discogs から結果が取得できませんでした。トークンを確認してください。');
  }
}
