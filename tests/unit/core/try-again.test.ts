// "Try again" after your words couldn't reach a session (src/core/decide.ts `retry`, app.ts
// notReached): the same words go to the same session, read in code. A status question
// for Lacy wasn't typed in (its terminal was on Claude Code's agents list), and had to be asked again
// in full.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { TRY_AGAIN } from "../../../src/core/routing-rules.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "lacy", folder: "lacy-platform", given: "Lacy", status: "idle" },
  { name: "kiko", title: "Voice app notes and settings", status: "busy" },
]);
const LACY = W.byName.get("lacy")!;
const WORDS = "What's next on this project? Give me a short status.";
const RETRY = { session: { sessionId: LACY.sessionId, cwd: LACY.cwd }, text: WORDS };

async function run(text: string, opts: Partial<DecideState> = {}) {
  const seen = { router: 0 };
  const deps: DecideDeps = {
    utterance: async () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9, appParts: 0, model: "test", costUsd: 0, ms: 1 }),
    approval: null,
    route: async () => {
      seen.router++;
      return { text: "Try what again?", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
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
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state).map(({ sessionId: _id, ...o }) => o), seen };
}

describe("'try again' after words that didn't reach a session", () => {
  test("the same words, to the same session, as they were: no router", async () => {
    for (const said of ["Try again.", "Okay, try again", "try that again please", "Send it again.", "Resend it.", "Retry."]) {
      const { d, outcomes, seen } = await run(said, { retry: RETRY });
      assert.equal(d.step, "retry", said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(outcomes, [{ action: "send", to: "Lacy", text: WORDS, via: "terminal" }], said);
    }
  });

  test("nothing kept: words like any others", async () => {
    const { d, seen } = await run("Try again.");
    assert.notEqual(d.step, "retry");
    assert.equal(seen.router, 1);
  });

  test("a finished turn waiting: it's that session's reply ('the build failed' … 'try again')", async () => {
    const kiko = W.byName.get("kiko")!;
    const { d, outcomes } = await run("Try again.", { retry: RETRY, waiting: { sessionId: kiko.sessionId, cwd: kiko.cwd } });
    assert.notEqual(d.step, "retry");
    assert.ok(!outcomes.some((o) => "to" in o && o.to === "Lacy"), JSON.stringify(outcomes));
  });

  test("only the request itself: 'try again with the other API' is words for a session", () => {
    for (const no of ["Try again with the other API.", "Can you try again later?", "I'll try again tomorrow.", "Try it."]) assert.equal(TRY_AGAIN.test(no), false, no);
  });
});
