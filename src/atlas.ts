// The six 2048² base atlases combined into one texture so every 3D product can share one
// material (adapted from groceries-manufacturing's loadProductAtlas). Product tiles keep
// their 64 px cells when the GPU allows a 6144-wide texture; otherwise cells are halved.

import * as THREE from "three";

export interface ProductAtlas {
  texture: THREE.Texture;
  /** atlas-index uv rect (v from the top) -> [u0, v0, u1, v1] in the combined texture (v up) */
  remap: (atlas: number, uv: readonly number[]) => [number, number, number, number];
}

export function probeMaxTextureSize(): number {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    return gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096;
  } catch {
    return 4096;
  }
}

export async function loadProductAtlas(
  count: number,
  format: string,
  maxTextureSize: number,
  onOne: () => void
): Promise<ProductAtlas> {
  const cols = 3;
  const rows = Math.ceil(count / cols);
  const cell = maxTextureSize >= 2048 * Math.max(cols, rows) ? 2048 : 1024;
  const c = document.createElement("canvas");
  c.width = cols * cell;
  c.height = rows * cell;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#f4f4f6";
  ctx.fillRect(0, 0, c.width, c.height);
  await Promise.all(
    Array.from(
      { length: count },
      (_, i) =>
        new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, (i % cols) * cell, Math.floor(i / cols) * cell, cell, cell);
            onOne();
            resolve();
          };
          img.onerror = () => reject(new Error(`atlas/base-${i}: failed to load`));
          img.src = `atlas/base-${i}.${format === "ktx2" ? "ktx2" : "png"}`;
        })
    )
  );
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2; // tile gutters are the real bleed defense (ADR-0002)
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.userData.shared = true;
  const remap = (atlas: number, uv: readonly number[]): [number, number, number, number] => {
    const col = atlas % cols;
    const row = Math.floor(atlas / cols);
    const U = (u: number) => (col + u) / cols;
    const V = (v: number) => 1 - (row + v) / rows; // canvas rows run down, texture v runs up
    return [U(uv[0]), V(uv[3]), U(uv[2]), V(uv[1])];
  };
  return { texture, remap };
}
