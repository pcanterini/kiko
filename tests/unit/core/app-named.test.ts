// A session named like the app (src/core/sessions.ts appNamed, namedLikeAppName; src/core/wake.ts).
// With a session in the kiko folder listed as "Kiko", a test message addressed "To Kiko, …" went to
// the router as said, which picked that session (pass_on s2), and the trim typed only the message's
// last sentence into it. So the session is "Kiko project", and "Kiko, …" up front means the app.
// But a direction before the name ("To, uh, Kiko. …", "Tell Kiko to …") names who the words are for:
// once, "To, uh, Kiko. …", a question about the app's setup screen, was taken as the app's name, the
// "To" with it, and the router gave the rest to Rowan, the session dealt with last. Now a direction
// goes to the session named like the app, whole, in code; "Kiko, …" still means the app, and the
// router is told the name is that session's too (<name_up_front>).
import "../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { setSpokenName } from "../../../src/core/name.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { directedAtName } from "../../../src/core/wake.ts";
import { makeWorld, type World } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

afterEach(() => setSpokenName(undefined));

// As the route prompt listed them then, more or less.
const W = makeWorld([
  { name: "lacy", folder: "lacy-platform", given: "Lacy", status: "idle" },
  { name: "kiko", title: "Project notes", status: "idle", asked: "Is the phone build ready?" },
]);

type RouteInput = Parameters<DecideDeps["route"]>[0];

async function run(text: string, opts: { world?: World; lastId?: string; classifier?: string; router?: (s: (n: string) => Session) => Action[] } = {}) {
  const world = opts.world ?? W;
  const S = (name: string) => world.byName.get(name)!;
  const seen = { classifier: [] as string[], router: [] as string[], routed: [] as RouteInput[] };
  const deps: DecideDeps = {
    utterance: async (input) => {
      seen.classifier.push(input.text);
      const audience = opts.classifier ? S(opts.classifier) : "app";
      return { audience, audienceConfidence: opts.classifier ? 0.95 : 0.3, intent: "message", intentConfidence: 0.95, appParts: 0, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async (input) => {
      seen.router.push(input.text);
      seen.routed.push(input);
      return { text: "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: world.sessions,
    notes: world.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: opts.lastId ?? null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
  };
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state), seen };
}

const sends = (outcomes: Awaited<ReturnType<typeof run>>["outcomes"]) => outcomes.map((o) => [o.action, "to" in o ? o.to : null, "text" in o ? o.text : null]);

describe("'Kiko, …' up front means the app, with a session called Kiko", () => {
  test("'Kiko, …': the name is taken off, and the rest goes as it would without it", async () => {
    for (const [said, rest] of [
      ["Kiko, what's everyone doing?", "What's everyone doing?"],
      ["Hey Kiko, read me the last reply.", "Read me the last reply."],
    ]) {
      const named = await run(said);
      const plain = await run(rest);
      assert.equal(named.d.toApp, true, said);
      assert.equal(named.d.text, rest, said);
      assert.equal(named.d.step, plain.d.step, said);
      assert.deepEqual(named.outcomes, plain.outcomes, said);
      assert.ok(!named.outcomes.some((o) => "to" in o), `${said}: ${JSON.stringify(named.outcomes)}`);
    }
  });

  // A request for the Kiko project, named up front but misheard (the dictionary wrote "Kiko"),
  // asking it to check its history, went to the router, which answered it itself with made-up limits
  // instead of passing it on.
  test("'To a Kiko project, …', 'To the Kiko project, …', 'Kiko project, …': the session, named up front: no router", async () => {
    for (const [said, rest] of [
      ["to a Kiko project. It looks like the reply went to Macy. Check the last 10 messages in the history.", "It looks like the reply went to Macy. Check the last 10 messages in the history."],
      ["To the Kiko project, check the last 10 messages in the history.", "Check the last 10 messages in the history."],
      ["Kiko project, check the last 10 messages in the history.", "Check the last 10 messages in the history."],
      ["To, uh, the Kiko project: run the tests.", "Run the tests."],
      ["Uh, to a Kiko session, run the tests.", "Run the tests."],
    ]) {
      const { d, outcomes, seen } = await run(said);
      assert.equal(d.toApp, undefined, said);
      assert.equal(d.step, "addressed", said);
      assert.deepEqual(seen.router, [], said);
      assert.deepEqual(sends(outcomes), [["send", "Kiko project", rest]], said);
    }
  });

  test("'To <name>, …' with small fillers is said to that session: 'To Lacy, …', 'To, uh, Lacy. …'", async () => {
    for (const said of ["To Lacy, what's next on the project?", "To, uh, Lacy. What's next on the project?", "To the Lacy session, what's next on the project?"]) {
      const { d, outcomes, seen } = await run(said);
      assert.equal(d.step, "addressed", said);
      assert.deepEqual(seen.router, [], said);
      assert.deepEqual(sends(outcomes), [["send", "Lacy", "What's next on the project?"]], said);
    }
  });

  test("'the Kiko project' / 'the Kiko session' is the session, named: no router", async () => {
    for (const said of ["Tell the Kiko project to run the tests.", "Tell the Kiko session to run the tests."]) {
      const { d, outcomes, seen } = await run(said);
      assert.equal(d.toApp, undefined, said);
      assert.deepEqual(seen.router, [], said);
      assert.deepEqual(
        outcomes.map((o) => [o.action, "to" in o ? o.to : null]),
        [["send", "Kiko project"]],
        said,
      );
    }
  });
});

// The sessions then: s1 Kiko project (folder kiko), s2 Rowan, s3 Bobby; Rowan dealt with last.
const LOGGED = makeWorld([
  { name: "kiko", title: "Settings screen copy", status: "idle" },
  { name: "rowan", folder: "rowan-platform", given: "Rowan", status: "idle" },
  { name: "bobby", folder: "2026-11-03-bobby", given: "Bobby", status: "idle" },
]);
const ROWAN = LOGGED.byName.get("rowan")!.sessionId;
const SAID =
  "To, uh, Kiko. Um, A little unsure how, uh, how we handle the setup screen in the release build, right? Do we show the import step? Do we let the user skip it? They don't have anything to import yet. So I'm curious, uh, which parts we keep.";
const REST =
  "Um, A little unsure how, uh, how we handle the setup screen in the release build, right? Do we show the import step? Do we let the user skip it? They don't have anything to import yet. So I'm curious, uh, which parts we keep.";

describe("a direction before the app's name is to the session named like it", () => {
  test("the incident: 'To, uh, Kiko. …' goes to the Kiko project, whole, never Rowan, with no router", async () => {
    const { d, outcomes, seen } = await run(SAID, { world: LOGGED, lastId: ROWAN, router: (s) => [{ name: "pass_on", session: s("rowan") }] });
    assert.equal(d.toApp, undefined);
    assert.equal(d.step, "addressed");
    assert.deepEqual(seen.router, []);
    assert.deepEqual(sends(outcomes), [["send", "Kiko project", REST]]);
    const send = d.actions[0];
    assert.ok(send.type === "send" && send.trimmed?.by === "phrase");
    assert.deepEqual(send.type === "send" && send.trimmed?.dropped, ["To, uh, Kiko."], "the direction is in what was cut, with the name");
  });

  test("'tell Kiko to run the tests', 'To Kiko, …', 'For Kiko: …', 'Ask Kiko to …', 'Send this to Kiko: …', 'This is for Kiko. …': the Kiko project", async () => {
    for (const [said, rest] of [
      ["Tell Kiko to run the tests.", "Run the tests."],
      ["tell Kiko to run the tests", "Run the tests"],
      ["To Kiko, this is a quick check from the laptop. Tell me if it arrives.", "This is a quick check from the laptop. Tell me if it arrives."],
      ["Okay, to, um, Kiko: run the tests.", "Run the tests."],
      ["For Kiko: run the tests.", "Run the tests."],
      ["Ask Kiko to run the tests.", "Run the tests."],
      ["Can you tell Kiko that the build is green?", "The build is green?"],
      ["Send this to Kiko: run the tests.", "Run the tests."],
      ["This is for Kiko. Run the tests.", "Run the tests."],
      ["Tell Kiko I'm back.", "I'm back."],
      ["To Kiku, run the tests.", "Run the tests."],
    ]) {
      const { d, outcomes, seen } = await run(said, { world: LOGGED, lastId: ROWAN });
      assert.equal(d.toApp, undefined, said);
      assert.equal(d.step, "addressed", said);
      assert.deepEqual(seen.router, [], said);
      assert.deepEqual(sends(outcomes), [["send", "Kiko project", rest]], said);
    }
  });

  test("what the direction and name were, and what's after: 'To, uh, Kiko.' with the 'To', never dropped unseen", () => {
    assert.deepEqual(directedAtName(SAID), { said: "To, uh, Kiko.", rest: REST });
    assert.deepEqual(directedAtName("Tell Kiko to run the tests."), { said: "Tell Kiko to", rest: "Run the tests." });
    for (const said of [
      "Kiko, run the tests.",
      "Hey Kiko, run the tests.",
      "To Kiko.",
      "Tell Kiko's session to run the tests.",
      "To Kiko project, run the tests.",
      "Ask Kiko if it deployed.",
      "Tell the Kiko-dev one to run it.",
    ]) {
      assert.equal(directedAtName(said), null, said);
    }
  });

  test("'Kiko, ask Rowan if it deployed': the app's, to Rowan, as before", async () => {
    const { d, outcomes } = await run("Kiko, ask Rowan if it deployed.", { world: LOGGED, lastId: ROWAN });
    assert.equal(d.toApp, true);
    assert.equal(d.text, "Ask Rowan if it deployed.");
    assert.equal(d.nameAlso, undefined, "the rest names a session: no hint");
    assert.ok(!outcomes.some((o) => "to" in o && o.to === "Kiko project"), JSON.stringify(outcomes));
  });

  test("'Tell Kiko to ask Rowan if it deployed': the rest is for Rowan by name, so the app's, as before", async () => {
    const { d } = await run("Tell Kiko to ask Rowan to check the deploy.", { world: LOGGED, lastId: ROWAN });
    assert.equal(d.toApp, true);
    assert.equal(d.nameSaid, "Tell Kiko to");
  });

  test("'Kiko.' alone: only the name, nothing said, as before", async () => {
    const { d, seen } = await run("Kiko.", { world: LOGGED, lastId: ROWAN });
    assert.equal(d.step, "name-only");
    assert.equal(d.toApp, true);
    assert.deepEqual(seen.router, []);
  });

  test("'Kiko, …' with a session called Kiko: the app's, and the router is told the name is that session's too", async () => {
    const { d, seen } = await run("Kiko, how do we handle the setup screen in the release build?", { world: LOGGED, lastId: ROWAN });
    assert.equal(d.toApp, true);
    assert.equal(d.nameSaid, "Kiko,");
    assert.deepEqual(d.nameAlso, [LOGGED.byName.get("kiko")!.sessionId]);
    assert.deepEqual(
      seen.routed.map((r) => r.nameAlso?.map((x) => x.sessionId)),
      [[LOGGED.byName.get("kiko")!.sessionId]],
    );
    assert.deepEqual(seen.router, ["How do we handle the setup screen in the release build?"]);
  });

  test("with no session named like the app, as before: 'Kiko, what time is it', 'To Kiko, …' and 'Tell Kiko …' are the app's, no hint", async () => {
    const none = makeWorld([
      { name: "rowan", folder: "rowan-platform", given: "Rowan", status: "idle" },
      { name: "bobby", folder: "2026-11-03-bobby", given: "Bobby", status: "idle" },
    ]);
    for (const [said, rest, off] of [
      ["Kiko, what time is it?", "What time is it?", "Kiko,"],
      ["To, uh, Kiko. What time is it?", "What time is it?", "To, uh, Kiko."],
      ["Tell Kiko to read me the last reply.", "Read me the last reply.", "Tell Kiko to"],
    ]) {
      const { d, seen } = await run(said, { world: none, lastId: none.byName.get("rowan")!.sessionId });
      assert.equal(d.toApp, true, said);
      assert.equal(d.text, rest, said);
      assert.equal(d.nameSaid, off, said);
      assert.equal(d.nameAlso, undefined, said);
      assert.equal(seen.routed[0]?.nameAlso, undefined, said);
    }
  });

  test("two sessions named like the app ('Kiko project', 'kiko-dev'): asked which, nothing sent", async () => {
    const two = makeWorld([
      { name: "kiko", title: "Phone screens", status: "idle" },
      { name: "kiko-dev", status: "idle" },
      { name: "rowan", folder: "rowan-platform", given: "Rowan", status: "idle" },
    ]);
    const { d, outcomes, seen } = await run("To Kiko, run the tests.", { world: two, lastId: two.byName.get("rowan")!.sessionId });
    assert.equal(d.step, "which-named");
    assert.deepEqual(seen.router, []);
    assert.ok(!outcomes.some((o) => o.action === "send"), JSON.stringify(outcomes));
    assert.deepEqual(d.question?.kind === "asked" && d.question.question.offered, [two.byName.get("kiko")!.sessionId, two.byName.get("kiko-dev")!.sessionId]);
    assert.deepEqual(d.question?.kind === "asked" && d.question.question.text, "Run the tests.");
  });

  test("the name you call the app: Juno, with a 'Juno web' session, the same", async () => {
    setSpokenName("Juno");
    const juno = makeWorld([
      { name: "juno", folder: "juno-site", given: "Juno web", status: "idle" },
      { name: "rowan", folder: "rowan-platform", given: "Rowan", status: "idle" },
    ]);
    const rowan = juno.byName.get("rowan")!.sessionId;
    const to = await run("To, uh, Juno. How do we show the phone app?", { world: juno, lastId: rowan });
    assert.equal(to.d.step, "addressed");
    assert.deepEqual(sends(to.outcomes), [["send", "Juno web", "How do we show the phone app?"]]);
    const tell = await run("Tell Juno to run the tests.", { world: juno, lastId: rowan });
    assert.deepEqual(sends(tell.outcomes), [["send", "Juno web", "Run the tests."]]);
    const plain = await run("Juno, what's the phone app story?", { world: juno, lastId: rowan });
    assert.equal(plain.d.toApp, true);
    assert.deepEqual(plain.d.nameAlso, [juno.byName.get("juno")!.sessionId]);
    // Kiko is no longer the app's name: "To Kiko, …" is nothing special.
    const kiko = await run("To Kiko, run the tests.", { world: juno, lastId: rowan });
    assert.equal(kiko.d.toApp, undefined);
    assert.notEqual(kiko.d.step, "addressed");
  });
});
