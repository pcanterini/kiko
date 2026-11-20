// The dithered voice glow (src/ui/dither-glow.ts, Voice Glow's dither look ported) and its input
// chain (src/ui/voice-envelope.ts): rows exactly as many and as wide as asked in both encodings;
// the grid (one braille dot one dither pixel at the phone's pitch, blocks at twice it); the
// original's geometry resolved for its two hosts; the lobes; the dither's rule; the modes (idle
// fades out, listening grows with the level and breathes at silence, a dome highest in the middle,
// processing's beam travelling and leaving dust); the reach fitted to a short band; colour (the
// filter, the drift, mono, light, xterm-256); braille cells (lit dots, the faint grid); the input
// chain's gate, saturation and envelope; and the demo's flags, band and script. Nothing here opens
// the mic or touches the terminal.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BAYER4,
  BRAILLE_DOTS,
  bayerThreshold,
  brailleOf,
  CELL_PX,
  COLORFUL,
  chooseEncoding,
  DitherGlow,
  ditherGeometry,
  ditherOn,
  GLOW_COLS,
  GLOW_ROWS,
  type GlowEncoding,
  type GlowMode,
  type GlowPalette,
  LIGHT,
  LOBE_SPAN,
  lifted,
  monoPalette,
  nearest256,
  PIXEL,
  reachFor,
  renderGlow,
  sgrOf,
  VOICE_LOBES,
} from "../../../src/ui/dither-glow.ts";
import { glowBand, glowDemoFlags, heldAt, paletteOf, scriptAt } from "../../../src/ui/glow-demo.ts";
import { BRAND, to256 } from "../../../src/ui/logo.ts";
import { BASE_GAIN, follow, micLevel, rmsOfLevel, shape, VOICE_INPUT } from "../../../src/ui/voice-envelope.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const cellsOf = (s: string) => [...plain(s)].length;
const mono = monoPalette(BRAND.accent);
const glow = (encoding: GlowEncoding = "braille", cols = GLOW_COLS, rows = GLOW_ROWS, depth: 0 | 256 | 24 = 24, palette: GlowPalette = COLORFUL) =>
  new DitherGlow({ cols, rows, encoding, depth, palette });

/** `seconds` of frames at 60 a second, the voice at `level` throughout: the glow's last frame. */
function play(g: DitherGlow, mode: GlowMode, level: number, seconds = 2, from = 0) {
  let lines: readonly string[] = [];
  const frames = Math.round(seconds * 60);
  for (let i = 0; i <= frames; i++) lines = g.render({ time: from + i / 60, level, mode });
  return lines;
}

function litAll(g: DitherGlow) {
  let n = 0;
  for (let y = 0; y < g.ph; y++) for (let x = 0; x < g.pw; x++) if (g.lit(x, y)) n++;
  return n;
}
function litRow(g: DitherGlow, y: number) {
  let n = 0;
  for (let x = 0; x < g.pw; x++) if (g.lit(x, y)) n++;
  return n;
}
/** How high the glow is lit in columns x…x+3: dots up from the bottom to its highest lit pixel. */
function heightAt(g: DitherGlow, x: number) {
  for (let y = 0; y < g.ph; y++) for (let dx = 0; dx < 4; dx++) if (g.lit(x + dx, y)) return g.ph - y;
  return 0;
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
          const lines = renderGlow({ cols, rows, encoding, depth: 24, palette: COLORFUL, time: 1.7, level: 0.8, mode, warmup: 0.5 });
          assert.equal(lines.length, rows);
          for (const l of lines) assert.equal(cellsOf(l), cols);
        }
      });

  test("the grid: one braille dot a dither pixel at the phone's pitch (3.2 px); blocks one half-block, twice the pitch, the same host", () => {
    assert.equal(CELL_PX, 3.2);
    const b = glow("braille", 30, 3);
    assert.deepEqual([b.pw, b.ph, b.cell], [60, 12, 3.2]);
    const k = glow("blocks", 30, 3);
    assert.deepEqual([k.pw, k.ph, k.cell], [30, 6, 6.4]);
    assert.equal(k.cw, b.cw);
  });

  test("the natural size: the phone's ~400 px across, 12 rows for its glow at full voice", () => {
    assert.equal(GLOW_COLS, 63);
    assert.equal(GLOW_ROWS, 12);
    const g = glow();
    assert.ok(Math.abs(g.cw - 400) < 4, `${g.cw}`);
  });

  test("resize: the new size from the next frame", () => {
    const g = glow("braille", 20, 2);
    g.resize(50, 3);
    const lines = g.render({ time: 0, level: 0.5, mode: "listening" });
    assert.equal(lines.length, 3);
    for (const l of lines) assert.equal(cellsOf(l), 50);
  });

  test("braille cells are braille or spaces; blocks cells are ▀ ▄ █ or spaces", () => {
    const b = renderGlow({ cols: 60, rows: 6, encoding: "braille", depth: 24, palette: COLORFUL, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(b.join(""))) assert.ok(ch === " " || (ch.codePointAt(0)! >= 0x2801 && ch.codePointAt(0)! <= 0x28ff), ch);
    const k = renderGlow({ cols: 60, rows: 6, encoding: "blocks", depth: 24, palette: COLORFUL, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(k.join(""))) assert.ok(" ▀▄█".includes(ch), ch);
  });

  test("without colour: no escape codes at all, and still the glow", () => {
    const lines = renderGlow({ cols: 40, rows: 6, encoding: "braille", depth: 0, palette: COLORFUL, time: 1, level: 1, mode: "listening" });
    for (const l of lines) assert.ok(!l.includes("\x1b"));
    assert.ok(lines.join("").trim().length > 0);
  });

  test("truecolor: exact RGB; 256 colours: xterm's", () => {
    const tc = renderGlow({ cols: 40, rows: 6, encoding: "blocks", depth: 24, palette: COLORFUL, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(tc, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.doesNotMatch(tc, /38;5;/);
    const x256 = renderGlow({ cols: 40, rows: 6, encoding: "blocks", depth: 256, palette: COLORFUL, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(x256, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(x256, /38;2;/);
  });
});

describe("the original's look", () => {
  test("seven lobes, symmetric about the middle, the middle tallest and widest; a 252 px ring", () => {
    assert.equal(VOICE_LOBES.length, 7);
    for (const l of VOICE_LOBES) assert.equal(VOICE_LOBES.filter((m) => m.x === -l.x && m.w === l.w && m.h === l.h && m.band === l.band).length, 1, `${l.x}`);
    const middle = VOICE_LOBES[0];
    for (const l of VOICE_LOBES.slice(1)) assert.ok(l.w < middle.w && l.h < middle.h);
    assert.equal(LOBE_SPAN, 252);
  });

  test("the dither on the phone: its tuning exactly (as resolveVoiceDefaults('mobile', 'dark', 'dither'))", () => {
    const g = ditherGeometry("mobile", "dark");
    assert.deepEqual(
      {
        scale: g.scale,
        reach: g.reach,
        spread: g.spread,
        flow: g.flow,
        bend: g.bend,
        glowWidth: g.glowWidth,
        glowHeight: g.glowHeight,
        bloomHeight: g.bloomHeight,
        softness: g.softness,
        rangeHeight: g.rangeHeight,
        pixelSize: g.pixelSize,
      },
      { scale: 1, reach: 3, spread: 0.9, flow: 56, bend: 19, glowWidth: 1.6, glowHeight: 3, bloomHeight: 0.3, softness: 0.84, rangeHeight: 0.85, pixelSize: 1 },
    );
    assert.deepEqual([g.bandStrength, g.bandWidth, g.bandPosition, g.bandSkew, g.bandOffset, g.bandTail, g.bandTailPosition], [1.05, 3, 0.5, 0, -50, 0.62, 0.21]);
  });

  test("the dither on the chat input: the phone's changes as ratios, then its own smaller cells", () => {
    const g = ditherGeometry("default", "dark");
    assert.deepEqual(
      [g.scale, g.spread, g.bandStrength, g.bandPosition, g.glowWidth, g.rangeHeight, g.softness, g.bend, g.bandWidth, g.bandSkew, g.pixelSize],
      [0.84, 1.4, 1.119, 0.44, 0.678, 0.708, 1.06, 58.286, 2.195, 0, 0.85],
    );
    // The light chat input starts taller and narrower.
    assert.equal(ditherGeometry("default", "light").reach, 1.8);
  });

  test("the dither's rule: lifted brightness against the Bayer threshold, a little scaled and raised", () => {
    assert.deepEqual(
      [...BAYER4].sort((a, b) => a - b),
      Array.from({ length: 16 }, (_, i) => i),
    );
    assert.equal(bayerThreshold(0, 0), 0.5 / 16);
    assert.equal(bayerThreshold(1, 0), 8.5 / 16);
    assert.equal(bayerThreshold(4, 4), bayerThreshold(0, 0));
    assert.ok(Math.abs(lifted(0.5) - 0.5 ** 0.65 * 1.15) < 1e-12);
    assert.equal(lifted(1), 1);
    // The faintest threshold: on from 0.0588, so a raw 0.01 (lifted 0.057) stays off.
    assert.equal(ditherOn(lifted(0.01), bayerThreshold(0, 0)), false);
    assert.equal(ditherOn(lifted(0.012), bayerThreshold(0, 0)), true);
    assert.equal(ditherOn(0.9, bayerThreshold(3, 1)), true);
  });
});

describe("the modes", () => {
  for (const encoding of ["braille", "blocks"] as const) {
    test(`${encoding}: idle shows nothing (closed), and fades out after listening`, () => {
      const g = glow(encoding, 80, 6);
      for (const line of play(g, "idle", 0.8, 1)) assert.equal(plain(line).trim(), "");
      play(g, "listening", 0.8, 1);
      assert.ok(litAll(g) > 0);
      for (const line of play(g, "idle", 0.8, 0.6, 1.1)) assert.equal(plain(line).trim(), "");
    });

    test(`${encoding}: listening lights more as the level goes up, and breathes at silence`, () => {
      const counts = [0, 0.1, 0.3, 1].map((level) => {
        const g = glow(encoding);
        play(g, "listening", level, 2);
        return litAll(g);
      });
      assert.ok(counts[0] > 0, "the idle glow at silence");
      for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], `${counts}`);
    });
  }

  test("a dome: highest in the middle, lower towards the sides", () => {
    const g = glow();
    play(g, "listening", 0.3, 2);
    const middle = heightAt(g, g.pw / 2 - 2);
    assert.ok(middle > 12, `${middle}`);
    assert.ok(heightAt(g, 4) < middle / 2, `${heightAt(g, 4)} at the side`);
    assert.ok(heightAt(g, g.pw - 8) < middle / 2, `${heightAt(g, g.pw - 8)} at the other`);
  });

  test("dense at the bottom, sparse at the top", () => {
    const g = glow();
    play(g, "listening", 0.6, 2);
    const bottom = litRow(g, g.ph - 1);
    assert.ok(bottom > 0.8 * g.pw, `${bottom}`);
    const top = Math.min(...Array.from({ length: g.ph }, (_, y) => (litRow(g, y) > 0 ? y : g.ph)));
    assert.ok(litRow(g, top) < 0.2 * g.pw, `${litRow(g, top)} lit in its top row`);
  });

  test("at full voice the glow fits: its top row never lit across, in the natural band or a short one", () => {
    for (const rows of [GLOW_ROWS, 6, 3]) {
      const g = glow("braille", GLOW_COLS, rows);
      play(g, "listening", 1, 2);
      assert.ok(litRow(g, 0) < 0.25 * g.pw, `${rows} rows: ${litRow(g, 0)} of ${g.pw}`);
    }
    assert.equal(reachFor(3, GLOW_ROWS), 3);
    assert.equal(reachFor(3, 24), 3);
    assert.equal(reachFor(3, 6), 1.25);
    assert.equal(reachFor(3, 1), 0.2);
  });

  test("processing: the beam travels across and leaves dust behind it", () => {
    const g = glow("braille", 120, 8);
    const centre = () => {
      let sum = 0;
      let n = 0;
      for (let y = 0; y < g.ph; y++)
        for (let x = 0; x < g.pw; x++)
          if (g.lit(x, y)) {
            sum += x;
            n++;
          }
      return n ? sum / n : Number.NaN;
    };
    play(g, "processing", 0, 0.5);
    const a = centre();
    play(g, "processing", 0, 0.6, 0.51);
    const b = centre();
    assert.ok(b > a + 10, `${a} then ${b}`);
    let dust = 0;
    for (let y = 0; y < g.ph; y++) for (let x = 0; x < g.pw; x++) if (g.pixel(x, y) === PIXEL.dust) dust++;
    assert.ok(dust > 0, "dust behind it");
    assert.ok(g.gather > 0.9);
  });

  test("speaking: the voice glow, following Kiko's voice", () => {
    const g = glow();
    play(g, "speaking", 0.6, 2);
    assert.ok(litAll(g) > 200);
    assert.ok(g.level > 0.5);
  });
});

describe("colour", () => {
  const colours = (lines: readonly string[]) => [...lines.join("").matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m.slice(1).map(Number));

  test("the colourful palette: many hues; the brightest pixels lifted towards white", () => {
    const g = glow();
    const cs = colours(play(g, "listening", 0.6, 2));
    assert.ok(new Set(cs.map((c) => c.join())).size > 30);
    assert.ok(
      cs.some(([r, gg, b]) => Math.min(r, gg, b) > 180),
      "a near-white core",
    );
    assert.ok(
      cs.some(([r, gg, b]) => b > 200 && r < 150 && gg < 200),
      "a blue",
    );
    assert.ok(
      cs.some(([r, gg, b]) => r > 200 && b > 150 && gg < 150),
      "a magenta",
    );
  });

  test("the hues drift ±24° over 12 s: -24° at the start, +24° at 6 s; mono's held", () => {
    const frame = (palette: GlowPalette, seconds: number) => play(glow("braille", GLOW_COLS, GLOW_ROWS, 24, palette), "listening", 0.5, seconds).join("\n");
    const held = (hueBase: number): GlowPalette => ({ ...COLORFUL, hueRange: 0, hueBase });
    assert.equal(frame(COLORFUL, 6), frame(held(24), 6));
    assert.notEqual(frame(COLORFUL, 6), frame(held(0), 6));
    assert.equal(frame(COLORFUL, 12), frame(held(-24), 12));
    assert.equal(mono.hueRange, 0);
    for (const [r, g, b] of colours(play(glow("braille", GLOW_COLS, GLOW_ROWS, 24, mono), "listening", 0.5, 2))) assert.ok(b >= g && g >= r, `${r},${g},${b}`);
  });

  test("light: mixed towards white, its own palette; the demo's palettes", () => {
    const cs = colours(play(glow("braille", GLOW_COLS, GLOW_ROWS, 24, LIGHT), "listening", 0.5, 2));
    assert.ok(cs.length > 20);
    assert.ok(cs.filter(([r, g, b]) => r + g + b > 450).length > cs.length / 3, "most of them light");
    assert.equal(paletteOf("light"), LIGHT);
    assert.equal(paletteOf("colorful"), COLORFUL);
    assert.deepEqual(paletteOf("mono").colors, mono.colors);
  });

  test("truecolor codes are the exact RGB", () => {
    assert.equal(sgrOf(0xff4678, 24), "\x1b[38;2;255;70;120m");
    assert.equal(sgrOf(0x3cbeff, 24, true), "\x1b[48;2;60;190;255m");
  });

  test("without truecolor: each colour's nearest xterm-256 colour", () => {
    for (const c of COLORFUL.colors) {
      const rgb = (c[0] << 16) | (c[1] << 8) | c[2];
      assert.equal(nearest256(rgb), to256(c), `${c}`);
      assert.equal(sgrOf(rgb, 256), `\x1b[38;5;${to256(c)}m`);
    }
    const lines = play(glow("braille", 60, 8, 256), "listening", 0.6, 1).join("");
    assert.ok(new Set([...lines.matchAll(/38;5;(\d+)m/g)].map((m) => m[1])).size >= 7);
    assert.doesNotMatch(lines, /38;2;/);
  });
});

describe("braille cells", () => {
  const dots = (rows: string[]) => rows.map((r) => [...r].map((c) => c === "#"));
  test("known patterns", () => {
    assert.equal(brailleOf(dots(["..", "..", "..", ".."])), " ");
    assert.equal(brailleOf(dots(["#.", "..", "..", ".."])), "⠁");
    assert.equal(brailleOf(dots([".#", "..", "..", ".."])), "⠈");
    assert.equal(brailleOf(dots(["#.", "#.", "#.", "#."])), "⡇");
    assert.equal(brailleOf(dots(["..", "..", "..", "##"])), "⣀");
    assert.equal(brailleOf(dots(["##", "##", "##", "##"])), "⣿");
  });

  test("a cell's dots are its lit pixels and dust; with neither, one in four of its faint grid", () => {
    const g = glow("braille", 63, 12, 0);
    const lines = play(g, "listening", 0.5, 2);
    let ghostCells = 0;
    for (let r = 0; r < 12; r++)
      for (let c = 0; c < 63; c++) {
        let lit = 0;
        let grid = 0;
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const k = g.pixel(c * 2 + dx, r * 4 + dy);
            if (k === PIXEL.lit || k === PIXEL.dust) lit |= BRAILLE_DOTS[dy][dx];
            else if (k === PIXEL.ghost && dx === 0 && dy % 2 === 0) grid |= BRAILLE_DOTS[dy][dx];
          }
        const want = lit || grid;
        if (!lit && grid) ghostCells++;
        assert.equal([...lines[r]][c].codePointAt(0), want ? 0x2800 + want : 32, `cell ${c},${r}`);
      }
    assert.ok(ghostCells > 0, "the faint grid shows somewhere");
  });
});

describe("which encoding", () => {
  test("braille by default, whatever the colours; blocks when asked, but not without colour", () => {
    assert.equal(chooseEncoding(24), "braille");
    assert.equal(chooseEncoding(256), "braille");
    assert.equal(chooseEncoding(24, "blocks"), "blocks");
    assert.equal(chooseEncoding(0, "blocks"), "braille");
    assert.equal(new DitherGlow({ cols: 10, rows: 2, encoding: "blocks", depth: 0, palette: COLORFUL }).encoding, "braille");
  });
});

describe("the input chain", () => {
  test("the original's settings", () => {
    assert.deepEqual(VOICE_INPUT, { sensitivity: 3.1, threshold: 0.015, attack: 0.325, release: 0.86, idle: 0.18, breatheDuration: 5.2 });
    assert.equal(BASE_GAIN, 5);
  });

  test("shape: silence at or under the threshold, then rounding off towards 1", () => {
    assert.equal(shape(0, 0.015), 0);
    assert.equal(shape(0.015, 0.015), 0);
    assert.equal(shape(Number.NaN, 0.015), 0);
    assert.ok(Math.abs(shape(1, 0) - 1) < 1e-12);
    assert.equal(shape(5, 0.015), 1);
    const half = shape(0.5, 0);
    assert.ok(Math.abs(half - (1 - Math.exp(-1.5)) / (1 - Math.exp(-3))) < 1e-12);
    assert.ok(half > 0.5, "a soft knee: above linear");
  });

  test("follow: the attack and release are time constants in seconds", () => {
    assert.ok(Math.abs(follow(0, 1, 0.325, 0.325, 0.86) - (1 - Math.exp(-1))) < 1e-12);
    assert.ok(Math.abs(follow(1, 0, 0.86, 0.325, 0.86) - Math.exp(-1)) < 1e-12);
    assert.equal(follow(0.4, 1, 0, 0.325, 0.86), 0.4);
  });

  test("the mic: levelOf's dB scale back to RMS, turned up as the original turns up a mic", () => {
    assert.equal(rmsOfLevel(0), 0);
    assert.ok(Math.abs(rmsOfLevel(1) - 1) < 1e-12);
    assert.ok(Math.abs(rmsOfLevel(2 / 3) - 0.1) < 1e-12, "-20 dB");
    assert.ok(Math.abs(micLevel(2 / 3) - 0.1 * 5 * 3.1) < 1e-12);
    // A quiet room (-55 dB) is nearly nothing; talking (-26 dB) close to full.
    assert.ok(shape(micLevel(5 / 60), VOICE_INPUT.threshold) < 0.05);
    assert.ok(shape(micLevel(34 / 60), VOICE_INPUT.threshold) > 0.85);
  });
});

describe("the demo", () => {
  test("flags", () => {
    const none = { mic: false, encoding: undefined, rows: GLOW_ROWS, wide: false, colors: "colorful" };
    assert.deepEqual(glowDemoFlags([]), none);
    assert.deepEqual(glowDemoFlags(["--mic", "--blocks", "--rows", "3"]), { ...none, mic: true, encoding: "blocks", rows: 3 });
    assert.deepEqual(glowDemoFlags(["--braille", "--rows=2"]), { ...none, encoding: "braille", rows: 2 });
    assert.deepEqual(glowDemoFlags(["--braille", "--wide", "--mono"]), { ...none, encoding: "braille", wide: true, colors: "mono" });
    assert.deepEqual(glowDemoFlags(["--light"]), { ...none, colors: "light" });
    assert.ok("error" in glowDemoFlags(["--mono", "--light"]));
    assert.ok("error" in glowDemoFlags(["--braille", "--blocks"]));
    assert.ok("error" in glowDemoFlags(["--rows", "0"]));
    assert.ok("error" in glowDemoFlags(["--rows", "two"]));
    assert.ok("error" in glowDemoFlags(["--loud"]));
  });

  test("the band: 63 × 12 centred by default, the whole width with --wide", () => {
    const flags = { rows: GLOW_ROWS, wide: false };
    assert.deepEqual(glowBand(120, 40, flags), { cols: 63, rows: 12, left: 29 });
    assert.deepEqual(glowBand(40, 40, flags), { cols: 40, rows: 12, left: 1 });
    assert.deepEqual(glowBand(120, 40, { ...flags, wide: true }), { cols: 120, rows: 12, left: 1 });
    assert.deepEqual(glowBand(120, 40, { rows: 4, wide: false }), { cols: 63, rows: 4, left: 29 });
    assert.deepEqual(glowBand(120, 8, flags), { cols: 63, rows: 5, left: 29 });
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
