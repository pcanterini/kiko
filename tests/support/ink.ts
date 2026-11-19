// Ink drawn for real in a test: a keyboard to type into it, and how to wait for what it draws. Every
// wait is for something to be so, never a fixed time: Ink draws at most 30 frames a second (the
// rest held for the next), runs effects a turn after a render, holds a lone Esc ~20 ms for the rest
// of a sequence, and a setting's options come later still (choicesFor is async); a busy machine
// stretches all of it, so a frame read after a fixed sleep could be the one before.
//   untilFrame(frame, ok, what): the frame `frame()` gives once `ok` passes on it (what's drawn
//     when something comes later: options loaded, a key's effect, an Esc).
//   inkDone(app): Ink through with what was typed or rendered before it (the keys read, the renders
//     and their effects run, the frame written): for a key whose effect is drawn at once, and before
//     a key that does nothing (what comes after it waits for it: keys are read in order).
// Both stretch with KIKO_TEST_SLOW (tests/support/until.ts).
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Instance } from "ink";
import { valueWaits, type What } from "./until.ts";

/** Text without its colours and cursor moves. */
export const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A terminal to type into: what Ink reads keys from (raw mode a no-op). */
export function keyboard() {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  return stdin;
}

const frameWaits = valueWaits(5000, 10);

/**
 * The frame `frame()` gives once `ok` passes on it, looked at every 10 ms; after `ms` (5 s unless
 * given, times KIKO_TEST_SLOW), an error saying what for, with the last frame (plain).
 */
export const untilFrame = (frame: () => string, ok: (frame: string) => boolean, what: What, ms?: number): Promise<string> =>
  frameWaits(frame, ok, what, ms).catch((e: Error) => {
    throw new Error(plain(e.message));
  });

/**
 * Ink through with what came before: a turn for the keys written to be read (and React's render and
 * effects for them to run), then Ink's own flush (any frame held back by its throttle written).
 * A lone Esc is the exception: Ink waits ~20 ms for more of a sequence, so wait for what it does.
 */
export async function inkDone(app: Pick<Instance, "waitUntilRenderFlush">) {
  await nextTurn();
  await app.waitUntilRenderFlush();
}

/** `keys` typed one at a time, Ink through with each before the next (none of them a lone Esc: see inkDone). */
export async function typeKeys(app: Pick<Instance, "waitUntilRenderFlush">, stdin: { write: (s: string) => unknown }, ...keys: string[]) {
  for (const key of keys) {
    if (key === "\x1b") throw new Error("a lone Esc: Ink holds it a moment; type it, then wait for what it does (untilFrame)");
    stdin.write(key);
    await inkDone(app);
  }
}
