// Signing the Mac in from the phone, end to end (protocol/README.md, "Signing the Mac in from the
// phone"): a real phone server, a real Account against a fake account server in this process
// (tests/support/fake-account.ts: nothing reaches the network or the Keychain), and fake phones at
// home and through a fake relay. A paired phone of a signed-out Mac is told why (mac_signed_out) and
// offered the sign-in; it says sign_in, gets the code (the approval page with the code in it), opens
// it; approved, the Mac's poll gets its token, the plan is asked, the phone hears signed_in and is let
// go with 4015, and its next hello gets in. One code for every phone; a code that runs out is
// replaced; a denial says so and sign_in tries again; signed in some other way meanwhile ends it as
// signed in. An older app that never says sign_in is let go with 4014 as before; a phone pairing is
// never offered it. And a refused phone gets nothing but the refusal and the hand-off, at home and
// through the relay: never welcome, the sessions, what was missed, the account, or a line.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Account, SESSION_KEY } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { MacSignIn } from "../../../src/core/account/mac-sign-in.ts";
import { phonePlan, type PhonePlan } from "../../../src/core/account/phone-plan.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { RelayClient } from "../../../src/remote/relay-client.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, PLAN_REQUIRED_CLOSE, SIGNED_IN_CLOSE, type PhoneHub } from "../../../src/remote/server.ts";
import { x25519Pair } from "../../../src/remote/tunnel.ts";
import { type Answer, EMAIL, fakeAccountServer, happyScript, memoryStore, PENDING, planJson, sessionAnswer, USER_CODE } from "../../support/fake-account.ts";
import { FakeRelay } from "../../support/fake-relay.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { RelayPhone } from "../../support/relay-phone.ts";
import { checkWaits } from "../../support/until.ts";

const until = checkWaits(5000, 10);

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

/** A code from the fake server: `code` its user code, running out after `expiresIn` seconds. */
const codeAnswer = (code = USER_CODE, expiresIn = 600, device = "dev-1"): Answer => ({
  json: {
    device_code: device,
    user_code: code,
    verification_uri: "https://account.kiko.sh/device",
    verification_uri_complete: `https://account.kiko.sh/device?user_code=${code}`,
    interval: 1,
    expires_in: expiresIn,
  },
});
const approved = happyScript().token[0];
const DENIED: Answer = { status: 400, json: { error: "access_denied" } };

function phoneAt(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  let closed = false;
  ws.once("close", () => (closed = true));
  return {
    ws,
    got,
    types: () => got.map((m) => (m.type === "mac_sign_in" ? `mac_sign_in:${m.state}` : m.type)),
    closed: () => closed,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
  };
}

/** A signed-out Mac: its Account on the fake server, its shared sign-in, its phone server; `included` lets a phone pair first. */
async function setUp(script: Partial<Record<string, Answer[]>> = {}, o: { relay?: { url: string; room: string; macKey: string; signingKey: string } } = {}) {
  const fake = await fakeAccountServer({
    ...happyScript(),
    code: [codeAnswer()],
    token: [PENDING],
    session: [sessionAnswer({ plan: planJson({ plan: "trial", daysLeft: 6 }) })],
    ...script,
  });
  const dir = mkdtempSync(join(tmpdir(), "signin-"));
  const store = memoryStore();
  const file = join(dir, "account.json");
  const account = new Account({ store: store.store, client: accountClient(fake.url, { callMs: 2000 }), file, sleep: (_ms, signal) => sleep(15, undefined, { signal }) });
  const signIn = new MacSignIn({ account: () => account, after: (a) => a.check().then(() => {}) });
  const plan = { forced: null as PhonePlan | null };
  const opened: string[] = [];
  const refused: string[] = [];
  const pairing = new Pairing(join(dir, "phones.json"));
  const server = new PhoneServer({
    hub,
    pairing,
    port: 0,
    host: "127.0.0.1",
    network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" },
    presenceMs: 60_000,
    opus: null,
    phonePlan: () => plan.forced ?? phonePlan(account.view(), { sale: true }),
    planRefused: (_p, r) => void refused.push(r.reason),
    macSignIn: signIn,
    signInOpened: (p) => void opened.push(p.name),
    signInMs: { answer: 200, hold: 60_000 },
    account: () => null,
    ...(o.relay ? { relay: o.relay } : {}),
  });
  const port = await server.start();
  return {
    fake,
    account,
    store,
    file,
    signIn,
    server,
    pairing,
    port,
    opened,
    refused,
    plan,
    /** A phone paired while the plan let it, then the plan as the account has it (signed out). */
    async paired(device = "Lacy's iPhone") {
      plan.forced = { ok: true };
      const a = phoneAt(port);
      await a.send({ type: "pair", code: pairing.open().code, device, appVersion: "0.5.0" });
      const welcome = await until(() => a.got.find((m) => m.type === "welcome"));
      const token = a.got.find((m) => m.type === "paired").token as string;
      plan.forced = null;
      return { a, token, welcome };
    },
    async stop() {
      signIn.stop();
      server.stop();
      await fake.close();
    },
  };
}

describe("signing the Mac in from the phone, at home", () => {
  test("refused as signed out and offered; sign_in, the code, opened; approved: signed in, signed_in and 4015, then in", async () => {
    const t = await setUp();
    try {
      const { a, token } = await t.paired();
      a.ws.close();
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => b.got.length === 1);
      assert.deepEqual(b.got[0], { v: 1, type: "plan_required", trialAvailable: true, reason: "mac_signed_out", signIn: true });
      assert.deepEqual(t.refused, ["mac_signed_out"]);

      await b.send({ type: "sign_in" });
      const code = await until(() => b.got.find((m) => m.type === "mac_sign_in" && m.state === "code"));
      assert.equal(code.code, USER_CODE);
      assert.equal(code.url, `https://account.kiko.sh/device?user_code=${USER_CODE}`, "the page with the code in it, for the phone's browser");
      assert.ok(code.expiresAt > Date.now() + 500_000);
      await b.send({ type: "sign_in_opened" });
      await until(() => t.opened.length === 1);
      assert.deepEqual(t.opened, ["Lacy's iPhone"]);
      // Waiting: held well past the answer's window, never let in.
      await sleep(300);
      assert.equal(b.closed(), false, "held for the sign-in");

      // Approved in the browser: the poll gets the token, the plan is asked, then signed_in and 4015.
      t.fake.answer("token", approved);
      await until(() => b.closed());
      assert.deepEqual(b.types(), ["plan_required", "mac_sign_in:starting", "mac_sign_in:code", "mac_sign_in:signed_in"]);
      assert.deepEqual(b.ws.closedBy, { code: SIGNED_IN_CLOSE, reason: "signed_in" });
      assert.equal(t.account.view().state, "signed-in");
      assert.equal(t.store.kept[SESSION_KEY], approved !== "drop" && approved !== "hang" ? (approved.json as any).access_token : null, "the token kept in the (test's) key store");
      assert.equal(t.fake.to("code").length, 1);
      assert.ok(t.fake.to("session").length >= 1, "the plan asked for before signed_in");

      // Connects again: the plan (the trial) includes it now.
      const c = phoneAt(t.port);
      await c.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => c.got.some((m) => m.type === "welcome"));
      c.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a refused phone gets nothing but the refusal and the hand-off: no welcome, sessions, missed, account or lines", async () => {
    const t = await setUp();
    try {
      const { a, token } = await t.paired();
      // A second phone stays connected (signed in), so the server has someone to tell things to.
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => b.got.length === 1);
      await b.send({ type: "sign_in" });
      await until(() => b.got.some((m) => m.state === "code"));
      const before = a.got.length;
      ui.info("a line the Mac said");
      ui.set({ sessions: [] });
      t.server.accountChanged();
      t.server.tell("nothing_plays");
      await b.send({ type: "get_sessions" });
      await sleep(150);
      assert.ok(a.got.length > before, "the phone that's in is told");
      assert.deepEqual(b.types(), ["plan_required", "mac_sign_in:starting", "mac_sign_in:code"], "only the refusal and the hand-off");
      assert.equal(b.closed(), false, "a signed-in phone's message is let be: never unauthorized, which would unpair it");
      a.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("an older app never says sign_in: let go with 4014 after the answer's window, as before", async () => {
    const t = await setUp();
    try {
      const { a, token } = await t.paired();
      a.ws.close();
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.4.0" });
      await until(() => b.closed());
      assert.deepEqual(b.types(), ["plan_required"]);
      assert.deepEqual(b.ws.closedBy, { code: PLAN_REQUIRED_CLOSE, reason: "plan_required" });
      assert.equal(t.fake.to("code").length, 0, "no code asked for nobody");
    } finally {
      await t.stop();
    }
  });

  test("a phone pairing while the Mac is signed out: told why, never offered the sign-in, let go at once", async () => {
    const t = await setUp();
    try {
      const a = phoneAt(t.port);
      await a.send({ type: "pair", code: t.pairing.open().code, device: "New iPhone", appVersion: "0.5.0" });
      await until(() => a.closed());
      assert.deepEqual(a.got, [{ v: 1, type: "plan_required", trialAvailable: true, reason: "mac_signed_out" }]);
      assert.equal(t.pairing.list().length, 0);
    } finally {
      await t.stop();
    }
  });

  test("two phones and a reconnect share one code; denied: failed, the connection stays, sign_in tries again with a new code", async () => {
    const t = await setUp({ code: [codeAnswer(), codeAnswer("WXYZ-2345", 600, "dev-2")] });
    try {
      const { a, token } = await t.paired();
      const second = await t.paired("Desk iPad");
      a.ws.close();
      second.a.ws.close();
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => b.got.length === 1);
      await b.send({ type: "sign_in" });
      await until(() => b.got.some((m) => m.state === "code"));
      const c = phoneAt(t.port);
      await c.send({ type: "hello", token: second.token, device: "Desk iPad", appVersion: "0.5.0" });
      await until(() => c.got.length === 1);
      await c.send({ type: "sign_in" });
      const cCode = await until(() => c.got.find((m) => m.state === "code"));
      assert.equal(cCode.code, USER_CODE, "the same code");
      assert.equal(t.fake.to("code").length, 1, "one code asked for");

      t.fake.answer("token", DENIED);
      await until(() => b.got.some((m) => m.state === "failed"));
      assert.deepEqual(
        b.got.find((m) => m.state === "failed"),
        { v: 1, type: "mac_sign_in", state: "failed", why: "denied" },
      );
      assert.equal(b.closed(), false, "it stays, to try again");
      t.fake.answer("token", PENDING);
      await b.send({ type: "sign_in" });
      await until(() => b.got.filter((m) => m.state === "code").length === 2);
      assert.equal(b.got.filter((m) => m.state === "code")[1].code, "WXYZ-2345");
      await until(() => c.got.filter((m) => m.state === "code").length === 2);
      b.ws.close();
      c.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a code that runs out while a phone waits is replaced: the new one sent on the same connection", async () => {
    const t = await setUp({ code: [codeAnswer(USER_CODE, 1), codeAnswer("WXYZ-2345", 600, "dev-2")] });
    try {
      const { a, token } = await t.paired();
      a.ws.close();
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => b.got.length === 1);
      await b.send({ type: "sign_in" });
      await until(() => b.got.filter((m) => m.state === "code").length === 2);
      assert.deepEqual(
        b.got.filter((m) => m.state === "code").map((m) => m.code),
        [USER_CODE, "WXYZ-2345"],
      );
      assert.equal(b.closed(), false);
      b.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("signed in some other way meanwhile (kiko login in a terminal): the waiting phone hears signed_in at the next look", async () => {
    const t = await setUp();
    try {
      const { a, token } = await t.paired();
      a.ws.close();
      const b = phoneAt(t.port);
      await b.send({ type: "hello", token, device: "Lacy's iPhone", appVersion: "0.5.0" });
      await until(() => b.got.length === 1);
      await b.send({ type: "sign_in" });
      await until(() => b.got.some((m) => m.state === "code"));
      // What `kiko login` leaves: account.json signed in (and the token in its store).
      writeFileSync(t.file, JSON.stringify({ email: EMAIL, since: Date.now(), checkedAt: Date.now(), plan: null, trial: null }));
      t.server.accountChanged();
      await until(() => b.closed());
      assert.equal(b.got.at(-1).state, "signed_in");
      assert.deepEqual(b.ws.closedBy, { code: SIGNED_IN_CLOSE, reason: "signed_in" });
    } finally {
      await t.stop();
    }
  });
});

describe("through the relay", () => {
  test("a refused phone away gets only plan_required and the hand-off, and the sign-in works there too", async () => {
    const relay = new FakeRelay();
    const url = await relay.start();
    const identity = newIdentity();
    const t = await setUp({}, { relay: { url, room: identity.room, macKey: identity.static.public.toString("base64"), signingKey: identity.signing.public.toString("base64") } });
    const client = new RelayClient({ url, identity, pairing: t.pairing, server: t.server, retryMs: { min: 20, max: 100 }, handshakeMs: 500 });
    client.start();
    try {
      await until(() => client.status === "connected");
      // Paired at home, set up for the relay there.
      t.plan.forced = { ok: true };
      const home = phoneAt(t.port);
      await home.send({ type: "pair", code: t.pairing.open().code, device: "Away iPhone", appVersion: "0.5.0" });
      await until(() => home.got.some((m) => m.type === "welcome"));
      const token = home.got.find((m) => m.type === "paired").token as string;
      const key = x25519Pair();
      await home.send({ type: "relay_pair", key: key.public.toString("base64") });
      const rp = await until(() => home.got.find((m) => m.type === "relay_paired"));
      home.ws.close();
      t.plan.forced = null;

      const away = new RelayPhone({ url, room: rp.room, credential: rp.credential, macKey: Buffer.from(rp.macKey, "base64"), key });
      await away.open();
      away.send({ type: "hello", token, device: "Away iPhone", appVersion: "0.5.0" });
      const refused = await away.next("plan_required");
      assert.deepEqual(refused, { v: 1, type: "plan_required", trialAvailable: true, reason: "mac_signed_out", signIn: true });
      away.send({ type: "sign_in" });
      await away.next("mac_sign_in");
      const code = await away.next("mac_sign_in");
      assert.equal(code.state, "code");
      ui.info("a line the Mac said");
      t.server.accountChanged();
      t.fake.answer("token", approved);
      const done = await away.next("mac_sign_in");
      assert.equal(done.state, "signed_in");
      assert.deepEqual(away.left(), [], "nothing else came: no welcome, sessions, missed, account or line");
      await away.until(() => away.closedBy);
      assert.equal(away.closedBy?.code, SIGNED_IN_CLOSE);
      away.close();
    } finally {
      client.stop();
      await t.stop();
      relay.stop();
    }
  });
});
