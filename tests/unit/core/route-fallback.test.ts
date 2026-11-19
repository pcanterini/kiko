// When the router can't answer (src/core/decide.ts routeFailed and keptFor, src/core/fallback.ts),
// 2026-11-12: the Mac's internet dropped for two minutes, and two messages in a row (made up here:
// FIRST and SECOND) each waited 12s for the router (two 8s tries) and were lost with
// "Something went wrong, and I didn't send that." Now the words are kept and routed again later by
// the router itself (app/deliver.ts retryKept); no session is guessed; a name sends them at once.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { backLine, gaveUpLine, keptLine, notDoneLine, sentLine, staleLine } from "../../../src/core/fallback.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

const W = makeWorld([
  { name: "Rowan", folder: "rowan-platform", given: "Rowan", status: "busy", asked: "Nice, the hover effect looks right now, but nothing animates when the list scrolls in." },
  { name: "Kiko project", folder: "kiko", given: "Kiko project", status: "idle" },
  { name: "atlas", status: "idle" },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const ROWAN = () => S("Rowan");

const FIRST =
  "Nice, this one reads much better than the old landing page. So let's keep it. Uh, merge these changes into the main branch. Uh, swap out, like what's up there now, and then you can publish it when you're done. And you can delete the feature branch and its worktree once it's merged.";
const SECOND = "We can polish a couple of things later, but for now I'd say it's good enough to ship.";
const TIMED_OUT = "no answer: 2 tries, 8000ms each";

/** `downAfter`: offline from when the router fails on (its failure is what said so, core/online.ts). */
type Opts = Partial<DecideState> & { router?: (s: (n: string) => Session) => Action[]; fails?: string; offline?: string | null; downAfter?: string };

async function run(text: string, opts: Opts = {}) {
  const seen = { router: 0, classifier: 0, routed: [] as string[] };
  let down = opts.offline ?? null;
  const deps: DecideDeps = {
    // As offline: the classifier failed too (no classify line in the log), so the router decides.
    utterance: async () => {
      seen.classifier++;
      throw new Error("The operation was aborted due to timeout");
    },
    approval: null,
    route: async (input) => {
      seen.router++;
      seen.routed.push(input.text);
      if (opts.fails) {
        down = opts.downAfter ?? down;
        throw new Error(opts.fails);
      }
      return { text: "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    clean: null,
    offline: () => down,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: ["you → Rowan: Nice, the hover effect looks right now, but nothing animates when the list scrolls in.", "app said (about Rowan): The list animations should now play in your browser."],
    waiting: null,
    justSpoke: null,
    lastId: ROWAN().sessionId,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state).map(({ sessionId: _id, ...o }) => o), seen };
}

describe("the router gives no answer: kept, never guessed", () => {
  test("timed out: kept to route again, said once, nothing sent and nothing offered", async () => {
    const { d, outcomes } = await run(FIRST, { fails: TIMED_OUT });
    assert.deepEqual(outcomes, [{ action: "say", text: "I couldn't work out where that goes. Trying again." }]);
    assert.deepEqual(d.keep, { text: FIRST });
    assert.equal(d.question, undefined, "no session guessed or offered");
    assert.deepEqual([d.fallback?.why, d.fallback?.skipped, d.fallback?.kept], ["failed", false, true]);
  });

  test("offline by the time it failed (the failure said so): the offline line", async () => {
    const { outcomes, seen } = await run(FIRST, { fails: TIMED_OUT, downAfter: "router: timeout, relay down" });
    assert.equal(seen.router, 1);
    assert.deepEqual(outcomes, [{ action: "say", text: "I'm offline. I'll send that when I'm back." }]);
  });

  test("known offline: neither the classifier nor the router is asked; kept at once", async () => {
    const { outcomes, seen, d } = await run(SECOND, { offline: "relay: ENOTFOUND" });
    assert.deepEqual([seen.classifier, seen.router], [0, 0]);
    assert.deepEqual(outcomes, [{ action: "say", text: keptLine("offline") }]);
    assert.deepEqual(d.keep, { text: SECOND });
    assert.equal(d.fallback?.skipped, true);
    assert.equal(d.offline, "relay: ENOTFOUND");
  });

  test("named up front, offline: sent at once, no router: a name isn't a guess", async () => {
    const { outcomes, seen } = await run("To, uh, Rowan. It looks good. Let's commit the changes.", { offline: "relay: ENOTFOUND" });
    assert.equal(seen.router, 0);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].action, "send");
    assert.equal((outcomes[0] as { to: string }).to, "Rowan");
  });

  test("a question to the app about a session: said not done, nothing kept", async () => {
    const { d, outcomes } = await run("Is atlas still deploying?", { offline: "relay: ENOTFOUND" });
    assert.deepEqual(outcomes, [{ action: "say", text: notDoneLine("offline") }]);
    assert.equal(d.keep, undefined);
  });

  test("a waiting session still gets its reply offline, as with the classifier off: no router", async () => {
    const { outcomes, seen } = await run(SECOND, { offline: "relay: ENOTFOUND", waiting: { sessionId: ROWAN().sessionId, cwd: ROWAN().cwd } });
    assert.equal(seen.router, 0);
    assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: SECOND, via: "reply" }]);
  });

  test("'Send it.' with nothing kept, offline: said so, never kept itself", async () => {
    const { outcomes, d } = await run("Send it.", { offline: "relay: ENOTFOUND" });
    assert.deepEqual(outcomes, [{ action: "say", text: "There's nothing waiting to send." }]);
    assert.equal(d.keep, undefined);
  });
});

describe("kept words, sent by 'send it' or a name", () => {
  const withKept = (text: string, opts: Opts = {}) => run(text, { kept: { texts: [FIRST] }, ...opts });

  test("'Atlas.', 'Send that to atlas': to the one named, at once, offline or not, read in code", async () => {
    for (const said of ["Send that to atlas.", "Atlas.", "To, uh, atlas.", "send it to the atlas session"]) {
      for (const offline of [null, "relay: ENOTFOUND"]) {
        const { outcomes, d, seen } = await withKept(said, { offline });
        assert.deepEqual([seen.router, seen.classifier], [0, 0], said);
        assert.deepEqual(outcomes, [{ action: "send", to: "atlas", text: FIRST, via: "terminal" }], said);
        assert.equal(d.keptUsed, "sent", said);
      }
    }
  });

  test("several kept: sent together, in the order said", async () => {
    const { outcomes } = await withKept("Rowan.", { kept: { texts: [FIRST, SECOND] } });
    assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: `${FIRST}\n\n${SECOND}`, via: "terminal" }]);
  });

  test("'Send it.': routed again now as if just said, the router picking", async () => {
    for (const said of ["Send it.", "Okay, send it now.", "send them", "Try again."]) {
      const { outcomes, seen, d } = await withKept(said, { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
      assert.deepEqual(seen.routed, [FIRST], said);
      assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: FIRST, via: "terminal", unsure: true }], said);
      assert.equal(d.keptUsed, "redecided", said);
    }
  });

  test("'Send it.' still offline: kept again, said again", async () => {
    const { outcomes, d } = await withKept("Send it.", { offline: "relay: ENOTFOUND" });
    assert.deepEqual(outcomes, [{ action: "say", text: keptLine("offline") }]);
    assert.equal(d.keptUsed, "redecided");
    assert.deepEqual(d.keep, { text: FIRST });
  });

  test("a name that's no session's: said, still kept", async () => {
    const { outcomes, d } = await withKept("Send it to Bob.");
    assert.deepEqual(outcomes, [{ action: "say", text: "I don't see a session called Bob." }]);
    assert.equal(d.keptUsed, undefined);
  });

  test("a session waiting for your reply: 'send it' and a bare name are its reply, not the kept words", async () => {
    const waiting = { sessionId: S("atlas").sessionId, cwd: S("atlas").cwd };
    for (const said of ["Send it.", "Rowan."]) {
      const { d } = await withKept(said, { waiting, offline: "relay: ENOTFOUND" });
      assert.equal(d.keptUsed, undefined, said);
      assert.notEqual(d.step, "kept", said);
    }
    // Named with a "send": the kept words, whatever waits.
    const { outcomes } = await withKept("Send that to Rowan.", { waiting });
    assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: FIRST, via: "terminal" }]);
  });

  test("words of their own aren't a pick: decided as new words, the kept ones left alone", async () => {
    const { d } = await withKept("Rowan, run the tests.", { router: (s) => [{ name: "pass_on", session: s("Rowan") }] });
    assert.equal(d.keptUsed, undefined);
    assert.notEqual(d.step, "kept");
  });
});

describe("the lines", () => {
  test("as the user asked for them", () => {
    assert.equal(keptLine("offline"), "I'm offline. I'll send that when I'm back.");
    assert.equal(gaveUpLine(1), "I couldn't send that. Say send it to try again.");
    assert.equal(sentLine("Rowan"), "Sent to Rowan.");
    assert.equal(staleLine("Nice, this one reads much better…", "Rowan"), 'Still send "Nice, this one reads much better…" to Rowan?');
    assert.equal(backLine(1), "I'm back online. Your last message is still waiting: say send it, or the session's name.");
  });
});
