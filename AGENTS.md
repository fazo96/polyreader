<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# polyreader

Read an epub beside an LLM translation of it: the original on the left, the translation on the right; pointing at a sentence on either side lights up its counterpart. Next.js 16 (App Router), plain CSS in `app/globals.css`, no UI kit. Same architecture as `../pen` (ACP agent + a tiny MCP endpoint).

## How it fits together

- `lib/epub.ts`: unzips the epub (fflate), reads the OPF for metadata and spine, the EPUB 3 nav or NCX for chapter titles. A chapter is a spine item; its index is its number in URLs (`/b/<book>/<n>`). Imports nothing app-specific, so tests load it with plain Node.
- `lib/segment.ts`: chapter XHTML → the body, cleaned (no scripts, book ids renamed `data-id`, images via `/api/books/<id>/asset/<zip path>`), with every innermost text block marked `data-b="b4"` and every sentence wrapped in `<span data-s="b4.s2">` (one span per text node when a sentence crosses `<em>` etc.). Sentences come from `Intl.Segmenter('fr')` plus fixes: dialogue tags after `!`/`?` (lowercase start), abbreviations (`M.`), stray punctuation all join the previous sentence. Blocks without letters (`***`, a chapter number) aren't marked and show as-is on both sides. `fillBlocks` builds the right pane from the same HTML, block contents swapped. `scopeCss` confines book CSS to `.book` with `@scope` (`body` → `:scope`).
- `lib/books.ts`: `data/<book>/` (`POLYREADER_DIR` overrides) holds `book.epub`, `chapters/<n>.json` (segmentation, written once: translations are keyed by its ids, so it must never shift; bump `SEGMENT_VERSION` when the output changes), `translations/<n>.json`, `session.json` (the agent's session id), `position.json`.
- `lib/translation.ts`: a translation is, per block, a list of units `{ ids, text }`; a unit covers one sentence or several consecutive ones of that block. `checkUnits` enforces coverage and order, with errors worded for the agent. `*text*` marks italics both ways.
- `lib/translate/`: one `Translator` per book (on `globalThis`), a queue of chapters worked through by one ACP session (Claude Code via `@agentclientprotocol/claude-agent-acp`, `POLYREADER_AGENT` overrides the command) so names and terms stay consistent; resumed with `session/resume` after a restart. Built-in tools are off; the agent's only tool is `save_translation` on `/api/translate/mcp` (bearer token per translator). Each chapter is sent as `[b12] p` + `b12.s0 <sentence>` lines; the agent saves 15-25 blocks per call, rejected blocks come back with the reason, and blocks still missing after a turn are re-prompted (3 attempts). Target language: `POLYREADER_LANG` (default English).
- `/api/books/<id>/translate`: GET is SSE (`state` and `blocks` events, `lib/translate/types.ts`); POST `{ action: "translate", chapter, prefetch }` or `{ action: "retranslate", chapter }`.
- `components/Reader.tsx`: both panes are plain DOM in one page. Hover: `[data-s~="<id>"]` on both sides gets `.lit`; a merged unit lights every sentence it covers. Scroll: the pane under the pointer leads; the other is placed so the same block sits at the same spot (`topBlock`/`scrollToBlock`). Arriving blocks are patched into the right pane's DOM in place (React sets each pane's HTML once per chapter). Opening a chapter asks for it and the next chapter with text.

## Commands

- `nix develop` for Node; `npm run dev` (hostnames other than localhost need `POLYREADER_DEV_ORIGINS`, see `next.config.ts`), `npm test` (node:test on `tests/**/*.test.ts`, including a pass over the sample book in `data/sample/book.epub` when present).
