/**
 * ⚠️ このファイルは「テンプレート」です。そのままでは使いません。
 *
 * 【使い方】
 * 1. このファイルをコピーして  setup-secrets.gs  という名前で保存する
 *    （.example が付かない名前。.gitignore 済みなのでコミットされません）
 * 2. 下の値を自分のものに書き換える
 * 3. Apps Scriptエディタで saveSecrets() を1回だけ実行する
 * 4. 実行が終わったら、setup-secrets.gs は削除して構いません
 *    （値はスクリプトプロパティ側に保存済みのため）
 *
 * 【なぜこの手順か】
 * 値をソースコードに置いたままにすると、gitの履歴やスクリーンショット経由で
 * 漏れます。ここで一度プロパティに移してしまえば、以降コードに秘密情報は
 * 一切登場しません。
 *
 * 【もっと安全な方法】
 * このファイルを使わず、Apps Scriptの
 * 「⚙ プロジェクトの設定」→「スクリプト プロパティ」から手で入力すれば、
 * 秘密情報がコードに一瞬たりとも載りません。そちらの方が確実です。
 */

function saveSecrets() {
  const values = {
    // ── 必須 ──────────────────────────────
    VISION_API_KEY: '',        // Google Cloud の APIキー
    GOOGLE_API_KEY: '',        // 同上（Google Books用。同じキーで可）
    DISCOGS_TOKEN: '',         // Discogs 開発者トークン
    SHEET_ID: '',              // 作業用スプレッドシートのID
    DRIVE_FOLDER_ID: '',       // 撮影画像を置くDriveフォルダのID

    // ── 販路連携（使う販路の分だけ入れればOK。空のままで構いません）──
    EBAY_OAUTH_TOKEN: '',
    ETSY_API_KEY: '',
    ETSY_OAUTH_TOKEN: '',
    ETSY_SHOP_ID: '',
    MERCARI_SHOPS_ACCESS_TOKEN: '',
    MERCARI_SHOPS_CLIENT_NAME: '',
    YAHOO_SHOPPING_ACCESS_TOKEN: '',
    YAHOO_SHOPPING_SELLER_ID: ''
  };

  // 空の項目は保存しない（既に入っている値を空で上書きしてしまわないため）
  const toSave = {};
  Object.keys(values).forEach(function (k) {
    if (values[k] && String(values[k]).trim() !== '') toSave[k] = String(values[k]).trim();
  });

  if (Object.keys(toSave).length === 0) {
    Logger.log('⚠️ 保存する値がありません。上の values に値を書いてから実行してください。');
    return;
  }

  PropertiesService.getScriptProperties().setProperties(toSave, false);
  refreshConfig();

  Logger.log('✅ ' + Object.keys(toSave).length + ' 件を保存しました: ' + Object.keys(toSave).join(', '));
  Logger.log('（値そのものはここには表示しません）');
  Logger.log('');
  Logger.log('続けて checkConfig() を実行して、設定状況を確認してください。');
  Logger.log('確認できたら、このファイル（setup-secrets.gs）は削除して構いません。');
}

/**
 * 保存済みのプロパティを全部消す（やり直したいとき用）。
 * 実行すると全ての設定が消えるので注意してください。
 */
function deleteAllSecrets_DANGER() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  refreshConfig();
  Logger.log('⚠️ 全てのスクリプトプロパティを削除しました。SKU採番カウンタも消えています。');
}
