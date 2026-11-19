/**
 * A send the app wasn't sure of (decide's `unsure`), held a moment after it says where it's going
 * (app/deliver.ts holdIf): once "To Lacy." has been heard (heard()), it goes HOLD_MS later. A press
 * meanwhile keeps it until your new words are dealt with (settleWith): a correction sends it where
 * it belongs instead, "cancel" drops it, anything else lets it go first. A correction that doesn't
 * say where ("wrong one") keeps it while the app asks, up to HOLD_ANSWER_MS, then drops it.
 *
 * Time and timers come in through `clock` (floor.ts), so tests/unit/core/hold.test.ts runs it on a fake one.
 */
import type { Act, Decision, Sent, Target } from "./decide.ts";
import { type Clock, realClock } from "./clock.ts";

export type Verdict = "send" | "redirect" | "cancel";

export type HoldOptions = {
  /** How long it waits once where it's going has been heard. */
  holdMs: number;
  /** How long it waits for you to say where it goes, once you said it was wrong. */
  answerMs: number;
  /** What a session is called now (a correction's, for the log). */
  nameOf: (to: Target) => string;
  /** Settled: it's no longer the send being held. */
  settled: (hold: Hold) => void;
  /** You said it was wrong, and never said where: it's dropped, and the app says so. */
  unanswered: (hold: Hold) => void;
  info: (text: string) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Something the status line and the UI show changed. */
  changed: () => void;
  clock?: Clock;
};

export class Hold {
  readonly to: Target;
  readonly name: string;
  readonly text: string;
  readonly why: string;
  readonly kind: "send" | "ask" | "resend";
  /** What a correction is about. */
  readonly last: Sent;
  readonly startedAt: number;
  /** What the header showed while deciding where they go. */
  readonly words: { text: string; startedAt: number } | null;
  /** The key went down since it was held: it waits for what you say. */
  pressed: boolean;
  asking = false; // your words said it was wrong, not where it goes: the app asked
  said = false; // where it's going was said (app/deliver.ts sayWhere): not said again as it goes
  settled = false;
  /** Whether it goes, goes elsewhere (the resend about it), or doesn't. */
  readonly verdict: Promise<Verdict>;
  /** It went out, or won't. */
  readonly gone: Promise<void>;

  private timer: unknown = null;
  private resolve!: (verdict: Verdict) => void;
  private finish!: () => void;
  private o: HoldOptions;
  private clock: Clock;

  constructor(send: { to: Target; name: string; text: string; why: string; kind: "send" | "ask" | "resend"; last: Sent; words: Hold["words"]; pressed: boolean }, options: HoldOptions) {
    this.o = options;
    this.clock = options.clock ?? realClock;
    this.to = send.to;
    this.name = send.name;
    this.text = send.text;
    this.why = send.why;
    this.kind = send.kind;
    this.last = send.last;
    this.words = send.words;
    this.pressed = send.pressed;
    this.startedAt = this.clock.now();
    this.verdict = new Promise((resolve) => (this.resolve = resolve));
    this.gone = new Promise((resolve) => (this.finish = resolve));
  }

  /**
   * Where it's going has been heard (or never will be): it goes HOLD_MS from now, unless you pressed,
   * or said it was wrong. The line notices a press only every 20ms (app/deliver.ts sayWhere), so "wrong one"
   * can be dealt with before this comes: then the app's question keeps its own clock.
   */
  heard() {
    if (this.settled || this.pressed || this.asking) return;
    this.arm(() => !this.pressed && !this.asking && this.settle("send", { after: "timer" }), this.o.holdMs);
  }

  /** The key went down: it waits for what you say now. */
  press() {
    if (this.settled) return;
    this.pressed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
  }

  /**
   * Your words since the press are dealt with, without saying what to do with it (nothing heard, or
   * a newer press dropped them): it goes now. One you said was wrong doesn't. Not with the key down again.
   */
  afterWords() {
    if (!this.pressed || this.settled) return;
    if (this.asking) this.settle("cancel", { by: "unanswered" });
    else this.settle("send", { after: "your words" });
  }

  /**
   * Your words while it was held, as decide() read them: "cancel" drops it; a correction that says
   * where it goes sends it there instead (the resend about it), and one that doesn't keeps it until
   * you answer the app's question, then drops it; anything else lets it go first, then your words
   * are dealt with. Since nothing was sent, nothing needs stopping. `note` notes your words in the
   * timeline when nothing else did. The actions left to carry out.
   */
  async settleWith(d: Decision, text: string, note: () => void): Promise<Act[]> {
    if (d.actions.some((a) => a.type === "undo")) {
      this.settle("cancel", { by: "you", said: text });
      if (!d.router) note();
      // Words that took themselves back ("…actually, never mind"; decide.ts `retracted`): it doesn't
      // go, nor do they, and the one line says so, logged as `retracted`.
      const why = d.step === "retracted" ? { why: "retracted" } : {};
      return [...d.actions.filter((a) => a.type !== "undo"), { type: "say", text: "Okay, not sent.", ...why }];
    }
    const redirect = d.actions.find((a) => a.type === "resend" && a.last === this.last);
    if (redirect?.type === "resend") {
      this.settle("redirect", { toSessionId: redirect.session.sessionId, toName: this.o.nameOf(redirect.session), said: text });
      return d.actions;
    }
    if (d.correction && !this.asking) {
      // "Wrong one": the app asks where it goes, and your answer redirects it.
      this.asking = true;
      this.pressed = false;
      this.o.log("send_held", { sessionId: this.to.sessionId, name: this.name, text: this.text, why: this.why, kind: this.kind, waitingFor: "where it goes", said: text });
      this.arm(() => {
        this.settle("cancel", { by: "unanswered" });
        this.o.unanswered(this);
      }, this.o.answerMs);
      return d.actions;
    }
    // Said it was wrong, then moved on: it doesn't go.
    if (this.asking) {
      this.settle("cancel", { by: "moved on", said: text });
      return d.actions;
    }
    this.settle("send", { after: "your words", said: text });
    await this.gone;
    return d.actions;
  }

  /** Decides it, once. */
  settle(verdict: Verdict, fields: Record<string, unknown> = {}) {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.o.settled(this);
    const event = verdict === "send" ? "send_released" : verdict === "redirect" ? "send_redirected" : "send_cancelled";
    this.o.log(event, { sessionId: this.to.sessionId, name: this.name, text: this.text, why: this.why, kind: this.kind, heldMs: this.clock.now() - this.startedAt, ...fields });
    if (verdict === "cancel") this.o.info(`(not sent to ${this.name})`);
    this.o.changed();
    this.resolve(verdict);
    // Sending goes on in holdIf, which says when it's out.
    if (verdict !== "send") this.finish();
  }

  /** Sent: holdIf is done with it. */
  done() {
    this.finish();
  }

  /** Its one clock: a new one replaces the last, never runs beside it. */
  private arm(fn: () => void, ms: number) {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(fn, ms);
  }
}
