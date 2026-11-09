import { describe, it, expect } from "vitest";
import { checkCart, type Cart, type Policy } from "./policy";

const policy: Policy = {
  per_order_cap_cents: 10000, monthly_budget_cents: 30000, blocked_categories: ["alcohol", "gift_cards"],
  max_items: 3, require_approval_over_cents: 5000, currency: "USD",
};
const item = (price_cents: number, quantity = 1, category = "books") =>
  ({ product_id: "p", title: "t", price_cents, quantity, category });
const cart = (items = [item(2500)], currency = "USD"): Cart => ({ id: "c1", items, currency });
const codes = (r: ReturnType<typeof checkCart>) => r.violations.map((x) => x.code);

describe("checkCart", () => {
  it("allows a normal cart", () => {
    const r = checkCart(cart(), policy, 0);
    expect(r.allowed).toBe(true);
    expect(r.violations).toEqual([]);
  });
  it("per-order cap: exactly at cap allowed, one cent over blocked", () => {
    expect(checkCart(cart([item(10000)]), policy, 0).allowed).toBe(true);
    const r = checkCart(cart([item(10001)]), policy, 0);
    expect(codes(r)).toContain("PER_ORDER_CAP_EXCEEDED");
    const v = r.violations.find((x) => x.code === "PER_ORDER_CAP_EXCEEDED")!;
    expect(v.limit).toBe(10000);
    expect(v.actual).toBe(10001);
  });
  it("monthly budget: exactly at budget allowed, one cent over blocked", () => {
    expect(checkCart(cart([item(5000)]), policy, 25000).allowed).toBe(true);
    expect(codes(checkCart(cart([item(5001)]), policy, 25000))).toContain("MONTHLY_BUDGET_EXCEEDED");
  });
  it("blocked category (case-insensitive)", () => {
    const r = checkCart(cart([item(1000, 1, "Gift_Cards")]), policy, 0);
    expect(r.allowed).toBe(false);
    expect(codes(r)).toEqual(["BLOCKED_CATEGORY"]);
  });
  it("max items: at limit allowed, over blocked (counts quantity)", () => {
    expect(checkCart(cart([item(100, 3)]), policy, 0).allowed).toBe(true);
    expect(codes(checkCart(cart([item(100, 4)]), policy, 0))).toContain("MAX_ITEMS_EXCEEDED");
  });
  it("currency mismatch", () => {
    expect(codes(checkCart(cart([item(100)], "EUR"), policy, 0))).toContain("CURRENCY_MISMATCH");
  });
  it("empty cart is blocked", () => {
    expect(codes(checkCart(cart([]), policy, 0))).toContain("EMPTY_CART");
  });
  it("requiresApproval flag: boundary", () => {
    expect(checkCart(cart([item(5000)]), policy, 0).requiresApproval).toBe(false);
    expect(checkCart(cart([item(5001)]), policy, 0).requiresApproval).toBe(true);
  });
  it("reports multiple violations together with messages", () => {
    const r = checkCart(cart([item(20000, 1, "alcohol")]), policy, 0);
    expect(codes(r)).toEqual(expect.arrayContaining(["PER_ORDER_CAP_EXCEEDED", "BLOCKED_CATEGORY"]));
    expect(r.violations.every((x) => x.message.length > 0)).toBe(true);
  });
});
