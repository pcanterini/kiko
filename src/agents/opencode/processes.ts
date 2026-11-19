// The OpenCode TUIs running now: what tells a session that's open in a terminal from the hundreds
// the background service keeps (it holds every session ever made, and doesn't say which a TUI
// shows). Read with `pgrep -x opencode` (pids only), `ps -o pid=,tty=,lstart=,comm=` (each one's
// terminal, start and executable) and `lsof -a -d cwd` (each one's folder): never a process's
// arguments or environment. The service is an `opencode` too: left out by its pid (its file's) and
// because it has no terminal (it runs detached); so is any other `opencode` with none (`opencode
// serve`). A one-shot `opencode run` in a terminal looks like a TUI while it runs: it's listed only
// if it makes a session in its folder, which is then one you started. The looking and its parsers
// are shared (../processes.ts); which of them are TUIs is OpenCode's own rule (tuisOf).
import { lstartMs, parseCwds, parsePs, pidsOf, psAndCwds, type PsRow } from "../processes.ts";

/** An OpenCode TUI: its process, its folder, and when it started (as `ps` says it, and in ms). */
export type Tui = { pid: number; cwd: string; procStart: string; startedAt: number };

/** OpenCode's executable, as `ps -o comm=` names it. */
export const openCodeProgram = (comm: string) => comm.split("/").pop() === "opencode";

/**
 * The TUIs among `opencode` processes: those with a terminal that aren't the service (`service`: its
 * pid), each with its folder (`cwds`: pid → folder; one without is left out).
 */
export function tuisOf(rows: readonly PsRow[], cwds: ReadonlyMap<number, string>, service: number | null): Tui[] {
  const out: Tui[] = [];
  for (const r of rows) {
    if (r.pid === service || !openCodeProgram(r.comm) || r.tty === "??" || r.tty === "-" || !r.tty) continue;
    const cwd = cwds.get(r.pid);
    if (cwd) out.push({ pid: r.pid, cwd, procStart: r.lstart, startedAt: lstartMs(r.lstart) });
  }
  return out;
}

/** The OpenCode TUIs running now; null when they couldn't be looked at. */
export async function openCodeTuis(service: number | null): Promise<Tui[] | null> {
  const found = await pidsOf("opencode");
  if (!found) return null;
  const pids = found.filter((p) => p !== service);
  if (!pids.length) return [];
  try {
    const { ps, lsof } = await psAndCwds(pids, "pid=,tty=,lstart=,comm=");
    return tuisOf(parsePs(ps), parseCwds(lsof), service);
  } catch {
    return null;
  }
}
