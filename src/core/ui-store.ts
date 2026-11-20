// What the app shows, in one place. The app reports what happens here instead of printing, and a
// renderer draws it: the Kiko window's list and settings screen (ui/tui.ts), or plain scrolling
// text (ui/plain.ts: the faked-app harness).
import { EventEmitter } from "node:events";
import type { CardAnswer } from "../agents/setup.ts";
import type { AskQuestion } from "./ask.ts";
import type { MicDevice, MicInUse } from "./mic-device.ts";
import type { Session } from "./sessions.ts";
import type { Icons } from "./settings.ts";
import type { NewSessionMode } from "./permission-mode.ts";
import type { Qr } from "./qr.ts";
import type { KeyOfferWhy } from "./account/plan-words.ts";

export type LineKind =
  | "you" // what you said
  | "session" // what a session said, raw
  | "spoken" // what the app read out about it
  | "permission" // a session asking to use a tool
  | "voice" // the app speaking for itself
  | "task" // a quick task: what it checks, and what it found
  | "info" // routing, decisions, costs
  | "error";

/**
 * `name`: the session's name as shown (session and permission lines); `sessionId`: whose, for its
 * agent's mark and colour. `checked`: Kiko's own line ending a quick check, and what it checked
 * (the phone keeps it in Updates as "Kiko checked: …"). `phone`: what the phone shows for a line
 * of Kiko's own said here, where the Mac's words don't fit it (the window's keys: plan-words.ts KeyOffer).
 */
export type Line = { id: number; at: number; kind: LineKind; text: string; name?: string; sessionId?: string; checked?: string; phone?: string };

export type SettingKey =
  | "voiceCan"
  | "tts"
  | "voice"
  /** Settings → Voice → Volume: a voice of yours' gain, in its sidecar (core/pocket-voices.ts); only while one is chosen. */
  | "voiceVolume"
  | "pronunciation"
  | "stt"
  | "cleanUp"
  | "dictionary"
  | "sttHints"
  | "llm"
  | "hotkey"
  | "pttMode"
  | "listenMode"
  | "spokenName"
  | "replyWithoutName"
  | "mic"
  | "micTest"
  | "announce"
  | "summaryLength"
  | "sounds"
  | "duckMusic"
  | "duckLevel"
  | "replyWindowMs"
  | "fyiReplyWindowMs"
  /** The safety gate (core/guard.ts): on or off, and its kinds one by one. */
  | "guard"
  | "autoAllowReads"
  | "voicePermissions"
  | "permissionWindowMs"
  | "classifier"
  | "classifierMinConfidence"
  | "holdUnsure"
  | "projectsRoot"
  | "scratchFolder"
  | "newSessionAgent"
  | "newSessionMode"
  | "menuKey"
  | "icons"
  | "voiceGlow"
  | "phone"
  /** Settings → Phone → Pair a phone: "open" shows the pairing QR code (PairQr), "close" closes it. */
  | "phonePair"
  | "phoneConnect"
  | "phonePairing"
  | "phones"
  /** Settings → Updates (core/updates/): the version running, and what's new. */
  | "updates"
  | "autoUpdate"
  /** Settings → Logs (core/log-retention.ts): how long they're kept; "open" shows their folder. */
  | "keepLogs"
  /** Settings → Account (core/account/): who's signed in, and signing out; only while accounts are open. */
  | "account"
  /** An agent's row under Agents (agents/setup.ts): `agent:<its id>`. */
  | `agent:${string}`
  /** A key's row under Keys (core/keys.ts): `key:<its id>`. */
  | `key:${string}`;

/**
 * A label and its value in a setting's pane, aligned with the others (Settings → Account: "Signed in
 * name@example.com", "Plan  Kiko Pro · renews 3 Dec"). `warn`: the value in yellow (never the
 * label); `ok`: in green ("✓ Signed in as …"); `more`: dim lines under the value, in its column. No label: a line of its own across the pane.
 */
export type SettingFact = { label?: string; value: string; warn?: boolean; ok?: boolean; more?: string[] };

/** One line of the settings screen: what it is, its current value, and whether changing it restarts the app. */
/**
 * `note`: a line about it (yellow); `detail`: a second, quieter one under the note (dim). `tag`: a
 * short mark after the value (Pair a phone's PRO, without Kiko Pro or the trial). `facts`: the
 * pane's label and value rows instead of its about text, note and detail (Settings → Account).
 */
export type SettingRow = { key: SettingKey; label: string; value: string; raw: unknown; restart: boolean; note?: string; detail?: string; tag?: string; facts?: SettingFact[] };

// Where its window is: counting down to `until`, or held (until null) while you talk ("listening"),
// your words are dealt with ("deciding") or the app speaks; "waiting" with until null: not started yet.
export type WindowPhase = "listening" | "deciding" | "speaking" | "waiting";
// `needsName`: hands-free, someone else was talking around the app's words, so a reply without the
// name isn't taken this time (wake.ts NeedsName).
export type Waiting = { sessionId: string; name: string; kind: "reply" | "permission"; phase: WindowPhase; until: number | null; needsName?: boolean };
/**
 * `id`: this prompt's own, for an answer from the phone (src/remote/) to say which it answers.
 * `questions`: the session asks you these (Claude's multiple choice, ask.ts), `asking` the one it's on by voice.
 */
export type Permission = {
  id: string;
  sessionId: string;
  name: string;
  what: string;
  risky: boolean;
  questions?: AskQuestion[];
  asking?: number;
  /** Not a tool: its agent (Claude Code, Codex) asking whether to trust this folder before the session starts (core/trust-prompt.ts). */
  folder?: string;
  /** A trust question's (a folder's, or Codex's hooks): what trusting means, shown under it; its buttons trust or don't. */
  means?: string;
  /** Kiko's quick check asking: what it was asked to check (its `name` on the Mac says "…, for: <it>"). */
  checkFor?: string;
  /** Allowed once or not at all, no "always": a block an agent made, offered to be allowed anyway (core/block-override.ts). */
  once?: boolean;
  /** It can be allowed for good (its agent offers "don't ask again": Held.canAllowAlways): the phone shows Always. */
  canAlways?: boolean;
  /** The tool call in full (decisions.ts toolDetail: a command as written), where `what` is short; for the phone's sheet. */
  detail?: string;
};
/** Your words after key up, while the app works out where they go. */
export type Deciding = { text: string; startedAt: number };
/** Where they went (`sessionId` null for a quick task), and how long deciding took. */
type Routed = { text: string; to: string; sessionId: string | null; tookMs: number; at: number };
/**
 * Settings → Phone → Pair a phone (app/phone.ts pairPhone): turning Phone on first ("starting"), the
 * QR code shown ("showing": the symbol, the typed code beneath it, until when it works), or a phone
 * paired just now ("paired": its name), for a moment before it closes. The symbol carries the
 * one-time secret, so it lives only here, in memory, and on screen.
 */
/**
 * `plan`: Pair a phone's offer picked without Kiko Pro or the trial (app/phone-offer.ts): signing in
 * (the device code, `code`, and the page opened, `url`), starting the trial, the checkout opened, the
 * payment waited for, or why it didn't go (`line`). Once the plan is there, the QR code follows.
 */
export type PlanStep = { phase: "plan"; step: "sign-in" | "trial" | "checkout" | "waiting" | "failed"; code?: string | null; url?: string | null; opened?: boolean; line?: string };
export type PairQr = { phase: "starting" } | { phase: "showing"; qr: Qr | null; code: string | null; until: number; why?: string } | { phase: "paired"; phone: string } | PlanStep;

/**
 * Settings → Test microphone: listening for a few seconds (until `until`), then turning it into
 * text, then what it heard. `peak`: the loudest the mic got, 0–1.
 */
export type MicTest = {
  phase: "listening" | "finishing" | "done";
  until: number;
  level: number;
  peak: number;
  heard: string;
  device: string;
  error?: string;
};
/** A send the app wasn't sure of, held a moment before it goes to `to` (a session's name). */
export type Holding = { text: string; to: string; sessionId: string; startedAt: number };

export type UiState = {
  listening: boolean;
  level: number; // mic level while listening, 0–1
  interim: string; // what you're saying, live
  /**
   * The mic's name while a press waits for it to give any sound (app/talk.ts keyDown: a Bluetooth
   * mic takes seconds to): shown where the level would be, as "connecting to …". Null or absent: none.
   */
  micConnecting?: string | null;
  speaking: boolean;
  muted: boolean;
  // Play on this Mac, the setting: off, the Mac plays nothing while a phone does (macPlays says which).
  playOnMac: boolean;
  // Whether the Mac plays what's said now (app/state.ts macPlays): Play on this Mac on, or off with no phone
  // playing it (closed, in the background or locked), when the Mac stands in. False: it's silent.
  macPlays: boolean;
  // A phone's Catch me up is being said, or waits its turn (src/remote/catch-up.ts): the phone shows Stop.
  catchingUp: boolean;
  sessions: Session[];
  sessionsLoaded: boolean; // false until the first look at what's running
  targetId: string | null; // where replies go once nothing is waiting
  waiting: Waiting | null;
  permission: Permission | null;
  /**
   * The other permission prompts Kiko holds, open and waiting their turn to be asked (behind the one
   * asked, or behind a reply being read out): each session they block needs you, and the phone can
   * answer them all. Absent or empty: none.
   */
  queuedPermissions?: Permission[];
  deciding: Deciding | null;
  holding: Holding | null;
  routed: Routed | null; // cleared a moment after
  checking: { what: string; startedAt: number } | null; // a quick task running
  lines: Line[];
  lastTiming: string;
  /** Kiko's own cost this run, in dollars; null while none are shown (on the subscription: core/dollars.ts). */
  cost: number | null;
  screen: "main" | "settings";
  /** The setting the settings screen opens on (the Kiko key, from a key clash's question); null or absent: the first. */
  settingsAt?: SettingKey | null;
  /** The settings screen opened on a key's row with its paste open at once (the window's offer of your own key: addKey); absent or false: as usual. */
  settingsPaste?: boolean;
  /**
   * The plan refused Kiko's AI and the window offers your own OpenRouter key (app/key-offer.ts): its
   * key (plan-words.ts ADD_KEY_KEY) in the list and the Ctrl+Space menu opens the paste. Null or
   * absent: none (no refusal, a key saved, the plan back).
   */
  keyOffer?: { why: KeyOfferWhy; until: number | null } | null;
  settings: SettingRow[];
  restartPending: boolean; // a change that needs a restart; applied when the settings screen closes
  capturing: boolean; // waiting for you to press the new push-to-talk key
  // Hands-free: listening for the name (`on`), and what it's taking your words as while it does
  // ("name": it heard the name; "reply": a reply in a session's window, without it).
  handsFree: { on: boolean; by: "name" | "reply" | null };
  // The mic in use (mic-device.ts), for the header: null until the helper lists the devices. A
  // fallback stands in for a chosen mic that's away.
  mic: MicInUse | null;
  micDevices: MicDevice[];
  micTest: MicTest | null;
  /** Settings → Phone → Pair a phone, while it's up (it covers the settings screen); null otherwise. */
  pairQr?: PairQr | null;
  about: { voice: string; model: string; hotkey: string; pttMode: "hold" | "tap"; classifier: boolean };
  /** The talk key isn't heard (no Input Monitoring: app/talk-key.ts talkKeyBar), for the window's line and the header; null or absent: nothing to say. */
  talkKeyOff?: string | null;
  /** The microphone isn't allowed for the app the helpers run in (app/mic-permission.ts micBar), for the window's line; null or absent: nothing to say. */
  micOff?: string | null;
  /** A newer Kiko, for the header and the window's line (core/updates/updater.ts updateWords): ready (installed, starts next time) or only available; null or absent: nothing to say. */
  update?: string | null;
  /** The free trial running the AI (core/account/plan-words.ts planBadge: "trial · 6d left"), for the window's line, dim (`warn`: yellow); null or absent: nothing shown (no trial, Pro, a key of your own). */
  plan?: { text: string; warn: boolean } | null;
  /** How the agent marks before session names are drawn (the "Nerd Font icons" setting); absent: plain Unicode. */
  icons?: Icons;
  /** The voice glow in the window (the "Voice glow" setting: ui/window-glow.ts); absent or false: none. */
  voiceGlow?: boolean;
  /** macOS's Reduce motion is on (Accessibility → Display): no voice glow, whatever the setting. Absent: off. */
  reduceMotion?: boolean;
  /** The mode sessions Kiko opens start in (the "Permission mode" setting): a session in another gets a tag in the list. Absent: Accept edits. */
  newSessionMode?: NewSessionMode;
  // The app runs in the Kiko window's list (src/ui/window-glue.ts); null when it doesn't (--plain).
  window: WindowState | null;
  /** Kiko's logo over the whole window as it opens (ui/splash.ts); null or absent once it's gone, or with none. */
  splash?: Splash | null;
};

/**
 * The splash as drawn (tui.ts Splash): since when (its first frame, Date.now(): start.ts painted it
 * from then while the app loaded, ui/splash-handoff.ts), `slow` once the app has taken longer than
 * the logo ("Starting…" under it), `leaving` once it's going: drawn blank then, while the window's
 * list pane goes back from the whole window to its own size (window-zoom.ts), which takes it away
 * (null) once it has, so the list's first frame is its own. `drawn`: the frame start.ts left on the
 * screen, this long after `since`, which the TUI's first frame is.
 */
export type Splash = { since: number; slow: boolean; leaving: boolean; drawn?: number };

/**
 * The Kiko window (src/terminals/tmux/window.ts) as the app in its list sees it: the TUI draws
 * the list there (src/ui/window-list.ts), or settings, zoomed to the whole window.
 */
export type WindowState = {
  /** The pane in the window's session area when it's a session's (a session's `place.id`); null when none is shown. */
  shown: string | null;
  /** A word under the list ("I couldn't show lacy: …"); "" for none. */
  note: string;
  /**
   * What the session area shows when it isn't a session of Kiko's tmux, as a page's ID
   * (window.ts): Kiko's own page (PAGE_ID), or the session outside it whose conversation it
   * shows, read-only (sessionPage); null or absent for neither.
   */
  viewing?: string | null;
  /** The project picker (n): where a new session can start; null or absent while it's closed. */
  picker?: Picker | null;
  /** A session being renamed in the list (its right-click menu), with the name it has; null or absent for none. */
  renaming?: { sessionId: string; name: string } | null;
  /** Which agent a new session starts in, asked once its folder is picked (a popup: src/ui/agent-picker.ts); null or absent while nothing is asked. */
  agentAsk?: AgentAsk | null;
  /**
   * A paired phone was turned away because this Mac is signed out: a popup asks once (each ask its
   * own id), "Sign in" on Enter (ui/window-glue.ts, then the macSignIn action); null or absent: none.
   */
  signInAsk?: string | null;
  /** The window's look (src/terminals/tmux/classic.ts): "classic" on tmux 3.8 and later, the list a box of its own; "tiled" or absent, the older one. */
  look?: "classic" | "tiled";
  /** The keyboard in the stage, not the list (tmux's active pane, asked as the list's focus reports come: window.ts); absent or false while the list has it. */
  inStage?: boolean;
};

/**
 * The window asking which agent a new session starts in (core/agent-pick.ts): this ask's own ID
 * (its answer must carry it), where it opens as said ("clipkit"), the agents to pick from (the main
 * one first; `note`: why the one chosen is; `mark`: its agent mark as the list draws it, glyph and
 * colour, src/ui/marks.ts), and the one chosen as it opens.
 */
export type AgentAsk = { ask: string; folder: string; rows: Array<{ id: string; name: string; note?: string; mark?: { glyph: string; color?: string } }>; selected: string };

/** Where a new session can start, for the picker: the projects (newest first), and where a new project goes (null: nowhere set). */
export type Picker = { projects: Array<{ cwd: string; name: string; detail: string }>; root: string | null };
/** What was picked: a project's folder, a new project by name, or a fresh scratch folder. */
export type StartPick = { project: string } | { newProject: string } | { scratch: true };

/** A session's state as the phone, the window's list and its bottom line show it. */
export type SessionStatus = "needs_you" | "waiting" | "working" | "idle" | "starting";

/**
 * Needs you (a permission prompt or question held by Kiko, or one open in its window: the
 * agent's "blocked"; or one the app opened that has waited too long to start: its trust prompt),
 * waiting for you (your reply in its window, or it stopped on a question of its own, nothing held:
 * the agent's "waiting", a background job asking what next), working (in a turn: never only for
 * what it runs in the background, which `backgroundNote` says beside this), idle, or starting (the
 * app opened it and Claude Code hasn't started it yet: core/starting.ts).
 */
export function sessionStatus(session: Session, s: Pick<UiState, "permission" | "waiting"> & Partial<Pick<UiState, "queuedPermissions">>): SessionStatus {
  if (s.permission?.sessionId === session.sessionId || session.status === "blocked") return "needs_you";
  if (s.queuedPermissions?.some((p) => p.sessionId === session.sessionId)) return "needs_you";
  if (session.status === "starting") return "starting"; // sessions.ts STARTING (imported as a type only here)
  if ((s.waiting?.sessionId === session.sessionId && s.waiting.kind === "reply") || session.status === "waiting") return "waiting";
  return session.status === "busy" ? "working" : "idle";
}

/**
 * What a session still runs in the background (AgentSession.background), said quietly after its
 * state: "2 in background", and how long the ones flagged quiet have been ("3 in background (quiet
 * 8h)" when all are, "3 in background (1 quiet 25m)" when some are). "" for nothing. Never "working":
 * that's a turn. `short`, for the window's narrow list, where the name needs the room: "2 bg".
 */
export function backgroundNote(session: Pick<Session, "background">, short = false, now = Date.now()): string {
  const bg = session.background;
  if (!bg || !(bg.count > 0)) return "";
  const note = `${bg.count} ${short ? "bg" : "in background"}`;
  if (!bg.quiet || !bg.quietSince) return note;
  const quiet = `quiet ${span(now - bg.quietSince)}`;
  return `${note} (${bg.quiet >= bg.count ? quiet : `${bg.quiet} ${quiet}`})`;
}

/** "25m", "8h", "3d": how long, in its largest whole unit. */
function span(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/** What the window's list, its menu and the settings screen ask of the app (keys, clicks, the menu's asks). */
export type Action =
  /** The splash skipped: a key pressed while it shows, or the window closing it (tmux unzoomed it). */
  | { type: "skipSplash" }
  /**
   * The permission prompt or questions on screen answered (`id`: the Permission's, as drawn; an
   * answer to one that's no longer the one waiting, a new prompt come meanwhile, is dropped).
   */
  | { type: "allow"; always: boolean; id: string }
  /**
   * The Kiko window: show this page (a page's ID, window.ts: Kiko's PAGE_ID, or a session's
   * sessionPage) in its session area, and go there; `focus` false: only shown, the keyboard left in
   * the list (the list's own keys and clicks: a preview).
   */
  | { type: "show"; page: string; focus?: boolean }
  /** The Kiko window: the page `by` away from the one shown, in the list's order (−1 up, 1 down), round the ends. */
  | { type: "step"; by: number }
  /** The Kiko window: the page shown before the one shown now (tmux's `l`); nothing when there's none. `focus` as for show. */
  | { type: "last"; focus?: boolean }
  /** The Kiko window: the keyboard to the session side (the list's Tab). */
  | { type: "focusStage" }
  /** The Kiko window: the project picker, for a new session; and closing it. */
  | { type: "newSession" }
  /** Claude Code opened in the scratch folder for its trust prompt, once (app/starting.ts trustScratch). */
  | { type: "trustScratch" }
  /** Sign in on this Mac (Enter on the popup a phone turned away for it asks: app/settings/account.ts signInFromPrompt: Settings → Kiko account → Sign in). */
  | { type: "macSignIn" }
  | { type: "closePicker" }
  /** The Kiko window: a new session where the picker says, shown there. */
  | { type: "start"; pick: StartPick }
  /** The Kiko window: the agent picked for the new session asked about (`ask`: AgentAsk's), or null: let go (Esc). */
  | { type: "pickAgent"; ask: string; agent: string | null }
  /** The Kiko window: a session's menu (a right-click on its row, at column `x`, row `y` of the list). */
  | { type: "rowMenu"; sessionId: string; x: number; y: number }
  /** The Kiko window: renaming a session in the list (null: done with it), and the name given. */
  | { type: "renaming"; sessionId: string | null }
  | { type: "rename"; sessionId: string; name: string }
  /** The Kiko window: Escape in a session (its turn interrupted), or closing it (Claude Code ends). */
  | { type: "interrupt"; sessionId: string }
  | { type: "close"; sessionId: string }
  /** The Kiko window: the Kiko key pressed twice, so the key itself goes to the session shown. */
  | { type: "passKey"; sessionId: string }
  /** The Kiko window: hidden from this terminal (it stops showing it, tmux's detach); the app goes on. */
  | { type: "detach" }
  /** Claude's question being asked (`asking`, of the Permission `id`, as drawn): its option `option` (1 the first), as if said. */
  | { type: "answer"; option: number; id: string; asking: number }
  | { type: "deny"; id: string }
  | { type: "repeat" }
  | { type: "mute" }
  | { type: "talk" } // tap mode: start or stop talking
  | { type: "settings"; at?: SettingKey } // open the settings screen (on that setting)
  /** The window's offer (UiState keyOffer): Settings → Keys → OpenRouter, its paste open. */
  | { type: "addKey" }
  | { type: "closeSettings" }
  | { type: "set"; key: SettingKey; value: unknown; label?: string }
  /**
   * A key typed into its row under Keys (`id`: core/keys.ts KeyId): checked, then saved in the Keychain.
   * Never logged. `then`: the option picked that needed it, set once the key is saved.
   */
  | { type: "apiKey"; id: string; key: string; then?: { key: SettingKey; value: unknown; label?: string } }
  /** Your dictionary (dictionary.ts), from the settings screen. */
  | { type: "dictionary"; op: "add"; heard: string; write: string }
  | { type: "dictionary"; op: "remove"; heard: string }
  /**
   * How the voice says words (pronunciation.ts), from the settings screen: add one for the voice in
   * use, or take out (`remove`) or hear (`test`) an entry ("yours:<i>" or "built-in:<i>").
   */
  | { type: "pronunciation"; op: "add"; word: string; say: string }
  | { type: "pronunciation"; op: "remove" | "test"; id: string }
  | { type: "preview"; value: string; label: string } // play a voice sample
  | { type: "captureKey" }
  | { type: "micTest" } // open the mic a few seconds and show its level and what was heard
  /** The first-run card answered (agents/setup.ts CardAnswer): connect the ones ticked, or later. */
  | ({ type: "agents" } & CardAnswer)
  | { type: "quit" };

const MAX_LINES = 500;

class Store extends EventEmitter {
  state: UiState = {
    listening: false,
    level: 0,
    interim: "",
    micConnecting: null,
    speaking: false,
    muted: false,
    playOnMac: true,
    macPlays: true,
    catchingUp: false,
    sessions: [],
    sessionsLoaded: false,
    targetId: null,
    waiting: null,
    permission: null,
    queuedPermissions: [],
    deciding: null,
    holding: null,
    routed: null,
    checking: null,
    lines: [],
    lastTiming: "",
    cost: null,
    screen: "main",
    settings: [],
    restartPending: false,
    capturing: false,
    handsFree: { on: false, by: null },
    mic: null,
    micDevices: [],
    micTest: null,
    about: { voice: "", model: "", hotkey: "", pttMode: "hold", classifier: false },
    window: null,
  };
  private nextId = 1;

  set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }

  line(kind: LineKind, text: string, session?: { name: string; sessionId: string }, about?: { checked?: string; phone?: string }) {
    const line: Line = { id: this.nextId++, at: Date.now(), kind, text, ...session, ...(about?.checked ? { checked: about.checked } : {}), ...(about?.phone ? { phone: about.phone } : {}) };
    this.state = { ...this.state, lines: [...this.state.lines.slice(-(MAX_LINES - 1)), line] };
    this.emit("line", line);
    this.emit("change", this.state);
  }

  you = (text: string) => this.line("you", text);
  session = (session: { name: string; sessionId: string }, text: string) => this.line("session", text, session);
  /** `session`: the one it's about (the TUI doesn't show it; the phone does). */
  spoken = (text: string, session?: { name: string; sessionId: string }) => this.line("spoken", text, session);
  permission = (session: { name: string; sessionId: string }, what: string) => this.line("permission", what, session);
  /** `about.checked`: it ends a quick check, which checked this; `about.phone`: the phone's words for it (Line). */
  voice = (text: string, about?: { checked?: string; phone?: string }) => this.line("voice", text, undefined, about);
  task = (text: string) => this.line("task", text);
  info = (text: string) => this.line("info", text);
  /** A call with no key and no plan (model-route.ts NoAiError): its line once a run, not one per call. */
  private noAiShown = false;
  error = (where: string, err: unknown) => {
    if (err instanceof Error && err.name === "NoAiError") {
      if (this.noAiShown) return;
      this.noAiShown = true;
      this.line("error", err.message);
      return;
    }
    this.line("error", `[${where}] ${err instanceof Error ? err.message : String(err)}`);
  };
  /** What you're saying, live, while the key is held. */
  heard = (text: string) => {
    this.set({ interim: text });
    this.emit("interim", text);
  };
  timing = (text: string) => {
    this.set({ lastTiming: text });
    this.emit("timing", text);
  };

  act(action: Action) {
    this.emit("action", action);
  }
}

export const ui = new Store();
