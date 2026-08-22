# 7THLEAF USED GOODS OS

中古品ハンター + 中央在庫 + 複数販路出品 / SOLD同期を1本につなぐための実験・運用OS。

## Current development state

- Frozen reference: `frozen/v0.0` @ `9f7d371dc22b0d3ed2814d24ed1eb85bf3d4530e`
- Active development: `agent/reuse-os-v0.1-e2e`
- Draft PR: `#1`
- Current target: Phase 1 Sandbox one-item E2E with readback

### Human gate shortcut

From the local v0.1 checkout:

```bash
npm run morning
```

This is the preferred 10-minute human lane. It verifies the branch and code, binds the local Apps Script project if needed, runs `clasp status`, requires the exact `PUSH` confirmation before source push, then opens Apps Script for an owner-only Web App deployment.

It does **not** deploy automatically, enter secrets, perform eBay OAuth, create listings, or touch Production.

After deployment:

```text
<WEB_APP_URL>?page=setup
<WEB_APP_URL>?page=phase1
```

The first real E2E is Sandbox only. Do not proceed unless the Phase 1 page is fully green.

See `PHASE1_RUNBOOK.md` and `VERSION_LOCK.md` for the authoritative execution and safety gates.

---

## Architecture

The system keeps the following concerns separate:

```text
Hunter
  -> MASTER INVENTORY
  -> Channel Adapter
  -> SOLD State Machine
  -> stop / verify
  -> SOLD / SYNCED
  -> actual-sale feedback
```

### Core principles

- Inventory is the parent source of truth; sales channels are exits.
- Channel-specific auth and API behavior live behind adapters.
- Inventory state and synchronization state are separate axes.
- duplicate sale events must be idempotent.
- `verify=null` is not success.
- failed channel operations are retried per-channel instead of replaying the whole sale.
- secrets belong in Apps Script Properties, never tracked source.
- Production is never used to compensate for missing Sandbox setup.

## Web App routes

```text
?page=setup    configuration and connection setup
?page=listing  manual-channel listing helper
?page=phase1   read-only Phase 1 readiness panel
```

The default route is the Reuse OS home screen.

## Local verification

```bash
npm run verify
```

GitHub Actions runs syntax/global-name checks and the full Node mock test suite with zero external API communication.

## GAS source sync

Tracked `.clasp.json` intentionally contains a placeholder `scriptId`. Bind the real project only in the local checkout unless the project later explicitly decides to track that identifier.

Preferred path:

```bash
npm run morning
```

Manual commands remain available:

```bash
clasp status
clasp push
clasp open
```

## Safety

- `frozen/v0.0` is immutable.
- v0.1 remains a Draft PR until real Sandbox evidence is reviewed.
- owner-only Web App access is required during Phase 1.
- API keys, OAuth tokens, Cert IDs, and private credentials must never be copied into GitHub, Notion, or chat.
- Production one-item execution is a separate explicit gate after Sandbox PASS.
