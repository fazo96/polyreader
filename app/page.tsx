import Link from "next/link";
import { DATA_DIR, listBooks } from "@/lib/books";

export const dynamic = "force-dynamic";

export default async function Home() {
  const books = await listBooks();
  return (
    <main className="library">
      <h1>polyreader</h1>
      {books.length ? (
        <ul>
          {books.map((b) => (
            <li key={b.id}>
              <Link href={`/b/${b.id}`}>
                {b.cover ? <img src={b.cover} alt="" /> : <div className="nocover" />}
                <span className="title">{b.title}</span>
                <span className="author">{b.author}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No books yet: put an epub at <code>{DATA_DIR}/&lt;name&gt;/book.epub</code>.
        </p>
      )}
    </main>
  );
}
