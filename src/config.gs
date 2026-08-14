/**
 * Config（最初に読み込まれるファイル）
 *
 * 【役割】APIキー等の秘密情報を、ソースコードから完全に分離する。
 *
 * 【なぜこうしたか】
 * 以前は phase0-implementation.gs の中に
 *   const CONFIG = { VISION_API_KEY: 'AIza...', DISCOGS_TOKEN: '...' }
 * と直接書いていた。これだと、
 *   - gitにコミットした瞬間に履歴へ永久に残る（後から消してもhistoryに残る）
 *   - GitHubのpublicリポジトリに上げたらキーが即座に公開される
 *   - スクリーンショットを共有するたびに漏洩リスクがある
 * という問題があった。
 *
 * このファイルでは値を一切持たず、Apps Scriptの
 * 「スクリプトプロパティ」（プロジェクトの設定画面で管理される、
 * ソースコードとは別の保管場所）から実行時に読み出す。
 * よってソースコードをそのまま公開しても秘密情報は漏れない。
 *
 * 【設定方法（どちらか片方でOK）】
 *
 * ■ 方法A：Apps Scriptの画面から手で入れる（推奨・コードに一切残らない）
 *   1. Apps Scriptエディタ左の「⚙ プロジェクトの設定」を開く
 *   2. 一番下の「スクリプト プロパティ」→「スクリプト プロパティを追加」
 *   3. 下の PROPERTY_KEYS にあるキー名と値を入れて保存
 *
 * ■ 方法B：setup-secrets.gs を使う（まとめて入れたい場合）
 *   setup-secrets.example.gs をコピーして setup-secrets.gs を作り、
 *   値を書いて1回だけ実行する。このファイルは .gitignore 済みなので
 *   コミットされない。実行後はファイルごと削除して構わない。
 *
 * 設定できているかは checkConfig() を実行すれば確認できる（値は伏せて表示される）。
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 扱うキーの一覧
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PROPERTY_KEYS = {
  // ── 必須（これが無いと基本機能が動かない）
  REQUIRED: [
    'VISION_API_KEY',      // Google Cloud の APIキー（Vision API用）
    'GOOGLE_API_KEY',      // 同上（Google Books API用。同じキーで可）
    'DISCOGS_TOKEN',       // Discogs 開発者トークン
    'SHEET_ID',            // 作業用スプレッドシートのID
    'DRIVE_FOLDER_ID'      // 撮影画像を置くDriveフォルダのID
  ],

  // ── 販路連携（該当する販路を使うときだけ必要）
  CHANNEL: [
    'EBAY_OAUTH_TOKEN',
    'ETSY_API_KEY',
    'ETSY_OAUTH_TOKEN',
    'ETSY_SHOP_ID',
    'MERCARI_SHOPS_ACCESS_TOKEN',
    'MERCARI_SHOPS_CLIENT_NAME',
    'YAHOO_SHOPPING_ACCESS_TOKEN',
    'YAHOO_SHOPPING_SELLER_ID'
  ]
};

/** 秘密情報ではない既定値。ここに書いてよいのは公開されても困らないものだけ */
const CONFIG_DEFAULTS = {
  HOURLY_RATE: 1500   // ROI計算に使う時給（円）
};

/**
 * 「値そのものを画面やログに出してはいけないキー」の一覧。
 * checkConfig() などで必ずマスクする。
 */
const SECRET_KEYS = [
  'VISION_API_KEY', 'GOOGLE_API_KEY', 'DISCOGS_TOKEN',
  'EBAY_OAUTH_TOKEN', 'ETSY_API_KEY', 'ETSY_OAUTH_TOKEN',
  'MERCARI_SHOPS_ACCESS_TOKEN', 'YAHOO_SHOPPING_ACCESS_TOKEN'
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONFIG 本体
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * CONFIG.VISION_API_KEY のような従来通りの書き方のまま、
 * 実際にはスクリプトプロパティから読む。
 *
 * 【実装メモ】
 * PropertiesService はスクリプト実行のたびにネットワーク越しの読み出しが発生し、
 * 1日あたりの読み出し回数にも上限がある。1商品ごとに何度も参照する箇所があるため、
 * 実行ごとに1回だけ読んでメモリ上に持つ（キャッシュする）。
 * 途中でプロパティを書き換えた場合は refreshConfig() を呼ぶこと。
 */
const CONFIG = (function () {
  let cache = null;

  function load_() {
    if (cache) return cache;
    let stored = {};
    try {
      stored = PropertiesService.getScriptProperties().getProperties() || {};
    } catch (e) {
      // テスト環境などPropertiesServiceが無い場合でも落とさない
      stored = {};
    }
    cache = {};
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) { cache[k] = CONFIG_DEFAULTS[k]; });
    PROPERTY_KEYS.REQUIRED.concat(PROPERTY_KEYS.CHANNEL).forEach(function (k) {
      cache[k] = stored[k] || '';
    });
    // 既定値も、プロパティ側に同名があればそちらを優先する
    Object.keys(stored).forEach(function (k) {
      if (cache[k] === undefined || cache[k] === '') cache[k] = stored[k];
    });
    return cache;
  }

  const obj = {};

  PROPERTY_KEYS.REQUIRED.concat(PROPERTY_KEYS.CHANNEL).concat(Object.keys(CONFIG_DEFAULTS))
    .forEach(function (key) {
      Object.defineProperty(obj, key, {
        enumerable: true,
        get: function () { return load_()[key]; },
        // setterは「この実行の間だけ一時的に上書きする」用途（テスト・検証用）。
        // スクリプトプロパティ自体は書き換えないので、実行が終われば元に戻る。
        set: function (v) { load_()[key] = v; }
      });
    });

  // キャッシュを捨てて次回アクセス時に読み直す
  obj.__refresh = function () { cache = null; };

  return obj;
})();

/** プロパティを更新した後に呼ぶと、CONFIGが読み直される */
function refreshConfig() {
  CONFIG.__refresh();
  return '再読み込みしました';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 診断
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 秘密情報を伏せた表示にする（末尾4文字だけ見せる） */
function maskSecret_(key, value) {
  if (!value) return '（未設定）';
  if (SECRET_KEYS.indexOf(key) === -1) return String(value);
  const s = String(value);
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4) + '（' + s.length + '文字）';
}

/**
 * どのキーが設定済みで、どれが未設定かを一覧表示する。
 * 秘密情報は末尾4文字だけ表示するので、実行ログを共有しても漏れない。
 */
function checkConfig() {
  const lines = [];
  let missingRequired = 0;

  lines.push('── 必須 ──');
  PROPERTY_KEYS.REQUIRED.forEach(function (k) {
    const v = CONFIG[k];
    if (!v) missingRequired++;
    lines.push('  ' + (v ? '✅' : '❌') + ' ' + k + ': ' + maskSecret_(k, v));
  });

  lines.push('── 販路連携（使う販路の分だけあればOK）──');
  PROPERTY_KEYS.CHANNEL.forEach(function (k) {
    const v = CONFIG[k];
    lines.push('  ' + (v ? '✅' : '・') + ' ' + k + ': ' + maskSecret_(k, v));
  });

  lines.push('── その他 ──');
  Object.keys(CONFIG_DEFAULTS).forEach(function (k) {
    lines.push('  ' + k + ': ' + CONFIG[k]);
  });

  lines.push('');
  if (missingRequired > 0) {
    lines.push('⚠️ 必須キーが ' + missingRequired + ' 件未設定です。');
    lines.push('   「⚙ プロジェクトの設定」→「スクリプト プロパティ」から追加してください。');
  } else {
    lines.push('✅ 必須キーは全て設定済みです。');
  }

  // 各販路が接続可能かもここで見えるようにする
  if (typeof CHANNEL_ADAPTERS !== 'undefined') {
    lines.push('');
    lines.push('── 販路の接続状態 ──');
    Object.keys(CHANNEL_ADAPTERS).forEach(function (ch) {
      const a = CHANNEL_ADAPTERS[ch];
      if (a.mode !== 'api') {
        lines.push('  ・ ' + a.label + ': 手動対応のみ（API接続の概念なし）');
        return;
      }
      const cfg = a.isConfigured();
      lines.push('  ' + (cfg.ok ? '✅' : '・') + ' ' + a.label + ': ' + (cfg.ok ? '接続可' : cfg.reason));
    });
  }

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

/**
 * 必須キーが揃っていなければ例外を投げる。
 * 実際にAPIを叩く処理の入口で呼ぶと、途中まで進んでから
 * 意味不明なエラーで落ちるのを防げる。
 */
function assertRequiredConfig_() {
  const missing = PROPERTY_KEYS.REQUIRED.filter(function (k) { return !CONFIG[k]; });
  if (missing.length) {
    throw new Error(
      '必須の設定が未登録です: ' + missing.join(', ') +
      '\n「⚙ プロジェクトの設定」→「スクリプト プロパティ」から追加するか、' +
      'setup-secrets.gs を使って登録してください。checkConfig() で状態を確認できます。'
    );
  }
}
