# ADR-0001: Full catalog from Oda public API at build time (sitemap-driven)

**Status:** revised v2 — scope changed from curated sample to FULL assortment · **Date:** 2026-08-06

## Context

The store must contain **the full Oda assortment** with names, descriptions, prices, images, and — new requirement — **category and storage information** so products can be placed realistically (cold → fridges, frozen → freezers, snacks together, drinks together).

Findings from probing:

- **MCP server**: no image URLs, no descriptions, no category browse, 20 items/page, unreachable from a browser app at runtime. Not usable as catalog source; it *is* the right channel for acting on the user's real cart (see ADR-0003).
- **Public API**: `oda.com/api/v1/products/{id}/` returns everything needed:
  - `images[]` (CDN URLs + dimensions), `detailed_info.local[].description_from_supplier`
  - `categories[]` with **full parent paths** (e.g. "Meieri, ost og egg → Melk → Lettmelk") — the placement taxonomy
  - `client_classifiers[]` — includes storage flags like **"Frysevare"** (frozen) and chilled/expiry markers — the fixture-type signal
  - price, unit price, availability, brand
- **Enumeration**: `oda.com/sitemap.xml` → 7 product sitemaps → **6,868 product IDs** (100 % coverage; keyword search would sample arbitrarily). Also 814 category URLs (45 top-level, several of which are thematic overlays like "Bestselgere" that must not be used as placement zones).
- Search endpoint (`/api/v1/search/`) exists but caps and biases coverage — used in v1 of this ADR, superseded.

## Decision

Build-time pipeline (`scripts/fetch_catalog.py`), one deliberate refresh command, output committed as a snapshot:

1. **Enumerate** all product IDs from the sitemap (6,868 today; discontinued IDs 404 and are dropped).
2. **Fetch** per-product detail JSON (threaded, retry ×3, polite). Keep: id, names, brand, price, unit price, availability, `categories` (full path), `client_classifiers`, description, first image URL + dimensions.
3. **Download** one thumbnail per product (~300 px, ~13 kB each, ≈ 90 MB total) — raw material for the texture pipeline (atlas building is ADR-0002's concern; aspect ratios validated/clamped here, warning outside [0.4, 2.5]). Image downloads are hardened separately from the API fetch: the CDN (`images.oda.com`) gets its own throttle, resume via existing-file check + content-length validation, and retry.
4. **Emit** `catalog.json` with snapshot metadata: `{ fetchedAt, currency: "NOK", schemaVersion, source, products: [...] }` — split into **catalog-lite** (id, name, brand, price, category path; startup-blocking) and a **descriptions chunk** fetched lazily on first detail-panel open (ADR-0002's loading budget). Real Oda `product_id` preserved end-to-end (the MCP cart handoff operates on IDs — ADR-0003).

The app is fully static after the pipeline runs. Runtime browser fetching of oda.com was rejected (CORS, per-visitor load); MCP as catalog source rejected (capabilities above).

## Consequences

- (+) True "all products", with the taxonomy + storage flags that drive realistic placement (ADR-0005).
- (+) Static, offline-capable app; IDs preserved for the real-cart handoff; snapshot age surfaceable in the UI ("prices as of <date>").
- (−) Snapshot staleness: prices/availability drift until refresh; the MCP handoff therefore includes a reconciliation step (ADR-0003).
- (−) ~7 k requests + 90 MB images per refresh — a deliberate, occasional operation, never part of `npm run build`.
- (−) Unofficial API; endpoints may change. Section assignment is deterministic (derived from each product's own primary category path, not search-result order).
- (−) Licensing: Oda's product photos must not ship in a public deployment without permission — personal/local demo use only; keep `public/img/` out of any public repo.
