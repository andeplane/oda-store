# ADR-0005: Product placement and floor plan

**Status:** revised v2 after second-round review (F1–F13 applied) · **Date:** 2026-08-06

## Context

The full assortment (~6.4–6.9 k products) must be laid out like a real supermarket: cold goods in fridges, frozen in freezers, snacks together, drinks together, produce up front. Data per product (ADR-0001): full category paths and classifiers. **Measured facts** (2.6 k-product sample; final counts stamped by the pipeline):

- There is **no explicit "Kjølevare" classifier** — chilled must be inferred (rules below).
- `Frysevare` (frozen) ≈ 6 % ⇒ ~414 products ⇒ **~32 m freezer face** at 13/m (a 16 m double-sided freezer aisle).
- `Holdbarhetsgaranti i N dager` coverage per top-level: Kylling og kjøtt 61 %, Grill 46 %, Meieri 19 %, **Frukt og grønt 18 %**, Iskrem/dessert 4 %, Pålegg 4 %, Bakeri 1 % — so it must NOT blanket-imply "fridge" (fresh bread and salads would land in multidecks).
- Meieri level-2 subpaths include ambient lines: Plantebaserte drikker, and Egg (chilled-by-rule is wrong for Norwegian stores).

## Decision

### Fixture assignment (deterministic, rule-ordered, list-driven)

Rules evaluate in order; all lists are explicit constants in the generator; **an unmapped top-level is a generator error**, never a silent fall-through.

1. `Frysevare` classifier → **freezer** (frozen aisle), regardless of category.
2. Top-level ∈ {Bakeri og konditori, Frukt og grønt, Blomster og planter} → **zone-native fixture** (bakery shelf / produce table), *ignoring* Holdbarhetsgaranti — except an explicit chilled-subpath **allowlist** (e.g. "Ferdigkuttet og salater" → the produce low fridge).
3. Top-level ∈ {Meieri ost og egg, Kylling og kjøtt, Fisk og sjømat} → **multideck fridge**, minus an ambient-subpath **denylist** (Plantebaserte drikker, Egg, UHT/langtidsholdbar melk, tørrmelk → shelf/end-cap in the same zone).
4. Any `Holdbarhetsgaranti` classifier elsewhere → **fridge bay in the owning zone** (every zone with ≥ 1 chilled product automatically gets a fridge bay emitted — including Drikke and Kiosk).
5. Everything else → **gondola/wall shelf** in its zone.

**Primary path (defined):** the first path in the API's `categories[]` order whose top-level is not in the maintained **overlay list** (Bestselgere, Økologisk hos Oda, Faste kupp, Påfyll til hverdagen, …). A product with zero non-overlay paths is a generator error surfaced in the report. Within a zone, products sort by full primary path, then product ID — subcategory clusters ("the melk shelf") emerge from sorting; deterministic across refreshes. Products that 404 mid-refresh are dropped and the layout reflows.

### Zones

| Zone | Top-level categories | Fixtures |
|---|---|---|
| Frukt & grønt | Frukt og grønt, Blomster og planter | produce tables + low fridge (allowlist) |
| Bakeri | Bakeri og konditori | bakery shelves, corner |
| Kjøtt & fisk | Kylling og kjøtt, Fisk og sjømat, Grill (fresh share via rule 4) | fridge wall |
| Meieri & egg | Meieri, ost og egg | fridge wall + ambient end-cap (denylist) |
| Pålegg | Pålegg | fridge bay + shelf |
| Middag & tilbehør | Middager og tilbehør, Grill (ambient share) | dry aisles + refrigerated island runs |
| Tørrvarer & frokost | Bakeingredienser, Frokostblandinger og müsli | dry aisles |
| Frossen | (rule 1, any category) | freezer aisle, clustered by source zone |
| Drikke | Drikke | drinks aisles + chilled bay |
| Snacks & søtt | Sjokolade snacks og godteri, Iskrem dessert og kjeks (non-frozen) | snacks aisles |
| Hjem & helse | Hus og hjem, Hygiene og skjønnhet, Legemidler, Trening, Baby og barn, Dyr | non-food aisles |
| Kiosk & diverse | Mathall, Restaurant, Bursdag, books/games/snus/misc | corner display (+fridge bay if rule 4 fires) |

### Capacity model (single source of truth — ADR-0002 cites these numbers)

- **Card slot box: ≤ 0.28 m wide × 0.34 m tall** (contain-fit, aspect clamped [0.4, 2.5]); horizontal pitch **0.31 m**; **5 levels** on a 2.1 m fixture (0.42 m level pitch: 0.34 m card + board + clearance) ⇒ **16 products/m** of shelf/fridge face; freezer 13/m; produce table ~8/m². One facing per product is the capacity default; a "2 facings where slack exists" pass fills leftover run length within a zone (visual density lever — flagged as an open question).
- Demand at 6.9 k ⇒ **~430 m face**. Chilled demand (rules 3–4 at measured rates: dairy+meat+fish ≈ 1.2 k, plus chilled shares of Pålegg/Middag/Grill/produce) ≈ **1.8–2.2 k products ⇒ ~110–140 m of fridge face** — roughly 2× the back+right perimeter. Supply therefore includes **refrigerated island runs** (fridge-backed gondola rows) in Middag, plus perimeter fridge on back + right + part of left wall. The generator emits however many gondolas the residual dry demand needs (**≥ 9** double-sided 20 m rows at current counts — derived, not fixed).
- Hall ≈ **46 × 30 m** (recomputed by the generator from actual counts; ADR-0002 must cite, not restate). Aisles ≥ 3 m. Produce + bakery + entrance + checkout share the front strip; the front zone is covered by the no-overlap test explicitly.

### Floor plan — generated, not hand-drawn

`scripts/build_layout.py` consumes `(zone → chilled/ambient/frozen counts)` and emits **`layout.json`**:

- **Store shell & anchors**: hall dimensions, walls, entrance position/orientation, checkout area, player spawn (loading UX prioritizes entrance-nearest detail tiles — ADR-0002).
- **Fixture runs**: type, zone, position, **yaw/facing normal**, length; double-sided gondolas as two faces with separate slot lists.
- **Slots**: `(level, index, productId)` per face, resolved to local offsets via a **versioned fixture-kit registry** (level heights, pitch, depth per fixture type) that also drives the proxy-box grid and collision AABBs — one source of geometry truth, never re-hardcoded in the renderer.
- **Produce tables**: 2-D grid slot variant (m²-based).
- **Signage payload**: zone display names, aisle-end sign text + positions, entrance directory board content.
- **Schema linkage**: `schemaVersion` + the catalog's `fetchedAt`/hash; the renderer refuses mismatched snapshots; every slot's product ID must exist in catalog.json (validated).

### Placement acceptance (phase-1 gate, per review F11)

- **Golden-sample unit tests**: frozen pizza → freezer; lettmelk → Meieri fridge; knekkebrød → shelf; ferskt brød → bakery shelf; plantebasert drikke → ambient; salatmiks → produce fridge.
- **Oddities report** for owner eyeballing: every Holdbarhetsgaranti product placed outside a fridge (and vice versa), counts per rule fired, fixture-type utilization per zone, unmapped/zero-path errors.
- Geometry tests: no overflow, no overlap (including front strip), aisle minimums.

### Wayfinding (load-bearing at this scale — promoted from polish to phase 3)

Zone signs + aisle-end signs + entrance directory board ship **with the store scene**, not in polish; desktop keeps ~3 m/s walk with sprint. (VR wrist-menu zone-jump for hands-only users is noted as v2 in ADR-0004.)

## Alternatives considered

- **Hand-authored floor plan** — untenable at 6.9 k slots; breaks on refresh.
- **Blanket Holdbarhetsgaranti → fridge** (v1 rule) — rejected by review + data: puts fresh bread and 18 % of produce in multidecks.
- **Frozen distributed per zone** — doubles fixture kinds per zone; single frozen aisle is standard Norwegian practice.
- **Keyword-search zones** (v0) — nondeterministic; superseded.

## Consequences

- (+) Realistic placement falls out of data + explicit lists; refresh re-flows the store; correctness is unit-tested before any 3D exists.
- (+) Fixture geometry, proxies, and collisions share one registry.
- (−) Allow/deny lists need occasional curation as Oda's taxonomy drifts (surfaced by the oddities report, not silent).
- (−) Eggs shelved at the dairy end-cap (ambient, Norwegian convention) — deliberate, noted.
- (−) Hall is big (~1,380 m² — smaller than a real 6.9 k-SKU store); wayfinding is therefore a phase-3 deliverable, and wall-clock traversal is part of the fantasy.
