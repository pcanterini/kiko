// Kiko's logo in the terminal: "KIKO." in 3D block letters, a pale face with two darker copies
// pushed down-right behind it, the dot in the brand's periwinkle, and the tagline under it. Under
// 52 columns (the wide one doesn't fit) it's the narrow "Kiko." with one copy behind; under 33, none.
// It plays three effects, about a second in all: the rows fading in top to bottom, a band of light
// sweeping across, and the tagline typing in. Drawn by the app's splash (./splash.ts) and at the
// start of `kiko setup` (./onboarding.ts); `kiko setup <agent>` has the one-line mark (logoMark).
//
//   ██▓  ▄██▀▓  ██████▓  ██▓  ▄██▀▓   ▄█████▄
//   ██▓▄██▀▓▓▒▒  ▓██▓▓▓▒ ██▓▄██▀▓▓▒▒ ██▀▓▓▓▀██▓
//   █████▓▓▒▒     ██▓▒   █████▓▓▒▒   ██▓▒▒  ██▓▒
//   ██▓▀██▄       ██▓▒   ██▓▀██▄     ██▄▒  ▄██▓▒ ▄▄▄
//   ██▓▒ ▀██▄   ██████▓  ██▓▒ ▀██▄    ▀█████▀▓▓▒ ███▓▒
//    ▓▓▒   ▓▓▓▒  ▓▓▓▓▓▓▒  ▓▓▒   ▓▓▓▒    ▓▓▓▓▓▒▒   ▓▓▓▒
//
//        Talk to all your coding agents at once.
//
// (as it is with no colour: the ▓ ▒ are the extrusion, in two darker indigos with colour)
//
// Everything is drawn on a pixel canvas where a pixel is half a cell (1 column × ½ row, about
// square), then folded into cells with ▀ ▄ █: the top pixel as the foreground, the bottom one as the
// background. The extrusion's pixels fall back to ▓ ▒ with no colour, so the shapes stay (NO_COLOR).
// Colour as cli-style.ts decides it (colorDepth): truecolor, else the nearest of xterm's 256 by
// "redmean" distance, which keeps a blue blue (plain RGB distance drifts dark indigos to teal).
// Pure: no Ink, nothing read; start.ts imports it before anything else is loaded.
import type { ColorDepth } from "./cli-style.ts";

type Rgb = readonly [number, number, number];

// ─── Colour ──────────────────────────────────────────────────────────────────────────────────────

const hex = (h: string): Rgb => [Number.parseInt(h.slice(1, 3), 16), Number.parseInt(h.slice(3, 5), 16), Number.parseInt(h.slice(5, 7), 16)];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** A colour picked from evenly spaced stops; `t` from 0 to 1. */
function ramp(stops: readonly Rgb[], t: number): Rgb {
  const s = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  return mix(stops[i], stops[i + 1], s - i);
}

/**
 * Kiko's colours as the site has them in its dark theme (kiko.sh styles.css: --text, the wordmark's
 * name; --accent, its dot; --term-faint), and an indigo ramp around the accent (light → dark, the
 * accent at 3). The window's wordmark (./wordmark.ts) takes its colours from here too.
 */
export const BRAND = {
  text: "#ececef",
  faint: "#8b8c94",
  face: "#d2d8ff",
  accent: "#9aa8ff",
  indigo: ["#f1f3ff", "#d4daff", "#b4bfff", "#9aa8ff", "#8090f5", "#6873e6", "#5058d6", "#3f46c9", "#323aa8", "#262c85", "#1c2063", "#14173f"],
} as const;

const K = {
  text: hex(BRAND.text),
  faint: hex(BRAND.faint),
  white: hex("#ffffff"),
  face: hex(BRAND.face),
  accent: hex(BRAND.accent),
  indigo: BRAND.indigo.map(hex),
};
const indigoAt = (i: number) => ramp(K.indigo, i / (K.indigo.length - 1));

const CUBE = [0, 95, 135, 175, 215, 255];
/** xterm's colours 16–255: the 6×6×6 cube, then the grey ramp. */
const XTERM: Rgb[] = [
  ...Array.from({ length: 216 }, (_, i): Rgb => [CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]]),
  ...Array.from({ length: 24 }, (_, i): Rgb => [8 + 10 * i, 8 + 10 * i, 8 + 10 * i]),
];
const nearest = new Map<string, number>();
/** The nearest xterm-256 colour to a "#rrggbb" (to256). */
export const hexTo256 = (h: string): number => to256(hex(h));

/** The nearest xterm-256 colour by redmean distance (cached: for the few colours drawn again and again). */
export function to256(c: Rgb): number {
  const key = c.join(",");
  const known = nearest.get(key);
  if (known !== undefined) return known;
  const best = nearestXterm(c[0], c[1], c[2]);
  nearest.set(key, best);
  return best;
}

/** The nearest xterm-256 colour by redmean distance, worked out each time (for callers with their own cache). */
export function nearestXterm(r: number, g: number, b: number): number {
  let best = 16;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < XTERM.length; i++) {
    const [x, y, z] = XTERM[i];
    const rm = (r + x) / 2;
    const d = (2 + rm / 256) * (x - r) ** 2 + 4 * (y - g) ** 2 + (2 + (255 - rm) / 256) * (z - b) ** 2;
    if (d < bestD) [best, bestD] = [16 + i, d];
  }
  return best;
}

const sgrColor = (c: Rgb, depth: ColorDepth, bg: boolean) => (depth === 24 ? `${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}` : `${bg ? 48 : 38};5;${to256(c)}`);

// ─── Letterforms ─────────────────────────────────────────────────────────────────────────────────
// '#' a letter's pixel, '*' the dot's, '.' nothing. Every glyph in a font has the same height.

type Font = Record<string, readonly string[]>;

/** Big caps, 10 px (5 rows): 2-px stems, 3-px diagonals (about a stem's weight at 45°), a serifed I so it never reads as l or |. */
const CAPS10: Font = {
  K: ["##....###", "##...###.", "##..###..", "##.###...", "#####....", "#####....", "##.###...", "##..###..", "##...###.", "##....###"],
  I: ["######", "######", "..##..", "..##..", "..##..", "..##..", "..##..", "..##..", "######", "######"],
  O: ["..#####..", ".#######.", "###...###", "##.....##", "##.....##", "##.....##", "##.....##", "###...###", ".#######.", "..#####.."],
  ".": ["...", "...", "...", "...", "...", "...", "...", "***", "***", "***"],
};

/** Mixed case, 8 px (4 rows): "Kiko." at small size; cap 8, x-height 6. */
const MID8: Font = {
  K: ["##...##", "##..##.", "##.##..", "####...", "####...", "##.##..", "##..##.", "##...##"],
  i: ["##", "..", "##", "##", "##", "##", "##", "##"],
  k: ["##....", "##....", "##..##", "##.##.", "####..", "####..", "##.##.", "##..##"],
  o: ["......", "......", ".####.", "##..##", "##..##", "##..##", "##..##", ".####."],
  ".": ["..", "..", "..", "..", "..", "..", "**", "**"],
};

type Role = "face" | "dot";

/** Which pixels a set word covers, and as what. */
class Mask {
  readonly w: number;
  readonly h: number;
  readonly cells: (Role | null)[];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = new Array(w * h).fill(null);
  }
  get(x: number, y: number): Role | null {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.cells[y * this.w + x];
  }
  set(x: number, y: number, role: Role) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y * this.w + x] = role;
  }
  *each(): Generator<[number, number, Role]> {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const role = this.cells[y * this.w + x];
        if (role) yield [x, y, role];
      }
  }
}

/** `text` set in `font`, `gap` pixels between letters; `kern` overrides a pair's gap ({ "O.": 3 }). */
function setText(font: Font, text: string, { gap = 2, kern = {} as Record<string, number> } = {}): Mask {
  const chars = [...text];
  const glyphs = chars.map((ch) => font[ch]);
  const h = glyphs[0].length;
  const gaps = chars.slice(1).map((ch, i) => kern[chars[i] + ch] ?? gap);
  const w = glyphs.reduce((s, g) => s + g[0].length, 0) + gaps.reduce((s, g) => s + g, 0);
  const mask = new Mask(w, h);
  let x0 = 0;
  glyphs.forEach((g, i) => {
    g.forEach((row, y) => {
      [...row].forEach((c, x) => {
        if (c !== ".") mask.set(x0 + x, y, c === "*" ? "dot" : "face");
      });
    });
    x0 += g[0].length + (gaps[i] ?? 0);
  });
  return mask;
}

// ─── Pixels → cells ──────────────────────────────────────────────────────────────────────────────

/** A pixel: its colour; `solid` (the face) draws as ▀▄█ without colour too, the rest (a side) as ▓ or ▒ by `shade`. */
type Pixel = { rgb: Rgb; role: Role | "side"; solid: boolean; shade?: 1 | 2 | 3 };

class Pix {
  readonly w: number;
  readonly h: number;
  readonly px: (Pixel | null)[];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h + (h % 2);
    this.px = new Array(this.w * this.h).fill(null);
  }
  get(x: number, y: number): Pixel | null {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.px[y * this.w + x] : null;
  }
  set(x: number, y: number, p: Pixel) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = p;
  }
  get rows() {
    return this.h / 2;
  }
  /** Every pixel's colour through `fn`, in place. */
  recolor(fn: (p: Pixel, x: number, y: number) => Rgb) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const p = this.get(x, y);
        if (p) this.set(x, y, { ...p, rgb: fn(p, x, y) });
      }
  }
}

const SHADES = ["░", "▒", "▓"] as const;

/** A cell: its character in colour (`ch`, `fg`, `bg`), and without (`plain`, else `ch`). */
type Cell = { ch: string; fg?: Rgb; bg?: Rgb; dim?: boolean; plain?: string };

/** The logo's cells: exactly its bounding box. */
export class Grid {
  readonly w: number;
  readonly h: number;
  readonly cells: (Cell | null)[][];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => new Array<Cell | null>(w).fill(null));
  }
  set(x: number, y: number, cell: Cell | null) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y][x] = cell;
  }
  get(x: number, y: number): Cell | null {
    return this.cells[y]?.[x] ?? null;
  }
  text(x: number, y: number, str: string, style: Omit<Cell, "ch"> = {}) {
    [...str].forEach((ch, i) => {
      this.set(x + i, y, { ch, ...style });
    });
  }
  /** Plain-text rows, as with no colour (trailing spaces trimmed). */
  plain(): string[] {
    return this.cells.map((row) =>
      row
        .map((c) => c?.plain ?? c?.ch ?? " ")
        .join("")
        .replace(/\s+$/, ""),
    );
  }
  /** Row `y` in `depth`'s colours (each SGR state written once, reset at the end); with 0, as plain(), but its full width. */
  row(y: number, depth: ColorDepth): string {
    let out = "";
    let cur = "";
    for (const c of this.cells[y]) {
      if (!depth) {
        out += c?.plain ?? c?.ch ?? " ";
        continue;
      }
      const parts: string[] = [];
      if (c?.dim) parts.push("2");
      if (c?.fg) parts.push(sgrColor(c.fg, depth, false));
      if (c?.bg) parts.push(sgrColor(c.bg, depth, true));
      const want = parts.join(";");
      if (want !== cur) {
        out += `\x1b[0m${want ? `\x1b[${want}m` : ""}`;
        cur = want;
      }
      out += c?.ch ?? " ";
    }
    return cur ? `${out}\x1b[0m` : out;
  }
}

/** The cell without colour: solid halves as ▀▄█, otherwise the stronger shade. */
function plainFor(t: Pixel | null, b: Pixel | null): string {
  if (t?.solid && b?.solid) return "█";
  if (t?.solid) return "▀";
  if (b?.solid) return "▄";
  const s = Math.max(t?.shade ?? 0, b?.shade ?? 0);
  return s ? SHADES[s - 1] : " ";
}

/** Folds a pixel canvas into the grid's cells from column `ox`, row `oy`. */
function blit(grid: Grid, pix: Pix, ox: number, oy: number) {
  for (let r = 0; r < pix.rows; r++)
    for (let x = 0; x < pix.w; x++) {
      const t = pix.get(x, 2 * r);
      const b = pix.get(x, 2 * r + 1);
      if (!t && !b) continue;
      let cell: Cell;
      if (t && b) cell = same(t.rgb, b.rgb) ? { ch: "█", fg: t.rgb } : { ch: "▀", fg: t.rgb, bg: b.rgb };
      else if (t) cell = { ch: "▀", fg: t.rgb };
      else cell = { ch: "▄", fg: (b as Pixel).rgb };
      cell.plain = plainFor(t, b);
      grid.set(ox + x, oy + r, cell);
    }
}

// ─── The look and its effects ────────────────────────────────────────────────────────────────────

/** Extruded: the flat face, and `depth` copies pushed down-right behind it, each a step darker. */
function extrude(mask: Mask, depth: number, tones: { face: Rgb; dot: Rgb; sides: Rgb[]; dotSides: Rgb[] }): Pix {
  const pix = new Pix(mask.w + depth, mask.h + depth);
  for (let d = depth; d >= 1; d--)
    for (const [x, y, role] of mask.each()) {
      if (mask.get(x + d, y + d)) continue;
      // The surface under a horizontal edge faces down (darker); the one beside a vertical edge faces right.
      const facesDown = !mask.get(x + d, y + d - 1) || mask.get(x + d - 1, y + d);
      const sides = role === "dot" ? tones.dotSides : tones.sides;
      const rgb = facesDown ? sides[d - 1] : mix(sides[d - 1], role === "dot" ? tones.dot : tones.face, 0.18);
      pix.set(x + d, y + d, { rgb, role: "side", solid: false, shade: d === 1 ? 3 : 2 });
    }
  for (const [x, y, role] of mask.each()) pix.set(x, y, { rgb: role === "dot" ? tones.dot : tones.face, role, solid: true });
  return pix;
}

/** A slanted band of light crossing the pixels left to right, at progress `p` (0 and 1: none). */
function sweep(pix: Pix, p: number, { width = 5, strength = 0.8, slant = 0.6 } = {}) {
  if (p <= 0 || p >= 1) return;
  const c = -width - pix.h * slant + (pix.w + 2 * width + pix.h * slant) * easeInOut(p);
  pix.recolor((px, x, y) => {
    const d = Math.abs(x - y * slant - c) / width;
    if (d >= 1) return px.rgb;
    return mix(px.rgb, K.white, (px.solid ? strength : strength * 0.35) * (1 - d) ** 1.4);
  });
}

/** Rows `top`… appear top to bottom at progress `p`, each fading in through ░ ▒ ▓ before its real cells. */
function reveal(grid: Grid, top: number, rows: number, p: number) {
  if (p >= 1) return;
  const span = 2.2;
  for (let r = 0; r < rows; r++) {
    const k = (p * (rows + span) - r) / span;
    if (k >= 1) continue;
    for (let x = 0; x < grid.w; x++) {
      const c = grid.get(x, top + r);
      if (!c) continue;
      if (k <= 0) grid.set(x, top + r, null);
      else {
        const ch = SHADES[Math.min(2, Math.floor(k * 3))];
        grid.set(x, top + r, { ch, fg: c.fg ?? c.bg, plain: ch });
      }
    }
  }
}

export const TAGLINE = "Talk to all your coding agents at once.";

/** `text` in lines of at most `width`, broken at spaces. */
export function wrapWords(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return line ? [...out, line] : out;
}

/** The tagline from row `y`, centred, typed in at progress `p` with a block cursor; its lines wrapped to the grid. */
function tagline(grid: Grid, y: number, p: number) {
  const lines = wrapWords(TAGLINE, grid.w);
  const shown = p >= 1 ? TAGLINE : TAGLINE.slice(0, Math.round(TAGLINE.length * Math.max(0, p)));
  const cursor = p > 0 && p < 1;
  let used = 0;
  lines.forEach((line, i) => {
    const part = shown.slice(used, used + line.length);
    used += line.length + 1;
    const col = Math.floor((grid.w - line.length) / 2);
    grid.text(col, y + i, part, { fg: K.faint });
    const last = shown.length <= used - 1 && shown.length >= used - line.length - 1;
    if (cursor && last) grid.set(col + part.length, y + i, { ch: "▌", fg: K.accent, plain: " " });
  });
}

/** The effects, each from `at` for `dur` ms after the logo's first frame: about a second in all. */
export const LOGO_EFFECTS = {
  reveal: { at: 0, dur: 450 },
  sweep: { at: 400, dur: 600 },
  type: { at: 450, dur: 600 },
} as const;
type Effect = keyof typeof LOGO_EFFECTS;

/** How long the effects take: the logo is at rest from then on. */
export const LOGO_MS = Math.max(...Object.values(LOGO_EFFECTS).map((e) => e.at + e.dur));

/** Each effect's progress (0 → 1) `ms` after the first frame; null: all done. */
const progressAt = (ms: number | null) => (fx: Effect) => (ms === null ? 1 : clamp01((ms - LOGO_EFFECTS[fx].at) / LOGO_EFFECTS[fx].dur));

export type LogoSize = "wide" | "narrow";

/** Each size's width and height in cells, the tagline included (wide: 50 × 8; narrow: 31 × 8, its tagline on two lines). */
const SIZES: Record<LogoSize, { w: number; h: number }> = { wide: { w: 50, h: 8 }, narrow: { w: 31, h: 8 } };

/** Columns kept clear on each side. */
const MARGIN = 1;
/** Under this many columns the wide one is too much even if it fits: the narrow one (the brief's "under 40"). */
const NARROW_UNDER = 40;

/** The logo for a space `cols` wide: the wide one where it fits, else the narrow one, else none (null). */
export function logoSize(cols: number): LogoSize | null {
  if (cols >= NARROW_UNDER && cols >= SIZES.wide.w + 2 * MARGIN) return "wide";
  if (cols >= SIZES.narrow.w + 2 * MARGIN) return "narrow";
  return null;
}

/** The logo's size in cells, its tagline included. */
export const logoBox = (size: LogoSize) => SIZES[size];

/** The logo `ms` after its first frame (null: at rest), its tagline under it after a blank row. */
export function logoGrid(size: LogoSize, ms: number | null): Grid {
  const p = progressAt(ms);
  const narrow = size === "narrow";
  const mask = narrow ? setText(MID8, "Kiko.", { kern: { "o.": 1 } }) : setText(CAPS10, "KIKO.", { gap: 3, kern: { "O.": 3 } });
  const pix = extrude(mask, narrow ? 1 : 2, { face: K.face, dot: K.accent, sides: [indigoAt(6), indigoAt(9)], dotSides: [indigoAt(7), indigoAt(10)] });
  sweep(pix, p("sweep"));
  const w = Math.max(pix.w, narrow ? 0 : TAGLINE.length);
  const grid = new Grid(w, pix.rows + 1 + wrapWords(TAGLINE, w).length);
  blit(grid, pix, Math.floor((w - pix.w) / 2), 0);
  tagline(grid, pix.rows + 1, p("type"));
  reveal(grid, 0, pix.rows, p("reveal"));
  return grid;
}

/** The logo's rows in `depth`'s colours (0: shapes only), each its full width. */
export const logoRows = (size: LogoSize, ms: number | null, depth: ColorDepth): string[] => {
  const grid = logoGrid(size, ms);
  return grid.cells.map((_, y) => grid.row(y, depth));
};

/** The one-line mark, "Kiko." in the brand's colours: the name bold in the site's text colour, the dot its periwinkle. */
export function logoMark(depth: ColorDepth): string {
  if (!depth) return "Kiko.";
  return `\x1b[1;${sgrColor(K.text, depth, false)}mKiko\x1b[${sgrColor(K.accent, depth, false)}m.\x1b[0m`;
}

/**
 * The logo printed where the cursor is, in a terminal that scrolls (setup's: ./onboarding.ts),
 * `indent` columns in, its tagline under it; false (nothing printed) when `columns` is too narrow
 * for it. With `animate`, its effects are played in place first: each frame drawn over the last
 * (the cursor moved back up over it, hidden meanwhile and always shown again), until they're done
 * or `skipped` resolves (a key pressed), then the logo at rest. The cursor ends on the line under it.
 */
export async function printLogo(
  out: { write(text: string): unknown },
  o: { columns: number; depth: ColorDepth; animate: boolean; indent?: number; skipped?: Promise<unknown>; frameMs?: number },
): Promise<boolean> {
  const indent = " ".repeat(o.indent ?? 0);
  const size = logoSize(o.columns - indent.length);
  if (!size) return false;
  const frame = (ms: number | null) => logoRows(size, ms, o.depth).map((row) => `${indent}${row}\x1b[K`);
  if (!o.animate) {
    out.write(`${frame(null).join("\n")}\n`);
    return true;
  }
  const height = logoBox(size).h;
  let skipped = false;
  void o.skipped?.then(() => (skipped = true));
  const shown = () => out.write("\x1b[?25h");
  process.once("exit", shown);
  try {
    out.write(`\x1b[?25l${frame(0).join("\n")}\n`);
    const start = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, o.frameMs ?? 33));
      const ms = Date.now() - start;
      const done = skipped || ms >= LOGO_MS;
      // Synchronized (the terminal shows the frame whole), over the one before.
      out.write(`\x1b[?2026h\x1b[${height}A\r${frame(done ? null : ms).join("\n")}\n\x1b[?2026l`);
      if (done) return true;
    }
  } finally {
    process.off("exit", shown);
    shown();
  }
}
