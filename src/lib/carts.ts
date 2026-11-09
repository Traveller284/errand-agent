import { db } from "./db";
import type { Cart, Policy } from "./policy";

export function getCart(id: string): (Cart & { status: string; paypal_order_id: string | null }) | null {
  const c = db().prepare("SELECT * FROM carts WHERE id=?").get(id) as any;
  if (!c) return null;
  const items = db().prepare("SELECT product_id,title,price_cents,quantity,category FROM cart_items WHERE cart_id=?").all(id) as any[];
  return { id: c.id, currency: c.currency, status: c.status, paypal_order_id: c.paypal_order_id, items };
}
export function getCartByOrder(orderId: string) {
  const r = db().prepare("SELECT id FROM carts WHERE paypal_order_id=?").get(orderId) as any;
  return r ? getCart(r.id) : null;
}
export function getPolicy(userId = "demo"): Policy {
  const p = db().prepare("SELECT * FROM policies WHERE user_id=?").get(userId) as any;
  return { ...p, blocked_categories: JSON.parse(p.blocked_categories) };
}
/** Sum of PAID carts in the current calendar month (UTC). */
export function monthToDateSpend(userId = "demo"): number {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const r = db().prepare("SELECT COALESCE(SUM(total_cents),0) s FROM carts WHERE user_id=? AND status='paid' AND created_at>=?")
    .get(userId, start.toISOString()) as any;
  return r.s;
}
export const setStatus = (id: string, status: string) =>
  db().prepare("UPDATE carts SET status=? WHERE id=?").run(status, id);
