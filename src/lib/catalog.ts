import { db } from "./db";

export type Product = { id: string; title: string; price_cents: number; currency: string; category: string;
  merchant: string; image_url: string; delivery_days: number; url: string };
export type SearchParams = { query: string; max_price_cents?: number; category?: string; deliver_within_days?: number };
export interface CatalogProvider { search(p: SearchParams): Promise<Product[]> }

// [title, price_cents, category, merchant, delivery_days]
const SEED: [string, number, string, string, number][] = [
  ["Atomic Habits (paperback)", 1399, "books", "Pagehouse", 2], ["The Midnight Library (paperback)", 1199, "books", "Pagehouse", 3],
  ["Project Hail Mary (hardcover)", 2299, "books", "Pagehouse", 3], ["Cooking for Friends cookbook", 2499, "books", "Pagehouse", 5],
  ["Sci-fi short story collection", 1699, "books", "Bookbarn", 2], ["Illustrated Atlas of the World", 3999, "books", "Bookbarn", 6],
  ["Wireless Headphones Pro (noise cancelling)", 19900, "electronics", "SoundLab", 3], ["Wireless Headphones Lite", 5900, "electronics", "SoundLab", 2],
  ["Bluetooth Speaker Mini", 3499, "electronics", "SoundLab", 2], ["USB-C Fast Charger 65W", 2999, "electronics", "VoltCo", 2],
  ["Smartwatch Fit", 12900, "electronics", "VoltCo", 4], ["Portable Power Bank 20000mAh", 3999, "electronics", "VoltCo", 3],
  ["E-reader 6 inch", 9900, "electronics", "Pagehouse", 4], ["Webcam 1080p", 4499, "electronics", "VoltCo", 3],
  ["Ceramic Mug", 1250, "kitchen", "Hearth", 2], ["Cast Iron Skillet 10in", 3499, "kitchen", "Hearth", 4],
  ["Chef's Knife 8in", 4999, "kitchen", "Hearth", 3], ["Pour-over Coffee Set", 3299, "kitchen", "Hearth", 3],
  ["Silicone Baking Mat Set", 1599, "kitchen", "Hearth", 2], ["Electric Kettle 1.7L", 3999, "kitchen", "Hearth", 3],
  ["Espresso Machine Deluxe", 34900, "kitchen", "Hearth", 6], ["Bamboo Cutting Board", 2199, "kitchen", "Hearth", 2],
  ["Scented Candle Trio", 2400, "gifts", "Giftery", 2], ["Personalized Photo Frame", 2800, "gifts", "Giftery", 4],
  ["Spa Gift Basket", 4500, "gifts", "Giftery", 3], ["Birthday Succulent Planter", 1900, "gifts", "Giftery", 2],
  ["Gourmet Chocolate Box", 3200, "gifts", "Giftery", 2], ["Silk Scarf", 5400, "gifts", "Giftery", 5],
  ["Jigsaw Puzzle 1000pc", 2200, "gifts", "Giftery", 3], ["Leather Journal", 2600, "gifts", "Giftery", 3],
  ["Artisan Tea Sampler", 2100, "gifts", "Giftery", 2], ["Desk Plant Kit", 1700, "gifts", "Giftery", 2],
  ["Luxury Perfume Set", 8900, "gifts", "Giftery", 6], ["Board Game: Strategy Night", 3900, "gifts", "Giftery", 4],
  ["$50 Gift Card (any store)", 5000, "gift_cards", "CardRack", 1], ["$100 Gift Card (any store)", 10000, "gift_cards", "CardRack", 1],
  ["Craft Whiskey 750ml", 4800, "alcohol", "Spirits&Co", 4], ["Red Wine Case (6 bottles)", 9600, "alcohol", "Spirits&Co", 5],
  ["Hunting Knife Tactical", 6900, "weapons", "OutdoorMart", 5], ["Airsoft Rifle Replica", 14900, "weapons", "OutdoorMart", 6],
];

function ensureProducts() {
  const d = db();
  if ((d.prepare("SELECT COUNT(*) c FROM products WHERE id='p1'").get() as any).c > 0) return;
  const ins = d.prepare("INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?)");
  SEED.forEach(([t, p, c, m, dd], i) =>
    ins.run(`p${i + 1}`, t, p, "USD", c, m, `https://picsum.photos/seed/p${i + 1}/200`, dd, `https://example.com/p${i + 1}`));
}

export class MockCatalog implements CatalogProvider {
  async search(p: SearchParams): Promise<Product[]> {
    ensureProducts();
    let rows = db().prepare("SELECT * FROM products").all() as Product[];
    if (p.category) rows = rows.filter((r) => r.category === p.category);
    if (p.max_price_cents !== undefined) rows = rows.filter((r) => r.price_cents <= p.max_price_cents!);
    if (p.deliver_within_days !== undefined) rows = rows.filter((r) => r.delivery_days <= p.deliver_within_days!);
    const stop = new Set(["a", "an", "the", "for", "my", "under", "buy", "get", "find", "me", "gift", "in", "days", "by", "and"]);
    const toks = p.query.toLowerCase().split(/\W+/).filter((t) => t.length > 1 && !stop.has(t) && !/^\d/.test(t));
    const score = (r: Product) => toks.filter((t) => `${r.title} ${r.category}`.toLowerCase().includes(t.replace(/s$/, ""))).length;
    const scored = rows.map((r) => [r, score(r)] as const);
    const hits = toks.length ? scored.filter(([, s]) => s > 0) : scored;
    return (hits.length ? hits : scored).sort((a, b) => b[1] - a[1] || a[0].price_cents - b[0].price_cents).slice(0, 8).map(([r]) => r);
  }
}

/** Maps a Channel3 product to our Product. Category is inferred so policy blocked-categories still work. */
export function mapChannel3(p: any): Product | null {
  const offer = (p.offers ?? []).find((o: any) => o.price?.currency === "USD" && o.availability !== "OutOfStock");
  if (!offer) return null;
  const title = String(p.title ?? "");
  const slug = p.category?.slug ?? "general";
  const hay = `${title} ${slug} ${p.category?.title ?? ""}`.toLowerCase();
  const category = /gift[ -]?cards?/.test(hay) ? "gift_cards"
    : /\b(wine|whisk(e)?y|vodka|beer|liquor|bourbon|tequila|rum|gin)\b/.test(hay) ? "alcohol"
    : /\b(gun|rifle|firearm|ammo|ammunition|knife|knives|crossbow)\b/.test(hay) ? "weapons" : slug;
  return { id: `c3_${p.id}`, title, price_cents: Math.round(offer.price.price * 100), currency: "USD", category,
    merchant: offer.domain, image_url: p.images?.[0]?.url ?? "", delivery_days: -1, url: offer.url }; // -1 = unknown
}

export class Channel3Catalog implements CatalogProvider {
  async search(p: SearchParams): Promise<Product[]> {
    ensureProducts();
    const res = await fetch("https://api.trychannel3.com/v1/search", {
      method: "POST",
      headers: { "x-api-key": process.env.CHANNEL3_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ query: p.query, limit: 10, config: { country: "US", currency: "USD" },
        ...(p.max_price_cents !== undefined ? { filters: { price: { max_price: p.max_price_cents / 100 } } } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Channel3 ${res.status}`);
    const out = ((await res.json()).products ?? []).map(mapChannel3).filter(Boolean) as Product[];
    const ins = db().prepare("INSERT OR REPLACE INTO products VALUES(?,?,?,?,?,?,?,?,?)");
    for (const r of out) ins.run(r.id, r.title, r.price_cents, r.currency, r.category, r.merchant, r.image_url, r.delivery_days, r.url);
    if (!out.length) throw new Error("Channel3 returned no usable offers");
    return out.filter((r) => p.max_price_cents === undefined || r.price_cents <= p.max_price_cents);
  }
}

class FallbackCatalog implements CatalogProvider {
  constructor(private primary: CatalogProvider, private fallback: CatalogProvider) {}
  async search(p: SearchParams) {
    try { return await this.primary.search(p); }
    catch (e) { console.warn("Catalog primary failed, using MockCatalog:", e instanceof Error ? e.message : e); return this.fallback.search(p); }
  }
}

export function getCatalog(): CatalogProvider {
  const mock = new MockCatalog();
  return process.env.CATALOG_PROVIDER === "channel3" && process.env.CHANNEL3_API_KEY ? new FallbackCatalog(new Channel3Catalog(), mock) : mock;
}
export function getProduct(id: string): Product | undefined {
  ensureProducts();
  return db().prepare("SELECT * FROM products WHERE id=?").get(id) as Product | undefined;
}
