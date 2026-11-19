// A session's name heard as other words: speech-to-text wrote "Too rowing, do we have anything …"
// for "To Rowan, do we have anything …", and no name in code matched, so
// the router guessed from the topic and sent it to another session. Here the words are held against
// the sessions' names by how they sound, not how they're spelled: a soft "c" as "s", "ph" as "f",
// double letters as one, every run of vowels as one vowel ("Rowen" and "Rowan" both "raw·an"), and as
// many syllables. Only a close match with a clear margin over every other session counts.
//
// It's a guess, never a name said: decide.ts gives it to the router as a strong hint
// (<name_heard_as>), and the send there is said and held a moment ("To Rowan."), never typed in unseen.
import type { Session } from "./sessions.ts";
import { callNames } from "./sessions.ts";
import { distance, tokens, type Token } from "./words.ts";

/** A session's name heard as other words: `heard`, those words; `said`, all of what opened your words up to the pause after them; `rest`, what follows. */
export type HeardAs = { session: Session; heard: string; said: string; rest: string };

/**
 * A word as it sounds, for telling names heard wrong: letters only; "ph" as "f", "ck", "q" and a
 * hard "c" as "k", a soft "c", "z" as "s", "x" as "ks", a silent "e" at the end dropped, "y" after
 * the first letter a vowel, every run of vowels as one "a", and double letters as one. "Rowan",
 * "Rowen" and "Rowann" are all "rawan", "Lacy" and "Lasey" both "lasa"; "rowing" is "rawang".
 */
export function soundKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length > 3) w = w.replace(/([^aeiouy])e$/, "$1");
  w = w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/^kn/, "n")
    .replace(/^wr/, "r")
    .replace(/wh/g, "w");
  w = w.charAt(0) + w.slice(1).replace(/y/g, "i");
  return w.replace(/[aeiou]+/g, "a").replace(/(.)\1+/g, "$1");
}

/** How many syllables a sound key has: its vowels ("tasa" 2, "tast" 1). */
const syllables = (key: string) => key.replace(/[^a]/g, "").length || 1;

/**
 * How far words said are from a name, by sound (soundKey, distance), or null when they aren't close:
 * the same first sound, as many syllables, and at most one sound off for a short name (four to six
 * of soundKey's letters), two for a longer one, none for a shorter one.
 */
export function soundDistance(said: string, name: string): number | null {
  const a = soundKey(said);
  const b = soundKey(name);
  if (a.length < 3 || b.length < 3 || a[0] !== b[0] || syllables(a) !== syllables(b)) return null;
  const d = distance(a, b);
  const most = b.length <= 3 ? 0 : b.length <= 6 ? 1 : 2;
  return d <= most ? d : null;
}

// Words that are never part of a name heard wrong: the words around one ("to", "tell", "the"), and
// those a sentence is made of.
const NOT_NAME = new Set(
  (
    "to too two tell ask for the a an and or but so that thats this these those it its is was were be been are am not no nope yes yeah " +
    "okay ok of in on at with from by about me you we us i im my your our them they he she his her then just also please hey hi hello " +
    "um uh umm uhm er erm ah oh hmm now well actually what which who how why when where do does did can could would should will"
  ).split(" "),
);
// Everyday words said after "too" or "to" with a pause ("Too busy, I'll look later", "To be
// honest, …", "To recap, …"): never a name heard wrong, whatever they sound like ("busy" is close to
// Bobby). A session called one of them is found by its name before this is asked.
const EVERYDAY = new Set(
  (
    "bad busy late early soon much many long hard easy true fast slow big small high low close far good well sure bright dark " +
    "hot cold loud quiet risky tricky messy simple complex complicated confusing tired expensive cheap weird broken " +
    "start begin do be clarify recap summarize sum confirm answer test check fix explain continue finish wrap say note add"
  ).split(" "),
);
// Before the name up front: sounds and greetings ("Okay, too rowing, …").
const OPENERS = new Set("hey hi hello ok okay oh um umm uh uhm so well".split(" "));
// "To", "too", "two" (speech-to-text's spellings of "to"), "tell", "ask", "for" before it.
const LEADS = new Set(["to", "too", "two", "tell", "ask", "for"]);
// The pause after the name, as speech-to-text writes one.
const PAUSE = /^\s*[,:;.!?…—–]+\s*/;
// Before a name, words that say it's the wrong one: "not to Kiko", "never Bobby".
const NEGATES = new Set(["not", "never", "no"]);

// Greetings that say a name follows ("Hey Bobbie, …"), as a lead does.
const GREETINGS = new Set(["hey", "hi", "hello", "yo"]);

/** Words `from..to` (token indexes) sound like `session`'s name, `d` sounds off; `restAt`, where what's after them starts. */
type Match = { session: Session; d: number; from: number; to: number; restAt?: number };

/** The session words `t[from..to)` sound like (soundDistance against each of its names), at its best; null for none. */
function closest(sessions: Session[], t: Token[], from: number, to: number): Match[] {
  if (to - from === 1 && EVERYDAY.has(t[from].word)) return [];
  const said = t
    .slice(from, to)
    .map((x) => x.word)
    .join("");
  const out: Match[] = [];
  for (const session of sessions) {
    let best: number | null = null;
    for (const name of callNames(session)) {
      const d = soundDistance(said, name);
      if (d !== null && (best === null || d < best)) best = d;
    }
    if (best !== null) out.push({ session, d: best, from, to });
  }
  return out;
}

/**
 * The one session the matches point to, with a clear margin: the closest, and no other session as
 * close. The longest words for it when several fit ("mint bots" over "mint").
 */
function clearBest(matches: Match[]): Match | null {
  if (!matches.length) return null;
  const least = Math.min(...matches.map((m) => m.d));
  const at = matches.filter((m) => m.d === least);
  if (new Set(at.map((m) => m.session)).size > 1) return null;
  // Another session only one sound further off is no clear margin either.
  if (matches.some((m) => m.session !== at[0].session && m.d <= least)) return null;
  return at.sort((a, b) => b.to - b.from - (a.to - a.from))[0];
}

/**
 * The session your words open by calling it a name heard as other words: one to three words up
 * front, after sounds ("okay", "um") and "to", "too", "two", "tell", "ask" or "for", with a pause
 * after them ("Too rowing, do we have …", "Two Rowen: run the tests") or, after "tell" and "ask",
 * "to" or "that" ("Tell rowing to check the build"). "For" only with a colon. A pause is needed:
 * "two rowing machines broke", "to test this", "two tests failed" call nobody; and a lead, or a greeting
 * ("Hey Bobbie, …"): "Rowing, but too slow." opens with a word, not a name. Null when no session
 * is close (soundDistance) with a clear margin, or nothing comes after.
 */
export function nameHeardAs(sessions: Session[], text: string): HeardAs | null {
  const t = tokens(text);
  let i = 0;
  let greeted = false;
  while (i < t.length && OPENERS.has(t[i].word)) greeted ||= GREETINGS.has(t[i++].word);
  const lead = i < t.length && LEADS.has(t[i].word) ? t[i].word : null;
  if (lead) i++;
  if (!lead && !greeted) return null;
  while (i < t.length && (t[i].word === "uh" || t[i].word === "um")) i++;
  if (i < t.length && t[i].word === "the") i++;
  const matches: Match[] = [];
  for (let k = 1; k <= 3 && i + k <= t.length; k++) {
    const words = t.slice(i, i + k);
    if (words.some((x) => NOT_NAME.has(x.word))) break;
    const after = text.slice(words[k - 1].end);
    const pause = PAUSE.exec(after);
    const told = (lead === "tell" || lead === "ask") && /^\s*,?\s*(?:to|that)\s+/i.exec(after);
    if (lead === "for" && !pause?.[0].includes(":")) continue;
    const gap = pause ?? (told || null);
    if (!gap) continue;
    const restAt = words[k - 1].end + gap[0].length;
    // Something of its own after it: two words or more.
    if (tokens(text.slice(restAt)).length < 2) continue;
    for (const m of closest(sessions, t, i, i + k)) matches.push({ ...m, restAt });
  }
  const best = clearBest(matches);
  if (!best?.restAt) return null;
  const rest = text.slice(best.restAt).trim();
  return {
    session: best.session,
    heard: text.slice(t[best.from].start, t[best.to - 1].end),
    said: text.slice(0, best.restAt).trim(),
    rest: rest.charAt(0).toUpperCase() + rest.slice(1),
  };
}

/**
 * The one session words anywhere in them sound like (soundDistance, with a clear margin), for a
 * correction of where your last words went ("That was too rowing, not to Kiko."): never words right
 * after "not", "never" or "no" ("not to Kiko" names the wrong one), nor `except` (where they went).
 * The words heard as it; null when none is.
 */
export function soundsLikeIn(sessions: Session[], text: string, except: ReadonlySet<string> = new Set()): { session: Session; heard: string } | null {
  const t = tokens(text);
  const candidates = sessions.filter((x) => !except.has(x.sessionId));
  const matches: Match[] = [];
  for (let i = 0; i < t.length; i++) {
    if (NOT_NAME.has(t[i].word)) continue;
    // "not to Kiko", "not the Kiko one": a negation up to two words before.
    const before = t.slice(Math.max(0, i - 3), i).map((x) => x.word);
    if (before.some((w) => NEGATES.has(w)) && before.slice(before.findLastIndex((w) => NEGATES.has(w)) + 1).every((w) => NOT_NAME.has(w))) continue;
    for (let k = 1; k <= 3 && i + k <= t.length; k++) {
      if (NOT_NAME.has(t[i + k - 1].word)) break;
      matches.push(...closest(candidates, t, i, i + k));
    }
  }
  const best = clearBest(matches);
  return best ? { session: best.session, heard: text.slice(t[best.from].start, t[best.to - 1].end) } : null;
}
