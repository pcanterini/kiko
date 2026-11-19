// The Kiko window's navigation, without tmux: the pages and their numbers (src/ui/nav.ts), the
// Ctrl+Space menu and a session's right-click menu built from them, drawn by their popup's program
// (src/ui/menu-view.ts: plain text, never a format; keys, clicks, Quit's press-again hint), the asks their
// items send the app (window.ts askApp), and the app's reading of its input (src/ui/input.ts: asks
// and clicks out, keys on to Ink).
import "../../setup.ts";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import type { Session } from "../../../src/core/sessions.ts";
import { ui, type UiState } from "../../../src/core/ui-store.ts";
import { askApp, askBytes, MENU, MENU_DATA, MENU_PROGRAM, menuPopup, openWindow, POPUP_BORDER_STYLE, POPUP_STYLE, setMenu, startingMenu } from "../../../src/terminals/tmux/window.ts";
import { forFocus, MenuView, menuSize, searchScore, type MenuData, type MenuEntry } from "../../../src/ui/menu-view.ts";
import { QUIT_AGAIN_MS } from "../../../src/ui/quit-again.ts";
import { WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { inkInput, take, type Ask, type Pointer } from "../../../src/ui/input.ts";
import {
  actionableSession,
  asker,
  canDo,
  CLOSE_KEY,
  closeOutsidePrompt,
  closePrompt,
  COMMANDS,
  currentPage,
  DESKTOP_MARK,
  FOCUS_LABEL,
  FOCUS_LABELS,
  INTERRUPT_KEY,
  listCommand,
  PAGE_ID,
  pages,
  RENAME_KEY,
  REPEAT_KEY,
  sessionMenu,
  sessionOf,
  shownSession,
  stepPage,
  windowMenu,
} from "../../../src/ui/nav.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";

const session = (name: string, fields: Partial<Session> = {}) =>
  ({ sessionId: name, cwd: `/code/${name}`, givenName: name, kind: "interactive", status: "idle", desktop: false, place: null, mapping: "none", nameSetBy: "user", ...fields }) as unknown as Session;
const inTmux = (name: string, pane: string, fields: Partial<Session> = {}) => session(name, { place: { via: "tmux", id: pane, keys: true, pid: 1 }, ...fields });
const state = (patch: Partial<UiState>): UiState => ({ ...ui.state, about: { ...ui.state.about, hotkey: "right_option" }, window: { shown: null, note: "" }, ...patch });
const TOKEN = "t0k3n";
const hexOf = (argv: string[]) => Buffer.from(argv.slice(argv.indexOf("-H") + 1).join(""), "hex").toString();

describe("pages", () => {
  test("Kiko 0, then Kiko's tmux, then outside, numbered on; past 9 no number", () => {
    const s = state({ sessions: [session("notes", { place: { via: "ghostty", id: "g", keys: true } }), inTmux("pixie", "%1"), inTmux("lacy", "%2")] });
    assert.deepEqual(
      pages(s).map((p) => [p.id, p.n, p.outside]),
      [
        [PAGE_ID, 0, false],
        ["session:pixie", 1, false],
        ["session:lacy", 2, false],
        ["session:notes", 3, true],
      ],
    );
    const many = state({ sessions: Array.from({ length: 11 }, (_, i) => inTmux(`s${i}`, `%${i}`)) });
    assert.deepEqual(
      pages(many)
        .map((p) => p.n)
        .slice(8),
      [8, 9, null, null],
    );
  });
  test("the page shown, and the one above or below it (round the ends)", () => {
    const sessions = [inTmux("pixie", "%1"), inTmux("lacy", "%2")];
    assert.equal(currentPage(state({ sessions, window: { shown: "%2", note: "" } })), "session:lacy");
    assert.equal(currentPage(state({ sessions, window: { shown: null, note: "", viewing: PAGE_ID } })), PAGE_ID);
    const s = state({ sessions, window: { shown: "%2", note: "" } });
    assert.equal(stepPage(s, 1), PAGE_ID);
    assert.equal(stepPage(s, -1), "session:pixie");
  });
  test('Kiko\'s page and the sessions never share an ID, whatever a session is called (one with the ID "kiko", or "page:kiko")', () => {
    const s = state({ sessions: [inTmux("kiko", "%1"), inTmux("page:kiko", "%2")], window: { shown: "%1", note: "" } });
    const ids = pages(s).map((p) => p.id);
    assert.deepEqual(ids, [PAGE_ID, "session:kiko", "session:page:kiko"]);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(currentPage(s), "session:kiko", "the session shown, not Kiko's page");
    assert.equal(sessionOf(PAGE_ID), null);
    assert.equal(sessionOf("session:page:kiko"), "page:kiko");
    assert.equal(sessionOf("kiko"), null, "an old bare ID is no page");
  });
});

describe("asks", () => {
  test("ESC _ kiko;token;verb;arg ESC \\, sent as hex: only letters, digits, - _ . : in it", () => {
    assert.equal(askBytes("tok", "go", "abc-123"), "\x1b_kiko;tok;go;abc-123\x1b\\");
    assert.equal(askBytes("tok", "go", "a;b'$(x)#{y}\x1b\\"), "\x1b_kiko;tok;go;abxy\x1b\\");
    const argv = askApp("%5", "tok", "go", "pixie");
    assert.deepEqual(argv.slice(0, 4), ["send-keys", "-t", "%5", "-H"]);
    assert.ok(argv.slice(4).every((h) => /^[0-9a-f]{2}$/.test(h)));
    assert.equal(hexOf(argv), "\x1b_kiko;tok;go;pixie\x1b\\");
  });
  test("read back: asks with this run's token taken out, any other APC dropped, the keys around them kept in order", () => {
    const got = take(`ab\x1b_kiko;${TOKEN};go;pixie\x1b\\c\x1b_kiko;wrong;quit;\x1b\\\x1b_other\x1b\\d\x1b[A`, TOKEN);
    assert.deepEqual(got.asks, [{ verb: "go", arg: "pixie" }]);
    assert.equal(got.keys, "abcd\x1b[A");
    assert.equal(got.rest, "");
  });
  test("clicks: left, right and the wheel, where; released too; never typed", () => {
    const got = take("\x1b[<0;5;3M\x1b[<0;5;3m\x1b[<2;6;4M\x1b[<64;1;1M\x1b[<65;1;1Mx", TOKEN);
    assert.deepEqual(got.pointers, [
      { x: 5, y: 3, button: "left", press: true },
      { x: 5, y: 3, button: "left", press: false },
      { x: 6, y: 4, button: "right", press: true },
      { x: 1, y: 1, button: "wheelUp", press: true },
      { x: 1, y: 1, button: "wheelDown", press: true },
    ]);
    assert.equal(got.keys, "x");
  });
  test("a key's release (the kitty keyboard protocol's event type 3) dropped, so a tap acts once; presses and a held key's repeats go on to Ink", () => {
    // m, Enter, ↓, Delete and a shifted M let go; m with its text, too.
    const releases = ["\x1b[109;1:3u", "\x1b[13;1:3u", "\x1b[1;1:3B", "\x1b[3;1:3~", "\x1b[109:77;2:3u", "\x1b[109;1:3;109u"];
    for (const r of releases) assert.deepEqual(take(`m${r}`, TOKEN), { keys: "m", asks: [], pointers: [], focus: [], released: 1, rest: "" }, JSON.stringify(r));
    // Pressed (no event type, or 1), held (2), and modifiers that aren't a release (3 is Alt+Shift).
    const kept = "\x1b[109u\x1b[109;1:1u\x1b[109;1:2u\x1b[1;1:2B\x1b[109;3u\x1b[1;3A\x1b[A";
    assert.equal(take(kept, TOKEN).keys, kept);
    // Cut off at a chunk's end: kept for the next, and dropped whole there.
    const a = take("m\x1b[109;1:", TOKEN);
    assert.deepEqual([a.keys, a.rest], ["m", "\x1b[109;1:"]);
    assert.deepEqual([take(`${a.rest}3u.`, TOKEN).keys], ["."]);
  });
  test("cut off at a chunk's end: kept for the next; a lone Escape goes on to Ink a moment later", async () => {
    const a = take(`x\x1b_kiko;${TOKEN};go;pi`, TOKEN);
    assert.deepEqual([a.keys, a.asks.length], ["x", 0]);
    const b = take(`${a.rest}xie\x1b\\`, TOKEN);
    assert.deepEqual(b.asks, [{ verb: "go", arg: "pixie" }]);
    assert.equal(take("\x1b[<0;5", TOKEN).rest, "\x1b[<0;5");
    // Through the stream Ink reads: the asks and clicks as events, the keys as typed, a lone Escape after a moment.
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    Object.assign(stdin, { setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const events = new EventEmitter();
    const asks: Ask[] = [];
    const pointers: Pointer[] = [];
    events.on("ask", (a) => asks.push(a));
    events.on("pointer", (p) => pointers.push(p));
    const ink = inkInput(stdin, TOKEN, events);
    let typed = "";
    ink.setEncoding("utf8");
    ink.on("data", (d) => (typed += d));
    (stdin as unknown as PassThrough).write(`hi\x1b_kiko;${TOKEN};new;\x1b\\\x1b[<0;3;2M`);
    (stdin as unknown as PassThrough).write("\x1b");
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(asks, [{ verb: "new", arg: "" }]);
    assert.deepEqual(pointers, [{ x: 3, y: 2, button: "left", press: true }]);
    assert.equal(typed, "hi\x1b");
  });
});

describe("the Ctrl+Space menu", () => {
  const s = state({
    sessions: [inTmux("pixie", "%1", { status: "blocked" }), inTmux("#(touch /tmp/x) #[fg=red]bad", "%2"), session("notes", { place: { via: "ghostty", id: "g", keys: true } })],
    window: { shown: "%1", note: "" },
  });
  const menu = windowMenu(s, asker("%9", TOKEN));
  const live = menu.items.filter((i): i is Exclude<MenuEntry, "-"> => i !== "-" && Boolean(i.run));
  const item = (key: string) => live.find((i) => i.key === key)!;

  test("the pages by number (the one shown marked, chosen to start with), Tab right under them, the session shown's actions under its name, the other commands with their keys, how to talk", () => {
    const line = (i: MenuEntry) => (i === "-" ? "-" : `${i.rule ? "rule" : (i.key ?? "")}|${i.label}${i.note ? `|${i.note}` : ""}`);
    assert.deepEqual(menu.items.slice(0, 13).map(line), [
      "0|  Kiko",
      "1|▸ pixie|⚠ needs you",
      "2|  #(touch /tmp/x) #[fg=red]bad",
      "3|  notes|(outside)",
      "-",
      "Tab|Switch list ⇄ session",
      "rule|pixie",
      "r|Rename…",
      "i|Interrupt (Escape)",
      "x|Close this session…",
      "|⌃Space again: ⌃Space to pixie",
      "-",
      "n|Next session",
    ]);
    assert.equal(menu.selected, 1);
    assert.deepEqual(
      live
        .filter((i) => !["r", "i", "x"].includes(i.key!))
        .slice(4)
        .map((i) => i.key),
      COMMANDS.map((c) => c.key),
    );
    assert.deepEqual(
      COMMANDS.map((c) => [c.key, c.label]),
      [
        ["Tab", "Switch list ⇄ session"],
        ["n", "Next session"],
        ["p", "Previous session"],
        ["l", "Last session"],
        ["c", "New session…"],
        ["t", "Trust the scratch folder (once)"],
        ["s", "Settings"],
        ["d", "Hide window (keeps listening)"],
        ["q", "Quit Kiko…"],
      ],
    );
    // No session shown (Kiko's page): Tab still first under the pages, the other commands straight after it.
    const page = windowMenu({ ...s, window: { shown: null, note: "", viewing: PAGE_ID } }, asker("%9", TOKEN));
    assert.deepEqual(page.items.slice(4, 8).map(line), ["-", "Tab|Switch list ⇄ session", "n|Next session", "p|Previous session"]);
    // How to use it, then how to talk: a line each (together they'd be wider than a menu gets).
    assert.deepEqual(menu.items.slice(-2).map(line), ["|/ search · ↑↓ move · ⏎ pick · Esc closes", "|talk: hold right ⌥"]);
    assert.equal(line(windowMenu({ ...s, about: { ...s.about, pttMode: "tap" } }, asker("%9", TOKEN)).items.at(-1)!), "|talk: space in the list");
    // ↑ ↓ are the highlight's, never an item's; q quits, asking first.
    assert.ok(!live.some((i) => i.input?.some((k) => ["\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB", "\r", " "].includes(k))));
    assert.deepEqual(item("q").input, ["q", "Q"]);
    // One key, one meaning: r is rename (only Rename… here) and . repeat, never a command's here or in the list.
    assert.deepEqual([RENAME_KEY, REPEAT_KEY, INTERRUPT_KEY, CLOSE_KEY], ["r", ".", "i", "x"]);
    assert.deepEqual(
      live.filter((i) => i.input?.includes(RENAME_KEY)).map((i) => i.label),
      ["Rename…"],
    );
    assert.ok(!live.some((i) => i.input?.includes(REPEAT_KEY)));
    assert.equal(listCommand(RENAME_KEY), null);
    assert.equal(listCommand(REPEAT_KEY), null);
  });
  test("no two items share a key, with the session group or without it; nor in a session's right-click menu", () => {
    const keysOf = (m: { items: MenuEntry[] }) => m.items.flatMap((i) => (i === "-" || !i.run ? [] : (i.input ?? (i.key ? [i.key] : []))));
    const shown = keysOf(menu);
    assert.ok(
      ["r", "i", "x"].every((k) => shown.includes(k)),
      shown.join(" "),
    );
    const page = keysOf(windowMenu({ ...s, window: { shown: null, note: "", viewing: PAGE_ID } }, asker("%9", TOKEN)));
    const right = keysOf(sessionMenu(inTmux("pixie", "%1"), asker("%9", TOKEN)));
    for (const keys of [shown, page, right])
      assert.deepEqual(
        keys.filter((k, n) => keys.indexOf(k) !== n),
        [],
        keys.join(" "),
      );
    // The keys as shown (the menu's right-hand column) too.
    const labels = menu.items.flatMap((i) => (i === "-" || !i.key ? [] : [i.key]));
    assert.deepEqual(
      labels.filter((k, n) => labels.indexOf(k) !== n),
      [],
    );
  });

  test('Tab\'s words say where it goes, by the side that has the keyboard as the menu opens: the list\'s "Go to the session →", the session side\'s "Go to the list ←"', () => {
    const tab = (m: MenuData) => m.items.find((i): i is Exclude<MenuEntry, "-"> => i !== "-" && i.key === "Tab")!;
    assert.deepEqual(FOCUS_LABELS, { list: "Go to the session →", stage: "Go to the list ←" });
    assert.deepEqual(tab(menu).byFocus, FOCUS_LABELS);
    assert.equal(tab(forFocus(menu, true)).label, "Go to the session →");
    assert.equal(tab(forFocus(menu, false)).label, "Go to the list ←");
    // Not known (tmux didn't answer): the words that fit both.
    assert.equal(tab(forFocus(menu, null)).label, FOCUS_LABEL);
    // Only Tab's words change: its key, what it runs, and every other line stay.
    const listSide = forFocus(menu, true);
    const others = (m: MenuData) => m.items.filter((i) => i === "-" || i.key !== "Tab");
    assert.deepEqual(others(listSide), others(menu));
    assert.deepEqual([tab(listSide).key, tab(listSide).input, tab(listSide).run], [tab(menu).key, tab(menu).input, tab(menu).run]);
    assert.deepEqual(tab(menu).run, [["select-pane", "-t", `=${WINDOW}:.+`]]);
    assert.equal(listCommand("\t"), "focus", "the list's own Tab: unchanged");
    // The popup is sized before the side is known: wide enough for any of the words.
    const sized = menuSize({ title: "x", items: [{ label: "", byFocus: { list: "a much longer way to the session →", stage: "back ←" }, key: "Tab", run: [] }] }).width;
    assert.equal(sized, menuSize({ title: "x", items: [{ label: "a much longer way to the session →", key: "Tab", run: [] }] }).width);
    // The starting menu (before the app makes its own) says the same.
    const start = tab(startingMenu());
    assert.deepEqual([start.label, start.byFocus], [FOCUS_LABEL, FOCUS_LABELS]);
    assert.equal(tab(forFocus(startingMenu(), false)).label, "Go to the list ←");
  });

  test("the session group: only for a session of Kiko's tmux in the stage, or an outside one viewed that it can act on (below); never Kiko's page, the placeholder or an outside one it can do nothing to (left out, not greyed)", () => {
    const group = (w: UiState["window"]) => windowMenu({ ...s, window: w }, asker("%9", TOKEN)).items.filter((i) => i !== "-" && (i.rule || i.input?.includes("x")));
    assert.equal(shownSession(s)?.sessionId, "pixie");
    assert.equal(group({ shown: "%1", note: "" }).length, 2);
    assert.deepEqual(group({ shown: null, note: "", viewing: PAGE_ID }), [], "Kiko's page");
    assert.deepEqual(group({ shown: null, note: "" }), [], "the placeholder");
    assert.deepEqual(group({ shown: null, note: "", viewing: "session:notes" }), [], "an outside session's conversation, its process not known and its window not sure");
    assert.deepEqual(group(null), [], "no window");
  });

  test("the session group is its right-click menu's: the same keys, labels, asks and question (one list of them)", () => {
    const pick = (items: MenuEntry[]) => items.filter((i): i is Exclude<MenuEntry, "-"> => i !== "-" && ["r", "i", "x"].includes(i.key ?? ""));
    assert.deepEqual(pick(menu.items), pick(sessionMenu(s.sessions[0], asker("%9", TOKEN)).items));
    assert.equal(hexOf(item("x").run![0]), `\x1b_kiko;${TOKEN};close;pixie\x1b\\`);
    assert.equal(hexOf(item("i").run![0]), `\x1b_kiko;${TOKEN};interrupt;pixie\x1b\\`);
    assert.equal(hexOf(item("r").run![0]), `\x1b_kiko;${TOKEN};rename;pixie\x1b\\`);
    assert.equal(item("x").confirm, closePrompt("pixie"));
    assert.equal(item("x").confirm, "Close pixie? Claude Code ends there.");
    assert.equal(item("i").confirm, undefined, "Interrupt doesn't ask");
  });

  test('a desktop app session: its app-window glyph in place of "(outside)", nothing else changed', () => {
    const desk = session("2 plus 2", { desktop: true });
    const m = windowMenu(
      state({ sessions: [inTmux("pixie", "%1"), desk, session("notes", { place: { via: "ghostty", id: "g", keys: true } })], window: { shown: "%1", note: "" } }),
      asker("%9", TOKEN),
    );
    const entry = (label: string) => m.items.find((i): i is Exclude<MenuEntry, "-"> => i !== "-" && i.label.includes(label))!;
    assert.equal(DESKTOP_MARK, "⧉");
    assert.deepEqual([entry("2 plus 2").note, entry("2 plus 2").noteTone], [DESKTOP_MARK, "dim"]);
    assert.equal(entry("notes").note, "(outside)");
  });

  test("each page's item asks the app for it; n p l c s ask for theirs (s and , both Settings); d and Tab are tmux's own; Quit wants q again, in the menu", () => {
    assert.equal(hexOf(item("2").run![0]), `\x1b_kiko;${TOKEN};go;session:touchtmpxfgredbad\x1b\\`);
    assert.equal(hexOf(item("0").run![0]), `\x1b_kiko;${TOKEN};go;page:kiko\x1b\\`);
    assert.equal(hexOf(item("n").run![0]), `\x1b_kiko;${TOKEN};step;next\x1b\\`);
    assert.equal(hexOf(item("p").run![0]), `\x1b_kiko;${TOKEN};step;prev\x1b\\`);
    assert.equal(hexOf(item("l").run![0]), `\x1b_kiko;${TOKEN};last;\x1b\\`);
    assert.equal(hexOf(item("c").run![0]), `\x1b_kiko;${TOKEN};new;\x1b\\`);
    assert.equal(hexOf(item("s").run![0]), `\x1b_kiko;${TOKEN};settings;\x1b\\`);
    assert.deepEqual(item("s").input, ["s", ","]);
    assert.deepEqual(item("d").run, [["detach-client"]]);
    assert.deepEqual(item("Tab").run, [["select-pane", "-t", `=${WINDOW}:.+`]]);
    assert.equal(item("q").twice, "Press q again to quit · your sessions keep running");
    assert.equal(item("q").confirm, undefined);
    assert.equal(hexOf(item("q").run![0]), `\x1b_kiko;${TOKEN};quit;\x1b\\`);
  });
  test("kept over stdin: its JSON, and the popup that shows it (only Node, the menu program, tmux and the option on its command line)", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    await setMenu(t.run, menu);
    const call = t.inputs.at(-1)!;
    assert.deepEqual(call.args, ["source-file", "-"]);
    assert.equal(call.input.split("\n").filter(Boolean).length, 2);
    const opts = t.windows.get(t.panes.get(t.panesOf(WINDOW)[0])!.window)!.opts;
    assert.deepEqual(JSON.parse(opts[MENU_DATA]), menu);
    const popup = FakeTmux.words(opts[MENU]);
    assert.equal(popup[0], "display-popup");
    const program = popup.slice(popup.indexOf("--") + 1);
    assert.deepEqual([program[0], program[1], program[3], program.length], [process.execPath, MENU_PROGRAM, MENU_DATA, 4]);
    for (const argv of t.calls) assert.ok(!argv.join(" ").includes("touch /tmp/x"), "the menu never on a command line");
  });
});

describe("the menu drawn (its popup's program)", () => {
  const menu = windowMenu(state({ sessions: [inTmux("pixie", "%1", { status: "blocked" }), inTmux("lacy\x1b[2J", "%2")], window: { shown: "%1", note: "" } }), asker("%9", TOKEN));
  const plainLines = (v: MenuView, w = 40) => v.frame(w, menu.items.length).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  test("each line: its words, a note, its key on the right; the one shown chosen; nothing in a name reaches the terminal as an escape", () => {
    const v = new MenuView(menu);
    const lines = plainLines(v);
    assert.match(lines[0], /^ {3}Kiko +0 $/);
    assert.match(lines[1], /^ ▸ pixie ⚠ needs you +1 $/);
    assert.match(lines[2], /^ {3}lacy \[2J +2 $/);
    assert.ok(!v.frame(40, 20).join("").includes("\x1b[2J"));
    assert.ok(v.frame(40, 20)[1].startsWith("\x1b[7m"), "the chosen line reversed");
    const size = menuSize(menu);
    assert.equal(size.height, menu.items.length);
    assert.ok(size.width >= 30 && size.width <= 60, String(size.width));
  });
  test("a key picks its item at once; ↑ ↓ only move the highlight (over items that do something, round the ends); Enter or Space picks it; a click its line; Escape or Ctrl+Space again closes", () => {
    const go = (page: string) => ({ kind: "run", commands: [asker("%9", TOKEN)("go", page)] });
    const v = new MenuView(menu);
    assert.deepEqual(v.key("2"), go("session:lacy\x1b[2J"));
    // The highlight starts on the page shown (pixie): ↓ the next page, Enter goes there; ↑ ↑ Kiko's, Space.
    const h = new MenuView(menu);
    assert.equal(h.at, 1);
    assert.deepEqual(h.key("\x1b[B"), { kind: "none" });
    assert.deepEqual(h.key("\r"), go("session:lacy\x1b[2J"));
    const up = new MenuView(menu);
    assert.deepEqual(
      [up.key("\x1b[A"), up.key("\x1bOA")].map((p) => p.kind),
      ["none", "none"],
    );
    assert.equal((menu.items[up.at] as { label: string }).label.trim(), "Quit Kiko…", "up from the first: round to the last item that does something");
    up.key("\x1b[B");
    assert.deepEqual(up.key(" "), go(PAGE_ID));
    // Past the last page: Tab first, the session's heading skipped, its actions next, then (the rule skipped) the other commands.
    const down = new MenuView(menu);
    const labels: string[] = [];
    for (let n = 0; n < 6; n++) {
      down.key("\x1b[B");
      labels.push((menu.items[down.at] as { label: string }).label);
    }
    assert.deepEqual(labels, ["  lacy\x1b[2J", FOCUS_LABEL, "Rename…", "Interrupt (Escape)", "Close this session…", "Next session"]);
    // Close asks first, as Quit does; Interrupt doesn't.
    const close = new MenuView(menu);
    assert.deepEqual(close.key("x"), { kind: "none" });
    assert.match(plainLines(close, 60)[0], /^ Close pixie\? Claude Code ends there\./);
    assert.deepEqual(close.key("y"), { kind: "run", commands: [asker("%9", TOKEN)("close", "pixie")] });
    assert.deepEqual(new MenuView(menu).key("i"), { kind: "run", commands: [asker("%9", TOKEN)("interrupt", "pixie")] });
    // Enter on Quit: its hint first.
    const quit = new MenuView(menu);
    quit.key("\x1b[A");
    quit.key("\x1b[A");
    assert.deepEqual(quit.key("\r"), { kind: "none" });
    assert.deepEqual(quit.key("y"), { kind: "run", commands: [asker("%9", TOKEN)("quit")] });
    // Keys sent as CSI u (extended keys): the same keys.
    assert.deepEqual(new MenuView(menu).key("\x1b[9u"), { kind: "run", commands: [["select-pane", "-t", `=${WINDOW}:.+`]] });
    assert.deepEqual(new MenuView(menu).key("\x1b[27u"), { kind: "close" });
    assert.deepEqual(new MenuView(menu).key("\x1b[9;5u"), { kind: "run", commands: [["select-pane", "-t", `=${WINDOW}:.+`]] }, "Ctrl still held: Tab");
    assert.deepEqual(new MenuView(menu).key("\x1b[50;5u"), new MenuView(menu).key("2"), "Ctrl still held: 2");
    // The menu key again (either way the terminal sends it): passed on to the session shown, by the app.
    const pass = { kind: "run", commands: [asker("%9", TOKEN)("pass")] };
    assert.deepEqual(new MenuView(menu).key("\x1b[32;5u"), pass, "Ctrl+Space again, CSI u");
    assert.deepEqual(new MenuView(menu).key("\x00"), pass, "Ctrl+Space again, NUL");
    assert.deepEqual(new MenuView(menu).key("q"), { kind: "none" }, "q is nothing");
    assert.deepEqual(v.key("z"), { kind: "none" });
    assert.deepEqual(v.key("\x1b"), { kind: "close" });
    // A menu that can't pass it on (tmux's own, before the app makes one): the key again only closes.
    assert.deepEqual(new MenuView({ ...menu, again: { input: ["\x00", "\x1b[32;5u"] } }).key("\x00"), { kind: "close" });
    assert.deepEqual(new MenuView(menu).key("\r"), { kind: "run", commands: [asker("%9", TOKEN)("go", "session:pixie")] });
    assert.deepEqual(v.click(1, 1).kind, "run");
    assert.deepEqual(v.click(1, menu.items.indexOf("-") + 1), { kind: "none" }, "a rule");
    assert.deepEqual(v.click(1, menu.items.length), { kind: "none" }, "the hint");
  });
  test("the look: only the terminal's palette (no fixed colour, no grey background); the chosen line reversed across its width; the popup on the terminal's own background, a blue rounded border, a bold title", () => {
    const fixed = /\x1b\[[0-9;]*(?:38|48);[25];/;
    const v = new MenuView(menu);
    const frames = [v.frame(40, menu.items.length)];
    const asked = new MenuView(menu);
    asked.key("x");
    frames.push(asked.frame(40, 6), new MenuView(sessionMenu(inTmux("pixie", "%1"), asker("%9", TOKEN))).frame(30, 6));
    for (const lines of frames) for (const l of lines) assert.ok(!fixed.test(l), JSON.stringify(l));
    // Every cell of the chosen line is reversed (one bar, its key too); the others aren't.
    const chosen = v.frame(40, menu.items.length)[1];
    const segments = chosen.split("\x1b[0m").filter(Boolean);
    assert.ok(
      segments.every((seg) => /^\x1b\[7[;m]/.test(seg)),
      JSON.stringify(segments),
    );
    assert.ok(!v.frame(40, menu.items.length)[0].includes("\x1b[7"));
    // The session's heading: its name between dim rules.
    const heading = v.frame(40, menu.items.length)[menu.items.findIndex((i) => i !== "-" && i.rule)];
    assert.match(heading.replace(/\x1b\[[0-9;]*m/g, ""), /^─ pixie ─+$/);
    const popup = menuPopup(menu, MENU_DATA);
    const opt = (flag: string) => popup[popup.indexOf(flag) + 1];
    assert.equal(opt("-b"), "rounded");
    assert.ok(opt("-T").startsWith("#[bold]"));
    assert.deepEqual([POPUP_STYLE, POPUP_BORDER_STYLE], ["bg=terminal,fg=terminal", "bg=terminal,fg=blue"]);
  });

  test("Quit… shows its hint; q again (or Q, or y) within QUIT_AGAIN_MS quits; another key goes back to the menu and does nothing else; so does the time running out", () => {
    const quit = { kind: "run", commands: [asker("%9", TOKEN)("quit")] };
    let now = 1000;
    const clock = () => now;
    // The hint, bold yellow, in place of the menu; one line when it fits, its parts on lines of their own when not.
    const v = new MenuView(menu, clock);
    assert.deepEqual(v.key("q"), { kind: "none" });
    assert.equal(plainLines(v, 60)[0], " Press q again to quit · your sessions keep running");
    assert.ok(v.frame(60, 6)[0].includes("\x1b[1;33m"), "bold yellow");
    assert.deepEqual(plainLines(v, 30).slice(0, 2), [" Press q again to quit", " your sessions keep running"]);
    assert.equal(v.againUntil, 1000 + QUIT_AGAIN_MS);
    // q, q quits.
    assert.deepEqual(v.key("q"), quit);
    // q, Q and q, y quit.
    const big = new MenuView(menu, clock);
    big.key("q");
    assert.deepEqual(big.key("Q"), quit);
    const yes = new MenuView(menu, clock);
    yes.key("q");
    now += QUIT_AGAIN_MS - 1;
    assert.deepEqual(yes.key("y"), quit, "just within the time");
    // q, another key: back to the menu, and that key does nothing else (n would be Next session).
    const other = new MenuView(menu, clock);
    other.key("q");
    assert.deepEqual(other.key("n"), { kind: "none" });
    assert.equal(other.asking, null);
    assert.match(plainLines(other)[0], /^ {3}Kiko +0 $/);
    assert.deepEqual(other.key("q"), { kind: "none" }, "q again starts it over: its hint, no quit");
    // q, then the time runs out: the hint goes (the popup draws the menu again: lapse), and q after is a first q again.
    const late = new MenuView(menu, clock);
    late.key("q");
    assert.equal(late.lapse(), false, "not yet");
    now += QUIT_AGAIN_MS;
    assert.equal(late.lapse(), true);
    assert.equal(late.asking, null);
    assert.equal(late.againUntil, null);
    assert.match(plainLines(late)[0], /^ {3}Kiko +0 $/);
    assert.deepEqual(late.key("q"), { kind: "none" }, "a first q again");
    // Its time out with no lapse (a key first): the key is as without the hint (n: Next session).
    const stale = new MenuView(menu, clock);
    stale.key("q");
    now += QUIT_AGAIN_MS + 1;
    assert.deepEqual(stale.key("n"), { kind: "run", commands: [asker("%9", TOKEN)("step", "next")] });
    // Picked with Enter: the same hint, the same keys.
    const entered = new MenuView(menu, clock);
    entered.key("\x1b[A");
    entered.key("\x1b[A");
    assert.deepEqual(entered.key("\r"), { kind: "none" });
    assert.match(plainLines(entered, 60)[0], /^ Press q again to quit/);
    assert.deepEqual(entered.key("q"), quit);
  });
});

describe("a question's buttons (Close this session…)", () => {
  const ask = asker("%9", TOKEN);
  const menu = windowMenu(state({ sessions: [inTmux("pixie", "%1")], window: { shown: "%1", note: "" } }), ask);
  const closed = { kind: "run", commands: [ask("close", "pixie")] };
  const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  /** A view with Close's question up, drawn `cols` × `rows`; the row and columns its buttons were drawn at (1 the first, as the terminal counts). */
  const asking = (cols = 40, rows = 6, m: MenuData = menu) => {
    const v = new MenuView(m);
    assert.deepEqual(v.key(CLOSE_KEY), { kind: "none" });
    const lines = plain(v.frame(cols, rows));
    const row = lines.findIndex((l) => l.includes("[ Yes ]")) + 1;
    const col = (text: string) => lines[row - 1].indexOf(text) + 1;
    return { v, lines, row, yes: col("[ Yes ]"), no: col("[ No ]") };
  };

  test("the frame: the question, then [ Yes ] (in the accent) and [ No ], and the keys' hint beside them or under them", () => {
    const wide = asking(60, 6);
    assert.deepEqual(wide.lines.slice(0, 3), [" Close pixie? Claude Code ends there.", "", " [ Yes ]  [ No ]   y yes · other keys no"]);
    assert.equal(wide.v.frame(60, 6)[2].startsWith(" \x1b[1;34m[ Yes ]\x1b[0m"), true, "Yes in the accent");
    // Narrower: the hint under the buttons; the question wrapped.
    assert.deepEqual(asking(30, 6).lines.slice(0, 5), [" Close pixie? Claude Code", " ends there.", "", " [ Yes ]  [ No ]", " y yes · other keys no"]);
    // A session's right-click menu, at its own size: all of it.
    const right = sessionMenu(inTmux("pixie", "%1"), ask);
    const { width, height } = menuSize(right);
    assert.deepEqual(asking(width, height, right).lines, [" Close pixie? Claude Code", " ends there.", "", " [ Yes ]  [ No ]", " y yes · other keys no"]);
    // Three rows: the question's first line, the buttons, the hint (no blank line).
    assert.deepEqual(asking(26, 3).lines, [" Close pixie? Claude Code", " [ Yes ]  [ No ]", " y yes · other keys no"]);
    // Narrowest: the hint's parts on lines of their own; never wider than the popup.
    const narrow = asking(20, 6);
    assert.deepEqual(narrow.lines.slice(-3), [" [ Yes ]  [ No ]", " y yes", " other keys no"]);
    for (const l of [...narrow.lines, ...asking(20, 3).lines]) assert.ok(l.length <= 20, JSON.stringify(l));
    assert.ok(!/[\p{Extended_Pictographic}]/u.test(wide.lines.join("")), "no emoji");
  });

  test("a click on Yes runs Close (as y does); on No, or anywhere else, back to the menu (as another key)", () => {
    // Yes: each of its columns (its brackets too), on its row; wherever the frame put it.
    for (const [cols, rows] of [
      [60, 6],
      [30, 6],
      [26, 3],
    ]) {
      const a = asking(cols, rows);
      assert.deepEqual(a.v.click(a.yes, a.row), closed, `${cols}×${rows}`);
      const last = asking(cols, rows);
      assert.deepEqual(last.v.click(last.yes + "[ Yes ]".length - 1, last.row), closed, "its last column");
    }
    // No: back to the menu, nothing run; the next key is the menu's own again.
    const no = asking();
    assert.deepEqual(no.v.click(no.no, no.row), { kind: "none" });
    assert.equal(no.v.asking, null);
    assert.match(plain(no.v.frame(40, menu.items.length))[0], /^ {3}Kiko +0 $/);
    // Elsewhere: beside Yes (the leading space, the gap, past No), the question's row, under the buttons.
    const elsewhere = (a: ReturnType<typeof asking>): [number, number, string][] => [
      [1, a.row, "the leading space"],
      [a.yes + "[ Yes ]".length, a.row, "the gap after Yes"],
      [a.no + "[ No ]".length, a.row, "past No"],
      [a.yes, 1, "the question, above Yes"],
      [a.yes, a.row + 1, "under Yes"],
    ];
    for (let k = 0; k < elsewhere(asking()).length; k++) {
      const a = asking();
      const [x, y, what] = elsewhere(a)[k];
      assert.deepEqual(a.v.click(x, y), { kind: "none" }, what);
      assert.equal(a.v.asking, null, what);
    }
  });

  test("the keys as before: y (or Y) runs Close; any other key goes back to the menu", () => {
    assert.deepEqual(asking().v.key("y"), closed);
    assert.deepEqual(asking().v.key("Y"), closed);
    for (const k of ["n", "\r", "\x1b", "x"]) {
      const a = asking();
      assert.deepEqual(a.v.key(k), { kind: "none" }, JSON.stringify(k));
      assert.equal(a.v.asking, null);
    }
  });

  test("Quit's press-again hint takes no click: it stays up, and q still quits", () => {
    const v = new MenuView(menu);
    v.key("q");
    assert.deepEqual(v.click(2, 1), { kind: "none" });
    assert.notEqual(v.asking, null);
    assert.deepEqual(v.key("q"), { kind: "run", commands: [ask("quit")] });
  });
});

describe("the menu's search (/)", () => {
  const ask = asker("%9", TOKEN);
  const setting = (key: string, label: string) => ({ key, label, value: "", raw: "", restart: false }) as UiState["settings"][number];
  const s = state({
    sessions: [inTmux("pixie", "%1", { status: "blocked" }), inTmux("lacy", "%2", { title: "Fix the router" }), inTmux("cloud speech", "%3", { cwd: "/code/claude-code-speech" })],
    window: { shown: "%1", note: "" },
    settings: [
      setting("voiceCan", "Voice can"),
      setting("tts", "Voice engine"),
      setting("voice", "Voice"),
      setting("mic", "Microphone"),
      setting("projectsRoot", "Projects root"),
      setting("voicePermissions", "Permissions by voice"),
    ],
  });
  const menu = windowMenu(s, ask);
  const go = (page: string) => ({ kind: "run", commands: [ask("go", page)] });
  const plain = (v: MenuView, rows = menu.items.length) => v.frame(44, rows).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  /** The results' lines as drawn (no search line, no blank rows, no hint), the chosen one marked ">". */
  const results = (v: MenuView) => {
    const lines = v.frame(44, menu.items.length);
    return lines.slice(1, -1).flatMap((l) => {
      const text = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
      return text ? [`${l.startsWith("\x1b[7") ? ">" : ""}${/^─+$/.test(text) ? "─" : text.replace(/ {2,}/g, " | ")}`] : [];
    });
  };
  const typed = (...keys: string[]) => {
    const v = new MenuView(menu);
    for (const k of keys) assert.deepEqual(v.key(k), { kind: "none" }, `${JSON.stringify(k)} typed`);
    return v;
  };

  test("/ starts it: a search line at the top; what's typed narrows the list live, best first, the chosen one the best", () => {
    const v = typed("/");
    assert.equal(v.query, "");
    assert.equal(plain(v)[0], " / ▏");
    assert.equal(plain(v).at(-1), " ↑↓ move · ⏎ pick · Esc clears");
    v.key("p");
    assert.equal(plain(v)[0], " / p▏");
    // Sessions and commands first (a session's number, a command's key); then, under a line, the settings.
    assert.deepEqual(results(v), [
      ">▸ pixie ⚠ needs you | 1",
      "Previous session | p",
      "cloud speech | 3",
      "Interrupt (Escape) | i",
      "Hide window (keeps listening) | d",
      "─",
      "Settings → Permissions by voice",
      "Settings → Projects root",
      "Settings → Microphone",
    ]);
    v.key("i");
    assert.deepEqual(results(v), [">▸ pixie ⚠ needs you | 1"]);
    // Forgiving: "pie" also has its letters in order in "PrevIous sEssion" and "Permissions by voIcE".
    assert.deepEqual(results(typed("/", ..."pie")), [">▸ pixie ⚠ needs you | 1", "Previous session | p", "Hide window (keeps listening) | d", "─", "Settings → Permissions by voice"]);
  });

  test("ranked by how well: the whole words, their start, from a word's start, inside, the starts of words, the letters in order; then the menu's own order", () => {
    assert.equal(searchScore("voice", "Voice"), 0);
    assert.equal(searchScore("voi", "Voice engine"), 1);
    assert.equal(searchScore("engine", "Voice engine"), 2);
    assert.equal(searchScore("ice", "Voice"), 3);
    assert.equal(searchScore("nese", "Next session"), 4);
    assert.equal(searchScore("pxe", "pixie"), 5);
    assert.equal(searchScore("pe", "pixie"), null, "two letters in order: too many match");
    assert.equal(searchScore("zz", "pixie"), null);
    assert.equal(searchScore("PIX", "pixie"), 1, "any case");
    assert.equal(searchScore("", "anything"), 0);
    // "voice": Voice before Voice can and Voice engine (the menu's order between those two), then by voice.
    assert.deepEqual(results(typed("/", ..."voice")), [">Settings → Voice", "Settings → Voice can", "Settings → Voice engine", "Settings → Permissions by voice"]);
    // The starts of words (NExt SEssion, NEw SEssion), before what has the letters only in order.
    assert.deepEqual(results(typed("/", ..."nese")), [">Next session | n", "New session… | c", "Interrupt (Escape) | i", "Hide window (keeps listening) | d"]);
    assert.deepEqual(results(typed("/", ..."pxe")), [">▸ pixie ⚠ needs you | 1"]);
    // As good a match: the menu's own order (Tab's first, then the session's group, then the commands).
    assert.deepEqual(results(typed("/", ..."sess")), [">Switch list ⇄ session | Tab", "Close this session… | x", "Next session | n", "Previous session | p", "Last session | l", "New session… | c"]);
    // A session's name before its title, as good a match.
    const twins = windowMenu(state({ sessions: [inTmux("notes", "%1", { title: "router fix" }), inTmux("router", "%2")] }), ask);
    const found = new MenuView(twins);
    for (const k of ["/", ..."router"]) found.key(k);
    assert.deepEqual(
      found.results()[0].map((r) => (twins.items[r.n] as { label: string }).label.trim()),
      ["router", "notes"],
    );
  });

  test("↑ ↓ move over the results (round the ends), Enter runs what that item runs: a page, a command, its question first", () => {
    const v = typed("/", ..."sess");
    assert.deepEqual(v.key("\r"), { kind: "run", commands: [["select-pane", "-t", `=${WINDOW}:.+`]] }, "the best: Tab's");
    const down = typed("/", ..."sess", "\x1b[B", "\x1b[B");
    assert.deepEqual(results(down)[2], ">Next session | n");
    assert.deepEqual(down.key("\r"), { kind: "run", commands: [ask("step", "next")] });
    const up = typed("/", ..."sess", "\x1b[A");
    assert.deepEqual(results(up).at(-1), ">New session… | c", "up from the first: the last");
    assert.deepEqual(up.key("\r"), { kind: "run", commands: [ask("new")] });
    const close = typed("/", ..."sess", "\x1b[B");
    assert.deepEqual(close.key("\r"), { kind: "none" }, "Close asks first");
    assert.match(plain(close, 6)[0], /^ Close pixie\? Claude Code ends there\./);
    assert.deepEqual(close.key("y"), { kind: "run", commands: [ask("close", "pixie")] });
    const back = typed("/", ..."quit");
    back.key("\r");
    assert.match(plain(back)[0], /^ Press q again to quit/, "Quit's hint");
    assert.deepEqual(back.key("n"), { kind: "none" }, "Quit's hint let go");
    assert.equal(plain(back)[0], " / quit▏", "back to the search");
    assert.deepEqual(typed("/", ..."lacy").key("\r"), go("session:lacy"));
    // A click on a result's row picks it (the search line first).
    const clicked = typed("/", ..."sess");
    plain(clicked);
    assert.deepEqual(clicked.click(1, 4), { kind: "run", commands: [ask("step", "next")] }, "the third result: Next session");
    assert.deepEqual(clicked.click(1, 1), { kind: "none" }, "the search line");
  });

  test("a session found by its folder and by Claude's title (as the router knows them), what it matched by said beside it", () => {
    const byFolder = typed("/", ..."claude-code");
    assert.deepEqual(results(byFolder), [">cloud speech claude-code-speech | 3"]);
    assert.deepEqual(byFolder.key("\r"), go("session:cloud speech"));
    const byTitle = typed("/", ..."router");
    assert.deepEqual(results(byTitle), [">lacy Fix the router | 2"]);
    assert.deepEqual(byTitle.key("\r"), go("session:lacy"));
    assert.deepEqual(
      menu.items.filter((i): i is Exclude<MenuEntry, "-"> => i !== "-" && i.key === "3").map((i) => i.find),
      [["cloud speech", "claude-code-speech", ""]],
    );
  });

  test("a setting found opens settings on its row; the app's settings ask takes it", () => {
    const v = typed("/", ..."microph");
    assert.deepEqual(results(v), [">Settings → Microphone"]);
    const picked = v.key("\r");
    assert.deepEqual(picked, { kind: "run", commands: [ask("settings", "mic")] });
    assert.equal(hexOf((picked as { commands: string[][] }).commands[0]), `\x1b_kiko;${TOKEN};settings;mic\x1b\\`);
    // In the settings screen's order, only its rows (none without a group of its own there).
    const keys = (rows: UiState["settings"]) => windowMenu({ ...s, settings: rows }, ask).search!.apart!.map((i) => (i === "-" ? "-" : i.label));
    assert.deepEqual(keys([setting("mic", "Microphone"), setting("voice", "Voice"), setting("nope" as never, "Nope")]), ["Settings → Voice", "Settings → Microphone"]);
  });

  test("nothing matches: a dim line saying so; Enter does nothing", () => {
    const v = typed("/", ..."zzzq");
    assert.deepEqual(results(v), ["nothing matches"]);
    assert.ok(v.frame(44, menu.items.length)[1].startsWith("\x1b[2m"), "dim");
    assert.deepEqual(v.key("\r"), { kind: "none" });
    assert.deepEqual(v.key("\x1b[B"), { kind: "none" });
  });

  test("while searching, every letter and digit is the search's, never an item's key (q, s, 2, Space); the Kiko key again still passes it on", () => {
    const v = typed("/", "q", "s", "2", " ", "x", "/");
    assert.equal(v.query, "qs2 x/");
    assert.equal(v.asking, null, "q didn't ask to quit");
    assert.deepEqual(typed("/").key("\x00"), { kind: "run", commands: [ask("pass")] });
    assert.deepEqual(typed("/", "r").key("\x1b[32;5u"), { kind: "run", commands: [ask("pass")] });
    assert.deepEqual(typed("/").key("\x03"), { kind: "close" }, "Ctrl+C");
    // Not searching: the keys as ever.
    assert.deepEqual(new MenuView(menu).key("2"), go("session:lacy"));
  });

  test("Backspace edits; on an empty search it ends it. Escape ends it (the whole menu, its highlight where it was); Escape again closes", () => {
    const v = typed("/", "r", "o", "\x7f");
    assert.equal(v.query, "r");
    v.key("\b");
    assert.equal(v.query, "");
    assert.deepEqual(v.key("\x7f"), { kind: "none" });
    assert.equal(v.query, null);
    assert.match(plain(v)[0], /^ {3}Kiko +0$/);
    const esc = typed("/", "t", "a", "\x1b[B");
    assert.deepEqual(esc.key("\x1b"), { kind: "none" });
    assert.equal(esc.query, null);
    assert.equal(esc.at, 1, "the page shown chosen still");
    assert.deepEqual(plain(esc), plain(new MenuView(menu)));
    assert.deepEqual(esc.key("\x1b"), { kind: "close" });
    // CSI u: Escape as the terminal may send it.
    const csi = typed("/", "t");
    csi.key("\x1b[27u");
    assert.equal(csi.query, null);
    assert.deepEqual(csi.key("2"), go("session:lacy"), "the keys again");
  });

  test("the pages past those listed are found too; menus without `search` (a session's right-click one, a checklist) take / as nothing", () => {
    const many = state({ sessions: Array.from({ length: 14 }, (_, i) => inTmux(`s${i}`, `%${i}`)), window: { shown: null, note: "", viewing: PAGE_ID } });
    const m = windowMenu(many, ask);
    assert.ok(!m.items.some((i) => i !== "-" && i.label.trim() === "s13"));
    const v = new MenuView(m);
    for (const k of ["/", ..."s13"]) v.key(k);
    assert.deepEqual(v.key("\r"), go("session:s13"));
    const right = new MenuView(sessionMenu(inTmux("pixie", "%1"), ask));
    assert.deepEqual(right.key("/"), { kind: "none" });
    assert.equal(right.query, null);
  });
});

describe("a session's right-click menu", () => {
  test("in Kiko's tmux: Enter shows (highlighted to start with), r rename (as in the list), i interrupt, x close (asked first); outside, with nothing it can do there: show only", () => {
    const m = sessionMenu(inTmux("pi#xie", "%1"), asker("%9", TOKEN));
    const items = m.items.filter((i) => i !== "-") as Array<Exclude<MenuEntry, "-">>;
    assert.deepEqual(
      items.map((i) => [i.key, i.label]),
      [
        ["⏎", "Show"],
        ["r", "Rename…"],
        ["i", "Interrupt (Escape)"],
        ["x", "Close this session…"],
      ],
    );
    assert.deepEqual(new MenuView(m).key("\r"), { kind: "run", commands: [asker("%9", TOKEN)("go", "session:pi#xie")] });
    assert.deepEqual(new MenuView(m).key("s"), { kind: "none" }, "s is Settings, not here");
    assert.deepEqual(new MenuView(m).key("r"), { kind: "run", commands: [asker("%9", TOKEN)("rename", "pi#xie")] }, "r renames, as in the list");
    assert.deepEqual(new MenuView(m).key("."), { kind: "none" }, ". is repeat, not here");
    const moved = new MenuView(m);
    moved.key("\x1b[B");
    assert.deepEqual(moved.key("\r"), { kind: "run", commands: [asker("%9", TOKEN)("rename", "pi#xie")] });
    assert.equal(m.title, " pi#xie ");
    assert.equal(items[3].confirm, "Close pi#xie? Claude Code ends there.");
    assert.equal(hexOf(items[3].run![0]), `\x1b_kiko;${TOKEN};close;pixie\x1b\\`);
    const outside = sessionMenu(session("notes", { place: { via: "ghostty", id: "g", keys: true } }), asker("%9", TOKEN));
    assert.deepEqual(
      outside.items.filter((i) => i !== "-" && i.run).map((i) => i !== "-" && i.label),
      ["Show"],
    );
  });
});

describe("outside Kiko's tmux: what each session can do", () => {
  const ghostty = (name: string, mapping: Session["mapping"], fields: Partial<Session> = {}) => session(name, { place: { via: "ghostty", id: "g1", keys: true }, mapping, pid: 501, ...fields });
  const kinds: Array<[string, Session, string[]]> = [
    ["in Kiko's tmux", inTmux("pixie", "%1"), ["Show", "Rename…", "Interrupt (Escape)", "Close this session…"]],
    ["Ghostty, its window found by its title", ghostty("notes", "title"), ["Show", "Rename…", "Interrupt (Escape)", "Close this session…"]],
    ["Ghostty, the only Claude window in its folder", ghostty("notes", "only"), ["Show", "Rename…", "Interrupt (Escape)", "Close this session…"]],
    ["Ghostty, not sure which window (a place but no sure match)", ghostty("notes", "ambiguous"), ["Show", "Close this session…"]],
    ["Warp, iTerm, herdr or your own tmux: nothing reaches it", session("warp", { pid: 502, mapping: "none" }), ["Show", "Close this session…"]],
    ["several Ghostty windows could be it", session("twins", { pid: 503, mapping: "ambiguous" }), ["Show", "Close this session…"]],
    ["a background job", session("job", { kind: "background", jobId: "b5d81f3a", pid: 504 }), ["Show", "Close this session…"]],
    ["a background job whose job isn't known", session("job2", { kind: "background", pid: 505 }), ["Show"]],
    ["its process not known", session("nopid", { mapping: "none" }), ["Show"]],
    ["the Claude desktop app", session("2 plus 2", { desktop: true, pid: 506 }), ["Show"]],
    // Through T3's server, no key: its run interrupted, its title changed, archived (core/can.ts, agents/t3code).
    ["a T3 Code thread", session("thread", { agent: "t3code", place: { via: "t3code", id: "t1", keys: false }, mapping: "none" }), ["Show", "Rename…", "Interrupt", "Archive in T3 Code…"]],
  ];
  const labels = (m: MenuData) => m.items.filter((i): i is Exclude<MenuEntry, "-"> => i !== "-" && Boolean(i.run)).map((i) => i.label);

  for (const [what, it, expected] of kinds) {
    test(`${what}: ${expected.slice(1).join(", ") || "show only"}`, () => {
      const m = sessionMenu(it, asker("%9", TOKEN));
      assert.deepEqual(labels(m), expected);
      const can = canDo(it);
      assert.deepEqual(
        [can.rename, can.interrupt, can.close],
        [/^Rename…$/, /^Interrupt/, /^(Close this session|Archive in T3 Code)…$/].map((l) => expected.some((e) => l.test(e))),
      );
      // Nothing it can do: said, dim, as before.
      if (expected.length === 1) assert.ok(m.items.some((i) => i !== "-" && i.label === "outside: read-only here"));
    });
  }

  test("Close asks first: it ends in its terminal (or its job stops), and a reply it's in the middle of is lost", () => {
    const confirm = (it: Session) => sessionMenu(it, asker("%9", TOKEN)).items.find((i): i is Exclude<MenuEntry, "-"> => i !== "-" && i.key === CLOSE_KEY)!.confirm;
    assert.equal(confirm(session("warp", { pid: 502 })), "Close warp? Claude Code ends in its terminal.");
    assert.equal(confirm(session("warp", { pid: 502, status: "busy" })), "Close warp? Claude Code ends in its terminal. Its current reply will be lost.");
    assert.equal(confirm(session("warp", { pid: 502, status: "blocked" })), "Close warp? Claude Code ends in its terminal. Its current reply will be lost.");
    assert.equal(confirm(session("job", { kind: "background", jobId: "j" })), "Close job? Its background job stops.");
    assert.equal(confirm(session("parked", { pid: 9, jobId: "j", status: "busy" })), "Close parked? Claude Code ends in its terminal, its background job too. Its current reply will be lost.");
    assert.equal(closeOutsidePrompt(session("warp", { pid: 502 })), "Close warp? Claude Code ends in its terminal.");
    assert.equal(confirm(inTmux("pixie", "%1", { status: "busy" })), closePrompt("pixie"), "in Kiko's tmux: as before");
    // A T3 Code thread is archived, its run stopped first.
    const thread = (fields: Partial<Session> = {}) => session("Pixie login", { agent: "t3code", place: { via: "t3code", id: "t1", keys: false }, mapping: "none", ...fields });
    assert.equal(confirm(thread()), "Archive Pixie login in T3 Code? It leaves the list; T3 can bring it back.");
    assert.equal(confirm(thread({ status: "busy" })), "Archive Pixie login in T3 Code? It leaves the list; T3 can bring it back. Its current run is stopped first.");
  });

  test("the Ctrl+Space menu, viewing an outside session's conversation: what it can do, under its name; the menu key twice still only to one shown", () => {
    const warp = session("warp", { pid: 502 });
    const notes = ghostty("notes", "title");
    const desk = session("2 plus 2", { desktop: true, pid: 506 });
    const s = state({ sessions: [inTmux("pixie", "%1"), warp, notes, desk] });
    const group = (viewing: string) => {
      const m = windowMenu({ ...s, window: { shown: null, note: "", viewing } }, asker("%9", TOKEN));
      const at = m.items.findIndex((i) => i !== "-" && i.rule);
      if (at < 0) return [];
      const end = m.items.indexOf("-", at);
      return m.items.slice(at, end).map((i) => (i === "-" ? "-" : `${i.key ?? ""}|${i.label}`));
    };
    assert.deepEqual(group("session:warp"), ["|warp", "x|Close this session…"]);
    assert.deepEqual(group("session:notes"), ["|notes", "r|Rename…", "i|Interrupt (Escape)", "x|Close this session…"]);
    assert.deepEqual(group("session:2 plus 2"), [], "the desktop app's: no group at all");
    assert.deepEqual(group(PAGE_ID), []);
    assert.equal(actionableSession({ ...s, window: { shown: null, note: "", viewing: "session:warp" } })?.sessionId, "warp");
    assert.equal(shownSession({ ...s, window: { shown: null, note: "", viewing: "session:warp" } }), null, "not shown: the menu key twice passes nothing to it");
    const m = windowMenu({ ...s, window: { shown: null, note: "", viewing: "session:warp" } }, asker("%9", TOKEN));
    assert.ok(!m.items.some((i) => i !== "-" && i.label.includes("again")));
    const x = m.items.find((i): i is Exclude<MenuEntry, "-"> => i !== "-" && i.key === CLOSE_KEY)!;
    assert.equal(hexOf(x.run![0]), `\x1b_kiko;${TOKEN};close;warp\x1b\\`);
    // Shown in Kiko's tmux: as before, its group with the line saying where the key twice goes.
    const shown = windowMenu({ ...s, window: { shown: "%1", note: "" } }, asker("%9", TOKEN));
    assert.ok(shown.items.some((i) => i !== "-" && i.label === "⌃Space again: ⌃Space to pixie"));
  });
});
