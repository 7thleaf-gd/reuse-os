# Reuse OS Version Lock

## Frozen baseline

- Version: `v0.0`
- Frozen branch: `frozen/v0.0`
- Frozen commit: `9f7d371dc22b0d3ed2814d24ed1eb85bf3d4530e`
- Frozen at: 2026-08-19 JST

This commit is the reference instrument for the pre-v0.1 system.

## Development rule

All new implementation after the freeze must live outside `frozen/v0.0`.

Current development branch:

- `agent/reuse-os-v0.1-e2e`

The v0.1 goal is to make the existing Hunter → Inventory → eBay Listing → Sale Detection / RESERVED → stop → verify → SOLD / SYNCED path safe to run with one real item.

Do not rewrite the frozen branch for convenience. If the new design needs a change, make it on a development branch and keep the frozen baseline readable for comparison and rollback.