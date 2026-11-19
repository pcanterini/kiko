// The header's right side, footer and dictation caption of the settings screen zoomed to the whole
// window (src/ui/tui.ts), shared with the Kiko window's classic look (tmux 3.8 and later:
// src/terminals/tmux/classic.ts), which has one line under its panels, its last, and the caption
// over them: the app renders them here (renderToString, the same Ink as the full screen), and the
// window's frame pane paints them (src/terminals/tmux/frame-pane.ts, fed by src/ui/window-frame.ts).
//
// The window's line (frameLines) has three zones. Left, Kiko's state as the tiled look's bottom
// line words it (src/ui/bar.ts doing, waitingOn: one piece of logic for both), drawn the full
// screen's way: a red badge and the mic's waveform while listening, a spinner while deciding (after
// a moment) or checking. Middle, what the full screen's header has on its right (aboutText, the
// mic), dim. Right, the keys the window takes (q quits there, and the menu's key, which can
// change), dim; the menu's words are its button. No timings (the log has them: press_done).
import React from "react";
import { Box, Text, renderToString } from "ink";
import { micHeader } from "../core/mic-device.ts";
import { spokenName } from "../core/name.ts";
import { plainLine } from "../core/text.ts";
import { sessionStatus, type UiState } from "../core/ui-store.ts";
import { captionWidth } from "../terminals/tmux/classic.ts";
import { menuKeyName } from "../terminals/tmux/keys.ts";
import { connectingTo, doing, noticeSpans, waitingOn, type Span } from "./bar.ts";
import { markFor } from "./marks.ts";
import { bars, METER_LENGTH } from "./meter.ts";
import { REPEAT_KEY } from "./nav.ts";

const h = React.createElement;

// After key up, "deciding…" shows only once working out where your words go takes longer than
// this, so quick ones go straight from listening to where they went.
export const DECIDING_SHOWN_AFTER_MS = 500;

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
export const spinner = (now = Date.now()) => SPINNER[Math.floor(now / 100) % SPINNER.length];

/**
 * What the full screen's header's right side says (and the window's line's middle): muted,
 * silent, the voice, the model, the classifier, what it cost. Silent only when the Mac really is (macPlays): Play on this Mac off and a phone playing what's said, not
 * while the Mac stands in for a phone that's closed, in the background or locked.
 */
/** Said while the phone plays what's said instead of the Mac. Plain words: no symbol or emoji (the user, 2026-11-05). */
export const SILENT_HERE = "silent on this Mac";

/** The window's line, right: what it's set to, without the voice's name or the classifier (the full screen's header keeps them: aboutText). */
const windowAbout = (s: UiState) => [s.muted ? "muted" : "", s.macPlays ? "" : SILENT_HERE, s.about.model, dollars(s)].filter(Boolean).join(" · ");

export const aboutText = (s: UiState) =>
  [s.muted ? "muted" : "", s.macPlays ? "" : SILENT_HERE, s.about.voice, s.about.model, s.about.classifier ? "Classifier" : "", dollars(s)].filter(Boolean).join(" · ");

/** What Kiko has cost this run ("$0.012"); nothing while no dollars are shown (on the subscription: core/dollars.ts). */
const dollars = (s: UiState) => (typeof s.cost === "number" ? `$${s.cost.toFixed(3)}` : "");

/**
 * The full screen's header's right side: what it's set to, cut from its start, a newer Kiko in
 * cyan when there is one, and the mic in use whole at the far right, in yellow while it stands in
 * for a wired one you chose that's away (never for a Bluetooth one: mic-device.ts micHeader).
 */
export function headerRight(s: UiState): React.ReactNode[] {
  const mic = micHeader(s.mic);
  return [
    h(Text, { key: "about", dimColor: true, wrap: "truncate-start" }, aboutText(s)),
    // A newer Kiko (core/updates/): never cut, quiet but not dim.
    s.update ? h(Box, { key: "update", flexShrink: 0 }, h(Text, { color: "cyan" }, plainLine(s.update))) : null,
    mic.text ? h(Box, { key: "mic", flexShrink: 0 }, h(Text, mic.warn ? { color: "yellow" } : { dimColor: true }, mic.text)) : null,
  ];
}

/** The listening badge: who listens (hands-free: the name once it's heard, or "reply" for a reply without it). */
export const badge = (by: "name" | "reply" | null | undefined) => (by === "name" ? ` ● ${spokenName().toUpperCase()} ` : by === "reply" ? " ● REPLY " : " ● LISTENING ");

/** A state's spans as Ink text: a name in its agent's colour (marks.ts) where the span has no colour of its own. */
function spansNode(spans: Span[], s: UiState, key: string) {
  return h(Text, { key }, ...spans.map((x, i) => h(Text, { key: i, color: x.fg ?? (x.session ? markFor(s.sessions, x.session, s.icons)?.color : undefined), bold: x.bold }, x.text)));
}

/**
 * The window's line, left: what Kiko is doing (listening: the badge and the waveform from
 * `levels`, newest on the right; deciding: what showed before for its first moment, then a spinner; checking:
 * a spinner; ready: "ready", dim, and how many sessions are working when any is ("ready · 2
 * working": in a turn, never one only running something in the background); hands-free's "listening
 * for 'Kiko'", a mode it's in), the notice, who waits for you; " · " between them, none before
 * the first that shows. Never blank: a moment with nothing new to say keeps what was there
 * (`held`), so it goes from one state straight to the next.
 */
let held: React.ReactNode = null;

/** Forgets what the window's line's left last showed (tests: each starts from nothing). */
export const forgetHeldStatus = () => void (held = null);

export function Status({ s, now, notice = "", levels }: { s: UiState; now: number; notice?: string; levels: readonly number[] }) {
  const d = doing(s, now);
  const first =
    d.kind === "listening"
      ? h(
          Text,
          { key: "doing" },
          h(Text, { backgroundColor: "red", color: "white", bold: true }, badge(d.by)),
          " ",
          // The mic not giving sound yet (a Bluetooth one connecting): said where its level would be flat.
          s.micConnecting ? h(Text, { color: "yellow" }, connectingTo(s.micConnecting)) : h(Text, { color: "red" }, bars(levels)),
        )
      : d.kind === "deciding"
        ? s.deciding && now - s.deciding.startedAt > DECIDING_SHOWN_AFTER_MS
          ? h(Text, { key: "doing", dimColor: true }, `${spinner(now)} deciding…`)
          : null
        : d.kind === "checking"
          ? h(Text, { key: "doing", color: "yellow" }, `${spinner(now)} checking…`)
          : d.kind === "ready" && !s.handsFree.on
            ? null
            : spansNode(d.spans, s, "doing");
  const more = [...noticeSpans(notice), ...waitingOn(s, now)].map((x, i) => spansNode(x, s, `p${i}`));
  const working = s.sessions.filter((x) => sessionStatus(x, s) === "working").length;
  const sessions = d.kind !== "ready" || s.handsFree.on ? null : h(Text, { key: "ready", dimColor: true }, working ? `ready · ${working} working` : "ready");
  const lead = first ?? sessions ?? held;
  if (first ?? sessions) held = lead;
  const parts = [lead, ...more].filter(Boolean);
  return h(Text, { wrap: "truncate-end" }, ...parts.flatMap((p, i) => (i ? [h(Text, { key: `sep${i}`, dimColor: true }, " · "), p] : [p])));
}

/** The full screen's keys, in its footer. */
export const FULL_SCREEN_KEYS = `${REPEAT_KEY} repeat · m mute · 1-9 pick session · s settings · q quit`;
/** The window's: the same keys as its list takes them (q or Q quits there, pressed twice: quit-again.ts), and the menu's key, which can change. */
export const windowKeys = () => `${REPEAT_KEY} repeat · m mute · ${menuKeyName()} menu`;
/** The window's keys' last words, the menu's: a click on them in the window opens the menu (window.ts MENU_CLICK). */
const menuWords = () => `${menuKeyName()} menu`;

/** The footer: the last timings dim on the left (quitting's hint in their place while it's up: `quit`), the keys dim on the right (on the main screen). */
export function Footer({ s, keys = FULL_SCREEN_KEYS, columns, quit = null }: { s: UiState; keys?: string; columns?: number; quit?: string | null }) {
  return h(
    Box,
    { justifyContent: "space-between", paddingX: 1, gap: 2, height: 1, ...(columns ? { width: columns } : {}) },
    quit ? h(Text, { color: "yellow", bold: true, wrap: "truncate-end" }, quit) : h(Text, { dimColor: true, wrap: "truncate-end" }, s.lastTiming ? `⏱ ${s.lastTiming}` : ""),
    s.screen === "main" ? h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, keys)) : null,
  );
}

// ── The caption: what you're saying, live ──

/** Lines a caption shows at most: the last ones, so the newest words are always in. */
export const CAPTION_LINES = 3;

/** Splits text into lines of at most `width` columns, breaking between words. */
export function wrapWords(text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The caption's width for a screen this wide, its border included (the window's caption box is as wide). */
export { captionWidth };

/** What the caption shows, in a caption this wide (its border and a column each side inside it): the last CAPTION_LINES lines of `said`; none before words come. */
export const captionLines = (said: string, width: number) => wrapWords(plainLine(said), Math.max(1, width - 4)).slice(-CAPTION_LINES);

// ── The window's bottom line, rendered ──

/** A waveform of nothing yet: what it starts from each time you talk. */
export const quietLevels = () => Array<number>(METER_LENGTH).fill(0);

const ANSI = /\x1b\[[0-9;:]*m/g;
/** One rendered line of Ink, `columns` wide at most. */
const line = (node: React.ReactElement, columns: number) => renderToString(node, { columns }).split("\n")[0] ?? "";

/**
 * The cells a node takes on one line as Ink lays it out (and tmux draws it: they agree, where
 * viewer.ts width counts the mic's 🎙 as two): put at the right end of a wide line after a mark,
 * it's what the spaces before the mark leave.
 */
function cellsIn(node: React.ReactNode, max = 2000): number {
  const out = line(h(Box, { width: max, justifyContent: "flex-end" }, h(Text, null, "|"), node), max).replace(ANSI, "");
  return Math.max(0, max - 1 - out.indexOf("|"));
}
/** cellsIn for plain text, kept (the keys and what it's set to change seldom; the line is drawn up to 20 times a second). */
const measured = new Map<string, number>();
function textCells(text: string): number {
  let n = measured.get(text);
  if (n === undefined) {
    if (measured.size > 200) measured.clear();
    measured.set(text, (n = cellsIn(h(Text, null, text))));
  }
  return n;
}

/** Space between the bottom line's zones, at least. */
const ZONE_GAP = 2;
/** Between what it's set to and the keys. */
const SEP = " · ";
/** The info (the middle zone) is shown cut down to this many cells, no fewer (else not at all). */
const MIN_INFO = 12;

/** The bottom line's middle: what it's set to (aboutText) and the mic, dim (the mic yellow while it stands in for a wired one that's away), with a newer Kiko between them in cyan. */
function info(s: UiState) {
  // The mic by its name alone, no 🎙 (the full screen's header has it).
  const mic = { ...micHeader(s.mic), text: micHeader(s.mic).text.replace(/^🎙 /, "") };
  const about = windowAbout(s);
  // A newer Kiko (core/updates/), after what it's set to: cut from the start, it's kept longest but for the mic.
  const update = s.update ? plainLine(s.update) : "";
  // The free trial (app/settings/account.ts): after what it's set to, dim, yellow near its end.
  const plan = s.plan ? plainLine(s.plan.text) : "";
  const before = about && plan ? " · " : "";
  const mid = (about || plan) && update ? " · " : "";
  const sep = mic.text && (about || plan || update) ? " · " : "";
  const node = h(
    Text,
    { wrap: "truncate-start" },
    h(Text, { dimColor: true }, about + before),
    plan ? h(Text, s.plan!.warn ? { color: "yellow" } : { dimColor: true }, plan) : null,
    h(Text, { dimColor: true }, mid),
    update ? h(Text, { color: "cyan" }, update) : null,
    h(Text, { dimColor: true }, sep),
    mic.text ? h(Text, mic.warn ? { color: "yellow" } : { dimColor: true }, mic.text) : null,
  );
  return { node, cells: textCells(about + before + plan + mid + update + sep + mic.text) };
}

/**
 * The window's one line, its last (the classic look has no header), for a frame `columns` wide, as
 * terminal text, and where the menu's words start on it (cells from the left; -1 when they're not
 * on it), for a click there. The state on the left (Status); on the right, ZONE_GAP from it at
 * least, one dim group: what it's set to (windowAbout and the mic), then the keys: the list's
 * (windowKeys) while it has the keyboard, else (`keys: "stage"`: a session, a viewer, Kiko's
 * page) only the menu's, the one key that works there. Narrow, what it's set to gives way first
 * (cut from its start, then gone), then the keys (from the left, the menu's last), then the state
 * (cut at its end, once it alone is wider than the line).
 */
export function frameLines(s: UiState, columns: number, at: { now?: number; notice?: string; levels?: readonly number[]; keys?: "list" | "stage" } = {}): { bottom: string; menuAt: number } {
  const now = at.now ?? Date.now();
  const status = h(Status, { s, now, notice: at.notice, levels: at.levels ?? quietLevels() });
  const room = Math.max(0, columns - 2); // a column each side
  const stateW = Math.min(room, cellsIn(status));
  // The keys: all, or as many as fit from the right, the menu's the last to go.
  const items = at.keys === "stage" ? [menuWords()] : windowKeys().split(" · ");
  let keys = "";
  for (let i = 0; i < items.length && !keys; i++) {
    const k = items.slice(i).join(" · ");
    if (stateW + ZONE_GAP + textCells(k) <= room) keys = k;
  }
  const keysW = keys ? textCells(keys) : 0;
  // What it's set to, just before the keys, only while every key is there.
  const between = room - stateW - keysW;
  const { node: setTo, cells: full } = info(s);
  const infoW = keys === items.join(" · ") ? Math.min(full, between - ZONE_GAP - SEP.length) : 0;
  const shown = keys !== "" && infoW > 0 && infoW >= Math.min(full, MIN_INFO);
  const bottom = line(
    h(
      Box,
      { paddingX: 1, height: 1, width: columns },
      h(Box, { width: stateW, flexShrink: 0, overflow: "hidden" }, status),
      h(Box, { flexGrow: 1 }),
      shown ? h(Box, { width: infoW, flexShrink: 0, overflow: "hidden" }, setTo) : null,
      shown ? h(Text, { dimColor: true }, SEP) : null,
      keys ? h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, keys)) : null,
    ),
    columns,
  );
  const words = menuWords();
  return { bottom, menuAt: keys.endsWith(words) ? columns - 1 - textCells(words) : -1 };
}
