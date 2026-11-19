// The app's "which session?" question (src/core/decide.ts answerQuestion, asksWhere; src/core/question.ts):
// the words it was about are kept, and an answer that only picks a session sends them there, read in
// code, never the answer itself. A short test message got "Which session should it go to, Lacy or
// Kiko?", and the answer naming one (misheard) was typed into Kiko as is.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState, type Question } from "../../../src/core/decide.ts";
import { AskedWhere } from "../../../src/core/question.ts";
import { dropsQuestion, QUESTION_MS } from "../../../src/core/routing-rules.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";
import { setSpokenName } from "../../../src/core/name.ts";

// The default name, Kiko (a name of your own: tests/unit/core/spoken-name.test.ts).
setSpokenName("Kiko");

// As the route prompt listed them, plus one the question didn't offer. The one in the
// kiko folder is shown and said as "Kiko project" since (sessions.ts APP_NAMED).
const W = makeWorld([
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates in secure checkout", status: "idle" },
  { name: "Kiko", folder: "kiko", title: "Notes file cleanup", status: "idle" },
  { name: "Clipkit", folder: "clipkit", given: "Clipkit", title: "ClipKit export window jump", status: "idle" },
]);
// By its spec name, or as listed ("Kiko project").
const S = (name: string) => W.byName.get(name.toLowerCase().replace(/ project$/, ""))!;

const SAID = "Just trying this out, um, from the tablet before the.";
const ORIGINAL = "Just trying this out from the tablet before the.";
const LINE = "I'm not sure who that's for. It sounds like a try-out from the tablet. Which session should it go to, Lacy or Kiko?";
const ASKED: Question = { text: ORIGINAL, offered: [S("Lacy").sessionId, S("Kiko").sessionId], line: LINE };
const RECENT = [`you → app: ${SAID}`, `app said: ${LINE}`];

type Stub = { router?: (s: (name: string) => Session) => Action[]; says?: string; clean?: (text: string) => string };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const calls = { classifier: 0, router: 0, clean: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      calls.classifier++;
      return { audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      calls.router++;
      const actions = opts.router?.((name) => S(name)) ?? [];
      return { text: opts.says ?? "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: opts.clean
      ? async (t: string) => {
          calls.clean++;
          const out = opts.clean!(t);
          return { text: out, cleaned: out !== t, costUsd: 0, ms: 1 };
        }
      : null,
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
  const outcomes = outcomesOf(d, state).map(({ sessionId: _id, ...rest }) => rest);
  return { ...d, outcomes, calls };
}

/** Right after the question, as the app hands it to decide(). */
const answer = (text: string, more: Partial<DecideState> & Stub = {}) => run(text, { recent: RECENT, appAsked: true, question: ASKED, ...more });

describe("the question is kept: what it was about, and the sessions it offered", () => {
  test("the router asks which session: the words as they'd have gone (cleaned up), Lacy and Kiko in its order", async () => {
    const d = await run(SAID, { says: LINE, clean: (t) => t.replace("out, um, from", "out from") });
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: LINE }]);
    assert.deepEqual(d.question, { kind: "asked", question: ASKED });
  });
  test("'Kiko or Lacy?' offers them in that order", async () => {
    const d = await run(SAID, { says: "Should that go to Kiko or Lacy?" });
    assert.equal(d.question?.kind, "asked");
    assert.deepEqual(d.question?.kind === "asked" && d.question.question.offered, [S("Kiko").sessionId, S("Lacy").sessionId]);
  });
  test("'Who's that for?' names none: every session it can reach is offered", async () => {
    const d = await run(SAID, { says: "Who's that for?" });
    assert.deepEqual(
      d.question?.kind === "asked" && d.question.question.offered,
      W.sessions.map((x) => x.sessionId),
    );
  });
  test("the guard's 'Which session is that for?' (asked of several, none clearly) is kept too", async () => {
    const d = await run("What was the decision on 104?", {
      router: (s) => ["Lacy", "Clipkit"].map((n) => ({ name: "ask_session", session: s(n), message: "What was the decision on 104?" })),
    });
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: "Which session is that for?" }]);
    assert.equal(d.question?.kind, "asked");
  });
  test("not kept: other questions, answers, and instructions to the app", async () => {
    for (const [said, says] of [
      [SAID, "It's 7:04 pm."],
      [SAID, "Want me to check that?"],
      ["Add to dictionary: ghosty means Ghostty.", "How is it spelled? Say the letters."],
      ["Stop it.", "Which one should I stop, Lacy or Kiko?"],
      ["Start a new session for the docs.", "Which folder, Lacy or Kiko?"],
    ]) {
      const d = await run(said, { says });
      assert.equal(d.question, undefined, `${said} → ${says}`);
    }
    // "Stop which one? Say its name." is the stop guard's: a name answers it with a stop.
    const stop = await run("Stop clipkid and lazy.", { router: () => [] });
    assert.equal(stop.question, undefined);
  });
  test("asked again after an unclear answer: still about the words before", async () => {
    const d = await answer("Hmm, the one with the logs?", { says: "Sorry, Lacy or Kiko?" });
    assert.equal(d.calls.router, 1);
    assert.equal(d.question?.kind === "asked" && d.question.question.text, ORIGINAL);
  });
});

describe("an answer that only picks a session: the words asked about go there, read in code", () => {
  const picks: Array<[string, string, string]> = [
    ["It should go to, uh, Keko.", "Kiko project", "near"],
    ["Kiko.", "Kiko project", "name"],
    ["Kiko, please.", "Kiko project", "name"],
    ["It should go to Kiko.", "Kiko project", "name"],
    ["To Lacy.", "Lacy", "name"],
    ["The first one.", "Lacy", "order"],
    ["Uh, the second one, please.", "Kiko project", "order"],
    ["Lucy.", "Lacy", "near"],
    ["L-A-C-Y.", "Lacy", "name"],
    ["The lacy platform one.", "Lacy", "name"],
    ["Yeah, I think Kiko.", "Kiko project", "name"],
    // Not offered, but named exactly: it goes there.
    ["Clipkit.", "Clipkit", "name"],
  ];
  for (const [said, to, how] of picks) {
    test(`${JSON.stringify(said)} → ${to} (${how}), no model call`, async () => {
      const d = await answer(said);
      assert.equal(d.step, "question");
      assert.deepEqual(
        d.outcomes.map((o) => ({ ...o, unsure: undefined })),
        [{ action: "send", to, text: ORIGINAL, via: "terminal", unsure: undefined }],
      );
      assert.deepEqual(d.question, { kind: "answered", sessionId: S(to).sessionId, how });
      assert.deepEqual(d.calls, { classifier: 0, router: 0, clean: 0 });
    });
  }
  test("the incident: 'should go to' is never typed, and a name only come close to is held a moment (unsure)", async () => {
    const d = await answer("It should go to, uh, Keko.");
    assert.ok(!d.outcomes.some((o) => "text" in o && /should go to/i.test(o.text)));
    assert.equal(d.outcomes[0].unsure, true);
    assert.equal((await answer("Kiko.")).outcomes[0].unsure, undefined, "named exactly: sure");
  });
  test("'Keko' means Kiko only when the question offered it", async () => {
    const lacyOrClipkit: Question = { ...ASKED, offered: [S("Lacy").sessionId, S("Clipkit").sessionId], line: "Lacy or Clipkit?" };
    const d = await answer("It should go to Keko.", { question: lacyOrClipkit, recent: [RECENT[0], "app said: Lacy or Clipkit?"], router: () => [] });
    assert.equal(d.calls.router, 1, "not a pick: the router reads it");
    assert.notEqual(d.question?.kind, "answered");
    // With no question waiting, "Keko" is no one's name.
    const none = await run("It should go to Keko.", { router: () => [] });
    assert.equal(none.step, "router");
  });
  test("two sessions named: not a pick", async () => {
    const d = await answer("Lacy and Kiko.", { router: () => [] });
    assert.equal(d.calls.router, 1);
  });
  test("a permission prompt waiting: the words answer it, not the question", async () => {
    const d = await answer("Clipkit.", { waiting: { sessionId: S("Lacy").sessionId, cwd: S("Lacy").cwd, permission: "run tests" } });
    assert.equal(d.step, "permission");
  });
});

describe("an answer that picks and adds more", () => {
  test("'Kiko, and tell it to check the logs too': the words asked about, then the rest, in one message", async () => {
    const d = await answer("Kiko, and tell it to check the logs too.");
    assert.deepEqual(d.outcomes, [{ action: "send", to: "Kiko project", text: `${ORIGINAL}\n\nTell it to check the logs too.`, via: "terminal" }]);
    assert.deepEqual(d.question, { kind: "answered", sessionId: S("Kiko").sessionId, how: "name", added: "Tell it to check the logs too." });
    assert.equal(d.calls.router + d.calls.classifier, 0);
  });
  test("the rest cleaned up like any words for a session", async () => {
    const d = await answer("To Lacy, uh, and ask it if it deployed.", { clean: (t) => t.replace("uh, ", "") });
    assert.equal(d.outcomes[0].action === "send" && d.outcomes[0].text, `${ORIGINAL}\n\nAsk it if it deployed.`);
  });
  test("more that names another or changes the pick: the router reads it, with the words asked about", async () => {
    let seen: unknown = null;
    for (const said of ["Lacy. No wait, Kiko.", "Kiko, and tell Lacy too."]) {
      const d = await run(said, {
        recent: RECENT,
        appAsked: true,
        question: ASKED,
        router: () => [],
      });
      assert.equal(d.calls.router, 1, said);
    }
    // The router is shown the words asked about and the sessions offered.
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      trim: null,
      route: async (input) => {
        seen = input.question;
        return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
    };
    await decide(
      {
        text: "Not Lacy.",
        sessions: W.sessions,
        notes: W.notes,
        recent: RECENT,
        waiting: null,
        justSpoke: null,
        lastId: null,
        appAsked: true,
        lastSent: null,
        lastRepeat: false,
        voiceCan: "messages",
        classifierMinConfidence: 0.75,
        question: ASKED,
      },
      deps,
    );
    assert.deepEqual(seen, { text: ORIGINAL, offered: [S("Lacy"), S("Kiko")] });
  });
});

describe("the safety net: the router's pass_on of an answer that only picks", () => {
  test("pass_on(Kiko) for 'The notes file one.': the words asked about, not the answer", async () => {
    const d = await answer("The notes file one.", { router: (s) => [{ name: "pass_on", session: s("Kiko") }] });
    assert.equal(d.calls.router, 1);
    assert.deepEqual(d.outcomes, [{ action: "send", to: "Kiko project", text: ORIGINAL, via: "terminal" }]);
    assert.deepEqual(d.question, { kind: "answered", sessionId: S("Kiko").sessionId, how: "router" });
  });
  test("pass_on of 'Yes.' after a question that offered one: the words asked about", async () => {
    const one: Question = { ...ASKED, offered: [S("Lacy").sessionId], line: "Should that go to Lacy?" };
    const d = await answer("Yes.", { question: one, recent: [RECENT[0], "app said: Should that go to Lacy?"], router: (s) => [{ name: "pass_on", session: s("Lacy") }] });
    assert.deepEqual(d.outcomes, [{ action: "send", to: "Lacy", text: ORIGINAL, via: "terminal" }]);
  });
  test("pass_on of words with a request of their own: those words, and the question isn't answered", async () => {
    const said = "Actually, run the release checklist in Kiko now.";
    const d = await answer(said, { router: (s) => [{ name: "pass_on", session: s("Kiko") }] });
    assert.deepEqual(
      d.outcomes.map((o) => o.action === "send" && o.text),
      [said],
    );
    assert.equal(d.question, undefined);
  });
  test("ask_session written by the router: the question counts as answered", async () => {
    const d = await answer("The notes one, and ask it to check the logs.", {
      router: (s) => [{ name: "ask_session", session: s("Kiko"), message: "Just trying this out from the tablet. Also check the logs." }],
    });
    assert.deepEqual(d.question, { kind: "answered", sessionId: S("Kiko").sessionId, how: "router" });
  });
});

describe("never mind: the words asked about are dropped, and the app says so", () => {
  for (const said of ["Never mind.", "Cancel.", "Forget it.", "Neither.", "None of them.", "Kiko, never mind."]) {
    test(JSON.stringify(said), async () => {
      const d = await answer(said);
      assert.deepEqual(d.outcomes, [{ action: "say", text: "Okay, not sent." }]);
      assert.deepEqual(d.question, { kind: "cancelled" });
      assert.equal(d.calls.router + d.calls.classifier, 0);
    });
  }
  test("dropsQuestion: not a pick, nor 'no' alone", () => {
    assert.equal(dropsQuestion("Neither one, thanks."), true);
    assert.equal(dropsQuestion("Kiko."), false);
    assert.equal(dropsQuestion("No."), false);
    assert.equal(dropsQuestion("No, Lacy."), false);
  });
});

describe("AskedWhere: kept until your next words, or a minute", () => {
  test("taken once: the words asked about go at most once", () => {
    const clock = new FakeClock();
    const a = new AskedWhere({ clock });
    assert.equal(a.open, false);
    a.set(ASKED);
    assert.equal(a.open, true);
    clock.advance(5_000);
    assert.deepEqual(a.take(), { question: ASKED, at: 0, told: false });
    assert.equal(a.open, false);
    assert.equal(a.take(), null);
    clock.advance(QUESTION_MS);
    assert.equal(clock.pending(), 0, "taken: it doesn't run out later");
  });
  test("after QUESTION_MS it runs out by itself: onExpired, with how long it waited (never silently)", () => {
    const clock = new FakeClock();
    const a = new AskedWhere({ clock });
    const gone: unknown[] = [];
    a.onExpired = (x) => gone.push(x);
    a.set(ASKED);
    clock.advance(QUESTION_MS - 1);
    assert.equal(a.open, true);
    assert.deepEqual(gone, []);
    clock.advance(1);
    assert.equal(a.open, false);
    assert.deepEqual(gone, [{ question: ASKED, at: 0, told: false, ageMs: QUESTION_MS }]);
  });
  test("not while you talk or your words are dealt with: they may answer it", () => {
    const clock = new FakeClock();
    let busy = true;
    const a = new AskedWhere({ clock, busy: () => busy });
    const gone: number[] = [];
    a.onExpired = (x) => gone.push(x.ageMs);
    a.set(ASKED);
    clock.advance(QUESTION_MS + 2_000);
    assert.equal(a.open, true, "still there for your words to take");
    busy = false;
    clock.advance(500);
    assert.deepEqual(gone, [QUESTION_MS + 2_500]);
  });
  test("a new question replaces the last: the one replaced comes back when it was about other words", () => {
    const a = new AskedWhere({ clock: new FakeClock() });
    assert.equal(a.set(ASKED), null);
    assert.equal(a.set(ASKED), null, "asked again about the same words");
    const next = { ...ASKED, text: "Run the tests." };
    assert.equal(a.set(next)?.question, ASKED);
    assert.equal(a.take()?.question, next);
  });
  test("moved on from: kept (told), for another QUESTION_MS; taken and put back, it keeps its time", () => {
    const clock = new FakeClock();
    const a = new AskedWhere({ clock });
    const gone: unknown[] = [];
    a.onExpired = (x) => gone.push(x.told);
    a.set(ASKED);
    clock.advance(50_000);
    a.take();
    a.set(ASKED, true); // the app said they weren't sent: a fresh minute
    clock.advance(30_000);
    const again = a.take()!; // more words, not a pick: put back as it was
    a.restore(again);
    clock.advance(29_999);
    assert.deepEqual(gone, []);
    clock.advance(1);
    assert.deepEqual(gone, [true]);
  });
});

// Words that move on from the question: the app keeps the words it asked about (told) and says once that they
// weren't sent (app.ts settleQuestion; the harness runs it). Only a plain pick sends them then.
describe("moved on from: only a plain pick sends the words asked about", () => {
  const TOLD: Question = { ...ASKED, told: true };
  const later = (text: string, more: Partial<DecideState> & Stub = {}) =>
    run(text, { recent: [...RECENT, "you → app: Check the build.", 'app said: I didn\'t send "Just trying this out from…" anywhere.'], question: TOLD, ...more });
  for (const said of ["Kiko.", "The first one.", "Send it to Lacy."]) {
    test(`${JSON.stringify(said)}: sent, no model call`, async () => {
      const d = await later(said);
      assert.equal(d.step, "question");
      assert.deepEqual(
        d.outcomes.map((o) => o.action === "send" && o.text),
        [ORIGINAL],
      );
      assert.equal(d.question?.kind, "answered");
      assert.deepEqual(d.calls, { classifier: 0, router: 0, clean: 0 });
    });
  }
  test("a pick with more to it is new words for that session, not the words asked about", async () => {
    const d = await later("Lacy, run the tests.", { router: (s) => [{ name: "pass_on", session: s("Lacy") }] });
    assert.deepEqual(
      d.outcomes.map((o) => o.action === "send" && o.text),
      ["Run the tests."],
      "as words for Lacy, without its name",
    );
    assert.equal(d.question, undefined);
  });
  test("'never mind' isn't about them: there's nothing to cancel", async () => {
    const d = await later("Never mind.", { lastSent: { sessionId: S("Clipkit").sessionId, folder: "clipkit", text: "Check the build." } });
    assert.notEqual(d.question?.kind, "cancelled");
    assert.ok(!d.outcomes.some((o) => o.action === "say" && o.text === "Okay, not sent."));
  });
  test("the router isn't shown them, so it can't mix them into new words", async () => {
    let seen: unknown = "unset";
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      trim: null,
      route: async (input) => {
        seen = input.question;
        return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
    };
    await decide(
      {
        text: "Ask Lacy what's next.",
        sessions: W.sessions,
        notes: W.notes,
        recent: RECENT,
        waiting: null,
        justSpoke: null,
        lastId: null,
        appAsked: false,
        lastSent: null,
        lastRepeat: false,
        voiceCan: "messages",
        classifierMinConfidence: 0.75,
        question: TOLD,
      },
      deps,
    );
    assert.equal(seen, null);
  });
});
