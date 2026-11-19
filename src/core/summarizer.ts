import { anthropic, requestInfo } from "./anthropic.ts";
import { config } from "./config.ts";
import { cost, log, type TokenUsage } from "./log.ts";
import { NAME } from "./name.ts";
import { streamText } from "./openrouter-llm.ts";
import { clipReply, type ReplyKind } from "./reply-shape.ts";
import type { SummaryLength } from "./settings.ts";

/**
 * Whose session a summary is about: its agent ("Claude Code", "Codex") and who speaks in it, as the
 * summary says it ("Claude", "Codex"; "" when that can't be told, said as "it"). Claude Code's
 * unless told, in the words its summaries have always had.
 */
export type Voice = { agent: string; speaker: string };
export const CLAUDE_CODE_VOICE: Voice = { agent: "Claude Code", speaker: "Claude" };

/** The words a summary's instructions and input use for who spoke: its name, its possessive, and its tags' prefix ("claude_reply"). */
function wordsFor(voice: Voice) {
  const speaker = voice.speaker.trim();
  return {
    a: /^[aeiou]/i.test(voice.agent) ? "An" : "A",
    who: speaker || "it",
    Who: speaker || "It",
    whose: speaker ? `${speaker}'s` : "its",
    tag: speaker.toLowerCase().replace(/[^a-z0-9]+/g, "") || "agent",
    call: speaker ? `call ${voice.agent} "${speaker}"` : `call it "it", never by a name: you don't know which model it runs`,
  };
}

// Each Summary length (settings: brief, short, normal, detailed): how much a summary says, and the
// most it says when the reply has more that can't be left out. Normal and short are the two lengths
// there were before, word for word: the summaries were good enough as they were, so the levels are
// added around them. Checked on real replies (tests/eval/summary.ts).
// `keep`: one more line, to keep what the reply says still fails, wasn't done or wasn't checked
// (KEEP). Brief needs it most and detailed has room for it. Normal and short go without: with it,
// they kept 2 to 5 points more of what can't be left out (69 to 73% against 66 to 71%, three
// judged rounds), within what two runs of the same instructions differ by, for 3 to 5 more words.
// `last`: said again at the end of the message, where Haiku heeds it: told only in the instructions
// to say "a few words", it said 44 (the median, against normal's 50) on the eval's replies; with it, 26.
const LENGTHS: Record<SummaryLength, { sum: string; most: string; keep?: true; last?: string }> = {
  brief: {
    keep: true,
    sum: `Say only the outcome, in a few words, like "In Lacy, the tests pass." or "In ${NAME}, it's merged."`,
    most: "Two short sentences at most, counting any question: the second only for what can't be left out, in a few words, and a question in as few words as it takes.",
    last: "(Brief: one sentence of under 12 words after the session's name, only the outcome: no details, numbers or lists. A second sentence only for its question or for something that failed, in a few words. Nothing else.)",
  },
  short: { sum: "Sum up the reply in one short sentence, under 15 words", most: "Two short sentences at most, counting any question." },
  normal: { sum: "Sum up the reply in one or two short sentences", most: "Three sentences at most." },
  detailed: { sum: "Sum up the reply in two to four sentences, with its main points", most: "Five sentences at most.", keep: true },
};
const KEEP = "- Even when it's short, don't drop what the reply says still fails, wasn't done, or wasn't checked or tested: a few words each, and only what it says.\n";

// A function so a summary-length change in settings applies to the next summary. Who spoke is the
// session's agent's (wordsFor): a Codex turn is "Codex says", not "Claude says" ("In T3, Claude
// said hello world." was once said for a T3 Code thread on Codex). A joke keeps its own "I", and
// nothing asked isn't said: a joke Codex told as "I told my plant a joke…" was spoken as "you told your
// plant a joke… Codex didn't ask anything else."
const system = (voice: Voice = CLAUDE_CODE_VOICE) => {
  const w = wordsFor(voice);
  return `You are the voice of ${voice.agent}, a coding agent. ${w.a} ${voice.agent} session just finished a turn, and you tell the user out loud what it said and, when ${w.who} asked them something, ask it. The user answers by voice, and their answer goes straight to that session.

Each message has the session's name (the name the user gave it, else its folder, or its title for a session in the Claude desktop app with no folder of its own), the recent conversation with it, and ${w.whose} reply. When the user said something to the session during the turn (its first message, or words sent while ${w.who} was busy), the message has that too, oldest first (user_asked).

- ${LENGTHS[config.summaryLength].sum}: the outcome or the main finding, not the steps.
${LENGTHS[config.summaryLength].keep ? KEEP : ""}- When the user asked a question or asked for something in user_asked and the reply answers it, lead with the answer itself, right after the session's name, short: say the joke itself, give the number, say what it found. A joke, story, quote or anything else ${w.who} said in its own voice keeps its words: its "I" stays "I", never "you". Never only say that ${w.who} answered ("${w.Who} told a joke"). Then the reply's most important other point, briefly, within the same length. If the reply doesn't answer it, never make an answer up. Their asking is no reason to ask them anything: the question rules below still apply.
- After the summary, ask a short question only when ${w.who} asked one or offered choices: ${w.tag}_asked has what its reply ends by asking or offering. End with that, in your own words, plainly, as a question, like "Want it to commit that?" when ${w.who} asked whether to commit.
- ${w.Who} asking the user to do something later or if something happens isn't a question: say it as a statement, like "If something breaks, tell ${w.who} the step number.", or leave it out.
- When ${w.tag}_asked says nothing, ${w.who} asked nothing: don't ask or suggest anything, and don't say so either: never that ${w.who} asked nothing or has no questions. Never ask something ${w.who} didn't ask, and never turn what it said into a question. Earlier "app said" lines are past summaries, not a pattern to copy. If it says it'll tell you whether the app needs a restart, say that; don't ask "Want it to skip the restart?"
- Otherwise the summary is all you say, like "In atlas agents, ${w.who} says the tests are still running and it'll tell you when they're done." The user hears a question as their cue to answer, so a summary on its own is complete.
- If ${w.whose} reply only acknowledges or wraps up (like "Got it" or "Sounds good"), just say it in a few words, with no question.
- If told to name the session, start with its name said as words, like "In atlas agents, ..." for a folder, or "In cloud speech, ..." or "In the 2 plus 2 session, ..." for a session with a name of its own. Use that name, never another.
- Bring up earlier requests only when ${w.whose} reply is about them. The conversation may be old.

Speech rules: everything you write is spoken. Talk to the user as "you" and ${w.call}. ${LENGTHS[config.summaryLength].most} No markdown, lists, code or symbols. Never read code, long paths, IDs or command output word for word. Where a plain word works, use it instead of a file name or code name: "the settings screen", not "settings.ts".`;
};

const PERMISSION_SYSTEM = `You are the voice of Claude Code. A Claude Code session wants permission to use a tool, and you ask the user out loud. Everything you write is spoken.

Say in one short sentence what it wants to do, in plain words, then ask "Allow?". For example: "Atlas agents wants to run the test suite with npm. Allow?" or "It wants to delete the node modules folder. Allow?"
- If told to name the session, start with its name said as words ("atlas agents wants to..." for a folder, "Cloud speech wants to..." or "The 2 plus 2 session wants to..." for a session with a name of its own); otherwise say "It wants to...".
- Describe what a command does rather than reading it: no flags, no long paths, no code. Say file names without their folders.
- If it would delete, overwrite, push, deploy, or touch something outside the project, say so plainly.
- No markdown or symbols.`;

const ANSWER_SYSTEM = `You are the voice of an app on the user's computer. They asked something out loud, Claude Code looked it up on their computer, and you tell them the answer. Everything you write is spoken.

- Answer what they asked in one or two short sentences, with only the facts that answer it. Round numbers and say units as words, like "about 311 gigabytes free".
- Say the figures you're given as they are: don't work out new ones, check them against each other or correct yourself.
- Never read command output, paths, process IDs or code word for word; name a program or folder plainly.
- If something couldn't be checked, say what, briefly.
- No markdown, lists or symbols, and no closing remark or offer to help more.`;

// Catch me up on the phone (src/remote/catch-up.ts): the updates it missed, as one short summary.
// Its own prompt, apart from the announcement's: the input is already spoken summaries.
const CATCH_UP_SYSTEM = `You are the voice of Claude Code. The user stepped away from their coding sessions and is back. You get the updates they missed, oldest first: what a session said when it finished a turn, a session asking permission to do something, or the app's own answer to something they asked. Catch them up out loud in one short summary. Everything you write is spoken.

- Start with "While you were away:", then go session by session, each session once, by its name as given, in the order they first come up: what it got done, in a few words, and whether it's waiting for them (it asked them something, or wants permission for something).
- A later update about a session replaces what an earlier one said about the same thing: say where it ended up, not each step.
- Two to four short sentences in all, however many updates there are. Leave out steps, numbers, file names and details.
- Don't ask their questions for them or tell the user how to answer; say who is waiting for them, and for what.
- No markdown, lists, symbols, code, paths or IDs.

For example: "While you were away: Lacy finished the migration and is waiting for you; ${NAME} merged two fixes and asked you to restart."`;
// Two to four short sentences fit in well under this; it's the hard stop if the model runs on.
const CATCH_UP_MAX_TOKENS = 200;

/** One update the phone missed, as the catch-up summary is given it: `name` said as words, null for the app's own. */
export type CatchUpUpdate = { name: string | null; kind: "announcement" | "permission" | "answer"; text: string; at: number };

const CATCH_UP_KINDS: Record<CatchUpUpdate["kind"], string> = {
  announcement: "finished a turn",
  permission: "asks permission",
  answer: "the app's answer",
};

/** The catch-up summary's input: each update, oldest first, with its session, what it is and how long ago. */
export function catchUpPrompt(updates: CatchUpUpdate[], now = Date.now()) {
  const lines = updates.map((u) => {
    const minutes = Math.max(0, Math.round((now - u.at) / 60_000));
    const session = u.name ? ` session="${u.name.replace(/"/g, "'")}"` : "";
    return `<update${session} kind="${CATCH_UP_KINDS[u.kind]}" minutes_ago="${minutes}">${clip(u.text)}</update>`;
  });
  return `<updates>\n${lines.join("\n")}\n</updates>`;
}

const MAX_INPUT_CHARS = 6000;

const named = (s: { name: string; titled?: boolean }) => (s.titled ? `<session_name>${s.name}</session_name>` : `<folder>${s.name}</folder>`);

export type Turn = {
  name: string; // what the session is called (sessions.ts sessionName)
  titled?: boolean; // that name is its own, not its folder
  nameSession: boolean;
  context: string[]; // recent conversation with this session, oldest first
  asked?: string[]; // your words to it during this turn, oldest first (Held.saidThisTurn)
  claudeReply: string; // what the session said (whichever agent's)
  voice?: Voice; // its agent and who speaks in it (Claude Code's when left out)
  // The classifier's needs_user for this turn (decideStop), null without it: an offer with no "?" waits for it (claudeAsked).
  needsUser?: Promise<number | null>;
  // What the reply was read as, given to the summary as hints: only the summary eval's variants do
  // (tests/eval/summary.ts new-code, new-jev); the app's summary reads the reply alone.
  shape?: { kinds?: ReplyKind[]; mustKeep?: string[] };
};

/** Hints of what a reply is, saying what they are, in the message: the instructions stay as they are (and cached). */
const shapeHints = (shape: NonNullable<Turn["shape"]>) =>
  `<hints>Read before you got it, maybe wrong (the reply decides): ${shape.kinds?.length ? `it's ${shape.kinds.join(", ")}` : "no kind"}${shape.mustKeep?.length ? `; may be among what's never left out:\n${shape.mustKeep.join("\n")}` : ""}</hints>`;

/** What "more" (or "more about the tests") elaborates on: a reply already summed up, and what was heard of it. */
type MoreOf = {
  name: string;
  titled?: boolean;
  claudeReply: string;
  heard: string; // the summary the user heard of it
  topic?: string | null; // what they want more about, in their words; none: the whole reply
  asked?: string[]; // your words to the session that turn (user_asked)
  voice?: Voice;
};

// "More" is a longer summary of the same reply, not the reply word for word (a choice made on
// purpose): what can't be left out, then what the short one left out. Told only to add what the
// summary left out, it dropped the restart or the question the user had just heard, and filled in
// with reasons the reply never gave (tests/eval/summary.ts, the first "more" round: 17 of 43 judged
// right). "More about the failing tests" is close to all the reply says about that, still spoken.
// Either way a colleague talking, not a report, and nothing the reply doesn't say: a topic it doesn't
// cover gets one sentence saying so (MORE_NOTHING), never an answer made up.
const moreSystem = (voice: Voice, topic: boolean) => {
  const w = wordsFor(voice);
  const short = config.summaryLength === "short" || config.summaryLength === "brief";
  const what = topic
    ? `They asked about one part of it (about, in their words). Tell them close to everything the reply says about that, in depth: what, why, the numbers and names, said plainly. Don't sum it up away, and leave out the rest of the reply. ${short ? "Five" : "Eight"} sentences at most. If the reply says nothing about it, say only "${MORE_NOTHING("<what they asked about>")}" with their words for it, and nothing else: never make anything up.`
    : `Give them a longer summary of the same reply: what matters most first, with anything ${w.who} needs from them, what failed or still fails, anything risky, what it skipped or didn't do and its caveats, then the main points the short summary (heard) left out. What they heard can come back in a few words where the rest needs it, but most of what you say should be new to them. Never mention a summary or what it left out: just tell it. ${short ? "Three or four" : "Four to six"} sentences at most: they can read the whole reply on screen, so pick what's worth hearing.`;
  return `You are the voice of ${voice.agent}, a coding agent. You just told the user out loud, in a short summary, what ${w.who} said when a session finished a turn, and they asked to hear more of it. ${what}

- Talk the way you'd explain it to a colleague: natural and easy to follow, not a report or a list. They can read the whole reply on screen, so this is for listening.
- Only what the reply says: no reasons, causes, risks or numbers it doesn't give, and nothing it says turned around.
- When ${w.tag}_asked says what the reply ends by asking, end with that question, briefly, in your own words. Otherwise ask nothing, and don't say that ${w.who} asked nothing.
- Start straight in, without the session's name and without "Sure" or "Here's more".

Speech rules: everything you write is spoken. Talk to the user as "you" and ${w.call}; you aren't ${w.who}, so never "I" for what it did. No markdown, lists, code or symbols. Never read code, commands, long paths, links, IDs, times or command output word for word; say what a file or a function is for, in plain words, instead of its name.`;
};

/** What "more about <topic>" says when the reply doesn't cover it. */
const MORE_NOTHING = (topic: string) => `It didn't say anything about ${topic}.`;
// "More" reads further into a long reply than its summary did.
const MORE_INPUT_CHARS = 12_000;
/**
 * A stream that sends nothing for this long (no first words, or none since the last) is given up
 * on, as an error: the floor and the sessions queued behind it are let go, rather than waiting for
 * fetch's own timeout (minutes) or a key press.
 */
const STALL_MS = 20_000;

/** Haiku (or the OpenRouter model picked in settings) turns what a session said into a short spoken summary. Stateless. */
export class Summarizer {
  private client = anthropic();
  private abort: AbortController | null = null;
  private cancels = 0; // cancel()s so far, for one that comes while a summary waits for the classifier
  private readonly stallMs: number;

  /** `stallMs`: STALL_MS, unless a test has its own. */
  constructor(o: { stallMs?: number } = {}) {
    this.stallMs = o.stallMs ?? STALL_MS;
  }

  /** Streams the spoken text to onText. Returns it with token usage, or null if cancelled. */
  async summarize(turn: Turn, onText: (delta: string) => void) {
    // What the reply ends by asking (claudeAsked), so the summary's question is Claude's own, or there's none. An offer
    // with no "?" only counts if the classifier agrees the session is waiting on you: "If any step fails,
    // just tell me its number." (needs_user 0.16) became a question of its own. The classifier runs alongside, and the
    // summary isn't heard before it answers anyway, so only such an offer waits for it.
    const ask = endingAsk(turn.claudeReply);
    let needsUser: number | null = null;
    if (ask && !ask.question && turn.needsUser) {
      const cancels = this.cancels;
      needsUser = await turn.needsUser;
      if (cancels !== this.cancels) return null;
      log("summary_offer", { offer: ask.text, needsUser, asked: needsUser === null || needsUser >= OFFER_NEEDS_USER });
    }
    const asked = claudeAsked(turn.claudeReply, needsUser);
    const voice = turn.voice ?? CLAUDE_CODE_VOICE;
    // Tagged by who spoke, as the instructions name them: <claude_reply> for Claude Code, <codex_reply>, <agent_reply> when it can't be told.
    const { tag } = wordsFor(voice);
    const prompt = [
      `${named(turn)}${turn.nameSession ? " (name the session)" : ""}`,
      `<recent_conversation>\n${turn.context.join("\n") || "(unknown)"}\n</recent_conversation>`,
      ...(turn.asked?.length ? [`<user_asked>\n${turn.asked.join("\n")}\n</user_asked>`] : []),
      `<${tag}_reply>${clipReply(turn.claudeReply, MAX_INPUT_CHARS) || "(no text)"}</${tag}_reply>`,
      `<${tag}_asked>${asked ?? "nothing"}</${tag}_asked>`,
      ...(turn.shape ? [shapeHints(turn.shape)] : []),
      ...(LENGTHS[config.summaryLength].last ? [LENGTHS[config.summaryLength].last!] : []),
    ].join("\n");
    return this.speak("summary", system(voice), prompt, onText, { asks: asked !== null, who: agentNames(voice, turn.name) });
  }

  /**
   * "More", "tell me more about the failing tests": a longer summary of a reply already summed up,
   * or all it says about `topic`. Streams like a summary; returns it, or null if cancelled.
   */
  more(of: MoreOf, onText: (delta: string) => void) {
    const voice = of.voice ?? CLAUDE_CODE_VOICE;
    const { tag } = wordsFor(voice);
    const asked = claudeAsked(of.claudeReply);
    const topic = of.topic?.trim() || null;
    const prompt = [
      named(of),
      ...(of.asked?.length ? [`<user_asked>\n${of.asked.join("\n")}\n</user_asked>`] : []),
      `<${tag}_reply>${clipReply(of.claudeReply, MORE_INPUT_CHARS) || "(no text)"}</${tag}_reply>`,
      `<${tag}_asked>${asked ?? "nothing"}</${tag}_asked>`,
      `<heard>${of.heard}</heard>`,
      ...(topic ? [`<about>${topic}</about>`] : []),
    ].join("\n");
    return this.speak(topic ? "more_about" : "more", moreSystem(voice, Boolean(topic)), prompt, onText, { asks: asked !== null, who: agentNames(voice, of.name) }, topic ? 600 : 450);
  }

  /** "Atlas agents wants to run the tests. Allow?" for a permission prompt. */
  describePermission(request: { name: string; titled?: boolean; nameSession: boolean; tool: string; input: unknown }, onText: (delta: string) => void) {
    const prompt = [
      `${named(request)}${request.nameSession ? " (name the session)" : ""}`,
      `<tool>${request.tool}</tool>`,
      `<input>${clip(JSON.stringify(request.input ?? {}, null, 1))}</input>`,
    ].join("\n");
    return this.speak("permission", PERMISSION_SYSTEM, prompt, onText);
  }

  /** What a quick task (quick-task.ts) found, as the answer to what you asked. */
  answer(found: { question: string; found: string }, onText: (delta: string) => void) {
    const prompt = `<asked>${found.question}</asked>\n<found>${clip(found.found) || "(nothing)"}</found>`;
    return this.speak("quick_answer", ANSWER_SYSTEM, prompt, onText);
  }

  /** "While you were away: Lacy finished the migration and is waiting for you; …" for the phone's Catch me up. */
  catchUp(updates: CatchUpUpdate[], onText: (delta: string) => void) {
    return this.speak("catch_up_summary", CATCH_UP_SYSTEM, catchUpPrompt(updates), onText, null, CATCH_UP_MAX_TOKENS);
  }

  /** `trim`: a summary, trimmed as it streams (dropClosingRemark); `asks`: Claude's reply asked or offered something; `who`: agentNames. */
  private async speak(
    what: string,
    system: string,
    prompt: string,
    onText: (delta: string) => void,
    trim: { asks: boolean; who: string[] } | null = null,
    maxTokens = 300,
  ): Promise<{ text: string; usage: TokenUsage; costUsd: number } | null> {
    const abort = new AbortController();
    this.abort = abort;
    const signal = abort.signal;
    const out = trim ? dropClosingRemark(onText, trim.asks, trim.who) : null;
    // Words keep coming, or it's given up on (STALL_MS): the timer starts again with each.
    let stalled = false;
    let stall: NodeJS.Timeout | undefined;
    const watch = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, this.stallMs);
      stall.unref?.();
    };
    watch();
    const push = (delta: string) => {
      watch();
      (out ? out.push : onText)(delta);
    };
    // Only the summary's instructions (~840 tokens) clear the model's 512-token minimum for prompt
    // caching; the permission and answer ones are too short to cache.
    const cache = what === "summary";
    const start = performance.now();
    const ms = () => Math.round(performance.now() - start);
    try {
      // An OpenRouter model when one is picked in settings; Haiku through the Anthropic API otherwise.
      if (config.llm !== "haiku") {
        const r = await streamText({ model: config.llm, system, prompt, maxTokens, cache, signal, onText: push, call: "summary", what });
        const { text, dropped } = out ? out.end() : { text: r.text, dropped: undefined };
        log(what, { model: config.llm, prompt, text, dropped, usage: r.usage, costUsd: r.costUsd, stop: r.stop, ms: ms(), requestId: r.id });
        return { ...r, text };
      }
      let spoken = "";
      const stream = this.client.messages.stream(
        {
          model: config.summaryModel,
          max_tokens: maxTokens,
          // Latency over depth: no thinking, low effort.
          thinking: { type: "disabled" },
          output_config: { effort: config.summaryEffort },
          system: cache ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      );
      stream.on("text", (delta) => {
        spoken += delta;
        push(delta);
      });
      const final = await stream.finalMessage();
      const { text, dropped } = out ? out.end() : { text: spoken, dropped: undefined };
      // The time to first words is on the announce line (firstTokenMs); this is the whole request.
      log(what, { prompt, text, dropped, usage: final.usage, stop: final.stop_reason, ms: ms(), ...requestInfo(stream.response) });
      return { text, usage: final.usage, costUsd: cost.haiku(final.usage) };
    } catch (err) {
      if (stalled) {
        log("summary_stalled", { what, ms: ms(), stallMs: this.stallMs });
        throw new Error(`The ${what === "summary" ? "summary" : "answer"} stopped coming (nothing for ${Math.round(this.stallMs / 1000)} s), so it was given up on.`);
      }
      if (signal.aborted) return null;
      throw err;
    } finally {
      clearTimeout(stall);
      if (this.abort === abort) this.abort = null;
    }
  }

  cancel() {
    this.cancels++;
    this.abort?.abort();
  }
}

// Long input other than a reply (a reply is clipReply's, which keeps what it must say): the start
// and the end, where the outcome and any question usually are.
function clip(text: string) {
  if (text.length <= MAX_INPUT_CHARS) return text;
  const half = MAX_INPUT_CHARS / 2;
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

// A last sentence about the summary itself instead of the work: "No question needed here, since you've
// said you'll restart.", "Nothing else needs your input right now." The prompt asks for none, but Haiku
// still adds one now and then, and once spoken it's in the next summary's context, where it gets copied.
// The text goes straight to speech, so only a later sentence that starts like one (STARTS) is held, and
// only until it ends and something follows it: the last one is dropped if it says what META does.
const STARTS = [
  "no ",
  "nothing ",
  "nothing's",
  "there's no",
  "there is no",
  "there's nothing",
  "there is nothing",
  "since ",
  "so ",
  "that's a quick",
  "that's a simple",
  "that was a",
  "that's all",
  "that's it",
  "that wraps",
  "you don't need",
  "it's just",
  "it's not",
  "it isn't",
];
const META = [
  /\bno (?:clear |obvious |further |more |real )?(?:follow[- ]?up )?(?:questions?|follow[- ]?ups?|next steps?)\b/,
  /\bnothing (?:else |more |further )?(?:is |was )?(?:needed|pending|required|to (?:ask|do|add|act on|follow up|answer))\b/,
  /\bnothing (?:else |more |further )?(?:needs|requires)\b/,
  /\bnothing (?:else |more |further )?(?:it|claude)(?:'s| is)? (?:asking|asked|waiting|needs|wants)\b/,
  /\b(?:needs?|needed|required|wanted) from you\b/,
  /\bno (?:further )?(?:action|input|reply|answer) (?:is )?needed\b/,
  // The rule to keep what wasn't done, echoed when nothing was: "Nothing is left unfinished in that list." (seen in the summary eval).
  /\bnothing (?:else )?(?:is |was |'s )?(?:left )?(?:unfinished|undone|open|outstanding|waiting on (?:you|your))\b/,
  /\bwraps? (?:it|this|things) up\b/,
  /^(?:so )?that's (?:all|it)\b/,
  /\byou don't need to do anything\b/,
  /\b(?:not|isn't) asking (?:you |for )?(?:anything|for anything)\b/,
];

// The same remark led by who spoke, as the prompt's "<codex_asked>nothing" puts it: "Codex didn't ask anything
// else.", "Claude hasn't asked you anything.", "Claude asked nothing, so there's nothing else
// to answer.". Only a sentence that's all remark, start to end (nothingAsked), is dropped;
// what it did is kept: "Codex didn't touch the tests.", "It didn't ask before deleting it.", "Claude says it will
// tell you when it's ready, and it hasn't asked you anything.", "It needs nothing from you; once it's done, …".
// Held only from words that can start one (AGENT_STARTS), so other sentences about it still stream as they come.
const NOT = String.raw`(?:didn't|did not|hasn't|has not|doesn't|does not|isn't|is not|wasn't|was not)`;
const ANY_QUESTION = String.raw`any(?: other| more| further| new| follow[- ]?up)? questions?`;
const NOTHING_ASKED = [
  String.raw`${NOT} (?:ask|asked|asking)(?: you| of you)? (?:anything|for anything|you for anything|${ANY_QUESTION}|a(?: single| follow[- ]?up)? question)`,
  String.raw`${NOT} (?:have|raise|pose) ${ANY_QUESTION}`,
  String.raw`(?:asked|asks|is asking|has asked)(?: you)? nothing`,
  String.raw`(?:has|had) no(?: other| more| further| new| follow[- ]?up)? questions?`,
  String.raw`(?:has|had) nothing(?: else| more| further)? to ask(?: you)?`,
  String.raw`(?:needs|wants|needed|wanted) nothing(?: else| more| further)? from you`,
  String.raw`${NOT} (?:need|want) anything(?: else| more| further)? from you`,
].join("|");
const NOTHING_ASKED_END = String.raw`(?: else| more| further)?(?: (?:from|of|for) you)?(?: (?:right now|for now|at the moment|this time|here|yet|in (?:its|this|that|the) reply))?(?:,? so (?:there's|there is) nothing(?: else| more)?(?: for you)? to (?:answer|do|reply to|respond to))?[.!]*$`;
const AGENT_STARTS = [
  "didn't",
  "did not",
  "hasn't",
  "has not",
  "doesn't",
  "does not",
  "isn't",
  "is not",
  "wasn't",
  "was not",
  "asked nothing",
  "asked you nothing",
  "asks nothing",
  "asks you nothing",
  "is asking nothing",
  "has asked",
  "has no ",
  "had no ",
  "has nothing",
  "had nothing",
  "needs nothing",
  "wants nothing",
  "needed nothing",
  "wanted nothing",
].flatMap((s) => [s, `also ${s}`, `otherwise ${s}`]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a summary can call who spoke, lower case, at the start of a sentence: its speaker ("codex") and agent
 * ("claude code"), "it", the session, and the session's name ("workbench", "the workbench session").
 */
export function agentNames(voice: Voice = CLAUDE_CODE_VOICE, session?: string) {
  const names = [voice.speaker, voice.agent, "it", "the session", "this session"];
  if (session?.trim()) names.push(session, `the ${session} session`);
  return [...new Set(names.map((n) => norm(n).replace(/\s+/g, " ")).filter(Boolean))];
}

/** A sentence that only says who spoke asked you nothing: "Codex didn't ask anything else." (NOTHING_ASKED). */
const nothingAsked = (who: string[]) => new RegExp(String.raw`^(?:${who.map(escapeRe).join("|")}) (?:also |otherwise )?(?:${NOTHING_ASKED})${NOTHING_ASKED_END}`);

const SENTENCE_END = /[.!?]+["')\u2019\u201d]*\s+/;
const QUESTION_END = /\?["')\u2019\u201d]*$/;
const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\u2019/g, "'");

// A question Claude never asked: "Want Claude to tell you when both are ready, or to walk you through
// the restart?" when the reply only said "I'll tell you when both are ready.". The
// prompt forbids it, but an earlier summary in the recent conversation that fairly ended in a question
// gets copied. The user hears a question as their cue to answer, so when the reply asks nothing, a later
// sentence that starts like a question (QUESTION_STARTS) is held until it ends, and dropped if it ends in "?".
const QUESTION_STARTS = [
  "want",
  "wanna",
  "should",
  "shall",
  "do you",
  "does ",
  "did ",
  "would",
  "will you",
  "could",
  "can ",
  "is ",
  "are ",
  "any",
  "which",
  "what",
  "how ",
  "when ",
  "where ",
  "who ",
  "why ",
  "or ",
  "ready",
  "need ",
  "if you",
];
// Not one verb in a list of them: "send, send with a note, or ask", "say \"share the shopping list\", press Ctrl+S".
const NOT_LISTED = String.raw`(?!\s*[,/|\u00b7]\s*(?:send|say|tell|ask|ping|wait|stop|press|run|type|tap|click)\b)`;
// Not what something will do: "the bar will just say \"All synced\"".
const UNSAID = String.raw`(?<!\b(?:will|would|can|could|should|might|to) )`;
// Words in a reply that offer a choice or ask for an answer without a question mark: "tell me if you want
// it committed", "your call", "I can build it as a setting". Checked on real replies and Claude Code
// transcripts: a statement like "I'll tell you when both are ready" matches none of them.
const OFFERS = [
  /\b(?:want|wants|like) me to\b/,
  /\b(?:should|shall) (?:i|we)\b/,
  /\blet me know\b/,
  /\bif you(?:'d)? (?:want|like|prefer|rather)\b/,
  /\bif (?:that|this|it) (?:sounds|looks) (?:right|good|ok|okay|fine)\b/,
  /\bif you're (?:ok|okay|happy|fine) with (?:it|that|this)\b/,
  /\b(?:your call|up to you|anything you like)\b/,
  /\bwhich (?:one |of (?:these|them|the \w+) )?(?:would|do) you\b/,
  /\bwould you (?:rather|like|prefer)\b/,
  /\bdo you want\b/,
  // Said to you, not about someone: "say so and I'll stop it", "tell me which", "send the screenshot", not "the log will say
  // which". None of them as a bare verb in a list (NOT_LISTED): "Three answers from the ranker: send, send with a note, or
  // ask." describes what the ranker picks between, and asks you nothing. "tell me", "ask me" and the like are
  // aimed at you wherever they are; "say …" and "send …" only where a sentence or a clause starts, not after "and" or "or":
  // "the setup script should check each variable, and say which one is missing", "Reload and send a new request", "or say
  // \"share the shopping list\"" tell you what something does or how to do it.
  new RegExp(String.raw`(?:^|[.;:!,(\u2022\-\u2013\u2014]\s*|${UNSAID}\b(?:just|then|and|or|so|please) )(?:tell me|ask me|ping me|send me)\b${NOT_LISTED}`),
  new RegExp(String.raw`(?:^|[.;!,(\u2022\-\u2013\u2014]\s*|${UNSAID}\b(?:just|so|please) )say ['\u2018]?(?:so|when|if|which|the word|yes|go|quoted)\b${NOT_LISTED}`),
  new RegExp(String.raw`(?:^|[.;!(\u2022\-\u2013\u2014]\s*|${UNSAID}\b(?:just|please) )send (?:it|them|that|this|those|these|over|along|the|a|an|your)\b${NOT_LISTED}`),
  /\bhappy to\b/,
  // Not why something's so: "Everything is logged, so I can trace it from there.".
  /(?<!\bso (?:that )?)\bi can(?!'t|not)\b/,
  /(?<!\bso (?:that )?)\bi could(?!n't)\b/,
  /\bi'd (?:go with|start with|pick|suggest|recommend)\b/,
  /\bmy (?:pick|recommendation|suggestion)\b/,
  /\bi (?:recommend|suggest)\b/,
  // Not "Nothing else is waiting on you.", "stale jobs stuck waiting on you" or "the hints and who's waiting for you".
  /(?<!\b(?:nothing (?:else )?(?:is |'s )?|was |were |been |stuck |who's |who is ))\bwaiting (?:on|for) (?:you|your)\b/,
  /\byour (?:go|choice|decision)\b/,
];
const EACH_OFFER = OFFERS.map((re) => new RegExp(re.source, "g"));

// A request or an offer for later, or for if something happens, asks nothing now. A reply once ended
// "If any step fails, just tell me its number.", and the summary turned it into a question of its own about telling
// Claude the number. "Tell me if anything breaks.", "Let me know when you're back.", "Ping
// me if it fails again.", "Once you've tested, tell me what you see.", "Tell me how it goes." and "If something's off, I
// can roll it back." are the same: a condition (CONDITION) says when, before it ("If X, tell me": LEADING) or after it in
// the same clause ("tell me if X": TRAILING), and until then nothing is waiting on you. The summary can say it as a
// statement; as a question it's a cue to answer something that hasn't happened.
// Still asking, now:
// - A condition that's yours: what you want, like or meant, or your OK (YOURS). "Let me know if you want me to commit it.",
//   "Say when you want it committed.", "I can do that next if you want.", "If you'd rather skip it, say so and I'll stop
//   it." and "If you meant something else, tell me." wait on your word, not on something happening.
// - A request whose answer is your choice or what you meant (CHOICE), whatever its condition: "After the reload, tell me
//   whether that layout is enough or whether you want a separate page.", "When you get a moment, tell
//   me which kind of storage usage you meant.". "When you get a moment" is only polite (POLITE).
// - "Say 'go'", "Just say when.": they ask for the go-ahead itself (APPROVAL).
// Not "whenever" or "any time" with a request, though: "Let me know whenever you'd like to dig into the data" is an
// open door, not a choice. An offer of work is still one: "I can start the price watch whenever you like."
// Not "when to start, your call": what to pick, not when to say.
const CONDITION = String.raw`(?:if|when(?! to\b)|whenever|once|as soon as|after(?= (?:you|it|they|we|that|this|the|i)\b)|in case|the moment|next time|any ?time)\b`;
const YOURS = new RegExp(
  String.raw`^(?:if|when|whenever|once|any ?time) (?:you(?:'d| would)? (?:want|like|prefer|rather)|you (?:\w+ )?(?:meant|mean)\b|you were (?:asking|thinking|after)|you (?:don't |do not )?like|(?:it|that|this) bothers you|you(?:'re| are) (?:ok|okay|happy|fine|good) with|you(?:'re| are) ready|you agree|so\b|yes\b|(?:that|this|it)(?:'s| is)? (?:sounds?|looks?|seems?) (?:right|good|ok|okay|fine))`,
);
const CHOICE = /\b(?:you(?:'d| would)? (?:want|prefer|rather)|you(?:'d| would) like|you (?:\w+ )?meant)\b/;
const POLITE = /^(?:when|whenever|once) you (?:get|have) (?:a )?(?:moment|minute|chance|sec(?:ond)?)\b|^when(?:ever)? you can\b/;
const OPEN = /^(?:whenever|any ?time)\b/;
// Mid-sentence, the condition is one clause; one that starts the sentence can run on: "If they don't match, or the
// billing page shows a different total, tell me both numbers".
const LEADING = new RegExp(String.raw`(?:^(?:(?:and|but|so|or) )?(${CONDITION}[^;:]*)|[,;:(\u2014\u2013]\s*(?:(?:and|but|so|or) )?(${CONDITION}[^,;:]*)),\s*(?:(?:and|then|just|please|so) )*$`);
// What happens then has its own condition: "tell me and I'll merge it when the tests pass", "Just say so and it'll go
// straight after the rename.".
const CLAUSE_END = /[,;:]|\b(?:and|so|but|because|then) (?:i|we|it|they|that|i'll|we'll|i'd|it'll)\b/;
const TRAILING = new RegExp(`\\b(${CONDITION}.*)$`);
const LATER = /^\s*(?:how (?:it|that|this|they) (?:goes|went)|what(?:ever)? you find)\b/;
const REQUEST = /^\W*(?:(?:just|then|and|or|so|please) )?(?:tell me|ask me|ping me|send me|say|send|let me know)\b/;
const APPROVAL = /\bsay ['\u2018]?(?:go|yes|the word)\b|\b(?:say|tell me|let me know) when\W*$/;

/** The offer at `at` in a sentence (norm'd) is for later or for if something happens (see CONDITION). */
function forLater(said: string, at: number, offer: string) {
  if (/^\W*if\b/.test(offer) || APPROVAL.test(said.slice(at))) return false;
  const start = at + offer.match(/^[^a-z']*/)![0].length; // past the ", " that leads into it
  // "Say when you're back": its own "when" starts the condition.
  const after = ((offer.match(/\b(?:if|when)$/)?.[0] ?? "") + said.slice(at + offer.length)).split(CLAUSE_END)[0];
  const request = REQUEST.test(offer);
  const lead = LEADING.exec(said.slice(0, start));
  // After an offer of work, "once", "when" or "after" say when the work would be, and it's still yours to pick now: "Or I
  // can wait and merge all three branches together once Search and the import fixes are done.".
  const trail = TRAILING.exec(after)?.[1];
  const conditions = [lead?.[1] ?? lead?.[2], request || /^(?:if|in case)\b/.test(trail ?? "") ? trail : undefined].filter((c): c is string => c !== undefined && !POLITE.test(c));
  if (request && conditions.some((c) => OPEN.test(c))) return true;
  if (CHOICE.test(after) || conditions.some((c) => YOURS.test(c))) return false;
  return conditions.length > 0 || (request && LATER.test(after));
}

/** How a sentence (norm'd, asides out) offers or asks without a "?" (OFFERS): "now", only "later" (forLater), or not. */
function offers(said: string): "now" | "later" | null {
  let later = false;
  for (const re of EACH_OFFER)
    for (const m of said.matchAll(re)) {
      if (!forLater(said, m.index, m[0])) return "now";
      later = true;
    }
  return later ? "later" : null;
}

// Code, links and quoted words in a reply aren't Claude asking: a "?" in a regex or a URL, a question it quotes back, a
// feature called "tell me when it's done". Each is set aside as a mark while the reply is read, and put back where it's shown.
const ASIDE = /`[^`\n]*`|\bhttps?:\/\/\S+|"[^"\n]{0,200}"|\u201c[^\u201d\n]{0,200}\u201d/g;
const MARK = /\u0000(\d+)\u0001/g;
const LIST_ITEM = /^\s*(?:[-*+\u2022]|\d+[.)])\s/;
// A list, or a label like "**Next:**" and then a list: the paragraph before it leads into it, and is part of the ending too.
const isList = (paragraph: string) => {
  const [first, second] = paragraph.trim().split("\n");
  return LIST_ITEM.test(first) || (/:\**$/.test(first) && second !== undefined && LIST_ITEM.test(second));
};
const SENTENCES = /(?<=[.!?]+["')\u2019\u201d*]*)\s+|\s*\n\s*/;
const ENDING_SENTENCES = 3;
const MAX_ASKED_CHARS = 400;

/**
 * What Claude's reply ends by asking you or offering, as it said it, or null when it asks nothing; `question`: it asks with
 * a "?". Only the end counts: whole paragraphs from the last one back, until there are ENDING_SENTENCES sentences, and the
 * one leading into a list. A question earlier that the reply then moves on from isn't what it leaves you with: a reply
 * once ended "The theme agent, which is also restyling the settings page colours, is still running.", and the summary
 * made up "Should it leave the theme work running, or wait for that to finish first?". A line or two after an offer
 * doesn't take it back, though: "I can add it if you want (with a backup first)." and then a short list and "Go ahead
 * with the import test whenever you're ready.". Three sentences, checked on 874 real
 * replies: fewer lost real offers followed by a line of status, and more brought back
 * made-up questions. A sentence asks with a "?" or words like OFFERS that aren't for later (forLater), code, links and
 * quotes left out (a quote is left as a word, for `say "go" and I'll merge`); the last one that does is given, with up to
 * two that ask right before it.
 */
export function endingAsk(reply: string): { text: string; question: boolean } | null {
  const asides: string[] = [];
  const text = reply.replace(/```[\s\S]*?(?:```|$)/g, "\n\n").replace(ASIDE, (m) => `\u0000${asides.push(m) - 1}\u0001`);
  const paragraphs = text.split(/\n[ \t]*\n/).filter((p) => p.trim());
  const sentences: string[] = [];
  const listed: boolean[] = []; // the sentence is in a list item
  while (paragraphs.length) {
    const paragraph = paragraphs.pop()!;
    const lines = paragraph.split("\n").map((line) => ({ line, said: line.split(SENTENCES).filter((s) => s.trim()) }));
    sentences.unshift(...lines.flatMap((l) => l.said));
    listed.unshift(...lines.flatMap((l) => l.said.map(() => LIST_ITEM.test(l.line))));
    if (sentences.length >= ENDING_SENTENCES && !isList(paragraph)) break;
  }
  const said = (sentence: string) => sentence.replace(MARK, (_, i) => (/^"|^\u201c/.test(asides[i]) ? " quoted " : " ")).replace(/\*/g, "");
  const question = (sentence: string) => said(sentence).includes("?");
  const offer = (sentence: string) => offers(norm(said(sentence)).replace(/\s+/g, " "));
  // Steps or how-tos that end "If anything misbehaves, tell me roughly when and I'll pull the logs.":
  // their "Pause: during an upload, say \"pause <file>\"." is how to use it, not an offer. Above a request for later, a list
  // item only asks with a "?".
  const later = sentences.findLastIndex((s) => !question(s) && offer(s) === "later");
  const asks = (sentence: string, i: number) => question(sentence) || (offer(sentence) === "now" && !(i < later && listed[i]));
  const last = sentences.findLastIndex(asks);
  if (last < 0) return null;
  let first = last;
  while (first > 0 && last - first < 2 && asks(sentences[first - 1], first - 1)) first--;
  const ending = sentences.slice(first, last + 1);
  const asked = ending
    .join(" ")
    .replace(MARK, (_, i) => asides[i])
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    text: asked.length > MAX_ASKED_CHARS ? `\u2026${asked.slice(-MAX_ASKED_CHARS)}` : asked,
    question: ending.some((s) => said(s).includes("?")),
  };
}

/**
 * Below this, the classifier's read that the session is waiting on you (decideStop's needs_user) says an offer without a "?" asks
 * nothing (claudeAsked). Words alone take too much for an offer: "I'd go with two." (needs_user 0.18), "My
 * suggestion: the second one." (0.33) and "Add or cut anything you like." (0.30) asked nothing,
 * and "If any step fails, just tell me its number." (0.16) became a made-up question. Of the
 * 1,324 real replies, the 31 that read as an offer once forLater is left out but are under
 * 0.35 (0.06 to 0.34) are all a recommendation, a pointer or something for later; the lowest real offer is an optional
 * setting offered "if you want it while you're testing" (0.37), and the next are 0.41 and 0.42 (offers
 * to add a rule). Below the 0.5 that says a turn doesn't need you (app/state.ts QUIET_NEEDS_USER):
 * The classifier reads offers lower than questions. A "?" counts whatever the classifier says: a real question wants its answer.
 */
export const OFFER_NEEDS_USER = 0.35;

/**
 * What Claude's reply ends by asking you or offering (endingAsk), or null when it asks nothing. With the classifier's needs_user for
 * the turn, an offer with no "?" counts only at OFFER_NEEDS_USER or more; without it (null: the classifier off or failed), it counts.
 */
export function claudeAsked(reply: string, needsUser: number | null = null): string | null {
  const ask = endingAsk(reply);
  if (!ask) return null;
  return ask.question || needsUser === null || needsUser >= OFFER_NEEDS_USER ? ask.text : null;
}

/** Claude's reply ends by asking you something or offering a choice (claudeAsked; for the tests). */
export const replyAsks = (reply: string) => claudeAsked(reply) !== null;

/**
 * Passes text on as it streams, holding back a closing remark about the summary itself, and, when Claude's
 * reply asked nothing (`asks` false), a question the summary adds. Only whole sentences after the first are dropped.
 * `who`: what the summary can call who spoke (agentNames), for a remark that says it asked nothing.
 */
export function dropClosingRemark(onText: (delta: string) => void, asks = true, who = agentNames()) {
  const base = asks ? STARTS : [...STARTS, ...QUESTION_STARTS];
  const holds = [...base, ...who.flatMap((name) => AGENT_STARTS.map((s) => `${name} ${s}`))];
  const remark = nothingAsked(who);
  const isRemark = (sentence: string) => {
    const said = norm(sentence);
    return (base.some((s) => said.startsWith(s)) && META.some((re) => re.test(said))) || remark.test(said);
  };
  let raw = "";
  let done = 0; // raw up to here is passed on (or dropped)
  let spoken = "";
  let at: "start" | "flow" | "held" = "start";
  let dropped: string | undefined;
  const drop = (sentence: string) => {
    dropped = dropped ? `${dropped} ${sentence.trim()}` : sentence.trim();
  };
  const pass = (text: string) => {
    if (!text) return;
    spoken += text;
    onText(text);
  };
  const step = (final: boolean) => {
    while (done < raw.length) {
      const rest = raw.slice(done);
      const end = rest.search(SENTENCE_END);
      const sentence = end < 0 ? rest : rest.slice(0, end + rest.slice(end).match(SENTENCE_END)![0].length);
      if (at === "flow") {
        // Mid-sentence: pass everything on, but keep a trailing full stop until it's clear it ends the sentence.
        const text = end >= 0 || final ? sentence : rest.replace(/[.!?]+["')\u2019\u201d]*$/, "");
        pass(text);
        done += text.length;
        if (end < 0 && !final) return;
        at = "start";
      } else if (at === "start") {
        const head = norm(rest);
        if (!spoken.trim())
          at = "flow"; // the first sentence is the summary: never held
        else if (holds.some((s) => head.startsWith(s))) at = "held";
        else if (!final && holds.some((s) => s.startsWith(head)))
          return; // too little to tell yet
        else at = "flow";
      } else {
        // Held: wait for the sentence to end and for anything after it.
        if (!final && (end < 0 || !rest.slice(sentence.length).trim())) return;
        if (!asks && QUESTION_END.test(sentence.trim())) {
          drop(sentence);
          done += sentence.length;
          at = "start";
          continue;
        }
        if (final && !rest.slice(sentence.length).trim() && isRemark(sentence)) {
          drop(sentence);
          done = raw.length;
          return;
        }
        pass(sentence);
        done += sentence.length;
        at = "start";
      }
    }
  };
  return {
    push(delta: string) {
      raw += delta;
      step(false);
    },
    /** The stream is over: passes on what's left. Returns what was spoken, and the remark it dropped. */
    end() {
      step(true);
      return { text: spoken.trim(), dropped };
    },
  };
}
