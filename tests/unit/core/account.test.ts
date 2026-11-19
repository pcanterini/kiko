// This Mac's account (src/core/account/): the device code flow against a fake account API on a
// port of its own (tests/support/fake-account.ts, the account service's API.md shapes), the session
// token kept in a store in memory (never the Keychain), and never signed out by accident: only the
// server's `401 signed_out` signs out; the network down, a timeout, a 5xx, any other 401 or a captive
// portal never do. Nothing reaches the real server, the network or ~/.config.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Account, MAX_MISSES, NewCode, REFRESH_EARLY_MS, type Renewed, SESSION_KEY, SIGN_IN_FOR_MS, SIGNED_OUT_LINE, UNREACHABLE_WAITS_MS } from "../../../src/core/account/account.ts";
import { type AccountClient, accountClient, CLIENT_ID, type DevicePoll, macosVersion, type DeviceStart } from "../../../src/core/account/client.ts";
import { accountsLive, accountUrl } from "../../../src/core/env.ts";
import { checkWaits } from "../../support/until.ts";
import { codeRefused, planJson, trialRefused, trialStarted } from "../../support/fake-account.ts";
import { NEAR_END, planActive, planBadge, planBrief, planLine, planFacts, planStatus, reminderNotice, trialRefusedLine, trialStartedLine } from "../../../src/core/account/plan-words.ts";
import { type Answer, EMAIL, fakeAccountServer, fakeJwt, happyScript, memoryStore, PENDING, SESSION_TOKEN, sessionAnswer, SIGNED_OUT, USER_CODE } from "../../support/fake-account.ts";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** A fake server, an account on it with a store in memory, a file of its own, a clock the test moves, and waits that don't wait. */
async function setUp(o: { store?: ReturnType<typeof memoryStore> } = {}) {
  const server = await fakeAccountServer(happyScript());
  servers.push(server);
  const mem = o.store ?? memoryStore();
  const file = join(mkdtempSync(join(tmpdir(), "acct-")), "account.json");
  let now = 1_800_000_000_000;
  const waits: number[] = [];
  const logged: string[] = [];
  const account = new Account({
    store: mem.store,
    client: accountClient(server.url, { now: () => now, callMs: 2000 }),
    file,
    now: () => now,
    sleep: async (ms, signal) => {
      waits.push(ms);
      if (signal?.aborted) throw new Error("aborted");
      await new Promise((r) => setImmediate(r));
    },
    log: (event, data) => void logged.push(`${event} ${JSON.stringify(data)}`),
  });
  const codes: DeviceStart[] = [];
  const signIn = (signal?: AbortSignal) => account.signIn({ onCode: (c) => void codes.push(c), signal });
  return { server, mem, file, account, waits, logged, codes, signIn, tick: (ms: number) => (now += ms), now: () => now };
}

/** Nothing of the token in what's kept on disk, or the log. */
function noTokenLeaks(t: { file: string; logged: string[] }) {
  if (existsSync(t.file)) assert.doesNotMatch(readFileSync(t.file, "utf8"), /sess-test/);
  assert.ok(!t.logged.some((l) => l.includes("sess-test")), "no token in the log");
  assert.ok(!t.logged.some((l) => l.includes(EMAIL)), "no email in the log");
}

const approved = (account?: object): Answer => ({ json: { access_token: SESSION_TOKEN, token_type: "Bearer", expires_in: 7776000, scope: "", ...(account ? { account } : {}) } });
const error = (code: string, status = 400): Answer => ({ status, json: { error: code } });

describe("the switch and the address", () => {
  test("accounts are open (name.ts ACCOUNTS_LIVE); KIKO_ACCOUNTS=0 turns them off, 1 on", () => {
    assert.equal(accountsLive({}), true, "open in a release: name.ts ACCOUNTS_LIVE is true");
    assert.equal(accountsLive({ KIKO_ACCOUNTS: "1" }), true);
    assert.equal(accountsLive({ KIKO_ACCOUNTS: "0" }), false);
  });

  test("the API's address: api.kiko.sh/v1, or KIKO_ACCOUNT_URL", () => {
    assert.equal(accountUrl({}), "https://api.kiko.sh/v1");
    assert.equal(accountUrl({ KIKO_ACCOUNT_URL: "http://127.0.0.1:9999/v1/" }), "http://127.0.0.1:9999/v1");
  });

  test("the User-Agent's macOS version, from Darwin's", () => {
    assert.equal(macosVersion("24.6.0", "darwin"), "15");
    assert.equal(macosVersion("25.1.0", "darwin"), "26");
    assert.equal(macosVersion("20.0.0", "darwin"), "11");
    assert.equal(macosVersion("6.8.0", "linux"), null);
  });
});

describe("signing in (the device code flow)", () => {
  test("pending, then approved: the code shown, the token kept in the store, who it is in account.json (no token there)", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING, PENDING, approved({ id: "3kq9", email: EMAIL }));
    const r = await t.signIn();
    assert.deepEqual(r, { ok: true, email: EMAIL });
    assert.equal(t.codes[0].userCode, USER_CODE);
    assert.equal(t.codes[0].verificationUriComplete, `https://account.kiko.sh/device?user_code=${USER_CODE}`);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    assert.equal(SESSION_KEY, "KIKO_ACCOUNT_SESSION");
    assert.equal(t.server.to("token").length, 3);
    assert.deepEqual(t.waits, [1000, 1000, 1000], "the server's interval, before the first poll and between them");
    // RFC 8628's grant, as a public client: the client id, no secret; the User-Agent API.md asks for.
    assert.equal(CLIENT_ID, "kiko-cli");
    assert.deepEqual(t.server.to("code")[0].body, { client_id: CLIENT_ID });
    assert.deepEqual(t.server.to("token")[0].body, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev-code-1", client_id: CLIENT_ID });
    assert.match(t.server.to("code")[0].agent, /^Kiko\/\d+\.\d+\.\d+( \(macOS \d+\))?$/);
    assert.equal(t.server.to("session").length, 0, "the approval said who it is");
    const view = t.account.view();
    assert.equal(view.state === "signed-in" && view.email, EMAIL);
    noTokenLeaks(t);
  });

  test("an approval that doesn't say who: asked with the session token", async () => {
    const t = await setUp();
    t.server.answer("token", approved());
    assert.deepEqual(await t.signIn(), { ok: true, email: EMAIL });
    assert.equal(t.server.to("session")[0].bearer, SESSION_TOKEN);
  });

  test("slow_down: 5 seconds more for every later poll (RFC 8628 §3.5)", async () => {
    const t = await setUp();
    t.server.answer("token", error("slow_down"), error("slow_down"), PENDING, approved());
    assert.equal((await t.signIn()).ok, true);
    assert.deepEqual(t.waits, [1000, 6000, 11000, 11000]);
  });

  test("429 while polling: its Retry-After, then slow_down's 5 seconds more", async () => {
    const t = await setUp();
    t.server.answer("token", { status: 429, json: { error: "rate_limited" }, headers: { "retry-after": "7" } }, approved());
    assert.equal((await t.signIn()).ok, true);
    assert.deepEqual(t.waits, [1000, 7000, 6000]);
  });

  test("denied in the browser: said, nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", error("access_denied"));
    const r = await t.signIn();
    assert.equal(!r.ok && r.why, "denied");
    assert.match(!r.ok ? r.said : "", /denied in the browser\. Nothing changed\./);
    assert.deepEqual(t.mem.kept, {});
    assert.equal(t.account.view().state, "signed-out");
  });

  test("expired: expired_token or invalid_grant from the server, or the code's own time running out here", async () => {
    for (const code of ["expired_token", "invalid_grant"]) {
      const t = await setUp();
      t.server.answer("token", error(code));
      const r = await t.signIn();
      assert.equal(!r.ok && r.why, "expired", code);
      assert.match(!r.ok ? r.said : "", /kiko-dev login gives you a new one/);
    }
    // The deadline passing with the server still saying pending.
    const u = await setUp();
    u.server.answer("token", PENDING);
    const r = await u.account.signIn({ onCode: () => void u.tick(601_000) });
    assert.equal(!r.ok && r.why, "expired");
    assert.equal(u.server.to("token").length, 0, "not polled once it's run out");
    assert.deepEqual(u.mem.kept, {});
  });

  test("a bug's answer (invalid_client): said, nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", error("invalid_client"));
    const r = await t.signIn();
    assert.equal(!r.ok && r.why, "refused");
    assert.deepEqual(t.mem.kept, {});
  });

  test("the network down mid-poll: a blip is waited out; gone for good, it gives up with nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING, "drop", { status: 503, html: "<h1>Bad gateway</h1>" }, approved());
    assert.equal((await t.signIn()).ok, true, "two misses, then approved");
    const u = await setUp();
    u.server.answer("token", PENDING);
    const r = await u.account.signIn({
      onCode: () => {
        // The server goes away once the code is shown.
        void u.server.down();
      },
    });
    assert.equal(!r.ok && r.why, "unreachable");
    assert.match(!r.ok ? r.said : "", /Lost touch with kiko\.sh .*Nothing changed: kiko-dev login tries again\./);
    assert.equal(u.waits.length, MAX_MISSES);
    assert.deepEqual(u.mem.kept, {});
  });

  test("the server down before any code: said, nothing kept", async () => {
    const t = await setUp();
    await t.server.down();
    const r = await t.signIn();
    assert.equal(!r.ok && r.why, "unreachable");
    assert.match(!r.ok ? r.said : "", /Couldn't reach kiko\.sh/);
    assert.equal(t.codes.length, 0);
  });

  test("cancelled (Ctrl+C, Esc): stops waiting, nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING);
    const stop = new AbortController();
    const r = await t.account.signIn({ onCode: () => stop.abort(), signal: stop.signal });
    assert.equal(!r.ok && r.why, "cancelled");
    assert.deepEqual(t.mem.kept, {});
  });

  test("stopped while a poll was out that came back approved: nothing kept, the session let go; approved in time: onApproved, then kept", async () => {
    const t = await setUp();
    t.server.answer("token", approved({ id: "3kq9", email: EMAIL }));
    const stop = new AbortController();
    const real = accountClient(t.server.url);
    // Stop pressed while the poll is out: the abort lands between asking and the answer.
    const client = { ...real, deviceToken: async (code: string) => await real.deviceToken(code).finally(() => stop.abort()) };
    const file = join(mkdtempSync(join(tmpdir(), "acct-")), "account.json");
    const a = new Account({ store: t.mem.store, client, file, sleep: async () => {} });
    let told = 0;
    const r = await a.signIn({ onCode: () => {}, signal: stop.signal, onApproved: () => told++ });
    assert.equal(!r.ok && r.why, "cancelled");
    assert.equal(told, 0);
    assert.deepEqual(t.mem.kept, {});
    assert.equal(a.view().state, "signed-out");
    await checkWaits(5000)(() => t.server.to("signOut").length, "the session let go");
    assert.equal(t.server.to("signOut")[0]?.bearer, SESSION_TOKEN, "the approved session let go on the server");

    const order: string[] = [];
    const set = t.mem.store.set.bind(t.mem.store);
    t.mem.store.set = async (name, key) => (order.push("kept"), set(name, key));
    assert.deepEqual(await t.account.signIn({ onCode: () => {}, onApproved: () => order.push("approved") }), { ok: true, email: EMAIL });
    assert.deepEqual(order, ["approved", "kept"]);
  });

  test("the store can't keep it: not signed in, and the server's session let go", async () => {
    const mem = memoryStore({}, { failSet: `the Keychain is locked (${SESSION_TOKEN})` });
    const t = await setUp({ store: mem });
    const r = await t.signIn();
    assert.equal(!r.ok && r.why, "save-failed");
    assert.doesNotMatch(!r.ok ? r.said : "", /sess-test/, "never the token, even in the store's error");
    assert.equal(t.account.view().state, "signed-out");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.server.to("signOut").length, 1);
  });

  test("no store (KIKO_KEYCHAIN=off): refused before anything is asked", async () => {
    const server = await fakeAccountServer();
    servers.push(server);
    const account = new Account({ store: null, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "acct-")), "account.json") });
    const r = await account.signIn({ onCode: () => {} });
    assert.equal(!r.ok && r.why, "no-keychain");
    assert.equal(server.calls.length, 0);
  });
});

/**
 * A patient sign-in (setup, `kiko login`) against a fake client and a fake clock: each wait moves
 * the clock on by its length, at once. `codes` answers each deviceCode in turn (the last again),
 * `polls` each deviceToken (the last again); either can be a function, called with the clock.
 */
function patientSetUp(o: { codes?: (CodeAnswer | ((now: number) => CodeAnswer))[]; polls?: (DevicePoll | ((now: number, code: string) => DevicePoll))[] } = {}) {
  let now = 1_800_000_000_000;
  const begun = now;
  const waits: number[] = [];
  const logged: string[] = [];
  const reach: boolean[] = [];
  const shown: { code: string; renewed?: Renewed }[] = [];
  const polled: string[] = [];
  const signedOut: string[] = [];
  // Codes asked for (each answer in turn), and given (numbered: CODE-1, dev-1…).
  let asked = 0;
  let given = 0;
  const codes = o.codes ?? [{ kind: "ok" }];
  const polls = o.polls ?? [{ kind: "pending" }];
  const pick = <T>(list: T[], i: number) => list[Math.min(i, list.length - 1)];
  const client = {
    async deviceCode() {
      const a = pick(codes, asked++);
      const answer = typeof a === "function" ? a(now) : a;
      if (answer.kind !== "ok") return answer;
      given++;
      return { deviceCode: `dev-${given}`, userCode: `CODE-${given}`, verificationUri: "https://account.kiko.sh/device", verificationUriComplete: null, interval: 5, expiresIn: 600, ...answer };
    },
    async deviceToken(code: string) {
      polled.push(code);
      const a = pick(polls, polled.length - 1);
      return typeof a === "function" ? a(now, code) : a;
    },
    async signOut(token: string) {
      signedOut.push(token);
      return { kind: "ok" as const };
    },
    async session() {
      return { kind: "unreachable" as const, why: "not asked in these tests" };
    },
  } as unknown as AccountClient;
  const mem = memoryStore();
  const account = new Account({
    store: mem.store,
    client,
    file: join(mkdtempSync(join(tmpdir(), "acct-patient-")), "account.json"),
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      waits.push(ms);
      now += ms;
      await new Promise((r) => setImmediate(r));
      if (signal?.aborted) throw new Error("aborted");
    },
    log: (event, data) => void logged.push(`${event} ${JSON.stringify(data)}`),
  });
  const newCode = new NewCode();
  const signIn = (x: { signal?: AbortSignal; onCode?: (code: string, renewed?: Renewed) => void } = {}) =>
    account.signIn({
      signal: x.signal,
      patient: { newCode, onReach: (ok) => void reach.push(ok) },
      onCode: (start, renewed) => {
        shown.push(renewed ? { code: start.userCode, renewed } : { code: start.userCode });
        x.onCode?.(start.userCode, renewed);
      },
    });
  return { account, mem, waits, logged, reach, shown, polled, signedOut, newCode, signIn, elapsed: () => now - begun, given: () => given };
}
type CodeAnswer = { kind: "ok"; expiresIn?: number; interval?: number } | { kind: "unreachable"; why: string } | { kind: "refused"; why: string };
const APPROVED: DevicePoll = { kind: "approved", token: SESSION_TOKEN, email: EMAIL };
const DOWN = { kind: "unreachable" as const, why: "fetch failed" };

describe("a patient sign-in (setup, kiko login): it keeps going while you're there", () => {
  test("a code that runs out here is replaced, said as ran out; approved on the new one", async () => {
    // The first code ran out (10 minutes of pending), then the second one approved.
    const t = patientSetUp({ polls: [(_now, code) => (code === "dev-2" ? APPROVED : { kind: "pending" })] });
    const r = await t.signIn();
    assert.deepEqual(r, { ok: true, email: EMAIL });
    assert.deepEqual(t.shown, [{ code: "CODE-1" }, { code: "CODE-2", renewed: "ran-out" }]);
    assert.ok(t.elapsed() >= 600_000, "the first code waited out its 10 minutes");
    assert.ok(!t.polled.slice(t.polled.indexOf("dev-2")).includes("dev-1"), "the old code never polled again");
    assert.ok(t.logged.includes('account_sign_in {"code":"ran-out","renewed":1,"asked":0,"outages":0}'));
    assert.ok(t.logged.includes('account_sign_in {"ended":"signed-in","renewed":1,"asked":0,"outages":0}'));
    assert.ok(!t.logged.some((l) => l.includes("CODE-") || l.includes("dev-") || l.includes(SESSION_TOKEN) || l.includes(EMAIL)), "never a code, a token or the email in the log");
  });

  test("expired_token from the server: a new code at once; invalid_grant mid-way is a used code (ended), at its very end a run-out one", async () => {
    const t = patientSetUp({ polls: [{ kind: "pending" }, { kind: "expired" }, APPROVED] });
    assert.equal((await t.signIn()).ok, true);
    assert.deepEqual(
      t.shown.map((s) => s.renewed),
      [undefined, "ran-out"],
    );
    assert.deepEqual(t.polled, ["dev-1", "dev-1", "dev-2"]);

    const used = patientSetUp({ polls: [{ kind: "pending" }, { kind: "used" }] });
    const r = await used.signIn();
    assert.equal(!r.ok && r.why, "used");
    assert.match(!r.ok ? r.said : "", /That code was used already, or isn't known\. Nothing changed: kiko(-dev)? login starts again\./);
    assert.deepEqual(used.mem.kept, {});

    // invalid_grant in the code's last interval: it's gone from the server as it ran out, so a new one.
    const late = patientSetUp({ codes: [{ kind: "ok", expiresIn: 12 }], polls: [{ kind: "pending" }, { kind: "used" }, APPROVED] });
    assert.equal((await late.signIn()).ok, true);
    assert.deepEqual(
      late.shown.map((s) => s.renewed),
      [undefined, "ran-out"],
    );
  });

  test("n (NewCode): the wait cut short, a fresh code at once (said as asked), the old one let go", async () => {
    // n pressed while the first code is waited for: as its second poll is out, so it's taken by the wait after.
    const t: ReturnType<typeof patientSetUp> = patientSetUp({
      polls: [
        (_now, code) => {
          if (code === "dev-1" && t.polled.length === 2) t.newCode.ask();
          return code === "dev-2" ? APPROVED : { kind: "pending" };
        },
      ],
    });
    const r = await t.signIn();
    assert.deepEqual(r, { ok: true, email: EMAIL });
    assert.deepEqual(t.polled, ["dev-1", "dev-1", "dev-2"], "the old code not polled again");
    assert.deepEqual(t.shown, [{ code: "CODE-1" }, { code: "CODE-2", renewed: "asked" }]);
    assert.ok(t.elapsed() < 600_000, "long before the first code ran out");
    assert.equal(t.polled.at(-1), "dev-2");
    assert.ok(t.logged.some((l) => l.startsWith('account_sign_in {"code":"asked","renewed":0,"asked":1')));
    // Asked between waits: taken at the next one.
    const u = patientSetUp({ polls: [(_now, code) => (code === "dev-2" ? APPROVED : { kind: "pending" })] });
    assert.equal((await u.signIn({ onCode: (code) => code === "CODE-1" && u.newCode.ask() })).ok, true);
    assert.deepEqual(u.polled, ["dev-2"], "the first code never polled: a new one asked for before its first wait was through");
  });

  test("the server out of reach before any code: still trying (said once), longer waits, then the code once it's back", async () => {
    const t = patientSetUp({ codes: [DOWN, DOWN, DOWN, DOWN, { kind: "ok" }], polls: [APPROVED] });
    assert.deepEqual(await t.signIn(), { ok: true, email: EMAIL });
    assert.deepEqual(t.reach, [false, true], "said as it went, and as it came back");
    assert.deepEqual(t.waits.slice(0, 4), [2000, 4000, 8000, 15_000]);
    assert.deepEqual(t.shown, [{ code: "CODE-1" }], "the code shown once it was given");
    assert.ok(t.logged.includes('account_sign_in {"unreachable":"fetch failed"}'));
    assert.ok(t.logged.includes('account_sign_in {"ended":"signed-in","renewed":0,"asked":0,"outages":1}'));
  });

  test("the server out of reach mid-wait: never given up for misses (well past MAX_MISSES), the waits capped; back, the same code goes on", async () => {
    const down = Array.from({ length: MAX_MISSES * 2 }, () => DOWN);
    const t = patientSetUp({ polls: [{ kind: "pending" }, ...down, APPROVED] });
    assert.deepEqual(await t.signIn(), { ok: true, email: EMAIL });
    assert.deepEqual(t.reach, [false, true]);
    assert.equal(Math.max(...t.waits), 30_000, "the longest wait 30 seconds");
    assert.deepEqual(t.waits.slice(2, 7), [5000, 5000, 8000, 15_000, 30_000], "the interval at least, longer with each miss");
    assert.deepEqual(t.shown, [{ code: "CODE-1" }]);
  });

  test("the code running out while the server is out of reach: a new one once it's back", async () => {
    // Down from the second poll until 12 minutes in; the first code (10 minutes) ran out meanwhile.
    const t = patientSetUp({
      codes: [{ kind: "ok" }, (now) => (now - 1_800_000_000_000 < 720_000 ? DOWN : { kind: "ok" })],
      polls: [{ kind: "pending" }, (now, code) => (code === "dev-2" ? APPROVED : now - 1_800_000_000_000 < 720_000 ? DOWN : { kind: "pending" })],
    });
    assert.deepEqual(await t.signIn(), { ok: true, email: EMAIL });
    assert.deepEqual(t.shown, [{ code: "CODE-1" }, { code: "CODE-2", renewed: "ran-out" }]);
    assert.deepEqual(t.reach, [false, true]);
  });

  test("30 minutes in all: codes renewed until then, then it stops (said, nothing kept); out of reach at the end, said so", async () => {
    const t = patientSetUp();
    const r = await t.signIn();
    assert.equal(!r.ok && r.why, "timed-out");
    assert.equal(!r.ok && r.offline, undefined);
    assert.match(!r.ok ? r.said : "", /Stopped waiting: no sign-in in 30 minutes\. Nothing changed: kiko(-dev)? login starts again\./);
    assert.equal(t.elapsed(), SIGN_IN_FOR_MS, "never waited past it");
    assert.deepEqual(
      t.shown.map((s) => s.code),
      ["CODE-1", "CODE-2", "CODE-3"],
      "a code each 10 minutes",
    );
    assert.deepEqual(t.mem.kept, {});
    assert.ok(t.logged.includes('account_sign_in {"ended":"timed-out","renewed":2,"asked":0,"outages":0}'));

    const off = patientSetUp({ polls: [DOWN] });
    const o = await off.signIn();
    assert.equal(!o.ok && o.why, "timed-out");
    assert.equal(!o.ok && o.offline, true);
    assert.match(!o.ok ? o.said : "", /Couldn't reach kiko\.sh for 30 minutes \(fetch failed\)\. Nothing changed: kiko(-dev)? login tries again\./);
    assert.ok(off.elapsed() <= SIGN_IN_FOR_MS);
    // Never a code at all (the server down from the start): the same bound.
    const never = patientSetUp({ codes: [DOWN] });
    const n = await never.signIn();
    assert.equal(!n.ok && n.why, "timed-out");
    assert.equal(never.shown.length, 0);
    assert.equal(never.elapsed(), SIGN_IN_FOR_MS);
    assert.ok(never.waits.every((w) => w <= UNREACHABLE_WAITS_MS.at(-1)!));
  });

  test("denied or refused: ended at once (no new code), nothing kept; Esc (the signal) during an outage stops it", async () => {
    for (const [poll, why] of [
      [{ kind: "denied" }, "denied"],
      [{ kind: "refused", why: "invalid_client" }, "refused"],
    ] as const) {
      const t = patientSetUp({ polls: [{ kind: "pending" }, poll] });
      const r = await t.signIn();
      assert.equal(!r.ok && r.why, why);
      assert.equal(t.shown.length, 1, "no new code");
      assert.deepEqual(t.mem.kept, {});
    }
    const refused = patientSetUp({ codes: [{ kind: "refused", why: "invalid_client" }] });
    const r = await refused.signIn();
    assert.equal(!r.ok && r.why, "refused");

    // Esc pressed on the third poll that can't reach the server.
    const stop = new AbortController();
    let misses = 0;
    const t = patientSetUp({ polls: [() => (++misses === 3 && stop.abort(), DOWN)] });
    const c = await t.signIn({ signal: stop.signal });
    assert.deepEqual(t.reach, [false]);
    assert.equal(!c.ok && c.why, "cancelled");
    assert.match(!c.ok ? c.said : "", /Sign-in stopped\. Nothing changed\./);
  });
});

/** Signed in already: the token in the store, who it is in account.json. */
async function signedIn() {
  const t = await setUp();
  assert.equal((await t.signIn()).ok, true);
  t.server.calls.length = 0;
  return t;
}

describe("staying signed in", () => {
  test("check: who it is and how many Macs, asked with the session token; account.json brought up to date", async () => {
    const t = await signedIn();
    t.server.answer("session", sessionAnswer({ email: "new@example.com", macs: 2 }));
    const r = await t.account.check();
    assert.deepEqual(r, { state: "signed-in", email: "new@example.com", since: r.state === "signed-in" ? r.since : 0, reached: true, macs: 2, plan: null, trial: null });
    assert.equal(t.server.to("session")[0].bearer, SESSION_TOKEN);
    assert.equal(t.server.to("session")[0].method, "GET");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    const view = t.account.view();
    assert.equal(view.state === "signed-in" && view.email, "new@example.com");
    noTokenLeaks(t);
  });

  test("the server down, failing, any 401 but signed_out, a captive portal's page: still signed in, the token kept", async () => {
    const t = await signedIn();
    const answers: Answer[] = [
      error("unavailable", 503),
      { status: 500, html: "oops" },
      error("rate_limited", 429),
      { status: 200, html: "<html>Log in to the Wi-Fi</html>" },
      { status: 200, json: null },
      { status: 401, html: "<html>portal</html>" },
      error("unauthorized", 401),
      { status: 302, headers: { location: "http://portal.example/" }, json: {} },
      "drop",
    ];
    for (const a of answers) {
      t.server.answer("session", a);
      const r = await t.account.check();
      assert.equal(r.state, "signed-in", JSON.stringify(a));
      assert.equal(r.state === "signed-in" && r.reached, false);
      assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    }
    await t.server.down();
    assert.equal((await t.account.check()).state, "signed-in");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    assert.equal(t.account.view().state, "signed-in");
  });

  test("revoked (401 signed_out, the one signal): signed out, the token gone, and the one line said from then on", async () => {
    const t = await signedIn();
    t.server.answer("session", SIGNED_OUT);
    assert.deepEqual(await t.account.check(), { state: "signed-out", revoked: true });
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    assert.deepEqual(t.account.view(), { state: "signed-out", revoked: true });
    assert.ok(t.logged.some((l) => l.startsWith("account_signed_out")));
    // Asked again: still the same state, nothing sent (no token to send).
    assert.deepEqual(await t.account.check(), { state: "signed-out", revoked: true });
    assert.equal(t.server.to("session").length, 1);
    assert.equal(SIGNED_OUT_LINE, "Signed out on kiko.sh: kiko-dev login signs in again.");
  });

  test("the token gone from the store (taken out by hand): signed out, not 'revoked'", async () => {
    const t = await signedIn();
    delete t.mem.kept[SESSION_KEY];
    assert.deepEqual(await t.account.check(), { state: "signed-out", revoked: false });
    assert.equal(t.account.view().state, "signed-out");
  });

  test("the store unreadable: unknown, nothing changed", async () => {
    const t = await signedIn();
    t.mem.store.get = () => {
      throw new Error("you said no to the prompt");
    };
    assert.deepEqual(await t.account.check(), { state: "unknown", why: "the Keychain couldn't be read: you said no to the prompt" });
    assert.equal(t.account.view().state, "signed-in");
  });
});

describe("access tokens", () => {
  const access = (jwt: string): Answer => ({ json: { access_token: jwt, token_type: "Bearer", expires_in: 600 } });

  test("held in memory while it has time left, fetched again early, before it runs out", async () => {
    const t = await signedIn();
    t.server.answer("access", access(fakeJwt(1)), access(fakeJwt(2)));
    assert.deepEqual(await t.account.accessToken(), { jwt: fakeJwt(1) });
    assert.equal(t.server.to("access")[0].bearer, SESSION_TOKEN);
    assert.equal(t.server.to("access")[0].method, "POST");
    t.tick(5 * 60_000);
    assert.deepEqual(await t.account.accessToken(), { jwt: fakeJwt(1) }, "5 minutes left: the one held");
    assert.equal(t.server.to("access").length, 1);
    t.tick(5 * 60_000 - REFRESH_EARLY_MS + 1000);
    assert.deepEqual(await t.account.accessToken(), { jwt: fakeJwt(2) }, "under two minutes left: a new one");
  });

  test("the server down at refresh: the one held while it's good, then none; still signed in, the token kept", async () => {
    const t = await signedIn();
    t.server.answer("access", access(fakeJwt()));
    assert.deepEqual(await t.account.accessToken(), { jwt: fakeJwt() });
    t.tick(9 * 60_000);
    await t.server.down();
    assert.deepEqual(await t.account.accessToken(), { jwt: fakeJwt() }, "a minute left, the server down: the one held");
    t.tick(2 * 60_000);
    const r = await t.account.accessToken();
    assert.equal("none" in r && r.none, "unreachable");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN, "the session token kept");
    assert.equal(t.account.view().state, "signed-in");
  });

  test("revoked at refresh: none, and signed out", async () => {
    const t = await signedIn();
    t.server.answer("access", SIGNED_OUT);
    const r = await t.account.accessToken();
    assert.equal("none" in r && r.none, "signed-out");
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    assert.deepEqual(t.account.view(), { state: "signed-out", revoked: true });
  });
});

describe("a phone paired: told to the server (POST /session/phone)", () => {
  test("told once, then not again while it's so; unpaired, told that", async () => {
    const t = await signedIn();
    assert.equal(await t.account.syncPhone(true), "told");
    assert.deepEqual(t.server.to("phone")[0].body, { paired: true });
    assert.equal(t.server.to("phone")[0].bearer, SESSION_TOKEN);
    assert.equal(await t.account.syncPhone(true), "known", "the server knows already");
    assert.equal(t.server.to("phone").length, 1);
    assert.equal(await t.account.syncPhone(true, true), "told", "forced (once at start)");
    t.server.answer("phone", sessionAnswer({ phonePaired: false }));
    assert.equal(await t.account.syncPhone(false), "told");
    assert.deepEqual(t.server.to("phone").at(-1)?.body, { paired: false });
  });

  test("a new sign-in has no phone on the server: none paired, nothing to tell", async () => {
    const t = await signedIn();
    assert.equal(await t.account.syncPhone(false), "known");
    assert.equal(t.server.to("phone").length, 0);
  });

  test("the server down: pending, the token kept; told on the next try", async () => {
    const t = await signedIn();
    t.server.answer("phone", error("unavailable", 503), sessionAnswer({ phonePaired: true }));
    assert.equal(await t.account.syncPhone(true), "pending");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    assert.equal(t.account.view().state, "signed-in");
    assert.equal(await t.account.syncPhone(true), "told");
    await t.server.down();
    assert.equal(await t.account.syncPhone(false), "pending");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("what the server says of it, seen by a check: told only when it differs", async () => {
    const t = await signedIn();
    t.server.answer("session", sessionAnswer({ phonePaired: true }));
    await t.account.check();
    assert.equal(await t.account.syncPhone(true), "known");
    assert.equal(t.server.to("phone").length, 0);
  });

  test("signed out on the server: signed out here", async () => {
    const t = await signedIn();
    t.server.answer("phone", SIGNED_OUT);
    assert.equal(await t.account.syncPhone(true), "signed-out");
    assert.deepEqual(t.account.view(), { state: "signed-out", revoked: true });
  });

  test("not signed in: nothing sent", async () => {
    const t = await setUp();
    assert.equal(await t.account.syncPhone(true), "none");
    assert.equal(t.server.calls.length, 0);
  });
});

describe("signing out", () => {
  test("the server told (POST /logout, with the token), the token taken out, account.json gone", async () => {
    const t = await signedIn();
    assert.deepEqual(await t.account.signOut(), { server: "done" });
    assert.equal(t.server.to("signOut")[0].bearer, SESSION_TOKEN);
    assert.equal(t.server.to("signOut")[0].method, "POST");
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    assert.equal(existsSync(t.file), false);
    assert.deepEqual(t.account.view(), { state: "signed-out", revoked: false });
  });

  test("the session dead there already (401 signed_out): signed out all the same", async () => {
    const t = await signedIn();
    t.server.answer("signOut", SIGNED_OUT);
    assert.deepEqual(await t.account.signOut(), { server: "done" });
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("offline: signed out here all the same, and said so", async () => {
    const t = await signedIn();
    await t.server.down();
    const r = await t.account.signOut();
    assert.equal(r.server, "unreachable");
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("the store can't remove it: said, still signed in", async () => {
    const t = await signedIn();
    t.mem.store.remove = async () => {
      throw new Error("the Keychain is locked");
    };
    assert.equal((await t.account.signOut()).kept, "the Keychain is locked");
    assert.equal(t.account.view().state, "signed-in");
  });
});

describe("deleting the account (POST /account/delete/code, then /account/delete)", () => {
  test("the code sent with the session token, then the account deleted with it: the token out of the store, account.json gone", async () => {
    const t = await setUp();
    await t.signIn();
    const sent = await t.account.deleteCode();
    assert.deepEqual(sent, { ok: true, email: EMAIL, expiresIn: 300 });
    assert.deepEqual(await t.account.deleteAccount("123456"), { ok: true });
    assert.deepEqual(
      t.server.to("delete").map((c) => [c.bearer, c.body]),
      [[SESSION_TOKEN, { code: "123456" }]],
    );
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    assert.equal(existsSync(t.file), false);
    assert.ok(t.logged.includes("account_deleted {}"));
    noTokenLeaks(t);
  });

  test("a code turned down: which, and nothing changes; the server down or failing: nothing changes either", async () => {
    const t = await setUp();
    await t.signIn();
    for (const code of ["invalid_code", "expired_code", "too_many_attempts"] as const) {
      t.server.answer("delete", codeRefused(code));
      assert.deepEqual(await t.account.deleteAccount("000000"), { ok: false, why: "code", code });
    }
    t.server.answer("delete", { status: 500, json: { error: "server_error" } });
    assert.equal((await t.account.deleteAccount("000000")).ok, false);
    await t.server.down();
    const r = await t.account.deleteCode();
    assert.equal(!r.ok && r.why, "unreachable");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN, "still signed in");
    assert.equal(t.account.view().state, "signed-in");
  });

  test("too many codes: rate-limited with its wait; signed out there: signed out here", async () => {
    const t = await setUp();
    await t.signIn();
    t.server.answer("deleteCode", { status: 429, json: { error: "rate_limited" }, headers: { "retry-after": "120" } });
    assert.deepEqual(await t.account.deleteCode(), { ok: false, why: "rate-limited", retryAfter: 120 });
    t.server.answer("deleteCode", SIGNED_OUT);
    assert.deepEqual(await t.account.deleteCode(), { ok: false, why: "signed-out" });
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    const view = t.account.view();
    assert.equal(view.state === "signed-out" && view.revoked, true);
  });

  test("deleted, but the store can't remove the token: done all the same, and said", async () => {
    const mem = memoryStore({}, {});
    const t = await setUp({ store: mem });
    await t.signIn();
    const failing = memoryStore({ [SESSION_KEY]: SESSION_TOKEN }, { failRemove: "the keychain helper failed (1)" });
    Object.assign(mem.store, { remove: failing.store.remove });
    assert.deepEqual(await t.account.deleteAccount("123456"), { ok: true, kept: "the keychain helper failed (1)" });
    assert.equal(existsSync(t.file), false);
  });

  test("not signed in: nothing sent", async () => {
    const t = await setUp();
    assert.deepEqual(await t.account.deleteCode(), { ok: false, why: "not-signed-in" });
    assert.deepEqual(await t.account.deleteAccount("123456"), { ok: false, why: "not-signed-in" });
    assert.equal(t.server.calls.length, 0);
  });
});

describe("the free trial (POST /trial/start)", () => {
  const words = { started: trialStartedLine, refused: trialRefusedLine };

  async function signedIn(script: Answer[] = [trialStarted()]) {
    const t = await setUp();
    t.server.answer("trial", ...script);
    assert.equal((await t.signIn()).ok, true);
    return t;
  }

  test("started with the session token: the plan kept in account.json (no token there), the access token fetched afresh", async () => {
    const t = await signedIn();
    const before = await t.account.accessToken();
    assert.ok("jwt" in before);
    const r = await t.account.startTrial(words);
    assert.equal(r.ok, true);
    assert.match(r.said, /^Your free trial runs until \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\. Kiko's AI calls go through Kiko, so you don't need a key\.$/);
    assert.deepEqual(
      t.server.to("trial").map((c) => [c.method, c.bearer]),
      [["POST", SESSION_TOKEN]],
    );
    const v = t.account.view();
    assert.equal(v.state === "signed-in" && v.plan?.name, "trial");
    assert.ok(v.state === "signed-in" && planActive(v.plan));
    // The next access token is a new one, so it carries the plan.
    await t.account.accessToken();
    assert.equal(t.server.to("access").length, 2);
    assert.ok(t.logged.includes('account_trial {"started":true}'));
    noTokenLeaks(t);
  });

  test("refused: its line, nothing kept; the server down: said, still signed in; signed out there: signed out", async () => {
    const t = await signedIn([trialRefused("trial_used"), trialRefused("email_not_allowed", { reason: "no_mail" }), { status: 503, json: { error: "server_error" } }, SIGNED_OUT]);
    let r = await t.account.startTrial(words);
    assert.deepEqual([r.ok, !r.ok && r.code], [false, "trial_used"]);
    assert.equal(r.said, "name@example.com has already used its free trial. Go on with your own OpenRouter key (kiko-dev keys set openrouter), free forever with no account.");
    r = await t.account.startTrial(words);
    assert.match(r.said, /^A free trial needs an email address that can receive mail, and example\.com can't\./);
    r = await t.account.startTrial(words);
    assert.deepEqual([r.ok, !r.ok && r.why], [false, "unreachable"]);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN, "a 5xx never signs out");
    const v = t.account.view();
    assert.equal(v.state === "signed-in" && v.plan, null, "no plan kept from a refusal");
    r = await t.account.startTrial(words);
    assert.deepEqual([r.ok, !r.ok && r.why], [false, "signed-out"]);
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("not signed in: nothing asked", async () => {
    const t = await setUp();
    const r = await t.account.startTrial(words);
    assert.deepEqual([r.ok, !r.ok && r.why], [false, "not-signed-in"]);
    assert.equal(t.server.to("trial").length, 0);
  });

  test("a check keeps the plan as the server says it; the notices given reset with a new plan", async () => {
    const t = await signedIn();
    t.server.answer("session", sessionAnswer({ plan: planJson({ daysLeft: 2, used: 0.5 }) }));
    const c = await t.account.check();
    assert.equal(c.state === "signed-in" && c.plan?.quota?.usedShare, 0.5);
    t.account.markTold("two_days");
    assert.equal(t.account.told("two_days"), true);
    await t.account.check();
    assert.equal(t.account.told("two_days"), true, "the same plan: kept");
    t.server.answer("session", sessionAnswer({ plan: planJson({ plan: "pro" }) }));
    await t.account.check();
    assert.equal(t.account.told("two_days"), false, "another plan: given again when it's due");
  });
});

describe("the plan's words", () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const plan = (o: { name?: "trial" | "pro" | "none"; daysLeft?: number; used?: number } = {}) => ({
    name: o.name ?? ("trial" as const),
    startedAt: now - 86_400_000,
    endsAt: now + (o.daysLeft ?? 4) * 86_400_000 - 60_000,
    quota: { period: "plan" as const, periodEnd: null, usedShare: o.used ?? 0.31, dailyCap: true, dailyResetsAt: null, pastCap: "stop" as const },
  });

  test("kiko account's line: days left and a percentage, never dollars", () => {
    assert.match(planLine(plan(), null, now), /^Plan: free trial · 4 days left \(until .+\) · 31% of its usage used\.$/);
    assert.match(planLine(plan({ daysLeft: 1, used: 1 }), null, now), / · 1 day left .* · 100% of its usage used\./);
    assert.equal(planLine({ ...plan({ name: "pro", used: 0.4 }) }, null, now), "Plan: Kiko Pro · 40% of this month used.");
    // Past it, a stop until it renews (no cheaper model any more): said under the line (planDetail).
    assert.equal(planLine({ ...plan({ name: "pro", used: 1 }) }, null, now), "Plan: Kiko Pro · 100% of this month used.");
    assert.match(planLine(null, null, now), /^Plan: none\. Kiko's AI runs on your own OpenRouter key/);
    assert.match(planLine(plan({ daysLeft: -1 }), null, now), /^Plan: none\. Your free trial ended/);
  });

  test("in brief (kiko keys's account line): the trial's days left and share used, Pro's month, ended, none", () => {
    assert.equal(planBrief(plan(), null, now), "free trial, 4 days left, 31% used");
    assert.equal(planBrief(plan({ daysLeft: 1, used: 0 }), null, now), "free trial, 1 day left, 0% used");
    assert.equal(planBrief(plan({ name: "pro", used: 0.12 }), null, now), "Kiko Pro, 12% of this month used");
    assert.equal(planBrief(plan({ daysLeft: -1 }), null, now), "free trial ended");
    assert.equal(planBrief(null, { startedAt: null, endsAt: null, ended: true, endedWhy: "cap" }, now), "free trial ended");
    assert.equal(planBrief(null, null, now), "no plan");
  });

  test("Settings → Account's rows: the trial's days and share, Pro's month, ended (on the day, or its usage, and how to go on), none; your own key plainly", () => {
    assert.deepEqual(planFacts(plan({ daysLeft: 6, used: 0.03 }), null, { now }), [
      { label: "Plan", value: "Free trial · 6 days left", warn: false },
      { label: "Used", value: "3% of the trial", warn: false },
    ]);
    assert.deepEqual(planFacts(plan({ name: "pro", used: 0.4 }), null, { now }), [
      { label: "Plan", value: "Kiko Pro", warn: false },
      { label: "This month", value: "40% used", warn: false },
    ]);
    const ended = { startedAt: now - 8 * 86_400_000, endsAt: Date.UTC(2026, 10, 2, 12), ended: true, endedWhy: "time" as const };
    const goOn = ["To go on, add your own OpenRouter key (free):", "kiko-dev keys set openrouter"];
    assert.deepEqual(planFacts(null, ended, { now }), [{ label: "Plan", value: "Trial ended on 2 Nov", more: goOn }]);
    assert.deepEqual(planFacts(null, { ...ended, endedWhy: "cap" }, { now }), [{ label: "Plan", value: "Trial ended: its usage was used up", more: goOn }]);
    assert.deepEqual(planFacts(null, null, { now }), [{ label: "Plan", value: "No plan" }]);
    assert.deepEqual(planFacts(null, null, { now, ownKey: true }), [{ label: "Plan", value: "Using your own OpenRouter key" }]);
    assert.deepEqual(planFacts(plan(), null, { now, ownKey: true }), [{ label: "Plan", value: "Using your own OpenRouter key", more: ["The free trial isn't used while a key is set."] }]);
    // Pro with your own key: still Pro, with why it isn't used under it (and no month's share).
    assert.equal(planFacts(plan({ name: "pro" }), null, { now, ownKey: true }).length, 1);
    // An ended trial with a key of your own: just ended (nothing to explain).
    assert.deepEqual(planFacts(null, ended, { now, ownKey: true }), [{ label: "Plan", value: "Trial ended on 2 Nov" }]);
    // While Kiko Pro is on sale, it's offered beside your own key.
    process.env.KIKO_ACCOUNTS = "1";
    process.env.KIKO_PRO = "1";
    try {
      assert.deepEqual(planFacts(null, ended, { now })[0].more, [...goOn, "Or get Kiko Pro: kiko-dev upgrade"]);
    } finally {
      delete process.env.KIKO_ACCOUNTS;
      process.env.KIKO_PRO = "0";
    }
  });

  test("the window's item: the trial's days left, dim; yellow in its last two days or past 80% (then the share); none for Pro, none, ended or a key of your own", () => {
    assert.deepEqual(planBadge(plan({ daysLeft: 6, used: 0.03 }), { now }), { text: "trial · 6d left", warn: false });
    assert.deepEqual(planBadge(plan({ daysLeft: 3, used: 0.79 }), { now }), { text: "trial · 3d left", warn: false });
    assert.deepEqual(planBadge(plan({ daysLeft: 2, used: 0.1 }), { now }), { text: "trial · 2d left", warn: true });
    assert.deepEqual(planBadge(plan({ daysLeft: 1, used: 0.1 }), { now }), { text: "trial · 1d left", warn: true });
    assert.deepEqual(planBadge(plan({ daysLeft: 5, used: 0.85 }), { now }), { text: "trial · 85% used", warn: true });
    assert.equal(planBadge(plan({ daysLeft: 5 }), { now, ownKey: true }), null);
    assert.equal(planBadge(plan({ name: "pro" }), { now }), null);
    assert.equal(planBadge(plan({ daysLeft: -1 }), { now }), null);
    assert.equal(planBadge(null, { now }), null);
  });

  test("one decision for every place that says the plan: planStatus feeds the line, Settings' rows, the item, the reminders and the phone's message", async () => {
    const { accountStatus } = await import("../../../src/remote/account-status.ts");
    assert.deepEqual(NEAR_END, { days: 2, used: 0.8 });
    for (const daysLeft of [7, 3, 2, 1, -1])
      for (const used of [0, 0.5, 0.79, 0.8, 0.95]) {
        const p = plan({ daysLeft, used });
        const st = planStatus(p, null, now);
        const badge = planBadge(p, { now });
        const reminder = reminderNotice(p, now);
        const phone = accountStatus({ state: "signed-in", email: null, since: now, checkedAt: now, plan: p, trial: null }, false, now);
        if (st.kind !== "trial") {
          assert.equal(st.kind, "ended");
          assert.equal(badge, null);
          assert.equal(reminder, null);
          assert.equal(phone?.ended, true);
          continue;
        }
        // Near its end, by the same thresholds: yellow on the window's line, and a reminder said.
        assert.equal(badge?.warn, st.near !== null, `${daysLeft}d ${used}`);
        assert.equal(reminder !== null, st.near !== null, `${daysLeft}d ${used}`);
        assert.equal(reminder?.key ?? null, st.near === "used" ? "almost_used" : st.near === "days" ? "two_days" : null);
        // The same days and share wherever they're said.
        assert.equal(phone?.usedPct, Math.round(used * 100));
        const [days, share] = planFacts(p, null, { now });
        assert.match(days.value, new RegExp(`^Free trial · ${st.daysLeft} days? left$`));
        assert.equal(share.value, `${Math.round(used * 100)}% of the trial`);
        // Yellow in Settings by the same thresholds, on the value that's near: the days, or the share.
        assert.equal(days.warn || share.warn, st.near !== null, `${daysLeft}d ${used}`);
        if (st.near === "used") assert.equal(share.warn, true);
        assert.match(planLine(p, null, now), new RegExp(`${st.daysLeft} days? left .* ${Math.round(used * 100)}% of its usage used`));
      }
  });

  test("the reminders: almost used up past 80%, then two days left; none for Pro or an ended trial", () => {
    assert.equal(reminderNotice(plan({ used: 0.81 }), now)?.key, "almost_used");
    assert.equal(reminderNotice(plan({ daysLeft: 2, used: 0.1 }), now)?.spoken, "Two days left on your free trial.");
    assert.equal(reminderNotice(plan({ daysLeft: 1, used: 0.1 }), now)?.spoken, "One day left on your free trial.");
    assert.equal(reminderNotice(plan({ daysLeft: 5, used: 0.1 }), now), null);
    assert.equal(reminderNotice(plan({ name: "pro", used: 0.95 }), now), null);
    assert.equal(reminderNotice(plan({ daysLeft: -1, used: 0.95 }), now), null);
  });
});
