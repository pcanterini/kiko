// Terminal.app, over AppleScript run by the helper app (platform/macos/apple-events.ts: macOS asks
// once whether Kiko may control Terminal). Its tabs are found by their tty (../tty/: each tab's
// `tty`, to the session process's own); a tab is known by its tty, which no other open tab has.
//
// Words go in with `do script … in` the tab: written to that tab only, whichever tab or window is
// in front (nothing is selected or brought forward), always followed by Terminal's own Return,
// which it can't leave out. So they go in as one bracketed paste (Claude Code and Codex both ask
// for those), and that Return after it is Enter: it sends them. No keys: Terminal has no way to
// send one without that Return after it (Escape and Enter would interrupt, then send your draft),
// and System Events' keystrokes would need it in front, and Accessibility. So Interrupt isn't
// offered for a session in Terminal (core/can.ts), unless its agent does it itself (Codex).
// `screen` is the tab's `contents`. New sessions open in a new window (the only script that
// brings Terminal forward).
import { log } from "../../core/log.ts";
import { runAppleScript, type ScriptRunner } from "../../platform/macos/apple-events.ts";
import { TTY, ttyTerminal, type Sent, type Tab, type TtyApp, type TtyDeps } from "../tty/index.ts";
import { cwds, onTtys, proc, runningCheck, ttysOf } from "../tty/procs.ts";

/**
 * Lines that go through every tab of every window, `body` run for each as `t` (`tab k of w`: a
 * Terminal object by its index, not an item of a list). A window with no tabs (its Settings) is
 * passed over. The tab's text is asked as `contents of tab k of w`, never of a variable: Terminal's
 * `contents` is AppleScript's own word for what a variable refers to.
 */
const eachTab = (body: string) => `
    repeat with w in windows
      set n to 0
      try
        set n to (count of tabs of w)
      end try
      repeat with k from 1 to n
        set t to tab k of w
${body}
      end repeat
    end repeat`;

// Every tab's tty, a line each.
export const LIST = `
on run argv
  if application "Terminal" is not running then return ""
  set out to ""
  tell application "Terminal"
${eachTab(`        try
          set out to out & (tty of t) & (character id 10)
        end try`)}
  end tell
  return out
end run`;

// Text (item 2) into the tab whose tty is item 1, with Terminal's Return after it; nothing selected or activated.
export const SEND = `
on run argv
  if application "Terminal" is not running then return "gone"
  tell application "Terminal"
${eachTab(`        if (tty of t) is (item 1 of argv) then
          do script (item 2 of argv) in t
          return "sent"
        end if`)}
  end tell
  return "gone"
end run`;

// What the tab with tty item 1 shows now; a tab character first, so a gone one ("") isn't an empty screen.
export const SCREEN = `
on run argv
  if application "Terminal" is not running then return ""
  tell application "Terminal"
${eachTab(`        if (tty of t) is (item 1 of argv) then return (character id 9) & (contents of tab k of w)`)}
  end tell
  return ""
end run`;

// A new window running the user's shell with the line typed in (as show.ts opens Kiko's window), its
// tty back. Terminal started by this opens its own first window too: the line goes in that one.
// The one script that brings Terminal forward.
export const OPEN = `
on run argv
  set wasRunning to application "Terminal" is running
  tell application "Terminal"
    if wasRunning then
      set t to do script (item 1 of argv)
    else
      activate
      delay 0.5
      try
        set t to do script (item 1 of argv) in window 1
      on error
        set t to do script (item 1 of argv)
      end try
    end if
    activate
    return tty of t
  end tell
end run`;

/** LIST's lines as tabs: each known by its tty. */
export function parseTabs(out: string): Tab[] {
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((tty) => TTY.test(tty))
    .map((tty) => ({ id: tty, tty, title: "" }));
}

/** SEND's answer. */
export function parseSent(out: string): Sent {
  const said = out.trim();
  if (said === "sent" || said === "gone") return { status: said };
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

export const TERMINAL_APP: TtyApp = { id: "terminal", name: "Terminal", words: "with-return", keys: false };

/** Terminal's real dependencies, its scripts run by `run`. */
export function terminalDeps(run: ScriptRunner = runAppleScript): TtyDeps {
  return {
    list: () => run(LIST).then(parseTabs),
    look: async (tty) => (TTY.test(tty) ? (parseTabs(await run(LIST)).find((t) => t.tty === tty) ?? null) : null),
    send: async (tab, data) => (TTY.test(tab.tty) ? parseSent(await run(SEND, [tab.tty, data])) : { status: "gone" }),
    screen: async (tty) => (TTY.test(tty) ? parseScreen(await run(SCREEN, [tty])) : null),
    open: async (cwd, line) => {
      const tty = (await run(OPEN, [line])).trim();
      log("terminal_window", { via: "terminal-app", cwd, tty });
      if (!TTY.test(tty)) throw new Error(`Terminal didn't say which tab it opened: ${tty.slice(0, 200)}`);
      return tty;
    },
    ttysOf,
    proc,
    onTtys,
    cwds,
    // Terminal is macOS's own: always there.
    installed: () => true,
    running: runningCheck("Terminal"),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const terminalApp = ttyTerminal(TERMINAL_APP, terminalDeps());
