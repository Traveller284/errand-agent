import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
// The client ID is public by design (PayPal docs); served at runtime so deploys need no build-time env.
export const GET = () => NextResponse.json({ clientId: process.env.PAYPAL_CLIENT_ID ?? "" });
