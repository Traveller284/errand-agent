import fs from "fs";
import path from "path";

// Node's built-in SQLite (no native build step). Needs Node >= 22.13.
const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite");
let _db: any = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS policies(
  user_id TEXT PRIMARY KEY, per_order_cap_cents INTEGER NOT NULL, monthly_budget_cents INTEGER NOT NULL,
  blocked_categories TEXT NOT NULL, max_items INTEGER NOT NULL,
  require_approval_over_cents INTEGER NOT NULL, currency TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY, title TEXT, price_cents INTEGER, currency TEXT, category TEXT,
  merchant TEXT, image_url TEXT, delivery_days INTEGER, url TEXT);
CREATE TABLE IF NOT EXISTS carts(
  id TEXT PRIMARY KEY, user_id TEXT, status TEXT NOT NULL, total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL, created_at TEXT NOT NULL, paypal_order_id TEXT, last_policy_allowed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cart_items(
  cart_id TEXT, product_id TEXT, title TEXT, price_cents INTEGER, quantity INTEGER, category TEXT);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cart_id TEXT, event_type TEXT NOT NULL,
  decision TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, amount_cents INTEGER,
  paypal_order_id TEXT, raw TEXT);
CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`;

export function db(): any {
  if (_db) return _db;
  const file = process.env.DATABASE_PATH ?? "./data/errand.db";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new DatabaseSync(file);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec(SCHEMA);
  seed(_db);
  return _db;
}

function seed(d: any) {
  d.prepare("INSERT OR IGNORE INTO users(id,name) VALUES('demo','Alex Demo')").run();
  d.prepare(`INSERT OR IGNORE INTO policies VALUES('demo',10000,30000,?,5,5000,'USD')`)
    .run(JSON.stringify(["alcohol", "gift_cards", "weapons"]));
}

export type LedgerRow = {
  cart_id?: string | null; event_type: string; decision: "allowed" | "blocked" | "n/a";
  reason?: string; actor: "agent" | "policy_engine" | "user" | "paypal";
  amount_cents?: number; paypal_order_id?: string; raw?: unknown;
};

export function writeLedger(r: LedgerRow) {
  db().prepare(`INSERT INTO ledger(ts,cart_id,event_type,decision,reason,actor,amount_cents,paypal_order_id,raw)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), r.cart_id ?? null, r.event_type, r.decision, r.reason ?? null,
    r.actor, r.amount_cents ?? null, r.paypal_order_id ?? null, r.raw ? JSON.stringify(r.raw) : null);
}
