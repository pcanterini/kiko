// What you say right after a summary that says it fell short: "you missed…", "what about the
// tests?", a question back about the same reply, or "more". Logged as `summary_feedback` (with the
// reply's id, the summary you heard and your words), so each becomes a case for the summary eval
// (tests/eval/summary.ts: its case ids are replyIdOf the reply). Only logged: what the words do is
// decided as before ("more" is the app's, the rest go to the session as they always did).
import { createHash } from "node:crypto";

type FeedbackKind = "more" | "more_about" | "missed" | "what_about" | "follow_up";

// "You missed the part about…", "you didn't say whether…", "it left out…", "what did it leave out?"
const MISSED =
  /\b(?:you|it|the summary|that) (?:missed|left out|skipped|forgot|didn't (?:say|mention|tell me|read)|never (?:said|mentioned))\b|\bwhat did (?:you|it) (?:miss|leave out|skip)\b|\b(?:missed|left out) (?:a|the|one|something|some)\b/i;
const WHAT_ABOUT = /^\W*(?:(?:and|so|but|ok(?:ay)?|uh|um|wait|hmm|also)[\s,]+)*what about\b/i;
// A question back: a question word up front, or a "?" at the end.
const QUESTION =
  /\?\s*$|^\W*(?:(?:and|so|but|ok(?:ay)?|uh|um|wait|hmm|also)[\s,]+)*(?:what|what's|whats|why|how|when|where|which|who|is|are|was|were|does|did|do|can|could|should|would|will|has|have)\b/i;

/** What kind of feedback on the summary just heard your words are, or null when they're none. */
export function feedbackKind(text: string, more?: { topic: string | null } | null): FeedbackKind | null {
  if (more) return more.topic ? "more_about" : "more";
  if (MISSED.test(text)) return "missed";
  if (WHAT_ABOUT.test(text)) return "what_about";
  if (QUESTION.test(text.trim())) return "follow_up";
  return null;
}

/** A reply's id: the same for the same words, as the summary eval's case ids are. */
export const replyIdOf = (reply: string) => createHash("sha256").update(reply).digest("hex").slice(0, 12);

/** The `summary_feedback` log line's fields. */
export function feedbackEvent(input: { kind: FeedbackKind; sessionId: string; name: string; reply: string; summary: string; said: string; went: string[] }) {
  return {
    kind: input.kind,
    replyId: replyIdOf(input.reply),
    sessionId: input.sessionId,
    name: input.name,
    summary: input.summary,
    said: input.said,
    // What the app did with the words: "more", or "send" when they went to the session as a question.
    went: input.went,
  };
}
