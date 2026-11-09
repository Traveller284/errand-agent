import { NextResponse } from "next/server";
import { z } from "zod";
import { writeLedger } from "@/lib/db";
import { captureOrder } from "@/lib/paypal";
import { verifyOrderViaMcp } from "@/lib/paypal-mcp";
import { checkCart, cartTotal } from "@/lib/policy";
import { getCartByOrder, getPolicy, monthToDateSpend, setStatus } from "@/lib/carts";

const Body = z.object({ orderId: z.string().min(1) }); // client sends ONLY the order id

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const orderId = parsed.data.orderId;
  const cart = getCartByOrder(orderId);
  if (!cart) return NextResponse.json({ error: "unknown order" }, { status: 404 });
  if (cart.status === "paid") return NextResponse.json({ status: "paid", cartId: cart.id }); // idempotent
  if (cart.status !== "approved_by_user")
    return NextResponse.json({ error: `cart is ${cart.status}, not approved_by_user` }, { status: 409 });

  // Rule 3: re-run policy at capture time, from the stored cart.
  const res = checkCart(cart, getPolicy(), monthToDateSpend());
  const total = cartTotal(cart.items);
  if (!res.allowed) {
    setStatus(cart.id, "policy_blocked");
    writeLedger({ cart_id: cart.id, event_type: "policy_check", decision: "blocked", actor: "policy_engine",
      amount_cents: total, paypal_order_id: orderId, reason: res.violations.map((v) => v.message).join(" "), raw: res });
    return NextResponse.json({ error: "blocked", violations: res.violations }, { status: 422 });
  }
  try {
    const out = await captureOrder(orderId);
    const ok = out.status === "COMPLETED";
    setStatus(cart.id, ok ? "paid" : "failed");
    writeLedger({ cart_id: cart.id, event_type: ok ? "payment_captured" : "payment_failed",
      decision: ok ? "allowed" : "blocked", actor: "paypal", amount_cents: total,
      paypal_order_id: orderId, reason: `PayPal status ${out.status}`, raw: out });
    if (ok) void verifyOrderViaMcp(cart.id, orderId, total).catch(() => {}); // PayPal MCP get_order, written to ledger
    return NextResponse.json({ status: ok ? "paid" : "failed", cartId: cart.id });
  } catch (e) {
    setStatus(cart.id, "failed");
    writeLedger({ cart_id: cart.id, event_type: "payment_failed", decision: "blocked", actor: "paypal",
      amount_cents: total, paypal_order_id: orderId, reason: String(e) });
    return NextResponse.json({ error: "capture failed" }, { status: 502 });
  }
}
