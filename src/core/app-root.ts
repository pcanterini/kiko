// Where Kiko runs from, and where it keeps what it writes. Two ways it runs:
//   - a dev checkout: the repo, run by Node (bin/kiko, pnpm start). Everything stays as it always
//     was: the app runs in the repo, its logs in logs/, its .env there (both the repo's wherever it runs from).
//   - an installed copy: one `kiko` executable (Bun's --compile, scripts/release.sh) with what it
//     needs beside it, in ~/.local/share/kiko/versions/<version>/ (install.sh). The `current` link
//     beside the versions points at the one in use, and ~/.local/bin/kiko at current/kiko. Its
//     logs and the like go to ~/.local/state/kiko/; settings stay in ~/.config/kiko/ either way.
// The two are also the two flavours (core/name.ts FLAVOUR): an installed copy is the release, a
// checkout Kiko Dev (`kiko-dev`, ~/.config/kiko-dev/, its own socket, tmux server and keys).
// Each one's hook entries are told apart by their root (hookFlavour).
// The installed folder (RELEASING.md):
//   kiko                 the executable: the CLI, and each of the app's own programs (src/main.ts)
//   native/<helper>         the Swift helpers that need no permission (keychain, opus, player, presence), prebuilt
//   Kiko.app                the helper app (name.ts helperApp): the mic, hotkey, speech and permissions helpers,
//                           whose macOS permissions are its own (platform/macos/helper-app.ts)
//   hooks/*.mjs, statusline/kiko-status.mjs   the scripts the agents run, run by the executable
//   pocket/                 Pocket TTS's server, setup script and requirements (its Python goes in POCKET_SHARED_VENV)
//   tmux/                   the window's tmux.conf and the empty pane's script
//   bin/tmux                tmux itself, built for the release (scripts/build-tmux.sh): Kiko's own server runs it
//   terminfo/               the tmux-256color entry its panes' programs need (macOS 13 has none)
//   LICENSE.md, THIRD_PARTY_NOTICES.md   Kiko's licence; Bun's, the bundled packages' and tmux's (scripts/notices/notices.ts)
// Imports nothing that loads .env or writes logs, so anything can import it.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envVar, FLAVOUR, type Flavour, flavourNames, SLUG } from "./name.ts";
import { shellWord } from "./shell.ts";

/** An installed copy: this code is built into the executable (Bun's embedded files, under /$bunfs/), not read from a checkout. */
export const INSTALLED = import.meta.url.includes("/$bunfs/");

const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** The repo (a checkout), or the folder holding the executable (an installed copy). */
export const APP_ROOT = INSTALLED ? dirname(real(process.execPath)) : fileURLToPath(new URL("../..", import.meta.url));

/** Kiko's own folder in ~/.local/share: the versions, the `current` link, Pocket's Python, uv and model. */
export const SHARE_DIR = join(homedir(), ".local", "share", SLUG);
/** The versions installed side by side (install.sh, `kiko update`). */
const VERSIONS_DIR = join(SHARE_DIR, "versions");
/** The link to the version in use. */
export const CURRENT_LINK = join(SHARE_DIR, "current");
/** The command on the PATH: a link to current/kiko. */
export const BIN_LINK = join(homedir(), ".local", "bin", SLUG);

/**
 * The root as the agents' hooks name it: an installed version reached through the `current` link,
 * so an update (which moves the link) leaves the hooks working. A checkout, or a copy run from
 * anywhere else: the folder itself.
 */
export const STABLE_ROOT = INSTALLED && dirname(APP_ROOT) === real(VERSIONS_DIR) ? CURRENT_LINK : APP_ROOT;

/** Where the app runs and writes: the repo in a checkout (as always); ~/.local/state/kiko/ for an installed copy. */
export const STATE_DIR = INSTALLED ? join(homedir(), ".local", "state", SLUG) : APP_ROOT;

/** The app's logs: KIKO_LOG_DIR, else logs/ in STATE_DIR (the repo's logs/ in a checkout), wherever it runs from. */
export const LOG_DIR = envVar("LOG_DIR") ?? join(STATE_DIR, "logs");

/**
 * A checkout's .env (core/dev-env.ts reads its KIKO_ values first thing, core/config.ts loads it
 * all): the repo's, wherever it runs from. KIKO_ENV_FILE names another, or none when empty (the
 * tests). The release reads none: an installed copy, or a checkout run as it (KIKO_FLAVOUR=release).
 */
export const ENV_FILE = INSTALLED || FLAVOUR === "release" ? null : (envVar("ENV_FILE") ?? join(APP_ROOT, ".env")) || null;

/**
 * Where Pocket TTS lives (`installed`: an installed copy; `root`: the checkout; `env`: for
 * KIKO_POCKET_VENV):
 *   - home: its own folder, once per flavour and outside any checkout or version folder, so every
 *     copy of a flavour shares one install (as they share the settings, the keys and the helper
 *     app's permissions) and an update keeps it: ~/.local/share/kiko for an installed copy,
 *     ~/.local/share/kiko-dev for a checkout (by where the code is, not KIKO_FLAVOUR: a checkout run
 *     as the release never touches the installed release's venv). The two never share a venv (a
 *     checkout may change Pocket's Python packages); each clones the other's model (core/pocket-tts.ts).
 *   - shared: its venv, pocket-venv in its home; KIKO_POCKET_VENV puts it elsewhere (the app
 *     harness's start with no Pocket: tests/harness/test-start.ts; the unit tests). Beside it,
 *     Pocket's own uv (pocket-uv/, when setup.sh had to fetch one), its model (pocket-hf/) and its
 *     download's files (pocket-prep.*): core/pocket-tts.ts.
 *   - legacy: where Kiko Dev kept Pocket before it was shared, a checkout's own pocket/.venv: this
 *     checkout's, then (a git worktree) its main checkout's. Only read, never written: one that's
 *     whole is used until the shared venv is ready (core/pocket-tts.ts pickPocketVenv), and its
 *     model is cloned from (pocketModelSources). None for an installed copy, nor with KIKO_POCKET_VENV.
 *   - log: its server's log, in the flavour's state folder (~/.local/state/kiko, or kiko-dev), not
 *     the checkout; beside KIKO_POCKET_VENV when that's set.
 */
export function pocketPaths(env: NodeJS.ProcessEnv = process.env, home = homedir(), installed = INSTALLED, root = APP_ROOT) {
  const slug = installed ? SLUG : flavourNames("dev").slug;
  const own = envVar("POCKET_VENV", env);
  const pocketHome = join(home, ".local", "share", slug);
  const shared = own || join(pocketHome, "pocket-venv");
  return {
    home: pocketHome,
    shared,
    legacy: installed || own ? [] : legacyCheckouts(root).map((checkout) => join(checkout, "pocket", ".venv")),
    log: own ? join(dirname(shared), "pocket-server.log") : join(home, ".local", "state", slug, "pocket-server.log"),
  };
}

/** A checkout and, when it's a git worktree (its .git a file naming <main>/.git/worktrees/<name>), its main checkout. */
export function legacyCheckouts(root: string): string[] {
  const out = [resolve(root)];
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(root, ".git"), "utf8"));
    const gitdir = m ? resolve(root, m[1]) : "";
    if (basename(dirname(gitdir)) === "worktrees" && basename(dirname(dirname(gitdir))) === ".git") out.push(dirname(dirname(dirname(gitdir))));
  } catch {
    // Not a worktree (its .git a folder), or not a git checkout at all.
  }
  return [...new Set(out)];
}

const POCKET = pocketPaths();
/** Pocket's own folder for this flavour (pocketPaths home). */
export const POCKET_HOME = POCKET.home;
/** Pocket TTS's Python, the flavour's shared venv (pocketPaths shared). The one in use may be an older checkout's own until it's ready: core/pocket-tts.ts POCKET_VENV. */
export const POCKET_SHARED_VENV = POCKET.shared;
/** A checkout's own pocket/.venv from before it was shared, this one's and its main checkout's (pocketPaths legacy). */
export const LEGACY_POCKET_VENVS = POCKET.legacy;
/** Pocket TTS's server log (pocketPaths log). */
export const POCKET_LOG = POCKET.log;

/**
 * A file that ships with the app, by its path in the repo; `installed`: its path in the installed
 * folder when that differs. `stable`: reached through the `current` link (for what the agents run).
 */
export function appFile(path: string, installed = path, stable = false): string {
  return INSTALLED ? join(stable ? STABLE_ROOT : APP_ROOT, installed) : join(APP_ROOT, path);
}

/** An installed copy's own tmux (terminals/tmux/tmux.ts tmuxPath), by the `current` link: a pane that runs it (the empty pane's script) outlives a version folder. */
export const BUNDLED_TMUX = join(STABLE_ROOT, "bin", "tmux");
/** The terminfo entries that ship beside it (terminals/tmux/tmux.ts tmuxEnv). */
export const BUNDLED_TERMINFO = join(STABLE_ROOT, "terminfo");

/** The Swift helper `name`, prebuilt, in an installed copy's native/ (a checkout builds its own: platform/macos/native.ts; the helper app holds the rest: helper-app.ts directPath). */
export const installedHelper = (name: string) => join(APP_ROOT, "native", name);

/**
 * The app's own programs, each run in a process (or a tmux pane) of its own, by their files in src/.
 * The keys are what an installed copy runs (`kiko _run <key>`, also in a tmux server's panes and
 * options), so they stay as they are when a file is renamed.
 */
export const PROGRAMS = {
  start: "start.ts",
  app: "app.ts",
  onboard: "onboard.ts",
  // Pocket's download started early (install.sh runs it once the files are in place).
  pocket: "pocket-start.ts",
  viewer: "terminals/tmux/viewer-pane.ts",
  frame: "terminals/tmux/frame-pane.ts",
  menu: "terminals/tmux/menu-popup.ts",
} as const;
export type Program = keyof typeof PROGRAMS;

/** Which of PROGRAMS this process is, in an installed copy (src/main.ts sets it before running it); null in a checkout, where argv[1] says. */
export const running: { program: Program | null } = { program: null };

/** The internal command an installed executable takes to run one of PROGRAMS (src/main.ts). */
export const RUN_PROGRAM = "_run";
/** The command an installed executable takes to run a script beside it (hooks/, statusline/): src/main.ts. */
export const RUN_SCRIPT = "hook";

/** The command line that runs one of the app's programs: `node src/<file>` in a checkout; the executable itself in an installed copy. */
export function programArgv(name: Program): string[] {
  return INSTALLED ? [process.execPath, RUN_PROGRAM, name] : [process.execPath, fileURLToPath(new URL(`../${PROGRAMS[name]}`, import.meta.url))];
}

/** The command line that runs the command line itself (`kiko …`): the executable in an installed copy; `node src/cli.ts` in a checkout. */
export function cliArgv(): string[] {
  return INSTALLED ? [process.execPath] : [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))];
}

/**
 * The command an agent's hook runs for `script` (hooks/<name>.mjs): `node <path>` in a checkout
 * (as always); in an installed copy, the executable, both by the `current` link. Absolute paths:
 * the agent runs it from any folder.
 */
export function hookCommand(script: string, quote: (word: string) => string = shellWord): string {
  return INSTALLED ? `${quote(join(STABLE_ROOT, SLUG))} ${RUN_SCRIPT} ${quote(join(STABLE_ROOT, script))}` : `node ${quote(join(APP_ROOT, script))}`;
}

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
/** This copy's own roots, as written and as they really are. */
const OWN_ROOTS = new Set([APP_ROOT, STABLE_ROOT].flatMap((root) => [resolve(root), real(resolve(root))]));
const ownRoot = (root: string) => OWN_ROOTS.has(resolve(root)) || OWN_ROOTS.has(real(resolve(root)));

/**
 * Which flavour one of Kiko's hook entries in an agent's file belongs to (`script`: the hook
 * script it runs, `command`: the whole command). The release's and Kiko Dev's entries sit side by
 * side there, and each app counts, repairs, upgrades and takes out only its own (agents/hooks-file.ts
 * isOurs), by the root its script is in, never by the script's name alone:
 *   - this copy's own root (its folder, or the `current` link it's reached by): this flavour;
 *   - the release's install (~/.local/share/kiko: any version, or `current`), or a script run by
 *     the executable beside it (`<root>/kiko hook <root>/hooks/…`, a release run from elsewhere):
 *     the release;
 *   - anything else (`node <a checkout>/hooks/…`, this one or another): Kiko Dev.
 * `share`: the release's install folder (tests give their own).
 */
export function hookFlavour(script: string, command: string, share = SHARE_DIR): Flavour {
  const root = dirname(dirname(script));
  if (ownRoot(root)) return FLAVOUR;
  if (within(resolve(script), resolve(share))) return "release";
  const exe = join(root, SLUG);
  if ([shellWord(exe), `"${exe}"`].some((word) => command.trimStart().startsWith(`${word} ${RUN_SCRIPT} `))) return "release";
  return "dev";
}

/** Whether a hook entry of Kiko's is this flavour's own (hookFlavour). */
export const ownsHook = (script: string, command: string) => hookFlavour(script, command) === FLAVOUR;

/** The argv that runs `script` (hooks/, statusline/) from the app itself: this Node in a checkout, the executable in an installed copy. */
export function scriptArgv(script: string): string[] {
  return INSTALLED ? [process.execPath, RUN_SCRIPT, join(APP_ROOT, script)] : [process.execPath, join(APP_ROOT, script)];
}
