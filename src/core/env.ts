// Kiko's environment variables. Every one is KIKO_<NAME> (core/name.ts envVar), but the API keys (OPENROUTER_API_KEY and the
// like: core/keys.ts) and other programs' own (CODEX_HOME, CLAUDE_CONFIG_DIR, TMUX…). The bare names
// settings had until 2026-11-01 (TTS, HOTKEY, SOUNDS…), and JEV_* for the classifier's, are no longer read.
// Imports nothing that loads .env or writes logs, so anything can import it.
import { ACCOUNT_URL, ACCOUNTS_LIVE, envVar, envVarName, FLAVOUR, type Flavour, PHONE_LIVE, PRO_ON_SALE } from "./name.ts";

/** "KIKO_<key>" when it's set, else undefined. */
export const appEnvName = (key: string): string | undefined => envVarName(key);

/** KIKO_<key>. */
export const appEnv = (key: string): string | undefined => envVar(key);

/**
 * The settings an environment variable can set (KIKO_<env>), which wins over settings.json: read by
 * config.ts, said by the settings screen (app.ts). `what`: the setting in words.
 */
export const SETTING_ENV = {
  tts: { env: "TTS", what: "voice engine" },
  stt: { env: "STT", what: "speech recognition" },
  llm: { env: "LLM", what: "summary model" },
  pocketVoice: { env: "POCKET_VOICE", what: "Pocket TTS voice" },
  cartesiaVoice: { env: "CARTESIA_VOICE_ID", what: "Cartesia voice" },
  sayVoice: { env: "SAY_VOICE", what: "macOS voice" },
  sayRate: { env: "SAY_RATE", what: "macOS voice speed" },
  hotkey: { env: "HOTKEY", what: "hotkey" },
  mic: { env: "MIC", what: "microphone" },
  pttMode: { env: "PTT_MODE", what: "push-to-talk style" },
  voicePermissions: { env: "VOICE_PERMISSIONS", what: "voice permissions" },
  sounds: { env: "SOUNDS", what: "sounds" },
  duckMusic: { env: "DUCK_MUSIC", what: "lower the volume while you talk" },
  duckLevel: { env: "DUCK_LEVEL", what: "how low it goes" },
  cleanUp: { env: "CLEAN_UP", what: "clean up my messages" },
  permissionWindowMs: { env: "PERMISSION_WINDOW_MS", what: "permission window" },
  announce: { env: "ANNOUNCE", what: "when sessions speak up" },
  summaryLength: { env: "SUMMARY_LENGTH", what: "summary length" },
  replyWindowMs: { env: "REPLY_WINDOW_MS", what: "reply window" },
  fyiReplyWindowMs: { env: "FYI_REPLY_WINDOW_MS", what: "short reply window" },
  voiceCan: { env: "VOICE_CAN", what: "what your voice can do" },
  classifierMinConfidence: { env: "CLASSIFIER_MIN_CONFIDENCE", what: "classifier confidence" },
  holdUnsure: { env: "HOLD_UNSURE", what: "hold unsure sends" },
  sttHints: { env: "STT_HINTS", what: "speech hints" },
  listenMode: { env: "LISTEN_MODE", what: "how you talk to it" },
  replyWithoutName: { env: "REPLY_WITHOUT_NAME", what: "replies without the name" },
  spokenName: { env: "SPOKEN_NAME", what: "the name you call it" },
  utteranceModel: { env: "UTTERANCE_MODEL", what: "classifier model for your words" },
  quickTaskModel: { env: "QUICK_TASK_MODEL", what: "quick task model" },
  quickTaskTimeoutMs: { env: "QUICK_TASK_TIMEOUT_MS", what: "quick task time limit" },
  quickTaskMaxTurns: { env: "QUICK_TASK_MAX_TURNS", what: "quick task turns" },
  projectsRoot: { env: "PROJECTS_ROOT", what: "projects folder" },
  scratchFolder: { env: "SCRATCH_FOLDER", what: "scratch folder" },
  newSessionAgent: { env: "NEW_SESSION_AGENT", what: "agent for new sessions" },
  newSessionMode: { env: "NEW_SESSION_MODE", what: "permission mode" },
  icons: { env: "ICONS", what: "icons" },
  phone: { env: "PHONE", what: "phone" },
} as const;
type EnvSetting = keyof typeof SETTING_ENV;

/** What the environment says of a setting (it wins over settings.json). */
export const settingEnv = (setting: EnvSetting) => appEnv(SETTING_ENV[setting].env);

/**
 * Whether accounts are open (name.ts ACCOUNTS_LIVE), or turned on by KIKO_ACCOUNTS=1 (development,
 * the tests); KIKO_ACCOUNTS=0 turns them off again once they're live. Read at each use.
 */
export function accountsLive(env: NodeJS.ProcessEnv = process.env): boolean {
  const asked = envVar("ACCOUNTS", env)?.trim().toLowerCase();
  if (asked === "1" || asked === "on" || asked === "true") return true;
  if (asked === "0" || asked === "off" || asked === "false") return false;
  return ACCOUNTS_LIVE;
}

/**
 * Whether Kiko Pro is on sale (name.ts PRO_ON_SALE): only while accounts are open, and then
 * KIKO_PRO=1 turns it on (development, the tests), KIKO_PRO=0 off. Read at each use.
 */
export function proOnSale(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!accountsLive(env)) return false;
  const asked = envVar("PRO", env)?.trim().toLowerCase();
  if (asked === "1" || asked === "on" || asked === "true") return true;
  if (asked === "0" || asked === "off" || asked === "false") return false;
  return PRO_ON_SALE;
}

/**
 * Whether the phone shows (name.ts PHONE_LIVE): the release only once that's true, Kiko Dev (a
 * checkout) always; KIKO_PHONE_LIVE=1 turns it on, KIKO_PHONE_LIVE=0 off (development, the tests).
 * Read at each use; `flavour` is this run's unless a test says.
 */
export function phoneLive(env: NodeJS.ProcessEnv = process.env, flavour: Flavour = FLAVOUR): boolean {
  const asked = envVar("PHONE_LIVE", env)?.trim().toLowerCase();
  if (asked === "1" || asked === "on" || asked === "true") return true;
  if (asked === "0" || asked === "off" || asked === "false") return false;
  return PHONE_LIVE || flavour === "dev";
}

/** Said, and shown, for anything about the phone asked while it isn't live (phoneLive): one plain line, nothing done. */
export const PHONE_NOT_OUT = "The iPhone app isn't out yet.";

/** The account API's address: KIKO_ACCOUNT_URL (a local one for development and the tests), else name.ts ACCOUNT_URL. No trailing slash. */
export const accountUrl = (env: NodeJS.ProcessEnv = process.env): string => (envVar("ACCOUNT_URL", env)?.trim() || ACCOUNT_URL).replace(/\/+$/, "");

/** The variable that sets `setting`, when one does ("KIKO_TTS"). */
export const settingEnvName = (setting: string) => (setting in SETTING_ENV ? appEnvName(SETTING_ENV[setting as EnvSetting].env) : undefined);

/**
 * The trial proxy's address (the account service's API.md, "The AI proxy"): KIKO_AI_URL (a local one
 * for development and the tests), else the account API's own, under /ai. No trailing slash.
 */
export const aiUrl = (env: NodeJS.ProcessEnv = process.env): string => (envVar("AI_URL", env)?.trim() || `${accountUrl(env)}/ai`).replace(/\/+$/, "");
