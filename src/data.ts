// Catalog / layout / atlas-index loading and types (ADR-0001, ADR-0005 contracts).

export interface Product {
  id: number;
  name: string;
  extra: string;
  brand: string;
  price: string;
  unitPrice: string;
  url: string;
  aspect: number; // clamped [0.4, 2.5]
  classifiers: string[];
  paths: string[][];
}

export interface Catalog {
  fetchedAt: string;
  currency: string;
  schemaVersion: number;
  catalogHash: string;
  products: Product[];
}

export interface Kit {
  boards: number[];
  pitch: number;
  depth: number;
  cardW: number;
  cardH: number;
  height: number;
}

export interface Slot {
  level: number;
  index: number;
  productId: number;
}

export interface Face {
  side: string;
  slots: Slot[];
}

export interface Run {
  id: string;
  kind: string; // gondola | fridge | freezer | produce | bakery
  zone: string;
  x: number;
  z: number;
  yaw: number;
  length: number;
  doubleSided?: boolean;
  faces: Face[];
  sign: string;
}

export interface Layout {
  schemaVersion: number;
  catalogHash: string;
  hall: {
    w: number;
    d: number;
    entrance: { x: number; z: number; yaw: number };
    spawn: { x: number; z: number; yaw: number };
    checkout: { x: number; z: number }[];
  };
  kits: Record<string, Kit>;
  runs: Run[];
  directory: { zone: string; label: string }[];
}

export interface AtlasIndex {
  schemaVersion: number;
  catalogHash: string;
  atlasCount: number;
  cell: number;
  gutter: number;
  size: number;
  detailPages: number;
  detailTile: number;
  detailGrid: number;
  format: "png" | "ktx2";
  vOrigin: "top";
  tiles: Record<string, { atlas: number; uv: [number, number, number, number]; d?: [number, number, number] }>;
}

/** Per-product packaging (public/products3d.json, built by scripts/build_products3d.py). */
export interface Products3D {
  schemaVersion: number;
  catalogHash: string;
  shapes: string[];
  /** id -> [shape index, w, h, d (cm), sRGB hex colour] */
  items: Record<string, [number, number, number, number, string]>;
}

export interface World {
  catalog: Catalog;
  layout: Layout;
  atlasIndex: AtlasIndex;
  products3d: Products3D;
  byId: Map<number, Product>;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadWorld(onProgress: (msg: string) => void): Promise<World> {
  onProgress("Henter katalog…");
  const [catalog, layout, atlasIndex, products3d] = await Promise.all([
    getJson<Catalog>("catalog.json"),
    getJson<Layout>("layout.json"),
    getJson<AtlasIndex>("atlas-index.json"),
    getJson<Products3D>("products3d.json"),
  ]);
  if (
    layout.catalogHash !== catalog.catalogHash ||
    atlasIndex.catalogHash !== catalog.catalogHash ||
    products3d.catalogHash !== catalog.catalogHash
  ) {
    throw new Error("layout/atlas snapshot does not match catalog — re-run the pipeline");
  }
  const byId = new Map(catalog.products.map((p) => [p.id, p]));
  return { catalog, layout, atlasIndex, products3d, byId };
}

// Descriptions are a lazily-fetched chunk (ADR-0002 loading budget).
let descriptions: Record<string, string> | null = null;
let descPromise: Promise<Record<string, string>> | null = null;

export async function getDescription(id: number): Promise<string> {
  if (!descriptions) {
    descPromise ??= getJson<Record<string, string>>("descriptions.json");
    descriptions = await descPromise;
  }
  return descriptions[String(id)] ?? "";
}
