// The voice and the model in the settings screen: the engines as saved (what runs after a
// restart), the voice and model's names for the header, and a voice's sample played.
import { config, DEFAULT_CARTESIA_VOICE, enginesFor } from "../../core/config.ts";
import { Cartesia } from "../../core/cartesia.ts";
import { DEFAULT_POCKET_VOICE, PocketTts } from "../../core/pocket-tts.ts";
import { customVoiceName } from "../../core/pocket-voices.ts";
import { OPENROUTER_MODELS } from "../../core/openrouter-llm.ts";
import { engineOf, respell } from "../../core/pronunciation.ts";
import { loadSettings, type Settings } from "../../core/settings.ts";
import { FEATURED_CARTESIA, pocketVoiceName, SAMPLE } from "../../core/settings-options.ts";
import { platform } from "../../platform/index.ts";
import { ui } from "../../core/ui-store.ts";
import { openSpeech, stopTalking } from "../speech.ts";
import { applyMute, audio, cartesia, floor, pocket, state } from "../state.ts";

/** The voice engine as saved: what runs after a restart, which may differ from what runs now (a free one, when the chosen one's key is missing). */
export function pendingTts(saved: Settings) {
  return enginesFor(saved).tts;
}

/** Speech recognition, the same way. */
export function pendingStt(saved: Settings) {
  return enginesFor(saved).stt;
}

/** The current voice for an engine, with a name to show. */
export function voiceFor(tts: string, saved: Settings): { raw: string; name: string } {
  if (tts === "cartesia") {
    const raw = saved.cartesiaVoice ?? config.cartesiaVoice;
    const name = FEATURED_CARTESIA.find((v) => v.id === raw)?.name ?? saved.cartesiaVoiceName ?? "custom";
    return { raw, name };
  }
  if (tts === "pocket") {
    const raw = saved.pocketVoice ?? config.pocketVoice ?? DEFAULT_POCKET_VOICE;
    return { raw, name: pocketVoiceName(raw) };
  }
  const raw = saved.sayVoice ?? config.sayVoice ?? "";
  return { raw, name: raw || "System default" };
}

/** Plays a sample of a voice from the engine the settings screen is showing voices for. */
export async function previewVoice(id: string, label: string) {
  // An announcement you hadn't heard yet goes back in line, as a press puts it back: made again once
  // the sample has played.
  floor.deferUnheard("preview");
  floor.bump();
  stopTalking("voice_preview");
  const tts = pendingTts(loadSettings());
  const text = SAMPLE(label.replace(/\s*\(.*$/, ""));
  if (tts === "say") {
    void platform.voice.sample(respell(text, "macos"), id).then(() => floor.drain());
    return;
  }
  let engine: Cartesia | PocketTts;
  if (tts === "cartesia") {
    if (!cartesia && !state.previewCartesia) {
      state.previewCartesia = new Cartesia();
      await state.previewCartesia.connect();
    }
    engine = (cartesia ?? state.previewCartesia)!;
  } else {
    if (!pocket && !state.previewPocket) {
      ui.info("Starting Pocket TTS for the preview…");
      state.previewPocket = new PocketTts();
      await state.previewPocket.connect();
    }
    engine = (pocket ?? state.previewPocket)!;
  }
  floor.bump();
  state.previewing = true;
  applyMute();
  const speech = await openSpeech((handlers) => engine.open(handlers, id), engineOf(tts));
  speech.push(text);
  speech.end();
  void audio.quiet().then(() => {
    state.previewing = false;
    applyMute();
  });
  floor.drain(); // what it put back, after the sample
}

/** Short name of the model writing summaries and replies. */
export function modelName() {
  return config.llm === "haiku" ? "Haiku" : (OPENROUTER_MODELS.find((m) => m.id === config.llm)?.label ?? config.llm);
}

/** Short name of the voice, for the UI header. */
export function voiceName() {
  if (config.tts === "say") return config.sayVoice ?? "macOS";
  if (config.tts === "pocket") {
    const id = config.pocketVoice ?? DEFAULT_POCKET_VOICE;
    return `${customVoiceName(id) ?? id} (Pocket)`;
  }
  if (config.cartesiaVoice === DEFAULT_CARTESIA_VOICE) return "Greg";
  return loadSettings().cartesiaVoiceName ?? "custom";
}
