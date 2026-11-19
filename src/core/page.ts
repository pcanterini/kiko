// Kiko's own page in its window: what you said, what Kiko said, where your words went, quick
// tasks' answers, errors and notices; the conversation the TUI shows, as it happens. Each line the
// app shows (ui-store's lines) goes, as JSON, into a file only you can read (in a folder only you
// can open, next to the app's lock: core/running.ts), which the page's viewer follows (src/ui/
// viewer.ts, in a pane of its own: src/terminals/tmux/viewer-pane.ts), so none of it is ever on a
// command line. Kept across runs (a line marks each start), cut back to its last lines when it
// grows large.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FOLDER, envVar } from "./name.ts";
import { appSocket } from "./running.ts";
import { ui, type Line, type LineKind } from "./ui-store.ts";

/** One line of the page: when, what kind (a ui-store line's, or "start": the app started), the text, and the session it's about. */
export type PageLine = { at: number; kind: LineKind | "start"; text: string; name?: string };

/** Where the page is kept: ~/.config/kiko/run/page.jsonl; next to the socket when KIKO_SOCKET sets one (the tests, the harness). */
export function pagePath(socket = appSocket()): string {
  return envVar("SOCKET") ? `${socket}.page.jsonl` : join(homedir(), ".config", CONFIG_FOLDER, "run", "page.jsonl");
}

/** Larger than this when the app starts, the page is cut back to its last KEPT lines. */
const MAX_BYTES = 1 << 20;
const KEPT = 600;
/** A line's text at most this long (a session's raw words can run long; the page shows a few lines of each). */
const MAX_TEXT = 4000;

/** A ui-store line as the page keeps it. */
const pageLine = (l: Pick<Line, "at" | "kind" | "text" | "name">): PageLine => ({ at: l.at, kind: l.kind, text: l.text.slice(0, MAX_TEXT), ...(l.name ? { name: l.name } : {}) });

/**
 * Starts keeping the page at `path`: made private (0600, in a 0700 folder) if new, cut back if
 * large, a start line, then every line the app shows. Returns how to stop. A write that fails is
 * dropped (the page is a view, never in the way of the app).
 */
export function keepPage(path = pagePath(), now = Date.now()): () => void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    if (statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-KEPT);
      writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    }
  } catch {
    return () => {};
  }
  const write = (l: PageLine) => {
    try {
      appendFileSync(path, `${JSON.stringify(l)}\n`);
    } catch {
      // the page is a view: never in the way
    }
  };
  write({ at: now, kind: "start", text: "" });
  const onLine = (l: Line) => write(pageLine(l));
  ui.on("line", onLine);
  return () => void ui.off("line", onLine);
}
