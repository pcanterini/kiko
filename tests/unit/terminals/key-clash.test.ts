// A key clash, warned about and asked (src/terminals/tmux/clash.ts): your terminal app's own keys
// by TERM_PROGRAM (Warp's Ctrl+Space), what `kiko` leaves the app (clashNote: a question, a
// remembered answer, or a plain warning), the question as the window's popup draws it
// (clashQuestion through src/ui/menu-view.ts), and the answer kept in the settings
// (rememberKeyClash, in this test's own settings file) so the same clash isn't asked about again.
import "../../setup.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import { loadSettings, rememberKeyClash, SETTINGS_FILE } from "../../../src/core/settings.ts";
import { answeredMessage, checkKey, clashId, clashNote, clashQuestion, isClashAnswer, takers, TERMINAL_KEYS, terminalTaker, type Clash } from "../../../src/terminals/tmux/clash.ts";
import { keySequences, usableKey } from "../../../src/terminals/tmux/keys.ts";
import { menuSize, MenuView } from "../../../src/ui/menu-view.ts";

const WARP: Clash = { by: "terminal", app: "Warp", key: "C-Space", fallback: "C-\\" };
const TMUX: Clash = { by: "tmux", key: "C-Space", fallback: "C-\\" };

describe("your terminal app's own keys, by TERM_PROGRAM", () => {
  test("Warp takes Ctrl+Space; Ctrl+\\ is free there", async () => {
    const warp = terminalTaker({ TERM_PROGRAM: "WarpTerminal" })!;
    assert.deepEqual({ by: warp.by, app: warp.app }, { by: "terminal", app: "Warp" });
    assert.equal(await warp.takes("C-Space"), true);
    assert.equal(await warp.takes("C-\\"), false);
    assert.deepEqual(await checkKey("C-Space", [warp]), WARP);
  });
  test("the terminals that take neither (iTerm2, Terminal.app, Ghostty, WezTerm, kitty, Alacritty, none) aren't takers", () => {
    for (const program of ["iTerm.app", "Apple_Terminal", "ghostty", "WezTerm", "tmux", "herdr", "", undefined]) assert.equal(terminalTaker({ TERM_PROGRAM: program }), null, String(program));
    // kitty and Alacritty set TERM, not TERM_PROGRAM: nothing to find.
    assert.equal(terminalTaker({ TERM: "xterm-kitty" }), null);
    assert.equal(terminalTaker({ TERM_PROGRAM: "toString" }), null, "only the table's own entries");
  });
  test("only TERM_PROGRAM is read, nothing else of the environment", () => {
    const read: string[] = [];
    const env = new Proxy({ TERM_PROGRAM: "WarpTerminal", SECRET: "x" } as NodeJS.ProcessEnv, {
      get: (t, k) => (typeof k === "string" && read.push(k), Reflect.get(t, k)),
    });
    assert.ok(terminalTaker(env));
    assert.deepEqual(read, ["TERM_PROGRAM"]);
  });
  test("with the others: run in Warp outside tmux and herdr, Warp is what clashes", async () => {
    const around = takers({ TERM_PROGRAM: "WarpTerminal", NODE_TEST_CONTEXT: "child" }, null);
    assert.deepEqual(
      around.map((t) => t.by),
      ["terminal"],
    );
    assert.deepEqual(await checkKey("C-Space", around), WARP);
    assert.equal(await checkKey("C-\\", around), null, "a key set to Ctrl+\\ doesn't clash in Warp");
  });
  test("the table: each entry a name and keys Kiko could have (one line each)", () => {
    for (const [program, t] of Object.entries(TERMINAL_KEYS)) {
      assert.ok(t.name && program, program);
      for (const [key, does] of Object.entries(t.keys)) assert.ok(usableKey(key) && does, `${program} ${key}`);
    }
  });
});

describe("what `kiko` leaves the app about a clash", () => {
  test("not answered before: warned (shown and said), then asked; the question's id is this run's own", () => {
    const note = clashNote(WARP, { ask: true, run: "1" });
    assert.equal(note.text, "Warp uses Ctrl+Space for a new pane, so the menu key is Ctrl+\\ this time. Keep it, or pick your own?");
    assert.equal(note.spoken, "Warp uses Control-Space for a new pane, so the menu key is Control-Backslash this time. Keep it, or pick your own? It's asked in the window.");
    assert.deepEqual(note.ask, WARP);
    assert.deepEqual(note.log, { event: "key_clash", fields: { ...WARP, asked: true } });
    // Let go this run: the next `kiko` asks again (another id, so the app tells it again).
    assert.notEqual(note.id, clashNote(WARP, { ask: true, run: "2" }).id);
  });
  test("answered before: no question, nothing said, told once (the same id every run)", () => {
    const kept = clashNote(WARP, { answered: "fallback", ask: true, run: "1" });
    assert.equal(kept.ask, undefined);
    assert.equal(kept.spoken, undefined);
    assert.equal(kept.text, "Warp uses Ctrl+Space for a new pane. The menu key is Ctrl+\\ then, as you chose.");
    assert.equal(kept.id, clashNote(WARP, { answered: "fallback", ask: true, run: "2" }).id);
    assert.deepEqual(kept.log.fields, { ...WARP, answered: "fallback" });
    const own = clashNote(TMUX, { answered: "own", ask: true, run: "1" });
    assert.equal(own.text, "Your tmux uses Ctrl+Space. The menu key is Ctrl+\\ this time. Set yours in settings.");
    assert.equal(own.ask, undefined);
  });
  test("--key or KIKO_KEY (not asked), or no free key: only warned, as before", () => {
    const flagged = clashNote(TMUX, { ask: false, run: "1" });
    assert.equal(flagged.ask, undefined);
    assert.equal(flagged.id, "key_clash:tmux:C-Space:C-\\");
    assert.equal(flagged.text, "Your tmux uses Ctrl+Space, so the menu key is Ctrl+\\ this time. Change it in settings.");
    const none = clashNote({ ...TMUX, fallback: null }, { ask: true, run: "1" });
    assert.equal(none.ask, undefined);
    assert.match(none.text, /Click ☰ Kiko Dev in the bottom line/);
  });
  test("a clash is what took which key, and the key used instead", () => {
    assert.equal(clashId(WARP), "terminal:Warp:C-Space:C-\\");
    assert.equal(clashId(TMUX), "tmux:C-Space:C-\\");
    assert.notEqual(clashId({ ...TMUX, fallback: "C-]" }), clashId(TMUX));
    assert.ok(isClashAnswer("fallback") && isClashAnswer("own") && !isClashAnswer("yes") && !isClashAnswer(undefined));
  });
});

describe("the question, as the window's popup draws it", () => {
  const answer = (a: string) => [["send-keys", a]];
  const question = () => new MenuView(clashQuestion({ ...WARP, fallback: "C-\\" }, answer));
  test("says which program takes the key, and fits the popup", () => {
    const menu = clashQuestion({ ...WARP, fallback: "C-\\" }, answer);
    const lines = new MenuView(menu).frame(menuSize(menu).width, menuSize(menu).height).join("\n");
    assert.match(lines, /Warp uses Ctrl\+Space for a new pane,/);
    assert.match(lines, /so it never reaches Kiko\./);
    assert.match(lines, /Use Ctrl\+\\ from now on/);
    assert.match(lines, /Set my own key in settings…/);
    assert.match(lines, /Esc: Ctrl\+\\ this time, ask next time/);
    assert.ok(menuSize(menu).width <= 60);
  });
  test("y (or Enter on the first choice) keeps the fallback; s a key of your own", () => {
    assert.deepEqual(question().key("y"), { kind: "run", commands: [["send-keys", "fallback"]] });
    assert.deepEqual(question().key("\r"), { kind: "run", commands: [["send-keys", "fallback"]] });
    assert.deepEqual(question().key("s"), { kind: "run", commands: [["send-keys", "own"]] });
  });
  test("Escape, or the key in use again, answers nothing: the fallback this run, asked next time", () => {
    assert.deepEqual(question().key("\x1b"), { kind: "close" });
    for (const k of keySequences("C-\\")) assert.deepEqual(question().key(k), { kind: "close" });
    assert.deepEqual(question().key("x"), { kind: "none" });
  });
});

describe("the answer, remembered", () => {
  beforeEach(() => rmSync(SETTINGS_FILE, { force: true }));
  /** What the next `kiko` leaves, from the settings as saved (as cli.ts windowKey does). */
  const next = (c: Clash, run: string) => {
    const answered = loadSettings().keyClashAnswers?.[clashId(c)];
    return clashNote(c, { answered: isClashAnswer(answered) ? answered : undefined, ask: true, run });
  };
  test("asked once: answered, not asked again for the same clash", () => {
    assert.ok(next(WARP, "1").ask, "asked the first time");
    rememberKeyClash(clashId(WARP), "fallback");
    assert.equal(next(WARP, "2").ask, undefined, "not asked again");
    assert.equal(next(WARP, "3").ask, undefined);
  });
  test("asked again when the clash changes: another taker, or another fallback", () => {
    rememberKeyClash(clashId(WARP), "fallback");
    assert.ok(next(TMUX, "1").ask, "your tmux now, not Warp");
    assert.ok(next({ ...WARP, fallback: "C-]" }, "1").ask, "another key instead");
  });
  test("let go (no answer): asked again next time", () => {
    assert.ok(next(WARP, "1").ask);
    assert.ok(next(WARP, "2").ask);
  });
  test("kept with the rest of the settings, as they are", () => {
    rememberKeyClash(clashId(WARP), "own");
    rememberKeyClash(clashId(TMUX), "fallback");
    assert.deepEqual(loadSettings().keyClashAnswers, { [clashId(WARP)]: "own", [clashId(TMUX)]: "fallback" });
  });
  test("what the window says once answered", () => {
    assert.equal(answeredMessage({ ...WARP, fallback: "C-\\" }, "fallback"), "The menu key is Ctrl+\\ from now on when Warp takes Ctrl+Space.");
    assert.equal(answeredMessage({ ...TMUX, fallback: "C-\\" }, "own"), "Pick the menu key here. Ctrl+\\ until then.");
  });
});
