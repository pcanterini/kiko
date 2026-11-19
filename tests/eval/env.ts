// The environment the routing and relay evals run the engine in, set before any src/ module loads
// (src/core/config.ts reads it as it loads): the user's keys from .env or the environment, none of
// their saved settings, the eval's own log folder. No src/ imports here.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** --model: the router and trim model, by short name or OpenRouter id. */
export const MODELS: Record<string, string> = {
  haiku: "haiku",
  deepseek: "deepseek/deepseek-v4.1-flash",
  mercury: "inception/mercury-3",
  gemini: "google/gemini-3.1-flash-lite",
  "haiku-or": "anthropic/claude-haiku-5.5",
};
/** --utterance-model: the decision model for your words. */
export const DECISION_MODELS: Record<string, string> = {
  classifier: "typesafe/jev-1.14",
  "d1-ultra": "liquid/d1-ultra",
};

/**
 * Sets the eval's environment and returns the router model. `keys`: also load .env and require the
 * keys the engine needs (true: OPENROUTER_API_KEY, and ANTHROPIC_API_KEY for Haiku or with
 * `alsoAnthropic`; or the variables listed). A git worktree has no .env of its own:
 * `node --env-file=<main checkout>/.env …`.
 */
export function setEvalEnv(opts: { model: string; utteranceModel?: string; keys: boolean | string[]; alsoAnthropic?: boolean; why?: string }): string {
  const model = MODELS[opts.model] ?? opts.model;
  if (opts.keys) {
    const envFile = join(root, ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const need = Array.isArray(opts.keys) ? opts.keys : ["OPENROUTER_API_KEY", ...(model === "haiku" || opts.alsoAnthropic ? ["ANTHROPIC_API_KEY"] : [])];
    for (const key of need) {
      if (!process.env[key]) throw new Error(`${key} missing: ${opts.why ?? "the eval needs OPENROUTER_API_KEY (Jev) and ANTHROPIC_API_KEY (Haiku)"}, in .env or the environment.`);
    }
  }
  process.env.KIKO_SETTINGS = join(here, "no-saved-settings.json");
  process.env.KIKO_STT = "apple";
  process.env.KIKO_TTS = "say";
  process.env.KIKO_LLM = model;
  // The cases were recorded with the app's code in claude-code-speech, wherever the repo is now.
  process.env.KIKO_APP_FOLDER = "claude-code-speech";
  delete process.env.KIKO_VOICE_CAN;
  delete process.env.VOICE_CAN;
  // No shadow model (src/core/shadow.ts) beside Jev: it's for comparing on real use, and would only add cost here.
  process.env.KIKO_DEV_SHADOW = "0";
  if (opts.utteranceModel) process.env.KIKO_UTTERANCE_MODEL = DECISION_MODELS[opts.utteranceModel] ?? opts.utteranceModel;
  // src/core/log.ts writes to tests/eval/logs/, not the app's logs/.
  process.env.KIKO_LOG_DIR = join(here, "logs");
  return model;
}
