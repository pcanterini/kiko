// The names this app gave sessions. It renames a session by typing Claude Code's /rename, which
// Claude Code records just as it does yours, so the app keeps its own: a session whose name is
// still the one the app gave it was named by the app (sessions.ts nameSetBy). Kept next to the
// settings file, so it outlasts a restart.
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { SETTINGS_FILE } from "./settings.ts";

export const RENAMES_FILE = join(dirname(SETTINGS_FILE), "renames.json");

// The newest are kept; a session renamed this long ago has closed.
const MAX_RENAMES = 200;

/** sessionId → the name the app gave it, and when (ms epoch). */
export type Renames = Record<string, { name: string; at: number }>;

/** The names given; none when there's no file, or one that can't be read (set aside, never saved over: core/json-file.ts). */
export function loadRenames(): Renames {
  return (readJsonFile(RENAMES_FILE) as Renames | undefined) ?? {};
}

/** Notes a rename the app typed in. Best effort: without it, the name just counts as yours. */
export function noteRename(sessionId: string, name: string, at = Date.now()) {
  const all = { ...loadRenames(), [sessionId]: { name, at } };
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_RENAMES);
  try {
    writeJsonAtomic(RENAMES_FILE, Object.fromEntries(kept));
  } catch {
    // the name counts as yours
  }
}
