// 3D products on the shelves + proxy grid (ADR-0002, ADR-0006). Every product is drawn
// with one of the 35 shared packaging meshes (src/products3d, shared with the packing-line
// simulation), scaled to its real size and printed with its photo. One InstancedMesh per
// packaging type plus one low-poly "far" mesh; instances are re-bucketed by distance as
// the viewer moves. Picking/grabs never touch instanced triangles — they query the proxy
// grid built here, one proxy per shelf slot.

import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ProductLayer, productGeometry, productMaterial } from "./products3d";
import type { ProductAtlas } from "./atlas";
import type { TileSource } from "./tiles";
import type { World } from "./data";

const CELL = 2.0; // spatial-grid cell size (m)
const FACING_GAP = 0.006; // between side-by-side facings (m)
const ROW_GAP = 0.004; // between front-to-back rows (m)
const PRODUCE_TABLE_TOP = 0.7; // fixtures.ts produce table body height (m)
const REBUCKET_MOVE = 0.75; // re-bucket instances after the viewer moved this far (m)

export interface CardInstance {
  productId: number;
  pos: THREE.Vector3; // centre of the front facings' front face
  normal: THREE.Vector3; // facing (axis-aligned)
  w: number; // front facings' total width
  h: number; // product height on the shelf
  min: THREE.Vector3; // proxy AABB (front row)
  max: THREE.Vector3;
  level: number;
}

export interface RayHit {
  card: CardInstance;
  dist: number;
  point: THREE.Vector3;
}

export interface ShelfOptions {
  /** max side-by-side facings per slot */
  maxFacings: number;
  /** max rows front-to-back per slot */
  maxRows: number;
  /** all rows render within this distance (m) */
  nearRadius: number;
  /** front rows render as full packaging within this distance; beyond, as low-poly boxes (m) */
  farRadius: number;
}

/** What a product looks like on the shelf: packaging type, scaled size (m), colour and photo rect. */
export interface ProductLook3D {
  shape: string;
  size: THREE.Vector3;
  color: THREE.Color;
  rect: [number, number, number, number];
}

function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
}

/**
 * The shared product material plus what the store needs on top: labels switch to the
 * streamed 256 px detail tile when the product has a detail slot, a hover tint, and a
 * little self-illumination on labels so studio-lit packshots keep their brightness.
 */
function storeProductMaterial(atlas: THREE.Texture, detail: THREE.Texture, detailGrid: number): THREE.MeshStandardMaterial {
  const m = productMaterial(atlas);
  const shared = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    shared.call(m, shader, renderer);
    shader.uniforms.uDetail = { value: detail };
    shader.uniforms.uDetailGrid = { value: detailGrid };
    const swap = (src: string, find: string, repl: string) => {
      if (!src.includes(find)) throw new Error(`product shader: '${find}' not found — products3d changed?`);
      return src.replace(find, repl);
    };
    shader.vertexShader = swap(
      shader.vertexShader,
      "attribute float aPart;",
      `attribute float aPart;
attribute float aDetail;
attribute float aTint;
varying float vDetail;
varying float vTint;`
    );
    shader.vertexShader = swap(shader.vertexShader, "vRect = aRect;", "vRect = aRect; vDetail = aDetail; vTint = aTint;");
    shader.fragmentShader = swap(
      shader.fragmentShader,
      "varying float vPart;",
      `varying float vPart;
varying float vDetail;
varying float vTint;
uniform sampler2D uDetail;
uniform float uDetailGrid;`
    );
    shader.fragmentShader = swap(
      shader.fragmentShader,
      "c = texture2D(map, luv).rgb;",
      `if (vDetail >= 0.0) {
      vec2 slot = vec2(mod(vDetail, uDetailGrid), floor(vDetail / uDetailGrid)) / uDetailGrid;
      c = texture2D(uDetail, slot + clamp(f, 0.004, 0.996) / uDetailGrid).rgb;
    } else {
      c = texture2D(map, luv).rgb;
    }
    totalEmissiveRadiance += c * 0.35;`
    );
    shader.fragmentShader = swap(
      shader.fragmentShader,
      "diffuseColor.rgb *= c;",
      `diffuseColor.rgb *= c;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.55, 0.35), vTint * 0.30);
  totalEmissiveRadiance += vec3(1.0, 0.45, 0.25) * vTint * 0.18;`
    );
  };
  m.customProgramCacheKey = () => "oda-store-product-v1";
  return m;
}

interface ShapeMesh {
  mesh: THREE.InstancedMesh;
  rect: THREE.InstancedBufferAttribute;
  col: THREE.InstancedBufferAttribute;
  detail: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
}

export class Cards {
  meshes: THREE.InstancedMesh[] = [];
  instances: CardInstance[] = [];
  byProduct = new Map<number, CardInstance[]>();
  private grid = new Map<string, CardInstance[]>();
  detailTexture: THREE.Texture;
  detailGrid: number;
  material: THREE.MeshStandardMaterial;

  // one entry per placed product copy ("facing"), contiguous per card
  private fShape: Uint8Array;
  private fMat: Float32Array;
  private fCard: Int32Array;
  private fFront: Uint8Array;
  private fMesh: Int16Array; // mesh the facing is in right now (-1 = not drawn)
  private fIdx: Int32Array;
  private cardFirst: number[] = [];
  private cardCount: number[] = [];
  private cardRect: Float32Array;
  private cardCol: Float32Array;
  private cardShape: Uint8Array;
  private cardSize: THREE.Vector3[] = [];
  private shapes: string[];
  private shapeMeshes: ShapeMesh[] = [];
  private farIndex: number;
  private detailOf = new Map<number, number>();
  private tintOf = new Map<number, number>();
  private lastViewpoint = new THREE.Vector3(Infinity, 0, Infinity);
  private cardOf = new Map<CardInstance, number>();

  constructor(world: World, private atlas: ProductAtlas, detailSize: number, private opts: ShelfOptions) {
    this.detailGrid = detailSize / 256;
    const fb = new THREE.FramebufferTexture(detailSize, detailSize);
    fb.minFilter = THREE.LinearFilter;
    fb.magFilter = THREE.LinearFilter;
    fb.generateMipmaps = false;
    fb.colorSpace = THREE.SRGBColorSpace;
    this.detailTexture = fb;
    this.material = storeProductMaterial(atlas.texture, fb, this.detailGrid);

    const { layout, atlasIndex, byId, products3d } = world;
    this.shapes = products3d.shapes;

    interface Facing {
      shape: number;
      m: THREE.Matrix4;
      front: boolean;
    }
    const facings: Facing[][] = [];
    const rects: number[] = [];
    const cols: number[] = [];
    const cardShapes: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const color = new THREE.Color();

    for (const run of layout.runs) {
      const kit = layout.kits[run.kind];
      const cos = Math.cos(run.yaw);
      const sin = Math.sin(run.yaw);
      const toWorld = (lx: number, ly: number, lz: number) =>
        new THREE.Vector3(run.x + lx * cos + lz * sin, ly, run.z - lx * sin + lz * cos);
      for (const face of run.faces) {
        // west/south faces look the other way
        const flip = face.side === "west" || face.side === "south";
        const s = flip ? -1 : 1;
        const faceYaw = run.yaw + (flip ? Math.PI : 0);
        for (const slot of face.slots) {
          const p = byId.get(slot.productId);
          const tile = atlasIndex.tiles[String(slot.productId)];
          const item = products3d.items[String(slot.productId)];
          if (!p || !tile || !item) continue;
          const [shapeIdx, wcm, hcm, dcm, hex] = item;

          // usable box on this board: outward distances from the run's centre line
          const level = slot.level;
          // produce tables: the lowest tier sits inside the 0.7 m table body, so goods stand on the top
          const board = run.kind === "produce" ? Math.max(kit.boards[level], PRODUCE_TABLE_TOP) : kit.boards[level];
          let front: number;
          let back: number;
          if (run.kind === "produce") {
            front = (kit.depth * (1 - 0.25 * level)) / 2 - 0.02; // stepped display tiers
            back = 0.03;
          } else if (run.doubleSided) {
            front = kit.depth / 2 - 0.03;
            back = 0.04;
          } else {
            front = kit.depth / 2 - 0.05;
            back = -kit.depth / 2 + 0.07;
          }
          const depth = front - back;
          const next = kit.boards[level + 1];
          const maxH = (next !== undefined ? next : board + 0.45) - board - 0.04;
          const maxW = kit.pitch - 0.025;

          // real size, shrunk only when it would not fit the slot
          const w0 = wcm / 100;
          const h0 = hcm / 100;
          const d0 = dcm / 100;
          const k = Math.min(1, maxW / w0, maxH / h0, depth / d0);
          const w = w0 * k;
          const h = h0 * k;
          const d = d0 * k;
          const nx = Math.max(1, Math.min(this.opts.maxFacings, Math.floor((kit.pitch - 0.01) / (w + FACING_GAP))));
          const nd = Math.max(1, Math.min(this.opts.maxRows, Math.floor(depth / (d + ROW_GAP))));

          const lxSlot = -run.length / 2 + kit.pitch * (slot.index + 0.5);
          const list: Facing[] = [];
          for (let row = 0; row < nd; row++) {
            for (let i = 0; i < nx; i++) {
              const seed = slot.productId * 131 + row * 17 + i;
              const lx = lxSlot + (i - (nx - 1) / 2) * (w + FACING_GAP) + (hash01(seed) - 0.5) * 0.004;
              const lz = s * (front - d / 2 - row * (d + ROW_GAP) - hash01(seed + 3) * 0.006);
              const yaw = faceYaw + (hash01(seed + 5) - 0.5) * 0.07;
              q.setFromAxisAngle(up, yaw);
              const m = new THREE.Matrix4().compose(toWorld(lx, board, lz), q, new THREE.Vector3(w, h, d));
              list.push({ shape: shapeIdx, m, front: row === 0 });
            }
          }
          facings.push(list);
          const r = atlas.remap(tile.atlas, tile.uv);
          rects.push(...r);
          color.set(hex).convertSRGBToLinear();
          cols.push(color.r, color.g, color.b);
          cardShapes.push(shapeIdx);
          this.cardSize.push(new THREE.Vector3(w, h, d));

          // proxy around the front row
          const gw = nx * (w + FACING_GAP);
          const pos = toWorld(lxSlot, board + h / 2, s * front);
          const normal = new THREE.Vector3(Math.sin(faceYaw), 0, Math.cos(faceYaw)).round();
          const pd = Math.max(0.08, d);
          const half = new THREE.Vector3(
            Math.abs(normal.x) > 0 ? pd / 2 : gw / 2,
            h / 2,
            Math.abs(normal.z) > 0 ? pd / 2 : gw / 2
          );
          const center = pos.clone().addScaledVector(normal, -pd / 2 + 0.01);
          const inst: CardInstance = {
            productId: slot.productId,
            pos,
            normal,
            w: gw,
            h,
            min: center.clone().sub(half),
            max: center.clone().add(half),
            level,
          };
          this.cardOf.set(inst, this.instances.length);
          this.instances.push(inst);
          const byP = this.byProduct.get(slot.productId) ?? [];
          byP.push(inst);
          this.byProduct.set(slot.productId, byP);
          const key = this.cellKey(pos.x, pos.z);
          const cell = this.grid.get(key) ?? [];
          cell.push(inst);
          this.grid.set(key, cell);
        }
      }
    }

    // flatten
    const total = facings.reduce((a, l) => a + l.length, 0);
    this.fShape = new Uint8Array(total);
    this.fMat = new Float32Array(total * 16);
    this.fCard = new Int32Array(total);
    this.fFront = new Uint8Array(total);
    this.fMesh = new Int16Array(total).fill(-1);
    this.fIdx = new Int32Array(total);
    this.cardRect = new Float32Array(rects);
    this.cardCol = new Float32Array(cols);
    this.cardShape = new Uint8Array(cardShapes);
    const perShape = new Array(this.shapes.length).fill(0);
    let fronts = 0;
    let n = 0;
    facings.forEach((list, c) => {
      this.cardFirst.push(n);
      this.cardCount.push(list.length);
      for (const f of list) {
        this.fShape[n] = f.shape;
        f.m.toArray(this.fMat, n * 16);
        this.fCard[n] = c;
        this.fFront[n] = f.front ? 1 : 0;
        perShape[f.shape]++;
        if (f.front) fronts++;
        n++;
      }
    });

    // one mesh per packaging type, then the far mesh
    this.shapes.forEach((shape, i) => this.shapeMeshes.push(this.makeMesh(productGeometry(shape), Math.max(1, perShape[i]))));
    this.farIndex = this.shapeMeshes.length;
    this.shapeMeshes.push(this.makeMesh(productGeometry("box"), Math.max(1, fronts)));
    this.meshes = this.shapeMeshes.map((s) => s.mesh);
  }

  private makeMesh(base: THREE.BufferGeometry, cap: number): ShapeMesh {
    // indexed copy: the shared meshes are non-indexed, indexing cuts vertex work ~3×
    const geo = mergeVertices(base.clone());
    const attr = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const rect = attr(4);
    const col = attr(3);
    const detail = attr(1);
    const tint = attr(1);
    geo.setAttribute("aRect", rect);
    geo.setAttribute("aColor", col);
    geo.setAttribute("aDetail", detail);
    geo.setAttribute("aTint", tint);
    const mesh = new THREE.InstancedMesh(geo, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // bounds span the hall
    mesh.count = 0;
    return { mesh, rect, col, detail, tint };
  }

  /** Re-bucket instances by distance (near: every row; mid: front row; far: low-poly boxes). */
  update(viewpoint: THREE.Vector3) {
    const dx = viewpoint.x - this.lastViewpoint.x;
    const dz = viewpoint.z - this.lastViewpoint.z;
    if (dx * dx + dz * dz < REBUCKET_MOVE * REBUCKET_MOVE) return;
    this.lastViewpoint.copy(viewpoint);
    const near2 = this.opts.nearRadius ** 2;
    const far2 = this.opts.farRadius ** 2;
    for (const s of this.shapeMeshes) s.mesh.count = 0;
    for (let c = 0; c < this.instances.length; c++) {
      const inst = this.instances[c];
      const ex = inst.pos.x - viewpoint.x;
      const ez = inst.pos.z - viewpoint.z;
      const d2 = ex * ex + ez * ez;
      const pid = inst.productId;
      const detail = this.detailOf.get(pid) ?? -1;
      const tint = this.tintOf.get(pid) ?? 0;
      const first = this.cardFirst[c];
      for (let f = first; f < first + this.cardCount[c]; f++) {
        let target = -1;
        if (d2 <= near2 || (this.fFront[f] && d2 <= far2)) target = this.fShape[f];
        else if (this.fFront[f]) target = this.farIndex;
        this.fMesh[f] = target;
        if (target < 0) continue;
        const s = this.shapeMeshes[target];
        const i = s.mesh.count++;
        this.fIdx[f] = i;
        (s.mesh.instanceMatrix.array as Float32Array).set(this.fMat.subarray(f * 16, f * 16 + 16), i * 16);
        (s.rect.array as Float32Array).set(this.cardRect.subarray(c * 4, c * 4 + 4), i * 4);
        (s.col.array as Float32Array).set(this.cardCol.subarray(c * 3, c * 3 + 3), i * 3);
        (s.detail.array as Float32Array)[i] = detail;
        (s.tint.array as Float32Array)[i] = tint;
      }
    }
    for (const s of this.shapeMeshes) {
      const n = s.mesh.count;
      for (const [a, size] of [[s.mesh.instanceMatrix, 16], [s.rect, 4], [s.col, 3], [s.detail, 1], [s.tint, 1]] as const) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      }
    }
  }

  /** current triangle/instance counts (debug) */
  stats() {
    let instances = 0;
    let triangles = 0;
    for (const m of this.meshes) {
      instances += m.count;
      triangles += (m.count * m.geometry.index!.count) / 3;
    }
    return { instances, triangles };
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  }

  private writeAll(productId: number, pick: (s: ShapeMesh) => THREE.InstancedBufferAttribute, v: number) {
    for (const inst of this.byProduct.get(productId) ?? []) {
      const c = this.cardOf.get(inst)!;
      for (let f = this.cardFirst[c]; f < this.cardFirst[c] + this.cardCount[c]; f++) {
        const mi = this.fMesh[f];
        if (mi < 0) continue;
        const attr = pick(this.shapeMeshes[mi]);
        (attr.array as Float32Array)[this.fIdx[f]] = v;
        attr.clearUpdateRanges();
        attr.needsUpdate = true;
      }
    }
  }

  setDetailSlot(productId: number, slot: number) {
    if (slot < 0) this.detailOf.delete(productId);
    else this.detailOf.set(productId, slot);
    this.writeAll(productId, (s) => s.detail, slot);
  }

  setTint(productId: number, v: number) {
    if (v === 0) this.tintOf.delete(productId);
    else this.tintOf.set(productId, v);
    this.writeAll(productId, (s) => s.tint, v);
  }

  /** packaging, scaled size and photo rect of a product as it stands on the shelf */
  look(productId: number): ProductLook3D | null {
    const inst = this.byProduct.get(productId)?.[0];
    if (!inst) return null;
    const c = this.cardOf.get(inst)!;
    const r = this.cardRect;
    return {
      shape: this.shapes[this.cardShape[c]],
      size: this.cardSize[c].clone(),
      color: new THREE.Color(this.cardCol[c * 3], this.cardCol[c * 3 + 1], this.cardCol[c * 3 + 2]),
      rect: [r[c * 4], r[c * 4 + 1], r[c * 4 + 2], r[c * 4 + 3]],
    };
  }

  /**
   * A standalone 3D copy of a product (for holding in VR): starts with the atlas photo and
   * swaps to the sharp 256 px tile once it has streamed in. Origin at the product's centre.
   */
  productObject(productId: number, tiles: TileSource, scale = 1): THREE.Object3D {
    const look = this.look(productId);
    const g = new THREE.Group();
    if (!look) return g;
    const mat = productMaterial(this.atlas.texture);
    mat.envMap = this.material.envMap;
    mat.envMapIntensity = this.material.envMapIntensity;
    const layer = new ProductLayer(mat, 1, false);
    const size = look.size.clone().multiplyScalar(scale);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, -size.y / 2, 0), new THREE.Quaternion(), size);
    const fill = (rect: readonly number[]) => {
      layer.begin();
      layer.add({ shape: look.shape, rect, color: look.color }, m);
      layer.end();
    };
    fill(look.rect);
    g.add(layer.group);
    void tiles.bitmap(productId).then((bmp) => {
      if (!bmp) return;
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex;
      mat.needsUpdate = true;
      fill([0, 0, 1, 1]);
    });
    return g;
  }

  /** all instances whose position is within radius of p (XZ circle, cheap) */
  near(p: THREE.Vector3, radius: number): CardInstance[] {
    const out: CardInstance[] = [];
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.z / CELL);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const cell = this.grid.get(`${cx + i},${cz + j}`);
        if (!cell) continue;
        for (const inst of cell) {
          const dx = inst.pos.x - p.x;
          const dz = inst.pos.z - p.z;
          if (dx * dx + dz * dz <= radius * radius) out.push(inst);
        }
      }
    }
    return out;
  }

  /** closest proxy hit along the ray, or null. inflate expands each AABB (m). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, inflate = 0): RayHit | null {
    let best: RayHit | null = null;
    const steps = Math.ceil(maxDist / CELL) + 1;
    const visited = new Set<string>();
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * maxDist;
      const px = origin.x + dir.x * t;
      const pz = origin.z + dir.z * t;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const key = `${Math.floor(px / CELL) + i},${Math.floor(pz / CELL) + j}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const cell = this.grid.get(key);
          if (!cell) continue;
          for (const inst of cell) {
            const d = rayBox(origin, dir, inst.min, inst.max, inflate);
            if (d !== null && d <= maxDist && (!best || d < best.dist)) {
              best = { card: inst, dist: d, point: origin.clone().addScaledVector(dir, d) };
            }
          }
        }
      }
    }
    return best;
  }

  /** does the ray clip this product's inflated proxy? (sticky target-loss test) */
  clips(origin: THREE.Vector3, dir: THREE.Vector3, productId: number, maxDist: number, inflate: number): boolean {
    for (const inst of this.byProduct.get(productId) ?? []) {
      const d = rayBox(origin, dir, inst.min, inst.max, inflate);
      if (d !== null && d <= maxDist) return true;
    }
    return false;
  }
}

function rayBox(o: THREE.Vector3, d: THREE.Vector3, min: THREE.Vector3, max: THREE.Vector3, inflate: number): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const mins = [min.x - inflate, min.y - inflate, min.z - inflate];
  const maxs = [max.x + inflate, max.y + inflate, max.z + inflate];
  const os = [o.x, o.y, o.z];
  const ds = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(ds[a]) < 1e-9) {
      if (os[a] < mins[a] || os[a] > maxs[a]) return null;
      continue;
    }
    let t1 = (mins[a] - os[a]) / ds[a];
    let t2 = (maxs[a] - os[a]) / ds[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
