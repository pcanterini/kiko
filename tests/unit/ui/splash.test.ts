// Kiko's logo (src/ui/logo.ts) and the splash as the window opens (src/ui/splash.ts, drawn by
// tui.ts Splash): which logo fits where, its shapes with and without colour, the effects playing
// and settling, and the splash's timing on a clock the test moves (tests/support/clock.ts): the
// soonest it goes, "Starting…" while the app takes longer, the latest it stays, a key skipping it,
// and when there's none at all.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { FakeClock } from "../../support/clock.ts";
import { inkDone, plain, untilFrame } from "../../support/ink.ts";
import { checkWaits } from "../../support/until.ts";
import { ui, type Action } from "../../../src/core/ui-store.ts";
import { colorDepth } from "../../../src/ui/cli-style.ts";
import { LOGO_MS, logoGrid, logoMark, logoRows, logoSize, printLogo, TAGLINE } from "../../../src/ui/logo.ts";
import { MIN_ROWS, SLOW_WORDS, SPLASH_TIMING, splashBlock, splashFits, splashScreen, splashTimer, splashWanted, wholeFirst, type SplashEnd } from "../../../src/ui/splash.ts";
import { Splash } from "../../../src/ui/tui.ts";

const ESC = /\x1b\[/;
const SOONEST = LOGO_MS + SPLASH_TIMING.holdMs;

describe("the logo", () => {
  test("the wide one where it fits (52 columns and up), the narrow one down to 33, none under", () => {
    assert.equal(logoSize(120), "wide");
    assert.equal(logoSize(52), "wide");
    assert.equal(logoSize(51), "narrow");
    assert.equal(logoSize(39), "narrow");
    assert.equal(logoSize(33), "narrow");
    assert.equal(logoSize(32), null);
    assert.equal(logoSize(24), null);
  });

  test("its shapes at rest, as with no colour: KIKO. in block letters with two copies behind, the tagline under it", () => {
    const wide = logoGrid("wide", null).plain();
    assert.deepEqual(wide, [
      "██▓  ▄██▀▓  ██████▓  ██▓  ▄██▀▓   ▄█████▄",
      "██▓▄██▀▓▓▒▒  ▓██▓▓▓▒ ██▓▄██▀▓▓▒▒ ██▀▓▓▓▀██▓",
      "█████▓▓▒▒     ██▓▒   █████▓▓▒▒   ██▓▒▒  ██▓▒",
      "██▓▀██▄       ██▓▒   ██▓▀██▄     ██▄▒  ▄██▓▒ ▄▄▄",
      "██▓▒ ▀██▄   ██████▓  ██▓▒ ▀██▄    ▀█████▀▓▓▒ ███▓▒",
      " ▓▓▒   ▓▓▓▒  ▓▓▓▓▓▓▒  ▓▓▒   ▓▓▓▒    ▓▓▓▓▓▒▒   ▓▓▓▒",
      "",
      `     ${TAGLINE}`,
    ]);
    const narrow = logoGrid("narrow", null).plain();
    assert.equal(narrow[0], "██▓ ▄█▀▓ ▀▀▓ ██▓");
    assert.deepEqual(narrow.slice(-2), ["Talk to all your coding agents", "           at once."], "the tagline on two lines");
  });

  test("colour: truecolor, or xterm's 256 (indigo kept blue); none at all is the shapes alone (NO_COLOR)", () => {
    const truecolor = logoRows("wide", null, 24).join("\n");
    assert.match(truecolor, /\x1b\[0m\x1b\[38;2;210;216;255m██/, "the pale face");
    assert.match(truecolor, /38;2;154;168;255m/, "the dot in the brand's periwinkle");
    const xterm = logoRows("wide", null, 256).join("\n");
    assert.match(xterm, /38;5;\d+m/);
    assert.doesNotMatch(xterm, /38;2;/);
    const none = logoRows("wide", null, 0);
    assert.ok(none.every((row) => !ESC.test(row)));
    assert.deepEqual(
      none.map((r) => r.replace(/\s+$/, "")),
      logoGrid("wide", null).plain(),
    );
    assert.equal(colorDepth({ isTTY: true }, { NO_COLOR: "1", COLORTERM: "truecolor" }), 0);
    assert.equal(colorDepth({ isTTY: true }, { COLORTERM: "truecolor" }), 24);
    assert.equal(colorDepth({ isTTY: true }, { TERM: "xterm-256color" }), 256);
    assert.equal(colorDepth({ isTTY: false }, { COLORTERM: "truecolor" }), 0);
  });

  test("the effects: nothing at the first frame, rows fading in, the light sweeping, the tagline typing with a cursor; at rest after", () => {
    const first = logoGrid("wide", 0).plain();
    assert.ok(
      first.every((row) => row.trim() === ""),
      "the first frame is empty: it fades in from nothing",
    );
    const fading = logoGrid("wide", 200).plain().join("\n");
    assert.match(fading, /[░▒▓]/);
    const typing = logoGrid("wide", 700).plain().at(-1)!.trim();
    assert.ok(typing.length > 0 && typing.length < TAGLINE.length && TAGLINE.startsWith(typing), typing);
    assert.match(logoRows("wide", 700, 24).at(-1)!, /▌/, "the cursor while it types");
    const sweeping = logoRows("wide", 700, 24).join("");
    assert.notEqual(sweeping, logoRows("wide", null, 24).join(""), "the sweep lights some of it");
    assert.deepEqual(logoRows("wide", LOGO_MS, 24), logoRows("wide", null, 24), "at rest once the effects are done");
    assert.ok(LOGO_MS <= 1100, `about a second in all (${LOGO_MS} ms)`);
  });

  test("the one-line mark: Kiko. in the brand's colours, plain with none", () => {
    assert.equal(logoMark(0), "Kiko.");
    assert.equal(logoMark(24).replace(/\x1b\[[0-9;]*m/g, ""), "Kiko.");
    assert.match(logoMark(24), /\x1b\[1;38;2;236;236;239mKiko\x1b\[38;2;154;168;255m\./);
  });

  test("printed into a scrolling terminal: at rest when it isn't one; played in place, the cursor hidden and shown again, a key skipping the rest", async () => {
    let still = "";
    assert.equal(await printLogo({ write: (t: string) => (still += t) }, { columns: 80, depth: 0, animate: false, indent: 2 }), true);
    assert.equal(still.split("\n").filter((l) => l.includes(TAGLINE)).length, 1);
    assert.ok(still.startsWith("  ██▓"));
    let narrowOut = "";
    assert.equal(await printLogo({ write: (t: string) => (narrowOut += t) }, { columns: 30, depth: 0, animate: false }), false, "too narrow: nothing");
    assert.equal(narrowOut, "");

    let played = "";
    let skip = () => {};
    const skipped = new Promise<void>((r) => (skip = r));
    const started = Date.now();
    const playing = printLogo({ write: (t: string) => (played += t) }, { columns: 80, depth: 24, animate: true, skipped, frameMs: 5 });
    setTimeout(skip, 50);
    await playing;
    assert.ok(Date.now() - started < LOGO_MS, "skipped: not played out");
    assert.ok(played.startsWith("\x1b[?25l"), "the cursor hidden as it plays");
    assert.ok(played.endsWith("\x1b[?25h"), "and shown again");
    assert.match(played, /\x1b\[8A/, "each frame over the one before");
    const last = played.slice(played.lastIndexOf("\x1b[8A"));
    assert.ok(last.includes(TAGLINE), "the last frame at rest, the tagline whole");
  });
});

describe("the splash", () => {
  test("its logo for the window: wide at 80 × 24 and up, narrow under 52 columns, none under 33 or under 10 rows", () => {
    assert.equal(splashFits(80, 24), "wide");
    assert.equal(splashFits(120, 40), "wide");
    assert.equal(splashFits(45, 24), "narrow");
    assert.equal(splashFits(32, 24), null);
    assert.equal(splashFits(80, MIN_ROWS), "wide");
    assert.equal(splashFits(80, MIN_ROWS - 1), null);
    assert.equal(splashFits(Number.NaN, 24), null, "a size tmux didn't say");
  });

  test("centred in the window; at rest after its effects; Starting… under the tagline only while the app takes longer, nothing moving when it comes", () => {
    const rest = splashScreen(80, 24, null);
    assert.equal(rest.length, 24);
    const top = rest.findIndex((l) => l.trim());
    assert.equal(top, 7, "(24 − 10) / 2 rows above");
    assert.ok(rest[top].startsWith(`${" ".repeat(15)}██▓`), "(80 − 50) / 2 columns in");
    assert.ok(!rest.join("\n").includes(SLOW_WORDS));
    const slow = splashScreen(80, 24, null, true);
    assert.deepEqual(slow.slice(0, top + 8), rest.slice(0, top + 8), "the logo where it was");
    assert.equal(slow[top + 9], `${" ".repeat(35)}${SLOW_WORDS}`);
    assert.ok(
      splashScreen(80, 24, 0).every((l) => l === ""),
      "its first frame: nothing yet",
    );
    assert.ok(
      splashScreen(30, 24, null).every((l) => l === ""),
      "too small: nothing",
    );
  });

  test("NO_COLOR: the shapes only, Starting… plain", () => {
    const block = splashBlock(80, 24, null, { slow: true, depth: 0 })!;
    assert.ok(block.lines.every((l) => !ESC.test(l)));
    const coloured = splashBlock(80, 24, null, { slow: true, depth: 24 })!;
    assert.match(coloured.lines.at(-1)!, /\x1b\[2mStarting…\x1b\[22m/, "dim, in colour");
  });

  test("only on the window's cold start, on a terminal, in a window it fits, with nothing else to show first; KIKO_SPLASH=off for the live tests", () => {
    const cold = { cold: true, tty: true, cols: 120, rows: 40 };
    assert.equal(splashWanted(cold), true);
    assert.equal(splashWanted({ ...cold, cold: false }), false, "a restart (and a reattach starts nothing)");
    assert.equal(splashWanted({ ...cold, tty: false }), false, "not a terminal");
    assert.equal(splashWanted({ ...cold, cols: 30 }), false, "too narrow for even the narrow logo");
    assert.equal(splashWanted({ ...cold, rows: 9 }), false, "too short");
    assert.equal(splashWanted({ ...cold, cols: 40, rows: 12 }), true, "the narrow one");
    assert.equal(splashWanted({ ...cold, note: true }), false, "Kiko Dev's first start has something to say");
    assert.equal(splashWanted({ ...cold, building: true }), false, "helpers to build first");
    assert.equal(splashWanted({ ...cold, off: "off" }), false);
    assert.equal(splashWanted({ ...cold, off: "0" }), false);
    assert.equal(splashWanted({ ...cold, off: "1" }), true);
  });

  test("`kiko` makes the window whole from the start when the splash is coming (or setup, which takes it whole too), so no terminal draws the two panes before it", () => {
    const made = { cols: 120, rows: 40, firstRun: false };
    assert.equal(wholeFirst(made), true);
    assert.equal(wholeFirst({ ...made, cols: 30 }), false, "too narrow for the logo: the list's own size");
    assert.equal(wholeFirst({ ...made, rows: 9 }), false, "too short");
    assert.equal(wholeFirst({ ...made, off: "off" }), false, "KIKO_SPLASH=off");
    assert.equal(wholeFirst({ ...made, cols: 30, firstRun: true }), true, "setup comes first: the whole window anyway");
    assert.equal(wholeFirst({ ...made, off: "off", firstRun: true }), true);
  });

  describe("its timing", () => {
    const timed = () => {
      const clock = new FakeClock();
      const said: { hide?: { why: SplashEnd; ms: number }; hides: number; slowAt: number | null } = { hides: 0, slowAt: null };
      const timer = splashTimer(clock, {
        hide(why, ms) {
          said.hide = { why, ms };
          said.hides++;
        },
        slow: () => (said.slowAt = clock.now()),
      });
      return { clock, timer, said };
    };

    test("ready before the logo's effects end: they finish and the hold goes by, then it goes (the soonest), under 2 s", () => {
      const { clock, timer, said } = timed();
      clock.advance(300);
      timer.ready();
      clock.advance(SOONEST - 301);
      assert.equal(said.hides, 0, "not before the soonest");
      clock.advance(1);
      assert.deepEqual(said.hide, { why: "ready", ms: SOONEST });
      assert.equal(said.slowAt, null, "never slow");
      assert.ok(SOONEST < 2000, `${SOONEST} ms`);
      clock.advance(10_000);
      assert.equal(said.hides, 1);
      assert.equal(clock.pending(), 0, "nothing left waiting");
    });

    test("ready later: Starting… from the soonest, then it goes as soon as the app is ready", () => {
      const { clock, timer, said } = timed();
      clock.advance(SOONEST);
      assert.equal(said.slowAt, SOONEST);
      assert.equal(said.hides, 0);
      clock.advance(2500 - SOONEST);
      timer.ready();
      assert.deepEqual(said.hide, { why: "ready", ms: 2500 });
    });

    test("never ready: the app anyway at the latest (4 s), in its own loading state; ready after that changes nothing", () => {
      const { clock, timer, said } = timed();
      clock.advance(SPLASH_TIMING.maxMs - 1);
      assert.equal(said.hides, 0);
      clock.advance(1);
      assert.deepEqual(said.hide, { why: "timeout", ms: SPLASH_TIMING.maxMs });
      assert.equal(SPLASH_TIMING.maxMs, 4000);
      timer.ready();
      assert.equal(said.hides, 1);
    });

    test("a key skips it at once, mid-effects too; once only", () => {
      const { clock, timer, said } = timed();
      clock.advance(120);
      timer.skip();
      assert.deepEqual(said.hide, { why: "skipped", ms: 120 });
      timer.skip();
      timer.ready();
      clock.advance(10_000);
      assert.equal(said.hides, 1);
      assert.equal(said.slowAt, null);
    });
  });

  test("drawn by the TUI: the logo centred, any key skips it, Ctrl+C too (quitting's hint carried to the list), Ctrl+C again quits; blank while it leaves", async () => {
    const acts: Action[] = [];
    const act = ui.act;
    ui.act = (a: Action) => void acts.push(a);
    let shown = "";
    const out = new Writable({ write: (chunk, _enc, done) => ((shown += chunk.toString()), done()) }) as Writable & { columns: number; rows: number };
    out.columns = 80;
    out.rows = 24;
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.ref = () => {};
    stdin.unref = () => {};
    // Waits for what's drawn or asked for (tests/support/ink.ts), never a fixed time.
    const until = checkWaits(5000);
    const at = { since: Date.now() - 5000, slow: false, leaving: false };
    const app = render(React.createElement(Splash, { splash: at }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true, exitOnCtrlC: false });
    try {
      const drawn = await untilFrame(
        () => plain(shown),
        (f) => f.includes(TAGLINE),
        "the logo",
      );
      assert.ok(drawn.includes(TAGLINE), drawn);
      assert.ok(drawn.includes("██▓  ▄██▀▓"));
      stdin.write("x");
      await until(() => acts.length, "the key's act");
      assert.deepEqual(acts, [{ type: "skipSplash" }]);
      stdin.write("\x03");
      await until(() => acts.length > 1, "Ctrl+C's act");
      assert.deepEqual(acts.at(-1), { type: "skipSplash" }, "the first Ctrl+C skips it, never quits");
      stdin.write("\x03");
      await until(() => acts.length > 2, "Ctrl+C again");
      assert.deepEqual(acts.at(-1), { type: "quit" });
      shown = "";
      app.rerender(React.createElement(Splash, { splash: { ...at, leaving: true } }));
      await inkDone(app);
      assert.ok(shown, "drawn again");
      assert.ok(!plain(shown).includes(TAGLINE), "blank while leaving");
    } finally {
      app.unmount();
      ui.act = act;
    }
  });
});
