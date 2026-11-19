// Kiko's own tmux: the program, its server and config, and running them. Its own server
// (`tmux -L kiko`) with its own config (./tmux.conf, given with `-f`), so the user's
// ~/.tmux.conf and their own tmux servers are never read or touched. Used by the tmux adapter
// (./index.ts) and by `kiko claude` (src/cli.ts), which runs in any folder: so this imports
// nothing of Kiko's that loads .env, reads settings or writes logs.
import { execFile, spawn } from "node:child_process";
import { existsSync, fstatSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isatty } from "node:tty";
import { appFile, BUNDLED_TERMINFO, BUNDLED_TMUX, INSTALLED } from "../../core/app-root.ts";
import { ENV_PREFIX as VAR_PREFIX, envVar, flavourNames, OWN, SLUG, TITLE } from "../../core/name.ts";
import { shellQuote, shellWord } from "../../core/shell.ts";

/** Its config, read when the server starts (a running one keeps what it started with). */
export const CONFIG = appFile("src/terminals/tmux/tmux.conf", "tmux/tmux.conf");

// Where Homebrew (Apple silicon, Intel) and MacPorts put it, for an app started without them on PATH.
const USUAL = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];

let found: string | null = null;

/**
 * Your own tmux: on PATH, else where it's usually installed; null when there's none. Looked up
 * again until it's found. For your own tmux server (clash.ts asks it about the Kiko key, when
 * `kiko` runs inside it), and Kiko's own in a checkout (tmuxPath).
 */
export function userTmux(path = process.env.PATH ?? ""): string | null {
  if (found) return found;
  for (const dir of [...path.split(delimiter).filter(Boolean), ...USUAL]) {
    const at = join(dir, "tmux");
    if (existsSync(at)) return (found = at);
  }
  return null;
}

/**
 * The tmux that runs Kiko's own server (`-L kiko`), and every client of it: KIKO_TMUX_BIN when
 * set (a checkout trying a release's); an installed copy's own, which each release ships
 * (bin/tmux, by the `current` link: core/app-root.ts BUNDLED_TMUX), so a Mac needs no tmux of its
 * own and client and server are always the same version; in a checkout, yours (userTmux, as
 * always). Null when that one isn't there. Every program that runs tmux on Kiko's server gets
 * this path (the window's panes take it as an argument: window.ts, placeholder.sh).
 */
export function tmuxPath(): string | null {
  const named = envVar("TMUX_BIN");
  if (named) return existsSync(named) ? named : null;
  if (INSTALLED) return existsSync(BUNDLED_TMUX) ? BUNDLED_TMUX : null;
  return userTmux();
}

/**
 * `env` for running Kiko's tmux (tmuxPath): when it's an installed copy's own, with the terminfo
 * that ships beside it on TERMINFO_DIRS, after macOS's own (and any of yours). Its panes' TERM is
 * tmux-256color (tmux.conf), which macOS 13's terminfo lacks (14 and later have it): a server
 * started with this passes it to every program in its panes. Anything else: `env` as it is.
 */
export function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!INSTALLED || envVar("TMUX_BIN") || !existsSync(BUNDLED_TERMINFO)) return env;
  const dirs = [...(env.TERMINFO_DIRS ? [env.TERMINFO_DIRS] : []), "/usr/share/terminfo", BUNDLED_TERMINFO];
  return { ...env, TERMINFO_DIRS: dirs.join(":") };
}

/**
 * Kiko's tmux server: `tmux -L kiko` (Kiko Dev's: `tmux -L kiko-dev`, so the two never
 * share sessions or options). KIKO_TMUX_SERVER names another, for trying things out on a
 * throwaway one (the app and `kiko` both read it); the tests make their own.
 */
export const SERVER = envVar("TMUX_SERVER") || OWN.tmuxServer;

/** What the app's own tmux names start with on SERVER: its options (`@kiko-role`…) and its window session (`_kiko`). */
const TMUX_NAME = SLUG;
/** An option of the app's own on SERVER: `@kiko-<name>` (TMUX_NAME). */
export const appOption = (name: string) => `@${TMUX_NAME}-${name}`;

/** One process, as `ps` lists it: its parent, its group, its terminal's foreground group, its state and terminal ("ttys003", "??"). */
export type Proc = { pid: number; ppid: number; pgid: number; tpgid: number; stat: string; tty: string };

/** `ps -A -o pid=,ppid=,pgid=,tpgid=,stat=,tty=` read back. */
export function parsePs(out: string): Proc[] {
  return out
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 6 && /^\d+$/.test(f[0]))
    .map(([pid, ppid, pgid, tpgid, stat, tty]) => ({ pid: +pid, ppid: +ppid, pgid: +pgid, tpgid: +tpgid, stat, tty }));
}

/** Every process on the computer. */
export function processes(): Promise<Proc[]> {
  return new Promise((resolve, reject) => execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,stat=,tty="], { maxBuffer: 16 << 20 }, (err, out) => (err ? reject(err) : resolve(parsePs(out)))));
}

// What tmux gets of the app's environment: what a new terminal window would have, nothing more.
// The app's own environment has its keys from .env (ANTHROPIC_API_KEY would make Claude Code bill
// the API instead of the user's plan) and KIKO_* settings; a server the app starts keeps its
// environment for every session in it. The login shell a new session runs in sets up the rest.
const PASSED = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "TMUX_TMPDIR", "LANG", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"]);

/** The environment tmux runs with when the app runs it: see PASSED, plus the locale (LC_*); never herdr's (HERDR_*). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (PASSED.has(k) || k.startsWith("LC_"))));
}

// What `kiko claude` doesn't pass on to its session: the terminal is described to it by tmux,
// not by the terminal outside (TERM, its program, its own variables), and tmux sets its own TMUX
// (which the session's program then doesn't get: LEAVE_TMUX, which keeps it in KIKO_KEPT_TMUX).
// herdr's (HERDR_*: ./herdr.ts) name the herdr pane `kiko` ran in, and herdr's own Claude Code
// hooks report to it: a session here would report as that pane (herdr issues #2134, #2135).
/** Where a session keeps what TMUX said (LEAVE_TMUX): KIKO_KEPT_TMUX. */
const KEPT = `${VAR_PREFIX}KEPT_TMUX`;
const NOT_PASSED = new RegExp(
  String.raw`^(?:TMUX|TMUX_PANE|${KEPT}|${KEPT}_PANE|TERM|TERMINFO|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|COLORTERM|ITERM_\w*|GHOSTTY_\w*|KITTY_\w*|WEZTERM_\w*|HERDR_\w*|LC_TERMINAL\w*|WINDOWID|SHLVL|PWD|OLDPWD|_)$`,
);

/** A shell's environment without its terminal's own variables (see NOT_PASSED). */
export function withoutTerminal(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !NOT_PASSED.test(k)));
}

/**
 * sh lines that keep a session's program (Claude Code) off Kiko's tmux server: TMUX and
 * TMUX_PANE unset, so a `tmux kill-server`, `kill-session` or `send-keys -t <the list> y` it runs
 * never reaches Kiko's server (where it could end every session, or answer a permission card).
 * What TMUX said is kept in KIKO_KEPT_TMUX, for `kiko` run there to know it's inside (`inKiko`).
 * The window's own panes (the list, the placeholder, the viewer, a menu's popup) keep TMUX: they
 * aren't sessions, and find their server by it.
 */
export const LEAVE_TMUX = `${KEPT}="$TMUX"; ${KEPT}_PANE="$TMUX_PANE"; export ${KEPT}; unset TMUX TMUX_PANE`;
/** After LEAVE_TMUX in a shell that goes on (a voice-opened session's, once its program ends): TMUX and TMUX_PANE back. */
export const BACK_TMUX = `export TMUX="$${KEPT}" TMUX_PANE="$${KEPT}_PANE"`;

// Names shells keep for themselves, read-only in some (bash, zsh): never exported.
const SHELLS_OWN = new Set(["UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO", "GROUPS", "FUNCNAME", "BASH_ARGV", "BASH_ARGC", "BASH_LINENO", "BASH_SOURCE"]);

/**
 * The environment a session `kiko claude` starts gets: the shell's it was run from, as plain
 * `claude` would have (whatever the server started with), but the terminal's own; as `export` lines
 * for sh. Never as `new-session -e` flags: those sat in tmux's command line, where any program on the
 * Mac can read them (`ps`), keys and tokens included (2026-10-29). Each line `command export … 2>/dev/null`:
 * a name sh can't set (read-only there) is skipped, and never ends the script (a plain `export`
 * of one would: the program never started and the file stayed).
 */
export function sessionEnv(env: NodeJS.ProcessEnv, cwd: string, leaveTmux = false): string {
  const lines = [...Object.entries(withoutTerminal(env)), ["PWD", cwd]]
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k!) && !SHELLS_OWN.has(k!))
    .map(([k, v]) => `command export ${k}=${shellQuote(String(v))} 2>/dev/null\n`)
    .join("");
  return leaveTmux ? `${lines}${LEAVE_TMUX}\n` : lines;
}

/** A launch file's folder, in the temp folder: `kiko-env-…` (`kiko-dev-env-…`: each flavour sweeps only its own). */
const ENV_PREFIX = `${OWN.slug}-env-`;
/** Older than this, a launch file's folder is one sh never got to read (tmux or the computer stopped first). */
const ENV_STALE_MS = 60_000;

/** A command line that starts a program with an environment from a private file, and `discard()` for when tmux never ran it. */
export type Launch = { argv: string[]; discard(): void };

/**
 * The command a pane runs to start `program` with `env` (sessionEnv) without it ever being on a
 * command line: the lines go in a file only you can read, in a folder only you can open, which sh
 * opens, deletes, then reads (from the open file: so it's gone whatever the lines do), and then
 * becomes `program` (so the pane's process is the program itself: Claude Code, or the Kiko app
 * in its window). When tmux refuses the command (a name taken, the server gone), `discard()`
 * deletes the file at once: it holds your environment, keys included. Every launch is either run
 * or discarded; what neither reached is swept (sweepLaunches).
 */
export function envLaunch(env: NodeJS.ProcessEnv, cwd: string, program: string, args: string[], leaveTmux = false): Launch {
  const dir = mkdtempSync(join(tmpdir(), ENV_PREFIX)); // 0700
  const file = join(dir, "env");
  writeFileSync(file, sessionEnv(env, cwd, leaveTmux), { mode: 0o600 });
  const script = `exec 3<"$1" && rm -rf "$2" && . /dev/fd/3; exec 3<&-; shift 2; exec "$@"`;
  return { argv: ["/bin/sh", "-c", script, "sh", file, dir, program, ...args], discard: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Deletes launch files left behind (envLaunch): our own folders only (the name's prefix, in the
 * temp folder, a real folder of this user's, not a link), older than a minute, so one a pane is
 * about to read stays. Run when the app and the CLI start: each holds your environment, keys
 * included. How many it deleted.
 */
export function sweepLaunches(dir = tmpdir(), now = Date.now()): number {
  let gone = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const at = join(dir, name);
    try {
      const st = lstatSync(at);
      if (!st.isDirectory() || st.uid !== process.getuid?.() || now - st.mtimeMs < ENV_STALE_MS) continue;
      rmSync(at, { recursive: true, force: true });
      gone++;
    } catch {
      // gone meanwhile, or not ours to delete
    }
  }
  return gone;
}

/**
 * What every run of tmux starts with: `-u`, UTF-8 whatever the locale says. Without a UTF-8 locale
 * (no LANG: an app started by launchd, a stripped environment) tmux writes every tab and non-ASCII
 * character of its output as "_", so `list-panes -F` with tabs between fields read back as no panes
 * at all, and names with "é" or "…" came back wrong.
 */
export const tmuxFlags = (server: string, config?: string) => ["-u", "-L", server, ...(config ? ["-f", config] : [])];

/**
 * Why tmux mustn't be run with `env`, or null when it may: under the test runner (NODE_TEST_CONTEXT),
 * only with a TMUX_TMPDIR folder that's there (tests/setup.ts makes one), so a test never reaches your
 * own servers (`-L kiko`, `-L kiko-dev`, the default one) in /tmp: tmux takes a TMUX_TMPDIR that
 * isn't there for none, and uses /tmp (a test once killed a real server that way). As platform/keys.ts refuses the Keychain there.
 */
export function realServersRefused(env: NodeJS.ProcessEnv, underTest = Boolean(process.env.NODE_TEST_CONTEXT)): string | null {
  if (!underTest) return null;
  if (env.TMUX_TMPDIR && existsSync(env.TMUX_TMPDIR)) return null;
  return `run by a test (NODE_TEST_CONTEXT) with ${env.TMUX_TMPDIR ? `TMUX_TMPDIR ${env.TMUX_TMPDIR}, which isn't there` : "no TMUX_TMPDIR"}: not running tmux, whose servers would be your own`;
}

/** How long tmux gets to answer a command before it's given up on (a server that hangs). */
const TMUX_ANSWER_MS = 5000;
/** What a command tmux didn't answer in time rejects with. */
export const NO_ANSWER = "tmux didn't answer";

/**
 * Runs tmux on `server` (with `config`, for when this starts it): its output, or a rejection with
 * what it said on stderr. `input` goes to its stdin (`load-buffer -`). One that doesn't finish
 * within `timeoutMs` (a hung server) is killed and rejects with NO_ANSWER, so a caller never waits
 * for ever (words being typed are then refused, said out loud, never dropped). Not a popup: tmux
 * answers `display-popup` only once it closes (the menu, while you're in it).
 */
export function tmuxRunner(server = SERVER, config = CONFIG, env: NodeJS.ProcessEnv = cleanEnv(), timeoutMs = TMUX_ANSWER_MS) {
  return (args: string[], input?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const tmux = tmuxPath();
      if (!tmux) return reject(new Error("tmux isn't installed"));
      const refused = realServersRefused(env);
      if (refused) return reject(new Error(refused));
      const child = spawn(tmux, [...tmuxFlags(server, config), ...args], { env: tmuxEnv(env), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = args.includes("display-popup")
        ? null
        : setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(NO_ANSWER));
          }, timeoutMs);
      timer?.unref();
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => (timer && clearTimeout(timer), reject(e)));
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        code === 0 ? resolve(out) : reject(new Error(err.trim() || `tmux exited with ${code}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
}

/**
 * A word for tmux's command line, kept as it is: tmux takes any argument ending in ";" for the end
 * of a command (`a ; b`), so "fix x;" lost its ";" and what came after ran as tmux commands. One
 * ending in "\;" is kept, and tmux turns it back into ";". For every word that comes from the user,
 * a folder or a model: our own separators are the bare ";" (window.ts `together`).
 */
export const tmuxArg = (word: string) => (word.endsWith(";") ? `${word.slice(0, -1)}\\;` : word);

/**
 * A word tmux reads as a format, kept as it is: a start folder (`-c`) is one, so a folder named
 * "C#Samples" was "C" + the session's name + "amples", missing, and tmux started in $HOME instead
 * (and a "#(…)" in one could run a command). Every "#" doubled ("##" is a "#" to tmux), and
 * through tmuxArg. For every `-c` (and any other format argument) holding a folder or the user's words.
 */
export const tmuxFormatArg = (word: string) => tmuxArg(word.replace(/#/g, "##"));

/** "no server running", "error connecting to …": nothing is running on that server, so it has no panes. */
export function noServer(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return /no server running|error connecting to|no such file or directory/i.test(text);
}

/**
 * A tmux session's name from its folder: "pixie", "my-app"; tmux takes neither ":" nor "." in
 * one, and a name is also a word to type, so only letters, digits, "-" and "_".
 */
export function sessionNameFor(cwd: string) {
  const base = cwd.split("/").filter(Boolean).pop() ?? "";
  return (
    base
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "claude"
  );
}

/**
 * The tmux session that is the Kiko window (./window.ts): the app's pane, the session shown
 * beside it, and the status line. Never a folder's session name: freeName skips it.
 */
export const WINDOW = `_${TMUX_NAME}`;

/**
 * What a terminal showing Kiko's tmux is titled with, before the pane's own title ("Kiko ·
 * ✳ fix tests"): tmux.conf's set-titles-string, and the window's own (window.ts barOptions). The
 * Ghostty adapter never takes a window titled so for a session's: typing there goes to whichever
 * pane is active (another session, or the list, where letters are commands); a session in it is
 * reached through tmux.
 */
export const TITLE_MARK = `${TITLE} · `;
/** Either flavour's TITLE_MARK ("Kiko · ", "Kiko Dev · "): the other's tmux may be shown in a window too. */
export const TITLE_MARKS = (["release", "dev"] as const).map((f) => `${flavourNames(f).title} · `);

/** `name`, else name-2, name-3…: the first that isn't taken (nor the Kiko window's name). */
export function freeName(name: string, taken: readonly string[]) {
  const used = new Set([...taken, WINDOW]);
  if (!used.has(name)) return name;
  for (let n = 2; ; n++) if (!used.has(`${name}-${n}`)) return `${name}-${n}`;
}

/** The command line that attaches a terminal to one of `server`'s sessions (`=`: that name exactly, not one starting with it). */
export function attachCommand(session: string, server = SERVER) {
  return [tmuxPath() ?? "tmux", ...tmuxFlags(server), "attach-session", "-t", `=${session}`].map(shellWord).join(" ");
}

/**
 * Whether `TMUX` (set inside a tmux pane: "<socket>,<pid>,<session>") is a pane of `server`'s,
 * Kiko's own: `kiko claude` there runs Claude Code in it as it is, instead of tmux in tmux.
 */
export function insideServer(tmuxVar: string | undefined, server = SERVER) {
  const socket = tmuxVar?.split(",")[0] ?? "";
  return Boolean(socket) && socket.split("/").pop() === server;
}

/**
 * Where this runs, as far as Kiko's tmux goes: "pane" in one of its panes with TMUX (a shell
 * there, the window's own panes), "session" in a session's program, which has no TMUX (LEAVE_TMUX,
 * kept as KIKO_KEPT_TMUX), or null outside it.
 * As the environment says, which can be stale: `whereInKiko` checks it with the server.
 */
export function inKiko(env: NodeJS.ProcessEnv = process.env, server = SERVER): "pane" | "session" | null {
  if (insideServer(env.TMUX, server)) return "pane";
  if (env.TMUX) return null;
  return insideServer(envVar("KEPT_TMUX", env), server) ? "session" : null;
}

/**
 * This process's terminal: whether a tty tmux names (`pane_tty`, "/dev/ttys003") is the one its
 * stdin, stdout or stderr is (the same device); null when none of them is a terminal (a command a
 * session's program runs, through pipes).
 */
export function ownTerminal(): ((tty: string) => boolean) | null {
  const devices = [0, 1, 2].filter((fd) => isatty(fd)).map((fd) => fstatSync(fd).rdev);
  if (!devices.length) return null;
  return (tty) => {
    try {
      return devices.includes(statSync(tty).rdev);
    } catch {
      return false;
    }
  };
}

/**
 * `inKiko`, checked with Kiko's server: TMUX (and KIKO_KEPT_TMUX) are passed on to all
 * that starts there, so a terminal app opened from a pane (Ghostty relaunched from one) gives every
 * shell in it a TMUX naming Kiko's server, and it's no client of it (2026-10-30: `kiko` there
 * said "no current client", `kiko claude` ran plain claude). Inside only when one of the
 * server's panes is this terminal (`here`, ownTerminal): one tmux call (`run`, on that server), and
 * only when the environment says inside. A stale one, or no server: outside. Nothing to compare
 * (no terminal), or tmux not answering: as the environment says.
 */
export async function whereInKiko(run: (args: string[]) => Promise<string>, env: NodeJS.ProcessEnv = process.env, server = SERVER, here = ownTerminal()): Promise<"pane" | "session" | null> {
  const said = inKiko(env, server);
  if (!said || !here) return said;
  let ttys: string;
  try {
    ttys = await run(["list-panes", "-a", "-F", "#{pane_tty}"]);
  } catch (err) {
    return noServer(err) ? null : said;
  }
  return ttys.split("\n").some((tty) => tty && here(tty.trim())) ? said : null;
}
