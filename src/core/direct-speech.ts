// Reported speech made direct, in code, only where it's mechanical: what follows a direction to a
// session ("tell X to …", "ask X whether …", "tell X it can …") as the words that session should
// read ("Restart the server.", "Is the new logo in the repo yet?", "You can merge once CI passes.").
// Words are only moved, never made up: the most it adds are the small words direct speech needs
// ("do", "you", "are", "don't"), and every word said stays (keepsWords checks it). Where the change
// isn't mechanical (a question with no helping verb to move: "whether the notarization went
// through"), these return null and the words aren't changed here (direction.ts hands them on).

// ── Words ─────────────────────────────────────────────────────────────────────────────────────
/** Helping verbs a question moves to the front: "the logo is in the repo" → "Is the logo in the repo". */
const AUX = new Set(
  "is are was were can could will would should shall may might must isn't aren't wasn't weren't can't couldn't won't wouldn't shouldn't has have had hasn't haven't hadn't".split(" "),
);
/** "has", "have", "had" only help a verb that's done ("has finished", "had been"): "if it has a test" isn't one. */
const HAVE = new Set("has have had hasn't haven't hadn't".split(" "));
const PARTICIPLE = /^(?:\p{L}+ed|been|done|gone|made|seen|run|written|built|found|sent|taken|given|got|gotten|broken|left|kept|begun|chosen|held|lost|paid)$/u;
/** What starts a noun phrase a helping verb can follow: "the new logo", "any work", "Harbor's deploy", "there". */
const DETERMINER = new Set("the a an any some this that these those my your our their its every each all no there".split(" "));
/** Who the clause is about, said to their face: "I", "we", "you", "they" stay; "it" (the session) becomes "you". */
const PRONOUN = new Set("i we you they it".split(" "));
/**
 * Words after "it is" in a question asked of the session that say it's the session ("is it
 * working on …" → "are you working on …"), not a thing ("is it possible", "is it tagged").
 */
const ABOUT_ITSELF = /^(?:\p{L}+ing|busy|stuck|free|available|sure|able)$/iu;
/**
 * The same said of it, in what's passed on ("so it's busy" → "so you're busy"): fewer, since a thing
 * is as often meant there ("it's failing on main", "tell me when it's done", "it's not possible").
 */
const SAID_OF_ITSELF = /^(?:busy|stuck|free|available|sure|able|working|doing)$/iu;
/** After "it can/should/will…": not "it would be possible". */
const NOT_ITSELF_AFTER_MODAL = /^(?:be|have\s+been)$/i;
/**
 * Verbs a session does ("before it deletes anything", "what it needs"): "it" before one of these is
 * the session. Not verbs things do ("once it passes", "if it works", "when it breaks").
 */
const AGENT_VERBS = new Set(
  "adds commits deletes deploys edits fixes handles knows merges moves plans pushes removes thinks touches tries wants writes asks says suggests recommends expects retries".split(" "),
);
/** And after a question word, where "it" is plainly the one asked: "what it needs", "how it uses …". */
const ASKED_VERBS = new Set([...AGENT_VERBS, ..."needs uses does makes changes finishes starts runs handles sees".split(" ")]);
const MODAL = new Set("can could will would should might must may can't couldn't won't wouldn't shouldn't".split(" "));

/** What direct speech may add: the words it moves pronouns and verbs with. */
export const MAY_ADD = new Set("do does did you your youre yourself are were have havent dont arent werent what".split(" "));

const lc = (w: string) => w.toLowerCase().replace(/’/g, "'");
const bare = (w: string) => lc(w).replace(/[^\p{L}\p{N}']/gu, "");
export const cap = (s: string) => s.replace(/^(\s*["'“‘(]*)(\p{Ll})/u, (_, a: string, c: string) => a + c.toUpperCase());
const uncap = (w: string) => (/^\p{Lu}\p{Ll}/u.test(w) && !/^I(?:'|$)/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w);

/** A verb in the -s form ("needs", "pushes", "tries", "does", "has") as after "you": "need", "push", "try", "do", "have". */
export function baseForm(verb: string): string {
  const w = lc(verb);
  if (w === "has") return "have";
  if (w === "does") return "do";
  if (w === "goes") return "go";
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z|o)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

const YOU_AUX: Record<string, string> = { is: "are", "'s": "are", was: "were", has: "have", "hasn't": "haven't", "isn't": "aren't", "wasn't": "weren't", does: "do", "doesn't": "don't" };

// ── "it" said of the session → "you" ─────────────────────────────────────────────────────────
/** Where "it" may be the session's: the clause's start, or right after a word that starts a clause. */
const CLAUSE_OPENER = /^(?:so|and|but|before|after|when|once|until|unless|if|while|because|then|that|whether|soon)$/i;

/**
 * "it" turned to "you" where it's plainly the session doing something: "it can merge" → "you can
 * merge", "before it deletes anything" → "before you delete anything", "if it hasn't yet" → "if you
 * haven't yet", "it's working on" → "you're working on"; "its own" after one of those → "your own".
 * Not a thing's "it": "it's possible", "it was a mistake", "once it passes", "merge it".
 */
export function youFor(clause: string): string {
  const parts = clause.split(/(\s+)/);
  let converted = false;
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    const w = bare(raw);
    if (converted && w === "its" && bare(parts[i + 2] ?? "") === "own") {
      parts[i] = raw.replace(/its/i, (m) => (m[0] === "I" ? "Your" : "your"));
      continue;
    }
    if (w !== "it" && w !== "it's") continue;
    const prev = i >= 2 ? parts[i - 2] : "";
    const opens = i === 0 || CLAUSE_OPENER.test(bare(prev)) || /[,;:.!?]$/.test(prev);
    if (!opens) continue;
    const upper = /^I/.test(raw);
    const you = upper ? "You" : "you";
    const next = parts[i + 2] ?? "";
    const nextW = bare(next);
    const after = bare(parts[i + 4] ?? "");
    if (w === "it's") {
      if (!SAID_OF_ITSELF.test(nextW)) continue;
      parts[i] = raw.replace(/it['’]s/i, `${you}'re`);
      converted = true;
      continue;
    }
    // "it is", "it was", "it has", "it hasn't", "it does"
    if (nextW in YOU_AUX && !/[,;:.!?]$/.test(raw)) {
      const ok = HAVE.has(nextW) ? PARTICIPLE.test(after) || /^(?:yet|already|not)$/.test(after) || !after : nextW === "does" || nextW === "doesn't" ? true : SAID_OF_ITSELF.test(after);
      if (!ok) continue;
      parts[i] = you;
      parts[i + 2] = next.replace(/^[\p{L}']+/u, YOU_AUX[nextW]);
      converted = true;
      continue;
    }
    if (MODAL.has(nextW) && !/[,;:.!?]$/.test(raw)) {
      if (NOT_ITSELF_AFTER_MODAL.test(after)) continue;
      parts[i] = you;
      converted = true;
      continue;
    }
    if (AGENT_VERBS.has(nextW) && !/[,;:.!?]$/.test(raw)) {
      parts[i] = you;
      parts[i + 2] = next.replace(/^[\p{L}']+/u, baseForm(nextW));
      converted = true;
    }
  }
  return parts.join("");
}

// ── The forms ─────────────────────────────────────────────────────────────────────────────────
/** The first sentence of `text`, and what follows it (its own sentences, as said). */
function firstSentence(text: string): { head: string; tail: string } {
  const m = /^([\s\S]*?[.!?])(\s+[\s\S]*)?$/.exec(text);
  if (!m) return { head: text, tail: "" };
  return { head: m[1], tail: m[2] ?? "" };
}

const endWith = (head: string, mark: string) => `${head.replace(/[\s,;:.!?]+$/, "")}${mark}`;

/**
 * "tell X to <rest>": the instruction itself ("Restart the server."). `neg`: "not" or "never" said
 * before "to" ("tell X not to push yet" → "Don't push yet."), or "not" after it ("to not start yet").
 */
export function imperative(rest: string, neg: "not" | "never" | null = null): string {
  let body = rest.trimStart();
  let not = neg;
  const after = /^(not|never)\s+/i.exec(body);
  if (!not && after) {
    not = lc(after[1]) as "not" | "never";
    body = body.slice(after[0].length);
  }
  body = youFor(body);
  if (not === "not") return `Don't ${uncap(body)}`;
  if (not === "never") return `Never ${uncap(body)}`;
  return cap(body);
}

/** "tell X (that) <rest>": what to tell it, said to it ("Tell Atlas it can merge" → "You can merge."). */
export function statement(rest: string): string {
  return cap(youFor(rest.trimStart()));
}

/** Words as tokens for the question forms, punctuation kept on each. */
const split = (s: string) => s.trim().split(/\s+/).filter(Boolean);

/** A pronoun subject with its helping verb run in ("we're", "they've", "I'm"): the two words. */
function contraction(word: string): [string, string] | null {
  const m = /^(i|we|you|they|it|there)['’](re|m|s|ve|ll|d)$/i.exec(bare(word));
  if (!m) return null;
  const subject = m[1].toLowerCase() === "i" ? "I" : m[1];
  const aux: Record<string, string> = { re: "are", m: "am", s: "is", ve: "have", ll: "will", d: "would" };
  return [subject, aux[m[2].toLowerCase()]];
}

/**
 * A subject, its helping verb moved before it: "the new logo is in the repo yet" → "Is the new logo
 * in the repo yet", "it can tell … from its own" → "Can you tell … from your own", "they're done" →
 * "Are they done". Null when there's none to move (no helping verb up front, or one a main verb:
 * "it has a test").
 */
function inverted(clause: string, plural: boolean): string | null {
  const ws = split(clause);
  if (!ws.length) return null;
  // "we're on" → "we are on"
  const c = contraction(ws[0]);
  if (c) ws.splice(0, 1, c[0], c[1] + (ws[0].match(/[,;:.!?]+$/)?.[0] ?? ""));
  const first = bare(ws[0]);
  if (!PRONOUN.has(first) && !DETERMINER.has(first) && !/^\p{Lu}[\p{L}\p{N}]*['’]s$/u.test(ws[0])) return null;
  // A pronoun's helping verb comes right after it: "it can …", not "it thinks should …".
  for (let k = 1; k < Math.min(ws.length, PRONOUN.has(first) ? 2 : 7); k++) {
    if (/[,;:]$/.test(ws[k - 1])) return null;
    const w = bare(ws[k]);
    if (!AUX.has(w)) continue;
    if (HAVE.has(w) && !PARTICIPLE.test(bare(ws[k + 1] ?? ""))) return null;
    const subject = ws.slice(0, k);
    const rest = ws.slice(k + 1);
    let aux = w;
    // The session ("it") asked about itself: "it can tell" → "can you tell", "it is busy" → "are you busy".
    const itself = k === 1 && (first === "it" || (plural && first === "they"));
    const expletive = first === "it" && (NOT_ITSELF_AFTER_MODAL.test(bare(rest[0] ?? "")) || (!MODAL.has(aux) && !ABOUT_ITSELF.test(bare(rest[0] ?? ""))));
    if (itself && !expletive) {
      subject[0] = "you";
      aux = YOU_AUX[aux] ?? aux;
      // "apart from its own" → "apart from your own"
      for (let j = 0; j < rest.length - 1; j++) if (bare(rest[j]) === "its" && bare(rest[j + 1]) === "own") rest[j] = rest[j].replace(/its/i, "your");
    } else if (first === "they" && plural && k === 1) {
      subject[0] = "you";
      aux = YOU_AUX[aux] ?? aux;
    } else subject[0] = uncap(subject[0]);
    return [cap(aux), ...subject, ...rest].join(" ");
  }
  return null;
}

/** "it needs", "it plans to": the session's verb, asked with "do": "do you need", "do you plan to". */
function withDo(clause: string): string | null {
  const ws = split(clause);
  if (ws.length < 2 || bare(ws[0]) !== "it" || !ASKED_VERBS.has(bare(ws[1]))) return null;
  return ["do", "you", ws[1].replace(/^[\p{L}']+/u, baseForm(bare(ws[1]))), ...ws.slice(2)].join(" ");
}

/**
 * "ask X whether/if <clause>": the yes-or-no question asked directly ("Is the new icon in the build
 * yet?", "Would it be possible to add a dark theme…?", "Can you keep Atlas's logs apart from your
 * own?"). The first sentence only; the rest goes as said. Null when there's no helping verb to move
 * ("the notarization went through"): not mechanical.
 */
export function yesNoQuestion(clause: string, plural = false): string | null {
  const { head, tail } = firstSentence(clause.trim());
  const body = head.replace(/[\s,;:.!?]+$/, "");
  const q = inverted(body, plural);
  if (!q) return null;
  return `${endWith(q, "?")}${tail}`;
}

/**
 * "ask X what/why/how … <clause>": the question asked directly. "what the test coverage is now" →
 * "What is the test coverage now?", "how it plans to handle refunds" → "How do you plan to handle
 * refunds?", "which screens are done" → "Which screens are done?", "what version we're on" → "What
 * version are we on?". Null when it isn't mechanical ("why handleWebhook throws": nothing to move).
 */
export function whQuestion(wh: string, clause: string, plural = false): string | null {
  const { head, tail } = firstSentence(clause.trim());
  const body = head.replace(/[\s,;:.!?]+$/, "");
  const ws = split(body);
  const w = lc(wh);
  // Already a question: "what do I need to do", "why does the checkout test fail".
  if (ws.length && (AUX.has(bare(ws[0])) || /^(?:do|does|did|don't|doesn't|didn't)$/.test(bare(ws[0])))) return `${endWith(`${cap(w)} ${body}`, "?")}${tail}`;
  // A pronoun subject (or "it" with its verb) within the question's first words: "what version we're on".
  for (let p = 0; p < Math.min(ws.length, 3); p++) {
    const word = bare(ws[p]);
    if (!PRONOUN.has(word) && !contraction(ws[p]) && !(plural && word === "they")) continue;
    const before = ws.slice(0, p);
    const rest = ws.slice(p).join(" ");
    const q = withDo(rest) ?? inverted(rest, plural) ?? (p === 0 && PRONOUN.has(word) && word !== "it" ? plainDo(rest, plural) : null);
    if (!q) return null;
    return `${endWith([cap(w) === w ? w : wh, ...before, uncap(q)].join(" "), "?")}${tail}`.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  // "what the HTTP status is when …": a noun phrase, then its helping verb.
  if (ws.length && DETERMINER.has(bare(ws[0]))) {
    const q = inverted(body, plural);
    if (!q) return null;
    return `${endWith(`${cap(w)} ${uncap(q)}`, "?")}${tail}`;
  }
  // "what happens when …", "which screens are done": the question word is the subject, or starts it.
  if (w === "what" || w === "which" || w === "who" || w === "whose") return `${endWith(`${cap(w)} ${body}`, "?")}${tail}`;
  return null;
}

/** "I need to do" → "do I need to do": a pronoun subject other than "it" with a plain verb (not one in the past). */
function plainDo(clause: string, plural: boolean): string | null {
  const ws = split(clause);
  if (ws.length < 2) return null;
  const verb = bare(ws[1]);
  if (AUX.has(verb) || /ed$/.test(verb) || PAST.has(verb) || verb.endsWith("s")) return null;
  const subject = plural && bare(ws[0]) === "they" ? "you" : ws[0] === "I" ? "I" : uncap(ws[0]);
  return ["do", subject, ...ws.slice(1)].join(" ");
}
const PAST = new Set("went did made got took gave ran wrote broke said told saw found built sent knew thought left kept meant brought chose began fell held paid lost".split(" "));

// ── Nothing made up ──────────────────────────────────────────────────────────────────────────
// "it's" as "it is", so "it's working" and "you are working" are the same words.
const expanded = (s: string) =>
  s
    .replace(/\b(it|that|there|what)['’]s\b/gi, "$1 is")
    .replace(/\b(we|you|they)['’]re\b/gi, "$1 are")
    .replace(/\bI['’]m\b/g, "I am");
const tokensOf = (s: string) =>
  [
    ...expanded(s)
      .toLowerCase()
      .matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu),
  ].map((m) => m[0].replace(/['’]/g, ""));
/** A word as compared: "needs" and "need", "it" and "you", "is" and "are" are the same word here. */
const SAME: Record<string, string> = {
  it: "you",
  its: "your",
  youre: "your",
  theyre: "your",
  their: "your",
  they: "you",
  is: "are",
  was: "were",
  has: "have",
  hasnt: "havent",
  isnt: "arent",
  wasnt: "werent",
  doesnt: "dont",
  does: "do",
  not: "dont",
};
const norm = (w: string) => SAME[w] ?? baseForm(w);

/**
 * Whether `result` is `original` less the `dropped` directions, its words only moved and turned
 * direct: every word said and not dropped is in it, and nothing's in it that wasn't said but the
 * small words direct speech adds (MAY_ADD). The safety check on everything above.
 */
export function keepsWords(original: string, result: string, dropped: string[] = []): boolean {
  const said = tokensOf(original).map(norm);
  const gone = dropped.flatMap(tokensOf).map(norm);
  const got = tokensOf(result).map(norm);
  const pool = new Map<string, number>();
  for (const w of got) pool.set(w, (pool.get(w) ?? 0) + 1);
  const left = [...said];
  for (const w of gone) {
    const i = left.indexOf(w);
    if (i >= 0) left.splice(i, 1);
  }
  for (const w of left) {
    const n = pool.get(w) ?? 0;
    if (n > 0) pool.set(w, n - 1);
    else if (!FILLER.has(w)) return false;
  }
  const saidSet = new Set(said);
  return got.every((w) => saidSet.has(w) || MAY_ADD.has(w) || MAY_ADD_NORM.has(w));
}
const FILLER = new Set("uh um umm uhm ah er erm hmm mm like".split(" "));
const MAY_ADD_NORM = new Set([...MAY_ADD].map(norm));
