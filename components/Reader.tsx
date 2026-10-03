"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { unitsHtml } from "@/lib/translation";
import type { TranslatorEvent, TranslatorState } from "@/lib/translate/types";

// The two panes: the book on the left, the translation on the right. Both are
// the same chapter HTML with the same block ids (data-b); sentences carry
// data-s ids, and a translated unit lists every id it covers, so pointing at
// either side lights up `[data-s~="<id>"]` on both. The pane under the
// pointer leads scrolling and the other follows, block by block.

type Props = {
  bookId: string;
  bookTitle: string;
  lang: string;
  chapters: { index: number; title: string }[];
  n: number;
  next?: number;
  css: string;
  sourceHtml: string;
  targetHtml: string;
  blockIds: string[];
  translated: string[];
  done: boolean;
  initialBlock?: string;
};

type Side = "source" | "target";

const POSITION_DELAY_MS = 1500;

type Anchor = { id: string; f: number; gap: number };

/**
 * The block at the top of `pane`: how far into it the top edge is (0–1), or,
 * when it starts below the edge (headings, images above it), how far below.
 */
function topBlock(pane: HTMLElement): Anchor | null {
  const top = pane.getBoundingClientRect().top;
  for (const el of pane.querySelectorAll<HTMLElement>("[data-b]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= top) continue;
    return r.top >= top ? { id: el.dataset.b!, f: 0, gap: r.top - top } : { id: el.dataset.b!, f: (top - r.top) / r.height, gap: 0 };
  }
  return null;
}

/** Scroll `pane` so block `id` sits where `topBlock` found it in the other pane. */
function scrollToBlock(pane: HTMLElement, { id, f, gap }: Anchor) {
  const el = pane.querySelector<HTMLElement>(`[data-b="${id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  pane.scrollTop += r.top + f * r.height - gap - pane.getBoundingClientRect().top;
}

function statusText(s: TranslatorState | null, n: number, done: boolean, progress: string) {
  if (!s) return done ? "" : "Connecting…";
  if (s.status === "error") return s.error ?? "The translator stopped.";
  if (s.chapter === n) return s.status === "starting" ? "Starting the translator…" : `Translating… ${progress}`;
  if (done) return s.chapter !== undefined ? `Translating chapter ${s.chapter} ahead…` : "";
  if (s.queue.includes(n)) return "Waiting to translate…";
  return s.status === "starting" ? "Starting the translator…" : "";
}

export default function Reader(p: Props) {
  const router = useRouter();
  const source = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const lead = useRef<Side>("source");
  const lit = useRef<{ key: string; els: Element[] }>({ key: "", els: [] });
  const [state, setState] = useState<TranslatorState | null>(null);
  const [translated, setTranslated] = useState(() => new Set(p.translated));
  const [done, setDone] = useState(p.done);

  // The HTML is set once per chapter; translations then patch the right pane in place.
  const sourceHtml = useMemo(() => ({ __html: p.sourceHtml }), [p.sourceHtml]);
  const targetHtml = useMemo(() => ({ __html: p.targetHtml }), [p.targetHtml]);

  const pane = (side: Side) => (side === "source" ? source.current : target.current);

  // ─── Translation: ask for it, then watch it arrive ─────────

  useEffect(() => {
    const es = new EventSource(`/api/books/${p.bookId}/translate`);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as TranslatorEvent;
      if (e.t === "state") {
        setState(e.state);
        if (e.state.done.includes(p.n)) setDone(true);
        return;
      }
      if (e.chapter !== p.n) return;
      const ids = Object.keys(e.blocks);
      if (!ids.length) {
        router.refresh(); // cleared for a fresh translation: placeholders come from the server
        return;
      }
      const el = target.current;
      const anchor = lead.current === "target" && el ? topBlock(el) : null;
      for (const id of ids) {
        const block = el?.querySelector<HTMLElement>(`[data-b="${id}"]`);
        if (block) block.innerHTML = unitsHtml(e.blocks[id]);
      }
      // Text above the reader's spot just changed height: keep their place.
      if (anchor && el) scrollToBlock(el, anchor);
      else sync("source");
      setTranslated((prev) => new Set([...prev, ...ids]));
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.bookId, p.n]);

  useEffect(() => {
    const prefetch = p.next === undefined ? [] : [p.next];
    void fetch(`/api/books/${p.bookId}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "translate", chapter: p.n, prefetch }),
    });
  }, [p.bookId, p.n, p.next]);

  const retry = () =>
    fetch(`/api/books/${p.bookId}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "translate", chapter: p.n, prefetch: p.next === undefined ? [] : [p.next] }),
    });

  const retranslate = async () => {
    if (!confirm("Throw away this chapter's translation and translate it again?")) return;
    const res = await fetch(`/api/books/${p.bookId}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retranslate", chapter: p.n }),
    });
    if (!res.ok) alert(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't start over.");
    else {
      setDone(false);
      setTranslated(new Set());
    }
  };

  // ─── Scrolling together ─────────────────────────────────────

  const sync = useCallback((from: Side) => {
    const a = pane(from);
    const b = pane(from === "source" ? "target" : "source");
    if (!a || !b) return;
    const at = topBlock(a);
    if (at) scrollToBlock(b, at);
    else b.scrollTop = a.scrollTop;
  }, []);

  const savePosition = useRef<ReturnType<typeof setTimeout> | null>(null);
  const position = useCallback(() => {
    // At the very top, the chapter opens at its start: nothing to remember.
    const at = source.current && source.current.scrollTop > 0 ? topBlock(source.current) : null;
    return JSON.stringify({ chapter: p.n, block: at?.id });
  }, [p.n]);

  const onScroll = (side: Side) => () => {
    if (lead.current !== side) return; // the follower moving
    sync(side);
    if (savePosition.current) clearTimeout(savePosition.current);
    savePosition.current = setTimeout(() => {
      void fetch(`/api/books/${p.bookId}/position`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: position() });
    }, POSITION_DELAY_MS);
  };

  useEffect(() => {
    if (source.current && p.initialBlock) scrollToBlock(source.current, { id: p.initialBlock, f: 0, gap: 0 });
    sync("source");
    // Remember the chapter even if the reader never scrolls.
    void fetch(`/api/books/${p.bookId}/position`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: position() });
    const hide = () => {
      if (document.visibilityState === "hidden") navigator.sendBeacon(`/api/books/${p.bookId}/position`, new Blob([position()], { type: "application/json" }));
    };
    document.addEventListener("visibilitychange", hide);
    const resize = () => sync(lead.current);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("resize", resize);
      if (savePosition.current) clearTimeout(savePosition.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Pointing at a sentence ─────────────────────────────────

  const light = (ids: string[], from: Side | null) => {
    const key = ids.join(" ");
    if (key === lit.current.key) return;
    for (const el of lit.current.els) el.classList.remove("lit");
    const els = ids.length
      ? [source.current, target.current].flatMap((root) =>
          root ? [...root.querySelectorAll(ids.map((id) => `[data-s~="${id}"]`).join(","))] : [],
        )
      : [];
    for (const el of els) el.classList.add("lit");
    lit.current = { key, els };
    if (!from) return;

    // The counterpart, units included: every id it covers on the other side.
    const other = pane(from === "source" ? "target" : "source");
    const twin = other && els.find((el) => other.contains(el));
    if (!other || !twin) return;
    const twinIds = twin.getAttribute("data-s")!.split(" ");
    if (twinIds.some((id) => !ids.includes(id))) {
      const more = [...other.ownerDocument.querySelectorAll(twinIds.map((id) => `[data-s~="${id}"]`).join(","))];
      for (const el of more) el.classList.add("lit");
      lit.current.els.push(...more);
    }
    // Bring it into view if the panes have drifted apart.
    const r = twin.getBoundingClientRect();
    const box = other.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) {
      other.scrollBy({ top: r.top - box.top - box.height / 3, behavior: "smooth" });
    }
  };

  const onPoint = (side: Side) => (e: React.PointerEvent | React.MouseEvent) => {
    const s = (e.target as Element).closest("[data-s]");
    light(s ? s.getAttribute("data-s")!.split(" ") : [], side);
  };

  // ─── Chapters ───────────────────────────────────────────────

  const prev = p.n > 0 ? p.n - 1 : undefined;
  const after = p.n < p.chapters.length - 1 ? p.n + 1 : undefined;
  const go = (n: number | undefined) => {
    if (n === undefined) return;
    void fetch(`/api/books/${p.bookId}/position`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapter: n }) });
    router.push(`/b/${p.bookId}/${n}`);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.target as Element).closest("select, input")) return;
      if (e.key === "ArrowLeft") go(prev);
      if (e.key === "ArrowRight") go(after);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  const progress = p.blockIds.length ? `${Math.min(translated.size, p.blockIds.length)} / ${p.blockIds.length}` : "";
  const status = statusText(state, p.n, done, progress);

  return (
    <div className="reader">
      <style>{p.css}</style>
      <header className="bar">
        <Link href="/" className="home" title="Library">
          {p.bookTitle}
        </Link>
        <nav>
          <button onClick={() => go(prev)} disabled={prev === undefined} title="Previous chapter (←)">
            ‹
          </button>
          <select value={p.n} onChange={(e) => go(Number(e.target.value))}>
            {p.chapters.map((c) => (
              <option key={c.index} value={c.index}>
                {c.title}
              </option>
            ))}
          </select>
          <button onClick={() => go(after)} disabled={after === undefined} title="Next chapter (→)">
            ›
          </button>
        </nav>
        <div className={`status${state?.status === "error" ? " error" : ""}`}>
          {status && <span>{status}</span>}
          {state?.status === "error" && <button onClick={retry}>Retry</button>}
          {done && p.blockIds.length > 0 && state?.chapter !== p.n && (
            <button onClick={retranslate} title="Translate this chapter again">
              Retranslate
            </button>
          )}
        </div>
      </header>
      <main className="panes" onPointerLeave={() => light([], null)}>
        <div
          ref={source}
          className="pane"
          lang={p.lang}
          onScroll={onScroll("source")}
          onPointerEnter={() => (lead.current = "source")}
          onWheel={() => (lead.current = "source")}
          onTouchStart={() => (lead.current = "source")}
          onPointerOver={onPoint("source")}
          onClick={onPoint("source")}
        >
          <div className="book" dangerouslySetInnerHTML={sourceHtml} />
        </div>
        <div
          ref={target}
          className="pane"
          lang="en"
          onScroll={onScroll("target")}
          onPointerEnter={() => (lead.current = "target")}
          onWheel={() => (lead.current = "target")}
          onTouchStart={() => (lead.current = "target")}
          onPointerOver={onPoint("target")}
          onClick={onPoint("target")}
        >
          <div className="book" dangerouslySetInnerHTML={targetHtml} />
        </div>
      </main>
    </div>
  );
}
