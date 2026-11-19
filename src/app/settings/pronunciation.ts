// Settings → Pronunciation, and by voice: how the voice in use says a word ("say nginx as
// engine-x"), its entries taken out or turned off, and one tried out loud.
import { config } from "../../core/config.ts";
import {
  addPronunciation,
  DEFAULTS as BUILT_IN_SAYINGS,
  disableDefault,
  ENGINE_LABEL,
  engineOf,
  forgetPronunciation,
  loadPronunciations,
  removePronunciation,
  wordFrom,
  type Pronunciation,
} from "../../core/pronunciation.ts";
import { spokenName } from "../../core/name.ts";
import { ui } from "../../core/ui-store.ts";
import { log } from "../../core/log.ts";
import { openSpeech, openTts, speakLine, stopTalking, ttsCost } from "../speech.ts";
import { applyMute, audio, floor, state, timeline } from "../state.ts";
import { refreshSettings } from "../settings-screen.ts";

const SPELL_IT = () => `Which word? Spell it for me, like: ${spokenName()}, say T M U X as tee mux.`;

/**
 * What was said and shown lately, newest first, for finding how a word you said is written ("say
 * T-Mux as …" is about tmux). The app's lines and the sessions' replies; not your own words, which
 * are speech-to-text's spelling of it.
 */
function recentWords() {
  const said = timeline
    .recent(20)
    .reverse()
    .filter((e) => e.who !== "you")
    .flatMap((e) => [e.spoken ?? "", e.text]);
  return [state.lastSpoken ?? "", ...said].filter(Boolean);
}

/**
 * "Kiko, say nginx as engine-x" (or the settings screen): the voice in use says it that way from
 * now on, and says so, the new way.
 */
export async function addSaying(heard: string, say: string, by: "voice" | "settings") {
  const voice = engineOf(config.tts);
  const word = by === "voice" ? wordFrom(heard, recentWords()) : heard.trim();
  if (!word || /\s/.test(word)) {
    log("pronunciation_unclear", { heard, say, by });
    if (by === "voice") await speakLine(SPELL_IT());
    else ui.error("pronunciation", new Error("One word at a time."));
    return;
  }
  let before: string | undefined;
  try {
    ({ before } = addPronunciation(word, say, voice));
  } catch (err) {
    ui.error("pronunciation", err);
    if (by === "voice") await speakLine("I couldn't save that.");
    return;
  }
  log("pronunciation_added", { word, say, voice, heard, before: before ?? null, by });
  refreshSettings();
  ui.info(`pronunciation: ${word} → "${say}" for ${ENGINE_LABEL[voice]}${before ? ` (was "${before}")` : ""}`);
  if (by === "voice") await speakLine(`Okay, from now on it's ${word}.`);
}

/** "Kiko, forget how to say nginx": the voice in use says it as written again. */
export async function forgetSaying(heard: string) {
  const voice = engineOf(config.tts);
  const word = wordFrom(heard, recentWords());
  if (!word || /\s/.test(word)) {
    log("pronunciation_unclear", { heard, by: "voice" });
    return speakLine(SPELL_IT());
  }
  let before: string | undefined;
  try {
    ({ before } = forgetPronunciation(word, voice));
  } catch (err) {
    ui.error("pronunciation", err);
    return speakLine("I couldn't save that.");
  }
  log("pronunciation_removed", { word, voice, heard, before: before ?? null, by: "voice" });
  refreshSettings();
  if (before === undefined) return speakLine(`I already say ${word} as it's written.`);
  ui.info(`pronunciation: ${word} as written for ${ENGINE_LABEL[voice]} (was "${before}")`);
  await speakLine(`Okay, back to ${word} as it's written.`);
}

/** An entry in the settings screen's list: "yours:<i>" in your file, "built-in:<i>" in the built-in list. */
function sayingById(id: string): { entry: Pronunciation; yours: boolean; index: number } | null {
  const [list, at] = id.split(":");
  const index = Number(at);
  const entry = list === "yours" ? loadPronunciations()[index] : list === "built-in" ? BUILT_IN_SAYINGS[index] : undefined;
  return entry ? { entry, yours: list === "yours", index } : null;
}

/** The settings screen's d: takes out one of yours, or turns off a built-in one. */
export function removeSaying(id: string) {
  const found = sayingById(id);
  if (!found) return;
  const gone = found.yours ? removePronunciation(found.index) : disableDefault(found.index);
  if (!gone) return;
  log("pronunciation_removed", { word: gone.word, voices: gone.voices ?? "all", builtIn: !found.yours, by: "settings" });
  refreshSettings();
  ui.info(`pronunciation: ${found.yours ? "removed yours for" : "turned off the built-in"} ${gone.word}`);
}

/** The settings screen's tab: one entry's respelling, said by the voice in use. */
export async function testSaying(id: string) {
  const found = sayingById(id);
  if (!found) return;
  const { word, say, disabled } = found.entry;
  floor.deferUnheard("preview");
  floor.bump();
  stopTalking("pronunciation_test");
  const line = (w: string) => `This is how I say ${w}.`;
  ui.voice(line(word));
  state.previewing = true;
  applyMute();
  const speech = await openSpeech(openTts, null);
  speech.push(line(disabled ? word : say!));
  speech.end();
  ttsCost(speech.chars());
  void audio.quiet().then(() => {
    state.previewing = false;
    applyMute();
  });
  floor.drain();
}
