// AppleScripts that control another app (Ghostty, Terminal, iTerm: src/terminals/), run by the
// helper app (./helper-app.ts, native/macos/app/host.swift's op osascript) so their Apple Events
// are the app's: macOS asks "“Kiko” wants access to control “Ghostty”" once, and keeps that grant
// whichever terminal `kiko` was started from. Run as `kiko`'s own child instead, the terminal that
// started it would be asking ("iTerm wants access to control Ghostty"), and every other terminal
// again. When the app can't be used (KIKO_HELPER_APP=off, no GUI session, it didn't start), the
// script runs as before, `kiko`'s own `osascript`, logged once (apple_events, with why).
//
// The volume's scripts (./duck.ts) stay `kiko`'s: `get volume settings` and `set volume` are
// Standard Additions, sent to no app, so macOS asks nothing for them.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { log } from "../../core/log.ts";
import { broker, type BrokerConn, type BrokerUse } from "./helper-app.ts";

/** Runs `script` (its `on run argv` given `args`): what it printed, or throws with what it said. */
export type ScriptRunner = (script: string, args?: string[], timeoutMs?: number) => Promise<string>;

/** What runAppleScript needs from the world: the tests' fakes replace them. */
export type AppleEventDeps = {
  /** The helper app's control channel, or why it can't be used (Broker.use). */
  use(): Promise<BrokerUse>;
  /** `osascript` as this process's own child: the fallback. */
  direct(script: string, args: string[], timeoutMs: number): Promise<string>;
  log(event: string, fields: Record<string, unknown>): void;
};

/** How long a script may take by default: a permission prompt waits on you meanwhile. */
const DEFAULT_MS = 60_000;

/** The app couldn't start osascript: nothing ran, so it runs here instead. */
class NotStarted extends Error {}

/**
 * One script run by the app: what it printed. Rejects with NotStarted when the app couldn't start
 * it; any other error (it failed, ran past its time, or the app went away meanwhile) may come after
 * it typed, so it's never run again.
 */
export function inApp(conn: BrokerConn, script: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(12).toString("hex");
    // The app stops it at timeoutMs; a little more for its answer to arrive.
    const timer = setTimeout(() => {
      conn.untrack(token);
      reject(new Error(`the helper app didn't answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs + 3000);
    conn.track(token, (m) => {
      clearTimeout(timer);
      if (m.op === "exit") {
        if (m.code === 0) return resolve(typeof m.stdout === "string" ? m.stdout : "");
        const said = typeof m.stderr === "string" ? m.stderr.trim() : "";
        return reject(new Error(said || (m.signal != null ? `osascript stopped (signal ${m.signal})` : `osascript exited ${m.code}`)));
      }
      if (m.op === "gone") return reject(new Error("the helper app went away"));
      reject(new NotStarted(String(m.message ?? "it couldn't start osascript")));
    });
    conn.send({ op: "osascript", token, script, args, timeout: Math.ceil(timeoutMs / 1000) });
  });
}

/** A runner over `d`: through the app when it can be used, else (or when it couldn't start osascript) directly. */
export function appleEvents(d: AppleEventDeps): ScriptRunner {
  // Each way, and each reason for the direct one, logged once a process: the listing runs every few seconds.
  const said = new Set<string>();
  const once = (key: string, fields: Record<string, unknown>) => {
    if (said.has(key)) return;
    said.add(key);
    d.log("apple_events", fields);
  };
  return async (script, args = [], timeoutMs = DEFAULT_MS) => {
    let use: BrokerUse;
    try {
      use = await d.use();
    } catch (err) {
      use = { why: err instanceof Error ? err.message : String(err) };
    }
    if ("conn" in use) {
      try {
        const out = await inApp(use.conn, script, args, timeoutMs);
        once("app", { via: "app" });
        return out;
      } catch (err) {
        // It ran (or may have): what it said stands. Only a script the app couldn't start runs here instead.
        if (!(err instanceof NotStarted)) throw err;
        once(`refused:${err.message}`, { via: "direct", why: `the helper app couldn't run it (${err.message})` });
      }
    } else once(`direct:${use.why}`, { via: "direct", why: use.why });
    return d.direct(script, args, timeoutMs);
  };
}

/** `osascript` as this process's child (what every script did before the helper app ran them). Never under the test runner. */
function osascript(script: string, args: string[], timeoutMs: number): Promise<string> {
  if (process.env.NODE_TEST_CONTEXT) return Promise.reject(new Error("osascript under the test runner: refused (a test must never script a real app)"));
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** The real one: this flavour's helper app, else `osascript` here. */
export const runAppleScript: ScriptRunner = appleEvents({ use: () => broker.use(), direct: osascript, log });
