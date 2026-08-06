#!/usr/bin/env python3
"""Atlas builder (ADR-0002).

images/{id}.jpg -> public/atlas/base-{n}.png   (64px base tier, always resident)
                -> public/atlas/tiles-{n}.jpg  (256px detail pages, streamed)
                -> public/atlas-index.json

- base: 2048x2048, 32x32 grid of 64px cells, content 56x56 on uniform bg, 4px gutter
- detail pages: 2048x2048 JPEG, 8x8 grid of 256px tiles, ordered by shelf position
  (layout.json) so nearby products share pages — GitHub Pages chokes on 5k files,
  and page-locality means one fetch warms a whole shelf run
- products sorted by id for base => stable tile coordinates across refreshes
- KTX2 encode step runs if `toktx` or `ktx` is on PATH; PNG is always emitted (fallback)
"""
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
IMG = ROOT / "images"
OUT = PUBLIC / "atlas"

DETAIL_TILE = 256
DETAIL_GRID = 8  # 8x8 = 64 tiles per 2048 page


def layout_order(products):
    """Order product ids by shelf position (run, face, level, index) when layout.json exists."""
    layout_path = PUBLIC / "layout.json"
    order = {p["id"]: i for i, p in enumerate(products)}  # fallback: id order
    if layout_path.exists():
        layout = json.loads(layout_path.read_text())
        pos = 0
        seen = set()
        ordered = {}
        for run in layout["runs"]:
            for face in run["faces"]:
                for slot in face["slots"]:
                    if slot["productId"] not in seen:
                        seen.add(slot["productId"])
                        ordered[slot["productId"]] = pos
                        pos += 1
        for pid in order:
            if pid not in ordered:
                ordered[pid] = pos
                pos += 1
        return ordered
    return order


def build_detail_pages(products, index):
    order = layout_order(products)
    ranked = sorted(products, key=lambda p: order[p["id"]])
    page_img = None
    n_page = -1
    per_page = DETAIL_GRID * DETAIL_GRID
    for i, p in enumerate(ranked):
        tile = i % per_page
        if tile == 0:
            if page_img is not None:
                page_img.save(OUT / f"tiles-{n_page}.jpg", quality=82, optimize=True)
            n_page += 1
            page_img = Image.new("RGB", (DETAIL_TILE * DETAIL_GRID,) * 2, (244, 244, 246))
        col, row = tile % DETAIL_GRID, tile // DETAIL_GRID
        src = IMG / f"{p['id']}.jpg"
        if src.exists():
            try:
                im = Image.open(src).convert("RGB").resize((DETAIL_TILE, DETAIL_TILE), Image.LANCZOS)
                page_img.paste(im, (col * DETAIL_TILE, row * DETAIL_TILE))
            except Exception:
                pass
        index[str(p["id"])]["d"] = [n_page, col, row]
    if page_img is not None:
        page_img.save(OUT / f"tiles-{n_page}.jpg", quality=82, optimize=True)
    return n_page + 1

ATLAS = 2048
CELL = 64
GUTTER = 4
CONTENT = CELL - 2 * GUTTER  # 56
GRID = ATLAS // CELL         # 32 -> 1024 tiles
BG = (244, 244, 246)


def main():
    catalog = json.loads((PUBLIC / "catalog.json").read_text())
    products = sorted(catalog["products"], key=lambda p: p["id"])
    OUT.mkdir(exist_ok=True)

    index = {}
    atlas_img = None
    n_atlas = -1
    missing = 0
    for i, p in enumerate(products):
        tile = i % (GRID * GRID)
        if tile == 0:
            if atlas_img is not None:
                atlas_img.save(OUT / f"base-{n_atlas}.png", optimize=True)
            n_atlas += 1
            atlas_img = Image.new("RGB", (ATLAS, ATLAS), BG)
        col, row = tile % GRID, tile // GRID
        x0, y0 = col * CELL, row * CELL

        src = IMG / f"{p['id']}.jpg"
        cw = ch = CONTENT
        if src.exists():
            try:
                im = Image.open(src).convert("RGB")
                im.thumbnail((CONTENT, CONTENT), Image.LANCZOS)
                cw, ch = im.size
                atlas_img.paste(im, (x0 + GUTTER + (CONTENT - cw) // 2, y0 + GUTTER + (CONTENT - ch) // 2))
            except Exception as e:
                missing += 1
        else:
            missing += 1

        # uv rect of the CONTENT area (v measured from top; renderer applies its convention)
        cx0 = x0 + GUTTER + (CONTENT - cw) // 2
        cy0 = y0 + GUTTER + (CONTENT - ch) // 2
        index[str(p["id"])] = {
            "atlas": n_atlas,
            "uv": [round(cx0 / ATLAS, 6), round(cy0 / ATLAS, 6),
                   round((cx0 + cw) / ATLAS, 6), round((cy0 + ch) / ATLAS, 6)],
        }
    if atlas_img is not None:
        atlas_img.save(OUT / f"base-{n_atlas}.png", optimize=True)

    n_pages = build_detail_pages(products, index)

    meta = {
        "schemaVersion": catalog["schemaVersion"],
        "catalogHash": catalog["catalogHash"],
        "atlasCount": n_atlas + 1,
        "cell": CELL, "gutter": GUTTER, "size": ATLAS,
        "detailPages": n_pages, "detailTile": DETAIL_TILE, "detailGrid": DETAIL_GRID,
        "format": "png",
        "vOrigin": "top",
        "tiles": index,
    }

    # optional KTX2 (ETC1S) encode
    encoder = shutil.which("toktx") or shutil.which("ktx")
    if encoder:
        ok = True
        for n in range(n_atlas + 1):
            png = OUT / f"base-{n}.png"
            ktx = OUT / f"base-{n}.ktx2"
            cmd = ([encoder, "--t2", "--encode", "etc1s", "--genmipmap", str(ktx), str(png)]
                   if "toktx" in encoder else
                   [encoder, "create", "--format", "R8G8B8_SRGB", "--encode", "basis-lz", "--generate-mipmap", str(png), str(ktx)])
            r = subprocess.run(cmd, capture_output=True)
            if r.returncode != 0:
                print(f"ktx2 encode failed for {png.name}: {r.stderr.decode()[:200]}")
                ok = False
                break
        if ok:
            meta["format"] = "ktx2"
            print(f"ktx2: encoded {n_atlas + 1} atlases")
    else:
        print("no toktx/ktx on PATH — PNG fallback (see ADR-0002)")

    (PUBLIC / "atlas-index.json").write_text(json.dumps(meta))
    total_px = sum((OUT / f"base-{n}.png").stat().st_size for n in range(n_atlas + 1))
    total_tiles = sum((OUT / f"tiles-{n}.jpg").stat().st_size for n in range(n_pages))
    print(f"atlases: {n_atlas + 1} base ({total_px/1e6:.1f} MB png), {n_pages} detail pages ({total_tiles/1e6:.1f} MB jpg), {len(index)} products, {missing} missing images")


if __name__ == "__main__":
    main()
