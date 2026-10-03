import "server-only";

// Just enough of MCP's Streamable HTTP transport to serve the translator's
// one tool: JSON-RPC over POST with plain JSON replies, no server stream.

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type ToolResult = { text: string; isError?: boolean };
export type SaveHandler = (args: unknown) => Promise<ToolResult>;

const TOOLS = [
  {
    name: "save_translation",
    description:
      "Save translated blocks of a chapter. Each block lists its units in order; a unit covers one sentence, or several consecutive sentences of that block, and every sentence is covered exactly once. Returns what was saved, what was rejected and why, and which blocks of the chapter are still missing.",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", description: "The chapter number from the prompt." },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              block: { type: "string", description: 'Block id, e.g. "b12".' },
              units: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ids: { type: "array", items: { type: "string" }, description: 'Sentence ids, e.g. ["b12.s0"].' },
                    text: { type: "string", description: "The translation, *italics* marked with asterisks." },
                  },
                  required: ["ids", "text"],
                },
              },
            },
            required: ["block", "units"],
          },
        },
      },
      required: ["chapter", "blocks"],
    },
  },
];

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const ok = (id: RpcMessage["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: RpcMessage["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: RpcMessage, save: SaveHandler) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "polyreader", version: "0.1.0" },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      if (params.name !== "save_translation") return fail(id, -32602, `unknown tool: ${String(params.name)}`);
      const { text, isError } = await save(params.arguments).catch((err: Error) => ({ text: err.message, isError: true }));
      return ok(id, { content: [{ type: "text", text }], isError: !!isError });
    }
    case "resources/list":
      return ok(id, { resources: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/** Handle one POST body; null means "notifications only, reply 202". */
export async function handleMcp(body: unknown, save: SaveHandler): Promise<unknown> {
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcMessage[];
  const replies = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") continue;
    if (msg.id === undefined || msg.id === null) continue; // notification
    replies.push(await handle(msg, save));
  }
  if (!replies.length) return null;
  return batch ? replies : replies[0];
}
