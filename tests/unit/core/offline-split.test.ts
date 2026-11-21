// One service down isn't "offline" (src/core/online.ts, core/services.ts, decide.ts), 2026-11-20, from
// the owner's log: OpenRouter, which runs only the optional classifier there, timed out (ETIMEDOUT);
// the app took the whole Mac as offline, said so, kept the words, and never asked the router, which
// runs on the Anthropic API and was answering. Its retries waited on the same sign for 80s. Now the
// classifier's service down only skips the classifier, the router is skipped only when its own service
// (or the network) is down, and a service that's the only thing down is said by its name. And words kept
// are routed again with the conversation as it was when they were said (kept.ts asThen): 87s later they
// went to the session that had talked since, not the one they answered. Names and words are made up.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState, type Offline } from "../../../src/core/decide.ts";
import { keptLine, notDoneLine, withoutClassifierLine } from "../../../src/core/fallback.ts";
import { asThen, type KeptContext } from "../../../src/core/kept.ts";
import { Online, serviceName, type Service } from "../../../src/core/online.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { llmService, openrouterService } from "../../../src/core/services.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "Lumen", folder: "lumen-web", given: "Lumen", status: "idle", asked: "Compare the two storage options for the photo uploads.", said: "Option B is cheaper, but its reads are slower." },
  { name: "Harbor", folder: "harbor", given: "Harbor", status: "idle", asked: "Tidy up the build script.", said: "The build script is tidied up." },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const WORDS = "Which one did you say was cheaper again, and by how much?";

// As Node's fetch reports a connect that timed out.
const timedOut = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" }) });

/** The app's two checks (app/deliver.ts), from an Online: the router's service and the classifier's. */
function checks(o: Online, router: Service, classifier: Service): Pick<DecideDeps, "offline" | "classifierOffline"> {
  return {
    offline: (): Offline | null => {
      const d = o.down(router);
      return d ? { detail: d.detail, ...(d.service ? { service: serviceName(d.service) } : {}) } : null;
    },
    classifierOffline: () => o.down(classifier)?.detail ?? null,
  };
}

type Opts = Partial<DecideState> & {
  classifier?: () => Promise<never>;
  router?: (input: Parameters<DecideDeps["route"]>[0]) => Action[];
  deps?: Partial<DecideDeps>;
};

async function run(text: string, opts: Opts = {}) {
  const seen = { classifier: 0, router: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      seen.classifier++;
      return (opts.classifier ?? (() => Promise.reject(new Error("fetch failed (ETIMEDOUT)"))))();
    },
    approval: null,
    route: async (input) => {
      seen.router++;
      return { text: "", actions: opts.router?.(input) ?? [{ name: "pass_on", session: S("Lumen") }], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: null,
    ...opts.deps,
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
    ...opts,
  };
  const d = await decide(state, deps);
  const outcomes = outcomesOf(d, state).map(({ sessionId: _id, ...o }) => o);
  // Where your words went: each send's session, or what was said.
  const went = outcomes.map((o) => (o.action === "send" ? `send ${o.to}` : o.action === "say" ? `say ${o.text}` : o.action));
  return { d, outcomes, went, seen };
}

function make() {
  const clock = new FakeClock();
  clock.t = 1_000_000;
  const o = new Online(clock);
  o.relayConnected();
  return o;
}

describe("the classifier's service down: routed by the router alone", () => {
  test("the classifier times out, the router answers: sent, nothing kept, nothing said about offline", async () => {
    const o = make();
    const { d, went, seen } = await run(WORDS, {
      classifier: () => {
        // As core/model-route.ts notes it: OpenRouter's connect timed out.
        o.callFailed("openrouter", timedOut());
        return Promise.reject(new Error("fetch failed (ETIMEDOUT)"));
      },
      deps: checks(o, "anthropic", "openrouter"),
    });
    assert.deepEqual(seen, { classifier: 1, router: 1 });
    assert.deepEqual(went, ["send Lumen"]);
    assert.equal(d.fallback, undefined);
    assert.equal(d.keep, undefined);
    assert.equal(d.errors[0]?.where, "classify_utterance");
  });

  test("the classifier's service known down: not asked, the router decides at once", async () => {
    const o = make();
    o.callFailed("openrouter", timedOut());
    const { d, went, seen } = await run(WORDS, { deps: checks(o, "anthropic", "openrouter") });
    assert.deepEqual(seen, { classifier: 0, router: 1 });
    assert.deepEqual(went, ["send Lumen"]);
    assert.match(d.offline ?? "", /openrouter: ETIMEDOUT/, "the log says why the classifier was skipped");
  });

  test("its line names the service, and that it routes anyway", () => {
    assert.equal(withoutClassifierLine("OpenRouter"), "OpenRouter isn't answering; routing without it.");
  });
});

describe("the router's own service down: kept, the service named", () => {
  test("Anthropic timing out (the router on Haiku): kept, 'Can't reach Anthropic: …'", async () => {
    const o = make();
    o.callFailed("anthropic", timedOut());
    const { d, outcomes, seen } = await run(WORDS, { deps: checks(o, "anthropic", "openrouter") });
    assert.equal(seen.router, 0, "not asked: its service is down");
    assert.deepEqual(outcomes, [{ action: "say", text: "Can't reach Anthropic: I'll send that when it's back." }]);
    assert.deepEqual(d.keep, { text: WORDS });
    assert.deepEqual([d.fallback?.why, d.fallback?.skipped, d.fallback?.service], ["offline", true, "Anthropic"]);
  });

  test("OpenRouter only (no Anthropic key, the router on OpenRouter): OpenRouter down is offline for it", async () => {
    const o = make();
    o.callFailed("openrouter", timedOut());
    const router = llmService("openai/some-model", "key");
    assert.equal(router, "openrouter");
    const { d, outcomes, seen } = await run(WORDS, { deps: checks(o, router, openrouterService("key")) });
    assert.deepEqual(seen, { classifier: 0, router: 0 });
    assert.deepEqual(outcomes, [{ action: "say", text: "Can't reach OpenRouter: I'll send that when it's back." }]);
    assert.equal(d.fallback?.kept, true);
  });

  test("on the account's plan (Kiko's proxy): the proxy down is offline for the router and the classifier both", async () => {
    const o = make();
    o.callFailed("kiko", timedOut());
    const router = llmService("openai/some-model", "account");
    assert.equal(router, "kiko");
    assert.equal(openrouterService("account"), "kiko");
    const { outcomes, seen } = await run(WORDS, { deps: checks(o, router, "kiko") });
    assert.deepEqual(seen, { classifier: 0, router: 0 });
    assert.deepEqual(outcomes, [{ action: "say", text: "Can't reach Kiko's AI: I'll send that when it's back." }]);
  });

  test("the network itself down (names don't resolve): 'I'm offline', as before", async () => {
    const o = make();
    o.relayError(new Error("getaddrinfo ENOTFOUND relay.example.test"));
    const { outcomes, seen } = await run(WORDS, { deps: checks(o, "anthropic", "openrouter") });
    assert.deepEqual(seen, { classifier: 0, router: 0 });
    assert.deepEqual(outcomes, [{ action: "say", text: "I'm offline. I'll send that when I'm back." }]);
  });

  test("the router fails and its service is known down by then: named too", async () => {
    const o = make();
    const { outcomes } = await run(WORDS, {
      classifier: () => Promise.reject(new Error("Jev 503")),
      deps: {
        ...checks(o, "anthropic", "openrouter"),
        route: async () => {
          o.callFailed("anthropic", timedOut());
          throw new Error("Connection error.");
        },
      },
    });
    assert.deepEqual(outcomes, [{ action: "say", text: "Can't reach Anthropic: I'll send that when it's back." }]);
  });

  test("the lines", () => {
    assert.equal(keptLine("offline", "Anthropic"), "Can't reach Anthropic: I'll send that when it's back.");
    assert.equal(notDoneLine("offline", "Anthropic"), "Can't reach Anthropic, so I couldn't do that. Ask again once it's back.");
    assert.equal(keptLine("offline"), "I'm offline. I'll send that when I'm back.");
    assert.equal(keptLine("failed", "Anthropic"), "I couldn't work out where that goes. Trying again.");
  });
});

describe("the kept words' retry", () => {
  test("routed by the router with the classifier's service still down: no wait on the classifier", async () => {
    const o = make();
    o.callFailed("openrouter", timedOut());
    // The retry's own decide (app/deliver.ts): no classifier at all for words kept.
    const { went, seen } = await run(WORDS, { deps: { ...checks(o, "anthropic", "openrouter"), utterance: null } });
    assert.deepEqual(seen, { classifier: 0, router: 1 });
    assert.deepEqual(went, ["send Lumen"]);
  });

  test("the classifier's service back first, the router's still down: no 'back' for the router", () => {
    const o = make();
    o.callFailed("anthropic", timedOut());
    o.callFailed("openrouter", timedOut());
    o.ok("openrouter");
    assert.ok(o.down("anthropic"), "the retry still waits");
    o.ok("anthropic");
    assert.equal(o.down("anthropic"), null);
  });

  test("routed with the conversation as it was when said: another session talking since doesn't take them", async () => {
    const lumen = S("Lumen");
    const harbor = S("Harbor");
    // When said: Lumen had just been read out; Harbor's last turn was about its build script.
    const then: KeptContext = {
      sessions: W.sessions,
      notes: W.notes,
      recent: ["you → Lumen: Compare the two storage options for the photo uploads.", "app said (about Lumen): Option B is cheaper, but its reads are slower."],
      waitingId: null,
      justSpoke: { id: lumen.sessionId, secondsAgo: 20 },
      lastId: lumen.sessionId,
      heardFrom: lumen.sessionId,
    };
    // Meanwhile Harbor talked about the very question, and waits for a reply now.
    const nowSessions: Session[] = W.sessions.map((s) => (s.sessionId === harbor.sessionId ? { ...s, status: "idle" } : s));
    const asWas = asThen(then, nowSessions, harbor.sessionId);
    assert.equal(asWas.waitingId, null, "Harbor waiting now isn't what the words answer");
    assert.deepEqual(asWas.justSpoke, then.justSpoke);
    assert.equal(asWas.lastId, lumen.sessionId);
    assert.deepEqual(asWas.recent, then.recent, "nothing said since");
    assert.deepEqual(asWas.notes.get(harbor.sessionId), W.notes.get(harbor.sessionId), "Harbor's notes as they were");
    // A router that goes by the context it's given: the session waiting, else the one that just spoke, else the last.
    const byContext = (input: Parameters<DecideDeps["route"]>[0]): Action[] => {
      const id = input.waitingId ?? input.justSpoke?.id ?? input.lastId;
      const to = input.sessions.find((s) => s.sessionId === id)!;
      return [{ name: "pass_on", session: to }];
    };
    const { went } = await run(WORDS, {
      sessions: asWas.sessions,
      notes: asWas.notes,
      recent: asWas.recent,
      waiting: null,
      justSpoke: asWas.justSpoke,
      lastId: asWas.lastId,
      router: byContext,
      deps: { utterance: null },
    });
    assert.deepEqual(went, ["send Lumen"]);
    // As it would have gone with today's context instead: Harbor. (What the fix avoids.)
    const { went: now } = await run(WORDS, {
      waiting: { sessionId: harbor.sessionId, cwd: harbor.cwd },
      lastId: harbor.sessionId,
      router: byContext,
      deps: { utterance: null },
    });
    assert.deepEqual(now, ["send Harbor"]);
  });

  test("a session gone since is left out; one started since is listed, with no notes from before", () => {
    const lumen = S("Lumen");
    const started = { ...S("Harbor"), sessionId: "id-new-one" };
    const then: KeptContext = { sessions: W.sessions, notes: W.notes, recent: [], waitingId: lumen.sessionId, justSpoke: null, lastId: null, heardFrom: null };
    const asWas = asThen(then, [lumen, started], null);
    assert.deepEqual(
      asWas.sessions.map((s) => s.sessionId),
      [lumen.sessionId, "id-new-one"],
    );
    assert.deepEqual(asWas.notes.get("id-new-one"), { asked: "", said: "" });
    assert.equal(asWas.waitingId, null, "Lumen isn't waiting now");
    assert.deepEqual(asWas.justSpoke, { id: lumen.sessionId, secondsAgo: 0 }, "the one waiting then, as the one that had just spoken");
    assert.equal(asThen(then, [lumen], lumen.sessionId).waitingId, lumen.sessionId, "still waiting: still the one");
  });
});
