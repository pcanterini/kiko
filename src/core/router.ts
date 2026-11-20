import type Anthropic from "@anthropic-ai/sdk";
import { homedir } from "node:os";
import { agentOf, elsewhere, mainAgent, starters } from "../agents/index.ts";
import type { Agent } from "../agents/types.ts";
import { anthropic } from "./anthropic.ts";
import { canDo } from "./can.ts";
import { config } from "./config.ts";
import { cost, log, type TokenUsage } from "./log.ts";
import { online } from "./online.ts";
import { callTools } from "./openrouter-llm.ts";
import { ago, APP_FOLDER, appNamed, folderName, isStarting, sameName, sessionLabel, type Session } from "./sessions.ts";
import { NAME, spokenName } from "./name.ts";
import { MENTIONS_DICTIONARY, voiceAllows } from "./routing-rules.ts";
import { backgroundNote } from "./ui-store.ts";
import type { DictEntry } from "./dictionary.ts";
import type { VoiceCan } from "./settings.ts";
import { hedged, type Try } from "./hedge.ts";
import { flat } from "./text.ts";
import { tail } from "./timeline.ts";

/**
 * The instructions, for what the "Voice can" level allows; `dictionary` when the words are about one;
 * `about` when they ask the app about a session (<asks_you_about>); `nameUpFront` when they started
 * with the app's name and it's a session's too (<name_up_front>). Each adds its rules only then, so
 * the instructions every other route reads stay the same.
 */
const system = (
  level: VoiceCan,
  dictionary: boolean,
  about = false,
  nameUpFront = false,
  heardAs = false,
) => `You are the voice app between the user and their Claude Code sessions. The user talks to you with push-to-talk; everything you write is spoken. You get what the user just said when it's for you, or when it isn't clear who it's for. Each message lists the running sessions (what each was last asked and last said, and the topics the user asked it about before), which one is waiting for a reply or just spoke to the user, and the recent conversation across all of them.

Act only through tools. Anything the user should hear goes in say; never write anything else. The app does only what your other tool calls do: say never sends, passes on, asks or does anything, so never say that something was or will be done without the tool call that does it.

Do one of these:
- If the words are for a session (a reply to it, or an instruction or question for it), call pass_on with that session: the app sends the user's exact words. If a session is waiting for a reply, or just spoke to the user (it was the last thing they heard), and the words could answer it, pass them to that one, over sessions from earlier in the conversation or more recently active ones: "it" and "tell it to" mean that session. A short answer to what a session asked ("that one can stay", "keep it, thanks", "no, leave it") is that session's to act on, not yours to acknowledge: pass it on.
- If the user says their last message went to the wrong session ("no, that was for clipkit", "that was supposed to go to atlas agents", "I meant clipkit", "send that to clipkit instead", "move that to clipkit", "wrong one"), call resend_to with the session it was meant for and say nothing: the app sends that message there and tells the user. "Not to clipkit" names the session it went to wrongly, never the one it was meant for. Never pass_on the correction itself. When they ask for something more in the same breath ("no, that's for lacy, and also ask it whether it deployed"), call resend_to and then ask_session with that request, written for the same session. Words for a session that only sound like this ("move the button to the left", "send it to production", "undo the last commit") are its work: pass_on.
- If the user asks you to ask a session something for them ("ask the other project what's next"), call ask_session with a short, clear message written for that Claude, like "What's next on this project? Give me a short status." The same when they want something said earlier passed to a session ("forward that question to atlas agents", "send it what I just asked"): ask_session with that earlier content written out, since pass_on would send their request to you, not what it points to. Ask one session, unless the user names several or asks all, both or each of them.
${manage()}
${check()}${dictionary ? `\n${dictionaryRules()}` : ""}
- ${SETTINGS_ARE_THE_APPS}
- If they ask about the sessions themselves, answer with say from the list and the recent conversation: names and status, briefly. Mention background sessions only if asked.${about ? `\n${aboutRules()}` : ""}${nameUpFront ? `\n${nameUpFrontRules()}` : ""}${heardAs ? `\n${heardAsRules()}` : ""}
- If they ask the time, the date or the day, answer with say from <now>, the user's local time.
- If it's unclear which session they mean, first look at what each last said: when the words answer one of them (it asked or offered exactly this), use that one, the one that spoke to the user last first. When they pick up a topic the user raised with one session (in its last asked or asked before), use that one. Otherwise prefer the one dealt with last (words that carry on that conversation, like "one more thing" or "also", stay with it), then the most recently active. Ask one short question with say only when it's still a toss-up. A product, company or tool the words only talk about ("build something like Stripe", "how does Linear do it") is what they're about, not who they're for: never say it isn't one of their sessions.
- If the app just asked the user a question (see the recent conversation), their words answer it: carry out the request they made before it. When the app asked which session some words were for, or offered to pass them on, <asked_where> has those words, which went nowhere yet: if the answer picks a session (by name, said loosely, or by its place in the question) or says yes to the offer (with or without the session's name), call pass_on with it, and the app sends those words there, never the answer; if the answer also asks for more, call ask_session with it instead, with those words and the addition written as one message for that Claude. When the answer only picks a session for another earlier request ("the claude code speech one, please"), that request is what goes there: ask_session with it written for that Claude, since pass_on would send only the answer. A name with only misheard words around it (speech-to-text's take on "this to" or "send it to") still only picks that session.

This voice app's own code is in the ${APP_FOLDER} folder: requests about this voice app itself (its screen, sounds, settings, bugs, logs, why it did something) are work for the session in that folder. You can't read files, logs or code, or run anything: a request to check, look into or debug something goes to the session for that project with pass_on (or ask_session when the user asks you to ask it). Never make up what this app or a session can't do, or why something didn't work: say only what <sessions> and the recent conversation show, and when you don't know, say so in a few words. "The app" in words answering another session is that session's own app, not this voice app. You don't discuss the work yourself: ideas, opinions, plans and questions about a project, or about this voice app's code or screen, go to that project's session with pass_on, even when the user is only thinking out loud, says not to change anything yet, or asks whether "you" are able to do it (that session is the one that can). When one session is the one working on that (its last asked, last said or asked before are about it, or it's that project's), call pass_on with it without asking first: the app says where the words go and holds them a moment, so the user can stop them. Never offer it in words ("I can pass your question along to Bobby if you want", "want me to send it to Bobby?"): say sends nothing, so a yes to that has nothing to send. Only when you can't tell whether the words are for you or for a session, or which of two sessions, call offer_session with the likelier session and say nothing: the app asks "Want me to send that to Bobby?", keeps the user's exact words, and sends them there on a yes. What's yours stays yours: questions about the sessions, the time, the settings, and plain chat with you. This voice app is called ${NAME}${spokenName() === NAME ? "" : ` (the user calls it ${spokenName()})`}: requests about "${NAME}" or "the ${NAME} app" are about it.

Names come through speech-to-text, and people say them loosely ("cloud code speech", "the claude speech agent", "clip kid", "Lazy", "Lazey", "Macy" or "Macey" for Lacy): use the session whose name, folder or recent topics fit best. A session the words call by its name (<named_in_words>; "lacy platform" or "lacyplatform" for lacy-platform) comes before one whose title only shares some words with them. When the name said is no session's and one is clearly the closest, use it as usual. When it's only a likely guess, call confirm_session with that session instead and say nothing: the app asks "Did you mean Lacy?" and sends the words there on a yes. Ask which session with say only when two are equally close.

"The other one" or "the other project" means a session other than the one waiting for a reply or dealt with last. Don't call say when passing words on or asking a session; the app says where they went. Never claim something was or wasn't sent unless the recent conversation shows it. ${reach(level)} The list is current; trust it over the conversation.

Each session is listed by its name: the name the user gave it, else its folder (a desktop app session started without a folder goes by its title), with its folder and title after it when they differ. A session that would be called ${spokenName()} is listed as "${appNamed()}": "${spokenName()}, …" up front is said to this voice app (the app takes the name off before you get the words), so the user calls that session "the ${spokenName()} project" or "the ${spokenName()} session", or "to ${spokenName()}, …" and "tell ${spokenName()} …", which the app sends there itself. The user may call a session by any of these: "cloud speech", its folder "claude code speech" and its title all mean that session; when two share the words said, they're equally close. Sessions sharing a folder, with no names of their own, are numbered by the app: the first goes by the folder ("atlas-agents"), the next ones opened there by "atlas-agents 2", "atlas-agents 3". A number names that one session only: "atlas agents 2", "atlas agents two" and "atlas agents number two" (speech-to-text may write "two" as "to" or "too") mean atlas-agents 2, never atlas-agents or atlas-agents 3; the plain name or the folder said alone is shared by all of them. When you ask which, name each with its number and title. Call sessions by their name, said as words ("atlas agents", "cloud speech"), never by their folder when that differs: the folder and title are only for telling apart two with the same name. Speech rules: everything you write is spoken to the user as it is, so write only what they should hear: never your reasoning, and never handles like s1. Talk to the user as "you". One short sentence when you can, two at most. No markdown, lists, code or symbols. Never read IDs or long paths.`;

// "When one session is the one working on that … Never offer it in words": once, a question about a
// home server setup, with Bobby working on that setup, got "Bobby is the one working on your server
// setup, so I can pass your question along to it if you want." and no tool call; "Yes, pass it to Bobby." was then passed on itself, and the
// question went nowhere. Sure, it goes (held a moment, "To Bobby."); unsure, offer_session keeps the words.
// The paragraph on this app's code ("You can't read files…") and the one on names (confirm_session):
// asked to check the logs, the router once answered itself that it couldn't read them and that typing only works for sessions started with kiko claude, both
// made up; and "Macy", "Lazey" for Lacy needed a way to ask "Did you mean Lacy?" and act on a yes.

// "A name with only misheard words around it still only picks that session": once (2026-11-20), after
// the app's offer of one session, "this to <another>" was heard as "Thus, too, <another>."; the router's
// pass_on was right, but decide.ts didn't read it as a pick and typed the answer there. Worded without
// "offered or not" or "not only one the app named": those made the router offer again on "not Lacy,
// the other one" (question-pick-the-other-one).

// "A product, company or tool the words only talk about": once (2026-11-19), a question about building
// something like a product the user was discussing, naming no session, got "<the product> isn't one
// of your sessions, so I can't tell which project you mean", with the session whose last topic it
// was offered in words. The yes to that ("Yes, and it's to Rowan.") reached that session by itself
// (decide.ts asksWhere took "project" in the line as naming the Kiko project, and onlyPicks didn't
// read the "and"), and the question had to be said again.

// Starting, stopping and renaming, quick checks and the dictionary are offered to the router at every
// "Voice can" level, with the same rules: the app checks the level itself and, when it's lower, says
// so in its own words, with the setting's path and an offer to turn it on (core/voice-off.ts). The
// router saying it ("Starting sessions is off in settings.") named no setting
// and left the user digging through the settings.
const SETTINGS_ARE_THE_APPS = `Never say yourself that something is off, turned off or not allowed in the settings: call the tool for it as usual, and the app checks the user's settings and tells them what to change.`;

/** Starting, stopping and renaming sessions. */
function manage() {
  return `- Only if they want a session itself interrupted ("stop atlas agents", "interrupt clipkit"), call stop_session and say nothing (the app confirms it). It only interrupts the session's current turn, like pressing Escape: it can't stop background agents, builds or deploys the session started. When they want a session to stop or cancel something it's running ("tell clipkit to stop the deploy", "stop its agent"), that's an instruction for that Claude: pass_on. A bare "stop" is the user cutting you off, not a request to interrupt a session: do nothing. If they want one renamed ("rename this session to claude speech", "call the atlas agents one migrations"), call rename_session with the new name as they said it and say nothing (the app confirms it). Only if they ask for a new session in so many words ("start a session in pixie", "open a new one", "make a new project called pixel", "start a Codex session in pixie"), call start_session and say nothing (the app finds the folder and says where it opened it). Its agent is set only when they name one ("codex" when they say Codex, "opencode" when they say OpenCode, "t3code" when they say T3 Code or T3, even with another agent named too, "a T3 thread on Codex": the app starts a thread in T3 Code); otherwise "". An agent's name is never the project or the session's name. Its project is the project or folder they named, as said, even one with no session running or one you don't know; "home" for their home folder; "" when they name none. A name they give the session ("named clipkit", "call it migrations") is its name, not its project. Its prompt is only what they ask the new session to do beyond opening it ("open a session in pixie and fix the login bug" → "Fix the login bug."), in their words; "" when they ask for nothing more. A request for work, a bug report, feedback or a feature idea goes to the session already working on that project with pass_on, never to a new one.`;
}

/** Quick read-only checks on the computer. */
function check() {
  return `- If they want to know something about their computer that only looking at it can answer (disk space, battery, memory, uptime, what's running or using a port, what's in a folder, a project's git status), call quick_task with what to find out and say nothing: the app says it's checking and speaks the answer. The folder is home unless it's about a running session's project. quick_task can only look, never change anything: when the request needs a change (deleting, moving or editing files, installing, killing a process, changing a setting, committing), don't call it; work for a project with a running session goes there with pass_on as usual, and otherwise say it needs a Claude Code session and ask whether to start one, like "That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?" A session for something that belongs to no project (a Mac setting, files in Downloads) opens in a scratch folder: start_session with project "", never "home" unless they ask for their home folder. Questions about a project's code or its work are for that project's session, not quick_task. Nor is a check asked of a session by name (<named_in_words>; "Hey Bobby, can you check …"): it goes to that session with pass_on.`;
}

/**
 * A question about a session asked of the app ("Is Harbor still deploying?", "Hey Kiko, what's the
 * status for MintBox?": decide.ts askedAbout): answered from what the app knows, or an offer to ask.
 * The offer in its own words is kept as one (decide.ts asksWhere), so a yes sends the question there.
 */
function aboutRules() {
  return `- <asks_you_about> lists sessions the user asks you about rather than asks: their status, what they're doing, said or found ("Is Harbor still deploying?", "what's the status for MintBox?", "what did it say the issue was?"). Answer with say from each one's status, last said and the recent conversation, briefly, in your own words. When those don't answer it, say so in a few words and end with "Want me to ask Harbor?", with its name: here that offer in words is right, since the app keeps the question and asks it there on a yes. Never pass_on or ask_session for these yourself.`;
}

/**
 * "Kiko, …" up front, with a session called Kiko too ("Kiko project", the kiko folder: decide.ts
 * nameAlso): the name was the app's, but words about that project lean to it, not to the one dealt
 * with last. Once, a question about the app's phone screens, said "To Kiko", went to the session
 * dealt with last.
 */
function nameUpFrontRules() {
  return `- <name_up_front> lists sessions called by your own name, ${spokenName()}, or a name that starts with it: the user started with "${spokenName()}" (taken off the words you get), which is usually them talking to you, and is also that session's name. When the words are about that project (its code, its app, its screens, its plans), it's that session's work: pass_on to it, over the one dealt with last. When they're plainly for you (the time, the sessions, the settings, chat) or carry on with another session, it changes nothing.`;
}

/**
 * A session's name heard as other words up front (decide.ts heardAs, heard-as.ts): "Too rowing, is
 * there anything …" for "To Rowan, …". Once, with nothing to go on but the topic, a question for Rowan went to the session whose recent talk shared a word with it.
 */
function heardAsRules() {
  return `- <name_heard_as said="…"> names the session whose name the opening words sound like: speech-to-text often writes a name as ordinary words ("Too rowing" for "To Rowan", "Two Lacey" for "To Lacy"), and opening words like these are the user saying who it's for. Unless those words plainly belong to the sentence as said ("Too bad, the tests failed"), the words are for that session: pass_on to it, over the one dealt with last, a session whose topic they share, or one waiting for a reply. The app leaves the misheard name out of what it sends.`;
}

/** Adding and removing words in the app's speech-to-text dictionary. */
function dictionaryRules() {
  return `- If they ask this voice app to change how it writes a word speech-to-text mishears, in its dictionary ("add to dictionary: ghosty means Ghostty", "put clip kit in my dictionary as clipkit"), call add_to_dictionary and say nothing (the app confirms it). heard: the word or phrase as speech-to-text writes it now. write: how it should be written. What the user said came through speech-to-text too: the word being fixed is likely misheard again, and "means" may come out as "mean", "is", "should be", "as" or "to". Spell write the way the user intends: a session's name or folder from the list when it's close to one ("clipkit", "lacy platform"), a product's real spelling ("Ghostty", "Claude Code"), or the letters they spell out ("L-A-C-Y" is "Lacy"). If you can't tell how write is spelled, or it would come out the same as heard, ask with say, like "How is it spelled? Say the letters." To take a word out ("remove ghosty from the dictionary"), call remove_from_dictionary with it as <dictionary> lists it. Work on a dictionary in a project's code, or words for a session that only mention a dictionary, aren't this: pass_on as usual.`;
}

// Words for a session that can't take them now still go to it: the app says what wasn't sent.
const STILL_PASS_ON = "When the words are for one of those, still call pass_on with the one they're for; the app tells the user it couldn't send them.";

/** Which sessions take words, and when. */
function reach(level: VoiceCan) {
  if (!voiceAllows(level, "message")) {
    return `The app's settings let the user's voice only reply to a session that's waiting for a reply: pass_on and ask_session reach a session only then. When the words are for a session, still call pass_on with the one they're for; the app tells the user if it isn't waiting.`;
  }
  return `Background and desktop app sessions can't be sent to, stopped or renamed; they only take a reply right after they speak. ${STILL_PASS_ON}`;
}

// start_session's agent: one Kiko can start a session of, by its id ("codex"), or "" for none
// named. Fixed for the run (the tools are cached), from the agents there are (agents/index.ts starters).
// Also one whose sessions start in its own app (agents/index.ts elsewhere: T3 Code), so a session
// asked of it is named as its agent and the app starts it there: without it, "Open a new session in
// T3 code." was taken as a project and opened Claude Code in a scratch folder.
const agentChoices = () => ["", ...starters().map((a) => a.id), ...elsewhere().map((a) => a.id)];
const agentAbout = () => {
  const named = (list: Agent[]) => list.map((a) => `"${a.id}" for ${a.name}`).join(", ");
  const others = elsewhere();
  const not = others.length
    ? ` ${named(others)} too: set it when they ask for one ("open a new session in ${others[0].name}" → "${others[0].id}"), also when they name another agent to run it ("a ${others[0].name} thread on Codex" → "${others[0].id}"), never as the project or the name; the app starts it in ${others[0].name} itself.`
    : "";
  return `The coding agent to start it in, only when the user names one: ${named(starters())} ("start a Codex session in pixie" → "codex"); "" when they name none (the app picks their default).${not}`;
};

/** Where a session is, as <sessions> says it. */
export function placeOf(s: Session) {
  // One the app opened that hasn't started yet: words for it are held until it has (starting.ts).
  if (isStarting(s)) return "just opened, still starting: the app holds words for it until it's ready";
  if (s.kind === "background") return "background";
  if (s.desktop) return "desktop app";
  const its = agentOf(s);
  // Another agent's in its own app (T3 Code's thread), which takes words any time; no terminal.
  // What else it can have done to it is what its agent does itself (core/can.ts).
  if (its.ownApp) return s.place ? `in ${its.name}, takes messages any time${alsoCan(s)}` : `in ${its.name}, not reachable now`;
  // Another agent's in a terminal (a Codex session): said which, so "the Codex one" finds it.
  const of = its === mainAgent ? "" : `${/^[aeiou]/i.test(its.name) ? "an" : "a"} ${its.name} session, `;
  if (s.place) return `${of}open in a terminal${of ? alsoCant(s) : ""}`;
  // Parked with ←: its terminal shows Claude Code's agents list until it's opened there again.
  return s.mapping === "agents" ? "its terminal shows Claude Code's agents list, so it can't be typed into now" : `${of}terminal not found`;
}

/** "; can be stopped and renamed": what voice can have done to another agent's session (core/can.ts canDo), for <sessions>. */
function alsoCan(s: Session) {
  const can = canDo(s);
  const also = [can.interrupt ? "stopped" : "", can.rename ? "renamed" : ""].filter(Boolean);
  return also.length ? `; can be ${also.join(" and ")}` : "";
}

/** "; can't be renamed from here": what voice can't have done to another agent's session in a terminal (core/can.ts canDo), for <sessions>. */
function alsoCant(s: Session) {
  const can = canDo(s);
  const not = [can.interrupt ? "" : "stopped", can.rename ? "" : "renamed"].filter(Boolean);
  return not.length ? `; can't be ${not.join(" or ")} from here` : "";
}

/** What a session was last asked and said, and the topics you asked it about before (Timeline.topics). */
export type SessionNote = { asked: string; said: string; topics?: string[] };

/** The user's local date and time, from the system clock: "Monday 26 October 2026, 5:29 pm, America/Los_Angeles". */
export function localNow(at = new Date()) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = at.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "");
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${date}, ${time}, ${zone}`;
}

export type Action =
  | { name: "pass_on"; session: Session }
  | { name: "resend_to"; session: Session }
  | { name: "ask_session"; session: Session; message: string }
  /**
   * A name said that's no session's, likely `session`'s ("Macy" for Lacy) but not surely: the app asks
   * "Did you mean Lacy?" and keeps the words (`message`, or the user's own when ""), sent there on a yes.
   */
  | { name: "confirm_session"; session: Session; heard: string; message: string }
  /**
   * Unsure whether the words are for the app or for `session` (or which of two): the app asks "Want me
   * to send that to Bobby?" and keeps the user's own words, sent there on a yes (decide.ts guard).
   */
  /** `ask`: the words ask the app about `session` (decide.ts askedAbout): "Want me to ask Harbor?" instead. */
  | { name: "offer_session"; session: Session; ask?: boolean }
  | { name: "stop_session"; session: Session }
  | { name: "rename_session"; session: Session; newName: string }
  /**
   * A new session: in the project named as said (null: none named; "home"), or a new project by
   * that name; with a name and a first message, each "" for none. The app finds the folder (decide.ts startPlace).
   */
  | {
      name: "start_session";
      project: string | null;
      newProject: boolean;
      sessionName: string;
      prompt: string;
      /** The agent named for it, by its id ("codex"); "" for none named (decide.ts takes the setting's, else Claude Code). */
      agent?: string;
    }
  /** A read-only `claude -p` run in `cwd` (quick-task.ts). */
  | { name: "quick_task"; task: string; cwd: string }
  /** Your dictionary (dictionary.ts): write `write` where speech-to-text writes `heard`. */
  | { name: "add_to_dictionary"; heard: string; write: string }
  | { name: "remove_from_dictionary"; heard: string };

/** The tools that act on one session, by its handle. */
const SESSION_TOOLS = new Set(["pass_on", "resend_to", "ask_session", "confirm_session", "offer_session", "stop_session", "rename_session"]);

/**
 * A tool call the router dropped: `handle`, the session it named, isn't one in <sessions> (the
 * model made it up, or took a folder's name from the conversation: "2026-10-29-dozer").
 */
export type Dropped = { tool: string; handle: string; message?: string };

/**
 * How long the router may take (hedge.ts). It's usually done in 1–3s: since prompt caching
 * (2026-10-27), 359 logged routes had a median of 1.5s, a p99 of 3.4s and a slowest of 3.6s, besides
 * two ~15s ones. Not answered in 4s, a second request starts beside the first,
 * and the first answer is taken: a stalled request costs ~4s more, not ~12s. Each has 8s, above the
 * slowest real answer logged (6.6s, before caching, when prompts were longer), so a route gives up
 * after 12s at most, and your words are said not sent (app/talk.ts act).
 */
export const ROUTE_TIMING = { hedgeMs: 4000, attemptMs: 8000 };

/** The model's answer to one request: its tool calls, stray text, and what it cost. */
type Answer = { calls: Array<{ name: string; input: Record<string, unknown> }>; stray: string; usage: TokenUsage; costUsd: number };

/** Haiku (or the OpenRouter model picked in settings) for what's addressed to the app, or unclear. */
// Spoken output comes only from the say tool; `onText` sees any stray free text, which isn't spoken.
export class Router {
  // No retries of the SDK's own: they'd wait inside an attempt, unseen. The hedge is the retry.
  private client = anthropic({ maxRetries: 0 });
  private abort: AbortController | null = null;
  private timing: { hedgeMs: number; attemptMs: number };

  /** `timing`: the hedge's wait and each attempt's limit (ROUTE_TIMING); shorter in the unit tests. */
  constructor(timing = ROUTE_TIMING) {
    this.timing = timing;
  }

  async route(
    input: {
      sessions: Session[];
      notes: Map<string, SessionNote>;
      waitingId: string | null;
      /** Read out moments ago, its reply window closed since, and nothing announced or sent after it. */
      justSpoke: { id: string; secondsAgo: number } | null;
      lastId: string | null;
      recent: string[];
      text: string;
      /** The "Voice can" level: which tools are offered, and what the instructions say. */
      voiceCan: VoiceCan;
      /** Your dictionary, shown (with its tools) only when the words or the last ones are about it. */
      dictionary?: DictEntry[];
      /** The app asked which session these words were for, offering these sessions (decide.ts Question). */
      question?: { text: string; offered: Session[] } | null;
      /** The sessions the words call by a name of theirs (sessions.ts calledByName), shown as <named_in_words>. */
      named?: Session[];
      /** The sessions the words ask the app about (their status, what they said: decide.ts), shown as <asks_you_about>. */
      about?: Session[];
      /** The sessions also called by the app's name you started with (decide.ts nameAlso), shown as <name_up_front>. */
      nameAlso?: Session[];
      /** A session's name heard as other words up front (decide.ts heardAs: "Too rowing" for Rowan), shown as <name_heard_as>. */
      heardAs?: { session: Session; said: string };
      /** When the words were heard (Date.now() at the transcript): the log tells Kiko's wait from the model's. */
      heardAt?: number;
    },
    onText: (delta: string) => void,
  ): Promise<{ text: string; actions: Action[]; claimsAction: boolean; dropped?: Dropped[]; usage: TokenUsage; costUsd: number } | null> {
    const { sessions, notes, waitingId, justSpoke, lastId, recent, text, voiceCan } = input;
    // "Add to dictionary: …", or the answer to "how is it spelled?" right after one.
    const aboutDictionary = [text, ...recent.slice(-2)].some((t) => MENTIONS_DICTIONARY.test(t));
    // Short handles instead of UUIDs: cheaper, and nothing worth reading aloud.
    const handles = new Map(sessions.map((s, i) => [`s${i + 1}`, s]));
    const handleOf = (id: string | null) => [...handles].find(([, s]) => s.sessionId === id)?.[0] ?? "none";
    const named = (input.named ?? []).map((s) => handleOf(s.sessionId)).filter((h) => h !== "none");
    const about = (input.about ?? []).map((s) => handleOf(s.sessionId)).filter((h) => h !== "none");
    const nameAlso = (input.nameAlso ?? []).map((s) => handleOf(s.sessionId)).filter((h) => h !== "none");
    const heardAs =
      input.heardAs && handleOf(input.heardAs.session.sessionId) !== "none" ? { handle: handleOf(input.heardAs.session.sessionId), said: input.heardAs.said.replace(/["<>]/g, "") } : null;
    const lines = [...handles].map(([handle, s]) => {
      const kind = placeOf(s);
      const note = notes.get(s.sessionId);
      const context = note
        ? `\n    last asked: ${flat(note.asked, 200) || "(unknown)"}\n    last said: ${tail(note.said, 300) || "(nothing yet)"}` +
          (note.topics?.length ? `\n    asked before: ${note.topics.join("; ")}` : "")
        : "";
      // What it runs in the background, apart from its status ("idle · 2 in background"): not a turn.
      const background = backgroundNote(s);
      return `${handle}: ${sessionLabel(s)} · ${s.status}${background ? ` · ${background}` : ""} · active ${ago(s.lastActiveAt)} · ${kind}${context}`;
    });
    const prompt = [
      // First: just before what the user said, it swayed unrelated answers (the routing eval).
      `<now>${localNow()}</now>`,
      `<sessions>\n${lines.join("\n") || "(none running)"}\n</sessions>`,
      `<waiting_for_reply>${handleOf(waitingId)}</waiting_for_reply>`,
      ...(justSpoke && handleOf(justSpoke.id) !== "none" ? [`<just_spoke_to_you>${handleOf(justSpoke.id)}, ${justSpoke.secondsAgo}s ago (its reply window has closed)</just_spoke_to_you>`] : []),
      `<dealt_with_last>${handleOf(lastId)}</dealt_with_last>`,
      ...(named.length ? [`<named_in_words>${named.join(", ")}</named_in_words>`] : []),
      ...(about.length ? [`<asks_you_about>${about.join(", ")}</asks_you_about>`] : []),
      ...(nameAlso.length ? [`<name_up_front>${nameAlso.join(", ")}</name_up_front>`] : []),
      ...(heardAs ? [`<name_heard_as said="${heardAs.said}">${heardAs.handle}</name_heard_as>`] : []),
      `<recent_conversation>\n${recent.join("\n") || "(nothing yet)"}\n</recent_conversation>`,
      ...(input.question
        ? [
            `<asked_where>\nwords: ${input.question.text}\noffered: ${
              input.question.offered
                .map((s) => handleOf(s.sessionId))
                .filter((h) => h !== "none")
                .join(", ") || "any"
            }\n</asked_where>`,
          ]
        : []),
      ...(aboutDictionary ? [`<dictionary>\n${(input.dictionary ?? []).map((e) => `${e.heard} → ${e.write}`).join("\n") || "(empty)"}\n</dictionary>`] : []),
      `The user said: ${text}`,
    ].join("\n");

    // No session handles, names or folders in the tools: they're cached with the instructions, so
    // they stay the same whatever is running. <sessions> in the message lists them; the code checks.
    const SESSION = { type: "string", description: 'A session\'s handle from <sessions>, like "s1".' } as const;
    const folders = [...new Set(sessions.map((s) => s.cwd))];
    // A running session's folder: by its folder name as <sessions> shows it (or said loosely), or its handle.
    const folderOf = (arg = "") => handles.get(arg)?.cwd ?? folders.find((f) => sameName(folderName(f), arg));
    let tools: Anthropic.Tool[] = [
      {
        name: "say",
        description: "Speak to the user: an answer, or a short question.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Exactly what the user hears." },
            claims_action: {
              type: "boolean",
              description:
                'True if the text says something was or will be done: sent, passed on, asked, told, kept, left alone, stopped, started or renamed ("got it, I\'ll leave it", "I\'ve asked it"). False for an answer, a question, or saying what\'s off in settings.',
            },
          },
          required: ["text", "claims_action"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "pass_on",
        description: "Send the user's exact words to a session (the waiting one gets them as its reply).",
        input_schema: {
          type: "object",
          properties: { session: SESSION },
          required: ["session"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "resend_to",
        description: "The user's last message went to the wrong session: send that same message to this session, the one it was meant for.",
        input_schema: {
          type: "object",
          properties: { session: SESSION },
          required: ["session"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "ask_session",
        description: "Ask a session something on the user's behalf, in a message you write for that Claude.",
        input_schema: {
          type: "object",
          properties: {
            session: SESSION,
            message: { type: "string", description: "A short, clear message for that Claude." },
          },
          required: ["session", "message"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "confirm_session",
        description:
          'The user named a session by a name that is no session\'s, and this one is a likely but uncertain match (speech-to-text mangles names: "Marla" or "Margot" for a session called Margo): the app asks "Did you mean Margo?" and, on a yes, sends the words there. Instead of pass_on or ask_session, only when unsure.',
        input_schema: {
          type: "object",
          properties: {
            session: SESSION,
            heard: { type: "string", description: 'The name as the user said it, like "Marla".' },
            message: {
              type: "string",
              description: 'For a request to ask that session something ("ask Marla what\'s next"), the message as ask_session would write it; "" to send the user\'s own words.',
            },
          },
          required: ["session", "heard", "message"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "offer_session",
        description:
          "Only when you can't tell whether the user's words are for you or for this session, or which of two sessions they're for: the app asks \"Want me to send that to Bobby?\", keeps the user's exact words, and sends them there on a yes. When you can tell, pass_on instead. Never offer a session in say.",
        input_schema: {
          type: "object",
          properties: { session: SESSION },
          required: ["session"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "stop_session",
        description:
          "Interrupt a session's current turn, like pressing Escape in it. Doesn't stop background agents, builds or deploys it started: to stop those, pass_on the request to that session.",
        input_schema: {
          type: "object",
          properties: { session: SESSION },
          required: ["session"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "rename_session",
        description: "Give a session a new name, with Claude Code's /rename.",
        input_schema: {
          type: "object",
          properties: {
            session: SESSION,
            name: { type: "string", description: "The new name as the user said it, without quotes." },
          },
          required: ["session", "name"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "start_session",
        description:
          "Open a new coding session (Claude Code, unless the user names another agent) in a new terminal window. Only when the user asks for a new session. The app finds the project's folder by its name (a fresh scratch folder when none is named or it doesn't know it) and says where it opened.",
        input_schema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description:
                'The project or folder to open it in, as the user said it ("pixie", "my website"), whether or not a session runs there; "home" when they ask for their home folder; "" when they name none.',
            },
            new_project: {
              type: "boolean",
              description: 'True only when they ask for a new project to be made ("make a new project called pixel"): project is its name.',
            },
            name: { type: "string", description: 'A name they give the session ("named migrations" → "migrations"); "" when none.' },
            prompt: {
              type: "string",
              description: 'What they ask the new session to do beyond opening it, in their words ("open one in pixie and fix the login bug" → "Fix the login bug."); "" when nothing more.',
            },
            agent: {
              type: "string",
              description: agentAbout(),
            },
          },
          required: ["project", "new_project", "name", "prompt", "agent"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "quick_task",
        description:
          "Find something out on the user's computer with a one-off, read-only Claude Code run: disk space, battery, memory, uptime, what's running or listening on a port, files in a folder, a project's git status. It only looks, never changes anything. The app says it's checking, and speaks the answer when it's ready.",
        input_schema: {
          type: "object",
          properties: {
            task: { type: "string", description: 'What to find out, as a short plain request for Claude, like "How much free disk space is there?"' },
            folder: {
              type: "string",
              description: "Where to look from: \"home\" (the user's home folder), or a running session's folder as <sessions> shows it, when it's about that project.",
            },
          },
          required: ["task", "folder"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "add_to_dictionary",
        description:
          "Add a word to this voice app's speech-to-text dictionary: from now on, where speech-to-text writes `heard`, the app writes `write` instead. Only when the user asks this app to; never for a project's code.",
        input_schema: {
          type: "object",
          properties: {
            heard: { type: "string", description: 'The word or phrase as speech-to-text writes it, like "ghosty" or "clip kit".' },
            write: { type: "string", description: 'How to write it instead, spelled and capitalised as the user intends, like "Ghostty" or "clipkit".' },
          },
          required: ["heard", "write"],
          additionalProperties: false,
        },
        strict: true,
      },
      {
        name: "remove_from_dictionary",
        description: "Take a word out of this voice app's speech-to-text dictionary.",
        input_schema: {
          type: "object",
          properties: { heard: { type: "string", description: "The word or phrase it listens for, as <dictionary> lists it." } },
          required: ["heard"],
          additionalProperties: false,
        },
        strict: true,
      },
    ];

    // Every tool at every "Voice can" level: what the level doesn't allow, the app refuses in its own
    // words, with the setting's path and an offer to turn it on (decide.ts gated, core/voice-off.ts).
    // The dictionary's tools only for words about it.
    const DICTIONARY = ["add_to_dictionary", "remove_from_dictionary"];
    if (!aboutDictionary) tools = tools.filter((t) => !DICTIONARY.includes(t.name));

    this.abort = new AbortController();
    const signal = this.abort.signal;
    const instructions = system(voiceCan, aboutDictionary, about.length > 0, nameAlso.length > 0, heardAs !== null);
    const started = performance.now();
    // Kiko's own wait, from your words heard to the request: the rest of the time is the model's.
    const sinceHeardMs = input.heardAt ? Math.max(0, Date.now() - input.heardAt) : undefined;
    let answer: Answer;
    let tries: Try[];
    let won: number;
    try {
      ({ value: answer, tries, won } = await hedged((attempt, _n, note) => this.ask(instructions, prompt, tools, attempt, note), { signal, ...this.timing }));
    } catch (err) {
      if (signal.aborted) return null;
      // The app falls back to what it knows (decide.ts routeFailed); logged here with each try, for why.
      const ms = Math.round(performance.now() - started);
      const tries = (err as { tries?: Try[] }).tries;
      log("route_failed", { model: config.llm, text, ms, sinceHeardMs, error: err instanceof Error ? err.message : String(err), tries });
      // Every try ran out its time: with the relay down too, the Mac is taken as offline (core/online.ts).
      if (tries?.length && tries.every((t) => t.how === "timeout")) online.callTimedOut("router");
      throw err;
    } finally {
      this.abort = null;
    }
    const { calls, stray, usage, costUsd } = answer;
    // Stray text from the answer taken only, once it's taken: a hedge's two streams never mix.
    if (stray) onText(stray);
    // The timing of the request taken: its request id, time to the response and to the first token, why it stopped.
    const taken = tries.find((t) => t.n === won)?.info ?? {};
    const timing = {
      ms: Math.round(performance.now() - started),
      ...(sinceHeardMs !== undefined ? { sinceHeardMs } : {}),
      ...taken,
      retries: tries.length - 1,
      ...(tries.length > 1 ? { tries } : {}),
    };

    const actions: Action[] = [];
    const said: string[] = [];
    const dropped: Dropped[] = [];
    let claimsAction = false;
    for (const block of calls) {
      const args = block.input as {
        session?: string;
        folder?: string;
        text?: string;
        task?: string;
        message?: string;
        name?: string;
        heard?: string;
        write?: string;
        claims_action?: boolean;
        project?: string;
        new_project?: boolean;
        prompt?: string;
        agent?: string;
      };
      // A handle that isn't in <sessions> (the schema can't list them) names no session: that call is
      // dropped, and returned with the handle it was given, so the app can say what it couldn't find.
      const handle = (args.session ?? "").trim();
      const session = handles.get(handle.toLowerCase());
      if (SESSION_TOOLS.has(block.name) && !session) {
        dropped.push({ tool: block.name, handle, ...(args.message?.trim() ? { message: args.message.trim() } : {}) });
        continue;
      }
      if (block.name === "say" && args.text?.trim()) {
        said.push(args.text.trim());
        claimsAction ||= args.claims_action === true;
      } else if (block.name === "pass_on" && session) {
        actions.push({ name: "pass_on", session });
      } else if (block.name === "resend_to" && session) {
        actions.push({ name: "resend_to", session });
      } else if (block.name === "ask_session" && session && args.message?.trim()) {
        actions.push({ name: "ask_session", session, message: args.message.trim() });
      } else if (block.name === "confirm_session" && session) {
        actions.push({ name: "confirm_session", session, heard: (args.heard ?? "").trim(), message: (args.message ?? "").trim() });
      } else if (block.name === "offer_session" && session) {
        actions.push({ name: "offer_session", session });
      } else if (block.name === "stop_session" && session) {
        actions.push({ name: "stop_session", session });
      } else if (block.name === "rename_session" && session && args.name?.trim()) {
        actions.push({ name: "rename_session", session, newName: args.name.trim() });
      } else if (block.name === "start_session") {
        // The project as said; a session's handle, as its folder. Which folder that is, the app works out.
        const said = (args.project ?? "").trim();
        const project = handles.get(said.toLowerCase())?.cwd ?? said;
        actions.push({
          name: "start_session",
          project: project ? (project.startsWith("/") ? folderName(project) : project) : null,
          newProject: args.new_project === true && Boolean(project),
          sessionName: (args.name ?? "").trim(),
          prompt: (args.prompt ?? "").trim(),
          ...(args.agent && agentChoices().includes(args.agent) ? { agent: args.agent } : {}),
        });
      } else if (block.name === "quick_task" && args.task?.trim()) {
        const cwd = folderOf(args.folder) ?? homedir();
        actions.push({ name: "quick_task", task: args.task.trim(), cwd });
      } else if (block.name === "add_to_dictionary" && args.heard?.trim() && args.write?.trim()) {
        actions.push({ name: "add_to_dictionary", heard: args.heard.trim(), write: args.write.trim() });
      } else if (block.name === "remove_from_dictionary" && args.heard?.trim()) {
        actions.push({ name: "remove_from_dictionary", heard: args.heard.trim() });
      }
    }
    log("route", { model: config.llm, prompt, stray: stray || undefined, calls, ...(dropped.length ? { dropped } : {}), usage, costUsd, ...timing });
    return { text: said.join(" "), actions, claimsAction, dropped, usage, costUsd };
  }

  /**
   * One request to the model, cut off when `signal` aborts (a new press, its time limit, or the
   * other request answering first). `note` puts the request's id, its time to the response
   * (`headersMs`) and to the first token, and why it stopped on its line in the log.
   */
  private async ask(instructions: string, prompt: string, tools: Anthropic.Tool[], signal: AbortSignal, note: (info: Record<string, unknown>) => void): Promise<Answer> {
    // An OpenRouter model when one is picked in settings; Haiku through the Anthropic API otherwise.
    if (config.llm !== "haiku") {
      const r = await callTools({
        model: config.llm,
        system: instructions,
        prompt,
        maxTokens: 400,
        tools: tools.map((t) => ({ ...t, description: t.description ?? "" })),
        cache: true,
        signal,
        call: "routing",
      });
      note({ ...(r.id ? { requestId: r.id } : {}), ...(r.stop ? { stop: r.stop } : {}) });
      return { calls: r.calls, stray: r.text, usage: r.usage, costUsd: r.costUsd };
    }
    const start = performance.now();
    const since = () => Math.round(performance.now() - start);
    const stream = this.client.messages.stream(
      {
        model: config.summaryModel,
        max_tokens: 400,
        // Latency over depth: no thinking, low effort.
        thinking: { type: "disabled" },
        output_config: { effort: config.summaryEffort },
        // Tools and instructions are cached together (tools render first): ~2,800–4,800 tokens, the
        // same on every call at a "Voice can" level, whatever sessions are running. What changes per
        // call, from <now> on, is in the user message after the breakpoint. A warm call costs about
        // a third.
        system: [{ type: "text", text: instructions, cache_control: { type: "ephemeral" } }],
        tools,
        // Tools only: no free text, which without thinking tends to be reasoning said out loud.
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: prompt }],
      },
      { signal },
    );
    let stray = "";
    let first = true;
    stream.on("connect", () => note({ headersMs: since(), ...(stream.request_id ? { requestId: stream.request_id } : {}) }));
    stream.on("streamEvent", (event) => {
      if (!first || event.type !== "content_block_start") return;
      first = false;
      note({ firstTokenMs: since() });
    });
    stream.on("text", (delta) => (stray += delta));
    const final = await stream.finalMessage();
    note({ stop: final.stop_reason });
    const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input as Record<string, unknown> }));
    return { calls, stray, usage: final.usage, costUsd: cost.haiku(final.usage) };
  }

  cancel() {
    this.abort?.abort();
  }
}
