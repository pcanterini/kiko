// A yes to the app's own offer carries the offer out (decide.ts asksWhere, answerQuestion, onlyPicks,
// the router's resend_to): the words the app asked about go, never the yes. The case, with made-up
// names: right after a restart (nothing in the conversation), a question about building something
// like Vantage (a product being talked about, not a session) named no session; the router answered
// in its own words that Vantage wasn't one of the sessions, that it couldn't tell which project, and
// offered to ask Rowan, whose last topic it was. The app took "project" in that line as naming the
// Kiko project, so it kept a "which one: Kiko project or Rowan?" question rather than an offer of
// Rowan; "Yes, and it's to Rowan." then picked nothing in code, the router's pass_on of it wasn't read
// as a pick (the "and"), and the yes itself was typed into Rowan.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState, type Question } from "../../../src/core/decide.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  {
    name: "kiko",
    folder: "kiko",
    given: "Kiko project",
    title: "Permission prompt wording",
    status: "idle",
    asked: "Which API key does the test clone use, mine or its own?",
    said: "It uses its own, from the clone's settings. Pull, then start it again to check.",
  },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    status: "idle",
    asked: "Isn't that already what Rowan is meant to be, with a few more features?",
    said: "Mostly, yes: Rowan stays the private place, and the connector is how outside agents reach it without anything private leaking back.",
  },
  { name: "mintbox", title: "Store screenshots", status: "idle", asked: "Make the dark set next.", said: "The dark set is done." },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const ROWAN = () => S("Rowan");
const KIKO = () => S("kiko");

const ASKED = "So if I wanted to build something exactly like Vantage, what would that look like?";
// The router's offer in its own words, as it said it.
const FREE_OFFER =
  "Vantage isn't one of your sessions, so I can't tell which project you mean. Rowan looks like the closest match, since its recent topics are about a private platform for agents. Want me to ask the Rowan session what building something like Vantage would involve?";
const OFFERED: Question = { text: ASKED, offered: [ROWAN().sessionId], line: FREE_OFFER, offer: true };
// What the app kept before the fix: a question offering both.
const BOTH: Question = { text: ASKED, offered: [KIKO().sessionId, ROWAN().sessionId], line: FREE_OFFER };

type Stub = { router?: (s: (n: string) => Session) => Action[]; says?: string };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen = { router: 0 };
  const deps: DecideDeps = {
    // Rowan at 0.54, under the bar: the router decides.
    utterance: async () => ({ audience: ROWAN(), audienceConfidence: 0.54, intent: "message", intentConfidence: 1, appParts: 0, model: "test", costUsd: 0, ms: 1 }),
    approval: null,
    route: async () => {
      seen.router++;
      return { text: opts.says ?? "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    // Just restarted: nothing said yet.
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

const after = (text: string, question: Question, opts: Partial<DecideState> & Stub = {}) =>
  run(text, { recent: [`you → app: ${ASKED}`, `app said: ${question.line}`], appAsked: true, question, ...opts });

const TO_ROWAN = { action: "send", to: "Rowan", text: ASKED, via: "terminal" };

describe("the router's offer in its own words keeps the one session it offers", () => {
  test("'which project you mean' names no Kiko project: an offer of Rowan alone", async () => {
    const { d } = await run(ASKED, { says: FREE_OFFER });
    assert.deepEqual(d.question, { kind: "asked", question: OFFERED });
  });

  test("a session named in the line by a word of its own still counts ('the Kiko project or Rowan?')", async () => {
    const line = "Is that for the Kiko project or Rowan?";
    const { d } = await run(ASKED, { says: line });
    assert.deepEqual(d.question, { kind: "asked", question: { text: ASKED, offered: [KIKO().sessionId, ROWAN().sessionId], line } });
  });

  test("'Is this for Rowan?': kept as a check of Rowan, so a yes sends the words there", async () => {
    const line = "Is this for Rowan?";
    const asked = await run(ASKED, { says: line });
    assert.deepEqual(asked.d.question, { kind: "asked", question: { text: ASKED, offered: [ROWAN().sessionId], line } });
    const { outcomes, seen } = await after("Yes.", { text: ASKED, offered: [ROWAN().sessionId], line });
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });
});

describe("a yes to the offer sends the words offered, never the yes", () => {
  test("'Yes, and it's to Rowan.': the question goes to Rowan, read in code", async () => {
    const { d, outcomes, seen } = await after("Yes, and it's to Rowan.", OFFERED);
    assert.equal(seen.router, 0);
    assert.deepEqual(d.question, { kind: "answered", sessionId: ROWAN().sessionId, how: "yes" });
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("other ways: a yes, a yes with the name, the name alone, 'send it to Rowan'", async () => {
    for (const said of ["Yes.", "Yeah, go ahead.", "Yes, to Rowan.", "Rowan.", "Send it to Rowan."]) {
      const { outcomes } = await after(said, OFFERED);
      assert.deepEqual(outcomes, [TO_ROWAN], said);
    }
  });

  test("with both sessions kept (the question the app asked before): 'Yes, and it's to Rowan.' picks Rowan in code", async () => {
    const { outcomes, seen } = await after("Yes, and it's to Rowan.", BOTH);
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("the router's pass_on of a yes the code didn't read: the words asked about go (onlyPicks reads the 'and')", async () => {
    const { outcomes, seen } = await after("Yes, and over to Rowan, right.", BOTH, { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("the router's resend_to while the question waits: the words asked about go there, not a correction", async () => {
    const { d, outcomes } = await after("Yes, and over to Rowan, right.", BOTH, { router: (s) => [{ name: "resend_to", session: s("Rowan") }] });
    assert.deepEqual(outcomes, [TO_ROWAN]);
    assert.deepEqual(d.question, { kind: "answered", sessionId: ROWAN().sessionId, how: "router" });
    assert.ok(!d.correction, "nothing went wrong: a held send isn't asked about");
  });

  test("a yes with a request of its own is the router's, the words offered and the request as one message", async () => {
    const message = `${ASKED} Keep it to the main parts.`;
    const { outcomes, seen } = await after("Yes, and keep it to the main parts.", OFFERED, { router: (s) => [{ name: "ask_session", session: s("Rowan"), message }] });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [{ action: "ask", to: "Rowan", message, via: "terminal" }]);
  });
});

describe("a no drops the words; new words go where they would have", () => {
  test("no: nothing sent, and said", async () => {
    for (const said of ["No.", "No, thanks.", "Nah, leave it."]) {
      const { d, outcomes } = await after(said, OFFERED);
      assert.deepEqual(d.question, { kind: "cancelled" }, said);
      assert.deepEqual(outcomes, [{ action: "say", text: "Okay, not sent." }], said);
    }
  });

  test("new words for another session: they go there, as said; the words offered don't", async () => {
    const { d, outcomes } = await after("Tell mintbox to make the light set too.", OFFERED, { router: (s) => [{ name: "pass_on", session: s("mintbox") }] });
    assert.deepEqual(outcomes, [{ action: "send", to: "mintbox", text: "Make the light set too.", via: "terminal" }]);
    assert.equal(d.question, undefined);
  });

  test("a question for the app: answered, the words offered not sent", async () => {
    const { outcomes } = await after("What time is it?", OFFERED, { says: "It's 2:50 pm." });
    assert.deepEqual(outcomes, [{ action: "say", text: "It's 2:50 pm." }]);
  });
});

// ── An answer to the offer that names another session ────────────────────────────────────────────
// The case, with made-up names: words naming no session; the router offered api ("Want me to send
// that to api?") and the app held them. The answer, "this to Rowan", was heard as "Thus, too, Rowan.":
// it picked nothing in code, the router's pass_on of it to Rowan wasn't read as a pick (onlyPicks
// didn't know "thus", "too"), so the app let the words offered go and typed the answer into Rowan.
const R = makeWorld([
  { name: "api", title: "Retry limits", status: "idle", asked: "Where does the retry limit live now?", said: "It's hard-coded in the client for now." },
  { name: "Rowan", folder: "rowan-platform", given: "Rowan", status: "idle", asked: "Is the settings page done?", said: "Yes, the settings page is done." },
  { name: "kiko", folder: "kiko", given: "Kiko project", status: "idle", asked: "Fix the overlay.", said: "The overlay is fixed." },
]);
const RS = (name: string) => R.byName.get(name.toLowerCase())!;
const HELD = "Can we move the retry limit into the settings file?";
const API_OFFER: Question = { text: HELD, offered: [RS("api").sessionId], line: "Want me to send that to api?", offer: true };

async function redirect(text: string, opts: Stub = {}) {
  const seen = { router: 0 };
  const deps: DecideDeps = {
    utterance: async () => ({ audience: RS("api"), audienceConfidence: 0.5, intent: "message", intentConfidence: 1, appParts: 0, model: "test", costUsd: 0, ms: 1 }),
    approval: null,
    route: async () => {
      seen.router++;
      return { text: opts.says ?? "", actions: opts.router?.(RS) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: null,
  };
  const state: DecideState = {
    text,
    sessions: R.sessions,
    notes: R.notes,
    recent: [`you → app: ${HELD}`, `app said: ${API_OFFER.line}`],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: true,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    question: API_OFFER,
  };
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state).map(({ sessionId: _id, ...o }) => o), seen };
}

const HELD_TO = (to: string) => ({ action: "send", to, text: HELD, via: "terminal" });

describe("an answer to the offer naming another session sends the words offered there, never the answer", () => {
  test("read in code: the name with only direction or filler words, misheard ones too", async () => {
    for (const said of ["This to Rowan.", "No, to Rowan.", "Send it to Rowan.", "Rowan.", "To Rowan instead.", "Actually, Rowan.", "Thus, too, Rowan.", "This two Rowan.", "Tue Rowan."]) {
      const { d, outcomes, seen } = await redirect(said);
      assert.equal(seen.router, 0, said);
      assert.deepEqual(outcomes, [HELD_TO("Rowan")], said);
      assert.equal(d.question?.kind, "answered", said);
    }
  });

  test("the session offered, said the same misheard way: the words go there", async () => {
    for (const said of ["Thus, too, api.", "This two api."]) {
      const { outcomes } = await redirect(said);
      assert.deepEqual(outcomes, [HELD_TO("api")], said);
    }
  });

  test("the router's pass_on of a short answer the code didn't read: the words offered go (redirectsAsked)", async () => {
    for (const said of ["Dus, tew, Rowan.", "Thus to Rowan, then.", "Sand it Rowan."]) {
      const { outcomes, seen } = await redirect(said, { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
      assert.equal(seen.router, 1, said);
      assert.deepEqual(outcomes, [HELD_TO("Rowan")], said);
    }
  });

  test("the router checking the name it heard (confirm_session): the words offered go, not the answer", async () => {
    const { outcomes } = await redirect("Dus, tew, Rowan.", { router: (s) => [{ name: "confirm_session", session: s("Rowan"), heard: "Rowan", message: "" }] });
    assert.deepEqual(outcomes, [HELD_TO("Rowan")]);
  });

  test("a name said only loosely and checked: the check is about the words offered", async () => {
    const { d } = await redirect("Thus, too, Rowen.", { router: (s) => [{ name: "confirm_session", session: s("Rowan"), heard: "Rowen", message: "" }] });
    assert.equal(d.question?.kind, "asked");
    assert.equal(d.question?.kind === "asked" && d.question.question.text, HELD);
  });

  test("the router offering the named session instead: the offer is about the words offered, not the answer", async () => {
    const { d, outcomes } = await redirect("Dus, tew, Rowan.", { router: (s) => [{ name: "offer_session", session: s("Rowan") }] });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "Want me to send that to Rowan?" }]);
    assert.equal(d.question?.kind === "asked" && d.question.question.text, HELD);
  });

  test("the router's resend_to of it: the words offered go there", async () => {
    const { outcomes } = await redirect("Dus, tew, Rowan.", { router: (s) => [{ name: "resend_to", session: s("Rowan") }] });
    assert.deepEqual(outcomes, [HELD_TO("Rowan")]);
  });
});

describe("not a redirect: a real request, a no, other words", () => {
  test("'Rowan, run the tests.': new words for Rowan, as said; the words offered don't go", async () => {
    const { d, outcomes, seen } = await redirect("Rowan, run the tests.", { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
    assert.equal(seen.router, 1, "the router reads a request of its own");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].action, "send");
    assert.equal((outcomes[0] as { to: string }).to, "Rowan");
    assert.match((outcomes[0] as { text: string }).text, /run the tests/i);
    assert.doesNotMatch((outcomes[0] as { text: string }).text, /retry limit/i);
    assert.notEqual(d.question?.kind, "answered");
  });

  test("short, but with a request verb: new words", async () => {
    for (const said of ["Rowan, check it.", "Fix Rowan."]) {
      const { outcomes } = await redirect(said, { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
      assert.equal(outcomes.length, 1, said);
      assert.doesNotMatch((outcomes[0] as { text: string }).text, /retry limit/i, said);
    }
  });

  test("'No.': nothing sent", async () => {
    const { d, outcomes } = await redirect("No.");
    assert.deepEqual(d.question, { kind: "cancelled" });
    assert.deepEqual(outcomes, [{ action: "say", text: "Okay, not sent." }]);
  });

  test("words naming no session, passed on by the router: they go as said, the words offered don't", async () => {
    const { outcomes } = await redirect("Too slow, the build is too slow.", { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
    assert.deepEqual(
      outcomes.map(({ unsure: _u, ...o }) => o),
      [{ action: "send", to: "Rowan", text: "Too slow, the build is too slow.", via: "terminal" }],
    );
  });
});
