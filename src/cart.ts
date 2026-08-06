// Cart state + HUD + cart mode + export (ADR-0003).

import type { Catalog, Product } from "./data";

interface Line {
  product: Product;
  qty: number;
}

export class Cart {
  private lines = new Map<number, Line>();
  private itemsEl = document.getElementById("cart-items")!;
  private countEl = document.getElementById("cart-count")!;
  private totalEl = document.getElementById("cart-total")!;
  private panelEl = document.getElementById("cart-panel")!;
  private toastEl = document.getElementById("toast")!;
  private toastTimer = 0;
  private lastToastId = 0;
  private lastToastAt = 0;
  private toastRun = 0;
  onChange: () => void = () => {};

  constructor(private catalog: Catalog) {
    document.getElementById("cart-fetched")!.textContent = `Priser per ${catalog.fetchedAt.slice(0, 10)}`;
    document.addEventListener("keydown", (e) => {
      if (e.code === "KeyC" && document.body.classList.contains("playing")) {
        this.panelEl.classList.toggle("collapsed");
      }
    });
    document.getElementById("cart-export")!.addEventListener("click", () => this.copyExport());
  }

  add(product: Product) {
    const line = this.lines.get(product.id);
    if (line) line.qty += 1;
    else this.lines.set(product.id, { product, qty: 1 });
    this.render();
    // coalesce rapid adds of the same product ("×3"), per review
    const now = performance.now();
    this.toastRun = product.id === this.lastToastId && now - this.lastToastAt < 2000 ? this.toastRun + 1 : 1;
    this.lastToastId = product.id;
    this.lastToastAt = now;
    const suffix = this.toastRun > 1 ? ` ×${this.toastRun}` : "";
    this.toast(`La til ${product.name}${suffix} — ${product.price} kr`);
  }

  remove(productId: number, all = false) {
    const line = this.lines.get(productId);
    if (!line) return false;
    line.qty -= all ? line.qty : 1;
    if (line.qty <= 0) this.lines.delete(productId);
    this.render();
    return true;
  }

  get count(): number {
    let n = 0;
    for (const l of this.lines.values()) n += l.qty;
    return n;
  }

  get total(): number {
    let sum = 0;
    for (const l of this.lines.values()) sum += parseFloat(l.product.price) * l.qty;
    return sum;
  }

  private render() {
    this.countEl.textContent = String(this.count);
    this.totalEl.textContent = `${this.total.toFixed(2)} kr`;
    this.itemsEl.innerHTML = "";
    if (this.lines.size === 0) {
      const empty = document.createElement("div");
      empty.className = "cart-empty";
      empty.textContent = "Sikt på en vare og trykk A for å legge den i kurven";
      this.itemsEl.append(empty);
    }
    for (const { product, qty } of this.lines.values()) {
      const row = document.createElement("div");
      row.className = "cart-item";
      const img = document.createElement("img");
      img.src = `img/${product.id}.jpg`;
      img.alt = "";
      const name = document.createElement("span");
      name.className = "ci-name";
      name.textContent = product.name;
      const controls = document.createElement("span");
      controls.className = "ci-controls";
      const minus = document.createElement("button");
      minus.textContent = "−";
      minus.addEventListener("click", () => this.remove(product.id));
      const q = document.createElement("span");
      q.className = "ci-qty";
      q.textContent = `×${qty}`;
      const plus = document.createElement("button");
      plus.textContent = "+";
      plus.addEventListener("click", () => this.add(product));
      controls.append(minus, q, plus);
      const price = document.createElement("span");
      price.className = "ci-price";
      price.textContent = `${(parseFloat(product.price) * qty).toFixed(0)} kr`;
      row.append(img, name, controls, price);
      this.itemsEl.append(row);
    }
    this.onChange();
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add("hidden"), 1800);
  }

  /** ADR-0003 export contract: real Oda product ids + snapshot metadata + ready-made prompt */
  private async copyExport() {
    const payload = {
      fetchedAt: this.catalog.fetchedAt,
      currency: this.catalog.currency,
      lines: [...this.lines.values()].map((l) => ({
        product_id: l.product.id,
        name: l.product.name,
        quantity: l.qty,
        unit_price_at_fetch: l.product.price,
      })),
    };
    const text =
      `Add these to my Oda cart (use manipulate_cart by product_id; quantities are authoritative, ` +
      `prices are a ${this.catalog.fetchedAt.slice(0, 10)} snapshot — report any drift, then share the checkout URL):\n` +
      JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.toast("Handleliste kopiert — lim inn i Claude-chatten");
    } catch {
      this.toast("Kunne ikke kopiere (nettleser-begrensning)");
    }
  }

  init() {
    this.render();
  }
}
