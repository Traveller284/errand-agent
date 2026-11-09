# Demo script (2:45)

Setup: app running, sandbox buyer logged in, policy at defaults ($100 per-order cap, $300 budget, blocked: alcohol, gift_cards, weapons).

**1. Problem (0:00-0:10)**
"Giving an AI agent a credit card is terrifying. Errand Agent lets it shop for you, but the LLM can never move money: it proposes, a deterministic policy engine decides, I approve, and the server charges through PayPal."

**2. Happy path (0:10-1:10)**
- Click **Happy path** ("Find a book under $25 delivered in 3 days").
- Point at the tool chips: Searching, Adding to cart, Checking policy.
- Show the green approval card: items, total, all checks passed.
- Click **Approve & Pay**, log in as the sandbox buyer, approve.
- "The server re-checked the policy, created the order from its stored cart, and captured it. The page never sends a price."
- Card shows Paid (sandbox).

**3. Blocked path (1:10-1:55)**
- Click **Over the cap** ("Buy the $199 Wireless Headphones Pro").
- Red card: "Order total $199.00 exceeds your per-order cap of $100.00."
- Agent explains the rule with numbers and offers the $59 Lite model. "No PayPal order exists; nothing could be charged."
- Click **Blocked category** ("Buy a $50 gift card"): blocked by category, agent proposes alternatives.

**4. Ledger and policy (1:55-2:25)**
- Ledger tab: show cart_proposed, policy_check (allowed/blocked badges), user_approved, order_created, payment_captured, webhook_received, order_status_verified. Click a row to expand raw JSON.
- Policy tab: lower the cap live, show the spend progress bar.

**5. Architecture and close (2:25-2:45)**
"Groq tool use (with a scripted no-AI fallback) for the agent, a pure TypeScript policy engine, PayPal Orders v2 plus SDK v6 for checkout, signed and deduplicated webhooks, and the PayPal MCP server for an agent-side order lookup. Guardrails first, payments second."
