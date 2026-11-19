// The code guards on where your words go (src/core/decide.ts), with the classifier and the router stubbed: the
// waiting session wins unless your words name another, one session per request unless you ask for
// more, stops only in the session picked, take-back phrases quoted as examples, and the topics and
// fan-out sends the timeline keeps (src/core/timeline.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { directionOff } from "../../../src/core/direction.ts";
import { decide, type DecideDeps, type DecideState, type Sent } from "../../../src/core/decide.ts";
import { quotesTakeBack } from "../../../src/core/routing-rules.ts";
import { sentWith, Timeline, topicLine, type Entry } from "../../../src/core/timeline.ts";
import { makeWorld, type World } from "../../support/fixtures.ts";
import { outcomesOf, type Outcome } from "../../support/outcomes.ts";

// As the route prompt listed them: three renamed sessions.
const W = makeWorld([
  { name: "Claude speech", folder: "claude-code-speech", given: "Claude speech", title: "Voice app notes and ideas", status: "busy", asked: "Can you look at a few more name ideas?" },
  { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates in secure checkout", status: "busy", asked: "Is anything still in progress?" },
  { name: "Clipkit", folder: "clipkit", given: "Clipkit", title: "ClipKit export window jump", status: "busy", asked: "Is the release deployed?" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const waits = (name: string) => ({ sessionId: S(name).sessionId, cwd: S(name).cwd });

type Stub = {
  classifier?: Partial<Omit<UtteranceDecision, "audience">> & { audience?: string };
  router?: (s: (name: string) => Session) => Action[];
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
    utterance: async () => {
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
      return { text: "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
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
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  const d = await decide(state, deps);
  const outcomes = outcomesOf(d, state).map(({ sessionId: _id, ...rest }) => rest as Outcome);
  return { ...d, outcomes, calls };
}

const ask =
  (name: string, message = ECHO) =>
  (s: (n: string) => Session): Action[] => [{ name: "ask_session", session: s(name), message }];
const ALL_TERMINALS = "Okay. What came out of the look at every terminal and so on? How much work would it be, roughly, a big lift?";

describe("the waiting session wins unless your words name another", () => {
  test("the router asks another, unnamed: your words go to the waiting one as its reply", async () => {
    const d = await run(ALL_TERMINALS, { waiting: waits("Claude speech"), router: ask("Clipkit") });
    assert.deepEqual(d.outcomes, [{ action: "send", to: "Claude speech", text: ALL_TERMINALS, via: "reply" }]);
    assert.deepEqual(
      d.guards?.map((g) => [g.rule, g.by, g.fromName]),
      [["waiting_wins", "router ask_session", "Clipkit"]],
    );
  });
  test("pass_on to another, unnamed: the waiting one", async () => {
    const d = await run("Is it a big lift?", { waiting: waits("Claude speech"), router: (s) => [{ name: "pass_on", session: s("Lacy") }] });
    assert.equal(d.outcomes[0].action === "send" && d.outcomes[0].to, "Claude speech");
  });
  test("the classifier sure of another, unnamed: the waiting one", async () => {
    const d = await run("Is it a big lift?", { waiting: waits("Claude speech"), classifier: { audience: "Clipkit", audienceConfidence: 0.95 } });
    assert.equal(d.step, "classifier");
    assert.equal(d.outcomes[0].action === "send" && d.outcomes[0].to, "Claude speech");
    assert.equal(d.guards?.[0].by, "classifier");
  });
  const kept = (said: string, to: string, more: Partial<DecideState> = {}) =>
    test(`kept: ${JSON.stringify(said)} → ${to}`, async () => {
      const d = await run(said, { waiting: waits("Claude speech"), router: ask(to), ...more });
      assert.deepEqual(
        d.outcomes.map((o) => [o.action, "to" in o ? o.to : ""]),
        [["ask", to]],
      );
      assert.equal(d.guards, undefined);
    });
  kept("What about Lacy? Is anything still running there?", "Lacy");
  kept("In the lacy platform, what's left before the release?", "Lacy");
  kept("How's the export window jump fix doing?", "Clipkit");
  kept("Ask the other one what's next.", "Clipkit");
  kept("Unrelated, but is the release out?", "Clipkit");
  kept("Clip kit, is the release out?", "Clipkit");
  kept("The one I asked about, yes.", "Clipkit", { appAsked: true });
  test("a session that just spoke (its window closed) isn't held to: the topic can win there", async () => {
    const d = await run(ALL_TERMINALS, { justSpoke: { id: S("Clipkit").sessionId, secondsAgo: 20 }, router: ask("Claude speech") });
    assert.equal(d.outcomes[0].action === "ask" && d.outcomes[0].to, "Claude speech");
  });
  test("'the voice app …' while another waits: the session on this app's code keeps it", async () => {
    const d = await run("The voice app's status bar never says speaking.", { waiting: waits("Clipkit"), router: ask("Claude speech") });
    assert.equal(d.outcomes[0].action === "ask" && d.outcomes[0].to, "Claude speech");
  });
  test("a correction isn't held to the waiting one", async () => {
    const lastSent: Sent = { sessionId: S("Clipkit").sessionId, folder: "Clipkit", text: "Run the tests." };
    const d = await run("That was supposed to go to lacy.", { waiting: waits("Claude speech"), lastSent, router: (s) => [{ name: "resend_to", session: s("Lacy") }] });
    assert.equal(d.outcomes[0].action, "resend");
  });
});

describe("one session per request unless you ask for more", () => {
  const ALL3 = (s: (n: string) => Session): Action[] => ["Lacy", "Claude speech", "Clipkit"].map((n) => ({ name: "ask_session", session: s(n), message: ECHO }));
  const to = (d: Awaited<ReturnType<typeof run>>) => d.outcomes.map((o) => `${o.action}:${"to" in o ? o.to : "text" in o ? o.text : ""}`);
  test("asked of all three, the one that just spoke gets it", async () => {
    const d = await run("What was the decision on 104 mixing digits and words?", { justSpoke: { id: S("Claude speech").sessionId, secondsAgo: 22 }, router: ALL3 });
    assert.deepEqual(to(d), ["ask:Claude speech"]);
    assert.deepEqual(
      d.guards?.map((g) => [g.rule, g.fromName]),
      [
        ["one_target", "Lacy"],
        ["one_target", "Clipkit"],
      ],
    );
  });
  test("nothing pending, nobody's topic: the app asks which", async () => {
    const d = await run("What was the decision on 104 mixing digits and words?", { router: ALL3 });
    assert.deepEqual(to(d), ["ask_user:Which session is that for?"]);
  });
  test("nothing pending, the first pick's topic: that one", async () => {
    const world = makeWorld([
      { name: "Claude speech", folder: "claude-code-speech", given: "Claude speech", earlier: [{ minutesAgo: 90, text: "What about mixing digits and words in the names?" }] },
      { name: "Lacy", folder: "lacy-platform", given: "Lacy" },
    ]);
    const d = await run("What was the decision on mixing digits and words?", {
      world,
      sessions: world.sessions,
      notes: world.notes,
      router: (s) => ["Claude speech", "Lacy"].map((n) => ({ name: "ask_session", session: s(n), message: ECHO })),
    });
    assert.deepEqual(to(d), ["ask:Claude speech"]);
  });
  test("'all of them': every one", async () => {
    const d = await run("Ask all of them what the decision was.", { router: ALL3 });
    assert.equal(d.outcomes.length, 3);
  });
  test("each named: each", async () => {
    // A question code can't turn direct (sessions.ts toSeveral splits "Ask Lacy and Clipkit what the decision was" itself).
    const d = await run("Ask Lacy and Clipkit whether the decision went through.", { router: (s) => ALL3(s).filter((a) => a.name === "ask_session" && a.session !== s("Claude speech")) });
    assert.deepEqual(to(d), ["ask:Lacy", "ask:Clipkit"]);
  });
});

describe("stops land only on the session picked, named", () => {
  const stops =
    (...names: string[]) =>
    (s: (n: string) => Session): Action[] =>
      names.map((n) => ({ name: "stop_session", session: s(n) }));
  const what = (d: Awaited<ReturnType<typeof run>>) => d.outcomes.map((o) => `${o.action}:${"to" in o ? o.to : "text" in o ? o.text : ""}`);
  test("'Stop Casey, uh, Casey, and stop Clipkit': Clipkit stopped, Lacy asked about, never Clipkit twice", async () => {
    const d = await run("Stop Casey, uh, Casey, and stop Clipkit.", { router: stops("Clipkit", "Lacy") });
    assert.deepEqual(what(d), ["stop:Clipkit", "ask_user:Stop Lacy?"]);
  });
  test("'You can stop both the Lazy and Clipkit': the question comes last", async () => {
    const d = await run("You can stop both the Lazy and Clipkit.", { router: stops("Lacy", "Clipkit") });
    assert.deepEqual(what(d), ["stop:Clipkit", "ask_user:Stop Lacy?"]);
  });
  test("both named exactly: both stopped", async () => {
    const d = await run("Stop Lacy and stop Clipkit.", { router: stops("Lacy", "Clipkit") });
    assert.deepEqual(what(d), ["stop:Lacy", "stop:Clipkit"]);
  });
  test("two stops for one session: one Escape", async () => {
    const d = await run("Stop Clipkit, stop it now.", { router: stops("Clipkit", "Clipkit") });
    assert.deepEqual(what(d), ["stop:Clipkit"]);
  });
  test("a pick the words don't name isn't moved to the one they do", async () => {
    const d = await run("Stop Clipkit, it's stuck.", { router: stops("Claude speech") });
    assert.deepEqual(what(d), ["ask_user:Stop which one? Say its name."]);
  });
  test("'stop' and nothing but names: read in code, no router", async () => {
    for (const [said, want] of [
      ["Stop Lacy and Clipkit.", ["stop:Lacy", "stop:Clipkit"]],
      ["Stop lazy.", ["ask_user:Stop Lacy?"]],
      ["You can stop both the Lazy and Clipkit.", ["stop:Clipkit", "ask_user:Stop Lacy?"]],
      ["Stop L-A-C-Y.", ["stop:Lacy"]],
    ] as const) {
      const d = await run(said, { router: stops("Claude speech") });
      assert.deepEqual(what(d), want, said);
      assert.equal(d.calls.router + d.calls.classifier, 0, said);
    }
  });
  test("'stop' with other words is the router's: 'Stop the deploy.'", async () => {
    const d = await run("Stop the deploy.", { router: () => [] });
    assert.equal(d.calls.router, 1);
  });
  test("'stop <name>' below 'everything': refused", async () => {
    const d = await run("Stop Clipkit.", { voiceCan: "messages" });
    assert.deepEqual(what(d), ["refused:Clipkit"]);
  });
  test("'Stop lazy.': asked first", async () => {
    const d = await run("Stop lazy.", { router: stops("Lacy") });
    assert.deepEqual(what(d), ["ask_user:Stop Lacy?"]);
  });
  test("'clipkid' for clipkit: asked first", async () => {
    const d = await run("Stop clipkid.", { router: stops("Clipkit") });
    assert.deepEqual(what(d), ["ask_user:Stop Clipkit?"]);
  });
  test("a bare 'Stop.' never stops anything", async () => {
    const d = await run("Stop.", { router: stops("Clipkit") });
    assert.deepEqual(what(d), ["stop_ignored:Clipkit"]);
  });
  const WHICH = ["you → app: Stop lazy.", "app said: Stop which one? Say its name."];
  test("'Stop which one?' answered with letters: stopped, no router", async () => {
    const d = await run("L-A-C-Y.", { appAsked: true, recent: WHICH, router: stops("Clipkit") });
    assert.deepEqual(what(d), ["stop:Lacy"]);
    assert.equal(d.calls.router, 0);
  });
  test("'Stop which one?' answered with the name: stopped", async () => {
    const d = await run("Lacy.", { appAsked: true, recent: WHICH });
    assert.deepEqual(what(d), ["stop:Lacy"]);
  });
  test("'Stop which one?' answered with a near name: asked first", async () => {
    const d = await run("Lazy.", { appAsked: true, recent: WHICH });
    assert.deepEqual(what(d), ["ask_user:Stop Lacy?"]);
  });
  const ASKED = ["you → app: Stop lazy.", "app said: Stop Lacy?"];
  test("'Stop Lacy?' then yes: stopped", async () => {
    const d = await run("Yeah, do it.", { appAsked: true, recent: ASKED });
    assert.deepEqual(what(d), ["stop:Lacy"]);
    assert.equal(d.calls.router + d.calls.classifier, 0);
  });
  test("'Stop Lacy?' then no: nothing stopped", async () => {
    for (const no of ["No.", "Nope, leave it."]) {
      const d = await run(no, { appAsked: true, recent: ASKED });
      assert.ok(!d.outcomes.some((o) => o.action === "stop"), no);
    }
  });
  test("'Stop Lacy?' then yes, below 'everything': refused", async () => {
    const d = await run("Yes.", { appAsked: true, recent: ASKED, voiceCan: "messages" });
    assert.deepEqual(what(d), ["refused:Lacy"]);
  });
});

describe("take-backs and corrections, and phrases that only mention them", () => {
  const lastSent: Sent = { sessionId: S("Clipkit").sessionId, folder: "Clipkit", text: "Deploy the shipping rates fix." };
  test("quoted as an example: a message, not an undo", async () => {
    for (const said of ["Make sure we support phrases like never mind.", "Can you also support something like cancel that?", "Add a few more, e.g. scratch that."]) {
      const d = await run(said, { waiting: waits("Claude speech"), lastSent, classifier: { intent: "undo", audience: "Claude speech", audienceConfidence: 0.9 } });
      assert.equal(d.outcomes[0].action, "send", said);
    }
  });
  test("'…something like cancel that. Never mind.': the classifier's undo stands (a take-back of its own)", async () => {
    const d = await run("Right, and make sure we handle something like cancel that. Never mind.", { waiting: waits("Claude speech"), lastSent, classifier: { intent: "undo" } });
    assert.equal(d.outcomes[0].action, "undo");
  });
  test("quotesTakeBack", () => {
    assert.equal(quotesTakeBack("Support phrases like never mind and scratch that."), true);
    assert.equal(quotesTakeBack("Handle such as that was for clipkit."), true);
    assert.equal(quotesTakeBack("Never mind."), false);
    assert.equal(quotesTakeBack("Ugh, never mind, forget it."), false);
    assert.equal(quotesTakeBack("Something like cancel that. Never mind."), false);
    assert.equal(quotesTakeBack("Run the tests."), false);
  });
  test("'Never mind.' right after a send, nothing waiting: undo; with one waiting: a wrap-up", async () => {
    assert.equal((await run("Never mind.", { lastSent })).outcomes[0].action, "undo");
    assert.equal((await run("Never mind.", { lastSent, waiting: waits("Claude speech") })).outcomes[0].action, "wrap_up");
  });
  test("'Move that to the lacy one', 'send it to lacy instead': resent, no models", async () => {
    for (const said of ["Move that to the lacy one.", "Oops, send it to Lacy instead."]) {
      const d = await run(said, { lastSent });
      assert.deepEqual(
        d.outcomes.map((o) => [o.action, "to" in o ? o.to : ""]),
        [["resend", "Lacy"]],
        said,
      );
      assert.equal(d.calls.classifier + d.calls.router, 0);
    }
  });
  test("'Send that to production.', 'Move the button to the left.': not corrections", async () => {
    for (const said of ["Send that to production.", "Move the button to the left."]) {
      const d = await run(said, { lastSent, waiting: waits("Clipkit"), classifier: { audience: "Clipkit", audienceConfidence: 0.9 } });
      assert.equal(d.outcomes[0].action, "send", said);
    }
  });
  test("a correction with a request of its own goes to the router", async () => {
    const d = await run("No, that's for Lacy, and also ask it whether the release went out.", {
      lastSent,
      classifier: { intent: "redirect", audience: "Lacy", audienceConfidence: 0.9 },
      router: (s) => [
        { name: "resend_to", session: s("Lacy") },
        { name: "ask_session", session: s("Lacy"), message: "Did the release go out?" },
      ],
    });
    assert.equal(d.calls.router, 1);
    assert.deepEqual(
      d.outcomes.map((o) => o.action),
      ["resend", "ask"],
    );
  });
  test("after a send to several, 'that was just for Claude speech': it already has it", async () => {
    const all: Sent = {
      ...lastSent,
      also: [
        { sessionId: S("Claude speech").sessionId, folder: "Claude speech" },
        { sessionId: S("Lacy").sessionId, folder: "Lacy" },
      ],
    };
    const d = await run("No, hold on, that went to the wrong ones, it was only for Claude Speech.", { lastSent: all, classifier: { intent: "redirect" } });
    assert.equal(d.actions[0].type, "resend");
    assert.deepEqual(d.outcomes, [{ action: "say", text: "That already went to Claude speech." }]);
  });
});

describe("timeline: topics and sends to several", () => {
  test("topicLine: the main words and how long ago; one word or none is no topic", () => {
    assert.equal(
      topicLine("Uh, while you're on that? Can we investigate a little what would be required to run in all terminals? Uh, not just ghosty?", 30 * 60_000),
      "30m ago: investigate required terminals ghosty",
    );
    assert.equal(topicLine("Yeah, you can commit.", 60_000), null);
    assert.equal(topicLine("Sure.", 60_000), null);
  });
  test("topics: newest first, past the recent entries, without the latest ask, bare replies or repeats", () => {
    const t = new Timeline();
    const you = (text: string, sessionId = "voice") => t.add({ who: "you", sessionId, folder: sessionId, text });
    you("Can we investigate what working on all terminals would take?");
    you("Run the dictionary tests again please.");
    you("Run the dictionary tests again please.");
    you("Yeah.");
    you("Check the clipkit release notes.", "clipkit");
    you("Revisit the naming options from earlier.");
    you("Look into names with vibe.");
    const topics = t.topics("voice", { count: 8, recent: 1, skip: (x) => x === "Yeah." });
    assert.deepEqual(
      topics.map((x) => x.split(": ")[1]),
      ["revisit naming options earlier", "dictionary tests", "investigate working terminals"],
    );
  });
  test("sentWith: the same words in the same press, not an earlier send of them", () => {
    const at = Date.now();
    const e = (sessionId: string | null, text: string, turn?: number): Entry => ({ at, who: "you", sessionId, folder: sessionId, text, turn });
    const entries = [e("voice", "Q", 1), e(null, "q said"), e("lacy", "Q", 2), e("voice", "Q", 2), e("clipkit", "Q", 2)];
    assert.deepEqual(
      sentWith(entries, entries[4]).map((x) => x.sessionId),
      ["voice", "lacy"],
    );
    const again = [e("voice", "Q", 1), e("clipkit", "Q", 2)];
    assert.deepEqual(sentWith(again, again[1]), []);
  });
});
