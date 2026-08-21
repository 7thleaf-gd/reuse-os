# Reuse OS Version Lock

## v0.0 Frozen Baseline

- Frozen branch: `frozen/v0.0`
- Frozen commit: `9f7d371dc22b0d3ed2814d24ed1eb85bf3d4530e`
- Purpose: preserve the pre-v0.1 reference instrument exactly as it existed when active development began.
- Rule: do not develop on this branch. Compare/readback only.

## v0.1 Development Line

- Branch: `agent/reuse-os-v0.1-e2e`
- Draft PR: `#1`
- Phase 1 E2E preflight is read-only and fail-closed.
- Production remains blocked unless the explicit one-item confirmation token is supplied by a future explicit runner.

### 2026-08-21 verified state

- Added read-only `?page=phase1` readiness panel.
- Added `PHASE1_RUNBOOK.md` for local binding → deploy → Sandbox OAuth → one-item E2E.
- `.clasp.json` push order includes `src/phase1-e2e-preflight.gs` while the tracked scriptId remains a placeholder.
- GitHub Actions `verify` PASS on v0.1 head.
- 8 test suites PASS, including Phase 1 page safety contract.
- SOLD State Machine remains 11/11 PASS.
- External API calls during CI/test path: 0.
- Human gate now starts at local Apps Script `scriptId` binding, then `clasp push`, owner-only Web App deploy, Script Properties, eBay Sandbox app/RuName and browser OAuth.

## Merge Gate

Do not merge v0.1 to `main` until the real Sandbox one-item E2E and readback are completed and reviewed.
