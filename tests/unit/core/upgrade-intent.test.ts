// "Upgrade to Pro" to the app (src/core/routing-rules.ts asksUpgrade, decided in code by decide.ts):
// Kiko Pro's checkout, only while Pro is on sale (DecideState.proOnSale); a bare "upgrade" only with
// nothing waiting for a reply, nothing just spoken and not in a session's screen. Words for a session
// that mention upgrading stay that session's. No model is asked for the intent.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { asksUpgrade, upgradeInterval } from "../../../src/core/routing-rules.ts";
import { makeSession } from "../../support/fixtures.ts";

const pixie = makeSession({ name: "pixie" });

async function run(text: string, o: Partial<DecideState> = {}) {
  let routed = 0;
  const deps: DecideDeps = {
    utterance: null,
    approval: null,
    trim: null,
    route: async () => (routed++, { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
  };
  const d = await decide(
    {
      text,
      sessions: [pixie],
      notes: new Map(),
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan: "messages",
      classifierMinConfidence: 0.75,
      proOnSale: true,
      ...o,
    },
    deps,
  );
  return { d, routed };
}

describe("the words", () => {
  test("upgrade to Pro, buy Kiko Pro, and the like; a bare upgrade only when allowed", () => {
    for (const said of [
      "Upgrade to Pro.",
      "upgrade to kiko pro",
      "Buy Kiko Pro.",
      "Okay, upgrade to pro please",
      "Get Kiko Pro",
      "Can you upgrade me to Pro?",
      "Subscribe to Kiko Pro.",
      "Upgrade to Pro yearly.",
    ])
      assert.ok(asksUpgrade(said, { bare: false }), said);
    for (const said of ["Upgrade.", "upgrade", "I'd like to upgrade.", "Upgrade now."]) {
      assert.ok(asksUpgrade(said, { bare: true }), said);
      assert.ok(!asksUpgrade(said, { bare: false }), said);
    }
    for (const said of ["Upgrade the dependencies.", "tell pixie to upgrade to pro", "upgrade node to 24", "should I upgrade?", "get the pro version of the package"])
      assert.ok(!asksUpgrade(said, { bare: true }), said);
  });

  test("monthly unless the words say yearly", () => {
    assert.equal(upgradeInterval("Upgrade to Pro."), "month");
    for (const said of ["Upgrade to Pro yearly.", "buy kiko pro for a year", "upgrade to pro on the annual plan"]) assert.equal(upgradeInterval(said), "year", said);
  });
});

describe("decided in code", () => {
  test("while Pro is on sale: the checkout, monthly or yearly; no router", async () => {
    const r = await run("Upgrade to Kiko Pro.");
    assert.deepEqual([r.d.step, r.d.actions, r.routed], ["upgrade", [{ type: "upgrade", interval: "month" }], 0]);
    assert.deepEqual((await run("Buy Kiko Pro for a year.")).d.actions, [{ type: "upgrade", interval: "year" }]);
    assert.deepEqual((await run("Upgrade.")).d.actions, [{ type: "upgrade", interval: "month" }]);
  });

  test("not on sale (PRO_ON_SALE off): never the checkout, the words routed as any", async () => {
    for (const said of ["Upgrade to Kiko Pro.", "Upgrade."]) {
      const r = await run(said, { proOnSale: false });
      assert.notEqual(r.d.step, "upgrade");
      assert.ok(!r.d.actions.some((a) => a.type === "upgrade"), said);
    }
  });

  test("a bare 'upgrade' with a session waiting for a reply, just spoken, or in its screen: that session's", async () => {
    const waiting = { sessionId: pixie.sessionId, cwd: pixie.cwd };
    for (const o of [{ waiting }, { justSpoke: { id: pixie.sessionId, secondsAgo: 5 } }, { to: pixie }] as Partial<DecideState>[]) {
      const r = await run("Upgrade.", o);
      assert.ok(!r.d.actions.some((a) => a.type === "upgrade"), JSON.stringify(Object.keys(o)));
    }
    // "Upgrade to Pro" is the app's even then.
    assert.equal((await run("Upgrade to Kiko Pro.", { waiting })).d.step, "upgrade");
  });
});
