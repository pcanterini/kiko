// The splash's first stage and its hand-off: start.ts paints Kiko's logo itself the moment it knows
// the splash is coming, so it starts on attach, while the app (Node, React, Ink, everything else:
// most of a second) loads. The app then takes the screen over, frame for frame: it was the whole
// window blank for that long before (2026-11-04).
//
//   start.ts                                         the app (--splash=<since>)
//   paints the splash (paintSplash), `since` its     loading…
//   first frame, on the alternate screen, every
//   FRAME_MS while its effects play
//                  ◄────── "keep\n" (fd 3) ───────   about to draw the splash itself (takeScreen)
//   stops; its last frame stays on the screen
//                  ─────── "<ms>\n" ──────────────►  draws that same frame first (tui.ts Splash),
//                                                    then on from `since`: one animation, one clock
//
// The app asks "clear" instead when it won't draw the splash (it stops first with something to
// say, it crashed, the window got too small): start.ts stops and leaves the alternate screen, for
// the cleared one under it, as the splash's screen was before. The screen is never written by both
// at once: the app writes nothing to it before the answer, and start.ts nothing after it (a write to
// a terminal is synchronous in Node and Bun: a frame is never cut in two by a request).
//
// Why the alternate screen: Ink draws on one (tui.ts), and entering it again changes nothing in
// tmux, so the logo stays up until the app's first frame is drawn over it; and what start.ts and
// the app leave on the window's own screen when the app ends is as before.
//
// The same frames: both draw splashBlock (./splash.ts: the logo, logo.ts, at its place and size) at
// the same moment of the same clock (`since`), in the same colours (cli-style.ts colorDepth, the same
// terminal and environment). Ink doesn't erase what it doesn't draw over (a line's end), so the
// app's first frame is exactly the one on the screen (`drawn`): the logo's typing cursor at a
// line's end is never left behind.
//
// Pure but for the terminal and fd 3: start.ts imports it before anything heavy is loaded.
import { closeSync, fstatSync, readSync, writeSync } from "node:fs";
import type { Clock } from "../core/clock.ts";
import { realClock } from "../core/clock.ts";
import type { ColorDepth } from "./cli-style.ts";
import { LOGO_MS } from "./logo.ts";
import { FRAME_MS, SPLASH_TIMING, splashBlock, splashSoonest } from "./splash.ts";

/** The app's end of the hand-off: its fd 3, a socket start.ts made (spawn's stdio[3], "pipe"). */
export const HANDOFF_FD = 3;

/** The app's request: draw the splash on from the frame on the screen, or not at all (the screen cleared for it). */
export type Take = "keep" | "clear";

const ESC = "\x1b[";
/** The alternate screen, in and out (tmux: entering it again while on it changes nothing). */
const ALT_ON = `${ESC}?1049h`;
const ALT_OFF = `${ESC}?1049l`;
/** Synchronized output, in and out: tmux shows a frame whole, never half drawn (Ink's frames are too). */
const SYNC_ON = `${ESC}?2026h`;
const SYNC_OFF = `${ESC}?2026l`;

/**
 * The whole splash `ms` after its first frame (null: the logo at rest), as one write: every row of
 * a window `cols` × `rows` (the rest of each erased, so nothing else stays), the cursor left home,
 * where Ink starts drawing. Exactly what tui.ts Splash draws there (splashBlock). Null when the
 * window is too small for it.
 */
export function splashFrame(cols: number, rows: number, ms: number | null, o: { slow: boolean; depth: ColorDepth }): string | null {
  const block = splashBlock(cols, rows, ms, o);
  if (!block) return null;
  let out = "";
  for (let r = 0; r < rows; r++) out += `${ESC}${r + 1};1H${block.lines[r - block.top] ?? ""}${ESC}K`;
  return `${out}${ESC}H`;
}

/** A terminal to paint on: start.ts's stdout. */
export type PaintOut = { columns: number; rows: number; write(text: string): unknown; on(event: "resize", fn: () => void): unknown; off(event: "resize", fn: () => void): unknown };

export type Painter = {
  /** Its first frame's time (the clock's): the splash's `since`, for the app. */
  since: number;
  /** Stops painting, the last frame left on the screen, or (`clear`) the alternate screen left for the cleared one under it. When the frame on the screen was drawn, after `since` (null: none, too small); the same every call. */
  stop(clear: boolean): number | null;
};

/**
 * The splash painted on `out` from now (start.ts, the app loading): the screen cleared and the
 * cursor hidden (the window's own screen, as the splash had it before), then the alternate screen,
 * the first frame at once, a frame every FRAME_MS while the effects play (each one whole:
 * synchronized), then still; "Starting…" under it from when the app's splash would say it
 * (LOGO_MS and the hold). Painted again at a new size when the window resizes; blank while it's
 * too small.
 */
export function paintSplash(out: PaintOut, o: { depth: ColorDepth; clock?: Clock; timing?: typeof SPLASH_TIMING }): Painter {
  const clock = o.clock ?? realClock;
  const soonest = splashSoonest(o.timing);
  const since = clock.now();
  let drawn: number | null = null;
  let timer: unknown = null;
  let stopped: { ms: number | null } | null = null;
  const paint = (prefix = "") => {
    const ms = clock.now() - since;
    const frame = splashFrame(out.columns, out.rows, ms < LOGO_MS ? ms : null, { slow: ms >= soonest, depth: o.depth });
    out.write(SYNC_ON + prefix + (frame ?? `${ESC}H${ESC}2J`) + SYNC_OFF);
    drawn = frame ? ms : null;
    // On while the effects play; once more for "Starting…"; then nothing changes.
    const next = ms < LOGO_MS ? FRAME_MS : ms < soonest ? soonest - ms : null;
    timer = next === null ? null : clock.setTimeout(() => paint(), next);
  };
  const resized = () => {
    if (timer) clock.clearTimeout(timer);
    paint(`${ESC}2J`);
  };
  paint(`${ESC}?25l${ESC}H${ESC}2J${ALT_ON}${ESC}H${ESC}2J`);
  out.on("resize", resized);
  return {
    since,
    stop(clear) {
      if (stopped) return stopped.ms;
      if (timer) clock.clearTimeout(timer);
      out.off("resize", resized);
      if (clear) out.write(ALT_OFF);
      stopped = { ms: drawn };
      return drawn;
    },
  };
}

/** A duplex end of the hand-off: start.ts's (spawn's stdio[3]). */
export type HandoffEnd = { on(event: "data", fn: (chunk: Buffer | string) => void): unknown; on(event: "error", fn: () => void): unknown; write(text: string): unknown };

/** start.ts's side: the app's request (keep, clear) on `end` answered: `painter` stopped, then when its frame on the screen was drawn ("-": none). */
export function answerHandoff(end: HandoffEnd, painter: Painter) {
  let heard = "";
  end.on("error", () => {});
  end.on("data", (chunk) => {
    heard += String(chunk);
    const take = /^(keep|clear)\n/.exec(heard)?.[1];
    if (!take) return;
    heard = "";
    const ms = painter.stop(take === "clear");
    end.write(`${ms ?? "-"}\n`);
  });
}

/**
 * The app's --splash argument: absent (undefined) without one; with start.ts painting it
 * (--splash=<since>), its first frame's time; plain --splash, null (the app's own first frame).
 */
export function splashArg(argv: readonly string[]): number | null | undefined {
  for (const arg of argv) {
    if (arg === "--splash") return null;
    const since = /^--splash=(\d+)$/.exec(arg)?.[1];
    if (since) return Number(since);
  }
  return undefined;
}

/** The answer, once asked: when the frame on the screen was drawn (null: none, or no painter answered). */
let taken: { ms: number | null } | null = null;
/** For sleeping a millisecond between reads, should fd 3 not block. */
const nap = new Int32Array(new SharedArrayBuffer(4));

/**
 * The app's side: the screen taken from start.ts's painting (`take`: keep its frame, or clear it),
 * before the app first writes to it. Synchronous, a fraction of a millisecond: start.ts answers
 * at once. Only the first call asks; every one returns its answer, when the frame on the screen was
 * drawn after `since` (null: none, no painter on `fd`, or none answered within `waitMs`).
 */
export function takeScreen(take: Take, fd = HANDOFF_FD, waitMs = 500): number | null {
  if (taken) return taken.ms;
  taken = { ms: null };
  try {
    // Not start.ts's socket (an fd of the app's own): left alone.
    if (!fstatSync(fd).isSocket()) return null;
  } catch {
    return null;
  }
  try {
    writeSync(fd, `${take}\n`);
    const buf = Buffer.alloc(32);
    let heard = "";
    const until = Date.now() + waitMs;
    while (!heard.includes("\n") && Date.now() < until) {
      try {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        heard += buf.toString("utf8", 0, n);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAGAIN") break;
        Atomics.wait(nap, 0, 0, 1);
      }
    }
    const ms = /^(\d+)\n/.exec(heard)?.[1];
    taken = { ms: ms === undefined ? null : Number(ms) };
  } catch {
    // No painter: nothing to take.
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  return taken.ms;
}

/**
 * The app's side, as it loads, with start.ts painting the splash: a crash takes the screen first
 * ("clear"), so what it prints lands on the window's own screen, not on the logo (what was printed
 * stays: core/running.ts afterApp "leave"). Before anything else that could fail is loaded (app.ts).
 */
export function guardHandoff(argv: readonly string[]) {
  if (typeof splashArg(argv) !== "number") return;
  process.on("uncaughtExceptionMonitor", () => void takeScreen("clear"));
}

/** For the tests: as if never asked. */
export function resetTaken() {
  taken = null;
}
