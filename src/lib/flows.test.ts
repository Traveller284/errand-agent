import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";
import { db } from "@/lib/db";
import { createOrder, captureOrder, verifyWebhook } from "@/lib/paypal";
import { checkCart } from "@/lib/policy";
import { getPolicy, monthToDateSpend } from "@/lib/carts";
import { MockCatalog, mapChannel3 } from "@/lib/catalog";
import { TOOLS } from "@/lib/agent";
import { POST as approve } from "@/app/api/cart/[id]/approve/route";
import { POST as capture } from "@/app/api/paypal/capture/route";
import { POST as webhook } from "@/app/api/paypal/webhook/route";

process.env.DATABASE_PATH = path.join(os.tmpdir(), `errand-test-${process.pid}-${Date.now()}.db`);
vi.mock("@/lib/paypal", () => ({
  createOrder: vi.fn(async () => ({ id: "ORDER123" })),
  captureOrder: vi.fn(async () => ({ status: "COMPLETED" })),
  verifyWebhook: vi.fn(async () => true),
  getOrder: vi.fn(), accessToken: vi.fn(),
}));
vi.mock("@/lib/paypal-mcp", () => ({ verifyOrderViaMcp: vi.fn(async () => {}) }));

type It = [string, number, number, string];
function makeCart(id: string, status: string, items: It[], created = new Date().toISOString(), orderId: string | null = null) {
  const total = items.reduce((s, i) => s + i[1] * i[2], 0);
  db().prepare("INSERT INTO carts(id,user_id,status,total_cents,currency,created_at,paypal_order_id) VALUES(?,?,?,?,?,?,?)").run(id, "demo", status, total, "USD", created, orderId);
  for (const [t, p, q, c] of items) db().prepare("INSERT INTO cart_items VALUES(?,?,?,?,?,?)").run(id, t, t, p, q, c);
}
const ledgerCount = (type: string) => (db().prepare("SELECT COUNT(*) c FROM ledger WHERE event_type=?").get(type) as any).c;
const status = (id: string) => (db().prepare("SELECT status FROM carts WHERE id=?").get(id) as any).status;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  for (const t of ["carts", "cart_items", "ledger", "webhook_events"]) db().exec(`DELETE FROM ${t}`);
  vi.clearAllMocks();
});

describe("budget", () => {
  it("monthly budget rule triggers after several purchases; last month's spend is ignored", () => {
    makeCart("old", "paid", [["x", 9000, 1, "books"]], "2000-01-15T00:00:00.000Z");
    for (const i of [1, 2, 3]) makeCart(`p${i}`, "paid", [["x", 9000, 1, "books"]]);
    expect(monthToDateSpend()).toBe(27000);
    const mk = (price: number) => ({ id: "n", currency: "USD", items: [{ product_id: "a", title: "a", price_cents: price, quantity: 1, category: "books" }] });
    expect(checkCart(mk(3000), getPolicy(), monthToDateSpend()).allowed).toBe(true); // exactly at budget
    expect(checkCart(mk(3001), getPolicy(), monthToDateSpend()).violations.map((v) => v.code)).toContain("MONTHLY_BUDGET_EXCEEDED");
  });
});

describe("tamper resistance", () => {
  it("approve ignores client-sent totals and uses the stored cart", async () => {
    makeCart("t1", "awaiting_approval", [["Book", 2000, 1, "books"]]);
    const res = await approve(post({ total_cents: 1, items: [{ title: "x", price_cents: 1, quantity: 1 }] }), params("t1"));
    expect(res.status).toBe(200);
    const items = vi.mocked(createOrder).mock.calls[0][1];
    expect(items).toHaveLength(1);
    expect(items[0].price_cents).toBe(2000);
    expect((db().prepare("SELECT amount_cents a FROM ledger WHERE event_type='user_approved'").get() as any).a).toBe(2000);
  });
  it("approve refuses carts that are not awaiting approval, and re-checks policy", async () => {
    makeCart("t2", "draft", [["Book", 2000, 1, "books"]]);
    expect((await approve(post({}), params("t2"))).status).toBe(409);
    makeCart("t3", "awaiting_approval", [["Gift card", 2000, 1, "gift_cards"]]);
    const r = await approve(post({}), params("t3"));
    expect(r.status).toBe(422);
    expect(createOrder).not.toHaveBeenCalled();
    expect(status("t3")).toBe("policy_blocked");
  });
  it("capture only works for approved carts, re-checks policy, and is idempotent", async () => {
    makeCart("c1", "draft", [["Book", 2000, 1, "books"]], undefined, "O1");
    expect((await capture(post({ orderId: "O1" }))).status).toBe(409);
    makeCart("c2", "approved_by_user", [["Gift card", 2000, 1, "gift_cards"]], undefined, "O2");
    expect((await capture(post({ orderId: "O2" }))).status).toBe(422);
    makeCart("c3", "approved_by_user", [["Book", 2000, 1, "books"]], undefined, "O3");
    expect((await capture(post({ orderId: "O3" }))).status).toBe(200);
    await capture(post({ orderId: "O3" }));
    expect(captureOrder).toHaveBeenCalledTimes(1);
    expect(status("c3")).toBe("paid");
    expect(ledgerCount("payment_captured")).toBe(1);
  });
});

describe("webhook", () => {
  const event = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { supplementary_data: { related_ids: { order_id: "O9" } } } };
  it("replayed events do not double-apply", async () => {
    makeCart("w1", "approved_by_user", [["Book", 2000, 1, "books"]], undefined, "O9");
    expect((await (await webhook(post(event))).json()).ok).toBe(true);
    expect((await (await webhook(post(event))).json()).duplicate).toBe(true);
    expect(ledgerCount("webhook_received")).toBe(1);
    expect(status("w1")).toBe("paid");
  });
  it("rejects events whose signature fails verification", async () => {
    vi.mocked(verifyWebhook).mockResolvedValueOnce(false);
    expect((await webhook(post(event))).status).toBe(401);
    expect(ledgerCount("webhook_received")).toBe(0);
  });
});

describe("agent and catalog", () => {
  it("agent has no tool that can pay or capture", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(["add_to_cart", "check_policy", "request_approval", "search_products"]);
  });
  it("MockCatalog has 40 products; gift-card and headphone queries find the right items", async () => {
    const c = new MockCatalog();
    expect((db().prepare("SELECT COUNT(*) c FROM products").get() as any).c).toBeGreaterThanOrEqual(0);
    expect((await c.search({ query: "buy a $50 gift card" }))[0].category).toBe("gift_cards");
    expect((await c.search({ query: "Wireless Headphones Pro" }))[0].price_cents).toBe(19900);
    expect((db().prepare("SELECT COUNT(*) c FROM products").get() as any).c).toBe(40);
    const books = await c.search({ query: "book", max_price_cents: 2500, deliver_within_days: 3 });
    expect(books.every((b) => b.price_cents <= 2500 && b.delivery_days <= 3)).toBe(true);
  });
  it("maps Channel3 products and infers blocked categories", () => {
    const base = { id: "x1", title: "Thing", category: { slug: "mugs", title: "Mugs" }, images: [{ url: "u" }],
      offers: [{ url: "https://s/p", domain: "s.com", price: { price: 12.5, currency: "USD" }, availability: "InStock" }] };
    expect(mapChannel3(base)).toMatchObject({ id: "c3_x1", price_cents: 1250, category: "mugs", delivery_days: -1 });
    expect(mapChannel3({ ...base, title: "Amazon eGift Card $50" })!.category).toBe("gift_cards");
    expect(mapChannel3({ ...base, title: "Single malt whisky 750ml" })!.category).toBe("alcohol");
    expect(mapChannel3({ ...base, offers: [{ ...base.offers[0], price: { price: 9, currency: "EUR" } }] })).toBeNull();
  });
});
