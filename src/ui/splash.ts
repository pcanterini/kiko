// The splash: Kiko's logo (./logo.ts) over the whole window as it opens, while the app loads under
// it, then the app. Only on a cold start of the window (start.ts decides: the app's first start
// there, not a restart; `kiko` again with the app running only attaches, so there's none). start.ts
// paints it from the window's first moment while the app loads (./splash-handoff.ts), and passes
// it to the app as --splash=<its first frame's time>; tui.ts draws it on from there (Splash), the
// window's list pane zoomed to the whole window for it (window-zoom.ts) and back to the list after.
// `kiko` makes the window zoomed from the start when the splash is coming (wholeFirst), so the two
// panes are never drawn before it.
//
//   0 ms        the first frame (start.ts's): the logo's rows fade in, the light sweeps, the tagline types
//   LOGO_MS     the logo at rest (about 1 s); the app takes the screen over about now
//               (start.ts's painting stopped, its last frame the app's first)
//   + holdMs    the soonest it goes: as soon as the app is ready from here (ready(): the sessions
//               looked at and the window's starting state gone, app.ts), else "Starting…" under it
//   maxMs       the latest: the app shows anyway, in its own loading state, so it never looks stuck
//
// A key pressed skips it (the app at once; one pressed before the app has the screen, once it has).
// The window too small for even the narrow logo (or
// fewer than MIN_ROWS rows): none. Pure: start.ts imports it before anything else is loaded.
import type { Clock } from "../core/clock.ts";
import type { ColorDepth } from "./cli-style.ts";
import { LOGO_MS, logoBox, logoRows, logoSize, type LogoSize } from "./logo.ts";

export const SPLASH_TIMING = {
  /** The logo at rest at least this long after its effects, before the app takes its place. */
  holdMs: 600,
  /** The app shows by now (from the first frame), ready or not. */
  maxMs: 4000,
};

/** The soonest the splash goes, after its first frame: the logo's effects, then the hold; "Starting…" from here while the app isn't ready. */
export const splashSoonest = (timing = SPLASH_TIMING) => LOGO_MS + timing.holdMs;

/** Fewer rows than this: no splash (the logo, its tagline, and the room for "Starting…"). */
export const MIN_ROWS = 10;

/** How often the effects are drawn while they play (Ink draws at most 30 frames a second: tui.ts). */
export const FRAME_MS = 33;

/** What's said under the tagline while the app takes longer than the logo. */
export const SLOW_WORDS = "Starting…";

/** The splash's logo for a window `cols` × `rows`; null: too small for one. */
export function splashFits(cols: number, rows: number): LogoSize | null {
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || rows < MIN_ROWS) return null;
  return logoSize(cols);
}

/**
 * Whether start.ts starts the app with the splash: only on the window's cold start (`cold`: the
 * app's first start in it, never a restart; `kiko` with the app running only attaches, starting
 * nothing), on a terminal, in a window big enough for the logo (`cols` × `rows`: splashFits), with
 * nothing to say first (`note`: Kiko Dev's first start) or to build (`building`: helpers out of
 * date), and not turned off (`off`: KIKO_SPLASH, "off" or "0": the live tests).
 */
export function splashWanted(o: { cold: boolean; tty: boolean; cols: number; rows: number; note?: boolean; building?: boolean; off?: string }): boolean {
  if (!o.cold || !o.tty || o.note || o.building || o.off === "off" || o.off === "0") return false;
  return splashFits(o.cols, o.rows) !== null;
}

/**
 * Whether `kiko` makes the window with its list's pane already the whole window (window.ts
 * openWindow `whole`, zoomed in the same tmux run that makes it, before the terminal attaches): when
 * the app will open with the splash (splashWanted, as `kiko` can tell it: the window made now, the
 * size it's made at, `off`), or first-run setup comes first (`firstRun`: it takes the whole window
 * too). Else the terminal drew the two panes first, then the zoom (2026-11-04). start.ts gives the
 * list its own size back when the app starts without the splash after all (Kiko Dev's first-start
 * note, helpers to build: things only it knows).
 */
export function wholeFirst(o: { cols: number; rows: number; firstRun: boolean; off?: string }): boolean {
  return o.firstRun || splashWanted({ cold: true, tty: true, cols: o.cols, rows: o.rows, off: o.off });
}

/**
 * The splash's lines for a window `cols` × `rows`, `ms` after its first frame (null: the logo at
 * rest), centred: `top` blank rows, then `lines`, each indented to the middle. The logo, a blank
 * row, the tagline, a blank row, and the row for "Starting…" (`slow`), kept empty until then so
 * nothing moves when it comes. Null when the window is too small (splashFits).
 */
export function splashBlock(cols: number, rows: number, ms: number | null, o: { slow: boolean; depth: ColorDepth }): { top: number; lines: string[] } | null {
  const size = splashFits(cols, rows);
  if (!size) return null;
  const box = logoBox(size);
  const pad = " ".repeat(Math.floor((cols - box.w) / 2));
  const slowPad = " ".repeat(Math.floor((cols - SLOW_WORDS.length) / 2));
  const slow = o.slow ? `${slowPad}${o.depth ? `\x1b[2m${SLOW_WORDS}\x1b[22m` : SLOW_WORDS}` : "";
  const lines = [...logoRows(size, ms, o.depth).map((row) => pad + row), "", slow];
  return { top: Math.max(0, Math.floor((rows - lines.length) / 2)), lines };
}

/** The whole window as the splash draws it, in plain text (trailing spaces trimmed): what tests and the frame dump look at. */
export function splashScreen(cols: number, rows: number, ms: number | null, slow = false): string[] {
  const block = splashBlock(cols, rows, ms, { slow, depth: 0 });
  const screen = Array.from({ length: rows }, () => "");
  if (!block) return screen;
  block.lines.forEach((line, i) => {
    if (block.top + i < rows) screen[block.top + i] = line.replace(/\s+$/, "");
  });
  return screen;
}

/** Why the splash went: the app ready, a key pressed (or something else asked of the window), or maxMs. */
export type SplashEnd = "ready" | "skipped" | "timeout";

export type SplashTimer = {
  /** The app is ready: the splash goes now if it's been up long enough, else once it has. */
  ready(): void;
  /** A key pressed: it goes now. */
  skip(): void;
};

/**
 * When the splash goes, counted from its first frame (`since`: now, else when start.ts painted it,
 * ./splash-handoff.ts): `hide` once, with why and how long it was up; `slow` once, when it's been up
 * long enough (the logo's effects and the hold) and the app isn't ready yet. Either at once when
 * that time has gone by already. A clock of its own for the tests (tests/support/clock.ts).
 */
export function splashTimer(clock: Clock, on: { hide(why: SplashEnd, ms: number): void; slow(): void }, o: { since?: number; timing?: typeof SPLASH_TIMING } = {}): SplashTimer {
  const timing = o.timing ?? SPLASH_TIMING;
  const start = o.since ?? clock.now();
  const soonest = splashSoonest(timing);
  const left = (ms: number) => Math.max(0, ms - (clock.now() - start));
  let ready = false;
  let done = false;
  const timers: unknown[] = [];
  const finish = (why: SplashEnd) => {
    if (done) return;
    done = true;
    for (const t of timers) clock.clearTimeout(t);
    on.hide(why, clock.now() - start);
  };
  timers.push(
    clock.setTimeout(() => {
      if (ready) finish("ready");
      else on.slow();
    }, left(soonest)),
    clock.setTimeout(() => finish("timeout"), left(timing.maxMs)),
  );
  return {
    ready() {
      if (done || ready) return;
      ready = true;
      if (clock.now() - start >= soonest) finish("ready");
    },
    skip: () => finish("skipped"),
  };
}
