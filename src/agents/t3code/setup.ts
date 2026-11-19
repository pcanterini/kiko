// T3 Code's setup: nothing to add. Kiko connects to its local server by itself whenever it runs
// (./client.ts). Installed when its CLI is in its home (KIKO_T3_HOME, else ~/.t3: bin/t3). Setup
// and the first-run card list it with the others, ticked: ticked changes nothing on disk ("yes" in
// agentAnswers, so it isn't asked again); unticked is a "no", and Kiko leaves it alone (./index.ts
// doesn't connect, so none of its threads are listed) until settings → Agents turns it on again.
// Inside the app: connected, or not running, by Kiko's connection to it (`running`, set by
// ./index.ts). Before that connection is started (setup, the CLI), by T3
// itself: the server it says it started (userdata/server-runtime.json, only its `pid`) still alive.
// Never a process's command line. Imports nothing that loads .env or writes logs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alive } from "../../core/alive.ts";
import { envVar, NAME } from "../../core/name.ts";
import { agentRefused } from "../../core/settings.ts";
import type { AgentSetup } from "../types.ts";

/** T3 Code's id, as its adapter's (./mapping.ts T3_AGENT). */
const T3_ID = "t3code";

/** T3 Code's home: KIKO_T3_HOME, else ~/.t3. */
const t3Home = () => envVar("T3_HOME") || join(homedir(), ".t3");

/**
 * Whether T3 Code runs now, by the server it says it started (`<home>/userdata/server-runtime.json`,
 * only its `pid` read) still being alive: false when there's no such file or that process is gone;
 * null when it can't be told (a file that isn't what T3 writes).
 */
export function t3Running(home = t3Home(), isAlive: (pid: number) => boolean = alive): boolean | null {
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(join(home, "userdata", "server-runtime.json"), "utf8"))?.pid;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  return isAlive(pid);
}

export const t3codeSetup: AgentSetup & { running: (() => boolean | null) | null } = {
  id: T3_ID,
  name: "T3 Code",
  about: `Nothing to set up: ${NAME} connects to T3 Code by itself while it's running, and lists its threads.`,
  file: () => "",
  installed: () => existsSync(join(t3Home(), "bin", "t3")),
  // Kiko's connection to it: up or not; null (or none set) while it isn't kept, as in setup.
  running: null,
  status() {
    if (!t3codeSetup.installed()) return { state: "not installed", detail: "not found in ~/.t3" };
    if (agentRefused(T3_ID)) return { state: "not connected", detail: `off: ${NAME} leaves it alone` };
    const connected = t3codeSetup.running?.() ?? null;
    if (connected === true) return { state: "automatic", detail: "connected" };
    if (connected === false) return { state: "automatic", detail: "not running" };
    if (t3Running()) return { state: "automatic", detail: `running: ${NAME} connects when it starts` };
    return { state: "automatic", detail: `nothing to add: ${NAME} connects while it's running` };
  },
};
