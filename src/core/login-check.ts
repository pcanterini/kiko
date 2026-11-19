// A turn Claude Code ended with "Not logged in · Please run /login" instead of a reply: said out
// loud, and for a session the app just opened with a first message, that message sent again once.
//
// Why: a session opened in ~ for a request to change a Mac setting had that error as its first
// reply, 1ms after its request was built ("<synthetic>", error "authentication_failed"), while every
// other session that night logged in.
// It isn't the home folder, Kiko's tmux or how the session starts: the same command, in ~, from
// a tmux server of its own, through the same trust prompt and Down+Enter, logged in. It's
// Claude Code (2.1.314): as it starts it reads its login from the Keychain once (`security
// find-generic-password`), and a read that fails is kept as "no login" for 30 seconds, so a prompt
// in those 30 seconds (Kiko's comes within seconds: it's on the command line) gets "Not logged
// in". Nothing ran (no model call, no tool), so sending it again after that is safe. Claude Code
// runs no Stop hook for such a turn (StopFailure instead, which isn't one of Kiko's hooks), so
// the app heard nothing and the session sat there: hence reading its transcript (history.ts turnSoFar).
import { promptKey } from "./dictated.ts";
import type { TurnSoFar } from "./history.ts";
import { log } from "./log.ts";
import { envVar } from "./name.ts";

/**
 * How often a turn is read after its prompt, and for how long (an error comes within a second; a
 * reply starts within seconds); and how long after the app opened a session its first message is
 * sent again: past Claude Code's 30 seconds of a failed Keychain read, with a margin
 * (KIKO_LOGIN_RETRY_MS sets it, read each time: the harness, shorter).
 */
export const LOGIN_TIMES = {
  everyMs: 500,
  forMs: 20_000,
  get retryAfterMs() {
    return Number(envVar("LOGIN_RETRY_MS") ?? 35_000);
  },
};

/** A turn that failed for want of a login: Claude Code's error "authentication_failed", or its words for it. */
export const loginFailed = (t: TurnSoFar): boolean => t.kind === "failed" && (t.error === "authentication_failed" || /\bnot logged in\b|please run \/login/i.test(t.text));

/** What's said about it: sent again in `inMs`, or failed (`again`: after being sent again), with the words that didn't go through. */
export type LoginTold = { kind: "retrying"; inMs: number } | { kind: "failed"; again: boolean; prompt: string };

type LoginSteps = {
  /** The session's latest turn so far (its transcript). */
  read(sessionId: string): TurnSoFar | Promise<TurnSoFar>;
  /** The first message the app opened this session with, and when it opened it; null for one it didn't open with one. */
  opened(sessionId: string): { prompt: string; at: number } | null;
  /** Types `prompt` into it again (its terminal's checked path); whether it went in. */
  typeAgain(sessionId: string, prompt: string): Promise<boolean>;
  tell(sessionId: string, what: LoginTold): void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Words compared loosely: a prompt as the hook told it and as the transcript has it. Without
 * Claude Code's paste lines since 2026-11-14 (dictated.ts promptKey): the hook tells a long prompt
 * with them and turnSoFar reads it without, so a long one never matched its own turn.
 */
const same = (a: string, b: string) => promptKey(a).slice(0, 200) === promptKey(b).slice(0, 200);

export class LoginWatch {
  private watching = new Set<string>();
  /** Sessions whose first message was sent again, with the turn that failed: never counted again, whoever asks. */
  private retried = new Map<string, string>();
  private steps: LoginSteps;
  private times: { everyMs: number; forMs: number; readonly retryAfterMs: number };
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(steps: LoginSteps, times = LOGIN_TIMES) {
    this.steps = steps;
    this.times = times;
    this.now = steps.now ?? Date.now;
    this.sleep = steps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  /** The turn `prompt` started, once Claude has answered or an error came; null if neither within `forMs`. */
  private async turnOf(sessionId: string, prompt: string, skip: string): Promise<Exclude<TurnSoFar, { kind: "none" }> | null> {
    const until = this.now() + this.times.forMs;
    for (;;) {
      const turn = await this.steps.read(sessionId);
      if (turn.kind !== "none" && turn.id !== skip && same(turn.prompt, prompt)) return turn;
      if (this.now() >= until) return null;
      await this.sleep(this.times.everyMs);
    }
  }

  /**
   * A session took `prompt` in: its turn read until Claude answers, an error comes, or `forMs`
   * passes. Only the turn that prompt started counts: not the one that failed, when it's sent again
   * with the same words (the app and the session's UserPromptSubmit hook may both ask). Once per
   * session at a time.
   */
  async watch(sessionId: string, prompt: string): Promise<void> {
    if (this.watching.has(sessionId) || !prompt.trim()) return;
    const skip = this.retried.get(sessionId) ?? "";
    this.watching.add(sessionId);
    let turn: Awaited<ReturnType<LoginWatch["turnOf"]>>;
    try {
      turn = await this.turnOf(sessionId, prompt, skip);
    } finally {
      this.watching.delete(sessionId);
    }
    if (turn?.kind !== "failed") return;
    // Another error (overloaded, too long…): Claude Code shows it in its window; logged here.
    if (!loginFailed(turn)) return void log("turn_failed", { sessionId, error: turn.error, text: turn.text });
    const first = this.steps.opened(sessionId);
    const again = this.retried.has(sessionId);
    log("login_failed", { sessionId, error: turn.error, text: turn.text, again, firstMessage: Boolean(first && same(first.prompt, prompt)) });
    // Sent again only once, and only the first message the app opened it with: one you typed or said
    // later may be a real lapse of the login (or a second failure); that's said, and left to you.
    if (again || !first || !same(first.prompt, prompt)) return void (await this.steps.tell(sessionId, { kind: "failed", again, prompt }));
    this.retried.set(sessionId, turn.id);
    const inMs = Math.max(0, first.at + this.times.retryAfterMs - this.now());
    await this.steps.tell(sessionId, { kind: "retrying", inMs });
    await this.sleep(inMs);
    // Something else went in meanwhile (you typed in its window): that's yours, nothing sent again.
    const latest = await this.steps.read(sessionId);
    if (latest.kind === "none" || latest.id !== turn.id) return void log("login_retry", { sessionId, typed: false, why: "another prompt went in meanwhile" });
    const typed = await this.steps.typeAgain(sessionId, first.prompt);
    log("login_retry", { sessionId, typed, waitedMs: inMs });
    // Not typed: the terminal's refusal was said where it was typed.
    if (typed) await this.watch(sessionId, first.prompt);
  }
}
