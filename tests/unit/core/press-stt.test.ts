// Each press's own speech-to-text (src/core/press-stt.ts), on a fake clock. The engines hear one press at a
// time: begin() starts afresh, and what they give at the end is what they have then. Pressed again within
// the key's 300ms tail, or on the phone during the ~100ms of transcription, the second press's begin() used
// to land on the first's words: lost, or given back as the first press's, cut. The fake engine here does
// just that (as Deepgram's socket, and Apple's helper cancelling the press under way, do), so these fail
// without press-stt.ts in front of it. The whole app runs it in the harness (sttCases: the Mac key pressed
// again within its tail; a phone press right after a Mac release), and Deepgram's socket in deepgram.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PressStt, type SttEngine } from "../../../src/core/press-stt.ts";
import { FakeClock } from "../../support/clock.ts";

/** One press at a time; its transcript is what it has heard when finishing ends, `finishMs` after finish(). */
class OneAtATime implements SttEngine {
  onInterim = (_: string) => {};
  heard: string[] = [];
  /** What happened, in order: begin, each word heard, finish, and what each finish gave. */
  steps: string[] = [];
  finishMs = 100;
  fails: Error | null = null;
  private clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }
  begin() {
    this.heard = [];
    this.steps.push("begin");
  }
  send(chunk: Buffer) {
    this.heard.push(chunk.toString());
    this.steps.push(chunk.toString());
    this.onInterim(this.heard.join(" "));
  }
  finish() {
    this.steps.push("finish");
    const fails = this.fails;
    return new Promise<string>((resolve, reject) =>
      this.clock.setTimeout(() => {
        if (fails) return reject(fails);
        const text = this.heard.join(" ");
        this.steps.push(`= ${text}`);
        resolve(text);
      }, this.finishMs),
    );
  }
  audioSeconds() {
    return this.heard.length;
  }
}

const w = (word: string) => Buffer.from(word);
const settle = () => new Promise((r) => setImmediate(r));
/** Moves the clock on, letting each timer's promise settle. */
async function advance(clock: FakeClock, ms: number) {
  for (let t = 0; t < ms; t += 10) {
    clock.advance(Math.min(10, ms - t));
    await settle();
  }
}

function setup(stuckMs?: number) {
  const clock = new FakeClock();
  const engine = new OneAtATime(clock);
  const logged: { event: string; fields: Record<string, unknown> }[] = [];
  const stt = new PressStt(engine, { clock, stuckMs, log: (event, fields) => logged.push({ event, fields }) });
  /** Which press's transcript came when, in order. */
  const order: string[] = [];
  const track = (name: string, p: Promise<string>) => p.then((text) => (order.push(name), text));
  return { clock, engine, stt, logged, order, track };
}

describe("pressed again before the last press has its words", () => {
  test("the Mac key again within the 300ms tail: the first press's words, then the second's, nothing cut", async () => {
    const { clock, engine, stt, logged, order, track } = setup();
    const a = stt.begin();
    a.send(w("run"));
    a.send(w("the"));
    a.send(w("tests"));
    // Let go: the tail runs (300ms). 120ms in, pressed again: the mic is the new press's now.
    await advance(clock, 120);
    const b = stt.begin();
    b.send(w("and"));
    b.send(w("the"));
    // The first press's tail ends: its words are finished, while the second is still held.
    await advance(clock, 180);
    const first = track("a", a.finish());
    b.send(w("linter"));
    await advance(clock, 100);
    assert.equal(await first, "run the tests");
    // The second press kept its audio while it waited, and has the engine now.
    b.send(w("too"));
    const second = track("b", b.finish());
    await advance(clock, 100);
    assert.equal(await second, "and the linter too");
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(engine.steps, ["begin", "run", "the", "tests", "finish", "= run the tests", "begin", "and", "the", "linter", "too", "finish", "= and the linter too"]);
    assert.deepEqual([a.audioSeconds(), b.audioSeconds()], [3, 4]);
    assert.deepEqual(
      logged.map((l) => l.event),
      ["stt_press_waits", "stt_press_starts"],
    );
    assert.equal(stt.pending, 0);
  });

  test("a phone press during the first press's ~100ms of transcription: its audio waits, then goes in order", async () => {
    const { clock, engine, stt, order, track } = setup();
    const a = stt.begin();
    a.send(w("bump"));
    a.send(w("the"));
    a.send(w("version"));
    const first = track("a", a.finish()); // the Mac press let go: transcribing
    await advance(clock, 30);
    const b = stt.begin(); // the phone's button
    b.send(w("and"));
    b.send(w("tag"));
    b.send(w("it"));
    const second = track("b", b.finish()); // a short press: up before the first has its words
    await advance(clock, 300);
    assert.deepEqual([await first, await second], ["bump the version", "and tag it"]);
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(
      engine.steps.filter((s) => s === "begin" || s.startsWith("=")),
      ["begin", "= bump the version", "begin", "= and tag it"],
    );
  });

  test("three quick presses: three transcripts, in the order they began", async () => {
    const { clock, stt, order, track } = setup();
    const presses = ["one", "two", "three"].map((word) => {
      const p = stt.begin();
      p.send(w(word));
      return track(word, p.finish());
    });
    await advance(clock, 400);
    assert.deepEqual(await Promise.all(presses), ["one", "two", "three"]);
    assert.deepEqual(order, ["one", "two", "three"]);
  });

  test("live words are the engine's press's, to that press only", async () => {
    const { clock, stt } = setup();
    const seen: string[] = [];
    const a = stt.begin((t) => seen.push(`a: ${t}`));
    a.send(w("hello"));
    const b = stt.begin((t) => seen.push(`b: ${t}`));
    b.send(w("world"));
    void a.finish();
    await advance(clock, 100);
    assert.deepEqual(seen, ["a: hello", "b: world"]);
    void b.finish();
    await advance(clock, 100);
  });

  test("audio after a press's end isn't the next press's", async () => {
    const { clock, engine, stt } = setup();
    const a = stt.begin();
    a.send(w("first"));
    const first = a.finish();
    const b = stt.begin();
    b.send(w("second"));
    a.send(w("late")); // the mic's last buffer, after finish()
    const second = b.finish();
    await advance(clock, 300);
    assert.deepEqual([await first, await second], ["first", "second"]);
    assert.ok(!engine.steps.includes("late"));
  });
});

describe("the next press is never held for good", () => {
  test("a press whose finish() never comes is finished after stuckMs once a newer one waits, and its words kept", async () => {
    const { clock, stt, logged } = setup(2000);
    const a = stt.begin();
    a.send(w("lost"));
    a.send(w("press"));
    await advance(clock, 5000); // alone, it may be held as long as you like
    const b = stt.begin();
    b.send(w("next"));
    const second = b.finish();
    await advance(clock, 1990);
    assert.equal(stt.pending, 2, "not yet");
    await advance(clock, 300);
    assert.equal(await second, "next");
    assert.equal(await a.finish(), "lost press", "its words, when its finish() comes");
    assert.deepEqual(
      logged.filter((l) => l.event === "stt_press_stuck").map((l) => l.fields.press),
      [a.id],
    );
  });

  test("a failed transcript fails its own press only: the next still gets its words", async () => {
    const { clock, engine, stt } = setup();
    const a = stt.begin();
    a.send(w("broken"));
    engine.fails = new Error("speech helper exited (1)");
    const first = a.finish();
    engine.fails = null;
    const b = stt.begin();
    b.send(w("fine"));
    const second = b.finish();
    await advance(clock, 300);
    await assert.rejects(first, /speech helper exited/);
    assert.equal(await second, "fine");
  });
});
