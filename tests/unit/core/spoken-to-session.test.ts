// Words spoken to a session up front ("Hey Bobby, …") go to it, and the router's own work (a quick
// check, its own answer) doesn't win over a session your words or the classifier picked
// (src/core/sessions.ts addressedByName, calledByName; src/core/decide.ts "named" step, sessionInstead).
//
// The incident: "Hey bobby, can you also, uh, have an agent look at …" (made up here) 10 s after
// kiko-dev spoke. The classifier picked Bobby at 0.79: over its bar (0.75),
// under the bar raised for kiko-dev, which had just spoken (0.9). "Hey Bobby" named nobody (a one-word
// name needed "for Bobby" or "the Bobby session"), so the router decided, ran Kiko's own quick check
// in ~, and the user answered its permission prompts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import type { Action } from "../../../src/core/router.ts";
import { addressedByName, calledByName, type Session } from "../../../src/core/sessions.ts";
import { makeWorld, type World } from "../../support/fixtures.ts";

// As the route prompt listed them.
const W = makeWorld([
  {
    name: "kiko-dev",
    folder: "kiko",
    given: "kiko-dev",
    title: "Attach error in a new tab",
    status: "idle",
    activeAgoS: 43,
    asked: "Yeah let's do it.",
    said: "…The shortcut is in the list, the menu and the full screen now. I'll let you know once it's merged.",
  },
  {
    name: "mintbox",
    title: "Mintbox export shortcut clash",
    status: "idle",
    activeAgoS: 780,
    asked: "Looks good. Go ahead and merge it, then delete the feature branch.",
    said: "Main is pushed, with the crash fix in it (`4e5f6a7`).",
  },
  {
    name: "Bobby",
    folder: "2026-01-20-internal",
    given: "Bobby",
    status: "idle",
    activeAgoS: 1020,
    asked: "Hey, Bobby, can you check which deploy keys the build box still accepts? I've lost track of which are set up. Could you list them?",
    said: "… it still works: `ssh build-box` logs straight in.",
  },
]);
const S = (name: string, world: World = W) => world.byName.get(name)!;

const INCIDENT =
  "Hey bobby, can you also, uh, have an agent look at what in the shared drive could be archived uh, from the projects that ended. Just check the dates. Um, and then any branches that are old or uh, preview builds and stuff like that. Find what's safe to archive. Uh, and I only want a list here. Please don't move or delete anything yet. Only the things that are clearly safe.";
const RECENT = [
  "you → kiko-dev: Hey, Kikodev, how about a key that mutes the reader for a minute, say holding M?",
  "app said: To kiko dev.",
  "app said (about kiko-dev): In kiko-dev, Claude says holding m for about a second could mute the reader for a minute. Want it?",
  "you → kiko-dev: Yeah let's do it.",
  "app said (about kiko-dev): In kiko-dev, Claude has started the change. It'll tell you when it's merged.",
];
const JUST_SPOKE = () => ({ id: S("kiko-dev").sessionId, secondsAgo: 10 });

type Stub = {
  /** The classifier's pick (a name, or "app") and how sure; null: the classifier is off. */
  classifier?: { audience: string; confidence: number } | null;
  /** The router's tool calls, and what it says. */
  router?: (s: (name: string) => Session) => Action[];
  said?: string;
  world?: World;
};

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const world = opts.world ?? W;
  const seen = { classifier: 0, router: 0 };
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
              intentConfidence: 0.96,
              appParts: 0.18,
              model: "test",
              costUsd: 0,
              ms: 1,
            };
          },
    approval: null,
    route: async () => {
      seen.router++;
      const actions = opts.router?.((name) => S(name, world)) ?? [];
      return { text: opts.said ?? "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const { classifier: _c, router: _r, said: _s, world: _w, ...rest } = opts;
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
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...rest,
  };
  const d = await decide(state, deps);
  return { d, seen };
}

/** Each send or ask as [to, why unsure (or "sure")]; a quick task as ["quick_task"]; a say as ["say", text]. */
const acts = (d: Awaited<ReturnType<typeof run>>["d"], world: World = W) =>
  d.actions.map((a) =>
    a.type === "send" || a.type === "ask" ? [[...world.byName].find(([, x]) => x.sessionId === a.session.sessionId)?.[0], a.unsure ?? "sure"] : a.type === "say" ? ["say", a.text] : [a.type],
  );
const quick = (): Action[] => [{ name: "quick_task", task: "List what could safely be archived: old branches, preview builds, ended projects. Read-only.", cwd: "/Users/someone" }];
const pass =
  (name: string) =>
  (s: (n: string) => Session): Action[] => [{ name: "pass_on", session: s(name) }];
const names = (sessions: Session[]) => sessions.map((x) => x.givenName || x.cwd.split("/").pop());

describe("the incident: 'Hey Bobby, can you also check …' ran Kiko's own check", () => {
  test("as it happened (classifier Bobby 0.79, kiko-dev just spoke, router quick_task): to Bobby, the router never asked", async () => {
    const { d, seen } = await run(INCIDENT, { justSpoke: JUST_SPOKE(), classifier: { audience: "bobby", confidence: 0.79 }, router: quick });
    assert.equal(d.step, "named");
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
    assert.equal(seen.router, 0);
  });
  test("its words go as said, less 'Hey bobby,' (the direction to it: direction.ts)", async () => {
    const { d } = await run(INCIDENT, { justSpoke: JUST_SPOKE(), classifier: { audience: "bobby", confidence: 0.79 } });
    const send = d.actions[0];
    assert.equal(send.type, "send");
    assert.match(send.type === "send" ? send.text : "", /^Can you also, uh, have an agent look/);
  });
  test("'Hey bobby' calls Bobby by name", () => {
    assert.deepEqual(names(addressedByName(W.sessions, INCIDENT)), ["Bobby"]);
    assert.deepEqual(names(calledByName(W.sessions, INCIDENT)), ["Bobby"]);
  });
});

describe("spoken to up front: a greeting, or the name and a pause", () => {
  test("'Hey/Hi/Yo Bobby', 'OK Bobby,', 'Bobby,', 'Uh, Bobby:' speak to Bobby", () => {
    for (const said of [
      "Hey Bobby, can you check the disk?",
      "Hey Bobby can you check the disk?",
      "Hi bobby, what's left?",
      "Yo Bobby, list the containers.",
      "Hello Bobby. Are the VMs old?",
      "OK Bobby, check the disk.",
      "Okay, Bobby, check the disk.",
      "Hey, Bobby, check the disk.",
      "Bobby, can you check the disk?",
      "Uh, Bobby: check the disk.",
      "Bobby - can you check the disk?",
    ]) {
      assert.deepEqual(names(addressedByName(W.sessions, said)), ["Bobby"], said);
      assert.deepEqual(names(calledByName(W.sessions, said)), ["Bobby"], said);
    }
  });
  test("not mid-sentence, not without the pause after 'okay', 'Hey,' or nothing, not its possessive", () => {
    for (const said of [
      "Can you ask about it, Bobby?",
      "I told Bobby, yes.",
      "Okay Bobby looks done.",
      "Hey, Bobby looks done.",
      "Bobby looks done, right?",
      "Hey Bobby's list is long.",
      "So Bobby, check the disk.",
    ]) {
      assert.deepEqual(addressedByName(W.sessions, said), [], said);
    }
  });
  test("a name multi-word or run together: 'Hey kiko dev, …', 'Hey Kikodev, …'; the longest name wins", () => {
    for (const said of ["Hey kiko dev, run the tests.", "Hey Kikodev, run the tests.", "Kiko-dev, run the tests."]) {
      assert.deepEqual(names(addressedByName(W.sessions, said)), ["kiko-dev"], said);
    }
    const two = makeWorld([
      { name: "api", given: "api" },
      { name: "api-gateway", given: "api-gateway" },
    ]);
    assert.deepEqual(names(addressedByName(two.sessions, "Hey api gateway, restart it.")), ["api-gateway"]);
    assert.deepEqual(names(addressedByName(two.sessions, "Api-gateway is down again, can you look?")), []);
  });
  test("'Bobby, …' with a comma: to Bobby, with no model at all", async () => {
    const { d, seen } = await run("Bobby, can you list the old Docker containers?", { justSpoke: JUST_SPOKE(), classifier: { audience: "kiko-dev", confidence: 0.6 }, router: quick });
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
    assert.equal(seen.router, 0);
  });
  test("'Hey Bobby, …' with the classifier on Bobby under its bar, another session waiting for your reply: to Bobby", async () => {
    const waiting = { sessionId: S("kiko-dev").sessionId, cwd: S("kiko-dev").cwd };
    const { d, seen } = await run("Hey Bobby, how big is the Docker folder?", { waiting, classifier: { audience: "bobby", confidence: 0.6 }, router: pass("kiko-dev") });
    assert.equal(d.step, "named");
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
    assert.equal(seen.router, 0);
  });
});

describe("the app's own name isn't a session's", () => {
  test("'Hey Kiko, what time is it': the app answers, never kiko-dev", async () => {
    const { d } = await run("Hey Kiko, what time is it?", { justSpoke: JUST_SPOKE(), classifier: { audience: "kiko-dev", confidence: 0.6 }, said: "It's 7:08 pm." });
    assert.deepEqual(acts(d), [["say", "It's 7:08 pm."]]);
    assert.deepEqual(addressedByName(W.sessions, "Hey Kiko, what time is it?"), []);
    assert.deepEqual(calledByName(W.sessions, "Hey Kiko, what time is it?"), []);
    assert.deepEqual(addressedByName(W.sessions, "Kiko, what time is it?"), []);
  });
  test("'Hey kiko dev, …' is kiko-dev, not the app's name and 'dev'", async () => {
    const { d } = await run("Hey kiko dev, run the tests again.", {
      justSpoke: { id: S("mintbox").sessionId, secondsAgo: 5 },
      classifier: { audience: "kiko-dev", confidence: 0.6 },
      router: pass("mintbox"),
    });
    assert.equal(d.toApp, undefined);
    assert.deepEqual(acts(d), [["kiko-dev", "sure"]]);
  });
  test("a session in the app's own folder, called by the folder: not spoken to by 'Hey Kiko'", () => {
    const own = makeWorld([{ name: "kiko" }, { name: "mintbox" }]);
    assert.deepEqual(addressedByName(own.sessions, "Hey Kiko, check the logs."), []);
  });
});

describe("a session named after a common word", () => {
  const api = makeWorld([
    { name: "api", given: "api", status: "idle" },
    { name: "web", given: "web", status: "idle" },
  ]);
  test("'The api is slow, can you …' names nothing; 'Hey api, …' and 'api, …' do", () => {
    for (const said of ["The api is slow, can you check why?", "Check if the api is slow.", "Okay api is slow now, can you check?", "Hey, api is slow."]) {
      assert.deepEqual(addressedByName(api.sessions, said), [], said);
      assert.deepEqual(calledByName(api.sessions, said), [], said);
    }
    assert.deepEqual(names(addressedByName(api.sessions, "Hey api, why are you slow?")), ["api"]);
    assert.deepEqual(names(addressedByName(api.sessions, "API, why are you slow?")), ["api"]);
  });
  test("'The api is slow, can you …' with the classifier on web under its bar: the router decides, its quick check runs", async () => {
    const { d, seen } = await run("The api is slow, can you check why?", { world: api, classifier: { audience: "web", confidence: 0.6 }, router: quick });
    assert.equal(seen.router, 1);
    assert.deepEqual(acts(d, api), [["quick_task"]]);
  });
});

describe("the router keeps your words for the app, the other reads say a session", () => {
  test("spoken to Bobby, the classifier elsewhere: the router's quick check becomes a send to Bobby", async () => {
    const { d, seen } = await run(INCIDENT, { classifier: { audience: "app", confidence: 0.6 }, router: quick });
    assert.equal(seen.router, 1);
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
    assert.deepEqual(
      d.guards?.map((g) => [g.rule, g.by]),
      [["session_over_app", "router quick_task"]],
    );
  });
  test("spoken to Bobby, the classifier picking kiko-dev: to Bobby all the same (words naming a send's session make it sure: disagrees)", async () => {
    const { d } = await run(INCIDENT, { classifier: { audience: "kiko-dev", confidence: 0.6 }, router: quick });
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
  });
  test("spoken to Bobby, the router answering itself: Bobby answers", async () => {
    const { d } = await run("Hey Bobby, what time is it there?", { classifier: { audience: "app", confidence: 0.8 }, said: "It's 7:08 pm." });
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
  });
  test("the classifier on Bobby over its bar (lost to the raised one), nothing named: the quick check is a held send to Bobby", async () => {
    const said = "Can you also check what in the shared drive could be archived? Old branches, preview builds.";
    const { d, seen } = await run(said, { justSpoke: JUST_SPOKE(), classifier: { audience: "bobby", confidence: 0.79 }, router: quick });
    assert.equal(seen.router, 1);
    assert.deepEqual(acts(d), [["bobby", "router quick_task; classifier: Bobby"]]);
  });
  test("Bobby called by name mid-sentence, the classifier elsewhere: the quick check is a held send to Bobby", async () => {
    const said = "Check what could be archived, the way the Bobby session did with the deploy keys.";
    const { d } = await run(said, { justSpoke: JUST_SPOKE(), classifier: { audience: "app", confidence: 0.7 }, router: quick });
    assert.deepEqual(acts(d), [["bobby", "router quick_task; named: Bobby"]]);
  });
  test("the classifier on Bobby below its bar, nothing named: the quick check runs, as before", async () => {
    const said = "Can you check what in the shared drive could be archived?";
    const { d } = await run(said, { justSpoke: JUST_SPOKE(), classifier: { audience: "bobby", confidence: 0.6 }, router: quick });
    assert.deepEqual(acts(d), [["quick_task"]]);
  });
  test("a question about a session, by name: the router's answer stands", async () => {
    const { d } = await run("Is the Bobby session done yet?", { classifier: { audience: "app", confidence: 0.6 }, said: "Bobby is idle." });
    assert.deepEqual(acts(d), [["say", "Bobby is idle."]]);
  });
  test("the router also sending the words somewhere: its calls stand (that send held, as unnamed)", async () => {
    const both = (s: (n: string) => Session): Action[] => [...pass("kiko-dev")(s), ...quick()];
    const { d } = await run(INCIDENT, { classifier: { audience: "app", confidence: 0.6 }, router: both });
    assert.deepEqual(acts(d), [["kiko-dev", "router pass_on"], ["quick_task"]]);
  });
  test("below 'everything', the check refused: spoken to Bobby, it goes to Bobby instead", async () => {
    const { d } = await run(INCIDENT, { voiceCan: "messages", classifier: { audience: "app", confidence: 0.6 }, router: quick });
    assert.deepEqual(acts(d), [["bobby", "sure"]]);
  });
});
