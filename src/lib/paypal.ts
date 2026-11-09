// Server-only PayPal Orders v2 client. Amounts always come from stored carts.
const BASE = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";

export type OrderItem = { title: string; price_cents: number; quantity: number };

export const fmt = (cents: number) => (cents / 100).toFixed(2);

export async function accessToken(): Promise<string> {
  const id = process.env.PAYPAL_CLIENT_ID?.trim(), secret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function pp(path: string, init: RequestInit & { requestId?: string } = {}) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal ${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function createOrder(cartId: string, items: OrderItem[], currency: string) {
  const total = items.reduce((s, i) => s + i.price_cents * i.quantity, 0);
  return pp("/v2/checkout/orders", {
    method: "POST",
    requestId: `order-${cartId}`, // idempotent per cart
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: cartId,
        amount: {
          currency_code: currency,
          value: fmt(total),
          breakdown: { item_total: { currency_code: currency, value: fmt(total) } },
        },
        items: items.map((i) => ({
          name: i.title.slice(0, 127),
          quantity: String(i.quantity),
          unit_amount: { currency_code: currency, value: fmt(i.price_cents) },
        })),
      }],
    }),
  });
}

export const captureOrder = (orderId: string) =>
  pp(`/v2/checkout/orders/${orderId}/capture`, { method: "POST", requestId: `capture-${orderId}`, body: "{}" });

export const getOrder = (orderId: string) => pp(`/v2/checkout/orders/${orderId}`);

/** Verifies a webhook via PayPal's verify-webhook-signature API. */
export async function verifyWebhook(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) return false;
  const h = (k: string) => headers.get(k);
  const out = await pp("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: h("paypal-auth-algo"),
      cert_url: h("paypal-cert-url"),
      transmission_id: h("paypal-transmission-id"),
      transmission_sig: h("paypal-transmission-sig"),
      transmission_time: h("paypal-transmission-time"),
      webhook_id: webhookId,
      webhook_event: event,
    }),
  });
  return out.verification_status === "SUCCESS";
}
