// A T3 Code thread waiting on you (its shell's pendingRuntimeRequest) as a permission prompt Kiko
// holds (../types.ts Held): asked on the Mac's card, by voice and on the phone, like Claude Code's,
// and answered back to T3 (orchestration.dispatchCommand, runtime-request.respond), so its run goes
// on. Read from T3's source at v0.1.5 (contracts/src/orchestrationV2.ts, providerPolicy.ts, and its
// client's client-runtime/src/state/threadRequests.ts derivePendingThreadRequests), never guessed:
//
//   the request     subscribeThread's projection: `runtimeRequests[]` (id, kind, status "pending",
//                   responseCapability {type: "live", supportsFeedback?})
//   what it asks    `turnItems[]`: the `approval_request` item with its requestId (prompt: the command
//                   for Claude's Bash, else Claude's title; `options` when the provider narrows the
//                   choices), and the tool's own item beside it (same nativeItemRef.nativeId):
//                   command_execution (input: the command), file_change (fileName), dynamic_tool
//                   (toolName, input: Claude's own tool input)
//   its questions   kind "user_input": the `user_input_request` item's questions (id, header, question,
//                   options {label, description, value?}, multiSelect?), Claude's AskUserQuestion
//   answered        {decision: "accept" | "acceptForSession" | "acceptAlways" | "decline", feedback?}
//                   or {answers: {<question id>: value or label, an array when it takes several}}
//
// Left to T3 (said as before: "waiting for you in T3 Code"): a request that can't be read (no item
// says what it asks), one whose answer can't reach the provider any more (not "live"), auth_refresh
// and dynamic_tool_call (T3's own client shows neither as an approval), and questions answered by a
// message (responseMode "message").
// "Always" is the session's allow (acceptForSession) unless the request's options say acceptAlways:
// Claude takes acceptAlways as a deny.
import { ASK_TOOL, type Answer, type AskQuestion } from "../../core/ask.ts";
import { isObject } from "../../core/is-object.ts";
import type { Held, ToolUse } from "../types.ts";

/** A decision T3 takes (providerPolicy.ts ProviderApprovalDecision); `cancel` (deny and stop the run) isn't offered. */
export type Decision = "accept" | "acceptForSession" | "acceptAlways" | "decline";

/** What a runtime-request.respond carries besides its thread and request. */
export type Response = { decision: Decision; feedback?: string } | { answers: Record<string, string | string[]> };

/** A pending request, as read from a thread's projection. */
export type Pending = {
  id: string;
  kind: string;
  /** The tool it asks to use, in Claude Code's shape (core/decisions.ts describeTool reads it). */
  tool: ToolUse;
  /** Questions (kind user_input): T3's, with their IDs and option values. Null for an approval. */
  questions: T3Question[] | null;
  /** The decisions it takes, when the provider narrowed them (null: T3's usual four). */
  decisions: Decision[] | null;
  supportsFeedback: boolean;
};

type T3Question = AskQuestion & { id: string; values: string[] };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The pending request `requestId` in a thread's projection, ready to ask about; null when it isn't
 * pending there, or it's one Kiko leaves to T3 (see the top).
 */
export function pendingRequest(projection: unknown, requestId: string): Pending | null {
  if (!isObject(projection)) return null;
  const requests: unknown[] = Array.isArray(projection.runtimeRequests) ? projection.runtimeRequests : [];
  const items: any[] = Array.isArray(projection.turnItems) ? projection.turnItems.filter(isObject) : [];
  const request = requests.find((r): r is Record<string, any> => isObject(r) && r.id === requestId);
  if (!request || request.status !== "pending") return null;
  const capability = isObject(request.responseCapability) ? request.responseCapability : {};
  if (capability.type !== "live") return null;
  const kind = str(request.kind);
  const supportsFeedback = capability.supportsFeedback === true;
  if (kind === "user_input") {
    const item = items.findLast((i) => i.type === "user_input_request" && i.requestId === requestId);
    if (!item || item.responseMode === "message") return null;
    const questions = questionsOf(item.questions);
    if (!questions) return null;
    return { id: requestId, kind, tool: { name: ASK_TOOL, input: { questions } }, questions, decisions: null, supportsFeedback };
  }
  if (!kind || kind === "auth_refresh" || kind === "dynamic_tool_call") return null;
  const item = items.findLast((i) => i.type === "approval_request" && i.requestId === requestId);
  // Nothing says what it asks: asking "allow?" of it would be blind.
  if (!item) return null;
  const prompt = str(item.prompt);
  const decisions = Array.isArray(item.options) ? item.options.map((o: any) => o?.decision).filter((d: unknown): d is Decision => typeof d === "string") : null;
  return { id: requestId, kind, tool: toolOf(kind, prompt, item, items), questions: null, decisions, supportsFeedback };
}

/** The tool an approval is about: its own item beside it (same native ID), else what the kind and prompt say. */
function toolOf(kind: string, prompt: string, approval: any, items: any[]): ToolUse {
  const native = str(approval?.nativeItemRef?.nativeId);
  const own = native ? items.findLast((i) => i !== approval && i.type !== "approval_request" && str(i.nativeItemRef?.nativeId) === native) : undefined;
  if (own?.type === "command_execution" && str(own.input)) return { name: "Bash", input: { command: str(own.input) } };
  if (own?.type === "file_change" && str(own.fileName)) return { name: kind === "file-read" ? "Read" : "Edit", input: { file_path: str(own.fileName) } };
  if (own?.type === "dynamic_tool" && str(own.toolName)) return { name: str(own.toolName), input: isObject(own.input) ? own.input : {} };
  // Its own item not there (or one Kiko doesn't read: a web search, an MCP tool's elicitation): what
  // T3 shows for it, as it is. The prompt may be Claude's title rather than a command, so it isn't read as one.
  return { name: prompt || kind.replace(/[-_]/g, " ") || "a tool", input: {} };
}

/** T3's questions as Kiko asks them; null when they can't be (none, or one without its text). */
function questionsOf(list: unknown): T3Question[] | null {
  if (!Array.isArray(list) || !list.length || list.length > 8) return null;
  const out: T3Question[] = [];
  for (const q of list) {
    if (!isObject(q) || !str(q.question) || !str(q.id)) return null;
    const options = (Array.isArray(q.options) ? q.options : []).filter((o: unknown) => isObject(o) && str((o as any).label)).slice(0, 8);
    out.push({
      id: str(q.id),
      question: str(q.question),
      header: str(q.header),
      options: options.map((o: any) => ({ label: str(o.label), description: str(o.description) })),
      values: options.map((o: any) => (typeof o.value === "string" ? o.value : str(o.label))),
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

/** The answers as T3 takes them (its client's pendingUserInput.ts): each question's ID → the value picked, an array when it takes several, or your words. */
export function answersOf(questions: T3Question[], answers: Answer[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (!a) return;
    const picked = a.labels.map((label) => q.values[q.options.findIndex((o) => o.label === label)] ?? label);
    const text = a.text.trim();
    out[q.id] = q.multiSelect ? [...picked, ...(text ? [text] : [])] : (picked[0] ?? text);
  });
  return out;
}

/**
 * A thread's pending request, held for you. `respond` sends the answer to T3 (false when it couldn't
 * go: T3 not connected); `release` leaves it in T3, unanswered. Closed (`onClosed`) when T3 says it's
 * no longer pending (answered in T3, the run stopped, the thread archived): `resolved`.
 */
export class T3Held implements Held {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isPermission = true;
  readonly desktop = false;
  readonly text = "";
  readonly continued = false;
  readonly pending: Pending;
  onClosed: () => void = () => {};
  private settled = false;
  private readonly asked: () => string;
  private readonly respond: (response: Response) => boolean;

  constructor(sessionId: string, cwd: string, pending: Pending, respond: (response: Response) => boolean, asked: () => string = () => "") {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.pending = pending;
    this.respond = respond;
    this.asked = asked;
  }

  get open() {
    return !this.settled;
  }

  get tool() {
    return this.pending.tool;
  }

  get questions(): AskQuestion[] | null {
    return this.pending.questions;
  }

  /** "Don't ask again": the session's allow, or always where the request offers it. */
  get canAllowAlways() {
    return this.always() !== null;
  }

  lastAsked() {
    return this.asked();
  }

  saidThisTurn() {
    return null;
  }

  // What's typed into T3 meanwhile goes to the thread as a message; nothing to watch here.
  watchTyped() {}

  answer() {
    return false;
  }

  allow(always: boolean) {
    const decision = always ? (this.always() ?? "accept") : "accept";
    return this.send({ decision });
  }

  deny(message: string) {
    return this.send({ decision: "decline", ...(this.pending.supportsFeedback && message ? { feedback: message } : {}) });
  }

  answerQuestions(answers: Answer[]) {
    if (!this.pending.questions) return false;
    return this.send({ answers: answersOf(this.pending.questions, answers) });
  }

  /** Left in T3, unanswered: its card there still takes it. */
  release() {
    if (this.settled) return false;
    this.settled = true;
    return true;
  }

  /** T3 says it's no longer pending: closed here, if it wasn't answered here. */
  resolved() {
    if (this.settled) return;
    this.settled = true;
    this.onClosed();
  }

  private always(): Decision | null {
    if (this.pending.questions) return null;
    const offered = this.pending.decisions;
    if (offered?.includes("acceptAlways")) return "acceptAlways";
    return !offered || offered.includes("acceptForSession") ? "acceptForSession" : null;
  }

  private send(response: Response) {
    if (this.settled) return false;
    this.settled = true;
    return this.respond(response);
  }
}
