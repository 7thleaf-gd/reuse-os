# Reuse OS Cloudflare Core v0

Google Apps Script / Sheets / Driveを必須依存にしない商品化コア。

## v0 bindings

- Workers: API / connector orchestration
- D1 `DB`: central inventory / channel listings / sale events
- R2 `MEDIA`: product photos
- Worker Secrets:
  - `ADMIN_TOKEN`
  - `DISCOGS_TOKEN`
  - later: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, refresh token

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
