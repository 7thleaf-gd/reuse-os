/** Web Router（ウェブアプリの唯一の入口） */
const PAGES = {
  home:      { file: 'home-ui',            title: 'REUSE OS' },
  inventory: { file: 'inventory-ui',       title: 'REUSE — 在庫' },
  setup:     { file: 'setup-ui',           title: 'REUSE — セットアップ' },
  listing:   { file: 'manual-listing-ui',  title: 'REUSE — 出品ヘルパー' }
};

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.code && params.state) {
    const result = exchangeEbayCode_(params.code, params.state);
    return HtmlService.createHtmlOutput(buildCallbackHtml_(result))
      .setTitle('REUSE — eBay接続')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  const key = params.page || 'home';
  const page = PAGES[key] || PAGES.home;
  return HtmlService.createTemplateFromFile(page.file)
    .evaluate().setTitle(page.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buildCallbackHtml_(result) {
  const url = getWebAppUrl();
  const color = result.ok ? '#3f7d5a' : '#a8452f';
  const icon = result.ok ? '✓' : '✗';
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><base target="_top">' +
    '<style>body{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#faf8f5;color:#211f1c;margin:0;padding:40px 20px;line-height:1.7}.box{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e6e1d9;border-radius:12px;padding:26px}h1{font-size:19px;margin:0 0 10px;color:' + color + '}a{display:inline-block;margin-top:18px;padding:9px 18px;background:#2f6f6a;color:#fff;text-decoration:none;border-radius:8px;font-weight:650;font-size:14px}</style></head><body>' +
    '<div class="box"><h1>' + icon + ' ' + (result.ok ? '接続しました' : '接続できませんでした') + '</h1>' +
    '<p>' + String(result.note || '').replace(/</g, '&lt;') + '</p>' +
    '<a href="' + url + '?page=setup">セットアップ画面へ戻る</a></div></body></html>';
}

function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }
function getWebAppUrl() { try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; } }
