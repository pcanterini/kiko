// How your words reach a session once it stops waiting for a reply: typed in by a terminal adapter
// (src/terminals/: its pane in Kiko's tmux, its Ghostty terminal), or not at all, because it
// runs in the background, in the Claude desktop app (never typed into: that took the clipboard),
// or in a terminal no adapter can find. Those only take a reply while they wait; one started with
// `kiko claude` (Kiko's tmux) can always be reached, and says so when it's worth saying.
import { agentOf, mainAgent } from "../agents/index.ts";
import { reachableStart } from "../terminals/index.ts";
import { sessionName, spoken, type Session } from "./sessions.ts";

export type Reach = "terminal" | "desktop" | "background" | "elsewhere";

/** A session that isn't listed counts as typeable, as before. `desktop`: its agent says it runs in the desktop app. */
export function reachOf(session: Session | undefined, desktop = false): Reach {
  if (desktop || session?.desktop) return "desktop";
  if (!session || session.place) return "terminal";
  return session.kind === "background" ? "background" : "elsewhere";
}

/** Shown when a finished session's window runs out. `typing`: voice may still send to it after. */
export function windowClosedNote(reach: Reach, typing = true) {
  if (reach === "terminal") {
    return `no reply; the session stopped. ${typing ? "Hold the key to reply anyway" : "Reply to it in its window"}`;
  }
  return `no reply; the session stopped${reach === "background" ? "" : ". Reply to it in its window"}`;
}

/**
 * Said when the app can't type into a session (`doing` is "stop it", "rename it", or null for your
 * words). `spoke`: it spoke since the app started, so it had a reply window. `start`: how to start
 * one it can always reach ("kiko claude", when tmux is installed), said for a terminal it can't
 * find, and for your words to a desktop app session: those are said just as for that terminal.
 */
export function cantReach(session: Session, doing: string | null, spoke: boolean, start = reachableStart(undefined, startProgram(session))) {
  const name = spoken(sessionName(session));
  const reach = reachOf(session);
  const next = start && (reach === "elsewhere" || (reach === "desktop" && !doing)) ? ` Start it with ${start} next time and I always can.` : "";
  // Its terminal shows Claude Code's agents list (parked with ←): typed there, words would start a
  // new session. Open the session there and it can be reached again.
  if (session.mapping === "agents") {
    return doing
      ? `${name}'s terminal is showing Claude Code's agents list, so I can't ${doing} from here. Open ${name} there first.`
      : `I couldn't reach ${name}: its terminal is showing Claude Code's agents list, so I didn't type that in. Open ${name} there first.`;
  }
  // Another agent's session in its own app its agent can't do this to (core/can.ts): only words reach it, through that app.
  if (doing && agentOf(session).ownApp) return `${name} is in ${agentOf(session).name}, so I can't ${doing} from here.`;
  if (doing) {
    return reach === "desktop" ? `${name} is in the desktop app, so I can't ${doing} from here.` : `I can't reach ${name}'s terminal to ${doing}.${next}`;
  }
  if (reach === "background") return `${name} runs in the background, so I can only reply right after it speaks.`;
  if (session.mapping === "ambiguous") return `I couldn't reach ${name}: I can't tell which terminal is ${name}, so I didn't type that in.${next}`;
  return spoke ? `Its reply window closed. Reply to ${name} in its window.${next}` : `I can only reply to ${name} right after it speaks. Reply to it in its window.${next}`;
}

/** Said when a terminal adapter found the session but wouldn't type (`doing`, as in cantReach), with why: "its process has ended". */
export function didntType(session: Session, doing: string | null, why: string) {
  const name = spoken(sessionName(session));
  return doing ? `I couldn't ${doing.replace(/ it$/, ` ${name}`)}: ${why}.` : `I didn't type that into ${name}: ${why}.`;
}

/** What `kiko …` starts in Kiko's tmux for a session of this one's agent: "claude", or "codex" for a Codex session. */
function startProgram(session: Session): string {
  const its = agentOf(session);
  return its === mainAgent || !its.starts ? "claude" : its.startCommand({ prompt: "", name: "" }).program;
}
