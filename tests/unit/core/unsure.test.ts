// Which sends are a guess (src/core/decide.ts `unsure`): the router, or a code guard on its pick, chose
// the session, not your words, the session waiting for your reply, or the classifier at its bar. The app says
// where those go and holds them a moment (app.ts holdIf), so a quick "no, clipkit" or "cancel"
// changes them before they land. And what your words do to a send that's held.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { directionOff } from "../../../src/core/direction.ts";
import { decide, type DecideDeps, type DecideState, type Sent } from "../../../src/core/decide.ts";
import { HELD_CANCEL } from "../../../src/core/routing-rules.ts";
import { makeWorld, type World } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "Claude speech", folder: "claude-code-speech", given: "Claude speech", title: "Voice app notes and settings", status: "busy", asked: "Can you look into names with vibe?" },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates in secure checkout", status: "idle", asked: "Is anything still in progress?" },
  { name: "Clipkit", folder: "clipkit", given: "Clipkit", title: "ClipKit export window jump", status: "idle", asked: "Is the release deployed?" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const waits = (name: string) => ({ sessionId: S(name).sessionId, cwd: S(name).cwd });

type Stub = {
  classifier?: Partial<Omit<UtteranceDecision, "audience">> & { audience?: string };
  router?: (s: (name: string) => Session) => Action[];
  /** The router's words when it only answers ("Which session was it for?"). */
  says?: string;
  noClassifier?: boolean;
  world?: World;
};

// The router's ask_session here writes your words, the direction off (ECHO): these tests are about
// where words go; what the router may write is router-words.test.ts's.
const ECHO = "<your words>";
const echoed = (actions: Action[], text: string) =>
  actions.map((a) => {
    if (a.name !== "ask_session" || a.message !== ECHO) return a;
    const off = directionOff(text, a.session, W.sessions);
    return { ...a, message: (off?.indirect ? off.loose?.text : off?.text) ?? text };
  });

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const world = opts.world ?? W;
  const calls = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    utterance: opts.noClassifier
      ? null
      : async () => {
          calls.classifier++;
          const j = opts.classifier ?? {};
          return {
            audience: j.audience && j.audience !== "app" ? world.byName.get(j.audience.toLowerCase())! : "app",
            audienceConfidence: j.audienceConfidence ?? 0.3,
            intent: j.intent ?? "message",
            intentConfidence: j.intentConfidence ?? 0.95,
            appParts: j.appParts ?? 0.1,
            model: "test",
            costUsd: 0,
            ms: 1,
          };
        },
    approval: null,
    route: async () => {
      calls.router++;
      const actions = echoed(opts.router?.((name) => world.byName.get(name.toLowerCase())!) ?? [], text);
      return { text: opts.says ?? "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
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
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  const d = await decide(state, deps);
  return { ...d, outcomes: outcomesOf(d, state), calls };
}

/** Each send, ask or resend as [action, to, why unsure (or "sure")]. */
const sends = (d: Awaited<ReturnType<typeof run>>) =>
  d.actions.flatMap((a) => (a.type === "send" || a.type === "ask" || a.type === "resend" ? [[a.type, nameOf(a.session.sessionId), a.unsure ?? "sure"]] : []));
const nameOf = (id: string) => [...W.byName.entries(), ...TWINS.byName.entries()].find(([, s]) => s.sessionId === id)?.[0];
const pass =
  (name: string) =>
  (s: (n: string) => Session): Action[] => [{ name: "pass_on", session: s(name) }];
const ask =
  (name: string) =>
  (s: (n: string) => Session): Action[] => [{ name: "ask_session", session: s(name), message: ECHO }];

// Two sessions in one folder: the folder names both.
const TWINS = makeWorld([
  { name: "voice-a", folder: "claude-code-speech", title: "Status bar colours" },
  { name: "voice-b", folder: "claude-code-speech", title: "Dictionary tests" },
  { name: "snip", folder: "clipkit" },
]);

describe("sure: these go straight through, as before", () => {
  test("you named it", async () => {
    const d = await run("Tell clipkit to run the tests.", { classifier: { audience: "Lacy", audienceConfidence: 0.3 } });
    assert.equal(d.step, "addressed");
    assert.deepEqual(sends(d), [["send", "clipkit", "sure"]]);
  });
  test("the classifier at its bar", async () => {
    const d = await run("Run the tests.", { classifier: { audience: "Lacy", audienceConfidence: 0.8 } });
    assert.equal(d.step, "classifier");
    assert.deepEqual(sends(d), [["send", "lacy", "sure"]]);
  });
  test("without the classifier, the waiting session's reply", async () => {
    const d = await run("Yes, go ahead.", { waiting: waits("Lacy"), noClassifier: true });
    assert.equal(d.step, "waiting-fallback");
    assert.deepEqual(sends(d), [["send", "lacy", "sure"]]);
  });
  test("the router picks the waiting session: its reply", async () => {
    const d = await run("Yes, go ahead.", { waiting: waits("Lacy"), router: pass("Lacy") });
    assert.equal(d.step, "router");
    assert.deepEqual(sends(d), [["send", "lacy", "sure"]]);
  });
  test("the router picks another, unnamed, while one waits: kept for the waiting one, sure", async () => {
    const d = await run("Is it a big lift?", { waiting: waits("Claude speech"), router: ask("Clipkit") });
    assert.deepEqual(sends(d), [["send", "claude speech", "sure"]]);
  });
  test("the router picks the one your words name", async () => {
    const d = await run("What about Lacy, is anything still running?", { router: ask("Lacy") });
    assert.deepEqual(sends(d), [["ask", "lacy", "sure"]]);
  });
  test("by two words of its title", async () => {
    const d = await run("How's the export window jump fix doing?", { router: ask("Clipkit") });
    assert.deepEqual(sends(d), [["ask", "clipkit", "sure"]]);
  });
  test("'ask all of them': every one, sure", async () => {
    const d = await run("Ask all of them what's left.", { router: (s) => ["Lacy", "Clipkit"].map((n): Action => ({ name: "ask_session", session: s(n), message: ECHO })) });
    assert.deepEqual(sends(d), [
      ["ask", "lacy", "sure"],
      ["ask", "clipkit", "sure"],
    ]);
  });
  test("a yes to the app's 'Want me to send it to Lacy?'", async () => {
    const d = await run("Yes.", { appAsked: true, recent: ["app said: A quick check can only look, and that needs a change. Want me to send it to Lacy?"], router: pass("Lacy") });
    assert.equal(d.step, "app-question");
    assert.deepEqual(sends(d), [["send", "lacy", "sure"]]);
  });
  test("'Which session is that for?' answered with its name", async () => {
    const d = await run("Clipkit.", { appAsked: true, recent: ["app said: Which session is that for?"], router: pass("Clipkit") });
    assert.deepEqual(sends(d), [["send", "clipkit", "sure"]]);
  });
  test("a correction that names where it goes", async () => {
    const lastSent: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests." };
    const d = await run("No, that was for clipkit.", { lastSent, classifier: { intent: "redirect", audience: "Clipkit", audienceConfidence: 0.4 } });
    assert.equal(d.step, "classifier-intent");
    assert.equal(d.correction, true);
    assert.deepEqual(sends(d), [["resend", "clipkit", "sure"]]);
  });
  test("'move that to clipkit'", async () => {
    const lastSent: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests." };
    const d = await run("Move that to clipkit.", { lastSent });
    assert.equal(d.step, "move-it");
    assert.equal(d.correction, true);
    assert.deepEqual(sends(d), [["resend", "clipkit", "sure"]]);
  });
});

describe("unsure: the router or a guard picked it", () => {
  test("the classifier under its bar, the router passes it on to a session your words don't name", async () => {
    const d = await run("Run the tests again.", { classifier: { audience: "Lacy", audienceConfidence: 0.6 }, router: pass("Lacy") });
    assert.equal(d.step, "router");
    assert.deepEqual(sends(d), [["send", "lacy", "router pass_on"]]);
    assert.equal(d.outcomes[0].unsure, true);
  });
  test("ask_session to one your words don't name", async () => {
    const d = await run("What's the status?", { router: ask("Clipkit") });
    assert.deepEqual(sends(d), [["ask", "clipkit", "router ask_session"]]);
  });
  test("the session that just spoke (its window closed): still a guess", async () => {
    const d = await run("Sure, do that.", { justSpoke: { id: S("Clipkit").sessionId, secondsAgo: 3 }, router: pass("Clipkit") });
    assert.deepEqual(sends(d), [["send", "clipkit", "router pass_on"]]);
  });
  test("start_session sent to the session already in that folder", async () => {
    const d = await run("Can we add a loading state?", { router: () => [{ name: "start_session", project: "Lacy", newProject: false, sessionName: "", prompt: "Add a loading state" }] });
    assert.deepEqual(sends(d), [["send", "lacy", "router start_session"]]);
  });
  test("one_target keeps the first pick by topic", async () => {
    const d = await run("Is anything still in progress there?", { router: (s) => ["Lacy", "Clipkit"].map((n): Action => ({ name: "ask_session", session: s(n), message: ECHO })) });
    assert.deepEqual(sends(d), [["ask", "lacy", "router ask_session"]]);
  });
  test("two sessions in one folder, your words name only the folder: the app asks which, each by its number and title", async () => {
    const d = await run("Ask claude code speech to run the tests.", { world: TWINS, classifier: { audienceConfidence: 0.3 }, router: ask("voice-b") });
    assert.equal(d.step, "which-numbered");
    assert.deepEqual(sends(d), []);
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: "Which one: claude code speech, Status bar colours; or claude code speech 2, Dictionary tests?" }]);
    assert.equal(d.calls.router, 0);
  });
  test("…by its number: sure", async () => {
    const d = await run("Ask claude code speech two to run the tests.", { world: TWINS, router: ask("voice-a") });
    assert.equal(d.step, "addressed");
    assert.deepEqual(sends(d), [["send", "voice-b", "sure"]]);
  });
  test("…by its title too: sure", async () => {
    const d = await run("Ask the dictionary tests one in claude code speech how it's going.", { world: TWINS, router: ask("voice-b") });
    assert.deepEqual(sends(d), [["ask", "voice-b", "sure"]]);
  });
  test("the router's resend_to, the words naming nobody: a guess, and a correction", async () => {
    const lastSent: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests." };
    const d = await run("No, wrong one.", { lastSent, classifier: { intent: "redirect", audienceConfidence: 0.3 }, router: (s) => [{ name: "resend_to", session: s("Clipkit") }] });
    assert.equal(d.correction, true);
    assert.deepEqual(sends(d), [["resend", "clipkit", "router resend_to"]]);
  });
  test("'wrong one' and the router only asks where: a correction with nowhere to send", async () => {
    const lastSent: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests.", held: true };
    const d = await run("Wrong one.", { lastSent, holding: true, classifier: { intent: "redirect", audienceConfidence: 0.3 }, says: "Which session was it for?" });
    assert.equal(d.correction, true);
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: "Which session was it for?" }]);
  });
  test("plain words aren't a correction", async () => {
    const d = await run("Run the tests again.", { router: pass("Lacy") });
    assert.equal(d.correction, undefined);
  });
});

describe("words while a send is held", () => {
  const held: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Run the tests.", held: true };
  for (const said of ["Cancel.", "Cancel that.", "No, cancel it.", "Never mind.", "Wait, don't send that.", "Scratch that.", "Stop."]) {
    test(`${JSON.stringify(said)}: dropped, no models`, async () => {
      const d = await run(said, { lastSent: held, holding: true });
      assert.equal(d.step, "held-cancel");
      assert.deepEqual(d.actions, [{ type: "undo" }]);
      assert.deepEqual(d.calls, { classifier: 0, router: 0 });
    });
  }
  test("'never mind' with a session waiting: still the held send it drops, not a wrap-up", async () => {
    const d = await run("Never mind.", { lastSent: held, holding: true, waiting: waits("Clipkit") });
    assert.deepEqual(d.actions, [{ type: "undo" }]);
  });
  test("not held: 'Cancel.' is as before", async () => {
    const d = await run("Cancel.", { lastSent: { ...held, held: undefined } });
    assert.notEqual(d.step, "held-cancel");
  });
  test("HELD_CANCEL leaves real requests alone", () => {
    for (const said of ["Cancel the deploy.", "Stop the dev server and restart it.", "Don't send emails from the test suite."]) assert.ok(!HELD_CANCEL.test(said), said);
  });
  test("'that's for clipkit': the held words go there", async () => {
    const d = await run("No, that's for clipkit.", { lastSent: held, holding: true, classifier: { intent: "redirect", audience: "Clipkit", audienceConfidence: 0.5 } });
    assert.equal(d.actions[0].type === "resend" && d.actions[0].last, held);
    assert.deepEqual(sends(d), [["resend", "clipkit", "sure"]]);
  });
  test("a bare 'Yeah.' held: nobody got it, so 'that's for clipkit' sends it there", async () => {
    const yeah: Sent = { ...held, text: "Yeah." };
    const d = await run("No, that's for clipkit.", { lastSent: yeah, holding: true, classifier: { intent: "redirect", audience: "Clipkit", audienceConfidence: 0.5 } });
    assert.equal(d.actions[0].type, "resend");
  });
  test("a correction to where it's already going: asked, not 'already went'", async () => {
    const d = await run("No, that was for lacy.", {
      lastSent: held,
      holding: true,
      classifier: { intent: "redirect", audienceConfidence: 0.3 },
      router: (s) => [{ name: "resend_to", session: s("Lacy") }],
    });
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: "That's going to Lacy. Which session was it for?" }]);
  });
});
