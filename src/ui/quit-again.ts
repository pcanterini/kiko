// How quitting Kiko is confirmed, wherever it's offered (the window's list, its menu's Quit…, the
// settings screen, the splash): the first q (or the menu's Quit…, or Ctrl+C) puts a hint on the
// keys' line, "Press q again to quit · your sessions keep running", and the same key again within
// QUIT_AGAIN_MS quits; y does too while the hint is up, and after Ctrl+C so does q. Any other key
// lets it go and does nothing else (the key that cancels isn't acted on), and so does the time
// running out, which clears the hint. Typing (a name, a project, a filter) never gets here: q is
// a letter there. Imports nothing: the menu's popup (src/terminals/tmux/menu-popup.ts) loads it.

/** How long the hint stays up: a second press within this quits. */
export const QUIT_AGAIN_MS = 2000;

/** What asked to quit first: q (or Q, or the menu's Quit…), or Ctrl+C. */
export type QuitBy = "q" | "ctrl-c";

/** The hint as said when there's room, then shorter and shorter: the first that fits `width` (the last cut if none does). */
function hints(by: QuitBy): string[] {
  const k = by === "q" ? "q" : "Ctrl+C";
  return [
    `Press ${k} again to quit · your sessions keep running`,
    `Press ${k} again to quit · sessions keep running`,
    `${k} again to quit · sessions keep running`,
    `Press ${k} again to quit`,
    `${k} again quits`,
  ];
}

/** The hint in full: "Press q again to quit · your sessions keep running". */
export const quitHint = (by: QuitBy = "q") => hints(by)[0];

/** The hint for a line `width` columns wide: the longest of its forms that fits (the shortest when none does). */
export function quitHintFor(by: QuitBy, width: number): string {
  const all = hints(by);
  return all.find((h) => h.length <= width) ?? all[all.length - 1];
}

/**
 * Whether a key quits while the hint is up: q or Q, y or Y, or Ctrl+C after Ctrl+C. Ctrl+C after q
 * doesn't (it's another key: it cancels). `ctrl`: Ctrl held with `input` ("c" for Ctrl+C, as Ink
 * gives it); a raw key (the menu's) is "\x03" for Ctrl+C.
 */
export function quitsAgain(by: QuitBy, input: string, ctrl = false): boolean {
  const ctrlC = (ctrl && input === "c") || input === "\x03";
  if (ctrlC) return by === "ctrl-c";
  return !ctrl && ["q", "Q", "y", "Y"].includes(input);
}

/** Whether a hint put up at `at` is still up at `now`. */
export const stillAsking = (at: number, now: number, ms = QUIT_AGAIN_MS) => now - at < ms;
