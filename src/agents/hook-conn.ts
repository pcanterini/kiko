// A hook's connection on the hooks socket (claude-code/hooks.ts HookServer), from either agent's hook
// script. The hook on the other end can be gone before Kiko writes to it: a told hook exits as soon
// as its line is out, a held one is timed out or killed (Esc, its session closed), and under load
// Kiko reads the line only after that. Writing then fails (EPIPE, or ECONNRESET): never thrown, never
// a crash, only a quiet log line; and once the connection has closed, nothing more is written.
import type { Socket } from "node:net";
import { log } from "../core/log.ts";

/** A write to a hook that had gone, as Node says it. */
const GONE = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

/**
 * Catches `conn`'s errors, logged once: `hook_gone` for a hook that had gone, `hook_socket_error`
 * for anything else. `about` (the event's kind, its session) is read when one comes, so it can be
 * filled in once the line is read.
 */
export function watchHookConn(conn: Socket, about: Record<string, unknown> = {}) {
  let logged = false;
  conn.on("error", (err: NodeJS.ErrnoException) => {
    if (logged) return;
    logged = true;
    const code = typeof err?.code === "string" ? err.code : "";
    if (GONE.has(code)) log("hook_gone", { code, ...about });
    else log("hook_socket_error", { code, message: err instanceof Error ? err.message : String(err), ...about });
  });
}

/** Whether the hook can't be written to any more: its connection closed, ended, or on its way to. Only what the socket says counts. */
export function hookGone(conn: Socket) {
  return conn.destroyed === true || conn.writableEnded === true || conn.writable === false;
}

/** Writes `line` to the hook, keeping the connection open; false (nothing written) when it had gone. */
export function writeHook(conn: Socket, line: string) {
  if (hookGone(conn)) return false;
  conn.write(line);
  return true;
}

/** Ends the hook's connection, with `line` when given; false (nothing written) when it had gone. */
export function endHook(conn: Socket, line?: string) {
  if (hookGone(conn)) {
    conn.destroy();
    return false;
  }
  if (line === undefined) conn.end();
  else conn.end(line);
  return true;
}
