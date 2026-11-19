// The processes ./index.ts looks at, for iTerm's and Terminal's adapters: `ps` for the fields asked
// for only (pid, group, terminal, state, executable: never a process's arguments or environment),
// `lsof -a -d cwd` for a folder, `pgrep -xq` for whether an app runs (no Apple Events). In the C
// locale, as ../../agents/processes.ts runs them.
import { execFile } from "node:child_process";
import { parseCwds } from "../../agents/processes.ts";
import type { Proc } from "./index.ts";

const C = () => ({ ...process.env, LC_ALL: "C" });

/** `cmd args`' output; what it printed even when it exited non-zero (ps and lsof exit 1 when a process asked for is gone). */
function output(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { env: C(), timeout: 5000, maxBuffer: 8 << 20 }, (err, stdout) => {
      // An exit code (a number) is ps's or lsof's own; anything else (not found, killed): failed.
      if (err && !stdout && typeof (err as { code?: unknown }).code !== "number") reject(err);
      else resolve(String(stdout ?? ""));
    }),
  );
}

/** A tty as `ps` prints it ("ttys003"), as the apps say it ("/dev/ttys003"); "" for none ("??"). */
export const devOf = (tty: string) => (/^ttys\d+$/.test(tty) ? `/dev/${tty}` : "");

/** `ps -o pid=,tty=` read back: pid → its tty ("/dev/ttys003"), for those on one. */
export function parseTtys(out: string): Map<number, string> {
  const ttys = new Map<number, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*$/);
    const tty = m ? devOf(m[2]) : "";
    if (m && tty) ttys.set(Number(m[1]), tty);
  }
  return ttys;
}

/** `ps -o pid=,pgid=,tpgid=,stat=,tty=,comm=` read back (an executable's path may have spaces: the rest of the line). */
export function parseProcs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (m) procs.push({ pid: +m[1], pgid: +m[2], tpgid: +m[3], stat: m[4], tty: devOf(m[5]), comm: m[6] });
  }
  return procs;
}

const PROC_FIELDS = "pid=,pgid=,tpgid=,stat=,tty=,comm=";
const int = (pids: readonly number[]) => pids.filter((p) => Number.isInteger(p) && p > 0);

/** Each of `pids`' tty: those still running, on one. */
export async function ttysOf(pids: readonly number[]): Promise<Map<number, string>> {
  const ok = int(pids);
  return ok.length ? parseTtys(await output("ps", ["-o", "pid=,tty=", "-p", ok.join(",")])) : new Map();
}

/** One process, looked at; null when it has ended. */
export async function proc(pid: number): Promise<Proc | null> {
  if (!int([pid]).length) return null;
  return parseProcs(await output("ps", ["-o", PROC_FIELDS, "-p", String(pid)])).find((p) => p.pid === pid) ?? null;
}

/** The processes on these ttys ("/dev/ttys003"). */
export async function onTtys(ttys: readonly string[]): Promise<Proc[]> {
  const names = ttys.map((t) => t.replace(/^\/dev\//, "")).filter((t) => /^ttys\d+$/.test(t));
  return names.length ? parseProcs(await output("ps", ["-o", PROC_FIELDS, "-t", names.join(",")])) : [];
}

/** Each of `pids`' folder. */
export async function cwds(pids: readonly number[]): Promise<Map<number, string>> {
  const ok = int(pids);
  return ok.length ? parseCwds(await output("lsof", ["-a", "-d", "cwd", "-p", ok.join(","), "-Fpn"])) : new Map();
}

/**
 * Whether a process named `name` runs (`pgrep -xq`: its exit code only), asked at most every
 * `maxAgeMs`: the listing asks every few seconds.
 */
export function runningCheck(name: string, maxAgeMs = 5000): () => Promise<boolean> {
  let last: { at: number; is: Promise<boolean> } | null = null;
  return () => {
    if (!last || Date.now() - last.at > maxAgeMs) {
      last = { at: Date.now(), is: new Promise((resolve) => execFile("pgrep", ["-xq", name], { timeout: 5000 }, (err) => resolve(!err))) };
    }
    return last.is;
  };
}
