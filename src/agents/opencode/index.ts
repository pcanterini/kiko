// OpenCode (github.com/anomalyco/opencode, 2.0 on), the fourth agent: its sessions in a terminal, as
// Claude Code's and Codex's are, but no hooks: every OpenCode TUI is a client of one background
// service, and Kiko is one more (./service.ts: its HTTP API and event stream), once you've
// connected it (./setup.ts: nothing of OpenCode's is written).
//
//   listed        while an OpenCode TUI runs in its folder (./processes.ts), from the moment it has
//                 a session (OpenCode makes one at its first message), wherever the terminal is: what
//                 the TUI made, used or looked at since it started (./sessions.ts), never a session
//                 the service only kept. Its TUI quitting drops it within a second (watchTuis). In
//                 Kiko's tmux, a TUI with no session yet is listed from its pane (runsAs, app.ts
//                 adoptPanes)
//   heard         session.execution.succeeded: its last reply read from its messages, held with a
//                 reply window (./requests.ts OpenCodeTurn): the reply goes to it as a new message
//                 (OpenCode doesn't wait on anyone after a turn, so nothing is held there)
//   replied to    at any moment: typed into its pane in Kiko's tmux (found by its TUI's process);
//                 anywhere else, a new message through the service (`message`, the agent adapter in
//                 src/terminals/agent/), never keys. Only while a TUI that has it still runs
//                 (openNow): the service would run a turn for a closed one that nobody sees, so
//                 that's "not sent", and why
//   permissions   permission.asked, held as Claude Code's (card, voice, phone): once, always where it
//                 offers it, or reject with why; let go, it's left asking in its TUI. Answered in its
//                 TUI (permission.replied, with its reply): closed as answered there ("terminal").
//                 Dropped by Esc in its TUI (2.0.32 says nothing of the ask then): closed as gone when
//                 its session's turn is interrupted or fails, or it goes idle (`stopped`)
//   questions     its question tool's forms, asked as Claude Code's AskUserQuestion is, answered back
//                 through the service; any other form (an MCP server's) is said, to answer there
//   status        busy (session.status), blocked while it holds a permission or questions, else idle
//   started       `opencode [--prompt <words>]` in Kiko's tmux ("start an OpenCode session in
//                 pixie"); a name is given through the service once it's listed (namesLater). One
//                 started without words is listed from its first message; words held for it are typed
//                 into its pane once its prompt shows (readyOnScreen)
//   renamed       its title, through the service (PATCH, as Ctrl+R in its TUI), wherever it runs: its
//                 TUI shows it; one renamed there shows here (session.renamed)
//   interrupted   through the service (POST …/interrupt, as Escape in its TUI), wherever it runs
//   closed        /exit typed in Kiko's tmux; elsewhere SIGHUP to its TUI (the one in front only,
//                 after the same checks as Claude Code's: ../process-check.ts), which OpenCode's TUI
//                 takes as its terminal closing: it puts the terminal back and quits
//   history       its messages, as a transcript's lines for the phone and the window (../mirror.ts):
//                 each once it's done (a reply still being written waits), kept up while followed
//   blocks        a call one of your deny rules stopped without asking (session.tool.failed,
//                 permission.rejected: ./requests.ts RuleBlocks): said (onBlocked), never overridden
import { dirname, join } from "node:path";
import { HistoryWatcher, type History } from "../../core/history.ts";
import { log } from "../../core/log.ts";
import { pagePath } from "../../core/page.ts";
import { agentLinked } from "../../core/settings.ts";
import { ASK_TOOL } from "../../core/ask.ts";
import { checkProcess, systemReach, terminate } from "../process-check.ts";
import { stillRuns } from "../processes.ts";
import { Mirrors, watched } from "../mirror.ts";
import type { Agent, AgentSession, Done } from "../types.ts";
import { openCodeProgram, openCodeTuis, type Tui } from "./processes.ts";
import { endedBy, OpenCodeHeld, OpenCodeTurn, permissionOf, questionsOf, repliedHow, repliedOf, RuleBlocks, turnOf, type PermissionReply, type Reply, type RuleBlock, type Turn } from "./requests.ts";
import { OpenCodeService, serviceFile, type Message, type OpenCodeEvent, type OpenCodeSession } from "./service.ts";
import { describe, OPENCODE_AGENT, openSessions, readTabs } from "./sessions.ts";
import { opencodeSetup } from "./setup.ts";

/** The one connection to OpenCode's background service. KIKO_OPENCODE_SERVICE points it at the tests' fake. */
export const service = new OpenCodeService(() => ({ file: serviceFile(), log }));
opencodeSetup.problem = () => (/password/.test(service.why) ? "OpenCode's service didn't take its own password: restart it (opencode service restart)" : null);

/** Whether you've connected OpenCode (./setup.ts): until then nothing of it is read. */
const linked = () => {
  try {
    return agentLinked(OPENCODE_AGENT);
  } catch {
    return false;
  }
};

// What the service told of each session: its info (title, folder, parent), and the words of its
// last turn (lastAsked, lastSaid are asked without waiting).
const sessions = new Map<string, OpenCodeSession>();
const words = new Map<string, { asked: string; said: string }>();
/** The sessions listed last, with the TUI in front of each (Close checks it's still that process). */
let listed: AgentSession[] = [];
const fronts = new Map<string, Tui>();
/** The TUIs in each listed session's folder: it's open while one of them still runs (openNow). */
const holders = new Map<string, Tui[]>();
/** Sessions whose waiting requests were asked for since the service connected (catchUp): once each. */
const caughtUp = new Set<string>();
/** What's held for you now: permission requests and questions by their ID, finished turns by session. */
const asking = new Map<string, OpenCodeHeld>();
const turns = new Map<string, OpenCodeTurn>();
/** Sessions whose next turn comes of a reply through a held one (Held.continued). */
const continuing = new Set<string>();
/** Its tool calls as they go, for one your deny rules stop. */
const ruleBlocks = new RuleBlocks();

/** A session's name as said: its title, else its folder's. */
const nameOf = (sessionId: string, cwd = sessions.get(sessionId)?.cwd ?? "") => sessions.get(sessionId)?.title || cwd.split("/").pop() || "An OpenCode session";

/** A session's info: as listed, else asked. */
async function infoOf(sessionId: string): Promise<OpenCodeSession | null> {
  const known = sessions.get(sessionId);
  if (known) return known;
  const s = await service.session(sessionId);
  if (s) sessions.set(s.id, s);
  return s;
}

/** The top-level session a subagent's belongs to (its permission is asked as that one's); itself when it's top-level. */
async function rootOf(sessionId: string): Promise<OpenCodeSession | null> {
  let s = await infoOf(sessionId);
  for (let i = 0; s?.parentId && i < 8; i++) s = await infoOf(s.parentId);
  return s;
}

/** Whether a session holds something for you now (a permission or questions): blocked. */
const blocked = (sessionId: string) => [...asking.values()].some((h) => h.sessionId === sessionId && h.open);

const statusOf = (sessionId: string) => (blocked(sessionId) ? "blocked" : service.isBusy(sessionId) ? "busy" : "idle");

// ── Listing ──

let listing: Promise<AgentSession[]> | null = null;

async function listOpen(): Promise<AgentSession[]> {
  if (!linked()) {
    service.stop();
    listedNow([]);
    return [];
  }
  await service.start();
  if (!service.connected) {
    listedNow([]);
    return [];
  }
  const tuis = await openCodeTuis(service.pid);
  // Couldn't look at the processes: as at the last look, less any whose TUIs have all quit since.
  if (!tuis) {
    for (const [id, here] of holders)
      holders.set(
        id,
        here.filter((t) => stillRuns(t.pid)),
      );
    listedNow(listed.filter((s) => openNow(s.sessionId)).map((s) => ({ ...s, status: statusOf(s.sessionId) })));
    return listed;
  }
  const inFolder = new Map<string, OpenCodeSession[]>();
  await Promise.all([...new Set(tuis.map((t) => t.cwd))].map(async (cwd) => inFolder.set(cwd, (await service.sessionsIn(cwd)) ?? [])));
  const open = openSessions(tuis, inFolder, readTabs());
  fronts.clear();
  holders.clear();
  for (const o of open) {
    sessions.set(o.session.id, o.session);
    holders.set(o.session.id, o.tuis);
    if (o.tui) fronts.set(o.session.id, o.tui);
    if (!caughtUp.has(o.session.id)) {
      caughtUp.add(o.session.id);
      void catchUp(o.session);
    }
  }
  listedNow(open.map((o) => describe(o, statusOf(o.session.id))));
  return listed;
}

/**
 * What's listed now. A session that's no longer (its TUI quit, or its tab closed there): what's
 * held of it let go (a reply window closed, a permission or questions left to OpenCode), as for a
 * Claude Code session that ended, and its TUIs forgotten, so nothing more goes to it.
 */
function listedNow(now: AgentSession[]) {
  const ids = new Set(now.map((s) => s.sessionId));
  for (const id of [...holders.keys()]) if (!ids.has(id)) holders.delete(id);
  for (const id of [...fronts.keys()]) if (!ids.has(id)) fronts.delete(id);
  for (const [id, turn] of turns) {
    if (ids.has(id)) continue;
    turns.delete(id);
    turn.close();
  }
  for (const [requestId, held] of asking) {
    if (ids.has(held.sessionId)) continue;
    asking.delete(requestId);
    held.resolved();
  }
  listed = now;
  mirrors.keepOnly(new Set([...ids, ...followed.keys()]));
  watchTuis();
}

/** Whether a session is open now: listed at the last look, and a TUI in its folder then still runs. */
function openNow(sessionId: string): boolean {
  return holders.get(sessionId)?.some((t) => stillRuns(t.pid)) ?? false;
}

/**
 * Open now, else at a fresh look (one OpenCode made a moment ago, not listed yet): twice at most,
 * since the first may be a look begun before it was made.
 */
async function stillOpen(sessionId: string): Promise<boolean> {
  for (let i = 0; i < 2 && !openNow(sessionId); i++) await opencode.list();
  return openNow(sessionId);
}

// A TUI quitting says nothing to the service, nor to Kiko: its process is looked at every second
// while it has sessions listed (signal 0, nothing run), and one gone has its sessions listed again.
let tuiWatch: ReturnType<typeof setInterval> | null = null;
const TUI_WATCH_MS = 1000;

function watchTuis() {
  const pids = () => new Set([...holders.values()].flat().map((t) => t.pid));
  if (!pids().size) {
    if (tuiWatch) clearInterval(tuiWatch);
    tuiWatch = null;
    return;
  }
  tuiWatch ??= setInterval(() => {
    if ([...pids()].some((pid) => !stillRuns(pid))) changed();
  }, TUI_WATCH_MS);
  tuiWatch.unref?.();
}

/**
 * A session listed for the first time since the service connected: what it waits on (a permission
 * or questions asked before Kiko was listening) held for you, and the words of its last turn kept.
 */
async function catchUp(s: OpenCodeSession) {
  const [pending, messages] = await Promise.all([service.pending(s.id), service.messages(s.id, 20)]);
  if (messages) keepWords(s.id, messages);
  for (const p of pending.permissions) void askPermission(p);
  for (const f of pending.forms) void askForm(f);
}

/** Its last turn's words, kept for lastAsked and lastSaid. */
function keepWords(sessionId: string, messages: Message[]): Turn {
  const turn = turnOf(messages);
  const had = words.get(sessionId);
  words.set(sessionId, { asked: turn.asked || had?.asked || "", said: turn.said || had?.said || "" });
  return turn;
}

// ── Events ──

let changedSoon: ReturnType<typeof setTimeout> | null = null;

/** Listed again now, once for several events together. */
function changed() {
  if (changedSoon) return;
  changedSoon = setTimeout(() => {
    changedSoon = null;
    opencode.onSessionsChanged();
  }, 50);
  changedSoon.unref?.();
}

function onEvent(e: OpenCodeEvent) {
  const d = e.data;
  const sessionId = typeof d.sessionID === "string" ? d.sessionID : "";
  if (sessionId) historyChanged(sessionId, e.type);
  switch (e.type) {
    case "session.created":
    case "session.deleted":
    case "session.forked":
    case "session.moved":
      if (e.type === "session.deleted") sessions.delete(sessionId);
      return changed();
    case "session.renamed": {
      const s = sessions.get(sessionId);
      if (s && typeof d.title === "string") s.title = d.title.trim();
      return changed();
    }
    case "session.status": {
      const kind = typeof d.status === "string" ? d.status : d.status?.type;
      // Working again (a message typed in its TUI): its reply window is moot.
      if (kind && kind !== "idle") turns.get(sessionId)?.close();
      // Idle: nothing of it waits on you any more (its turn was stopped with what it asked).
      if (kind === "idle") stopped(sessionId, "idle");
      return changed();
    }
    case "session.execution.interrupted":
    case "session.execution.failed":
      // Esc in its TUI while it asked (or its turn failed): OpenCode drops the ask without a permission.replied.
      stopped(sessionId, e.type === "session.execution.failed" ? "failed" : `interrupted${typeof d.reason === "string" ? `:${d.reason}` : ""}`);
      return;
    case "session.inbox.enqueued": {
      const text = d.item?.type === "user" && typeof d.item.payload?.text === "string" ? d.item.payload.text : "";
      if (!text || !sessionId) return;
      log("prompt_submitted", { sessionId, chars: text.length, agent: OPENCODE_AGENT });
      opencode.onPromptSubmitted(sessionId, text);
      return;
    }
    case "session.execution.succeeded":
      if (sessionId) void turnEnded(sessionId);
      return;
    case "permission.asked":
      ruleBlocks.seen(e.type, d);
      void askPermission(d);
      return;
    case "session.tool.input.started":
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const block = ruleBlocks.seen(e.type, d);
      if (block) void ruleBlocked(block);
      return;
    }
    case "permission.replied": {
      const r = repliedOf(d);
      if (r) repliedThere(r);
      return;
    }
    case "form.created":
      void askForm(d.form);
      return;
    case "form.replied":
    case "form.cancelled":
      // Replied: answered in its TUI (one answered here was settled already).
      if (typeof d.id === "string") resolved(d.id, e.type === "form.replied" ? { reply: null } : null);
      return;
  }
}

/**
 * A call your deny rules stopped: said for its top-level session (a subagent's is its parent's), as
 * Claude Code's auto mode blocks are, only while a TUI shows it. Never overridden: it's your rule.
 */
async function ruleBlocked(b: RuleBlock) {
  const root = await rootOf(b.sessionId);
  const sessionId = root?.id ?? b.sessionId;
  if (!(await stillOpen(sessionId))) {
    log("opencode_block_unsaid", { sessionId, callId: b.callId, why: "no OpenCode TUI shows it" });
    return;
  }
  log("opencode_blocked", { sessionId, callId: b.callId, tool: b.tool.name, reason: b.reason });
  opencode.onBlocked?.({ sessionId, cwd: root?.cwd ?? "", tool: b.tool, reason: b.reason, by: "rule" });
}

/** A request settled in OpenCode (answered there, or here): closed here, the list told. */
function resolved(requestId: string, there: { reply: PermissionReply | null } | null = null) {
  const held = asking.get(requestId);
  asking.delete(requestId);
  if (!held) return;
  held.resolved(there);
  changed();
}

// Sessions (the asker's) whose permission Kiko just rejected, and when: OpenCode rejects the rest of
// that session's asks with it, each told as a permission.replied "reject" not given in its TUI.
const rejectedHere = new Map<string, number>();

/**
 * A permission answered (permission.replied): one held here, and not answered here, was answered in
 * its TUI: closed as such (Held.closedHow "terminal"), with its reply, logged. One of a batch Kiko's
 * own reject took with it is closed as gone (requests.ts repliedHow).
 */
function repliedThere(r: { requestId: string; sessionId: string; reply: PermissionReply | null }) {
  const held = asking.get(r.requestId);
  if (!held?.open) return resolved(r.requestId);
  const there = repliedHow(r.reply, rejectedHere.get(held.askedIn));
  log("opencode_replied_there", { sessionId: held.sessionId, requestId: r.requestId, reply: r.reply, ...(there ? {} : { with: "kiko_reject" }) });
  resolved(r.requestId, there);
}

/**
 * A session stopped (`why`: interrupted, failed, idle): what it asked that's still held here is
 * gone, closed as its hook closing would be. OpenCode says nothing else of it (repliedThere never
 * comes for an ask dropped so).
 */
function stopped(sessionId: string, why: string) {
  for (const held of endedBy(asking.values(), sessionId)) {
    log("opencode_ask_dropped", { sessionId: held.sessionId, requestId: held.requestId, why });
    resolved(held.requestId);
  }
}

/**
 * A turn that ended: read out, with a reply window. Not a subagent's, nor one no TUI shows (a
 * one-shot run, the web app, one whose TUI quit while the service went on with it).
 */
async function turnEnded(sessionId: string) {
  const s = await infoOf(sessionId);
  if (!s || s.parentId) return;
  if (!(await stillOpen(sessionId))) {
    log("opencode_turn_unheard", { sessionId, why: "no OpenCode TUI shows it" });
    return;
  }
  const messages = await service.messages(sessionId);
  if (!messages) return;
  const turn = keepWords(sessionId, messages);
  // A turn before it still held (never answered): this one supersedes it.
  turns.get(sessionId)?.close();
  const held = new OpenCodeTurn({ sessionId, cwd: s.cwd, turn, continued: continuing.delete(sessionId) }, (text) => {
    turns.delete(sessionId);
    // Its TUI quit since: not sent (the app tries typing it in, which says so).
    if (!service.connected || !openNow(sessionId)) return false;
    continuing.add(sessionId);
    void service.prompt(sessionId, text).then((done) => {
      if (!done.done) {
        continuing.delete(sessionId);
        opencode.onNotice(`${nameOf(sessionId)} in OpenCode didn't get that (${done.why}): reply in its window.`);
      }
    });
    return true;
  });
  turns.set(sessionId, held);
  log("opencode_turn", { sessionId, chars: turn.said.length, continued: held.continued });
  opencode.onHeld(held);
}

/** Sends a held request's answer back to OpenCode; said when it didn't take (its TUI still asks). */
function replier(sessionId: string, requestId: string, kind: "permission" | "form") {
  return (reply: Reply) => {
    asking.delete(requestId);
    changed();
    if (!service.connected) return false;
    // OpenCode rejects the rest of this session's asks with it (repliedThere).
    if ("decision" in reply && reply.decision === "reject") rejectedHere.set(sessionId, Date.now());
    const go = "answer" in reply ? service.replyForm(sessionId, requestId, reply.answer) : service.replyPermission(sessionId, requestId, reply.decision, reply.message);
    log("opencode_reply", { sessionId, requestId, kind, ...("decision" in reply ? { decision: reply.decision } : { answers: Object.keys(reply.answer).length }) });
    void go.then((done) => {
      if (!done.done) opencode.onNotice(`${nameOf(sessionId)} in OpenCode didn't get that answer (${done.why}): answer it in its window.`);
    });
    return true;
  };
}

/**
 * Whether a request of a session is held for you: only while a TUI shows it. One whose TUI quit
 * while the service went on with it is left to OpenCode: answered here, its turn would go on unseen.
 */
async function openFor(kind: "permission" | "questions", sessionId: string, requestId: string) {
  if (await stillOpen(sessionId)) return true;
  log("opencode_unheld", { sessionId, requestId, kind, why: "no OpenCode TUI shows it" });
  return false;
}

/** A permission request: held for you, as the top-level session it's for (a subagent's is its parent's). */
async function askPermission(raw: unknown) {
  const p = permissionOf(raw);
  if (!p || asking.has(p.id)) return;
  const root = await rootOf(p.sessionId);
  const sessionId = root?.id ?? p.sessionId;
  if (!(await openFor("permission", sessionId, p.id)) || asking.has(p.id)) return;
  const held = new OpenCodeHeld(
    { sessionId, cwd: root?.cwd ?? "", requestId: p.id, tool: p.tool, canAllowAlways: p.canAlways, questions: null, askedIn: p.sessionId },
    replier(p.sessionId, p.id, "permission"),
    () => words.get(sessionId)?.asked ?? "",
  );
  asking.set(p.id, held);
  log("opencode_permission", { sessionId, requestId: p.id, tool: p.tool.name });
  changed();
  opencode.onHeld(held);
}

/** A form: its question tool's held as questions; any other said once, to answer in its window. */
async function askForm(raw: unknown) {
  const form = raw as any;
  if (!form || typeof form.id !== "string" || asking.has(form.id) || typeof form.sessionID !== "string") return;
  const root = await rootOf(form.sessionID);
  const sessionId = root?.id ?? form.sessionID;
  const q = questionsOf(form);
  if (!q) {
    // MCP elicitations belong to no session ("global"): only one of a session is said.
    if (root) opencode.onNotice(`${nameOf(sessionId)} in OpenCode is asking you something in its window: answer it there.`);
    return;
  }
  if (!(await openFor("questions", sessionId, q.id)) || asking.has(q.id)) return;
  const held = new OpenCodeHeld(
    { sessionId, cwd: root?.cwd ?? "", requestId: q.id, tool: { name: ASK_TOOL, input: { questions: q.questions } }, canAllowAlways: false, questions: q.questions, askedIn: q.sessionId },
    replier(q.sessionId, q.id, "form"),
    () => words.get(sessionId)?.asked ?? "",
  );
  asking.set(q.id, held);
  log("opencode_questions", { sessionId, formId: q.id, questions: q.questions.length });
  changed();
  opencode.onHeld(held);
}

service.onEvent = onEvent;
service.onConnected = () => {
  // Asked again as each session is listed: what it waits on may have come while Kiko wasn't listening.
  caughtUp.clear();
  changed();
  // And the conversations followed: their messages may have come meanwhile, with no event here for them.
  for (const pokes of watchers.values()) for (const poke of pokes) poke();
};
service.onDropped = () => {
  // OpenCode's TUI still asks what's held here: let go, answered there.
  for (const held of asking.values()) held.resolved();
  asking.clear();
  for (const t of turns.values()) t.close();
  turns.clear();
  changed();
};

// ── History: its messages as a transcript, for the phone and the window ──

type Projection = { messages: { id: string; role: string; text: string; createdAt: string }[] };
const watchers = new Map<string, Set<() => void>>();

/**
 * A session's messages, oldest first, as the mirror reads a projection (../mirror.ts
 * messageLines), up to a reply still being written while it works: the mirror writes each message
 * once, so one read half written would stay cut short. It's read again as its step or turn ends.
 */
async function projectionOf(sessionId: string): Promise<Projection | null> {
  const messages = await service.messages(sessionId, 200);
  if (!messages) return null;
  const oldestFirst = [...messages].reverse();
  const writing = service.isBusy(sessionId) ? oldestFirst.findIndex((m) => m.writing) : -1;
  return {
    messages: (writing < 0 ? oldestFirst : oldestFirst.slice(0, writing))
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.at ? new Date(m.at).toISOString() : "" })),
  };
}

/** Follows a session's messages: read now, and again a moment after each event about it. */
function watchSession(sessionId: string, changedTo: (projection: unknown) => void): { stop(): void } {
  let soon: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const read = () => {
    soon = null;
    void projectionOf(sessionId).then((p) => {
      if (p && !stopped) changedTo(p);
    });
  };
  const poke = () => {
    if (soon || stopped) return;
    soon = setTimeout(read, 300);
    soon.unref?.();
  };
  const set = watchers.get(sessionId) ?? new Set();
  set.add(poke);
  watchers.set(sessionId, set);
  read();
  return {
    stop() {
      stopped = true;
      if (soon) clearTimeout(soon);
      set.delete(poke);
      if (!set.size) watchers.delete(sessionId);
    },
  };
}

/** The events that change what a session's conversation shows (a message in, a step's or a turn's words done). */
const HISTORY = new Set([
  "session.inbox.delivered",
  "session.text.ended",
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.synthetic",
]);
function historyChanged(sessionId: string, type: string) {
  if (!HISTORY.has(type)) return;
  for (const poke of watchers.get(sessionId) ?? []) poke();
}

/** The sessions shown in the Kiko window or on the phone, as transcript files: next to Kiko's page, in opencode/. */
const mirrors = new Mirrors(() => join(dirname(pagePath()), "opencode"), watched(watchSession));

/**
 * The sessions whose conversation is followed now (watchHistory: the phone's chat, the window), and
 * by how many: their files are kept up while they are, through a listing that missed them (the
 * service dropped for a moment), since nothing else would start them again under a screen left open.
 */
const followed = new Map<string, number>();

function follow(sessionId: string, changedTo: (history: History) => void): { stop(): void } {
  followed.set(sessionId, (followed.get(sessionId) ?? 0) + 1);
  const watcher = new HistoryWatcher(mirrors.path(sessionId), changedTo);
  let stopped = false;
  return {
    stop() {
      watcher.stop();
      if (stopped) return;
      stopped = true;
      const left = (followed.get(sessionId) ?? 1) - 1;
      if (left > 0) followed.set(sessionId, left);
      else followed.delete(sessionId);
    },
  };
}

// ── Closing one outside Kiko's tmux ──

const reach = systemReach;

/** The words OpenCode's composer shows when it's ready for a message, and what shows while it works (OpenCode 2.0.32's TUI: tui/src/component/prompt). */
const COMPOSER = /Ask anything/;
const WORKING = /\besc\b.{0,16}interrupt/i;

/** Whether an OpenCode window shows its empty prompt with nothing running. */
export const atOpenCodePrompt = (screen: string) => COMPOSER.test(screen) && !WORKING.test(screen);

/** Why words weren't sent to a session no TUI shows now. */
const CLOSED = "its OpenCode window was closed";

/** Its session through the service, done to; one the service doesn't have now: said so. */
async function withSession(of: { sessionId: string }, act: (id: string) => Promise<Done>): Promise<Done> {
  if (!service.connected) return { done: false, why: "OpenCode's service isn't connected" };
  return act(of.sessionId);
}

export const opencode: Agent = {
  id: OPENCODE_AGENT,
  name: "OpenCode",
  speaker: "OpenCode",
  starts: true,
  // "Start an OpenCode session", as speech-to-text may write it.
  heard: /\bopen[\s-]?code\b/i,
  // ▣, a square in a square after its logo, in its TUI's default theme `primary` (#FAB283); its light
  // theme's primary is a blue too close to Codex's, so an amber there. No Nerd Font icon for it.
  mark: { glyph: "▣", color: { dark: "#FAB283", light: "#9C6B12" } },
  // OpenCode's session IDs: "ses_" and an ascending ID (schema/src/session-id.ts).
  owns: (sessionId) => /^ses_[0-9A-Za-z]+$/.test(sessionId),
  onNotice: () => {},
  onHeld: () => {},
  onSessionsChanged: () => {},
  onPromptSubmitted: () => {},
  onSessionEnded: () => {},
  // A call your deny rules stopped without asking (ruleBlocked): said, never overridden.
  onBlocked: () => {},
  // Connected (./setup.ts): the service, looked for now and as its sessions are listed.
  start: async () => {
    if (linked()) await service.start();
  },
  stop: () => {
    mirrors.stop();
    service.stop();
    if (tuiWatch) clearInterval(tuiWatch);
    tuiWatch = null;
  },
  setup: opencodeSetup,
  list: () => {
    listing ??= listOpen().finally(() => (listing = null));
    return listing;
  },
  names: (of) => ({ givenName: sessions.get(of.sessionId)?.title ?? "", title: "" }),
  lastAsked: (of) => words.get(of.sessionId)?.asked ?? "",
  lastSaid: (of) => words.get(of.sessionId)?.said ?? "",
  watchHistory: (of, changedTo) => follow(of.sessionId, changedTo),
  historyFile: (of) => mirrors.path(of.sessionId),
  madeUpFolder: () => false,
  // Nothing in OpenCode waits on a held turn, so there's no cap on replies through one.
  heldReplies: 20,
  interruptKey: "escape",
  // No slash command renames (Ctrl+R opens a dialog): renamed through the service instead.
  renameCommand: () => "",
  exitCommand: "/exit",
  // Outside Kiko's tmux: SIGHUP to its TUI, the one in front in its folder, after the checks.
  end: async (session) => {
    const tui = fronts.get(session.sessionId);
    if (!tui || tui.pid !== session.pid) return { sent: false, why: "its OpenCode window isn't known for sure" };
    const why = await checkProcess(tui.pid, tui.procStart, reach, { name: "OpenCode", is: openCodeProgram });
    if (why) return { sent: false, why };
    return terminate(tui.pid, reach, "SIGHUP");
  },
  // Through the service, wherever it runs (no keys typed), while it's connected and a TUI shows it.
  can: (session) => {
    const has = service.connected && openNow(session.sessionId);
    return { reply: has, interrupt: has, rename: has, close: Number.isInteger(session.pid) && fronts.get(session.sessionId)?.pid === session.pid };
  },
  rename: (of, name) =>
    withSession(of, async (id) => {
      const done = await service.rename(id, name);
      const s = sessions.get(id);
      if (done.done && s) s.title = name.trim();
      return done;
    }),
  interrupt: (of) => withSession(of, (id) => service.interrupt(id)),
  // Never to one no TUI shows (listed a moment ago, its TUI quit since): the service would run a
  // turn for it that nobody sees. Not sent, and why.
  message: async (of, text) => {
    if (!openNow(of.sessionId)) {
      log("opencode_command", { method: "session.prompt", sessionId: of.sessionId, ok: false, why: CLOSED });
      return { sent: false, why: CLOSED };
    }
    const done = await withSession(of, (id) => service.prompt(id, text));
    return done.done ? { sent: true } : { sent: false, why: done.why };
  },
  // `opencode [--prompt <words>]`: the words are its first message, sent as it opens. No flag names a session: renamed once it's listed (namesLater).
  // The "Permission mode" setting isn't mapped: OpenCode 2.0.32's `opencode` has no flag for any of
  // them (its --auto approves everything not denied, nearer bypass than Accept edits or auto),
  // so nothing is passed. It starts in your OpenCode config's permissions, as before.
  startCommand: ({ prompt }) => ({ program: "opencode", args: prompt ? ["--prompt", prompt] : [] }),
  namesLater: true,
  readyOnScreen: atOpenCodePrompt,
  // Its TUI in a pane of Kiko's tmux (`kiko opencode`): listed from the pane until it has a session.
  runsAs: (command) => command === "opencode",
  knownFolders: () => [],
};
