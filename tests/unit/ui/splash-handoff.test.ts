// The splash's first stage and its hand-off (src/ui/splash-handoff.ts): start.ts paints the splash
// while the app loads, on a clock the test moves (tests/support/clock.ts), and the app takes the
// screen over from it, frame for frame. On a small terminal of the test's own (Screen: each cell's
// character and colours, as far as the painter and Ink write them): the painter's frame is exactly
// the TUI's (tui.ts Splash), and the TUI's first frame drawn over it changes nothing. The hand-off
// itself between two real processes (the app's side is synchronous, over its fd 3), and the app
// stopping before it starts with something to say, or crashing: its words whole, on a clean screen,
// with what start.ts writes after it. No tmux.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { Writable, type Duplex } from "node:stream";
import { describe, test } from "node:test";
import { FakeClock } from "../../support/clock.ts";
import { keyboard, untilFrame } from "../../support/ink.ts";

// Truecolour, for Ink (chalk reads it as it loads: each test file runs in a process of its own) and
// for the splash's own reading of the terminal (cli-style.ts colorDepth), as in the Kiko window.
process.env.FORCE_COLOR = "3";
process.env.CLICOLOR_FORCE = "1";
process.env.COLORTERM = "truecolor";
delete process.env.NO_COLOR;
const React = (await import("react")).default;
const { render } = await import("ink");
const { LOGO_MS, TAGLINE } = await import("../../../src/ui/logo.ts");
const { FRAME_MS, SLOW_WORDS, SPLASH_TIMING, splashBlock, splashSoonest, splashTimer } = await import("../../../src/ui/splash.ts");
const { answerHandoff, paintSplash, resetTaken, splashArg, splashFrame, takeScreen } = await import("../../../src/ui/splash-handoff.ts");
const { Splash } = await import("../../../src/ui/tui.ts");
const { beforeSaidKept, CURSOR_ON, startingScreen } = await import("../../../src/ui/loading.ts");
const { CLOSE_HINT, lockHeldWords, otherRunningWords, SAID_EXIT } = await import("../../../src/core/running.ts");

const SRC = new URL("../../../src/", import.meta.url).pathname;
const [COLS, ROWS] = [80, 24];
const SOONEST = splashSoonest();

/**
 * A terminal screen, as far as the splash, Ink and start.ts write to one: each cell's character and
 * colours ("ch|fg|bg|dim"; a blank's colours don't show); the alternate screen (in: cleared; out:
 * the window's own again, its cursor back) and the cursor saved and restored.
 */
class Screen {
  cells: string[][];
  x = 0;
  y = 0;
  /** The window's own screen and its cursor, while on the alternate one. */
  private own: { cells: string[][]; x: number; y: number } | null = null;
  private saved = { x: 0, y: 0 };
  private fg = "";
  private bg = "";
  private dim = false;
  readonly cols: number;
  readonly rows: number;
  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => this.blankRow());
  }
  private blankRow = () => new Array<string>(this.cols).fill(" ||");
  private cell(ch: string) {
    return ch === " " ? ` ||${this.bg}` : `${ch}|${this.fg}|${this.bg}${this.dim ? "|dim" : ""}`;
  }
  private sgr(params: string) {
    const p = params === "" ? [0] : params.split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) [this.fg, this.bg, this.dim] = ["", "", false];
      else if (n === 2) this.dim = true;
      else if (n === 22) this.dim = false;
      else if (n === 39) this.fg = "";
      else if (n === 49) this.bg = "";
      else if (n === 38 || n === 48) {
        const colour = p[i + 1] === 2 ? p.slice(i + 2, i + 5).join(",") : `x${p[i + 2]}`;
        i += p[i + 1] === 2 ? 4 : 2;
        if (n === 38) this.fg = colour;
        else this.bg = colour;
      }
    }
  }
  write(text: string) {
    for (const m of text.matchAll(/\x1b\[([?0-9;]*)([A-Za-z])|\x1b[78]|\r|\n|[^\x1b\r\n]/gu)) {
      const [all, params = "", final] = m;
      if (all === "\r") this.x = 0;
      else if (all === "\n") [this.x, this.y] = [0, Math.min(this.rows - 1, this.y + 1)];
      else if (all === "\x1b7") this.saved = { x: this.x, y: this.y };
      else if (all === "\x1b8") [this.x, this.y] = [this.saved.x, this.saved.y];
      else if (!final) {
        if (this.x < this.cols) this.cells[this.y][this.x] = this.cell(all);
        this.x++;
      } else if (params === "?1049" && final === "h" && !this.own) {
        this.own = { cells: this.cells, x: this.x, y: this.y };
        this.cells = Array.from({ length: this.rows }, () => this.blankRow());
      } else if (params === "?1049" && final === "l" && this.own) {
        [this.cells, this.x, this.y] = [this.own.cells, this.own.x, this.own.y];
        this.own = null;
      } else if (params.startsWith("?")) continue;
      else {
        const n = (i: number, d: number) => Number(params.split(";")[i] || d);
        if (final === "m") this.sgr(params);
        else if (final === "H") [this.y, this.x] = [n(0, 1) - 1, n(1, 1) - 1];
        else if (final === "A") this.y = Math.max(0, this.y - n(0, 1));
        else if (final === "B") this.y = Math.min(this.rows - 1, this.y + n(0, 1));
        else if (final === "E") [this.x, this.y] = [0, Math.min(this.rows - 1, this.y + n(0, 1))];
        else if (final === "G") this.x = n(0, 1) - 1;
        else if (final === "K") {
          const from = params === "2" ? 0 : params === "1" ? -1 : this.x;
          for (let x = Math.max(0, from); x < this.cols && (params !== "1" || x <= this.x); x++) this.cells[this.y][x] = " ||";
        } else if (final === "J") {
          if (params === "2") this.cells = Array.from({ length: this.rows }, () => this.blankRow());
          else for (let y = this.y; y < this.rows; y++) for (let x = y === this.y ? this.x : 0; x < this.cols; x++) this.cells[y][x] = " ||";
        }
      }
    }
  }
  /** What it shows: each row's characters (trailing blanks trimmed). */
  text() {
    return this.cells.map((row) =>
      row
        .map((c) => c[0])
        .join("")
        .replace(/\s+$/, ""),
    );
  }
  /** Every cell, characters and colours, for comparing two screens. */
  key() {
    return this.cells.map((row) => row.join("\t")).join("\n");
  }
}

/** A terminal to paint on (paintSplash's `out`): what's written, onto a Screen; resizable. */
function terminal(cols = COLS, rows = ROWS) {
  const screen = new Screen(cols, rows);
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  const out = {
    columns: cols,
    rows,
    write(text: string) {
      writes.push(text);
      screen.write(text);
      return true;
    },
    on: (_e: "resize", fn: () => void) => listeners.add(fn),
    off: (_e: "resize", fn: () => void) => listeners.delete(fn),
  };
  return { out, screen, writes, listeners, resize: () => [...listeners].forEach((fn) => fn()) };
}

/**
 * The TUI's splash (tui.ts Splash) drawn by Ink onto `screen` from its cursor, as in the app, and
 * its first frame: Ink writes it as it renders (a legacy root: in render() itself), so it's on the
 * screen when this returns; anything later (Ink flushing, the effects' next frames) comes after.
 */
async function inkSplash(screen: Screen, splash: { since: number; slow: boolean; leaving: boolean; drawn?: number }) {
  let written = false;
  const out = new Writable({ write: (chunk, _enc, done) => ((written = true), screen.write(chunk.toString()), done()) }) as Writable & { columns: number; rows: number; isTTY: boolean };
  out.columns = screen.cols;
  out.rows = screen.rows;
  out.isTTY = true;
  const app = render(React.createElement(Splash, { splash }), { stdout: out as never, stdin: keyboard() as never, patchConsole: false, interactive: true, exitOnCtrlC: false, maxFps: 30 });
  assert.ok(written, "the first frame written as it rendered");
  return app;
}

describe("the splash's first stage (start.ts paints it)", () => {
  test("a frame: every row of the window, the logo where the TUI draws it (splashBlock), the rest erased, the cursor left home", () => {
    const frame = splashFrame(COLS, ROWS, null, { slow: true, depth: 24 }) as string;
    const screen = new Screen(COLS, ROWS);
    screen.write("x".repeat(COLS * ROWS));
    screen.write(frame);
    const block = splashBlock(COLS, ROWS, null, { slow: true, depth: 24 }) as { top: number; lines: string[] };
    assert.deepEqual(
      screen.text(),
      Array.from({ length: ROWS }, (_, r) => (block.lines[r - block.top] ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")),
      "nothing else left",
    );
    assert.ok(screen.text().some((row) => row.includes(TAGLINE)));
    assert.ok(screen.text().some((row) => row.trim() === SLOW_WORDS));
    assert.deepEqual([screen.x, screen.y], [0, 0]);
    assert.equal(splashFrame(30, 9, null, { slow: false, depth: 24 }), null, "too small for it");
  });

  test("painted from now: the screen cleared, the alternate screen, a frame every FRAME_MS while the effects play, Starting… from the soonest, then nothing", () => {
    const clock = new FakeClock();
    clock.t = 5000;
    const { out, writes, screen } = terminal();
    const painter = paintSplash(out, { depth: 24, clock });
    assert.equal(painter.since, 5000);
    assert.match(writes[0], /^\x1b\[\?2026h\x1b\[\?25l\x1b\[H\x1b\[2J\x1b\[\?1049h/, "the cursor hidden, the window's own screen cleared, then the alternate one");
    assert.ok(
      writes.every((w) => w.startsWith("\x1b[?2026h") && w.endsWith("\x1b[?2026l")),
      "each frame whole",
    );
    clock.advance(LOGO_MS + FRAME_MS);
    const during = writes.length;
    assert.ok(during >= Math.floor(LOGO_MS / FRAME_MS), `${during} frames`);
    assert.ok(!screen.text().some((row) => row.includes(SLOW_WORDS)));
    clock.advance(SOONEST - LOGO_MS - FRAME_MS);
    assert.equal(writes.length, during + 1, "once more, for Starting…");
    assert.ok(screen.text().some((row) => row.trim() === SLOW_WORDS));
    clock.advance(10_000);
    assert.equal(writes.length, during + 1, "then nothing");
    assert.equal(clock.pending(), 0);
    assert.equal(painter.stop(false), SOONEST, "the frame on the screen: Starting…'s");
  });

  test("stopped: the frame on the screen and when it was drawn; `clear` leaves the alternate screen; nothing after, the same answer again", () => {
    const clock = new FakeClock();
    const { out, writes, listeners } = terminal();
    const painter = paintSplash(out, { depth: 24, clock });
    clock.advance(500);
    const drawn = painter.stop(false);
    assert.equal(drawn, 495, "the last frame's, FRAME_MS apart");
    const written = writes.length;
    clock.advance(5000);
    assert.equal(writes.length, written, "nothing painted after");
    assert.equal(listeners.size, 0, "resizes not followed");
    assert.equal(painter.stop(true), drawn);
    assert.equal(writes.length, written, "asked once only");

    const other = terminal();
    const cleared = paintSplash(other.out, { depth: 24, clock: new FakeClock() });
    cleared.stop(true);
    assert.equal(other.writes.at(-1), "\x1b[?1049l");
  });

  test("the window resized: painted again at its new size; too small: blank, and nothing drawn (null)", () => {
    const clock = new FakeClock();
    const t = terminal();
    const painter = paintSplash(t.out, { depth: 24, clock });
    clock.advance(LOGO_MS + 10);
    t.out.columns = 60;
    t.resize();
    assert.match(t.writes.at(-1) as string, /\x1b\[2J/);
    t.out.columns = 20;
    t.resize();
    assert.equal(painter.stop(false), null);
  });
});

describe("the hand-off: the TUI's first frame is the painter's", () => {
  for (const ms of [120, 600, LOGO_MS - 8, LOGO_MS + 40]) {
    test(`at ${ms} ms: the same cells, characters and colours, and drawn over it, nothing changes`, async () => {
      const clock = new FakeClock();
      const t = terminal();
      const painter = paintSplash(t.out, { depth: 24, clock });
      clock.advance(ms);
      const drawn = painter.stop(false) as number;
      const painted = t.screen.key();
      const app = await inkSplash(t.screen, { since: Date.now() - drawn - 5, slow: false, leaving: false, drawn });
      try {
        assert.equal(t.screen.key(), painted);
        const alone = new Screen(COLS, ROWS);
        const own = await inkSplash(alone, { since: Date.now() - drawn - 5, slow: false, leaving: false, drawn });
        const first = alone.key();
        own.unmount();
        assert.equal(first, painted, "the TUI's frame on a blank screen: the painter's");
      } finally {
        app.unmount();
      }
    });
  }

  test("why its first frame is that one: the logo at rest drawn over the typing's last moments leaves its cursor behind (Ink doesn't erase a line's end)", async () => {
    const screen = new Screen(COLS, ROWS);
    // The tagline typed in full, its cursor still after it: the effects' last few ms (a frame can land there).
    screen.write(splashFrame(COLS, ROWS, LOGO_MS - 5, { slow: false, depth: 24 }) as string);
    assert.ok(screen.text().some((row) => row.endsWith(`${TAGLINE}▌`)));
    const app = await inkSplash(screen, { since: Date.now() - 5000, slow: false, leaving: false });
    const shown = screen.text();
    app.unmount();
    assert.ok(
      shown.some((row) => row.endsWith(`${TAGLINE}▌`)),
      "left behind",
    );
  });

  test("then on with the time: its next frame is the moment it is now, from `since`", async () => {
    const clock = new FakeClock();
    const t = terminal();
    const painter = paintSplash(t.out, { depth: 24, clock });
    clock.advance(100);
    const drawn = painter.stop(false) as number;
    const since = Date.now() - 600;
    const at = (ms: number) => {
      const s = new Screen(COLS, ROWS);
      s.write(splashFrame(COLS, ROWS, ms, { slow: false, depth: 24 }) as string);
      return s.text();
    };
    // The tagline's typing shows the moment in characters: typed this far.
    const typed = (rows: string[]) =>
      rows
        .find((row) => /^\s+Talk/.test(row))
        ?.trim()
        .replace("▌", "").length ?? 0;
    const from = Date.now() - since;
    const app = await inkSplash(t.screen, { since, slow: false, leaving: false, drawn });
    try {
      const first = t.screen.text().join("\n");
      assert.equal(first, at(drawn).join("\n"), "its first frame: the painter's");
      const next = await untilFrame(
        () => t.screen.text().join("\n"),
        (f) => f !== first,
        "the splash moved on",
      );
      const to = Date.now() - since;
      const shown = typed(next.split("\n"));
      assert.ok(shown >= typed(at(from)) && shown <= typed(at(to)), `typed ${shown}: between ${typed(at(from))} (when it started) and ${typed(at(to))} (now)`);
      assert.ok(shown > 0, "not where the painter stopped (before the typing)");
    } finally {
      app.unmount();
    }
  });
});

describe("its timing from `since`", () => {
  test("taken over late: the timing counts from the first frame; past the soonest, Starting… at once; past the latest, gone at once", () => {
    const said: string[] = [];
    const clock = new FakeClock();
    clock.t = 10_000;
    const late = splashTimer(clock, { hide: (why, ms) => said.push(`${why} ${ms}`), slow: () => said.push("slow") }, { since: 10_000 - SOONEST - 50 });
    clock.advance(0);
    assert.deepEqual(said, ["slow"]);
    late.ready();
    assert.deepEqual(said, ["slow", `ready ${SOONEST + 50}`]);
    const gone: string[] = [];
    splashTimer(clock, { hide: (why, ms) => gone.push(`${why} ${ms}`), slow: () => gone.push("slow") }, { since: clock.now() - SPLASH_TIMING.maxMs - 1 });
    clock.advance(0);
    assert.deepEqual(gone, ["slow", `timeout ${SPLASH_TIMING.maxMs + 1}`]);
  });

  test("the app's --splash: painted from <since>, or plain (its own first frame), or none", () => {
    assert.equal(splashArg(["--window", "--splash=1762250000123"]), 1762250000123);
    assert.equal(splashArg(["--window", "--splash"]), null);
    assert.equal(splashArg(["--window"]), undefined);
    assert.equal(splashArg(["--splash=soon"]), undefined);
  });
});

describe("between two processes (the app's side over its fd 3)", () => {
  /**
   * A child run as start.ts runs the app, a painter here (on `t`): `script` (imports from
   * splash-handoff.ts in scope); what it wrote to stdout, and to stderr (the window, for the app's
   * words: written onto `t` once it's ended, after what the painter wrote, as in the window).
   */
  async function runChild(t: ReturnType<typeof terminal>, painter: ReturnType<typeof paintSplash>, script: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { guardHandoff, takeScreen } from ${JSON.stringify(join(SRC, "ui/splash-handoff.ts"))}; ${script}`], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    answerHandoff(child.stdio[3] as Duplex, painter);
    let [out, said] = ["", ""];
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (said += d));
    const status = await new Promise<number | null>((r) => child.once("exit", r));
    if (said) t.out.write(said);
    return { out, said, status };
  }

  /** A child taking the screen (`take`) over its fd 3 from a painter here, as start.ts runs the app; what it heard, and the painter. */
  async function handOff(take: "keep" | "clear", painterFor: (out: ReturnType<typeof terminal>["out"]) => ReturnType<typeof paintSplash>) {
    const t = terminal();
    const painter = painterFor(t.out);
    const { out, said } = await runChild(t, painter, `const a = takeScreen(${JSON.stringify(take)}); const b = takeScreen("clear"); process.stdout.write(JSON.stringify([a, b]));`);
    assert.equal(said, "", "nothing said");
    return { heard: JSON.parse(out) as [number | null, number | null], t };
  }

  test("keep: the painting stopped, the child told when the frame on the screen was drawn, and asked once only", async () => {
    const clock = new FakeClock();
    let painter: ReturnType<typeof paintSplash> | undefined;
    const { heard, t } = await handOff("keep", (out) => {
      painter = paintSplash(out, { depth: 24, clock });
      clock.advance(300);
      return painter;
    });
    assert.deepEqual(heard, [297, 297]);
    const written = t.writes.length;
    clock.advance(2000);
    assert.equal(t.writes.length, written, "stopped");
    assert.notEqual(t.writes.at(-1), "\x1b[?1049l", "its frame left on the screen");
  });

  test("clear: the painting stopped and the alternate screen left", async () => {
    const { heard, t } = await handOff("clear", (out) => paintSplash(out, { depth: 24, clock: new FakeClock() }));
    assert.deepEqual(heard, [0, 0]);
    assert.equal(t.writes.at(-1), "\x1b[?1049l");
  });

  // The app stopping before it starts with something to say (SAID_EXIT: another app, the lock held):
  // it clears the screen for its words (app.ts), and start.ts keeps the window open on them
  // (core/running.ts afterApp "keep-open": loading.ts beforeSaidKept, then keepOpen's line under them).
  const WIDE = 160;
  const blank = (n: number) => new Array<string>(n).fill("");
  const sayings = [
    ["the lock held", lockHeldWords(4242)],
    ["the other flavour running", otherRunningWords()],
  ] as const;
  for (const [why, words] of sayings) {
    test(`stopped before starting (${why}), after the splash: its words whole on a clean screen, from the top row, the hint under them`, async () => {
      const clock = new FakeClock();
      const t = terminal(WIDE, ROWS);
      const painter = paintSplash(t.out, { depth: 24, clock });
      clock.advance(300);
      const { status } = await runChild(t, painter, `takeScreen("clear"); process.stderr.write(${JSON.stringify(`${words}\n`)}); process.exit(${SAID_EXIT});`);
      assert.equal(status, SAID_EXIT);
      t.out.write(`${beforeSaidKept(false)}\n${CLOSE_HINT}\n`);
      // Before: the top row taken back as "Starting…"'s is without the splash, the words' first line with it (2026-11-04).
      assert.deepEqual(t.screen.text(), [words, "", CLOSE_HINT, ...blank(ROWS - 3)]);
      assert.ok(beforeSaidKept(false).endsWith(CURSOR_ON), "the cursor shown again (the painter hid it)");
    });

    test(`stopped before starting (${why}), no splash: "Starting…" taken back, the words under it whole`, () => {
      const screen = new Screen(WIDE, ROWS);
      screen.write(startingScreen("tiled"));
      screen.write(`${words}\n`);
      screen.write(`${beforeSaidKept(true)}\n${CLOSE_HINT}\n`);
      assert.deepEqual(screen.text(), ["", "", words, "", CLOSE_HINT, ...blank(ROWS - 5)]);
    });
  }

  test('a crash as it loads, after the splash: its trace whole on a clean screen, from the top row (afterApp "leave": start.ts shows the cursor, nothing more)', async () => {
    const t = terminal(WIDE, ROWS);
    const painter = paintSplash(t.out, { depth: 24, clock: new FakeClock() });
    const { said, status } = await runChild(t, painter, `guardHandoff(["--splash=1"]); throw new Error("broke as it loaded");`);
    assert.equal(status, 1);
    assert.match(said, /Error: broke as it loaded/);
    t.out.write(CURSOR_ON);
    const lines = said.split("\n").map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, "")
        .slice(0, WIDE)
        .replace(/\s+$/, ""),
    );
    assert.deepEqual(t.screen.text().slice(0, Math.min(lines.length, ROWS - 1)), lines.slice(0, ROWS - 1));
    assert.ok(!t.screen.text().some((row) => row.includes(TAGLINE)), "no logo left");
  });

  test("no painter on that fd (not a socket): nothing asked, and the fd left alone", () => {
    resetTaken();
    const fd = openSync(join(SRC, "ui/splash-handoff.ts"), "r");
    try {
      assert.equal(takeScreen("keep", fd), null);
      assert.ok(fstatSync(fd).isFile(), "still open");
    } finally {
      closeSync(fd);
      resetTaken();
    }
  });
});
