import { notFound, redirect } from "next/navigation";
import { readBook, readPosition } from "@/lib/books";

export const dynamic = "force-dynamic";

/** Open a book where it was left, else at the start. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const epub = await readBook(id);
  if (!epub) notFound();
  const pos = await readPosition(id);
  const n = pos && epub.chapters[pos.chapter] ? pos.chapter : 0;
  redirect(`/b/${id}/${n}`);
}
