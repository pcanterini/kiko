// Which Codex sessions are this adapter's: those Codex's own CLI runs, its TUI in a terminal. An app
// that runs Codex for its own threads (T3 Code, Codex's desktop app, its IDE extension) starts
// Codex's app server with its own client name, and Codex records that name as the session's
// `originator` in the first line of its rollout (session_meta), kept for good when it's resumed.
// Codex's hooks fire there too (they're the user's, in $CODEX_HOME/hooks.json), so without this a
// T3 Code thread on Codex was a second session, announced as well as T3's own: one chat, two
// announcements, and a phantom row.
//
// An allowlist, not a list of the apps to leave out: the originators Codex's CLI writes are few and
// fixed in its source (codex-rs, 0.153.0 and 0.166.0): "codex-tui" (its TUI's app-server client
// name) and "codex_cli_rs" (DEFAULT_ORIGINATOR, an older TUI's), while an app's is whatever it calls
// itself ("T3 Code", "Codex Desktop", "codex_vscode", "codex_work_desktop"…), including apps
// Kiko has no adapter for. So the Codex adapter never names another app, and no app has to
// declare itself. Matched as a word (tui or cli between separators), as the daemon's listing did
// loosely before, so a renamed TUI ("codex_tui") still counts and an app named "…client" doesn't.
// `codex exec` ("codex_exec") doesn't either: a one-shot run is no session Kiko lists (./setup.ts health,
// ./daemon.ts threadOf). A session that records no originator (a Codex from before it did, or a
// rollout not written yet) counts as Codex's, as before.
//
// hooks/codex-hook.mjs keeps the same rule (`otherApp` there): a hook for another app's session
// exits at once, printing nothing, keeping no record and telling Kiko nothing, so that app
// answers its own permission prompts. Keep the two in step.
import { closeSync, openSync, readSync } from "node:fs";

const CLI = /(?:^|[-_ ])(?:tui|cli)(?:[-_ ]|$)/i;

/** Whether an originator is Codex's own CLI's (or there's none): a session this adapter lists, hears and answers. */
export const codexOriginator = (originator: unknown) => typeof originator !== "string" || !originator.trim() || CLI.test(originator);

/** The first line of a rollout is its session_meta, about 22 KB (Codex's instructions are in it): read at most this much of it. */
const FIRST_LINE_MAX = 1024 * 1024;

/** A file's first line, whole; undefined when there's no file, or no whole line yet (Codex is still writing it). */
function firstLine(path: string): string | undefined {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let at = 0; at < FIRST_LINE_MAX; ) {
      const n = readSync(fd, buffer, 0, buffer.length, at);
      if (!n) return undefined;
      const end = buffer.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buffer.subarray(0, end < 0 ? n : end)));
      if (end >= 0) return Buffer.concat(chunks).toString("utf8");
      at += n;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Who started a session, from its rollout's first line (session_meta `originator`): the name, null
 * when it records none, undefined when it can't be read (no rollout, or not written yet). Only that
 * field is read; nothing else of the rollout is kept or logged.
 */
export function originatorOf(path: string | undefined): string | null | undefined {
  if (!path) return undefined;
  const first = firstLine(path);
  if (first === undefined) return undefined;
  try {
    const line = JSON.parse(first);
    const originator = line?.type === "session_meta" ? line.payload?.originator : undefined;
    return typeof originator === "string" ? originator : null;
  } catch {
    return undefined;
  }
}

// Each session's originator once read (it never changes: Codex keeps the first one when a session is resumed).
const origins = new Map<string, string | null>();

/**
 * The app that runs a Codex session when it isn't Codex's own CLI (its originator: "T3 Code"), else
 * null: Codex's own, or not known yet (read again next time, until its rollout says).
 */
export function otherApp(sessionId: string, rollout: string | undefined): string | null {
  let originator = origins.get(sessionId);
  if (originator === undefined) {
    const read = originatorOf(rollout);
    if (read === undefined) return null;
    origins.set(sessionId, read);
    originator = read;
  }
  return codexOriginator(originator) ? null : originator;
}

/** Forgets what was read (for the tests). */
export const forgetOrigins = () => origins.clear();
