// `kiko uninstall` and the Kiko account (src/uninstall.ts accountLines, accountSignOut, phoneLines,
// realUninstallDeps): the list of what goes names this Mac's sign-in (accounts open), and each paired
// phone, unpaired (pair it again after a reinstall), accounts open or not; then
// this Mac is signed out on the server (POST /logout, best effort) before its token goes; offline,
// down or too slow (a short wait), one dim line and on, the token gone all the same. Against a fake
// account server on a port of its own and a store in memory: never the real server or the Keychain.
// Nothing here removes any of Kiko's files (the whole uninstall runs in install-live).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Account, SESSION_KEY } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { accountLines, accountSignOut, phoneLines, realUninstallDeps, SIGN_OUT_MS } from "../../../src/uninstall.ts";
import { styleOf } from "../../../src/ui/cli-style.ts";
import { EMAIL, fakeAccountServer, happyScript, memoryStore, SESSION_TOKEN } from "../../support/fake-account.ts";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setUp(o: { signedIn?: boolean; callMs?: number } = {}) {
  const server = await fakeAccountServer(happyScript());
  servers.push(server);
  const mem = memoryStore();
  const account = new Account({
    store: mem.store,
    client: accountClient(server.url, { callMs: o.callMs ?? SIGN_OUT_MS }),
    file: join(mkdtempSync(join(tmpdir(), "acct-uninstall-")), "account.json"),
    sleep: async () => {},
  });
  if (o.signedIn ?? true) {
    assert.equal((await account.signIn({ onCode: () => {} })).ok, true);
    server.calls.length = 0;
  }
  return { server, mem, account, a: { account } };
}

test("the list: this Mac's sign-in, who, and that it's signed out on kiko.sh too", async () => {
  const t = await setUp();
  assert.deepEqual(accountLines(t.a, true), [`  this Mac's sign-in to your Kiko account, ${EMAIL} (signed out on kiko.sh too; the account stays)`]);
  // In colour: the email bold, the aside dim.
  assert.match(accountLines(t.a, true, styleOf(true))[0], /\x1b\[1mname@example\.com\x1b\[22m \x1b\[2m\(signed out/);
});

test("the list: a paired phone is unpaired, to pair again after a reinstall; two said together; none, nothing said", () => {
  assert.deepEqual(phoneLines(["Alex's iPhone"]), ["    Alex's iPhone is unpaired: pair it again after you reinstall"]);
  assert.deepEqual(phoneLines(["iPhone", "iPad"]), ["    iPhone and iPad are unpaired: pair them again after you reinstall"]);
  assert.deepEqual(phoneLines([]), []);
  // In colour: each phone bold.
  assert.equal(phoneLines(["iPhone"], styleOf(true))[0], "    \x1b[1miPhone\x1b[22m is unpaired: pair it again after you reinstall");
});

describe("the real deps: the paired phones read with accounts off too; the account only with them on", () => {
  const was = { accounts: process.env.KIKO_ACCOUNTS, url: process.env.KIKO_ACCOUNT_URL };
  beforeEach(() => {
    // Never the real server (nothing here calls it: the client is only made).
    process.env.KIKO_ACCOUNT_URL = "http://127.0.0.1:9";
  });
  afterEach(() => {
    for (const [name, value] of [
      ["KIKO_ACCOUNTS", was.accounts],
      ["KIKO_ACCOUNT_URL", was.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const confirm = async () => false;

  test("accounts off, a phone paired: no account, and the phone listed", async () => {
    process.env.KIKO_ACCOUNTS = "0";
    const d = await realUninstallDeps(confirm, { phones: async () => ["Alex's iPhone"] });
    assert.equal(d.account, undefined);
    assert.deepEqual(d.phones, ["Alex's iPhone"]);
    assert.deepEqual(phoneLines(d.phones ?? []), ["    Alex's iPhone is unpaired: pair it again after you reinstall"]);
  });

  test("accounts off, no phone paired (or phones.json unreadable): none listed", async () => {
    process.env.KIKO_ACCOUNTS = "0";
    const none = await realUninstallDeps(confirm, { phones: async () => [] });
    assert.equal(none.account, undefined);
    assert.deepEqual(none.phones, []);
    assert.deepEqual(phoneLines(none.phones ?? []), []);
    const unreadable = await realUninstallDeps(confirm, {
      phones: async () => {
        throw new Error("phones.json: bad JSON");
      },
    });
    assert.deepEqual(unreadable.phones, []);
  });

  test("accounts on: the account, and the phones as well", async () => {
    process.env.KIKO_ACCOUNTS = "1";
    const d = await realUninstallDeps(confirm, { phones: async () => ["iPhone", "iPad"] });
    assert.ok(d.account?.account);
    assert.deepEqual(d.phones, ["iPhone", "iPad"]);
  });
});

test("the list: nobody signed in and no token, nothing said; a token without account.json, still listed", async () => {
  const t = await setUp({ signedIn: false });
  assert.deepEqual(accountLines(t.a, false), []);
  assert.deepEqual(accountLines(t.a, true), ["  this Mac's sign-in to your Kiko account (signed out on kiko.sh too; the account stays)"]);
});

test("signed out on the server first (POST /logout with the token), then the token out of the store", async () => {
  const t = await setUp();
  const r = await accountSignOut(t.a);
  assert.deepEqual(r, { lines: ["✓ This Mac is signed out of your Kiko account."], removed: true });
  assert.deepEqual(
    t.server.to("signOut").map((c) => c.bearer),
    [SESSION_TOKEN],
  );
  assert.equal(t.mem.kept[SESSION_KEY], undefined);
});

test("offline: one dim line with the account page, and the token gone all the same", async () => {
  const t = await setUp();
  await t.server.down();
  const r = await accountSignOut(t.a, styleOf(true));
  assert.equal(r.removed, true);
  assert.equal(r.lines.length, 1);
  assert.match(
    r.lines[0],
    /^\x1b\[2mCouldn't reach kiko\.sh to sign this Mac out there \(offline\? .*\): its session ends by itself, or sign it out on https:\/\/account\.kiko\.sh\/account\.\x1b\[22m$/,
  );
  assert.equal(t.mem.kept[SESSION_KEY], undefined);
});

test("a server that doesn't answer: given up on after the short wait, and on", async () => {
  const t = await setUp({ callMs: 150 });
  t.server.answer("signOut", "hang");
  const started = performance.now();
  const r = await accountSignOut(t.a);
  assert.ok(performance.now() - started < 2000, "not held up");
  assert.match(r.lines[0], /^Couldn't reach kiko\.sh to sign this Mac out there \(it didn't answer in time\)/);
  assert.equal(r.removed, true);
  assert.equal(t.mem.kept[SESSION_KEY], undefined);
  assert.ok(SIGN_OUT_MS <= 5000, "the real wait is short too");
});

test("a 5xx: the same dim line; the session already gone there (401 signed_out): signed out, nothing more said", async () => {
  const t = await setUp();
  t.server.answer("signOut", { status: 502, json: { error: "bad_gateway" } });
  assert.match((await accountSignOut(t.a)).lines[0], /^Couldn't reach kiko\.sh/);
  const u = await setUp();
  u.server.answer("signOut", { status: 401, json: { error: "signed_out" } });
  assert.deepEqual((await accountSignOut(u.a)).lines, ["✓ This Mac is signed out of your Kiko account."]);
});

test("the store can't remove the token: not removed, so uninstall's key step tries again", async () => {
  const server = await fakeAccountServer(happyScript());
  servers.push(server);
  const mem = memoryStore({}, {});
  const account = new Account({ store: mem.store, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "acct-uninstall-")), "account.json"), sleep: async () => {} });
  await account.signIn({ onCode: () => {} });
  mem.store.remove = async () => {
    throw new Error("the keychain helper failed (1)");
  };
  const r = await accountSignOut({ account });
  assert.equal(r.removed, false);
});
