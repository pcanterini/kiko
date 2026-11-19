// OpenCode's background service (2.0 on): every OpenCode TUI on this Mac is a client of one local
// HTTP server, and its sessions live there, so Kiko connects to it as one more client: it hears
// every session's events (a turn ending, a permission asked, a question, a rename) and answers them
// through it. Read from OpenCode 2.0.32's source (github.com/anomalyco/opencode, tag v2.0.32:
// packages/client/src/service-probe.ts, cli/src/services/service-registration.ts, server/src/
// middleware/authorization.ts, server/src/event-feed.ts, protocol/openapi.json; checked against the
// real 2.0.32 with read-only requests: its info, a session's fields, the first event), never guessed:
//
//   where     $XDG_STATE_HOME/opencode/service.json (~/.local/state/opencode/service.json): {id,
//             version, url, pid, password}, written 0600 by the service as it starts, removed as it
//             stops. "That file is the complete discovery contract" (OpenCode's own words). Only a
//             loopback url is used: the password is never sent anywhere else
//   signed in HTTP Basic, user "opencode" and that password, on every request. The password stays
//             in memory, in a Secret that never prints or logs, and never on a command line
//   told      GET /api/event, server-sent events: `data: {id, created, type, data, location?}` per
//             event, every session in every folder (session.created, .renamed, .deleted, .status
//             {busy|retry|idle}, .execution.succeeded, .inbox.enqueued, permission.asked/.replied,
//             form.created/.replied/.cancelled). Volatile: a slow reader is cut off, and events
//             while disconnected are missed, so it reconnects and catches up by asking
//   asked     GET /api/session?directory=…&parentID=null (top-level sessions in a folder),
//             /api/session/{id}, /api/session/active (those running now), /api/session/{id}/message
//             (newest first), /api/session/{id}/permission and /form (what it waits on)
//   done      POST /api/session/{id}/permission/{request}/reply {decision: once|always|reject,
//             message?}; POST /api/session/{id}/form/{form}/reply {answer}; POST /api/session/{id}/
//             interrupt; PATCH /api/session/{id} {title}; POST /api/session/{id}/prompt {text}
//
// OpenCode 1.x has no such service (nothing here then: said by its setup's health). Logged:
// `opencode_service {ok, why}` when that changes, `opencode_command {method, sessionId, ok, why}`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envVar } from "../../core/name.ts";
import { redact, Secret } from "../secret.ts";
import type { Done } from "../types.ts";

/** Where the service registers itself: KIKO_OPENCODE_SERVICE (the tests'), else OpenCode's own place (service-probe.ts fallback). */
export const serviceFile = () => envVar("OPENCODE_SERVICE") || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");

/** The service as its file describes it. */
type ServiceInfo = { url: string; pid: number; version: string; password: Secret };

/** A url on this Mac only (a wildcard bind reached on loopback); null for any other host. */
export function loopback(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0" || host === "::") u.hostname = "127.0.0.1";
  else if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
  return u.origin;
}

/** The service's file read: null when there's none (not running), it's unreadable, or its url isn't this Mac's. */
export function readService(file = serviceFile()): ServiceInfo | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const url = typeof j?.url === "string" ? loopback(j.url) : null;
    if (!url || typeof j.password !== "string" || !j.password) return null;
    return { url, pid: Number.isInteger(j.pid) ? j.pid : 0, version: typeof j.version === "string" ? j.version : "", password: new Secret(j.password) };
  } catch {
    return null;
  }
}

/** One event off the stream. */
export type OpenCodeEvent = { type: string; data: Record<string, any>; location?: { directory?: string } };

/** A session as the service gives it (Session.Info), in the few fields Kiko reads (times in ms epoch). */
export type OpenCodeSession = {
  id: string;
  /** Its title: given by you (Ctrl+R, or Kiko's rename) or OpenCode's own after its first message; "" for none yet. */
  title: string;
  cwd: string;
  parentId: string | null;
  created: number;
  updated: number;
  /** When a TUI last showed it after it went idle; 0 for never. */
  viewed: number;
  archived: boolean;
};

/** OpenCode's placeholder title for a session with none ("New session - 2026-10-30T…Z"), which isn't a name. */
const FALLBACK_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A session as Kiko reads it; null for something that isn't one. */
export function sessionOf(s: any): OpenCodeSession | null {
  if (!s || typeof s.id !== "string" || typeof s.location?.directory !== "string") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const title = typeof s.title === "string" && !FALLBACK_TITLE.test(s.title) ? s.title.trim() : "";
  return {
    id: s.id,
    title,
    cwd: s.location.directory,
    parentId: typeof s.parentID === "string" && s.parentID ? s.parentID : null,
    created: n(s.time?.created),
    updated: n(s.time?.updated),
    viewed: n(s.time?.viewed),
    archived: n(s.time?.archived) > 0,
  };
}

/**
 * A message as Kiko reads it: whose, its text (an assistant's text parts together), and when.
 * `writing`: an assistant's still being written (no `time.completed`, finish or error yet): its
 * text isn't all there.
 */
export type Message = { id: string; role: "user" | "assistant" | "idle" | "other"; text: string; at: number; writing?: boolean };

/** A message from the service (Session.Message.Info): users' and assistants' words, and the idle marker a turn ends with. */
export function messageOf(m: any): Message | null {
  if (!m || typeof m.id !== "string") return null;
  const at = typeof m.time?.created === "number" ? m.time.created : 0;
  if (m.type === "user") return { id: m.id, role: "user", text: typeof m.text === "string" ? m.text.trim() : "", at };
  if (m.type === "assistant") {
    const parts: any[] = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const done = typeof m.time?.completed === "number" || m.finish != null || m.error != null;
    return { id: m.id, role: "assistant", text, at, ...(done ? {} : { writing: true }) };
  }
  if (m.type === "idle") return { id: m.id, role: "idle", text: "", at };
  return { id: m.id, role: "other", text: "", at };
}

const REQUEST_MS = 5000;
/** Not connected: looked for again at most this often, as the sessions are listed. */
const RETRY_MS = 2000;
/** The stream dropped: tried again after this long, doubling to BACKOFF_MAX_MS while it can't be had. */
const BACKOFF_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

type ServiceOptions = {
  /** Its file (serviceFile). */
  file: string;
  log?: (event: string, data: Record<string, unknown>) => void;
};

const messageOfError = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class OpenCodeService {
  /** An event, as it came (every session's, every folder's). */
  onEvent: (event: OpenCodeEvent) => void = () => {};
  /** Connected anew (the first time, or after the stream dropped): what happened meanwhile is asked for again. */
  onConnected: () => void = () => {};
  /** The connection went (the service quit, or the stream was cut off). */
  onDropped: () => void = () => {};

  private readonly configure: () => ServiceOptions;
  private options: ServiceOptions | null = null;
  private info: ServiceInfo | null = null;
  private stream: AbortController | null = null;
  private live = false;
  private running = false;
  private triedAt = 0;
  private connecting: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = BACKOFF_MS;
  private logged = "";
  /** Sessions running now (session.status busy or retry), from the stream and /api/session/active. */
  private readonly busy = new Set<string>();
  /** Why the last try didn't connect, for the setup's health ("" while connected, or before any try). */
  why = "";

  /** `configure`: read when it starts (the app's environment is settled by then). */
  constructor(configure: () => ServiceOptions) {
    this.configure = configure;
  }

  /** The stream is up now. */
  get connected() {
    return this.live;
  }

  /** The service's process (its file's pid), while connected: never a TUI. */
  get pid(): number | null {
    return this.live ? this.info?.pid || null : null;
  }

  /** Its version (its file's), while connected. */
  get version(): string {
    return this.live ? (this.info?.version ?? "") : "";
  }

  /** Whether a session is running now, as the service last said. */
  isBusy(sessionId: string) {
    return this.busy.has(sessionId);
  }

  /**
   * Starts: one try now (connected or not), more as the sessions are listed (at most every
   * RETRY_MS: started already, this is `ensure`) and after a drop. Never throws.
   */
  start(): Promise<void> {
    if (this.running) return this.tryConnect(false);
    this.running = true;
    this.options = this.configure();
    return this.tryConnect(true);
  }

  stop() {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop("stopped", false);
  }

  /** Looked for again when it isn't connected, at most every RETRY_MS (as the sessions are listed). */
  ensure(): Promise<void> {
    if (!this.running || this.live) return Promise.resolve();
    return this.tryConnect(false);
  }

  // ── Asked ──

  /** The top-level sessions in a folder, newest first; null when it couldn't be asked. */
  async sessionsIn(folder: string, limit = 20): Promise<OpenCodeSession[] | null> {
    const q = new URLSearchParams({ directory: folder, parentID: "null", order: "desc", limit: String(limit) });
    const got = await this.json(`/api/session?${q}`).catch(() => null);
    if (!got || !Array.isArray(got.data)) return null;
    return got.data.map(sessionOf).filter((s: OpenCodeSession | null): s is OpenCodeSession => s !== null && s.cwd === folder && !s.parentId && !s.archived);
  }

  /** One session; null when it's gone or can't be asked. */
  async session(id: string): Promise<OpenCodeSession | null> {
    const got = await this.json(`/api/session/${encodeURIComponent(id)}`).catch(() => null);
    return sessionOf(got?.data);
  }

  /** A session's newest messages, newest first; null when they can't be asked. */
  async messages(id: string, limit = 40): Promise<Message[] | null> {
    const q = new URLSearchParams({ order: "desc", limit: String(limit) });
    const got = await this.json(`/api/session/${encodeURIComponent(id)}/message?${q}`).catch(() => null);
    if (!got || !Array.isArray(got.data)) return null;
    return got.data.map(messageOf).filter((m: Message | null): m is Message => m !== null);
  }

  /** What a session waits on now: its pending permission requests and forms (questions); empty when it can't be asked. */
  async pending(id: string): Promise<{ permissions: any[]; forms: any[] }> {
    const s = encodeURIComponent(id);
    const [p, f] = await Promise.all([this.json(`/api/session/${s}/permission`).catch(() => null), this.json(`/api/session/${s}/form`).catch(() => null)]);
    return { permissions: Array.isArray(p?.data) ? p.data : [], forms: Array.isArray(f?.data) ? f.data : [] };
  }

  // ── Done ──

  /** A permission request answered: once, always (its rules saved), or rejected with why for the model. */
  replyPermission(sessionId: string, requestId: string, decision: "once" | "always" | "reject", message?: string): Promise<Done> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
    return this.command("permission.reply", sessionId, "POST", path, { decision, ...(message ? { message } : {}) });
  }

  /** A form (OpenCode's questions) answered, field key → value. */
  replyForm(sessionId: string, formId: string, answer: Record<string, string | string[]>): Promise<Done> {
    return this.command("form.reply", sessionId, "POST", `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`, { answer });
  }

  /** Its turn stopped, as Escape in its TUI would; none running: said so. */
  async interrupt(sessionId: string): Promise<Done> {
    const done = await this.command("session.interrupt", sessionId, "POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, undefined, (body) =>
      body && body.interrupted === false ? "it isn't running anything" : null,
    );
    return done;
  }

  /** Its title, as Ctrl+R in its TUI sets it: shown there, and listed by it. */
  rename(sessionId: string, title: string): Promise<Done> {
    return this.command("session.update", sessionId, "PATCH", `/api/session/${encodeURIComponent(sessionId)}`, { title });
  }

  /** A new message to it, as typed in its TUI: queued behind a turn running now, else its next turn. */
  prompt(sessionId: string, text: string): Promise<Done> {
    return this.command("session.prompt", sessionId, "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text });
  }

  // ── The connection ──

  private async tryConnect(now: boolean) {
    if (!this.running || this.live) return;
    if (this.connecting) return this.connecting;
    if (!now && Date.now() - this.triedAt < RETRY_MS) return;
    this.triedAt = Date.now();
    this.connecting = this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect() {
    const info = readService(this.options?.file);
    if (!info) return this.failed("OpenCode's background service isn't running");
    this.info = info;
    let res: Response;
    const abort = new AbortController();
    try {
      // Signed in and answering, before the stream is opened.
      const check = await this.fetch("/api/info", { signal: AbortSignal.timeout(REQUEST_MS) });
      if (check.status === 401) return this.failed("OpenCode's service didn't take its own password");
      if (!check.ok) return this.failed(`OpenCode's service answered ${check.status}`);
      res = await this.fetch("/api/event", { headers: { accept: "text/event-stream" }, signal: abort.signal });
    } catch (err) {
      return this.failed(`OpenCode's service didn't answer (${this.clean(err)})`);
    }
    if (!res.ok || !res.body) return this.failed(`OpenCode's event stream answered ${res.status}`);
    if (!this.running) return abort.abort();
    this.stream = abort;
    this.live = true;
    this.why = "";
    this.backoff = BACKOFF_MS;
    this.note(true);
    void this.read(res.body, abort);
    await this.catchUp();
    if (this.live && this.stream === abort) this.onConnected();
  }

  /** Who's running now (session.status is told only as it changes). */
  private async catchUp() {
    const got = await this.json("/api/session/active").catch(() => null);
    if (got?.data && typeof got.data === "object") {
      this.busy.clear();
      for (const id of Object.keys(got.data)) this.busy.add(id);
    }
  }

  private async read(body: ReadableStream<Uint8Array>, abort: AbortController) {
    const decoder = new TextDecoder();
    let buffer = "";
    let why = "its event stream ended";
    try {
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
          this.frame(frame);
        }
      }
    } catch (err) {
      why = abort.signal.aborted ? "stopped" : `its event stream broke (${this.clean(err)})`;
    }
    if (this.stream !== abort) return;
    this.drop(why, this.running);
  }

  /** One server-sent event: its data lines, as JSON. */
  private frame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let e: any;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (!e || typeof e.type !== "string") return;
    const event: OpenCodeEvent = { type: e.type, data: e.data && typeof e.data === "object" ? e.data : {}, ...(e.location ? { location: e.location } : {}) };
    if (event.type === "session.status" && typeof event.data.sessionID === "string") {
      const kind = typeof event.data.status === "string" ? event.data.status : event.data.status?.type;
      if (kind === "idle") this.busy.delete(event.data.sessionID);
      else if (kind) this.busy.add(event.data.sessionID);
    }
    if (event.type === "session.idle" && typeof event.data.sessionID === "string") this.busy.delete(event.data.sessionID);
    try {
      this.onEvent(event);
    } catch {}
  }

  private drop(why: string, again: boolean) {
    const was = this.live;
    this.live = false;
    this.stream?.abort();
    this.stream = null;
    this.busy.clear();
    if (was) {
      this.note(false, why);
      this.onDropped();
    }
    if (again) this.later();
  }

  private failed(why: string) {
    this.why = why;
    this.note(false, why);
    this.later();
  }

  /** Tried again in a while (doubling while it can't be had), and as the sessions are listed. */
  private later() {
    if (!this.running || this.retry) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.tryConnect(true);
    }, wait);
    this.retry.unref?.();
  }

  private note(ok: boolean, why = "") {
    const line = `${ok}:${why}`;
    if (line === this.logged) return;
    this.logged = line;
    this.options?.log?.("opencode_service", { ok, ...(ok ? { version: this.info?.version ?? "" } : { why }) });
  }

  private fetch(path: string, init: RequestInit = {}) {
    const info = this.info;
    if (!info) return Promise.reject(new Error("not connected"));
    const auth = `Basic ${Buffer.from(`opencode:${info.password.reveal()}`).toString("base64")}`;
    return fetch(`${info.url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: auth } });
  }

  private async json(path: string): Promise<any> {
    if (!this.live) throw new Error("OpenCode's service isn't connected");
    const res = await this.fetch(path, { signal: AbortSignal.timeout(REQUEST_MS) });
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    return res.json();
  }

  /** A request that does something, logged; why it didn't, from its answer (`refused`) or its status. */
  private async command(method: string, sessionId: string, verb: string, path: string, body: unknown, refused?: (body: any) => string | null): Promise<Done> {
    if (!this.live) return { done: false, why: "OpenCode's service isn't connected" };
    let done: Done;
    try {
      const res = await this.fetch(path, {
        method: verb,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        signal: AbortSignal.timeout(REQUEST_MS),
      });
      const text = await res.text().catch(() => "");
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      if (res.status === 404) done = { done: false, why: "OpenCode doesn't have it any more" };
      else if (!res.ok) done = { done: false, why: `OpenCode didn't take it (${res.status}${typeof parsed?.message === "string" ? `: ${parsed.message}` : ""})` };
      else {
        const why = refused?.(parsed) ?? null;
        done = why ? { done: false, why } : { done: true };
      }
    } catch (err) {
      done = { done: false, why: `OpenCode didn't answer (${this.clean(err)})` };
    }
    this.options?.log?.("opencode_command", { method, sessionId, ok: done.done, ...(done.done ? {} : { why: done.why }) });
    return done;
  }

  /** An error's words, never the password. */
  private clean(err: unknown) {
    return redact(messageOfError(err), this.info?.password);
  }
}
