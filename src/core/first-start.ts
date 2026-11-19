// Kiko Dev's first start. A checkout is Kiko Dev (core/name.ts), with its own
// settings and Keychain service, and the release has the real ones. So the first time Kiko Dev
// starts, it copies the release's over, and nothing you set up is lost:
//   - ~/.config/kiko/ into ~/.config/kiko-dev/: settings, the dictionary, pronunciations,
//     session names, the phones paired, what was missed, the quick checks' "always", Codex's records.
//     The original stays as it was. Not run/ (a running app's lock and sockets). What the dev folder
//     has already is kept (a Codex hook of Kiko Dev's may have made its records there first).
//   - the Keychain's API keys from the release's service to Kiko Dev's, by the keychain helper
//     itself (keychain.swift copy): the keys never pass through here, never printed or logged. One
//     there already is kept.
// Then a mark in the dev folder (FIRST_START_MARK), so it's done once: a folder with settings in it,
// or the mark, is Kiko Dev's own already. Run by `kiko-dev` (src/cli.ts) and the app's start
// (src/start.ts) before anything reads the settings or the keys. Imports nothing that loads .env or
// writes logs.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_KEY } from "./account/account.ts";
import { DEV, envVar, type FlavourNames, flavourNames, OTHER, OWN } from "./name.ts";

/** In the dev folder once its first start has been seen to: what was copied, and when. */
export const FIRST_START_MARK = "first-start.json";

/**
 * What's never copied: a running app's lock and sockets, and who's signed in (account.json): Kiko
 * Dev signs in on its own, so signing one out never signs the other out.
 */
const SKIP = new Set(["run", FIRST_START_MARK, "account.json"]);

/** What the first start did: the files and folders copied, the keys copied (names only), and why the keys weren't, when they weren't. */
type FirstStart = { copied: string[]; keys: string[]; keysError?: string };

/**
 * `from` copied into `to` (the original left as it was), but what `to` has already, which is kept:
 * a folder in both merged, file by file. Each top-level name copied, or merged into.
 */
function copyMissing(from: string, to: string, skip: ReadonlySet<string> = SKIP): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const done: string[] = [];
  for (const name of readdirSync(from)) {
    if (skip.has(name)) continue;
    const src = join(from, name);
    const dest = join(to, name);
    const stat = statSync(src, { throwIfNoEntry: false });
    if (!stat || !(stat.isFile() || stat.isDirectory())) continue; // a socket, a dangling link
    if (stat.isDirectory() && existsSync(dest)) {
      if (copyMissing(src, dest, new Set()).length) done.push(name);
      continue;
    }
    if (existsSync(dest)) continue;
    cpSync(src, dest, { recursive: true, preserveTimestamps: true, errorOnExist: false, force: false });
    done.push(name);
  }
  return done;
}

/**
 * The first start, for `home` (the tests give their own): from the other flavour's config folder
 * (`from`) to this one's (`to`), and the keys through `keys` (null: the Keychain is off). Nothing when
 * it's been done (the mark), or this one's folder has settings of its own. Throws only for a folder
 * that can't be written; a key copy that fails is said in `keysError`, and the rest stands.
 */
export async function firstStart(
  o: { home?: string; from?: FlavourNames; to?: FlavourNames; keys?: { copyFrom(service: string): Promise<string[]>; remove?(name: string): Promise<boolean> } | null } = {},
): Promise<FirstStart | null> {
  const home = o.home ?? homedir();
  const from = o.from ?? flavourNames("release");
  const to = o.to ?? flavourNames("dev");
  const dir = join(home, ".config", to.configFolder);
  if (existsSync(join(dir, FIRST_START_MARK)) || existsSync(join(dir, "settings.json"))) return null;
  const copied = copyMissing(join(home, ".config", from.configFolder), dir);
  let keys: string[] = [];
  let keysError: string | undefined;
  if (o.keys) {
    try {
      keys = await o.keys.copyFrom(from.keychainService);
      // The account's session token isn't carried over with the API keys, for the same reason as account.json.
      if (keys.includes(SESSION_KEY)) {
        keys = keys.filter((k) => k !== SESSION_KEY);
        await o.keys.remove?.(SESSION_KEY);
      }
    } catch (err) {
      keysError = err instanceof Error ? err.message : String(err);
    }
  }
  const done: FirstStart = { copied, keys, ...(keysError ? { keysError } : {}) };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, FIRST_START_MARK), `${JSON.stringify({ at: new Date().toISOString(), from: from.configFolder, ...done }, null, 2)}\n`, { mode: 0o600 });
  return done;
}

/** What's said about it, in a line or two; null when there's nothing to say. */
export function firstStartWords(done: FirstStart | null, from: FlavourNames = OTHER, to: FlavourNames = OWN): string | null {
  if (!done || (!done.copied.length && !done.keys.length && !done.keysError)) return null;
  const lines: string[] = [];
  if (done.copied.length) lines.push(`${to.title}: your settings are copied from ~/.config/${from.configFolder} to ~/.config/${to.configFolder} (the originals stay).`);
  if (done.keys.length) lines.push(`${to.title}: your API keys (${done.keys.join(", ")}) are copied to its own place in the Keychain.`);
  if (done.keysError) lines.push(`${to.title}: your API keys weren't copied (${done.keysError}); ${to.command} keys set <name> adds one.`);
  return lines.join("\n");
}

/**
 * Kiko Dev's first start, for real: only Kiko Dev's, only with the settings and the socket where
 * they always are (not KIKO_SETTINGS or KIKO_SOCKET: the tests, the harness), never under the test runner; with the Keychain
 * unless it's off (KIKO_KEYCHAIN). What's said about it, or null.
 */
export async function devFirstStart(): Promise<string | null> {
  if (!DEV || envVar("SETTINGS") || envVar("SOCKET") || process.env.NODE_TEST_CONTEXT) return null;
  const { pickKeyStore } = await import("../platform/keys.ts");
  const store = pickKeyStore();
  const keys = store && "copyFrom" in store ? (store as { copyFrom(service: string): Promise<string[]>; remove(name: string): Promise<boolean> }) : null;
  return firstStartWords(await firstStart({ keys }));
}
