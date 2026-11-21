// What Kiko's AI runs on, and how it's said (src/core/account/key-words.ts, plan-words.ts aiWords):
// every key setup (none, OpenRouter only, Anthropic only, both with Haiku on Anthropic routing or an
// OpenRouter model) against every account state (accounts off, signed out, no plan, the trial, Pro),
// decided as the app decides it (core/keys.ts aiUseFor: pickEngines, then model-route.ts's order),
// the same words for Settings → Account, `kiko account` and the phone's `account` message. Made-up
// keys and plans only: nothing read from the Keychain, .env or the account server.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AccountView } from "../../../src/core/account/account.ts";
import type { Plan } from "../../../src/core/account/client.ts";
import { aiUse, keysDetail, keysLine, keyUse, ownKeysOnly, planUsed } from "../../../src/core/account/key-words.ts";
import { aiWords, planRunsAi } from "../../../src/core/account/plan-words.ts";
import { aiUseFor } from "../../../src/core/keys.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { accountStatus } from "../../../src/remote/account-status.ts";

const now = Date.UTC(2026, 10, 20, 12);
const DAY = 86_400_000;
const DEC_3 = Date.UTC(2026, 11, 3, 12);
const FAKE = "made-up-key";

const trial: Plan = {
  name: "trial",
  startedAt: now - DAY,
  endsAt: now + 5 * DAY - 60_000,
  quota: { period: "plan", periodEnd: null, usedShare: 0.2, dailyCap: true, dailyResetsAt: null, pastCap: "stop" },
};
const pro = (interval: "month" | "year" | null = "month"): Plan => ({
  name: "pro",
  startedAt: now - DAY,
  endsAt: null,
  quota: { period: "month", periodEnd: now + 10 * DAY, usedShare: 0.31, dailyCap: false, dailyResetsAt: null, pastCap: "stop" },
  ...(interval ? { pro: { interval, renewsAt: DEC_3, cancelAt: null, paymentFailed: null, weekShare: null, pace: null } } : {}),
});
const signedIn = (plan: Plan | null): AccountView => ({ state: "signed-in", email: "name@example.com", since: now, checkedAt: now, plan, trial: null });

const VIEWS: Record<string, AccountView | null> = {
  "accounts off": null,
  "signed out": { state: "signed-out", revoked: false },
  "no plan": signedIn({ name: "none", startedAt: null, endsAt: null, quota: null }),
  trial: signedIn(trial),
  pro: signedIn(pro()),
};

/** The setups: the keys set (made up) and what's chosen in Settings → Replies. */
const SETUPS: Record<string, { env: Record<string, string>; chosen: { llm?: string } }> = {
  "no keys": { env: {}, chosen: {} },
  "OpenRouter only": { env: { OPENROUTER_API_KEY: FAKE }, chosen: {} },
  "Anthropic only": { env: { ANTHROPIC_API_KEY: FAKE }, chosen: {} },
  "both, Haiku on Anthropic": { env: { OPENROUTER_API_KEY: FAKE, ANTHROPIC_API_KEY: FAKE }, chosen: { llm: "haiku" } },
  "both, an OpenRouter model": { env: { OPENROUTER_API_KEY: FAKE, ANTHROPIC_API_KEY: FAKE }, chosen: { llm: "openai/gpt-5.4-nano" } },
};

const useOf = (setup: string, view: AccountView | null, classifier = true) => {
  const planRuns = view?.state === "signed-in" && planRunsAi(view.plan, now);
  return aiUseFor(SETUPS[setup]!.chosen, SETUPS[setup]!.env, { planRuns, classifier });
};

const OFF = "None, so Kiko's AI is off";
const BOTH = "Your own keys: Anthropic for routing and summaries, OpenRouter for quick checks";
const OR = "Your own OpenRouter key";
const ANT = "Your own Anthropic key (quick checks off: they need OpenRouter)";
const TRIAL = "Free trial · 5 days left";
const PRO = "Kiko Pro (monthly) · renews 3 Dec";
const OR_OVER_TRIAL = ["Your own OpenRouter key is in use, so the free trial isn't being used."];
const OR_OVER_PRO = ["Your own OpenRouter key is in use, so Pro isn't being used.", `To use Pro: ${COMMAND} keys remove openrouter`];

/** Every setup × every account state: [plan, the note under it, keys]. */
const WANT: Record<string, Record<string, [string | null, string[], string | null]>> = {
  "no keys": {
    "accounts off": [null, [], OFF],
    "signed out": ["Signed out", [], OFF],
    "no plan": ["No plan", [], OFF],
    trial: [TRIAL, [], null],
    pro: [PRO, [], null],
  },
  "OpenRouter only": {
    "accounts off": [null, [], OR],
    "signed out": ["Signed out", [], OR],
    "no plan": ["No plan", [], OR],
    trial: [TRIAL, OR_OVER_TRIAL, OR],
    pro: [PRO, OR_OVER_PRO, OR],
  },
  "Anthropic only": {
    "accounts off": [null, [], ANT],
    "signed out": ["Signed out", [], ANT],
    "no plan": ["No plan", [], ANT],
    // No OpenRouter key: the plan runs the quick checks, your Anthropic key the rest.
    trial: [TRIAL, ["The free trial runs the quick checks; your own Anthropic key runs routing and summaries."], "Your own Anthropic key for routing and summaries; the free trial for quick checks"],
    pro: [
      PRO,
      ["Pro runs the quick checks; your own Anthropic key runs routing and summaries.", `To use Pro for both: ${COMMAND} keys remove anthropic`],
      "Your own Anthropic key for routing and summaries; Kiko Pro for quick checks",
    ],
  },
  "both, Haiku on Anthropic": {
    "accounts off": [null, [], BOTH],
    "signed out": ["Signed out", [], BOTH],
    "no plan": ["No plan", [], BOTH],
    trial: [TRIAL, ["Your own keys are in use, so the free trial isn't being used."], BOTH],
    pro: [PRO, ["Your own keys are in use, so Pro isn't being used.", `To use Pro: ${COMMAND} keys remove anthropic and ${COMMAND} keys remove openrouter`], BOTH],
  },
  // The model on OpenRouter: the Anthropic key isn't used, so only OpenRouter's is said.
  "both, an OpenRouter model": {
    "accounts off": [null, [], OR],
    "signed out": ["Signed out", [], OR],
    "no plan": ["No plan", [], OR],
    trial: [TRIAL, OR_OVER_TRIAL, OR],
    pro: [PRO, OR_OVER_PRO, OR],
  },
};

describe("what Kiko's AI runs on, said the same everywhere", () => {
  for (const [setup, byView] of Object.entries(WANT)) {
    for (const [name, [plan, planNote, keys]] of Object.entries(byView)) {
      test(`${setup}, ${name}`, () => {
        const view = VIEWS[name]!;
        assert.deepEqual(aiWords(view, useOf(setup, view), now), { plan, planNote, keys });
      });
    }
  }

  test("the owner's setup (signed out, both keys, Haiku on Anthropic): Anthropic routes and summarizes, OpenRouter runs the quick checks", () => {
    const use = useOf("both, Haiku on Anthropic", VIEWS["signed out"]!);
    assert.deepEqual({ router: use.router, checks: use.checks, checksOff: use.checksOff }, { router: "anthropic", checks: "openrouter", checksOff: null });
    assert.equal(keysLine(use), BOTH);
    assert.equal(ownKeysOnly(use), true);
    assert.equal(planUsed(use), false);
  });

  test("Pro paid yearly, or given by hand: its name says so, or nothing", () => {
    const use = useOf("no keys", signedIn(pro("year")));
    assert.equal(aiWords(signedIn(pro("year")), use, now).plan, "Kiko Pro (yearly) · renews 3 Dec");
    assert.equal(aiWords(signedIn(pro(null)), use, now).plan, "Kiko Pro");
  });

  test("the quick checks turned off in Settings: said beside the key; with both keys, only Anthropic's is in use", () => {
    assert.equal(keysLine(useOf("OpenRouter only", null, false)), "Your own OpenRouter key (quick checks off in Settings)");
    assert.equal(keysLine(useOf("Anthropic only", null, false)), "Your own Anthropic key (quick checks off in Settings)");
    assert.equal(keysLine(useOf("both, Haiku on Anthropic", null, false)), "Your own Anthropic key (quick checks off in Settings)");
    const p = VIEWS.pro!;
    assert.deepEqual(aiWords(p, useOf("both, Haiku on Anthropic", p, false), now).planNote, [
      "Your own Anthropic key is in use, so Pro isn't being used.",
      `To use Pro: ${COMMAND} keys remove anthropic`,
    ]);
  });

  test("what each key does, for Settings → Keys and kiko keys: Deepgram and Cartesia only there", () => {
    const use = aiUse({ llm: "haiku", classifier: true, keys: ["anthropic", "openrouter", "deepgram", "cartesia"], planRuns: false, stt: "deepgram", tts: "cartesia" });
    assert.equal(keyUse(use, "anthropic"), "Used for routing and summaries (Haiku)");
    assert.equal(keyUse(use, "openrouter"), "Used for quick checks");
    assert.equal(keyUse(use, "deepgram"), "Used for speech-to-text");
    assert.equal(keyUse(use, "cartesia"), "Used for the voice");
    assert.deepEqual(keysDetail(use), ["Routing and summaries: your Anthropic key", "Quick checks: your OpenRouter key", "Speech-to-text: your Deepgram key", "Voice: your Cartesia key"]);
    // Never in the short line.
    assert.equal(keysLine(use), BOTH);
    const other = aiUse({ llm: "openai/gpt-5.4-nano", classifier: true, keys: ["anthropic", "openrouter", "deepgram"], planRuns: false, stt: "apple", tts: "pocket" });
    assert.equal(keyUse(other, "anthropic"), "Not used now: the model in Settings → Replies is on OpenRouter");
    assert.equal(keyUse(other, "openrouter"), "Used for routing, summaries and quick checks");
    assert.equal(keyUse(other, "deepgram"), "Not used now: speech-to-text is Apple's");
    assert.equal(keyUse(other, "cartesia"), null, "not set: nothing to say");
    const none = aiUse({ llm: null, classifier: true, keys: [], planRuns: false });
    assert.deepEqual(keysDetail(none), ["Routing and summaries: off (no key)", "Quick checks: off (they need OpenRouter: your key or a plan)", "Speech-to-text: Apple's, free", "Voice: free"]);
  });

  test("the phone's account message: the Mac's words beside the fields it had (ownKey unchanged: your OpenRouter key set)", () => {
    const out = VIEWS["signed out"]!;
    assert.deepEqual(accountStatus(out, true, now, { use: useOf("both, Haiku on Anthropic", out) }), {
      type: "account",
      signedIn: false,
      ownKey: true,
      plan: "none",
      planText: "Signed out",
      keysText: BOTH,
    });
    const p = VIEWS.pro!;
    assert.deepEqual(accountStatus(p, true, now, { use: useOf("OpenRouter only", p) }), {
      type: "account",
      signedIn: true,
      ownKey: true,
      plan: "pro",
      usedPct: 31,
      renewsAt: DEC_3,
      cancelAt: null,
      paymentFailed: null,
      billingOnMac: true,
      planText: PRO,
      planNote: `Your own OpenRouter key is in use, so Pro isn't being used. To use Pro, on your Mac: ${COMMAND} keys remove openrouter`,
      keysText: OR,
    });
    // The plan running it all: no keysText.
    const t = VIEWS.trial!;
    assert.deepEqual(accountStatus(t, false, now, { use: useOf("no keys", t) }), {
      type: "account",
      signedIn: true,
      ownKey: false,
      plan: "trial",
      endsAt: trial.endsAt,
      usedPct: 20,
      ended: false,
      endedWhy: null,
      planText: TRIAL,
    });
    // Without `use` (an older caller): as before, none of the words.
    assert.equal("keysText" in accountStatus(out, true, now)!, false);
  });
});
