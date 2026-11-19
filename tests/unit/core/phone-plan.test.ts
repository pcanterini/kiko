// The iPhone app as a Kiko Pro feature (core/account/phone-plan.ts): included with a trial or Pro in
// effect (a failed payment's grace and cancelled Pro until their end), 7 days of grace after the last
// check while the server can't be reached, never without Pro on sale; whether the trial could still
// start; the relay pass (Account.relayPass: fetched, held, renewed under 12 hours and at once when the
// plan changes, let go on plan_required, kept while the server is out of reach; keepRelayPass asking
// at once on a plan change); Pair a phone's offer (app/phone-offer.ts)
// carried out against a fake account server: signing in, the trial, the checkout, then on to the QR
// code. Nothing reaches the real server, Stripe, the Keychain or ~/.config.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Account, PASS_RENEW_MS, SESSION_KEY, type AccountView } from "../../../src/core/account/account.ts";
import { accountClient, type Plan } from "../../../src/core/account/client.ts";
import { PHONE_GRACE_MS, PHONE_WORDS, phoneIncluded, phonePlan, phoneReason, trialAvailable } from "../../../src/core/account/phone-plan.ts";
import { choicesFor } from "../../../src/core/settings-options.ts";
import type { PlanStep } from "../../../src/core/ui-store.ts";
import { planForPhone } from "../../../src/app/phone-offer.ts";
import { keepRelayPass } from "../../../src/app/phone-plan.ts";
import {
  billingPage,
  fakeAccountServer,
  happyScript,
  memoryStore,
  planJson,
  planRequired,
  proJson,
  relayPassAnswer,
  SESSION_TOKEN,
  sessionAnswer,
  trialRefused,
  trialStarted,
  type Answer,
  type Route,
} from "../../support/fake-account.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const plan = (name: Plan["name"], endsAt: number | null, extra: Partial<Plan> = {}): Plan => ({ name, startedAt: NOW - 3 * DAY, endsAt, quota: null, ...extra });
const view = (p: Plan | null, checkedAt: number | null = NOW, trial: AccountView extends infer V ? (V extends { trial: infer T } ? T : never) : never = null): AccountView => ({
  state: "signed-in",
  email: "lacy@example.com",
  since: NOW - 30 * DAY,
  checkedAt,
  plan: p,
  trial,
});

describe("whether the plan includes the iPhone app", () => {
  test("Pro not on sale: always, whatever the account (pairing and the phone stay free)", () => {
    for (const v of [null, { state: "signed-out", revoked: false } as AccountView, view(null), view(plan("none", null))]) assert.equal(phoneIncluded(v, { sale: false, now: NOW }), true);
  });

  test("on sale: a trial or Pro in effect, including a failed payment's grace and cancelled Pro until its end", () => {
    assert.equal(phoneIncluded(view(plan("trial", NOW + 2 * DAY)), { sale: true, now: NOW }), true);
    assert.equal(phoneIncluded(view(plan("pro", null)), { sale: true, now: NOW }), true);
    const grace = plan("pro", NOW + 3 * DAY, { pro: { interval: "month", renewsAt: null, cancelAt: null, paymentFailed: { graceEndsAt: NOW + 3 * DAY }, weekShare: null, pace: null } });
    assert.equal(phoneIncluded(view(grace), { sale: true, now: NOW }), true, "a failed payment's 7 days");
    const cancelled = plan("pro", NOW + DAY, { pro: { interval: "month", renewsAt: null, cancelAt: NOW + DAY, paymentFailed: null, weekShare: null, pace: null } });
    assert.equal(phoneIncluded(view(cancelled), { sale: true, now: NOW }), true, "cancelled, until its end");
    // Pro past its month's allowance still includes the phone (the allowance is for the AI).
    const usedUp = plan("pro", null, { quota: { period: "month", periodEnd: NOW + DAY, usedShare: 1, dailyCap: false, dailyResetsAt: null, pastCap: "stop" } });
    assert.equal(phoneIncluded(view(usedUp), { sale: true, now: NOW }), true);
  });

  test("on sale: signed out, no plan, your own key alone: not included", () => {
    assert.equal(phoneIncluded({ state: "signed-out", revoked: false }, { sale: true, now: NOW }), false);
    assert.equal(phoneIncluded(null, { sale: true, now: NOW }), false);
    assert.equal(phoneIncluded(view(null), { sale: true, now: NOW }), false);
    assert.equal(phoneIncluded(view(plan("none", null)), { sale: true, now: NOW }), false);
  });

  test("7 days of grace after the last check: a plan in effect then holds while the server can't be reached, even past its end", () => {
    const checked = NOW - 2 * DAY;
    const lapsed = plan("pro", NOW - DAY);
    assert.equal(phoneIncluded(view(lapsed, checked), { sale: true, now: NOW }), true, "past its end, 2 days after the last check");
    assert.equal(phoneIncluded(view(lapsed, checked), { sale: true, now: checked + PHONE_GRACE_MS - 1 }), true);
    assert.equal(phoneIncluded(view(lapsed, checked), { sale: true, now: checked + PHONE_GRACE_MS }), false, "the grace is 7 days");
    // Checked after its end (the server said so): no grace.
    assert.equal(phoneIncluded(view(lapsed, NOW - DAY / 2), { sale: true, now: NOW }), false);
    // Never checked: nothing to hold.
    assert.equal(phoneIncluded(view(lapsed, null), { sale: true, now: NOW }), false);
  });

  test("the trial could still start: none on record (or signed out), unless the server said otherwise", () => {
    assert.equal(trialAvailable({ state: "signed-out", revoked: false }), true);
    assert.equal(trialAvailable(view(plan("none", null))), true);
    assert.equal(trialAvailable(view(plan("none", null), NOW, { startedAt: NOW - 9 * DAY, endsAt: NOW - 2 * DAY, ended: true, endedWhy: "time" })), false);
    assert.equal(trialAvailable(view(plan("pro", NOW - DAY), NOW)), false, "had Pro: no trial");
    assert.equal(trialAvailable(view(plan("none", null)), false), false, "the server's word wins");
    assert.deepEqual(phonePlan(view(plan("none", null)), { sale: true, now: NOW }), { ok: false, trialAvailable: true, reason: "no_plan" });
    assert.deepEqual(phonePlan(view(plan("trial", NOW + DAY)), { sale: true, now: NOW }), { ok: true });
  });

  test("the words: the offer with the price, the refusal pointing to kiko upgrade, or kiko setup while the trial can start", () => {
    assert.equal(PHONE_WORDS.offer, "The iPhone app comes with Kiko Pro: $8.99 a month or $89 a year, Kiko's AI included.");
    assert.match(PHONE_WORDS.refused(false), /^Your phone tried to connect\. The iPhone app comes with Kiko Pro: kiko(-dev)? upgrade\.$/);
    assert.match(PHONE_WORDS.refused(true), /kiko(-dev)? setup\.$/);
  });
});

describe("why the plan doesn't include the iPhone app (the reason the phone and the Mac's line name)", () => {
  const failed = { interval: "month" as const, renewsAt: null, cancelAt: null, paymentFailed: { graceEndsAt: NOW - DAY }, weekShare: null, pace: null };
  test("signed out (or no account at all) is the Mac being signed out, never Pro's fault", () => {
    assert.equal(phoneReason({ state: "signed-out", revoked: false }, NOW), "mac_signed_out");
    assert.equal(phoneReason({ state: "signed-out", revoked: true }, NOW), "mac_signed_out", "signed out from the web");
    assert.equal(phoneReason(null, NOW), "mac_signed_out");
    assert.deepEqual(phonePlan({ state: "signed-out", revoked: true }, { sale: true, now: NOW }), { ok: false, trialAvailable: true, reason: "mac_signed_out" });
  });

  test("signed in: no plan, a trial that ended, Pro that ended, Pro stopped after a failed payment", () => {
    assert.equal(phoneReason(view(null), NOW), "no_plan");
    assert.equal(phoneReason(view(plan("none", null)), NOW), "no_plan");
    assert.equal(phoneReason(view(plan("none", null), NOW, { startedAt: NOW - 9 * DAY, endsAt: NOW - 2 * DAY, ended: true, endedWhy: "time" }), NOW), "trial_ended");
    assert.equal(phoneReason(view(plan("none", null), NOW, { startedAt: NOW - 3 * DAY, endsAt: NOW + 4 * DAY, ended: true, endedWhy: "cap" }), NOW), "trial_ended", "its usage used up");
    assert.equal(phoneReason(view(plan("trial", NOW - DAY)), NOW), "trial_ended", "past its end as last known");
    assert.equal(phoneReason(view(plan("pro", NOW - DAY)), NOW), "pro_ended");
    assert.equal(phoneReason(view(plan("pro", NOW - DAY, { pro: failed })), NOW), "payment_failed_grace_over");
    // The server says none once Pro is over: account.json kept that it was Pro.
    assert.equal(phoneReason({ ...view(plan("none", null)), proEnded: { at: NOW - DAY, paymentFailed: false } } as AccountView, NOW), "pro_ended");
    assert.equal(phoneReason({ ...view(plan("none", null)), proEnded: { at: NOW - DAY, paymentFailed: true } } as AccountView, NOW), "payment_failed_grace_over");
  });

  test("Pro over is kept from the check that saw it go, until a plan is in effect again", async () => {
    const answers = [
      sessionAnswer({ plan: proJson({ failed: true, graceEndsAt: NOW + DAY }) }),
      sessionAnswer({ plan: planJson({ plan: "none" }) }),
      sessionAnswer({ plan: planJson({ plan: "none" }) }),
      sessionAnswer({ plan: planJson({ plan: "trial" }) }),
    ];
    const t = await accountWith({ session: answers });
    // accountWith's own check took the first: Pro, its payment failing.
    const first = t.account.view();
    assert.equal(first.state === "signed-in" ? first.plan?.name : null, "pro");
    await t.account.check();
    const gone = t.account.view();
    assert.ok(gone.state === "signed-in" && gone.proEnded?.paymentFailed === true, "Pro gone after a failed payment");
    assert.equal(phoneReason(gone), "payment_failed_grace_over");
    await t.account.check();
    assert.equal(phoneReason(t.account.view()), "payment_failed_grace_over", "kept at the next check");
    await t.account.check();
    const back = t.account.view();
    assert.ok(back.state === "signed-in" && back.proEnded === undefined, "a trial in effect: forgotten");
  });

  test("the Mac's line for each: the one thing that fixes it", () => {
    assert.match(PHONE_WORDS.refused(true, "mac_signed_out"), /^Your phone can't connect: this Mac is signed out of Kiko\. Press Enter to sign in\.$/);
    assert.match(
      PHONE_WORDS.refused(true, "mac_signed_out", { enter: false }),
      /^Your phone can't connect: this Mac is signed out of Kiko\. Sign in: Settings → Kiko account, or kiko(-dev)? login\.$/,
    );
    assert.match(PHONE_WORDS.refused(false, "trial_ended"), /^Your phone tried to connect, but your free trial ended: kiko(-dev)? upgrade\.$/);
    assert.match(PHONE_WORDS.refused(false, "pro_ended"), /^Your phone tried to connect, but Kiko Pro ended: kiko(-dev)? upgrade\.$/);
    assert.match(PHONE_WORDS.refused(false, "payment_failed_grace_over"), /^Your phone tried to connect, but Kiko Pro stopped after a failed payment: kiko(-dev)? account billing\.$/);
    assert.match(PHONE_WORDS.refused(true, "no_plan"), /or the free trial: kiko(-dev)? setup\.$/);
    for (const r of ["mac_signed_out"] as const) assert.doesNotMatch(PHONE_WORDS.refused(true, r), /Pro/, "signed out never blames Pro");
  });
});

describe("Pair a phone's offer, in the settings screen", () => {
  test("the QR code with the plan; the trial (while it can start), monthly and yearly without", async () => {
    assert.deepEqual(
      (await choicesFor("phonePair", { tts: "say", current: "" })).choices.map((c) => c.value),
      ["open"],
    );
    const offer = await choicesFor("phonePair", { tts: "say", current: JSON.stringify({ offer: true, trial: true }) });
    assert.deepEqual(
      offer.choices.map((c) => [c.value, c.label, c.hint]),
      [
        ["trial", "Start the free trial (7 days, no card)", undefined],
        ["month", "Kiko Pro, monthly", "$8.99 a month"],
        ["year", "Kiko Pro, yearly", "$89 a year (about 2 months free)"],
      ],
    );
    const noTrial = await choicesFor("phonePair", { tts: "say", current: JSON.stringify({ offer: true, trial: false }) });
    assert.deepEqual(
      noTrial.choices.map((c) => c.value),
      ["month", "year"],
    );
  });
});

async function accountWith(script: Partial<Record<Route, Answer[]>>, o: { signedIn?: boolean; now?: () => number } = {}) {
  const server = await fakeAccountServer({ ...happyScript(), ...script });
  closers.push(() => server.close());
  const mem = memoryStore(o.signedIn === false ? {} : { [SESSION_KEY]: SESSION_TOKEN });
  const file = join(mkdtempSync(join(tmpdir(), "phone-plan-")), "account.json");
  const account = new Account({ store: mem.store, client: accountClient(server.url), file, sleep: async () => {}, ...(o.now ? { now: o.now } : {}) });
  if (o.signedIn !== false) await account.check();
  server.calls.length = 0;
  return { server, account };
}

/** Relay room ids (32 lowercase hex), made up. */
const ROOM = "0123456789abcdef".repeat(2);
const OTHER_ROOM = "fedcba9876543210".repeat(2);

describe("the relay pass", () => {
  test("fetched with the session token, held while it has more than 12 hours left, renewed under that", async () => {
    const HOUR = 3_600_000;
    assert.equal(PASS_RENEW_MS, 12 * HOUR);
    let clock = NOW;
    const t = await accountWith({ relayPass: [relayPassAnswer(NOW + DAY, 1), relayPassAnswer(NOW + 2 * DAY, 2)] }, { now: () => clock });
    const first = await t.account.relayPass(ROOM);
    assert.ok(first.ok);
    assert.equal(first.fetched, true);
    assert.equal(first.expiresAt, NOW + DAY);
    assert.deepEqual(
      t.server.to("relayPass").map((c) => [c.method, c.bearer, c.body]),
      [["POST", SESSION_TOKEN, { room: ROOM }]],
    );
    clock = NOW + 11 * HOUR;
    const held = await t.account.relayPass(ROOM);
    assert.ok(held.ok && !held.fetched && held.pass === first.pass, "13 hours left: the one held");
    assert.equal(t.server.to("relayPass").length, 1);
    clock = NOW + DAY - PASS_RENEW_MS + 1;
    const renewed = await t.account.relayPass(ROOM);
    assert.ok(renewed.ok && renewed.fetched && renewed.pass !== first.pass, "under 12 hours: a new one");
    assert.equal(t.server.to("relayPass").length, 2);
  });

  test("the plan changed (heard by a check): a new pass at once, though the one held has hours left; the same plan heard again: held", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ daysLeft: 5 }) })], relayPass: [relayPassAnswer(NOW + DAY, 1), relayPassAnswer(NOW + DAY, 2)] }, { now: () => NOW });
    const first = await t.account.relayPass(ROOM);
    assert.ok(first.ok && first.fetched);
    // Checked again, nothing changed: the one held.
    await t.account.check();
    const same = await t.account.relayPass(ROOM);
    assert.ok(same.ok && !same.fetched);
    // Pro bought (or the trial ended, or Pro renewed): heard by the next check.
    t.server.answer("session", sessionAnswer({ plan: proJson() }));
    await t.account.check();
    const after = await t.account.relayPass(ROOM);
    assert.ok(after.ok && after.fetched && after.pass !== first.pass, "a pass asked for under the new plan");
    assert.equal(t.server.to("relayPass").length, 2);
  });

  test("onPlanChange: told when the plan as known changes, not when it's checked unchanged; stopped, not told", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ daysLeft: 5 }) })] });
    let told = 0;
    const stop = t.account.onPlanChange(() => told++);
    await t.account.check();
    await new Promise((r) => setImmediate(r));
    assert.equal(told, 0);
    t.server.answer("session", sessionAnswer({ plan: proJson() }));
    await t.account.check();
    await new Promise((r) => setImmediate(r));
    assert.equal(told, 1);
    stop();
    t.server.answer("session", sessionAnswer({ plan: planJson({ plan: "none" }) }));
    await t.account.check();
    await new Promise((r) => setImmediate(r));
    assert.equal(told, 1);
  });

  test("keepRelayPass: asked at start, then at once when the plan changes (not only on its hourly look); stopped, never again", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ daysLeft: 5 }) })], relayPass: [relayPassAnswer(Date.now() + DAY, 1), relayPassAnswer(Date.now() + DAY, 2)] });
    const shown: (string | null)[] = [];
    const keeper = keepRelayPass(ROOM, (p) => void shown.push(p), { lookMs: 3_600_000, account: () => t.account, onSale: () => true });
    try {
      const until = async (n: number) => {
        for (let i = 0; i < 200 && shown.length < n; i++) await new Promise((r) => setTimeout(r, 5));
      };
      await until(1);
      assert.equal(shown.length, 1);
      t.server.answer("session", sessionAnswer({ plan: proJson() }));
      await t.account.check();
      await until(2);
      assert.equal(shown.length, 2, "the plan changed: shown a new pass at once");
      assert.notEqual(shown[1], shown[0]);
      assert.equal(t.server.to("relayPass").length, 2);
    } finally {
      keeper.stop();
    }
    t.server.answer("session", sessionAnswer({ plan: planJson({ daysLeft: 2 }) }));
    await t.account.check();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.server.to("relayPass").length, 2, "stopped: not asked again");
  });

  test("plan_required: none held any more, and the server's word on the trial kept; the server out of reach: the held one while it's good", async () => {
    let clock = NOW;
    const HOUR = 3_600_000;
    const t = await accountWith({ relayPass: [relayPassAnswer(NOW + DAY), planRequired(true)] }, { now: () => clock });
    assert.ok((await t.account.relayPass(ROOM)).ok);
    clock = NOW + 20 * HOUR;
    assert.deepEqual(await t.account.relayPass(ROOM), { ok: false, why: "plan-required", trialAvailable: true });
    assert.equal(t.account.trialAvailableSaid(), true);
    // A new pass, then the server down: the one held goes on until it runs out.
    t.server.answer("relayPass", relayPassAnswer(clock + DAY), "drop");
    assert.ok((await t.account.relayPass(ROOM)).ok);
    clock += 14 * HOUR;
    const offline = await t.account.relayPass(ROOM);
    assert.ok(offline.ok && !offline.fetched, "unreachable: kept");
    clock += 11 * HOUR;
    const gone = await t.account.relayPass(ROOM);
    assert.equal(gone.ok, false, "run out: none");
  });

  test("the room changed (a new relay identity): a new pass asked for the new room at once, the old room's never shown for it", async () => {
    const t = await accountWith({ relayPass: [relayPassAnswer(NOW + 7 * DAY, 1), relayPassAnswer(NOW + 7 * DAY, 2)] }, { now: () => NOW });
    const first = await t.account.relayPass(ROOM);
    assert.ok(first.ok && first.fetched);
    const other = await t.account.relayPass(OTHER_ROOM);
    assert.ok(other.ok && other.fetched && other.pass !== first.pass, "a new room: fetched, though the old pass has 7 days left");
    assert.deepEqual(
      t.server.to("relayPass").map((c) => c.body),
      [{ room: ROOM }, { room: OTHER_ROOM }],
    );
    // Held for the new room from then on.
    const held = await t.account.relayPass(OTHER_ROOM);
    assert.ok(held.ok && !held.fetched && held.pass === other.pass);
    // The server out of reach as the room changes: no pass (the one held is for the other room).
    t.server.answer("relayPass", "drop");
    const away = await t.account.relayPass(ROOM);
    assert.equal(away.ok, false);
  });

  test("signed out on this Mac: none asked for", async () => {
    const t = await accountWith({}, { signedIn: false });
    assert.deepEqual(await t.account.relayPass(ROOM), { ok: false, why: "not-signed-in" });
    assert.equal(t.server.to("relayPass").length, 0);
  });
});

describe("the offer, carried out (app/phone-offer.ts)", () => {
  const run = async (t: { account: Account }, pick: "trial" | "month" | "year") => {
    const steps: PlanStep[] = [];
    const opened: string[] = [];
    const end = await planForPhone(pick, {
      account: t.account,
      open: async (url) => (opened.push(url), true),
      show: (s) => void steps.push(s),
      phones: () => 0,
      signal: new AbortController().signal,
    });
    return { end, steps, opened };
  };

  test("signed out, the free trial: signed in (the code shown, the page opened), the trial started, then on to the QR code", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ plan: "none" }) }), sessionAnswer({ plan: planJson({ daysLeft: 7 }) })], trial: [trialStarted()] }, { signedIn: false });
    const r = await run(t, "trial");
    assert.deepEqual(r.end, { ok: true });
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["sign-in", "sign-in", "trial"],
    );
    assert.equal(r.steps[1].code, "ABCD-EFGH");
    assert.equal(r.opened[0], "https://account.kiko.sh/device?user_code=ABCD-EFGH");
    assert.equal(t.server.to("trial").length, 1);
  });

  test("the trial used already: its words, no pairing", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ ended: "time" }) })], trial: [trialRefused("trial_used")] });
    const r = await run(t, "trial");
    assert.equal(r.end.ok, false);
    assert.match((r.end as { said: string }).said, /has already used its free trial/);
  });

  test("Kiko Pro, yearly: the checkout opened, the payment waited for, then on to the QR code", async () => {
    const none = sessionAnswer({ plan: planJson({ plan: "none" }) });
    const t = await accountWith({ session: [none, none, sessionAnswer({ plan: proJson({ interval: "year" }) })], checkout: [billingPage()] });
    const r = await run(t, "year");
    assert.deepEqual(r.end, { ok: true });
    assert.deepEqual(
      t.server.to("checkout").map((c) => c.body),
      [{ interval: "year" }],
    );
    assert.deepEqual(r.opened, ["https://checkout.stripe.com/c/pay/cs_test_kiko"]);
    assert.deepEqual(
      r.steps.map((s) => s.step),
      ["checkout", "waiting"],
    );
  });

  test("Pro already (bought elsewhere): straight on, nothing bought", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: proJson() })] });
    const r = await run(t, "month");
    assert.deepEqual(r.end, { ok: true });
    assert.equal(t.server.to("checkout").length, 0);
  });

  test("Esc: stopped, nothing said", async () => {
    const t = await accountWith({ session: [sessionAnswer({ plan: planJson({ plan: "none" }) })] });
    const stop = new AbortController();
    const end = await planForPhone("month", {
      account: t.account,
      open: async () => (stop.abort(), true),
      show: () => {},
      phones: () => 0,
      signal: stop.signal,
    });
    assert.deepEqual(end, { ok: false, said: null });
  });
});
