#!/usr/bin/env python3
"""Layout generator (ADR-0005): catalog.json -> public/layout.json + data/layout_report.md.

Deterministic, pure, GPU-free. Rule-ordered fixture assignment with explicit lists;
capacity-driven floor plan; emits the fixture-kit registry as the single source of
geometry truth for the renderer, proxy grid, and collision.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"

SCHEMA_VERSION = 1

# ---------------------------------------------------------------- taxonomy

OVERLAY_TOPS = {
    "Bestselgere", "Økologisk hos Oda", "Faste kupp", "Påfyll til hverdagen",
    "Fyll matpakken", "Norsk lokalmat", "Gode vaner", "Enklere småbarnsliv",
    "Ferskvaredisken", "Plantebasert", "Grill",  # Grill items always have a canonical path too
    "Alder 0-3 år", "Alder 3-6 år", "Alder 6-9 år", "Alder 9-12 år", "Alder 12-16 år",
}

ZONE_OF_TOP = {
    "Frukt og grønt": "produce", "Blomster og planter": "produce",
    "Bakeri og konditori": "bakery",
    "Kylling og kjøtt": "meat_fish", "Fisk og sjømat": "meat_fish",
    "Meieri, ost og egg": "dairy",
    "Pålegg": "palegg",
    "Middager og tilbehør": "dinner",
    "Bakeingredienser": "dry", "Frokostblandinger og müsli": "dry",
    "Drikke": "drinks",
    "Sjokolade, snacks og godteri": "snacks", "Iskrem, dessert og kjeks": "snacks",
    "Hus og hjem": "home", "Hygiene og skjønnhet": "home", "Legemidler og helsekost": "home",
    "Trening": "home", "Baby og barn": "home", "Dyr": "home",
    "Mathall": "kiosk", "Restaurant": "kiosk", "Bursdag og fest": "kiosk", "Bursdag": "kiosk",
    "Snus og tobakk": "kiosk", "Barnebøker": "kiosk", "Pocket": "kiosk", "Quiz og sudoku": "kiosk",
    "Spill og puslespill": "kiosk", "Aktiviteter": "kiosk", "Bøker mat og drikke": "kiosk",
}

ZONE_LABEL = {
    "produce": "Frukt & grønt", "bakery": "Bakeri", "meat_fish": "Kjøtt & fisk",
    "dairy": "Meieri & egg", "palegg": "Pålegg", "dinner": "Middag & tilbehør",
    "dry": "Tørrvarer & frokost", "frozen": "Frossent", "drinks": "Drikke",
    "snacks": "Snacks & søtt", "home": "Hjem & helse", "kiosk": "Kiosk & diverse",
}

# rule 2: chilled subpaths inside produce/bakery that DO go to fridge
PRODUCE_CHILL_ALLOW = {"Ferdige salater", "Ferdigkuttet og salater", "Salater og spirer", "Ferske ferdigretter"}
# rule 3: ambient subpaths inside dairy/meat/fish that do NOT go to fridge
AMBIENT_DENY = {"Plantebaserte drikker", "Egg", "Langtidsholdbar melk", "Tørrmelk og kondensert melk", "Kaffemelk"}

CHILL_TOPS = {"Meieri, ost og egg", "Kylling og kjøtt", "Fisk og sjømat"}
NATIVE_TOPS = {"Bakeri og konditori", "Frukt og grønt", "Blomster og planter"}


OVERLAY_PREFIXES = ("Påfyll til hverdagen", "Faste kupp", "Alder ")


def is_overlay(top):
    return top in OVERLAY_TOPS or top.startswith(OVERLAY_PREFIXES)


def primary_path(p):
    for path in p["paths"]:
        if path and not is_overlay(path[0]):
            return path
    return None


def has_classifier(p, prefix):
    return any(c.startswith(prefix) for c in p["classifiers"])


def assign(p):
    """-> (zone, fixture_kind) or raises KeyError for unmapped top-level."""
    path = primary_path(p)
    if path is None:
        return None  # orphan; caller reports
    top = path[0]
    zone = ZONE_OF_TOP[top]
    segs = set(path)

    if has_classifier(p, "Frysevare"):
        return ("frozen", "freezer", zone)
    if top in NATIVE_TOPS:
        if segs & PRODUCE_CHILL_ALLOW:
            return (zone, "fridge", zone)
        return (zone, "produce" if zone == "produce" else "bakery", zone)
    if top in CHILL_TOPS:
        if segs & AMBIENT_DENY:
            return (zone, "shelf", zone)
        return (zone, "fridge", zone)
    if has_classifier(p, "Holdbarhetsgaranti"):
        return (zone, "fridge", zone)
    return (zone, "shelf", zone)


# ---------------------------------------------------------------- kits (geometry truth)

KITS = {
    "gondola":  {"boards": [0.30, 0.72, 1.14, 1.56, 1.98], "pitch": 0.31, "depth": 0.55,
                 "cardW": 0.28, "cardH": 0.34, "height": 2.40},
    "fridge":   {"boards": [0.30, 0.72, 1.14, 1.56, 1.98], "pitch": 0.31, "depth": 0.72,
                 "cardW": 0.28, "cardH": 0.34, "height": 2.40},
    "freezer":  {"boards": [0.35, 0.80, 1.25, 1.70], "pitch": 0.31, "depth": 0.72,
                 "cardW": 0.28, "cardH": 0.34, "height": 2.20},
    "produce":  {"boards": [0.55, 0.95], "pitch": 0.35, "depth": 0.90,
                 "cardW": 0.30, "cardH": 0.32, "height": 1.30},
    "bakery":   {"boards": [0.30, 0.72, 1.14, 1.56, 1.98], "pitch": 0.31, "depth": 0.55,
                 "cardW": 0.28, "cardH": 0.34, "height": 2.40},
}

KIT_OF_KIND = {"shelf": "gondola", "fridge": "fridge", "freezer": "freezer",
               "produce": "produce", "bakery": "bakery"}


def per_meter(kind):
    k = KITS[KIT_OF_KIND.get(kind, kind)]
    return len(k["boards"]) / k["pitch"]


# ---------------------------------------------------------------- floor plan

AISLE = 3.0          # clear aisle width
ROW_GAP = AISLE + 2 * 0.72  # center-to-center-ish envelope for double rows
FRONT_DEPTH = 10.0   # entrance / checkout / produce / bakery strip
MARGIN = 1.2


def build(catalog):
    products = catalog["products"]
    placed, orphans, errors = [], [], []
    for p in products:
        try:
            a = assign(p)
        except KeyError as e:
            errors.append((p["id"], p["name"], str(e)))
            continue
        if a is None:
            # overlay-only products exist in real data — shelve them in kiosk, report for eyeballing
            orphans.append((p["id"], p["name"], [x[0] for x in p["paths"]]))
            a = ("kiosk", "shelf", "orphan")
        zone, kind, src = a
        placed.append((p, zone, kind, src))

    if errors:
        for pid, name, top in errors[:20]:
            print(f"ERROR unmapped top-level {top}: {pid} {name}")
        raise SystemExit(f"{len(errors)} products with unmapped top-level — extend ZONE_OF_TOP")

    # group: (zone, kind) -> [products], sorted by primary path then id
    groups = defaultdict(list)
    for p, zone, kind, src in placed:
        groups[(zone, kind)].append((p, src))
    for g in groups.values():
        g.sort(key=lambda t: ("/".join(primary_path(t[0]) or ["zz-orphan"]), t[0]["id"]))

    # ---- demand in meters
    def meters(zone, kind):
        n = len(groups.get((zone, kind), []))
        if n == 0:
            return 0.0
        # 5% + one slot of slack: slot counts floor per run, so exact-fit demand under-provisions
        return n / per_meter(kind) * 1.05 + KITS[KIT_OF_KIND[kind]]["pitch"]

    fridge_zones = ["meat_fish", "dairy", "palegg", "produce", "dinner", "drinks", "snacks", "dry", "home", "kiosk", "bakery"]
    fridge_need = {z: meters(z, "fridge") for z in fridge_zones if meters(z, "fridge") > 0}
    frozen_m = meters("frozen", "freezer")
    produce_m = meters("produce", "produce")
    bakery_m = meters("bakery", "bakery")
    shelf_need = {z: meters(z, "shelf") for z in
                  ["palegg", "dinner", "dry", "drinks", "snacks", "home", "kiosk", "dairy", "meat_fish"]
                  if meters(z, "shelf") > 0}

    # ---- hall sizing
    D = 30.0
    row_len = D - FRONT_DEPTH - 2.0 - MARGIN * 2  # leave back-wall fridge corridor
    # each zone occupies whole rows (no zone-mixing within a row), so sum per-zone ceilings
    n_shelf_rows = sum(int(-(-m // (2 * row_len))) for m in shelf_need.values())
    n_freezer_rows = max(1, int(-(-frozen_m // (2 * row_len))))
    # perimeter fridge supply: back wall + parts of side walls
    peri_fridge = {}
    fridge_flow = ["meat_fish", "dairy", "palegg", "dinner", "drinks", "produce", "snacks", "dry", "home", "kiosk", "bakery"]
    remaining = dict(fridge_need)
    # back wall gets meat_fish + dairy first; sized after W known -> iterate
    n_island_rows = 0
    W = MARGIN * 2 + (n_shelf_rows + n_freezer_rows) * ROW_GAP + 8  # first guess, +8 slack
    for _ in range(4):
        back_m = W - 2 * MARGIN - 4
        side_m = D - FRONT_DEPTH - MARGIN - 2
        supply = back_m + 2 * side_m
        overflow = max(0.0, sum(fridge_need.values()) - supply)
        # islands fragment per-zone too; approximate with +1 row of slack
        n_island_rows = (int(-(-overflow // (2 * row_len))) + 1) if overflow > 0 else 0
        W_new = MARGIN * 2 + (int(n_shelf_rows) + int(n_freezer_rows) + n_island_rows) * ROW_GAP + 6
        if abs(W_new - W) < 0.1:
            break
        W = W_new
    W = round(W, 1)

    # ---- emit fixtures
    runs, tables = [], []
    run_id = [0]

    def add_run(kind, zone, x, z, yaw, length, sides):
        run_id[0] += 1
        runs.append({
            "id": f"r{run_id[0]}", "kind": kind, "zone": zone,
            "x": round(x, 2), "z": round(z, 2), "yaw": round(yaw, 4),
            "length": round(length, 2),
            "faces": [{"side": s, "slots": []} for s in sides],
            "sign": ZONE_LABEL[zone],
        })
        return runs[-1]

    import math
    # perimeter fridge: back wall (yaw=0 faces +z... define yaw as facing direction)
    # convention: run local +x spans length, faces point along +z after yaw rotation.
    cursor = MARGIN + 2
    back_z = D - MARGIN - KITS["fridge"]["depth"] / 2
    back_cap = W - 2 * (MARGIN + 2)
    side_caps = {"left": D - FRONT_DEPTH - MARGIN - 2, "right": D - FRONT_DEPTH - MARGIN - 2}
    wall_cursors = {"back": MARGIN + 2, "left": FRONT_DEPTH, "right": FRONT_DEPTH}

    def wall_place(zone, need):
        placed_m = 0.0
        while need - placed_m > 0.3:
            for wall in ["back", "right", "left"]:
                cap = back_cap if wall == "back" else side_caps[wall]
                cur = wall_cursors[wall]
                free = (MARGIN + 2 + cap - cur) if wall == "back" else (FRONT_DEPTH + cap - cur)
                if free < 1.0:
                    continue
                seg = min(need - placed_m, free)
                if seg < 0.5:
                    seg = min(free, 1.0)
                if wall == "back":
                    add_run("fridge", zone, cur + seg / 2, back_z, math.pi, seg, ["front"])
                elif wall == "right":
                    add_run("fridge", zone, W - MARGIN - KITS["fridge"]["depth"] / 2, cur + seg / 2, -math.pi / 2, seg, ["front"])
                else:
                    add_run("fridge", zone, MARGIN + KITS["fridge"]["depth"] / 2, cur + seg / 2, math.pi / 2, seg, ["front"])
                wall_cursors[wall] = cur + seg
                placed_m += seg
                break
            else:
                return need - placed_m  # walls full
        return 0.0

    island_overflow = {}
    for z in fridge_flow:
        if z in remaining and remaining[z] > 0:
            left = wall_place(z, remaining[z])
            if left > 0.3:
                island_overflow[z] = left

    # center rows: order across x reflects shopping flow
    row_order = []
    for z in ["palegg", "dinner"]:
        if z in shelf_need:
            row_order.append(("gondola", z, shelf_need[z]))
    for z, m in island_overflow.items():
        row_order.append(("fridge", z, m))
    row_order.append(("freezer", "frozen", frozen_m))
    for z in ["dry", "drinks", "snacks", "dairy", "meat_fish", "home", "kiosk"]:
        if z in shelf_need:
            row_order.append(("gondola", z, shelf_need[z]))

    x = MARGIN + 2 + ROW_GAP / 2
    z0 = FRONT_DEPTH + row_len / 2
    pending = row_order[::-1]
    while pending:
        kind, zone, need = pending.pop()
        while need > 0.3:  # hall width grows to fit; no silent truncation
            # one double-sided row consumes 2*length meters of demand
            length = max(2.0, min(row_len, need / 2))
            r = add_run(kind, zone, x, z0, math.pi / 2, length, ["east", "west"])  # rows run along hall depth
            r["doubleSided"] = True
            need -= 2 * length
            x += ROW_GAP
    # walls were placed against W, so rows must not overrun it (W carries +6 slack)
    assert x - ROW_GAP / 2 <= W - MARGIN - 1.5, f"row overrun: rows end at {x:.1f} in hall {W:.1f} — raise W slack"
    hall_w = W

    # produce tables + bakery in front strip
    px = MARGIN + 2
    need = produce_m
    while need > 0.1:
        L = min(6.0, max(2.0, need))
        tables.append({"id": f"t{len(tables)}", "kind": "produce", "zone": "produce",
                       "x": round(px + L / 2, 2), "z": 6.0, "yaw": 0.0, "length": L,
                       "faces": [{"side": "north", "slots": []}, {"side": "south", "slots": []}],
                       "sign": ZONE_LABEL["produce"]})
        need -= 2 * L
        px += L + 1.2
    bx = hall_w - MARGIN - 2
    need = bakery_m
    while need > 0.1:
        L = min(6.0, max(2.0, need))
        runs.append({"id": f"r{run_id[0] + len(runs)}b", "kind": "bakery", "zone": "bakery",
                     "x": round(bx - L / 2, 2), "z": 3.0 + 0.3, "yaw": 0.0, "length": L,
                     "faces": [{"side": "front", "slots": []}], "sign": ZONE_LABEL["bakery"]})
        need -= L
        bx -= L + 1.0

    # ---- fill slots (deterministic: groups sorted; faces filled level-major)
    def fill(fixtures, kind_filter, zone, items):
        faces = []
        for f in fixtures:
            if f["kind"] in kind_filter and f["zone"] == zone:
                k = KITS[f["kind"]]
                cols = int(f["length"] // k["pitch"])
                for face in f["faces"]:
                    faces.append((f, face, cols, len(k["boards"])))
        idx = 0
        for f, face, cols, levels in faces:
            for level in range(levels):
                for col in range(cols):
                    if idx >= len(items):
                        return 0
                    face["slots"].append({"level": level, "index": col, "productId": items[idx][0]["id"]})
                    idx += 1
        return len(items) - idx

    unplaced = Counter()
    all_fixtures = runs + tables
    for (zone, kind), items in sorted(groups.items()):
        kinds = {"shelf": ["gondola"], "fridge": ["fridge"], "freezer": ["freezer"],
                 "produce": ["produce"], "bakery": ["bakery"]}[kind]
        left = fill(all_fixtures, kinds, zone if kind != "freezer" else "frozen", items)
        if left:
            unplaced[(zone, kind)] = left

    layout = {
        "schemaVersion": SCHEMA_VERSION,
        "catalogHash": catalog["catalogHash"],
        "hall": {
            "w": hall_w, "d": D,
            "entrance": {"x": round(hall_w / 2, 1), "z": 0.0, "yaw": math.pi},
            "spawn": {"x": round(hall_w / 2, 1), "z": 2.0, "yaw": math.pi},  # face into the store (+z)
            "checkout": [{"x": round(hall_w / 2 - 6 + i * 4, 1), "z": 3.0} for i in range(3)],
        },
        "kits": KITS,
        "runs": runs + tables,
        "directory": [{"zone": z, "label": ZONE_LABEL[z]} for z in ZONE_LABEL],
    }
    report = make_report(groups, fridge_need, shelf_need, frozen_m, orphans, unplaced, layout)
    return layout, report


def make_report(groups, fridge_need, shelf_need, frozen_m, orphans, unplaced, layout):
    lines = ["# Layout report\n"]
    lines.append(f"hall: {layout['hall']['w']} x {layout['hall']['d']} m, runs: {len(layout['runs'])}\n")
    lines.append("## Products per (zone, fixture)\n")
    for (zone, kind), items in sorted(groups.items(), key=lambda t: -len(t[1])):
        lines.append(f"- {zone:10s} {kind:8s} {len(items):5d}")
    lines.append("\n## Fridge demand (m): " + ", ".join(f"{z}={m:.1f}" for z, m in fridge_need.items()))
    lines.append("## Shelf demand (m): " + ", ".join(f"{z}={m:.1f}" for z, m in shelf_need.items()))
    lines.append(f"## Freezer demand (m): {frozen_m:.1f}")
    if unplaced:
        lines.append("\n## UNPLACED (capacity bug!)\n")
        for (zone, kind), n in unplaced.items():
            lines.append(f"- {zone} {kind}: {n}")
    if orphans:
        lines.append(f"\n## Orphans (only overlay paths): {len(orphans)}\n")
        for pid, name, tops in orphans[:40]:
            lines.append(f"- {pid} {name} {tops}")
    return "\n".join(lines)


def validate(layout, catalog):
    ids = {p["id"] for p in catalog["products"]}
    seen = Counter()
    for r in layout["runs"]:
        k = layout["kits"][r["kind"]]
        cols = int(r["length"] // k["pitch"])
        for face in r["faces"]:
            for s in face["slots"]:
                assert s["productId"] in ids, f"slot references unknown product {s['productId']}"
                assert s["index"] < cols, f"slot index beyond run length in {r['id']}"
                seen[s["productId"]] += 1
    dupes = {k: v for k, v in seen.items() if v > 1}
    assert not dupes, f"{len(dupes)} products placed twice"
    return len(seen)


if __name__ == "__main__":
    catalog = json.loads((PUBLIC / "catalog.json").read_text())
    layout, report = build(catalog)
    n = validate(layout, catalog)
    DATA.mkdir(exist_ok=True)
    (PUBLIC / "layout.json").write_text(json.dumps(layout, ensure_ascii=False))
    (DATA / "layout_report.md").write_text(report)
    total = len(catalog["products"])
    print(f"layout: {n}/{total} products placed, hall {layout['hall']['w']}x{layout['hall']['d']} m, {len(layout['runs'])} fixtures")
    if n < total:
        print(f"WARNING: {total - n} products unplaced — see data/layout_report.md")
        sys.exit(1)
