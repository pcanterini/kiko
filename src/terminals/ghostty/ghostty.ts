// Ghostty over AppleScript, run by the helper app (platform/macos/apple-events.ts), so macOS asks
// whether Kiko may control Ghostty, not whichever terminal `kiko` was started from.
import { execFile } from "node:child_process";
import { appEnv } from "../../core/env.ts";
import { log } from "../../core/log.ts";
import { runAppleScript } from "../../platform/macos/apple-events.ts";
import { appInstalled } from "../../core/terminal-apps.ts";

const run = (script: string, args: string[] = []) => runAppleScript(script, args);

/** A Ghostty terminal (a window or a tab): sessions are matched to these by title and folder. */
export type TerminalWindow = { id: string; title: string; cwd: string };

// Set KIKO_GHOSTTY_DRY_RUN=1 to log input instead of sending it (for testing without touching real sessions).
const DRY_RUN = appEnv("GHOSTTY_DRY_RUN") === "1";

// Ghostty's dictionary has a `tab` class that shadows AppleScript's tab constant, so use character ids.
const LIST = `
tell application "Ghostty"
  set out to ""
  repeat with t in terminals
    set out to out & (id of t) & (character id 9) & (name of t) & (character id 9) & (working directory of t) & (character id 10)
  end repeat
  return out
end tell`;

// Text and ids arrive as argv, never spliced into the script source.
const INPUT = `
on run argv
  tell application "Ghostty"
    set t to first terminal whose id is (item 1 of argv)
    input text (item 2 of argv) to t
    send key "enter" to t
  end tell
end run`;

const KEY = `
on run argv
  tell application "Ghostty"
    send key (item 2 of argv) to (first terminal whose id is (item 1 of argv))
  end tell
end run`;

// A new window running the user's shell, with a command typed in as if by hand.
const NEW_WINDOW = `
on run argv
  tell application "Ghostty"
    new window with configuration {initial working directory:(item 1 of argv), initial input:(item 2 of argv)}
    activate
  end tell
end run`;

// A new window running a program instead of the shell (Ghostty 1.3's `command`): nothing typed in,
// and the window closes when the program ends. For showing a tmux session (../tmux/show.ts).
const RUN_WINDOW = `
on run argv
  tell application "Ghostty"
    new window with configuration {initial working directory:(item 1 of argv), command:(item 2 of argv)}
    activate
  end tell
end run`;

// The listing under way: one at a time (a prompt of macOS's waiting on you holds it), shared by
// whoever asks meanwhile.
let listing: Promise<TerminalWindow[]> | null = null;

export function listTerminals(): Promise<TerminalWindow[]> {
  listing ??= run(LIST)
    .then((stdout) =>
      stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, title, cwd] = line.split("\t");
          return { id, title: title ?? "", cwd: cwd ?? "" };
        }),
    )
    .finally(() => (listing = null));
  return listing;
}

/** Types text into a terminal as if pasted, then presses Enter. */
export async function typeText(terminalId: string, text: string) {
  log("terminal_type", { via: "ghostty", id: terminalId, text, dryRun: DRY_RUN });
  if (DRY_RUN) return;
  await run(INPUT, [terminalId, text]);
}

/** Sends one key press, e.g. "escape" to interrupt Claude Code. */
export async function sendKey(terminalId: string, key: string) {
  log("terminal_key", { via: "ghostty", id: terminalId, key, dryRun: DRY_RUN });
  if (DRY_RUN) return;
  await run(KEY, [terminalId, key]);
}

/** Opens a new Ghostty window in `cwd` and runs `command` in its shell (Enter included). */
export async function openWindow(cwd: string, command: string) {
  log("terminal_open", { via: "ghostty", cwd, command, dryRun: DRY_RUN });
  if (DRY_RUN) return;
  await run(NEW_WINDOW, [cwd, `${command}\n`]);
}

/** Opens a new Ghostty window in `cwd` running `command` (a shell command line) instead of the shell. */
export async function runWindow(cwd: string, command: string) {
  log("terminal_window", { via: "ghostty", cwd, command, dryRun: DRY_RUN });
  if (DRY_RUN) return;
  await run(RUN_WINDOW, [cwd, command]);
}

/** Whether Ghostty is installed, in /Applications or ~/Applications. */
export const ghosttyInstalled = () => appInstalled("ghostty");

/**
 * Whether Ghostty is running, by its process's name (no Apple Events: `tell application "Ghostty"`
 * would start it, and ask whether Kiko may control it). Asked at most every few seconds.
 */
let running: { at: number; is: Promise<boolean> } | null = null;
export function ghosttyRunning(maxAgeMs = 5000): Promise<boolean> {
  if (!running || Date.now() - running.at > maxAgeMs) {
    running = {
      at: Date.now(),
      is: new Promise((resolve) => execFile("pgrep", ["-xq", "ghostty"], { timeout: 5000 }, (err) => resolve(!err))),
    };
  }
  return running.is;
}
