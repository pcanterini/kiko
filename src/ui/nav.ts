// Where you can go and what you can do in the Kiko window, in one place: the pages its right
// side shows (Kiko's own first, then every session, numbered as the list numbers them) and the
// commands. The list (window-list.ts) draws and keys them; the Ctrl+Space menu is built from them
// here, each time the app's state changes (sessions come and go), as are a session's right-click
// menu and its items. A new command is one more line in COMMANDS (its key, its words, what it does)
// and one more case where the app does it (src/ui/window-glue.ts `ask`).
import { agentOf } from "../agents/index.ts";
import { byAgent, canDo, type Can } from "../core/can.ts";
import { folderName, inScratch, sessionName, type Session } from "../core/sessions.ts";
import { sessionStatus, type UiState } from "../core/ui-store.ts";
import { NAME } from "../core/name.ts";
import { ADD_KEY_KEY } from "../core/account/plan-words.ts";
import { SETTING_GROUPS } from "../core/settings-options.ts";
import * as win from "../terminals/tmux/window.ts";
import { keyName } from "./bar.ts";
import { currentKey, keySequences, menuKeyName } from "../terminals/tmux/keys.ts";
import type { ByFocus, MenuData, MenuEntry, Tone } from "./menu-view.ts";
import { quitHint } from "./quit-again.ts";
import { WINDOW as WINDOW_NAME } from "../terminals/tmux/tmux.ts";

export const PAGE_ID = win.PAGE_ID;
export const { sessionPage, sessionOf } = win;

/**
 * A page the window's right side can show: Kiko's own (`session` null, `id` PAGE_ID), or a
 * session (`id` its sessionPage). `n`: its number key, null past 9.
 */
export type Page = { id: string; n: number | null; session: Session | null; outside: boolean };

// When each session was first listed: the list keeps them in that order, so a session's number
// stays its own while others get busy or quiet ("Ctrl+Space 2" is still pixie). One that ends
// lets the ones after it move up.
const seen = new Map<string, number>();
const firstSeen = (session: Session) => {
  if (!seen.has(session.sessionId)) seen.set(session.sessionId, seen.size);
  return seen.get(session.sessionId)!;
};

/** The sessions the list shows, in its order (first seen first): in Kiko's tmux (they can be shown here), then outside it. */
export function listed(s: Pick<UiState, "sessions">): { inside: Session[]; outside: Session[] } {
  for (const x of s.sessions) firstSeen(x); // new ones in the order they're listed
  const all = [...s.sessions].sort((a, b) => firstSeen(a) - firstSeen(b));
  // Background ones are never in Kiko's tmux; outside, their conversation shows read-only too.
  return {
    inside: all.filter((x) => x.place?.via === "tmux"),
    outside: all.filter((x) => x.place?.via !== "tmux"),
  };
}

/** Every page, in the list's order: Kiko (0), the sessions in Kiko's tmux, then those outside. */
export function pages(s: Pick<UiState, "sessions">): Page[] {
  const { inside, outside } = listed(s);
  const all: Page[] = [{ id: PAGE_ID, n: 0, session: null, outside: false }];
  for (const [session, out] of [...inside.map((x) => [x, false] as const), ...outside.map((x) => [x, true] as const)]) {
    all.push({ id: sessionPage(session.sessionId), n: all.length <= 9 ? all.length : null, session, outside: out });
  }
  return all;
}

/** The page shown now (its ID): Kiko's, a session's (shown, or viewed read-only), or null (a placeholder, nothing). */
export function currentPage(s: UiState): string | null {
  const w = s.window;
  if (!w) return null;
  if (w.viewing) return w.viewing;
  const shown = w.shown ? s.sessions.find((x) => x.place?.via === "tmux" && x.place.id === w.shown) : undefined;
  return shown ? sessionPage(shown.sessionId) : null;
}

/** The page `by` away from the one shown (−1 the one above it in the list, 1 below), round the end. */
export function stepPage(s: UiState, by: number): string {
  const all = pages(s);
  const at = all.findIndex((p) => p.id === currentPage(s));
  return all[(Math.max(0, at) + by + all.length) % all.length].id;
}

// ── Commands ──

type CommandId = "next" | "prev" | "last" | "new" | "trust" | "settings" | "focus" | "hide" | "quit";

/**
 * What the window does besides showing a page, in the menu's order: its key there (as shown, and
 * what the terminal sends for it), its words (`byFocus`: by which side has the keyboard as the menu
 * opens, `label` when that can't be told), the hint to press its key
 * again if it asks first (`twice`: Quit's, quit-again.ts), and the keys in the
 * list when it has them (`listKeys`). One key means one thing everywhere in Kiko, tmux's letter
 * where tmux has one for the same thing (n, p, l, c, d); ↑ ↓ only move the menu's highlight
 * (src/ui/menu-view.ts), Enter or Space picks it.
 */
export type Command = { id: CommandId; key: string; input: string[]; label: string; byFocus?: ByFocus; twice?: string; listKeys?: string[] };

/** Tab's words in the menu (window.ts): where it takes the keyboard from the side that has it, FOCUS_LABEL when that can't be told. */
export const { FOCUS_LABEL, FOCUS_LABELS } = win;

export const COMMANDS: readonly Command[] = [
  // First, right under the pages (before the session shown's group): the way between the two sides, easy to miss lower down.
  { id: "focus", key: "Tab", input: ["\t"], label: FOCUS_LABEL, byFocus: FOCUS_LABELS, listKeys: ["\t"] },
  { id: "next", key: "n", input: ["n"], label: "Next session", listKeys: ["n"] },
  { id: "prev", key: "p", input: ["p"], label: "Previous session", listKeys: ["p"] },
  { id: "last", key: "l", input: ["l"], label: "Last session", listKeys: ["l"] },
  { id: "new", key: "c", input: ["c"], label: "New session…", listKeys: ["c"] },
  // New scratch sessions each ask Claude Code to trust their folder until the scratch folder is: once.
  { id: "trust", key: "t", input: ["t"], label: "Trust the scratch folder (once)", listKeys: ["t"] },
  // ⌘, is Settings on the Mac: "," too.
  { id: "settings", key: "s", input: ["s", ","], label: "Settings", listKeys: ["s", ","] },
  { id: "hide", key: "d", input: ["d"], label: "Hide window (keeps listening)", listKeys: ["d"] },
  { id: "quit", key: "q", input: ["q", "Q"], label: `Quit ${NAME}…`, twice: quitHint("q"), listKeys: ["q", "Q"] },
];

/**
 * Keys that aren't menu commands, one meaning each wherever they act: `r` renames a session (in
 * both menus' Rename…, and in the list the highlighted session), `.` says the last thing again
 * (the list); `i` and `x` a session's Interrupt and Close (both menus); `e`, only while the plan
 * refuses Kiko's AI, adds your own OpenRouter key (the list and the Ctrl+Space menu: plan-words.ts ADD_KEY_KEY).
 */
export const RENAME_KEY = "r";
export const REPEAT_KEY = ".";
/** A session's Interrupt (Escape) and Close in the menus. */
export const INTERRUPT_KEY = "i";
export const CLOSE_KEY = "x";

/** The command a key in the list does (its `listKeys`), if any. */
export const listCommand = (input: string): CommandId | null => COMMANDS.find((c) => c.listKeys?.includes(input))?.id ?? null;

/** Asks of the app in its list pane (window.ts askApp), with this run's token. */
export type Asker = (verb: string, arg?: string) => string[];
export const asker =
  (list: string, token: string): Asker =>
  (verb, arg = "") =>
    win.askApp(list, token, verb, arg);

/** What a command runs, in tmux: the app asked, or tmux doing it itself. `classic`: the window's classic look (Tab by role: window.ts focusRun). */
function commandRun(id: CommandId, ask: Asker, classic = false): string[][] {
  switch (id) {
    case "new":
      return [ask("new")];
    case "trust":
      return [ask("trust")];
    case "settings":
      return [ask("settings")];
    case "prev":
      return [ask("step", "prev")];
    case "next":
      return [ask("step", "next")];
    case "last":
      return [ask("last")];
    case "focus":
      return [classic ? win.focusRun(true) : ["select-pane", "-t", `=${WINDOW_NAME}:.+`]];
    case "hide":
      // Run from the menu's popup: the terminal it's on (tmux's pick, the one used last, which pressed Ctrl+Space).
      return [["detach-client"]];
    case "quit":
      return [ask("quit")];
  }
}

// ── Menus ──

/** Pages the menu lists by name; past these, it says how many more the list has. */
const MENU_PAGES = 12;

const STATE_NOTE: Partial<Record<ReturnType<typeof sessionStatus>, { note: string; tone: Tone }>> = {
  needs_you: { note: "⚠ needs you", tone: "red" },
  waiting: { note: "◆ waits", tone: "yellow" },
  starting: { note: "◌ starting", tone: "dim" },
};

/**
 * The mark after a session that runs in the Claude desktop app, in the list and the menu: one dim
 * glyph, an app window, one cell wide (East Asian width neutral, so Ink's string-width and the
 * terminal agree, and the list's rows and clicks stay where they are).
 */
export const DESKTOP_MARK = "⧉";

/** It runs in the Claude desktop app (its hooks' entrypoint says so). */
export const inDesktop = (session: Pick<Session, "desktop">) => session.desktop;

/**
 * What a session is found by in the menu's search (`/`): its name, its folder, Claude's title for
 * it, as sessionLabel gives them to the router (never a folder its agent made up).
 */
const sessionFinds = (session: Session) => [sessionName(session), inScratch(session.cwd) ? "" : folderName(session.cwd), session.title ?? ""];

/** A page's line in the menu (plain text: the popup draws it, no tmux format), marked when it's the one shown. */
function pageEntry(p: Page, s: UiState, current: string | null, ask: Asker): MenuEntry {
  const mark = p.id === current ? "▸ " : "  ";
  const key = p.n === null ? {} : { key: String(p.n), input: [String(p.n)] };
  if (!p.session) return { label: `${mark}${NAME}`, tone: "accent", ...key, run: [ask("go", p.id)], find: [NAME] };
  const state = STATE_NOTE[sessionStatus(p.session, s)];
  // A desktop app session: its mark in place of "(outside)".
  const note = [p.outside ? (inDesktop(p.session) ? DESKTOP_MARK : "(outside)") : "", state?.note ?? ""].filter(Boolean).join(" ");
  return { label: `${mark}${sessionName(p.session)}`, ...(note ? { note, noteTone: state?.tone ?? "dim" } : {}), ...key, run: [ask("go", p.id)], find: sessionFinds(p.session) };
}

/** The menu's next to last line: how to use it. */
export const MENU_HINT = "/ search · ↑↓ move · ⏎ pick · Esc closes";

/** The menu's last line: how to talk (a line of its own: with the keys it's wider than a menu gets). */
function talkHint(s: UiState): string {
  return `talk: ${s.about.pttMode === "tap" ? "space in the list" : `hold ${keyName(s.about.hotkey)}`}`;
}

/**
 * The settings the menu's search finds ("voice": Settings → Voice), by name, in the settings
 * screen's order: each opens settings on its row (the settings ask, with the row's key).
 */
export function settingEntries(s: Pick<UiState, "settings">, ask: Asker): MenuEntry[] {
  const order = SETTING_GROUPS.flatMap((g) => g.keys);
  // Only the screen's rows (settings.ts lists each group's).
  return order.flatMap((key) => s.settings.filter((r) => r.key === key)).map((r) => ({ label: `Settings → ${r.label}`, find: [r.label], run: [ask("settings", r.key)] }));
}

/** Asked before a session is closed, in either menu. */
export const closePrompt = (name: string, agentName = "Claude Code") => `Close ${name}? ${agentName} ends there.`;

/**
 * Asked before a session outside Kiko's tmux is closed: it ends where it runs, your terminal (or
 * its background job stops), and a reply it's in the middle of is lost.
 */
export function closeOutsidePrompt(session: Session): string {
  // An agent whose sessions don't end as a process does (T3 Code: archived): its own question.
  const ending = agentOf(session).ending;
  if (ending) return ending.ask(sessionName(session), session.status === "busy" || session.status === "blocked");
  const who = agentOf(session).name;
  const ends = session.kind === "background" ? "Its background job stops." : session.jobId ? `${who} ends in its terminal, its background job too.` : `${who} ends in its terminal.`;
  const midTurn = session.status === "busy" || session.status === "blocked";
  return `Close ${sessionName(session)}? ${ends}${midTurn ? " Its current reply will be lost." : ""}`;
}

/** What can be done to a session from the window (sessionActions), and with `r` in the list: core/can.ts, the one list. */
export { canDo, type Can };

/**
 * What can be done to a session (canDo), the same in its right-click menu and in the Ctrl+Space
 * menu while it's shown: rename it (`r`, as in the list), interrupt its turn (`i`, Escape, as in its
 * terminal) and close it (`x`, asked first: in Kiko's tmux, Claude Code is asked to exit, then its
 * tmux session ends; outside, its agent ends it where it runs).
 */
export function sessionActions(session: Session, ask: Asker): MenuEntry[] {
  const can = canDo(session);
  const confirm = session.place?.via === "tmux" ? closePrompt(sessionName(session), agentOf(session).name) : closeOutsidePrompt(session);
  // Its agent's own (T3 Code's thread: through its server, no key; archived, not ended).
  const ending = session.place?.via === "tmux" ? undefined : agentOf(session).ending;
  return [
    ...(can.rename ? [{ label: "Rename…", key: RENAME_KEY, input: [RENAME_KEY], run: [ask("rename", session.sessionId)] }] : []),
    ...(can.interrupt ? [{ label: byAgent(session, "interrupt") ? "Interrupt" : "Interrupt (Escape)", key: INTERRUPT_KEY, input: [INTERRUPT_KEY], run: [ask("interrupt", session.sessionId)] }] : []),
    ...(can.close ? [{ label: ending?.label ?? "Close this session…", key: CLOSE_KEY, input: [CLOSE_KEY], run: [ask("close", session.sessionId)], confirm }] : []),
  ];
}

/** The session shown that Kiko can act on: one in its own tmux, in the stage (never Kiko's page, the placeholder or an outside one). */
export function shownSession(s: UiState): Session | null {
  const page = currentPage(s);
  const sessionId = page ? sessionOf(page) : null;
  if (!sessionId || s.window?.viewing) return null;
  const session = s.sessions.find((x) => x.sessionId === sessionId);
  return session?.place?.via === "tmux" ? session : null;
}

/**
 * The session the Ctrl+Space menu offers actions for (sessionActions): the one shown, or an outside
 * one whose conversation is viewed. The Kiko key twice still goes only to the one shown (`pass`).
 */
export function actionableSession(s: UiState): Session | null {
  const shown = shownSession(s);
  if (shown) return shown;
  const sessionId = s.window?.viewing ? sessionOf(s.window.viewing) : null;
  return (sessionId && s.sessions.find((x) => x.sessionId === sessionId)) || null;
}

/** A command's line in the Ctrl+Space menu. */
const commandEntry = (c: Command, ask: Asker, classic = false): MenuEntry => ({
  label: c.label,
  ...(c.byFocus ? { byFocus: c.byFocus } : {}),
  key: c.key,
  input: c.input,
  run: commandRun(c.id, ask, classic),
  ...(c.twice ? { twice: c.twice } : {}),
});

/**
 * The Ctrl+Space menu, from the app's state: the pages by number (the one shown marked, and the
 * highlight on it to start with: ↓ Enter is the next page), then the commands, the first (Tab, the
 * way between the list and the session) right under the pages, then what can be done to the
 * session shown or viewed (under its name: actionableSession), then the others; how to use it
 * and talk (`/` searches it, and the settings: `search`). Every item that needs the app asks the
 * app in its list. The Kiko key pressed again in it closes it and passes the key on to the
 * session shown (`pass`).
 */
export function windowMenu(s: UiState, ask: Asker): MenuData {
  const all = pages(s);
  const current = currentPage(s);
  const items: MenuEntry[] = all.slice(0, MENU_PAGES).map((p) => pageEntry(p, s, current, ask));
  if (all.length > MENU_PAGES) items.push({ label: `  … ${all.length - MENU_PAGES} more in the list`, tone: "dim" });
  const [first, ...rest] = COMMANDS;
  const classic = s.window?.look === "classic";
  items.push("-");
  // The plan refusing Kiko's AI (the trial ended, today's share used): your own key, first, the list's key (app/key-offer.ts).
  if (s.keyOffer) items.push({ label: "Add your OpenRouter key…", tone: "yellow", key: ADD_KEY_KEY, input: [ADD_KEY_KEY, ADD_KEY_KEY.toUpperCase()], run: [ask("addKey")] });
  items.push(commandEntry(first, ask, classic));
  const shown = shownSession(s);
  const acted = actionableSession(s);
  const actions = acted ? sessionActions(acted, ask) : [];
  // The Kiko key again passes it on (`again`, below): said under the session's actions, where it goes (only to one shown).
  const passed: MenuEntry[] = shown ? [{ label: `${menuKeyName()} again: ${menuKeyName()} to ${sessionName(shown)}`, tone: "dim" }] : [];
  if (acted && actions.length) items.push({ label: sessionName(acted), rule: true }, ...actions, ...passed, "-");
  items.push(...rest.map((c) => commandEntry(c, ask, classic)), "-", { label: MENU_HINT, tone: "dim" }, { label: talkHint(s), tone: "dim" });
  const at = all.slice(0, MENU_PAGES).findIndex((p) => p.id === current);
  // The Kiko key again: passed on to the session shown (the app checks there is one, and types it the checked way).
  const again = { input: keySequences(currentKey()), run: [ask("pass")] };
  // `/` searches it: the pages past the ones listed too, and the settings by name, a group of their own.
  const search = { also: all.slice(MENU_PAGES).map((p) => pageEntry(p, s, current, ask)), apart: settingEntries(s, ask) };
  return { title: ` ${NAME} `, items, again, search, ...(at >= 0 ? { selected: at } : {}) };
}

/**
 * A session's right-click menu: show it (Enter: highlighted to start with, so Enter shows it; no
 * letter, `s` is Settings everywhere); then what the Ctrl+Space menu offers for it, as far as it
 * can be done (sessionActions: rename, interrupt, close).
 */
export function sessionMenu(session: Session, ask: Asker): MenuData {
  const name = sessionName(session);
  const actions = sessionActions(session, ask);
  const items: MenuEntry[] = [{ label: "Show", key: "⏎", run: [ask("go", sessionPage(session.sessionId))] }];
  if (actions.length) items.push("-", ...actions);
  else items.push("-", { label: "outside: read-only here", tone: "dim" });
  return { title: ` ${name} `, items, selected: 0 };
}
