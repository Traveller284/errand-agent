import { NextResponse } from "next/server";
import { db, writeLedger } from "@/lib/db";
import { verifyWebhook } from "@/lib/paypal";
import { getCartByOrder, setStatus } from "@/lib/carts";

export async function POST(req: Request) {
  let event: any;
  try { event = JSON.parse(await req.text()); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  // Rule 4: verify the signature with PayPal's API before trusting anything.
  let verified = false;
  try { verified = await verifyWebhook(req.headers, event); } catch { /* treated as unverified */ }
  if (!verified) return NextResponse.json({ error: "signature verification failed" }, { status: 401 });

  // Idempotency: dedupe by event id.
  const ins = db().prepare("INSERT OR IGNORE INTO webhook_events(event_id,received_at) VALUES(?,?)")
    .run(event.id, new Date().toISOString());
  if (ins.changes === 0) return NextResponse.json({ ok: true, duplicate: true });

  const orderId = event.resource?.supplementary_data?.related_ids?.order_id as string | undefined;
  const cart = orderId ? getCartByOrder(orderId) : null;
  writeLedger({ cart_id: cart?.id, event_type: "webhook_received", decision: "n/a", actor: "paypal",
    paypal_order_id: orderId, reason: event.event_type, raw: event });

  if (cart) {
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && cart.status === "approved_by_user") setStatus(cart.id, "paid");
    if (event.event_type === "PAYMENT.CAPTURE.DENIED" && cart.status !== "paid") setStatus(cart.id, "failed");
  }
  return NextResponse.json({ ok: true });
}
