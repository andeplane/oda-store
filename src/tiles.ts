// Detail tiles ship as packed 2048² JPEG pages (64 tiles each, shelf-ordered) —
// GitHub Pages cannot deploy 5k individual files, and page locality means one
// fetch warms a whole shelf run. This service fetches pages (small LRU) and
// crops per-product bitmaps out of them.

import type { AtlasIndex } from "./data";

const MAX_PAGES = 12;

export class TileSource {
  private pages = new Map<number, Promise<Blob>>();
  private order: number[] = [];

  constructor(private index: AtlasIndex) {}

  has(id: number): boolean {
    return !!this.index.tiles[String(id)]?.d;
  }

  /** cropped, unflipped bitmap of the product's 256px tile, or null when unknown */
  async bitmap(id: number): Promise<ImageBitmap | null> {
    const entry = this.index.tiles[String(id)];
    if (!entry?.d) return null;
    const [page, col, row] = entry.d;
    let blobP = this.pages.get(page);
    if (!blobP) {
      blobP = fetch(`atlas/tiles-${page}.jpg`).then((r) => {
        if (!r.ok) throw new Error(`tiles-${page}: ${r.status}`);
        return r.blob();
      });
      this.pages.set(page, blobP);
      this.order.push(page);
      while (this.order.length > MAX_PAGES) this.pages.delete(this.order.shift()!);
    }
    const blob = await blobP;
    const T = this.index.detailTile;
    try {
      return await createImageBitmap(blob, col * T, row * T, T, T);
    } catch {
      return null;
    }
  }

  /** draw the product tile into a canvas element (for HUD panel / cart rows) */
  async draw(canvas: HTMLCanvasElement, id: number, size = 256): Promise<void> {
    const bmp = await this.bitmap(id);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    if (bmp) {
      ctx.drawImage(bmp, 0, 0, size, size);
      bmp.close();
    }
  }
}
