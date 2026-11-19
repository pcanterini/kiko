// The app switching to Pocket by itself once its download is ready (src/app/pocket-switch.ts), with
// fakes for the download's state, Pocket's start and what's being said: never mid-line (swapped
// only while nothing is said or waiting), only when Pocket is still what would be picked, and the
// macOS voice kept when Pocket can't start. Also the speech lock's busy (src/core/speech-lock.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { watchPocket, type SwitchDeps } from "../../../src/app/pocket-switch.ts";
import type { PrepState } from "../../../src/core/pocket-prep.ts";
import { SpeechLock } from "../../../src/core/speech-lock.ts";

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fake(over: Partial<SwitchDeps<string>> = {}) {
  const w = {
    state: "running" as PrepState,
    wanted: true,
    busy: false,
    starts: 0,
    used: [] as string[],
    closed: [] as string[],
    logged: [] as string[],
    failStart: false,
  };
  const deps: SwitchDeps<string> = {
    state: () => w.state,
    wanted: () => w.wanted,
    start: async () => {
      w.starts++;
      if (w.failStart) throw new Error("Pocket TTS server exited during startup");
      return `pocket#${w.starts}`;
    },
    close: (e) => void w.closed.push(e),
    busy: () => w.busy,
    use: (e) => void w.used.push(e),
    log: (event, fields) => void w.logged.push(`${event} ${JSON.stringify(fields ?? {})}`),
    everyMs: 10,
    quietMs: 10,
    ...over,
  };
  return { w, deps };
}

describe("switching to Pocket once it's ready", () => {
  test("watched while it runs; ready: started on the side, then used, once", async () => {
    const { w, deps } = fake();
    const stop = watchPocket(deps);
    await settle(50);
    assert.equal(w.starts, 0, "still downloading: nothing started");
    w.state = "ready";
    await settle(50);
    assert.deepEqual(w.used, ["pocket#1"]);
    assert.equal(w.starts, 1);
    assert.ok(w.logged.includes("pocket_switched {}"));
    await settle(50);
    assert.equal(w.starts, 1, "not again");
    stop();
  });

  test("never mid-line: while something is being said (or waiting), the swap waits for a quiet moment", async () => {
    const { w, deps } = fake();
    w.state = "ready";
    w.busy = true;
    const stop = watchPocket(deps);
    await settle(60);
    assert.equal(w.starts, 1, "started meanwhile, the macOS voice still speaking");
    assert.deepEqual(w.used, [], "not swapped while busy");
    w.busy = false;
    await settle(40);
    assert.deepEqual(w.used, ["pocket#1"]);
    stop();
  });

  test("a voice chosen meanwhile (or a Cartesia key added): not switched", async () => {
    const { w, deps } = fake();
    w.state = "ready";
    w.wanted = false;
    watchPocket(deps);
    await settle(30);
    assert.equal(w.starts, 0);
    assert.deepEqual(w.used, []);
  });

  test("failed, or never started: nothing to switch to, the watch ends", async () => {
    for (const state of ["failed", "none"] as const) {
      const { w, deps } = fake();
      w.state = state;
      watchPocket(deps);
      await settle(30);
      w.state = "ready";
      await settle(30);
      assert.equal(w.starts, 0, state);
    }
  });

  test("Pocket can't start: the macOS voice goes on, and the log says why", async () => {
    const { w, deps } = fake();
    w.state = "ready";
    w.failStart = true;
    watchPocket(deps);
    await settle(30);
    assert.deepEqual(w.used, []);
    assert.ok(
      w.logged.some((l) => l.startsWith("pocket_switch") && l.includes("exited during startup")),
      w.logged.join("\n"),
    );
  });

  test("stopped (the app quitting) while it waited for a quiet moment: the one started is closed, not used", async () => {
    const { w, deps } = fake();
    w.state = "ready";
    w.busy = true;
    const stop = watchPocket(deps);
    await settle(30);
    stop();
    w.busy = false;
    await settle(30);
    assert.deepEqual(w.used, []);
    assert.deepEqual(w.closed, ["pocket#1"]);
  });

  test("the speech lock is busy while a line is said and while one waits its turn", async () => {
    const lock = new SpeechLock();
    assert.equal(lock.busy, false);
    let done = () => {};
    const open = async (h: { onDone: () => void }) => {
      done = h.onDone;
      return { push() {}, end() {}, cancel() {}, chars: () => 0 };
    };
    await lock.open(open, () => {});
    assert.equal(lock.busy, true);
    done();
    assert.equal(lock.busy, false);
  });
});
