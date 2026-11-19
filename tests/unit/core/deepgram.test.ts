// Deepgram's live socket (src/core/deepgram.ts) against a stand-in server on 127.0.0.1. If the socket drops in the
// middle of a press, it connects again ~0.5s later; the audio said meanwhile used to be thrown away. Now it's held and
// sent first, in order, once the socket is back (up to 5 seconds of it; past that the oldest goes, and the log says so).
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { Deepgram } from "../../../src/core/deepgram.ts";
import { PressStt } from "../../../src/core/press-stt.ts";
import { checkWaits } from "../../support/until.ts";

/** What each connection got: audio chunks as their text, and the control messages' types; `from`: where this press began (after the last Finalize). */
type Conn = { ws: WebSocket; got: string[]; from: number };
const conns: Conn[] = [];
const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
const { port } = wss.address() as { port: number };
// The stand-in hears the words in this connection's audio since the last Finalize: each one as an interim, and all
// of them as final when it's finalized (`finalizeMs` later).
let finalizeMs = 0;
wss.on("connection", (ws) => {
  const conn: Conn = { ws, got: [], from: 0 };
  conns.push(conn);
  const results = (final: boolean) => {
    const words = conn.got
      .slice(conn.from)
      .filter((g) => g.startsWith("w:"))
      .map((g) => g.slice(2))
      .join(" ");
    if (final) conn.from = conn.got.length;
    ws.send(JSON.stringify({ type: "Results", is_final: final, from_finalize: final, channel: { alternatives: [{ transcript: words }] } }));
  };
  ws.on("message", (data, binary) => {
    if (binary) {
      conn.got.push(data.toString());
      return results(false);
    }
    const msg = JSON.parse(data.toString());
    conn.got.push(msg.type);
    if (msg.type === "Finalize") {
      if (finalizeMs) setTimeout(() => results(true), finalizeMs);
      else results(true);
    }
  });
});
after(() => wss.close());

const until = checkWaits(3000, 5);
const word = (w: string) => Buffer.from(`w:${w}`);
/** A second of 16 kHz 16-bit audio, tagged. */
const second = (tag: string) => Buffer.concat([Buffer.from(`s:${tag}:`), Buffer.alloc(32000 - 4 - tag.length)]);
const logged = (event: string) =>
  readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(`logs/${f}`, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((l) => l.event === event);

async function connected() {
  const dg = new Deepgram("test-key", `ws://127.0.0.1:${port}/v1/listen`);
  const before = conns.length;
  await dg.connect();
  await until(() => conns.length === before + 1);
  return { dg, conn: () => conns.at(-1)! };
}

/** The server lets the socket go, and the client has seen it close. */
async function drop(dg: Deepgram, conn: Conn) {
  conn.ws.terminate();
  await until(() => (dg as any).ws === null);
}

test("a press goes out as it's said, and finish() gives its words", async () => {
  const { dg, conn } = await connected();
  dg.begin();
  dg.send(word("tell"));
  dg.send(word("lacy"));
  assert.equal(await dg.finish(), "tell lacy");
  assert.deepEqual(conn().got, ["w:tell", "w:lacy", "Finalize"]);
  dg.close();
});

test("dropped mid-press: what's said while it reconnects is held and sent first, in order, then the rest", async () => {
  const { dg, conn } = await connected();
  const first = conn();
  dg.begin();
  dg.send(word("tell"));
  await until(() => (dg as any).interim === "tell");
  await drop(dg, first);
  dg.send(word("atlas")); // ~0.5s with no socket
  dg.send(word("agents"));
  await until(() => conns.at(-1) !== first);
  const second = conn();
  await until(() => second.got.length >= 2);
  dg.send(word("to"));
  dg.send(word("deploy"));
  const heard = await dg.finish();
  assert.deepEqual(second.got, ["w:atlas", "w:agents", "w:to", "w:deploy", "Finalize"]);
  assert.equal(heard, "tell atlas agents to deploy", "what the first socket heard, then the rest");
  assert.equal(dg.audioSeconds() > 0, true, "the held audio counts as sent");
  assert.deepEqual(logged("deepgram_dropped"), [], "nothing was lost");
  dg.close();
});

test("let go before it's back: finish() waits for it, sends what was held, then Finalize", async () => {
  const { dg, conn } = await connected();
  const first = conn();
  dg.begin();
  await drop(dg, first);
  dg.send(word("push"));
  dg.send(word("it"));
  assert.equal(await dg.finish(), "push it");
  assert.deepEqual(conn().got, ["w:push", "w:it", "Finalize"]);
  dg.close();
});

test("more than 5 seconds while it's down: the oldest goes, and the log says how much", async () => {
  const { dg, conn } = await connected();
  const first = conn();
  dg.begin();
  await drop(dg, first);
  for (let i = 1; i <= 7; i++) dg.send(second(String(i)));
  await dg.finish();
  const tags = conn()
    .got.filter((g) => g.startsWith("s:"))
    .map((g) => g.split(":")[1]);
  assert.deepEqual(tags, ["3", "4", "5", "6", "7"], "the last 5 seconds, in order");
  const dropped = logged("deepgram_dropped");
  assert.equal(dropped.length, 1);
  assert.deepEqual([dropped[0].seconds, dropped[0].why], [2, "backlog_full"]);
  dg.close();
});

// Pressed again while the last press is finalized (src/core/press-stt.ts): one socket hears one press at a time.
// begin() for the second used to clear the first's words before Deepgram's answer came, and the second's audio
// went into the first's transcript.
test("pressed again while the last press is finalized: each press gets its own words, in order", async () => {
  const { dg, conn } = await connected();
  finalizeMs = 100;
  const stt = new PressStt(dg);
  const order: string[] = [];
  const a = stt.begin();
  a.send(word("run"));
  a.send(word("the"));
  a.send(word("tests"));
  const first = a.finish().then((t) => (order.push("a"), t));
  // The next press at once (the phone's button, during the first's transcription).
  const b = stt.begin();
  b.send(word("and"));
  b.send(word("the"));
  b.send(word("linter"));
  const second = b.finish().then((t) => (order.push("b"), t));
  assert.deepEqual([await first, await second], ["run the tests", "and the linter"]);
  assert.deepEqual(order, ["a", "b"]);
  // The second press's audio went once the first's Finalize was answered.
  assert.deepEqual(conn().got, ["w:run", "w:the", "w:tests", "Finalize", "w:and", "w:the", "w:linter", "Finalize"]);
  finalizeMs = 0;
  dg.close();
});
