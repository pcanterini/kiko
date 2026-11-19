// The Kiko window's views of the app (src/ui/): the bottom line (bar.ts), the list rendered with
// Ink and driven by its keys and clicks (window-list.ts: pages, the permission card at the bottom, the picker,
// renaming), and the app's side of it on a pretend tmux (window-glue.ts): the bottom line and the menu
// kept to the app's state, Kiko's page in an empty stage, a page shown when asked (a session,
// an outside one's viewer, Kiko's), a session's right-click menu, settings zoomed and back.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, test } from "node:test";
import React from "react";
import { render } from "ink";
import type { Session } from "../../../src/core/sessions.ts";
import { ui, type UiState } from "../../../src/core/ui-store.ts";
import { WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { agent } from "../../../src/agents/index.ts";
import { BAR, LABEL, MENU, MENU_DATA, openWindow, ROLE, VIEWER_INFO, VIEWING } from "../../../src/terminals/tmux/window.ts";
import { inkInput, windowEvents, type Pointer } from "../../../src/ui/input.ts";
import { EventEmitter } from "node:events";
import { asker, DESKTOP_MARK, PAGE_ID, windowMenu } from "../../../src/ui/nav.ts";
import { t3code } from "../../../src/agents/t3code/index.ts";
import { createRequire } from "node:module";

// Ink's own width measure (string-width, and the East Asian widths under it), as Ink resolves them.
const fromInk = createRequire(import.meta.resolve("ink"));
const stringWidthPath = fromInk.resolve("string-width");
const { default: stringWidth } = (await import(stringWidthPath)) as { default: (s: string) => number };
const { eastAsianWidthType } = (await import(createRequire(stringWidthPath).resolve("get-east-asian-width"))) as { eastAsianWidthType: (c: number) => string };
import { barText, keyName, literal } from "../../../src/ui/bar.ts";
import { startWindow } from "../../../src/ui/window-glue.ts";
import { WindowList, wrapWords } from "../../../src/ui/window-list.ts";
import { describeTool } from "../../../src/core/decisions.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";
import { inkDone, typeKeys, untilFrame } from "../../support/ink.ts";
import { QUIT_AGAIN_MS, quitHintFor } from "../../../src/ui/quit-again.ts";
import { checkWaits } from "../../support/until.ts";

const session = (name: string, fields: Partial<Session> = {}) =>
  ({ sessionId: name, cwd: `/code/${name}`, givenName: name, kind: "interactive", status: "idle", desktop: false, place: null, mapping: "none", nameSetBy: "user", ...fields }) as unknown as Session;
const inTmux = (name: string, pane: string, fields: Partial<Session> = {}) => session(name, { place: { via: "tmux", id: pane, keys: true, pid: 1 }, ...fields });
const state = (patch: Partial<UiState>): UiState => ({ ...ui.state, about: { ...ui.state.about, hotkey: "right_option" }, ...patch });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = checkWaits(3000, 20);
/** This process's log lines of `event` (src/core/log.ts writes them under logs/ in the test's own folder: tests/setup.ts). */
const logged = (event: string): Array<Record<string, any>> =>
  readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join("logs", f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((l) => l.event === event);
/** Text without colours. */
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
/** tmux's styles out, for reading. */
const unstyled = (s: string) => s.replace(/#\[[^\]]*\]/g, "");

describe("the bottom line", () => {
  test("the talk key as on the keyboard", () => {
    assert.deepEqual(["right_option", "left_command", "fn", "f13", "keycode:99"].map(keyName), ["right ⌥", "left ⌘", "fn", "F13", "key 99"]);
  });
  test("ready and how to talk; what you said before isn't left in it", () => {
    const s = state({ lines: [{ id: 1, at: 0, kind: "you", text: "tell lacy to run the tests" }] });
    assert.equal(unstyled(barText(s)), "● Kiko is readyhold right ⌥ to talk · ⌃Space menu ");
  });
  test("the talk key not heard (no Input Monitoring): in yellow on the line until it is; not in tap mode", () => {
    const off = "Right Option isn't heard: allow Kiko Dev in macOS's dialog (maybe behind this window) or Settings → Input Monitoring";
    const s = state({ talkKeyOff: off });
    assert.ok(barText(s).includes(`#[fg=yellow]${off}#[default]`), barText(s));
    assert.doesNotMatch(barText(state({ talkKeyOff: off, about: { ...s.about, pttMode: "tap" } })), /isn't heard/);
    assert.doesNotMatch(barText(state({ talkKeyOff: null })), /isn't heard/);
  });
  test("the free trial: a short dim item, yellow near its end; none without one", () => {
    const on = barText(state({ plan: { text: "trial · 6d left", warn: false } }));
    assert.ok(on.includes(" #[dim]·#[nodim] #[dim]trial · 6d left#[nodim]"), on);
    assert.ok(barText(state({ plan: { text: "trial · 2d left", warn: true } })).includes("#[fg=yellow]trial · 2d left#[default]"));
    assert.doesNotMatch(barText(state({ plan: null })), /trial/);
    assert.doesNotMatch(barText(state({})), /trial/);
  });
  test("the microphone not allowed: in yellow on the line until it is, in tap mode too", () => {
    const off = "The mic isn't allowed: turn it on in System Settings → Privacy & Security → Microphone → Kiko Dev";
    const s = state({ micOff: off });
    assert.ok(barText(s).includes(`#[fg=yellow]${off}#[default]`), barText(s));
    assert.ok(barText(state({ micOff: off, about: { ...s.about, pttMode: "tap" } })).includes(off));
    assert.doesNotMatch(barText(state({ micOff: null })), /isn't allowed/);
  });
  test("your words only while you say them: speaking shows them, let go (deciding) and done they're gone", () => {
    const said = "tell lacy to run the tests";
    const you = { id: 1, at: 0, kind: "you" as const, text: said };
    // Speaking: the words as they come.
    assert.match(unstyled(barText(state({ listening: true, interim: said }))), /^● listening “tell lacy to run the tests”/);
    // Let go, being worked out: the state, not the words (interim may still hold them).
    const deciding = unstyled(barText(state({ listening: false, interim: said, deciding: { text: said, startedAt: 0 }, lines: [you] })));
    assert.match(deciding, /^… deciding/);
    assert.ok(!deciding.includes("tell lacy"), deciding);
    // Done: where they went for a moment, then ready; the words never again.
    const routed = unstyled(barText(state({ routed: { text: said, to: "lacy", sessionId: "lacy", tookMs: 300, at: Date.now() }, lines: [you] })));
    assert.match(routed, /^sent to → lacy/);
    assert.ok(!routed.includes("run the tests"), routed);
    const after = unstyled(barText(state({ lines: [you] })));
    assert.ok(!after.includes("run the tests"), after);
    // Held a moment (a send it wasn't sure of): where to, not what.
    const holding = unstyled(barText(state({ holding: { text: said, to: "lacy", sessionId: "lacy", startedAt: 0 }, lines: [you] })));
    assert.match(holding, /^sending to → lacy/);
    assert.ok(!holding.includes("run the tests"), holding);
  });
  test("speaking", () => {
    assert.match(unstyled(barText(state({ speaking: true }))), /^♪ speaking/);
    assert.match(unstyled(barText(state({ handsFree: { on: true, by: null } }))), /Kiko is listening for “Kiko”.*say “Kiko, …” or hold right ⌥/);
  });
  test("who waits for you: the open window first, then any other that needs you", () => {
    const s = state({
      waiting: { sessionId: "pixie", name: "pixie", kind: "permission", phase: "waiting", until: null },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2", { status: "blocked" })],
    });
    assert.match(unstyled(barText(s)), /⚠ pixie needs you · ⚠ lacy needs you/);
  });
  test("a talk key's name from settings goes in as text too", () => {
    const s = state({});
    s.about = { ...s.about, hotkey: "#(touch x)#[fg=red]" };
    assert.match(barText(s), /hold ####\(touch x\)##\[fg=red\] to talk/);
  });
  test("a background job stopped on a question of its own waits for you (yellow), after any that need you; never red", () => {
    const s = state({ sessions: [session("job", { kind: "background", status: "waiting" }), inTmux("lacy", "%2", { status: "blocked" })] });
    const bar = barText(s);
    assert.match(unstyled(bar), /⚠ lacy needs you · ◆ job waits for you/);
    assert.match(bar, /#\[fg=yellow\]◆ job waits for you/);
    assert.ok(!/job needs you/.test(bar));
  });
  test("what was said goes in as itself: # can't start a tmux style", () => {
    assert.equal(literal("fix #[bold] now ##[x] #(y) #{z} #"), "fix ##[bold] now ####[x] ####(y) ####{z} ####");
    assert.equal(literal("x".repeat(80), 10), `${"x".repeat(9)}…`);
  });
});

// Where Ink starts a frame after the first: it erases the one before, from the top (ESC[1;1H ESC[J)
// when that filled the pane, else line by line upward (ESC[2K ESC[1A …, then ESC[G); Ink before 7
// cleared the screen (ESC[2J).
const FRAME_START = /\u001b\[2J|\u001b\[1;1H\u001b\[J|(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;

/**
 * A terminal for Ink: output kept, input fed by the test. What the list's effects change comes in a
 * later frame, throttled (Ink's maxFps), so a fixed wait read the frame before it on a slow machine (a
 * CI runner: the rename field still empty, 2026-11-02): each wait is for Ink to be through
 * (tests/support/ink.ts inkDone), or for what a key or click asks for.
 */
function terminal(columns = 32, rows = 20) {
  let text = "";
  const stdout = new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }) as Writable & { columns: number; rows: number; isTTY: boolean };
  Object.assign(stdout, { columns, rows, isTTY: true });
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(on: boolean): void; ref(): void; unref(): void };
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  /** The screen: the last frame drawn. */
  const last = () => plain(text.split(FRAME_START).at(-1) ?? text);
  return { stdout, stdin, last };
}

describe("the list", () => {
  test("in the classic look (a box of its own, titled Sessions by tmux): the full screen's two lines a row, its state and folder under the name; a click on either line is the row's", async () => {
    const s = state({
      sessionsLoaded: true,
      window: { shown: "%1", note: "", look: "classic" },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2", { status: "busy", givenName: "lacy", cwd: "/code/lacy-api" })],
    });
    const { out } = await drawn(s, 36);
    const lines = out.split("\n");
    // One column in from the border tmux draws (the box's); INTERNAL over the sessions in Kiko's tmux.
    assert.equal(lines[0], " 0   ▪  Kiko");
    assert.equal(lines[1], "     the conversation");
    assert.equal(lines[2], " ── INTERNAL ──");
    assert.equal(lines[3], " 1   ✻  pixie");
    assert.equal(lines[4], "     ● idle");
    assert.equal(lines[5], " 2   ✻  lacy");
    assert.match(lines[6], /^ {5}● working · .*lacy-api/);
    assert.equal(lines[7], "     +  new session (c)");
    // Room for Enter's too (the dots alone): picking here only previews.
    assert.ok(out.includes("⏎ open · c new · ⇥ session") && !out.includes("Space menu"), out);
    // A click on a row's second line shows it, as one on its first (a preview: the keyboard stays in the list).
    const t = terminal(36);
    const acts: unknown[] = [];
    const takeIt = (a: unknown) => void acts.push(a);
    ui.on("action", takeIt);
    const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
    try {
      await inkDone(app);
      windowEvents.emit("pointer", { x: 4, y: 6, button: "left", press: true });
      await until(() => acts.length, "the click's act");
      assert.deepEqual(acts, [{ type: "show", page: "session:lacy", focus: false }]);
    } finally {
      app.unmount();
      ui.off("action", takeIt);
    }
  });

  test("what a session still runs in the background shows quietly after its state, never as working: short in the narrow list, in words in the classic look, quiet ones flagged", async () => {
    const eightHours = Date.now() - 8 * 3600_000 - 60_000;
    const sessions = [
      inTmux("pixie", "%1", { background: { count: 2 } }),
      inTmux("job", "%2", { background: { count: 3, quiet: 3, quietSince: eightHours } }),
      inTmux("lacy", "%3", { status: "busy", background: { count: 2, quiet: 1, quietSince: Date.now() - 25 * 60_000 } }),
    ];
    const narrow = async (columns: number) => (await drawn(state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions }), columns)).out.split("\n").map((l) => l.trimEnd());
    const rows = await narrow(50);
    assert.match(rows.find((r) => r.includes("pixie"))!, /pixie +● idle · 2 bg$/);
    assert.match(rows.find((r) => r.includes("job"))!, /job +● idle · 3 bg \(quiet 8h\)$/);
    assert.match(rows.find((r) => r.includes("lacy"))!, /lacy +● working · 2 bg \(1 quiet 25m\)$/);
    // Narrower, it gives way before the name does: its quiet flag first, then all of it.
    const tighter = await narrow(34);
    assert.match(tighter.find((r) => r.includes("job"))!, /job +● idle · 3 bg$/);
    assert.match(tighter.find((r) => r.includes("lacy"))!, /lacy +● working · 2 bg$/);
    const tightest = await narrow(26);
    assert.match(tightest.find((r) => r.includes("job"))!, /job +● idle$/);
    assert.match(tightest.find((r) => r.includes("lacy"))!, /lacy +● working$/);
    const classic = (await drawn(state({ sessionsLoaded: true, window: { shown: "%1", note: "", look: "classic" }, sessions }), 60)).out.split("\n");
    assert.equal(classic[classic.findIndex((l) => l.includes("pixie")) + 1].trimEnd(), "     ● idle · 2 in background");
    assert.match(classic[classic.findIndex((l) => l.includes("job")) + 1], /^ {5}● idle · 3 in background \(quiet 8h\)/);
  });

  test("a note wraps at spaces, no line starting with one; a word too long is cut", () => {
    const note = "Kiko was started in Ghostty, not in this window, so it can't be shown here. You can still talk to it.";
    const lines = wrapWords(note, 28).split("\n");
    assert.deepEqual(lines, ["Kiko was started in Ghostty,", "not in this window, so it", "can't be shown here. You can", "still talk to it."]);
    assert.equal(wrapWords("abcdefghij xy", 4), "abcd\nefgh\nij\nxy");
  });

  test("no arrow while you browse the list (the highlight says which); a gray ► on the one shown once you're in it (the keyboard in the stage), in both looks", async () => {
    for (const look of ["classic", undefined] as const) {
      const at = (inStage: boolean) => state({ sessionsLoaded: true, window: { shown: "%1", note: "", inStage, ...(look ? { look } : {}) }, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2")] });
      assert.ok(!(await drawn(at(false), 36)).out.includes("►"));
      const rows = (await drawn(at(true), 36)).out.split("\n");
      assert.match(rows.find((r) => r.includes("pixie"))!, /1 ► ✻ {2}pixie/);
      assert.equal(rows.filter((r) => r.includes("►")).length, 1, rows.join("\n"));
    }
  });

  test("Kiko (0) on top, the sessions numbered under INTERNAL, a new one with them; outside ones under EXTERNAL, numbered on; each one's state", async () => {
    const s = state({
      sessionsLoaded: true,
      window: { shown: "%1", note: "" },
      waiting: { sessionId: "lacy", name: "lacy", kind: "reply", phase: "waiting", until: null },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), inTmux("tideline", "%3", { status: "busy" }), session("clipkit", { place: { via: "ghostty", id: "g", keys: true } })],
    });
    const { out } = await drawn(s, 36);
    const rows = out.split("\n").map((l) => l.trimEnd());
    assert.match(rows[0], /^ {2}0 {3}▪ {2}Kiko$/);
    assert.match(rows[1], /── INTERNAL/);
    assert.match(rows[2], /^ {2}1 {3}✻ {2}pixie +● idle$/);
    assert.match(rows[3], /^ {2}2 {3}✻ {2}lacy +● waiting$/);
    assert.match(rows[4], /^ {2}3 {3}✻ {2}tideline +● working$/);
    assert.match(rows[5], /^ {6}\+ {2}new session \(c\)$/);
    assert.match(rows[6], /── EXTERNAL/);
    assert.match(rows[7], /^ {2}4 {3}✻ {2}clipkit +● idle$/);
    // INTERNAL with none in it yet: the heading and the new one still, so the two kinds are plain.
    const none = (
      await drawn(state({ sessionsLoaded: true, window: { shown: null, note: "", viewing: PAGE_ID }, sessions: [session("clipkit", { place: { via: "ghostty", id: "g", keys: true } })] }), 36)
    ).out
      .split("\n")
      .map((l) => l.trimEnd());
    assert.match(none[1], /── INTERNAL/);
    assert.match(none[2], /^ {6}\+ {2}new session \(c\)$/);
    assert.match(none[3], /── EXTERNAL/);
    // The list's keys, never the menu's (the window's line has it).
    assert.match(rows.at(-1)!, /^ {2}⏎ open · c new · ⇥ session$/);
    // Narrower: the dots alone, then without Enter's, before anything is cut.
    for (const [columns, hint] of [
      [30, "⏎ open · c new · ⇥ session"],
      [28, "⏎ open·c new·⇥ session"],
      [24, "c new · ⇥ session"],
    ] as const) {
      const last = (await drawn(s, columns)).out
        .split("\n")
        .map((l) => l.trimEnd())
        .at(-1)!;
      assert.equal(last, `  ${hint}`, `${columns} columns`);
      assert.ok(last.length <= columns - 1, `${columns} columns: ${last}`);
    }
  });

  test("background sessions under EXTERNAL, marked (background); one asking what next waits (yellow), it doesn't need you; the one viewed on the list as the others while you browse it", async () => {
    const job = await drawn(
      state({ sessionsLoaded: true, window: { shown: null, note: "", viewing: "session:job" }, sessions: [inTmux("pixie", "%1"), session("job", { kind: "background", status: "waiting" })] }),
      40,
    );
    assert.match(job.out, /EXTERNAL[^\n]*\n\s*2 {3}✻ {2}job \(background\)\s+● waiting/);
    assert.ok(!job.out.includes("needs you"), job.out);
    const page = await drawn(state({ sessionsLoaded: true, window: { shown: null, note: "", viewing: PAGE_ID }, sessions: [inTmux("pixie", "%1")] }), 40);
    assert.match(page.out, /0 {3}▪ {2}Kiko/);
  });

  test("a desktop app session: one app-window glyph after its name (dim, like the background note), one cell wide, the row lined up with the others", async () => {
    // Ink's own width (string-width), East Asian width neutral: never ambiguous, never two cells.
    assert.equal(stringWidth(DESKTOP_MARK), 1);
    assert.equal(eastAsianWidthType(DESKTOP_MARK.codePointAt(0)!), "neutral");
    const desk = session("2 plus 2", { desktop: true });
    const notes = session("notes", { place: { via: "ghostty", id: "g", keys: true } });
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), desk, notes] });
    const { out } = await drawn(s, 40);
    const rows = out.split("\n");
    assert.match(out, /EXTERNAL[^\n]*\n\s*2 {3}✻ {2}2 plus 2 ⧉\s+● idle\n\s*3 {3}✻ {2}notes\s+● idle/);
    assert.ok(!rows.some((r) => r.includes("notes ⧉") || r.includes("pixie ⧉")), "only on the desktop one");
    // The row lines up with the others: the state's column ends where theirs does.
    const at = (label: string) => rows.find((r) => r.includes(label))!;
    assert.equal(at("2 plus 2").trimEnd().length, at("notes").trimEnd().length);
  });

  test("keys: ↓ previews the next (shown, the keyboard staying in the list), Enter goes into it; a number previews that one (0 Kiko, outside ones too); n p l preview; the menu's other letters (c s , d q); Tab the session side; q or Q asks, y quits, anything else doesn't", async () => {
    const s = state({
      sessionsLoaded: true,
      window: { shown: "%1", note: "" },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), session("notes", { place: { via: "ghostty", id: "g", keys: true } })],
    });
    const acts = await typing(s, ["\u001b[B", "\r", "0", "3", "n", "p", "l", "c", "s", ",", "\t", "d", "q", "x", "Q", "y"]);
    assert.deepEqual(acts, [
      { type: "show", page: "session:lacy", focus: false },
      { type: "show", page: "session:lacy" },
      { type: "show", page: PAGE_ID, focus: false },
      { type: "show", page: "session:notes", focus: false },
      // n and p from the highlighted one (notes, the last), round the ends.
      { type: "show", page: PAGE_ID, focus: false },
      { type: "show", page: "session:notes", focus: false },
      { type: "last", focus: false },
      { type: "newSession" },
      { type: "settings" },
      { type: "settings" },
      { type: "focusStage" },
      { type: "detach" },
      { type: "quit" },
    ]);
  });

  test("going in: Enter or → on the highlighted one (shown and the keyboard there); on + new session Enter the picker, → nothing; the highlight goes where a number previews, ↓ on from there", async () => {
    const s = state({
      sessionsLoaded: true,
      window: { shown: "%1", note: "" },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), session("notes", { place: { via: "ghostty", id: "g", keys: true } })],
    });
    const right = "\u001b[C";
    assert.deepEqual(
      await typing(s, [right, "\r"]),
      [
        { type: "show", page: "session:pixie" },
        { type: "show", page: "session:pixie" },
      ],
      "the one shown: the keyboard there",
    );
    // 2 (lacy), ↓ + new session (nothing shown), → nothing, Enter the picker; ↓ notes (outside), → into its viewer; ↓ Kiko's row (round the end), Enter.
    assert.deepEqual(await typing(s, ["2", "\u001b[B", right, "\r", "\u001b[B", right, "\u001b[B", "\r"]), [
      { type: "show", page: "session:lacy", focus: false },
      { type: "newSession" },
      { type: "show", page: "session:notes", focus: false },
      { type: "show", page: "session:notes" },
      { type: "show", page: PAGE_ID, focus: false },
      { type: "show", page: PAGE_ID },
    ]);
    // ↑ from the one shown: Kiko's row (0) is previewed too.
    assert.deepEqual(await typing(s, ["\u001b[A"]), [{ type: "show", page: PAGE_ID, focus: false }]);
  });

  test("↓ held: each key a step, however fast they come (even several in one read); n p from the highlighted one", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), inTmux("tideline", "%3")] });
    const down = "\u001b[B";
    const acts = await typing(s, [down.repeat(3), "n", "n", "p"]);
    assert.deepEqual(acts, [
      { type: "show", page: "session:lacy", focus: false },
      { type: "show", page: "session:tideline", focus: false },
      // + new session: nothing shown; n from there goes on from the one shown (pixie).
      { type: "show", page: "session:lacy", focus: false },
      { type: "show", page: "session:tideline", focus: false },
      { type: "show", page: "session:lacy", focus: false },
    ]);
  });

  test("one tap, one act: a key's release (a terminal reporting key events sends ESC [ 109 ; 1 : 3 u after m, and tmux passes it on) never acts; a held key's repeats do, as presses; each act's key in the log, never what's typed", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), inTmux("tideline", "%3")] });
    const before = logged("list_key").length;
    // m and . tapped, each let go; ↓ pressed, held (a repeat), let go: the way the list reads its terminal (input.ts).
    const keys = ["m", "\x1b[109;1:3u", ".", "\x1b[46;1:3u", "\x1b[B", "\x1b[1;1:2B", "\x1b[1;1:3B"];
    assert.deepEqual(await typing(s, keys, true), [
      { type: "mute" },
      { type: "repeat" },
      { type: "show", page: "session:lacy", focus: false },
      { type: "show", page: "session:tideline", focus: false },
    ]);
    assert.deepEqual(
      logged("list_key")
        .slice(before)
        .map(({ key, type }) => ({ key, type })),
      [{ key: "m" }, { key: "." }, { key: "downArrow" }, { key: "downArrow", type: "repeat" }].map((l) => ({ type: undefined, ...l })),
    );
    // A new name typed: only Enter's act logged, not the letters.
    const renaming = state({ ...s, window: { shown: "%1", note: "", renaming: { sessionId: "pixie", name: "pixie" } } });
    const was = logged("list_key").length;
    assert.deepEqual(await typing(renaming, ["z", "q", "\r"], true), [{ type: "rename", sessionId: "pixie", name: "pixiezq" }]);
    assert.deepEqual(
      logged("list_key")
        .slice(was)
        .map((l) => l.key),
      ["return"],
    );
  });

  test("a key held down acts once: . m s held (the terminal's auto-repeat, or a kitty repeat) say, mute or open once; ↓ held still steps; a card's y held answers once; typing a name keeps every letter", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), inTmux("tideline", "%3")] });
    // Auto-repeat: the same key again and again, quickly; a kitty repeat: ESC [ 46 ; 1 : 2 u.
    assert.deepEqual(await typing(s, [".", ".", ".", "\x1b[46;1:2u", "m", "m", "s", "s"], true), [{ type: "repeat" }, { type: "mute" }, { type: "settings" }]);
    // Moving keeps repeating.
    assert.deepEqual(await typing(s, ["\x1b[B", "\x1b[B"], true), [
      { type: "show", page: "session:lacy", focus: false },
      { type: "show", page: "session:tideline", focus: false },
    ]);
    // Another key between: two taps, two acts.
    assert.deepEqual(await typing(s, [".", "\x1b[B", "."], true), [{ type: "repeat" }, { type: "show", page: "session:lacy", focus: false }, { type: "repeat" }]);
    // A card's y held: one answer.
    const card = state({ ...s, permission: { id: "p1", sessionId: "pixie", name: "pixie", what: "run pnpm test", risky: false } });
    assert.deepEqual(await typing(card, ["y", "y", "y"], true), [{ type: "allow", always: false, id: "p1" }]);
    // Typing a name: every letter, doubled ones too.
    const renaming = state({ ...s, window: { shown: "%1", note: "", renaming: { sessionId: "pixie", name: "pixie" } } });
    assert.deepEqual(await typing(renaming, ["m", "m", "\r"], true), [{ type: "rename", sessionId: "pixie", name: "pixiemm" }]);
  });

  test("a card up: its keys (y a n) still win over the list's; ↓ still previews", async () => {
    const permission = { id: "p1", sessionId: "pixie", name: "pixie", what: "run pnpm test", risky: false };
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2")] });
    assert.deepEqual(await typing(s, ["y", "a", "n", "\u001b[B"]), [
      { type: "allow", always: false, id: "p1" },
      { type: "allow", always: true, id: "p1" },
      { type: "deny", id: "p1" },
      { type: "show", page: "session:lacy", focus: false },
    ]);
  });

  test("the highlight follows a page shown from elsewhere (voice, the menu) when it was on the one shown; moved on, it stays", async () => {
    const sessions = [inTmux("pixie", "%1"), inTmux("lacy", "%2"), inTmux("tideline", "%3")];
    const t = terminal(36);
    const acts: unknown[] = [];
    const take = (a: unknown) => void acts.push(a);
    ui.on("action", take);
    const app = render(React.createElement(WindowList, { s: state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions }) }), {
      stdout: t.stdout as never,
      stdin: t.stdin as never,
      patchConsole: false,
      interactive: true,
    });
    const shown = async (pane: string) => {
      app.rerender(React.createElement(WindowList, { s: state({ sessionsLoaded: true, window: { shown: pane, note: "" }, sessions }) }));
      await inkDone(app);
    };
    try {
      await inkDone(app);
      await shown("%3"); // tideline, from the menu: the highlight there
      t.stdin.write("\u001b[A");
      await until(() => acts.length === 1, "↑'s act");
      assert.deepEqual(acts.at(-1), { type: "show", page: "session:lacy", focus: false }, "↑ from tideline");
      // A preview of lacy on its way, pixie's an older one ending first: the highlight stays on lacy.
      await shown("%1");
      t.stdin.write("\u001b[A");
      await until(() => acts.length === 2, "↑'s act");
      assert.deepEqual(acts.at(-1), { type: "show", page: "session:pixie", focus: false }, "↑ from lacy, not from pixie");
    } finally {
      app.unmount();
      ui.off("action", take);
    }
  });

  test("r renames the highlighted session, as its right-click Rename… (one in Kiko's tmux, or a Ghostty window found for sure; nothing on Kiko's row, another outside one or the new one); . repeats", async () => {
    const s = state({
      sessionsLoaded: true,
      window: { shown: "%1", note: "" },
      sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2"), session("notes", { place: { via: "ghostty", id: "g", keys: true } })],
    });
    // On the page shown (pixie), then ↓ lacy, ↓ + new session, ↓ notes (outside), ↓ Kiko (round the end); r on each; then .
    // Each ↓ previews the page it lands on; "+ new session" shows nothing.
    const acts = await typing(s, ["r", "\u001b[B", "r", "\u001b[B", "r", "\u001b[B", "r", "\u001b[B", "r", "."]);
    assert.deepEqual(acts, [
      { type: "renaming", sessionId: "pixie" },
      { type: "show", page: "session:lacy", focus: false },
      { type: "renaming", sessionId: "lacy" },
      { type: "show", page: "session:notes", focus: false },
      { type: "show", page: PAGE_ID, focus: false },
      { type: "repeat" },
    ]);
    // Nothing selected: the cursor on Kiko's page.
    assert.deepEqual(await typing(state({ sessionsLoaded: true, window: { shown: null, note: "", viewing: PAGE_ID }, sessions: [inTmux("pixie", "%1")] }), ["r"]), []);
    // Outside: a Ghostty window found by its title is renamed; one in Warp (nothing reaches it) isn't.
    const outside = state({
      sessionsLoaded: true,
      window: { shown: null, note: "", viewing: "session:sure" },
      sessions: [session("sure", { place: { via: "ghostty", id: "g", keys: true }, mapping: "title", pid: 501 }), session("warp", { pid: 502 })],
    });
    assert.deepEqual(await typing(outside, ["r", "\u001b[B", "r"]), [
      { type: "renaming", sessionId: "sure" },
      { type: "show", page: "session:warp", focus: false },
    ]);
  });

  test("clicks, on every kind of row: Kiko's page, a session in Kiko's tmux, one outside (each a preview: the keyboard stays in the list), the new one (the picker); a right-click on a session opens its menu", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), session("notes", { place: { via: "ghostty", id: "g", keys: true } })] });
    const t = terminal(36);
    const acts: unknown[] = [];
    const take = (a: unknown) => void acts.push(a);
    ui.on("action", take);
    const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
    try {
      await inkDone(app);
      const rows = t.last().split("\n");
      const y = (label: string) => rows.findIndex((r) => r.includes(label)) + 1;
      const click = (label: string, button: Pointer["button"] = "left") => {
        windowEvents.emit("pointer", { x: 6, y: y(label), button, press: true });
        windowEvents.emit("pointer", { x: 6, y: y(label), button, press: false }); // the release does nothing
      };
      for (const label of ["▪  Kiko", "pixie", "notes", "+  new session"]) click(label);
      click("pixie", "right");
      click("notes", "right");
      click("── INTERNAL"); // a heading: nothing
      await inkDone(app);
      assert.deepEqual(acts, [
        { type: "show", page: PAGE_ID, focus: false },
        { type: "show", page: "session:pixie", focus: false },
        { type: "show", page: "session:notes", focus: false },
        { type: "newSession" },
        { type: "rowMenu", sessionId: "pixie", x: 6, y: y("pixie") },
        { type: "rowMenu", sessionId: "notes", x: 6, y: y("notes") },
      ]);
    } finally {
      app.unmount();
      ui.off("action", take);
    }
  });

  test("a permission held by Kiko: a card at the bottom (who, what, its keys); y, a, n answer it, and clicks on them; n only denies while it's there", async () => {
    const permission = { id: "p1", sessionId: "pixie", name: "pixie", what: "run pnpm test", risky: false };
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission, sessions: [inTmux("pixie", "%1")] });
    const { out } = await drawn(s, 36);
    const rows = out.split("\n");
    const at = rows.findIndex((r) => /╭─+╮/.test(r));
    assert.match(rows[at + 1], /│ ⚠ ✻ {2}pixie +│/);
    assert.match(rows[at + 2], /│ wants to run pnpm test +│/);
    assert.ok(out.includes("y allow") && out.includes("a always") && out.includes("n deny"), out);
    assert.match(rows.at(-1)!, /y\/n answer$/);
    assert.ok(out.includes("+  new session (c)"), out);
    const acts = await typing(s, ["y", "a", "n"]);
    // Each for the prompt drawn (its id): one come meanwhile isn't answered by it (the app checks).
    assert.deepEqual(acts, [
      { type: "allow", always: false, id: "p1" },
      { type: "allow", always: true, id: "p1" },
      { type: "deny", id: "p1" },
    ]);
    // Clicked: each word where it's drawn (narrow: one a line; wide: on one line, by column).
    const clicked = await clicking(s, 36, (rows) =>
      ["y allow", "a always", "n deny"].map((w) => ({ y: rows.findIndex((r) => r.includes(w)) + 1, x: rows[rows.findIndex((r) => r.includes(w))].indexOf(w) + 2 })),
    );
    assert.deepEqual(clicked, [
      { type: "allow", always: false, id: "p1" },
      { type: "allow", always: true, id: "p1" },
      { type: "deny", id: "p1" },
    ]);
  });

  test("the card sits at the bottom, just above the keys: the sessions start at the top where they always are, a blank between them and it; a question's card too", async () => {
    const permission = { id: "p1", sessionId: "lacy", name: "lacy", what: "use search from plugin_cloudflare_cloudflare-api", risky: false };
    const sessions = [inTmux("pixie", "%1"), inTmux("lacy", "%2", { status: "blocked" }), session("notes", { place: { via: "ghostty", id: "g", keys: true } })];
    const question = {
      ...permission,
      id: "p2",
      what: "ask 1 question",
      asking: 0,
      questions: [{ question: "Which database?", header: "", multiSelect: false, options: [{ label: "Postgres", description: "" }] }],
    };
    for (const p of [permission, question]) {
      const { out } = await drawn(state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission: p, sessions }), 36);
      const rows = out.split("\n").map((l) => l.trimEnd());
      assert.equal(rows.length, 20, out);
      // The list as it is with no card: Kiko's page first, the sessions, the new one.
      assert.match(rows[0], /^ {2}0 {3}▪ {2}Kiko$/);
      assert.match(rows[1], /── INTERNAL/);
      assert.match(rows[2], /^ {2}1 {3}✻ {2}pixie +● idle$/);
      assert.match(rows[3], /^ {2}2 {3}✻ {2}lacy +● needs you$/);
      assert.match(rows[4], /^ {6}\+ {2}new session \(c\)$/);
      assert.match(rows[5], /── EXTERNAL/);
      // Then blanks, then the card whole, its bottom border right above the keys.
      const top = rows.findIndex((r) => /╭─+╮/.test(r));
      assert.ok(top > 7 && rows.slice(7, top).every((r) => r === ""), out);
      assert.match(rows[top + 1], p === question ? /│ \? ✻ {2}lacy asks +│/ : /│ ⚠ ✻ {2}lacy +│/);
      assert.match(rows.at(-2)!, /╰─+╯/);
      assert.match(rows.at(-1)!, /y\/n answer$/);
    }
    // A note from the app goes over the card, the keys stay last.
    const noted = (await drawn(state({ sessionsLoaded: true, window: { shown: "%1", note: "Closed pixie." }, permission, sessions }), 36)).out.split("\n").map((l) => l.trimEnd());
    const note = noted.findIndex((r) => r.includes("Closed pixie."));
    assert.match(noted[note + 1], /╭─+╮/);
    assert.match(noted.at(-2)!, /╰─+╯/);
  });

  test("a pane too short for the list and the card: the card whole, the list scrolled to keep the cursor's row in view; clicks land on the row drawn, the card's too", async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => inTmux(`s${i + 1}`, `%${i + 1}`));
    const permission = { id: "p1", sessionId: "s2", name: "s2", what: "run pnpm test", risky: false };
    const s = state({ sessionsLoaded: true, window: { shown: "%7", note: "" }, permission, sessions });
    const { out } = await drawn(s, 36, 12);
    const rows = out.split("\n").map((l) => l.trimEnd());
    assert.equal(rows.length, 12, out);
    // The card and the keys: the last seven rows, whole; a blank above them.
    assert.match(rows[5], /╭─+╮/);
    assert.match(rows[6], /│ ⚠ ✻ {2}s2 +│/);
    assert.ok(
      rows.some((r) => r.includes("y allow") && r.includes("n deny")),
      out,
    );
    assert.match(rows[10], /╰─+╯/);
    assert.match(rows[11], /y\/n answer/);
    assert.equal(rows[4], "");
    // The list in the four rows left, ending on the one shown (the cursor's).
    assert.deepEqual(
      rows.slice(0, 4).map((r) => r.match(/s\d/)?.[0]),
      ["s4", "s5", "s6", "s7"],
    );
    assert.match(rows[3], /7 {3}✻ {2}s7/);
    // Each click is the row it's on.
    const clicked = await clicking(
      s,
      36,
      (rows) => {
        const y = (w: string) => rows.findIndex((r) => r.includes(w));
        return [
          { y: y("s5") + 1, x: 6 },
          { y: y("n deny") + 1, x: rows[y("n deny")].indexOf("n deny") + 2 },
        ];
      },
      12,
    );
    assert.deepEqual(clicked, [
      { type: "show", page: "session:s5", focus: false },
      { type: "deny", id: "p1" },
    ]);
    // Shorter than the card and the keys: the keys go, the card stays whole.
    const tiny = (await drawn(s, 36, 6)).out.split("\n").map((l) => l.trimEnd());
    assert.equal(tiny.length, 6, tiny.join("\n"));
    assert.match(tiny[0], /╭─+╮/);
    assert.match(tiny[5], /╰─+╯/);
  });

  test("Claude Code's trust question as a card: what it asks and means, y trust and n don't trust, no \"always\"", async () => {
    const permission = {
      id: "t1",
      sessionId: "starting-1234abcd",
      name: "Dozer",
      what: "trust its folder ~/Kiko/scratch/2026-10-29-dozer",
      risky: false,
      folder: "~/Kiko/scratch/2026-10-29-dozer",
    };
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission, sessions: [inTmux("pixie", "%1")] });
    const { out } = await drawn(s, 60);
    const rows = out.split("\n");
    const at = rows.findIndex((r) => /╭─+╮/.test(r));
    assert.match(rows[at + 1], /│ ⚠ Dozer +│/);
    assert.match(rows[at + 2], /│ wants to trust its folder +│/);
    assert.match(rows[at + 3], /│ ~\/Kiko\/scratch\/2026-10-29-dozer +│/);
    assert.ok(out.includes("Claude Code will be able to read, edit and run files"), out);
    assert.ok(out.includes("y trust") && out.includes("n don't trust"), out);
    assert.ok(!out.includes("always"), out);
    const acts = await typing(s, ["a", "y", "n"]);
    assert.deepEqual(
      acts,
      [
        { type: "allow", always: false, id: "t1" },
        { type: "deny", id: "t1" },
      ],
      "a does nothing here",
    );
  });

  test("words from elsewhere are drawn as plain text: a command's escape sequences (OSC 52, a style) never reach the terminal", async () => {
    const evil = "\u001b]52;c;aGk=\u0007\u001b[8m"; // the clipboard; then hidden text (Ink drops all but styles itself)
    const what = describeTool("Bash", { command: `printf '${evil}'` });
    assert.ok(!/[\u0000-\u001f]/.test(what), JSON.stringify(what));
    assert.ok(!/[\u0000-\u001f]/.test(describeTool("Read", { file_path: `/x${evil}` })));
    const raw = async (s: UiState) => {
      const t = terminal(40);
      let text = "";
      // Every write kept as it comes (the callback too: Ink's flush waits for it).
      t.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        text += String(chunk);
        const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
        if (done) process.nextTick(done);
        return true;
      }) as never;
      const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
      await inkDone(app);
      app.unmount();
      return text;
    };
    const card = { id: "p1", sessionId: "pixie", name: `ev${evil}il`, what: `run: ${evil}`, risky: false };
    const question = {
      ...card,
      id: "p2",
      asking: 0,
      questions: [{ question: `Which${evil}?`, header: `H${evil}`, multiSelect: false, options: [{ label: `one${evil}`, description: "" }] }],
    };
    const sessions = [inTmux(`ro${evil}cky`, "%1"), session(`no${evil}tes`, { place: { via: "ghostty", id: "g", keys: true } })];
    const picker = { projects: [{ cwd: "/code/x", name: `pro${evil}ject`, detail: `~/co${evil}de` }], root: `/r${evil}` };
    for (const s of [
      state({ sessionsLoaded: true, window: { shown: "%1", note: `a note ${evil}` }, permission: card, sessions }),
      state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission: question, sessions }),
      state({ sessionsLoaded: true, window: { shown: null, note: "", picker }, sessions }),
      state({ sessionsLoaded: true, window: { shown: "%1", note: "", renaming: { sessionId: sessions[0].sessionId, name: "x" } }, sessions }),
    ]) {
      const out = await raw(s);
      assert.ok(!out.includes("\u001b]52") && !out.includes("\u0007") && !out.includes("\u001b[8m"), JSON.stringify(out));
    }
  });

  test("Claude's question held by Kiko: the question and its options numbered; a number answers, a click on an option too; n declines", async () => {
    const permission = {
      id: "p2",
      sessionId: "pixie",
      name: "pixie",
      what: "ask 1 question",
      risky: false,
      asking: 0,
      questions: [
        {
          question: "Which database?",
          header: "DB",
          multiSelect: false,
          options: [
            { label: "Postgres", description: "" },
            { label: "SQLite", description: "" },
          ],
        },
      ],
    };
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, permission, sessions: [inTmux("pixie", "%1")] });
    const { out } = await drawn(s, 36);
    for (const part of ["? ✻  pixie asks", "DB: Which database?", "1 Postgres", "2 SQLite", "n decline"]) assert.ok(out.includes(part), `${part} in:\n${out}`);
    assert.deepEqual(await typing(s, ["2", "7", "n"]), [
      { type: "answer", option: 2, id: "p2", asking: 0 },
      { type: "deny", id: "p2" },
    ]);
    const clicked = await clicking(s, 36, (rows) => [{ y: rows.findIndex((r) => r.includes("2 SQLite")) + 1, x: 8 }]);
    assert.deepEqual(clicked, [{ type: "answer", option: 2, id: "p2", asking: 0 }]);
  });

  test("the picker: projects newest first, narrowed as you type; Enter or a click starts one; a new project by name; a scratch folder; Esc closes it", async () => {
    const picker = {
      projects: [
        { cwd: "/code/pixie", name: "pixie", detail: "~/code" },
        { cwd: "/code/lacy", name: "lacy", detail: "~/code" },
      ],
      root: "/code",
    };
    const s = state({ sessionsLoaded: true, window: { shown: null, note: "", picker }, sessions: [] });
    const { out } = await drawn(s, 40);
    for (const part of ["NEW SESSION IN", "pixie", "~/code", "lacy", "+ new project…", "◌ scratch folder", "⏎ start · Esc back"]) assert.ok(out.includes(part), `${part} in:\n${out}`);
    // A new project and a scratch folder on top, then the projects; the cursor on the first project.
    const at = (label: string) => out.indexOf(label);
    assert.ok(at("+ new project…") < at("◌ scratch folder") && at("◌ scratch folder") < at("pixie") && at("pixie") < at("lacy"), out);
    assert.deepEqual(await typing(s, ["\r"]), [{ type: "start", pick: { project: "/code/pixie" } }]);
    assert.deepEqual(await typing(s, ["l", "a", "\r"]), [{ type: "start", pick: { project: "/code/lacy" } }]);
    assert.deepEqual(await typing(s, ["\u001b[A", "\r"]), [{ type: "start", pick: { scratch: true } }]);
    assert.deepEqual(await typing(s, ["\u001b[A", "\u001b[A", "\r", "P", "i", "x", "e", "l", "\r"]), [{ type: "start", pick: { newProject: "Pixel" } }]);
    // Typed a name that fits no project: the cursor on "+ new project…", Enter names it so.
    assert.deepEqual(await typing(s, ["z", "o", "o", "\r", "\r"]), [{ type: "start", pick: { newProject: "zoo" } }]);
    assert.deepEqual(await typing(s, ["\u001b"]), [{ type: "closePicker" }]);
    const clicked = await clicking(s, 40, (rows) => [{ y: rows.findIndex((r) => r.includes("scratch folder")) + 1, x: 4 }]);
    assert.deepEqual(clicked, [{ type: "start", pick: { scratch: true } }]);
  });

  test("renaming: the name as it is to edit; Enter renames, Esc doesn't", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "", renaming: { sessionId: "pixie", name: "pixie" } }, sessions: [inTmux("pixie", "%1")] });
    const { out } = await drawn(s, 36);
    assert.ok(out.includes("RENAME pixie") && out.includes("› pixie"), out);
    assert.deepEqual(await typing(s, ["\u007f", "\u007f", "\u007f", "\u007f", "\u007f", "a", "p", "i", "\r"]), [{ type: "rename", sessionId: "pixie", name: "api" }]);
    assert.deepEqual(await typing(s, ["\u001b"]), [{ type: "renaming", sessionId: null }]);
  });
});

describe("quitting from the list (src/ui/quit-again.ts)", () => {
  const s = state({ sessionsLoaded: true, window: { shown: "%1", note: "" }, sessions: [inTmux("pixie", "%1"), inTmux("lacy", "%2")] });
  const HINT = "Press q again to quit · your sessions keep running";
  const QUIT = { type: "quit" };

  /**
   * The list in a pane `columns` wide, read through its own reading of the terminal (input.ts
   * inkInput), as in the window: `type` keys one at a time, `acts` what they asked for, `last` the
   * screen. `quitAgainMs`: the hint's time (QUIT_AGAIN_MS unless given). Ctrl+C is the list's, never Ink's.
   */
  async function list(st: UiState, o: { columns?: number; quitAgainMs?: number } = {}) {
    const t = terminal(o.columns ?? 60);
    const acts: unknown[] = [];
    const take = (a: unknown) => void acts.push(a);
    ui.on("action", take);
    const stdin = inkInput(t.stdin as never, "token", new EventEmitter());
    const app = render(React.createElement(WindowList, { s: st, ...(o.quitAgainMs ? { quitAgainMs: o.quitAgainMs } : {}) }), {
      stdout: t.stdout as never,
      stdin: stdin as never,
      patchConsole: false,
      interactive: true,
      exitOnCtrlC: false,
    });
    open.push(() => (app.unmount(), ui.off("action", take)));
    await inkDone(app);
    return { acts, last: t.last, type: (...keys: string[]) => typeKeys(app, t.stdin, ...keys) };
  }
  /** Each list opened by a test, unmounted after it. */
  const open: Array<() => void> = [];
  afterEach(() => open.splice(0).forEach((close) => close()));

  test("q puts the hint on the keys' line, in full where it fits, shorter where it doesn't; q again quits", async () => {
    const l = await list(s);
    assert.ok(!l.last().includes(HINT));
    await l.type("q");
    assert.ok(l.last().includes(HINT), l.last());
    assert.deepEqual(l.acts, [], "the first q only asks");
    await l.type("q");
    assert.deepEqual(l.acts, [QUIT]);
    // A narrow pane: the longest form that fits.
    const narrow = await list(s, { columns: 36 });
    await narrow.type("q");
    assert.ok(narrow.last().includes("Press q again to quit"), narrow.last());
    assert.ok(!narrow.last().includes("sessions keep running"), narrow.last());
    assert.equal(quitHintFor("q", 45), "Press q again to quit · sessions keep running");
    assert.equal(quitHintFor("q", 40), "q again to quit · sessions keep running");
    assert.equal(quitHintFor("q", 10), "q again quits");
    assert.equal(QUIT_AGAIN_MS, 2000);
  });

  test("q, y quits; q, Q too", async () => {
    const l = await list(s);
    await l.type("q", "y");
    assert.deepEqual(l.acts, [QUIT]);
    const big = await list(s);
    await big.type("Q", "Q");
    assert.deepEqual(big.acts, [QUIT]);
  });

  test("q, another key: the hint goes, and that key does nothing else (n would show the next session); q starts it over", async () => {
    const l = await list(s);
    await l.type("q", "n");
    assert.deepEqual(l.acts, [], "n neither quit nor showed the next session");
    assert.ok(!l.last().includes(HINT), l.last());
    assert.ok(l.last().includes("c new"), "the list's own keys back");
    await l.type("n");
    assert.deepEqual(l.acts, [{ type: "show", page: "session:lacy", focus: false }], "n is n again");
    await l.type("q");
    assert.ok(l.last().includes(HINT));
    await l.type("\x1b[B");
    assert.deepEqual(l.acts.length, 1, "↓ only let it go");
    await l.type("q", "q");
    assert.deepEqual(l.acts.at(-1), QUIT);
  });

  test("q, then the time runs out: the hint goes by itself, and q after is a first q again", async () => {
    const l = await list(s, { quitAgainMs: 500 }); // past HELD_MS: a q after it is a tap, not q held
    await l.type("q");
    assert.ok(l.last().includes(HINT));
    await untilFrame(l.last, (f) => !f.includes(HINT), "the hint gone");
    await l.type("q");
    assert.deepEqual(l.acts, [], "a first q: no quit");
    assert.ok(l.last().includes(HINT), "its hint up again");
  });

  test("Ctrl+C twice quits (its own hint); Ctrl+C then q or y too; q then Ctrl+C only lets it go", async () => {
    const l = await list(s);
    await l.type("\x03");
    assert.ok(l.last().includes("Press Ctrl+C again to quit · your sessions keep running"), l.last());
    assert.deepEqual(l.acts, []);
    await l.type("\x03");
    assert.deepEqual(l.acts, [QUIT]);
    const q = await list(s);
    await q.type("\x03", "q");
    assert.deepEqual(q.acts, [QUIT]);
    const y = await list(s);
    await y.type("\x03", "y");
    assert.deepEqual(y.acts, [QUIT]);
    const other = await list(s);
    await other.type("q", "\x03");
    assert.deepEqual(other.acts, []);
    assert.ok(!other.last().includes("again to quit"), other.last());
  });

  test("q held down (a kitty-protocol repeat) never quits; two taps close together do", async () => {
    const l = await list(s);
    await l.type("q", "\x1b[113;1:2u", "\x1b[113;1:2u");
    assert.deepEqual(l.acts, []);
    const taps = await list(s);
    await taps.type("q", "q");
    assert.deepEqual(taps.acts, [QUIT], "within HELD_MS, still a second q");
  });

  test("typing a name or a project, or narrowing the picker: q is a letter, never quit; Ctrl+C still asks, and the key that lets it go isn't typed", async () => {
    const renaming = state({ ...s, window: { shown: "%1", note: "", renaming: { sessionId: "pixie", name: "pixie" } } });
    const r = await list(renaming);
    await r.type("q", "q", "Q");
    assert.ok(!r.last().includes("again to quit"), r.last());
    await r.type("\r");
    assert.deepEqual(r.acts, [{ type: "rename", sessionId: "pixie", name: "pixieqqQ" }]);
    const c = await list(renaming);
    await c.type("\x03");
    assert.ok(c.last().includes("Press Ctrl+C again to quit"), c.last());
    await c.type("z", "\r");
    assert.deepEqual(c.acts, [{ type: "rename", sessionId: "pixie", name: "pixie" }], "z let it go, typed nothing; the name as it was");
    const picker = { projects: [{ cwd: "/code/quiet", name: "quiet", detail: "~/code" }], root: "/code" };
    const p = await list(state({ ...s, window: { shown: null, note: "", picker } }));
    await p.type("q", "q");
    assert.ok(p.last().includes("› qq"), p.last());
    await p.type("\x7f", "\r");
    assert.deepEqual(p.acts, [{ type: "start", pick: { project: "/code/quiet" } }]);
    const n = await list(state({ ...s, window: { shown: null, note: "", picker } }));
    await n.type("\x1b[A", "\x1b[A", "\r", "q", "q", "\r");
    assert.deepEqual(n.acts, [{ type: "start", pick: { newProject: "qq" } }], "a new project's name");
  });
});

/** The list drawn in a pane `columns` wide: its screen as text. */
async function drawn(s: UiState, columns = 32, rows = 20) {
  const t = terminal(columns, rows);
  const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
  await inkDone(app);
  const out = t.last();
  app.unmount();
  return { out };
}

/**
 * The actions keys typed into the list asked for, in order (each key on its own, as typed, Ink through
 * with it before the next; a lone Esc, which Ink holds a moment, until what it asks for); `read`:
 * through the list's own reading of its terminal (input.ts inkInput), as in the window.
 */
async function typing(s: UiState, keys: string[], read = false) {
  const t = terminal(36);
  const acts: unknown[] = [];
  const take = (a: unknown) => void acts.push(a);
  ui.on("action", take);
  const stdin = read ? inkInput(t.stdin as never, "token", new EventEmitter()) : t.stdin;
  const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: stdin as never, patchConsole: false, interactive: true });
  try {
    await inkDone(app);
    for (const k of keys) {
      if (k !== "\u001b") await typeKeys(app, t.stdin, k);
      else {
        const before = acts.length;
        t.stdin.write(k);
        await until(() => acts.length > before, "what Esc asks for");
      }
    }
  } finally {
    app.unmount();
    ui.off("action", take);
  }
  return acts;
}

/** The actions clicks at `where(rows)` asked for. */
async function clicking(s: UiState, columns: number, where: (rows: string[]) => Array<{ x: number; y: number }>, rows = 20) {
  const t = terminal(columns, rows);
  const acts: unknown[] = [];
  const take = (a: unknown) => void acts.push(a);
  ui.on("action", take);
  const app = render(React.createElement(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
  try {
    await inkDone(app);
    for (const p of where(t.last().split("\n"))) windowEvents.emit("pointer", { ...p, button: "left", press: true });
    await inkDone(app);
  } finally {
    app.unmount();
    ui.off("action", take);
  }
  return acts;
}

describe("the app's side", () => {
  test("the bottom line follows the app's state; a page shown on asking (a session, an outside one's viewer, Kiko's); settings zoom and come back", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const pixie = (await t.run(["new-session", "-d", "-s", "pixie", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    const before = ui.state;
    ui.set({
      window: { shown: null, note: "" },
      about: { ...ui.state.about, hotkey: "right_option" },
      sessions: [inTmux("Pixie API", pixie), session("clipkit", { place: { via: "ghostty", id: "g", keys: true } })],
    });
    const glue = startWindow(t.run, list, "/run/page.jsonl");
    const stage = () => t.panesOf(WINDOW)[1];
    try {
      await glue.refresh();
      await wait(250);
      const bar = () => unstyled(t.sessions.get(WINDOW)!.opts[BAR]);
      assert.match(bar(), /^● Kiko is ready.*hold right ⌥ to talk · ⌃Space menu/);
      assert.equal(t.panes.get(pixie)!.opts[LABEL], "Pixie API", "its name on its border");
      // An empty stage: Kiko's page, a viewer of the page file (only its path on the command line); the keyboard stays in the list.
      assert.equal(t.panes.get(stage())!.opts[ROLE], "viewer");
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      assert.deepEqual(t.panes.get(stage())!.command.slice(-2), ["/run/page.jsonl", "page"]);
      assert.equal(t.windows.get(t.panes.get(list)!.window)!.active, list);
      assert.equal(ui.state.window!.viewing, PAGE_ID);
      assert.equal(JSON.parse(t.panes.get(stage())!.opts[VIEWER_INFO]).doing, "ready");
      ui.set({ listening: true, interim: "show me" });
      await wait(250);
      assert.match(bar(), /^● listening “show me”/);
      assert.equal(JSON.parse(t.panes.get(stage())!.opts[VIEWER_INFO]).doing, "listening");
      ui.set({ listening: false, interim: "" });

      // The menu: kept in the window's option, its items asking this app (its pane, this run's token).
      const opts = () => t.windows.get(t.panes.get(list)!.window)!.opts;
      assert.equal(FakeTmux.words(opts()[MENU])[0], "display-popup");
      const menu = JSON.parse(opts()[MENU_DATA]);
      assert.ok(
        menu.items.some((i: { label?: string }) => i.label?.includes("Pixie API")),
        opts()[MENU_DATA],
      );
      const asks = menu.items.flatMap((i: { run?: string[][] }) => (typeof i === "object" ? (i.run ?? []) : [])).filter((c: string[]) => c[0] === "send-keys");
      assert.ok(asks.length >= 3 && asks.every((c: string[]) => c[2] === list), JSON.stringify(asks));

      // Asked (as a menu item does, through the list's input): pixie's own pane moves into the stage, focused.
      // (The app takes the action it becomes: here, the glue's show.)
      const showing = (a: { type: string; page?: string }) => void (a.type === "show" && glue.show(a.page!));
      ui.on("action", showing);
      windowEvents.emit("ask", { verb: "go", arg: "session:Pixie API" });
      await wait(30);
      ui.off("action", showing);
      assert.equal(stage(), pixie);
      assert.equal(ui.state.window!.shown, pixie);
      assert.equal(ui.state.window!.viewing, null);

      // An outside one: its conversation in a viewer, pixie back home; the viewer's header kept to its state.
      await glue.show("session:clipkit");
      const viewer = stage();
      assert.notEqual(viewer, pixie);
      assert.equal(t.where(pixie), "pixie");
      assert.equal(t.panes.get(viewer)!.opts[ROLE], "viewer");
      assert.equal(t.panes.get(viewer)!.command.at(-1), agent.historyFile({ sessionId: "clipkit", cwd: "/code/clipkit" }));
      assert.equal(ui.state.window!.viewing, "session:clipkit");
      const info = () => JSON.parse(t.panes.get(viewer)!.opts[VIEWER_INFO]);
      assert.deepEqual(info(), { name: "clipkit", where: "ghostty", status: "idle", folder: "/code/clipkit", spoken: [], key: "⌃Space", agent: { name: "Claude", color: "#D77757" } });
      ui.set({ sessions: [ui.state.sessions[0], { ...ui.state.sessions[1], status: "busy" }] });
      ui.spoken("Clipkit finished the export.", { name: "clipkit", sessionId: "clipkit" });
      await wait(250);
      assert.equal(info().status, "working");
      assert.deepEqual(
        info().spoken.map((s: { text: string }) => s.text),
        ["Clipkit finished the export."],
      );
      // It ended (gone from the list): said so, the rest left to the viewer.
      ui.set({ sessions: [ui.state.sessions[0]], sessionsLoaded: true });
      await glue.refresh();
      await wait(250);
      assert.deepEqual(info(), { status: "ended" });

      // Up and down the list (the menu's ↑ ↓): Kiko's page is above pixie.
      await glue.show("session:Pixie API");
      await glue.step(-1);
      assert.equal(ui.state.window!.viewing, PAGE_ID);
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      await glue.step(1);
      assert.equal(stage(), pixie);
      // l: the one shown before (Kiko's page), and again: back.
      await glue.last();
      assert.equal(ui.state.window!.viewing, PAGE_ID);
      await glue.last();
      assert.equal(stage(), pixie);

      // A right-click on pixie's row: its menu on the terminal that used the window last, just below the row.
      t.clients.set(WINDOW, ["/dev/ttys009", "/dev/ttys001"]);
      await glue.rowMenu("Pixie API", 5, 4);
      const shown = t.menus.at(-1)!;
      assert.equal(shown[shown.indexOf("-c") + 1], "/dev/ttys009");
      assert.equal(shown[shown.indexOf("-T") + 1], "#[bold] Pixie API ");
      assert.equal(shown[shown.indexOf("-x") + 1], "4");
      assert.equal(shown[shown.indexOf("-y") + 1], String(1 + 4 + 7));
      // q: that terminal stops showing the window.
      await glue.detach();
      assert.deepEqual(t.detached, ["/dev/ttys009"]);

      ui.set({ screen: "settings" });
      await wait(20);
      assert.equal(t.windows.get(t.panes.get(list)!.window)!.zoomed, true);
      ui.set({ screen: "main" });
      await wait(20);
      assert.equal(t.windows.get(t.panes.get(list)!.window)!.zoomed, false);

      // Settings open, then the session clicked (tmux unzooms): settings close, and it stays unzoomed.
      const closing = (a: { type: string }) => void (a.type === "closeSettings" && ui.set({ screen: "main" }));
      ui.on("action", closing);
      try {
        ui.set({ screen: "settings" });
        await wait(20);
        assert.equal(t.windows.get(t.panes.get(list)!.window)!.zoomed, true);
        await t.run(["select-pane", "-t", pixie]); // the fake unzooms on select-pane, as tmux does
        process.stdout.emit("resize");
        await wait(50);
        assert.equal(ui.state.screen, "main");
        assert.equal(t.windows.get(t.panes.get(list)!.window)!.zoomed, false, "not zoomed back");
      } finally {
        ui.off("action", closing);
      }

      // Closed from its menu: it goes home, its tmux session ends, Kiko's page comes back to the stage.
      await glue.close("Pixie API");
      assert.equal(t.sessions.has("pixie"), false);
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      assert.equal(ui.state.window!.note, "Closed Pixie API.");
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });

  test("the splash: the window kept whole as the app starts (start.ts zoomed it), drawn blank a moment as it leaves, the list's size again, then gone; tmux unzooming it skips it", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    await t.run(["resize-pane", "-Z", "-t", list]); // start.ts, before the app started
    const zoomed = () => t.windows.get(t.panes.get(list)!.window)!.zoomed;
    const before = ui.state;
    const showing = { since: Date.now(), slow: false, leaving: false };
    ui.set({ window: { shown: null, note: "" }, splash: showing });
    const glue = startWindow(t.run, list, null);
    const acts: string[] = [];
    const take = (a: { type: string }) => void acts.push(a.type);
    ui.on("action", take);
    try {
      await wait(30);
      assert.equal(zoomed(), true, "kept whole while it shows (not unzoomed as after first-run setup)");
      ui.set({ splash: { ...showing, leaving: true } });
      await wait(20);
      assert.equal(zoomed(), true, "blank a moment first, still whole");
      assert.ok(ui.state.splash, "not gone yet: the list isn't drawn at the whole window's size");
      for (let i = 0; i < 100 && ui.state.splash; i++) await wait(10);
      assert.equal(ui.state.splash, null, "gone once the pane is the list's again");
      assert.equal(zoomed(), false);

      // Showing again, and the session area clicked (tmux unzooms): skipped, as a key would.
      ui.set({ splash: showing });
      await wait(30);
      assert.equal(zoomed(), true);
      await t.run(["select-pane", "-t", t.panesOf(WINDOW)[1]]);
      process.stdout.emit("resize");
      await wait(50);
      assert.deepEqual(acts, ["skipSplash"]);
    } finally {
      ui.off("action", take);
      await glue.stop();
      ui.set({ ...before, splash: null });
    }
  });

  test("a preview (the list's picks): shown, the keyboard left in the list, a session's, an outside one's viewer, Kiko's page; going in moves it there, over the one shown too; the menu's picks still go there", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const pane = async (name: string) => (await t.run(["new-session", "-d", "-s", name, "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    const [pixie, lacy] = [await pane("pixie"), await pane("lacy")];
    const before = ui.state;
    ui.set({
      window: { shown: null, note: "" },
      sessions: [inTmux("pixie", pixie), inTmux("lacy", lacy), session("clipkit", { place: { via: "ghostty", id: "g", keys: true } })],
      sessionsLoaded: true,
    });
    const glue = startWindow(t.run, list, "/run/page.jsonl");
    const stage = () => t.panesOf(WINDOW)[1];
    const active = () => t.windows.get(t.panes.get(list)!.window)!.active;
    try {
      await glue.refresh();
      await glue.show("session:pixie", false);
      assert.equal(stage(), pixie);
      assert.equal(active(), list, "the keyboard stays in the list");
      assert.equal(ui.state.window!.shown, pixie);
      await glue.show("session:clipkit", false);
      assert.equal(t.panes.get(stage())!.opts[VIEWING], "session:clipkit");
      assert.equal(active(), list);
      await glue.show(PAGE_ID, false);
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      assert.equal(active(), list);
      // Going in (Enter, →): over what's shown already, only the keyboard moves; the viewer too (for scrolling).
      const viewer = stage();
      await glue.show(PAGE_ID);
      assert.equal(stage(), viewer);
      assert.equal(active(), viewer);
      // Back to the list (Ctrl+Space Tab), a preview there, then in.
      await t.run(["select-pane", "-t", list]);
      await glue.show("session:lacy", false);
      assert.equal(stage(), lacy);
      assert.equal(active(), list);
      await glue.show("session:lacy");
      assert.equal(active(), lacy);
      // l from the list: the one before (Kiko's page), the keyboard staying.
      await t.run(["select-pane", "-t", list]);
      await glue.last(false);
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      assert.equal(active(), list);

      // The menu's picks (Ctrl+Space: a number, n p l; a right-click's Show) ask for a show that goes there.
      const asked: Array<{ type: string; focus?: boolean }> = [];
      const take = (a: { type: string; focus?: boolean }) => void asked.push(a);
      ui.on("action", take);
      for (const [verb, arg] of [
        ["go", "session:pixie"],
        ["step", "next"],
        ["step", "prev"],
        ["last", ""],
      ])
        windowEvents.emit("ask", { verb, arg });
      await wait(30);
      ui.off("action", take);
      assert.deepEqual(asked, [{ type: "show", page: "session:pixie" }, { type: "step", by: 1 }, { type: "step", by: -1 }, { type: "last" }]);
      await glue.show("session:pixie");
      assert.equal(active(), pixie);
      await glue.step(1);
      assert.equal(active(), lacy, "the menu's n: there");
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });

  test("previews asked faster than they're done (↓ held): only the latest waits its turn, the ones in between never shown; one that can't be shown doesn't stop the next", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const pane = async (name: string) => (await t.run(["new-session", "-d", "-s", name, "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    const names = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const panes: string[] = [];
    for (const n of names) panes.push(await pane(n));
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" }, sessions: names.map((n, i) => inTmux(n, panes[i])), sessionsLoaded: true });
    // Every pane moved into the stage (the second swap-pane of a show: the session in, after the one shown went home).
    const swapped: string[] = [];
    const run = async (args: string[], input?: string) => {
      for (let i = args.indexOf("swap-pane"); i >= 0; i = args.indexOf("swap-pane", i + 1)) swapped.push(args[args.indexOf("-s", i) + 1]);
      await wait(5); // tmux takes a while
      return t.run(args, input);
    };
    const glue = startWindow(run, list, null);
    const stage = () => t.panesOf(WINDOW)[1];
    const active = () => t.windows.get(t.panes.get(list)!.window)!.active;
    try {
      await glue.refresh();
      swapped.length = 0;
      const done = names.map((n) => glue.show(`session:${n}`, false));
      await Promise.all(done);
      assert.equal(stage(), panes[5], "the latest shown");
      assert.equal(ui.state.window!.shown, panes[5]);
      assert.equal(active(), list);
      const moved = new Set(swapped.filter((p) => panes.includes(p)));
      assert.deepEqual([...moved].sort(), [panes[0], panes[5]].sort(), "s1 (under way when the rest came) and s6, nothing in between");
      // One that can't be shown (its session ended): said, and the next asked still shown.
      const gone = glue.show("session:nobody", false);
      const next = glue.show("session:s2", false);
      await Promise.all([gone, next]);
      assert.equal(stage(), panes[1]);
      // Going in after previews (↓ ↓ Enter, quicker than tmux): the last one asked, and the keyboard there.
      await Promise.all([glue.show("session:s3", false), glue.show("session:s4", false), glue.show("session:s4")]);
      assert.equal(stage(), panes[3]);
      assert.equal(active(), panes[3]);
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });

  // The flaky nested tmux test (nested-live, "Ctrl+\ typed in your terminal…", 2026-10-29): pixie
  // picked from the menu, then the menu key twice went nowhere. A look at the window (refresh:
  // the app's every 4 seconds, the test app's every second) begun just before pixie moved into the
  // stage finished after it, and put back what it had seen: nothing shown, so "pass" had no session
  // to pass the key to until the next look. Made certain here: the look's list-panes answered as the
  // window was, then held until the show is done.
  test("a look at the window begun before a page is shown doesn't undo it when it ends after", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const pixie = (await t.run(["new-session", "-d", "-s", "pixie", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" }, sessions: [inTmux("Pixie API", pixie)] });
    let hold: { release: () => void } | null = null;
    let holding = false;
    const run = async (args: string[], input?: string) => {
      if (!holding || args[0] !== "list-panes") return t.run(args, input);
      holding = false;
      const seen = await t.run(args, input);
      await new Promise<void>((release) => (hold = { release }));
      return seen;
    };
    const glue = startWindow(run, list, null);
    try {
      await glue.refresh();
      assert.equal(ui.state.window!.shown, null);
      holding = true;
      const looking = glue.refresh();
      await glue.show("session:Pixie API");
      assert.equal(ui.state.window!.shown, pixie);
      (hold as { release: () => void } | null)?.release();
      await looking;
      assert.equal(ui.state.window!.shown, pixie, "still pixie: the older look didn't put back what it saw");
      // The next look sees pixie there, as it is.
      await glue.refresh();
      assert.equal(ui.state.window!.shown, pixie);
      t.run(["kill-session", "-t", "=pixie"]).catch(() => "");
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });

  // /exit typed in a session opened from the window; Claude Code quit, the
  // session left the list, and its shell stayed in the stage. Its pane now ends with it (index.ts
  // afterProgram); here, the app's side of that.
  test("a session that quit by itself: its pane gone with it, logged as exited; shown, Kiko's page in the stage at once; at home, the stage as it was; Close's own never logged as exited", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const pane = async (name: string) => (await t.run(["new-session", "-d", "-s", name, "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    const [pixie, lacy, dot] = [await pane("pixie"), await pane("lacy"), await pane("dot")];
    const before = ui.state;
    const all = [inTmux("pixie", pixie), inTmux("lacy", lacy), inTmux("dot", dot)];
    const listed = (...names: string[]) => ui.set({ sessions: all.filter((s) => names.includes(s.sessionId)), sessionsLoaded: true });
    ui.set({ window: { shown: null, note: "" } });
    listed("pixie", "lacy", "dot");
    const glue = startWindow(t.run, list, "/run/page.jsonl");
    const stage = () => t.panesOf(WINDOW)[1];
    const exited = () => logged("session_closed").filter((l) => l.how === "exited" && ["pixie", "lacy", "dot"].includes(l.sessionId));
    try {
      await glue.refresh();
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID, "Kiko's page to start with");
      await glue.show("session:pixie");
      assert.equal(stage(), pixie);
      await glue.refresh();

      // pixie quits in the stage: its SessionEnd first (off the list, its pane still there), then its pane ends with it.
      listed("lacy", "dot");
      await glue.refresh();
      assert.equal(stage(), pixie, "nothing done while its pane is there");
      assert.deepEqual(exited(), []);
      t.end(pixie); // dead in the stage (remain-on-exit), as tmux keeps it until DIED_HOOK (the fake runs no hooks: tidy does it)
      // No look asked for: the glue looks again shortly by itself, and Kiko's page is in at once (not PAGE_AGAIN_MS after the last).
      await until(() => t.panes.get(stage())?.opts[VIEWING] === PAGE_ID, "Kiko's page in the stage");
      assert.equal(t.panes.has(pixie), false, "its pane gone");
      assert.equal(t.sessions.has("pixie"), false, "its tmux session gone");
      assert.deepEqual(
        exited().map((l) => [l.sessionId, l.shown]),
        [["pixie", true]],
      );
      assert.equal(ui.state.window!.viewing, PAGE_ID);

      // dot quits at home, lacy shown: dot's tmux session goes, the stage stays on lacy.
      await glue.show("session:lacy");
      await glue.refresh();
      t.end(dot);
      listed("lacy");
      await glue.refresh();
      assert.equal(t.sessions.has("dot"), false);
      assert.equal(stage(), lacy, "the stage as it was");
      assert.equal(ui.state.window!.shown, lacy);
      assert.deepEqual(
        exited().map((l) => [l.sessionId, l.shown]),
        [
          ["pixie", true],
          ["dot", false],
        ],
      );

      // Closed from Kiko (its pane may end with its program meanwhile): closed once, never logged as exited.
      await glue.close("lacy");
      listed();
      await glue.refresh();
      assert.equal(t.sessions.has("lacy"), false);
      assert.equal(ui.state.window!.note, "Closed lacy.");
      assert.equal(t.panes.get(stage())!.opts[VIEWING], PAGE_ID);
      assert.deepEqual(
        exited().map((l) => l.sessionId),
        ["pixie", "dot"],
      );
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });
});

describe("a T3 Code thread in the window", () => {
  const thread = (fields: Partial<Session> = {}) => session("Pixie login", { sessionId: "t3:th1", agent: "t3code", place: { via: "t3code", id: "th1", keys: false }, ...fields });

  test("the list's r renames it, as its right-click Rename… (T3 renames it through its server)", async () => {
    const s = state({ sessionsLoaded: true, window: { shown: null, note: "", viewing: PAGE_ID }, sessions: [thread()] });
    // ↓ + new session (nothing shown), ↓ the thread (outside), r.
    assert.deepEqual(await typing(s, ["\u001b[B", "\u001b[B", "r"]), [
      { type: "show", page: "session:t3:th1", focus: false },
      { type: "renaming", sessionId: "t3:th1" },
    ]);
  });

  test('shown: its conversation in a viewer (the file its agent keeps of it), "in T3 Code"; the Ctrl+Space menu then offers Rename…, Interrupt and Archive for it', async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const before = ui.state;
    // Its agent's file, here a made-up path: the real one is written next to Kiko's page (agents/mirror.ts).
    const historyFile = t3code.historyFile;
    t3code.historyFile = (of) => `/run/t3/${of.sessionId.slice(3)}.jsonl`;
    ui.set({ window: { shown: null, note: "" }, sessions: [thread()] });
    const glue = startWindow(t.run, list, null);
    try {
      await glue.refresh();
      await glue.show("session:t3:th1");
      const viewer = t.panesOf(WINDOW)[1];
      assert.equal(t.panes.get(viewer)!.opts[ROLE], "viewer");
      assert.equal(t.panes.get(viewer)!.command.at(-1), "/run/t3/th1.jsonl");
      assert.equal(ui.state.window!.viewing, "session:t3:th1");
      assert.equal(JSON.parse(t.panes.get(viewer)!.opts[VIEWER_INFO]).where, "t3");
      const menu = windowMenu(ui.state, asker(list, "token"));
      const at = menu.items.findIndex((i) => i !== "-" && i.rule);
      assert.deepEqual(
        menu.items.slice(at, menu.items.indexOf("-", at)).map((i) => (i === "-" ? "-" : i.label)),
        ["Pixie login", "Rename…", "Interrupt", "Archive in T3 Code…"],
      );
    } finally {
      t3code.historyFile = historyFile;
      await glue.stop();
      ui.set({ ...before });
    }
  });

  test("Close archives it (its agent's end), and says so its way; not done: says why", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" }, sessions: [thread()] });
    const ended: string[] = [];
    const glue = startWindow(t.run, list, null, undefined, undefined, async (s) => (ended.push(s.sessionId), { how: "ended", ms: 1 }));
    try {
      await glue.refresh();
      await glue.close("t3:th1");
      assert.deepEqual(ended, ["t3:th1"]);
      assert.equal(ui.state.window!.note, "Archived Pixie login in T3 Code.");
      // Not connected (T3 quit meanwhile): said why.
      const refused = startWindow(t.run, list, null, undefined, undefined, async () => ({ how: "refused", why: "T3 Code isn't connected", ms: 1 }));
      await refused.close("t3:th1");
      assert.equal(ui.state.window!.note, "I didn't close Pixie login: T3 Code isn't connected.");
      await refused.stop();
    } finally {
      await glue.stop();
      ui.set({ ...before });
    }
  });
});
