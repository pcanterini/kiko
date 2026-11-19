// Where your words go and what the app does with them, decided without doing any of it: the code
// shortcuts, the classifier, the router and the code guards on its tool calls, in that order. The models come
// in through `deps`, so the app (app/deliver.ts deliver()) and the tests run this same function; the app
// then carries out the actions it returns (sends, speaks, stops, renames, starts).
import { homedir } from "node:os";
import type { ApprovalDecision, SessionInfo, UtteranceDecision } from "./decisions.ts";
import type { Action as RouterAction, Dropped, Router, SessionNote } from "./router.ts";
import {
  AND_ALSO,
  APP_PARTS,
  ASKED_FOR_NEW,
  BARE_STOP,
  CHANGE_REQUEST,
  DICTIONARY_REQUEST,
  dropsQuestion,
  INTENT_MIN_CONFIDENCE,
  isClosing,
  MOVE_IT,
  NAMED_MIN_CONFIDENCE,
  NEVER_MIND,
  NOT_A_MESSAGE_QUESTION,
  OTHER_THAN_PENDING,
  permissionAnswer,
  POINTS_ELSEWHERE,
  QUICK_CANCEL,
  quotesTakeBack,
  EVERY,
  HELD_CANCEL,
  NO_FALLBACK,
  SKIP,
  asksTrustScratch,
  asksUpgrade,
  upgradeInterval,
  TRY_AGAIN,
  pronunciationRequest,
  REPEAT_FALLBACK,
  RETRACTED_MIN,
  retraction,
  answerTakenBack,
  endsInTakeBack,
  YES_FALLBACK,
  bareReply,
  voiceAllows,
  aboutVoiceApp,
  asksYou,
  WHICH_SESSION,
  DID_YOU_MEAN,
  OFFERS_SESSION,
  OFFER_FILLER,
  OFFER_NOT,
  OFFER_YES,
  moreRequest,
  livenessCheck,
  livenessLine,
  namesSaidToApp,
  appLeftOff,
  appWordsOff,
  saidToAppParts,
  SEND_KEPT,
} from "./routing-rules.ts";
import {
  addressedTo,
  APP_FOLDER,
  asNumbered,
  findSession,
  folderName,
  heardWords,
  mentionsSession,
  namedLikeAppName,
  namesSession,
  nameWords,
  callNames,
  sameName,
  sameNumberedName,
  saidNumber,
  sessionName,
  sessionNumber,
  sessionsNamed,
  addressedByName,
  askedAbout,
  calledByName,
  isStarting,
  splitBySession,
  partForUnknown,
  spoken,
  spokenWithTitle,
  type Addressed,
  type Session,
  type SessionPart,
} from "./sessions.ts";
import type { VoiceCan } from "./settings.ts";
import { andList, orList } from "./text.ts";
import type { Trim } from "./trim.ts";
import { cutFromCleaned, type Cleanup } from "./cleanup.ts";
import { directionOff } from "./direction.ts";
import { POINTS_BACK, routerWords } from "./router-words.ts";
import { keyOf, type DictEntry } from "./dictionary.ts";
import { topicWords } from "./timeline.ts";
import { directedAtName, leadingName, nameTakenOff, type Lead } from "./wake.ts";
import { offFromWords, SAYS_OFF_IN_SETTINGS, TURN_ON, VOICE_ON } from "./voice-off.ts";
import { distance, nearDistance, sounded } from "./words.ts";
import { nameHeardAs, soundsLikeIn } from "./heard-as.ts";
import { isHome, listProjects, sessionFolders, startPlace, type Project, type StartPlace } from "./projects.ts";
import { elsewhere, starters } from "../agents/index.ts";
import { keptLine, notDoneLine, NOTHING_KEPT_LINE, type FallbackWhy } from "./fallback.ts";
import type { Agent } from "../agents/types.ts";

/** A session to send to: one from the list, or the waiting one when the list doesn't have it. */
export type Target = { sessionId: string; cwd: string };

/** Your last words that went to a session; `folder` is what that session is called (its name now). */
export type Sent = {
  sessionId: string;
  folder: string;
  text: string;
  /** The other sessions the same words went to in the same go (the router asked several). */
  also?: Array<{ sessionId: string; folder: string }>;
  /** Not gone yet: the app holds them (a send it wasn't sure of), so nobody got them. */
  held?: boolean;
  /** They never reached `sessionId` (nothing could type them in: timeline Entry.notSent), so it didn't get them. */
  notSent?: boolean;
  /** "No, cancel that" took them back (timeline Entry.undone): a correction sends them on with nothing to stop. */
  undone?: boolean;
};

/**
 * The app asked which session your words were for ("Which session should it go to, Lacy or
 * Kiko?"), so they went nowhere yet: `text`, those words as they'd have gone (cleaned up when the
 * clean-up is on); `offered`, the sessions the question named, in its order (every one it can reach
 * when it named none); `line`, the question. The app keeps it until your next words, or QUESTION_MS.
 * `told`: your words moved on from it, and the app said they weren't sent (question.ts): kept for a
 * plain pick only ("Kiko.", "the first one"), read in code. Nothing else takes it: not a cancel
 * (there's nothing to cancel), not words with more to them, and not the router.
 * `offer`: the app offered to send them to the one session offered ("Want me to send that to
 * Bobby?": the router's offer_session, or its own words offering it): a yes ("yeah, pass it to
 * Bobby", "send it", "go ahead") sends them there; no drops them, and so do words that move on (they
 * go where they would have, and the offer isn't kept: app/deliver.ts settleQuestion).
 * `kept`: words kept when the router couldn't answer, routed again minutes later, and asked about
 * first (app/deliver.ts retryKept: "Still send "Nice, this one reads…" to Rowan?"): they stay kept
 * (core/kept.ts), so moving on still leaves them for "send it" or a name; a yes or a pick sends
 * them and a no drops them, either way kept no longer.
 */
export type Question = { text: string; offered: string[]; line: string; told?: boolean; offer?: boolean; kept?: boolean };

export type DecideState = {
  text: string;
  sessions: Session[];
  /** What each was last asked and said, and the topics you asked it about before. */
  notes: Map<string, SessionNote>;
  /** Timeline.lines(timeline.recent(8)). */
  recent: string[];
  /**
   * The hook request held open: a finished turn waiting for a reply, or a permission prompt (what it
   * asks), which may be the session's own questions (`questions`: Claude's multiple choice, ask.ts).
   */
  waiting: (Target & { permission?: string; questions?: boolean }) | null;
  /** Read out moments ago; its reply window closed since. */
  justSpoke: { id: string; secondsAgo: number } | null;
  /** The session dealt with last (the app's `target`). */
  lastId: string | null;
  /** The app's last words were a question to you, moments ago. */
  appAsked: boolean;
  /**
   * Your last words that went to a session, while that's the latest thing the app did for you
   * (timeline.lastSent(…, true)); or the send the app is holding, which a correction redirects.
   */
  lastSent: Sent | null;
  /** A send the app wasn't sure of is held, not gone yet: "cancel" drops it. */
  holding?: boolean;
  /** An announcement you haven't heard waits (your press put it back, or it's next in line): "skip that" drops it. */
  skippable?: boolean;
  /** The app's answer to your previous words was a repeat: a correction now is about that. */
  lastRepeat: boolean;
  /**
   * The session whose finished turn you last heard summed up (its timeline entry has `spoken`): what
   * "more" is about when your words name none. None heard yet: "more" is words like any others.
   */
  heardFrom?: string | null;
  voiceCan: VoiceCan;
  /** A quick task running (quick-task.ts): "stop" or "cancel" now ends it. */
  quickTask?: { task: string } | null;
  /**
   * The app's last words offered a session for a quick task it couldn't finish (quick-ask.ts
   * HAND_OFF_LINE, or needsChanges): yes starts one in its folder with the task as its prompt; one
   * from the home folder (a Mac setting: no project's) in a scratch folder, unless you say "home".
   */
  handOff?: { task: string; cwd: string } | null;
  /**
   * The app's last words, moments ago, were the offer to turn Voice can up (core/voice-off.ts
   * voiceOffLine: "… Say turn it on, and I'll do it now."), after it stopped something you asked:
   * "turn it on", or a plain yes with no session waiting for a reply, sets it to Everything and
   * carries that out (voice_on).
   */
  voiceOffer?: boolean;
  /**
   * Your words that just failed to reach a session you can put right (its terminal on Claude Code's
   * agents list, or not told apart from another), kept a moment: "try again" sends them there.
   */
  retry?: { session: Target; text: string } | null;
  /** At or above this, the classifier's pick of a session is where the words go. */
  classifierMinConfidence: number;
  /** Kiko Pro is on sale (core/env.ts proOnSale): "upgrade" to the app opens its checkout (routing-rules.ts asksUpgrade). */
  proOnSale?: boolean;
  /**
   * Where a new session can open by name (core/projects.ts), asked for only when one is asked for;
   * the running sessions' folders are added to them. None: only those.
   */
  projects?: () => Project[];
  /** Where "make a new project called Pixel" makes it (projects.ts newProjectRoot); null: nowhere set. */
  newProjectRoot?: string | null;
  /** Your dictionary, for the router when your words are about it. */
  dictionary?: DictEntry[];
  /**
   * Said inside a session's screen (the phone's session view): the words are for it, as if you'd
   * named it up front. "Kiko, …" still goes to the app.
   */
  to?: Target | null;
  /** The app's "which session?" question about words that went nowhere yet: what you say now may answer it. */
  question?: Question | null;
  /** When the words were heard (Date.now() at the transcript), for the router's log line: how long Kiko took to ask it. */
  heardAt?: number;
  /**
   * Your words kept after the router couldn't answer (core/kept.ts), oldest first: "send it" routes
   * them again now, "send that to Rowan" or a name alone sends them there.
   */
  kept?: { texts: string[] } | null;
};

type RouteInput = Parameters<Router["route"]>[0];
type RouteResult = NonNullable<Awaited<ReturnType<Router["route"]>>>;

export type DecideDeps = {
  /** The classifier on what you said; null when the classifier is off. */
  utterance:
    | ((input: {
        text: string;
        sessions: SessionInfo[];
        waitingId: string | null;
        justSpoke: { id: string; secondsAgo: number } | null;
        lastId: string | null;
        recent: string[];
      }) => Promise<UtteranceDecision>)
    | null;
  /** The classifier on a permission answer; null when the classifier is off. */
  approval: ((input: { request: string; text: string }) => Promise<ApprovalDecision>) | null;
  /** The router (Router.route); null back means it was cancelled. */
  route: (input: RouteInput) => Promise<RouteResult | null>;
  /** The trim of parts meant for the app (trimForClaude); null skips it (phrase trims still apply). */
  trim: ((input: { text: string; to: Session | Target; sessions: Session[] }) => Promise<Trim>) | null;
  /**
   * Your words cleaned up (cleanUp): the "uh"s, stutters and false starts left out. Asked once, as
   * soon as your words could be for a session, while the classifier and the router decide; only words that go
   * to a session use it. Absent or null: your words go as said.
   */
  clean?: ((text: string) => Promise<Cleanup>) | null;
  /** Called just before the router is asked with `text`, your words as decided on (the app notes them and the turn then). */
  beforeRoute?: (text: string) => void;
  /**
   * Why the network is known to be down now (core/online.ts), or null: the classifier and the router
   * aren't asked then, and the fallback is at once. Asked as each is about to be: it can go down
   * while your words are decided.
   */
  offline?: (() => string | null) | null;
};

/** Words for a session, minus what was cut as meant for the app. */
export type Trimmed = { kept: string; dropped: string[]; by: "phrase" | "model"; ms?: number };

/** The send's words were cleaned up: `said` is what would have gone otherwise. */
export type Cleaned = { said: string; ms: number };

/**
 * What the app does. A send, ask or resend is `unsure` (why, for the log) when the router, or a
 * code guard on its pick, chose the session: not your words, not the session waiting for your
 * reply, not the classifier at its bar (unsureWhy). The app says where it's going and holds it a moment first.
 */
export type Act =
  | { type: "permission"; answer: ApprovalDecision["answer"] }
  /** Your words to the question the session asks (ask.ts): the app matches them to its options. */
  | { type: "answer"; text: string }
  /** Say again a session's last summary, or with no session the last thing said. */
  | { type: "repeat"; session: Session | null }
  | { type: "wrap_up" }
  | { type: "undo" }
  /** "Skip that": the announcement you haven't heard isn't made. */
  | { type: "skip" }
  /** "More", "more about the tests": a longer summary of a session's last reply heard, or all it says about `topic`. */
  | { type: "more"; sessionId: string; topic: string | null }
  /**
   * Your words to a session: its reply when it's waiting, else typed in. `line`: said as they go in
   * place of "To Lacy." (words kept and sent by a retry: "Sent to Rowan.", app/deliver.ts retryOne).
   */
  | { type: "send"; session: Target; text: string; trimmed?: Trimmed; cleaned?: Cleaned; from?: "start_session"; unsure?: string; line?: string }
  /** ask_session: a message the router wrote. */
  | { type: "ask"; session: Session; message: string; unsure?: string }
  /**
   * "No, that was for clipkit": the last message, to the session it was meant for. `text`: the words
   * that go when not as sent: without the name heard wrong up front ("Too rowing, …" for Rowan: heard-as.ts).
   */
  | { type: "resend"; session: Session; last: Sent; text?: string; unsure?: string }
  /** Escape in a session. */
  | { type: "stop"; session: Session }
  /** stop_session the BARE_STOP guard dropped. */
  | { type: "stop_ignored"; session: Session }
  | { type: "rename"; session: Session; name: string }
  /**
   * A new session where `where` says, named `name`, with `prompt` as its first message (each "" for
   * none), in `agent` (an agent's id, named in your words: "a Codex session"; "" for your default).
   * `app`: asked of an agent whose sessions start in its own app (T3 Code: "a T3 thread in pixie"),
   * started there; `agent` is then what runs it there, or what starts in its place when it isn't open.
   */
  | { type: "start"; where: StartPlace; name: string; prompt: string; agent?: string; app?: string }
  /** A read-only `claude -p` run for a question about the computer, answered out loud when done. */
  | { type: "quick_task"; task: string; cwd: string }
  /** Ends the quick task running. */
  | { type: "cancel_quick" }
  /** Your dictionary: write `write` from now on where speech-to-text writes `heard`, or stop. */
  | { type: "dictionary"; op: "add"; heard: string; write: string }
  | { type: "dictionary"; op: "remove"; heard: string }
  /** How the voice says a word (pronunciation.ts), for the voice in use. `word` as heard: the app finds its spelling. */
  | { type: "pronounce"; op: "add"; word: string; say: string }
  | { type: "pronounce"; op: "forget"; word: string }
  /** "Trust the scratch folder": Claude Code opened in the scratch folder for its trust prompt, once (app/starting.ts trustScratch). */
  | { type: "trust_scratch" }
  /** "Upgrade to Pro": Kiko Pro's checkout opened in the browser (app/settings/account.ts startCheckout), while it's on sale. */
  | { type: "upgrade"; interval: "month" | "year" }
  /**
   * The "Voice can" level doesn't allow it: the app says what's off, where it's turned on, and offers
   * to turn it on now (core/voice-off.ts). `then`: what was asked, carried out once you say yes.
   */
  | { type: "refused"; what: "stop" | "start" | "rename" | "check" | "dictionary"; session?: Session; then?: Act }
  /** Yes to that offer: Voice can set to Everything, and what it stopped carried out. */
  | { type: "voice_on" }
  /** The app speaks. `why` names the guard that wrote it, for the log; `offer`, a session it offers for a task (a yes starts it: handOff). */
  | { type: "say"; text: string; why?: string; offer?: { task: string; cwd: string } };

export type Step =
  | "name-only"
  | "question"
  | "permission"
  | "answer"
  | "quick-cancel"
  | "skip"
  | "liveness"
  | "more"
  | "pronounce"
  | "repeat-fallback"
  | "closing"
  | "retracted"
  | "move-it"
  | "confirm"
  | "hand-off"
  | "voice-on"
  | "retry"
  | "stop-named"
  | "app-question"
  | "dictionary"
  | "trust-scratch"
  | "upgrade"
  | "which-numbered"
  | "which-named"
  | "resend-which"
  | "split"
  | "addressed"
  | "about"
  | "held-cancel"
  | "classifier"
  | "classifier-intent"
  | "named"
  | "waiting-fallback"
  | "kept"
  | "router";

export type Decision = {
  /** Which step decided. */
  step: Step;
  /** Your words as decided on: as said, less the app's name up front when you said it to the app. */
  text: string;
  /** You started with the app's name, said to it ("Kiko, …"): taken off `text`. */
  toApp?: boolean;
  /** With `toApp`, what was taken off ("Kiko,", "To, uh, Kiko."), for the log. */
  nameSaid?: string;
  /**
   * With `toApp`, the sessions also called by that name ("Kiko project"), when the rest names none:
   * the router is told (<name_up_front>), so words about that project lean there.
   */
  nameAlso?: string[];
  actions: Act[];
  utterance?: UtteranceDecision;
  approval?: ApprovalDecision;
  router?: RouteResult;
  /** Model calls that failed; deciding carried on without them. */
  errors: Array<{ where: string; message: string }>;
  /** Code guards that changed where your words go, for the log. */
  guards?: Guarded[];
  /**
   * Your words correct where your last words went ("no, that was for clipkit", "wrong one"),
   * whether or not it was found where they belong.
   */
  correction?: boolean;
  /**
   * What became of the app's "which session?" question: asked just now (the app keeps it), answered
   * (the words it was about went to `sessionId`, found `how`, with `added`, the rest of your answer),
   * or dropped ("never mind", "neither").
   */
  question?: { kind: "asked"; question: Question } | { kind: "answered"; sessionId: string; how: PickHow; added?: string } | { kind: "cancelled" };
  /**
   * A name said that's no session's, taken as `sessionId`'s: asked about ("Did you mean Lacy?",
   * the router's confirm_session) or sent there as the router's guess ("routed"), with how far the
   * name said is from it (`score`, 1 the same as said, 0 nothing alike), for the log.
   */
  guess?: { heard: string; sessionId: string; how: "asked" | "routed"; score: number };
  /**
   * Your words open with what sounds like a session's name heard as other words ("Too rowing, …" for
   * Rowan: heard-as.ts nameHeardAs): `heard`, those words; `said`, all that opened them up to the pause,
   * cut from what goes there; `rest`, what's left. A guess, never a name said: the router is told
   * (<name_heard_as>), and a send there is said and held a moment.
   */
  heardAs?: { sessionId: string; heard: string; said: string; rest: string };
  classifierCostUsd: number;
  /** The router and the trim. */
  llmCostUsd: number;
  /**
   * The router gave no answer (`skipped`: not asked, the network known to be down), and what the app
   * did instead: kept the words (`kept`), or only said so.
   */
  fallback?: { why: FallbackWhy; error: string; skipped: boolean; kept: boolean };
  /** Words to keep and route again (core/kept.ts). */
  keep?: { text: string };
  /** The words kept before were taken: sent (`sent`), or decided again as if just said (`redecided`). */
  keptUsed?: "sent" | "redecided";
  /** The network was known to be down: the classifier wasn't asked (why, for the log). */
  offline?: string;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Liveness checks answered so far, so the answer isn't the same twice in a row (livenessLine). */
let livenessCount = 0;

/**
 * Works out who your words are for and what the app should do with them. Words for the app are
 * never passed on: a send left with nothing of the session's in it (all of it was said to the app:
 * "…, and Kiko, slow down") doesn't go, and logged (app_words); with nothing else to do, the router
 * answers the words as the app's.
 */
export async function decide(s: DecideState, deps: DecideDeps): Promise<Decision> {
  const d = await decideWords(s, deps);
  // Only when the app was spoken to by name: a plain "Okay." or "Then." to a session is its own (a reply, often).
  const toApp = namesSaidToApp(d.text).length > 0;
  const empty = (a: Act) => toApp && a.type === "send" && !sessionWords(a.text);
  if (!d.actions.some(empty)) return d;
  for (const a of d.actions.filter(empty)) {
    if (a.type === "send") (d.guards ??= []).push({ rule: "app_words", by: d.step, from: a.session.sessionId, fromName: "", to: null, text: d.text });
  }
  d.actions = d.actions.filter((a) => !empty(a));
  if (!d.actions.length && d.step !== "router") {
    await route({ ...s, text: d.text }, deps, d, null, [], "say");
    d.actions = d.actions.filter((a) => !empty(a));
  }
  return d;
}

/** Fillers and openers only ("Okay.", "And, uh,"): nothing for a session. */
const NOT_FOR_A_SESSION = new Set("uh um umm uhm ah er erm hmm mm ok okay and so also please thanks thank you oh well now then but".split(" "));
const sessionWords = (text: string) =>
  wordsOf(text)
    .split(" ")
    .some((w) => w && !NOT_FOR_A_SESSION.has(w));

async function decideWords(s: DecideState, deps: DecideDeps): Promise<Decision> {
  // "Kiko two, run the tests", "tell atlas agents number two …", "atlas agents too, …": a number said
  // after a numbered name, written as that session's name ("Kiko project 2", "atlas agents 2") for
  // every rule below, the models and the words that go (sessions.ts asNumbered). First, so "Kiko"
  // up front with a number after it is that session, not the app.
  const numbered = asNumbered(s.text, s.sessions);
  if (numbered !== s.text) s = { ...s, text: numbered };
  const out: Decision = { step: "router", text: s.text, actions: [], errors: [], classifierCostUsd: 0, llmCostUsd: 0 };
  // "Kiko, ask Lacy if it deployed": the app's name up front only says who you're talking to
  // (wake.ts). The rest goes as any words would; the name alone is nothing said.
  // Not "Hey kiko dev, …": the app's name there starts a session's, and that's who it's said to.
  // "To, uh, Kiko. …", "Tell Kiko to run the tests": a direction before the app's name names who the
  // words are for, so with a session named like the app ("Kiko project", the kiko folder) it's that
  // session's name, not the wake (wake.ts directedAtName). Once, taken as the app's name, the
  // direction went with it, and the router gave the rest to the session dealt with last.
  // Not while a session's prompt waits (your words answer it), nor when the rest is itself for
  // another session ("tell Kiko to ask Rowan …"); with none named like the app, as before.
  const directed = directedToAppNamed(s);
  const lead: Lead = directed || addressedByName(s.sessions, s.text).length ? { addressed: false, rest: s.text } : leadingName(s.text);
  // The app asked which session your words were for: an answer that only picks one sends them
  // there, read in code, before the app's name is taken off ("Kiko." picks the Kiko session).
  // Not while a permission prompt waits: your words answer that.
  if (s.question && s.waiting?.permission === undefined) {
    const answered = await answerQuestion(s, deps, out, s.question, lead);
    if (answered) return answered;
  }
  // Words you already moved on from: only a plain pick sends them. Everything else is new words, as
  // if no question were kept; the router doesn't see it, so it can't mix them in.
  if (s.question?.told) s = { ...s, question: null };
  if (lead.addressed) {
    out.nameSaid = nameTakenOff(s.text, lead);
    // "Kiko, …" about the Kiko project's work: the name up front is the app's, and it's also that
    // session's. The router is told, so a question about that project leans there, not to the one
    // dealt with last; not when the rest names a session ("Kiko, ask Rowan if it deployed").
    const alsoNamed = lead.rest ? namedLikeAppName(s.sessions) : [];
    if (alsoNamed.length && !namesSession(s.sessions, lead.rest)) out.nameAlso = alsoNamed.map((x) => x.sessionId);
    s = { ...s, text: lead.rest };
    out.text = lead.rest;
    out.toApp = true;
    if (!lead.rest) {
      out.step = "name-only";
      return out;
    }
  }
  const { text, sessions, waiting } = s;
  const waitingId = waiting?.sessionId ?? null;
  const done = (step: Step, ...actions: Act[]) => {
    out.step = step;
    out.actions.push(...actions);
    return out;
  };

  // "Kiko, say nginx as engine-x", "Kiko, forget how to say tmux": how the voice says a word.
  // Said to the app by name, so it's the app's even with a permission prompt waiting.
  const pronounce = out.toApp ? pronunciationRequest(text) : null;
  if (pronounce) return done("pronounce", { type: "pronounce", ...pronounce });
  // Words that end by taking themselves back ("…actually, never mind"; retraction): nothing in them goes.
  const takesBack = retraction(text);
  // An answer to a yes or a no that takes itself back ("Yes. Actually, never mind."): it confirms nothing.
  const takenBack = answerTakenBack(text);
  const notSent: Act = { type: "say", text: "Okay, not sent.", why: "retracted" };
  // The session's own questions are waiting: your words answer the one being asked (app.ts matches
  // them). "Option two, actually, never mind" and "Yes. Never mind." answer nothing, and the question stays.
  // A take-back with more after it ("Option two. Never mind, option three.") answers with what follows.
  if (waiting?.questions) return takenBack === "taken" && endsInTakeBack(text) ? done("retracted", notSent) : done("answer", { type: "answer", text });
  // A permission prompt is waiting: your words answer it.
  if (waiting?.permission !== undefined) {
    let d: ApprovalDecision | null = null;
    if (deps.approval) {
      try {
        d = await deps.approval({ request: waiting.permission, text });
        out.approval = d;
        out.classifierCostUsd += d.costUsd;
      } catch (err) {
        out.errors.push({ where: "classify_approval", message: message(err) });
      }
    }
    // "Allow it… actually, never mind", "Yes. Never mind." approve nothing (nor deny): the prompt is
    // asked again. "No, never mind." is a no, as the classifier or the phrases read it.
    return done("permission", { type: "permission", answer: takesBack || takenBack === "taken" ? "unclear" : permissionAnswer(text, d) });
  }
  // "Cancel", "never mind" while a send the app wasn't sure of is held: it doesn't go.
  if (s.holding && HELD_CANCEL.test(text)) return done("held-cancel", { type: "undo" });
  // "Stop", "cancel that" while a quick task runs: that's what to stop.
  if (s.quickTask && QUICK_CANCEL.test(text)) return done("quick-cancel", { type: "cancel_quick" });
  // "Skip that" while an announcement you haven't heard waits: it isn't made. Not a cancel of a held
  // send ("skip" isn't one), and with nothing to skip, words like any others.
  if (s.skippable && SKIP.test(text)) return done("skip", { type: "skip" });
  // "Can you hear me?", "Are you there?", "Testing.": only the app hears you, so it answers, at once
  // and with no model, whoever you dealt with last, is waiting, or whose screen you're in
  // (routing-rules.ts livenessCheck). A session named in them ("Test, are you there?") gets them, below.
  const live = livenessCheck(text, (part) => !aboutVoiceApp(part) && sessions.some((x) => [sessionName(x), folderName(x.cwd), x.title ?? ""].some((n) => n && sameName(n, part))));
  if (live) return done("liveness", { type: "say", text: livenessLine(live, livenessCount++), why: "liveness" });
  // "More", "tell me more about the failing tests": the app says more of a reply it summed up. Read in
  // code, before the words could go to the session waiting (or the one whose screen they're said in).
  const more = moreOf(s);
  if (more) return done("more", more);
  // "Try again" right after your words couldn't reach a session: the same words, to the same one.
  // Not with a finished turn waiting: there it's a reply ("try again" to "the build failed").
  if (s.retry && !waiting && TRY_AGAIN.test(text)) return done("retry", { type: "send", session: s.retry.session, text: s.retry.text });
  // Words kept when the router couldn't answer (core/kept.ts, 2026-11-12): "send that to Rowan" or the
  // name alone ("Rowan.") sends them there at once, offline or not: a name isn't a guess. "Send it"
  // decides them again now, as if just said: the router works out where (no session is ever guessed).
  // Read in code, no model. Not a bare "send it" or name while a session waits for your reply: that's its reply.
  const kept = s.kept?.texts.length ? keptFor(s, text) : null;
  if (kept === "redo") {
    // Kept as they'd have gone (cleaned up already): the clean-up started for "send it" isn't theirs.
    const again = await decide({ ...s, text: s.kept!.texts.join("\n\n"), kept: null, question: null, appAsked: false, retry: null }, { ...deps, clean: null });
    again.keptUsed = "redecided";
    return again;
  }
  if (kept) {
    if (kept.type === "send") out.keptUsed = "sent";
    return done("kept", kept);
  }
  if (!deps.utterance && REPEAT_FALLBACK.test(text)) return done("repeat-fallback", repeat(s));
  // "Stop Lacy?", asked when your words only came close to its name; "Stop which one?"; the offer of
  // a session after a quick task (handOff): the app's own questions, read in code below.
  const confirming = s.appAsked ? stopAsked(s) : null;
  const stopWhich = s.appAsked && s.recent.at(-1) === `app said: ${STOP_WHICH}`;
  const offered = s.appAsked ? (s.handOff ?? null) : null;
  const voiceOffer = Boolean(s.voiceOffer);
  // "Stop Lacy?" answered "Yes. Actually, never mind." stopped Lacy: the "yes" up front was read
  // first, and the take-back ended words with nothing of their own. An answer to one of the app's
  // questions that takes itself back confirms nothing: its no ("Okay, I'll leave it."), `retracted`
  // logged. Read in code, no model, before a wrap-up (isClosing) or a yes: when in doubt, nothing is
  // stopped or started. "No, never mind." and "Never mind." are its plain no. A clear yes after it
  // ("Yeah, never mind, do it") stands. The same for a short answer to a question the router reads
  // ("Want me to open a new session for that?"), where a plain no still goes on as before; longer
  // words are new ones, and the take-back is checked with the classifier below as for any. Not "which session?"
  // (answerQuestion, above: "Lacy. Never mind, Kiko." picks again).
  const answer = !s.question && wordsOf(text).split(" ").length <= ANSWER_WORDS;
  if (s.appAsked && takenBack && (confirming || stopWhich || offered || (takenBack === "taken" && answer))) {
    const why = takenBack === "taken" ? "retracted" : offered ? "hand_off_declined" : "stop_declined";
    return done(offered ? "hand-off" : confirming || stopWhich ? "confirm" : "app-question", { type: "say", text: "Okay, I'll leave it.", why });
  }
  // "…Say turn it on, and I'll do it now." after Voice can stopped something: "turn it on", or a
  // plain yes with no session waiting for one, turns it on and does it. Before a wrap-up ("Okay, do
  // it."). Not words that take themselves back ("Yes. Actually, never mind.").
  if (voiceOffer && !takenBack && !takesBack && (TURN_ON.test(text) || (!waiting && YES_FALLBACK.test(text)))) return done("voice-on", { type: "voice_on" });
  // "Never mind." with nothing waiting, right after your words went to a session: take them back.
  // Not as the answer to "That already went to clipkit. Which session was it for?": that drops the
  // correction, and the words stay where they went.
  const resendAsked = s.appAsked && RESEND_ASKED.test(s.recent.at(-1) ?? "");
  if (isClosing(text)) return done("closing", !waiting && s.lastSent && !resendAsked && NEVER_MIND.test(text) ? { type: "undo" } : { type: "wrap_up" });
  // The classifier on your words, asked once: here when they may take themselves back, else further down.
  const reachable = sessions.filter((x) => x.place || x.sessionId === waitingId);
  let utterance: Promise<UtteranceDecision | null> | undefined;
  const askClassifier = () => (utterance ??= utteranceOf(s, deps, out, reachable));
  // A request that ended by taking itself back ("… Actually, never mind.") was once typed into the
  // session the classifier picked: nothing read words that take themselves back, only a bare "never
  // mind" (isClosing) or the classifier's undo, which takes back what went before. Dropped when the code's rule
  // finds such an ending and the classifier's `retracted` agrees; without the classifier, only on a cue ("actually, never
  // mind"), never on words cut off alone. Before everything below that would act on them.
  // While a send the app wasn't sure of is held, the take-back is most likely of that too: it doesn't
  // go either (as HELD_CANCEL's "never mind"), and "Okay, not sent." is said once (hold.ts settleWith).
  if (takesBack) {
    const d = await askClassifier();
    if (d ? (d.retracted ?? 0) >= RETRACTED_MIN : takesBack === "strict") return done("retracted", s.holding ? { type: "undo" } : notSent);
  }
  // The clean-up doesn't depend on where your words go: it starts now, alongside the classifier and the
  // router, and whatever sends them waits for it then. Once: every send shares the one answer.
  if (deps.clean) {
    const cleaning = deps.clean(text).catch((err): Cleanup => ({ text, cleaned: false, why: message(err), costUsd: 0, ms: 0 }));
    deps = { ...deps, clean: () => cleaning };
  }
  // The app just asked you something ("which session?"): this answers it, so the router, who
  // asked, takes it with the request it was about.
  // "Stop Lacy?": yes stops it, no leaves it.
  if (confirming && YES_FALLBACK.test(text)) {
    return done("confirm", gate(s, { type: "stop", session: confirming }));
  }
  if (confirming && NO_FALLBACK.test(text)) return done("confirm", { type: "say", text: "Okay, I'll leave it.", why: "stop_declined" });
  // "Want me to open a session for it?" after a quick task: yes opens one there with the task; no leaves it.
  if (offered && YES_FALLBACK.test(text)) {
    const { task, cwd } = offered;
    const where: StartPlace = cwd === homedir() ? homeOrScratch(text) : { kind: "project", cwd, how: "exact", name: folderName(cwd), said: folderName(cwd) };
    return done("hand-off", gate(s, { type: "start", where, name: "", prompt: task }));
  }
  if (offered && NO_FALLBACK.test(text)) return done("hand-off", { type: "say", text: "Okay, I'll leave it.", why: "hand_off_declined" });
  // "Stop which one? Say its name.": the name (or its letters) answers it; a near name is asked about.
  if (stopWhich) {
    const said = withSpelled(text);
    const named = sessionsNamed(sessions, said, true);
    if (named.length) return done("confirm", ...named.map((x): Act => gate(s, { type: "stop", session: x })));
    const near = sessions.filter((x) => nearName(x, said, sessions));
    if (near.length === 1) return done("confirm", { type: "say", text: `Stop ${spoken(sessionName(near[0]))}?`, why: "stop_confirm" });
  }
  // "That already went to Kiko project. Which session was it for?" (resend's own question, about a
  // correction it couldn't place): a session's name, or one it sounds like ("Rowan.", "too rowing"),
  // resends the words there, read in code. The correction stood aside in the timeline, so the send
  // is still the one it's about (timeline.ts latestSend).
  if (resendAsked && s.lastSent) {
    const last = s.lastSent;
    const others = reachable.filter((x) => x.sessionId !== last.sessionId);
    const pick = pickIn(s, { text: last.text, offered: others.map((x) => x.sessionId), line: "" }, text);
    const to = pick && !pick.extra && pick.session.sessionId !== last.sessionId ? pick.session : !pick && wordsOf(text).split(" ").length <= 4 ? soundsLikeIn(others, text)?.session : undefined;
    if (to) {
      out.correction = true;
      return done("resend-which", resend(s, to));
    }
  }
  if (s.appAsked) {
    // A short answer to the app's question, unanswerable without the router, isn't words to keep
    // ("Yes." to "Want me to open a new session for that?"); longer words may be a message.
    await route(s, deps, out, null, [], wordsOf(text).split(" ").length <= ANSWER_WORDS ? "say" : "keep");
    out.step = "app-question";
    return out;
  }
  // "Add to dictionary: ghosty means Ghostty": an instruction to the app, which only the router
  // carries out. The classifier would hear a session's name in it ("clipkit") and send it there.
  if (DICTIONARY_REQUEST.test(text)) {
    await route(s, deps, out, null);
    out.step = "dictionary";
    return out;
  }

  // "Trust the scratch folder": the one-time step for new scratch sessions' trust prompt. It opens a
  // session (in the scratch folder), so only where starting them is allowed.
  if (asksTrustScratch(text)) return done("trust-scratch", gate(s, { type: "trust_scratch" }));

  // "Upgrade to Pro", "buy Kiko Pro": Kiko Pro's checkout, while it's on sale. A bare "upgrade" only
  // with nothing waiting for a reply or just spoken, and not said in a session's screen: there it may
  // answer that session.
  if (s.proOnSale && asksUpgrade(text, { bare: !waiting && !s.justSpoke && !s.to })) return done("upgrade", { type: "upgrade", interval: upgradeInterval(text) });

  // "Stop clipkit.", "Stop lazy.", "Stop Lacy and Clipkit.": nothing but "stop" and names.
  const stops = stopNamed(s);
  if (stops) return done("stop-named", ...stops);

  // "Move that to lacy", "send it to clipkit instead": the last message, to the one session named.
  if (s.lastSent && MOVE_IT.test(text) && !AND_ALSO.test(text)) {
    const last = s.lastSent;
    const to = sessions.filter((x) => x.sessionId !== last.sessionId && (mentionsSession(x, text) || sessionsNamed([x], text, true).length > 0));
    if (to.length === 1) {
      out.correction = true;
      return done("move-it", resend(s, to[0]));
    }
  }

  // Said inside a session's screen: as good as naming it, and nothing to trim. "Stop" there stops
  // it, as "stop Lacy" would.
  if (s.to && !out.toApp && !directed) {
    const there = findSession(sessions, s.to!.sessionId);
    if (there && BARE_STOP.test(text)) {
      return done("stop-named", gate(s, { type: "stop", session: there }));
    }
    return done("addressed", await send(s, deps, out, there ?? s.to, null, null));
  }

  // "Tell Harbor to deploy and tell Atlas to tag the release", "Tell Mintbox to add the export button
  // and Pixie to update the screenshots": each session named gets its own part, cut from your words
  // (sessions.ts splitBySession), each sent as words named for it are. Before, the first one named got
  // it all, the other's part included. A first part that names none is the waiting session's reply.
  // Words that do speak to two in turn but don't cut into one part each go nowhere: the app asks for
  // each one's part, rather than send it all to one. One session's words that only mention another
  // ("Tell Bobby that MintBox already fixed the cert") aren't a split: they go on below, whole.
  const waitingSession = waiting && waiting.permission === undefined ? (findSession(sessions, waiting.sessionId) ?? null) : null;
  const split = splitBySession(sessions, text, waitingSession);
  if (split && "parts" in split) {
    const acts: Act[] = [];
    for (const part of split.parts) acts.push(await sendPart(s, deps, out, part));
    return done("split", ...acts);
  }
  if (split) {
    const names = andList(split.unclear.map((x) => spoken(sessionName(x))));
    return done("split", { type: "say", text: `That's for ${names}, and I couldn't tell which part is whose. Say each one's part on its own.`, why: "split_unclear" });
  }
  // "Tell Harbor to deploy and tell Atlus to tag the release": a second part for a name that's no
  // session's but close to one (Atlas): asked about as above, rather than all of it sent to Harbor.
  const unknown = split ? null : partForUnknown(sessions, text);
  const near = unknown ? sessions.filter((x) => x !== unknown.first && nameScore(unknown.heard, x) >= 0.6) : [];
  if (unknown && near.length === 1) {
    const names = andList([unknown.first, near[0]].map((x) => spoken(sessionName(x))));
    return done("split", { type: "say", text: `That's for ${names}, and I couldn't tell which part is whose. Say each one's part on its own.`, why: "split_unclear" });
  }

  // "Atlas agents, check the build", "tell atlas agents to …": a session named up front needs no
  // guessing. A softer mention ("for the in-app settings one, …") is only cut, once the classifier agrees.
  const named = directed ?? addressedTo(sessions, text);
  const sure = named?.sure && named.sessions.length === 1 ? named.sessions[0] : null;
  if (sure && (sure.sessionId !== waitingId || named === directed)) return done("addressed", await send(s, deps, out, sure, named, null));
  // "To Kiko, …" with two sessions named like the app ("Kiko project", "kiko-dev"): which one, as
  // for a numbered name below.
  if (directed && directed.sessions.length > 1 && !sameNumberedName(directed.sessions)) {
    const line = whichOne(directed.sessions);
    const words = (await send(s, deps, out, directed.sessions[0], directed, null)).text;
    out.question = { kind: "asked", question: { text: words, offered: directed.sessions.map((x) => x.sessionId), line } };
    return done("which-named", { type: "say", text: line, why: "named_unclear" });
  }
  // "Kiko project, run the tests" with "Kiko project 2" open there too: the plain name names them
  // all, so the app asks which rather than guess, each by its number and Claude's title for it
  // ("Which one: Kiko project, Idea file; or Kiko project 2, Session colours?"), and your answer
  // ("two", "the second one", "Kiko project 2") sends the words there. Not when one of them waits
  // for your reply: the words most likely answer it, as below.
  const twins = named?.sure ? sameNumberedName(named.sessions) : null;
  if (twins && !twins.some((x) => x.sessionId === waitingId)) {
    const line = whichOne(twins);
    const words = (await send(s, deps, out, twins[0], named, null)).text;
    out.question = { kind: "asked", question: { text: words, offered: twins.map((x) => x.sessionId), line } };
    return done("which-numbered", { type: "say", text: line, why: "numbered_unclear" });
  }

  // "Is Harbor still deploying?", "What's the status for MintBox?", "Hey Kiko, what did MintBox find?":
  // a question about a session, asked of the app (in the third person, or with its name up front),
  // which it answers from what it knows (the router's say: each one's status, last said and the recent
  // conversation), or says it doesn't know and offers to ask. The classifier would send it to the
  // session it's about, as it once did "Hey Kiko, what's the status for MintBox?". A
  // question said to the session ("Bobby, are you still deploying?") went above, as named up front.
  const about = askedAbout(reachable, text);
  const asked = about.length ? about : out.toApp && ASKS_APP.test(text) ? sessionsNamed(reachable, text, true, true) : [];
  if (asked.length) {
    await route(s, deps, out, null, asked);
    out.step = "about";
    return out;
  }

  // "Too rowing, is there anything …" for "To Rowan, …": once, no name in code
  // matched, the classifier was flat, and the router sent it to the session whose topic it shared. A
  // session's name heard as other words up front (heard-as.ts) is a guess, so it never sends by
  // itself: the router is told (<name_heard_as>), and words for that session go without it.
  const heard = named ? null : nameHeardAs(reachable, text);
  if (heard) out.heardAs = { sessionId: heard.session.sessionId, heard: heard.heard, said: heard.said, rest: heard.rest };

  const d = await askClassifier();

  // "Support phrases like never mind": the words only quote a take-back or a correction, as an
  // example for a session. The classifier hears the phrase; it's a message like any other.
  const quoted = d && (d.intent === "undo" || d.intent === "redirect") && quotesTakeBack(text);
  if (d && d.intentConfidence >= INTENT_MIN_CONFIDENCE && !quoted) {
    if (d.intent === "wrap_up") return done("classifier-intent", { type: "wrap_up" });
    if (d.intent === "undo") return done("classifier-intent", { type: "undo" });
    if (d.intent === "repeat") return done("classifier-intent", repeat(s));
    if (d.intent === "redirect") {
      // "No, I said the clipkit session" right after a repeat: the repeat was for the wrong one.
      const again = s.lastRepeat ? repeatFor(s) : null;
      if (again) return done("classifier-intent", again);
      out.correction = true;
      // "No, that was for clipkit": where it was meant to go, if your words name it or the classifier is sure;
      // otherwise the router works it out from the conversation, or asks.
      const last = s.lastSent;
      // "No, that's for lacy, and also ask it …": the router resends and asks the rest too.
      if (last && AND_ALSO.test(text)) {
        await route(s, deps, out, null);
        return out;
      }
      if (last) {
        const others = reachable.filter((x) => x.sessionId !== last.sessionId);
        const mentioned = others.filter((x) => mentionsSession(x, text));
        const classifierSure = d.audience !== "app" && d.audience.sessionId !== last.sessionId && d.audienceConfidence >= s.classifierMinConfidence ? d.audience : null;
        // "That was too rowing, not to Kiko.": a name heard as other words, when nothing else says where.
        const to = mentioned.length === 1 ? mentioned[0] : (classifierSure ?? soundsLikeIn(others, text)?.session ?? null);
        if (!to) {
          await route(s, deps, out, null);
          return out;
        }
        return done("classifier-intent", resend(s, to));
      }
    }
  }
  // The classifier at its bar for another session than the one a name heard wrong up front points
  // to, but not very sure (OTHER_THAN_PENDING), and nothing in your words naming its pick: the router
  // weighs the two, told of the name.
  const heardOther = Boolean(
    heard &&
      d &&
      d.audience !== "app" &&
      d.audience.sessionId !== heard.session.sessionId &&
      d.audienceConfidence < OTHER_THAN_PENDING &&
      !calledByName(reachable, text).some((x) => d.audience !== "app" && x.sessionId === d.audience.sessionId),
  );
  if (d && d.audience !== "app" && d.audienceConfidence >= bar(s, d.audience) && !heardOther) {
    const to = keepWaiting(s, out, d.audience, "classifier");
    return done("classifier", await send(s, deps, out, to, to === d.audience ? (named ?? heardPhrase(out, to)) : forWaiting(s, text), d.appParts));
  }
  // "Also, I reopened Kiko Dev, and … the Kikodev session …": your words call one
  // session by its name, and the classifier picked it too, if below its bar: two reads agree, so
  // they go there, not to the router (which once took "Ivy Beta" in another session's title over
  // the name). Not while another session waits for your reply or just spoke: the router weighs that,
  // unless your words speak to this one up front ("Hey Bobby, can you also look at …", addressedByName):
  // that's who they're for, not a reply to the other. Once, Bobby at 0.79, under
  // the bar raised for kiko-dev, which had just spoken, went to the router, which ran its own check.
  const called = calledByName(reachable, text);
  const pending = s.waiting?.sessionId ?? s.justSpoke?.id ?? null;
  if (
    d &&
    called.length === 1 &&
    d.audience !== "app" &&
    d.audience.sessionId === called[0].sessionId &&
    d.audienceConfidence >= NAMED_MIN_CONFIDENCE &&
    (!pending || pending === called[0].sessionId || addressedByName(reachable, text).includes(called[0]))
  ) {
    return done("named", await send(s, deps, out, called[0], named, d.appParts));
  }
  // Without the classifier, a waiting session gets your words as its reply.
  if (!d && waiting) return done("waiting-fallback", await send(s, deps, out, waiting, named, null));
  await route(s, deps, out, d?.appParts ?? null, [], "keep");
  return out;
}

/**
 * Your words with a direction to the app's name up front ("To, uh, Kiko. …", "Tell Kiko to run the
 * tests"), as a phrase naming the sessions called by that name (sessions.ts namedLikeAppName): sure,
 * with the direction and the name cut. Null when there's no such direction or session, a session's
 * prompt waits, or what's after it is for another session by name ("tell Kiko to ask Rowan …").
 */
function directedToAppNamed(s: DecideState): Addressed | null {
  if (s.waiting?.questions || s.waiting?.permission !== undefined) return null;
  const d = directedAtName(s.text);
  if (!d) return null;
  const to = namedLikeAppName(s.sessions);
  if (!to.length) return null;
  const others = s.sessions.filter((x) => !to.includes(x));
  if (addressedTo(others, d.rest)?.sure || addressedByName(others, d.rest).length) return null;
  return { sessions: to, rest: d.rest, dropped: d.said, sure: true };
}

/**
 * Your words now, with words kept (DecideState.kept): what sends those, or "redo" to decide them again
 * as if just said, or null when these words are about something else. A name picks as for "which
 * session?" (pickIn: "Rowan.", "send that to Rowan", "to, uh, the Rowan one"), nothing more with it.
 */
function keptFor(s: DecideState, text: string): Act | "redo" | null {
  const kept = s.kept!;
  const words = kept.texts.join("\n\n");
  const asked = SEND_KEPT.exec(text);
  const again = TRY_AGAIN.test(text);
  // Nothing offered: only a session's own name picks, never one it merely comes close to.
  const pick = pickIn(s, { text: words, offered: [], line: "" }, text);
  if (pick && !pick.extra && (asked || again || /\b(?:send|pass|forward)\b/i.test(text) || !s.waiting)) {
    return { type: "send", session: { sessionId: pick.session.sessionId, cwd: pick.session.cwd }, text: words };
  }
  if (!asked && !again) return null;
  const name = asked?.groups?.name?.trim();
  if (name) return { type: "say", text: `I don't see a session called ${spoken(name)}.`, why: "unknown_session" };
  return s.waiting ? null : "redo";
}

/** The classifier on your words; null when it's off or failed (the failure noted in `out`). */
async function utteranceOf(s: DecideState, deps: DecideDeps, out: Decision, reachable: Session[]): Promise<UtteranceDecision | null> {
  if (!deps.utterance) return null;
  // Known to be offline: not asked (it would only run out its 4s), decided as with it off.
  const down = deps.offline?.() ?? null;
  if (down) {
    out.offline = down;
    return null;
  }
  try {
    const d = await deps.utterance({
      text: s.text,
      sessions: reachable.map((session) => ({ session, ...(s.notes.get(session.sessionId) ?? { asked: "", said: "" }) })),
      waitingId: s.waiting?.sessionId ?? null,
      justSpoke: s.justSpoke,
      lastId: s.lastId,
      recent: s.recent,
    });
    out.utterance = d;
    out.classifierCostUsd += d.costUsd;
    return d;
  } catch (err) {
    out.errors.push({ where: "classify_utterance", message: message(err) });
    return null;
  }
}

/**
 * How sure the classifier must be to send straight to `to`: the setting, or more when another session is
 * waiting for your reply or just spoke (your words most likely answer that one; the router weighs it).
 */
function bar(s: DecideState, to: Session) {
  const pending = s.waiting?.sessionId ?? s.justSpoke?.id ?? null;
  return pending && pending !== to.sessionId ? Math.max(s.classifierMinConfidence, OTHER_THAN_PENDING) : s.classifierMinConfidence;
}

/**
 * "What's …", "is …", "did …": a question, as the words open, said to the app with its name up front
 * about a session it names ("Kiko, what did MintBox find?"). Not "can"/"could" ("Kiko, can MintBox
 * check the logs?" asks for work), nor one that asks the app to ask ("Kiko, ask Harbor if …").
 */
const ASKS_APP = /^\W*(?:(?:so|and|okay|ok|hey|um+|uh+|oh|also)[\s,]+)*(?:what|what['’]s|whats|which|who|whose|when|where|why|how|how['’]s|is|are|was|were|has|have|had|did|does|do)\b/i;

/**
 * What the app does when the router gives no answer (routeFailed): "keep" the words to route again,
 * for words that may be a message; "say" so, for words that were the app's (a question about a
 * session, the dictionary, a correction, a yes to its question).
 */
type WhenNoAnswer = "keep" | "say";

/**
 * The router's tool calls, then the code guards that run on them. `about`: sessions the words ask the
 * app about (askedAbout). `noAnswer`: what to do when the router can't answer.
 */
async function route(s: DecideState, deps: DecideDeps, out: Decision, appParts: number | null, about: Session[] = [], noAnswer: WhenNoAnswer = "say") {
  const { text, sessions } = s;
  out.step = "router";
  deps.beforeRoute?.(text);
  // Known to be offline (core/online.ts): not asked. It would wait out two 8s tries (2026-11-12, 12s
  // each for two messages) for an answer that can't come.
  const down = deps.offline?.() ?? null;
  if (down) return routeFailed(s, deps, out, noAnswer, { why: "offline", error: down, skipped: true });
  let result: RouteResult | null;
  try {
    result = await deps.route({
      sessions,
      notes: s.notes,
      waitingId: s.waiting?.sessionId ?? null,
      justSpoke: s.justSpoke,
      lastId: s.lastId,
      recent: s.recent,
      text,
      voiceCan: s.voiceCan,
      dictionary: s.dictionary,
      question: s.question ? { text: s.question.text, offered: offeredIn(s, s.question) } : null,
      // The sessions your words call by name: a strong hint, over words that only match a title.
      named: calledByName(sessions, text),
      ...(out.nameAlso?.length ? { nameAlso: out.nameAlso.flatMap((id) => findSession(sessions, id) ?? []) } : {}),
      ...(heardAsOf(s, out) ? { heardAs: { session: heardAsOf(s, out)!, said: out.heardAs!.heard } } : {}),
      ...(about.length ? { about } : {}),
      ...(s.heardAt ? { heardAt: s.heardAt } : {}),
    });
  } catch (err) {
    // No answer (router.ts route_failed: every try timed out or failed, no key). A new press isn't
    // this: it answers null. Offline by now (the failure itself may have said so): said as that.
    return routeFailed(s, deps, out, noAnswer, { why: deps.offline?.() ? "offline" : "failed", error: message(err), skipped: false });
  }
  if (!result) return;
  out.router = result;
  out.llmCostUsd += result.costUsd;
  // Calls for a session it named by a handle it wasn't given: one still starting, called by its
  // folder or name, still gets them (held until it's ready); the rest are said, never dropped silently.
  const recovered = recover(s, result.actions, result.dropped ?? []);
  const { missing } = recovered;
  // A question about a session, asked of the app: never sent there unasked. The router's pass_on or
  // ask_session for it is the app's offer to ask instead ("Want me to ask Harbor?"), a yes sending it.
  const calls = recovered.calls.map((a): RouterAction => {
    if (!about.length || (a.name !== "pass_on" && a.name !== "ask_session")) return a;
    (out.guards ??= []).push({ rule: "asked_about", by: `router ${a.name}`, from: a.session.sessionId, fromName: sessionName(a.session), to: null, text });
    return { name: "offer_session", session: a.session, ask: true };
  });
  const notFound = missing.length ? notFoundLine(s, missing) : null;
  // Its text is only spoken when it just answers. Before a tool call it tends to narrate its
  // reasoning, so when it acts, the app says a short fixed line instead.
  if (!calls.length) {
    // "Hey Bobby, what's the time?": spoken to a session, so it answers, not the router.
    const instead = notFound ? null : await sessionInstead(s, deps, out, "router say", appParts, true);
    if (instead) {
      out.actions.push(instead);
      return;
    }
    if (notFound) out.actions.push(notFound);
    // What it says it did, it didn't: the app never claims an action it didn't take.
    if (result.claimsAction) {
      out.actions.push({ type: "say", text: "I didn't send that anywhere. Who's it for?", why: "claimed_without_action" });
    } else if (result.text.trim() && s.voiceCan !== VOICE_ON && SAYS_OFF_IN_SETTINGS.test(result.text)) {
      // "Starting sessions is off in settings.": the router's own words, naming no setting. Told to
      // call the tool instead; when it doesn't, the app's line (what's off, where, and the offer) instead.
      out.actions.push({ type: "refused", what: offFromWords(text) });
    } else if (result.text.trim()) {
      out.actions.push({ type: "say", text: result.text.trim() });
    }
    await asksWhere(s, deps, out);
    return;
  }
  if (calls.some((a) => a.name === "resend_to")) out.correction = true;
  const acts: Act[] = [];
  if (notFound) acts.push(notFound);
  const one = oneTarget(s, out, calls);
  if (one.ask) acts.push({ type: "say", text: "Which session is that for?", why: "one_target_unclear" });
  for (const action of one.actions) {
    const act = await guard(s, deps, out, action, appParts);
    // Two stops never land on one session.
    if (act.type === "stop" && acts.some((a) => a.type === "stop" && a.session.sessionId === act.session.sessionId)) continue;
    acts.push(act);
  }
  // The router's guess at a session your words named by a name that's none of them ("ask Lazey …"
  // for Lacy): logged with how close it was. It goes as any guess does: said, and held a moment.
  const guessed = acts.find((a): a is Act & { type: "send" | "ask" } => (a.type === "send" || a.type === "ask") && Boolean(a.unsure));
  const picked = guessed && !out.guess ? findSession(sessions, guessed.session.sessionId) : undefined;
  const miss = picked && misheard(text, picked, sessions);
  if (picked && miss) out.guess = { ...miss, sessionId: picked.sessionId, how: "routed" };
  // "Stop Lacy?" last: what you say next answers it, so nothing may be said after it.
  const asks = acts.filter((a) => a.type === "say" && a.why === "stop_confirm");
  out.actions.push(...acts.filter((a) => !asks.includes(a)), ...asks);
  await asksWhere(s, deps, out);
}

/**
 * The router gave no answer (`f`): the words are kept (core/kept.ts) and routed again by themselves
 * (app/deliver.ts retryKept), and the app says so once ("I'm offline. I'll send that when I'm
 * back."). No session is guessed: the user, 2026-11-12, "a guess will often be wrong". Words that
 * were the app's (`noAnswer` "say") are only said not done. Before 2026-11-12 the router's failure
 * was thrown, and app/talk.ts said "Something went wrong, and I didn't send that.", the words gone.
 */
async function routeFailed(s: DecideState, deps: DecideDeps, out: Decision, noAnswer: WhenNoAnswer, f: { why: FallbackWhy; error: string; skipped: boolean }) {
  out.fallback = { ...f, kept: false };
  if (noAnswer === "say") {
    out.actions.push({ type: "say", text: notDoneLine(f.why), why: "route_fallback" });
    return;
  }
  // "Send it." with nothing kept (keptFor took it otherwise): not words to keep and send later, where
  // they'd go along with the next ones kept.
  if (SEND_KEPT.test(s.text) || TRY_AGAIN.test(s.text)) {
    out.actions.push({ type: "say", text: NOTHING_KEPT_LINE, why: "route_fallback" });
    return;
  }
  // Kept cleaned up when the clean-up answered: the retries and "send it" don't clean them again.
  const words = (await clean(s, deps, { type: "send", session: { sessionId: "", cwd: "" }, text: s.text })).text;
  out.fallback = { ...out.fallback, kept: true };
  out.keep = { text: words };
  out.actions.push({ type: "say", text: keptLine(f.why), why: "route_fallback_kept" });
}

/**
 * The router's calls, with those it dropped (a handle not in <sessions>: Dropped) that name a
 * session still starting (status "starting": one the app opened, not ready yet) by its name or
 * folder put back as calls for it; the others, `missing`. Without this, a question for a session
 * still at Claude Code's trust prompt went to its folder's name ("2026-10-29-dozer"), dropped, and
 * nothing was said.
 */
function recover(s: DecideState, actions: RouterAction[], dropped: Dropped[]): { calls: RouterAction[]; missing: Dropped[] } {
  const calls = [...actions];
  const missing: Dropped[] = [];
  for (const d of dropped) {
    const starting = startingNamed(s.sessions, d.handle);
    if (starting && d.tool === "pass_on") calls.push({ name: "pass_on", session: starting });
    else if (starting && d.tool === "ask_session" && d.message) calls.push({ name: "ask_session", session: starting, message: d.message });
    else missing.push(d);
  }
  return { calls, missing };
}

/** The one session still starting that `handle` names, by its name or its folder ("2026-10-29-dozer"). */
function startingNamed(sessions: Session[], handle: string): Session | null {
  if (!handle.trim()) return null;
  const named = sessions.filter((x) => isStarting(x) && (sameName(sessionName(x), handle) || sameName(folderName(x.cwd), handle)));
  return named.length === 1 ? named[0] : null;
}

/**
 * What the router named and the app couldn't find, said: "I don't see a session called dozer.";
 * one still starting (for something it can't wait for): "Dozer is still starting."
 */
function notFoundLine(s: DecideState, missing: Dropped[]): Act {
  const starting = missing.map((d) => startingNamed(s.sessions, d.handle)).find(Boolean);
  if (starting) return { type: "say", text: `${spoken(sessionName(starting))} is still starting.`, why: "session_starting" };
  const names = [...new Set(missing.map((d) => handleName(d.handle)).filter(Boolean))];
  if (!names.length) return { type: "say", text: "I couldn't tell which session that was for.", why: "unknown_session" };
  const text = names.length === 1 ? `I don't see a session called ${names[0]}.` : `I don't see sessions called ${orList(names)}.`;
  return { type: "say", text, why: "unknown_session" };
}

/** A handle the router made up, as said: a scratch folder's name without its date ("2026-10-29-dozer" → "dozer"); "" for one like "s7". */
export function handleName(handle: string) {
  const h = handle.trim();
  if (/^s\d+$/i.test(h)) return "";
  return spoken(h.replace(/^\d{4}-\d{2}-\d{2}-(?=.)/, "")).trim();
}

async function guard(s: DecideState, deps: DecideDeps, out: Decision, action: RouterAction, appParts: number | null): Promise<Act> {
  const { text, sessions } = s;
  switch (action.name) {
    case "pass_on": {
      // An answer to "which session?" that only picks one (the router told to pass_on it, or reading
      // the answer as words for that session): what goes is what the question was about, never the
      // answer: otherwise an answer like "It should go to <the session>." is typed into that session.
      if (s.question && onlyPicks(s, s.question, action.session)) {
        out.question = { kind: "answered", sessionId: action.session.sessionId, how: "router" };
        return unsure(s, { type: "send", session: { sessionId: action.session.sessionId, cwd: action.session.cwd }, text: s.question.text }, "router pass_on");
      }
      const which = await numberedUnclear(s, deps, out, action.session, appParts);
      if (which) return which;
      // Your exact words, never a rewrite; minus "atlas agents," or other parts that were for the app.
      const tie = folderTie(s, action.session);
      const to = keepWaiting(s, out, tie, "router pass_on");
      return unsure(s, await send(s, deps, out, to, to === tie ? (addressedTo([tie], text) ?? heardPhrase(out, tie)) : forWaiting(s, text), appParts), "router pass_on", out);
    }
    case "confirm_session": {
      // "Ask Macy what's next" with no Macy and Lacy likely: "Did you mean Lacy?", the words kept as
      // the question's (offering only Lacy), sent there on a yes, to another one if that's named
      // instead (answerQuestion), never retyped. The name said is cut as a session's name would be.
      const to = action.session;
      const said = action.heard ? addressedTo([{ ...to, givenName: action.heard, title: "" }], text) : null;
      const checked = action.message ? await routerWordsOr(s, deps, out, to, action.message, appParts, "router confirm_session", said) : null;
      const words = typeof checked === "string" ? checked : (checked ?? (await send(s, deps, out, to, said, appParts))).text;
      const line = `Did you mean ${spoken(sessionName(to))}?`;
      out.question = { kind: "asked", question: { text: words, offered: [to.sessionId], line } };
      out.guess = { heard: action.heard, sessionId: to.sessionId, how: "asked", score: nameScore(action.heard, to) };
      return { type: "say", text: line, why: "confirm_name" };
    }
    case "offer_session": {
      // Unsure whether the words were for the app or for this session: "Want me to send that to
      // Bobby?", with the user's own words kept (as pass_on would have sent them: cleaned up when the
      // clean-up is on, a name up front for the app cut), sent there on a yes (answerQuestion), never
      // the yes itself. The case: "I can pass your question along to it if you want."
      // said in the router's own words, and "Yes, pass it to Bobby." was what reached Bobby.
      const to = action.session;
      const words = (await send(s, deps, out, to, addressedTo([to], text) ?? heardPhrase(out, to), appParts)).text;
      const line = action.ask ? `Want me to ask ${spoken(sessionName(to))}?` : `Want me to send that to ${spoken(sessionName(to))}?`;
      out.question = { kind: "asked", question: { text: words, offered: [to.sessionId], line, offer: true } };
      return { type: "say", text: line, why: "offer_session" };
    }
    case "resend_to":
      // Back to the one session they went to ("That was too rowing, not to Kiko." as resend_to Kiko
      // project): never as is. Another session your words name, or sound
      // like, is where they go; with none, resend asks which.
      if (s.lastSent && action.session.sessionId === s.lastSent.sessionId && !s.lastSent.also?.length) {
        const other = correctedTo(s);
        return unsure(s, resend(s, other ?? action.session), "router resend_to");
      }
      if (s.lastSent) return unsure(s, resend(s, action.session), "router resend_to");
      // Your last words went to the app, not a session: after a repeat, it's that repeat redone.
      return (s.lastRepeat && repeatFor(s, action.session)) || { type: "say", text: "Your last words didn't go to a session, so there's nothing to send on.", why: "nothing_to_resend" };
    case "ask_session": {
      const which = await numberedUnclear(s, deps, out, action.session, appParts);
      if (which) return which;
      const tie = folderTie(s, action.session);
      const to = keepWaiting(s, out, tie, "router ask_session");
      // Kept for the waiting one, your words are its reply: as said, not the router's rewrite.
      if (to !== tie) return unsure(s, await send(s, deps, out, to, forWaiting(s, text), appParts), "router ask_session", out);
      // Your answer to "which session?" with more to it: the router wrote the words asked about and the rest as one.
      if (s.question && !out.question) out.question = { kind: "answered", sessionId: tie.sessionId, how: "router" };
      // The router's words, checked: none you didn't say (router-words.ts); else your own words go.
      const words = await routerWordsOr(s, deps, out, tie, action.message, appParts, "router ask_session");
      return unsure(s, typeof words === "string" ? { type: "ask", session: tie, message: words } : words, "router ask_session", out);
    }
    case "stop_session": {
      // Escape is disruptive: only for a session your words name, or the one session that's busy.
      // A bare "stop" is you cutting the app off, which the key press already did.
      if (BARE_STOP.test(text)) return { type: "stop_ignored", session: action.session };
      return gate(s, stopFor(s, action.session));
    }
    case "rename_session": {
      // The new name isn't a session being named: "rename clipkit to random".
      const which = resolve(sessions, without(text, action.newName), action.session);
      if (which === "ambiguous") return { type: "say", text: `Rename which one? ${choices(sessions, without(text, action.newName))}`, why: "rename_unclear" };
      return gate(s, { type: "rename", session: which, name: action.newName });
    }
    case "start_session": {
      const projects = s.projects?.() ?? listProjects(sessionFolders(sessions));
      // The home folder only when you said so, or said yes to the app's offer of it: the router reaches
      // for it when no project is named, where a scratch folder is meant (a bare yes to the offer of a
      // session for a Mac setting would otherwise open one in ~).
      const home = action.project !== null && isHome(action.project) && !/\bhome\b/i.test(text) && !(s.appAsked && /\bhome folder\b/i.test(s.recent.at(-1) ?? ""));
      const placeOf = (ask: typeof action) => startPlace(home ? { ...ask, project: null } : ask, projects, s.newProjectRoot ?? null, homedir());
      const where = placeOf(action);
      // A session of an agent whose sessions start in its own app (T3 Code's threads, made on its
      // server): started there, in the project named, with no question first and never redirected to
      // a session there (you named the app). Its name as the project or the session's name is only its
      // name. The app starts it (app/new-session.ts startInApp), or, with T3 Code not open, a terminal session in
      // its place; `agent` is another agent your words name ("a T3 thread on Codex": what runs it).
      const other = startsElsewhere(action, text, where);
      if (other) {
        const own = { ...action, project: onlyItsName(action.project, other) ? null : action.project, sessionName: onlyItsName(action.sessionName, other) ? "" : action.sessionName };
        const place = own.project === action.project && own.sessionName === action.sessionName ? where : placeOf(own);
        if (!place) return noProjectsRoot(s);
        const runsOn = starters().find((a) => a.heard?.test(text.replace(new RegExp(other.heard!.source, "gi"), "")))?.id;
        return gate(s, { type: "start", where: place, name: own.sessionName, prompt: action.prompt, app: other.id, ...(runsOn ? { agent: runsOn } : {}) });
      }
      // A new window only when you asked for one: otherwise your words go to the session already
      // working there (the model sometimes reaches for start_session for any request).
      const cwd = where && where.kind !== "scratch" && where.kind !== "new" ? where.cwd : null;
      const there = cwd ? sessions.find((x) => x.cwd === cwd && x.place) : undefined;
      if (there && !ASKED_FOR_NEW.test(text)) {
        const to = keepWaiting(s, out, there, "router start_session");
        if (to !== there) return send(s, deps, out, to, forWaiting(s, text), appParts);
        return unsure(s, { ...(await send(s, deps, out, there, addressedTo([there], text) ?? heardPhrase(out, there), appParts)), from: "start_session" }, "router start_session", out);
      }
      if (!where) return noProjectsRoot(s);
      // Nothing named and nothing that asks for a session: work the router took for a new one. Ask
      // first rather than open a scratch session for it; "yes" answers the app's question.
      if (where.kind === "scratch" && !where.said && !action.sessionName && !ASKED_FOR_NEW.test(text) && !s.appAsked) {
        return { type: "say", text: "Want me to open a new session for that?", why: "start_unasked" };
      }
      const agent = namedAgent(action.agent ?? "", text);
      return gate(s, { type: "start", where, name: action.sessionName, prompt: action.prompt, ...(agent ? { agent } : {}) });
    }
    case "quick_task": {
      // Your words were for a session, by its name or the classifier's read: they go there (sessionInstead).
      const instead = await sessionInstead(s, deps, out, "router quick_task", appParts, false);
      if (instead) return instead;
      // Only at "everything": below it, refused with the offer to turn it on (and a yes runs it then).
      if (!voiceAllows(s.voiceCan, "check")) {
        return { type: "refused", what: "check", ...(CHANGE_REQUEST.test(action.task) || CHANGE_REQUEST.test(text) ? {} : { then: { type: "quick_task", task: action.task, cwd: action.cwd } }) };
      }
      // It can only look: asked to change something, the app offers a session without the run; a
      // yes starts it in code (handOff), as after a run that found it needs changes.
      if (CHANGE_REQUEST.test(action.task) || CHANGE_REQUEST.test(text)) {
        return { type: "say", text: needsChanges(sessions, action.cwd), why: "quick_task_needs_changes", offer: { task: action.task, cwd: action.cwd } };
      }
      return { type: "quick_task", task: action.task, cwd: action.cwd };
    }
    case "add_to_dictionary": {
      const write = spelledOut(action.write);
      // "ghosty means ghosty": speech-to-text wrote the new word the old way too. ("clip kit" →
      // "clipkit" joins words: a change.) Below "everything", refused first: it isn't asked.
      if (wordsOf(write) === wordsOf(action.heard)) {
        return voiceAllows(s.voiceCan, "dictionary") ? { type: "say", text: "How is it spelled? Say the letters.", why: "dictionary_same_word" } : { type: "refused", what: "dictionary" };
      }
      return gate(s, { type: "dictionary", op: "add", heard: keyOf(action.heard), write });
    }
    case "remove_from_dictionary":
      return gate(s, { type: "dictionary", op: "remove", heard: action.heard });
  }
}

/**
 * `act` when the "Voice can" level allows it. Otherwise refused, with `act` kept: the app says what's
 * off and where it's turned on, and offers to turn it on now, then carries it out (core/voice-off.ts).
 */
export function gate(s: { voiceCan: VoiceCan }, act: Act): Act {
  const what =
    act.type === "stop"
      ? "stop"
      : act.type === "rename"
        ? "rename"
        : act.type === "start" || act.type === "trust_scratch"
          ? "start"
          : act.type === "quick_task"
            ? "check"
            : act.type === "dictionary"
              ? "dictionary"
              : null;
  if (!what || voiceAllows(s.voiceCan, what === "check" || what === "dictionary" ? what : "manage")) return act;
  const session = act.type === "stop" || act.type === "rename" ? act.session : undefined;
  return { type: "refused", what, ...(session ? { session } : {}), then: act };
}

/** No folder to open a new session in: where it's set, or first that starting them is off. */
function noProjectsRoot(s: DecideState): Act {
  if (!voiceAllows(s.voiceCan, "manage")) return { type: "refused", what: "start" };
  return { type: "say", text: "I don't know where your projects go. Set a projects root in Settings, under New sessions.", why: "no_projects_root" };
}

const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ");

// At most this many words is an answer to the app's question rather than new words ("Yeah, open
// one. Actually, never mind." is seven).
const ANSWER_WORDS = 10;

/** A word spelled out letter by letter ("L-A-C-Y", "l a c y") as a word, "Lacy"; anything else as it is. */
export function spelledOut(write: string) {
  const w = write.trim().replace(/[.,]+$/, "");
  if (!/^\p{L}(?:[\s.-]+\p{L}){2,}$/u.test(w)) return w;
  const word = w.replace(/[\s.-]+/g, "").toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A code guard that changed where your words go: `rule`, and who picked `from` (the classifier, a router tool). */
export type Guarded = {
  rule: "waiting_wins" | "one_target" | "session_over_app" | "asked_about" | "router_words" | "app_words";
  by: string;
  from: string;
  fromName: string;
  to: string | null;
  text: string;
  /** router_words: what the router wrote, why it didn't go as written, and what went instead. */
  message?: string;
  why?: string;
  added?: string[];
  lost?: string[];
  cut?: string[];
  sent?: string;
};

/**
 * The message the router wrote for `to` (ask_session, confirm_session's), as it may go: your words
 * and nothing more (router-words.ts), less any sentence of its own ("Give me a short answer."). When
 * it isn't, or `to` is the session waiting for your reply (that goes as said), your own words go
 * instead (send: the direction off, direction.ts), and the guard is logged (router_words). Several
 * messages from one go, or a correction with it ("no, that's for Lacy, and also ask it …"), each
 * carry only a part of your words: only its own sentences are cut there.
 */
async function routerWordsOr(
  s: DecideState,
  deps: DecideDeps,
  out: Decision,
  to: Session,
  message: string,
  appParts: number | null,
  by: string,
  named: Addressed | null = addressedTo([to], s.text) ?? heardPhrase(out, to),
): Promise<string | (Act & { type: "send" })> {
  const base = { rule: "router_words" as const, by, from: to.sessionId, fromName: sessionName(to), to: to.sessionId, text: s.text, message };
  const own = async (why: string, more: Partial<Guarded> = {}) => {
    const act = await send(s, deps, out, to, named, appParts);
    (out.guards ??= []).push({ ...base, why, ...more, sent: act.text });
    return act;
  };
  if (replyTo(s, to) && !s.question) return own("reply");
  const calls = out.router?.actions ?? [];
  const partial = calls.some((a) => a.name === "resend_to") || new Set(calls.flatMap((a) => (a.name === "ask_session" ? [a.message] : []))).size > 1;
  const found = directionOff(s.text, to, s.sessions);
  // The direction, and words said to the app ("and Kiko, read me just the summary"): never the session's.
  // A name heard as other words up front ("Too rowing," for Rowan: Decision.heardAs) is its direction
  // too: a message that keeps it isn't your words for it, and your own go instead, without it.
  const heardAs = out.heardAs?.sessionId === to.sessionId ? [out.heardAs.said] : [];
  const off = [...((found?.indirect ? found.loose?.dropped : found?.dropped) ?? []), ...heardAs, ...saidToAppParts(s.text)];
  const earlier = [...(s.question ? [s.question.text] : []), ...(POINTS_BACK.test(s.text) || partial ? s.recent : []), ...(s.kept?.texts ?? [])];
  // A name said for it that's none of the sessions' ("Ask Macy …" for Lacy) is the direction too.
  const heard = misheard(s.text, to, s.sessions)?.heard;
  const names = [...s.sessions.flatMap((x) => [...nameWords(x), ...nameWords(x, "title")]), ...(heard ? [heard] : [])];
  const r = routerWords({ message, said: s.text, off, earlier, partial, names });
  if (r.ok) {
    if (r.cut.length) (out.guards ??= []).push({ ...base, why: "cut", cut: r.cut, sent: r.text });
    return r.text;
  }
  return own(r.why, { ...(r.added ? { added: r.added } : {}), ...(r.lost ? { lost: r.lost } : {}) });
}

/**
 * A session is waiting for your reply, and the classifier or the router picked another one to message: your
 * words are the waiting one's reply unless they name the other one (its name, folder or title, as
 * loosely as speech gives it: "what about lacy?"; or up front by a name heard as other words, "Too
 * rowing, …": Decision.heardAs), point elsewhere ("the other one", "tell that
 * instance", "unrelated, but"), or are about this voice app and it's the one working on it. The case
 * it's for: a follow-up question on the waiting session's own topic from half an hour before went to
 * another session the router picked. An answer to the app's own question ("which one?") picks for itself. Only the window
 * that's open: a session that just spoke (its window closed) still loses to a better pick, since
 * you may well have moved on (the router weighs it, with the topics each was asked about).
 */
function keepWaiting(s: DecideState, out: Decision, picked: Session, by: string): Session | Target {
  const w = s.waiting;
  if (!w || w.permission !== undefined || picked.sessionId === w.sessionId || s.appAsked) return picked;
  if (wordsName(s, picked) || POINTS_ELSEWHERE.test(s.text) || out.heardAs?.sessionId === picked.sessionId) return picked;
  if (folderName(picked.cwd) === APP_FOLDER && aboutVoiceApp(s.text)) return picked;
  const to = findSession(s.sessions, w.sessionId) ?? { sessionId: w.sessionId, cwd: w.cwd };
  (out.guards ??= []).push({ rule: "waiting_wins", by, from: picked.sessionId, fromName: sessionName(picked), to: w.sessionId, text: s.text });
  return to;
}

/**
 * Whether your words name this session, or two words in a row of its title ("the library focus
 * fix" for "ClipKit export window jump"). In the waiting one's folder, only by what's its alone (a
 * name of its own, its title): the folder names the waiting one just as well.
 */
function wordsName(s: DecideState, session: Session) {
  if (titleNamed(s, session)) return true;
  if (session.cwd === s.waiting?.cwd) return mentionsSession(session, s.text, "own");
  return mentionsSession(session, s.text) || sessionsNamed([session], s.text, true).length > 0;
}

/** Two words in a row of its title, each longer than three letters. */
function titleNamed(s: DecideState, session: Session) {
  const said = ` ${wordsOf(s.text)} `;
  const title = wordsOf(session.title ?? "").split(" ");
  return title.slice(1).some((w, i) => w.length > 3 && title[i].length > 3 && said.includes(` ${title[i]} ${w} `));
}

/**
 * A send the router aimed (`by`, its tool), marked unsure unless you weren't left guessing: it's
 * the waiting session's reply, your words ask for every session, or name this one (by what's its
 * alone when another shares its folder), or answer the app's question that named it ("Want me to
 * send it to Lacy?" "Yes."; "Which session?" "Clipkit."). Else a guess: the router picked it from
 * the conversation, or a guard did (the one that just spoke, the one dealt with last in a folder).
 * With `out` (the classifier's read in it), also a send the other reads of your words disagree
 * with (disagrees), whatever made it look sure.
 */
function unsure<A extends Act>(s: DecideState, act: A, by: string, out?: Decision): A {
  if (act.type !== "send" && act.type !== "ask" && act.type !== "resend") return act;
  const why = unsureWhy(s, act.session, by) ?? (out ? disagrees(s, out, act.session, by) : undefined);
  return why ? { ...act, unsure: why } : act;
}

/**
 * Where the router (`by`) sends your words, against the other reads of them: the classifier picked
 * another session, or your words call another one by its name (calledByName) and not this one.
 * Then the send is a guess, said and held a moment ("To mintbox."; "no, kiko dev" or "cancel"
 * changes it), never typed in silently: the router once sent "… I restarted Kiko Dev … the Kikodev
 * session …" to mintbox for "Ivy Beta" in its title, with the classifier on kiko-dev. Asking instead
 * would cost a question every time; trusting the classifier below its bar would undo the bar.
 *
 * The classifier counts from NAMED_MIN_CONFIDENCE (or its bar, if lower), or, for the session
 * waiting for your reply or that just spoke, only from its bar: a reply to that one is where words
 * go by default, and the classifier's picks of another there were wrong at 0.76–0.80 (OTHER_THAN_PENDING).
 * A name doesn't hold back a reply either: answers mention other sessions ("do what clipkit did").
 */
function disagrees(s: DecideState, out: Decision, to: Session | Target, by: string): string | undefined {
  if (EVERY.test(s.text)) return undefined;
  const called = calledByName(s.sessions, s.text);
  const session = findSession(s.sessions, to.sessionId);
  // Your words have its name in them ("can mintbox look at it?"), not only words of its title.
  if (called.some((x) => x.sessionId === to.sessionId) || (session && sessionsNamed([session], s.text, true, true).length)) return undefined;
  const pending = to.sessionId === (s.waiting?.permission === undefined ? s.waiting?.sessionId : undefined) || to.sessionId === s.justSpoke?.id;
  const d = out.utterance;
  const min = pending ? s.classifierMinConfidence : Math.min(s.classifierMinConfidence, NAMED_MIN_CONFIDENCE);
  if (d && d.audience !== "app" && d.audience.sessionId !== to.sessionId && d.audienceConfidence >= min) return `${by}; classifier: ${sessionName(d.audience)}`;
  if (!pending && called.length === 1) return `${by}; named: ${sessionName(called[0])}`;
  return undefined;
}

/**
 * The router (`by`) kept your words for the app itself, a quick check of its own or (`answered`)
 * only its answer, while the other reads of them say they were for a session: the session they go
 * to instead, or null. Once, "Hey Bobby, can you also look at … what could be
 * sped up …" with the classifier on Bobby at 0.79 ran Kiko's quick check in ~, and you answered
 * its permission prompts, Bobby never asked.
 *
 * - Spoken to up front ("Hey Bobby, …", addressedByName): there, as "Bobby, …" goes with no model
 *   at all. Sure, whatever the classifier says: words that name a send's session make it so (disagrees).
 * - For a quick check only, called by name elsewhere in the words (calledByName), or the
 *   classifier's pick at its own bar (it lost only to the bar raised for a session waiting or that
 *   just spoke): there, but unsure, so "To Bobby." is said and held a moment, and "cancel" or "no,
 *   kiko dev" changes it. Not the check held instead ("Checking it myself, not Bobby"): a hold is of
 *   words on their way to a session (hold.ts), and "no, Bobby" a resend of them; the session can run
 *   the same check, with what it knows of the work.
 * - Its own answer stays otherwise: "is the Bobby session done?" asks the app, not Bobby.
 *
 * Never when the router also sent your words somewhere, or they're for every session.
 */
async function sessionInstead(s: DecideState, deps: DecideDeps, out: Decision, by: string, appParts: number | null, answered: boolean): Promise<Act | null> {
  if (EVERY.test(s.text)) return null;
  if (out.router?.actions.some((a) => a.name !== "quick_task")) return null;
  const reachable = s.sessions.filter((x) => x.place || x.sessionId === s.waiting?.sessionId);
  const spokenTo = addressedByName(reachable, s.text);
  let to: Session | undefined;
  let why: string | undefined;
  if (spokenTo.length === 1) to = spokenTo[0];
  else if (!answered) {
    const called = calledByName(reachable, s.text);
    const d = out.utterance;
    const picked = d && d.audience !== "app" && d.audienceConfidence >= s.classifierMinConfidence ? findSession(reachable, d.audience.sessionId) : undefined;
    to = called.length === 1 ? called[0] : picked;
    if (to) why = `${by}; ${called.length === 1 ? "named" : "classifier"}: ${sessionName(to)}`;
  }
  if (!to) return null;
  (out.guards ??= []).push({ rule: "session_over_app", by, from: "app", fromName: "app", to: to.sessionId, text: s.text });
  const act = await send(s, deps, out, to, addressedTo([to], s.text) ?? heardPhrase(out, to), appParts);
  return why ? { ...act, unsure: why } : unsure(s, act, by, out);
}

function unsureWhy(s: DecideState, to: Session | Target, by: string): string | undefined {
  if (s.waiting && s.waiting.permission === undefined && to.sessionId === s.waiting.sessionId) return undefined;
  if (EVERY.test(s.text)) return undefined;
  const session = findSession(s.sessions, to.sessionId);
  if (!session) return by;
  const twin = s.sessions.some((x) => x !== session && x.cwd === session.cwd);
  if (wordsName(s, session) && (!twin || mentionsSession(session, s.text, "own") || titleNamed(s, session))) return undefined;
  if (s.appAsked) {
    const asked = s.recent.at(-1) ?? "";
    if (asked.startsWith("app said: ") && asked.toLowerCase().includes(spoken(sessionName(session)).toLowerCase())) return undefined;
    const named = sessionsNamed(s.sessions, withSpelled(s.text), true);
    if (named.length === 1 && named[0] === session) return undefined;
  }
  return by;
}

/** A phrase naming the waiting session ("for claude code speech, …"), to cut from its reply. */
function forWaiting(s: DecideState, text: string): Addressed | null {
  const waiting = findSession(s.sessions, s.waiting?.sessionId);
  return waiting ? addressedTo([waiting], text) : null;
}

/**
 * The router's messages to several sessions at once (one question asked of all three, though it was
 * about one session's work) go to one, unless your
 * words name each of them or ask for all, both or each. The one: the session waiting for your
 * reply, else the one that just spoke, else the router's first pick when the topic is clearly its
 * (its last ask and earlier topics share the most words with yours). Otherwise the app asks.
 */
function oneTarget(s: DecideState, out: Decision, actions: RouterAction[]): { actions: RouterAction[]; ask: boolean } {
  const isMessage = (a: RouterAction): a is RouterAction & { name: "pass_on" | "ask_session" } => a.name === "pass_on" || a.name === "ask_session";
  const messages = actions.filter(isMessage);
  const ids = [...new Set(messages.map((a) => a.session.sessionId))];
  if (ids.length < 2 || EVERY.test(s.text) || messages.every((a) => wordsName(s, a.session))) return { actions, ask: false };
  const pending = s.waiting?.permission === undefined ? (s.waiting?.sessionId ?? s.justSpoke?.id ?? null) : null;
  const keep =
    messages.find((a) => a.session.sessionId === pending) ??
    (s.waiting ? messages[0] : null) ??
    (ownsTopic(
      s,
      messages[0].session,
      messages.slice(1).map((a) => a.session),
    )
      ? messages[0]
      : null);
  for (const a of messages) {
    if (a === keep) continue;
    (out.guards ??= []).push({ rule: "one_target", by: `router ${a.name}`, from: a.session.sessionId, fromName: sessionName(a.session), to: keep?.session.sessionId ?? null, text: s.text });
  }
  return { actions: actions.filter((a) => !isMessage(a) || a === keep), ask: !keep };
}

/** Whether your words share more with what `first` was asked (last, and before) than with any of `others`. */
function ownsTopic(s: DecideState, first: Session, others: Session[]) {
  const said = new Set(topicWords(s.text).map((w) => w.replace(/s$/, "")));
  const score = (x: Session) => {
    const note = s.notes.get(x.sessionId);
    const asked = topicWords([note?.asked ?? "", ...(note?.topics ?? [])].join(" "));
    return asked.filter((w) => said.has(w.replace(/s$/, ""))).length;
  };
  const mine = score(first);
  return mine > 0 && others.every((x) => score(x) < mine);
}

/**
 * How close a name said is to a session's (its name or folder, a word at a time), spelled as said (a
 * soft "c" as "s", a hard one as "k"): 1 the same, 0 nothing alike. "Macy" and "Lazey" for Lacy
 * are 0.8 and 0.67. For the log of a guess (Decision.guess).
 */
export function nameScore(heard: string, session: Session): number {
  const said = wordsOf(heard).split(" ").filter(Boolean);
  const own = [sessionName(session), folderName(session.cwd)].flatMap((n) => wordsOf(n).split(" ")).filter((w) => w.length > 2);
  let best = 0;
  for (const w of said) {
    for (const n of own) {
      const a = sounded(w);
      const b = sounded(n);
      best = Math.max(best, 1 - distance(a, b) / Math.max(a.length, b.length));
    }
  }
  return Math.round(best * 100) / 100;
}

/**
 * The word in what you said that's likely `session`'s name heard wrong ("Lazey" for Lacy): no
 * session's name itself, at least four letters, and closer to it than not (nameScore over 0.5).
 * Null when there's none.
 */
function misheard(text: string, session: Session, sessions: Session[]): { heard: string; score: number } | null {
  const names = new Set(sessions.flatMap((x) => nameWords(x)));
  let best: { heard: string; score: number } | null = null;
  for (const w of wordsOf(text).split(" ")) {
    if (w.length < 4 || names.has(asHeard(w))) continue;
    const score = nameScore(w, session);
    if (score > 0.5 && (!best || score > best.score)) best = { heard: w, score };
  }
  return best;
}

/** "Stop Lacy?" the app asked a moment ago, when your words came close to its name: Lacy. */
function stopAsked(s: DecideState): Session | null {
  const m = s.recent.at(-1)?.match(/^app said: Stop (.+)\?$/);
  return (m && s.sessions.find((x) => spoken(sessionName(x)).toLowerCase() === m[1].toLowerCase())) || null;
}

/**
 * Escape in `target`, the router's pick, never another session: only when your words name it
 * (several named in one go is fine; letters spelled out, "L-A-C-Y", count), or name none and it's
 * the one session that's busy. Words that only come close to its name ("stop lazy" for Lacy,
 * "clipkid" for clipkit) get a yes-or-no question first. Otherwise a request to stop two sessions,
 * one of them misheard, pressed Escape twice in the one heard right, since both stops were moved there.
 */
function stopFor(s: DecideState, target: Session): Act {
  const said = withSpelled(s.text);
  const named = sessionsNamed(s.sessions, said, true);
  const unclear: Act = { type: "say", text: STOP_WHICH, why: "stop_unclear" };
  if (named.some((x) => x.sessionId === target.sessionId)) {
    // "Stop claude code speech" with two sessions there: the folder names both.
    const twin = named.some((x) => x !== target && x.cwd === target.cwd);
    return twin && !mentionsSession(target, said, "own") ? unclear : { type: "stop", session: target };
  }
  if (!named.length) {
    if (mentionsSession(target, said)) return { type: "stop", session: target };
    const busy = s.sessions.filter((x) => x.status === "busy" && x.place?.keys);
    if (busy.length === 1 && busy[0].sessionId === target.sessionId) return { type: "stop", session: target };
  }
  if (nearName(target, said, s.sessions)) return { type: "say", text: `Stop ${spoken(sessionName(target))}?`, why: "stop_confirm" };
  return unclear;
}

const STOP_WHICH = "Stop which one? Say its name.";

// The end of resend's question about a correction it couldn't place ("That already went to Kiko
// project. Which session was it for?"), as the conversation has it.
const RESEND_ASKED = /^app said: .*\bWhich session was it for\?$/;

const STOP_ONLY = /^\W*(?:(?:ok(?:ay)?|no|hey|wait|uh|um|so|please|can you|could you|you can)[\s,]+)*(?:stop|interrupt)\s+(?<rest>.+?)[\s.!]*$/i;
const FILLER_WORDS = new Set("and both the session sessions one ones please now too also uh um".split(" "));

/**
 * "Stop clipkit.", "Stop lazy and clipkit.": "stop" and nothing but names, which the code reads
 * itself (the router took "Stop lazy." as words for Lacy now and then): each session named is
 * stopped, one only come close to ("lazy" for Lacy) is asked about. Null when other words are in
 * it ("stop the deploy", "stop clipkit, it's going the wrong way"): the router reads those.
 */
function stopNamed(s: DecideState): Act[] | null {
  const rest = STOP_ONLY.exec(s.text)?.groups?.rest;
  if (!rest) return null;
  const said = withSpelled(rest);
  const found = sessionsNamed(s.sessions, said, true);
  // "Stop Kiko project" with "Kiko project 2" there too names both: only those said by number (or
  // title) are stopped, and with none of them, the app asks which.
  const twins = new Set(found.filter((x) => found.some((y) => y !== x && sameNumberedName([x, y]))));
  const named = found.filter((x) => !twins.has(x) || mentionsSession(x, said, "own"));
  if (twins.size && !named.some((x) => twins.has(x))) return [{ type: "say", text: STOP_WHICH, why: "stop_unclear" }];
  const near = s.sessions.filter((x) => !found.includes(x) && nearName(x, said, s.sessions));
  if (!named.length && !near.length) return null;
  const sound = (w: string) => w.replace(/c(?=[eiy])/g, "s").replace(/c/g, "k");
  const nameWords = [...named, ...near].flatMap((x) => [sessionName(x), folderName(x.cwd), x.title ?? ""].flatMap((n) => wordsOf(n).split(" ")));
  const spelled = new Set(wordsOf(said).split(" ").slice(wordsOf(rest).split(" ").length));
  const explained = (w: string) => FILLER_WORDS.has(w) || w.length === 1 || spelled.has(w) || nameWords.some((n) => n === w || distance(sound(w), sound(n)) <= 2);
  if (!wordsOf(rest).split(" ").every(explained)) return null;
  const manage = voiceAllows(s.voiceCan, "manage");
  const acts: Act[] = named.map((x) => gate(s, { type: "stop", session: x }));
  if (near.length && manage)
    acts.push(near.length === 1 ? { type: "say", text: `Stop ${spoken(sessionName(near[0]))}?`, why: "stop_confirm" } : { type: "say", text: STOP_WHICH, why: "stop_unclear" });
  return acts.length ? acts : [{ type: "refused", what: "stop", session: near[0] }];
}

/** Words with any letters spelled out ("L-A-C-Y", "l a c y", "L.A.C.Y.") also as the word. */
function withSpelled(text: string) {
  const spelled = [...text.matchAll(/(?<![\p{L}\p{N}])\p{L}(?:[\s.-]+\p{L}(?![\p{L}\p{N}])){2,}/gu)].map((m) => m[0].replace(/[\s.-]+/g, ""));
  return spelled.length ? `${text} ${spelled.join(" ")}` : text;
}

// Words in a stop request that are never a name said wrong.
const NOT_A_NAME = new Set("stop stops both please that this them those these session sessions interrupt also just their it's okay".split(" "));

/**
 * Whether a word you said is, or sounds close to, a word of this session's name or folder ("lazy"
 * or "casey" for Lacy, "clipkid" for clipkit, "lacy" for lacy-platform): at most two letters apart
 * once spelled as said (a soft "c" as "s", a hard one as "k"), and not a word of another's name.
 */
function nearName(target: Session, text: string, sessions: Session[]) {
  const sound = (w: string) =>
    w
      .replace(/ph/g, "f")
      .replace(/ck/g, "k")
      .replace(/c(?=[eiy])/g, "s")
      .replace(/c/g, "k");
  const own = [sessionName(target), folderName(target.cwd)].flatMap((n) => wordsOf(n).split(" ")).filter((w) => w.length > 3);
  const others = new Set(sessions.filter((x) => x !== target).flatMap((x) => [sessionName(x), folderName(x.cwd)].flatMap((n) => wordsOf(n).split(" "))));
  return wordsOf(text)
    .split(" ")
    .filter((w) => w.length > 3 && !NOT_A_NAME.has(w) && !others.has(w))
    .some((w) => own.some((n) => distance(sound(w), sound(n)) <= Math.min(2, Math.floor(n.length / 2))));
}

// ── The app's "which session?" question ───────────────────────────────────────

/**
 * How an answer to "which session?" picked one: by its name, by a name it came close to (only among
 * those offered), by its place in the question ("the second one"), or the router read it.
 */
type PickHow = "name" | "near" | "order" | "router" | "yes";

// Words in an answer to "which session?" that only carry the pick: "uh, I think it should go to the
// Kiko one, please". Not "and", "but", "not": those say more.
const PICK_WORDS = new Set(
  (
    "uh um umm er erm ah oh hmm okay ok so yeah yes yep yup no well actually just like i i'd id i'm im think guess say said mean meant " +
    "it it's its that that's this one ones session sessions should would will can go goes going went send sent give put pass move " +
    "to for in into on the a an please thanks thank you was is be probably maybe definitely sure"
  ).split(" "),
);
// "The second one", "the last one": by the question's order.
const ORDINALS: Record<string, number> = { first: 0, "1st": 0, former: 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, last: -1, latter: -1 };
// Joining what comes after the pick: "Kiko, and also tell it …".
const CONNECTOR = /^(?:and|also|plus|then|but)$/;
// More after a pick that takes it back or changes it ("Lacy. No wait …"): the router reads those.
const CHANGES_PICK = /\b(?:no|nope|wait|never ?mind|scratch that|cancel|i mean|i meant|wrong|not)\b/i;
// Said as part of a pick, with the session's name: "the Lacy session", "the claude one".
const SESSION_WORDS = new Set("session sessions instance agent project terminal window thread claude code".split(" "));
// Said around a pick the router read: "not Lacy, the other one", "Kiko instead".
const ROUTER_PICK_WORDS = new Set("not other instead rather either".split(" "));

/** The one session offered whose number a word is ("two", "2"); "one" is never a number ("the second one"). */
function byNumber(offered: Session[], word: string): Session | null {
  const n = word === "one" ? 0 : saidNumber(word);
  if (n < 2) return null;
  const matching = offered.filter((x) => sessionNumber(x) === n);
  return matching.length === 1 ? matching[0] : null;
}

/** "Which one: Kiko project, Idea file; or Kiko project 2, Session colours?": each by its name and number, with Claude's title for it. */
function whichOne(sessions: Session[]) {
  const names = sessions.map(spokenWithTitle);
  return `Which one: ${names.slice(0, -1).join("; ")}; or ${names.at(-1)}?`;
}

/** The sessions the question offered, as they're listed now (one that ended is gone). */
function offeredIn(s: DecideState, q: Question): Session[] {
  return q.offered.flatMap((id) => findSession(s.sessions, id) ?? []);
}

/** "L-A-C-Y" as "LACY", so letters spelled out read as the word. */
const joinSpelled = (text: string) => text.replace(/(?<![\p{L}\p{N}])\p{L}(?:[\s.-]+\p{L}(?![\p{L}\p{N}])){2,}/gu, (m) => m.replace(/[\s.-]+/g, ""));

/** Each word with where it ends in `text`, lower case, "’" as "'". */
const tokensOf = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+(?:['’]\p{L}+)?/gu)].map((m) => ({ word: m[0].toLowerCase().replace(/’/g, "'"), end: m.index + m[0].length }));

const isPickWord = (w: string) => PICK_WORDS.has(w) || PICK_WORDS.has(w.replace("'", ""));

/** A word as session names are compared ("cloud" as "claude"). */
const asHeard = (w: string) => heardWords(w).join("");

/**
 * The one session among `offered` a word comes close to, as speech-to-text gets names wrong:
 * "Lucy" or "lazy" for Lacy. Spelled as said (a soft "c" as "s", a hard one
 * as "k"), it starts with the same sound and is at most about half the name's letters off. Only
 * against the names the question offered: never a word of another session's name, never a
 * dictionary entry, so here "Lucy" means the Lacy session only right after "Lacy or Pixie?".
 */
function nearOffered(offered: Session[], sessions: Session[], word: string): Session | null {
  if (word.length < 3) return null;
  if (sessions.some((x) => nameWords(x).includes(word))) return null;
  let best: { session: Session; d: number } | null = null;
  let tie = false;
  for (const session of offered) {
    for (const n of nameWords(session).filter((x) => x.length > 3)) {
      const d = nearDistance(word, n);
      if (d === null) continue;
      if (best && best.session !== session && d === best.d) tie = true;
      if (!best || d < best.d) {
        best = { session, d };
        tie = false;
      }
    }
  }
  return best && !tie ? best.session : null;
}

type Pick = { session: Session; how: Exclude<PickHow, "router">; extra: string | null };

/**
 * The session your answer to "which session?" picks, read in code: up front, nothing but words that
 * name one session (any by its name; one the question offered also by a name it comes close to), or
 * its place in the question ("the second one"), with fillers around them ("it should go to, uh,
 * Kiko, please"). `extra`: what you said after it, when there's more ("Kiko, and tell it to
 * check the logs too"). Null when no one session is named up front, something comes before it ("not
 * Lacy"), or what follows names another or changes the pick ("Lacy. No wait, Kiko."): the router
 * reads those, with the words asked about.
 */
function pickIn(s: DecideState, q: Question, said: string): Pick | null {
  const offered = offeredIn(s, q);
  const text = joinSpelled(said);
  const tokens = tokensOf(text);
  const sets: Session[][] = [];
  // The words of a name said, in order: "kiko project".
  const nameSaid: string[] = [];
  let how: Pick["how"] = "name";
  let end = 0;
  for (const { word, end: at } of tokens) {
    if (sets.length && CONNECTOR.test(word)) break;
    // "Number two": the number picks.
    if (isPickWord(word) || word === "number") continue;
    const place = ORDINALS[word];
    if (place !== undefined && offered.length > 1) {
      const one = offered.at(place);
      if (!one) return null;
      sets.push([one]);
      if (how === "name") how = "order";
      end = at;
      continue;
    }
    // "Two", "number two" when the question offered "Kiko project 2": its number (alone, or after its name).
    const numbered = byNumber(offered, word);
    if (numbered) {
      sets.push([numbered]);
      end = at;
      continue;
    }
    const heard = asHeard(word);
    const named = s.sessions.filter((x) => nameWords(x).includes(heard));
    if (named.length) {
      sets.push(named);
      nameSaid.push(word);
      end = at;
      continue;
    }
    const near = nearOffered(offered, s.sessions, heard);
    if (near) {
      sets.push([near]);
      how = "near";
      end = at;
      continue;
    }
    // "The lacy session": with a name, only part of it.
    if (sets.length && SESSION_WORDS.has(word)) continue;
    break;
  }
  if (!sets.length) return null;
  // Every word up front names the same one: "claude code speech", "the lacy platform one".
  const both = sets.reduce((a, b) => a.filter((x) => b.includes(x)));
  const among = both.length > 1 ? both.filter((x) => offered.includes(x)) : both;
  // "Kiko project" to "Kiko project, …; or Kiko project 2, …?": the one called just that, with no number.
  const plain = among.length > 1 ? among.filter((x) => !sessionNumber(x) && [sessionName(x), folderName(x.cwd)].some((n) => sameName(n, nameSaid.join(" ")))) : among;
  if (plain.length !== 1) return null;
  const session = plain[0];
  const rest = text.slice(end);
  const more = tokensOf(rest).filter((t) => !isPickWord(t.word));
  if (!more.length) return { session, how, extra: null };
  // More than a pick: it goes with the words asked about, unless it names another or changes the pick.
  if (CHANGES_PICK.test(rest)) return null;
  if (
    more.some(
      (t) =>
        s.sessions.some((x) => x !== session && nameWords(x).includes(asHeard(t.word))) ||
        nearOffered(
          offered.filter((x) => x !== session),
          s.sessions,
          asHeard(t.word),
        ),
    )
  )
    return null;
  const extra = rest
    .replace(/^[\s,.;:!?—–-]+/, "")
    .replace(/^(?:(?:and|also|plus|then)\b[\s,]*)+/i, "")
    .trim();
  return { session, how, extra: extra.charAt(0).toUpperCase() + extra.slice(1) };
}

/**
 * Whether your words do no more than pick `picked` (its name or title, a name it comes close to, its
 * place, "not Lacy, the other one", fillers, "yes"), for the router's pass_on while a question waits: it sends the words asked
 * about then, never these. Not a plain "no".
 */
function onlyPicks(s: DecideState, q: Question, picked: Session): boolean {
  const offered = offeredIn(s, q);
  const tokens = tokensOf(joinSpelled(s.text));
  const title = nameWords(picked, "title");
  const explained = tokens.every(({ word }) => {
    const heard = asHeard(word);
    return (
      isPickWord(word) ||
      word === "number" ||
      SESSION_WORDS.has(word) ||
      ROUTER_PICK_WORDS.has(word) ||
      ORDINALS[word] !== undefined ||
      Boolean(byNumber(offered, word)) ||
      title.includes(heard) ||
      s.sessions.some((x) => nameWords(x).includes(heard)) ||
      Boolean(nearOffered(offered, s.sessions, heard))
    );
  });
  const onlyNo = tokens.length > 0 && tokens.every(({ word }) => isPickWord(word)) && tokens.some(({ word }) => word === "no");
  return explained && !onlyNo;
}

/**
 * A yes to the app's offer to send your words to `to` ("Want me to send that to Bobby?"), and
 * nothing more, read in code: a yes word ("yes", "sure", "send", "pass", "go ahead", "do it"), with
 * only fillers and `to`'s own name around it ("Yeah, pass it along to Bobby, thanks."). Not with a
 * "no", "not" or "wait" in it, another session's name, or words of its own ("Yes, and ask it about
 * WireGuard": the router reads that, with the offer as <asked_where>).
 */
function offerAccepted(s: DecideState, to: Session, said: string): boolean {
  const tokens = tokensOf(joinSpelled(said));
  if (!tokens.length || !tokens.some(({ word }) => OFFER_YES.has(word))) return false;
  const own = nameWords(to);
  return tokens.every(({ word }) => {
    if (OFFER_NOT.has(word)) return false;
    if (OFFER_YES.has(word) || OFFER_FILLER.has(word) || SESSION_WORDS.has(word)) return true;
    return own.includes(asHeard(word));
  });
}

/** A no to the app's offer, up front ("No.", "Nah, I'll ask it myself."), naming no session ("No, send it to Lacy" picks Lacy). */
function offerDeclined(s: DecideState, said: string): boolean {
  if (!/^\W*(?:no|nope|nah|no thanks|not now)\b/i.test(said)) return false;
  return !tokensOf(joinSpelled(said)).some(({ word }) => s.sessions.some((x) => nameWords(x).includes(asHeard(word))));
}

/** An answer to "which session?": it sends the words asked about where it picks, or drops them. Null when it isn't one. */
async function answerQuestion(s: DecideState, deps: DecideDeps, out: Decision, q: Question, lead: Lead): Promise<Decision | null> {
  // As said, then without the app's name up front: "Kiko." picks the Kiko session; "Kiko, the first one." the first.
  const tries = lead.addressed && lead.rest ? [s.text, lead.rest] : [s.text];
  // "Yes. Actually, never mind." to "Did you mean Lacy?": nothing sent either.
  if (!q.told && tries.some(dropsQuestion)) {
    out.step = "question";
    out.question = { kind: "cancelled" };
    // Logged by the app with the words that weren't sent (app/deliver.ts settleQuestion); a take-back after
    // words of the answer's own ("Yes. Never mind.") as `retracted` too.
    const takenBack = tries.some((t) => answerTakenBack(t) === "taken" && !HELD_CANCEL.test(t));
    out.actions.push({ type: "say", text: "Okay, not sent.", ...(takenBack ? { why: "retracted" } : {}) });
    return out;
  }
  // "Did you mean Lacy?" (one session offered): a plain yes sends the words there; a plain no drops
  // them. A name ("Lacy", "no, the Kiko project") picks as for any question, below.
  const offered = offeredIn(s, q);
  if (!q.told && offered.length === 1 && (q.offer || DID_YOU_MEAN.test(q.line))) {
    // "Want me to send that to Bobby?": a yes in more words too ("Yes, pass it to Bobby.", "Send it.").
    if (tries.some((t) => (bareReply(t) && YES_FALLBACK.test(t.trim())) || (q.offer && offerAccepted(s, offered[0], t)))) {
      out.step = "question";
      out.question = { kind: "answered", sessionId: offered[0].sessionId, how: "yes" };
      out.actions.push({ type: "send", session: { sessionId: offered[0].sessionId, cwd: offered[0].cwd }, text: q.text });
      return out;
    }
    // To an offer, a no in more words too ("Nah, I'll ask it myself."), unless it names a session ("No, send it to Lacy").
    if (tries.some((t) => (bareReply(t) && NO_FALLBACK.test(t.trim())) || (q.offer && offerDeclined(s, t)))) {
      out.step = "question";
      out.question = { kind: "cancelled" };
      out.actions.push({ type: "say", text: "Okay, not sent.", ...(q.offer ? { why: "offer_declined" } : {}) });
      return out;
    }
  }
  for (const said of tries) {
    const pick = pickIn(s, q, said);
    if (!pick) continue;
    // Moved on from: a pick with more to it ("Lacy, run the tests") is new words for that session.
    if (q.told && pick.extra) continue;
    let added = pick.extra;
    // The rest of your answer goes as you said it, cleaned up like any words for a session.
    if (added && deps.clean) {
      try {
        const c = await deps.clean(said);
        const again = c.cleaned ? pickIn(s, q, c.text) : null;
        if (again?.session === pick.session && again.extra) added = again.extra;
      } catch {
        // As said.
      }
    }
    out.step = "question";
    out.question = { kind: "answered", sessionId: pick.session.sessionId, how: pick.how, ...(added ? { added } : {}) };
    out.actions.push({
      type: "send",
      session: { sessionId: pick.session.sessionId, cwd: pick.session.cwd },
      text: added ? `${q.text}\n\n${added}` : q.text,
      // A name it only came close to is a guess: said, and held a moment for a correction.
      ...(pick.how === "near" ? { unsure: "question near name" } : {}),
    });
    return out;
  }
  return null;
}

/**
 * The app's last words ask which session yours are for (the router's own question, or "Which
 * session is that for?"): the app keeps them, as they'd have gone, with the sessions it named
 * (every one it can reach when it named none), so a bare "Kiko" next sends them there. Not a
 * question about something else ("Stop which one?", "How is it spelled?"), nor about words that
 * were an instruction to the app ("stop it", "start a new one").
 */
async function asksWhere(s: DecideState, deps: DecideDeps, out: Decision) {
  if (out.correction || out.question || !out.actions.length || !out.actions.every((a) => a.type === "say")) return;
  const last = out.actions.at(-1) as Act & { type: "say" };
  if (last.why && last.why !== "one_target_unclear" && last.why !== "claimed_without_action") return;
  const line = last.text;
  if ((!asksYou(line) && !OFFERS_SESSION.test(line)) || NOT_A_MESSAGE_QUESTION.test(line)) return;
  const reachable = s.sessions.filter((x) => x.place || x.sessionId === s.waiting?.sessionId);
  const said = heardWords(line);
  const at = (x: Session) => {
    // One of a numbered name, where its whole name is: "Kiko project" isn't where "Kiko project 2" is.
    if (x.number) {
      const full = heardWords(sessionName(x));
      for (let i = 0; i + full.length <= said.length; i++) {
        if (full.every((w, k) => said[i + k] === w) && (sessionNumber(x) > 0 || !/^\d/.test(said[i + full.length] ?? ""))) return i;
      }
    }
    const names = nameWords(x);
    const i = said.findIndex((w) => names.includes(w));
    return i < 0 ? Infinity : i;
  };
  const named = reachable.filter((x) => at(x) < Infinity).sort((a, b) => at(a) - at(b));
  // "Did you mean Lacy?" names one: kept as a question about it too, so a yes sends the words there.
  const confirms = DID_YOU_MEAN.test(line) && named.length === 1;
  // "I can pass your question along to Bobby if you want.": the router offering one session in its
  // own words, which it's told never to do (offer_session instead). Kept as that offer all the same,
  // so a yes sends the words there, not itself (once, "Yes, pass it to Bobby." reached Bobby).
  const offers = !confirms && OFFERS_SESSION.test(line) && named.length === 1;
  if (!WHICH_SESSION.test(line) && named.length < 2 && !confirms && !offers) return;
  const { text } = s;
  if (BARE_STOP.test(text) || STOP_ONLY.test(text) || ASKED_FOR_NEW.test(text) || DICTIONARY_REQUEST.test(text)) return;
  // A short, unclear answer to the last one ("hmm, the other one?"), asked again: still about the words before.
  const again = s.question && s.appAsked && wordsOf(text).split(" ").length <= 6;
  const words = again ? s.question!.text : (await clean(s, deps, { type: "send", session: { sessionId: "", cwd: "" }, text })).text;
  out.question = { kind: "asked", question: { text: words, offered: (named.length ? named : reachable).map((x) => x.sessionId), line, ...(offers ? { offer: true } : {}) } };
}

/**
 * The router's pick is one of a numbered name's ("Kiko project", "Kiko project 2"), and your words
 * name them only by the name they share ("can the Kiko project check the logs?"): the app asks which,
 * as when that name is said up front, rather than send them to its guess. Not when the words name one
 * by its number or title, name none of them (the router went by the topic), or one of them is waiting
 * for your reply or just spoke, nor in an answer to the app's own question.
 */
async function numberedUnclear(s: DecideState, deps: DecideDeps, out: Decision, picked: Session, appParts: number | null): Promise<Act | null> {
  if (s.question || s.appAsked || out.question) return null;
  const twins = sameNumberedName(s.sessions.filter((x) => x.sessionId === picked.sessionId || sameNumberedName([picked, x])));
  if (!twins) return null;
  const pending = [s.waiting?.sessionId, s.justSpoke?.id];
  if (twins.some((x) => pending.includes(x.sessionId))) return null;
  if (!twins.some((x) => mentionsSession(x, s.text, "name"))) return null;
  if (twins.some((x) => mentionsSession(x, s.text, "own") || titleNamed(s, x))) return null;
  const line = whichOne(twins);
  const words = (await send(s, deps, out, picked, addressedTo(twins, s.text), appParts)).text;
  out.question = { kind: "asked", question: { text: words, offered: twins.map((x) => x.sessionId), line } };
  return { type: "say", text: line, why: "numbered_unclear" };
}

/**
 * Two sessions in one folder, and your words name only that folder ("ask claude code speech to …"):
 * they're equally close, so the one dealt with last gets them over the router's pick of the other.
 * Words that name its pick by what's its alone (a name of its own, its title) keep it.
 */
function folderTie(s: DecideState, picked: Session): Session {
  const last = findSession(s.sessions, s.lastId);
  if (!last || last.sessionId === picked.sessionId || last.cwd !== picked.cwd) return picked;
  return mentionsSession(picked, s.text, "folder") && !mentionsSession(picked, s.text, "own") ? last : picked;
}

/** How needsChanges begins when it offers a session already there: no handOff for it (app.ts), the router sends it. */
export const NEEDS_CHANGES_SEND = "A quick check can only look, and that needs a change. Want me to send it to ";

/**
 * A quick task can't change things: the offer of a session that can, in its folder; from the home
 * folder (a Mac setting, files in Downloads: no project's), in a scratch folder, never ~ itself. It
 * says why ("That needs changes." alone puzzled). A yes
 * starts a new one in code (handOff); one already there is the router's to send it to.
 */
export function needsChanges(sessions: Session[], cwd: string) {
  const there = sessions.find((x) => x.cwd === cwd && x.kind === "interactive" && x.place);
  if (there) return `${NEEDS_CHANGES_SEND}${spoken(sessionName(there))}?`;
  if (cwd === homedir()) return "That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?";
  return `That would change something, and a quick check can only look. Want me to start a session in ${spoken(folderName(cwd))} to do it?`;
}

/** Where a yes to the offer of a session for something from the home folder opens it: a scratch folder, or ~ when your words say "home". */
function homeOrScratch(text: string): StartPlace {
  return /\bhome\b/i.test(text) ? { kind: "home", cwd: homedir() } : { kind: "scratch", said: null };
}

/**
 * The session your words name, over the router's pick: when they name sessions (names before
 * titles) and its pick isn't one of them, the one they name; several they name equally is ambiguous.
 */
function resolve(sessions: Session[], text: string, picked: Session): Session | "ambiguous" {
  const named = sessionsNamed(sessions, text);
  if (!named.length) return picked;
  if (named.length > 1) return "ambiguous";
  return named[0];
}

/** "Say clipkit or claude code speech." for the sessions the words name. */
function choices(sessions: Session[], text: string) {
  const names = sessionsNamed(sessions, text).map(spokenWithTitle);
  return names.length > 1 ? `${names.slice(0, -1).join("; ")} or ${names.at(-1)}?` : "Say its name.";
}

/** Text with a phrase taken out, ignoring case. */
function without(text: string, phrase: string) {
  const at = text.toLowerCase().lastIndexOf(phrase.toLowerCase().trim());
  return at < 0 || !phrase.trim() ? text : `${text.slice(0, at)} ${text.slice(at + phrase.trim().length)}`;
}

/**
 * "More" (routing-rules.ts moreRequest), for which session's reply: the one your words name, else the
 * one whose screen they're said in, else the one you heard last. Null: not a "more" (a name up front
 * that's no session's, or nothing heard yet and no session named).
 */
function moreOf(s: DecideState): Act | null {
  const asked = moreRequest(s.text);
  if (!asked) return null;
  // A session's name: one session, and the words are hardly more than its name ("the Lacy session").
  const sessionNamed = (words: string) => {
    const found = sessionsNamed(s.sessions, words, true);
    return found.length === 1 && wordsOf(words).split(" ").length <= 3 ? found[0] : null;
  };
  if (asked.lead && !sessionNamed(asked.names[0])) return null;
  const named = asked.names.map(sessionNamed).find(Boolean) ?? null;
  // "More about Lacy" names the session, not a topic called Lacy.
  const topic = asked.topic && named && sessionNamed(asked.topic) === named ? null : asked.topic;
  const sessionId = named?.sessionId ?? s.to?.sessionId ?? s.heardFrom ?? null;
  return sessionId ? { type: "more", sessionId, topic } : null;
}

/** "Repeat that", or "repeat the last clipkit message" for the session your words name. */
function repeat(s: DecideState): Act {
  return repeatFor(s) ?? { type: "repeat", session: null };
}

/** A repeat of one session's last summary: the one your words name, or `fallback`. */
function repeatFor(s: DecideState, fallback?: Session): Act | null {
  const named = sessionsNamed(s.sessions, s.text, true);
  const session = named.length === 1 ? named[0] : named.length ? null : (fallback ?? null);
  return session ? { type: "repeat", session } : null;
}

/** "No, that was for clipkit": the last message, to the session it was meant for. */
function resend(s: DecideState, to: Session): Act {
  const last = s.lastSent!;
  // "Yeah." or "Sure" means something only to the session it answered: sent on, it reads as a yes
  // to whatever the other one last asked.
  // Back to the one session it went to: a misread correction ("to cloud code speech. I didn't mean
  // for this session"), so the app asks where it was meant to go.
  if (to.sessionId === last.sessionId && !last.also?.length) {
    const name = spoken(sessionName(to));
    const where = last.held ? `That's going to ${name}.` : last.undone ? `That went to ${name}, and you cancelled it.` : `That already went to ${name}.`;
    return { type: "say", text: `${where} Which session was it for?`, why: "resend_same" };
  }
  const got = last.sessionId === to.sessionId || Boolean(last.also?.some((x) => x.sessionId === to.sessionId));
  // Held, nobody got them: "that's for clipkit" says where they belong.
  if (!got && !last.held && bareReply(last.text)) {
    return {
      type: "say",
      text: `"${last.text.trim()}" was a reply to ${spoken(last.folder)}, so I didn't send it on. What should ${spoken(sessionName(to))} get?`,
      why: "bare_reply_not_resent",
    };
  }
  // Its name up front, said or heard as other words ("Too rowing, do we have …" for Rowan): it goes
  // without it, as words named for it do.
  const rest = got ? null : (addressedTo([to], last.text)?.rest ?? nameHeardAs([to], last.text)?.rest ?? null);
  return { type: "resend", session: to, last, ...(rest && rest !== last.text ? { text: rest } : {}) };
}

/**
 * Where a correction that came back to the session your words went to means them to go instead
 * (the router's resend_to: "That was too rowing, not to Kiko." once picked Kiko
 * project, "not to Kiko" taken for the target): the one other session your words name, else the
 * one they sound like (heard-as.ts soundsLikeIn). Never one named after "not" or "never" ("no, not
 * Bobby, the other one"). Null when neither.
 */
function correctedTo(s: DecideState): Session | null {
  const last = s.lastSent!;
  const others = s.sessions.filter((x) => (x.place || x.sessionId === s.waiting?.sessionId) && x.sessionId !== last.sessionId);
  const said = s.text.replace(/\b(?:not|never)\b[^,.;:!?]*/gi, " ");
  const named = others.filter((x) => mentionsSession(x, said) || sessionsNamed([x], said, true, true).length > 0);
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  return soundsLikeIn(others, said)?.session ?? null;
}

/** The session a name heard as other words up front points to (Decision.heardAs), as listed now. */
function heardAsOf(s: DecideState, out: Decision): Session | undefined {
  return out.heardAs ? findSession(s.sessions, out.heardAs.sessionId) : undefined;
}

/**
 * The words up front that only called `to` by a name heard as other words ("Too rowing,"), as a
 * phrase to cut from what goes there (Addressed); null when they called another, or none.
 */
function heardPhrase(out: Decision, to: Session | Target): Addressed | null {
  const h = out.heardAs;
  if (!h || h.sessionId !== to.sessionId) return null;
  return { sessions: [], rest: h.rest, dropped: h.said, sure: false };
}

/**
 * Your words for a session, minus the parts that were for the app: a phrase naming that session
 * ("ah, for the in-app settings one", "tell atlas agents to"), or, when the classifier hears parts for the
 * app that no phrase covers, what a quick model call drops. Deletions only; your words otherwise.
 */
async function send(s: DecideState, deps: DecideDeps, out: Decision, to: Session | Target, named: Addressed | null, appParts: number | null): Promise<Act & { type: "send" }> {
  const { text, sessions } = s;
  const session = { sessionId: to.sessionId, cwd: to.cwd };
  // The direction to it off, in code, and reported speech made direct where that's mechanical
  // (direction.ts): "Ask MintBox, what do I …" → "What do I …", "Tell Harbor not to push yet" →
  // "Don't push yet.", "…, send that to Harbor." Never a reply to the session waiting for one: that
  // goes as said (less its name up front, below). A question that isn't mechanical to turn around
  // goes as said, the direction off: "Ask MintBox whether the notarization went through" → "The
  // notarization went through?" (handing it to the router to write instead cost ~2.5s for the same
  // verdicts in the eval, 2026-11-16).
  const full = findSession(sessions, to.sessionId);
  if (full && !replyTo(s, to)) {
    // A name heard as other words up front (Decision.heardAs: "Ask, uh, Mint box, um, whether …")
    // is read as its name here, so the direction around it comes off as it would around the name
    // ("Is the crash fixed …?"), not only the words heard ("Um, whether the …"). As said in the log.
    const h = out.heardAs?.sessionId === to.sessionId ? out.heardAs : null;
    const name = h ? callNames(full)[0] : undefined;
    const at = h && name ? text.indexOf(h.heard) : -1;
    const read = h && name && at >= 0 ? `${text.slice(0, at)}${name}${text.slice(at + h.heard.length)}` : text;
    const found = directionOff(read, full, sessions);
    const d = found?.indirect ? found.loose : found;
    if (d?.dropped.length) {
      const dropped = read === text ? d.dropped : d.dropped.map((x) => x.replace(name!, h!.heard));
      const phrased = { type: "send" as const, session, text: d.text, trimmed: { kept: d.text, dropped, by: "phrase" as const } };
      return clean(s, deps, await toAppLeftOut(s, deps, out, to, phrased));
    }
  }
  // A phrase naming another session stays: it's about that one, or tells Claude something.
  if (named && (!named.sessions.length || named.sessions.some((x) => x.sessionId === to.sessionId))) {
    const phrased = { type: "send" as const, session, text: named.rest, trimmed: { kept: named.rest, dropped: [named.dropped], by: "phrase" as const } };
    return clean(s, deps, await toAppLeftOut(s, deps, out, to, phrased));
  }
  // Words said to the app by its name ("…, and Kiko, slow down when you read the results", "Thanks
  // Kiko."): left out, in code or by the trim, whatever the classifier heard.
  if (namesSaidToApp(text).length) return clean(s, deps, await toAppLeftOut(s, deps, out, to, { type: "send", session, text }));
  if (appParts === null || appParts < APP_PARTS || !deps.trim) return clean(s, deps, { type: "send", session, text });
  const t = await deps.trim({ text, to: findSession(sessions, to.sessionId) ?? to, sessions });
  out.llmCostUsd += t.costUsd;
  if (!t.dropped.length) return clean(s, deps, { type: "send", session, text });
  return clean(s, deps, { type: "send", session, text: t.text, trimmed: { kept: t.text, dropped: t.dropped, by: "model", ms: t.ms } });
}

/** Whether words for `to` are a reply to it: it's the session waiting for one (not a permission prompt). */
function replyTo(s: DecideState, to: Session | Target) {
  return Boolean(s.waiting && s.waiting.permission === undefined && s.waiting.sessionId === to.sessionId);
}

/**
 * One session's part of words that gave several a part each (splitBySession): sent as words named for
 * it are, the direction to it, the "and" and the others' parts left out; and anything said to the app.
 */
async function sendPart(s: DecideState, deps: DecideDeps, out: Decision, part: SessionPart): Promise<Act & { type: "send" }> {
  const session = { sessionId: part.session.sessionId, cwd: part.session.cwd };
  // A part said to its session another way ("… and ask Atlas whether it's tagged"): its direction off
  // too, as it would be alone (send). Not the waiting session's reply.
  const found = replyTo(s, part.session) ? null : directionOff(part.text, part.session, s.sessions);
  const d = found?.indirect ? found.loose : found;
  const text = d?.dropped.length ? d.text : part.text;
  const dropped = d?.dropped.length ? [...part.dropped, ...d.dropped] : part.dropped;
  const phrased = { type: "send" as const, session, text, trimmed: { kept: text, dropped, by: "phrase" as const } };
  return clean(s, deps, await toAppLeftOut(s, deps, out, part.session, phrased));
}

/**
 * A send whose words say the app's name to it ("…, and Kiko, slow down when you read the results",
 * "Thanks Kiko.", routing-rules.ts namesSaidToApp), without what's said to the app: a thanks or the
 * name at the very end, in code (appLeftOff); the rest, what the trim finds. What was cut before (a
 * phrase naming the session) stays cut. As it was when there's none.
 */
async function toAppLeftOut(s: DecideState, deps: DecideDeps, out: Decision, to: Session | Target, act: Act & { type: "send" }): Promise<Act & { type: "send" }> {
  if (!namesSaidToApp(act.text).length) return act;
  const off = appLeftOff(act.text);
  const ended: Act & { type: "send" } = off
    ? { ...act, text: off.text, trimmed: { ...act.trimmed, kept: off.text, dropped: [...(act.trimmed?.dropped ?? []), off.dropped], by: act.trimmed?.by ?? "phrase" } }
    : act;
  // What's plainly the app's, in code (routing-rules.ts appWordsOff): "…, and Kiko, slow down when
  // you read the results" whole; "…, Kiko, don't change the colours" only the name.
  const plain = appWordsOff(ended.text);
  const next: Act & { type: "send" } = plain
    ? { ...ended, text: plain.text, trimmed: { ...ended.trimmed, kept: plain.text, dropped: [...(ended.trimmed?.dropped ?? []), ...plain.dropped], by: ended.trimmed?.by ?? "phrase" } }
    : ended;
  if (!deps.trim || !namesSaidToApp(next.text).length) return next;
  const t = await deps.trim({ text: next.text, to: findSession(s.sessions, to.sessionId) ?? to, sessions: s.sessions });
  out.llmCostUsd += t.costUsd;
  if (!t.dropped.length) return next;
  return { ...next, text: t.text, trimmed: { kept: t.text, dropped: [...(next.trimmed?.dropped ?? []), ...t.dropped], by: "model", ms: t.ms } };
}

/**
 * A send with your words cleaned up, when the clean-up is on and found something: the cleaned
 * words, minus the same parts when some were cut as meant for the app. As it was otherwise.
 */
async function clean(s: DecideState, deps: DecideDeps, send: Act & { type: "send" }): Promise<Act & { type: "send" }> {
  if (!deps.clean) return send;
  const c = await deps.clean(s.text);
  if (!c.cleaned) return send;
  const text = send.trimmed ? cutFromCleaned(c.text, send.trimmed.dropped, send.text) : c.text;
  return text ? { ...send, text, cleaned: { said: send.text, ms: c.ms } } : send;
}

/**
 * The agent the router named for a new session, when your words name it too (Agent.heard: "a Codex
 * session"); else "", your default. The router reaches for one now and then that wasn't said, and
 * Claude Code stays the default unless you say otherwise (or set "New sessions in").
 */
export function namedAgent(id: string, text: string): string {
  if (!id) return "";
  return starters()
    .find((a) => a.id === id)
    ?.heard?.test(text)
    ? id
    : "";
}

/**
 * The agent a new session was asked of whose sessions start in its own app (agents/index.ts elsewhere: T3
 * Code), when your words name it too; else null. The router names it as start_session's agent; or,
 * as it did before it could, takes its name for the project ("Open a new session in T3 code." →
 * "T3 code", a scratch folder "t3-code") or the session's name ("Open new T3 session, please." →
 * "T3"), both opening Claude Code. A field that's only its
 * name ("T3", "T3 code", "T3 session") is taken as it, unless one of your projects goes by it.
 */
export function startsElsewhere(action: { project: string | null; newProject: boolean; sessionName: string; agent?: string }, text: string, where: StartPlace | null): Agent | null {
  // A project of yours by that name, or a new one you asked to be made ("make a new project called T3").
  const yours = action.newProject || (where?.kind === "project" && where.how !== "close");
  return (
    elsewhere().find((a) => {
      if (!a.heard!.test(text)) return false;
      if (action.agent === a.id) return true;
      return !yours && (onlyItsName(action.project, a) || onlyItsName(action.sessionName, a));
    }) ?? null
  );
}

/** A field that's only an agent's name ("T3", "T3 code", "T3 session"): no project, no session's name. */
function onlyItsName(field: string | null, a: Agent): boolean {
  return (
    Boolean(field) &&
    a.heard !== undefined &&
    !field!
      .replace(new RegExp(a.heard.source, "gi"), "")
      .replace(/\b(?:code|app|session|thread)\b/gi, "")
      .match(/[\p{L}\p{N}]/u)
  );
}
