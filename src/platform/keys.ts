// Where the API keys are kept on this computer (types.ts KeyStore): the Keychain on a Mac. Picked
// here rather than in index.ts because config.ts reads the keys as it loads, and index.ts's pieces
// import config.
//
// KIKO_KEYCHAIN: "off" (no store: keys only from the environment and .env), or the path of a
// keychain file to use instead of the login keychain (only tests do, with a throwaway one). Under
// the test runner (NODE_TEST_CONTEXT) it's off unless a file is given: a test never touches your
// login keychain.
import { envVar } from "../core/name.ts";
import { keychainStore } from "./macos/keychain.ts";
import type { KeyStore } from "./types.ts";

export function pickKeyStore(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = process.platform): KeyStore | null {
  const asked = envVar("KEYCHAIN", env)?.trim() ?? "";
  if (os !== "darwin" || ["off", "0", "false", "no"].includes(asked.toLowerCase())) return null;
  if (asked) return keychainStore({ file: asked });
  if (env.NODE_TEST_CONTEXT) return null;
  return keychainStore();
}

/** This run's store, or null when there's none (off, or not a Mac). */
export const keyStore: KeyStore | null = pickKeyStore();
