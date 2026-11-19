// What a permission prompt is said as when no model words it: a quick check's question (always the
// same few words), a session's when Haiku's wording failed or came back empty, and what auto mode
// blocked. A command is said only when it's a few plain words ("run pnpm test"); anything else is
// what it's for, or a plain phrase. Before this, a quick check's question read out a whole shell
// pipeline (cd, ls, sed, sort, uniq, head…), when the command's own description said it in a few words.
//
// Only what's said: the screen (the card, the timeline's "asks permission to …", the phone) still
// shows the command (app/state.ts whatOf, decisions.ts describeTool).
import type { ToolUse } from "../agents/types.ts";
import { plainLine } from "./text.ts";

/** Longest a spoken "wants to …" may be; longer is the plain phrase instead. */
const MAX_SPOKEN = 120;

/** Whether text reads as code rather than words: pipes, `;`, `&&`, `$(`, a variable, backticks, redirects, braces, a path with several slashes, a very long token. */
export function codeLike(text: string): boolean {
  if (/[|;`<>{}\\]|&&|\$[\w({]/.test(text)) return true;
  return text.split(/\s+/).some((word) => (word.match(/\//g)?.length ?? 0) >= 2 || word.length > 30);
}

/**
 * A command short and plain enough to say as it is ("pnpm test", "wrangler deploy --env production"),
 * else null: at most 4 words and 40 characters, a program's name first, no more than 2 flags, and
 * nothing but letters, digits and . _ - : @ + (so no paths, pipes, quotes, globs, `$` or `=`).
 */
export function sayableCommand(command: string): string | null {
  const line = plainLine(command);
  if (!line || line.length > 40) return null;
  const words = line.split(" ");
  if (words.length > 4 || !/^[A-Za-z][\w.-]*$/.test(words[0])) return null;
  if (!words.every((w) => /^[\w.:@+-]+$/.test(w))) return null;
  if (words.filter((w) => w.startsWith("-")).length > 2) return null;
  return line;
}

/**
 * A tool input's own `description`, said after "wants to" ("Summarize log files by date and entry
 * kinds." → "summarize log files by date and entry kinds"): its first letter lower-cased (unless its
 * first word is a name, "GitHub", "README"), no closing period. Null when there's none, or it's long
 * or reads as code.
 */
export function spokenDescription(input: Record<string, unknown> | undefined): string | null {
  const raw = typeof input?.description === "string" ? plainLine(input.description) : "";
  const text = raw.replace(/[.\s]+$/, "");
  if (!text || text.length > 100 || codeLike(text)) return null;
  const first = text.split(" ")[0];
  return /^[A-Z][^A-Z]*$/.test(first) ? text[0].toLowerCase() + text.slice(1) : text;
}

// A file said by its name alone; "" when there's none.
const baseName = (path: string) => plainLine(path).split("/").filter(Boolean).pop() ?? "";
// A tool's or a server's name as words: "dns_update" → "dns update".
const asWords = (name: string) => plainLine(name.replace(/[_-]+/g, " "));

/** The plain phrase for a tool, when nothing more about it can be said. */
function generic(tool: ToolUse | null | undefined): string {
  switch (tool?.name) {
    case "Bash":
      return "run a command";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit a file";
    case "Write":
      return "write a file";
    case "Read":
      return "read a file";
    case "WebFetch":
      return "open a web page";
    case "WebSearch":
      return "search the web";
    case "Agent":
    case "Task":
      return "start a subagent";
    default:
      return "use a tool";
  }
}

function saying(tool: ToolUse | null | undefined): string {
  const input = tool?.input ?? {};
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (tool?.name) {
    case "Bash": {
      const description = spokenDescription(input);
      if (description) return description;
      const command = sayableCommand(str("command"));
      return command ? `run ${command}` : generic(tool);
    }
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const file = baseName(str("file_path") || str("notebook_path"));
      return file ? `edit ${file}` : generic(tool);
    }
    case "Write":
      return baseName(str("file_path")) ? `write ${baseName(str("file_path"))}` : generic(tool);
    case "Read":
      return baseName(str("file_path")) ? `read ${baseName(str("file_path"))}` : generic(tool);
    case "WebFetch": {
      try {
        return `open a web page on ${new URL(str("url")).hostname.replace(/^www\./, "")}`;
      } catch {
        return generic(tool);
      }
    }
    case "WebSearch": {
      const query = plainLine(str("query"));
      return query && query.split(" ").length <= 8 ? `search the web for ${query}` : generic(tool);
    }
    case "Agent":
    case "Task": {
      const description = spokenDescription(input);
      return description ? `start a subagent to ${description}` : generic(tool);
    }
    default: {
      const name = tool?.name ?? "";
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return `use ${asWords(mcp[2])} from ${asWords(mcp[1])}`;
      return name ? `use ${plainLine(name)}` : generic(tool);
    }
  }
}

/**
 * What a tool use is said as after "wants to", when no model words it: its description ("summarize
 * log files by date and entry kinds"), a short plain command ("run pnpm test"), a file by its name
 * ("edit app.ts"), a web page by its site ("open a web page on example.com"), else a plain phrase
 * ("run a command"). Last of all, anything still long or code-like is that plain phrase.
 */
export function spokenWhat(tool: ToolUse | null | undefined): string {
  const what = saying(tool);
  return what.length > MAX_SPOKEN || codeLike(what) ? generic(tool) : what;
}

/** A session's question out loud with no model's words: "Lacy wants to run a command. Allow?" (`who`: as said). */
export const plainPermissionLine = (who: string, tool: ToolUse | null | undefined) => `${who} wants to ${spokenWhat(tool)}. Allow?`;
