// The app offering a session instead of acting is a real offer (router.ts offer_session, decide.ts
// guard and answerQuestion): "Want me to send that to Bobby?" keeps your own words, and a yes sends
// them there, never the yes. A pick the router is sure of isn't offered: it goes, held a moment ("To
// Bobby."). The case: a question about a backup setup on an office server, with Bobby the one working
// on that server; the router answered in its own words that Bobby was the one to ask and it could pass
// the question along, with no tool call, then passed on "Yes, pass it to Bobby." by itself, and Bobby
// was confused.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState, type Question } from "../../../src/core/decide.ts";
import { AskedWhere } from "../../../src/core/question.ts";
import { QUESTION_MS } from "../../../src/core/routing-rules.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

// As the route prompt would list them.
const W = makeWorld([
  {
    name: "mintbox",
    title: "Release signing key location",
    status: "idle",
    asked: "Does the phone's terminal app have a way to split the screen, or only one pane?",
    said: "Want me to install tmux (`brew install tmux`) and add a small config for it?",
  },
  {
    name: "Bobby",
    folder: "2026-01-20-internal",
    given: "Bobby",
    status: "idle",
    asked: "Is there a desktop app for the backup tool, or do I need to give the team a web link instead?",
    said: "The token is copied to the protected secrets file on the office server and never appears in the repo or output.",
  },
  { name: "kiko-dev", folder: "kiko", given: "kiko-dev", title: "Attach error in a new tab", status: "idle" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const BOBBY = () => S("Bobby");

// The user's words (made up), as speech-to-text would write them.
const ASKED =
  "Are you able to, um, set up a nightly copy of the, uh, photo vault folder that, uh, goes to the office server. Uh, but only over the work network we use? Don't change anything yet, only answer. We're only talking it through.";
const OFFER_LINE = "Want me to send that to Bobby?";
// What the router said in its own words.
const FREE_TEXT = "That one suits a session better than me. Bobby handles the office server backups, so I can pass your question along to it if you want.";
const OFFERED: Question = { text: ASKED, offered: [BOBBY().sessionId], line: OFFER_LINE, offer: true };

type Stub = { router?: (s: (n: string) => Session) => Action[]; says?: string; clean?: (text: string) => string };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen = { router: 0, classifier: 0 };
  const deps: DecideDeps = {
    // Bobby at 0.69, under the bar, so the router decides.
    utterance: async () => {
      seen.classifier++;
      return { audience: BOBBY(), audienceConfidence: 0.69, intent: "message", intentConfidence: 1, appParts: 0, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      seen.router++;
      return { text: opts.says ?? "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: opts.clean ? async (t: string) => ({ text: opts.clean!(t), cleaned: opts.clean!(t) !== t, costUsd: 0, ms: 1 }) : null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: ["app said (about Bobby): In Bobby, Claude says the backup report now lists each folder's size."],
    waiting: null,
    justSpoke: null,
    lastId: BOBBY().sessionId,
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

/** After the offer: the app's question is the last thing said, and the words are kept. */
const afterOffer = (text: string, opts: Partial<DecideState> & Stub = {}) => run(text, { recent: [`you → app: ${ASKED}`, `app said: ${OFFER_LINE}`], appAsked: true, question: OFFERED, ...opts });

describe("the question about the office server backups, with Bobby working on that server", () => {
  test("the router sure (pass_on): it goes to Bobby at once, your exact words, held a moment ('To Bobby.'), no offer", async () => {
    const { d, outcomes } = await run(ASKED, { router: (s) => [{ name: "pass_on", session: s("Bobby") }] });
    assert.deepEqual(outcomes, [{ action: "send", to: "Bobby", text: ASKED, via: "terminal", unsure: true }]);
    assert.equal(d.question, undefined, "nothing asked");
  });

  test("the router unsure (offer_session): 'Want me to send that to Bobby?', your words kept as said, Bobby the one offered", async () => {
    const { d, outcomes } = await run(ASKED, { router: (s) => [{ name: "offer_session", session: s("Bobby") }] });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: OFFER_LINE }]);
    assert.deepEqual(d.question, { kind: "asked", question: OFFERED });
    assert.ok(!d.actions.some((a) => a.type === "send" || a.type === "ask"), "nothing sent yet");
  });

  test("offered with the clean-up on: kept as pass_on would have sent them, never the router's words or the context's", async () => {
    const clean = (t: string) => t.replace(/,? (?:um|uh),?/g, "").replace("photo vault", "PhotoVault");
    const sent = await run(ASKED, { clean, router: (s) => [{ name: "pass_on", session: s("Bobby") }] });
    const offered = await run(ASKED, { clean, router: (s) => [{ name: "offer_session", session: s("Bobby") }] });
    const words = sent.d.actions[0].type === "send" ? sent.d.actions[0].text : "";
    assert.match(words, /PhotoVault/);
    assert.equal(offered.d.question?.kind === "asked" && offered.d.question.question.text, words);
  });

  test("the router's offer in its own words: kept as an offer of Bobby all the same", async () => {
    const { d, outcomes } = await run(ASKED, { says: FREE_TEXT });
    assert.deepEqual(outcomes, [{ action: "say", text: FREE_TEXT }]);
    assert.deepEqual(d.question, { kind: "asked", question: { text: ASKED, offered: [BOBBY().sessionId], line: FREE_TEXT, offer: true } });
  });

  test("an answer of its own that names a session but offers nothing isn't an offer", async () => {
    const { d } = await run("Is Bobby done?", { says: "Bobby is idle; it finished the backup report." });
    assert.equal(d.question, undefined);
  });
});

describe("a yes to the offer sends the words offered, never the yes", () => {
  test("'Yes, pass it to Bobby.': the question goes to Bobby, read in code, no model", async () => {
    const { d, outcomes, seen } = await afterOffer("Yes, pass it to Bobby.");
    assert.deepEqual([seen.router, seen.classifier], [0, 0]);
    assert.deepEqual(d.question, { kind: "answered", sessionId: BOBBY().sessionId, how: "yes" });
    assert.deepEqual(outcomes, [{ action: "send", to: "Bobby", text: ASKED, via: "terminal" }]);
  });

  test("other ways of saying yes", async () => {
    for (const said of ["Yes.", "Yeah", "Yeah, pass it to Bobby.", "Send it.", "Go ahead.", "Do it.", "Sure, send it along, thanks.", "Yep, please do.", "Okay, pass it on to the Bobby session."]) {
      const { outcomes, seen } = await afterOffer(said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(outcomes, [{ action: "send", to: "Bobby", text: ASKED, via: "terminal" }], said);
    }
  });

  test("after the router's own free-text offer (no question mark, so not the app asking): the yes still sends the words", async () => {
    const { outcomes, seen } = await run("Yes, pass it to Bobby.", {
      recent: [`you → app: ${ASKED}`, `app said: ${FREE_TEXT}`],
      question: { text: ASKED, offered: [BOBBY().sessionId], line: FREE_TEXT, offer: true },
    });
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [{ action: "send", to: "Bobby", text: ASKED, via: "terminal" }]);
  });

  test("another session named instead: the words go there", async () => {
    const { outcomes } = await afterOffer("No, send it to mintbox.");
    assert.deepEqual(outcomes, [{ action: "send", to: "mintbox", text: ASKED, via: "terminal" }]);
  });

  test("a yes with more to it is the router's, with the words offered as <asked_where>", async () => {
    const message = `${ASKED} Also, how long would it keep old copies?`;
    const { outcomes, seen } = await afterOffer("Yes, and ask it how long it keeps old copies too.", { router: (s) => [{ name: "ask_session", session: s("Bobby"), message }] });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [{ action: "ask", to: "Bobby", message, via: "terminal" }]);
  });

  test("a yes the code doesn't read, passed on by the router: the words offered go, never the yes (decide.ts onlyPicks)", async () => {
    const { outcomes, seen } = await afterOffer("Yes, I'd say so.", { router: (s) => [{ name: "pass_on", session: s("Bobby") }] });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [{ action: "send", to: "Bobby", text: ASKED, via: "terminal" }]);
  });
});

describe("no drops the offer", () => {
  test("no, in a few words: nothing sent, and said", async () => {
    for (const said of ["No.", "Nope", "No, thanks.", "Nah, I'll ask it myself later.", "No, don't send it."]) {
      const { d, outcomes, seen } = await afterOffer(said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(d.question, { kind: "cancelled" }, said);
      assert.deepEqual(outcomes, [{ action: "say", text: "Okay, not sent." }], said);
    }
  });
});

describe("words that move on drop the offer, and go where they would have", () => {
  test("an unrelated question: routed as usual, the words offered not sent", async () => {
    const { d, outcomes, seen } = await afterOffer("What time is it?", { says: "It's 1:12 am." });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [{ action: "say", text: "It's 1:12 am." }]);
    assert.equal(d.question, undefined, "neither answered nor asked: the app lets it go (app/deliver.ts settleQuestion)");
  });

  test("new words for another session: they go there, as said; the words offered don't", async () => {
    const { d, outcomes } = await afterOffer("Tell mintbox to go ahead and install tmux.", { router: (s) => [{ name: "pass_on", session: s("mintbox") }] });
    assert.deepEqual(outcomes, [{ action: "send", to: "mintbox", text: "Go ahead and install tmux.", via: "terminal" }]);
    assert.equal(d.question, undefined);
  });
});

describe("the offer runs out like any question the app asks", () => {
  test("kept for QUESTION_MS, then let go with its words (onExpired), offer and all", () => {
    const clock = new FakeClock();
    const a = new AskedWhere({ clock });
    const gone: Array<{ question: Question; ageMs: number }> = [];
    a.onExpired = (g) => gone.push(g);
    a.set(OFFERED);
    clock.advance(QUESTION_MS - 1);
    assert.ok(a.open);
    clock.advance(1);
    assert.ok(!a.open);
    assert.deepEqual(
      gone.map((g) => [g.question.text, g.question.offer, g.ageMs]),
      [[ASKED, true, QUESTION_MS]],
    );
  });

  test("once it's gone, a yes is only a yes: nothing offered is sent", async () => {
    const { outcomes } = await run("Yes, pass it to Bobby.", {
      recent: [`you → app: ${ASKED}`, `app said: ${OFFER_LINE}`],
      router: (s) => [{ name: "pass_on", session: s("Bobby") }],
    });
    assert.ok(!outcomes.some((o) => o.action === "send" && o.text === ASKED));
  });
});
