// A quick task asking you to let it use a tool it isn't allowed (quick-task.ts): Claude Code calls
// its permission tool (hooks/quick-permission.mjs), which sends the app a permission prompt as a
// session's hook does, as the session QUICK_CHECK_ID. The app asks it like any session's (the card,
// voice, the phone), as "Kiko's quick check", except:
//   - what changes things is denied outright, never asked (deniedOutright): the editing tools, any
//     MCP tool, and shell commands that change something or reach out (rm, a write with >, git
//     writing, docker prune, curl -d, …), read as the run's own guard hook reads them;
//   - "always" means always for that exact command in quick checks, kept with Kiko's settings
//     (QUICK_ALWAYS_FILE), never in Claude Code's: the next quick check runs it without asking;
//   - the web (WebFetch, WebSearch) is asked every time: never "always";
//   - let go without an answer (the window ran out) is a no: a quick check has no terminal to fall
//     back to, and it answers with what it couldn't check.
// It's done when it's answered, or the quick check went away; the quick check's clock stops meanwhile.
import { dirname, join } from "node:path";
import type { Answer, AskQuestion } from "./ask.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import type { Held, ToolUse } from "../agents/types.ts";
import { NAME, SLUG } from "./name.ts";
import { commandVerdict } from "../../hooks/guard/read-only.mjs";
import { SETTINGS_FILE } from "./settings.ts";

/** The session ID a quick check's permission prompts come as (hooks/quick-permission.mjs SESSION_ID); the phone's too. */
export const QUICK_CHECK_ID = SLUG;
/** What it's called on screen, out loud and on the phone. */
export const QUICK_CHECK_NAME = `${NAME}'s quick check`;

export const isQuickCheck = (sessionId: string | null | undefined) => sessionId === QUICK_CHECK_ID;

/** How long what it checks may be on a card. */
export const CHECK_FOR_MAX = 200;
/** What a check was asked, on one line and cut to CHECK_FOR_MAX. */
export const checkForText = (task: string) => {
  const one = task.replace(/\s+/g, " ").trim();
  return one.length > CHECK_FOR_MAX ? `${one.slice(0, CHECK_FOR_MAX - 1)}…` : one;
};
/** Its permission card's name: what it's for, not only the command ("Kiko's quick check, for: how much disk space is free"). */
export const quickCardName = (task: string) => `${QUICK_CHECK_NAME}, for: ${checkForText(task)}`;

/** Commands you allowed for good in quick checks: next to the settings file (~/.config/kiko/). */
export const QUICK_ALWAYS_FILE = join(dirname(SETTINGS_FILE), "quick-always.json");

/** The commands allowed for good, as `{ "commands": [...] }` in QUICK_ALWAYS_FILE. */
export function loadQuickAlways(file = QUICK_ALWAYS_FILE): string[] {
  // One that can't be read is set aside, never saved over (core/json-file.ts): none, until allowed again.
  const commands = (readJsonFile(file) as { commands?: unknown } | undefined)?.commands;
  return Array.isArray(commands) ? commands.filter((c): c is string => typeof c === "string") : [];
}

/** Adds a command to them. Best effort: without it, the next quick check asks again. */
export function rememberQuickAlways(command: string, file = QUICK_ALWAYS_FILE) {
  const commands = loadQuickAlways(file);
  if (commands.includes(command)) return true;
  try {
    writeJsonAtomic(file, { commands: [...commands, command] });
    return true;
  } catch {
    return false;
  }
}

/** What "always" keeps for a tool use: a Bash command, exactly. Nothing for anything else (the web is asked every time). */
export function alwaysRuleOf(tool: ToolUse | null): string | null {
  if (tool?.name !== "Bash") return null;
  const command = tool.input?.command;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/**
 * Why a tool use is denied without asking (it would change things), or null when it may be asked:
 * the editing tools, any MCP tool, and a shell command that changes something or reaches out, as
 * the quick check's own guard hook reads it (hooks/guard/read-only.mjs: rm, a write with >, git
 * writing, docker rm or prune, curl -d, ssh, kill, an install, …). The same in any permission mode.
 */
export function deniedOutright(tool: ToolUse | null): string | null {
  const name = tool?.name ?? "";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return "A quick check can't change files.";
  if (name.startsWith("mcp__")) return "A quick check has no other tools.";
  if (name === "Bash") {
    const command = typeof tool?.input?.command === "string" ? tool.input.command : "";
    const v = commandVerdict(command);
    if (v.verdict !== "change") return null;
    if (/^git\b/.test(v.what ?? "")) return "A quick check can't change a git repository.";
    return `A quick check only looks, and this would change something${v.what ? ` (${v.what})` : ""}.`;
  }
  return null;
}

/** What it asks, for the screen and the phone ("run whois kiko.dev"), in "wants to …". */
export function quickWhat(tool: ToolUse | null, described: string) {
  const command = tool?.name === "Bash" && typeof tool.input?.command === "string" ? tool.input.command.replace(/\s+/g, " ").trim() : "";
  return command ? `run ${command.length > 300 ? `${command.slice(0, 300)}…` : command}` : described;
}

/** The question out loud: "Kiko's quick check wants to run whois kiko.dev. Allow?" */
export const quickAskLine = (what: string) => `${QUICK_CHECK_NAME} wants to ${what}. Allow?`;

/** What happens to a quick check's request before anyone is asked. */
type QuickVerdict = { verdict: "deny"; why: string } | { verdict: "allow"; why: "always" } | { verdict: "ask" };

/** Denied outright, allowed for good before (`always`: the commands kept), or asked. */
export function quickVerdict(tool: ToolUse | null, always: readonly string[]): QuickVerdict {
  const denied = deniedOutright(tool);
  if (denied) return { verdict: "deny", why: denied };
  const rule = alwaysRuleOf(tool);
  if (rule && always.includes(rule)) return { verdict: "allow", why: "always" };
  return { verdict: "ask" };
}

/**
 * A quick check's permission prompt as the floor holds it: the hook's own (`inner`), with "always"
 * kept by Kiko (`remember`), and let go as a no. `done` once, when it's answered or goes away.
 */
export class QuickAsk implements Held {
  onClosed: () => void = () => {};
  private finished = false;

  private readonly inner: Held;
  private readonly o: { remember: (command: string) => void; done: () => void };

  constructor(inner: Held, o: { remember: (command: string) => void; done: () => void }) {
    this.inner = inner;
    this.o = o;
    inner.onClosed = () => {
      this.finish();
      this.onClosed();
    };
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.o.done();
  }

  get sessionId() {
    return this.inner.sessionId;
  }
  get cwd() {
    return this.inner.cwd;
  }
  readonly isPermission = true;
  get open() {
    return this.inner.open;
  }
  readonly desktop = false;
  readonly text = "";
  readonly continued = false;
  get tool() {
    return this.inner.tool;
  }
  /** Only a command: "always" is for that command, exactly; the web is asked every time. */
  get canAllowAlways() {
    return alwaysRuleOf(this.inner.tool) !== null;
  }
  readonly questions: AskQuestion[] | null = null;

  lastAsked() {
    return "";
  }
  saidThisTurn() {
    return null;
  }
  watchTyped() {}
  answer() {
    return false;
  }
  answerQuestions(_answers: Answer[]) {
    return false;
  }

  allow(always: boolean) {
    const rule = always ? alwaysRuleOf(this.inner.tool) : null;
    if (rule) this.o.remember(rule);
    const sent = this.inner.allow(false);
    this.finish();
    return sent;
  }

  deny(message: string) {
    const sent = this.inner.deny(message);
    this.finish();
    return sent;
  }

  /** Nobody answered in time: a no (there's no terminal to fall back to). */
  release() {
    return this.deny("Nobody answered in time.");
  }
}

/**
 * After a quick task, whether to offer it to a session: it ended needing changes, or with something
 * it couldn't check (a tool denied). Said once, after its answer.
 */
export const HAND_OFF_LINE = "I couldn't check that quickly. Want me to open a session for it?";
export function offersHandOff(r: { outcome: string; denied: string[] }) {
  if (r.outcome === "cancelled" || r.outcome === "timeout") return false;
  return r.outcome === "needs_changes" || r.denied.length > 0;
}
