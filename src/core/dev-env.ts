// A checkout's .env (core/app-root.ts ENV_FILE): its KIKO_ values read by Kiko Dev as if your shell
// exported them (core/name.ts envVar), from each program's first line. Imported first, for this
// side effect, by the command line (src/cli.ts: `kiko-dev login`, `logout`, `account`, `setup`,
// `keys`, its help) and by each of the app's programs (core/app-root.ts PROGRAMS), so every one of
// them agrees on the values even read as a module loads (KIKO_ACCOUNTS, KIKO_TMUX_SERVER,
// KIKO_SETTINGS…). Until 2026-11-03 only core/config.ts loaded .env, in the app, after much had
// been read: the command line, which loads no config, never saw KIKO_ACCOUNTS=1 there.
// Your shell's values win. They're held in name.ts dotenvVars, never put in process.env: nothing a
// program starts (a `kiko claude` session, the app, tmux) inherits them. The API keys aren't
// KIKO_ names, so none is read here (core/config.ts and core/keys.ts hold those).
// The release reads no .env (ENV_FILE is null for it), so this does nothing there.
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { ENV_FILE } from "./app-root.ts";
import { dotenvVars, ENV_PREFIX } from "./name.ts";

/** Read before any .env can be (name.ts FLAVOUR, app-root.ts ENV_FILE): only ever the environment's. */
const ENVIRONMENT_ONLY = new Set(["FLAVOUR", "ENV_FILE"].map((key) => ENV_PREFIX + key));

/** The KIKO_ values in a .env's text, but the ones only the environment sets. */
export function kikoValues(text: string): Record<string, string> {
  return Object.fromEntries(Object.entries(parseEnv(text)).flatMap(([name, value]) => (name.startsWith(ENV_PREFIX) && !ENVIRONMENT_ONLY.has(name) && value !== undefined ? [[name, value]] : [])));
}

/** The .env's KIKO_ values (`file`: ENV_FILE, null in the release) held in `into` (name.ts dotenvVars). Their names. */
export function loadDevEnv(file: string | null = ENV_FILE, into: Record<string, string> = dotenvVars): string[] {
  if (!file || !existsSync(file)) return [];
  let values: Record<string, string>;
  try {
    values = kikoValues(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  Object.assign(into, values);
  return Object.keys(values);
}

// Under the test runner (NODE_TEST_CONTEXT), only a .env the test names (KIKO_ENV_FILE), never the repo's.
loadDevEnv(process.env.NODE_TEST_CONTEXT && process.env[`${ENV_PREFIX}ENV_FILE`] === undefined ? null : ENV_FILE);
