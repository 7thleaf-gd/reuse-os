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
