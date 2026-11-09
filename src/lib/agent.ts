import crypto from "crypto";
import { z } from "zod";
import { db, writeLedger } from "./db";
import { getCatalog, getProduct } from "./catalog";
import { checkCart, cartTotal } from "./policy";
import { getCart, getPolicy, monthToDateSpend, setStatus } from "./carts";

export type Emit = (e: Record<string, unknown>) => void;
type Msg = { role: "user" | "assistant"; content: string };
type State = { cartId: string | null; checked: boolean; blocked: boolean };

const SYSTEM = `You are a careful personal shopping assistant for a user with spending guardrails.
- Always use tools; never invent products or prices. Only recommend items returned by search_products.
- Build a cart with add_to_cart, then ALWAYS call check_policy (even if add_to_cart already shows violations, because check_policy records the decision in the audit ledger), and only then request_approval.
- If check_policy blocks the cart, explain exactly which rule was hit using the returned violations (with the numbers), then propose a compliant alternative (cheaper item, remove an item) instead of arguing. Do not call request_approval for a blocked cart.
- If allowed, call request_approval; the user will approve and pay in the UI. You cannot charge anything.
- Never claim a purchase happened; payment is only real once the ledger shows payment_captured, which you cannot see.
- delivery_days null means unknown: never promise a delivery date for those items.
- Never refuse or judge a request yourself, even for gift cards, alcohol or other items that look restricted. Search with simple keywords and no category filter, add the matching item, and let check_policy decide. If a search finds nothing, retry once with simpler keywords.
- Add only the item the user asked for. After a blocked check, a new add_to_cart starts a fresh cart containing only the alternative item.
- Never offer to place an order or charge anything; you can only add to a cart and request approval.
- Be brief. Use short plain sentences, not tables.`;

const S = {
  search: z.object({ query: z.string(), max_price_cents: z.number().int().optional(), category: z.string().optional(), deliver_within_days: z.number().int().optional() }),
  add: z.object({ product_id: z.string(), quantity: z.number().int().min(1).max(20).default(1) }),
  cart: z.object({ cart_id: z.string() }),
};

// No tool here can pay or capture. Payment happens only on the server after human approval.
export const TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  { name: "search_products", description: "Search the catalog. Prices are in cents.", input_schema: { type: "object", properties: { query: { type: "string" }, max_price_cents: { type: "integer" }, category: { type: "string" }, deliver_within_days: { type: "integer" } }, required: ["query"] } },
  { name: "add_to_cart", description: "Add a product to the cart (server looks up the price).", input_schema: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id"] } },
  { name: "check_policy", description: "Run the deterministic policy engine on the cart.", input_schema: { type: "object", properties: { cart_id: { type: "string" } }, required: ["cart_id"] } },
  { name: "request_approval", description: "Ask the human to approve a cart that passed check_policy.", input_schema: { type: "object", properties: { cart_id: { type: "string" } }, required: ["cart_id"] } },
];

function payload(id: string) {
  const cart = getCart(id)!;
  return { cartId: id, items: cart.items, total_cents: cartTotal(cart.items), currency: cart.currency, check: checkCart(cart, getPolicy(), monthToDateSpend()) };
}

async function exec(state: State, emit: Emit, name: string, input: unknown): Promise<any> {
  if (name === "search_products") {
    const p = S.search.parse(input);
    const res = await getCatalog().search(p);
    return res.map((r) => ({ id: r.id, title: r.title, price_cents: r.price_cents, category: r.category, delivery_days: r.delivery_days < 0 ? null : r.delivery_days, merchant: r.merchant }));
  }
  if (name === "add_to_cart") {
    const a = S.add.parse(input);
    const prod = getProduct(a.product_id);
    if (!prod) return { error: `Unknown product_id ${a.product_id}` };
    if (state.blocked) { state.cartId = null; state.blocked = false; } if (!state.cartId) {
      state.cartId = "cart_" + crypto.randomUUID().slice(0, 8);
      db().prepare("INSERT INTO carts(id,user_id,status,total_cents,currency,created_at) VALUES(?,?,?,?,?,?)").run(state.cartId, "demo", "draft", 0, "USD", new Date().toISOString());
    }
    const cartId = state.cartId;
    const ex = db().prepare("SELECT quantity FROM cart_items WHERE cart_id=? AND product_id=?").get(cartId, prod.id) as any;
    if (ex) db().prepare("UPDATE cart_items SET quantity=quantity+? WHERE cart_id=? AND product_id=?").run(a.quantity, cartId, prod.id);
    else db().prepare("INSERT INTO cart_items VALUES(?,?,?,?,?,?)").run(cartId, prod.id, prod.title, prod.price_cents, a.quantity, prod.category);
    const c = getCart(cartId)!;
    db().prepare("UPDATE carts SET total_cents=?, status='draft', last_policy_allowed=0 WHERE id=?").run(cartTotal(c.items), cartId);
    state.checked = false;
    return payload(cartId);
  }
  const { cart_id } = S.cart.parse(input);
  const cart = getCart(cart_id);
  if (!cart) return { error: "Unknown cart_id" };
  const total = cartTotal(cart.items);
  const res = checkCart(cart, getPolicy(), monthToDateSpend());
  if (name === "check_policy") {
    writeLedger({ cart_id, event_type: "cart_proposed", decision: "n/a", actor: "agent", amount_cents: total, reason: cart.items.map((i) => `${i.quantity}x ${i.title}`).join(", ") });
    writeLedger({ cart_id, event_type: "policy_check", decision: res.allowed ? "allowed" : "blocked", actor: "policy_engine", amount_cents: total, reason: res.allowed ? "All rules passed" : res.violations.map((v) => v.message).join(" "), raw: res });
    db().prepare("UPDATE carts SET last_policy_allowed=? WHERE id=?").run(res.allowed ? 1 : 0, cart_id);
    setStatus(cart_id, res.allowed ? "draft" : "policy_blocked");
    state.checked = true; state.blocked = !res.allowed;
    emit({ type: "cart", ...payload(cart_id) });
    return res;
  }
  if (name === "request_approval") { if (!state.checked) { await exec(state, emit, "check_policy", { cart_id }); }
    if (!res.allowed) return { error: "Cart fails policy; call check_policy and propose an alternative.", violations: res.violations };
    setStatus(cart_id, "awaiting_approval");
    writeLedger({ cart_id, event_type: "approval_requested", decision: "n/a", actor: "agent", amount_cents: total });
    emit({ type: "approval", ...payload(cart_id) });
    return { status: "awaiting_user_approval" };
  }
  return { error: `Unknown tool ${name}` };
}

// Test mode / fallback: no AI model. Same tools, policy engine and ledger.
async function runScripted(messages: Msg[], emit: Emit) {
  const state: State = { cartId: null, checked: false, blocked: false };
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  emit({ type: "text", delta: "(Test mode: scripted agent, no AI model.)\n" });
  emit({ type: "tool", name: "search_products" });
  let found: any[] = await exec(state, emit, "search_products", { query: last });
  if (!Array.isArray(found) || found.length === 0) {
    for (const w of last.split(/\s+/).filter((x) => x.length > 3)) {
      found = await exec(state, emit, "search_products", { query: w });
      if (Array.isArray(found) && found.length) break;
    }
  }
  if (!Array.isArray(found) || found.length === 0) {
    emit({ type: "text", delta: "No products matched. Try words like 'headphones', 'gift card' or 'whiskey'." });
    return;
  }
  const pick = found[0];
  emit({ type: "tool", name: "add_to_cart" });
  await exec(state, emit, "add_to_cart", { product_id: pick.id, quantity: 1 });
  emit({ type: "tool", name: "check_policy" });
  const res = await exec(state, emit, "check_policy", { cart_id: state.cartId });
  if (res?.allowed) {
    emit({ type: "tool", name: "request_approval" });
    await exec(state, emit, "request_approval", { cart_id: state.cartId });
    emit({ type: "text", delta: `Added "${pick.title}" and it passed policy. Please approve and pay in the UI.` });
  } else {
    const why = (res?.violations ?? []).map((v: any) => v.message).join(" ");
    emit({ type: "text", delta: `"${pick.title}" was blocked by policy. ${why}` });
  }
}

async function groqChat(apiKey: string, body: any): Promise<any> {
  let last: any;
  for (let n = 0; n < 3; n++) {
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`${resp.status} ${text.slice(0, 300)}`);
      return JSON.parse(text);
    } catch (e: any) {
      last = e;
      const m = String(e?.message ?? e);
      console.log("[groq retry]", n, m.slice(0, 300));
      if (!/^(429|500|502|503)|tool_use_failed/.test(m)) throw e;
      await new Promise((done) => setTimeout(done, 1000 * (n + 1) * (n + 1)));
    }
  }
  throw last;
}

async function runGroq(messages: Msg[], emit: Emit, apiKey: string) {
  const model = (process.env.GROQ_MODEL ?? "").replace(/[^a-zA-Z0-9._\/-]/g, "") || "openai/gpt-oss-120b";
  const state: State = { cartId: null, checked: false, blocked: false };
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const convo: any[] = [{ role: "system", content: SYSTEM }, ...messages.map((m) => ({ role: m.role, content: m.content }))];
  let finished = false;

  for (let i = 0; i < 8; i++) {
    const data = await groqChat(apiKey, { model, messages: convo, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 4096 });
    const msg = data?.choices?.[0]?.message;
    if (!msg) { emit({ type: "text", delta: "(No reply from model.)" }); finished = true; break; }
    convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (msg.content) emit({ type: "text", delta: msg.content });
    const calls: any[] = msg.tool_calls ?? [];
    if (calls.length === 0) { finished = true; break; }
    for (const c of calls) {
      const name = c.function?.name as string;
      emit({ type: "tool", name });
      let out: any;
      try {
        const args = JSON.parse(c.function?.arguments || "{}");
        out = await exec(state, emit, name, args);
      } catch (e) {
        out = { error: `Tool failed: ${e instanceof Error ? e.message : e}` };
      }
      convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
  if (!finished) emit({ type: "text", delta: "\n(Stopped after 8 steps.)" });

  // Server-side guarantee: every cart gets a recorded policy decision, even if the model skipped check_policy.
  if (state.cartId && !state.checked) {
    emit({ type: "tool", name: "check_policy" });
    await exec(state, emit, "check_policy", { cart_id: state.cartId });
  }
}

export async function runAgent(messages: Msg[], emit: Emit) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (process.env.AGENT_MODE === "scripted" || !apiKey) return runScripted(messages, emit);
  try {
    await runGroq(messages, emit, apiKey);
  } catch (e) {
    console.log("[groq failed, using scripted fallback]", String((e as any)?.message ?? e).slice(0, 300));
    emit({ type: "text", delta: "\n(The AI model is unavailable right now, so the scripted agent is answering.)\n" });
    await runScripted(messages, emit);
  }
}