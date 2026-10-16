import * as THREE from 'three';
import { productGeometry } from './geometry';

/** What the layer needs to know about a product. */
export interface ProductLook {
  shape: string;
  /** Atlas rect [u0, v0, u1, v1] in texture space. */
  rect: readonly number[];
  /** Linear RGB package colour. */
  color: THREE.Color;
}

/**
 * One InstancedMesh per packaging type. Fill once (static shelves) or every frame:
 * begin(), add(look, matrix) ..., end(). The matrix should include the product's w×h×d scale.
 */
export class ProductLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<string, { mesh: THREE.InstancedMesh; rect: THREE.InstancedBufferAttribute; col: THREE.InstancedBufferAttribute; n: number; cap: number }>();

  constructor(private material: THREE.Material, private capacity = 256, private castShadow = true) {}

  private grow(shape: string, need: number) {
    const old = this.meshes.get(shape);
    const cap = Math.max(this.capacity, Math.ceil(need * 1.6));
    const geo = productGeometry(shape).clone();
    const rect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    rect.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aRect', rect);
    geo.setAttribute('aColor', col);
    const mesh = new THREE.InstancedMesh(geo, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = this.castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const e = { mesh, rect, col, n: 0, cap };
    if (old) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < old.n; i++) {
        old.mesh.getMatrixAt(i, m);
        mesh.setMatrixAt(i, m);
        rect.setXYZW(i, old.rect.getX(i), old.rect.getY(i), old.rect.getZ(i), old.rect.getW(i));
        col.setXYZ(i, old.col.getX(i), old.col.getY(i), old.col.getZ(i));
      }
      e.n = old.n;
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
      old.mesh.dispose();
    }
    this.meshes.set(shape, e);
    this.group.add(mesh);
    return e;
  }

  begin(): void {
    for (const e of this.meshes.values()) e.n = 0;
  }

  add(look: ProductLook, matrix: THREE.Matrix4): void {
    let e = this.meshes.get(look.shape);
    if (!e || e.n >= e.cap) e = this.grow(look.shape, (e?.n ?? 0) + 1);
    e.mesh.setMatrixAt(e.n, matrix);
    const r = look.rect;
    e.rect.setXYZW(e.n, r[0], r[1], r[2], r[3]);
    e.col.setXYZ(e.n, look.color.r, look.color.g, look.color.b);
    e.n++;
  }

  end(): void {
    for (const e of this.meshes.values()) {
      e.mesh.count = e.n;
      e.mesh.instanceMatrix.needsUpdate = true;
      e.rect.needsUpdate = true;
      e.col.needsUpdate = true;
    }
  }
}
