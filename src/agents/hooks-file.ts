// The agents' hook files, as Kiko reads and writes them: Claude Code's settings.json and Codex's
// hooks.json have the same shape for hooks ({"hooks": {"<event>": [{"matcher"?, "hooks": [{"type":
// "command", "command": "…", "timeout": …}]}]}}), and Kiko's entries are the ones whose command
// runs its script (`marker`: claude-code-hook.mjs, codex-hook.mjs)
// from a root of this flavour's (the release's install, or a checkout: core/app-root.ts hookFlavour;
// the other flavour's entries beside them are someone else's). What's here finds those, takes them
// out, points them at where the script is now, and writes a file whole after a backup. Nothing of
// anyone else's is changed: other keys (a statusLine, permissions), other events, other hooks on the
// same event, in their places. Imports nothing that loads .env or writes logs.
//
// Under the test runner (NODE_TEST_CONTEXT) a write to the real ~/.claude, ~/.codex,
// ~/.config/kiko or ~/.config/kiko-dev is refused: the tests point every file at a folder of their own.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ownsHook } from "../core/app-root.ts";
import { flavourNames, SLUG } from "../core/name.ts";

export type Handler = { type?: string; command?: string; timeout?: number } & Record<string, unknown>;
export type Group = { matcher?: string; hooks?: Handler[] } & Record<string, unknown>;
export type HooksFile = { hooks?: Record<string, Group[]> } & Record<string, unknown>;

/** What marks Kiko's entries: its script's name, or its names (one renamed: the old name too). */
type Marker = string | readonly string[];
const names = (marker: Marker): readonly string[] => (typeof marker === "string" ? [marker] : marker);

/**
 * Whether a hook runs this Kiko's script: one of its names, from a root of this flavour's
 * (core/app-root.ts hookFlavour: the release's and Kiko Dev's entries sit side by side in the
 * same file, and each leaves the other's alone). A script named without a folder: ours.
 */
export const isOurs = (h: Handler | undefined, marker: Marker) => {
  const command = h?.command;
  if (typeof command !== "string" || !names(marker).some((name) => command.includes(name))) return false;
  const script = scriptOf(command, marker);
  return !script || !isAbsolute(script) || ownsHook(script, command);
};

/** An event's groups, or none when what's there isn't a list. */
const groupsOf = (file: HooksFile, event: string): Group[] => (Array.isArray(file.hooks?.[event]) ? file.hooks![event] : []);

/** Each of Kiko's entries in `file`: the event it's on and its command. */
function ourCommands(file: HooksFile, marker: Marker): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  for (const event of Object.keys(file.hooks ?? {})) {
    for (const g of groupsOf(file, event)) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (isOurs(h, marker)) out.push({ event, command: h.command! });
  }
  return out;
}

/** The events Kiko's script runs on in `file`. */
export const ourEvents = (file: HooksFile, marker: Marker) => [...new Set(ourCommands(file, marker).map((c) => c.event))];

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The script a command of Kiko's runs, as it names it (quotes taken off); null when it names none. */
export function scriptOf(command: string, marker: Marker): string | null {
  const name = `(?:${names(marker).map(escaped).join("|")})`;
  const m = new RegExp(`'([^']*${name})'|"([^"]*${name})"|(\\S*${name})`).exec(command);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * The scripts Kiko's entries run that aren't there any more (the repo moved, or was deleted).
 * Only a full path counts: a relative one is the agent's to resolve.
 */
export function goneScripts(file: HooksFile, marker: Marker, exists: (path: string) => boolean = existsSync): string[] {
  const gone = new Set<string>();
  for (const { command } of ourCommands(file, marker)) {
    const script = scriptOf(command, marker);
    if (script && isAbsolute(script) && !exists(script)) gone.add(script);
  }
  return [...gone];
}

/**
 * `file` without Kiko's entries: a group left with no hooks goes, and an event left with no
 * groups; `hooks` itself, left empty by that, goes too. Nothing else changes, and `file` is left as it was.
 */
export function withoutOurs(file: HooksFile, marker: Marker): HooksFile {
  if (!file.hooks || typeof file.hooks !== "object") return file;
  const hooks: Record<string, Group[]> = {};
  for (const [event, value] of Object.entries(file.hooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value;
      continue;
    }
    const groups = value.flatMap((g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some((h) => isOurs(h, marker))) return [g];
      const left = g.hooks.filter((h) => !isOurs(h, marker));
      return left.length ? [{ ...g, hooks: left }] : [];
    });
    if (groups.length || !value.length) hooks[event] = groups;
  }
  const { hooks: _, ...rest } = file;
  return Object.keys(hooks).length || !Object.keys(file.hooks).length ? { ...rest, hooks } : rest;
}

/** `file` with each of Kiko's entries running `command` (its script moved), in its place; nothing else changes. */
export function repointed(file: HooksFile, marker: Marker, command: string): HooksFile {
  if (!file.hooks || typeof file.hooks !== "object") return file;
  const hooks: Record<string, Group[]> = {};
  for (const [event, value] of Object.entries(file.hooks)) {
    hooks[event] = Array.isArray(value)
      ? value.map((g) => (Array.isArray(g?.hooks) && g.hooks.some((h) => isOurs(h, marker)) ? { ...g, hooks: g.hooks.map((h) => (isOurs(h, marker) ? { ...h, command } : h)) } : g))
      : value;
  }
  return { ...file, hooks };
}

/** A JSON file holding an object, read: {} when there's none; throws when it isn't one (then nothing is written). */
export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} isn't a JSON object`);
  return parsed;
}

/** The folders a test must never write in: the real agents' and Kiko's own (either flavour's). */
const REAL = () => [join(homedir(), ".claude"), join(homedir(), ".codex"), ...(["release", "dev"] as const).map((f) => join(homedir(), ".config", flavourNames(f).configFolder))];

/** Throws under the test runner for a path in the real ~/.claude, ~/.codex or ~/.config/kiko(-dev). */
export function refuseRealFile(path: string) {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const at = resolve(path);
  if (REAL().some((dir) => at === dir || at.startsWith(`${dir}/`))) throw new Error(`run by a test (NODE_TEST_CONTEXT): not writing the real ${path}`);
}

/** Where a backup of `path` goes: next to it, `<name>.kiko-backup-<when>`. */
const backupPath = (path: string, now: Date) => `${path}.${SLUG}-backup-${now.toISOString().replace(/[:.]/g, "-")}`;

/**
 * `value` written to `path` as JSON, whole: the file as it was copied next to it first (backupPath),
 * then a temporary file moved in place, so a write cut short leaves the old one. The backup's path;
 * null when there was no file.
 */
export function writeWithBackup(path: string, value: unknown, now = new Date()): string | null {
  refuseRealFile(path);
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = backupPath(path, now);
    copyFileSync(path, backup);
  }
  const temp = `${path}.${SLUG}-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
  return backup;
}

/** Where `program` is on `path` (a PATH's folders); null when it isn't. */
export function onPath(program: string, path = process.env.PATH ?? ""): string | null {
  return (
    path
      .split(":")
      .filter(Boolean)
      .map((dir) => join(dir, program))
      .find((at) => existsSync(at)) ?? null
  );
}
