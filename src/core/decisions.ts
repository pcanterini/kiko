// The decisions the classifier (classifier.ts) makes for the app, each as one request with several questions:
// your words on config.utteranceModel (d1-ultra), the rest on config.classifierModel (Jev).
import { config } from "./config.ts";
import { decide, picked, yes, type Answer, type Question } from "./classifier.ts";
import type { ReplyKind } from "./reply-shape.ts";
import { ago, APP_FOLDER, folderName, inScratch, sameName, sessionName, sessionNumber, spoken, type Session } from "./sessions.ts";
import { NAME } from "./name.ts";
import { flat } from "./text.ts";
import { tail } from "./timeline.ts";

/** A session for the classifier, with what it was last asked and said, and the topics it was asked about before. */
export type SessionInfo = { session: Session; asked: string; said: string; topics?: string[] };

export type UtteranceDecision = {
  /** The session your words are for, or "app" for the voice app itself. */
  audience: Session | "app";
  audienceConfidence: number;
  intent: "message" | "wrap_up" | "undo" | "repeat" | "redirect";
  intentConfidence: number;
  /** How likely the words also hold parts for the app ("for the in-app settings one"), not for Claude. */
  appParts: number;
  /**
   * How likely the words end by taking themselves back ("…actually, never mind"), so none of them
   * should go anywhere. Not the undo intent, which takes back what was sent before. Absent: not asked.
   */
  retracted?: number;
  /** The model that decided, as it names itself. */
  model: string;
  costUsd: number;
  ms: number;
};

/**
 * Who you're talking to and what kind of thing you said: words to pass on to a Claude session as
 * they are, something for the voice app to understand and act on, a wrap-up, taking back what you
 * just said, or saying it went to the wrong session.
 */
export async function decideUtterance(input: {
  text: string;
  sessions: SessionInfo[];
  waitingId: string | null;
  /** Read out moments ago, its reply window closed since, and nothing announced or sent after it. */
  justSpoke: { id: string; secondsAgo: number } | null;
  lastId: string | null;
  recent: string[];
}): Promise<UtteranceDecision> {
  const { text, sessions, waitingId, justSpoke, lastId, recent } = input;
  const handles = new Map(sessions.map((info, i) => [`s${i + 1}`, info]));
  const handleOf = (id: string | undefined) => [...handles].find(([, i]) => i.session.sessionId === id)?.[0];
  const spoke = handleOf(justSpoke?.id);
  const audience: Record<string, string> = {};
  for (const [handle, { session, asked, said, topics }] of handles) {
    const role =
      session.sessionId === waitingId
        ? " It just finished, spoke to the user, and is waiting for their reply."
        : handle === spoke
          ? ` It finished and spoke to the user ${justSpoke!.secondsAgo}s ago, the last thing they heard; it still takes their reply.`
          : session.sessionId === lastId
            ? " The user dealt with it last."
            : "";
    const name = sessionName(session);
    const folder = folderName(session.cwd);
    const title = session.title && !sameName(session.title, name) ? ` ("${session.title}")` : "";
    // Who named it is for the classifier only: it never speaks.
    const by = session.nameSetBy === "app" ? "a name the voice app gave it for the user" : "a name the user gave it";
    const where = inScratch(session.cwd)
      ? `"${name}" in the Claude desktop app${session.givenName ? ` (${by})` : ""}`
      : sessionNumber(session)
        ? `"${name}" in the ${folder} folder${title}${session.desktop ? ", in the Claude desktop app" : ""} (the app numbers sessions there to tell them apart: only "${spoken(name)}" names this one)`
        : sameName(name, folder)
          ? `in the ${folder} folder${title}${session.desktop ? ", in the Claude desktop app" : ""}`
          : `"${name}" (${by}${session.desktop ? ", in the Claude desktop app" : ""}) in the ${folder} folder${title}`;
    audience[handle] =
      `The Claude Code session ${where}, ` +
      `${session.status}, last active ${ago(session.lastActiveAt)}.${role} Last asked: ${flat(asked, 150) || "unknown"}. ` +
      `Last said: ${tail(said, 300) || "nothing yet"}. ` +
      (topics?.length ? `Asked before: ${topics.join("; ")}. ` : "") +
      "Pick it when the words are for that Claude to read and act on: a reply to it, or an instruction or question for it.";
  }
  audience.app =
    `The voice app itself (${NAME}), not any Claude session: the user asks about their sessions (which are running, what one ` +
    'is doing, or what one said, naming it in the third person: "what did clipkit say last time?"), asks the app to pass something on or ask a session something for them ("ask the other project ' +
    'what\'s next"), wants a session started, stopped or renamed ("rename this session to …"), or only checks that the app ' +
    'hears them or is there, with nothing else in their words ("can you hear me?", "are you there?", "did you get that?"), ' +
    "even right after talking to a session: only the app hears them. Words about the work that only use such words " +
    '("can you hear the audio in the video?", "testing the endpoint now") are for a Claude. ' +
    `Not feedback, bug reports or feature ideas, even about this voice app or "${NAME}": those are work for a Claude ` +
    `(the app's own code is in the ${APP_FOLDER} folder).`;

  const questions: Record<"audience" | "intent" | "app_parts" | "retracted", Question> = {
    audience: {
      type: "choice",
      instructions:
        "The user is working with several Claude Code sessions by voice. Who are their words meant for? " +
        (waitingId
          ? "A session just spoke and is waiting: if the words could be a reply to it, pick it. "
          : spoke
            ? "A session spoke to the user moments ago (session_that_just_spoke) and nothing happened since: if the words " +
              "could be a reply to it, pick it, over sessions from earlier in the conversation. "
            : "If the words answer what one session last said (it asked or offered something), pick that one. " +
              "Otherwise, when they could fit more than one, pick the one the user dealt with last, then the most recently active. ") +
        "Pick the app only when the user is clearly talking to the app about sessions, or checking it hears them, rather than to a Claude.",
      criteria: audience,
    },
    intent: {
      type: "choice",
      instructions: "What kind of thing did the user say?",
      criteria: {
        message:
          "Something to act on or answer: a request, a question, an answer to a question, or a decision. Also work that " +
          "undoes, moves or sends a named thing (undo the last commit, move the button to the left, send it to production), " +
          "and talk about phrases (support phrases like never mind).",
        wrap_up: "Only closes the exchange and asks for nothing: thanks, no thanks, that's all, I'll do it myself, all good.",
        undo:
          "Takes back what the user just said or sent: never mind, cancel that, undo that, scratch that, ignore that, " +
          "forget it, take that back, that's not for you. A bare \"undo that\" names nothing to undo, so it's this.",
        redirect:
          "Says their last message went to the wrong session and was meant for another: no, that was for clipkit; " +
          "that was supposed to go to atlas agents; I meant clipkit; sorry, that was for lacy; send that to clipkit " +
          "instead; move that to clipkit; actually, make that for clipkit; that wasn't meant for clipkit; oops, wrong one; not that one; " +
          "wrong session, send it to the other one.",
        repeat:
          "Asks the voice app to say its last spoken message again, word for word: repeat that, say that again, " +
          "what did you say, come again. Not a request for Claude to explain, redo or go over something.",
      },
    },
    app_parts: {
      type: "noul",
      instructions:
        "Besides what's meant for Claude, do the words include parts meant for the voice app: picking or naming " +
        "which session they're for, an aside to the app, or thinking out loud that isn't for Claude?",
      criteria: {
        true:
          'Part of it only tells the app where the words go or talks to the app: "for the in-app settings one", ' +
          '"this is for atlas agents", "tell the other one to", "the claude code speech one, please".',
        false: "All of it is for Claude to read: the request, question or reply, with any context, reasons, filler " + "words, or thinking out loud about the work, even about the voice app itself.",
      },
    },
    // Words that ended by taking themselves back ("… Actually, never mind.") were once typed into a
    // session. Only a check on the code's rule (decide.ts): words are dropped when both say so.
    retracted: {
      type: "noul",
      instructions:
        "Do the user's words end by cancelling themselves, so that nothing in them should be sent anywhere: " +
        'they start saying something, then give it up with "actually, never mind", "oh, forget it", "wait, scratch that"?',
      criteria: {
        true:
          'The user abandons what they were saying, often mid-sentence: "Can you check the… actually, never mind.", ' +
          '"So what about the — forget it.", "So just to check, if the build Actually, never mind."',
        false:
          "The words are meant to go even though they mention or end with such a phrase: talking about the phrase or " +
          'quoting it ("support phrases like never mind", "when someone says actually, never mind, catch it", "the ' +
          'button says never mind"); a new request after it ("never mind the tests, just deploy", "forget it, let\'s do ' +
          'option two"); telling a session to drop something ("tell Lacy to forget it", "ask it to scratch that last ' +
          'commit"); a condition ("if the build fails, never mind"); or a bare "never mind" with nothing before it.',
      },
    },
  };
  const state = {
    user_said: text,
    session_waiting_for_reply: handleOf(waitingId ?? undefined) ?? "none",
    ...(spoke ? { session_that_just_spoke: `${spoke} (${justSpoke!.secondsAgo}s ago; its reply window has closed)` } : {}),
    recent_conversation: recent,
  };
  // Shadowed (shadow.ts): which session each handle stood for, so the comparison can name them.
  const sessionsByHandle = Object.fromEntries([...handles].map(([h, i]) => [h, { name: sessionName(i.session), id: i.session.sessionId }]));
  const { answers, costUsd, ms, model } = await decide("utterance", state, questions, {
    model: config.utteranceModel,
    shadow: { handles: sessionsByHandle },
  });
  const who = picked(answers.audience);
  const intent = picked(answers.intent);
  return {
    audience: who.choice === "app" ? "app" : (handles.get(who.choice)?.session ?? "app"),
    audienceConfidence: who.confidence,
    intent: (["message", "wrap_up", "undo", "repeat", "redirect"].includes(intent.choice) ? intent.choice : "message") as UtteranceDecision["intent"],
    intentConfidence: intent.confidence,
    appParts: yes(answers.app_parts),
    retracted: yes(answers.retracted),
    model,
    costUsd,
    ms,
  };
}

export type StopDecision = { needsUser: number; worthSaying: number; costUsd: number; ms: number };

/**
 * Whether a finished turn is worth reading out, and whether its agent is waiting on the user.
 * `speaker`: who spoke in it (Agent.speaker: "Claude", the default, "Codex"; "" when it can't be
 * told). The state keeps `claude_reply` for every agent's reply (shadow-report.ts reads it).
 */
export async function decideStop(input: { claudeReply: string; context: string[]; speaker?: string }): Promise<StopDecision> {
  const who = input.speaker === undefined ? "Claude" : input.speaker.trim() || "the agent";
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  const { answers, costUsd, ms } = await decide(
    "stop",
    { claude_reply: flat(input.claudeReply, 3000), recent_conversation: input.context },
    {
      needs_user: {
        type: "noul",
        instructions: `Is ${who} asking the user something or waiting on their decision before it goes on?`,
        criteria: {
          true: `${Who} asks a question, offers choices, or needs approval or input.`,
          false: `${Who} reports, confirms or acknowledges; it needs nothing from the user.`,
        },
      },
      worth_saying: {
        type: "noul",
        instructions: "Would the user want to hear this reply read out to them?",
        criteria: {
          true: "It reports finished work, a result, a finding, a problem, or a question.",
          false: "It's only a pleasantry, a bare acknowledgment, or repeats what the user already knows.",
        },
      },
    },
    { shadow: {} },
  );
  return { needsUser: yes(answers.needs_user), worthSaying: yes(answers.worth_saying), costUsd, ms };
}

/** The classifier's read of what a reply is (replyKindQuestions): its kind, and how likely each must-keep thing is in it. */
type ReplyRead = {
  kind: ReplyKind;
  kindConfidence: number;
  failure: number;
  skipped: number;
  caveat: number;
  risk: number;
};

/**
 * What a finished turn's reply is, for the classifier: the same kinds and must-keep things as the code's read
 * (reply-shape.ts), asked of the classifier for the eval (tests/eval/summary.ts) to weigh one against the other.
 */
export function replyKindQuestions(speaker = "Claude") {
  const who = speaker.trim() || "the agent";
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  return {
    kind: {
      type: "choice",
      instructions: `What is ${who}'s reply, mainly? Pick the one the user most needs to hear about.`,
      criteria: {
        done: `${Who} only says it did what was asked, or acknowledges: short, nothing else to it.`,
        report: `${Who} reports work it did or what it found, and it all went fine.`,
        failure: `Something failed, is broken, blocked, or still doesn't work.`,
        decision: `${Who} asks the user to decide or answer something, or offers options.`,
        answer: `${Who} answers a question the user asked it.`,
        plan: `${Who} lays out a plan or a proposal: what it would do, not what it did.`,
      },
    },
    failure: {
      type: "noul",
      instructions: `Does ${who}'s reply say that something failed, is broken, or still doesn't work (failing tests included)?`,
      criteria: { true: "Something failed or still fails.", false: "Nothing failed, or it was fixed." },
    },
    skipped: {
      type: "noul",
      instructions: `Does ${who}'s reply say that something was skipped, left undone, or is still to do?`,
      criteria: { true: "Something was skipped or isn't done yet.", false: "Everything asked for was done." },
    },
    caveat: {
      type: "noul",
      instructions: `Does ${who}'s reply say that something is untested, unverified or uncertain?`,
      criteria: { true: "It couldn't verify, didn't test, or isn't sure about something.", false: "No caveats." },
    },
    risk: {
      type: "noul",
      instructions: `Did ${who} do, or does it propose, something risky or hard to undo (deleting data, force pushing, deploying, production)?`,
      criteria: { true: "Something risky or destructive was done or is proposed.", false: "Nothing risky." },
    },
  } satisfies Record<string, Question>;
}

const REPLY_KINDS: ReplyKind[] = ["done", "report", "failure", "decision", "answer", "plan"];

/** The classifier's answers to replyKindQuestions, read. */
export function replyReadOf(answers: Record<keyof ReturnType<typeof replyKindQuestions>, Answer>): ReplyRead {
  const kind = picked(answers.kind);
  return {
    kind: (REPLY_KINDS as string[]).includes(kind.choice) ? (kind.choice as ReplyKind) : "report",
    kindConfidence: kind.confidence,
    failure: yes(answers.failure),
    skipped: yes(answers.skipped),
    caveat: yes(answers.caveat),
    risk: yes(answers.risk),
  };
}

export type ApprovalDecision = {
  answer: "allow" | "allow_always" | "deny" | "repeat" | "unclear";
  confidence: number;
  costUsd: number;
  ms: number;
};

/** Your spoken answer to a permission prompt. */
export async function decideApproval(input: { request: string; text: string }): Promise<ApprovalDecision> {
  const { answers, costUsd, ms } = await decide(
    "approval",
    { claude_wants_to: input.request, user_said: input.text },
    {
      answer: {
        type: "choice",
        instructions: "Claude asked the user's permission to do something, and the user answered by voice. What did they answer?",
        criteria: {
          allow: "Yes, this once: yes, sure, go ahead, do it, allow it, okay.",
          allow_always: "Yes, and don't ask again for this kind of thing: always allow it, yes and don't ask again, allow all of these.",
          deny: "No, or no with a reason or an alternative: no, don't, stop, use pnpm instead, not that file.",
          repeat: "Asks the voice app to say the request again: repeat that, what was that, say it again.",
          unclear: "Anything else: a question about the request, or words that are neither yes nor no.",
        },
      },
    },
  );
  const a = picked(answers.answer);
  const valid = ["allow", "allow_always", "deny", "repeat", "unclear"];
  return {
    answer: (valid.includes(a.choice) ? a.choice : "unclear") as ApprovalDecision["answer"],
    confidence: a.confidence,
    costUsd,
    ms,
  };
}

/** Whether a tool call is risky enough to need an explicit "allow it". */
export async function decideRisk(input: { request: string }): Promise<{ risky: number; costUsd: number; ms: number }> {
  const { answers, costUsd, ms } = await decide(
    "risk",
    { claude_wants_to: input.request },
    {
      risky: {
        type: "noul",
        instructions: "Could this action do damage that's hard to undo, or reach outside the user's machine?",
        criteria: {
          true: "Deletes or overwrites data, force-pushes or pushes, deploys, sends messages, spends money, changes system settings, or runs something unknown from the internet.",
          false: "Reads, searches, builds, tests, or edits project files in a way git can undo.",
        },
      },
    },
  );
  return { risky: yes(answers.risky), costUsd, ms };
}

/**
 * The safety gate (core/guard.ts): what a tool call its rules couldn't place does, if it sends,
 * deletes, pays or posts. `none` must be fairly sure (GUARD_NONE_SURE) to let it run without asking;
 * otherwise the likeliest of the four is asked about.
 */
export async function decideGuardKind(input: { request: string }): Promise<{ kind: "sends" | "deletes" | "pays" | "posts" | null; confidence: number; costUsd: number; ms: number }> {
  const { answers, costUsd, ms } = await decide(
    "guard",
    { coding_agent_wants_to: input.request },
    {
      kind: {
        type: "choice",
        instructions: "A coding agent is about to run this on the user's computer. Which of these does it do, if any, judging from what's shown (a script's or a tool's name and its arguments)?",
        criteria: {
          sends: "Sends something to people or another server: an email, a chat or Slack message, a comment, a webhook, an HTTP request that changes something elsewhere.",
          deletes: "Deletes data that's hard to get back: files outside build output, database tables or rows, branches, cloud resources.",
          pays: "Spends money: a charge, a purchase, a subscription, a refund, registering a domain, a paid cloud resource.",
          posts: "Publishes or deploys: pushes code, releases, publishes a package, deploys a site or service, changes DNS or live settings, posts publicly.",
          none: "None of those: it reads, builds, tests, formats, or changes only local files.",
        },
      },
    },
  );
  const answer = answers.kind;
  const a = picked(answer);
  const kinds = ["sends", "deletes", "pays", "posts"] as const;
  if (a.choice === "none" && a.confidence >= GUARD_NONE_SURE) return { kind: null, confidence: a.confidence, costUsd, ms };
  // Not sure it's none: the likeliest of the four.
  const p = answer.type === "choice" ? answer.probabilities : {};
  const best = [...kinds].sort((x, y) => (p[y] ?? 0) - (p[x] ?? 0))[0];
  const kind = (kinds as readonly string[]).includes(a.choice) ? (a.choice as (typeof kinds)[number]) : best;
  return { kind, confidence: a.confidence, costUsd, ms };
}

/** How sure the classifier must be that an unclear call is none of the four for it to run without asking. */
export const GUARD_NONE_SURE = 0.7;

/**
 * A short plain description of a tool call, for prompts, logs and the screen: "run: npm test",
 * "edit app.ts". Plain text: a command's escape sequences (or any other control character, a
 * path's or a URL's) are spaces, so drawing it never sends them to a terminal.
 */
export function describeTool(name = "", input: Record<string, unknown> = {}) {
  return describing(name, input).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ");
}

// The most of a tool call's detail the phone is given (protocol permission_prompt `detail`).
export const DETAIL_MAX = 8000;

/**
 * A tool call in full, for where there's room to read it (the phone's request sheet): a command as
 * written, its lines kept; a file's or a page's whole path. Null where describeTool says it all, or
 * there's nothing more to it. Plain text: control characters other than line breaks and tabs are
 * spaces (bidi overrides too), and it's cut to DETAIL_MAX with "…".
 */
export function toolDetail(name = "", input: Record<string, unknown> = {}): string | null {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  let text = "";
  switch (name) {
    case "Bash":
      text = str("command");
      break;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
      text = str("file_path");
      break;
    case "WebFetch":
      text = str("url");
      break;
    case "Agent":
    case "Task":
      text = str("prompt") || str("description");
      break;
    default:
      return null;
  }
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .trim();
  if (!clean) return null;
  return clean.length > DETAIL_MAX ? `${clean.slice(0, DETAIL_MAX - 1)}…` : clean;
}

function describing(name: string, input: Record<string, unknown>) {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const base = (path: string) => path.split("/").pop() || path;
  switch (name) {
    case "Bash":
      return `run: ${flat(str("command"), 300)}`;
    case "Edit":
    case "MultiEdit":
      return `edit ${base(str("file_path"))}`;
    case "Write":
      return `write ${base(str("file_path"))}`;
    case "Read":
      return `read ${str("file_path")}`;
    case "WebFetch":
      return `fetch ${str("url")}`;
    case "WebSearch":
      return `search the web for "${str("query")}"`;
    case "Agent":
    case "Task":
      return `start a subagent: ${flat(str("description") || str("prompt"), 120)}`;
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      return mcp ? `use ${mcp[2]} from ${mcp[1]}` : `use ${name}`;
    }
  }
}
