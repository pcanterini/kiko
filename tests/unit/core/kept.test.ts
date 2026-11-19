// Words kept when the router couldn't answer (src/core/kept.ts), 2026-11-12: retried with a growing
// wait until the router answers or the retries stop, in the order said, taken once, and gone when
// they run out.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { KEPT_MS, KeptWords, RETRY_FOR_MS, RETRY_MAX, RETRY_STEPS_MS } from "../../../src/core/kept.ts";
import { FakeClock } from "../../support/clock.ts";

function make() {
  const clock = new FakeClock();
  const kept = new KeptWords({ clock });
  const seen = { due: [] as number[], gaveUp: [] as string[][], expired: [] as string[][] };
  kept.onDue = () => seen.due.push(clock.t);
  kept.onGaveUp = (left) => seen.gaveUp.push(left.map((e) => e.text));
  kept.onExpired = (gone) => seen.expired.push(gone.map((e) => e.text));
  return { clock, kept, seen };
}

/** A retry that fails again each time it comes due, as offline. */
function failEachTime(kept: KeptWords) {
  kept.onDue = ((due) => () => {
    due();
    const e = kept.next();
    if (e) kept.failed(e);
  })(kept.onDue);
}

describe("retries", () => {
  test("2s, 5s, 10s, 20s, then every 30s, until RETRY_MAX tries: then held, and said once", () => {
    const { kept, clock, seen } = make();
    failEachTime(kept);
    kept.keep("one");
    clock.advance(RETRY_FOR_MS);
    const gaps = seen.due.map((t, i) => t - (seen.due[i - 1] ?? 0));
    assert.deepEqual(gaps, [2000, 5000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000]);
    assert.equal(seen.due.length, RETRY_MAX);
    assert.deepEqual(seen.gaveUp, [["one"]]);
    assert.equal(kept.retrying, false);
    assert.deepEqual(kept.pending(), { texts: ["one"] }, "still kept for send it");
    assert.equal(RETRY_STEPS_MS.length, 5);
  });

  test("the router answers: taken off the list once, and the retries are over", () => {
    const { kept, clock, seen } = make();
    kept.keep("one");
    clock.advance(2000);
    const e = kept.next()!;
    assert.equal(kept.next(), null, "never handed out twice");
    kept.sent(e);
    assert.equal(kept.pending(), null);
    assert.equal(kept.retrying, false);
    clock.advance(60_000);
    assert.equal(seen.due.length, 1);
  });

  test("the network back: the retry at once, not at its time", () => {
    const { kept, clock, seen } = make();
    kept.keep("one");
    clock.advance(500);
    kept.now();
    clock.advance(0);
    assert.deepEqual(seen.due, [500]);
  });

  test("in the order said: one put back after a failure stays ahead of newer ones", () => {
    const { kept, clock } = make();
    kept.keep("one", { at: 0 });
    clock.advance(100);
    kept.keep("two", { at: 100 });
    const e = kept.next()!;
    assert.equal(e.text, "one");
    kept.failed(e);
    assert.deepEqual(kept.pending()?.texts, ["one", "two"]);
  });

  test("kept without retries (talk.ts: anything else that failed): only send it or a name", () => {
    const { kept, clock, seen } = make();
    kept.keep("one", { retry: false });
    clock.advance(60_000);
    assert.deepEqual(seen.due, []);
    assert.equal(kept.retrying, false);
    assert.deepEqual(kept.pending()?.texts, ["one"]);
  });

  test("asked about (hold): no more retries for it, still kept", () => {
    const { kept, clock, seen } = make();
    kept.keep("one", { at: 0 });
    clock.advance(2000);
    const e = kept.next()!;
    kept.sent(e);
    kept.hold("one, as decided", e.at);
    clock.advance(60_000);
    assert.deepEqual(seen.due, [2000]);
    assert.deepEqual(kept.pending()?.texts, ["one, as decided"]);
  });
});

describe("kept words", () => {
  test("taken once: nothing is left to send twice, and the retries stop", () => {
    const { kept, clock, seen } = make();
    kept.keep("Apply these changes to main.");
    assert.deepEqual(
      kept.take().map((e) => e.text),
      ["Apply these changes to main."],
    );
    assert.equal(kept.pending(), null);
    assert.deepEqual(kept.take(), []);
    clock.advance(60_000);
    assert.deepEqual(seen.due, []);
  });

  test("the same words again: kept once", () => {
    const { kept, clock } = make();
    kept.keep("one");
    clock.advance(10);
    kept.keep("two");
    clock.advance(10);
    kept.keep("one");
    assert.deepEqual(kept.pending()?.texts, ["two", "one"]);
  });

  test("a yes or a pick sent them: no longer kept", () => {
    const { kept } = make();
    kept.keep("one");
    assert.equal(kept.remove("one"), true);
    assert.equal(kept.remove("one"), false);
    assert.equal(kept.pending(), null);
  });

  test("they run out KEPT_MS after they were said, told as they go", () => {
    const { kept, clock, seen } = make();
    kept.keep("one", { retry: false });
    clock.advance(60_000);
    kept.keep("two", { retry: false });
    clock.advance(KEPT_MS - 60_000);
    assert.deepEqual(seen.expired, [["one"]]);
    clock.advance(60_000);
    assert.deepEqual(seen.expired, [["one"], ["two"]]);
    assert.equal(kept.pending(), null);
    assert.equal(clock.pending(), 0, "no timer left");
  });

  test("at most five: the oldest goes", () => {
    const { kept, clock } = make();
    for (const n of [1, 2, 3, 4, 5]) {
      kept.keep(`m${n}`);
      clock.advance(1);
    }
    const dropped = kept.keep("m6");
    assert.deepEqual(
      dropped.map((e) => e.text),
      ["m1"],
    );
    assert.equal(kept.list().length, 5);
  });
});
