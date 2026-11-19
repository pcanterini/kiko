// What became of each thing said or typed on the phone, told back to that phone as it happens
// (talk_status): heard (the transcript is ready), routed (to a session, or to Kiko itself), held
// (it waits before going in), delivered (in the session; `queued` when it was busy then), started
// (Claude began the turn with it), replied (that turn is over: its reply is ready), answered
// (Kiko itself dealt with it) or failed (nothing was sent, and why). Until it's replied, answered
// or failed, the phone shows that a reply is owed. The phone ties them to its message by the talkId it gave (talk_start, type).
//
// The app (app.ts) begins one per press or typed message from a phone that gave an id, and runs the
// words' handling inside it (`run`): everything that handling does, however deep and however many
// awaits later, tells the talk it belongs to (`current`) without being passed it. Something that
// waits on another event (words given to a finished turn once it's read out) takes the talks with it
// and runs inside them again. Stages only move forward, and once a talk has ended (failed, answered,
// replied) nothing more is told; once it's in the session (delivered, started) only started and
// replied can follow. `finish`, when the handling is over, makes sure no talk is left
// hanging: one that went nowhere is failed, one Kiko dealt with is answered.
//
// Started: a talk delivered by typing waits for its session to take the words in: Claude Code's
// UserPromptSubmit hook with the same prompt, or a T3 Code run starting with them (promptSubmitted), or, for words typed while it was busy
// and taken in mid-turn, the turn's end listing them among what reached it (turnEnded). One given as
// a finished turn's reply carries on at once: started with delivered.
//
// Replied: a started talk's session finished a turn (its Stop hook: the reply is ready, to be read
// out or not), `turnEnded`. A turn that took typed words in mid-turn starts them and replies to them
// at once. One never replied to (a session without Kiko's hooks, one that closed) is forgotten
// after a while, and the phone stops waiting by itself.
import { AsyncLocalStorage } from "node:async_hooks";
import { flat } from "../core/text.ts";

type TalkStage = "heard" | "routed" | "held" | "delivered" | "started" | "replied" | "answered" | "failed";

/** One talk_status message, without `v` and `type`. */
export type TalkStatus = {
  talkId: string;
  stage: TalkStage;
  sessionId?: string | null;
  name?: string | null;
  text?: string;
  detail?: string;
  queued?: boolean;
};

/** Where words go: a session (its ID and name), or null for Kiko itself. */
export type Where = { sessionId: string; name: string } | null;

/** Waits for its session to take the words in this long at most; then it's forgotten (still delivered). */
export const STARTED_WITHIN_MS = 30 * 60_000;
/** Waits for the turn it started to end this long at most; then it's forgotten (still started). */
export const REPLIED_WITHIN_MS = 60 * 60_000;

const ENDED: ReadonlySet<TalkStage> = new Set(["failed", "answered", "replied"]);
const IN_SESSION: ReadonlySet<TalkStage> = new Set(["delivered", "started"]);
const TEXT_MAX = 4000;
const DETAIL_MAX = 300;

/** One press or typed message from a phone, and what became of it. */
export class Talk {
  readonly id: string;
  readonly phoneId: string;
  /** Typed on the phone's keyboard, not said: typed into a session, its agent isn't told they were dictated (core/dictated.ts). */
  readonly typed: boolean;
  stage: TalkStage | null = null;
  /** Where it was last routed: undefined until it is, null for Kiko itself. */
  where: Where | undefined = undefined;
  private tell: (talk: Talk, status: TalkStatus) => void;

  constructor(id: string, phoneId: string, tell: (talk: Talk, status: TalkStatus) => void, typed = false) {
    this.id = id;
    this.phoneId = phoneId;
    this.typed = typed;
    this.tell = tell;
  }

  /** It has ended: failed, answered or replied. */
  get ended() {
    return this.stage !== null && ENDED.has(this.stage);
  }

  /** In its session or ended: nothing before delivered can be told any more. */
  get settled() {
    return this.ended || (this.stage !== null && IN_SESSION.has(this.stage));
  }

  /** The transcript is ready (`text`: the words, for a press; typed words the phone has already). */
  heard(text?: string) {
    if (this.stage !== null) return;
    this.set("heard", text ? { text: text.slice(0, TEXT_MAX) } : {});
  }

  /** Where it's going. Again for another session (one of several asked), until it's delivered. */
  routed(where: Where) {
    if (this.settled) return;
    if (this.stage === "routed" && same(this.where, where)) return;
    if (this.stage === "held" && same(this.where, where)) return;
    this.where = where;
    this.set("routed", at(where));
  }

  /** It waits before going in to `where` (`detail`: for what). */
  held(where: Where, detail: string) {
    if (this.settled) return;
    this.where = where;
    this.set("held", { ...at(where), detail: detail.slice(0, DETAIL_MAX) });
  }

  /** In the session: `text` went in; `queued` while it was busy (it takes them once it's done). */
  delivered(where: NonNullable<Where>, text: string, queued = false) {
    if (this.settled) return;
    this.where = where;
    this.set("delivered", { ...at(where), text: text.slice(0, TEXT_MAX), ...(queued ? { queued: true } : {}) });
  }

  /** Claude began the turn with it. Only once it's delivered. */
  started() {
    if (this.stage !== "delivered") return;
    this.set("started", at(this.where ?? null));
  }

  /** The turn it started is over: its reply is ready. Only once it's started. */
  replied() {
    if (this.stage !== "started") return;
    this.set("replied", at(this.where ?? null));
  }

  /** Kiko itself dealt with it (it went to the app, not a session). */
  answered() {
    if (this.settled) return;
    this.set("answered", at(null));
  }

  /** Nothing was sent: `detail`, short, for the phone to show. Not once it's in a session. */
  failed(detail: string) {
    if (this.settled) return;
    this.set("failed", { ...(this.where !== undefined ? at(this.where) : {}), detail: detail.slice(0, DETAIL_MAX) });
  }

  /**
   * Its words have been dealt with: none is left hanging. Delivered, ended, or held (still to go,
   * and it settles itself), it's left as it is; routed to Kiko, it was answered; anything else
   * went nowhere: failed, with `why`.
   */
  finish(why: string) {
    if (this.settled || this.stage === "held") return;
    if (this.stage === "routed" && this.where === null) return this.answered();
    this.failed(why);
  }

  private set(stage: TalkStage, fields: Partial<TalkStatus>) {
    this.stage = stage;
    this.tell(this, { talkId: this.id, stage, ...fields });
  }
}

const at = (where: Where): Pick<TalkStatus, "sessionId" | "name"> => ({ sessionId: where?.sessionId ?? null, name: where?.name ?? null });
const same = (a: Where | undefined, b: Where) => (a === null ? b === null : a !== undefined && b !== null && a.sessionId === b.sessionId);

/**
 * The talks going on, and the one each piece of handling belongs to. `send` gets each status for
 * its phone (PhoneServer.talkStatus).
 */
export class Talks {
  private als = new AsyncLocalStorage<readonly Talk[]>();
  private send: (phoneId: string, status: TalkStatus) => void;
  private now: () => number;
  // Delivered by typing, waiting for their session to take them in.
  private waiting: Array<{ talk: Talk; sessionId: string; text: string; at: number }> = [];
  // Started, waiting for their turn to end.
  private replying: Array<{ talk: Talk; sessionId: string; at: number }> = [];

  constructor(send: (phoneId: string, status: TalkStatus) => void, now: () => number = Date.now) {
    this.send = send;
    this.now = now;
  }

  /** A press or typed message (`typed`) from a phone; null when it gave no id (an older app: no statuses). */
  begin(talkId: string | null | undefined, phoneId: string, typed = false): Talk | null {
    if (!talkId) return null;
    return new Talk(
      talkId,
      phoneId,
      (talk, status) => {
        // However it started (typed and taken in, given as a turn's reply), its turn's end replies.
        if (status.stage === "started" && talk.where) this.replying.push({ talk, sessionId: talk.where.sessionId, at: this.now() });
        this.send(talk.phoneId, status);
      },
      typed,
    );
  }

  /** Runs `fn` as the handling of these talks (none: of nothing, even inside another's). */
  run<T>(talks: Talk | readonly Talk[] | null, fn: () => T): T {
    return this.als.run(talks === null ? [] : talks instanceof Talk ? [talks] : talks, fn);
  }

  /** The talks the handling running now belongs to: none outside a phone's words. */
  current(): readonly Talk[] {
    return this.als.getStore() ?? [];
  }

  // As Talk's, for the talks of the handling running now.

  routed(where: Where) {
    for (const t of this.current()) t.routed(where);
  }

  /** Held: returned, to take along to where they go in later (`run`). */
  held(where: Where, detail: string) {
    const talks = this.current();
    for (const t of talks) t.held(where, detail);
    return talks;
  }

  /**
   * In the session. Given as a finished turn's reply (`started`), it carries on with them at once;
   * typed, the talk waits for the session to take them in.
   */
  delivered(where: NonNullable<Where>, text: string, opts: { queued?: boolean; started?: boolean } = {}) {
    this.prune();
    for (const t of this.current()) {
      if (t.settled) continue;
      t.delivered(where, text, opts.queued);
      if (opts.started) t.started();
      else this.waiting.push({ talk: t, sessionId: where.sessionId, text: flat(text), at: this.now() });
    }
  }

  failed(detail: string) {
    for (const t of this.current()) t.failed(detail);
  }

  /**
   * A session took a prompt in (Claude Code's UserPromptSubmit): the talks typed into it with
   * those words started. `sessionIds`: every ID the session goes by. Several messages queued while
   * it was busy may come in as one prompt.
   */
  promptSubmitted(sessionIds: readonly string[], prompt: string) {
    const p = flat(prompt);
    if (!p) return;
    this.start(sessionIds, (text) => p === text || p.includes(text));
  }

  /**
   * A session finished a turn (its Stop hook): talks typed into it while it was busy that reached
   * it during the turn (`said`, from its own record: read only when some wait on it) started then,
   * if nothing said so before; and every talk started in it has its reply.
   */
  turnEnded(sessionIds: readonly string[], said: () => string[] | null) {
    this.prune();
    if (this.waiting.some((w) => sessionIds.includes(w.sessionId))) {
      const words = (said() ?? []).map((s) => flat(s));
      this.start(sessionIds, (text) => words.some((w) => w === text || w.includes(text)));
    }
    this.replying = this.replying.filter((r) => {
      if (!sessionIds.includes(r.sessionId)) return true;
      r.talk.replied();
      return false;
    });
  }

  private start(sessionIds: readonly string[], took: (text: string) => boolean) {
    this.waiting = this.waiting.filter((w) => {
      if (!sessionIds.includes(w.sessionId) || !took(w.text)) return true;
      w.talk.started();
      return false;
    });
  }

  private prune() {
    const now = this.now();
    this.waiting = this.waiting.filter((w) => w.at >= now - STARTED_WITHIN_MS && w.talk.stage === "delivered");
    this.replying = this.replying.filter((r) => r.at >= now - REPLIED_WITHIN_MS && r.talk.stage === "started");
  }
}
