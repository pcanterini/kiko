// Permission prompts that stay up after their voice window: "standing". Kiko asks a prompt out loud
// and waits its permission window (20 s); nobody answering used to let its hook go at once, so the
// Mac's card and the phone's Allow/Deny went with it. Someone who stepped away (the kitchen, the
// phone left on the desk) could never answer it from the apps later.
//
// Now every prompt whose window runs out stands: its hook stays held, its card stays up on the Mac
// and on every phone, whether or not you're at the Mac. Standing takes no way of answering away:
// Claude Code draws its own dialog in its terminal beside a held hook (checked live 2026-11-05), and
// OpenCode's and T3 Code's apps keep asking, so the card, the phone and its own window all answer
// it. Codex shows no prompt of its own while its hook is held (Held.onlyHere): until it's let go,
// only the card and the phone do.
//
// It's settled at once wherever it's answered: the Mac's card (y, n, a), by voice, a phone, or it's
// over without an answer from here (`gone`): its hook went away (the session interrupted, the hook's
// own timeout: a Codex safety-gate ask's denies the call at 280 s), it was answered in its own window
// (Claude Code leaves the hook running when it's answered there: the app tells by its transcript and
// its session's status, agents/claude-code/answered-there.ts; OpenCode says so), its turn went on (its next Stop), or its session ended (gone from the list). Only its hold
// limit lets it go unanswered (`holdLimitMs` from when its hook came in, under the installed hook's
// timeout). Each is logged: `permission_stood`, `permission_released_back`, `permission_answered_late`,
// `permission_stand_gone`.
//
// Generalised from the trust cards' TrustCards (core/trust-prompt.ts): a store of what's up, added
// to and settled once, with how. Unlike those, a session can have several standing at once (a
// subagent's prompt beside its own), so they're kept by prompt, not by session.
//
// Platform-neutral and terminal-neutral: time comes through `clock` (tests/unit/core/standing.test.ts
// runs it on a fake one), and letting go is the held prompt's own release(): its hook prints nothing,
// and its agent asks wherever it runs.
import { type Clock, realClock } from "./clock.ts";

/** What the store needs of a held prompt (agents/types.ts Held has it). */
export type Standable = {
  readonly open: boolean;
  readonly sessionId: string;
  /** Lets it go without an answer: its agent asks in its own window. False when it was gone already. */
  release(): boolean;
};

/** How a standing prompt was answered: the Mac's card, by voice, a phone. */
export type AnsweredHow = "card" | "voice" | "phone";

/**
 * How a standing prompt was let go without an answer: its hook's limit was near (`hold_limit`),
 * Kiko shut down (`shutdown`), or something else let it go (`left`: its questions left to the
 * terminal).
 */
export type ReleasedHow = "hold_limit" | "shutdown" | "left";

/** How it was over without an answer from here (StandingPrompts.gone). */
export type GoneHow = "hook_closed" | "terminal" | "turn_ended" | "session_ended";

/** How it came down: answered here, let go to its terminal, or its hook went away by itself. */
export type StandSettled = { kind: "answered"; how: AnsweredHow } | { kind: "released"; how: ReleasedHow } | { kind: "gone" };

/** What's known of it as it stands. */
export type StandInfo = {
  /** When it was first asked out loud (ms on the store's clock): logged. */
  askedAt: number;
  /** When its hook came in: the hold limit counts from then (the hook's own timeout does). */
  heldSince: number;
};

type Entry<R> = StandInfo & {
  request: R;
  stoodAt: number;
  limit: unknown;
};

export type StandingOptions<R> = {
  /** How long after its hook came in a standing prompt is let go: under the hook's own timeout. */
  holdLimitMs: number;
  /** It stood (logged here): the app says so on screen. */
  stood(request: R): void;
  /** It came down, however (`how`): the app takes its card down from the Mac and every phone. */
  settled(request: R, how: StandSettled): void;
  log(event: string, fields: Record<string, unknown>): void;
  clock?: Clock;
};

/** The prompts standing now, and their limits. */
export class StandingPrompts<R extends Standable> {
  private entries = new Map<R, Entry<R>>();
  private o: StandingOptions<R>;
  private clock: Clock;

  constructor(options: StandingOptions<R>) {
    this.o = options;
    this.clock = options.clock ?? realClock;
  }

  /** Its voice window ended unanswered: it stands, on the cards until it's answered, over, or at its hold limit. */
  stand(request: R, info: StandInfo) {
    if (this.entries.has(request) || !request.open) return;
    const now = this.clock.now();
    const limitMs = info.heldSince + this.o.holdLimitMs - now;
    const entry: Entry<R> = { ...info, request, stoodAt: now, limit: null };
    this.entries.set(request, entry);
    entry.limit = this.clock.setTimeout(() => this.release(request, "hold_limit"), Math.max(0, limitMs));
    this.o.log("permission_stood", { sessionId: request.sessionId, sinceAskedMs: Math.round(now - info.askedAt), limitMs: Math.round(limitMs) });
    this.o.stood(request);
  }

  /** Whether it's up here. */
  has(request: R) {
    return this.entries.has(request);
  }

  /** Every one up and still held, oldest first (by when its hook came in). */
  list(): R[] {
    return [...this.entries.values()]
      .filter((e) => e.request.open)
      .sort((a, b) => a.heldSince - b.heldSince)
      .map((e) => e.request);
  }

  /** Answered here (the caller gave it its answer): taken down, logged. False when it wasn't up. */
  answered(request: R, how: AnsweredHow) {
    const entry = this.entries.get(request);
    if (!entry) return false;
    this.drop(entry);
    this.o.log("permission_answered_late", { sessionId: request.sessionId, how, stoodMs: Math.round(this.clock.now() - entry.stoodAt) });
    this.o.settled(request, { kind: "answered", how });
    return true;
  }

  /**
   * It's over without an answer from here: its hook went away by itself (`hook_closed`: the session
   * interrupted, the hook's own timeout), or it was answered in its own window while its hook was
   * still held (`terminal`: Claude Code shows its dialog beside a held hook, and answered there it
   * leaves the hook running, 2.1.318), or its turn went on past it (`turn_ended`), or its session
   * ended with its hook still held (`session_ended`: gone from the list, its process too). Taken down; a
   * hook still held is let go (an answer through it would come to nothing).
   */
  gone(request: R, how: GoneHow = "hook_closed") {
    const entry = this.entries.get(request);
    if (!entry) return false;
    this.drop(entry);
    if (request.open) request.release();
    this.o.log("permission_stand_gone", { sessionId: request.sessionId, how, stoodMs: Math.round(this.clock.now() - entry.stoodAt) });
    this.o.settled(request, { kind: "gone" });
    return true;
  }

  /** Let go to its terminal (its release()), taken down, logged. False when it wasn't up. */
  release(request: R, how: ReleasedHow) {
    const entry = this.entries.get(request);
    if (!entry) return false;
    this.drop(entry);
    const letGo = request.release();
    this.o.log("permission_released_back", { sessionId: request.sessionId, how, stoodMs: Math.round(this.clock.now() - entry.stoodAt), ...(letGo ? {} : { gone: true }) });
    this.o.settled(request, letGo ? { kind: "released", how } : { kind: "gone" });
    return true;
  }

  /** Every one let go, for shutting down. */
  releaseAll() {
    for (const request of [...this.entries.keys()]) this.release(request, "shutdown");
  }

  private drop(entry: Entry<R>) {
    this.entries.delete(entry.request);
    if (entry.limit !== null) this.clock.clearTimeout(entry.limit);
  }
}
