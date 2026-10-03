import { unzipSync } from "fflate";
import { DomUtils, parseDocument } from "htmlparser2";
import type { Element } from "domhandler";

// Reads an .epub (a zip): the package file (OPF) for metadata and reading
// order, the NCX or EPUB 3 nav for chapter titles. Imports nothing from the
// rest of the app so tests can load it with plain Node.

export type Chapter = {
  /** Position in the spine, which is also the chapter's number in URLs. */
  index: number;
  /** Path inside the zip, e.g. "OEBPS/Text/ch01.xhtml". */
  path: string;
  title: string;
};

export type Epub = {
  title: string;
  author: string;
  lang: string;
  /** Zip path of the cover image, if the book names one. */
  cover?: string;
  chapters: Chapter[];
  file(path: string): Uint8Array | undefined;
  text(path: string): string | undefined;
};

const decoder = new TextDecoder("utf-8");

/** Resolve `href` (relative, maybe with a #fragment or %-escapes) against the zip path `from`. */
export function resolvePath(from: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0]);
  const parts = from.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

const xml = (s: string) => parseDocument(s, { xmlMode: true });

/** Elements by local name, ignoring namespace prefixes (dc:title, opf:item…). */
function byName(root: Parameters<typeof DomUtils.findAll>[1], name: string): Element[] {
  return DomUtils.findAll((el) => el.name === name || el.name.endsWith(`:${name}`), root);
}

const textOf = (el: Element | undefined) => (el ? DomUtils.textContent(el).replace(/\s+/g, " ").trim() : "");

export function openEpub(data: Uint8Array): Epub {
  const files = unzipSync(data);
  const file = (p: string) => files[p];
  const text = (p: string) => {
    const f = files[p];
    return f ? decoder.decode(f) : undefined;
  };

  const container = text("META-INF/container.xml");
  if (!container) throw new Error("not an epub: no META-INF/container.xml");
  const opfPath = byName(xml(container).children, "rootfile")[0]?.attribs["full-path"];
  const opfText = opfPath && text(opfPath);
  if (!opfText) throw new Error("not an epub: package file missing");
  const opf = xml(opfText).children;

  const manifest = new Map<string, { path: string; type: string; props: string }>();
  for (const item of byName(opf, "item")) {
    const { id, href, "media-type": type = "", properties = "" } = item.attribs;
    if (id && href) manifest.set(id, { path: resolvePath(opfPath, href), type, props: properties });
  }

  // Chapter titles: EPUB 3 nav first, then the NCX; by file, first entry wins.
  const titles = new Map<string, string>();
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  const navText = nav && text(nav.path);
  if (navText) {
    for (const a of byName(xml(navText).children, "a")) {
      const href = a.attribs.href;
      const p = href && resolvePath(nav.path, href);
      if (p && !titles.has(p)) titles.set(p, textOf(a));
    }
  }
  const spineEl = byName(opf, "spine")[0];
  const ncx = manifest.get(spineEl?.attribs.toc ?? "") ?? [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
  const ncxText = ncx && text(ncx.path);
  if (ncxText) {
    for (const point of byName(xml(ncxText).children, "navPoint")) {
      const src = byName(point.children, "content")[0]?.attribs.src;
      const label = byName(point.children, "text")[0];
      const p = src && resolvePath(ncx.path, src);
      if (p && !titles.has(p)) titles.set(p, textOf(label));
    }
  }

  const chapters: Chapter[] = [];
  for (const ref of spineEl ? byName(spineEl.children, "itemref") : []) {
    const item = manifest.get(ref.attribs.idref);
    if (!item || !/x?html/.test(item.type)) continue;
    const index = chapters.length;
    chapters.push({ index, path: item.path, title: titles.get(item.path) || `Section ${index + 1}` });
  }

  const meta = (name: string) => textOf(byName(opf, name)[0]);
  const coverId = byName(opf, "meta").find((m) => m.attribs.name === "cover")?.attribs.content;
  const coverItem =
    [...manifest.values()].find((m) => m.props.split(/\s+/).includes("cover-image")) ??
    (coverId ? (manifest.get(coverId) ?? [...manifest.values()].find((m) => m.path.endsWith(`/${coverId}`))) : undefined);

  return {
    title: meta("title") || "Untitled",
    // Calibre often stores the creator as "Last, First".
    author: meta("creator").replace(/^([^,]+), ([^,]+)$/, "$2 $1"),
    lang: meta("language") || "fr",
    cover: coverItem?.path,
    chapters,
    file,
    text,
  };
}
