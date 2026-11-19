// Sessions whose agent takes your words itself, as a new message through its own server
// (Agent.message: OpenCode's background service), wherever they run: another TUI's window, a
// terminal app none of the others reach, or a tab not in front. Asked after tmux (a session in
// Kiko's tmux is typed into its pane, and shown in the window) and before Ghostty (nothing is
// guessed by its title for one that can take a message). No keys (Interrupt and Rename go through
// the agent too: core/can.ts byAgent), no windows, no clipboard. Only sessions whose agent says it
// can (`Agent.can`'s reply) are found here.
import { agentOf } from "../../agents/index.ts";
import type { Found, Terminal } from "../types.ts";

/** A place's handle: the session's agent and its ID, so `type` knows whose server to send through. */
const handleOf = (agent: string, sessionId: string) => `${agent}:${sessionId}`;

export const agentMessages: Terminal = {
  id: "agent",
  label: "as a message",
  async find(sessions) {
    const found = new Map<string, Found>();
    for (const s of await sessions) {
      const its = agentOf(s);
      if (!its.message || !its.can?.({ ...s, name: "", givenName: "", title: "", status: "", lastActiveAt: 0 }).reply) continue;
      found.set(s.sessionId, { place: { via: agentMessages.id, id: handleOf(its.id, s.sessionId), keys: false }, mapping: "none" });
    }
    return found;
  },
  async type(place, text) {
    const cut = place.id.indexOf(":");
    const its = agentOf({ sessionId: place.id.slice(cut + 1), agent: place.id.slice(0, cut) });
    if (cut < 1 || !its.message) return { sent: false, why: "its agent doesn't take messages" };
    return its.message({ sessionId: place.id.slice(cut + 1), cwd: "" }, text);
  },
};
