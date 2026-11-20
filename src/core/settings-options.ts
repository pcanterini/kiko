// The choices for each setting, shared by first-run setup (ui/onboarding.ts) and the settings screen
// inside the app (ui/settings.ts), so labels and hints never drift apart.
import { KIND_INFO, KINDS } from "./guard.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { config, DEFAULT_CARTESIA_VOICE } from "./config.ts";
import { commonRoots } from "./projects.ts";
import { DICTIONARY_FILE, loadDictionary } from "./dictionary.ts";
import { DEFAULTS as BUILT_IN_SAYINGS, ENGINE_LABEL, loadPronunciations, overridden, PRONUNCIATION_FILE, type Pronunciation } from "./pronunciation.ts";
import { micChoices, type MicChoice, type MicDevice } from "./mic-device.ts";
import { POCKET_VOICES } from "./pocket-tts.ts";
import { customVoice, customVoiceName, customVoices, GAIN_MAX_DB, GAIN_MIN_DB, VOICES_DIR, voiceGain, voiceSidecar } from "./pocket-voices.ts";
import type { SettingFact, SettingRow } from "./ui-store.ts";
import { OPENROUTER_MODELS } from "./openrouter-llm.ts";
import { COMMAND, DOMAIN, ENV_PREFIX, NAME, PHONE_PORT, PRO_PRICE, SPOKEN_DEFAULT, spokenName } from "./name.ts";
import type { AccountRow, AccountView, SignInShown } from "./account/account.ts";
import { planFacts } from "./account/plan-words.ts";
import { PHONE_WORDS } from "./account/phone-plan.ts";
import { agreeLine } from "./terms.ts";
import { proOnSale } from "./env.ts";
import { LAST_USED, type SummaryLength } from "./settings.ts";
import { nameWarning } from "./wake.ts";
import type { NewSessionMode } from "./permission-mode.ts";
import { DEFAULT_KEY, FALLBACKS, keyWords } from "../terminals/tmux/keys.ts";
import { platform } from "../platform/index.ts";
import { SETUPS } from "../agents/setup.ts";
import type { SetupState } from "../agents/types.ts";
import type { VoiceInfo } from "../platform/types.ts";
import { keyForOption, KEYS, type KeyId, type KeyRow } from "./keys.ts";
import { shortPath } from "./text.ts";
import { LOG_DIR } from "./app-root.ts";
import { keepLogsDefault, keepLogsWords, logsSize, sizeWords, type KeepLogs } from "./log-retention.ts";
import { compareVersions } from "./updates/feed.ts";
import type { UpdateView } from "./updates/updater.ts";

/** `needsKey`: the key it needs and there isn't (core/keys.ts KeyId): picking it asks for the key first (ui/settings.ts). */
export type Choice<V = string> = { value: V; label: string; hint?: string; needsKey?: KeyId };
export type Voice = { id: string; name: string; hint?: string };

export const SAMPLE = (name: string) => `Hi, I'm ${name}. Atlas agents finished the migration and all tests pass. Want it to commit?`;

// ── Engines and models ──────────────────────────────────────────────────────

export const TTS_ENGINES: Choice<"cartesia" | "pocket" | "say">[] = [
  { value: "cartesia", label: "Cartesia", hint: "natural; about half a cent per spoken summary" },
  { value: "pocket", label: "Pocket TTS", hint: "free, runs on your Mac; first use downloads ~220 MB" },
  { value: "say", label: "macOS voice", hint: "free, built in, more robotic" },
];

export const STT_ENGINES: Choice<"deepgram" | "apple">[] = [
  { value: "deepgram", label: "Deepgram", hint: "streaming, live captions as you talk; about $0.005 a minute" },
  { value: "apple", label: "Apple, on this Mac", hint: "free and private; captions update about once a second" },
];

/** Haiku on the Anthropic API, then the OpenRouter models: each marked when its key is missing (withKeys). */
export function modelChoices(env = process.env): Choice[] {
  return withKeys(
    "llm",
    [
      { value: "haiku", label: "Claude Haiku 5.5", hint: "Anthropic API · the default with an Anthropic key" },
      ...OPENROUTER_MODELS.map((m) => ({ value: m.id, label: m.label, hint: `OpenRouter · ${m.hint}` })),
    ],
    env,
  );
}

/** The options of a voice engine, speech recognition or the model, each whose key isn't in `env` marked with it (needsKey). */
export function withKeys<V>(setting: "tts" | "stt" | "llm", choices: Choice<V>[], env = process.env): Choice<V>[] {
  return choices.map((c) => {
    const key = keyForOption(setting, c.value);
    return key && !env[key.env] ? { ...c, needsKey: key.id } : c;
  });
}

export const modelLabel = (id: string) => (id === "haiku" ? "Claude Haiku 5.5" : (OPENROUTER_MODELS.find((m) => m.id === id)?.label ?? id));

// ── Voices ──────────────────────────────────────────────────────────────────

const SKYLAR = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
export const FEATURED_CARTESIA: Voice[] = [
  { id: DEFAULT_CARTESIA_VOICE, name: "Greg", hint: "neutral, deep male · the default" },
  { id: SKYLAR, name: "Skylar", hint: "approachable American female" },
];

async function cartesiaGet(path: string): Promise<any> {
  const res = await fetch(`https://api.cartesia.ai${path}`, {
    headers: { "X-API-Key": config.cartesiaKey, "Cartesia-Version": config.cartesiaVersion },
  });
  if (!res.ok) throw new Error(`Cartesia ${res.status}`);
  return res.json();
}

const describeCartesia = (v: any): Voice => ({
  id: v.id,
  name: v.name,
  hint: [v.tagline, v.accents?.find((a: any) => a.is_native)?.accent?.replace(/-/g, " ")].filter(Boolean).join(" · "),
});

/** Cartesia's English voices, optionally one gender ("feminine", "masculine", "gender_neutral"). */
async function cartesiaVoices(gender = ""): Promise<Voice[]> {
  const voices: Voice[] = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ limit: "100", language: "en", ...(gender ? { gender } : {}) });
    if (after) query.set("starting_after", after);
    const body = await cartesiaGet(`/voices?${query}`);
    voices.push(...body.data.map(describeCartesia));
    if (!body.has_more) break;
    after = body.next_page;
  }
  return voices;
}

export async function cartesiaVoice(id: string): Promise<Voice> {
  return describeCartesia(await cartesiaGet(`/voices/${id}`));
}

/** A Pocket voice's name to show: "bill_boerst" → "Bill Boerst"; one of yours (custom:Marlo) by its file's name. */
export const pocketVoiceName = (id: string) => customVoiceName(id) ?? id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Keys ────────────────────────────────────────────────────────────────────

export const keyLabel = (name: string) =>
  name.startsWith("keycode:")
    ? `Key code ${name.slice(8)}`
    : name
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace("Fn", "fn");

const hotkeyChoices = (): Choice[] => Object.keys(platform.hotkey.keys).map((k) => ({ value: k, label: keyLabel(k) }));

export const LISTEN_MODES: Choice<"push-to-talk" | "hands-free">[] = [
  { value: "push-to-talk", label: "Push-to-talk", hint: "the key; the default" },
  {
    value: "hands-free",
    get label() {
      return `Hands-free, say “${spokenName()}”`;
    },
    hint: "the mic stays open; Apple speech on this Mac",
  },
];

export const PTT_MODES: Choice<"hold" | "tap">[] = [
  { value: "hold", label: "Hold the key while talking", hint: "works from any app" },
  { value: "tap", label: "Press to start and stop", hint: "Enter, or space in the app's screen" },
];

// ── Behaviour ───────────────────────────────────────────────────────────────

export const VOICE_CAN: Choice<"replies" | "messages" | "everything">[] = [
  { value: "replies", label: "Replies only", hint: "when a session waits for you" },
  { value: "messages", label: "Replies and messages", hint: "any session, any time" },
  { value: "everything", label: "Everything", hint: "also starts, stops and renames" },
];

/**
 * What a new session starts in when you don't name an agent (core/agent-pick.ts): the one you last
 * started a session in (the default), or one pinned: each agent Kiko can start sessions of
 * (agents/setup.ts, AgentSetup.starts), so a new adapter adds its row here with nothing else.
 */
export const newSessionChoices = (setups = SETUPS): Choice<string>[] => [
  { value: LAST_USED, label: "Last used", hint: "the default: the agent you last started one in" },
  ...setups.filter((s) => s.starts).map((s) => ({ value: s.id, label: s.name, hint: "always, unless you name another" })),
];
export const NEW_SESSION_AGENTS: Choice<string>[] = newSessionChoices();

/**
 * The permission mode a session Kiko opens starts in (core/permission-mode.ts; each agent maps it:
 * claude-code/index.ts permissionModeArgs, codex/index.ts codexModeArgs). Never bypass.
 */
export const NEW_SESSION_MODES: Choice<NewSessionMode>[] = [
  { value: "manual", label: "Ask me", hint: "asks before each edit and command" },
  { value: "acceptEdits", label: "Accept edits", hint: "the default: edits without asking, asks for the rest" },
  { value: "plan", label: "Plan", hint: "plans first, changes nothing until you say" },
  { value: "auto", label: "Auto", hint: "a classifier decides; what it blocks never reaches you as a prompt" },
  { value: "inherit", label: "Your Claude Code default", hint: "no flag: whatever your own settings say" },
];

/** How the agent marks before session names are drawn (ui/marks.ts): plain Unicode, or Nerd Font icons where an agent has one. */
export const ICONS: Choice<"unicode" | "nerd">[] = [
  { value: "unicode", label: "Off", hint: "plain marks that work in any font; the default" },
  { value: "nerd", label: "On", hint: "Claude Code's and Codex's own icons; needs Nerd Fonts 3.5 or newer" },
];

export const ANNOUNCE: Choice<"all" | "results" | "needs_you">[] = [
  { value: "all", label: "Every time" },
  { value: "results", label: "Results and questions", hint: "skips pleasantries like “sounds good”" },
  { value: "needs_you", label: "Only when Claude needs you", hint: "questions, choices, approvals" },
];

// Every length keeps what can't be left out (a question and its options, a failure, a caveat); "more"
// by voice says more of any reply.
export const SUMMARY_LENGTHS: Choice<SummaryLength>[] = [
  { value: "brief", label: "Brief", hint: "a few words" },
  { value: "short", label: "Just the gist", hint: "one short sentence" },
  { value: "normal", label: "A sentence or two" },
  { value: "detailed", label: "Detailed", hint: "the main points" },
];

export const CLASSIFIER_CONFIDENCE: Choice<number>[] = [
  { value: 0.6, label: "Less sure", hint: "faster, more wrong guesses" },
  { value: 0.75, label: "Balanced", hint: "the default" },
  { value: 0.85, label: "Very sure", hint: "Haiku checks more often, about a second slower" },
];

/** How low the volume goes while you talk, as a share of what it was. */
export const DUCK_LEVELS: Choice<number>[] = [
  { value: 0, label: "Silent" },
  { value: 10, label: "10%", hint: "barely there" },
  { value: 20, label: "20%", hint: "the default" },
  { value: 35, label: "35%" },
  { value: 50, label: "Half" },
];

/** A voice's volume in words: "+6 dB", "0 dB", "-3 dB". */
export const gainWords = (db: number) => `${db > 0 ? "+" : ""}${db} dB`;

/** A voice of yours' volume (Settings → Voice → Volume): -6 to +12 dB, 1 dB apart. */
export const VOICE_VOLUMES: Choice<number>[] = Array.from({ length: GAIN_MAX_DB - GAIN_MIN_DB + 1 }, (_, i) => {
  const db = GAIN_MIN_DB + i;
  return { value: db, label: gainWords(db), ...(db === 0 ? { hint: "as recorded" } : {}) };
});

/**
 * Settings → Voice → Volume: only with Pocket and one of your voices chosen (its file there), so
 * the built-in voices and the other engines show no such row. Its value is that voice's gain, from
 * its sidecar (<Name>.json); picked, it's written there and heard from the next thing said.
 */
export function voiceVolumeRow(tts: string, voiceId: string, dir = VOICES_DIR): SettingRow | undefined {
  if (tts !== "pocket") return undefined;
  const voice = customVoice(voiceId, dir);
  if (!voice) return undefined;
  const gain = voiceGain(voice.name, dir);
  const row: SettingRow = { key: "voiceVolume", label: "Volume", raw: gain.gainDb, value: gainWords(gain.gainDb), restart: false };
  if (gain.problem) row.note = `${shortPath(voiceSidecar(voice.name, dir))} unreadable: 0 dB`;
  return row;
}

export const ON_OFF: Choice<boolean>[] = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];

/**
 * How long the logs are kept (core/log-retention.ts), the default marked; then opening their folder
 * in Finder (`open`, not a setting), with where it is and how much it holds now.
 */
export function keepLogsChoices(dev?: boolean, size = logsSize(LOG_DIR), dir = LOG_DIR): Choice<KeepLogs | "open">[] {
  const fallback = keepLogsDefault(dev);
  return [
    ...([7, 30, 90, 0] as KeepLogs[]).map((days) => ({
      value: days,
      label: keepLogsWords(days),
      ...(days === fallback ? { hint: "the default" } : days === 0 ? { hint: "nothing deleted" } : {}),
    })),
    { value: "open" as const, label: "Open the folder in Finder", hint: `${shortPath(dir)} · ${sizeWords(size.bytes)}` },
  ];
}

export const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** Options for a duration, keeping the current value even if it isn't one of the presets. */
export function durations(presets: number[], current: number): Choice<number>[] {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return values.map((ms) => ({ value: ms, label: seconds(ms) }));
}

export const REPLY_WINDOWS = [10000, 15000, 20000, 30000];
export const FYI_WINDOWS = [3000, 4000, 6000, 10000];
const PERMISSION_WINDOWS = [10000, 20000, 30000];

/** The projects root: not set (the usual folders that exist), the one set, or one of the usual ones. */
function projectsRootChoices(current: string, home = homedir()): Choice[] {
  const usual = commonRoots(home);
  const unset: Choice = { value: "", label: "Not set", hint: usual.length ? `uses ${usual.map((p) => shortPath(p, home)).join(", ")}` : "none of ~/git, ~/code… found" };
  const all = [...new Set([current, ...usual].filter(Boolean))];
  return [unset, ...all.map((path) => ({ value: path, label: shortPath(path, home) }))];
}

/** What you call it: the name now and the default, each with a warning when it may wake it by accident. */
function spokenNameChoices(current: string): Choice[] {
  return [...new Set([current || SPOKEN_DEFAULT, SPOKEN_DEFAULT])].map((name) => ({
    value: name,
    label: name,
    hint: [name === SPOKEN_DEFAULT ? "the default" : "", nameWarning(name) ?? ""].filter(Boolean).join(" · ") || undefined,
  }));
}

/** The scratch folder: the one set, and the default. */
function scratchChoices(current: string, home = homedir()): Choice[] {
  return [...new Set([current, join(home, NAME, "scratch")])].map((path) => ({ value: path, label: shortPath(path, home) }));
}

function parsed<T>(raw: unknown, fallback: T): T {
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export { POCKET_VOICES };

// ── The settings screen ─────────────────────────────────────────────────────

/** The Phone section's rows: none, and none carried out, while the iPhone app isn't out (core/env.ts phoneLive). */
export const PHONE_KEYS: ReadonlySet<string> = new Set(["phone", "phonePair", "phoneConnect", "phonePairing", "phones"]);

/** The screen's sections, in order. */
export const SETTING_GROUPS: { title: string; keys: string[] }[] = [
  // One row per supported agent (agents/setup.ts): connect, disconnect or repair its hooks.
  { title: "Agents", keys: SETUPS.map((s) => `agent:${s.id}`) },
  // Who's signed in, and signing out (app/settings/account.ts): only while accounts are open, else no row (and no heading).
  { title: "Account", keys: ["account"] },
  // One row per key the chosen options can use (core/keys.ts keysShown): enter, check, remove.
  { title: "Keys", keys: KEYS.map((k) => `key:${k.id}`) },
  { title: "Control", keys: ["voiceCan"] },
  { title: "Voice", keys: ["tts", "voice", "voiceVolume", "pronunciation", "sounds"] },
  { title: "Listening", keys: ["spokenName", "listenMode", "replyWithoutName", "mic", "micTest", "stt", "dictionary", "sttHints", "cleanUp", "hotkey", "pttMode", "duckMusic", "duckLevel"] },
  { title: "Replies", keys: ["llm", "announce", "summaryLength", "replyWindowMs", "fyiReplyWindowMs"] },
  { title: "Permissions", keys: ["guard", "autoAllowReads", "voicePermissions", "permissionWindowMs"] },
  { title: "Decisions", keys: ["classifier", "classifierMinConfidence", "holdUnsure"] },
  { title: "New sessions", keys: ["projectsRoot", "scratchFolder", "newSessionAgent", "newSessionMode"] },
  { title: `The ${NAME} window`, keys: ["menuKey", "icons"] },
  { title: "Phone", keys: [...PHONE_KEYS] },
  // The version running, what's new, and whether new ones install by themselves (core/updates/).
  { title: "Updates", keys: ["updates", "autoUpdate"] },
  // How long the logs are kept, and where they are (core/log-retention.ts).
  { title: "Logs", keys: ["keepLogs"] },
];

/** A sentence's first letter in capitals: "the one key" → "The one key". */
export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What each setting does, beside its options: a line or two, dim (ui/settings.ts). Only what the
 * label, the value and the options' hints don't already say; a "\n" starts a line of its own (a
 * command, never broken in two). What's done with it shows where it's done: an option's hint, the
 * line said after a change, the setting's label and value rows (SETTING_FACTS).
 */
export const SETTING_ABOUT: Record<string, string> = {
  voiceCan: "What your voice may do in your sessions. Everything is the default; with the safety gate on, it still asks before anything risky.",
  tts: "What reads things out loud. Picking one without its key asks for the key.",
  voice: "The voice the engine speaks with.",
  voiceVolume: "How loud this voice of yours is. About +6 dB brings a quiet recording up to the built-in voices.",
  pronunciation: "How the voice says words it gets wrong. Only what's heard changes, never what's shown.",
  sounds: "A soft blip when the mic opens, and another when your words reach a session.",
  get spokenName() {
    return `What you call it, out loud, before what you want: “${spokenName()}, ask pixie if the tests pass”. Two syllables work best.`;
  },
  get listenMode() {
    return `Hands-free hears “${spokenName()}, …” from across the room; nothing leaves this Mac until it hears its name. Needs macOS 26 or later.`;
  },
  get replyWithoutName() {
    return `Hands-free only: while a session waits for your reply, answer it without saying “${spokenName()}” first.`;
  },
  mic: "Which mic listens, for the key and hands-free. System default follows macOS, AirPods too.\nA mic you pick stays picked; while it's away, the system default stands in.\nA Bluetooth mic in use stays on: instant, call-quality. The Mac's own mic keeps full quality.",
  micTest: "Opens the mic for 5 seconds and shows its level and what speech-to-text heard. Say a few words.",
  stt: "What turns your speech into text. Picking one without its key asks for the key.",
  dictionary: "Fixes names speech-to-text gets wrong (“snap deck” → SnapDeck). Yours win over the built-in ones, which aren't listed.",
  sttHints: "Tells speech-to-text which words to expect: your dictionary's, and your sessions' names. Deepgram: about $0.0013 a minute more.",
  cleanUp: "Leaves out the “uh”s, “um”s and false starts, and fixes the punctuation. Nothing is reworded.",
  hotkey: "The key you hold to talk, from any app.",
  duckMusic: `Turns the Mac's volume down while you talk, and back up after; not while ${NAME} speaks, or its voice would drop too.`,
  duckLevel: "As a share of where the volume was.",
  llm: `Writes the summaries, answers what you ask ${NAME}, and cleans up your messages. Picking one without its key asks for it.`,
  announce: "Which finished turns are read out. The last two need the classifier; without it, every turn is.",
  summaryLength: "How much it says about each finished turn.",
  replyWindowMs: "How long a session waits for your spoken reply after its summary.",
  fyiReplyWindowMs: "The same wait, when the agent was only reporting, not asking.",
  guard: "Asks you before a coding agent sends, deletes, pays or posts, whatever its own permission settings say. Only “allow it” allows one, once.",
  autoAllowReads:
    "Allows plain reads (ls, cat, git log, grep, with 2>/dev/null or 2>&1) in the session's folder and ~/git without asking, once each.\nAnything else asks: writes, the network, secrets, anything unusual.",
  voicePermissions: "Answer permission prompts by voice: yes, no or always.",
  permissionWindowMs: "How long a permission prompt waits for your spoken answer before the agent shows its own. Keep it short.",
  classifier: "A fast model that picks which session you mean, whether a turn is worth reading out, and how risky a tool is. Off: the main model does.",
  classifierMinConfidence: "How sure the classifier must be about who you're talking to. Below that, the main model decides, and may ask.",
  holdUnsure: `When ${NAME} had to guess the session, it says where (“To Lacy”) and waits a second: “no, clipkit” or “cancel” changes it. Off sends at once.`,
  projectsRoot: "Where your projects are: “open a session in pixie” opens the folder pixie, here or wherever Claude Code has run before.",
  scratchFolder: "A session with no known project opens in a new folder in here, named for the day and what it's for.",
  newSessionAgent: "Which agent a new session starts in when you don't name one. Naming one always wins: “start a Codex session in pixie”.",
  newSessionMode: `The permission mode a session ${NAME} opens starts in. Sessions you start yourself aren't touched.`,
  menuKey: `Opens the ${NAME} window's menu, even while you type in a session. Pressed twice, it goes to the session shown.\nIf tmux, herdr or Warp takes it first, ${NAME} uses another and asks.`,
  icons: `Claude Code's and Codex's own icons before session names, instead of plain marks. Needs Nerd Fonts 3.5 or newer:\nbrew install --cask font-symbols-only-nerd-font\nthen add to Ghostty's config:\nfont-family = "Symbols Nerd Font Mono"`,
  phone: `The ${NAME} iPhone app: hear, talk, type and answer prompts away from the desk. Only paired phones get in.`,
  phoneConnect: "What to type in the phone app when it doesn't find this Mac by itself. The Tailscale address works from anywhere.",
  get phonePair() {
    return `Scan the QR code with the iPhone's Camera or the ${NAME} app: it pairs at once. Show it only to your own phone.${proOnSale() ? "\nYour own OpenRouter key keeps the Mac free, not the phone." : ""}`;
  },
  phonePairing: "For a phone without a camera: type the code in the phone app once, and it gets its own key. Five wrong tries close it.",
  phones: "Forget one and it has to pair again; one connected now is let go at once.",
  updates: `${NAME} looks for a new version once a day. Nothing restarts under you: a new one starts the next time ${NAME} does.`,
  autoUpdate: `On: a new version downloads in the background and starts the next time ${NAME} does. Off: ${NAME} only says one is out.\n${ENV_PREFIX}UPDATES=off stops even the daily look.`,
  keepLogs: `Older logs are deleted at start and once a day. They hold what you said and what ${NAME} said and typed, so read one before sharing it.`,
  ...Object.fromEntries(SETUPS.map((s) => [`agent:${s.id}`, s.about])),
  ...Object.fromEntries(KEYS.map((k) => [`key:${k.id}`, `${capital(k.what)}.`])),
};

/**
 * A setting's label and value rows, under its about (ui/settings.ts factRows, as Settings →
 * Account's): where it's saved, how to do it by voice or in a terminal, what other agents get. The
 * row's own (SettingRow.facts: an agent's hooks file, the account) come after these.
 */
export const SETTING_FACTS: Record<string, SettingFact[]> = {
  get pronunciation() {
    return [
      { label: "By voice", value: `“${spokenName()}, say nginx as engine-x”`, more: [`“${spokenName()}, forget how to say nginx”`] },
      { label: "Saved in", value: shortPath(PRONUNCIATION_FILE) },
    ];
  },
  get dictionary() {
    return [
      { label: "By voice", value: "“add to dictionary: snap deck means SnapDeck”", more: ["with Voice can at Everything"] },
      { label: "Saved in", value: shortPath(DICTIONARY_FILE), more: ["edits there apply to your next words"] },
    ];
  },
  guard: [
    { label: "Works with", value: `Claude Code and Codex CLI, while ${NAME} is running` },
    { label: "Each kind", value: "Enter turns it off, or back on" },
  ],
  newSessionMode: [
    // Scratch sessions in auto while this is left unset (core/permission-mode.ts startModeFor); picking any value ends it.
    { label: "Scratch", value: "Auto in Claude Code until you pick a mode" },
    { label: "Codex", value: "the nearest it has: Ask me is read-only, Accept edits workspace-write, Auto its reviewer" },
    { label: "OpenCode", value: "no flag for any of them" },
  ],
  phone: [{ label: "Listens on", value: `port ${PHONE_PORT}: your Wi-Fi, and Tailscale anywhere` }],
  updates: [
    { label: `${COMMAND} update`, value: "installs the newest now" },
    { label: `${COMMAND} update --rollback`, value: "goes back one version" },
  ],
  ...Object.fromEntries(KEYS.map((k) => [`key:${k.id}`, [{ label: "In a terminal", value: `${COMMAND} keys set ${k.id}` }]])),
};

/**
 * The safety gate's options: on (every kind), off, and each kind, which Enter turns off or back on
 * (its row's `raw`, as JSON: `{ on, off }`).
 */
/** Pair a phone's offer, without Kiko Pro or the trial: the trial while it can still start, then Pro monthly and yearly. */
export function phoneOfferChoices(trial: boolean): Choice[] {
  return [
    ...(trial ? [{ value: "trial", label: PHONE_WORDS.trial }] : []),
    { value: "month", label: PHONE_WORDS.month, hint: PRO_PRICE.month },
    { value: "year", label: PHONE_WORDS.year, hint: `${PRO_PRICE.year} (${PRO_PRICE.yearSaves})` },
  ];
}

export function guardChoices(now: { on: boolean; off: string[] }): Choice[] {
  return [
    { value: "on", label: "On, for every kind", hint: "sends, deletes, pays and posts" },
    { value: "off", label: "Off", hint: "the default: agents' own settings decide" },
    ...KINDS.map((k) => {
      const asks = now.on && !now.off.includes(k);
      return { value: `kind:${k}`, label: `${asks ? "✓" : "✗"} ${KIND_INFO[k].label}: ${asks ? "asks" : "doesn't ask"}`, hint: KIND_INFO[k].covers };
    }),
  ];
}

/** An agent's row as the settings screen gets it (its `raw`, as JSON): where it stands, and the file its hooks go in. */
type AgentRow = { state: SetupState; detail: string; file: string; unreadable?: boolean; partial?: string; link?: string; nothing?: boolean };

/**
 * What can be done with an agent from its row: by where it stands (app/settings/agents.ts agentAction carries it out).
 * One reached through its own server (`link`: AgentSetup.linkWords) has nothing of its own changed.
 * One with nothing to set up (`nothing`: T3 Code) is on (automatic) or off (not connected: you said no).
 */
export function agentChoices(row: AgentRow): Choice[] {
  const leave: Choice = { value: "keep", label: "Leave it" };
  // Its file is in the pane's rows (app/settings/agents.ts agentFacts): the hints only say what's done to it.
  if (row.nothing && (row.state === "not connected" || row.state === "not installed"))
    return [
      { value: "connect", label: "Turn on", hint: row.state === "not installed" ? `${NAME} connects once it's running` : `${NAME} connects while it's running` },
      { value: "keep", label: "Leave it off" },
    ];
  const disconnect: Choice = { value: "disconnect", label: "Disconnect", hint: row.link ? `${NAME} stops listening` : `takes out only ${NAME}'s hooks, backed up first` };
  switch (row.state) {
    case "not connected":
      return [{ value: "connect", label: "Connect", hint: row.link ? "nothing of its own changes" : `adds ${NAME}'s hooks, backed up first` }, leave];
    case "connected":
      return [...(row.partial ? [{ value: "connect", label: "Add the rest", hint: row.partial }] : []), disconnect, { value: "keep", label: "Keep it" }];
    case "needs repair":
      if (row.unreadable) return [{ value: "keep", label: "Leave it", hint: "fix the file by hand first" }];
      return [{ value: "connect", label: "Repair", hint: `fixes ${NAME}'s hooks, backed up first` }, disconnect, leave];
    case "not installed":
      return [{ value: "connect", label: "Connect anyway", hint: row.link ? "for when it's installed" : `adds ${NAME}'s hooks, for when it's installed` }, leave];
    case "automatic":
      return [
        { value: "keep", label: "Keep it on", hint: row.detail },
        { value: "disconnect", label: "Turn off", hint: `${NAME} leaves it alone, none of its threads listed` },
      ];
  }
}

// Fetched once per run: moving through the settings shouldn't refetch them.
let cartesiaCatalogue: Promise<Voice[]> | undefined;
let macCatalogue: VoiceInfo[] | undefined;

export type ChoiceSet = {
  choices: Choice<unknown>[];
  apiKey?: string; // a key's row: offer "enter a key", typed hidden (the provider's name)
  test?: boolean; // the mic test: enter runs it
  dictionary?: boolean; // the entries: offer "add a word", enter edits one, d removes it
  pronunciation?: boolean; // the entries: offer "add a word", d removes one, tab says it
  searchable?: boolean; // long list: type to filter
  previewable?: boolean; // voices: Tab plays a sample
  capture?: boolean; // offer "press the key you want"
  path?: boolean; // offer "type a path"
  name?: boolean; // offer "type a name"
  escape?: unknown; // Esc picks this (Settings → Account's sign-in: stop), staying on the setting
};

/** The options for one setting. `tts` is the voice engine the voice list is for. */
export async function choicesFor(key: string, ctx: { tts: string; current: unknown; currentLabel?: string; micDevices?: MicDevice[]; mic?: MicChoice }): Promise<ChoiceSet> {
  switch (key) {
    case "tts":
      return { choices: withKeys("tts", TTS_ENGINES) };
    case "voice": {
      if (ctx.tts === "pocket") {
        // The built-in voices, then yours (the files in voices/ next to the settings: pocket-voices.ts).
        const builtIn = POCKET_VOICES.map((v) => ({ value: v.id as string, label: v.label }));
        const yours = customVoices().map((v) => ({ value: v.id, label: v.name, hint: "custom" }));
        return { choices: [...builtIn, ...yours], previewable: true };
      }
      if (ctx.tts === "say") {
        macCatalogue ??= platform.voice.voices();
        const voices = macCatalogue.map((v) => ({ value: v.name, label: v.name, hint: v.locale }));
        return { choices: [{ value: "", label: "System default" }, ...voices], searchable: true, previewable: true };
      }
      const featured = FEATURED_CARTESIA.map((v) => ({ value: v.id, label: v.name, hint: v.hint }));
      const current = String(ctx.current ?? "");
      const extra = current && !FEATURED_CARTESIA.some((v) => v.id === current) ? [{ value: current, label: ctx.currentLabel ?? "Your current voice" }] : [];
      let more: Choice<unknown>[] = [];
      try {
        cartesiaCatalogue ??= cartesiaVoices().catch((err) => {
          cartesiaCatalogue = undefined; // try again next time
          throw err;
        });
        more = (await cartesiaCatalogue).filter((v) => !FEATURED_CARTESIA.some((f) => f.id === v.id) && v.id !== current).map((v) => ({ value: v.id, label: v.name, hint: v.hint }));
      } catch {
        // offline or no key: the featured voices still work
      }
      return { choices: [...featured, ...extra, ...more], searchable: true, previewable: true };
    }
    case "voiceVolume":
      return { choices: VOICE_VOLUMES };
    case "stt":
      return { choices: withKeys("stt", STT_ENGINES) };
    case "llm":
      return { choices: modelChoices() };
    case "hotkey":
      return { choices: hotkeyChoices(), capture: true };
    case "pttMode":
      return { choices: PTT_MODES };
    case "listenMode":
      return { choices: LISTEN_MODES };
    case "mic":
      return { choices: micChoices(ctx.micDevices ?? [], ctx.mic ?? null) };
    case "micTest":
      return { choices: [{ value: "run", label: "Start the test" }], test: true };
    case "voiceCan":
      return { choices: VOICE_CAN };
    case "announce":
      return { choices: ANNOUNCE };
    case "summaryLength":
      return { choices: SUMMARY_LENGTHS };
    case "dictionary":
      return { choices: loadDictionary().map((e) => ({ value: e.heard, label: `${e.heard} → ${e.write}` })), dictionary: true };
    case "pronunciation":
      return { choices: sayingChoices(), pronunciation: true };
    case "guard":
      return { choices: guardChoices(parsed<{ on: boolean; off: string[] }>(ctx.current, { on: false, off: [] })) };
    case "sounds":
    case "sttHints":
    case "cleanUp":
    case "autoAllowReads":
    case "voicePermissions":
    case "classifier":
    case "holdUnsure":
    case "duckMusic":
    case "replyWithoutName":
      return { choices: ON_OFF };
    case "duckLevel":
      return { choices: DUCK_LEVELS };
    case "menuKey":
      return { choices: menuKeyChoices(String(ctx.current ?? "")) };
    case "icons":
      return { choices: ICONS };
    case "replyWindowMs":
      return { choices: durations(REPLY_WINDOWS, Number(ctx.current)) };
    case "fyiReplyWindowMs":
      return { choices: durations(FYI_WINDOWS, Number(ctx.current)) };
    case "permissionWindowMs":
      return { choices: durations(PERMISSION_WINDOWS, Number(ctx.current)) };
    case "classifierMinConfidence":
      return { choices: CLASSIFIER_CONFIDENCE };
    case "spokenName":
      return { choices: spokenNameChoices(String(ctx.current ?? "")), name: true };
    case "projectsRoot":
      return { choices: projectsRootChoices(String(ctx.current ?? "")), path: true };
    case "scratchFolder":
      return { choices: scratchChoices(String(ctx.current)), path: true };
    case "newSessionAgent":
      return { choices: NEW_SESSION_AGENTS };
    case "newSessionMode":
      return { choices: NEW_SESSION_MODES };
    case "phone":
      return { choices: ON_OFF };
    case "account": {
      // raw: AccountRow, as JSON. Signing in: Esc stops it.
      const row = parsed<AccountRow>(ctx.current, { signedIn: false, confirming: false, phones: 0 });
      return { choices: accountChoices(row), ...(row.signing ? { escape: "stop" } : {}) };
    }
    case "updates":
      // raw: the UpdateView, as JSON.
      return { choices: updateChoices(parsed<UpdateView | null>(ctx.current, null)) };
    case "autoUpdate":
      return { choices: ON_OFF };
    case "keepLogs":
      return { choices: keepLogsChoices() };
    case "phoneConnect":
      // raw: the addresses, each with what it is.
      return { choices: parsed<Choice[]>(ctx.current, []) };
    case "phonePair": {
      // raw: "" for the QR code; without Kiko Pro or the trial (Pro on sale), the offer (app/phone.ts pairRow).
      const offer = parsed<{ offer?: boolean; trial?: boolean }>(ctx.current, {});
      if (!offer.offer) return { choices: [{ value: "open", label: "Show the QR code", hint: "5 minutes, one phone" }] };
      return { choices: phoneOfferChoices(offer.trial === true) };
    }
    case "phonePairing":
      return {
        choices: [
          { value: "open", label: "Show a new code", hint: "works for 10 minutes" },
          { value: "close", label: "Close pairing" },
        ],
      };
    case "phones": {
      // raw: the paired phones.
      const phones = parsed<Array<{ id: string; name: string; pairedAt: number; connected: boolean }>>(ctx.current, []);
      return {
        choices: [
          { value: "keep", label: "Keep them" },
          ...phones.map((p) => ({
            value: `forget:${p.id}`,
            label: `Forget ${p.name}`,
            hint: `paired ${new Date(p.pairedAt).toLocaleDateString()}${p.connected ? " · connected" : ""}`,
          })),
          ...(phones.length > 1 ? [{ value: "forget:all", label: "Forget all of them" }] : []),
        ],
      };
    }
    default:
      // An agent's row (raw: AgentRow).
      if (key.startsWith("agent:")) {
        const row = parsed<AgentRow | null>(ctx.current, null);
        return { choices: row ? agentChoices(row) : [] };
      }
      // A key's row (raw: KeyRow).
      if (key.startsWith("key:")) {
        const info = KEYS.find((k) => k.id === key.slice("key:".length));
        const row = parsed<KeyRow | null>(ctx.current, null);
        return info && row ? keyChoices(info.name, row) : { choices: [] };
      }
      return { choices: [] };
  }
}

/**
 * What signing out on this Mac does, said before it with a phone paired (Settings → Account): other
 * Macs stay signed in; the phone, while Kiko Pro is on sale (it needs the plan then:
 * account/phone-plan.ts), stops until this Mac signs in again, else only away from home.
 */
export const signOutWords = () =>
  `Other Macs stay signed in. ${proOnSale() ? "Your phone stops working until this Mac signs in again." : "Your phone loses access away from home; at home it keeps working."}`;

/**
 * Settings → Account's pane (no about text: these say it), as aligned label and value rows: who's
 * signed in, then the plan (plan-words.ts planFacts). Signed out: plainly, with Sign in below it,
 * and that your own keys need no account. Signing in there (`signIn`, app/settings/account.ts): the
 * code and the page it's typed at, then the wait, then "✓ Signed in as …" over the signed-in rows,
 * or why not. Asking "sign out anyway?" (a phone paired): what signing out does, briefly.
 */
export function accountFacts(view: AccountView, o: { ownKey: boolean; confirming: boolean; now?: number; signIn?: SignInShown | null; copied?: boolean }): SettingFact[] {
  const noAccount = "Your own keys never need an account.";
  const s = o.signIn ?? null;
  if (s?.phase === "starting") return [{ value: `Asking ${DOMAIN} for a code…` }];
  // Copy the code picked: under the code, whether it's copied (the sign-in waits on either way).
  const copied: SettingFact[] =
    o.copied === undefined
      ? []
      : o.copied
        ? [{ value: "✓ Code copied", ok: true }]
        : [{ value: "Couldn't copy the code: drag across it with Shift held (Option in iTerm2) to select it, or type it in.", warn: true }];
  // The terms signing in accepts, by the code, as kiko login says them (core/terms.ts).
  if (s?.phase === "code") return [{ label: "Your code", value: s.code, more: [`Enter opens ${s.url}; type the code there.`, agreeLine("signing in")] }, ...copied];
  if (s?.phase === "waiting") {
    const where: SettingFact = s.link
      ? { value: `Open ${s.url} on any device and type the code.` }
      : s.opened
        ? { value: "Waiting for you to approve in the browser… Esc to stop" }
        : { value: `Couldn't open a browser: open ${s.url} and type the code.`, warn: true };
    return [{ label: "Your code", value: s.code }, ...copied, where, ...(s.link || !s.opened ? [{ value: "Waiting for you to approve… Esc to stop" }] : [])];
  }
  if (view.state === "signed-out") {
    const failed: SettingFact[] = s?.phase === "failed" ? [{ value: s.said, warn: true }] : [];
    return [...failed, view.revoked ? { value: `Signed out on ${DOMAIN}.`, warn: true, more: [noAccount] } : { value: "Not signed in.", more: [noAccount] }];
  }
  const done: SettingFact[] = s?.phase === "done" ? [{ value: `✓ Signed in as ${s.email ?? "you"}`, ok: true }] : [];
  const who: SettingFact = { label: "Signed in", value: view.email ?? "on this Mac" };
  if (o.confirming) return [who, { value: "Sign out on this Mac?", warn: true, more: [signOutWords()] }];
  // Nothing on record yet (no plan, no trial): no Plan row, unless your own key runs the AI.
  if (!view.plan && !view.trial && !o.ownKey) return [...done, who];
  return [...done, who, ...planFacts(view.plan, view.trial, { ownKey: o.ownKey, now: o.now })];
}

/**
 * What can be done from Settings → Account (app/settings/account.ts accountAction): signed in, sign
 * out (with a phone paired, a second "sign out anyway" first, its pane saying what it does) or leave
 * it; not signed in, Sign in, `kiko login`'s flow in the pane: its code shown, Open the browser
 * (Enter), Copy the code or Stop; then, waiting for the approval, Copy the code or Stop (Esc too:
 * ChoiceSet.escape). Copy the code is there while the code shows, and only then.
 */
export function accountChoices(row: AccountRow): Choice[] {
  const stop: Choice = { value: "stop", label: "Stop", hint: "nothing changes" };
  const copy: Choice = { value: "copy", label: "Copy the code", hint: "to paste in the browser" };
  if (row.signing === "code") return [{ value: "open", label: "Open the browser" }, copy, stop];
  if (row.signing === "waiting") return [copy, stop];
  if (row.signing) return [stop];
  if (!row.signedIn)
    return [
      { value: "signin", label: "Sign in", hint: "in your browser, with a code" },
      { value: "keep", label: "Leave it" },
    ];
  if (row.confirming)
    return [
      { value: "signout", label: "Sign out anyway" },
      { value: "keep", label: "Stay signed in" },
    ];
  return [
    { value: "keep", label: "Leave it" },
    ...(row.billing ? [{ value: "billing", label: "Manage billing", hint: "card, invoices, cancelling · opens your browser" }] : []),
    { value: "signout", label: "Sign out on this Mac", hint: row.phones ? "asks first: a phone is paired" : "other Macs stay signed in" },
  ];
}

/**
 * What can be done from a key's row (app.ts keyAction): enter one (typed hidden, checked first),
 * remove the Keychain's; or, for one entered that couldn't be checked, save it anyway or not.
 */
export function keyChoices(name: string, row: KeyRow): ChoiceSet {
  if (!row.store) return { choices: [{ value: "keep", label: "No Keychain here", hint: "put the key in .env" }] };
  if (row.unchecked) {
    return {
      choices: [
        { value: "save", label: "Save it anyway", hint: "unchecked" },
        { value: "drop", label: "Don't save it" },
      ],
    };
  }
  return {
    choices: [...(row.inKeychain ? [{ value: "remove", label: "Remove from the Keychain" }] : []), { value: "keep", label: "Leave it" }],
    apiKey: name,
  };
}

/**
 * What can be done from Settings → Updates (app/settings/updates.ts updateAction), by where it stands: restart into
 * the version installed, install the newer one now, look again, or nothing (a development copy).
 */
export function updateChoices(view: UpdateView | null): Choice[] {
  const later: Choice = { value: "keep", label: "Leave it" };
  if (!view) return [later];
  if (view.ready) {
    const newer = compareVersions(view.ready.version, view.running) > 0;
    return [
      { value: "restart", label: `Restart now to use ${view.ready.version}`, hint: "your sessions keep running" },
      { value: "keep", label: "Later", hint: `${newer ? "it" : view.ready.version} starts the next time ${NAME} does` },
    ];
  }
  if (!view.installed) return [{ value: "keep", label: "Nothing to do", hint: "a development copy: git pull updates it" }];
  const looked = view.checkedAt ? `looked ${new Date(view.checkedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "it looks once a day";
  // kiko.sh refused this install's invite: what to do, said where Look again is.
  if (view.link && !view.available) return [{ value: "check", label: "Look again", hint: view.link.why }, later];
  if (view.available) {
    return [
      { value: "install", label: `Install ${view.available.version} now`, hint: `downloaded and checked here; it starts the next time ${NAME} does` },
      { value: "check", label: "Look again", hint: looked },
      later,
    ];
  }
  return [{ value: "check", label: "Look for a new version now", hint: looked }, later];
}

/** The Kiko key's choices: the default and the usual others, and the one set (by hand, say) when it's none of them. */
function menuKeyChoices(current: string): Choice[] {
  const keys = [DEFAULT_KEY, ...FALLBACKS, "C-g", "M-Space"];
  const choices: Choice[] = keys.map((k) => ({
    value: k,
    label: keyWords(k),
    ...(k === DEFAULT_KEY
      ? { hint: "the default" }
      : k === FALLBACKS[0]
        ? { hint: `what ${NAME} takes when Ctrl+Space clashes` }
        : k === "M-Space"
          ? { hint: "needs Option as Alt in your terminal" }
          : {}),
  }));
  if (current && !keys.includes(current)) choices.push({ value: current, label: keyWords(current), hint: "set by hand" });
  return choices;
}

/**
 * The pronunciation list: yours first ("yours:<i>"), then the built-in ones ("built-in:<i>"), each
 * with the voices it's for. A built-in one with an entry of yours for its word says so.
 */
export function sayingChoices(user: Pronunciation[] = loadPronunciations()): Choice[] {
  const voices = (e: Pronunciation) => (e.voices ? e.voices.map((v) => ENGINE_LABEL[v]).join(", ") : "all voices");
  const label = (e: Pronunciation) => (e.disabled ? `${e.word}: as written` : `${e.word} → ${e.say}`);
  return [
    ...user.map((e, i) => ({ value: `yours:${i}`, label: label(e), hint: `${voices(e)} · yours` })),
    ...BUILT_IN_SAYINGS.map((e, i) => ({
      value: `built-in:${i}`,
      label: label(e),
      hint: `${voices(e)} · built in${overridden(e, user) ? " · yours instead" : ""}`,
    })),
  ];
}
