// The Kiko window's classic look (tmux 3.8 and later): the look of the old full-screen UI (gone
// with `--no-tmux`), drawn by tmux. Its panels are floating panes, each a box of its own: four sides,
// its title on the top edge, its border lighter while it has the keyboard. The list (on the left)
// and the stage sit side by side over one ordinary pane, the frame (./frame-pane.ts), which paints the
// window's one line, its last (no header: the boxes start on the first), and puts the boxes back
// in place when the window resizes. While you dictate, a third box with a red border shows your
// words over the bottom of the window (the caption): a floating pane too, which never takes the keyboard.
//
//   ┌── Sessions ──────────┐┌── ✻  pixie ──────────────────────────────────────────────────┐
//   │ 0 ►    Kiko          ││ the real Claude Code, in its own pane                        │
//   │ 1   ✻  pixie         ││                                                              │
//   └──────────────────────┘└──────────────────────────────────────────────────────────────┘
//    ready · ⚠ lacy needs you      george (Pocket) · Haiku · $0.000      . repeat · q quit · ⌃Space menu
//
// Accepted limits: square corners (tmux draws a pane's border with its lines, no rounded ones),
// the titles on the top border, no padding inside the stage (it's the session's own screen).
// Older tmux has no floating panes: the window keeps its tiled look, unchanged (two panes side by
// side, the bottom line in the status line: ./window.ts).
//
// Here: whether this tmux can (asked once), where the boxes go for a window's size, and the look's
// colours. Imports nothing that loads .env (the CLI and the frame program use it).
import { envVar, SLUG } from "../../core/name.ts";
import { appOption } from "./tmux.ts";

/** Window: CLASSIC when the window has the classic look (set as it's made, or made over); unset, the tiled one. */
export const LOOK = appOption("look");
export const CLASSIC = "classic";
/** Window: where the bottom line's menu words start (cells from the left, the frame's: src/ui/classic.ts frameLines); a click from there on opens the menu. */
export const MENU_AT = appOption("menu-at");
/** Global: the app's frame socket (src/ui/window-frame.ts), which the frame and the caption connect to. */
export const FRAME_SOCKET = appOption("frame-socket");
/** A caption's pane title, given as it's made (tmux's -T): it's known for a caption from its first moment, before its role is set. */
export const CAPTION_TITLE = `${SLUG}:caption`;

// The colours (the user's, picked from the preview's: branch look-preview). Two for the borders:
// the panel with the keyboard, the other. Titles bold, light while focused, dimmer when not.
export const FOCUS_BORDER = "#4d5577";
export const REST_BORDER = "#44475a";
export const TITLE = "#f8f8f2";
export const TITLE_REST = "#8d91a8";
/** The caption's border: the full screen's caption was red, as the listening badge is. */
export const CAPTION_BORDER = "red";

/** `tmux -V`'s answer read as major and minor ("tmux 3.8", "tmux 3.8a", "tmux next-3.9"); null when it isn't one. */
export function parseVersion(out: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Whether a tmux this version has floating panes (3.8 and later). */
export const floats = (v: { major: number; minor: number } | null) => Boolean(v && (v.major > 3 || (v.major === 3 && v.minor >= 8)));

/** A tmux runner (./window.ts Tmux). */
type Run = (args: string[]) => Promise<string>;
const asked = new WeakMap<Run, Promise<boolean>>();

/**
 * Whether a window made now gets the classic look: this tmux has floating panes (`-V`, asked once
 * for each runner), unless KIKO_LOOK=tiled asks for the old look. A tmux that doesn't answer is
 * taken for one that can't. A window that's there keeps its look until it's made again (or made
 * over by a `kiko` whose tmux can: window.ts openWindow).
 */
export function classicLook(tmux: Run): Promise<boolean> {
  if (envVar("LOOK") === "tiled") return Promise.resolve(false);
  let answer = asked.get(tmux);
  if (!answer) {
    answer = tmux(["-V"]).then(
      (out) => floats(parseVersion(out)),
      () => false,
    );
    asked.set(tmux, answer);
  }
  return answer;
}

/** Where a box goes, its border included: its top left corner (columns and lines from the window's), its width and height. */
export type Box = { x: number; y: number; w: number; h: number };

/** The narrowest list a drag can leave. */
const MIN_LIST = 18;

/** The window's lines the boxes leave to the frame: its last, the bottom line (none at the top: no header). */
const BOTTOM_LINES = 1;

/**
 * The boxes for a window this size: the list as the full screen sizes its sessions panel (30% of
 * the width, 26 to 40 columns), or as you last dragged it (`dragged`: 18 columns to half the
 * window); the stage the rest. Both from the window's first line to the one above the bottom line.
 */
export function boxes(cols: number, rows: number, dragged = 0): { list: Box; stage: Box } {
  const listW = dragged > 0 ? Math.max(MIN_LIST, Math.min(Math.floor(cols / 2), dragged)) : Math.max(26, Math.min(40, Math.floor(cols * 0.3)));
  const h = Math.max(4, rows - BOTTOM_LINES);
  return { list: { x: 0, y: 0, w: listW, h }, stage: { x: listW, y: 0, w: Math.max(10, cols - listW), h } };
}

// boxes() for a dragged list as tmux formats, for the window they're expanded in (a hook's: the
// window's own width and height), so tmux can place the boxes itself as a drag goes (window.ts
// splitHook), with no program asked: the same numbers as boxes(), the frame's.
const HALF = "#{e|/:#{window_width},2}";
const BOX_H = `#{?#{e|<:#{window_height},${4 + BOTTOM_LINES}},4,#{e|-:#{window_height},${BOTTOM_LINES}}}`;

/** The list's box width boxes() gives for a list dragged to `raw` columns (a format), as a format: MIN_LIST to half the window. */
export function draggedFormat(raw: string): string {
  const upTo = `#{?#{e|>:${raw},${HALF}},${HALF},${raw}}`;
  return `#{?#{e|<:${upTo},${MIN_LIST}},${MIN_LIST},${upTo}}`;
}

/**
 * placeCommands for the list and the stage (`list`, `stage`: their pane IDs, or formats for them)
 * with the list's box `listW` columns wide (a format, as draggedFormat gives), as formats: one
 * command line to expand and run (run-shell -C).
 */
export function placeFormat(list: string, stage: string, listW: string): string {
  const rest = `#{e|-:#{window_width},${listW}}`;
  const stageW = `#{?#{e|<:${rest},10},10,${rest}}`;
  return [`resize-pane -t ${list} -x ${listW} -y ${BOX_H}`, `move-pane -t ${list} -X 0 -Y 0`, `move-pane -t ${stage} -X ${listW} -Y 0`, `resize-pane -t ${stage} -x ${stageW} -y ${BOX_H}`].join(" ; ");
}

/** The caption's width for a window this wide, its border included: two thirds of it, at least 40 columns, never past it (the full screen's). */
export const captionWidth = (cols: number) => Math.min(cols - 4, Math.max(40, Math.round((cols * 2) / 3)));

/** The caption's box for `lines` lines of words: centred, its bottom edge on the line just above the boxes' bottom edge (as the full screen had it). */
export function captionBox(cols: number, rows: number, lines: number): Box {
  const w = captionWidth(cols);
  const h = Math.max(1, lines) + 2;
  const { list } = boxes(cols, rows);
  const boxesBottom = list.y + list.h - 1; // the boxes' bottom border's line
  return { x: Math.max(0, Math.floor((cols - w) / 2)), y: Math.max(list.y, boxesBottom - h), w, h };
}

/** A floating pane's place and size, as new-pane takes them. */
export const geometry = (b: Box) => ["-x", String(b.w), "-y", String(b.h), "-X", String(b.x), "-Y", String(b.y)];

/**
 * The commands that put the boxes (by pane ID) where they go: each shrunk and moved before the
 * other grows, so neither is pushed off the window on the way (tmux keeps a floating pane inside it).
 * `caption`: its pane and how many lines it shows now.
 */
export function placeCommands(panes: { list?: string | null; stage?: string | null; caption?: { id: string; lines: number } | null }, cols: number, rows: number, dragged = 0): string[][] {
  const b = boxes(cols, rows, dragged);
  const out: string[][] = [];
  if (panes.list) out.push(["resize-pane", "-t", panes.list, "-x", String(b.list.w), "-y", String(b.list.h)], ["move-pane", "-t", panes.list, "-X", String(b.list.x), "-Y", String(b.list.y)]);
  if (panes.stage) out.push(["move-pane", "-t", panes.stage, "-X", String(b.stage.x), "-Y", String(b.stage.y)], ["resize-pane", "-t", panes.stage, "-x", String(b.stage.w), "-y", String(b.stage.h)]);
  if (panes.caption) out.push(...captionCommands(panes.caption.id, captionBox(cols, rows, panes.caption.lines)));
  return out;
}

/** The caption (its pane) to its box. */
export const captionCommands = (pane: string, b: Box) => [
  ["resize-pane", "-t", pane, "-x", String(b.w), "-y", String(b.h)],
  ["move-pane", "-t", pane, "-X", String(b.x), "-Y", String(b.y)],
];
