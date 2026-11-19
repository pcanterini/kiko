// Deepgram's socket coming back (src/core/deepgram.ts), as Cartesia's (cartesia-reconnect.test.ts):
// started offline, or dropped and every attempt failing, it waits longer each time (0.5 s doubling
// to 30 s), says each failure in the log (deepgram_reconnect_failed), never an unhandled rejection,
// and stops when closed. A message that isn't JSON, or isn't
// an object, is dropped, not thrown. Real sockets on 127.0.0.1: a port nothing listens on, and a
// stand-in server.
import "../../setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { Deepgram } from "../../../src/core/deepgram.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(5000, 5);

/** A port on 127.0.0.1 that nothing listens on: every attempt is refused. */
async function deadPort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

/** console.error's lines while `f` runs. */
async function quiet<T>(f: (errors: string[]) => Promise<T>) {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    return await f(errors);
  } finally {
    console.error = realError;
  }
}

test("started offline: no unhandled rejection, and each wait is longer, up to the most", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const waits: number[] = [];
  const dg = new Deepgram("k", `ws://127.0.0.1:${await deadPort()}/v1/listen`, {
    retryMs: { min: 500, max: 4000 },
    // Asked for, then run at once: the test needn't wait them out.
    wait: (then, ms) => {
      waits.push(ms);
      return setTimeout(then, 1);
    },
  });
  try {
    await quiet(async () => {
      await assert.rejects(dg.connect(), /ECONNREFUSED/);
      await until(() => waits.length >= 6);
    });
    dg.close();
    assert.deepEqual(waits.slice(0, 6), [500, 1000, 2000, 4000, 4000, 4000]);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(rejections, []);
  } finally {
    dg.close();
    process.off("unhandledRejection", onRejection);
  }
});

test("closed while waiting to connect again: it doesn't", async () => {
  let attempts = 0;
  let pending: NodeJS.Timeout | null = null;
  const dg = new Deepgram("k", `ws://127.0.0.1:${await deadPort()}/v1/listen`, {
    wait: (then, ms) => {
      attempts++;
      pending = setTimeout(then, ms / 50);
      return pending;
    },
  });
  await quiet(async () => {
    await dg.connect().catch(() => {});
    await until(() => pending !== null);
    dg.close();
    await new Promise((r) => setTimeout(r, 40));
  });
  assert.equal(attempts, 1);
});

test("a message that isn't JSON, or isn't an object, is dropped, not thrown; the socket goes on", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const { port } = wss.address() as { port: number };
  wss.on("connection", (ws) => {
    for (const bad of ["{ half", "null", "7", '"text"']) ws.send(bad);
    ws.send(JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "still here" }] } }));
  });
  const thrown: unknown[] = [];
  const onThrow = (err: unknown) => thrown.push(err);
  process.on("uncaughtException", onThrow);
  const dg = new Deepgram("k", `ws://127.0.0.1:${port}/v1/listen`);
  const heard: string[] = [];
  dg.onInterim = (text) => heard.push(text);
  try {
    const errors = await quiet(async (errors) => {
      await dg.connect();
      await until(() => heard.length > 0);
      return errors;
    });
    assert.deepEqual(thrown, []);
    assert.deepEqual(heard, ["still here"]);
    assert.match(errors.join("\n"), /\[deepgram\] a message that isn't JSON/);
  } finally {
    dg.close();
    process.off("uncaughtException", onThrow);
    wss.close();
  }
});
