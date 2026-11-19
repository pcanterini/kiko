// The API keys this run uses, where Kiko keeps the ones it found itself: the Keychain's, a
// checkout's .env's, and one entered in setup or settings. Held here, in memory, never in
// process.env: whatever Kiko starts (the app from `kiko setup`, its helpers, Pocket, a settings
// screen, tmux, a session) inherits process.env, and none of them may get a key (2026-11-02: the
// app started by setup logged its keys as coming from "the environment", handed down by setup).
// A key your own shell exports stays where it is, in process.env: that one is yours, and wins
// (core/keys.ts fillKeys). Nothing here is ever logged, printed or put on a command line.
// No imports: core/openrouter-llm.ts reads a key here, and core/keys.ts imports that.

/** The keys Kiko found itself, by variable (OPENROUTER_API_KEY…). */
export const heldKeys: Record<string, string> = {};

/** A key's variable has one: set and not blank (a blank one is no key). */
const isSet = (value: string | undefined): value is string => Boolean(value?.trim());

/** The key under `name` this run uses: your environment's (it wins), else the one Kiko holds, else "". */
export function keyOf(name: string, env: NodeJS.ProcessEnv = process.env, held: Record<string, string> = heldKeys): string {
  const own = env[name];
  if (isSet(own)) return own;
  return held[name] ?? "";
}

/** A key found or entered by Kiko: held for this run (never put in process.env). */
export function holdKey(name: string, value: string, held: Record<string, string> = heldKeys) {
  held[name] = value;
}

/**
 * `env` without the keys Kiko holds (`names`), for a program Kiko starts: a key your shell
 * exports (one that isn't held) stays. Nothing is held in process.env, so this is only a second
 * line, for a launch's environment (src/cli.ts appLaunch).
 */
export function withoutHeldKeys(env: NodeJS.ProcessEnv, names: readonly string[], held: Record<string, string> = heldKeys): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of names) if (held[name] !== undefined && out[name] === held[name]) delete out[name];
  return out;
}
