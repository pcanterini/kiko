// Kiko Pro on the Mac (phase 3): its terms read from GET /session (src/core/account/client.ts
// planFrom, either spelling), the billing calls against a fake account server on a port of its own
// (tests/support/fake-account.ts), every Pro state's wording wherever it's said (one planStatus:
// Settings → Account and its pace line, `kiko account`, `kiko keys`, the window's item, the phone's
// `account` message), and the PRO_ON_SALE switch hiding everything about buying. Nothing reaches
// the real server, Stripe, the Keychain or ~/.config.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Account, SESSION_KEY } from "../../../src/core/account/account.ts";
import { accountClient, planFrom, type Plan } from "../../../src/core/account/client.ts";
import {
  billingChange,
  billingWatcher,
  planBadge,
  planBrief,
  planDetail,
  planFacts,
  planLine,
  planNoteLines,
  planRunsAi,
  planStatus,
  refusalNotice,
  reminderNotice,
  trialRefusedLine,
  UPGRADE_HINT,
  when,
} from "../../../src/core/account/plan-words.ts";
import { aiUse } from "../../../src/core/account/key-words.ts";
import { proOnSale } from "../../../src/core/env.ts";
import { COMMAND, PRO_ON_SALE } from "../../../src/core/name.ts";
import { accountChoices } from "../../../src/core/settings-options.ts";
import { accountStatus } from "../../../src/remote/account-status.ts";
import { billingPage, billingRefused, fakeAccountServer, happyScript, memoryStore, planJson, proJson, SESSION_TOKEN, sessionAnswer, SIGNED_OUT } from "../../support/fake-account.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  delete process.env.KIKO_ACCOUNTS;
  process.env.KIKO_PRO = "0";
});

/** Kiko Pro on sale for this test (KIKO_ACCOUNTS=1, KIKO_PRO=1): afterEach puts it back. */
function onSale() {
  process.env.KIKO_ACCOUNTS = "1";
  process.env.KIKO_PRO = "1";
}

const now = Date.UTC(2026, 10, 20, 12);
const DEC_3 = Date.UTC(2026, 11, 3, 12);
const NOV_27 = Date.UTC(2026, 10, 27, 12);
const DEC_1 = Date.UTC(2026, 11, 1, 12);

/** A Pro plan as account.json keeps it: `used` 0 to 1, its month ending DEC_1, its terms (none: given by hand). */
function pro(o: { used?: number; terms?: Partial<NonNullable<Plan["pro"]>> | null } = {}): Plan {
  return {
    name: "pro",
    startedAt: now - 10 * 86_400_000,
    endsAt: now + 300 * 86_400_000,
    quota: { period: "month", periodEnd: DEC_1, usedShare: o.used ?? 0.31, dailyCap: false, dailyResetsAt: null, pastCap: "stop" },
    ...(o.terms === null ? {} : { pro: { interval: "month", renewsAt: DEC_3, cancelAt: null, paymentFailed: null, weekShare: 0.12, pace: "on_track", ...o.terms } }),
  };
}

describe("Pro's terms, as GET /session says them", () => {
  test("the contract's camelCase and API.md's snake_case read alike; usedPct over the quota's share; times as ISO or numbers", () => {
    const camel = planFrom(proJson({ used: 42, week: 15, pace: "fast", interval: "year", cancelAt: DEC_3, failed: true, graceEndsAt: NOV_27 }).plan)!;
    assert.equal(camel.quota?.usedShare, 0.42);
    assert.deepEqual(camel.pro, { interval: "year", renewsAt: DEC_3, cancelAt: DEC_3, paymentFailed: { graceEndsAt: NOV_27 }, weekShare: 0.15, pace: "fast" });
    const snake = planFrom({
      name: "pro",
      started_at: null,
      ends_at: null,
      quota: null,
      interval: "month",
      renews_at: DEC_3 / 1000,
      cancel_at: null,
      used_pct: 7,
      week_used_pct: 3,
      pace: "on_track",
      payment_failed: null,
    })!;
    assert.equal(snake.quota?.usedShare, 0.07, "a share said with no quota: still shown");
    assert.deepEqual(snake.pro, { interval: "month", renewsAt: DEC_3, cancelAt: null, paymentFailed: null, weekShare: 0.03, pace: "on_track" });
    // Pro given by hand (no billing terms), and a trial: no terms.
    assert.equal(planFrom(planJson({ plan: "pro" }).plan)!.pro, undefined);
    assert.equal(planFrom(planJson().plan)!.pro, undefined);
  });
});

describe("the billing calls", () => {
  async function signedIn(script: Partial<ReturnType<typeof happyScript>> = {}) {
    const server = await fakeAccountServer({ ...happyScript(), ...script });
    closers.push(server.close);
    const mem = memoryStore({ [SESSION_KEY]: SESSION_TOKEN });
    const file = join(mkdtempSync(join(tmpdir(), "pro-")), "account.json");
    const account = new Account({ store: mem.store, client: accountClient(server.url), file, sleep: async () => {} });
    await account.check();
    server.calls.length = 0;
    return { server, mem, account };
  }

  test("checkout: POST /billing/checkout with the interval and the session token; its https link", async () => {
    const t = await signedIn();
    assert.deepEqual(await t.account.checkout("year"), { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_kiko" });
    assert.deepEqual(
      t.server.to("checkout").map((c) => [c.method, c.bearer, c.body]),
      [["POST", SESSION_TOKEN, { interval: "year" }]],
    );
  });

  test("checkout's refusals: already_pro, billing_unavailable; a link that isn't https is no link; 401 signed_out signs out", async () => {
    const t = await signedIn({ checkout: [billingRefused("already_pro"), billingRefused("billing_unavailable"), billingPage("http://evil.example/pay"), SIGNED_OUT] });
    assert.deepEqual(await t.account.checkout("month"), { ok: false, why: "already-pro" });
    assert.deepEqual(await t.account.checkout("month"), { ok: false, why: "billing-unavailable" });
    const plain = await t.account.checkout("month");
    assert.deepEqual([plain.ok, !plain.ok && plain.why], [false, "unreachable"]);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN, "none of those signs out");
    assert.deepEqual(await t.account.checkout("month"), { ok: false, why: "signed-out" });
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("portal: POST /billing/portal; no_billing said as such", async () => {
    const t = await signedIn({ portal: [billingPage("https://billing.stripe.com/p/session/x"), billingRefused("no_billing")] });
    assert.deepEqual(await t.account.portal(), { ok: true, url: "https://billing.stripe.com/p/session/x" });
    assert.deepEqual(await t.account.portal(), { ok: false, why: "no-billing" });
  });

  test("waitForPro: the server asked until the plan is Pro, then the access token let go; Esc stops it; 15 minutes at most", async () => {
    // One answer for each check before the wait (signedIn's, then this account's), then none, then Pro.
    const none = sessionAnswer({ plan: planJson({ plan: "none" }) });
    const t = await signedIn({ session: [none, none, none, sessionAnswer({ plan: proJson() })] });
    const waits: number[] = [];
    const account = new Account({ store: t.mem.store, client: accountClient(t.server.url), file: join(mkdtempSync(join(tmpdir(), "pro-")), "account.json"), sleep: async (ms) => void waits.push(ms) });
    await account.check();
    const tokens = t.server.to("access").length;
    const r = await account.waitForPro();
    assert.equal(r.ok, true);
    assert.equal(t.server.to("access").length, tokens + 1, "a new access token at once, so the proxy sees Pro");
    assert.deepEqual(waits, [3000, 3000], "every 3 seconds");
    assert.equal(account.view().state === "signed-in" && (account.view() as { plan: Plan }).plan.name, "pro", "account.json follows");
    // Esc: the wait stops at once.
    const stop = new AbortController();
    stop.abort();
    const stopped = await new Account({ store: t.mem.store, client: accountClient(t.server.url), file: join(mkdtempSync(join(tmpdir(), "pro-")), "account.json") }).waitForPro({ signal: stop.signal });
    assert.deepEqual(stopped, { ok: false, why: "stopped" });
    // No payment: 15 minutes, then it stops waiting.
    t.server.answer("session", sessionAnswer({ plan: planJson({ plan: "none" }) }));
    let clock = 0;
    const slow = new Account({
      store: t.mem.store,
      client: accountClient(t.server.url),
      file: join(mkdtempSync(join(tmpdir(), "pro-")), "account.json"),
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    assert.deepEqual(await slow.waitForPro(), { ok: false, why: "timeout" });
    assert.equal(clock, 15 * 60_000);
  });
});

describe("every Pro state, in words", () => {
  test("renewing: Settings 'Plan  Kiko Pro · renews 3 Dec' and 'This month  31% used · this week 12%, on track'; kiko account and kiko keys", () => {
    const p = pro();
    assert.deepEqual(planFacts(p, null, { now }), [
      { label: "Plan", value: "Kiko Pro (monthly) · renews 3 Dec", warn: false },
      { label: "This month", value: "31% used · this week 12%, on track", warn: false },
    ]);
    assert.equal(planFacts(pro({ terms: { pace: "fast", weekShare: 0.3 } }), null, { now })[1].value, "31% used · this week 30%, faster than usual");
    assert.equal(planDetail(p, null, { now }), "12% this week · on track");
    assert.equal(planDetail(pro({ terms: { pace: "fast", weekShare: 0.3 } }), null, { now }), "30% this week · using it faster than usual");
    assert.equal(planLine(p, null, now), "Plan: Kiko Pro (monthly) · renews 3 Dec · 31% of this month used.");
    assert.equal(planBrief(p, null, now), "Kiko Pro (monthly), renews 3 Dec, 31% of this month used");
  });

  test("cancelled: 'Kiko Pro · ends 3 Dec', still with the month's share", () => {
    const p = pro({ terms: { cancelAt: DEC_3, renewsAt: null } });
    assert.deepEqual(planFacts(p, null, { now }), [
      { label: "Plan", value: "Kiko Pro (monthly) · ends 3 Dec", warn: true },
      { label: "This month", value: "31% used · this week 12%, on track", warn: false },
    ]);
    assert.equal(planLine(p, null, now), "Plan: Kiko Pro (monthly) · ends 3 Dec · 31% of this month used.");
    assert.equal(planBrief(p, null, now), "Kiko Pro (monthly), ends 3 Dec, 31% of this month used");
  });

  test("a payment failed: Settings 'Kiko Pro · payment failed' in yellow, to update the card before Pro stops, the month's share and pace; kiko account and kiko keys", () => {
    const p = pro({ terms: { paymentFailed: { graceEndsAt: NOV_27 } } });
    assert.deepEqual(planFacts(p, null, { now }), [
      { label: "Plan", value: "Kiko Pro (monthly) · payment failed", warn: true, more: ["Update your card in Manage billing before Pro stops on 27 Nov."] },
      { label: "This month", value: "31% used · this week 12%, on track", warn: false },
    ]);
    assert.equal(planDetail(p, null, { now }), "31% of this month used · 12% this week · on track");
    assert.equal(planLine(p, null, now), `Plan: Kiko Pro · payment failed: update your card (${COMMAND} account billing) · Pro stops on 27 Nov.`);
    assert.equal(planBrief(p, null, now), `Kiko Pro, payment failed (${COMMAND} account billing)`);
    assert.deepEqual(planFacts(pro({ terms: { paymentFailed: { graceEndsAt: null } } }), null, { now })[0].more, ["Update your card in Manage billing, or Pro stops soon."]);
  });

  test("past the month's allowance: paused until it renews, your own key to keep going; the plan stops running the AI", () => {
    const p = pro({ used: 1 });
    assert.deepEqual(planFacts(p, null, { now })[1], {
      label: "This month",
      value: "100% used · paused until 1 Dec",
      warn: true,
      more: ["Your own OpenRouter key keeps Kiko going meanwhile:", `${COMMAND} keys set openrouter`],
    });
    assert.equal(planDetail(p, null, { now }), `Paused until 1 Dec: your own OpenRouter key keeps Kiko going now (${COMMAND} keys set openrouter)`);
    assert.equal(planBrief(p, null, now), "Kiko Pro, this month's allowance used (back 1 Dec)");
    assert.equal(planRunsAi(p, now), false);
    assert.equal(planRunsAi(p, DEC_1 + 1), true, "the next month: on again (the server says the new share at its next check)");
    assert.equal(planRunsAi(pro({ used: 0.99 }), now), true);
    const n = refusalNotice("pro_quota_used", { resetsAt: DEC_3 })!;
    assert.equal(n.spoken, "You've used this month's Kiko Pro allowance. It renews on 3 Dec; add your own OpenRouter key to keep going now.");
    assert.equal(n.key, `pro_quota_used:${DEC_3}`, "once a period");
  });

  test("Pro given by hand (no billing): 'Kiko Pro', '31% used' and no pace", () => {
    const p = pro({ terms: null });
    assert.deepEqual(planFacts(p, null, { now }), [
      { label: "Plan", value: "Kiko Pro", warn: false },
      { label: "This month", value: "31% used", warn: false },
    ]);
    assert.equal(planFacts(pro({ used: 0.85, terms: null }), null, { now })[1].warn, true, "near the month's allowance: yellow");
    assert.equal(planDetail(p, null, { now }), null);
    assert.equal(planLine(p, null, now), "Plan: Kiko Pro · 31% of this month used.");
  });

  test("the window's item: only near the cap, 'pro · 85% used' in yellow; nothing under 80% or on your own key", () => {
    assert.equal(planBadge(pro({ used: 0.79 }), { now }), null);
    assert.deepEqual(planBadge(pro({ used: 0.85 }), { now }), { text: "pro · 85% used", warn: true });
    assert.deepEqual(planBadge(pro({ used: 1 }), { now }), { text: "pro · 100% used", warn: true });
    assert.equal(planBadge(pro({ used: 0.85 }), { now, ownKey: true }), null);
  });

  test("your own key with Pro paid for: Pro still shown (no month's share), and why its allowance isn't used, in Settings, kiko account and kiko keys", () => {
    const own = aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: ["openrouter"], planRuns: true });
    const lines = ["Your own OpenRouter key is in use, so Pro isn't being used.", `To use Pro: ${COMMAND} keys remove openrouter`];
    assert.deepEqual(planFacts(pro(), null, { now, use: own }), [{ label: "Plan", value: "Kiko Pro (monthly) · renews 3 Dec", warn: false, more: lines }]);
    assert.deepEqual(planNoteLines(pro(), null, own, now), lines);
    assert.equal(planDetail(pro(), null, { now, use: own }), lines.join(" "));
    assert.equal(planLine(pro(), null, now, { use: own }), "Plan: Kiko Pro (monthly) · renews 3 Dec.");
    assert.equal(planBrief(pro(), null, now, { use: own }), "Kiko Pro (monthly), renews 3 Dec");
    assert.deepEqual(planFacts(pro({ terms: { cancelAt: DEC_3, renewsAt: null } }), null, { now, use: own })[0], {
      label: "Plan",
      value: "Kiko Pro (monthly) · ends 3 Dec",
      warn: true,
      more: lines,
    });
    // Past the month's allowance, your key going on: still Pro, with the same line under it (not "paused").
    const ownPaused = aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: ["openrouter"], planRuns: false });
    assert.equal(planDetail(pro({ used: 1 }), null, { now, use: ownPaused }), lines.join(" "));
    // No key of yours: nothing under it.
    assert.deepEqual(planNoteLines(pro(), null, aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: [], planRuns: true }), now), []);
    // The trial: its plan shown, and only that it isn't used (no "to use the trial").
    const trial: Plan = {
      name: "trial",
      startedAt: now - 86_400_000,
      endsAt: now + 5 * 86_400_000,
      quota: { period: "plan", periodEnd: null, usedShare: 0.1, dailyCap: true, dailyResetsAt: null, pastCap: "stop" },
    };
    assert.deepEqual(planFacts(trial, null, { now, use: own }), [
      { label: "Plan", value: "Free trial · 5 days left", more: ["Your own OpenRouter key is in use, so the free trial isn't being used."] },
    ]);
  });

  test("a change made on the billing page: cancelled, resumed, switched yearly or monthly, ended; the card alone is none", () => {
    const renewing = { plan: pro(), trial: null };
    const cancelled = { plan: pro({ terms: { cancelAt: DEC_3, renewsAt: null } }), trial: null };
    assert.deepEqual(billingChange(renewing, cancelled, now), {
      kind: "cancelled",
      line: `Kiko Pro is cancelled. It stays on until 3 Dec. Changed your mind? ${COMMAND} account billing`,
      spoken: "Kiko Pro is cancelled. It stays on until 3 Dec.",
    });
    assert.deepEqual(billingChange(cancelled, renewing, now), { kind: "resumed", line: "Kiko Pro renews again on 3 Dec.", spoken: "Kiko Pro renews again on 3 Dec." });
    const NOV_3_2027 = Date.UTC(2027, 10, 3, 12);
    assert.deepEqual(billingChange(renewing, { plan: pro({ terms: { interval: "year", renewsAt: NOV_3_2027 } }), trial: null }, now), {
      kind: "interval",
      line: "Kiko Pro is now yearly. Renews 3 Nov 2027.",
      spoken: null,
    });
    assert.equal(billingChange({ plan: pro({ terms: { interval: "year" } }), trial: null }, renewing, now)?.line, "Kiko Pro is now monthly. Renews 3 Dec.");
    assert.equal(billingChange(renewing, { plan: null, trial: null }, now)?.kind, "ended");
    // The card updated (or the invoices looked at): nothing that shows changed.
    assert.equal(billingChange(renewing, { plan: pro({ used: 0.4 }), trial: null }, now), null);
    assert.equal(billingChange({ plan: null, trial: null }, renewing, now), null, "only from Pro: buying is kiko upgrade's");
  });

  test("the app's look each minute: a cancel or a resume said once (spoken), the first look only remembering", () => {
    const look = billingWatcher();
    const view = (plan: Plan | null) => ({ state: "signed-in", plan, trial: null });
    const cancelled = pro({ terms: { cancelAt: DEC_3, renewsAt: null } });
    assert.equal(look(view(cancelled), now), null, "the first look: nothing to compare with");
    assert.equal(look(view(cancelled), now), null);
    assert.equal(look(view(pro()), now)?.spoken, "Kiko Pro renews again on 3 Dec.");
    assert.equal(look(view(pro()), now), null, "once");
    assert.equal(look(view(cancelled), now)?.spoken, "Kiko Pro is cancelled. It stays on until 3 Dec.");
    assert.equal(look(view(cancelled), now), null, "once");
    // Switched yearly: written in kiko account billing, not said.
    assert.equal(look(view(pro({ terms: { cancelAt: DEC_3, renewsAt: null, interval: "year" } })), now)?.spoken, null);
    // Signed out in between: nothing said for the look after.
    assert.equal(look({ state: "signed-out", plan: null, trial: null }, now), null);
    assert.equal(look(view(pro()), now), null);
  });

  test("the phone's account message: Pro's renewsAt, cancelAt and paymentFailed; billingOnMac with Pro paid for, on sale or not; Pro with your own key still Pro", () => {
    const view = (plan: Plan) => ({ state: "signed-in" as const, email: null, since: now, checkedAt: now, plan, trial: null });
    assert.deepEqual(accountStatus(view(pro()), false, now), {
      type: "account",
      signedIn: true,
      ownKey: false,
      plan: "pro",
      usedPct: 31,
      renewsAt: DEC_3,
      cancelAt: null,
      paymentFailed: null,
      billingOnMac: true,
    });
    assert.deepEqual(accountStatus(view(pro()), true, now), {
      type: "account",
      signedIn: true,
      ownKey: true,
      plan: "pro",
      usedPct: 31,
      renewsAt: DEC_3,
      cancelAt: null,
      paymentFailed: null,
      billingOnMac: true,
    });
    assert.deepEqual(accountStatus(view(pro({ terms: { paymentFailed: { graceEndsAt: NOV_27 } } })), false, now), {
      type: "account",
      signedIn: true,
      ownKey: false,
      plan: "pro",
      usedPct: 31,
      renewsAt: DEC_3,
      cancelAt: null,
      paymentFailed: { graceEndsAt: NOV_27 },
      billingOnMac: true,
    });
    // Given by hand: as before, nothing new (no billing to manage).
    assert.deepEqual(accountStatus(view(pro({ terms: null })), false, now), { type: "account", signedIn: true, ownKey: false, plan: "pro", usedPct: 31 });
    // One status for all of them: the same share everywhere.
    assert.equal(planStatus(pro(), null, now).kind, "pro");
  });
});

describe("PRO_ON_SALE", () => {
  const trial = (daysLeft: number, used: number): Plan => ({
    name: "trial",
    startedAt: now - 86_400_000,
    endsAt: now + daysLeft * 86_400_000 - 60_000,
    quota: { period: "plan", periodEnd: null, usedShare: used, dailyCap: true, dailyResetsAt: null, pastCap: "stop" },
  });

  test("on in the release (2026-11-17), only with accounts open: KIKO_PRO=1 turns it on, 0 off", () => {
    assert.equal(PRO_ON_SALE, true);
    assert.equal(proOnSale({}), true, "accounts open, Pro on sale");
    assert.equal(proOnSale({ KIKO_PRO: "1" }), true, "accounts are open by default");
    assert.equal(proOnSale({ KIKO_ACCOUNTS: "0", KIKO_PRO: "1" }), false, "not without accounts");
    assert.equal(proOnSale({ KIKO_ACCOUNTS: "1" }), true);
    assert.equal(proOnSale({ KIKO_ACCOUNTS: "1", KIKO_PRO: "1" }), true);
    assert.equal(proOnSale({ KIKO_ACCOUNTS: "1", KIKO_PRO: "0" }), false);
  });

  test("off: nothing about buying is said (the reminders, the trial's end, kiko account's lines); Settings' Manage billing only with Pro", () => {
    for (const n of [reminderNotice(trial(2, 0.1), now), reminderNotice(trial(5, 0.85), now)]) {
      assert.doesNotMatch(`${n!.line} ${n!.spoken}`, /upgrade/i);
    }
    assert.doesNotMatch(refusalNotice("trial_ended")!.line, /upgrade/);
    assert.doesNotMatch(planLine(null, null, now), /upgrade/);
    assert.doesNotMatch(planLine(null, { startedAt: null, endsAt: now - 86_400_000, ended: true, endedWhy: "time" }, now), /upgrade/);
    assert.deepEqual(
      accountChoices({ signedIn: true, confirming: false, phones: 0 }).map((c) => c.value),
      ["keep", "signout"],
    );
  });

  test("on: the spoken trial reminders add how to upgrade, and only those; your own key still said beside it", () => {
    onSale();
    const two = reminderNotice(trial(2, 0.1), now)!;
    assert.equal(two.spoken, `Two days left on your free trial. Say 'upgrade' or run ${COMMAND} upgrade when you're ready.`);
    const almost = reminderNotice(trial(5, 0.85), now)!;
    assert.equal(almost.spoken, `Your trial is almost used up. ${UPGRADE_HINT}`);
    assert.match(almost.line, /your own OpenRouter key .* free forever with no account\. Say 'upgrade'/);
    assert.match(refusalNotice("trial_ended")!.line, new RegExp(`your own key \\(free\\), or Kiko Pro: ${COMMAND} upgrade\\.$`));
    assert.match(planLine(null, null, now), new RegExp(`or Kiko Pro \\(${COMMAND} upgrade\\)\\.$`));
    // Never mid-work otherwise: the refusals that aren't the trial's end don't mention it.
    for (const code of ["daily_cap", "trials_paused", "no_plan", "blocked", "pro_quota_used"]) assert.doesNotMatch(refusalNotice(code)!.spoken, /upgrade/i, code);
    assert.deepEqual(
      accountChoices({ signedIn: true, confirming: false, phones: 0, billing: true }).map((c) => c.value),
      ["keep", "billing", "signout"],
    );
  });
});

describe("free trials full for today (403 trials_paused)", () => {
  test("said with when to try again (resets_at, in local time), and your own key; nothing signed out", async () => {
    const resets = Date.UTC(2026, 10, 21, 0);
    const server = await fakeAccountServer({
      ...happyScript(),
      trial: [{ status: 403, json: { error: "trials_paused", error_description: "test", resets_at: new Date(resets).toISOString() }, headers: { "retry-after": "3600" } }],
    });
    closers.push(server.close);
    const mem = memoryStore({ [SESSION_KEY]: SESSION_TOKEN });
    const account = new Account({ store: mem.store, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "pro-")), "account.json") });
    await account.check();
    const r = await account.startTrial({ started: () => "started", refused: trialRefusedLine });
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "trials_paused"]);
    assert.equal(r.said, `Free trials are full for today; try again after ${when(resets)}, or use your own OpenRouter key (no account needed: ${COMMAND} keys set openrouter).`);
    assert.equal(mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("no resets_at: from Retry-After; neither: tomorrow", () => {
    assert.match(trialRefusedLine("trials_paused", null, null, { retryAfter: 3600, now }), new RegExp(`try again after ${when(now + 3_600_000).replace(/[()]/g, "\\$&")},`));
    assert.match(trialRefusedLine("trials_paused", null, null), /^Free trials are full for today; try again tomorrow, or use your own OpenRouter key \(no account needed/);
  });
});
