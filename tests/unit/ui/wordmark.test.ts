// Kiko's own row at the top of the window's list (src/ui/wordmark.ts, window-list.ts): the brand's
// periwinkle square (▪) as its icon in the icon column, then "Kiko" (bold, the site's pale text
// colour, no dot after it) in the names' column, in both looks and with the Nerd Font icons setting
// on or off; a narrow row cutting the name as a session's is cut; the square steady while Kiko is
// idle and pulsing (2.5 steps a second between three close shades) while it listens or speaks,
// driven here by a fake clock; steady in 256 colours, uncoloured with NO_COLOR; and the list just as
// tall as before. Every wait is for Ink to be through, or for a frame showing what's expected
// (tests/support/ink.ts), never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, test } from "node:test";
import type { Session } from "../../../src/core/sessions.ts";
import type { UiState } from "../../../src/core/ui-store.ts";
import type { Instance } from "ink";
import { FakeClock } from "../../support/clock.ts";
import { inkDone, untilFrame } from "../../support/ink.ts";

// Truecolour on for Ink (chalk reads it as it loads: each test file runs in a process of its own),
// and for the wordmark's own reading of the terminal (cli-style.ts colorDepth).
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
delete process.env.NO_COLOR;
const React = (await import("react")).default;
const { render } = await import("ink");
const { ui } = await import("../../../src/core/ui-store.ts");
const { WindowList } = await import("../../../src/ui/window-list.ts");
const { BRAND, hexTo256 } = await import("../../../src/ui/logo.ts");
const { KIKO_SQUARE, KikoSquare, PULSE, PULSE_MS, squareColor, Wordmark, wordmarkPulses } = await import("../../../src/ui/wordmark.ts");
const { cells } = await import("../../../src/ui/viewer.ts");
const { MARK_SLOT } = await import("../../../src/ui/marks.ts");
const { agents } = await import("../../../src/agents/index.ts");

const h = React.createElement;
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
/** The truecolour SGR for a "#rrggbb" foreground, as chalk writes it. */
const fg = (hex: string) => `\u001b[38;2;${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}m`;

const session = (name: string, pane: string, fields: Partial<Session> = {}) =>
  ({
    sessionId: name,
    cwd: `/code/${name}`,
    givenName: name,
    kind: "interactive",
    status: "idle",
    desktop: false,
    place: { via: "tmux", id: pane, keys: true, pid: 1 },
    mapping: "none",
    nameSetBy: "user",
    ...fields,
  }) as unknown as Session;
const state = (patch: Partial<UiState> = {}): UiState => ({
  ...ui.state,
  about: { ...ui.state.about, hotkey: "right_option" },
  sessionsLoaded: true,
  window: { shown: "%1", note: "" },
  sessions: [session("api", "%1", { status: "busy" }), session("docs", "%2"), session("billing", "%3", { status: "waiting" }), session("kiko 2", "%4")],
  ...patch,
});

/** An Ink terminal: what's written kept; `frame()` the last frame, raw (colours in). */
function terminal(columns: number, rows: number) {
  let text = "";
  const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns, rows, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  // Ink's frames after the first erase the one before (from the top, or line by line up).
  const FRAME_START = /\u001b\[2J|\u001b\[1;1H\u001b\[J|(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/;
  const frame = () => text.split(FRAME_START).at(-1) ?? text;
  /** What `act` has `app` draw next, once Ink is through with it ("" if it draws nothing). */
  const next = async (app: Instance, act: () => void) => {
    text = "";
    act();
    await inkDone(app);
    return text ? frame() : "";
  };
  return { stdout, stdin, frame, next };
}

/** The list drawn `columns` × `rows`: its lines, plain and raw. */
async function list(s: UiState, columns: number, rows = 14) {
  const t = terminal(columns, rows);
  const app = render(h(WindowList, { s }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
  await inkDone(app);
  const raw = t.frame();
  app.unmount();
  return {
    raw,
    lines: plain(raw)
      .split("\n")
      .map((l) => l.trimEnd()),
  };
}

/** Kiko's square and name alone, on a fake clock: their frames as the test moves time on. */
function mark(props: { pulsing: boolean; depth: 0 | 256 | 24 }, clock = new FakeClock()) {
  const t = terminal(20, 2);
  const app = render(h(Wordmark, { ...props, clock }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
  return {
    clock,
    t,
    app,
    /** The frame once Ink has drawn it. */
    async now() {
      await inkDone(app);
      return t.frame();
    },
    /** The frame drawn after the clock moves `ms` on ("" for none). */
    after: (ms: number) => t.next(app, () => clock.advance(ms)),
    rerender: (p: Partial<typeof props>) => app.rerender(h(Wordmark, { ...props, ...p, clock })),
  };
}

const env = { NO_COLOR: process.env.NO_COLOR, COLORTERM: process.env.COLORTERM };
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("Kiko's square and name", () => {
  test("▪: one character, one cell, a text glyph (no emoji presentation), the site's small square at terminal size", () => {
    assert.equal(KIKO_SQUARE, "▪");
    assert.equal([...KIKO_SQUARE].length, 1);
    assert.equal(cells(KIKO_SQUARE), 1);
    assert.ok(!/\p{Emoji_Presentation}/u.test(KIKO_SQUARE), "drawn as text, never an emoji");
    // Kiko's own, no agent's (OpenCode's ▣ is a square too, but a bigger, hollow one).
    for (const a of agents) assert.ok(a.mark?.glyph !== KIKO_SQUARE && a.mark?.nerd !== KIKO_SQUARE, a.id);
  });

  test("the site's colours: the square its periwinkle accent, then 'Kiko' bold in its pale text colour, no dot after it", async () => {
    assert.equal(BRAND.text, "#ececef");
    assert.equal(BRAND.accent, "#9aa8ff");
    const m = mark({ pulsing: false, depth: 24 });
    try {
      const out = await m.now();
      // The square in a slot as wide as a session's mark's, the name after it.
      assert.equal(plain(out).trimEnd(), `${KIKO_SQUARE}${" ".repeat(MARK_SLOT - 1)}Kiko`);
      assert.ok(out.includes(`${fg(BRAND.accent)}${KIKO_SQUARE}`), JSON.stringify(out));
      assert.match(out, new RegExp(`\\u001b\\[1m(?:\\u001b\\[[0-9;]*m)*${fg(BRAND.text).replace(/\[/g, "\\[")}Kiko`), "bold, pale");
      assert.ok(!plain(out).includes("."), "no trailing dot");
    } finally {
      m.app.unmount();
    }
  });

  test("pulses while listening or speaking out loud; steady when idle, deciding, or speaking muted", () => {
    const at = (s: Partial<UiState>) => wordmarkPulses({ listening: false, speaking: false, muted: false, ...s });
    assert.equal(at({}), false);
    assert.equal(at({ listening: true }), true);
    assert.equal(at({ speaking: true }), true);
    assert.equal(at({ speaking: true, muted: true }), false);
  });

  test("the pulse: a step every 400 ms (2.5 a second) through three close shades round the accent, never off; back to the accent when it stops", async () => {
    // Three shades, next to each other on the brand's indigo ramp, the accent between the others.
    assert.equal(new Set(PULSE).size, 3);
    assert.deepEqual([PULSE[0], PULSE[2]], [BRAND.accent, BRAND.accent]);
    assert.deepEqual([PULSE[1], PULSE[3]], [BRAND.indigo[2], BRAND.indigo[4]]);
    assert.equal(1000 / PULSE_MS, 2.5);
    const m = mark({ pulsing: true, depth: 24 });
    try {
      const squares: string[] = [];
      const square = (out: string) => PULSE.find((c) => out.includes(`${fg(c)}${KIKO_SQUARE}`)) ?? "none";
      squares.push(square(await m.now()));
      for (let i = 0; i < 5; i++) squares.push(square(await m.after(PULSE_MS)));
      assert.deepEqual(squares, [PULSE[0], PULSE[1], PULSE[2], PULSE[3], PULSE[0], PULSE[1]]);
      // Between steps nothing changes: a step is PULSE_MS.
      assert.equal(await m.after(PULSE_MS - 1), "", "nothing drawn before the next step");
      const later = await m.after(1);
      assert.equal(square(later), PULSE[2]);
      // Only the square pulses: the name stays as it was.
      assert.match(later, new RegExp(`${fg(BRAND.text).replace(/\[/g, "\\[")}Kiko`));
      // Idle again: the accent at once, and no timer left running.
      m.rerender({ pulsing: false });
      assert.equal(square(await m.now()), BRAND.accent);
      assert.equal(m.clock.pending(), 0);
      assert.equal(await m.after(PULSE_MS * 3), "", "steady: nothing drawn again");
    } finally {
      m.app.unmount();
    }
    assert.equal(m.clock.pending(), 0, "unmounted: its timer gone");
  });

  test("steady when idle: no timer at all", async () => {
    const clock = new FakeClock();
    const t = terminal(4, 1);
    const app = render(h(KikoSquare, { pulsing: false, depth: 24, clock }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
    try {
      await inkDone(app);
      assert.equal(plain(t.frame()).trim(), KIKO_SQUARE);
      assert.equal(clock.pending(), 0);
    } finally {
      app.unmount();
    }
  });

  test("256 colours: the accent's nearest, steady even while pulsing; no colour (NO_COLOR): a plain ▪, no pulse", async () => {
    assert.equal(squareColor(256, true, 1), `ansi256(${hexTo256(BRAND.accent)})`);
    assert.equal(squareColor(0, true, 1), undefined);
    assert.equal(squareColor(24, true, 1), PULSE[1]);
    for (const depth of [256, 0] as const) {
      const m = mark({ pulsing: true, depth });
      try {
        const out = await m.now();
        assert.equal(plain(out).trimEnd(), `${KIKO_SQUARE}  Kiko`);
        assert.equal(m.clock.pending(), 0, `${depth}: no pulse`);
        if (depth === 0) assert.ok(!/\u001b\[3[89];/.test(out), `no colour: ${JSON.stringify(out)}`);
        else assert.ok(out.includes(`\u001b[38;5;${hexTo256(BRAND.accent)}m${KIKO_SQUARE}`), JSON.stringify(out));
      } finally {
        m.app.unmount();
      }
    }
  });
});

/** The cell `text` starts at in a plain line (each character here one cell: Nerd Font icons are astral, two in JavaScript's count). */
const column = (line: string, text: string) => [...line.slice(0, line.indexOf(text))].length;

describe("Kiko's row in the window's list", () => {
  const LOOKS = [undefined, "classic"] as const;
  const ICONS = ["unicode", "nerd"] as const;

  test("the square in the icon column, 'Kiko' in the names' column, as every session's: both looks, Nerd Font icons on and off", async () => {
    for (const look of LOOKS) {
      for (const icons of ICONS) {
        const at = `${look ?? "tiled"}, ${icons}`;
        const s = state({ icons, window: { shown: "%1", note: "", ...(look ? { look } : {}) } });
        const { lines } = await list(s, 36);
        const kiko = lines[0];
        assert.equal(kiko, look ? ` 0   ${KIKO_SQUARE}  Kiko` : `  0   ${KIKO_SQUARE}  Kiko`, at);
        const rows = ["api", "docs", "billing"].map((name) => {
          const line = lines.find((l) => l.includes(` ${name}`));
          assert.ok(line, `${at}: ${name} in\n${lines.join("\n")}`);
          return { name, line };
        });
        for (const { name, line } of rows) {
          const nameAt = column(line, ` ${name}`) + 1;
          assert.equal(column(kiko, "Kiko"), nameAt, `${at}: Kiko's name in ${name}'s column\n${kiko}\n${line}`);
          // The icon column: the session's mark (a Nerd Font icon with the setting on), Kiko's square.
          const icon = [...line][nameAt - MARK_SLOT];
          assert.equal(column(kiko, KIKO_SQUARE), nameAt - MARK_SLOT, `${at}: the square in ${name}'s icon column`);
          assert.equal(icons === "nerd", icon !== "✻", `${at}: ${name}'s mark ${icon}`);
        }
        // The brand's square even with Nerd Font icons on, and no "Kiko." left.
        assert.ok(!lines.some((l) => l.includes("Kiko.")), at);
      }
    }
  });

  test("narrow, the name gives way as a session's does (cut with …), the square and the columns kept; no 'K.'", async () => {
    // The list at its narrowest (16 columns: window.ts LIST_WIDTH_FORMAT) has room for all of it.
    assert.equal((await list(state(), 16)).lines[0], `  0   ${KIKO_SQUARE}  Kiko`);
    assert.equal((await list(state(), 12)).lines[0], `  0   ${KIKO_SQUARE}  K…`);
    const classic = state({ window: { shown: "%1", note: "", look: "classic" } });
    assert.equal((await list(classic, 16)).lines[0], ` 0   ${KIKO_SQUARE}  Kiko`);
    // Classic at 11: Kiko's name and a session's cut alike, in one column.
    const { lines } = await list(classic, 11);
    assert.equal(lines[0], ` 0   ${KIKO_SQUARE}  K…`);
    assert.ok(lines.includes(" 1   ✻  a…"), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("K.")), lines.join("\n"));
  });

  test("the list is just as tall: Kiko's row where its name was, no line added", async () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${i + 1}`, `%${i + 1}`));
    for (const look of LOOKS) {
      const s = state({ sessions: many, window: { shown: "%1", note: "", ...(look ? { look } : {}) } });
      const { lines } = await list(s, 36, 12);
      assert.equal(lines.length, 12, `${look ?? "tiled"}: exactly the pane's rows`);
      // Top to bottom as before: Kiko's row first, the sessions from the line under the heading.
      assert.match(lines[0], new RegExp(`${KIKO_SQUARE} {2}Kiko$`));
      assert.match(lines[1], look ? /the conversation/ : /── INTERNAL/);
      // As many sessions as before: all the rows but the keys' (1), Kiko's (1 tiled, 2 classic) and the heading's (1), at one a session (two classic).
      const sessionRows = lines.filter((l) => /\bs\d+\b/.test(l)).length;
      assert.equal(sessionRows, look ? (12 - 1 - 2 - 1) / 2 : 12 - 1 - 1 - 1, `${look ?? "tiled"}: as many sessions shown as before`);
    }
  });

  test("its square pulses while Kiko listens or speaks, steady when it's idle, in both looks; with NO_COLOR a plain ▪", async () => {
    const squareOf = (raw: string) => {
      const line = raw.split("\n")[0];
      return PULSE.find((c) => line.includes(`${fg(c)}${KIKO_SQUARE}`)) ?? "none";
    };
    for (const look of LOOKS) {
      const window = { shown: "%1", note: "", ...(look ? { look } : {}) };
      const idle = await list(state({ window }), 36);
      assert.equal(squareOf(idle.raw), BRAND.accent, `${look ?? "tiled"}: steady`);
      // Listening or speaking: a step later the square is the next shade (the real clock here; the fake one above).
      for (const busy of [{ listening: true }, { speaking: true }]) {
        const t = terminal(36, 14);
        const app = render(h(WindowList, { s: state({ window, ...busy }) }), { stdout: t.stdout as never, stdin: t.stdin as never, patchConsole: false, interactive: true });
        try {
          await inkDone(app);
          const seen = new Set([squareOf(t.frame())]);
          await untilFrame(t.frame, (f) => seen.add(squareOf(f)).size >= 2, "the next shade", PULSE_MS * 3).catch(() => {});
          assert.ok(seen.size >= 2, `${look ?? "tiled"} ${JSON.stringify(busy)}: pulsed (${[...seen]})`);
        } finally {
          app.unmount();
        }
      }
    }
    process.env.NO_COLOR = "1";
    const bare = await list(state({ listening: true }), 36);
    assert.equal(bare.lines[0], `  0   ${KIKO_SQUARE}  Kiko`);
    assert.ok(!bare.raw.split("\n")[0].includes(fg(BRAND.accent)), "no colour on its square");
  });
});
