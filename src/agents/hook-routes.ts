// One hooks socket for every agent whose hooks are command hooks (claude-code/hooks.ts HookServer
// listens on it; hooks/claude-code-hook.mjs and hooks/codex-hook.mjs connect to it). A hook that marks
// its line with an agent (`"agent": "codex"`) is handed here whole, with its connection, to the
// adapter that took that agent's route: it answers on the connection as Claude Code's do, or
// closes it. Nothing here knows any agent. A line marked for an agent no adapter took is let go
// (the hook exits, and its agent goes on as it would without Kiko).
import type { Socket } from "node:net";

/** What takes an agent's hook lines: the line, parsed, and its connection (to answer on, or close). */
type HookRoute = (event: Record<string, unknown>, conn: Socket) => void;

const routes = new Map<string, HookRoute>();

/** `agent`'s hook lines come to `take` from now on. */
export function takeHooks(agent: string, take: HookRoute) {
  routes.set(agent, take);
}

/** Who takes a line marked for `agent`; null when no adapter does. */
export function hookRoute(agent: string): HookRoute | null {
  return routes.get(agent) ?? null;
}
