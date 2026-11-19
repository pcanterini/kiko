// The read-only view of a session outside Kiko's tmux (in Ghostty, the desktop app, the
// background), in the Kiko window's session area: a header (its folder, when it was last
// active, its state; its name and where it runs are on the box's title, or the tiled look's border:
// placeText), its conversation newest at the bottom (core/history.ts's folded items, with what
// Kiko said about it in between), and a footer (read-only, how to talk to it, the menu's key).
// Kiko's own page is drawn the same way (`page` mode): its conversation with you, from the page
// file the app keeps (core/page.ts). Drawn by its own small process (src/terminals/tmux/viewer-pane.ts);
// this is only the drawing, the scrolling and the keys read, with the clock given, so the tests drive it.
//
// Following: at the bottom, new messages come into view; scrolled up, the view stays where it is
// and the footer says "↓ 2 new messages" until End (or scrolling down) goes back to the bottom.
import type { Folder, History, HistoryItem } from "../core/history.ts";
import type { PageLine } from "../core/page.ts";
import type { SessionStatus } from "../core/ui-store.ts";
import { menuKeyName } from "../terminals/tmux/keys.ts";
import { NAME } from "../core/name.ts";

/** Where an outside session runs. */
export type Where = "ghostty" | "desktop" | "background" | "t3" | "elsewhere";
type ViewerStatus = SessionStatus | "ended";
/** A line Kiko said about the session (its spoken summary), when (ms epoch). */
export type Spoken = { at: number; text: string };
/**
 * Who answers in a session, for the heading over its replies: its agent's speaker ("Claude" for
 * Claude Code, "Codex", "OpenCode"), else the agent's name ("T3 Code", whose threads run on
 * Claude or Codex underneath); `color`, its mark's ("#rrggbb"), else the terminal's own. Sent by
 * the app (marks.ts speakerOf): this process loads no adapter.
 */
export type Speaker = { name: string; color?: string };
/**
 * The header and what Kiko said, from the app (window.ts VIEWER_INFO, as JSON); any field may be
 * missing. Kiko's page: `doing` (ready, listening…) and `talk` (how to talk, for its footer).
 * `key`: the Kiko key as shown ("⌃Space"), for the footer. `agent`: who answers (Speaker).
 */
export type ViewerInfo = { name: string; where: Where; status: ViewerStatus; folder: string; spoken: Spoken[]; doing?: string; talk?: string; key?: string; agent?: Speaker };

const PLACES: Record<Where, { header: string; footer: string }> = {
  ghostty: { header: "in Ghostty", footer: "its own window is in Ghostty" },
  desktop: { header: "in the Claude desktop app", footer: "it's open in the Claude desktop app" },
  background: { header: "in the background", footer: "it runs in the background (claude agents)" },
  t3: { header: "in T3 Code", footer: "it's a thread in T3 Code" },
  elsewhere: { header: "in a terminal of its own", footer: "its own window is in another terminal" },
};

/** Where an outside session runs, for its title after its name ("in Ghostty"): window.ts PLACE. */
export const placeText = (where: Where) => PLACES[where].header;

/**
 * The footer, written here only: what this is and how to talk to it (`about`), and the menu's key
 * (`back`, kept whole when the pane is narrow).
 */
export function footer(where: Where, key = menuKeyName()) {
  return { about: `Read-only · talk to it by voice · ${PLACES[where].footer}`, back: `${key} menu` };
}
/** Kiko's page's footer: how to talk (from the app), and the menu's key. */
function pageFooter(talk = "hold the talk key to talk", key = menuKeyName()) {
  return { about: `${talk} · click a session to show it`, back: `${key} menu` };
}
/** A viewer's footer as one line (for the tests). */
export const footerText = (where: Where) => Object.values(footer(where)).join(" · ");

const STATUS: Record<ViewerStatus, { text: string; style: string }> = {
  needs_you: { text: "⚠ needs you", style: "1;31" },
  waiting: { text: "◆ waits for you", style: "33" },
  working: { text: "● working", style: "32" },
  idle: { text: "○ idle", style: "2" },
  starting: { text: "◌ starting", style: "36" },
  ended: { text: "■ ended", style: "2" },
};

/** A colour as "#rrggbb" (a mark's: marks.ts). */
const HEX = /^#[0-9a-f]{6}$/i;

/** The info as the app sent it, checked field by field; null when it isn't JSON at all. */
export function parseInfo(text: string): Partial<ViewerInfo> | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<ViewerInfo> = {};
  if (typeof raw.name === "string") out.name = raw.name;
  if (typeof raw.where === "string" && raw.where in PLACES) out.where = raw.where;
  if (typeof raw.status === "string" && raw.status in STATUS) out.status = raw.status;
  if (typeof raw.folder === "string") out.folder = raw.folder;
  if (Array.isArray(raw.spoken)) out.spoken = raw.spoken.filter((s: any) => typeof s?.at === "number" && typeof s.text === "string");
  if (typeof raw.doing === "string") out.doing = raw.doing.slice(0, 40);
  if (typeof raw.talk === "string") out.talk = raw.talk.slice(0, 80);
  if (typeof raw.key === "string") out.key = clean(raw.key).replace(/\n/g, " ").slice(0, 20);
  const agentName = typeof raw.agent?.name === "string" ? clean(raw.agent.name).replace(/\n/g, " ").trim().slice(0, 30) : "";
  if (agentName) out.agent = { name: agentName, ...(typeof raw.agent.color === "string" && HEX.test(raw.agent.color) ? { color: raw.agent.color } : {}) };
  return out;
}

// ── Text in cells ──

/** A piece of a line in one style (SGR parameters: "1" bold, "2" dim, "36" cyan…; "" plain). */
type Span = { text: string; style: string };
type Line = Span[];

/**
 * Text from a transcript, safe to draw: no escape sequences or other control characters (they'd
 * move the cursor or change the terminal), tabs as spaces.
 */
export const clean = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "");

/** Columns a character takes: 0 for combining marks, 2 for wide (East Asian, most emoji), else 1. */
export function cells(ch: string): number {
  const c = ch.codePointAt(0)!;
  if ((c >= 0x300 && c <= 0x36f) || (c >= 0x200b && c <= 0x200d) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x20d0 && c <= 0x20ff)) return 0;
  if (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
    return 2;
  return 1;
}
export const width = (text: string) => [...text].reduce((n, ch) => n + cells(ch), 0);

/** `text` cut to `max` columns. */
function fit(text: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = cells(ch);
    if (used + w > max) break;
    out += ch;
    used += w;
  }
  return out;
}

/** A line as the terminal draws it: each span in its style, nothing after. */
export const draw = (line: Line) => line.map((s) => (s.style && s.text ? `\x1b[${s.style}m${s.text}\x1b[0m` : s.text)).join("");
const plainOf = (line: Line) => line.map((s) => s.text).join("");

/** A line cut to `max` columns (spans kept). */
function cutLine(line: Line, max: number): Line {
  const out: Line = [];
  let left = max;
  for (const s of line) {
    if (left <= 0) break;
    const text = fit(s.text, left);
    left -= width(text);
    out.push({ text, style: s.style });
  }
  return out;
}

/**
 * Spans wrapped to `max` columns, between words where it can, within a word where one is longer
 * than a line. `first` starts the first line, `rest` the others (a list item's hanging indent).
 */
function wrap(spans: Line, max: number, first: Line = [], rest: Line = first): Line[] {
  const lines: Line[] = [];
  const copy = (prefix: Line) => prefix.map((s) => ({ ...s }));
  let line: Line = copy(first);
  let lead = first.length; // the prefix's spans, never written into
  let used = width(plainOf(first));
  let start = used;
  const room = () => Math.max(1, max - start);
  const push = (text: string, style: string) => {
    const last = line.at(-1);
    if (last && line.length > lead && last.style === style) last.text += text;
    else line.push({ text, style });
    used += width(text);
  };
  const newLine = () => {
    const last = line.at(-1);
    if (last && line.length > lead) last.text = last.text.replace(/ +$/, "");
    lines.push(line);
    line = copy(rest);
    lead = rest.length;
    used = start = width(plainOf(rest));
  };
  for (const span of spans) {
    for (const word of span.text.split(/( +)/)) {
      if (!word) continue;
      const w = width(word);
      if (word.startsWith(" ")) {
        if (used > start && used + w <= max) push(word, span.style);
        else if (used > start) newLine();
        continue;
      }
      if (used + w > max && used > start) newLine();
      if (w <= room()) {
        push(word, span.style);
        continue;
      }
      // Longer than a line: cut where the line ends.
      let piece = "";
      for (const ch of word) {
        if (used + width(piece) + cells(ch) > max && (piece || used > start)) {
          if (piece) push(piece, span.style);
          piece = "";
          newLine();
        }
        piece += ch;
      }
      if (piece) push(piece, span.style);
    }
  }
  lines.push(line);
  return lines;
}

// ── Markdown, readably ──

const INLINE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?=[^\s*])([^*]+?)(?<=\S)\*(?![\w*])/g;

/** One line's inline Markdown as spans: **bold**, *italic*, `code`, [links](…) as their text. */
function inline(text: string, base = ""): Line {
  const out: Line = [];
  const style = (more: string) => [base, more].filter(Boolean).join(";");
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), style: base });
    if (m[2] !== undefined) out.push({ text: m[2].replace(/`/g, ""), style: style("1") });
    else if (m[3] !== undefined) out.push({ text: m[3], style: style("36") });
    else if (m[4] !== undefined) out.push({ text: m[4], style: style("4") });
    else out.push({ text: m[6], style: style("3") });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), style: base });
  return out;
}

/**
 * A message's text as lines `max` wide, indented by `indent`: paragraphs wrapped, headings bold,
 * list items with a hanging indent, code blocks as they are (cyan, without their fences), quotes
 * marked, rules drawn; blank lines kept, one at a time.
 */
export function markdown(text: string, max: number, indent = 2, base = ""): Line[] {
  const pad = " ".repeat(indent);
  const lines: Line[] = [];
  let code = false;
  let blank = false;
  for (const raw of clean(text).split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      code = !code;
      continue;
    }
    if (code) {
      lines.push(...wrap([{ text: raw.replace(/\s+$/, "") || " ", style: "36" }], max, [{ text: `${pad}  `, style: "" }]));
      blank = false;
      continue;
    }
    if (!raw.trim()) {
      if (!blank && lines.length) lines.push([]);
      blank = true;
      continue;
    }
    blank = false;
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^\s*#{1,6}\s+(.*)$/))) lines.push(...wrap(inline(m[1], "1"), max, [{ text: pad, style: "" }]));
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw))
      lines.push([
        { text: pad, style: "" },
        { text: "─".repeat(Math.max(1, Math.min(40, max - indent))), style: "2" },
      ]);
    else if ((m = raw.match(/^(\s*)[-*+]\s+(.*)$/))) {
      const lead = pad + " ".repeat(Math.min(8, m[1].length));
      lines.push(...wrap(inline(m[2], base), max, [{ text: `${lead}• `, style: "" }], [{ text: `${lead}  `, style: "" }]));
    } else if ((m = raw.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
      const lead = pad + " ".repeat(Math.min(8, m[1].length));
      lines.push(...wrap(inline(m[3], base), max, [{ text: `${lead}${m[2]} `, style: "" }], [{ text: `${lead}${" ".repeat(m[2].length + 1)}`, style: "" }]));
    } else if ((m = raw.match(/^\s*>\s?(.*)$/))) lines.push(...wrap(inline(m[1], "2;3"), max, [{ text: `${pad}│ `, style: "2" }]));
    else lines.push(...wrap(inline(raw.trim(), base), max, [{ text: pad, style: "" }]));
  }
  while (lines.length && !lines.at(-1)!.length) lines.pop();
  return lines;
}

// ── The conversation ──

type Entry = { kind: "you" | "claude" | "steps" | "spoken"; item?: HistoryItem; spoken?: Spoken; at: number | null };

const time = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const parsed = (at: string | null) => (at ? Date.parse(at) : NaN);

/** The history's items and Kiko's lines, in time order (Kiko's after what they're about). */
function entries(items: HistoryItem[], spoken: Spoken[]): Entry[] {
  const out: Entry[] = [];
  const said = [...spoken].sort((a, b) => a.at - b.at);
  let next = 0;
  for (const item of items) {
    const at = parsed(item.at);
    if (Number.isFinite(at)) while (next < said.length && said[next].at < at) out.push({ kind: "spoken", spoken: said[next], at: said[next++].at });
    out.push({ kind: item.kind, item, at: Number.isFinite(at) ? at : null });
  }
  while (next < said.length) out.push({ kind: "spoken", spoken: said[next], at: said[next++].at });
  return out;
}

const HEADS = {
  you: { mark: "›", name: "You", style: "1;36" },
  claude: { mark: "●", name: "Claude", style: "1;38;5;173" },
  spoken: { mark: "♪", name: `${NAME} said`, style: "1;35" },
} as const;

/**
 * The heading over a session's replies: who answers (Speaker), bold, in its agent's colour (a
 * truecolor SGR, as the menus draw a mark: tmux brings it down to what the terminal has); with no
 * colour, the terminal's own. Not said yet (the app sends it with the session): Claude, as before.
 */
function replyHeading(agent: Speaker | undefined) {
  const name = agent ? clean(agent.name).replace(/\n/g, " ").trim() : "";
  if (!name) return HEADS.claude;
  const hex = agent?.color && HEX.test(agent.color) ? agent.color : "";
  const rgb = hex ? `;38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}` : "";
  return { mark: "●", name, style: `1${rgb}` };
}

/** The conversation as lines `max` wide, oldest first; the replies headed with who answers (`agent`: replyHeading). */
export function conversation(items: HistoryItem[], spoken: Spoken[], max: number, truncated = false, ended = false, agent?: Speaker): Line[] {
  const lines: Line[] = [];
  if (truncated) lines.push([{ text: "  … earlier messages aren't shown", style: "2" }], []);
  const heads = { ...HEADS, claude: replyHeading(agent) };
  let speaker: "you" | "claude" | "spoken" | null = null;
  for (const e of entries(items, spoken)) {
    const who = e.kind === "steps" ? "claude" : e.kind;
    if (who !== speaker) {
      if (lines.length && lines.at(-1)!.length) lines.push([]);
      const head = heads[who];
      const at = time(e.at);
      lines.push(cutLine([{ text: `${head.mark} `, style: head.style }, { text: head.name, style: head.style }, ...(at ? [{ text: ` · ${at}`, style: "2" }] : [])], max));
      speaker = who;
    } else if (lines.at(-1)?.length) lines.push([]);
    if (e.kind === "steps" && e.item?.kind === "steps") {
      const failed = e.item.steps.filter((s) => s.error).length;
      const line: Line = [{ text: `  ⋯ ${clean(e.item.summary) || "worked"}`, style: "2" }];
      if (failed) line.push({ text: ` · ${failed} failed`, style: "31" });
      lines.push(cutLine(line, max));
    } else {
      const text = e.kind === "spoken" ? e.spoken!.text : e.item!.kind === "steps" ? "" : e.item!.text;
      lines.push(...markdown(text, max, 2, e.kind === "spoken" ? "3" : ""));
    }
  }
  if (!lines.length) lines.push([{ text: "  Nothing said yet.", style: "2" }]);
  if (ended) lines.push([], [{ text: "  ── the session ended ──", style: "2" }]);
  return lines;
}

// ── Kiko's page ──

const PAGE_KINDS = new Set(["you", "session", "spoken", "permission", "voice", "task", "info", "error", "start"]);
/** Lines the page keeps in view at most (its file can hold more). */
const PAGE_KEPT = 400;

/** Kiko's page as its viewer has it: the lines read, newest last. */
export type PageSnapshot = { lines: PageLine[]; truncated: boolean };

/** The page file's lines (core/page.ts), checked one by one as they're read (core/history.ts JsonlWatcher). */
export class PageFolder implements Folder<PageSnapshot> {
  private lines: PageLine[] = [];
  truncated = false;
  add(raw: any): boolean {
    if (!raw || typeof raw !== "object" || typeof raw.at !== "number" || typeof raw.text !== "string" || !PAGE_KINDS.has(raw.kind)) return false;
    this.lines.push({ at: raw.at, kind: raw.kind, text: raw.text, ...(typeof raw.name === "string" ? { name: raw.name } : {}) });
    if (this.lines.length > PAGE_KEPT) {
      this.lines.splice(0, this.lines.length - PAGE_KEPT);
      this.truncated = true;
    }
    return true;
  }
  snapshot(): PageSnapshot {
    return { lines: [...this.lines], truncated: this.truncated };
  }
}

/** Who a page line is from, for its heading: you, Kiko, or a session (by its name). */
const pageWho = (l: PageLine) =>
  l.kind === "you" ? "you" : l.kind === "spoken" || l.kind === "voice" ? "app" : l.kind === "session" || l.kind === "permission" ? `s:${l.name ?? ""}` : l.kind === "task" ? "task" : null;

/**
 * Kiko's page as lines `max` wide, oldest first: what you said, what Kiko said, what sessions
 * said and asked, quick tasks, each under a heading with its time; where your words went and other
 * notices dim beneath, errors in red; a rule where the app started again.
 */
function pageLines(page: PageSnapshot, max: number): Line[] {
  const lines: Line[] = [];
  if (page.truncated) lines.push([{ text: "  … earlier lines aren't shown", style: "2" }], []);
  let speaker: string | null = null;
  const head = (mark: string, name: string, style: string, at: number) =>
    lines.push(
      cutLine(
        [
          { text: `${mark} `, style },
          { text: name, style },
          { text: ` · ${time(at)}`, style: "2" },
        ],
        max,
      ),
    );
  for (const l of page.lines) {
    const who = pageWho(l);
    if (l.kind === "start") {
      if (lines.length && lines.at(-1)!.length) lines.push([]);
      const label = ` ${NAME} started · ${time(l.at)} `;
      lines.push([{ text: `──${label}${"─".repeat(Math.max(2, Math.min(20, max - width(label) - 2)))}`, style: "2" }]);
      speaker = null;
      continue;
    }
    if (who === null) {
      // A notice (where your words went, a decision) or an error: under whatever came before it.
      const style = l.kind === "error" ? "31" : "2";
      lines.push(...wrap(inline(clean(l.text).replace(/\n/g, " "), style), max, [{ text: `  ${l.kind === "error" ? "✗ " : ""}`, style }], [{ text: "    ", style: "" }]));
      continue;
    }
    if (who !== speaker) {
      if (lines.length && lines.at(-1)!.length) lines.push([]);
      if (who === "you") head(HEADS.you.mark, HEADS.you.name, HEADS.you.style, l.at);
      else if (who === "app") head("♪", NAME, "1;35", l.at);
      else if (who === "task") head("✓", "Quick task", "1;33", l.at);
      else head("●", clean(l.name ?? "a session").replace(/\n/g, " "), HEADS.claude.style, l.at);
      speaker = who;
    }
    if (l.kind === "permission") lines.push(...wrap(inline(`wants to ${clean(l.text).replace(/\n/g, " ")}`, "33"), max, [{ text: "  ", style: "" }]));
    else if (l.kind === "session") lines.push(...markdown(l.text, max, 2, "2").slice(0, 6));
    else lines.push(...markdown(l.text, max, 2, l.kind === "task" ? "2" : ""));
  }
  if (!lines.length) lines.push([{ text: "  Nothing said yet. Hold the talk key and speak: it all shows here.", style: "2" }]);
  return lines;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// ── Keys ──

export type Key = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";
/** What a key or the wheel does: a key, or the wheel by lines (negative: up, older). */
export type Input = { key: Key } | { wheel: number };

const SEQUENCES: Record<string, Key> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  k: "up",
  "\x1b[B": "down",
  "\x1bOB": "down",
  j: "down",
  "\x1b[5~": "pageUp",
  "\x1b[6~": "pageDown",
  " ": "pageDown",
  b: "pageUp",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home",
  "\x1b[7~": "home",
  g: "home",
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end",
  "\x1b[8~": "end",
  G: "end",
};
const WHEEL_LINES = 3;

/** Keys and wheel turns in what the terminal sent (several may come at once); anything else is left out. */
export function inputs(data: string): Input[] {
  const out: Input[] = [];
  let i = 0;
  while (i < data.length) {
    // The mouse, as SGR reports it (asked for with ?1006): ESC [ < button ; x ; y M|m. 64 wheel up, 65 down.
    const mouse = /^\x1b\[<(\d+);\d+;\d+[Mm]/.exec(data.slice(i));
    if (mouse) {
      const b = Number(mouse[1]);
      if ((b & ~0x1c) === 64) out.push({ wheel: -WHEEL_LINES });
      else if ((b & ~0x1c) === 65) out.push({ wheel: WHEEL_LINES });
      i += mouse[0].length;
      continue;
    }
    const seq = Object.keys(SEQUENCES).find((s) => data.startsWith(s, i));
    if (seq) {
      out.push({ key: SEQUENCES[seq] });
      i += seq.length;
      continue;
    }
    // An escape sequence this doesn't know: skip it whole.
    const other = /^\x1b(?:\[[0-9;?<>]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i));
    i += other && data[i] === "\x1b" ? other[0].length : 1;
  }
  return out;
}

// ── The view ──

const HEADER = 2;
const FOOTER = 2;

const BLANK: ViewerInfo = { name: "", where: "elsewhere", status: "idle", folder: "", spoken: [] };
const keyOf = (i: HistoryItem) => `${i.kind}|${i.at ?? ""}|${i.kind === "steps" ? "" : i.text.slice(0, 40)}`;

/**
 * The viewer's state: the conversation, the header, and where it's scrolled to (`offset`: lines up
 * from the bottom; 0 follows new messages). `frame` draws it for a pane `width` × `height`.
 */
export class ConversationView {
  info: ViewerInfo = { ...BLANK };
  /** "session": an outside session's conversation; "page": Kiko's own page. */
  readonly mode: "session" | "page";
  private items: HistoryItem[] = [];
  private sheet: PageSnapshot = { lines: [], truncated: false };
  private truncated = false;
  private offset = 0;
  /** Messages come in since it was scrolled up. */
  unseen = 0;
  private total = -1; // body lines at the last frame, at `cols` wide
  private cols = -1;
  private page = 10;
  private now: () => number;

  constructor(now: () => number = Date.now, mode: "session" | "page" = "session") {
    this.now = now;
    this.mode = mode;
  }

  /** Kiko's page as its watcher has it now. */
  setPage(page: PageSnapshot) {
    const last = this.sheet.lines.at(-1);
    const from = last ? page.lines.findLastIndex((l) => l.at === last.at && l.text === last.text) : -1;
    const added = from < 0 ? page.lines.length : page.lines.length - 1 - from;
    this.sheet = page;
    if (!this.following) this.unseen += Math.max(0, added);
  }

  get following() {
    return this.offset === 0;
  }

  /** The history as its watcher has it now. */
  setHistory(history: History) {
    const before = this.items.length ? keyOf(this.items.at(-1)!) : null;
    const from = before === null ? -1 : history.items.findLastIndex((i) => keyOf(i) === before);
    const added = from < 0 ? history.items.length : history.items.length - 1 - from;
    this.items = history.items;
    this.truncated = history.truncated;
    if (!this.following) this.unseen += Math.max(0, added);
  }

  /** What the app says, merged into what it said before (a field left out stays as it was). */
  setInfo(info: Partial<ViewerInfo>) {
    const said = new Set(this.info.spoken.map((s) => `${s.at}|${s.text}`));
    const fresh = (info.spoken ?? []).filter((s) => !said.has(`${s.at}|${s.text}`)).length;
    this.info = { ...this.info, ...info };
    if (!this.following) this.unseen += fresh;
  }

  /** Scrolls by `lines` (negative: up, to older). */
  scroll(lines: number) {
    this.offset = Math.max(0, this.offset - lines);
    if (this.total >= 0) this.offset = Math.min(this.offset, Math.max(0, this.total - this.page));
    if (this.following) this.unseen = 0;
  }

  input(i: Input) {
    if ("wheel" in i) return this.scroll(i.wheel);
    const page = Math.max(1, this.page - 1);
    if (i.key === "up") this.scroll(-1);
    else if (i.key === "down") this.scroll(1);
    else if (i.key === "pageUp") this.scroll(-page);
    else if (i.key === "pageDown") this.scroll(page);
    else if (i.key === "home") this.scroll(-Infinity);
    else this.scroll(Infinity);
  }

  /** The pane's lines, each at most `cols` wide, `rows` of them. */
  frame(cols: number, rows: number): string[] {
    cols = Math.max(10, cols);
    const small = rows < HEADER + FOOTER + 2;
    const bodyRows = Math.max(1, rows - (small ? 2 : HEADER + FOOTER));
    const body = this.mode === "page" ? pageLines(this.sheet, cols - 1) : conversation(this.items, this.info.spoken, cols - 1, this.truncated, this.info.status === "ended", this.info.agent);
    // Scrolled up: what's on screen stays put as lines come in below (or above, at the same width).
    if (this.offset > 0 && this.cols === cols && this.total >= 0) this.offset += body.length - this.total;
    this.total = body.length;
    this.cols = cols;
    this.page = bodyRows;
    this.offset = Math.max(0, Math.min(this.offset, body.length - bodyRows));
    if (this.offset === 0) this.unseen = 0;
    const end = body.length - this.offset;
    const shown = body.slice(Math.max(0, end - bodyRows), end);
    while (shown.length < bodyRows) shown.unshift([]); // newest at the bottom
    const header = this.header(cols);
    const footer = this.footer(cols);
    const lines = small ? [header[0], ...shown, footer[1]] : [...header, ...shown, ...footer];
    return lines.slice(0, rows).map((l) => draw(cutLine(l, cols)));
  }

  /**
   * Two lines: what's on the left (dim), a word on the right in its style, then a rule. The name
   * and where it runs aren't here: they're on the title above (placeText). Kiko's page: what it
   * is, and what Kiko is doing only while it does something (never "ready").
   */
  private header(cols: number): Line[] {
    let words: string;
    let right = "";
    let style = "";
    if (this.mode === "page") {
      words = `what you said, what ${NAME} said, where your words went`;
      const doing = this.info.doing && this.info.doing !== "ready" ? this.info.doing : "";
      if (doing) [right, style] = [` ● ${doing} `, doing === "listening" ? "1;31" : "33"];
    } else {
      const { status, folder } = this.info;
      const lastAt = Math.max(-Infinity, ...this.items.map((i) => parsed(i.at)).filter(Number.isFinite), ...this.info.spoken.map((x) => x.at));
      words = [
        clean(folder)
          .replace(/\n/g, " ")
          .replace(/^\/Users\/[^/]+/, "~"),
        Number.isFinite(lastAt) ? `last active ${ago(this.now() - lastAt)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      [right, style] = [` ${STATUS[status].text} `, STATUS[status].style];
    }
    const room = cols - width(right);
    const left = cutLine([{ text: ` ${words}`, style: "2" }], Math.max(1, right ? room - 1 : room)); // a space at least before the right word
    const gap = right ? Math.max(1, room - width(plainOf(left))) : 0;
    return [[...left, { text: " ".repeat(gap), style: "" }, { text: right, style }], [{ text: "─".repeat(cols), style: "2" }]];
  }

  private footer(cols: number): Line[] {
    let rule: Line = [{ text: "─".repeat(cols), style: "2" }];
    if (!this.following) {
      const note = this.unseen ? ` ↓ ${this.unseen} new message${this.unseen === 1 ? "" : "s"} · End to jump ` : " ↑ scrolled back · End for the newest ";
      const side = Math.max(0, Math.floor((cols - width(note)) / 2));
      rule = [
        { text: "─".repeat(side), style: "2" },
        { text: note, style: this.unseen ? "1;33" : "2" },
        { text: "─".repeat(Math.max(0, cols - side - width(note))), style: "2" },
      ];
    }
    const key = this.info.key || undefined;
    const { about, back } = this.mode === "page" ? pageFooter(this.info.talk, key) : footer(this.info.where, key);
    const room = cols - width(back) - 4;
    const left = width(about) <= room ? about : room > 8 ? `${fit(about, room - 1)}…` : "";
    return [
      rule,
      [
        { text: ` ${left}${left ? " · " : ""}`, style: "2" },
        { text: back, style: "" },
      ],
    ];
  }
}
