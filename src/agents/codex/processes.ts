// The folders Codex's TUI runs in now: what tells a thread Codex's daemon still has open (./daemon.ts)
// from one whose TUI has quit, which the daemon keeps loaded for a while (60s by default) and
// doesn't say. Read with `pgrep -x codex` (pids only), `ps -o pid=,comm=` (each one's executable)
// and `lsof -a -d cwd` (each one's folder): never a process's arguments or environment. The daemon
// is a `codex` too (started in the folder of the TUI that started it), so it's left out: the pids
// in $CODEX_HOME/app-server-daemon/*.pid (Codex's own records of it and its updater), and any
// executable from its package ($CODEX_HOME/packages/app-server-daemon/…). The looking and its
// parsers are shared (../processes.ts); which of them are TUIs is Codex's own rule (tuiFoldersOf).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCwds, parsePidField, pidsOf, psAndCwds } from "../processes.ts";

/** The pids Codex's daemon records for itself and its updater ($CODEX_HOME/app-server-daemon/*.pid: JSON with `pid`). */
export function daemonPids(home: string): Set<number> {
  const pids = new Set<number>();
  const dir = join(home, "app-server-daemon");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch {
    return pids;
  }
  for (const f of files) {
    try {
      const pid = JSON.parse(readFileSync(join(dir, f), "utf8"))?.pid;
      if (Number.isInteger(pid)) pids.add(pid);
    } catch {}
  }
  return pids;
}

/** Whether an executable is Codex's daemon's own (its package), not a TUI. */
const daemonProgram = (comm: string) => /\/app-server-daemon\//.test(comm);

/**
 * The TUIs among `codex` processes: each one's folder, how many in each. `comms`: pid → executable;
 * `cwds`: pid → folder; `daemon`: the daemon's own pids.
 */
export function tuiFoldersOf(comms: ReadonlyMap<number, string>, cwds: ReadonlyMap<number, string>, daemon: ReadonlySet<number>): Map<string, number> {
  const folders = new Map<string, number>();
  for (const [pid, comm] of comms) {
    if (daemon.has(pid) || daemonProgram(comm) || comm.split("/").pop() !== "codex") continue;
    const cwd = cwds.get(pid);
    if (cwd) folders.set(cwd, (folders.get(cwd) ?? 0) + 1);
  }
  return folders;
}

/** The folders a Codex TUI runs in now, how many in each; null when they couldn't be looked at. */
export async function tuiFolders(home: string): Promise<Map<string, number> | null> {
  const pids = await pidsOf("codex");
  if (!pids) return null;
  if (!pids.length) return new Map();
  try {
    const { ps, lsof } = await psAndCwds(pids, "pid=,comm=");
    return tuiFoldersOf(parsePidField(ps), parseCwds(lsof), daemonPids(home));
  } catch {
    return null;
  }
}
