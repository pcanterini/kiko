// The hooks socket, stood in for: a case hands the app a HookRequest with T.hooks.onRequest(...), and
// reads what it was answered (`reply`) and when. T.hooks.onSessionsChanged() is a session started or ended,
// T.hooks.onPromptSubmitted(id, prompt) one that took a prompt in (UserPromptSubmit), and T.hooks.dictated(id, prompt) what the app
// answers its hook: whether the prompt is your dictated words it typed in. What a hook's event means (the Held core sees) is
// the real module's HookHeld.
import { log } from "../../../../../src/core/log.ts";
import { HookHeld, HookServer as RealHookServer, type HookEvent } from "../../../../../src/agents/claude-code/hooks.ts";
export class HookRequest extends HookHeld {
  settled = false;
  reply: unknown = undefined;
  answers: unknown = undefined;
  settledAt = 0;
  constructor(event: HookEvent) {
    super(event);
  }
  get open() {
    return !this.settled;
  }
  protected send(payload: Record<string, unknown>) {
    if (this.settled) return false;
    // What it was answered: a Stop's reply (null: let it stop), or a permission's decision, and
    // Claude's questions' answers (question → answer) when it was those.
    const reply = "reply" in payload ? payload.reply : payload.decision;
    this.settled = true;
    this.reply = reply;
    this.answers = payload.answers;
    this.settledAt = Date.now();
    log("hook_answer", { kind: this.event.hook_event_name, sessionId: this.event.session_id, reply, ...(payload.answers ? { answers: payload.answers } : {}) });
    return true;
  }
}
// T.hooks.listen(): the real socket too (KIKO_SOCKET, out/voice.sock), for a case where a real
// hook-like client (the quick task's permission server, the real hook script on a prompt taken in)
// connects; T.hooks.unlisten() closes it.
export class HookServer {
  onRequest = (_: HookRequest) => {};
  onSessionsChanged = () => {};
  onPromptSubmitted = (_id: string, _prompt: string) => {};
  // Set by the adapter (src/agents/claude-code/index.ts): the app's answer to a prompt's hook.
  dictated = (_id: string, _prompt: string): boolean => false;
  onSessionEnded = (_id: string) => {};
  // T.hooks.onBlocked({sessionId, cwd, tool, reason, by, mode}): auto mode blocked a tool call (PermissionDenied).
  onBlocked = (_: { sessionId: string; cwd: string; tool: { name: string; input?: Record<string, unknown> }; reason: string; by?: "auto" | "rule"; mode?: string }) => {};
  // T.hooks.onGuard(check): a call the safety gate's rules flagged (PreToolUse), as the real server
  // hands it over; resolves to the app's verdict. Set by the adapter (src/agents/claude-code/index.ts).
  onGuard = (_: any): Promise<any> => Promise.resolve({ ask: false, why: "unset" });
  private real: RealHookServer | null = null;
  constructor() {
    (globalThis as any).T.hooks = this;
  }
  start() {
    return Promise.resolve();
  }
  stop() {
    this.unlisten();
  }
  async listen() {
    const real = new RealHookServer();
    real.onRequest = (r) => this.onRequest(r as any);
    real.onPromptSubmitted = (id, prompt) => this.onPromptSubmitted(id, prompt);
    real.dictated = (id, prompt) => this.dictated(id, prompt);
    await real.start();
    this.real = real;
  }
  unlisten() {
    this.real?.stop();
    this.real = null;
  }
}
