// The coding agents Kiko talks to, listed once at startup: the one place that names them. Core
// and the entry points import `agent` (and `agentOf`) from here, and the shapes from ./types.ts.
//
// Several at once: every session knows its agent (AgentSession.agent, or the ID it goes by: `owns`),
// as it knows the terminal adapter that reaches it. `agent` stands for them all: it lists every
// agent's sessions together, and whatever is about one session (its names, history, what it last
// said) goes to that session's own agent. What isn't about one session (starting a new one, the
// folders it knows, whether a folder is trusted) is the main agent's: Claude Code's. Each agent's
// setup (connecting its hooks) is its own: `agents.map((a) => a.setup)`, also listed in ./setup.ts.
// Except a new session in another agent: one you name ("start a Codex session in pixie"), or, with
// more than one connected (`offeredStarters`), the one picked or preselected (core/agent-pick.ts);
// that one's startCommand is asked. One whose sessions start in its own app (T3 Code: `elsewhere`)
// is asked to start it there (Agent.launches).
import { decideGuard, type GuardCheck } from "../core/guard.ts";
import { claudeCode } from "./claude-code/index.ts";
import { codex } from "./codex/index.ts";
import { opencode } from "./opencode/index.ts";
import { t3code } from "./t3code/index.ts";
import type { Agent, AgentSession } from "./types.ts";

/** Claude Code: the main agent, the one new sessions start in unless another is asked for. */
export const mainAgent: Agent = claudeCode;

/** Every agent, the main one first. */
export const agents: Agent[] = [claudeCode, codex, opencode, t3code];

/** The agents Kiko can start a session of in a terminal (Agent.starts), the main one first. */
export const starters = (among = agents): Agent[] => among.filter((a) => a === mainAgent || a.starts);

/**
 * The agents you can ask a new session of that start their sessions in their own app, not a
 * terminal (Agent.launches: T3 Code's threads, made on its server), asked of by name only.
 */
export const elsewhere = (among = agents): Agent[] => among.filter((a) => a !== mainAgent && !a.starts && a.launches && a.heard);

/**
 * Those of them that can start a session in `cwd` now (their app is there, and it's one of their
 * folders): what the window's picker offers beside the agents that start sessions in a terminal.
 */
export const launchersIn = (cwd: string, among = agents): Agent[] => elsewhere(among).filter((a) => a.launches!.ready() && a.launches!.projects().some((p) => p.cwd === cwd));

/**
 * The agents a new session can start in when none is named, the main one first: each that starts
 * sessions (`starters`) whose hooks are in its files (its setup's status: connected, or needing
 * repair; one with nothing to set up counts), read from its files each time. None of them: the main
 * one alone. More than one: the window asks which (core/agent-pick.ts), voice names the one it starts.
 */
export function offeredStarters(among = agents): Agent[] {
  const hooked = (a: Agent) => {
    if (!a.setup) return true;
    try {
      const state = a.setup.status().state;
      return state === "connected" || state === "needs repair";
    } catch {
      return false;
    }
  };
  const ready = starters(among).filter(hooked);
  return ready.length ? ready : [mainAgent];
}

/**
 * The agent a new session starts in: `asked` (an agent's id, from the router), else `byDefault`
 * (the "New sessions in" setting), else the main one; only one that starts sessions (`starters`).
 */
export function starter(asked: string | null | undefined, byDefault: string | null | undefined, among = agents): Agent {
  const can = starters(among);
  return can.find((a) => a.id === asked) ?? can.find((a) => a.id === byDefault) ?? mainAgent;
}

/** The agent a session belongs to: the one that listed it, else the one that owns its ID, else the main one. */
export function agentOf(session: { sessionId: string; agent?: string }): Agent {
  if (session.agent) {
    const listed = agents.find((a) => a.id === session.agent);
    if (listed) return listed;
  }
  return agents.find((a) => a !== mainAgent && a.owns?.(session.sessionId)) ?? mainAgent;
}

/** Every agent's sessions together: the main agent's as it lists them (its failure is the listing's), the others' when they can. */
async function listAll(main: Agent, among: Agent[]): Promise<AgentSession[]> {
  const lists = await Promise.all(
    among.map((a) =>
      a === main
        ? a.list()
        : a.list().then(
            (sessions) => sessions.map((s) => ({ ...s, agent: a.id })),
            () => [] as AgentSession[],
          ),
    ),
  );
  return lists.flat();
}

/**
 * All the agents as one: the shape core has always used. The callbacks core sets on it (onHeld,
 * onSessionsChanged, …) get every agent's events.
 */
export function together(main: Agent, among: Agent[]): Agent {
  const others = among.filter((a) => a !== main);
  const of = (sessionId: string) => others.find((a) => a.owns?.(sessionId)) ?? main;
  const all: Agent = {
    id: main.id,
    name: main.name,
    onHeld: () => {},
    onSessionsChanged: () => {},
    onPromptSubmitted: () => {},
    onSessionEnded: () => {},
    onNotice: () => {},
    onBlocked: () => {},
    onGuard: rulesOnly,
    folderTrusted: main.folderTrusted ? (folder) => main.folderTrusted!(folder) : undefined,
    // The main agent's start failing is the app's (another Kiko has its socket); the others start
    // on their own, and a failure of theirs is theirs to say.
    async start() {
      await main.start();
      for (const a of others) {
        a.start().catch(() => {});
      }
    },
    stop() {
      for (const a of among) a.stop();
    },
    list: () => listAll(main, among),
    names: (s) => of(s.sessionId).names(s),
    lastAsked: (s) => of(s.sessionId).lastAsked(s),
    lastSaid: (s) => of(s.sessionId).lastSaid(s),
    watchHistory: (s, changed) => of(s.sessionId).watchHistory(s, changed),
    historyFile: (s) => of(s.sessionId).historyFile(s),
    madeUpFolder: (cwd) => among.some((a) => a.madeUpFolder(cwd)),
    get heldReplies() {
      return main.heldReplies;
    },
    get interruptKey() {
      return main.interruptKey;
    },
    renameCommand: (name) => main.renameCommand(name),
    get exitCommand() {
      return main.exitCommand;
    },
    startCommand: (start) => main.startCommand(start),
    knownFolders: () => main.knownFolders(),
  };
  for (const a of among) {
    a.onHeld = (held) => all.onHeld(held);
    a.onSessionsChanged = () => all.onSessionsChanged();
    a.onPromptSubmitted = (sessionId, prompt) => all.onPromptSubmitted(sessionId, prompt);
    a.dictated = (sessionId, prompt) => all.dictated?.(sessionId, prompt) ?? false;
    a.onSessionEnded = (sessionId) => all.onSessionEnded(sessionId);
    a.onNotice = (line) => all.onNotice(line);
    a.onBlocked = (blocked) => all.onBlocked?.(blocked);
    a.onGuard = (check) => (all.onGuard ? all.onGuard(check) : rulesOnly(check));
  }
  return all;
}

/** The gate's verdict with nothing but its rules (core/guard.ts): before the app sets its own. */
const rulesOnly = (check: GuardCheck) => decideGuard(check, { on: true, off: [] });

/** Every agent as one (see `together`). */
export const agent: Agent = together(mainAgent, agents);
