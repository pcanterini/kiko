import { guardOffOf, guardOn } from "./guard.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { ENV_FILE } from "./app-root.ts";
import { appEnv, phoneLive, settingEnv } from "./env.ts";
import { envVar, PHONE_PORT, RELAY_URL, setSpokenName } from "./name.ts";
import { newSessionModeChosen, newSessionModeSetting } from "./permission-mode.ts";
import { iconsSetting, loadSettings, newSessionSetting, scratchFolderOf, summaryLengthOf, type ListenMode, type Settings, type VoiceCan } from "./settings.ts";
import { fillKeys, hasModel, KEY_NAMES, keysInUse, pickEngines } from "./keys.ts";
import { keyOf } from "./key-values.ts";
import { pocketInstalled } from "./pocket-tts.ts";
import { OPENROUTER_HAIKU } from "./openrouter-llm.ts";
import { keyStore } from "../platform/keys.ts";
import { accountHasPlan, accountRunsModels } from "./account/app-account.ts";

// The keys the environment had before .env (for where each came from: settings → Keys).
const shellKeys = new Set(KEY_NAMES.filter((name) => process.env[name]));
// A checkout's .env, the repo's wherever it runs from; an installed copy reads none (core/app-root.ts).
if (ENV_FILE && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
// The ones in neither, from the Keychain (core/keys.ts): a key in the environment or .env wins.
// .env's and the Keychain's are held in memory (core/key-values.ts), not in process.env: nothing
// this starts inherits them. Read one with keyOf.
export const keys = fillKeys(process.env, shellKeys, keyStore);
// Your choices from settings; an environment variable (or .env value) for the same thing wins (core/env.ts SETTING_ENV).
const saved = loadSettings();
const num = (env: string | undefined, fromSettings: number | undefined, fallback: number) => (env !== undefined ? Number(env) : (fromSettings ?? fallback));

// "~/git" as the full path.
const fromHome = (path: string) => path.trim().replace(/^~(?=$|\/)/, homedir());

const offIfEmpty = (value: string) => (["", "off", "false", "none"].includes(value.trim().toLowerCase()) ? "" : value.trim());

/**
 * The voice, speech recognition and model that run, by what's chosen (an .env value wins) and the
 * keys there are now (keys.ts pickEngines): one chosen whose key is missing gets a free stand-in, said
 * at start (`fallbacks`); nothing chosen is the one-key setup, or the paid one whose key is there.
 */
export const enginesFor = (s: Settings) =>
  pickEngines({ tts: settingEnv("tts") ?? s.tts, stt: settingEnv("stt") ?? s.stt, llm: settingEnv("llm") ?? s.llm }, keysInUse(), pocketInstalled(), viaAccount());
/**
 * Pocket is the voice that would speak if it were installed in this copy: chosen (settings or
 * KIKO_TTS), or with nothing chosen the free voice picked (no Cartesia key). Not for Cartesia chosen
 * without its key, whose stand-in is Pocket only once it's there. app.ts starts Pocket's download
 * at start when it's wanted and missing (a new clone: settings shared, the venv the copy's own).
 */
export function pocketWanted(s: Settings = loadSettings()): boolean {
  const chosen = settingEnv("tts") ?? s.tts;
  return chosen ? chosen === "pocket" : pickEngines({}, keysInUse(), true, viaAccount()).tts === "pocket";
}
/**
 * No OpenRouter key of your own, and a Kiko account's plan in effect (accounts open, signed in, a
 * trial or Pro): OpenRouter's calls go through the account (core/model-route.ts). Yours always wins.
 */
export const viaAccount = () => !keyOf("OPENROUTER_API_KEY") && accountRunsModels();
const engines = enginesFor(saved);
/** What stands in this run for a choice whose key is missing (app.ts says it once at start). */
export const keyFallbacks = engines.fallbacks;
/**
 * No OpenRouter or Anthropic key, and no account plan to run on: no model, so the app stops and says
 * how to add one. The same question setup asks (keys.ts hasModel), so setup never skips the key when
 * the app won't find one. A plan in effect counts, Pro past its month's allowance too (accountHasPlan):
 * a Pro account is never stopped for a key; its AI waits for the renewal, or your own key runs it.
 */
export const noModelKey = !hasModel(keysInUse(), accountHasPlan());
const tts = engines.tts as "cartesia" | "say" | "pocket";
const stt = engines.stt as "deepgram" | "apple";
// "haiku" uses the Anthropic API; anything else is an OpenRouter model ID.
const llm = engines.llm ?? OPENROUTER_HAIKU;
// The classifier's models (core/classifier.ts, OpenRouter's decisions endpoint); see classifierModel,
// utteranceModel and shadowModel below.
const classifierModel = appEnv("CLASSIFIER_MODEL") ?? "typesafe/jev-1.14";
const utteranceModel = settingEnv("utteranceModel") ?? saved.utteranceModel ?? classifierModel;
// Shadow testing (shadow.ts) is a developer's tool, not a setting: off unless KIKO_DEV_SHADOW=1,
// whatever settings.json or KIKO_SHADOW_MODEL say, so no one pays for, or sends their words to, a model
// they never chose. With the switch on, KIKO_SHADOW_MODEL and KIKO_UTTERANCE_SHADOW_MODEL pick the models.
const devShadow = envVar("DEV_SHADOW") === "1";
const shadowModel = devShadow ? offIfEmpty(appEnv("SHADOW_MODEL") ?? "liquid/d1-ultra") : "";

// What you call the app, out loud (name.ts spokenName): set for this run here, once .env is read;
// the settings screen sets it again when you change it.
setSpokenName(settingEnv("spokenName") ?? saved.spokenName);

export const DEFAULT_CARTESIA_VOICE = "a0e99841-438c-4a64-b679-ae501e7d6091"; // Greg

/** KIKO_RELAY_URL as the relay to use: unset, name.ts RELAY_URL; "off", "0", "none" or empty, none; else the address given. */
export function relayUrlOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return RELAY_URL;
  const v = raw.trim();
  return v === "" || /^(off|0|none|false|no)$/i.test(v) ? undefined : v;
}

export const config = {
  // "deepgram" (streaming, paid) or "apple" (on-device, free).
  stt,
  deepgramKey: keyOf("DEEPGRAM_API_KEY"),
  cartesiaKey: keyOf("CARTESIA_API_KEY"),
  anthropicKey: keyOf("ANTHROPIC_API_KEY"),
  anthropicWorkspace: process.env.ANTHROPIC_WORKSPACE_ID,

  // "hold": hold the hotkey to talk (global, works while unfocused). "tap": press Enter to start and again to stop.
  pttMode: (settingEnv("pttMode") ?? saved.pttMode ?? "hold") as "hold" | "tap",
  // A key name from KEYS in hotkey.ts (right_option, right_command, fn, f13…), or keycode:<n>.
  hotkey: settingEnv("hotkey") ?? saved.hotkey ?? "right_option",
  // "push-to-talk", the default: the key. "hands-free": the mic stays open and Apple's on-device
  // speech-to-text listens for the app's name (hands-free.ts, wake.ts). The key still works.
  listenMode: (settingEnv("listenMode") ?? saved.listenMode ?? "push-to-talk") as ListenMode,
  // Hands-free: in a session's reply window, what you say is its reply without the name first.
  replyWithoutName: (settingEnv("replyWithoutName") ?? String(saved.replyWithoutName ?? true)) !== "false",
  // The microphone for every capture path (mic-device.ts): a Core Audio device UID, or in KIKO_MIC
  // also a name; empty is the system default. One that's away falls back to the default until it's back.
  mic: settingEnv("mic") ?? saved.mic ?? "",
  micName: settingEnv("mic") ?? saved.micName ?? "",

  // Writes the spoken summaries and the app's own replies: Haiku, or an OpenRouter model (llm).
  llm,
  summaryModel: appEnv("SUMMARY_MODEL") ?? "claude-haiku-5-5",
  summaryEffort: (appEnv("SUMMARY_EFFORT") ?? "low") as "low" | "medium" | "high",
  summaryLength: summaryLengthOf(settingEnv("summaryLength") ?? saved.summaryLength),
  // When a finished session speaks up: "all" turns, "results" and questions (skips pleasantries),
  // or only when Claude "needs_you". The last two need the classifier; without it every turn is spoken.
  announce: (settingEnv("announce") ?? saved.announce ?? "results") as "all" | "results" | "needs_you",

  // Optional for the classifier; needed when llm is an OpenRouter model. With a key, the classifier's
  // models on OpenRouter (Jev, d1-ultra) decide who you're talking to and whether a finished turn is worth reading out. Without one, replies go to the waiting session
  // and Haiku handles the rest. Settings can turn it off while keeping the key.
  openrouterKey: keyOf("OPENROUTER_API_KEY"),
  classifier: saved.classifier !== false && (Boolean(keyOf("OPENROUTER_API_KEY")) || viaAccount()),
  // The classifier's model (Jev by default) decides finished turns (worth reading out? waiting on you?), permission answers and risk.
  classifierModel,
  // Your words (who they're for, what kind of thing, parts for the app) can go to their own classifier
  // model. Jev by default: d1-ultra won more live audience calls but lost the routing eval, and its
  // misses were its own. Any model on OpenRouter's decisions endpoint, e.g. liquid/d1-ultra.
  utteranceModel,
  // Below this confidence about who you're talking to, Haiku decides instead (it can ask).
  classifierMinConfidence: num(settingEnv("classifierMinConfidence"), saved.classifierMinConfidence, 0.75),
  // When the app had to guess where your words go (the router picked the session: you didn't name
  // it, it isn't the one waiting for your reply, the classifier wasn't sure), it says "To <session>" and holds
  // the send about a second, so "no, clipkit" or "cancel" changes it before that session sees it.
  holdUnsure: (settingEnv("holdUnsure") ?? String(saved.holdUnsure ?? true)) !== "false",
  // Shadow testing, only with KIKO_DEV_SHADOW=1 (above): another classifier model answers the same
  // questions at the same time, on every utterance and finished turn. Only logged ("shadow" events),
  // never acted on; compare with `pnpm shadow:report`. Runs only while the classifier does. KIKO_SHADOW_MODEL shadows
  // the classifier's finished turns (d1-ultra); empty or "off" turns all shadowing off.
  shadowModel,
  // The shadow on your words: by default whichever of Jev and d1-ultra isn't deciding them, so
  // the comparison carries on whichever way round. KIKO_UTTERANCE_SHADOW_MODEL=off turns only this off.
  utteranceShadowModel: shadowModel ? offIfEmpty(appEnv("UTTERANCE_SHADOW_MODEL") ?? (utteranceModel === classifierModel ? shadowModel : classifierModel)) : "",

  // How long a finished session waits for a spoken reply once its summary has been spoken.
  // It shows as still running meanwhile; after that it stops and replies are typed into its terminal
  // (where an adapter reaches it: never the Claude desktop app's).
  replyWindowMs: num(settingEnv("replyWindowMs"), saved.replyWindowMs, 10000),
  // Shorter window when the classifier says Claude isn't asking you anything (it just reported something).
  fyiReplyWindowMs: num(settingEnv("fyiReplyWindowMs"), saved.fyiReplyWindowMs, 4000),
  // Soft cues when the mic opens and when your words reach a session.
  sounds: (settingEnv("sounds") ?? String(saved.sounds ?? true)) !== "false",
  // Play the voice and the cues on this Mac. Off, the Mac plays nothing; a phone with Play on phone
  // on still gets them, and everything is timed as if they'd played (mac-output.ts). Only the phone
  // app switches it (play_on_mac); the Mac has no setting for it, it's just remembered here. On
  // while the iPhone app isn't out (core/env.ts phoneLive): what's saved is kept for then.
  playOnMac: !phoneLive() || saved.playOnMac !== false,
  // While you talk, lower the Mac's volume (music, videos) to duckLevel percent of what it was, and
  // put it back when you're done (duck.ts). Not while the app speaks: its voice would drop too.
  duckMusic: (settingEnv("duckMusic") ?? String(saved.duckMusic ?? true)) !== "false",
  duckLevel: num(settingEnv("duckLevel"), saved.duckLevel, 20),
  // Clean up your words before a session reads them (cleanup.ts): fillers, stutters and false
  // starts left out, punctuation fixed, nothing reworded. Only what goes to a session; the app
  // decides where it goes from your words as said.
  cleanUp: (settingEnv("cleanUp") ?? String(saved.cleanUp ?? true)) !== "false",
  // Tell speech-to-text which words to expect (stt-hints.ts): your dictionary's, session names and
  // folders. Deepgram bills its keyterm prompting as an add-on (KIKO_PRICE_DEEPGRAM_KEYTERM_MINUTE).
  sttHints: (settingEnv("sttHints") ?? String(saved.sttHints ?? true)) !== "false",
  // Answer permission prompts by voice. Claude Code shows its own prompt only after the voice window
  // ends unanswered, so keep the window short.
  voicePermissions: (settingEnv("voicePermissions") ?? String(saved.voicePermissions ?? true)) !== "false",
  permissionWindowMs: num(settingEnv("permissionWindowMs"), saved.permissionWindowMs, 20000),
  // The safety gate (core/guard.ts): Kiko asks before anything that sends, deletes, pays or posts,
  // whatever a session's own permission mode or allow rules. Off unless turned on (since 2026-11-02;
  // hooks/lib.mjs guardOn, which the hooks read too); kinds can be turned off one by one.
  guard: guardOn(saved),
  guardOff: guardOffOf(saved.guardOff) as string[],
  // A prompt for a call that only reads is allowed without asking, once each time (core/auto-allow.ts;
  // since 2026-11-12). On unless turned off: a fresh install asks only for what can change something.
  autoAllowReads: saved.autoAllowReads !== false,
  // What your voice may do. "replies": only answer a session waiting for your reply, and permission
  // prompts. "messages": also send to any session any time, typed into its terminal.
  // "everything" (the default; the safety gate, turned on, asks before anything that sends,
  // deletes, pays or posts): also start, stop and rename sessions, quick checks and the dictionary.
  // A value you saved stays yours.
  voiceCan: (settingEnv("voiceCan") ?? saved.voiceCan ?? "everything") as VoiceCan,
  // Quick tasks (voice can: everything): a one-off, read-only Claude Code run (`claude -p`) for
  // questions about the computer. Haiku: these are lookups (run df, read it, say it), where speed
  // matters more than depth, and it's the cheapest. Any `claude --model` name or alias works.
  quickTaskModel: settingEnv("quickTaskModel") ?? saved.quickTaskModel ?? "haiku",
  quickTaskTimeoutMs: num(settingEnv("quickTaskTimeoutMs"), saved.quickTaskTimeoutMs, 60_000),
  quickTaskMaxTurns: num(settingEnv("quickTaskMaxTurns"), saved.quickTaskMaxTurns, 8),
  // Where new sessions open (core/projects.ts). The projects root: the folder whose subfolders are
  // your projects, next to the folders Claude Code has run in; "" (unset) uses the usual ones that
  // exist (~/git, ~/code, …). A session with no project of its own gets a fresh folder in the scratch folder.
  projectsRoot: fromHome(settingEnv("projectsRoot") ?? saved.projectsRoot ?? ""),
  scratchFolder: scratchFolderOf(saved),
  // The agent a new session starts in when you don't name one (core/agent-pick.ts): "last-used"
  // (the default: the one you last started a session in) or an agent's id, pinned. Naming one
  // ("start a Codex session in pixie") wins over it; so does `kiko codex` for its run.
  newSessionAgent: newSessionSetting(settingEnv("newSessionAgent") ?? saved.newSessionAgent),
  // The permission mode a session Kiko opens starts in (core/permission-mode.ts): Accept edits
  // unless set; "inherit" passes no flag (your Claude Code default, auto for some).
  newSessionMode: newSessionModeSetting(settingEnv("newSessionMode") ?? saved.newSessionMode),
  // Whether it was chosen rather than left at its default: left, scratch sessions start in auto
  // where Claude Code offers it (core/permission-mode.ts startModeFor); chosen, they get it too.
  newSessionModeChosen: newSessionModeChosen(settingEnv("newSessionMode") ?? saved.newSessionMode),
  // Each session's agent mark in the lists (ui/marks.ts): plain Unicode glyphs ("unicode", the
  // default), or Nerd Font icons where the agent has one ("nerd": Nerd Fonts 3.5 or newer).
  icons: iconsSetting(settingEnv("icons") ?? saved.icons),

  // The phone companion (src/remote/): a WebSocket server on every interface, so a paired phone
  // reaches the Mac at home and through Tailscale. Off unless turned on (Settings → Phone). Off too
  // while the iPhone app isn't out (core/env.ts phoneLive): a `phone: true` saved is kept, not used.
  phone: phoneLive() && (settingEnv("phone") ?? String(saved.phone ?? false)) === "true",
  phonePort: Number(envVar("PHONE_PORT") ?? PHONE_PORT),
  // Only this address (the harness uses 127.0.0.1); unset, every interface.
  phoneHost: envVar("PHONE_HOST") || undefined,
  // The phone relay (src/remote/relay-client.ts, relay/): where the Mac's room is, so the phone
  // reaches the Mac away from home too (name.ts RELAY_URL, unless KIKO_RELAY_URL names another or
  // is "off"). No setting of its own: it's on with Phone.
  relayUrl: relayUrlOf(envVar("RELAY_URL")),

  // "cartesia" (natural, paid), "say" (macOS built-in voice, free) or "pocket" (Pocket TTS, local, free).
  tts,
  pocketVoice: settingEnv("pocketVoice") ?? saved.pocketVoice,
  sayVoice: settingEnv("sayVoice") ?? saved.sayVoice,
  sayRate: settingEnv("sayRate") ?? saved.sayRate,
  cartesiaModel: appEnv("CARTESIA_MODEL") ?? "sonic-3.6",
  cartesiaVoice: settingEnv("cartesiaVoice") ?? saved.cartesiaVoice ?? DEFAULT_CARTESIA_VOICE,
  cartesiaVersion: appEnv("CARTESIA_VERSION") ?? "2026-08-14",
  // How long Cartesia may wait for more text before speaking what it has.
  cartesiaBufferMs: Number(appEnv("CARTESIA_BUFFER_MS") ?? 250),
};

export const MIC_SAMPLE_RATE = 16000;
export const TTS_SAMPLE_RATE = 24000;
