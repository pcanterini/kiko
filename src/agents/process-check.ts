// The guards before Kiko signals a coding agent's process to end a session outside its tmux
// (Agent.end): Claude Code's (claude-code/sessions.ts endProcess), Codex's (codex/sessions.ts) and
// OpenCode's (opencode/index.ts, whose TUI's start is noted as it's listed: `checkProcess`) all go
// through here. A session's process is signalled only when its record (the agent's own,
// or the one Codex's hook keeps for Kiko) is still that session's, the process started when the
// record says (a pid taken again by another process is never signalled), and it's the agent's
// program. `ps` is asked for the start time and the executable only, never a command line.
import { readFileSync } from "node:fs";
import { psField } from "./processes.ts";
import type { Endable, Signalled } from "./types.ts";

/** What the guards reach: the records' folder, `ps` and signals (a test's own, in tests). */
export type ProcessReach = {
  /** The folder of process records, one `<pid>.json` each. */
  dir: string;
  /** `ps -o <field>= -p <pid>` in C and UTC (never its command line); "" when the process is gone. */
  ps(pid: number, field: "comm" | "lstart"): Promise<string>;
  kill(pid: number, signal: NodeJS.Signals): void;
};

/** The real `ps` and signals: each agent's reach (with its records' folder, and Claude Code's `claude stop`). */
export const systemReach: Pick<ProcessReach, "ps" | "kill"> = {
  ps: psField,
  kill: (pid, signal) => process.kill(pid, signal),
};

/** A process record as the guards read it: whose session, and when its process started. */
type ProcessRecord = { sessionId?: unknown; procStart?: unknown } & Record<string, unknown>;

/** Process `pid`'s record in `dir`; null when there's none, or it isn't an object. */
export function recordOf(dir: string, pid: number): ProcessRecord | null {
  try {
    const record = JSON.parse(readFileSync(`${dir}/${pid}.json`, "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Why not to signal process `pid` for `session`, checked right before: its record must be this
 * session's (or an alias's), `refuse` (the agent's own reasons: a headless run, the desktop app)
 * must have nothing against it, its `procStart` must be the process's own start, and the process
 * the agent's program (`program.is`, on `ps -o comm=`). Null when all hold.
 */
export async function checkSessionProcess(
  session: Endable,
  pid: number,
  via: ProcessReach,
  program: { name: string; is(comm: string): boolean },
  refuse: (record: ProcessRecord) => string | null = () => null,
): Promise<string | null> {
  const record = recordOf(via.dir, pid);
  if (!record) return "its process record is gone";
  if (typeof record.sessionId !== "string" || ![session.sessionId, ...(session.aliases ?? [])].includes(record.sessionId)) return "its process runs another session now";
  const why = refuse(record);
  if (why) return why;
  return checkProcess(pid, record.procStart, via, program);
}

/**
 * Why not to signal process `pid`, whose start (`ps -o lstart=`) was noted as `procStart`: it has
 * ended, its pid belongs to another process now, or it isn't the agent's program. Null when it's
 * still the one. For an agent that notes its process's start itself (no record file: OpenCode's TUI).
 */
export async function checkProcess(pid: number, procStart: unknown, via: Pick<ProcessReach, "ps">, program: { name: string; is(comm: string): boolean }): Promise<string | null> {
  const started = squeeze(await via.ps(pid, "lstart"));
  if (!started) return "its process has ended";
  if (typeof procStart !== "string" || squeeze(procStart) !== started) return "its process ID belongs to another process now";
  const comm = (await via.ps(pid, "comm")).trim();
  if (!program.is(comm)) return `its process isn't ${program.name} (${comm.split("/").pop() || "unknown"})`;
  return null;
}

/**
 * A signal to `pid` (SIGTERM, or the one its program quits cleanly on: OpenCode's TUI, SIGHUP),
 * checked already: sent (gone meanwhile counts: it has ended all the same), or why not.
 */
export function terminate(pid: number, via: Pick<ProcessReach, "kill">, signal: NodeJS.Signals = "SIGTERM"): Signalled {
  try {
    via.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") return { sent: false, why: code === "EPERM" ? "I'm not allowed to signal its process" : (err as Error).message };
  }
  return { sent: true, pids: [pid] };
}
