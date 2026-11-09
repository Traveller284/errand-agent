import { z } from "zod";
import { runAgent } from "@/lib/agent";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1) });

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return Response.json({ error: "invalid body" }, { status: 400 });
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctl) {
      const emit = (e: Record<string, unknown>) => ctl.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        
        await runAgent(p.data.messages, emit);
      } catch (e) { emit({ type: "text", delta: `\n[Error: ${e instanceof Error ? e.message : e}]` }); }
      emit({ type: "done" });
      ctl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
