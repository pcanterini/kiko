// A fake OpenCode background service (2.0.32's HTTP API, as src/agents/opencode/service.ts reads it,
// from OpenCode's source): its registration file (service.json: url, pid, version, password), Basic
// auth as "opencode" with that password, the event stream (`data: {id, created, type, data}` per
// event, server.connected first), and the endpoints Kiko uses, acted on as OpenCode does. A test
// scripts it: sessions in folders, a turn ending (its messages, then session.status idle and
// session.execution.succeeded), a permission or questions asked, a rename in its TUI. What Kiko
// sent is kept in `calls`. Never the real OpenCode: the tests point KIKO_OPENCODE_SERVICE here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";

export type FakeSession = { id: string; title?: string; cwd: string; parentID?: string; created: number; updated: number; viewed?: number; archived?: number };
export type FakeMessage = { id: string; type: "user" | "assistant" | "idle"; text?: string; created: number; writing?: boolean };
export type Call = { method: string; path: string; body: any };

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(++seq).toString().padStart(6, "0")}fake`;

export class FakeOpenCode {
  readonly password: string;
  readonly version: string;
  readonly sessions = new Map<string, FakeSession>();
  readonly messages = new Map<string, FakeMessage[]>();
  readonly permissions = new Map<string, any>();
  readonly forms = new Map<string, any>();
  readonly busy = new Set<string>();
  readonly calls: Call[] = [];
  /** Answers 401 to everything (a password that changed). */
  refuse = false;
  private server: Server | null = null;
  private streams = new Set<ServerResponse>();
  url = "";

  constructor(o: { password?: string; version?: string } = {}) {
    this.password = o.password ?? "fake-password-not-real";
    this.version = o.version ?? "2.0.32";
  }

  /** Listens on loopback and writes its registration file at `file`. */
  async start(file: string): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ id: "fake", version: this.version, url: this.url, pid: process.pid, password: this.password }), { mode: 0o600 });
    this.file = file;
    return this;
  }

  private file = "";

  /** Stops, as the service quits: its file removed, every stream ended. */
  async stop() {
    for (const s of this.streams) s.end();
    this.streams.clear();
    rmSync(this.file, { force: true });
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
    this.server = null;
  }

  /** How many event streams are open (Kiko's). */
  get listeners() {
    return this.streams.size;
  }

  // ── Scripting ──

  emit(type: string, data: Record<string, unknown>) {
    const frame = `data: ${JSON.stringify({ id: nextId("evt"), created: Date.now(), type, data })}\n\n`;
    for (const s of this.streams) s.write(frame);
  }

  /** A session made in `cwd` (as a TUI's first message makes one), told. */
  addSession(o: { id?: string; title?: string; cwd: string; parentID?: string; at?: number }): FakeSession {
    const at = o.at ?? Date.now();
    const s: FakeSession = { id: o.id ?? nextId("ses"), cwd: o.cwd, created: at, updated: at, ...(o.title ? { title: o.title } : {}), ...(o.parentID ? { parentID: o.parentID } : {}) };
    this.sessions.set(s.id, s);
    this.messages.set(s.id, []);
    this.emit("session.created", { sessionID: s.id, slug: s.id, location: { directory: s.cwd }, version: this.version });
    return s;
  }

  /** Renamed in its TUI (Ctrl+R): told. */
  renameInTui(id: string, title: string) {
    const s = this.sessions.get(id)!;
    s.title = title;
    this.emit("session.renamed", { sessionID: id, title });
  }

  /** A turn: your words, then its reply and the idle marker; busy, then idle and succeeded, as OpenCode tells it. */
  turn(id: string, asked: string, said: string) {
    const msgs = this.messages.get(id)!;
    const now = Date.now();
    if (asked) msgs.push({ id: nextId("msg"), type: "user", text: asked, created: now });
    this.busy.add(id);
    this.emit("session.status", { sessionID: id, status: { type: "busy" } });
    msgs.push({ id: nextId("msg"), type: "assistant", text: said, created: now + 1 }, { id: nextId("msg"), type: "idle", created: now + 2 });
    const s = this.sessions.get(id)!;
    s.updated = now + 2;
    this.busy.delete(id);
    this.emit("session.status", { sessionID: id, status: { type: "idle" } });
    this.emit("session.execution.succeeded", { sessionID: id });
  }

  /** A turn begun: your words in, and its reply being written (no finish or completed time yet), its first words streamed so far. */
  startReply(id: string, asked: string, sofar: string): FakeMessage {
    const msgs = this.messages.get(id)!;
    const now = Date.now();
    msgs.push({ id: nextId("msg"), type: "user", text: asked, created: now });
    this.busy.add(id);
    this.emit("session.status", { sessionID: id, status: { type: "busy" } });
    this.emit("session.inbox.delivered", { sessionID: id });
    const reply: FakeMessage = { id: nextId("msg"), type: "assistant", text: sofar, created: now + 1, writing: true };
    msgs.push(reply);
    this.emit("session.text.ended", { sessionID: id });
    return reply;
  }

  /** The reply startReply began, written in full: then idle and succeeded. */
  finishReply(id: string, reply: FakeMessage, said: string) {
    reply.text = said;
    delete reply.writing;
    this.messages.get(id)!.push({ id: nextId("msg"), type: "idle", created: Date.now() });
    this.busy.delete(id);
    this.emit("session.status", { sessionID: id, status: { type: "idle" } });
    this.emit("session.execution.succeeded", { sessionID: id });
  }

  /** A permission request (the shell tool's, by default), told. */
  askPermission(sessionID: string, o: { action?: string; resources?: string[]; save?: string[] } = {}) {
    const p = { id: nextId("per"), sessionID, action: o.action ?? "shell", resources: o.resources ?? ["npm test"], save: o.save ?? ["npm test *"], metadata: {} };
    this.permissions.set(p.id, p);
    this.emit("permission.asked", p);
    return p;
  }

  /** Its question tool's form, told. */
  askQuestions(sessionID: string, questions: { header: string; question: string; options: string[]; multiple?: boolean }[]) {
    const form = {
      id: nextId("frm"),
      sessionID,
      title: "Questions",
      metadata: { kind: "question", tool: { messageID: "msg_x", id: "call_x" } },
      fields: questions.map((q, i) => ({
        key: `q${i}`,
        title: q.header,
        description: q.question,
        type: q.multiple ? "multiselect" : "string",
        options: q.options.map((label) => ({ value: label, label })),
        custom: true,
      })),
    };
    this.forms.set(form.id, form);
    this.emit("form.created", { form });
    return form;
  }

  /** A permission answered in its TUI: told. */
  answerInTui(requestID: string) {
    const p = this.permissions.get(requestID);
    this.permissions.delete(requestID);
    this.emit("permission.replied", { sessionID: p?.sessionID, requestID, reply: "once" });
  }

  // ── The server ──

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const auth = req.headers.authorization ?? "";
    const want = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
    if (this.refuse || auth !== want) return this.send(res, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
    const url = new URL(req.url ?? "/", this.url);
    const body = await new Promise<any>((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    const path = url.pathname;
    if (req.method !== "GET" || !path.endsWith("/event")) this.calls.push({ method: req.method ?? "", path: `${path}${url.search}`, body });
    const m = (re: RegExp) => path.match(re);
    let x: RegExpMatchArray | null;
    if (req.method === "GET" && path === "/api/info") return this.send(res, 200, { version: this.version, pid: process.pid, urls: [this.url], paths: { tmp: "/tmp" } });
    if (req.method === "GET" && path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: nextId("evt"), type: "server.connected", data: {} })}\n\n`);
      this.streams.add(res);
      res.on("close", () => this.streams.delete(res));
      return;
    }
    if (req.method === "GET" && path === "/api/session/active") return this.send(res, 200, { data: Object.fromEntries([...this.busy].map((id) => [id, { type: "running" }])) });
    if (req.method === "GET" && path === "/api/session") {
      const dir = url.searchParams.get("directory");
      const top = url.searchParams.get("parentID") === "null";
      const list = [...this.sessions.values()].filter((s) => (!dir || s.cwd === dir) && (!top || !s.parentID)).sort((a, b) => b.updated - a.updated);
      return this.send(res, 200, { data: list.map((s) => this.info(s)), cursor: {} });
    }
    if ((x = m(/^\/api\/session\/([^/]+)$/))) {
      const s = this.sessions.get(decodeURIComponent(x[1]));
      if (!s) return this.send(res, 404, { _tag: "NotFound" });
      if (req.method === "GET") return this.send(res, 200, { data: this.info(s) });
      if (req.method === "PATCH") {
        if (typeof body?.title === "string") {
          s.title = body.title;
          this.emit("session.renamed", { sessionID: s.id, title: body.title });
        }
        return this.send(res, 204);
      }
    }
    if ((x = m(/^\/api\/session\/([^/]+)\/message$/)) && req.method === "GET") {
      const msgs = [...(this.messages.get(decodeURIComponent(x[1])) ?? [])].reverse().slice(0, Number(url.searchParams.get("limit") ?? 100));
      return this.send(res, 200, {
        data: msgs.map((g) =>
          g.type === "user"
            ? { id: g.id, type: "user", text: g.text, time: { created: g.created } }
            : g.type === "assistant"
              ? g.writing
                ? { id: g.id, type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, content: [{ type: "text", text: g.text }], time: { created: g.created, streamed: g.created } }
                : {
                    id: g.id,
                    type: "assistant",
                    agent: "build",
                    model: { id: "m", providerID: "p" },
                    content: [{ type: "text", text: g.text }],
                    finish: "stop",
                    time: { created: g.created, completed: g.created + 1 },
                  }
              : { id: g.id, type: "idle", outcome: "succeeded", time: { created: g.created } },
        ),
        cursor: {},
      });
    }
    if ((x = m(/^\/api\/session\/([^/]+)\/permission$/)) && req.method === "GET")
      return this.send(res, 200, { data: [...this.permissions.values()].filter((p) => p.sessionID === decodeURIComponent(x![1])) });
    if ((x = m(/^\/api\/session\/([^/]+)\/form$/)) && req.method === "GET") return this.send(res, 200, { data: [...this.forms.values()].filter((f) => f.sessionID === decodeURIComponent(x![1])) });
    if ((x = m(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)) && req.method === "POST") {
      const p = this.permissions.get(decodeURIComponent(x[2]));
      if (!p) return this.send(res, 404, { _tag: "NotFound" });
      this.permissions.delete(p.id);
      this.emit("permission.replied", { sessionID: p.sessionID, requestID: p.id, reply: body?.decision });
      return this.send(res, 204);
    }
    if ((x = m(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/)) && req.method === "POST") {
      const f = this.forms.get(decodeURIComponent(x[2]));
      if (!f) return this.send(res, 404, { _tag: "NotFound" });
      this.forms.delete(f.id);
      this.emit("form.replied", { id: f.id, sessionID: f.sessionID, answer: body?.answer });
      return this.send(res, 204);
    }
    if ((x = m(/^\/api\/session\/([^/]+)\/interrupt$/)) && req.method === "POST") {
      const id = decodeURIComponent(x[1]);
      const was = this.busy.delete(id);
      if (was) this.emit("session.status", { sessionID: id, status: { type: "idle" } });
      return this.send(res, 200, { interrupted: was });
    }
    if ((x = m(/^\/api\/session\/([^/]+)\/prompt$/)) && req.method === "POST") {
      const id = decodeURIComponent(x[1]);
      if (!this.sessions.has(id)) return this.send(res, 404, { _tag: "NotFound" });
      const msg = { id: nextId("msg"), sessionID: id, time: { created: Date.now() }, type: "user", payload: { text: body?.text ?? "" }, delivery: "queue" };
      this.messages.get(id)!.push({ id: msg.id, type: "user", text: body?.text ?? "", created: Date.now() });
      this.emit("session.inbox.enqueued", { sessionID: id, inboxID: msg.id, item: { type: "user", payload: msg.payload, delivery: "queue" } });
      return this.send(res, 200, { data: msg });
    }
    return this.send(res, 404, { _tag: "NotFound" });
  }

  private info(s: FakeSession) {
    return {
      id: s.id,
      projectID: "prj_fake",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: s.created, updated: s.updated, ...(s.viewed ? { viewed: s.viewed } : {}), ...(s.archived ? { archived: s.archived } : {}) },
      ...(s.title ? { title: s.title } : {}),
      ...(s.parentID ? { parentID: s.parentID } : {}),
      location: { directory: s.cwd },
    };
  }

  private send(res: ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
}
