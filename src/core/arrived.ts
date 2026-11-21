// Whether words the app typed into a session arrived whole: the one check every terminal adapter's
// typing gets, whichever it was (tmux, Rex, iTerm, Terminal, Ghostty), since what a program does
// with what it reads is out of any adapter's hands. On 2026-11-21 a 1158-character dictation typed
// into Claude Code in Rex came in as its last 136 characters: Rex had written all of it, the
// terminal handed it over in two reads, and that Claude Code kept only the second
// (src/terminals/paste.ts, which now pastes long words). Nothing said so: the app had "sent" it.
//
// So: what the app types into a session is remembered for a while (app/announce.ts noteTyped, the
// one place every typing passes), and when the session takes a prompt in (its agent's
// UserPromptSubmit, Agent.onPromptSubmitted) the prompt is compared with it. A prompt that is the
// start or the end of long words just typed there, and shorter, is them cut short: logged
// (typed_short) and said, with "try again" to send them whole (app/session-ops.ts cutShort).
// Compared as the dictated note is (core/dictated.ts promptKey): Claude Code's paste lines and the
// whitespace a terminal changes don't count.
import { DICTATED_QUEUED_MS, promptKey } from "./dictated.ts";

/**
 * Only words this long are watched: the shortest cut seen kept 136 of 1158, and nothing shorter
 * than a terminal's read (1022 bytes) is ever split; a few hundred leaves room for a cut elsewhere.
 */
export const WATCHED_CHARS = 300;

/** How long typed words are waited for: as long as dictated words a busy session queues (core/dictated.ts). */
export const ARRIVED_WITHIN_MS = DICTATED_QUEUED_MS;

/** Words that reached a session cut short: what was typed, and how many characters of it came in. */
export type Short = { text: string; typed: number; got: number; at: "start" | "end" };

type Typed = { text: string; key: string; until: number };

/** Long words typed into each session lately, and whether a prompt it took in is one of them cut short. */
export class Arrivals {
  private typed = new Map<string, Typed[]>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Words the app is about to type into this session (short ones aren't watched). */
  typing(sessionId: string, text: string, withinMs = ARRIVED_WITHIN_MS) {
    const key = promptKey(text);
    if (key.length < WATCHED_CHARS) return;
    this.typed.set(sessionId, [...this.recent(sessionId), { text, key, until: this.now() + withinMs }]);
  }

  /**
   * A session (`sessionIds`: every ID it goes by) took `prompt` in. Words typed there that it is
   * whole are done with (null); words it is the start or the end of, shorter, came in cut short:
   * those, done with too. Anything else isn't about them (null): another prompt, or several typed
   * while it was busy coming in as one.
   */
  took(sessionIds: readonly string[], prompt: string): Short | null {
    const got = promptKey(prompt);
    if (!got) return null;
    for (const id of sessionIds) {
      const recent = this.recent(id);
      const whole = recent.findIndex((t) => t.key === got);
      if (whole >= 0) {
        this.keep(
          id,
          recent.filter((_, i) => i !== whole),
        );
        return null;
      }
      const cut = recent.findLastIndex((t) => got.length < t.key.length && (t.key.endsWith(got) || t.key.startsWith(got)));
      if (cut >= 0) {
        const t = recent[cut];
        this.keep(
          id,
          recent.filter((_, i) => i !== cut),
        );
        return { text: t.text, typed: t.key.length, got: got.length, at: t.key.endsWith(got) ? "end" : "start" };
      }
    }
    return null;
  }

  /** What was typed into a session and is still in time. */
  private recent(sessionId: string) {
    const now = this.now();
    return (this.typed.get(sessionId) ?? []).filter((t) => t.until > now);
  }

  private keep(sessionId: string, recent: Typed[]) {
    if (recent.length) this.typed.set(sessionId, recent);
    else this.typed.delete(sessionId);
  }
}
