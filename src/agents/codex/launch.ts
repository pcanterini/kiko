// The command line of every Codex TUI Kiko starts: a session it opens (../codex/index.ts
// startCommand) and `kiko codex [args…]` (cli.ts). Kept apart from index.ts, which hooks into the
// app as it loads, so the CLI can take it alone.
//
// Codex's own startup screens can't be answered by voice, so Kiko keeps them from showing where it
// safely can, for that launch only (`-c` overrides: nothing is written to $CODEX_HOME/config.toml):
//
//   update        "An update is available: Update / Skip / Skip until next version" (codex-rs/tui,
//                 0.166.0): `check_for_update_on_startup=false`, on every launch. One you passed
//                 yourself (`kiko codex -c check_for_update_on_startup=true`) wins: ours is left out.
//   folder trust  "Trust this folder?": only for a folder Kiko made for the session itself (a fresh
//                 scratch folder), `projects={"<its real path>"={trust_level="trusted"}}`. Merged
//                 over your own `[projects]` (yours stay as they are). A quoted dotted key
//                 (`projects."/a/b".trust_level`) doesn't work: Codex splits an override's key on
//                 every "." and keeps the quotes (codex-rs/config/src/overrides.rs). A folder you
//                 chose is never trusted for you: its question is a card (core/trust-prompt.ts).
import { realpathSync } from "node:fs";

/** The config key behind Codex's "An update is available" startup question. */
export const UPDATE_CHECK_KEY = "check_for_update_on_startup";

/** The key of each `-c key=value` (`--config`, `-ckey=value`, `--config=key=value`) in `args`. */
function overriddenKeys(args: readonly string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // After `--` everything is the prompt's.
    if (a === "--") break;
    let pair: string | undefined;
    if (a === "-c" || a === "--config") pair = args[++i];
    else if (a.startsWith("--config=")) pair = a.slice("--config=".length);
    else if (a.startsWith("-c") && a.length > 2 && !a.startsWith("--")) pair = a.slice(2);
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) keys.push(pair.slice(0, eq).trim());
  }
  return keys;
}

/** `path` as Codex keys its projects: the real path (macOS's /tmp is /private/tmp). As given when it can't be read. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `-c projects={"<folder>"={trust_level="trusted"}}`: `folder` trusted for this launch only. Its
 * path as a TOML basic string (JSON's string escapes are TOML's).
 */
export function trustOverride(folder: string): string[] {
  return ["-c", `projects={${JSON.stringify(realPath(folder))}={trust_level="trusted"}}`];
}

/**
 * Kiko's `-c` overrides, then `args`: the update question off (unless `args` set it), and
 * `trusted`, a folder Kiko made for this session, trusted for this launch. Overrides go first, as
 * Codex's root options: a subcommand after them (`resume`) still takes them, and one of yours
 * later on the line would win anyway.
 */
export function codexArgs(args: readonly string[], o: { trusted?: string } = {}): string[] {
  const yours = overriddenKeys(args);
  return [...(yours.includes(UPDATE_CHECK_KEY) ? [] : ["-c", `${UPDATE_CHECK_KEY}=false`]), ...(o.trusted ? trustOverride(o.trusted) : []), ...args];
}
