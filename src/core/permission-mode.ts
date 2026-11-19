// Permission modes: which one a session Kiko opens starts in (the "Permission mode" setting, under New sessions),
// what each session is in now (Claude Code's hooks say, on each event that carries
// `permission_mode`; Codex's daemon, as its settings change), the list's short tag for one that isn't
// in the mode the setting starts sessions in, and what's said when auto mode blocks something (the
// card that allows it anyway: core/block-override.ts).
//
// Why: every session Kiko opened used to start as plain `claude`, so in your Claude Code default,
// which can be auto. Auto mode's classifier blocks a risky action silently: no PermissionRequest, so
// no card, nothing on the phone, and "go ahead" in the chat isn't an approval. In a real case a
// deploy was blocked with nothing said, a "go ahead" was blocked again, and only after switching to
// Accept edits by hand did a normal permission prompt come as a card, and a spoken yes worked. So sessions Kiko opens start in Accept edits unless you pick
// another, the list shows a session in another mode, and a block is said (PermissionDenied).
// Scratch sessions are the exception while the setting is left at its default: auto, where the
// Claude Code installed offers it (startModeFor, 2026-11-05).
//
// The modes in Claude Code's own words, as its hooks give them (code.claude.com/docs/en/hooks,
// "permission_mode"): default (shown as Manual in 2.1.314; it still arrives as "default"),
// acceptEdits, plan, auto, dontAsk, bypassPermissions. Imports nothing that loads .env.
import type { ToolUse } from "../agents/types.ts";
import { sayableCommand, spokenDescription } from "./spoken-permission.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

/** A hook's `permission_mode` as one of the modes ("manual", the new name of "default", as "default"); null for anything else. */
export function permissionModeOf(raw: unknown): PermissionMode | null {
  if (raw === "manual") return "default";
  return typeof raw === "string" && (PERMISSION_MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : null;
}

/**
 * The "Permission mode" setting: the mode a session Kiko opens starts in. "manual" (Ask me),
 * "acceptEdits" (the default), "plan", "auto", or "inherit": no flag at all, so your Claude Code
 * default (`permissions.defaultMode`), as before 2026-10-30. Never bypass: not offered here.
 */
export type NewSessionMode = "manual" | "acceptEdits" | "plan" | "auto" | "inherit";

const NEW_SESSION_MODE_VALUES: readonly NewSessionMode[] = ["manual", "acceptEdits", "plan", "auto", "inherit"];

export const DEFAULT_NEW_SESSION_MODE: NewSessionMode = "acceptEdits";

/** The setting as read (KIKO_NEW_SESSION_MODE, else the settings): one of its values, else Accept edits. */
export function newSessionModeSetting(raw: unknown): NewSessionMode {
  const value = typeof raw === "string" ? raw.trim() : "";
  return (NEW_SESSION_MODE_VALUES as readonly string[]).includes(value) ? (value as NewSessionMode) : DEFAULT_NEW_SESSION_MODE;
}

/** Whether the setting was chosen (KIKO_NEW_SESSION_MODE, or saved): one of its values, not left at the default. */
export const newSessionModeChosen = (raw: unknown): boolean => typeof raw === "string" && (NEW_SESSION_MODE_VALUES as readonly string[]).includes(raw.trim());

/**
 * The mode a session Kiko opens starts in: the setting's, except in a scratch folder while the
 * setting was never chosen, where it's auto when its agent says it takes auto (Claude Code: its
 * `claude --help`, claude-code/modes-offered.ts). Scratch work is throwaway, and Accept edits asked
 * about every harmless read-only command there (the user, 2026-11-05: six questions in one scratch
 * session); auto's classifier lets routine calls through, a block is still said (or a card in
 * Kiko's tmux), and Kiko's own guard still asks on top. An agent that can't say (`offersMode` left
 * out: Codex, OpenCode) keeps the setting's mode, as does a Claude Code without auto
 * (`autoUnavailable`: the caller logs it), so the start never fails on a mode it would refuse.
 */
export async function startModeFor(o: {
  scratch: boolean;
  setting: NewSessionMode;
  chosen: boolean;
  offersMode?: (mode: PermissionMode) => Promise<boolean>;
}): Promise<{ mode: NewSessionMode; autoUnavailable?: true }> {
  if (!o.scratch || o.chosen || !o.offersMode) return { mode: o.setting };
  const offered = await o.offersMode("auto").catch(() => false);
  return offered ? { mode: "auto" } : { mode: o.setting, autoUnavailable: true };
}

/**
 * The mode a session opened with the setting at `setting` is in, as the hooks would say it: what the
 * list takes as the usual one. "Your Claude Code default" is taken as "default" (Manual), which is
 * Claude Code's own when nothing is set: with auto as your default, the list says "auto" on each one.
 */
export function expectedMode(setting: NewSessionMode): PermissionMode {
  return setting === "manual" || setting === "inherit" ? "default" : setting;
}

/** Each mode's tag in the list, short and plain. */
const MODE_TAGS: Record<PermissionMode, string> = {
  default: "ask",
  acceptEdits: "edits",
  plan: "plan",
  auto: "auto",
  dontAsk: "don't ask",
  bypassPermissions: "bypass",
};

/** A session's tag in the list: "" when its mode isn't known, or is the one the setting starts sessions in. */
export function modeTag(mode: string | null | undefined, setting: NewSessionMode): string {
  const known = permissionModeOf(mode);
  if (!known || known === expectedMode(setting)) return "";
  return MODE_TAGS[known];
}

/**
 * A tool call an agent's own safety layer blocked without asking: Claude Code's auto mode (its
 * PermissionDenied hook; `by` "auto", the default), or one of OpenCode's deny rules (`by` "rule": its
 * service's session.tool.failed, permission.rejected, for a call it never asked about). `mode`: the
 * session's permission mode as the agent said it with the block (Claude Code's `permission_mode`:
 * "auto", or "plan" with auto mode on), where it did.
 */
export type Blocked = { sessionId: string; cwd: string; tool: ToolUse; reason: string; by?: "auto" | "rule"; mode?: string };

// Control characters (and the invisible ones that reorder text) as spaces, runs of space as one, cut to `max`.
const plain = (text: string, max: number) => {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};

/** What the blocked call was doing, as said after "blocked Lacy from": "running wrangler deploy", "editing app.ts". */
export function blockedDoing(tool: ToolUse): string {
  const input = tool.input ?? {};
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const base = (path: string) => plain(path.split("/").pop() || path, 80);
  switch (tool.name) {
    case "Bash": {
      // A command said only when it's a few plain words (spoken-permission.ts), else what it's for.
      const command = sayableCommand(str("command"));
      const description = spokenDescription(input);
      return command ? `running ${command}` : description ? `running a command to ${description}` : "running a command";
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str("file_path") || str("notebook_path") ? `editing ${base(str("file_path") || str("notebook_path"))}` : "editing a file";
    case "Write":
      return str("file_path") ? `writing ${base(str("file_path"))}` : "writing a file";
    case "Read":
      return str("file_path") ? `reading ${base(str("file_path"))}` : "reading a file";
    case "WebFetch": {
      try {
        return `fetching ${new URL(str("url")).hostname}`;
      } catch {
        return "fetching a web page";
      }
    }
    case "WebSearch":
      return "searching the web";
    case "Agent":
    case "Task":
      return "starting a subagent";
    default: {
      const mcp = tool.name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return `using ${plain(mcp[2], 40)} from ${plain(mcp[1], 40)}`;
      return tool.name ? `using ${plain(tool.name, 40)}` : "doing something";
    }
  }
}

/**
 * What's said when auto mode blocks a session's tool call: what was blocked, plainly ("Auto mode
 * blocked Lacy from running wrangler deploy."). A block with no verdict (the classifier couldn't
 * check it, or wasn't there) says so. One of OpenCode's deny rules: "Your OpenCode permissions
 * blocked Lacy from running rm -rf build." Whether it can be allowed anyway is the caller's to add:
 * the card's "Allow it?" (core/block-override.ts), or why it can't.
 */
export function blockedLine(name: string, b: Pick<Blocked, "tool" | "reason" | "by">): string {
  if (b.by === "rule") return `Your OpenCode permissions blocked ${name} from ${blockedDoing(b.tool)}.`;
  const unchecked = /^Auto mode could not evaluate|^Classifier unavailable/i.test(b.reason.trim());
  return `Auto mode blocked ${name} from ${blockedDoing(b.tool)}.${unchecked ? " It couldn't check it, so it blocked it to be safe." : ""}`;
}
