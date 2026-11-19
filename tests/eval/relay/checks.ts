// The relay eval's hard checks, in code: where the words went, and what arrived there against the
// reference (reference.json): the direction gone, every must-keep detail verbatim, every negation and
// condition kept, nothing added beyond framing words. A reply to the waiting session must be the
// words as said, less only what today's engine drops. No model, no I/O: tests/unit/eval/relay-checks.test.ts.
import { DISFLUENT, findRun, tokens } from "../../../src/core/words.ts";

/** Opus 5.5's reading of a case (reference.ts), hand-checked. */
export type Reference = {
  /** What the user wants, in a sentence. */
  intent: string;
  /** Every question or action the target must receive. */
  actions: string[];
  /** Spans copied from the words that only say where they go ("Ask MintBox,", "tell Bobby to"): must not arrive. */
  direction: string[];
  /** Spans copied from the words that are for Kiko ("and Kiko, slow down"): must not arrive. */
  kikoParts: string[];
  /** Spans copied from the words that must arrive verbatim: paths, names, numbers, commands, quotes. */
  mustKeep: string[];
  /** Spans with a negation or limit (not, never, only, unless, except, without…) that must survive. */
  negations: string[];
  /** Spans with a condition or an order (if, when, once, until, before, then…) that must survive. */
  conditions: string[];
  /** Where it should go: the ideal message for each session it goes to; empty when it shouldn't be sent. */
  messages: Array<{ to: string; text: string }>;
  /** The words reply to the session waiting for a reply: they go as said. */
  isReply: boolean;
  /** Anything ambiguous, and hand corrections. */
  notes: string;
};

/** One message Kiko sent: to a session (by the case's name), with the text typed or replied. */
export type Sent = { to: string; text: string; via: string; action: string };

export type CheckName = "target" | "direction" | "kiko-words" | "must-keep" | "negation" | "condition" | "nothing-added" | "reply-exact";
export type Check = { name: CheckName; pass: boolean; why?: string; to?: string };

// ── Words ────────────────────────────────────────────────────────────────────────────────────
/** One class per kind of negation or limit: dropping any changes what was meant. */
const NEGATION_CLASSES: Record<string, RegExp> = {
  not: /^(?:not|no|nor|neither|dont|doesnt|didnt|cant|cannot|wont|wouldnt|shouldnt|isnt|arent|wasnt|werent|havent|hasnt|hadnt|mustnt|nothing|none|nobody|nowhere)$/,
  never: /^never$/,
  only: /^only$/,
  unless: /^unless$/,
  except: /^(?:except|excluding)$/,
  without: /^without$/,
  until: /^(?:until|till)$/,
};
/** Words that carry a condition or an order; each in a condition span must arrive. */
const CONDITION_WORDS = new Set(["if", "when", "whenever", "once", "unless", "until", "before", "after", "then", "first", "while", "otherwise", "else"]);

/** Words a direct rewrite may add or swap ("tell it to" → "you", "ask whether" → "did …?"): never content. */
const FRAMING = new Set([
  ...["i", "me", "my", "mine", "myself", "you", "your", "yours", "yourself", "we", "us", "our", "they", "them", "their", "he", "him", "his", "she", "her", "it", "its", "itself"],
  ...["im", "ive", "id", "ill", "youre", "youve", "youd", "youll", "were", "weve", "theyre", "its", "itll", "thats", "whats", "hows", "wheres", "theres", "lets", "heres"],
  ...["a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "that", "this", "these", "those"],
  ...["is", "are", "was", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had", "can", "could", "would", "will", "should", "shall", "may", "might", "must"],
  ...["please", "whether", "if", "what", "which", "who", "how", "why", "where", "when", "there", "here", "any", "also", "just", "now", "yet", "ok", "okay"],
  // "Ask Atlas for the diff" → "Can you show me the diff?"
  ...["show", "share", "send", "give"],
]);
/** Direction words: in a direction span, every other word names where the words go (a session, a title). */
const DIRECTION_WORDS = new Set([
  ...[
    "ask",
    "tell",
    "check",
    "send",
    "pass",
    "let",
    "know",
    "have",
    "message",
    "question",
    "note",
    "hey",
    "hi",
    "okay",
    "ok",
    "so",
    "and",
    "also",
    "then",
    "please",
    "can",
    "could",
    "would",
    "you",
    "go",
    "ahead",
  ],
  ...[
    "to",
    "for",
    "with",
    "on",
    "in",
    "this",
    "that",
    "it",
    "is",
    "its",
    "thats",
    "these",
    "one",
    "ones",
    "session",
    "instance",
    "agent",
    "project",
    "the",
    "a",
    "an",
    "by",
    "way",
    "whether",
    "if",
    "yours",
    "about",
  ],
]);

/** Lowercase words, apostrophes dropped (words.ts tokens), with every negation of one class as that class. */
export function words(text: string): string[] {
  return tokens(text).map((t) => t.word);
}

/** Common irregular verbs, by their base form: "Ask whether it went through" → "Did it go through?". */
const IRREGULAR: Record<string, string> = Object.fromEntries(
  Object.entries({
    go: "went gone goes going",
    do: "did done does doing",
    be: "was were been",
    have: "has had",
    make: "made",
    get: "got gotten",
    take: "took taken",
    give: "gave given",
    run: "ran running",
    write: "wrote written",
    break: "broke broken",
    say: "said says",
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
    fall: "fell fallen",
    hold: "held",
    pay: "paid",
    lose: "lost",
  }).flatMap(([base, forms]) => [[base, base], ...forms.split(" ").map((f) => [f, base])]),
);

/** A word's stem, for "passed" = "pass", "tests" = "test": crude, and only for comparing. */
export function stem(word: string): string {
  const base = IRREGULAR[word];
  if (base) return base;
  // "retries", "retried" = "retry".
  if (word.length > 4 && /(?:ies|ied)$/.test(word)) return `${word.slice(0, -3)}y`;
  let w = word;
  for (const end of ["ing", "ed", "es", "s"]) {
    if (word.length - end.length >= 3 && word.endsWith(end)) {
      w = word.slice(0, -end.length);
      break;
    }
  }
  // "delete", "deletes", "deleted" = "delet".
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

const negationClass = (w: string) => Object.entries(NEGATION_CLASSES).find(([, re]) => re.test(w))?.[0] ?? null;

/** How many of each class of negation `text` holds. */
export function negationCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words(text)) {
    const k = negationClass(w);
    if (k) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Text compared by its characters, spaces and sentence punctuation aside: for verbatim details. */
function squash(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[\s,;!?]+/g, " ")
    .trim();
}

/** `detail` is in `text` as said: case kept, unless it's plain lowercase words (a sentence may capitalise it). */
export function hasVerbatim(text: string, detail: string): boolean {
  const t = squash(text);
  const d = squash(detail).replace(/^["']|["'.]$/g, "");
  if (!d) return true;
  if (t.includes(d)) return true;
  const plain = /^[a-z][a-z' ]*$/.test(d);
  return plain && t.toLowerCase().includes(d.toLowerCase());
}

const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;

// ── The checks ───────────────────────────────────────────────────────────────────────────────
/** Where it went against where it should: the same sessions (names, any case), or nowhere. */
export function checkTarget(want: string | string[] | null, sent: Sent[], alsoOk: Array<string | string[] | null> = []): Check {
  const got = [...new Set(sent.map((s) => s.to.toLowerCase()))].sort();
  const same = (w: string | string[] | null) => {
    const ws = [...new Set((w === null ? [] : Array.isArray(w) ? w : [w]).map((x) => x.toLowerCase()))].sort();
    return ws.length === got.length && ws.every((x, i) => x === got[i]);
  };
  if (same(want) || alsoOk.some(same)) return { name: "target", pass: true };
  const shown = (w: string | string[] | null) => (w === null ? "nowhere" : Array.isArray(w) ? w.join(" + ") : w);
  return { name: "target", pass: false, why: `went ${got.length ? `to ${got.join(" + ")}` : "nowhere"}, wanted ${shown(want)}` };
}

/**
 * The direction (or Kiko's words) gone from `text`: no span's run of words left, and no word naming a
 * session from it ("MintBox" of "Ask MintBox,") more often than the ideal message has it.
 */
export function checkGone(name: "direction" | "kiko-words", text: string, spans: string[], ideal: string): Check {
  const all = tokens(text);
  const said = words(text);
  const want = words(ideal);
  const left: string[] = [];
  for (const span of spans) {
    const run = words(span).filter((w) => !DISFLUENT.has(w));
    if (!run.length) continue;
    const meant = run.filter((w) => !DIRECTION_WORDS.has(w));
    // The whole span still there (unless the ideal has it too: "ask me" kept as content).
    if (run.length > 1 && findRun(all, run, 0) !== null && findRun(tokens(ideal), run, 0) === null) {
      left.push(span);
      continue;
    }
    // A name from it, left behind ("MintBox, what do I need …").
    const extra = meant.filter((w) => count(said, w) > count(want, w));
    if (extra.length) left.push(`${span} (${[...new Set(extra)].join(", ")})`);
  }
  return left.length ? { name, pass: false, why: `left in: ${left.map((s) => JSON.stringify(s)).join(", ")}` } : { name, pass: true };
}

/** Every must-keep detail in `text`, verbatim. */
export function checkMustKeep(text: string, details: string[]): Check {
  const lost = details.filter((d) => !hasVerbatim(text, d));
  return lost.length ? { name: "must-keep", pass: false, why: `lost: ${lost.map((d) => JSON.stringify(d)).join(", ")}` } : { name: "must-keep", pass: true };
}

/** Each kind of negation in the negation spans at least as often in `text` ("not to push" → "Don't push" counts). */
export function checkNegations(text: string, spans: string[]): Check {
  const want = new Map<string, number>();
  for (const span of spans) for (const [k, n] of negationCounts(span)) want.set(k, (want.get(k) ?? 0) + n);
  const got = negationCounts(text);
  const lost = [...want].filter(([k, n]) => (got.get(k) ?? 0) < n).map(([k, n]) => `${k} ×${n - (got.get(k) ?? 0)}`);
  return lost.length ? { name: "negation", pass: false, why: `lost: ${lost.join(", ")}` } : { name: "negation", pass: true };
}

/**
 * Each condition's own words (if, when, until… and its content words, stemmed) in `text`. With
 * `ideal`, only the content words the ideal message keeps ("When Harbor finishes" → "When you finish").
 */
export function checkConditions(text: string, spans: string[], ideal?: string): Check {
  const got = new Set(words(text).map(stem));
  const kept = ideal === undefined ? null : new Set(words(ideal).map(stem));
  const lost: string[] = [];
  for (const span of spans) {
    const content = (w: string) => !FRAMING.has(w) && !DISFLUENT.has(w) && !negationClass(w) && (!kept || kept.has(stem(w)));
    const need = words(span).filter((w) => CONDITION_WORDS.has(w) || content(w));
    const missing = need.filter((w) => !got.has(stem(w)));
    if (missing.length) lost.push(`${JSON.stringify(span)} (${missing.join(", ")})`);
  }
  return lost.length ? { name: "condition", pass: false, why: `lost: ${lost.join(", ")}` } : { name: "condition", pass: true };
}

/** No content word in `text` that wasn't said: only framing words may be new ("Tell it to restart" → "Restart."). */
export function checkNothingAdded(said: string, text: string): Check {
  const from = new Set(words(said).map((w) => negationClass(w) ?? stem(w)));
  const added = [...new Set(words(text).filter((w) => !FRAMING.has(w) && !DISFLUENT.has(w) && !from.has(negationClass(w) ?? stem(w))))];
  return added.length ? { name: "nothing-added", pass: false, why: `added: ${added.join(", ")}` } : { name: "nothing-added", pass: true };
}

/**
 * A reply as said: `text` is `said` with words left out and nothing added, changed or moved, and
 * what's left out only what today's engine drops from a reply: fillers ("uh"), a word said twice in
 * a row, and the words of `names` (the session's own name up front: "Bobby, yes do it").
 */
export function checkReplyExact(said: string, text: string, names: string[]): Check {
  const from = words(said);
  const got = words(text);
  const mayDrop = new Set([...DISFLUENT, "hey", ...names.flatMap(words)]);
  const dropped: string[] = [];
  let i = 0;
  for (const w of got) {
    while (i < from.length && from[i] !== w) {
      if (!mayDrop.has(from[i]) && from[i] !== from[i + 1] && from[i] !== from[i - 1]) dropped.push(from[i]);
      i++;
    }
    if (i === from.length) return { name: "reply-exact", pass: false, why: `changed: "${w}" isn't in what was said, in order` };
    i++;
  }
  for (; i < from.length; i++) if (!mayDrop.has(from[i]) && from[i] !== from[i - 1]) dropped.push(from[i]);
  return dropped.length ? { name: "reply-exact", pass: false, why: `dropped: ${dropped.join(", ")}` } : { name: "reply-exact", pass: true };
}

/**
 * All the hard checks on one run: the target, then each message sent against the reference's (by
 * session). Without a reference only the target and, for replies, reply-exact. `reply`: the case is a
 * reply to the waiting session (reply-exact), whose `names` it may drop.
 */
export function hardChecks(input: {
  said: string;
  sent: Sent[];
  want: string | string[] | null;
  alsoOk?: Array<string | string[] | null>;
  reference: Reference | null;
  reply: { names: string[] } | null;
}): Check[] {
  const { said, sent, reference: ref, reply } = input;
  const out: Check[] = [checkTarget(input.want, sent, input.alsoOk)];
  for (const s of sent) {
    const tag = (c: Check): Check => ({ ...c, to: s.to });
    if (reply) {
      out.push(tag(checkReplyExact(said, s.text, reply.names)));
      continue;
    }
    if (!ref) continue;
    const ideal = ref.messages.find((m) => m.to.toLowerCase() === s.to.toLowerCase())?.text ?? ref.messages[0]?.text ?? "";
    // Several sessions, a message each: the other sessions' words aren't this one's to keep.
    const own = (span: string) => ref.messages.length < 2 || hasVerbatim(ideal, span) || words(span).every((w) => words(ideal).includes(w));
    out.push(tag(checkGone("direction", s.text, ref.direction, ideal)));
    if (ref.kikoParts.length) out.push(tag(checkGone("kiko-words", s.text, ref.kikoParts, ideal)));
    out.push(tag(checkMustKeep(s.text, ref.mustKeep.filter(own))));
    out.push(tag(checkNegations(s.text, ref.negations.filter(own))));
    out.push(tag(checkConditions(s.text, ref.conditions.filter(own), ideal || undefined)));
    out.push(tag(checkNothingAdded(said, s.text)));
  }
  return out;
}
