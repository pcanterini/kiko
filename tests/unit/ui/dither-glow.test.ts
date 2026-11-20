// The dithered voice glow (src/ui/dither-glow.ts) and its level's envelope (src/ui/voice-envelope.ts):
// rows exactly as many and as wide as asked in both encodings; the seven lobes, symmetric, the middle
// tallest, at their natural size in the default band; nothing lit in idle at level 0, the bottom
// mostly lit at a high level, more lit as the level goes up; the palettes (each lobe its own colour,
// blended between, drifting; mono and light) and the xterm-256 fallback; the Bayer matrix's
// thresholds; braille's dot bits; the encoding falling back to braille without truecolor; the
// envelope's threshold, gain, attack and release (and where they come from); and the demo's flags,
// band and script. Nothing here opens the mic or touches the terminal.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorDepth } from "../../../src/ui/cli-style.ts";
import {
  BAYER4,
  bayerThreshold,
  brailleOf,
  COLORFUL,
  chooseEncoding,
  DitherGlow,
  DRIFT_SECONDS,
  GLOW_COLS,
  GLOW_LOBES,
  GLOW_ROWS,
  GLOW_SPAN,
  type GlowEncoding,
  type GlowMode,
  LIGHT,
  layoutLobes,
  monoPalette,
  nearest256,
  PX_PER_DOT,
  renderGlow,
  type Rgb,
  sgrOf,
} from "../../../src/ui/dither-glow.ts";
import { glowBand, glowDemoFlags, heldAt, paletteOf, scriptAt } from "../../../src/ui/glow-demo.ts";
import { BRAND, to256 } from "../../../src/ui/logo.ts";
import { envelope, gated, levelOfRms, MIC_ENVELOPE, PLAIN_ENVELOPE, perFrameToMs } from "../../../src/ui/voice-envelope.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const cellsOf = (s: string) => [...plain(s)].length;
const mono = monoPalette(BRAND.accent);
const glow = (encoding: GlowEncoding, cols = 40, rows = 4, depth: 0 | 256 | 24 = 24, palette = COLORFUL) => new DitherGlow({ cols, rows, encoding, depth, palette });
const unpack = (rgb: number): Rgb => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
/** A colour's hue in degrees: the same however far it's shaded towards black or white. */
const hueOf = ([r, g, b]: Rgb) => (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
const hueGap = (a: Rgb, b: Rgb) => {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return d > 180 ? 360 - d : d;
};
/** The index of the palette colour nearest `rgb` in hue. */
const nearestOf = (rgb: number, colors: readonly Rgb[]) => {
  const c = unpack(rgb);
  let best = 0;
  for (let i = 1; i < colors.length; i++) if (hueGap(c, colors[i]) < hueGap(c, colors[best])) best = i;
  return best;
};

/** The share of pixel row `y` that's lit. */
function litShare(g: DitherGlow, y: number) {
  let n = 0;
  for (let x = 0; x < g.pw; x++) if (g.lit(x, y)) n++;
  return n / g.pw;
}
function litAll(g: DitherGlow) {
  let n = 0;
  for (let y = 0; y < g.ph; y++) for (let x = 0; x < g.pw; x++) if (g.lit(x, y)) n++;
  return n;
}

describe("the glow's rows", () => {
  for (const encoding of ["braille", "blocks"] as const)
    for (const mode of ["idle", "listening", "processing", "speaking"] as const)
      test(`${encoding}, ${mode}: as many rows as asked, each exactly as wide`, () => {
        for (const [cols, rows] of [
          [120, 4],
          [37, 3],
          [1, 1],
        ]) {
          const lines = renderGlow({ cols, rows, encoding, depth: 24, palette: COLORFUL, time: 1.7, level: 0.8, mode });
          assert.equal(lines.length, rows);
          for (const l of lines) assert.equal(cellsOf(l), cols);
        }
      });

  test("pixels: 2×4 a cell in braille, 1×2 in blocks", () => {
    const b = glow("braille", 30, 3);
    assert.deepEqual([b.pw, b.ph], [60, 12]);
    const k = glow("blocks", 30, 3);
    assert.deepEqual([k.pw, k.ph], [30, 6]);
  });

  test("resize: the new size from the next frame", () => {
    const g = glow("braille", 20, 2);
    g.resize(50, 3);
    const lines = g.render({ time: 0, level: 0.5, mode: "listening" });
    assert.equal(lines.length, 3);
    for (const l of lines) assert.equal(cellsOf(l), 50);
  });

  test("braille cells are braille or spaces; blocks cells are ▀ ▄ █ or spaces", () => {
    const b = renderGlow({ cols: 60, rows: 4, encoding: "braille", depth: 24, palette: COLORFUL, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(b.join(""))) assert.ok(ch === " " || (ch.codePointAt(0)! >= 0x2801 && ch.codePointAt(0)! <= 0x28ff), ch);
    const k = renderGlow({ cols: 60, rows: 4, encoding: "blocks", depth: 24, palette: COLORFUL, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(k.join(""))) assert.ok(" ▀▄█".includes(ch), ch);
  });

  test("without colour: no escape codes at all", () => {
    const lines = renderGlow({ cols: 40, rows: 3, encoding: "braille", depth: 0, palette: COLORFUL, time: 1, level: 1, mode: "listening" });
    for (const l of lines) assert.ok(!l.includes("\x1b"));
    assert.ok(lines.join("").trim().length > 0);
  });

  test("truecolor: exact RGB; 256 colours: xterm's", () => {
    const tc = renderGlow({ cols: 40, rows: 3, encoding: "blocks", depth: 24, palette: COLORFUL, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(tc, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.doesNotMatch(tc, /38;5;/);
    const x256 = renderGlow({ cols: 40, rows: 3, encoding: "blocks", depth: 256, palette: COLORFUL, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(x256, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(x256, /38;2;/);
  });
});

describe("the lobes", () => {
  test("seven, symmetric about the middle: each one's mirror the same size and band", () => {
    assert.equal(GLOW_LOBES.length, 7);
    for (const l of GLOW_LOBES) {
      const mirror = GLOW_LOBES.filter((m) => m.x === -l.x && m.w === l.w && m.h === l.h && m.band === l.band);
      assert.equal(mirror.length, 1, `${l.x}`);
    }
  });

  test("the middle one the tallest and widest, stepping down outwards; about 260 px across", () => {
    const byDistance = [...GLOW_LOBES].sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
    assert.equal(byDistance[0].x, 0);
    for (let i = 1; i < byDistance.length; i++) {
      const [inner, outer] = [byDistance[i - 1], byDistance[i]];
      if (Math.abs(inner.x) === Math.abs(outer.x)) continue;
      assert.ok(outer.h < inner.h && outer.w < inner.w, `${outer.x}`);
    }
    const across = Math.max(...GLOW_LOBES.map((l) => l.x + l.w / 2)) - Math.min(...GLOW_LOBES.map((l) => l.x - l.w / 2));
    assert.ok(across > 250 && across <= GLOW_SPAN, `${across}`);
  });

  test("at the natural size one braille dot is 4 of the look's px: about 65 dots across, the tallest about 14 dots", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS);
    assert.deepEqual([g.pw, g.ph], [68, 16]);
    assert.equal(g.pw / GLOW_SPAN, 1 / PX_PER_DOT);
    const lobes = layoutLobes(g.pw, g.ph);
    const left = Math.min(...lobes.map((l) => l.cx - l.halfWidth / 1.2));
    const right = Math.max(...lobes.map((l) => l.cx + l.halfWidth / 1.2));
    assert.ok(Math.abs(right - left - 258 / 4) < 0.01, `${right - left}`);
    assert.ok(Math.abs(lobes[0].height - (46 * 1.25) / 4) < 0.01, `${lobes[0].height}`);
    for (const l of lobes) assert.ok(lobes.some((m) => Math.abs(m.cx + l.cx - g.pw) < 1e-9 && m.height === l.height));
  });

  test("a wide band stretches the set across it; a taller one makes the lobes taller", () => {
    const wide = layoutLobes(240, 16);
    assert.ok(Math.abs(wide[6].cx - wide[5].cx - (216 * 240) / GLOW_SPAN) < 1e-9);
    assert.equal(layoutLobes(68, 32)[0].height, 2 * layoutLobes(68, 16)[0].height);
  });

  for (const mode of ["listening", "speaking", "idle", "processing"] as const)
    test(`${mode}: the brightness mirrored about the middle`, () => {
      const g = glow("braille", GLOW_COLS, GLOW_ROWS);
      g.render({ time: 2.3, level: 0.7, mode: mode === "processing" ? "listening" : mode });
      for (let y = 0; y < g.ph; y++) for (let x = 0; x < g.pw / 2; x++) assert.ok(Math.abs(g.brightness(x, y) - g.brightness(g.pw - 1 - x, y)) < 1e-5, `${x},${y}`);
    });

  test("listening at full level: the middle reaches about its 14 dots, the outer lobes lower", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS);
    g.render({ time: 0, level: 1, mode: "listening", bands: [1, 1, 1] });
    /** How high the glow is lit around column `x`: the highest row (in dots up from the bottom) with a grain in x-2…x+2. */
    const reach = (x: number) => {
      for (let y = 0; y < g.ph; y++) for (let dx = -2; dx <= 2; dx++) if (g.lit(Math.round(x) + dx, y)) return g.ph - y;
      return 0;
    };
    const [middle, , , , , outer] = g.lobes;
    assert.ok(reach(middle.cx) >= 12 && reach(middle.cx) <= 16, `${reach(middle.cx)}`);
    assert.ok(reach(outer.cx) < reach(middle.cx), `${reach(outer.cx)}`);
  });
});

describe("colour", () => {
  test("each lobe in its own colour, in GLOW_LOBES' order, near its centre", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS);
    g.render({ time: 0, level: 0.8, mode: "listening" });
    g.lobes.forEach((l, i) => assert.equal(nearestOf(g.colorAt(Math.floor(l.cx), g.ph - 3), COLORFUL.colors), i, `lobe ${i}`));
  });

  test("between two lobes, a blend of both", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS);
    g.render({ time: 0, level: 0.8, mode: "listening" });
    // Halfway between the middle (pink) and the next one right (purple): a hue between theirs, clear of both.
    const x = Math.round((g.lobes[0].cx + g.lobes[2].cx) / 2);
    const blend = unpack(g.colorAt(x, g.ph - 2));
    const [pink, purple] = [COLORFUL.colors[0], COLORFUL.colors[2]];
    const span = hueGap(pink, purple);
    assert.ok(Math.abs(hueGap(blend, pink) + hueGap(blend, purple) - span) < 1, `${blend}`);
    assert.ok(hueGap(blend, pink) > span / 5 && hueGap(blend, purple) > span / 5, `${blend}`);
  });

  test("the beam in the colours of the lobes it passes", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS);
    g.render({ time: 0, level: 0, mode: "processing" });
    assert.equal(nearestOf(g.colorAt(Math.floor(g.lobes[5].cx), g.ph - 1), COLORFUL.colors), 5);
    assert.equal(nearestOf(g.colorAt(Math.floor(g.lobes[6].cx), g.ph - 1), COLORFUL.colors), 6);
  });

  test("the hues drift with time; mono's never", () => {
    const at = (palette = COLORFUL, time = 0) => {
      const g = glow("braille", GLOW_COLS, GLOW_ROWS, 24, palette);
      g.render({ time, level: 0.8, mode: "listening" });
      return unpack(g.colorAt(g.pw / 2, g.ph - 2));
    };
    // A quarter turn: the hues at their furthest, COLORFUL's 20° along.
    const gap = hueGap(at(COLORFUL, DRIFT_SECONDS / 4), at(COLORFUL, 0));
    assert.ok(gap > 12 && gap < 28, `${gap}`);
    assert.ok(hueGap(at(COLORFUL, DRIFT_SECONDS), at(COLORFUL, 0)) < 1);
    assert.ok(hueGap(at(mono, DRIFT_SECONDS / 4), at(mono, 0)) < 1);
  });

  test("mono: every grain a shade of Kiko's accent (its blue over green over red kept)", () => {
    const lines = renderGlow({ cols: 60, rows: 4, encoding: "braille", depth: 24, palette: mono, time: 1, level: 1, mode: "listening" }).join("");
    const codes = [...lines.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m.slice(1).map(Number));
    assert.ok(codes.length > 5);
    for (const [r, g, b] of codes) assert.ok(b >= g && g >= r, `${r},${g},${b}`);
  });

  test("light: its own colours (the middle yellow)", () => {
    const g = glow("braille", GLOW_COLS, GLOW_ROWS, 24, LIGHT);
    g.render({ time: 0, level: 0.8, mode: "listening" });
    assert.equal(nearestOf(g.colorAt(Math.floor(g.lobes[0].cx), g.ph - 3), LIGHT.colors), 0);
    assert.equal(paletteOf("light"), LIGHT);
    assert.equal(paletteOf("colorful"), COLORFUL);
    assert.deepEqual(paletteOf("mono").colors, mono.colors);
  });

  test("truecolor codes are the exact RGB", () => {
    assert.equal(sgrOf(0xff4678, 24), "\x1b[38;2;255;70;120m");
    assert.equal(sgrOf(0x3cbeff, 24, true), "\x1b[48;2;60;190;255m");
  });

  test("without truecolor: each colour's nearest xterm-256 colour", () => {
    for (const palette of [COLORFUL, LIGHT])
      for (const c of palette.colors) {
        const rgb = (c[0] << 16) | (c[1] << 8) | c[2];
        assert.equal(nearest256(rgb), to256(c), `${c}`);
        assert.equal(sgrOf(rgb, 256), `\x1b[38;5;${to256(c)}m`);
      }
    // A few by hand: the pink, the blue and the orange.
    assert.deepEqual([0xff4678, 0x3cbeff, 0xff9628].map(nearest256), [204, 75, 208]);
    const lines = renderGlow({ cols: 40, rows: 4, encoding: "braille", depth: 256, palette: COLORFUL, time: 0, level: 1, mode: "listening" }).join("");
    const used = new Set([...lines.matchAll(/38;5;(\d+)m/g)].map((m) => Number(m[1])));
    assert.ok(used.size >= 7, `${[...used]}`);
    assert.doesNotMatch(lines, /38;2;/);
  });
});

describe("dithering against the 4×4 Bayer matrix", () => {
  test("the matrix holds each of 0–15 once; thresholds sit between 0 and 1, tiled every 4", () => {
    assert.deepEqual(
      [...BAYER4].sort((a, b) => a - b),
      Array.from({ length: 16 }, (_, i) => i),
    );
    assert.equal(bayerThreshold(0, 0), 0.5 / 16);
    assert.equal(bayerThreshold(1, 0), 8.5 / 16);
    assert.equal(bayerThreshold(3, 3), 5.5 / 16);
    assert.equal(bayerThreshold(4, 4), bayerThreshold(0, 0));
    assert.equal(bayerThreshold(6, 5), bayerThreshold(2, 1));
  });

  for (const encoding of ["braille", "blocks"] as const) {
    test(`${encoding}: idle at level 0 lights nothing, whatever the time`, () => {
      const g = glow(encoding, 80, 4);
      for (const time of [0, 0.4, 3.3, 77]) {
        const lines = g.render({ time, level: 0, mode: "idle" });
        assert.equal(litAll(g), 0);
        for (const l of lines) assert.equal(plain(l).trim(), "");
      }
    });

    test(`${encoding}: a high level lights most of the bottom row, fewer going up`, () => {
      const g = glow(encoding, 120, 4);
      g.render({ time: 2.5, level: 1, mode: "listening" });
      const bottom = litShare(g, g.ph - 1);
      assert.ok(bottom > 0.6, `bottom row ${bottom}`);
      assert.ok(litShare(g, 0) < bottom, "the top row has fewer than the bottom");
    });

    test(`${encoding}: listening lights more as the level goes up, and a faint line at silence`, () => {
      const g = glow(encoding, 120, 4);
      const counts = [0, 0.3, 0.6, 1].map((level) => (g.render({ time: 4, level, mode: "listening" }), litAll(g)));
      assert.ok(counts[0] > 0, "listening at silence still shows");
      for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `${counts}`);
    });
  }

  test("processing: a beam that moves left to right along the bottom", () => {
    const g = glow("braille", 120, 4);
    const centre = (time: number) => {
      g.render({ time, level: 0, mode: "processing" });
      // The brightest part of the bottom rows: where the most pixels are lit in a window.
      let best = 0;
      let at = 0;
      for (let x = 0; x < g.pw - 12; x++) {
        let n = 0;
        for (let dx = 0; dx < 12; dx++) for (let y = g.ph - 4; y < g.ph; y++) if (g.lit(x + dx, y)) n++;
        if (n > best) [best, at] = [n, x];
      }
      return at;
    };
    const a = centre(0.6);
    const b = centre(1.2);
    assert.ok(b > a, `${a} then ${b}`);
  });

  test("speaking stays lower than loud listening", () => {
    const g = glow("braille", 120, 4);
    const top = (mode: GlowMode) => {
      g.render({ time: 3, level: 1, mode });
      return litShare(g, 0) + litShare(g, 1) + litShare(g, 2) + litShare(g, 3);
    };
    assert.ok(top("speaking") < top("listening"));
  });
});

describe("braille cells", () => {
  const dots = (rows: string[]) => rows.map((r) => [...r].map((c) => c === "#"));
  test("known patterns", () => {
    assert.equal(brailleOf(dots(["..", "..", "..", ".."])), " ");
    assert.equal(brailleOf(dots(["#.", "..", "..", ".."])), "⠁");
    assert.equal(brailleOf(dots([".#", "..", "..", ".."])), "⠈");
    assert.equal(brailleOf(dots(["#.", "#.", "#.", "#."])), "⡇");
    assert.equal(brailleOf(dots([".#", ".#", ".#", ".#"])), "⢸");
    assert.equal(brailleOf(dots(["..", "..", "..", "##"])), "⣀");
    assert.equal(brailleOf(dots(["##", "##", "##", "##"])), "⣿");
    assert.equal(brailleOf(dots(["#.", ".#", "#.", ".#"])), "⢕");
  });

  test("a frame's cells are its pixels, dot for dot", () => {
    const g = glow("braille", 16, 2, 0);
    const lines = g.render({ time: 1.1, level: 0.7, mode: "listening" });
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 16; c++) {
        const want = brailleOf(Array.from({ length: 4 }, (_, dy) => [g.lit(c * 2, r * 4 + dy), g.lit(c * 2 + 1, r * 4 + dy)]));
        assert.equal([...lines[r]][c], want);
      }
  });
});

describe("which encoding", () => {
  const depthOf = (env: NodeJS.ProcessEnv) => colorDepth({ isTTY: true }, env);
  test("truecolor (COLORTERM truecolor or 24bit): blocks", () => {
    assert.equal(chooseEncoding(depthOf({ TERM: "xterm-256color", COLORTERM: "truecolor" })), "blocks");
    assert.equal(chooseEncoding(depthOf({ TERM: "xterm-256color", COLORTERM: "24bit" })), "blocks");
  });
  test("no truecolor: braille", () => {
    assert.equal(chooseEncoding(depthOf({ TERM: "xterm-256color" })), "braille");
    assert.equal(chooseEncoding(depthOf({ TERM: "xterm-256color", NO_COLOR: "1", COLORTERM: "truecolor" })), "braille");
  });
  test("asked for: kept, except blocks without colour", () => {
    assert.equal(chooseEncoding(24, "braille"), "braille");
    assert.equal(chooseEncoding(256, "blocks"), "blocks");
    assert.equal(chooseEncoding(0, "blocks"), "braille");
    assert.equal(new DitherGlow({ cols: 10, rows: 2, encoding: "blocks", depth: 0, palette: COLORFUL }).encoding, "braille");
  });
});

describe("the level's envelope", () => {
  test("threshold and gain: silence under the threshold, stretched and held at 1 over it", () => {
    const o = { threshold: 0.3, gain: 2 };
    assert.equal(gated(0, o), 0);
    assert.equal(gated(0.3, o), 0);
    assert.ok(Math.abs(gated(0.44, o) - 0.4) < 1e-9);
    assert.equal(gated(0.9, o), 1);
    assert.equal(gated(Number.NaN, o), 0);
    assert.equal(gated(0.5, PLAIN_ENVELOPE), 0.5);
  });

  test("attack is quick, release slow", () => {
    const o = { threshold: 0, gain: 1, attackMs: 30, releaseMs: 300 };
    const up = envelope(0, 1, 30, o);
    assert.ok(Math.abs(up - (1 - Math.exp(-1))) < 1e-9);
    const down = envelope(1, 0, 30, o);
    assert.ok(down > 0.9 && down < 1, `${down}`);
  });

  test("it gets there, never past it; no time, no change", () => {
    let v = 0;
    for (let i = 0; i < 100; i++) v = envelope(v, 0.8, 33, PLAIN_ENVELOPE);
    assert.ok(v > 0.79 && v <= 0.8);
    for (let i = 0; i < 200; i++) v = envelope(v, 0, 33, PLAIN_ENVELOPE);
    assert.ok(v >= 0 && v < 0.01);
    assert.equal(envelope(0.4, 1, 0, PLAIN_ENVELOPE), 0.4);
  });

  test("the mic's: a quiet room is silence, talking lights it", () => {
    let v = 0;
    for (let i = 0; i < 30; i++) v = envelope(v, 0.2, 33, MIC_ENVELOPE);
    for (let i = 0; i < 30; i++) v = envelope(v, 0.35, 33, MIC_ENVELOPE);
    assert.equal(v, 0);
    for (let i = 0; i < 30; i++) v = envelope(v, 0.8, 33, MIC_ENVELOPE);
    assert.ok(v > 0.85, `${v}`);
  });

  test("the look's audio chain mapped on: attack 0.325, release 0.86 a frame at 60 fps; threshold 0.015 RMS; sensitivity 3.1", () => {
    assert.ok(Math.abs(perFrameToMs(0.325) - 42.4) < 0.1);
    assert.ok(Math.abs(perFrameToMs(1 - 0.86) - 110.5) < 0.1);
    assert.ok(Math.abs(levelOfRms(0.015) - 0.392) < 0.001);
    assert.equal(levelOfRms(1), 1);
    assert.equal(levelOfRms(0.0001), 0);
    assert.deepEqual(MIC_ENVELOPE, { threshold: 0.39, gain: 1.35, attackMs: 42, releaseMs: 111 });
    assert.deepEqual(PLAIN_ENVELOPE, { threshold: 0, gain: 1, attackMs: 42, releaseMs: 111 });
    // Full at the RMS where the look's level reaches 1: 0.015 + 1/3.1.
    assert.ok(gated(levelOfRms(0.015 + 1 / 3.1), MIC_ENVELOPE) > 0.99);
  });
});

describe("the demo", () => {
  test("flags", () => {
    const plain = { mic: false, encoding: undefined, rows: GLOW_ROWS, wide: false, colors: "colorful" };
    assert.deepEqual(glowDemoFlags([]), plain);
    assert.deepEqual(glowDemoFlags(["--mic", "--blocks", "--rows", "3"]), { ...plain, mic: true, encoding: "blocks", rows: 3 });
    assert.deepEqual(glowDemoFlags(["--braille", "--rows=2"]), { ...plain, encoding: "braille", rows: 2 });
    assert.deepEqual(glowDemoFlags(["--braille", "--wide", "--mono"]), { ...plain, encoding: "braille", wide: true, colors: "mono" });
    assert.deepEqual(glowDemoFlags(["--light"]), { ...plain, colors: "light" });
    assert.ok("error" in glowDemoFlags(["--mono", "--light"]));
    assert.ok("error" in glowDemoFlags(["--braille", "--blocks"]));
    assert.ok("error" in glowDemoFlags(["--rows", "0"]));
    assert.ok("error" in glowDemoFlags(["--rows", "two"]));
    assert.ok("error" in glowDemoFlags(["--loud"]));
  });

  test("the band: 34 × 4 centred by default, the whole width with --wide", () => {
    const flags = { rows: GLOW_ROWS, wide: false };
    assert.equal(GLOW_COLS, 34);
    assert.equal(GLOW_ROWS, 4);
    assert.deepEqual(glowBand(120, 40, flags), { cols: 34, rows: 4, left: 44 });
    assert.deepEqual(glowBand(35, 40, flags), { cols: 34, rows: 4, left: 1 });
    assert.deepEqual(glowBand(20, 40, flags), { cols: 20, rows: 4, left: 1 });
    assert.deepEqual(glowBand(120, 40, { ...flags, wide: true }), { cols: 120, rows: 4, left: 1 });
    assert.deepEqual(glowBand(120, 40, { rows: 8, wide: false }), { cols: 34, rows: 8, left: 44 });
    assert.deepEqual(glowBand(120, 5, { rows: 8, wide: false }), { cols: 34, rows: 2, left: 44 });
  });

  test("the script: idle, speech with pauses, processing, speaking, round again", () => {
    const seen = new Set<GlowMode>();
    let loud = 0;
    let quiet = 0;
    for (let t = 0; t < 16.5; t += 0.05) {
      const { mode, level } = scriptAt(t);
      seen.add(mode);
      assert.ok(level >= 0 && level <= 1);
      if (mode === "listening") level > 0.5 ? loud++ : level < 0.05 && quiet++;
    }
    assert.deepEqual([...seen], ["idle", "listening", "processing", "speaking"]);
    assert.ok(loud > 10 && quiet > 10, `${loud} loud, ${quiet} quiet`);
    assert.deepEqual(scriptAt(2.2), scriptAt(2.2 + 16.5));
  });

  test("a mode held keeps its voice going", () => {
    assert.equal(heldAt("processing", 3).level, 0);
    assert.ok([...Array(200).keys()].some((i) => heldAt("listening", 100 + i * 0.05).level > 0.5));
    assert.ok(heldAt("speaking", 50).level >= 0.3);
  });
});
