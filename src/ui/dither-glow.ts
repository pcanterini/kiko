// A dithered voice glow for the terminal: a soft multicoloured light rising from the bottom edge of
// a band a few rows high, in seven lobes, their height and brightness following the voice's level.
// Every pixel is on or off: the glow's brightness there against a 4×4 Bayer matrix (ordered
// dithering), which gives it its grain. A prototype (`kiko-dev _glow-demo`: ./glow-demo.ts); not
// in the window yet.
//
// The look follows the "Dither" style of a web Voice Glow: its seven lobes (GLOW_LOBES), sizes and
// colours, with 4-px dither cells. One braille dot of a typical 8×16 px terminal cell is 4×4 px,
// so at its natural size (GLOW_COLS × GLOW_ROWS, 34 × 4 cells) one dot is one of its dither cells;
// a wider or narrower band fits the set to its width.
//
// The modes:
//   idle        nothing at level 0; a low ember when there's sound
//   listening   the lobes, rising and brightening with the level; a low breathing glow at silence
//   processing  a bright beam travelling left to right along the bottom, a tail behind it, in the
//               colours of the lobes it passes
//   speaking    calmer and lower: the lobes breathing, the level adding a little
//
// Colour: each lobe has its own (the palette); a pixel's is the lobes' colours blended by how much
// each lights it (squared, so the colours stay clear between lobes rather than going muddy), then
// shaded by its brightness. Exact RGB in truecolor, the nearest xterm-256 colour otherwise.
//
// Two ways to put pixels in cells:
//   braille  U+2800–U+28FF, 2×4 dots a cell, one colour a cell (its brightest dot's): works in
//            every terminal, the finest grain
//   blocks   ▀ ▄ █ with a foreground and a background, 2 pixels a cell, each its own colour: for
//            truecolor terminals (COLORTERM)
// chooseEncoding picks: blocks in truecolor, braille otherwise (and always without colour).
//
// Cheap: the buffers and each lobe's spread across the band are made once (and again on resize); a
// frame fills the brightness, dithers it and builds its row strings. Pure: no Ink, nothing read,
// the time given.
import type { ColorDepth } from "./cli-style.ts";
import { nearestXterm } from "./logo.ts";

export type GlowMode = "idle" | "listening" | "processing" | "speaking";
export type GlowEncoding = "braille" | "blocks";
export type Rgb = readonly [number, number, number];

export type GlowPalette = {
  /** One colour a lobe, in GLOW_LOBES' order (one alone colours them all). */
  colors: readonly Rgb[];
  /** What the faintest grains lean towards, and how far (0–1); the brightest likewise. */
  faint: readonly [Rgb, number];
  bright: readonly [Rgb, number];
  /** Colour boost after blending, as the original's dark theme does (1 = none): saturation around the pixel's luminance, then brightness. */
  saturation?: number;
  brightness?: number;
  /** How far the hues swing either way, in degrees, over DRIFT_SECONDS: 0 holds them. */
  drift: number;
};

export type GlowOptions = {
  /** The band's size in terminal cells. */
  cols: number;
  rows: number;
  encoding: GlowEncoding;
  /** The terminal's colours (cli-style.ts colorDepth): 0 draws the dots alone, no colour. */
  depth: ColorDepth;
  palette: GlowPalette;
};

export type GlowFrame = {
  /** Seconds, any origin: only its changes matter (the breathing, the beam, the hue's drift). */
  time: number;
  /** The voice's level, 0–1, already smoothed (./voice-envelope.ts). */
  level: number;
  mode: GlowMode;
  /** The level in GLOW_BANDS bands, low to high, each 0–1, when there's a spectrum; else made from `level`. */
  bands?: readonly number[];
};

// ─── The look ────────────────────────────────────────────────────────────────────────────────────

/**
 * The lobes in the look's own pixels: `x` the centre from the middle, `w` the width, `h` the
 * height at full level, `band` the voice band that drives it (0 low, 1 mid, 2 high). Symmetric,
 * the middle tallest, stepping down outwards; about 260 px across.
 */
export const GLOW_LOBES = [
  { x: 0, w: 74, h: 46, band: 0 },
  { x: -36, w: 54, h: 40, band: 1 },
  { x: 36, w: 54, h: 40, band: 1 },
  { x: -72, w: 48, h: 32, band: 2 },
  { x: 72, w: 48, h: 32, band: 2 },
  { x: -108, w: 42, h: 26, band: 1 },
  { x: 108, w: 42, h: 26, band: 1 },
] as const;
export const GLOW_BANDS = 3;

/** One braille dot of a typical 8×16 px cell, in the look's pixels: one of its 4-px dither cells. */
export const PX_PER_DOT = 4;
/** The band, in cells, that holds the set at its natural size (one dot, one dither cell). */
export const GLOW_COLS = 34;
export const GLOW_ROWS = 4;
/** The width the set is fitted to: the outer lobes' edges (258 px) and a little room, 272 px. */
export const GLOW_SPAN = GLOW_COLS * 2 * PX_PER_DOT;

/** The lobes' widths and heights as drawn (the look's glowWidth and glowHeight). */
const WIDTH_SCALE = 1.2;
const HEIGHT_SCALE = 1.25;
/** How soft a lobe's edge is (the look's softness): the falloff's steepness across, and (softer) going up, so a lobe's grains reach about its height. */
const SOFTNESS = 1.09;
const FALLOFF = 2 * SOFTNESS;
const FALLOFF_UP = 1.4 * SOFTNESS;
/** The field's brightness at its fullest: over 1, so the lobes' feet are solid. */
const GAIN = 1.3;
/** Listening's glow at silence (the look's idle level), and its slow pulse there (its breathe duration). */
export const IDLE_FLOOR = 0.18;
export const BREATHE_SECONDS = 5.2;
/** A full turn of the hues' drift. */
export const DRIFT_SECONDS = 8.5;

/** The colours on a dark background, one a lobe. */
export const COLORFUL: GlowPalette = {
  colors: [
    [255, 70, 120],
    [60, 190, 255],
    [175, 70, 255],
    [60, 220, 130],
    [255, 150, 40],
    [90, 100, 255],
    [40, 200, 190],
  ],
  faint: [[0, 0, 0], 0.12],
  bright: [[255, 255, 255], 0.3],
  drift: 20,
  saturation: 1.2,
  brightness: 1.1,
};

/** The colours on a light background: the faintest grains lean lighter, the brightest a little deeper. */
export const LIGHT: GlowPalette = {
  colors: [
    [255, 201, 21],
    [126, 196, 255],
    [180, 40, 230],
    [235, 100, 160],
    [255, 176, 122],
    [154, 160, 255],
    [127, 217, 238],
  ],
  faint: [[255, 255, 255], 0.25],
  bright: [[0, 0, 0], 0.12],
  drift: 40,
};

const hexRgb = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];

/** One colour, "#rrggbb", for every lobe (Kiko's accent: logo.ts BRAND.accent): deep at the faintest, pale at the brightest. */
export const monoPalette = (color: string): GlowPalette => ({ colors: [hexRgb(color)], faint: [[0, 0, 0], 0.55], bright: [[255, 255, 255], 0.65], drift: 0 });

// ─── Ordered dithering ───────────────────────────────────────────────────────────────────────────

/** The 4×4 Bayer index matrix, row by row. */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const THRESHOLDS = Float32Array.from(BAYER4, (v) => (v + 0.5) / 16);

/** The brightness a pixel at (x, y) must pass to be on: 1/32 … 31/32, tiled every 4 pixels. */
export const bayerThreshold = (x: number, y: number): number => THRESHOLDS[((y & 3) << 2) | (x & 3)];

// ─── Braille ─────────────────────────────────────────────────────────────────────────────────────

/** A braille cell's dot bits, [row][column]: dots 1 2 3 7 down the left, 4 5 6 8 down the right. */
export const BRAILLE_DOTS: readonly (readonly [number, number])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
/** A cell's character for its dot bits; no dots is a space (the empty braille cell is drawn oddly by some fonts). */
const BRAILLE = Array.from({ length: 256 }, (_, bits) => (bits === 0 ? " " : String.fromCharCode(0x2800 + bits)));

/** The braille character for a 4×2 dot pattern, [row][column], true for a raised dot. */
export function brailleOf(dots: readonly (readonly boolean[])[]): string {
  let bits = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) if (dots[r]?.[c]) bits |= BRAILLE_DOTS[r][c];
  return BRAILLE[bits];
}

// ─── Encoding ────────────────────────────────────────────────────────────────────────────────────

/** Blocks in truecolor, braille otherwise; one asked for (--braille, --blocks) is kept, but blocks need colour. */
export function chooseEncoding(depth: ColorDepth, forced?: GlowEncoding): GlowEncoding {
  if (depth === 0) return "braille";
  return forced ?? (depth === 24 ? "blocks" : "braille");
}

// ─── Colour codes ────────────────────────────────────────────────────────────────────────────────

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Packed colours' nearest xterm-256 colours, as found: cleared when it grows past CACHE_256 (the hues drift, so new ones keep coming). */
const NEAREST_256 = new Map<number, number>();
const CACHE_256 = 8192;

/** The nearest xterm-256 colour to a packed 0xrrggbb (logo.ts nearestXterm). */
export function nearest256(rgb: number): number {
  let n = NEAREST_256.get(rgb);
  if (n === undefined) {
    if (NEAREST_256.size >= CACHE_256) NEAREST_256.clear();
    n = nearestXterm((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    NEAREST_256.set(rgb, n);
  }
  return n;
}

const FG_256 = Array.from({ length: 256 }, (_, i) => `\x1b[38;5;${i}m`);
const BG_256 = Array.from({ length: 256 }, (_, i) => `\x1b[48;5;${i}m`);

/** A colour's escape code at a depth: exact RGB in truecolor, the nearest xterm-256 colour otherwise. */
export function sgrOf(rgb: number, depth: ColorDepth, bg = false): string {
  if (depth === 24) return `\x1b[${bg ? 48 : 38};2;${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}m`;
  return (bg ? BG_256 : FG_256)[nearest256(rgb)];
}

// ─── The field ───────────────────────────────────────────────────────────────────────────────────

/** Where a lobe sits in a band of `pw` × `ph` pixels: its centre, half its width and its height at full level, in pixels. */
export type LobeLayout = { cx: number; halfWidth: number; height: number };

/** The lobes fitted to a band: the set spread across GLOW_SPAN of its width, the middle one's height about 0.9 of it. */
export function layoutLobes(pw: number, ph: number): LobeLayout[] {
  const sx = pw / GLOW_SPAN;
  // At the natural size (16 dots high) the tallest is 46 × 1.25 / 4 ≈ 14.4 dots; other heights in proportion.
  const sy = ph / (GLOW_ROWS * 4) / PX_PER_DOT;
  return GLOW_LOBES.map((l) => ({ cx: pw / 2 + l.x * sx, halfWidth: (l.w * WIDTH_SCALE * sx) / 2, height: l.h * HEIGHT_SCALE * sy }));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How each band sways about the level when there's no spectrum: its own speed and phase, so the lobes don't move as one. */
const SWAY = [
  { rate: 1.7, phase: 0, depth: 0.15 },
  { rate: 2.6, phase: 1.9, depth: 0.25 },
  { rate: 3.7, phase: 4.2, depth: 0.3 },
] as const;

/** The beam's seconds to cross the band, and how far past each edge it starts and ends. */
const BEAM_SECONDS = 2.2;
const BEAM_OVERRUN = 0.15;
/** Where shading turns from leaning faint to leaning bright: the colour itself. */
const SHADE_MID = 0.55;

const LOBE_COUNT = GLOW_LOBES.length;

/**
 * The glow, renderer-owned buffers reused frame to frame: `render` fills a brightness for every
 * pixel, dithers it and encodes the cells. The rows it returns are reused too (copy them to keep).
 */
export class DitherGlow {
  private o: GlowOptions;
  /** Pixels across and down. */
  pw = 0;
  ph = 0;
  /** The lobes as laid out for this size. */
  lobes: LobeLayout[] = [];
  /** Each lobe's spread across the band, [lobe × pw]: 0–1, 1 at its centre. */
  private spread = new Float32Array(0);
  /** GAIN / the most the spreads add up to anywhere: the field's brightest at GAIN. */
  private norm = 1;
  /** This frame's: each lobe's strength, and its falloff going up, [lobe × ph] (row 0 the top). */
  private strength = new Float32Array(LOBE_COUNT);
  private rise = new Float32Array(0);
  /** For processing: each column's peak brightness and 1/height². */
  private peak = new Float32Array(0);
  private fall = new Float32Array(0);
  /** Each pixel's brightness, row by row from the top; and whether it's on. */
  private bright = new Float32Array(0);
  private on = new Uint8Array(0);
  /** This frame's lobe colours (the palette drifted), 0–255. */
  private readonly red = new Float32Array(LOBE_COUNT);
  private readonly green = new Float32Array(LOBE_COUNT);
  private readonly blue = new Float32Array(LOBE_COUNT);
  private readonly lines: string[] = [];

  constructor(o: GlowOptions) {
    this.o = { ...o, encoding: chooseEncoding(o.depth, o.encoding) };
    this.resize(o.cols, o.rows);
  }

  get encoding(): GlowEncoding {
    return this.o.encoding;
  }

  /** A new size in cells: the buffers made again (only then). */
  resize(cols: number, rows: number) {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    this.o.cols = c;
    this.o.rows = r;
    const braille = this.o.encoding === "braille";
    const pw = braille ? c * 2 : c;
    const ph = braille ? r * 4 : r * 2;
    this.pw = pw;
    this.ph = ph;
    this.lobes = layoutLobes(pw, ph);
    this.spread = new Float32Array(LOBE_COUNT * pw);
    let most = 0;
    for (let x = 0; x < pw; x++) {
      let sum = 0;
      for (let i = 0; i < LOBE_COUNT; i++) {
        const { cx, halfWidth } = this.lobes[i];
        const d = (x + 0.5 - cx) / Math.max(halfWidth, 0.5);
        const s = Math.exp(-FALLOFF * d * d);
        this.spread[i * pw + x] = s;
        sum += s;
      }
      if (sum > most) most = sum;
    }
    this.norm = most > 0 ? GAIN / most : GAIN;
    this.rise = new Float32Array(LOBE_COUNT * ph);
    this.peak = new Float32Array(pw);
    this.fall = new Float32Array(pw);
    this.bright = new Float32Array(pw * ph);
    this.on = new Uint8Array(pw * ph);
    this.lines.length = r;
  }

  /** Whether pixel (x, y) is on after the last render; y from the top. */
  lit(x: number, y: number): boolean {
    return this.on[y * this.pw + x] === 1;
  }

  /** Pixel (x, y)'s brightness after the last render, before dithering. */
  brightness(x: number, y: number): number {
    return this.bright[y * this.pw + x];
  }

  /** One frame: the band's rows, each exactly `cols` cells wide, colour reset at its end. */
  render(f: GlowFrame): readonly string[] {
    if (f.mode === "processing") this.beam(f.time);
    else this.field(f);
    this.dither();
    if (this.o.depth) this.drift(f.time);
    if (this.o.encoding === "braille") this.encodeBraille();
    else this.encodeBlocks();
    return this.lines;
  }

  /** The lobes' strengths and heights for the mode and level, then every pixel's brightness: their sum. */
  private field({ time: t, level, mode, bands }: GlowFrame) {
    const { pw, ph, lobes, spread, strength, rise, bright, norm } = this;
    const L = clamp01(level);
    const breath = 0.5 - 0.5 * Math.cos((t * 2 * Math.PI) / BREATHE_SECONDS);
    const pulse = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI * 0.6);
    for (let i = 0; i < LOBE_COUNT; i++) {
      const b = GLOW_LOBES[i].band;
      const sway = SWAY[b];
      const band = bands ? clamp01(bands[b] ?? L) : clamp01(L * (1 + sway.depth * Math.sin(t * sway.rate + sway.phase)));
      let a: number;
      let h: number;
      if (mode === "listening") {
        const e = IDLE_FLOOR * (0.8 + 0.4 * breath) + (1 - IDLE_FLOOR) * band;
        a = 0.2 + 0.9 * e;
        h = e;
      } else if (mode === "speaking") {
        a = 0.35 + 0.15 * pulse + 0.25 * band;
        h = 0.22 + 0.1 * pulse + 0.18 * band;
      } else {
        a = 0.6 * band;
        h = 0.1 + 0.35 * band;
      }
      strength[i] = a * norm;
      const k = FALLOFF_UP / Math.max(lobes[i].height * h, 0.25) ** 2;
      for (let y = 0; y < ph; y++) {
        const up = ph - 1 - y + 0.5;
        rise[i * ph + y] = Math.exp(-k * up * up);
      }
    }
    for (let y = 0; y < ph; y++) {
      const row = y * pw;
      for (let x = 0; x < pw; x++) {
        let sum = 0;
        for (let i = 0; i < LOBE_COUNT; i++) sum += strength[i] * spread[i * pw + x] * rise[i * ph + y];
        bright[row + x] = sum;
      }
    }
  }

  /** Processing: a beam with a tail along the bottom; the lobes only colour it (each at full strength, all the way up). */
  private beam(t: number) {
    const { pw, ph, peak, fall, rise, strength, bright } = this;
    strength.fill(1);
    rise.fill(1);
    // The head, from just off the left edge to just off the right one, then round again.
    const head = ((t / BEAM_SECONDS) % 1) * (1 + 2 * BEAM_OVERRUN) - BEAM_OVERRUN;
    for (let x = 0; x < pw; x++) {
      const d = (x + 0.5) / pw - head;
      const core = Math.exp(-(d * d) / 0.0025);
      const tail = d < 0 ? 0.55 * Math.exp(d / 0.2) : 0;
      peak[x] = 0.1 + 1.2 * core + tail;
      const h = 0.08 + 0.42 * core + 0.18 * tail;
      fall[x] = 1 / (h * h);
    }
    for (let y = 0; y < ph; y++) {
      const up = (ph - 1 - y + 0.5) / ph;
      const up2 = up * up;
      const row = y * pw;
      for (let x = 0; x < pw; x++) bright[row + x] = peak[x] * Math.exp(-up2 * fall[x]);
    }
  }

  /** Every pixel on or off against the Bayer matrix (bayerThreshold, y counted up from the bottom). */
  private dither() {
    const { pw, ph, bright, on } = this;
    for (let y = 0; y < ph; y++) {
      const row = y * pw;
      // The matrix counted from the bottom edge, so the edge row gets its lowest thresholds (1/32,
      // 5/32): a faint glow still shows there as a sparse line of grains.
      const ty = ((ph - 1 - y) & 3) << 2;
      for (let x = 0; x < pw; x++) on[row + x] = bright[row + x] > THRESHOLDS[ty | (x & 3)] ? 1 : 0;
    }
  }

  /** This frame's lobe colours: the palette, its hues turned by the drift (a hue rotation keeping the lightness). */
  private drift(t: number) {
    const { colors, drift } = this.o.palette;
    const angle = drift ? ((drift * Math.PI) / 180) * Math.sin((t * 2 * Math.PI) / DRIFT_SECONDS) : 0;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let i = 0; i < LOBE_COUNT; i++) {
      const [r, g, b] = colors[i % colors.length];
      if (!angle) {
        this.red[i] = r;
        this.green[i] = g;
        this.blue[i] = b;
        continue;
      }
      this.red[i] = (0.213 + 0.787 * c - 0.213 * s) * r + (0.715 - 0.715 * c - 0.715 * s) * g + (0.072 - 0.072 * c + 0.928 * s) * b;
      this.green[i] = (0.213 - 0.213 * c + 0.143 * s) * r + (0.715 + 0.285 * c + 0.14 * s) * g + (0.072 - 0.072 * c - 0.283 * s) * b;
      this.blue[i] = (0.213 - 0.213 * c - 0.787 * s) * r + (0.715 - 0.715 * c + 0.715 * s) * g + (0.072 + 0.928 * c + 0.072 * s) * b;
    }
  }

  /**
   * Pixel (x, y)'s colour, packed 0xrrggbb: the lobes' colours weighted by how much each lights it,
   * squared (so a lobe's own colour holds near it and the blend is short between), then shaded.
   */
  colorAt(x: number, y: number): number {
    const { pw, ph, strength, spread, rise, red, green, blue } = this;
    let r = 0;
    let g = 0;
    let b = 0;
    let sum = 0;
    for (let i = 0; i < LOBE_COUNT; i++) {
      const w0 = strength[i] * spread[i * pw + x] * rise[i * ph + y];
      const w = w0 * w0;
      r += w * red[i];
      g += w * green[i];
      b += w * blue[i];
      sum += w;
    }
    if (sum > 1e-30) {
      r /= sum;
      g /= sum;
      b /= sum;
    } else {
      // Too far from every lobe for the weights to register: the nearest lobe's.
      let best = 0;
      for (let i = 1; i < LOBE_COUNT; i++) if (Math.abs(this.lobes[i].cx - x) < Math.abs(this.lobes[best].cx - x)) best = i;
      [r, g, b] = [red[best], green[best], blue[best]];
    }
    const { faint, bright, saturation = 1, brightness = 1 } = this.o.palette;
    if (saturation !== 1 || brightness !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = (l + (r - l) * saturation) * brightness;
      g = (l + (g - l) * saturation) * brightness;
      b = (l + (b - l) * saturation) * brightness;
    }
    const v = this.bright[y * pw + x];
    const [[tr, tg, tb], amount] = v < SHADE_MID ? faint : bright;
    const k = v < SHADE_MID ? amount * (1 - v / SHADE_MID) : amount * clamp01((v - SHADE_MID) / (1 - SHADE_MID));
    r += (tr - r) * k;
    g += (tg - g) * k;
    b += (tb - b) * k;
    return pack(clamp255(r), clamp255(g), clamp255(b));
  }

  /** 2×4 pixels a cell, coloured by its brightest lit dot. */
  private encodeBraille() {
    const { pw, bright, on, lines } = this;
    const { cols, rows, depth } = this.o;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let current = -1;
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        let top = -1;
        let at = 0;
        for (let dy = 0; dy < 4; dy++) {
          const i = (r * 4 + dy) * pw + c * 2;
          if (on[i]) {
            bits |= BRAILLE_DOTS[dy][0];
            if (bright[i] > top) [top, at] = [bright[i], i];
          }
          if (on[i + 1]) {
            bits |= BRAILLE_DOTS[dy][1];
            if (bright[i + 1] > top) [top, at] = [bright[i + 1], i + 1];
          }
        }
        if (depth && bits) {
          const rgb = this.colorAt(at % pw, (at / pw) | 0);
          if (rgb !== current) {
            s += sgrOf(rgb, depth);
            current = rgb;
          }
        }
        s += BRAILLE[bits];
      }
      lines[r] = depth ? `${s}\x1b[0m` : s;
    }
  }

  /** 1×2 pixels a cell: the top pixel in the foreground of ▀, the bottom one in its background (▄ or █ when only one, or both the same). */
  private encodeBlocks() {
    const { pw, on, lines } = this;
    const { cols, rows, depth } = this.o;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let curFg = -1;
      let curBg = -1; // -1: the terminal's own
      const top = r * 2;
      for (let c = 0; c < cols; c++) {
        const t = on[top * pw + c] ? this.colorAt(c, top) : -1;
        const b = on[(top + 1) * pw + c] ? this.colorAt(c, top + 1) : -1;
        // The glyph, and the colours it wants (-1 for the terminal's background).
        let ch = "▀";
        let wantFg = t;
        let wantBg = -1;
        if (t < 0 && b < 0) {
          ch = " ";
          wantFg = curFg;
        } else if (t === b) ch = "█";
        else if (t < 0) {
          ch = "▄";
          wantFg = b;
        } else if (b >= 0) wantBg = b;
        if (wantBg !== curBg) {
          s += wantBg < 0 ? "\x1b[49m" : sgrOf(wantBg, depth, true);
          curBg = wantBg;
        }
        if (wantFg !== curFg) {
          s += sgrOf(wantFg, depth);
          curFg = wantFg;
        }
        s += ch;
      }
      lines[r] = `${s}\x1b[0m`;
    }
  }
}

const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** One frame, made from scratch: for tests and one-offs (an animation keeps a DitherGlow). */
export function renderGlow(o: GlowOptions & GlowFrame): string[] {
  return [...new DitherGlow(o).render(o)];
}
