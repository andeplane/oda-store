// Store shell + fixture kits (ADR-0005 geometry via layout.json's kit registry).
// Static geometry merges into a handful of meshes; signs use cached canvas textures.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Layout, Run } from "./data";

export interface FixtureWorld {
  group: THREE.Group;
  colliders: { min: THREE.Vector3; max: THREE.Vector3 }[];
}

const MATS = {
  shelf: new THREE.MeshStandardMaterial({ color: 0xf1f1f4, roughness: 0.85, metalness: 0.05 }),
  plinth: new THREE.MeshStandardMaterial({ color: 0x2b2e35, roughness: 0.9 }),
  fridge: new THREE.MeshStandardMaterial({ color: 0x394048, roughness: 0.6, metalness: 0.3 }),
  fridgeGlow: new THREE.MeshBasicMaterial({ color: 0xd9ecff }),
  freezer: new THREE.MeshStandardMaterial({ color: 0xcfd8e2, roughness: 0.5, metalness: 0.2 }),
  freezerGlow: new THREE.MeshBasicMaterial({ color: 0xeaf6ff }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9a713f, roughness: 0.8 }),
  desk: new THREE.MeshStandardMaterial({ color: 0x3c414c, roughness: 0.7 }),
};

function box(w: number, h: number, d: number, x: number, y: number, z: number, yaw: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(yaw);
  g.translate(x, y, z);
  return g;
}

const signCache = new Map<string, THREE.CanvasTexture>();

function signTexture(text: string, bg: string): THREE.CanvasTexture {
  const key = `${text}|${bg}`;
  let tex = signCache.get(key);
  if (tex) return tex;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 52px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.toUpperCase(), c.width / 2, c.height / 2 + 2);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  signCache.set(key, tex);
  return tex;
}

const ZONE_COLORS: Record<string, string> = {
  "Frukt & grønt": "#4c9e53", Bakeri: "#b07c3f", "Kjøtt & fisk": "#c25049",
  "Meieri & egg": "#4a84c4", Pålegg: "#d5a02f", "Middag & tilbehør": "#d97a4b",
  "Tørrvarer & frokost": "#8a7f56", Frossent: "#57a7c9", Drikke: "#3fa8a0",
  "Snacks & søtt": "#9a5fb5", "Hjem & helse": "#77706b", "Kiosk & diverse": "#5b6570",
};

function buildRun(run: Run, layout: Layout, parts: Record<string, THREE.BufferGeometry[]>, signs: THREE.Group) {
  const kit = layout.kits[run.kind];
  const L = run.length;
  const yaw = run.yaw;
  const x = run.x;
  const z = run.z;
  const isFridge = run.kind === "fridge";
  const isFreezer = run.kind === "freezer";
  const isProduce = run.kind === "produce";
  const bodyMat = isFridge ? "fridge" : isFreezer ? "freezer" : run.kind === "bakery" ? "wood" : "shelf";

  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const local = (lx: number, ly: number, lz: number): [number, number, number] => [
    x + lx * cos + lz * sin,
    ly,
    z - lx * sin + lz * cos,
  ];

  if (isProduce) {
    const [tx, ty, tz] = local(0, 0.35, 0);
    parts.wood.push(box(L, 0.7, kit.depth, tx, ty, tz, yaw));
    for (const b of kit.boards) {
      const [bx, by, bz] = local(0, b - 0.02, 0);
      parts.wood.push(box(L, 0.04, kit.depth * (1 - 0.25 * kit.boards.indexOf(b)), bx, by, bz, yaw));
    }
    return;
  }

  // back panel + plinth + sides + boards
  const [px, py, pz] = local(0, 0.07, 0);
  parts.plinth.push(box(L, 0.14, kit.depth, px, py, pz, yaw));
  const backLz = run.doubleSided ? 0 : -kit.depth / 2 + 0.03;
  const [bx, by, bz] = local(0, kit.height / 2, backLz);
  parts[bodyMat].push(box(L, kit.height, 0.06, bx, by, bz, yaw));
  for (const s of [-1, 1]) {
    const [sx, sy, sz] = local((s * L) / 2, kit.height / 2, 0);
    parts[bodyMat].push(box(0.05, kit.height, kit.depth, sx, sy, sz, yaw));
  }
  const sides = run.doubleSided ? [-1, 1] : [1];
  for (const level of kit.boards) {
    for (const side of sides) {
      const lz = run.doubleSided ? (side * kit.depth) / 4 : 0;
      const depth = run.doubleSided ? kit.depth / 2 - 0.04 : kit.depth - 0.08;
      const [ox, oy, oz] = local(0, level - 0.02, lz);
      parts[bodyMat].push(box(L, 0.04, depth, ox, oy, oz, yaw));
    }
  }
  // top + light strip for cold fixtures
  const [tx2, ty2, tz2] = local(0, kit.height + 0.04, 0);
  parts[bodyMat].push(box(L, 0.08, kit.depth, tx2, ty2, tz2, yaw));
  if (isFridge || isFreezer) {
    for (const side of sides) {
      const lz = (run.doubleSided ? side : 1) * (kit.depth / 2 - 0.05);
      const [gx, gy, gz] = local(0, kit.height - 0.1, lz);
      parts[isFridge ? "fridgeGlow" : "freezerGlow"].push(box(L * 0.96, 0.05, 0.03, gx, gy, gz, yaw));
    }
  }

  // sign above each face
  const color = ZONE_COLORS[run.sign] ?? "#5b6570";
  for (const side of run.doubleSided ? [-1, 1] : [1]) {
    const [sx, sy, sz] = local(0, kit.height + 0.35, side * 0.12);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(L * 0.8, 4.5), 0.5),
      new THREE.MeshBasicMaterial({ map: signTexture(run.sign, color) })
    );
    sign.position.set(sx, sy, sz);
    sign.rotation.y = yaw + (side < 0 ? Math.PI : 0);
    signs.add(sign);
  }
}

export function buildFixtures(layout: Layout): FixtureWorld {
  const group = new THREE.Group();
  const colliders: FixtureWorld["colliders"] = [];
  const parts: Record<string, THREE.BufferGeometry[]> = {
    shelf: [], plinth: [], fridge: [], fridgeGlow: [], freezer: [], freezerGlow: [], wood: [], desk: [],
  };
  const signs = new THREE.Group();

  for (const run of layout.runs) {
    buildRun(run, layout, parts, signs);
    // collision envelope
    const kit = layout.kits[run.kind];
    const alongX = Math.abs(Math.cos(run.yaw)) > 0.5;
    const hx = alongX ? run.length / 2 : kit.depth / 2;
    const hz = alongX ? kit.depth / 2 : run.length / 2;
    colliders.push({
      min: new THREE.Vector3(run.x - hx, 0, run.z - hz),
      max: new THREE.Vector3(run.x + hx, kit.height, run.z + hz),
    });
  }

  // checkout desks
  for (const c of layout.hall.checkout) {
    parts.desk.push(box(2.6, 0.92, 1.0, c.x, 0.46, c.z, 0));
    parts.plinth.push(box(2.2, 0.06, 0.8, c.x - 0.1, 0.95, c.z, 0));
    colliders.push({
      min: new THREE.Vector3(c.x - 1.3, 0, c.z - 0.5),
      max: new THREE.Vector3(c.x + 1.3, 1.0, c.z + 0.5),
    });
  }

  for (const [name, geos] of Object.entries(parts)) {
    if (!geos.length) continue;
    const merged = mergeGeometries(geos);
    const mesh = new THREE.Mesh(merged, MATS[name as keyof typeof MATS]);
    group.add(mesh);
  }
  group.add(signs);

  // entrance directory board
  const dirText = layout.directory.map((d) => d.label).join("  ·  ");
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 0.6),
    new THREE.MeshBasicMaterial({ map: signTexture(dirText.slice(0, 60), "#2b2e35") })
  );
  board.position.set(layout.hall.entrance.x, 2.6, layout.hall.entrance.z + 0.6);
  group.add(board);

  return { group, colliders };
}

export function buildShell(layout: Layout): THREE.Group {
  const g = new THREE.Group();
  const W = layout.hall.w;
  const D = layout.hall.d;
  const H = 4.0;

  // floor (procedural tiles)
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  for (let ty = 0; ty < 2; ty++)
    for (let tx = 0; tx < 2; tx++) {
      const s = 226 + ((tx + ty) % 2) * 5 + Math.floor(Math.random() * 4);
      ctx.fillStyle = `rgb(${s},${s},${s + 2})`;
      ctx.fillRect(tx * 256, ty * 256, 256, 256);
    }
  ctx.strokeStyle = "rgba(140,142,150,0.5)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 2; i++) {
    ctx.strokeRect(i * 256, 0, 0.1, 512);
    ctx.strokeRect(0, i * 256, 512, 0.1);
  }
  const floorTex = new THREE.CanvasTexture(c);
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  floorTex.repeat.set(W / 2, D / 2);
  floorTex.colorSpace = THREE.SRGBColorSpace;
  floorTex.anisotropy = 8;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.6 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, D / 2);
  g.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xdcdde2, roughness: 0.92 });
  const mkWall = (w: number, x: number, z: number, yaw: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, H), wallMat);
    m.position.set(x, H / 2, z);
    m.rotation.y = yaw;
    g.add(m);
  };
  mkWall(W, W / 2, D, Math.PI); // back (faces into store)
  mkWall(W, W / 2, 0, 0); // front
  mkWall(D, 0, D / 2, Math.PI / 2); // left
  mkWall(D, W, D / 2, -Math.PI / 2); // right

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.95 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(W / 2, H, D / 2);
  g.add(ceiling);

  // light strips over aisles
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xf5f7ff });
  const strips: THREE.BufferGeometry[] = [];
  for (let x = 4; x < W - 2; x += 4.4) {
    for (let z = 6; z < D - 4; z += 8) {
      strips.push(box(0.35, 0.07, 5.0, x, H - 0.12, z, 0));
    }
  }
  g.add(new THREE.Mesh(mergeGeometries(strips), stripMat));

  // logo over entrance
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 0.8),
    new THREE.MeshBasicMaterial({ map: signTexture("Oda Virtual Store", "#ff5230") })
  );
  logo.position.set(layout.hall.entrance.x, 3.1, 0.02);
  g.add(logo);

  // lights
  g.add(new THREE.HemisphereLight(0xffffff, 0x8a8d94, 1.1));
  const dir = new THREE.DirectionalLight(0xfff4e0, 0.8);
  dir.position.set(W / 2 + 8, 12, D / 2 - 6);
  g.add(dir);
  const dir2 = new THREE.DirectionalLight(0xdfeaff, 0.35);
  dir2.position.set(W / 2 - 10, 10, D / 2 + 8);
  g.add(dir2);

  return g;
}
