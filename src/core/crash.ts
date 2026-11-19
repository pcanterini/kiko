// What the app does with a throw or a rejection nothing caught (process "uncaughtException" and
// "unhandledRejection", installed by app.ts): before 2026-11-12 either one ended the app, its stack
// in the pane and nowhere else, and start.ts doesn't start a crashed app again. Now each is logged (`crash_caught`: its message and stack,
// with the keys taken out; never the environment) and the app keeps running, unless going on isn't
// safe (`fatalWhy`), when it stops as on a quit, with exit code 1.
// Imports nothing that loads .env or writes logs (the app passes its `log`), so the tests can load it.
import { redact } from "../agents/secret.ts";

export type CrashKind = "exception" | "rejection";

/**
 * More than this many in FLOOD_MS: the same failure over and over (a timer, a socket's handler).
 * The app keeps running, but their stacks aren't logged again until it calms down, so the log
 * doesn't fill with them.
 */
export const FLOOD_COUNT = 10;
export const FLOOD_MS = 60_000;
/** A stack longer than this is cut (a log line each, and some stacks are thousands of frames). */
const STACK_MAX = 4000;

export type CrashDeps = {
  log: (event: string, data: Record<string, unknown>) => void;
  /**
   * Stops the app, only when going on isn't safe: app.ts prints `line` where the pane keeps it
   * (core/running.ts afterApp "leave"), as for a failed start, then shutdown(1).
   */
  stop: (line: string) => void;
  /** The app is already stopping (app.ts shutdown ran). */
  stopping: () => boolean;
  /** The values to take out of what's logged: the API keys the app holds. */
  secrets?: () => Array<string | null | undefined>;
  /** Where it's said when the log can't take it: stderr. */
  say?: (line: string) => void;
  now?: () => number;
};

/** An error's name, message and stack (or what was thrown, as text), the secrets taken out. */
export function crashFields(err: unknown, secrets: Array<string | null | undefined> = []): Record<string, unknown> {
  const clean = (text: string) => redact(text, ...secrets).replace(/\b(Bearer|Token)\s+[\w.~+/=-]{8,}/g, "$1 [redacted]");
  if (!(err instanceof Error)) return { message: clean(typeof err === "string" ? err : safeString(err)) };
  const code = (err as NodeJS.ErrnoException).code;
  return {
    name: err.name,
    message: clean(err.message),
    ...(typeof code === "string" ? { code } : {}),
    ...(err.stack ? { stack: clean(err.stack).slice(0, STACK_MAX) } : {}),
  };
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Why going on after this one isn't safe, or null to keep running. The one case: the app is
 * already stopping. A throw in shutdown() leaves it half stopped, and it would never exit (its
 * process.exit is the last thing shutdown does), so it exits now. Anything else was one listener,
 * timer or promise failing: the rest of the app is as it was (each part keeps its own state, and a
 * rejection leaves only what awaited it undone), so it goes on, as the phone's user would want.
 */
export function fatalWhy(o: { stopping: boolean }): string | null {
  return o.stopping ? "while stopping" : null;
}

/** The handler for both events: logs each, and stops the app only when fatalWhy says so. */
export function crashCatcher(d: CrashDeps): (kind: CrashKind, err: unknown) => void {
  const now = d.now ?? Date.now;
  const say = d.say ?? ((line: string) => process.stderr.write(`${line}\n`));
  let times: number[] = [];
  let count = 0;
  return (kind, err) => {
    const at = now();
    times = [...times.filter((t) => at - t < FLOOD_MS), at];
    count++;
    const why = fatalWhy({ stopping: d.stopping() });
    const { stack, ...fields } = crashFields(err, d.secrets?.() ?? []);
    const flood = times.length > FLOOD_COUNT;
    const then = why ? `stopping (${why})` : "kept running";
    try {
      d.log("crash_caught", { kind, ...fields, ...(stack && !flood ? { stack } : {}), ...(flood ? { flood: `${times.length} in ${FLOOD_MS / 1000} s, stacks not logged` } : {}), count, then });
    } catch (logErr) {
      // core/log.ts never throws; a stand-in might. Said, not lost.
      say(`crash_caught (${kind}) not logged: ${logErr instanceof Error ? logErr.message : safeString(logErr)}: ${String(stack ?? fields.message)}`);
    }
    if (why) d.stop(`Stopped after an error (${why}): ${String(stack ?? fields.message)}`);
  };
}
