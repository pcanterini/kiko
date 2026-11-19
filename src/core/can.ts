// What Kiko can do to each session (agents/types.ts Can), in one place: the window's menus and
// its list (src/ui/nav.ts), the window's asks (src/ui/window-glue.ts), the router's description of each
// session (router.ts placeOf), and voice's stop and rename (app.ts) all read canDo, so a session is
// offered, described and acted on the same way everywhere. The phone reaches the same actions by
// voice, and answers what a session holds (a permission, its questions) whatever its agent.
import { agentOf } from "../agents/index.ts";
import type { Agent, Can } from "../agents/types.ts";
import type { Session } from "./sessions.ts";

export type { Can };

/**
 * Whether keys can go into its terminal for sure: Kiko's tmux, a Rex block found by its process, an
 * iTerm session found by its tty (both checked again before every key), or a Ghostty window found
 * by its title or as the only one in its folder (Ghostty has no process to find it by). Never a
 * Terminal tab (its place takes no keys: Terminal can't send one without a Return after it), Warp,
 * herdr or your own tmux: Kiko never types into your own servers.
 */
function keysReach(session: Session) {
  if (session.place?.via === "tmux") return true;
  if (session.place?.via === "rex" || session.place?.via === "iterm" || session.place?.via === "terminal") return session.place.keys;
  return session.place?.via === "ghostty" && session.place.keys && (session.mapping === "title" || session.mapping === "only");
}

/**
 * What can be done to a session: all of it in Kiko's tmux. Outside it, Rename and Interrupt where
 * keys reach it for sure (keysReach), typed in as there; then what its agent does itself, with no
 * terminal (Agent.can): Claude Code closes one whose process or job it knows, never the desktop
 * app's; T3 Code interrupts, renames and archives its threads through its server; Codex renames and
 * interrupts one its shared daemon has open, wherever it runs (Warp, iTerm too). Your words reach it
 * at any moment wherever a terminal adapter found it (`reply`).
 */
export function canDo(session: Session): Can {
  if (session.place?.via === "tmux") return { reply: true, interrupt: true, rename: true, close: true };
  const keys = keysReach(session);
  const its = agentOf(session);
  const own = its.can?.(session) ?? {};
  return {
    reply: Boolean(session.place),
    interrupt: keys || Boolean(own.interrupt && its.interrupt),
    rename: keys || Boolean(own.rename && its.rename),
    close: Boolean(own.close && its.end),
  };
}

/**
 * Whether a session's Interrupt or Rename is done by its agent itself (Agent.interrupt, Agent.rename),
 * not typed into its terminal: whenever its agent can, even where keys reach it too (Codex through
 * its daemon: nothing typed over a draft in its composer, no wait for it to be idle). Claude Code's
 * are always typed (it has neither).
 */
export function byAgent(session: Session, what: "interrupt" | "rename"): boolean {
  const its = agentOf(session);
  return Boolean(its[what] && its.can?.(session)[what]);
}

/**
 * Whether a session started in this agent can be named as it starts (the phone's New session sheet,
 * "start a session called …"): its own app or command names it (`launches`, `startCommand`), or, for
 * one that names it later (`namesLater`: renamed once listed, app/starting.ts started), it can be renamed: by
 * the agent itself (`rename`, as its `can` allows then) or by a command typed into its terminal.
 */
export function namedAtStart(its: Agent): boolean {
  if (its.launches || !its.namesLater) return true;
  return Boolean(its.rename) || Boolean(its.renameCommand("name"));
}
