// Settings → Keys (core/keys.ts): the API keys' rows, and a key entered, saved or removed taken up
// at once where it can be.
import { aiUseNow, config, enginesFor, keys as keyFill } from "../../core/config.ts";
import { settingEnv } from "../../core/env.ts";
import { KeySettings, keysInUse, type KeyInfo } from "../../core/keys.ts";
import { holdKey } from "../../core/key-values.ts";
import { keyStore } from "../../platform/keys.ts";
import { classifierEnabled } from "../../core/classifier.ts";
import { loadSettings } from "../../core/settings.ts";
import { ui, type SettingRow } from "../../core/ui-store.ts";
import { log } from "../../core/log.ts";
import { modelName, pendingStt, pendingTts } from "./voice.ts";
import { keyOffers } from "../key-offer.ts";

/** A key saved that's the one to use: taken up at once where it can be (OpenRouter, read at each call); true when the engines started with the old one need a restart. */
function useKey(info: KeyInfo, key: string): boolean {
  // Held for this run, never in process.env (core/key-values.ts): nothing the app starts gets it.
  holdKey(info.env, key);
  switch (info.id) {
    case "openrouter":
      config.openrouterKey = key;
      config.classifier = loadSettings().classifier !== false;
      // The OpenRouter model chosen, back from Haiku standing in for it: read at each call, so at once.
      config.llm = enginesFor(loadSettings()).llm ?? config.llm;
      ui.set({ about: { ...ui.state.about, classifier: classifierEnabled(), model: modelName() } });
      return false;
    case "anthropic":
      config.anthropicKey = key;
      // Haiku's clients are made at start, with the key there was then.
      return enginesFor(loadSettings()).llm === "haiku";
    // The engine in use, or the one chosen that a free one stands in for until a restart.
    case "deepgram":
      config.deepgramKey = key;
      return config.stt === "deepgram" || enginesFor(loadSettings()).stt === "deepgram";
    case "cartesia":
      config.cartesiaKey = key;
      return config.tts === "cartesia" || enginesFor(loadSettings()).tts === "cartesia";
  }
}

// The Anthropic key Haiku's clients were made with (core/anthropic.ts): one entered since needs a restart.
export const anthropicAtStart = config.anthropicKey;

// The Keys section (core/keys.ts): its rows, and keys entered, saved and removed from them.
export const keySettings = new KeySettings({
  env: () => keysInUse(),
  sources: keyFill.sources,
  store: keyStore,
  log,
  say: (line) => ui.info(line),
  use: useKey,
  restart: () => ui.set({ restartPending: true }),
  // Your own OpenRouter key while the window offers it (the trial ended): let go, and said (app/key-offer.ts).
  saved: (info) => keyOffers.keySaved(info.id),
  // Each key's row: what it's used for now (Deepgram and Cartesia included), or why not.
  aiUse: aiUseNow,
});

/**
 * The Keys section's rows: OpenRouter and Anthropic, and Deepgram and Cartesia when that engine is
 * chosen (or a key for it is set). Each says where its key comes from, with only its last four characters.
 */
export function keyRows(): SettingRow[] {
  const saved = loadSettings();
  // What's chosen, even while a free one stands in for it: its key shows as needed.
  return keySettings.rows({ stt: settingEnv("stt") ?? saved.stt ?? pendingStt(saved), tts: settingEnv("tts") ?? saved.tts ?? pendingTts(saved), llm: settingEnv("llm") ?? saved.llm ?? config.llm });
}
