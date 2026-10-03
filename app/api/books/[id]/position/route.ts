import { readBook, writePosition } from "@/lib/books";

// Where the reader is: the chapter and the block at the top of the screen.
// PUT from the page while reading, POST by beacon when it's hidden.

async function save(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const epub = await readBook(id);
  if (!epub) return Response.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { chapter?: unknown; block?: unknown } | null;
  const chapter = body?.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || !epub.chapters[chapter]) {
    return Response.json({ error: "bad chapter" }, { status: 400 });
  }
  const block = typeof body?.block === "string" && /^b\d+$/.test(body.block) ? body.block : undefined;
  await writePosition(id, { chapter, block });
  return Response.json({ ok: true });
}

export const PUT = save;
export const POST = save;
