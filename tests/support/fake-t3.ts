// A fake T3 Code server for tests: never the real one. On 127.0.0.1 and a port the system picks, it
// answers what Kiko uses, in T3's real shapes (contracts at v0.1.5, read from its source):
//
//   GET  /.well-known/t3/environment          its descriptor: orchestrationProtocolVersion (`protocol`)
//   POST /api/auth/websocket-ticket/rpc       a one-time ticket, for a bearer token it issued
//   GET  /ws?wsTicket=…&orchestrationProtocol=2
//                                            426 with T3's body for another protocol, 401 for a bad
//                                            ticket, else Effect RPC frames (src/agents/t3code/rpc.ts):
//        orchestration.subscribeShell        a snapshot, then (`doubleSnapshot`) the empty second
//                                            one 30ms later, then thread.updated as threads change
//        orchestration.subscribeThread       a snapshot of the thread's projection (its messages)
//        orchestration.dispatchCommand       recorded in `dispatched`, answered with a sequence, and
//                                            acted on as T3 does: message.dispatch (the thread's
//                                            message), runtime-request.respond (the request resolved,
//                                            the thread's pendingRuntimeRequest cleared), thread.stop
//                                            and run.interrupt (its run interrupted; the run must be
//                                            its live one), thread.metadata.update (its title),
//                                            thread.archive (refused while its run is going, as T3's
//                                            client won't; then archived, location "archive")
//        server.getConfig                    `config`: its settings and providers (a new thread's model)
//        orchestration.launchThread          recorded in `launched`; a new thread in its project, told
//                                            to the shell, its first message taken by a run that starts
//                                            (none: an empty thread); refused for a project it doesn't
//                                            have, or with `refuseLaunch`
//   Chunks wait for the client's Ack, as T3's do. Ping gets Pong. `capabilities`: its descriptor's
//   (threadStop: whether Stop is thread.stop).
//
// Scripted: projects and threads (thread()), runs (startRun: taking the messages dispatched to it;
// completeRun: with the brief `waiting` as a run ends), a pending permission (askPermission: a
// command, a file change, or one with nothing to read; runtimeRequests and turnItems in its
// projection, as T3's), Claude's questions (askQuestions), restarts (dropAll). Tokens come from its
// own minter (`minter`), or from a fake CLI it writes (writeCli) that prints the same JSON as T3's.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { Secret } from "../../src/agents/secret.ts";
import type { Issued, Minter } from "../../src/agents/t3code/auth.ts";

type Thread = Record<string, any> & { id: string; projectId: string; title: string; status: string };
type Message = { id: string; threadId: string; runId: string | null; role: "user" | "assistant"; text: string; createdAt?: string };
type Stream = { ws: WebSocket; id: string; queue: unknown[][]; waiting: boolean; tag: string; threadId?: string };
/** A request a thread waits on, and the turn items that say what it asks (subscribeThread's runtimeRequests and turnItems). */
type Request = { threadId: string; request: Record<string, any>; items: Record<string, any>[] };
/** What a pending permission asks: a command, a file change, or (`none`) nothing Kiko can read. */
export type Asking = { command: string } | { file: string } | { tool: string; input: Record<string, unknown> } | { none: true };

export class FakeT3 {
  protocol = 2;
  /** The protocol its socket takes, when it isn't the one its descriptor says (a T3 between the two). */
  socketProtocol: number | null = null;
  /** The second, empty snapshot T3 sends about 30ms after the first. */
  doubleSnapshot = true;
  /** Its descriptor's capabilities: `threadStop` (Stop is thread.stop), else run.interrupt. */
  capabilities: Record<string, unknown> = {};
  /** The requests threads wait on (and waited on), by ID. */
  readonly requests = new Map<string, Request>();
  readonly projects = new Map<string, { id: string; title: string; workspaceRoot: string }>();
  readonly threads = new Map<string, Thread>();
  readonly messages: Message[] = [];
  private stamp = (m: Message) => this.messages.push({ createdAt: new Date().toISOString(), ...m });
  /** Every message.dispatch received. */
  readonly dispatched: any[] = [];
  /** Every orchestration.launchThread received. */
  readonly launched: any[] = [];
  /** launchThread refused with this message, when set. */
  refuseLaunch: string | null = null;
  /**
   * What server.getConfig answers (contracts ServerConfig: the fields a new thread's model is read
   * from): Codex first, as T3 lists its drivers, then Claude, both ready.
   */
  config: Record<string, any> = {
    settings: { defaultModelSelection: null, fallbackModelSelection: null, defaultRuntimeMode: "full-access", projectSettingsOverrides: {}, projectSettingsFolded: true, providerInstances: {} },
    providers: [
      {
        instanceId: "codex",
        driver: "codex",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra", isCustom: false, isDefault: true }],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, isDefault: true }],
      },
    ],
  };
  /** Every frame received, in order. */
  readonly frames: any[] = [];
  readonly tokens = new Map<string, { sessionId: string }>();
  readonly revoked: string[] = [];
  issuedCount = 0;
  /** What the socket's URL had: `orchestrationProtocol`, and whether a ticket was there (never the ticket). */
  readonly upgrades: { protocol: string | null; ticket: boolean; ok: boolean }[] = [];
  port = 0;
  private sequence = 1;
  private readonly tickets = new Set<string>();
  private readonly streams = new Set<Stream>();
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/.well-known/t3/environment") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            environmentId: "fake-env",
            label: "Fake T3",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.1.5",
            orchestrationProtocolVersion: this.protocol,
            capabilities: this.capabilities,
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/auth/websocket-ticket/rpc") {
        const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        if (!bearer || !this.tokens.has(bearer)) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ _tag: "EnvironmentAuthInvalidError" }));
        }
        const ticket = `ticket-${randomUUID()}`;
        this.tickets.add(ticket);
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ ticket, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      }
      res.statusCode = 404;
      res.end();
    });
    this.server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      const protocol = url.searchParams.get("orchestrationProtocol");
      const ticket = url.searchParams.get("wsTicket");
      const refuse = (status: number, body: unknown) => {
        this.upgrades.push({ protocol, ticket: Boolean(ticket), ok: false });
        const text = JSON.stringify(body);
        socket.end(`HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n\r\n${text}`);
      };
      if (url.pathname !== "/ws") return refuse(404, {});
      const speaks = this.socketProtocol ?? this.protocol;
      if (protocol !== String(speaks)) {
        return refuse(426, { code: "orchestration_protocol_incompatible", message: `Update this client to one that supports orchestration protocol ${speaks}.`, orchestrationProtocolVersion: speaks });
      }
      if (!ticket || !this.tickets.delete(ticket)) return refuse(401, { _tag: "EnvironmentAuthInvalidError" });
      this.upgrades.push({ protocol, ticket: true, ok: true });
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
    });
  }

  /** Listens on `port` (0: one the system picks). */
  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  async close() {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** T3 quitting or restarting: every socket dropped. */
  dropAll() {
    for (const ws of this.wss.clients) ws.terminate();
    this.streams.clear();
  }

  /** Open sockets now. */
  get sockets() {
    return this.wss.clients.size;
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /** Issues a token it accepts. */
  issue(ttlMs = 15 * 60_000): { sessionId: string; token: string; expiresAt: string } {
    const sessionId = `session-${++this.issuedCount}`;
    const token = `t3tok-${randomUUID()}`;
    this.tokens.set(token, { sessionId });
    return { sessionId, token, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
  }

  revoke(sessionId: string) {
    this.revoked.push(sessionId);
    for (const [token, s] of this.tokens) if (s.sessionId === sessionId) this.tokens.delete(token);
  }

  /** A minter for the client, as T3's CLI would mint (`ttlMs`: how long its tokens last). */
  minter(ttlMs?: number): Minter {
    return {
      issue: async (): Promise<Issued> => {
        const t = this.issue(ttlMs);
        return { sessionId: t.sessionId, token: new Secret(t.token), expiresAt: Date.parse(t.expiresAt) };
      },
      revoke: (sessionId) => this.revoke(sessionId),
    };
  }

  /**
   * A fake `t3` CLI at <home>/bin/t3: `auth session issue … --json` prints the JSON T3's prints
   * (with `token`, a token this server accepts); `auth session revoke <id>` records it in
   * <home>/revoked. It notes its arguments, and whether the app's keys reached it (never their
   * values), in <home>/calls.
   */
  writeCli(home: string) {
    const t = this.issue();
    mkdirSync(`${home}/bin`, { recursive: true });
    const script = `#!/usr/bin/env node
// Either module system (a package.json above it may say "module"): no require, no import.
const fs = process.getBuiltinModule("node:fs");
const args = process.argv.slice(2);
const leaked = Object.keys(process.env).filter((k) => k.startsWith("KIKO_") || k.endsWith("_API_KEY"));
fs.appendFileSync(${JSON.stringify(`${home}/calls`)}, JSON.stringify({ args, leaked }) + "\\n");
if (args[0] === "auth" && args[1] === "session" && args[2] === "issue") {
  process.stdout.write(JSON.stringify({ sessionId: ${JSON.stringify(t.sessionId)}, token: ${JSON.stringify(t.token)}, method: "bearer-session-token", scopes: ["orchestration:read", "orchestration:operate"], subject: "cli", expiresAt: ${JSON.stringify(t.expiresAt)} }, null, 2) + "\\n");
} else if (args[0] === "auth" && args[1] === "session" && args[2] === "revoke") {
  fs.appendFileSync(${JSON.stringify(`${home}/revoked`)}, args[3] + "\\n");
  process.stdout.write("Revoked session " + args[3] + ".\\n");
} else process.exit(2);
`;
    writeFileSync(`${home}/bin/t3`, script);
    chmodSync(`${home}/bin/t3`, 0o755);
    return t;
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  project(id: string, workspaceRoot: string, title = id) {
    this.projects.set(id, { id, title, workspaceRoot });
  }

  /** Adds or changes a thread (T3's ThreadShell, the fields Kiko reads and a few more), and tells the shell subscribers. */
  thread(id: string, fields: Partial<Thread> & { projectId?: string; title?: string } = {}): Thread {
    const had = this.threads.get(id);
    const now = new Date().toISOString();
    const t: Thread = {
      id,
      projectId: "p1",
      title: id,
      providerInstanceId: "claude",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      latestRunCompletedAt: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      ...had,
      ...fields,
    } as Thread;
    t.updatedAt = now;
    this.threads.set(id, t);
    this.toShell({ kind: "thread.updated", sequence: this.sequence++, location: "active", thread: t });
    return t;
  }

  /** A thread deleted: gone from the shell. */
  removeThread(id: string) {
    if (!this.threads.delete(id)) return;
    this.toShell({ kind: "thread.removed", sequence: this.sequence++, location: "active", threadId: id });
  }

  /**
   * A run starts in a thread, with your message (`asked`: typed in T3). Without one, it takes the
   * messages dispatched to the thread that no run has taken yet, as T3 does; none, "do the thing".
   */
  startRun(threadId: string, asked?: string): string {
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const pending = asked === undefined ? this.messages.filter((m) => m.threadId === threadId && m.role === "user" && m.runId === null) : [];
    for (const m of pending) m.runId = runId;
    if (!pending.length) this.stamp({ id: `m-${randomUUID()}`, threadId, runId, role: "user", text: asked ?? "do the thing" });
    this.thread(threadId, { latestRunId: runId, activeRunId: runId, status: "running", latestRunCompletedAt: null });
    return runId;
  }

  /** The thread's run completes with `reply`: `waiting` for a moment first, as T3 shows, then completed. */
  async completeRun(threadId: string, reply: string) {
    const t = this.threads.get(threadId);
    const runId = t?.latestRunId ?? this.startRun(threadId);
    this.stamp({ id: `m-${randomUUID()}`, threadId, runId, role: "assistant", text: reply });
    this.thread(threadId, { status: "waiting" });
    await new Promise((r) => setTimeout(r, 20));
    this.thread(threadId, { status: "completed", activeRunId: null, latestRunCompletedAt: new Date().toISOString() });
  }

  /**
   * The thread's run waits on a permission, in T3's card: a file change by default; `asking` a command,
   * another tool of Claude's, or nothing to read (no turn items). `options`: the decisions it takes, when narrowed.
   */
  askPermission(threadId: string, asking: Asking = { file: "src/login.ts" }, options?: string[]) {
    const id = `req-${randomUUID().slice(0, 8)}`;
    const kind = "command" in asking ? "command" : "file" in asking ? "file-change" : "tool" in asking ? "file-read" : "permission";
    const native = `toolu_${randomUUID().slice(0, 8)}`;
    const item = (type: string, fields: Record<string, unknown>) => this.turnItem(threadId, type, native, fields);
    const items =
      "none" in asking
        ? []
        : [
            "command" in asking
              ? item("command_execution", { input: asking.command })
              : "file" in asking
                ? item("file_change", { fileName: asking.file })
                : item("dynamic_tool", { toolName: asking.tool, input: asking.input }),
            item("approval_request", {
              requestId: id,
              requestKind: kind,
              prompt: "command" in asking ? asking.command : `Claude wants to ${kind}`,
              ...(options ? { options: options.map((decision) => ({ decision, label: decision })) } : {}),
            }),
          ];
    return this.pend(threadId, id, kind, items);
  }

  /** The thread's run asks you questions (Claude's AskUserQuestion), in T3's card: T3's question shapes, each with its ID. */
  askQuestions(
    threadId: string,
    questions: Array<{ id: string; header: string; question: string; options: Array<{ label: string; description: string; value?: string }>; multiSelect?: boolean }>,
    responseMode?: "message",
  ) {
    const id = `req-${randomUUID().slice(0, 8)}`;
    const items = [this.turnItem(threadId, "user_input_request", null, { requestId: id, questions, ...(responseMode ? { responseMode } : {}) })];
    return this.pend(threadId, id, "user_input", items);
  }

  /** The request, pending: in the projection, and on the thread's shell. */
  private pend(threadId: string, id: string, kind: string, items: Record<string, any>[]) {
    const createdAt = new Date().toISOString();
    const request = {
      id,
      nodeId: null,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "ps-1", supportsFeedback: true },
      createdAt,
      resolvedAt: null,
    };
    this.requests.set(id, { threadId, request, items });
    this.thread(threadId, { pendingRuntimeRequest: { id, kind, createdAt, blocking: true } });
    return id;
  }

  private turnItem(threadId: string, type: string, native: string | null, fields: Record<string, unknown>) {
    const runId = this.threads.get(threadId)?.latestRunId ?? null;
    const nativeItemRef = native ? { driver: "claudeAgent", nativeId: native, strength: "strong" } : null;
    return {
      id: `ti-${randomUUID().slice(0, 8)}`,
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef,
      parentItemId: null,
      ordinal: 0,
      status: "pending",
      title: null,
      startedAt: null,
      type,
      ...fields,
    };
  }

  /** A request answered in T3 itself (its card there): resolved, the thread no longer waiting. */
  resolveInT3(requestId: string) {
    const r = this.requests.get(requestId);
    if (!r) return;
    r.request.status = "resolved";
    if (this.threads.get(r.threadId)?.pendingRuntimeRequest?.id === requestId) this.thread(r.threadId, { pendingRuntimeRequest: null });
  }

  // ── The socket ─────────────────────────────────────────────────────────────

  private connected(ws: WebSocket) {
    ws.on("message", (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      this.frames.push(m);
      this.handle(ws, m);
    });
    ws.on("close", () => {
      for (const s of this.streams) if (s.ws === ws) this.streams.delete(s);
    });
  }

  private handle(ws: WebSocket, m: any) {
    switch (m._tag) {
      case "Ping":
        return ws.send(JSON.stringify({ _tag: "Pong" }));
      case "Ack": {
        const s = [...this.streams].find((x) => x.ws === ws && x.id === m.requestId);
        if (!s) return;
        s.waiting = false;
        return this.flush(s);
      }
      case "Interrupt": {
        const s = [...this.streams].find((x) => x.ws === ws && x.id === m.requestId);
        if (s) this.streams.delete(s);
        return ws.send(JSON.stringify({ _tag: "Exit", requestId: m.requestId, exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", fiberId: null }] } }));
      }
      case "Request":
        return this.request(ws, m);
    }
  }

  private request(ws: WebSocket, m: any) {
    const exit = (value: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value } }));
    const fail = (error: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } }));
    switch (m.tag) {
      case "orchestration.subscribeShell": {
        const s: Stream = { ws, id: m.id, queue: [], waiting: false, tag: m.tag };
        this.streams.add(s);
        this.push(s, [{ kind: "snapshot", snapshot: this.snapshot() }]);
        if (this.doubleSnapshot) {
          setTimeout(() => {
            if (this.streams.has(s)) this.push(s, [{ kind: "snapshot", snapshot: { ...this.snapshot(), threads: [], projects: [] } }]);
          }, 30);
        }
        return;
      }
      case "orchestration.subscribeThread": {
        const threadId = m.payload?.threadId;
        const thread = this.threads.get(threadId);
        if (!thread) return fail({ _tag: "OrchestrationV2ThreadNotFoundError", message: "Thread not found." });
        const s: Stream = { ws, id: m.id, queue: [], waiting: false, tag: m.tag, threadId };
        this.streams.add(s);
        const now = new Date().toISOString();
        const messages = this.messages
          .filter((x) => x.threadId === threadId)
          .map((x) => ({
            ...x,
            nodeId: null,
            attachments: [],
            streaming: false,
            createdAt: x.createdAt ?? now,
            updatedAt: x.createdAt ?? now,
            createdBy: x.role === "user" ? "user" : "agent",
            creationSource: "web",
          }));
        const mine = [...this.requests.values()].filter((r) => r.threadId === threadId);
        const runs = thread.latestRunId ? [{ id: thread.latestRunId, threadId, status: thread.activeRunId ? "running" : thread.status }] : [];
        const projection = {
          thread,
          runs,
          attempts: [],
          nodes: [],
          subagents: [],
          providerSessions: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: mine.map((r) => r.request),
          messages,
          plans: [],
          turnItems: mine.flatMap((r) => r.items),
          checkpointScopes: [],
          checkpoints: [],
          contextHandoffs: [],
          contextTransfers: [],
          visibleTurnItems: [],
          updatedAt: now,
        };
        return this.push(s, [{ kind: "snapshot", snapshotSequence: this.sequence, projection }]);
      }
      case "orchestration.dispatchCommand": {
        this.dispatched.push(m.payload);
        const c = m.payload ?? {};
        const rejected = (message: string) => fail({ _tag: "OrchestrationV2CommandRejectedError", message });
        const t = this.threads.get(c.threadId);
        if (!t) return rejected("Unknown thread.");
        switch (c.type) {
          case "message.dispatch":
            if (t.archivedAt) return rejected("Thread is archived.");
            this.stamp({ id: c.messageId, threadId: c.threadId, runId: null, role: "user", text: c.text });
            break;
          case "runtime-request.respond": {
            const r = this.requests.get(c.requestId);
            if (!r || r.threadId !== c.threadId || r.request.status !== "pending") return rejected("No such pending request.");
            Object.assign(r.request, {
              status: "resolved",
              resolvedAt: new Date().toISOString(),
              ...(c.decision ? { decision: c.decision } : {}),
              ...(c.feedback ? { feedback: c.feedback } : {}),
              ...(c.answers ? { answers: c.answers } : {}),
            });
            if (t.pendingRuntimeRequest?.id === c.requestId) this.thread(c.threadId, { pendingRuntimeRequest: null });
            break;
          }
          case "run.interrupt":
            if (!t.activeRunId || c.runId !== t.activeRunId) return rejected("That run isn't active.");
          // falls through: interrupted the same way
          case "thread.stop":
            this.thread(c.threadId, { status: "interrupted", activeRunId: null, pendingRuntimeRequest: null });
            break;
          case "thread.metadata.update":
            if (typeof c.title === "string") this.thread(c.threadId, { title: c.title });
            break;
          case "thread.archive":
            if (["preparing", "starting", "running"].includes(t.status)) return rejected("Stop the thread before archiving it.");
            t.archivedAt = new Date().toISOString();
            this.toShell({ kind: "thread.updated", sequence: this.sequence++, location: "archive", thread: t });
            break;
        }
        return exit({ sequence: this.sequence++ });
      }
      case "server.getConfig":
        return exit(this.config);
      case "orchestration.launchThread": {
        // As T3's ThreadLaunchService: the thread made in its project (thread.create), then its first
        // message dispatched, which starts a run; without one, an empty thread.
        const c = m.payload ?? {};
        this.launched.push(c);
        if (this.refuseLaunch) return fail({ _tag: "OrchestrationV2ThreadLaunchError", message: this.refuseLaunch });
        if (!this.projects.has(c.projectId)) return fail({ _tag: "OrchestrationV2ThreadLaunchError", message: "Project not found." });
        const threadId = c.threadId ?? `th-${randomUUID().slice(0, 8)}`;
        this.thread(threadId, {
          projectId: c.projectId,
          title: c.title,
          providerInstanceId: c.modelSelection?.instanceId,
          modelSelection: c.modelSelection,
          runtimeMode: c.runtimeMode,
          interactionMode: c.interactionMode,
        });
        if (c.initialMessage) {
          this.stamp({ id: c.initialMessage.messageId ?? `m-${randomUUID()}`, threadId, runId: null, role: "user", text: c.initialMessage.text });
          this.startRun(threadId);
        }
        return exit({ threadId, projection: { thread: this.threads.get(threadId) }, resumed: false });
      }
      default:
        return fail({ _tag: "RpcUnknownMethod", message: `Unknown method ${m.tag}` });
    }
  }

  private snapshot() {
    return {
      schemaVersion: 1,
      snapshotSequence: this.sequence,
      threads: [...this.threads.values()],
      archivedThreads: [],
      projects: [...this.projects.values()].map((p) => ({ ...p, defaultModelSelection: null, scripts: [], createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z" })),
    };
  }

  private toShell(item: unknown) {
    for (const s of this.streams) if (s.tag === "orchestration.subscribeShell") this.push(s, [item]);
  }

  /** A chunk, sent once the last one was acked. */
  private push(s: Stream, values: unknown[]) {
    s.queue.push(values);
    this.flush(s);
  }

  private flush(s: Stream) {
    if (s.waiting || !s.queue.length || !this.streams.has(s)) return;
    const values = s.queue.shift()!;
    s.waiting = true;
    s.ws.send(JSON.stringify({ _tag: "Chunk", requestId: s.id, values }));
  }
}
