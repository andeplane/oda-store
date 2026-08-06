# ADR-0003: Interaction model and cart

**Status:** revised v3 after second-round review (sticky-switch rewrite, third deviation disclosed, cart-mode round trip specified) · **Date:** 2026-08-06

## Context

Spec: center aim; pointing at a product 0.5 s opens details; **A** adds to cart. A is also the conventional WASD strafe-left key; the desktop HUD lives under pointer lock (no cursor); and the real Oda cart is only reachable via the MCP server in a chat session.

## Decision

### Aim & dwell

- A raycast from screen center every frame, max **4.5 m**, against per-product **proxy boxes** (card size × ~8 cm depth — shared with the VR grab query, see ADR-0004), scoped per shelf cell so the ray can't select through a board.
- **All hover/dwell/panel state is keyed by product ID, never by mesh/facing.** Crossing between facings of the same product is a no-op.
- Hovering shows an instant name+price label and a reticle progress ring; after **0.5 s on the same product ID** the detail panel opens.
- **One grace rule for both phases (0.35 s):** slipping off during the dwell fill *pauses* the timer and resumes if the same product is re-hit within the grace window; the open panel similarly survives slips ≤ 0.35 s. Ring decays only after grace expires.
- **Sticky targeting (two separate rules — inflation never decides switching):**
  - *Target loss:* the current target is kept while the ray hits nothing but still clips its ~15 %-inflated bounds (hand jitter). Loss occurs when the ray leaves even the inflated bounds for > grace.
  - *Target switch:* the closest proxy hit differs from the current target **continuously for ≥ 80 ms** (the same 80 ms doubles as label hysteresis). This avoids the oblique-angle bug where a ray aimed at product B still clips A's inflated box on the way and A never releases. The panel-close condition uses the same loss rule, never the inflation test alone.
- **Dwell slows at speed:** above ~1.5 m/s translational speed the ring holds its fill; below that (including slow strafe-browsing along a shelf) dwell fills normally. **This is a third disclosed spec deviation** — at full run "0.5 s of pointing" alone won't open the panel; slow down or stop and it does.
- Hovered product gets a visible highlight (emissive tint/slight pop) so it's clear which card the ray hit. Products beyond 4.5 m show a dimmed reticle state (a conscious deviation from the spec's uncapped "pointing"; noted openly).
- **Panel placement:** the side is chosen **once at panel-open** from the sign of the proxy-center's screen-x offset (default **right** when |offset| < ε) and never re-evaluated while open — a center-aimed product would otherwise coin-flip sides per neighbor. The panel never occludes the reticle. Close condition is the sticky *loss* rule above, *not* "reticle entered the panel area".

### A key (and its conflict with WASD)

- **A adds to cart only while the detail panel is open**; otherwise A strafes left (Q/arrows always strafe). The panel opens within 0.5 s of aiming, so the spec's point→details→press-A flow is preserved; the gate prevents "A never strafes" while scanning along a shelf, where something is hovered almost 100 % of the time. *(Interpretation of spec point 5 — flagged as an open question for the user.)*
- Add fires on `keydown` with `event.repeat === false` only: one press = one add. A key already held for strafing when the panel opens **stays strafe until released**; symmetrically, an A held after an add does nothing further until released (edge-triggered). The HUD hint surfaces "Q/← always strafe" since A is repurposed whenever a panel is open.
- **X decrements** the panel product's quantity (the one-keystroke undo for accidental adds). The panel shows "A +1 / X −1".

### Cart

- Cart state: one line per product ID with quantity (adding an existing product increments qty — never duplicate lines), running total, snapshot-price disclaimer ("prices as of <fetchedAt>").
- HUD panel top-right; **C** collapses/expands; empty state shows "Aim at a product and press A" (doubles as the tutorial). Rapid adds coalesce into one toast ("Tine Melk ×3").
- Pointer lock makes DOM clicking impossible, so v1's correction path is keyboard-only (A/X on the open panel). **Cart mode is the handler for any `pointerlockchange` → unlocked transition** (Esc, alt-tab, whatever): the HUD becomes a normal clickable panel with per-line −/+/remove and the export button; the open detail panel and any partial dwell are reset on the transition. A **"Resume shopping"** button re-requests pointer lock and must tolerate Chrome's ~1.3 s re-acquisition cooldown after an Esc exit (disabled state/retry, not silent failure).
- **Export contract** (button in cart mode: "Copy cart for Claude", clipboard needs the user gesture available there): `{ fetchedAt, currency: "NOK", lines: [{ product_id, name, quantity, unit_price_at_fetch }] }` plus a ready-made one-line prompt ("Add these to my Oda cart: …"). `product_id` is the real Oda ID (preserved end-to-end from the fetch pipeline) — `manipulate_cart` operates on IDs, never name matching.

### Real-cart handoff (MCP, in chat)

Runs in the Claude session, not the app: paste the export → `manipulate_cart` per line by product ID → **reconciliation report** (per-item success, out-of-stock, price drift vs `unit_price_at_fetch`; quantity is authoritative, snapshot price advisory) → `get_cart` → share the checkout URL. In-browser credential/cookie use was rejected (fragile, credential smell).

## Alternatives considered

- **E/Click to add** — spec says A; context gate keeps it. Aliases can be added later.
- **Dwell-to-add** — accidental adds; rejected.
- **A adds on raw hover** (v1 of this ADR) — rejected by review: degenerates to "A never strafes" when scanning shelves.
- **Direct cart API from the app** — rejected (credentials in browser).

## Consequences

- (+) Spec-faithful flow with legible modes; dense shelves scannable without panel churn; corrections possible under pointer lock.
- (−) Real-cart sync remains a chat step, by design.
- (−) Three disclosed spec deviations: 4.5 m aim range; A gated on the open panel (still within 0.5 s of aiming); dwell holds its fill above ~1.5 m/s movement.
- Fridge/freezer "glass" never blocks rays — doors are non-occluding set dressing (decision shared with ADR-0002/0004); shelf boards do occlude via proxy-cell scoping.
