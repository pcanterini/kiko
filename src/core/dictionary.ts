// The dictionary: what speech-to-text writes for names it mishears, and what to write instead
// ("cloud code" → "Claude Code", "ghosty" → "Ghostty"). Applied to what you said right after
// speech-to-text, before anything decides where it goes, so routing, the clean-up and the trim all
// see the fixed words. Two parts:
// - Built in (builtInEntries): the app's names, its domain and a few common coding tools. In the
//   code, updated with each release; never written to your file, never listed in settings.
// - Yours: dictionary.json next to the settings file, plain JSON ({ "heard": "write" }), empty until
//   you add a word (settings → Dictionary, or by voice). Read when used, so an edit there applies to
//   your next words without a restart. An entry of yours for the same words as a built-in one wins
//   (one that writes the words as heard keeps them as they are).
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { log } from "./log.ts";
import { DOMAIN, DOMAIN_HEARD, flavourNames, misheard, NAME, spokenName } from "./name.ts";
import { DICTIONARY_REQUEST } from "./routing-rules.ts";
import { SETTINGS_FILE } from "./settings.ts";

export const DICTIONARY_FILE = join(dirname(SETTINGS_FILE), "dictionary.json");

export type DictEntry = { heard: string; write: string };
/** One fix made: `heard` as it was in the text, `write` what replaced it. */
export type Replaced = { heard: string; write: string };

const all = (write: string, ...heard: string[]): DictEntry[] => heard.map((h) => ({ heard: h, write }));

/**
 * Common coding tools as speech-to-text writes them, from real use. Only
 * phrases that can't mean anything else, for anyone: "cloud code" is Claude Code, but "cloud" alone
 * stays "cloud" (and nothing writes "Claude" alone); "T-Mux" is tmux, "J-Son" JSON. Nothing of one
 * person's (their projects go in their own dictionary).
 */
export const TOOLS: DictEntry[] = [
  // "cloud code" most of all (41 times), then the rest.
  ...all("Claude Code", "cloud code", "clot code", "clod code", "cod code", "quad code", "caught code"),
  ...all("CLAUDE.md", "claude dot md", "cloud dot md"),
  ...all("Codex", "kodex"),
  ...all("Codex CLI", "kodak cli"),
  ...all("OpenCode", "open code"),
  ...all("T3 Code", "t3 code", "t 3 code", "t three code", "tee three code"),
  ...all("Ghostty", "ghosty", "ghostie"),
  // "T-Mux" (hyphens are spaces here).
  ...all("tmux", "t mux", "tee mux"),
  ...all("GitHub", "git hub"),
  ...all("TypeScript", "type script"),
  ...all("JavaScript", "java script"),
  ...all("Next.js", "next js", "next j s", "next dot js"),
  ...all("npm", "n p m"),
  ...all("pnpm", "p n p m"),
  ...all("JSON", "j son"),
  ...all("macOS", "mac os", "mac o s"),
  ...all("iPhone", "i phone"),
  ...all("Xcode", "x code"),
  ...all("Deepgram", "deep gram"),
];

/**
 * The app's own words as speech-to-text writes them, all from name.ts, so a new name brings its
 * own: the spoken name's spellings (misheard: "kiku" → Kiko) and the product's (NAME), for "the
 * kiku app"; its domain said as words ("kiku dot S H" → DOMAIN, and DOMAIN_HEARD); and a
 * checkout's flavour ("kiko dev", "devkiko" → Kiko Dev).
 */
function nameEntries(spoken = spokenName()): DictEntry[] {
  const of = (name: string) => misheard(name).heard.map((heard) => ({ heard, write: name }));
  // The product's name and its spellings, lower case: what the domain and the flavour are said with.
  const spellings = [NAME, ...misheard(NAME).heard].map((n) => n.toLowerCase());
  const [site, tld = ""] = DOMAIN.split(".");
  // "sh" said as a word or as letters ("S H").
  const tlds = tld.length <= 3 ? [tld, [...tld].join(" ")] : [tld];
  const domain = site === NAME.toLowerCase() ? spellings.flatMap((n) => tlds.map((t) => `${n} dot ${t}`)) : [];
  const dev = flavourNames("dev").title;
  return [...of(spoken), ...(keyOf(spoken) === keyOf(NAME) ? [] : of(NAME)), ...all(DOMAIN, ...domain, ...DOMAIN_HEARD), ...all(dev, ...spellings.flatMap((n) => [`${n} dev`, `dev ${n}`, `dev${n}`]))];
}

/** Everything built in, as it is now (the names follow the spoken name): yours win over these. */
export const builtInEntries = (spoken = spokenName()): DictEntry[] => [...nameEntries(spoken), ...TOOLS];

/** The built-in entry for `heard` (any case or spacing), if there's one. */
export const builtIn = (heard: string): DictEntry | undefined => builtInEntries().find((e) => keyOf(e.heard) === keyOf(heard));

// Your entries with the built-in ones after them, kept while both are the same (patternFor's cache keys on the list).
let withBuiltIn: { entries: DictEntry[]; spoken: string; all: DictEntry[] } | null = null;
function andBuiltIn(entries: DictEntry[]): DictEntry[] {
  const spoken = spokenName();
  if (withBuiltIn?.entries === entries && withBuiltIn.spoken === spoken) return withBuiltIn.all;
  withBuiltIn = { entries, spoken, all: [...entries, ...builtInEntries(spoken)] };
  return withBuiltIn.all;
}

/** "Snip  Kit" and "clip-kit" are the same entry. */
export const keyOf = (heard: string) =>
  heard
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .join(" ");

// Read again only when the file changed: it's checked on every press and caption update.
let cache: { file: string; mtimeMs: number; entries: DictEntry[] } | null = null;
// No file (a new install's, until you add a word): the same empty list each time, so patternFor's cache (keyed on the list) holds.
const NONE: DictEntry[] = [];

/** Your entries, in the file; none when it's missing or unreadable. The built-in ones aren't in it. */
export function loadDictionary(file = DICTIONARY_FILE): DictEntry[] {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return NONE;
  }
  if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.entries;
  // A broken file (one edited by hand, or left half written by a Kiko before 2026-11-12) is set
  // aside, never saved over (core/json-file.ts): no fixes until words are added again.
  const all = readJsonFile(file) as Record<string, unknown> | undefined;
  const entries = all
    ? Object.entries(all)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .map(([heard, write]) => ({ heard: heard.trim(), write: write.trim() }))
        .filter(usable)
    : [];
  cache = { file, mtimeMs, entries };
  return entries;
}

// A word or phrase with letters or digits in it, and something to write.
const usable = (e: DictEntry) => /[\p{L}\p{N}]/u.test(e.heard) && e.write.length > 0;

function save(entries: DictEntry[], file: string) {
  writeJsonAtomic(file, Object.fromEntries(entries.map((e) => [e.heard, e.write])));
  cache = null;
}

/** Adds an entry, or changes what an existing one writes. Returns what it wrote before, if anything. */
export function addEntry(heard: string, write: string, file = DICTIONARY_FILE): { before?: string } {
  const entry = { heard: heard.trim(), write: write.trim() };
  if (!usable(entry)) throw new Error("A dictionary entry needs words to listen for and what to write.");
  const all = loadDictionary(file);
  const at = all.findIndex((e) => keyOf(e.heard) === keyOf(entry.heard));
  const before = at >= 0 ? all[at].write : undefined;
  save(at >= 0 ? all.map((e, i) => (i === at ? entry : e)) : [...all, entry], file);
  return { before };
}

/**
 * Removes the entry for `heard`; failing that, the ones that write it ("remove Ghostty" when you
 * say what it becomes). Returns what was removed.
 */
export function removeEntry(heard: string, file = DICTIONARY_FILE): DictEntry[] {
  const all = loadDictionary(file);
  const key = keyOf(heard);
  let gone = all.filter((e) => keyOf(e.heard) === key);
  if (!gone.length) gone = all.filter((e) => keyOf(e.write) === key);
  if (gone.length)
    save(
      all.filter((e) => !gone.includes(e)),
      file,
    );
  return gone;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One pattern for the whole dictionary, kept while the entries are the same.
let compiled: { entries: DictEntry[]; re: RegExp | null; write: Map<string, string> } | null = null;

function patternFor(entries: DictEntry[]) {
  if (compiled?.entries === entries) return compiled;
  // Longest first: at any one place, "cloud code" is tried before a "cloud" of yours. The same words
  // sort together whatever their spacing, in the order given: yours before the built-in one.
  const sorted = [...entries].sort((a, b) => keyOf(b.heard).split(" ").length - keyOf(a.heard).split(" ").length || keyOf(b.heard).length - keyOf(a.heard).length);
  const write = new Map<string, string>();
  const alternatives: string[] = [];
  for (const e of sorted) {
    const key = keyOf(e.heard);
    if (write.has(key)) continue; // yours, then the built-in one for the same words (or a list passed in with two)
    write.set(key, e.write);
    alternatives.push(key.split(" ").map(escape).join("[\\s-]+"));
  }
  // Whole words only: "ghosty" in "ghostys" or "unghosty" stays.
  const re = alternatives.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  compiled = { entries, re, write };
  return compiled;
}

/**
 * `text` with every word or phrase in the dictionary replaced: whole words, any case, longest
 * first, in one pass (what one entry writes is never fixed again by another). The built-in entries
 * (builtInEntries) too, after `entries`, which win over them.
 */
export function applyDictionary(text: string, entries: DictEntry[] = loadDictionary()): { text: string; replaced: Replaced[] } {
  const { re, write } = patternFor(andBuiltIn(entries));
  if (!re || !text) return { text, replaced: [] };
  const replaced: Replaced[] = [];
  const out = text.replace(re, (heard) => {
    const to = write.get(keyOf(heard))!;
    if (to !== heard) replaced.push({ heard, write: to });
    return to;
  });
  return { text: out, replaced };
}

// What you said, fixed as the app takes it. Not an "add to dictionary: ghosty means Ghostty": fixed,
// it would say "Ghostty means Ghostty".
function fixed(heard: string, entries: DictEntry[]): { text: string; replaced: Replaced[] } {
  if (DICTIONARY_REQUEST.test(heard)) return { text: heard, replaced: [] };
  return applyDictionary(heard, entries);
}

/**
 * What you said, fixed by the dictionary, as the app takes it after speech-to-text; the log keeps
 * both ("dictionary": `heard` as transcribed, `text` as fixed, what was `replaced`).
 */
export function fixHeard(heard: string, entries: DictEntry[] = loadDictionary()): { text: string; replaced: Replaced[] } {
  const out = fixed(heard, entries);
  if (out.replaced.length) log("dictionary", { heard, text: out.text, replaced: out.replaced });
  return out;
}

/**
 * Your words while you're still saying them (the caption, the phone's live words), fixed as fixHeard
 * will fix them once they're final, so what you see while talking is what's sent. Never logged:
 * they change several times a second, and only the final words are what you said.
 */
export const fixLive = (heard: string, entries: DictEntry[] = loadDictionary()) => fixed(heard, entries).text;
