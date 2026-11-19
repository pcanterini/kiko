// The Kiko window's list (src/ui/window-glue.ts): the TUI as a narrow pane beside the page shown.
// Kiko's own page first (0), the brand's square its icon, pulsing while Kiko listens or speaks, and
// "Kiko" its name (./wordmark.ts), then every session Kiko knows, numbered, the one shown marked,
// each with its agent's mark and in its agent's colour (marks.ts), and its state as the phone
// shows it (after a dim tag for its permission mode when that isn't the one sessions start in:
// "plan", "auto", "bypass", core/permission-mode.ts); those in Kiko's tmux first, the others
// under "external"; then a line to start a new one. A permission prompt or Claude's question held by
// Kiko shows as a card at the bottom, just above the keys, answered here with its keys or a
// click; the sessions stay where they are. The project picker (c) and renaming a session take the
// list's place while they're open.
//
// Keys reach this pane only while it's the active one, so typing in a session never sets them off.
// Picking here previews: a number, ↑ ↓ (each page passed), n p l and a click show that page in the
// stage and leave the keyboard in the list, to flip through them; Enter or → goes into the one
// highlighted (the keyboard there), as Tab goes to the one shown. q (or Q, or Ctrl+C) puts quitting's
// hint on the keys' line, and the same again (or y) within QUIT_AGAIN_MS quits (./quit-again.ts).
// While the plan refuses Kiko's AI (the trial ended, today's share used: UiState keyOffer), two
// yellow lines at the bottom say so, and e (or a click on them) opens your own key's paste
// (app/key-offer.ts).
// Every word drawn here that came from elsewhere (a session's name, a command it wants to run, a
// question, a folder) goes through plainText: an escape sequence in it would reach the terminal.
// The mouse: the list asks for clicks (src/ui/input.ts), so tmux passes them on after moving the
// keyboard here; a click shows that page (the keyboard staying here), a right-click on a session
// opens its menu. The whole pane is drawn as rows of one line each, so a click's row is the line it's on.
//
// In the window's classic look (tmux 3.8 and later: src/terminals/tmux/classic.ts) the list is a box
// of its own, titled "Sessions" by tmux, and its rows are the full-screen UI's: two lines each (the
// name, then its state and what it's on, under it), a column in from the border. The cursor's row
// has a quiet blue background, a little lighter while the list has the keyboard (its focus reports:
// src/ui/input.ts), its name bold and its second line brighter; the others' second lines dim.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdout, useWindowSize, type Key } from "ink";
import { log } from "../core/log.ts";
import { ADD_KEY_KEY, type KeyOfferWhy } from "../core/account/plan-words.ts";
import { sessionDetail, sessionName } from "../core/sessions.ts";
import { plainText } from "../core/text.ts";
import { backgroundNote, sessionStatus, ui, type Picker, type SessionStatus, type UiState } from "../core/ui-store.ts";
import { windowEvents, type Pointer } from "./input.ts";
import { canDo, currentPage, DESKTOP_MARK, inDesktop, listCommand, pages, PAGE_ID, RENAME_KEY, REPEAT_KEY, type Page } from "./nav.ts";
import { MARK_SLOT, markFor, sessionMark, slotted } from "./marks.ts";
import { TRUST_MEANS } from "../core/trust-prompt.ts";
import { DEFAULT_NEW_SESSION_MODE, modeTag } from "../core/permission-mode.ts";
import { LIST_INDENT } from "./loading.ts";
import { colorDepth, type ColorDepth } from "./cli-style.ts";
import { QUIT_AGAIN_MS, quitHintFor, quitsAgain, stillAsking, type QuitBy } from "./quit-again.ts";
import { Wordmark, wordmarkPulses } from "./wordmark.ts";

const h = React.createElement;

const STATUS: Record<SessionStatus, { text: string; color: string }> = {
  needs_you: { text: "needs you", color: "red" },
  waiting: { text: "waiting", color: "yellow" },
  working: { text: "working", color: "green" },
  idle: { text: "idle", color: "gray" },
  starting: { text: "starting", color: "cyan" },
};

/** The narrow list keeps this much of a session's name (or all of a shorter one) before what it runs in the background shows. */
const NAME_ROOM = 8;

/**
 * The row the cursor is on: a quiet grey across the whole row (#3a3a3a, a step above the borders'
 * bar), its name bold. Never the name's own colour as a block (inverse): a pink or green slab.
 */
const CURSOR_BG = "#3a3a3a";
/** The classic look's: while the list has the keyboard, and while it hasn't (the preview's variants 2 and 3). */
const CLASSIC_CURSOR_BG = "#3b4270";
const CLASSIC_CURSOR_BG_REST = "#2d2f3b";
/** The cursor row's second line in the classic look: brighter than the others' (dim). */
const CLASSIC_CURSOR_DETAIL = "#c3c7dc";

/**
 * Text broken into lines of at most `width` at spaces, for the narrow pane: Ink's own wrapping
 * starts a line with the space it broke at. A word longer than a line is cut.
 */
export function wrapWords(text: string, width: number): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; w = w.slice(width)) {
      const part = w.slice(0, width);
      if (line && line.length + 1 + part.length <= width) line += ` ${part}`;
      else {
        if (line) lines.push(line);
        line = part;
      }
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** One row of the pane: what's drawn, and what a click (or right-click) on it does. `x`: the click's column in the row's text (0 the first). */
type Row = { key: string; node: React.ReactNode; bg?: string; click?: (x: number) => void; right?: (p: Pointer) => void };

const text = (key: string, node: React.ReactNode, more: Partial<Row> = {}): Row => ({ key, node, ...more });
/** Where a row's text starts in the pane: two columns in, in line with the pane's name on the border bar above (in the classic look's box, one: CLASSIC_INDENT). The starting screen's too (loading.ts). */
const TILED_INDENT = LIST_INDENT.tiled;
const CLASSIC_INDENT = LIST_INDENT.classic;

function useTick(ms: number, on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms, on]);
}

// ── The card: a permission prompt or Claude's questions, held by Kiko ──

/** Choices on one line when they fit, else one a line; each with the columns it takes, for a click. */
function buttons(parts: Array<{ key: string; word: string; color: string; act: () => void }>, room: number, edge: string, color: string): Row[] {
  const one = parts.map((p) => `${p.key} ${p.word}`).join("  ");
  const side = (node: React.ReactNode, pad: number) => h(Text, null, h(Text, { key: "l", color }, `${edge} `), node, " ".repeat(Math.max(0, pad)), h(Text, { key: "r", color }, ` ${edge}`));
  const label = (p: (typeof parts)[number]) => [h(Text, { key: `k${p.key}`, color: p.color, bold: true }, p.key), ` ${p.word}`];
  if (one.length <= room) {
    let at = 0;
    const spans = parts.map((p) => {
      const span = { from: at, to: at + p.key.length + 1 + p.word.length, act: p.act };
      at = span.to + 2;
      return span;
    });
    const node = h(Text, { key: "b" }, ...parts.flatMap((p, i) => [...label(p), i < parts.length - 1 ? "  " : ""]));
    return [text("buttons", side(node, room - one.length), { click: (x) => spans.find((s) => x - 2 >= s.from && x - 2 < s.to)?.act() })];
  }
  return parts.map((p) => text(`button-${p.key}`, side(h(Text, { key: "b" }, ...label(p)), room - p.key.length - 1 - p.word.length), { click: () => p.act() }));
}

/** The card's rows: drawn here, line by line, so its height (and where a click lands) is known. */
function cardRows(s: UiState, width: number): Row[] {
  const p = s.permission;
  if (!p) return [];
  const color = p.risky ? "red" : "yellow";
  const room = Math.max(8, width - 4); // the border and a space each side
  const line = (key: string, node: React.ReactNode, used: number, more: Partial<Row> = {}) =>
    text(key, h(Text, null, h(Text, { key: "l", color }, "│ "), node, " ".repeat(Math.max(0, room - used)), h(Text, { key: "r", color }, " │")), more);
  const wrapped = (key: string, words: string, max: number, style: object = {}) =>
    wrapWords(words, room)
      .split("\n")
      .slice(0, max)
      .map((l, i) => line(`${key}${i}`, h(Text, { key: "t", ...style }, l), l.length));
  // Who asks: its agent's mark and its name, in the agent's colour (marks.ts); the terminal's own,
  // and no mark, for one no longer listed. The mark in its slot (marks.ts), counted as the slot's
  // cells whatever the glyph's length (an astral one is two in JavaScript, one on screen).
  const mark = markFor(s.sessions, p.sessionId, s.icons);
  const nameColor = mark?.color;
  const who = plainText(p.name)
    .replace(/\s+/g, " ")
    .slice(0, room - 2 - (mark ? MARK_SLOT : 0));
  const name = `${mark ? slotted(mark.glyph) : ""}${who}`;
  const nameWidth = (mark ? MARK_SLOT : 0) + who.length;
  const rows: Row[] = [text("top", h(Text, { color }, `╭${"─".repeat(width - 2)}╮`))];
  const left = s.waiting?.kind === "permission" && s.waiting.until !== null ? Math.max(0, Math.ceil((s.waiting.until - Date.now()) / 1000)) : 0;
  const q = p.questions?.[p.asking ?? 0];
  if (p.questions && q) {
    const of = p.questions.length > 1 ? ` ${(p.asking ?? 0) + 1}/${p.questions.length}` : "";
    rows.push(
      line(
        "who",
        [h(Text, { key: "m", color: "yellow", bold: true }, "? "), h(Text, { key: "n", color: nameColor, bold: true }, name), h(Text, { key: "o", dimColor: true }, ` asks${of}`)],
        2 + nameWidth + 5 + of.length,
      ),
    );
    rows.push(...wrapped("q", plainText(q.header ? `${q.header}: ${q.question}` : q.question).replace(/\s+/g, " "), 4));
    q.options.slice(0, 9).forEach((o, i) => {
      const label = plainText(`${o.label}`)
        .replace(/\s+/g, " ")
        .slice(0, room - 2);
      rows.push(
        line(`opt${i}`, [h(Text, { key: "k", color: "green", bold: true }, String(i + 1)), ` ${label}`], 2 + label.length, {
          click: () => ui.act({ type: "answer", option: i + 1, id: p.id, asking: p.asking ?? 0 }),
        }),
      );
    });
    rows.push(line("decline", [h(Text, { key: "k", color: "red", bold: true }, "n"), " decline"], 9, { click: () => ui.act({ type: "deny", id: p.id }) }));
    const hint = left ? `or say it · ${left}s` : "or say your answer";
    rows.push(line("hint", h(Text, { key: "h", dimColor: true }, hint.slice(0, room)), Math.min(room, hint.length)));
  } else {
    rows.push(line("who", [h(Text, { key: "m", color, bold: true }, "⚠ "), h(Text, { key: "n", color: nameColor, bold: true }, name)], 2 + nameWidth));
    rows.push(...wrapped("what", plainText(`wants to ${p.what}`).replace(/\s+/g, " "), 3));
    // An agent's trust question (a folder's, Codex's hooks; not a tool): what trusting means, and no "always".
    const trusting = Boolean(p.folder || p.means);
    if (trusting) rows.push(...wrapped("means", p.means ?? TRUST_MEANS, 2, { dimColor: true }));
    rows.push(
      ...buttons(
        [
          { key: "y", word: trusting ? "trust" : "allow", color: "green", act: () => ui.act({ type: "allow", always: false, id: p.id }) },
          // A trust question, and a block allowed anyway, are once or not at all.
          ...(trusting || p.once ? [] : [{ key: "a", word: "always", color: "green", act: () => ui.act({ type: "allow", always: true, id: p.id }) }]),
          { key: "n", word: trusting ? "don't trust" : "deny", color: "red", act: () => ui.act({ type: "deny", id: p.id }) },
        ],
        room,
        "│",
        color,
      ),
    );
    const hint = p.risky ? "risky: say “allow it”" : left ? `or say yes / no · ${left}s` : "or say yes / no";
    rows.push(line("hint", h(Text, { key: "h", dimColor: !p.risky, color: p.risky ? "red" : undefined }, hint.slice(0, room)), Math.min(room, hint.length)));
  }
  rows.push(text("bottom", h(Text, { color }, `╰${"─".repeat(width - 2)}╯`)));
  return rows;
}

// ── The list ──

/** Kiko's icon and name on its row (./wordmark.ts): the brand's square in the icon column, whatever the icons setting, then "Kiko" in the names'. */
const kikoName = (s: UiState, depth: ColorDepth) => h(Wordmark, { key: "w", pulsing: wordmarkPulses(s), depth });

/** ► (gray) on the one shown while you're in it (the keyboard in the stage); browsing the list, the highlight says it. */
const inItMark = (inIt: boolean) => h(Text, { color: "gray" }, inIt ? "►" : " ");

function PageRow({ s, page, shown, cursor, inIt, width, depth }: { s: UiState; page: Page; shown: boolean; cursor: boolean; inIt: boolean; width: number; depth: ColorDepth }) {
  // Never squeezed by a long name: the number and the mark keep their columns.
  const number = h(Box, { key: "n", flexShrink: 0 }, h(Text, { dimColor: !cursor }, page.n === null ? " " : String(page.n)));
  const mark = h(Box, { key: "m", flexShrink: 0 }, inItMark(inIt));
  if (!page.session) {
    // The brand's square and pale name, never a session's blue: its old blue (#87afd7) was too close to
    // Codex's (#63a8f8). Its name gives way (cut with …) as a session's does.
    return h(Box, { gap: 1, flexGrow: 1 }, number, mark, h(Box, { key: "name", flexGrow: 1, flexShrink: 1, overflow: "hidden" }, h(Text, { wrap: "truncate-end" }, kikoName(s, depth))));
  }
  const session = page.session;
  const status = STATUS[sessionStatus(session, s)];
  // Its agent's mark in its slot, then its name, both in the agent's colour (marks.ts).
  const agentMark = sessionMark(session, s.icons);
  // Its permission mode, only when it isn't the one the setting starts sessions in (nor unknown):
  // dim, before its state, so the list says no more than usual for the usual ones.
  const tag = modeTag(session.mode, s.newSessionMode ?? DEFAULT_NEW_SESSION_MODE);
  // What it runs in the background, said short ("2 bg"): the pane is narrow. It gives way before the
  // name does: its quiet flag first, then all of it, so the name keeps NAME_ROOM (or all of itself).
  const name = plainText(sessionName(session));
  const named = name.length + (session.kind === "background" ? " (background)".length : 0) + (inDesktop(session) ? 2 : 0);
  // Its number and ► with a space after each, the mark's slot, a space, then the state's own.
  const fixed = String(page.n ?? " ").length + 3 + MARK_SLOT + 1 + (tag ? tag.length + 1 : 0) + 2 + status.text.length;
  const keeps = (note: string) => width - fixed - (note ? note.length + 3 : 0) >= Math.min(named, NAME_ROOM);
  const full = backgroundNote(session, true);
  const background = [full, full.replace(/ \(.*\)$/, ""), ""].find(keeps) ?? "";
  // The name gives way (cut with …) before the state does.
  return h(
    Box,
    { gap: 1, flexGrow: 1 },
    number,
    mark,
    h(
      Box,
      { key: "name", flexGrow: 1, flexShrink: 1, overflow: "hidden" },
      h(
        Text,
        { wrap: "truncate-end" },
        h(Text, { color: agentMark.color, bold: shown || cursor }, `${slotted(agentMark.glyph)}${name}`),
        session.kind === "background" ? h(Text, { dimColor: true }, " (background)") : null,
        inDesktop(session) ? h(Text, { dimColor: true }, ` ${DESKTOP_MARK}`) : null,
      ),
    ),
    h(
      Box,
      { key: "state", flexShrink: 0 },
      tag ? h(Text, { dimColor: true }, `${tag} `) : null,
      h(Text, { color: status.color }, "● "),
      h(Text, { dimColor: status.color === "gray" }, status.text),
      // What it still runs in the background, dim: never part of its state.
      background ? h(Text, { dimColor: true }, ` · ${background}`) : null,
    ),
  );
}

/**
 * A page's two lines in the classic look, the full-screen UI's: its number, ► when you're in it
 * (inItMark), its agent's mark and name in the agent's colour (bold on the cursor's row); under the
 * name, its state (a dot in its colour) and what it's on (its folder, or Claude's title for it),
 * after its permission mode's tag when that isn't the usual one. Kiko's own: its square and name, then "the conversation".
 */
function classicRows(s: UiState, page: Page, inIt: boolean, cursor: boolean, width: number, depth: ColorDepth): [React.ReactNode, React.ReactNode] {
  const number = h(Text, { dimColor: !cursor }, page.n === null ? " " : String(page.n));
  const mark = inItMark(inIt);
  const second = (node: React.ReactNode[]) => h(Text, { wrap: "truncate-end" }, "    ", ...node);
  const quiet = (text: string, key: string) => h(Text, { key, ...(cursor ? { color: CLASSIC_CURSOR_DETAIL } : { dimColor: true }) }, text);
  if (!page.session) {
    return [h(Text, { wrap: "truncate-end" }, number, " ", mark, " ", kikoName(s, depth)), second([quiet("the conversation", "d")])];
  }
  const session = page.session;
  const status = STATUS[sessionStatus(session, s)];
  const agentMark = sessionMark(session, s.icons);
  const tag = modeTag(session.mode, s.newSessionMode ?? DEFAULT_NEW_SESSION_MODE);
  const name = plainText(sessionName(session));
  const background = backgroundNote(session);
  const room = Math.max(8, width - 4 - status.text.length - (tag ? tag.length + 3 : 0) - (background ? background.length + 3 : 0) - 5);
  const detail = plainText(sessionDetail(session, room));
  return [
    h(
      Text,
      { wrap: "truncate-end" },
      number,
      " ",
      mark,
      " ",
      h(Text, { color: agentMark.color, bold: cursor }, `${slotted(agentMark.glyph)}${name}`),
      session.kind === "background" ? h(Text, { dimColor: true }, " (background)") : null,
      inDesktop(session) ? h(Text, { dimColor: true }, ` ${DESKTOP_MARK}`) : null,
    ),
    second([
      ...(tag ? [quiet(`${tag} · `, "t")] : []),
      h(Text, { key: "s", color: status.color }, "● "),
      quiet(status.text, "w"),
      ...(background ? [quiet(` · ${background}`, "b")] : []),
      ...(detail ? [quiet(` · ${detail}`, "d")] : []),
    ]),
  ];
}

/** A heading in the list: "── EXTERNAL ──", cut to the pane. */
const heading = (label: string, width: number) => h(Text, { dimColor: true, wrap: "truncate-end" }, `── ${label} ──`.slice(0, Math.max(4, width)));

/** The list's choices in its order: Kiko, the sessions in its tmux, a new one (it opens there), then those outside. */
const choiceIds = (all: Page[]) => [...all.filter((p) => !p.outside).map((p) => p.id), "+new", ...all.filter((p) => p.outside).map((p) => p.id)];

/** What a typed line holds: printable characters only, as you typed or pasted them. */
const typed = (input: string) => input.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

const NAMED_KEYS = ["upArrow", "downArrow", "leftArrow", "rightArrow", "return", "escape", "tab", "backspace", "delete", "pageUp", "pageDown", "home", "end"] as const;
/** A key as the log names it: Enter, the arrows and the like by name, one printable character as itself, ⌃ and a letter as ctrl+…; anything else (a paste) "other". */
export function keyLabel(input: string, key: Key): string {
  const named = NAMED_KEYS.find((k) => key[k]);
  if (named) return named;
  if (input === " ") return "space";
  if (key.ctrl && /^[a-z]$/.test(input)) return `ctrl+${input}`;
  return /^[\x21-\x7e]$/.test(input) ? input : "other";
}

/** Rows `room` tall around the cursor's, when there are more than fit. */
function around<T>(all: T[], at: number, room: number): { shown: T[]; from: number } {
  if (all.length <= room) return { shown: all, from: 0 };
  const from = Math.max(0, Math.min(all.length - room, at - Math.floor(room / 2)));
  return { shown: all.slice(from, from + room), from };
}

// ── The project picker ──

type Choice = { key: string; label: string; detail: string; pick: () => void };

/** The picker's lines that are always there, on top: a new project, a scratch folder. */
const PICKER_TOP = 2;
/** How soon the same key again counts as the key held down (heldDown): above a Mac's repeat rate, under a deliberate second tap. */
const HELD_MS = 400;
/** The list's keys that act once (heldDown): repeat, mute, settings, new, trust, hide, last, quit, rename, your own key. */
const ONE_SHOT = [REPEAT_KEY, "m", "s", ",", "c", "t", "d", "l", "q", "Q", RENAME_KEY, ADD_KEY_KEY, ADD_KEY_KEY.toUpperCase()];

/** The list's line while the plan refuses Kiko's AI (UiState keyOffer), and the key's words under it. */
const OFFER_HEAD: Record<KeyOfferWhy, string> = { trial_ended: "Free trial ended: AI paused", daily_cap: "Today's trial share used up" };
const OFFER_ACTION = "add your own key";
/** A card's answers (and its options' numbers), held down: once. */
const CARD_KEYS = ["y", "a", "n"];

/** The picker's lines: a new project and a scratch folder first (always there), then the projects, narrowed by what's typed. */
function pickerChoices(p: Picker, filter: string, setNaming: (v: string) => void): Choice[] {
  const f = filter.toLowerCase();
  const projects = p.projects
    .filter((x) => !f || x.name.toLowerCase().includes(f) || x.detail.toLowerCase().includes(f))
    .map((x) => ({ key: x.cwd, label: x.name, detail: x.detail, pick: () => ui.act({ type: "start", pick: { project: x.cwd } }) }));
  return [
    { key: "+new", label: "+ new project…", detail: "", pick: () => setNaming(filter) },
    { key: "+scratch", label: "◌ scratch folder", detail: "", pick: () => ui.act({ type: "start", pick: { scratch: true } }) },
    ...projects,
  ];
}

/** Quitting asked: by which key, and when (its hint goes QUIT_AGAIN_MS after). */
type QuitAsk = { by: QuitBy; at: number };
/** Ctrl+C on the splash (tui.ts): the list, as it comes next, starts with quitting's hint up from then. */
let carried: QuitAsk | null = null;
/** The splash's Ctrl+C: quits when it's the second (carried still up), else carried to the list. True when it quit. */
export function splashCtrlC(): boolean {
  const was = carried;
  carried = null;
  if (was && stillAsking(was.at, Date.now())) return (ui.act({ type: "quit" }), true);
  carried = { by: "ctrl-c", at: Date.now() };
  return false;
}

/**
 * Quitting's hint, as the list and the settings screen keep it (./quit-again.ts): `asked` (null
 * while it isn't up); `take(input, key)`, for each key before anything else: true when the key
 * was quitting's, and nothing else acts on it (the hint up: q, y, or Ctrl+C after Ctrl+C quits,
 * any other key only lets it go; or Ctrl+C: the hint put up, typing or not, what's typed kept);
 * `ask(by)` puts it up (q in the list). It goes by itself `ms` after (a test's shorter). Kept in
 * a ref too: a key right after another sees it before the screen is drawn again. `fromSplash`:
 * a Ctrl+C on the splash carried in (the list's).
 */
export function useQuitAsk(ms = QUIT_AGAIN_MS, fromSplash = false) {
  const [asked, setAsked] = useState<QuitAsk | null>(() => {
    if (!fromSplash) return null;
    const c = carried;
    carried = null;
    return c && stillAsking(c.at, Date.now(), ms) ? c : null;
  });
  const ref = useRef(asked);
  const ask = (by: QuitBy | null) => {
    ref.current = by ? { by, at: Date.now() } : null;
    setAsked(ref.current);
  };
  useEffect(() => {
    if (!asked) return;
    const timer = setTimeout(() => ref.current === asked && ask(null), Math.max(0, asked.at + ms - Date.now()));
    return () => clearTimeout(timer);
  }, [asked]);
  const take = (input: string, key: Pick<Key, "ctrl">): boolean => {
    const was = ref.current;
    if (was) {
      ask(null);
      // Up: quits, or only let go. Its time ran out: the key as without it.
      if (stillAsking(was.at, Date.now(), ms)) return (quitsAgain(was.by, input, key.ctrl) && ui.act({ type: "quit" }), true);
    }
    if (key.ctrl && input === "c") return (ask("ctrl-c"), true);
    return false;
  };
  return { asked, up: () => ref.current !== null, ask, take };
}

/** The list. `quitAgainMs`: how long quitting's hint stays up (QUIT_AGAIN_MS; a test's shorter). */
export function WindowList({ s, quitAgainMs = QUIT_AGAIN_MS }: { s: UiState; quitAgainMs?: number }) {
  const { columns, rows: height } = useWindowSize();
  // Kiko's square's colours: the pane's (NO_COLOR, a terminal with 256: the square steady).
  const depth = colorDepth(useStdout().stdout as { isTTY?: boolean });
  const all = pages(s);
  const shownId = currentPage(s);
  const [cursorId, setCursor] = useState<string | null>(null);
  // Quitting's hint (q, Q or Ctrl+C once): up until the same again (or y) quits, another key or the time lets it go.
  const quit = useQuitAsk(quitAgainMs, true);
  const quitting = quit.asked;
  // The picker's own: what's typed to narrow it, its cursor (on the first project when there's one), and a new project's name being typed (null: not naming one).
  const [filter, setFilter] = useState("");
  const [pickAt, setPickAt] = useState(-1); // -1: where it starts (pickCursor)
  const [naming, setNaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState<string | null>(null);
  const picker = s.window?.picker ?? null;
  const renaming = s.window?.renaming ?? null;
  useTick(250, Boolean(s.permission && s.waiting?.until));
  // The classic look: a box of its own, the full screen's rows, the cursor's row lighter while the list has the keyboard.
  const classic = s.window?.look === "classic";
  const INDENT = classic ? CLASSIC_INDENT : TILED_INDENT;
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    const onFocus = (on: boolean) => setFocused(on);
    windowEvents.on("focus", onFocus);
    return () => void windowEvents.off("focus", onFocus);
  }, []);
  const cursorBg = classic ? (focused ? CLASSIC_CURSOR_BG : CLASSIC_CURSOR_BG_REST) : CURSOR_BG;
  // The keyboard in the stage (tmux's active pane, window.ts): the one shown gets its ►.
  const inStage = Boolean(s.window?.inStage);

  // A picker or rename freshly opened starts empty.
  const pickerOpen = Boolean(picker);
  useEffect(() => {
    setFilter("");
    setPickAt(-1);
    setNaming(null);
  }, [pickerOpen]);
  useEffect(() => setRenameText(renaming ? renaming.name : null), [renaming?.sessionId]);

  // The choices on the list, in its order. The cursor stays on its choice as the list changes; else on the page shown.
  const choices = choiceIds(all);
  const cursor = cursorId && choices.includes(cursorId) ? cursorId : (shownId ?? PAGE_ID);
  // The highlight as the next key sees it, before the list is drawn again (keys held down come faster than that).
  const at = useRef(cursor);
  at.current = cursor;
  // The page shown changed elsewhere (voice, the menu, the phone): the highlight follows, if it was
  // on the one shown before. One that moved on (previews still on their way) is never pulled back.
  const wasShown = useRef(shownId);
  useEffect(() => {
    const was = wasShown.current;
    wasShown.current = shownId;
    if (was !== shownId) setCursor((c) => (c === null || c === was ? null : c));
  }, [shownId]);
  // A preview: the highlight on it, and a page shown in the stage, the keyboard staying here (window.ts
  // coalesces them: holding ↓ shows only the latest). "+ new session" shows nothing: the stage keeps what it had.
  const highlight = (id: string) => {
    at.current = id;
    setCursor(id);
    if (id !== "+new") ui.act({ type: "show", page: id, focus: false });
  };
  // Into it (Enter, →): shown if it isn't, and the keyboard there; on "+ new session", the picker.
  const enter = (id: string) => (id === "+new" ? ui.act({ type: "newSession" }) : ui.act({ type: "show", page: id }));
  const move = (by: number) => highlight(choices[(choices.indexOf(at.current) + by + choices.length) % choices.length]);
  // n and p: the page after or before the highlighted one (the one shown, from "+ new session"), round the ends, never "+ new session".
  const step = (by: number) => {
    const ids = all.map((p) => p.id);
    const from = Math.max(0, ids.indexOf(at.current === "+new" ? (shownId ?? PAGE_ID) : at.current));
    highlight(ids[(from + by + ids.length) % ids.length]);
  };

  const choicesInPicker = picker ? pickerChoices(picker, filter, setNaming) : [];
  // Where the picker's cursor starts, and goes back to as you type: the first project that fits
  // (typing narrows, Enter starts it), else "+ new project…" (Enter names it what you typed).
  const firstProject = choicesInPicker.length > PICKER_TOP ? PICKER_TOP : 0;
  const pickCursor = pickAt < 0 ? firstProject : Math.min(pickAt, Math.max(0, choicesInPicker.length - 1));
  const q = s.permission?.questions?.[s.permission.asking ?? 0];

  const onKey = (input: string, key: Key) => {
    // Quitting's first (useQuitAsk): its hint up, or Ctrl+C, typing or not.
    if (quit.take(input, key)) return;
    // Typing a name: a new project's, or a session's new one.
    const edit = (value: string, set: (v: string) => void, done: (v: string) => void, cancel: () => void) => {
      if (key.escape) return cancel();
      if (key.return) return done(value.trim());
      if (key.backspace || key.delete) return set(value.slice(0, -1));
      if (!key.ctrl && !key.meta && input) set((value + typed(input)).slice(0, 80));
    };
    if (renaming && renameText !== null) {
      return edit(
        renameText,
        setRenameText,
        (name) => name && ui.act({ type: "rename", sessionId: renaming.sessionId, name }),
        () => ui.act({ type: "renaming", sessionId: null }),
      );
    }
    if (picker) {
      if (naming !== null)
        return edit(
          naming,
          setNaming,
          (name) => name && ui.act({ type: "start", pick: { newProject: name } }),
          () => setNaming(null),
        );
      if (key.escape) return ui.act({ type: "closePicker" });
      if (key.upArrow) return setPickAt((pickCursor - 1 + choicesInPicker.length) % choicesInPicker.length);
      if (key.downArrow) return setPickAt((pickCursor + 1) % choicesInPicker.length);
      if (key.return) return choicesInPicker[pickCursor]?.pick();
      if (key.backspace || key.delete) return (setFilter(filter.slice(0, -1)), setPickAt(-1));
      if (!key.ctrl && !key.meta && input && typed(input)) return (setFilter((filter + typed(input)).slice(0, 40)), setPickAt(-1));
      return;
    }
    // A card on top: its keys first (n is "deny" while it's there, and nothing else; the digits its
    // options), for the one drawn (its id).
    const p = s.permission;
    if (p) {
      if (q && /^[1-9]$/.test(input) && Number(input) <= q.options.length) return ui.act({ type: "answer", option: Number(input), id: p.id, asking: p.asking ?? 0 });
      if (input === "n") return ui.act({ type: "deny", id: p.id });
      if (!q && input === "y") return ui.act({ type: "allow", always: false, id: p.id });
      if (!q && !p.folder && !p.means && !p.once && input === "a") return ui.act({ type: "allow", always: true, id: p.id });
    }
    // Picking here previews (↑ ↓, a number, n p l: shown, the keyboard stays in the list); Enter or →
    // goes into the one highlighted. Never Esc: Claude Code's interrupt.
    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);
    if (key.return) return enter(at.current);
    if (key.rightArrow) return void (at.current !== "+new" && enter(at.current));
    if (s.about.pttMode === "tap" && input === " ") return ui.act({ type: "talk" });
    if (/^[0-9]$/.test(input)) {
      const page = all.find((p) => p.n === Number(input));
      return void (page && highlight(page.id));
    }
    // The menu's letters (nav.ts COMMANDS), as there; plain Tab moves the keyboard to the session side.
    switch (key.tab ? "focus" : listCommand(input)) {
      case "next":
        return step(1);
      case "prev":
        return step(-1);
      case "last":
        // The one shown before (the app knows it): the highlight follows it there.
        setCursor(null);
        return ui.act({ type: "last", focus: false });
      case "new":
        return ui.act({ type: "newSession" });
      case "trust":
        return ui.act({ type: "trustScratch" });
      case "settings":
        return ui.act({ type: "settings" });
      case "focus":
        return ui.act({ type: "focusStage" });
      case "hide":
        return ui.act({ type: "detach" });
      case "quit":
        return quit.ask("q");
    }
    // r renames the highlighted session, as its right-click menu's Rename… (one it has: nothing on
    // Kiko's row, the new one's, or an outside session only Ghostty can't be sure of: canDo); .
    // says the last thing again.
    if (input === RENAME_KEY) {
      const p = all.find((x) => x.id === cursor);
      return void (p?.session && canDo(p.session).rename && ui.act({ type: "renaming", sessionId: p.session.sessionId }));
    }
    if (input === REPEAT_KEY) return ui.act({ type: "repeat" });
    if (input === "m") return ui.act({ type: "mute" });
    // e, while the plan refuses Kiko's AI (the trial ended, today's share used): your own key's paste.
    if (s.keyOffer && input.toLowerCase() === ADD_KEY_KEY) return ui.act({ type: "addKey" });
  };
  // A key held down acts once: its repeats (the terminal's own auto-repeat, or a kitty-protocol
  // "repeat") are dropped, so holding . or s doesn't say it again and again or open settings again
  // and again, and holding y doesn't answer the next card. Only the keys that act once (ONE_SHOT,
  // and a card's answers while it's up): moving (↑ ↓ j k n p), Enter, → and the numbers still
  // repeat, and typing a name or in the picker is never touched. Plain auto-repeat looks like the
  // same key again, quickly: one within HELD_MS of the last of it is taken as held, but not while
  // quitting's hint is up: q twice quickly quits (a kitty-protocol repeat is still a held key's).
  const lastKey = useRef({ input: "", at: 0 });
  const heldDown = (input: string, key: Key) => {
    const card = Boolean(s.permission);
    const once = ONE_SHOT.includes(input) || (card && (CARD_KEYS.includes(input) || /^[0-9]$/.test(input)));
    const typing = (renaming && renameText !== null) || picker;
    // The key before it, whatever it was: a held key repeats with nothing in between.
    const now = Date.now();
    const again = input === lastKey.current.input && now - lastKey.current.at < HELD_MS;
    lastKey.current = { input: key.upArrow || key.downArrow || key.return || key.rightArrow ? "" : input, at: now };
    if (!once || typing || key.ctrl || key.meta) return false;
    return key.eventType === "repeat" || (again && !quit.up());
  };
  // Each key that sets something off here, a line in the log (its name, and whether it's a key held
  // down's repeat): how a key acting twice shows next time. Typing a name or narrowing the picker
  // acts on nothing until Enter, so what's typed is never in it.
  useInput((input, key) => {
    if (heldDown(input, key)) return;
    let acted = false;
    const mark = () => void (acted = true);
    ui.on("action", mark);
    try {
      onKey(input, key);
    } finally {
      ui.off("action", mark);
    }
    if (acted) log("list_key", { key: keyLabel(input, key), ...(key.eventType && key.eventType !== "press" ? { type: key.eventType } : {}) });
  });

  // ── The rows, top to bottom ──
  const width = Math.max(10, columns - INDENT - 1); // clear of the border bar on the right
  const top: Row[] = [];
  let card: Row[] = [];
  let cursorRow = -1;
  if (renaming && renameText !== null) {
    const was = s.sessions.find((x) => x.sessionId === renaming.sessionId);
    top.push(text("rh", heading(plainText(`RENAME ${was ? sessionName(was) : ""}`).slice(0, width - 4), width)));
    top.push(text("rt", h(Text, { wrap: "truncate-start" }, h(Text, { color: "cyan" }, "› "), renameText, h(Text, { inverse: true }, " "))));
  } else if (picker) {
    if (naming !== null) {
      top.push(text("nh", heading("NEW PROJECT", width)));
      top.push(text("nt", h(Text, { wrap: "truncate-start" }, h(Text, { color: "cyan" }, "name › "), naming, h(Text, { inverse: true }, " "))));
      top.push(
        text(
          "nr",
          h(
            Text,
            { dimColor: !picker.root ? false : true, color: picker.root ? undefined : "yellow", wrap: "wrap" },
            picker.root ? plainText(`in ${picker.root.replace(/^\/Users\/[^/]+/, "~")}`) : "no projects folder: Settings → New sessions → Projects root",
          ),
        ),
      );
    } else {
      top.push(text("ph", heading("NEW SESSION IN", width)));
      top.push(text("pf", filter ? h(Text, { wrap: "truncate-start" }, h(Text, { color: "cyan" }, "› "), filter, h(Text, { inverse: true }, " ")) : h(Text, { dimColor: true }, "type to narrow it")));
      const room = Math.max(3, height - top.length - 3);
      const { shown, from } = around(choicesInPicker, pickCursor, room);
      shown.forEach((c, i) => {
        const at = from + i;
        // The name whole if it fits, where it is (its parent folder) after it, cut from the start.
        const room = Math.min(c.label.length, width - 2);
        const node = h(
          Box,
          { gap: 1, flexGrow: 1 },
          h(Box, { key: "l", width: room, flexShrink: 0, overflow: "hidden" }, h(Text, { wrap: "truncate-end", bold: at === pickCursor }, plainText(c.label))),
          c.detail ? h(Box, { key: "d", flexShrink: 1, flexGrow: 1, overflow: "hidden", justifyContent: "flex-end" }, h(Text, { dimColor: true, wrap: "truncate-start" }, plainText(c.detail))) : null,
        );
        top.push(text(`p-${c.key}`, node, { bg: at === pickCursor ? cursorBg : undefined, click: () => (setPickAt(at), c.pick()) }));
      });
    }
  } else {
    card = cardRows(s, width);
    const insideCount = all.filter((p) => p.session && !p.outside).length;
    // A page's rows: one (the tiled look), or the classic look's two, both answering a click as the row.
    const rowFor = (p: Page) => {
      const more: Partial<Row> = {
        bg: p.id === cursor ? cursorBg : undefined,
        click: () => highlight(p.id),
        right: p.session ? (ptr) => (setCursor(p.id), ui.act({ type: "rowMenu", sessionId: p.session!.sessionId, x: ptr.x, y: ptr.y })) : undefined,
      };
      if (!classic) {
        if (p.id === cursor) cursorRow = top.length;
        return top.push(text(`page-${p.id}`, h(PageRow, { s, page: p, shown: p.id === shownId, cursor: p.id === cursor, inIt: p.id === shownId && inStage, width, depth }), more));
      }
      const [first, second] = classicRows(s, p, p.id === shownId && inStage, p.id === cursor, width, depth);
      top.push(text(`page-${p.id}`, first, more), text(`page-${p.id}-2`, second, more));
      if (p.id === cursor) cursorRow = top.length - 1; // scrolled to keep both of its lines in view
    };
    rowFor(all[0]);
    // INTERNAL always, so there's plainly more than one kind: the sessions in Kiko's tmux, and a
    // new one (it opens there); then EXTERNAL, those outside, when there are any.
    top.push(text("h-inside", heading("INTERNAL", width)));
    for (const p of all.slice(1).filter((x) => !x.outside)) rowFor(p);
    if (!insideCount && !s.sessionsLoaded) top.push(text("none", h(Text, { dimColor: true }, "  looking…")));
    if (cursor === "+new") cursorRow = top.length;
    top.push(
      // Lined up with the sessions: its + (the text's colour, never taken for the green ►) in a mark's slot, past the number and ► columns.
      text("new", h(Text, { wrap: "truncate-end" }, "    ", slotted("+"), "new session", h(Text, { dimColor: true }, " (c)")), {
        bg: cursor === "+new" ? cursorBg : undefined,
        click: () => (setCursor("+new"), enter("+new")),
      }),
    );
    const outside = all.filter((x) => x.outside);
    if (outside.length) {
      top.push(text("h-outside", heading("EXTERNAL", width)));
      for (const p of outside) rowFor(p);
    }
  }

  // The bottom: a word from the app, muted, the card, and the keys (or quitting's question).
  const notes: Row[] = [];
  if (s.window?.note)
    wrapWords(plainText(s.window.note), width)
      .split("\n")
      .forEach((l, i) => notes.push(text(`note${i}`, h(Text, { color: "yellow" }, l))));
  // The plan refusing Kiko's AI, and the key that adds your own (app/key-offer.ts): a click on it does too.
  if (s.keyOffer) {
    const add = () => ui.act({ type: "addKey" });
    wrapWords(OFFER_HEAD[s.keyOffer.why], width)
      .split("\n")
      .forEach((l, i) => notes.push(text(`offer${i}`, h(Text, { color: "yellow" }, l), { click: add })));
    notes.push(text("offer-key", h(Text, { wrap: "truncate-end" }, h(Text, { color: "yellow", bold: true }, ADD_KEY_KEY), ` ${OFFER_ACTION}`), { click: add }));
  }
  if (s.muted) notes.push(text("muted", h(Text, { color: "magenta" }, "muted")));
  // The list's own keys, ` · ` between them like the others; a pane too narrow for that drops the
  // spaces round the dots before it cuts anything, so it's never cut sooner than plain spaces were.
  // Enter's (into the one highlighted: picking here only previews) first, only where it fits whole.
  // Not the menu's key: the window's line has it (one place for it, and a click there opens it).
  const listKeys = ["c new", "⇥ session"];
  const withOpen = ["⏎ open", ...listKeys];
  const listHint = [withOpen.join(" · "), withOpen.join("·")].find((hint) => hint.length <= width) ?? (listKeys.join(" · ").length <= width ? listKeys.join(" · ") : listKeys.join("·"));
  const keys = quitting
    ? h(Text, { color: "yellow", bold: true, wrap: "truncate-end" }, quitHintFor(quitting.by, width))
    : h(
        Text,
        { dimColor: true, wrap: "truncate-end" },
        renaming ? "⏎ rename · Esc cancel" : picker ? (naming !== null ? "⏎ make it · Esc back" : "⏎ start · Esc back") : s.permission ? "y/n answer" : listHint,
      );
  const keysRow = text("keys", keys);
  // The card is answered here, so it's drawn whole, just above the keys. In a pane too short for
  // everything the list gives way first (scrolled to keep the cursor's row in view, as always) down
  // to that one row, then the note and the muted line, then the cursor's row, then the keys (the
  // card has its own); only a pane shorter than the card itself cuts it, from its end.
  const bottom = !card.length ? [...notes, keysRow] : [...notes.slice(0, Math.max(0, height - card.length - 2)), ...card, ...(card.length < height ? [keysRow] : [])];

  // Exactly `height` rows: the top ones (scrolled to keep the cursor's in view), blank ones, the
  // bottom. With a card, one blank at least between the list and it, while two rows are left.
  const spare = height - bottom.length;
  const room = card.length ? Math.max(0, spare >= 2 ? spare - 1 : spare) : Math.max(1, spare);
  const scrolled = cursorRow >= room ? top.slice(cursorRow - room + 1, cursorRow + 1) : top.slice(0, room);
  const blanks = Math.max(0, height - bottom.length - scrolled.length);
  const screen = [...scrolled, ...Array.from({ length: blanks }, (_, i) => text(`blank${i}`, "")), ...bottom].slice(0, height);

  // A click: the row it's on, and where in it (the text starts INDENT columns in).
  const latest = useRef(screen);
  latest.current = screen;
  const indent = useRef(INDENT);
  indent.current = INDENT;
  useEffect(() => {
    const onPointer = (p: Pointer) => {
      if (!p.press) return;
      const row = latest.current[p.y - 1];
      if (p.button === "left") row?.click?.(p.x - 1 - indent.current);
      else if (p.button === "right") row?.right?.(p);
      else if (p.button === "wheelUp" || p.button === "wheelDown") {
        const by = p.button === "wheelUp" ? -1 : 1;
        if (ui.state.window?.picker) setPickAt((n) => Math.max(0, (n < 0 ? PICKER_TOP : n) + by));
        else
          setCursor((id) => {
            const ids = choiceIds(pages(ui.state));
            const at = ids.indexOf(id ?? currentPage(ui.state) ?? PAGE_ID);
            return ids[Math.max(0, Math.min(ids.length - 1, at + by))];
          });
      }
    };
    windowEvents.on("pointer", onPointer);
    return () => void windowEvents.off("pointer", onPointer);
  }, []);

  return h(
    Box,
    { flexDirection: "column", width: columns, height },
    ...screen.map((r) =>
      h(Box, { key: r.key, height: 1, width: columns, paddingLeft: INDENT, paddingRight: 1, backgroundColor: r.bg, overflow: "hidden" }, typeof r.node === "string" ? h(Text, null, r.node) : r.node),
    ),
  );
}
