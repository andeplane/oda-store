# Oda Virtual Store — Plan (v2)

## Goal

A walkable, visually appealing 3D supermarket in the browser, stocked with **Oda's full real assortment**, ending in VR with hand tracking:

1. Fetch **all** products, descriptions and images
2. Virtual shop laid out as a physical store — cold goods in fridges, frozen in freezers, snacks together, drinks together
3. First-person walking
4. Center aim reticle; pointing at a product for 0.5 s opens its details
5. **A** adds the product to a shopping cart
6. VR with hand tracking: pick products off the shelf, put them in the cart

Stack: three.js + TypeScript + Vite. Process: **plan → agent review → approved → code** (no code before approval).

## Status of this plan

**Approved for implementation** after two agent-review rounds. Round 1 (three reviewers, v1 docs): approve-with-changes → all must-fixes folded into v2. Round 2 (three fresh reviewers, v2 docs): approve-with-changes with docs-only fixes — every must-fix (Holdbarhetsgaranti rule overreach, ~2× fridge under-provisioning, slot-pitch contradiction, atlas gutter/mip spec, detail-cache upload path, sticky-switch rewrite, cart-as-drop-target, third deviation disclosure, layout.json contract gaps) is applied in the v3 ADRs below.

**Disclosed spec deviations** (all interaction-quality driven, see ADR-0003/0004): ① 4.5 m aim range; ② A adds while the detail panel is open (opens 0.5 s after aiming) and strafes otherwise; ③ dwell holds its fill above ~1.5 m/s movement.

## The data (measured, not assumed)

- Sitemap enumeration: **6,868 product IDs** (some 404 → expect ~6.4–6.6 k live), 814 categories (45 top-level).
- Per product: full category path ("Meieri, ost og egg → Melk → Lettmelk"), classifiers (**Frysevare** = frozen ~6 %, **Holdbarhetsgaranti** = fresh/chilled), supplier description, price/unit price, ~300 px image (~13 kB → ~90 MB total).
- Fetch is throttled (~2 req/s, 429-backoff, resumable) — a deliberate refresh operation, not a build step. *(Full fetch running now; final zone counts get stamped into the pipeline output.)*

## Decisions (ADRs)

| ADR | Decision | Status |
|---|---|---|
| [0001](adr/0001-product-data-source.md) | Full catalog via sitemap + public API at build time; MCP only for real-cart handoff; snapshot metadata; licensing note | v3, review-approved |
| [0002](adr/0002-rendering-architecture.md) | Two-tier texture residency (ETC1S base atlases w/ gutters + streamed detail cache via `copyTextureToTexture`) + 7 InstancedMeshes + unlit shader → <100 draw calls, ~130 MB GPU, 5–10 MB startup transfer | v3, review-approved |
| [0003](adr/0003-interaction-and-cart.md) | Dwell keyed by product ID, resume-grace, two-rule sticky targeting; A adds only while panel open (`!repeat`), X decrements; pointerlock-loss cart mode; ID-based export → MCP reconciliation | v3, review-approved |
| [0004](adr/0004-vr-hand-tracking.md) | r170-verified WebXR: explicit `hand-tracking` feature, vendored assets, thumb/index-midpoint pinch, damped world-space holds, grab proxies, hip basket **and** cart as drop targets, snap turn, secure-context recipe | v3, review-approved |
| [0005](adr/0005-placement-and-floor-plan.md) | Rule-ordered placement with allow/deny lists (no blanket chilled rule), defined primary path, capacity model incl. refrigerated islands, layout.json full contract, golden-sample tests + oddities report | v3, review-approved |

## Architecture

```
scripts/
  fetch_catalog.py   sitemap → details → images → catalog.json (throttled, resumable)
  build_atlases.py   thumbnails → base atlases (KTX2 + PNG fallback) + atlas index
  build_layout.py    catalog → zones → fixtures → layout.json  (pure, unit-testable)
public/
  catalog.json  atlas/*.ktx2  img/*.jpg (detail tiles)  layout.json  hands/*.glb
src/
  data.ts        catalog/layout loading + types
  residency.ts   detail-tile priority queue + cache-atlas uploads (≤2/frame)
  cards.ts       InstancedMesh product cards + unlit shader + proxy-box spatial grid
  fixtures.ts    fixture kits (shelf/fridge/freezer/produce) + store shell
  player.ts      pointer-lock walk, collision vs fixture AABBs
  interact.ts    reticle raycast vs proxies, dwell/grace/sticky, detail panel
  cart.ts        cart state, HUD, Esc cart-mode, export ("Copy cart for Claude")
  vr.ts          XR session, hands/controllers, grab, hip basket, locomotion
  main.ts        bootstrap, loading UX, render loop
```

The **proxy-box spatial grid** is the shared interaction contract: desktop rays and VR pinch queries both hit proxies (never instanced triangles), scoped per shelf cell.

## Phases & gates

| # | Phase | Gate to pass |
|---|---|---|
| 0 | Plan re-review (agents) | all reviewers approve |
| 1 | Data pipeline: full fetch, atlases, layout generator | layout unit tests green (incl. golden-sample placement + oddities report); atlas sizes within ADR-0002 budget |
| 2 | **Rendering core (the technical risk, built first)**: instanced cards + residency on a dummy grid | 6.9 k cards at 60 fps desktop **and 72 Hz in Quest browser / Immersive Web Emulator**; drawcalls <100; no upload jank |
| 3 | Store: fixtures, zones, lighting, walk + collision, **wayfinding (zone/aisle signs + entrance directory — load-bearing at this scale)** | walkthrough smoke test (agent-browser screenshots), spec pt 2–3 |
| 4 | Interactions: dwell details + A/X cart | spec pt 4–5 per ADR-0003; keyboard-only correction path works; cart-mode round trip works |
| 5 | VR: hands, grab, basket + cart drop targets, locomotion, **drop-confirm audio** | Quest (or emulator): 72 Hz, grab→basket→cart-add works on both targets |
| 6 | Polish: loading UX refinements, ambient sound, white-matte card experiments, cart export → MCP handoff recipe | end-to-end: browse → cart → chat sync → checkout URL |

Verification per phase: `tsc` clean, `vite build` clean, runtime smoke via agent-browser (console errors, screenshots), stats overlay for frame time/draw calls/GPU mem estimate.

## Risks

1. **Residency/atlas shader** — the one genuinely hard component; built first (phase 2) on a dummy scene so failure is cheap and visible early.
2. **Rate limiting** during refresh — throttled fetcher with backoff; snapshot committed so refreshes are rare.
3. **Quest performance** — budgets are designed-in (ADR-0002/0004); emulator testing before device testing.
4. **KTX2 toolchain** (`toktx`) — PNG fallback path if unavailable (desktop fine, Quest degraded).
5. **Image licensing** — local/personal demo only; `public/img/` never pushed to a public repo.

## Open questions for the owner (non-blocking, defaults chosen)

1. Full assortment includes non-food oddities (books, snus, birthday supplies) — kept in a small "kiosk" corner. OK? *(default: yes)*
2. A-key adds only while the detail panel is open (0.5 s after aiming) — the review-recommended reading of spec pt 5. OK? *(default: yes)*
3. Desktop-only + VR; no mobile/touch fallback in v1 beyond a friendly message. OK? *(default: yes)*
4. **One facing per product** is the capacity default (a second facing fills leftover run slack) — the single biggest visual-density lever. OK? *(default: yes)*
5. VR corrections are v1-limited to "fix it in desktop cart mode afterwards". OK? *(default: yes)*
