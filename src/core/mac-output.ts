/**
 * Play on this Mac (switched from the phone app; the Mac has no setting for it), or not. Off, the
 * Mac plays nothing, voice or cue, and everything else goes on as if it did: phones with Play on
 * phone on still get the sound as it's made (the tee in app.ts comes before this), or for the
 * macOS voice its words to say; and the app still hears "playing" and "idle" when the sound would
 * have started and ended, so the floor, reply windows and "speaking" are the same either way. A
 * clock stands in for the Mac's player (each chunk's length at 24 kHz) and for `say` (its words at
 * an unhurried pace), with a moment more at the end of speech for the phone, which hears it a
 * little after it's sent (not after a cue: what comes next queues behind it on the phone anyway).
 *
 * Turning it off cuts what the Mac is playing at once, and the clock times the rest; turning it on
 * starts with the next thing said, not halfway through a sentence.
 */
import { TTS_SAMPLE_RATE } from "./config.ts";
import { type Clock, realClock } from "./clock.ts";
import type { Speech } from "./speech-lock.ts";
import type { LocalVoice, Speaker, Stall } from "../platform/types.ts";

/** Added to the end of speech timed rather than played: a phone hears it after the network and its player starting. */
export const PHONE_LAG_MS = 250;
/** About how fast a phone says the macOS voice's words (AVSpeechSynthesizer): on the slow side, so a reply window doesn't open before it's done. */
const WORDS_PER_MINUTE = 160;
// An idle still to come from what the Mac's player was cut off at is given up on after this.
const STALE_MS = 1000;

const msOf = (pcm: Buffer) => ((pcm.length / 2) * 1000) / TTS_SAMPLE_RATE;
/** How long saying `text` takes, about. */
export const sayMs = (text: string) => Math.round((text.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE) * 60_000);

/**
 * The player, as the app sees it: the Mac's, or (off) a clock that takes the sound and plays
 * nothing, saying "playing" when it would start and "idle" when it would have finished. Which one is
 * decided at the start of each stretch of sound (from the first chunk to the idle after it).
 */
export class MacSpeaker implements Speaker {
  onPlaying: () => void = () => {};
  onIdle: () => void = () => {};
  onStalled: (stall: Stall) => void = () => {};
  onBack: () => void = () => {};

  private mac: Speaker;
  private on: () => boolean;
  private clock: Clock;
  // The stretch of sound now: on the Mac, timed by the clock, or none.
  private stretch: "mac" | "silent" | null = null;
  private id = 0;
  // When what's been given would have finished playing, and what's added for the phone.
  private endAt = 0;
  private lag = 0;
  private timer: unknown = null;
  // Idles to come from the Mac's player for sound cut when it was turned off (the clock ends that
  // stretch), and for sound a barge-in cut (passed on: the queue counts on them).
  private stale = 0;
  private staleTimer: unknown = null;
  private owed = 0;
  private owedTimer: unknown = null;

  constructor(mac: Speaker, on: () => boolean, clock: Clock = realClock) {
    this.mac = mac;
    this.on = on;
    this.clock = clock;
    // The Mac's player's own news passes on as it always did (an idle after a cut can come once the
    // next sound is written, and the queue counts on it), except the idle for what was cut when it
    // was turned off: the clock ends that stretch.
    mac.onPlaying = () => this.stretch !== "silent" && this.onPlaying();
    mac.onIdle = () => {
      if (this.stale) return void this.stale--;
      if (this.owed) this.owed--;
      else if (this.stretch === "mac") this.stretch = null;
      this.onIdle();
    };
    // A stall is news only for a stretch on the Mac: one the clock times plays nowhere here.
    mac.onStalled = (stall) => this.stretch === "mac" && this.onStalled(stall);
    mac.onBack = () => this.onBack();
  }

  start() {
    return this.mac.start();
  }

  shutdown() {
    this.clearTimer();
    this.mac.shutdown();
  }

  /**
   * `beep`: a cue (the queue never puts speech in the same stretch as one). `only`: on the Mac (a
   * press there: whatever the setting) or timed only (a press on a phone: it plays there).
   */
  write(pcm: Buffer, beep = false, only?: "mac" | "silent") {
    const now = this.clock.now();
    if (this.stretch === null) {
      this.stretch = only ?? (this.on() ? "mac" : "silent");
      this.endAt = now;
      this.lag = beep ? 0 : PHONE_LAG_MS;
      const id = ++this.id;
      // A moment later, as the player says it.
      if (this.stretch === "silent") this.clock.setTimeout(() => this.id === id && this.stretch === "silent" && this.onPlaying(), 0);
    }
    this.endAt = Math.max(this.endAt, now) + msOf(pcm);
    if (this.stretch === "mac") return this.mac.write(pcm, beep);
    this.timeEnd();
  }

  /**
   * Cut it now and drop anything queued: idle follows a moment later, as the player's does. The
   * stretch is over at once: what's written next starts a new one, whichever it is.
   */
  stop() {
    this.mac.stop();
    if (this.stretch === "mac") {
      // The Mac's player says idle for what it cut: passed on, but not the end of what comes next.
      this.stretch = null;
      this.owed++;
      if (this.owedTimer) this.clock.clearTimeout(this.owedTimer);
      this.owedTimer = this.clock.setTimeout(() => (this.owed = 0), STALE_MS);
      return;
    }
    if (this.stretch !== "silent") return;
    this.clearTimer();
    this.stretch = null;
    this.clock.setTimeout(() => this.onIdle(), 0);
  }

  /** The Mac's player's gain (mute.ts): at once, mid-line too. The clock's timing is the same either way. */
  volume(level: number) {
    this.mac.volume(level);
  }

  /** It was turned off: what the Mac is playing stops now, and the clock times the rest of it. */
  silence() {
    if (this.stretch !== "mac") return;
    this.stretch = "silent";
    this.stale++;
    if (this.staleTimer) this.clock.clearTimeout(this.staleTimer);
    this.staleTimer = this.clock.setTimeout(() => (this.stale = 0), STALE_MS);
    this.mac.stop();
    this.timeEnd();
  }

  private timeEnd() {
    this.clearTimer();
    const id = this.id;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        if (this.id !== id || this.stretch !== "silent") return;
        this.stretch = null;
        this.onIdle();
      },
      Math.max(0, this.endAt + this.lag - this.clock.now()),
    );
  }

  private clearTimer() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A line the voice says: by the Mac (`say`), or timed while a phone says it (`silent`). */
type Line = { silent: boolean; endAt: number; timer: unknown; done: () => void };

/**
 * The macOS voice, as the app sees it: `say` on the Mac, or (off) nothing on the Mac and a clock
 * timing the line, with onStart and onEnd when it would have started and ended. The phone gets the
 * words to say either way (app.ts). What `say` says passes on as it always did, except the exit of
 * a line it was cut off in when Play on this Mac went off: the clock ends that one.
 */
export class MacVoice implements LocalVoice {
  onStart: () => void = () => {};
  onEnd: () => void = () => {};

  private mac: LocalVoice;
  private on: () => boolean;
  private clock: Clock;
  // The line `say` is saying, and the one the clock is timing.
  private onMac: Line | null = null;
  private timed: Line | null = null;
  // `say` exits still to come for lines handed to the clock.
  private skipEnds = 0;
  private skipTimer: unknown = null;

  constructor(mac: LocalVoice, on: () => boolean, clock: Clock = realClock) {
    this.mac = mac;
    this.on = on;
    this.clock = clock;
    mac.onStart = () => this.onStart();
    mac.onEnd = () => {
      if (this.skipEnds) return void this.skipEnds--;
      this.onMac = null;
      this.onEnd();
    };
  }

  async open(onDone: () => void = () => {}): Promise<Speech> {
    const line: Line = { silent: false, endAt: 0, timer: null, done: onDone };
    // `say` says it's done when it exits: not for a line handed to the clock.
    const speech = await this.mac.open(() => !line.silent && onDone());
    let text = "";
    let cancelled = false;
    return {
      push: (delta) => {
        text += delta;
        speech.push(delta);
      },
      chars: () => text.length,
      end: () => {
        if (cancelled || !text.trim()) return speech.end();
        line.endAt = this.clock.now() + sayMs(text);
        if (this.on()) {
          this.onMac = line;
          return speech.end();
        }
        line.silent = true;
        this.timed = line;
        this.clock.setTimeout(() => this.timed === line && this.onStart(), 0);
        this.timeEnd(line);
      },
      cancel: () => {
        cancelled = true;
        speech.cancel();
        if (this.timed === line) this.stop();
      },
    };
  }

  stop() {
    this.mac.stop(); // a line on the Mac ends as `say` exits
    const line = this.timed;
    if (!line) return;
    if (line.timer) this.clock.clearTimeout(line.timer);
    this.timed = null;
    this.clock.setTimeout(() => {
      this.onEnd();
      line.done();
    }, 0);
  }

  /** It was turned off: a line `say` is saying stops now, and the clock times the rest of it. */
  silence() {
    const line = this.onMac;
    if (!line) return;
    this.onMac = null;
    line.silent = true;
    this.timed = line;
    this.skipEnds++;
    if (this.skipTimer) this.clock.clearTimeout(this.skipTimer);
    this.skipTimer = this.clock.setTimeout(() => (this.skipEnds = 0), STALE_MS);
    this.mac.stop();
    this.timeEnd(line);
  }

  private timeEnd(line: Line) {
    line.timer = this.clock.setTimeout(
      () => {
        if (this.timed !== line) return;
        this.timed = null;
        this.onEnd();
        line.done();
      },
      Math.max(0, line.endAt + PHONE_LAG_MS - this.clock.now()),
    );
  }
}
