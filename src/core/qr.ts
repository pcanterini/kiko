// A QR code encoder (ISO/IEC 18004), just what the phone's pairing code needs: byte mode, versions
// 1–40, all four error correction levels, the mask with the lowest penalty. No dependencies. It
// follows the standard's own steps (as Project Nayuki's reference encoder lays them out): the data
// bits, Reed-Solomon over GF(256), interleaving, the function patterns, the codewords in their
// zigzag, then each mask tried and scored. tests/unit/core/qr.test.ts decodes what it makes with an
// independent decoder (jsQR), version by version, and as the terminal draws it (qrCells).
//
// And how a terminal draws one: two modules per character cell, one above the other, so a module is
// about square at a terminal's usual 1:2 cell. A cell whose two modules match is only its background
// (no glyph at all), and one whose modules differ is "▀" in the top's colour on the bottom's: the
// code never depends on how a font draws a full block. Dark is black and light white, whatever the
// terminal's theme, with a light quiet zone around: always dark on light, as scanners expect.

export type Ecc = "L" | "M" | "Q" | "H";

export type Qr = {
  version: number;
  ecc: Ecc;
  mask: number;
  /** Modules per side: 17 + 4 × version. */
  size: number;
  /** [y][x], true for dark. */
  modules: boolean[][];
};

const ECC_ORDER: Ecc[] = ["L", "M", "Q", "H"];
/** The two format bits each level is written with. */
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// By level (L, M, Q, H), then version (index 0 unused).
const ECC_PER_BLOCK: Record<Ecc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<Ecc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Modules that carry data and its error correction (everything but the function patterns), in bits. */
function rawModules(version: number) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}

/** Data codewords (bytes) a version and level hold. */
function dataCodewords(version: number, ecc: Ecc) {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[ecc][version] * BLOCKS[ecc][version];
}

/** Bytes of byte-mode data a version and level hold. */
export function byteCapacity(version: number, ecc: Ecc) {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(version, ecc) * 8 - 4 - countBits) / 8);
}

/**
 * `text` (UTF-8, byte mode) as a QR code: the smallest version that holds it at `ecc` (L unless
 * said), then the strongest level that still fits that version (as many encoders do: more
 * correction for nothing). Throws when it's too long for version 40.
 */
export function encodeQr(text: string | Buffer, o: { ecc?: Ecc; boost?: boolean; mask?: number } = {}): Qr {
  const data = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const min = o.ecc ?? "L";
  let version = 1;
  while (version <= 40 && byteCapacity(version, min) < data.length) version++;
  if (version > 40) throw new Error(`too long for a QR code: ${data.length} bytes`);
  let ecc = min;
  if (o.boost !== false) for (const e of ECC_ORDER.slice(ECC_ORDER.indexOf(min) + 1)) if (byteCapacity(version, e) >= data.length) ecc = e;
  return build(version, ecc, data, o.mask);
}

// ── The data ────────────────────────────────────────────────────────────────

function codewords(version: number, ecc: Ecc, data: Buffer): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(data.length, version <= 9 ? 8 : 16);
  for (const b of data) put(b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length)); // the terminator
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** GF(256) multiplication, modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The Reed-Solomon generator polynomial of `degree`, its leading 1 left out. */
function rsDivisor(degree: number) {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: number[], divisor: number[]) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((coef, i) => (out[i] ^= gfMul(coef, factor)));
  }
  return out;
}

/** The data split into blocks, each with its error correction, then interleaved. */
function withEcc(version: number, ecc: Ecc, data: number[]) {
  const blocks = BLOCKS[ecc][version];
  const eccLen = ECC_PER_BLOCK[ecc][version];
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const block = [...dat];
    if (i < short) block.push(0); // a short block's gap, skipped below
    all.push([...block, ...rsRemainder(dat, divisor)]);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= short) out.push(block[i]);
    });
  }
  return out;
}

// ── The symbol ──────────────────────────────────────────────────────────────

function alignmentPositions(version: number, size: number) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

function build(version: number, ecc: Ecc, data: Buffer, fixedMask?: number): Qr {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing, finders (with their separators), alignment.
  for (let i = 0; i < size; i++) {
    fn(6, i, i % 2 === 0);
    fn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) fn(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const align = alignmentPositions(version, size);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  const bit = (v: number, i: number) => ((v >>> i) & 1) === 1;
  const format = (mask: number) => {
    const d = (FORMAT_BITS[ecc] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) fn(8, i, bit(bits, i));
    fn(8, 7, bit(bits, 6));
    fn(8, 8, bit(bits, 7));
    fn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) fn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) fn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) fn(8, size - 15 + i, bit(bits, i));
    fn(8, size - 8, true); // the dark module
  };
  format(0); // reserved now, written for real once the mask is chosen

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fn(a, b, bit(bits, i));
      fn(b, a, bit(bits, i));
    }
  }

  // The codewords, two columns at a time, up and down, right to left (skipping the timing column).
  const words = withEcc(version, ecc, codewords(version, ecc, data));
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < words.length * 8) {
          modules[y][x] = bit(words[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let flip: boolean;
        switch (mask) {
          case 0:
            flip = (x + y) % 2 === 0;
            break;
          case 1:
            flip = y % 2 === 0;
            break;
          case 2:
            flip = x % 3 === 0;
            break;
          case 3:
            flip = (x + y) % 3 === 0;
            break;
          case 4:
            flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            flip = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (flip) modules[y][x] = !modules[y][x];
      }
    }
  };

  let mask = fixedMask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      format(m);
      const score = penalty(modules);
      if (score < best) {
        best = score;
        mask = m;
      }
      applyMask(m); // undone
    }
  }
  applyMask(mask);
  format(mask);
  return { version, ecc, mask, size, modules };
}

/** The standard's penalty for a masked symbol: long runs, 2×2 blocks, finder-like patterns, imbalance. */
function penalty(modules: boolean[][]) {
  const size = modules.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let color = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const add = (length: number) => {
      if (history[0] === 0) length += size; // the light border before the first run
      history.pop();
      history.unshift(length);
    };
    const patterns = () => {
      const n = history[1];
      const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
      return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      if (get(i) === color) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score++;
      } else {
        add(run);
        if (!color) score += patterns() * 40;
        color = get(i);
        run = 1;
      }
    }
    if (color) {
      add(run);
      run = 0;
    }
    add(run + size);
    score += patterns() * 40;
  };
  for (let y = 0; y < size; y++) line((x) => modules[y][x]);
  for (let x = 0; x < size; x++) line((y) => modules[y][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// ── In a terminal ───────────────────────────────────────────────────────────

/** One character cell: its glyph (none, or the upper half block) and its two colours, dark or not. */
export type QrCell = { ch: " " | "▀"; fg: boolean; bg: boolean };

/** The standard's quiet zone: 4 modules of light all round. */
export const QUIET = 4;

/**
 * The code as character cells, two modules (one above the other) per cell, with `quiet` modules of
 * light all round: (size + 2 × quiet) wide and half as many rows, rounded up (the last row's bottom
 * half is quiet zone). A cell whose two modules match is only its background; one whose modules
 * differ is "▀", the top's colour on the bottom's.
 */
export function qrCells(qr: Qr, quiet = QUIET): QrCell[][] {
  const span = qr.size + quiet * 2;
  const at = (x: number, y: number) => {
    const mx = x - quiet;
    const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx];
  };
  const rows: QrCell[][] = [];
  for (let y = 0; y < span; y += 2) {
    const row: QrCell[] = [];
    for (let x = 0; x < span; x++) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      row.push(top === bottom ? { ch: " ", fg: top, bg: bottom } : { ch: "▀", fg: top, bg: bottom });
    }
    rows.push(row);
  }
  return rows;
}

/** The cells' modules again, as a scanner sees them: what a test decodes. [y][x], quiet zone included. */
export function cellsToModules(cells: QrCell[][]): boolean[][] {
  const out: boolean[][] = [];
  for (const row of cells) {
    out.push(row.map((c) => (c.ch === "▀" ? c.fg : c.bg)));
    out.push(row.map((c) => c.bg));
  }
  return out;
}

/** How many columns and rows the code takes in a terminal, quiet zone included. */
export function qrFootprint(qr: Qr, quiet = QUIET) {
  const span = qr.size + quiet * 2;
  return { columns: span, rows: Math.ceil(span / 2) };
}
