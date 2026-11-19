import type { VoiceLine } from "./voice-marks.ts";

/**
 * One voice at a time. Every spoken reply opens through here and waits for whoever is speaking;
 * otherwise two replies stream into the player together and their audio comes out interleaved.
 *
 * A speech holds the lock until all its audio is with the player (the next one's then plays right
 * after it) or it's cancelled. stop() is barge-in: it cuts the speech and drops any still waiting.
 */
export type Speech = { push: (text: string) => void; end: () => void; cancel: () => void; chars: () => number };
// ready: resolves once a beep ahead of it is done (audio-queue.ts); `say`, which plays by itself, waits for it.
// marks: the line being said (voice-marks.ts), told what the voice says of its words as it says them.
export type TtsHandlers = { onAudio: (pcm: Buffer) => void; onDone: () => void; ready?: () => Promise<void>; marks?: VoiceLine };

export const SILENT: Speech = { push: () => {}, end: () => {}, cancel: () => {}, chars: () => 0 };

type Hold = { live: boolean; stop: () => void; over: () => void };

export class SpeechLock {
  private held: Hold | null = null;
  private waiting: Array<(hold: Hold | null) => void> = [];

  /**
   * Opens a speech with `open` once everyone ahead is done, its audio going to `play`.
   * Stopped before its turn comes, it's silent. `over` is called once, when it no longer holds the
   * voice (all its audio handed over, cut, or never got its turn).
   */
  async open(open: (handlers: TtsHandlers) => Promise<Speech>, play: (pcm: Buffer) => void, over: () => void = () => {}): Promise<Speech> {
    const hold = this.held ? await new Promise<Hold | null>((resolve) => this.waiting.push(resolve)) : this.grant();
    if (!hold?.live) {
      over(); // stopped while it waited
      return SILENT;
    }
    hold.over = over;
    const release = () => this.release(hold);
    let speech: Speech;
    try {
      speech = await open({ onAudio: (pcm) => hold.live && play(pcm), onDone: release });
    } catch (err) {
      release();
      throw err;
    }
    if (!hold.live) {
      speech.cancel(); // stopped while it was opening
      return SILENT;
    }
    const cancel = () => {
      speech.cancel();
      release();
    };
    hold.stop = cancel;
    return { ...speech, cancel };
  }

  /** Something is being said, or waiting to be. */
  get busy(): boolean {
    return this.held !== null || this.waiting.length > 0;
  }

  /** Cut whatever is being said and drop whatever is waiting to be. */
  stop() {
    for (const resolve of this.waiting.splice(0)) resolve(null);
    const hold = this.held;
    if (!hold) return;
    hold.stop();
    this.release(hold);
  }

  private grant(): Hold {
    const hold: Hold = { live: true, stop: () => {}, over: () => {} };
    this.held = hold;
    return hold;
  }

  private release(hold: Hold) {
    if (!hold.live) return;
    hold.live = false;
    hold.over();
    if (this.held !== hold) return;
    this.held = null;
    const next = this.waiting.shift();
    if (next) next(this.grant());
  }
}
