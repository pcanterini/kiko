// Cartesia's word timestamps for the phone's read-along (src/core/cartesia.ts): asked for when the
// line wants them, handed on as they come, and a bad batch never stops the voice. No network: the
// socket is a stand-in that keeps what's sent.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cartesia } from "../../../src/core/cartesia.ts";

function withSocket() {
  const c = new Cartesia();
  const sent: any[] = [];
  (c as any).ws = { send: (m: string) => sent.push(JSON.parse(m)) };
  return { c, sent, message: (m: unknown) => (c as any).onMessage(m) };
}

test("timestamps asked for with marks, and each batch handed on with its audio", async () => {
  const { c, sent, message } = withSocket();
  const got: unknown[] = [];
  const audio: number[] = [];
  const marks = { sentence() {}, sentenceDone() {}, timestamps: (w: string[], s: number[], e: number[]) => got.push([w, s, e]) };
  const s = await c.open({ onAudio: (b) => audio.push(b.length), onDone: () => {}, marks });
  s.push("Hello world");
  assert.equal(sent[0].add_timestamps, true);
  const id = sent[0].context_id;
  message({ type: "chunk", context_id: id, data: Buffer.alloc(4).toString("base64") });
  message({ type: "timestamps", context_id: id, word_timestamps: { words: ["Hello", "world"], start: [0, 0.5], end: [0.4, 0.9] } });
  message({ type: "timestamps", context_id: id, word_timestamps: { words: ["x"], start: [1] } }); // no ends: the starts
  message({ type: "timestamps", context_id: id, word_timestamps: { words: "nope" } }); // not arrays: dropped
  assert.deepEqual(audio, [4]);
  assert.deepEqual(got, [
    [
      ["Hello", "world"],
      [0, 0.5],
      [0.4, 0.9],
    ],
    [["x"], [1], [1]],
  ]);
});

test("without marks, nothing extra is asked; a marks that throws doesn't stop the audio", async () => {
  const { c, sent, message } = withSocket();
  const plain = await c.open({ onAudio: () => {}, onDone: () => {} });
  plain.push("Hi");
  assert.equal(sent[0].add_timestamps, undefined);
  const audio: number[] = [];
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    const marks = {
      sentence() {},
      sentenceDone() {},
      timestamps: () => {
        throw new Error("boom");
      },
    };
    const s = await c.open({ onAudio: (b) => audio.push(b.length), onDone: () => {}, marks });
    s.push("Hi");
    const id = sent[1].context_id;
    message({ type: "timestamps", context_id: id, word_timestamps: { words: ["Hi"], start: [0], end: [0.2] } });
    message({ type: "chunk", context_id: id, data: Buffer.alloc(2).toString("base64") });
  } finally {
    console.error = realError;
  }
  assert.deepEqual(audio, [2]);
  assert.match(errors[0], /timestamps: boom/);
});
