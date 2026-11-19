// A model call made a second time when the first is slow or fails (src/core/hedge.ts), with fake
// attempts on short timers: the first answer is taken once and the other cut off, a fast failure
// retries at once, a bad request doesn't, and when nothing answers it fails with every try said.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hedged, HedgeError, retryable } from "../../../src/core/hedge.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An attempt that answers `value` after `ms`, or rejects when its signal aborts first (`honour`: false answers anyway). */
function answers<T>(value: T, ms: number, honour = true) {
  return (signal: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), ms);
      if (honour) signal.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Aborted", "AbortError"))), { once: true });
    });
}
/** An attempt that never answers until it's cut off. */
const hangs = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
/** An attempt that fails after `ms` with `err`. */
const fails =
  (err: unknown, ms = 5) =>
  () =>
    new Promise<never>((_, reject) => setTimeout(() => reject(err), ms));

const TIMING = { hedgeMs: 60, attemptMs: 400 };

describe("hedged: the first answer, once", () => {
  test("an answer before the hedge: one request, no second", async () => {
    let started = 0;
    const r = await hedged((signal) => (started++, answers("first", 10)(signal)), TIMING);
    assert.equal(r.value, "first");
    assert.equal(r.won, 1);
    assert.equal(started, 1);
    assert.deepEqual(
      r.tries.map((t) => t.how),
      ["won"],
    );
    await sleep(TIMING.hedgeMs + 20);
    assert.equal(started, 1, "no hedge after an answer");
  });

  test("a slow first: the hedge starts at hedgeMs, answers, and the first is cut off", async () => {
    const signals: AbortSignal[] = [];
    const r = await hedged((signal, n) => (signals.push(signal), n === 1 ? hangs(signal) : answers("second", 10)(signal)), TIMING);
    assert.equal(r.value, "second");
    assert.equal(r.won, 2);
    assert.ok(r.tries[1].startMs >= TIMING.hedgeMs - 5, `the hedge started at ${r.tries[1].startMs}ms`);
    assert.deepEqual(
      r.tries.map((t) => t.how),
      ["lost", "won"],
    );
    assert.equal(signals[0].aborted, true, "the first is cut off");
    assert.equal(signals[1].aborted, false);
  });

  test("both answer: only the first answer is used, the late one is dropped", async () => {
    let taken = 0;
    // The first ignores its abort and answers anyway, after the hedge's.
    const run = (signal: AbortSignal, n: number) => (n === 1 ? answers({ n: 1 }, 150, false)(signal) : answers({ n: 2 }, 20)(signal));
    const r = await hedged(run, TIMING).then((x) => (taken++, x));
    assert.deepEqual(r.value, { n: 2 });
    await sleep(200);
    assert.equal(taken, 1);
    assert.deepEqual(
      r.tries.map((t) => t.how),
      ["lost", "won"],
      "the late answer doesn't change the tries",
    );
  });

  test("the first answers after the hedge started but before it: the first is taken, the hedge cut off", async () => {
    const signals: AbortSignal[] = [];
    const r = await hedged((signal, n) => (signals.push(signal), n === 1 ? answers("first", 100)(signal) : answers("second", 300)(signal)), TIMING);
    assert.equal(r.value, "first");
    assert.equal(r.won, 1);
    assert.equal(signals[1].aborted, true);
  });

  test("note: what an attempt notes goes on its line", async () => {
    const r = await hedged(async (_signal, n, note) => (note({ requestId: `req_${n}` }), "ok"), TIMING);
    assert.deepEqual(r.tries[0].info, { requestId: "req_1" });
  });
});

describe("hedged: failures", () => {
  test("a fast failure worth retrying: the second starts at once, not at the hedge", async () => {
    const r = await hedged((signal, n) => (n === 1 ? fails(Object.assign(new Error("overloaded"), { status: 529 }))() : answers("second", 5)(signal)), TIMING);
    assert.equal(r.value, "second");
    assert.ok(r.tries[1].startMs < TIMING.hedgeMs, `retried at ${r.tries[1].startMs}ms`);
    assert.equal(r.tries[0].how, "failed");
    assert.equal(r.tries[0].error, "overloaded");
  });

  test("a bad request (400): given up on at once, no second try", async () => {
    let started = 0;
    const bad = Object.assign(new Error("invalid_request_error"), { status: 400 });
    await assert.rejects(
      hedged(() => (started++, fails(bad)()), TIMING),
      (err) => err === bad,
    );
    await sleep(TIMING.hedgeMs + 20);
    assert.equal(started, 1);
  });

  test("a time limit before the hedge's wait: the second starts when the first is cut off", async () => {
    const r = await hedged((signal, n) => (n === 1 ? hangs(signal) : answers("second", 5)(signal)), { hedgeMs: 1000, attemptMs: 50 });
    assert.equal(r.value, "second");
    assert.equal(r.tries[0].how, "timeout");
    assert.ok(r.tries[1].startMs >= 45 && r.tries[1].startMs < 200, `second at ${r.tries[1].startMs}ms`);
  });

  test("neither answers: a HedgeError naming both tries, after the hedge's wait plus one time limit", async () => {
    const t0 = performance.now();
    const err = await hedged((signal) => hangs(signal), { hedgeMs: 40, attemptMs: 120 }).catch((e) => e);
    const took = performance.now() - t0;
    assert.ok(err instanceof HedgeError);
    assert.equal(err.message, "no answer: 2 tries, 120ms each");
    assert.deepEqual(
      err.tries.map((t: { how: string }) => t.how),
      ["timeout", "timeout"],
    );
    assert.ok(took >= 155 && took < 400, `gave up after ${Math.round(took)}ms`);
  });

  test("both fail: a HedgeError with each error", async () => {
    const err = await hedged(fails(new Error("fetch failed")), TIMING).catch((e) => e);
    assert.ok(err instanceof HedgeError);
    assert.deepEqual(
      err.tries.map((t: { error?: string }) => t.error),
      ["fetch failed", "fetch failed"],
    );
  });

  test("cancelled from outside: every attempt is cut off and it rejects with the abort", async () => {
    const outer = new AbortController();
    const signals: AbortSignal[] = [];
    const p = hedged((signal) => (signals.push(signal), hangs(signal)), { ...TIMING, signal: outer.signal });
    await sleep(TIMING.hedgeMs + 20);
    outer.abort();
    await assert.rejects(p);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((s) => s.aborted));
  });

  test("retryable: 5xx, 408, 409, 429 and network errors are; other 4xx aren't", () => {
    for (const status of [500, 529, 408, 409, 429]) assert.equal(retryable({ status }), true, String(status));
    for (const status of [400, 401, 403, 404, 413]) assert.equal(retryable({ status }), false, String(status));
    assert.equal(retryable(new TypeError("fetch failed")), true);
  });
});
