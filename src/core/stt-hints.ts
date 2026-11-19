// The words speech-to-text should expect: what your dictionary writes, the names and folders of
// the sessions open, what the app calls itself and the agents it works with. Deepgram takes them
// as keyterms, Apple's recognizer as contextual strings. Built ahead of time (as the session list
// refreshes), never when the key goes down, and kept short: a long list slows nothing down but
// helps less.
import { type DictEntry, keyOf, loadDictionary } from "./dictionary.ts";
import { NAME, spokenName } from "./name.ts";
import { folderName, inScratch, sessionName, spoken, type Session } from "./sessions.ts";

// Deepgram allows 500 tokens and suggests the 20–50 terms that matter most.
export const MAX_HINTS = 40;
const MAX_WORDS = 4;
const MAX_CHARS = 40;

// The agents it works with, built in for everyone (the dictionary's other built-in words aren't
// hints: they're fixed after). Never "Claude" alone: it would pull "cloud" towards it.
const AGENTS = ["Claude Code", "Codex", "OpenCode", "T3 Code"];

/**
 * The hint list, most deliberate first: the name you call the app (name.ts spokenName: the wake
 * word, hands-free), your dictionary's targets (your spelling), the app's name and the agents, then
 * session names and folders, said as words ("lacy platform"). Each once, whatever its case.
 */
export function speechHints(sessions: Session[], entries: DictEntry[] = loadDictionary()): string[] {
  const names = sessions.flatMap((s) => [sessionName(s), inScratch(s.cwd) ? "" : folderName(s.cwd)]).map(spoken);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [spokenName(), ...entries.map((e) => e.write), NAME, ...AGENTS, ...names]) {
    const t = term.replace(/\s+/g, " ").trim();
    const key = keyOf(t);
    if (!worthHinting(t) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MAX_HINTS) break;
  }
  return out;
}

// Words, not IDs: letters in it, short, and no long digit runs ("scratch-2026-10-26-16dc10", a UUID).
function worthHinting(term: string) {
  return /\p{L}/u.test(term) && term.length <= MAX_CHARS && term.split(" ").length <= MAX_WORDS && !/\d{4,}|[0-9a-f]{8}-/i.test(term);
}
