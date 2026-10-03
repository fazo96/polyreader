import { notFound } from "next/navigation";
import Reader from "@/components/Reader";
import { chapterCss, readBook, readChapter, readPosition, readTranslation } from "@/lib/books";
import { fillBlocks } from "@/lib/segment";
import { pendingHtml, unitsHtml } from "@/lib/translation";

// Always fresh: the translation grows while the agent works.
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n: raw } = await params;
  const n = Number(raw);
  const epub = await readBook(id);
  if (!epub || !Number.isInteger(n) || !epub.chapters[n]) notFound();
  const [seg, translation, pos] = await Promise.all([readChapter(id, n), readTranslation(id, n), readPosition(id)]);
  if (!seg) notFound();
  const css = await chapterCss(id, seg);
  const target = fillBlocks(seg, (b) => (translation.blocks[b.id] ? unitsHtml(translation.blocks[b.id]) : pendingHtml(b)));
  // The next chapter with something to translate, to have it ready.
  let next: number | undefined;
  for (let i = n + 1; i < epub.chapters.length && next === undefined; i++) {
    if ((await readChapter(id, i))?.blocks.length) next = i;
  }

  return (
    <Reader
      key={`${id}/${n}`}
      bookId={id}
      bookTitle={epub.title}
      lang={epub.lang}
      chapters={epub.chapters.map((c) => ({ index: c.index, title: c.title }))}
      n={n}
      next={next}
      css={css}
      sourceHtml={seg.html}
      targetHtml={target}
      blockIds={seg.blocks.map((b) => b.id)}
      translated={Object.keys(translation.blocks)}
      done={translation.done || !seg.blocks.length}
      initialBlock={pos?.chapter === n ? pos.block : undefined}
    />
  );
}
