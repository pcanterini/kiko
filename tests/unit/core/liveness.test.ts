// Liveness checks (src/core/routing-rules.ts livenessCheck, decide.ts): "Can you hear me?", "Are you
// there?", "Testing." are the app's to answer, at once and with no model, whoever you dealt with last,
// is waiting or just spoke; before, the classifier could send them to the session that had just spoken,
// or to the one dealt with last even when said to the app by name. Words that only start that way, or
// name a session, are still a session's.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { livenessCheck, livenessLine } from "../../../src/core/routing-rules.ts";
import { makeWorld } from "../../support/fixtures.ts";

const W = makeWorld([
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates", status: "idle", asked: "Is anything still in progress?", said: "Nothing is in progress." },
  { name: "api", folder: "api", title: "Endpoint tests", status: "idle", asked: "Add the endpoint.", said: "The endpoint is added." },
  { name: "test", folder: "test", title: "Scratch tests", status: "idle", asked: "Run it.", said: "Done." },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

const HEAR = new Set(["Yes, I hear you.", "Loud and clear.", "I hear you.", "Yep, I can hear you."]);
const HERE = new Set(["I'm here.", "Yes, I'm here.", "Still here.", "Here."]);

async function run(text: string, opts: Partial<DecideState> = {}) {
  const calls = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    // A classifier sure the words are Lacy's, as it was when such checks went there.
    utterance: async () => {
      calls.classifier++;
      return { audience: S("Lacy"), audienceConfidence: 0.92, intent: "message", intentConfidence: 0.97, appParts: 0.05, model: "test", costUsd: 0, ms: 1 };
    },
    approval: async () => ({ answer: "unclear", confidence: 0.9, costUsd: 0, ms: 1 }),
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
    lastId: S("Lacy").sessionId,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  return { ...(await decide(state, deps)), calls };
}

const said = (d: Awaited<ReturnType<typeof run>>) => {
  assert.equal(d.actions.length, 1);
  const a = d.actions[0];
  assert.equal(a.type, "say");
  assert.equal(a.type === "say" && a.why, "liveness");
  return a.type === "say" ? a.text : "";
};

describe("livenessCheck: only words that are nothing but a check", () => {
  const hear = [
    "Can you hear me?",
    "Can you hear me, still?",
    "Can you hear me, okay?",
    "Can you still hear me?",
    "Hey, can you actually hear me?",
    "What's up? Can you hear me?",
    "Hey. You hear me",
    "One more time. Can you hear me?",
    "I'm just testing. Can you hear me?",
    "Just testing.",
    "Testing, testing.",
    "Testing one, two, three, four, five.",
    "Test 123",
    "Mic check.",
    "Is this thing on?",
    "Is this working?",
    "Can you hear me, Kiko?",
  ];
  for (const t of hear) test(`${JSON.stringify(t)}: hear`, () => assert.equal(livenessCheck(t), "hear"));
  for (const t of ["Are you there?", "You there?", "Are you still there?", "Are you listening?", "Hello?", "Hello, hello.", "Anyone there?"]) {
    test(`${JSON.stringify(t)}: here`, () => assert.equal(livenessCheck(t), "here"));
  }
  const not = [
    "Testing the api endpoint now.",
    "Can you hear the audio in the video?",
    "Api, are you there?",
    "Lacy, can you hear me?",
    "Can you hear me? Also fix the build.",
    "testing, linting, a blocker for shipping the other parts, or?",
    "Testing the new mic setting. No need to pass this on. Just say whether, um, you can hear me.",
    "Two open projects. Can you hear me?",
    "Are you there? Are you deciding?",
    "Is it working?",
    "Are you working on it?",
    "Did you get that?",
    "Hello.",
    "Yes.",
    "",
  ];
  for (const t of not) test(`${JSON.stringify(t)}: not a check`, () => assert.equal(livenessCheck(t), null));
  test("a part that's a session's name makes it that session's", () => {
    assert.equal(livenessCheck("Test, are you there?"), "hear");
    assert.equal(
      livenessCheck("Test, are you there?", (p) => p === "test"),
      null,
    );
  });
  test("the answers vary, and fit the check", () => {
    assert.notEqual(livenessLine("hear", 0), livenessLine("hear", 1));
    for (let n = 0; n < 8; n++) {
      assert.ok(HEAR.has(livenessLine("hear", n)));
      assert.ok(HERE.has(livenessLine("here", n)));
    }
  });
});

describe("decide: the app answers a liveness check, with no model", () => {
  test('"Can you hear me, still?" right after Lacy spoke: the app answers, nothing is sent', async () => {
    const d = await run("Can you hear me, still?", { justSpoke: { id: S("Lacy").sessionId, secondsAgo: 26 } });
    assert.equal(d.step, "liveness");
    assert.ok(HEAR.has(said(d)));
    assert.deepEqual(d.calls, { classifier: 0, router: 0 });
  });
  test('"Hey Kiko, just testing.", said to the app by name: the app answers', async () => {
    const d = await run("Hey Kiko, just testing.");
    assert.equal(d.step, "liveness");
    assert.equal(d.toApp, true);
    assert.ok(HEAR.has(said(d)));
  });
  test('"Are you there?" with Lacy waiting for a reply: "I\'m here", and Lacy still waits', async () => {
    const d = await run("Are you there?", { waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd } });
    assert.equal(d.step, "liveness");
    assert.ok(HERE.has(said(d)));
    assert.deepEqual(d.calls, { classifier: 0, router: 0 });
  });
  test("said inside a session's screen: still the app's", async () => {
    const d = await run("Can you hear me?", { to: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd } });
    assert.equal(d.step, "liveness");
  });
  test("twice in a row: not the same words twice", async () => {
    const a = said(await run("Can you hear me?"));
    const b = said(await run("Can you hear me?"));
    assert.notEqual(a, b);
  });
  test("a permission prompt waiting: the words answer it, as before", async () => {
    const d = await run("Can you hear me?", { waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd, permission: "run: rm -rf build" } });
    assert.equal(d.step, "permission");
  });
});

describe("decide: words that only start like a check, or name a session, are a session's", () => {
  test('"Api, are you there?": named up front, it goes to api', async () => {
    const d = await run("Api, are you there?");
    assert.equal(d.step, "addressed");
    assert.equal(d.actions[0].type === "send" && d.actions[0].session.sessionId, S("api").sessionId);
  });
  test('"Test, are you there?" with a session called test: not the app\'s', async () => {
    const d = await run("Test, are you there?");
    assert.notEqual(d.step, "liveness");
  });
  for (const t of ["Testing the api endpoint now.", "Can you hear the audio in the video?", "Can you hear me? Also fix the build."]) {
    test(`${JSON.stringify(t)}: the classifier's, sent on`, async () => {
      const d = await run(t);
      assert.equal(d.step, "classifier");
      assert.equal(d.calls.classifier, 1);
      assert.equal(d.actions[0].type, "send");
    });
  }
});
