// Detail-tier texture residency (ADR-0002): streams 256px tiles for nearby
// products into slots of one cache texture; base atlas covers everything else.
// Implementation follows review option (b): no cache mips, LinearFilter, and the
// distance gate keeps detail sampling magnified-or-parity only.

import * as THREE from "three";
import type { Cards } from "./cards";
import type { TileSource } from "./tiles";

const TILE = 256;
const UPLOADS_PER_FRAME = 2;
const BURST_UPLOADS = 12; // while the loading screen still covers the scene
const RECOMPUTE_INTERVAL = 0.4; // s
const HYSTERESIS = 1.5; // residents stay until radius * this

/** OffscreenCanvas 2D needs Safari 16.4+; older iPhones fall back to a DOM canvas */
function makeCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(TILE, TILE);
  const c = document.createElement("canvas");
  c.width = c.height = TILE;
  return c;
}

interface SlotState {
  productId: number | null;
  lastWanted: number;
}

export class Residency {
  private slots: SlotState[];
  private byProduct = new Map<number, number>(); // productId -> slot
  private loading = new Set<number>();
  private ready: { productId: number; canvas: OffscreenCanvas | HTMLCanvasElement }[] = [];
  private clock = 0;
  private sinceRecompute = Infinity;
  burst = true;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private cards: Cards,
    private tiles: TileSource,
    private radius: number,
    slotCount: number
  ) {
    this.slots = Array.from({ length: slotCount }, () => ({ productId: null, lastWanted: -1 }));
  }

  update(dt: number, viewpoint: THREE.Vector3) {
    this.clock += dt;
    this.sinceRecompute += dt;
    if (this.sinceRecompute > RECOMPUTE_INTERVAL) {
      this.sinceRecompute = 0;
      this.recompute(viewpoint);
    }
    let budget = this.burst ? BURST_UPLOADS : UPLOADS_PER_FRAME;
    while (budget-- > 0 && this.ready.length > 0) {
      const { productId, canvas } = this.ready.shift()!;
      this.upload(productId, canvas);
    }
  }

  private recompute(viewpoint: THREE.Vector3) {
    const nearby = this.cards.near(viewpoint, this.radius);
    // one entry per product, closest distance
    const want = new Map<number, number>();
    for (const inst of nearby) {
      const d = inst.pos.distanceTo(viewpoint);
      const cur = want.get(inst.productId);
      if (cur === undefined || d < cur) want.set(inst.productId, d);
    }
    const ranked = [...want.entries()].sort((a, b) => a[1] - b[1]).slice(0, this.slots.length);
    const wantedIds = new Set(ranked.map(([id]) => id));

    // mark wanted residents
    for (const [id] of ranked) {
      const slot = this.byProduct.get(id);
      if (slot !== undefined) this.slots[slot].lastWanted = this.clock;
    }
    // load missing, evicting the stalest non-wanted resident
    for (const [id] of ranked) {
      if (this.byProduct.has(id) || this.loading.has(id)) continue;
      const slot = this.findFreeSlot(wantedIds, viewpoint);
      if (slot === null) break;
      this.load(id, slot);
    }
  }

  private findFreeSlot(wantedIds: Set<number>, viewpoint: THREE.Vector3): number | null {
    let stalest: number | null = null;
    let stalestTime = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.productId === null) return i;
      if (wantedIds.has(s.productId)) continue;
      // hysteresis: keep residents that are still fairly close
      const insts = this.cards.byProduct.get(s.productId);
      const d = insts?.[0]?.pos.distanceTo(viewpoint) ?? Infinity;
      if (d < this.radius * HYSTERESIS) continue;
      if (s.lastWanted < stalestTime) {
        stalestTime = s.lastWanted;
        stalest = i;
      }
    }
    return stalest;
  }

  private async load(productId: number, slot: number) {
    this.loading.add(productId);
    const prev = this.slots[slot].productId;
    if (prev !== null) {
      this.byProduct.delete(prev);
      this.cards.setDetailSlot(prev, -1);
    }
    this.slots[slot] = { productId, lastWanted: this.clock };
    this.byProduct.set(productId, slot);
    try {
      const bitmap = await this.tiles.bitmap(productId);
      if (!bitmap) throw new Error("no tile");
      const canvas = makeCanvas();
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      // no pre-flip: copyTextureToTexture's upload path lands canvas row 0 at the
      // slot's high-v edge, which matches the shader's vUv convention (verified visually)
      ctx.fillStyle = "#f4f4f6";
      ctx.fillRect(0, 0, TILE, TILE);
      ctx.drawImage(bitmap, 0, 0, TILE, TILE);
      bitmap.close();
      this.ready.push({ productId, canvas });
    } catch {
      // image missing: release the slot
      this.byProduct.delete(productId);
      this.slots[slot] = { productId: null, lastWanted: -1 };
      this.loading.delete(productId);
    }
  }

  private upload(productId: number, canvas: OffscreenCanvas | HTMLCanvasElement) {
    const slot = this.byProduct.get(productId);
    this.loading.delete(productId);
    if (slot === undefined) return; // evicted while decoding
    const src = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
    src.flipY = false;
    src.colorSpace = THREE.SRGBColorSpace;
    src.generateMipmaps = false;
    src.minFilter = THREE.LinearFilter;
    this.renderer.initTexture(src);
    const grid = this.cards.detailGrid;
    const col = slot % grid;
    const row = Math.floor(slot / grid);
    this.renderer.copyTextureToTexture(src, this.cards.detailTexture, null, new THREE.Vector2(col * TILE, row * TILE));
    src.dispose();
    this.cards.setDetailSlot(productId, slot);
  }
}
