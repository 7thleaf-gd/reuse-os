/**
 * Phase 0 実装ガイド（赤ペン修正版）
 * 
 * 【コア設計】
 * 写真 / バーコード
 *    ↓
 * [Identifier Layer]
 * JAN / EAN / UPC / ISBN / 型番 / OCR文字列
 *    ↓
 * [Category Router]
 * BOOK / MUSIC / GAME / GEAR / CAMERA
 *    ↓
 * [Resolver]
 * BOOK    → Google Books
 * MUSIC   → Discogs
 * GAME    → IGDB等（商用条件確認必須）
 * GEAR    → Reverb
 * CAMERA  → メーカー/型番DB + marketplace
 *    ↓
 * [Normalization]
 * バラバラな中古品 → Canonical Product Record
 *    ↓
 * [Approval]
 * 人間確認 → Google Sheets
 *    ↓
 * [Export]
 * CSV出力
 *    ↓
 * Phase 1: 複数モール出品（Phase 0では NOT IMPLEMENTED）
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 設定
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CONFIG = {
  // ▼▼▼ ここ3行だけ、ご自分のキーに書き換えてください ▼▼▼
  VISION_API_KEY: 'ここにGoogle CloudのAPIキーを貼る',
  GOOGLE_API_KEY: 'ここに同じAPIキーを貼る',
  DISCOGS_TOKEN:  'ここにDiscogsトークンを貼る',
  // ▲▲▲ ここまで ▲▲▲

  // 以下は設定済み（書き換え不要）
  SHEET_ID: '__REDACTED_SHEET_ID__',
  DRIVE_FOLDER_ID: '__REDACTED_DRIVE_FOLDER_ID__',
  HOURLY_RATE: 1500,

  // ▼▼▼ 販路連携（inventory-manager.gs用・まだどれも未設定でOK） ▼▼▼
  // 空文字/未設定のままなら、その販路の自動停止は「not_configured」として
  // スキップされるだけで、他の処理は止まらない設計にしてあります
  EBAY_OAUTH_TOKEN: '',              // eBay Inventory API用（未取得）
  ETSY_API_KEY: '',                  // Etsy Open API v3 keystring（未取得）
  ETSY_OAUTH_TOKEN: '',              // Etsy OAuth2アクセストークン（未取得）
  ETSY_SHOP_ID: '',                  // EtsyショップID（未取得）
  MERCARI_SHOPS_ACCESS_TOKEN: '',    // Mercari Shops Personal API Access Token（未取得）
  MERCARI_SHOPS_CLIENT_NAME: '',     // Mercari Shopsが契約時に発行するAPI_CLIENT_NAME（未取得）
  YAHOO_SHOPPING_ACCESS_TOKEN: '',   // Yahoo!ショッピング商品登録APIアクセストークン（未取得）
  YAHOO_SHOPPING_SELLER_ID: ''       // Yahoo!ショッピングストアのセラーID（未取得）
  // ▲▲▲ ここまで ▲▲▲
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Canonical Product Record（統一商品レコード）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class CanonicalProductRecord {
  constructor() {
    this.metadata = {
      id: null,
      createdAt: new Date(),
      sourceImageId: null,
      confidenceScore: 0  // 0-100
    };
    
    this.identifiers = {
      barcode: null,      // JAN/EAN/ISBN/UPC
      barcodeType: null,  // 'JAN', 'ISBN', 'UPC', etc
      modelNumber: null,  // 型番
      ocrText: []         // OCR抽出文字列
    };
    
    this.product = {
      category: null,     // MUSIC / BOOK / GAME / GEAR / CAMERA
      brand: null,
      maker: null,
      productName: null,
      modelName: null,
      edition: null,
      year: null,
      condition: null,    // 'Used', 'Excellent', 'Fair'
      format: null,       // CD, Vinyl, Book, PS4, etc
      formatConfidenceNote: null  // OCRテキストから拾えたフォーマットのヒントとDB側formatが食い違う場合の注意書き
    };
    
    this.database = {
      source: null,       // 'discogs', 'googlebooks', 'igdb', 'reverb', etc
      dbId: null,
      dbMatch: null,
      sourceMatches: []
    };
    
    this.pricing = {
      estimatedPrice: null,
      currency: null,          // 相場データが持つ通貨。JPYとは限らない（未換算のまま保持）
      marketplaceSource: null,
      priceConfidence: 0,      // 0-100
      priceSource: null,       // 'discogs_price_suggestions' | 'placeholder' | 'unavailable'
      priceUnavailableReason: null,  // 取得できなかった場合の理由（人が読める文言）
      byCondition: null        // {条件名: {currency, value}} 全コンディションの内訳
    };

    this.content = {
      photos: [],
      title: null,          // Listing Generator が生成する出品タイトル
      description: null,    // Listing Generator が生成する出品説明文
      listingWarnings: [],  // 生成時に気づいた注意点（空タイトル・通貨未換算など）
      tags: [],
      channelSummary: null,  // Channel Router が生成する「どの販路にOK/NGか」の要約文
      channelEligibility: [] // Channel Router の詳細結果（{channel, mode, eligible, reason}の配列）
    };
    
    this.approval = {
      status: 'pending',  // pending, approved, rejected
      confirmedByUser: false,
      userModifications: null,
      approvalTime: null
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1: Identifier Layer
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Vision API：OCR テキスト抽出のみ
 */
function extractTextWithVisionAPI(blob) {
  const base64Image = Utilities.base64Encode(blob.getBytes());
  
  const payload = {
    'requests': [{
      'image': { 'content': base64Image },
      'features': [{ 'type': 'TEXT_DETECTION' }]
    }]
  };
  
  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };
  
  const url = 'https://vision.googleapis.com/v1/images:annotate?key=' + CONFIG.VISION_API_KEY;
  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());
  
  if (result.responses?.[0]?.textAnnotations) {
    return {
      success: true,
      rawText: result.responses[0].textAnnotations[0].description,
      confidence: 0.85
    };
  }
  
  return { success: false, rawText: '' };
}

/**
 * Barcode Scanner：Google ML Kit Barcode Scanning
 * GAS では Cloud Vision Barcode Detection を代替使用
 */
function scanBarcodeWithMLKit(blob) {
  const base64Image = Utilities.base64Encode(blob.getBytes());
  
  const payload = {
    'requests': [{
      'image': { 'content': base64Image },
      'features': [{ 'type': 'BARCODE_DETECTION' }]
    }]
  };
  
  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };
  
  const url = 'https://vision.googleapis.com/v1/images:annotate?key=' + CONFIG.VISION_API_KEY;
  const response = UrlFetchApp.fetch(url, options);
  const result = JSON.parse(response.getContentText());
  
  const barcodes = [];
  
  if (result.responses?.[0]?.barcodeAnnotations) {
    result.responses[0].barcodeAnnotations.forEach(barcode => {
      barcodes.push({
        rawValue: barcode.rawValue,
        format: barcode.format  // 'EAN_13', 'CODE_39', 'QR_CODE'
      });
    });
  }
  
  return { success: barcodes.length > 0, barcodes: barcodes };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2: Category Router
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function detectCategoryFromBarcode(barcode, format) {
  if (!barcode) return null;
  
  const prefix = barcode.substring(0, 2);
  const third = barcode.charAt(2);
  
  // ISBN-13: 978-0 or 979-0
  if (prefix === '97' && (third === '8' || third === '9')) {
    return 'BOOK';
  }
  
  // JAN: 45 = 本 or 451-453 = CD
  if (prefix === '45') {
    if (third === '0' || third === '1') return 'BOOK';
    if (third >= '1' && third <= '3') return 'MUSIC';
  }
  
  return null;
}

function detectCategoryFromText(text) {
  if (!text) return null;
  
  const lower = text.toLowerCase();
  
  const patterns = {
    MUSIC: ['vinyl', 'lp', 'cd', 'discogs', 'artist', 'album'],
    BOOK: ['isbn', '著者', '出版', 'author', 'publisher'],
    GAME: ['playstation', 'xbox', 'nintendo', 'switch', 'ps5'],
    GEAR: ['amplifier', 'mixer', 'microphone', 'reverb', 'pedal'],
    CAMERA: ['canon', 'nikon', 'sony', 'fujifilm', 'lens', 'dslr']
  };
  
  for (const [category, keywords] of Object.entries(patterns)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return category;
    }
  }

  return null;
}

/**
 * MUSIC専用：OCRテキストから「CD」「Vinyl(レコード/LP)」「Cassette(カセット)」の
 * どれっぽいかヒントを拾う。あくまで補助シグナルで、確定判定はDiscogsマッチの
 * formatフィールドを正とする（このヒントはそれとの食い違いチェック専用）
 */
function detectMusicFormatHint_(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  const hints = {
    Cassette: ['cassette', 'カセット', 'compact cassette', 'stereo cassette'],
    Vinyl: ['vinyl', ' lp ', '33 1/3', '33⅓', '45 rpm', 'レコード', 'アナログ盤', 'analog disc'],
    CD: ['compact disc', ' cd ', 'digital audio']
  };

  for (const [format, keywords] of Object.entries(hints)) {
    if (keywords.some(kw => lower.includes(kw))) {
      return format;
    }
  }
  return null;
}

function routeCategory(barcodeResult, ocrResult) {
  if (barcodeResult?.success && barcodeResult.barcodes.length > 0) {
    const barcode = barcodeResult.barcodes[0];
    const cat = detectCategoryFromBarcode(barcode.rawValue, barcode.format);
    if (cat) return { category: cat, source: 'barcode', confidence: 0.95 };
  }
  
  if (ocrResult?.success) {
    const cat = detectCategoryFromText(ocrResult.rawText);
    if (cat) return { category: cat, source: 'ocr', confidence: 0.70 };
  }
  
  return { category: 'UNKNOWN', source: 'none', confidence: 0 };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 3: Resolver
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function resolveProduct(category, ocrText, barcodeData, sourceImage) {
  const record = new CanonicalProductRecord();
  record.metadata.sourceImageId = sourceImage;
  
  if (barcodeData) {
    record.identifiers.barcode = barcodeData.rawValue;
    record.identifiers.barcodeType = barcodeData.format;
  }
  record.identifiers.ocrText = [ocrText];
  record.product.category = category;
  
  let dbMatch = null;
  
  switch(category) {
    case 'MUSIC':
      dbMatch = resolveDiscogs(ocrText);
      break;
    case 'BOOK':
      dbMatch = resolveGoogleBooks(ocrText, barcodeData?.rawValue);
      break;
    case 'GAME':
      dbMatch = resolveIGDB_TODO(ocrText);
      break;
    case 'GEAR':
      dbMatch = resolveReverb(ocrText);
      break;
    case 'CAMERA':
      dbMatch = resolveCamera(ocrText);
      break;
    default:
      dbMatch = null;
  }
  
  if (!dbMatch) {
    record.approval.status = 'rejected';
    record.metadata.confidenceScore = 0;
    return record;
  }
  
  // Canonical Record に統一
  record.database.source = dbMatch.source;
  record.database.dbId = dbMatch.dbId;
  record.database.dbMatch = {
    title: dbMatch.title,
    url: dbMatch.url,
    confidence: dbMatch.confidence
  };
  
  record.product.brand = dbMatch.brand;
  record.product.maker = dbMatch.maker;
  record.product.productName = dbMatch.productName;
  record.product.modelName = dbMatch.modelName;
  record.product.year = dbMatch.year;
  record.product.format = dbMatch.format;
  record.product.condition = 'Used';

  // MUSIC限定：OCRテキストから拾えるフォーマットのヒント(CD/Vinyl/Cassette等の
  // 表記)とDB側のformatが食い違う場合は要注意フラグを立てる。
  // 【限界】盤面や帯にCD/LP/カセット等の表記が無ければヒント自体が取れないため
  // 「一致した」ではなく「食い違いが検出されなかった」程度の弱いチェックです
  if (category === 'MUSIC') {
    const hint = detectMusicFormatHint_(ocrText);
    if (hint && dbMatch.format && !dbMatch.format.toLowerCase().includes(hint.toLowerCase())) {
      record.product.formatConfidenceNote =
        'OCRからは「' + hint + '」の表記が見えたが、DB側のフォーマットは「' + dbMatch.format +
        '」で一致しない可能性あり（別プレス/別フォーマットの誤マッチの疑い、目視確認推奨）';
    }
  }
  
  record.pricing.estimatedPrice = dbMatch.estimatedPrice;
  record.pricing.priceConfidence = dbMatch.priceConfidence;
  
  record.metadata.confidenceScore = dbMatch.confidence;
  
  return record;
}

/**
 * Discogs Resolver（MUSIC）
 *
 * 【価格について】estimatedPrice / priceConfidence はここでは仮の値です。
 * price-engine.gs の attachPriceSuggestions_() が、実際の Discogs
 * price_suggestions（実売相場）で record.pricing を上書きします。
 * ここに固定値を書いているのは「価格取得が丸ごと失敗した場合でも
 * record 自体は壊れない」ようにするための最低限のフォールバックです。
 */
function resolveDiscogs(ocrText) {
  const parts = ocrText.split('\n').filter(x => x.trim());
  if (parts.length < 2) return null;

  const query = `${parts[0]} ${parts[1]}`;
  // 【バグ修正 2026-08-14】旧コードは &format=CD を検索クエリに固定しており、
  // Discogs検索結果がCDしか返らない状態だった（実機検証：format指定を外すと
  // 同じ検索でVinyl盤が返ることを確認）。CD/カセット/レコードを自動判別したい
  // という要望に反するバグだったため、format指定を削除して全フォーマットを
  // 検索対象にする。実際の形式は下のmatch.basic_information.formats[0].nameで
  // Discogsのレスポンスから取得する（元々そのためのコードがあった）
  const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(query)}&type=release&token=${CONFIG.DISCOGS_TOKEN}`;

  try {
    discogsRateLimit_();   // price-engine.gs 側と共有のレート制御（1秒1リクエスト厳守）

    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'User-Agent': 'Reuse-Intake-AI/1.0' },
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());
    if (!result.results?.[0]) return null;

    const match = result.results[0];
    return {
      source: 'discogs',
      dbId: match.id,
      title: match.title,
      url: match.uri,
      brand: match.basic_information?.artists?.[0]?.name,
      maker: null,
      productName: match.title,
      modelName: match.basic_information?.catalog_number,
      year: match.basic_information?.year,
      format: match.basic_information?.formats?.[0]?.name || 'CD',
      // 価格未取得時のプレースホルダー（price-engine.gs が実データで上書きする）
      estimatedPrice: null,
      priceConfidence: 0,
      priceSource: 'placeholder',
      confidence: 85
    };
  } catch (e) {
    Logger.log('Discogs error: ' + e);
    return null;
  }
}

/**
 * Google Books Resolver（BOOK）
 */
function resolveGoogleBooks(ocrText, isbn) {
  let url;
  if (isbn && isbn.startsWith('97')) {
    url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&key=${CONFIG.GOOGLE_API_KEY}`;
  } else {
    const parts = ocrText.split('\n').filter(x => x.trim());
    url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(parts[0])}&key=${CONFIG.GOOGLE_API_KEY}`;
  }
  
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const result = JSON.parse(response.getContentText());
    if (!result.items?.[0]) return null;
    
    const book = result.items[0].volumeInfo;
    return {
      source: 'googlebooks',
      dbId: result.items[0].id,
      title: book.title,
      url: book.infoLink,
      brand: null,
      maker: book.publisher,
      productName: book.title,
      modelName: isbn,
      year: parseInt(book.publishedDate?.substring(0, 4)),
      format: 'Book',
      estimatedPrice: 1000,
      priceConfidence: 30,
      confidence: 80
    };
  } catch (e) {
    Logger.log('Google Books error: ' + e);
    return null;
  }
}

/**
 * ⚠️ IGDB Resolver（GAME）
 * TODO: 商用利用条件を確認してから実装してください
 * https://www.igdb.com/api
 */
function resolveIGDB_TODO(ocrText) {
  Logger.log('⚠️ TODO: IGDB 商用条件を確認。現在未実装');
  return null;
}

/**
 * Reverb Resolver（GEAR）
 */
function resolveReverb(ocrText) {
  const brand = extractBrand(ocrText);
  return {
    source: 'reverb_fallback',
    dbId: null,
    title: ocrText.substring(0, 100),
    url: null,
    brand: brand,
    maker: null,
    productName: ocrText,
    modelName: null,
    year: null,
    format: 'Instrument',
    estimatedPrice: 8000,
    priceConfidence: 20,
    confidence: 50
  };
}

/**
 * Camera Resolver（CAMERA）
 * 型番 OCR + eBay 相場（Phase 1で統合）
 */
function resolveCamera(ocrText) {
  const brand = extractCameraBrand(ocrText);
  const model = extractCameraModel(ocrText);
  
  return {
    source: 'camera_fallback',
    dbId: null,
    title: `${brand} ${model}`.trim(),
    url: null,
    brand: brand,
    maker: brand,
    productName: `${brand} ${model}`.trim(),
    modelName: model,
    year: extractCameraYear(ocrText),
    format: 'Camera',
    estimatedPrice: 15000,
    priceConfidence: 25,
    confidence: 60
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helper Functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function extractBrand(text) {
  const brands = ['Fender', 'Gibson', 'Marshall', 'Roland', 'Yamaha'];
  const upper = text.toUpperCase();
  for (const b of brands) {
    if (upper.includes(b.toUpperCase())) return b;
  }
  return null;
}

function extractCameraBrand(text) {
  const upper = text.toUpperCase();
  if (upper.includes('CANON')) return 'Canon';
  if (upper.includes('NIKON')) return 'Nikon';
  if (upper.includes('SONY')) return 'Sony';
  if (upper.includes('FUJI')) return 'Fujifilm';
  return null;
}

function extractCameraModel(text) {
  const match = text.match(/[A-Z]+[0-9]+/);
  return match ? match[0] : null;
}

function extractCameraYear(text) {
  const match = text.match(/(?:19|20)\d{2}/);
  return match ? parseInt(match[0]) : null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 4: Sheet Record & Approval
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function recordProductToSheet(record) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName('pending_approval');
  
  if (!sheet) {
    sheet = ss.insertSheet('pending_approval');
    const headers = [
      'Status', 'Category', 'Brand', 'Product', 'Model', 'Barcode',
      'Year', 'Format', 'DB ID', 'Confidence %', 'Est. Price ¥',
      'User OK?', 'User Notes', 'Created'
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  
  const row = [
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
    '',  // User OK?
    '',  // Notes
    new Date().toISOString()
  ];
  
  sheet.appendRow(row);
}

/**
 * CSV エクスポート（Phase 0 の最終アウトプット）
 */
function exportToCSV() {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet = ss.getSheetByName('pending_approval');
  const data = sheet.getDataRange().getValues();
  
  // User OK? が TRUE の行のみ
  const approved = data.filter((row, idx) => idx > 0 && row[11] === true);
  
  if (approved.length === 0) {
    Logger.log('No approved records');
    return;
  }
  
  const csv = approved.map(row =>
    row.map(cell => {
      const s = String(cell);
      return s.includes(',') ? `"${s}"` : s;
    }).join(',')
  ).join('\n');
  
  const file = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID)
    .createFile('products-' + new Date().toISOString().split('T')[0] + '.csv', csv);
  
  Logger.log('CSV exported: ' + file.getUrl());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Phase 0 ここまで
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * テスト
 */
function testIdentificationFlow() {
  const testRecord = new CanonicalProductRecord();
  testRecord.product.category = 'MUSIC';
  testRecord.product.brand = 'King Crimson';
  testRecord.product.productName = 'In the Court of the Crimson King';
  testRecord.product.year = 1969;
  testRecord.metadata.confidenceScore = 87;
  
  recordProductToSheet(testRecord);
  Logger.log('✅ Test record saved to Sheet');
}
