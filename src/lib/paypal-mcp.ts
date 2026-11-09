// Agent-driven PayPal action: after capture, we ask the official PayPal MCP server (@paypal/mcp)
// for the order via its `get_order` tool and write the verification to the ledger.
// Falls back to a direct REST lookup if the MCP server cannot start (e.g. no network for npx).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { accessToken, getOrder } from "./paypal";
import { writeLedger } from "./db";

const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("MCP timeout")), ms));

export async function verifyOrderViaMcp(cartId: string, orderId: string, amountCents: number) {
  let source = "paypal-mcp";
  let result: unknown;
  try {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@paypal/mcp", "--tools=all"],
      env: { ...(process.env as Record<string, string>), PAYPAL_ACCESS_TOKEN: await accessToken(), PAYPAL_ENVIRONMENT: "SANDBOX" },
    });
    const client = new Client({ name: "errand-agent", version: "0.1.0" });
    try {
      await Promise.race([client.connect(transport), timeout(30000)]);
      result = await Promise.race([client.callTool({ name: "get_order", arguments: { id: orderId } }), timeout(20000)]);
      if ((result as { isError?: boolean }).isError) throw new Error("MCP get_order returned an error");
    } finally { await client.close().catch(() => {}); }
  } catch {
    source = "rest-fallback";
    try { result = await getOrder(orderId); } catch (e) { result = { error: String(e) }; }
  }
  const completed = /COMPLETED/.test(JSON.stringify(result));
  writeLedger({ cart_id: cartId, event_type: "order_status_verified", decision: completed ? "allowed" : "blocked", actor: "agent",
    amount_cents: amountCents, paypal_order_id: orderId,
    reason: `Order status looked up via ${source}: ${completed ? "COMPLETED" : "not confirmed"}`, raw: { source, result } });
}
