// The coding agents whose sessions Kiko talks to: one adapter per agent, each the shape of what
// the Claude Code one (./claude-code/) already does. index.ts lists them once, at startup; core and
// the entry points reach them only through it (`agent`, which goes to each session's own, and
// `agentOf`), never through ./claude-code/ or ./t3code/. Claude Code is the main one: what isn't
// about one session (starting a new one, the folders it knows, its setup) is its.
//
// What an adapter does: list the running sessions; hold a finished turn (with what it said) or a
// permission prompt for you, and answer it; read a session's history; and say how to start,
// interrupt and rename one in a terminal (typing is the terminal adapters' job: src/terminals/), or
// do those itself where it can with no terminal (`can`: T3 Code, through its server). What a session
// can do, all told, is one list (`Can`, core/can.ts canDo) the menus, router, voice and phone read.
// Every session reaches Kiko this way, however and wherever it was started: announcements,
// replies in its reply window and permission answers need no terminal adapter.
//
// Codex CLI (./codex/) is one: hooks much like Claude Code's (Stop held for a reply, which carries
// the turn on; PermissionRequest allowed or denied), on the same socket; its sessions from the
// records its hook keeps; typed into, renamed, interrupted and closed as Claude Code's are.
// OpenCode (./opencode/) is one: no hooks, its background service's HTTP API and event stream
// instead (every OpenCode TUI is a client of it): its sessions listed while a TUI runs in their
// folder, a finished turn read out with a reply window (the reply is a new message), its permissions
// and questions held as Claude Code's are, and your words, renames and interrupts sent through it.
// T3 Code (./t3code/) is one: its threads over its local server's WebSocket, a finished run read
// out as a turn that can't be held, your words sent to the thread as a new message, its permissions
// and questions held as Claude Code's are, and its threads stopped, renamed and archived through it.
import type { GuardCheck, GuardVerdict } from "../core/guard.ts";
import type { Answer, AskQuestion } from "../core/ask.ts";
import type { History } from "../core/history.ts";
import type { Blocked, NewSessionMode, PermissionMode } from "../core/permission-mode.ts";
import type { Command, Typed } from "../terminals/types.ts";

/** A running session, as its agent lists it: core's Session is this, with where a terminal adapter reaches it. */
export type AgentSession = {
  sessionId: string;
  /** The agent's own name for it: Claude Code makes one up from the folder ("atlas-agents-9a") until it's renamed. */
  name: string;
  /** The name it was given (Claude Code's /rename, by you or by the app for you), else "". */
  givenName: string;
  /** The agent's automatic title for the conversation, or "". */
  title: string;
  cwd: string;
  kind: "interactive" | "background";
  /**
   * busy (in a turn: what "working" means everywhere; never only because something it started still
   * runs in the background, which is `background`) | idle | blocked (something in its window waits
   * on you: a permission prompt, a dialog) | waiting (it stopped on a question of its own, nothing
   * held: a background job asking what next) | …
   */
  status: string;
  /**
   * What it still runs in the background (shells, subagents), shown quietly beside its status
   * ("idle · 2 in background"), never as working. Left out when nothing does, or its agent can't
   * tell (Claude Code tells only for its background jobs: claude-code/background.ts).
   */
  background?: Background;
  /** When it was last active (ms epoch); 0 if unknown. */
  lastActiveAt: number;
  /** Runs in the Claude desktop app, not in a terminal. */
  desktop: boolean;
  /** What its terminal window may be titled, for the terminal adapters to find it by. */
  titles: string[];
  /** Its process, when the agent knows it: the terminal adapters find its tmux pane by it. */
  pid?: number;
  /**
   * Other IDs the same conversation goes by, which find it too (core/sessions.ts findSession):
   * Claude Code's terminal session whose turns a background process now runs, listed as that
   * process (claude-code/sessions.ts `continuations`).
   */
  aliases?: string[];
  /** The agent that lists it (its `id`), when that isn't the main one (Claude Code): src/agents/index.ts agentOf. */
  agent?: string;
  /**
   * Words typed into it always go in as one bracketed paste, a line or several (Codex: its TUI takes
   * keys that come fast as a paste, and an Enter within 120ms of them as a new line, not a send).
   */
  bracketed?: boolean;
  /**
   * Its TUI's executable as the terminal shows it (tmux's pane_current_command: "codex"), for a
   * session whose process the agent doesn't know (Codex 0.166's hooks run in its shared app-server
   * daemon, far from its TUI): the terminal adapters find its pane by that and its folder instead.
   */
  program?: string;
  /**
   * Claude Code's background job (`claude stop` ends it): the one this session is, or the one its
   * turns were moved into (claude-code/sessions.ts `continued`).
   */
  jobId?: string;
  /**
   * Its permission mode now, as its agent last said it (core/permission-mode.ts): Claude Code's hooks,
   * on each event that carries `permission_mode`; Codex's daemon, as a thread's settings change.
   * Left out while it isn't known (no hook has run for it yet; an agent that never says).
   */
  mode?: PermissionMode;
  /**
   * The terminal app it runs in, as its hooks last said it (core/terminal-apps.ts sessionTerminal:
   * "ghostty", "iterm", "kiko-tmux"…); left out while none has (Ghostty is then listed only while it runs).
   */
  terminal?: string;
  /**
   * The pane its hooks last said it runs in, where its terminal says one (a Rex block, REX_BLOCK):
   * the terminal adapters look there first (Findable.pane), and take it only while its process is in it.
   */
  pane?: string;
};

/**
 * What a session still runs in the background: how many (`count`), and how many of them have shown
 * no sign of life (output, a transcript written) for 10 minutes or more (`quiet`), with when the
 * longest quiet one last did (`quietSince`, ms epoch): one left over, stuck. Both left out when none is.
 * `agents`: how many of them are subagents (the rest shells, monitors), where it's known.
 */
export type Background = { count: number; agents?: number; quiet?: number; quietSince?: number };

/** What `Agent.end` needs of a session. */
export type Endable = Pick<AgentSession, "sessionId" | "aliases" | "kind" | "desktop" | "pid" | "jobId">;

/** Whether `Agent.end` sent its signal (or command): the processes it ended, to watch go; or why not. */
export type Signalled = { sent: true; pids: number[] } | { sent: false; why: string };

/**
 * What Kiko can do to a session, besides hearing it and answering what it holds for you (a
 * finished turn, a permission, its questions: `Held`, from any agent): take your words at any
 * moment, have its current turn interrupted, be renamed, be closed. The one list the menus, the
 * router's descriptions, voice commands and the phone read (core/can.ts canDo); in Kiko's tmux
 * all of it, elsewhere what a terminal adapter can be sure of plus what its agent does itself (`Agent.can`;
 * its `reply` there: it takes your words itself, `Agent.message`, found by the agent adapter in src/terminals/agent/).
 */
export type Can = { reply: boolean; interrupt: boolean; rename: boolean; close: boolean };

/** Whether an agent did something to a session itself (`Agent.interrupt`, `Agent.rename`), or why not (said out loud). */
export type Done = { done: true } | { done: false; why: string };

/** A session known by its folder and ID alone (from a hook, or a line of the timeline). */
export type SessionRef = { sessionId: string; cwd: string };

/** The tool a permission prompt asks to use, and its input. */
export type ToolUse = { name: string; input: Record<string, unknown> | undefined };

/**
 * A session held by its agent, waiting for you: a finished turn (its words in `text`), or a
 * permission prompt (`tool`). The floor holds it until it's answered or let go, or it goes away
 * by itself (`onClosed`: a timeout, or the session was interrupted).
 */
export interface Held {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isPermission: boolean;
  /** Still held: an answer reaches it. */
  readonly open: boolean;
  /** Runs in the Claude desktop app. */
  readonly desktop: boolean;
  /** A finished turn: what it said last ("" when nothing). */
  readonly text: string;
  /** A finished turn that came of a reply through its hold, not one it stopped on by itself. */
  readonly continued: boolean;
  /** A permission prompt: the tool it wants to use. Null for a finished turn. */
  readonly tool: ToolUse | null;
  /** A permission prompt that can be allowed for good ("don't ask again"). */
  readonly canAllowAlways: boolean;
  /**
   * A permission prompt that is the agent asking you questions (Claude Code's AskUserQuestion): the
   * questions, answered with answerQuestions(). Null for any other prompt, and for a finished turn.
   */
  readonly questions: AskQuestion[] | null;
  /** It went away first (its timeout, or the session was interrupted). */
  onClosed: () => void;
  /**
   * How it went away, when its agent said (read in `onClosed`): `terminal`, answered in its own
   * window (OpenCode's permission.replied). Unset: its hook closed.
   */
  readonly closedHow?: "terminal";
  /**
   * A permission prompt whose agent shows no prompt of its own while it's held, so only Kiko's cards
   * answer it then (Codex: its hooks run first, and its own prompt shows only once the hook gives no
   * decision). Unset: its agent's own dialog is up beside it (Claude Code, OpenCode, T3 Code).
   */
  readonly onlyHere?: boolean;
  /**
   * The agent whose hook holds it (its id: "claude-code", "codex"), where that hook says. Kiko allows
   * a read-only call by itself only for these (core/auto-allow.ts); unset for the rest (OpenCode's,
   * T3 Code's, and Kiko's own cards).
   */
  readonly agent?: string;
  /**
   * A permission prompt answered (or cancelled) in its agent's own dialog while it's held, with
   * nothing to say so through its hold (Claude Code: its hook keeps running): `answered` is called
   * once, with what showed it, for as long as it's held. Missing: its agent tells (`onClosed`).
   */
  watchAnswered?(answered: (sign: string) => void): void;
  /** What you last asked the session, from its own record. */
  lastAsked(): string;
  /**
   * A finished turn: your words that reached the session during it, oldest first, from its own
   * record: its prompt, a reply through its last hold, and messages sent while it was busy, typed by
   * hand or by the app. Null when it can't tell: a permission prompt, no record, or an agent without one.
   */
  saidThisTurn(): string[] | null;
  /**
   * Calls `typed` with each thing typed into the session by hand while it's held (it waits in the
   * agent's queue until the hold lets go), for as long as it's held. Nothing, for an agent that
   * can't tell.
   */
  watchTyped(typed: (text: string) => void): void;
  /** A finished turn: carries on with `reply`, or stops (null). False when it was gone already. */
  answer(reply: string | null): boolean;
  /** A permission prompt: allowed, for good when `always` (and it can be). */
  allow(always: boolean): boolean;
  /** A permission prompt: denied, with why, for the agent to see. */
  deny(message: string): boolean;
  /** Questions (`questions`): answered, one answer per question, as if at the agent's own prompt. */
  answerQuestions(answers: Answer[]): boolean;
  /** Lets it go without an answer: a finished turn stops, a permission prompt falls back to the session's own. */
  release(): boolean;
}

/**
 * How an agent's sessions are told apart in the lists (src/ui/marks.ts): a glyph before each name,
 * glyph and name in its colour. `glyph`: plain Unicode, one cell wide and never an emoji (✳ is one
 * in some fonts, two cells wide), so it lines up in every terminal and inside tmux; one that isn't is
 * drawn as the plain mark. Each gets a slot two cells wide, for a glyph a fallback font draws wider
 * than its cell (marks.ts). `nerd`: a Nerd Font icon (a Private Use Area character), shown instead
 * with the "Nerd Font icons" setting on.
 * `color`: hex, one for a dark background and one for a light one; left out, the terminal's own
 * colour. Where each agent's come from: ARCHITECTURE.md, "Agent marks".
 */
export type AgentMark = { glyph: string; nerd?: string; color?: { dark: string; light: string } };

/** A folder an agent's own app starts sessions in (T3 Code: a project there), with the names it goes by (its title, its folder's name). */
type LaunchProject = { cwd: string; names: string[]; lastUsed: number };

/**
 * What a new session started in an agent's own app was asked: in `cwd` (one of `projects()`), named
 * `name` and with `prompt` as its first message (each "" for none), on `agent` (the id of another
 * agent named in the words, "a T3 thread on Codex": what runs it there, where the app can choose;
 * "" for the app's own default).
 */
export type Launch = { cwd: string; name: string; prompt: string; agent: string };

/** Started: its session's ID (listed once its agent lists it). Not: why, as a sentence to say. */
export type Launched = { started: true; sessionId: string } | { started: false; why: string };

/** An agent's own app, which starts its sessions itself (Agent.launches). */
type Launcher = {
  /** It can start one now (T3 Code: connected). */
  ready(): boolean;
  /** The folders it starts sessions in (T3 Code: its projects); [] while it isn't ready. */
  projects(): LaunchProject[];
  start(launch: Launch): Promise<Launched>;
};

/** A coding agent's sessions, its events, and what to type to manage one. */
export interface Agent {
  /** "claude-code". */
  readonly id: string;
  /** "Claude Code". */
  readonly name: string;
  /**
   * Who speaks in its sessions, as a spoken summary says it: "Claude" for Claude Code ("In pixie,
   * Claude says…"), "Codex", "OpenCode". Left out where it can't be told (T3 Code's threads run on
   * Claude or Codex): the summary says "it".
   */
  readonly speaker?: string;
  /**
   * Its sessions live in its own app, not in a terminal (T3 Code's threads): a prompt let go of waits
   * "in T3 Code", and the router says so. Left out: they run in a terminal, as Claude Code's and Codex's do.
   */
  readonly ownApp?: boolean;
  /**
   * Kiko can start one of its sessions in a terminal (`startCommand`): the main agent by default,
   * another only when you name it ("start a Codex session in pixie": `heard`) or the "New sessions
   * in" setting picks it. Left out: it can't (T3 Code's threads start in T3 Code).
   */
  readonly starts?: boolean;
  /** How speech-to-text writes its name, said for a new session ("a Codex session"): what picks it. */
  readonly heard?: RegExp;
  /**
   * For one whose sessions start in its own app, not a terminal (`starts` left out; T3 Code's threads,
   * made on its server): asked of by name (`heard`), a session starts there while it's `ready()`;
   * while it isn't, the app starts one in a terminal instead and says so (app/new-session.ts startInApp). Left
   * out: it isn't one you'd ask a session of.
   */
  readonly launches?: Launcher;
  /** Its sessions' mark in the lists (✻ for Claude Code, in its orange). Left out: a plain ◇ in the terminal's colour. */
  readonly mark?: AgentMark;
  /**
   * Whether a session ID is one of its sessions', for one known only by its ID (a hook, the
   * timeline, the phone). Every agent but the main one says; the main one has the rest.
   */
  owns?(sessionId: string): boolean;
  /**
   * Something to tell you once, said out loud as it is ("T3 Code updated in a way this Kiko
   * doesn't know yet…"). Set before start(); an agent with nothing to say never calls it.
   */
  onNotice: (line: string) => void;
  /** A finished turn or a permission prompt, held for you. Set before start(). */
  onHeld: (held: Held) => void;
  /**
   * A session started or ended, or a turn of one did (its status changed), as the agent tells it:
   * core lists them again now rather than at its next look. Once for several that come together.
   * Claude Code says so through its SessionStart and SessionEnd hooks, and a turn's through
   * UserPromptSubmit and Stop; OpenCode's session events would.
   */
  onSessionsChanged: () => void;
  /**
   * A session took a prompt in and starts its turn (`prompt`: what it took in), as the agent tells
   * it: words typed into it from the phone have started. Claude Code says so through its optional
   * UserPromptSubmit hook, T3 Code as a thread's run starts; an agent that can't tell never calls it.
   */
  onPromptSubmitted: (sessionId: string, prompt: string) => void;
  /**
   * Whether a prompt a session just took in is your dictated words, typed into it by the app
   * (core/dictated.ts): asked just before onPromptSubmitted by an agent whose hook can add context to
   * a prompt (Claude Code's and Codex's UserPromptSubmit), which then tells the agent it was spoken
   * (hooks/lib.mjs VOICE_PROMPT). Each typed message counts once. Core sets it on the agents
   * together; unset, or an agent with no such hook (OpenCode, T3 Code): never.
   */
  dictated?: (sessionId: string, prompt: string) => boolean;
  /**
   * A session ended, as the agent tells it, at once (onSessionsChanged comes a moment later, for
   * them all): a Close waiting for it to exit goes on. Claude Code says so through its SessionEnd hook.
   */
  onSessionEnded: (sessionId: string) => void;
  /**
   * The agent's own safety layer blocked one of a session's tool calls without asking, as the agent
   * tells it: Claude Code's auto mode (its PermissionDenied hook), offered as a card to allow it anyway
   * where that can be done (core/block-override.ts), else said; OpenCode's deny rules (its service's
   * events), said. An agent that can't tell leaves it alone; core sets it on the agents together
   * (src/agents/index.ts).
   */
  onBlocked?: (blocked: Blocked) => void;
  /**
   * Kiko's safety gate (core/guard.ts): a tool call the hooks' rules flagged, about to run; its
   * verdict decides whether you're asked first. Core sets it on the agents together; an agent with no
   * hook before a tool runs (OpenCode, T3 Code) never calls it. Unset: the rules' own verdict.
   */
  onGuard?: (check: GuardCheck) => Promise<GuardVerdict>;
  /**
   * Whether the agent trusts a folder, so a session it starts there doesn't stop to ask first
   * (Claude Code's "trust this folder?" prompt); null when it can't tell. An agent that never asks
   * leaves it out.
   */
  folderTrusted?(folder: string): boolean | null;
  /** Starts hearing its sessions (Claude Code: the hooks socket). Throws when another Kiko has it. */
  start(): Promise<void>;
  stop(): void;
  /**
   * How its sessions get to reach Kiko: whether it's installed here, whether Kiko's hooks are in
   * its files, and putting them in or taking them out (./setup.ts lists them all, for the first-run
   * card, the "Agents" settings and `kiko setup`). Left out: nothing to set up.
   */
  readonly setup?: AgentSetup;
  /** The sessions running now that someone can talk to. */
  list(): Promise<AgentSession[]>;
  /** A session's given name and title, for one known only by its folder and ID. */
  names(of: SessionRef): { givenName: string; title: string };
  /** What you last asked a session, and the last thing it said, from its own record. */
  lastAsked(of: SessionRef): string;
  lastSaid(of: SessionRef): string;
  /** Follows a session's conversation: `changed` gets it at once, then each time it changes. */
  watchHistory(of: SessionRef, changed: (history: History) => void): { stop(): void };
  /**
   * The file `watchHistory` follows (Claude Code: its transcript), for a process of its own to follow
   * the same way: the Kiko window's read-only view of a session outside its tmux. "" when it
   * has none (T3 Code: its threads are on its server).
   */
  historyFile(of: SessionRef): string;
  /** A folder the agent made up for a session started without one: such a session goes by its title. */
  madeUpFolder(cwd: string): boolean;
  /** Replies through a held turn it takes in a row; past that, your words are typed in instead. */
  readonly heldReplies: number;
  /** The key that interrupts a session's current turn in its terminal. */
  readonly interruptKey: string;
  /** What to type into a session to rename it; "" when it can't be renamed by typing. */
  renameCommand(name: string): string;
  /** What to type into a session to end it cleanly (it saves its conversation, runs its end hooks); "" when nothing does. */
  readonly exitCommand: string;
  /**
   * Ends a session nothing can type `exitCommand` into (one outside Kiko's tmux) from outside its
   * terminal, cleanly still (Claude Code: SIGTERM, `claude stop` for a background job; it saves its
   * conversation and runs its end hooks), after checking its process is still that session's. Not
   * sent says why; sent names the processes to watch go. An agent that can't leaves it out.
   */
  end?(session: Endable): Promise<Signalled>;
  /**
   * What it does to a session itself, with no terminal (core/can.ts canDo adds what a terminal can):
   * Claude Code closes one outside Kiko's tmux whose process or job it knows (`end`); T3 Code
   * interrupts, renames and archives its threads through its server. Left out: nothing.
   */
  can?(session: Omit<AgentSession, "titles">): Partial<Can>;
  /** Interrupts a session's current turn itself (T3 Code: through its server), for one `can` says it can: no key typed. */
  interrupt?(session: SessionRef): Promise<Done>;
  /** Renames a session itself (T3 Code: its thread's title), at any moment, for one `can` says it can: nothing typed. */
  rename?(session: SessionRef, name: string): Promise<Done>;
  /**
   * Sends your words to a session itself, as a new message through its own server (OpenCode's), at
   * any moment, wherever it runs: for one `can` says `reply` of, found by the agent adapter
   * (src/terminals/agent/) where no terminal adapter reaches it first. Left out: words are typed.
   */
  message?(session: SessionRef, text: string): Promise<Typed>;
  /**
   * How its Close reads, for an agent whose sessions don't end as a process does (T3 Code: a thread
   * is archived): the menu's words, the question asked first, and what's said once it's done.
   * Left out: Claude Code's ("Close this session…").
   */
  readonly ending?: { label: string; ask(name: string, busy: boolean): string; done(name: string): string };
  /** The command that starts a session: with `prompt` as its first message and `name` as its name, when they aren't "". */
  startCommand(start: NewSession): Command;
  /**
   * Whether its installed version takes `mode` as it starts (Claude Code: `claude --help`'s
   * `--permission-mode` choices, read once a run: claude-code/modes-offered.ts). Asked only to start
   * a scratch session in auto (core/permission-mode.ts startModeFor). Left out: never asked, so its
   * scratch sessions start in the setting's mode like any other (Codex, OpenCode).
   */
  offersMode?(mode: PermissionMode): Promise<boolean>;
  /**
   * Its startCommand can't name a session (Codex has no flag for it): one started with a name is
   * renamed (renameCommand) once it's listed and idle. Left out: the command names it (`claude --name`).
   */
  readonly namesLater?: boolean;
  /**
   * For an agent that lists a session only from its first message (Codex makes one then): whether a
   * window it was started in, still starting, shows it ready for that message (its prompt up, nothing
   * asked in front of it), so Kiko can type in words held for it (Terminal.placeIn). Left out:
   * its sessions are listed as they start, and words wait for that.
   */
  readyOnScreen?(screen: string): boolean;
  /**
   * Whether what's in front in a pane of Kiko's tmux (its pane_current_command: "codex") is this
   * agent's TUI. A pane that runs it, which no listed session is in and Kiko didn't open (`kiko
   * codex`, or typed in a shell there), is listed as one of its sessions starting, from its pane, so
   * it's in the list and reachable before (or without) its hooks. Left out: never looked for (Claude
   * Code registers its sessions as they start, and its native install shows a version number there).
   */
  runsAs?(command: string): boolean;
  /** The folders it has run sessions in that are still there, from its own history. */
  knownFolders(): KnownFolder[];
}

/** A folder the agent has run sessions in, from its own history: what a new session can open in by name (core/projects.ts). */
export type KnownFolder = {
  cwd: string;
  /** Names its sessions were given there (Claude Code's /rename); its folder's name isn't one of them. */
  names: string[];
  /** When a session last ran there (ms epoch); 0 if unknown. */
  lastUsed: number;
};

/**
 * What a new session starts with: its first message and its name, each "" for none; and the
 * permission mode it starts in (the "Permission mode" setting, core/permission-mode.ts), which each
 * agent maps to its own flags as best it honestly can. Left out, or "inherit": no flag, its own default.
 * `madeFolder`: the folder, when Kiko made it for this session just now (a fresh scratch folder): an
 * agent may trust it for this launch (Codex: codex/launch.ts). Never set for a folder you chose.
 */
export type NewSession = { prompt: string; name: string; mode?: NewSessionMode; madeFolder?: string };

/**
 * Where an agent stands with Kiko: its hooks in and working (connected), not in (not connected),
 * in but broken (needs repair: a hook's script gone, the repo moved; or one it can't do without
 * missing), the agent not on this Mac (not installed), or nothing to set up: Kiko finds it when it
 * runs (automatic: T3 Code; one you said no to is "not connected": off).
 */
export type SetupState = "connected" | "not connected" | "needs repair" | "not installed" | "automatic";

/**
 * Its state, and a few words on it for the card and settings ("adds hooks to ~/.claude/settings.json",
 * "Stop isn't on", "running: Kiko connects when it starts"). `unreadable`: its file isn't JSON,
 * so Kiko leaves it alone (nothing to offer; settings say so). `partial`: connected, but Connect
 * would add more (Claude Code's optional hooks): what ("SessionEnd, UserPromptSubmit not on").
 */
export type SetupStatus = { state: SetupState; detail: string; unreadable?: boolean; partial?: string };

/**
 * What connecting (or repairing, or disconnecting) changed: the file, the events Kiko's hook went
 * on (or came off), the copy of the file as it was (null: nothing written, or there was no file), and
 * how many of Kiko's entries were pointed at where its hook is now (a repair).
 */
export type Changed = { file: string; events: string[]; backup: string | null; repointed?: number; refreshed?: string[] };

/**
 * Kiko's hook events in an agent's file, as AgentSetup.hookEvents says (`stale`: events whose entry
 * of Kiko's has another matcher or timeout than this Kiko's, brought up to date by the start's upgrade).
 */
export type HookEvents = { all: readonly string[]; missing: string[]; ours: boolean; gone: boolean; stale?: string[] };

/**
 * An agent's setup, as one entry: a new agent (OpenCode, Pi) is one more of these in ./setup.ts.
 * Imports nothing that loads .env or writes logs: the CLI and first-run setup use it too.
 */
export interface AgentSetup {
  /** The agent's id and name, as its adapter's ("codex", "Codex"). */
  readonly id: string;
  readonly name: string;
  /**
   * How it's listed where you pick the agents to connect (setup's boxes, "Also works with", the
   * first-run card, settings → Agents; ./setup.ts labelOf), when its name alone could be another
   * app: "Codex CLI", not the Codex desktop app. What's said and the sessions' marks keep `name`.
   * Left out: its name.
   */
  readonly label?: string;
  /** What it does, for its row in settings: a line or two (its file is shown under it, its actions' hints say what they do). */
  readonly about: string;
  /**
   * Kiko can start its sessions (its adapter's Agent.starts, said here too for what can't load the
   * adapters: the settings' "New sessions in" choices). Left out: it can't.
   */
  readonly starts?: boolean;
  /** The file its hooks go in, as shown (~ for the home folder); "" when it needs none. */
  file(): string;
  /** Whether it's on this Mac (its program on PATH, or its folder). */
  installed(): boolean;
  /** Whether you're signed in to it, when it can tell without reading secrets; left out (or null): not known. */
  signedIn?(): boolean | null;
  /** Where it stands now, read from its file each time (./setup.ts statusOf adds `health`). */
  status(): SetupStatus;
  /**
   * A look past the file: whether its hooks actually work (they fire, the agent's version takes
   * them). A problem's words make a connected agent "needs repair"; null: nothing wrong, or can't
   * tell. Left out: the file is all there is to check.
   */
  health?(): string | null;
  /**
   * Kiko's hooks into its file, next to the ones there (each kept, in its place), after a backup;
   * or, for one that needs repair, its entries pointed where Kiko's hook is now and the missing
   * ones added. `only`: just these of its events added, none other (the start's upgrade, ./setup.ts
   * upgradeHooks); left out, every one missing. Throws, changing nothing, when the file isn't JSON.
   * Left out: nothing to connect.
   */
  connect?(only?: readonly string[]): Changed;
  /**
   * Kiko's hook events in its file, for the start's upgrade (./setup.ts upgradeHooks): every event
   * this Kiko hooks (`all`), the ones its hook isn't on there (`missing`), whether any of its
   * entries are there at all (`ours`: connected), whether any of their scripts is gone (`gone`:
   * needs repair). Throws as connect does. Left out: no hooks file of its own (OpenCode, T3 Code).
   */
  hookEvents?(): HookEvents;
  /**
   * Its hook events as they were before Kiko upgraded its own hooks at start (2026-10-30, when
   * PermissionDenied was new): what an install with no record of its own (the settings' hooksKnown)
   * is taken to have been given. One missing from the file that's in here was left off or taken out,
   * so it isn't put back; one that isn't is new, and goes in. Never changes as events are added.
   */
  readonly hooksBefore?: readonly string[];
  /** Kiko's own entries out of its file, nothing else, after a backup. Throws as connect does. */
  disconnect?(): Changed;
  /**
   * What connect would change, said before asking (`kiko setup`): the command its hook runs, the
   * events it would go on, and how many of Kiko's entries it would point anew. Throws as connect does.
   */
  plan?(): { command: string; events: string[]; repoint: number };
  /** What to tell once it's connected ("Codex asks you to trust them once, at its next start."). */
  readonly afterConnect?: string;
  /**
   * Its sessions already open don't speak up until they're restarted (they read its hooks as they
   * start): said in setup's one short line once it's connected (./setup.ts cardSaid).
   */
  readonly restartOpen?: boolean;
  /** What it asks of you at its next start, in a few words, for that same line ("Codex asks once to trust its hooks"). */
  readonly nextStart?: string;
  /** Lines `kiko setup` says before asking (Codex: it asks to trust new hooks; Claude Code: no status line). */
  readonly beforeConnect?: string[];
  /** What `kiko setup` adds when it's connected already and sessions still don't speak up ("trust them in Codex: /hooks"). */
  readonly stillQuiet?: string;
  /** The word for it on the command line (`kiko setup claude`). */
  readonly word?: string;
  /**
   * For an agent Kiko reaches through its own server rather than hooks in its files (OpenCode):
   * what being connected means, said where hooks would be ("Kiko listens to OpenCode's background
   * service"). Connect and Disconnect then change only Kiko's own settings, nothing of the
   * agent's, and nothing is backed up. Left out: hooks in its file (`file`).
   */
  readonly linkWords?: string;
}
