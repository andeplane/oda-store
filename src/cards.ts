// Instanced product cards + proxy grid (ADR-0002). All ~7k cards render as one
// InstancedMesh per base atlas with an unlit shader; picking/grabs never touch
// instanced triangles — they query the proxy grid built here.

import * as THREE from "three";
import type { World } from "./data";

const PROXY_DEPTH = 0.08; // grab/ray proxy thickness in front of the card face
const CELL = 2.0; // spatial-grid cell size (m)

export interface CardInstance {
  productId: number;
  atlas: number;
  indexInMesh: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3; // facing (axis-aligned)
  w: number;
  h: number;
  min: THREE.Vector3; // proxy AABB
  max: THREE.Vector3;
  level: number;
}

export interface RayHit {
  card: CardInstance;
  dist: number;
  point: THREE.Vector3;
}

const VERT = /* glsl */ `
attribute vec4 aUvRect;
attribute float aDetail;
attribute float aTint;
varying vec2 vUv;
varying vec4 vUvRect;
varying float vDetail;
varying float vTint;
void main() {
  vUv = uv;
  vUvRect = aUvRect;
  vDetail = aDetail;
  vTint = aTint;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform sampler2D uDetail;
uniform float uDetailGrid;
varying vec2 vUv;
varying vec4 vUvRect;
varying float vDetail;
varying float vTint;
void main() {
  vec3 col;
  if (vDetail >= 0.0) {
    float g = uDetailGrid;
    vec2 slotOrigin = vec2(mod(vDetail, g), floor(vDetail / g)) / g;
    col = texture2D(uDetail, slotOrigin + vUv / g).rgb;
  } else {
    col = texture2D(uAtlas, mix(vUvRect.xy, vUvRect.zw, vUv)).rgb;
  }
  col = mix(col, vec3(1.0, 0.55, 0.35), vTint * 0.30) * (1.0 + vTint * 0.18);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 0xffffffff;
}

export class Cards {
  meshes: THREE.InstancedMesh[] = [];
  instances: CardInstance[] = [];
  byProduct = new Map<number, CardInstance[]>();
  private grid = new Map<string, CardInstance[]>();
  private detailAttrs: THREE.InstancedBufferAttribute[] = [];
  private tintAttrs: THREE.InstancedBufferAttribute[] = [];
  detailTexture: THREE.Texture;
  detailGrid: number;

  constructor(world: World, atlasTextures: THREE.Texture[], detailSize: number) {
    this.detailGrid = detailSize / 256;
    const fb = new THREE.FramebufferTexture(detailSize, detailSize);
    fb.minFilter = THREE.LinearFilter;
    fb.magFilter = THREE.LinearFilter;
    fb.generateMipmaps = false;
    fb.colorSpace = THREE.SRGBColorSpace;
    this.detailTexture = fb;

    const { layout, atlasIndex, byId } = world;

    // gather per-atlas card lists first
    interface Pending {
      productId: number;
      atlas: number;
      uv: [number, number, number, number];
      pos: THREE.Vector3;
      yaw: number;
      w: number;
      h: number;
      level: number;
    }
    const perAtlas: Pending[][] = Array.from({ length: atlasIndex.atlasCount }, () => []);

    for (const run of layout.runs) {
      const kit = layout.kits[run.kind];
      const cos = Math.cos(run.yaw);
      const sin = Math.sin(run.yaw);
      for (const face of run.faces) {
        // face plane offset along local z; west/south faces look the other way
        const flip = face.side === "west" || face.side === "south";
        const faceYaw = run.yaw + (flip ? Math.PI : 0);
        const lz = (flip ? -1 : 1) * (kit.depth / 2 - 0.06);
        for (const slot of face.slots) {
          const p = byId.get(slot.productId);
          const tile = atlasIndex.tiles[String(slot.productId)];
          if (!p || !tile) continue;
          let h = kit.cardH;
          let w = h * p.aspect;
          if (w > kit.cardW) {
            w = kit.cardW;
            h = w / p.aspect;
          }
          const lx = -run.length / 2 + kit.pitch * (slot.index + 0.5);
          const ly = kit.boards[slot.level] + h / 2 + 0.01;
          const wx = run.x + lx * cos + lz * sin;
          const wz = run.z - lx * sin + lz * cos;
          perAtlas[tile.atlas].push({
            productId: slot.productId,
            atlas: tile.atlas,
            uv: tile.uv,
            pos: new THREE.Vector3(wx, ly, wz),
            yaw: faceYaw + (hash01(slot.productId) - 0.5) * 0.1,
            w: w * (0.98 + hash01(slot.productId + 1) * 0.04),
            h,
            level: slot.level,
          });
        }
      }
    }

    const mat4 = new THREE.Matrix4();
    const quatT = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scl = new THREE.Vector3();

    perAtlas.forEach((cards, atlasN) => {
      const n = cards.length;
      const uvRect = new Float32Array(n * 4);
      const detail = new Float32Array(n).fill(-1);
      const tint = new Float32Array(n);

      const material = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uAtlas: { value: atlasTextures[atlasN] },
          uDetail: { value: this.detailTexture },
          uDetailGrid: { value: this.detailGrid },
        },
      });
      const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, n);
      mesh.frustumCulled = false;

      cards.forEach((c, i) => {
        quatT.setFromAxisAngle(up, c.yaw);
        scl.set(c.w, c.h, 1);
        mat4.compose(c.pos, quatT, scl);
        mesh.setMatrixAt(i, mat4);
        // atlas png: v origin top, flipY=true at load -> v_gl = 1 - y
        uvRect[i * 4 + 0] = c.uv[0];
        uvRect[i * 4 + 1] = 1 - c.uv[3];
        uvRect[i * 4 + 2] = c.uv[2];
        uvRect[i * 4 + 3] = 1 - c.uv[1];

        const normal = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)).round();
        const half = new THREE.Vector3(
          Math.abs(normal.x) > 0 ? PROXY_DEPTH : c.w / 2,
          c.h / 2,
          Math.abs(normal.z) > 0 ? PROXY_DEPTH : c.w / 2
        );
        const center = c.pos.clone().addScaledVector(normal, PROXY_DEPTH / 2);
        const inst: CardInstance = {
          productId: c.productId,
          atlas: atlasN,
          indexInMesh: i,
          pos: c.pos,
          normal,
          w: c.w,
          h: c.h,
          min: center.clone().sub(half),
          max: center.clone().add(half),
          level: c.level,
        };
        this.instances.push(inst);
        const list = this.byProduct.get(c.productId) ?? [];
        list.push(inst);
        this.byProduct.set(c.productId, list);
        const key = this.cellKey(c.pos.x, c.pos.z);
        const cell = this.grid.get(key) ?? [];
        cell.push(inst);
        this.grid.set(key, cell);
      });

      const uvAttr = new THREE.InstancedBufferAttribute(uvRect, 4);
      const dAttr = new THREE.InstancedBufferAttribute(detail, 1);
      dAttr.setUsage(THREE.DynamicDrawUsage);
      const tAttr = new THREE.InstancedBufferAttribute(tint, 1);
      tAttr.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute("aUvRect", uvAttr);
      mesh.geometry.setAttribute("aDetail", dAttr);
      mesh.geometry.setAttribute("aTint", tAttr);
      this.detailAttrs[atlasN] = dAttr;
      this.tintAttrs[atlasN] = tAttr;
      this.meshes.push(mesh);
    });
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  }

  setDetailSlot(productId: number, slot: number) {
    for (const inst of this.byProduct.get(productId) ?? []) {
      const attr = this.detailAttrs[inst.atlas];
      (attr.array as Float32Array)[inst.indexInMesh] = slot;
      attr.needsUpdate = true;
    }
  }

  setTint(productId: number, v: number) {
    for (const inst of this.byProduct.get(productId) ?? []) {
      const attr = this.tintAttrs[inst.atlas];
      (attr.array as Float32Array)[inst.indexInMesh] = v;
      attr.needsUpdate = true;
    }
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
