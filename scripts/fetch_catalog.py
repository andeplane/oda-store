#!/usr/bin/env python3
"""Oda catalog pipeline (ADR-0001).

Stages (each resumable, run any subset):
  --details   sitemap -> per-product detail JSON -> data/raw_products.jsonl  (throttled 2 req/s, 429-backoff)
  --images    download one thumbnail per product -> data/img/{id}.jpg        (CDN throttle, content-length checked)
  --emit      raw jsonl -> public/catalog.json (lite) + public/descriptions.json

The raw file is the snapshot of record; --emit is pure and cheap.
"""
import argparse
import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw_products.jsonl"
PUBLIC = ROOT / "public"
IMG_DIR = ROOT / "images"  # pipeline source; runtime ships packed tile pages instead

SCHEMA_VERSION = 1
UA = {"User-Agent": "Mozilla/5.0 (oda-virtual-store; personal project)", "Accept": "application/json"}

API_RATE = 2.0  # req/s against oda.com API
CDN_RATE = 8.0  # req/s against images.oda.com


class Throttle:
    def __init__(self, rate: float):
        self.rate = rate
        self.lock = threading.Lock()
        self.next_slot = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(self.next_slot, now)
            self.next_slot = t + 1.0 / self.rate
        time.sleep(max(0.0, t - time.monotonic()))


def get(url: str, throttle: Throttle | None = None, timeout: int = 25) -> bytes:
    if throttle:
        throttle.wait()
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def sitemap_ids(throttle: Throttle) -> list[int]:
    idx = get("https://oda.com/sitemap.xml", throttle).decode()
    ids: set[int] = set()
    for m in re.findall(r"<loc>(https://oda\.com/sitemap/nb/products/\d+\.xml)</loc>", idx):
        ids.update(int(x) for x in re.findall(r"/products/(\d+)-", get(m, throttle).decode()))
    return sorted(ids)


def fetch_details():
    DATA.mkdir(exist_ok=True)
    throttle = Throttle(API_RATE)
    backoff_until = [0.0]
    lock = threading.Lock()

    def fetch(pid: int):
        for attempt in range(8):
            wait = backoff_until[0] - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            try:
                return json.loads(get(f"https://oda.com/api/v1/products/{pid}/", throttle))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None
                if e.code == 429:
                    retry = int(e.headers.get("Retry-After") or 60)
                    with lock:
                        backoff_until[0] = max(backoff_until[0], time.monotonic() + retry)
                    continue
                time.sleep(2 + attempt)
            except Exception:
                time.sleep(2 + attempt)
        print(f"gave up on {pid}")
        return None

    done: set[int] = set()
    if RAW.exists():
        with RAW.open() as f:
            for line in f:
                try:
                    done.add(json.loads(line)["id"])
                except Exception:
                    pass
    todo = [i for i in sitemap_ids(throttle) if i not in done]
    print(f"details: {len(done)} cached, {len(todo)} to fetch")
    wlock = threading.Lock()
    with RAW.open("a") as f, ThreadPoolExecutor(max_workers=3) as ex:
        for i, d in enumerate(ex.map(fetch, todo)):
            if d:
                with wlock:
                    f.write(json.dumps(d, ensure_ascii=False) + "\n")
                    f.flush()
            if (i + 1) % 250 == 0:
                print(f"  {i+1}/{len(todo)}")


def image_url(p: dict) -> str | None:
    imgs = p.get("images") or []
    if not imgs:
        return None
    return (imgs[0].get("thumbnail") or {}).get("url") or (imgs[0].get("large") or {}).get("url")


def fetch_images():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    throttle = Throttle(CDN_RATE)
    prods = load_raw()

    def dl(p: dict) -> bool:
        url = image_url(p)
        if not url:
            return False
        path = IMG_DIR / f"{p['id']}.jpg"
        if path.exists() and path.stat().st_size > 500:
            return True
        for attempt in range(4):
            try:
                throttle.wait()
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read()
                    clen = r.headers.get("Content-Length")
                    if clen and len(body) != int(clen):
                        raise IOError("truncated body")
                path.write_bytes(body)
                return True
            except Exception:
                time.sleep(2 + attempt)
        print(f"  image failed: {p['id']}")
        return False

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(dl, prods))
    print(f"images: {sum(results)}/{len(prods)} ok")


def load_raw() -> list[dict]:
    prods, seen, bad = [], set(), 0
    with RAW.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
            except json.JSONDecodeError:
                bad += 1  # truncated tail line from an interrupted run
                continue
            if p["id"] not in seen:
                seen.add(p["id"])
                prods.append(p)
    if bad:
        print(f"  note: skipped {bad} corrupt line(s) in {RAW.name}")
    return prods


def description_of(p: dict) -> str:
    for loc in (p.get("detailed_info") or {}).get("local", []):
        d = loc.get("description_from_supplier") or loc.get("short_description")
        if d:
            return re.sub(r"<[^>]+>", " ", d).strip()
    return ""


def paths_of(p: dict) -> list[list[str]]:
    """All category paths, root-first, e.g. [["Meieri, ost og egg", "Melk", "Lettmelk"], ...]."""
    out = []
    for c in p.get("categories") or []:
        parents = [x["name"] for x in (c.get("parents") or [])]
        out.append(parents + [c["name"]] if parents else [c["name"]])
    return out


def emit():
    PUBLIC.mkdir(exist_ok=True)
    prods = load_raw()
    prods.sort(key=lambda p: p["id"])
    lite, descs = [], {}
    for p in prods:
        if not (p.get("availability") or {}).get("is_available", True):
            continue
        if not image_url(p):
            continue
        imgs = p["images"][0].get("large") or {}
        w, h = imgs.get("width") or 1, imgs.get("height") or 1
        aspect = round(w / h, 3) if h else 1.0
        if not 0.2 <= aspect <= 8:
            print(f"  warn: wild aspect {aspect} on {p['id']} {p['full_name']}")
        lite.append({
            "id": p["id"],
            "name": p["full_name"],
            "extra": p.get("name_extra") or "",
            "brand": p.get("brand") or "",
            "price": p["gross_price"],
            "unitPrice": f'{p["gross_unit_price"]} kr/{p["unit_price_quantity_abbreviation"]}',
            "url": p["front_url"],
            "aspect": max(0.4, min(2.5, aspect)),
            "classifiers": [c["name"] for c in p.get("client_classifiers") or []],
            "paths": paths_of(p),
        })
        d = description_of(p)
        if d:
            descs[str(p["id"])] = d

    catalog_hash = hashlib.sha256(
        json.dumps([(x["id"], x["price"]) for x in lite]).encode()
    ).hexdigest()[:16]
    meta = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "currency": "NOK",
        "schemaVersion": SCHEMA_VERSION,
        "source": "oda.com public API (personal demo; images not for redistribution)",
        "catalogHash": catalog_hash,
    }
    (PUBLIC / "catalog.json").write_text(json.dumps({**meta, "products": lite}, ensure_ascii=False))
    (PUBLIC / "descriptions.json").write_text(json.dumps(descs, ensure_ascii=False))
    print(f"emit: {len(lite)} products, {len(descs)} descriptions, hash {catalog_hash}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--details", action="store_true")
    ap.add_argument("--images", action="store_true")
    ap.add_argument("--emit", action="store_true")
    args = ap.parse_args()
    if not (args.details or args.images or args.emit):
        ap.error("pick at least one stage")
    if args.details:
        fetch_details()
    if args.images:
        fetch_images()
    if args.emit:
        emit()
