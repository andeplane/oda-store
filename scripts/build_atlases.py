#!/usr/bin/env python3
"""Base-tier atlas builder (ADR-0002).

public/img/{id}.jpg -> public/atlas/base-{n}.png + public/atlas-index.json

- 2048x2048 atlases, 32x32 grid of 64px cells
- content 56x56 contain-fit on uniform background, 4px gutter (mip-bleed control)
- products sorted by id => stable tile coordinates across refreshes
- KTX2 encode step runs if `toktx` or `ktx` is on PATH; PNG is always emitted (fallback)
"""
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
IMG = PUBLIC / "img"
OUT = PUBLIC / "atlas"

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

    meta = {
        "schemaVersion": catalog["schemaVersion"],
        "catalogHash": catalog["catalogHash"],
        "atlasCount": n_atlas + 1,
        "cell": CELL, "gutter": GUTTER, "size": ATLAS,
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
    print(f"atlases: {n_atlas + 1} x {ATLAS}px, {len(index)} tiles, {missing} missing images, {total_px/1e6:.1f} MB png")


if __name__ == "__main__":
    main()
