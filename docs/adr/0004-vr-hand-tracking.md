# ADR-0004: VR mode with hand tracking

**Status:** revised v3 after second-round review (cart accepts drops, VR cart visibility, basket lifecycle specified) · **Date:** 2026-08-06

## Context

VR phase: hand tracking to pick products off shelves and put them in a shopping cart. Target: Meta Quest browser (WebXR + hand tracking). The desktop DOM HUD is invisible in XR, so VR needs in-scene UI. Review verified all API claims against pinned r170 sources (`VRButton.js`, `XRHandModelFactory.js`, `WebXRController.js`, `WebXRManager.js`).

## Decision

### Session & hands (r170 specifics, verified)

- `renderer.xr.enabled = true`; `renderer.xr.setReferenceSpaceType('local-floor')` set explicitly (it is the default, but intent documented; if not granted, `local` → sunken floor — log a warning, accept in v1).
- **`'hand-tracking'` must be passed via `VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] })`** — r170's VRButton does *not* include it by default; user features append to (not replace) the built-in `local-floor`/`bounded-floor`/`layers`.
- Hand visuals: `XRHandModelFactory.createHandModel(hand, 'mesh')` (default profile is `'spheres'`, so `'mesh'` is explicit). The mesh profile fetches `left.glb`/`right.glb` from jsdelivr at runtime unless redirected — **vendor both GLBs into `public/hands/` and call `factory.setPath('/hands/')`**; no runtime CDN dependency.
- Pinch events: core dispatches `pinchstart`/`pinchend` on `renderer.xr.getHand(i)` with fixed 2 cm ± 0.5 cm hysteresis (not configurable). **The event carries no position** — the app computes the pinch point as the **midpoint of `thumb-tip` and `index-finger-tip` joints** (there is no 'pinch' joint). Joints materialize lazily and can be undefined during tracking loss — all joint access is null-checked.

### Grabbing

- Every product card has an invisible **grab-proxy box** (card w × h × ~8 cm depth, in front of the card face, scoped to its shelf cell) — shared with the desktop reticle raycast (ADR-0003). Proxies on the top (~1.9 m) and bottom (~0.3 m) levels get extra inflation — authentic shelf heights are hostile to pinch reach. Fridge/freezer "glass" never blocks the proximity query — doors are non-occluding set dressing (decision shared with ADR-0002/0003). The per-frame proximity query (≤ 15 cm, `Box3.distanceToPoint`) selects a **pre-pinch candidate**, which is visibly highlighted; `pinchstart` grabs **only when a highlighted candidate exists** (kills accidental pinches at rest).
- On grab, a **clone** is taken (the shelf facing stays). The clone is **not parented to a joint** (fingertip jitter is worst mid-pinch): it lives at scene root and each frame damp-follows the target pose — position `lerp(target, 1 − e^(−20·dt))`, orientation `slerp` from the **wrist joint** (stabler than fingertips).
- **Tracking loss ≠ drop:** lost joints freeze the held item up to ~200 ms; longer → grab cancels, item fades back to shelf. Never registers a basket drop. When tracking resumes with the hand still physically pinching, **no re-grab happens without a fresh `pinchstart` edge**.
- The floating info card above a held product despawns with its clone (drop, fade-out, or cancel — always torn down together).
- **Per-handedness state:** hold state is a map keyed by `event.handedness`; each hand can hold its own clone concurrently (two of the same product is legitimate shopping); `pinchend` from an empty hand is a no-op.
- A canvas-textured info card (name, price, size) floats above a held product — the VR analogue of the detail panel.

### The basket and the cart (two valid drop targets, one add path)

- **Body-anchored basket** (the convenience target): rendered as an actual **Oda shopping basket**, positioned each frame at a yaw-only damped offset from the headset (~35 cm forward-left, ~0.9 m height — the "left hip"), so a drop target is always within arm's reach anywhere in the store. It may clip fixtures when the user presses against a shelf — accepted visually (stated).
- **The stationary shopping cart** near the entrance is a **real drop target too** (its interior gets its own inflated `Box3`, same cart-add path) — the object literally named "shopping cart" must accept deposits, per spec point 6. It doubles as the themed checkout spot.
- On `pinchend`, the held item's world position is tested against either target's inflated interior `Box3`; inside → cart add + settle tween; outside → fade out (with a subtle "return to shelf" ghost). A short **drop-confirm click sound ships with this phase** (the basket sits at the edge of peripheral vision), not in polish.
- **Contents lifecycle:** settle tween → item despawns into the basket's **rim badge** (canvas texture: item count + running total — the VR cart HUD); the last ~3 items persist as miniatures for tangibility. Nothing accumulates on the moving anchor (draw calls, jitter, body clipping on snap turns).
- **Corrections in VR are v1-limited and disclosed**: no pinch-out removal; mistakes are fixed afterwards in desktop cart mode. (Pre-pinch candidate gating + inflated targets make accidental drops rare.)

### Camera rig invariants (prevents floating/sunken floors)

- Rig origin sits on the virtual floor (y = 0). Desktop eye height (1.7 m) lives on **`camera.position` inside the rig** — never on the rig y (that's the classic float-by-1.7 m bug: with `local-floor` the headset writes real head height into the camera's local transform, verified to compound the rig matrix).
- Session start: do nothing (three.js overwrites the camera pose per frame). **Session end: three.js does NOT restore the camera (verified)** — reset `camera.position.set(0, 1.7, 0)` and level orientation (preserve yaw).
- "The player" is at `camera.getWorldPosition()` — room-scale walking moves the camera off the rig origin. **Collision uses the camera's world XZ**; blocked motion clamps the rig. Thumbstick locomotion translates the rig along the camera's yaw.

### Locomotion & comfort

- Room-scale walking + smooth locomotion on the left controller thumbstick. **45° snap turn on the right thumbstick is mandatory v1 comfort** (rotate the rig about the camera's world position, not the rig origin, or the user orbits). Radial vignette during stick motion (camera-parented alpha ring) — should-have. No teleport in v1 (pinch-teleport conflicts with pinch-grab).
- Honest limitation: hands-only users move by physical walking, so they shop within their play space; full-store traversal needs controllers. Controllers and hands share slots (`getController(i)`/`getHand(i)`, `selectstart` vs `pinchstart`) and Quest hot-swaps mid-session — the `connected` event's `inputSource.hand !== null` distinguishes; trigger = grab is the controller fallback.

### Performance & dev logistics (Quest)

- Quest browser budgets: ~100–200 draw calls, 72 Hz, tab killed near ~1 GB GPU memory. Per-product planes with unique textures blow both — **the instanced/atlased rendering pipeline of ADR-0002 is a hard prerequisite for this phase** (ADR-0002 owns the numbers). No shadows, no post-processing, default foveation.
- Secure-context trap: `navigator.xr` does not exist on `http://LAN-IP:5173` — VRButton silently reports "VR not supported". Dev paths: `adb reverse tcp:5173 tcp:5173` + `http://localhost:5173` on the Quest (localhost is secure), or `@vitejs/plugin-basic-ssl`/mkcert with `--host`. Most hand logic is debuggable on desktop with Meta's Immersive Web Emulator extension.

## Alternatives considered

- **Physics engine for drops** — deferred (dependency + Quest CPU); damped tweens suffice.
- **Teleport for hands-only** — gesture conflicts with pinch-grab; deferred.
- **Joint-parented held items** — rejected by review (pinch-time fingertip jitter).
- **Stationary cart as the drop target** — rejected by review (round trip per item; unreachable for hands-only users deep in an aisle).
- **AR/passthrough** — out of scope.

## Consequences

- (+) Hands-first, controller fallback, desktop unaffected; drop target always reachable; verified against r170 (no API surprises left).
- (−) Hands-only users limited to play-space shopping (disclosed).
- (−) Requires the ADR-0002 atlas/instancing pipeline before VR ships.
