// The settings screen (ui-store.ts `settings`, ui/settings.tsx): every row (refreshSettings) and
// what changing one does (applySetting). The sections with rows and actions of their own are in
// ./settings/: the dictionary and pronunciation (by voice too), the voice and model, updates, logs,
// the agents Kiko connects to, the account, keys, and the microphone.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { guardOffOf, guardValue } from "../core/guard.ts";
import { keepLogsOf, type KeepLogs } from "../core/log-retention.ts";
import { config, enginesFor, viaAccount } from "../core/config.ts";
import { PHONE_NOT_OUT, phoneLive, settingEnv, settingEnvName } from "../core/env.ts";
import { KEYS, type Fallback } from "../core/keys.ts";
import { keyOf } from "../core/key-values.ts";
import { shortPath } from "../core/text.ts";
import { fallbackNote, micValue } from "../core/mic-device.ts";
import { expandHome, projectsRootShown } from "../core/projects.ts";
import { classifierEnabled } from "../core/classifier.ts";
import { loadDictionary } from "../core/dictionary.ts";
import { DEFAULTS as BUILT_IN_SAYINGS, loadPronunciations } from "../core/pronunciation.ts";
import { nameWarning } from "../core/wake.ts";
import { iconsSetting, LAST_USED, loadSettings, saveSettings, summaryLengthOf, type ListenMode, type Settings, type VoiceCan } from "../core/settings.ts";
import { cleanSpokenName, COMMAND, envVar, NAME, setSpokenName, SPOKEN_DEFAULT, spokenName } from "../core/name.ts";
import { starter, starters } from "../agents/index.ts";
import { platform } from "../platform/index.ts";
import { ui, type SettingKey, type SettingRow } from "../core/ui-store.ts";
import { newSessionModeSetting } from "../core/permission-mode.ts";
import {
  ANNOUNCE,
  CLASSIFIER_CONFIDENCE,
  DUCK_LEVELS,
  ICONS,
  keyLabel,
  LISTEN_MODES,
  modelLabel,
  NEW_SESSION_MODES,
  PHONE_KEYS,
  PTT_MODES,
  seconds,
  STT_ENGINES,
  SUMMARY_LENGTHS,
  TTS_ENGINES,
  VOICE_CAN,
  voiceVolumeRow,
} from "../core/settings-options.ts";
import { customVoiceName, saveVoiceGain } from "../core/pocket-voices.ts";
import { DEFAULT_KEY, KEY_ENV, keyWords, parseKey } from "../terminals/tmux/keys.ts";
import { log } from "../core/log.ts";
import { writeState } from "./status.ts";
import { pairPhone, phoneAction, phoneRows, setPhone } from "./phone.ts";
import { phoneIncludedNow } from "./phone-plan.ts";
import { state } from "./state.ts";
import { setListening } from "./talk.ts";
import { accountAction, accountRows } from "./settings/account.ts";
import { agentAction, agentRows } from "./settings/agents.ts";
import { refreshHints } from "./settings/dictionary.ts";
import { anthropicAtStart, keyRows, keySettings } from "./settings/keys.ts";
import { logsRow, openLogs, pruneLogsNow } from "./settings/logs.ts";
import { micInUse as micNow, pickMic } from "./settings/mic.ts";
import { setAutoUpdate, updateAction, updateRows } from "./settings/updates.ts";
import { modelName, pendingTts, voiceFor } from "./settings/voice.ts";

export const labelIn = (choices: Array<{ value: unknown; label: string }>, value: unknown) => choices.find((c) => c.value === value)?.label ?? String(value);

/** A value with the key missing when a free engine or another model stands in for the one chosen: "Pocket TTS (no Cartesia key)". */
function standingIn(value: string, fallback: Fallback | undefined) {
  return fallback ? `${value} (no ${KEYS.find((k) => k.id === fallback.key)!.name} key)` : value;
}

/** How you talk to it now: hands-free only once it's listening. */
function listenValue() {
  if (config.listenMode === "hands-free" && !state.handsFree?.on) return state.handsFreeError ? "Push-to-talk (hands-free unavailable)" : "Hands-free (starting…)";
  return labelIn(LISTEN_MODES, config.listenMode);
}

/** The projects root as shown (core/projects.ts projectsRootShown). */
const projectsRootValue = () => projectsRootShown(config.projectsRoot, homedir());

/** "New sessions in" as shown: "Last used (Codex)" (or plain "Last used" before any), or the agent pinned. */
function newSessionValue(saved: Settings) {
  if (config.newSessionAgent !== LAST_USED) return starter(null, config.newSessionAgent).name;
  const last = saved.lastNewSessionAgent ? starters().find((a) => a.id === saved.lastNewSessionAgent) : undefined;
  return last ? `Last used (${last.name})` : "Last used";
}

/**
 * "Menu key": as saved (Ctrl+Space unless set), and what this run uses when that's another (a
 * clash `kiko` found, --key, KIKO_KEY).
 */
function menuKeyRow(saved: Settings): SettingRow {
  const parsed = parseKey(String(saved.menuKey ?? DEFAULT_KEY));
  const want = "key" in parsed ? parsed.key : DEFAULT_KEY;
  const row: SettingRow = { key: "menuKey", label: "Menu key", raw: want, value: keyWords(want), restart: false };
  const now = state.windowGlue?.key();
  if (now && now.key !== want) {
    const why = now.by === "flag" ? "--key" : now.by === "env" ? KEY_ENV : now.by === "clash" ? "it clashed" : "";
    row.note = `${keyWords(now.key)} this run${why ? ` (${why})` : ""}`;
  }
  return row;
}

/** Every setting with its current value, for the settings screen. */
export function refreshSettings() {
  const saved = loadSettings();
  const engines = enginesFor(saved);
  const tts = engines.tts;
  const stt = engines.stt;
  const fellBack = (setting: Fallback["setting"], using: string) => engines.fallbacks.find((f) => f.setting === setting && f.using === using);
  const voice = voiceFor(tts, saved);
  const onOff = (v: boolean) => (v ? "On" : "Off");
  // Your own key, or the account's plan running OpenRouter's models (core/model-route.ts).
  const hasOpenrouterKey = Boolean(keyOf("OPENROUTER_API_KEY")) || viaAccount();
  const dictionary = loadDictionary();
  const sayings = loadPronunciations();
  const micInUse = micNow();
  const rows: SettingRow[] = [
    { key: "voiceCan", label: "Voice can", raw: config.voiceCan, value: labelIn(VOICE_CAN, config.voiceCan), restart: false },
    { key: "tts", label: "Voice engine", raw: tts, value: standingIn(labelIn(TTS_ENGINES, tts), fellBack("tts", tts)), restart: true },
    { key: "voice", label: "Voice", raw: voice.raw, value: voice.name, restart: tts === "say" || tts !== config.tts },
    // Only for one of your Pocket voices (its sidecar's gain).
    ...[voiceVolumeRow(tts, voice.raw)].filter((r): r is SettingRow => Boolean(r)),
    // raw: your entries, so the list loads again when they change.
    { key: "pronunciation", label: "Pronunciation", raw: JSON.stringify(sayings), value: `${sayings.length} yours · ${BUILT_IN_SAYINGS.length} built in`, restart: false },
    { key: "stt", label: "Speech recognition", raw: stt, value: standingIn(labelIn(STT_ENGINES, stt), fellBack("stt", stt)), restart: true },
    { key: "cleanUp", label: "Clean up my messages", raw: config.cleanUp, value: onOff(config.cleanUp), restart: false },
    { key: "dictionary", label: "Dictionary", raw: JSON.stringify(dictionary), value: `${dictionary.length} ${dictionary.length === 1 ? "word" : "words"}`, restart: false },
    { key: "sttHints", label: "Speech hints", raw: config.sttHints, value: onOff(config.sttHints), restart: false },
    { key: "llm", label: "Model", raw: config.llm, value: standingIn(modelLabel(config.llm), fellBack("llm", config.llm)), restart: false },
    { key: "hotkey", label: "Push-to-talk key", raw: saved.hotkey ?? config.hotkey, value: keyLabel(saved.hotkey ?? config.hotkey), restart: true },
    { key: "spokenName", label: "Its name", raw: spokenName(), value: spokenName(), restart: false },
    { key: "listenMode", label: "Listen", raw: config.listenMode, value: listenValue(), restart: false },
    { key: "replyWithoutName", label: `Reply without saying ${spokenName()}`, raw: config.replyWithoutName, value: onOff(config.replyWithoutName), restart: false },
    // raw: the device it matched (its UID may have changed since you picked it), or the one that's away.
    { key: "mic", label: "Microphone", raw: micInUse.wanted ? (micInUse.fallback ? micInUse.wanted.uid : (micInUse.device?.uid ?? "")) : "", value: micValue(micInUse), restart: false },
    { key: "micTest", label: "Test microphone", raw: "", value: "5 seconds", restart: false },
    { key: "pttMode", label: "Push-to-talk style", raw: saved.pttMode ?? config.pttMode, value: labelIn(PTT_MODES, saved.pttMode ?? config.pttMode), restart: true },
    { key: "duckMusic", label: "Lower the volume while I talk", raw: config.duckMusic, value: onOff(config.duckMusic), restart: false },
    { key: "duckLevel", label: "Volume while I talk", raw: config.duckLevel, value: DUCK_LEVELS.find((c) => c.value === config.duckLevel)?.label ?? `${config.duckLevel}%`, restart: false },
    { key: "announce", label: "Speak up when", raw: config.announce, value: labelIn(ANNOUNCE, config.announce), restart: false },
    { key: "summaryLength", label: "Summary length", raw: config.summaryLength, value: labelIn(SUMMARY_LENGTHS, config.summaryLength), restart: false },
    { key: "sounds", label: "Sounds", raw: config.sounds, value: onOff(config.sounds), restart: false },
    { key: "replyWindowMs", label: "Reply window", raw: config.replyWindowMs, value: seconds(config.replyWindowMs), restart: false },
    { key: "fyiReplyWindowMs", label: "Reply window, just reporting", raw: config.fyiReplyWindowMs, value: seconds(config.fyiReplyWindowMs), restart: false },
    // raw: on and the kinds turned off, as JSON (settings-options.ts guardChoices).
    {
      key: "guard",
      label: "Safety gate",
      raw: JSON.stringify({ on: config.guard, off: config.guardOff }),
      value: guardValue(config.guard, config.guardOff),
      restart: false,
    },
    { key: "autoAllowReads", label: "Allow read-only commands", raw: config.autoAllowReads, value: onOff(config.autoAllowReads), restart: false },
    { key: "voicePermissions", label: "Permissions by voice", raw: config.voicePermissions, value: onOff(config.voicePermissions), restart: false },
    { key: "permissionWindowMs", label: "Permission window", raw: config.permissionWindowMs, value: seconds(config.permissionWindowMs), restart: false },
    { key: "classifier", label: "Classifier", raw: config.classifier, value: hasOpenrouterKey ? onOff(config.classifier) : "Off (no OpenRouter key)", restart: false },
    { key: "classifierMinConfidence", label: "Classifier confidence", raw: config.classifierMinConfidence, value: labelIn(CLASSIFIER_CONFIDENCE, config.classifierMinConfidence), restart: false },
    { key: "holdUnsure", label: "Hold unsure sends", raw: config.holdUnsure, value: onOff(config.holdUnsure), restart: false },
    { key: "projectsRoot", label: "Projects root", raw: config.projectsRoot, value: projectsRootValue(), restart: false },
    { key: "scratchFolder", label: "Scratch folder", raw: config.scratchFolder, value: shortPath(config.scratchFolder), restart: false },
    { key: "newSessionAgent", label: "New sessions in", raw: config.newSessionAgent, value: newSessionValue(saved), restart: false },
    { key: "newSessionMode", label: "Permission mode", raw: config.newSessionMode, value: labelIn(NEW_SESSION_MODES, config.newSessionMode), restart: false },
    menuKeyRow(saved),
    { key: "icons", label: "Nerd Font icons", raw: config.icons, value: labelIn(ICONS, config.icons), restart: false },
    { key: "voiceGlow", label: "Voice glow", raw: config.voiceGlow, value: onOff(config.voiceGlow), restart: false },
    ...phoneRows(),
    ...updateRows(),
    logsRow(saved),
    ...agentRows(),
    ...accountRows(),
    ...keyRows(),
  ];
  for (const row of rows) {
    const env = settingEnvName(row.key);
    if (env) row.note = `${env} in .env wins`;
    if (row.key === "listenMode" && state.handsFreeError) row.note = `Apple speech isn't available: ${state.handsFreeError}`;
    if ((row.key === "mic" || row.key === "micTest") && micInUse.fallback) row.note = fallbackNote(micInUse) ?? undefined;
  }
  ui.set({ settings: rows });
}

/**
 * What changing a setting did besides being saved: "restart" (it applies after one), or "refused"
 * (said why, and nothing saved). Nothing: it applies now.
 */
type Change = "restart" | "refused" | undefined;

/** The settings saved and used at once, nothing more: each with how its value is read. */
const AT_ONCE: { [K in keyof Settings & keyof typeof config]?: (value: unknown) => NonNullable<Settings[K]> & (typeof config)[K] } = {
  voiceCan: (v) => v as VoiceCan,
  replyWithoutName: Boolean,
  announce: (v) => v as (typeof config)["announce"],
  summaryLength: (v) => summaryLengthOf(String(v)),
  sounds: Boolean,
  duckMusic: Boolean,
  duckLevel: Number,
  cleanUp: Boolean,
  replyWindowMs: Number,
  fyiReplyWindowMs: Number,
  autoAllowReads: Boolean,
  voicePermissions: Boolean,
  permissionWindowMs: Number,
  classifierMinConfidence: Number,
  holdUnsure: Boolean,
};

function saveAtOnce<K extends keyof typeof AT_ONCE>(next: Settings, key: K, value: unknown) {
  const v = AT_ONCE[key]!(value);
  next[key] = v;
  config[key] = v;
}

/** An engine or push-to-talk's style, started with the app: saved, and used after a restart when it changed. */
function atRestart<K extends "tts" | "stt" | "pttMode">(key: K) {
  return (next: Settings, value: unknown): Change => {
    next[key] = value as Settings[K];
    return value !== config[key] ? "restart" : undefined;
  };
}

/** The rest, each with what it does as it changes. */
const CHANGES: Partial<Record<SettingKey, (next: Settings, value: unknown, label?: string) => Change>> = {
  tts: atRestart("tts"),
  stt: atRestart("stt"),
  pttMode: atRestart("pttMode"),
  hotkey: (next, value) => {
    next.hotkey = String(value);
    if (!(String(value) in platform.hotkey.keys)) ui.info(`${keyLabel(String(value))} also types into the focused app while you hold it.`);
    return value !== config.hotkey ? "restart" : undefined;
  },
  voice: (next, value, label) => {
    const tts = pendingTts(next);
    if (tts === "cartesia") {
      next.cartesiaVoice = String(value);
      next.cartesiaVoiceName = label;
      if (config.tts === "cartesia") config.cartesiaVoice = String(value);
    } else if (tts === "pocket") {
      next.pocketVoice = String(value);
      if (config.tts === "pocket") config.pocketVoice = String(value);
    } else {
      next.sayVoice = String(value) || undefined;
    }
    ui.set({ about: { ...ui.state.about, voice: label ?? String(value) } });
    return tts === "say" || tts !== config.tts ? "restart" : undefined;
  },
  voiceVolume: (next, value) => {
    // Written beside the voice (its sidecar), not in the settings: read as each reply starts, so heard from the next.
    const name = customVoiceName(voiceFor(pendingTts(next), next).raw);
    if (name === undefined) return refuse("The volume is for one of your own voices: pick one under Voice first.");
    try {
      saveVoiceGain(name, Number(value));
    } catch (err: any) {
      return refuse(`Couldn't save the volume of ${name}: ${err?.message ?? err}`);
    }
  },
  llm: (next, value) => {
    next.llm = config.llm = String(value);
    ui.set({ about: { ...ui.state.about, model: modelName() } });
    // Haiku's clients were made at start: with an Anthropic key entered since, they need a restart.
    return value === "haiku" && config.anthropicKey !== anthropicAtStart ? "restart" : undefined;
  },
  listenMode: (next, value) => {
    next.listenMode = config.listenMode = value as ListenMode;
    void setListening(config.listenMode);
  },
  spokenName: (next, value) => {
    // Works at once: the wake word, the dictionary, the hints and what it says of itself all read
    // it as they go. The default isn't written, so it follows the default. KIKO_SPOKEN_NAME, when set, decides this run.
    const name = cleanSpokenName(String(value)) || SPOKEN_DEFAULT;
    if (name === SPOKEN_DEFAULT) delete next.spokenName;
    else next.spokenName = name;
    if (settingEnv("spokenName") !== undefined) return;
    setSpokenName(name);
    refreshHints();
    writeState(); // the status line's "listening for …"
    const warning = nameWarning(name);
    ui.info(`(Say “${name}, …” to talk to it now.${warning ? ` ${warning}` : ""})`);
  },
  mic: (next, value, label) => {
    pickMic(next, String(value), label);
  },
  sttHints: (next, value) => {
    next.sttHints = config.sttHints = Boolean(value);
    refreshHints();
  },
  guard: (next, value) => {
    // On (every kind), off, or one kind turned off or back on; works at the next tool call (the
    // hooks read it from the settings file: hooks/lib.mjs guardSaved). Saved either way, true or
    // false: off is the default since 2026-11-02, and a choice made here stays if that changes.
    const v = String(value);
    if (v === "on" || v === "off") {
      next.guard = config.guard = v === "on";
      if (v === "on") next.guardOff = config.guardOff = [];
    } else if (v.startsWith("kind:")) {
      const kind = v.slice(5);
      const asks = config.guard && !config.guardOff.includes(kind);
      const off = asks ? [...config.guardOff, kind] : config.guardOff.filter((k) => k !== kind);
      next.guardOff = config.guardOff = guardOffOf(off);
      next.guard = config.guard = true;
    }
    if (!next.guardOff?.length) delete next.guardOff;
  },
  classifier: (next, value) => {
    next.classifier = Boolean(value);
    config.classifier = Boolean(value) && (Boolean(keyOf("OPENROUTER_API_KEY")) || viaAccount());
    ui.set({ about: { ...ui.state.about, classifier: classifierEnabled() } });
  },
  phone: (next, value) => {
    next.phone = config.phone = Boolean(value);
    void setPhone(config.phone);
  },
  autoUpdate: (next, value) => {
    next.autoUpdate = Boolean(value);
    setAutoUpdate(next.autoUpdate);
  },
  menuKey: (next, value) => {
    // Saved for every `kiko` from now on (flag > KIKO_KEY > this > Ctrl+Space); bound now, unless --key or KIKO_KEY decided this run.
    const parsed = parseKey(String(value));
    if (!("key" in parsed)) return refuse(parsed.error);
    next.menuKey = parsed.key;
    // A key you picked: a clash with it is asked about afresh (clash.ts), not answered by what you said about another.
    delete next.keyClashAnswers;
    const by = state.windowGlue?.key().by;
    if (by === "flag" || by === "env") ui.info(`(Menu key ${keyWords(parsed.key)}: from the next ${COMMAND}; ${by === "flag" ? "--key" : KEY_ENV} decides this run.)`);
    else if (state.windowGlue) void state.windowGlue.setKey(parsed.key).then(refreshSettings, (err) => ui.error("settings", err));
  },
  icons: (next, value) => {
    // Drawn at once, in the list and the picker; KIKO_ICONS, when set, decides this run.
    next.icons = iconsSetting(value);
    if (envVar("ICONS") === undefined) ui.set({ icons: (config.icons = next.icons) });
  },
  voiceGlow: (next, value) => {
    // Shown (or faded out) at once, in either look.
    next.voiceGlow = Boolean(value);
    ui.set({ voiceGlow: (config.voiceGlow = next.voiceGlow) });
  },
  projectsRoot: (next, value) => {
    // Empty: not set, the usual folders.
    const path = expandHome(String(value), homedir());
    if (path && (!existsSync(path) || !statSync(path).isDirectory())) return refuse(`No folder at ${path}`);
    if (path) next.projectsRoot = path;
    else delete next.projectsRoot;
    config.projectsRoot = path;
  },
  scratchFolder: (next, value) => {
    // Made when a session first needs it.
    const path = expandHome(String(value), homedir());
    if (!path.startsWith("/")) return refuse(`The scratch folder needs a full path, like ~/${NAME}/scratch.`);
    if (existsSync(path) && !statSync(path).isDirectory()) return refuse(`${path} isn't a folder`);
    next.scratchFolder = config.scratchFolder = path;
  },
  newSessionAgent: (next, value) => {
    // "Last used", or an agent Kiko can start a session of, pinned; naming one when asking still wins.
    next.newSessionAgent = config.newSessionAgent = value === LAST_USED ? LAST_USED : starter(String(value), null).id;
  },
  newSessionMode: (next, value) => {
    // For the next session opened; the list's tags compare with it at once. KIKO_NEW_SESSION_MODE, when set, decides this run.
    next.newSessionMode = newSessionModeSetting(value);
    if (envVar("NEW_SESSION_MODE") === undefined) {
      // Chosen now: scratch sessions take it too, no longer auto (core/permission-mode.ts startModeFor).
      config.newSessionModeChosen = true;
      ui.set({ newSessionMode: (config.newSessionMode = next.newSessionMode) });
    }
  },
  keepLogs: (next, value) => {
    next.keepLogs = keepLogsOf(value) satisfies KeepLogs;
  },
};

/** A change refused: said, and nothing saved. */
function refuse(why: string): Change {
  ui.error("settings", why);
  return "refused";
}

/**
 * What the settings screen asks that isn't a setting: pairing and the paired phones, an agent's row,
 * Updates, the logs' folder, a key's row. True when it was one of those, carried out.
 */
function settingAction(key: SettingKey, value: unknown): boolean {
  if (key === "phoneConnect" || key === "phonePairing" || key === "phones") phoneAction(key, String(value));
  // Pair a phone: its QR code. With Phone off, Phone is turned on first (as its own row would), and the code shows once it listens.
  else if (key === "phonePair") {
    pairPhone(String(value));
    // Without the plan for the phone (Pro on sale), "open" only says the offer: Phone stays as it is.
    if (value === "open" && !config.phone && phoneIncludedNow()) applySetting("phone", true);
  } else if (key.startsWith("agent:")) agentAction(key.slice("agent:".length), String(value));
  else if (key === "updates") updateAction(String(value));
  else if (key === "account") accountAction(String(value));
  else if (key === "keepLogs" && value === "open") openLogs();
  // A key's row: not logged as a setting (and a key itself never comes this way: the "apiKey" action).
  else if (key.startsWith("key:")) void keySettings.act(key.slice("key:".length), String(value)).then(refreshSettings);
  else return false;
  return true;
}

/** Saves a change from the settings screen and applies it now, or after a restart. */
export function applySetting(key: SettingKey, value: unknown, label?: string) {
  // The Phone section isn't there while the iPhone app isn't out: nothing of it is carried out, or saved.
  if (PHONE_KEYS.has(key) && !phoneLive()) return void refuse(PHONE_NOT_OUT);
  if (settingAction(key, value)) return;
  const next: Settings = { ...loadSettings() };
  let change: Change;
  if (Object.hasOwn(AT_ONCE, key)) saveAtOnce(next, key as keyof typeof AT_ONCE, value);
  else change = CHANGES[key]?.(next, value, label);
  if (change === "refused") return;
  const restart = change === "restart";
  saveSettings(next);
  log("setting", { key, value, restart });
  if (key === "keepLogs") pruneLogsNow();
  if (restart) ui.set({ restartPending: true });
  refreshSettings();
}

/** "Press the key you want": waits for the next key press anywhere. */
export async function captureHotkey() {
  ui.set({ capturing: true });
  try {
    const key = await Promise.race([platform.hotkey.capture(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no key pressed in 20s")), 20000))]);
    applySetting("hotkey", key);
  } catch (err) {
    ui.error("settings", err);
  } finally {
    ui.set({ capturing: false });
  }
}
