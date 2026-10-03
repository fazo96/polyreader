import render from "dom-serializer";
import { type ChildNode, Element, type Node, Text } from "domhandler";
import { DomUtils, parseDocument } from "htmlparser2";
import { resolvePath } from "./epub.ts";

// Turns a chapter's XHTML into what the reader shows: the body, cleaned up,
// with every text block marked (data-b="b4") and every sentence wrapped
// (<span data-s="b4.s2">), plus the sentences as plain text for the
// translator. A sentence that crosses inline tags (<em>…</em>) gets one span
// per piece, all with the same id. Blocks without letters ("***", a chapter
// number) aren't marked and appear as they are in both panes.

export type Sentence = { id: string; text: string };
export type Block = { id: string; tag: string; sentences: Sentence[] };
export type Segmented = {
  /** Bump when the output changes shape: stored translations are keyed by its ids. */
  v: typeof SEGMENT_VERSION;
  html: string;
  /** Zip paths of the chapter's stylesheets. */
  styles: string[];
  blocks: Block[];
};

export const SEGMENT_VERSION = 1;

const BLOCKS = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p", "pre", "section", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "form", "input", "button", "head", "title", "link", "meta"]);
const ITALIC = new Set(["em", "i", "cite"]);
const HAS_LETTER = /\p{L}/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** "M. Dupont", "Mme. Roux", "J. Martin": a period that ends no sentence. */
const ABBREVIATION = /(?:^|[\s(«“])(?:M|MM|Mme|Mmes|Mlle|Mlles|Dr|Pr|Me|Mgr|St|Ste|cf|p|\p{Lu})\.$/u;

const localName = (el: Element) => el.name.replace(/^.*:/, "").toLowerCase();
const isElement = (n: Node): n is Element => n instanceof Element;
const isBlock = (el: Element) => BLOCKS.has(localName(el));

/** The sentences of `text` as [start, end) ranges, trimmed, with French dialogue fixes. */
export function sentenceRanges(text: string, lang = "fr"): [number, number][] {
  const raw: [number, number][] = [];
  for (const { index, segment } of new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text)) {
    let s = index;
    let e = index + segment.length;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) raw.push([s, e]);
  }
  const out: [number, number][] = [];
  for (const r of raw) {
    const piece = text.slice(r[0], r[1]);
    const prev = out.at(-1);
    // "— Quoi ! lança Lucas." is one sentence; so is a stray "***" or "»" with its neighbour.
    const joins =
      !HAS_WORD.test(piece) ||
      /^[\p{Ll}]/u.test(piece) ||
      /^[»”)\]]/.test(piece) ||
      (prev && ABBREVIATION.test(text.slice(prev[0], prev[1])));
    if (prev && joins) prev[1] = r[1];
    else out.push([...r]);
  }
  // A leading piece without words ("—") joins the next sentence.
  if (out.length > 1 && !HAS_WORD.test(text.slice(out[0][0], out[0][1]))) {
    out[1][0] = out[0][0];
    out.shift();
  }
  return out;
}

type Piece = { node: Text; start: number };

/** The text of a block, its text nodes' offsets and where its italics are. */
function collect(block: Element) {
  let text = "";
  const pieces: Piece[] = [];
  const italics: [number, number][] = [];
  const walk = (n: ChildNode) => {
    if (n instanceof Text) {
      pieces.push({ node: n, start: text.length });
      text += n.data;
    } else if (isElement(n)) {
      const name = localName(n);
      if (name === "br") {
        text += "\n";
        return;
      }
      if (name === "rt" || name === "rp") return;
      const start = text.length;
      n.children.forEach(walk);
      if (ITALIC.has(name) && text.length > start) italics.push([start, text.length]);
    }
  };
  block.children.forEach(walk);
  return { text, pieces, italics };
}

/** Sentence text for the translator: whitespace collapsed, italics as *…*. */
function marked(text: string, [s, e]: [number, number], italics: [number, number][]) {
  const marks = new Map<number, string>();
  for (const [a, b] of italics) {
    const from = Math.max(a, s);
    const to = Math.min(b, e);
    if (to <= from || !HAS_WORD.test(text.slice(from, to))) continue;
    marks.set(from, (marks.get(from) ?? "") + "*");
    marks.set(to, "*" + (marks.get(to) ?? ""));
  }
  let out = "";
  for (let i = s; i <= e; i++) {
    out += marks.get(i) ?? "";
    if (i < e) out += text[i];
  }
  // "**" where one italic run ends and the next begins is no italics change at all.
  return out.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/** Wrap each sentence's slices of each text node in <span data-s>. */
function wrap(pieces: Piece[], ranges: [number, number][], ids: string[]) {
  for (const { node, start } of pieces) {
    const end = start + node.data.length;
    const parts: ChildNode[] = [];
    let at = start;
    ranges.forEach(([s, e], i) => {
      const from = Math.max(s, start);
      const to = Math.min(e, end);
      if (to <= from) return;
      if (from > at) parts.push(new Text(node.data.slice(at - start, from - start)));
      parts.push(new Element("span", { "data-s": ids[i] }, [new Text(node.data.slice(from - start, to - start))]));
      at = to;
    });
    if (!parts.length) continue;
    if (at < end) parts.push(new Text(node.data.slice(at - start)));
    DomUtils.replaceElement(node, parts[0]);
    for (let i = 1; i < parts.length; i++) DomUtils.append(parts[i - 1], parts[i]);
  }
}

/** Strip what a reader page shouldn't run or link to, and point images at the asset route. */
function clean(el: Element, path: string, assetUrl: (zipPath: string) => string) {
  for (const child of [...el.children]) {
    if (!isElement(child)) continue;
    const name = localName(child);
    if (DROP.has(name)) {
      DomUtils.removeElement(child);
      continue;
    }
    for (const attr of Object.keys(child.attribs)) {
      if (/^on/i.test(attr) || attr === "style" && /expression|url\(/i.test(child.attribs[attr])) delete child.attribs[attr];
    }
    // Ids from the book would clash with the page's own.
    if (child.attribs.id) {
      child.attribs["data-id"] = child.attribs.id;
      delete child.attribs.id;
    }
    if (name === "img" && child.attribs.src) child.attribs.src = assetUrl(resolvePath(path, child.attribs.src));
    if (name === "image") {
      for (const k of ["xlink:href", "href"]) {
        if (child.attribs[k]) child.attribs[k] = assetUrl(resolvePath(path, child.attribs[k]));
      }
    }
    if (name === "a") {
      const href = child.attribs.href ?? "";
      if (/^https?:/i.test(href)) {
        child.attribs.target = "_blank";
        child.attribs.rel = "noreferrer";
      } else delete child.attribs.href; // links inside the book: not yet
    }
    clean(child, path, assetUrl);
  }
}

export function segmentChapter(
  xhtml: string,
  { path, assetUrl, lang = "fr" }: { path: string; assetUrl: (zipPath: string) => string; lang?: string },
): Segmented {
  const doc = parseDocument(xhtml, { xmlMode: true });
  const styles = DomUtils.findAll(
    (el) => localName(el) === "link" && /stylesheet/i.test(el.attribs.rel ?? "") && !!el.attribs.href,
    doc.children,
  ).map((el) => resolvePath(path, el.attribs.href));
  const body = DomUtils.findOne((el) => localName(el) === "body", doc.children);
  if (!body) return { v: SEGMENT_VERSION, html: "", styles, blocks: [] };
  clean(body, path, assetUrl);

  const blocks: Block[] = [];
  const visit = (el: Element) => {
    const nested = DomUtils.findOne(isBlock, el.children);
    if (nested || !isBlock(el)) {
      el.children.filter(isElement).forEach(visit);
      return;
    }
    const { text, pieces, italics } = collect(el);
    if (!HAS_LETTER.test(text)) return;
    const id = `b${blocks.length}`;
    const ranges = sentenceRanges(text, lang);
    const ids = ranges.map((_, i) => `${id}.s${i}`);
    wrap(pieces, ranges, ids);
    el.attribs["data-b"] = id;
    blocks.push({ id, tag: localName(el), sentences: ranges.map((r, i) => ({ id: ids[i], text: marked(text, r, italics) })) });
  };
  visit(body);

  return { v: SEGMENT_VERSION, html: render(body.children, { xmlMode: false, encodeEntities: "utf8" }), styles, blocks };
}

/**
 * A book stylesheet confined to the pane (`.book`): html/body rules apply to
 * the pane itself, url()s go through the asset route, and print-only rules go.
 */
export function scopeCss(css: string, path: string, assetUrl: (zipPath: string) => string) {
  const fixed = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@(import|charset)[^;]*;/g, "")
    .replace(/@page[^{]*\{[^}]*\}/g, "")
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, href: string) =>
      /^(data:|https?:)/.test(href) ? m : `url("${assetUrl(resolvePath(path, href))}")`,
    );
  // @font-face can't sit inside @scope.
  const fonts: string[] = [];
  const rules = fixed.replace(/@font-face\s*\{[^}]*\}/g, (m) => {
    fonts.push(m);
    return "";
  });
  const scoped = rules.replace(/(^|[},]\s*)(html|body)(?=[\s,{.:#[>~+])/g, "$1:scope");
  return `${fonts.join("\n")}\n@scope (.book) {\n${scoped}\n}`;
}

/**
 * The translation pane's HTML: the chapter as segmented, with each text
 * block's content replaced by `fill(block)`. Same tags and classes, so the
 * book's styling and the block ids line up across both panes.
 */
export function fillBlocks(seg: Segmented, fill: (block: Block) => string) {
  const doc = parseDocument(seg.html, { xmlMode: false });
  const byId = new Map(seg.blocks.map((b) => [b.id, b]));
  for (const el of DomUtils.findAll((e) => !!e.attribs["data-b"], doc.children)) {
    const block = byId.get(el.attribs["data-b"]);
    if (!block) continue;
    const inner = parseDocument(fill(block), { xmlMode: false });
    el.children = inner.children;
    for (const c of el.children) c.parent = el;
  }
  return render(doc.children, { xmlMode: false, encodeEntities: "utf8" });
}
