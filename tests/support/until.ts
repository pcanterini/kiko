// How a test waits for something to be so: it looks again every few ms, and fails after a while saying
// what it waited for (and, for a value, what it saw last). A file makes its own `until` with its own
// defaults: `const until = valueWaits(8000, 50)` (the live tests: `until(get, ok, what, ms)`), or
// `const until = checkWaits(3000)` (`until(ok)`, then how long and what, in either order).
// KIKO_TEST_SLOW stretches every wait (2: twice as long), for a slow or busy machine.
import { setTimeout as wait } from "node:timers/promises";
import { envVar } from "../../src/core/name.ts";

/** What a wait is for, said when it times out (a function: worked out then). */
export type What = string | (() => string);
/** What a check found: anything but false, 0, "", null or undefined. */
export type Found<T> = Exclude<T, false | 0 | "" | null | undefined>;

/** How many times longer every wait may take than it says: KIKO_TEST_SLOW, 1 when unset. */
export const SLOW = Math.max(1, Number(envVar("TEST_SLOW")) || 1);

const words = (what: What) => (typeof what === "function" ? what() : what);
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));

async function poll<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, ms: number, every: number, timedOut: (v: T) => string): Promise<T> {
  const end = Date.now() + ms * SLOW;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(timedOut(v));
    await wait(every);
  }
}

/**
 * A file's `until(get, ok, what?, ms?)`: what `get` gives once `ok` passes on it, looked at every
 * `every` ms; after `ms` (`defaultMs` unless given), an error with what it gave last.
 */
export const valueWaits =
  (defaultMs: number, every = 25) =>
  <T>(get: () => T | Promise<T>, ok: (v: T) => boolean, what: What = "it", ms = defaultMs): Promise<T> =>
    poll(get, ok, ms, every, (v) => `timed out after ${ms}ms waiting for ${words(what)}; last:\n${shown(v)}`);

/**
 * A file's `until(check, …)`: once `check` gives something (true, or a value found), that, looked at
 * every `every` ms. After it, a number is how long to wait (`defaultMs` unless given), anything else
 * what for: `until(ok)`, `until(ok, 2000)`, `until(ok, "the reply")`, `until(ok, 2000, "the reply")`.
 */
export const checkWaits =
  (defaultMs: number, every = 10) =>
  <T>(check: () => T | Promise<T>, ...how: Array<number | What>): Promise<Found<T>> => {
    const ms = how.find((h) => typeof h === "number") ?? defaultMs;
    const what = how.find((h) => typeof h !== "number");
    return poll(check, Boolean, ms, every, () => `timed out after ${ms}ms${what === undefined ? "" : ` waiting for ${words(what)}`}`) as Promise<Found<T>>;
  };
