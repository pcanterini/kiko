// What a phone press's audio looked like as it reached the hub, for the log (phone_talk's `audio`):
// whether the phone sent sound or silence, in time, up to the end, and when speech-to-text last
// found more words. A transcript cut short with loud seconds after its last words points at
// speech-to-text; quiet or all-zero seconds point at the phone's mic.

/** RMS of a second with nothing at all in it (all zeros), in dBFS. */
export const SILENT_DB = -99;
/** Chunks quieter than this (RMS, dBFS) are counted as near-silent: a live mic in a room is louder. */
const QUIET_DB = -70;

type PressAudioSummary = {
  bytes: number;
  chunks: number;
  /** Chunks that were exact zeros. */
  zeroChunks: number;
  /** Chunks below QUIET_DB, zeros included. */
  quietChunks: number;
  /** RMS of each second of audio (by its samples, not when it arrived), dBFS rounded; SILENT_DB for zeros. */
  dbPerSecond: number[];
  /** The longest wait between two chunks arriving, ms. */
  maxGapMs: number;
  /** When the longest wait ended, ms after talk_start. */
  maxGapAtMs: number | null;
  /** From the last chunk arriving to the press ending (talk_end), ms. */
  lastChunkToEndMs: number | null;
  /** When the transcript last gained words, ms after talk_start; and how many it had then. */
  wordsLastGrewMs: number | null;
  words: number;
};

export class PressAudio {
  private bytes = 0;
  private chunks = 0;
  private zeroChunks = 0;
  private quietChunks = 0;
  private samples = 0;
  private seconds: number[] = []; // sum of squares per second of audio
  private lastAt: number | null = null;
  private maxGapMs = 0;
  private maxGapAt: number | null = null;
  private words = 0;
  private wordsAt: number | null = null;

  private readonly start: number;
  private readonly rate: number;

  /** `start`: when talk_start came; `rate`: samples per second (16-bit mono). */
  constructor(start: number, rate: number) {
    this.start = start;
    this.rate = rate;
  }

  /** A chunk of 16-bit little-endian mono PCM that came at `at`. */
  add(pcm: Buffer, at: number) {
    if (this.lastAt !== null && at - this.lastAt > this.maxGapMs) {
      this.maxGapMs = at - this.lastAt;
      this.maxGapAt = at;
    }
    this.lastAt = at;
    this.bytes += pcm.length;
    this.chunks++;
    const n = pcm.length >> 1;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
      const second = Math.floor(this.samples / this.rate);
      this.seconds[second] = (this.seconds[second] ?? 0) + v * v;
      this.samples++;
    }
    if (sum === 0) this.zeroChunks++;
    if (n === 0 || db(sum / n) < QUIET_DB) this.quietChunks++;
  }

  /** The transcript so far (interim or final), at `at`. */
  heard(text: string, at: number) {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > this.words) {
      this.words = words;
      this.wordsAt = at;
    }
  }

  /** The press ended at `endAt` (talk_end). */
  summary(endAt: number): PressAudioSummary {
    const full = Math.floor(this.samples / this.rate);
    const dbPerSecond = this.seconds.map((sum, i) => {
      const n = i < full ? this.rate : this.samples - full * this.rate;
      return sum === 0 ? SILENT_DB : Math.round(db(sum / n));
    });
    const ms = (t: number | null) => (t === null ? null : Math.round(t - this.start));
    return {
      bytes: this.bytes,
      chunks: this.chunks,
      zeroChunks: this.zeroChunks,
      quietChunks: this.quietChunks,
      dbPerSecond,
      maxGapMs: Math.round(this.maxGapMs),
      maxGapAtMs: ms(this.maxGapAt),
      lastChunkToEndMs: this.lastAt === null ? null : Math.round(endAt - this.lastAt),
      wordsLastGrewMs: ms(this.wordsAt),
      words: this.words,
    };
  }
}

function db(meanSquare: number) {
  return meanSquare > 0 ? Math.max(SILENT_DB, 10 * Math.log10(meanSquare)) : SILENT_DB;
}
