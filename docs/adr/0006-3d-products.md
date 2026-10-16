# ADR-0006: 3D products instead of flat cards

**Status:** accepted · **Date:** 2026-10-16

## Context

Products were flat photo cards (ADR-0002). The packing-line simulation (andeplane/groceries-manufacturing) now has 35 procedural packaging meshes (can, PET bottle, gable carton, pillow bag, tray, …) built from the OpenAI Decisions API classification of every product, scaled to real outer dimensions and printed with the product photo. The store should show the same products.

## Decision

- **Shared models.** `src/products3d/` is a verbatim copy of the simulation's module (geometry, material, instanced layer). Change it there first and copy it back; the store only *extends* the material (detail tiles, hover tint, label glow) by patching shader strings, and fails loudly if the shared shader no longer contains the patched lines.
- **Data.** `public/products3d.json` (`scripts/build_products3d.py`) holds per product: packaging type, outer w×h×d in cm and package colour, keyed by id and bound to the catalog hash like `layout.json` and `atlas-index.json`.
- **Placement.** Each slot holds the product at real size on its board, shrunk only when it does not fit the slot (≈60 of 5,185). Narrow products get up to 3 side-by-side facings, shallow ones up to 3 rows back, with tiny deterministic jitter.
- **Textures.** The six base atlases are combined into one texture (6144×4096; 3072×2048 on phones) so one material serves all products. Labels switch to the streamed 256 px tile when the residency manager (ADR-0002 detail tier) gives the product a slot.
- **Level of detail.** Instances are re-bucketed when the viewer moves 0.75 m: all rows within `nearRadius`, front rows only within `farRadius`, and a low-poly box with the photo beyond. Desktop 7 m / 22 m, Quest and phones 2.5 m / 9 m with at most 2×2 copies per slot. Shared meshes are indexed at load. Draw calls: 36 for all products.
- **Lighting.** Products use the lit standard material with a RoomEnvironment reflection map on the product material only, plus 35 % self-illumination on labels so studio-lit packshots keep their brightness under `NoToneMapping`.
- **Interaction unchanged.** Picking and grabs still use one proxy AABB per slot (around the front facings). In VR the grabbed item is the 3D product with its sharp tile.

## Consequences

- (+) Shelves read as a real store; the store and the simulation share one product model.
- (−) Far more triangles than cards; the LOD radii are the knob if Quest drops frames.
- (−) The combined atlas needs a 6144 px texture for full-resolution far labels; smaller GPUs get half-resolution tiles.
