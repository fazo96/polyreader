import "server-only";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { readAgentState, readBook, readChapter, readTranslation, TARGET_LANG, writeAgentState, writeTranslation } from "../books";
import { type ChapterTranslation, checkUnits, type Unit } from "../translation";
import { AGENT, chapterPrompt, MCP_NAME, systemPrompt, TOOL_PREFIX } from "./agent";
import type { ToolResult } from "./mcp";
import type { TranslatorEvent, TranslatorState } from "./types";

// One translator per book: a queue of chapters worked through one at a time
// by a single ACP session, so names and terms stay consistent across the
// book. Lives in the server process (on globalThis, so dev reloads keep it);
// reader pages watch it through /api/books/[id]/translate. The agent's
// session id is stored with the book and resumed after a restart.

/** Prompts per chapter before giving up on blocks the agent keeps skipping. */
const ATTEMPTS = 3;

class Translator {
  readonly token = randomBytes(24).toString("base64url");
  private state: TranslatorState = { status: "idle", queue: [], done: [] };
  private listeners = new Set<(e: TranslatorEvent) => void>();
  private child: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private stderr: string[] = [];
  private canResume = false;
  private pumping = false;
  /** Translations being written, so tool calls never race a read of the file. */
  private chapters = new Map<number, ChapterTranslation>();
  /** What the agent said in the current turn, logged when it isn't the expected "Done." */
  private said = "";

  constructor(
    readonly bookId: string,
    private baseUrl: string,
  ) {}

  // ─── Watchers ───────────────────────────────────────────────

  subscribe(fn: (e: TranslatorEvent) => void) {
    fn({ t: "state", state: this.state });
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(e: TranslatorEvent) {
    for (const fn of this.listeners) fn(e);
  }

  private setState(patch: Partial<TranslatorState>) {
    this.state = { ...this.state, ...patch };
    this.emit({ t: "state", state: this.state });
  }

  // ─── Queue ──────────────────────────────────────────────────

  private async translation(n: number) {
    let t = this.chapters.get(n);
    if (!t) {
      t = await readTranslation(this.bookId, n);
      this.chapters.set(n, t);
    }
    return t;
  }

  /** Translate chapter `n` next, then `after` (prefetch), skipping finished ones. */
  async request(n: number, after: number[] = []) {
    const wanted: number[] = [];
    for (const c of [n, ...after]) {
      if (c === this.state.chapter || wanted.includes(c)) continue;
      const seg = await readChapter(this.bookId, c);
      if (!seg) continue;
      if ((await this.translation(c)).done) {
        this.markDone(c);
        continue;
      }
      wanted.push(c);
    }
    // The chapter being read jumps the queue; prefetches wait their turn.
    const queue = this.state.queue.filter((c) => !wanted.includes(c));
    const next = wanted[0] === n ? [n, ...queue, ...wanted.slice(1)] : [...queue, ...wanted];
    this.setState({ queue: next, ...(this.state.status === "error" ? { status: "idle", error: undefined } : {}) });
    void this.pump();
  }

  /** Throw away a chapter's translation and queue it first. */
  async retranslate(n: number) {
    if (this.state.chapter === n) throw new Error("That chapter is being translated right now.");
    const t = { v: 1 as const, lang: TARGET_LANG, blocks: {}, done: false, updated: Date.now() };
    this.chapters.set(n, t);
    await writeTranslation(this.bookId, n, t);
    this.setState({ done: this.state.done.filter((c) => c !== n) });
    this.emit({ t: "blocks", chapter: n, blocks: {} });
    await this.request(n);
  }

  private markDone(n: number) {
    if (!this.state.done.includes(n)) this.setState({ done: [...this.state.done, n].sort((a, b) => a - b) });
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.state.queue.length) {
        const [n, ...rest] = this.state.queue;
        this.setState({ chapter: n, queue: rest, status: this.conn ? "working" : "starting" });
        try {
          await this.translateChapter(n);
        } catch (err) {
          console.error(`translator: chapter ${n} failed`, err);
          const detail = this.stderr.slice(-3).join(" · ");
          this.setState({ status: "error", error: `${(err as Error).message}${detail ? ` (${detail})` : ""}`, queue: [] });
          break;
        }
      }
    } finally {
      this.pumping = false;
      this.setState({ chapter: undefined, status: this.state.status === "error" ? "error" : "idle" });
    }
  }

  private async translateChapter(n: number) {
    const epub = await readBook(this.bookId);
    const seg = await readChapter(this.bookId, n);
    if (!epub || !seg) throw new Error(`No chapter ${n}.`);
    const t = await this.translation(n);
    const missing = () => new Set(seg.blocks.filter((b) => !t.blocks[b.id]).map((b) => b.id));
    for (let attempt = 0; attempt < ATTEMPTS && missing().size; attempt++) {
      await this.start();
      this.setState({ status: "working" });
      this.said = "";
      const res = await this.conn!.prompt({
        sessionId: this.sessionId!,
        prompt: [{ type: "text", text: chapterPrompt(n, epub.chapters[n].title, seg, missing(), attempt > 0) }],
      });
      if (this.said.trim() && this.said.trim() !== "Done.") console.log(`translator (chapter ${n}): ${this.said.trim().slice(0, 500)}`);
      if (res.stopReason === "refusal") throw new Error(`${AGENT.name} declined to translate chapter ${n}.`);
      if (res.stopReason === "cancelled") throw new Error("Translation stopped.");
    }
    const left = missing().size;
    if (left) throw new Error(`${AGENT.name} left ${left} block(s) of chapter ${n} untranslated.`);
    t.done = true;
    t.updated = Date.now();
    await writeTranslation(this.bookId, n, t);
    this.markDone(n);
  }

  // ─── The tool ───────────────────────────────────────────────

  async save(args: unknown): Promise<ToolResult> {
    const { chapter, blocks } = (args ?? {}) as { chapter?: unknown; blocks?: unknown };
    if (typeof chapter !== "number" || !Number.isInteger(chapter)) return { text: "chapter must be an integer", isError: true };
    if (!Array.isArray(blocks)) return { text: "blocks must be an array", isError: true };
    const seg = await readChapter(this.bookId, chapter);
    if (!seg) return { text: `there is no chapter ${chapter}`, isError: true };
    const t = await this.translation(chapter);

    const saved: Record<string, Unit[]> = {};
    const errors: string[] = [];
    for (const item of blocks as { block?: unknown; units?: unknown }[]) {
      const block = seg.blocks.find((b) => b.id === item?.block);
      if (!block) {
        errors.push(`${String(item?.block)}: no such block in chapter ${chapter}`);
        continue;
      }
      const units = checkUnits(block, item.units);
      if (typeof units === "string") errors.push(units);
      else saved[block.id] = units;
    }
    if (Object.keys(saved).length) {
      Object.assign(t.blocks, saved);
      t.updated = Date.now();
      await writeTranslation(this.bookId, chapter, t);
      this.emit({ t: "blocks", chapter, blocks: saved });
    }

    const missing = seg.blocks.filter((b) => !t.blocks[b.id]).map((b) => b.id);
    const lines = [`Saved ${Object.keys(saved).length} block(s).`];
    if (errors.length) lines.push(`Rejected ${errors.length}; fix and resend them:`, ...errors.map((e) => `- ${e}`));
    lines.push(
      missing.length
        ? `Chapter ${chapter} still needs ${missing.length} block(s): ${missing.slice(0, 40).join(", ")}${missing.length > 40 ? ", …" : ""}`
        : `Chapter ${chapter} is complete.`,
    );
    return { text: lines.join("\n"), isError: !Object.keys(saved).length && errors.length > 0 };
  }

  // ─── The agent process ──────────────────────────────────────

  private start(): Promise<void> {
    if (this.conn && this.sessionId) return Promise.resolve();
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch() {
    this.setState({ status: "starting", error: undefined });
    try {
      const cwd = path.join(os.tmpdir(), "polyreader-agent", this.bookId);
      await mkdir(cwd, { recursive: true });
      const [cmd, ...args] = AGENT.command;
      this.stderr = [];
      const child = spawn(cmd, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        this.stderr.push(...chunk.split("\n").filter(Boolean));
        if (this.stderr.length > 40) this.stderr.splice(0, this.stderr.length - 40);
      });
      const exited = new Promise<string>((resolve) => {
        child.on("error", (err) => resolve(err.message));
        child.on("exit", (code, signal) => resolve(`exited (${signal ?? code})`));
      });
      exited.then((why) => {
        if (this.child !== child) return; // stopped on purpose
        this.child = null;
        this.conn = null;
        this.sessionId = null;
        const detail = this.stderr.slice(-3).join(" · ");
        this.setState({ status: "error", error: `${AGENT.name} ${why}${detail ? `: ${detail}` : ""}` });
      });

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => this.client(), stream);
      this.conn = conn;

      const init = await Promise.race([
        conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}, // no fs, no terminal
          clientInfo: { name: "polyreader", version: "0.1.0" },
        }),
        exited.then((why) => Promise.reject(new Error(why))),
      ]);
      if (init.agentCapabilities?.mcpCapabilities?.http !== true) {
        throw new Error(`${AGENT.name} can't use polyreader's tool (no HTTP MCP support).`);
      }
      this.canResume = !!init.agentCapabilities?.sessionCapabilities?.resume;
      await this.openSession(cwd);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  private async openSession(cwd: string) {
    const conn = this.conn!;
    const epub = await readBook(this.bookId);
    const params = {
      cwd,
      mcpServers: [
        {
          type: "http" as const,
          name: MCP_NAME,
          url: `${this.baseUrl}/api/translate/mcp`,
          headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
        },
      ],
      _meta: AGENT.sessionMeta(systemPrompt({ title: epub?.title ?? this.bookId, author: epub?.author ?? "", lang: epub?.lang ?? "fr" }, TARGET_LANG)),
    };

    // Continue the book's session, so the agent remembers the names and terms it chose.
    const stored = await readAgentState(this.bookId);
    if (stored.sessionId && this.canResume) {
      try {
        await conn.resumeSession({ ...params, sessionId: stored.sessionId });
        this.sessionId = stored.sessionId;
        return;
      } catch (err) {
        console.error("translator: couldn't resume session", stored.sessionId, err);
      }
    }
    const res = await conn.newSession(params);
    this.sessionId = res.sessionId;
    await writeAgentState(this.bookId, { sessionId: res.sessionId });
  }

  stop() {
    const child = this.child;
    if (this.conn && this.sessionId) void this.conn.cancel({ sessionId: this.sessionId }).catch(() => {});
    this.child = null;
    this.conn = null;
    this.sessionId = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    }
  }

  // ─── ACP client side ────────────────────────────────────────

  private client(): Client {
    return {
      requestPermission: (p) => this.permission(p),
      sessionUpdate: async (n) => this.update(n),
    };
  }

  /** The one tool is pre-approved; anything else is refused. */
  private async permission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const meta = p.toolCall._meta?.claudeCode as { toolName?: unknown } | undefined;
    const name = typeof meta?.toolName === "string" ? meta.toolName : (p.toolCall.title ?? "");
    const allowed = name.startsWith(TOOL_PREFIX);
    const option =
      p.options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once")) ??
      p.options.find((o) => o.kind.startsWith(allowed ? "allow" : "reject"));
    if (!allowed) console.warn(`translator: blocked tool ${name || "(unnamed)"}`);
    return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private update({ sessionId, update: u }: SessionNotification) {
    if (sessionId !== this.sessionId) return;
    if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") this.said += u.content.text;
  }
}

const g = globalThis as typeof globalThis & { __polyTranslators?: Map<string, Translator>; __polyExitHook?: boolean };
const translators = (g.__polyTranslators ??= new Map());

if (!g.__polyExitHook) {
  g.__polyExitHook = true;
  const killAll = () => {
    for (const t of translators.values()) t.stop();
  };
  process.once("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(0);
    });
  }
}

export function getTranslator(bookId: string, baseUrl: string): Translator {
  let t = translators.get(bookId);
  if (!t) {
    t = new Translator(bookId, baseUrl);
    translators.set(bookId, t);
  }
  return t;
}

/** The translator an MCP request belongs to, by its bearer token. */
export function translatorForToken(token: string): Translator | undefined {
  for (const t of translators.values()) if (t.token === token) return t;
  return undefined;
}
