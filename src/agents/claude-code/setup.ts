// Claude Code's setup: Kiko's hooks (./settings.ts: hooks/claude-code-hook.mjs on Stop, PermissionRequest,
// SessionStart, SessionEnd, UserPromptSubmit, PermissionDenied and PreToolUse, the safety gate's) in its user settings, ~/.claude/settings.json
// ($CLAUDE_CONFIG_DIR/settings.json when that's set; KIKO_CLAUDE_SETTINGS: another, the tests').
// Added only when you ask (the first-run card, settings → Agents, `kiko setup claude`), next to
// the hooks there; taken out the same way, ours only. The file is backed up first and written whole
// (../hooks-file.ts). Nothing else in it is touched: a statusLine, permissions, other tools' hooks.
//
// The status line (statusline/kiko-status.mjs) isn't added: it wraps your own statusLine command,
// so adding it means rewriting yours, which Kiko doesn't do without asking (DEVELOPMENT.md,
// "Connecting your agents"). The script's own header says how to set it by hand.
//
// Connected: our hook on Stop and PermissionRequest, its script still there. Needs repair: a script
// gone (the repo moved: the entries are pointed at this one's), or Stop or PermissionRequest
// missing. The others are optional: Connect adds them (one connected before PermissionDenied
// was added, 2026-10-30, shows "Add the rest"). Since then the app adds an event new to this
// Kiko to a connected file by itself at start (../setup.ts upgradeHooks, through `connect` with
// `only` those events): HOOKS_BEFORE_UPGRADES is what a file with no record had. Imports nothing
// that loads .env or writes logs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STABLE_ROOT } from "../../core/app-root.ts";
import { envVar, NAME, STATUS_LINE_SCRIPT } from "../../core/name.ts";
import { shortPath } from "../../core/text.ts";
import { goneScripts, ourEvents, onPath, readJsonObject, repointed, withoutOurs, writeWithBackup } from "../hooks-file.ts";
import type { AgentSetup, Changed, HookEvents, SetupStatus } from "../types.ts";
import { HOOK_COMMAND, HOOK_MARKER, HOOK_TIMEOUTS, HOOKS_BEFORE_UPGRADES, REQUIRED_EVENTS, refreshedHooks, runsOurs, staleEvents, withOurHooks, type ClaudeSettings } from "./settings.ts";

/** Claude Code's user settings file: KIKO_CLAUDE_SETTINGS, else $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json. */
export function claudeSettingsFile(): string {
  const set = envVar("CLAUDE_SETTINGS");
  if (set) return set;
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

/** Claude Code's settings read: {} when there's none; throws when it isn't JSON (then nothing is written). */
const readClaudeSettings = (path = claudeSettingsFile()): ClaudeSettings => readJsonObject(path) as ClaudeSettings;

/** Where `settings` stand: connected, not connected, or needs repair (and why), for `file` (as shown). */
export function claudeStatusOf(settings: ClaudeSettings, file: string, exists: (path: string) => boolean = existsSync): SetupStatus {
  if (!ourEvents(settings, HOOK_MARKER).length) return { state: "not connected", detail: `adds hooks to ${file}` };
  const gone = goneScripts(settings, HOOK_MARKER, exists);
  if (gone.length) return { state: "needs repair", detail: `its hook points at ${shortPath(gone[0])}, which is gone` };
  const missing = Object.keys(HOOK_TIMEOUTS).filter((event) => !runsOurs(settings.hooks?.[event]));
  const required = missing.filter((event) => (REQUIRED_EVENTS as readonly string[]).includes(event));
  if (required.length) return { state: "needs repair", detail: `${required.join(" and ")} ${required.length > 1 ? "aren't" : "isn't"} on` };
  const partial = missing.length ? `${missing.join(", ")} not on (optional)` : undefined;
  return { state: "connected", detail: partial ? `hooks in ${file}; ${partial}` : `hooks in ${file}`, ...(partial ? { partial } : {}) };
}

/** Our events in `settings` (AgentSetup.hookEvents): every one, the ones not on, whether any of ours are there, and whether a script of theirs is gone. */
function claudeHookEvents(settings: ClaudeSettings, exists: (path: string) => boolean = existsSync): HookEvents {
  const all = Object.keys(HOOK_TIMEOUTS);
  return {
    all,
    missing: all.filter((event) => !runsOurs(settings.hooks?.[event])),
    ours: ourEvents(settings, HOOK_MARKER).length > 0,
    gone: goneScripts(settings, HOOK_MARKER, exists).length > 0,
    stale: staleEvents(settings),
  };
}

/**
 * `settings` connected: ours pointed at this hook where their script is gone (all of them), ours
 * with an older, shorter timeout given this one's (staleEvents: every event, whatever `only` says),
 * then each event that has none of ours given one (`only`: just those events).
 */
export function connectedSettings(
  settings: ClaudeSettings,
  command = HOOK_COMMAND,
  exists: (path: string) => boolean = existsSync,
  only?: readonly string[],
): { next: ClaudeSettings; repointed: number; refreshed: string[] } {
  // Gone: all of ours.
  const moving = goneScripts(settings, HOOK_MARKER, exists).length ? ourEvents(settings, HOOK_MARKER).length : 0;
  const moved = moving ? (repointed(settings, HOOK_MARKER, command) as ClaudeSettings) : settings;
  const stale = staleEvents(moved);
  return { next: withOurHooks(refreshedHooks(moved, stale), command, only), repointed: moving, refreshed: stale };
}

/** Our hooks into Claude Code's settings (connectedSettings; `only`: just those events), after a backup; nothing written when they're all there and working. */
export function connectClaude(path = claudeSettingsFile(), now = new Date(), command = HOOK_COMMAND, only?: readonly string[]): Changed {
  const before = readClaudeSettings(path);
  const { next, repointed: moved, refreshed } = connectedSettings(before, command, existsSync, only);
  const had = new Set(ourEvents(before, HOOK_MARKER));
  const events = ourEvents(next, HOOK_MARKER).filter((e) => !had.has(e));
  if (JSON.stringify(next) === JSON.stringify(before)) return { file: path, events: [], backup: null };
  return { file: path, events, backup: writeWithBackup(path, next, now), ...(moved ? { repointed: moved } : {}), ...(refreshed.length ? { refreshed } : {}) };
}

/** Our entries out of Claude Code's settings, nothing else, after a backup; nothing written when there are none. */
export function disconnectClaude(path = claudeSettingsFile(), now = new Date()): Changed {
  const before = readClaudeSettings(path);
  const events = ourEvents(before, HOOK_MARKER);
  if (!events.length) return { file: path, events: [], backup: null };
  return { file: path, events, backup: writeWithBackup(path, withoutOurs(before, HOOK_MARKER), now) };
}

/** `claude` on your PATH, or its folder (where the settings file goes). */
const installed = () => Boolean(onPath("claude")) || existsSync(dirname(claudeSettingsFile()));

export const claudeCodeSetup: AgentSetup = {
  id: "claude-code",
  name: "Claude Code",
  starts: true,
  about: `Claude Code's sessions reach ${NAME} through hooks in its settings file, next to yours. Sessions already open pick them up when restarted.`,
  file: () => shortPath(claudeSettingsFile()),
  installed,
  status() {
    const file = shortPath(claudeSettingsFile());
    if (!installed()) return { state: "not installed", detail: "claude isn't on your PATH" };
    try {
      return claudeStatusOf(readClaudeSettings(), file);
    } catch {
      return { state: "needs repair", detail: `${file} isn't valid JSON, so ${NAME} leaves it alone`, unreadable: true };
    }
  },
  plan() {
    const before = readClaudeSettings();
    const { next, repointed: repoint } = connectedSettings(before);
    const had = new Set(ourEvents(before, HOOK_MARKER));
    return { command: HOOK_COMMAND, events: ourEvents(next, HOOK_MARKER).filter((e) => !had.has(e)), repoint };
  },
  connect: (only) => connectClaude(undefined, undefined, undefined, only),
  hookEvents: () => claudeHookEvents(readClaudeSettings()),
  hooksBefore: HOOKS_BEFORE_UPGRADES,
  disconnect: () => disconnectClaude(),
  afterConnect: "New Claude Code sessions speak up; restart ones already open.",
  restartOpen: true,
  // Said inline: a user's README has no section on it (the script's header says how to set it by hand).
  beforeConnect: [`${NAME}'s status line isn't added: it wraps your own statusLine command. To use it, set it by hand (${shortPath(join(STABLE_ROOT, "statusline", STATUS_LINE_SCRIPT))} says how).`],
  word: "claude",
};
