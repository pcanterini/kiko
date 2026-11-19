import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { INSTALLED, installedHelper, LOG_DIR } from "../../core/app-root.ts";
import { envVar, IDENTIFIER } from "../../core/name.ts";

// The Swift helpers' sources, and their binaries in .build/ beside them (git-ignored).
const NATIVE = fileURLToPath(new URL("../../../native/macos/", import.meta.url));
const BUILD = join(NATIVE, ".build");
/** Where the helpers are built in a checkout (git-ignored). */
export const NATIVE_BUILD = BUILD;

/**
 * The helpers the helper app starts (helper-app.ts): those a macOS permission is asked for. The rest
 * (player, opus, presence, keychain) stay `kiko`'s own children.
 */
export const BROKERED: ReadonlySet<string> = new Set(["mic", "hotkey", "speech", "permissions"]);

/**
 * The helpers signed with a code signature of their own after building (the rest keep the linker's
 * ad-hoc one: re-signing the mic or the hotkey helper would make macOS ask for its permission again).
 * The keychain helper's signature is what the Keychain trusts with Kiko's keys (keychain.swift).
 */
const SIGNED: Record<string, string> = { keychain: `${IDENTIFIER}.keychain` };

/**
 * The identity to sign with, from `security find-identity -v -p codesigning`'s output: a Developer
 * ID Application one first, else an Apple Development one; null with neither (signed ad hoc).
 */
export function pickIdentity(found: string): string | null {
  const ids = [...found.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1], name: m[2] }));
  return (ids.find((i) => i.name.startsWith("Developer ID Application:")) ?? ids.find((i) => i.name.startsWith("Apple Development:")))?.hash ?? null;
}

/**
 * Who signs a helper in SIGNED: KIKO_SIGN_IDENTITY when set ("-" is ad hoc; tests set it), else
 * your developer identity if this Mac has one, else ad hoc ("-").
 */
export function signer(): string {
  const set = envVar("SIGN_IDENTITY");
  if (set) return set;
  try {
    return pickIdentity(execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8", timeout: 10_000 })) ?? "-";
  } catch {
    return "-";
  }
}

/**
 * The identifier `binary` is signed with, for a helper in SIGNED (null for the others: not asked).
 * A helper signed with another identifier is rebuilt, so the Keychain's items are always made by
 * the one they trust.
 */
function signedAs(binary: string): string | null {
  if (!Object.keys(SIGNED).some((name) => binary.endsWith(`/${name}`))) return null;
  const at = `${binary}\0${statSync(binary).mtimeMs}`;
  const known = signedSeen.get(at);
  if (known !== undefined) return known;
  const out = spawnSync("codesign", ["-d", "--verbose=1", binary], { encoding: "utf8", timeout: 10_000 });
  const id = /^Identifier=(.+)$/m.exec(`${out.stdout ?? ""}${out.stderr ?? ""}`)?.[1] ?? null;
  signedSeen.set(at, id);
  return id;
}
// What signedAs found, by binary and its time: asked of codesign once, not on every key read.
const signedSeen = new Map<string, string | null>();

/** Where the helpers' own stderr goes: null, the terminal (inherited); set, a line at a time to it. */
let stderrSink: ((helper: string, line: string) => void) | null = null;

/**
 * The helpers' stderr from now on: to `sink` a line at a time, never the terminal (first-run setup
 * draws its own screen there: a helper's "[mic] error: …" broke it). Null: the terminal again.
 */
export function helperStderrTo(sink: ((helper: string, line: string) => void) | null) {
  stderrSink = sink;
}

/** A helper's stderr for spawn's stdio: the terminal, or a pipe for helperStderrTo's sink (helperStderr then reads it). */
export const helperErr = (): "inherit" | "pipe" => (stderrSink ? "pipe" : "inherit");

/** A helper's piped stderr (helperErr) to the sink, a line at a time. */
export function helperStderr(helper: string, proc: { stderr: Readable | null }) {
  const sink = stderrSink;
  if (sink && proc.stderr) createInterface({ input: proc.stderr }).on("line", (line) => sink(helper, line));
}

/**
 * Where what the compiler says goes, every build of a helper, warnings and all: a file in the logs
 * (core/app-root.ts LOG_DIR, the checkout's logs/), never the terminal. The app's window pane is a
 * terminal: swiftc's warnings once filled the list there while it built the player.
 */
export const buildLog = () => join(LOG_DIR, "native-build.log");

/** A path as it's said: under your home folder, from ~. */
const said = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** A helper that couldn't be built: its message is one line to show as it is ("couldn't build the player helper (…)"). */
export class HelperBuildError extends Error {}

/**
 * Whether native/macos/<name>.swift would be built by buildNative (in .build/ or `into`): its binary
 * missing, older than its source, or (one in SIGNED) signed as something else. Never in an installed copy.
 */
export function needsBuild(name: string, into?: string): boolean {
  if (INSTALLED && !into) return false;
  const binary = join(into ?? BUILD, name);
  return !(existsSync(binary) && statSync(binary).mtimeMs >= statSync(join(NATIVE, `${name}.swift`)).mtimeMs && signedAs(binary) === (SIGNED[name] ?? null));
}

/**
 * Builds native/macos/<name>.swift into native/macos/.build/<name> (or `into`) when needsBuild says
 * so, and signs it if it's one in SIGNED (`sign`: the identity, else signer()'s). Returns the binary
 * path. An installed copy has them prebuilt beside it (scripts/release.sh): no building. What the
 * compiler says goes to buildLog (and to the helpers' stderr sink, while one is set), never the
 * terminal; a build that fails throws a HelperBuildError naming that file. `compiler`: swiftc
 * unless given (tests: a stand-in).
 */
export function buildNative(name: string, opts: { into?: string; sign?: string; compiler?: string } = {}): string {
  if (INSTALLED && !opts.into) return installedHelper(name);
  const source = join(NATIVE, `${name}.swift`);
  const dir = opts.into ?? BUILD;
  const binary = join(dir, name);
  if (!needsBuild(name, opts.into)) return binary;
  mkdirSync(dir, { recursive: true });
  const compiler = opts.compiler ?? "swiftc";
  const started = Date.now();
  const built = spawnSync(compiler, ["-O", source, "-o", binary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${built.stdout ?? ""}${built.stderr ?? ""}`.trimEnd();
  const outcome = built.error ? `didn't run (${built.error.message})` : built.status === 0 ? "built" : `failed (exit ${built.status ?? built.signal})`;
  const log = buildLog();
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(log, `── ${new Date(started).toISOString()} ${name}: ${outcome} in ${Date.now() - started} ms (${compiler} -O ${source})\n${output ? `${output}\n` : ""}`);
  } catch {
    // No log to write (a read-only folder): the build stands or falls all the same.
  }
  if (stderrSink) for (const line of output.split("\n")) if (line) stderrSink(`swiftc ${name}`, line);
  if (built.error) {
    const missing = (built.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new HelperBuildError(`couldn't build the ${name} helper: ${missing ? `${compiler} isn't installed (it comes with Xcode or its Command Line Tools)` : built.error.message}`);
  }
  if (built.status !== 0) throw new HelperBuildError(`couldn't build the ${name} helper (what ${compiler} said is in ${said(log)})`);
  const id = SIGNED[name];
  if (id) {
    const identity = opts.sign ?? signer();
    try {
      execFileSync("codesign", ["--force", "--sign", identity, "--identifier", id, binary], { stdio: "ignore", timeout: 60_000 });
    } catch {
      // The identity's key refused (its own "allow" prompt said no): ad hoc, as the linker left it, but with our identifier.
      if (identity !== "-") execFileSync("codesign", ["--force", "--sign", "-", "--identifier", id, binary], { stdio: "ignore" });
    }
  }
  return binary;
}

/** Every helper's name (native/macos/*.swift), in order. */
export const helperNames = () =>
  readdirSync(NATIVE)
    .filter((f) => f.endsWith(".swift"))
    .sort()
    .map((f) => f.slice(0, -".swift".length));

// `pnpm build:native`: builds every helper that's missing or out of date (the app also does it as it
// needs each, and `kiko` in a checkout before it starts the app: src/start.ts). Said here, in your
// terminal: which it builds, and where the compiler's words went.
if (import.meta.main) {
  let failed = false;
  const stale = helperNames().filter((name) => needsBuild(name));
  for (const name of stale) {
    console.log(`Building the ${name} helper…`);
    try {
      buildNative(name);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      failed = true;
    }
  }
  if (stale.length) console.log(`What swiftc said: ${said(buildLog())}`);
  if (failed) process.exit(1);
}
