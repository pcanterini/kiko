// A permission prompt Kiko holds in a Claude Code hook, answered in Claude Code's own dialog instead.
// Claude Code draws its dialog beside a held PermissionRequest hook, and answered there it runs (or
// skips) the tool and leaves the hook running, with nothing to say so (2.1.318, checked live
// 2026-11-05). The list's look every 4 s (app/standing.ts sessionsListed: listed blocked, then not)
// misses an answer quicker than that, so while one is held it's watched here, for as long as it's
// held and no longer:
// - its transcript (~/.claude/projects/<folder>/<session>.jsonl, a subagent's own under
//   <session>/subagents/agent-<id>.jsonl), from its end: the prompt's own tool_use is found (the
//   hook carries no tool_use_id: the most recent assistant tool_use of the hook's tool and input
//   with nothing after it yet), then what's appended is followed (../tail.ts followLines) for the
//   first sign its session moved past it: the call's tool_result (allowed and done, or denied), a
//   progress line for it, an interruption, its turn going on to another message or ending;
// - its session's process record (./sessions.ts recordStatus, ~1 s): "waiting" while its dialog is
//   up, then not. Only while it's the session's one prompt held: another's dialog may come and go.
// What Claude Code 2.1.319 writes while an allowed command runs: nothing at all for it until its
// tool_result (checked 2026-11-07 on the transcripts' structure: no progress lines), so a long
// command allowed there is told by the record (its dialog gone) or, failing that, its result.
// Transcripts are internal to Claude Code: everything here is best effort, and a miss only means the
// prompt is taken down later (the list's look, its turn's Stop, its hold limit), never early.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { followLines, tailAt } from "../tail.ts";
import { recordStatus } from "./sessions.ts";

/** The tool call a prompt asks for, as its hook says it (tool_input clipped: hooks/lib.mjs clipInput). */
export type PromptCall = { name: string; input?: Record<string, unknown> };

/** The prompt's own tool_use in its transcript: its id, and the assistant message it's part of. */
export type PromptUse = { id: string; messageId: string | null };

/** What showed its session moved past the prompt. */
export type PastSign = "tool_result" | "progress" | "interrupted" | "next_message" | "turn_ended" | "dialog_closed";

// The longest string the hook sends whole (hooks/lib.mjs MAX_STRING); a longer one is cut, with "…".
const CLIPPED = 2000;

function sameText(hook: string, used: string) {
  if (hook.length === CLIPPED + 1 && hook.endsWith("…")) return used.startsWith(hook.slice(0, CLIPPED));
  return hook === used;
}

/** Whether a tool_use's input is the hook's: every text field both have says the same (a clipped one, its start). */
export function sameInput(hook: Record<string, unknown> | undefined, used: unknown): boolean {
  if (!hook || !used || typeof used !== "object") return true;
  for (const [key, value] of Object.entries(hook)) {
    const theirs = (used as Record<string, unknown>)[key];
    if (typeof value === "string" && typeof theirs === "string" && !sameText(value, theirs)) return false;
  }
  return true;
}

const blocks = (entry: any): any[] => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

function textOf(entry: any): string {
  const content = entry?.message?.content;
  if (typeof content === "string") return content;
  return blocks(entry)
    .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/**
 * What an entry written after the prompt's tool_use says of it: a sign its session moved past it, or
 * null (its own bookkeeping: titles, queued prompts, attachments, another part of the same message).
 */
export function pastIt(entry: any, use: PromptUse): PastSign | null {
  switch (entry?.type) {
    case "user":
      if (blocks(entry).some((b) => b?.type === "tool_result" && b.tool_use_id === use.id)) return "tool_result";
      if (!entry.isMeta && textOf(entry).startsWith("[Request interrupted by user")) return "interrupted";
      return null;
    case "progress":
      return entry.toolUseID === use.id || entry.parentToolUseID === use.id ? "progress" : null;
    case "assistant": {
      // A part of the same message (a call beside it) isn't; the next message is: its call is behind it.
      const id = entry.message?.id;
      return typeof id === "string" && id !== use.messageId ? "next_message" : null;
    }
    case "system":
      return entry.subtype === "turn_duration" || entry.subtype === "stop_hook_summary" ? "turn_ended" : null;
    default:
      return null;
  }
}

/**
 * The prompt's own tool_use among a transcript's entries (oldest first): the most recent assistant
 * tool_use of the hook's tool and input with nothing after it that moved past it. An older one of the
 * same call, answered already, has its result (or the turn's next message) after it; the prompt's own
 * being written is no sign of anything. Null when it isn't there (not written yet).
 */
export function findPrompt(entries: readonly unknown[], call: PromptCall): PromptUse | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry?.type !== "assistant") continue;
    const uses = blocks(entry).filter((b) => b?.type === "tool_use" && typeof b.id === "string" && b.name === call.name && sameInput(call.input, b.input));
    for (const b of uses.reverse()) {
      const use: PromptUse = { id: b.id, messageId: typeof entry.message?.id === "string" ? entry.message.id : null };
      if (!entries.slice(i + 1).some((later) => pastIt(later, use))) return use;
    }
  }
  return null;
}

/** Each whole JSON line of a transcript's text, parsed; one that isn't (cut, or being written) left out. */
function entriesOf(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** The transcript a prompt's tool_use is in: its session's, or its subagent's own. Null when there's none. */
export function promptTranscript(transcript: string | undefined, sessionId: string, agentId?: string): string | null {
  if (!transcript) return null;
  if (!agentId) return transcript;
  const own = join(dirname(transcript), sessionId, "subagents", `agent-${agentId}.jsonl`);
  return existsSync(own) ? own : null;
}

// The prompts watched now, by session (`count`), and how many times that changed: the record's status
// speaks for a session's one prompt only, held alone from when its dialog was seen up.
const watched = new Map<string, { count: number; changes: number }>();

/** How far back the prompt's tool_use is looked for: the end of its transcript, where it was just written. */
const TAIL_BYTES = 512 * 1024;
/** How often its transcript is looked at (a stat, and what was appended read). */
export const WATCH_MS = 500;
/** How often its session's record is (one small file read). */
export const RECORD_MS = 1000;
/** How long its tool_use is looked for, as its transcript grows, before only its record is watched. */
const FIND_FOR_MS = 30_000;

export type PromptWatch = {
  sessionId: string;
  /** Its transcript (promptTranscript); null: only its record is watched. */
  transcript: string | null;
  call: PromptCall;
  /** Its hook's parent process: Claude Code's, or the shell it ran the hook in (./sessions.ts recordStatus). */
  pids?: readonly (number | undefined)[];
  /** Still held: the watch stops once it isn't. */
  open: () => boolean;
  /** Its session moved past it (once): answered, or cancelled, in its own window. */
  answered: (sign: PastSign) => void;
  everyMs?: number;
  recordEveryMs?: number;
  findForMs?: number;
};

/**
 * Watches a held prompt for an answer in Claude Code's own dialog (above), until it's no longer held
 * or `answered` is called, once. Its transcript is read from its end only; until its tool_use is
 * written, the end is looked at again each time it grows.
 */
export function watchPrompt(w: PromptWatch) {
  let done = false;
  const mine = watched.get(w.sessionId) ?? { count: 0, changes: 0 };
  watched.set(w.sessionId, mine);
  mine.count++;
  mine.changes++;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(recordTimer);
    stopFollowing?.();
    mine.count--;
    mine.changes++;
    if (mine.count <= 0 && watched.get(w.sessionId) === mine) watched.delete(w.sessionId);
  };
  const active = () => {
    if (!done && !w.open()) finish();
    return !done;
  };
  const sign = (s: PastSign) => {
    if (!active()) return;
    finish();
    w.answered(s);
  };

  // Its session's record: its dialog seen up, then gone, with it the session's one prompt held all
  // the while. With another held beside it (or since), whose dialog that was can't be told from here.
  let upSince: number | null = null;
  const recordTimer = setInterval(() => {
    if (!active()) return;
    if (mine.count !== 1) {
      upSince = null;
      return;
    }
    const status = recordStatus(w.sessionId, w.pids ?? []);
    if (status === "waiting") upSince = mine.changes;
    else if (status && upSince === mine.changes) sign("dialog_closed");
    else upSince = null;
  }, w.recordEveryMs ?? RECORD_MS);
  recordTimer.unref();

  // Its transcript: its tool_use found, then followed past it.
  let stopFollowing: (() => void) | null = null;
  const path = w.transcript;
  if (!path) return finish;
  let use: PromptUse | null = null;
  let seenEnd = -1;
  const look = () => {
    let tail: { text: string; end: number };
    try {
      tail = tailAt(path, TAIL_BYTES, { lines: true });
    } catch {
      return;
    }
    if (tail.end === seenEnd) return;
    seenEnd = tail.end;
    // A last line still being written is left for the follow to read whole.
    const whole = tail.text.slice(0, tail.text.lastIndexOf("\n") + 1);
    use = findPrompt(entriesOf(whole), w.call);
    if (!use) return;
    const found = use;
    stopFollowing = followLines(path, {
      from: tail.end - Buffer.byteLength(tail.text.slice(whole.length)),
      everyMs: w.everyMs ?? WATCH_MS,
      active,
      onLine(line) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        const s = pastIt(entry, found);
        if (s) sign(s);
      },
    });
  };
  look();
  if (!use && !done) {
    // Not written yet: looked for again as the transcript grows, for a while (it's written just
    // before its hook runs; one never found, a hook older than `agent_id` for a subagent's call say,
    // is left to its record).
    const until = Date.now() + (w.findForMs ?? FIND_FOR_MS);
    const finding = setInterval(() => {
      if (!active() || use || Date.now() > until) return clearInterval(finding);
      look();
      if (use) clearInterval(finding);
    }, w.everyMs ?? WATCH_MS);
    finding.unref();
  }
  return finish;
}
