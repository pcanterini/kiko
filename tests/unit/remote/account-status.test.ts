// The plan on the phone (src/remote/account-status.ts, protocol `account`): the Mac's plan and trial
// status as Settings → Account decides it (a running trial, Pro, a trial that ended, none, signed
// out), your own key said, nothing private in it, every one valid against the schema. Then through a
// real server with fake phones: sent right after welcome, to every phone when it changes and only
// then, and never while accounts are off.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { AccountView } from "../../../src/core/account/account.ts";
import type { Plan, Trial } from "../../../src/core/account/client.ts";
import { accountStatus, type AccountStatus } from "../../../src/remote/account-status.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { checkWaits } from "../../support/until.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12, 0);

const quota = (usedShare: number, period: "plan" | "month" = "plan") => ({ period, periodEnd: null, usedShare, dailyCap: false, dailyResetsAt: null, pastCap: "stop" as const });
const trialPlan = (endsAt: number, usedShare: number): Plan => ({ name: "trial", startedAt: endsAt - 7 * DAY, endsAt, quota: quota(usedShare) });
const signedIn = (plan: Plan | null, trial: Trial | null = null): AccountView => ({ state: "signed-in", email: "lacy@example.com", since: NOW - DAY, checkedAt: NOW, plan, trial });

/** Valid as the hub would send it. */
const valid = (s: AccountStatus | null) => {
  assert.ok(s);
  assert.equal(invalid({ v: 1, ...s }, "hub"), null, JSON.stringify(s));
  return s;
};

describe("the account status", () => {
  test("a running trial: its end, the share used, not ended", () => {
    const ends = NOW + 6 * DAY - 3600_000;
    assert.deepEqual(valid(accountStatus(signedIn(trialPlan(ends, 0.314), { startedAt: ends - 7 * DAY, endsAt: ends, ended: false, endedWhy: null }), false, NOW)), {
      type: "account",
      signedIn: true,
      ownKey: false,
      plan: "trial",
      endsAt: ends,
      usedPct: 31,
      ended: false,
      endedWhy: null,
    });
  });

  test("your own key in use: said, with the trial as it is (the phone shows the key, not the trial)", () => {
    const s = valid(accountStatus(signedIn(trialPlan(NOW + DAY, 0.1)), true, NOW));
    assert.equal(s.ownKey, true);
    assert.equal(s.plan, "trial");
  });

  test("Pro: this month's share", () => {
    const pro: Plan = { name: "pro", startedAt: NOW - 40 * DAY, endsAt: null, quota: quota(0.42, "month") };
    assert.deepEqual(valid(accountStatus(signedIn(pro), false, NOW)), { type: "account", signedIn: true, ownKey: false, plan: "pro", usedPct: 42 });
  });

  test("a trial that ended: its days ran out (by the server, or past its end as last known) or its usage was used up", () => {
    const ended = NOW - 2 * DAY;
    const byServer = valid(
      accountStatus(signedIn({ name: "none", startedAt: null, endsAt: null, quota: null }, { startedAt: ended - 7 * DAY, endsAt: ended, ended: true, endedWhy: "time" }), false, NOW),
    );
    assert.deepEqual([byServer.plan, byServer.ended, byServer.endedWhy, byServer.endsAt], ["trial", true, "time", ended]);
    // account.json still says the trial, but its end has passed: ended, as planLine says it.
    const pastEnd = valid(accountStatus(signedIn(trialPlan(ended, 0.5)), false, NOW));
    assert.deepEqual([pastEnd.plan, pastEnd.ended, pastEnd.endedWhy, pastEnd.usedPct], ["trial", true, "time", 50]);
    const cap = valid(accountStatus(signedIn(null, { startedAt: NOW - DAY, endsAt: NOW + 6 * DAY, ended: true, endedWhy: "cap" }), false, NOW));
    assert.deepEqual([cap.plan, cap.ended, cap.endedWhy], ["trial", true, "cap"]);
  });

  test("no plan, signed out, accounts off", () => {
    assert.deepEqual(valid(accountStatus(signedIn(null), false, NOW)), { type: "account", signedIn: true, ownKey: false, plan: "none" });
    assert.deepEqual(valid(accountStatus({ state: "signed-out", revoked: true }, true, NOW)), { type: "account", signedIn: false, ownKey: true, plan: "none" });
    assert.equal(accountStatus(null, false, NOW), null, "accounts off: nothing to send");
  });

  test("a share is said as a whole percentage, kept between 0 and 100", () => {
    assert.equal(valid(accountStatus(signedIn(trialPlan(NOW + DAY, 1.7)), false, NOW)).usedPct, 100);
    assert.equal(valid(accountStatus(signedIn(trialPlan(NOW + DAY, -0.2)), false, NOW)).usedPct, 0);
    assert.equal(valid(accountStatus(signedIn(trialPlan(NOW + DAY, 0.795)), false, NOW)).usedPct, 80);
  });

  test("nothing private: no email, no token", () => {
    const s = JSON.stringify(accountStatus(signedIn(trialPlan(NOW + DAY, 0.2)), false, NOW));
    assert.ok(!s.includes("lacy@example.com"));
    assert.ok(!/email|token/i.test(s));
  });
});

// ── Through a real server ───────────────────────────────────────────────────

const until = checkWaits(2000, 10);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    got,
    accounts: () => got.filter((m) => m.type === "account"),
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const hub: PhoneHub = {
  talkStart: () => null,
  talkAudio: () => {},
  talkEnd: () => {},
  type: () => null,
  permission: () => null,
  answers: () => null,
  talking: () => false,
  playOnMac: () => {},
  catchUp: () => {},
  catchUpSummary: () => {},
  catchUpStop: () => false,
};

async function serve(account: (() => AccountStatus | null) | undefined, file: string, accountCheckMs = 30) {
  const pairing = new Pairing(join(process.cwd(), file));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000, account, accountCheckMs });
  const port = await server.start();
  const signIn = async (device: string) => {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device, appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    return p;
  };
  return { server, signIn };
}

describe("the account status, through the phone server", () => {
  test("after welcome; to every phone when it changes, once; nothing while it stays the same", async () => {
    let status: AccountStatus = { type: "account", signedIn: true, ownKey: false, plan: "trial", endsAt: NOW + 6 * DAY, usedPct: 31, ended: false, endedWhy: null };
    const { server, signIn } = await serve(() => status, "phones-account.json");
    try {
      const a = await signIn("Phone A");
      await until(() => a.accounts().length === 1);
      const welcomeAt = a.got.findIndex((m) => m.type === "welcome");
      assert.ok(a.got.findIndex((m) => m.type === "account") > welcomeAt, "after welcome");
      assert.deepEqual(a.accounts()[0], { v: 1, ...status });
      const b = await signIn("Phone B");
      await until(() => b.accounts().length === 1);
      // Unchanged for several looks: nothing more to either.
      await wait(150);
      assert.equal(a.accounts().length, 1, "unchanged: not sent again");
      assert.equal(b.accounts().length, 1);

      // The share went up: both told, once.
      status = { ...status, usedPct: 82 };
      await until(() => a.accounts().length === 2 && b.accounts().length === 2);
      await wait(150);
      assert.deepEqual([a.accounts().length, b.accounts().length], [2, 2]);
      assert.equal(b.accounts()[1].usedPct, 82);

      // Your own key added: told at once when the app says so, without waiting for the next look.
      status = { ...status, ownKey: true };
      server.accountChanged();
      await until(() => a.accounts().length === 3 && b.accounts().length === 3);
      assert.equal(a.accounts()[2].ownKey, true);

      // A phone that reconnects gets it again after its welcome.
      await a.close();
      const pairedB = b.got.find((m) => m.type === "paired");
      const again = phone(server.port);
      await again.send({ type: "hello", token: pairedB.token, device: "Phone B", appVersion: "0.2.0" });
      await until(() => again.accounts().length === 1);
      assert.equal(again.accounts()[0].ownKey, true);
      await again.close();
      await b.close();
    } finally {
      server.stop();
    }
  });

  test("accounts off (or no reader): never sent", async () => {
    for (const [account, file] of [
      [() => null, "phones-account-off.json"],
      [undefined, "phones-account-none.json"],
    ] as const) {
      const { server, signIn } = await serve(account, file);
      try {
        const p = await signIn("Phone");
        await wait(150);
        server.accountChanged();
        await wait(50);
        assert.equal(p.accounts().length, 0);
        await p.close();
      } finally {
        server.stop();
      }
    }
  });

  test("a reader that throws sends nothing and keeps the connection", async () => {
    const { server, signIn } = await serve(() => {
      throw new Error("account.json unreadable");
    }, "phones-account-throws.json");
    try {
      const p = await signIn("Phone");
      await wait(100);
      assert.equal(p.accounts().length, 0);
      assert.ok(p.got.some((m) => m.type === "welcome"));
      await p.close();
    } finally {
      server.stop();
    }
  });
});
