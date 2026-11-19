// The terminal adapters this computer has, picked once at startup: the one place that names them.
// Core imports `terminals` and the helpers from here, and the shapes from ./types.ts.
import { agentMessages } from "./agent/index.ts";
import { ghostty } from "./ghostty/index.ts";
import { iterm } from "./iterm/index.ts";
import { rex } from "./rex/index.ts";
import { t3codeTerminal } from "./t3code/index.ts";
import { terminalApp } from "./terminal-app/index.ts";
import { tmux } from "./tmux/index.ts";
import type { Findable, Found, Place, Terminal } from "./types.ts";
import { COMMAND } from "../core/name.ts";

function pick(os: NodeJS.Platform): Terminal[] {
  switch (os) {
    // tmux first: a session in a pane of Kiko's tmux is reached that way whichever terminal app
    // shows the pane. Without tmux installed it finds nothing and opens nothing (`ready`), and
    // Ghostty does both as before. The Claude desktop app has none: Kiko never types into it
    // (that took the clipboard), so its sessions are reached only through their hooks. Between them,
    // the sessions whose agent takes a message itself (./agent/: OpenCode's), anywhere else they run.
    // Then Rex (./rex/), found by process as tmux finds a pane, and iTerm and Terminal (./iterm/,
    // ./terminal-app/), found by tty, before Ghostty's guess by title: an exact place first, and a
    // guess's "ambiguous" never stands over it.
    case "darwin":
      return [tmux, agentMessages, rex, iterm, terminalApp, ghostty];
    default:
      // Ghostty is Mac-only: it loads, and finds nothing or fails when used, as it always has. Rex
      // looks for its server's socket where Rex for Mac has it: elsewhere it's never listed.
      return [tmux, agentMessages, rex, ghostty];
  }
}

// T3 Code's threads first: reached through T3 only, whatever else is open in their folder.
export const terminals: Terminal[] = [t3codeTerminal, ...pick(process.platform)];

const NOWHERE: Found = { place: null, mapping: "none" };

/**
 * Where each session can be typed into: the first adapter (in `terminals` order) that can reach it.
 * One none can reach keeps "ambiguous" if any adapter saw several windows that could be it. An
 * adapter's "ambiguous" stands: a later one's guess never overrides it (tmux sees two sessions in
 * one pane; Ghostty's window for them would be that same pane, keys reaching either). So does
 * "agents": its window shows Claude Code's agents list, which says more than another's "none".
 */
export async function findPlaces(sessions: Promise<readonly Findable[]>, among = terminals): Promise<(sessionId: string) => Found> {
  const all = await Promise.all(among.map((t) => t.find(sessions)));
  const places = new Map<string, Found>();
  const stands = (f: Found | undefined) => f?.mapping === "ambiguous" || f?.mapping === "agents";
  for (const found of all) {
    for (const [id, f] of found) {
      const had = places.get(id);
      if (had?.place || stands(had)) continue;
      if (f.place || !had || stands(f)) places.set(id, f);
    }
  }
  return (sessionId) => places.get(sessionId) ?? NOWHERE;
}

/** The adapter a place belongs to. */
export function terminalOf(place: Place): Terminal | null {
  return terminals.find((t) => t.id === place.via) ?? null;
}

/** Adapters that open new sessions only when every other couldn't: iTerm, then Terminal (Ghostty stays the default). */
const OPEN_LAST = [iterm.id, terminalApp.id];

/**
 * The adapters new sessions open in, in order: those that open windows and can now (tmux:
 * installed), iTerm and Terminal last (OPEN_LAST). The first is used; the next only when it
 * couldn't start anything.
 */
export function openers(among = terminals): Array<Terminal & Required<Pick<Terminal, "open">>> {
  const can = among.filter((t) => t.open && (t.ready?.() ?? true)) as Array<Terminal & Required<Pick<Terminal, "open">>>;
  const last = (t: Terminal) => OPEN_LAST.indexOf(t.id);
  return [...can.filter((t) => last(t) < 0), ...can.filter((t) => last(t) >= 0).sort((a, b) => last(a) - last(b))];
}

/**
 * How to start a session Kiko can always type into, said when it can't reach one: "kiko
 * claude" (src/cli.ts; "kiko codex" for a Codex session: `program`) when tmux is installed; null when it isn't.
 */
export function reachableStart(among = terminals, program = "claude"): string | null {
  return among.some((t) => t.id === tmux.id && (t.ready?.() ?? true)) ? `${COMMAND} ${program}` : null;
}
