import { timingSafeEqual } from "node:crypto";
import { handleMcp } from "@/lib/translate/mcp";
import { translatorForToken } from "@/lib/translate/session";

// The translator's tool, called by the agent process rather than the browser.
// Each running translator has its own bearer token, which scopes it to one book.

export const dynamic = "force-dynamic";

function authorize(req: Request) {
  const token = req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1];
  const translator = token ? translatorForToken(token) : undefined;
  if (!token || !translator) return undefined;
  const a = Buffer.from(token);
  const b = Buffer.from(translator.token);
  return a.length === b.length && timingSafeEqual(a, b) ? translator : undefined;
}

export async function POST(req: Request) {
  const translator = authorize(req);
  if (!translator) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const reply = await handleMcp(body, (args) => translator.save(args));
  return reply === null ? new Response(null, { status: 202 }) : Response.json(reply);
}

// No server-to-client stream and no MCP sessions to end.
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
