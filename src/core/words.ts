// Your words as words: what the trim (trim.ts) and the clean-up (cleanup.ts) compare and cut by,
// case and punctuation aside.

export type Token = { word: string; start: number; end: number };

// Words that are only sound: dropping them alone never changes what you meant.
export const DISFLUENT = new Set(["uh", "um", "umm", "uhm", "ah", "er", "erm", "hmm", "mm"]);
export const NEGATION = /^(?:not|no|never|dont|doesnt|didnt|cant|cannot|wont|wouldnt|shouldnt|isnt|arent|wasnt|nothing|none|without)$/;

// Letters and digits, apostrophes dropped: "Let's" and "lets" are the same word.
export function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)].map((m) => ({
    word: m[0].toLowerCase().replace(/['’]/g, ""),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Where the run of words `want` starts in `all`, from `from` on. */
export function findRun(all: Token[], want: string[], from: number): number | null {
  for (let i = from; i + want.length <= all.length; i++) {
    if (want.every((w, j) => all[i + j].word === w)) return i;
  }
  return null;
}

/**
 * `text` without the runs of its words in `cuts` ([first, last + 1) token indexes, not
 * overlapping), each with the punctuation and space after it, tidied.
 */
export function cutRuns(text: string, all: Token[], cuts: Array<[number, number]>): { text: string; dropped: string[] } {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  // What follows a cut that ends a sentence starts one: "Push it. Kiko, don't merge" → "Push it. Don't merge".
  const upFirst = (s: string) => (/[.!?]\s*$/.test(out) ? s.replace(/^(\s*)(\p{Ll})/u, (_, sp: string, c: string) => sp + c.toUpperCase()) : s);
  for (const [s, e] of sorted) {
    out += upFirst(text.slice(pos, all[s].start));
    // Take the punctuation and space after the part with it ("one. Uh," → "Uh,"), keeping a
    // sentence end the text before it now lacks.
    const gap = text.slice(all[e - 1].end).match(/^[\s,.;:!?—–-]*/)![0];
    const end = gap.match(/[.!?]/)?.[0];
    if (end && /[\p{L}\p{N}]\s*$/u.test(out)) out = `${out.trimEnd()}${end} `;
    pos = all[e - 1].end + gap.length;
  }
  out += upFirst(text.slice(pos));
  return { text: tidy(out), dropped: sorted.map(([s, e]) => text.slice(all[s].start, all[e - 1].end)) };
}

// What's left after cutting: no stray punctuation at the edges, a capital to start.
function tidy(text: string) {
  const s = text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/^[\s,.;:!?—–-]+/, "")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Levenshtein distance. */
export function distance(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** A word spelled as said: a soft "c" as "s", a hard one (and "ck", "q") as "k", "ph" as "f". */
export const sounded = (w: string) =>
  w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k");

/**
 * How far a word said is from a name it may be speech-to-text's take on ("Lucy" for Lacy,
 * "Pixy" for pixie): spelled as said, it starts with the same sound and is at most about half the
 * name's letters off (`share` of them). Null when it isn't that close. Both lower case.
 */
export function nearDistance(said: string, name: string, share = 0.45): number | null {
  const a = sounded(said);
  const b = sounded(name);
  if (!a || a[0] !== b[0]) return null;
  const d = distance(a, b);
  return d <= Math.max(1, Math.floor(name.length * share)) ? d : null;
}
