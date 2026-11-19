// T3 Code's threads: where your words reach one at any moment, as a new message in it
// (orchestration.dispatchCommand, message.dispatch, through the agent's connection:
// src/agents/t3code/). No keys (nothing to press Escape in), no new windows, and no clipboard.
// Only T3's own threads are found here; it's asked first, so no terminal
// adapter guesses a Ghostty window in the same folder for one.
import { t3 } from "../../agents/t3code/index.ts";
import { T3_AGENT, threadIdOf } from "../../agents/t3code/mapping.ts";
import type { Found, Terminal } from "../types.ts";

export const t3codeTerminal: Terminal = {
  id: "t3code",
  label: "T3 Code",
  async find(sessions) {
    const found = new Map<string, Found>();
    for (const session of await sessions) {
      const threadId = session.agent === T3_AGENT ? threadIdOf(session.sessionId) : null;
      if (threadId) found.set(session.sessionId, { place: { via: t3codeTerminal.id, id: threadId, keys: false }, mapping: "none" });
    }
    return found;
  },
  async type(place, text) {
    return t3.send(place.id, text);
  },
};
