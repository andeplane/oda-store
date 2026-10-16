#!/usr/bin/env python3
"""Build public/products3d.json: per-product packaging shape, outer size and package colour.

Usage: python3 scripts/build_products3d.py [path/to/groceries-manufacturing/public/products.json]

The source is the packing-line simulation's product table (andeplane/groceries-manufacturing),
built from this store's catalog: shape and size class come from the OpenAI Decisions API
classification, dimensions from the pack contents, colour from the product photo. Both apps
render the same 35 packaging models (src/products3d is shared with that repo).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, '..', 'groceries-manufacturing', 'public', 'products.json')
OUT = os.path.join(ROOT, 'public', 'products3d.json')


def main():
    products = json.load(open(SRC))
    catalog = json.load(open(os.path.join(ROOT, 'public', 'catalog.json')))
    known = {p['id'] for p in catalog['products']}
    shapes = sorted({p['shape'] for p in products})
    items = {}
    for p in sorted(products, key=lambda p: p['id']):
        if p['id'] not in known:
            continue
        items[str(p['id'])] = [shapes.index(p['shape']), p['w'], p['h'], p['d'], p.get('col') or '#d8d8d8']
    missing = known - {int(k) for k in items}
    out = {'schemaVersion': 1, 'catalogHash': catalog['catalogHash'], 'shapes': shapes, 'fields': ['shape', 'w', 'h', 'd', 'col'], 'items': items}
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(f'{len(items)} products, {len(shapes)} shapes, {len(missing)} catalog products without 3D data -> {OUT} ({os.path.getsize(OUT) / 1e3:.0f} kB)')


if __name__ == '__main__':
    main()
