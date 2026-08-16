/**
 * Channel Adapters（追加ファイル）
 *
 * 【役割】各販路のURL・認証・停止手順・verify手順を「ここだけ」に隔離する。
 * inventory-manager.gs は「どのSKUのどのチャネルを止めるか」だけを決める王様で、
 * 各社APIの作法は一切知らない。新しい販路を足すときは、このファイルに
 * Adapterを1つ追加して CHANNEL_ADAPTERS に登録するだけで済む。
 *
 * 【Adapterインターフェース（duck typing）】
 *   channel                     : チャネルID（CHANNEL_POLICYのキーと一致させる）
 *   label                       : 表示名
 *   mode                        : 'api' | 'manual'
 *   isConfigured()              : {ok: bool, reason: string}
 *   buildStopSteps(externalId)  : [{name, request}] 停止に必要なHTTPリクエストの順序付きリスト
 *   interpretStop(step, code, body) : {success: bool, note: string}
 *   buildVerifyRequest(externalId)  : {request} | null（verify手段が無い場合はnull）
 *   interpretVerify(code, body) : {verified: true|false|null, note: string}
 *                                 true=停止確認できた / false=まだ購入可能な疑い /
 *                                 null=判定不能（ここを握りつぶさないのが重要）
 *
 * 【停止が複数ステップになるチャネルがある理由】
 * - Yahoo!ショッピング：在庫クローズ(setStock)とページ非公開(editItem)が別API
 * - メルカリShops：在庫0にしてから削除する（後述の実例対策）
 * inventory-manager は「ラウンドN＝全チャネルのN番目のステップ」を並列実行するので、
 * チャネル間は並列、チャネル内は順次、という実行になる。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 【公式ドキュメント調査の結果（2026-08-14時点）】
 * 確認できたことと、確認できなかったことを明確に分けて記載する。
 * 「確認できなかった」ものを推測で埋めない（REUSE開発方針D）。
 *
 * ■ eBay
 *   認証  : User access token（認可コードフロー）が必須。有効期限2時間。
 *           リフレッシュトークン（約18ヶ月）から自動更新する仕組みは ebay-auth.gs。
 *           ホストは環境で変わるため ebayApiBase_() を必ず経由すること
 *           （直書きするとサンドボックスで動かない）
 *   停止  : withdrawOffer  POST /sell/inventory/v1/offer/{offerId}/withdraw  ✅確認済み
 *           公式に "will end the active eBay listing associated with the offer" と明記
 *   verify: getOffer       GET  /sell/inventory/v1/offer/{offerId}           ✅エンドポイント確認済み
 *           OfferStatusEnum = PUBLISHED / UNPUBLISHED も✅確認済み
 *           ⚠️ ただしレスポンスJSON中のフィールド名が literally "status" かどうかは
 *              ドキュメントのOutput表が動的描画で読めず未確認。実接続時に実物を見て確定すること
 *
 * ■ Etsy
 *   停止  : updateListing  PATCH /v3/application/shops/{shop_id}/listings/{listing_id}
 *           body: {state: "inactive"}                                        ✅
 *           公式が「unsearchable, and unsellable」と明記する唯一の確実な停止手段
 *           ⚠️ 重要：ドキュメント本文の "Deactivated" は説明用の言葉で、API上のリテラル値は
 *              "inactive"（getListingsByShopのstateパラメータenumが
 *              ["active","inactive","sold_out","draft","expired"] であることから確認）。
 *              "deactivated" という文字列はenumに存在しないので使ってはいけない
 *   verify: getListing     GET  /v3/application/listings/{listing_id}        ✅エンドポイント確認済み
 *           ⚠️ レスポンスのstateフィールドが "inactive" を返すことはenumから強く推定できるが
 *              レスポンススキーマ自体は未確認。実接続時に1度実物で確認すること
 *
 * ■ メルカリShops
 *   停止  : ①updateProductVariant(stockQuantity:0) → ②deleteProduct        ✅両方確認済み
 *           ⚠️ 在庫0だけでは不十分：公式サポートに
 *              「updateProductVariantで在庫を0に設定しましたが、その後に注文が入りました」
 *              という記述が実在する。だから削除まで行う2段構えにしている
 *   verify: product(id:) クエリ                                              ✅クエリ存在は確認済み
 *           ProductStatus enum = OPENED / UNOPENED / CLOSED も✅確認済み
 *           ⚠️ 【設計上の判断】deleteProduct の後に product(id:) を引いたとき何が返るか
 *              （エラーかnullか）は公式ドキュメントに記載が無い。返り値型が Product!（非null）
 *              なのでエラーになる可能性が高いが、これは推測。
 *              → そこで verify は「削除の後」ではなく「在庫0にした直後・削除の前」に行う。
 *                 stockQuantity===0 を確認してから削除する順序にすることで、
 *                 未確認の挙動に依存しない設計にした
 *   注意  : 認証は Personal Access Token（自己発行可）＋ API_CLIENT_NAME（契約時にMercariが発行）
 *           の2点セット。後者が無いと呼べないため、契約前は isConfigured() が false になる
 *
 * ■ Yahoo!ショッピング
 *   停止  : ①setStock(quantity=0, stock_close=1) → ②editItem(display=0)     ✅両方確認済み
 *   verify: getStock POST /ShoppingWebService/V1/getStock                    ✅確認済み
 *           レスポンスに Quantity / StockClose / IsPublished フィールドあり ✅確認済み
 *           StockClose="1" が在庫クローズ状態                                ✅確認済み
 *           ⚠️ editItemで設定した display フラグを読み戻すエンドポイントは未確認。
 *              よってverifyは在庫側（getStock）でのみ行い、display側は未検証のまま残る
 *   構造的問題: editItemは公式に「※フロント反映はしません。別途反映処理が必要です」と明記。
 *              つまり停止の即時性が構造的に弱い。4社中もっとも二重販売リスクが高い
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// eBay Adapter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const EbayAdapter = {
  channel: 'EBAY',
  label: 'eBay',
  mode: 'api',

  isConfigured: function () {
    // 【重要】eBayのアクセストークンは2時間で失効するため、
    // 「トークンが入っているか」ではなく「今すぐ有効なトークンを取れるか」で判定する。
    // 期限が近ければここで自動更新される（ebay-auth.gs）
    const t = getEbayAccessToken_();
    if (!t.ok) return { ok: false, reason: t.note };
    return { ok: true, reason: '' };
  },

  // externalId = eBayのofferId
  buildStopSteps: function (externalId) {
    const t = getEbayAccessToken_();
    // isConfigured() を先に通す前提だが、単体で呼ばれても壊れないようにする
    const token = t.ok ? t.token : '';
    return [{
      name: 'withdrawOffer',
      request: {
        url: ebayApiBase_() + '/offer/' + encodeURIComponent(externalId) + '/withdraw',
        method: 'post',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true
      }
    }];
  },

  interpretStop: function (stepName, code, body) {
    if (code >= 200 && code < 300) {
      return { success: true, note: 'withdrawOffer成功（listingは終了扱い）' };
    }
    return { success: false, note: 'withdrawOffer失敗 HTTP' + code + '：' + String(body).substring(0, 150) };
  },

  buildVerifyRequest: function (externalId) {
    const t = getEbayAccessToken_();
    return {
      url: ebayApiBase_() + '/offer/' + encodeURIComponent(externalId),
      method: 'get',
      headers: { Authorization: 'Bearer ' + (t.ok ? t.token : '') },
      muteHttpExceptions: true
    };
  },

  interpretVerify: function (code, body) {
    if (code < 200 || code >= 300) {
      return { verified: null, note: 'getOffer取得失敗 HTTP' + code + '（停止できたか判定不能）' };
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { verified: null, note: 'getOfferのJSON解析に失敗（判定不能）' };
    }
    // ⚠️ フィールド名 status は未確認（上部コメント参照）。念のため複数の置き場所を見る
    const status = json.status || (json.listing && json.listing.listingStatus) || null;
    if (!status) {
      return { verified: null, note: 'レスポンスにstatus相当のフィールドが見つからず判定不能（実物を見てAdapterを修正すること）' };
    }
    if (String(status).toUpperCase() === 'UNPUBLISHED') {
      return { verified: true, note: 'status=UNPUBLISHED を確認。停止できている' };
    }
    return { verified: false, note: 'status=' + status + '（まだ公開中の疑い。二重販売リスクあり）' };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Etsy Adapter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const EtsyAdapter = {
  channel: 'ETSY',
  label: 'Etsy',
  mode: 'api',

  isConfigured: function () {
    const missing = [];
    if (!CONFIG.ETSY_API_KEY) missing.push('ETSY_API_KEY');
    if (!CONFIG.ETSY_OAUTH_TOKEN) missing.push('ETSY_OAUTH_TOKEN');
    if (!CONFIG.ETSY_SHOP_ID) missing.push('ETSY_SHOP_ID');
    if (missing.length) {
      return { ok: false, reason: 'CONFIG未設定: ' + missing.join('/') };
    }
    return { ok: true, reason: '' };
  },

  // externalId = Etsyのlisting_id
  buildStopSteps: function (externalId) {
    return [{
      name: 'updateListing(state=inactive)',
      request: {
        url: 'https://api.etsy.com/v3/application/shops/' + encodeURIComponent(CONFIG.ETSY_SHOP_ID) +
          '/listings/' + encodeURIComponent(externalId),
        method: 'patch',
        headers: {
          'x-api-key': CONFIG.ETSY_API_KEY,
          Authorization: 'Bearer ' + CONFIG.ETSY_OAUTH_TOKEN
        },
        contentType: 'application/json',
        // 【重要】"deactivated" ではなく "inactive"。enumに存在するのは後者（上部コメント参照）
        payload: JSON.stringify({ state: 'inactive' }),
        muteHttpExceptions: true
      }
    }];
  },

  interpretStop: function (stepName, code, body) {
    if (code >= 200 && code < 300) {
      return { success: true, note: 'updateListing(state=inactive)成功' };
    }
    return { success: false, note: 'updateListing失敗 HTTP' + code + '：' + String(body).substring(0, 150) };
  },

  buildVerifyRequest: function (externalId) {
    return {
      url: 'https://api.etsy.com/v3/application/listings/' + encodeURIComponent(externalId),
      method: 'get',
      headers: {
        'x-api-key': CONFIG.ETSY_API_KEY,
        Authorization: 'Bearer ' + CONFIG.ETSY_OAUTH_TOKEN
      },
      muteHttpExceptions: true
    };
  },

  interpretVerify: function (code, body) {
    if (code < 200 || code >= 300) {
      return { verified: null, note: 'getListing取得失敗 HTTP' + code + '（判定不能）' };
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { verified: null, note: 'getListingのJSON解析に失敗（判定不能）' };
    }
    const state = json.state || null;
    if (!state) {
      return { verified: null, note: 'レスポンスにstateフィールドが無く判定不能' };
    }
    // 購入されうる状態は active のみ。sold_out/expired/draft/inactive はいずれも購入不可側
    if (String(state).toLowerCase() === 'active') {
      return { verified: false, note: 'state=active（まだ購入可能。二重販売リスクあり）' };
    }
    return { verified: true, note: 'state=' + state + '（activeではないので購入不可）' };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// メルカリShops Adapter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const MercariShopsAdapter = {
  channel: 'MERCARI_SHOPS',
  label: 'メルカリShops（法人）',
  mode: 'api',

  isConfigured: function () {
    const missing = [];
    if (!CONFIG.MERCARI_SHOPS_ACCESS_TOKEN) missing.push('MERCARI_SHOPS_ACCESS_TOKEN（ショップ管理画面から自己発行可）');
    if (!CONFIG.MERCARI_SHOPS_CLIENT_NAME) missing.push('MERCARI_SHOPS_CLIENT_NAME（Mercariとの契約時に発行される）');
    if (missing.length) {
      return { ok: false, reason: 'CONFIG未設定: ' + missing.join(' / ') };
    }
    return { ok: true, reason: '' };
  },

  graphql_: function (query) {
    return {
      url: 'https://api.mercari-shops.com/graphql',
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + CONFIG.MERCARI_SHOPS_ACCESS_TOKEN,
        'User-Agent': CONFIG.MERCARI_SHOPS_CLIENT_NAME + '/1.0'
      },
      contentType: 'application/json',
      payload: JSON.stringify({ query: query }),
      muteHttpExceptions: true
    };
  },

  /**
   * externalId は "productId:variantId" 形式で渡す想定（在庫更新にvariantIdが要るため）。
   * variantIdが無い場合は在庫0ステップを省略して削除のみ行う。
   *
   * 【順序の理由】在庫0 → verify → 削除、という順にしたいので、
   * 在庫0を step1、削除を step2 に置いている。inventory-manager は
   * step1完了後にverifyを挟める設計になっている。
   */
  buildStopSteps: function (externalId) {
    const parts = String(externalId).split(':');
    const productId = parts[0];
    const variantId = parts.length > 1 ? parts[1] : null;

    const steps = [];

    if (variantId) {
      steps.push({
        name: 'updateProductVariant(stock=0)',
        request: this.graphql_(
          'mutation { updateProductVariant(input: { id: "' + variantId + '", stockQuantity: 0 }) ' +
          '{ productVariant { id stockQuantity } } }'
        )
      });
    }

    steps.push({
      name: 'deleteProduct',
      request: this.graphql_(
        'mutation { deleteProduct(input: { id: "' + productId + '" }) { product { id } } }'
      )
    });

    return steps;
  },

  interpretStop: function (stepName, code, body) {
    if (code < 200 || code >= 300) {
      return { success: false, note: stepName + '失敗 HTTP' + code + '：' + String(body).substring(0, 150) };
    }
    // GraphQLはHTTP200でもerrorsを返すことがあるので必ず中身を見る
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { success: false, note: stepName + '：レスポンスがJSONとして解析できません' };
    }
    if (json.errors && json.errors.length) {
      const first = json.errors[0] || {};
      const errCode = (first.extensions && first.extensions.errorCode) || '';
      // 公式に記載のある競合エラー。呼び出し側でリトライすべきケース
      if (String(errCode) === 'PRODUCT_DIFFERENCE_FOUND') {
        return {
          success: false,
          note: stepName + '：在庫の並行更新で競合（PRODUCT_DIFFERENCE_FOUND）。最新在庫を取得し直してリトライが必要',
          retryable: true
        };
      }
      return { success: false, note: stepName + '：GraphQLエラー ' + JSON.stringify(json.errors).substring(0, 150) };
    }
    return { success: true, note: stepName + '成功' };
  },

  buildVerifyRequest: function (externalId) {
    const productId = String(externalId).split(':')[0];
    return this.graphql_('query { product(id: "' + productId + '") { id status variants { id stockQuantity } } }');
  },

  interpretVerify: function (code, body) {
    if (code < 200 || code >= 300) {
      return { verified: null, note: 'product照会失敗 HTTP' + code + '（判定不能）' };
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { verified: null, note: 'product照会のJSON解析に失敗（判定不能）' };
    }
    if (json.errors && json.errors.length) {
      // 削除後にエラーが返る可能性は高いが公式に記載が無いため、成功と断定しない
      return {
        verified: null,
        note: '削除済みでエラーが返っている可能性が高いが、削除後の挙動が公式ドキュメント未記載のため断定不可：' +
          JSON.stringify(json.errors).substring(0, 120)
      };
    }
    const product = json.data && json.data.product;
    if (!product) {
      return { verified: null, note: 'productがレスポンスに含まれず判定不能' };
    }
    const totalStock = (product.variants || []).reduce(function (sum, v) {
      return sum + (Number(v.stockQuantity) || 0);
    }, 0);
    if (String(product.status).toUpperCase() === 'CLOSED' || totalStock === 0) {
      return { verified: true, note: 'status=' + product.status + ' / 在庫合計=' + totalStock + '（購入不可）' };
    }
    return { verified: false, note: 'status=' + product.status + ' / 在庫合計=' + totalStock + '（まだ購入可能な疑い）' };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Yahoo!ショッピング Adapter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const YahooShoppingAdapter = {
  channel: 'YAHOO_SHOPPING',
  label: 'Yahoo!ショッピング（ストア）',
  mode: 'api',

  isConfigured: function () {
    const missing = [];
    if (!CONFIG.YAHOO_SHOPPING_ACCESS_TOKEN) missing.push('YAHOO_SHOPPING_ACCESS_TOKEN');
    if (!CONFIG.YAHOO_SHOPPING_SELLER_ID) missing.push('YAHOO_SHOPPING_SELLER_ID');
    if (missing.length) {
      return { ok: false, reason: 'CONFIG未設定: ' + missing.join('/') };
    }
    return { ok: true, reason: '' };
  },

  // externalId = 商品コード（code）
  buildStopSteps: function (externalId) {
    const sellerId = encodeURIComponent(CONFIG.YAHOO_SHOPPING_SELLER_ID);
    const code = encodeURIComponent(externalId);
    const auth = { Authorization: 'Bearer ' + CONFIG.YAHOO_SHOPPING_ACCESS_TOKEN };

    return [
      {
        name: 'setStock(quantity=0, stock_close=1)',
        request: {
          url: 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1/setStock',
          method: 'post',
          headers: auth,
          contentType: 'application/x-www-form-urlencoded',
          payload: 'seller_id=' + sellerId + '&code=' + code + '&quantity=0&stock_close=1',
          muteHttpExceptions: true
        }
      },
      {
        name: 'editItem(display=0)',
        request: {
          url: 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1/editItem',
          method: 'post',
          headers: auth,
          contentType: 'application/x-www-form-urlencoded',
          payload: 'seller_id=' + sellerId + '&code=' + code + '&display=0',
          muteHttpExceptions: true
        }
      }
    ];
  },

  interpretStop: function (stepName, code, body) {
    if (code >= 200 && code < 300) {
      const note = stepName.indexOf('editItem') === 0
        ? stepName + '成功（⚠️ ただし公式に「フロント反映はしません。別途反映処理が必要です」と明記あり。' +
          '実際に購入不可になるまでラグがある前提で運用すること）'
        : stepName + '成功';
      return { success: true, note: note };
    }
    return { success: false, note: stepName + '失敗 HTTP' + code + '：' + String(body).substring(0, 150) };
  },

  buildVerifyRequest: function (externalId) {
    return {
      url: 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1/getStock',
      method: 'post',
      headers: { Authorization: 'Bearer ' + CONFIG.YAHOO_SHOPPING_ACCESS_TOKEN },
      contentType: 'application/x-www-form-urlencoded',
      payload: 'seller_id=' + encodeURIComponent(CONFIG.YAHOO_SHOPPING_SELLER_ID) +
        '&code=' + encodeURIComponent(externalId),
      muteHttpExceptions: true
    };
  },

  interpretVerify: function (code, body) {
    if (code < 200 || code >= 300) {
      return { verified: null, note: 'getStock取得失敗 HTTP' + code + '（判定不能）' };
    }
    const text = String(body);
    // getStockはXMLを返す。GASにXMLパーサ(XmlService)はあるが、
    // レスポンスの正確なネスト構造が未確認のため、ここでは値の抽出のみ行う
    const stockCloseMatch = text.match(/<StockClose>([^<]*)<\/StockClose>/);
    const quantityMatch = text.match(/<Quantity>([^<]*)<\/Quantity>/);

    if (!stockCloseMatch && !quantityMatch) {
      return { verified: null, note: 'getStockレスポンスからStockClose/Quantityを抽出できず判定不能（実物を見てAdapterを修正すること）' };
    }

    const stockClose = stockCloseMatch ? stockCloseMatch[1].trim() : null;
    const quantity = quantityMatch ? Number(quantityMatch[1].trim()) : null;

    if (stockClose === '1' || quantity === 0) {
      return {
        verified: true,
        note: 'StockClose=' + stockClose + ' / Quantity=' + quantity +
          '（在庫側は停止確認。⚠️ ただしdisplayフラグの読み戻しAPIが未確認のため、ページ非公開までは未検証）'
      };
    }
    return { verified: false, note: 'StockClose=' + stockClose + ' / Quantity=' + quantity + '（まだ購入可能な疑い）' };
  }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manual Adapter（メルカリ個人 / ラクマ / ヤフオク個人）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 公式APIが無い（または規約で自動化が禁止されている）販路用のAdapter。
 * HTTPリクエストは一切作らず、「人間がやるべき作業」を返すだけ。
 * これがあることで inventory-manager 側は
 * 「APIチャネルか手動チャネルか」を意識せず同じループで扱える。
 */
function makeManualAdapter_(channel, label, reason) {
  return {
    channel: channel,
    label: label,
    mode: 'manual',
    isConfigured: function () { return { ok: true, reason: '' }; },
    buildStopSteps: function () { return []; },   // HTTPは発行しない
    interpretStop: function () { return { success: false, note: '手動対応が必要' }; },
    buildVerifyRequest: function () { return null; },
    interpretVerify: function () { return { verified: null, note: '自動verify不可' }; },
    manualInstruction: function (externalId) {
      return label + 'の出品を手動で削除してください' +
        (externalId ? '（出品ID/URL: ' + externalId + '）' : '') + ' ／ 理由: ' + reason;
    }
  };
}

const MercariManualAdapter = makeManualAdapter_(
  'MERCARI', 'メルカリ（個人）',
  '公式出品APIが無く、利用規約が「弊社提供インターフェイス以外でのアクセス」を禁止しているため自動停止できない'
);

const RakumaManualAdapter = makeManualAdapter_(
  'RAKUMA', 'ラクマ',
  '公式出品APIの存在を確認できず、自動化可否の規約条項も未確認のため自動停止できない'
);

const YahooAuctionManualAdapter = makeManualAdapter_(
  'YAHOO_AUCTION', 'ヤフオク！（個人）',
  '個人向け出品APIは2018年・2020年に提供終了。利用規約も自動出品ツールの利用を明確に禁止しているため自動停止できない'
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Adapter レジストリ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CHANNEL_ADAPTERS = {
  EBAY: EbayAdapter,
  ETSY: EtsyAdapter,
  MERCARI_SHOPS: MercariShopsAdapter,
  YAHOO_SHOPPING: YahooShoppingAdapter,
  MERCARI: MercariManualAdapter,
  RAKUMA: RakumaManualAdapter,
  YAHOO_AUCTION: YahooAuctionManualAdapter
};

function getAdapter_(channel) {
  return CHANNEL_ADAPTERS[channel] || null;
}

/** APIで自動停止できるチャネルのIDリスト */
function apiChannels_() {
  return Object.keys(CHANNEL_ADAPTERS).filter(function (ch) {
    return CHANNEL_ADAPTERS[ch].mode === 'api';
  });
}

/** 手動対応が必要なチャネルのIDリスト */
function manualChannels_() {
  return Object.keys(CHANNEL_ADAPTERS).filter(function (ch) {
    return CHANNEL_ADAPTERS[ch].mode === 'manual';
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 動作確認（外部APIを一切叩かない）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 全Adapterが インターフェースを満たしているか、
 * 未設定時に安全に落ちるかを、HTTPを一切発行せずに確認する。
 */
function testChannelAdapters() {
  const required = ['channel', 'label', 'mode', 'isConfigured', 'buildStopSteps',
    'interpretStop', 'buildVerifyRequest', 'interpretVerify'];

  Object.keys(CHANNEL_ADAPTERS).forEach(function (key) {
    const a = CHANNEL_ADAPTERS[key];
    const missing = required.filter(function (r) { return a[r] === undefined; });
    const cfg = a.isConfigured();
    Logger.log('── ' + key + ' (' + a.label + ') ──');
    Logger.log('  mode: ' + a.mode);
    Logger.log('  インターフェース欠落: ' + (missing.length ? missing.join(',') : 'なし'));
    Logger.log('  設定状態: ' + (cfg.ok ? 'OK' : 'NG - ' + cfg.reason));
    if (a.mode === 'api' && cfg.ok) {
      const steps = a.buildStopSteps('DUMMY_ID');
      Logger.log('  停止ステップ数: ' + steps.length + ' (' +
        steps.map(function (s) { return s.name; }).join(' → ') + ')');
    }
  });
}
