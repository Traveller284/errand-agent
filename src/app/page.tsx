"use client";
import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from "ag-grid-community";
ModuleRegistry.registerModules([AllCommunityModule]);
const gridTheme = themeQuartz.withPart(colorSchemeDark);
const safe = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
type Msg = { role: "user" | "assistant"; content: string };
type Item = { role: "msg"; m: Msg } | { role: "chip"; text: string } | { role: "cart"; c: any; approvable: boolean; state?: string };
const EXAMPLES = [
  ["Happy path", "Find a book under $25 delivered in 3 days"],
  ["Over the cap", "Buy the $199 Wireless Headphones Pro"],
  ["Blocked category", "Buy a $50 gift card"],
];

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"ledger" | "policy">("ledger");
  const [ledger, setLedger] = useState<any[]>([]);
  const [pol, setPol] = useState<any>(null);
  const [sel, setSel] = useState<any>(null);
  const sdk = useRef<any>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const loadPolicy = () => fetch("/api/policy").then((r) => r.json()).then(setPol);
  useEffect(() => {
    loadPolicy();
    const t = setInterval(() => { fetch("/api/ledger").then((r) => r.json()).then(setLedger); loadPolicy(); }, 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [items]);

  async function initSdk() {
    try {
      const { clientId } = await (await fetch("/api/config")).json(); // runtime, so no build-time env needed
      sdk.current = await (window as any).paypal.createInstance({ clientId, components: ["paypal-payments"] });
    } catch (e) { console.error("PayPal SDK init", e); }
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true); setInput("");
    const history: Msg[] = [...items.filter((i): i is { role: "msg"; m: Msg } => i.role === "msg").map((i) => i.m), { role: "user", content: text }];
    setItems((p) => [...p, { role: "msg", m: { role: "user", content: text } }]);
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }) });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    const labels: Record<string, string> = { search_products: "Searching products…", add_to_cart: "Adding to cart…", check_policy: "Checking policy…", request_approval: "Requesting approval…" };
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop()!;
      for (const l of lines) {
        if (!l) continue; const e = JSON.parse(l);
        setItems((p) => {
          const n = [...p];
          if (e.type === "text") {
            const last = n[n.length - 1];
            if (last?.role === "msg" && last.m.role === "assistant") n[n.length - 1] = { role: "msg", m: { role: "assistant", content: last.m.content + e.delta } };
            else n.push({ role: "msg", m: { role: "assistant", content: e.delta } });
          } else if (e.type === "tool") n.push({ role: "chip", text: labels[e.name] ?? e.name });
          else if (e.type === "cart") n.push({ role: "cart", c: e, approvable: false });
          else if (e.type === "approval") { for (let i = n.length - 1; i >= 0; i--) { const x = n[i]; if (x.role === "cart" && x.c.cartId === e.cartId) { n[i] = { ...x, approvable: true }; break; } } }
          return n;
        });
      }
    }
    setBusy(false);
  }

  function setState(cartId: string, state: string) {
    setItems((p) => p.map((x) => (x.role === "cart" && x.c.cartId === cartId ? { ...x, state, approvable: false } : x)));
  }
  async function pay(cartId: string) {
    if (!sdk.current) return setState(cartId, "PayPal SDK not ready (check PAYPAL_CLIENT_ID)");
    const session = sdk.current.createPayPalOneTimePaymentSession({
      onApprove: async ({ orderId }: { orderId: string }) => {
        setState(cartId, "Capturing…");
        const r = await fetch("/api/paypal/capture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }) });
        const d = await r.json(); setState(cartId, d.status === "paid" ? "Paid ✔ (sandbox)" : "Payment failed: " + (d.error ?? d.status));
      },
      onCancel: () => setState(cartId, "Cancelled at PayPal"), onError: () => setState(cartId, "PayPal error"),
    });
    // Order promise is passed unawaited (PayPal v6 transient-activation requirement). Body is empty: server uses the stored cart.
    const orderPromise = fetch(`/api/cart/${cartId}/approve`, { method: "POST" }).then(async (r) => {
      const d = await r.json(); if (!r.ok) { setState(cartId, d.violations ? "Blocked: " + d.violations.map((v: any) => v.message).join(" ") : "Could not create order"); throw new Error(d.error); }
      return { orderId: d.orderId as string };
    });
    try { await session.start({ presentationMode: "auto" }, orderPromise); } catch { /* state already set */ }
  }
  async function reject(cartId: string) { await fetch(`/api/cart/${cartId}/approve`, { method: "DELETE" }); setState(cartId, "Rejected"); }

  const spent = pol?.spent_cents ?? 0, budget = pol?.policy.monthly_budget_cents ?? 1;
  const badge = (p: any) => <span className={`badge ${p.value === "allowed" ? "ok" : p.value === "blocked" ? "bad" : ""}`}>{p.value}</span>;
  const cols: any[] = [
    { field: "ts", headerName: "Time", width: 110, valueFormatter: (p: any) => new Date(p.value).toLocaleTimeString() },
    { field: "actor", width: 120 }, { field: "event_type", headerName: "Event", width: 170 },
    { field: "decision", width: 110, cellRenderer: badge },
    { field: "amount_cents", headerName: "Amount", width: 100, valueFormatter: (p: any) => (p.value == null ? "" : usd(p.value)) },
    { field: "reason", flex: 1, minWidth: 200 }, { field: "paypal_order_id", headerName: "PayPal order", width: 150 },
  ];

  return (
    <>
      <Script src="https://www.sandbox.paypal.com/web-sdk/v6/core" strategy="afterInteractive" onLoad={initSdk} />
      <header className="top">
        <strong>Errand Agent</strong><span>{pol?.user}</span>
        <span>Month to date: {usd(spent)} / {usd(budget)}</span>
        <span className="badge ok ml-auto">Sandbox mode</span>
      </header>
      <div className="main">
        <section className="pane" aria-label="Chat">
          <div className="msgs" aria-live="polite">
            {items.length === 0 && <p className="text-[var(--mut)]">Ask me to buy something. I propose; the policy engine decides; you approve.</p>}
            {items.map((it, i) => it.role === "msg" ? <div key={i} className={`m ${it.m.role}`}>{it.m.content}</div>
              : it.role === "chip" ? <span key={i} className="chip">{it.text}</span>
              : <div key={i} className={`card ${it.c.check.allowed ? "" : "blocked"}`}>
                  {it.c.items.map((x: any, j: number) => <div key={j}>{x.quantity}× {x.title} — {usd(x.price_cents * x.quantity)}</div>)}
                  <strong>Total {usd(it.c.total_cents)}</strong>
                  {it.c.check.allowed ? <div style={{ color: "var(--ok)" }}>✓ All policy checks passed</div>
                    : it.c.check.violations.map((v: any, j: number) => <div key={j} style={{ color: "var(--bad)" }}>✗ {v.message}</div>)}
                  {it.state && <div>{it.state}</div>}
                  {it.approvable && <div className="flex gap-2 mt-2">
                    <button onClick={() => pay(it.c.cartId)}>Approve & Pay</button><button className="ghost" onClick={() => reject(it.c.cartId)}>Reject</button></div>}
                </div>)}
            <div ref={bottom} />
          </div>
          <div className="ex">{EXAMPLES.map(([l, t]) => <button key={l} className="ghost" disabled={busy} onClick={() => send(t)}>{l}</button>)}</div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Get my sister a birthday gift under $60…" />
            <button disabled={busy}>Send</button>
          </form>
        </section>
        <section className="pane" aria-label="Ledger and policy">
          <div className="tabs" role="tablist">
            {(["ledger", "policy"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === "ledger" ? "Ledger" : "Policy"}</button>)}
          </div>
          {tab === "ledger" ? <>
            <div className="flex-1 min-h-[300px]">
              <AgGridReact rowData={ledger} columnDefs={cols} defaultColDef={{ sortable: true, filter: true, resizable: true }}
                onRowClicked={(e: any) => setSel(e.data)} theme={gridTheme} />
            </div>
            {sel && <pre style={{ padding: 10, maxHeight: 180 }}>{JSON.stringify({ ...sel, raw: sel.raw ? safe(sel.raw) : null }, null, 2)}</pre>}
          </> : pol && <PolicyForm pol={pol} spent={spent} reload={loadPolicy} />}
        </section>
      </div>
    </>
  );
}

function PolicyForm({ pol, spent, reload }: { pol: any; spent: number; reload: () => void }) {
  const [f, setF] = useState({ cap: pol.policy.per_order_cap_cents / 100, budget: pol.policy.monthly_budget_cents / 100,
    max: pol.policy.max_items, over: pol.policy.require_approval_over_cents / 100, cats: pol.policy.blocked_categories.join(", ") });
  const [msg, setMsg] = useState("");
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/policy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      per_order_cap_cents: Math.round(+f.cap * 100), monthly_budget_cents: Math.round(+f.budget * 100), max_items: +f.max,
      require_approval_over_cents: Math.round(+f.over * 100), blocked_categories: String(f.cats).split(",").map((s: string) => s.trim()).filter(Boolean) }) });
    setMsg(r.ok ? "Saved" : "Invalid values"); reload();
  }
  return (
    <form onSubmit={save} style={{ padding: 16, overflow: "auto" }}>
      <div>Spent this month: {usd(spent)} of {usd(pol.policy.monthly_budget_cents)}</div>
      <div className="bar" role="progressbar" aria-valuenow={spent} aria-valuemax={pol.policy.monthly_budget_cents}><div style={{ width: `${Math.min(100, (spent / pol.policy.monthly_budget_cents) * 100)}%` }} /></div>
      <label htmlFor="cap">Per-order cap ($)</label><input id="cap" type="number" step="0.01" value={f.cap} onChange={set("cap")} />
      <label htmlFor="bud">Monthly budget ($)</label><input id="bud" type="number" step="0.01" value={f.budget} onChange={set("budget")} />
      <label htmlFor="max">Max items</label><input id="max" type="number" value={f.max} onChange={set("max")} />
      <label htmlFor="over">Flag orders over ($)</label><input id="over" type="number" step="0.01" value={f.over} onChange={set("over")} />
      <label htmlFor="cats">Blocked categories (comma separated)</label><input id="cats" value={f.cats} onChange={set("cats")} />
      <p><button>Save policy</button> <span>{msg}</span></p>
    </form>
  );
}
