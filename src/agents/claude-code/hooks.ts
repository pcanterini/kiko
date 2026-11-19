import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { answersFor, ASK_TOOL, readQuestions, type Answer, type AskQuestion } from "../../core/ask.ts";
import { saidThisTurn } from "../../core/history.ts";
import { decideGuard, guardCheckOf, type GuardCheck, type GuardVerdict } from "../../core/guard.ts";
import { log } from "../../core/log.ts";
import type { Blocked } from "../../core/permission-mode.ts";
import { envVar, NAME, SOCKET_PATH } from "../../core/name.ts";
import { endHook, hookGone, watchHookConn } from "../hook-conn.ts";
import { hookRoute } from "../hook-routes.ts";
import type { Held, ToolUse } from "../types.ts";
import { promptTranscript, watchPrompt } from "./answered-there.ts";
import { forgetMode, noteMode } from "./modes.ts";
import { forgetTerminal, noteTerminal, terminalOf } from "./terminals.ts";
import { fromDesktop, hiddenSession, tellHidden } from "./sessions.ts";
import { lastUserMessage } from "./transcripts.ts";
import { noteHook, turnResumed } from "./turns.ts";
import { watchQueued } from "./typed-in.ts";

export const SOCKET = envVar("SOCKET") ?? SOCKET_PATH;

export type HookEvent = {
  hook_event_name: "Stop" | "PermissionRequest";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  // CLAUDE_CODE_ENTRYPOINT: "cli" in a terminal, "claude-desktop" from the desktop app. Missing
  // from hooks older than this field.
  entrypoint?: string;
  // The hook's parent process: Claude Code's, or a shell it ran the hook in. Logged, to trace a
  // session ID to its process. Missing from hooks older than this field.
  pid?: number;
  // Its permission mode now ("default", "acceptEdits", "plan", "auto", …: ./modes.ts). Missing from
  // hooks older than this field.
  permission_mode?: string;
  // The terminal it runs in, as the hook's environment says (hooks/lib.mjs terminalEnv; ./terminals.ts),
  // here and on SessionStart and UserPromptSubmit. Missing from hooks older than this field.
  terminal?: { program?: string; bundle?: string; kiko?: boolean; rex?: string };
  // Stop
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  // PermissionRequest
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: unknown[];
  // A subagent's prompt: its ID (its own transcript has the call). Missing from hooks older than this field.
  agent_id?: string;
};

/** A session started or ended: told, not held (the hook doesn't wait for an answer). */
type SessionEvent = {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  // SessionStart: startup, resume, clear or compact.
  source?: string;
  // SessionEnd: clear, logout, prompt_input_exit, other…
  reason?: string;
  // SessionStart: the hook's parent process (as HookEvent's).
  pid?: number;
  // SessionEnd (SessionStart has none): its permission mode, as HookEvent's.
  permission_mode?: string;
};

/**
 * A session took a prompt in and starts its turn: told, not held. Answered at once all the same,
 * with one line, {"voice":true} or {"voice":false}: whether the prompt is your dictated words the
 * app typed in (HookServer.dictated), which the hook then tells Claude beside the prompt.
 */
type PromptEvent = {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  /** What it took in (cut to the hook's MAX_PROMPT). */
  prompt?: string;
  permission_mode?: string;
};

/**
 * Auto mode blocked a tool call (Claude Code's PermissionDenied: only in auto mode, never for a
 * prompt you denied or a deny rule): told, not held. Nothing is answered (no `retry`): the denial
 * stands, and the app says it.
 */
type DeniedEvent = {
  hook_event_name: "PermissionDenied";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  /** "[Data Exfiltration]" (the rule it matched), "Auto mode could not evaluate this action…", "Classifier unavailable". */
  reason?: string;
};

/**
 * The safety gate (core/guard.ts): a tool call its rules flagged, about to run (PreToolUse, only for
 * those: the hook passes the rest by itself). Answered with the verdict at once, on one line:
 * {"guard":{"ask":true,"reason":…}} has the hook make Claude Code ask, {"guard":{"ask":false}} lets it run.
 */
type GuardEvent = {
  hook_event_name: "PreToolUse";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent_id?: string;
  guard?: { hits?: unknown; unclear?: unknown };
};

/** How long a session starting or ending waits for others before the sessions are listed again. */
export const SESSIONS_SETTLE_MS = 200;

type PermissionDecision = { behavior: "allow"; updatedPermissions?: unknown[] } | { behavior: "deny"; message: string };

/**
 * A session waiting inside its hook for you, as core sees one held (../types.ts Held), read from
 * the hook's event. How the answer gets back is the subclass's: HookRequest's socket here, a
 * stand-in in the harness.
 * Stop (it finished a turn): answer(text) sends it on with that text; answer(null) lets it stop.
 * PermissionRequest (it wants to use a tool): allow or deny it; decide(null) leaves it to the
 * normal terminal prompt. AskUserQuestion (Claude asks you questions) comes the same way, and is
 * answered with answerQuestions().
 */
export abstract class HookHeld implements Held {
  readonly event: HookEvent;

  /** The hook went away first (its timeout, or the session was interrupted). */
  onClosed: () => void = () => {};

  constructor(event: HookEvent) {
    this.event = event;
  }

  abstract get open(): boolean;

  /** Sends the hook its answer, once: false when it had one, or went away. */
  protected abstract send(payload: Record<string, unknown>): boolean;

  readonly agent = "claude-code";

  get isPermission() {
    return this.event.hook_event_name === "PermissionRequest";
  }

  get sessionId() {
    return this.event.session_id;
  }

  get cwd() {
    return this.event.cwd;
  }

  get desktop() {
    return fromDesktop(this.event.entrypoint);
  }

  get text() {
    return this.event.last_assistant_message ?? "";
  }

  get continued() {
    return Boolean(this.event.stop_hook_active);
  }

  get tool(): ToolUse | null {
    return this.isPermission ? { name: this.event.tool_name ?? "", input: this.event.tool_input } : null;
  }

  get canAllowAlways() {
    const suggestions = this.event.permission_suggestions;
    return Array.isArray(suggestions) && suggestions.length > 0;
  }

  private asked: AskQuestion[] | null | undefined;
  /** AskUserQuestion's questions, read once; null for any other prompt, or ones that can't be read. */
  get questions() {
    if (this.asked === undefined) this.asked = this.isPermission && this.event.tool_name === ASK_TOOL ? readQuestions(this.event.tool_input) : null;
    return this.asked;
  }

  lastAsked() {
    return lastUserMessage(this.event.transcript_path);
  }

  saidThisTurn() {
    return this.isPermission ? null : saidThisTurn(this.event.transcript_path);
  }

  /**
   * A permission prompt answered (or cancelled) in Claude Code's own dialog while it's held: its
   * transcript moved past its call, or its session's dialog came and went (./answered-there.ts).
   */
  watchAnswered(answered: (sign: string) => void) {
    if (!this.isPermission) return;
    const e = this.event;
    watchPrompt({
      sessionId: e.session_id,
      transcript: promptTranscript(e.transcript_path, e.session_id, e.agent_id),
      call: { name: e.tool_name ?? "", input: e.tool_input },
      pids: [e.pid],
      open: () => this.open,
      answered,
    });
  }

  /** Something typed into the session while it's held shows up in its transcript as a queued prompt (./typed-in.ts). */
  watchTyped(typed: (text: string) => void) {
    const path = this.event.transcript_path;
    if (!path) return;
    watchQueued(path, () => this.open, typed);
  }

  answer(reply: string | null) {
    const sent = this.send({ reply });
    // Your reply carries its turn on, with no UserPromptSubmit to say so (./turns.ts).
    if (sent && !this.isPermission && reply?.trim()) turnResumed(this.sessionId);
    return sent;
  }

  allow(always: boolean) {
    return this.decide({ behavior: "allow", ...(always && this.canAllowAlways ? { updatedPermissions: this.event.permission_suggestions } : {}) });
  }

  deny(message: string) {
    return this.decide({ behavior: "deny", message });
  }

  decide(decision: PermissionDecision | null) {
    return this.send({ decision });
  }

  /**
   * AskUserQuestion answered: allowed, with `answers` (each question's text → its answer, in Claude
   * Code's form: ../../core/ask.ts answersFor). The hook gives Claude Code back the tool's own input
   * with them added (`updatedInput`), which it takes as answered at its own prompt; an allow without
   * them it ignores for this tool, and asks in the terminal.
   */
  answerQuestions(answers: Answer[]) {
    const questions = this.questions;
    if (!questions) return false;
    return this.send({ decision: { behavior: "allow" }, answers: answersFor(questions, answers) });
  }

  /** Lets the session go without an answer: a Stop stops, a permission falls back to the terminal. */
  release() {
    return this.isPermission ? this.decide(null) : this.answer(null);
  }
}

/** A session waiting inside its hook, on the other end of a socket connection. */
export class HookRequest extends HookHeld {
  private conn: Socket;
  private settled = false;

  constructor(event: HookEvent, conn: Socket) {
    super(event);
    this.conn = conn;
    const closed = () => {
      if (this.settled) return;
      this.settled = true;
      log("hook_closed", { kind: event.hook_event_name, sessionId: event.session_id });
      this.onClosed();
    };
    conn.on("close", closed);
    // Gone before it was held (its close may have come already): let go once whoever holds it is listening.
    if (conn.destroyed) setImmediate(closed);
  }

  get open() {
    return !this.settled;
  }

  protected send(payload: Record<string, unknown>) {
    if (this.settled) return false;
    // The hook went away and its close is on the way (it lets go then): nothing written.
    if (hookGone(this.conn)) return false;
    this.settled = true;
    log("hook_answer", { kind: this.event.hook_event_name, sessionId: this.event.session_id, ...payload });
    endHook(this.conn, `${JSON.stringify(payload)}\n`);
    return true;
  }
}

/**
 * Listens for hooks/claude-code-hook.mjs, which every Claude Code session runs on Stop and
 * PermissionRequest (held: HookRequest), and on SessionStart, SessionEnd, UserPromptSubmit and
 * PermissionDenied (told: the connection is closed at once; UserPromptSubmit's with one line, whether
 * the prompt is your dictated words: PromptEvent). Each event's `permission_mode` is kept
 * as that session's (./modes.ts), and whether it's in a turn (./turns.ts), and the sessions listed
 * again when either changed. Another agent's hooks reach the same socket, their lines marked with
 * that agent, and go to its adapter (../hook-routes.ts: Codex's). The socket exists only while the
 * app runs; without it the hook exits immediately.
 */
export class HookServer {
  private server: Server | null = null;
  private settling: NodeJS.Timeout | null = null;

  onRequest: (request: HookRequest) => void = () => {};
  /**
   * A session started or ended. Once for those that come together (/clear ends one session and
   * starts the next), SESSIONS_SETTLE_MS after the first.
   */
  onSessionsChanged: () => void = () => {};
  /** A session took a prompt in (UserPromptSubmit), and starts its turn. */
  onPromptSubmitted: (sessionId: string, prompt: string) => void = () => {};
  /**
   * Whether a prompt a session just took in is your dictated words, typed into it by the app
   * (core/dictated.ts): the hook's answer, so Claude is told they were spoken. Never, until the app sets it.
   */
  dictated: (sessionId: string, prompt: string) => boolean = () => false;
  /** A session ended (SessionEnd), at once: a Close waiting for it to exit goes on (core/close.ts). */
  onSessionEnded: (sessionId: string) => void = () => {};
  /** Auto mode blocked one of a session's tool calls (PermissionDenied), for a session the list shows. */
  onBlocked: (blocked: Blocked) => void = () => {};
  /** The safety gate's verdict on a call its rules flagged (core/guard.ts); its rules' own until the app sets it. */
  onGuard: (check: GuardCheck) => Promise<GuardVerdict> = (check) => decideGuard(check, { on: true, off: [] });

  async start() {
    if (existsSync(SOCKET)) {
      // Another user's (/tmp is anyone's): never taken over nor talked to, and said for what it is.
      const owner = lstatSync(SOCKET).uid;
      if (owner !== process.getuid?.()) throw new Error(`${SOCKET} belongs to another user of this Mac (uid ${owner}), so ${NAME} can't listen there: ask them to remove it, or remove it with sudo`);
      if (await alive(SOCKET)) throw new Error(`Another ${NAME} is already listening on ${SOCKET}`);
      unlinkSync(SOCKET); // left over from a crash
    }
    const server = createServer((conn) => {
      // A hook gone before its answer (../hook-conn.ts): logged, never thrown.
      const about: Record<string, unknown> = {};
      watchHookConn(conn, about);
      const lines = createInterface({ input: conn });
      lines.once("line", (line) => {
        lines.close();
        try {
          this.hookLine(line, conn, about);
        } catch (err) {
          // A bug, or a line of a shape nobody foresaw: logged and let go, never the app's end.
          log("error", { where: "hook_line", kind: about.kind, message: err instanceof Error ? err.message : String(err) });
          endHook(conn);
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(SOCKET, resolve);
    });
  }

  /** One hook's line: told, answered at once, or held for the app (onRequest). */
  private hookLine(line: string, conn: Socket, about: Record<string, unknown>) {
    let event: HookEvent | SessionEvent | PromptEvent | DeniedEvent | GuardEvent;
    try {
      event = JSON.parse(line);
    } catch {
      endHook(conn);
      return;
    }
    // Not a hook's event (not an object, no name, a field of the wrong type): let go and logged,
    // before anything reads it. An agent's release that changed its payload lands here, not in a throw.
    const wrong = hookShapeError(event);
    if (wrong) {
      endHook(conn);
      log("hook_invalid", { why: wrong });
      return;
    }
    // Another agent's hook (hooks/codex-hook.mjs marks its lines "agent": "codex"): its adapter's (../hook-routes.ts).
    const other = (event as { agent?: unknown })?.agent;
    Object.assign(about, { kind: event?.hook_event_name, sessionId: event?.session_id, ...(other ? { agent: other } : {}) });
    if (typeof other === "string" && other !== "claude-code") {
      const take = hookRoute(other);
      if (take) return take(event as unknown as Record<string, unknown>, conn);
      endHook(conn);
      log("hook_unknown", { agent: other, kind: event?.hook_event_name });
      return;
    }
    const kind = event?.hook_event_name;
    // Its turn, opened or ended (./turns.ts): what "working" means. A change gets it listed again.
    if (noteHook(kind, event?.session_id, (event as SessionEvent).source)) this.sessionsChanged();
    // Its mode, on every event that says it: a new one gets the list drawn again (its tag).
    if (kind !== "SessionEnd" && noteMode(event?.session_id, event?.permission_mode)) {
      log("permission_mode", { sessionId: event.session_id, mode: event.permission_mode, on: kind });
      this.sessionsChanged();
    }
    // Its terminal app, where the event says it (./terminals.ts): one newly known can be looked for in Ghostty.
    if (kind !== "SessionEnd" && noteTerminal(event?.session_id, (event as HookEvent).terminal)) {
      log("session_terminal", { sessionId: event.session_id, terminal: terminalOf(event.session_id), on: kind });
      this.sessionsChanged();
    }
    if (kind === "SessionStart" || kind === "SessionEnd") {
      endHook(conn);
      const { session_id: sessionId, cwd, source, reason, pid } = event as SessionEvent;
      log(kind === "SessionStart" ? "session_started" : "session_ended", { sessionId, cwd, source, reason, ...(Number.isInteger(pid) ? { pid } : {}) });
      if (kind === "SessionEnd" && typeof sessionId === "string") {
        forgetMode(sessionId);
        forgetTerminal(sessionId);
        this.onSessionEnded(sessionId);
      }
      this.sessionsChanged();
      return;
    }
    if (kind === "PermissionDenied") {
      endHook(conn);
      const e = event as DeniedEvent;
      if (typeof e.session_id !== "string" || typeof e.cwd !== "string") return;
      const tool: ToolUse = { name: typeof e.tool_name === "string" ? e.tool_name : "", input: e.tool_input && typeof e.tool_input === "object" ? e.tool_input : undefined };
      const reason = typeof e.reason === "string" ? e.reason : "";
      // One another Claude started (the list leaves it out): logged, never said.
      const hidden = hiddenSession(e.session_id, e.cwd);
      log("hook_permission_denied", { sessionId: e.session_id, cwd: e.cwd, tool: tool.name, reason, mode: e.permission_mode, ...(hidden ? { hidden } : {}) });
      if (!hidden) this.onBlocked({ sessionId: e.session_id, cwd: e.cwd, tool, reason, by: "auto", ...(typeof e.permission_mode === "string" ? { mode: e.permission_mode } : {}) });
      return;
    }
    if (kind === "PreToolUse") {
      const check = guardCheckOf(event as GuardEvent, "claude-code");
      if (!check) return void endHook(conn);
      const answer = (verdict: GuardVerdict) => endHook(conn, `${JSON.stringify({ guard: verdict.ask ? { ask: true, reason: verdict.reason } : { ask: false } })}\n`);
      // One another Claude started (an agent trying something out), which the list leaves out:
      // nobody here could answer its prompt, so it runs as configured, as with the app off.
      const hidden = hiddenSession(check.sessionId, check.cwd);
      if (hidden) {
        log("guard_pass", { agent: "claude-code", sessionId: check.sessionId, why: `hidden (${hidden})`, rule: check.hits[0]?.rule ?? check.unclear[0]?.rule });
        return answer({ ask: false, why: "hidden" });
      }
      this.onGuard(check).then(answer, (err) => {
        log("error", { where: "guard", message: err instanceof Error ? err.message : String(err) });
        // Kiko is here but couldn't decide: a sure hit still asks.
        answer(
          check.hits.length
            ? { ask: true, kind: check.hits[0].kind, rule: check.hits[0].rule, what: check.hits[0].what, by: "rule", reason: `${NAME} asks first: ${check.hits[0].what}.` }
            : { ask: false, why: "error" },
        );
      });
      return;
    }
    if (kind === "UserPromptSubmit") {
      const { session_id: sessionId, prompt } = event as PromptEvent;
      if (typeof sessionId !== "string" || typeof prompt !== "string") return void endHook(conn);
      // Answered before anything else is done with it: the hook waits a second at most, and the
      // prompt waits on the hook. `voice` is logged only when the hook was still there to be told
      // (2026-11-14: so the logs say which prompts went in with the note).
      const dictated = this.dictated(sessionId, prompt);
      const told = endHook(conn, `${JSON.stringify({ voice: dictated })}\n`);
      log("prompt_submitted", { sessionId, chars: prompt.length, ...(dictated && told ? { voice: true } : {}) });
      this.onPromptSubmitted(sessionId, prompt);
      return;
    }
    // Held only for what it knows how to answer: a hook added for some other event is let go.
    if (kind !== "Stop" && kind !== "PermissionRequest") {
      endHook(conn);
      log("hook_unknown", { kind });
      return;
    }
    // One another Claude started (an agent trying something out), which the list leaves out: let
    // go at once, as with the app off (it stops; a permission goes to its terminal), never heard.
    const { session_id: sessionId, cwd, pid } = event as HookEvent;
    const hidden = hiddenSession(sessionId, cwd);
    if (hidden) {
      endHook(conn);
      tellHidden(sessionId, hidden, cwd, pid);
      return;
    }
    log(kind === "PermissionRequest" ? "hook_permission" : "hook_stop", { ...event });
    this.onRequest(new HookRequest(event as HookEvent, conn));
  }

  private sessionsChanged() {
    if (this.settling) return;
    this.settling = setTimeout(() => {
      this.settling = null;
      this.onSessionsChanged();
    }, SESSIONS_SETTLE_MS);
  }

  stop() {
    if (this.settling) clearTimeout(this.settling);
    this.settling = null;
    this.server?.close();
    this.server = null;
    if (existsSync(SOCKET)) unlinkSync(SOCKET);
  }
}

/** Fields a hook's line has as strings, when it has them (HookEvent and the others above). */
const STRING_FIELDS = ["agent", "cwd", "transcript_path", "permission_mode", "entrypoint", "last_assistant_message", "tool_name", "tool_use_id", "agent_id", "prompt", "source", "reason"];
/** Fields it has as objects, when it has them. */
const OBJECT_FIELDS = ["tool_input", "terminal", "guard"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why a parsed hook line isn't one the server can take, or null when it is: an object with the
 * event's name and its session, each field it has of the type the hook sends (as the phone's
 * messages are checked: remote/schema.ts). A prompt or a stop, which the app holds, has its folder too.
 */
export function hookShapeError(event: unknown): string | null {
  if (!isObject(event)) return "not an object";
  if (typeof event.hook_event_name !== "string") return "no hook_event_name";
  if (typeof event.session_id !== "string") return "no session_id";
  for (const key of STRING_FIELDS) if (event[key] !== undefined && typeof event[key] !== "string") return `${key} isn't a string`;
  for (const key of OBJECT_FIELDS) if (event[key] !== undefined && !isObject(event[key])) return `${key} isn't an object`;
  if (event.permission_suggestions !== undefined && !Array.isArray(event.permission_suggestions)) return "permission_suggestions isn't a list";
  if ((event.hook_event_name === "Stop" || event.hook_event_name === "PermissionRequest") && typeof event.cwd !== "string") return "no cwd";
  return null;
}

function alive(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(path, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}
