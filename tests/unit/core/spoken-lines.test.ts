// The lines being said, for the log (src/core/spoken-lines.ts): speech_done and speech_cut.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LEVEL_MS, SpokenLines } from "../../../src/core/spoken-lines.ts";

// 24 kHz mono 16-bit: `ms` of silence.
const pcm = (ms: number) => Buffer.alloc(Math.round((ms / 1000) * 24000) * 2);

function setup() {
  let t = 1_000_000;
  const events: Array<{ event: string } & Record<string, unknown>> = [];
  const lines = new SpokenLines(
    (event, fields) => events.push({ event, ...fields }),
    () => t,
  );
  return { lines, events, advance: (ms: number) => (t += ms) };
}

describe("SpokenLines", () => {
  test("a line made and played: speech_done, and nothing to cut once it has played out", () => {
    const { lines, events, advance } = setup();
    const line = lines.open({ sessionId: "s1", name: "kiko", kind: "reply", text: "", replyId: "abc" });
    line.audio(pcm(1000));
    line.audio(pcm(1000));
    line.finished({ chars: 40, voice: "pocket", phones: ["opus"] });
    line.over();
    assert.deepEqual(events, [{ event: "speech_done", kind: "reply", sessionId: "s1", replyId: "abc", madeS: 2, chars: 40, voice: "pocket", phones: ["opus"] }]);
    advance(2500);
    lines.cutNow("press", {});
    assert.equal(events.length, 1);
  });

  test("a stop while it plays: speech_cut with why, what it was for, and how much was heard", () => {
    const { lines, events, advance } = setup();
    const line = lines.open({ sessionId: "s1", name: "kiko", kind: "reply", text: "", replyId: "abc" });
    line.audio(pcm(5000));
    line.finished({ chars: 90 });
    const waiting = lines.open({ sessionId: null, name: null, kind: "line", text: "" });
    advance(1700);
    lines.cutNow("typed_in", { causeSessionId: "s2" });
    line.over();
    waiting.over();
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      event: "speech_cut",
      why: "typed_in",
      causeSessionId: "s2",
      kind: "reply",
      sessionId: "s1",
      replyId: "abc",
      madeS: 5,
      playedS: 1.7,
      leftS: 3.3,
      making: false,
      dropped: 1,
    });
  });

  test("a line's sound starts once the one before it has played out", () => {
    const { lines, events, advance } = setup();
    const first = lines.open();
    first.audio(pcm(2000));
    first.finished({});
    const second = lines.open({ sessionId: "s3", name: "x", kind: "question", text: "" });
    second.audio(pcm(2000));
    advance(2500); // 0.5 s into the second
    lines.cutNow("press", {});
    const cut = events.find((e) => e.event === "speech_cut");
    assert.equal(cut?.sessionId, "s3");
    assert.equal(cut?.playedS, 0.5);
    assert.equal(cut?.making, true);
    assert.equal(cut?.dropped, 0);
  });

  test("cut by its maker, not a stop: logged as cancelled; a stop with nothing said logs nothing", () => {
    const { lines, events } = setup();
    lines.cutNow("press", {});
    assert.equal(events.length, 0);
    const line = lines.open({ sessionId: "s1", name: "kiko", kind: "reply", text: "" });
    line.over();
    assert.deepEqual(events, [{ event: "speech_cut", why: "cancelled", kind: "reply", sessionId: "s1", madeS: 0, playedS: 0, leftS: 0, making: true, dropped: 0 }]);
  });
});

// A tone of `ms` at `amp` (0–1 of full scale): sound whose level can be measured.
const tone = (ms: number, amp: number) => {
  const n = Math.round((ms / 1000) * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), i * 2);
  return b;
};

// What the Mac overlay shows while Kiko speaks (src/app/overlay.ts): the words said by the sample
// being played, and how loud it is there, in step with the sound, not with the voice making it.
describe("SpokenLines: what's heard now", () => {
  // Words said by a sample: one a second of sound, as the line's read-along (VoiceLine.saidBy) gives them.
  const WORDS = ["Tests", "pass", "on", "main", "now."];
  const saidBy = (sample: number) => WORDS.slice(0, Math.min(WORDS.length, 1 + Math.floor(sample / 24000)));

  test("the words said so far advance as the sound plays, though the voice made it all at once", () => {
    const { lines, advance } = setup();
    const line = lines.open({ sessionId: "s1", name: "kiko", kind: "reply", text: "" }, saidBy);
    assert.equal(lines.heard(), null, "no sound yet: nothing heard");
    line.audio(tone(5000, 0.5));
    line.finished({});
    assert.deepEqual(lines.heard()?.words, ["Tests"]);
    advance(1500);
    assert.deepEqual(lines.heard()?.words, ["Tests", "pass"]);
    advance(2000);
    assert.deepEqual(lines.heard()?.words, ["Tests", "pass", "on", "main"]);
    advance(5000);
    assert.deepEqual(lines.heard()?.words, WORDS, "played out: all of it, until the next line");
  });

  test("the level is the sound's where it's being played: loud, then quiet, then nothing once it has played out", () => {
    const { lines, advance } = setup();
    const line = lines.open({ sessionId: "s1", name: "kiko", kind: "reply", text: "" }, saidBy);
    line.audio(tone(1000, 0.5));
    line.audio(pcm(1000));
    line.audio(tone(1000, 0.05));
    line.finished({});
    const loud = lines.heard()!.level;
    advance(1200);
    const silent = lines.heard()!.level;
    advance(1000);
    const soft = lines.heard()!.level;
    advance(2000);
    const after = lines.heard()!.level;
    assert.ok(loud > 0.8, `loud: ${loud}`);
    assert.equal(silent, 0);
    assert.ok(soft > 0.4 && soft < loud, `soft: ${soft}`);
    assert.equal(after, 0);
  });

  test("a level for each slice of a chunk (LEVEL_MS), as the mic's is", () => {
    const { lines, advance } = setup();
    const line = lines.open(undefined, saidBy);
    // One chunk: loud, then as long again of silence.
    line.audio(Buffer.concat([tone(LEVEL_MS * 3, 0.5), pcm(LEVEL_MS * 3)]));
    assert.ok(lines.heard()!.level > 0.8);
    advance(LEVEL_MS * 3 + 10);
    assert.equal(lines.heard()!.level, 0);
  });

  test("the line in front: the next one's words once its sound starts, after the first has played out", () => {
    const { lines, advance } = setup();
    const first = lines.open({ sessionId: "s1", name: "a", kind: "reply", text: "" }, () => ["first"]);
    first.audio(tone(1000, 0.5));
    first.finished({});
    const second = lines.open({ sessionId: "s2", name: "b", kind: "reply", text: "" }, () => ["second"]);
    second.audio(tone(1000, 0.5));
    second.finished({});
    assert.deepEqual(lines.heard()?.words, ["first"], "the second's sound waits for the first's");
    assert.equal(lines.heard()?.said?.name, "a");
    advance(1500);
    assert.deepEqual(lines.heard()?.words, ["second"]);
    assert.equal(lines.heard()?.said?.name, "b");
  });

  test("a line with no sound in front (the macOS voice plays by itself): nothing heard; after a stop, nothing", () => {
    const { lines, advance } = setup();
    const played = lines.open(undefined, () => ["old"]);
    played.audio(tone(500, 0.5));
    played.finished({});
    advance(1000);
    lines.open(undefined, () => ["said"]);
    assert.equal(lines.heard(), null);
    lines.cutNow("press", {});
    assert.equal(lines.heard(), null);
  });

  test("no words known (no read-along): the line and its level, its words null", () => {
    const { lines } = setup();
    const line = lines.open({ sessionId: null, name: null, kind: "line", text: "" });
    line.audio(tone(500, 0.5));
    const h = lines.heard();
    assert.equal(h?.words, null);
    assert.ok(h!.level > 0.8);
  });
});
