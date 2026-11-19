// The guard on the router's own words: a message it writes for a session (ask_session) must be what
// you said, turned direct at most, never more. The relay eval (2026-11-07, 2026-11-16) found it
// adding requests ("Give me a short answer.", "Let me know yes or no."), the session's own title
// words ("the staging deploy", "for the onboarding screens"), and rewrites in the third person ("The
// user asks why …"). Measured on words, case, punctuation and word endings aside: a pronoun swapped
// ("Ask me before it deletes anything" → "… before you delete …") or a verb turned around ("whether
// it went through" → "Did it go through?") is the same message; a word you never said isn't.
//
// - A sentence of its own the router added ("Give me a short status.") is left out.
// - What's left must hold no word you didn't say (but the small words direct speech needs), every
//   number, path, name and command you said, every "not"/"only"/"unless", and most of your words.
// Otherwise decide.ts sends your own words instead, the direction off (direction.ts).
import { tokens } from "./words.ts";

/** Words a rewrite may add or drop: pronouns, articles, helping verbs, question words. Never content. */
const FRAMING = new Set([
  ...["i", "me", "my", "mine", "myself", "you", "your", "yours", "yourself", "we", "us", "our", "they", "them", "their", "he", "him", "his", "she", "her", "it", "its", "itself"],
  ...["a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "that", "this", "these", "those", "there", "here"],
  ...["is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had", "can", "could", "would", "will", "should", "shall", "may", "might", "must"],
  ...["please", "whether", "if", "what", "which", "who", "how", "why", "where", "when", "also", "just", "now", "ok", "okay", "hey"],
  ...["uh", "um", "umm", "uhm", "ah", "er", "erm", "hmm", "mm", "like", "yeah"],
]);
/** Said, but not words a session needs kept: dropping them isn't losing the message. */
const LIGHT = new Set("guess think maybe actually really kind sort basically mean know thing stuff right well either both each all".split(" "));
/** The words of a direction: a message that leaves them out has lost nothing. */
const DIRECTING = new Set("ask tell let know check send pass forward session one".split(" "));
/** Each class of negation or limit: a message with fewer of one than you said changed what you meant. */
const LIMITS: Array<[string, RegExp]> = [
  ["not", /^(?:not|no|nor|neither|dont|doesnt|didnt|cant|cannot|wont|wouldnt|shouldnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|mustnt|never|nothing|none|nobody|nowhere|without)$/],
  ["only", /^only$/],
  ["unless", /^unless$/],
  ["except", /^(?:except|excluding)$/],
  ["until", /^(?:until|till)$/],
];
const IRREGULAR: Record<string, string> = Object.fromEntries(
  Object.entries({
    go: "went gone goes going",
    do: "did done doing",
    be: "was were been",
    have: "had",
    make: "made",
    get: "got gotten",
    take: "took taken",
    give: "gave given",
    run: "ran running",
    write: "wrote written",
    break: "broke broken",
    say: "said",
    tell: "told",
    see: "saw seen",
    find: "found",
    build: "built",
    send: "sent",
    know: "knew known",
    think: "thought",
    leave: "left",
    keep: "kept",
    mean: "meant",
    bring: "brought",
    choose: "chose chosen",
    begin: "began begun",
    throw: "threw thrown",
  }).flatMap(([base, forms]) => forms.split(" ").map((f) => [f, base])),
);

const expanded = (s: string) =>
  s
    .replace(/\b(it|that|there|what|who|where|how)['’]s\b/gi, "$1 is")
    .replace(/\b(we|you|they)['’]re\b/gi, "$1 are")
    .replace(/\bI['’]m\b/g, "I am")
    .replace(/n['’]t\b/gi, " not");

/** A word as compared: "passed" and "pass", "deletes" and "delete", "went" and "go". */
export function stem(word: string): string {
  if (IRREGULAR[word]) return IRREGULAR[word];
  let w = word;
  if (w.length > 4 && /(?:ies|ied)$/.test(w)) return `${w.slice(0, -3)}y`;
  for (const end of ["ing", "ed", "es", "s"]) {
    if (w.length - end.length >= 3 && w.endsWith(end)) {
      w = w.slice(0, -end.length);
      break;
    }
  }
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

const wordsOf = (s: string) => tokens(expanded(s)).map((t) => t.word);
const contentOf = (s: string) => wordsOf(s).filter((w) => !FRAMING.has(w));
const limitsOf = (s: string) => {
  const out = new Map<string, number>();
  for (const w of wordsOf(s)) for (const [k, re] of LIMITS) if (re.test(w)) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
};
/** What must arrive verbatim: numbers, versions, paths, commands, identifiers ("v3.2.0", "src/x.ts", "--force", "handleWebhook", "SSH"). */
export function exactBits(text: string): string[] {
  return [...text.matchAll(/[^\s,;:!?()"“”]+/g)]
    .map((m) => m[0].replace(/^['‘]+|['’.]+$/g, ""))
    .filter((w) => /\d/.test(w) || /[/_~]|^--?\w|\w\.\w/.test(w) || /^[a-z]+[A-Z]\w*$/.test(w) || /^[A-Z]{2,}s?$/.test(w));
}

export type RouterWords = { ok: true; text: string; cut: string[] } | { ok: false; why: string; added?: string[]; lost?: string[] };

/**
 * Whether the router's `message` is your words (`said`, less `off`: the direction and parts for the
 * app) and nothing more: `text`, it less sentences of its own (`cut`). `earlier`: other words of
 * yours (or the conversation's) it may draw on when yours point to them ("forward that question to
 * Atlas"); then most of the message may come from them. `partial`: the message carries only a part of
 * your words (one of several, or with a correction): only its own sentences are left out. `names`:
 * the sessions' names (as heard words), which a message needn't keep.
 */
export function routerWords(input: { message: string; said: string; off?: string[]; earlier?: string[]; partial?: boolean; names?: string[] }): RouterWords {
  const { message } = input;
  const offWords = new Set((input.off ?? []).flatMap(contentOf).map(stem));
  const own = contentOf(input.said).map(stem);
  // Sessions' names said in it may well go (they say where it goes), and so may the direction's words;
  // so may a session named by what it is ("…? ask the new one", "tell the other session to …").
  const names = new Set((input.names ?? []).map(stem));
  const refs = [...input.said.matchAll(SESSION_REF)].map((m) => m[0]);
  const kept = contentOf(removeAll(input.said, refs))
    .map(stem)
    .filter((w) => !offWords.has(w) && !names.has(w) && !DIRECTING.has(w));
  const vocab = new Set([...own, ...(input.earlier ?? []).flatMap(contentOf).map(stem)]);
  // Words of the parts that aren't the session's (said to the app): never theirs to pass on, unless said elsewhere too.
  const elsewhere = new Set(contentOf(removeAll(input.said, input.off ?? [])).map(stem));
  const known = (w: string) => vocab.has(stem(w)) && (!offWords.has(stem(w)) || elsewhere.has(stem(w)));
  const sentences = message.split(/(?<=[.!?])\s+(?=\S)/);
  const cut: string[] = [];
  const saidExact = new Set(exactBits(input.said).map((b) => b.toLowerCase()));
  const saidLimits = limitsOf(input.said);
  const keptSet = new Set(kept);
  // Never the router's own: a sentence with a number, path or command you said, or a "not"/"only" you said
  // ("Increase it to 45 seconds."); for a part of your words (partial: nothing checks it after), one with two of your words.
  const yours = (sentence: string) =>
    exactBits(sentence).some((b) => saidExact.has(b.toLowerCase())) ||
    [...limitsOf(sentence).keys()].some((k) => saidLimits.has(k)) ||
    (Boolean(input.partial) &&
      new Set(
        contentOf(sentence)
          .map(stem)
          .filter((w) => keptSet.has(w) && !LIGHT.has(w)),
      ).size >= 2);
  const keptSentences = sentences.filter((sentence) => {
    const content = contentOf(sentence);
    const added = content.filter((w) => !known(w));
    // A sentence mostly of words you never said is the router's own: left out.
    if (content.length && added.length * 2 >= content.length && !yours(sentence)) {
      cut.push(sentence.trim());
      return false;
    }
    return true;
  });
  const text = keptSentences.join(" ").trim();
  if (!contentOf(text).length) return { ok: false, why: "nothing of yours left" };
  // A part of your words (one of several messages, or with a correction): only its own sentences go.
  if (input.partial) return { ok: true, text, cut };
  const added = [...new Set(contentOf(text).filter((w) => !known(w)))];
  if (added.length) return { ok: false, why: "adds words", added };
  // Every number, path and command you said, verbatim.
  const exactSaid = exactBits(removeAll(input.said, input.off ?? []));
  const lostExact = exactSaid.filter((b) => !text.toLowerCase().includes(b.toLowerCase()));
  if (lostExact.length) return { ok: false, why: "loses details", lost: lostExact };
  // Every "not", "only", "unless" you said.
  const want = limitsOf(removeAll(input.said, input.off ?? []));
  const got = limitsOf(text);
  const lostLimits = [...want].filter(([k, n]) => (got.get(k) ?? 0) < n).map(([k]) => k);
  if (lostLimits.length) return { ok: false, why: "loses a negation", lost: lostLimits };
  // Most of your words: unless they only point to earlier ones ("send it what I just asked").
  const fromYou = contentOf(text).filter((w) => own.includes(stem(w))).length;
  const pointing = input.earlier?.length && fromYou * 2 < contentOf(text).length;
  if (!pointing) {
    const have = new Set(contentOf(text).map(stem));
    const needed = kept.filter((w) => !LIGHT.has(w));
    const missing = [...new Set(needed.filter((w) => !have.has(w)))];
    if (needed.length && (needed.length - missing.length) / needed.length < 0.75) return { ok: false, why: "drops your words", lost: missing };
  }
  return { ok: true, text, cut };
}

/** "ask the new one", "tell the other session", "ask that first one": a session named by what it is, not its name. */
const SESSION_REF = /\b(?:ask|tell)\s+(?:the|that|this)\s+(?:[\p{L}\p{N}]+\s+){0,2}?(?:one|session)\b/giu;

/** `text` without each of `parts` (as said), for comparing what's left. */
function removeAll(text: string, parts: string[]) {
  let out = text;
  for (const p of parts) {
    const at = out.toLowerCase().indexOf(p.toLowerCase());
    if (at >= 0) out = `${out.slice(0, at)} ${out.slice(at + p.length)}`;
  }
  return out;
}

/**
 * Your words point to earlier ones, which a message may then carry: "forward that question to
 * Atlas", "send it what I just asked", "ask Harbor the same thing", "tell it what Atlas found".
 */
export const POINTS_BACK =
  /\b(?:forward|send|pass|relay|repeat|give)\b[^.?!]*\b(?:that|this|it|them|what)\b|\b(?:same|that|this|my|the\s+last|the\s+previous|earlier)\s+(?:question|message|request|thing|one)\b|\bwhat\s+(?:i|you|they|he|she|it|\w+)\s+(?:just\s+)?(?:said|asked|wrote|told|found|did)\b/i;
