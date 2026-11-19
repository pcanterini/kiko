// Talking to the app: a press of the Mac's key (or the window's Talk), hands-free hearing its name
// or a reply, and the phone's talk button or typed words. Each holds the floor (floor.ts) as the key
// does, and what was said goes through act() to deliver(). The steps they share are one press's
// (begin, listen, wordsOf, end); each source keeps what's its own. A phone's
// hands-free (core/phone-listen.ts) is the Mac's hands-free on that phone's audio, its words acted on
// as the phone's press's are.
import { randomUUID } from "node:crypto";
import { config, MIC_SAMPLE_RATE } from "../core/config.ts";
import { appEnv } from "../core/env.ts";
import { applyDictionary, fixHeard, fixLive } from "../core/dictionary.ts";
import type { Target } from "../core/decide.ts";
import { leadingName, levelOf, type By as WakeBy } from "../core/wake.ts";
import { HandsFree, type Request } from "../core/hands-free.ts";
import { notStartedLine } from "../core/mic-device.ts";
import { PhoneListeners } from "../core/phone-listen.ts";
import type { Transcribing } from "../core/press-stt.ts";
import { PressAudio } from "../core/press-audio.ts";
import type { ListenMode } from "../core/settings.ts";
import { spokenName } from "../core/name.ts";
import { ui } from "../core/ui-store.ts";
import { cost, log, totals } from "../core/log.ts";
import { pressDoneLine } from "../core/cost-lines.ts";
import { writeState } from "./status.ts";
import { sessionCost } from "./announce.ts";
import { deliver, endDeciding, keep, startDeciding } from "./deliver.ts";
import { FAILED_KEPT_LINE } from "../core/fallback.ts";
import { SEND_KEPT, TRY_AGAIN } from "../core/routing-rules.ts";
import { refreshSettings } from "./settings-screen.ts";
import { micFields } from "./settings/mic.ts";
import { cue, speakLine, stopTalking } from "./speech.ts";
import { getSessions } from "./starting.ts";
import { type PressAt, askedWhere, audio, dictations, duck, floor, mic, now, secs, state, stt, sttEngine, tailMs, talks } from "./state.ts";

// ── A press ─────────────────────────────────────────────────────────────────

/**
 * Where a press comes from: the Mac (its key, the window's Talk, Enter with tap), hands-free (it
 * heard the name, or a reply in a session's window), or a phone (its talk button, or words typed).
 */
type Source = "mac" | "hands-free" | "phone";

/**
 * A press starts: a new turn (floor.ts keyDown); before it made a sound, or in its first moments of
 * sound, the announcement being made waits until you're done instead (and is cut below). Hands-free
 * holding the floor (it heard the name, or a reply) gives it to the key or a phone: what it heard so
 * far is dropped, and the press's recording starts now. `own`: what's the source's own, done as the
 * press is noted. False when the floor isn't free (for hands-free: the key is down, and its words
 * are its own; or another listener holds it). `listener`: for hands-free, which one (the Mac's, or a
 * phone's): every other listener drops what it heard.
 */
function begin(source: Source, at: PressAt, own?: () => void, listener?: HandsFree): boolean {
  const tookOver = source !== "hands-free" && state.voiceHolds;
  if (!tookOver && !floor.keyDown()) return false;
  const from = state.voiceBy;
  state.voiceHolds = source === "hands-free";
  state.voiceBy = source === "hands-free" ? (listener ?? null) : null;
  state.pressAt = at;
  // The Mac's talk key: you're at the Mac, so what it showed you lately was seen (remote/seen-on-mac.ts).
  if (source === "mac") state.phone?.macUsed("key");
  own?.();
  if (source !== "hands-free") {
    state.handsFree?.pressed();
    if (tookOver) ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by: null } });
    // A phone's listener that held the floor: the words it was taking are dropped, as the Mac's are.
    if (tookOver && from && from !== state.handsFree) phoneVoiceTaken(from);
  } else if (listener !== state.handsFree) state.handsFree?.drop();
  phoneListeners.dropAll(source === "hands-free" ? (listener ?? null) : null);
  // A send held a moment (holdIf) waits for what you say now.
  state.holding?.press();
  // Barge-in: a press silences whatever is being written or said.
  stopTalking(source === "mac" ? "press" : source === "phone" ? "phone_press" : "hands_free");
  return true;
}

/**
 * The press's speech-to-text (press-stt.ts): its live words shown while it's the one being held,
 * with your dictionary's fixes (as its final words will have them); `heard` gets each as it comes.
 */
function listen(heard?: (text: string) => void): Transcribing {
  const mine = floor.presses;
  const said = stt.begin((text) => {
    heard?.(text);
    if (floor.pressed && floor.presses === mine) ui.heard(fixLive(text));
  });
  ui.heard("");
  return said;
}

/** A press under way: a fresh list of sessions, ready by the time you finish talking. */
function underWay() {
  void getSessions(0);
  writeState();
}

/**
 * What a press's speech-to-text heard, and what it cost. Nothing more is coming from the press,
 * failed or not: the mic level and the live words go, unless a newer press has them now.
 */
async function wordsOf(said: Transcribing | null, press: number) {
  let heard: string;
  try {
    heard = said ? await said.finish() : "";
  } finally {
    if (floor.presses === press) ui.set({ level: 0, interim: "" });
  }
  const audioSeconds = said?.audioSeconds() ?? 0;
  const sttCost = config.stt === "deepgram" ? cost.deepgram(audioSeconds, sttEngine.hinted()) : 0;
  totals.deepgram += sttCost;
  return { heard, audioSeconds, sttCost };
}

/**
 * A press ends, as key up (floor.ts keyUp): `hear` (given the press's number) deals with its words.
 * A session that finishes meanwhile waits until it's done: its announcement goes after the app's
 * answer, and your words aren't taken as a reply to it. True when the floor was a press's.
 */
async function end(hear: (press: number) => Promise<boolean>) {
  const up = await floor.keyUp(hear, () => {
    // Your words while a send was held are dealt with, without saying what to do with it (nothing
    // heard, or a newer press dropped them): it goes now. One you said was wrong doesn't.
    if (!floor.pressed) state.holding?.afterWords();
  });
  if (up) writeState();
  return up;
}

// ── Push to talk ────────────────────────────────────────────────────────────

export function keyDown() {
  // The mic test has the mic for a few seconds: the key waits.
  if (state.micTesting) return ui.info("(testing the mic: the key works again in a moment)");
  if (!begin("mac", "mac")) return;
  // The volume goes down once the cue has been heard: lowered first, the cue would be quieter too.
  // Never awaited: osascript takes 100ms+ to start, and recording doesn't wait for it.
  const press = floor.turn;
  cue("listening", "mac", () => {
    if (floor.pressed && floor.turn === press) void duck.duck();
  });
  const said = listen();
  state.keyStt = said;
  state.keyDownAt = now();
  const mine = floor.presses;
  state.micPress = mine;
  let lastLevel = 0;
  mic.open((chunk) => {
    micLive();
    said.send(chunk);
    if (Date.now() - lastLevel > 80) {
      lastLevel = Date.now();
      ui.set({ level: levelOf(chunk) });
    }
  });
  // No sound yet a moment in (a Bluetooth mic switching to its call profile: seconds, 2026-11-12):
  // the listening state says it's still connecting, where the level would be.
  setTimeout(() => {
    if (!mic.live && floor.pressed && floor.presses === mine && state.micPress === mine) ui.set({ micConnecting: mic.using?.name || "the mic" });
  }, CONNECTING_MS).unref();
  underWay();
}

/** How long a press waits for the mic's first sound before it says it's connecting: the built-in mic takes ~150 ms. */
const CONNECTING_MS = Number(appEnv("TEST_MIC_CONNECTING_MS") ?? 400);

/** The mic gave its first sound (mic.ts "started", or the audio itself): no longer connecting. */
export function micLive() {
  if (ui.state.micConnecting) ui.set({ micConnecting: null });
}

export async function keyUp() {
  // The floor is hands-free's or the phone's, not the key's: the quiet after your words, or the
  // phone's button going up, ends it.
  if (state.voiceHolds || state.phoneHolds) return;
  await end(hear);
}

/** Turns what you said into text and acts on it (`press`: its number). True once there were words, and they were dealt with. */
async function hear(press: number) {
  const up = now();
  // This press's own: pressed again within the tail, the next press has its own.
  const said = state.keyStt;
  state.keyStt = null;
  const heldMs = Math.round(up - state.keyDownAt);

  await new Promise((r) => setTimeout(r, tailMs()));
  // Whether the mic gave anything, the tail included: asked before it's closed.
  const live = mic.live;
  if (floor.presses === press) micLive();
  // Hands-free on, the mic stays open and its audio goes back to listening for the name. Pressed
  // again within the tail, the mic is the new press's: it's left alone. Pressed on the phone, it's
  // closed (the phone's press gives it back to hands-free as it ends).
  if (state.micPress === press) {
    state.micPress = null;
    if (floor.presses !== press || !state.handsFree?.released()) mic.close();
  }
  // Recording is over, tail included: the volume comes back up while your words are turned into
  // text and dealt with, before anything is said. Not if you've pressed again meanwhile.
  if (!floor.pressed) void duck.restore();
  const { heard, audioSeconds, sttCost } = await wordsOf(said, press);
  log("transcript", { text: heard, audioSeconds, msAfterKeyUp: Math.round(now() - up) });
  // The key went up before the mic gave any sound: said, with the mic's name, never an empty
  // transcript and silence (2026-11-12: six presses of seven on AirPods, each "(nothing heard)").
  if (!live && !heard.trim()) {
    log("mic_not_started", { ...micFields(), heldMs });
    await speakLine(notStartedLine(mic.using?.name, config.pttMode === "tap"));
    return false;
  }
  return act(heard, up, "key up", press, sttCost);
}

/**
 * What you said, as transcribed (by push-to-talk's speech-to-text, hands-free's, or the phone's
 * audio through push-to-talk's), or typed on the phone, acted on. True once there were words, and
 * they were dealt with. `up`: when you stopped talking (the key went up, the quiet after your words
 * began, the phone's button went up), for the timing line. `press`: the press's number (floor.ts
 * keyUp). `to`: said in a session's screen.
 */
async function act(heard: string, up: number, from: "key up" | "quiet" | "phone" | "typed", press: number, sttCost = 0, to: Target | null = null) {
  // Your dictionary's fixes, before anything decides where your words go.
  const { text, replaced } = fixHeard(heard);
  writeState();
  // Pressed again while these were turned into text: they're still dealt with, first. They were
  // dropped here once, unlogged; a send of them now waits for the new words (holdIf).
  if (floor.pressed && text) log("pressed_while_hearing", { text });
  // Only the app's name ("Kiko."): nothing said to it yet (wake.ts).
  const lead = leadingName(text);
  // Unless the app just asked which session your words were for: "Kiko." picks the Kiko session.
  if (!text || (lead.addressed && !lead.rest && !askedWhere.open)) {
    ui.info(text ? `(only "${text.trim()}": nothing sent)` : "(nothing heard)");
    return false;
  }
  ui.you(text);
  if (replaced.length) ui.info(`(dictionary: ${replaced.map((r) => `${r.heard} → ${r.write}`).join(", ")})`);
  const mine = startDeciding(text);
  try {
    await deliver(text, press, to, mine.startedAt);
  } catch (err) {
    ui.error("reply", err);
    const message = err instanceof Error ? err.message : String(err);
    log("error", { where: "deliver", message });
    // Your words went nowhere: said, never silently (a send that was decided says which: deliver).
    // Kept all the same (2026-11-12), for "send it" or a session's name, not retried by themselves:
    // nothing was sent of them. A router that can't answer no longer comes here (decide.ts routeFailed).
    log("words_failed", { text, why: message });
    // Not "send it" itself: what it asked to send is still kept.
    if (!SEND_KEPT.test(text) && !TRY_AGAIN.test(text)) keep(text, Date.now(), false);
    talks.failed(FAILED_KEPT_LINE);
    void speakLine(FAILED_KEPT_LINE);
  } finally {
    endDeciding(mine);
  }
  ui.timing(pressDoneLine(`${from} → done ${secs(now() - up)}`, sttCost, sessionCost()));
  // The same in the log: the window no longer shows the timings (only the full screen does).
  log("press_done", { from, ms: Math.round(now() - up), sttCost, totalCost: sessionCost() });
  return true;
}

// ── Hands-free ──────────────────────────────────────────────────────────────

// Shorter in the faked-app harness: the quiet that ends a request (wake.ts END_SILENCE_MS), and the
// wait for one after the name alone.
const LISTEN_TIMING = {
  ...(appEnv("TEST_LISTEN_SILENCE_MS") ? { endSilenceMs: Number(appEnv("TEST_LISTEN_SILENCE_MS")) } : {}),
  ...(appEnv("TEST_LISTEN_NAME_WAIT_MS") ? { nameOnlyWaitMs: Number(appEnv("TEST_LISTEN_NAME_WAIT_MS")) } : {}),
};

// When words without the name are a reply, and what one word answers: the same for the Mac's
// listener and each phone's.
const replyWindow = () => config.replyWithoutName && Boolean(floor.waiting) && floor.until !== null;
// One word is a reply only when it answers what was asked: Claude's question, a yes or no.
const asks = () => (floor.waiting?.questions ? ("choice" as const) : floor.asks ? ("yes-no" as const) : null);

function makeHandsFree() {
  return new HandsFree({
    mic,
    fix: (text) => applyDictionary(text).text,
    // Speaking, a cue, or a speech in line: it doesn't hear itself. Nor while a phone's listener holds the floor.
    talking: () => floor.speaking || audio.busy() || heldByOther(state.handsFree),
    replyWindow,
    asks,
    changed: writeState,
    holding: (by) => voiceDown(by),
    named: voiceNamed,
    request: (text, heard) => void voiceUp(text, heard),
    dropped: () => void voiceUp(null),
    interim: (text) => ui.heard(text),
    level: (level) => ui.set({ level }),
    log,
    timing: LISTEN_TIMING,
  });
}

/** Turns listening for the name on or off: the setting, and on start. Says so when it can't. */
export async function setListening(mode: ListenMode) {
  if (mode === "hands-free") {
    state.handsFree ??= makeHandsFree();
    const why = await state.handsFree.start();
    // Turned off again meanwhile.
    if (config.listenMode !== "hands-free") state.handsFree.stop();
    else if (why) {
      state.handsFreeError = why;
      log("listen_mode", { mode, on: false, error: why });
      ui.error("hands-free", `Apple speech isn't available on this Mac, so it's push-to-talk only: ${why}`);
    } else if (state.handsFreeError !== null || !ui.state.handsFree.on) {
      state.handsFreeError = null;
      log("listen_mode", { mode, on: true, replyWithoutName: config.replyWithoutName });
      ui.info(`Listening for "${spokenName()}": say "${spokenName()}, …" and what you want. Nothing leaves this Mac until it hears the name.`);
    }
  } else {
    state.handsFreeError = null;
    const was = state.handsFree?.on;
    state.handsFree?.stop(); // also one still starting
    if (was) {
      log("listen_mode", { mode, on: false });
      ui.info("Push-to-talk only: the mic is closed until you hold the key.");
    }
  }
  ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by: state.voiceHolds ? (state.handsFree?.by ?? null) : null } });
  refreshSettings();
  writeState();
}

/** Hands-free heard words to act on: the name, or a reply in a session's window. The floor is held as a key press holds it. */
function voiceDown(by: WakeBy) {
  if (!begin("hands-free", "mac", undefined, state.handsFree ?? undefined)) return; // the key is down: its words are its own
  // A reply without the name: no cue (you didn't call the app), but the volume goes down as you talk.
  if (by === "reply") void duck.duck();
  ui.set({ handsFree: { on: true, by } });
  underWay();
}

/** It heard the name: the listening cue, then the volume down, as on key down. */
function voiceNamed() {
  if (!holds(state.handsFree)) return;
  const press = floor.turn;
  cue("listening", "mac", () => {
    if (holds(state.handsFree) && floor.turn === press) void duck.duck();
  });
  ui.set({ handsFree: { on: true, by: "name" } });
  ui.info(`(heard "${spokenName()}")`);
}

/**
 * The quiet after the words hands-free acted on, or the name and then nothing (`text` null): as key
 * up, with the words it heard. Not when the key took over meanwhile.
 */
async function voiceUp(text: string | null, heard?: Request) {
  if (!holds(state.handsFree)) return;
  state.voiceHolds = false;
  state.voiceBy = null;
  void duck.restore();
  ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by: null }, level: 0, interim: "" });
  await end(async (press) => {
    if (text === null || !heard) {
      ui.info(`(heard "${spokenName()}", then nothing)`);
      return false;
    }
    const quietAt = now() - heard.finalMs;
    log("wake_request", { text, by: heard.by, live: heard.live, ms: heard.ms, finalMs: heard.finalMs });
    log("transcript", { text, audioSeconds: heard.audioSeconds, msAfterKeyUp: heard.finalMs, via: "hands-free", by: heard.by });
    return act(text, quietAt, "quiet", press);
  });
}

// ── The phone's press ───────────────────────────────────────────────────────

let phoneLevelAt = 0;

/**
 * The phone's talk button went down, in a session's screen (`to`) or its home screen: as the key,
 * hands-free holding the floor gives it to the phone. `dictate`: a new session's first message said
 * (its sheet's button), only written down, so no talk of its own.
 */
export function phoneTalkStart(to: Target | null, phoneId: string, talkId: string | null, dictate?: boolean): "busy" | null {
  if (state.micTesting) return "busy";
  const pressed = begin("phone", `phone:${phoneId}`, () => {
    state.phoneHolds = true;
    state.phoneTo = to;
    state.phonePress = { at: now(), firstAudioAt: null };
    state.phoneAudio = new PressAudio(state.phonePress.at, MIC_SAMPLE_RATE);
    state.phoneDictation = dictate && talkId ? dictations.begin(phoneId, talkId) : null;
    state.phoneTalk = state.phoneDictation ? null : talks.begin(talkId, phoneId);
  });
  if (!pressed) return "busy";
  // No listening cue: the phone's haptic at touch-down says so at once, and a blip coming back
  // from here a moment later would land in what its mic records.
  const audio = state.phoneAudio;
  state.phoneStt = listen((text) => audio?.heard(text, now()));
  underWay();
  return null;
}

/** The phone's audio while its button is down: through push-to-talk's speech-to-text. */
export function phoneTalkAudio(pcm: Buffer) {
  if (!state.phoneHolds) return;
  state.phonePress.firstAudioAt ??= now();
  state.phoneAudio?.add(pcm, now());
  state.phoneStt?.send(pcm);
  if (Date.now() - phoneLevelAt > 80) {
    phoneLevelAt = Date.now();
    ui.set({ level: levelOf(pcm) });
  }
}

/** The phone's talk button went up (or it went away: `cancel`, its words go nowhere): as key up. */
export async function phoneTalkEnd(cancel: boolean) {
  state.phoneHolds = false;
  const to = state.phoneTo;
  state.phoneTo = null;
  const talk = state.phoneTalk;
  state.phoneTalk = null;
  const dictation = state.phoneDictation;
  state.phoneDictation = null;
  // From talk_start: to its first audio (the phone's mic starting, plus the network) and to its end.
  const firstAudioMs = state.phonePress.firstAudioAt === null ? null : Math.round(state.phonePress.firstAudioAt - state.phonePress.at);
  const endAt = now();
  const heldMs = Math.round(endAt - state.phonePress.at);
  const audio = state.phoneAudio;
  // This press's own: a press right after has its own.
  const said = state.phoneStt;
  state.phoneStt = null;
  await end(async (press) => {
    const at = now();
    state.handsFree?.released();
    const { heard, audioSeconds, sttCost } = await wordsOf(said, press);
    audio?.heard(heard, now());
    if (state.phoneAudio === audio) state.phoneAudio = null;
    log("phone_talk", {
      text: heard,
      audioSeconds,
      firstAudioMs,
      heldMs,
      sessionId: to?.sessionId ?? null,
      cancelled: cancel,
      ...(dictation ? { dictated: true } : {}),
      audio: audio?.summary(endAt) ?? null,
    });
    // A new session's first message: written down for its new_session (your dictionary's fixes
    // too), never routed: "open a session in pixie" said here is what the new session is told.
    if (dictation) {
      const words = cancel ? null : fixHeard(heard).text;
      if (!cancel) log("transcript", { text: heard, audioSeconds, msAfterKeyUp: Math.round(now() - at), via: "phone", dictated: true });
      ui.info(cancel ? "(phone: let go without sending)" : `(phone: a new session's first message: "${words}")`);
      dictation.end(words);
      return false;
    }
    if (cancel) {
      ui.info("(phone: let go without sending)");
      talk?.failed("Cancelled");
      return false;
    }
    log("transcript", { text: heard, audioSeconds, msAfterKeyUp: Math.round(now() - at), via: "phone" });
    talk?.heard(heard);
    return talks.run(talk, () => act(heard, at, "phone", press, sttCost, to));
  });
  // Nothing heard, or words that went nowhere: never left at "sending".
  talk?.finish(talk.stage === "heard" ? "Not sent" : "Nothing heard");
  // A dictated press whose words never came (hearing failed): its new_session hears nothing.
  dictation?.end(null);
}

/** Words typed on the phone, in a session's screen (`to`) or its home screen: a press and its words at once. */
export function phoneTyped(text: string, to: Target | null, phoneId: string, talkId: string | null): "busy" | null {
  if (state.micTesting) return "busy";
  // As a press does: what's being said stops, and an announcement not heard yet waits.
  if (!begin("phone", `phone:${phoneId}`)) return "busy";
  log("phone_type", { text, sessionId: to?.sessionId ?? null });
  const talk = talks.begin(talkId, phoneId, true);
  talk?.heard();
  void end(async (press) => {
    state.handsFree?.released();
    return talks.run(talk, () => act(text, now(), "typed", press, 0, to));
  }).then(() => talk?.finish("Not sent"));
  return null;
}

// ── A phone's hands-free ────────────────────────────────────────────────────

/** Whether this listener holds the floor now. */
function holds(listener: HandsFree | null) {
  return state.voiceHolds && listener !== null && state.voiceBy === listener;
}

/** The floor is pressed by someone other than this listener (a key, a phone's button, another listener). */
function heldByOther(listener: HandsFree | null) {
  return floor.pressed && !holds(listener);
}

/**
 * Each phone's hands-free (its Settings → Hands-free, while its app is in front): the Mac's hands-free
 * on the audio that phone sends (core/phone-listen.ts), one listener per phone, beside the Mac's own.
 * Its words go as the phone's press's do: held as a press holds the floor (begin), cues on that
 * phone, replies there with Play on phone, and what became of them told to it (a talk, as a press's).
 */
export const phoneListeners = new PhoneListeners({
  fix: (text) => applyDictionary(text).text,
  // As the Mac's: deaf while the app speaks or plays a cue, and while the floor is someone else's.
  talking: (listener) => floor.speaking || audio.busy() || heldByOther(listener),
  replyWindow,
  asks,
  holding: (phoneId, listener, by) => phoneVoiceDown(phoneId, listener, by),
  named: (phoneId, listener) => phoneVoiceNamed(phoneId, listener),
  request: (phoneId, listener, text, heard) => void phoneVoiceUp(phoneId, listener, text, heard),
  dropped: (phoneId, listener) => void phoneVoiceUp(phoneId, listener, null),
  interim: (text) => ui.heard(text),
  level: (level) => ui.set({ level }),
  state: (phoneId, s) => state.phone?.handsFreeState(phoneId, { ...s, name: spokenName() }),
  log,
  timing: LISTEN_TIMING,
});

/** A phone's Hands-free switched on (its app in front) or off. Null once it's as asked; else why not (said to the phone). */
export async function phoneListen(phoneId: string, on: boolean, why: "phone" | "away" | "gone" = "phone"): Promise<string | null> {
  if (!on) {
    phoneListeners.off(phoneId, why);
    return null;
  }
  const error = await phoneListeners.on(phoneId);
  if (!error && !state.phone) phoneListeners.off(phoneId, "gone"); // the phone server stopped meanwhile
  if (error) ui.error("hands-free", `A phone's hands-free can't listen: Apple speech isn't available on this Mac (${error}).`);
  return error;
}

/** What a phone's mic heard while its Hands-free is on (16 kHz mono 16-bit PCM). */
export function phoneListenAudio(phoneId: string, pcm: Buffer) {
  phoneListeners.audio(phoneId, pcm);
}

/** A phone says it plays the app's voice or a cue, or that its mic is back: its listener's deaf window follows it. */
export function phoneListenPlaying(phoneId: string, playing: boolean) {
  phoneListeners.playing(phoneId, playing);
}

/** The phone whose listener holds the floor now, if one does. */
export function phoneVoiceHolds(): string | null {
  return state.voiceHolds ? phoneListeners.phoneOf(state.voiceBy) : null;
}

/** A phone's listener heard words to act on: the name, or a reply in a session's window. Held as the phone's press holds the floor. */
function phoneVoiceDown(phoneId: string, listener: HandsFree, by: WakeBy): boolean {
  if (!begin("hands-free", `phone:${phoneId}`, undefined, listener)) return false; // the floor is someone else's
  ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by } });
  underWay();
  return true;
}

/** It heard the name: the listening cue, on the phone (as a press made there has its cues there). */
function phoneVoiceNamed(phoneId: string, listener: HandsFree) {
  if (!holds(listener)) return;
  cue("listening", `phone:${phoneId}`);
  ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by: "name" } });
  ui.info(`(phone: heard "${spokenName()}")`);
}

/** The key or a phone's button took the floor from a phone's listener: its phone is told, and the Mac's line cleared. */
function phoneVoiceTaken(listener: HandsFree) {
  const phoneId = phoneListeners.phoneOf(listener);
  if (phoneId) log("phone_wake_taken", { phoneId });
}

/**
 * The quiet after the words a phone's listener acted on, or the name and then nothing (`text` null):
 * as the phone's press ending, with the words it heard: a talk for it, so the phone shows what became
 * of them. Not when something took the floor meanwhile.
 */
async function phoneVoiceUp(phoneId: string, listener: HandsFree, text: string | null, heard?: Request) {
  if (!holds(listener)) return;
  state.voiceHolds = false;
  state.voiceBy = null;
  ui.set({ handsFree: { on: Boolean(state.handsFree?.on), by: null }, level: 0, interim: "" });
  // Said only once there are words: the name alone shows nothing on the phone.
  const talk = text !== null && heard ? talks.begin(randomUUID(), phoneId) : null;
  phoneListeners.done(phoneId, talk?.id);
  await end(async (press) => {
    if (text === null || !heard) {
      ui.info(`(phone: heard "${spokenName()}", then nothing)`);
      return false;
    }
    const quietAt = now() - heard.finalMs;
    log("phone_wake_request", { phoneId, text, by: heard.by, live: heard.live, ms: heard.ms, finalMs: heard.finalMs });
    log("transcript", { text, audioSeconds: heard.audioSeconds, msAfterKeyUp: heard.finalMs, via: "phone-hands-free", by: heard.by, phoneId });
    talk?.heard(text);
    return talks.run(talk, () => act(text, quietAt, "quiet", press));
  });
  talk?.finish(talk.stage === "heard" ? "Not sent" : "Nothing heard");
}
