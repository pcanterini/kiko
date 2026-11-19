// Read-only calls allowed without asking (Settings → Permissions → "Allow read-only commands", on by
// default): a permission prompt whose call only reads (hooks/guard/auto-allow.mjs, in code, no
// model) is allowed at once, this once, with nothing said, no card and no phone question; Kiko's page
// shows a line ("allowed, only reads: git log …") and the log has `auto_allowed`. Why, 2026-11-12: a
// question about a release brought six spoken prompts in a minute, every one a read.
//
// Only Claude Code's and Codex's prompts (Held.agent): their shell commands come as written. Never a
// prompt the safety gate asked (core/guard.ts), a quick check's (they have their own rules:
// core/quick-ask.ts), a block offered to be allowed anyway, a folder's trust, or Claude's questions.
// Never "don't ask again": nothing is added to the agent's own settings.
import { readOnlyCall } from "../../hooks/guard/auto-allow.mjs";
import type { Held } from "../agents/types.ts";
import { guardOf } from "./guard.ts";
import { isQuickCheck } from "./quick-ask.ts";
import { flat, plainText } from "./text.ts";

/** The agents whose prompts Kiko may allow itself. */
const AGENTS = new Set(["claude-code", "codex"]);

/** The tools a prompt for which may be allowed (hooks/guard/auto-allow.mjs readOnlyCall): every other asks as before. */
const TOOLS = new Set(["Bash", "Read", "Grep", "Glob", "LS"]);

/** What it was, for the page's line and the log ("git log --oneline -3", cut at 300), and why it only reads ("git log, head"). */
export type ReadOnlyAllowed = { what: string; why: string };

/**
 * Whether Kiko allows this prompt by itself: what it is and why (its readers) when it does; null
 * when it's asked as before, with `skipped` told why for a tool that might have been (for the log).
 */
export function readOnlyAllowed(held: Held, skipped: (why: string) => void = () => {}): ReadOnlyAllowed | null {
  if (!held.isPermission || held.questions || !held.agent || !AGENTS.has(held.agent)) return null;
  const tool = held.tool;
  if (!tool || !TOOLS.has(tool.name)) return null;
  if (isQuickCheck(held.sessionId)) return null;
  const skip = (why: string) => {
    skipped(why);
    return null;
  };
  if (guardOf(held)) return skip("the safety gate asked it");
  // Paths must stay inside the session's own folder or ~/git (hooks/guard/auto-allow.mjs).
  const r = readOnlyCall(tool.name, tool.input, held.cwd);
  if (!r.readOnly) return skip(r.why);
  return { what: whatOf(tool.name, tool.input ?? {}), why: r.why };
}

/** The call in a few words: the command as written, the file read, what's searched for where. */
function whatOf(name: string, input: Record<string, unknown>) {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const where = str("path") ? ` in ${str("path")}` : "";
  const what =
    name === "Bash" ? str("command") : name === "Grep" ? `search for "${str("pattern")}"${where}` : name === "Glob" ? `list ${str("pattern")}${where}` : `read ${str("file_path") || str("path")}`;
  return flat(plainText(what), 300);
}
