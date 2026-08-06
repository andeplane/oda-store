// Desktop first-person controller (ADR-0003). Rig origin on the floor; eye height
// on camera.position (ADR-0004 rig invariants). Collision vs fixture AABBs.

import * as THREE from "three";
import type { FixtureWorld } from "./fixtures";
import type { Layout } from "./data";

export const EYE_HEIGHT = 1.7;
const RADIUS = 0.35;
const WALK = 3.0;
const RUN = 5.5;

export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly rig: THREE.Group;
  locked = false;
  speed = 0; // current translational speed (m/s), read by interact's dwell gate
  /** while true, KeyA is add-to-cart (panel open), not strafe */
  aIsAdd: () => boolean = () => false;

  private keys = new Set<string>();
  private yaw: number;
  private pitch = 0;

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

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * 0.0022));
      this.camera.rotation.set(this.pitch, 0, 0, "YXZ");
      this.rig.rotation.y = this.yaw;
    });
    document.addEventListener("keydown", (e) => this.keys.add(e.code));
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
      document.body.classList.toggle("playing", this.locked);
      document.body.classList.toggle("cartmode", !this.locked);
    });
  }

  requestLock() {
    this.dom.requestPointerLock();
  }

  update(dt: number) {
    if (!this.locked) {
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
    if (!fwd && !strafe) {
      this.speed = 0;
      return;
    }
    const len = Math.hypot(fwd, strafe);
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dx = ((strafe / len) * cos + (fwd / len) * sin) * sp * dt;
    const dz = (-(strafe / len) * sin + (fwd / len) * cos) * sp * dt;
    this.move(dx, dz);
    this.speed = sp;
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
