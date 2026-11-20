// The voice glow in the Kiko window (./dither-glow.ts, Voice Glow's dither look): what it shows for
// the app's state, and the loop that draws it. Where it's drawn is the look's: the classic look's
// glow pane, a borderless box over the bottom of the window under the caption (./window-classic.ts,
// src/terminals/tmux/classic.ts glowBox); the tiled look's list, a few rows above its keys
// (./window-list.ts ListGlow).
//
// The modes, from the UI store (glowMode):
//   listening   the talk key held, or hands-free taking your words: the mic's level (UiState level,
//               core/wake.ts levelOf's scale) turned up as the original turns up a mic (micLevel)
//   processing  your words being dealt with (holding, deciding) or a quick task running (checking):
//               the lobes gathered into the travelling beam
//   speaking    Kiko reading a reply aloud on this Mac (not muted, not left to a phone): the level of
//               the sound being played (setGlowSpeech: spoken-lines.ts heard()), a little softer than
//               a voice's; a gentle made-up one where the sound isn't Kiko's to measure (the macOS voice)
//   idle        anything else, the setting off, or macOS's Reduce motion on: it fades out
//
// The loop (GlowDriver) runs only while there's something to show: started when the state leaves
// idle (wake), at GLOW_FPS frames a second, and stopped once a frame idle has faded all the way
// out: no timer at all while nobody talks. Nothing here touches tmux or the terminal.
import type { UiState } from "../core/ui-store.ts";
import type { ColorDepth } from "./cli-style.ts";
import { chooseEncoding, COLORFUL, DitherGlow, GLOW_COLS, type GlowMode, type GlowPalette, LIGHT } from "./dither-glow.ts";
import { micLevel } from "./voice-envelope.ts";

/** Frames a second while it's showing: the original's motion reads smoothly from about 20. */
export const GLOW_FPS = 25;
/** Below this opacity a frame idle is the effect closed (the renderer draws nothing under it either). */
const CLOSED = 0.02;
/** Kiko's own voice a little calmer than yours. */
const SPEAKING_SOFTER = 0.7;

/** What the glow shows for the app's state now (see the header). */
export function glowMode(s: UiState): GlowMode {
  if (!s.voiceGlow || s.reduceMotion) return "idle";
  if (s.listening) return "listening";
  if (s.holding || s.deciding) return "processing";
  if (s.speaking) return s.muted || !s.macPlays ? "idle" : "speaking";
  if (s.checking) return "processing";
  return "idle";
}

/** A steady 0–1 "random" for whole number `n`. */
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** A gentle made-up voice at `t` seconds: syllables at about four a second, each its own loudness, never silent. */
export function gentleVoice(t: number): number {
  const rate = 4;
  const n = Math.floor(t * rate);
  const within = t * rate - n;
  return 0.22 + 0.22 * (0.55 + 0.45 * hash(n)) * Math.sin(Math.PI * within) ** 2;
}

// Kiko's sound's level now (0–1, the mic's scale), or null where it isn't known: the app's (app.ts).
let speechLevel: () => number | null = () => null;

/** Where Kiko's sound's level comes from (spoken-lines.ts heard()'s level; null: no sound of its own to measure). */
export function setGlowSpeech(level: () => number | null): void {
  speechLevel = level;
}

export type GlowInput = { mode: GlowMode; level: number };

/** The mode and the level to draw for `s`, `t` seconds on (any origin). `speech`: Kiko's sound's level, read only while it speaks. */
export function glowInput(s: UiState, t: number, speech: () => number | null = speechLevel): GlowInput {
  const mode = glowMode(s);
  if (mode === "listening") return { mode, level: s.micConnecting ? 0 : micLevel(s.level) };
  if (mode === "speaking") {
    const heard = speech();
    return { mode, level: heard === null ? gentleVoice(t) : micLevel(heard) * SPEAKING_SOFTER };
  }
  return { mode, level: 0 };
}

/** The palette for the window's background: the app takes it for dark (ui/marks.ts BACKGROUND). */
export const glowPalette = (background: "dark" | "light"): GlowPalette => (background === "light" ? LIGHT : COLORFUL);

/** The tiled look's band, in the list: this many rows, in a pane at least LIST_GLOW_MIN_ROWS high and LIST_GLOW_MIN_COLS wide. */
export const LIST_GLOW_ROWS = 3;
export const LIST_GLOW_MIN_ROWS = 12;
export const LIST_GLOW_MIN_COLS = 20;

/** The list's band for a pane this size (`width`: its text's), or null when it's too small for one: as wide as the text, up to the glow's natural width. */
export function listGlowSize(width: number, height: number): { cols: number; rows: number } | null {
  if (height < LIST_GLOW_MIN_ROWS || width < LIST_GLOW_MIN_COLS) return null;
  return { cols: Math.min(GLOW_COLS, width), rows: LIST_GLOW_ROWS };
}

/** Runs `tick` every `ms` until the function it gives back is called. */
export type Every = (ms: number, tick: () => void) => () => void;

const realEvery: Every = (ms, tick) => {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
};

export type GlowDriverOptions = {
  /** The band's size, in cells. */
  cols: number;
  rows: number;
  depth: ColorDepth;
  palette: GlowPalette;
  /** What to show now (glowInput, as a rule). */
  input: () => GlowInput;
  /** Each frame's rows (reused: copy them to keep them). */
  draw: (lines: readonly string[]) => void;
  /** It started (from idle): before its first frame. */
  opened?: () => void;
  /** It faded out and stopped (or was stopped): nothing more is drawn until it starts again. */
  closed?: () => void;
  fps?: number;
  /** The time, in ms (performance.now unless given), and the timer (setInterval unless given): the tests'. */
  now?: () => number;
  every?: Every;
};

/** Drivers running now, for the tests: none while nobody talks. */
let running = 0;
export const runningGlows = () => running;

/** The glow's loop: see the header. */
export class GlowDriver {
  private readonly glow: DitherGlow;
  private cancel: (() => void) | null = null;
  /** Frames drawn since it was made. */
  frames = 0;

  private readonly o: GlowDriverOptions;

  constructor(o: GlowDriverOptions) {
    this.o = { ...o };
    this.glow = new DitherGlow({ cols: o.cols, rows: o.rows, encoding: chooseEncoding(o.depth), depth: o.depth, palette: o.palette });
  }

  get running(): boolean {
    return this.cancel !== null;
  }

  /** The band's size now, in cells. */
  get cols(): number {
    return this.o.cols;
  }

  get rows(): number {
    return this.o.rows;
  }

  /** Starts the loop if there's something to show and it isn't running; else nothing. Cheap: call it at every change of state. */
  wake(): void {
    if (this.cancel || this.o.input().mode === "idle") return;
    running++;
    this.cancel = (this.o.every ?? realEvery)(1000 / (this.o.fps ?? GLOW_FPS), () => this.tick());
    this.o.opened?.();
    this.tick();
  }

  /** A new size in cells (only when it changed). */
  resize(cols: number, rows: number): void {
    if (cols === this.o.cols && rows === this.o.rows) return;
    this.o.cols = cols;
    this.o.rows = rows;
    this.glow.resize(cols, rows);
  }

  /** The loop stopped now, faded or not (`closed` told when it was running). */
  stop(): void {
    if (!this.halt()) return;
    this.o.closed?.();
  }

  private halt(): boolean {
    if (!this.cancel) return false;
    this.cancel();
    this.cancel = null;
    running--;
    return true;
  }

  private tick(): void {
    if (!this.cancel) return;
    const { mode, level } = this.o.input();
    const lines = this.glow.render({ time: (this.o.now ?? (() => performance.now()))() / 1000, level, mode });
    if (mode === "idle" && this.glow.opacity <= CLOSED) return this.stop();
    this.frames++;
    this.o.draw(lines);
  }
}
