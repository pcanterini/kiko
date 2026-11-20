// The voice glow in the Kiko window (src/ui/window-glow.ts): which mode the app's state shows (the
// setting and Reduce motion first, then listening, holding or deciding, speaking out loud on this
// Mac, a quick task), the level it's drawn with (the mic's, Kiko's sound's a little softer, a gentle
// made-up one where there's none), and its loop: started only out of idle, drawing while it shows,
// stopped (its timer gone) once a frame idle has faded out, and nothing at all while idle. In the
// tiled look's list (src/ui/window-list.ts) its rows rise above the keys while you talk and are gone
// after; none in the classic look's list (the window has it there), nor in a pane too small. Reduce
// motion as `defaults` says it. Nothing here touches tmux, the mic or the Mac's settings.
import "../../setup.ts";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import type { UiState } from "../../../src/core/ui-store.ts";
import { untilFrame, inkDone } from "../../support/ink.ts";

process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
delete process.env.NO_COLOR;

const React = (await import("react")).default;
const { render } = await import("ink");
const { ui } = await import("../../../src/core/ui-store.ts");
const { WindowList } = await import("../../../src/ui/window-list.ts");
const { COLORFUL, GLOW_COLS } = await import("../../../src/ui/dither-glow.ts");
const { micLevel } = await import("../../../src/ui/voice-envelope.ts");
const { GlowDriver, gentleVoice, glowInput, glowMode, LIST_GLOW_MIN_COLS, LIST_GLOW_MIN_ROWS, LIST_GLOW_ROWS, listGlowSize, runningGlows } = await import("../../../src/ui/window-glow.ts");
const { reduceMotion, reduceMotionOf } = await import("../../../src/platform/macos/reduce-motion.ts");

const h = React.createElement;
const state = (patch: Partial<UiState> = {}): UiState => ({ ...ui.state, voiceGlow: true, sessionsLoaded: true, window: { shown: null, note: "" }, ...patch });
const deciding = { text: "run the tests", startedAt: 0 } as unknown as UiState["deciding"];

describe("the mode for the app's state", () => {
  test("listening, then holding or deciding, then Kiko speaking, then a quick task; idle otherwise", () => {
    const cases: [Partial<UiState>, string][] = [
      [{}, "idle"],
      [{ listening: true }, "listening"],
      [{ listening: true, handsFree: { on: true, by: "name" } }, "listening"],
      [{ deciding }, "processing"],
      [{ holding: { text: "x", to: "pixie", sessionId: "p", startedAt: 0 } }, "processing"],
      [{ checking: { what: "the weather", startedAt: 0 } }, "processing"],
      [{ speaking: true }, "speaking"],
      [{ listening: true, deciding, speaking: true }, "listening"],
      [{ deciding, speaking: true }, "processing"],
      [{ speaking: true, checking: { what: "x", startedAt: 0 } }, "speaking"],
      // Not heard on this Mac: muted, or left to a phone.
      [{ speaking: true, muted: true }, "idle"],
      [{ speaking: true, macPlays: false }, "idle"],
      [{ speaking: true, muted: true, checking: { what: "x", startedAt: 0 } }, "idle"],
    ];
    for (const [patch, mode] of cases) assert.equal(glowMode(state(patch)), mode, JSON.stringify(patch));
  });

  test("none with the setting off (or not given), or with macOS's Reduce motion on", () => {
    assert.equal(glowMode(state({ listening: true, voiceGlow: false })), "idle");
    assert.equal(glowMode({ ...state({ listening: true }), voiceGlow: undefined }), "idle");
    assert.equal(glowMode(state({ listening: true, reduceMotion: true })), "idle");
  });

  test("the level: the mic's turned up as the original does it, Kiko's sound's softer, a gentle one where it has none", () => {
    assert.deepEqual(glowInput(state({ listening: true, level: 0.6 }), 0), { mode: "listening", level: micLevel(0.6) });
    assert.equal(glowInput(state({ listening: true, level: 0.6, micConnecting: "AirPods" }), 0).level, 0, "no sound yet");
    assert.deepEqual(glowInput(state({ deciding }), 0), { mode: "processing", level: 0 });
    const said = glowInput(state({ speaking: true }), 0, () => 0.6);
    assert.equal(said.mode, "speaking");
    assert.ok(said.level > 0 && said.level < micLevel(0.6), String(said.level));
    let asked = 0;
    glowInput(state({ listening: true }), 0, () => (asked++, 0.5));
    assert.equal(asked, 0, "Kiko's sound is only looked at while it speaks");
    const made = Array.from({ length: 200 }, (_, i) => glowInput(state({ speaking: true }), i / 50, () => null).level);
    assert.ok(Math.min(...made) >= 0.2 && Math.max(...made) <= 0.45, `${Math.min(...made)}–${Math.max(...made)}`);
    assert.ok(new Set(made.map((l) => l.toFixed(2))).size > 10, "it moves");
    assert.equal(gentleVoice(3.3), gentleVoice(3.3));
  });
});

/** A driver on a fake clock and timer: `step()` one tick on (1/25 s). */
function driven(input: () => { mode: "idle" | "listening" | "processing" | "speaking"; level: number }) {
  let now = 0;
  let tick: (() => void) | null = null;
  const made: number[] = [];
  const told: string[] = [];
  const drawn: string[][] = [];
  const loop = new GlowDriver({
    cols: 40,
    rows: 3,
    depth: 24,
    palette: COLORFUL,
    input,
    draw: (lines) => drawn.push([...lines]),
    opened: () => told.push("opened"),
    closed: () => told.push("closed"),
    now: () => now,
    every: (ms, fn) => {
      made.push(ms);
      tick = fn;
      return () => void (tick = null);
    },
  });
  return {
    loop,
    made,
    told,
    drawn,
    get ticking() {
      return tick !== null;
    },
    step(n = 1) {
      for (let i = 0; i < n && tick; i++) {
        now += 40;
        tick();
      }
    },
  };
}

describe("the loop", () => {
  test("idle: no timer at all, however often it's woken", () => {
    const d = driven(() => ({ mode: "idle", level: 0 }));
    for (let i = 0; i < 5; i++) d.loop.wake();
    assert.equal(d.made.length, 0);
    assert.equal(d.loop.running, false);
    assert.deepEqual(d.told, []);
  });

  test("out of idle it starts (once), at 25 a second; back to idle it fades out, then its timer stops", () => {
    let input: { mode: "listening" | "idle"; level: number } = { mode: "listening", level: 0.5 };
    const before = runningGlows();
    const d = driven(() => input);
    d.loop.wake();
    d.loop.wake();
    assert.deepEqual(d.made, [40], "one timer, 40 ms");
    assert.deepEqual(d.told, ["opened"]);
    assert.equal(runningGlows(), before + 1);
    d.step(30);
    assert.equal(d.drawn.length, 31, "a frame at once, then one a tick");
    assert.ok(d.drawn.at(-1)!.every((l) => l.length > 0));
    assert.ok(/[⠁-⣿]/.test(d.drawn.at(-1)!.join("")), "lit dots");
    input = { mode: "idle", level: 0 };
    d.step(5);
    assert.equal(d.loop.running, true, "still fading out");
    d.step(30); // the fade out is half a second
    assert.equal(d.loop.running, false);
    assert.equal(d.ticking, false, "its timer gone");
    assert.deepEqual(d.told, ["opened", "closed"]);
    assert.equal(runningGlows(), before);
    const frames = d.drawn.length;
    d.step(10);
    d.loop.wake();
    assert.equal(d.drawn.length, frames, "nothing drawn while idle");
    // And again, once there's something to show.
    input = { mode: "listening", level: 0.2 };
    d.loop.wake();
    assert.deepEqual(d.told, ["opened", "closed", "opened"]);
    d.loop.stop();
    assert.equal(d.ticking, false);
    assert.deepEqual(d.told, ["opened", "closed", "opened", "closed"]);
  });

  test("resized: its rows at the new size", () => {
    const d = driven(() => ({ mode: "processing", level: 0 }));
    d.loop.wake();
    d.loop.resize(24, 2);
    d.step();
    assert.equal(d.drawn.at(-1)!.length, 2);
    assert.equal(d.loop.cols, 24);
    d.loop.stop();
  });
});

describe("in the tiled look's list", () => {
  test("a band as wide as the list's text up to the glow's own, three rows; none in a pane too small", () => {
    assert.deepEqual(listGlowSize(30, 40), { cols: 30, rows: LIST_GLOW_ROWS });
    assert.deepEqual(listGlowSize(200, 40), { cols: GLOW_COLS, rows: LIST_GLOW_ROWS });
    assert.equal(listGlowSize(LIST_GLOW_MIN_COLS - 1, 40), null);
    assert.equal(listGlowSize(30, LIST_GLOW_MIN_ROWS - 1), null);
  });

  /** An Ink terminal: `frame()` the last frame drawn, plain. */
  function terminal(columns: number, rows: number) {
    let text = "";
    const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns, rows, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const FRAME_START = /\u001b\[2J|\u001b\[1;1H\u001b\[J|(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
    const frame = () => (text.split(FRAME_START).at(-1) ?? text).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    return { stdout, stdin, frame };
  }
  const lit = (line: string) => /[⠁-⣿]/.test(line);
  const glowRowsOf = (frame: string) => frame.split("\n").filter(lit);

  test("rises above the keys while you talk, and is gone (its loop stopped) after", async () => {
    const t = terminal(34, 30);
    const app = render(h(WindowList, { s: state({ listening: true, level: 0.8 }) }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
    try {
      const shown = await untilFrame(t.frame, (f) => glowRowsOf(f).length >= 2, "the glow");
      const lines = shown.split("\n").map((l) => l.trimEnd());
      const keys = lines.findIndex((l) => l.includes("c new"));
      const rows = lines.map((l, i) => (lit(l) ? i : -1)).filter((i) => i >= 0);
      assert.ok(
        rows.every((i) => i < keys && i >= keys - LIST_GLOW_ROWS),
        `just above the keys:\n${shown}`,
      );
      assert.equal(lines.length, 30, "the list as tall as ever");
      assert.equal(runningGlows(), 1);
      // Let go, nothing being decided: it fades out.
      app.rerender(h(WindowList, { s: state() }));
      await untilFrame(t.frame, (f) => glowRowsOf(f).length === 0, "the glow gone", 3000);
      assert.equal(runningGlows(), 0, "no timer left");
      // While Kiko works out where your words go: the beam.
      app.rerender(h(WindowList, { s: state({ deciding }) }));
      await untilFrame(t.frame, (f) => glowRowsOf(f).length >= 1, "the beam");
      app.rerender(h(WindowList, { s: state({ deciding, voiceGlow: false }) }));
      await untilFrame(t.frame, (f) => glowRowsOf(f).length === 0, "off: gone", 3000);
      assert.equal(runningGlows(), 0);
    } finally {
      app.unmount();
    }
    assert.equal(runningGlows(), 0, "unmounted: stopped");
  });

  test("none in the classic look's list (the window has it), nor in a pane too short or too narrow", async () => {
    for (const [columns, rows, look] of [
      [34, 30, "classic"],
      [34, LIST_GLOW_MIN_ROWS - 1, undefined],
      [LIST_GLOW_MIN_COLS, 30, undefined],
    ] as const) {
      const t = terminal(columns, rows);
      const s = state({ listening: true, level: 0.8, window: { shown: null, note: "", look } });
      const app = render(h(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
      try {
        await inkDone(app);
        await new Promise((r) => setTimeout(r, 300));
        await inkDone(app);
        assert.deepEqual(glowRowsOf(t.frame()), [], `${columns}×${rows} ${look ?? "tiled"}`);
        assert.equal(runningGlows(), 0);
      } finally {
        app.unmount();
      }
    }
  });
});

describe("Reduce motion", () => {
  test("as `defaults` says it; off when it can't be read, off the Mac, and never read under the test runner", async () => {
    assert.equal(reduceMotionOf("1\n"), true);
    assert.equal(reduceMotionOf("0\n"), false);
    assert.equal(reduceMotionOf(null), false);
    const asked: string[][] = [];
    const exec = async (file: string, args: string[]) => (asked.push([file, ...args]), "1\n");
    assert.equal(await reduceMotion(exec, "darwin", {}), true);
    assert.deepEqual(asked, [["/usr/bin/defaults", "read", "com.apple.universalaccess", "reduceMotion"]]);
    assert.equal(await reduceMotion(exec, "linux", {}), false);
    assert.equal(await reduceMotion(exec), false, "the test runner's");
    assert.equal(asked.length, 1);
  });
});
