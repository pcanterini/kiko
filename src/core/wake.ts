// The app's name as the way to talk to it, like "Hey Siri". Said at the very start of what you say
// ("Kiko, ask Lacy if it deployed", "Kiko: what's everyone doing?", "To Kiko, …", "Tell
// Kiko …"), it only says who you're talking to: it's taken off, and the rest goes where any
// words would (decide.ts, first thing). After a direction ("To Kiko, …", "Tell Kiko to …":
// directedAtName), it's a session's name when one is named like the app ("Kiko project"). A real word speech-to-text writes for the name (name.ts
// misheard atStart) counts only there, opening what you said; never mid-sentence. Anywhere else ("tell the Kiko session to fix the bug", "in the Kiko project, …", "the
// Kiko app's settings screen is broken"), or up front as what the sentence is about ("Kiko's
// status bar is wrong", "Kiko session, run the tests"), it stays: work for the session on the
// app's own code, as before.
//
// Hands-free (hands-free.ts), the same name is the wake word: Listener below hears it at the start
// of a phrase, takes what follows until the quiet after it, and hands that on as push-to-talk words.
//
// The name is the one you call it (name.ts spokenName, the spokenName setting: Kiko unless you
// pick another), read at each use, so a new one works at once. "Kiku" and "Chiko" are Kiko's
// (name.ts misheard); a name of your own has no such spellings.
import { type Clock, realClock } from "./clock.ts";
import { misheard, spokenName } from "./name.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Kiko", "Kiku", "Chiko": speech-to-text's spellings of the name, with or without the
// dictionary's fix, words apart or run together.
const asForm = (f: string) => f.toLowerCase().split(/\s+/).map(escape).join("[\\s-]*");
// "Hey", "okay", "um" before the name: still at the start.
const OPENER = "(?:(?:hey|hi|ok(?:ay)?|oh|um+|uh+|so)[\\s,.!]+)*";
// "To Kiko, …" ("two" as speech-to-text writes it), "To, uh, Kiko, …", "Tell Kiko …": said to the app.
const TO = "(?:(?<tell>tell)|to|two)(?:[\\s,]+(?:uh+|um+|er+))*[\\s,]+";

/**
 * The spoken name (name.ts spokenName, a setting) and the spellings speech-to-text gives it
 * (name.ts misheard), as one pattern with no groups. Not the real words it's written as (atStart).
 */
export const nameForms = (name = spokenName()) => [...new Set([name, ...misheard(name).heard].map((f) => f.toLowerCase()))].map(asForm).join("|");

// The pattern for the name up front, made again when the spoken name changes: "Jarvis, …" works
// the moment the setting says Jarvis, and "Kiko, …" stops.
let lead: { name: string; re: RegExp } | null = null;
function leadPattern(): RegExp {
  const name = spokenName();
  if (lead?.name === name) return lead.re;
  // Real words speech-to-text writes for the name (atStart): only when they open what you said.
  const atStart = misheard(name).atStart.map(asForm);
  const word = atStart.length ? `|(?<word>${atStart.join("|")})` : "";
  const re = new RegExp(`^[\\s"'“‘]*${OPENER}(?:${TO})?(?:(?<name>${nameForms(name)})${word})(?![\\p{L}\\p{N}])`, "iu");
  lead = { name, re };
  return re;
}

const SYLLABLES = /[aeiouy]+/g;
/** Roughly how many syllables a word has, by its vowel groups ("Kiko" 2, "Max" 1, "Jarvis" 2). */
function syllables(word: string) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  let n = w.match(SYLLABLES)?.length ?? 1;
  // A silent e at the end ("Mike", "Dave"), but not "-le" ("Pebble").
  if (n > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) n--;
  return Math.max(1, n);
}

// Words said every day, which would wake it mid-conversation, whatever their length.
const COMMON = new Set(
  (
    "hey hi hello okay alright yes yeah no nope stop go wait help please thanks sorry right really maybe actually basically " +
    "listen look today tomorrow later never always other about after again also another something nothing everything " +
    "someone anyone people thing money water coffee music computer phone honey baby buddy daddy mommy mother father " +
    "sister brother morning evening pretty little very over under every any many only even ever open close start " +
    "finish session cancel repeat answer question problem number working coding claude code cloud assistant system " +
    "button window terminal project program folder river table paper letter happy funny sunny"
  ).split(" "),
);

/**
 * Whether a spoken name is likely to wake it by accident: one syllable, or a word said every day.
 * The words to say so (a warning: any name can be set), or null when it's fine.
 */
export function nameWarning(name: string): string | null {
  const words = name
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!words.length) return null;
  const short = words.reduce((n, w) => n + syllables(w), 0) < 2;
  const common = words.length === 1 && COMMON.has(words[0].replace(/[’']/g, ""));
  return short || common ? "Short, common words wake it by accident; two syllables work best." : null;
}

// After the name with no comma, a word that makes it what the sentence is about rather than who
// it's said to: "Kiko session …", "Kiko app …", "Kiko is broken", "Kiko and Lacy …".
const ABOUT_IT = new Set(
  (
    "session sessions project projects app apps application repo repository folder directory code codebase one ones " +
    "instance terminal window agent claude build tests screen ui tui settings status statusline readme docs bug bugs " +
    "issue issues hook hooks helper helpers version release logs log menu side " +
    "is isn't isnt was wasn't has hasn't had does doesn't did didn't should shouldn't would wouldn't could couldn't " +
    "can can't cant cannot will won't needs keeps still seems crashed crashes crashing broke breaks failed fails failing " +
    "and or vs versus"
  ).split(" "),
);
// "Kiko, can you …" said without the comma: "can you" is a question to it.
const ASKS_YOU = /^(?:can|could|would|will|should|did|does|do|is|are|have|has)\s+you\b/i;

export type Lead = {
  /** The name up front, said to the app: `rest` is what's left once it's taken off. */
  addressed: boolean;
  /** The words without the name (and its comma or colon), or as said when it wasn't addressed. Empty when it was only the name. */
  rest: string;
};

/**
 * Whether what you said starts with the app's name said to it, and what's left without it. "Kiko,
 * Kiko, …" loses both. A name that's what the sentence is about ("Kiko's settings screen",
 * "Kiko session, fix it") isn't taken off. `opens`: `text` is the start of what you said, where a
 * real word written for the name (atStart) may be the name too (false for a later sentence, hands-free).
 */
export function leadingName(text: string, opens = true): Lead {
  let rest = text;
  let addressed = false;
  for (let i = 0; i < 3; i++) {
    const next = afterName(rest, opens);
    if (next === null) break;
    addressed = true;
    rest = next;
    if (!rest) break;
  }
  if (!addressed) return { addressed: false, rest: text };
  return { addressed: true, rest: rest && rest[0].toUpperCase() + rest.slice(1) };
}

/** The words after the app's name said up front; null when it isn't. */
function afterName(text: string, opens: boolean): string | null {
  const m = leadPattern().exec(text);
  if (!m) return null;
  const tell = m.groups?.tell !== undefined;
  // A real word written for the name is the name only opening what you said, and only with a pause
  // after it ("<word>, …", "To <word>. …") or after "tell": followed straight by more words, it's the word.
  if (m.groups?.word !== undefined && !opens) return null;
  const after = text.slice(m[0].length);
  // "Kiko's settings": what the sentence is about. "Kiko-related": one word.
  if (/^['’]s(?![\p{L}\p{N}])/iu.test(after) || /^-\p{L}/u.test(after)) return null;
  // "Tell Kiko to check the logs", "tell Kiko that …": what's said to it.
  const told = (words: string) => (tell ? words.replace(/^(?:to|that)\s+/i, "") : words);
  const sep = /^[\s"'”’]*[,:;.!?…—–-]+/.exec(after);
  if (sep) return told(trimLead(after.slice(sep[0].length)));
  const words = trimLead(after);
  if (!words) return "";
  if (m.groups?.word !== undefined && !tell) return null;
  const first = words
    .split(/\s+/)[0]
    .toLowerCase()
    .replace(/[^\p{L}'’]/gu, "")
    .replace(/’/g, "'");
  if (ABOUT_IT.has(first) && !ASKS_YOU.test(words)) return null;
  return told(words);
}

const trimLead = (s: string) => s.replace(/^[\s,:;.!?…—–"'”’-]+/, "").trim();

/**
 * What `leadingName` took off the front of `text` ("To, uh, Kiko.", "Tell Kiko to"), for the log:
 * the direction before the name goes with it, and never unseen. Empty when nothing was.
 */
export function nameTakenOff(text: string, lead: Lead): string {
  if (!lead.addressed) return "";
  const said = text.trim();
  if (!lead.rest) return said;
  const at = said.length - lead.rest.length;
  return at >= 0 && said.slice(at).toLowerCase() === lead.rest.toLowerCase() ? said.slice(0, at).trim() : "";
}

// A direction to the name up front: "To Kiko, …", "To, uh, Kiko. …", "For Kiko: …", "Tell Kiko to
// …", "Ask Kiko to …", "Send this to Kiko: …", "This is for Kiko. …". `tell`: "tell" or "ask", where
// "to" or "that" after the name goes with it.
const DIRECTION =
  "(?:(?:(?:can|could|would)\\s+you\\s+|please\\s+|go\\s+ahead\\s+and\\s+)?(?<tell>tell|ask)" +
  "|(?:send|pass|forward|give)\\s+(?:this|that|it)(?:\\s+on)?\\s+to" +
  "|(?:this|that|it)(?:\\s+(?:one|message|question|part))?(?:\\s+is|['’]s)\\s+for" +
  "|(?:a\\s+)?(?:question|message|note|request)\\s+for" +
  "|to|two|for)(?:[\\s,]+(?:uh+|um+|er+))*[\\s,]+(?:(?:the|a|an)\\s+)?";
let directed: { name: string; re: RegExp } | null = null;
function directedPattern(): RegExp {
  const name = spokenName();
  if (directed?.name === name) return directed.re;
  const re = new RegExp(`^[\\s"'“‘]*${OPENER}${DIRECTION}(?:${nameForms(name)})(?![\\p{L}\\p{N}])`, "iu");
  directed = { name, re };
  return re;
}

/**
 * The app's name up front after a direction to it ("To, uh, Kiko. …", "Tell Kiko to run the
 * tests", "This is for Kiko: …"): `said`, the direction and the name, and `rest`, the words after
 * them. Null when there's none, or nothing after it. A direction names who the words are for, so
 * with a session named like the app ("Kiko project", the kiko folder), decide.ts sends them there:
 * the name there is that session's, not the wake (once, "To, uh, Kiko. …" about the app's own
 * phone screens went to the session dealt with last). Without one, `leadingName` still
 * takes it as said to the app. Not what the sentence is about ("Tell Kiko's session …", "To Kiko
 * project, …": that's the session's own name), nor "ask Kiko" with no "to" or pause after it.
 */
export function directedAtName(text: string): { said: string; rest: string } | null {
  const m = directedPattern().exec(text);
  if (!m) return null;
  const tell = m.groups?.tell;
  const after = text.slice(m[0].length);
  if (/^['’]s(?![\p{L}\p{N}])/iu.test(after) || /^-\p{L}/u.test(after)) return null;
  let start: number;
  const sep = /^[\s"'”’]*[,:;.!?…—–-]+/.exec(after);
  const to = tell ? /^\s*,?\s*(?:to|that)\s+/i.exec(sep ? after.slice(sep[0].length) : after) : null;
  if (sep) start = sep[0].length + (to ? to[0].length : 0);
  else if (to) start = to[0].length;
  else {
    if (tell?.toLowerCase() === "ask") return null;
    const first = trimLead(after)
      .split(/\s+/)[0]
      .toLowerCase()
      .replace(/[^\p{L}'’]/gu, "")
      .replace(/’/g, "'");
    if (!first || (ABOUT_IT.has(first) && !ASKS_YOU.test(trimLead(after)))) return null;
    start = 0;
  }
  const tail = after.slice(start);
  const rest = trimLead(tail);
  if (!rest) return null;
  const skipped = tail.length - tail.replace(/^[\s,:;.!?…—–"'”’-]+/, "").length;
  const said = text.slice(0, m[0].length + start + skipped).trim();
  return { said, rest: rest[0].toUpperCase() + rest.slice(1) };
}

/**
 * The app's name said to it at the start of a sentence in `text` (the start, or after a full stop,
 * question or exclamation mark: "Okay, thanks. Kiko, ask Lacy …"), and the words after it. Null
 * when there's none. For listening hands-free, where what came before may be anything: a real word
 * written for the name (atStart) only at the very start.
 */
export function wakeIn(text: string): { at: number; rest: string } | null {
  const starts = [0, ...[...text.matchAll(/[.!?]+\s+/g)].map((m) => m.index! + m[0].length)];
  for (const at of starts) {
    const lead = leadingName(text.slice(at), at === 0);
    if (lead.addressed) return { at, rest: lead.rest };
  }
  return null;
}

// ── Listening hands-free ────────────────────────────────────────────────────

/** About this much quiet after a request ends it. */
export const END_SILENCE_MS = 1500;
/** The name said alone ("Kiko." … "ask Lacy …"): how long it waits for the request. */
export const NAME_ONLY_WAIT_MS = 4000;
/**
 * Without the name, a phrase ends after this much quiet, and the next starts a fresh transcript:
 * the name only counts at the start of one, and someone talking just before you doesn't hide it.
 */
export const PHRASE_GAP_MS = 800;
/** Apple's words come about this long after the sound they're for. */
export const WORDS_LAG_MS = 1000;
/** Words that stop changing for this long end it, even if steady noise keeps the level up. */
export const WORDS_STILL_MS = 3000;
/**
 * The longest request: it goes as it is then. Only a backstop for speech that never stops (a TV):
 * your requests run long (a 38s one was cut at 30s, 2026-10-28), and quiet or still words end them.
 */
export const MAX_REQUEST_MS = 120_000;
/** A phrase without the name that goes on this long (talk in the room) is dropped, and listening starts afresh. */
export const MAX_PHRASE_MS = 30_000;

/** Loudness of 16-bit PCM as 0–1 on a -60…0 dB scale (the level meter's, and the gate's). */
export function levelOf(chunk: Buffer) {
  const samples = chunk.length >> 1;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = chunk.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, samples)) + 1e-6);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/**
 * Whether a chunk of the mic's audio sounds like someone talking: well above the room's own noise,
 * which it keeps track of (down at once to anything quieter, up slowly), and not too quiet to be
 * speech at all. Only for when a phrase ends: what's in it is up to speech-to-text.
 */
export class Gate {
  /** The room's noise, on levelOf's scale. */
  floor = 1;
  /** How far over the noise (~9 dB), and how loud at least (~-48 dB). */
  above = 0.15;
  least = 0.2;

  voiced(level: number) {
    this.floor = level < this.floor ? level : this.floor + (level - this.floor) * 0.02;
    return level >= this.least && level - this.floor >= this.above;
  }
}

/** What a phrase was taken as: said to the app by name, or a reply to the session waiting, without it. */
export type By = "name" | "reply";

// ── Replies without the name: only deliberate ones, and only in a quiet room ────────────────

/**
 * Talk without the name (a phrase ignored, or one still going) this soon before the app started
 * speaking: someone else is talking in the room (a person, a TV), so the window after needs the name.
 */
export const BACKGROUND_BEFORE_MS = 5000;
/**
 * A voice already there this soon after the mic comes back (the app stopped, and DEAF_TAIL_MS
 * passed): it was going on through the app's words. Nobody answers that fast.
 */
export const ONSET_MS = 250;
/** A window that opens this soon after the mic came back follows what the app said (it opens as the app stops). */
const FOLLOWS_MS = 1500;

/** Why this window's reply needs the name: talk before the app spoke, talk going on as it started, a voice there as the mic came back. */
export type NeedsName = { why: "before" | "during" | "onset"; ms: number };

/**
 * What the session waiting asked: a yes or no (a permission prompt, or a finished turn that needs
 * you), one of Claude's multiple-choice questions, or nothing (it was only reporting: the short window).
 */
export type Asks = "yes-no" | "choice" | null;

// Sounds speech-to-text writes as words: not a reply on their own ("uh-huh", "hmm", a cough as "huh").
const FILLER = new Set("uh uhh um umm hmm hm mm mmm mhm huh ah ahh oh eh er erm".split(" "));
// Words that open what's said to the app ("Hey Kiko, …", "Okay, Kiko, …", "To Kiko, …": OPENER, TO):
// up front they don't count, so "Hey" alone never makes a reply before the name has had time to come.
const OPENS = new Set("hey hi hello ok okay so well to tell".split(" "));
// One word that answers a yes-or-no question or a permission prompt (routing-rules.ts YES_FALLBACK, NO_FALLBACK).
const ANSWER = new Set("yes yeah yep yup sure no nope nah allow approve deny stop cancel".split(" "));

/** The words that count in a reply: letters or digits, fillers left out, and the openers up front ("hey", "okay"). */
function replyWords(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu) ?? []).filter((w) => !FILLER.has(w));
  let i = 0;
  while (i < words.length && OPENS.has(words[i])) i++;
  return words.slice(i);
}

/**
 * Whether words without the name are a deliberate reply: two real words or more; one only when it
 * answers what the session asked ("yes" to a permission prompt, "two" to Claude's question). A lone
 * "yeah", "okay", "hmm" from across the room isn't one, and neither is "Hey …" before the name comes
 * ("Hey Kiko, just testing" is said to the app: it was once taken as a reply at "Hey").
 */
export function realReply(text: string, asks: Asks): boolean {
  const words = replyWords(text);
  if (words.length >= 2) return true;
  if (!words.length) return false;
  return asks === "choice" || (asks === "yes-no" && ANSWER.has(words[0]));
}

export type Timing = {
  endSilenceMs: number;
  nameOnlyWaitMs: number;
  phraseGapMs: number;
  wordsLagMs: number;
  wordsStillMs: number;
  maxRequestMs: number;
  maxPhraseMs: number;
};

const TIMING: Timing = {
  endSilenceMs: END_SILENCE_MS,
  nameOnlyWaitMs: NAME_ONLY_WAIT_MS,
  phraseGapMs: PHRASE_GAP_MS,
  wordsLagMs: WORDS_LAG_MS,
  wordsStillMs: WORDS_STILL_MS,
  maxRequestMs: MAX_REQUEST_MS,
  maxPhraseMs: MAX_PHRASE_MS,
};

type ListenerOptions = {
  /** A session's reply window is open, and replies without the name are on: words without it are a reply. */
  replyWindow: () => boolean;
  /** What the session waiting asked (Asks): one word answers a yes or no, or a choice. Null when absent. */
  asks?: () => Asks;
  /** This window's reply needs the name after all: someone else was talking (NeedsName). */
  needsName?: (why: NeedsName) => void;
  /** Words to act on began (the name, or a reply in its window): the app holds the floor, as a key press does. */
  holding: (by: By) => void;
  /** It heard the name: the listening cue, and the volume down. */
  named: () => void;
  /**
   * Quiet after the request. `text` is what was heard live, from the name on (or all of it, for a
   * reply); `ms` how long since words to act on began. The app takes the transcript's final words
   * and acts on them, then starts a fresh transcript.
   */
  ended: (heard: { text: string; by: By; ms: number }) => void;
  /** The name, then nothing: let go. The app starts a fresh transcript. */
  dropped: (by: By) => void;
  /**
   * A phrase without the name, outside a reply window, ended: not for the app. The app counts it and
   * starts a fresh transcript. In a window, `why` it wasn't a reply: the window needs the name, or
   * it wasn't one (a lone filler, one word that answers nothing).
   */
  ignored: (why?: "needs the name" | "not a reply") => void;
  timing?: Partial<Timing>;
  clock?: Clock;
};

/**
 * Hands-free listening, one phrase at a time: the live transcript since the app last started a
 * fresh one (`heard`), and whether each chunk of the mic's audio sounded like someone talking
 * (`sound`, from Gate). A phrase starting with the name ("Kiko, ask Lacy if it deployed", or
 * after a sentence ended: wakeIn) wakes it: the floor is held (`holding`) and the cue plays
 * (`named`). The request is what follows, until about END_SILENCE_MS of quiet (`ended`); the name
 * alone waits NAME_ONLY_WAIT_MS for one (`dropped` if none comes). In a session's reply window, a
 * phrase without the name is a reply when it's a real one (realReply), and only in a quiet room:
 * talk without the name heard up to BACKGROUND_BEFORE_MS before the app started speaking (`deaf`),
 * or a voice already there as the mic came back (`back`, ONSET_MS), and that window needs the name
 * (`needsName`). Any other phrase ends after PHRASE_GAP_MS of quiet and is
 * only counted (`ignored`). Quiet is the sound's when the gate hears voices, else the words'
 * (which come WORDS_LAG_MS late); words that stop changing for WORDS_STILL_MS end it whatever the
 * noise. Time comes in through `clock`, so tests/unit/core/wake.test.ts runs it on a fake one.
 */
export class Listener {
  /** Words to act on are coming in: the name was heard, or a reply in its window. */
  by: By | null = null;
  private text = "";
  private startedAt: number | null = null; // the phrase's first sound or words; null while nothing's been heard
  private inWindow = false; // a reply window was open when it started
  private wokeAt = 0;
  private namedHeard = false;
  private lastVoice = 0;
  private lastWords = 0;
  private voiced = false; // the gate heard a voice in this phrase: quiet is the sound's
  private timer: unknown = null;
  // Kept across phrases (reset() leaves them): the room around the app's words, and the window.
  private lastBackground: number | null = null; // the last sound or words of talk without the name
  private backAt: number | null = null; // the mic came back after the app spoke
  private before: NeedsName | null = null; // what the room was like as the app started to speak
  private windowOpen = false;
  private needs: NeedsName | null = null; // this window needs the name, and why
  private readonly t: Timing;
  private readonly o: ListenerOptions;
  private readonly clock: Clock;

  constructor(options: ListenerOptions) {
    this.o = options;
    this.t = { ...TIMING, ...options.timing };
    this.clock = options.clock ?? realClock;
  }

  get awake() {
    return this.by !== null;
  }

  /** Something was heard since the transcript started. */
  get started() {
    return this.startedAt !== null;
  }

  /** This window's reply needs the name (someone else was talking around the app's words); null when it doesn't, or no window is open. */
  get needsName(): NeedsName | null {
    return this.needs && this.o.replyWindow() ? this.needs : null;
  }

  /** The live transcript of this phrase, with the dictionary's fixes. */
  heard(text: string) {
    const t = text.replace(/\s+/g, " ").trim();
    if (t === this.text) return;
    const now = this.clock.now();
    this.look(now);
    this.text = t;
    this.lastWords = now;
    if (t) {
      this.begin(now);
      const wake = wakeIn(t);
      if (!this.by) {
        if (wake) this.wake("name", now);
        else if (this.replyOpen() && !this.needs && realReply(t, this.o.asks?.() ?? null)) this.wake("reply", now);
      } else if (!this.namedHeard && wake?.at === 0) {
        // A reply that starts with the name after all ("Kiko, yes", the name's word written late):
        // said to the app by name, and the cue, late.
        this.by = "name";
        this.namedHeard = true;
        this.o.named();
      }
    }
    this.schedule();
  }

  /** A chunk of the mic's audio: whether it sounded like someone talking. */
  sound(voiced: boolean) {
    const now = this.clock.now();
    this.look(now);
    if (!voiced) return;
    this.lastVoice = now;
    this.voiced = true;
    this.begin(now);
    this.schedule();
  }

  /** Drops whatever was heard (the app is about to speak, or the key went down), with no callback. */
  reset() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.by = null;
    this.text = "";
    this.startedAt = null;
    this.inWindow = false;
    this.wokeAt = 0;
    this.namedHeard = false;
    this.lastVoice = 0;
    this.lastWords = 0;
    this.voiced = false;
  }

  /**
   * The app is about to speak: the mic is dropped (hands-free.ts), and what was heard goes, as
   * reset(). What the room was like is kept for the window that follows: talk without the name
   * going on now, or ended BACKGROUND_BEFORE_MS ago or less. Back only a moment since it last
   * spoke (a cue, then the words), it's one stretch: what was heard before the first counts too.
   */
  deaf() {
    const now = this.clock.now();
    const going = !this.by && this.startedAt !== null && /[\p{L}\p{N}]/u.test(this.text);
    const ago = this.lastBackground === null ? null : now - this.lastBackground;
    let room: NeedsName | null = going ? { why: "during", ms: 0 } : ago !== null && ago <= BACKGROUND_BEFORE_MS ? { why: "before", ms: ago } : null;
    if (this.backAt !== null && now - this.backAt < FOLLOWS_MS) room ??= this.before;
    // A cue in a window that needs the name: it still does once the cue is over.
    if (this.windowOpen) room ??= this.needs;
    if (going) this.lastBackground = now;
    this.reset();
    this.before = room;
    this.backAt = null;
    this.windowOpen = false;
    this.needs = null;
  }

  /** The mic is back after the app spoke (and DEAF_TAIL_MS after). */
  back() {
    this.backAt = this.clock.now();
  }

  /** A reply window opening: it needs the name when the room wasn't quiet as the app spoke (deaf). */
  private look(now: number) {
    const open = this.o.replyWindow();
    if (open === this.windowOpen) return;
    this.windowOpen = open;
    if (!open) return;
    const follows = this.backAt !== null && now - this.backAt <= FOLLOWS_MS;
    const room = follows ? this.before : null;
    this.before = null;
    this.needs = null;
    if (room) this.needName(room);
  }

  private needName(why: NeedsName) {
    this.needs = why;
    this.o.needsName?.(why);
  }

  /** A reply window was open as the phrase started, or is now. */
  private replyOpen() {
    return this.inWindow || this.o.replyWindow();
  }

  private begin(now: number) {
    if (this.startedAt !== null) return;
    this.startedAt = now;
    this.inWindow = this.o.replyWindow();
    // A voice there the moment the mic came back, in the window that follows: it was going on all along.
    if (this.windowOpen && !this.needs && this.backAt !== null && now - this.backAt <= ONSET_MS) this.needName({ why: "onset", ms: now - this.backAt });
  }

  private wake(by: By, now: number) {
    this.by = by;
    this.wokeAt = now;
    this.o.holding(by);
    if (by === "name") {
      this.namedHeard = true;
      this.o.named();
    }
  }

  /** What the request is so far: the words after the name, or all of them for a reply. */
  private request() {
    return this.by === "name" ? (wakeIn(this.text)?.rest ?? "") : this.text;
  }

  /** When the phrase ends, if nothing more is heard; null with nothing heard. */
  private deadline(): number | null {
    if (this.startedAt === null) return null;
    const still = this.text ? this.lastWords + this.t.wordsStillMs : Infinity;
    // Not woken yet: what decides is the words, so the quiet counts from when the last sound's words
    // would be in (a pause right after "Kiko" mustn't end the phrase before "Kiko" is written).
    if (!this.by) {
      const settled = Math.max(this.voiced ? this.lastVoice + this.t.wordsLagMs : 0, this.lastWords, this.startedAt);
      return Math.min(settled + this.t.phraseGapMs, still, this.startedAt + this.t.maxPhraseMs);
    }
    // Woken: the request ends on the sound's quiet; the final transcript catches up with the words.
    const words = this.voiced ? this.lastWords - this.t.wordsLagMs : this.lastWords;
    const quiet = Math.max(this.lastVoice, words, this.startedAt);
    const cap = this.wokeAt + this.t.maxRequestMs;
    // The name alone: a few seconds for the request, longer while you're still making a sound.
    if (!this.request()) return Math.min(Math.max(this.wokeAt + this.t.nameOnlyWaitMs, quiet + this.t.endSilenceMs), cap);
    return Math.min(quiet + this.t.endSilenceMs, still, cap);
  }

  private schedule() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const at = this.deadline();
    if (at === null) return;
    this.timer = this.clock.setTimeout(() => this.fire(), Math.max(0, at - this.clock.now()));
  }

  private fire() {
    this.timer = null;
    const at = this.deadline();
    if (at === null) return;
    const now = this.clock.now();
    if (now < at) return this.schedule();
    const { by, text, wokeAt } = this;
    const rest = this.request();
    const words = /[\p{L}\p{N}]/u.test(text);
    const inWindow = this.replyOpen();
    // Talk without the name: the room isn't quiet (deaf), as of its last sound or words. Not a short
    // word in a window (it's as likely yours, "yeah" to what was said).
    if (!by && words && (!inWindow || this.needs)) this.lastBackground = Math.max(this.lastVoice, this.lastWords);
    this.reset();
    if (by && rest) this.o.ended({ text: by === "name" ? text.slice(wakeIn(text)!.at) : text, by, ms: now - wokeAt });
    else if (by) this.o.dropped(by);
    else if (words) this.o.ignored(inWindow ? (this.needs ? "needs the name" : "not a reply") : undefined);
  }
}
