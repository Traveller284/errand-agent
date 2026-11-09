import { NextResponse } from "next/server";
import { db, writeLedger } from "@/lib/db";
import { createOrder } from "@/lib/paypal";
import { checkCart, cartTotal } from "@/lib/policy";
import { getCart, getPolicy, monthToDateSpend, setStatus } from "@/lib/carts";

// Body is ignored on purpose: everything comes from the stored cart (tamper-proof).
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cart = getCart(id);
  if (!cart) return NextResponse.json({ error: "unknown cart" }, { status: 404 });
  if (cart.status !== "awaiting_approval") return NextResponse.json({ error: `cart is ${cart.status}` }, { status: 409 });
  const total = cartTotal(cart.items);
  const res = checkCart(cart, getPolicy(), monthToDateSpend()); // re-check at approval time
  if (!res.allowed) {
    setStatus(id, "policy_blocked");
    writeLedger({ cart_id: id, event_type: "policy_check", decision: "blocked", actor: "policy_engine", amount_cents: total, reason: res.violations.map((v) => v.message).join(" "), raw: res });
    return NextResponse.json({ error: "blocked", violations: res.violations }, { status: 422 });
  }
  setStatus(id, "approved_by_user");
  db().prepare("UPDATE carts SET last_policy_allowed=1 WHERE id=?").run(id);
  writeLedger({ cart_id: id, event_type: "user_approved", decision: "allowed", actor: "user", amount_cents: total });
  try {
    const order = await createOrder(id, cart.items, cart.currency);
    db().prepare("UPDATE carts SET paypal_order_id=? WHERE id=?").run(order.id, id);
    writeLedger({ cart_id: id, event_type: "order_created", decision: "allowed", actor: "paypal", amount_cents: total, paypal_order_id: order.id });
    return NextResponse.json({ orderId: order.id });
  } catch (e) {
    setStatus(id, "failed");
    writeLedger({ cart_id: id, event_type: "payment_failed", decision: "blocked", actor: "paypal", amount_cents: total, reason: String(e) });
    return NextResponse.json({ error: "order creation failed" }, { status: 502 });
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cart = getCart(id);
  if (!cart || cart.status !== "awaiting_approval") return NextResponse.json({ error: "not rejectable" }, { status: 409 });
  setStatus(id, "cancelled");
  writeLedger({ cart_id: id, event_type: "user_rejected", decision: "blocked", actor: "user", amount_cents: cartTotal(cart.items) });
  return NextResponse.json({ ok: true });
}
