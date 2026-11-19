// The install (./updater.ts has how updates go), the shared contract (install.sh writes it):
//   ~/.local/share/kiko/versions/<version>/   each version, as its tarball unpacked it
//   ~/.local/share/kiko/current  → versions/<version>   the one `kiko` runs
//   ~/.local/share/kiko/previous → versions/<version>   the one before (kiko update --rollback)
//   ~/.local/bin/kiko            → ~/.local/share/kiko/current/kiko
// A link is switched by making the new one beside it and renaming it over the old (rename(2) is
// atomic), so a start always finds one version or the other, never half of one. Here too: a release
// put into it (downloaded, unpacked, checked, switched to), one install at a time, and only ever
// forward: never a version lower than or the same as the one running or installed (--rollback is
// the way back).
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { alive } from "../alive.ts";
import { APP_ROOT } from "../app-root.ts";
import { COMMAND, envVar, NAME, SLUG } from "../name.ts";
import { compareVersions, download, isVersion, type NetTiming, platformKey, type Progress, RETRY_MS, type Release } from "./feed.ts";
import type { ReleaseAuth } from "./invite.ts";
import { type Verify, verifyRelease } from "./verify.ts";

const run = promisify(execFile);

// ── The install ─────────────────────────────────────────────────────────────

/** Where an install lives (the contract's layout), and where its update state is kept. */
export type Layout = { share: string; bin: string; state: string };

/** The layout under a home folder (the user's, or a test's). */
export const layoutOf = (home = homedir()): Layout => ({
  share: join(home, ".local", "share", SLUG),
  bin: join(home, ".local", "bin", SLUG),
  state: join(home, ".local", "state", SLUG),
});

const versionsDir = (l: Layout) => join(l.share, "versions");
const currentLink = (l: Layout) => join(l.share, "current");
const previousLink = (l: Layout) => join(l.share, "previous");
/** Where a version is unpacked to. */
export const versionDir = (l: Layout, version: string) => join(versionsDir(l), version);

/**
 * The version a link points at (versions/<version>, relative or not), when it's a version folder
 * that's there; null otherwise.
 */
function linkedVersion(l: Layout, link: string): string | null {
  let target: string;
  try {
    target = resolve(dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
  const rel = relative(versionsDir(l), target);
  return isVersion(rel) && existsSync(join(target, SLUG)) ? rel : null;
}

/** The version `kiko` starts now (current's), null when there's none. */
export const currentVersion = (l: Layout) => linkedVersion(l, currentLink(l));

/** The versions unpacked, oldest first. */
export function versionsInstalled(l: Layout): string[] {
  let names: string[];
  try {
    names = readdirSync(versionsDir(l));
  } catch {
    return [];
  }
  return names.filter((n) => isVersion(n) && existsSync(join(versionsDir(l), n, SLUG))).sort(compareVersions);
}

/**
 * The version to go back to: what `previous` points at, else (an install that only ever had the
 * install script) the newest one older than current.
 */
export function previousVersion(l: Layout): string | null {
  const current = currentVersion(l);
  const linked = linkedVersion(l, previousLink(l));
  if (linked && linked !== current) return linked;
  if (!current) return null;
  return (
    versionsInstalled(l)
      .filter((v) => compareVersions(v, current) < 0)
      .pop() ?? null
  );
}

/**
 * The version folder a copy running from `root` is, when it's an installed one; null for a
 * development checkout (or anything else not in versions/).
 */
export function installedAs(root: string, l: Layout): string | null {
  try {
    const rel = relative(realpathSync(versionsDir(l)), realpathSync(root));
    return isVersion(rel) && !rel.includes(sep) ? rel : null;
  } catch {
    return null;
  }
}

/** A link pointed at `target`, atomically: made beside it, then renamed over it. */
function relink(link: string, target: string) {
  const fresh = `${link}.new-${process.pid}`;
  rmSync(fresh, { force: true });
  symlinkSync(target, fresh);
  renameSync(fresh, link);
}

/**
 * ~/.local/bin/kiko made when it's missing, and pointed at current's when it's a link into the
 * install. A file of your own there (your launcher), or a link elsewhere, is left as it is.
 */
function ensureBinLink(l: Layout) {
  const want = join(currentLink(l), SLUG);
  let link: string | null = null;
  try {
    if (!lstatSync(l.bin).isSymbolicLink()) return;
    link = readlinkSync(l.bin);
  } catch {
    // none
  }
  if (link === want) return;
  if (link !== null && !resolve(dirname(l.bin), link).startsWith(`${l.share}${sep}`)) return;
  mkdirSync(dirname(l.bin), { recursive: true });
  relink(l.bin, want);
}

/** Switches the install to `version` (unpacked already): the one current had becomes previous. */
export function switchTo(l: Layout, version: string) {
  if (!existsSync(join(versionDir(l, version), SLUG))) throw new Error(`${NAME} ${version} isn't unpacked`);
  const was = currentVersion(l);
  if (was && was !== version) relink(previousLink(l), join("versions", was));
  relink(currentLink(l), join("versions", version));
  ensureBinLink(l);
}

/** Back to the version before: current and previous change places. Returns both; throws when there's none to go back to. */
export function rollback(l: Layout): { from: string; to: string } {
  const from = currentVersion(l);
  const to = previousVersion(l);
  if (!from) throw new Error(`${NAME} isn't installed here (no ${currentLink(l)})`);
  if (!to) throw new Error(`there's no version before ${from} to go back to`);
  relink(previousLink(l), join("versions", from));
  relink(currentLink(l), join("versions", to));
  ensureBinLink(l);
  return { from, to };
}

/**
 * Old versions taken out: all but current, previous and `keep` (the one running, which tmux's panes
 * may still use), and what an unpack cut short left.
 */
export function prune(l: Layout, keep: Array<string | null | undefined> = []): string[] {
  const kept = new Set([currentVersion(l), previousVersion(l), ...keep].filter(Boolean));
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(versionsDir(l));
  } catch {
    return removed;
  }
  for (const name of names) {
    const path = join(versionsDir(l), name);
    if (name.startsWith(".unpack-")) {
      const old = Date.now() - statSync(path).mtimeMs > RETRY_MS;
      if (old) rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (!isVersion(name) || kept.has(name)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// ── Unpack ──────────────────────────────────────────────────────────────────

/**
 * A downloaded tarball unpacked to versions/<version>: into a folder beside it first, checked
 * (`verify`), then its one folder (kiko-<version>/, holding the kiko executable) renamed into
 * place, so versions/ never has half a version, nor one that failed its check. One that's there
 * already is kept as it is.
 */
async function unpack(l: Layout, tarball: string, version: string, verify: Verify = verifyRelease): Promise<string> {
  const dest = versionDir(l, version);
  if (existsSync(join(dest, SLUG))) return dest;
  const scratch = join(versionsDir(l), `.unpack-${version}-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await run("tar", ["-xzf", tarball, "-C", scratch]);
    const folder = join(scratch, `${SLUG}-${version}`);
    const exe = join(folder, SLUG);
    if (!existsSync(exe) || !statSync(exe).isFile()) throw new Error(`the download has no ${SLUG}-${version}/${SLUG} in it`);
    if (!(statSync(exe).mode & 0o111)) throw new Error(`${SLUG}-${version}/${SLUG} in the download isn't executable`);
    await verify(folder, version);
    rmSync(dest, { recursive: true, force: true }); // a folder without its executable: what's left of something else
    renameSync(folder, dest);
    return dest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── One at a time ───────────────────────────────────────────────────────────

/** Thrown when another install is going on (the app's in the background, or another kiko update). */
export class BusyError extends Error {}

/** Thrown when the feed offers a version that isn't newer than the one running or installed. */
export class DowngradeError extends Error {}

const LOCK_STALE_MS = 30 * 60 * 1000;

/** Runs `fn` holding the install's lock (a folder: mkdir is atomic); one left by a process that's gone, or very old, is taken over. */
export async function withLock<T>(l: Layout, fn: () => Promise<T>): Promise<T> {
  const lock = join(l.share, ".update-lock");
  mkdirSync(l.share, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt) throw new BusyError(`another update is going on (${lock})`);
      let pid = 0;
      try {
        pid = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {
        // being written, or left empty
      }
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // gone meanwhile
      }
      if ((pid && alive(pid) && age < LOCK_STALE_MS) || (!pid && age < 60_000)) throw new BusyError(`another update is going on (${lock})`);
      rmSync(lock, { recursive: true, force: true });
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * A release installed: downloaded for this Mac, checked (its sha256, then its signatures:
 * `verify`, verifyRelease by default), unpacked beside the others, switched to, and the old ones
 * beyond the one before taken out (never `running`). Only forward: a version that isn't newer than
 * `running` and the one installed is refused (DowngradeError). One unpacked already (`kiko
 * update` after a rollback) is checked again too; one that fails is taken out. Returns its folder.
 * `auth`: the invite's headers for kiko.sh (./invite.ts), sent with the download when it's there.
 * A download cut off is tried again (./feed.ts download; `net`: the tests' shorter waits).
 */
export async function install(
  l: Layout,
  release: Release,
  o: { running?: string | null; progress?: Progress; platform?: string; verify?: Verify; auth?: ReleaseAuth; net?: NetTiming } = {},
): Promise<string> {
  const key = o.platform ?? platformKey();
  const asset = release.assets[key];
  if (!asset) throw new Error(`${NAME} ${release.version} has no download for this Mac (${key})`);
  const verify = o.verify ?? verifyRelease;
  return withLock(l, async () => {
    for (const ahead of [o.running, currentVersion(l)])
      if (ahead && compareVersions(release.version, ahead) <= 0) throw new DowngradeError(`${NAME} ${release.version} isn't newer than ${ahead} (${COMMAND} update --rollback is the way back)`);
    let dest = versionDir(l, release.version);
    if (!existsSync(join(dest, SLUG))) {
      const tarball = join(versionsDir(l), `.unpack-${release.version}-${process.pid}.tar.gz`);
      try {
        await download(asset, tarball, o.progress, undefined, o.auth, o.net);
        dest = await unpack(l, tarball, release.version, verify);
      } finally {
        rmSync(tarball, { force: true });
      }
    } else {
      try {
        await verify(dest, release.version);
      } catch (err) {
        // Neither current nor running (it's newer than both): nothing uses it.
        rmSync(dest, { recursive: true, force: true });
        throw err;
      }
    }
    switchTo(l, release.version);
    prune(l, [o.running]);
    return dest;
  });
}

// ── This copy ───────────────────────────────────────────────────────────────

/** This copy: where it runs from, its version, and whether it's an installed one. */
export type Copy = { root: string; version: string; layout: Layout; installed: boolean };

/** This copy: where it runs from (KIKO_APP_ROOT in tests, a fake install's version folder), and its version. */
export const thisCopy = (version: string, layout = layoutOf()) => copyOf(envVar("APP_ROOT") ?? APP_ROOT, version, layout);

/** This copy, running from `root`: an installed one's version is its folder's name (the same as its package.json's), else `version`. */
export function copyOf(root: string, version: string, layout = layoutOf()): Copy {
  const as = installedAs(root, layout);
  return { root, version: as ?? version, layout, installed: as !== null };
}

// ── Starting the new one ────────────────────────────────────────────────────

/**
 * The command line that starts the version installed now in place of this one (start.ts, after
 * Restart now): `argv`, the one that starts this version's program (core/app-root.ts programArgv),
 * with every path inside the running version's folder moved to the same place in the new one's
 * (the one executable …/versions/0.1.0/kiko → …/versions/0.1.1/kiko). Null when there's no
 * other version to start.
 */
export function relaunchCommand(copy: Copy, argv: readonly string[]): string[] | null {
  if (!copy.installed) return null;
  const next = currentVersion(copy.layout);
  if (!next || next === installedAs(copy.root, copy.layout)) return null;
  let real: string;
  try {
    real = realpathSync(copy.root);
  } catch {
    return null;
  }
  const to = versionDir(copy.layout, next);
  const roots = [real, resolve(copy.root)].map((r) => r.replace(/\/+$/, ""));
  const move = (p: string) => {
    const from = roots.find((r) => p === r || p.startsWith(`${r}${sep}`));
    return from ? to + p.slice(from.length) : p;
  };
  return argv.map(move);
}
