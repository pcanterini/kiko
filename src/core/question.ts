// The app's "which session?" question (decide.ts Question), kept between your words: asked when the
// router or a guard asks where your words go, taken by your next words, which answer it or move on,
// so the words asked about go at most once. Time and timers come in through `clock`, so
// tests/unit/core/question.test.ts runs it on a fake one.
//
// The words it asked about are never let go silently (app/deliver.ts settleQuestion). Words that move on to
// something else don't drop them: the app says once that they weren't sent ("I didn't send "…"
// anywhere."), and keeps them (`told`) for a pick that names a session, for another QUESTION_MS. A
// question nobody answered is let go after QUESTION_MS (`onExpired`: logged, shown, and said unless
// it was already), but not while you talk or your words are dealt with (`busy`): they may answer it.
import type { Question } from "./decide.ts";
import { type Clock, realClock } from "./clock.ts";
import { QUESTION_MS } from "./routing-rules.ts";

/** A question kept: when it was asked (or last said again), and whether the app already said the words weren't sent. */
export type Asked = { question: Question; at: number; told: boolean };

// Busy when it runs out: looked at again this long after.
const BUSY_AGAIN_MS = 500;

export class AskedWhere {
  private asked: Asked | null = null;
  private timer: unknown = null;
  private clock: Clock;
  private ms: () => number;
  private busy: () => boolean;

  /** It ran out with nobody answering: the words it asked about go nowhere. */
  onExpired: (gone: Asked & { ageMs: number }) => void = () => {};

  /** `ms`: how long one is kept, as it's asked (a function: the faked-app harness shortens it for a case). */
  constructor({ clock = realClock, ms = QUESTION_MS, busy = () => false }: { clock?: Clock; ms?: number | (() => number); busy?: () => boolean } = {}) {
    this.clock = clock;
    this.ms = typeof ms === "number" ? () => ms : ms;
    this.busy = busy;
  }

  /**
   * The app just asked it (`told`: or said the words weren't sent, and keeps them): for QUESTION_MS
   * from now. The one before is replaced: returned when it was about other words, for the app to say so.
   */
  set(question: Question, told = false): Asked | null {
    const before = this.asked;
    this.asked = { question, at: this.clock.now(), told };
    this.arm(this.ms());
    return before && before.question.text !== question.text ? before : null;
  }

  /** It still waits for your answer. */
  get open() {
    return this.asked !== null;
  }

  /** The one kept, without taking it. */
  get pending(): Asked | null {
    return this.asked;
  }

  /** For your words now to answer: taken, so it's answered once. Put back (`restore`) if they leave it be. */
  take(): Asked | null {
    const asked = this.asked;
    this.asked = null;
    this.disarm();
    return asked;
  }

  /** Taken, and left as it was: it runs out when it would have. Unless a newer one was asked meanwhile. */
  restore(asked: Asked) {
    if (this.asked) return;
    this.asked = asked;
    this.arm(Math.max(0, asked.at + this.ms() - this.clock.now()));
  }

  private arm(ms: number) {
    this.disarm();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      const asked = this.asked;
      if (!asked) return;
      if (this.busy()) return this.arm(BUSY_AGAIN_MS);
      this.asked = null;
      this.onExpired({ ...asked, ageMs: this.clock.now() - asked.at });
    }, ms);
  }

  private disarm() {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
