# Errand Agent

## Inspiration
Everyone wants an AI that can handle errands, and almost nobody wants to hand it a payment method. The missing piece is not a smarter model; it is a hard boundary the model cannot cross. We wanted an agent that is genuinely useful at shopping while being structurally unable to overspend.

## What it does
You type "Get my sister a birthday gift under $60, delivered by Friday." The agent searches products, builds a cart and submits it to a deterministic policy engine (per-order cap, monthly budget, blocked categories, item limit, currency). If the cart passes, you see an approval card and pay with PayPal (sandbox). If it violates a rule, the agent is blocked, explains exactly which rule was hit with the numbers, and proposes a compliant alternative. Every decision is written to a live ledger you can filter and inspect.

## How we built it
Next.js (App Router) and TypeScript in a single deployable service with SQLite. An LLM on Groq (OpenAI-compatible tool use, with a scripted no-AI fallback) runs the agent loop with only four tools: search, add to cart, check policy, request approval. The agent has no payment tool at all. Checkout uses PayPal Orders v2 on the server and the JS SDK v6 in the browser; amounts are always computed server-side from the stored cart, and the policy is re-run at approval and at capture. Webhooks are verified through PayPal's verification API and deduplicated by event id. After capture, the server asks the official PayPal MCP server for the order via `get_order` and records the result in the ledger. Products come from Channel3's search API, with a seeded mock catalog as a fallback so the demo never breaks.

## Challenges
Keeping the LLM away from money while keeping the experience fluid; adapting to SDK v6's different order-creation contract (the order promise is handed to `session.start()`); making webhooks and browser callbacks safe to receive in any order; and inferring policy categories (gift cards, alcohol, weapons) for live catalog results, where categories do not match our own.

## What's next
Per-merchant and per-category budgets, delivery-date constraints from live shipping data, multi-user auth, spend-anomaly alerts, and letting the agent request a policy exception that a human can grant with one tap.
