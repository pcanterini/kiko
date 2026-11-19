// A send the app wasn't sure of, held a moment (src/core/hold.ts), on a fake clock: when it goes on its
// own, what a press does to it, and what your next words do. HOLD_MS 100 and HOLD_ANSWER_MS 1000,
// as in the faked-app harness (tests/harness), which runs the same cases through the whole app.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Act, Decision, Sent } from "../../../src/core/decide.ts";
import { Hold } from "../../../src/core/hold.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { FakeClock } from "../../support/clock.ts";

const LACY = { sessionId: "lacy-1", cwd: "/p/lacy" };
const CLIPKIT = { sessionId: "snip-1", cwd: "/p/clipkit", name: "clipkit" } as unknown as Session;

function setup(pressed = false) {
  const clock = new FakeClock();
  const logs: Array<{ event: string } & Record<string, unknown>> = [];
  const info: string[] = [];
  const settled: Hold[] = [];
  const unanswered: Hold[] = [];
  const last: Sent = { sessionId: LACY.sessionId, folder: "lacy", text: "run the tests", held: true };
  clock.advance(5000);
  const hold = new Hold(
    { to: LACY, name: "lacy", text: "run the tests", why: "router", kind: "send", last, words: null, pressed },
    {
      holdMs: 100,
      answerMs: 1000,
      nameOf: (to) => (to.sessionId === CLIPKIT.sessionId ? "clipkit" : "lacy"),
      settled: (h) => settled.push(h),
      unanswered: (h) => unanswered.push(h),
      info: (text) => info.push(text),
      log: (event, fields) => logs.push({ event, ...fields }),
      changed: () => {},
      clock,
    },
  );
  let verdict: string | null = null;
  void hold.verdict.then((v) => (verdict = v));
  let gone = false;
  void hold.gone.then(() => (gone = true));
  return { hold, clock, logs, info, settled, unanswered, last, verdict: () => verdict, gone: () => gone };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const decision = (actions: Act[], more: Partial<Decision> = {}): Decision => ({ step: "router", text: "", actions, errors: [], classifierCostUsd: 0, llmCostUsd: 0, ...more });
const event = (h: ReturnType<typeof setup>) => h.logs.at(-1)!;

describe("on its own", () => {
  test("goes HOLD_MS after where it's going was heard", async () => {
    const h = setup();
    h.clock.advance(700); // "To Lacy." being said
    h.hold.heard();
    h.clock.advance(99);
    assert.ok(!h.hold.settled);
    h.clock.advance(1);
    await flush();
    assert.equal(h.verdict(), "send");
    assert.deepEqual(h.settled, [h.hold]);
    assert.deepEqual(event(h), { event: "send_released", sessionId: LACY.sessionId, name: "lacy", text: "run the tests", why: "router", kind: "send", heldMs: 800, after: "timer" });
    assert.ok(!h.gone(), "going out is holdIf's");
    h.hold.done();
    await flush();
    assert.ok(h.gone());
  });

  test("held with the key already down: it waits for your words, not the clock", () => {
    const h = setup(true);
    h.hold.heard();
    h.clock.advance(5000);
    assert.ok(!h.hold.settled);
  });

  test("decided once", () => {
    const h = setup();
    h.hold.settle("cancel", { by: "you" });
    h.hold.settle("send");
    assert.equal(h.logs.length, 1);
    assert.deepEqual(h.info, ["(not sent to lacy)"]);
  });
});

describe("a press while it's held", () => {
  test("stops the clock; with nothing said, it goes once you let go", async () => {
    const h = setup();
    h.hold.heard();
    h.clock.advance(50);
    h.hold.press();
    h.clock.advance(5000);
    assert.ok(!h.hold.settled);
    h.hold.afterWords();
    await flush();
    assert.equal(h.verdict(), "send");
    assert.equal(event(h).after, "your words");
  });

  test("before where it's going was heard: the clock never starts", () => {
    const h = setup();
    h.hold.press();
    h.hold.heard();
    h.clock.advance(5000);
    assert.ok(!h.hold.settled);
  });

  test("let go without a press: nothing happens", () => {
    const h = setup();
    h.hold.afterWords();
    assert.ok(!h.hold.settled);
  });
});

describe("your words while it's held", () => {
  test("'cancel': not sent, and the app says so", async () => {
    const h = setup(true);
    let noted = 0;
    const actions = await h.hold.settleWith(decision([{ type: "undo" }]), "cancel that", () => noted++);
    assert.deepEqual(actions, [{ type: "say", text: "Okay, not sent." }]);
    assert.equal(h.verdict(), "cancel");
    assert.deepEqual(event(h), { event: "send_cancelled", sessionId: LACY.sessionId, name: "lacy", text: "run the tests", why: "router", kind: "send", heldMs: 0, by: "you", said: "cancel that" });
    assert.equal(noted, 1, "your words noted: the router didn't");
    assert.ok(h.gone());
  });

  test("'cancel' through the router: it noted your words already", async () => {
    const h = setup(true);
    let noted = 0;
    await h.hold.settleWith(decision([{ type: "undo" }], { router: {} as Decision["router"] }), "cancel", () => noted++);
    assert.equal(noted, 0);
  });

  test("'no, clipkit': it goes there instead", async () => {
    const h = setup(true);
    const actions: Act[] = [{ type: "resend", session: CLIPKIT, last: h.last }];
    assert.equal(await h.hold.settleWith(decision(actions), "no, clipkit", () => {}), actions);
    assert.equal(h.verdict(), "redirect");
    assert.equal(event(h).event, "send_redirected");
    assert.equal(event(h).toSessionId, CLIPKIT.sessionId);
    assert.equal(event(h).toName, "clipkit");
    assert.ok(h.gone());
  });

  test("anything else: it goes first, then your words are dealt with", async () => {
    const h = setup(true);
    const actions: Act[] = [{ type: "say", text: "It's 3pm." }];
    let after: Act[] | null = null;
    void h.hold.settleWith(decision(actions), "what time is it", () => {}).then((a) => (after = a));
    await flush();
    assert.equal(h.verdict(), "send");
    assert.equal(event(h).said, "what time is it");
    assert.equal(after, null, "not until it's out");
    h.hold.done();
    await flush();
    assert.equal(after, actions);
  });

  test("a resend about something else isn't about it: it goes first", async () => {
    const h = setup(true);
    const other: Sent = { ...h.last };
    void h.hold.settleWith(decision([{ type: "resend", session: CLIPKIT, last: other }]), "no, clipkit", () => {});
    await flush();
    assert.equal(h.verdict(), "send");
  });
});

describe("'wrong one', without saying where", () => {
  test("kept while the app asks; unanswered, it doesn't go", async () => {
    const h = setup(true);
    await h.hold.settleWith(decision([{ type: "say", text: "Which session was it for?" }], { correction: true }), "wrong one", () => {});
    assert.ok(h.hold.asking);
    assert.ok(!h.hold.pressed);
    assert.deepEqual(event(h), { event: "send_held", sessionId: LACY.sessionId, name: "lacy", text: "run the tests", why: "router", kind: "send", waitingFor: "where it goes", said: "wrong one" });
    h.clock.advance(999);
    assert.ok(!h.hold.settled);
    h.clock.advance(1);
    await flush();
    assert.equal(h.verdict(), "cancel");
    assert.equal(event(h).by, "unanswered");
    assert.deepEqual(h.unanswered, [h.hold]);
  });

  test("then where: it goes there, and the question's clock stops", async () => {
    const h = setup(true);
    await h.hold.settleWith(decision([], { correction: true }), "wrong one", () => {});
    h.hold.press();
    await h.hold.settleWith(decision([{ type: "resend", session: CLIPKIT, last: h.last }]), "clipkit", () => {});
    assert.equal(h.verdict(), "redirect");
    h.clock.advance(5000);
    assert.deepEqual(h.unanswered, []);
  });

  test("then something else: it doesn't go", async () => {
    const h = setup(true);
    await h.hold.settleWith(decision([], { correction: true }), "wrong one", () => {});
    await h.hold.settleWith(decision([{ type: "say", text: "Sure." }]), "never mind, what time is it", () => {});
    assert.equal(h.verdict(), "cancel");
    assert.equal(event(h).by, "moved on");
  });

  test("'To Lacy.' heard only after 'wrong one' was dealt with: it still waits for where, and never goes", async () => {
    const h = setup(true);
    await h.hold.settleWith(decision([], { correction: true }), "wrong one", () => {});
    h.hold.heard(); // the line's wait checks every 20ms: it can notice the press this late
    h.clock.advance(100);
    assert.ok(!h.hold.settled, "the hold's clock didn't take over from the question's");
    h.clock.advance(900);
    await flush();
    assert.equal(h.verdict(), "cancel");
    assert.equal(event(h).by, "unanswered");
    assert.equal(h.logs.filter((l) => l.event === "send_released").length, 0);
  });

  test("then a press with nothing said: it doesn't go", async () => {
    const h = setup(true);
    await h.hold.settleWith(decision([], { correction: true }), "wrong one", () => {});
    h.hold.press();
    h.hold.afterWords();
    await flush();
    assert.equal(h.verdict(), "cancel");
    assert.equal(event(h).by, "unanswered");
    assert.deepEqual(h.unanswered, [], "said nothing: no line about it");
  });
});
