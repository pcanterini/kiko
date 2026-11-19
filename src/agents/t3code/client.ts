// The connection to T3 Code's local server, kept up while Kiko runs: found, checked, signed in,
// subscribed, and found again when T3 quits or restarts. When T3 isn't running, nothing here does
// anything you'd notice: it looks again now and then, quietly.
//
//   1. where: the port in ~/.t3/userdata/server-runtime.json (only `port` is read), else 3773;
//      always 127.0.0.1
//   2. which protocol: GET /.well-known/t3/environment (no auth) says `orchestrationProtocolVersion`.
//      Kiko speaks 2; another is said once ("T3 Code updated in a way this Kiko doesn't know
//      yet…") and voice control of T3 stays off until Kiko updates
//   3. a token: auth.ts, minted by T3's CLI; renewed before it runs out, revoked on quit
//   4. a ticket: POST /api/auth/websocket-ticket/rpc with the token as a bearer
//   5. the socket: ws://127.0.0.1:<port>/ws?wsTicket=…&orchestrationProtocol=2 (a 426 answer is
//      another protocol, as in 2), then rpc.ts's frames
//   6. orchestration.subscribeShell: its threads as sessions (mapping.ts)
//   7. orchestration.subscribeThread, read once for a run that started or completed, once for each
//      thread as it's first listed (what it was last asked and said, from before Kiko started),
//      once for a request a thread waits on (what it asks: ./requests.ts), and for a thread whose
//      conversation is open on the phone (again as the thread changes)
//   8. orchestration.dispatchCommand, every change Kiko makes, as T3's own client sends each
//      (client-runtime operations/commands.ts): your words (message.dispatch), a request answered
//      (runtime-request.respond), a run stopped (thread.stop where the server says it has it, else
//      run.interrupt of its live run), a thread renamed (thread.metadata.update) or archived
//      (thread.archive, after its run is stopped: T3 won't archive a running thread)
//   9. a new thread (launch): server.getConfig for the model and runtime mode a new thread takes,
//      then orchestration.launchThread, as T3's own client makes one from its first message
//      (./launch.ts); it's listed as the shell tells of it
//
// Logged: `t3_connect {protocol, ok, why}` when that changes. Never the token, the ticket or a URL with it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { log as appLog } from "../../core/log.ts";
import { redact } from "../secret.ts";
import { cliMinter, type Issued, type Minter } from "./auth.ts";
import type { History } from "../../core/history.ts";
import { askedInRun, historyOf, lastReply, Shell, threadIdOf, type ShellThread } from "./mapping.ts";
import { launchInput, modelFor, runtimeModeFor } from "./launch.ts";
import { pendingRequest, type Pending, type Response } from "./requests.ts";
import { RpcSocket, UpgradeRefused } from "./rpc.ts";
import { NAME } from "../../core/name.ts";

/** The orchestration protocol this Kiko speaks (T3's ORCHESTRATION_PROTOCOL_VERSION). */
export const PROTOCOL = 2;
const DEFAULT_PORT = 3773;
export const MISMATCH = `T3 Code updated in a way this ${NAME} doesn't know yet; voice control of T3 is off until ${NAME} updates.`;

/** Backoff between tries: doubling from the first to the last, which is also how often a T3 that isn't running is looked for. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** A token is renewed this long before it runs out. */
const RENEW_BEFORE_MS = 3 * 60_000;
/** A thread's reply is waited for this long. */
const READ_MS = 8000;
/** A conversation open on the phone is read again this long after its thread last changed (a run's changes come close together). */
const HISTORY_SETTLE_MS = 250;
/** How long a run being stopped before its thread is archived has to stop. */
const STOP_MS = 5000;
/** How long T3 has to answer a request that isn't a stream (its config, a new thread). */
const ANSWER_MS = 15_000;
/** How long a new thread has to show in the shell once T3 has made it. */
const LISTED_MS = 3000;

/** The run statuses T3 won't archive a thread in (its client's threadRuntimeCanArchive), and the ones a run can be interrupted in. */
const UNARCHIVABLE = new Set(["preparing", "starting", "running"]);
const INTERRUPTIBLE = new Set(["preparing", "starting", "running", "waiting"]);

export type ClientOptions = {
  /** T3's home (~/.t3): its CLI is bin/t3, its runtime state userdata/server-runtime.json. */
  home?: string;
  /** The port, when it isn't to be read from T3's state. */
  port?: number;
  minter?: Minter;
  log?: (event: string, data: Record<string, unknown>) => void;
  backoffMs?: number[];
  renewBeforeMs?: number;
};

/**
 * A run that completed: its thread, and what was said (and asked) in it. `turn`: your words that
 * reached the run, oldest first, from T3's own record ([] or left out when it can't tell).
 */
export type Completed = { thread: ShellThread; said: string; asked: string; turn?: string[] };

/** A run that started (took your message in, typed here or in T3): its thread, and that message ("" when it couldn't be read). */
export type Started = { thread: ShellThread; asked: string };

/** A change made in T3 (dispatchCommand), or why not: said out loud. */
export type Dispatched = { done: true } | { done: false; why: string };

/** A new thread made in T3 (launchThread): its ID, or why not (said out loud). */
export type Launched = { done: true; threadId: string } | { done: false; why: string };

type Connect = { ok: true } | { ok: false; why: string; protocol?: number };

export class T3Client {
  readonly shell = new Shell();
  /** The threads changed (listed again). */
  onChanged: () => void = () => {};
  /** A run started, with your message: Claude Code's UserPromptSubmit, for T3. */
  onStarted: (started: Started) => void = () => {};
  /** A run completed, with its reply. */
  onCompleted: (done: Completed) => void = () => {};
  /**
   * A thread waits on you (a permission, a question): once per request, with what it asks as read
   * from T3 (./requests.ts), or null when that couldn't be read or is left to T3.
   */
  onWaiting: (thread: ShellThread, pending: Pending | null) => void = () => {};
  /** A request a thread waited on is no longer pending (answered, here or in T3; its run stopped; the thread gone). */
  onResolved: (threadId: string, requestId: string) => void = () => {};
  /** Something to say once. */
  onNotice: (line: string) => void = () => {};

  private options: ClientOptions = {};
  private home = "";
  private minter!: Minter;
  private log: (event: string, data: Record<string, unknown>) => void = appLog;
  private backoff = BACKOFF_MS;
  private renewBefore = RENEW_BEFORE_MS;
  private socket: RpcSocket | null = null;
  private issued: Issued | null = null;
  private running = false;
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private logged = "";
  private mismatchSaid = false;
  /** What the server said it has (its descriptor's `capabilities`): `threadStop`. */
  private capabilities: Record<string, unknown> = {};
  private connecting: Promise<void> | null = null;
  /** What each thread last said and was asked, as read when its run started (asked) and completed (both). */
  readonly replies = new Map<string, { said: string; asked: string }>();
  /** Threads whose last words are being read as they're first listed, one at a time (`priming`). */
  private readonly toPrime = new Set<string>();
  private priming = false;
  /** Told when a thread changes (or the shell is listed afresh): the conversations open on the phone. */
  private readonly threadWatchers = new Map<string, Set<() => void>>();

  /** `options`: read when it starts (the app's environment is settled by then). */
  private readonly configure: ClientOptions | (() => ClientOptions);
  constructor(configure: ClientOptions | (() => ClientOptions) = {}) {
    this.configure = configure;
  }

  /** Connected and subscribed now. */
  get connected() {
    return this.socket !== null;
  }

  /** Keeping the connection up (started, not stopped): only then does `connected` tell whether T3 runs. */
  get keeping() {
    return this.running;
  }

  /** Starts keeping the connection up; resolves after the first try (connected or not). Never throws. */
  start(): Promise<void> {
    if (this.running) return this.connecting ?? Promise.resolve();
    this.running = true;
    const options = (this.options = typeof this.configure === "function" ? this.configure() : this.configure);
    this.home = options.home ?? `${homedir()}/.t3`;
    this.minter = options.minter ?? cliMinter(`${this.home}/bin/t3`);
    this.log = options.log ?? appLog;
    this.backoff = options.backoffMs ?? BACKOFF_MS;
    this.renewBefore = options.renewBeforeMs ?? RENEW_BEFORE_MS;
    return this.attempt();
  }

  /** Stops: the socket closed, the token revoked. */
  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.timer = this.renewTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    if (this.issued) this.minter.revoke(this.issued.sessionId);
    this.issued = null;
  }

  /** Your words to a thread, as a new message (message.dispatch): sent, or why not. */
  async send(threadId: string, text: string): Promise<{ sent: true } | { sent: false; why: string }> {
    const commandId = randomUUID();
    // As T3's own client sends a message (client-runtime operations/commands.ts startThreadTurn):
    // delivered "auto" (T3 decides whether it steers a run that's going, or queues it), started at once.
    const done = await this.dispatch("message.dispatch", {
      commandId,
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: commandId,
      text,
      attachments: [],
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
    return done.done ? { sent: true } : { sent: false, why: done.why };
  }

  /** A request a thread waits on, answered (runtime-request.respond): a decision, or the answers to its questions. */
  respond(threadId: string, requestId: string, response: Response): Promise<Dispatched> {
    return this.dispatch("runtime-request.respond", { commandId: randomUUID(), threadId, requestId, ...response });
  }

  /**
   * A thread's run stopped, as T3's own Stop does: thread.stop where the server says it has it, else
   * run.interrupt of its live run (the messages queued behind it held, not started). Nothing live: said so.
   */
  async interrupt(threadId: string): Promise<Dispatched> {
    if (!this.socket) return { done: false, why: "T3 Code isn't connected" };
    if (this.capabilities.threadStop === true) return this.dispatch("thread.stop", { commandId: randomUUID(), threadId });
    const runId = await this.liveRun(threadId);
    if (!runId) return { done: false, why: "it isn't running anything" };
    return this.dispatch("run.interrupt", { commandId: randomUUID(), threadId, runId, holdQueue: true });
  }

  /** A thread's title (thread.metadata.update): shown in T3, and Kiko lists it by it. */
  rename(threadId: string, title: string): Promise<Dispatched> {
    return this.dispatch("thread.metadata.update", { commandId: randomUUID(), threadId, title });
  }

  /**
   * A thread archived (thread.archive): it leaves T3's list, and can be brought back there. A run
   * that's going is stopped first, and given a moment to: T3 won't archive a running thread.
   */
  async archive(threadId: string): Promise<Dispatched> {
    if (!this.socket) return { done: false, why: "T3 Code isn't connected" };
    const running = () => UNARCHIVABLE.has(this.shell.threads.get(threadId)?.status ?? "");
    if (running()) {
      const stopped = await this.interrupt(threadId);
      if (!stopped.done) return { done: false, why: `its run didn't stop (${stopped.why})` };
      const until = Date.now() + STOP_MS;
      while (running() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      if (running()) return { done: false, why: "its run was still going after it was stopped" };
    }
    return this.dispatch("thread.archive", { commandId: randomUUID(), threadId });
  }

  /**
   * A new thread in the project `projectId`, as T3's own client makes one (./launch.ts): named
   * `name` (else titled from `prompt`), with `prompt` as its first message ("" for none: made empty),
   * on `driver`'s provider ("codex", "claudeAgent") or T3's default. Done once T3 has made it, and
   * (up to LISTED_MS) once its shell lists it. Logged as t3_command {type: "launchThread", …}.
   */
  async launch(o: { projectId: string; name: string; prompt: string; driver: string | null }): Promise<Launched> {
    const socket = this.socket;
    if (!socket) return { done: false, why: "T3 Code isn't connected" };
    const project = this.shell.projects.get(o.projectId);
    if (!project) return { done: false, why: "that project isn't in T3 Code" };
    const fail = (why: string, threadId: string | null = null): Launched => {
      this.log("t3_command", { type: "launchThread", threadId, ok: false, why });
      return { done: false, why };
    };
    let config: any;
    try {
      config = await this.answer(socket, "server.getConfig", {});
    } catch (err) {
      return fail(`T3 Code didn't say how it starts threads (${this.safe(err)})`);
    }
    const model = modelFor(config, project, o.driver);
    if (!model) return fail(o.driver ? "T3 Code has no provider of that kind ready" : "T3 Code has no provider ready to start a thread on");
    const threadId = randomUUID();
    const input = launchInput({ threadId, projectId: o.projectId, name: o.name, prompt: o.prompt, model, runtimeMode: runtimeModeFor(config, project) });
    let made: any;
    try {
      made = await this.answer(socket, "orchestration.launchThread", input);
    } catch (err) {
      return fail(`T3 Code didn't take it (${this.safe(err)})`, threadId);
    }
    // T3 may give it another ID (a launch it had made already): its own answer says which.
    const id = typeof made?.threadId === "string" && made.threadId ? made.threadId : threadId;
    this.log("t3_command", { type: "launchThread", threadId: id, ok: true, model: model.instanceId, prompt: "initialMessage" in input });
    const until = Date.now() + LISTED_MS;
    while (!this.shell.threads.has(id) && this.socket === socket && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return { done: true, threadId: id };
  }

  /** One request and its answer, given ANSWER_MS: T3 not answering is a failure, not a wait forever. */
  private answer<T>(socket: RpcSocket, tag: string, payload: unknown): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer")), ANSWER_MS);
      timer.unref?.();
    });
    return Promise.race([socket.request<T>(tag, payload), late]).finally(() => clearTimeout(timer));
  }

  /** What a thread waits on (its pending request `requestId`), read from T3; null when it can't be read or is left to T3. */
  async readRequest(threadId: string, requestId: string): Promise<Pending | null> {
    return pendingRequest(await this.readThread(threadId), requestId);
  }

  /** The run a thread has going: its shell's, else the projection's last live one (as T3's client finds it). */
  private async liveRun(threadId: string): Promise<string | null> {
    const thread: any = this.shell.threads.get(threadId);
    if (typeof thread?.activeRunId === "string" && thread.activeRunId) return thread.activeRunId;
    const runs: unknown = (await this.readThread(threadId))?.runs;
    const live = (Array.isArray(runs) ? runs : []).findLast((r: any) => INTERRUPTIBLE.has(r?.status));
    if (typeof live?.id === "string") return live.id;
    return INTERRUPTIBLE.has(thread?.status) && thread?.latestRunId ? thread.latestRunId : null;
  }

  /** One command to T3 (orchestration.dispatchCommand), logged (never your words): done, or why not. */
  private async dispatch(type: string, command: Record<string, unknown>): Promise<Dispatched> {
    const socket = this.socket;
    if (!socket) return { done: false, why: "T3 Code isn't connected" };
    try {
      await socket.request("orchestration.dispatchCommand", { type, ...command });
      // Words sent are logged by the app already (sent, send_failed).
      if (type !== "message.dispatch") this.log("t3_command", { type, threadId: command.threadId, ok: true });
      return { done: true };
    } catch (err) {
      const why = `T3 Code didn't take it (${this.safe(err)})`;
      if (type !== "message.dispatch") this.log("t3_command", { type, threadId: command.threadId, ok: false, why });
      return { done: false, why };
    }
  }

  /** A thread's last reply (and what was asked), from subscribeThread's first snapshot; the stream is ended once read. */
  async readReply(threadId: string, runId: string | null): Promise<{ said: string; asked: string }> {
    return lastReply(await this.readThread(threadId), runId);
  }

  /** A thread's projection (its messages and the rest), from subscribeThread's first snapshot; the stream is ended once read. Null when it couldn't be read. */
  readThread(threadId: string): Promise<any | null> {
    const socket = this.socket;
    if (!socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (projection: any | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stream.stop();
        resolve(projection);
      };
      const timer = setTimeout(() => finish(null), READ_MS);
      const stream = socket.stream(
        "orchestration.subscribeThread",
        { threadId },
        (item: any) => {
          if (item?.kind === "snapshot") finish(item.projection ?? null);
        },
        () => finish(null),
      );
    });
  }

  /**
   * Follows a thread's conversation (the phone's view of it): `changed` gets it at once, then again
   * each time the thread changes, read afresh a moment later, until stopped. `fallback`: what's
   * shown when it can't be read at first (T3 not connected).
   */
  watchHistory(threadId: string, changed: (history: History) => void, fallback: () => History): { stop(): void } {
    let last = "";
    return this.watchThread(threadId, (projection) => {
      if (!projection && last) return;
      const history = projection ? historyOf(projection) : fallback();
      const key = JSON.stringify(history);
      if (key === last) return;
      last = key;
      changed(history);
    });
  }

  /**
   * Follows a thread: `changed` gets its projection (subscribeThread's first snapshot) at once, then
   * again each time the thread changes (its shell's thread.updated, or a fresh listing), read afresh
   * a moment later, one read at a time, until stopped; null when it couldn't be read.
   */
  watchThread(threadId: string, changed: (projection: any | null) => void): { stop(): void } {
    let stopped = false;
    let reading = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      do {
        again = false;
        const projection = await this.readThread(threadId);
        if (stopped) return;
        changed(projection);
      } while (again && !stopped);
      reading = false;
    };
    const soon = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = null;
        void read();
      }, HISTORY_SETTLE_MS);
      timer.unref?.();
    };
    const watchers = this.threadWatchers.get(threadId) ?? new Set();
    watchers.add(soon);
    this.threadWatchers.set(threadId, watchers);
    void read();
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        watchers.delete(soon);
        if (!watchers.size && this.threadWatchers.get(threadId) === watchers) this.threadWatchers.delete(threadId);
      },
    };
  }

  private attempt(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.connect()
      .catch((err): Connect => ({ ok: false, why: this.safe(err) }))
      .then((result) => {
        this.connecting = null;
        this.note(result);
        if (!this.running) {
          // Stopped while it connected: a token minted meanwhile is revoked too.
          if (this.issued) this.minter.revoke(this.issued.sessionId);
          this.issued = null;
          return;
        }
        if (result.ok) {
          this.tries = 0;
          return;
        }
        // Another protocol: no hurry; it's looked at again at the slowest pace, and not said again.
        const wait = result.protocol !== undefined ? this.backoff.at(-1)! : this.backoff[Math.min(this.tries++, this.backoff.length - 1)];
        this.timer = setTimeout(() => void this.attempt(), wait);
        this.timer.unref?.();
      });
    this.connecting = run;
    return run;
  }

  private async connect(): Promise<Connect> {
    const port = this.port();
    const base = `http://127.0.0.1:${port}`;
    // Is it there, and which protocol does it speak? No token needed, and none minted when it isn't.
    let descriptor: any;
    try {
      const res = await fetch(`${base}/.well-known/t3/environment`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, why: `not T3 Code (HTTP ${res.status})` };
      descriptor = await res.json();
    } catch {
      return { ok: false, why: "not running" };
    }
    const protocol = Number(descriptor?.orchestrationProtocolVersion ?? 1);
    if (protocol !== PROTOCOL) return this.mismatch(protocol);
    this.capabilities = descriptor?.capabilities && typeof descriptor.capabilities === "object" ? descriptor.capabilities : {};
    if (!this.running) return { ok: false, why: "stopped" };

    const issued = await this.token();
    const ticketRes = await fetch(`${base}/api/auth/websocket-ticket/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token.reveal()}` },
      signal: AbortSignal.timeout(5000),
    });
    if (ticketRes.status === 401 || ticketRes.status === 403) {
      // Revoked, or run out early: a new one next time.
      this.dropToken();
      return { ok: false, why: `token refused (HTTP ${ticketRes.status})` };
    }
    if (!ticketRes.ok) return { ok: false, why: `no ticket (HTTP ${ticketRes.status})` };
    const ticket = String(((await ticketRes.json()) as any)?.ticket ?? "");
    if (!ticket) return { ok: false, why: "no ticket" };

    let socket: RpcSocket;
    try {
      socket = await RpcSocket.open(`ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=${PROTOCOL}`);
    } catch (err) {
      if (err instanceof UpgradeRefused && err.status === 426) return this.mismatch(Number((err.body as any)?.orchestrationProtocolVersion ?? 0));
      return { ok: false, why: err instanceof UpgradeRefused ? `refused (HTTP ${err.status})` : redact(this.safe(err), ticket) };
    }
    if (!this.running) {
      socket.close();
      return { ok: false, why: "stopped" };
    }
    this.socket = socket;
    socket.onClose = (why) => this.closed(socket, why);
    socket.stream(
      "orchestration.subscribeShell",
      {},
      (item) => this.shellItem(item),
      (err) => {
        // The shell stream ending is the connection's end: start again.
        if (this.socket === socket) socket.close();
        void err;
      },
    );
    this.scheduleRenew(issued);
    return { ok: true };
  }

  private mismatch(protocol: number): Connect {
    if (!this.mismatchSaid) {
      this.mismatchSaid = true;
      this.onNotice(MISMATCH);
    }
    return { ok: false, why: "protocol", protocol };
  }

  private async token(): Promise<Issued> {
    if (this.issued && this.issued.expiresAt - Date.now() > this.renewBefore) return this.issued;
    const old = this.issued;
    this.issued = await this.minter.issue();
    if (old) this.minter.revoke(old.sessionId);
    return this.issued;
  }

  private dropToken() {
    if (this.issued) this.minter.revoke(this.issued.sessionId);
    this.issued = null;
  }

  /** Before the token runs out: a new one, and the connection made again with it (the old one is revoked). */
  private scheduleRenew(issued: Issued) {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    const wait = Math.max(1000, issued.expiresAt - Date.now() - this.renewBefore);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      if (!this.running || this.issued !== issued) return;
      // Expired as far as token() is concerned: the next connect mints, then revokes this one.
      this.issued = { ...issued, expiresAt: 0 };
      const socket = this.socket;
      this.socket = null;
      socket?.close();
      void this.attempt();
    }, wait);
    this.renewTimer.unref?.();
  }

  private closed(socket: RpcSocket, why: string) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.note({ ok: false, why: `disconnected: ${why}` });
    this.onChanged();
    if (this.running) {
      this.timer = setTimeout(() => void this.attempt(), this.backoff[0]);
      this.timer.unref?.();
    }
  }

  private shellItem(item: unknown) {
    let changed = false;
    for (const change of this.shell.apply(item)) {
      if (change.kind === "listed") changed = true;
      else if (change.kind === "waiting") void this.waiting(change.thread);
      else if (change.kind === "resolved") this.onResolved(change.threadId, change.requestId);
      else if (change.kind === "started") void this.started(change.thread);
      else if (change.kind === "completed") void this.completed(change.thread);
    }
    if (changed) this.onChanged();
    // What each listed thread was last asked and said, for one not read yet (Kiko just started).
    if (changed) this.prime();
    // The conversations open on the phone: the one thread that changed, or all of them on a fresh listing.
    const kind = (item as any)?.kind;
    const ids = kind === "snapshot" ? [...this.threadWatchers.keys()] : kind === "thread.updated" ? [(item as any).thread?.id] : [];
    for (const id of ids) for (const soon of this.threadWatchers.get(id) ?? []) soon();
  }

  /** Reads, one at a time, what each listed thread not known yet was last asked and said; a run's start or end read meanwhile wins. */
  private prime() {
    for (const s of this.shell.sessions()) {
      const id = threadIdOf(s.sessionId);
      if (id && !this.replies.has(id)) this.toPrime.add(id);
    }
    if (this.priming) return;
    this.priming = true;
    void (async () => {
      while (this.toPrime.size && this.socket) {
        const id = this.toPrime.values().next().value!;
        this.toPrime.delete(id);
        if (this.replies.has(id)) continue;
        const projection = await this.readThread(id);
        if (projection && !this.replies.has(id)) this.replies.set(id, lastReply(projection, this.shell.threads.get(id)?.latestRunId ?? null));
      }
      this.priming = false;
    })();
  }

  /** A thread waits on you: what it asks, read from T3 (null: couldn't be, or left to T3). */
  private async waiting(thread: ShellThread) {
    const requestId = thread.pendingRuntimeRequest?.id ?? "";
    const pending = requestId ? await this.readRequest(thread.id, requestId) : null;
    this.log("t3_waiting", { threadId: thread.id, requestId, kind: thread.pendingRuntimeRequest?.kind ?? null, asked: pending ? (pending.questions ? "questions" : "permission") : null });
    // Answered (or gone) while it was read: nothing to ask.
    if (this.shell.threads.get(thread.id)?.pendingRuntimeRequest?.id !== requestId) return;
    this.onWaiting(thread, pending);
  }

  private async started(thread: ShellThread) {
    // Its message, and the last thing it said before it (this run hasn't said anything yet).
    const { asked, said } = lastReply(await this.readThread(thread.id), thread.latestRunId);
    if (asked) this.replies.set(thread.id, { said: said || (this.replies.get(thread.id)?.said ?? ""), asked });
    this.onStarted({ thread, asked });
  }

  private async completed(thread: ShellThread) {
    const projection = await this.readThread(thread.id);
    const reply = lastReply(projection, thread.latestRunId);
    this.replies.set(thread.id, reply);
    this.onCompleted({ thread, ...reply, turn: askedInRun(projection, thread.latestRunId) });
  }

  /** The port: T3's runtime state (only its `port`), else the default. */
  private port(): number {
    if (this.options.port) return this.options.port;
    try {
      const state = JSON.parse(readFileSync(`${this.home}/userdata/server-runtime.json`, "utf8"));
      const port = Number(state?.port);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    return DEFAULT_PORT;
  }

  /** Logs t3_connect when what it says changes (not every quiet try while T3 isn't running). */
  private note(result: Connect) {
    const entry = result.ok ? { protocol: PROTOCOL, ok: true } : { protocol: result.protocol ?? null, ok: false, why: result.why };
    const key = JSON.stringify(entry);
    if (key === this.logged) return;
    this.logged = key;
    this.log("t3_connect", entry);
  }

  /** An error's message, with the token taken out (it never should be in one). */
  private safe(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return redact(message, this.issued?.token);
  }
}
