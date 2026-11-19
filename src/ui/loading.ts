// What the Kiko window's list pane shows while the app starts: drawn by src/start.ts before it
// starts the app (and again before each restart), so the pane never shows whatever happens to be
// there. The app draws on a screen of its own over it (Ink's alternate screen: src/ui/tui.ts) and
// leaves it as it was when it stops. The other side, the session area, says it too: its placeholder
// (src/terminals/tmux/placeholder.sh), with what the app is doing (window.ts setStarting).
//
//   ┌── Sessions ───────┐┌── starting ───────────────────────────┐
//   │ Starting…         ││                                        │
//   │                   ││  Kiko Dev is starting…                 │
//   │                   ││  Connecting to sessions…               │
//
// Imports nothing: start.ts runs before anything else is loaded.

/** Where a row's text starts in the list's pane (window-list.ts): in line with the pane's name on the border bar above it, or a column in from the classic look's box. */
export const LIST_INDENT = { tiled: 2, classic: 1 } as const;

const ESC = "\x1b[";
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

/**
 * The list pane's screen while the app starts: cleared, "Starting…" dimmed where the list's first
 * row goes (the classic look's box is titled "Sessions" by tmux; the tiled look's border names the
 * app), and `note` under it if there's one (Kiko Dev's first start: what it copied). The cursor
 * hidden, and left two rows below, so anything said next (the app can stop before it starts: another
 * one runs) comes under it, not over it.
 */
export function startingScreen(look: "tiled" | "classic", note = ""): string {
  const pad = " ".repeat(LIST_INDENT[look]);
  const lines = [`${pad}${DIM}Starting…${RESET}`, ...(note ? ["", ...note.split("\n").map((l) => `${pad}${DIM}${l}${RESET}`)] : [])];
  return `${ESC}?25l${ESC}H${ESC}2J${lines.join("\r\n")}\r\n\r\n`;
}

/** The starting line taken back (the app stopped with something to say, which stays under it), the cursor shown again. Where the cursor is, stays. */
export const startingGone = `\x1b7${ESC}1;1H${ESC}2K\x1b8${ESC}?25h`;

/** The cursor shown again (the app, or setup, takes the pane from here). */
export const CURSOR_ON = `${ESC}?25h`;

/**
 * What start.ts writes before keeping the window open on what the app said (it stopped before
 * starting: another app, the lock): "Starting…" taken back when it's above the words (`startingShown`:
 * startingScreen drawn), the cursor shown again either way. Not after the splash, which never drew
 * it: the app cleared the screen for its words (ui/splash-handoff.ts "clear"), and they start on its
 * top row, where "Starting…" would be (taking that row back lost their first line: 2026-11-04).
 */
export const beforeSaidKept = (startingShown: boolean) => (startingShown ? startingGone : CURSOR_ON);
