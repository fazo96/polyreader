import { readBook } from "@/lib/books";

// Files from inside the epub (images, fonts), by their path in the zip.

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  css: "text/css; charset=utf-8",
  otf: "font/otf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await params;
  const epub = await readBook(id);
  const zipPath = path.map(decodeURIComponent).join("/");
  const ext = zipPath.split(".").pop()?.toLowerCase() ?? "";
  const data = epub && TYPES[ext] ? epub.file(zipPath) : undefined;
  if (!data) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": TYPES[ext],
      "Cache-Control": "private, max-age=86400",
      // An SVG from a book may carry scripts; never let it run them.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
  });
}
