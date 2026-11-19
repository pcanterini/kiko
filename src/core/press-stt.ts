// Each press's own speech-to-text (app.ts: the key, the phone's talk button, the mic test). The engines
// (Apple's on-device helper, Deepgram's socket) turn one stream of audio into text at a time, and
// begin() starts it afresh. A press that began while the one before was still being turned into text
// (the key pressed again within the 300ms tail after letting go, or a phone press during the ~100ms
// of transcription) restarted it under the new press: the first press's words were lost (Apple's
// helper cancelled them; Deepgram's were cleared), or came back as the first press's, cut, and the
// second press's were empty.
//
// Now each press gets its own `Transcribing`: what it hears goes to it alone, and finishing it touches
// only its own words. The engine has one press at a time: a press that begins while the one before is
// still being heard or finished keeps its audio, in order, and it goes to the engine the moment the
// one before has its transcript. Nothing is dropped, and transcripts come back in the order the presses
// began: the first press's words, then the second's.
//
// A press whose finish() never comes (a bug) can't hold the next one forever: once a newer press waits
// behind it, it's finished after `stuckMs` with what it heard, logged (stt_press_stuck), and its own
// finish() gets those words when it comes.
import { MIC_SAMPLE_RATE } from "./config.ts";
import { type Clock, realClock } from "./clock.ts";

/** What a speech-to-text engine does for a press (Deepgram, platform/macos/apple-stt.ts): one at a time. */
export type SttEngine = {
  onInterim: (text: string) => void;
  /** A new press starts: whatever the engine had is over. */
  begin(): void;
  send(chunk: Buffer): void;
  /** The press's full transcript, since begin(). */
  finish(): Promise<string>;
  /** Seconds of audio it got since begin(). */
  audioSeconds(): number;
};

/** One press's speech-to-text. */
export type Transcribing = {
  /** Counts up with each press begun. */
  readonly id: number;
  /** Its audio: to the engine now, or kept, in order, until the press before has its transcript. */
  send(chunk: Buffer): void;
  /** Its transcript, after every press begun before it has had theirs. The same promise if asked again. */
  finish(): Promise<string>;
  /** Seconds of its audio the engine turned into text; 0 until it's finished. */
  audioSeconds(): number;
};

type PressSttOptions = {
  /** A press whose finish() hasn't come this long after a newer one began is finished anyway. */
  stuckMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  clock?: Clock;
};

type Press = {
  id: number;
  /** waiting: kept until the engine is free; live: the engine's, hearing it; finishing: its transcript is coming; done. */
  state: "waiting" | "live" | "finishing" | "done";
  kept: Buffer[];
  keptBytes: number;
  /** finish() was asked for: it's finished as soon as it's live. */
  ended: boolean;
  seconds: number;
  began: number;
  interim: (text: string) => void;
  result: Promise<string>;
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
};

export class PressStt {
  private engine: SttEngine;
  /** The presses not done yet, in the order they began: the first is the engine's. */
  private line: Press[] = [];
  private ids = 0;
  private stuckTimer: unknown = null;
  private stuckMs: number;
  private log: (event: string, fields: Record<string, unknown>) => void;
  private clock: Clock;

  constructor(engine: SttEngine, options: PressSttOptions = {}) {
    this.engine = engine;
    this.stuckMs = options.stuckMs ?? 3000;
    this.log = options.log ?? (() => {});
    this.clock = options.clock ?? realClock;
    // Live words are the engine's press's: the first in line.
    engine.onInterim = (text) => {
      const first = this.line[0];
      if (first && (first.state === "live" || first.state === "finishing")) first.interim(text);
    };
  }

  /** A press starts. `interim`: its live words as they change. */
  begin(interim: (text: string) => void = () => {}): Transcribing {
    let resolve!: (text: string) => void;
    let reject!: (err: unknown) => void;
    const result = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
    result.catch(() => {}); // a failure is its finish()'s to report
    const p: Press = { id: ++this.ids, state: "waiting", kept: [], keptBytes: 0, ended: false, seconds: 0, began: this.clock.now(), interim, result, resolve, reject };
    this.line.push(p);
    if (this.line.length === 1) this.start(p);
    else {
      const first = this.line[0];
      this.log("stt_press_waits", { press: p.id, behind: first.id, state: first.state });
      this.watchStuck();
    }
    return {
      id: p.id,
      send: (chunk) => this.send(p, chunk),
      finish: () => this.finish(p),
      audioSeconds: () => p.seconds,
    };
  }

  /** Presses begun and not finished yet: the engine's, and any waiting for it. */
  get pending() {
    return this.line.length;
  }

  private send(p: Press, chunk: Buffer) {
    if (p.state === "live") return this.engine.send(chunk);
    if (p.state !== "waiting" || p.ended) return; // over: the mic or the phone sent it late
    p.kept.push(chunk);
    p.keptBytes += chunk.length;
  }

  private finish(p: Press) {
    if (!p.ended) {
      p.ended = true;
      if (p.state === "live") this.end(p);
    }
    return p.result;
  }

  /** The engine is free: this press has it, with what it kept, in order. */
  private start(p: Press) {
    p.state = "live";
    this.engine.begin();
    if (p.kept.length) {
      this.log("stt_press_starts", { press: p.id, keptSeconds: Math.round((p.keptBytes / (MIC_SAMPLE_RATE * 2)) * 100) / 100, waitedMs: Math.round(this.clock.now() - p.began) });
      for (const chunk of p.kept.splice(0)) this.engine.send(chunk);
    }
    if (p.ended) this.end(p);
    else this.watchStuck();
  }

  /** Its transcript, then the next press has the engine. */
  private end(p: Press) {
    p.state = "finishing";
    this.clearStuck();
    let finishing: Promise<string>;
    try {
      finishing = this.engine.finish();
    } catch (err) {
      finishing = Promise.reject(err);
    }
    finishing.then(
      (text) => {
        // Read before the next press's begin() starts the count again.
        p.seconds = this.engine.audioSeconds();
        this.done(p);
        p.resolve(text);
        this.next();
      },
      (err) => {
        this.done(p);
        p.reject(err);
        this.next();
      },
    );
  }

  private done(p: Press) {
    p.state = "done";
    const i = this.line.indexOf(p);
    if (i >= 0) this.line.splice(i, 1);
  }

  private next() {
    const first = this.line[0];
    if (first?.state === "waiting") this.start(first);
  }

  /** The engine's press, not let go, with a newer one waiting: finished after stuckMs. */
  private watchStuck() {
    this.clearStuck();
    const first = this.line[0];
    if (!first || first.state !== "live" || this.line.length < 2) return;
    this.stuckTimer = this.clock.setTimeout(() => {
      this.stuckTimer = null;
      if (this.line[0] !== first || first.state !== "live") return;
      this.log("stt_press_stuck", { press: first.id, waiting: this.line.length - 1, ms: this.stuckMs });
      first.ended = true;
      this.end(first);
    }, this.stuckMs);
  }

  private clearStuck() {
    if (this.stuckTimer === null) return;
    this.clock.clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
  }
}
