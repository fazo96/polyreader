import { readBook } from "@/lib/books";
import { getTranslator } from "@/lib/translate/session";
import type { TranslatorEvent } from "@/lib/translate/types";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const notFound = () => Response.json({ error: "not found" }, { status: 404 });
const bad = (error: string) => Response.json({ error }, { status: 400 });

/**
 * Where the agent process reaches the MCP endpoint: this server, on loopback.
 * The port is the one Next listens on (it sets PORT), never the request's: behind
 * a reverse proxy that would be the proxy's.
 */
function internalUrl() {
  if (process.env.POLYREADER_INTERNAL_URL) return process.env.POLYREADER_INTERNAL_URL.replace(/\/$/, "");
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function book(params: Ctx["params"]) {
  const { id } = await params;
  return (await readBook(id)) ? id : null;
}

/** Server-sent events: the translator's state, then every change and every saved block. */
export async function GET(req: Request, { params }: Ctx) {
  const id = await book(params);
  if (!id) return notFound();
  const translator = getTranslator(id, internalUrl());

  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: TranslatorEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      const unsubscribe = translator.subscribe(send);
      const ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 25_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel: () => cleanup(),
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

type Action = { action: "translate"; chapter: number; prefetch?: number[] } | { action: "retranslate"; chapter: number };

const isChapter = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export async function POST(req: Request, { params }: Ctx) {
  const id = await book(params);
  if (!id) return notFound();
  const body = (await req.json().catch(() => null)) as Action | null;
  if (!body || !isChapter(body.chapter)) return bad("chapter must be a chapter number");
  const translator = getTranslator(id, internalUrl());
  try {
    if (body.action === "translate") {
      const prefetch = Array.isArray(body.prefetch) ? body.prefetch.filter(isChapter).slice(0, 3) : [];
      await translator.request(body.chapter, prefetch);
    } else if (body.action === "retranslate") {
      await translator.retranslate(body.chapter);
    } else return bad("unknown action");
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
  return Response.json({ ok: true });
}
