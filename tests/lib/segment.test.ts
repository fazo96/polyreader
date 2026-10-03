import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseDocument, DomUtils } from "htmlparser2";
import { openEpub } from "../../lib/epub.ts";
import { fillBlocks, scopeCss, segmentChapter, sentenceRanges } from "../../lib/segment.ts";
import { checkUnits, pendingHtml, unitHtml, unitsHtml } from "../../lib/translation.ts";

const SAMPLE = new URL("../../data/sample/book.epub", import.meta.url);
const assetUrl = (p: string) => `/asset/${p}`;
const split = (text: string) => sentenceRanges(text).map(([s, e]) => text.slice(s, e));

test("sentences: French dialogue tags stay with their line", () => {
  assert.deepEqual(split("— Un alchimiste ne dit jamais n’importe quoi ! lança Lucas le doigt levé. Il rit."), [
    "— Un alchimiste ne dit jamais n’importe quoi ! lança Lucas le doigt levé.",
    "Il rit.",
  ]);
});

test("sentences: pieces without words join a neighbour", () => {
  assert.deepEqual(split("Fin. *** Début."), ["Fin.", "*** Début."]);
  assert.deepEqual(split("Non. —"), ["Non. —"]);
});

test("sentences: abbreviations don't end a sentence", () => {
  assert.deepEqual(split("M. Dupont arriva. Il s’assit avec Mme. Roux."), ["M. Dupont arriva.", "Il s’assit avec Mme. Roux."]);
  assert.deepEqual(split("Quoi ? dit-il. Bon."), ["Quoi ? dit-il.", "Bon."]);
});

const chapter = (xhtml: string) =>
  segmentChapter(
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="../Styles/a.css"/><script>x()</script></head><body>${xhtml}</body></html>`,
    { path: "OEBPS/Text/c.xhtml", assetUrl },
  );

test("segment: wraps sentences across inline tags and keeps the text", () => {
  const seg = chapter(`<h1>1</h1><p class="courant">— <em>Narcissus !</em> Fleurs purgatives. En infusion, <b>aide</b> contre la toux !</p><div>***</div>`);
  assert.deepEqual(seg.styles, ["OEBPS/Styles/a.css"]);
  assert.equal(seg.blocks.length, 1, "number-only and *** blocks are left alone");
  assert.deepEqual(
    seg.blocks[0].sentences.map((s) => s.text),
    ["— *Narcissus !*", "Fleurs purgatives.", "En infusion, aide contre la toux !"],
  );
  const doc = parseDocument(seg.html);
  const spans = DomUtils.findAll((el) => !!el.attribs["data-s"], doc.children);
  assert.deepEqual([...new Set(spans.map((s) => s.attribs["data-s"]))], ["b0.s0", "b0.s1", "b0.s2"]);
  // The visible text is unchanged by the wrapping.
  const p = DomUtils.findOne((el) => el.attribs["data-b"] === "b0", doc.children)!;
  assert.equal(DomUtils.textContent(p), "— Narcissus ! Fleurs purgatives. En infusion, aide contre la toux !");
  assert.ok(!seg.html.includes("<script"), "scripts are dropped");
});

test("segment: images point at the asset route, book ids don't leak", () => {
  const seg = chapter(`<div id="x"><img src="../Images/cover.jpg" alt=""/></div><p id="n1">Un mot.</p>`);
  assert.match(seg.html, /src="\/asset\/OEBPS\/Images\/cover\.jpg"/);
  assert.doesNotMatch(seg.html, / id="/);
});

test("segment: nested blocks are segmented at the innermost level", () => {
  const seg = chapter(`<div class="cadre"><p>Un.</p><p>Deux. Trois.</p></div>`);
  assert.deepEqual(
    seg.blocks.map((b) => [b.id, b.tag, b.sentences.length]),
    [
      ["b0", "p", 1],
      ["b1", "p", 2],
    ],
  );
});

test("units: checked for coverage and order", () => {
  const block = { id: "b3", tag: "p", sentences: [{ id: "b3.s0", text: "A." }, { id: "b3.s1", text: "B." }, { id: "b3.s2", text: "C." }] };
  assert.deepEqual(checkUnits(block, [{ ids: ["b3.s0"], text: " A " }, { ids: ["b3.s1", "b3.s2"], text: "BC" }]), [
    { ids: ["b3.s0"], text: "A" },
    { ids: ["b3.s1", "b3.s2"], text: "BC" },
  ]);
  assert.match(checkUnits(block, [{ ids: ["b3.s0"], text: "A" }]) as string, /missing b3\.s1, b3\.s2/);
  assert.match(checkUnits(block, [{ ids: ["b3.s1"], text: "B" }]) as string, /expected b3\.s0/);
  assert.match(checkUnits(block, [{ ids: ["b3.s0", "b3.s1", "b3.s2", "b3.s3"], text: "x" }]) as string, /extra/);
  assert.match(checkUnits(block, [{ ids: ["b3.s0"], text: "" }]) as string, /no text/);
  assert.match(checkUnits(block, "nope") as string, /non-empty array/);
});

test("units: rendered escaped, with italics and their ids", () => {
  assert.equal(unitHtml(`<b>"Hi"</b> & *Narcissus*`), "&lt;b&gt;&quot;Hi&quot;&lt;/b&gt; &amp; <em>Narcissus</em>");
  assert.equal(unitsHtml([{ ids: ["b1.s0", "b1.s1"], text: "Hi." }]), `<span data-s="b1.s0 b1.s1">Hi.</span>`);
});

test("fillBlocks: same structure, block content replaced", () => {
  const seg = chapter(`<h2 class="t">Brume</h2><p class="courant">Un. Deux.</p><hr/>`);
  const html = fillBlocks(seg, (b) => (b.id === "b0" ? unitsHtml([{ ids: ["b0.s0"], text: "Mist" }]) : pendingHtml(b)));
  assert.equal(
    html,
    `<h2 class="t" data-b="b0"><span data-s="b0.s0">Mist</span></h2><p class="courant" data-b="b1"><span class="pending">Un. Deux.</span></p><hr>`,
  );
});

test("scopeCss: confined to the pane, urls rewritten, @page dropped", () => {
  const css = scopeCss(
    `body {margin: 0 5%;} @page {margin: 20%;} p.x,body .y {color: red} @font-face {src: url(../Fonts/a.ttf)}`,
    "OEBPS/Styles/s.css",
    assetUrl,
  );
  assert.match(css, /^@font-face \{src: url\("\/asset\/OEBPS\/Fonts\/a\.ttf"\)\}/);
  assert.match(css, /@scope \(\.book\) \{\n:scope \{margin: 0 5%;\}/);
  assert.match(css, /p\.x,:scope \.y/);
  assert.doesNotMatch(css, /@page/);
});

test("the sample book: every chapter segments and keeps all its text", { skip: !existsSync(SAMPLE) }, () => {
  const book = openEpub(readFileSync(SAMPLE));
  assert.equal(book.title, "A Plague Tale : Tenebris");
  assert.equal(book.author, "Cédric Degottex");
  assert.equal(book.chapters.length, 34);
  assert.equal(book.chapters[4].title, "1. Innocence");
  let sentences = 0;
  for (const ch of book.chapters) {
    const seg = segmentChapter(book.text(ch.path)!, { path: ch.path, assetUrl });
    const again = segmentChapter(book.text(ch.path)!, { path: ch.path, assetUrl });
    assert.deepEqual(again, seg, `${ch.path} segments the same way twice`);
    const doc = parseDocument(seg.html);
    for (const b of seg.blocks) {
      const el = DomUtils.findOne((e) => e.attribs["data-b"] === b.id, doc.children)!;
      // Every letter of the block sits inside some sentence span.
      const outside = DomUtils.findAll(() => true, el.children)
        .filter((e) => !e.attribs["data-s"])
        .flatMap((e) => e.children.filter((c) => c.type === "text").map((c) => (c as unknown as { data: string }).data));
      const direct = el.children.filter((c) => c.type === "text").map((c) => (c as unknown as { data: string }).data);
      assert.ok(![...outside, ...direct].some((t) => /\p{L}/u.test(t)), `${ch.path} ${b.id}: text outside sentences`);
      sentences += b.sentences.length;
    }
  }
  assert.ok(sentences > 3000, `found ${sentences} sentences`);
});
