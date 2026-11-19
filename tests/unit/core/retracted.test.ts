// Words that end by taking themselves back (src/core/routing-rules.ts retraction, decide.ts): dropped
// when the code's rule and the classifier's `retracted` both say so; without the classifier, only on a cue ("actually, never
// mind"). A question that broke off into "Actually, never mind." was once typed
// into the Kiko session. Everything that only uses the words
// ("support phrases like never mind", "tell Lacy to forget it") still goes.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ApprovalDecision, UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type DecideDeps, type DecideState, type Question, type Sent } from "../../../src/core/decide.ts";
import { Hold } from "../../../src/core/hold.ts";
import { answerTakenBack, dropsQuestion, retraction, RETRACTED_MIN } from "../../../src/core/routing-rules.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "Kiko project", folder: "kiko", given: "Kiko project", status: "idle", asked: "So just to check, Claude, Codex and OpenCode all behave the same way here?" },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", status: "busy", asked: "Is anything still in progress?" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const waits = (name: string) => ({ sessionId: S(name).sessionId, cwd: S(name).cwd });

// Two that take themselves back, cut off mid-sentence (made up, the shape of ones that were typed in).
const TAKEN_BACK = ["Okay. So just to check, if the phone app Actually, never mind.", "Uh, to the, uh, docs one. I Actually, never mind."];

// Words that must still go, whatever the classifier says: they use, quote or address the phrase.
const MUST_SEND = [
  // Listing phrases to support.
  "Right, and make sure we handle something like cancel that. Never mind.",
  // Talking about the word, ending in it.
  "Okay, so when people say, never mind, they tend to say something like, actually, never mind, right? So catching those shouldn't be too hard, I think. But come up with some good rules that still let people use the word. Never mind.",
  "Add support for phrases like never mind and forget it.",
  "If I say never mind it should cancel.",
  "What does 'scratch that' do?",
  "The button says never mind.",
  "The button says, actually, never mind.",
  "They usually say something like, actually, never mind.",
  "Never mind the tests, just deploy it.",
  "Never mind that, check the logs instead.",
  "Forget it, let's do option two.",
  "If the build fails, never mind.",
  "If the build fails, uh, never mind.",
  "Tell Lacy to forget it.",
  "tell Lacy to forget it",
  "Tell Lacy to, um, scratch that.",
  "Ask it to scratch that last commit.",
  "I never mind waiting.",
  "Never minding the cost, ship it.",
  "Don't make me wait, never mind.",
  "If the answer is no, never mind.",
  "Sure, let's do what you suggested. Just test it enough that there are no false positives for that. Never mind instance.",
  "Tell Kiku project to look at my last message that said, okay, never mind. The app itself shouldn't have picked that up on the Kiku side, it should have dropped it and not sent it to an instance.",
  "Okay, can you check one more thing on the Kiku? All I see is, The reply from, Actually, never mind, sorry. Um, this probably works as it should.",
  "Well, uh, ghosty and also iTerm, right? Don't forget those, but that one's an app, I guess, so.",
];

type ClassifierStub = Partial<Omit<UtteranceDecision, "audience">> & { audience?: string };

async function run(text: string, opts: Partial<DecideState> & { classifier?: ClassifierStub | "off" | "down"; approval?: ApprovalDecision } = {}) {
  const calls = { classifier: 0, router: 0 };
  const { classifier, approval, ...state0 } = opts;
  const deps: DecideDeps = {
    utterance:
      classifier === "off"
        ? null
        : async () => {
            calls.classifier++;
            if (classifier === "down") throw new Error("Jev 503");
            const j = classifier ?? {};
            return {
              audience: j.audience && j.audience !== "app" ? S(j.audience) : "app",
              audienceConfidence: j.audienceConfidence ?? 0.3,
              intent: j.intent ?? "message",
              intentConfidence: j.intentConfidence ?? 0.95,
              appParts: j.appParts ?? 0.1,
              ...(j.retracted !== undefined ? { retracted: j.retracted } : {}),
              model: "test",
              costUsd: 0,
              ms: 1,
            };
          },
    approval: approval ? async () => approval : null,
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
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...state0,
  };
  const d = await decide(state, deps);
  return { ...d, outcomes: outcomesOf(d, state), calls };
}

const NOT_SENT = { action: "say", text: "Okay, not sent." };
const dropped = (d: Awaited<ReturnType<typeof run>>) => d.step === "retracted" && d.outcomes.length === 1 && d.outcomes[0].action === "say" && d.outcomes[0].text === NOT_SENT.text;
const yes = { retracted: 0.9 };
const no = { retracted: 0.1 };
// Jev's pick then: the session that had just spoken.
const toKiko = { audience: "Kiko project", audienceConfidence: 0.96, intent: "undo" as const, intentConfidence: 0.65 };

describe("retraction: the code's half", () => {
  test("a cue right before the take-back: strict", () => {
    for (const said of [
      ...TAKEN_BACK,
      "Can you check the… actually, never mind.",
      "Run the tests. No, never mind.",
      "Check the build, oh, forget it.",
      "Look at the logs, wait, scratch that.",
      "Deploy it to staging. Actually, never mind, sorry.",
      "Tell Lacy to, actually, never mind.",
      "Can you check the, uh, actually, nevermind.",
    ]) {
      assert.equal(retraction(said), "strict", said);
    }
  });
  test("only words cut off, or a filler: loose", () => {
    for (const said of ["So what about the — forget it.", "Can you check the… never mind.", "Can you check the, um, never mind.", "Open the logs and -- scratch that."]) {
      assert.equal(retraction(said), "loose", said);
    }
  });
  test("words that use, quote or address the phrase, or end in it after a whole sentence: none", () => {
    for (const said of MUST_SEND) assert.equal(retraction(said), null, said);
  });
  test("a bare take-back is not this rule's (isClosing and the classifier's undo keep it)", () => {
    for (const said of ["Never mind.", "Actually, never mind.", "Okay, actually never mind.", "Oh, never mind. Sorry.", "No, never mind.", "Never mind, cancel that."]) {
      assert.equal(retraction(said), null, said);
    }
  });
  test("the threshold leans clearly yes", () => assert.ok(RETRACTED_MIN > 0.5 && RETRACTED_MIN < 0.8));
});

describe("decide: dropped only when both agree", () => {
  test("the rule and Jev agree: nothing sent, no router, said and logged as retracted", async () => {
    for (const said of TAKEN_BACK) {
      const d = await run(said, { justSpoke: { id: S("Kiko project").sessionId, secondsAgo: 14 }, classifier: { ...toKiko, ...yes } });
      assert.ok(dropped(d), said);
      assert.deepEqual(d.outcomes, [NOT_SENT]);
      assert.equal(d.actions[0].type === "say" && d.actions[0].why, "retracted");
      assert.equal(d.calls.router, 0);
      assert.equal(d.calls.classifier, 1, "the classifier asked once");
    }
  });
  test("cut-off words and the classifier agrees: dropped", async () => {
    assert.ok(dropped(await run("So what about the — forget it.", { classifier: { audience: "Lacy", audienceConfidence: 0.9, ...yes } })));
  });
  test("the rule finds it, Jev doesn't: the words go as before", async () => {
    const d = await run(TAKEN_BACK[0], { justSpoke: { id: S("Kiko project").sessionId, secondsAgo: 14 }, classifier: { ...toKiko, ...no } });
    assert.equal(d.step, "classifier");
    assert.deepEqual(
      d.outcomes.map((o) => [o.action, "to" in o ? o.to : ""]),
      [["send", "Kiko project"]],
    );
  });
  test("the classifier says retracted, the rule doesn't: the words go as before", async () => {
    for (const said of MUST_SEND) {
      const d = await run(said, { classifier: { audience: "Lacy", audienceConfidence: 0.95, ...yes } });
      assert.notEqual(d.step, "retracted", said);
      assert.equal(d.outcomes[0].action, "send", said);
    }
  });
  test("an older classifier model with no `retracted` answer: the words go", async () => {
    const d = await run(TAKEN_BACK[0], { classifier: { audience: "Kiko project", audienceConfidence: 0.96 } });
    assert.equal(d.outcomes[0].action, "send");
  });
  test("the classifier off or down: the strict form alone drops", async () => {
    for (const classifier of ["off", "down"] as const) {
      for (const said of [...TAKEN_BACK, "Can you check the… actually, never mind."]) {
        const d = await run(said, { classifier });
        assert.ok(dropped(d), `${classifier}: ${said}`);
        assert.equal(d.calls.router, 0);
      }
    }
  });
  test("the classifier off or down: cut-off words alone aren't enough, they go on as before", async () => {
    for (const classifier of ["off", "down"] as const) {
      for (const said of ["So what about the — forget it.", "Can you check the, um, never mind."]) {
        const d = await run(said, { classifier });
        assert.notEqual(d.step, "retracted", `${classifier}: ${said}`);
        assert.equal(d.calls.router, 1, `${classifier}: ${said}`);
      }
    }
  });
  test("the classifier off: the must-send words go on as before (none dropped)", async () => {
    for (const said of MUST_SEND) assert.notEqual((await run(said, { classifier: "off" })).step, "retracted", said);
  });
});

describe("decide: what comes first stays first", () => {
  const lastSent: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Deploy the shipping rates fix." };
  test("a bare 'Never mind.' after a send: undo, without the classifier; with one waiting: a wrap-up", async () => {
    const d = await run("Never mind.", { lastSent, classifier: yes });
    assert.equal(d.step, "closing");
    assert.equal(d.outcomes[0].action, "undo");
    assert.equal(d.calls.classifier, 0);
    assert.equal((await run("Never mind.", { lastSent, waiting: waits("Lacy"), classifier: yes })).outcomes[0].action, "wrap_up");
  });
  test("'Actually, never mind.' isn't this rule's: the classifier's undo takes back the last send", async () => {
    const d = await run("Actually, never mind.", { lastSent, classifier: { intent: "undo", intentConfidence: 0.9, ...yes } });
    assert.equal(d.outcomes[0].action, "undo");
  });
  test("a held send: 'never mind' cancels it", async () => {
    assert.equal((await run("Never mind.", { lastSent: { ...lastSent, held: true }, holding: true })).step, "held-cancel");
  });
  test("a quick task: 'never mind' still ends it", async () => {
    assert.equal((await run("Never mind.", { quickTask: { task: "disk space" } })).step, "quick-cancel");
  });
  test("a permission prompt: a take-back never approves (asked again), even when the classifier or the fallback hears allow", async () => {
    const waiting = { ...waits("Lacy"), permission: "Bash: rm -rf build" };
    assert.deepEqual((await run("Allow it. Actually, never mind.", { waiting })).outcomes, [{ action: "permission", answer: "unclear" }]);
    const approval: ApprovalDecision = { answer: "allow", confidence: 0.95, costUsd: 0, ms: 1 };
    assert.deepEqual((await run("Yes, go ahead, oh, never mind.", { waiting, approval })).outcomes, [{ action: "permission", answer: "unclear" }]);
    // Without a take-back: as before.
    assert.deepEqual((await run("Allow it.", { waiting })).outcomes, [{ action: "permission", answer: "allow" }]);
    assert.deepEqual((await run("Yes, and tell it to forget it.", { waiting, approval })).outcomes, [{ action: "permission", answer: "allow" }]);
  });
  test("the session's own question: 'option two, actually, never mind' answers nothing", async () => {
    const waiting = { ...waits("Lacy"), permission: "AskUserQuestion", questions: true };
    assert.deepEqual((await run("Option two, actually, never mind.", { waiting })).outcomes, [NOT_SENT]);
    assert.deepEqual((await run("Option two.", { waiting })).outcomes, [{ action: "answer", text: "Option two." }]);
  });
  test("the app's 'which session?': an answer that takes itself back drops the question", async () => {
    const question = { text: "Run the tests.", offered: [S("Lacy").sessionId, S("Kiko project").sessionId], line: "Which session should it go to, Lacy or Kiko project?" };
    const d = await run("Lacy, actually, never mind.", { question, appAsked: true });
    assert.deepEqual(d.question, { kind: "cancelled" });
    assert.deepEqual(d.outcomes, [NOT_SENT]);
    // A plain pick still sends.
    assert.equal((await run("Lacy.", { question, appAsked: true })).outcomes[0].action, "send");
  });
  test("words named up front, or said in a session's screen, are checked too (the classifier asked for it)", async () => {
    const named = await run("Lacy, check the build, actually, never mind.", { classifier: yes });
    assert.ok(dropped(named));
    assert.equal(named.calls.classifier, 1);
    const screen = await run("Check the build, actually, never mind.", { to: waits("Lacy"), classifier: yes });
    assert.ok(dropped(screen));
    // The classifier disagrees: they go there, as before.
    assert.equal((await run("Check the build, actually, never mind.", { to: waits("Lacy"), classifier: no })).outcomes[0].action, "send");
  });
});

// The app's own questions ("Stop Lacy?", "Stop which one?", the offer of a session, "Did you mean
// Lacy?", "Which session…?", one the router reads) and Claude's (a permission prompt, its multiple
// choice): "Yes. Actually, never mind." confirmed, since the "yes" up front was read first and
// retraction() needs words of their own before the take-back. Read in code (answerTakenBack): a
// take-back confirms nothing, and on a stop or a start, when in doubt, nothing is done.
describe("answerTakenBack: the code's read of an answer", () => {
  test("a take-back after the answer's own words: taken", () => {
    for (const said of [
      "Yes. Actually, never mind.",
      "Yes, never mind.",
      "Yeah, forget it.",
      "Sure. Scratch that.",
      "Okay, never mind.",
      "Yes, stop it. Actually, never mind.",
      "Yeah, never mind, I'll do it myself.",
      "Lacy, oh, never mind.",
      "Yes. Never mind, sorry.",
      ...TAKEN_BACK,
    ]) {
      assert.equal(answerTakenBack(said), "taken", said);
    }
  });
  test("only a no or fillers before it: no", () => {
    for (const said of ["Never mind.", "No, never mind.", "Nope, forget it.", "Uh, actually, never mind.", "No, never mind, I'll do it myself."]) {
      assert.equal(answerTakenBack(said), "no", said);
    }
  });
  test("none: a plain answer, a clear yes after the take-back, or the phrase quoted, negated, told or used as words", () => {
    for (const said of [
      "Yes.",
      "Yes, stop it.",
      "Yeah, do it.",
      "Yeah, never mind, do it.",
      "Never mind, yes, go ahead.",
      "Yes, and tell it to forget it.",
      "Yes, don't forget it.",
      "Yes, never mind the tests, stop it.",
      "Sure, forget that test.",
      "The button says never mind.",
      "I never mind waiting.",
    ]) {
      assert.equal(answerTakenBack(said), null, said);
    }
  });
});

describe("the app's yes-or-no questions: a take-back confirms nothing", () => {
  const ASKED = ["you → app: Stop lazy.", "app said: Stop Lacy?"];
  const LEAVE = { action: "say", text: "Okay, I'll leave it." };
  const why = (d: Awaited<ReturnType<typeof run>>) => d.actions.map((a) => (a.type === "say" ? a.why : a.type));
  const stops = (d: Awaited<ReturnType<typeof run>>) => d.outcomes.map((o) => (o.action === "stop" ? o.to : o.action));
  const TAKEN = ["Yes. Actually, never mind.", "Yes, stop it. Actually, never mind.", "Yeah, forget it.", "Yes, never mind.", "Yeah, never mind, I'll do it myself.", "Okay, never mind."];

  test("'Stop Lacy?': nothing stopped, its no said, `retracted` logged; no model asked, whatever the classifier would say", async () => {
    for (const classifier of [yes, no, "off" as const]) {
      for (const said of TAKEN) {
        const d = await run(said, { appAsked: true, recent: ASKED, classifier });
        assert.deepEqual(d.outcomes, [LEAVE], said);
        assert.deepEqual(why(d), ["retracted"], said);
        assert.equal(d.calls.router + d.calls.classifier, 0, said);
      }
    }
  });
  test("'Stop Lacy?': 'No, never mind.' and 'Never mind.' are a plain no", async () => {
    for (const said of ["No, never mind.", "Never mind.", "Nope, forget it."]) {
      const d = await run(said, { appAsked: true, recent: ASKED });
      assert.deepEqual(d.outcomes, [LEAVE], said);
      assert.deepEqual(why(d), ["stop_declined"], said);
    }
  });
  test("'Stop Lacy?': a yes still stops, and a clear yes after a take-back stands", async () => {
    for (const said of ["Yes.", "Yes, stop it.", "Yeah, do it.", "Yeah, never mind, do it.", "Yes, never mind the tests, stop it."]) {
      const d = await run(said, { appAsked: true, recent: ASKED });
      assert.deepEqual(stops(d), ["Lacy"], said);
    }
  });
  test("'Stop which one? Say its name.': a name that takes itself back stops nothing", async () => {
    const WHICH = ["you → app: Stop it.", "app said: Stop which one? Say its name."];
    for (const said of ["Lacy, actually, never mind.", "Lacy. Never mind.", "Lacy, oh, forget it."]) {
      const d = await run(said, { appAsked: true, recent: WHICH, classifier: no });
      assert.deepEqual(d.outcomes, [LEAVE], said);
    }
    assert.deepEqual(stops(await run("Lacy.", { appAsked: true, recent: WHICH })), ["Lacy"]);
  });
  test("the offer of a session after a quick task: nothing started", async () => {
    const handOff = { task: "Set the volume to 10%.", cwd: S("Lacy").cwd };
    const recent = ["app said: I couldn't check that quickly. Want me to open a session for it?"];
    for (const said of TAKEN) {
      const d = await run(said, { appAsked: true, recent, handOff });
      assert.deepEqual(d.outcomes, [LEAVE], said);
      assert.deepEqual(why(d), ["retracted"], said);
      assert.equal(d.step, "hand-off");
    }
    assert.deepEqual(why(await run("No, never mind.", { appAsked: true, recent, handOff })), ["hand_off_declined"]);
    assert.equal((await run("Sure.", { appAsked: true, recent, handOff })).outcomes[0].action, "start");
    assert.equal((await run("Yeah, never mind, do it.", { appAsked: true, recent, handOff })).outcomes[0].action, "start");
  });
  test("a question the router reads ('Want me to open a new session for that?'): a short take-back is its no; a plain answer goes to the router", async () => {
    const recent = ["you → app: Look into the flaky test.", "app said: Want me to open a new session for that?"];
    for (const said of ["Yes. Actually, never mind.", "Yeah, open one. Actually, never mind.", "Sure, forget it."]) {
      const d = await run(said, { appAsked: true, recent });
      assert.deepEqual(d.outcomes, [LEAVE], said);
      assert.deepEqual(why(d), ["retracted"], said);
      assert.equal(d.calls.router, 0, said);
    }
    for (const said of ["Yes.", "Yeah, never mind, do it."]) {
      const d = await run(said, { appAsked: true, recent });
      assert.equal(d.step, "app-question", said);
      assert.equal(d.calls.router, 1, said);
    }
    // A bare one goes on as before (a wrap-up); longer words are new ones, the take-back checked with the classifier.
    assert.equal((await run("No, never mind.", { appAsked: true, recent })).step, "closing");
    const long = await run(MUST_SEND[0], { appAsked: true, recent, classifier: "off" });
    assert.equal(long.calls.router, 1);
  });
  test("'Did you mean Lacy?': a yes that takes itself back sends nothing", async () => {
    const question: Question = { text: "Ask it what's next.", offered: [S("Lacy").sessionId], line: "Did you mean Lacy?" };
    const recent = ["you → app: Ask Macy what's next.", "app said: Did you mean Lacy?"];
    for (const said of ["Yes. Actually, never mind.", "Yeah, forget it.", "Yes, never mind.", "Lacy. Never mind."]) {
      const d = await run(said, { appAsked: true, recent, question });
      assert.deepEqual(d.question, { kind: "cancelled" }, said);
      assert.deepEqual(d.outcomes, [NOT_SENT], said);
      assert.deepEqual(why(d), ["retracted"], said);
      assert.equal(d.calls.router + d.calls.classifier, 0, said);
    }
    const plain = await run("No, never mind.", { appAsked: true, recent, question });
    assert.deepEqual(plain.question, { kind: "cancelled" });
    assert.deepEqual(why(plain), [undefined]);
    assert.deepEqual(
      (await run("Yes.", { appAsked: true, recent, question })).outcomes.map((o) => o.action),
      ["send"],
    );
  });
  test("'Which session…?': a pick that takes itself back is dropped; a take-back with a new pick after it isn't", async () => {
    const question: Question = { text: "Run the tests.", offered: [S("Lacy").sessionId, S("Kiko project").sessionId], line: "Which session should it go to, Lacy or Kiko project?" };
    const d = await run("Lacy. Never mind.", { question, appAsked: true });
    assert.deepEqual(d.question, { kind: "cancelled" });
    assert.ok(!dropsQuestion("Lacy. Never mind, Kiko project."));
    const again = await run("Lacy. Never mind, Kiko project.", { question, appAsked: true });
    assert.notEqual(again.question?.kind, "cancelled");
    assert.ok(!again.outcomes.some((o) => o.action === "say" && o.text === LEAVE.text));
  });
  test("a permission prompt ('Allow?', the app's quick check too): a yes taken back is unclear, asked again; 'No, never mind.' denies", async () => {
    const waiting = { ...waits("Lacy"), permission: "Bash: rm -rf build" };
    const allow: ApprovalDecision = { answer: "allow", confidence: 0.95, costUsd: 0, ms: 1 };
    for (const said of ["Yes. Actually, never mind.", "Yeah, forget it.", "Yes, never mind."]) {
      assert.deepEqual((await run(said, { waiting, approval: allow })).outcomes, [{ action: "permission", answer: "unclear" }], said);
    }
    assert.deepEqual((await run("No, never mind.", { waiting })).outcomes, [{ action: "permission", answer: "deny" }]);
    assert.deepEqual((await run("Yeah, never mind, do it.", { waiting })).outcomes, [{ action: "permission", answer: "allow" }]);
    assert.deepEqual((await run("Yes.", { waiting })).outcomes, [{ action: "permission", answer: "allow" }]);
  });
  test("the session's own question: 'Yes. Never mind.' answers nothing; a new answer after a take-back does", async () => {
    const waiting = { ...waits("Lacy"), permission: "AskUserQuestion", questions: true };
    assert.deepEqual((await run("Yes. Never mind.", { waiting })).outcomes, [NOT_SENT]);
    assert.deepEqual((await run("Option two. Never mind, option three.", { waiting })).outcomes, [{ action: "answer", text: "Option two. Never mind, option three." }]);
    assert.deepEqual((await run("No, never mind.", { waiting })).outcomes, [{ action: "answer", text: "No, never mind." }]);
  });
});

describe("a held send and a take-back", () => {
  const held: Sent = { sessionId: S("Lacy").sessionId, folder: "Lacy", text: "Deploy the shipping rates fix.", held: true };
  test("words that take themselves back cancel the held send too: undo, decided as retracted, no router", async () => {
    for (const classifier of [yes, "off" as const]) {
      const d = await run("Can you check the… actually, never mind.", { lastSent: held, holding: true, classifier });
      assert.equal(d.step, "retracted");
      assert.deepEqual(d.actions, [{ type: "undo" }]);
      assert.equal(d.calls.router, 0);
    }
  });
  test("the classifier disagrees: the words go as before, and the held send isn't cancelled", async () => {
    const d = await run("Can you check the… actually, never mind.", { lastSent: held, holding: true, classifier: { audience: "Kiko project", audienceConfidence: 0.95, ...no } });
    assert.ok(!d.actions.some((a) => a.type === "undo"));
    assert.equal(d.outcomes[0].action, "send");
  });
  test("other new words while one is held: as before (they go, and so does it)", async () => {
    const d = await run("Check the logs in Kiko project.", { lastSent: held, holding: true, classifier: { audience: "Kiko project", audienceConfidence: 0.95, ...no } });
    assert.ok(!d.actions.some((a) => a.type === "undo"));
    assert.equal(d.outcomes[0].action, "send");
  });
  test("the hold: cancelled, and 'Okay, not sent.' said once, logged as retracted", async () => {
    const logs: string[] = [];
    const hold = new Hold(
      { to: { sessionId: held.sessionId, cwd: S("Lacy").cwd }, name: "Lacy", text: held.text, why: "router", kind: "send", last: held, words: null, pressed: true },
      { holdMs: 100, answerMs: 1000, nameOf: () => "Lacy", settled: () => {}, unanswered: () => {}, info: () => {}, log: (event) => logs.push(event), changed: () => {} },
    );
    const d = await run("Can you check the… actually, never mind.", { lastSent: held, holding: true, classifier: yes });
    const actions = await hold.settleWith(d, d.text, () => {});
    assert.deepEqual(actions, [{ type: "say", text: "Okay, not sent.", why: "retracted" }]);
    assert.equal(await hold.verdict, "cancel");
    assert.deepEqual(logs, ["send_cancelled"]);
  });
});
