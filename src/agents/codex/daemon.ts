// Codex's shared app-server daemon (0.166 on): every Codex TUI on this Mac attaches to it, and its
// threads live there. Kiko connects to it as one more local client and asks it which threads are
// open, so a Codex session is listed as soon as it's open, before its first turn (which is when its
// hooks first run), wherever its terminal is. Read from Codex 0.166.0's source, never guessed
// (codex-rs/app-server-transport, app-server-client, app-server-protocol v2):
//
//   where     $CODEX_HOME/app-server-control/app-server-control.sock, a link to the socket itself
//             (in /tmp/codex-daemon-<uid>/: the link's own path can be too long for a unix socket).
//             No token: the socket is the user's own (0600 in a 0700 folder), as for the TUI
//   framing   a WebSocket over that socket (the TUI's handshake URL is ws://localhost/rpc), one
//             JSON-RPC message per text frame, without "jsonrpc": {id, method, params} → {id,
//             result} | {id, error}; {method, params} for notifications either way
//   hello     initialize {clientInfo} → {userAgent, codexHome, …}, then the `initialized` notification
//   listed    thread/loaded/list → {data: [threadId…]}: the threads loaded now; thread/read
//             {threadId} → {thread} (a read: nothing written, nothing subscribed to): its cwd, name,
//             status (idle | active {activeFlags} | systemError | notLoaded), source, originator
//   told      broadcast to every client: thread/started {thread}, thread/closed {threadId} (unloaded),
//             thread/name/updated {threadId, threadName} (a /rename in Codex, or ours),
//             thread/status/changed {threadId, status}, thread/archived and thread/deleted,
//             thread/settings/updated {threadId, threadSettings} (its approval policy, approvals
//             reviewer, sandbox and collaboration mode: its permission mode, codexModeOf; read from
//             `codex app-server generate-ts`, 0.166.0's own bindings: thread/read has none of it)
//   renamed   thread/name/set {threadId, name} → {}: Codex's own name for it, shown in its TUI
//             (which takes the thread/name/updated that follows) and written to session_index.jsonl
//   stopped   thread/turns/list {threadId, limit: 1} for its turn in progress, then turn/interrupt
//             {threadId, turnId}, which Codex refuses for any turn but the one running (as Escape)
//
// A thread stays loaded for a while after its TUI quits (`thread_unload_delay_secs`, 60 by default)
// and the daemon doesn't say which threads a TUI is attached to, so a thread is listed only while a
// Codex TUI runs in its folder (./processes.ts; ./sessions.ts mergeLive). When the daemon isn't
// running (a Codex before 0.166, or none open yet), nothing here does anything: Codex's sessions
// are listed from its hooks, as before. Logged: `codex_daemon {ok, why}` when that changes.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { log as appLog } from "../../core/log.ts";
import type { PermissionMode } from "../../core/permission-mode.ts";
import type { Done } from "../types.ts";
import { codexOriginator } from "./origin.ts";
import { NAME, SLUG } from "../../core/name.ts";

/** The daemon's socket, as Codex advertises it (a link). */
const daemonSocket = (home: string) => join(home, "app-server-control", "app-server-control.sock");

/** A Codex thread the daemon has open, as Kiko lists it (times in ms epoch). */
export type DaemonThread = {
  id: string;
  cwd: string;
  /** Codex's own name for it (/rename), or "". */
  name: string;
  /** idle | busy | blocked (waiting on an approval or an answer in its window). */
  status: string;
  /** When the daemon last told its status (this process's clock): newer than a hook's record of it, or not. */
  statusAt: number;
  /** Its rollout, when Codex said. */
  path: string | null;
  createdAt: number;
  updatedAt: number;
  /** Its permission mode in Claude Code's words (codexModeOf), once the daemon has told its settings; else left out. */
  mode?: PermissionMode;
};

/**
 * A thread's settings (ThreadSettings) as one of Claude Code's permission modes, the nearest:
 *   plan                its collaboration mode is plan
 *   bypassPermissions   never asks, no sandbox (--dangerously-bypass-approvals-and-sandbox)
 *   auto                its requests go to Codex's automatic reviewer (auto_review, guardian_subagent)
 *   dontAsk             never asks, in a sandbox: what it can't do fails
 *   default             asks for more than reading (read-only sandbox, or "untrusted")
 *   acceptEdits         writes in its folder without asking, asks past it (workspace-write, on-request)
 * Null for anything else (full access that still asks, an external sandbox): not said rather than guessed.
 */
export function codexModeOf(settings: any): PermissionMode | null {
  if (!settings || typeof settings !== "object") return null;
  const approval = settings.approvalPolicy;
  const sandbox = settings.sandboxPolicy?.type;
  if (settings.collaborationMode?.mode === "plan") return "plan";
  if (approval === "never" && sandbox === "dangerFullAccess") return "bypassPermissions";
  if (settings.approvalsReviewer === "auto_review" || settings.approvalsReviewer === "guardian_subagent") return "auto";
  if (approval === "never") return "dontAsk";
  if (approval === "untrusted" || sandbox === "readOnly") return "default";
  if (sandbox === "workspaceWrite") return "acceptEdits";
  return null;
}

/** A thread's status as Codex says it (ThreadStatus), in Kiko's words. */
export function statusOf(status: any): string {
  if (status?.type !== "active") return "idle";
  const flags: unknown[] = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput") ? "blocked" : "busy";
}

/**
 * A thread as the daemon gives it (thread/read, thread/started), as Kiko lists it; null for one
 * that isn't a session in a terminal: a subagent's or a review's (a parent, or a subAgent source),
 * one that's never saved (ephemeral), a one-shot `codex exec`, or one an app runs (its originator
 * isn't Codex's TUI or CLI: 0.166's TUI is "codex-tui", older ones "codex_cli_rs"; ./origin.ts).
 */
export function threadOf(t: any, now = Date.now()): DaemonThread | null {
  if (!t || typeof t.id !== "string" || typeof t.cwd !== "string" || !t.cwd) return null;
  if (t.ephemeral === true || t.parentThreadId) return null;
  if (t.source && typeof t.source === "object") return null;
  if (t.source === "exec" || t.source === "appServer") return null;
  if (!codexOriginator(t.originator)) return null;
  const secs = (v: unknown) => (typeof v === "number" ? v * 1000 : 0);
  return {
    id: t.id,
    cwd: t.cwd,
    name: typeof t.name === "string" ? t.name.trim() : "",
    status: statusOf(t.status),
    statusAt: now,
    path: typeof t.path === "string" && t.path ? t.path : null,
    createdAt: secs(t.createdAt),
    updatedAt: secs(t.updatedAt),
  };
}

type Pending = { resolve(value: any): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> };

/** A request's answer is waited for this long; an interrupt's longer (Codex answers once the turn has stopped). */
const REQUEST_MS = 5000;
const INTERRUPT_MS = 10_000;
/** Not connected: looked for again at most this often, as the sessions are listed. */
const RETRY_MS = 2000;

type DaemonOptions = { home: string; log?: (event: string, data: Record<string, unknown>) => void; version?: string };

export class CodexDaemon {
  /** Its threads changed (one opened, closed, renamed, or started or stopped working): list them again. */
  onChanged: () => void = () => {};

  private readonly configure: () => DaemonOptions;
  private options: DaemonOptions | null = null;
  private ws: WebSocket | null = null;
  private next = 1;
  private readonly calls = new Map<number, Pending>();
  /** The threads it has open that are sessions (threadOf), by ID; and the IDs it has that aren't, so they aren't read again. */
  private readonly threads = new Map<string, DaemonThread>();
  private readonly others = new Set<string>();
  private running = false;
  private triedAt = 0;
  private connecting: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private logged = "";

  /** `configure`: read when it starts (the app's environment is settled by then). */
  constructor(configure: () => DaemonOptions) {
    this.configure = configure;
  }

  /** Connected (initialized) now. */
  get connected() {
    return this.ws !== null;
  }

  /** Starts: one try now (connected or not), more as the sessions are listed. Never throws. */
  start(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.options = this.configure();
    }
    return this.tryConnect(true);
  }

  stop() {
    this.running = false;
    this.drop("stopped", false);
  }

  /** Whether it has a thread open (one Kiko lists from it): renamed and interrupted through it. */
  has(threadId: string) {
    return this.ws !== null && this.threads.has(threadId);
  }

  /** Codex's name for a thread it has open ("" for none given), or undefined for one it doesn't have. */
  nameOf(threadId: string): string | undefined {
    return this.ws ? this.threads.get(threadId)?.name : undefined;
  }

  /** Its rollout, for one it has open that said. */
  pathOf(threadId: string): string | undefined {
    return (this.ws && this.threads.get(threadId)?.path) || undefined;
  }

  /**
   * The threads it has open now that are sessions, asked afresh (thread/loaded/list; thread/read
   * for any it hadn't told of); null when it isn't there (not running, or not reachable).
   */
  async loaded(): Promise<DaemonThread[] | null> {
    if (!this.running) return null;
    if (!this.ws) await this.tryConnect(false);
    if (!this.ws) return null;
    await this.refresh();
    return this.ws ? [...this.threads.values()] : null;
  }

  /** A thread's name in Codex (thread/name/set): shown in its TUI, and listed by it. */
  async rename(threadId: string, name: string): Promise<Done> {
    if (!this.ws) return { done: false, why: "Codex's app server isn't connected" };
    try {
      await this.request("thread/name/set", { threadId, name });
      const t = this.threads.get(threadId);
      if (t) t.name = name.trim();
      this.log("codex_command", { method: "thread/name/set", threadId, ok: true });
      return { done: true };
    } catch (err) {
      const why = `Codex didn't take it (${messageOf(err)})`;
      this.log("codex_command", { method: "thread/name/set", threadId, ok: false, why });
      return { done: false, why };
    }
  }

  /** A thread's turn in progress interrupted (turn/interrupt), as Escape in its window would; none running: said so. */
  async interrupt(threadId: string): Promise<Done> {
    if (!this.ws) return { done: false, why: "Codex's app server isn't connected" };
    try {
      const turns = await this.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      const turn = Array.isArray(turns?.data) ? turns.data[0] : null;
      if (!turn || turn.status !== "inProgress" || typeof turn.id !== "string") return { done: false, why: "it isn't running anything" };
      await this.request("turn/interrupt", { threadId, turnId: turn.id }, INTERRUPT_MS);
      this.log("codex_command", { method: "turn/interrupt", threadId, ok: true });
      return { done: true };
    } catch (err) {
      const why = `Codex didn't take it (${messageOf(err)})`;
      this.log("codex_command", { method: "turn/interrupt", threadId, ok: false, why });
      return { done: false, why };
    }
  }

  // ── The connection ──

  private log(event: string, data: Record<string, unknown>) {
    (this.options?.log ?? appLog)(event, data);
  }

  /** `codex_daemon` logged when whether it's connected (or why not) changes. */
  private say(ok: boolean, why: string) {
    const key = `${ok}:${why}`;
    if (key === this.logged) return;
    this.logged = key;
    this.log("codex_daemon", ok ? { ok } : { ok, why });
  }

  /** One try at connecting, unless one is under way or (`now` false) one was made a moment ago. */
  private tryConnect(now: boolean): Promise<void> {
    if (this.ws || !this.running) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!now && Date.now() - this.triedAt < RETRY_MS) return Promise.resolve();
    this.triedAt = Date.now();
    this.connecting = this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect() {
    const home = this.options!.home;
    const link = daemonSocket(home);
    if (!existsSync(link)) return this.say(false, "not running");
    let socket: string;
    try {
      // The link's target: Node connects to the path it's given, which has to fit a unix socket's.
      socket = realpathSync(link);
    } catch {
      return this.say(false, "not running");
    }
    const ws = await new Promise<WebSocket | null>((resolve) => {
      const ws = new WebSocket(`ws+unix://${socket}:/rpc`, { handshakeTimeout: 3000 });
      const fail = () => {
        ws.removeAllListeners();
        ws.on("error", () => {});
        ws.terminate();
        resolve(null);
      };
      ws.once("error", fail);
      ws.once("unexpected-response", fail);
      ws.once("open", () => {
        ws.removeAllListeners();
        resolve(ws);
      });
    });
    if (!ws) return this.say(false, "it didn't answer");
    if (!this.running) return void ws.close();
    ws.on("message", (data) => this.receive(ws, String(data)));
    ws.on("close", () => this.closed(ws));
    ws.on("error", () => this.closed(ws));
    try {
      await this.call(ws, "initialize", { clientInfo: { name: SLUG, title: NAME, version: this.options!.version ?? "0" } });
      ws.send(JSON.stringify({ method: "initialized" }));
    } catch (err) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      return this.say(false, `initialize failed (${messageOf(err)})`);
    }
    this.ws = ws;
    this.threads.clear();
    this.others.clear();
    this.say(true, "");
    await this.refresh();
    this.onChanged();
  }

  /** The socket went away (Codex's daemon quit, restarted or updated): its threads aren't listed from it until it's back. */
  private closed(ws: WebSocket) {
    if (this.ws !== ws) return;
    this.drop("closed", true);
  }

  private drop(why: string, tell: boolean) {
    const ws = this.ws;
    this.ws = null;
    for (const [, p] of this.calls) {
      clearTimeout(p.timer);
      p.reject(new Error("not connected"));
    }
    this.calls.clear();
    const had = this.threads.size > 0;
    this.threads.clear();
    this.others.clear();
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.close();
      this.say(false, why);
    }
    // Looked for again at the next listing, at once (a restart is quick).
    this.triedAt = 0;
    if (tell && had) this.onChanged();
  }

  /** The threads it has open, asked again: one at a time (two listings at once share it). */
  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.reread().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async reread() {
    let ids: string[] = [];
    try {
      for (let cursor: string | null = null, pages = 0; pages < 20; pages++) {
        const page: any = await this.request("thread/loaded/list", cursor ? { cursor } : {});
        ids.push(...(Array.isArray(page?.data) ? page.data.filter((x: unknown) => typeof x === "string") : []));
        cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
        if (!cursor) break;
      }
    } catch {
      return;
    }
    const open = new Set(ids);
    for (const id of [...this.threads.keys()]) if (!open.has(id)) this.threads.delete(id);
    for (const id of [...this.others]) if (!open.has(id)) this.others.delete(id);
    for (const id of ids) {
      if (this.threads.has(id) || this.others.has(id)) continue;
      try {
        const read: any = await this.request("thread/read", { threadId: id });
        this.take(read?.thread);
      } catch {
        // gone meanwhile, or not readable: asked again next time
      }
    }
  }

  /** A thread it told of (thread/read, thread/started): kept when it's a session, else noted as not one. */
  private take(raw: any): boolean {
    const t = threadOf(raw);
    // Its mode is told only as it changes (thread/settings/updated): kept across a thread told of again.
    const mode = t ? this.threads.get(t.id)?.mode : undefined;
    if (t) this.threads.set(t.id, mode ? { ...t, mode } : t);
    else if (typeof raw?.id === "string") this.others.add(raw.id);
    return Boolean(t);
  }

  private receive(ws: WebSocket, text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m && typeof m.id !== "undefined" && m.id !== null && typeof m.method !== "string") {
      const p = this.calls.get(m.id);
      if (!p) return;
      this.calls.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(typeof m.error.message === "string" ? m.error.message : "error"));
      else p.resolve(m.result);
      return;
    }
    if (typeof m?.method !== "string") return;
    // A request of Codex's to this client (none is expected: it subscribes to no thread): refused, so it never waits on it.
    if (typeof m.id !== "undefined" && m.id !== null) {
      ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: `unsupported request \`${m.method}\`` } }));
      return;
    }
    if (this.ws !== ws) return;
    this.notified(m.method, m.params ?? {});
  }

  /** What every client is told: the threads opened, closed, renamed, and working or not. */
  private notified(method: string, params: any) {
    const id = typeof params.threadId === "string" ? params.threadId : null;
    switch (method) {
      case "thread/started":
        if (this.take(params.thread)) this.onChanged();
        return;
      case "thread/closed":
      case "thread/archived":
      case "thread/deleted":
        if (id && this.threads.delete(id)) this.onChanged();
        if (id) this.others.delete(id);
        return;
      case "thread/name/updated": {
        const t = id ? this.threads.get(id) : undefined;
        if (!t) return;
        const name = typeof params.threadName === "string" ? params.threadName.trim() : "";
        if (name === t.name) return;
        t.name = name;
        this.onChanged();
        return;
      }
      case "thread/settings/updated": {
        const t = id ? this.threads.get(id) : undefined;
        if (!t) return;
        const mode = codexModeOf(params.threadSettings) ?? undefined;
        if (mode === t.mode) return;
        t.mode = mode;
        this.onChanged();
        return;
      }
      case "thread/status/changed": {
        const t = id ? this.threads.get(id) : undefined;
        if (!t) return;
        const status = statusOf(params.status);
        t.statusAt = Date.now();
        if (status === t.status) return;
        t.status = status;
        this.onChanged();
        return;
      }
      default:
        return;
    }
  }

  private request(method: string, params: unknown, ms = REQUEST_MS): Promise<any> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not connected"));
    return this.call(ws, method, params, ms);
  }

  private call(ws: WebSocket, method: string, params: unknown, ms = REQUEST_MS): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error("no answer"));
      }, ms);
      timer.unref?.();
      this.calls.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/** An error's words, short, for a log line or a spoken "why" (Codex's messages hold no secrets). */
function messageOf(err: unknown) {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 120 ? `${m.slice(0, 120)}…` : m;
}
