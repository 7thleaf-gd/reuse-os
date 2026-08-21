/**
 * Web Router（ウェブアプリの唯一の入口）
 *
 * 【役割】GASプロジェクトに doGet() は1つしか置けないため、
 * 画面の振り分けをここに集約する。各画面はページ名で切り替える。
 *
 *   ?page=setup    セットアップ画面（APIキー等の設定）
 *   ?page=phase1   Phase 1 試走ゲート（read-only preflight）
 *   ?page=listing  出品ヘルパー（手動販路のコピペ支援）
 *   （省略時）      ホーム
 *
 * 【設置と公開手順】
 * 1. clasp push
 * 2. Apps Scriptエディタ右上「デプロイ」→「新しいデプロイ」
 * 3. 種類「ウェブアプリ」
 * 4. 「次のユーザーとして実行」＝自分
 *    「アクセスできるユーザー」＝自分のみ
 * 5. 発行されたURLをスマホのホーム画面に追加しておくと便利
 *
 * ⚠️ アクセス権を「全員」にしないでください。在庫情報と設定画面が公開されます。
 */

const PAGES = {
  home:    { file: 'home-ui',            title: 'REUSE OS' },
  setup:   { file: 'setup-ui',           title: 'REUSE — セットアップ' },
  phase1:  { file: 'phase1-ui',          title: 'REUSE — Phase 1 試走ゲート' },
  listing: { file: 'manual-listing-ui',  title: 'REUSE — 出品ヘルパー' }
};

function doGet(e) {
  const params = (e && e.parameter) || {};

  // eBayの認証から戻ってきた場合。
  // eBayは RuName に登録した「Auth Accepted URL」へ ?code=...&state=... を付けて返す。
  // page パラメータは付かないので、code の有無で判定する。
  if (params.code && params.state) {
    const result = exchangeEbayCode_(params.code, params.state);
    return HtmlService.createHtmlOutput(buildCallbackHtml_(result))
      .setTitle('REUSE — eBay接続')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  const key = params.page || 'home';
  const page = PAGES[key] || PAGES.home;

  return HtmlService.createTemplateFromFile(page.file)
    .evaluate()
    .setTitle(page.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 認証から戻ってきたときに出す結果画面 */
function buildCallbackHtml_(result) {
  const url = getWebAppUrl();
  const color = result.ok ? '#3f7d5a' : '#a8452f';
  const icon = result.ok ? '✓' : '✗';
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><base target="_top">' +
    '<style>body{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#faf8f5;color:#211f1c;' +
    'margin:0;padding:40px 20px;line-height:1.7}.box{max-width:520px;margin:0 auto;background:#fff;' +
    'border:1px solid #e6e1d9;border-radius:12px;padding:26px}h1{font-size:19px;margin:0 0 10px;color:' + color + '}' +
    'a{display:inline-block;margin-top:18px;padding:9px 18px;background:#2f6f6a;color:#fff;' +
    'text-decoration:none;border-radius:8px;font-weight:650;font-size:14px}</style></head><body>' +
    '<div class="box"><h1>' + icon + ' ' + (result.ok ? '接続しました' : '接続できませんでした') + '</h1>' +
    '<p>' + String(result.note || '').replace(/</g, '&lt;') + '</p>' +
    '<a href="' + url + '?page=setup">セットアップ画面へ戻る</a></div></body></html>';
}

/** HTMLファイルから <?!= include('ui-styles') ?> で共通パーツを差し込む */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 画面間のリンクに使うウェブアプリのURL。
 * GASのウェブアプリはiframe内で動くため、リンクには target="_top" が必要。
 */
function getWebAppUrl() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}
