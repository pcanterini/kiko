// Words said inside a session's screen on the phone (decide's `to`): they go to that session as if
// you'd named it, without asking the classifier or the router; "stop" there stops it (at Voice can:
// Everything); "Kiko, …" up front still goes to the app.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { makeWorld } from "../../support/fixtures.ts";

const W = makeWorld([
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", status: "busy" },
  { name: "Clipkit", folder: "clipkit", given: "Clipkit", status: "idle" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, more: Partial<DecideState> = {}) {
  const calls = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      calls.classifier++;
      return { audience: S("Clipkit"), audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95, appParts: 0, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      calls.router++;
      return { text: "Sure.", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const d = await decide(
    {
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
      voiceCan: "everything",
      classifierMinConfidence: 0.75,
      ...more,
    },
    deps,
  );
  return { d, calls };
}

const lacy = () => ({ sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd });

test("in Lacy's screen, words go to Lacy as said, even when the classifier would pick another", async () => {
  const { d, calls } = await run("run the migrations", { to: lacy() });
  assert.equal(d.step, "addressed");
  assert.deepEqual(d.actions, [{ type: "send", session: lacy(), text: "run the migrations" }]);
  assert.deepEqual(calls, { classifier: 0, router: 0 });
});

test("outside a session's screen, the same words are decided as usual", async () => {
  const { d, calls } = await run("run the migrations");
  assert.equal(d.step, "classifier");
  assert.equal(calls.classifier, 1);
  assert.equal(d.actions[0].type === "send" && d.actions[0].session.sessionId, S("Clipkit").sessionId);
});

test('"stop" in its screen stops it, as "stop Lacy" would; refused below Everything', async () => {
  assert.deepEqual((await run("stop", { to: lacy() })).d.actions, [{ type: "stop", session: S("Lacy") }]);
  assert.deepEqual((await run("stop", { to: lacy(), voiceCan: "messages" })).d.actions, [{ type: "refused", what: "stop", session: S("Lacy"), then: { type: "stop", session: S("Lacy") } }]);
});

test('"Kiko, …" in a session\'s screen is for the app', async () => {
  const { d, calls } = await run("Kiko, what's running?", { to: lacy() });
  assert.equal(d.toApp, true);
  assert.equal(calls.router + calls.classifier > 0, true);
  assert.notEqual(d.step, "addressed");
});

test("a permission prompt waiting still takes the words as its answer, as a named session's would", async () => {
  const { d } = await run("yes", { to: lacy(), waiting: { ...lacy(), permission: "run pnpm db:migrate" } });
  assert.equal(d.step, "permission");
});
