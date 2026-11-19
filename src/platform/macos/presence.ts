// Whether someone is at this Mac (../types.ts AtComputer): the presence helper (native/macos/
// presence.swift: the HID idle time, the session's lock, the display's sleep), else `ioreg` (the
// idle time from IOHIDSystem's HIDIdleTime, the lock from the console user's
// CGSSessionScreenIsLocked; nothing else of either is read). Null when neither can tell.
import { execFile } from "node:child_process";
import type { AtComputer } from "../types.ts";
import { buildNative } from "./native.ts";

const TIMEOUT_MS = 2000;
// Nothing of the app's environment is passed on: these need none.
const ENV = { PATH: "/usr/sbin:/usr/bin:/bin" };

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile(file, args, { env: ENV, timeout: TIMEOUT_MS }, (err, out) => resolve(err ? null : out)));
}

// The helper's binary: built the first time (once a run), null when it can't be.
let helper: string | null | undefined;
function binary(): string | null {
  if (helper === undefined) {
    try {
      helper = buildNative("presence");
    } catch {
      helper = null;
    }
  }
  return helper;
}

/** The helper's line, as an AtComputer; null when it's not one. */
export function parseHelper(out: string | null): AtComputer | null {
  try {
    const x = JSON.parse(out ?? "");
    if (!Number.isFinite(x?.idleMs) || x.idleMs < 0 || typeof x.locked !== "boolean" || typeof x.asleep !== "boolean") return null;
    return { idleMs: x.idleMs, locked: x.locked, asleep: x.asleep };
  } catch {
    return null;
  }
}

/** HIDIdleTime (nanoseconds) in `ioreg -c IOHIDSystem`'s output, as ms; null when it isn't there. */
export function parseIdle(out: string | null): number | null {
  const m = /"HIDIdleTime" = (\d+)/.exec(out ?? "");
  return m ? Math.round(Number(m[1]) / 1e6) : null;
}

/** Whether `ioreg -n Root -k IOConsoleUsers`'s output has the screen locked. */
export const parseLocked = (out: string | null) => /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(out ?? "");

export async function atComputer(): Promise<AtComputer | null> {
  const bin = binary();
  const read = bin ? parseHelper(await run(bin, [])) : null;
  if (read) return read;
  const [idle, root] = await Promise.all([run("ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1", "-k", "HIDIdleTime"]), run("ioreg", ["-n", "Root", "-d", "1", "-k", "IOConsoleUsers"])]);
  const idleMs = parseIdle(idle);
  if (idleMs === null) return null;
  return { idleMs, locked: parseLocked(root), asleep: false };
}
