// WebXR + hand tracking (ADR-0004 v3): pinch-grab clones off the shelf, damped
// world-space holds keyed by handedness, hip basket + stationary cart drop targets,
// controller fallback, snap turn, session-end camera restore.

import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { World, Product } from "./data";
import type { Cards, CardInstance } from "./cards";
import type { Cart } from "./cart";
import { Player, EYE_HEIGHT } from "./player";

const GRAB_RANGE = 0.25;
const DAMP_K = 20;
const TRACKLOSS_CANCEL = 0.2; // s
const SNAP_ANGLE = Math.PI / 4;

interface Held {
  product: Product;
  mesh: THREE.Group;
  lostFor: number;
}

function productCardMesh(product: Product, w: number, h: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xf4f4f6 });
  const card = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  card.material.side = THREE.DoubleSide;
  g.add(card);
  new THREE.TextureLoader().load(`img/${product.id}.jpg`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    mat.map = tex;
    mat.color.set(0xffffff);
    mat.needsUpdate = true;
  });
  // floating info card
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(20,22,28,0.92)";
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = "#fff";
  ctx.font = "600 34px -apple-system, sans-serif";
  ctx.fillText(product.name.slice(0, 28), 16, 50);
  ctx.fillStyle = "#ff8266";
  ctx.font = "800 40px -apple-system, sans-serif";
  ctx.fillText(`${product.price} kr`, 16, 102);
  const info = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.06),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true })
  );
  info.position.y = h / 2 + 0.06;
  g.add(info);
  return g;
}

function basketMesh(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xff5230, roughness: 0.6 });
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.02, 0.26), mat);
  g.add(bottom);
  for (const [w, d, x, z] of [
    [0.38, 0.02, 0, 0.13], [0.38, 0.02, 0, -0.13], [0.02, 0.26, 0.19, 0], [0.02, 0.26, -0.19, 0],
  ]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(w, 0.2, d), mat);
    side.position.set(x, 0.11, z);
    g.add(side);
  }
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.008, 6, 16, Math.PI), mat);
  handle.position.y = 0.22;
  handle.rotation.y = Math.PI / 2;
  g.add(handle);
  return g;
}

function cartMesh(): THREE.Group {
  const g = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, roughness: 0.4, metalness: 0.6 });
  const basket = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.9), frame);
  basket.position.y = 0.65;
  g.add(basket);
  for (const [x, z] of [[-0.25, -0.38], [0.25, -0.38], [-0.25, 0.38], [0.25, 0.38]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.45), frame);
    leg.position.set(x, 0.22, z);
    g.add(leg);
    const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.05), frame);
    wheel.position.set(x, 0.05, z);
    g.add(wheel);
  }
  const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6), frame);
  handleBar.rotation.z = Math.PI / 2;
  handleBar.position.set(0, 1.0, -0.5);
  g.add(handleBar);
  return g;
}

export class VRMode {
  private held = new Map<string, Held>();
  private candidates = new Map<string, CardInstance | null>();
  private basket: THREE.Group;
  private cartFixture: THREE.Group;
  private badgeCtx: CanvasRenderingContext2D;
  private badgeTex: THREE.CanvasTexture;
  private hands: THREE.XRHandSpace[] = [];
  private controllers: THREE.XRTargetRaySpace[] = [];
  private snapReady = true;
  private transient: { mesh: THREE.Object3D; t: number; kind: "settle" | "fade"; target?: THREE.Vector3 }[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private world: World,
    private cards: Cards,
    private cart: Cart,
    private player: Player
  ) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    document.body.appendChild(
      VRButton.createButton(renderer, { optionalFeatures: ["hand-tracking"] })
    );

    const factory = new XRHandModelFactory();
    factory.setPath("hands/");
    for (const i of [0, 1]) {
      const hand = renderer.xr.getHand(i);
      hand.add(factory.createHandModel(hand, "mesh"));
      player.rig.add(hand);
      this.hands.push(hand);
      hand.addEventListener("pinchstart", (e) => this.onGrab((e as any).handedness ?? `hand${i}`, this.pinchPoint(hand)));
      hand.addEventListener("pinchend", (e) => this.onRelease((e as any).handedness ?? `hand${i}`));
      const ctrl = renderer.xr.getController(i);
      player.rig.add(ctrl);
      this.controllers.push(ctrl);
      ctrl.addEventListener("selectstart", () => this.onGrab(`ctrl${i}`, ctrl.getWorldPosition(new THREE.Vector3())));
      ctrl.addEventListener("selectend", () => this.onRelease(`ctrl${i}`));
    }

    this.basket = basketMesh();
    scene.add(this.basket);
    this.basket.visible = false;
    this.cartFixture = cartMesh();
    const e = world.layout.hall.entrance;
    this.cartFixture.position.set(e.x + 2.5, 0, e.z + 2.5);
    scene.add(this.cartFixture);

    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    this.badgeCtx = c.getContext("2d")!;
    this.badgeTex = new THREE.CanvasTexture(c);
    const badge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.05),
      new THREE.MeshBasicMaterial({ map: this.badgeTex, transparent: true })
    );
    badge.position.set(0, 0.28, 0);
    this.basket.add(badge);
    cart.onChange = () => this.renderBadge();
    this.renderBadge();

    renderer.xr.addEventListener("sessionstart", () => {
      this.basket.visible = true;
      document.body.classList.add("xr");
    });
    renderer.xr.addEventListener("sessionend", () => {
      this.basket.visible = false;
      document.body.classList.remove("xr");
      // three.js does NOT restore the camera (verified) — reset eye height, keep yaw
      player.camera.position.set(0, EYE_HEIGHT, 0);
      player.camera.rotation.set(0, 0, 0, "YXZ");
    });
  }

  private renderBadge() {
    const ctx = this.badgeCtx;
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = "rgba(20,22,28,0.9)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = "#fff";
    ctx.font = "700 36px -apple-system, sans-serif";
    ctx.fillText(`🛒 ${this.cart.count} · ${this.cart.total.toFixed(0)} kr`, 10, 44);
    this.badgeTex.needsUpdate = true;
  }

  private pinchPoint(hand: THREE.XRHandSpace): THREE.Vector3 | null {
    const joints = (hand as any).joints;
    const tipI = joints?.["index-finger-tip"];
    const tipT = joints?.["thumb-tip"];
    if (!tipI || !tipT) return null;
    return tipI.getWorldPosition(this.tmp).clone().add(tipT.getWorldPosition(this.tmp2)).multiplyScalar(0.5);
  }

  private nearestCard(p: THREE.Vector3): CardInstance | null {
    let best: CardInstance | null = null;
    let bestD = GRAB_RANGE;
    for (const inst of this.cards.near(p, GRAB_RANGE + 0.5)) {
      // generous inflation on top/bottom levels (ADR-0004)
      const inflate = inst.level === 0 || inst.level >= 4 ? 0.08 : 0.03;
      const d = distToBox(p, inst.min, inst.max, inflate);
      if (Math.abs(p.y - inst.pos.y) > 0.5) continue;
      if (d < bestD) {
        bestD = d;
        best = inst;
      }
    }
    return best;
  }

  private onGrab(hand: string, point: THREE.Vector3 | null) {
    if (!this.renderer.xr.isPresenting || !point || this.held.has(hand)) return;
    // pre-pinch candidate gate: only grab what is highlighted
    const cand = this.candidates.get(hand);
    if (!cand) return;
    const product = this.world.byId.get(cand.productId);
    if (!product) return;
    const mesh = productCardMesh(product, cand.w, cand.h);
    mesh.position.copy(point);
    this.scene.add(mesh);
    this.held.set(hand, { product, mesh, lostFor: 0 });
  }

  private onRelease(hand: string) {
    const held = this.held.get(hand);
    if (!held) return;
    this.held.delete(hand);
    const p = held.mesh.position;
    if (this.inBasket(p)) {
      this.cart.add(held.product);
      const target = this.basket.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0));
      this.transient.push({ mesh: held.mesh, t: 0, kind: "settle", target });
      this.playClick();
    } else {
      this.transient.push({ mesh: held.mesh, t: 0, kind: "fade" });
    }
  }

  private inBasket(p: THREE.Vector3): boolean {
    for (const target of [this.basket, this.cartFixture]) {
      const c = target.getWorldPosition(this.tmp);
      const hy = target === this.basket ? 0.35 : 0.95;
      if (Math.abs(p.x - c.x) < 0.45 && Math.abs(p.z - c.z) < 0.6 && p.y > c.y - 0.1 && p.y < c.y + hy + 0.3) {
        return true;
      }
    }
    return false;
  }

  private audioCtx: AudioContext | null = null;

  private playClick() {
    this.audioCtx ??= new AudioContext();
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  }

  update(dt: number) {
    if (!this.renderer.xr.isPresenting) return;
    const cam = this.player.camera;
    const camPos = cam.getWorldPosition(new THREE.Vector3());

    // hip basket: yaw-only damped follow, forward-left of the head
    const yaw = Math.atan2(
      cam.getWorldDirection(this.tmp).x,
      cam.getWorldDirection(this.tmp).z
    );
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const target = new THREE.Vector3(
      camPos.x + fx * 0.3 - fz * 0.25,
      0.9,
      camPos.z + fz * 0.3 + fx * 0.25
    );
    const k = 1 - Math.exp(-8 * dt);
    this.basket.position.lerp(target, k);
    this.basket.rotation.y += (yaw - this.basket.rotation.y) * k;

    // pre-pinch candidates + held follow per hand
    for (let i = 0; i < this.hands.length; i++) {
      const hand = this.hands[i];
      const handed = ((hand as any).xrInputSource?.handedness as string) ?? `hand${i}`;
      const point = this.pinchPoint(hand);
      const heldKeys = [handed, `hand${i}`];
      const held = heldKeys.map((k2) => this.held.get(k2)).find(Boolean);
      if (point) {
        if (held) {
          held.lostFor = 0;
          const wrist = (hand as any).joints?.wrist;
          const hk = 1 - Math.exp(-DAMP_K * dt);
          held.mesh.position.lerp(point, hk);
          if (wrist) {
            const q = wrist.getWorldQuaternion(new THREE.Quaternion());
            held.mesh.quaternion.slerp(q, hk);
          }
          this.setCandidate(handed, null);
        } else {
          this.setCandidate(handed, this.nearestCard(point));
        }
      } else if (held) {
        held.lostFor += dt;
        if (held.lostFor > TRACKLOSS_CANCEL) {
          for (const k2 of heldKeys) this.held.delete(k2);
          this.transient.push({ mesh: held.mesh, t: 0, kind: "fade" });
        }
      }
    }

    // controller locomotion + snap turn
    const session = this.renderer.xr.getSession();
    if (session) {
      for (const src of session.inputSources) {
        const axes = src.gamepad?.axes;
        if (!axes || axes.length < 4) continue;
        const ax = axes[2];
        const ay = axes[3];
        if (src.handedness === "left") {
          if (Math.abs(ax) > 0.1 || Math.abs(ay) > 0.1) {
            // stick forward (-ay) moves along camera yaw; stick x strafes
            const SPEED = 2.2;
            this.player.move(
              (fx * -ay + fz * ax) * SPEED * dt,
              (fz * -ay - fx * ax) * SPEED * dt,
              camPos
            );
          }
        } else if (src.handedness === "right") {
          if (Math.abs(ax) > 0.7 && this.snapReady) {
            this.snapReady = false;
            this.snapTurn(Math.sign(ax) * -SNAP_ANGLE, camPos);
          } else if (Math.abs(ax) < 0.3) {
            this.snapReady = true;
          }
        }
      }
    }

    // transient animations
    for (let i = this.transient.length - 1; i >= 0; i--) {
      const tr = this.transient[i];
      tr.t += dt;
      if (tr.kind === "settle" && tr.target) {
        tr.mesh.position.lerp(tr.target, 1 - Math.exp(-10 * dt));
        tr.mesh.scale.multiplyScalar(1 - Math.exp(-4 * dt) * 0.5);
      } else {
        tr.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 4));
      }
      if (tr.t > 0.6) {
        this.scene.remove(tr.mesh);
        this.transient.splice(i, 1);
      }
    }
  }

  private lastCandidate = new Map<string, number | null>();

  private setCandidate(hand: string, inst: CardInstance | null) {
    this.candidates.set(hand, inst);
    const prev = this.lastCandidate.get(hand) ?? null;
    const cur = inst?.productId ?? null;
    if (prev !== cur) {
      if (prev !== null) this.cards.setTint(prev, 0);
      if (cur !== null) this.cards.setTint(cur, 1);
      this.lastCandidate.set(hand, cur);
    }
  }

  private snapTurn(angle: number, about: THREE.Vector3) {
    const rig = this.player.rig;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = rig.position.x - about.x;
    const dz = rig.position.z - about.z;
    rig.position.x = about.x + dx * cos - dz * sin;
    rig.position.z = about.z + dx * sin + dz * cos;
    rig.rotation.y += angle;
  }
}

function distToBox(p: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3, inflate: number): number {
  const dx = Math.max(min.x - inflate - p.x, 0, p.x - max.x - inflate);
  const dy = Math.max(min.y - inflate - p.y, 0, p.y - max.y - inflate);
  const dz = Math.max(min.z - inflate - p.z, 0, p.z - max.z - inflate);
  return Math.hypot(dx, dy, dz);
}
