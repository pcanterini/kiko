// OpenCode's setup: no hooks. OpenCode 2's TUIs are clients of one background service with an HTTP
// API and an event stream (./service.ts), which is all Kiko needs to hear its sessions and answer
// them, so nothing of OpenCode's is written: no config, no plugin, nothing to trust or review in it.
// Connecting it is your yes to Kiko reading the service's password (from its own 0600 file) and
// listening to it: kept in Kiko's settings (linkedAgents), as are Disconnect (Kiko stops
// listening) and Repair (nothing to repair: connecting again is enough). Not connected, Kiko never
// reads that file. Imports nothing that loads .env or writes logs.
//
// Health: OpenCode older than 2.0 has no service (its sessions were their own servers then), and
// a service that doesn't take its own password is said (`problem`, set by ./index.ts while it runs;
// the CLI, which doesn't connect, can't tell).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { NAME } from "../../core/name.ts";
import { agentLinked, linkAgent, SETTINGS_FILE } from "../../core/settings.ts";
import type { AgentSetup, Changed } from "../types.ts";
import { newerThan } from "../version.ts";
import { readService } from "./service.ts";
import { OPENCODE_AGENT } from "./sessions.ts";

/** Where `opencode` is on your PATH (or its installer's ~/.opencode/bin); null when it isn't installed. */
export function openCodeOnPath(path = process.env.PATH ?? ""): string | null {
  const found = path
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "opencode"))
    .find((at) => existsSync(at));
  if (found) return found;
  const installer = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(installer) ? installer : null;
}

// This adapter was checked against OpenCode 2.0.0 to 2.0.32 (its source and the real binary's API).

/** What's said where hooks would be (AgentSetup.linkWords). */
const LISTENS = `${NAME} listens to OpenCode's background service`;

const changed = (on: boolean, did: boolean): Changed => ({ file: SETTINGS_FILE, events: did ? [on ? "listen" : "stop listening"] : [], backup: null });

export const opencodeSetup: AgentSetup & { problem: (() => string | null) | null } = {
  id: OPENCODE_AGENT,
  name: "OpenCode",
  starts: true,
  about: `OpenCode's sessions reach ${NAME} through its background service, which every OpenCode window uses. Needs OpenCode 2.0 or newer.`,
  // Nothing of OpenCode's: the yes is in Kiko's own settings.
  file: () => "",
  installed: () => Boolean(openCodeOnPath()),
  problem: null,
  status() {
    if (!opencodeSetup.installed()) return { state: "not installed", detail: "opencode isn't on your PATH" };
    if (!agentLinked(OPENCODE_AGENT)) return { state: "not connected", detail: `lets ${NAME} listen to its background service` };
    return { state: "connected", detail: "listening to its background service" };
  },
  health() {
    // Its running service's version, from its own file (read only once you've connected it).
    const version = readService()?.version ?? "";
    if (version && !newerThan(version, "1.999.999")) return `OpenCode ${version} has no background service: update it (opencode upgrade)`;
    return opencodeSetup.problem?.() ?? null;
  },
  plan: () => ({ command: "", events: agentLinked(OPENCODE_AGENT) ? [] : ["listen"], repoint: 0 }),
  connect: () => changed(true, linkAgent(OPENCODE_AGENT, true)),
  disconnect: () => changed(false, linkAgent(OPENCODE_AGENT, false)),
  linkWords: LISTENS,
  afterConnect: "Open any OpenCode session and it's listed; nothing to restart.",
  beforeConnect: [`Nothing of OpenCode's is changed, and there's nothing to trust in it: ${NAME} only reads its background service's password, from the service's own file, to listen to it.`],
  word: "opencode",
};
