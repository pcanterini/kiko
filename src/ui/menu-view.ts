// The Kiko window's menus (the Kiko key's, a session's right-click one), drawn in a tmux popup by
// a small program of their own (src/terminals/tmux/menu-popup.ts); this is only the drawing and what a
// key or a click picks, so the tests drive it. Why a popup and not tmux's own display-menu: tmux
// 3.8 draws a pane's output over a menu (a session scrolling, Claude Code's spinner erasing its
// line) and never draws the menu again, so it went half blank while it was still taking keys; a
// popup's program owns its cells, which tmux keeps clear of the panes under it.
//
// Everything in it is plain text drawn here, never a tmux format: a session's name can't run or
// style anything. A normal menu: ↑ ↓ move the highlight (over the items that do something, round
// the ends), Enter or Space picks it, each item's key picks it at once (as display-menu's do), a
// click picks the line, Escape closes it. The Kiko key again (`again`: what the terminal sends
// for it) closes it too, and passes the key on to the session shown when the menu says how (as
// tmux's prefix pressed twice does). An item that asks first (Close) turns the menu into its
// question, with [ Yes ] and [ No ] under it: y or a click on Yes does it, any other key or a
// click anywhere else goes back. One that wants its key again (`twice`: Quit…) puts
// its hint up in place of the menu ("Press q again to quit · your sessions keep running"): its key
// again (or y) within QUIT_AGAIN_MS does it, anything else goes back, and so does the time running
// out (the popup draws the menu again then: againUntil, lapse).
//
// A checklist (a menu with `submit`: the first-run card's agents, src/ui/agents-card.ts): its items
// with `check` are ticked or not ([x] / [ ]), Space (or the item's key, or a click) ticks or unticks
// the one chosen, ↑ ↓ move, and Enter runs each ticked item's commands, then `submit`'s. Any menu's
// `closed`: the commands run when it closes without a pick (Escape, Ctrl+C, the Kiko key again),
// so the app knows it was let go.
//
// A menu with `search` (the Kiko key's): `/` starts a search. A search line at the top (`/ ro▏`),
// and from then on what's typed is the search, never an item's key; Backspace edits it (with nothing
// left, it ends the search). The list narrows to what matches, best first (searchScore, then the
// menu's own order): the menu's items (and `search.also`'s, listed nowhere else), then under a line
// of their own `search.apart`'s (settings). ↑ ↓ move, Enter picks one (what that item runs, its
// question first if it has one), Escape ends the search (the whole menu again; Escape again closes).
import { plainText } from "../core/text.ts";
import { QUIT_AGAIN_MS } from "./quit-again.ts";

/** How an item's words look: as they are, dim (a hint), the accent, red (needs you), yellow (waits). */
export type Tone = "plain" | "dim" | "accent" | "red" | "yellow";

/**
 * One line of a menu: its words (`label`, then `note` after it, in `noteTone`), its key as shown
 * (`key`) and the input that picks it (`input`: what the terminal sends for that key), the tmux
 * commands it runs (`run`), and a question to ask first (`confirm`), or a hint to press its key
 * again (`twice`: its key or y within QUIT_AGAIN_MS runs it). Without `run`: shown, never
 * picked. `rule`: a separator with the label in it, heading the lines under it (`─ lacy ────`).
 * `byFocus`: its words by which side has the keyboard when the menu opens (the list, or the
 * session side: `stage`), put in `label` by `forFocus`; `label` stays when that can't be told.
 * `mark`: an agent's mark before the words (src/ui/marks.ts: a one-cell glyph, in its hex colour), in
 * a slot of MARK_SLOT cells as the lists draw it.
 * `find`: the words a search (`/`) looks in, best first (a session's name, folder, Claude's title);
 * without it, its label.
 * "-": a plain separator.
 */
export type MenuEntry =
  | {
      label: string;
      byFocus?: ByFocus;
      tone?: Tone;
      note?: string;
      noteTone?: Tone;
      key?: string;
      input?: string[];
      run?: string[][];
      confirm?: string;
      twice?: string;
      rule?: boolean;
      check?: boolean;
      mark?: { glyph: string; color?: string };
      find?: string[];
    }
  | "-";
export type ByFocus = { list: string; stage: string };

/** A menu as it opens: each item's words for the side that has the keyboard (`list`: true for the list, false the session side, null not known: as they are). */
export function forFocus(menu: MenuData, list: boolean | null): MenuData {
  if (list === null) return menu;
  return { ...menu, items: menu.items.map((i) => (i === "-" || !i.byFocus ? i : { ...i, label: list ? i.byFocus.list : i.byFocus.stage })) };
}

/**
 * A menu: its title (on the popup's border), its lines, the line chosen to start with, and the
 * Kiko key pressed again in it (`again`): what the terminal sends for that key (keys.ts
 * keySequences), and the tmux commands that pass it on (none: it only closes the menu). `submit`:
 * it's a checklist, and these run on Enter after the ticked items' own (see the top). `closed`: run
 * when it closes without a pick. `search`: `/` searches it (see the top): its items, and `also`'s
 * with them (never listed: the pages past the ones it lists), and `apart`'s in a group of their
 * own under them (never listed: "Settings → Voice").
 */
export type MenuData = {
  title: string;
  items: MenuEntry[];
  selected?: number;
  again?: { input: string[]; run?: string[][] };
  submit?: string[][];
  closed?: string[][];
  search?: { also?: MenuEntry[]; apart?: MenuEntry[] };
};

/** What a key or a click does: nothing (the menu drawn again: the highlight may have moved), close the menu, or run these tmux commands (then close). */
export type Picked = { kind: "none" } | { kind: "close" } | { kind: "run"; commands: string[][] };

const UP = ["\x1b[A", "\x1bOA"];
const DOWN = ["\x1b[B", "\x1bOB"];

/**
 * A key as the menu reads it: one a terminal sends in the CSI u form (extended keys: "ESC [ 9 u"
 * for Tab, 13 Enter, 27 Escape, 32 Space; any other letter or digit too), as its plain character,
 * so it works whichever way the terminal (and tmux) send it. Ctrl still held from Ctrl+Space
 * ("ESC [ 9 ; 5 u", Ctrl+Tab) counts as the key alone; Ctrl+Space again is Ctrl+Space (closes).
 */
function plainKey(data: string): string {
  const m = /^\x1b\[(\d+)(?:;(\d+))?u$/.exec(data);
  if (!m) return data;
  const code = Number(m[1]);
  const ctrl = m[2] !== undefined && ((Number(m[2]) - 1) & 4) !== 0;
  return ctrl && code === 32 ? "\x00" : String.fromCodePoint(code);
}

const NONE: Picked = { kind: "none" };
const CLOSE: Picked = { kind: "close" };

/** Columns a character takes (wide ones two), as the viewer counts them. */
function cells(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200d) || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1faff))
    return 2;
  return 1;
}
const width = (text: string) => [...text].reduce((n, ch) => n + cells(ch), 0);
/** `text` cut to `max` columns, with … when it was longer. */
function fit(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = "";
  for (const ch of text) {
    if (width(out) + cells(ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// The look: only the terminal's own palette (its 16 colours, its default foreground and background,
// bold, dim, reverse), never a fixed colour (but an agent's mark, in its own: paintMark), so it
// reads the same in a dark theme and a light one.
// The popup's background is the terminal's (window.ts menuPopup: bg=default). The line chosen is
// reversed across its whole width, its words bold; on it, dim and the accent give way to that one
// bar (a warning's red or yellow stays).
const SGR: Record<Tone, string> = { plain: "", dim: "2", accent: "1;34", red: "1;31", yellow: "33" };
const CHOSEN = "7";
const paint = (text: string, tone: Tone = "plain", chosen = false, strong = false) => {
  const style = chosen ? [CHOSEN, strong ? "1" : "", tone === "red" || tone === "yellow" ? SGR[tone] : ""].filter(Boolean).join(";") : SGR[tone];
  return style ? `\x1b[${style}m${text}\x1b[0m` : text;
};
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
/** A mark's slot, as marks.ts MARK_SLOT (this file imports only core/text.ts and ./quit-again.ts, which import nothing of the app's: the popup loads it alone). */
const MARK_SLOT = 3;
/**
 * An agent's mark (an item's `mark`): the one fixed colour a menu draws, the agent's own (a
 * truecolor SGR; tmux brings it down to what the terminal has). On the line chosen it stays, as a
 * warning's red does: one cell of it in the bar. A colour that isn't "#rrggbb" is left out. In its
 * slot, as the lists draw it (marks.ts MARK_SLOT: the glyph, room for it drawn wider, a space): a
 * glyph that isn't one cell is a blank.
 */
function paintMark(mark: { glyph: string; color?: string }, chosen: boolean): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(mark.color ?? "");
  const rgb = hex
    ? `38;2;${hex
        .slice(1)
        .map((x) => parseInt(x, 16))
        .join(";")}`
    : "";
  const style = [chosen ? `${CHOSEN};1` : "", rgb].filter(Boolean).join(";");
  const first = [...plainText(mark.glyph)][0] ?? " ";
  const glyph = cells(first) === 1 && !/[\p{Extended_Pictographic}\p{Z}\p{Cc}\p{Cf}]/u.test(first) ? first : " ";
  return `${style ? `\x1b[${style}m${glyph}\x1b[0m` : glyph}${paint(" ".repeat(MARK_SLOT - 1), "plain", chosen)}`;
}

/** `text` in lines of at most `max` columns, broken between words. */
function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > max) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : fit(word, max);
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * A question's buttons (an item's `confirm`), left to right: their words and whether it's Yes.
 * Plain text, as everything in a menu; Yes in the accent, No bold.
 */
const ASK_BUTTONS = [
  { text: "[ Yes ]", yes: true },
  { text: "[ No ]", yes: false },
] as const;
const ASK_BUTTON_GAP = "  ";
/** The keys under (or beside) the buttons: y does it, any other key goes back. */
const ASK_HINT = "y yes · other keys no";
const ASK_HINT_GAP = "   ";
/** A button's columns on its row, as the terminal counts them (1 the first), both ends in. */
type ButtonSpan = { yes: boolean; from: number; to: number };

/** The buttons' line (after the leading space, column 1), its width, and each button's columns: one walk, so a click hits what's drawn. */
function askButtons(): { line: string; width: number; spans: ButtonSpan[] } {
  let line = " ";
  let col = 2; // the leading space is column 1
  const spans: ButtonSpan[] = [];
  ASK_BUTTONS.forEach((b, k) => {
    if (k) {
      line += ASK_BUTTON_GAP;
      col += width(ASK_BUTTON_GAP);
    }
    spans.push({ yes: b.yes, from: col, to: col + width(b.text) - 1 });
    line += b.yes ? paint(b.text, "accent") : bold(b.text);
    col += width(b.text);
  });
  return { line, width: col - 1, spans };
}

/** The keys' hint, dim, its y in the accent (the key that does it). */
const paintHint = (text: string) => (text.startsWith("y ") ? `${paint("y", "accent")}${paint(text.slice(1), "dim")}` : paint(text, "dim"));

/** The widest a menu gets. */
const MAX_WIDTH = 60;

/** The popup's inner size for `menu`: wide enough for its longest line and key, one row a line. */
export function menuSize(menu: MenuData): { width: number; height: number } {
  let w = 20;
  for (const i of menu.items) {
    if (i === "-") continue;
    // Wide enough for any of its words (byFocus: chosen as it opens, after its size is set).
    for (const label of [i.label, ...(i.byFocus ? [i.byFocus.list, i.byFocus.stage] : [])]) {
      const words = plainText(`${label}${i.note ? ` ${i.note}` : ""}`);
      w = Math.max(w, i.rule ? 4 + width(words) + 4 : 1 + (i.check !== undefined ? 4 : 0) + (i.mark ? MARK_SLOT : 0) + width(words) + (i.key ? 3 + width(i.key) : 0) + 2);
    }
  }
  return { width: Math.min(MAX_WIDTH, w), height: menu.items.length };
}

const live = (i: MenuEntry): i is Exclude<MenuEntry, "-"> & { run: string[][] } => i !== "-" && Boolean(i.run);

// ── Search ──

const wordy = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
/** Whether a word starts at `at` in `text`: a letter or digit with none before it. */
const wordStart = (text: string[], at: number) => wordy(text[at]) && !wordy(text[at - 1]);

/** Whether `q` is the starts of words of `text` from `from` on, in order ("nese": NExt SEssion, "pxe": no). */
function byWordStarts(q: string[], text: string[], from = 0): boolean {
  if (!q.length) return true;
  for (let i = from; i < text.length; i++) {
    if (!wordStart(text, i)) continue;
    let n = 0;
    while (n < q.length && wordy(text[i + n]) && text[i + n] === q[n]) n++;
    for (let k = n; k >= 1; k--) if (byWordStarts(q.slice(k), text, i + k)) return true;
  }
  return false;
}

/** Whether `q`'s letters are all in `text`, in order ("pxe": PiXiE). */
function inOrder(q: string[], text: string[]): boolean {
  let n = 0;
  for (const ch of text) if (ch === q[n]) n++;
  return n >= q.length;
}

/** Letters in order count from this many on: two match nearly everything. */
const IN_ORDER_FROM = 3;

/**
 * How well `query` matches `text`, any case (lower is better; null: it doesn't): 0 it's the text,
 * 1 it starts it, 2 it's in it from a word's start, 3 elsewhere in it, 4 it's the starts of its
 * words in order ("nese": NExt SEssion), 5 its letters are in it in order ("pxe": PiXiE; three
 * letters or more). Nothing searched matches everything, all the same.
 */
export function searchScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = plainText(text).toLowerCase().trim();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  const chars = [...t];
  const size = [...q].length;
  let inside = false;
  for (let i = 0; i + size <= chars.length; i++) {
    if (chars.slice(i, i + size).join("") !== q) continue;
    if (wordStart(chars, i)) return 2;
    inside = true;
  }
  if (inside) return 3;
  const letters = [...q].filter((ch) => ch !== " ");
  if (byWordStarts(letters, chars)) return 4;
  if (letters.length >= IN_ORDER_FROM && inOrder(letters, chars)) return 5;
  return null;
}

/** What an item is searched by: its `find`, else its label (without the mark of the page shown). */
const searchedBy = (i: Exclude<MenuEntry, "-">) => i.find ?? [i.label.replace(/^[▸\s]+/, "")];
/** An item's rank in a search: how well it matched (searchScore), a match past its first words (its folder, its title) just after a match as good on them. */
const rankOf = (score: number, k: number) => score * 2 + (k > 0 ? 1 : 0);

/** One line of a search's results: an item (by its place in MenuView's `all`), the words it matched by when they aren't its first, a group's line, or none matched. */
type Shown = { n: number; via?: string } | "-" | "none";

/** A menu shown: the line chosen, the question it's asking (an item's `confirm`) when it is, and the search typed (`/`) when there is one. */
export class MenuView {
  readonly menu: MenuData;
  /** The line chosen (Enter picks it; drawn highlighted). */
  at: number;
  /** The item whose question (or `twice` hint) is up, if one is (its place in `all`). */
  asking: number | null = null;
  /** When it was asked (a `twice` hint goes QUIT_AGAIN_MS after). */
  private askedAt = 0;
  /** A checklist's items ticked now. */
  readonly ticked = new Set<number>();
  /** What's searched for since `/` (null: no search). */
  query: string | null = null;
  /** The result chosen while searching: its place in the results, one after another. */
  hit = 0;
  /** The menu's items, then those only searched (`search.also`, then `search.apart`): what `asking` and a pick count in. */
  private readonly all: MenuEntry[];
  /** Where `search.apart`'s start in `all`. */
  private readonly apartFrom: number;
  /** The rows the search drew last, each the result there (for a click). */
  private drawn: Shown[] = [];
  /** Where a question's buttons were drawn last (askFrame): their row and spans (for a click). */
  private buttons: { row: number; spans: ButtonSpan[] } | null = null;

  /** The time now (a test's own clock). */
  private readonly now: () => number;

  constructor(menu: MenuData, now: () => number = Date.now) {
    this.menu = menu;
    this.now = now;
    const first = menu.items.findIndex(live);
    this.at = menu.selected !== undefined && live(menu.items[menu.selected] ?? "-") ? menu.selected : first;
    menu.items.forEach((i, n) => i !== "-" && i.check && live(i) && this.ticked.add(n));
    this.all = [...menu.items, ...(menu.search?.also ?? [])];
    this.apartFrom = this.all.length;
    this.all.push(...(menu.search?.apart ?? []));
  }

  /** A checklist: Space ticks, Enter submits. */
  private get checklist() {
    return Boolean(this.menu.submit);
  }

  /** The item asking, when it's a `twice` one (its hint up). */
  private get twiceItem(): (Exclude<MenuEntry, "-"> & { twice: string }) | null {
    const item = this.asking === null ? null : this.all[this.asking];
    return item && item !== "-" && item.twice ? (item as Exclude<MenuEntry, "-"> & { twice: string }) : null;
  }

  /** When a `twice` hint up goes (the popup draws the menu again then: lapse), or null without one. */
  get againUntil(): number | null {
    return this.twiceItem ? this.askedAt + QUIT_AGAIN_MS : null;
  }

  /** The `twice` hint let go if its time's up: true when it was (draw the menu again). */
  lapse(): boolean {
    const until = this.againUntil;
    if (until === null || this.now() < until) return false;
    this.asking = null;
    return true;
  }

  /** Closed without a pick: its `closed` commands, if it has any. */
  private closing(): Picked {
    return this.menu.closed?.length ? { kind: "run", commands: this.menu.closed } : CLOSE;
  }

  /**
   * What the search matches, best first, in its two groups: the menu's own items (and `also`'s),
   * then `apart`'s. Ranked by how well (searchScore; a match past an item's first words a little
   * worse), then the menu's own order. `via`: the words it matched by, when they aren't its first.
   */
  results(): { n: number; via?: string }[][] {
    const query = this.query ?? "";
    const groups: { n: number; score: number; via?: string }[][] = [[], []];
    this.all.forEach((i, n) => {
      if (!live(i)) return;
      let best: { score: number; via?: string } | null = null;
      for (const [k, words] of searchedBy(i).entries()) {
        const score = words.trim() ? searchScore(query, words) : null;
        if (score === null) continue;
        const worth = rankOf(score, k);
        if (!best || worth < best.score) best = { score: worth, ...(k > 0 && query.trim() ? { via: words } : {}) };
      }
      if (best) groups[n < this.apartFrom ? 0 : 1].push({ n, ...(best as { score: number; via?: string }) });
    });
    return groups.map((g) => g.sort((a, b) => a.score - b.score || a.n - b.n).map(({ n, via }) => (via ? { n, via } : { n })));
  }

  /** The results, one after another (what ↑ ↓ and `hit` count in). */
  private found() {
    return this.results().flat();
  }

  /** The popup's lines, `cols` wide. */
  frame(cols: number, rows: number): string[] {
    const twice = this.twiceItem;
    if (twice) {
      // The hint whole when it fits, else a line for each of its parts (" · " between them), each wrapped.
      const max = cols - 2;
      const hint = plainText(twice.twice);
      const parts = width(hint) <= max ? [hint] : hint.split(" · ");
      const lines = parts.flatMap((p) => wrapText(p, max)).map((l) => ` \x1b[1;33m${l}\x1b[0m`); // bold yellow, as the list's
      return [...lines, ...Array(Math.max(0, rows - lines.length)).fill("")].slice(0, rows);
    }
    if (this.asking !== null) return this.askFrame(cols, rows);
    if (this.query !== null) return this.searchFrame(cols, rows);
    return this.menu.items.slice(0, rows).map((i, n) => this.line(i, n === this.at, cols, n));
  }

  /**
   * An item's question (`confirm`): its words, a blank line, the buttons (ASK_BUTTONS: a click on
   * Yes does it, anywhere else goes back) and the keys' hint, beside them when it fits, else under
   * them (its parts on lines of their own when it's too wide whole). Rows short: the question's
   * first line and the buttons always, then the hint, the blank line, the rest of the question.
   * Where the buttons went is kept for a click (`buttons`).
   */
  private askFrame(cols: number, rows: number): string[] {
    const item = this.all[this.asking ?? -1] as Exclude<MenuEntry, "-">;
    const question = wrapText(plainText(item.confirm ?? ""), cols - 2);
    const buttons = askButtons();
    const beside = buttons.width + ASK_HINT_GAP.length + width(ASK_HINT) <= cols;
    let room = Math.max(0, rows - 2); // after the question's first line and the buttons
    const parts = beside ? [] : width(ASK_HINT) + 1 <= cols ? [ASK_HINT] : ASK_HINT.split(" · ");
    const hints = parts.length <= room ? parts : [fit(ASK_HINT, Math.max(1, cols - 1))].slice(0, room);
    room -= hints.length;
    const blank = room > 0 ? [""] : [];
    room -= blank.length;
    const asked = question.slice(0, 1 + room).map((l) => ` ${bold(l)}`);
    this.buttons = { row: asked.length + blank.length + 1, spans: buttons.spans };
    const lines = [...asked, ...blank, `${buttons.line}${beside ? `${ASK_HINT_GAP}${paintHint(ASK_HINT)}` : ""}`, ...hints.map((h) => ` ${paintHint(h)}`)];
    return [...lines, ...Array(Math.max(0, rows - lines.length)).fill("")].slice(0, rows);
  }

  /** One item's line: its mark, words and note, its key at the right. `n`: its place (a checklist's box); `via`: what a search found it by, before its note. */
  private line(i: MenuEntry, chosen: boolean, cols: number, n = -1, via = ""): string {
    if (i === "-") return paint("─".repeat(cols), "dim");
    if (i.rule) {
      const words = fit(plainText(i.label), Math.max(1, cols - 4));
      return `${paint("─", "dim")} ${bold(words)} ${paint("─".repeat(Math.max(0, cols - 3 - width(words))), "dim")}`;
    }
    const key = i.key ? ` ${i.key} ` : "";
    const marked = i.mark ? MARK_SLOT : 0; // the mark's slot
    const room = cols - 1 - width(key) - 1 - marked;
    const box = i.check !== undefined ? `[${this.ticked.has(n) ? "x" : " "}] ` : "";
    const words = fit(box + plainText(i.label), room);
    const noted = [via && plainText(via), i.note && plainText(i.note)].filter(Boolean).join(" · ");
    const note = noted ? fit(` ${noted}`, Math.max(0, room - width(words))) : "";
    const gap = " ".repeat(Math.max(1, cols - 1 - marked - width(words) - width(note) - width(key)));
    const tone = i.tone ?? (live(i) ? "plain" : "dim");
    const noteTone = via ? "dim" : (i.noteTone ?? "dim");
    return `${paint(" ", "plain", chosen)}${i.mark ? paintMark(i.mark, chosen) : ""}${paint(words, tone, chosen, true)}${note ? paint(note, noteTone, chosen) : ""}${paint(gap, "plain", chosen)}${paint(key, "dim", chosen)}`;
  }

  /**
   * Searching: the search line, the results in the rows left (the one chosen kept in view; a line
   * between the groups), and how to use it on the last row (when there's room for it).
   */
  private searchFrame(cols: number, rows: number): string[] {
    const head = ` ${paint("/", "accent")} ${bold(fit(plainText(this.query ?? ""), Math.max(1, cols - 5)))}▏`;
    const hint = rows >= 4 ? [paint(fit(" ↑↓ move · ⏎ pick · Esc clears", cols), "dim")] : [];
    const room = Math.max(0, rows - 1 - hint.length);
    const [mine, apart] = this.results();
    const all: Shown[] = !mine.length && !apart.length ? ["none"] : [...mine, ...(mine.length && apart.length ? ["-" as const] : []), ...apart];
    const chosen = this.found()[this.hit];
    const at = chosen ? all.findIndex((r) => typeof r === "object" && r.n === chosen.n) : 0;
    const start = Math.max(0, Math.min(at - Math.floor(room / 2), all.length - room));
    this.drawn = all.slice(start, start + room);
    const body = this.drawn.map((r) => {
      if (r === "none") return paint(" nothing matches", "dim");
      if (r === "-") return paint("─".repeat(cols), "dim");
      return this.line(this.all[r.n], r.n === chosen?.n, cols, -1, r.via);
    });
    return [head, ...body, ...Array(Math.max(0, room - body.length)).fill(""), ...hint].slice(0, rows);
  }

  /** What `data` (one read from the terminal) picks. */
  key(raw: string): Picked {
    const data = plainKey(raw);
    // A `twice` hint up: its key again (or y) does it, any other key goes back to the menu (and
    // does nothing else). Its time up: let go, and the key is as without it.
    const twice = this.twiceItem;
    if (twice) {
      if (!this.lapse()) {
        this.asking = null;
        return twice.input?.includes(data) || data === "y" || data === "Y" ? { kind: "run", commands: twice.run ?? [] } : NONE;
      }
    } else if (this.asking !== null) {
      const item = this.all[this.asking] as Exclude<MenuEntry, "-">;
      this.asking = null;
      this.buttons = null;
      return data === "y" || data === "Y" ? { kind: "run", commands: item.run ?? [] } : NONE;
    }
    // The Kiko key again, as it came (Ctrl+\ in CSI u form isn't a plain "\"): passed on, or closes.
    const again = this.menu.again;
    if (again?.input.includes(raw) || (again && again.input.includes(data))) return again.run?.length ? { kind: "run", commands: again.run } : this.closing();
    if (this.query !== null) return this.searchKey(data);
    if (data === "\x1b" || data === "\x00" || data === "\x03") return this.closing(); // Escape, Ctrl+Space (the key it was), Ctrl+C
    const n = this.menu.items.findIndex((i) => live(i) && i.input?.includes(data));
    if (n >= 0) return this.pick(n);
    if (data === "/" && this.menu.search && !this.checklist) {
      this.query = "";
      this.hit = 0;
      return NONE;
    }
    if (UP.includes(data)) return this.move(-1);
    if (DOWN.includes(data)) return this.move(1);
    if (this.checklist && (data === "\r" || data === "\n")) return this.submitted();
    if (data === "\r" || data === "\n" || data === " ") return this.at >= 0 ? this.pick(this.at) : NONE;
    return NONE;
  }

  /** A key while searching: typed into the search (never an item's key), ↑ ↓ the results, Enter picks, Escape the whole menu again. */
  private searchKey(data: string): Picked {
    const query = this.query ?? "";
    if (data === "\x1b") return this.endSearch();
    if (data === "\x00" || data === "\x03") return this.closing();
    if (data === "\x7f" || data === "\b") {
      if (!query) return this.endSearch();
      this.query = [...query].slice(0, -1).join("");
      this.hit = 0;
      return NONE;
    }
    const found = this.found();
    if (UP.includes(data) || DOWN.includes(data)) {
      if (found.length) this.hit = (this.hit + (UP.includes(data) ? -1 : 1) + found.length) % found.length;
      return NONE;
    }
    if (data === "\r" || data === "\n") return found[this.hit] ? this.pick(found[this.hit].n) : NONE;
    // One character typed (not a control one, nor an escape sequence).
    if ([...data].length === 1 && !/\p{C}/u.test(data)) {
      this.query = query + data;
      this.hit = 0;
    }
    return NONE;
  }

  /** The search let go: the whole menu again, its highlight where it was. */
  private endSearch(): Picked {
    this.query = null;
    this.hit = 0;
    this.drawn = [];
    return NONE;
  }

  /** A checklist submitted: each ticked item's commands, in order, then `submit`'s. */
  private submitted(): Picked {
    const ticked = this.menu.items.flatMap((i, n) => (live(i) && i.check !== undefined && this.ticked.has(n) ? i.run : []));
    return { kind: "run", commands: [...ticked, ...(this.menu.submit ?? [])] };
  }

  /** The highlight `by` items up (−1) or down (1), over the ones that do something, round the ends. */
  private move(by: number): Picked {
    const count = this.menu.items.length;
    for (let step = 1; step <= count; step++) {
      const n = (((this.at + by * step) % count) + count) % count;
      if (live(this.menu.items[n])) {
        this.at = n;
        break;
      }
    }
    return NONE;
  }

  /**
   * A click at column `x`, row `y` of the popup (1 the first, as the terminal counts); searching, a
   * result's row (the search line is the first). A question up: on Yes, its item's commands (as y);
   * anywhere else, back to the menu (as any other key). A `twice` hint up: nothing.
   */
  click(x: number, y: number): Picked {
    if (this.twiceItem) return NONE;
    if (this.asking !== null) {
      const item = this.all[this.asking] as Exclude<MenuEntry, "-">;
      const hit = this.buttons?.row === y ? this.buttons.spans.find((b) => x >= b.from && x <= b.to) : undefined;
      this.asking = null;
      this.buttons = null;
      return hit?.yes ? { kind: "run", commands: item.run ?? [] } : NONE;
    }
    if (this.query !== null) {
      const r = this.drawn[y - 2];
      return r && typeof r === "object" ? this.pick(r.n) : NONE;
    }
    const n = y - 1;
    return live(this.menu.items[n] ?? "-") ? this.pick(n) : NONE;
  }

  /** Item `n` of `all` (the menu's, or one only searched) picked. */
  private pick(n: number): Picked {
    const item = this.all[n];
    if (!live(item)) return NONE;
    if (n < this.menu.items.length) this.at = n;
    // A checklist's item: ticked or unticked, nothing run yet.
    if (this.checklist && item.check !== undefined) {
      if (this.ticked.has(n)) this.ticked.delete(n);
      else this.ticked.add(n);
      return NONE;
    }
    if (item.confirm || item.twice) {
      this.asking = n;
      this.askedAt = this.now();
      this.buttons = null; // drawn with the question (askFrame)
      return NONE;
    }
    return { kind: "run", commands: item.run };
  }
}
