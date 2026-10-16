/**
 * Procedural base meshes for the 35 Oda packaging types (data/geometries.json).
 *
 * Every mesh is normalised to the unit box [-0.5,0.5]×[0,1]×[-0.5,0.5] (origin at the bottom
 * centre, +z = front) and is scaled per product to its outer w×h×d. Each vertex carries a
 * `aPart` material slot (see PART) and a `uv` that is only meaningful on LABEL parts, where the
 * product photo is printed (u may run past 1 to repeat the label around a cylinder).
 *
 * Standalone: depends only on three.js, so it can be dropped into other projects (e.g. oda-store).
 */
import * as THREE from 'three';

export const PART = {
  BODY: 0, // product colour
  LABEL: 1, // product photo
  CAP: 2, // darker product colour (lids, caps)
  WHITE: 3, // white plastic / paper
  METAL: 4, // tin, aluminium
  CLEAR: 5, // clear plastic / glass, tinted by the product colour
  DARK_GLASS: 6, // wine/oil bottles
  LEAF: 7, // plant green
  BROWN: 8, // stems, crusts, terracotta
} as const;

export const SHAPE_TYPES = [
  'can', 'pet_bottle', 'glass_bottle', 'jug', 'squeeze_bottle', 'pump_bottle', 'aerosol', 'gable_carton',
  'brick_carton', 'box', 'jar', 'tub', 'tray', 'vacuum_pack', 'block', 'bar', 'pillow_bag', 'standup_pouch',
  'paper_sack', 'sachet', 'tube', 'loaf', 'produce_round', 'produce_long', 'net_bag', 'clamshell', 'egg_carton',
  'multipack', 'roll_pack', 'soft_pack', 'flat_pack', 'blister_card', 'potted_plant', 'bouquet', 'irregular',
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

interface Piece {
  geo: THREE.BufferGeometry;
  part: (vertex: number, geo: THREE.BufferGeometry) => number;
}

// ---------------------------------------------------------------- building blocks

/** Profile point for a lathe: radius, height, part. Repeat a point to make a hard part boundary. */
type PP = [number, number, number];

/**
 * Lathe with per-profile-point parts. Label parts get uv = (2 copies around, 0..1 over the label band)
 * with the label centred on +z.
 */
function lathe(profile: PP[], segments = 28, label?: [number, number]): Piece {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const geo = new THREE.LatheGeometry(pts, segments);
  const n = profile.length;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  if (label) {
    for (let k = 0; k < uv.count; k++) {
      const i = Math.floor(k / n);
      const y = pos.getY(k);
      uv.setXY(k, (i / segments) * 2 + 0.5, (y - label[0]) / (label[1] - label[0]));
    }
  }
  return { geo, part: (v) => profile[v % n][2] };
}

/** Box with a part per face (+x, -x, +y, -y, +z, -z). */
function box(w: number, h: number, d: number, at: [number, number, number], faces: [number, number, number, number, number, number], seg: [number, number, number] = [1, 1, 1]): Piece {
  const geo = new THREE.BoxGeometry(w, h, d, ...seg).translate(at[0], at[1], at[2]);
  const groups = geo.groups;
  const idx = geo.index!;
  const vPart = new Map<number, number>();
  groups.forEach((g, f) => {
    for (let k = g.start; k < g.start + g.count; k++) vPart.set(idx.getX(k), faces[f]);
  });
  return { geo, part: (v) => vPart.get(v) ?? faces[0] };
}

function solid(geo: THREE.BufferGeometry, part: number): Piece {
  return { geo, part: () => part };
}

/** Deform a piece's positions in place. */
function warp(p: Piece, f: (v: THREE.Vector3) => void): Piece {
  const pos = p.geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    f(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  p.geo.computeVertexNormals();
  return p;
}

function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Merge pieces into one non-indexed geometry with position/normal/uv/aPart, normalised to the unit box. */
function assemble(pieces: Piece[]): THREE.BufferGeometry {
  const P: number[] = [];
  const N: number[] = [];
  const U: number[] = [];
  const A: number[] = [];
  for (const pc of pieces) {
    const g = pc.geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
    const uv = g.attributes.uv;
    const index = g.index;
    const count = index ? index.count : pos.count;
    for (let k = 0; k < count; k++) {
      const v = index ? index.getX(k) : k;
      P.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      N.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
      U.push(uv ? uv.getX(v) : 0, uv ? uv.getY(v) : 0);
      A.push(pc.part(v, g));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(A, 1));
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  const s = new THREE.Vector3();
  b.getSize(s);
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.scale(1 / Math.max(s.x, 1e-6), 1 / Math.max(s.y, 1e-6), 1 / Math.max(s.z, 1e-6));
  // Normals must follow the non-uniform normalisation scale.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < nrm.count; i++) {
    v.fromBufferAttribute(nrm, i).multiply(s).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const { BODY, LABEL, CAP, WHITE, METAL, CLEAR, DARK_GLASS, LEAF, BROWN } = PART;
const L = LABEL;

/** A rounded-edge box: box faces with label on front/back, edges softened by pushing corners in. */
function softBox(w: number, h: number, d: number, faces: [number, number, number, number, number, number], round = 0.15, seg = 6): Piece {
  const p = box(w, h, d, [0, h / 2, 0], faces, [seg, seg, seg]);
  return warp(p, (v) => {
    const nx = (2 * v.x) / w;
    const ny = (2 * (v.y - h / 2)) / h;
    const nz = (2 * v.z) / d;
    const k = 1 - round * (nx * nx * ny * ny + nx * nx * nz * nz + ny * ny * nz * nz) * 0.5;
    v.x *= k;
    v.z *= k;
    v.y = h / 2 + (v.y - h / 2) * (1 - round * 0.3 * nx * nx * nz * nz);
  });
}

// ---------------------------------------------------------------- the 35 types

const builders: Record<ShapeType, () => Piece[]> = {
  can: () => [
    lathe([[0, 0, METAL], [0.44, 0, METAL], [0.5, 0.035, METAL], [0.5, 0.07, METAL], [0.5, 0.07, L], [0.5, 0.93, L], [0.5, 0.93, METAL], [0.47, 0.975, METAL], [0.43, 1, METAL], [0.4, 0.99, METAL], [0, 0.985, METAL]], 32, [0.07, 0.93]),
  ],
  pet_bottle: () => [
    lathe([[0, 0, CLEAR], [0.42, 0, CLEAR], [0.5, 0.05, CLEAR], [0.5, 0.2, CLEAR], [0.5, 0.2, L], [0.5, 0.56, L], [0.5, 0.56, CLEAR], [0.47, 0.64, CLEAR], [0.32, 0.76, CLEAR], [0.2, 0.84, CLEAR], [0.18, 0.88, CLEAR], [0.2, 0.885, CAP], [0.21, 0.9, CAP], [0.21, 1, CAP], [0, 1, CAP]], 28, [0.2, 0.56]),
  ],
  glass_bottle: () => [
    lathe([[0, 0, DARK_GLASS], [0.48, 0, DARK_GLASS], [0.5, 0.03, DARK_GLASS], [0.5, 0.12, DARK_GLASS], [0.5, 0.12, L], [0.5, 0.48, L], [0.5, 0.48, DARK_GLASS], [0.48, 0.58, DARK_GLASS], [0.3, 0.7, DARK_GLASS], [0.17, 0.76, DARK_GLASS], [0.15, 0.86, DARK_GLASS], [0.16, 0.86, CAP], [0.17, 0.88, CAP], [0.17, 1, CAP], [0, 1, CAP]], 28, [0.12, 0.48]),
  ],
  jug: () => {
    const neck = lathe([[0.001, 0.8, BODY], [0.14, 0.8, BODY], [0.14, 0.92, CAP], [0.15, 0.92, CAP], [0.15, 1.0, CAP], [0, 1.0, CAP]], 16);
    neck.geo.translate(-0.25, 0, 0);
    return [
      softBox(1, 0.82, 0.7, [BODY, BODY, BODY, BODY, L, L], 0.25),
      neck,
      solid(new THREE.TorusGeometry(0.16, 0.05, 8, 16, Math.PI).translate(0.2, 0.8, 0), BODY),
    ];
  },
  squeeze_bottle: () => [
    lathe([[0, 0, BODY], [0.45, 0, BODY], [0.5, 0.06, BODY], [0.5, 0.15, BODY], [0.5, 0.15, L], [0.5, 0.7, L], [0.5, 0.7, BODY], [0.46, 0.82, BODY], [0.36, 0.86, BODY], [0.36, 0.86, CAP], [0.37, 0.88, CAP], [0.36, 1, CAP], [0, 1, CAP]], 28, [0.15, 0.7]),
  ],
  pump_bottle: () => [
    lathe([[0, 0, BODY], [0.46, 0, BODY], [0.5, 0.05, BODY], [0.5, 0.1, BODY], [0.5, 0.1, L], [0.5, 0.6, L], [0.5, 0.6, BODY], [0.45, 0.7, BODY], [0.22, 0.74, BODY], [0.2, 0.74, WHITE], [0.2, 0.8, WHITE], [0.08, 0.8, WHITE], [0.08, 0.9, WHITE], [0.18, 0.9, WHITE], [0.18, 0.97, WHITE], [0, 0.97, WHITE]], 24, [0.1, 0.6]),
    box(0.1, 0.05, 0.36, [0, 0.95, 0.2], [WHITE, WHITE, WHITE, WHITE, WHITE, WHITE]),
  ],
  aerosol: () => [
    lathe([[0, 0, METAL], [0.46, 0, METAL], [0.5, 0.03, METAL], [0.5, 0.06, L], [0.5, 0.78, L], [0.5, 0.78, METAL], [0.42, 0.84, METAL], [0.3, 0.86, METAL], [0.42, 0.86, CAP], [0.44, 0.86, CAP], [0.44, 1, CAP], [0, 1, CAP]], 28, [0.06, 0.78]),
  ],
  gable_carton: () => {
    const body = box(1, 0.8, 1, [0, 0.4, 0], [BODY, BODY, WHITE, WHITE, L, L]);
    // gable roof: two slanted panels + triangular ends
    const roof = new THREE.BufferGeometry();
    const v = [
      -0.5, 0.8, 0.5, 0.5, 0.8, 0.5, 0.5, 0.96, 0, -0.5, 0.8, 0.5, 0.5, 0.96, 0, -0.5, 0.96, 0,
      0.5, 0.8, -0.5, -0.5, 0.8, -0.5, -0.5, 0.96, 0, 0.5, 0.8, -0.5, -0.5, 0.96, 0, 0.5, 0.96, 0,
      0.5, 0.8, 0.5, 0.5, 0.8, -0.5, 0.5, 0.96, 0, -0.5, 0.8, -0.5, -0.5, 0.8, 0.5, -0.5, 0.96, 0,
    ];
    roof.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    roof.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((v.length / 3) * 2).fill(0), 2));
    roof.computeVertexNormals();
    const fin = box(1, 0.06, 0.06, [0, 0.99, 0], [WHITE, WHITE, WHITE, WHITE, WHITE, WHITE]);
    const cap = lathe([[0.001, 0, CAP], [0.1, 0, CAP], [0.1, 0.07, CAP], [0, 0.07, CAP]], 14);
    cap.geo.translate(0.22, 0.86, 0.25);
    return [body, solid(roof, BODY), fin, cap];
  },
  brick_carton: () => [
    box(1, 1, 1, [0, 0.5, 0], [BODY, BODY, WHITE, WHITE, L, L]),
    lathe([[0.001, 1, CAP], [0.09, 1, CAP], [0.09, 1.07, CAP], [0, 1.07, CAP]], 14),
  ],
  box: () => [softBox(1, 1, 1, [BODY, BODY, BODY, BODY, L, L], 0.04, 2)],
  jar: () => [
    lathe([[0, 0, CLEAR], [0.44, 0, CLEAR], [0.5, 0.05, CLEAR], [0.5, 0.12, CLEAR], [0.5, 0.12, L], [0.5, 0.7, L], [0.5, 0.7, CLEAR], [0.47, 0.78, CLEAR], [0.42, 0.8, CLEAR], [0.45, 0.8, CAP], [0.46, 0.82, CAP], [0.46, 0.98, CAP], [0.43, 1, CAP], [0, 1, CAP]], 32, [0.12, 0.7]),
  ],
  tub: () => [
    lathe([[0, 0, BODY], [0.4, 0, BODY], [0.41, 0.02, L], [0.48, 0.86, L], [0.48, 0.86, CAP], [0.51, 0.88, CAP], [0.51, 0.94, CAP], [0.47, 0.97, CAP], [0.47, 0.97, L], [0, 0.99, L]], 32, [0.02, 0.86]),
  ].map((p) => {
    // Lid top shows the photo, seen from above.
    const pos = p.geo.attributes.position as THREE.BufferAttribute;
    const uv = p.geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0.965) uv.setXY(i, pos.getX(i) / 0.96 + 0.5, -pos.getZ(i) / 0.96 + 0.5);
    return p;
  }),
  tray: () => [
    warp(box(1, 0.8, 1, [0, 0.4, 0], [WHITE, WHITE, L, WHITE, WHITE, WHITE], [4, 1, 4]), (v) => {
      if (v.y < 0.5) {
        v.x *= 0.9;
        v.z *= 0.9;
      }
    }),
    box(1.06, 0.06, 1.06, [0, 0.78, 0], [WHITE, WHITE, L, WHITE, WHITE, WHITE]),
  ],
  vacuum_pack: () => [softBox(1, 1, 1, [BODY, BODY, L, BODY, L, BODY], 0.35, 6)],
  block: () => [softBox(1, 1, 1, [BODY, BODY, L, BODY, L, L], 0.12, 4)],
  bar: () => [softBox(1, 1, 1, [BODY, BODY, L, BODY, L, BODY], 0.2, 4)],
  pillow_bag: () => [
    warp(box(1, 1, 1, [0, 0.5, 0], [BODY, BODY, BODY, BODY, L, L], [10, 14, 2]), (v) => {
      const t = Math.min(1, Math.max(0, v.y));
      const pinch = Math.pow(Math.sin(Math.PI * t), 0.55);
      const sx = Math.pow(Math.sin(Math.PI * (v.x + 0.5)), 0.4);
      v.z *= 0.08 + 0.92 * pinch * (0.4 + 0.6 * sx);
      v.x *= 1 - 0.06 * (1 - pinch);
    }),
  ],
  standup_pouch: () => [
    warp(box(1, 1, 1, [0, 0.5, 0], [BODY, BODY, BODY, BODY, L, L], [8, 12, 2]), (v) => {
      const t = Math.min(1, Math.max(0, v.y));
      const thick = 0.12 + 0.88 * Math.pow(1 - t, 0.7);
      const sx = Math.pow(Math.sin(Math.PI * (v.x + 0.5)), 0.3);
      v.z *= thick * (0.5 + 0.5 * sx);
    }),
  ],
  paper_sack: () => {
    const body = box(1, 0.82, 1, [0, 0.41, 0], [BODY, BODY, BODY, BODY, L, L]);
    const top = warp(box(1, 0.18, 1, [0, 0.91, 0], [BODY, BODY, BODY, BODY, BODY, BODY], [1, 2, 2]), (v) => {
      const t = (v.y - 0.82) / 0.18;
      v.z *= 1 - 0.85 * t;
    });
    return [body, top];
  },
  sachet: () => [softBox(1, 1, 1, [BODY, BODY, BODY, BODY, L, L], 0.3, 6)],
  tube: () => [
    warp(lathe([[0, 0, CAP], [0.22, 0, CAP], [0.24, 0.02, CAP], [0.24, 0.1, CAP], [0.22, 0.1, BODY], [0.46, 0.18, BODY], [0.5, 0.22, L], [0.5, 0.94, L], [0.5, 0.94, BODY], [0.5, 1.0, BODY], [0, 1.0, BODY]], 24, [0.22, 0.94]), (v) => {
      const t = Math.max(0, (v.y - 0.25) / 0.75);
      v.z *= 1 - 0.85 * t;
      v.x *= 1 + 0.15 * t;
    }),
  ],
  loaf: () => [
    warp(box(1, 1, 1, [0, 0.5, 0], [L, L, L, BODY, L, L], [6, 6, 10]), (v) => {
      const top = Math.max(0, v.y - 0.45) / 0.55;
      const r = 1 - 0.45 * top * top * (v.x * v.x * 4);
      v.y = v.y * (0.9 + 0.1 * Math.cos(v.x * Math.PI));
      v.x *= r;
      v.z *= 1 - 0.12 * Math.pow(Math.abs(v.z * 2), 6);
    }),
  ],
  produce_round: () => [
    warp(solid(new THREE.SphereGeometry(0.5, 28, 20).translate(0, 0.5, 0), BODY), (v) => {
      const k = 1 + 0.035 * Math.sin(v.x * 17 + v.y * 9) * Math.cos(v.z * 13);
      v.x *= k;
      v.z *= k;
      if (v.y > 0.93) v.y -= (v.y - 0.93) * 0.8; // dimple
    }),
    solid(new THREE.CylinderGeometry(0.02, 0.03, 0.12, 6).translate(0, 0.97, 0), BROWN),
  ],
  produce_long: () => [
    warp(solid(new THREE.CapsuleGeometry(0.5, 2.2, 8, 16).rotateZ(Math.PI / 2).translate(0, 0.5, 0), BODY), (v) => {
      v.y += 0.18 * (v.x / 1.6) ** 2; // gentle curve
    }),
    solid(new THREE.CylinderGeometry(0.06, 0.1, 0.3, 6).rotateZ(Math.PI / 2).translate(1.7, 0.66, 0), BROWN),
  ],
  net_bag: () => {
    const out: Piece[] = [];
    let i = 0;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3 - (y === 2 ? 1 : 0); x++) for (let z = 0; z < 2; z++) {
      out.push(solid(new THREE.SphereGeometry(0.3, 12, 9).translate(-0.33 + x * 0.33 + (y === 2 ? 0.16 : 0) + (hash(i) - 0.5) * 0.08, 0.3 + y * 0.42, -0.15 + z * 0.3 + (hash(i + 7) - 0.5) * 0.06), BODY));
      i++;
    }
    out.push(box(0.5, 0.35, 0.02, [0, 1.28, 0.05], [L, L, L, L, L, L]));
    out.push(solid(new THREE.TorusGeometry(0.06, 0.02, 6, 10).rotateX(Math.PI / 2).translate(0, 1.18, 0), CAP));
    return out;
  },
  clamshell: () => [
    box(1, 0.7, 1, [0, 0.35, 0], [CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR]),
    warp(box(1.02, 0.3, 1.02, [0, 0.85, 0], [CLEAR, CLEAR, L, CLEAR, CLEAR, CLEAR], [4, 1, 4]), (v) => {
      if (v.y > 0.95) v.y += 0.05 * Math.cos(v.x * Math.PI) * Math.cos(v.z * Math.PI);
    }),
  ],
  egg_carton: () => {
    const out: Piece[] = [box(2, 0.55, 1, [0, 0.275, 0], [WHITE, WHITE, L, WHITE, WHITE, WHITE])];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) out.push(solid(new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.6, 1).translate(-0.66 + i * 0.66, 0.55, -0.25 + j * 0.5), WHITE));
    return out;
  },
  multipack: () => {
    const out: Piece[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const p = lathe([[0, 0, METAL], [0.46, 0, METAL], [0.5, 0.05, L], [0.5, 0.92, L], [0.5, 0.92, METAL], [0.44, 1, METAL], [0, 1, METAL]], 18, [0.05, 0.92]);
      p.geo.scale(1, 2.2, 1).translate(i * 1.02, 0, j * 1.02);
      out.push(p);
    }
    out.push(box(3.1, 0.6, 2.1, [1.02, 0.3, 0.51], [L, L, CLEAR, CLEAR, L, L]));
    return out;
  },
  roll_pack: () => {
    const out: Piece[] = [softBox(1, 1, 1, [CLEAR, CLEAR, WHITE, WHITE, L, L], 0.18, 6)];
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) out.push(solid(new THREE.CircleGeometry(0.09, 12).rotateX(-Math.PI / 2).translate(-0.25 + i * 0.5, 1.003, -0.25 + j * 0.5), BROWN));
    return out;
  },
  soft_pack: () => [softBox(1, 1, 1, [BODY, BODY, BODY, BODY, L, L], 0.3, 6)],
  flat_pack: () => [softBox(1, 1, 1, [BODY, BODY, L, BODY, BODY, BODY], 0.1, 4)],
  blister_card: () => [
    box(1, 1, 0.06, [0, 0.5, 0], [WHITE, WHITE, WHITE, WHITE, L, L]),
    solid(new THREE.CapsuleGeometry(0.22, 0.3, 4, 12).scale(1, 1, 0.5).translate(0, 0.45, 0.06), CLEAR),
    solid(new THREE.TorusGeometry(0.05, 0.015, 6, 12).translate(0, 0.9, 0.035), WHITE),
  ],
  potted_plant: () => {
    const pot = lathe([[0, 0, BODY], [0.3, 0, BODY], [0.38, 0.38, BODY], [0.42, 0.4, BODY], [0.42, 0.44, BODY], [0.36, 0.44, BROWN], [0, 0.44, BROWN]], 20);
    const leaves = warp(solid(new THREE.SphereGeometry(0.48, 24, 16).translate(0, 0.95, 0), LEAF), (v) => {
      const k = 1 + 0.16 * Math.sin(v.x * 11) * Math.sin(v.z * 9 + v.y * 7);
      v.x *= k;
      v.z *= k;
      v.y = 0.95 + (v.y - 0.95) * k;
    });
    return [pot, leaves];
  },
  bouquet: () => {
    const out: Piece[] = [lathe([[0.04, 0, WHITE], [0.42, 1.0, WHITE], [0.4, 1.0, WHITE], [0.03, 0.02, WHITE]], 14)];
    out.push(solid(new THREE.CylinderGeometry(0.05, 0.05, 0.25, 6).translate(0, -0.1, 0), LEAF));
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4;
      const r = i === 0 ? 0 : 0.18 + 0.08 * hash(i);
      out.push(solid(new THREE.SphereGeometry(0.13, 10, 8).translate(Math.cos(a) * r, 1.05 + 0.12 * hash(i + 3), Math.sin(a) * r), BODY));
    }
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.4;
      out.push(solid(new THREE.ConeGeometry(0.06, 0.32, 5).rotateZ(-0.5).rotateY(a).translate(Math.cos(a) * 0.3, 1.0, Math.sin(a) * 0.3), LEAF));
    }
    return out;
  },
  irregular: () => [softBox(1, 1, 1, [BODY, BODY, BODY, BODY, L, L], 0.3, 6)],
};

const cache = new Map<string, THREE.BufferGeometry>();

/** Unit-box base mesh for a packaging type (cached). Unknown types fall back to 'box'. */
export function productGeometry(type: string): THREE.BufferGeometry {
  let g = cache.get(type);
  if (!g) {
    const b = builders[type as ShapeType] ?? builders.box;
    g = assemble(b());
    cache.set(type, g);
  }
  return g;
}
