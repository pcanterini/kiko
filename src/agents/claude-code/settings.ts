// Our entries in Claude Code's ~/.claude/settings.json: hooks/claude-code-hook.mjs on each event it
// handles. Nothing here writes the file (./setup.ts does, when you connect Claude Code: the first-run
// card, settings → Agents, `kiko setup claude`); this is what they are, and how they go in next to
// other hooks on the same event. Imports nothing that loads .env or writes logs.
import { hookCommand } from "../../core/app-root.ts";
import { isOurs } from "../hooks-file.ts";

/** The hook's command, by absolute path: Claude Code runs it from any folder (an installed copy's, by its `current` link: core/app-root.ts). */
export const HOOK_COMMAND = hookCommand("hooks/claude-code-hook.mjs");

/**
 * Each event's timeout, in seconds: a Stop waits out your reply, a permission prompt your yes or
 * no, for up to an hour: one nobody answered in its voice window stands, held with its card up on
 * the Mac and the phone until it's answered (src/core/standing.ts; Kiko lets it go 30 s before this,
 * 2026-11-05; it was 120 s, raised in installed files by the start's upgrade: staleEvents). A session starting or ending, taking a prompt in, or having a tool call blocked by auto mode
 * waits for nothing (the hook is gone within a second); those four are optional: the first two only
 * get a session listed sooner, UserPromptSubmit tells the phone a message it sent has started, and
 * PermissionDenied has a block said (2026-10-30: auto mode blocked Lacy's change twice, silently);
 * PreToolUse is Kiko's safety gate (optional too: the start's upgrade adds it to a connected file).
 */
export const HOOK_TIMEOUTS = { Stop: 300, PermissionRequest: 3600, SessionStart: 5, SessionEnd: 5, UserPromptSubmit: 5, PermissionDenied: 5, PreToolUse: 15 } as const;

/**
 * The events whose entries name the tools they run for (Claude Code's `matcher`). PreToolUse, Kiko's
 * safety gate (core/guard.ts, added 2026-11-02): only shell commands (Bash, and Monitor's) and MCP
 * tools, so reads, edits and searches never start the hook at all. Its 15 s covers the app's
 * classifier (2.5 s) inside the hook's own 6 s wait.
 */
export const HOOK_MATCHERS: Partial<Record<keyof typeof HOOK_TIMEOUTS, string>> = { PreToolUse: "Bash|Monitor|mcp__.*" };

/** The events sessions can't speak up without: a finished turn, a permission prompt. The others are optional. */
export const REQUIRED_EVENTS = ["Stop", "PermissionRequest"] as const;

/** What marks one of our entries among the others: the hook's script's name. */
export const HOOK_MARKER = "claude-code-hook.mjs";

type Entry = { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] };
export type ClaudeSettings = { hooks?: Record<string, Entry[]> } & Record<string, unknown>;

/** Whether an event's entries run our hook already. */
export function runsOurs(entries: Entry[] | undefined) {
  return Array.isArray(entries) && entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((hook) => isOurs(hook, HOOK_MARKER)));
}

/**
 * Our events before Kiko upgraded its own hooks at start (2026-10-30): what an install with no
 * record of the events it was given is taken to have had (../setup.ts upgradeHooks). PermissionDenied
 * isn't in it: new that day, it goes into a connected file that lacks it. Never changes.
 */
export const HOOKS_BEFORE_UPGRADES = ["Stop", "PermissionRequest", "SessionStart", "SessionEnd", "UserPromptSubmit"] as const;

/**
 * The events whose timeout a Kiko raised since it was first given (PermissionRequest: 120 s before
 * prompts could stand, 2026-11-05). Only these are brought up to date in an installed file: another
 * event's timeout, set by hand, is yours.
 */
export const RAISED_TIMEOUTS: readonly (keyof typeof HOOK_TIMEOUTS)[] = ["PermissionRequest"];

/**
 * The events (of RAISED_TIMEOUTS) whose entry of ours has a shorter timeout than HOOK_TIMEOUTS gives
 * it now: an older Kiko's. A longer one, set by hand, is left.
 */
export function staleEvents(settings: ClaudeSettings): string[] {
  return Object.entries(HOOK_TIMEOUTS)
    .filter(([event]) => (RAISED_TIMEOUTS as readonly string[]).includes(event))
    .filter(([event, want]) =>
      (settings.hooks?.[event] ?? []).some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => isOurs(h, HOOK_MARKER) && typeof h.timeout === "number" && h.timeout < want)),
    )
    .map(([event]) => event);
}

/** `settings` with our handlers on `events` given this Kiko's timeout, where theirs is shorter (staleEvents); nothing else changed. */
export function refreshedHooks(settings: ClaudeSettings, events: readonly string[]): ClaudeSettings {
  if (!events.length) return settings;
  const hooks = { ...settings.hooks };
  for (const event of events) {
    const want = HOOK_TIMEOUTS[event as keyof typeof HOOK_TIMEOUTS];
    if (!want || !Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].map((entry) =>
      Array.isArray(entry?.hooks) && entry.hooks.some((h) => isOurs(h, HOOK_MARKER))
        ? { ...entry, hooks: entry.hooks.map((h) => (isOurs(h, HOOK_MARKER) && typeof h.timeout === "number" && h.timeout < want ? { ...h, timeout: want } : h)) }
        : entry,
    );
  }
  return { ...settings, hooks };
}

/**
 * `settings` with our entry added to each event that doesn't run our hook yet, after the ones
 * already there (another tool's SessionStart hook keeps its place); `only`: just those events. Nothing
 * else is changed, and `settings` itself is left as it was.
 */
export function withOurHooks(settings: ClaudeSettings, command = HOOK_COMMAND, only?: readonly string[]): ClaudeSettings {
  const hooks = { ...settings.hooks };
  for (const [event, timeout] of Object.entries(HOOK_TIMEOUTS)) {
    if (only && !only.includes(event)) continue;
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (runsOurs(entries)) continue;
    const matcher = HOOK_MATCHERS[event as keyof typeof HOOK_TIMEOUTS];
    hooks[event] = [...entries, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] }];
  }
  return { ...settings, hooks };
}
