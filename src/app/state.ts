// The app's shared state: what every part of src/app/ reads and changes. What changes
// is one `state` object, since a module can't assign to another module's exported `let`
// (`state.pressAt = "mac"`); a value only one part uses stays a `let` in that part. Next to it: the
// parts made once at start (the mic, speech to text and out, the player, the floor, the timeline),
// the timings they're tuned by, and small helpers. It imports none of the parts: what the objects
// made here call in them is in `hooks`, wired by app.ts as it starts.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { keyOf } from "../core/key-values.ts";
import { appEnv } from "../core/env.ts";
import { micChoice, MicWatch } from "../core/mic-device.ts";
import { Deepgram } from "../core/deepgram.ts";
import { Dictated } from "../core/dictated.ts";
import { Summarizer } from "../core/summarizer.ts";
import { Cartesia } from "../core/cartesia.ts";
import { PocketTts } from "../core/pocket-tts.ts";
import { SpeechLock } from "../core/speech-lock.ts";
import { AudioQueue } from "../core/audio-queue.ts";
import { MacSpeaker, MacVoice } from "../core/mac-output.ts";
import { Mute } from "../core/mute.ts";
import { Unplayed, type Said } from "../core/unplayed.ts";
import { findSession, sessionName, spoken, type Session } from "../core/sessions.ts";
import { describeTool, type StopDecision } from "../core/decisions.ts";
import { Router } from "../core/router.ts";
import { type Asking, askWhat } from "../core/ask.ts";
import type { Target } from "../core/decide.ts";
import { Floor } from "../core/floor.ts";
import type { HandsFree } from "../core/hands-free.ts";
import type { Hold, HoldOptions } from "../core/hold.ts";
import { InLine } from "../core/in-line.ts";
import { PressStt, type Transcribing } from "../core/press-stt.ts";
import { AskedWhere } from "../core/question.ts";
import { KEPT_MS, KeptWords, RETRY_STEPS_MS } from "../core/kept.ts";
import { flat } from "../core/text.ts";
import type { Running } from "../core/quick-task.ts";
import { isQuickCheck, QUICK_CHECK_NAME, quickWhat } from "../core/quick-ask.ts";
import { QUESTION_MS, UNHEARD_FOR_MS, voiceAllows } from "../core/routing-rules.ts";
import { windowClosedNote } from "../core/reach.ts";
import { Timeline, type Entry } from "../core/timeline.ts";
import type { PressAudio } from "../core/press-audio.ts";
import { SETTINGS_FILE } from "../core/settings.ts";
import { envVar, STATE_PATH, TITLE } from "../core/name.ts";
import { agentOf } from "../agents/index.ts";
import type { Held } from "../agents/types.ts";
import { platform } from "../platform/index.ts";
import type { Hotkey, HubAddress } from "../platform/types.ts";
import { Dictations } from "../remote/new-session.ts";
import type { PhoneServer } from "../remote/server.ts";
import { Pairing } from "../remote/pairing.ts";
import { Talks, type Talk } from "../remote/talk-status.ts";
import type { By } from "../core/starting.ts";
import { isTrust, trustWhat } from "../core/trust-prompt.ts";
import { ui } from "../core/ui-store.ts";
import { isOverride, overrideWhat } from "../core/block-override.ts";
import { guardOf, guardWhat } from "../core/guard.ts";
import type { WindowGlue } from "../ui/window-glue.ts";
import { log } from "../core/log.ts";
import type { writeState } from "./status.ts";
import type { announce, askPermission, askQuestions } from "./announce.ts";
import type { notSentAnywhere } from "./deliver.ts";
import type { speakLine, stopTalking } from "./speech.ts";
import type { stands } from "./standing.ts";

/**
 * The parts' behaviour that what's made here calls (the floor makes an announcement, a hold says it
 * didn't send, the question runs out, a restart ends the app): set once by app.ts as it starts
 * (wireHooks), before anything can call them. Here only as hooks, so this file imports no part and
 * isn't in a cycle with them; `shutdown` is app.ts's own, which no part imports either.
 */
type Hooks = {
  announce: typeof announce;
  askPermission: typeof askPermission;
  askQuestions: typeof askQuestions;
  notSentAnywhere: typeof notSentAnywhere;
  speakLine: typeof speakLine;
  stopTalking: typeof stopTalking;
  writeState: typeof writeState;
  stands: typeof stands;
  shutdown: (code?: number) => void;
};
export const hooks = {} as Hooks;
export const wireHooks = (parts: Hooks) => void Object.assign(hooks, parts);

// Keep recording briefly after key up so the last word isn't cut off (people release while still finishing it).
// Read at each key up: the faked-app harness sets it for a case.
export const tailMs = () => Number(appEnv("TEST_TAIL_MS") ?? 300);
// A send the app wasn't sure of (decide's `unsure`) waits this long once "To <session>" is heard;
// one you said was wrong without saying where waits up to HOLD_ANSWER_MS for you to say.
const HOLD_MS = Number(appEnv("TEST_HOLD_MS") ?? 1000);
const HOLD_ANSWER_MS = Number(appEnv("TEST_HOLD_ANSWER_MS") ?? 10_000);
// A line isn't said over a press: it waits for the key to go up, at most this long.
export const KEY_UP_WAIT_MS = 60_000;
// Below these, the classifier's read of a finished turn means "don't read it out".
export const QUIET_WORTH = 0.3;
export const QUIET_NEEDS_USER = 0.5;
// A finished turn that only reported something, with another session already in line, gives way
// this long after its reading ends.
const GIVE_WAY_MS = Number(appEnv("TEST_GIVE_WAY_MS") ?? 2000);
// A press this soon after an announcement starts making a sound still puts it back (floor.ts deferUnheard).
const UNHEARD_MS = Number(appEnv("TEST_UNHEARD_MS") ?? UNHEARD_FOR_MS);
// At or above this, the classifier's read of a permission request means "ask for an explicit allow it".
export const RISKY = 0.5;
// Read by the status line add-on (statusline/kiko-status.mjs).
export const STATE_FILE = envVar("STATE") ?? STATE_PATH;

// Where the latest press was (the Mac's key, hands-free or keys; or a phone): its cues play there.
export type PressAt = "mac" | `phone:${string}`;
// Your words while the app works out where they go (deciding, then carrying it out), for the
// status line and the header; `sent`: the session they last went to, and when.
type Words = { text: string; startedAt: number };

export const state = {
  // A voice sample asked for in the settings screen is playing: on the Mac, and heard muted or not.
  previewing: false,
  hotkey: null as Hotkey | null,
  // Hands-free (hands-free.ts): listening for the app's name while it's on; why it couldn't start, if
  // it couldn't (shown in the settings screen). `voiceHolds`: it holds the floor now, as a key press
  // would (it heard the name, or a reply in a session's window), until the quiet after your words.
  handsFree: null as HandsFree | null,
  handsFreeError: null as string | null,
  voiceHolds: false,
  // Which listener holds it while `voiceHolds`: the Mac's (handsFree) or a phone's (app/talk.ts
  // phoneListeners). Each acts only on what it holds itself.
  voiceBy: null as HandsFree | null,
  // The phone (src/remote/, Settings → Phone): its server while it's on, and the addresses it can be
  // reached at. `phoneHolds`: its talk button is down, holding the floor as the key would;
  // `phoneTo`: the session whose screen it's talking in; `phonePress`: when its talk_start and its
  // first audio came, to log how long the phone's mic took to get going; `phoneAudio`: what its
  // audio looked like as it came (press-audio.ts), logged with phone_talk.
  phone: null as PhoneServer | null,
  phoneAddresses: [] as HubAddress[],
  phoneHolds: false,
  phoneTo: null as Target | null,
  phonePress: { at: 0, firstAudioAt: null as number | null },
  phoneAudio: null as PressAudio | null,
  // The phone's press whose button is down (talks below).
  phoneTalk: null as Talk | null,
  // The phone's press for a new session's first message whose button is down (dictations below).
  phoneDictation: null as { end: (words: string | null) => void } | null,
  // Each press's speech-to-text (press-stt.ts): the key's latest, and the phone's while its button is
  // down. A press's own `hear` takes it as the key goes up, so a press right after doesn't change it.
  keyStt: null as Transcribing | null,
  // When the key's latest press went down, for how long it was held when its mic gave nothing (mic_not_started).
  keyDownAt: 0,
  phoneStt: null as Transcribing | null,
  // The press whose audio the Mac's mic is giving (its number, floor.presses): only that press's end
  // closes it, or gives it back to hands-free. Pressed again within the tail, the mic is the new press's.
  micPress: null as number | null,
  // m: muted like a TV (mute.ts): silent on the Mac and the phones, everything else as if it were
  // heard; unmuted, what's being said is heard from where it is then. The macOS voice can't be turned
  // down mid-line, so with it muting cuts the line and nothing is said until unmuted.
  muted: false,
  pressAt: "mac" as PressAt,
  // The Mac plays what's said for a phone that can't (checkHeard): Play on this Mac off, and no phone
  // playing it. Told once as it starts and ends; null for a moment after start, while paired phones
  // connect again.
  macStandsIn: null as boolean | null,
  // The session you dealt with last: where a reply goes by default once nothing is waiting.
  target: null as Target | null,
  lastAnnounced: null as string | null,
  // The last thing the app said out loud, for "repeat that".
  lastSpoken: "",
  // Whether the permission being asked about needs an explicit "allow it".
  currentRisky: false,
  deciding: null as Words | null,
  sent: null as { name: string; sessionId: string; at: number } | null,
  // A send the app wasn't sure of, held a moment after it says where it's going (holdIf, hold.ts).
  holding: null as Hold | null,
  // The held send's words while it goes out, for where landed() says they went.
  landing: null as Words | null,
  // The quick task running (quick-task.ts): one at a time.
  quick: null as { task: string; cwd: string; startedAt: number; run: Running } | null,
  // The offer to open a session for the last quick task (quick-ask.ts HAND_OFF_LINE): a yes to `line` starts one with `task`.
  handOff: null as { task: string; cwd: string; line: string } | null,
  // The offer to turn Voice can up after it stopped something you asked (session-ops.ts allowed):
  // a yes to `line` sets it to Everything and runs `then`, what was asked (turnOnVoice). `request`:
  // the trust prompt it stopped an answer to, which your next words answer (announce.ts answerPermission).
  voiceOffer: null as { line: string; at: number; then: (() => Promise<unknown>) | null; request?: Held } | null,
  // Your words that just failed to reach a session you can put right (its terminal on Claude Code's
  // agents list, or not told apart from another): "try again" sends them there for RETRY_MS
  // (decide.ts `retry`). Gone once something reaches that session, or newer ones fail.
  unsent: null as { to: Target; text: string; at: number } | null,
  // Listing sessions takes ~130ms; a key press starts a fresh listing so it's ready by key up (getSessions).
  sessionsCache: null as { at: number; list: Promise<Session[]> } | null,
  // Settings → Test microphone is listening (testMic).
  micTesting: false,
  // The mic the helper gave up on for giving no link (its UID; mic-device.ts noLinkAfter): listed,
  // but another stands in until it's held again. Null: none.
  micNoLink: null as string | null,
  // Engines started only to play voice samples for an engine that isn't running (previewVoice).
  previewCartesia: null as Cartesia | null,
  previewPocket: null as PocketTts | null,
  // The Kiko window (`kiko`, src/ui/window-glue.ts): its bottom line and sessions' names, and its list.
  windowGlue: null as WindowGlue | null,
};

export const mic = platform.mic.create();
// The microphone you picked (settings: Listening → Microphone), else the system default.
mic.setDevice(micChoice(config.mic, config.micName));
// Tells once when the chosen mic goes missing, and once when it's back (mic-device.ts): logged, and said for a mic that isn't Bluetooth.
export const micWatch = new MicWatch();
// Speech to text: Deepgram (streaming, paid) or Apple's on-device recognizer (free).
export const sttEngine = config.stt === "apple" ? platform.speech.create() : new Deepgram(config.deepgramKey);
// Apple's can't start on every Mac (before macOS 26, no speech model, no Swift to build its helper):
// said plainly, and the app runs on without speech-to-text rather than stopping.
// Deepgram's socket not opening at the start (offline, a bad key): said, and the app starts all the
// same; the socket keeps trying, a longer wait each time (core/deepgram.ts), and a press works once it's back.
export const connectStt = () =>
  sttEngine.connect().catch((err) => {
    const why = err instanceof Error ? err.message : String(err);
    log("error", { where: "stt_connect", stt: config.stt, message: why });
    if (config.stt !== "apple") return void ui.error("speech", `Deepgram couldn't connect (${why}), so speech isn't turned into text until it does. It keeps trying.`);
    const key = keyOf("DEEPGRAM_API_KEY") ? "" : " (it asks for a Deepgram key)";
    ui.error("speech", `Apple speech recognition couldn't start (${why}), so nothing turns your speech into text: pick Deepgram in Settings → Speech recognition${key}.`);
  });
// Each press's own (press-stt.ts): a press while the one before is still turned into text waits its
// turn with its audio kept, and finishing one never touches the next.
export const stt = new PressStt(sttEngine, { log });
export const summarizer = new Summarizer();
export const answerer = new Summarizer(); // quick task answers, alongside announcements
export const catchUpWriter = new Summarizer(); // the phone's Catch me up summary
export const explainer = new Summarizer(); // "more": a longer summary of a reply already heard
export const router = new Router();
export const cartesia = config.tts === "cartesia" ? new Cartesia() : null;
// Cartesia's socket not opening at the start: said, and the app starts all the same; it keeps
// trying (core/cartesia.ts), and replies are spoken once it's back.
export const connectCartesia = () =>
  cartesia?.connect().catch((err) => {
    const why = err instanceof Error ? err.message : String(err);
    log("error", { where: "tts_connect", tts: config.tts, message: why });
    ui.error("voice", `Cartesia couldn't connect (${why}), so replies aren't spoken in its voice until it does. It keeps trying.`);
  });
// Set later too: the macOS voice speaking only because Pocket was still downloading, it's switched
// to once it's ready (pocket-switch.ts usePocket). Read where it's used, never kept.
export let pocket = config.tts === "pocket" ? new PocketTts() : null;

/** Pocket, started (`engine`), speaks from the next line on: what's being said finishes in the voice it started in. */
export function usePocket(engine: PocketTts) {
  pocket = engine;
  config.tts = "pocket";
}
// Pocket's server not starting at the start (a venv that's broken, a port taken, too slow to load):
// said, and the macOS voice speaks this run, rather than the app stopping. One not installed here
// never gets this far (keys.ts pickEngines: the macOS voice, and app.ts starts its download).
export const connectPocket = () =>
  pocket?.connect().catch((err) => {
    const why = err instanceof Error ? err.message : String(err);
    log("error", { where: "tts_connect", tts: "pocket", message: why });
    pocket?.close();
    pocket = null;
    config.tts = "say";
    ui.error("voice", `Pocket couldn't start (${why}), so the macOS voice speaks this run. Settings → Voice changes it; restarting ${TITLE} tries Pocket again.`);
  });
// The Mac's player, or with Play on this Mac off a clock that plays nothing in its time (mac-output.ts).
// A voice sample you asked for in the settings screen plays here either way. Off with no phone to
// play it (none connected with Play on phone on, or its app in the background or locked), the Mac
// plays it after all: what's said is never played to no one (checkHeard).
export const macPlays = () => config.playOnMac || !state.phone?.audible();
const macPlayer = platform.speaker.create();
export const speaker = new MacSpeaker(macPlayer, () => macPlays() || state.previewing);
// Beeps and speech take turns (audio-queue.ts): neither plays over, or into the middle of, the other.
// What plays goes to a phone that asked for it too (src/remote/), as it's made: whether or not the
// Mac plays it.
//
// A press's cues are feedback for whoever pressed, so they play only where the press was: a press
// on the Mac on its speaker (whatever Play on this Mac says), never on a phone; a press on a phone
// on that phone only, timed here (what follows waits for it) but not played.
export const audio = new AudioQueue<Said>((pcm, cueAt, pos) => {
  if (cueAt === null) {
    speaker.write(pcm);
    mute.voice(pcm, pos);
  } else if (cueAt === "mac") {
    speaker.write(pcm, true, "mac");
  } else {
    speaker.write(pcm, true, "silent");
    state.phone?.cue(pcm, cueAt.slice("phone:".length));
  }
});
// What the Mac's output didn't play (unplayed.ts): AirPods with the phone take no sound, the player
// gives up on it, and what was cut stays to be said again (speech.ts onStalled, onBack).
export const unplayed = new Unplayed();
// `say`, or with Play on this Mac off nothing on the Mac, timed by its words (a phone says them).
export const say = new MacVoice(platform.voice.create(config.sayVoice, config.sayRate), macPlays);
// The Mac's volume, lowered while you talk (duck.ts). It goes by the output the player says it's on
// (a headset's call profile has a volume of its own: with its mic held open, for as long as it's the mic in use).
export const duck = platform.volume.duck({ enabled: () => config.duckMusic, level: () => config.duckLevel, output: () => macPlayer.output ?? null });
macPlayer.onOutput = () => void duck.outputChanged();
export const timeline = new Timeline();

// The phones paired with this Mac.
export const pairing = new Pairing(join(dirname(SETTINGS_FILE), "phones.json"));
// What became of each press or typed message from a phone that gave it an id (talk-status.ts):
// told to that phone as it goes. `state.phoneTalk`: the press whose button is down.
export const talks = new Talks((phoneId, status) => state.phone?.talkStatus(phoneId, status));
// Your dictated words typed into a session, until it takes them in: its agent is told they were
// spoken (core/dictated.ts; session-ops.ts typeInto notes them, the agents' hooks ask).
export const dictated = new Dictated();
// Presses said on a phone for a new session's first message (talk_start `dictate`: remote/new-session.ts):
// their words kept for its new_session, never routed. `state.phoneDictation`: the one whose button is down.
export const dictations = new Dictations();
export const speechLock = new SpeechLock(); // one voice at a time
// Muted (state.muted) like a TV.
export const mute = new Mute({ gain: (level) => speaker.volume(level), phone: { audio: (pcm, pos) => state.phone?.audio(pcm, pos), stop: () => state.phone?.stopAudio() } });
// A voice sample asked for in the settings screen is heard, muted or not.
export const applyMute = () => mute.set(state.muted && !state.previewing);
// Muted with the macOS voice: nothing is said at all, so the text on screen is the line.
export const textOnly = () => state.muted && !state.previewing && !cartesia && !pocket;
// Paired phones connect again within this, after start (state.macStandsIn).
export const PHONES_BACK_MS = 10_000;

// The announcement queue, the reply window and your presses (floor.ts): what's announced when,
// which session waits for your reply, and for how long. It says what to do; the app does it.
export const floor: Floor<Held> = new Floor<Held>({
  windows: () => ({ reply: config.replyWindowMs, fyi: config.fyiReplyWindowMs, permission: config.permissionWindowMs }),
  quietNeedsUser: QUIET_NEEDS_USER,
  giveWayMs: GIVE_WAY_MS,
  unheardMs: UNHEARD_MS,
  audio,
  whyClosed: (request, reach) =>
    isQuickCheck(request.sessionId)
      ? "no answer, so the quick check goes on without it"
      : isTrust(request)
        ? "no answer yet; its card stays up until you answer it"
        : isOverride(request)
          ? "no answer, so it stays blocked"
          : request.isPermission
            ? `no answer; the ${request.questions ? "questions are" : "prompt is"} waiting ${heldWhere(request)}`
            : windowClosedNote(reach, voiceAllows(config.voiceCan, "message")),
  make: (request) => void (request.questions ? hooks.askQuestions(request) : request.isPermission ? hooks.askPermission(request) : hooks.announce(request)),
  // A permission prompt unanswered in its window stands: held, its card up (app/standing.ts).
  stand: (request) => hooks.stands(request),
  cut: (unheard) => {
    summarizer.cancel();
    unheard.speech?.cancel();
  },
  stopTalking: (why, sessionId) => hooks.stopTalking(why, { causeSessionId: sessionId }),
  info: (text) => ui.info(text),
  log,
  changed: () => hooks.writeState(),
});
// sessionId → new name, typed in once it's idle; `by`: who asked (only voice's go when Voice can stops allowing it).
export const pendingRenames = new Map<string, { name: string; by: By }>();
// Replies through a held turn since the session last stopped on its own: its agent takes only so
// many in a row (agent.heldReplies: Claude Code's hook continuations); near the cap, type instead.
export const heldReplies = new Map<string, number>();
// Requests already in the timeline and on screen (with the context their summary was asked with):
// made again after a press put them back, they aren't added or shown twice. A finished turn's classifier
// verdict is kept too (asked once, its line shown once), and its summary once it was shown. One your
// words went to before it was read out is in the timeline (ahead of them), not on screen yet.
type Shown = {
  entry: Entry;
  context: string[];
  /** Your words to it during the turn (askedOf); none for a permission prompt. */
  asked?: string[];
  onScreen?: boolean;
  verdict?: Promise<StopDecision | null>;
  classifierShown?: boolean;
  summary?: { text: string; nameSession: boolean };
};
export const shown = new WeakMap<Held, Shown>();
// Claude's questions (core/ask.ts), each prompt's walk through them: asked again after a press put it
// back, it goes on from the question it was on.
export const asking = new WeakMap<Held, Asking>();
// Your words for a finished turn not read out yet, in the order you said them, and whether the
// "sent" beep goes with them: they go once it has been (sendTo, floor.ts replyAfter).
export const laterWords = new Map<Held, { texts: string[]; beep: boolean; at: PressAt; talks: Talk[][] }>();
// What the app typed into each session lately (sessionId → texts). Its own words show up in the
// transcript as queued prompts too, and aren't you typing there.
export const OWN_TYPING_MS = 60_000;
// The longest a quick task's permission prompt waits on the app (hooks/quick-permission.mjs): it's
// asked once it's its turn, then waits out the permission window like any prompt.
export const QUICK_ASK_WAIT_MS = 180_000;
export const ownTyping = new Map<string, Array<{ text: string; at: number }>>();
// Your words, decided in the order you said them (in-line.ts): each waits for the ones before to be
// sent or held.
export const inLine = new InLine();
export const holdOptions: HoldOptions = {
  holdMs: HOLD_MS,
  answerMs: HOLD_ANSWER_MS,
  nameOf: (to) => nameOf(to),
  settled: (h) => {
    if (state.holding === h) state.holding = null;
  },
  unanswered: (h) => void hooks.speakLine(`I didn't send it to ${spoken(h.name)}.`),
  info: (text) => ui.info(text),
  log,
  changed: () => hooks.writeState(),
};
// The app asked which session your words were for ("Which session should it go to, Lacy or
// Kiko?"): those words, which went nowhere yet, until your next words answer it, or QUESTION_MS
// passes (decide.ts answerQuestion). Never let go silently (settleQuestion, notSentAnywhere). Not
// while you talk or your words are dealt with: they may answer it.
export const askedWhere = new AskedWhere({
  busy: () => floor.pressed || floor.replying > 0,
  // As each is asked: the faked-app harness shortens it for a case.
  ms: () => Number(appEnv("TEST_QUESTION_MS") ?? QUESTION_MS),
});
askedWhere.onExpired = (gone) => {
  log("question_dropped", { text: gone.question.text, line: gone.question.line, why: "expired", ageMs: gone.ageMs, told: gone.told, ...(gone.question.kept ? { kept: true } : {}) });
  // "Still send …?", asked as a retry found words kept late: they're still kept (keptWords), so only shown.
  void hooks.notSentAnywhere(
    gone.question,
    gone.told || gone.question.kept ? null : "after",
    gone.question.kept ? "the question ran out; still kept: say send it, or a session's name" : "the question ran out",
  );
};
// Your words that couldn't be sent when the router gave no answer (offline, a timeout), kept and
// routed again by themselves (deliver.ts retryKept, wired by app.ts), or sent by "send it" or a
// session's name (decide.ts keptFor), 2026-11-12. Running out is shown and logged, never said: you
// were told when they were kept. The faked-app harness shortens the times for a case.
export const keptWords = new KeptWords({
  ms: () => Number(appEnv("TEST_KEPT_MS") ?? KEPT_MS),
  steps: () => appEnv("TEST_KEPT_STEPS_MS")?.split(",").map(Number) ?? RETRY_STEPS_MS,
});
keptWords.onExpired = (gone) => {
  for (const e of gone) log("kept_expired", { text: e.text, ageMs: Date.now() - e.at });
  ui.info(`(no longer kept, not sent: ${gone.map((e) => `"${flat(e.text, 60)}"`).join(", ")})`);
};
// How long store.routed (where your words went) is kept; the header shows it for part of that.
export const ROUTED_MS = 2000;
// The models see this many recent timeline entries, and up to TOPICS earlier asks per session.
export const RECENT = 8;
export const TOPICS = 8;
// A finished turn's summary sees up to this many of your words to it during the turn (askedOf).
export const ASKED_MAX = 4;

export const now = () => performance.now();
export const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
/** What a session is called, on screen and out loud: the name it was given, else its folder (sessions.ts sessionName). */
export function nameOf(to: Target) {
  if (isQuickCheck(to.sessionId)) return QUICK_CHECK_NAME;
  return sessionName(findSession(ui.state.sessions, to.sessionId) ?? to);
}

/** Where a prompt let go of still waits: its terminal (Claude Code's, Codex's), or another agent's own app ("in T3 Code"). */
export const heldWhere = (held: Held) => (agentOf(held).ownApp ? `in ${agentOf(held).name}` : "in the terminal");

/** A held session as its folder and ID, for what only needs those. */
export const refOf = (held: Held) => ({ sessionId: held.sessionId, cwd: held.cwd });

/** What a permission prompt asks, short: "run: npm test", or "ask 2 questions: Install tmux, Checks". */
export const whatOf = (held: Held) =>
  isTrust(held)
    ? trustWhat(held, homedir())
    : held.questions
      ? askWhat(held.questions)
      : isQuickCheck(held.sessionId)
        ? quickWhat(held.tool, describeTool(held.tool?.name, held.tool?.input))
        : isOverride(held)
          ? overrideWhat(describeTool(held.tool?.name, held.tool?.input))
          : gatedWhat(held);

/** A prompt's "wants to …", marked when the safety gate asked it (core/guard.ts): "run: git push (Kiko asks first: posts)". */
function gatedWhat(held: Held) {
  const what = describeTool(held.tool?.name, held.tool?.input);
  const gated = guardOf(held);
  return gated ? guardWhat(what, gated.kind) : what;
}

/** A listed session's name now, for timeline lines: one renamed since is called by its new name. */
export function currentName(sessionId: string) {
  const session = findSession(ui.state.sessions, sessionId);
  return session ? sessionName(session) : undefined;
}

/** Timeline lines for a model prompt, sessions by the names they have now. */
export const linesOf = (entries: Entry[]) => Timeline.lines(entries, undefined, currentName);
