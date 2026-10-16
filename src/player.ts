// First-person controller (ADR-0003). Rig origin on the floor; eye height
// on camera.position (ADR-0004 rig invariants). Collision vs fixture AABBs.
// Desktop uses pointer lock + WASD; touch devices (no pointer lock on mobile
// browsers) use a left-thumb move stick and drag-to-look anywhere else.

import * as THREE from "three";
import type { FixtureWorld } from "./fixtures";
import type { Layout } from "./data";

export const EYE_HEIGHT = 1.7;
const RADIUS = 0.35;
const WALK = 3.0;
const RUN = 5.5;
const LOOK_SPEED = 0.0022;
const TOUCH_LOOK_SPEED = 0.005;
const STICK_RADIUS = 60; // px of thumb travel for full walking speed
const STICK_DEADZONE = 0.15; // thumb wobble near the origin must not creep the player
const ACCEL = 10; // 1/s: velocity eases toward the input instead of starting dead
const DECEL = 18; // 1/s: but stops quickly once keys are released, so it never feels slippery
const MOUSE_SPIKE = 250; // px: Chrome occasionally reports a huge movementX/Y after a lock
const TELEPORT_MIN = 1.0; // m of floor distance from the body
const TELEPORT_MAX = 12;

/** phones/tablets: no usable pointer lock, so they get the touch controller */
export const isTouchDevice =
  matchMedia("(pointer: coarse)").matches || typeof Element.prototype.requestPointerLock !== "function";
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly rig: THREE.Group;
  /** true while walking around (pointer locked on desktop, entered on touch) */
  locked = false;
  onActiveChange: (active: boolean) => void = () => {};
  speed = 0; // current translational speed (m/s), read by interact's dwell gate
  /** while true, KeyA is add-to-cart (panel open), not strafe */
  aIsAdd: () => boolean = () => false;

  private keys = new Set<string>();
  private yaw: number;
  private pitch = 0;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 }; // -1..1, y negative = forward
  private lookTouches = new Map<number, { x: number; y: number }>();
  private vel = new THREE.Vector2(); // world xz velocity (m/s)
  private boxes: THREE.Box3[];
  private ray = new THREE.Ray();
  private boxHit = new THREE.Vector3();
  private stickEl = document.getElementById("touch-stick");
  private knobEl = document.getElementById("touch-knob");

  constructor(
    private dom: HTMLElement,
    private layout: Layout,
    private fixtures: FixtureWorld
  ) {
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 120);
    this.rig = new THREE.Group();
    const s = layout.hall.spawn;
    this.rig.position.set(s.x, 0, s.z);
    this.yaw = s.yaw;
    this.rig.rotation.y = this.yaw;
    this.camera.position.set(0, EYE_HEIGHT, 0);
    this.rig.add(this.camera);
    this.boxes = fixtures.colliders.map((c) => new THREE.Box3(c.min, c.max));

    document.addEventListener("mousemove", (e) => {
      if (!this.locked || isTouchDevice) return;
      if (Math.abs(e.movementX) > MOUSE_SPIKE || Math.abs(e.movementY) > MOUSE_SPIKE) return;
      this.look(e.movementX * LOOK_SPEED, e.movementY * LOOK_SPEED);
    });
    document.addEventListener("keydown", (e) => this.keys.add(e.code));
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("pointerlockchange", () => this.setActive(document.pointerLockElement === this.dom));
    if (isTouchDevice) this.initTouch();
  }

  requestLock() {
    if (isTouchDevice) {
      this.setActive(true);
      return;
    }
    // raw (unaccelerated) mouse input where supported, so look speed tracks hand speed;
    // returns a promise in modern browsers; a refused lock must not surface as an unhandled rejection
    const lock = (opts?: object) => Promise.resolve((this.dom.requestPointerLock as any)(opts));
    void lock({ unadjustedMovement: true }).catch(() => lock().catch(() => {}));
  }

  /** leave walking mode (touch "menu" button; desktop leaves via Esc) */
  exit() {
    if (isTouchDevice) this.setActive(false);
    else document.exitPointerLock();
  }

  private setActive(active: boolean) {
    if (active === this.locked) return;
    this.locked = active;
    document.body.classList.toggle("playing", active);
    document.body.classList.toggle("cartmode", !active);
    if (!active) {
      this.stickId = null;
      this.stick.x = this.stick.y = 0;
      this.vel.set(0, 0);
      this.lookTouches.clear();
      this.updateStickEl(false);
    }
    this.onActiveChange(active);
  }

  private look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy));
    this.camera.rotation.set(this.pitch, 0, 0, "YXZ");
    this.rig.rotation.y = this.yaw;
  }

  private updateStickEl(show: boolean) {
    if (!this.stickEl || !this.knobEl) return;
    this.stickEl.classList.toggle("hidden", !show);
    if (!show) return;
    this.stickEl.style.left = `${this.stickOrigin.x}px`;
    this.stickEl.style.top = `${this.stickOrigin.y}px`;
    this.knobEl.style.transform = `translate(${this.stick.x * STICK_RADIUS}px, ${this.stick.y * STICK_RADIUS}px)`;
  }

  private initTouch() {
    const el = this.dom;
    el.style.touchAction = "none";
    el.addEventListener("touchstart", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        // a thumb landing on the left half of the screen drives the move stick
        if (this.stickId === null && t.clientX < innerWidth * 0.5) {
          this.stickId = t.identifier;
          this.stickOrigin = { x: t.clientX, y: t.clientY };
          this.stick.x = this.stick.y = 0;
          this.updateStickEl(true);
        } else {
          this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }
    }, { passive: false });
    el.addEventListener("touchmove", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          let dx = (t.clientX - this.stickOrigin.x) / STICK_RADIUS;
          let dy = (t.clientY - this.stickOrigin.y) / STICK_RADIUS;
          const len = Math.hypot(dx, dy);
          if (len > 1) {
            dx /= len;
            dy /= len;
          }
          this.stick.x = dx;
          this.stick.y = dy;
          this.updateStickEl(true);
        } else {
          const prev = this.lookTouches.get(t.identifier);
          if (!prev) continue;
          this.look((t.clientX - prev.x) * TOUCH_LOOK_SPEED, (t.clientY - prev.y) * TOUCH_LOOK_SPEED);
          this.lookTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
      }
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stickId) {
          this.stickId = null;
          this.stick.x = this.stick.y = 0;
          this.updateStickEl(false);
        }
        this.lookTouches.delete(t.identifier);
      }
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  update(dt: number) {
    if (!this.locked) {
      this.vel.set(0, 0);
      this.speed = 0;
      return;
    }
    const sp = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? RUN : WALK;
    let fwd = 0;
    let strafe = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) fwd -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) fwd += 1;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyQ") || (this.keys.has("KeyA") && !this.aIsAdd())) strafe -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyE") || this.keys.has("KeyD")) strafe += 1;
    let scale = 1;
    if (this.stickId !== null) {
      const mag = Math.hypot(this.stick.x, this.stick.y);
      if (mag > STICK_DEADZONE) {
        // rescale past the deadzone so walking still starts gently
        scale = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
        fwd = this.stick.y;
        strafe = this.stick.x;
      }
    }
    let tx = 0;
    let tz = 0;
    const len = Math.hypot(fwd, strafe);
    if (len) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      tx = ((strafe / len) * cos + (fwd / len) * sin) * sp * scale;
      tz = (-(strafe / len) * sin + (fwd / len) * cos) * sp * scale;
    }
    const k = 1 - Math.exp(-(len ? ACCEL : DECEL) * dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.y += (tz - this.vel.y) * k;
    if (!len && this.vel.lengthSq() < 0.0004) this.vel.set(0, 0);
    if (!this.vel.x && !this.vel.y) {
      this.speed = 0;
      return;
    }
    const before = this.rig.position.clone();
    this.move(this.vel.x * dt, this.vel.y * dt);
    // blocked by a shelf: keep only the velocity that actually happened (no sticky push into walls)
    if (dt > 0) {
      this.vel.set((this.rig.position.x - before.x) / dt, (this.rig.position.z - before.z) / dt);
      if (this.vel.length() > sp) this.vel.setLength(sp); // a collider snap is not speed
    }
    this.speed = this.vel.length();
  }

  /**
   * Where a gaze ray lands on open floor, or null when it isn't looking down at reachable floor
   * (too near/far, behind a fixture, or the spot is inside a fixture's walk envelope).
   */
  floorTarget(origin: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | null {
    if (dir.y > -0.1 || origin.y <= 0) return null;
    const t = -origin.y / dir.y;
    out.copy(dir).multiplyScalar(t).add(origin);
    out.y = 0;
    const flat = Math.hypot(out.x - origin.x, out.z - origin.z);
    if (flat < TELEPORT_MIN || flat > TELEPORT_MAX) return null;
    const W = this.layout.hall.w;
    const D = this.layout.hall.d;
    const m = RADIUS + 0.1;
    if (out.x < m || out.x > W - m || out.z < m || out.z > D - m) return null;
    this.ray.set(origin, dir);
    for (const b of this.boxes) {
      if (
        out.x > b.min.x - RADIUS && out.x < b.max.x + RADIUS &&
        out.z > b.min.z - RADIUS && out.z < b.max.z + RADIUS
      ) return null;
      const hit = this.ray.intersectBox(b, this.boxHit);
      if (hit && hit.distanceTo(origin) < t) return null;
    }
    return out;
  }

  /** move the rig so the body (camera world xz in VR) lands on target */
  teleport(target: THREE.Vector3, body: THREE.Vector3) {
    this.rig.position.x += target.x - body.x;
    this.rig.position.z += target.z - body.z;
  }

  /** shared with VR locomotion: moves the rig with slide collision, using p as the body position */
  move(dx: number, dz: number, body?: THREE.Vector3) {
    const p = this.rig.position;
    const bx = body ? body.x : p.x;
    const bz = body ? body.z : p.z;
    const nx = this.resolveAxis(bx + dx, bz, true);
    const nz = this.resolveAxis(bz + dz, nx, false);
    const W = this.layout.hall.w;
    const D = this.layout.hall.d;
    const cx = Math.max(RADIUS + 0.1, Math.min(W - RADIUS - 0.1, nx));
    const cz = Math.max(RADIUS + 0.1, Math.min(D - RADIUS - 0.1, nz));
    p.x += cx - bx;
    p.z += cz - bz;
  }

  private resolveAxis(target: number, other: number, isX: boolean): number {
    for (const box of this.fixtures.colliders) {
      const minA = isX ? box.min.x : box.min.z;
      const maxA = isX ? box.max.x : box.max.z;
      const minB = isX ? box.min.z : box.min.x;
      const maxB = isX ? box.max.z : box.max.x;
      if (other > minB - RADIUS && other < maxB + RADIUS && target > minA - RADIUS && target < maxA + RADIUS) {
        target = target < (minA + maxA) / 2 ? minA - RADIUS : maxA + RADIUS;
      }
    }
    return target;
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}
