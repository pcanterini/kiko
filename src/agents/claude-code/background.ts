// What a Claude Code session still runs in the background (shells it started with
// run_in_background or moved there, monitors, subagents), shown apart from its turn and never as
// "working" (AgentSession.background; ./turns.ts says whether it's in a turn).
// - A background job says, in its own file, ~/.claude/jobs/<job>/state.json (read here, never
//   written): `inFlight.tasks`, how many run, and `fan`, each one started (`id`, `kind` "agent" or
//   "shell", `label`, `startedAt`, and `doneAt` once an agent is done). A terminal session moved into
//   a job (./sessions.ts `continued`) goes by the job's.
// - A terminal session (or the desktop app's) keeps nothing like it, so its transcript says
//   (transcriptTasks): each task starts with its tool's result (a Bash or PowerShell call's
//   `backgroundTaskId`, a Monitor's `taskId`, an Agent call's "async_launched" `agentId`) and ends
//   with Claude Code's `<task-notification>` naming it with a final status (completed, failed,
//   killed, stopped). A stop it never wrote (the notice lost, the process gone) can't keep a count
//   up for good: `claude agents` says "idle" for a session whose process has nothing left running,
//   and everything it started before then is over (sessionBackground); so is whatever it started
//   before its process did (a session resumed in a new one).
// Whether one still does anything: its output file growing, Claude Code's
// /tmp/claude-<uid>/<project>/<session>/tasks/<id>.output (a subagent's is a link to its
// transcript, so that's its transcript being written). Only files are read: never a process's
// command line or environment.
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { envVar } from "../../core/name.ts";
import type { Background } from "../types.ts";
import { OPEN_GRACE_MS } from "./turns.ts";

/** A task that hasn't shown a sign of life (output, its transcript written) for this long is flagged as quiet. */
export const QUIET_MS = 10 * 60_000;

/** ~/.claude/jobs; KIKO_CLAUDE_JOBS points the tests at a fixture. */
const jobsDir = () => envVar("CLAUDE_JOBS") ?? `${homedir()}/.claude/jobs`;

/**
 * Where Claude Code keeps its tasks' output: /tmp/claude-<uid> (its CLAUDE_CODE_TMPDIR, when this
 * process has it, for /tmp); KIKO_CLAUDE_TASKS points the tests at a fixture.
 */
const tasksRoot = () => envVar("CLAUDE_TASKS") ?? `${process.env.CLAUDE_CODE_TMPDIR || "/tmp"}/claude-${process.getuid?.() ?? 0}`;

/** A session's tasks folder, as Claude Code names it (its folder's path with every other character a "-", as for its transcripts). */
export const tasksDir = (cwd: string, sessionId: string) => `${tasksRoot()}/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${sessionId}/tasks`;

/** When a file was last written (ms epoch), following a link; 0 when it isn't there. */
function writtenAt(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Each job's state.json as last read, by its path: read again only when it changed.
const states = new Map<string, { at: number; state: unknown }>();

function jobState(job: string): unknown {
  const path = `${jobsDir()}/${job}/state.json`;
  const at = writtenAt(path);
  if (!at) return null;
  const known = states.get(path);
  if (known?.at === at) return known.state;
  let state: unknown = null;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  if (states.size > 100) states.clear();
  states.set(path, { at, state });
  return state;
}

/** A background job's work still running, from its state.json; undefined for none, or none known. */
export function jobBackground(job: string, cwd: string, sessionId: string, now = Date.now()): Background | undefined {
  if (!/^[\w-]+$/.test(job)) return undefined;
  const dir = tasksDir(cwd, sessionId);
  return backgroundOf(jobState(job), (id) => (/^[\w-]+$/.test(id) ? writtenAt(`${dir}/${id}.output`) : 0), now);
}

/** A background task: its id (its output file's name), whether it's a subagent, when it started (ms epoch). */
export type Started = { id: string; agent: boolean; startedAt: number };

/**
 * What a job's state.json says still runs (`inFlight.tasks`; else its `fan` entries not done), and
 * which of them have been quiet for QUIET_MS or more: of the newest of its `fan` entries not done, as
 * many as run, each one's last sign of life is when its output was last written (`outputAt`, by
 * its id), else when it started. `quietSince`: the longest quiet one's. `agents`: how many of those
 * entries are subagents. Undefined when nothing runs.
 */
export function backgroundOf(state: unknown, outputAt: (id: string) => number, now = Date.now()): Background | undefined {
  if (!state || typeof state !== "object") return undefined;
  const { inFlight, fan } = state as { inFlight?: { tasks?: unknown }; fan?: unknown };
  const running: Started[] = (Array.isArray(fan) ? fan : [])
    .filter((f) => f && typeof f.id === "string" && f.doneAt == null)
    .map((f) => ({ id: f.id as string, agent: f.kind === "agent", startedAt: typeof f.startedAt === "number" ? f.startedAt : 0 }));
  const tasks = inFlight?.tasks;
  const count = typeof tasks === "number" && Number.isInteger(tasks) && tasks >= 0 ? tasks : running.length;
  if (!count) return undefined;
  return counted(running.sort((a, b) => b.startedAt - a.startedAt).slice(0, count), count, outputAt, now);
}

/**
 * `count` running, `known` the ones named: how many of those are subagents (`agents`), and which
 * have been quiet for QUIET_MS or more (each one's last sign of life: its output last written, else
 * its start), with the longest quiet one's (`quietSince`).
 */
function counted(known: Started[], count: number, outputAt: (id: string) => number, now: number): Background {
  const agents = known.filter((t) => t.agent).length;
  const lasts = known.map((t) => Math.max(t.startedAt, outputAt(t.id))).filter((last) => last > 0 && now - last >= QUIET_MS);
  return { count, agents, ...(lasts.length ? { quiet: lasts.length, quietSince: Math.min(...lasts) } : {}) };
}

// ── A terminal session's, from its transcript ─────────────────────────────

/** A transcript as read so far: up to `offset`, with the line it stopped in the middle of (`rest`), and the tasks started that haven't ended. */
type Read = { offset: number; rest: Buffer; skipping: boolean; running: Map<string, Started> };

const reads = new Map<string, Read>();
const CHUNK = 4 * 1024 * 1024;
/** How much of a transcript the first read takes, from its end. */
const FIRST_MAX = 16 * 1024 * 1024;
/** A line longer than this (a huge tool result) is skipped: no start or end is ever that long. */
const LINE_MAX = 16 * 1024 * 1024;
/** A task's notice with one of these isn't its last (a check-in, an agent waiting on you); any other status is final. */
const NOT_OVER = new Set(["running", "pending", "blocked", "in_progress", ""]);
const ID = /^[\w-]{1,128}$/;

/**
 * The background tasks a session's transcript says are still running, oldest first: read on from
 * where it was last time (its last FIRST_MAX the first time), so each call reads only what was added. A
 * file that shrank (rewritten) is read again from the start. [] when there's none, or no file.
 * Ones started before `after` (ms epoch) are over: left out, and forgotten.
 */
export function transcriptTasks(path: string, after = 0): Started[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    reads.delete(path);
    return [];
  }
  let read = reads.get(path);
  try {
    const size = fstatSync(fd).size;
    if (!read || size < read.offset) {
      // The first time, only its last FIRST_MAX: a long transcript isn't read whole while the list
      // waits (a task started before that, hours of work ago, goes uncounted). Its first line, cut, is skipped.
      const offset = Math.max(0, size - FIRST_MAX);
      read = { offset, rest: Buffer.alloc(0), skipping: offset > 0, running: new Map() };
    }
    reads.delete(path);
    reads.set(path, read);
    if (reads.size > 100) reads.delete(reads.keys().next().value!);
    if (read.offset < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - read.offset));
      while (read.offset < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - read.offset), read.offset);
        if (n <= 0) break;
        read.offset += n;
        takeLines(read, chunk.subarray(0, n));
      }
    }
  } catch {
    // unreadable now: what was read so far stands
  } finally {
    closeSync(fd);
  }
  if (!read) return [];
  // Over by now, whether or not their end was written: never kept again.
  for (const [id, t] of read.running) if (t.startedAt < after) read.running.delete(id);
  return [...read.running.values()];
}

/** The whole lines in what was just read (with what was left of the last one), each taken; the line cut off kept for next time. */
function takeLines(read: Read, bytes: Buffer) {
  const data = read.rest.length ? Buffer.concat([read.rest, bytes]) : bytes;
  let start = 0;
  for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
    if (!read.skipping) take(read, data.toString("utf8", start, nl));
    read.skipping = false;
    start = nl + 1;
  }
  const rest = data.subarray(start);
  if (rest.length > LINE_MAX) {
    read.skipping = true;
    read.rest = Buffer.alloc(0);
  } else {
    read.rest = Buffer.from(rest);
  }
}

/** One transcript line: a background task started (its tool's result), or ended (a notice naming it). */
function take(read: Read, line: string) {
  if (line.includes("<task-notification>")) ended(read, line);
  if (!line.includes('"toolUseResult"')) return;
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  const result = entry?.type === "user" ? entry.toolUseResult : null;
  if (!result || typeof result !== "object") return;
  const agent = result.status === "async_launched" && typeof result.agentId === "string";
  // A subagent; a Bash (or PowerShell) call run in the background or moved there; a Monitor (its
  // deadline says it's one: a cloud agent's `taskId` has none, and runs elsewhere).
  const id = agent
    ? result.agentId
    : typeof result.backgroundTaskId === "string"
      ? result.backgroundTaskId
      : typeof result.taskId === "string" && typeof result.timeoutMs === "number"
        ? result.taskId
        : null;
  if (!id || !ID.test(id) || read.running.has(id)) return;
  const at = Date.parse(entry.timestamp);
  read.running.set(id, { id, agent, startedAt: Number.isFinite(at) ? at : Date.now() });
}

/**
 * Claude Code's notices about its tasks, wherever the line has them (queued, or delivered as a
 * message): each names its task (`<task-id>`; several in one about tasks a previous process left)
 * and, once it's over, its final `<status>`. One about an agent that now reports to another says
 * nothing more comes here: over too.
 */
function ended(read: Read, line: string) {
  for (const notice of line.split("<task-notification>").slice(1)) {
    const body = notice.split("</task-notification>")[0];
    const status = /<status>([^<]*)<\/status>/.exec(body)?.[1].trim().toLowerCase();
    const over = status !== undefined ? !NOT_OVER.has(status) : body.includes("completion will not be delivered here");
    if (!over) continue;
    for (const [, id] of body.matchAll(/<task-id>([^<]*)<\/task-id>/g)) read.running.delete(id.trim());
  }
}

/** When each session's process was last seen with nothing running, by its transcript's path: what it started before then is over. */
const idleAt = new Map<string, number>();

/**
 * What a terminal session still runs in the background, from its transcript (transcriptTasks).
 * `busy`: its process may run something (`claude agents` doesn't say "idle", or it's in a turn).
 * When it doesn't, nothing runs, and everything started until a moment before (OPEN_GRACE_MS: a
 * listing a little behind) is over, its end missed or not, so it's never counted again; nothing
 * is read then. `since`: when its process started (ms epoch; 0 when unknown): a task started
 * before then was a previous process's. Undefined when nothing runs.
 */
export function sessionBackground(path: string, cwd: string, sessionId: string, { busy, since = 0 }: { busy: boolean; since?: number }, now = Date.now()): Background | undefined {
  if (!busy) {
    idleAt.delete(path);
    idleAt.set(path, now - OPEN_GRACE_MS);
    if (idleAt.size > 200) idleAt.delete(idleAt.keys().next().value!);
    return undefined;
  }
  const after = Math.max(since, idleAt.get(path) ?? 0);
  const tasks = transcriptTasks(path, after);
  if (!tasks.length) return undefined;
  const dir = tasksDir(cwd, sessionId);
  return counted(tasks, tasks.length, (id) => writtenAt(`${dir}/${id}.output`), now);
}

/** Forgets every transcript read and idle process seen (for the tests). */
export function forgetBackground() {
  reads.clear();
  idleAt.clear();
}
