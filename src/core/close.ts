// Closing a session gracefully (the Kiko window's Close, in a session's right-click menu and the
// Ctrl+Space menu): Claude Code is asked to exit, as if you typed /exit, so it saves the
// conversation and runs its SessionEnd hook; only then is its tmux session closed. In order:
//   1. mid-turn (or on a prompt), Escape first, as Interrupt does, and a moment for it to stop;
//   2. /exit typed through its terminal adapter's own checked path (tmux: the pane still runs that
//      session's process, in front, checked again as it pastes): never anywhere else;
//   3. up to END_MS for it to end: its SessionEnd hook, its process gone, or its pane's program no
//      longer Claude Code (a voice-opened pane runs `claude; exec $SHELL -l`: the shell is left;
//      or, one that has been in the Kiko window, the pane ends with it: tmux/index.ts afterProgram);
//   4. then tidied as before (`tidy`: the pane home, its own tmux session killed, the shell with it;
//      "gone" when the pane went with its program meanwhile).
// Escape or /exit not taken, or no end in time: straight to 4, the abrupt way, logged as
// `close_fallback` with why. `session_closed` says which way it went and how long it took.
import type { Signalled } from "../agents/types.ts";
import type { Place, Terminal, Typed } from "../terminals/types.ts";
import { alive } from "./alive.ts";
import { log } from "./log.ts";

/** How long to wait after Escape before typing /exit, how long for the session to end, how often to look. */
export const CLOSE_TIMES = { settleMs: 600, endMs: 5000, everyMs: 100 };

/** What tidying up after did: tmux's closeSession. */
export type Tidied = "closed" | "gone" | "not a session";

/** How a close went: `how` "exit" (it ended by itself, after /exit) or "killed" (`why`), and how long it took. */
export type Closed = { how: "exit" | "killed"; why?: string; interrupted: boolean; tidied: Tidied; ms: number };

/** The steps, for one session: wired by `closeSteps` (or a test's fakes). */
export type CloseSteps = {
  sessionId: string;
  /** Mid-turn now (or on a permission prompt): Escape first. */
  busy: boolean;
  /** Why not to type at all (still starting: its trust prompt, say), or null. */
  refuse: string | null;
  /** Escape into it. */
  interrupt(): Promise<Typed>;
  /** /exit into it, checked. */
  exit(): Promise<Typed>;
  /** Whether it has ended (and how), or null while it runs. */
  ended(): Promise<string | null>;
  /** The pane home, its tmux session killed (whatever runs there then). */
  tidy(): Promise<Tidied>;
  wait(ms: number): Promise<void>;
  now?(): number;
};

/** Closes a session: /exit first, its tmux session after; killed only when that didn't work. */
export async function closeGracefully(steps: CloseSteps, times = CLOSE_TIMES): Promise<Closed> {
  const now = steps.now ?? Date.now;
  const started = now();
  let interrupted = false;
  const why = await (async (): Promise<string | null> => {
    if (steps.refuse) return steps.refuse;
    if (steps.busy) {
      const pressed = await steps.interrupt();
      if (!pressed.sent) return `Escape didn't go in: ${pressed.why}`;
      interrupted = true;
      await steps.wait(times.settleMs);
    }
    const typed = await steps.exit();
    if (!typed.sent) return `/exit didn't go in: ${typed.why}`;
    for (;;) {
      const how = await steps.ended();
      if (how) {
        log("close_ended", { sessionId: steps.sessionId, by: how, ms: now() - started });
        return null;
      }
      if (now() - started >= times.endMs) return `it hadn't ended ${Math.round(times.endMs / 1000)} seconds after /exit`;
      await steps.wait(times.everyMs);
    }
  })();
  if (why) log("close_fallback", { sessionId: steps.sessionId, why });
  const tidied = await steps.tidy();
  const closed: Closed = { how: why ? "killed" : "exit", ...(why ? { why } : {}), interrupted, tidied, ms: now() - started };
  log("session_closed", { sessionId: steps.sessionId, how: closed.how, ms: closed.ms, ...(interrupted ? { interrupted } : {}), tidied });
  return closed;
}

// ── Closing a session outside Kiko's tmux ──
// Nothing types /exit into a session in Ghostty, Warp, iTerm or your own tmux (Kiko never types
// into your own servers), so its agent ends it from outside (Agent.end: Claude Code's SIGTERM, which
// it takes as /exit, or `claude stop` for a background job), after checking its process is still
// that session's. Then up to END_MS for it to go: its SessionEnd hook, or its processes gone. Still
// running after that is said, never killed harder; nothing to tidy (its terminal is the user's).

/** How long a session ended from outside has to go (its SessionEnd hooks can take a while), how often to look. */
export const END_TIMES = { endMs: 10_000, everyMs: 100 };

/** How a close from outside went: "ended", "refused" (nothing sent: `why`), or "running" still after END_MS. */
export type Ended = { how: "ended" | "refused" | "running"; why?: string; ms: number };

/** The steps for one session ended from outside: wired by `endSteps` (or a test's fakes). */
export type EndSteps = {
  sessionId: string;
  /** Why not to end it at all (the desktop app's, an agent that can't), or null. */
  refuse: string | null;
  /** Its agent ends it (Agent.end), checked first. */
  end(): Promise<Signalled>;
  /** Whether it has gone (and how), with the processes `end` named; null while it runs. */
  ended(pids: number[]): Promise<string | null>;
  wait(ms: number): Promise<void>;
  now?(): number;
};

/** Closes a session outside Kiko's tmux: its agent ends it, then a wait for it to go. */
export async function endFromOutside(steps: EndSteps, times = END_TIMES): Promise<Ended> {
  const now = steps.now ?? Date.now;
  const started = now();
  const signalled: Signalled = steps.refuse ? { sent: false, why: steps.refuse } : await steps.end();
  if (!signalled.sent) {
    log("close_refused", { sessionId: steps.sessionId, why: signalled.why });
    return { how: "refused", why: signalled.why, ms: now() - started };
  }
  for (;;) {
    const how = await steps.ended(signalled.pids);
    if (how) {
      const ms = now() - started;
      log("close_ended", { sessionId: steps.sessionId, by: how, ms });
      log("session_closed", { sessionId: steps.sessionId, how: "signal", ms });
      return { how: "ended", ms };
    }
    if (now() - started >= times.endMs) {
      const ms = now() - started;
      log("session_closed", { sessionId: steps.sessionId, how: "running", ms, pids: signalled.pids });
      return { how: "running", why: `it was still running ${Math.round(times.endMs / 1000)} seconds after`, ms };
    }
    await steps.wait(times.everyMs);
  }
}

/** The steps for a session outside Kiko's tmux (its IDs `ids`): `end` its agent's, its end told by its hook or its processes going. */
export function endSteps(
  session: { sessionId: string; ids: readonly string[]; refuse: string | null },
  via: { end(): Promise<Signalled>; ended?(ids: readonly string[], since: number): boolean; alive?(pid: number): boolean; wait?(ms: number): Promise<void> },
): EndSteps {
  const since = Date.now();
  const isAlive = via.alive ?? alive;
  const ended = via.ended ?? endedSince;
  return {
    sessionId: session.sessionId,
    refuse: session.refuse,
    end: via.end,
    async ended(pids) {
      if (ended(session.ids, since)) return "hook";
      // A background job with no process left: `claude stop` was all there was to it.
      if (!pids.length) return "stopped";
      return pids.some(isAlive) ? null : "process";
    },
    wait: via.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

// ── Told by the agent: sessions that ended (Claude Code's SessionEnd hook) ──

const endedAt = new Map<string, number>();
const ENDED_KEPT_MS = 60_000;

/** A session ended, as its agent says (agent.onSessionEnded). */
export function sessionEnded(sessionId: string, at = Date.now()) {
  for (const [id, when] of endedAt) if (at - when > ENDED_KEPT_MS) endedAt.delete(id);
  endedAt.set(sessionId, at);
}

/** Whether one of `ids` (a session's IDs: core/sessions.ts idsOf) was said to have ended at or after `since`. */
export const endedSince = (ids: readonly string[], since: number) => ids.some((id) => (endedAt.get(id) ?? -Infinity) >= since);

/** What `closeSteps` needs besides the session: its terminal adapter, the agent's keys and words, how to tidy up. */
type CloseVia = {
  terminal: Pick<Terminal, "type" | "key" | "program">;
  /** The agent's interrupt key ("escape") and exit command ("/exit"). */
  interruptKey: string;
  exitCommand: string;
  tidy(): Promise<Tidied>;
  /** Told what's about to be typed (the app notes its own typing). */
  typing?(text: string): void;
  ended?(ids: readonly string[], since: number): boolean;
  alive?(pid: number): boolean;
  wait?(ms: number): Promise<void>;
};

/** The steps for a session at `place` (its IDs `ids`), through its terminal adapter's checked typing. */
export function closeSteps(session: { sessionId: string; ids: readonly string[]; place: Place; busy: boolean; refuse?: string | null }, via: CloseVia): CloseSteps {
  const { place } = session;
  let since = Date.now();
  const isAlive = via.alive ?? alive;
  const ended = via.ended ?? endedSince;
  return {
    sessionId: session.sessionId,
    busy: session.busy,
    refuse: session.refuse ?? (via.terminal.key ? null : "its terminal takes no keys"),
    interrupt: () => via.terminal.key!(place, via.interruptKey),
    async exit() {
      since = Date.now();
      via.typing?.(via.exitCommand);
      return via.terminal.type(place, via.exitCommand);
    },
    async ended() {
      if (ended(session.ids, since)) return "hook";
      if (place.pid && !isAlive(place.pid)) return "process";
      const program = via.terminal.program ? await via.terminal.program(place.id).catch(() => "running" as const) : "running";
      return program === "running" ? null : `pane: ${program}`;
    },
    tidy: via.tidy,
    wait: via.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}
