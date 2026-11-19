// The Kiko window's classic look, the app's side (src/ui/classic.ts): its one line, its last (no
// header), in three zones. Left, Kiko's state as the tiled look's bottom line words it
// (src/ui/bar.ts: one piece of logic), drawn the full-screen UI's way (the red badge and the
// waveform while listening, a spinner while deciding); middle, what the full screen's header has on
// its right; right, the keys (the list's, or only the menu's while the stage has the keyboard).
// Narrow, the middle gives way first, then the keys (the menu's last), the state never before
// them. The caption is the last three lines of what you're saying. Rendered with Ink as the frame pane gets them; colours aside (no terminal here).
// Then the glue's side on a pretend tmux 3.8 (tests/support/fake-tmux.ts): the lines sent over the
// frame's real socket, the caption's box made and gone. The real tmux: tests/live/terminals/classic-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ui, type UiState } from "../../../src/core/ui-store.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { FRAME_SOCKET } from "../../../src/terminals/tmux/classic.ts";
import { WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { BAR, describe as layoutOf, openWindow, ROLE } from "../../../src/terminals/tmux/window.ts";
import { barText } from "../../../src/ui/bar.ts";
import { aboutText, SILENT_HERE, captionLines, captionWidth, CAPTION_LINES, forgetHeldStatus, frameLines, FULL_SCREEN_KEYS, quietLevels, windowKeys } from "../../../src/ui/classic.ts";
import { take, windowEvents } from "../../../src/ui/input.ts";
import { pushLevel } from "../../../src/ui/meter.ts";
import { startWindow } from "../../../src/ui/window-glue.ts";
import { framePath } from "../../../src/ui/window-frame.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";
import { checkWaits } from "../../support/until.ts";

const state = (patch: Partial<UiState>): UiState =>
  ({ ...ui.state, about: { voice: "george (Pocket)", model: "Haiku", hotkey: "right_option", pttMode: "hold", classifier: true }, playOnMac: false, macPlays: false, cost: 0, ...patch }) as UiState;
const session = (name: string, fields: Partial<Session> = {}) =>
  ({ sessionId: name, cwd: `/code/${name}`, givenName: name, kind: "interactive", status: "idle", desktop: false, place: null, mapping: "none", nameSetBy: "user", ...fields }) as unknown as Session;
const plain = (s: string) => s.replace(/\u001b\[[0-9;:]*m/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = checkWaits(3000, 20);
const lineOf = (s: UiState, columns = 160, at: Parameters<typeof frameLines>[2] = {}) => plain(frameLines(s, columns, at).bottom);
/** A cell of the line for each character (tmux draws the mic's 🎙, one code point, a cell wide, as Ink lays it out). */
const cells = (s: string) => [...s].length;
const KEYS = ". repeat · m mute · ⌃Space menu";
const MENU = "⌃Space menu";

describe("the line's state (the left)", () => {
  test("ready: \"ready\" on the left (no logo, no talk hint); what it's set to and the list's keys at the right; no timings", () => {
    const line = lineOf(state({ lastTiming: "stt 210ms · route 80ms" }));
    assert.match(line, /^ ready {2,}silent on this Mac · Haiku · \$0\.000 · \. repeat · m mute · ⌃Space menu$/);
    assert.ok(!line.includes("is ready") && !line.includes("●"), line);
    assert.ok(!line.includes("🎙 Kiko") && !line.includes("to talk"), line);
    assert.ok(!line.includes("⏱") && !line.includes("stt 210ms"), "the timings are the log's now (press_done), not the window's");
    assert.equal(line.length, 159, "the line, its padding at the right end left to the frame");
    // Muted: said in the middle as the full screen's header says it.
    assert.match(lineOf(state({ muted: true })), /muted · silent on this Mac/);
  });

  test("the states the bottom line shows, in its words", () => {
    const now = 10_000;
    const lacy = session("lacy");
    const cases: Array<[Partial<UiState>, RegExp]> = [
      [{ handsFree: { on: true, by: null } }, /^ ● Kiko is listening for “Kiko”/],
      [{ holding: { text: "x", to: "lacy", sessionId: "lacy", startedAt: 0 }, sessions: [lacy] }, /^ sending to → lacy {2}/],
      [{ routed: { text: "x", to: "lacy", sessionId: "lacy", tookMs: 300, at: now - 100 } }, /^ sent to → lacy {2}/],
      [{ speaking: true }, /^ ♪ speaking/],
      [{ speaking: true, muted: true }, /^ muted/],
      // Ready, then who waits for you.
      [{ waiting: { sessionId: "pixie", name: "pixie", kind: "permission", phase: "waiting", until: null } as UiState["waiting"] }, /^ ready · ⚠ pixie needs you {2}/],
      [{ waiting: { sessionId: "pixie", name: "pixie", kind: "reply", phase: "waiting", until: null } as UiState["waiting"] }, /^ ready · ◆ waiting for reply {2}/],
      [{ waiting: { sessionId: "pixie", name: "pixie", kind: "reply", phase: "waiting", until: now + 11_200 } as UiState["waiting"] }, /^ ready · ◆ waiting for reply 12s {2}/],
      // Hands-free, someone else was talking around the app's words: the name is needed this time.
      [
        { handsFree: { on: true, by: null }, waiting: { sessionId: "pixie", name: "pixie", kind: "reply", phase: "waiting", until: now + 11_200, needsName: true } as UiState["waiting"] },
        /^ ● Kiko is listening for “Kiko” · ◆ waiting for reply 12s · say “Kiko” first {2}/,
      ],
      // Ready, and how many sessions work when any does.
      [{}, /^ ready {2}/],
      [{ sessions: [session("ann", { status: "busy" }), session("bob", { status: "busy" }), session("cy")] }, /^ ready · 2 working {2}/],
      // Only sessions in a turn: one idle with work left running in the background isn't counted.
      [{ sessions: [session("ann", { status: "busy", background: { count: 1 } }), session("cy", { background: { count: 3, quiet: 3, quietSince: 0 } })] }, /^ ready · 1 working {2}/],
      [{ sessions: [session("cy", { background: { count: 3 } })] }, /^ ready {2}/],
      [{ sessions: [session("ann", { status: "busy" }), session("bob", { status: "waiting" })] }, /^ ready · 1 working · ◆ bob waits for you {2}/],
      [{ sessions: [session("bob", { status: "waiting" })] }, /^ ready · ◆ bob waits for you {2}/],
      [{ sessions: [session("ann", { status: "blocked" }), session("bob", { status: "waiting" })] }, /^ ready · ⚠ ann needs you · ◆ bob waits for you {2}/],
      // After something that shows, as before.
      [{ speaking: true, sessions: [session("bob", { status: "waiting" })] }, /^ ♪ speaking · ◆ bob waits for you/],
    ];
    for (const [patch, want] of cases) assert.match(lineOf(state(patch), 160, { now }), want, JSON.stringify(patch));
    // The notice (a key clash's) after what it's doing, as on the bottom line; first when it's ready.
    const notice = "Your tmux uses Ctrl+Space, so the menu key is Ctrl+\\ here.";
    assert.match(lineOf(state({}), 160, { notice }), /^ ready · Your tmux uses Ctrl\+Space/);
    assert.match(lineOf(state({ handsFree: { on: true, by: null } }), 160, { notice }), /^ ● Kiko is listening for “Kiko” · Your tmux uses Ctrl\+Space/);
    // The bottom line (tmux older than 3.8, or the tiled look) still says it's ready: its left would be blank otherwise.
    assert.match(barText(state({})), /Kiko is ready/);
  });

  test("listening: the badge and the waveform (newest on the right), never the words", () => {
    let levels = quietLevels();
    for (const l of [0.1, 0.5, 0.99]) levels = pushLevel(levels, l);
    const said = "tell lacy to run the tests";
    const line = lineOf(state({ listening: true, interim: said }), 160, { levels });
    assert.match(line, /^ {2}● LISTENING {2}▁▁▁▁▁▁▁▁▅█ /);
    assert.ok(!line.includes("tell lacy"), line);
    assert.match(lineOf(state({ listening: true, handsFree: { on: true, by: "reply" } })), /^ {2}● REPLY /);
    assert.match(lineOf(state({ listening: true, handsFree: { on: true, by: "name" } })), /^ {2}● KIKO /);
    // The bottom line (tmux older than 3.8) still has the words: one piece of logic, two drawings.
    assert.match(barText(state({ listening: true, interim: said })), /● listening#\[default\] “tell lacy to run the tests”/);
  });

  test("deciding: what showed before for a moment (never blank), then a spinner; checking: a spinner", () => {
    const deciding = state({ deciding: { text: "x", startedAt: 1000 } });
    forgetHeldStatus();
    assert.match(lineOf(deciding, 160, { now: 1200 }), /^ {3,}silent/, "nothing before it: nothing");
    assert.match(lineOf(state({ listening: true }), 160, { now: 900 }), /^ {2}● LISTENING/);
    assert.match(lineOf(deciding, 160, { now: 1200 }), /^ {2}● LISTENING/, "listening kept until deciding shows");
    lineOf(state({}), 160, { now: 900 });
    assert.match(lineOf(deciding, 160, { now: 1200 }), /^ ready {2,}silent/, "ready kept");
    assert.match(lineOf(deciding, 160, { now: 1600 }), /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] deciding…/);
    assert.match(lineOf(state({ checking: { what: "the tests", startedAt: 0 } }), 160, { now: 1600 }), /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] checking…/);
  });

  test("silent on this Mac is plain words, no symbol", () => {
    assert.equal(SILENT_HERE, "silent on this Mac");
  });

  test("silent on this Mac only when it is: the setting off and a phone playing, not while the Mac stands in", () => {
    const rest = "george (Pocket) · Haiku · Classifier · $0.000";
    // Play on this Mac off, a phone playing what's said: the Mac is silent.
    assert.equal(aboutText(state({ playOnMac: false, macPlays: false })), `silent on this Mac · ${rest}`);
    // Off, but no phone plays it (closed, in the background, locked): the Mac stands in and plays.
    assert.equal(aboutText(state({ playOnMac: false, macPlays: true })), rest);
    assert.ok(!lineOf(state({ playOnMac: false, macPlays: true })).includes("silent"));
    // On: it plays.
    assert.equal(aboutText(state({ playOnMac: true, macPlays: true })), rest);
    assert.equal(aboutText(state({ muted: true, macPlays: true })), `muted · ${rest}`);
    // The classifier named only while it's on; the voice by its name and engine, no "voice" before it.
    const off = state({ macPlays: true });
    assert.equal(aboutText({ ...off, about: { ...off.about, classifier: false } }), "george (Pocket) · Haiku · $0.000");
  });
});

describe("the line's two sides, narrow and wide", () => {
  const mic = { mic: { device: { uid: "u", name: "USB Mic", isDefault: true }, fallback: false } as UiState["mic"], cost: 0.012 };
  const INFO = "silent on this Mac · Haiku · $0.012 · USB Mic";
  let levels = quietLevels();
  for (const l of [0.1, 0.5, 0.99]) levels = pushLevel(levels, l);
  const LISTENING = "  ● LISTENING  ▁▁▁▁▁▁▁▁▅█";
  const needs = { sessions: [session("pixie", { status: "blocked" })] };

  /** The line as drawn, checked: never wider than the frame; the menu's words where menuAt says. */
  function zones(patch: Partial<UiState>, columns: number, at: Parameters<typeof frameLines>[2] = {}) {
    const got = frameLines(state({ ...mic, ...patch }), columns, { levels, ...at });
    const line = plain(got.bottom);
    assert.ok(cells(line) <= columns - 1, `${columns}: ${cells(line)} cells`);
    if (got.menuAt >= 0) {
      assert.equal(got.menuAt, columns - 1 - MENU.length, `${columns}: right-aligned, a column in`);
      assert.equal([...line].slice(got.menuAt, got.menuAt + MENU.length).join(""), MENU, `${columns}: the menu's words at menuAt`);
    }
    return { line, menuAt: got.menuAt };
  }
  const gapsOf = (line: string) => line.trim().split(/ {2,}/);

  test("160 columns: the state on the left; on the right what it's set to, then the keys, one group; no voice, no classifier, no 🎙", () => {
    const { line, menuAt } = zones({}, 160);
    assert.deepEqual(gapsOf(line), ["ready", `${INFO} · ${KEYS}`]);
    assert.ok(!line.includes("george") && !line.includes("Classifier") && !line.includes("🎙"), line);
    assert.ok(menuAt > 0);
  });

  test("the free trial: its short item after what it's set to; none without one", () => {
    const { line } = zones({ plan: { text: "trial · 6d left", warn: false } }, 160);
    assert.deepEqual(gapsOf(line), ["ready", `silent on this Mac · Haiku · $0.012 · trial · 6d left · USB Mic · ${KEYS}`]);
    // (Its colours are Ink's, not drawn in a test's plain render: the tmux line's are checked in window-glue.test.ts.)
    assert.match(zones({ plan: { text: "trial · 85% used", warn: true } }, 160).line, /\$0\.012 · trial · 85% used · USB Mic/);
    assert.ok(!zones({ plan: null }, 160).line.includes("trial"));
  });

  test("narrow: what it's set to cut from its start (…), then gone, every key still there", () => {
    assert.match(zones({}, 60).line, /^ ready {2,}….* · \. repeat · m mute · ⌃Space menu$/);
    assert.deepEqual(gapsOf(zones({}, 45).line), ["ready", KEYS], "nothing but the keys at 45");
  });

  test("while listening: what it's set to gives way first, then the keys from the left, the menu's last; the badge and waveform always whole", () => {
    const at = (c: number) => zones({ listening: true }, c);
    for (const c of [160, 120, 90, 60, 50]) assert.ok(at(c).line.startsWith(`${LISTENING}  `), at(c).line);
    assert.ok(at(160).line.endsWith(`${INFO} · ${KEYS}`), at(160).line);
    assert.match(at(90).line, / {2}….* · \. repeat · m mute · ⌃Space menu$/);
    assert.ok(!at(60).line.includes("USB Mic"), at(60).line);
    assert.match(at(60).line, / {2,}\. repeat · m mute · ⌃Space menu$/);
    assert.match(at(50).line, / {2,}m mute · ⌃Space menu$/);
    assert.match(at(40).line, /▅█ {2,}⌃Space menu$/);
    const tiny = at(26);
    assert.equal(tiny.line, LISTENING);
    assert.equal(tiny.menuAt, -1);
  });

  test("⚠ X needs you: the state whole at every width; cut at its end only once it alone is wider than the line", () => {
    for (const c of [160, 120, 90, 60]) {
      const { line, menuAt } = zones(needs, c);
      assert.ok(line.startsWith(" ready · ⚠ pixie needs you  "), `${c}: ${line}`);
      assert.ok(line.endsWith(MENU) && menuAt > 0, `${c}: ${line}`);
    }
    const many = state({ sessions: ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"].map((n) => session(n, { status: "blocked" })) });
    const got = frameLines(many, 50);
    assert.match(plain(got.bottom), /^ ready · ⚠ aaaaaaaa needs you · ⚠ bbbbbbbb needs…$/);
    assert.equal(got.menuAt, -1, "no menu words on the line: a click there is nothing");
  });

  test("the stage has the keyboard: only the menu's key, the one that works there, still clickable, after what it's set to", () => {
    for (const c of [160, 120, 90]) {
      const { line, menuAt } = zones({}, c, { keys: "stage" });
      assert.ok(line.endsWith(`${INFO} · ${MENU}`) && !line.includes("repeat"), `${c}: ${line}`);
      assert.ok(menuAt > 0);
    }
    assert.deepEqual(gapsOf(zones({ listening: true }, 40, { keys: "stage" }).line), ["● LISTENING", "▁▁▁▁▁▁▁▁▅█", MENU]);
  });

  test("the keys: the list's as it takes them (q or Q quits there), the menu's key last; the full screen's its own", () => {
    assert.equal(windowKeys(), KEYS);
    assert.equal(FULL_SCREEN_KEYS, ". repeat · m mute · 1-9 pick session · s settings · q quit");
  });
});

describe("the caption", () => {
  test("two thirds of the width, at least 40, never past the screen", () => {
    assert.equal(captionWidth(160), 107);
    assert.equal(captionWidth(45), 40);
    assert.equal(captionWidth(100), 67);
  });
  test("nothing before words come; the last three wrapped lines of what's said, the newest words in", () => {
    assert.deepEqual(captionLines("", 60), []);
    assert.deepEqual(captionLines("  tell lacy  ", 60), ["tell lacy"]);
    const said = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const lines = captionLines(said, 44); // 40 columns of text inside the border and a column each side
    assert.equal(lines.length, CAPTION_LINES);
    assert.ok(
      lines.every((l) => l.length <= 40),
      JSON.stringify(lines),
    );
    assert.ok(lines[2].endsWith("word39"), lines[2]);
    assert.ok(!lines.join(" ").includes("word0 "), "the oldest words have scrolled away");
    // An escape sequence in what's heard is never passed on.
    assert.deepEqual(captionLines("hi \u001b[2J there", 60), ["hi [2J there"]);
  });
});

describe("the window's frame and caption, from the app (src/ui/window-glue.ts, on a pretend tmux 3.8)", () => {
  /** A frame program as ./frame-pane.ts is: connected to the app's socket, saying what it is and its size, keeping what it's sent. */
  function client(path: string, role: "frame" | "caption", pane: string, cols: number, rows: number) {
    const got: any[] = [];
    const socket = createConnection(path);
    socket.setEncoding("utf8");
    let rest = "";
    socket.on("data", (d: string) => {
      const lines = (rest + d).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) got.push(JSON.parse(l));
    });
    socket.on("connect", () => socket.write(`${JSON.stringify({ role, pane, cols, rows })}\n`));
    return { got, last: () => got.at(-1), close: () => socket.destroy() };
  }

  test("its line goes to the frame at its width, with no header (the keys the list's while it has the keyboard, else the menu's alone); the caption a box once words come, its words sent to it, gone when you let go; the bottom line left alone", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "cbf-")), "app.sock");
    process.env.KIKO_SOCKET = sock;
    const t = new FakeTmux();
    t.version = "tmux 3.8";
    await openWindow(t.run, () => ({ argv: ["/bin/sh", "-c", "the app"], discard: () => {} }), "/code", { width: 160, height: 45 });
    const v = (await layoutOf(t.run)).view!;
    const before = ui.state;
    ui.set({
      window: { shown: null, note: "" },
      about: { ...ui.state.about, voice: "george (Pocket)", model: "Haiku", hotkey: "right_option", classifier: true },
      playOnMac: false,
      macPlays: false,
      listening: false,
      interim: "",
      cost: 0,
    });
    const glue = startWindow(t.run, v.list!.id, null);
    let frame: ReturnType<typeof client> | null = null;
    try {
      await glue.refresh();
      assert.equal(ui.state.window!.look, "classic");
      assert.equal(t.global[FRAME_SOCKET], framePath(), "the socket's path kept on the server for the frame");
      frame = client(framePath(), "frame", v.frame!.id, 160, 45);
      await until(() => Boolean(frame!.last()), "the frame's lines");
      assert.match(plain(frame.last().bottom), /^ ready {2,}silent on this Mac · Haiku · \$0\.000 · \. repeat · m mute · ⌃Space menu$/);
      assert.equal(frame.last().top, undefined, "no header");
      assert.equal(frame.last().menuAt, 160 - 1 - "⌃Space menu".length);
      // A focus report with the list still the active pane (your terminal lost focus): the keys as they were.
      windowEvents.emit("focus", false);
      await wait(150);
      assert.match(plain(frame.last().bottom), /\. repeat · m mute .* ⌃Space menu$/);
      assert.ok(!ui.state.window!.inStage, "the list's ► stays off");
      // The keyboard to the stage (tmux's active pane, asked as the list's focus report comes): the
      // menu's key alone, still where a click opens it; back, the list's keys.
      await t.run(["select-pane", "-t", v.stage!.id]);
      windowEvents.emit("focus", false);
      await until(() => !plain(frame!.last().bottom).includes("repeat"), "the stage's keys");
      assert.match(plain(frame.last().bottom), /\$0\.000 · ⌃Space menu$/);
      assert.equal(ui.state.window!.inStage, true, "the list's ► on the one shown");
      assert.equal(frame.last().menuAt, 160 - 1 - "⌃Space menu".length);
      await t.run(["select-pane", "-t", v.list!.id]);
      windowEvents.emit("focus", true);
      await until(() => plain(frame!.last().bottom).includes(". repeat · m mute"), "the list's keys again");
      assert.equal(ui.state.window!.inStage, false);
      // Listening: the badge, and no caption until words come.
      ui.set({ listening: true, interim: "", level: 0.5 });
      await until(() => plain(frame!.last().bottom).includes("● LISTENING"), "the badge");
      await wait(120);
      assert.equal((await layoutOf(t.run)).view!.caption, null);
      ui.set({ interim: "tell lacy to run the tests" });
      await until(() => [...t.panes.values()].some((p) => p.opts[ROLE] === "caption"), "the caption's box");
      const id = [...t.panes.values()].find((p) => p.opts[ROLE] === "caption")!.id;
      assert.equal(t.windows.get(t.panes.get(v.list!.id)!.window)!.active, v.list!.id, "the keyboard stays in the list");
      const caption = client(framePath(), "caption", id, 105, 1);
      await until(() => Boolean(caption.last()), "the caption's words");
      assert.deepEqual(caption.last(), { lines: ["tell lacy to run the tests"] });
      assert.ok(!plain(frame.last().bottom).includes("tell lacy"), "the line has no words");
      // More words than three lines hold: the last three, the box three lines tall.
      ui.set({ interim: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") });
      await until(() => caption.last().lines.length === 3, "three lines");
      assert.ok(caption.last().lines[2].endsWith("word59"));
      await until(() => t.panes.get(id)?.height === 3, "sized to three lines");
      // Let go: gone.
      ui.set({ listening: false, interim: "" });
      await until(() => !t.panes.has(id), "the caption gone");
      await until(() => /^ ready {2,}silent on this Mac/.test(plain(frame!.last().bottom)), "ready again");
      caption.close();
      assert.equal(t.sessions.get(WINDOW)!.opts[BAR], "Kiko Dev is starting…", "no status line pushed: the frame's line has it");
    } finally {
      frame?.close();
      await glue.stop();
      ui.set(before);
      delete process.env.KIKO_SOCKET;
    }
  });
});

describe("the list's focus", () => {
  test("focus reports out of its input (tmux gives the keyboard to the pane, or takes it away), in order; the keys round them for Ink", () => {
    const got = take("a\x1b[Ob\x1b[Ic", "token");
    assert.deepEqual(got.focus, [false, true]);
    assert.equal(got.keys, "abc");
    assert.equal(take("x\x1b[", "token").rest, "\x1b[");
  });
});
