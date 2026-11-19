// What a finished turn's reply is, read in code before its summary is asked for: what kind of reply
// it is (a plain "done", a failure, a decision for you, an answer to your question, a plan), which
// decides how much the summary says, and what in it the summary may never drop (MustKeep). Code, not
// a model: the summary streams into the voice, and anything it waits for comes before the first word
// (the classifier's read of the same, asked alongside for the log and the eval, takes ~0.37 s at the
// median). Before this, every summary had one fixed budget ("one or two
// sentences"), and a reply's failing tests, skipped step or "couldn't verify" were dropped as often
// as its steps were (the summary eval's cases: tests/eval/summary.ts).
import { SLUG } from "./name.ts";

/** What a reply is. A reply can be more than one: a failure that ends by asking what to do. */
export type ReplyKind = "done" | "report" | "failure" | "decision" | "answer" | "plan";

/** Something a summary must say: what needs you, what failed, what's risky, what wasn't done, a caveat. */
type MustKeep = { kind: "needs_you" | "failure" | "risk" | "skipped" | "caveat"; text: string };

type Shape = { kinds: ReplyKind[]; mustKeep: MustKeep[] };

// Most important first: the order they're listed in, and kept in when there are too many.
const ORDER: MustKeep["kind"][] = ["needs_you", "failure", "risk", "skipped", "caveat"];
// A sentence that reads as more than one is the most specific: "I couldn't verify it" is a caveat, not
// a failure; "2 tests still fail" a failure, not something left to do.
const CLASSIFY: MustKeep["kind"][] = ["needs_you", "caveat", "failure", "risk", "skipped"];
/** More than this, and the summary would be a list again: the most important are kept. */
const MAX_MUST_KEEP = 4;
const MAX_ITEM_CHARS = 220;

// Each kind's words, checked on about 1,600 real replies for what they'd catch: a word list wide
// enough to find "2 tests still fail" and "I couldn't run it on the phone", narrow enough that a plain report ("Fixed the crash and added a test.") finds nothing.
const MUST_KEEP: Record<MustKeep["kind"], RegExp> = {
  // Something you have to do or decide that isn't a question (the question itself is <x_asked>).
  needs_you: new RegExp(
    String.raw`\b(?:you(?:'ll| will)? need to|you have to|you'll have to|you must|needs? (?:your|you to)|waiting (?:on|for) (?:you|your)|your (?:approval|permission|ok|go-ahead|call)|(?:a |needs? a |requires? a )?restart (?:the app|${SLUG}|it|claude|the session)\b|(?:needs?|requires?) (?:a )?restart|before you (?:test|try|run|merge|restart)|(?:approve|allow) (?:it|the|this)\b)`,
    "i",
  ),
  failure:
    /\b(?:fail(?:s|ed|ing|ure|ures)?|errored|(?:an|the|this|that|same) error\b(?! (?:types?|handling|messages?|codes?))|errors? (?:when|on|in|from|with|at)\b|broken|breaks|crash(?:es|ed|ing)?|exception|regress(?:ion|ions|ed)|(?:does|did|do)(?:n't| not) work|not working|stopped working|timed? out|blocker|blocked|can't|cannot|couldn't|unable to|refused|rejected|denied|wrong|bug)\b/i,
  risk: /\b(?:force[- ]push(?:ed)?|reset --hard|rm -rf|irreversible|can(?:'t|not) be undone|wiped|(?:deleted|dropped|removed|overwrote|overwritten|erased|purged) (?:the |all |every |your |their |\d+ )?(?:\w+ )?(?:data|database|table|tables|branch|branches|files?|folders?|repo|repository|records|rows|users|history|keys?|keychain|logs|backups?|commits?|stash)|deployed|pushed (?:it |this |that )?(?:to|into) (?:main|master|prod|production)|production|ran (?:the )?migrations?|rewr(?:ote|itten) (?:the )?history|secrets?|credentials?)\b/i,
  skipped:
    /\b(?:skipped|skipping|left (?:it |that |this |them )?out|didn't (?:do|touch|change|get to|include|add|fix|merge|push|commit|finish|update)|not (?:done|yet|included|implemented|handled|covered|fixed|merged|pushed|committed)|haven't (?:done|started|merged|pushed|committed|fixed|finished|added|touched)|still (?:to do|todo|pending|open|need|needs|failing|fails|broken|missing|running|waiting)|remaining|todo|out of scope|deferred|postponed|parked|for later|follow-?up)\b/i,
  caveat:
    /\b(?:untested|not tested|haven't (?:tested|verified|checked|confirmed|run|tried)|didn't (?:test|verify|check|confirm|run|try)|couldn't (?:verify|test|check|confirm|reproduce|run|try)|can't (?:verify|tell|confirm|test)|not (?:verified|sure|confirmed|certain)|unverified|unclear|assum(?:e|ed|ing|ption)|guess|might not|may not|probably|caveat|heads[- ]up|warning|flaky|by hand|on the real|only (?:checked|tested|built) against|against a fake)\b/i,
};

// Words that look like one of the above but say all is well: "no errors", "all 312 tests pass",
// "fixed the crash", "0 failures". A sentence with only these is a plain report.
const ALL_WELL =
  /\b(?:no|zero|0|without|none of the)\s+(?:new\s+|more\s+|other\s+)?(?:failures?|errors?|failing|crash(?:es)?|regressions?|bugs?|warnings?)\b|\b(?:fixed|fixes|fixing|solved|resolved|handled|caught|guards? against|prevents?|no longer)\b|\ball\s+(?:\d[\d,]*\s+)?(?:\w+\s+)?(?:tests?|checks?)\s+pass|\b(?:pass(?:es|ed)?|green)\b(?![^.]*\b(?:but|except|apart from)\b)/i;
// Only the failure and skipped words are let off by these: "no errors" isn't a failure, but "it's
// fixed, though I couldn't verify it on the phone" is still a caveat.
const LET_OFF: MustKeep["kind"][] = ["failure", "skipped"];

// Fenced code, inline code and links aren't sentences: a "?" or "fail" in a regex or a URL isn't one.
const CODE = /```[\s\S]*?(?:```|$)/g;
const SENTENCE = /(?<=[.!?]["')’”*]*)\s+(?=[A-Z0-9"'(“*`])|\n+/;

/** The reply's sentences, code blocks left out and list markers and markdown taken off. */
function sentencesOf(reply: string): string[] {
  return reply
    .replace(CODE, "\n")
    .split(SENTENCE)
    .map((s) =>
      s
        .replace(/^\s*(?:[-*+•]|\d+[.)]|#+)\s+/, "")
        .replace(/\*\*|__/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((s) => /[a-z]/i.test(s));
}

/** What in a reply a summary must say (MUST_KEEP), most important first, MAX_MUST_KEEP at most. */
export function mustKeepOf(reply: string): MustKeep[] {
  const found: MustKeep[] = [];
  const seen = new Set<string>();
  for (const sentence of sentencesOf(reply)) {
    // Code and paths inside a sentence aren't what it says: "`fail()`" isn't a failure.
    const words = sentence.replace(/`[^`]*`|\bhttps?:\/\/\S+|(?:~|\.{0,2})\/\S+/g, " ");
    const kind = CLASSIFY.find((k) => MUST_KEEP[k].test(words) && !(LET_OFF.includes(k) && ALL_WELL.test(words) && !otherThanWell(k, words)));
    if (!kind) continue;
    const text = sentence.length > MAX_ITEM_CHARS ? `${sentence.slice(0, MAX_ITEM_CHARS)}…` : sentence;
    if (seen.has(text)) continue;
    seen.add(text);
    found.push({ kind, text });
  }
  // The most important kinds first; within a kind, the reply's order. Later sentences beat earlier
  // ones of the same kind: the end of a reply is where what's left ("2 tests still fail") usually is.
  const ranked = ORDER.flatMap((k) => {
    const of = found.filter((f) => f.kind === k);
    return of.length > 2 ? of.slice(-2) : of;
  });
  return ranked.slice(0, MAX_MUST_KEEP);
}

// "All tests pass, but 2 still fail on CI": the all-well words don't let off a sentence that says
// what's wrong after a "but".
function otherThanWell(kind: MustKeep["kind"], words: string) {
  const after = words
    .split(/\b(?:but|except|though|although|however|apart from)\b/i)
    .slice(1)
    .join(" ");
  return Boolean(after) && MUST_KEEP[kind].test(after);
}

// You asked something: a question, or "tell me", "explain", "what's", "how many".
const QUESTION =
  /\?\s*$|^\W*(?:(?:so|and|ok(?:ay)?|hey|uh|um|also|quick question|one (?:more|other) question)[\s,]+)*(?:what|what's|whats|why|how|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|should|would|will|have|has|tell me|explain|describe|check (?:if|whether)|find out)\b/i;
// A plan or a proposal: what it would do, not what it did.
const PLAN =
  /\b(?:(?:here's|here is|my|the) (?:plan|proposal|approach)|i (?:propose|suggest|recommend)|i'd (?:suggest|recommend|propose|start|go with|do)|i would|proposed|(?:the )?options? (?:are|is)|two (?:options|ways|approaches)|a few (?:options|ways|approaches)|would (?:look like|work like|need|mean)|we could)\b/i;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s/m;
/** Under this, with nothing to keep and nothing asked, a reply is a plain "done" (or a pleasantry). */
const DONE_CHARS = 280;

/**
 * What kind of reply it is, and what the summary must keep. `asked`: your words to the session this
 * turn (user_asked); `claudeAsked`: what the reply ends by asking you (summarizer.ts claudeAsked).
 */
export function shapeOf(reply: string, asked: string[] = [], claudeAsked: string | null = null): Shape {
  const mustKeep = mustKeepOf(reply);
  const kinds: ReplyKind[] = [];
  const text = reply.replace(CODE, " ");
  if (mustKeep.some((m) => m.kind === "failure")) kinds.push("failure");
  if (claudeAsked) kinds.push("decision");
  if (asked.some((a) => QUESTION.test(a.trim()))) kinds.push("answer");
  if (PLAN.test(text) && (LIST_ITEM.test(text) || text.length > 600)) kinds.push("plan");
  if (!kinds.length) kinds.push(reply.trim().length < DONE_CHARS && !mustKeep.length ? "done" : "report");
  return { kinds, mustKeep };
}

/**
 * A long reply cut to `max` characters, keeping what matters: its start, its end (where the outcome,
 * "2 tests still fail" and any question usually are), and every must-keep sentence from the middle
 * that fits. Before, the middle went whole, must-keep sentences with it.
 */
export function clipReply(reply: string, max: number): string {
  if (reply.length <= max) return reply;
  const head = Math.round(max * 0.3);
  const tail = Math.round(max * 0.45);
  const middle = reply.slice(head, reply.length - tail);
  const kept: string[] = [];
  let room = max - head - tail;
  for (const m of mustKeepOf(middle)) {
    const line = `… ${m.text}`;
    if (line.length + 1 > room) continue;
    kept.push(line);
    room -= line.length + 1;
  }
  return `${reply.slice(0, head)}\n${kept.length ? `${kept.join("\n")}\n` : ""}…\n${reply.slice(-tail)}`;
}
