// Signed by us (./updater.ts has how updates go): every executable in a new version must be signed
// by our Developer ID (name.ts TEAM) as sh.kiko.<file>, and its signed `kiko` must vouch for every
// other file beside it and for its version (core/release-files.ts). The feed's sha256 only catches a
// broken download; this is what stops a fake build.
import { execFile } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { INSTALLED } from "../app-root.ts";
import { envVar, IDENTIFIER, NAME, SLUG, TEAM } from "../name.ts";
import { RELEASE, type ReleaseBuild, VERIFY_FILES } from "../release-files.ts";
import { plain } from "./feed.ts";

const run = promisify(execFile);

/** Checks an unpacked version's folder before it's switched to; throws (SignatureError) when it mustn't be. */
export type Verify = (folder: string, version: string) => Promise<void>;

/**
 * Whose signatures an update must carry: our team's Developer ID (`team`); any signature with the
 * right identifiers, ad hoc included (`adHoc`); or none checked (`off`).
 */
type Trust = { team: string } | { adHoc: true } | { off: true };

/**
 * The trust this copy runs with. A release build (Bun's executable) takes it only from what was
 * baked into it when it was built: the team, unless release.sh built it ad hoc (KIKO_SIGN_IDENTITY=-,
 * the tests' builds and a build to try on this Mac, never uploaded), which takes ad hoc updates
 * too. Nothing at run time can loosen it: no setting, no environment variable, nothing the feed
 * says, so a real release never takes an ad hoc or another team's build. A checkout runs its own
 * source, which whoever runs it can change anyway, so there KIKO_UPDATE_SIGNATURES=adhoc|off is
 * honoured (the unit tests' fake installs); without it a checkout is as strict as a release.
 */
export function trustOf(built: boolean, baked: Pick<ReleaseBuild, "adHoc"> | null, asked: string | undefined): Trust {
  if (built) return baked?.adHoc === true ? { adHoc: true } : { team: TEAM };
  const want = asked?.trim().toLowerCase();
  if (want === "off") return { off: true };
  if (want === "adhoc") return { adHoc: true };
  return { team: TEAM };
}

/** This copy's trust (trustOf). */
const releaseTrust = (): Trust => trustOf(INSTALLED, RELEASE, envVar("UPDATE_SIGNATURES"));

/**
 * The code requirement one shipped executable must meet (codesign -R): Apple's anchor, a Developer
 * ID Application certificate (the two Apple OIDs: Developer ID's intermediate, and the leaf's
 * Developer ID Application mark) of our team, and the identifier release.sh signs it with,
 * IDENTIFIER.<file>. Ad hoc: only the identifier. install.sh repeats it.
 */
export function requirement(file: string, trust: { team: string } | { adHoc: true }): string {
  const id = `identifier "${IDENTIFIER}.${file}"`;
  if (!("team" in trust)) return id;
  return `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${trust.team}" and ${id}`;
}

/** Thrown when an update isn't signed by Kiko's developer, or isn't what its signed executable says it is: nothing of it is kept. */
export class SignatureError extends Error {}

/** A file name that can go into a requirement as it is: no quotes, nothing the requirement language reads. */
const PLAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The executables release.sh signs, by their paths in the folder: kiko, each helper in native/, bin/tmux (scripts/release.sh signed_files). */
function signedFiles(folder: string): string[] {
  let helpers: string[];
  try {
    helpers = readdirSync(join(folder, "native")).sort();
  } catch {
    throw new SignatureError("the download has no native/ helpers");
  }
  if (!helpers.length) throw new SignatureError("the download has no native/ helpers");
  return [SLUG, ...helpers.map((h) => `native/${h}`), "bin/tmux"];
}

/**
 * An unpacked version checked before anything is switched to it: each executable's signature
 * (codesign --verify --strict against `requirement`), then its own `kiko` asked to check every
 * other file against the list signed into it and to say its version, which must be `version` (an
 * old build of ours relabelled as a new one is a downgrade). Throws SignatureError saying why.
 */
export async function verifyRelease(folder: string, version: string, trust: Trust = releaseTrust()): Promise<void> {
  if ("off" in trust) return;
  await verifySignatures(folder, trust);
  let said: string;
  try {
    // Ours (its signature just checked), so it's safe to run: with nothing of this process's environment.
    said = (await run(join(folder, SLUG), [VERIFY_FILES], { cwd: folder, env: { PATH: "/usr/bin:/bin", HOME: homedir() }, timeout: 60_000 })).stdout.trim();
  } catch (err) {
    const why = String((err as { stderr?: string }).stderr ?? "").trim();
    throw new SignatureError(`its files aren't the ones ${NAME}'s developer built${why ? ` (${plain(why, 160)})` : ""}`);
  }
  if (said !== version) throw new SignatureError(`its ${SLUG} is version ${plain(said, 40) || "(none)"}, not ${version}`);
}

/** The app bundles in a release folder (the helper app, `<NAME>.app`), by their names there. */
function signedBundles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((name) => name.endsWith(".app"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Each executable in `folder` (signedFiles) signed as `trust` requires, and each app bundle in it
 * (the helper app: signedBundles) as IDENTIFIER.helper, with everything in it sealed by that
 * signature (`--deep`); throws SignatureError naming the first that isn't.
 */
export async function verifySignatures(folder: string, trust: { team: string } | { adHoc: true }): Promise<void> {
  for (const bundle of signedBundles(folder)) {
    const path = join(folder, bundle);
    if (!lstatSync(path).isDirectory()) throw new SignatureError(`${bundle} in the download isn't a folder`);
    try {
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${requirement("helper", trust)}`, path]);
    } catch (err) {
      const said = String((err as { stderr?: string }).stderr ?? "")
        .trim()
        .split("\n")
        .pop();
      throw new SignatureError(`${bundle} isn't signed by ${NAME}'s developer${said ? ` (codesign: ${plain(said.replace(`${path}: `, ""), 160)})` : ""}`);
    }
  }
  for (const file of signedFiles(folder)) {
    const name = file.split("/").pop() ?? "";
    if (!PLAIN_NAME.test(name)) throw new SignatureError(`the download has a file named ${JSON.stringify(file).slice(0, 80)}`);
    const path = join(folder, file);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      throw new SignatureError(`the download has no ${file}`);
    }
    if (!st.isFile()) throw new SignatureError(`${file} in the download isn't a plain file`);
    try {
      await run("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement(name, trust)}`, path]);
    } catch (err) {
      const said = String((err as { stderr?: string }).stderr ?? "")
        .trim()
        .split("\n")
        .pop();
      throw new SignatureError(`${file} isn't signed by ${NAME}'s developer${said ? ` (codesign: ${plain(said.replace(`${path}: `, ""), 160)})` : ""}`);
    }
  }
}
