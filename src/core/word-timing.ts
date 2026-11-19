// When each word of a sentence is said, for a voice that doesn't say (Pocket): estimated from the
// sentence's own audio, for the phone's read-along (voice-marks.ts). Pocket says one sentence per
// request, so each sentence's audio is known exactly, start to end; within it:
//   - the speech itself is found by its loudness: Pocket starts each sentence with 0.3 to 0.9 s of
//     silence, and pauses up to 1.5 s after a short sentence ("Sure.");
//   - its long silences are matched to the text's punctuation (a sentence's end, a comma), in order,
//     where the words' estimated lengths put them;
//   - between those, the time is shared across the words by their estimated length (letters, with
//     a little for each syllable and each word).
// Moving each boundary to the quietest moment near it (the gap between two words) was tried and made
// it worse (p90 132 → 149 ms at best), so it isn't done.
// Every start is then pushed a little later (`lagMs`): a word that turns white just after it's
// begun reads fine, one that turns white before it's said doesn't. Measured on real Pocket audio
// against a forced aligner (scripts/perf/readalong-pocket.ts).
//
// Never throws, never NaN: no audio, silence, or no words give an even spread (or nothing).

/** A word's start and end, in samples from the start of the audio it was estimated in. */
export type TimedWord = { start: number; end: number };

/**
 * How much of the audio is used: `plain` shares all of it by word length; `trimmed` only the speech
 * in it (its silence at either end left out); `pauses` (the default) also ties its long silences to
 * the punctuation. The first two are only there to measure against.
 */
export type EstimateMode = "plain" | "trimmed" | "pauses";

export type EstimateOptions = { mode?: EstimateMode; lagMs?: number };

/**
 * How much later than estimated a word's start is given (ms): see the top. At 100 ms, on real Pocket
 * audio, 2.6 % of words turn white more than 100 ms before they begin, and the median word is 110 ms
 * late.
 */
export const LAG_MS = 100;

const FRAME_S = 0.01;
// A silence this long (s) inside the speech can be a pause between words or phrases.
const MIN_PAUSE_S = 0.1;

/** Syllables in a word, roughly: its groups of vowels (a silent final e left out), at least one. */
export function syllables(word: string): number {
  const w = word
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (!w) return 0;
  // Digits: about one syllable each ("42": "forty two" is three; close enough).
  const digits = (w.match(/\p{N}/gu) ?? []).length;
  const letters = w.replace(/\p{N}/gu, "");
  let groups = (letters.match(/[aeiouy]+/g) ?? []).length;
  if (groups > 1 && /[^aeiouy]e$/.test(letters) && !/le$/.test(letters)) groups--;
  // A word with letters but none of those vowels ("tmux" respelled is fine; "A", "P", "I" are one).
  if (letters && !groups) groups = Math.max(1, Math.ceil(letters.length / 3));
  return Math.max(1, groups + digits);
}

/**
 * A word's estimated length, in shares of the sentence's speech. Fitted on Pocket's own words
 * (scripts/perf/readalong-pocket.ts): about 48 ms a letter, plus a little a syllable and a word; a
 * capital letter on its own ("A P I") is said as a whole syllable, about three letters' worth.
 */
export function weightOf(word: string): number {
  const bare = word.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
  if (!bare) return 0.15;
  const letters = /^\p{Lu}$/u.test(bare) && bare !== "I" ? 3 : [...bare].length;
  return 0.25 + 0.43 * syllables(word) + letters;
}

/** The pause the text allows after a word: 2 at a sentence's end, 1 at a clause's, 0 elsewhere. */
export function breakAfter(word: string): number {
  const w = word.replace(/["'”’)\]]+$/u, "");
  if (/[.!?…]$/u.test(w)) return 2;
  if (/[,;:—–]$/u.test(w) || /^[—–-]$/u.test(w)) return 1;
  return 0;
}

/** Loudness per 10 ms frame, in dB (−100 for digital silence). */
export function levels(pcm: Int16Array, rate: number): number[] {
  const size = Math.max(1, Math.round(rate * FRAME_S));
  const n = Math.floor(pcm.length / size);
  const out: number[] = new Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) {
      const x = pcm[i] / 32768;
      sum += x * x;
    }
    const mean = sum / size;
    out[f] = mean > 1e-10 ? 10 * Math.log10(mean) : -100;
  }
  return out;
}

const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);

/**
 * When each of `words` starts and ends in `pcm` (mono, `rate` Hz), in samples. One entry per word,
 * in order, each start at or after the one before, all within the audio.
 */
export function estimateWords(words: string[], pcm: Int16Array, rate: number, o: EstimateOptions = {}): TimedWord[] {
  if (!words.length) return [];
  const total = pcm.length;
  const mode = o.mode ?? "pauses";
  const lag = Math.round((finite(o.lagMs ?? LAG_MS) / 1000) * rate);
  const weights = words.map(weightOf);
  const frame = Math.max(1, Math.round(rate * FRAME_S));
  const db = mode === "plain" ? [] : levels(pcm, rate);
  const speech = mode === "plain" ? null : speechIn(db);
  const from = speech ? speech.from * frame : 0;
  const to = speech ? Math.min(total, speech.to * frame) : total;
  // The stretches the words are shared over: the whole speech, or it cut at the pauses tied to punctuation.
  let cuts: Array<{ word: number; from: number; to: number }> = [];
  if (mode === "pauses" && speech) cuts = tiePauses(words, weights, speech.gaps, speech.from, speech.to).map((c) => ({ word: c.word, from: c.from * frame, to: c.to * frame }));
  const starts: number[] = new Array(words.length).fill(0);
  const ends: number[] = new Array(words.length).fill(0);
  let first = 0;
  let at = from;
  for (const stretch of [...cuts, { word: words.length - 1, from: to, to }]) {
    const last = Math.min(words.length - 1, Math.max(first, stretch.word));
    share(weights, first, last, at, Math.max(at, stretch.from), starts, ends);
    first = last + 1;
    at = Math.max(at, stretch.to);
    if (first >= words.length) break;
  }
  // Words left (only when a cut came after the last word: it can't): at the end.
  for (let i = first; i < words.length; i++) starts[i] = ends[i] = to;
  const out: TimedWord[] = [];
  let prev = 0;
  for (let i = 0; i < words.length; i++) {
    const start = Math.min(total, Math.max(prev, Math.round(finite(starts[i]) + lag)));
    const end = Math.min(total, Math.max(start, Math.round(finite(ends[i]))));
    out.push({ start, end });
    prev = start;
  }
  return out;
}

/** Words `first`…`last` across [from, to), each by its weight. */
function share(weights: number[], first: number, last: number, from: number, to: number, starts: number[], ends: number[]) {
  let sum = 0;
  for (let i = first; i <= last; i++) sum += weights[i];
  let at = from;
  for (let i = first; i <= last; i++) {
    const len = sum > 0 ? ((to - from) * weights[i]) / sum : (to - from) / (last - first + 1);
    starts[i] = at;
    at += len;
    ends[i] = at;
  }
}

/**
 * Where the speech is (frames): its first and last loud frame, and the silences inside it at least
 * MIN_PAUSE_S long. Null when there's none (silence, or no audio).
 */
export function speechIn(db: number[]): { from: number; to: number; gaps: Array<{ from: number; to: number }> } | null {
  if (!db.length) return null;
  const sorted = [...db].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? -100;
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -100;
  // Speech: well above the quiet, and not too far under its loudest. Pocket's silence is near −80 dB.
  const threshold = Math.max(floor + 12, loud - 27, -62);
  if (loud < threshold) return null;
  let from = -1;
  let to = -1;
  for (let f = 0; f < db.length; f++) {
    if (db[f] < threshold) continue;
    if (from < 0) from = f;
    to = f + 1;
  }
  if (from < 0) return null;
  const minGap = Math.round(MIN_PAUSE_S / FRAME_S);
  const gaps: Array<{ from: number; to: number }> = [];
  let start = -1;
  for (let f = from; f < to; f++) {
    if (db[f] < threshold) {
      if (start < 0) start = f;
    } else if (start >= 0) {
      if (f - start >= minGap) gaps.push({ from: start, to: f });
      start = -1;
    }
  }
  return { from, to, gaps };
}

/**
 * The silences (frames) tied to the words they come after, in order: each silence either goes to a
 * boundary between two words or to none (a breath, a stop inside a word), whichever fits best
 * (dynamic programming over both lists). A silence fits a boundary where the text allows a pause
 * (a sentence's end best) and where the words' estimated lengths put it; a long one left untied, or
 * a sentence's end with no silence, costs. Returns the tied ones: the word before, and the silence.
 */
export function tiePauses(words: string[], weights: number[], gaps: Array<{ from: number; to: number }>, from: number, to: number): Array<{ word: number; from: number; to: number }> {
  const n = words.length;
  if (n < 2 || !gaps.length) return [];
  // Where each boundary falls, as a share of the words' weight; where each gap falls, as a share of the speech (gaps left out).
  const totalW = weights.reduce((a, b) => a + b, 0) || 1;
  const bounds: Array<{ word: number; at: number; kind: number }> = [];
  let w = 0;
  for (let i = 0; i < n - 1; i++) {
    w += weights[i];
    bounds.push({ word: i, at: w / totalW, kind: breakAfter(words[i]) });
  }
  const silent = gaps.reduce((a, g) => a + (g.to - g.from), 0);
  const voiced = Math.max(1, to - from - silent);
  let before = 0;
  let prevEnd = from;
  const spots = gaps.map((g) => {
    before += g.from - prevEnd;
    prevEnd = g.to;
    return { at: before / voiced, len: (g.to - g.from) * FRAME_S };
  });
  // Costs: how far a gap is from where the words put the boundary, and what the text allows there.
  // (Tried wider: the results hardly move.)
  const placeCost = (s: { at: number; len: number }, b: { at: number; kind: number }) => Math.abs(s.at - b.at) * 4 + (b.kind === 2 ? 0 : b.kind === 1 ? 0.05 : s.len >= 0.25 ? 1 : 0.6);
  const untiedCost = (s: { len: number }) => (s.len >= 0.3 ? 1.2 : s.len >= 0.18 ? 0.7 : 0.35);
  const missedCost = (b: { kind: number }) => (b.kind === 2 ? 0.5 : 0);
  const G = spots.length;
  const B = bounds.length;
  // best[g][b]: the cheapest for the first g gaps and the first b boundaries.
  const best: number[][] = Array.from({ length: G + 1 }, () => new Array(B + 1).fill(Infinity));
  const how: number[][] = Array.from({ length: G + 1 }, () => new Array(B + 1).fill(0));
  best[0][0] = 0;
  for (let g = 0; g <= G; g++) {
    for (let b = 0; b <= B; b++) {
      const here = best[g][b];
      if (!Number.isFinite(here)) continue;
      // Boundary b without a gap.
      if (b < B && here + missedCost(bounds[b]) < best[g][b + 1]) {
        best[g][b + 1] = here + missedCost(bounds[b]);
        how[g][b + 1] = 1;
      }
      // Gap g untied.
      if (g < G && here + untiedCost(spots[g]) < best[g + 1][b]) {
        best[g + 1][b] = here + untiedCost(spots[g]);
        how[g + 1][b] = 2;
      }
      // Gap g at boundary b.
      if (g < G && b < B) {
        const c = here + placeCost(spots[g], bounds[b]);
        if (c < best[g + 1][b + 1]) {
          best[g + 1][b + 1] = c;
          how[g + 1][b + 1] = 3;
        }
      }
    }
  }
  const tied: Array<{ word: number; from: number; to: number }> = [];
  let g = G;
  let b = B;
  while (g > 0 || b > 0) {
    const step = how[g][b];
    if (step === 3) {
      tied.unshift({ word: bounds[b - 1].word, from: gaps[g - 1].from, to: gaps[g - 1].to });
      g--;
      b--;
    } else if (step === 2) g--;
    else if (step === 1) b--;
    else break;
  }
  return tied;
}
