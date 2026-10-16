# ADR-0002: Rendering architecture for ~6.9k products

**Status:** revised v3 after second-round review (all must-fix findings applied) · **Date:** 2026-08-06 · flat cards superseded by 3D products in ADR-0006 (texture tiers, proxies and residency still apply)

## Context

The full assortment (~6.4–6.9 k products) must be on display, each with its own photo, at 60 fps desktop and 72 Hz Quest browser. Ceilings: Quest draw calls ~100–200; Quest tab killed near ~1 GB GPU memory; thousands of synchronous texture uploads freeze the main thread. Per-product meshes/textures are impossible at this scale. This ADR is foundational for desktop *and* VR.

**Card geometry is owned by ADR-0005** (single source of truth): slot box **≤ 0.28 m wide × 0.34 m tall**, 0.31 m pitch, 5 levels, aspect clamped [0.4, 2.5]. Hall dimensions likewise come from ADR-0005's generator. This ADR cites, never restates.

## Decision

**Two-tier texture residency + instanced cards.**

### Base tier (always resident, every product)

- 64 px tiles in 2048² atlases → 1024 tiles/atlas → **7 atlases** (~300 spare slots).
- **Tile packing spec (mip-bleed control):** contain-fit each product onto a **uniform background color**, content **56×56** inside the 64 cell (**4 px gutter**, edge-extended; 56 and 4 are 4×4-block aligned), per-instance UVs clamped to the content rect. Anisotropy on card atlases **1–2 only** (higher worsens cross-tile fetch at grazing angles; the gutter is the real defense).
- **KTX2 with ETC1S supercompression**: ~5.6 MB/atlas GPU (8 bpp + mips) → **~40 MB GPU**; disk/transfer ~0.3–1 MB/atlas → **~5–10 MB download**. Transcode (~1–2 s on Quest CPU) runs in a worker behind the loading screen; Basis transcoder wasm/js **vendored locally** (`setTranscoderPath`), `detectSupport(renderer)` per device. Encoder: pinned official KTX-Software (or `basisu`) macOS arm64 release — not assumed from homebrew. **PNG fallback** if toolchain unavailable: ~156 MB GPU (desktop fine; Quest ~178 MB total — survivable, degraded, stated).
- Optional halving (nice-to-have): cards are opaque → RGB-only base format ≈ 20 MB.

### Detail tier (streamed, near products only)

- One 4096² **cache atlas**, 256 slots of 256² (Quest: 2048², 64 slots). **Immutable storage with a short mip chain (256→16); uploads go per-level via `renderer.copyTextureToTexture(src, dst, srcRegion, dstPosition, level)`** (r165+ signature) from pre-downscaled `ImageBitmap`s — slots are power-of-two aligned so per-level writes are clean; never `generateMipmap` on the whole cache (several ms per call — kills the budget). Same 4 px gutter logic per slot.
- Priority queue: distance + frustum with strong hysteresis (no slot thrash). Desktop radius ~6–8 m; **Quest radius ~2.5–3 m** (64 slots ≈ 4 m of shelf face at 16/m — the budget, not the wish, sets the radius). ≤ 2 uploads/frame steady-state; **burst 8–16/frame while the loading screen still covers the scene** (cold-filling 256 slots at 2/frame is ~2 s of visible pop-in otherwise).
- **V-orientation convention baked at build time** (one flipY convention across KTX2 `CompressedTexture` (flipY=false) and ImageBitmap tiles via `imageOrientation`), documented in the atlas index — else detail pop-in shows upside-down products.
- **Perceptual math (honest version):** desktop 1080p/50° FOV: a 0.28 m card covers ~95 px at 3 m — the base tile is ~1.5–2× magnified inside ~4.5 m; texel:pixel parity ≈ 5–5.5 m (Quest ~20 px/deg: parity ≈ 5 m). The desktop detail radius covers the magnified zone; **Quest accepts mildly soft product faces between ~3–5 m** — a stated trade, not an oversight.
- Dedupe shared packshots (flavor variants reuse images) — fewer tiles, less traffic (nice-to-have).

### Geometry & materials

- All cards in **7 `InstancedMesh`es** (one per base atlas, unit quad) with per-instance attributes: transform, base UV rect, detail-slot index (−1 = base), highlight tint. **7 material instances** of one custom **unlit** `ShaderMaterial` (per-atlas uniform; vertex shader applies `instanceMatrix` itself). Instance attributes: `InstancedBufferAttribute` + `DynamicDrawUsage` + `addUpdateRange`. **`frustumCulled = false`** on all 7 (their bounds span the hall; culling is per-mesh).
- Unlit by design: packshots are studio-lit; relighting double-shades. `SRGBColorSpace` everywhere, `NoToneMapping`.
- Slight per-card yaw/scale jitter (±3°/±2 %); facings-touching merchandising per ADR-0005.
- Draw calls: 7 (cards) + fixtures (shared materials, merged; signs atlased into 1–2 canvas textures rather than 20–30 individual draws) ≈ **well under 100**.
- Picking/grabs never touch instanced triangles: **proxy boxes** in a spatial grid keyed by shelf cell (contract shared with ADR-0003/0004), derived from the fixture-kit registry (ADR-0005).

### Atlas index & determinism

`atlas-index.json`: `productId → { atlas, uvRect, contentRect }` (contentRect also feeds aspect-correct contain-fit). Products sorted by ID before packing → refreshes keep coordinates stable (cacheable, diffable). `schemaVersion` + catalog `fetchedAt` hash links index ↔ catalog ↔ layout (ADR-0005).

### Fixtures & scene

Fixture kits per ADR-0005; hemisphere + 2 directionals for fixtures only; no shadow maps (dark plinths + floor gradient); fog for depth. **Fridge/freezer "glass" is non-occluding set dressing — proxies are the only interaction geometry** (stated decision, see ADR-0003/0004).

### Loading UX (transfer budget, not GPU budget)

Blocks on: **catalog-lite** (id, name, brand, price, path — descriptions split into a lazily-fetched chunk loaded on first panel-open; full catalog would be 4–10 MB raw) + `layout.json` (~0.5 MB) + 7 ETC1S atlases (5–10 MB) + entrance-nearest detail tiles. **Interactive < 5 s on broadband with real headroom.** Everything else streams.

## Alternatives considered

- Per-product meshes/textures (v1) — 7 k draws, ~2.5 GB; dead.
- 256² texture arrays for all — ~600 MB compressed; rejected.
- `BatchedMesh` — viable, unneeded (single shared quad → instancing is simpler).
- UASTC supercompression — 4× transfer for quality 64 px tiles don't need; ETC1S chosen.
- White-matte cutout cards — biggest visual upgrade, risky on white products; deferred to polish with white-card fallback.

## Consequences

- (+) Whole assortment ≈ 130 MB GPU (KTX2 path) and <100 draw calls on one architecture for desktop + Quest; 5–10 MB startup transfer.
- (+) Scales ~+1 atlas per +1 k products; stable across refreshes.
- (−) Residency manager + custom shader is the project's hard component — built first (phase 2) on a dummy grid, with the Quest/emulator 72 Hz check in the same gate.
- (−) KTX2 toolchain dependency (pinned release); PNG fallback degrades Quest headroom.
- (−) Quest shows softer product faces at 3–5 m (disclosed above).
