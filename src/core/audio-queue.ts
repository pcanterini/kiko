/**
 * One way out for sound: the app's beeps (sounds.ts) and its speech take turns, in the order they
 * were asked for. A beep asked for while a speech is playing, or about to (it's in line or has the
 * voice, no sound yet), plays once that speech has been heard to the end; a speech asked for while
 * a beep plays starts once the beep is done (a beep is ~150ms, less than a voice takes to start).
 * Speech that has no beep ahead of it is never held up.
 *
 * Without this, a beep went straight to the player (speaker.ts), which plays what it's given in
 * order: written mid-speech, it came out between two chunks of the voice. And `say` plays on its
 * own, over anything.
 *
 * The player's "playing" and "idle" come in through playing() and idle(), and onPlaying / onIdle
 * pass on the speech's only: a beep isn't the app speaking, and an idle between two chunks of a
 * speech still coming (the voice fell behind, or Pocket between sentences) isn't the end of it.
 */
import { TTS_SAMPLE_RATE } from "./config.ts";
import type { VoicePos } from "./voice-marks.ts";

/** A speech's place in line. audio(): its sound, for the player (`pos`: where the chunk is in its
 * line, for the phones' read-along: voice-marks.ts); ready(): resolves once it may start (for `say`,
 * which plays by itself); end(): it's over, every chunk handed over or cut. */
export type Turn = { audio: (pcm: Buffer, pos?: VoicePos) => void; ready: () => Promise<void>; end: () => void };

// `tag`: what the speech is, as its maker said (stalled() hands it back); `dropped`: the player gave
// up on its sound, so what's still to come of it goes nowhere.
// `writtenMs`: how much of its sound went to the player.
type Speech<T> = {
  kind: "speech";
  tag?: T;
  done: boolean;
  sounded: boolean;
  dropped: boolean;
  writtenMs: number;
  held: Array<{ pcm: Buffer; pos?: VoicePos }>;
  waiting: Array<() => void>;
};
type Beep = { kind: "beep"; pcm: Buffer; to: string; playing: boolean; timer: NodeJS.Timeout | null; done?: () => void };

// A beep the player never says it finished (it died, or its idle got lost) is taken as done this
// long after it should have ended, so nothing waits on it for good.
const BEEP_GRACE_MS = 500;
// Idles still to come from what stop() cut are given up on after this.
const STALE_MS = 1000;

export class AudioQueue<T = unknown> {
  /** The speech's sound started coming out. */
  onPlaying: () => void = () => {};
  /** The speech's sound is over: nothing more of it is coming. */
  onIdle: () => void = () => {};

  private line: Array<Speech<T> | Beep> = [];
  private unplayed = false; // written to the player, and it hasn't said idle since
  private told = false; // onPlaying was passed on, and onIdle not yet
  private stale = 0; // idles to come from sound stop() cut
  private staleTimer: NodeJS.Timeout | null = null;
  private quietWaiters: Array<() => void> = [];
  private aheadWaiters: Array<{ tag: T; ahead: (tag: T) => boolean; resolve: () => void }> = [];

  // `cue`: where a cue's sound plays (what cue() was given); null for a speech's, with `pos` its place in its line.
  private write: (pcm: Buffer, cue: string | null, pos?: VoicePos) => void;

  constructor(write: (pcm: Buffer, cue: string | null, pos?: VoicePos) => void) {
    this.write = write;
  }

  /**
   * A speech gets in line. Each one's end() must come, or the beeps behind it wait. `tag`: what it
   * is, handed back by stalled() if the player gives up on its sound.
   */
  speech(tag?: T): Turn {
    const s: Speech<T> = { kind: "speech", tag, done: false, sounded: false, dropped: false, writtenMs: 0, held: [], waiting: [] };
    this.line.push(s);
    return {
      audio: (pcm, pos) => {
        if (!this.line.includes(s)) return; // stopped
        if (this.mayPlay(s)) this.play(s, pcm, pos);
        else s.held.push({ pcm, pos });
      },
      ready: () => (!this.line.includes(s) || this.mayPlay(s) ? Promise.resolve() : new Promise((resolve) => s.waiting.push(resolve))),
      end: () => {
        if (s.done || !this.line.includes(s)) return;
        s.done = true;
        // An idle that came mid-speech was its end after all.
        const over = !this.unplayed && !this.sounding();
        this.pump();
        if (over) this.tellIdle();
      },
    };
  }

  /**
   * A beep: now when nothing is said or about to be, else after it. `done`: it has played, or was
   * dropped. `to`: where it plays, passed on to the writer as it is.
   */
  cue(pcm: Buffer, done?: () => void, to = "") {
    this.line.push({ kind: "beep", pcm, to, playing: false, timer: null, done });
    this.pump();
  }

  /** Whether any speech is in line, being said, or still coming out of the player. */
  busy() {
    return this.line.some((e) => e.kind === "speech");
  }

  /** Resolves once no speech is in line or playing (or stop() cut it). */
  quiet(): Promise<void> {
    return this.busy() ? new Promise((resolve) => this.quietWaiters.push(resolve)) : Promise.resolve();
  }

  /**
   * Resolves once no speech ahead of the one tagged `tag` is one `ahead` picks: each has been heard
   * to the end (its sound played out) or was cut. At once when there's none, or no speech tagged so.
   * For a session's announcement, so an app line before it ("I couldn't reach Lacy …") is heard on
   * its own, and the announcement's sound starts after it rather than running on from it.
   */
  clearAhead(tag: T, ahead: (tag: T) => boolean): Promise<void> {
    const waiter = { tag, ahead, resolve: () => {} };
    if (!this.blocked(waiter)) return Promise.resolve();
    return new Promise((resolve) => {
      waiter.resolve = resolve;
      this.aheadWaiters.push(waiter);
    });
  }

  private blocked({ tag, ahead }: { tag: T; ahead: (tag: T) => boolean }) {
    const at = this.line.findIndex((e) => e.kind === "speech" && e.tag === tag);
    return at > 0 && this.line.slice(0, at).some((e) => e.kind === "speech" && e.tag !== undefined && ahead(e.tag));
  }

  /** Barge-in: drops every speech and beep in line. The caller stops the player and the voices. */
  stop() {
    const line = this.line;
    this.line = [];
    for (const e of line) {
      if (e.kind === "beep") {
        if (e.timer) clearTimeout(e.timer);
        e.done?.();
      }
      // A `say` waiting to start goes on to find it was cancelled.
      if (e.kind === "speech") for (const resolve of e.waiting.splice(0)) resolve();
    }
    if (this.unplayed) {
      // The player says idle once more for what it was playing; that one isn't news.
      this.stale++;
      if (this.staleTimer) clearTimeout(this.staleTimer);
      this.staleTimer = setTimeout(() => (this.stale = 0), STALE_MS);
      this.staleTimer.unref?.();
    }
    this.unplayed = false;
    if (this.told) {
      // Told it was speaking: now it isn't. Not from inside the caller's stop.
      setImmediate(() => !this.sounding() && this.tellIdle());
    }
    this.settle();
  }

  /**
   * The player gave up on its last `unheardMs` of sound (all of it, without): the output took none
   * of it (speaker.ts onStalled). Its idle follows, as for a cut. Hands back the speeches that sound
   * was of, oldest first, by their tags: what wasn't heard (a speech that had all its sound played
   * before, still in line for the idle after the next one's, isn't one). What's still to come of
   * those goes nowhere (the output that dropped the start would only play the rest), and each still
   * ends as its voice finishes; what's in line behind them plays.
   */
  stalled(unheardMs = Infinity): T[] {
    const sounded = this.line.filter((e): e is Speech<T> => e.kind === "speech" && e.sounded);
    const cut: Speech<T>[] = [];
    let left = unheardMs;
    for (const s of sounded.reverse()) {
      if (left <= 0) break;
      cut.unshift(s);
      left -= s.writtenMs;
    }
    for (const s of cut) {
      s.dropped = true;
      s.held = [];
    }
    return cut.flatMap((s) => (s.tag === undefined ? [] : [s.tag]));
  }

  /** The player started on what it was given. */
  playing() {
    if (this.stale || this.beepPlaying()) return;
    if (this.told) return;
    this.told = true;
    this.onPlaying();
  }

  /** The player ran out of what it was given. */
  idle() {
    if (this.stale) {
      this.stale--;
      return;
    }
    const front = this.line[0];
    if (front?.kind === "beep" && front.playing) return this.beepDone(front);
    this.unplayed = false;
    if (this.sounding()) return; // more of this speech is coming
    this.pump();
    this.tellIdle();
  }

  /** A speech whose sound has started, and not all of it is in yet. */
  private sounding() {
    return this.line.some((e) => e.kind === "speech" && e.sounded && !e.done);
  }

  private beepPlaying() {
    const front = this.line[0];
    return front?.kind === "beep" && front.playing;
  }

  /** No beep ahead of it. */
  private mayPlay(s: Speech<T>) {
    for (const e of this.line) {
      if (e === s) return true;
      if (e.kind === "beep") return false;
    }
    return false;
  }

  private play(s: Speech<T>, pcm: Buffer, pos?: VoicePos) {
    if (s.dropped) return; // the player gave up on its start (stalled)
    s.sounded = true;
    s.writtenMs += ((pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;
    this.unplayed = true;
    this.write(pcm, null, pos);
  }

  private beepDone(b: Beep) {
    if (this.line[0] !== b) return;
    if (b.timer) clearTimeout(b.timer);
    this.line.shift();
    this.unplayed = false;
    b.done?.();
    this.pump();
  }

  /**
   * Lets what may go now go: speeches with no beep ahead of them get their held sound and their
   * start; finished ones leave the front; a beep at the front plays once nothing is ahead of it.
   */
  private pump() {
    for (;;) {
      for (const e of this.line) {
        if (e.kind === "beep") break;
        for (const { pcm, pos } of e.held.splice(0)) this.play(e, pcm, pos);
        for (const resolve of e.waiting.splice(0)) resolve();
      }
      const front = this.line[0];
      if (!front) break;
      if (front.kind === "speech") {
        if (!front.done || this.unplayed) break; // still being said, or still coming out
        this.line.shift();
        continue;
      }
      if (!front.playing) {
        front.playing = true;
        this.unplayed = true;
        const ms = ((front.pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;
        front.timer = setTimeout(() => this.beepDone(front), ms + BEEP_GRACE_MS);
        front.timer.unref?.();
        this.write(front.pcm, front.to);
      }
      break;
    }
    this.settle();
  }

  private settle() {
    for (const w of this.aheadWaiters.filter((w) => !this.blocked(w))) {
      this.aheadWaiters.splice(this.aheadWaiters.indexOf(w), 1);
      w.resolve();
    }
    if (this.busy()) return;
    for (const resolve of this.quietWaiters.splice(0)) resolve();
  }

  private tellIdle() {
    if (!this.told) return;
    this.told = false;
    this.onIdle();
  }
}
