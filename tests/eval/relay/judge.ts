// The relay eval's judge: Opus 5.5, given what the user said, the reference and what Kiko did and
// typed, says whether the outcome carries the same meaning and every action. A structured verdict:
// pass or fail, the aspect that failed, a short reason. calibration.ts holds hand-labelled outcomes
// to check it against (--calibrate).
import type { Reference } from "./checks.ts";
import { askOpus, describeMoment, type Effort } from "./opus.ts";

export const ASPECTS = [
  "none",
  "wrong-target",
  "not-sent",
  "sent-when-should-not",
  "direction-left",
  "kiko-words-left",
  "meaning-changed",
  "action-lost",
  "detail-lost",
  "negation-lost",
  "content-added",
  "reply-altered",
  "other",
] as const;
export type Aspect = (typeof ASPECTS)[number];
export type Verdict = { pass: boolean; aspect: Aspect; reason: string };

/** What Kiko did with the words, for the judge: each action, and the text of each message sent. */
export type Did = Array<{ action: string; to?: string; text?: string; via?: string }>;

export const JUDGE_SYSTEM = `You judge one moment of Kiko, a voice app for coding agents. The user spoke (speech-to-text wrote it, slips included); Kiko decided which of the open coding-agent sessions the words were for and typed a message into it, or did something else (answered, asked back, sent nothing).

What Kiko should do with words for a session: relay them the way a good human assistant would. Drop the direction (the parts that only say where the words go: "Ask MintBox,", "tell Bobby to", "this is for Atlas"); turn reported speech into direct speech ("Tell Bobby to restart the server" → "Restart the server."); leave out words meant for Kiko itself ("Kiko, slow down"); keep the meaning and every action exactly: every question, instruction, detail (paths, numbers, versions, names, commands, quotes), negation, limit, condition and order; add nothing. Another session named as content stays. Fillers and stutters may go or stay.

A reply to the session waiting for a reply (it just spoke and Kiko read it out) must arrive as said: no rewrite, no reframing. Leaving out fillers or the session's own name said up front ("Bobby, yes do it" → "Yes do it") is fine; any other change fails (reply-altered).

You get the reference, written ahead of time: the intent, the actions, the direction and Kiko's words to drop, the details, negations and conditions to keep, and an ideal message per session. The ideal shows one right answer, not the only one: a message worded differently passes when it carries the same meaning and every action, with the direction gone. Words as said, with the direction left in, fail (direction-left), even though the session could work out what was meant. So does any piece of it left behind: the session's own name up front ("MintBox, what do I …" from "Ask MintBox, what do I …") or a dangling "if"/"whether" from "ask X if …" (outside a reply to the waiting session, where the name may stay). The reference's notes say where a case is debatable; be fair there.

Judge the outcome as a whole:
- Sent to the wrong session, or to too few or too many: wrong-target. Not sent when it should have been: not-sent (asking back which session is fine only where the reference says it shouldn't be sent, or its notes say asking is fine). Sent when it shouldn't have been: sent-when-should-not.
- Then the message: direction-left, kiko-words-left, meaning-changed, action-lost, detail-lost, negation-lost, content-added, reply-altered, or other.
Pick the one aspect that matters most (none when it passes), and give a short reason naming what's wrong.`;

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "aspect", "reason"],
  properties: {
    pass: { type: "boolean" },
    aspect: { type: "string", enum: [...ASPECTS] },
    reason: { type: "string" },
  },
} as const;

/** What each of Kiko's actions means (tests/support/outcomes.ts), for the judge: which send words, which don't. */
const ACTION_MEANING: Record<string, string> = {
  send: "the user's words, as shown, typed into that session (or given as its reply)",
  ask: "a message Kiko wrote, as shown, typed into that session",
  resend: "the user's previous message sent again to that session",
  say: "Kiko said this out loud to the user; nothing sent to any session",
  ask_user: "Kiko asked the user this out loud; nothing sent to any session",
  more: "Kiko read out more of that session's last reply to the user; nothing sent to it",
  repeat: "Kiko read that session's last summary out loud again; nothing sent to it",
  stop: "Kiko interrupted that session's turn (Escape); no message sent",
  start: "Kiko started a new session, with the text shown as its first message",
  quick_task: "Kiko ran its own read-only check on the computer for the text shown; nothing sent to a session",
  refused: "Kiko said this isn't allowed by its settings; nothing sent",
  none: "Kiko did nothing",
};

/** What the judge reads: the moment, the reference and what Kiko did. */
export function judgePrompt(input: { moment: Parameters<typeof describeMoment>[0]; reference: Reference | null; did: Did }): string {
  const ref = input.reference;
  const reference = ref
    ? JSON.stringify(
        {
          intent: ref.intent,
          actions: ref.actions,
          direction: ref.direction,
          kikoParts: ref.kikoParts,
          mustKeep: ref.mustKeep,
          negations: ref.negations,
          conditions: ref.conditions,
          idealMessages: ref.messages,
          shouldBeSent: ref.messages.length > 0,
          isReply: ref.isReply,
          notes: ref.notes,
        },
        null,
        2,
      )
    : "(none: work out what should have happened yourself)";
  const did = input.did.length
    ? input.did
        .map((d) => {
          const what = ACTION_MEANING[d.action];
          return `- ${d.action}${d.to ? ` → ${d.to}` : ""}${d.via ? ` (${d.via})` : ""}${d.text !== undefined ? `: ${JSON.stringify(d.text)}` : ""}${what ? ` [${what}]` : ""}`;
        })
        .join("\n")
    : "- nothing";
  return `${describeMoment(input.moment)}\n<reference>\n${reference}\n</reference>\n<kiko_did>\n${did}\n</kiko_did>`;
}

export async function judge(input: Parameters<typeof judgePrompt>[0], effort: Effort) {
  return askOpus<Verdict>({ system: JUDGE_SYSTEM, user: judgePrompt(input), schema: JUDGE_SCHEMA, effort, maxTokens: 16000 });
}
