// An agent's processes, looked at: which run a program (`pgrep -x`: pids only), and for those, `ps`
// (the fields asked for: its executable, terminal, start) and `lsof -a -d cwd` (its folder). Never
// a process's arguments or environment. What's shared by the adapters that find their TUIs this way
// (Codex's: ./codex/processes.ts; OpenCode's: ./opencode/processes.ts), each keeping only its own
// rule for which pids are its TUIs. Signals and the checks before one: ./process-check.ts.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { alive } from "../core/alive.ts";

const run = promisify(execFile);

/** `ps` and `lsof` in the C locale, times in UTC: what the parsers here read. */
const C_UTC = () => ({ ...process.env, LC_ALL: "C", TZ: "UTC" });

/** The pids of the processes whose executable is `name` (`pgrep -x`); null when they couldn't be looked at. */
export async function pidsOf(name: string): Promise<number[] | null> {
  try {
    const { stdout } = await run("pgrep", ["-x", name]);
    return stdout
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch (err: any) {
    // pgrep exits 1 when nothing matches.
    if (err?.code === 1) return [];
    return null;
  }
}

/**
 * `ps -o <fields>` and `lsof -a -d cwd -Fpn` for `pids`, at once: what each printed (a process gone
 * meanwhile makes either exit 1; what it printed for the rest is still right).
 */
export async function psAndCwds(pids: readonly number[], fields: string): Promise<{ ps: string; lsof: string }> {
  const env = C_UTC();
  const [ps, lsof] = await Promise.all([
    run("ps", ["-o", fields, "-p", pids.join(",")], { env }).catch((err) => ({ stdout: String(err?.stdout ?? "") })),
    run("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], { env }).catch((err) => ({ stdout: String(err?.stdout ?? "") })),
  ]);
  return { ps: ps.stdout, lsof: lsof.stdout };
}

/** Lines of `ps -o pid=,<one field>=` (comm, lstart…): pid → that field, as printed. */
export function parsePidField(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** `ps -o pid=,lstart= -p <pids>` (C and UTC): pid → when it started, for those still running; empty when none is. */
export async function startTimes(pids: readonly number[]): Promise<Map<number, string>> {
  const times = new Map<number, string>();
  if (!pids.length) return times;
  try {
    const { stdout } = await run("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: C_UTC() });
    for (const [pid, lstart] of parsePidField(stdout)) times.set(pid, lstart.replace(/\s+/g, " "));
  } catch {
    // ps exits 1 when none of them runs any more
  }
  return times;
}

/** `ps -o <field>= -p <pid>` (C and UTC), trimmed; "" when the process is gone. */
export const psField = (pid: number, field: string): Promise<string> =>
  run("ps", ["-o", `${field}=`, "-p", String(pid)], { env: C_UTC() }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );

/** `lsof -a -d cwd -Fpn`'s fields: pid → its folder. */
export function parseCwds(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** A line of `ps -o pid=,tty=,lstart=,comm=` (C locale, UTC). */
export type PsRow = { pid: number; tty: string; lstart: string; comm: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps`'s lstart ("Thu Oct 30 00:45:12 2026", UTC) in ms; 0 when it can't be read. */
export function lstartMs(lstart: string): number {
  const m = lstart.trim().match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  if (!m) return 0;
  const month = MONTHS.indexOf(m[1]);
  return month < 0 ? 0 : Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** `ps -o pid=,tty=,lstart=,comm=`'s lines. */
export function parsePs(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (m) rows.push({ pid: Number(m[1]), tty: m[2], lstart: m[3].replace(/\s+/g, " "), comm: m[4] });
  }
  return rows;
}

/**
 * Whether a process still runs, asked without running anything (signal 0): for a TUI found at the
 * last look, between looks. One that isn't ours to signal still runs.
 */
export const stillRuns = alive;
