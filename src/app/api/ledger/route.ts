import { NextResponse } from "next/server";
import { db } from "@/lib/db";
export const dynamic = "force-dynamic";
export const GET = () => NextResponse.json(db().prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT 300").all());
