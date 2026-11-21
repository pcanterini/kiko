// One shared record of the voice conversation across sessions: what each session said (as spoken),
// what you said and where it went, and what the app said. The routing decisions and the spoken
// summaries both read from it, so "never mind" knows what it takes back and summaries don't lean on
// stale transcript prompts.
import { flat } from "./text.ts";

export type Entry = {
  at: number;
  who: "you" | "claude" | "app";
  sessionId: string | null; // the session spoken to or about; null for the app itself
  folder: string | null; // what that session was called then (its name, else its folder; sessions.ts sessionName)
  text: string;
  /** For a session's finished turn the app read out: what the user heard, the app's spoken summary. */
  spoken?: string;
  /** An app entry that said again something already said ("repeat that"): not a new question. */
  repeated?: boolean;
  /** Your words sent to a session: which press of the key they came from (app.ts `turn`). */
  turn?: number;
  /** A session's permission prompt, or your answer to one: neither a finished turn nor words for Claude. */
  permission?: boolean;
  /**
   * Your words for a session that never reached it (nothing could type them in, its pane refused
   * them, its reply couldn't be given): kept, so the conversation shows what you said, but marked
   * so nobody takes them as delivered. "you → Lacy (not sent): …" in the models' lines; never what
   * it was last asked, nor words it has (sentSinceTurn), nor a topic raised with it.
   */
  notSent?: boolean;
  /**
   * Your words that left the send before them standing as what a correction is about: "no, cancel
   * that" (`undo`), which took it back, or a correction the app asked about ("That already went to
   * Kiko project. Which session was it for?": `asked`). Neither went to a session, so "that was for
   * Rowan" next still means that send (latestSend).
   */
  aside?: "undo" | "asked";
  /** Your words for a session that a "never mind" took back (`aside` "undo"): stopped or never read, so a correction has nothing left to stop. */
  undone?: boolean;
  /**
   * Your words the app dealt with itself, sent to no session: a quick check it ran, its own answer, a
   * session it opened. While that's the latest thing it did for you, "send that to Rowan" or "that
   * was for Rowan" means these words (latestSend), never the correction itself.
   */
  handled?: Handled;
};

/** How the app dealt with your words itself (Entry.handled). */
export type Handled = "quick_task" | "answered" | "start";

// Enough for an hour or two of talk: what you asked a session half an hour ago still routes (topics).
const MAX_ENTRIES = 300;

/** A session's ID, or all the IDs it goes by (core/sessions.ts idsOf): entries under any of them are its. */
type Ids = string | readonly string[];
const isFor = (e: Entry, ids: Ids) => e.sessionId !== null && (typeof ids === "string" ? e.sessionId === ids : ids.includes(e.sessionId));

export class Timeline {
  private entries: Entry[] = [];

  add(entry: Omit<Entry, "at">) {
    const added = { ...entry, at: Date.now() };
    this.entries.push(added);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    return added;
  }

  recent(count: number, sessionId?: Ids): Entry[] {
    const matching = sessionId ? this.entries.filter((e) => isFor(e, sessionId)) : this.entries;
    return matching.slice(-count);
  }

  /** The newest entry by `who` about a session; for yours, the newest that reached it (not `notSent`). */
  last(who: Entry["who"], sessionId: Ids): Entry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.who === who && isFor(e, sessionId) && !e.notSent) return e;
    }
    return undefined;
  }

  /**
   * Your words `text` for a session didn't reach it after all: the newest such entry of yours is
   * marked `notSent` (added as they went, before it was known). Said twice, the same one: an older
   * send of the same words that did reach it stays as it is. Returns it; undefined when none is.
   */
  markNotSent(sessionId: Ids, text: string): Entry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.who !== "you" || !isFor(e, sessionId) || e.permission || e.text !== text) continue;
      e.notSent = true;
      return e;
    }
    return undefined;
  }

  /** Your words the app sent a session since its last finished turn, oldest first (not permission answers, nor words that didn't reach it). */
  sentSinceTurn(sessionId: Ids): Entry[] {
    const out: Entry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!isFor(e, sessionId) || e.permission || e.notSent) continue;
      if (e.who === "claude") break;
      if (e.who === "you") out.unshift(e);
    }
    return out;
  }

  /**
   * What you asked a session before, newest first, each cut to its main words with how long ago
   * ("30m ago: investigate required terminals ghosty"): the topics you raised with it, so words
   * that pick one up again later ("what was the finding on all terminals?") find it once the recent
   * conversation has moved on. Leaves out the last `recent` entries (the prompt shows those), its
   * latest ask (its notes' "last asked"), and asks `skip` says are bare ("Sure.").
   */
  topics(sessionId: Ids, { count, recent = 0, skip = () => false, now = Date.now() }: { count: number; recent?: number; skip?: (text: string) => boolean; now?: number }): string[] {
    const latest = this.last("you", sessionId);
    const out: string[] = [];
    for (let i = this.entries.length - 1 - recent; i >= 0 && out.length < count; i--) {
      const e = this.entries[i];
      if (e.who !== "you" || !isFor(e, sessionId) || e === latest || e.notSent || skip(e.text)) continue;
      const line = topicLine(e.text, now - e.at);
      // The same ask again ("run the tests" twice) once, the newest.
      if (line && !out.some((x) => x.split(": ")[1] === line.split(": ")[1])) out.push(line);
    }
    return out;
  }

  /**
   * Your most recent words that went to a session, if within `withinMs`. With `latest`, only when
   * that send is the latest thing the app did for you (see latestSend); or your words the app dealt
   * with itself (Entry.handled, no session), when those are.
   */
  lastSent(withinMs: number, latest = false): Entry | undefined {
    return latestSend(this.entries, withinMs, latest);
  }

  /** The other sessions `sent`'s words went to in the same go (sentWith). */
  sentWith(sent: Entry): Entry[] {
    return sentWith(this.entries, sent);
  }

  /**
   * Plain lines for a model prompt, oldest first, like "you → atlas-agents: run the tests" ("you →
   * atlas-agents (not sent): …" for words that never reached it, so neither the router nor a
   * summary takes them as something it was asked). A turn
   * the app read out is what the user heard ("app said (about atlas-agents): …"); one it didn't is
   * the end of Claude's reply, where its question or outcome usually is. `nameNow` gives a
   * session's name now, so one renamed since goes by the same name as in the session list.
   */
  static lines(entries: Entry[], max = 200, nameNow: (sessionId: string) => string | undefined = () => undefined): string[] {
    return entries.map((e) => {
      const name = (e.sessionId && nameNow(e.sessionId)) || e.folder;
      if (e.who === "you") return `you → ${name ?? "app"}${e.notSent ? " (not sent)" : ""}: ${flat(e.text, max)}`;
      if (e.who === "claude") {
        return e.spoken ? `app said (about ${name}): ${tail(e.spoken, max * 2)}` : `${name} said: ${tail(e.text, max)}`;
      }
      if (e.repeated) return `app repeated${name ? ` (about ${name})` : ""}: ${tail(e.text, max * 2)}`;
      return `app said: ${flat(e.text, max)}`;
    });
  }
}

/**
 * Your most recent words that went to a session (newest entries last), if within `withinMs`. With
 * `latest`, only while that send is the latest thing the app did for you: not once later words of
 * yours went to the app (a question, a repeat, a wrap-up), or another session's turn was read out
 * since. "No, that was for clipkit" corrects the latest thing; an older send isn't what it means.
 * Words that didn't reach it count as that send too (`notSent`): "never mind" then has nothing to
 * stop, and a correction sends them where they belong, with nobody to take them back from.
 * Your words set aside (Entry.aside) don't end it: "No, cancel that." then "That was for Rowan." sends
 * the words cancelled to Rowan (once, "Your last words didn't go to a session").
 * An undo only stands aside for the send it took back (`undone`).
 * With `latest`, your words the app dealt with itself (Entry.handled: a quick check, its answer, a
 * session it opened) count as that send too, with no session: "that was for Rowan" right after a
 * quick check sends what you asked there (2026-11-20: the correction itself was typed in instead).
 */
export function latestSend(entries: Entry[], withinMs: number, latest = false, now = Date.now()): Entry | undefined {
  const announced = new Set<string>();
  let undid = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (now - e.at > withinMs) return undefined;
    if (e.who === "you" && e.sessionId) {
      if (undid && !e.undone) return undefined;
      return latest && [...announced].some((id) => id !== e.sessionId) ? undefined : e;
    }
    if (!latest) continue;
    if (e.who === "you" && e.aside) {
      undid ||= e.aside === "undo";
      continue;
    }
    if (e.who === "you" && e.handled) return undid || announced.size ? undefined : e;
    if (e.who === "you") return undefined;
    if (e.who === "claude" && e.spoken && e.sessionId) announced.add(e.sessionId);
  }
  return undefined;
}

/**
 * The other sessions that got the same words as `sent` in the same go (the router asked several):
 * your entries just before it with the same text, back to your words before them; not those they
 * never reached (`notSent`).
 */
export function sentWith(entries: Entry[], sent: Entry): Entry[] {
  const out: Entry[] = [];
  for (let i = entries.indexOf(sent) - 1; i >= 0; i--) {
    const e = entries[i];
    // Another press's words: the same words sent again later aren't the same go.
    if (sent.at - e.at > 10_000 || (e.who === "you" && (e.text !== sent.text || (e.sessionId && e.turn !== sent.turn)))) break;
    if (e.who === "you" && e.sessionId && !e.notSent && e.sessionId !== sent.sessionId && !out.some((x) => x.sessionId === e.sessionId)) out.push(e);
  }
  return out;
}

/** The end of a message, where a question or the outcome usually is. */
export function tail(text: string, max: number) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

// Words that say little about a topic on their own, left out of topic lines.
const COMMON = new Set(
  (
    "about above actually after again also always another anything around back because been before being better both " +
    "call came cant come could didnt does doesnt doing done dont each else even ever every everything fine first from " +
    "gave give going gonna good great have having here into just keep kind know last least less lets like little look " +
    "made make many maybe mean might more most much must need never next only other over pretty probably please quite " +
    "rather really right same says should since some something sorry still stuff such sure take tell than thank thanks " +
    "that thats their them then there these they thing things think this those though thought through today told " +
    "very want wanted wants well were what whats when where whether which while will with without wonder wondering " +
    "work would yeah your youre okay cool hmm umm"
  ).split(" "),
);

/**
 * An earlier ask as a topic line: how long ago, and its main words, the longest few kept in the
 * order said ("30m ago: investigate required terminals ghosty"); null when one word or none is left.
 */
export function topicLine(text: string, agoMs: number, max = 5): string | null {
  const words = topicWords(text);
  // One word ("commit", "suggestions") is a reply more than a topic.
  if (words.length < 2) return null;
  const kept = new Set([...words].sort((a, b) => b.length - a.length).slice(0, max));
  return `${agoShort(agoMs)}: ${words.filter((w) => kept.has(w)).join(" ")}`;
}

/** The words of a request that say what it's about, each once, in the order said. */
export function topicWords(text: string): string[] {
  const seen = new Set<string>();
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => {
      const stem = w.replace(/s$/, "");
      if (w.length < 4 || COMMON.has(w) || COMMON.has(stem) || seen.has(stem)) return false;
      seen.add(stem);
      return true;
    });
}

/** "just now", "4m ago", "2h ago". */
function agoShort(ms: number) {
  const min = Math.round(ms / 60_000);
  return min < 1 ? "just now" : min < 90 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
}
