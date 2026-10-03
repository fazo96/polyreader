import type { Block } from "./segment.ts";

// A chapter's translation: per text block, the units that make it up. A unit
// translates one sentence, or several consecutive ones when the target
// language reads better merged; its `ids` are what the hover highlights.

export type Unit = { ids: string[]; text: string };

export type ChapterTranslation = {
  v: 1;
  lang: string;
  blocks: Record<string, Unit[]>;
  done: boolean;
  updated: number;
};

export const emptyTranslation = (lang: string): ChapterTranslation => ({ v: 1, lang, blocks: {}, done: false, updated: 0 });

/**
 * Check the units the translator sent for `block`: every sentence covered
 * once, in order, consecutive ids grouped, no empty text. Returns the clean
 * units, or what's wrong in words the agent can act on.
 */
export function checkUnits(block: Block, units: unknown): Unit[] | string {
  if (!Array.isArray(units) || !units.length) return `${block.id}: units must be a non-empty array`;
  const expected = block.sentences.map((s) => s.id);
  const out: Unit[] = [];
  let next = 0;
  for (const [i, u] of units.entries()) {
    const ids = (u as Unit)?.ids;
    const text = (u as Unit)?.text;
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== "string")) {
      return `${block.id}: unit ${i} needs "ids", a non-empty array of sentence ids`;
    }
    if (typeof text !== "string" || !text.trim()) return `${block.id}: unit ${i} (${ids.join(", ")}) has no text`;
    for (const id of ids) {
      if (id !== expected[next]) {
        return expected[next]
          ? `${block.id}: expected ${expected[next]} next but unit ${i} has ${id}; cover ${expected.join(", ")} in order, each once`
          : `${block.id}: ${id} is extra; this block's sentences are ${expected.join(", ")}`;
      }
      next++;
    }
    out.push({ ids: [...ids], text: text.trim() });
  }
  if (next < expected.length) return `${block.id}: missing ${expected.slice(next).join(", ")}`;
  return out;
}

/** A unit's text as HTML: escaped, with the translator's *italics*. */
export function unitHtml(text: string) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

/** A block's inner HTML in the translation pane: one span per unit, carrying the ids it covers. */
export const unitsHtml = (units: Unit[]) =>
  units.map((u) => `<span data-s="${u.ids.join(" ")}">${unitHtml(u.text)}</span>`).join(" ");

/** Shown in place of a block until its translation arrives. */
export const pendingHtml = (block: Block) =>
  `<span class="pending">${unitHtml(block.sentences.map((s) => s.text.replace(/\*/g, "")).join(" "))}</span>`;
