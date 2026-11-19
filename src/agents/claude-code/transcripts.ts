// A session's transcript (~/.claude/projects/<folder>/<session id>.jsonl): where it is, and the few
// things read from its end (its names, what it was started from, what was last asked and said).
// Its history, folded into steps, is core/history.ts; what's typed in while it's held, ./typed-in.ts.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { yourBlocks } from "../../core/history.ts";
import { envVar } from "../../core/name.ts";
import { readTail } from "../tail.ts";

// Transcripts are internal to Claude Code and their format may change, so everything that
// reads them is best effort: a miss returns "" and the app carries on without it.

const TAIL_BYTES = 1024 * 1024;

/** Where a session's transcript was found outside its folder's project, by session ID. */
const movedTranscripts = new Map<string, string>();

/**
 * Claude Code keeps a session's transcript under the project of the folder it started in. A session
 * whose folder has since moved (resumed there, or the folder renamed) still writes to the old one,
 * so when it isn't where the folder says, look for it by ID in every project.
 */
export function transcriptPath(cwd: string, sessionId: string) {
  // KIKO_CLAUDE_PROJECTS points the harness at a fake one (as ./projects.ts projectsDir).
  const projects = envVar("CLAUDE_PROJECTS") ?? `${homedir()}/.claude/projects`;
  const path = `${projects}/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}.jsonl`;
  if (existsSync(path)) return path;
  const moved = movedTranscripts.get(sessionId);
  if (moved && existsSync(moved)) return moved;
  try {
    for (const dir of readdirSync(projects)) {
      const found = `${projects}/${dir}/${sessionId}.jsonl`;
      if (existsSync(found)) {
        movedTranscripts.set(sessionId, found);
        return found;
      }
    }
  } catch {}
  return path;
}

/**
 * From the transcript: the name given with /rename (or in the desktop app) and Claude Code's
 * latest automatic title, either of which may be missing, and what started the session ("cli",
 * "claude-desktop"…).
 */
export function transcriptInfo(cwd: string, sessionId: string): { customTitle: string; aiTitle: string; entrypoint: string } {
  const tail = readTail(transcriptPath(cwd, sessionId), TAIL_BYTES);
  return {
    customTitle: lastField(tail, "customTitle"),
    aiTitle: lastField(tail, "aiTitle"),
    entrypoint: lastField(tail, "entrypoint"),
  };
}

function lastField(text: string, field: string): string {
  const matches = [...text.matchAll(new RegExp(`"${field}":"((?:[^"\\\\]|\\\\.)*)"`, "g"))];
  return matches.length ? JSON.parse(`"${matches[matches.length - 1][1]}"`) : "";
}

/**
 * Where a session's turn stands, as its transcript says it: when it was last written (`at`, ms epoch;
 * 0 when there's none) and whether its last turn ended (`ended`: the assistant's final message, the
 * turn's own "turn_duration" line after it, or "[Request interrupted by user]"; false for anything
 * a turn goes on from: your prompt, a background task's notification, a tool call or its result).
 * Null `ended` when the end of the file says neither. For the session's status (./turns.ts), so it
 * stays cheap: a stat each time, and the tail read only when the file changed.
 */
export function transcriptTurn(path: string): { at: number; ended: boolean | null } {
  let size: number;
  let at: number;
  try {
    ({ size, mtimeMs: at } = statSync(path));
  } catch {
    return { at: 0, ended: null };
  }
  const known = turnsRead.get(path);
  if (known && known.at === at && known.size === size) return { at, ended: known.ended };
  let ended: boolean | null = null;
  try {
    ended = turnEnded(readTail(path, TURN_TAIL_BYTES));
  } catch {}
  turnsRead.delete(path);
  turnsRead.set(path, { at, size, ended });
  if (turnsRead.size > 200) turnsRead.delete(turnsRead.keys().next().value!);
  return { at, ended };
}

// The end of a transcript is enough to tell: a line too long for it (a big tool result) is skipped.
const TURN_TAIL_BYTES = 256 * 1024;
const turnsRead = new Map<string, { at: number; size: number; ended: boolean | null }>();

/** Whether a transcript's tail ends a turn (`transcriptTurn`): its last entry that says, read from the end. */
export function turnEnded(tail: string): boolean | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Its own bookkeeping (titles, costs, queued prompts, attachments) says nothing either way.
    if (entry?.type === "system") {
      if (entry.subtype === "turn_duration") return true;
      continue;
    }
    if (entry?.type === "assistant") {
      const reason = entry.message?.stop_reason;
      return reason === "end_turn" || reason === "stop_sequence";
    }
    if (entry?.type !== "user" || entry.isMeta) continue;
    const content = entry.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : "";
    if (text.startsWith("[Request interrupted by user")) return true;
    // A command run at its prompt (/login, /model): no turn.
    if (/^<(?:command-name|command-message|local-command-)/.test(text.trimStart())) continue;
    return false;
  }
  return null;
}

/** The last thing the user typed in a session, skipping tool results and system wrappers. */
export function lastUserMessage(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  const tail = readTail(transcriptPath, TAIL_BYTES);
  // Claude Code records the latest prompt on its own line; scanning messages is the fallback.
  const lastPrompt = lastField(tail, "lastPrompt");
  if (lastPrompt.trim()) return lastPrompt.trim();
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // also skips the first line, usually cut in half by the tail read
    }
    if (entry?.type !== "user" || entry.isMeta) continue;
    // Your words as the conversation shows them (core/history.ts yourWords, 2026-11-14): a long
    // dictation or a paste, which Claude Code wraps in lines starting with "<", was passed over
    // here for whatever was asked before it.
    const text = yourBlocks(entry.message?.content);
    if (text) return text;
  }
  return "";
}

/** The last text Claude wrote in a session, skipping tool calls. */
export function lastClaudeText(transcriptPath: string): string {
  const lines = readTail(transcriptPath, TAIL_BYTES).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    const text = entry.message.content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
