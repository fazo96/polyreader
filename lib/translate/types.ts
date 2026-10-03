import type { Unit } from "../translation";

// What the reader page hears from a book's translator over SSE.

export type TranslatorStatus = "idle" | "starting" | "working" | "error";

export type TranslatorState = {
  status: TranslatorStatus;
  /** The chapter being translated now, and the ones waiting. */
  chapter?: number;
  queue: number[];
  /** Chapters fully translated (of those this server has looked at). */
  done: number[];
  error?: string;
};

export type TranslatorEvent =
  | { t: "state"; state: TranslatorState }
  | { t: "blocks"; chapter: number; blocks: Record<string, Unit[]> };
