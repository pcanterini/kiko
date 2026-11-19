import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { settingEnv } from "./env.ts";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { cleanSpokenName, CONFIG_FOLDER, envVar, NAME, setSpokenName, SPOKEN_DEFAULT } from "./name.ts";
import type { NewSessionMode } from "./permission-mode.ts";

const CONFIG_HOME = join(homedir(), ".config");

// Your choices from settings and first-run setup. Values in .env still win over these. The dictionary and the
// names given to sessions are kept next to it.
export const SETTINGS_FILE = envVar("SETTINGS") ?? join(CONFIG_HOME, CONFIG_FOLDER, "settings.json");

// What your voice may do: reply to a session waiting for you (and permission prompts), also send
// to any session any time, or also start, stop and rename sessions.
export type VoiceCan = "replies" | "messages" | "everything";

// How you talk to it: the push-to-talk key, or also hands-free, by saying its name.
export type ListenMode = "push-to-talk" | "hands-free";

export type Settings = Partial<{
  voiceCan: VoiceCan;
  stt: "deepgram" | "apple";
  tts: "cartesia" | "say" | "pocket";
  pocketVoice: string;
  // "haiku" (Anthropic API), or an OpenRouter model ID for the summaries and the app's own replies.
  llm: string;
  cartesiaVoice: string;
  cartesiaVoiceName: string;
  sayVoice: string;
  sayRate: string;
  hotkey: string;
  pttMode: "hold" | "tap";
  listenMode: ListenMode;
  // What you call the app, out loud (name.ts spokenName): the wake word hands-free, and the name it
  // calls itself when it speaks. Unset: name.ts SPOKEN_DEFAULT. KIKO_SPOKEN_NAME wins over it.
  spokenName: string;
  // Hands-free: words in a session's reply window are its reply without the name first.
  replyWithoutName: boolean;
  // The microphone (mic-device.ts): its Core Audio device UID, and its name to show and to find it
  // by when the UID changes (another USB port). None: the system default.
  mic: string;
  micName: string;
  // When a finished session speaks up: every turn, results and questions, or only when Claude needs you.
  announce: "all" | "results" | "needs_you";
  summaryLength: SummaryLength;
  replyWindowMs: number;
  fyiReplyWindowMs: number;
  // The folder whose subfolders are your projects (core/projects.ts); unset, the usual ones that exist (~/git, ~/code, …).
  projectsRoot: string;
  // Where a new session with no project of its own gets a fresh folder (~/Kiko/scratch).
  scratchFolder: string;
  // The agent a new session starts in when you don't name one: "last-used" (LAST_USED, the default:
  // the one you last started a session in) or an agent's id, pinned ("claude-code", "codex"). Naming
  // one ("start a Codex session") wins over it, and `kiko codex` does for its run (core/agent-pick.ts).
  newSessionAgent: string;
  // The agent the last session started from Kiko was in (its id), by any route: voice, the
  // window's picker, the phone's words, `kiko codex`. What "last used" preselects.
  lastNewSessionAgent: string;
  // The permission mode a session Kiko opens starts in (core/permission-mode.ts): "acceptEdits"
  // (the default), "manual", "plan", "auto", or "inherit" (no flag: your Claude Code default).
  // Sessions you start yourself are never touched. KIKO_NEW_SESSION_MODE wins over it.
  newSessionMode: NewSessionMode;
  // The classifier (core/classifier.ts): on unless turned off (and only with an OpenRouter key), and
  // how sure it must be of who you're talking to. Saved as jev and jevMinConfidence until
  // 2026-11-01 (loadSettings reads those).
  classifier: boolean;
  classifierMinConfidence: number;
  // The classifier model for your words (who they're for); config.classifierModel keeps the rest.
  utteranceModel: string;
  voicePermissions: boolean;
  // Kiko's safety gate (core/guard.ts): ask before anything that sends, deletes, pays or posts,
  // whatever an agent's own mode or allow rules. Off unless turned on (hooks/lib.mjs guardOn);
  // `guardOff`: kinds turned off.
  guard: boolean;
  guardOff: string[];
  // A permission prompt for a call that only reads (ls, git log, a plain curl GET) is allowed without
  // asking, once each time (core/auto-allow.ts). On unless turned off.
  autoAllowReads: boolean;
  sounds: boolean;
  // Play the voice and the cues on this Mac; off, only phones with Play on phone on hear them.
  playOnMac: boolean;
  // Lower the Mac's volume while you talk, to duckLevel percent of what it was.
  duckMusic: boolean;
  duckLevel: number;
  // Leave out "uh"s, stutters and false starts from what you say before a session reads it.
  cleanUp: boolean;
  // Tell speech-to-text the words to expect: dictionary targets, session names and folders.
  sttHints: boolean;
  // Say where a send the app wasn't sure of is going, and hold it a moment so you can change it.
  holdUnsure: boolean;
  permissionWindowMs: number;
  quickTaskModel: string;
  quickTaskTimeoutMs: number;
  quickTaskMaxTurns: number;
  // The phone server (src/remote/): off unless turned on.
  phone: boolean;
  // New versions downloaded and installed in the background (core/updates/): on unless turned off.
  // Off, Kiko only says one is out (kiko update installs it).
  autoUpdate: boolean;
  // The Kiko key, as tmux names it ("C-Space", "C-\\"): the window's menu from anywhere in it.
  // --key and KIKO_KEY win over it (terminals/tmux/keys.ts); read by `kiko`, and bound at once when changed.
  menuKey: string;
  // How each session's agent mark is drawn in the lists (ui/marks.ts): "unicode" (plain glyphs,
  // the default) or "nerd" (Nerd Font icons where the agent has one: Nerd Fonts 3.5 or newer).
  // KIKO_ICONS wins over it.
  icons: Icons;
  // What you answered when something took the Kiko key (terminals/tmux/clash.ts), by which clash
  // (clashId: "terminal:Warp:C-Space:C-\\"): "fallback" (that key from now on whenever it comes up) or
  // "own" (a key of your own, set in settings). Read by `kiko`, so the same clash isn't asked about
  // again; a key set in settings clears them.
  keyClashAnswers: Record<string, "fallback" | "own">;
  // What you answered when the first-run card offered to connect an agent (agents/setup.ts), by its
  // id: "later" (Esc), "no" (unticked), or "yes" (ticked, for one with nothing to set up: T3 Code).
  // One answered isn't offered again; connecting it in settings forgets the answer, disconnecting it
  // there keeps "no". T3 Code's "no" is also Kiko leaving it alone (agentRefused).
  agentAnswers: Record<string, "later" | "no" | "yes">;
  // The agents Kiko reaches through their own server rather than hooks (AgentSetup.linkWords:
  // OpenCode's background service), by id, once you've connected them: nothing of theirs is written.
  linkedAgents: string[];
  // Kiko's hook events each connected agent's file has been given, by its id (agents/setup.ts
  // upgradeHooks, 2026-10-30): kept when you connect one and at each start. One missing from the
  // file that's listed here was taken out (by you), so the start's upgrade doesn't put it back; one
  // that isn't is new to this Kiko, and goes in. None for an agent: its AgentSetup.hooksBefore.
  hooksKnown: Record<string, string[]>;
  // The first-run setup steps finished (core/onboarding.ts DONE_STEPS: "mic", "talkKey", "name", "hello"):
  // `kiko setup` leaves them out next time (all of them with --all).
  setupDone: string[];
  // Kiko's Terms and Privacy Policy, accepted by going on past setup's first step (core/terms.ts):
  // their version (TERMS_DATE, the effective date) and when (ISO time). Setup says them once per version.
  termsAccepted: { version: string; at: string };
  // Where the next `kiko setup` (or `kiko`) picks up: "talkKey" when Input Monitoring needed
  // the terminal app reopened first (core/onboarding.ts stepsFor). Gone once that step is behind.
  setupResume: string;
  // How many days the logs are kept (core/log-retention.ts): 7, 30 or 90, or 0 for forever.
  // Unset: 30 days for a release, forever in a development checkout.
  keepLogs: number;
  // Pocket's background download, started by first-run setup (core/pocket-prep.ts): "started", then
  // "noted" once the app has said it's ready (or that it failed).
  pocketSetup: "started" | "noted";
}>;

/**
 * How much a finished turn's summary says (summarizer.ts LENGTHS). Short and normal were the two
 * there were before 2026-10-31, and are the same now: a saved one means what it did.
 */
export type SummaryLength = "brief" | "short" | "normal" | "detailed";
const SUMMARY_LENGTH_VALUES: readonly string[] = ["brief", "short", "normal", "detailed"];
/** A saved or given Summary length; anything else (an old typo, an unknown value) is normal. */
export const summaryLengthOf = (value: string | undefined): SummaryLength => (value && SUMMARY_LENGTH_VALUES.includes(value) ? (value as SummaryLength) : "normal");

/**
 * Where scratch sessions go (config.ts scratchFolder): KIKO_SCRATCH_FOLDER, else the setting,
 * else ~/Kiko/scratch; "~" as the home folder. For the CLI too, which loads no .env.
 */
export function scratchFolderOf(saved: Settings = loadSettings()): string {
  const path = envVar("SCRATCH_FOLDER") || saved.scratchFolder || join(homedir(), NAME, "scratch");
  return path.trim().replace(/^~(?=$|\/)/, homedir());
}

export function settingsExist() {
  return existsSync(SETTINGS_FILE);
}

/**
 * The saved settings; none when there's no file. One that can't be read is set aside first
 * (core/json-file.ts: settings.json.corrupt-<time>, said by the app), never taken for empty and
 * saved over by the next remember*.
 */
export function loadSettings(): Settings {
  return renamedSettings((readJsonFile(SETTINGS_FILE) as Record<string, unknown> | undefined) ?? {});
}

/** Settings saved under a name they had before, and the name they have now. */
const RENAMED_SETTINGS: Array<[before: string, now: keyof Settings]> = [
  ["jev", "classifier"],
  ["jevMinConfidence", "classifierMinConfidence"],
];

/**
 * Saved settings with any under an old name (RENAMED_SETTINGS) moved to the new one, value kept; a
 * value under the new name wins. The file itself changes the next time settings are saved.
 */
export function renamedSettings(saved: Record<string, unknown>): Settings {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const out: Record<string, unknown> = { ...saved };
  for (const [before, now] of RENAMED_SETTINGS) {
    if (!(before in out)) continue;
    if (!(now in out)) out[now] = out[before];
    delete out[before];
  }
  return out as Settings;
}

/** All of them, in one step (core/json-file.ts): a crash or another process reading finds the old file or the new one, never half. */
export function saveSettings(settings: Settings) {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

/** Keeps your answer to a key clash (`id`: clash.ts clashId) with the rest of the settings, as they are now. */
export function rememberKeyClash(id: string, answer: "fallback" | "own") {
  const saved = loadSettings();
  saveSettings({ ...saved, keyClashAnswers: { ...saved.keyClashAnswers, [id]: answer } });
}

/** How the agent marks are drawn (Settings icons): plain Unicode glyphs, or Nerd Font icons where an agent has one. */
export type Icons = "unicode" | "nerd";

/** The "icons" setting as read (KIKO_ICONS, else the settings): "nerd" however written; anything else, or nothing, "unicode". */
export function iconsSetting(raw: unknown): Icons {
  return typeof raw === "string" && raw.trim().toLowerCase() === "nerd" ? "nerd" : "unicode";
}

/** "New sessions in" set to the agent you last started a session in (Settings newSessionAgent): the default. */
export const LAST_USED = "last-used";

/**
 * The "New sessions in" setting as read (KIKO_NEW_SESSION_AGENT, else the settings): LAST_USED
 * when it's unset, empty, or "last used" however written; otherwise the agent's id as given (one
 * pinned before "last used" existed, "claude-code" or "codex", keeps working as it was).
 */
export function newSessionSetting(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.toLowerCase().replace(/[^a-z]/g, "") === "lastused") return LAST_USED;
  return value;
}

/** Keeps the agent a session was just started in (lastNewSessionAgent) with the rest of the settings as they are now; nothing written when it's the one kept already. */
export function rememberLastAgent(id: string) {
  const saved = loadSettings();
  if (!id || saved.lastNewSessionAgent === id) return;
  saveSettings({ ...saved, lastNewSessionAgent: id });
}

/** Whether you've connected an agent Kiko reaches through its own server (linkedAgents). */
export const agentLinked = (id: string, saved: Settings = loadSettings()) => Array.isArray(saved.linkedAgents) && saved.linkedAgents.includes(id);

/** An agent connected (or, false, disconnected) in linkedAgents, with the rest of the settings as they are now; whether that changed anything. */
export function linkAgent(id: string, on: boolean): boolean {
  const saved = loadSettings();
  const had = Array.isArray(saved.linkedAgents) ? saved.linkedAgents.filter((a) => typeof a === "string") : [];
  if (had.includes(id) === on) return false;
  const linked = on ? [...had, id] : had.filter((a) => a !== id);
  const next: Settings = { ...saved, linkedAgents: linked };
  if (!linked.length) delete next.linkedAgents;
  saveSettings(next);
  return true;
}

/** `patch` saved with the rest of the settings as they are now (another writer's changes kept). */
export function rememberSettings(patch: Settings) {
  saveSettings({ ...loadSettings(), ...patch });
}

/**
 * What you call the app, kept with the rest of the settings as they are now, and set for this run
 * (name.ts setSpokenName) unless KIKO_SPOKEN_NAME decides it. The default isn't written, so it
 * follows the default if that changes. Returns the name as kept (name.ts cleanSpokenName).
 */
export function rememberSpokenName(raw: string): string {
  const name = cleanSpokenName(raw) || SPOKEN_DEFAULT;
  if (settingEnv("spokenName") === undefined) setSpokenName(name);
  const next: Settings = { ...loadSettings(), spokenName: name };
  if (name === SPOKEN_DEFAULT) delete next.spokenName;
  saveSettings(next);
  return name;
}

/** Keeps (or, with null, forgets) your answers about agents (agents/setup.ts), with the rest of the settings as they are now. */
export function rememberAgents(patch: Record<string, "later" | "no" | "yes" | null>) {
  if (!Object.keys(patch).length) return;
  const saved = loadSettings();
  const answers: Record<string, "later" | "no" | "yes"> = { ...saved.agentAnswers };
  for (const [id, answer] of Object.entries(patch)) {
    if (answer) answers[id] = answer;
    else delete answers[id];
  }
  const next: Settings = { ...saved, agentAnswers: answers };
  if (!Object.keys(answers).length) delete next.agentAnswers;
  saveSettings(next);
}

/** Whether you said no to an agent (agentAnswers): one with nothing to set up (T3 Code) is then left alone. */
export const agentRefused = (id: string): boolean => (loadSettings().agentAnswers as Record<string, unknown> | undefined)?.[id] === "no";

/** The hook events kept for each agent (hooksKnown), as far as they're lists of events. */
export function hooksKnownOf(saved: unknown): Record<string, string[]> {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  return Object.fromEntries(
    Object.entries(saved)
      .filter(([, v]) => Array.isArray(v))
      .map(([id, v]) => [id, (v as unknown[]).filter((e) => typeof e === "string")]),
  ) as Record<string, string[]>;
}

/** Keeps the hook events an agent's file has been given (hooksKnown), by its id, with the rest of the settings as they are now. */
export function rememberHooks(patch: Record<string, string[]>) {
  if (!Object.keys(patch).length) return;
  const saved = loadSettings();
  saveSettings({ ...saved, hooksKnown: { ...hooksKnownOf(saved.hooksKnown), ...patch } });
}
