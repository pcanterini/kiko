// What Kiko does for a session, feature by feature, with Claude Code (the main agent) as the
// reference: every agent adapter says, for each, whether its sessions get it (./<agent>/support.ts),
// and why not where they don't. SUPPORT.md is drawn from those (`pnpm support`: ./support-matrix.ts),
// so what's there and what's missing for each agent is one table, never a guess.
//
// A new feature is one more entry in FEATURES: every adapter's declaration then fails to typecheck
// until it says how it stands on it (`Record<Feature, Support>`). A new agent is one more
// declaration in ./support-matrix.ts (a test checks every agent in ./index.ts has one).
// tests/unit/agents/support.test.ts checks what it can against the adapters themselves (an agent
// with `rename` can't say rename isn't built), and that SUPPORT.md is up to date.
//
// Imports nothing: the doc's script and the tests read it without loading the adapters.
import { NAME, SLUG } from "../core/name.ts";

/** Where a row goes in the table: its section of SUPPORT.md. */
export const GROUPS = ["Listed", "Heard", "Your words", "Permissions and questions", "Interrupt, rename, close", "Starting a session", "Permission modes", "History, phone, setup"] as const;
export type Group = (typeof GROUPS)[number];

type FeatureInfo = { group: Group; label: string; about: string };

/**
 * Every user-facing feature Kiko has for a session, in the order SUPPORT.md shows them. "In
 * Kiko's tmux" and "outside" are rows of their own where what reaches a session differs (keys
 * typed into its pane there; elsewhere a Ghostty window found for sure, or the agent itself).
 */
export const FEATURES = {
  listed: { group: "Listed", label: "Listed with your sessions", about: "In the window's list and the phone, wherever it runs, by its name." },
  listedAtOnce: { group: "Listed", label: "Listed as soon as it opens", about: "Before its first message: a session just opened is in the list and can be picked." },
  status: { group: "Listed", label: "Busy / needs you / idle", about: 'Its state in the list, the bottom line and the phone; red "needs you" while something waits on you.' },
  heard: { group: "Heard", label: "A finished turn heard", about: "Its last reply summarised and said (or announced), as it ends." },
  speaker: { group: "Heard", label: "The summary names who spoke", about: '"In pixie, Claude says…": the agent\'s own name, not "it" (Agent.speaker).' },
  replyWindow: { group: "Heard", label: "Reply window", about: "Words said right after it spoke go to it, unnamed, carrying its turn on (Held.answer)." },
  typedWhileHeld: { group: "Heard", label: "Typing in its own window noticed", about: `Words you type into it by hand while ${NAME} holds its turn aren't sent twice (Held.watchTyped).` },
  promptStarted: { group: "Heard", label: "Your words seen to start", about: "It says when it took a prompt in: the phone's words show as started (Agent.onPromptSubmitted)." },
  wordsInTmux: { group: "Your words", label: `Words at any moment, in ${NAME}'s tmux`, about: "Named by voice, the phone or the window, typed into its pane." },
  wordsOutside: { group: "Your words", label: "Words at any moment, outside it", about: "The same for one in Ghostty, Warp, iTerm or its own app." },
  dictatedNote: {
    group: "Your words",
    label: "Told that typed-in words were dictated",
    about: 'Words typed into it for you come with a line for the agent saying they were spoken, so a misheard word ("high term") is read as one; nothing more is typed or shown (Agent.dictated).',
  },
  permissions: { group: "Permissions and questions", label: "Permission prompts: allow / deny", about: "Asked by voice, on the Mac's card and on the phone; a no tells it why." },
  allowAlways: { group: "Permissions and questions", label: "Allow always", about: `"Don't ask again" from ${NAME} (Held.canAllowAlways).` },
  safetyGate: {
    group: "Permissions and questions",
    label: "Asks before it sends, deletes, pays or posts",
    about: `${NAME}'s safety gate (core/guard.ts), off by default (Settings → Permissions turns it on): a shell command or tool call that sends, deletes, pays or posts is asked about first, whatever the session's own permission mode or allow rules.`,
  },
  questions: {
    group: "Permissions and questions",
    label: "Its questions, with options",
    about: "The agent asking you to pick (Claude Code's AskUserQuestion), by voice and on the phone (Held.questions).",
  },
  interruptInTmux: { group: "Interrupt, rename, close", label: `Interrupt, in ${NAME}'s tmux`, about: '"Stop pixie", the menus\' Interrupt.' },
  interruptOutside: { group: "Interrupt, rename, close", label: "Interrupt, outside it", about: `The same for one ${NAME} didn't open in its tmux.` },
  renameInTmux: { group: "Interrupt, rename, close", label: `Rename, in ${NAME}'s tmux`, about: '"Rename pixie to docs", the menus\' Rename…; a rename in the agent shows here too.' },
  renameOutside: { group: "Interrupt, rename, close", label: "Rename, outside it", about: `The same for one ${NAME} didn't open in its tmux.` },
  closeInTmux: { group: "Interrupt, rename, close", label: `Close, in ${NAME}'s tmux`, about: "The menus' Close…: it ends cleanly (saves, runs its end hooks)." },
  closeOutside: { group: "Interrupt, rename, close", label: "Close, outside it", about: `The same for one ${NAME} didn't open in its tmux.` },
  start: { group: "Starting a session", label: "Start one", about: "By voice, the phone's words or the window's `c` (and the agent picker), in a project or the scratch folder." },
  startPrompt: { group: "Starting a session", label: "Start with a first message", about: '"Start a session in pixie to fix the tests": the words are its first message.' },
  startName: { group: "Starting a session", label: "Start with a name", about: '"… named docs": it goes by that name from the start.' },
  startHeldWords: { group: "Starting a session", label: "Words for one still starting", about: "Held, and typed in once it's ready for them, never before." },
  trustCard: { group: "Starting a session", label: "Folder-trust card at start", about: 'Its "trust this folder?" question asked as a card, by voice and on the phone.' },
  loginFailed: { group: "Starting a session", label: "A turn that couldn't log in said", about: '"Not logged in" said (and a first message tried again once), never left silent.' },
  knownFolders: {
    group: "Starting a session",
    label: "Its projects known by name",
    about: 'Folders it ran sessions in, from its own history: what "start a session in pixie" finds (Agent.knownFolders).',
  },
  startMode: {
    group: "Permission modes",
    label: "Starts in the chosen permission mode",
    about: "The \"Permission mode\" setting (Accept edits by default) passed as it starts (NewSession.mode); Claude Code's scratch sessions in auto while it's left at its default.",
  },
  modeShown: { group: "Permission modes", label: "Its mode now, shown", about: "Its permission mode in the list and on the phone (AgentSession.mode)." },
  autoBlocks: { group: "Permission modes", label: "Auto mode's blocks said", about: "A tool call its auto mode blocked, which no prompt asks you about, said (Agent.onBlocked)." },
  blockOverride: {
    group: "Permission modes",
    label: "A block allowed anyway",
    about: '"Auto mode blocked Lacy from running wrangler deploy. Allow it?" as a card; yes lets the call through the agent\'s own way (core/block-override.ts).',
  },
  history: {
    group: "History, phone, setup",
    label: "What it said; its conversation",
    about: `"What did it say?", and its conversation on the phone and in the ${NAME} window (watchHistory, historyFile).`,
  },
  phone: { group: "History, phone, setup", label: "On the phone", about: "Listed with its agent's name, talked to, its cards answered there." },
  mark: { group: "History, phone, setup", label: "Its mark in the lists", about: "Its agent glyph and colour before each name (Agent.mark)." },
  setup: { group: "History, phone, setup", label: `Connected from ${NAME}`, about: `The first-run card, settings → Agents, \`${SLUG} setup\`; a broken setup said (Agent.setup).` },
  hooksCurrent: {
    group: "History, phone, setup",
    label: "Its hooks kept current",
    about: `At start, a connected agent's hooks file is given each event this ${NAME} hooks that it never had, backed up first; one you took out stays out (agents/setup.ts upgradeHooks).`,
  },
} as const satisfies Record<string, FeatureInfo>;

export type Feature = keyof typeof FEATURES;

/**
 * How an agent's sessions stand on a feature:
 *   yes         as Claude Code's
 *   partial     some of it: `why` says what's missing
 *   tool-limit  the agent itself can't (`why` cites why: "a Codex hook's allow is for one request")
 *   not-built   it could, Kiko hasn't yet (`why` says how it could be)
 *   n/a         it doesn't apply to this agent (`why` says why)
 */
export type Status = "yes" | "partial" | "tool-limit" | "not-built" | "n/a";
export const STATUSES: readonly Status[] = ["yes", "partial", "tool-limit", "not-built", "n/a"];

/**
 * Where it stands, and why: a reason is optional only for `yes` (a note on how, or since which
 * version). `unsure`: read from the agent's source or docs but not checked against it, or not known
 * for sure; the reason says what's unchecked, and SUPPORT.md lists it under "To check".
 */
export type Support = ({ status: "yes"; why?: string } | { status: Exclude<Status, "yes">; why: string }) & { unsure?: boolean };

/** One agent's declaration: every feature, as its adapter (same `id` and `name`) has it. */
export type AgentSupport = { id: string; name: string; features: Record<Feature, Support> };

const sure = (unsure: boolean) => (unsure ? { unsure } : {});
export const yes = (why?: string, unsure = false): Support => ({ status: "yes", ...(why ? { why } : {}), ...sure(unsure) });
export const partial = (why: string, unsure = false): Support => ({ status: "partial", why, ...sure(unsure) });
export const toolLimit = (why: string, unsure = false): Support => ({ status: "tool-limit", why, ...sure(unsure) });
export const notBuilt = (why: string, unsure = false): Support => ({ status: "not-built", why, ...sure(unsure) });
export const na = (why: string, unsure = false): Support => ({ status: "n/a", why, ...sure(unsure) });
