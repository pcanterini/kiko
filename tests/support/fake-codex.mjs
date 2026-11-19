#!/usr/bin/env node
// A stand-in for Codex CLI's TUI, for the tests: never the real Codex. Run through a link named
// `codex` to Node (so `ps -o comm=` says codex, as for the real one): `codex fake-codex.mjs [prompt]`.
// It does what Kiko relies on, as Codex 0.166.0 does (codex-rs/tui, codex-rs/hooks), or 0.153.0
// with FAKE_CODEX_VERSION=0.153.0:
//   - asks for bracketed paste, and draws its composer ("› Ask Codex to do anything"), or
//     "• Working (0s • esc to interrupt)" while a turn runs; FAKE_CODEX_TRUST=1: its folder-trust
//     question first (0.166: "Trust this folder? … Trust and continue"; 0.153: "Do you trust the
//     contents of this directory?"), Enter trusts;
//   - takes keys as its TUI does: a bracketed paste goes into the composer whole; 3 or more plain
//     keys at once are a paste "burst", and an Enter within 120ms of one is a new line, not a send;
//     Enter sends; Escape interrupts a turn;
//   - holds its writer lock ($CODEX_HOME/thread-writer-locks/<id>.lock) from the start, and writes
//     its rollout from the first prompt (session_meta, task_started, item_completed UserMessage /
//     AgentMessage / CommandExecution, task_complete, turn_aborted), as the paginated history does;
//   - runs its hooks as Codex does (`/bin/sh -lc "<command>"`: Codex uses $SHELL; the event as JSON on
//     stdin): FAKE_CODEX_HOOK is the command (hooks/codex-hook.mjs), unset for a Codex whose hooks never
//     fire (not set up, not trusted). 0.166: in its shared app-server daemon, a process of its own
//     named codex with no terminal (the hook finds no TUI above it, so no pid); 0.153: in the TUI's
//     own process. SessionStart and UserPromptSubmit with its first prompt (Codex runs no hook
//     before a session's first turn), PermissionRequest for FAKE_CODEX_ASK (a shell command it wants
//     to run), Stop at each turn's end (a {"decision":"block","reason"} back carries the turn on with
//     the reason as a HookPrompt), Interrupt on Escape, SessionEnd on /exit;
//   - /rename <name> appends to $CODEX_HOME/session_index.jsonl (0.166: through its daemon, which
//     does); /exit ends it cleanly;
//   - SIGTERM: noted, then gone at once (exit 143), with no SessionEnd, as Codex's TUI has no handler.
// 0.166's shared app-server daemon (codex-rs/app-server*, src/agents/codex/daemon.ts): the first TUI
// with none to attach to starts it (`codex fake-codex.mjs --app-server`, detached, so ps names it
// codex too, in that TUI's folder, as the real one is), and every TUI attaches to it over
// $CODEX_HOME/app-server-control/app-server-control.sock (a link to the socket in the temp folder:
// the link's path can be too long for a unix socket), a WebSocket of JSON-RPC lines. A TUI opens its
// thread there as it starts, before any turn (thread/start; its rollout's session_meta then), and
// tells it its turns (fake/turn: the daemon's own part in the real one) and its hooks to run
// (fake/hook). What Kiko uses is as Codex's: initialize, thread/loaded/list, thread/read,
// thread/name/set, thread/turns/list, turn/interrupt (handed to the TUI as fake/interrupt, which
// stops its turn as Escape does), and thread/started, thread/closed, thread/name/updated and
// thread/status/changed told to every client. A thread whose TUI has gone is let go after
// FAKE_CODEX_UNLOAD_MS (60s, as Codex's thread_unload_delay_secs), told as thread/closed. The TUI
// notes each name its daemon tells it ("named <name>"), as Codex's TUI shows it. The daemon writes
// $CODEX_HOME/app-server-daemon/daemon.pid as Codex's does, and goes once no client is left (or
// $CODEX_HOME is). `startAppServer` and `TuiLink` are also exported, for a test to run them itself.
// FAKE_CODEX_LOG: a file it notes what happened in, for the test to read. FAKE_CODEX_WORK_MS: how
// long a turn works before it answers (300ms; 5s for a prompt with "slowly" in it).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

/** Where Codex advertises its daemon's socket (a link), and the socket itself (short enough for a unix socket). */
export const socketLink = (home) => join(home, "app-server-control", "app-server-control.sock");
const socketFile = (home) => join(tmpdir(), `fcx-${createHash("sha256").update(home).digest("hex").slice(0, 16)}.sock`);

/** Whether something answers on a unix socket. */
const answers = (path) =>
  new Promise((resolve) => {
    const c = connect(path);
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });

/** Runs a hook's command as Codex does, the event on stdin: what it printed. */
function runHook(command, input) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * The shared app-server daemon, as 0.166's (see the top): listening on `home`'s socket. `unloadMs`:
 * how long a thread whose TUI went is kept; `exitWhenIdle`: gone once no client is left (and
 * whenever `home` is); `pidFile`: its record in $CODEX_HOME/app-server-daemon/daemon.pid. Resolves
 * to it once it listens (null when another already does); `requests` is every method asked of it.
 */
export async function startAppServer(home, { unloadMs = 60_000, exitWhenIdle = false, pidFile = false } = {}) {
  const link = socketLink(home);
  const file = socketFile(home);
  if (await answers(file)) return null;
  rmSync(file, { force: true });
  mkdirSync(dirname(link), { recursive: true });
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(file, resolve);
  });
  rmSync(link, { force: true });
  symlinkSync(file, link);
  const pidPath = join(home, "app-server-daemon", "daemon.pid");
  if (pidFile) {
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, processStartTime: new Date().toString() }));
  }
  const clients = new Set();
  const threads = new Map();
  const requests = [];
  const view = (t) => ({
    id: t.id,
    sessionId: t.id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    model: "fake-model",
    createdAt: Math.floor(t.createdAt / 1000),
    updatedAt: Math.floor(t.updatedAt / 1000),
    recencyAt: null,
    status: t.status,
    path: t.path,
    cwd: t.cwd,
    cliVersion: t.cliVersion,
    originator: "codex-tui",
    source: "vscode",
    name: t.name,
    turns: [],
  });
  const send = (c, m) => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify(m));
  const broadcast = (method, params) => {
    for (const c of clients) if (c.initialized) send(c, { method, params });
  };
  const status = (t, s) => {
    t.status = s;
    t.updatedAt = Date.now();
    broadcast("thread/status/changed", { threadId: t.id, status: s });
  };
  const unload = (t) => {
    clearTimeout(t.unloading);
    t.unloading = setTimeout(() => {
      if (t.subscribers.size) return;
      threads.delete(t.id);
      broadcast("thread/closed", { threadId: t.id });
    }, unloadMs);
  };
  const methods = {
    initialize: (c, p) => {
      c.name = p?.clientInfo?.name ?? "";
      return { userAgent: `codex-tui/0.166.0 (fake) (${c.name}; ${p?.clientInfo?.version ?? ""})`, codexHome: home, platformFamily: "unix", platformOs: "macos" };
    },
    "thread/start": (c, p) => {
      const now = Date.now();
      const t = {
        id: p.threadId ?? randomUUID(),
        cwd: p.cwd,
        name: null,
        status: { type: "idle" },
        createdAt: now,
        updatedAt: now,
        path: p.path ?? null,
        cliVersion: p.cliVersion ?? "0.166.0",
        subscribers: new Set([c]),
        active: null,
        last: null,
        unloading: null,
      };
      threads.set(t.id, t);
      c.threads.add(t.id);
      broadcast("thread/started", { thread: view(t) });
      return { thread: view(t) };
    },
    "thread/loaded/list": () => ({ data: [...threads.keys()], nextCursor: null }),
    "thread/read": (c, p) => {
      const t = threads.get(p.threadId);
      if (!t) throw { code: -32600, message: `thread not loaded: ${p.threadId}` };
      return { thread: view(t) };
    },
    "thread/name/set": (c, p) => {
      const name = String(p.name ?? "").trim();
      if (!name) throw { code: -32600, message: "thread name must not be empty" };
      const t = threads.get(p.threadId);
      if (!t) throw { code: -32600, message: `thread not found: ${p.threadId}` };
      t.name = name;
      t.updatedAt = Date.now();
      appendFileSync(join(home, "session_index.jsonl"), `${JSON.stringify({ id: t.id, thread_name: name, updated_at: new Date().toISOString() })}\n`);
      queueMicrotask(() => broadcast("thread/name/updated", { threadId: t.id, threadName: name }));
      return {};
    },
    "thread/turns/list": (c, p) => {
      const t = threads.get(p.threadId);
      if (!t) throw { code: -32600, message: `thread not loaded: ${p.threadId}` };
      const turn = t.active ? { id: t.active, status: "inProgress" } : t.last ? { id: t.last, status: t.lastStatus } : null;
      return { data: turn ? [{ ...turn, items: [], itemsView: "notLoaded", error: null }] : [], nextCursor: null, backwardsCursor: null };
    },
    "turn/interrupt": (c, p) => {
      const t = threads.get(p.threadId);
      if (!t) throw { code: -32600, message: `thread not loaded: ${p.threadId}` };
      if (!t.active) throw { code: -32600, message: "no active turn to interrupt" };
      if (t.active !== p.turnId) throw { code: -32600, message: `expected active turn id ${p.turnId} but found ${t.active}` };
      for (const s of t.subscribers) send(s, { method: "fake/interrupt", params: { threadId: t.id, turnId: t.active } });
      return {};
    },
    // The real daemon runs the turns and the hooks itself; here the TUI does, and tells it.
    "fake/turn": (c, p) => {
      const t = threads.get(p.threadId);
      if (!t) return {};
      if (p.running) {
        t.active = p.turnId;
        status(t, { type: "active", activeFlags: [] });
      } else {
        t.active = null;
        t.last = p.turnId;
        t.lastStatus = p.interrupted ? "interrupted" : "completed";
        status(t, { type: "idle" });
      }
      return {};
    },
    "fake/hook": async (c, p) => ({ out: await runHook(p.command, p.input) }),
  };
  let idleTimer = null;
  const idle = () => {
    if (!exitWhenIdle) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => clients.size === 0 && close(), 1500);
  };
  const homeCheck = exitWhenIdle ? setInterval(() => !existsSync(home) && close(), 1000) : null;
  wss.on("connection", (ws) => {
    const c = { ws, initialized: false, name: "", threads: new Set() };
    clients.add(c);
    ws.on("message", async (data) => {
      let m;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof m?.method !== "string") return;
      if (m.id === undefined) {
        if (m.method === "initialized") c.initialized = true;
        return;
      }
      requests.push(m.method);
      const f = methods[m.method];
      if (!f) return send(c, { id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
      try {
        send(c, { id: m.id, result: await f(c, m.params ?? {}) });
      } catch (err) {
        send(c, { id: m.id, error: { code: err?.code ?? -32603, message: err?.message ?? String(err) } });
      }
    });
    ws.on("close", () => {
      clients.delete(c);
      for (const id of c.threads) {
        const t = threads.get(id);
        if (!t) continue;
        t.subscribers.delete(c);
        if (!t.subscribers.size) unload(t);
      }
      if (!clients.size) idle();
    });
  });
  idle();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(idleTimer);
    if (homeCheck) clearInterval(homeCheck);
    for (const t of threads.values()) clearTimeout(t.unloading);
    for (const c of clients) c.ws.terminate();
    wss.close();
    http.close();
    rmSync(file, { force: true });
    rmSync(link, { force: true });
    if (pidFile) rmSync(pidPath, { force: true });
    if (exitWhenIdle) process.exit(0);
  }
  return { threads, requests, clients, close };
}

/**
 * A TUI's link to the daemon: `open` attaches (starting the daemon when none answers: `start`),
 * `request` asks it something, `onNote` gets what it tells (thread/name/updated, fake/interrupt).
 */
export class TuiLink {
  ws = null;
  next = 1;
  calls = new Map();
  onNote = () => {};
  constructor(home) {
    this.home = home;
  }
  async open(start = async () => {}) {
    const link = socketLink(this.home);
    for (let i = 0; i < 60; i++) {
      if (existsSync(link) && (await answers(socketFile(this.home)))) break;
      if (i === 0) await start();
      await new Promise((r) => setTimeout(r, 50));
    }
    this.ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${socketFile(this.home)}:/rpc`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.id !== undefined && this.calls.has(m.id)) {
        const { resolve, reject } = this.calls.get(m.id);
        this.calls.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (typeof m.method === "string") this.onNote(m.method, m.params ?? {});
    });
    this.ws.on("error", () => {});
    await this.request("initialize", { clientInfo: { name: "codex-tui", title: null, version: "0.166.0" } });
    this.ws.send(JSON.stringify({ method: "initialized" }));
    return this;
  }
  request(method, params) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    this.ws?.close();
  }
}

// The daemon (0.166), started by a TUI: shared by every TUI of this $CODEX_HOME.
const direct = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (direct && process.argv.includes("--app-server")) {
  const started = await startAppServer(process.env.CODEX_HOME, { unloadMs: Number(process.env.FAKE_CODEX_UNLOAD_MS ?? 60_000), exitWhenIdle: true, pidFile: true }).catch(() => null);
  if (!started) process.exit(0);
} else if (direct) main();

function main() {
  const HOME = process.env.CODEX_HOME;
  const HOOK = process.env.FAKE_CODEX_HOOK ?? "";
  const LOG = process.env.FAKE_CODEX_LOG ?? "";
  const WORK_MS = Number(process.env.FAKE_CODEX_WORK_MS ?? 300);
  const ASK = process.env.FAKE_CODEX_ASK ?? "";
  const VERSION = process.env.FAKE_CODEX_VERSION ?? "0.166.0";
  const DAEMON = VERSION !== "0.153.0";
  const id = randomUUID();
  const cwd = process.cwd();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
  const rollout = join(HOME, "sessions", day, `rollout-${new Date().toISOString().replace(/[:.]/g, "-")}-${id}.jsonl`);
  const lock = join(HOME, "thread-writer-locks", `${id}.lock`);

  const note = (line) => LOG && appendFileSync(LOG, `${line}\n`);
  const record = (type, payload) => appendFileSync(rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`);

  let trusting = process.env.FAKE_CODEX_TRUST === "1";
  let composer = "";
  let started = false;
  let working = null; // the timer of the turn running now
  let turn = 0;
  let burstUntil = 0;

  mkdirSync(join(HOME, "thread-writer-locks"), { recursive: true });
  writeFileSync(lock, "");
  note(`pid ${process.pid}`);
  note(`session ${id}`);

  function draw() {
    process.stdout.write("\x1b[2J\x1b[H");
    if (trusting && DAEMON) {
      process.stdout.write(
        `> You are in ${cwd}\r\n\r\n  Trust this folder? Codex can read, edit, and run files here, subject to\r\n  your permission settings.\r\n\r\n› 1. Trust and continue\r\n  2. Quit\r\n`,
      );
      return;
    }
    if (trusting) {
      process.stdout.write(
        `> You are in ${cwd}\r\n\r\n  Do you trust the contents of this directory? Working with untrusted\r\n  contents comes with higher risk of prompt injection.\r\n\r\n› 1. Yes, continue\r\n  2. No, quit\r\n\r\n  Press enter to continue\r\n`,
      );
      return;
    }
    process.stdout.write("╭─────────────────────────────╮\r\n│ >_ OpenAI Codex (fake)      │\r\n╰─────────────────────────────╯\r\n\r\n");
    if (named) process.stdout.write(`  ${named}\r\n\r\n`);
    if (working) process.stdout.write("• Working (0s • esc to interrupt)\r\n\r\n");
    process.stdout.write(composer ? `› ${composer.replace(/\n/g, "\r\n  ")}\r\n` : "› Ask Codex to do anything\r\n");
    process.stdout.write("\r\n  fake-model medium · " + cwd + "\r\n");
  }

  /** Runs the hook command as Codex does, with the event on stdin (0.166: in its daemon): what it printed. */
  function hook(event, fields = {}) {
    if (!HOOK) return Promise.resolve("");
    note(`hook ${event}`);
    const input = JSON.stringify({ session_id: id, transcript_path: rollout, cwd, hook_event_name: event, model: "fake-model", permission_mode: "default", ...fields });
    if (DAEMON)
      return attached.then((d) =>
        d
          ? d.request("fake/hook", { command: HOOK, input }).then(
              (r) => r.out ?? "",
              () => "",
            )
          : "",
      );
    return runHook(HOOK, input);
  }

  // 0.166: attached to its shared daemon, started (as `codex`: this process's own link, so ps names
  // it codex; in a session of its own, with no terminal) when none answers. Its thread opened there
  // once it's past its trust question, before any turn.
  let link = null;
  let attachedTo = () => {};
  const attached = new Promise((resolve) => (attachedTo = resolve));
  async function attach() {
    const self = process.argv0.endsWith("/codex") ? process.argv0 : process.execPath;
    const start = async () => {
      const child = spawn(self, [process.argv[1], "--app-server"], { detached: true, stdio: "ignore" });
      child.unref();
    };
    try {
      link = await new TuiLink(HOME).open(start);
    } catch (err) {
      note(`daemon unreachable ${err?.message ?? err}`);
      return attachedTo(null);
    }
    link.onNote = (method, params) => {
      if (params.threadId !== id) return;
      if (method === "thread/name/updated") {
        named = params.threadName ?? "";
        note(`named ${named}`);
        draw();
      } else if (method === "fake/interrupt") void interrupt();
    };
    mkdirSync(join(HOME, "sessions", day), { recursive: true });
    record("session_meta", { id, session_id: id, cwd, originator: "codex-tui", cli_version: VERSION, source: "vscode", history_mode: "paginated" });
    await link.request("thread/start", { threadId: id, cwd, path: rollout, cliVersion: VERSION });
    note("thread started");
    attachedTo(link);
  }
  /** Tells the daemon whether a turn runs (0.166). */
  const told = (turnId, running, interrupted = false) => link && void link.request("fake/turn", { threadId: id, turnId, running, interrupted }).catch(() => {});
  let named = "";

  async function submit(text) {
    note(`submit ${text}`);
    if (text === "/exit") {
      if (started) await hook("SessionEnd", { reason: "other" });
      rmSync(lock, { force: true });
      link?.close();
      note("exit");
      process.stdout.write("\x1b[?2004l");
      process.exit(0);
    }
    const rename = text.match(/^\/rename\s+(.+)$/);
    if (rename) {
      // 0.166: through its daemon (thread/name/set), which writes the index and tells every client.
      const d = DAEMON ? await attached : null;
      if (d) await d.request("thread/name/set", { threadId: id, name: rename[1].trim() }).catch(() => {});
      else {
        mkdirSync(HOME, { recursive: true });
        appendFileSync(join(HOME, "session_index.jsonl"), `${JSON.stringify({ id, thread_name: rename[1].trim(), updated_at: new Date().toISOString() })}\n`);
      }
      note(`renamed ${rename[1].trim()}`);
      return draw();
    }
    await begin(text, false);
  }

  /** A turn: from your prompt, or carried on with a Stop hook's reason (`hooked`). */
  async function begin(text, hooked) {
    const turnId = `turn-${++turn}`;
    if (!started) {
      started = true;
      // 0.166 wrote its rollout as its thread opened (attach); 0.153 writes it now.
      if (!DAEMON || !(await attached)) {
        mkdirSync(join(HOME, "sessions", day), { recursive: true });
        record("session_meta", { id, session_id: id, cwd, originator: "codex-tui", cli_version: VERSION, source: DAEMON ? "vscode" : "cli", history_mode: "paginated" });
      }
      await hook("SessionStart", { source: "startup" });
    }
    if (hooked) {
      record("event_msg", {
        type: "item_completed",
        thread_id: id,
        turn_id: turnId,
        item: { type: "HookPrompt", id: `hp-${turn}`, content: [{ type: "text", text: `<hook_prompt hook_run_id="h${turn}">${text}</hook_prompt>` }] },
      });
    } else {
      record("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 1000 });
      record("event_msg", { type: "item_completed", thread_id: id, turn_id: turnId, item: { type: "UserMessage", id: `u-${turn}`, content: [{ type: "text", text, text_elements: [] }] } });
      await hook("UserPromptSubmit", { turn_id: turnId, prompt: text });
    }
    told(turnId, true);
    // "…slowly": a turn long enough to interrupt.
    working = setTimeout(() => void finish(text, turnId, hooked), /\bslowly\b/.test(text) ? 5000 : WORK_MS);
    draw();
  }

  async function finish(text, turnId, hooked) {
    if (ASK && !hooked) {
      const out = await hook("PermissionRequest", { turn_id: turnId, tool_name: "Bash", tool_input: { command: ASK } });
      let decision = "none";
      try {
        const d = JSON.parse(out).hookSpecificOutput?.decision;
        decision = d?.behavior === "deny" ? `deny ${d.message}` : (d?.behavior ?? "none");
      } catch {}
      note(`permission ${decision}`);
      if (decision === "allow") {
        record("event_msg", {
          type: "item_completed",
          thread_id: id,
          turn_id: turnId,
          item: { type: "CommandExecution", id: `c-${turn}`, command: ["/bin/zsh", "-lc", ASK], status: "completed", aggregated_output: "ok\n", exit_code: 0 },
        });
      }
    }
    if (!working) return;
    working = null;
    // A reply through the Stop hook comes wrapped in Kiko's words: answered as what you said.
    const reply = `Done: ${text.replace(/^The user replied by voice[^:]*: /, "")}`;
    record("event_msg", { type: "item_completed", thread_id: id, turn_id: turnId, item: { type: "AgentMessage", id: `a-${turn}`, content: [{ type: "Text", text: reply }], phase: "final_answer" } });
    record("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: reply });
    told(turnId, false);
    draw();
    const out = await hook("Stop", { turn_id: turnId, stop_hook_active: hooked, last_assistant_message: reply });
    let parsed = {};
    try {
      parsed = JSON.parse(out);
    } catch {}
    if (parsed.decision === "block" && typeof parsed.reason === "string") {
      note(`stop block ${parsed.reason}`);
      await begin(parsed.reason, true);
    } else note("stop done");
  }

  async function interrupt() {
    if (!working) return;
    clearTimeout(working);
    working = null;
    record("event_msg", { type: "turn_aborted", turn_id: `turn-${turn}`, reason: "interrupted" });
    told(`turn-${turn}`, false, true);
    note("interrupted");
    draw();
    await hook("Interrupt", { turn_id: `turn-${turn}` });
  }

  // ── Keys ──

  const PASTE_START = "\x1b[200~";
  const PASTE_END = "\x1b[201~";
  let pasting = null;

  function keys(chunk) {
    let s = chunk;
    while (s.length) {
      if (pasting !== null) {
        const end = s.indexOf(PASTE_END);
        if (end < 0) {
          pasting += s;
          return;
        }
        pasting += s.slice(0, end);
        composer += pasting;
        pasting = null;
        // A real paste ends any burst: an Enter after it sends.
        burstUntil = 0;
        s = s.slice(end + PASTE_END.length);
        draw();
        continue;
      }
      if (s.startsWith(PASTE_START)) {
        pasting = "";
        s = s.slice(PASTE_START.length);
        continue;
      }
      if (s === "\x1b") return void (trusting ? process.exit(0) : interrupt());
      const c = s[0];
      s = s.slice(1);
      if (c === "\r") {
        if (trusting) {
          trusting = false;
          note("trusted");
          if (DAEMON) void attach();
          draw();
          continue;
        }
        if (Date.now() < burstUntil) {
          composer += "\n";
          note("enter as newline");
          continue;
        }
        const text = composer.trim();
        composer = "";
        if (text) void submit(text);
        else draw();
        continue;
      }
      if (c === "\x7f") {
        composer = composer.slice(0, -1);
        continue;
      }
      if (c >= " ") composer += c;
    }
    draw();
  }

  process.on("SIGTERM", () => {
    // No handler of its own in Codex: gone at once, nothing more run (no SessionEnd), its lock left.
    note("SIGTERM");
    process.exit(143);
  });

  process.stdout.write("\x1b[?2004h");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // Plain keys that come all at once (3 or more): a paste burst, as Codex's TUI takes them.
    const plain = chunk.replace(/\x1b\[20[01]~/g, "");
    if (!chunk.includes(PASTE_START) && pasting === null && plain.replace(/\r/g, "").length >= 3) burstUntil = Date.now() + 120;
    keys(chunk);
  });
  draw();
  if (DAEMON && !trusting) void attach();
  else if (!DAEMON) attachedTo(null);
  const prompt = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (prompt && !trusting) void submit(prompt);
}
