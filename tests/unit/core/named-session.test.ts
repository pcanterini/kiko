// A session called by its name outranks words that only match another session's title, and the
// router's pick doesn't go silently when the other reads of your words disagree (src/core/decide.ts
// calledByName, disagrees; src/core/sessions.ts calledByName, mentionsSession).
//
// The incident (in made-up words here): "One more thing. I restarted, um, Kiko Dev, … while I'm in
// Ivy Beta … the, um, Kikodev session open and focused …", right after a talk with kiko-dev. The
// classifier picked kiko-dev at 0.74 (its bar 0.75), so the router decided:
// pass_on mintbox, titled "Mintbox overriding Ivy Beta Cmd+E shortcut". And it went unheld: "One"
// up front and "beta" in the title counted as naming mintbox ("the beta one"), so the send looked sure.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { Router, type Action } from "../../../src/core/router.ts";
import { calledByName, mentionsSession, type Session } from "../../../src/core/sessions.ts";
import { makeWorld, type World } from "../../support/fixtures.ts";

// As the route prompt listed them.
const W = makeWorld([
  {
    name: "kiko-dev",
    folder: "kiko",
    given: "kiko-dev",
    title: "Attach error in a new tab",
    status: "idle",
    activeAgoS: 10,
    asked: "Yeah, let's go with your suggestion.",
    said: "…y when you're back at the Mac? Since the terminal shows the prompt anyway, I suggest yes. 3. Decide whether I should repair the app's end-to-end tests (`pnpm test:app`), which were failing before. 4. Run the live terminal test when you have a minute (the command is in my last message).",
  },
  {
    name: "mintbox",
    title: "Mintbox overriding Ivy Beta Cmd+E shortcut",
    status: "idle",
    activeAgoS: 660,
    asked: "mintbox crashed again ------------------------------------- Crash Report ------------------------------------- Process: mintbox-desktop [12345] Path:…",
    said: "…n System Settings → Privacy & Security → Screen Recording. 3. In Mintbox Dev, open the Library and capture a region that covers its window. That should complete now instead of crashing. Mintbox Dev has its own settings and library, kept apart from the regular app.",
  },
  { name: "lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates in secure checkout", status: "idle", activeAgoS: 900 },
]);
const S = (name: string, world: World = W) => world.byName.get(name)!;

const INCIDENT =
  "One more thing. I restarted, um, Kiko Dev, and the overlay is still there, uh, while I'm in Ivy Beta. It keeps showing, though the Ivy beta window is in front and, um, the Kikodev session sits focused in it. That seems wrong to me.";
const RECENT = [
  "you → app: What's the busy agent in Kiko doing at the moment?",
  "you → kiko-dev: What are you doing at the moment? Give me a short status.",
  "app said: Asking kiko dev.",
  "app said (about kiko-dev): …n agent is running, and it's stopping Kiko's own test sessions from showing in your session list. The rest of today's work is merged and pushed; restart Kiko Dev and rebuild the phone app to pick it up. Should missed-prompt cards stay open until they're answered in the terminal, rather than closing when you're back at the Mac? Claude suggests yes.",
  "you → kiko-dev: Yeah, let's go with your suggestion.",
];

type Stub = {
  /** The classifier's pick (a name, or "app") and how sure; null: the classifier is off. */
  classifier?: { audience: string; confidence: number } | null;
  /** The router's tool calls. */
  router?: (s: (name: string) => Session) => Action[];
  world?: World;
};

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const world = opts.world ?? W;
  const seen = { classifier: 0, router: 0, named: [] as string[][] };
  const deps: DecideDeps = {
    utterance:
      opts.classifier === null
        ? null
        : async (): Promise<UtteranceDecision> => {
            seen.classifier++;
            const c = opts.classifier ?? { audience: "app", confidence: 0.3 };
            return {
              audience: c.audience === "app" ? "app" : S(c.audience, world),
              audienceConfidence: c.confidence,
              intent: "message",
              intentConfidence: 1,
              appParts: 0.13,
              model: "test",
              costUsd: 0,
              ms: 1,
            };
          },
    approval: null,
    route: async (input) => {
      seen.router++;
      seen.named.push((input.named ?? []).map((x) => x.givenName || x.cwd.split("/").pop()!));
      const actions = opts.router?.((name) => S(name, world)) ?? [];
      return { text: "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const { classifier: _c, router: _r, world: _w, ...rest } = opts;
  const state: DecideState = {
    text,
    sessions: world.sessions,
    notes: world.notes,
    recent: RECENT,
    waiting: null,
    justSpoke: null,
    lastId: S("kiko-dev", world)?.sessionId ?? null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...rest,
  };
  const d = await decide(state, deps);
  return { d, seen };
}

/** Each send or ask as [to, why unsure (or "sure")]. */
const sends = (d: Awaited<ReturnType<typeof run>>["d"], world: World = W) =>
  d.actions.flatMap((a) => (a.type === "send" || a.type === "ask" ? [[[...world.byName].find(([, x]) => x.sessionId === a.session.sessionId)?.[0], a.unsure ?? "sure"]] : []));
const pass =
  (name: string) =>
  (s: (n: string) => Session): Action[] => [{ name: "pass_on", session: s(name) }];

describe("the incident: words about Kiko Dev went to mintbox", () => {
  test("as it happened (classifier kiko-dev 0.74, router mintbox): to kiko-dev, the router never asked", async () => {
    const { d, seen } = await run(INCIDENT, { classifier: { audience: "kiko-dev", confidence: 0.74 }, router: pass("mintbox") });
    assert.equal(d.step, "named");
    assert.deepEqual(sends(d), [["kiko-dev", "sure"]]);
    assert.equal(seen.router, 0);
  });
  test("the classifier elsewhere: the router is told kiko-dev was named; its mintbox pick is held, not typed in", async () => {
    const { d, seen } = await run(INCIDENT, { classifier: { audience: "app", confidence: 0.4 }, router: pass("mintbox") });
    assert.equal(d.step, "router");
    assert.deepEqual(seen.named, [["kiko-dev"]]);
    assert.deepEqual(sends(d), [["mintbox", "router pass_on"]]);
  });
  test("without the classifier: the same hint, the same hold", async () => {
    const { d, seen } = await run(INCIDENT, { classifier: null, router: pass("mintbox") });
    assert.deepEqual(seen.named, [["kiko-dev"]]);
    assert.deepEqual(sends(d), [["mintbox", "router pass_on"]]);
  });
  test("the router picking kiko-dev: sure, as named", async () => {
    const { d } = await run(INCIDENT, { classifier: { audience: "app", confidence: 0.4 }, router: pass("kiko-dev") });
    assert.deepEqual(sends(d), [["kiko-dev", "sure"]]);
  });
  test("'One more thing' and 'Ivy Beta' don't name mintbox; 'the Ivy Beta one' does", () => {
    assert.equal(mentionsSession(S("mintbox"), INCIDENT), false);
    assert.equal(mentionsSession(S("mintbox"), "Can the Ivy Beta one look at it?"), true);
    assert.equal(mentionsSession(S("kiko-dev"), INCIDENT), true);
  });
});

describe("a session called by its name outranks a title's words", () => {
  test("'kiko dev', 'Kikodev', 'kiko-dev' anywhere in the words call kiko-dev; a title's words don't call mintbox", () => {
    for (const said of [INCIDENT, "Can kiko dev check the Ivy Beta overlay?", "The Ivy Beta overlay is back. Kikodev, have a look.", "is kiko-dev done with the shortcut fix?"]) {
      assert.deepEqual(
        calledByName(W.sessions, said).map((x) => x.sessionId),
        [S("kiko-dev").sessionId],
        said,
      );
    }
    assert.deepEqual(calledByName(W.sessions, "Mintbox overriding Ivy Beta Cmd+E shortcut is still broken."), []);
  });
  test("named mid-sentence, the classifier agreeing below its bar: there, over the router", async () => {
    const { d, seen } = await run("The overlay still shows over Ivy Beta, can kiko dev look at it?", { classifier: { audience: "kiko-dev", confidence: 0.6 }, router: pass("mintbox") });
    assert.equal(d.step, "named");
    assert.deepEqual(sends(d), [["kiko-dev", "sure"]]);
    assert.equal(seen.router, 0);
  });
  test("the classifier not sure of it (below 0.5): the router decides, told who was named", async () => {
    const { d, seen } = await run("The overlay still shows over Ivy Beta, can kiko dev look at it?", { classifier: { audience: "kiko-dev", confidence: 0.4 }, router: pass("kiko-dev") });
    assert.equal(d.step, "router");
    assert.deepEqual(seen.named, [["kiko-dev"]]);
    assert.deepEqual(sends(d), [["kiko-dev", "sure"]]);
  });
  test("another session waiting for your reply: the router weighs it, not the shortcut", async () => {
    const waiting = { sessionId: S("mintbox").sessionId, cwd: S("mintbox").cwd };
    const { d, seen } = await run("Can kiko dev look at the overlay?", { waiting, classifier: { audience: "kiko-dev", confidence: 0.7 }, router: pass("kiko-dev") });
    assert.equal(seen.router, 1);
    assert.deepEqual(sends(d), [["kiko-dev", "sure"]]);
  });
  test("the router's prompt: <named_in_words> lists it, and the rule says a name beats a title's words", async () => {
    const sent = await prompt(INCIDENT, [S("kiko-dev")]);
    assert.match(sent.prompt, /<dealt_with_last>s1<\/dealt_with_last>\n<named_in_words>s1<\/named_in_words>/);
    assert.match(sent.system, /call by its name \(<named_in_words>[^)]*\) comes before one whose title only shares some words/);
    assert.match(sent.system, /"one more thing" or "also", stay with it/);
    assert.match(sent.system, /Nor is a check asked of a session by name \(<named_in_words>; "Hey Bobby, can you check …"\): it goes to that session with pass_on/);
    const none = await prompt("hello", []);
    assert.doesNotMatch(none.prompt, /named_in_words/);
  });
});

describe("the app's name alone isn't kiko-dev", () => {
  test("'Kiko' calls no session, in the kiko folder or in the app's own (APP_FOLDER)", () => {
    const own = makeWorld([{ name: "kiko-dev", folder: "claude-code-speech", given: "kiko-dev" }, { name: "mintbox" }]);
    for (const world of [W, own]) {
      for (const said of ["I restarted Kiko and the overlay still shows over Ivy Beta.", "Is this a bug for Kiko?", "Can you tell Kiko the overlay is back?", "The Kiko session list looks wrong."]) {
        assert.deepEqual(calledByName(world.sessions, said), [], said);
      }
    }
    assert.deepEqual(
      calledByName(own.sessions, "Kiko dev, run the tests.").map((x) => x.sessionId),
      [own.sessions[0].sessionId],
    );
  });
  test("'I restarted Kiko …' with the classifier on kiko-dev below its bar: no shortcut, the router decides", async () => {
    const { d, seen } = await run("I restarted Kiko and the overlay still shows over Ivy Beta.", { classifier: { audience: "kiko-dev", confidence: 0.6 }, router: pass("kiko-dev") });
    assert.equal(d.step, "router");
    assert.deepEqual(seen.named, [[]]);
    assert.equal(seen.router, 1);
  });
});

describe("the classifier and the router disagree: said and held, never silent", () => {
  const waiting = () => ({ sessionId: S("mintbox").sessionId, cwd: S("mintbox").cwd });
  test("at its bar, under the bar raised for a waiting session: the router's reply to the waiting one is held", async () => {
    const { d } = await run("Yes, and check the overlay too.", { waiting: waiting(), classifier: { audience: "kiko-dev", confidence: 0.8 }, router: pass("mintbox") });
    assert.equal(d.step, "router");
    assert.deepEqual(sends(d), [["mintbox", "router pass_on; classifier: kiko-dev"]]);
  });
  test("below its bar, a reply to the waiting one goes at once, as before", async () => {
    const { d } = await run("Yes, and check the overlay too.", { waiting: waiting(), classifier: { audience: "kiko-dev", confidence: 0.6 }, router: pass("mintbox") });
    assert.deepEqual(sends(d), [["mintbox", "sure"]]);
  });
  test("the router's pick named only by its title's words, the classifier leaning elsewhere: held", async () => {
    // "shipping rates": two words of Lacy's title, "Shipping rates in secure checkout", so the send looked sure.
    const { d } = await run("The shipping rates check fails again, what's going on?", { classifier: { audience: "kiko-dev", confidence: 0.6 }, router: pass("lacy") });
    assert.deepEqual(sends(d), [["lacy", "router pass_on; classifier: kiko-dev"]]);
    const unsure = await run("The shipping rates check fails again, what's going on?", { classifier: { audience: "kiko-dev", confidence: 0.4 }, router: pass("lacy") });
    assert.deepEqual(sends(unsure.d), [["lacy", "sure"]]);
  });
  test("the words name the router's pick: sure, whatever the classifier says", async () => {
    const { d } = await run("Can mintbox look at the Ivy Beta shortcut again?", { classifier: { audience: "kiko-dev", confidence: 0.6 }, router: pass("mintbox") });
    assert.deepEqual(sends(d), [["mintbox", "sure"]]);
  });
  test("the classifier agreeing: as before", async () => {
    const { d } = await run("Yes, and check the overlay too.", { waiting: waiting(), classifier: { audience: "mintbox", confidence: 0.8 }, router: pass("mintbox") });
    assert.equal(d.step, "classifier");
    assert.deepEqual(sends(d), [["mintbox", "sure"]]);
  });
});

// The router's own prompt, without the network (as router-tools.test.ts).
let captured: Array<{ system: string; prompt: string }> = [];
const realFetch = globalThis.fetch;
before(() => {
  config.llm = "test/no-network";
  process.env.OPENROUTER_API_KEY = "unit-test-no-network";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    captured.push({ system: body.messages[0].content, prompt: body.messages[1].content });
    const completion = {
      choices: [{ message: { content: "", tool_calls: [{ function: { name: "say", arguments: JSON.stringify({ text: "ok" }) } }] } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 },
    };
    return new Response(JSON.stringify(completion), { status: 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function prompt(text: string, named: Session[]) {
  captured = [];
  await new Router().route({ sessions: W.sessions, notes: W.notes, waitingId: null, justSpoke: null, lastId: S("kiko-dev").sessionId, recent: RECENT, text, voiceCan: "messages", named }, () => {});
  assert.equal(captured.length, 1);
  return captured[0];
}
