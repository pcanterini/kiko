import { followLines } from "../tail.ts";

/**
 * Watches a session's transcript for prompts queued while the app holds its Stop hook. Something
 * typed into the session then (by you, or by the app) doesn't reach Claude: Claude Code shelves it
 * as a queued prompt, a {"type":"queue-operation","operation":"enqueue"} line, until the hook lets
 * go. Polls the file's size and reads only what's appended after the watch starts (../tail.ts
 * followLines); stops once `active` says so. Calls `onQueued` with each queued prompt's text ("" when it isn't plain text).
 */
export function watchQueued(path: string, active: () => boolean, onQueued: (content: string) => void, everyMs = 450) {
  followLines(path, {
    everyMs,
    active,
    onLine(line) {
      if (!line.includes('"queue-operation"')) return;
      try {
        const record = JSON.parse(line);
        if (record.type !== "queue-operation" || record.operation !== "enqueue") return;
        const content = typeof record.content === "string" ? record.content : "";
        // Claude Code queues its own notices the same way (a background agent finished, a subagent's
        // hand-back, a message from another session); nobody typed those.
        if (harnessNotice(content)) return;
        onQueued(content);
      } catch {
        // not a whole JSON line; skip it
      }
    },
  });
}

// What Claude Code queues, word for word, once a usage limit it stopped at has reset.
const USAGE_RESET = "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.";

/**
 * A queued prompt Claude Code made itself, not one typed: a background task's notice
 * (`<task-notification>`), a subagent's hand-back (`<agent-message from="…">`), a message from
 * another session (`<cross-session-message …>`, `[Cross-session delivery notice]`, `[Cross-session
 * idle notice]`), and its note that the usage limit reset. A paste (`<pasted_content …>`), an
 * image (`[Image #1]`) or plain words are yours.
 */
export function harnessNotice(content: string) {
  return /^\s*(<task-notification>|<agent-message[\s>]|<cross-session-message[\s>]|\[Cross-session )/.test(content) || content.trim() === USAGE_RESET;
}
