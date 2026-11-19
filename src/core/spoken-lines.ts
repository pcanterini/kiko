/**
 * The lines being said, for the log: `speech_done` once a line's voice has made all of it, and
 * `speech_cut` when a stop (stopTalking: a press, typing into the session, the phone's Stop…) or its
 * maker cuts one, with why and how much of it was heard.
 *
 * How much was heard is estimated from the audio made, as the player plays it: in real time, each
 * chunk after the one before it (speaker.ts, and the phones' players do the same). A line's sound
 * starts when its first chunk is made, or when the line before it has played out if that's later.
 *
 * The same estimate says what's being heard now (heard()): which line, its words said so far (the
 * line's read-along, voice-marks.ts, at the sample being played) and how loud its sound is there,
 * on the mic's scale (wake.ts levelOf, every LEVEL_MS): the Mac overlay's words and bars while Kiko
 * speaks (app/overlay.ts), in step with the sound rather than with the voice making it.
 */
import { TTS_SAMPLE_RATE } from "./config.ts";
import type { Said } from "./unplayed.ts";
import { levelOf } from "./wake.ts";

/** A line's sound is measured in slices this long (ms): as often as the mic's level is (app/talk.ts). */
export const LEVEL_MS = 80;

/** A chunk of a line's sound: when it plays (estimated), how long, where it is in the line (samples), and its level in each LEVEL_MS. */
type Chunk = { at: number; ms: number; sample: number; levels: number[] };

/** What's heard now: the line (`said`), its written words said so far (null: not known), and its sound's level now (0–1, levelOf's scale). */
export type Heard = { said?: Said; words: string[] | null; level: number };

type Line = {
  said?: Said;
  /** Its written words said by a sample of its sound (voice-marks.ts VoiceLine.saidBy); absent: not known. */
  words?: (sample: number) => string[];
  chunks: Chunk[];
  samples: number;
  madeMs: number;
  /** When its sound starts playing (estimated); null before it has made any. */
  startAt: number | null;
  /** When what it made so far has played out (estimated). */
  endAt: number;
  finished: boolean;
  /** Logged: done, or cut. */
  cut: boolean;
};

export type LineHandle = {
  /** A chunk of its voice was made (24 kHz mono 16-bit PCM). */
  audio: (pcm: Buffer) => void;
  /** Its voice made all of it. */
  finished: (fields: Record<string, unknown>) => void;
  /** It no longer has the voice: finished, or cut (stopTalking's cut was logged then; any other is its maker's). */
  over: () => void;
};

const secs = (ms: number) => Math.round(ms / 100) / 10;

export class SpokenLines {
  private lines = new Set<Line>();
  /** When everything made so far has played out (estimated). */
  private playhead = 0;
  private log: (event: string, fields: Record<string, unknown>) => void;
  private now: () => number;

  constructor(log: (event: string, fields: Record<string, unknown>) => void, now: () => number = Date.now) {
    this.log = log;
    this.now = now;
  }

  /** A line asks for the voice (it may wait its turn). `words`: its words said by a sample of its sound, for heard(). */
  open(said?: Said, words?: (sample: number) => string[]): LineHandle {
    const line: Line = { said, words, chunks: [], samples: 0, madeMs: 0, startAt: null, endAt: 0, finished: false, cut: false };
    this.prune();
    this.lines.add(line);
    return {
      audio: (pcm) => {
        if (line.cut) return;
        const now = this.now();
        const ms = ((pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;
        const at = Math.max(now, this.playhead);
        line.startAt ??= at;
        line.chunks.push({ at, ms, sample: line.samples, levels: levelsOf(pcm) });
        line.samples += pcm.length >> 1;
        this.playhead = at + ms;
        line.endAt = this.playhead;
        line.madeMs += ms;
      },
      finished: (fields) => {
        if (line.cut || line.finished) return;
        line.finished = true;
        this.log("speech_done", { ...this.what(line), madeS: secs(line.madeMs), ...fields });
      },
      over: () => {
        if (line.cut || line.finished) return;
        // Cut by its maker (an announcement a permission prompt put back, a reply cancelled), not by a stop.
        line.cut = true;
        this.lines.delete(line);
        this.logCut(line, "cancelled", {}, 0);
      },
    };
  }

  /**
   * A stop: every line being said, or waiting to be, is cut. Logged when one was (`why`, and what
   * the stop was for: `cause`): the one being heard, and how many waiting behind it were dropped.
   */
  cutNow(why: string, cause: Record<string, unknown>) {
    this.prune();
    const lines = [...this.lines];
    this.lines.clear();
    this.playhead = 0;
    if (!lines.length) return;
    for (const line of lines) line.cut = true;
    const now = this.now();
    const heard = lines.find((l) => l.startAt !== null && l.startAt <= now) ?? lines[0]!;
    this.logCut(heard, why, cause, lines.length - 1);
  }

  /**
   * What's heard now: the line in front (the first not yet played out, or still being made, or the
   * last), at the sample being played, with its words said by then and its sound's level there (0
   * between chunks, and once it has played out). Null when the line in front has no sound (the
   * macOS voice plays by itself; a line still waiting for its first chunk) or there's none.
   */
  heard(): Heard | null {
    const now = this.now();
    const lines = [...this.lines];
    const front = lines.find((l, k) => l.endAt > now || !l.finished || k === lines.length - 1);
    if (!front || front.startAt === null || front.startAt > now) return null;
    let sample = 0;
    let level = 0;
    for (const c of front.chunks) {
      if (c.at > now) break;
      const into = now - c.at;
      if (into < c.ms) {
        sample = c.sample + Math.floor((into / 1000) * TTS_SAMPLE_RATE);
        level = c.levels[Math.floor(into / LEVEL_MS)] ?? 0;
        break;
      }
      sample = c.sample + Math.round((c.ms / 1000) * TTS_SAMPLE_RATE);
    }
    return { said: front.said, words: front.words ? front.words(sample) : null, level };
  }

  private logCut(line: Line, why: string, cause: Record<string, unknown>, dropped: number) {
    const now = this.now();
    const playedMs = line.startAt === null ? 0 : Math.min(line.madeMs, Math.max(0, now - line.startAt));
    this.log("speech_cut", {
      why,
      ...cause,
      ...this.what(line),
      madeS: secs(line.madeMs),
      playedS: secs(playedMs),
      // Of what was made: more was still to come while it was being made (`making`).
      leftS: secs(line.madeMs - playedMs),
      making: !line.finished,
      dropped,
    });
  }

  /** Lines whose sound has all played out are over. */
  private prune() {
    const now = this.now();
    for (const line of this.lines) if (line.finished && line.endAt <= now) this.lines.delete(line);
  }

  private what(line: Line) {
    const s = line.said;
    if (!s) return { kind: "line" };
    return { kind: s.kind, ...(s.sessionId ? { sessionId: s.sessionId } : {}), ...(s.replyId ? { replyId: s.replyId } : {}) };
  }
}

/** A chunk's level in each LEVEL_MS of it (the last slice what's left). */
function levelsOf(pcm: Buffer): number[] {
  const step = Math.max(2, Math.round((LEVEL_MS / 1000) * TTS_SAMPLE_RATE) * 2);
  const levels: number[] = [];
  for (let at = 0; at < pcm.length; at += step) levels.push(levelOf(pcm.subarray(at, Math.min(pcm.length, at + step))));
  return levels;
}
