import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Epub, openEpub } from "./epub";
import { SEGMENT_VERSION, type Segmented, scopeCss, segmentChapter } from "./segment";
import { type ChapterTranslation, emptyTranslation } from "./translation";

// The library on disk: one folder per book in data/ (POLYREADER_DIR
// overrides), holding book.epub and what's made from it:
//   chapters/<n>.json      the segmented chapter (kept: translations use its ids)
//   translations/<n>.json  the translation so far
//   session.json           the translator agent's session, to resume it
//   position.json          where the reader was

export const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/
  process.env.POLYREADER_DIR ?? path.join(process.cwd(), "data"),
);
export const TARGET_LANG = process.env.POLYREADER_LANG ?? "English";

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const isValidId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

const dir = (id: string) => path.join(DATA_DIR, id);

export const assetUrl = (id: string) => (zipPath: string) =>
  `/api/books/${id}/asset/${zipPath.split("/").map(encodeURIComponent).join("/")}`;

type Cached = { mtime: number; epub: Epub };
const g = globalThis as typeof globalThis & { __polyEpubs?: Map<string, Cached> };
const epubs = (g.__polyEpubs ??= new Map());

/** The book's parsed epub, kept in memory while the file is unchanged. */
export async function readBook(id: string): Promise<Epub | null> {
  if (!isValidId(id)) return null;
  const file = path.join(dir(id), "book.epub");
  let mtime: number;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = epubs.get(id);
  if (hit?.mtime === mtime) return hit.epub;
  const epub = openEpub(await readFile(file));
  epubs.set(id, { mtime, epub });
  return epub;
}

export async function listBooks() {
  let names: string[] = [];
  try {
    names = await readdir(DATA_DIR);
  } catch {}
  const books = [];
  for (const id of names.filter(isValidId).sort()) {
    const epub = await readBook(id).catch(() => null);
    if (epub) books.push({ id, title: epub.title, author: epub.author, cover: epub.cover ? assetUrl(id)(epub.cover) : undefined });
  }
  return books;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write via a temp file so a crash never leaves half a JSON file. */
async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`; // unique: saves can overlap
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/** A chapter, segmented once and then read back, so its sentence ids never shift. */
export async function readChapter(id: string, n: number): Promise<Segmented | null> {
  const epub = await readBook(id);
  const ch = epub?.chapters[n];
  if (!epub || !ch) return null;
  const file = path.join(dir(id), "chapters", `${n}.json`);
  const stored = await readJson<Segmented>(file);
  if (stored?.v === SEGMENT_VERSION) return stored;
  const seg = segmentChapter(epub.text(ch.path) ?? "", { path: ch.path, assetUrl: assetUrl(id), lang: epub.lang });
  await writeJson(file, seg);
  return seg;
}

/** The chapter's stylesheets, scoped to the reading pane. */
export async function chapterCss(id: string, seg: Segmented) {
  const epub = await readBook(id);
  if (!epub) return "";
  return seg.styles
    .map((p) => {
      const css = epub.text(p);
      return css ? scopeCss(css, p, assetUrl(id)) : "";
    })
    .join("\n");
}

export async function readTranslation(id: string, n: number): Promise<ChapterTranslation> {
  const t = await readJson<ChapterTranslation>(path.join(dir(id), "translations", `${n}.json`));
  return t?.v === 1 && t.lang === TARGET_LANG ? t : emptyTranslation(TARGET_LANG);
}

export const writeTranslation = (id: string, n: number, t: ChapterTranslation) =>
  writeJson(path.join(dir(id), "translations", `${n}.json`), t);

export type AgentState = { sessionId: string | null };
export const readAgentState = async (id: string) =>
  (await readJson<AgentState>(path.join(dir(id), "session.json"))) ?? { sessionId: null };
export const writeAgentState = (id: string, s: AgentState) => writeJson(path.join(dir(id), "session.json"), s);

export type Position = { chapter: number; block?: string };
export const readPosition = (id: string) => readJson<Position>(path.join(dir(id), "position.json"));
export const writePosition = (id: string, p: Position) => writeJson(path.join(dir(id), "position.json"), p);
