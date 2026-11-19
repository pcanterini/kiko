// iTerm2, over AppleScript run by the helper app (platform/macos/apple-events.ts: macOS asks once
// whether Kiko may control iTerm). Sessions are found by their tty (../tty/: each session's `tty`,
// to the session process's own), typed into with `write text … newline false` (bytes written as if
// typed, to that session only, whichever tab or window is in front: nothing is selected or brought
// forward), then Enter on its own; keys are their bytes the same way (Escape is one ESC). Words
// with line breaks, or Codex's, go in as one bracketed paste. `screen` is the session's `contents`.
// New sessions open in a new window (the only script that brings iTerm forward).
//
// iTerm's `write text` goes to every session of the window while you have its Broadcast Input on
// (iTerm's own rule for anything typed there): Kiko can't see that setting.
import { log } from "../../core/log.ts";
import { appInstalled } from "../../core/terminal-apps.ts";
import { runAppleScript, type ScriptRunner } from "../../platform/macos/apple-events.ts";
import { VIEW_PHRASES } from "../views.ts";
import { TTY, ttyTerminal, type Sent, type Tab, type TtyApp, type TtyDeps } from "../tty/index.ts";
import { cwds, onTtys, proc, runningCheck, ttysOf } from "../tty/procs.ts";

const RUNNING = `if application "iTerm" is not running then return ""`;

/**
 * Lines that go through every session of every tab of every window, `body` run for each as `s` (an
 * iTerm object by its index, not an item of a list: `contents of s` is then iTerm's, the session's
 * text). `passOver`: a session whose properties can't be read (one iTerm is still making, a tmux
 * integration's with no tty) is passed over, for a listing; a send's errors are its own.
 */
const eachSession = (body: string, passOver = false) => `
    repeat with w in windows
      repeat with t in tabs of w
        repeat with k from 1 to (count of sessions of t)
          set s to session k of t
${
  passOver
    ? `          try
${body}
          end try`
    : body
}
        end repeat
      end repeat
    end repeat`;

// A session as a line: its id, tty and name. iTerm's `tab` class shadows AppleScript's tab
// constant, so character ids.
const LINE = `(id of s) & (character id 9) & (tty of s) & (character id 9) & (name of s)`;

// Every session: a line each.
export const LIST = `
on run argv
  ${RUNNING}
  set out to ""
  tell application "iTerm"
${eachSession(`            set out to out & ${LINE} & (character id 10)`, true)}
  end tell
  return out
end run`;

// One session (item 1: its id), the same way; "" when it's gone.
export const LOOK = `
on run argv
  ${RUNNING}
  tell application "iTerm"
${eachSession(`            if (id of s) is (item 1 of argv) then return ${LINE}`, true)}
  end tell
  return ""
end run`;

// Bytes (item 3) into the session with id item 1, only while its tty is still item 2 and its name
// has none of the agents lists' words (items 4…): checked and written in one script. As typed, no
// newline added; nothing selected or activated.
export const SEND = `
on run argv
  if application "iTerm" is not running then return "gone"
  tell application "iTerm"
${eachSession(`            if (id of s) is (item 1 of argv) then
              if (tty of s) is not (item 2 of argv) then return "changed"
              set shown to (name of s)
              repeat with i from 4 to (count of argv)
                if shown contains (item i of argv) then return "view"
              end repeat
              tell s to write text (item 3 of argv) newline false
              return "sent"
            end if`)}
  end tell
  return "gone"
end run`;

// What a session (item 1) shows now; a tab character first, so a gone one ("") isn't an empty screen.
export const SCREEN = `
on run argv
  ${RUNNING}
  tell application "iTerm"
${eachSession(`            if (id of s) is (item 1 of argv) then return (character id 9) & (contents of s)`)}
  end tell
  return ""
end run`;

// A new window with the default profile (the user's shell), the line typed into it, as show.ts
// opens Kiko's window. Its session's id back. The one script that brings iTerm forward.
export const OPEN = `
on run argv
  tell application "iTerm"
    set w to (create window with default profile)
    set s to current session of w
    tell s to write text (item 1 of argv)
    activate
    return id of s
  end tell
end run`;

/** A session's id as iTerm writes it (a UUID). */
export const SESSION_ID = /^[0-9A-Fa-f-]{8,64}$/;

/** LIST's (or LOOK's) lines as sessions: those with an id and a tty. */
export function parseSessions(out: string): Tab[] {
  return out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([id, tty]) => SESSION_ID.test(id ?? "") && TTY.test(tty ?? ""))
    .map(([id, tty, ...title]) => ({ id, tty, title: title.join(" ").trim() }));
}

/** SEND's answer. */
export function parseSent(out: string): Sent {
  const said = out.trim();
  if (said === "sent" || said === "gone") return { status: said };
  if (said === "changed") return { status: "changed" };
  if (said === "view") return { status: "changed", why: "its tab is showing Claude Code's agents list" };
  return { status: "failed", error: `unexpected answer: ${said.slice(0, 200)}` };
}

/** SCREEN's answer: the screen, each line without its trailing spaces; null when it's gone. */
export function parseScreen(out: string): string | null {
  if (!out.startsWith("\t")) return null;
  const lines = out
    .slice(1)
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export const ITERM: TtyApp = { id: "iterm", name: "iTerm", words: "then-enter", keys: true };

/** iTerm's real dependencies, its scripts run by `run`. */
export function itermDeps(run: ScriptRunner = runAppleScript): TtyDeps {
  return {
    list: () => run(LIST).then(parseSessions),
    look: async (id) => (SESSION_ID.test(id) ? (parseSessions(await run(LOOK, [id]))[0] ?? null) : null),
    send: async (tab, data) => {
      if (!SESSION_ID.test(tab.id) || !TTY.test(tab.tty)) return { status: "gone" };
      return parseSent(await run(SEND, [tab.id, tab.tty, data, ...VIEW_PHRASES]));
    },
    screen: async (id) => (SESSION_ID.test(id) ? parseScreen(await run(SCREEN, [id])) : null),
    open: async (cwd, line) => {
      const id = (await run(OPEN, [line])).trim();
      log("terminal_window", { via: "iterm", cwd, id });
      if (!SESSION_ID.test(id)) throw new Error(`iTerm didn't say which session it opened: ${id.slice(0, 200)}`);
      return id;
    },
    ttysOf,
    proc,
    onTtys,
    cwds,
    installed: () => appInstalled("iterm"),
    running: runningCheck("iTerm2"),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const iterm = ttyTerminal(ITERM, itermDeps());
