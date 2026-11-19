/**
 * What the Mac's output didn't play. AirPods that are the Mac's output while they're with the phone
 * take no sound: the player gives up after a few seconds (speaker.ts onStalled), the app goes on, and
 * what was being said is cut (audio-queue.ts stalled(): each speech by what it was, a `Said`). A
 * session's reply is never swallowed (the rule: every reply is heard, in order, unless you skip it),
 * so here it isn't lost either:
 *
 * - The screen says what wasn't heard, where, and how to hear it (notice()): "Couldn't play on
 *   AirPods, so Lacy's reply wasn't heard. Say 'repeat that' to hear it." It stays what "repeat
 *   that" (and "repeat Lacy") says: the app keeps it as said, since it was.
 * - Once sound comes out again (the player's "back": the output moving again, or later sound
 *   played), what's owed is said again by itself, in order (back()). Once each: one that doesn't play
 *   then either is left to "repeat that", so an output that only looks back can't make a loop. Not
 *   one you've had repeated meanwhile (repeated()), nor one older than MAX_AGE_MS, which would come
 *   out of nowhere, nor a permission question (its prompt has moved on).
 */
import { type Clock, realClock } from "./clock.ts";
import { andList } from "./text.ts";

/**
 * What a speech was: a session's reply, its permission question, or the app's own line. `text`: filled in once known.
 * `replyId`: a reply's id, as the log names it (summary-feedback.ts replyIdOf).
 */
export type Said = { sessionId: string | null; name: string | null; kind: "reply" | "question" | "line"; text: string; replyId?: string };

// Past this, what wasn't heard isn't said again by itself when sound is back: still "repeat that".
export const MAX_AGE_MS = 10 * 60_000;

/** What it was, as the notice says it: "Lacy's reply", "what I said". */
function what(s: Said) {
  if (s.kind === "line" || !s.name) return "what I said";
  return `${s.name}'s ${s.kind === "question" ? "question" : "reply"}`;
}

/**
 * The one line the screen shows for a stall: where it couldn't play (`device`: the output's name;
 * null or "" when not known), what wasn't heard (`cut`, oldest first; none known: what was being
 * said), and how to hear it.
 */
export function notice(device: string | null, cut: Said[]): string {
  const where = device ? `Couldn't play on ${device}` : "Couldn't play the sound";
  const things = [...new Set(cut.map(what))];
  if (!things.length) return `${where}, so what I was saying wasn't heard.`;
  const one = things.length === 1;
  const sessions = [...new Set(cut.filter((s) => s.kind !== "line" && s.name).map((s) => s.name))];
  const how = one ? `Say 'repeat that' to hear it.` : sessions.length ? `Say 'repeat' and a session's name to hear one.` : `Say 'repeat that' to hear the last.`;
  return `${where}, so ${andList(things)} ${one ? "wasn't" : "weren't"} heard. ${how}`;
}

export class Unplayed {
  private owed: Array<{ said: Said; at: number }> = [];
  // Said again by itself once already: not again.
  private resaid = new WeakSet<Said>();
  private clock: Pick<Clock, "now">;

  constructor(clock: Pick<Clock, "now"> = realClock) {
    this.clock = clock;
  }

  /** The output gave up on these (oldest first): owed, and the line to show. */
  stalled(device: string | null, cut: Said[]): string {
    const at = this.clock.now();
    for (const said of cut) if (!this.owed.some((o) => o.said === said)) this.owed.push({ said, at });
    return notice(device, cut);
  }

  /**
   * Sound is back: what to say again now, oldest first. Each only once, only with its words known,
   * and not past MAX_AGE_MS; the rest are let go (still "repeat that"). Not a permission question:
   * asked again out of the blue, a "yes" after it would answer nothing (its prompt has been asked in
   * the terminal by then, or is still the one waiting, which "repeat that" asks again).
   */
  back(): Said[] {
    const now = this.clock.now();
    const owed = this.owed.splice(0);
    const again = owed.filter((o) => o.said.kind !== "question" && o.said.text.trim() && !this.resaid.has(o.said) && now - o.at <= MAX_AGE_MS).map((o) => o.said);
    for (const said of again) this.resaid.add(said);
    return again;
  }

  /** You had it said again ("repeat that"): not owed any more. */
  repeated(text: string) {
    const t = text.trim();
    this.owed = this.owed.filter((o) => o.said.text.trim() !== t);
  }

  /** How many are owed. */
  get size() {
    return this.owed.length;
  }
}
