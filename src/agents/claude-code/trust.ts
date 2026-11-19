// Whether Claude Code trusts a folder: it asks "Accessing workspace … ❯ No, exit / Yes, I trust this
// folder" in one it doesn't, and starts no session there until you answer. Your answer is kept in
// its own config file (~/.claude.json) as `projects[<folder>].hasTrustDialogAccepted`; a trusted
// parent covers its subfolders (except inside a git repo, where the walk up stops at the repo's
// root), so trusting Kiko's scratch folder once covers every scratch session after it.
//
// As Claude Code 2.1.314 decides it (read from its own code, the startup check): trusted when its
// project's entry is (the git repo's root, a worktree's main checkout, else the folder itself), or
// when the folder or any folder above it is, walking up to the repo's root inside a git repo (the
// first folder up with a `.git`, a directory or a worktree's file) and to `/` outside one. A
// subfolder's own `false` doesn't stop the walk: a session started in a new scratch folder without
// asking, its own entry `false`, the scratch folder's `true`. Paths are compared as Claude Code writes them (NFC, no trailing slash).
//
// Read only, and only that one field: the file is Claude Code's (running sessions rewrite it) and
// holds its tokens, so Kiko never writes it, and never logs or prints anything else from it. No
// flag skips the prompt for an interactive `claude`: the way to trust a folder is to answer the
// prompt there once (`kiko trust-scratch`, or "trust the scratch folder" to the app).
//
// Imports nothing that loads .env, so the CLI uses it too.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { envVar } from "../../core/name.ts";

/** Claude Code's config file: $CLAUDE_CONFIG_DIR/.claude.json when that's set, else ~/.claude.json. KIKO_CLAUDE_CONFIG: another (the tests' fixture). */
export function claudeConfigFile(): string {
  const set = envVar("CLAUDE_CONFIG");
  if (set) return set;
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Whether Claude Code trusts `folder`, as it decides it (see the top): its project's answer, or its
 * own, or a folder's above it, up to its git repo's root (to `/` outside one); under the path as
 * given or as it really is. A folder not made yet is looked at as it will be. Null when it can't
 * tell: no file, or one it can't read. Parsed here, in this process; nothing but that field is
 * looked at, and nothing is kept.
 */
export function folderTrusted(folder: string, file = claudeConfigFile()): boolean | null {
  let projects: unknown;
  try {
    projects = JSON.parse(readFileSync(file, "utf8"))?.projects;
  } catch {
    return null;
  }
  if (!projects || typeof projects !== "object") return false;
  const trusted = (path: string) => (projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>)[path]?.hasTrustDialogAccepted === true;
  const paths = new Set([clean(resolve(folder))]);
  try {
    paths.add(clean(realpathSync(folder)));
  } catch {
    // not made yet: as given
  }
  for (const path of paths) {
    const repo = gitRoot(path);
    // A worktree is its main checkout's project.
    const main = repo && mainCheckout(repo);
    if (main && trusted(main)) return true;
    for (let at = path; ; at = dirname(at)) {
      if (trusted(at)) return true;
      if (at === repo || dirname(at) === at) break;
    }
  }
  return false;
}

/** A path as Claude Code keys its projects: NFC, no trailing slash ("/" stays). */
const clean = (path: string) => path.normalize("NFC").replace(/(.)\/+$/, "$1");

/** The git repo `path` is in: the first folder up (itself first) with a `.git`, a directory or a worktree's file; null outside one. */
function gitRoot(path: string): string | null {
  for (let at = path; ; at = dirname(at)) {
    try {
      const git = statSync(join(at, ".git"));
      if (git.isDirectory() || git.isFile()) return at;
    } catch {
      // none here
    }
    if (dirname(at) === at) return null;
  }
}

/**
 * A worktree's main checkout, which Claude Code keys its project by: its `.git` file says `gitdir:
 * <main>/.git/worktrees/<name>`, whose `commondir` is the main `.git`. Null for a main checkout itself.
 */
function mainCheckout(repo: string): string | null {
  try {
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(repo, ".git"), "utf8"))?.[1]?.trim();
    if (!link) return null;
    const gitdir = resolve(repo, link);
    const commondir = join(gitdir, "commondir");
    const common = existsSync(commondir) ? resolve(gitdir, readFileSync(commondir, "utf8").trim()) : null;
    return common && basename(common) === ".git" ? clean(dirname(common)) : null;
  } catch {
    return null;
  }
}
