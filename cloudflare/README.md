# Reuse OS Cloudflare Core v0

Google Apps Script / Sheets / Driveを必須依存にしない商品化コア。

## v0 bindings

- Workers: API / connector orchestration
- D1 `DB`: central inventory / channel listings / sale events
- R2 `MEDIA`: product photos
- Worker Secrets:
  - `ADMIN_TOKEN`
  - `DISCOGS_TOKEN`
- eBay credentials and OAuth refresh token are entered through the authenticated Admin Shell and encrypted before D1 storage. They are never written to Git or returned to the browser after save.

Google連携はOptional Bridgeとして扱う。

## Local

```bash
cd cloudflare
npm install
npm run db:local
npm run dev
```

WranglerはD1/R2 bindingを自動provisionできる構成にしている。Productionへ初回deployする前にCloudflare account / resource names / migration方針をreadbackすること。

## Secrets

値はGit / Notion / Chatへ書かない。

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DISCOGS_TOKEN
```

## API v0

- `GET /api/health` public, no secret values
- `GET /api/inventory` admin
- `POST /api/inventory` admin
- `POST /api/inventory/:sku/media` admin -> R2
- `GET /api/media/:key` admin
- `GET /api/connectors/discogs/identity` admin, READ ONLY
- `POST /api/connectors/discogs/listings/:id/stop` admin, WRITE / destructive

## Safety

Discogs stop endpoint is not exercised by CI or setup. Real Marketplace listing changes require an explicit runtime call after secret injection.

The existing GAS implementation remains a temporary bridge only. Do not delete or migrate live data until the Cloudflare path has passed shadow E2E.


## v0.1 inventory admin API

Authenticated with `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /api/dashboard` — inventory/listing summary
- `GET /api/inventory` — latest 200 inventory rows
- `POST /api/inventory` — create inventory item
- `GET /api/inventory/:sku` — item detail with listings/media
- `PATCH /api/inventory/:sku` — whitelist-only inventory update
- `POST /api/inventory/:sku/listings` — register/update external listing metadata
- `POST /api/inventory/:sku/media` — upload image when R2 is bound
- `GET /api/connectors/discogs/identity` — read-only Discogs identity check
- `POST /api/connectors/discogs/listings/:id/stop` — destructive stop/verify action

The admin shell now supports inventory creation, inventory table readback, and summary counts. R2 remains optional/fail-closed until its binding is provisioned.

### Validation and failure behavior

- unknown inventory patch fields are rejected
- duplicate SKU returns `409 SKU_EXISTS`
- invalid/negative JPY values are rejected
- media endpoints return `503 R2_NOT_CONFIGURED` when R2 is unavailable
- only JPEG / PNG / WebP are accepted for media upload
- Discogs destructive stop remains explicit and is never triggered by inventory CRUD


## Sale event state machine

Cloudflare Core now accepts idempotent sale events without performing destructive marketplace writes.

- `POST /api/sales/events` — record one sale event
- `GET /api/sales/events` — recent sale events
- `GET /api/stop-queue` — listings that must be stopped on other channels

When the last unit sells, inventory becomes `SOLD` with `sync_state=STOP_PENDING`.
When stock remains, inventory stays `AVAILABLE` with `sync_state=SYNC_PENDING`.

The response includes `destructive_actions_executed:false`. Actual marketplace stop calls remain a separate explicit executor boundary.


## eBay OAuth

The Cloudflare Core owns the eBay OAuth flow. Do not use the legacy GAS OAuth path and do not paste a two-hour User Access Token into source code.

1. Open the Worker Admin Shell and enter `ADMIN_TOKEN`.
2. In **eBay OAuth**, save Sandbox App ID, Cert ID, and OAuth-enabled RuName.
3. In eBay Developer Portal, set that RuName's **Auth Accepted URL** to:
   `https://reuse-os-core-v0.7thleaf.workers.dev/oauth/ebay/callback`
4. Click **eBayと接続** and approve with the Sandbox seller.
5. The callback exchanges the authorization code for access + refresh tokens, encrypts the connector payload, and stores only ciphertext in D1.
6. **接続テスト** calls the read-only Account API privileges endpoint.

Requested OAuth scopes are intentionally limited to the selling workflow while avoiding buy/PII/marketing scopes:

- `sell.inventory`
- `sell.account`
- `sell.fulfillment`

The first two cover inventory/offers and seller policies; fulfillment is included up front so order/shipping integration does not require another consent ceremony later.

### Admin API

- `POST /api/connectors/ebay/config` — save App ID / Cert ID / RuName / environment
- `GET /api/connectors/ebay/oauth/status` — sanitized connection state
- `GET /api/connectors/ebay/oauth/start` — create a signed OAuth consent URL
- `GET /oauth/ebay/callback` — public eBay callback; validates signed state, exchanges code, stores encrypted tokens
- `GET /api/connectors/ebay/privileges` — read-only seller account / selling-limit check
- `POST /api/connectors/ebay/disconnect` — remove OAuth tokens while retaining app configuration

Sandbox is the fail-safe default. Production is used only when `production` is explicitly saved in the Admin Shell.
