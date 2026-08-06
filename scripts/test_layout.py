#!/usr/bin/env python3
"""Golden-sample placement tests (ADR-0005 phase-1 gate). Run: python3 scripts/test_layout.py"""
import json
from pathlib import Path

import build_layout as bl

PUBLIC = Path(__file__).resolve().parent.parent / "public"


def mk(name, paths, classifiers=()):
    return {"id": 0, "name": name, "paths": paths, "classifiers": list(classifiers)}


CASES = [
    # (product, expected (zone, kind))
    (mk("Frossen pizza", [["Middager og tilbehør", "Pizza"]], ["Frysevare"]), ("frozen", "freezer")),
    (mk("Tine Lettmelk", [["Meieri, ost og egg", "Melk", "Lettmelk"]], ["Nøkkelhullet"]), ("dairy", "fridge")),
    (mk("Knekkebrød", [["Pålegg", "Knekkebrød"]]), ("palegg", "shelf")),
    (mk("Ferskt brød", [["Bakeri og konditori", "Brød"]], ["Holdbarhetsgaranti i 5 dager"]), ("bakery", "bakery")),
    (mk("Eple", [["Frukt og grønt", "Frukt"]], ["Holdbarhetsgaranti i 5 dager"]), ("produce", "produce")),
    (mk("Salatmiks", [["Frukt og grønt", "Ferdige salater"]], ["Holdbarhetsgaranti i 3 dager"]), ("produce", "fridge")),
    (mk("Havredrikk", [["Meieri, ost og egg", "Plantebaserte drikker"]]), ("dairy", "shelf")),
    (mk("Egg 12pk", [["Meieri, ost og egg", "Egg"]]), ("dairy", "shelf")),
    (mk("Kyllingfilet", [["Kylling og kjøtt", "Kylling"]], ["Holdbarhetsgaranti i 4 dager"]), ("meat_fish", "fridge")),
    (mk("Fersk ferdigrett", [["Middager og tilbehør", "Ferske middager"]], ["Holdbarhetsgaranti i 3 dager"]), ("dinner", "fridge")),
    (mk("Cola", [["Drikke", "Brus"]]), ("drinks", "shelf")),
    (mk("Sjokolade", [["Sjokolade, snacks og godteri", "Sjokolade"]]), ("snacks", "shelf")),
    (mk("Iskrem", [["Iskrem, dessert og kjeks", "Iskrem"]], ["Frysevare"]), ("frozen", "freezer")),
    (mk("Overlay-only via canonical", [["Bestselgere"], ["Drikke", "Kaffe"]]), ("drinks", "shelf")),
    (mk("Zalo", [["Hus og hjem", "Oppvask"]]), ("home", "shelf")),
]


def test_golden():
    for p, (zone, kind) in CASES:
        got = bl.assign(p)
        assert got is not None, f"{p['name']}: orphaned"
        gz, gk, _src = got
        assert (gz, gk) == (zone, kind), f"{p['name']}: expected {(zone, kind)}, got {(gz, gk)}"
    print(f"golden: {len(CASES)} cases ok")


def test_orphan_detection():
    p = mk("Only overlays", [["Bestselgere"], ["Faste kupp"]])
    assert bl.assign(p) is None
    print("orphan detection ok")


def test_full_layout_if_catalog_present():
    cat_path = PUBLIC / "catalog.json"
    if not cat_path.exists():
        print("catalog.json missing — skipping integration test")
        return
    catalog = json.loads(cat_path.read_text())
    layout, _report = bl.build(catalog)
    n = bl.validate(layout, catalog)
    # geometry: no fixture-envelope overlap (with small tolerance for back-to-back faces)
    import math
    boxes = []
    for r in layout["runs"]:
        k = layout["kits"][r["kind"]]
        c, s = math.cos(r["yaw"]), math.sin(r["yaw"])
        hx = r["length"] / 2 if abs(c) > 0.5 else k["depth"] / 2
        hz = k["depth"] / 2 if abs(c) > 0.5 else r["length"] / 2
        if r.get("doubleSided"):
            hx, hz = (hx, k["depth"]) if abs(c) > 0.5 else (k["depth"], hz)
        boxes.append((r["id"], r["x"] - hx, r["x"] + hx, r["z"] - hz, r["z"] + hz))
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            if a[1] < b[2] - 0.05 and b[1] < a[2] - 0.05 and a[3] < b[4] - 0.05 and b[3] < a[4] - 0.05:
                raise AssertionError(f"fixture overlap: {a[0]} vs {b[0]}")
    print(f"integration: {n} products placed, {len(layout['runs'])} fixtures, no overlaps")


if __name__ == "__main__":
    test_golden()
    test_orphan_detection()
    test_full_layout_if_catalog_present()
    print("ALL LAYOUT TESTS PASSED")
