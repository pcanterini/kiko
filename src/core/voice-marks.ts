// When each word of a spoken line is said, for the phone's read-along (its Talking to Kiko screen
// draws the words grey, turning white as each is said). One VoiceLine per line said (app/speech.ts
// openSpeech), fed by the line's own text and voice:
//   - the words as written (on screen) and as said (respelled for the voice: "nginx" said as
//     "engine-x", "kiko.sh" as "kiko dot S H"), from the respeller (pronunciation.ts respoken);
//   - its audio as it comes, counted in samples from the line's start: every chunk gets its place
//     (`audio()`), which goes with it to the phones, so the phone knows exactly which sample of
//     which line it's playing (remote/server.ts, `voice_marks` `sync`);
//   - the voice's own word times where it gives them (Cartesia's timestamps, exact), or the
//     sentences it was asked for one at a time (Pocket: each sentence's audio, start to end,
//     exact), within which the words are estimated (word-timing.ts);
//   - for the macOS voice, which the phone says itself: where each written word is in the text the
//     phone says (UTF-16 offsets), so its synthesizer's own word callbacks find it.
// What the voice says is matched back to the written words letter by letter (lowercased, accents
// and punctuation dropped), so a word respelled into several ("kiko dot S H") or several said as
// one is still the word on screen, and a word the voice said differently (a number read out) is
// skipped rather than throwing the rest off. What's known goes to the phones (`send`) as it's known.
import { TTS_SAMPLE_RATE } from "./config.ts";
import type { SaidWord } from "./pronunciation.ts";
import { estimateWords } from "./word-timing.ts";

/** Where a chunk of a line's audio is: the line, and its first sample's place in it. */
export type VoicePos = { line: number; at: number };

/**
 * A word of a line, by its place among the line's written words (split on white space, as the
 * phone splits the text it shows): when it's said, in samples from the line's start (`start`,
 * `end`), or where it is in the text the phone says itself (`from`, `to`).
 */
export type MarkWord = { i: number; text: string; start?: number; end?: number; from?: number; to?: number };

/** What the phones are told of a line's words: exact (the voice said when), or estimated. */
export type LineMarks = { line: number; words: MarkWord[]; exact: boolean };

/** What a voice tells a line about its words, as it says them (TtsHandlers.marks). */
export type VoiceTimings = {
  /** Pocket: the next audio is this sentence's (as it was sent: respelled, its Markdown out). */
  sentence(text: string): void;
  /** Pocket: all of the sentence's audio came. */
  sentenceDone(): void;
  /** Cartesia's word timestamps: each word said, its start and end in seconds of the line's audio. */
  timestamps(words: string[], starts: number[], ends: number[]): void;
};

// Lines are numbered from a random start, so a phone that stays connected across a restart of the
// Mac never takes a new line for an old one.
let nextLine = 1 + Math.floor(Math.random() * 1_000_000_000);
export const newLineId = () => {
  const id = nextLine;
  nextLine = nextLine >= 2_000_000_000 ? 1 : nextLine + 1;
  return id;
};

/** A word's letters, as the matching compares them: lowercase, no accents, no punctuation. */
export const lettersOf = (word: string) =>
  word
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

// How far ahead (letters) a word the voice said is looked for: past a few the voice left out.
const LOOK_AHEAD = 80;
// Estimated words wait this long (ms) to go with the next, so a line is a few messages, not many.
const SEND_MS = 40;

const finiteSamples = (x: number) => (Number.isFinite(x) && x >= 0 ? Math.round(x) : null);

export class VoiceLine implements VoiceTimings {
  readonly id: number;
  private send: (m: LineMarks) => void;
  private rate: number;
  // The written words, and the said text's letters with whose each is (owner) and where each starts.
  private written: string[] = [];
  private firstLetter: number[] = [];
  private lastLetter: number[] = [];
  private letters = "";
  private owner: number[] = [];
  // The text said, as it went to the voice, and each written word's place in it.
  private said = "";
  private saidAt: Array<[number, number]> = [];
  // Letters already matched to what the voice said.
  private cursor = 0;
  private samples = 0;
  private sentenceOpen: { text: string; start: number; pcm: Buffer[] } | null = null;
  // Cartesia's times, if a later batch starts over from 0 (seconds added).
  private timeBase = 0;
  private lastStart = 0;
  private lastEnd = 0;
  private known = new Map<number, { start: number; end: number }>();
  private pending: { words: MarkWord[]; exact: boolean } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(send: (m: LineMarks) => void, o: { id?: number; rate?: number } = {}) {
    this.id = o.id ?? newLineId();
    this.send = send;
    this.rate = o.rate ?? TTS_SAMPLE_RATE;
  }

  /** Words went to the voice: as written and as said (`said`: the piece said, its words' offsets in it). */
  wrote = (words: SaidWord[], said: string) => {
    const base = this.said.length;
    for (const w of words) {
      const i = this.written.length;
      this.written.push(w.written);
      this.saidAt.push([base + w.at, base + w.at + w.said.length]);
      this.firstLetter.push(this.letters.length);
      for (const part of w.said.split(/\s+/)) {
        const l = lettersOf(part);
        this.letters += l;
        for (let k = 0; k < l.length; k++) this.owner.push(i);
      }
      this.lastLetter.push(this.letters.length - 1);
    }
    this.said += said;
  };

  /** A chunk of the line's audio, as it goes to be played: its place in the line (the phones get it with it). */
  audio(pcm: Buffer): VoicePos {
    const at = this.samples;
    this.samples += Math.floor(pcm.length / 2);
    this.sentenceOpen?.pcm.push(pcm);
    return { line: this.id, at };
  }

  sentence(text: string) {
    this.sentenceDone();
    this.sentenceOpen = { text, start: this.samples, pcm: [] };
  }

  sentenceDone() {
    const s = this.sentenceOpen;
    if (!s) return;
    this.sentenceOpen = null;
    const words = s.text.split(/\s+/).filter(Boolean);
    const joined = Buffer.concat(s.pcm);
    const n = Math.floor(joined.length / 2);
    // An Int16Array over a Buffer needs its offset even: copied when it isn't.
    const samples = joined.byteOffset % 2 ? new Int16Array(Uint8Array.from(joined).buffer, 0, n) : new Int16Array(joined.buffer, joined.byteOffset, n);
    const est = estimateWords(words, samples, this.rate);
    this.place(
      words.map((w, k) => ({ text: w, start: s.start + (est[k]?.start ?? 0), end: s.start + (est[k]?.end ?? 0) })),
      false,
    );
  }

  timestamps(words: string[], starts: number[], ends: number[]) {
    if (!Array.isArray(words) || !Array.isArray(starts)) return;
    const timed: Array<{ text: string; start: number; end: number }> = [];
    for (let k = 0; k < words.length; k++) {
      let start = Number(starts[k]);
      let end = Number(ends?.[k] ?? start);
      if (typeof words[k] !== "string" || !Number.isFinite(start)) continue;
      if (!Number.isFinite(end) || end < start) end = start;
      // A batch that starts over (times from its own start, not the line's): on from the last word.
      if (k === 0 && start + this.timeBase < this.lastStart - 0.05) this.timeBase = this.lastEnd;
      start += this.timeBase;
      end += this.timeBase;
      this.lastStart = start;
      this.lastEnd = Math.max(this.lastEnd, end);
      timed.push({ text: words[k], start: start * this.rate, end: end * this.rate });
    }
    this.place(timed, true);
  }

  /** For the macOS voice, which the phone says itself: each written word's place in the text it says. */
  saidWords(): { line: number; words: MarkWord[] } {
    return { line: this.id, words: this.written.map((text, i) => ({ i, text, from: this.saidAt[i][0], to: this.saidAt[i][1] })) };
  }

  /**
   * The written words said by `sample` (of the line's sound): every word up to the last one known to
   * have begun by then (a word the voice said differently, never placed, is in once one after it is).
   * For the Mac overlay's read-along (spoken-lines.ts heard()).
   */
  saidBy = (sample: number): string[] => {
    let n = 0;
    for (const [i, at] of this.known) if (at.start <= sample && i >= n) n = i + 1;
    return this.written.slice(0, n);
  };

  /** What's waiting goes now (the line is over). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p?.words.length) this.send({ line: this.id, words: p.words, exact: p.exact });
  }

  /**
   * Words the voice said, in order, with when (samples of the line): each matched to the written
   * word whose letters it said, from where the last one left off. A word that isn't there (said
   * differently) is skipped; one that spans several written words gives each its share.
   */
  private place(timed: Array<{ text: string; start: number; end: number }>, exact: boolean) {
    const fresh: MarkWord[] = [];
    for (const t of timed) {
      const l = lettersOf(t.text);
      if (!l) continue;
      const p = this.find(l);
      if (p < 0) continue;
      const len = l.length;
      const span = Math.max(0, t.end - t.start);
      for (let k = p; k < p + len; k++) {
        const i = this.owner[k];
        if (this.firstLetter[i] === k || (k === p && !this.known.has(i))) {
          const start = finiteSamples(t.start + (span * (k - p)) / len);
          if (start === null) continue;
          const had = this.known.get(i);
          this.known.set(i, { start: had && had.start <= start ? had.start : start, end: had?.end ?? start });
        }
        if (this.lastLetter[i] === k) {
          const end = finiteSamples(t.start + (span * (k + 1 - p)) / len);
          const had = this.known.get(i);
          if (end !== null && had) had.end = Math.max(had.start, end);
        }
      }
      this.cursor = p + len;
      const touched = new Set<number>();
      for (let k = p; k < p + len; k++) touched.add(this.owner[k]);
      for (const i of touched) {
        const at = this.known.get(i);
        if (at) fresh.push({ i, text: this.written[i], start: at.start, end: at.end });
      }
    }
    if (!fresh.length) return;
    // The same word told twice (said across two of the voice's words): the latest.
    const byIndex = new Map<number, MarkWord>();
    for (const w of [...(this.pending?.exact === exact ? this.pending.words : []), ...fresh]) byIndex.set(w.i, w);
    if (this.pending && this.pending.exact !== exact) this.flush();
    this.pending = { words: [...byIndex.values()].sort((a, b) => a.i - b.i), exact };
    this.timer ??= setTimeout(() => this.flush(), SEND_MS);
    this.timer.unref?.();
  }

  /** Where `l` is in the letters said, from the cursor on (a little way ahead at most); −1 if not there. */
  private find(l: string): number {
    const window = this.letters.slice(this.cursor, this.cursor + LOOK_AHEAD + l.length);
    const at = window.indexOf(l);
    return at < 0 ? -1 : this.cursor + at;
  }
}
