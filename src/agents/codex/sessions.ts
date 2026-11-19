// Codex's running sessions. Codex keeps no record of its sessions' processes (no `claude agents`,
// no ~/.claude/sessions), so its hook keeps one for Kiko (hooks/codex-hook.mjs): <pid>.json in
// ~/.config/kiko/codex-sessions (KIKO_CODEX_SESSIONS), with the session's ID, folder, rollout
// and status, and when its process started. A session is listed while its process is still that
// one (alive, and started when the record says). Codex runs no hook before a session's first turn
// (SessionStart comes with it), so from the records alone one just opened with nothing asked yet
// isn't listed. One whose hooks run in Codex's shared app-server daemon (every session from
// 0.166.0 on) has no pid in its record: listed while Codex holds its thread's writer lock, and found
// in its tmux pane by its program and folder (AgentSession.program) rather than by its process.
// From 0.166.0, Codex's shared daemon also says which threads are open (./daemon.ts), from the
// moment a TUI opens one, hooks or not: those are listed too, each session once (`mergeLive`), and
// while the daemon answers it says which of them still run.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_FOLDER, envVar } from "../../core/name.ts";
import { checkSessionProcess, systemReach, terminate, type ProcessReach } from "../process-check.ts";
import { startTimes } from "../processes.ts";
import type { AgentSession, Endable, Signalled } from "../types.ts";
import type { DaemonThread } from "./daemon.ts";
import { otherApp } from "./origin.ts";
import { parseLines, rolloutTail } from "./rollouts.ts";

/** The adapter's id: a Codex session is listed with it (AgentSession.agent). */
export const CODEX_AGENT = "codex";

/** Where the hook keeps its records: KIKO_CODEX_SESSIONS (the tests'), else codex-sessions in this flavour's config folder, ~/.config/kiko(-dev)/ (as hooks/codex-hook.mjs). */
export const recordsDir = () => envVar("CODEX_SESSIONS") || join(homedir(), ".config", CONFIG_FOLDER, "codex-sessions");

/** Codex's own folder: CODEX_HOME, else ~/.codex. Only read here (its session names, its writer locks), never written. */
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/** A record as the hook writes it (any field may be missing from a record it didn't write). */
export type CodexRecord = {
  pid?: number;
  procStart?: string;
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
  /** busy | idle | blocked: what its last event left it doing. */
  status?: string;
  /** When the hook last wrote it (ms epoch). */
  at?: number;
};

/** Every record the hook keeps that's whole: a session ID and a folder. */
export function readRecords(dir = recordsDir()): CodexRecord[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      return r && typeof r.sessionId === "string" && typeof r.cwd === "string" ? [r as CodexRecord] : [];
    } catch {
      return [];
    }
  });
}

/** Whether Codex holds a thread's writer lock: its file there (removed when Codex exits cleanly). */
const locked = (sessionId: string, home = codexHome()) => existsSync(join(home, "thread-writer-locks", `${sessionId}.lock`));

/**
 * The records whose sessions are still running: by pid, a process started when the record says;
 * without one, a thread whose writer lock is there. `times`: start times by pid (`startTimes`).
 */
export function liveRecords(records: CodexRecord[], times: ReadonlyMap<number, string>, isLocked: (sessionId: string) => boolean = locked): CodexRecord[] {
  const live = records.filter((r) => (Number.isInteger(r.pid) ? typeof r.procStart === "string" && times.get(r.pid!) === r.procStart.replace(/\s+/g, " ").trim() : isLocked(r.sessionId)));
  // One process, one session: the newest record for it (`/new` in Codex starts another in the same process).
  const byPid = new Map<number, CodexRecord>();
  for (const r of live) if (Number.isInteger(r.pid) && (byPid.get(r.pid!)?.at ?? -1) < (r.at ?? 0)) byPid.set(r.pid!, r);
  return live.filter((r) => !Number.isInteger(r.pid) || byPid.get(r.pid!) === r);
}

// ── Names given with /rename ──

let names: { key: string; map: Map<string, string> } | null = null;

/**
 * The names sessions were given in Codex (/rename, or `codex resume`'s), by session ID: the newest
 * line for each in $CODEX_HOME/session_index.jsonl ({"id", "thread_name", "updated_at"}). Read again
 * only when the file changes.
 */
export function threadNames(home = codexHome()): Map<string, string> {
  const path = join(home, "session_index.jsonl");
  let key: string;
  try {
    const s = statSync(path);
    key = `${path}:${s.size}:${s.mtimeMs}`;
  } catch {
    return new Map();
  }
  if (names?.key === key) return names.map;
  const map = new Map<string, string>();
  for (const line of parseLines(rolloutTail(path, 4 * 1024 * 1024))) {
    if (typeof line?.id !== "string") continue;
    const name = typeof line.thread_name === "string" ? line.thread_name.trim() : "";
    if (name) map.set(line.id, name);
    else map.delete(line.id);
  }
  names = { key, map };
  return map;
}

/**
 * What Codex's shared daemon says is open (./daemon.ts): its threads (null: no daemon to ask), and
 * the folders a Codex TUI runs in now (./processes.ts; null: couldn't look).
 */
export type Open = { threads: DaemonThread[] | null; folders: ReadonlyMap<string, number> | null };

/**
 * The sessions running now: from the hook's records (`liveRecords`) and, with `open`, the threads
 * Codex's daemon has open (`mergeLive`), each once. Named as Codex names them (`nameOf`: its daemon's
 * name for it, else the one given with /rename in session_index.jsonl).
 */
export async function listSessions(dir = recordsDir(), open?: Open, nameOf: (sessionId: string) => string = (id) => threadNames().get(id) ?? ""): Promise<AgentSession[]> {
  // Not another app's (a T3 Code thread on Codex, ./origin.ts): its hook keeps no record of one, but
  // one may be left from before its rollout could be read (or from a hook before that rule).
  const records = readRecords(dir).filter((r) => !otherApp(r.sessionId, r.transcriptPath));
  const times = await startTimes(records.filter((r) => Number.isInteger(r.pid)).map((r) => r.pid!));
  return mergeLive(records, times, open ?? { threads: null, folders: null }, nameOf);
}

/**
 * The hook's records and the daemon's threads as one list, one row per session (its thread ID is
 * the hooks' session ID). Without a daemon to ask (`threads` null: a Codex before 0.166, or none
 * open): the records, as `liveRecords` keeps them. With one:
 *   - a thread is live while it's loaded and a Codex TUI runs in its folder (the daemon keeps a
 *     thread a while after its TUI quits); with `folders` unknown, while it's loaded
 *   - a record with a process (its hooks ran in the TUI: 0.153, or a TUI with its own app-server)
 *     is live as before, by its process; one without (its hooks ran in the daemon) only while its
 *     thread is live, so it leaves the list as its TUI quits, not when the daemon lets the thread go
 *   - a session in both: its record's process and rollout, the daemon's status unless the hook told
 *     one since (a held turn or permission the daemon still calls working), and one name (`nameOf`)
 */
export function mergeLive(records: CodexRecord[], times: ReadonlyMap<number, string>, open: Open, nameOf: (sessionId: string) => string): AgentSession[] {
  if (!open.threads) return liveRecords(records, times).map((r) => describe(r, nameOf(r.sessionId)));
  const live = new Map(open.threads.filter((t) => !open.folders || (open.folders.get(t.cwd) ?? 0) > 0).map((t) => [t.id, t]));
  const kept = liveRecords(records, times, (sessionId) => live.has(sessionId));
  const out: AgentSession[] = [];
  const seen = new Set<string>();
  for (const r of kept) {
    seen.add(r.sessionId);
    const t = live.get(r.sessionId);
    const s = describe(r, nameOf(r.sessionId));
    if (!t) out.push(s);
    else out.push({ ...s, status: (r.at ?? 0) > t.statusAt ? s.status : t.status, lastActiveAt: Math.max(s.lastActiveAt, t.updatedAt), ...(t.mode ? { mode: t.mode } : {}) });
  }
  for (const t of live.values()) if (!seen.has(t.id)) out.push(describeThread(t, nameOf(t.id)));
  return out;
}

/** A thread Codex's daemon has open, with no record of the hook's (none of its hooks has run yet), as a session. */
export function describeThread(t: DaemonThread, givenName: string): AgentSession {
  return {
    ...describe({ sessionId: t.id, cwd: t.cwd, status: t.status, at: t.updatedAt || t.createdAt, ...(t.path ? { transcriptPath: t.path } : {}) }, givenName),
    status: t.status,
    ...(t.mode ? { mode: t.mode } : {}),
  };
}

/** A record as a session (AgentSession). */
export function describe(r: CodexRecord, givenName: string): AgentSession {
  return {
    sessionId: r.sessionId,
    // Codex makes up no name: its folder's, as its terminal title shows it.
    name: basename(r.cwd) || r.cwd,
    givenName,
    title: "",
    cwd: r.cwd,
    kind: "interactive",
    status: r.status === "busy" || r.status === "blocked" ? r.status : "idle",
    lastActiveAt: lastActive(r),
    desktop: false,
    // Codex titles its terminal with its folder's name by default ("⠋ pixie" while it works), which
    // isn't enough to tell its window from another in that folder; its session's ID or name, where
    // `[tui] terminal_title` has it show "thread-id" or "thread-title", is.
    titles: [givenName, r.sessionId].filter(Boolean),
    ...(Number.isInteger(r.pid) ? { pid: r.pid } : {}),
    // Without a pid (its hooks ran in Codex's shared daemon: 0.166), its pane is found by its program and folder.
    program: "codex",
    agent: CODEX_AGENT,
  };
}

/** When its rollout last changed, else when the hook last wrote its record (ms epoch); 0 if unknown. */
function lastActive(r: CodexRecord): number {
  try {
    if (r.transcriptPath) return statSync(r.transcriptPath).mtimeMs;
  } catch {}
  return r.at ?? 0;
}

// ── Ending a session from outside its terminal (Agent.end) ──

/** Codex's executable, as `ps -o comm=` names it: the native `codex` (npm's node wrapper runs it, and passes signals on). */
const codexProgram = (comm: string) => comm.split("/").pop() === "codex";

export const reach: ProcessReach = {
  get dir() {
    return recordsDir();
  },
  ...systemReach,
};

/**
 * Ends a session nothing types /exit into (one outside Kiko's tmux), after the same checks as
 * Claude Code's (../process-check.ts): its record (the hook's) still this session's, its process
 * started when the record says, and Codex's. Then SIGTERM. Codex's TUI has no handler for it
 * (codex-rs/tui, 0.153.0): it ends at once, its conversation saved up to its last line (Codex
 * writes each as it goes), but its SessionEnd hook doesn't run and its terminal isn't put back
 * (`reset` there fixes it). In Kiko's tmux, /exit is typed instead, which does all of that.
 */
export async function endProcess(session: Endable, via: ProcessReach = reach): Promise<Signalled> {
  if (!Number.isInteger(session.pid)) return { sent: false, why: "its process isn't known" };
  const pid = session.pid!;
  const why = await checkSessionProcess(session, pid, via, { name: "Codex", is: codexProgram });
  if (why) return { sent: false, why };
  return terminate(pid, via);
}
