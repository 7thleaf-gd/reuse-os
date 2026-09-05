/** Reuse OS 商品本体の薄い操作盤。状態正本はinventory Sheetのみ。 */
function getInventoryDashboard() {
  const sheet = ensureSheet_(SHEET_INVENTORY, INVENTORY_HEADERS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0] || INVENTORY_HEADERS;
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const obj = {};
    headers.forEach(function(h, idx){ obj[h] = row[idx]; });
    obj.channels = getChannelListings_(row[0]).map(function(c){
      return { channel:c.channel, externalId:c.externalId, status:c.status, attemptCount:c.attemptCount };
    });
    rows.push(obj);
  }
  rows.reverse();
  return { rows: rows, webAppUrl: getWebAppUrl(), total: rows.length };
}

function createInventoryFromUi(input) {
  input = input || {};
  const name = String(input.productName || '').trim();
  if (!name) return { ok:false, note:'商品名を入力してください' };
  const record = {
    product: {
      category: String(input.category || 'UNKNOWN').trim() || 'UNKNOWN',
      productName: name,
      format: String(input.format || '').trim()
    },
    pricing: {
      estimatedPrice: input.estimatedPrice === '' || input.estimatedPrice == null ? null : Number(input.estimatedPrice),
      currency: String(input.currency || 'JPY').trim() || 'JPY'
    },
    content: { channelEligibility: [] }
  };
  if (record.pricing.estimatedPrice !== null && !isFinite(record.pricing.estimatedPrice)) {
    return { ok:false, note:'想定売価が数値ではありません' };
  }
  const cost = input.costPrice === '' || input.costPrice == null ? 0 : Number(input.costPrice);
  if (!isFinite(cost)) return { ok:false, note:'仕入価格が数値ではありません' };
  record.content.channelEligibility = evaluateChannels_(record);
  const sku = registerInventoryItem(record, cost);
  return { ok:true, sku:sku, note:'中央在庫へ登録しました: ' + sku };
}

function registerListedFromUi(sku, channel, externalId) {
  sku = String(sku || '').trim();
  channel = String(channel || '').trim();
  externalId = String(externalId || '').trim();
  if (!sku || !channel || !externalId) return { ok:false, note:'SKU / 販路 / 外部IDを入力してください' };
  return markAsListed(sku, channel, externalId);
}

function retryInventoryFromUi(sku) {
  if (typeof retryFailedStops !== 'function') return { ok:false, note:'retry engineが見つかりません' };
  return retryFailedStops(String(sku || '').trim());
}
