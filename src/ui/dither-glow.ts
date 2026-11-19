// A dithered voice glow for the terminal: a soft light rising from the bottom edge of a band a few
// rows high, in a few drifting lobes, its height and brightness following the voice's level. Every
// pixel is on or off: the glow's brightness there against a 4×4 Bayer matrix (ordered dithering),
// which gives it its grain. A prototype (`kiko-dev _glow-demo`: ./glow-demo.ts); not in the window yet.
//
// The modes:
//   idle        nothing at level 0; a low ember when there's sound
//   listening   the lobes, rising and brightening with the level; a faint grainy line at silence
//   processing  a bright beam travelling left to right along the bottom, a tail behind it
//   speaking    calmer and lower: broad lobes breathing slowly, the level adding a little
//
// Two ways to put pixels in cells:
//   braille  U+2800–U+28FF, 2×4 dots a cell, one colour a cell (the brightest dot's shade): works
//            in every terminal, the finest grain
//   blocks   ▀ ▄ █ with a foreground and a background, 2 pixels a cell, each its own shade of a
//            gradient (dark → the colour → pale): for truecolor terminals (COLORTERM)
// chooseEncoding picks: blocks in truecolor, braille otherwise (and always without colour).
//
// Cheap: the pixel buffers and the colour codes are made once (and again on resize); a frame only
// fills them and builds its row strings. Pure: no Ink, nothing read, the time given.
import type { ColorDepth } from "./cli-style.ts";
import { to256 } from "./logo.ts";

export type GlowMode = "idle" | "listening" | "processing" | "speaking";
export type GlowEncoding = "braille" | "blocks";
type Rgb = readonly [number, number, number];

export type GlowOptions = {
  /** The band's size in terminal cells. */
  cols: number;
  rows: number;
  encoding: GlowEncoding;
  /** The terminal's colours (cli-style.ts colorDepth): 0 draws the dots alone, no colour. */
  depth: ColorDepth;
  /** The glow's colour, "#rrggbb" (Kiko's accent: logo.ts BRAND.accent). */
  color: string;
};

export type GlowFrame = {
  /** Seconds, any origin: only its changes matter (the drift, the beam, the pulse). */
  time: number;
  /** The voice's level, 0–1, already smoothed (./voice-envelope.ts). */
  level: number;
  mode: GlowMode;
};

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

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────────

/** How many shades the gradient is cut into: enough to look smooth, few enough to cache their codes. */
const SHADES = 12;

const hexRgb = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/** The gradient: a deep shade of the colour at the faintest, the colour itself, then towards white at the brightest. */
function gradient(color: string): Rgb[] {
  const c = hexRgb(color);
  const deep = mix(c, [0, 0, 0], 0.55);
  const pale = mix(c, [255, 255, 255], 0.65);
  return Array.from({ length: SHADES }, (_, i) => {
    const t = i / (SHADES - 1);
    return t < 0.55 ? mix(deep, c, t / 0.55) : mix(c, pale, (t - 0.55) / 0.45);
  });
}

const sgr = (rgb: Rgb, depth: ColorDepth, bg: boolean) => (depth === 24 ? `\x1b[${bg ? 48 : 38};2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[${bg ? 48 : 38};5;${to256(rgb)}m`);

/** A brightness as a shade of the gradient. */
const shadeOf = (b: number) => (b >= 1 ? SHADES - 1 : b <= 0 ? 0 : (b * SHADES) | 0);

// ─── The field ───────────────────────────────────────────────────────────────────────────────────

/** The lobes, along the band (0 left, 1 right): where, how wide, how strong, and how they drift and breathe. */
const LOBES = [
  { at: 0.16, width: 0.13, gain: 0.85, drift: 0.05, speed: 0.31, breath: 0.9, phase: 0.0 },
  { at: 0.42, width: 0.19, gain: 1.0, drift: 0.07, speed: 0.23, breath: 0.7, phase: 2.1 },
  { at: 0.69, width: 0.11, gain: 0.75, drift: 0.04, speed: 0.43, breath: 1.3, phase: 4.4 },
  { at: 0.88, width: 0.15, gain: 0.9, drift: 0.06, speed: 0.27, breath: 1.1, phase: 1.3 },
] as const;

/** The lobes' sum at `u` (0–1 along the band) at `t` seconds: about 0–1.2. */
function lobesAt(u: number, t: number): number {
  let sum = 0;
  for (let i = 0; i < LOBES.length; i++) {
    const l = LOBES[i];
    const centre = l.at + l.drift * Math.sin(t * l.speed * Math.PI + l.phase);
    const strength = l.gain * (0.78 + 0.22 * Math.sin(t * l.breath + l.phase * 1.7));
    const d = (u - centre) / l.width;
    sum += strength * Math.exp(-d * d);
  }
  return sum;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The beam's seconds to cross the band, and how far past each edge it starts and ends. */
const BEAM_SECONDS = 2.2;
const BEAM_OVERRUN = 0.15;

/**
 * The glow, renderer-owned buffers reused frame to frame: `render` fills a brightness for every
 * pixel, dithers it and encodes the cells. The rows it returns are reused too (copy them to keep).
 */
export class DitherGlow {
  private o: GlowOptions;
  /** Pixels across and down. */
  pw = 0;
  ph = 0;
  /** Each column's brightness at the bottom edge, and 1/height² (how fast it falls off going up). */
  private peak = new Float32Array(0);
  private fall = new Float32Array(0);
  /** Each pixel row's distance from the bottom edge, squared, as a share of the band (0 bottom, ~1 top). */
  private rise2 = new Float32Array(0);
  /** Each pixel's brightness, row by row from the top; and whether it's on. */
  private bright = new Float32Array(0);
  private on = new Uint8Array(0);
  private readonly fg: string[];
  private readonly bg: string[];
  private readonly lines: string[] = [];

  constructor(o: GlowOptions) {
    this.o = { ...o, encoding: chooseEncoding(o.depth, o.encoding) };
    const shades = gradient(o.color);
    this.fg = o.depth ? shades.map((c) => sgr(c, o.depth, false)) : [];
    this.bg = o.depth ? shades.map((c) => sgr(c, o.depth, true)) : [];
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
    this.pw = braille ? c * 2 : c;
    this.ph = braille ? r * 4 : r * 2;
    this.peak = new Float32Array(this.pw);
    this.fall = new Float32Array(this.pw);
    this.rise2 = new Float32Array(this.ph);
    for (let y = 0; y < this.ph; y++) {
      const d = (this.ph - 1 - y + 0.5) / this.ph;
      this.rise2[y] = d * d;
    }
    this.bright = new Float32Array(this.pw * this.ph);
    this.on = new Uint8Array(this.pw * this.ph);
    this.lines.length = r;
  }

  /** Whether pixel (x, y) is on after the last render; y from the top. */
  lit(x: number, y: number): boolean {
    return this.on[y * this.pw + x] === 1;
  }

  /** One frame: the band's rows, each exactly `cols` cells wide, colour reset at its end. */
  render(f: GlowFrame): readonly string[] {
    this.shape(f);
    this.dither();
    if (this.o.encoding === "braille") this.encodeBraille();
    else this.encodeBlocks();
    return this.lines;
  }

  /** Each column's peak brightness and height, for the mode. */
  private shape({ time: t, level, mode }: GlowFrame) {
    const { pw, peak, fall } = this;
    const L = clamp01(level);
    // The beam's head, from just off the left edge to just off the right one, then round again.
    const head = ((t / BEAM_SECONDS) % 1) * (1 + 2 * BEAM_OVERRUN) - BEAM_OVERRUN;
    const pulse = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI * 0.6);
    for (let x = 0; x < pw; x++) {
      const u = (x + 0.5) / pw;
      let b: number;
      let h: number;
      if (mode === "processing") {
        const d = u - head;
        const core = Math.exp(-(d * d) / 0.0025);
        const tail = d < 0 ? 0.55 * Math.exp(d / 0.2) : 0;
        b = 0.1 + 1.2 * core + tail;
        h = 0.08 + 0.42 * core + 0.18 * tail;
      } else {
        const lobes = lobesAt(u, mode === "speaking" ? t * 0.45 : t);
        const shape = lobes > 1 ? 1 : 0.32 + 0.68 * lobes;
        if (mode === "listening") {
          b = (0.17 + 1.05 * L) * shape;
          h = (0.1 + 0.95 * L) * (0.35 + 0.65 * shape);
        } else if (mode === "speaking") {
          b = (0.32 + 0.22 * pulse + 0.3 * L) * (0.55 + 0.45 * shape);
          h = (0.16 + 0.12 * pulse + 0.18 * L) * (0.5 + 0.5 * shape);
        } else {
          b = 0.6 * L * shape;
          h = (0.08 + 0.45 * L) * shape;
        }
      }
      peak[x] = b;
      fall[x] = 1 / (h * h);
    }
  }

  /** Every pixel's brightness (a gaussian falling off from the bottom edge), then on or off against the Bayer matrix (bayerThreshold, y counted up from the bottom). */
  private dither() {
    const { pw, ph, peak, fall, rise2, bright, on } = this;
    for (let y = 0; y < ph; y++) {
      const d2 = rise2[y];
      const row = y * pw;
      // The matrix counted from the bottom edge, so the edge row gets its lowest thresholds (1/32,
      // 5/32): a faint glow still shows there as a sparse line of grains.
      const ty = ((ph - 1 - y) & 3) << 2;
      for (let x = 0; x < pw; x++) {
        const p = peak[x];
        const b = p <= 0 ? 0 : p * Math.exp(-d2 * fall[x]);
        bright[row + x] = b;
        on[row + x] = b > THRESHOLDS[ty | (x & 3)] ? 1 : 0;
      }
    }
  }

  /** 2×4 pixels a cell, coloured by its brightest lit dot. */
  private encodeBraille() {
    const { pw, bright, on, fg, lines } = this;
    const { cols, rows } = this.o;
    const colour = fg.length > 0;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let current = -1;
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        let top = 0;
        for (let dy = 0; dy < 4; dy++) {
          const i = (r * 4 + dy) * pw + c * 2;
          if (on[i]) {
            bits |= BRAILLE_DOTS[dy][0];
            if (bright[i] > top) top = bright[i];
          }
          if (on[i + 1]) {
            bits |= BRAILLE_DOTS[dy][1];
            if (bright[i + 1] > top) top = bright[i + 1];
          }
        }
        if (colour && bits) {
          const shade = shadeOf(top);
          if (shade !== current) {
            s += fg[shade];
            current = shade;
          }
        }
        s += BRAILLE[bits];
      }
      lines[r] = colour ? `${s}\x1b[0m` : s;
    }
  }

  /** 1×2 pixels a cell: the top pixel in the foreground of ▀, the bottom one in its background (▄ or █ when only one, or both the same). */
  private encodeBlocks() {
    const { pw, bright, on, fg, bg, lines } = this;
    const { cols, rows } = this.o;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let curFg = -1;
      let curBg = -1; // -1: the terminal's own
      const top = r * 2 * pw;
      const bottom = top + pw;
      for (let c = 0; c < cols; c++) {
        const t = on[top + c] ? shadeOf(bright[top + c]) : -1;
        const b = on[bottom + c] ? shadeOf(bright[bottom + c]) : -1;
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
          s += wantBg < 0 ? "\x1b[49m" : bg[wantBg];
          curBg = wantBg;
        }
        if (wantFg !== curFg) {
          s += fg[wantFg];
          curFg = wantFg;
        }
        s += ch;
      }
      lines[r] = `${s}\x1b[0m`;
    }
  }
}

/** One frame, made from scratch: for tests and one-offs (an animation keeps a DitherGlow). */
export function renderGlow(o: GlowOptions & GlowFrame): string[] {
  return [...new DitherGlow(o).render(o)];
}
