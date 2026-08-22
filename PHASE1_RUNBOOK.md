# Reuse OS Phase 1 Sandbox E2E Runbook

Status: v0.1 development line. The frozen v0.0 reference remains untouched.

## Goal

Reach a real Sandbox one-item E2E without skipping safety gates.

```text
local binding
  -> clasp push
  -> Web App deploy (owner-only)
  -> Script Properties
  -> eBay Sandbox app + RuName
  -> browser OAuth
  -> Phase 1 preflight PASS
  -> one Sandbox item E2E
  -> readback
```

## Tomorrow 10-minute human lane

Human time is intentionally compressed to authentication and browser-only gates.

From a local checkout of `agent/reuse-os-v0.1-e2e` run:

```bash
npm run morning
```

The launcher:

1. confirms the expected development branch;
2. asks for the Apps Script `scriptId` only if the local `.clasp.json` is still a placeholder;
3. runs the complete local verification suite;
4. runs `clasp status`;
5. requires the human to type `PUSH` exactly before any Apps Script source write;
6. runs `clasp push` only after that explicit gate;
7. opens the Apps Script project and prints the owner-only Web App deployment steps.

It never deploys a Web App, enters secrets, performs eBay OAuth, creates a listing, or touches Production by itself.

If the eBay Developer Sandbox keyset does not already exist, creating the developer keyset/RuName may exceed this 10-minute window. In that case stop after the owner-only Web App is deployed and resume the eBay human gate separately. Do not compensate by using Production credentials.

## 0. Hard rules

- First E2E is **Sandbox only**.
- Do not put API keys, OAuth tokens, Cert ID, or other secrets in GitHub/Notion.
- Do not merge v0.1 into `main` before real-item readback.
- `frozen/v0.0` is the reference instrument and must not be modified.
- The Phase 1 readiness page is read-only and must not make external API calls.

## 1. Local GAS binding

The repository intentionally keeps a placeholder in tracked `.clasp.json`.

On the local working copy only, replace the placeholder `scriptId` with the target Apps Script project ID. Do not commit that local-only binding change unless the project explicitly decides the ID is safe to publish inside the private repository.

Preferred path:

```bash
npm run morning
```

Manual verification if needed:

```bash
clasp status
```

Expected: the project resolves and `rootDir` is `src`.

## 2. Push and deploy

Preferred source push path is the explicit gate inside:

```bash
npm run morning
```

Manual equivalent:

```bash
clasp push
```

Then deploy the Apps Script as a Web App:

- Execute as: yourself
- Access: yourself only

Never expose the setup/inventory Web App to everyone.

## 3. Base Script Properties

Open:

```text
<WEB_APP_URL>?page=setup
```

Set/test the required base configuration:

- SHEET_ID
- DRIVE_FOLDER_ID
- VISION_API_KEY
- GOOGLE_API_KEY
- DISCOGS_TOKEN

Secrets stay in Script Properties.

## 4. eBay Sandbox

In eBay Developer:

1. Use/create **Sandbox** application keys.
2. Prepare App ID / Cert ID / RuName.
3. Put the deployed Web App URL into the RuName `Auth Accepted URL`.
4. In Reuse OS setup set `EBAY_ENV=sandbox`.
5. Save App ID / Cert ID / RuName.
6. Press `eBayと接続` and complete browser OAuth.

Sandbox keys and Production keys are separate. Never substitute Production credentials for this gate.

## 5. Read-only preflight

Open:

```text
<WEB_APP_URL>?page=phase1
```

Required result:

```text
PASS
READY_FOR_EXPLICIT_E2E_RUN
```

Expected checks:

- core_config PASS
- ebay_env PASS and environment=sandbox
- ebay_app PASS
- ebay_oauth PASS
- production_gate PASS because Sandbox does not require Production confirmation

If any item is red, return to `?page=setup` and fix only that item.

## 6. One-item Sandbox E2E

Only after the read-only preflight is fully green, select one harmless test item and run the explicit Phase 1 E2E path.

Target readback chain:

```text
Hunter
  -> Inventory
  -> eBay Sandbox Listing
  -> Sale Detection / test event
  -> RESERVED
  -> stop other channels where applicable
  -> verify
  -> SOLD / SYNCED
```

No Production listing belongs in this step.

## 7. PASS evidence

Record at minimum:

- branch + commit SHA
- Web App deployment version/date, but no secret values
- preflight result and blocker count
- test SKU / non-sensitive item identifier
- listing create result
- inventory state transition
- SOLD event idempotency readback
- stop/verify result per channel
- final SOLD / SYNCED or explicit PARTIAL / MANUAL state
- external API call count / failures

## 8. Phase 1 FIX gate

Phase 1 is not FIX until real Sandbox E2E evidence is reviewed. Production one-item E2E is a separate explicit gate after Sandbox PASS.
