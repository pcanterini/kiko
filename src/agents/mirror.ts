// A conversation as a Claude Code transcript, for what follows one: core's history (core/history.ts
// HistoryWatcher: the phone's session screen) and the Kiko window's read-only viewer (src/ui/
// viewer.ts, in a pane of its own: src/terminals/tmux/viewer-pane.ts), which read a transcript and
// nothing else. An agent that keeps its conversation another way has it mirrored: Codex's rollout
// (./codex/mirror.ts), T3 Code's threads and OpenCode's sessions, which live on their servers
// (`watched`). Each is written as the lines a transcript has ({"type":"user"} with your words,
// {"type":"assistant"} with the agent's text: `transcriptLine`) to a file next to Kiko's page
// (<agent>/<id>.jsonl), private (0600 in a 0700 folder: the conversation is yours), written afresh
// when it's first asked for in a run, then added to as the conversation grows, while it's listed.
// The viewer reads a file's end once, then only what's added, so a line is never written twice.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A transcript's line for words said: yours (`user`), or the agent's (`assistant` text), with when (left out when not known). */
export function transcriptLine(role: "user" | "assistant", text: string, at?: string): object {
  return role === "user"
    ? { type: "user", message: { role: "user", content: text }, timestamp: at }
    : { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: at };
}

/** One conversation to mirror: its lines so far, then `follow`, which hands on the lines added after them until it's stopped. */
export type Source = { lines: string[]; follow(added: (lines: string[]) => void): { stop(): void } };

/** The files of the conversations asked for in this run, each kept to its conversation while it's listed. */
export class Mirrors {
  private readonly kept = new Map<string, { file: string; following: { stop(): void } }>();
  private readonly dir: () => string;
  private readonly open: (id: string) => Source | null;

  /** `dir`: where the files go (asked when the first is written); `open`: a conversation by its ID (null: nothing to mirror, yet). */
  constructor(dir: () => string, open: (id: string) => Source | null) {
    this.dir = dir;
    this.open = open;
  }

  /** A conversation's file (what it said so far, then kept to it); "" when there's nothing to mirror, or it can't be written. */
  path(id: string): string {
    const had = this.kept.get(id);
    if (had) return had.file;
    const source = this.open(id);
    if (!source) return "";
    const file = join(this.dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.jsonl`);
    try {
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      writeFileSync(file, source.lines.length ? `${source.lines.join("\n")}\n` : "", { mode: 0o600 });
    } catch {
      return "";
    }
    const following = source.follow((lines) => {
      if (!lines.length) return;
      try {
        appendFileSync(file, `${lines.join("\n")}\n`);
      } catch {}
    });
    this.kept.set(id, { file, following });
    return file;
  }

  /** Stops keeping the files of conversations no longer listed (`listed`: the IDs of those that are). */
  keepOnly(listed: ReadonlySet<string>) {
    for (const [id, { following }] of this.kept) {
      if (listed.has(id)) continue;
      following.stop();
      this.kept.delete(id);
    }
  }

  stop() {
    for (const { following } of this.kept.values()) following.stop();
    this.kept.clear();
  }
}

// ── A conversation as messages (T3 Code's threads, OpenCode's sessions) ──

/**
 * The lines a transcript would have for a conversation's done messages not written yet (`written`:
 * their IDs, added to). `projection`: `{messages: [{id, role, text, createdAt, streaming?}]}`, as
 * T3 Code's thread has them (OpenCode's session is put that way: ./opencode/index.ts projectionOf).
 * Only messages that are done (not `streaming`) are written, each once, in order.
 */
export function messageLines(projection: unknown, written: Set<string>): string[] {
  const messages: unknown[] = Array.isArray((projection as any)?.messages) ? (projection as any).messages : [];
  const lines: string[] = [];
  for (const m of messages as any[]) {
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    const id = typeof m?.id === "string" ? m.id : "";
    if (!text || !id || m.streaming === true || written.has(id) || (m.role !== "user" && m.role !== "assistant")) continue;
    written.add(id);
    lines.push(JSON.stringify(transcriptLine(m.role, text, typeof m.createdAt === "string" ? m.createdAt : undefined)));
  }
  return lines;
}

/** Follows a conversation as messages: `changed` gets the whole of them each time they change (T3 Code's client.ts watchThread). */
type Watch = (id: string, changed: (projection: unknown) => void) => { stop(): void };

/** A conversation followed by `watch`, as a mirror's source: nothing at first, then each message once it's done. */
export const watched =
  (watch: Watch) =>
  (id: string): Source => ({
    lines: [],
    follow(added) {
      const written = new Set<string>();
      return watch(id, (projection) => added(messageLines(projection, written)));
    },
  });
