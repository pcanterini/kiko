// Claude's multiple-choice questions (Claude Code's AskUserQuestion tool), answered by voice or on the
// phone. They reach the app as a permission prompt for that tool; its input has 1 to 4 questions,
// each with a header, the question, 2 to 4 options (label and description) and `multiSelect`, and
// Claude Code adds a free-text "Other" by itself. The answers go back through the same hook: allow,
// with the input given back plus `answers` (each question's text → the label picked, several joined
// with ", ", or the words said for "Other"), which Claude Code takes as the user's own answers
// (hooks/claude-code-hook.mjs builds that). Leaving it to the terminal is letting the hook go, as an
// unanswered permission prompt is.
//
// By voice, one question at a time: its header, the question, the options as a short numbered list
// (labels only, "recommended" said once), then the reply window. Your words are matched in code
// first (matchAnswer: "the first one", "number two", "yes, install it", "both"); else a quick model
// call (ask-model.ts), whose pick is checked here against the real options (fromModel). Words that
// match nothing are your own answer only when the model says they clearly are one; otherwise the app
// asks again, once, then leaves it at the Mac. "I'll answer at the Mac", "skip" leave it there too.
// `Asking` is the walk through the questions; app.ts speaks what it says and answers the hook.
import { isObject } from "./is-object.ts";
import { andList, flat } from "./text.ts";
import { tokens } from "./words.ts";

type AskOption = { label: string; description: string };
export type AskQuestion = { question: string; header: string; options: AskOption[]; multiSelect: boolean };

/** One question's answer: the options picked (their labels, exactly), and words of your own ("" for none). */
export type Answer = { labels: string[]; text: string };

/** What your words to a question came to. `picks`: option indexes. */
export type Match =
  | { kind: "pick"; picks: number[] }
  | { kind: "other"; text: string }
  /** "I'll answer at the Mac", "skip": left to the terminal. */
  | { kind: "mac" }
  | { kind: "repeat" }
  | { kind: "unclear" };

/** The tool whose permission prompt is a set of questions. */
export const ASK_TOOL = "AskUserQuestion";

/**
 * The questions in an AskUserQuestion input; null when they aren't readable (then the prompt is
 * left to the terminal): none, a question without text, an option without a label, or two
 * questions with the same text (the answers are keyed by it).
 */
export function readQuestions(input: unknown): AskQuestion[] | null {
  const list = isObject(input) ? input.questions : null;
  if (!Array.isArray(list) || !list.length || list.length > 8) return null;
  const out: AskQuestion[] = [];
  for (const q of list) {
    if (!isObject(q) || typeof q.question !== "string" || !q.question.trim()) return null;
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length > 8 || !options.every((o) => isObject(o) && typeof o.label === "string" && o.label.trim())) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      options: options.map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : "" })),
      multiSelect: q.multiSelect === true,
    });
  }
  return new Set(out.map((q) => q.question)).size === out.length ? out : null;
}

/** What the prompt wants, short, for the screen, the log and the phone ("wants to …"): "ask 3 questions: Install tmux, Your sessions, Overnight". */
export function askWhat(questions: AskQuestion[]) {
  const heads = questions.map((q) => q.header.trim() || flat(q.question, 60));
  return `ask ${questions.length === 1 ? "a question" : `${questions.length} questions`}: ${heads.join(", ")}`;
}

// ── Saying them ─────────────────────────────────────────────────────────────

const RECOMMENDED = /\s*\(recommended\)\s*/i;
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight"];

/** A label as said and shown short: no "(Recommended)", no code marks. */
export function plainLabel(label: string) {
  return unmark(label.replace(RECOMMENDED, " ")).replace(/\s+/g, " ").trim();
}

/** Markdown's marks out of what's said: `code`, **bold**, _emphasis_. */
function unmark(text: string) {
  return text
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The options as a short numbered list, labels only: "One: Yes, install it, recommended. Two: No, I'll install it." */
function spokenOptions(q: AskQuestion) {
  let recommended = false;
  return q.options
    .map((o, i) => {
      const says = !recommended && RECOMMENDED.test(o.label);
      recommended ||= says;
      return `${cap(NUMBER_WORDS[i] ?? String(i + 1))}: ${end(plainLabel(o.label) + (says ? ", recommended" : ""))}`;
    })
    .join(" ");
}

/**
 * One question as said: where it is among them (`at` of `of`), its header, the question, and the
 * options. A header the question already says isn't said twice.
 */
export function spokenQuestion(q: AskQuestion, at: number, of: number) {
  const place = of === 1 ? "" : at === 0 ? "First" : at === of - 1 ? "Last one" : "Next";
  const question = end(unmark(q.question));
  const header = unmark(q.header);
  const body = header && !question.toLowerCase().includes(header.toLowerCase()) ? `${header}: ${question}` : question;
  const how = !q.options.length ? "Say your answer." : q.multiSelect ? "Pick any." : "";
  return [cap(place ? `${place}, ${body}` : body), how, q.options.length ? spokenOptions(q) : ""].filter(Boolean).join(" ");
}

/** What was taken, said back: "Yes, install it", "tmux and nginx", or your own words. */
export function spokenAnswer(a: Answer) {
  const parts = [...a.labels.map((l) => plainLabel(l)), ...(a.text ? [a.text.trim()] : [])];
  return andList(parts);
}

// ── The answers, for the hook ───────────────────────────────────────────────

/**
 * Claude Code's form of the answers: each question's text → its answer as one string. Several
 * labels are joined with ", ", any holding ", " or a quote then written as a JSON string (as Claude
 * Code's own dialog does, so it reads them back as labels).
 */
export function answersFor(questions: AskQuestion[], answers: Answer[]): Record<string, string> {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    const parts = [...a.labels, ...(a.text.trim() ? [a.text.trim()] : [])];
    // One is as it is: Claude Code finds a label by the whole string first.
    out[q.question] = parts.length === 1 ? parts[0] : parts.map((p) => (p.includes(", ") || p.includes('"') ? JSON.stringify(p) : p)).join(", ");
  });
  return out;
}

/**
 * The phone's answers, checked against the questions: one per question, labels that are the
 * options' own (one at most unless it takes several), and something picked or said for each.
 * Null when they don't fit.
 */
export function checkAnswers(questions: AskQuestion[], answers: Array<{ labels?: string[]; text?: string }>): Answer[] | null {
  if (answers.length !== questions.length) return null;
  const out: Answer[] = [];
  for (const [i, q] of questions.entries()) {
    const labels = [...new Set(answers[i].labels ?? [])];
    const text = (answers[i].text ?? "").trim();
    const known = new Set(q.options.map((o) => o.label));
    if (!labels.every((l) => known.has(l))) return null;
    if (!labels.length && !text) return null;
    if (!q.multiSelect && labels.length + (text ? 1 : 0) > 1) return null;
    out.push({ labels: q.options.map((o) => o.label).filter((l) => labels.includes(l)), text });
  }
  return out;
}

// ── Your words, matched ─────────────────────────────────────────────────────

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5 };
const CARDINALS: Record<string, number> = { one: 0, "1": 0, two: 1, "2": 1, three: 2, "3": 2, four: 3, "4": 3, five: 4, "5": 4, six: 5, "6": 5 };
// After "number", "option", "choice": speech-to-text's "to", "too", "for" for two and four.
const AFTER_NUMBER: Record<string, number> = { ...CARDINALS, to: 1, too: 1, for: 3 };
// Words that say nothing about which option: what's left once they're out has to be in a label.
const FILLER = new Set(
  "a an and the to of on in it its is that this one ones option options choice please uh um ah er hmm ok okay so well lets let go with i id ill im want would like take pick choose choosing do just yeah yes yep sure".split(
    " ",
  ),
);
const LEAVE = [
  /\b(?:i'?ll|i will|let me|i'?d rather|i want to|i'?m going to|gonna)\s+(?:answer|do|pick|choose|handle|deal with|look at|see|type)\b.*\b(?:at|on|from|in)\s+(?:the\s+)?(?:mac|computer|terminal|keyboard|desk|screen|laptop)\b/i,
  /\b(?:answer|do)\s+(?:it|that|this|them|those)?\s*(?:at|on|from|in)\s+(?:the\s+)?(?:mac|computer|terminal|keyboard|desk|laptop)\b/i,
  /^\W*(?:(?:ok(?:ay)?|no|uh|um)[\s,]+)*(?:skip(?:\s+(?:it|that|this|them|those|these|the questions?|for now))?|leave (?:it|that|them)(?: for now| there)?|not now|later|i'?ll do it later|never ?mind|cancel(?: that)?)\W*$/i,
];
const AGAIN =
  /^\W*(?:(?:sorry|uh|um|what|huh|wait)[\s,?]*)*(?:repeat(?: (?:that|it|the (?:question|options|choices)))?|say (?:that|it|them) again|again|what (?:were|are) the (?:options|choices)|read (?:them|it|the (?:options|choices|question)) again|come again|pardon|what did you say)?\W*(?:please)?\W*$/i;
const YES = /^(?:yes|yeah|yep|yup|sure)$/;
const NO = /^(?:no|nope|nah)$/;
const ALL = /\b(?:all(?: of them| three| four)?|both(?: of them)?|every(?:thing| one of them))\b/i;

/**
 * Your words to question `q`, matched in code: leaving it to the Mac or asking again; a number, an
 * ordinal ("the second one", "number two", "the last one", "the recommended one"); a label's words
 * ("yes, install it"); "yes" or "no" when one label starts with it; "both" or "all" when it takes
 * several. `unclear` when code can't tell (the model's turn): nothing found, two options where it
 * takes one, or a "not" near a pick that isn't a label's own.
 */
export function matchAnswer(q: AskQuestion, text: string): Match {
  const words = tokens(text).map((t) => t.word);
  const n = q.options.length;
  // A label said whole is a pick even when it's "Skip" or "Later".
  const whole = n ? labelsIn(q, words, true) : [];
  if (whole.length === 1 || (q.multiSelect && whole.length > 1)) {
    const more = q.multiSelect ? [...new Set([...whole, ...numbersIn(words, n, q)])] : whole;
    return { kind: "pick", picks: more.sort((a, b) => a - b) };
  }
  if (LEAVE.some((re) => re.test(text))) return { kind: "mac" };
  if (!words.length) return { kind: "unclear" };
  if (AGAIN.test(text) && !words.every((w) => FILLER.has(w))) return { kind: "repeat" };
  // No options (only your own words): any real words are the answer.
  if (!n) return clearlyWords(text) ? { kind: "other", text: text.trim() } : { kind: "unclear" };
  const negated = words.some((w) => /^(?:not|dont|never|isnt|wont|without)$/.test(w));
  const numbers = numbersIn(words, n, q);
  const named = labelsIn(q, words, false);
  if (q.multiSelect && ALL.test(text) && !negated) return { kind: "pick", picks: q.options.map((_, i) => i) };
  const picks = [...new Set([...numbers, ...named])].sort((a, b) => a - b);
  if (negated && picks.length) return { kind: "unclear" };
  if (picks.length === 1 || (q.multiSelect && picks.length > 1)) return { kind: "pick", picks };
  if (picks.length > 1) return { kind: "unclear" };
  // "Yes." / "No." on their own: the one label that starts that way.
  const first = words.filter((w) => !FILLER.has(w) || YES.test(w));
  if (first.length === 1) {
    const starts = (re: RegExp) => q.options.flatMap((o, i) => (re.test(tokens(o.label)[0]?.word ?? "") ? [i] : []));
    const yes = YES.test(first[0]) ? starts(YES) : NO.test(first[0]) ? starts(NO) : [];
    if (yes.length === 1) return { kind: "pick", picks: yes };
  }
  return { kind: "unclear" };
}

/** Options named by number or ordinal: "the second one", "number two", "two", "the last one", "the recommended one". */
function numbersIn(words: string[], n: number, q: AskQuestion) {
  const out: number[] = [];
  const add = (i: number | undefined) => i !== undefined && i < n && !out.includes(i) && out.push(i);
  const lone = words.filter((w) => !FILLER.has(w) || w in CARDINALS);
  const recommended = q.options.findIndex((o) => RECOMMENDED.test(o.label));
  words.forEach((w, i) => {
    if (w in ORDINALS) add(ORDINALS[w]);
    if (w === "last" && words[i + 1] !== "night") add(n - 1);
    if (/^(?:number|option|choice)$/.test(w) && words[i + 1] in AFTER_NUMBER) add(AFTER_NUMBER[words[i + 1]]);
    if (/^(?:recommended|recommend|recommendation|suggested|suggestion)$/.test(w) && recommended >= 0) add(recommended);
  });
  // "Two." "One and three." Only number words with nothing else of note around them.
  if (lone.length && lone.every((w) => w in CARDINALS)) for (const w of lone) add(CARDINALS[w]);
  return out;
}

/**
 * Options whose label your words say: `whole`, all of its words in a row ("yes install it"); else
 * every word of yours that tells options apart is in its label and in no other, with its words
 * mostly said ("wrap claude" for "Wrap `claude` itself").
 */
function labelsIn(q: AskQuestion, words: string[], whole: boolean) {
  const labels = q.options.map((o) => tokens(plainLabel(o.label)).map((t) => t.word));
  if (whole) return labels.flatMap((l, i) => (l.length && runIn(words, l) ? [i] : []));
  const said = words.filter((w) => !FILLER.has(w) && !(w in ORDINALS) && !(w in CARDINALS));
  if (!said.length) return [];
  const found = labels.flatMap((l, i) => {
    const own = l.filter((w) => !FILLER.has(w));
    const hits = said.filter((w) => own.includes(w));
    return hits.length && hits.length === said.length && hits.length * 2 >= own.length ? [i] : [];
  });
  return found.length === 1 ? found : found.filter((i) => labels[i].every((w) => FILLER.has(w) || said.includes(w)));
}

function runIn(words: string[], run: string[]) {
  for (let i = 0; i + run.length <= words.length; i++) if (run.every((w, j) => words[i + j] === w)) return true;
  return false;
}

/** Words that can be your own answer: more than "yes", "no", "okay" or filler. */
function clearlyWords(text: string) {
  const words = tokens(text).map((t) => t.word);
  return words.some((w) => !FILLER.has(w) && !YES.test(w) && !NO.test(w));
}

/**
 * The model's line for question `q`, checked against it: option numbers in range (exactly one where
 * it takes one), OTHER only when your words can be an answer (they become it, as said), MAC, REPEAT.
 * Anything else is unclear.
 */
export function fromModel(q: AskQuestion, line: string, text: string): Match {
  const answer = line.trim().split("\n")[0].trim().replace(/[.!]$/, "");
  if (/^\d+(?:\s*,\s*\d+)*$/.test(answer)) {
    const picks = [...new Set(answer.split(",").map((s) => Number(s.trim()) - 1))].sort((a, b) => a - b);
    if (!picks.every((i) => i >= 0 && i < q.options.length)) return { kind: "unclear" };
    if (!q.multiSelect && picks.length !== 1) return { kind: "unclear" };
    return { kind: "pick", picks };
  }
  const word = answer.toUpperCase();
  if (word === "OTHER") return clearlyWords(text) ? { kind: "other", text: text.trim() } : { kind: "unclear" };
  if (word === "MAC") return { kind: "mac" };
  if (word === "REPEAT") return { kind: "repeat" };
  return { kind: "unclear" };
}

// ── The walk through them ───────────────────────────────────────────────────

/**
 * What to do with your words to the question being asked: `say` it (the next question, or asking
 * again), then answer the hook with all the answers (`done`), or leave it to the terminal (`leave`).
 */
export type Step = { say: string; done?: Answer[]; leave?: string };

/**
 * One prompt's questions, asked one at a time. `start()` is what's said first (`who`: the session,
 * as it's named), `take(match)` moves on from each answer. Asked again (a press put it back before
 * it was heard), it goes on from the question it was on.
 */
export class Asking {
  readonly questions: AskQuestion[];
  /** The question being asked. */
  at = 0;
  readonly answers: Answer[] = [];
  /** Asked again once already, after words it couldn't place. */
  private again = false;

  constructor(questions: AskQuestion[]) {
    this.questions = questions;
  }

  get current() {
    return this.questions[this.at];
  }

  /** What's said as it's asked (or asked again): who asks, how many, then the question it's on. */
  start(who: string) {
    const n = this.questions.length;
    const intro = this.at > 0 ? `${who}, still asking.` : `${who} ${n === 1 ? "asks" : `has ${n} questions`}.`;
    return `${intro} ${spokenQuestion(this.current, this.at, n)}`;
  }

  take(match: Match): Step {
    const q = this.current;
    switch (match.kind) {
      case "repeat":
        return { say: spokenQuestion(q, this.at, this.questions.length) };
      case "mac":
        return { say: "OK, it's waiting at the Mac.", leave: "left at the Mac" };
      case "unclear":
        if (this.again) return { say: "I'll leave that one at the Mac.", leave: "not understood twice" };
        this.again = true;
        return {
          say: q.options.length ? `Sorry, which one? Say a number, or your own answer. ${spokenOptions(q)}` : `Sorry, I didn't get that. ${end(unmark(q.question))}`,
        };
      case "pick":
      case "other": {
        const answer: Answer = match.kind === "pick" ? { labels: match.picks.map((i) => q.options[i].label), text: "" } : { labels: [], text: match.text };
        this.answers[this.at] = answer;
        this.again = false;
        const got = `Got it: ${end(spokenAnswer(answer))}`;
        this.at++;
        if (this.at < this.questions.length) return { say: `${got} ${spokenQuestion(this.current, this.at, this.questions.length)}` };
        return { say: got, done: this.answers };
      }
    }
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Ends with a full stop unless it ends a sentence already. */
const end = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
