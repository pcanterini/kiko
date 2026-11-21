// Your words that couldn't be sent, kept a while (2026-11-12): the router gave no answer (offline, a
// timeout, an error), so nobody knows yet where they go. They're routed again by themselves, oldest
// first, with a growing wait (RETRY_STEPS_MS) and at once when the network comes back
// (app/deliver.ts retryKept), until RETRY_MAX tries or RETRY_FOR_MS; then the retries stop, and
// "send it" or a session's name alone sends them (decide.ts keptFor) until KEPT_MS after they were
// said. Taken once: whatever sends them takes them off the list first, so nothing goes twice. Never
// sent without the router or a name. Kept in memory only: a restart within minutes is rare, and the
// words are on Kiko's page and in the log (words_kept) all the same. Time and timers come in through
// `clock`, so tests/unit/core/kept.test.ts runs it on a fake one.
import { type Clock, realClock } from "./clock.ts";
import type { SessionNote } from "./router.ts";
import type { Session } from "./sessions.ts";

/** How long kept words wait, from when they were said, for the retries, "send it" or a name. */
export const KEPT_MS = 10 * 60_000;
/** The wait before each retry; the last one repeats. */
export const RETRY_STEPS_MS = [2000, 5000, 10_000, 20_000, 30_000];
/** Retries stop after this many tries, or this long after the first was kept: "Say send it to try again." */
export const RETRY_MAX = 8;
export const RETRY_FOR_MS = 3 * 60_000;
// More than this many unsent messages: the oldest goes (said in the log), so "send them" stays one go.
const MOST = 5;

/**
 * The conversation as it stood when the words were said, for routing them again as then
 * (app/deliver.ts): the sessions and their notes, the recent conversation, the session waiting for
 * your reply or just read out, and the one last talked to. Added 2026-11-20: words kept 87s went to
 * the session that had talked since (about them, as it happened), not the one they answered.
 */
export type KeptContext = {
  sessions: Session[];
  notes: Map<string, SessionNote>;
  recent: string[];
  waitingId: string | null;
  justSpoke: { id: string; secondsAgo: number } | null;
  lastId: string | null;
  heardFrom: string | null;
};

/**
 * One message kept: when it was said, and `held`: not retried any more (the retries stopped, or the
 * app asked whether still to send it), only "send it", a name or a yes sends it. `context`: the
 * conversation then, when it's known.
 */
export type KeptEntry = { text: string; at: number; held: boolean; context?: KeptContext };

export class KeptWords {
  private entries: KeptEntry[] = [];
  /** The retries under way, for the whole list in order: how many so far, since when, the next one's time. */
  private retry: { tries: number; since: number; dueAt: number } | null = null;
  /** The one taken by next() and being routed again: the retries go on until it's sent() or failed(). */
  private flying: KeptEntry | null = null;
  private expiry: unknown = null;
  private due: unknown = null;
  private clock: Clock;
  private ms: () => number;
  private steps: () => number[];

  /** A retry is due: route the words not held again, oldest first (next(), then sent() or failed()). */
  onDue: () => void = () => {};
  /** The retries stopped (RETRY_MAX, RETRY_FOR_MS) with these still unsent. */
  onGaveUp: (left: KeptEntry[]) => void = () => {};
  /** Kept words ran out unsent (oldest first). */
  onExpired: (gone: KeptEntry[]) => void = () => {};

  /** `steps`: the waits between retries (the faked-app harness shortens them). */
  constructor({ clock = realClock, ms = KEPT_MS, steps = RETRY_STEPS_MS }: { clock?: Clock; ms?: number | (() => number); steps?: number[] | (() => number[]) } = {}) {
    this.clock = clock;
    this.ms = typeof ms === "number" ? () => ms : ms;
    this.steps = Array.isArray(steps) ? () => steps : steps;
  }

  /**
   * Kept now (`at`: when they were said). `retry`: routed again by themselves (the router gave no
   * answer); false, only "send it" or a name sends them. A new one starts the retries again, for all
   * the ones not held, in order. The same words again replace the older copy. Returns any dropped as too many.
   */
  keep(text: string, { at = this.clock.now(), retry = true, context }: { at?: number; retry?: boolean; context?: KeptContext } = {}): KeptEntry[] {
    this.expire();
    this.entries = this.entries.filter((e) => e.text !== text);
    this.insert({ text, at, held: !retry, ...(context ? { context } : {}) });
    const dropped = this.entries.length > MOST ? this.entries.splice(0, this.entries.length - MOST) : [];
    if (retry && !this.retry) this.retry = { tries: 0, since: this.clock.now(), dueAt: this.clock.now() + this.step(0) };
    this.arm();
    return dropped;
  }

  /** What's kept now, oldest first. */
  list(): readonly KeptEntry[] {
    this.expire();
    return this.entries;
  }

  /** What decide() sees: the words, oldest first; null when nothing is kept. */
  pending(): { texts: string[] } | null {
    const all = this.list();
    return all.length ? { texts: all.map((e) => e.text) } : null;
  }

  /** Retries are under way: some words wait for one. */
  get retrying() {
    return this.retry !== null && (this.flying !== null || this.list().some((e) => !e.held));
  }

  /** The oldest one to retry now, taken off the list (then sent(), or failed() puts it back). */
  next(): KeptEntry | null {
    this.expire();
    const i = this.entries.findIndex((e) => !e.held);
    if (i < 0) return null;
    const e = this.entries[i];
    this.entries = this.entries.filter((x) => x !== e);
    this.flying = e;
    this.arm();
    return e;
  }

  /** `e` (taken with next()) was dealt with: the router answered. */
  sent(e: KeptEntry) {
    if (this.flying === e) this.flying = null;
    this.arm();
  }

  /** The router still can't answer `e` (taken with next()): back in its place, and the next retry later, or none. */
  failed(e: KeptEntry) {
    if (this.flying === e) this.flying = null;
    this.insert(e);
    this.failedAgain();
  }

  /** A retry that couldn't be made (known offline) counts as one that failed. */
  failedAgain() {
    if (!this.retry) return;
    this.retry.tries++;
    const now = this.clock.now();
    if (this.retry.tries >= RETRY_MAX || now - this.retry.since >= RETRY_FOR_MS) {
      this.retry = null;
      for (const e of this.entries) e.held = true;
      this.arm();
      const left = this.list();
      if (left.length) this.onGaveUp([...left]);
      return;
    }
    this.retry.dueAt = now + this.step(this.retry.tries);
    this.arm();
  }

  /** The network is back: the retry now, not at its time. */
  now() {
    if (!this.retrying || this.flying) return;
    this.retry!.dueAt = this.clock.now();
    this.arm();
  }

  /** Not retried any more (asked whether still to send it): kept for a yes, "send it" or a name. */
  hold(text: string, at: number) {
    this.expire();
    if (!this.entries.some((e) => e.text === text)) this.insert({ text, at, held: true });
    for (const e of this.entries) if (e.text === text) e.held = true;
    this.arm();
  }

  /** All of them, for sending: nothing is left to send twice, and the retries stop. */
  take(): KeptEntry[] {
    this.expire();
    const all = this.entries;
    this.entries = [];
    this.retry = null;
    this.flying = null;
    this.arm();
    return all;
  }

  /** Those words went (a yes, a pick): no longer kept. True when they were. */
  remove(text: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.text !== text);
    this.arm();
    return this.entries.length < before;
  }

  /** In the order said. */
  private insert(e: KeptEntry) {
    const i = this.entries.findIndex((x) => x.at > e.at);
    this.entries = i < 0 ? [...this.entries, e] : [...this.entries.slice(0, i), e, ...this.entries.slice(i)];
  }

  private step(tries: number) {
    const steps = this.steps();
    return steps[Math.min(tries, steps.length - 1)];
  }

  private expire() {
    const now = this.clock.now();
    const gone = this.entries.filter((e) => now - e.at >= this.ms());
    if (!gone.length) return;
    this.entries = this.entries.filter((e) => !gone.includes(e));
    this.onExpired(gone);
  }

  /** Timers: the oldest one running out (shown as it happens), and the next retry while any wait for one. */
  private arm() {
    if (this.expiry !== null) this.clock.clearTimeout(this.expiry);
    if (this.due !== null) this.clock.clearTimeout(this.due);
    this.expiry = null;
    this.due = null;
    // Nothing left to retry: the retries are over (a new one kept starts them again).
    if (!this.flying && !this.entries.some((e) => !e.held)) this.retry = null;
    const oldest = this.entries[0];
    if (oldest) {
      this.expiry = unref(
        this.clock.setTimeout(
          () => {
            this.expiry = null;
            this.expire();
            this.arm();
          },
          Math.max(0, oldest.at + this.ms() - this.clock.now()),
        ),
      );
    }
    if (this.retry && !this.flying) {
      this.due = unref(
        this.clock.setTimeout(
          () => {
            this.due = null;
            this.onDue();
          },
          Math.max(0, this.retry.dueAt - this.clock.now()),
        ),
      );
    }
  }
}

function unref(timer: unknown) {
  (timer as { unref?: () => void } | null)?.unref?.();
  return timer;
}

/**
 * Words kept, routed again: what the models are told, the conversation as it stood when they were
 * said (`then`), never what came since. Each session as it was then, while it's still running (one
 * started since, as it is `now`, with no notes from before); the session waiting for your reply then,
 * only while it still is (`waitingNow`), else as the one that had just spoken; one waiting now that
 * wasn't then isn't what they answer.
 */
export function asThen(then: KeptContext, now: Session[], waitingNow: string | null): KeptContext {
  const running = new Set(now.map((s) => s.sessionId));
  const old = new Set(then.sessions.map((s) => s.sessionId));
  const sessions = [...then.sessions.filter((s) => running.has(s.sessionId)), ...now.filter((s) => !old.has(s.sessionId))];
  const waitingId = then.waitingId && then.waitingId === waitingNow ? then.waitingId : null;
  const justSpoke = then.justSpoke ?? (then.waitingId && !waitingId && running.has(then.waitingId) ? { id: then.waitingId, secondsAgo: 0 } : null);
  return {
    ...then,
    sessions,
    notes: new Map(sessions.map((s) => [s.sessionId, then.notes.get(s.sessionId) ?? { asked: "", said: "" }])),
    waitingId,
    justSpoke,
  };
}
