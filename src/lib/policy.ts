// Pure policy engine. No I/O, no LLM. The only authority on whether a cart may proceed.
export type CartItem = { product_id: string; title: string; price_cents: number; quantity: number; category: string };
export type Cart = { id: string; items: CartItem[]; currency: string };
export type Policy = {
  per_order_cap_cents: number; monthly_budget_cents: number; blocked_categories: string[];
  max_items: number; require_approval_over_cents: number; currency: string;
};
export type ViolationCode =
  | "PER_ORDER_CAP_EXCEEDED" | "MONTHLY_BUDGET_EXCEEDED" | "BLOCKED_CATEGORY"
  | "MAX_ITEMS_EXCEEDED" | "CURRENCY_MISMATCH" | "EMPTY_CART";
export type Violation = { code: ViolationCode; message: string; limit?: number | string; actual?: number | string };
export type PolicyResult = { allowed: boolean; violations: Violation[]; requiresApproval: boolean };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export const cartTotal = (items: CartItem[]) => items.reduce((s, i) => s + i.price_cents * i.quantity, 0);
export const itemCount = (items: CartItem[]) => items.reduce((s, i) => s + i.quantity, 0);

export function checkCart(cart: Cart, policy: Policy, monthToDateSpendCents: number): PolicyResult {
  const v: Violation[] = [];
  const total = cartTotal(cart.items);
  const count = itemCount(cart.items);

  if (cart.items.length === 0) v.push({ code: "EMPTY_CART", message: "The cart is empty." });

  if (cart.currency !== policy.currency)
    v.push({ code: "CURRENCY_MISMATCH", limit: policy.currency, actual: cart.currency,
      message: `Cart currency ${cart.currency} does not match your policy currency ${policy.currency}.` });

  if (total > policy.per_order_cap_cents)
    v.push({ code: "PER_ORDER_CAP_EXCEEDED", limit: policy.per_order_cap_cents, actual: total,
      message: `Order total ${usd(total)} exceeds your per-order cap of ${usd(policy.per_order_cap_cents)}.` });

  if (monthToDateSpendCents + total > policy.monthly_budget_cents)
    v.push({ code: "MONTHLY_BUDGET_EXCEEDED", limit: policy.monthly_budget_cents, actual: monthToDateSpendCents + total,
      message: `This order would bring your month's spend to ${usd(monthToDateSpendCents + total)}, over your ${usd(policy.monthly_budget_cents)} budget (${usd(monthToDateSpendCents)} already spent).` });

  const blocked = new Set(policy.blocked_categories.map((c) => c.toLowerCase()));
  const hit = [...new Set(cart.items.filter((i) => blocked.has(i.category.toLowerCase())).map((i) => i.category))];
  for (const c of hit)
    v.push({ code: "BLOCKED_CATEGORY", limit: "not allowed", actual: c,
      message: `Category "${c}" is blocked by your policy.` });

  if (count > policy.max_items)
    v.push({ code: "MAX_ITEMS_EXCEEDED", limit: policy.max_items, actual: count,
      message: `Cart has ${count} items; your limit is ${policy.max_items}.` });

  return { allowed: v.length === 0, violations: v, requiresApproval: total > policy.require_approval_over_cents };
}
