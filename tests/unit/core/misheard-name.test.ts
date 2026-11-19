// A session's name heard wrong ("Macy", "Lazey", "Lazy" for Lacy): the router's clear guess goes
// as any guess does (said, held a moment); an uncertain one is asked about ("Did you mean Lacy?",
// router.ts confirm_session, decide.ts guard), and the answer acts on the words kept (decide.ts
// answerQuestion): yes sends them there, a name sends them to that one, no drops them. The case: a
// question for Lacy, its name heard as "Lazey", and a later mention of it as "Macy". When unsure, the
// router asks for a guess, you confirm it, and the words still go on from there.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, nameScore, type DecideDeps, type DecideState, type Question } from "../../../src/core/decide.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

// As the route prompt listed them: the Kiko project and Lacy.
const W = makeWorld([
  { name: "kiko", title: "Project notes", status: "busy", asked: "Yeah go ahead." },
  { name: "lacy", folder: "lacy-platform", given: "Lacy", status: "idle" },
]);
const S = (name: string) => W.byName.get(name)!;

type Stub = { router?: (s: (n: string) => Session) => Action[]; says?: string };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen = { router: 0 };
  const deps: DecideDeps = {
    utterance: async () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9, appParts: 0, model: "test", costUsd: 0, ms: 1 }),
    approval: null,
    route: async () => {
      seen.router++;
      return { text: opts.says ?? "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
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

const ASK = "What's next on this project? Give me a short status.";
// What goes of it: the sentence of the router's own left out (router-words.ts).
const ASK_SENT = "What's next on this project?";
const confirm =
  (message = ASK, heard = "Macy") =>
  (s: (n: string) => Session): Action[] => [{ name: "confirm_session", session: s("lacy"), heard, message }];

describe("an uncertain guess is asked about: 'Did you mean Lacy?'", () => {
  test("ask_session words: the router's message kept as the question's, Lacy the one offered, the guess logged", async () => {
    const { d, outcomes } = await run("Ask Macy what's next on that project.", { router: confirm() });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "Did you mean Lacy?" }]);
    assert.deepEqual(d.question, { kind: "asked", question: { text: ASK_SENT, offered: [S("lacy").sessionId], line: "Did you mean Lacy?" } });
    assert.equal(d.guess?.how, "asked");
    assert.equal(d.guess?.heard, "Macy");
    assert.equal(d.guess?.sessionId, S("lacy").sessionId);
    assert.ok(d.guess!.score > 0.5, String(d.guess?.score));
  });

  test("words to pass on: the user's own, less the name heard wrong", async () => {
    const { d } = await run("Macy, run the tests again.", { router: confirm("") });
    assert.equal(d.question?.kind === "asked" && d.question.question.text, "Run the tests again.");
  });

  test("the router asking it in its own words keeps the question too", async () => {
    const { d, outcomes } = await run("Ask Macy what's next.", { says: "Did you mean Lacy?" });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "Did you mean Lacy?" }]);
    assert.deepEqual(d.question?.kind === "asked" && d.question.question.offered, [S("lacy").sessionId]);
  });
});

describe("the answer acts on the words kept, never retyped", () => {
  const ASKED: Question = { text: ASK, offered: [S("lacy").sessionId], line: "Did you mean Lacy?" };
  const answer = (text: string) => run(text, { recent: ["you → app: Ask Macy what's next on that project.", "app said: Did you mean Lacy?"], appAsked: true, question: ASKED });

  test("yes: sent to Lacy, as kept; no router", async () => {
    for (const said of ["Yes.", "Yeah", "Yep, please.", "Yes please"]) {
      const { d, outcomes, seen } = await answer(said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(d.question, { kind: "answered", sessionId: S("lacy").sessionId, how: "yes" }, said);
      assert.deepEqual(outcomes, [{ action: "send", to: "Lacy", text: ASK, via: "terminal" }], said);
    }
  });

  test("its name: the same", async () => {
    for (const said of ["Lacy.", "Yes, Lacy.", "Lacy, please."]) {
      const { outcomes, seen } = await answer(said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(outcomes, [{ action: "send", to: "Lacy", text: ASK, via: "terminal" }], said);
    }
  });

  test("another one named: sent there instead", async () => {
    const { outcomes } = await answer("No, the Kiko project.");
    assert.deepEqual(outcomes, [{ action: "send", to: "Kiko project", text: ASK, via: "terminal" }]);
  });

  test("no: dropped, and said", async () => {
    for (const said of ["No.", "Nope", "No, thanks."]) {
      const { d, outcomes } = await answer(said);
      assert.deepEqual(d.question, { kind: "cancelled" }, said);
      assert.deepEqual(outcomes, [{ action: "say", text: "Okay, not sent." }], said);
    }
  });

  test("a yes to a 'which session?' with two offered picks nothing by itself", async () => {
    const which: Question = { text: ASK, offered: [S("lacy").sessionId, S("kiko").sessionId], line: "Which one, Lacy or Kiko project?" };
    const { d } = await run("Yes.", { recent: ["app said: Which one, Lacy or Kiko project?"], appAsked: true, question: which });
    assert.notEqual(d.question?.kind, "answered");
  });
});

describe("a clear guess goes, held a moment, and is logged", () => {
  test("'Ask, uh, Lazey, what's next on that project?': the router's ask_session to Lacy is a guess (said, held), Lazey logged", async () => {
    const { d, outcomes } = await run("Ask, uh, Lazey, what's next on that project?", {
      router: (s) => [{ name: "ask_session", session: s("lacy"), message: ASK }],
    });
    assert.deepEqual(outcomes, [{ action: "ask", to: "Lacy", message: ASK_SENT, via: "terminal", unsure: true }]);
    assert.deepEqual(d.guess, { heard: "lazey", sessionId: S("lacy").sessionId, how: "routed", score: nameScore("lazey", S("lacy")) });
  });

  test("its own name said: no guess", async () => {
    const { d } = await run("Ask Lacy what's next on that project?", { router: (s) => [{ name: "ask_session", session: s("lacy"), message: ASK }] });
    assert.equal(d.guess, undefined);
  });
});

describe("nameScore: how close a name said is, spelled as said", () => {
  test("the user's mishearings of Lacy are close; other words aren't", () => {
    for (const heard of ["Macy", "Macey", "Lazey", "Lazy", "Lucy"]) assert.ok(nameScore(heard, S("lacy")) > 0.5, `${heard}: ${nameScore(heard, S("lacy"))}`);
    assert.equal(nameScore("Lacy", S("lacy")), 1);
    for (const heard of ["project", "status", "deploy"]) assert.ok(nameScore(heard, S("lacy")) <= 0.5, `${heard}: ${nameScore(heard, S("lacy"))}`);
  });
});
