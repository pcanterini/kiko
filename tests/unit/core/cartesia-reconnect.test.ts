// Cartesia's socket coming back (src/core/cartesia.ts): a reconnect that fails (offline, just after
// waking) is logged, never an unhandled rejection, and waits
// longer each time it fails, back to the shortest once one opens. No network: stand-in sockets, and
// the waits run by hand.
import "../../setup.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type WebSocket from "ws";
import { Cartesia } from "../../../src/core/cartesia.ts";

class FakeSocket extends EventEmitter {
  send() {}
  close() {
    this.emit("close");
  }
  /** As ws does when it can't connect: an error, then close. */
  fail(message: string) {
    this.emit("error", new Error(message));
    this.emit("close");
  }
}

function stand() {
  const sockets: FakeSocket[] = [];
  const waits: Array<{ ms: number; then: () => void }> = [];
  const c = new Cartesia({
    dial: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    retryMs: { min: 500, max: 4000 },
    wait: (then, ms) => {
      waits.push({ ms, then });
      return {} as NodeJS.Timeout;
    },
  });
  /** The last wait asked for, run now. */
  const runWait = () => waits.at(-1)?.then();
  return { c, sockets, waits, runWait };
}

/** console.error's lines while `f` runs. */
async function quiet(f: (errors: string[]) => Promise<void>) {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await f(errors);
  } finally {
    console.error = realError;
  }
}

test("a failed reconnect is handled and said, and each wait is longer until one opens", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const { c, sockets, waits, runWait } = stand();
  try {
    await quiet(async (errors) => {
      const first = c.connect();
      sockets[0].emit("open");
      await first;
      // The socket drops; then every attempt fails, as offline.
      sockets[0].emit("close");
      for (let i = 1; i <= 5; i++) {
        runWait();
        sockets[i].fail("getaddrinfo ENOTFOUND api.cartesia.ai");
        await tick();
      }
      assert.deepEqual(rejections, [], "no unhandled rejection");
      assert.equal(errors.filter((e) => e.includes("ENOTFOUND")).length, 5, "each failure said");
      // After the drop, then after each failure: doubling, up to the most.
      assert.deepEqual(
        waits.map((w) => w.ms),
        [500, 500, 1000, 2000, 4000, 4000],
      );
      // One opens: a drop after it waits the shortest again.
      runWait();
      sockets[6].emit("open");
      sockets[6].emit("close");
      assert.equal(waits.at(-1)?.ms, 500);
    });
  } finally {
    c.close();
    process.off("unhandledRejection", onRejection);
  }
});

test("closed while waiting to reconnect: it doesn't", async () => {
  const sockets: FakeSocket[] = [];
  let pending: NodeJS.Timeout | null = null;
  const c = new Cartesia({
    dial: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    wait: (then, ms) => (pending = setTimeout(then, ms / 50)),
  });
  const first = c.connect();
  sockets[0].emit("open");
  await first;
  sockets[0].emit("close");
  assert.ok(pending);
  c.close();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sockets.length, 1);
});

test("a message that isn't JSON is said and dropped, not thrown", async () => {
  const { c, sockets } = stand();
  await quiet(async (errors) => {
    const first = c.connect();
    sockets[0].emit("open");
    await first;
    assert.doesNotThrow(() => sockets[0].emit("message", Buffer.from("{ half")));
    assert.match(errors[0], /\[cartesia\] a message that isn't JSON/);
  });
  c.close();
});
