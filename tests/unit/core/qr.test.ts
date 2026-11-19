// The QR code encoder (src/core/qr.ts) and the pairing screen's drawing of it (src/ui/pair-phone.ts),
// each checked by decoding what comes out with an independent decoder (jsQR): every level across a
// range of versions, all eight masks, the capacity at each edge, and the code as the terminal gets it
// (Ink's output, its 24-bit colours read back cell by cell), at the standard quiet zone and the
// narrower one a small window gets.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import jsQRModule from "jsqr";
import { byteCapacity, cellsToModules, encodeQr, qrCells, qrFootprint, QUIET, type Ecc } from "../../../src/core/qr.ts";
import { relayVectors } from "../../../scripts/relay-vectors.ts";

/** What a phone's camera would read from these modules ([y][x], quiet zone included): jsQR on a clean image. */
function scan(modules: boolean[][], scale = 4): string | null {
  const height = modules.length * scale;
  const width = modules[0].length * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = modules[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

/** The symbol with a light quiet zone round it, as a plain module grid. */
function framed(modules: boolean[][], quiet = QUIET) {
  const size = modules.length + quiet * 2;
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => modules[y - quiet]?.[x - quiet] ?? false));
}

// jsQR is CommonJS: its function is module.exports.default (Node hands module.exports over as the default).
const jsQR = jsQRModule.default;

const text = (n: number) => Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789:/?&=._-"[(i * 7 + n) % 44]).join("");

test("every level, versions 1 to 25: what's encoded decodes to the same text", () => {
  for (const ecc of ["L", "M", "Q", "H"] as Ecc[]) {
    for (let version = 1; version <= 25; version += version < 12 ? 1 : 3) {
      const n = byteCapacity(version, ecc);
      const t = text(n);
      const qr = encodeQr(t, { ecc, boost: false });
      assert.equal(qr.version, version, `${n} bytes at ${ecc} is version ${version}`);
      assert.equal(qr.size, 17 + 4 * version);
      assert.equal(scan(framed(qr.modules)), t, `version ${version} ${ecc}`);
    }
  }
});

test("the smallest version that holds it: one byte past a version's capacity is the next", () => {
  for (const version of [1, 5, 9, 10, 15]) {
    const n = byteCapacity(version, "M");
    assert.equal(encodeQr(text(n), { ecc: "M", boost: false }).version, version);
    assert.equal(encodeQr(text(n + 1), { ecc: "M", boost: false }).version, version + 1);
  }
  assert.throws(() => encodeQr("x".repeat(3000)), /too long/);
});

test("boosted: the strongest level that still fits the version, never a bigger symbol", () => {
  const plain = encodeQr("sh.kiko.ios://pair?v=1", { boost: false });
  const boosted = encodeQr("sh.kiko.ios://pair?v=1");
  assert.equal(boosted.version, plain.version);
  // 22 bytes: version 2 holds 32 at L, 26 at M, 20 at Q.
  assert.deepEqual([plain.version, plain.ecc, boosted.ecc], [2, "L", "M"]);
  assert.equal(scan(framed(boosted.modules)), "sh.kiko.ios://pair?v=1");
});

test("all eight masks decode, and the one chosen is one of them", () => {
  for (let mask = 0; mask < 8; mask++) {
    const t = `mask ${mask}: ${text(60)}`;
    const qr = encodeQr(t, { mask });
    assert.equal(qr.mask, mask);
    assert.equal(scan(framed(qr.modules)), t);
  }
  assert.ok(encodeQr(text(40)).mask >= 0);
});

test("UTF-8 in byte mode (a Mac's name can have any letters)", () => {
  const t = "Kiko on Alex’s MacBook — São Paulo";
  assert.equal(scan(framed(encodeQr(t).modules)), t);
});

test("in a terminal: two modules a cell, a light quiet zone, and the cells give the modules back", () => {
  const qr = encodeQr(text(100));
  for (const quiet of [QUIET, 2]) {
    const cells = qrCells(qr, quiet);
    const f = qrFootprint(qr, quiet);
    assert.equal(cells.length, f.rows);
    assert.ok(cells.every((r) => r.length === f.columns));
    // Only a background where the two modules match, the upper half block where they differ.
    for (const r of cells) for (const c of r) assert.equal(c.ch === "▀", c.fg !== c.bg);
    const back = cellsToModules(cells);
    // The quiet zone is light all round.
    assert.ok(back[0].every((m) => !m) && back.every((r) => !r[0]));
    assert.equal(scan(back), text(100), `quiet ${quiet}`);
  }
});

/** Ink's output read back: each cell's top from its glyph's colour (▀) or its background, its bottom from the background. */
function modulesFromAnsi(out: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of out.split("\n")) {
    if (!line.includes("\x1b[48;2;")) continue;
    let fg: boolean | null = null;
    let bg: boolean | null = null;
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
      if (sgr) {
        const n = sgr[1].split(";").map(Number);
        if (n[0] === 38 && n[1] === 2) fg = n[2] === 0;
        else if (n[0] === 48 && n[1] === 2) bg = n[2] === 0;
        else if (n[0] === 39) fg = null;
        else if (n[0] === 49) bg = null;
        continue;
      }
      for (const ch of part) {
        if (bg === null) continue; // outside the code (its centring)
        top.push(ch === "▀" ? fg! : bg);
        bottom.push(bg);
      }
    }
    rows.push(top, bottom);
  }
  return rows;
}

test("the pairing screen as the terminal gets it (Ink, 24-bit colour) scans back to the pairing URL, black on white", async () => {
  const before = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "3";
  try {
    const React = (await import("react")).default;
    const { renderToString } = await import("ink");
    const { PairPhone, quietThatFits } = await import("../../../src/ui/pair-phone.ts");
    const { url } = relayVectors().local.qr;
    const qr = encodeQr(url);
    const draw = (width: number, height: number) =>
      renderToString(React.createElement(PairPhone, { p: { phase: "showing", qr, code: "482913", until: Date.now() + 300_000 }, width, height }), { columns: width });
    // Room for the standard quiet zone; then a window just big enough for the narrower one.
    const roomy = draw(100, 45);
    assert.equal(quietThatFits(qr, 100, 45), QUIET);
    // Only black and white are drawn in the code, whatever the theme.
    for (const m of roomy.matchAll(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/g)) assert.ok(["0,0,0", "255,255,255"].includes(m.slice(1).join(",")), m[0]);
    assert.equal(scan(modulesFromAnsi(roomy)), url);
    assert.match(roomy, /Scan with the Kiko app \(or the iPhone Camera\)/);
    assert.match(roomy, /Works for 5 minutes, one phone/);
    assert.match(roomy, /No camera\? Code: .*482 913/);
    const tight = qrFootprint(qr, 2);
    assert.equal(quietThatFits(qr, tight.columns, tight.rows + 3), 2);
    assert.equal(scan(modulesFromAnsi(draw(tight.columns, tight.rows + 3))), url);
    // Too small for either: no half-drawn code, but what to do and the typed code.
    const small = draw(50, 20);
    assert.ok(!small.includes("▀"));
    assert.match(small, /Make this window bigger to show the QR code/);
    assert.match(small, /482 913/);
  } finally {
    if (before === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = before;
  }
});
