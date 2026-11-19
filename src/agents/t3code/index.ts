// T3 Code (github.com/pingdotgg/t3code), the second agent: its threads, over its local server's
// WebSocket (./client.ts, ./rpc.ts; signed in with a short-lived token from its CLI: ./auth.ts), as
// Kiko's sessions (./mapping.ts). Minimal for now:
//
//   listed        each thread that's neither archived nor settled: named by its title, in its project's folder
//   started       a run that took your message in (sent from here, or typed in T3): told as Claude
//                 Code's UserPromptSubmit is (onPromptSubmitted), with that message
//   heard         a run that completed: its last reply read (subscribeThread) and announced as a
//                 finished turn that can't be held (`open` false from the start), so it's read out
//                 with no reply window (../types.ts)
//   replied to    your words go to the thread as a new message, at any moment, through its keyless
//                 terminal adapter (src/terminals/t3code/: message.dispatch)
//   needs you     a thread waiting on a permission or a question shows as blocked, and is held as
//                 Claude Code's permission prompt is (./requests.ts): asked on the Mac's card, by
//                 voice and on the phone, the answer sent back to T3 (runtime-request.respond). One
//                 that can't be read here is said once, and answered in T3 Code
//   interrupted   its run stopped (thread.stop, or run.interrupt): the menus' Interrupt, "stop <thread>"
//   renamed       its title (thread.metadata.update): the menus' Rename…, "rename <thread> to …"
//   closed        archived (thread.archive; its run stopped first): the menus' Close, asked first;
//                 it can be brought back in T3
//   started anew  a new thread, by voice or the phone ("a T3 thread in pixie and …"), or the window's
//                 picker: made on T3's server as its client makes one (orchestration.launchThread:
//                 ./launch.ts), in a T3 project, with its first message (`launches`; app/new-session.ts startInApp)
//   history       its messages, read from T3 when the phone opens it, and again as the thread changes;
//                 in the Kiko window, read-only, from a file kept to it while it's shown (./mirror.ts)
//
// When T3 isn't running, or speaks another protocol, it lists nothing and Kiko works as before.
// When you said no to it (setup, the card, settings → Agents' Turn off: agentAnswers), Kiko never
// connects to it, so it lists nothing either; turned on again, it connects at once (app/settings/agents.ts).
import { basename, dirname, join } from "node:path";
import { log } from "../../core/log.ts";
import { envVar } from "../../core/name.ts";
import { pagePath } from "../../core/page.ts";
import { agentRefused } from "../../core/settings.ts";
import { Mirrors, watched } from "../mirror.ts";
import type { Agent, Done, Held } from "../types.ts";
import { T3Client, type Completed, type Dispatched, type Started } from "./client.ts";
import { DRIVERS } from "./launch.ts";
import { PREFIX, sessionIdOf, T3_AGENT, threadIdOf, type ShellThread } from "./mapping.ts";
import { T3Held, type Pending } from "./requests.ts";
import { t3codeSetup } from "./setup.ts";

/** The one connection to T3 (its terminal adapter sends through it too). KIKO_T3_HOME and KIKO_T3_PORT point it elsewhere (the tests' fake T3). */
export const t3 = new T3Client(() => {
  const port = Number(envVar("T3_PORT") ?? 0);
  return { home: envVar("T3_HOME") || undefined, port: port > 0 ? port : undefined };
});
// Shown as connected in the card and settings while Kiko's connection to it is up. Before it's
// started (setup, the CLI): null, and its setup looks for T3 itself.
t3codeSetup.running = () => (t3.keeping ? t3.connected : null);

const name = (thread: ShellThread) => thread.title.trim() || "A thread";

/** The threads shown in the Kiko window, as files its viewer follows: next to Kiko's page, in t3/. */
const mirrors = new Mirrors(
  () => join(dirname(pagePath()), "t3"),
  watched((id, changed) => t3.watchThread(id, changed)),
);

export const t3code: Agent = {
  id: T3_AGENT,
  name: "T3 Code",
  // No `speaker`: a thread runs on Claude or Codex, which Kiko doesn't read from T3 (yet), so its summary says "it".
  // Its threads are in T3 Code's own app, not a terminal; and they start there (`launches`, never startCommand).
  ownApp: true,
  // ⊤, a "T" (its icon is a white "T3" on blue), in its indigo (--primary, hue 264) lifted to read on
  // a dark background and moved off Codex's blue. No Nerd Font icon exists for it.
  mark: { glyph: "⊤", color: { dark: "#7878FF", light: "#5A3FD8" } },
  owns: (sessionId) => sessionId.startsWith(PREFIX),
  onNotice: () => {},
  onHeld: () => {},
  onSessionsChanged: () => {},
  // Set by agents/index.ts; called as a run starts (onStarted, below). Its threads end in T3 (listed again then).
  onPromptSubmitted: () => {},
  onSessionEnded: () => {},
  // Said no to (setup, the card, or settings → Agents' Turn off): left alone, never connected to.
  start: () => (agentRefused(T3_AGENT) ? Promise.resolve() : t3.start()),
  stop: () => {
    mirrors.stop();
    t3.stop();
  },
  // Nothing to set up: when T3 runs, it's found (./setup.ts, shown as connected while it is).
  setup: t3codeSetup,
  // Not connected (T3 quit, or speaks another protocol): none of its threads can be reached.
  list: async () => (t3.connected ? t3.shell.sessions() : []),
  names: (of) => {
    const id = threadIdOf(of.sessionId);
    const title = (id && t3.shell.threads.get(id)?.title.trim()) || "";
    return { givenName: title, title: "" };
  },
  lastAsked: (of) => t3.replies.get(threadIdOf(of.sessionId) ?? "")?.asked ?? "",
  lastSaid: (of) => t3.replies.get(threadIdOf(of.sessionId) ?? "")?.said ?? "",
  watchHistory: (of, changed) => {
    const id = threadIdOf(of.sessionId) ?? "";
    // T3 not there: what's known of it here, what was last asked and said.
    const fallback = () => {
      const reply = t3.replies.get(id);
      const items = reply ? [...(reply.asked ? [{ kind: "you" as const, text: reply.asked, at: null }] : []), ...(reply.said ? [{ kind: "claude" as const, text: reply.said, at: null }] : [])] : [];
      return { items, truncated: true };
    };
    return t3.watchHistory(id, changed, fallback);
  },
  // Its conversation as a transcript's lines, kept to the thread while it's listed (./mirror.ts).
  historyFile: (of) => {
    const id = threadIdOf(of.sessionId);
    return id ? mirrors.path(id) : "";
  },
  madeUpFolder: () => false,
  heldReplies: 0,
  // No keys: nothing to interrupt, rename or exit by typing (its terminal adapter only takes words);
  // all three are done through T3's server instead (can, interrupt, rename, end).
  interruptKey: "",
  renameCommand: () => "",
  exitCommand: "",
  // Listed only while T3 is connected: each listed thread can be.
  can: () => ({ interrupt: true, rename: true, close: true }),
  interrupt: (of) => withThread(of, (id) => t3.interrupt(id)),
  rename: (of, name) => withThread(of, (id) => t3.rename(id, name)),
  // Archived: no process to watch go (`pids` none), and its thread leaves the list as T3 says so.
  end: async (of) => {
    const done = await withThread(of, (id) => t3.archive(id));
    return done.done ? { sent: true, pids: [] } : { sent: false, why: done.why };
  },
  ending: {
    label: "Archive in T3 Code…",
    ask: (name, busy) => `Archive ${name} in T3 Code? It leaves the list; T3 can bring it back.${busy ? " Its current run is stopped first." : ""}`,
    done: (name) => `Archived ${name} in T3 Code.`,
  },
  startCommand: () => {
    throw new Error("T3 Code threads are started in T3 Code");
  },
  // "Open a new session in T3 code." used to open Claude Code in a scratch folder "t3-code": its name, as speech-to-text writes it ("T3", "T three"), is the
  // agent's, and asking for one starts a thread in T3 (core/decide.ts startsElsewhere, app/new-session.ts startInApp).
  heard: /\bt(?:3|-3| 3| three)\b/i,
  // A new thread, made on T3's server as its own client makes one (client.ts launch), in one of its
  // projects; it's listed through the shell as any thread is. T3 not connected: not ready, and the
  // app starts a session in a terminal instead.
  launches: {
    ready: () => t3.connected,
    projects: () => {
      if (!t3.connected) return [];
      const used = new Map<string, number>();
      for (const t of t3.shell.threads.values()) {
        const at = Date.parse(t.updatedAt);
        if (Number.isFinite(at)) used.set(t.projectId, Math.max(used.get(t.projectId) ?? 0, at));
      }
      return [...t3.shell.projects.values()].map((p) => ({
        cwd: p.workspaceRoot,
        names: [p.title.trim(), basename(p.workspaceRoot)].filter(Boolean),
        lastUsed: used.get(p.id) ?? 0,
      }));
    },
    start: async ({ cwd, name, prompt, agent }) => {
      const project = [...t3.shell.projects.values()].find((p) => p.workspaceRoot === cwd);
      if (!project) return { started: false, why: "That project isn't in T3 Code." };
      const made = await t3.launch({ projectId: project.id, name, prompt, driver: agent ? (DRIVERS[agent] ?? null) : null });
      return made.done ? { started: true, sessionId: sessionIdOf(made.threadId) } : { started: false, why: `I couldn't start a T3 Code thread: ${made.why}.` };
    },
  },
  knownFolders: () => [],
};

t3.onChanged = () => {
  // The files of threads no longer listed (archived, gone, T3 quit) aren't kept up.
  mirrors.keepOnly(new Set(t3.connected ? t3.shell.sessions().map((s) => threadIdOf(s.sessionId) ?? "") : []));
  t3code.onSessionsChanged();
};
t3.onNotice = (line) => t3code.onNotice(line);
t3.onWaiting = (thread, pending) => waitingOf(thread, pending);
t3.onResolved = (threadId, requestId) => {
  const held = asking.get(requestId);
  asking.delete(requestId);
  if (held?.sessionId === sessionIdOf(threadId)) held.resolved();
};
t3.onStarted = (started) => promptOf(started);
t3.onCompleted = (done) => t3code.onHeld(heldOf(done));

/** Its thread's ID, done to; a session that isn't a thread's: said so. */
async function withThread(of: { sessionId: string }, act: (threadId: string) => Promise<Dispatched>): Promise<Done> {
  const id = threadIdOf(of.sessionId);
  return id ? act(id) : { done: false, why: "it isn't a T3 Code thread" };
}

/** The requests held for you now, by their ID: closed when T3 says they're no longer pending. */
const asking = new Map<string, T3Held>();

/**
 * A thread waits on you: held as a permission prompt (or Claude's questions), answered back to T3;
 * one that couldn't be read is said once, as before, and answered in T3 Code.
 */
export function waitingOf(thread: ShellThread, pending: Pending | null, cwd = thread.worktreePath ?? t3.shell.projects.get(thread.projectId)?.workspaceRoot ?? "") {
  if (!pending) return t3code.onNotice(`${name(thread)} in T3 is waiting for you in T3 Code.`);
  const sessionId = sessionIdOf(thread.id);
  const held = new T3Held(
    sessionId,
    cwd,
    pending,
    (response) => {
      asking.delete(pending.id);
      log("t3_respond", { sessionId, requestId: pending.id, ...("decision" in response ? { decision: response.decision } : { answers: Object.keys(response.answers).length }) });
      void t3.respond(thread.id, pending.id, response).then((done) => {
        // Not taken (T3 went away meanwhile): its card in T3 still takes it.
        if (!done.done) t3code.onNotice(`${name(thread)} in T3 didn't get that answer: answer it in T3 Code.`);
      });
      return t3.connected;
    },
    () => t3.replies.get(thread.id)?.asked ?? "",
  );
  asking.set(pending.id, held);
  t3code.onHeld(held);
  return held;
}

/** A run that started: told as Claude Code's UserPromptSubmit is, with the message it took in. */
export function promptOf({ thread, asked }: Started) {
  if (!asked) return;
  const sessionId = sessionIdOf(thread.id);
  log("prompt_submitted", { sessionId, chars: asked.length, agent: T3_AGENT });
  t3code.onPromptSubmitted(sessionId, asked);
}

/** A completed run as a finished turn that can't be held: read out, and replied to as a new message. */
export function heldOf({ thread, said, asked, turn }: Completed, cwd = thread.worktreePath ?? t3.shell.projects.get(thread.projectId)?.workspaceRoot ?? ""): Held {
  return {
    sessionId: sessionIdOf(thread.id),
    cwd,
    isPermission: false,
    open: false,
    desktop: false,
    text: said,
    continued: false,
    tool: null,
    canAllowAlways: false,
    questions: null,
    onClosed: () => {},
    lastAsked: () => asked,
    // Your words that reached the run, from T3's own record: what the phone's talks wait on to be started.
    saidThisTurn: () => (turn?.length ? turn : asked ? [asked] : null),
    watchTyped: () => {},
    answer: () => false,
    allow: () => false,
    deny: () => false,
    answerQuestions: () => false,
    release: () => false,
  };
}
