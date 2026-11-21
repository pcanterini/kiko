// Routing eval cases. Each is one moment: the sessions open, what was said lately (Timeline.lines
// format), who's waiting or just spoke, the "Voice can" level, and what the user said, with what
// the app should do. The cases here are written from scratch (tagged "synthetic"), in worlds shaped
// like real use; the ones made from real speech are private (the end of this file).
//
// expect:  any one of these must match the app's first action (fields given must be equal; `text`
//          is a regex on what's sent or asked).
// mustNot: none of these may match any action the app takes.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOME, type SessionSpec, type VoiceCan } from "../support/fixtures.ts";

export type Match = {
  action?:
    | "send"
    | "ask"
    | "resend"
    | "stop"
    | "stop_ignored"
    | "rename"
    | "start"
    | "quick_task"
    | "cancel_quick"
    | "dictionary"
    | "upgrade"
    | "refused"
    | "permission"
    | "wrap_up"
    | "undo"
    | "repeat"
    | "say"
    | "ask_user"
    | "none";
  to?: string;
  via?: string;
  answer?: string;
  what?: string;
  from?: string;
  folder?: string;
  /** A new session's: the agent it starts in ("codex"; "" for the default, Claude Code). */
  agent?: string;
  /** A new session's: the app it starts in, asked of one whose sessions start there ("t3code": a T3 Code thread). */
  app?: string;
  /** A new session's: how its folder was found (exact, close, named, home, new, scratch). */
  how?: string;
  name?: RegExp;
  text?: RegExp;
  op?: "add" | "remove";
  heard?: RegExp;
  write?: RegExp;
  /** The send's session was a guess (decide's `unsure`): held a moment with "To <session>". */
  unsure?: boolean;
  /** Kiko Pro's checkout: the plan asked for ("month", "year"). */
  interval?: string;
};

export type Case = {
  id: string;
  tags: string[];
  /** Why it exists: incident time (UTC) and log file, or the gap it fills. */
  why: string;
  sessions: SessionSpec[];
  recent?: string[];
  /** A finished turn waiting for a reply. */
  waiting?: string;
  /** A permission prompt waiting for an answer. */
  permission?: { session: string; request: string };
  /** Read out moments ago; its reply window closed since. */
  justSpoke?: { session: string; secondsAgo: number };
  /** Dealt with last (the app's `target`). Defaults to where the last message went. */
  last?: string;
  /**
   * The last words sent to a session (for "never mind" and "that was for X"). Defaults to the last
   * "you → session" line. `undone`: "no, cancel that" took them back since (timeline Entry.undone).
   */
  lastSent?: { session: string; text: string; undone?: boolean } | null;
  /**
   * The app dealt with your last words itself (timeline Entry.handled): the last "you → app" line
   * was a quick check it ran, its own answer, or a session it opened.
   */
  handled?: "quick_task" | "answered" | "start";
  /** The app just asked a question. Defaults to: the last recent line is "app said: …?". */
  appAsked?: boolean;
  voiceCan?: VoiceCan;
  /**
   * The app's "which session?" question still waits (decide.ts Question): the words it asked about,
   * and the sessions it offered by the case's names. The question is the last recent line.
   */
  question?: { text: string; offered: string[]; offer?: boolean };
  /** Fix `say` with the dictionary first (tests/support/dictionary.ts MINE, and the built-in words), as the app does after speech-to-text. */
  dictionary?: boolean;
  /** Projects in ~/git with no session running, which a new session can open in by name (core/projects.ts). */
  projects?: string[];
  /** Kiko Pro on sale (DecideState.proOnSale): "upgrade" opens its checkout. Default true. */
  proOnSale?: boolean;
  say: string;
  expect: Match[];
  mustNot?: Match[];
};

// ── Shorthands ──────────────────────────────────────────────────────────────────────────────
const send = (to: string, more: Partial<Match> = {}): Match => ({ action: "send", to, ...more });
const ask = (to: string): Match => ({ action: "ask", to });
/** Words reach that session, typed as said or as a message the router wrote. */
const reach = (to: string): Match[] => [send(to), ask(to)];
/** Not a guess (named, the waiting one's reply, Jev sure): it goes at once. */
const sure = (ms: Match[]): Match[] => ms.map((m) => ({ ...m, unsure: false }));
const resend = (to: string): Match => ({ action: "resend", to });
const stop = (to?: string): Match => ({ action: "stop", ...(to ? { to } : {}) });
const ASK_USER: Match = { action: "ask_user" };
const SAY: Match = { action: "say" };
/** The app answers or says it can't, possibly ending with a question ("…want me to ask it?"). */
const SPEAK: Match[] = [{ action: "say" }, { action: "ask_user" }];
const START: Match = { action: "start" };
/** The extra-session bug: a new session in the app's own folder, or with "open a session" in its first message. */
const START_IN_APP: Match = { action: "start", folder: "claude-code-speech" };
const STARTED_WITH_REQUEST: Match = { action: "start", text: /\b(?:open|start)\b.*\bsession\b/i };
const ANY_STOP: Match = { action: "stop" };
const permission = (answer: string): Match => ({ action: "permission", answer });
/** A read-only check on the computer, from the home folder (or `folder`). */
const QUICK = (folder = HOME.split("/").pop()!): Match => ({ action: "quick_task", folder });
const ANY_QUICK: Match = { action: "quick_task" };
/** "Checking your computer is off in settings." */
const CHECK_OFF: Match[] = [
  { action: "say", text: /settings/i },
  { action: "ask_user", text: /settings/i },
  { action: "refused", what: "check" },
];
const NO_SEND: Match[] = [{ action: "send" }, { action: "ask" }];

// ── Sessions as the app listed them (names, titles, kinds from the route prompts) ───────────
// An evening: the app's own code (claude-code-speech), a video app, a checkout platform, two desktop chats.
const voice = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "claude-code-speech",
  title: "random",
  status: "busy",
  activeAgoS: 20,
  asked: "Sure, commit it.",
  said: "I committed the font change as `3c71e0b`. The volume setting and the sorting fix are still uncommitted, since you wanted to try them first.",
  ...o,
});
const clipkit = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "clipkit",
  title: "ClipKit export window jump",
  status: "idle",
  activeAgoS: 40,
  asked: "Go ahead and fix the issue in ClipKit.",
  said: "I fixed it, and it works in a fresh ClipKit build. It's not committed yet.",
  ...o,
});
const lacy = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "lacy-platform",
  title: "Saved cards in checkout",
  status: "idle",
  activeAgoS: 600,
  asked: "What shipped last on this project? Keep it short.",
  said: "The last thing shipped was the receipt email fix: worker v0.4.2 and web build 7a9d3e15.",
  ...o,
});
const twoPlusTwo = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "2 plus 2",
  desktop: true,
  status: "idle",
  activeAgoS: 7200,
  asked: "Follow-up: what about 20+20?",
  said: "Still 40. 20 + 20 = 40.",
  ...o,
});
const random = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "random",
  desktop: true,
  status: "idle",
  activeAgoS: 7200,
  asked: "Voice test number four, just reply OK.",
  said: "OK",
  ...o,
});
const EVENING = (o: { voice?: Partial<SessionSpec>; clipkit?: Partial<SessionSpec>; lacy?: Partial<SessionSpec> } = {}) => [voice(o.voice), twoPlusTwo(), lacy(o.lacy), clipkit(o.clipkit), random()];

// An afternoon, before the folders were renamed.
const atlas = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "atlas-agents",
  title: "Saved cards in checkout",
  status: "busy",
  activeAgoS: 120,
  asked: "I noticed the nightly import doesn't start on its own, so nothing gets synced.",
  said: "👍 I'll report when it's done.",
  ...o,
});
const voicePM = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "claude-code-speech",
  title: "Voice app notes and settings",
  status: "idle",
  activeAgoS: 60,
  asked: "Fine, commit the changes.",
  said: "I committed it as `b81f2c4` on `settings-page`.",
  ...o,
});
const pixie: SessionSpec = { name: "pixie", background: true, status: "blocked", activeAgoS: 0 };

// Night: claude-code-speech renamed "cloud speech" with /rename,
// and a second, unnamed claude-code-speech session Claude titled "Capital of France".
const cloudVoice = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "cloud speech",
  folder: "claude-code-speech",
  given: "cloud speech",
  title: "Voice app notes and settings",
  status: "busy",
  activeAgoS: 60,
  asked: "No, that's fine. The, uh, weather A.P.I. key is already in your environment variables, so you should have what you need.",
  said: "Yes, the weather key is there now; I confirmed it's set without printing it. The test subagent will use it, so the forecast check runs with the rest.",
  ...o,
});
const capitalOfFrance = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "capital of france",
  folder: "claude-code-speech",
  title: "Capital of France",
  status: "idle",
  activeAgoS: 780,
  asked: "What is the capital of France?",
  said: "The capital of France is Paris.",
  ...o,
});
const NIGHT = () => [cloudVoice(), lacy({ activeAgoS: 1860 }), clipkit({ activeAgoS: 1500 }), capitalOfFrance()];
const NIGHT_RECENT = [
  "you → cloud speech: No, that's fine. The, uh, weather A.P.I. key is already in your environment variables, so you should have what you need.",
  "app said (about cloud speech): In cloud speech, Claude confirmed the weather key is already in your environment and told the test agent to use it, so the forecast check will run alongside the others.",
  "you → app: What's the capital of NY?",
  "app said: Do you mean New York State? Its capital is Albany. If you had another one in mind, say so.",
  "you → app: No, I meant the capital of Spain.",
  "app said: The capital of Spain is Madrid.",
];

// ── The cases ───────────────────────────────────────────────────────────────────────────────
export const CASES: Case[] = [
  {
    id: "app-feedback-while-clipkit-waits",
    tags: ["app-words", "waiting", "synthetic"],
    why: "Synthetic: feedback about the voice app while clipkit waits for a reply. It's not clipkit's reply.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 300 }, clipkit: { status: "busy", said: "The fix is in. Want me to commit it?" } }),
    recent: ["app said (about clipkit): In clipkit, Claude fixed the export window jumping forward. Want me to commit it?"],
    waiting: "clipkit",
    last: "clipkit",
    say: "Unrelated, but the voice app's status bar says listening but never says speaking when the app is talking. Can we add that to the voice app?",
    expect: reach("claude-code-speech"),
    mustNot: [send("clipkit")],
  },
  {
    id: "just-spoke-deploy-yes",
    tags: ["just-spoke", "synthetic"],
    why: "Synthetic: lacy-platform asked 'Want me to deploy it?' and its window closed 3s ago; claude-code-speech was dealt with last. The yes is lacy's.",
    sessions: EVENING({ voice: { status: "busy", activeAgoS: 30 }, lacy: { status: "idle", activeAgoS: 5, said: "The fix is built and tests pass. Want me to deploy it?" } }),
    recent: [
      "you → claude-code-speech: Send me a link to each of those so I can click through.",
      "app said (about lacy-platform): In lacy-platform, the fix is built and the tests pass. Want me to deploy it?",
    ],
    justSpoke: { session: "lacy-platform", secondsAgo: 3 },
    last: "claude-code-speech",
    say: "Yes, go ahead and deploy.",
    expect: [send("lacy-platform")],
    mustNot: [send("claude-code-speech")],
  },
  {
    id: "just-spoke-desktop-follow-up",
    tags: ["just-spoke", "desktop", "synthetic"],
    why: "Synthetic: 2 plus 2 answered 8s ago, its window closed; a follow-up goes to it (not typed into the desktop app: the app says it couldn't send).",
    sessions: EVENING({ voice: { status: "busy" } }),
    recent: ["you → 2 plus 2: What's 3 plus 3?", "app said (about 2 plus 2): In the 2 plus 2 session, Claude said 3 plus 3 is 6."],
    justSpoke: { session: "2 plus 2", secondsAgo: 8 },
    last: "2 plus 2",
    say: "What about 6 plus 6?",
    expect: [send("2 plus 2", { via: "unreachable" })],
    mustNot: [send("claude-code-speech"), START],
  },
  {
    id: "background-waiting-reply",
    tags: ["waiting", "background", "synthetic"],
    why: "Synthetic: a background session (pixie) speaks and waits: replying is the only way to reach it.",
    sessions: [voicePM({ status: "busy" }), { ...pixie, asked: "Commit the API changes when tests pass.", said: "Tests pass. Want me to commit?" }],
    recent: ["app said (about pixie): In pixie, the tests pass. Want me to commit?"],
    waiting: "pixie",
    say: "Yes, commit it.",
    expect: [send("pixie", { via: "reply" })],
    mustNot: [send("claude-code-speech")],
  },

  // ════ Corrections: "that was for X" ═══════════════════════════════════════════════════════
  {
    id: "correction-supposed-to-go-to-atlas",
    tags: ["correction", "synthetic"],
    why: "Synthetic, phrasing from the router prompt: the last message went to claude-code-speech, meant for atlas-agents.",
    sessions: [atlas({ status: "idle" }), voicePM({ status: "busy", activeAgoS: 3 })],
    recent: ["you → claude-code-speech: Check whether the nightly import ran at 7 AM.", "app said: To claude code speech."],
    say: "That was supposed to go to atlas agents.",
    expect: [resend("atlas-agents")],
    mustNot: [send("atlas-agents"), send("claude-code-speech")],
  },
  {
    id: "correction-wrong-session-other-one",
    tags: ["correction", "synthetic"],
    why: "Synthetic: 'wrong session, send it to the other one' with two sessions: the other one is clipkit.",
    sessions: [voice({ status: "busy", activeAgoS: 2 }), clipkit({ status: "idle" })],
    recent: ["you → claude-code-speech: Bump the version and write the changelog.", "app said: To claude code speech."],
    say: "Wrong session, send it to the other one.",
    expect: [resend("clipkit"), ASK_USER],
    mustNot: [send("clipkit"), send("claude-code-speech")],
  },
  {
    id: "correction-to-desktop-session",
    tags: ["correction", "desktop", "synthetic"],
    why: "Synthetic: a sum meant for the 2 plus 2 desktop session went to claude-code-speech.",
    sessions: EVENING({ voice: { status: "busy", activeAgoS: 2 } }),
    recent: ["you → claude-code-speech: What about 50 plus 50?", "app said: To claude code speech."],
    say: "No, that was for the 2 plus 2 session.",
    expect: [resend("2 plus 2")],
    mustNot: [send("2 plus 2"), send("claude-code-speech")],
  },
  {
    id: "correction-meant-for-clipkit-not-you",
    tags: ["correction", "synthetic"],
    why: "Synthetic, with clear speech: 'I meant that for clipkit, not you.'",
    sessions: EVENING({ voice: { status: "busy", activeAgoS: 2 } }),
    recent: ["you → claude-code-speech: Cut a new development build and give me the open command.", "app said: To claude code speech."],
    say: "Sorry, I meant that for clipkit, not you.",
    expect: [resend("clipkit")],
    mustNot: [send("clipkit"), send("claude-code-speech")],
  },
  {
    id: "undo-scratch-that",
    tags: ["undo", "synthetic"],
    why: "Synthetic: 'Scratch that' right after sending to clipkit.",
    sessions: EVENING(),
    recent: ["you → clipkit: Delete the old screenshots folder.", "app said: To clipkit."],
    say: "Wait, scratch that.",
    expect: [{ action: "undo" }],
    mustNot: [{ action: "send" }, { action: "ask" }],
  },
  {
    id: "permission-words-for-another-session",
    tags: ["permission", "synthetic"],
    why: "Synthetic: a permission prompt holds the floor; words for another session are not a yes. (deliver() sends everything to the prompt: unclear is the best outcome.)",
    sessions: EVENING(),
    permission: { session: "clipkit", request: "run: git push origin main" },
    say: "Lacy platform, run the migration tests.",
    expect: [permission("unclear")],
    mustNot: [permission("allow"), permission("allow_always")],
  },

  // ════ "Voice can" levels ══════════════════════════════════════════════════════════════════
  {
    id: "replies-level-message-refused",
    tags: ["voice-can", "synthetic"],
    why: "Synthetic: at 'replies', words for a session that isn't waiting aren't typed in.",
    voiceCan: "replies",
    sessions: EVENING(),
    say: "Clipkit, bump the version to 0.4.14.",
    expect: [{ action: "refused", what: "message", to: "clipkit" }],
    mustNot: [{ action: "send" }],
  },
  {
    id: "replies-level-reply-goes",
    tags: ["voice-can", "waiting", "synthetic"],
    why: "Synthetic: at 'replies', a reply to the waiting session still goes.",
    voiceCan: "replies",
    sessions: EVENING({ clipkit: { status: "busy", said: "Want me to commit it?" } }),
    recent: ["app said (about clipkit): In clipkit, the fix is verified. Want me to commit it?"],
    waiting: "clipkit",
    say: "Yes, commit it.",
    expect: [send("clipkit", { via: "reply" })],
  },
  {
    id: "replies-level-ask-session-refused",
    tags: ["voice-can", "synthetic"],
    why: "Synthetic: at 'replies', asking a session something (ask_session) is refused like any message.",
    voiceCan: "replies",
    sessions: EVENING(),
    say: "Ask lacy platform what shipped today.",
    expect: [{ action: "refused", what: "message" }, ...SPEAK],
    mustNot: [{ action: "send" }, { action: "ask" }],
  },
  {
    id: "messages-level-stop-off",
    tags: ["voice-can", "stop", "synthetic"],
    why: "Synthetic: at 'messages' (the default), 'interrupt clipkit' can't press Escape; the app says so or passes it on.",
    voiceCan: "messages",
    sessions: EVENING({ clipkit: { status: "busy" } }),
    say: "Interrupt clipkit.",
    expect: [...SPEAK, { action: "refused", what: "stop" }, ...reach("clipkit")],
    mustNot: [ANY_STOP, send("claude-code-speech")],
  },
  {
    id: "messages-level-start-off",
    tags: ["voice-can", "new-session", "synthetic"],
    why: "Synthetic: at 'messages', asking for a new session gets 'starting sessions is off'.",
    voiceCan: "messages",
    sessions: EVENING(),
    say: "Open a new session in clipkit and have it write the changelog.",
    expect: [...SPEAK, { action: "refused", what: "start" }],
    mustNot: [START, { action: "send" }],
  },
  {
    id: "everything-start-new-session",
    tags: ["voice-can", "new-session", "synthetic"],
    why: "Synthetic: at 'everything', asking for a new session in so many words starts one.",
    voiceCan: "everything",
    sessions: EVENING(),
    say: "Open a new session in clipkit and have it write the changelog.",
    expect: [{ action: "start", folder: "clipkit", how: "exact", text: /changelog/i }],
    mustNot: [send("claude-code-speech"), STARTED_WITH_REQUEST],
  },
  {
    id: "everything-start-in-background-folder",
    tags: ["voice-can", "new-session", "background", "synthetic"],
    why: "Synthetic: 'start a session in pixie' — pixie only has a background session, so a new one is right.",
    voiceCan: "everything",
    sessions: [voicePM(), atlas(), pixie],
    say: "Start a session in pixie to look at why the API tests fail.",
    expect: [{ action: "start", folder: "pixie", how: "exact", text: /API tests/i }],
    mustNot: [send("claude-code-speech"), send("atlas-agents"), STARTED_WITH_REQUEST],
  },
  {
    id: "start-close-match",
    tags: ["new-session", "synthetic"],
    why: "Synthetic: speech-to-text writes 'Pixy' for pixie: the closest project opens (and the app says which).",
    voiceCan: "everything",
    sessions: EVENING(),
    projects: ["pixie", "tideline"],
    say: "Open a new session in Pixy.",
    expect: [{ action: "start", folder: "pixie", how: "close" }],
    mustNot: [START_IN_APP, STARTED_WITH_REQUEST],
  },
  {
    id: "start-unknown-project-scratch",
    tags: ["new-session", "synthetic"],
    why: "Synthetic: a project nobody knows ('Pixel'; pixie is too far off): a fresh scratch folder, never a real project or the app's own.",
    voiceCan: "everything",
    sessions: EVENING(),
    projects: ["pixie"],
    say: "Start a new session in Pixel.",
    expect: [{ action: "start", folder: "scratch", how: "scratch" }],
    mustNot: [START_IN_APP, { action: "start", folder: "pixie" }, STARTED_WITH_REQUEST],
  },
  {
    id: "start-no-project-scratch",
    tags: ["new-session", "synthetic"],
    why: "Synthetic: a new session with no project named: a scratch folder, with what it's for as its first message.",
    voiceCan: "everything",
    sessions: EVENING(),
    say: "Open a new session and have it sketch a tiny weather app in Python.",
    expect: [{ action: "start", folder: "scratch", how: "scratch", text: /weather/i }],
    mustNot: [START_IN_APP, STARTED_WITH_REQUEST, { action: "send" }],
  },
  {
    id: "start-with-task",
    tags: ["new-session", "synthetic"],
    why: "Synthetic: what's asked beyond opening the session is its first message, and only that.",
    voiceCan: "everything",
    sessions: EVENING(),
    projects: ["pixie"],
    say: "Open a session in pixie and fix the login bug.",
    expect: [{ action: "start", folder: "pixie", how: "exact", text: /login bug/i }],
    mustNot: [START_IN_APP, STARTED_WITH_REQUEST],
  },
  {
    id: "start-new-project",
    tags: ["new-session", "synthetic"],
    why: "Synthetic: 'make a new project called Pixel' makes pixel in the projects root and opens there.",
    voiceCan: "everything",
    sessions: EVENING(),
    projects: ["pixie"],
    say: "Make a new project called Pixel and open a session in it.",
    expect: [{ action: "start", folder: "pixel", how: "new" }],
    mustNot: [START_IN_APP, { action: "start", folder: "pixie" }, { action: "start", folder: "scratch" }],
  },
  {
    id: "everything-interrupt-clipkit",
    tags: ["voice-can", "stop", "synthetic"],
    why: "Synthetic: at 'everything', 'interrupt clipkit' is the one case for Escape: the session itself, named.",
    voiceCan: "everything",
    sessions: EVENING({ clipkit: { status: "busy" } }),
    say: "Interrupt clipkit.",
    expect: [stop("clipkit")],
    mustNot: [stop("claude-code-speech")],
  },
  {
    id: "everything-stop-background-pixie",
    tags: ["voice-can", "stop", "background", "synthetic"],
    why: "Synthetic: 'stop pixie' when pixie runs in the background: can't be stopped from here; never Escape elsewhere.",
    voiceCan: "everything",
    sessions: [voicePM({ status: "busy" }), atlas({ status: "busy" }), pixie],
    say: "Stop pixie.",
    expect: [...SPEAK, { action: "stop", to: "pixie", via: "unreachable" }],
    mustNot: [stop("claude-code-speech"), stop("atlas-agents")],
  },
  {
    id: "same-folder-ambiguous-name",
    tags: ["same-folder", "ambiguous", "synthetic"],
    why: "Synthetic: 'claude code speech, …' names the folder of two sessions; the one dealt with last gets it, or the app asks which (by title). Never the other one alone, never both.",
    sessions: [
      {
        name: "voice-settings",
        folder: "claude-code-speech",
        title: "in-app settings",
        status: "idle",
        activeAgoS: 900,
        asked: "Build the settings screen.",
        said: "The settings screen is done and typechecks.",
      },
      {
        name: "voice-main",
        folder: "claude-code-speech",
        title: "random",
        status: "idle",
        activeAgoS: 30,
        asked: "Make the session colours unique.",
        said: "The colour palette is done. Want me to commit?",
      },
      atlas({ status: "idle" }),
    ],
    recent: ["you → claude-code-speech: Make the session colours unique.", "app said (about claude-code-speech): In claude-code-speech (random), the colour palette is done. Want me to commit?"],
    last: "voice-main",
    say: "Claude code speech, commit your changes.",
    expect: [send("voice-main"), ask("voice-main"), ASK_USER],
    mustNot: [send("voice-settings"), ask("voice-settings"), send("atlas-agents"), START],
  },
  {
    id: "ask-the-other-project",
    tags: ["context", "synthetic"],
    why: "Synthetic, the router prompt's own example ('ask the other project what's next') with two terminal sessions: 'other' than the one dealt with last.",
    sessions: [voicePM({ status: "idle" }), clipkit({ status: "idle" })],
    recent: ["you → claude-code-speech: Commit the colour change.", "app said (about claude-code-speech): Committed as 3c71e0b."],
    last: "claude-code-speech",
    say: "Could you check what's next on the other project?",
    expect: [ask("clipkit")],
    mustNot: [send("claude-code-speech"), ask("claude-code-speech")],
  },
  {
    id: "app-asked-want-me-to-ask-yes",
    tags: ["app-question", "synthetic"],
    why: "Synthetic: the app offered 'Should I ask that session for its guess?'; a yes means ask clipkit.",
    sessions: EVENING({
      voice: { status: "idle", activeAgoS: 1740 },
      clipkit: { activeAgoS: 2340, said: "I wrote the crash report, the steps to reproduce it and my best guess into a notes file." },
    }),
    recent: ["you → app: What was its guess?", "app said: ClipKit's guess about the crash is in its notes file, but its last reply didn't say what it is. Should I ask that session for its guess?"],
    last: "claude-code-speech",
    say: "Yes, please.",
    expect: [ask("clipkit")],
    mustNot: [send("claude-code-speech"), send("clipkit", { text: /^yes, please\.?$/i })],
  },
  {
    id: "named-by-name-mid-sentence",
    tags: ["named", "synthetic"],
    why: "Synthetic: the renamed session by its name, mid-sentence (no shortcut phrase): Jev and the router must know 'cloud speech' is the claude-code-speech session listed under that name.",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "capital of france",
    say: "Uh, could cloud speech also check how long the router takes on average?",
    expect: reach("cloud speech"),
    mustNot: [...reach("capital of france"), ...reach("clipkit"), ...reach("lacy-platform")],
  },
  {
    id: "named-by-folder",
    tags: ["named", "synthetic"],
    why: "Synthetic: the renamed session by its folder, the only session there: 'the claude code speech one' is cloud speech.",
    sessions: [cloudVoice({ status: "idle" }), lacy({ activeAgoS: 300 }), clipkit({ activeAgoS: 30 })],
    recent: ["you → clipkit: Cut a new dev build.", "app said (about clipkit): In clipkit, the new dev build is ready."],
    last: "clipkit",
    say: "Hmm, the claude code speech one should also show the time in the header.",
    expect: reach("cloud speech"),
    mustNot: [...reach("clipkit"), ...reach("lacy-platform"), START],
  },
  {
    id: "named-unnamed-by-title",
    tags: ["named", "same-folder", "synthetic"],
    why: "Synthetic: the unnamed claude-code-speech session by Claude's title for it, at the end ('for the capital of France one'), while the renamed one in the same folder was dealt with last.",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "And what's the capital of Spain? That one's for the capital of France session.",
    expect: [send("capital of france", { text: /capital of Spain/i }), ask("capital of france")],
    mustNot: [...reach("cloud speech"), ...reach("clipkit")],
  },
  {
    id: "named-two-in-one-folder",
    tags: ["named", "same-folder", "synthetic"],
    why: "Synthetic: two claude-code-speech sessions, each renamed (cloud speech, settings work): the one named gets it, not the one dealt with last.",
    sessions: [
      cloudVoice({ status: "busy", activeAgoS: 5 }),
      {
        name: "settings work",
        folder: "claude-code-speech",
        given: "settings work",
        title: "In-app settings screen",
        status: "idle",
        activeAgoS: 400,
        asked: "Build the settings preview.",
        said: "The settings preview is half done; the voice list still needs scrolling.",
      },
      clipkit({ activeAgoS: 900 }),
    ],
    recent: ["you → cloud speech: Check the router timings.", "app said (about cloud speech): In cloud speech, Claude is checking the router timings now."],
    last: "cloud speech",
    say: "Ask the settings work session whether the voice list scrolls yet.",
    expect: reach("settings work"),
    mustNot: [...reach("cloud speech"), ...reach("clipkit")],
  },
  {
    id: "named-rename-by-name",
    tags: ["named", "rename", "voice-can", "synthetic"],
    why: "Synthetic: renaming a session by the name it already has.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "capital of france",
    say: "Rename cloud speech to voice main.",
    expect: [{ action: "rename", to: "cloud speech", name: /voice main/i }],
    mustNot: [{ action: "rename", to: "capital of france" }, { action: "send" }],
  },

  // ════ Quick tasks: a read-only `claude -p` run, at "everything" only ═════════════════════════
  {
    id: "quick-task-disk",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: a question only the computer can answer, at 'everything': a quick task from the home folder, nothing sent to a session.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "How much disk space do I have left?",
    expect: [QUICK()],
    mustNot: [...NO_SEND, START],
  },
  {
    id: "quick-task-battery",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: battery level, at 'everything'.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Uh, what's my battery at?",
    expect: [QUICK()],
    mustNot: [...NO_SEND, START],
  },
  {
    id: "quick-task-port",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: what's on a port, at 'everything': a check, from home or a session's folder.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Is anything running on port 3000?",
    expect: [ANY_QUICK],
    mustNot: [...NO_SEND, START],
  },
  {
    id: "quick-task-date-and-disk",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: the date is known (<now>) but free disk space needs a look: a quick task.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "What's today's date and how much free disk space is there?",
    expect: [QUICK()],
    mustNot: [...NO_SEND, START],
  },
  {
    id: "quick-task-git-status-project",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: a project's git status: a check in that session's folder, or the question to the session itself; never from home.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "What's the git status of clipkit? Anything uncommitted?",
    expect: [QUICK("clipkit"), ...reach("clipkit")],
    mustNot: [QUICK(), ...reach("cloud speech"), START],
  },
  {
    id: "quick-task-off-at-messages",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: the same disk question at 'messages': checking is off in settings, said so; never sent to a session instead.",
    voiceCan: "messages",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "How much disk space do I have left?",
    expect: CHECK_OFF,
    mustNot: [...NO_SEND, ANY_QUICK],
  },
  {
    id: "quick-task-off-at-replies",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: battery at 'replies': off in settings, nothing sent.",
    voiceCan: "replies",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Uh, what's my battery at?",
    expect: CHECK_OFF,
    mustNot: [...NO_SEND, ANY_QUICK],
  },
  {
    id: "quick-task-needs-changes",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: a request that changes things, not about any session's project: no quick task (it's read-only); the app says it needs a session and offers one, or starts one.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Can you delete everything in my Downloads folder that's older than a month?",
    expect: [ASK_USER, { action: "start" }],
    mustNot: [ANY_QUICK, ...NO_SEND],
  },
  {
    id: "quick-task-needs-changes-kill",
    tags: ["quick-task", "voice-can", "synthetic"],
    why: "Synthetic: killing a process is a change: no quick task.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Kill whatever's running on port 3000.",
    expect: [ASK_USER, SAY, { action: "start" }],
    mustNot: [ANY_QUICK],
  },
  {
    id: "quick-task-yes-starts-session",
    tags: ["quick-task", "new-session", "app-question", "synthetic"],
    why: "Synthetic: after a check that needed changes, the app offered a session in the scratch folder; 'yes' starts it there with the request, not in ~ (the app's own hand-off does this in code; this is the router's way, when the app's handOff isn't kept).",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: [
      ...NIGHT_RECENT,
      "you → app: Can you clear the old screenshots off my desktop?",
      "app said: Checking.",
      "app said: That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?",
    ],
    last: "cloud speech",
    say: "Yes, please.",
    expect: [{ action: "start", how: "scratch", text: /screenshot/i }],
    mustNot: [ANY_QUICK, ...NO_SEND, { action: "start", how: "home" }],
  },
  {
    id: "home-folder-asked-for",
    tags: ["new-session", "home-folder", "synthetic"],
    why: "Synthetic: starting in ~ is still there when you ask for your home folder.",
    voiceCan: "everything",
    sessions: NIGHT(),
    recent: NIGHT_RECENT,
    last: "cloud speech",
    say: "Start a new session in my home folder.",
    expect: [{ action: "start", how: "home" }],
    mustNot: [...NO_SEND],
  },
  // ════ Dictionary (src/core/dictionary.ts): fixes after speech-to-text, and "add to dictionary" ═══
  {
    id: "dictionary-clip-kit-addressed",
    tags: ["dictionary", "named", "synthetic"],
    why: "Synthetic: 'clip kit' is how speech-to-text writes clipkit; fixed by the dictionary, 'tell clipkit to …' names the session up front.",
    dictionary: true,
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Tell clip kit to cut a new version and make it available in production.",
    expect: [send("clipkit", { text: /^Cut a new version/ })],
    mustNot: [...reach("claude-code-speech"), ...reach("lacy-platform")],
  },
  {
    id: "dictionary-add-by-voice",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: 'add to dictionary: X means Y' adds the entry, spelled as meant.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Add to dictionary: ghosty means Ghostty.",
    expect: [{ action: "dictionary", op: "add", heard: /^ghosty$/i, write: /^Ghostty$/ }],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-add-misheard-means",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: speech-to-text garbles 'means' and writes the target as it heard the word ('ghosty'); the terminal app is Ghostty, or the app asks how it's spelled.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Add to the dictionary, ghosty mean ghosty, the terminal app I use.",
    expect: [{ action: "dictionary", op: "add", heard: /^ghosty$/i, write: /^Ghostty$/ }, ASK_USER],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-add-session-name",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: the target heard the old way too ('clip kit as clip kit'): it's the clipkit session's name, so that's the spelling (or the app asks).",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Uh, can you add clip kit to my dictionary as the clip kit project name?",
    expect: [{ action: "dictionary", op: "add", heard: /^clip kit$/i, write: /^clipkit$/i }, ASK_USER],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-add-spelled-out",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: the user spells the word out, as they did for Lacy on 2026-10-26 ('Lazy is L-A-C-Y').",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Add to dictionary: lazy platform means Lacy platform. Lacy is L-A-C-Y.",
    expect: [{ action: "dictionary", op: "add", heard: /^lazy platform$/i, write: /^Lacy platform$/ }],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-remove-by-voice",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: 'remove X from the dictionary' takes the entry out.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Remove ghosty from the dictionary.",
    expect: [{ action: "dictionary", op: "remove", heard: /ghost/i }],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-add-while-waiting",
    tags: ["dictionary", "voice-can", "waiting", "synthetic"],
    why: "Synthetic: clipkit waits for a reply, but 'add to dictionary' is for the app, not a reply to it (Jev would hear clipkit's name and send it there).",
    voiceCan: "everything",
    sessions: EVENING(),
    waiting: "clipkit",
    say: "Add to dictionary: click kit means clipkit.",
    expect: [{ action: "dictionary", op: "add", heard: /^click kit$/i, write: /^clipkit$/i }],
    mustNot: NO_SEND,
  },
  {
    id: "dictionary-off-below-everything",
    tags: ["dictionary", "voice-can", "synthetic"],
    why: "Synthetic: at 'replies and messages' the voice can't change the dictionary: the app says so, and it doesn't go to a session.",
    voiceCan: "messages",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Add to dictionary: ghosty means Ghostty.",
    expect: [
      { action: "refused", what: "dictionary" },
      { action: "say", text: /settings/i },
      { action: "ask_user", text: /settings/i },
    ],
    mustNot: [...NO_SEND, { action: "dictionary" }],
  },
  {
    id: "dictionary-feature-request-not-hijacked",
    tags: ["dictionary", "synthetic"],
    why: "Synthetic: a feature idea that mentions a dictionary is work for the session on this app, not a dictionary edit.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "For the voice app, could we show the dictionary words in the status line too? Don't make changes yet.",
    expect: [...reach("claude-code-speech"), ASK_USER],
    mustNot: [{ action: "dictionary" }, ...reach("clipkit"), ...reach("lacy-platform")],
  },
  {
    id: "dictionary-project-work-not-hijacked",
    tags: ["dictionary", "named", "synthetic"],
    why: "Synthetic: starts like a dictionary command ('add … to the dictionary'), but it's clipkit's own dictionary page: the router passes it on.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Add the new keyboard shortcut names to the dictionary page in clipkit.",
    expect: reach("clipkit"),
    mustNot: [{ action: "dictionary" }, ...reach("claude-code-speech")],
  },
  {
    id: "dictionary-tell-session-not-hijacked",
    tags: ["dictionary", "named", "synthetic"],
    why: "Synthetic: an instruction for clipkit that mentions a dictionary goes to clipkit as said.",
    voiceCan: "everything",
    sessions: EVENING(),
    last: "claude-code-speech",
    say: "Tell clipkit to add a spell-check dictionary to the editor.",
    expect: [send("clipkit", { text: /dictionary/i })],
    mustNot: [{ action: "dictionary" }],
  },
];

// ── Waiting wins, and the topics each session was asked about ───────────────────────────────────
// A question about an earlier topic ("what did you find out about … Linux?") while Claude speech waits
// must not go to Clipkit: the recent conversation is only about icons, and the Linux question was
// Claude speech's from half an hour before (its earlier asks).
const CLAUDE_VOICE = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "Claude speech",
  folder: "claude-code-speech",
  given: "Claude speech",
  title: "Voice app notes and settings",
  status: "busy",
  activeAgoS: 34,
  asked: "Nice ones, noted. Let me sleep on it, but could you also try icons around talking while you work, something that shows, um, a speech bubble?",
  said: "I've started a subagent on speech-bubble icons. It will draw each at menu-bar size and in dark mode, and flag any that look like other apps' icons, since a bubble is already a crowded shape in chat tools. The dictionary work is still going as well. You'll hear back on both.",
  // Its earlier asks in that log, newest first (the ones in the recent lines left out, as the app does).
  earlier: [
    { minutesAgo: 21, text: "Sure, commit it." },
    {
      minutesAgo: 22,
      text: "Okay. We also need a list for, um, the first release: the installer, uh, and a welcome screen where you choose a voice and a shortcut. Uh, and the help page too. Let's keep all of that in one document.",
    },
    { minutesAgo: 23, text: "No, leave it as it is. We can decide later." },
    { minutesAgo: 24, text: "How's the side-by-side test of the new, uh, voice going? Is it good enough to switch? It sounds clearer, right?" },
    { minutesAgo: 25, text: "So where would someone, uh, change those dictionary words? Is there a screen for it?" },
    { minutesAgo: 26, text: "And yes to the dictionary, and the, uh, spelling fixes you listed." },
    {
      minutesAgo: 27,
      text: "Hmm, maybe, but I'm not sure that's the way to go, especially if the list gets sent every time, since that adds up. Does it work like that? I had in mind more of a dictionary, uh, that replaces one word with another. Could that work as well? It's a different thing from the cleanup, of course.",
    },
    { minutesAgo: 30, text: "Uh, while you're at it, can you find out what it would take to run on Linux? Uh, not just the Mac?" },
  ],
  ...o,
});
const LACY = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "Lacy",
  folder: "lacy-platform",
  given: "Lacy",
  title: "Saved cards in checkout",
  status: "idle",
  activeAgoS: 180,
  asked: "Is anything still running here, or has the Lazy refund work shipped? A short status, please.",
  said: "Sure. It's all deployed, and I'll hold until you're ready.",
  ...o,
});
const CLIPKIT = (o: Partial<SessionSpec> = {}): SessionSpec => ({
  name: "Clipkit",
  folder: "clipkit",
  given: "Clipkit",
  title: "ClipKit export window jump",
  status: "idle",
  activeAgoS: 120,
  asked: "Where are we on the ClipKit work? Is the release in production yet? Short status, please.",
  said: "ClipKit 0.5.2 is out, and your copy should offer it on its next update check. Your unsaved changes in clipkit-docs are still there, untouched. The reporter hasn't been asked yet whether it crashes in full screen too. You could also tell them 0.5.2 should fix it.",
  ...o,
});
const NAMING_RECENT = [
  "you → app: Same thing for Clipkit, Clipkit. Call it Clipkit.",
  "app said: renamed clipkit to Clipkit",
  "app said: Renamed clipkit to Clipkit.",
  "you → app: So, uh, while you do the other things for, uh, Claude speech, can we get back to the, um, icon ideas from before?",
  "you → Claude speech: While you do the other things for Claude speech, can we get back to the icon ideas from before?",
  "app said (about Claude speech): In Claude speech, Claude went over the icon options again: it recommends the rounded K, since it reads well at menu-bar size and in dark mode, with two others as backups. Do you want one of these, or should it draw a new set?",
  "you → Claude speech: Nice ones, noted. Let me sleep on it, but could you also try icons around talking while you work, something that shows, um, a sp…",
  "app said (about Claude speech): In Claude speech, Claude has started a subagent to sketch speech-bubble icons, pick about five that read well small, and try each in dark mode and at menu-bar size. It will also flag any that look like other apps' icons, and report back along with the dictionary work.",
];
const ALL_TERMINALS = "Great. What did you find out about running on Linux and all that? Is it a lot of work or not?";

CASES.push(
  {
    id: "all-terminals-nobody-waiting",
    tags: ["topics", "synthetic"],
    why: "Synthetic: Claude speech's window closed, nothing waits; the Linux question was asked of it 30 minutes before (its 'asked before' topics), so that's where it goes.",
    sessions: [CLAUDE_VOICE({ status: "idle" }), LACY(), CLIPKIT()],
    recent: NAMING_RECENT,
    last: "Claude speech",
    say: ALL_TERMINALS,
    expect: [...reach("Claude speech"), ASK_USER],
    mustNot: [...reach("Clipkit"), ...reach("Lacy")],
  },
  {
    id: "all-terminals-after-clipkit-status",
    tags: ["topics", "synthetic"],
    why: "Synthetic: you dealt with Clipkit last (a release status), nothing waits; only Claude speech's earlier topics say the Linux work is its.",
    sessions: [CLAUDE_VOICE({ status: "idle" }), LACY(), CLIPKIT()],
    recent: [
      ...NAMING_RECENT.slice(4),
      "you → Clipkit: Where are we on the ClipKit work? Is the release in production yet? Short status, please.",
      "app said (about Clipkit): In Clipkit, Claude says 0.5.2 is out, and your copy should offer it on its next update check.",
    ],
    last: "Clipkit",
    say: ALL_TERMINALS,
    expect: [...reach("Claude speech"), ASK_USER],
    mustNot: [...reach("Clipkit"), ...reach("Lacy")],
  },
  {
    id: "waiting-what-about-lacy",
    tags: ["waiting", "named", "synthetic"],
    why: "Negative of the waiting guard: 'what about Lacy?' names another session while Claude speech waits: it's about Lacy (asked, or answered from its notes).",
    sessions: [CLAUDE_VOICE(), LACY(), CLIPKIT()],
    recent: NAMING_RECENT,
    waiting: "Claude speech",
    last: "Claude speech",
    say: "Cool. What about Lacy? Is anything still running there?",
    expect: [...sure(reach("Lacy")), ...SPEAK],
    mustNot: [...reach("Claude speech"), ...reach("Clipkit")],
  },
  {
    id: "waiting-ask-clipkit-release",
    tags: ["waiting", "named", "synthetic"],
    why: "Negative of the waiting guard: Clipkit named by name while Claude speech waits.",
    sessions: [CLAUDE_VOICE(), LACY(), CLIPKIT()],
    recent: NAMING_RECENT,
    waiting: "Claude speech",
    last: "Claude speech",
    say: "Okay. Can you check with Clipkit whether the reporter got back to us?",
    expect: [...reach("Clipkit"), ...SPEAK],
    mustNot: reach("Claude speech"),
  },
  {
    id: "waiting-names-lacy-by-folder",
    tags: ["waiting", "named", "synthetic"],
    why: "Negative of the waiting guard: Lacy named by its folder ('lacy platform') while Claude speech waits.",
    sessions: [CLAUDE_VOICE(), LACY(), CLIPKIT()],
    recent: NAMING_RECENT,
    waiting: "Claude speech",
    last: "Claude speech",
    say: "In the lacy platform, what's left before the next VM release?",
    expect: [...reach("Lacy"), ...SPEAK],
    mustNot: reach("Claude speech"),
  },
  {
    id: "waiting-names-clipkit-by-title",
    tags: ["waiting", "named", "synthetic"],
    why: "Negative of the waiting guard: Clipkit named only by words of its title ('export window') while Claude speech waits.",
    sessions: [CLAUDE_VOICE(), LACY(), CLIPKIT()],
    recent: NAMING_RECENT,
    waiting: "Claude speech",
    last: "Claude speech",
    say: "How's the export window jump fix doing? Did the reporter confirm it?",
    expect: [...reach("Clipkit"), ...SPEAK],
    mustNot: reach("Claude speech"),
  },
);

// ── Corrections and take-backs, said the ways people say them (and words that only sound like them) ──
// You just sent clipkit something meant for lacy-platform (or the waiting session is the right one).
const MISROUTED = [
  "app said (about lacy-platform): In lacy platform, Claude says the saved cards fix is ready; want it deployed to staging?",
  "you → clipkit: Yes, go ahead and deploy the saved cards fix to staging.",
];
const misrouted = (id: string, say: string, expect: Match[], more: Partial<Case> = {}): Case => ({
  id,
  tags: ["correction", "synthetic"],
  why: "Synthetic: a misroute corrected in other words than 'that was for X'.",
  sessions: EVENING(),
  recent: MISROUTED,
  say,
  expect,
  mustNot: [send("clipkit"), ask("clipkit")],
  ...more,
});
const UNDO: Match = { action: "undo" };
const ON_VOICE = [
  "you → claude-code-speech: If the app sends something to the wrong session, how do I take it back?",
  "app said (about claude-code-speech): In claude code speech, Claude says you can say never mind or that was for X; it'll add more phrasings. Anything to add?",
];
const aboutPhrases = (id: string, say: string, more: Partial<Case> = {}): Case => ({
  id,
  tags: ["undo", "waiting", "synthetic"],
  why: "Synthetic: a take-back phrase quoted as an example is a message for the session, not an undo.",
  sessions: EVENING(),
  recent: ON_VOICE,
  waiting: "claude-code-speech",
  say,
  expect: [send("claude-code-speech")],
  mustNot: [UNDO, { action: "resend" }],
  ...more,
});

CASES.push(
  misrouted("correction-oops-wrong-one", "Oops, wrong one. That was for lacy platform.", [resend("lacy-platform")]),
  misrouted("correction-not-that-one-i-meant", "Not that one, I meant lacy platform.", [resend("lacy-platform")]),
  misrouted("correction-sorry-that-was-for", "Sorry, that was for lacy platform.", [resend("lacy-platform")]),
  misrouted("correction-send-that-instead", "Send that to lacy platform instead.", [resend("lacy-platform")]),
  misrouted("correction-move-that-to", "Move that to the lacy platform one.", [resend("lacy-platform")]),
  misrouted("correction-make-that-for", "Actually, make that for lacy platform.", [resend("lacy-platform")]),
  misrouted("correction-wasnt-meant-for-clipkit", "That wasn't meant for Clipkit.", [resend("lacy-platform"), ASK_USER]),
  misrouted("correction-not-for-you", "No, no, no, hold on, that's not for you.", [UNDO, resend("lacy-platform"), ...SPEAK]),
  misrouted("correction-and-also-ask", "No, that's for lacy platform, and also ask it whether the last VM release went out.", [resend("lacy-platform")]),
  misrouted("undo-take-that-back", "Take that back.", [UNDO], { tags: ["undo", "synthetic"] }),
  misrouted("undo-undo-that", "Undo that.", [UNDO], { tags: ["undo", "synthetic"] }),
  misrouted("undo-bare-never-mind", "Never mind.", [UNDO], { tags: ["undo", "synthetic"] }),
  misrouted("undo-cancel-that", "Cancel that.", [UNDO], { tags: ["undo", "synthetic"] }),
  misrouted("undo-scratch-that-never-mind", "Scratch that, never mind.", [UNDO], { tags: ["undo", "synthetic"] }),
  misrouted("undo-ugh-never-mind-forget-it", "Ugh, never mind, forget it.", [UNDO], { tags: ["undo", "synthetic"] }),
  aboutPhrases("not-undo-phrases-like-never-mind", "Make sure we support phrases like never mind and scratch that."),
  aboutPhrases("not-undo-support-something-like-cancel-that", "Can you also support something like cancel that?"),
  aboutPhrases("not-undo-eg-scratch-that", "Add a few more, e.g. scratch that, or take that back."),
  aboutPhrases("not-redirect-phrases-like-that-was-for", "Also handle phrasings such as that was for clipkit, or I meant lacy."),
  {
    id: "not-correction-move-the-button",
    tags: ["correction", "waiting", "synthetic"],
    why: "Synthetic: 'move … to …' is work for the waiting session, not moving the last message.",
    sessions: EVENING(),
    recent: MISROUTED,
    waiting: "clipkit",
    say: "Move the button to the left.",
    expect: [send("clipkit")],
    mustNot: [{ action: "resend" }, UNDO],
  },
  {
    id: "not-undo-undo-the-last-commit",
    tags: ["undo", "waiting", "synthetic"],
    why: "Synthetic: 'undo the last commit' is work for the waiting session, not taking back what was sent.",
    sessions: EVENING(),
    recent: ON_VOICE,
    waiting: "claude-code-speech",
    say: "Undo the last commit.",
    expect: [send("claude-code-speech")],
    mustNot: [UNDO, { action: "resend" }],
  },
  {
    id: "not-correction-send-that-to-production",
    tags: ["correction", "waiting", "synthetic"],
    why: "Synthetic: 'send that to production' is a deploy for the waiting session, not a redirect.",
    sessions: EVENING(),
    recent: MISROUTED,
    waiting: "clipkit",
    say: "Send that to production.",
    expect: [send("clipkit")],
    mustNot: [{ action: "resend" }, UNDO],
  },
);
const AFTER_HEADS_UP = [
  "you → Claude speech: Okay, looks like it chose the right one that time, so it's not a bug after all. Just letting you know.",
  "app said (about Claude speech): In Claude speech, Claude says thanks for the heads up; it'll leave that case as it is.",
];
const BUSY3 = () => [CLAUDE_VOICE(), LACY({ status: "busy" }), CLIPKIT({ status: "busy" })];
const stopTo = (to: string): Match => ({ action: "stop", to });
const NO_STOP: Match[] = [{ action: "stop" }];

CASES.push(
  {
    id: "fan-out-when-asked-all",
    tags: ["one-target", "synthetic"],
    why: "Synthetic: 'ask all of them' wants every session: the router may ask several.",
    sessions: [CLAUDE_VOICE({ status: "idle" }), LACY(), CLIPKIT()],
    recent: AFTER_HEADS_UP,
    last: "Claude speech",
    say: "Ask all of them whether they have anything uncommitted.",
    expect: [{ action: "ask" }, { action: "send" }],
    mustNot: [ASK_USER],
  },
  {
    id: "fan-out-when-each-named",
    tags: ["one-target", "named", "synthetic"],
    why: "Synthetic: two sessions named: both may be asked.",
    sessions: [CLAUDE_VOICE({ status: "idle" }), LACY(), CLIPKIT()],
    recent: AFTER_HEADS_UP,
    last: "Claude speech",
    say: "Ask Lacy and Clipkit whether they have anything uncommitted.",
    expect: [...reach("Lacy"), ...reach("Clipkit")],
    mustNot: reach("Claude speech"),
  },
  {
    id: "stop-which-one-answer-name",
    tags: ["stop", "app-question", "synthetic"],
    why: "Synthetic: after 'Stop which one? Say its name.', a bare name answers it.",
    sessions: BUSY3(),
    recent: [...AFTER_HEADS_UP, "you → app: Stop that one.", "app said: Stop which one? Say its name."],
    voiceCan: "everything",
    say: "Lacy.",
    expect: [stopTo("Lacy")],
    mustNot: [stopTo("Claude speech"), stopTo("Clipkit")],
  },
  {
    id: "stop-confirm-yes",
    tags: ["stop", "app-question", "synthetic"],
    why: "Synthetic: 'Stop Lacy?' then 'Yeah, do it.' stops Lacy.",
    sessions: BUSY3(),
    recent: [...AFTER_HEADS_UP, "you → app: Stop lazy.", "app said: Stop Lacy?"],
    voiceCan: "everything",
    say: "Yeah, do it.",
    expect: [stopTo("Lacy")],
    mustNot: [stopTo("Claude speech"), stopTo("Clipkit")],
  },
  {
    id: "stop-confirm-no",
    tags: ["stop", "app-question", "synthetic"],
    why: "Synthetic: 'Stop Lacy?' then 'No.' stops nothing.",
    sessions: BUSY3(),
    recent: [...AFTER_HEADS_UP, "you → app: Stop lazy.", "app said: Stop Lacy?"],
    voiceCan: "everything",
    say: "No.",
    expect: [SAY, { action: "none" }, { action: "wrap_up" }],
    mustNot: NO_STOP,
  },
);

// ════ The app's name (src/core/wake.ts): up front it's said to the app; anywhere else it's the session on its code ════
CASES.push(
  {
    id: "name-up-front-ask-lacy",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: 'Kiko, …' says who you're talking to, like 'Hey Siri'. The name goes and the rest is routed as usual: Lacy, not the session on the app's code.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 60 } }),
    say: "Kiko, ask Lacy if it deployed.",
    expect: reach("lacy-platform"),
    mustNot: reach("claude-code-speech"),
  },
  {
    id: "name-up-front-everyone",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: 'Kiko: what's everyone doing?' is a question to the app about the sessions, which it answers itself.",
    sessions: EVENING(),
    say: "Kiko: what's everyone doing?",
    expect: SPEAK,
    mustNot: NO_SEND,
  },
  {
    id: "name-up-front-chiko-clipkit",
    tags: ["app-name", "dictionary", "synthetic"],
    why: "Synthetic: speech-to-text writes 'Chiko'; the dictionary makes it Kiko and the rest goes to clipkit, not the session on the app's code.",
    sessions: EVENING(),
    dictionary: true,
    say: "Chiko, tell clipkit to commit the fix.",
    expect: reach("clipkit"),
    mustNot: reach("claude-code-speech"),
  },
  {
    id: "name-up-front-kiku-reply",
    tags: ["app-name", "waiting", "dictionary", "synthetic"],
    why: "Synthetic: 'Kiku' (speech-to-text's spelling) up front while clipkit waits: the rest is clipkit's reply.",
    sessions: EVENING({ clipkit: { status: "busy", said: "The fix is in. Want me to commit it?" } }),
    recent: ["app said (about clipkit): In clipkit, Claude fixed the export window jumping forward. Want me to commit it?"],
    waiting: "clipkit",
    last: "clipkit",
    dictionary: true,
    say: "Kiku, yes, commit it.",
    expect: [send("clipkit")],
    mustNot: reach("claude-code-speech"),
  },
  {
    id: "name-up-front-no-comma",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: speech-to-text often leaves out the comma after the name. Still said to the app: a question about Lacy, not work for the session on the app's code.",
    sessions: EVENING(),
    say: "Kiko what's Lacy working on?",
    expect: [...SPEAK, ...reach("lacy-platform")],
    mustNot: reach("claude-code-speech"),
  },
  {
    id: "name-only",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: only the name is nothing said: nothing is sent or said.",
    sessions: EVENING(),
    say: "Kiko.",
    expect: [{ action: "none" }],
    mustNot: [...NO_SEND, SAY],
  },
  {
    id: "name-mid-tell-the-session",
    tags: ["app-name", "app-words", "synthetic"],
    why: "Synthetic: 'the Kiko session' is the session on the app's code.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 120 } }),
    say: "Tell the Kiko session to fix the bug where the caption runs off the screen.",
    expect: reach("claude-code-speech"),
    mustNot: [...reach("clipkit"), ...reach("lacy-platform")],
  },
  {
    id: "name-mid-in-the-project",
    tags: ["app-name", "app-words", "synthetic"],
    why: "Synthetic: 'in the Kiko project, …' is work for the session on the app's code.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 120 } }),
    say: "In the Kiko project, add a setting to turn the wake word off.",
    expect: reach("claude-code-speech"),
    mustNot: [...reach("clipkit"), ...reach("lacy-platform"), SAY],
  },
  {
    id: "name-app-settings-broken-while-waiting",
    tags: ["app-name", "app-words", "waiting", "synthetic"],
    why: "Synthetic: 'the Kiko app's settings screen is broken' while clipkit waits: a bug report for the session on the app's code, not clipkit's reply.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 300 }, clipkit: { status: "busy", said: "The fix is in. Want me to commit it?" } }),
    recent: ["app said (about clipkit): In clipkit, Claude fixed the export window jumping forward. Want me to commit it?"],
    waiting: "clipkit",
    last: "clipkit",
    say: "The Kiko app's settings screen is broken: the descriptions get cut off.",
    expect: reach("claude-code-speech"),
    mustNot: [send("clipkit")],
  },
  {
    id: "name-up-front-possessive",
    tags: ["app-name", "app-words", "synthetic"],
    why: "Synthetic: 'Kiko's status bar …' starts with the name, but as what the sentence is about: work for the session on the app's code.",
    sessions: EVENING({ voice: { status: "idle", activeAgoS: 120 } }),
    say: "Kiko's status bar never says speaking. Can we fix that?",
    expect: reach("claude-code-speech"),
    mustNot: [...reach("clipkit"), ...reach("lacy-platform")],
  },
);

// ── A session named like the app: "Kiko project" (src/core/sessions.ts APP_NAMED) ──────────────
// A session in the kiko folder was once listed as "Kiko", and "To Kiko, can you hear me from the
// laptop?" went into it (pass_on s2). "Kiko" up
// front is always the app now; the session is "the Kiko project" or "the Kiko session".
const APP_NAMED_SESSIONS = (): SessionSpec[] => [
  { name: "lacy", folder: "lacy-platform", given: "Lacy", title: "Saved cards in checkout", status: "idle", activeAgoS: 300 },
  {
    name: "kiko",
    folder: "kiko",
    title: "Voice app notes and settings",
    status: "idle",
    activeAgoS: 60,
    asked: "Can you make the phone's catch-up banner show again?",
    said: "Done: the banner shows whenever there's something you missed. Want me to build it for the phone?",
  },
];
CASES.push(
  {
    id: "app-named-tell-kiko",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: 'Tell Kiko …' is always the app, even with a session called Kiko: nothing goes to it.",
    sessions: APP_NAMED_SESSIONS(),
    say: "Tell Kiko I'm stepping away for lunch.",
    expect: [SAY, { action: "none" }, { action: "wrap_up" }],
    mustNot: [...reach("kiko"), ...reach("lacy")],
  },
  {
    id: "app-named-the-kiko-project",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: 'the Kiko project' is the session listed as 'Kiko project'.",
    sessions: APP_NAMED_SESSIONS(),
    say: "Tell the Kiko project to build it for the phone.",
    expect: reach("kiko"),
    mustNot: reach("lacy"),
  },
  {
    id: "app-named-the-kiko-session-question",
    tags: ["app-name", "synthetic"],
    why: "Synthetic: 'what's the Kiko session doing?' asks about the session: the app answers from the list, or asks it.",
    sessions: APP_NAMED_SESSIONS(),
    say: "What's the Kiko session working on?",
    expect: [...SPEAK, ...reach("kiko")],
    mustNot: reach("lacy"),
  },
);

// ── The app's "which session?" question, still waiting ─────────────────────────────────────
// From the phone: the router asked where a test message goes,
// and the answer was typed into Kiko instead of the message. The sessions as the route prompt
// listed them; Kiko is the session on the app's code.
const QUESTION_SESSIONS = (): SessionSpec[] => [
  {
    name: "lacy",
    folder: "lacy-platform",
    given: "Lacy",
    title: "Saved cards in checkout",
    status: "idle",
    activeAgoS: 60,
    asked: "Quick status on the Lacy work, please: what's finished, what's still open, and anything that needs me.",
    said: "Nothing else is needed for the refund flow.",
  },
  {
    name: "kiko",
    folder: "claude-code-speech",
    given: "Kiko",
    title: "Voice app notes and settings",
    status: "idle",
    activeAgoS: 60,
    asked: "The user wants to know what the two agents here are busy with. A short status of each, please: what's running and what needs them.",
    said: "Two things for you: 1. Rebuild the phone app for the new banner. 2. Restart Kiko for the volume fix.",
  },
];
const QUICK_TEST = "A quick test sent from the phone on my way to the.";
const ASKED_WHERE = {
  sessions: QUESTION_SESSIONS(),
  recent: ["you → app: A, um, quick test sent from the phone on my way to the.", "app said: I can't tell who that's for. It sounds like a phone check. Should it go to Lacy or Kiko?"],
  question: { text: QUICK_TEST, offered: ["lacy", "kiko"] },
};
const NEVER_THE_ANSWER: Match[] = [{ action: "send", text: /should go to|other one|not lacy/i }, send("lacy"), ask("lacy")];

CASES.push(
  {
    id: "question-pick-and-more",
    tags: ["app-question", "question", "synthetic"],
    why: "Synthetic: the answer picks Kiko and adds a request; both go to Kiko, the message asked about first.",
    ...ASKED_WHERE,
    say: "Kiko, and tell it to check why the message got cut off.",
    expect: [send("kiko", { text: /quick test[\s\S]*cut off/i })],
    mustNot: NEVER_THE_ANSWER,
  },
  {
    id: "question-pick-the-other-one",
    tags: ["app-question", "question", "synthetic"],
    why: "Synthetic: 'not Lacy, the other one' picks Kiko without naming it; the router reads it, and the message asked about goes there, never the answer.",
    ...ASKED_WHERE,
    say: "Not Lacy, the other one.",
    expect: [send("kiko", { text: /quick test/i }), { action: "ask", to: "kiko", text: /quick test|phone app/i }],
    mustNot: NEVER_THE_ANSWER,
  },
  {
    id: "question-moved-on",
    tags: ["app-question", "question", "synthetic"],
    why: "Synthetic: instead of answering, a new request for Lacy. It goes to Lacy as said; the message asked about doesn't ride along.",
    ...ASKED_WHERE,
    say: "Actually, tell Lacy to run the tests.",
    expect: [send("lacy", { text: /run the tests/i }), ask("lacy")],
    mustNot: [{ action: "send", text: /quick test/i }, { action: "ask", text: /quick test/i }, send("kiko"), ask("kiko")],
  },
  {
    id: "stop-a-t3-thread",
    tags: ["t3", "stop", "synthetic"],
    why: "Synthetic, T3 parity (2026-10-29): a T3 Code thread can now be stopped from Kiko (run.interrupt through T3's server). 'Stop hello from t3' is a stop of that thread, never words sent to it, never 'it's in T3 Code'.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 400, asked: "Run the tests.", said: "All tests pass." },
      {
        name: "hello from t3",
        folder: "workbench",
        given: "hello from t3",
        t3: true,
        status: "busy",
        activeAgoS: 20,
        asked: "Write a long essay about capitals.",
        said: "The capital of Germany is Berlin.",
      },
    ],
    say: "Stop hello from T3.",
    expect: [stop("hello from t3")],
    mustNot: [{ action: "send" }, { action: "ask" }, stop("kiko"), { action: "stop", via: "unreachable" }],
  },
  {
    id: "rename-a-t3-thread",
    tags: ["t3", "rename", "synthetic"],
    why: "Synthetic, T3 parity (2026-10-29): a T3 Code thread can now be renamed from Kiko (thread.metadata.update). 'Rename hello from t3 to capitals' renames it; nothing is sent to it.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 400, asked: "Run the tests.", said: "All tests pass." },
      { name: "hello from t3", folder: "workbench", given: "hello from t3", t3: true, activeAgoS: 960, asked: "What about Germany?", said: "The capital of Germany is Berlin." },
    ],
    say: "Rename hello from T3 to capitals.",
    expect: [{ action: "rename", to: "hello from t3", name: /capitals/i }],
    mustNot: [{ action: "send" }, { action: "ask" }, { action: "rename", to: "kiko" }],
  },
  {
    id: "can-the-t3-thread-be-stopped",
    tags: ["t3", "app-question-about-sessions", "synthetic"],
    why: "Synthetic, T3 parity (2026-10-29): asked whether the T3 thread can be stopped from here, the router says yes (its <sessions> line says it can be stopped and renamed), not that it's out of reach in T3 Code. Nothing is stopped: it was a question.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 400, asked: "Run the tests.", said: "All tests pass." },
      {
        name: "hello from t3",
        folder: "workbench",
        given: "hello from t3",
        t3: true,
        status: "busy",
        activeAgoS: 20,
        asked: "Write a long essay about capitals.",
        said: "The capital of Germany is Berlin.",
      },
    ],
    say: "Can you stop the T3 thread from here, or do I have to do it in T3 Code?",
    expect: [{ action: "say", text: /\b(yes|can|I can)\b/i }, { action: "ask_user", text: /\b(yes|can|want me)\b/i }, stop("hello from t3")],
    mustNot: [{ action: "say", text: /can'?t|cannot|have to do it in T3|out of reach/i }, { action: "send" }, { action: "ask" }],
  },
);

// ── An evening: addressing by name, made-up limits, misheard names ─────────────────────────────
// The sessions as the route prompts listed them: the Kiko project (on the app's code:
// in the eval that folder is claude-code-speech, sessions.ts APP_FOLDER) and a Lacy just parked.
const EVENING_30 = (o: { lacy?: Partial<SessionSpec> } = {}): SessionSpec[] => [
  {
    name: "kiko",
    folder: "claude-code-speech",
    given: "Kiko",
    title: "Voice app notes and settings",
    status: "busy",
    activeAgoS: 16,
    asked: "The menu animation doesn't matter much. Leave it.",
    said: "I moved the note into the ideas file. Still running: the export button and the dark-mode fixes.",
  },
  { name: "lacy", folder: "lacy-platform", given: "Lacy", status: "idle", activeAgoS: 14, ...o.lacy },
];
// What the router once said for itself: limits nobody gave it.
const MADE_UP: Match = { action: "say", text: /can'?t (?:read|see|access|check|look)|cannot|only works|kiko claude|started with/i };
const ASK_LACY = "What's next on this project? Give me a short status.";
const DID_YOU_MEAN_LACY: Match = { action: "ask_user", text: /did you mean lacy/i };

CASES.push(
  {
    id: "to-the-kiko-project",
    tags: ["app-name", "addressed", "synthetic"],
    why: "Synthetic: 'To the Kiko project, …' names the session listed as Kiko project up front.",
    sessions: EVENING_30(),
    say: "To the Kiko project, run the tests again.",
    expect: sure(reach("kiko")),
    mustNot: [...reach("lacy"), SAY],
  },
  {
    id: "kiko-project-up-front",
    tags: ["app-name", "addressed", "synthetic"],
    why: "Synthetic: 'Kiko project, …' up front is the session, not the app.",
    sessions: EVENING_30(),
    say: "Kiko project, what's left on the list?",
    expect: sure(reach("kiko")),
    mustNot: [...reach("lacy"), SAY],
  },
  {
    id: "to-uh-lacy-up-front",
    tags: ["addressed", "synthetic"],
    why: "Synthetic: 'To, uh, Lacy. …' says who it's for up front, with a filler between.",
    sessions: EVENING_30(),
    say: "To, uh, Lacy. What's next on the project?",
    expect: sure(reach("lacy")),
    mustNot: reach("kiko"),
  },
  {
    id: "check-my-logs-goes-to-the-project",
    tags: ["made-up-limits", "app-words", "synthetic"],
    why: "Synthetic: asked to check the logs, the router can't do it itself, so it passes it to the session on the app's code; it never says it can't read logs.",
    sessions: EVENING_30(),
    say: "Look through my logs for the last few errors.",
    expect: reach("kiko"),
    mustNot: [...reach("lacy"), MADE_UP],
  },
  {
    id: "why-didnt-it-reach-lacy",
    tags: ["made-up-limits", "app-words", "synthetic"],
    why: "Synthetic: why the app didn't reach Lacy is a question about this app's behaviour, for the session on its code, not something the router explains from guesses.",
    sessions: EVENING_30(),
    recent: ["you → app: Ask Lacy what's next.", "app said: I couldn't reach Lacy: I can't tell which terminal is Lacy, so I didn't type that in."],
    say: "Why couldn't you reach Lacy just now? Look into it.",
    expect: reach("kiko"),
    mustNot: [...reach("lacy"), MADE_UP],
  },
  {
    id: "misheard-macy",
    tags: ["misheard-name", "speech-to-text", "synthetic"],
    why: "Synthetic: 'Macy' (Lacy heard wrong) is Lacy, or asked about.",
    sessions: EVENING_30(),
    say: "Ask Macy what's next on that project.",
    expect: [ask("lacy"), send("lacy"), DID_YOU_MEAN_LACY],
    mustNot: reach("kiko"),
  },
  {
    id: "misheard-macey-tell",
    tags: ["misheard-name", "speech-to-text", "synthetic"],
    why: "Synthetic: 'Tell Macey to …' is Lacy, or asked about.",
    sessions: EVENING_30(),
    say: "Tell Macey to run the tests and tell me if anything fails.",
    expect: [send("lacy"), ask("lacy"), DID_YOU_MEAN_LACY],
    mustNot: reach("kiko"),
  },
  {
    id: "misheard-confirm-yes",
    tags: ["misheard-name", "question", "synthetic"],
    why: "Synthetic: after 'Did you mean Lacy?', 'Yeah.' sends the words kept to Lacy, without saying them again (read in code).",
    sessions: EVENING_30(),
    recent: ["you → app: Ask Macy what's next on that project.", "app said: Did you mean Lacy?"],
    question: { text: ASK_LACY, offered: ["lacy"] },
    say: "Yeah.",
    expect: [send("lacy", { text: /what's next/i })],
    mustNot: [{ action: "send", text: /^yeah/i }, ...reach("kiko")],
  },
  {
    id: "misheard-confirm-other",
    tags: ["misheard-name", "question", "synthetic"],
    why: "Synthetic: after 'Did you mean Lacy?', 'No, the Kiko project.' sends the words kept there instead.",
    sessions: EVENING_30(),
    recent: ["you → app: Ask Macy what's next on that project.", "app said: Did you mean Lacy?"],
    question: { text: ASK_LACY, offered: ["lacy"] },
    say: "No, the Kiko project.",
    expect: [send("kiko", { text: /what's next/i })],
    mustNot: reach("lacy"),
  },
  {
    id: "misheard-confirm-no",
    tags: ["misheard-name", "question", "synthetic"],
    why: "Synthetic: after 'Did you mean Lacy?', 'No.' sends nothing, and says so.",
    sessions: EVENING_30(),
    recent: ["you → app: Ask Macy what's next on that project.", "app said: Did you mean Lacy?"],
    question: { text: ASK_LACY, offered: ["lacy"] },
    say: "No.",
    expect: [{ action: "say", text: /not sent/i }],
    mustNot: NO_SEND,
  },
  {
    id: "start-a-codex-session",
    tags: ["codex", "new-session", "synthetic"],
    why: "Synthetic, the Codex adapter (2026-10-29): 'start a Codex session in X' opens Codex there (start_session's agent \"codex\"), never Claude Code, and never words sent to the session already in pixie.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 400, asked: "Run the tests.", said: "All tests pass." },
      { name: "lacy", folder: "lacy-platform", given: "Lacy", activeAgoS: 900, asked: "Deploy it.", said: "Deployed." },
    ],
    projects: ["pixie"],
    say: "Start a Codex session in pixie.",
    expect: [{ action: "start", folder: "pixie", agent: "codex" }],
    mustNot: [{ action: "start", agent: "" }, { action: "send" }, { action: "ask" }],
  },
  {
    id: "start-a-session-stays-claude",
    tags: ["codex", "new-session", "synthetic"],
    why: "Synthetic, the Codex adapter (2026-10-29): with a Codex session running, a new session that names no agent is still Claude Code's (the default): Codex only when it's said.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 400, asked: "Run the tests.", said: "All tests pass." },
      { name: "tideline", folder: "tideline", codex: true, activeAgoS: 120, asked: "Fix the build.", said: "The build is green." },
    ],
    projects: ["pixie"],
    say: "Open a new session in pixie.",
    expect: [{ action: "start", folder: "pixie", agent: "" }],
    mustNot: [{ action: "start", agent: "codex" }, { action: "send" }],
  },
  {
    id: "tell-the-codex-one",
    tags: ["codex", "send", "synthetic"],
    why: "Synthetic, the Codex adapter (2026-10-29): 'tell the codex one to …' picks the session <sessions> describes as a Codex session, by what it is, not by its name.",
    voiceCan: "messages",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 60, asked: "Run the tests.", said: "All tests pass." },
      { name: "tideline", folder: "tideline", codex: true, activeAgoS: 300, asked: "Fix the build.", said: "The build is green." },
      { name: "lacy", folder: "lacy-platform", given: "Lacy", activeAgoS: 200, asked: "Deploy it.", said: "Deployed." },
    ],
    say: "Tell the Codex one to add a changelog entry.",
    expect: reach("tideline"),
    mustNot: [send("kiko"), send("lacy"), ask("kiko"), ask("lacy"), START],
  },
  {
    id: "stop-the-codex-session",
    tags: ["codex", "stop", "synthetic"],
    why: "Synthetic, the Codex adapter (2026-10-29): 'stop the Codex session' interrupts the Codex session (Escape in its terminal), never words sent to it, never another session stopped.",
    voiceCan: "everything",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "busy", activeAgoS: 10, asked: "Refactor the router.", said: "Working on it." },
      { name: "tideline", folder: "tideline", codex: true, status: "busy", activeAgoS: 5, asked: "Rewrite the whole test suite.", said: "Starting with the unit tests." },
    ],
    say: "Stop the Codex session.",
    expect: [stop("tideline")],
    mustNot: [stop("kiko"), { action: "send" }, { action: "ask" }],
  },
  {
    id: "whats-running-names-codex",
    tags: ["codex", "status", "synthetic"],
    why: "Synthetic, the Codex adapter (2026-10-29): asked what's running, a Codex session is said to be Codex's (a Codex session), not called a Claude session.",
    sessions: [
      { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", activeAgoS: 60, asked: "Run the tests.", said: "All tests pass." },
      { name: "tideline", folder: "tideline", codex: true, status: "busy", activeAgoS: 5, asked: "Fix the build.", said: "Looking at the CI logs." },
    ],
    say: "Which sessions are running, and which one is Codex?",
    expect: [{ action: "say", text: /tideline[^.]*codex|codex[^.]*tideline/i }],
    mustNot: [{ action: "send" }, { action: "ask" }],
  },
);

// ════ Liveness checks: "can you hear me?", "are you there?", "testing" are the app's ═══════════
// Only the app hears you: it answers ("Yes, I hear you.", "I'm here."), whoever you dealt with last
// or just spoke (routing-rules.ts livenessCheck, at once and with no model; the classifier and the
// router for less clear ones). Words that only start that way, or name a session, are a session's.
// An evening: the session renamed Voice project (the app's own code) had just read out its agents'
// status.
const NOV4 = (o: Partial<SessionSpec> = {}): SessionSpec[] => [
  {
    name: "Voice project",
    folder: "claude-code-speech",
    given: "Voice project",
    title: "Window title after restart",
    status: "idle",
    activeAgoS: 26,
    asked: "No, I mean the voice project. How are all the agents in the voice project doing?",
    said: "One agent is still running: the export fix, started 20 minutes ago. Three others have finished: the settings tests, the menu icons, and the help page.",
    ...o,
  },
  { name: "T3", folder: "playground", given: "T3", t3: true, status: "idle", activeAgoS: 108_000, asked: "To T3: what's the capital of Peru?", said: "The capital of Peru is Lima." },
  {
    name: "Capital of France",
    folder: "playground",
    given: "Capital of France",
    t3: true,
    status: "idle",
    activeAgoS: 10_800,
    asked: "What is the capital of France?",
    said: "The capital of France is Paris.",
  },
];
const NOV4_RECENT = [
  "you → Voice project: No, I mean the voice project. How are all the agents in the voice project doing?",
  "app said (about Voice project): In Voice project, Claude says one agent is still running: the export fix, started 20 minutes ago. Three others have finished: the settings tests, the menu icons, and the help page.",
];
/** The app answers that it hears you (or a question back, from the router), and nothing goes to a session. */
const HEARD: Match[] = [{ action: "say", text: /\b(?:hear|here|clear|listening)\b/i }];
// Afternoon, synthetic: a session on an API, one on a video app, and Lacy.
const API_WORLD = (): SessionSpec[] => [
  {
    name: "api",
    folder: "api",
    title: "Orders rate limit",
    status: "idle",
    activeAgoS: 30,
    asked: "Add the rate limit to the orders endpoint.",
    said: "I added the rate limit to the orders endpoint and the tests pass. Try it with curl when you're ready.",
  },
  {
    name: "clipkit",
    title: "Export audio track",
    status: "idle",
    activeAgoS: 90,
    asked: "Fix the export so the audio track is kept.",
    said: "The export keeps the audio track now. I re-exported the demo video to the Desktop.",
  },
  lacy({ name: "Lacy", folder: "lacy-platform", given: "Lacy", activeAgoS: 1200 }),
];

CASES.push(
  {
    id: "liveness-are-you-there-waiting",
    tags: ["liveness", "waiting", "synthetic"],
    why: "Synthetic: 'Are you there?' while a session waits for a reply is still the app's ('I'm here.'), not a reply typed into it; it keeps waiting.",
    sessions: NOV4({ said: "Want me to start the remaining two agents in parallel now?" }),
    recent: [...NOV4_RECENT.slice(0, 1), "app said (about Voice project): In Voice project, Claude asks whether to start the remaining two agents in parallel now."],
    waiting: "Voice project",
    say: "Are you there?",
    expect: HEARD,
    mustNot: NO_SEND,
  },
  {
    id: "liveness-hello",
    tags: ["liveness", "synthetic"],
    why: "Synthetic: 'Hello?' right after a session spoke checks the app is there.",
    sessions: NOV4(),
    recent: NOV4_RECENT,
    justSpoke: { session: "Voice project", secondsAgo: 15 },
    say: "Hello?",
    expect: HEARD,
    mustNot: NO_SEND,
  },
  {
    id: "liveness-did-you-get-that",
    tags: ["liveness", "synthetic"],
    why: "Synthetic: 'Did you get that?' after words went to a busy session asks the app whether it heard (and sent) them; it answers, nothing is typed into the session again.",
    sessions: NOV4({ status: "busy", activeAgoS: 5, asked: "Start the remaining two agents in parallel.", said: "One agent is still running: the export fix." }),
    recent: [...NOV4_RECENT, "you → Voice project: Start the remaining two agents in parallel."],
    last: "Voice project",
    say: "Did you get that?",
    expect: SPEAK,
    mustNot: NO_SEND,
  },
  // Words for a session that only start like a check, or name one.
  {
    id: "liveness-not-testing-the-endpoint",
    tags: ["liveness", "synthetic"],
    why: "Synthetic: 'Testing the api endpoint now.' tells the api session what you're doing with its work; not a check of the app.",
    sessions: API_WORLD(),
    recent: [
      "you → api: Add the rate limit to the orders endpoint.",
      "app said (about api): In api, Claude added the rate limit to the orders endpoint and the tests pass. It says to try it with curl.",
    ],
    justSpoke: { session: "api", secondsAgo: 30 },
    last: "api",
    say: "Testing the api endpoint now.",
    expect: reach("api"),
    mustNot: [SAY, ...reach("clipkit"), ...reach("Lacy")],
  },
  {
    id: "liveness-not-hear-the-audio",
    tags: ["liveness", "synthetic"],
    why: "Synthetic: 'Can you hear the audio in the video?' asks clipkit about the export it just fixed; not a check of the app.",
    sessions: API_WORLD(),
    recent: [
      "you → clipkit: Fix the export so the audio track is kept.",
      "app said (about clipkit): In clipkit, Claude says the export keeps the audio track now and re-exported the demo video to the Desktop.",
    ],
    justSpoke: { session: "clipkit", secondsAgo: 20 },
    last: "clipkit",
    say: "Can you hear the audio in the video?",
    expect: reach("clipkit"),
    mustNot: [SAY, ...reach("api"), ...reach("Lacy")],
  },
  {
    id: "liveness-named-api-are-you-there",
    tags: ["liveness", "named", "synthetic"],
    why: "Synthetic: 'Api, are you there?' names the api session up front: name-first routing wins, it goes there, not to the app.",
    sessions: API_WORLD(),
    recent: ["you → clipkit: Fix the export so the audio track is kept.", "app said (about clipkit): In clipkit, Claude says the export keeps the audio track now."],
    last: "clipkit",
    say: "Api, are you there?",
    expect: sure(reach("api")),
    mustNot: [SAY, ...reach("clipkit"), ...reach("Lacy")],
  },
  {
    id: "liveness-named-lacy-hear-me",
    tags: ["liveness", "named", "synthetic"],
    why: "Synthetic: 'Lacy, can you hear me?' names Lacy up front: it goes to Lacy, even with another session dealt with last.",
    sessions: API_WORLD(),
    recent: ["you → api: Add the rate limit to the orders endpoint.", "app said (about api): In api, Claude added the rate limit to the orders endpoint."],
    last: "api",
    say: "Lacy, can you hear me?",
    expect: sure(reach("Lacy")),
    mustNot: [SAY, ...reach("api"), ...reach("clipkit")],
  },
);

// ════ Numbered sessions: two in one folder ════════════════════════════════════════════════
// Two new sessions open in the same project folder were once shown with the same name. Now the first keeps the folder's name and the next is numbered (core/session-numbers.ts):
// in the app's own folder, called the app's name, "Kiko project" and "Kiko project 2". A number names
// that one only, speech-to-text's "to"/"too" for "two" included; the plain name asks which.
const NUMBERED = (): SessionSpec[] => [
  {
    name: "kiko-a",
    folder: "kiko",
    title: "Voice app notes and settings",
    status: "idle",
    activeAgoS: 200,
    asked: "Write the plan for the phone's home screen into the idea file.",
    said: "The plan for the home screen is in the idea file. Want me to start on it?",
  },
  {
    name: "kiko-b",
    folder: "kiko",
    title: "Session colours",
    status: "idle",
    activeAgoS: 60,
    asked: "Make the session colours unique.",
    said: "Each session has its own colour now and the tests pass. Want me to commit?",
  },
  { name: "atlas-a", folder: "atlas-agents", title: "Saved cards", status: "idle", activeAgoS: 900 },
  { name: "atlas-b", folder: "atlas-agents", title: "Billing page", status: "busy", activeAgoS: 30, asked: "Build the billing page.", said: "Working on the invoice table." },
];
const WHICH_KIKO = "Which one: Kiko project, Voice app notes and settings; or Kiko project 2, Session colours?";
const NOT_EITHER_KIKO: Match[] = [...reach("kiko-a"), ...reach("kiko-b")];

CASES.push(
  {
    id: "numbered-number-word",
    tags: ["numbered", "named", "synthetic"],
    why: "Synthetic, 2026-11-04 numbering: 'Kiko two, …' is Kiko project 2 (the number makes it the session, not the app), never the plain one.",
    sessions: NUMBERED(),
    say: "Kiko two, run the tests and tell me if anything fails.",
    expect: sure([send("kiko-b", { text: /^Run the tests/ })]),
    mustNot: [...reach("kiko-a"), ...reach("atlas-a"), ...reach("atlas-b")],
  },
  {
    id: "numbered-heard-as-to",
    tags: ["numbered", "named", "speech-to-text", "synthetic"],
    why: "Synthetic: speech-to-text writes 'two' as 'to' (as it writes 'to' for 'two', the other way round): 'Kiko to, …' with a pause after it is Kiko project 2.",
    sessions: NUMBERED(),
    say: "Kiko to, check the logs for my last five messages.",
    expect: sure([send("kiko-b", { text: /^Check the logs/ })]),
    mustNot: [...reach("kiko-a")],
  },
  {
    id: "numbered-tell-to-is-the-word",
    tags: ["numbered", "speech-to-text", "synthetic"],
    why: "Synthetic: 'Tell kiko to …' is the app's name and 'to' (wake.ts): said to the app; never Kiko project 2 for the 'to'.",
    sessions: NUMBERED(),
    say: "Tell kiko to check how many sessions are open.",
    expect: [SAY, ASK_USER],
    mustNot: [...reach("kiko-b")],
  },
  {
    id: "numbered-ask-by-number",
    tags: ["numbered", "synthetic"],
    why: "Synthetic: 'Ask Kiko project 2 whether …' names the second by its number, mid-sentence: the classifier or the router, never the plain one.",
    sessions: NUMBERED(),
    say: "Ask Kiko project 2 whether the session colours work in the light theme too.",
    expect: [...reach("kiko-b")],
    mustNot: [...reach("kiko-a"), ...reach("atlas-a"), ...reach("atlas-b")],
  },
  {
    id: "numbered-status-of-number-two",
    tags: ["numbered", "synthetic"],
    why: "Synthetic: 'What's atlas agents number two doing?' asks the app about the second: answered, or asked of it; never the first.",
    sessions: NUMBERED(),
    say: "What's atlas agents number two doing right now?",
    expect: [SAY, ...reach("atlas-b")],
    mustNot: [...reach("atlas-a"), ...NOT_EITHER_KIKO],
  },
  {
    id: "numbered-plain-name-asks",
    tags: ["numbered", "ambiguous", "synthetic"],
    why: "Synthetic: 'Tell the Kiko project to …' with Kiko project 2 open names both: the app asks which, by number and title, rather than guess.",
    sessions: NUMBERED(),
    say: "Tell the Kiko project to commit the changes.",
    expect: [ASK_USER],
    mustNot: NOT_EITHER_KIKO,
  },
  {
    id: "numbered-plain-name-mid-sentence",
    tags: ["numbered", "ambiguous", "synthetic"],
    why: "Synthetic: the plain name mid-sentence, no session dealt with yet: asked which, never a guess at either.",
    sessions: NUMBERED(),
    say: "Can the Kiko project check the logs to see why my last message got cut off?",
    expect: [ASK_USER],
    mustNot: NOT_EITHER_KIKO,
  },
  {
    id: "numbered-to-the-tests",
    tags: ["numbered", "ambiguous", "speech-to-text", "synthetic"],
    why: "Synthetic: 'Atlas agents, to the tests …': the pause comes before 'to', so it's the word, not the number: the plain name, asked which; never atlas-agents 2 for the 'to'.",
    sessions: NUMBERED(),
    say: "Atlas agents, to the tests: run them again.",
    expect: [ASK_USER],
    mustNot: [...reach("atlas-b"), ...reach("atlas-a")],
  },
  {
    id: "numbered-answer-second",
    tags: ["numbered", "question", "synthetic"],
    why: "Synthetic: 'The second one.' answers 'Which one: Kiko project, …; or Kiko project 2, …?': the words asked about go to Kiko project 2.",
    sessions: NUMBERED(),
    recent: ["you → app: Tell the Kiko project to commit the changes.", `app said: ${WHICH_KIKO}`],
    question: { text: "Commit the changes.", offered: ["kiko-a", "kiko-b"] },
    say: "The second one.",
    expect: [send("kiko-b", { text: /^Commit the changes/ })],
    mustNot: [...reach("kiko-a"), { action: "send", text: /second one/i }],
  },
  {
    id: "numbered-answer-by-title",
    tags: ["numbered", "question", "synthetic"],
    why: "Synthetic: the answer picks by Claude's title for it, shown dimmed and said in the question ('the session colours one'): the words asked about go to Kiko project 2.",
    sessions: NUMBERED(),
    recent: ["you → app: Tell the Kiko project to commit the changes.", `app said: ${WHICH_KIKO}`],
    question: { text: "Commit the changes.", offered: ["kiko-a", "kiko-b"] },
    say: "The session colours one, please.",
    expect: [send("kiko-b", { text: /^Commit the changes/ }), { action: "ask", to: "kiko-b" }],
    mustNot: [...reach("kiko-a"), { action: "send", text: /colours/i }],
  },
  {
    id: "numbered-rename",
    tags: ["numbered", "rename", "synthetic"],
    why: "Synthetic: 'Rename Kiko project 2 to colours' renames that one session (it has its own name then, and no number).",
    sessions: NUMBERED(),
    voiceCan: "everything",
    say: "Rename Kiko project 2 to colours.",
    expect: [{ action: "rename", to: "kiko-b", name: /colou?rs/i }],
    mustNot: [{ action: "rename", to: "kiko-a" }, ...NOT_EITHER_KIKO],
  },
  // ── Kiko Pro: "upgrade" (decided in code while Pro is on sale, routing-rules.ts asksUpgrade) ─────
  {
    id: "upgrade-to-pro",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: the trial's reminder says \"Say 'upgrade'\": the app opens Kiko Pro's checkout, monthly; nothing goes to a session.",
    sessions: [clipkit(), voice()],
    say: "Upgrade to Kiko Pro.",
    expect: [{ action: "upgrade", interval: "month" }],
    mustNot: NO_SEND,
  },
  {
    id: "upgrade-bare",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: a bare 'Upgrade.' with nothing waiting: the reminder's word, the checkout.",
    sessions: [clipkit(), voice()],
    say: "Upgrade.",
    expect: [{ action: "upgrade" }],
    mustNot: NO_SEND,
  },
  {
    id: "upgrade-yearly",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: the yearly plan asked for by name: the checkout for a year.",
    sessions: [clipkit()],
    say: "Buy Kiko Pro for a year, please.",
    expect: [{ action: "upgrade", interval: "year" }],
    mustNot: NO_SEND,
  },
  {
    id: "upgrade-answers-waiting",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: clipkit asked whether to upgrade a dependency and waits: 'Upgrade.' is its answer, never the checkout.",
    sessions: [clipkit({ said: "React Native 0.79 is out. Should I upgrade the dependency now, or keep 0.78 until the release?" })],
    waiting: "clipkit",
    say: "Upgrade.",
    expect: [send("clipkit", { text: /upgrade/i })],
    mustNot: [{ action: "upgrade" }],
  },
  {
    id: "upgrade-work-for-session",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: upgrading is the session's work here (a dependency, named session): never the checkout.",
    sessions: [clipkit(), voice()],
    say: "Tell clipkit to upgrade the dependencies.",
    expect: reach("clipkit"),
    mustNot: [{ action: "upgrade" }],
  },
  {
    id: "upgrade-not-on-sale",
    tags: ["upgrade", "synthetic"],
    why: "Synthetic: Kiko Pro not on sale (PRO_ON_SALE off): 'Upgrade to Kiko Pro' is never a checkout; the app answers or it goes to the Kiko session.",
    sessions: [clipkit(), voice()],
    proOnSale: false,
    say: "Upgrade to Kiko Pro.",
    expect: [...SPEAK, ...reach("claude-code-speech"), { action: "none" }],
    mustNot: [{ action: "upgrade" }, ...reach("clipkit")],
  },
);

// ── "To Rowan, …" heard as "Too rowing, …" ───────────────────────────────────────────────────────
// The sessions as the route prompts listed them: Bobby, Rowan, the Kiko project, mintbox.
const ROWAN_SESSIONS = (kiko: Partial<SessionSpec> = {}): SessionSpec[] => [
  {
    name: "Bobby",
    folder: "2026-01-21-bobby",
    given: "Bobby",
    activeAgoS: 3180,
    noTerminal: true,
    asked: "! git -C ~/git/recipes push origin main",
    said: "…It should open your recipe list. The share link will keep working when you edit the list later. To add or change recipes, edit the list near the top of `src/pages/recipes.astro`, or just ask me.",
  },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    activeAgoS: 32,
    asked: "any news? can i try it somewhere yet? no rush",
    said: "…for one fix. The sidebar grew with the font size, so its icons sat off-center at the larger sizes. Once that's done, it goes into the next desktop release with font size and the new theme. That release needs you to type your signing password, and I'll give you the command when it's ready.",
  },
  {
    name: "kiko",
    folder: "kiko",
    given: "Kiko project",
    title: "Kiko update check",
    activeAgoS: 1140,
    asked: "can the app check for updates by itself and install them when it restarts?",
    said: "…The phone screen would ask you to sign in first. I'd keep that, but you could skip it while testing. If you pick the three options, I can do steps 3 and 4 right after.",
    ...kiko,
  },
  {
    name: "mintbox",
    title: "Mintbox store screenshots",
    activeAgoS: 4,
    asked: "nice! keep the settings so we can redo them if the design changes. light mode looks great",
    said: "…When you want, I can make a few cropped versions for the feature pages on the website. I've noted the idea so it isn't lost. The dark-mode set is still next. After that comes the rest of the list.",
  },
];
const ROWAN_RECENT = [
  "app said (about Kiko project): … a few choices for you (how often it checks and whether it asks first), the download setup, code work for me, and a first test build. Older versions need one extra step.",
  "app said (about Kiko project): In Kiko project, Codex replied with nothing: no suggestions and nothing to report.",
  "app said (about Rowan): In Rowan, Claude has started both: a three-step Font size setting for web and desktop, and a dark theme in Settings.",
  "app said (about mintbox): In mintbox, Claude says the settings are now the defaults for every screenshot, with one file to change the theme, the device frame and the background.",
  "app said (about Rowan): In Rowan, Claude says the font-size setting works: Settings has a new Appearance section, and the layout still fits at the largest size.",
  "app said (about Rowan): In Rowan, Claude says the dark theme is live, so reload to see it. It also says the font-size work is built but sent back for a fix to the sidebar.",
];
CASES.push(
  {
    id: "two-rowen-check-the-logs",
    tags: ["synthetic", "speech-to-text", "misheard-name"],
    why: "Synthetic, from a misheard-name incident: another spelling of 'to Rowan' up front, with the Kiko project dealt with last; Rowan's (the classifier sure of it, or the router's guess said and held), or asked about.",
    sessions: ROWAN_SESSIONS(),
    recent: ROWAN_RECENT,
    last: "kiko",
    lastSent: null,
    say: "Two Rowen, can you check the logs for any errors from the last deploy?",
    expect: [...reach("Rowan"), { action: "ask_user", text: /\bRowan\b/ }],
    mustNot: [...reach("kiko"), ...reach("mintbox"), ...reach("Bobby")],
  },
  {
    id: "too-bad-is-no-name",
    tags: ["synthetic", "misheard-name"],
    why: "Synthetic: words that open like a name heard wrong but are only a sentence ('Too bad, …') go where they would have: Rowan, which just reported, dealt with last.",
    sessions: ROWAN_SESSIONS(),
    recent: ROWAN_RECENT,
    last: "Rowan",
    lastSent: null,
    say: "Too bad, the sidebar fix is taking a while. Can you check if the font-size work is ready now?",
    expect: reach("Rowan"),
    mustNot: [...reach("kiko"), ...reach("mintbox"), ...reach("Bobby")],
  },
);

// ── A yes to the app's own offer; a product the words only talk about ─────────────────────────────
// Made up, from an incident (2026-11-19): right after a restart, a question about building something
// like a product being talked about ("Vantage", no session) named no session; the router said the
// product wasn't one of the sessions and offered, in its own words, to ask Rowan, whose last topic it
// was; the yes to that ("Yes, and it's to Rowan.") was typed into Rowan by itself.
const VANTAGE_SESSIONS = (): SessionSpec[] => [
  {
    name: "kiko",
    folder: "kiko",
    given: "Kiko project",
    title: "Permission prompt wording",
    status: "idle",
    activeAgoS: 55,
    asked: "Which API key does the test clone use, mine or its own?",
    said: "…It uses its own, from the clone's settings. Pull, then start it again and I'll tell you when it's ready.",
  },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    status: "idle",
    activeAgoS: 240,
    asked: "Isn't that already what Rowan is meant to be, with a few more features?",
    said: "…That also helps the business: every handoff brings someone into Rowan instead of making it an invisible back end. So the platform idea holds, with one honest limit: the private place is the product, and the connector is how other agents reach it without leaking.",
  },
  {
    name: "mintbox",
    title: "Store screenshot sizes",
    status: "idle",
    activeAgoS: 2880,
    asked: "Which screenshot sizes does the store still need from us?",
    said: "…Two sizes are left: the large phone and the tablet. The light set is done for both.",
  },
];
const VANTAGE_ASKED = "So if I wanted to build something exactly like Vantage, what would that look like?";
const VANTAGE_OFFER =
  "Vantage isn't one of your sessions, so I can't tell which project you mean. Rowan looks like the closest match, since its recent topics are about a private platform for agents. Want me to ask the Rowan session what building something like Vantage would involve?";
const AFTER_VANTAGE_OFFER = {
  sessions: VANTAGE_SESSIONS(),
  recent: [`you → app: ${VANTAGE_ASKED}`, `app said: ${VANTAGE_OFFER}`],
  lastSent: null,
  question: { text: VANTAGE_ASKED, offered: ["Rowan"], offer: true },
};
const VANTAGE_TO_ROWAN: Match[] = [send("Rowan", { text: /build something exactly like Vantage/i }), { action: "ask", to: "Rowan", text: /Vantage/i }];
// The yes itself, typed into a session.
const THE_YES: Match[] = [
  { action: "send", text: /^\W*(?:yes|yeah|yep|sure|no|rowan)\b/i },
  { action: "ask", text: /^\W*(?:yes|yeah|yep|sure|no|rowan)\b/i },
];
// The router claiming a product the words talk about was meant as a session.
const NOT_A_SESSION_CLAIM: Match[] = [
  { action: "say", text: /\b(?:isn'?t|is not|not) (?:one of )?your sessions?\b|\bno session (?:called|named)\b/i },
  { action: "ask_user", text: /\b(?:isn'?t|is not|not) (?:one of )?your sessions?\b|\bno session (?:called|named)\b/i },
];

CASES.push(
  {
    id: "offer-yes-sends-the-words",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic, from the 2026-11-19 offer incident: 'Yes.' to the app's offer of Rowan sends the words offered there, never the yes.",
    ...AFTER_VANTAGE_OFFER,
    say: "Yes.",
    expect: VANTAGE_TO_ROWAN,
    mustNot: [...THE_YES, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "offer-yes-and-the-name",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic, from the 2026-11-19 offer incident: 'Yes, and it's to Rowan.' (an 'and' before the name) sends the words offered to Rowan, never the yes.",
    ...AFTER_VANTAGE_OFFER,
    say: "Yes, and it's to Rowan.",
    expect: VANTAGE_TO_ROWAN,
    mustNot: [...THE_YES, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "offer-bare-name",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic: the session's name alone, answering the app's offer, sends the words offered there.",
    ...AFTER_VANTAGE_OFFER,
    say: "Rowan.",
    expect: VANTAGE_TO_ROWAN,
    mustNot: [...THE_YES, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "offer-yes-in-other-words",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic: a yes to the offer the code doesn't read (the router's): the words offered go to Rowan, never the yes.",
    ...AFTER_VANTAGE_OFFER,
    say: "Yeah, that's the one, go for it.",
    expect: VANTAGE_TO_ROWAN,
    mustNot: [{ action: "send", text: /go for it/i }, { action: "ask", text: /go for it/i }, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "offer-no-drops-the-words",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic: 'No.' to the app's offer sends nothing, and says so.",
    ...AFTER_VANTAGE_OFFER,
    say: "No.",
    expect: [{ action: "say", text: /not sent/i }],
    mustNot: NO_SEND,
  },
  {
    id: "offer-moved-on",
    tags: ["question", "offer", "synthetic"],
    why: "Synthetic: new words after the app's offer go where they would have; the words offered don't go.",
    ...AFTER_VANTAGE_OFFER,
    say: "Tell mintbox to make the tablet screenshots next.",
    expect: [send("mintbox", { text: /tablet/i }), { action: "ask", to: "mintbox", text: /tablet/i }],
    mustNot: [
      { action: "send", text: /Vantage/i },
      { action: "ask", text: /Vantage/i },
    ],
  },
  {
    id: "asked-both-yes-and-the-name",
    tags: ["question", "synthetic"],
    why: "Synthetic, from the 2026-11-19 offer incident: the question as the app kept it then (both the Kiko project and Rowan offered, not an offer), and 'Yes, and it's to Rowan.': the words asked about go to Rowan, never the yes.",
    ...AFTER_VANTAGE_OFFER,
    question: { text: VANTAGE_ASKED, offered: ["kiko", "Rowan"] },
    say: "Yes, and it's to Rowan.",
    expect: VANTAGE_TO_ROWAN,
    mustNot: [...THE_YES, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "product-name-is-no-session",
    tags: ["topic", "unnamed", "synthetic"],
    why: "Synthetic, from the 2026-11-19 offer incident: just restarted, a question naming no session, about building something like a product (no session), carries on Rowan's last topic: Rowan's, or offered; never 'Vantage isn't one of your sessions'.",
    sessions: VANTAGE_SESSIONS(),
    recent: [],
    lastSent: null,
    say: VANTAGE_ASKED,
    expect: [...reach("Rowan"), { action: "ask_user", text: /\bRowan\b/ }],
    mustNot: [...NOT_A_SESSION_CLAIM, ...reach("kiko"), ...reach("mintbox")],
  },
  {
    id: "product-name-is-no-session-shots",
    tags: ["topic", "unnamed", "synthetic"],
    why: "Synthetic: a question about how another company's app does something, naming no session, on mintbox's topic (store screenshots): mintbox's, or offered; never that the product isn't a session.",
    sessions: VANTAGE_SESSIONS(),
    recent: [],
    lastSent: null,
    say: "How does Pebblenote do their store screenshots with the phone frame? Could we make ours look like that?",
    expect: [...reach("mintbox"), { action: "ask_user", text: /\bmintbox\b/i }],
    mustNot: [...NOT_A_SESSION_CLAIM, ...reach("kiko"), ...reach("Rowan")],
  },
);

// ── An answer to the app's offer naming another session ──────────────────────────────────────────
// Made up, from an incident (2026-11-20): words naming no session; the router offered api ("Want me
// to send that to api?") and the app held them. "This to Rowan", heard as "Thus, too, Rowan.", named
// another session: the router's pass_on to Rowan was right, but the app didn't read it as a pick, let
// the words offered go and typed the answer into Rowan.
const API_SESSIONS = (): SessionSpec[] => [
  {
    name: "api",
    title: "Retry limits",
    status: "idle",
    activeAgoS: 60,
    asked: "Where does the retry limit live now?",
    said: "…It's hard-coded in the client for now: three tries, two seconds apart.",
  },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    status: "idle",
    activeAgoS: 300,
    asked: "Is the settings page done?",
    said: "…Yes, the settings page is done, with the new settings file behind it.",
  },
  {
    name: "mintbox",
    title: "Store screenshot sizes",
    status: "idle",
    activeAgoS: 2880,
    asked: "Which screenshot sizes does the store still need from us?",
    said: "…Two sizes are left: the large phone and the tablet.",
  },
];
const API_HELD = "Can we move the retry limit into the settings file?";
const API_OFFER = "Want me to send that to api?";
const AFTER_API_OFFER = {
  sessions: API_SESSIONS(),
  recent: [`you → app: ${API_HELD}`, `app said: ${API_OFFER}`],
  lastSent: null,
  question: { text: API_HELD, offered: ["api"], offer: true },
};
const HELD_TO_ROWAN: Match[] = [send("Rowan", { text: /retry limit into the settings file/i }), { action: "ask", to: "Rowan", text: /retry limit/i }];
// The answer itself, typed into a session.
const THE_ANSWER: Match[] = [
  { action: "send", text: /^\W*(?:this|thus|dus|no|send|rowan)\b/i },
  { action: "ask", text: /^\W*(?:this|thus|dus|no|send|rowan)\b/i },
];
const redirectCase = (id: string, say: string, why: string): Case => ({
  id,
  tags: ["question", "offer", "offer-redirect", "synthetic"],
  why,
  ...AFTER_API_OFFER,
  say,
  expect: HELD_TO_ROWAN,
  mustNot: [...THE_ANSWER, ...reach("api"), ...reach("mintbox")],
});

CASES.push(
  redirectCase(
    "offer-redirect-plain",
    "This to Rowan.",
    "Synthetic, from the 2026-11-20 offer incident: after the app's offer of api, 'This to Rowan.' sends the words offered to Rowan, never the answer.",
  ),
  redirectCase("offer-redirect-no-instead", "No, send it to Rowan instead.", "Synthetic: a no to the app's offer of api that names Rowan sends the words offered to Rowan."),
  redirectCase(
    "offer-redirect-misheard",
    "Thus, too, Rowan.",
    "Synthetic, from the 2026-11-20 offer incident: 'this to Rowan' misheard as 'Thus, too, Rowan.' sends the words offered to Rowan, never the answer.",
  ),
  redirectCase("offer-redirect-misheard-two", "This two Rowan.", "Synthetic: 'this to Rowan' misheard as 'This two Rowan.' sends the words offered to Rowan."),
  {
    ...redirectCase(
      "offer-redirect-misheard-router",
      "Dus, tew, Rowan.",
      "Synthetic: 'this to Rowan' misheard past what the code reads ('Dus, tew, Rowan.'): the router's pick sends the words offered to Rowan, never the answer; or the app asks about sending them there.",
    ),
    expect: [...HELD_TO_ROWAN, { action: "ask_user", text: /\bRowan\b/ }],
  },
  {
    id: "offer-redirect-new-request",
    tags: ["question", "offer", "offer-redirect", "synthetic"],
    why: "Synthetic: after the app's offer of api, a request of its own naming Rowan ('Rowan, run the tests.') goes to Rowan; nothing goes to api.",
    ...AFTER_API_OFFER,
    say: "Rowan, run the tests.",
    expect: [send("Rowan", { text: /run the tests/i }), { action: "ask", to: "Rowan", text: /tests/i }],
    mustNot: [{ action: "send", text: /^\W*rowan\b/i }, ...reach("api"), ...reach("mintbox")],
  },
);

// ── A correction right after the app dealt with the words itself ───────────────────────────────
// 2026-11-20 (made-up names and words): a question meant for Rowan named no session, and the app ran
// a quick check on it. "Send that to Rowan, don't check it yourself" (the name misheard) was then
// passed on to Rowan as is: the correction was typed in, and the question never reached Rowan. Words
// the app checked, answered or opened a session for are what a correction then sends (resend_to).
const CHECKED_SESSIONS = (): SessionSpec[] => [
  { name: "api", title: "Retry limits", status: "idle", activeAgoS: 600, asked: "Where does the retry limit live now?", said: "…It's in the client for now." },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    status: "busy",
    activeAgoS: 40,
    asked: "Kick off the nightly import on the staging box.",
    said: "…The nightly import is running on the staging box; I'll tell you when it's done.",
  },
  { name: "mintbox", title: "Store screenshot sizes", status: "idle", activeAgoS: 2880, asked: "Make the dark set next.", said: "…The dark set is done." },
];
const CHECKED = "Did the nightly import finish on the staging box?";
const AFTER_CHECK = { sessions: CHECKED_SESSIONS(), recent: [`you → app: ${CHECKED}`, "app said: Checking."], handled: "quick_task" as const };
const AFTER_ANSWER = { sessions: CHECKED_SESSIONS(), recent: [`you → app: ${CHECKED}`, "app said: I can't tell from here whether it finished."], handled: "answered" as const };
const CHECKED_TO_ROWAN: Match[] = [{ action: "resend", to: "Rowan", text: /nightly import/i }];
// The correction itself, typed into a session.
const THE_CORRECTION: Match[] = [
  { action: "send", text: /\b(?:send|that was|yourself|instead|should|meant)\b/i },
  { action: "ask", text: /\b(?:send that|yourself|instead|you should|was meant)\b/i },
];
const correctsCheck = (id: string, say: string, why: string, more: Partial<Case> = {}): Case => ({
  id,
  tags: ["correction", "app-handled", "synthetic"],
  why,
  ...AFTER_CHECK,
  say,
  expect: CHECKED_TO_ROWAN,
  mustNot: [...THE_CORRECTION, ...reach("api"), ...reach("mintbox")],
  ...more,
});

CASES.push(
  correctsCheck(
    "app-handled-check-send-that",
    "You should send that to Rowan. Don't check it yourself.",
    "Synthetic, from the 2026-11-20 quick check incident: after the app checked a question itself, 'send that to Rowan' sends the question there, never the correction.",
  ),
  correctsCheck(
    "app-handled-check-misheard",
    "No, Rohan should look at that, not you.",
    "Synthetic, from the 2026-11-20 quick check incident: the name misheard ('Rohan' for Rowan); the question goes to Rowan, never the correction.",
  ),
  correctsCheck(
    "app-handled-check-misheard-roan",
    "Don't check it yourself, send it to Roan.",
    "Synthetic: the name misheard ('Roan' for Rowan) after a quick check: the question goes to Rowan, or the app asks where; never the correction.",
    { expect: [...CHECKED_TO_ROWAN, ASK_USER] },
  ),
  correctsCheck("app-handled-check-was-for", "That was for Rowan.", "Synthetic: 'that was for Rowan' right after a quick check sends the question checked to Rowan."),
  correctsCheck("app-handled-check-ask-instead", "No, ask Rowan instead.", "Synthetic: 'no, ask Rowan instead' after a quick check sends the question to Rowan."),
  correctsCheck("app-handled-check-should-check", "Rowan should check that, not you.", "Synthetic: 'Rowan should check that' after a quick check sends the question to Rowan."),
  {
    id: "app-handled-answer-was-for",
    tags: ["correction", "app-handled", "synthetic"],
    why: "Synthetic: after the app answered a question itself, 'that was meant for Rowan' sends the question there.",
    ...AFTER_ANSWER,
    say: "That was meant for Rowan.",
    expect: CHECKED_TO_ROWAN,
    mustNot: [...THE_CORRECTION, ...reach("api"), ...reach("mintbox")],
  },
  {
    id: "app-handled-start-send-that",
    tags: ["correction", "app-handled", "synthetic"],
    why: "Synthetic: after the app opened a session for a request, 'no, send that to Rowan' sends the request there.",
    sessions: CHECKED_SESSIONS(),
    recent: ["you → app: Start a session to fix the import retries.", "app said: Opened a new session in the scratch folder."],
    handled: "start",
    say: "No, send that to Rowan.",
    expect: [{ action: "resend", to: "Rowan", text: /import retries/i }],
    mustNot: [...THE_CORRECTION, START],
  },
  {
    id: "app-handled-check-new-request",
    tags: ["app-handled", "synthetic"],
    why: "Synthetic negative: after a quick check, a request of its own naming Rowan goes there as new words; the question checked doesn't.",
    ...AFTER_CHECK,
    say: "Rowan, also rerun the failed batch.",
    expect: [send("Rowan", { text: /rerun the failed batch/i }), { action: "ask", to: "Rowan", text: /failed batch/i }],
    mustNot: [{ action: "resend" }, { action: "send", text: /nightly import finish/i }],
  },
  {
    id: "app-handled-answer-new-ask",
    tags: ["app-handled", "synthetic"],
    why: "Synthetic negative: after the app said the time, 'ask Rowan whether the import finished' is new words for Rowan, not the time question resent.",
    sessions: CHECKED_SESSIONS(),
    recent: ["you → app: What time is it?", "app said: It's 9:40 pm."],
    handled: "answered",
    say: "Ask Rowan whether the import finished.",
    expect: [send("Rowan", { text: /import/i }), { action: "ask", to: "Rowan", text: /import/i }],
    mustNot: [{ action: "resend" }, { action: "send", text: /what time/i }, { action: "ask", text: /what time/i }],
  },
  {
    id: "app-handled-answer-tell-other",
    tags: ["app-handled", "synthetic"],
    why: "Synthetic negative: after the app answered, an instruction for mintbox goes there as said; nothing is resent.",
    sessions: CHECKED_SESSIONS(),
    recent: ["you → app: What time is it?", "app said: It's 9:40 pm."],
    handled: "answered",
    say: "Tell mintbox to make the tablet set next.",
    expect: [send("mintbox", { text: /tablet set/i }), { action: "ask", to: "mintbox", text: /tablet/i }],
    mustNot: [{ action: "resend" }, ...reach("Rowan")],
  },
);

// ── The cases made from real speech ──────────────────────────────────────────────────────────
// The owner's own words from the app's logs are private: tests/eval/private/cases.ts, left out of
// the public repo (export-ignore). When it's there, its cases run with these.
const PRIVATE = join(dirname(fileURLToPath(import.meta.url)), "private", "cases.ts");
if (existsSync(PRIVATE)) CASES.push(...((await import(pathToFileURL(PRIVATE).href)) as { PRIVATE_CASES: Case[] }).PRIVATE_CASES);
