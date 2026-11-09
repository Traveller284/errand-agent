import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getPolicy, monthToDateSpend } from "@/lib/carts";
export const dynamic = "force-dynamic";
const P = z.object({ per_order_cap_cents: z.number().int().min(0), monthly_budget_cents: z.number().int().min(0),
  blocked_categories: z.array(z.string()), max_items: z.number().int().min(1), require_approval_over_cents: z.number().int().min(0) });
export const GET = () => NextResponse.json({ policy: getPolicy(), spent_cents: monthToDateSpend(), user: "Alex Demo" });
export async function PUT(req: Request) {
  const p = P.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.flatten() }, { status: 400 });
  const v = p.data;
  db().prepare("UPDATE policies SET per_order_cap_cents=?,monthly_budget_cents=?,blocked_categories=?,max_items=?,require_approval_over_cents=? WHERE user_id='demo'")
    .run(v.per_order_cap_cents, v.monthly_budget_cents, JSON.stringify(v.blocked_categories), v.max_items, v.require_approval_over_cents);
  return NextResponse.json({ ok: true });
}
