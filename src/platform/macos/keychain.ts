// The keys in the macOS Keychain, through native/macos/keychain.swift. A key goes to the helper on
// its stdin and comes back on its stdout (a pipe of ours): never in its arguments, nor its
// environment, nor anything logged. Errors carry the helper's own line, which never has a key in it.
import { execFile, execFileSync } from "node:child_process";
import { NAME, OWN } from "../../core/name.ts";
import type { KeyStore } from "../types.ts";
import { buildNative } from "./native.ts";

// A Keychain prompt ("Kiko wants to use your confidential information") waits for you: long enough to answer it.
const WAIT_MS = 60_000;

/** What the helper said on stderr, or how it ended. */
function why(err: unknown): string {
  const e = err as { stderr?: Buffer | string; status?: number | null; code?: number | string; killed?: boolean; signal?: string | null };
  const said = String(e.stderr ?? "")
    .trim()
    .replace(/^keychain: /, "");
  if (said) return said;
  if (e.killed || e.signal) return "the Keychain didn't answer in time";
  return `the keychain helper failed (${e.status ?? e.code ?? "?"})`;
}

/** The exit code the helper ended with: 3 is "there was none", 4 "you said no to the prompt". */
const exitCode = (err: unknown) => {
  const e = err as { status?: number | null; code?: number | string };
  return typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : null;
};

/** The Keychain as a KeyStore, plus `copyFrom` (keychain.swift copy). */
export type Keychain = KeyStore & {
  /** Each key of `service` this store lacks, copied in by the helper (never through this process); the names copied. */
  copyFrom(service: string): Promise<string[]>;
};

/**
 * The Keychain as a KeyStore. `service`: the one the keys are kept under, this flavour's unless
 * given (core/name.ts flavourNames: the release's and Kiko Dev's are apart). `file`: a keychain
 * file instead of the login keychain (tests' throwaway one).
 */
export function keychainStore(opts: { file?: string; service?: string; helper?: () => string } = {}): Keychain {
  const helper = opts.helper ?? (() => buildNative("keychain"));
  const first = [...(opts.file ? ["--keychain", opts.file] : []), "--service", opts.service ?? OWN.keychainService, "--app", NAME];
  const run = (args: string[], input?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(helper(), [...first, ...args], { encoding: "utf8", timeout: WAIT_MS }, (err, stdout) => {
        if (err) return reject(Object.assign(new Error(why(err)), { exit: exitCode(err) }));
        resolve(stdout);
      });
      child.stdin?.end(input ?? "");
    });
  return {
    where: "the Keychain",
    get(names) {
      if (!names.length) return {};
      try {
        const out = execFileSync(helper(), [...first, "get", ...names], { encoding: "utf8", timeout: WAIT_MS, stdio: ["ignore", "pipe", "pipe"] });
        return JSON.parse(out) as Record<string, string>;
      } catch (err) {
        throw new Error(why(err));
      }
    },
    async set(name, key) {
      await run(["set", name], `${key}\n`);
    },
    async remove(name) {
      try {
        await run(["delete", name]);
        return true;
      } catch (err) {
        if ((err as { exit?: number }).exit === 3) return false;
        throw err;
      }
    },
    async list() {
      return JSON.parse(await run(["list"])) as string[];
    },
    async copyFrom(service) {
      return JSON.parse(await run(["copy", service])) as string[];
    },
  };
}
