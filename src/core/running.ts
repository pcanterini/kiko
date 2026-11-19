// One Kiko app at a time. It listens on the hooks socket (agents/claude-code/hooks.ts), so
// something answering there is a running app: start.ts asks before starting the app in the Kiko
// window, and waits instead. And the app takes a lock first thing, so two started at the same
// moment can't both run. Nor beside the other flavour (the release beside Kiko Dev, or Kiko
// Dev beside the release: core/name.ts): `otherRunning`, asked by `kiko` and the app before they
// start, since both want the talk key and the mic. Imports nothing that loads .env, reads settings or writes logs.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { alive } from "./alive.ts";
import { CONFIG_FOLDER, envVar, type FlavourNames, OTHER, SOCKET_PATH, TITLE } from "./name.ts";

/** The app's exit code that tells start.ts to start it again (a setting that needs a restart changed). */
export const RESTART_EXIT = 76;
/** The app's exit code that tells start.ts to start the version installed since (core/updates/) in place of this one. */
export const UPDATE_EXIT = 77;
/**
 * The app's exit code when there's no model key (and setup's, left without one): start.ts asks for
 * the key in the window then, rather than the window closing on a line nobody sees.
 */
export const NO_KEY_EXIT = 78;
/** The app's exit code when it stopped before starting and said why (another app running, the lock held): start.ts keeps the window open on it. */
export const SAID_EXIT = 79;

/**
 * What start.ts does once the app has ended, by its exit code: start it again (RESTART_EXIT), start
 * the version installed since (UPDATE_EXIT), ask for the key in the window (NO_KEY_EXIT), keep the
 * window open on what it said (SAID_EXIT), close the window (quit: 0), or leave the pane as it
 * ended (a crash: what was printed stays, with "stopped" under it).
 */
type AfterApp = "restart" | "update" | "ask-key" | "keep-open" | "close" | "leave";
export function afterApp(status: number | null): AfterApp {
  if (status === RESTART_EXIT) return "restart";
  if (status === UPDATE_EXIT) return "update";
  if (status === NO_KEY_EXIT) return "ask-key";
  if (status === SAID_EXIT) return "keep-open";
  return status === 0 ? "close" : "leave";
}

/** Said under what the app said when the window stays open on it (afterApp "keep-open"). */
export const CLOSE_HINT = "Press Enter to close.";

/** The hooks socket: KIKO_SOCKET, else /tmp/kiko.sock (as hooks.ts has it). */
export const appSocket = () => envVar("SOCKET") ?? SOCKET_PATH;

/** Something answers on `path` (a socket file left by an app that crashed doesn't). */
export function answers(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

/** The Kiko app is running (anywhere: the Kiko window, or one started some other way). */
export const appRunning = () => answers(appSocket());

/** A lock with no start time (ps couldn't say) younger than this, whose process is alive, is an app still starting. */
const STARTING_MS = 60_000;
/** A takeover older than this was left by an app that crashed taking over: given up. */
const BREAKING_MS = 10_000;

/**
 * Where the lock is: in a folder only you can open, ~/.config/kiko/run/ (never in /tmp, where
 * anyone can make or remove files); next to the socket when KIKO_SOCKET sets one (the tests,
 * the harness), so each has its own.
 */
export function lockPath(socket = appSocket()): string {
  return envVar("SOCKET") ? `${socket}.lock` : join(homedir(), ".config", CONFIG_FOLDER, "run", "app.lock");
}

/**
 * The other flavour, when it's running (`other`: its names; `home`: where its config folder is): its
 * lock held by a live app (`holder`: looked at first, so a lock that settles it never needs the
 * socket), else something answering on its socket. Not asked with KIKO_SOCKET set: the tests and
 * the harness run an app of their own, beside whichever of yours.
 */
export async function otherRunning(other: FlavourNames = OTHER, home = homedir()): Promise<boolean> {
  if (envVar("SOCKET")) return false;
  if (await holder(join(home, ".config", other.configFolder, "run", "app.lock"), other.socket)) return true;
  return answers(other.socket);
}

/** Another app that mustn't run beside this one, when one does: the other flavour. Null when none is. */
export async function whoElseRuns(home = homedir()): Promise<FlavourNames | null> {
  return (await otherRunning(OTHER, home)) ? OTHER : null;
}

/** What the app says when another app of this flavour holds the lock (process `pid`), before it stops (SAID_EXIT). */
export const lockHeldWords = (pid: number) => `${TITLE} is already running (process ${pid}). Only one can run: it's the one that hears you.`;

/** What's said when it is, and nothing starts: "Kiko (the release) is running; quit it first." */
export const otherRunningWords = (other: FlavourNames = OTHER) =>
  `${other.title} (${other.flavour === "release" ? "the release" : "the checkout"}) is running; quit it first (q in its window). Only one runs at a time: both want the talk key and the mic.`;

/**
 * When process `pid` started, as `ps -o lstart=` says it ("Thu Oct 29 11:35:01 2026"; the C
 * locale, so it reads the same from any app): with its pid, which process it is, even once the
 * pid is reused. Null when there's no such process.
 */
export function startedAt(pid: number): Promise<string | null> {
  return new Promise((resolve) =>
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { PATH: process.env.PATH ?? "/bin:/usr/bin", LC_ALL: "C" }, timeout: 3000 }, (err, out) => resolve(err ? null : out.trim() || null)),
  );
}

/**
 * Who holds the lock at `path`: a live app's pid; null when it's stale; undefined when there's
 * none (gone meanwhile). It holds the app's pid and when that process started: the same process
 * still running (the pid alive, started then) holds it, whatever the socket says (an app slow to
 * answer, or not listening yet, is still the one app); anything else (gone, the pid reused since)
 * is stale. A lock with no start time (ps couldn't say when it started): its pid alive, and something answering
 * on the socket or the lock under a minute old.
 */
async function holder(path: string, socket: string): Promise<number | null | undefined> {
  let pid = 0;
  let started = "";
  let age = Infinity;
  try {
    const text = readFileSync(path, "utf8").trim();
    const [first, ...rest] = text.split("\n");
    pid = Number(first) || 0;
    started = rest.join(" ").trim();
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  if (!pid || pid === process.pid || !alive(pid)) return null;
  if (started) return (await startedAt(pid)) === started ? pid : null;
  return (await answers(socket)) || age < STARTING_MS ? pid : null;
}

/**
 * The app's lock, taken first thing (before the screen, the mic or the hotkey): created only if it
 * isn't there, whole, in one atomic step (`create`), holding the app's pid and when it started
 * (`holder`). So two apps started at the same moment
 * (two `kiko`s in two terminals, say) can't both get past it, which the socket alone can't
 * promise (it's only listened on once the app is well under way). One left by an app that's gone
 * (`holder`) is taken over, by one starter at a time: whoever makes the takeover folder (also
 * created only if absent) looks again and removes it, then all try to create it as before, and only
 * one can. (Without that, two starters could each find it stale, one remove it and take it, and the
 * other remove that one's: both ran.) `heldBy`: another app holds it, this pid.
 */
export async function takeLock(socket = appSocket(), path = lockPath(socket)): Promise<{ release(): void } | { heldBy: number }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const breaking = `${path}.breaking`;
  const me = `${process.pid}\n${(await startedAt(process.pid)) ?? ""}\n`;
  for (let tries = 0; ; tries++) {
    if (create(path, me)) {
      return {
        release() {
          try {
            if (readFileSync(path, "utf8").split("\n")[0].trim() === String(process.pid)) unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    }
    if (tries > 200) throw Object.assign(new Error(`can't take the lock ${path}`), { code: "EEXIST" });
    const held = await holder(path, socket);
    if (held) return { heldBy: held };
    if (held === undefined) continue; // gone meanwhile: try again
    try {
      mkdirSync(breaking, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another is taking it over: in a moment it's theirs (or stale again, if they crashed doing it).
      if (Date.now() - (statSync(breaking, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > BREAKING_MS) rmSync(breaking, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
      continue;
    }
    try {
      if ((await holder(path, socket)) === null) rmSync(path, { force: true });
    } finally {
      rmSync(breaking, { recursive: true, force: true });
    }
  }
}

/**
 * Makes the lock at `path` holding `me`, only if there's none: written whole to a file of its own,
 * then linked in place (link, like O_EXCL, fails when the name is taken), so no one ever reads it
 * half written. A lock made empty and written after (writeFileSync's "wx") could be read in between
 * by a starter taking over a stale one, taken as stale too and removed: two apps ran (the race seen
 * in running.test.ts, 2026-10-29). False when there's one already.
 */
function create(path: string, me: string): boolean {
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(mine, me, { flag: "wx", mode: 0o600 });
  try {
    linkSync(mine, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    unlinkSync(mine);
  }
}
