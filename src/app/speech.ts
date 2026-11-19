// Speech out: every line said waits its turn (openSpeech: the speech lock, the beeps' queue,
// respelled for the voice), the voices themselves (openTts), cues, stopTalking (barge-in), and what
// the Mac's output didn't play said again once sound is back.
import { config } from "../core/config.ts";
import { SILENT, type Speech, type TtsHandlers } from "../core/speech-lock.ts";
import type { Said } from "../core/unplayed.ts";
import { VoiceLine } from "../core/voice-marks.ts";
import { engineOf, respoken, type Engine } from "../core/pronunciation.ts";
import { SOUNDS } from "../core/sounds.ts";
import type { Stall } from "../platform/types.ts";
import { ui } from "../core/ui-store.ts";
import { cost, log, totals } from "../core/log.ts";
import { SpokenLines } from "../core/spoken-lines.ts";
import { catchingUp } from "./phone.ts";
import { type PressAt, answerer, audio, cartesia, duck, explainer, floor, mute, pocket, router, say, speaker, speechLock, state, summarizer, textOnly, timeline, unplayed } from "./state.ts";

// ── Speech out ──────────────────────────────────────────────────────────────

// The lines being said, for the log (speech_done, speech_cut).
const spokenLines = new SpokenLines(log);

/**
 * Every spoken reply starts here, and waits its turn: one that comes while another is being said
 * plays after it instead of over it. It's in line with the beeps from now (audio-queue.ts): a beep
 * asked for after this plays once it's been said, and a beep playing now finishes first.
 * stopTalking() cuts it, and drops any still waiting.
 *
 * What's pushed to it is respelled for `voice` on the way in (pronunciation.ts: "nginx" said as
 * "engine-x"), so every voice and a phone saying the words itself get the respelled text, and
 * nothing on screen or in the log does. `voice` null: said as given (a test of one respelling).
 * `said`: what it is (a session's reply, its question, a line of the app's), for what's owed if the
 * output doesn't play it (onStalled); its text can be filled in once it's known.
 */
export async function openSpeech(open: (handlers: TtsHandlers) => Promise<Speech> = openTts, voice: Engine | null = engineOf(config.tts), said?: Said): Promise<Speech> {
  // Never into a volume Kiko lowered and didn't put back (duck.ts beforeSpeech): 2026-11-13, two replies
  // played at 1 after AirPods' call profile kept the restore from reading ours. Not awaited: the voice
  // takes longer to start than the volume to come up.
  void duck.beforeSpeech();
  const turn = audio.speech(said);
  // The phone's read-along (voice-marks.ts): the line's words as written and said, and each chunk
  // of its voice with its place in the line, so the phone can tell which word is being said.
  const marks = voice ? new VoiceLine((m) => state.phone?.voiceMarks(m)) : undefined;
  // For the log: speech_done once its voice has made it all, speech_cut if it's cut (spoken-lines.ts);
  // and for the Mac overlay, its words said so far as its sound plays (heardNow).
  const line = spokenLines.open(said, marks?.saidBy);
  let made: Speech | undefined;
  const onDone = (done: () => void) => () => {
    line.finished({ chars: made?.chars() ?? said?.text.length ?? 0, voice: config.tts, phones: state.phone?.playingCodecs() ?? [] });
    done();
  };
  const speech = await speechLock.open(
    async (handlers) => (made = await open({ ...handlers, onDone: onDone(handlers.onDone), ready: turn.ready, marks })),
    (pcm) => {
      line.audio(pcm);
      turn.audio(pcm, marks?.audio(pcm));
    },
    () => {
      line.over();
      turn.end();
    },
  );
  return voice && speech !== SILENT ? respoken(speech, voice, undefined, marks?.wrote) : speech;
}

export async function openTts(handlers: TtsHandlers): Promise<Speech> {
  if (cartesia) return cartesia.open(handlers);
  if (pocket) return pocket.open(handlers, config.pocketVoice);
  // Muted, the streamed voices play on unheard (mute.ts); `say` plays by itself and can't be turned
  // down, so muted it says nothing.
  if (textOnly()) return { ...SILENT, end: handlers.onDone };
  // `say` plays by itself, the moment it starts: after a beep that's playing, not over it. It can't
  // be streamed, so a phone that asked for the audio gets the words to say itself.
  const speech = await say.open(handlers.onDone);
  const ready = handlers.ready ?? (() => Promise.resolve());
  let text = "";
  return {
    ...speech,
    push: (delta) => {
      text += delta;
      speech.push(delta);
    },
    end: () =>
      void ready().then(() => {
        // With where each written word is in it, for the phone's read-along (its synthesizer says which it's on).
        if (text.trim()) state.phone?.speak(text, handlers.marks?.saidWords());
        speech.end();
      }),
  };
}

/** What's heard now: the line being played, its words said so far and its sound's level (spoken-lines.ts heard()); the Mac overlay's. */
export const heardNow = () => spokenLines.heard();

/**
 * Barge-in: whatever is being written or said is cut, and what waits to be is dropped. `why`: what
 * cut it (a press, typing into a session, the phone's Stop, an answer to a prompt…), and the
 * session that was about (`causeSessionId`), logged with what was cut (speech_cut) when anything was.
 */
export function stopTalking(why = "other", cause: { causeSessionId?: string } = {}) {
  spokenLines.cutNow(why, cause);
  summarizer.cancel();
  explainer.cancel();
  answerer.cancel();
  catchingUp.pressed();
  router.cancel();
  audio.stop(); // first: the speeches cut next don't let the beeps behind them play
  speechLock.stop();
  speaker.stop();
  say.stop();
  mute.stop(); // the phones cut what they play too
}

export function ttsCost(chars: number) {
  const c = cartesia ? cost.cartesia(chars) : 0;
  totals.cartesia += c;
  return c;
}

/**
 * A soft cue (unless sounds are off or the app is muted), where the press it answers was (`at`).
 * After whatever is being said, or about to be; at once otherwise, as "listening" always is: the
 * press that asks for it stopped the speech. `played`: once it has been heard (or dropped), or at
 * once when there's no cue.
 */
export function cue(sound: keyof typeof SOUNDS, at: PressAt, played?: () => void) {
  if (config.sounds && !state.muted) audio.cue(SOUNDS[sound], played, at);
  else played?.();
}

/** Speaks a fixed line from the app itself. `said`: what it is, when it's a session's said again. */
/** `about`: a quick check's result (`checked`: what it checked), for the phone's Updates; `phone`: what the phone shows instead (the line names the Mac's keys). */
export async function speakLine(text: string, record = true, said?: Said, about?: { checked?: string; phone?: string }) {
  ui.voice(text, about);
  state.lastSpoken = text;
  if (record) timeline.add({ who: "app", sessionId: null, folder: null, text });
  const speech = await openSpeech(undefined, undefined, said ?? { sessionId: null, name: null, kind: "line", text });
  speech.push(text);
  speech.end();
  ttsCost(speech.chars());
}

export function onPlaying() {
  floor.playing();
}

export function onIdle() {
  floor.idle();
}

/**
 * The Mac's output took none of what it was given for a few seconds (AirPods that are with the
 * phone), so the player dropped it; its idle follows, and the floor goes on: "speaking" ends, and the
 * sessions in line are announced. What was cut is owed (unplayed.ts): the screen says what and how to
 * hear it, it's still what "repeat that" says, and it's said again once sound is back (onBack).
 */
export function onStalled(stall: Stall) {
  const cut = audio.stalled(stall.unheardMs);
  ui.error("sound", unplayed.stalled(stall.device, cut));
  log("speech_unheard", {
    device: stall.device,
    unheardMs: stall.unheardMs,
    cut: cut.map((s) => ({ kind: s.kind, sessionId: s.sessionId, name: s.name })),
  });
}

/**
 * Sound comes out of the Mac again after a stall: what wasn't heard is said again by itself, in the
 * order it was first said, each once (unplayed.ts back()). Not over you, nor while your words are
 * dealt with.
 */
export async function onBack() {
  const again = unplayed.back();
  if (!again.length) return;
  ui.info(`(sound is back: saying again what wasn't heard)`);
  log("speech_said_again", { said: again.map((s) => ({ kind: s.kind, sessionId: s.sessionId, name: s.name })) });
  while (floor.pressed || floor.replying) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const said of again) {
    if (said.kind !== "line") timeline.add({ who: "app", sessionId: said.sessionId, folder: said.name, text: said.text, repeated: true });
    void speakLine(said.text, false, said);
  }
}
