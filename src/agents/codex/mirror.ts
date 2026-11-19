// A Codex session's conversation as a Claude Code transcript (../mirror.ts), for what follows one:
// core's history (core/history.ts HistoryWatcher: the phone's session screen) and the Kiko
// window's read-only viewer (src/ui/viewer.ts). Codex writes its rollout as it goes (./rollouts.ts),
// each line flushed; its mirror (codex/<session id>.jsonl next to Kiko's page) gets the same
// conversation as transcript lines, added to as the rollout grows (looked at every half second).
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Source } from "../mirror.ts";
import { saidIn, TAIL_BYTES, transcriptLines } from "./rollouts.ts";

/** Rollout text added since `offset`, up to its last whole line: the text, and where the next look starts. */
function addedSince(path: string, offset: number): { text: string; next: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { text: "", next: offset };
  }
  if (size < offset) return { text: "", next: size };
  if (size === offset) return { text: "", next: offset };
  const buffer = Buffer.alloc(size - offset);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, buffer.length, offset);
  } catch {
    return { text: "", next: offset };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const end = buffer.lastIndexOf(10);
  if (end < 0) return { text: "", next: offset };
  return { text: buffer.subarray(0, end + 1).toString("utf8"), next: offset + end + 1 };
}

/**
 * A session's rollout as a mirror's source (../mirror.ts Mirrors): its end so far (the last 2 MB,
 * from a whole line), then whatever comes after exactly that, looked at every `everyMs`. Null when
 * there's no rollout.
 */
export function rolloutSource(rollout: string | undefined, everyMs = 500): Source | null {
  if (!rollout) return null;
  let size = 0;
  try {
    size = statSync(rollout).size;
  } catch {}
  const start = Math.max(0, size - TAIL_BYTES);
  const first = addedSince(rollout, start);
  let offset = first.next;
  return {
    lines: transcriptLines(saidIn(start > 0 ? first.text.slice(first.text.indexOf("\n") + 1) : first.text)),
    follow(added) {
      const timer = setInterval(() => {
        const more = addedSince(rollout, offset);
        offset = more.next;
        if (more.text) added(transcriptLines(saidIn(more.text)));
      }, everyMs);
      timer.unref();
      return { stop: () => clearInterval(timer) };
    },
  };
}
