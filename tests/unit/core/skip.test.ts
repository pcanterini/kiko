// "Skip that" (src/core/decide.ts, routing-rules.ts SKIP): while an announcement you haven't heard waits
// (your press put it back, or it's next in line: floor.ts skippable), it isn't made. Only "skip"
// phrases, only then, and never a cancel of a held send, or the other way round.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState, type Sent } from "../../../src/core/decide.ts";
import { HELD_CANCEL, SKIP } from "../../../src/core/routing-rules.ts";
import { makeWorld } from "../../support/fixtures.ts";

const W = makeWorld([
  { name: "Kiko", folder: "kiko", given: "Kiko", title: "Voice app", status: "idle", asked: "Is there a time limit?" },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates", status: "idle", asked: "Is anything still in progress?" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, opts: Partial<DecideState> = {}) {
  const calls = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      calls.classifier++;
      return { audience: S("Lacy"), audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      calls.router++;
      return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  return { ...(await decide(state, deps)), calls };
}

const SKIPS = ["Skip that.", "skip it", "Skip.", "Okay, skip it.", "Just skip that one.", "No, skip this.", "Skip it, please.", "Kiko, skip that."];

describe('"skip that" with an announcement you haven\'t heard waiting', () => {
  for (const said of SKIPS) {
    test(`${JSON.stringify(said)}: skipped, no models`, async () => {
      const d = await run(said, { skippable: true });
      assert.equal(d.step, "skip");
      assert.deepEqual(d.actions, [{ type: "skip" }]);
      assert.deepEqual(d.calls, { classifier: 0, router: 0 });
    });
  }

  test('nothing to skip: words like any others (a session\'s question, "…or skip it?")', async () => {
    const d = await run("Skip it.", { skippable: false });
    assert.notEqual(d.step, "skip");
    assert.ok(!d.actions.some((a) => a.type === "skip"));
  });

  test("a permission prompt waiting takes the words as its answer, as before", async () => {
    const d = await run("Skip that.", { skippable: true, waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd, permission: "run the tests" } });
    assert.equal(d.step, "permission");
  });

  test('requests with "skip" in them aren\'t a skip', () => {
    for (const said of ["Skip the flaky test.", "Skip it and run the rest.", "Don't skip it.", "Can you skip that test?", "Skip the migration for now and deploy."]) {
      assert.ok(!SKIP.test(said), said);
    }
  });

  test('"never mind", "stop" and "cancel" aren\'t a skip: they take back, cut off, or drop a held send', () => {
    for (const said of ["Never mind.", "Stop.", "Stop that.", "Cancel.", "Cancel that.", "Scratch that."]) assert.ok(!SKIP.test(said), said);
  });

  test('with a send held: "cancel" drops the send, not an announcement; "skip that" skips the announcement, not the send', async () => {
    const held: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests.", held: true };
    const cancel = await run("Cancel that.", { skippable: true, holding: true, lastSent: held });
    assert.equal(cancel.step, "held-cancel");
    assert.deepEqual(cancel.actions, [{ type: "undo" }]);
    const skip = await run("Skip that.", { skippable: true, holding: true, lastSent: held });
    assert.equal(skip.step, "skip");
    assert.deepEqual(skip.actions, [{ type: "skip" }]);
    for (const said of SKIPS) assert.ok(!HELD_CANCEL.test(said), said);
  });
});
