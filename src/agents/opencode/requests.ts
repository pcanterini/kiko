// What an OpenCode session holds for you, as Kiko holds it (../types.ts Held): a finished turn,
// a permission request, or its questions. Read from OpenCode 2.0.32's source (schema/src/
// permission.ts and form.ts, core/src/tool/plugin/shell.ts, edit.ts, question.ts), never guessed:
//
//   a turn        session.execution.succeeded: its last reply read from its messages (newest
//                 first: the idle marker, the assistant's text, your message). OpenCode doesn't wait
//                 on anyone after a turn, so the reply window's answer is a new message through its
//                 service, as typed in its TUI; one typed there first (it's busy again) closes it
//   a permission  permission.asked {id, sessionID, action, resources, save?, metadata?}: `action` is
//                 the tool's ("shell" with the commands as `resources`, "edit" with the file,
//                 "webfetch" with the url, …), read in Claude Code's shape (core/decisions.ts reads
//                 it); answered once, always (only when it says what it would save: `save`, as its
//                 TUI offers "Always allow"), or reject with why. Let go, it's left asking in its TUI
//   its questions form.created whose metadata.kind is "question" (its question tool): one field per
//                 question, q0, q1, …, title the header, description the question, options by label,
//                 "multiselect" for several, any words of your own as well (`custom`). Answered with
//                 {q0: label or your words, q1: [labels…]}. Any other form (an MCP server asking) is
//                 said once, to answer in its window
//   a block       a call one of your deny rules stopped (never asked): said, never overridden (RuleBlocks)
import type { Answer, AskQuestion } from "../../core/ask.ts";
import { isObject } from "../../core/is-object.ts";
import type { Held, ToolUse } from "../types.ts";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A permission request, as read from permission.asked. */
export type Permission = { id: string; sessionId: string; tool: ToolUse; canAlways: boolean };

/** The tool a permission asks to use, in Claude Code's shape: its action and what it's for. */
export function toolOf(action: string, resources: string[], metadata: unknown): ToolUse {
  const first = resources[0] ?? "";
  switch (action) {
    case "shell":
    case "bash":
      return { name: "Bash", input: { command: resources.join("; ") } };
    case "edit":
    case "write":
    case "patch":
      return { name: "Edit", input: { file_path: first } };
    case "read":
      return { name: "Read", input: { file_path: first } };
    case "webfetch":
      return { name: "WebFetch", input: { url: first } };
    case "websearch":
      return { name: "WebSearch", input: { query: first } };
    case "glob":
      return { name: "Glob", input: { pattern: first } };
    case "grep":
      return { name: "Grep", input: { pattern: first } };
    default: {
      // An MCP tool (its server and name), a subagent, a skill, outside its folder: as OpenCode names it.
      const input = isObject(metadata) && isObject(metadata.input) ? metadata.input : resources.length && first !== "*" ? { resources } : {};
      return { name: action || "a tool", input };
    }
  }
}

/** A permission request from permission.asked (or the session's pending list); null when it can't be read. */
export function permissionOf(p: unknown): Permission | null {
  if (!isObject(p) || !str(p.id) || !str(p.sessionID) || typeof p.action !== "string") return null;
  const resources = Array.isArray(p.resources) ? p.resources.filter((r: unknown): r is string => typeof r === "string") : [];
  const save = Array.isArray(p.save) ? p.save.filter((r: unknown) => typeof r === "string") : [];
  return { id: str(p.id), sessionId: str(p.sessionID), tool: toolOf(p.action, resources, p.metadata), canAlways: save.length > 0 };
}

/** OpenCode's questions, as Kiko asks them: each with its field's key and option values. */
type FormQuestion = AskQuestion & { key: string; values: string[] };

/** A form that is OpenCode's questions (metadata.kind "question"); null for any other form, or one that can't be read. */
export function questionsOf(form: unknown): { id: string; sessionId: string; questions: FormQuestion[] } | null {
  if (!isObject<any>(form) || !str(form.id) || !str(form.sessionID) || form.metadata?.kind !== "question") return null;
  const fields: unknown[] = Array.isArray(form.fields) ? form.fields : [];
  if (!fields.length || fields.length > 8) return null;
  const questions: FormQuestion[] = [];
  for (const f of fields) {
    if (!isObject(f) || !str(f.key) || (f.type !== "string" && f.type !== "multiselect")) return null;
    const question = str(f.description) || str(f.title);
    if (!question) return null;
    const options = (Array.isArray(f.options) ? f.options : []).filter((o: unknown) => isObject(o) && str((o as any).label)).slice(0, 8);
    questions.push({
      key: str(f.key),
      question,
      header: str(f.title),
      options: options.map((o: any) => ({ label: str(o.label), description: str(o.description) })),
      values: options.map((o: any) => (typeof o.value === "string" ? o.value : str(o.label))),
      multiSelect: f.type === "multiselect",
    });
  }
  return { id: str(form.id), sessionId: str(form.sessionID), questions };
}

/** The answers as the form takes them: each question's key → the value picked or your words, an array for several. */
export function formAnswer(questions: FormQuestion[], answers: Answer[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    const picked = a.labels.map((label) => q.values[q.options.findIndex((o) => o.label === label)] ?? label);
    const text = a.text.trim();
    out[q.key] = q.multiSelect ? [...picked, ...(text ? [text] : [])] : (picked[0] ?? text);
  });
  return out;
}

/** How OpenCode says a permission was answered (permission.replied's `reply`, 2.0.32). */
export type PermissionReply = "once" | "always" | "reject";

/** A permission.replied event's request and reply (`reply` null when it says none Kiko knows). Null without a request. */
export function repliedOf(d: unknown): { requestId: string; sessionId: string; reply: PermissionReply | null } | null {
  const e = d as { requestID?: unknown; sessionID?: unknown; reply?: unknown } | null;
  if (!e || typeof e.requestID !== "string" || !e.requestID) return null;
  const reply = e.reply === "once" || e.reply === "always" || e.reply === "reject" ? e.reply : null;
  return { requestId: e.requestID, sessionId: typeof e.sessionID === "string" ? e.sessionID : "", reply };
}

/** How long after Kiko rejects one of a session's asks OpenCode's rejects of the rest (its batch) may come. */
export const BATCH_MS = 5000;

/**
 * How a held permission OpenCode says was replied to (and Kiko didn't answer) came down: answered in
 * its TUI, with its reply; or (null) one of the batch OpenCode rejects with a reject Kiko just sent
 * for another of its session's asks (`rejectedHereAt`): not answered there, only gone.
 */
export function repliedHow(reply: PermissionReply | null, rejectedHereAt: number | undefined, now = Date.now()): { reply: PermissionReply | null } | null {
  return reply === "reject" && rejectedHereAt !== undefined && now - rejectedHereAt < BATCH_MS ? null : { reply };
}

/**
 * The held requests a session stopping ends (its turn interrupted with Esc in its TUI, failed, or the
 * session gone idle): OpenCode 2.0.32 drops what it waits on then without a permission.replied
 * (packages/core/src/permission.ts: an interrupted ask's entry is only deleted). Those it asked
 * itself, and every one held as its own (a subagent's under a top-level session that stopped).
 */
export function endedBy<H extends { sessionId: string; askedIn: string; open: boolean }>(held: Iterable<H>, sessionId: string): H[] {
  if (!sessionId) return [];
  return [...held].filter((h) => h.open && (h.askedIn === sessionId || h.sessionId === sessionId));
}

/** What answering a request sends back: a permission's decision (with why, for a reject), or a form's answer. */
export type Reply = { decision: PermissionReply; message?: string } | { answer: Record<string, string | string[]> };

/**
 * A permission request or questions, held for you. `reply` sends the answer to OpenCode (false when
 * it couldn't go: the service isn't connected); `release` leaves it asking in its TUI. Closed
 * (`onClosed`) when OpenCode says it's settled (answered in its TUI, the turn stopped): `resolved`.
 */
export class OpenCodeHeld implements Held {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isPermission = true;
  readonly desktop = false;
  readonly text = "";
  readonly continued = false;
  readonly tool: ToolUse;
  readonly canAllowAlways: boolean;
  readonly questions: FormQuestion[] | null;
  /** The request's (or form's) ID in OpenCode. */
  readonly requestId: string;
  /** The session that asked it: `sessionId`'s own, or its subagent's. */
  readonly askedIn: string;
  onClosed: () => void = () => {};
  /** Answered in its TUI (`resolved` with OpenCode's reply): Held.closedHow. */
  closedHow?: "terminal";
  /** How it was answered there: OpenCode's reply ("once", "always", "reject"). */
  repliedThere: PermissionReply | null = null;
  private settled = false;
  private readonly asked: () => string;
  private readonly reply: (reply: Reply) => boolean;

  constructor(
    o: { sessionId: string; cwd: string; requestId: string; tool: ToolUse; canAllowAlways: boolean; questions: FormQuestion[] | null; askedIn?: string },
    reply: (reply: Reply) => boolean,
    asked: () => string = () => "",
  ) {
    this.sessionId = o.sessionId;
    this.askedIn = o.askedIn ?? o.sessionId;
    this.cwd = o.cwd;
    this.requestId = o.requestId;
    this.tool = o.tool;
    this.canAllowAlways = o.canAllowAlways;
    this.questions = o.questions;
    this.reply = reply;
    this.asked = asked;
  }

  get open() {
    return !this.settled;
  }

  lastAsked() {
    return this.asked();
  }

  saidThisTurn() {
    return null;
  }

  // Typed into its TUI meanwhile goes to the session as a message (queued): nothing to watch here.
  watchTyped() {}

  answer() {
    return false;
  }

  allow(always: boolean) {
    if (this.questions) return false;
    return this.send({ decision: always && this.canAllowAlways ? "always" : "once" });
  }

  deny(message: string) {
    if (this.questions) return false;
    return this.send({ decision: "reject", ...(message ? { message } : {}) });
  }

  answerQuestions(answers: Answer[]) {
    if (!this.questions) return false;
    return this.send({ answer: formAnswer(this.questions, answers) });
  }

  /** Left asking in its TUI: answered there. */
  release() {
    if (this.settled) return false;
    this.settled = true;
    return true;
  }

  /**
   * OpenCode says it's settled: closed here, if it wasn't answered here. `there`: it was answered
   * in its TUI (`closedHow` "terminal"), with its permission.replied's `reply` (null for questions,
   * form.replied); none: it went away otherwise (its turn stopped, the session went idle, the
   * service dropped).
   */
  resolved(there: { reply: PermissionReply | null } | null = null) {
    if (this.settled) return;
    this.settled = true;
    if (there) {
      this.closedHow = "terminal";
      this.repliedThere = there.reply;
    }
    this.onClosed();
  }

  private send(reply: Reply) {
    if (this.settled) return false;
    this.settled = true;
    return this.reply(reply);
  }
}

/** A finished turn as read from its messages (newest first): its last reply, your words before it, and all you said this turn. */
export type Turn = { said: string; asked: string; turn: string[] };

/**
 * A turn's words from a session's messages, newest first: the last assistant message with words
 * (a turn can end on tools), the last thing you said, and what you said since the turn before
 * ended (its idle marker; the newest one is this turn's own end).
 */
export function turnOf(messages: readonly { role: string; text: string }[]): Turn {
  let said = "";
  let asked = "";
  const turn: string[] = [];
  let started = false;
  for (const m of messages) {
    // The idle marker before anything else is this turn's own end; the next one, the turn before's.
    if (m.role === "idle") {
      if (started) break;
      continue;
    }
    started = true;
    if (m.role === "assistant" && !said && m.text) said = m.text;
    if (m.role === "user" && m.text) {
      if (!asked) asked = m.text;
      turn.unshift(m.text);
    }
  }
  return { said, asked, turn };
}

/**
 * A finished turn, held for you: read out, with a reply window whose answer goes to the session as
 * a new message (`send`: false when it couldn't go). Nothing waits in OpenCode meanwhile, so letting
 * it go does nothing there; it's closed (`close`) when the session starts another turn by itself.
 */
export class OpenCodeTurn implements Held {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isPermission = false;
  readonly desktop = false;
  readonly text: string;
  readonly continued: boolean;
  readonly tool = null;
  readonly canAllowAlways = false;
  readonly questions = null;
  onClosed: () => void = () => {};
  private settled = false;
  private readonly words: Turn;
  private readonly send: (text: string) => boolean;

  constructor(o: { sessionId: string; cwd: string; turn: Turn; continued: boolean }, send: (text: string) => boolean) {
    this.sessionId = o.sessionId;
    this.cwd = o.cwd;
    this.text = o.turn.said;
    this.words = o.turn;
    this.continued = o.continued;
    this.send = send;
  }

  get open() {
    return !this.settled;
  }

  lastAsked() {
    return this.words.asked;
  }

  saidThisTurn() {
    return this.words.turn.length ? this.words.turn : this.words.asked ? [this.words.asked] : null;
  }

  watchTyped() {}

  answer(reply: string | null) {
    if (this.settled) return false;
    this.settled = true;
    return reply === null ? true : this.send(reply);
  }

  allow() {
    return false;
  }

  deny() {
    return false;
  }

  answerQuestions() {
    return false;
  }

  release() {
    if (this.settled) return false;
    this.settled = true;
    return true;
  }

  /** Superseded: the session took another message (typed in its TUI) and works again. */
  close() {
    if (this.settled) return;
    this.settled = true;
    this.onClosed();
  }
}

/** A call OpenCode's own permissions stopped without asking, as RuleBlocks reads it. */
export type RuleBlock = { sessionId: string; callId: string; tool: ToolUse; reason: string };

/** A blocked call's tool in Claude Code's shape (core/permission-mode.ts says it), from OpenCode's tool name and input. */
function blockedToolOf(name: string, input: Record<string, unknown>): ToolUse {
  const path = str(input.path) || str(input.filePath) || str(input.file_path);
  switch (name) {
    case "shell":
    case "bash":
      return { name: "Bash", input: { command: str(input.command) } };
    case "edit":
    case "patch":
      return { name: "Edit", input: path ? { file_path: path } : {} };
    case "write":
      return { name: "Write", input: path ? { file_path: path } : {} };
    case "read":
      return { name: "Read", input: path ? { file_path: path } : {} };
    case "webfetch":
      return { name: "WebFetch", input: { url: str(input.url) } };
    case "websearch":
      return { name: "WebSearch", input: {} };
    default:
      return { name: name || "a tool", input: {} };
  }
}

/** The most calls (and asked calls) kept at once: the oldest go first. */
const MAX_CALLS = 500;

/**
 * Calls OpenCode's own permissions stopped without asking: one of your deny rules (or a plugin's
 * deny), which its service tells only as the call failing, `session.tool.failed` with error type
 * "permission.rejected" (2.0.32's core/src/permission.ts BlockedError, its message the rule's reason
 * or "Permission denied: <action>"; session/to-session-error.ts). A prompt rejected with words fails
 * the same way (CorrectedError), so a call a `permission.asked` was made for (its `source.id`, the
 * call's) is never one. Its tool is the one `session.tool.input.started` named and
 * `session.tool.called` gave input to, kept by the call's ID until it ends. Only told, never
 * overridden: the rule is your own setting, and OpenCode has no way to allow past it.
 */
export class RuleBlocks {
  private readonly calls = new Map<string, { sessionId: string; name: string; input: Record<string, unknown> }>();
  private readonly asked = new Map<string, true>();

  /** One of the service's events: the block it tells of, if it's one; null for anything else. */
  seen(type: string, d: Record<string, any>): RuleBlock | null {
    const id = str(d?.id);
    switch (type) {
      case "permission.asked": {
        const call = str(d?.source?.id);
        if (call) keep(this.asked, call, true);
        return null;
      }
      case "session.tool.input.started":
        if (id && str(d.sessionID)) keep(this.calls, id, { sessionId: str(d.sessionID), name: str(d.name), input: {} });
        return null;
      case "session.tool.called": {
        const call = this.calls.get(id);
        if (call && isObject(d.input)) call.input = d.input;
        else if (id && str(d.sessionID) && isObject(d.input)) keep(this.calls, id, { sessionId: str(d.sessionID), name: str(d.name), input: d.input });
        return null;
      }
      case "session.tool.success":
        this.calls.delete(id);
        this.asked.delete(id);
        return null;
      case "session.tool.failed": {
        const call = this.calls.get(id);
        const asked = this.asked.has(id);
        this.calls.delete(id);
        this.asked.delete(id);
        const sessionId = str(d.sessionID) || call?.sessionId || "";
        if (d.error?.type !== "permission.rejected" || asked || !sessionId) return null;
        return { sessionId, callId: id, tool: blockedToolOf(call?.name ?? "", call?.input ?? {}), reason: str(d.error.message) };
      }
    }
    return null;
  }
}

/** Kept as the newest, the oldest let go past MAX_CALLS. */
function keep<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CALLS) map.delete(map.keys().next().value!);
}
