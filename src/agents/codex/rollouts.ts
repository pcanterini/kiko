// A Codex session's record, read: its rollout (~/.codex/sessions/…/rollout-<when>-<id>.jsonl, the
// hook's transcript_path; the names sessions were given with /rename are ./sessions.ts threadNames).
// Formats as Codex 0.153.0 writes them (codex-rs/protocol/src/protocol.rs, items.rs): each line {timestamp, type, payload}; what was said and done comes as
// event_msg lines. A rollout in "paginated" history mode has item_completed events (item.type
// UserMessage, AgentMessage, CommandExecution, FileChange…); one in "legacy" mode has user_message,
// agent_message, exec_command_end and patch_apply_end. Both have task_started, task_complete (with
// last_agent_message) and turn_aborted. Read best effort: a line it doesn't understand is skipped,
// and a missing file is nothing said. (response_item lines aren't read: Codex puts its own
// instructions and context there as the user's; and a hook's added context as a developer message,
// which is where the line Kiko's hook adds beside a dictated prompt goes, hooks/lib.mjs VOICE_PROMPT:
// never shown. Checked on 0.167.0.)
//
// Core's history (core/history.ts HistoryFolder) and the Kiko window's viewer follow a Claude
// Code transcript, so a rollout is also turned into one (`transcriptLines`): your words and Codex's
// as user and assistant text, a command as a Bash step with its output, a file change as an edit.
import { existsSync } from "node:fs";
// How Kiko's Stop hook gives Codex a spoken reply (hooks/codex-hook.mjs), in the hooks' own wording: taken off below.
import { VOICE_REPLY } from "../../../hooks/lib.mjs";
import { transcriptLine } from "../mirror.ts";
import { readTail } from "../tail.ts";

/** How much of a rollout's end is read for what was said last (and what its mirror starts from: ./mirror.ts). */
export const TAIL_BYTES = 2 * 1024 * 1024;

/** The end of a rollout (all of it when it's small), from the start of a line; "" when it can't be read. */
export function rolloutTail(path: string, bytes = TAIL_BYTES): string {
  try {
    return readTail(path, bytes, { lines: true });
  } catch {
    return "";
  }
}

/** A rollout's lines, parsed; those that aren't JSON skipped. */
export function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** What a rollout line says happened, in a form the rest reads; null for anything else. */
export type Said =
  | { kind: "you"; text: string; at: string | null }
  | { kind: "codex"; text: string; at: string | null }
  | { kind: "command"; id: string; command: string; output: string; failed: boolean; at: string | null }
  | { kind: "change"; id: string; files: Array<{ path: string; how: "add" | "update" | "delete"; added: number; removed: number }>; failed: boolean; at: string | null }
  | { kind: "turn"; at: string | null }
  | { kind: "done"; text: string; at: string | null };

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((c: any) => (typeof c?.text === "string" && (c.type === "text" || c.type === "Text" || c.type === undefined) ? c.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";

/** A shell command as Codex records it (["/bin/zsh", "-lc", "npm test"]): the command line itself. */
export function commandLine(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const parts = command.filter((p): p is string => typeof p === "string");
  const shell = parts.length >= 3 && /(?:^|\/)(?:ba|z|k|da)?sh$/.test(parts[0]) && /^-\w*c$/.test(parts[1]);
  return shell ? parts.slice(2).join(" ") : parts.join(" ");
}

/** A unified diff's lines added and removed (its +++/--- headers left out). */
function diffStats(diff: unknown): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (typeof diff === "string") {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/** A FileChange's (or patch_apply_end's) `changes`: each file, how, and its size. */
function changesOf(changes: unknown): Extract<Said, { kind: "change" }>["files"] {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, any>).map(([path, c]) => {
    const how: "add" | "update" | "delete" = c?.type === "add" || c?.type === "delete" ? c.type : "update";
    const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);
    const size = how === "add" ? { added: lines(c?.content), removed: 0 } : how === "delete" ? { added: 0, removed: lines(c?.content) } : diffStats(c?.unified_diff);
    return { path, how, ...size };
  });
}

/** One rollout line, read (`Said`). */
export function said(line: any): Said | null {
  if (line?.type !== "event_msg" || !line.payload || typeof line.payload !== "object") return null;
  const p = line.payload;
  const at = typeof line.timestamp === "string" ? line.timestamp : null;
  switch (p.type) {
    case "task_started":
    case "turn_started":
      return { kind: "turn", at };
    case "task_complete":
    case "turn_complete":
      return { kind: "done", text: typeof p.last_agent_message === "string" ? p.last_agent_message : "", at };
    // Legacy mode.
    case "user_message":
      return typeof p.message === "string" ? { kind: "you", text: p.message, at } : null;
    case "agent_message":
      return typeof p.message === "string" ? { kind: "codex", text: p.message, at } : null;
    case "exec_command_end":
      return { kind: "command", id: String(p.call_id ?? ""), command: commandLine(p.command), output: String(p.aggregated_output ?? p.stdout ?? ""), failed: p.exit_code !== 0, at };
    case "patch_apply_end":
      return { kind: "change", id: String(p.call_id ?? ""), files: changesOf(p.changes), failed: p.success === false, at };
    // Paginated mode.
    case "item_completed": {
      const item = p.item;
      switch (item?.type) {
        case "UserMessage":
          return { kind: "you", text: textOf(item.content), at };
        case "AgentMessage":
          return { kind: "codex", text: textOf(item.content), at };
        // A reply given through the Stop hook: your words, when they're Kiko's.
        case "HookPrompt": {
          const text = textOf(item.content) || (typeof item.text === "string" ? item.text : "");
          const i = text.indexOf(VOICE_REPLY);
          return i >= 0
            ? {
                kind: "you",
                text: text
                  .slice(i + VOICE_REPLY.length)
                  .replace(/<\/hook_prompt>\s*$/, "")
                  .trim(),
                at,
              }
            : null;
        }
        case "CommandExecution":
          return {
            kind: "command",
            id: String(item.id ?? ""),
            command: commandLine(item.command),
            output: String(item.aggregated_output ?? item.stdout ?? ""),
            failed: item.status === "failed" || item.status === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0),
            at,
          };
        case "FileChange":
          return { kind: "change", id: String(item.id ?? ""), files: changesOf(item.changes), failed: item.status === "failed" || item.status === "declined", at };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

/** What a rollout's end says, in order. */
function saids(path: string | undefined): Said[] {
  if (!path) return [];
  return parseLines(rolloutTail(path)).flatMap((l) => said(l) ?? []);
}

/** The last thing you asked a session (your words, not Codex's own context). */
export function lastUserText(path: string | undefined): string {
  const all = saids(path);
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if (s.kind === "you" && s.text.trim()) return s.text.trim();
  }
  return "";
}

/** The last thing Codex said in a session: its last message, else the last turn's reply. */
export function lastCodexText(path: string | undefined): string {
  const all = saids(path);
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i];
    if ((s.kind === "codex" || s.kind === "done") && s.text.trim()) return s.text.trim();
  }
  return "";
}

/**
 * Your words that reached a session during its latest turn, oldest first: its prompt, words typed
 * in while it ran (Codex steers them into the turn), and replies through Kiko's Stop hook (the
 * same turn carries on). Null when it has no rollout.
 */
export function saidSince(path: string | undefined): string[] | null {
  if (!path || !existsSync(path)) return null;
  const all = saids(path);
  let from = all.length;
  while (from > 0 && all[from - 1].kind !== "turn") from--;
  return all.slice(from).flatMap((s) => (s.kind === "you" && s.text.trim() ? [s.text.trim()] : []));
}

// ── As a Claude Code transcript (for core/history.ts and the window's viewer) ──

/** The transcript lines for what a rollout said (`Said`s, in order): what core's HistoryFolder reads. */
export function transcriptLines(all: readonly Said[]): string[] {
  const lines: object[] = [];
  for (const s of all) {
    const timestamp = s.at ?? undefined;
    switch (s.kind) {
      case "you":
        if (s.text.trim()) lines.push(transcriptLine("user", s.text, timestamp));
        break;
      case "codex":
        if (s.text.trim()) lines.push(transcriptLine("assistant", s.text, timestamp));
        break;
      case "command": {
        const id = `codex-cmd-${s.id || lines.length}`;
        lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: s.command } }] }, timestamp });
        lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: s.output, is_error: s.failed }] }, timestamp });
        break;
      }
      case "change":
        s.files.forEach((f, i) => {
          const id = `codex-patch-${s.id || lines.length}-${i}`;
          const name = f.how === "add" ? "Write" : "Edit";
          lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { file_path: f.path } }] }, timestamp });
          const hunk = [...Array(f.added).fill("+"), ...Array(f.removed).fill("-")];
          lines.push({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "", is_error: s.failed }] },
            toolUseResult: { structuredPatch: [{ lines: hunk }] },
            timestamp,
          });
        });
        break;
      default:
        break;
    }
  }
  return lines.map((l) => JSON.stringify(l));
}

/** Said things in rollout text that's been added (a whole number of lines), for a follower. */
export const saidIn = (text: string) => parseLines(text).flatMap((l) => said(l) ?? []);
