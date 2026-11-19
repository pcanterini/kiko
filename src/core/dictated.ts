// Your dictated words that the app typed into a session's terminal, remembered for a moment: until
// the session takes them in as a prompt. Since 2026-11-14 its hook asks then (UserPromptSubmit:
// hooks/claude-code-hook.mjs, hooks/codex-hook.mjs) whether the prompt is one of these, and one that
// is gets a line of hook context beside it saying it was dictated (hooks/lib.mjs VOICE_PROMPT), as a
// reply given through a held Stop hook has always said. Typed words used to arrive with nothing, so
// the agent read "high term" as written, not as iTerm misheard.
//
// A prompt you typed by hand must never get that line, so the match is narrow: the same session,
// the same text (but for whitespace, which a terminal changes), within DICTATED_WITHIN_MS of the
// typing (DICTATED_QUEUED_MS for words a session can't take in yet), and each typed message counts
// once. A second prompt with the same words, typed by hand right after, isn't one.
import { flat } from "./text.ts";

/**
 * How long after it's typed a message can still be taken for the prompt a session takes in. A
 * session takes typed words in within a second (the logs of 2026-11: 635 ms at most over 160 of
 * them); a minute leaves room for a busy Mac, and is short enough that the same words typed by hand
 * later are yours.
 */
export const DICTATED_WITHIN_MS = 60_000;

/**
 * How long words given to a session that can't take them in yet are waited for. One busy with a
 * turn queues them, and Claude Code takes the ones still queued at the turn's end in as a prompt of
 * their own (its UserPromptSubmit comes then, as for any prompt): two minutes after the typing at
 * the median in the transcripts of 2026-11, often far longer. One still starting takes its first
 * message (on its command line) once it has started, after its trust question, however long that
 * waits. As long as the phone waits for typed words to start (remote/talk-status.ts STARTED_WITHIN_MS).
 */
export const DICTATED_QUEUED_MS = 30 * 60_000;

// Claude Code puts a long paste (over 800 characters, or three lines) between two lines of its own
// when it hands the prompt on: `<pasted_content id="7169">` and `</pasted_content id="7169">`. The
// app's typing arrives as a paste, so its longer messages come back wrapped (seen in the logs: 58
// characters more than was typed). Read from real transcripts on 2026-11-14 (211 pastes): each tag
// is always a line of its own, the closing one carries the id too, the id is letters as well as
// digits ("ec41"), and Claude Code leaves blank lines around the pair ("words\n\n\n<pasted_content
// …>\n" before, "\n</pasted_content …>\n\n\nwords" after; "\n\n" before one that starts the prompt).
const PASTE_LINES = /(?:\n*^<\/?pasted_content id="[^"\n]*">$\n*)+/gm;

/**
 * A prompt without Claude Code's paste lines: what was pasted stays where it was, a paragraph of
 * its own between your words before and after it (the blank lines Claude Code put around its two
 * lines become one). What a transcript's reader shows as your words (core/history.ts yourWords), and
 * what a prompt is compared by below.
 */
export const unpasted = (text: string) => text.replace(PASTE_LINES, "\n\n").trim();

/**
 * A prompt as it's compared: without Claude Code's paste lines, the control characters a terminal
 * drops (src/terminals/tmux literal), and with every run of whitespace one space (a line break typed
 * into a terminal that takes no paste is a space; a tab too).
 */
export function promptKey(text: string) {
  return flat(unpasted(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""));
}

/** The dictated words typed into each session lately, and whether a prompt it took in is one of them. */
export class Dictated {
  private typed = new Map<string, Array<{ key: string; until: number }>>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Words you dictated, about to be typed into this session, or given as its first message as it
   * opens (noted under its starting ID). Waited for `withinMs`: DICTATED_QUEUED_MS for a session
   * that can't take them in yet.
   */
  note(sessionId: string, text: string, withinMs = DICTATED_WITHIN_MS) {
    const key = promptKey(text);
    if (!key) return;
    this.typed.set(sessionId, [...this.recent(sessionId), { key, until: this.now() + withinMs }]);
  }

  /** They didn't go in after all (its pane had closed): not waited for, so the same words typed by hand next aren't taken for them. */
  drop(sessionId: string, text: string) {
    const recent = this.recent(sessionId);
    const i = recent.findLastIndex((t) => t.key === promptKey(text));
    if (i < 0) return;
    recent.splice(i, 1);
    this.keep(sessionId, recent);
  }

  /**
   * Whether `prompt`, which a session just took in, is words noted for it lately (`sessionIds`:
   * every ID the session goes by): each counts once. Several typed while it was busy can come in as
   * one prompt, a line each: that's one only when all of it is them, in the order they were typed.
   */
  take(sessionIds: readonly string[], prompt: string): boolean {
    const key = promptKey(prompt);
    if (!key) return false;
    for (const id of sessionIds) {
      const recent = this.recent(id);
      const one = recent.findIndex((t) => t.key === key);
      const used = one >= 0 ? [one] : several(recent, key);
      this.keep(
        id,
        recent.filter((_, i) => !used.includes(i)),
      );
      if (used.length) return true;
    }
    return false;
  }

  /**
   * A session finished a turn: words noted for it that reached it during the turn (`said`, from its
   * own record, read only when some are noted) are let go. Claude Code takes words typed while it's
   * busy in as the turn goes, between two steps, and no UserPromptSubmit comes for those (the
   * transcripts and logs of 2026-11: 240 of 270 taken in that way had none), so nothing else uses
   * them up, and the same words typed by hand later would be taken for the app's.
   */
  reached(sessionIds: readonly string[], said: () => readonly string[] | null) {
    const noted = sessionIds.filter((id) => this.recent(id).length);
    if (!noted.length) return;
    const keys = new Set((said() ?? []).map(promptKey));
    for (const id of noted)
      this.keep(
        id,
        this.recent(id).filter((t) => !keys.has(t.key)),
      );
  }

  /** What was typed into a session and is still in time. */
  private recent(sessionId: string) {
    const now = this.now();
    return (this.typed.get(sessionId) ?? []).filter((t) => t.until > now);
  }

  private keep(sessionId: string, recent: Array<{ key: string; until: number }>) {
    if (recent.length) this.typed.set(sessionId, recent);
    else this.typed.delete(sessionId);
  }
}

/** The typed messages that, one after another in the order typed, make up the whole prompt: their places, none when it isn't all them. */
function several(recent: ReadonlyArray<{ key: string }>, prompt: string): number[] {
  const used: number[] = [];
  let rest = prompt;
  for (const [i, t] of recent.entries()) {
    if (rest === t.key) return [...used, i];
    if (!rest.startsWith(`${t.key} `)) continue;
    used.push(i);
    rest = rest.slice(t.key.length + 1);
  }
  return [];
}
