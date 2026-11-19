// Which permission modes this Mac's Claude Code takes for `--permission-mode`, read from its
// `claude --help` once a run: the option's "(choices: …)" list (2.1.318: "acceptEdits", "auto",
// "bypassPermissions", "manual", "dontAsk", "plan"). Scratch sessions start in auto where it's
// offered (core/permission-mode.ts startModeFor); an older Claude Code without auto, one whose help
// has no choices list, or a help that can't be read (not installed, timed out) offers nothing, so
// those start as any other session does and never fail on a mode it would refuse.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** How long `claude --help` may take before it's taken as offering nothing. */
const HELP_TIMEOUT_MS = 5_000;

/**
 * `--permission-mode`'s choices in Claude Code's `--help` text, as listed ("acceptEdits", "auto", …);
 * null when the option, or its choices list, isn't there. Commander wraps a long description, so the
 * list may run over lines; it's read only up to the next option's line, never another option's choices.
 */
export function modesInHelp(help: string): string[] | null {
  const at = help.search(/--permission-mode\b/);
  if (at < 0) return null;
  const rest = help.slice(at);
  const next = rest.slice(1).search(/\n\s*-/);
  const own = next < 0 ? rest : rest.slice(0, next + 1);
  const choices = own.match(/\(choices:([^)]*)\)/);
  if (!choices) return null;
  return [...choices[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const readHelp = async () => (await run("claude", ["--help"], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 })).stdout;

let reader: () => Promise<string> = readHelp;
let offered: Promise<string[] | null> | null = null;

/** The modes `--permission-mode` takes (modesInHelp), read once a run and kept; null when they can't be read. */
export function modesOffered(): Promise<string[] | null> {
  offered ??= reader().then(modesInHelp, () => null);
  return offered;
}

/** Whether this Claude Code takes `mode` for `--permission-mode`; false when its help doesn't say so, or can't be read. */
export const offersMode = async (mode: string): Promise<boolean> => (await modesOffered())?.includes(mode) ?? false;

/** Tests: where the help text comes from (a fake `claude --help`), and nothing kept. Left out: the real one again. */
export function readHelpWith(read?: () => Promise<string>) {
  reader = read ?? readHelp;
  offered = null;
}
