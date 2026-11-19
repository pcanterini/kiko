// The iPhone app and the plan in the running app (src/app/phone-plan.ts, app/phone.ts phoneRows),
// from account.json as the app's account reads it (no server, no Keychain: KIKO_KEYCHAIN is off):
// Pair a phone's PRO badge and offer without Pro or the trial, none with either or with Pro off sale;
// the phone server's connect check (null off sale: everyone in); the once-a-day line when a paired
// phone was turned away; the phone's `account` message saying whether the plan includes it.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, test } from "node:test";
import { ACCOUNT_FILE, type AccountView } from "../../../src/core/account/account.ts";
import { appAccount } from "../../../src/core/account/app-account.ts";
import { PHONE_WORDS } from "../../../src/core/account/phone-plan.ts";
import { phoneRows } from "../../../src/app/phone.ts";
import { phoneIncludedNow, phonePlanNow, phoneRefused, resetPhonePlanForTests } from "../../../src/app/phone-plan.ts";
import { accountStatus } from "../../../src/remote/account-status.ts";

const DAY = 86_400_000;
const NOW = Date.now();

afterEach(() => {
  delete process.env.KIKO_ACCOUNTS;
  process.env.KIKO_PRO = "0";
  rmSync(ACCOUNT_FILE, { force: true });
  resetPhonePlanForTests();
});

/** account.json as the app keeps it: signed in with this plan (null: signed out). */
function saved(plan: "none" | "trial" | "pro" | null, o: { checkedAt?: number; endsAt?: number | null; trialEnded?: boolean } = {}) {
  mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
  if (plan === null) return writeFileSync(ACCOUNT_FILE, "{}\n");
  const endsAt = o.endsAt === undefined ? (plan === "trial" ? NOW + 5 * DAY : null) : o.endsAt;
  writeFileSync(
    ACCOUNT_FILE,
    JSON.stringify({
      email: "lacy@example.com",
      since: NOW - 30 * DAY,
      checkedAt: o.checkedAt ?? NOW,
      plan: { name: plan, startedAt: NOW - 2 * DAY, endsAt, quota: null },
      trial: o.trialEnded ? { startedAt: NOW - 9 * DAY, endsAt: NOW - 2 * DAY, ended: true, endedWhy: "time" } : null,
    }),
  );
}

const onSale = () => {
  process.env.KIKO_ACCOUNTS = "1";
  process.env.KIKO_PRO = "1";
};
const pairRow = () => phoneRows().find((r) => r.key === "phonePair")!;

describe("Settings → Phone → Pair a phone", () => {
  test("Pro on sale, no plan: the PRO badge, the offer as its note, the trial offered while it can start", () => {
    onSale();
    saved("none");
    const row = pairRow();
    assert.equal(row.tag, "PRO");
    assert.equal(row.note, PHONE_WORDS.offer);
    assert.deepEqual(JSON.parse(String(row.raw)), { offer: true, trial: true });
    saved("none", { trialEnded: true });
    assert.deepEqual(JSON.parse(String(pairRow().raw)), { offer: true, trial: false }, "the trial used: only Pro");
    saved(null);
    assert.equal(pairRow().tag, "PRO", "signed out");
  });

  test("with the trial or Pro: no badge, the QR code", () => {
    onSale();
    for (const plan of ["trial", "pro"] as const) {
      saved(plan);
      const row = pairRow();
      assert.equal(row.tag, undefined, plan);
      assert.equal(row.raw, "");
    }
  });

  test("Pro not on sale (accounts on or off): pairing and the phone free, as today", () => {
    for (const accounts of ["1", undefined]) {
      if (accounts) process.env.KIKO_ACCOUNTS = accounts;
      saved("none");
      assert.equal(pairRow().tag, undefined);
      assert.equal(pairRow().raw, "");
      assert.equal(phonePlanNow(), null, "no connect check: every phone gets in");
      assert.equal(phoneIncludedNow(), true);
    }
  });
});

describe("the connect check and the Mac's line", () => {
  test("from account.json: in with a plan, out without, 7 days of grace after the last check", () => {
    onSale();
    saved("pro");
    assert.deepEqual(phonePlanNow(), { ok: true });
    saved("none");
    assert.deepEqual(phonePlanNow(), { ok: false, trialAvailable: true, reason: "no_plan" });
    saved("pro", { endsAt: NOW - DAY, checkedAt: NOW - 2 * DAY });
    assert.deepEqual(phonePlanNow(), { ok: true }, "lapsed since the last check, the server out of reach: grace");
    saved("pro", { endsAt: NOW - 9 * DAY, checkedAt: NOW - 8 * DAY });
    assert.deepEqual(phonePlanNow(), { ok: false, trialAvailable: false, reason: "pro_ended" });
    saved(null);
    assert.deepEqual(phonePlanNow(), { ok: false, trialAvailable: true, reason: "mac_signed_out" }, "signed out: the Mac's, not the plan's");
  });

  test("signed out: \"Press Enter to sign in\" with the window's popup asked, once a day, apart from the plan's line", () => {
    onSale();
    saved(null);
    const said: string[] = [];
    let asked = 0;
    const o = { say: (line: string) => void said.push(line), recheck: () => {}, ask: () => (asked++, true) };
    phoneRefused(true, { reason: "mac_signed_out", now: NOW, ...o });
    phoneRefused(true, { reason: "mac_signed_out", now: NOW + 60_000, ...o });
    assert.equal(said.length, 1, "once a day");
    assert.match(said[0], /^Your phone can't connect: this Mac is signed out of Kiko( Dev)?\. Press Enter to sign in\.$/);
    assert.equal(asked, 1, "the popup asked once");
    // No window to ask in: where to sign in instead.
    resetPhonePlanForTests();
    phoneRefused(true, { reason: "mac_signed_out", now: NOW, ...o, ask: () => false });
    assert.match(said[1], /Sign in: Settings → Kiko( Dev)? account, or kiko(-dev)? login\.$/);
    // Signed in, no plan: its own line, said although the signed-out one was just said.
    saved("none");
    phoneRefused(true, { reason: "no_plan", now: NOW + 120_000, ...o });
    assert.equal(said.length, 3);
    assert.match(said[2], /The iPhone app comes with Kiko( Dev)? Pro, or the free trial/);
  });

  test("a paired phone turned away: said once a day at most (kiko setup while the trial can start, else kiko upgrade), kept across runs", () => {
    onSale();
    saved("none");
    const said: string[] = [];
    let rechecks = 0;
    const o = { say: (line: string) => void said.push(line), recheck: () => void rechecks++ };
    phoneRefused(true, { now: NOW, ...o });
    phoneRefused(true, { now: NOW + 30_000, ...o });
    phoneRefused(true, { now: NOW + DAY - 1, ...o });
    assert.equal(rechecks, 2, "the plan asked again, once a minute at most");
    assert.equal(said.length, 1);
    assert.match(said[0], /^Your phone tried to connect\. The iPhone app comes with Kiko Pro, or the free trial: kiko(-dev)? setup\.$/);
    // Another run (nothing in memory): account.json says it was said.
    resetPhonePlanForTests();
    phoneRefused(true, { now: NOW + 2 * 60_000, ...o });
    assert.equal(said.length, 1);
    phoneRefused(false, { now: NOW + DAY, ...o });
    assert.equal(said.length, 2);
    assert.match(said[1], /The iPhone app comes with Kiko Pro: kiko(-dev)? upgrade\.$/);
    assert.equal(appAccount()?.lastSaid("phone-refused"), NOW + DAY);
  });
});

describe("the phone's account message", () => {
  const view: AccountView = { state: "signed-in", email: null, since: NOW - DAY, checkedAt: NOW, plan: { name: "none", startedAt: null, endsAt: null, quota: null }, trial: null };
  test("phoneApp while Pro is on sale (included or needs_pro); not said otherwise", () => {
    assert.equal(accountStatus(view, false, NOW, { phone: false })?.phoneApp, "needs_pro");
    assert.equal(accountStatus(view, false, NOW, { phone: true })?.phoneApp, "included");
    assert.equal(accountStatus(view, false, NOW)?.phoneApp, undefined);
    assert.equal(accountStatus(view, false, NOW, { phone: false })?.phoneAppReason, "no_plan");
    assert.equal(accountStatus(view, false, NOW, { phone: true })?.phoneAppReason, undefined);
    assert.deepEqual(accountStatus({ state: "signed-out", revoked: true }, false, NOW, { phone: false }), {
      type: "account",
      signedIn: false,
      ownKey: false,
      plan: "none",
      phoneApp: "needs_pro",
      phoneAppReason: "mac_signed_out",
    });
  });
});
