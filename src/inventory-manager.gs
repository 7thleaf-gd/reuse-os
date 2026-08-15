/**
 * Inventory Manager（商品マスター + SOLD ステートマシン）
 *
 * 【役割】「7thleaf USED GOODS OS」の王様。
 * このSheetが唯一の真実（Single Source of Truth）であり、フリマ各社は
 * ただの出口（蛇口）として扱う。どのSKUのどのチャネルを止めるかを決めるだけで、
 * 各社APIの作法は一切知らない（全部 channel-adapters.gs に隔離済み）。
 *
 * 【設置順】phase0-implementation.gs → channel-router.gs → channel-adapters.gs
 *          → このファイル、の順に依存します。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【ステートマシン】
 *
 *   在庫ステータス（inventory.Status）＝物理的な在庫の所在
 *     AVAILABLE ──→ RESERVED ──→ SOLD
 *                      │
 *                      └──→ AVAILABLE（誤検知・注文キャンセル時に戻す）
 *
 *   同期ステータス（inventory.Sync State）＝他チャネル停止作業の進捗
 *     SALE_DETECTED → STOPPING_CHANNELS → VERIFYING → ┬ SYNCED
 *                                                      ├ PARTIAL_FAILURE
 *                                                      └ MANUAL_ACTION_REQUIRED
 *
 * この2軸を分けているのは、「在庫は確保できたが他チャネルの停止に失敗している」
 * という状態を正確に表現するため。1本の直線にすると
 * 「SOLDだけど実はeBayにまだ出てる」を表せず、二重販売を見逃す。
 *
 * 【RESERVED が最重要】
 * Webhookを受けた瞬間、外部チャネルの停止を待たずに即座にRESERVEDにする。
 * 停止完了を待ってから在庫を止めるのでは遅い（その数秒で別の客が買える）。
 * RESERVED以降、このSKUへの新規出品処理は assertListable_() で機械的に禁止される。
 *
 * 【冪等性（idempotency）】
 * イベントID = "チャネル:注文ID"。同じWebhookが2回来ても
 * sale_events台帳に既存の行があれば即returnし、停止処理を二重実行しない。
 * さらに LockService でRESERVED遷移を排他制御し、同時到達にも耐える。
 *
 * 【リトライ】
 * 3チャネル成功・1チャネル失敗でも全部やり直さない。
 * channel_listings の Listing Status が STOP_FAILED の行だけを
 * retryFailedStops(sku) が拾って再実行する。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【正直に書いておく限界】
 * - verify は各Adapterの実装に依存し、判定不能（verified=null）を返すケースがある。
 *   これを「成功」に丸めない。null は null のまま MANUAL_ACTION_REQUIRED に倒す
 * - Yahoo!ショッピングはeditItemのフロント反映が別処理と公式明記されており、
 *   verifyが通っても実際に購入不可になるまでラグがある
 * - 手数料計算は未実装。Gross Profit は「実売価格 − 仕入価格」の単純計算で、
 *   各社の販売手数料（eBay 12.9%等）は引かれていない
 * - Discogsは現状「商品DB・相場参照」専用。販売チャネルとしては未実装
 *   （本人確認が通ったら discogs-adapter を足して CHANNEL_ADAPTERS に登録するだけでよい）
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状態の定義
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const STOCK_STATUS = {
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  SOLD: 'SOLD'
};

const SYNC_STATE = {
  SALE_DETECTED: 'SALE_DETECTED',
  STOPPING_CHANNELS: 'STOPPING_CHANNELS',
  VERIFYING: 'VERIFYING',
  SYNCED: 'SYNCED',
  PARTIAL_FAILURE: 'PARTIAL_FAILURE',
  MANUAL_ACTION_REQUIRED: 'MANUAL_ACTION_REQUIRED'
};

const LISTING_STATUS = {
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',   // そのチャネルの規約・ポリシー上そもそも出せない
  NOT_LISTED: 'NOT_LISTED',       // 出せるがまだ出していない
  LISTED: 'LISTED',               // 出品中
  STOP_PENDING: 'STOP_PENDING',   // 停止処理中
  STOPPED: 'STOPPED',             // 停止済み（verify通過）
  STOP_FAILED: 'STOP_FAILED',     // 停止失敗（リトライ対象）
  STOP_UNVERIFIED: 'STOP_UNVERIFIED', // 停止APIは成功したが購入不可を確認できていない
  MANUAL_REQUIRED: 'MANUAL_REQUIRED'  // 人間が手で消す必要がある
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SKU採番
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SKU_PREFIX_BY_CATEGORY = {
  MUSIC: 'AUDIO',
  BOOK: 'BOOK',
  GAME: 'GAME',
  GEAR: 'GEAR',
  CAMERA: 'CAM',
  ANTIQUE: 'ANTQ',
  FIGURINE: 'FIG',
  JUNK_ELECTRONICS: 'ELEC',
  UNKNOWN: 'MISC'
};

function generateSku_(category) {
  const prefix = SKU_PREFIX_BY_CATEGORY[category] || SKU_PREFIX_BY_CATEGORY.UNKNOWN;
  const props = PropertiesService.getScriptProperties();
  const key = 'SKU_COUNTER_' + prefix;
  const current = parseInt(props.getProperty(key) || '0', 10);
  const next = current + 1;
  props.setProperty(key, String(next));
  return prefix + '-' + String(next).padStart(6, '0');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sheet定義（3テーブル）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SHEET_INVENTORY = 'inventory';
const SHEET_CHANNEL_LISTINGS = 'channel_listings';
const SHEET_SALE_EVENTS = 'sale_events';

const INVENTORY_HEADERS = [
  'SKU', 'Status', 'Sync State', 'Category', 'Product Name', 'Format',
  'Cost', 'Est. Price', 'Est. Currency',
  'Sale Price', 'Sale Currency', 'Sold Channel', 'Sold Order ID',
  'Gross Profit(手数料前)', 'Days Held',
  'Created At', 'Reserved At', 'Sold At', 'Action Required'
];

const CHANNEL_LISTING_HEADERS = [
  'SKU', 'Channel', 'External ID', 'Listing Status',
  'Attempt Count', 'Last Attempt At', 'Last Note'
];

const SALE_EVENT_HEADERS = [
  'Event ID', 'SKU', 'Channel', 'Order ID',
  'Detected At', 'Stop Started At', 'Verified At', 'Synced At',
  'Final State', 'Note'
];

/** 既存データを壊さずヘッダを用意する（不足列は末尾追加） */
function ensureSheet_(name, headers) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold');
  }
  return sheet;
}

/** ヘッダ名 → 列番号(1始まり) の辞書を返す */
function headerMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) { map[h] = i + 1; });
  return map;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 在庫登録
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 承認済みrecordを在庫として登録し、チャネル別の出品可否行も同時に作る。
 */
function registerInventoryItem(record, costPrice) {
  const sheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const sku = generateSku_(record.product.category);

  sheet.appendRow([
    sku,
    STOCK_STATUS.AVAILABLE,
    '',                                  // Sync State（売れるまで空）
    record.product.category || '',
    record.product.productName || '',
    record.product.format || '',
    costPrice || 0,
    record.pricing.estimatedPrice !== null ? record.pricing.estimatedPrice : '',
    record.pricing.currency || '',
    '', '', '', '',                      // Sale Price/Currency/Channel/OrderID
    '', '',                              // Gross Profit / Days Held
    new Date().toISOString(),
    '', '',                              // Reserved At / Sold At
    ''                                   // Action Required
  ]);

  // チャネル別の初期状態を作る（channel-router.gs の判定結果を使う）
  const channels = (record.content && record.content.channelEligibility && record.content.channelEligibility.length)
    ? record.content.channelEligibility
    : evaluateChannels_(record);

  const listingSheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  channels.forEach(function (c) {
    listingSheet.appendRow([
      sku,
      c.channel,
      '',                                                                  // External ID（出品したら埋まる）
      c.eligible ? LISTING_STATUS.NOT_LISTED : LISTING_STATUS.NOT_ELIGIBLE,
      0,
      '',
      c.eligible ? '' : c.reason
    ]);
  });

  // コピペ用の出品文をフルで保存する。
  // pending_approval 側は先頭120文字のプレビューしか持たないため、
  // 実際に貼り付けられる本文はこちらに置く（manual-listing-helper.gs）
  if (typeof saveListingCopy_ === 'function') {
    saveListingCopy_(sku, record);
  }

  return sku;
}

/**
 * 「このSKUをこのチャネルに出品した」ことを記録する。
 * 出品そのものの自動化（Listing Adapter）はまだ未実装なので、
 * 現状は手動出品後に外部IDをここに登録する運用を想定。
 *
 * RESERVED / SOLD のSKUには出品できない（＝RESERVEDの意味を機械的に守る）。
 */
function markAsListed(sku, channel, externalId) {
  const guard = assertListable_(sku);
  if (!guard.ok) return guard;

  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const col = headerMap_(sheet);
  const found = findChannelListingRow_(sheet, sku, channel);

  if (!found) {
    return { ok: false, note: 'SKU=' + sku + ' / channel=' + channel + ' の行が見つかりません' };
  }
  if (found.status === LISTING_STATUS.NOT_ELIGIBLE) {
    return { ok: false, note: channel + ' はこの商品の出品対象外です（' + found.note + '）' };
  }

  sheet.getRange(found.rowIndex, col['External ID']).setValue(externalId);
  sheet.getRange(found.rowIndex, col['Listing Status']).setValue(LISTING_STATUS.LISTED);
  sheet.getRange(found.rowIndex, col['Last Attempt At']).setValue(new Date().toISOString());
  return { ok: true, note: channel + ' に出品中として記録しました' };
}

/**
 * 新規出品してよいSKUかを判定する。
 * RESERVED以降は機械的に出品を禁止する（二重販売の入口を塞ぐ）。
 */
function assertListable_(sku) {
  const sheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const found = findInventoryRow_(sheet, sku);
  if (!found) return { ok: false, note: 'SKU「' + sku + '」が在庫に存在しません' };
  if (found.get('Status') !== STOCK_STATUS.AVAILABLE) {
    return {
      ok: false,
      note: 'SKU「' + sku + '」は ' + found.get('Status') + ' のため新規出品できません' +
        '（RESERVED/SOLDのSKUを再出品すると二重販売になります）'
    };
  }
  return { ok: true, note: '' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 行検索ヘルパ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function findInventoryRow_(sheet, sku) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === sku) {
      const row = data[i];
      return {
        rowIndex: i + 1,
        row: row,
        get: function (name) { return row[headers.indexOf(name)]; }
      };
    }
  }
  return null;
}

function findChannelListingRow_(sheet, sku, channel) {
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const iSku = headers.indexOf('SKU');
  const iCh = headers.indexOf('Channel');
  for (let i = 1; i < data.length; i++) {
    if (data[i][iSku] === sku && data[i][iCh] === channel) {
      return {
        rowIndex: i + 1,
        externalId: data[i][headers.indexOf('External ID')],
        status: data[i][headers.indexOf('Listing Status')],
        attemptCount: Number(data[i][headers.indexOf('Attempt Count')]) || 0,
        note: data[i][headers.indexOf('Last Note')]
      };
    }
  }
  return null;
}

/** そのSKUの全チャネル行を返す */
function getChannelListings_(sku) {
  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const iSku = headers.indexOf('SKU');
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][iSku] !== sku) continue;
    out.push({
      rowIndex: i + 1,
      sku: sku,
      channel: data[i][headers.indexOf('Channel')],
      externalId: data[i][headers.indexOf('External ID')],
      status: data[i][headers.indexOf('Listing Status')],
      attemptCount: Number(data[i][headers.indexOf('Attempt Count')]) || 0
    });
  }
  return out;
}

function updateChannelListing_(rowIndex, status, note) {
  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const col = headerMap_(sheet);
  const prev = Number(sheet.getRange(rowIndex, col['Attempt Count']).getValue()) || 0;
  sheet.getRange(rowIndex, col['Listing Status']).setValue(status);
  sheet.getRange(rowIndex, col['Attempt Count']).setValue(prev + 1);
  sheet.getRange(rowIndex, col['Last Attempt At']).setValue(new Date().toISOString());
  sheet.getRange(rowIndex, col['Last Note']).setValue(String(note).substring(0, 500));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 台帳（sale_events）と冪等性
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** イベントIDは「チャネル:注文ID」。同じ注文の通知が何度来ても1件に収束する */
function buildEventId_(channel, orderId) {
  return channel + ':' + orderId;
}

function findSaleEvent_(eventId) {
  const sheet = ensureSheet_(SHEET_SALE_EVENTS, SALE_EVENT_HEADERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === eventId) {
      return { rowIndex: i + 1, finalState: data[i][data[0].indexOf('Final State')] };
    }
  }
  return null;
}

function appendSaleEvent_(eventId, sku, channel, orderId) {
  const sheet = ensureSheet_(SHEET_SALE_EVENTS, SALE_EVENT_HEADERS);
  sheet.appendRow([eventId, sku, channel, orderId, new Date().toISOString(), '', '', '', SYNC_STATE.SALE_DETECTED, '']);
  return sheet.getLastRow();
}

function updateSaleEvent_(rowIndex, fields) {
  const sheet = ensureSheet_(SHEET_SALE_EVENTS, SALE_EVENT_HEADERS);
  const col = headerMap_(sheet);
  Object.keys(fields).forEach(function (name) {
    if (col[name]) sheet.getRange(rowIndex, col[name]).setValue(fields[name]);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 停止・verifyの実行エンジン（Adapterの中身は知らない）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 対象チャネル群の停止を実行する。
 * チャネル間は並列（fetchAll）、チャネル内は順次（ラウンド制）。
 *
 * targets: [{channel, externalId, rowIndex}]
 * 戻り値: { チャネルID: {attempted, success, notes:[], retryable} }
 */
function executeStops_(targets) {
  const results = {};
  const plans = [];

  targets.forEach(function (t) {
    const adapter = getAdapter_(t.channel);
    if (!adapter) {
      results[t.channel] = { attempted: false, success: false, notes: ['Adapter未登録'] };
      return;
    }
    if (adapter.mode === 'manual') {
      results[t.channel] = {
        attempted: false, success: false, manual: true,
        notes: [adapter.manualInstruction(t.externalId)]
      };
      return;
    }
    const cfg = adapter.isConfigured();
    if (!cfg.ok) {
      results[t.channel] = { attempted: false, success: false, notes: ['未接続: ' + cfg.reason] };
      return;
    }
    const steps = adapter.buildStopSteps(t.externalId);
    if (!steps.length) {
      results[t.channel] = { attempted: false, success: false, notes: ['停止ステップが定義されていません'] };
      return;
    }
    plans.push({ channel: t.channel, adapter: adapter, steps: steps });
    results[t.channel] = { attempted: true, success: true, notes: [], retryable: false };
  });

  // 最大ステップ数だけラウンドを回す（各ラウンド内は全チャネル並列）
  const maxSteps = plans.reduce(function (m, p) { return Math.max(m, p.steps.length); }, 0);

  for (let round = 0; round < maxSteps; round++) {
    const roundPlans = plans.filter(function (p) {
      // 直前のラウンドで失敗したチャネルは以降のステップを打ち切る
      return p.steps[round] && results[p.channel].success;
    });
    if (!roundPlans.length) continue;

    let responses;
    try {
      responses = UrlFetchApp.fetchAll(roundPlans.map(function (p) { return p.steps[round].request; }));
    } catch (e) {
      roundPlans.forEach(function (p) {
        results[p.channel].success = false;
        results[p.channel].notes.push('fetchAll失敗: ' + e.message);
      });
      continue;
    }

    responses.forEach(function (res, i) {
      const p = roundPlans[i];
      const step = p.steps[round];
      const verdict = p.adapter.interpretStop(step.name, res.getResponseCode(), res.getContentText());
      results[p.channel].notes.push(verdict.note);
      if (!verdict.success) {
        results[p.channel].success = false;
        if (verdict.retryable) results[p.channel].retryable = true;
      }
    });
  }

  return results;
}

/**
 * 停止したチャネルが「本当に購入不可になったか」を再取得して確認する。
 * verified が true / false / null の3値であることが重要。
 * null（判定不能）を true に丸めない。
 */
function executeVerifies_(targets) {
  const results = {};
  const plans = [];

  targets.forEach(function (t) {
    const adapter = getAdapter_(t.channel);
    if (!adapter || adapter.mode !== 'api') {
      results[t.channel] = { verified: null, note: 'verify対象外' };
      return;
    }
    const req = adapter.buildVerifyRequest(t.externalId);
    if (!req) {
      results[t.channel] = { verified: null, note: 'このチャネルにはverify手段がありません' };
      return;
    }
    plans.push({ channel: t.channel, adapter: adapter, request: req });
  });

  if (plans.length) {
    let responses;
    try {
      responses = UrlFetchApp.fetchAll(plans.map(function (p) { return p.request; }));
      responses.forEach(function (res, i) {
        const p = plans[i];
        results[p.channel] = p.adapter.interpretVerify(res.getResponseCode(), res.getContentText());
      });
    } catch (e) {
      plans.forEach(function (p) {
        results[p.channel] = { verified: null, note: 'verifyのfetchAll失敗: ' + e.message };
      });
    }
  }

  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SOLD ワークフロー本体
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 売却を検知したときの唯一の入口。Webhookからも手動からもここを呼ぶ。
 *
 * 冪等：同じ (channel, orderId) で何度呼んでも1回しか実行されない。
 */
function handleSaleEvent(sku, soldChannel, orderId, salePrice, saleCurrency) {
  const eventId = buildEventId_(soldChannel, orderId);

  // ── 冪等性チェック（ロック取得前に軽く弾く）
  const existing = findSaleEvent_(eventId);
  if (existing) {
    return {
      ok: true, duplicated: true,
      note: 'イベント「' + eventId + '」は処理済みのためスキップしました（現在: ' + existing.finalState + '）'
    };
  }

  // ── RESERVED遷移は排他制御下で行う（同時到達対策）
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { ok: false, note: 'ロック取得に失敗しました（他の処理が実行中）: ' + e.message };
  }

  let eventRow;
  let inv;
  try {
    // ロック内で再チェック（この間に他スレッドが書いた可能性）
    if (findSaleEvent_(eventId)) {
      return { ok: true, duplicated: true, note: 'イベント「' + eventId + '」は同時実行により処理済みです' };
    }

    const invSheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
    inv = findInventoryRow_(invSheet, sku);
    if (!inv) {
      return { ok: false, note: 'SKU「' + sku + '」が在庫に存在しません' };
    }

    const current = inv.get('Status');
    if (current === STOCK_STATUS.SOLD) {
      return { ok: false, note: 'SKU「' + sku + '」は既にSOLDです（別注文の可能性。二重販売が起きていないか要確認）' };
    }
    if (current === STOCK_STATUS.RESERVED) {
      return { ok: false, note: 'SKU「' + sku + '」は既にRESERVEDです（別チャネルの売却処理が進行中）' };
    }

    // ★ ここが肝：外部チャネルの停止を待たず、即座に確保する
    const col = headerMap_(invSheet);
    invSheet.getRange(inv.rowIndex, col['Status']).setValue(STOCK_STATUS.RESERVED);
    invSheet.getRange(inv.rowIndex, col['Sync State']).setValue(SYNC_STATE.SALE_DETECTED);
    invSheet.getRange(inv.rowIndex, col['Reserved At']).setValue(new Date().toISOString());
    invSheet.getRange(inv.rowIndex, col['Sold Channel']).setValue(soldChannel);
    invSheet.getRange(inv.rowIndex, col['Sold Order ID']).setValue(orderId);

    eventRow = appendSaleEvent_(eventId, sku, soldChannel, orderId);
    SpreadsheetApp.flush();   // ロック解放前に確実に書き込む
  } finally {
    lock.releaseLock();
  }

  // ── ここから先は時間のかかるHTTP処理。ロックの外で行う
  return finalizeSale_(sku, soldChannel, orderId, salePrice, saleCurrency, eventRow);
}

/**
 * RESERVED 済みのSKUについて、他チャネル停止 → verify → SOLD確定 を行う。
 */
function finalizeSale_(sku, soldChannel, orderId, salePrice, saleCurrency, eventRow) {
  const invSheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const col = headerMap_(invSheet);
  const inv = findInventoryRow_(invSheet, sku);

  // ── STOPPING_CHANNELS
  invSheet.getRange(inv.rowIndex, col['Sync State']).setValue(SYNC_STATE.STOPPING_CHANNELS);
  if (eventRow) updateSaleEvent_(eventRow, { 'Stop Started At': new Date().toISOString(), 'Final State': SYNC_STATE.STOPPING_CHANNELS });

  // 停止対象＝「出品中」かつ「売れたチャネル以外」
  const targets = getChannelListings_(sku).filter(function (l) {
    return l.channel !== soldChannel && l.status === LISTING_STATUS.LISTED;
  });

  targets.forEach(function (t) { updateChannelListing_(t.rowIndex, LISTING_STATUS.STOP_PENDING, '停止処理開始'); });

  const stopResults = executeStops_(targets);

  // ── VERIFYING（停止APIが成功したチャネルだけ確認する）
  invSheet.getRange(inv.rowIndex, col['Sync State']).setValue(SYNC_STATE.VERIFYING);

  const verifyTargets = targets.filter(function (t) {
    const r = stopResults[t.channel];
    return r && r.attempted && r.success;
  });
  const verifyResults = executeVerifies_(verifyTargets);
  if (eventRow) updateSaleEvent_(eventRow, { 'Verified At': new Date().toISOString() });

  // ── 各チャネルの最終状態を確定
  const actionItems = [];
  targets.forEach(function (t) {
    const stop = stopResults[t.channel] || {};
    const ver = verifyResults[t.channel] || {};
    const notes = (stop.notes || []).join(' / ') + (ver.note ? ' ／ verify: ' + ver.note : '');

    let status;
    if (stop.manual) {
      status = LISTING_STATUS.MANUAL_REQUIRED;
      actionItems.push(stop.notes[0]);
    } else if (!stop.attempted) {
      status = LISTING_STATUS.STOP_FAILED;
      actionItems.push(t.channel + ': 停止を試行できませんでした（' + notes + '）');
    } else if (!stop.success) {
      status = LISTING_STATUS.STOP_FAILED;
      actionItems.push(t.channel + ': 停止APIが失敗しました。retryFailedStops("' + sku + '") で再試行するか手動で止めてください');
    } else if (ver.verified === true) {
      status = LISTING_STATUS.STOPPED;
    } else if (ver.verified === false) {
      status = LISTING_STATUS.STOP_FAILED;
      actionItems.push(t.channel + ': ⚠️停止APIは成功したが、まだ購入可能な状態です。至急手動確認してください');
    } else {
      // null＝判定不能。ここを成功に丸めない
      status = LISTING_STATUS.STOP_UNVERIFIED;
      actionItems.push(t.channel + ': 停止APIは成功しましたが購入不可を確認できませんでした（' + (ver.note || '') + '）');
    }
    updateChannelListing_(t.rowIndex, status, notes);
  });

  // 手動チャネル（メルカリ個人・ラクマ・ヤフオク個人）は出品中でなくても必ず案内を出す
  getChannelListings_(sku).forEach(function (l) {
    if (l.channel === soldChannel) return;
    const adapter = getAdapter_(l.channel);
    if (!adapter || adapter.mode !== 'manual') return;
    if (l.status !== LISTING_STATUS.LISTED && l.status !== LISTING_STATUS.MANUAL_REQUIRED) return;
    updateChannelListing_(l.rowIndex, LISTING_STATUS.MANUAL_REQUIRED, '自動停止不可のため手動削除が必要');
    const msg = adapter.manualInstruction(l.externalId);
    if (actionItems.indexOf(msg) === -1) actionItems.push(msg);
  });

  // ── 最終同期ステータスを決める
  const finalStatuses = getChannelListings_(sku)
    .filter(function (l) { return l.channel !== soldChannel; })
    .map(function (l) { return l.status; });

  let syncState;
  if (finalStatuses.indexOf(LISTING_STATUS.STOP_FAILED) !== -1) {
    syncState = SYNC_STATE.PARTIAL_FAILURE;
  } else if (finalStatuses.indexOf(LISTING_STATUS.MANUAL_REQUIRED) !== -1 ||
             finalStatuses.indexOf(LISTING_STATUS.STOP_UNVERIFIED) !== -1) {
    syncState = SYNC_STATE.MANUAL_ACTION_REQUIRED;
  } else {
    syncState = SYNC_STATE.SYNCED;
  }

  // ── SOLD確定
  const soldAt = new Date();
  const createdAtStr = inv.get('Created At');
  const createdAt = createdAtStr ? new Date(createdAtStr) : soldAt;
  const daysHeld = Math.max(0, Math.round((soldAt - createdAt) / 86400000));
  const grossProfit = Number(salePrice) - (Number(inv.get('Cost')) || 0);

  invSheet.getRange(inv.rowIndex, col['Status']).setValue(STOCK_STATUS.SOLD);
  invSheet.getRange(inv.rowIndex, col['Sync State']).setValue(syncState);
  invSheet.getRange(inv.rowIndex, col['Sale Price']).setValue(salePrice);
  invSheet.getRange(inv.rowIndex, col['Sale Currency']).setValue(saleCurrency || '');
  invSheet.getRange(inv.rowIndex, col['Gross Profit(手数料前)']).setValue(grossProfit);
  invSheet.getRange(inv.rowIndex, col['Days Held']).setValue(daysHeld);
  invSheet.getRange(inv.rowIndex, col['Sold At']).setValue(soldAt.toISOString());
  invSheet.getRange(inv.rowIndex, col['Action Required']).setValue(actionItems.join('\n'));

  if (eventRow) {
    updateSaleEvent_(eventRow, {
      'Synced At': soldAt.toISOString(),
      'Final State': syncState,
      'Note': actionItems.join(' / ').substring(0, 500)
    });
  }

  return {
    ok: true,
    sku: sku,
    syncState: syncState,
    daysHeld: daysHeld,
    grossProfit: grossProfit,
    stopResults: stopResults,
    verifyResults: verifyResults,
    actionItems: actionItems
  };
}

/**
 * 失敗したチャネルだけを再実行する（リトライキュー）。
 * 成功済みチャネルには触らないので、何度呼んでも安全。
 */
function retryFailedStops(sku) {
  const failed = getChannelListings_(sku).filter(function (l) {
    return l.status === LISTING_STATUS.STOP_FAILED && l.externalId;
  });

  if (!failed.length) {
    return { ok: true, note: 'リトライ対象のチャネルはありません', retried: 0 };
  }

  const stopResults = executeStops_(failed);
  const verifyTargets = failed.filter(function (t) {
    const r = stopResults[t.channel];
    return r && r.attempted && r.success;
  });
  const verifyResults = executeVerifies_(verifyTargets);

  const stillFailing = [];
  failed.forEach(function (t) {
    const stop = stopResults[t.channel] || {};
    const ver = verifyResults[t.channel] || {};
    const notes = (stop.notes || []).join(' / ') + (ver.note ? ' ／ verify: ' + ver.note : '');

    let status;
    if (stop.attempted && stop.success && ver.verified === true) {
      status = LISTING_STATUS.STOPPED;
    } else if (stop.attempted && stop.success) {
      status = LISTING_STATUS.STOP_UNVERIFIED;
    } else {
      status = LISTING_STATUS.STOP_FAILED;
      stillFailing.push(t.channel);
    }
    updateChannelListing_(t.rowIndex, status, notes);
  });

  // 全部片付いたなら在庫側の同期ステータスも更新する
  const remaining = getChannelListings_(sku).filter(function (l) {
    return l.status === LISTING_STATUS.STOP_FAILED ||
           l.status === LISTING_STATUS.MANUAL_REQUIRED ||
           l.status === LISTING_STATUS.STOP_UNVERIFIED;
  });
  if (!remaining.length) {
    const invSheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
    const inv = findInventoryRow_(invSheet, sku);
    if (inv) {
      invSheet.getRange(inv.rowIndex, headerMap_(invSheet)['Sync State']).setValue(SYNC_STATE.SYNCED);
    }
  }

  return { ok: true, retried: failed.length, stillFailing: stillFailing, stopResults: stopResults };
}

/**
 * 誤検知・注文キャンセル時に RESERVED を AVAILABLE へ戻す。
 * SOLD になったものは戻さない（戻すべきケースは返品処理として別に扱うべきなので、
 * ここで安易に巻き戻せるようにしない）。
 */
function releaseReservation(sku, reason) {
  const invSheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const inv = findInventoryRow_(invSheet, sku);
  if (!inv) return { ok: false, note: 'SKU「' + sku + '」が見つかりません' };
  if (inv.get('Status') !== STOCK_STATUS.RESERVED) {
    return { ok: false, note: 'SKU「' + sku + '」は RESERVED ではありません（現在: ' + inv.get('Status') + '）' };
  }
  const col = headerMap_(invSheet);
  invSheet.getRange(inv.rowIndex, col['Status']).setValue(STOCK_STATUS.AVAILABLE);
  invSheet.getRange(inv.rowIndex, col['Sync State']).setValue('');
  invSheet.getRange(inv.rowIndex, col['Reserved At']).setValue('');
  invSheet.getRange(inv.rowIndex, col['Action Required']).setValue('予約解除: ' + (reason || ''));
  return { ok: true, note: 'SKU「' + sku + '」を AVAILABLE に戻しました' };
}

/**
 * 人間が対応すべき作業の一覧（メルカリ個人の削除など）。
 * これをそのまま作業リストとして使える。
 */
function listActionRequired() {
  const sheet = ensureSheet_(SHEET_CHANNEL_LISTINGS, CHANNEL_LISTING_HEADERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const status = data[i][headers.indexOf('Listing Status')];
    if (status === LISTING_STATUS.MANUAL_REQUIRED ||
        status === LISTING_STATUS.STOP_FAILED ||
        status === LISTING_STATUS.STOP_UNVERIFIED) {
      out.push({
        sku: data[i][headers.indexOf('SKU')],
        channel: data[i][headers.indexOf('Channel')],
        externalId: data[i][headers.indexOf('External ID')],
        status: status,
        note: data[i][headers.indexOf('Last Note')]
      });
    }
  }
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動作確認
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function testInventoryStateMachine() {
  const record = new CanonicalProductRecord();
  record.product.category = 'MUSIC';
  record.product.productName = 'In the Court of the Crimson King';
  record.product.format = 'Vinyl';
  record.product.year = 1969;
  record.pricing.estimatedPrice = 9.35;
  record.pricing.currency = 'EUR';
  attachChannelRouting_(record);

  const sku = registerInventoryItem(record, 3000);
  Logger.log('SKU: ' + sku);

  Logger.log('eBayに出品記録: ' + JSON.stringify(markAsListed(sku, 'EBAY', 'offer-123')));
  Logger.log('メルカリ個人に出品記録: ' + JSON.stringify(markAsListed(sku, 'MERCARI', 'mercari-abc')));

  const r1 = handleSaleEvent(sku, 'MERCARI', 'ORDER-001', 8000, 'JPY');
  Logger.log('1回目: ' + JSON.stringify(r1, null, 2));

  const r2 = handleSaleEvent(sku, 'MERCARI', 'ORDER-001', 8000, 'JPY');
  Logger.log('2回目（冪等性チェック）: ' + JSON.stringify(r2));

  Logger.log('要対応リスト: ' + JSON.stringify(listActionRequired(), null, 2));
}
