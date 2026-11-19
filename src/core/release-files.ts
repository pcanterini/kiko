// What a release build knows about itself, baked in by scripts/release.sh when it compiles the
// executable (`bun build --compile --define __KIKO_RELEASE__=…`): how it was signed, and the
// SHA-256 of every other file its folder ships with (the helpers, tmux, the hooks, Pocket's
// scripts, the terminfo entry…). The executable is signed, so this list is covered by Apple's
// signature as much as the code is: once an update's `kiko` passes its signature check
// (core/updates/verify.ts verifyRelease), it can vouch for the files beside it, scripts included, which
// codesign can't sign on their own. `kiko _verify-files` (src/main.ts) does that check on its
// own folder and prints the version it was built as.
//
// The helper app (`<NAME>.app`: ARCHITECTURE.md, "The helper app") is the one thing in the folder
// that isn't in that list: a bundle carries a signature of its own over everything in it (its
// helpers, Info.plist, icon), so it's checked as a whole instead, `codesign --verify --deep --strict`
// against the requirement baked in beside the list (its identifier, and the team unless ad hoc).
// Nothing in it is hashed one by one, so its signature (or a notarization ticket stapled to it)
// can't upset the list.
//
// A checkout has none of it (RELEASE is null). Imports nothing of the app's, so main.ts can run
// the check without starting anything.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { SLUG } from "./name.ts";

/**
 * What release.sh bakes in. `adHoc`: built with KIKO_SIGN_IDENTITY=- (the tests, a build to try on
 * this Mac). `app`: the helper app's folder in it and the code requirement its signature must meet
 * (none in a release from before it).
 */
export type ReleaseBuild = { adHoc: boolean; files: Record<string, string>; app?: { path: string; requirement: string } };

declare const __KIKO_RELEASE__: ReleaseBuild | undefined;

/** This executable's own, when it's a release build; null in a checkout (nothing was baked in). */
export const RELEASE: ReleaseBuild | null = typeof __KIKO_RELEASE__ === "object" && __KIKO_RELEASE__ !== null ? __KIKO_RELEASE__ : null;

/** The hidden command the running version asks a new one's executable to check its folder with. */
export const VERIFY_FILES = "_verify-files";

/** The executable itself: signed, so not in its own list. */
const SELF = SLUG;

/**
 * Every file under `folder` but the executable and the bundle `skip` (the helper app, checked by its
 * own signature), by its path inside it, with its SHA-256. Throws on anything that isn't a plain file
 * or folder: a link could point a check at one file and the program at another.
 */
export function listFiles(folder: string, skip?: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(folder, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(folder, path));
      if (path === skip && st.isDirectory()) continue;
      if (st.isDirectory()) walk(path);
      else if (!st.isFile()) throw new Error(`${path} is a link or something else that isn't a file`);
      else if (path !== SELF)
        files[path] = createHash("sha256")
          .update(readFileSync(join(folder, path)))
          .digest("hex");
    }
  };
  walk("");
  return files;
}

/** Whether `folder` holds exactly the files `expected` lists (`skip`: the helper app's bundle, not listed), each unchanged: null when it does, else what's wrong. */
export function checkFiles(folder: string, expected: Record<string, string>, skip?: string): string | null {
  let found: Record<string, string>;
  try {
    found = listFiles(folder, skip);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  for (const [path, sha] of Object.entries(found)) {
    if (!Object.hasOwn(expected, path)) return `${path} isn't one of the files it was built with`;
    if (expected[path] !== sha) return `${path} isn't the file it was built with`;
  }
  for (const path of Object.keys(expected)) if (!Object.hasOwn(found, path)) return `${path} is missing`;
  return null;
}

/**
 * `kiko _verify-files`: this executable's folder against the list baked into it. Prints the
 * version it was built as and returns 0 when they match; else says why on stderr and returns 1.
 */
export function verifyOwnFolder(version: string): number {
  if (!RELEASE) {
    console.error("this executable was built without a list of its files");
    return 1;
  }
  const folder = dirname(realpathSync(process.execPath));
  const wrong = checkFiles(folder, RELEASE.files, RELEASE.app?.path) ?? (RELEASE.app ? checkBundle(folder, RELEASE.app) : null);
  if (wrong) {
    console.error(wrong);
    return 1;
  }
  console.log(version);
  return 0;
}

/** The helper app in `folder` signed as `app.requirement` says, everything in it sealed by that signature: null when it is, else what's wrong. */
export function checkBundle(folder: string, app: { path: string; requirement: string }, codesign = "/usr/bin/codesign"): string | null {
  const path = join(folder, app.path);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return `${app.path} is missing`;
  }
  if (!st.isDirectory()) return `${app.path} isn't a folder`;
  const said = spawnSync(codesign, ["--verify", "--deep", "--strict", `-R=${app.requirement}`, path], { encoding: "utf8", timeout: 60_000 });
  if (said.status === 0) return null;
  const why = `${said.stderr ?? ""}`.trim().split("\n").pop()?.replace(`${path}: `, "") ?? "";
  return `${app.path} isn't signed as it was built${why ? ` (codesign: ${why.slice(0, 160)})` : ""}`;
}
