// A dithered voice glow for the terminal: Voice Glow's "dither" look, ported. A broad mound of
// light rising from the bottom edge in seven coloured lobes that ripple and drift with the voice,
// a thin multicoloured band hugging the edge, the whole sampled on a grid of small square pixels,
// each on or off by a 4×4 ordered dither and its colour cut to a few levels. A prototype
// (`kiko-dev _glow-demo`: ./glow-demo.ts); not in the window yet.
//
// Ported from voice-glow 0.5.0, the MIT-licensed open-source package of Libraries.dev
// (https://github.com/Jakubantalik/Libraries.dev, packages/voice-glow), its free "dither" look only:
//   src/styles.ts      the lobes (voiceLobes, LOBE_SPACING), the palettes, the theme presets
//   src/presets.ts     the geometry defaults and the dither's own tuning (resolveVoiceDefaults)
//   src/VoiceBeam.tsx  the band colours, the props' defaults and how `scale` multiplies them
//   src/voiceDriver.ts the per-frame motion: envelope, breathing, flow, bend, band line, gather, hue drift
//   src/pixel.ts       the pixel engine: lobe field, range mask, band, comet lean, dust, dither, colour
// The input chain (shape, follow, the gain) is in ./voice-envelope.ts. Left out: the pointer's
// magnet and the pixels flying to a button (no pointer here), the halo (a blur: see below), and
// nothing of Libraries Pro (its mosaic, dots and lines looks, emotion, transcript).
// The processing beam's motion (how far it's gathered, where it travels) is Kiko's own here: in the
// original a Pro state drives it; the gather, comet and dust it drives are the open package's.
//
// Copyright (c) 2026 Jakub Antalik
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// In the terminal. The original paints a host element in CSS px; here the host is the band of
// cells, one braille dot (or, with blocks, one half-block) one dither pixel. The look is the
// dither as tuned on its `mobile` host, the bottom of a ~400 px phone screen (GLOW_HOST): the one
// on Libraries.dev, a dome over seven lobes taller than the range they're masked to, so its top
// thins out into scattered pixels. Its natural size (GLOW_COLS × GLOW_ROWS) is that host's width at
// its cell pitch (3.2 px), tall enough for its glow at full voice; a shorter band lowers the reach
// to fit (reachFor), and a wider one is a wider host with the same glow in its middle.
//
// The modes:
//   listening   the voice glow: the lobes rising, spreading and flowing with the level, breathing
//               at silence (the original's own idle)
//   processing  the lobes gathered into one beam travelling side to side, leaning into where
//               it's heading like a comet and leaving a trail of dust
//   speaking    the voice glow following Kiko's voice
//   idle        the effect closed: it fades out (and in again), as the original's does
//
// What a terminal can't do the same, and what stands in for it:
//   - pixel size: lit pixels are squares a little smaller than their cell, those left off show as
//     a faint grid of tiny ones (the "ghosts"). A braille dot has one size, so a lit pixel is a
//     dot in its colour and the ghosts a sparse grid (one dot in four) in their faint one, only in
//     cells with nothing lit (a cell has one colour: the average of its lit dots').
//   - the halo: a blurred copy of the picture beneath it; a cell's background is too coarse for a
//     blur, so there is none.
//   - opacity: a colour is mixed towards the background (assumed black, or white with LIGHT).
//
// Pure: no Ink, nothing read; the time is given. Buffers are made once (and again on resize).
import type { ColorDepth } from "./cli-style.ts";
import { nearestXterm } from "./logo.ts";
import { follow, shape, VOICE_INPUT } from "./voice-envelope.ts";

export type GlowMode = "idle" | "listening" | "processing" | "speaking";
export type GlowEncoding = "braille" | "blocks";
export type Rgb = readonly [number, number, number];

/** The colours: the original's palette for a theme, and its filter (hue drift, brightness, saturation). */
export type GlowPalette = {
  /** What the glow sits on: a dark or a light background. */
  theme: "dark" | "light";
  /** One colour a lobe, in VOICE_LOBES' order (one alone colours them all). */
  colors: readonly Rgb[];
  /** The band's colours: its core, the fringe above it and the one below. */
  band: { core: Rgb; above: Rgb; below: Rgb };
  /** The stylesheet's filter on every colour: brightness, then saturation. */
  brightness: number;
  saturation: number;
  /** The hue's drift: how far either way (degrees; 0 holds it), a full swing's seconds, and where it's centred. */
  hueRange: number;
  hueDuration: number;
  hueBase: number;
  /** The whole effect's opacity (the theme's strength). */
  strength: number;
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
  /** Seconds, any origin: the frame's step is the change since the last (held under 0.05 s, as the original's). */
  time: number;
  /**
   * The voice as the original's source gives it: a plain level 0–1 (the demo's script), or a mic's
   * RMS turned up by BASE_GAIN × sensitivity (voice-envelope.ts micLevel). Shaped and followed here.
   */
  level: number;
  mode: GlowMode;
  /** The level in its three voice bands (low, mid, high), raw likewise, when there's a spectrum; else made from `level`. */
  bands?: readonly number[];
};

// ─── The look (src/styles.ts, src/presets.ts, src/VoiceBeam.tsx) ────────────────────────────────

/**
 * The lobes, in px for a ~350 px host: `x` the resting offset from the centre, `w` and `h` the
 * ellipse's radii before the layer's scale, `band` the voice band that lifts it (0 low, 1 mid,
 * 2 high). The centre one follows the lows, its neighbours the mids, the next pair the highs.
 */
export const VOICE_LOBES = [
  { x: 0, w: 74, h: 46, band: 0 },
  { x: -36, w: 54, h: 40, band: 1 },
  { x: 36, w: 54, h: 40, band: 1 },
  { x: -72, w: 48, h: 32, band: 2 },
  { x: 72, w: 48, h: 32, band: 2 },
  { x: -108, w: 42, h: 26, band: 1 },
  { x: 108, w: 42, h: 26, band: 1 },
] as const;
/** The ring the lobes flow around: 36 px between neighbours, one full turn. */
export const LOBE_SPAN = 36 * VOICE_LOBES.length;
const LOBES = VOICE_LOBES.length;

/** The colourful palette on a dark background, through the phone's filter (its brightness 1.2 and saturation 1.5 over the dark theme's 1.1 and 1.2). */
export const COLORFUL: GlowPalette = {
  theme: "dark",
  colors: [
    [255, 70, 120],
    [60, 190, 255],
    [175, 70, 255],
    [60, 220, 130],
    [255, 150, 40],
    [90, 100, 255],
    [40, 200, 190],
  ],
  band: { core: [255, 255, 255], above: [255, 70, 80], below: [80, 140, 255] },
  brightness: 1.2,
  saturation: 1.5,
  hueRange: 24,
  hueDuration: 12,
  hueBase: 0,
  strength: 1,
};

/** The colourful palette on a light background, the light theme's filter, at the phone's full strength. */
export const LIGHT: GlowPalette = {
  theme: "light",
  colors: [
    [255, 201, 21],
    [126, 196, 255],
    [180, 40, 230],
    [235, 100, 160],
    [255, 176, 122],
    [154, 160, 255],
    [127, 217, 238],
  ],
  band: { core: [197, 139, 255], above: [255, 122, 182], below: [45, 255, 171] },
  brightness: 0.95,
  saturation: 1.6,
  hueRange: 40,
  hueDuration: 8.5,
  hueBase: 5,
  strength: 1,
};

const hexRgb = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];

/** One colour, "#rrggbb", for every lobe and the band's fringes (Kiko's accent: logo.ts BRAND.accent), held still: the original's custom colours and band colours, with static colours. */
export const monoPalette = (color: string): GlowPalette => {
  const c = hexRgb(color);
  return { ...COLORFUL, colors: [c], band: { core: [255, 255, 255], above: c, below: c }, hueRange: 0 };
};

/** The geometry a type preset and a look can tune (src/presets.ts VoiceGeometry, the fields the pixel looks read). */
type Geometry = {
  scale: number;
  idle: number;
  reach: number;
  spread: number;
  flow: number;
  bend: number;
  bandStrength: number;
  bandWidth: number;
  bandPosition: number;
  bandCurve: number;
  bandSpread: number;
  bandSkew: number;
  bandOffset: number;
  bandTail: number;
  bandTailPosition: number;
  bandTailCurve: number;
  bandTailOverflow: number;
  bandAberration: number;
  glowWidth: number;
  glowHeight: number;
  lobeSpacing: number;
  rangeWidth: number;
  rangeHeight: number;
  softness: number;
  innerHeight: number;
  bloomScale: number;
  bloomHeight: number;
  pixelSize: number;
};

/** The `default` type: a ~350 px chat input (voiceDefaults). */
const DEFAULT_TYPE: Geometry = {
  scale: 1,
  idle: VOICE_INPUT.idle,
  reach: 1.2,
  spread: 1.05,
  flow: 48,
  bend: 60,
  bandStrength: 1.55,
  bandWidth: 2.15,
  bandPosition: 0.35,
  bandCurve: 1.75,
  bandSpread: 0.87,
  bandSkew: 0.12,
  bandOffset: -27,
  bandTail: 0.59,
  bandTailPosition: 0.67,
  bandTailCurve: 2.4,
  bandTailOverflow: 15,
  bandAberration: 0.89,
  glowWidth: 0.65,
  glowHeight: 1.25,
  lobeSpacing: 0.85,
  rangeWidth: 0.75,
  rangeHeight: 1,
  softness: 1.07,
  innerHeight: 1,
  bloomScale: 1,
  bloomHeight: 1,
  pixelSize: 1,
};

/** The `mobile` type's own (voiceTypePresets.mobile, the fields here): the phone the pixel looks were tuned on. */
const MOBILE_TYPE: Partial<Geometry> = {
  scale: 1.25,
  spread: 0.45,
  reach: 3,
  flow: 60,
  bend: 70,
  bandWidth: 2.4,
  bandCurve: 1.55,
  bandSpread: 0.9,
  bandOffset: -50,
  bandTail: 0.62,
  bandTailPosition: 0.42,
  bandTailCurve: 2.7,
  bandTailOverflow: 22,
  bandStrength: 1.8,
  glowWidth: 1.15,
  glowHeight: 2.1,
  lobeSpacing: 1.35,
  rangeWidth: 1.25,
  rangeHeight: 1.2,
  softness: 1.1,
};

/** The pixel looks' tuning on the phone, and the dither's on top of it (PIXEL_LOOK_MOBILE, DITHER_LOOK_MOBILE). */
const DITHER_TUNING: Partial<Geometry> = {
  scale: 1.05,
  spread: 0.6,
  bandPosition: 0.44,
  glowWidth: 1.2,
  rangeHeight: 0.85,
  softness: 1.09,
  innerHeight: 1.2,
  bloomHeight: 0.35,
  bend: 68,
  bandStrength: 1.3,
  bandWidth: 2.45,
  bandSkew: 0,
};

/** The dither's own values per host, over everything above (DITHER_TYPE): the chat input's cell size; the phone's whole tuning. */
const DITHER_TYPE: Record<GlowHost, Partial<Geometry>> = {
  default: { pixelSize: 0.85 },
  mobile: {
    scale: 1,
    spread: 0.9,
    flow: 56,
    bend: 19,
    bandStrength: 1.05,
    bandWidth: 3,
    bandPosition: 0.5,
    bandTailPosition: 0.21,
    glowWidth: 1.6,
    glowHeight: 3,
    lobeSpacing: 1.2,
    softness: 0.84,
    innerHeight: 1.6,
    bloomHeight: 0.3,
  },
};

/**
 * The original's hosts: `default` a ~350 px chat input, `mobile` the bottom of a ~400 px phone
 * screen. The dither was tuned by hand on the phone, and the look Kiko follows is that one.
 */
export type GlowHost = "default" | "mobile";
export const GLOW_HOST: GlowHost = "mobile";

/** A host's type preset with the theme's own (resolveTypeDefaults): the light chat input is taller and narrower, and the band on white stronger. */
function typeGeometry(host: GlowHost, theme: "dark" | "light"): Geometry {
  const preset = host === "mobile" ? MOBILE_TYPE : {};
  const light: Partial<Geometry> = theme === "light" ? { ...(preset.reach === undefined ? { reach: 1.8 } : {}), ...(preset.spread === undefined ? { spread: 0.8 } : {}) } : {};
  return { ...DEFAULT_TYPE, ...light, ...preset, ...(theme === "light" ? { bandStrength: 1.7 } : {}) };
}

/**
 * The dither's geometry for a host and theme (resolveVoiceDefaults(host, theme, 'dither')): on the
 * dark phone its tuning exactly; elsewhere the same changes carried over as ratios to the phone's
 * own values (an absolute where the phone's is 0); then the host's own.
 */
export function ditherGeometry(host: GlowHost, theme: "dark" | "light"): Geometry {
  const g = typeGeometry(host, theme);
  if (host === "mobile" && theme === "dark") return { ...g, ...DITHER_TUNING, ...DITHER_TYPE[host] };
  const phone = typeGeometry("mobile", "dark");
  const out: Geometry = { ...g };
  for (const key of Object.keys(DITHER_TUNING) as (keyof Geometry)[]) {
    const want = DITHER_TUNING[key] as number;
    out[key] = phone[key] ? Math.round(g[key] * (want / phone[key]) * 1000) / 1000 : want;
  }
  return { ...out, ...DITHER_TYPE[host] };
}

/** The driver's settings: the geometry with `scale` multiplied into its px values, as VoiceBeam does. */
type Config = Geometry & {
  /** How long processing's dust lingers, s (pixelDust), and how much the field dips to its sides (pixelDome). */
  pixelDust: number;
  pixelDome: number;
};

function configOf(host: GlowHost, theme: "dark" | "light"): Config {
  const d = ditherGeometry(host, theme);
  const sc = d.scale;
  return {
    ...d,
    flow: d.flow * sc,
    bend: d.bend * sc,
    bandWidth: d.bandWidth * sc,
    bandOffset: d.bandOffset * sc,
    bandTailOverflow: d.bandTailOverflow * sc,
    glowWidth: d.glowWidth * sc,
    glowHeight: d.glowHeight * sc,
    lobeSpacing: d.lobeSpacing * sc,
    rangeWidth: d.rangeWidth * sc,
    rangeHeight: d.rangeHeight * sc,
    pixelDust: host === "mobile" ? 1.5 : 1.1,
    pixelDome: host === "mobile" ? 0.6 : 0,
  };
}

/** A dither pixel's pitch at scale 1, px (DITHER_CELL); the chat input's is this × √scale × pixelSize. */
const DITHER_CELL = 3.2;
/** The pitch the band is laid out at: one braille dot. */
export const CELL_PX = DITHER_CELL * Math.sqrt(configOf(GLOW_HOST, "dark").scale) * configOf(GLOW_HOST, "dark").pixelSize;
/** The natural size, in cells: the phone's ~400 px across, and tall enough for its glow at full voice (about 48 dots). */
export const GLOW_COLS = Math.round(400 / CELL_PX / 2);
export const GLOW_ROWS = 12;

/**
 * The reach for a band `rows` high: the original's as it is at GLOW_ROWS or more; lower in a
 * shorter band, so the glow at full voice still fits under its top (its height goes with
 * 0.5 + reach), as a host sets `reach` for its own height.
 */
export function reachFor(reach: number, rows: number): number {
  const k = Math.min(1, rows / GLOW_ROWS);
  return Math.max(0.2, (0.5 + reach) * k - 0.5);
}
/** The host the band is the bottom of, px: a phone screen. Only its ceiling's cap reads it (the band line's apex is held under 0.82 of it). */
export const HOST_HEIGHT = 700;

// ─── The motion (src/voiceDriver.ts) ─────────────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;
const CEILING_HALF_WIDTH = 170;
const CEILING_HEIGHT = 64;
const BAND_SAMPLES = 56;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** A lobe offset wrapped into [-span/2, span/2). */
const wrapX = (x: number, span: number) => ((((x + span / 2) % span) + span) % span) - span / 2;

/** How much of a lobe shows at offset x: full at the centre, gone at the wrap, so none pops across. */
function edgeEnvelope(x: number, span: number): number {
  const t = x / (span / 2 + 4);
  return Math.max(0, 1 - t * t);
}

/** The band's bell, 1 at the centre and 0 at the ends: exp(-(|t|/σ)^p) with its tail taken out; `skew` widens one side. */
function bell(t: number, p: number, sigma: number, skew: number): number {
  const s = Math.max(0.05, sigma * (t < 0 ? 1 - skew : 1 + skew));
  const v = Math.exp(-((Math.abs(t) / s) ** p));
  const tail = Math.exp(-((1 / s) ** p));
  return Math.max(0, (v - tail) / (1 - tail));
}

/** The band's ends rising again towards the corners: from `position` of the way out, to `lift` at the edge. */
function tailLift(dist: number, edge: number, lift: number, position: number, curve: number): number {
  if (lift <= 0 || edge <= 0) return 0;
  const start = edge * Math.max(0, Math.min(0.98, position));
  if (dist <= start) return 0;
  const u = Math.min(1, (dist - start) / Math.max(1, edge - start));
  return lift * u ** Math.max(0.5, curve);
}

/** 0 at phase 0 and 1, 1 at 0.5, eased. */
const pingPong = (phase: number) => (1 - Math.cos(TWO_PI * phase)) / 2;

// ─── The pixels (src/pixel.ts) ───────────────────────────────────────────────────────────────────

/** Colour levels per channel; the ordered dither spreads the steps between them. */
const DITHER_LEVELS = 6;
/** The faint grid of pixels left off, as a share of a lit pixel's opacity. */
const GHOST_ALPHA = 0.16;
/** How far a lobe's pull on the colour reaches, in its own radii; the saturation given back after blending. */
const HUE_REACH = 0.62;
const HUE_VIVID = 1.35;
/** How far the band's colour wins over the lobes' where it's lit. */
const BAND_PULL = 2.5;
/** How strongly processing's beam turns into a comet at full speed. */
const LEAN = 0.5;
/** How bright a pixel must be lit to leave processing's dust. */
const DUST_MIN_V = 0.3;

/** The 4×4 Bayer index matrix, row by row. */
export const BAYER4: readonly number[] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const THRESHOLDS = Float32Array.from(BAYER4, (v) => (v + 0.5) / 16);

/** The Bayer threshold at column x, row y: 1/32 … 31/32, tiled every 4. */
export const bayerThreshold = (x: number, y: number): number => THRESHOLDS[((y & 3) << 2) | (x & 3)];

/** Whether a pixel of brightness `v` (already lifted) is on at threshold `t`: the original's rule. */
export const ditherOn = (v: number, t: number): boolean => v >= t * 0.92 + 0.03;

/** The brightness lift: the glow's soft edges still read as scattered pixels. */
export const lifted = (raw: number): number => Math.min(1, raw ** 0.65 * 1.15);

/** A fixed 0–1 value per cell, so its choices hold from frame to frame. */
function hash(c: number, r: number): number {
  let h = Math.imul(c, 0x27d4eb2d) ^ Math.imul(r, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function hueMatrix(deg: number): number[] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213,
    0.715 - c * 0.715 - s * 0.715,
    0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143,
    0.715 + c * 0.285 + s * 0.14,
    0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787,
    0.715 - c * 0.715 + s * 0.715,
    0.072 + c * 0.928 + s * 0.072,
  ];
}

function saturateMatrix(s: number): number[] {
  return [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
}

function apply(m: number[], r: number, g: number, b: number, out: Float32Array, at: number): void {
  out[at] = clamp01(m[0] * r + m[1] * g + m[2] * b);
  out[at + 1] = clamp01(m[3] * r + m[4] * g + m[5] * b);
  out[at + 2] = clamp01(m[6] * r + m[7] * g + m[8] * b);
}

/** An RGB colour (0–255) through the stylesheet's filter chain: hue-rotate, brightness, saturate; 0–1 into `out` at `at`. */
function filtered(rgb: Rgb, hue: number[], sat: number[], brightness: number, out: Float32Array, at: number, tmp: Float32Array): void {
  apply(hue, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, tmp, 0);
  apply(sat, Math.min(1, tmp[0] * brightness), Math.min(1, tmp[1] * brightness), Math.min(1, tmp[2] * brightness), out, at);
}

// ─── Encoding ────────────────────────────────────────────────────────────────────────────────────

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

/** Braille unless blocks are asked for; blocks need colour (each half its own), so without it braille. */
export function chooseEncoding(depth: ColorDepth, forced?: GlowEncoding): GlowEncoding {
  if (depth === 0) return "braille";
  return forced ?? "braille";
}

const pack = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
const clamp255 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

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

// ─── The glow ────────────────────────────────────────────────────────────────────────────────────

/** What a pixel is after a frame: nothing, lit, a ghost of the faint grid, or processing's dust. */
export const PIXEL = { none: 0, lit: 1, ghost: 2, dust: 3 } as const;

/** Processing's beam: how much faster than the voice glow it gathers and lets go (s), its swing's seconds, the level it's held at. */
const GATHER_TAU = 0.25;
const SWING_SECONDS = 4.4;
const HELD_LEVEL = 0.6;
/** The fade in and out (the original's 0.6 s and 0.5 s). */
const FADE_IN = 0.6;
const FADE_OUT = 0.5;

/**
 * The glow, renderer-owned buffers reused frame to frame: `render` steps the motion, samples every
 * pixel, dithers it and encodes the cells. The rows it returns are reused too (copy them to keep).
 */
export class DitherGlow {
  private o: GlowOptions;
  private config: Config;
  private readonly baseReach: number;
  /** The grid: pixels across and down and their pitch (px); the host it's the bottom of (px), and its rows above the grid. */
  pw = 0;
  ph = 0;
  cell = CELL_PX;
  cw = 0;
  ch = 0;
  private above = 0;
  /** Each pixel after a frame: PIXEL's kind, colour (0xrrggbb, before opacity) and alpha. */
  private kind = new Uint8Array(0);
  private rgb = new Int32Array(0);
  private alpha = new Float32Array(0);
  /** Each pixel's brightness after a frame (lifted, 0–1), 0 where nothing reached. */
  private value = new Float32Array(0);
  /** Processing's dust: each pixel's charge (0–1, fading) and colour. */
  private dust = new Float32Array(0);
  private dustC = new Int32Array(0);
  private dustAny = false;
  private readonly lines: string[] = [];

  // The motion's state (voiceDriver.ts VoiceState) and the beam's.
  /** The followed level and bands; the flow's phase (px); the own clock; the gather. */
  level = 0;
  private readonly bands = [0, 0, 0];
  private phase = 0;
  private t = 0;
  private lastTime: number | undefined;
  gather = 0;
  private swing = 0;
  /** The fade, 0–1 (eased into the opacity). */
  private fade = 0;
  private travelX = Number.NaN;
  private travelV = 0;

  // This frame's (drawPixels' per-frame scratch).
  readonly lobeX = new Float32Array(LOBES);
  readonly lobeL = new Float32Array(LOBES);
  private readonly lobeRgb = new Float32Array(LOBES * 3);
  private readonly lobeIrx = new Float32Array(LOBES);
  private readonly lobeIry = new Float32Array(LOBES);
  private readonly hues = new Float32Array(LOBES);
  private readonly bandRgb = new Float32Array(9);
  private readonly bandYs = new Float32Array(BAND_SAMPLES + 1);
  private readonly bandPull = new Float32Array(3);
  private readonly mix = new Float32Array(3);
  private readonly tmp = new Float32Array(3);
  private bandX0 = 0;
  private bandStep = 1;
  private bandAlpha = 0;
  private bandSigma = 1;
  private bandDy = 0;
  private bandEnds = 0.18;
  private bandV = 0;
  private domeK = 0;
  private domeCx = 0;
  private domeIhw = 0;
  private leanCx = 0;
  private leanDir = 0;
  private leanW = 0;
  private leanTail = 1;
  private fadeR = 0.7;
  private beamX = 0;
  private cy = 0;
  private mrx = 1;
  private mry = 1;
  /** The opacity this frame: the fade eased, times the palette's strength. */
  opacity = 0;

  constructor(o: GlowOptions) {
    this.o = { ...o, encoding: chooseEncoding(o.depth, o.encoding) };
    this.config = configOf(GLOW_HOST, o.palette.theme);
    this.baseReach = this.config.reach;
    this.resize(o.cols, o.rows);
  }

  get encoding(): GlowEncoding {
    return this.o.encoding;
  }

  /** A new size in cells: the buffers made again (only then). Braille's pixel is a dot; blocks' a half-block, twice the pitch. */
  resize(cols: number, rows: number) {
    const c = Math.max(1, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    this.o.cols = c;
    this.o.rows = r;
    const braille = this.o.encoding === "braille";
    this.pw = braille ? c * 2 : c;
    this.ph = braille ? r * 4 : r * 2;
    this.cell = braille ? CELL_PX : CELL_PX * 2;
    this.cw = this.pw * this.cell;
    this.above = Math.max(0, Math.ceil(HOST_HEIGHT / this.cell) - this.ph);
    this.ch = (this.ph + this.above) * this.cell;
    const n = this.pw * this.ph;
    this.kind = new Uint8Array(n);
    this.rgb = new Int32Array(n);
    this.alpha = new Float32Array(n);
    this.value = new Float32Array(n);
    this.dust = new Float32Array(n);
    this.dustC = new Int32Array(n);
    this.dustAny = false;
    this.lines.length = r;
    this.config = { ...this.config, reach: reachFor(this.baseReach, r) };
  }

  /** Pixel (x, y)'s kind after the last render (PIXEL); y from the top. */
  pixel(x: number, y: number): number {
    return this.kind[y * this.pw + x];
  }

  /** Whether pixel (x, y) is lit after the last render. */
  lit(x: number, y: number): boolean {
    return this.kind[y * this.pw + x] === PIXEL.lit;
  }

  /** Pixel (x, y)'s brightness after the last render (lifted, before dithering). */
  brightness(x: number, y: number): number {
    return this.value[y * this.pw + x];
  }

  /** Pixel (x, y)'s colour after the last render, 0xrrggbb, before opacity. */
  colorOf(x: number, y: number): number {
    return this.rgb[y * this.pw + x];
  }

  /** One frame: the band's rows, each exactly `cols` cells wide, colour reset at its end. */
  render(f: GlowFrame): readonly string[] {
    const dt = this.lastTime === undefined ? 1 / 60 : Math.min(0.05, Math.max(0, f.time - this.lastTime));
    this.lastTime = f.time;
    this.step(f, dt);
    // Closed: nothing to sample (the encoders draw nothing at this opacity either).
    if (this.opacity > 0.02) this.draw(dt);
    else this.kind.fill(PIXEL.none);
    if (this.o.encoding === "braille") this.encodeBraille();
    else this.encodeBlocks();
    return this.lines;
  }

  /** The driver's frame: the level shaped and followed, breathing, flow, gather, every lobe, the band line, the hue. */
  private step(f: GlowFrame, dt: number) {
    const c = this.config;
    const p = this.o.palette;
    this.t += dt;
    const t = this.t;
    const raw = Math.max(0, f.level);
    // No spectrum: the bands wobble slowly about the level, out of phase, so the lobes ripple.
    const b0 = f.bands?.[0] ?? raw;
    const b1 = f.bands?.[1] ?? raw * (0.72 + 0.28 * Math.sin(t * 9.1));
    const b2 = f.bands?.[2] ?? raw * (0.6 + 0.4 * Math.sin(t * 13.7 + 2));
    const { threshold, attack, release, breatheDuration } = VOICE_INPUT;
    this.level = follow(this.level, shape(raw, threshold), dt, attack, release);
    this.bands[0] = follow(this.bands[0], shape(b0, threshold * 0.6), dt, attack, release * 1.15);
    this.bands[1] = follow(this.bands[1], shape(b1, threshold * 0.6), dt, attack, release * 1.15);
    this.bands[2] = follow(this.bands[2], shape(b2, threshold * 0.6), dt, attack, release * 1.15);

    // The effect opens and closes; processing gathers the lobes into a beam that swings across.
    const active = f.mode !== "idle";
    this.fade = clamp01(this.fade + (active ? dt / FADE_IN : -dt / FADE_OUT));
    this.opacity = smoothstep(this.fade) * p.strength;
    this.gather = follow(this.gather, f.mode === "processing" ? 1 : 0, dt, GATHER_TAU, GATHER_TAU);
    const morph = this.gather < 0.001 ? 0 : this.gather;
    if (morph > 0) this.swing += dt / SWING_SECONDS;
    else this.swing = 0;

    const span = LOBE_SPAN * c.lobeSpacing;
    const gatherK = 1 - morph * 0.6;
    const maskWidth = 1 - morph * 0.45;
    // How fast it swings (0 at a turn, 1 crossing the middle) widens it a little while it moves.
    const stretch = Math.abs(Math.cos(TWO_PI * this.swing));
    const passWidth = 1 + morph * 0.3 * stretch;

    const breathe = 0.5 + 0.5 * Math.sin((TWO_PI * t) / breatheDuration);
    const voiced = this.level + (1 - this.level) * c.idle * breathe;
    const heldT = clamp01((morph - 0.25) / 0.75);
    const eff = Math.max(voiced, HELD_LEVEL * smoothstep(heldT));
    const glow = 0.15 + 0.85 * eff;
    const h = 0.5 + c.reach * eff;
    const w = (0.85 + c.spread * eff) * passWidth;
    if (c.flow !== 0) this.phase = (((this.phase + c.flow * eff * dt) % span) + span) % span;
    // The beam's place: from side to side, its centre reaching 85% of the way to each edge.
    const reachOut = (0.85 * this.cw) / 2 / Math.max(1, (span / 2) * w);
    const cx = ((Math.sin(TWO_PI * this.swing) * reachOut * span) / 2) * morph;

    const lift = c.bend * eff;
    const bendA = c.bend > 0 ? Math.min(1, lift / c.bend) : 0;
    const { cw } = this;
    this.beamX = cw / 2 + cx * w;
    this.cy = 0;
    for (let i = 0; i < LOBES; i++) {
      const lobe = VOICE_LOBES[i];
      const x = wrapX(lobe.x * c.lobeSpacing + this.phase, span);
      this.lobeL[i] = (0.6 + 0.7 * this.bands[lobe.band]) * edgeEnvelope(x, span);
      this.lobeX[i] = cw / 2 + (cx + x * gatherK) * w;
    }
    this.bandLine(cx, w, h, maskWidth, lift, morph);

    const hue = p.hueRange === 0 ? 0 : -p.hueRange + 2 * p.hueRange * pingPong(t / p.hueDuration);
    const hm = hueMatrix(p.hueBase + hue);
    const sm = saturateMatrix(p.saturation);
    for (let i = 0; i < LOBES; i++) filtered(p.colors[i % p.colors.length], hm, sm, p.brightness, this.lobeRgb, i * 3, this.tmp);
    const strands = [p.band.core, p.band.above, p.band.below];
    for (let j = 0; j < 3; j++) filtered(strands[j], hm, sm, p.brightness, this.bandRgb, j * 3, this.tmp);

    // drawPixels' frame set-up: the lobes' ellipses, the softness, the range mask, the band's look.
    const sw = c.glowWidth * 1.15 * c.bloomScale;
    const sh = c.glowHeight * 1.5 * c.bloomScale * c.bloomHeight;
    for (let i = 0; i < LOBES; i++) {
      const lobe = VOICE_LOBES[i];
      this.lobeIrx[i] = 1 / Math.max(1, Math.round(lobe.w * sw) * w);
      this.lobeIry[i] = 1 / Math.max(1, Math.round(lobe.h * sh) * h * Math.max(0.02, this.lobeL[i]));
    }
    this.fadeR = Math.max(40, Math.min(95, 70 * c.softness)) / 100;
    this.mrx = Math.max(1, CEILING_HALF_WIDTH * c.rangeWidth * w * maskWidth);
    this.mry = Math.max(1, CEILING_HEIGHT * c.rangeHeight * h + lift);
    this.presence = Math.min(1, glow * 1.15);
    this.domeK = Math.max(0, c.pixelDome) * 2.2;
    this.domeCx = cw / 2;
    this.domeIhw = 2 / Math.max(1, cw);
    this.bandAlpha = c.bandWidth > 0 ? Math.min(1, 0.6 * c.bandStrength * bendA) * 0.85 : 0;
    this.bandSigma = Math.max(0.9, 1.5 * c.bandWidth * (1 + 0.35 * this.level));
    this.bandDy = (4 + 12 * c.bandAberration * (0.35 + 0.65 * this.level)) * c.scale * 0.55;
    this.bandEnds = c.bandTail > 0 ? 0.015 : 0.18;
    this.lean(dt, morph);
  }

  private presence = 1;

  /** The band line (bandPoints): a bell on the range's ceiling, its ends rising into the corners, in host px. */
  private bandLine(cx: number, w: number, h: number, mw: number, lift: number, corner: number) {
    const c = this.config;
    const { cw, ch, bandYs } = this;
    const centre = cw / 2 + cx * w;
    const half = CEILING_HALF_WIDTH * c.rangeWidth * w * mw;
    const apexCap = ch * 0.82 * Math.min(1, c.scale);
    const apex = Math.min(apexCap, (CEILING_HEIGHT * c.rangeHeight * h + lift) * c.bandPosition);
    const base = ch - c.bandOffset;
    // The hooks are the resting look: gone by a quarter of the way into the gather.
    const tailT = Math.min(1, corner * 4);
    const tail = c.bandTail * (1 - smoothstep(tailT));
    const withTail = tail > 0.001;
    const over = withTail ? c.bandTailOverflow : 0;
    const x0 = withTail ? -over : centre - half;
    const x1 = withTail ? cw + over : centre + half;
    for (let i = 0; i <= BAND_SAMPLES; i++) {
      const x = x0 + ((x1 - x0) * i) / BAND_SAMPLES;
      const t = Math.max(-1, Math.min(1, (x - centre) / Math.max(1, half)));
      const edge = (x < centre ? centre : cw - centre) + over;
      const y = bell(t, c.bandCurve, c.bandSpread, c.bandSkew) + tailLift(Math.abs(x - centre), edge, tail, c.bandTailPosition, c.bandTailCurve);
      bandYs[i] = base - apex * y;
    }
    this.bandX0 = x0;
    this.bandStep = (x1 - x0) / BAND_SAMPLES || 1;
  }

  /** Processing's comet: the beam's centre by its lobes' light, its smoothed speed, and how far it leans. */
  private lean(dt: number, gather: number) {
    let sumL = 0;
    let sumX = 0;
    for (let i = 0; i < LOBES; i++) {
      sumL += this.lobeL[i];
      sumX += this.lobeX[i] * this.lobeL[i];
    }
    const { cw, ch } = this;
    const cx = sumL > 1e-4 ? sumX / sumL : cw / 2;
    if (this.travelX === this.travelX && dt > 0) {
      const vNow = (cx - this.travelX) / dt;
      this.travelV += (vNow - this.travelV) * (1 - Math.exp(-dt / 0.08));
    }
    this.travelX = cx;
    this.leanCx = cx;
    // Full lean from about a third of the host's width a second.
    this.leanDir = gather > 0.02 ? Math.max(-1, Math.min(1, this.travelV / (cw * 0.33))) * gather : 0;
    if (this.leanDir !== 0) {
      // The beam's half-width: out from its centre, at its height, until its light halves.
      const peak = this.lobeField(cx, ch);
      let half = 8;
      if (peak > 0.01) {
        for (let d = 4; d < cw / 2; d += 4) {
          if (this.lobeField(cx + d, ch) + this.lobeField(cx - d, ch) < peak) break;
          half = d;
        }
      }
      this.leanW = half;
      this.leanTail = Math.max(24, half * 3.2);
    }
  }

  private domeAt(x: number): number {
    if (this.domeK <= 0) return 1;
    const u = (x - this.domeCx) * this.domeIhw;
    return 1 + this.domeK * u * u;
  }

  /** The lobes' light at a point, each lobe's gradient joined as light joins; fills `hues`, each lobe's pull on the colour. */
  private lobeField(x: number, y: number): number {
    const { lobeX, lobeL, lobeIrx, lobeIry, hues, ch, fadeR } = this;
    let dark = 1;
    const dome = this.domeAt(x);
    for (let i = 0; i < LOBES; i++) {
      const dx = (x - lobeX[i]) * lobeIrx[i];
      const dy = (y - ch) * lobeIry[i] * dome;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2) / fadeR;
      const v = d < 1 ? 1 - d : 0;
      hues[i] = lobeL[i] > 0.01 ? Math.exp(-d2 / (HUE_REACH * HUE_REACH)) * Math.min(1, lobeL[i]) : 0;
      dark *= 1 - v * 0.92;
    }
    return 1 - dark;
  }

  /** The band's light at a point: a soft ridge on its line, its fringes split above and below, fading in at its ends. */
  private sampleBand(x: number, y: number) {
    const { bandPull } = this;
    this.bandV = 0;
    bandPull[0] = bandPull[1] = bandPull[2] = 0;
    if (this.bandAlpha <= 0.004) return;
    const u = (x - this.bandX0) / this.bandStep;
    if (u < 0 || u > BAND_SAMPLES) return;
    const k = Math.min(BAND_SAMPLES - 1, Math.floor(u));
    const ly = this.bandYs[k] + (this.bandYs[k + 1] - this.bandYs[k]) * (u - k);
    const t = u / BAND_SAMPLES;
    const a = this.bandAlpha * Math.min(1, Math.min(t, 1 - t) / this.bandEnds);
    if (a <= 0.004) return;
    const s2 = 1 / (this.bandSigma * this.bandSigma);
    const dc = y - ly;
    const da = y - (ly - this.bandDy);
    const db = y - (ly + this.bandDy);
    const core = Math.exp(-dc * dc * s2);
    const above = Math.exp(-da * da * s2) * 0.6;
    const below = Math.exp(-db * db * s2) * 0.6;
    bandPull[0] = core * a;
    bandPull[1] = above * a;
    bandPull[2] = below * a;
    this.bandV = Math.min(1, Math.max(core, above, below) * a);
  }

  /** The glow at a point: the comet's warp, the band, the range mask and the lobes. */
  private sample(x: number, y: number): number {
    let xs = x;
    let taper = 1;
    if (this.leanDir !== 0) {
      const a = Math.abs(this.leanDir) * LEAN;
      const front = this.leanCx + this.leanDir * this.leanW * 0.85;
      const u = (x - front) * this.leanDir;
      let cx: number;
      let ct: number;
      if (u > 0) {
        cx = this.leanCx + this.leanDir * u * 4;
        ct = 1;
      } else {
        cx = this.leanCx;
        ct = Math.max(0, 1 + u / this.leanTail) ** 1.35;
      }
      xs = x + (cx - x) * a;
      taper = 1 + (ct - 1) * a;
    }
    this.sampleBand(xs, y);
    if (taper < 1) {
      this.bandV *= taper;
      this.bandPull[0] *= taper;
      this.bandPull[1] *= taper;
      this.bandPull[2] *= taper;
    }
    // The range: solid at the centre, half at 45% out, gone at the rim.
    const mx = (xs - this.beamX) / this.mrx;
    const my = ((y - (this.ch + this.cy)) / this.mry) * this.domeAt(xs);
    const md = Math.sqrt(mx * mx + my * my);
    // Outside it, the colour's pull is the last point's, as the original's (the band's tails take it into the corners).
    if (md >= 1) return 0;
    const mask = md < 0.45 ? 1 - (0.5 * md) / 0.45 : 0.5 * (1 - (md - 0.45) / 0.55);
    return this.lobeField(xs, y) * mask * taper;
  }

  /** The colours at the last sampled point, blended by each lobe's light and the band's, given back their saturation; false where none reaches. */
  private blend(): boolean {
    const { hues, lobeRgb, bandPull, bandRgb, mix } = this;
    let sw = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < LOBES; i++) {
      const k = hues[i];
      sw += k;
      r += lobeRgb[i * 3] * k;
      g += lobeRgb[i * 3 + 1] * k;
      b += lobeRgb[i * 3 + 2] * k;
    }
    for (let j = 0; j < 3; j++) {
      const k = bandPull[j] * BAND_PULL;
      if (k <= 0) continue;
      sw += k;
      r += bandRgb[j * 3] * k;
      g += bandRgb[j * 3 + 1] * k;
      b += bandRgb[j * 3 + 2] * k;
    }
    if (sw <= 1e-6) return false;
    r /= sw;
    g /= sw;
    b /= sw;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    mix[0] = clamp01(l + (r - l) * HUE_VIVID);
    mix[1] = clamp01(l + (g - l) * HUE_VIVID);
    mix[2] = clamp01(l + (b - l) * HUE_VIVID);
    return true;
  }

  /** drawDither: every pixel sampled, lifted, dithered on or off, its colour blended and cut to a few levels; the dust. */
  private draw(dt: number) {
    const { pw, ph, cell, kind, rgb, alpha, value, mix } = this;
    kind.fill(PIXEL.none);
    value.fill(0);
    this.dustDecay(dt);
    const gather = this.config.pixelDust > 0 ? this.gather : 0;
    const q = DITHER_LEVELS - 1;
    let top = Math.max(0, this.ch + this.cy - this.mry);
    if (this.bandAlpha > 0.004) for (let i = 0; i <= BAND_SAMPLES; i++) top = Math.min(top, this.bandYs[i] - 3 * this.bandSigma - this.bandDy);
    top = Math.max(0, top);
    const presence = this.presence;
    const above = this.above;
    for (let r = ph - 1; r >= 0; r--) {
      // The host's row: the grid is its bottom rows, and the matrix is laid from its top, as the original's.
      const hr = r + above;
      const y = (hr + 0.5) * cell;
      if (y + cell < top) break;
      for (let c = 0; c < pw; c++) {
        const x = (c + 0.5) * cell;
        const m = r * pw + c;
        const raw = 1 - (1 - this.sample(x, y) * presence) * (1 - this.bandV);
        if (raw <= 0.004) {
          this.dustAt(m, c, hr);
          continue;
        }
        const v = lifted(raw);
        value[m] = v;
        const t = THRESHOLDS[((hr & 3) << 2) | (c & 3)];
        const on = ditherOn(v, t);
        if (!on) {
          // Dust shows where the beam has passed, in place of the faint grid.
          if (this.dustAt(m, c, hr)) continue;
          if (v < 0.06) continue;
        }
        if (!this.blend()) continue;
        // Whiter where the glow is strongest; each channel cut to a level on the same threshold, so hues dither instead of banding.
        const lift = Math.max(0, v - 0.7) / 0.3;
        const r8 = Math.round((Math.min(q, Math.floor((mix[0] + (1 - mix[0]) * lift * 0.6) * q + t)) / q) * 255);
        const g8 = Math.round((Math.min(q, Math.floor((mix[1] + (1 - mix[1]) * lift * 0.6) * q + t)) / q) * 255);
        const b8 = Math.round((Math.min(q, Math.floor((mix[2] + (1 - mix[2]) * lift * 0.6) * q + t)) / q) * 255);
        const packed = pack(r8, g8, b8);
        rgb[m] = packed;
        if (on) {
          kind[m] = PIXEL.lit;
          alpha[m] = 1;
          if (gather > 0.05 && v >= DUST_MIN_V) {
            const d = Math.min(1, v * gather);
            if (d > this.dust[m]) {
              this.dust[m] = d;
              this.dustC[m] = packed;
              this.dustAny = true;
            }
          }
        } else {
          kind[m] = PIXEL.ghost;
          alpha[m] = GHOST_ALPHA;
        }
      }
    }
  }

  /** The dust's charges fall to a third in `pixelDust` seconds. */
  private dustDecay(dt: number) {
    if (!this.dustAny || dt <= 0) return;
    const tau = this.config.pixelDust;
    const k = tau > 0 ? Math.exp(-dt / tau) : 0;
    const d = this.dust;
    let any = false;
    for (let i = 0; i < d.length; i++) {
      if (d[i] <= 0) continue;
      d[i] *= k;
      if (d[i] < 0.02) d[i] = 0;
      else any = true;
    }
    this.dustAny = any;
  }

  /** Pixel m's speck of dust, if its charge is over its own threshold (spread over the cells, so the trail thins pixel by pixel); true if shown. */
  private dustAt(m: number, c: number, r: number): boolean {
    const d = this.dust[m];
    if (!(d > 0)) return false;
    const th = 0.22 + 0.78 * hash(c + 17, r + 31);
    if (d < th) return false;
    this.kind[m] = PIXEL.dust;
    this.rgb[m] = this.dustC[m];
    this.alpha[m] = Math.min(1, (d - th) * 5) * 0.9;
    return true;
  }

  /** A colour at an alpha (times the opacity) over the background: black, or white on the light theme. */
  private over(packed: number, a: number): number {
    const k = a * this.opacity;
    const bg = this.o.palette.theme === "light" ? 255 : 0;
    const ch = (v: number) => clamp255(bg + (v - bg) * k);
    return pack(ch((packed >> 16) & 255), ch((packed >> 8) & 255), ch(packed & 255));
  }

  /**
   * 2×4 pixels a cell. Its dots are its lit pixels and dust; its colour their average (each by its
   * alpha). A cell with neither shows the faint grid: one dot in four of its ghosts, in theirs.
   */
  private encodeBraille() {
    const { pw, kind, rgb, alpha, lines } = this;
    const { cols, rows, depth } = this.o;
    const visible = this.opacity > 0.02;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let current = -1;
      for (let c = 0; c < cols; c++) {
        let bits = 0;
        let ghostBits = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sa = 0;
        let gr = 0;
        let gg = 0;
        let gb = 0;
        let gn = 0;
        if (visible) {
          for (let dy = 0; dy < 4; dy++) {
            const y = r * 4 + dy;
            for (let dx = 0; dx < 2; dx++) {
              const i = y * pw + c * 2 + dx;
              const k = kind[i];
              if (k === PIXEL.none) continue;
              const p = rgb[i];
              if (k === PIXEL.ghost) {
                if (((c * 2 + dx) & 1) === 0 && (y & 1) === 0) {
                  ghostBits |= BRAILLE_DOTS[dy][dx];
                  gr += (p >> 16) & 255;
                  gg += (p >> 8) & 255;
                  gb += p & 255;
                  gn++;
                }
                continue;
              }
              bits |= BRAILLE_DOTS[dy][dx];
              const a = alpha[i];
              sr += ((p >> 16) & 255) * a;
              sg += ((p >> 8) & 255) * a;
              sb += (p & 255) * a;
              sa += a;
            }
          }
        }
        let color = -1;
        if (bits) {
          // The dots' average colour, at their average alpha.
          const n = popcount(bits);
          color = this.over(pack(clamp255(sr / sa), clamp255(sg / sa), clamp255(sb / sa)), sa / n);
        } else if (ghostBits) {
          bits = ghostBits;
          color = this.over(pack(clamp255(gr / gn), clamp255(gg / gn), clamp255(gb / gn)), GHOST_ALPHA);
        }
        if (depth && bits && color !== current) {
          s += sgrOf(color, depth);
          current = color;
        }
        s += BRAILLE[bits];
      }
      lines[r] = depth ? `${s}\x1b[0m` : s;
    }
  }

  /** A pixel's colour as blocks draw it (-1 for none): lit and dust at their alpha; the faint grid isn't drawn, a half-block being too big for it. */
  private blockColor(i: number): number {
    const k = this.kind[i];
    if (k === PIXEL.none || k === PIXEL.ghost || this.opacity <= 0.02) return -1;
    return this.over(this.rgb[i], this.alpha[i]);
  }

  /** 1×2 pixels a cell: the top pixel in the foreground of ▀, the bottom one in its background (▄ or █ when only one, or both the same). */
  private encodeBlocks() {
    const { pw, lines } = this;
    const { cols, rows, depth } = this.o;
    for (let r = 0; r < rows; r++) {
      let s = "";
      let curFg = -1;
      let curBg = -1; // -1: the terminal's own
      const top = r * 2;
      for (let c = 0; c < cols; c++) {
        const t = this.blockColor(top * pw + c);
        const b = this.blockColor((top + 1) * pw + c);
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

const popcount = (bits: number) => {
  let n = 0;
  for (let b = bits; b; b &= b - 1) n++;
  return n;
};

/** One frame, made from scratch after `warmup` seconds of the same frame at 60 a second (the envelope settled): for tests and one-offs. */
export function renderGlow(o: GlowOptions & GlowFrame & { warmup?: number }): string[] {
  const glow = new DitherGlow(o);
  const frames = Math.round((o.warmup ?? 2) * 60);
  for (let i = 0; i < frames; i++) glow.render({ ...o, time: o.time - (frames - i) / 60 });
  return [...glow.render(o)];
}
