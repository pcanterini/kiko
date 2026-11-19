/**
 * Who has the floor: the sessions held in their hooks, waiting their turn to be announced
 * (`queue`); the one announced last, waiting out its reply window (`current`); and you, while you
 * hold the key and while your words are dealt with. app.ts tells it what happens (a hook came in
 * or went away, the app's voice started or stopped, a key went down or up) and carries out what it
 * says: announce the next one (`make`), let one go when its window runs out, cut what's being said.
 *
 * In short: one thing at a time. Nothing is announced while you talk, your words are dealt with,
 * or the app speaks. A finished turn waits for your reply for its window (shorter when it was only
 * reporting), counted from when everything being said has been heard; another session in line cuts
 * it short (makeRoom). A press before an announcement made a sound, or in its first moments of
 * sound, puts it back (deferUnheard). Permission prompts go ahead of finished turns, and take over
 * from one only waiting out its window. One whose window runs out unanswered may stand (`stand`:
 * core/standing.ts): off the floor, its hook still held and its card up, and the next is announced.
 *
 * A finished turn is never dropped before you've heard it, unless you skip it ("skip that"), type
 * into its session yourself, or turn off what it's read out for (announce()'s quiet turns). Words for
 * one still in line wait for it to be read out (replyAfter), and one whose hook went away is still
 * read out, with no window after: its words came with it. Each drop is logged
 * (`announce_dropped`, with why).
 *
 * Time and timers come in through `clock`, so it runs on a fake one in tests/unit/core/floor.test.ts.
 * `Waiter` is all it knows of the agent (a Held from src/agents/: Claude Code's hooks today), and
 * `Reach` all it knows of how a session is reached once it stops waiting (its terminal, or
 * nothing: the desktop app, the background, a terminal none finds).
 */
import { type Clock, realClock } from "./clock.ts";
import { enqueue } from "./hook-queue.ts";
import type { Reach } from "./reach.ts";
import { heardBy } from "./routing-rules.ts";

/** A session held in its hook, waiting for you: a finished turn, or a permission prompt. */
export type Waiter = {
  readonly open: boolean;
  readonly isPermission: boolean;
  readonly sessionId: string;
  /** Lets it go without an answer: false when it was gone already. */
  release(): boolean;
};

/** The session whose finished turn was read out last, and when the reading ended (or it last waited). */
type SpokeLast = { sessionId: string; at: number };

/**
 * The announcement being made (a finished turn, or a permission prompt) until it has been heard: a
 * press before it made a sound, or in its first UNHEARD_MS of sound, puts it back (deferUnheard),
 * and so does a permission prompt coming in before a finished turn made a sound. `soundAt`: its
 * first sound. `speech`: its speech, once it has the voice. `undo`: puts back what making it
 * changed outside the floor (where replies go, "repeat that"), as it was before.
 */
export type Unheard<R> = {
  request: R;
  turn: number;
  startedAt: number;
  soundAt: number | null;
  speech: { cancel(): void } | null;
  deferred: boolean;
  spokeLast: SpokeLast | null;
  undo: () => void;
};

type FloorOptions<R extends Waiter> = {
  /** The windows' lengths as set now: the settings screen changes them while the app runs. */
  windows: () => { reply: number; fyi: number; permission: number };
  /** Below this, the classifier's read of a finished turn means it was only reporting something: the short window. */
  quietNeedsUser: number;
  /** A finished turn that only reported something, with another session in line, gives way this long after its reading ends. */
  giveWayMs: number;
  /** A press this soon after an announcement starts making a sound still puts it back. */
  unheardMs: number;
  /** Whether anything is being said or waits its turn to be (audio-queue.ts), and when that's over. */
  audio: { busy(): boolean; quiet(): Promise<void> };
  /** Why a session's window ran out, as shown when it's let go. */
  whyClosed: (request: R, reach: Reach) => string;
  /** Announce it: a finished turn read out, or a permission prompt asked. */
  make: (request: R) => void;
  /**
   * A permission prompt's window ran out unanswered: true when the app takes it (app/standing.ts,
   * core/standing.ts): it stands, still held, its card up (or it was answered in its own window
   * already), taken off the floor without being let go here. False (or none given): let go as
   * before, with whyClosed's line.
   */
  stand?: (request: R) => boolean;
  /** A permission prompt put back the announcement being made: cut what it's writing and saying. */
  cut: (unheard: Unheard<R>) => void;
  /** Barge-in: silence whatever is being written or said. `why`, and the session it was for: logged. */
  stopTalking: (why: string, sessionId?: string) => void;
  info: (text: string) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Something the status line and the UI show changed. */
  changed: () => void;
  clock?: Clock;
};

export class Floor<R extends Waiter> {
  /** Sessions that finished (or ask permission) and wait their turn to be announced. */
  readonly queue: R[] = [];
  /** The session announced last, still waiting for a reply. */
  current: R | null = null;
  /** Bumped by each press and each announcement; stale work checks it and bails. */
  turn = 0;
  pressed = false;
  pressedAt = 0; // when you last started talking
  /** Each press's number (keyDown counts them): which words came after which. */
  presses = 0;
  speaking = false;
  replying = 0; // what you said is still being dealt with: finished sessions wait (drain)
  // Cleared once anything else is announced or sent.
  spokeLast: SpokeLast | null = null;
  unheard: Unheard<R> | null = null;

  // The waiting session's window: how long, how a reply reaches it once it closes, the classifier's read of
  // the announced turn (null without it), when it started and when it ends.
  private windowMs: number;
  private reach: Reach = "terminal";
  private needsUser: number | null = null;
  private windowStartedAt = 0;
  private replyDeadline = 0;
  private replyTimer: unknown = null;
  private armWhenQuiet = false; // startReplyTimer() runs again once what's being said is over
  // The waiting finished turn your last words were dealt with while it waited: with another session
  // in line, it gives way once the app's answer is heard (makeRoom).
  private answered: R | null = null;
  // Words for a finished turn not read out yet: they go once it has been, in place of its window (replyAfter).
  private replies = new Map<R, () => void>();
  // The announcement your last press put back before you heard it: what "skip that" skips (skippable).
  private putBack: R | null = null;
  // The presses whose words are still being heard or dealt with (keyUp's `hear`), by number.
  private hearing = new Set<number>();

  private o: FloorOptions<R>;
  private clock: Clock;

  constructor(options: FloorOptions<R>) {
    this.o = options;
    this.clock = options.clock ?? realClock;
    this.windowMs = options.windows().reply;
  }

  /** The session waiting for a reply now, if its hook is still open. Not one being read out with your words already waiting for it. */
  get waiting() {
    return this.current?.open && !this.replies.has(this.current) ? this.current : null;
  }

  /**
   * The session waiting asked you something: a permission prompt, or a finished turn with the long
   * window (the classifier read it as needing you, or there's no read). False for one that was only
   * reporting (the short window), and with none waiting.
   */
  get asks() {
    const w = this.waiting;
    return w !== null && (w.isPermission || this.needsUser === null || this.needsUser >= this.o.quietNeedsUser);
  }

  /** When the waiting session's window ends; null while it isn't counting down. */
  get until() {
    return this.replyTimer !== null ? this.replyDeadline : null;
  }

  // ── Sessions held in their hooks ──────────────────────────────────────────

  /** A session finished, or asks permission. */
  add(request: R) {
    // Permission prompts block their session, so they go ahead of finished turns (hook-queue.ts).
    enqueue(this.queue, request);
    if (request.isPermission) {
      // And take over from a finished turn that's only waiting out its reply window. One still being
      // announced, not heard yet, waits behind it instead, still open: cut before it makes a sound.
      if (this.current && !this.current.isPermission && !this.pressed && !this.speaking) {
        const cut = this.unheard;
        if (this.deferUnheard("permission")) {
          this.turn++;
          this.o.cut(cut!); // not open yet: announce() cancels it once it is
        } else this.release(this.current, "a permission prompt came in");
      }
    } else {
      this.makeRoom(true);
    }
    this.drain();
  }

  /**
   * Its hook went away first (its timeout, or the session was interrupted). `note` is shown if it was
   * waiting. A finished turn not heard yet isn't lost with it: its words came with it, so it's
   * still read out in its place in line (or its reading goes on), with no window after, and words
   * for it are typed in once it has been.
   */
  closed(request: R, note: string) {
    if (!request.isPermission && this.queue.includes(request)) {
      this.o.log("hook_closed_unheard", { sessionId: request.sessionId, queued: true });
      return;
    }
    if (this.unqueue(request)) this.dropped(request, "hook_closed");
    if (this.current !== request) return;
    if (!request.isPermission && (this.replyTimer === null || this.unheardNow(request))) {
      // Still being read out (or you talk over it): it ends as its reading does, with no window.
      if (this.unheardNow(request)) this.o.log("hook_closed_unheard", { sessionId: request.sessionId, queued: false });
      this.o.info(note);
      this.startReplyTimer();
      this.o.changed();
      return;
    }
    this.current = null;
    this.clearReplyTimer();
    if (!this.pressed) this.o.stopTalking("hook_closed", request.sessionId);
    this.o.info(note);
    this.drain();
    this.o.changed();
  }

  /**
   * You typed into a session whose finished turn the floor holds (queued, or waiting out its
   * window): what you typed sits in Claude Code's queue until the hook lets go. So it lets go:
   * you've moved on, and an announcement not made yet isn't.
   */
  typedIn(request: R, why: string) {
    if (this.spokeLast?.sessionId === request.sessionId) this.spokeLast = null;
    // You were at its terminal: its answer was there to see. Words of yours waiting for it still go.
    if (this.unheardNow(request)) this.dropped(request, "typed_in");
    if (this.unqueue(request) || this.current !== request) return this.release(request, why);
    // Still being announced: cut it. Not while you talk or your words are dealt with: your press
    // already cut it, and stopping now would cut what's answering you.
    if (this.replyTimer === null && !this.pressed && !this.replying) {
      this.turn++;
      this.o.stopTalking("typed_in", request.sessionId);
    }
    this.release(request, why);
    this.drain();
  }

  /** Takes it out of line, if it's there: true when it was. */
  unqueue(request: R) {
    const i = this.queue.indexOf(request);
    if (i >= 0) this.queue.splice(i, 1);
    return i >= 0;
  }

  /** No longer the one waiting: it was answered. Its window goes with it; the caller drains. */
  drop(request: R) {
    if (this.current !== request) return;
    this.current = null;
    this.clearReplyTimer();
  }

  /** The finished turn of this session the floor still holds, announced or not. */
  heldStop(sessionId: string) {
    return [this.current, ...this.queue].find((r) => r?.open && !r.isPermission && r.sessionId === sessionId) ?? null;
  }

  /** A permission prompt (or questions) of this session the floor still holds, asked now or in line. */
  heldPermission(sessionId: string) {
    return [this.current, ...this.queue].find((r) => r?.open && r.isPermission && r.sessionId === sessionId) ?? null;
  }

  /** Whether it's the one announced last or in line. */
  has(request: R) {
    return this.current === request || this.queue.includes(request);
  }

  /** Whether the floor holds anything of this session in its hook. */
  holds(sessionId: string) {
    return [this.current, ...this.queue].some((r) => r?.open && r.sessionId === sessionId);
  }

  /**
   * The finished turn of this session you haven't heard yet: in line (its hook open or not), or being
   * read out with words already waiting for it. Words for it wait for it to be read out (replyAfter).
   */
  unread(sessionId: string) {
    const current = this.current && this.replies.has(this.current) ? [this.current] : [];
    return [...current, ...this.queue].find((r) => !r.isPermission && r.sessionId === sessionId) ?? null;
  }

  /**
   * Your words for a finished turn not read out yet (unread): it's read out first, in its place in
   * line, and `deliver` gives them to it once that's been heard, in place of its window. Also once
   * it's let go or skipped before then, or the app shuts down: they never wait on something that
   * won't come. The caller keeps the words; a second call for the same one changes nothing.
   */
  replyAfter(request: R, deliver: () => void) {
    if (!this.replies.has(request)) this.replies.set(request, deliver);
  }

  /** The words waiting for it were taken back ("never mind"): it's read out as any other, its window after. */
  cancelReply(request: R) {
    this.replies.delete(request);
  }

  /** Gives it the words waiting for it, if any: true when there were. */
  private deliver(request: R) {
    const deliver = this.replies.get(request);
    if (!deliver) return false;
    this.replies.delete(request);
    deliver();
    return true;
  }

  /** Whether any finished turn is still to be read out to you, or your words wait for one to be. */
  owesReading() {
    return this.replies.size > 0 || this.queue.some((r) => !r.isPermission) || (this.current !== null && this.unheardNow(this.current));
  }

  /**
   * What "skip that" skips: the announcement your last press put back before you heard it, while it's
   * still in line; with none put back, nothing waiting for a reply and nothing read out just before
   * (`justSpoke`: words then most likely answer that one), the next one in line. Null: nothing.
   */
  skippable(justSpoke = false) {
    if (this.putBack) return this.queue.includes(this.putBack) ? this.putBack : null;
    return this.waiting || justSpoke ? null : (this.queue[0] ?? null);
  }

  /** Skips it (skippable): out of line, and let go, or given the words waiting for it. False when it's gone already. */
  skip(request: R, why: string) {
    if (!this.unqueue(request)) return false;
    this.dropped(request, "skipped");
    this.release(request, why);
    return true;
  }

  /** Whether it's still to be heard: in line, or being announced and not heard yet (deferUnheard's test). */
  private unheardNow(request: R) {
    if (this.queue.includes(request)) return true;
    const u = this.unheard;
    if (this.current !== request || u?.request !== request) return false;
    return !heardBy(u.soundAt, this.clock.now(), this.speaking || this.o.audio.busy(), this.o.unheardMs);
  }

  /** An announcement you hadn't heard isn't made, or not all of it: logged with why. */
  dropped(request: R, reason: string) {
    this.o.log("announce_dropped", { sessionId: request.sessionId, kind: request.isPermission ? "permission" : "stop", reason });
  }

  /** Announce the next finished session when nobody is talking. */
  drain(): void {
    if (this.pressed || this.replying || this.speaking || this.current) return;
    const request = this.queue.shift();
    if (!request) return;
    // A permission prompt whose hook went away was answered in the terminal: nothing to ask. A finished
    // turn's is read out all the same (closed).
    if (!request.open && request.isPermission) {
      this.dropped(request, "hook_closed");
      return this.drain();
    }
    this.current = request;
    this.reach = "terminal";
    this.needsUser = null;
    this.answered = null;
    this.windowMs = request.isPermission ? this.o.windows().permission : this.o.windows().reply;
    this.o.make(request);
  }

  /**
   * Let the waiting session go without an answer: a finished turn stops, a permission prompt shows in
   * the terminal. One with your words waiting for it gets them instead (replyAfter).
   */
  release(request: R | null, why: string) {
    if (!request) return;
    // Only its own window: one let go after it stopped waiting leaves the next one's alone.
    if (this.current === request) {
      this.current = null;
      this.clearReplyTimer();
    }
    if (!this.deliver(request) && request.release()) this.o.info(`(${why})`);
    this.o.changed();
  }

  /**
   * Its window ran out: let go (release), unless it's a permission prompt that stands (`stand`): then
   * it's only off the floor, still held, and the next one in line is announced (the caller drains).
   */
  private ranOut(request: R, why: string) {
    if (request.isPermission && request.open && this.o.stand?.(request)) {
      this.current = null;
      this.clearReplyTimer();
      this.o.changed();
      return;
    }
    this.release(request, why);
  }

  /** Releases every session held, for shutting down; words waiting for one go to it. */
  releaseAll() {
    for (const request of [this.current, ...this.queue]) {
      if (!request) continue;
      if (this.unheardNow(request)) this.dropped(request, "shutdown");
      if (!this.deliver(request)) request.release();
    }
  }

  /** Bumps the turn: work started before this is stale. */
  bump() {
    return ++this.turn;
  }

  // ── Announcing ────────────────────────────────────────────────────────────

  /** An announcement starts (drain's `make`): a new turn, tracked until it makes a sound. */
  announcing(request: R, undo: () => void): Unheard<R> {
    const u: Unheard<R> = {
      request,
      turn: ++this.turn,
      startedAt: this.clock.now(),
      soundAt: null,
      speech: null,
      deferred: false,
      spokeLast: this.spokeLast,
      undo,
    };
    this.unheard = u;
    return u;
  }

  /** Nothing more to hear from this announcement (it was quiet, had no words, or the screen showed it): a press is a reply. */
  forget(u: Unheard<R>) {
    if (this.unheard === u) this.unheard = null;
  }

  /**
   * The classifier's read of the finished turn being announced (`needsUser`, null without it), and how a
   * reply reaches it once its window closes. Its window's length, which is also kept if it's still
   * the one waiting.
   */
  judged(request: R, reach: Reach, needsUser: number | null) {
    const windows = this.o.windows();
    const windowMs = needsUser !== null && needsUser < this.o.quietNeedsUser ? windows.fyi : windows.reply;
    if (this.current === request) {
      this.reach = reach;
      this.needsUser = needsUser;
      this.windowMs = windowMs;
    }
    return windowMs;
  }

  /**
   * A press before the announcement being made made any sound, or in its first UNHEARD_MS of sound:
   * you haven't heard it, so it isn't lost (released when the window ran out) or taken as what your
   * words answer; they most likely answer what came before it. It goes back to the front of the
   * queue, still open, and drain() makes it again once your words are dealt with, at once on key up
   * when you said nothing. Words that answer that session meanwhile go through its hook (sendTo's
   * held stop), and a closed request is skipped. Past those first moments, or once it's over, a press
   * is a barge-in. A permission prompt coming in before a finished turn made a sound puts it back the
   * same way, and is asked first, and so does a voice preview in the settings screen. A finished turn
   * whose hook went away is put back too: it's still read out (closed). True when it put one back;
   * the caller cuts what it was saying.
   */
  deferUnheard(reason: "press" | "permission" | "preview") {
    const u = this.unheard;
    this.unheard = null;
    if (!u || this.current !== u.request || (!u.request.open && u.request.isPermission)) return false;
    const heard = reason === "permission" ? u.soundAt !== null : heardBy(u.soundAt, this.clock.now(), this.speaking || this.o.audio.busy(), this.o.unheardMs);
    if (heard) return false;
    const id = u.request.sessionId;
    u.deferred = true;
    this.current = null;
    // Its window, if it started before a sound (announce() starts it as the speech is handed over),
    // goes back with it: left counting, it would let whoever waits next go.
    this.clearReplyTimer();
    enqueue(this.queue, u.request, true);
    // Back as it was: nothing was heard from it, so it's named when it's made again, isn't where
    // your words go by default, and "repeat that" isn't it.
    if (!this.spokeLast || this.spokeLast.sessionId === id) this.spokeLast = u.spokeLast;
    u.undo();
    this.o.log("announce_deferred", {
      sessionId: id,
      kind: u.request.isPermission ? "permission" : "stop",
      reason,
      afterMs: this.clock.now() - u.startedAt,
      afterSoundMs: u.soundAt === null ? null : this.clock.now() - u.soundAt,
    });
    return true;
  }

  // ── The app's voice ───────────────────────────────────────────────────────

  /**
   * What's being said started making a sound. `own`: it's the announcement's own sound, not a line
   * of the app's said ahead of it (app/announce.ts announce): only that makes it heard.
   */
  playing(own = true) {
    this.speaking = true;
    // It's being heard: a press is a barge-in once its first moments are over (deferUnheard).
    if (own && this.unheard?.turn === this.turn) this.unheard.soundAt ??= this.clock.now();
    this.clearReplyTimer();
    this.o.changed();
  }

  /** It's over: nothing more is coming out. */
  idle() {
    this.speaking = false;
    const spoke = this.spokeLast;
    if (spoke && this.current?.open && this.current.sessionId === spoke.sessionId) spoke.at = this.clock.now();
    this.startReplyTimer();
    this.drain();
    this.o.changed();
  }

  // ── Push to talk ──────────────────────────────────────────────────────────

  /**
   * The key went down: a new turn, and the window stops counting. Before it made a sound, or in its
   * first moments of sound, the announcement being made waits until you're done instead (the caller
   * cuts what's being said). False when the key was down already.
   */
  keyDown() {
    if (this.pressed) return false;
    this.pressed = true;
    this.pressedAt = this.clock.now();
    this.presses++;
    this.turn++;
    this.clearReplyTimer();
    const u = this.unheard;
    this.putBack = this.deferUnheard("press") ? u!.request : null;
    // Heard, and cut: with your words already waiting for it, or its hook gone, nothing waits for a
    // reply. The words go now, ahead of what you're about to say.
    const current = this.current;
    if (current && (this.replies.has(current) || !current.open)) this.over(current);
    return true;
  }

  /**
   * The key went up. A session that finishes while `hear` deals with what you said waits until it's
   * done: its announcement goes after the app's answer, and your words aren't taken as a reply to
   * it. `hear` (given the press's number) is true once there were words, and they were dealt with;
   * `then` runs once it's done, before the window starts again. False when the key wasn't down. If
   * `hear` fails (speech to text, say), nothing was dealt with, and the rest still happens: otherwise
   * nothing more is announced until something else comes along.
   */
  async keyUp(hear: (press: number) => Promise<boolean>, then?: () => void) {
    if (!this.pressed) return false;
    this.pressed = false;
    this.replying++;
    const press = this.presses;
    this.hearing.add(press);
    let dealt = false;
    try {
      dealt = await hear(press);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.o.log("error", { where: "hear", message });
      this.o.info(`(couldn't hear that: ${message})`);
    } finally {
      this.replying--;
      this.hearing.delete(press);
    }
    then?.();
    // A question to the app, or words it only acknowledged, leave the waiting session waiting; its
    // window starts over. With another session in line, a finished turn gives way instead (makeRoom).
    if (dealt && !this.pressed && this.current?.open && !this.current.isPermission) this.answered = this.current;
    this.startReplyTimer();
    this.drain();
    return true;
  }

  /**
   * Whether words of yours come after press `press`'s: the key is down, or a later press's words are
   * still being heard or dealt with. A send of those earlier words then waits for them (app/deliver.ts holdIf).
   */
  wordsAfter(press: number) {
    return this.pressed || [...this.hearing].some((n) => n > press);
  }

  // ── The reply window ──────────────────────────────────────────────────────

  /**
   * Starts the waiting session's window. Only once everything being said has been heard: an idle
   * between two chunks of a speech isn't its end (audio-queue.ts), and a speech in line, or handed
   * to the voice and not playing yet, starts it when it's done instead of now. Not while your words
   * are dealt with: a quiet moment then (after "To Lacy.", say) isn't the end of it, and the window
   * could run out while the app still decides; keyUp starts it once they are.
   */
  startReplyTimer() {
    this.clearReplyTimer();
    const current = this.current;
    if (!current || this.pressed || this.replying || this.speaking) return;
    // Your words already wait for it, or its hook is gone: nothing waits for a reply, so no window.
    const done = !current.open || this.replies.has(current);
    if (this.o.audio.busy()) {
      if (!this.armWhenQuiet) {
        this.armWhenQuiet = true;
        void this.o.audio.quiet().then(() => {
          this.armWhenQuiet = false;
          this.startReplyTimer();
        });
      }
      return;
    }
    if (done) {
      // Not before its reading made a sound: a speech that never starts lets it go when the window
      // would have run out (release() gives it your words).
      const u = this.unheard;
      if (u?.request === current && u.soundAt === null) return this.armReplyTimer(this.windowMs);
      return this.over(current);
    }
    this.windowStartedAt = this.clock.now();
    this.armReplyTimer(this.windowMs);
    this.makeRoom(false);
  }

  /** Read out, and nothing waits for a reply: your words for it go now, if any, and the next is announced. */
  private over(request: R) {
    this.current = null;
    this.clearReplyTimer();
    this.deliver(request);
    this.drain();
    this.o.changed();
  }

  clearReplyTimer() {
    if (this.replyTimer !== null) this.clock.clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.replyDeadline = 0;
  }

  /**
   * The waiting session's window ends in `ms`. The window is that session's: if another is waiting
   * by the time it runs out, it lets nobody go (its note is about the one it was set for).
   */
  private armReplyTimer(ms: number) {
    if (this.replyTimer !== null) this.clock.clearTimeout(this.replyTimer);
    const request = this.current!;
    this.replyDeadline = this.clock.now() + ms;
    const why = this.o.whyClosed(request, this.reach);
    this.replyTimer = this.clock.setTimeout(() => {
      if (this.current === request) this.ranOut(request, why);
      else {
        this.clearReplyTimer();
        this.o.changed();
      }
      this.drain();
    }, ms);
    this.o.changed();
  }

  /**
   * Another session finished while this one waits out its reply window, and would wait in silence
   * until it ends. One your words were just dealt with gives way at once (its window starts once the
   * app's answer is heard). One that only reported something gives way as that one comes in
   * (`arrived`), or GIVE_WAY_MS after its reading ended when that one was already in line; one that
   * asked you something keeps the short window, counted from when its own started. The window ends
   * as if it ran out, so the session can still be reached after. Never a permission prompt's, and
   * not while you talk or your words are being dealt with: keyUp restarts the window, and this.
   */
  private makeRoom(arrived: boolean) {
    const current = this.current;
    if (!current?.open || current.isPermission || this.replies.has(current) || this.replyTimer === null || this.pressed || this.replying || this.speaking) return;
    const done = this.answered === current;
    if (!this.queue.some((r) => r.open)) {
      // Nothing in line once your words were dealt with: its window started over, as before.
      if (done && !arrived) this.answered = null;
      return;
    }
    const asked = this.needsUser === null || this.needsUser >= this.o.quietNeedsUser;
    const left = done || (arrived && !asked) ? 0 : Math.max(0, this.windowStartedAt + (asked ? this.o.windows().fyi : this.o.giveWayMs) - this.clock.now());
    if (left >= this.replyDeadline - this.clock.now()) return;
    const id = current.sessionId;
    // You were just talking about it: words that come a moment late still go to it ("just spoke").
    if (done && this.spokeLast?.sessionId === id) this.spokeLast.at = this.clock.now();
    this.o.log("window_cut", { sessionId: id, needsUser: this.needsUser, answered: done, leftMs: Math.round(left) });
    this.armReplyTimer(left);
  }
}
