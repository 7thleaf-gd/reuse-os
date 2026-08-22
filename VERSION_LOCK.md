# Reuse OS Version Lock

## Frozen reference

- version: `v0.0`
- branch: `frozen/v0.0`
- commit: `9f7d371dc22b0d3ed2814d24ed1eb85bf3d4530e`
- policy: immutable reference instrument; do not develop on this branch

## Active development line

- version: `v0.1`
- branch: `agent/reuse-os-v0.1-e2e`
- PR: `#1`
- goal: Phase 1 Sandbox one-item E2E through readback

## Current verified state

As of 2026-08-23 JST:

- v0.0 frozen branch remains the immutable reference point.
- v0.1 includes a read-only Phase 1 preflight and `?page=phase1` readiness page.
- Production one-item execution remains fail-closed behind explicit confirmation.
- `npm run morning` provides the 10-minute human gate for local Apps Script binding, local verification, `clasp status`, explicit `PUSH`, source push, and browser handoff.
- the morning launcher does not deploy, enter secrets, perform OAuth, create listings, or touch Production automatically.
- latest GitHub Actions verify on the current development head passes, including the morning launcher safety contract.
- external API communication in CI remains 0.

## Remaining human gate before Sandbox E2E

1. run `npm run morning` from the local v0.1 checkout;
2. bind the intended Apps Script `scriptId` locally if still unset;
3. inspect `clasp status` and type `PUSH` only when the target is correct;
4. deploy the Apps Script Web App as yourself / only yourself;
5. set/test base Script Properties through `?page=setup`;
6. configure eBay Sandbox App ID / Cert ID / RuName and Auth Accepted URL;
7. complete browser OAuth;
8. require `?page=phase1` to show PASS before any Sandbox item run.

Production remains a later, separate explicit gate after Sandbox evidence is reviewed.
