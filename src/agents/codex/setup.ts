// Kiko's hooks in Codex's hooks file ($CODEX_HOME/hooks.json, ~/.codex/hooks.json by default):
// hooks/codex-hook.mjs on each event the adapter hears. Added only when you ask (the first-run card,
// settings → Agents, or `kiko setup codex`: all `codexSetup`),
// next to whatever hooks are there already: nothing of yours is changed or removed, the file is
// backed up first, and it's written whole, then moved in place (../hooks-file.ts). Disconnect takes
// out Kiko's entries only; Repair points them at this Kiko when its folder moved. Codex runs a new hook only once you've trusted it: it asks at its next start ("Hooks need
// review"), or in /hooks. Hooks in config.toml's [hooks] table are left alone; Codex loads both.
//
// The file's shape (codex-rs/config/src/hook_config.rs in 0.153.0, codex-rs/protocol/src/hooks.rs in 0.166.0):
//   {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "…", "timeout": 300}]}], …}}
// Each event's timeout in seconds; SessionEnd's and Interrupt's are capped at 3 by Codex.
//
// Codex versions, as checked against their source and the real binary (CODEX_CHECKED):
//   0.153.0  hooks run in the TUI's own process (its in-process app-server), so the hook finds the
//            TUI above it and records its pid.
//   0.166.0  the same file, events and trust: an unchanged hooks.json stays trusted across the
//            upgrade (the trust hash is of the normalized hook, stored in config.toml's
//            [hooks.state."<hooks.json>:<event>:<group>:<handler>"] trusted_hash; the real 0.166.0
//            app-server's hooks/list shows the user's 0.153-trusted hooks "trusted"). New: the TUI
//            attaches to a shared app-server daemon ($CODEX_HOME/app-server-daemon, started by the
//            first TUI) and hooks run there, as `$SHELL -lc "<command>"`: no terminal above them, so
//            no pid; Kiko finds such a session's pane by its program and folder instead
//            (terminals/tmux byProgram). The daemon reads hooks.json and their trust when it starts:
//            a change needs it restarted (quit every Codex). `features.hooks` defaults on in both.
//   Both     SessionStart runs at a session's first turn, not when Codex opens: a Codex open with
//            nothing asked runs no hook at all (only SessionEnd, when it quits).
// An event name Codex doesn't know is ignored with the rest of the file loaded (serde's default
// for unknown fields); Interrupt exists in both.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { hookCommand } from "../../core/app-root.ts";
import { NAME } from "../../core/name.ts";
import { shortPath } from "../../core/text.ts";
import { goneScripts, isOurs, ourEvents, readJsonObject, repointed, withoutOurs, writeWithBackup } from "../hooks-file.ts";
import type { AgentSetup, Changed, HookEvents, SetupStatus } from "../types.ts";
import { newerThan } from "../version.ts";
import { codexOriginator } from "./origin.ts";
import { parseLines } from "./rollouts.ts";
import { codexHome, readRecords, recordsDir } from "./sessions.ts";

/** The hook's command, by absolute path: Codex runs it from any folder, with your shell (an installed copy's, by its `current` link: core/app-root.ts). */
export const CODEX_HOOK_COMMAND = hookCommand("hooks/codex-hook.mjs");

/** What marks one of Kiko's entries among the others: its script's name. */
export const OURS = "codex-hook.mjs";

/**
 * Each event's entry: its timeout (a Stop waits out your reply, a permission prompt your yes or no;
 * the rest only tell, and are gone within a second) and its matcher, where Codex reads one (a tool's
 * name: every tool for a permission, only its questions' tool before a tool runs).
 */
export const CODEX_HOOKS: Record<string, { timeout: number; matcher?: string }> = {
  Stop: { timeout: 300 },
  // Up to an hour: one nobody answered in its voice window stands until it's answered (src/core/standing.ts;
  // Kiko lets it go 30 s before this). 120 s before 2026-11-05: staleEvents has the start's upgrade raise it.
  PermissionRequest: { timeout: 3600, matcher: "*" },
  SessionStart: { timeout: 5 },
  SessionEnd: { timeout: 3 },
  UserPromptSubmit: { timeout: 5 },
  Interrupt: { timeout: 3 },
  // Its questions (told), and since 2026-11-02 Kiko's safety gate (core/guard.ts): every shell command
  // and MCP call, held while you're asked about one the gate's rules flag. The hook denies one you
  // don't answer itself, well before Codex's timeout, which would let it run.
  PreToolUse: { timeout: 300, matcher: "request_user_input|Bash|mcp__.*" },
};

type Handler = { type?: string; command?: string; timeout?: number } & Record<string, unknown>;
type Group = { matcher?: string; hooks?: Handler[] } & Record<string, unknown>;
type CodexHooksFile = { hooks?: Record<string, Group[]> } & Record<string, unknown>;

/** Whether an event's groups run this Kiko's hook already (the other flavour's beside it don't count: hooks-file.ts isOurs). */
export function runsOurs(groups: Group[] | undefined): boolean {
  return Boolean(groups?.some((g) => g.hooks?.some((h) => isOurs(h, OURS))));
}

/**
 * Kiko's events before it upgraded its own hooks at start (2026-10-30): what a hooks file with
 * no record of the events it was given is taken to have had (../setup.ts upgradeHooks). All of
 * today's: an event added to CODEX_HOOKS from now on isn't in it, so it goes into a connected file
 * by itself. Never changes.
 */
const CODEX_HOOKS_BEFORE_UPGRADES = ["Stop", "PermissionRequest", "SessionStart", "SessionEnd", "UserPromptSubmit", "Interrupt", "PreToolUse"] as const;

/**
 * `file` with Kiko's entry added to each event that doesn't run it yet, after the ones there
 * (another tool's Stop hook keeps its place); `only`: just those events. Nothing else changes, and
 * `file` itself is left as it was.
 */
export function withCodexHooks(file: CodexHooksFile, command = CODEX_HOOK_COMMAND, only?: readonly string[]): CodexHooksFile {
  const hooks: Record<string, Group[]> = { ...(file.hooks ?? {}) };
  for (const [event, { timeout, matcher }] of Object.entries(CODEX_HOOKS)) {
    if (only && !only.includes(event)) continue;
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (runsOurs(groups)) continue;
    hooks[event] = [...groups, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] }];
  }
  return { ...file, hooks };
}

/** The events whose entry of Kiko's has another matcher or timeout than CODEX_HOOKS says (the gate widened PreToolUse's). */
function staleEvents(file: CodexHooksFile): string[] {
  return Object.entries(CODEX_HOOKS)
    .filter(([event, want]) => (file.hooks?.[event] ?? []).some((g) => g.hooks?.some((h) => isOurs(h, OURS) && (h.timeout !== want.timeout || (g.matcher ?? undefined) !== want.matcher))))
    .map(([event]) => event);
}

/**
 * `file` with Kiko's entries for `events` brought up to date: its handler's timeout, and the matcher
 * of a group that holds only Kiko's (one shared with your hooks keeps its matcher: Kiko's handler
 * moves to a group of its own). Nothing else changes.
 */
function refreshedHooks(file: CodexHooksFile, events: readonly string[]): CodexHooksFile {
  const hooks: Record<string, Group[]> = { ...(file.hooks ?? {}) };
  for (const event of events) {
    const want = CODEX_HOOKS[event];
    if (!want || !Array.isArray(hooks[event])) continue;
    const moved: Handler[] = [];
    hooks[event] = hooks[event].flatMap((g) => {
      if (!g.hooks?.some((h) => isOurs(h, OURS))) return [g];
      const ours = g.hooks.filter((h) => isOurs(h, OURS));
      const theirs = g.hooks.filter((h) => !isOurs(h, OURS));
      if (!theirs.length) return [{ ...g, ...(want.matcher ? { matcher: want.matcher } : {}), hooks: ours.map((h) => ({ ...h, timeout: want.timeout })) }];
      moved.push(...ours);
      return [{ ...g, hooks: theirs }];
    });
    if (moved.length) hooks[event].push({ ...(want.matcher ? { matcher: want.matcher } : {}), hooks: moved.map((h) => ({ ...h, timeout: want.timeout })) });
    if (!want.matcher) for (const g of hooks[event]) if (g.hooks?.every((h) => isOurs(h, OURS))) delete g.matcher;
  }
  return { ...file, hooks };
}

/** The events Kiko's hook isn't on yet in `file`: all of them when it has none (`only`: of those). */
export function missingEvents(file: CodexHooksFile, only?: readonly string[]): string[] {
  return Object.keys(CODEX_HOOKS).filter((event) => !runsOurs(file.hooks?.[event]) && (!only || only.includes(event)));
}

/** Kiko's events in `file` (AgentSetup.hookEvents): every one, the ones not on, whether any of its are there, and whether a script of theirs is gone. */
function codexHookEvents(file: CodexHooksFile, exists: (path: string) => boolean = existsSync): HookEvents {
  return {
    all: Object.keys(CODEX_HOOKS),
    missing: missingEvents(file),
    ours: ourEvents(file, OURS).length > 0,
    gone: goneScripts(file, OURS, exists).length > 0,
    stale: staleEvents(file),
  };
}

/** Codex's hooks file: $CODEX_HOME/hooks.json. */
export const hooksFile = (home = codexHome()) => join(home, "hooks.json");

/** Codex's hooks file read: {} when there's none; throws when it isn't JSON (then nothing is written). */
export const readHooksFile = (path = hooksFile()): CodexHooksFile => readJsonObject(path) as CodexHooksFile;

/** Whether Codex runs Kiko's hook on every event the adapter hears (the setup's own check; trust is Codex's to give). */
function codexHooksInstalled(path = hooksFile()): boolean {
  try {
    return missingEvents(readHooksFile(path)).length === 0;
  } catch {
    return false;
  }
}

export type Installed = { path: string; added: string[]; backup: string | null };

/**
 * Kiko's entries added to Codex's hooks file (`withCodexHooks`; `only`: just those events): backed
 * up first (next to it, `hooks.json.kiko-backup-<when>`), then written whole and moved in place.
 * `added`: the events it went on; none when it was there already (and nothing is written).
 */
export function installCodexHooks(path = hooksFile(), now = new Date(), only?: readonly string[]): Installed {
  const before = readHooksFile(path);
  const added = missingEvents(before, only);
  if (!added.length) return { path, added, backup: null };
  return { path, added, backup: writeWithBackup(path, withCodexHooks(before, CODEX_HOOK_COMMAND, only), now) };
}

/** The Codex versions Kiko's hooks were checked against (see the top): a newer one is noted when its hooks don't fire (codexHookSilence, below). */
export const CODEX_CHECKED = { oldest: "0.153.0", newest: "0.166.0" };

/** Where Codex's hooks file stands: connected (every event, its script there), not connected (none of ours), or needs repair. */
export function codexStatusOf(file: CodexHooksFile, shown: string, exists: (path: string) => boolean = existsSync): SetupStatus {
  if (!ourEvents(file, OURS).length) return { state: "not connected", detail: `adds hooks to ${shown}` };
  const gone = goneScripts(file, OURS, exists);
  if (gone.length) return { state: "needs repair", detail: `its hook points at ${shortPath(gone[0])}, which is gone` };
  const missing = missingEvents(file);
  if (missing.length) return { state: "needs repair", detail: `${missing.join(", ")} ${missing.length > 1 ? "aren't" : "isn't"} on` };
  return { state: "connected", detail: `hooks in ${shown}` };
}

/**
 * Codex connected: installCodexHooks (`only`: just those events), after pointing Kiko's entries
 * whose script is gone at this one's (a repair). Nothing written when they're all there and working.
 */
export function connectCodex(path = hooksFile(), now = new Date(), command = CODEX_HOOK_COMMAND, only?: readonly string[]): Changed {
  const before = readHooksFile(path);
  const gone = goneScripts(before, OURS);
  // Entries of Kiko's with an older matcher or timeout (PreToolUse before the gate): brought up to date.
  const stale = staleEvents(before);
  if (!gone.length && !stale.length) {
    const done = installCodexHooks(path, now, only);
    return { file: done.path, events: done.added, backup: done.backup };
  }
  const moving = gone.length;
  const base = refreshedHooks(moving ? (repointed(before, OURS, command) as CodexHooksFile) : before, stale);
  const next = withCodexHooks(base, command, only);
  const had = new Set(ourEvents(before, OURS));
  return {
    file: path,
    events: ourEvents(next, OURS).filter((e) => !had.has(e)),
    backup: writeWithBackup(path, next, now),
    ...(moving ? { repointed: ourEvents(before, OURS).length } : {}),
    ...(stale.length ? { refreshed: stale } : {}),
  };
}

/** Kiko's entries out of Codex's hooks file, nothing else, after a backup; nothing written when there are none. */
export function disconnectCodex(path = hooksFile(), now = new Date()): Changed {
  const before = readHooksFile(path);
  const events = ourEvents(before, OURS);
  if (!events.length) return { file: path, events: [], backup: null };
  return { file: path, events, backup: writeWithBackup(path, withoutOurs(before, OURS), now) };
}

/** `codex` on your PATH, or its home folder. */
const installed = () => Boolean(codexOnPath()) || existsSync(codexHome());

export const codexSetup: AgentSetup = {
  id: "codex",
  name: "Codex",
  // The CLI is what Kiko hooks into, not the desktop app: so it's listed where you pick agents.
  label: "Codex CLI",
  starts: true,
  about: `Codex CLI's sessions reach ${NAME} through hooks in its hooks file, next to yours. Codex asks you to trust them once, at its next start.`,
  file: () => shortPath(hooksFile()),
  installed,
  status() {
    const shown = shortPath(hooksFile());
    if (!installed()) return { state: "not installed", detail: "codex isn't on your PATH" };
    try {
      return codexStatusOf(readHooksFile(), shown);
    } catch {
      return { state: "needs repair", detail: `${shown} isn't valid JSON, so ${NAME} leaves it alone`, unreadable: true };
    }
  },
  plan() {
    const before = readHooksFile();
    return { command: CODEX_HOOK_COMMAND, events: missingEvents(before), repoint: goneScripts(before, OURS).length ? ourEvents(before, OURS).length : 0 };
  },
  // Connected, but a Codex turn ran since this Kiko started that no hook told of (codexHooksSilent, below).
  health: () => codexHooksSilent(),
  connect: (only) => connectCodex(undefined, undefined, undefined, only),
  hookEvents: () => codexHookEvents(readHooksFile()),
  hooksBefore: CODEX_HOOKS_BEFORE_UPGRADES,
  disconnect: () => disconnectCodex(),
  afterConnect: "Codex asks you to trust them once, at its next start: quit every Codex first (it keeps the hooks it read until they've all quit). A session speaks up from its first message.",
  restartOpen: true,
  nextStart: "Codex asks once to trust its hooks",
  beforeConnect: [`Codex asks you to trust new hooks at its next start ("Hooks need review"): pick "Trust all and continue", or review them in /hooks.`],
  stillQuiet: "If Codex sessions still don't speak up after a message, trust them in Codex (/hooks), then quit every Codex and start it again.",
  word: "codex",
};

/** Where `codex` is on your PATH; null when it isn't installed. */
function codexOnPath(path = process.env.PATH ?? ""): string | null {
  return (
    path
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "codex"))
      .find((at) => existsSync(at)) ?? null
  );
}

// ── Health: whether its hooks fire ──
//
// Whether Codex's hooks fire (its setup's `health`, above): connected, but never heard from.
// Codex writes every turn into its session's rollout ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl,
// by the local date), hooks or not, and its hooks keep a record for each session they run for
// (./sessions.ts), whether Kiko runs or not. So a rollout with a turn that started since this
// process did (`SINCE`: the app's start; a `kiko setup` run's, which finds none), a while ago now,
// whose session no hook told of (noteHeard) and that has no record: its hooks didn't run, or didn't
// reach Kiko. That makes Codex "needs repair", with what to check in Codex.
//
// Why it can happen: Codex runs a hook only once it's trusted (its "Hooks need
// review" screen, or /hooks), only with `[features] hooks` on, and a Codex already running keeps
// the hooks it read at its start (0.166's shared app-server daemon: until it restarts). Codex
// starts a session's hooks at its first turn (SessionStart comes with it): a Codex open with nothing
// asked runs none, which is fine, and isn't counted here.

/** How long after a turn starts its hooks have to be heard (SessionStart and UserPromptSubmit come at once). */
const HOOK_GRACE_MS = 20_000;

/** When this process started looking: turns before it aren't its to judge. */
const SINCE = Date.now();

/** The sessions a Codex hook told of, this run (../codex/index.ts, as each hook line comes). */
const heard = new Set<string>();
export const noteHeard = (sessionId: string) => void heard.add(sessionId);

/** $CODEX_HOME/sessions/YYYY/MM/DD for each local day from `since` to `now`. */
function dayFolders(home: string, since: number, now: number): string[] {
  const out: string[] = [];
  const day = new Date(since);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() <= now; day.setDate(day.getDate() + 1)) {
    const y = String(day.getFullYear());
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    out.push(join(home, "sessions", y, m, d));
  }
  return out;
}

/** A rollout's session and its first turn since `since` that's older than `before`, if any. */
function firstTurn(path: string, since: number, before: number) {
  const lines = parseLines(readFileSync(path, "utf8"));
  const meta = lines.find((l) => l?.type === "session_meta")?.payload;
  if (!meta || typeof meta.id !== "string") return null;
  // `codex exec` (a one-shot run, no TUI), or another app's (a T3 Code thread on Codex, whose hooks
  // Kiko's leave alone: ./origin.ts): not a session Kiko lists.
  if (meta.source === "exec" || !codexOriginator(meta.originator)) return null;
  const turn = lines.find((l) => {
    if (l?.type !== "event_msg" || l.payload?.type !== "task_started") return false;
    const at = Date.parse(l.timestamp);
    return at >= since && at <= before;
  });
  if (!turn) return null;
  return { sessionId: meta.id as string, cwd: String(meta.cwd ?? ""), version: String(meta.cli_version ?? ""), source: String(meta.source ?? ""), at: turn.timestamp as string };
}

/** A Codex turn its hooks didn't tell of: the session, and the words for it. */
type Silence = { sessionId: string; cwd: string; detail: string; fields: Record<string, unknown> };

/**
 * A Codex session whose turn (since `since`) no hook told of; null while all is well, or Kiko's
 * hooks aren't in Codex's file (that's its status, not this). `isHeard`: whether a hook told of a session.
 */
export function codexHookSilence(since: number, isHeard: (sessionId: string) => boolean, home = codexHome(), now = Date.now(), records = recordsDir()): Silence | null {
  if (!codexHooksInstalled(hooksFile(home))) return null;
  const recorded = new Set(readRecords(records).map((r) => r.sessionId));
  for (const dir of dayFolders(home, since, now)) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        if (statSync(path).mtimeMs < since) continue;
        const turn = firstTurn(path, since, now - HOOK_GRACE_MS);
        if (!turn || isHeard(turn.sessionId) || recorded.has(turn.sessionId)) continue;
        const folder = basename(turn.cwd) || "a folder";
        const newer = turn.version && newerThan(turn.version, CODEX_CHECKED.newest) ? ` (this Codex is ${turn.version}, newer than the ${CODEX_CHECKED.newest} ${NAME} was checked against)` : "";
        return {
          sessionId: turn.sessionId,
          cwd: turn.cwd,
          detail: `a Codex turn in ${folder} ran, but none of its hooks reached ${NAME}${newer}; check /hooks in Codex (trusted, and on), then quit every Codex and start it again`,
          fields: { rollout: path, cliVersion: turn.version, source: turn.source, turnAt: turn.at },
        };
      } catch {}
    }
  }
  return null;
}

/** Codex's setup `health`: what's wrong (codexHookSilence since this process started), or null. */
function codexHooksSilent(): string | null {
  return codexHookSilence(SINCE, (id) => heard.has(id))?.detail ?? null;
}
