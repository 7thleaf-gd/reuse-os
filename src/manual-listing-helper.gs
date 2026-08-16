/**
 * Manual Listing Helper（追加ファイル）
 *
 * 【役割】公式APIが無い／規約で自動化が禁止されている販路
 * （メルカリ個人・ラクマ・ヤフオク個人）向けに、
 * 「出品フォームに貼るだけ」の状態までテキストを用意する。
 *
 * スマホのブラウザで開ける画面として提供するので、
 * 出品作業中に手元で見ながらコピペできる。
 *
 * 【なぜ必要だったか】
 * listing-generator.gs は説明文を生成していたが、
 * Sheetには先頭120文字のプレビューしか書いていなかったため、
 * 実際にはコピペできない状態だった。ここでフルテキストを保存し、
 * コピーボタン付きで出す。
 *
 * 【開き方】ウェブアプリのURLに ?page=listing を付けて開きます。
 * デプロイ手順は web-router.gs のコメントを参照してください。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【文字数制限について（公式ヘルプで確認できた分のみ採用）】
 *
 *  メルカリ   商品名 40文字        ✅公式確認済み
 *             販売価格 ¥300〜¥9,999,999  ✅公式確認済み
 *             商品説明の上限        ❌公式に記載を見つけられず
 *
 *  ラクマ     商品名 65文字        ✅公式確認済み
 *             ※2026年7月の仕様変更で40→65文字に拡大された点に注意
 *             販売価格 300円〜9,999,999円 ✅公式確認済み
 *             商品説明の上限        ❌公式に記載を見つけられず
 *
 *  ヤフオク   タイトル 全角65文字   ✅公式確認済み
 *             商品説明の上限        ❌公式に記載を見つけられず
 *             最低開始価格          ❌公式に記載を見つけられず
 *
 * 【設計判断】説明文は上限が確認できないため、勝手に切り詰めない。
 * 文字数だけ表示して人間に判断してもらう。
 * 「知らないうちに末尾が消えていた」のが一番まずいので。
 *
 * 【ヤフオクの全角換算について】
 * 「全角65文字」とあるが、半角文字を何文字分として数えるかの規則は
 * 公式に明記が無い。ここでは半角ASCIIを0.5文字として計算しているが、
 * これは推定である旨を画面にも表示している。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const MANUAL_CHANNEL_SPEC = {
  MERCARI: {
    label: 'メルカリ',
    titleLimit: 40,
    titleCountMode: 'chars',        // 単純な文字数
    priceMin: 300,
    priceMax: 9999999,
    descLimit: null,               // 公式に記載を確認できず
    verifiedNote: '商品名40文字・価格¥300〜¥9,999,999は公式ヘルプで確認済み。説明文の上限は公式に記載が見つからず'
  },
  RAKUMA: {
    label: 'ラクマ',
    titleLimit: 65,
    titleCountMode: 'chars',
    priceMin: 300,
    priceMax: 9999999,
    descLimit: null,
    verifiedNote: '商品名65文字（2026年7月に40→65へ拡大）・価格300〜9,999,999円は公式確認済み。説明文の上限は記載が見つからず'
  },
  YAHOO_AUCTION: {
    label: 'ヤフオク!',
    titleLimit: 65,
    titleCountMode: 'zenkaku',     // 全角換算（半角0.5文字と仮定＝推定）
    priceMin: null,
    priceMax: null,
    descLimit: null,
    verifiedNote: 'タイトル全角65文字は公式確認済み。ただし半角の換算規則は公式に明記が無く、半角=0.5文字と仮定して計算している（推定）。説明文の上限・最低開始価格も記載が見つからず'
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 生成済みテキストの保存（フル本文）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SHEET_LISTING_COPY = 'listing_copy';
const LISTING_COPY_HEADERS = ['SKU', 'Title', 'Description', 'Warnings', 'Generated At'];

/**
 * registerInventoryItem() から呼ばれ、生成済みの出品文をフルで保存する。
 * pending_approval 側は120文字のプレビューしか持っていないため、
 * コピペ用の本文はここに置く。
 */
function saveListingCopy_(sku, record) {
  const sheet = ensureSheet_(SHEET_LISTING_COPY, LISTING_COPY_HEADERS);
  const c = (record && record.content) || {};
  sheet.appendRow([
    sku,
    c.title || '',
    c.description || '',
    (c.listingWarnings || []).join(' / '),
    new Date().toISOString()
  ]);
}

function getListingCopy_(sku) {
  const sheet = ensureSheet_(SHEET_LISTING_COPY, LISTING_COPY_HEADERS);
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i][h.indexOf('SKU')] === sku) {
      return {
        title: data[i][h.indexOf('Title')] || '',
        description: data[i][h.indexOf('Description')] || '',
        warnings: data[i][h.indexOf('Warnings')] || ''
      };
    }
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 文字数カウントとタイトル調整
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 半角ASCIIを0.5文字として数える（ヤフオクの全角換算・推定） */
function countZenkaku_(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n += /[\x20-\x7E]/.test(s[i]) ? 0.5 : 1;
  }
  return n;
}

function countForChannel_(s, channel) {
  const spec = MANUAL_CHANNEL_SPEC[channel];
  if (!spec) return s.length;
  return spec.titleCountMode === 'zenkaku' ? countZenkaku_(s) : s.length;
}

/**
 * 販路の文字数制限に収まるタイトル候補を作る。
 *
 * 【重要】末尾を機械的に切り落とすことはしない。
 * 「アーティスト → 商品名 → [形式/年]」という優先順位で、
 * 入る要素だけを積む。入らなかった要素は dropped として返し、
 * 画面上で「何を落としたか」が見えるようにする。
 */
function buildTitleForChannel_(parts, channel) {
  const spec = MANUAL_CHANNEL_SPEC[channel];
  const limit = spec ? spec.titleLimit : 9999;

  const ordered = parts.filter(function (p) { return p && String(p).trim(); });
  if (!ordered.length) {
    return { title: '', count: 0, limit: limit, dropped: [], overflow: false, needsManualTrim: false };
  }

  const used = [];
  const dropped = [];

  ordered.forEach(function (p) {
    const candidate = used.concat([p]).join(' ');
    if (countForChannel_(candidate, channel) <= limit) {
      used.push(p);
    } else {
      dropped.push(p);
    }
  });

  // 【重要】最優先の要素（商品名）単体で上限を超える場合、
  // used が空のままだと「[Vinyl]だけのタイトル」のような使えないものが出る。
  // その場合は勝手に切らず、商品名をそのまま渡して
  // 「超過しているので手で削ってください」と伝える方が実用的。
  if (used.length === 0 || (used.length === 1 && used[0] !== ordered[0])) {
    const primary = String(ordered[0]);
    return {
      title: primary,
      count: countForChannel_(primary, channel),
      limit: limit,
      dropped: dropped.filter(function (d) { return d !== ordered[0]; }),
      overflow: true,
      needsManualTrim: true
    };
  }

  const title = used.join(' ');
  return {
    title: title,
    count: countForChannel_(title, channel),
    limit: limit,
    dropped: dropped,
    overflow: countForChannel_(title, channel) > limit,
    needsManualTrim: false
  };
}

/** inventory行から、タイトルの構成要素を優先順に取り出す */
function titlePartsFromRow_(row, h) {
  return [
    row[h.indexOf('Product Name')],
    row[h.indexOf('Format')] ? '[' + row[h.indexOf('Format')] + ']' : ''
  ];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 画面に渡すデータ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * まだ手動販路に出していない在庫の一覧を返す。
 * （画面から google.script.run で呼ばれる）
 */
function getManualListingQueue() {
  const invSheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const data = invSheet.getDataRange().getValues();
  const h = data[0];
  const out = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sku = row[h.indexOf('SKU')];
    if (!sku) continue;
    if (row[h.indexOf('Status')] !== STOCK_STATUS.AVAILABLE) continue;

    // この在庫で、まだ出していない手動販路を拾う
    const listings = getChannelListings_(sku).filter(function (l) {
      return MANUAL_CHANNEL_SPEC[l.channel] && l.status === LISTING_STATUS.NOT_LISTED;
    });
    if (!listings.length) continue;

    const copy = getListingCopy_(sku) || { title: '', description: '', warnings: '' };
    const baseParts = titlePartsFromRow_(row, h);
    const price = row[h.indexOf('Est. Price')];
    const currency = row[h.indexOf('Est. Currency')];

    out.push({
      sku: sku,
      productName: String(row[h.indexOf('Product Name')] || ''),
      format: String(row[h.indexOf('Format')] || ''),
      cost: row[h.indexOf('Cost')],
      estPrice: price,
      estCurrency: String(currency || ''),
      description: String(copy.description || ''),
      warnings: String(copy.warnings || ''),
      channels: listings.map(function (l) {
        const t = buildTitleForChannel_(baseParts, l.channel);
        const spec = MANUAL_CHANNEL_SPEC[l.channel];
        return {
          channel: l.channel,
          label: spec.label,
          title: t.title,
          titleCount: t.count,
          titleLimit: t.limit,
          dropped: t.dropped,
          needsManualTrim: !!t.needsManualTrim,
          priceMin: spec.priceMin,
          priceMax: spec.priceMax,
          descLimit: spec.descLimit,
          verifiedNote: spec.verifiedNote
        };
      })
    });
  }
  return out;
}

/**
 * 売れたあとに「手で消す」必要がある出品の一覧。
 * ここが片付かないと二重販売のリスクが残り続ける。
 */
function getManualCleanupQueue() {
  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const data = sheet.getDataRange().getValues();
  const h = data[0];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const status = data[i][h.indexOf('Listing Status')];
    if (status !== LISTING_STATUS.MANUAL_REQUIRED && status !== LISTING_STATUS.STOP_FAILED &&
        status !== LISTING_STATUS.STOP_UNVERIFIED) continue;
    const ch = data[i][h.indexOf('Channel')];
    const adapter = typeof getAdapter_ === 'function' ? getAdapter_(ch) : null;
    out.push({
      sku: String(data[i][h.indexOf('SKU')] || ''),
      channel: ch,
      label: adapter ? adapter.label : ch,
      externalId: String(data[i][h.indexOf('External ID')] || ''),
      status: status,
      urgent: status === LISTING_STATUS.STOP_FAILED || status === LISTING_STATUS.STOP_UNVERIFIED
    });
  }
  return out;
}

/** 画面の「出品した」ボタンから呼ばれる */
function markListedFromUI(sku, channel, externalId) {
  return markAsListed(sku, channel, externalId || '(手動出品)');
}

/** 画面の「消した」ボタンから呼ばれる */
function markCleanupDoneFromUI(sku, channel) {
  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const found = findChannelListingRow_(sheet, sku, channel);
  if (!found) return { ok: false, note: '該当行が見つかりません' };
  updateChannelListing_(found.rowIndex, LISTING_STATUS.STOPPED, '人間が手動で削除したことを確認');
  return { ok: true, note: sku + ' / ' + channel + ' を削除済みにしました' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ウェブアプリ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// doGet() は web-router.gs に一本化しました。
// GASプロジェクトに doGet は1つしか置けないため、
// セットアップ画面と出品ヘルパーを同居させるにはルーターが必要です。
// この画面は ?page=listing で開きます。

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動作確認（外部APIを叩かない）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testManualListingHelper() {
  Logger.log('── タイトルの文字数調整 ──');

  const longName = 'In the Court of the Crimson King (An Observation By King Crimson) 50th Anniversary';
  ['MERCARI', 'RAKUMA', 'YAHOO_AUCTION'].forEach(function (ch) {
    const r = buildTitleForChannel_([longName, '[Vinyl]'], ch);
    Logger.log(MANUAL_CHANNEL_SPEC[ch].label + '（上限' + r.limit + '）: ' +
      r.count + '文字 / 落とした要素: ' + (r.dropped.length ? r.dropped.join(',') : 'なし'));
    Logger.log('  → ' + r.title);
  });

  Logger.log('');
  Logger.log('── 全角換算の確認（ヤフオク・推定ルール）──');
  Logger.log('"あいう" = ' + countZenkaku_('あいう') + '（全角3文字）');
  Logger.log('"abcdef" = ' + countZenkaku_('abcdef') + '（半角6文字→3.0）');

  Logger.log('');
  Logger.log('── キュー ──');
  Logger.log('出品待ち: ' + getManualListingQueue().length + '件');
  Logger.log('要削除: ' + getManualCleanupQueue().length + '件');
}
