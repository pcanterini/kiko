// A correction right after the app dealt with your words itself (timeline.ts Entry.handled,
// latestSend; decide.ts handledBy, resend_to; app/deliver.ts resend). The case, with made-up names
// and words: a question meant for Rowan named no session, and the router ran a quick check on it.
// "Send that to Rowan, don't check it yourself" (the name misheard) then went to the router, which
// passed it on to Rowan as is: the correction was typed into Rowan, the question never reached it,
// and the quick check's answer was read out after. "That was for Rowan" only ever meant words that
// went to a session (latestSend stopped at words the app had dealt with), so there was nothing
// for resend_to to send. Now those words are what it sends, and the correction never goes.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, handledBy, type Decision, type DecideDeps, type DecideState, type Sent } from "../../../src/core/decide.ts";
import type { Action, Router } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { latestSend, type Entry, type Handled } from "../../../src/core/timeline.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "api", title: "Retry limits", status: "idle", activeAgoS: 60, asked: "Where does the retry limit live now?", said: "It's in the client for now." },
  { name: "Rowan", folder: "rowan-platform", given: "Rowan", status: "busy", activeAgoS: 20, asked: "Run the nightly import on the staging box.", said: "Starting the import now." },
  { name: "mintbox", title: "Store screenshots", status: "idle", activeAgoS: 2880, asked: "Make the dark set next.", said: "The dark set is done." },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

// The words the app dealt with itself, and what it said for them.
const ASKED = "Did the nightly import finish on the staging box?";
const LINES: Record<Handled, string[]> = {
  quick_task: [`you → app: ${ASKED}`, "app said: Checking."],
  answered: [`you → app: ${ASKED}`, "app said: I can't tell from here whether it finished."],
  start: ["you → app: Open a session for the nightly import.", "app said: Opened a session in the scratch folder."],
};
const appSent = (how: Handled, text = how === "start" ? "Open a session for the nightly import." : ASKED): Sent => ({ sessionId: "", folder: "", text, app: how });

type Stub = { router?: (s: (n: string) => Session) => Action[]; says?: string; classifier?: Partial<UtteranceDecision> };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen: { router: number; route?: Parameters<Router["route"]>[0] } = { router: 0 };
  const deps: DecideDeps = {
    // Under the bar by default: the router decides.
    utterance: async () => ({ audience: "app", audienceConfidence: 0.5, intent: "message", intentConfidence: 1, appParts: 0, model: "test", costUsd: 0, ms: 1, ...opts.classifier }),
    approval: null,
    route: async (input) => {
      seen.router++;
      seen.route = input;
      return { text: opts.says ?? "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: null,
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
  return { d, outcomes: outcomesOf(d, state).map(({ sessionId: _id, unsure: _u, ...o }) => o), seen };
}

/** Right after the app dealt with ASKED itself (`how`). */
const after = (how: Handled, text: string, opts: Partial<DecideState> & Stub = {}) => run(text, { recent: LINES[how], lastSent: appSent(how), ...opts });

const TO_ROWAN = { action: "resend", to: "Rowan", text: ASKED, via: "terminal" };
const resendRowan: Stub["router"] = (s) => [{ name: "resend_to", session: s("Rowan") }];

describe("what a correction is about: your words the app dealt with itself (timeline.ts latestSend)", () => {
  const at = Date.now();
  const you = (text: string, more: Partial<Entry> = {}): Entry => ({ at, who: "you", sessionId: null, folder: null, text, ...more });
  const app = (text: string): Entry => ({ at, who: "app", sessionId: null, folder: null, text });

  test("the latest thing: your words the app checked, answered or started a session for", () => {
    for (const how of ["quick_task", "answered", "start"] as const) {
      const words = you(ASKED, { handled: how });
      assert.equal(latestSend([words, app("Checking.")], 180_000, true), words, how);
    }
  });

  test("not once newer words of yours came, or another session's turn was read out", () => {
    const words = you(ASKED, { handled: "quick_task" });
    assert.equal(latestSend([words, app("Checking."), you("What time is it?")], 180_000, true), undefined);
    const read: Entry = { at, who: "claude", sessionId: S("api").sessionId, folder: "api", text: "Done.", spoken: "api is done." };
    assert.equal(latestSend([words, read], 180_000, true), undefined);
  });

  test("words the app didn't deal with itself (a question it asked about them, a line it said) aren't", () => {
    assert.equal(latestSend([you(ASKED), app("Which session is that for?")], 180_000, true), undefined);
  });

  test("an older send still is what a correction means while it's the latest; 'never mind' never stops a session for words the app dealt with", () => {
    const sent: Entry = { at, who: "you", sessionId: S("api").sessionId, folder: "api", text: "Run the tests." };
    assert.equal(latestSend([sent, app("To api.")], 180_000, true), sent);
    // Not `latest` (what "never mind" takes back): words the app dealt with are no send of yours.
    assert.equal(latestSend([sent, you(ASKED, { handled: "quick_task" })], 180_000, false), sent);
  });

  test("too long ago: nothing", () => {
    const old = { ...you(ASKED, { handled: "quick_task" }), at: at - 200_000 };
    assert.equal(latestSend([old], 180_000, true, at), undefined);
  });
});

describe("the app dealt with them itself (decide.ts handledBy)", () => {
  const S0 = W.sessions[0];
  const of = (actions: Decision["actions"], more: Partial<Decision> = {}): Handled | null =>
    handledBy({ step: "router", text: ASKED, actions, errors: [], classifierCostUsd: 0, llmCostUsd: 0, ...more } as Decision);
  test("a quick check, a session opened, its own answer", () => {
    assert.equal(of([{ type: "quick_task", task: "Did the import finish?", cwd: "/tmp" }]), "quick_task");
    assert.equal(of([{ type: "start", where: { kind: "scratch" } as never, name: "", prompt: "" }]), "start");
    assert.equal(of([{ type: "say", text: "It's 3 pm." }]), "answered");
  });
  test("not when words went to a session, it asked about them, said why not, or couldn't route", () => {
    assert.equal(of([{ type: "send", session: S0, text: ASKED }]), null);
    assert.equal(of([{ type: "ask", session: S0, message: ASKED }]), null);
    assert.equal(of([{ type: "say", text: "Which session is that for?", why: "one_target_unclear" }]), null);
    assert.equal(of([{ type: "say", text: "Want me to send that to api?" }], { question: { kind: "asked", question: { text: ASKED, offered: [], line: "" } } }), null);
    assert.equal(of([{ type: "say", text: "No answer." }], { fallback: { why: "failed", error: "", skipped: false, kept: false } }), null);
    assert.equal(of([]), null);
  });
});

describe("a correction after a quick check sends the words checked, never the correction", () => {
  test("the router's resend_to: the question goes to Rowan as asked", async () => {
    const { d, outcomes, seen } = await after("quick_task", "You should send that to Rowan, don't check it yourself.", { router: resendRowan });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [TO_ROWAN]);
    assert.ok(d.correction);
  });

  test("the router is told what the app dealt with (<you_handled>)", async () => {
    const { seen } = await after("quick_task", "You should send that to Rowan, don't check it yourself.", { router: resendRowan });
    assert.deepEqual(seen.route?.handled, { text: ASKED, how: "quick_task" });
  });

  test("the name misheard: the router's resend_to of the session it heard still sends the question", async () => {
    const { outcomes } = await after("quick_task", "Send that to Rohan, you don't need to look yourself.", { router: resendRowan });
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("'Send that to Rowan instead.': read in code, the question goes there", async () => {
    const { outcomes, seen } = await after("quick_task", "Send that to Rowan instead.");
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("the classifier sure it's a correction that names Rowan: the question goes there", async () => {
    const { outcomes, seen } = await after("quick_task", "No, that was for Rowan.", { classifier: { intent: "redirect", intentConfidence: 0.9 } });
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("the classifier's pick alone, with no name said, isn't where they go: the router decides", async () => {
    const { seen } = await after("quick_task", "No, not you, the one doing it.", {
      classifier: { intent: "redirect", intentConfidence: 0.9, audience: S("api"), audienceConfidence: 0.9 },
      router: resendRowan,
    });
    assert.equal(seen.router, 1);
  });

  test("a yes-or-no the app dealt with goes as said, not turned down as a reply to no one", async () => {
    const { outcomes } = await run("That was for Rowan.", { recent: ["you → app: Yes, go ahead.", "app said: Okay."], lastSent: appSent("answered", "Yes, go ahead."), router: resendRowan });
    assert.deepEqual(outcomes, [{ ...TO_ROWAN, text: "Yes, go ahead." }]);
  });
});

describe("after the app's own answer, or a session it opened", () => {
  test("'That was for Rowan.' after an answer: the question goes there", async () => {
    const { outcomes } = await after("answered", "That was for Rowan.", { router: resendRowan });
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("after start_session: the words go to Rowan; nothing is stopped", async () => {
    const { outcomes } = await after("start", "No, ask Rowan to do that.", { router: resendRowan });
    assert.deepEqual(outcomes, [{ ...TO_ROWAN, text: "Open a session for the nightly import." }]);
  });
});

describe("not a correction: new words, and sends as before", () => {
  test("a request of its own naming Rowan, after a quick check: those words go, not the ones checked", async () => {
    const { outcomes } = await after("quick_task", "Rowan, run the migrations too.", { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].action, "send");
    assert.match((outcomes[0] as { text: string }).text, /run the migrations/i);
  });

  test("'Never mind.' after a quick check isn't a take-back of an older send", async () => {
    const { outcomes } = await after("answered", "Never mind.");
    assert.equal(outcomes[0].action, "wrap_up");
  });

  test("words the app didn't deal with: resend_to still has nothing to send", async () => {
    const { outcomes } = await run("That was for Rowan.", { recent: [`you → app: ${ASKED}`], router: resendRowan });
    assert.deepEqual(outcomes, [{ action: "say", text: "Your last words didn't go to a session, so there's nothing to send on." }]);
  });

  test("a correction after a normal send still resends it, and the router isn't told of anything handled", async () => {
    const lastSent: Sent = { sessionId: S("api").sessionId, folder: "api", text: ASKED };
    const { outcomes, seen } = await run("That was for Rowan.", { recent: [`you → api: ${ASKED}`], lastSent, router: resendRowan });
    assert.deepEqual(outcomes, [TO_ROWAN]);
    assert.equal(seen.route?.handled, undefined);
  });
});

describe("the router's resend_to with the correction passed on too (decide.ts resendOnly)", () => {
  test("pass_on of the same session as well: only the resend goes, never the correction", async () => {
    const { d, outcomes } = await after("quick_task", "Don't check it yourself, send it to Roan.", {
      router: (s) => [
        { name: "resend_to", session: s("Rowan") },
        { name: "pass_on", session: s("Rowan") },
      ],
    });
    assert.deepEqual(outcomes, [TO_ROWAN]);
    assert.equal(d.guards?.[0]?.rule, "resend_only");
  });

  test("ask_session of the same words again: only the resend goes", async () => {
    const { outcomes } = await after("quick_task", "No, ask Rowan instead.", {
      router: (s) => [
        { name: "resend_to", session: s("Rowan") },
        { name: "ask_session", session: s("Rowan"), message: ASKED },
      ],
    });
    assert.deepEqual(outcomes, [TO_ROWAN]);
  });

  test("a request of its own in the same breath still goes", async () => {
    const message = "How long it took?";
    const { outcomes } = await after("quick_task", "That was for Rowan, and also ask it how long it took.", {
      router: (s) => [
        { name: "resend_to", session: s("Rowan") },
        { name: "ask_session", session: s("Rowan"), message },
      ],
    });
    assert.deepEqual(outcomes, [TO_ROWAN, { action: "ask", to: "Rowan", message, via: "terminal" }]);
  });
});
