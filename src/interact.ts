// Center-reticle aim, dwell, detail panel, A/X cart keys (ADR-0003 v3 semantics):
// all state keyed by product ID; two-rule sticky targeting; resume-grace on the
// dwell fill; dwell holds above 1.5 m/s; A gated on the open panel.

import * as THREE from "three";
import { getDescription, type World } from "./data";
import type { Cards } from "./cards";
import type { Cart } from "./cart";
import type { Player } from "./player";
import type { TileSource } from "./tiles";

const DWELL = 0.5;
const GRACE = 0.35;
const SWITCH_MS = 0.08;
const MAX_DIST = 4.5;
const INFLATE = 0.03;
const SPEED_GATE = 1.5;

export class Interactions {
  hoveredId: number | null = null;
  panelId: number | null = null;

  private dwell = 0;
  private offFor = 0;
  private switchCand: { id: number; since: number } | null = null;
  private clock = 0;

  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  private reticleEl = document.getElementById("reticle")!;
  private hoverEl = document.getElementById("hover-label")!;
  private hoverName = document.getElementById("hover-name")!;
  private hoverPrice = document.getElementById("hover-price")!;
  private panelEl = document.getElementById("detail-panel")!;

  constructor(
    private world: World,
    private cards: Cards,
    private cart: Cart,
    private player: Player,
    private tiles: TileSource
  ) {
    player.aIsAdd = () => this.panelId !== null;
    document.addEventListener("keydown", (e) => {
      if (e.repeat || !document.body.classList.contains("playing")) return;
      if (this.panelId === null) return;
      const p = this.world.byId.get(this.panelId);
      if (!p) return;
      if (e.code === "KeyA") this.cart.add(p);
      if (e.code === "KeyX") {
        if (this.cart.remove(p.id)) this.cart.toast(`Fjernet ${p.name}`);
      }
    });
  }

  reset() {
    this.setHover(null);
    this.closePanel();
  }

  update(dt: number, active: boolean) {
    if (!active) {
      this.reset();
      return;
    }
    this.clock += dt;
    this.player.camera.getWorldPosition(this.origin);
    this.player.camera.getWorldDirection(this.dir);

    const hit = this.cards.raycast(this.origin, this.dir, MAX_DIST);
    const hitId = hit?.card.productId ?? null;

    if (this.hoveredId === null) {
      if (hitId !== null) this.setHover(hitId);
    } else if (hitId === this.hoveredId) {
      this.switchCand = null;
      this.offFor = 0;
    } else if (hitId !== null) {
      // switch rule: closest hit differs continuously for >= 80 ms
      if (this.switchCand?.id !== hitId) this.switchCand = { id: hitId, since: this.clock };
      else if (this.clock - this.switchCand.since >= SWITCH_MS) this.setHover(hitId);
      this.offFor = 0;
    } else {
      // loss rule: keep target while the ray still clips its inflated proxy
      this.switchCand = null;
      if (this.cards.clips(this.origin, this.dir, this.hoveredId, MAX_DIST, INFLATE)) {
        this.offFor = 0;
      } else {
        this.offFor += dt;
        if (this.offFor > GRACE) this.setHover(null);
      }
    }

    // dwell fill (paused above speed gate; grace pauses rather than resets)
    if (this.hoveredId !== null) {
      if (this.panelId === this.hoveredId) {
        this.setProgress(1);
      } else {
        if (this.player.speed <= SPEED_GATE && this.offFor === 0) this.dwell += dt;
        this.setProgress(Math.min(this.dwell / DWELL, 1));
        if (this.dwell >= DWELL) this.openPanel(this.hoveredId);
      }
    } else {
      this.setProgress(0);
      if (this.panelId !== null) this.closePanel();
    }
  }

  private setHover(id: number | null) {
    if (this.hoveredId !== null) this.cards.setTint(this.hoveredId, 0);
    this.hoveredId = id;
    this.switchCand = null;
    this.dwell = 0;
    this.offFor = 0;
    if (id !== null) {
      const p = this.world.byId.get(id)!;
      this.cards.setTint(id, 1);
      this.hoverName.textContent = p.name;
      this.hoverPrice.textContent = `${p.price} kr`;
      this.hoverEl.classList.remove("hidden");
      this.reticleEl.classList.add("aiming");
    } else {
      this.hoverEl.classList.add("hidden");
      this.reticleEl.classList.remove("aiming");
    }
  }

  private setProgress(v: number) {
    this.reticleEl.style.setProperty("--p", v.toFixed(3));
  }

  private openPanel(id: number) {
    if (this.panelId === id) return;
    this.panelId = id;
    const p = this.world.byId.get(id)!;
    // side chosen once at open from the card's screen-x offset, default right
    const inst = this.cards.byProduct.get(id)?.[0];
    let side = "right";
    if (inst) {
      const sp = inst.pos.clone().project(this.player.camera);
      if (sp.x < -0.02) side = "left";
    }
    this.panelEl.classList.toggle("left", side === "left");
    void this.tiles.draw(document.getElementById("detail-img") as HTMLCanvasElement, p.id);
    document.getElementById("detail-name")!.textContent = p.name;
    document.getElementById("detail-brand")!.textContent = p.brand;
    document.getElementById("detail-extra")!.textContent = p.extra;
    document.getElementById("detail-price")!.textContent = `${p.price} kr`;
    document.getElementById("detail-unit-price")!.textContent = p.unitPrice;
    const cls = document.getElementById("detail-classifiers")!;
    cls.innerHTML = "";
    for (const c of p.classifiers.slice(0, 5)) {
      const chip = document.createElement("span");
      chip.textContent = c;
      cls.append(chip);
    }
    const desc = document.getElementById("detail-desc")!;
    desc.textContent = "";
    void getDescription(id).then((d) => {
      if (this.panelId === id) desc.textContent = d;
    });
    this.panelEl.classList.remove("hidden");
  }

  private closePanel() {
    this.panelId = null;
    this.panelEl.classList.add("hidden");
  }
}
