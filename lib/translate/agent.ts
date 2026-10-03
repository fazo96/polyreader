import "server-only";
import type { Segmented } from "../segment";

// The translator: Claude Code over ACP, launched with every built-in tool
// switched off, so all it can do is read what it's sent and hand back
// translations through polyreader's one MCP tool (./mcp.ts).

export const MCP_NAME = "polyreader";
export const TOOL_PREFIX = `mcp__${MCP_NAME}__`;

const split = (cmd: string) => cmd.trim().split(/\s+/);

export const AGENT = {
  name: "Claude Code",
  command: split(process.env.POLYREADER_AGENT ?? "npx -y @agentclientprotocol/claude-agent-acp@0.84.0"),
  sessionMeta: (systemPrompt: string) => ({
    systemPrompt,
    claudeCode: {
      options: {
        tools: [], // no Read/Write/Bash/Web…: only save_translation
        allowedTools: [`mcp__${MCP_NAME}`, `mcp__${MCP_NAME}__*`],
        strictMcpConfig: true, // ignore the user's own MCP servers
        settingSources: [], // ignore ~/.claude settings, hooks, CLAUDE.md
        allowDangerouslySkipPermissions: false,
      },
    },
  }),
};

export function systemPrompt(book: { title: string; author: string; lang: string }, target: string) {
  return `You are the translator inside polyreader, a reader that shows a book in its original language beside your translation. The book is "${book.title}" by ${book.author || "an unknown author"}, written in ${book.lang === "fr" ? "French" : `the language "${book.lang}"`}. You translate it into ${target}, a chapter at a time, for someone who reads only a little of the original language and follows along in both panes: when they point at a sentence on one side, its counterpart lights up on the other.

How to translate:
- Be faithful to the meaning, tone and register, and write natural, literary ${target}. Stay close to the original's sentence structure where ${target} allows it, so the reader can match the two sides; don't paraphrase or summarize, and don't add or drop anything.
- Keep names of people and places as they are. Keep invented or Latin terms, translating them only where the original's readers would understand them. Stay consistent across the book: the same character, place or term is rendered the same way in every chapter.
- Text between *asterisks* is italic in the original; mark the matching words in your translation the same way. Keep punctuation conventions natural for ${target} (e.g. dialogue introduced by "—" in French becomes quoted dialogue or keeps the dash, whichever you pick, consistently).

How to hand it back: each chapter comes as blocks (a paragraph or heading, e.g. [b12]) of numbered sentences (b12.s0, b12.s1, …). Call save_translation with blocks, each with its units: a unit is { "ids": [...], "text": "..." }. Normally a unit is one sentence ({ "ids": ["b12.s0"], "text": "…" }). When a sentence was split mid-thought or ${target} genuinely reads better merged, one unit may cover several consecutive sentences of the same block (["b12.s1", "b12.s2"]). Every sentence of a block must be covered exactly once, in order. Never split one sentence across units.

Send the chapter in several save_translation calls of about 15-25 blocks each, in order, rather than all at once. The tool tells you which blocks are still missing and rejects malformed ones with the reason: fix and resend those. When the tool says the chapter is complete, reply with just "Done." No commentary, notes or summaries.`;
}

/** The prompt for one chapter: the blocks still to translate, as numbered sentences. */
export function chapterPrompt(n: number, title: string, seg: Segmented, missing: Set<string>, retry: boolean) {
  const blocks = seg.blocks.filter((b) => missing.has(b.id));
  const body = blocks
    .map((b) => [`[${b.id}] ${b.tag}`, ...b.sentences.map((s) => `${s.id} ${s.text}`)].join("\n"))
    .join("\n\n");
  const intro = retry
    ? `Chapter ${n} ("${title}") still has ${blocks.length} block(s) without a translation. Translate these and save them with save_translation (chapter: ${n}):`
    : `Translate chapter ${n}, "${title}" (${blocks.length} blocks). Save with save_translation, chapter: ${n}.`;
  return `${intro}\n\n${body}`;
}
