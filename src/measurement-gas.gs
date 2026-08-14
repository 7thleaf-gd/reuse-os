/**
 * Phase 0 計測データ自動記録スクリプト
 * Google Sheets にコピペして使用
 * 
 * 使い方：
 * 1. Google Sheet を作成
 * 2. このコードを Apps Script にコピペ
 * 3. デプロイして使用
 * 4. ダッシュボードから「データ同期」ボタンで自動更新
 */

// スプレッドシート ID（設定済み：書き換え不要）
const SHEET_ID = '__REDACTED_SHEET_ID__';
const SHEET_NAME = 'Phase0計測データ';

/**
 * 初期化：Sheets にデータ構造を作成
 */
function initializeSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  
  // ヘッダー行を作成
  const headers = [
    '日時',
    '従来登録時間(h)',
    'OS使用時間(h)',
    '自動特定成功数',
    '総数',
    '人間修正数',
    'eBay出品完了数',
    '削減時間(h)',
    '月間削減額(¥)',
    'ROI(%)',
    '成功率(%)',
    '修正率(%)',
    '出品完了率(%)'
  ];
  
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold');
}

/**
 * 計測データを記録
 * 
 * @param {Object} metrics - 計測データオブジェクト
 *   {
 *     traditionalTime: 10,      // 従来登録時間（時間）
 *     osTime: 2.5,              // OS使用時間（時間）
 *     successCount: 261,         // 自動特定成功数
 *     totalCount: 300,           // 総数
 *     correctionCount: 39,       // 人間修正数
 *     completionCount: 294       // eBay出品完了数
 *   }
 */
function recordMetrics(metrics) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  
  if (!sheet) {
    initializeSheet();
  }
  
  // 計算値
  const timeSaved = metrics.traditionalTime - metrics.osTime;
  const monthlySavings = Math.round(timeSaved * 4.3 * 1500); // 月間削減額 (¥1,500/h)
  const roi = Math.round((monthlySavings / 9800) * 100); // ROI (¥9,800/月)
  const successRate = ((metrics.successCount / metrics.totalCount) * 100).toFixed(1);
  const correctionRate = ((metrics.correctionCount / metrics.totalCount) * 100).toFixed(1);
  const completionRate = ((metrics.completionCount / metrics.totalCount) * 100).toFixed(1);
  
  // 新規行に追加
  const lastRow = sheet.getLastRow();
  const newRow = lastRow + 1;
  
  const values = [
    new Date().toLocaleString('ja-JP'),
    metrics.traditionalTime,
    metrics.osTime,
    metrics.successCount,
    metrics.totalCount,
    metrics.correctionCount,
    metrics.completionCount,
    timeSaved,
    monthlySavings,
    roi,
    successRate,
    correctionRate,
    completionRate
  ];
  
  sheet.getRange(newRow, 1, 1, values.length).setValues([values]);
  
  // 背景色を交互に
  const bgColor = newRow % 2 === 0 ? '#0f172a' : '#1e293b';
  sheet.getRange(newRow, 1, 1, values.length).setBackground(bgColor).setFontColor('#e2e8f0');
  
  Logger.log('計測データを記録しました: ' + new Date());
  return {
    success: true,
    row: newRow,
    timeSaved: timeSaved,
    monthlySavings: monthlySavings,
    roi: roi
  };
}

/**
 * Sheets のデータから JSON で最新値を返す
 */
function getLatestMetrics() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  
  // 最後の行を取得
  const lastRow = data[data.length - 1];
  
  return {
    date: lastRow[0],
    traditionalTime: lastRow[1],
    osTime: lastRow[2],
    successCount: lastRow[3],
    totalCount: lastRow[4],
    correctionCount: lastRow[5],
    completionCount: lastRow[6],
    timeSaved: lastRow[7],
    monthlySavings: lastRow[8],
    roi: lastRow[9],
    successRate: lastRow[10],
    correctionRate: lastRow[11],
    completionRate: lastRow[12]
  };
}

/**
 * ダッシュボードから呼び出す API
 * これを外部に公開する場合は deployAsAPI()
 */
function doPost(e) {
  const params = JSON.parse(e.postData.contents);
  
  if (params.action === 'record') {
    return ContentService.createTextOutput(
      JSON.stringify(recordMetrics(params.metrics))
    ).setMimeType(ContentService.MimeType.JSON);
  }
  
  if (params.action === 'getLatest') {
    return ContentService.createTextOutput(
      JSON.stringify(getLatestMetrics())
    ).setMimeType(ContentService.MimeType.JSON);
  }
  
  return ContentService.createTextOutput(
    JSON.stringify({ error: 'Unknown action' })
  ).setMimeType(ContentService.MimeType.JSON);
}

/**
 * テスト用：ダミーデータを記録
 */
function testRecord() {
  const testMetrics = {
    traditionalTime: 10,
    osTime: 2.5,
    successCount: 261,
    totalCount: 300,
    correctionCount: 39,
    completionCount: 294
  };
  
  const result = recordMetrics(testMetrics);
  Logger.log('テスト記録完了:');
  Logger.log(JSON.stringify(result, null, 2));
}

/**
 * 自動計測ログの例
 * 実際の Vision API / eBay API 呼び出し時に このような形で呼ぶ
 */
function onImageUploadedToGDrive() {
  // これは Drive API の Trigger で自動実行される
  // 実装例：
  // 1. Drive に新規ファイルがアップロードされた
  // 2. Vision API で OCR 実行（成功数をカウント）
  // 3. Discogs API で照合（修正必要数をカウント）
  // 4. eBay API で出品（完了数をカウント）
  // 5. recordMetrics() を呼び出し
}

/**
 * 月次レポート自動生成
 * 毎月末に実行
 */
function generateMonthlyReport() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  
  // 最新の計測結果を取得
  const latest = data[data.length - 1];
  
  // メール送信（オプション）
  const recipientEmail = 'your-email@example.com';
  const subject = `Phase 0 計測レポート - ${new Date().toLocaleDateString('ja-JP')}`;
  const message = `
計測完了レポート

【削減効果】
- 削減時間: ${latest[7]}時間（300枚）
- 月間削減額: ¥${latest[8].toLocaleString()}
- 初月ROI: ${latest[9]}%

【精度指標】
- 自動特定成功率: ${latest[10]}%
- 人間修正率: ${latest[11]}%
- 出品完了率: ${latest[12]}%

営業資料は以下を参照：
https://your-dashboard-url.com

Phase 0 計測担当者より
  `;
  
  // GmailApp.sendEmail(recipientEmail, subject, message);
  Logger.log('月次レポート生成完了');
}

/**
 * 定期実行の設定（必須：Apps Script の Trigger で設定してください）
 * 設定方法：
 * 1. Apps Script 画面の「トリガー」メニューを開く
 * 2. 「新規トリガーを作成」
 * 3. 関数: generateMonthlyReport
 * 4. 実行方法: 月単位
 * 5. 日時: 月末 23:00
 */
