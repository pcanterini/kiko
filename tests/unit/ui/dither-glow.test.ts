// The dithered voice glow (src/ui/dither-glow.ts) and its level's envelope (src/ui/voice-envelope.ts):
// rows exactly as many and as wide as asked in both encodings; nothing lit in idle at level 0, the
// bottom mostly lit at a high level, more lit as the level goes up; the Bayer matrix's thresholds;
// braille's dot bits; the encoding falling back to braille without truecolor; the envelope's
// threshold, gain, attack and release; and the demo's flags and script. Nothing here opens the mic
// or touches the terminal.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorDepth } from "../../../src/ui/cli-style.ts";
import { BAYER4, bayerThreshold, brailleOf, chooseEncoding, DitherGlow, renderGlow, type GlowEncoding, type GlowMode } from "../../../src/ui/dither-glow.ts";
import { glowDemoFlags, heldAt, scriptAt } from "../../../src/ui/glow-demo.ts";
import { BRAND } from "../../../src/ui/logo.ts";
import { envelope, gated, MIC_ENVELOPE, PLAIN_ENVELOPE } from "../../../src/ui/voice-envelope.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const cellsOf = (s: string) => [...plain(s)].length;
const glow = (encoding: GlowEncoding, cols = 40, rows = 4, depth: 0 | 256 | 24 = 24) => new DitherGlow({ cols, rows, encoding, depth, color: BRAND.accent });

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
          const lines = renderGlow({ cols, rows, encoding, depth: 24, color: BRAND.accent, time: 1.7, level: 0.8, mode });
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
    const b = renderGlow({ cols: 60, rows: 4, encoding: "braille", depth: 24, color: BRAND.accent, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(b.join(""))) assert.ok(ch === " " || (ch.codePointAt(0)! >= 0x2801 && ch.codePointAt(0)! <= 0x28ff), ch);
    const k = renderGlow({ cols: 60, rows: 4, encoding: "blocks", depth: 24, color: BRAND.accent, time: 2, level: 1, mode: "listening" });
    for (const ch of plain(k.join(""))) assert.ok(" ▀▄█".includes(ch), ch);
  });

  test("without colour: no escape codes at all", () => {
    const lines = renderGlow({ cols: 40, rows: 3, encoding: "braille", depth: 0, color: BRAND.accent, time: 1, level: 1, mode: "listening" });
    for (const l of lines) assert.ok(!l.includes("\x1b"));
    assert.ok(lines.join("").trim().length > 0);
  });

  test("truecolor: the accent's own shades; 256 colours: xterm's", () => {
    const tc = renderGlow({ cols: 40, rows: 3, encoding: "blocks", depth: 24, color: BRAND.accent, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(tc, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.doesNotMatch(tc, /38;5;/);
    const x256 = renderGlow({ cols: 40, rows: 3, encoding: "blocks", depth: 256, color: BRAND.accent, time: 1, level: 1, mode: "listening" }).join("");
    assert.match(x256, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(x256, /38;2;/);
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
    assert.equal(new DitherGlow({ cols: 10, rows: 2, encoding: "blocks", depth: 0, color: BRAND.accent }).encoding, "braille");
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
    assert.equal(v, 0);
    for (let i = 0; i < 30; i++) v = envelope(v, 0.65, 33, MIC_ENVELOPE);
    assert.ok(v > 0.7, `${v}`);
  });
});

describe("the demo", () => {
  test("flags", () => {
    assert.deepEqual(glowDemoFlags([]), { mic: false, encoding: undefined, rows: 4 });
    assert.deepEqual(glowDemoFlags(["--mic", "--blocks", "--rows", "3"]), { mic: true, encoding: "blocks", rows: 3 });
    assert.deepEqual(glowDemoFlags(["--braille", "--rows=2"]), { mic: false, encoding: "braille", rows: 2 });
    assert.ok("error" in glowDemoFlags(["--braille", "--blocks"]));
    assert.ok("error" in glowDemoFlags(["--rows", "0"]));
    assert.ok("error" in glowDemoFlags(["--rows", "two"]));
    assert.ok("error" in glowDemoFlags(["--loud"]));
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
