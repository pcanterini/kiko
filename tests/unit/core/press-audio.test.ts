// What a phone press's audio looked like as it reached the hub (src/core/press-audio.ts), logged
// with phone_talk: seconds of sound against seconds of silence, all-zero and near-silent chunks,
// the longest wait between chunks, the last chunk against talk_end, and when the words last grew.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PressAudio, SILENT_DB } from "../../../src/core/press-audio.ts";

const RATE = 16000;

/** `ms` of 16-bit PCM: a sine at `amplitude` (0..1), or zeros. */
function pcm(ms: number, amplitude: number) {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude * 32767), i * 2);
  return b;
}

describe("a phone press's audio", () => {
  test("loud seconds, then zeros: per second, with the zero chunks counted", () => {
    const audio = new PressAudio(1000, RATE);
    let at = 1000;
    // 2 s of sound in 100 ms chunks, then 1.5 s of zeros.
    for (let i = 0; i < 20; i++) audio.add(pcm(100, 0.3), (at += 100));
    for (let i = 0; i < 15; i++) audio.add(pcm(100, 0), (at += 100));
    const s = audio.summary(at + 30);
    assert.equal(s.chunks, 35);
    assert.equal(s.bytes, 35 * 3200);
    assert.equal(s.zeroChunks, 15);
    assert.equal(s.quietChunks, 15);
    assert.equal(s.dbPerSecond.length, 4);
    // A sine at 0.3 is about -13.5 dBFS.
    assert.ok(s.dbPerSecond[0] > -16 && s.dbPerSecond[0] < -11, String(s.dbPerSecond[0]));
    assert.ok(s.dbPerSecond[1] > -16 && s.dbPerSecond[1] < -11, String(s.dbPerSecond[1]));
    assert.equal(s.dbPerSecond[2], SILENT_DB);
    assert.equal(s.dbPerSecond[3], SILENT_DB); // the last half second
    assert.equal(s.lastChunkToEndMs, 30);
    assert.equal(s.maxGapMs, 100);
  });

  test("near-silent chunks count as quiet, not as zeros", () => {
    const audio = new PressAudio(0, RATE);
    audio.add(pcm(100, 0.0001), 100); // about -83 dBFS: a mic that isn't hearing
    audio.add(pcm(100, 0.01), 200); // about -43 dBFS: a quiet room
    const s = audio.summary(250);
    assert.equal(s.zeroChunks, 0);
    assert.equal(s.quietChunks, 1);
  });

  test("the longest wait between chunks, and when it ended", () => {
    const audio = new PressAudio(0, RATE);
    audio.add(pcm(20, 0.1), 80);
    audio.add(pcm(100, 0.1), 600); // the mic stalled
    audio.add(pcm(100, 0.1), 700);
    const s = audio.summary(720);
    assert.equal(s.maxGapMs, 520);
    assert.equal(s.maxGapAtMs, 600);
  });

  test("when the transcript last gained words, from talk_start", () => {
    const audio = new PressAudio(1000, RATE);
    audio.heard("This is", 1500);
    audio.heard("This is a quick test", 3000);
    audio.heard("This is a quick test", 9000); // the same again: not more words
    audio.heard("This is a quick", 9500); // revised down: still not more
    const s = audio.summary(15000);
    assert.equal(s.wordsLastGrewMs, 2000);
    assert.equal(s.words, 5);
  });

  test("no audio at all", () => {
    const s = new PressAudio(0, RATE).summary(500);
    assert.deepEqual(s.dbPerSecond, []);
    assert.equal(s.lastChunkToEndMs, null);
    assert.equal(s.maxGapAtMs, null);
    assert.equal(s.wordsLastGrewMs, null);
  });
});
