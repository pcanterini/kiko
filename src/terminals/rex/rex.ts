// Rex (superlogical.com/rex) through its own CLI, `rex`: a server on a Unix socket, its terminals
// "blocks" in windows (tabs) of sessions. Each look or send is one `rex do`: a Lua script of ours
// run against the server in one connection (rex.call: its API), so finding every session's block
// is one process (~20 ms), and a word's check and send are one too: the block's process is looked
// at again and the text goes in only if it's the one checked, in the same script.
//
// Only Rex's local server, and only when it's running (its socket is there): never `--autostart`
// (that would start a server for someone who doesn't use Rex). Only terminal blocks on this Mac
// (the server's own host_id: a block on another host has another machine's processes). What the
// scripts give back is only what Kiko reads: process ids, executable names, folders, titles,
// bracketed paste; never a process's argv0 or anything of its command line. What's typed goes in
// over the script's stdin (`--args -`), never on a command line, where `ps` shows it.
//
// REX_SESSION and REX_BLOCK are taken out of rex's environment: with them, a command without a
// block would act on the block Kiko was started from. Every script names its block itself.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isObject } from "../../core/is-object.ts";
import { envVar } from "../../core/name.ts";

/** A block's id as Rex writes it: "block:" and a UUID. */
export const BLOCK_ID = /^block:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A session's id as Rex writes it. */
export const SESSION_ID = /^session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Rex's server socket on a Mac (`rex whoami`'s endpoint); KIKO_REX_SOCKET names another (the unit tests: none; a live test: a throwaway server), which every rex command then talks to. */
export const rexSocket = () => envVar("REX_SOCKET") ?? join(homedir(), "Library", "Application Support", "rex", "server.sock");

/** Where Rex for Mac keeps its CLI (it puts that folder on the shell's PATH). */
const BUNDLED = join(homedir(), "Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex");

let found: string | null = null;

/** The `rex` CLI: KIKO_REX_BIN, else on PATH, else where Rex for Mac keeps it; null when there's none. */
export function rexPath(path = process.env.PATH ?? ""): string | null {
  const named = envVar("REX_BIN");
  if (named) return existsSync(named) ? named : null;
  if (found) return found;
  for (const at of [
    ...path
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "rex")),
    BUNDLED,
  ]) {
    if (existsSync(at)) return (found = at);
  }
  return null;
}

/** Whether Rex's server is running: its socket is there (a stat, no process started). */
export function rexRunning(socket = rexSocket()): boolean {
  try {
    return statSync(socket).isSocket();
  } catch {
    return false;
  }
}

/**
 * A terminal block, as a look gives it: its session, what's in front in it (`pid`, its executable's
 * `name`, its folder `cwd`: Rex's `process` method's `foreground`), the processes between that and
 * the one the block started (`up`: Rex's `ancestors`, then its `child`), its title, and whether its
 * program has exited (a block kept open after it).
 */
export type Block = { session: string; block: string; pid?: number; name?: string; cwd?: string; up: number[]; title: string; exited: boolean };

/** A block looked at closely: also whether its program asked for bracketed paste. */
export type Inspected = Block & { paste: boolean };

/** A key as Rex's key event has it (`client.key`'s schema): the physical key, its modifiers, the text it types. */
export type RexKey = { key: string; mods?: string; text?: string };

/** What a guarded send did: went in; nothing went in, as the block changed since it was checked (or it's gone); or Rex refused. */
export type Sent = { status: "sent" } | { status: "changed" } | { status: "gone" } | { status: "failed"; error: string };

// ── The scripts ──

// Every script starts here: the connection hears every session (so it may call their blocks'
// methods: without it, a block's method is refused as not attached), and finds its blocks.
const PRELUDE = `
local A = rex.args or {}
local attached = rex.call("session.attach_all", { event_scope = "session" })
local SESSIONS = (attached and attached.sessions) or {}
local status = rex.call("server.status", {})
local HOST = status and status.host_id
local function call(s, b, method, args)
  return rex.call("block.method", { session_id = s, block_id = b, method = method, args = args })
end
local function blocks(s)
  local r = rex.call("session.list_blocks", { session_id = s })
  return (r and r.blocks) or {}
end
local function terminal(x)
  return type(x.flavor) == "string" and string.sub(x.flavor, 1, 26) == "com.superlogical.terminal."
    and (HOST == nil or x.host_id == nil or x.host_id == HOST)
end
local function locate(id)
  for _, s in ipairs(SESSIONS) do
    for _, x in ipairs(blocks(s.session_id)) do
      if x.block_id == id then
        if terminal(x) then return s.session_id, x end
        return nil
      end
    end
  end
  return nil
end
local function look(s, x)
  local row = { session = s, block = x.block_id, up = {} }
  local p = call(s, x.block_id, "process")
  if type(p) == "table" then
    local fg = p.foreground
    if type(fg) == "table" then
      row.pid = fg.pid
      row.name = fg.name
      row.cwd = fg.cwd
    end
    if type(p.ancestors) == "table" then
      for _, a in ipairs(p.ancestors) do
        if type(a) == "table" then row.up[#row.up + 1] = a.pid end
      end
    end
    if type(p.child) == "table" then row.up[#row.up + 1] = p.child.pid end
    row.exited = type(p.last_exit) == "table"
  end
  local t = call(s, x.block_id, "title")
  if type(t) == "table" and type(t.title) == "string" then row.title = t.title end
  return row
end
local function pasting(s, b)
  local m = call(s, b, "modes")
  if type(m) == "table" and type(m.modes) == "table" then
    for _, mode in ipairs(m.modes) do
      if type(mode) == "table" and (mode.name == "bracketed_paste" or (mode.number == 2004 and not mode.ansi)) then
        return mode.set == true
      end
    end
  end
  return false
end
`;

/** Every terminal block on the server, looked at: one script, one process. */
export const LIST = `${PRELUDE}
local out = {}
for _, s in ipairs(SESSIONS) do
  for _, x in ipairs(blocks(s.session_id)) do
    if terminal(x) then out[#out + 1] = look(s.session_id, x) end
  end
end
return { blocks = out }
`;

/** One block (A.block), looked at closely; gone when it isn't there. */
export const INSPECT = `${PRELUDE}
local s, x = locate(A.block)
if not s then return { gone = true } end
local row = look(s, x)
row.paste = pasting(s, x.block_id)
return { block = row }
`;

/**
 * Text (A.text) or one key (A.key) into a block (A.block), only if what's in front there is still
 * the process checked (A.pid) and, for a bracketed paste (A.paste), it still asks for one: checked
 * and sent in one connection. A bracketed paste is Rex's paste event (it brackets it, as the
 * program asked); other text is typed (write); a key is pressed and released.
 */
export const SEND = `${PRELUDE}
local s, x = locate(A.block)
if not s then return { status = "gone" } end
local p = call(s, x.block_id, "process")
local fg = type(p) == "table" and p.foreground or nil
if type(fg) ~= "table" or fg.pid ~= A.pid then return { status = "changed" } end
if A.paste and not pasting(s, x.block_id) then return { status = "changed" } end
local function event(t, payload)
  return rex.call("block.event", { session_id = s, block_id = x.block_id, event = { type = t, payload = payload } })
end
local ok, err
if type(A.text) == "string" then
  if A.paste then
    ok, err = event("paste", { text = A.text })
  else
    ok, err = call(s, x.block_id, "write", { data = A.text })
  end
elseif type(A.key) == "table" then
  local k = { key = A.key.key, mods = A.key.mods or "", consumed_mods = "", text = A.key.text or "", composing = false, action = "press" }
  ok, err = event("key", k)
  if ok then
    k.action = "release"
    k.text = ""
    event("key", k)
  end
else
  return { status = "failed", error = "nothing to send" }
end
if not ok then return { status = "failed", error = tostring(err) } end
return { status = "sent" }
`;

/** What a block (A.block) shows: its text, and how many rows its screen has; gone when it isn't there. */
export const SCREEN = `${PRELUDE}
local s, x = locate(A.block)
if not s then return { gone = true } end
local f = call(s, x.block_id, "format", { format = "text" })
if type(f) ~= "table" or type(f.content) ~= "string" then return { gone = true } end
local z = call(s, x.block_id, "size")
return { content = f.content, rows = type(z) == "table" and z.rows or nil }
`;

/** The sessions on the server, by id. */
export const SESSIONS = `${PRELUDE}
local out = {}
for _, s in ipairs(SESSIONS) do out[#out + 1] = s.session_id end
return { sessions = out }
`;

// ── Reading what the scripts give back (whatever it is: a field Rex left out, or one it renamed, is passed over) ──

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A look's row, or null when it isn't one (no block id, no session id). */
export function blockOf(v: unknown): Block | null {
  if (!isObject(v)) return null;
  const block = str(v.block);
  const session = str(v.session);
  if (!block || !BLOCK_ID.test(block) || !session || !SESSION_ID.test(session)) return null;
  const pid = int(v.pid);
  const name = str(v.name);
  const cwd = str(v.cwd);
  return {
    session,
    block,
    ...(pid ? { pid } : {}),
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    up: Array.isArray(v.up) ? v.up.map(int).filter((p): p is number => p !== undefined) : [],
    title: str(v.title) ?? "",
    exited: v.exited === true,
  };
}

/** LIST's answer as blocks. */
export function parseList(out: string): Block[] {
  const v = parse(out);
  const rows = isObject(v) && Array.isArray(v.blocks) ? v.blocks : [];
  return rows.map(blockOf).filter((b): b is Block => b !== null);
}

/** INSPECT's answer: the block, or null when it's gone (or the answer isn't one). */
export function parseInspect(out: string): Inspected | null {
  const v = parse(out);
  const block = isObject(v) ? blockOf(v.block) : null;
  return block && isObject(v) && isObject(v.block) ? { ...block, paste: v.block.paste === true } : null;
}

/** SEND's answer. */
export function parseSent(out: string): Sent {
  const v = parse(out);
  const status = isObject(v) ? v.status : undefined;
  if (status === "sent" || status === "changed" || status === "gone") return { status };
  return { status: "failed", error: isObject(v) && typeof v.error === "string" ? v.error : `unexpected answer: ${out.trim().slice(0, 200)}` };
}

/**
 * SCREEN's answer: the screen's own rows, the last `rows` lines (scrollback above them left out, as
 * tmux's capture-pane shows), each without its trailing spaces; null when it's gone.
 */
export function parseScreen(out: string): string | null {
  const v = parse(out);
  if (!isObject(v) || typeof v.content !== "string") return null;
  const lines = v.content.split("\n").map((l) => l.replace(/\s+$/, ""));
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const rows = int(v.rows);
  return (rows && lines.length > rows ? lines.slice(-rows) : lines).join("\n");
}

/** SESSIONS's answer. */
export function parseSessions(out: string): string[] {
  const v = parse(out);
  const all = isObject(v) && Array.isArray(v.sessions) ? v.sessions : [];
  return all.filter((s): s is string => typeof s === "string" && SESSION_ID.test(s));
}

/** `rex run --json`'s (and `rex new --json`'s) new block. */
export function parseCreated(out: string): string | null {
  const v = parse(out);
  if (!isObject(v)) return null;
  const ids = Array.isArray(v.block_ids) ? v.block_ids : Array.isArray(v.initial_windows) && isObject(v.initial_windows[0]) ? v.initial_windows[0].block_ids : [];
  const block = Array.isArray(ids) ? ids[0] : undefined;
  return typeof block === "string" && BLOCK_ID.test(block) ? block : null;
}

function parse(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ── Running rex ──

/** How long one rex command may take: Rex's own limit on each request, and ours on the whole. */
const REQUEST = "2s";
const WHOLE_MS = 4000;

/** rex's environment: Kiko's own, without the block and session Kiko may have been started from (and the server, when one is named). */
function rexEnv(named: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  delete env.REX_WINDOW;
  delete env.REX_CLIENT;
  if (named) delete env.REX_SERVER;
  return env;
}

/** The server KIKO_REX_SOCKET names (a throwaway one, for a live test): rex talks to that one, as rexRunning looks at it. */
const serverArgs = () => {
  const named = envVar("REX_SOCKET");
  return named ? ["--server", named] : [];
};

/** `rex <args>` on the local server (never starting one), `input` on its stdin: what it printed; rejects with what it said. */
export function runRex(args: string[], input?: string): Promise<string> {
  const path = rexPath();
  if (!path) return Promise.reject(new Error("rex isn't installed"));
  return new Promise((resolve, reject) => {
    const server = serverArgs();
    const child = execFile(path, [...server, "--autostart=false", "--timeout", REQUEST, "--color", "never", ...args], { env: rexEnv(server.length > 0), timeout: WHOLE_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** One of the scripts above, with `args` as its rex.args (over stdin). */
export const script = (code: string, args: Record<string, unknown> = {}) => runRex(["do", "-e", code, "--args", "-"], JSON.stringify(args));

/** The session REX_SESSION names in Kiko's own environment (Kiko started from Rex), when it's one. */
export function ownSession(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.REX_SESSION;
  return s && SESSION_ID.test(s) ? s : null;
}

/** The session a new tab goes in: Kiko's own (it was started from Rex) while it's there, else the first; null with none. */
export function tabSession(sessions: readonly string[], own: string | null): string | null {
  return own && sessions.includes(own) ? own : (sessions[0] ?? null);
}

/** `rex run` (a new tab in `session`) or, with none, `rex new` (a new session): `argv` started directly in `cwd`. Its block. */
export async function runBlock(session: string | null, cwd: string, argv: string[]): Promise<string> {
  const out = await runRex(session ? ["run", "-s", session, "-c", cwd, "--shell=none", "--json", "--", ...argv] : ["new", "-c", cwd, "--shell=none", "--json", "--", ...argv]);
  const block = parseCreated(out);
  if (!block) throw new Error(`Rex didn't say which pane it opened: ${out.trim().slice(0, 200)}`);
  return block;
}

/**
 * A new tab in Rex running `command` (a shell command line) instead of a shell, closed with it: for
 * Kiko's window (../tmux/show.ts, KIKO_WINDOW_TERMINAL=rex or `kiko` started from Rex). In the
 * session Kiko was started from, else the first one; with none, a new session.
 */
export async function rexWindow(cwd: string, command: string): Promise<void> {
  const session = tabSession(parseSessions(await script(SESSIONS)), ownSession());
  await runBlock(session, cwd, ["/bin/sh", "-c", `exec ${command}`]);
}

/** Whether a Rex window can be opened now: its server running, `rex` installed. */
export const rexReady = () => rexRunning() && rexPath() !== null;
