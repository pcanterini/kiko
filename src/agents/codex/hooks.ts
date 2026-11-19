// Codex's hooks, as Kiko hears them: hooks/codex-hook.mjs on each event, over the same socket as
// Claude Code's (claude-code/hooks.ts HookServer, which hands the lines marked "agent": "codex" here:
// ../hook-routes.ts). Stop and PermissionRequest are held (CodexHeld); the rest are told:
//   SessionStart, SessionEnd   a session started (at its first prompt: Codex makes one then) or ended
//                              (/exit; not on a signal: Codex's TUI has no handler for one)
//   UserPromptSubmit           it took a prompt in and starts its turn; answered at once with one
//                              line, {"voice":true} when the prompt is your dictated words the app
//                              typed in (core/dictated.ts), which the hook then tells Codex beside it
//   Interrupt                  its turn was interrupted (Esc): what Kiko held of it goes
//   PreToolUse                 for request_user_input, its questions: no hook can answer those, so
//                              Kiko says they wait in its window. For a shell command or MCP call the
//                              safety gate's rules flagged (`guard` on the line): the gate's verdict
//                              first, {"guard":{"ask":false}} (it runs) or {"guard":{"ask":true}}, and
//                              then, for an ask, held like a PermissionRequest (CodexHeld, isPermission):
//                              allowed, it runs; denied or let go, the hook denies it
// The event's fields are Codex's (codex-rs/hooks/src/schema.rs, 0.153.0), as the hook passes them on.
// A session another app runs Codex for (T3 Code's threads: its originator, ./origin.ts) is none of
// these: every event of it is let go at once, unanswered (that app answers its own prompts), and
// logged once as `codex_other_app`. The hook itself leaves those out already (hooks/codex-hook.mjs);
// this is for one whose rollout it couldn't read yet.
import type { Socket } from "node:net";
import { guardCheckOf, type GuardCheck } from "../../core/guard.ts";
import { log } from "../../core/log.ts";
import { endHook, hookGone } from "../hook-conn.ts";
import type { Answer } from "../../core/ask.ts";
import type { Held, ToolUse } from "../types.ts";
import { otherApp } from "./origin.ts";
import { lastUserText, saidSince } from "./rollouts.ts";

export type CodexEvent = {
  agent: "codex";
  hook_event_name: "Stop" | "PermissionRequest" | "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "Interrupt" | "PreToolUse";
  session_id: string;
  cwd: string;
  /** Its rollout (~/.codex/sessions/…/rollout-….jsonl); missing when Codex keeps none. */
  transcript_path?: string;
  turn_id?: string;
  /** The Codex TUI's process, when the hook found it (codex-hook.mjs tuiPid). */
  pid?: number;
  // SessionStart: startup, resume, clear or compact. SessionEnd: "other".
  source?: string;
  reason?: string;
  // UserPromptSubmit
  prompt?: string;
  // PermissionRequest, PreToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // PreToolUse for the safety gate: what its rules found (hooks/guard.mjs).
  tool_use_id?: string;
  guard?: { hits?: unknown; unclear?: unknown };
  // Stop
  stop_hook_active?: boolean;
  last_assistant_message?: string;
};

/**
 * A Codex tool as Kiko describes tools (core/decisions.ts describeTool, which knows Claude Code's
 * names): a shell command is already "Bash" with its `command`; a patch (apply_patch, its whole
 * text as `command`) is an edit of its first file ("Write" when it adds one). Anything else as Codex names it.
 */
export function toolOf(name: string, input: Record<string, unknown> | undefined): ToolUse {
  if (name !== "apply_patch") return { name, input };
  const patch = typeof input?.command === "string" ? input.command : "";
  const file = patch.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/m);
  if (!file) return { name: "Edit", input: { file_path: "a file", patch } };
  return { name: file[1] === "Add" ? "Write" : "Edit", input: { file_path: file[2].trim(), patch } };
}

/**
 * A Codex session waiting inside its hook for you, as core sees one held (../types.ts Held). How the
 * answer gets back is the subclass's: the hook's socket (CodexRequest), a stand-in in the harness.
 * Stop: answer(text) carries the turn on with it (decision "block"); answer(null) lets it stop.
 * PermissionRequest: allowed or denied, this once (Codex's hooks have no "always"); release() leaves
 * it to Codex's own prompt, which shows once the hook is gone.
 */
export abstract class CodexHeld implements Held {
  readonly event: CodexEvent;
  onClosed: () => void = () => {};

  constructor(event: CodexEvent) {
    this.event = event;
  }

  abstract get open(): boolean;

  protected abstract send(payload: Record<string, unknown>): boolean;

  /** A permission prompt: Codex's own, or a call the safety gate holds for you (its PreToolUse). */
  get isPermission() {
    return this.event.hook_event_name === "PermissionRequest" || this.guarded;
  }

  /** A call the safety gate holds (PreToolUse): let go, it's denied, since no prompt of Codex's follows. */
  get guarded() {
    return this.event.hook_event_name === "PreToolUse" && Boolean(this.event.guard);
  }

  /**
   * While Kiko holds it, Codex's terminal has no prompt to answer: its hooks run first, and its own
   * prompt shows only once the hook gives no decision (or a safety-gate ask's: none ever). Only
   * Kiko's cards answer it then.
   */
  get onlyHere() {
    return this.isPermission;
  }

  get sessionId() {
    return this.event.session_id;
  }

  get cwd() {
    return this.event.cwd;
  }

  readonly desktop = false;
  readonly agent = "codex";

  get text() {
    return this.event.last_assistant_message ?? "";
  }

  get continued() {
    return Boolean(this.event.stop_hook_active);
  }

  get tool(): ToolUse | null {
    return this.isPermission ? toolOf(this.event.tool_name ?? "", this.event.tool_input) : null;
  }

  // A hook's allow is for this request only: updatedPermissions fails Codex's hook (output_parser.rs).
  readonly canAllowAlways = false;
  // Codex's questions (request_user_input) never come through a permission hook.
  readonly questions = null;

  lastAsked() {
    return lastUserText(this.event.transcript_path);
  }

  saidThisTurn() {
    return this.isPermission ? null : saidSince(this.event.transcript_path);
  }

  // What's typed into Codex while its Stop hook runs goes into its turn ("steer"), not a queue Kiko can read.
  watchTyped() {}

  answer(reply: string | null) {
    return this.send({ reply });
  }

  allow(_always: boolean) {
    return this.send({ decision: { behavior: "allow" } });
  }

  deny(message: string) {
    return this.send({ decision: { behavior: "deny", message } });
  }

  answerQuestions(_answers: Answer[]) {
    return false;
  }

  release() {
    return this.isPermission ? this.send({ decision: null }) : this.send({ reply: null });
  }
}

/** A Codex session waiting inside its hook, on the other end of a socket connection. */
export class CodexRequest extends CodexHeld {
  private conn: Socket;
  private settled = false;

  constructor(event: CodexEvent, conn: Socket) {
    super(event);
    this.conn = conn;
    const closed = () => {
      if (this.settled) return;
      this.settled = true;
      log("hook_closed", { kind: event.hook_event_name, sessionId: event.session_id, agent: "codex" });
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
    log("hook_answer", { kind: this.event.hook_event_name, sessionId: this.event.session_id, agent: "codex", ...payload });
    endHook(this.conn, `${JSON.stringify(payload)}\n`);
    return true;
  }
}

/** What the adapter does with Codex's hooks (./index.ts sets them). */
type CodexHooks = {
  held(request: CodexHeld): void;
  started(event: CodexEvent): void;
  ended(event: CodexEvent): void;
  prompted(event: CodexEvent): void;
  /** Whether the prompt it took in is your dictated words, typed in by the app: the hook's answer. */
  dictated?(event: CodexEvent): boolean;
  interrupted(event: CodexEvent): void;
  asking(event: CodexEvent): void;
  /** A call the safety gate's rules flagged: its verdict, then (an ask) it's held as a card, on `conn`. */
  guard?(check: GuardCheck, event: CodexEvent, conn: Socket): void;
};

// The other apps' sessions already logged (`codex_other_app`), so each is logged once.
const othersLogged = new Set<string>();

/**
 * One line from codex-hook.mjs (../hook-routes.ts gives it here): told ones closed at once, held ones
 * kept open for the answer; one for another app's session (`otherApp`) closed at once, with no answer.
 */
export function onHookLine(event: Record<string, unknown>, conn: Socket, to: CodexHooks) {
  const e = event as CodexEvent;
  const kind = e.hook_event_name;
  if (typeof e.session_id !== "string" || typeof e.cwd !== "string") {
    endHook(conn);
    return;
  }
  const app = otherApp(e.session_id, e.transcript_path);
  if (app) {
    endHook(conn);
    if (!othersLogged.has(e.session_id)) {
      othersLogged.add(e.session_id);
      log("codex_other_app", { sessionId: e.session_id, originator: app, kind });
    }
    return;
  }
  if (kind === "PreToolUse" && e.guard) {
    const check = guardCheckOf(e, "codex");
    if (!check || !to.guard) return void endHook(conn);
    return to.guard(check, e, conn);
  }
  if (kind === "Stop" || kind === "PermissionRequest") {
    log(kind === "PermissionRequest" ? "hook_permission" : "hook_stop", { ...e });
    to.held(new CodexRequest(e, conn));
    return;
  }
  if (kind === "UserPromptSubmit") {
    if (typeof e.prompt !== "string") return void endHook(conn);
    // Answered before anything else is done with it: the hook waits a second at most. `voice` is
    // logged only when the hook was still there to be told (as claude-code/hooks.ts, 2026-11-14).
    const dictated = to.dictated?.(e) ?? false;
    const told = endHook(conn, `${JSON.stringify({ voice: dictated })}\n`);
    log("prompt_submitted", { sessionId: e.session_id, chars: e.prompt.length, agent: "codex", ...(dictated && told ? { voice: true } : {}) });
    return to.prompted(e);
  }
  endHook(conn);
  const fields = { sessionId: e.session_id, cwd: e.cwd, agent: "codex", ...(Number.isInteger(e.pid) ? { pid: e.pid } : {}) };
  switch (kind) {
    case "SessionStart":
      log("session_started", { ...fields, source: e.source });
      return to.started(e);
    case "SessionEnd":
      log("session_ended", { ...fields, reason: e.reason });
      return to.ended(e);
    case "Interrupt":
      log("session_interrupted", fields);
      return to.interrupted(e);
    case "PreToolUse":
      log("codex_question", fields);
      return to.asking(e);
    default:
      log("hook_unknown", { kind, agent: "codex" });
  }
}
