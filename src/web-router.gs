/**
 * Web Router（ウェブアプリの唯一の入口）
 *
 * 【役割】GASプロジェクトに doGet() は1つしか置けないため、
 * 画面の振り分けをここに集約する。各画面はページ名で切り替える。
 *
 *   ?page=setup    セットアップ画面（APIキー等の設定）
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
  listing: { file: 'manual-listing-ui',  title: 'REUSE — 出品ヘルパー' }
};

function doGet(e) {
  const key = (e && e.parameter && e.parameter.page) || 'home';
  const page = PAGES[key] || PAGES.home;

  return HtmlService.createTemplateFromFile(page.file)
    .evaluate()
    .setTitle(page.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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
