// The relay pass (src/pass.ts, src/index.ts; protocol/README.md, "Relay": the pass), on local relays
// (support.ts) whose JWKS is a small server of this test's own, with keys made here: no account
// server, nothing deployed. requirePass is on by default; off (set so): rooms work exactly as before,
// with a pass or without. On: a Mac signs in only with a valid pass for its room (in `auth` or in the
// upgrade's Kiko-Relay-Pass header), else plan_required (4014): missing, expired, another audience,
// issuer or room, no room, a bad signature and an unknown key id are each refused; a Mac without one
// can't displace the one signed in; a phone of a Mac refused hears plan_required; a pass in the
// upgrade waits outside the per-address limits; an account's rooms are capped; a new key id fetches
// the JWKS again; a pass renewed on the open socket; a pass running out mid-session cuts nobody off;
// the pairing QR code's way in needs it too. The account server away: the keys last fetched (kept in
// KV) still check a pass in a fresh relay; with none ever fetched, a pass is unverified and refused.
// The revocation list: read at sign-in and join, and while phones are in (a revocation lets them go).
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { authMessage, ed25519Pair, ed25519Sign, roomOf } from "../../src/remote/tunnel.ts";
import { Client, NO_PASS, ONE_ADDRESS, onChannel, sha256hex, startRelay, writeKv, type LocalRelay } from "./support.ts";

// ── The JWKS: a server of the test's own, its keys changeable, its fetches counted ──────────────────

type Key = { kid: string; priv: KeyObject; jwk: Record<string, unknown> };
function makeKey(kid = `k${randomBytes(4).toString("hex")}`): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA" } };
}

const jwks = { keys: [] as Key[], fetches: 0 };
let server: Server;
let jwksUrl = "";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
type PassOptions = { key?: Key; kid?: string; claims?: Record<string, unknown>; expIn?: number; signWith?: Key };
/** A pass as the account server makes it (POST /v1/relay/pass), each part changeable (`room: undefined`: none). */
function makePass(o: PassOptions = {}) {
  const key = o.key ?? jwks.keys[0];
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: o.kid ?? key.kid }));
  const claims = { iss: "https://account.kiko.sh", aud: "relay.kiko.sh", sub: "acct_test", plan: "pro", iat: now, exp: now + (o.expIn ?? 86400), ...o.claims };
  const payload = b64url(JSON.stringify(claims));
  const sig = edSign(null, Buffer.from(`${header}.${payload}`), (o.signWith ?? key).priv);
  return `${header}.${payload}.${b64url(sig)}`;
}
/** A pass for the room it's shown in, as the Mac asks for it (its room id in the request). */
const forRoom =
  (o: PassOptions = {}) =>
  (room: string) =>
    makePass({ ...o, claims: { room, ...o.claims } });
type Shown = string | ((room: string) => string);

// ── Relays: off (set so), on (the default), and on with a JWKS that never answers ──────────────────

let off: LocalRelay;
let on: LocalRelay;
let outage: LocalRelay;
const OFF = JSON.stringify(NO_PASS);
// Every Mac here shows a pass of the one account (acct_test): its rooms' cap made generous but where a test is about it.
const MANY_ROOMS = { roomsPerAccount: 10_000 };
const REQUIRE = JSON.stringify({ requirePass: true, ...ONE_ADDRESS, ...MANY_ROOMS });

before(async () => {
  jwks.keys = [makeKey()];
  server = createServer((req, res) => {
    if (req.url !== "/jwks") return void res.writeHead(404).end();
    jwks.fetches++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: jwks.keys.map((k) => k.jwk) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  jwksUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/jwks`;
  [off, on, outage] = await Promise.all([
    startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: OFF }),
    startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: REQUIRE }),
    // Nothing listens on port 9 here: every fetch of the JWKS fails.
    startRelay({ PASS_JWKS_URL: "http://127.0.0.1:9/jwks", RELAY_LIMITS: REQUIRE }),
  ]);
});
after(async () => {
  await Promise.all([off?.dispose(), on?.dispose(), outage?.dispose()]);
  server?.close();
});

/**
 * A Mac's sign-in to a room of its own: showing `shown` in auth (or none; a function: made for its
 * room) and `header` in the upgrade's Kiko-Relay-Pass (or none). Its socket, and what came back:
 * ready, or the error it was refused with.
 */
async function signIn(relay: LocalRelay, shown?: Shown, key = ed25519Pair(), header?: Shown) {
  const room = roomOf(key.public);
  const pass = typeof shown === "function" ? shown(room) : shown;
  const inUpgrade = typeof header === "function" ? header(room) : header;
  const c = new Client(`${relay.url}/v1/mac/${room}`, inUpgrade ? { "Kiko-Relay-Pass": inUpgrade } : undefined);
  const { nonce } = await c.next("challenge");
  c.send({ type: "auth", key: key.public.toString("base64"), sig: ed25519Sign(key.seed, authMessage(room, Buffer.from(nonce, "base64"))).toString("base64"), ...(pass === undefined ? {} : { pass }) });
  const answer = await c.until(
    () => {
      const i = c.texts.findIndex((m) => m.type === "ready" || m.type === "error");
      return i >= 0 ? c.texts.splice(i, 1)[0] : undefined;
    },
    5_000,
    true,
  );
  return { c, room, answer };
}

/** A Mac signed in (as signIn), with one phone credential registered. */
async function mac(relay: LocalRelay, shown?: Shown, key = ed25519Pair(), header?: Shown) {
  const { c, room, answer } = await signIn(relay, shown, key, header);
  assert.equal(answer.type, "ready", JSON.stringify(answer));
  const credential = randomBytes(32);
  c.send({ type: "phones", credentials: [sha256hex(credential)] });
  await new Promise((r) => setTimeout(r, 50));
  return { c, room, ready: answer, credential };
}

/** A Mac refused at sign-in for its pass: plan_required with the pass's status, then 4014. */
async function refusedMac(relay: LocalRelay, shown: Shown | undefined, status: string, key = ed25519Pair()) {
  const { c, answer } = await signIn(relay, shown, key);
  assert.deepEqual(answer, { type: "error", code: "plan_required", pass: status });
  assert.equal(await c.closed(), 4014);
  return c;
}

async function phone(relay: LocalRelay, room: string, credential: Buffer) {
  const p = new Client(`${relay.url}/v1/phone/${room}`);
  await p.opened();
  p.send({ type: "join", credential: credential.toString("base64") });
  return p;
}

/** A phone refused for the plan: the error, then 4014; and the Mac told. */
async function refusedForPlan(m: Awaited<ReturnType<typeof mac>>, p: Client, pass: string) {
  assert.equal((await p.next("error")).code, "plan_required");
  assert.equal(await p.closed(), 4014);
  assert.deepEqual(await m.c.next("phone_refused"), { type: "phone_refused", code: "plan_required", pass });
}

/** A phone in, with frames both ways. */
async function joinedAndTalking(m: Awaited<ReturnType<typeof mac>>, p: Client) {
  await p.next("joined");
  const { channel } = await m.c.next("open");
  p.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...(await m.c.frame()).subarray(4)], [1, 2, 3]);
  m.c.send(onChannel(channel, new Uint8Array([9])));
  assert.deepEqual([...(await p.frame())], [9]);
  return channel;
}

describe("requirePass off (set so): every room as before", () => {
  test("no pass: ready says so and none is required; a phone joins and talks", async () => {
    const m = await mac(off);
    assert.deepEqual(m.ready, { type: "ready", pairing: true, pass: "missing", passRequired: false });
    const p = await phone(off, m.room, m.credential);
    await joinedAndTalking(m, p);
    p.close();
    m.c.close();
  });

  test("a bad pass, or an expired one: the phone joins all the same; a good one is still checked and said", async () => {
    for (const [pass, status] of [
      ["not a pass", "invalid"],
      [forRoom({ expIn: -60 }), "expired"],
    ] as const) {
      const m = await mac(off, pass);
      assert.equal(m.ready.pass, status);
      const p = await phone(off, m.room, m.credential);
      await p.next("joined");
      p.close();
      m.c.close();
    }
    const good = await mac(off, forRoom());
    assert.equal(good.ready.pass, "valid");
    good.c.close();
  });

  test("the room is always bound: a pass without a room, or for another room, is invalid even off (the phone let in all the same)", async () => {
    for (const pass of [makePass(), makePass({ claims: { room: "0".repeat(32) } })]) {
      const m = await mac(off, pass);
      assert.equal(m.ready.pass, "invalid");
      await (await phone(off, m.room, m.credential)).next("joined");
      m.c.close();
    }
  });
});

describe("requirePass on (the default)", () => {
  test("a valid pass: ready says valid with until when; a phone joins and talks", async () => {
    let pass = "";
    const m = await mac(on, (room) => (pass = makePass({ claims: { room } })));
    const exp = JSON.parse(Buffer.from(pass.split(".")[1], "base64url").toString()).exp;
    assert.deepEqual(m.ready, { type: "ready", pairing: true, pass: "valid", passExpiresAt: exp * 1000, passRequired: true });
    const p = await phone(on, m.room, m.credential);
    await joinedAndTalking(m, p);
    p.close();
    m.c.close();
  });

  test("no pass: the Mac is refused at sign-in (plan_required, 4014, pass missing): nobody claims a room without one", async () => {
    await refusedMac(on, undefined, "missing");
  });

  test("the pass in the upgrade (Kiko-Relay-Pass) is enough: ready says valid, a phone joins", async () => {
    const m = await mac(on, undefined, ed25519Pair(), forRoom());
    assert.equal(m.ready.pass, "valid");
    await joinedAndTalking(m, await phone(on, m.room, m.credential));
    m.c.close();
  });

  test("only a good pass displaces the Mac: the same key without one is refused and the Mac in stays, its phone talking; with one, it replaces it", async () => {
    const key = ed25519Pair();
    const m = await mac(on, forRoom(), key);
    const p = await phone(on, m.room, m.credential);
    const channel = await joinedAndTalking(m, p);
    await refusedMac(on, undefined, "missing", key);
    await refusedMac(on, forRoom({ expIn: -1 }), "expired", key);
    m.c.send(onChannel(channel, new Uint8Array([7])));
    assert.deepEqual([...(await p.frame())], [7]);
    assert.equal(m.c.closeCode, null);
    const again = await mac(on, forRoom(), key);
    assert.equal(await m.c.closed(), 4000);
    assert.equal(await p.closed(), 4002);
    again.c.close();
  });

  test("a Mac refused for its plan: its phone hears plan_required, not mac_offline; once a Mac signs in with a pass, the phone joins", async () => {
    const key = ed25519Pair();
    const m = await mac(on, forRoom(), key);
    m.c.close();
    await m.c.closed();
    await refusedMac(on, undefined, "missing", key);
    const p = await phone(on, m.room, m.credential);
    assert.equal((await p.next("error")).code, "plan_required");
    assert.equal(await p.closed(), 4014);
    const back = await signIn(on, forRoom(), key);
    assert.equal(back.answer.type, "ready");
    back.c.send({ type: "phones", credentials: [sha256hex(m.credential)] });
    await new Promise((r) => setTimeout(r, 50));
    await (await phone(on, m.room, m.credential)).next("joined");
    back.c.close();
  });

  test("a key id the cached JWKS doesn't have fetches it again (a new key), at most once in a while", async () => {
    // Cached already (the tests before), or fetched now.
    const first = await mac(on, forRoom());
    assert.equal(first.ready.pass, "valid");
    first.c.close();
    const before = jwks.fetches;
    const rotated = makeKey();
    jwks.keys.push(rotated);
    const m = await mac(on, forRoom({ key: rotated }));
    assert.equal(m.ready.pass, "valid");
    assert.equal(jwks.fetches, before + 1, "fetched once more, for the new key id");
    const p = await phone(on, m.room, m.credential);
    await p.next("joined");
    p.close();
    m.c.close();
    // Another made-up key id right after: not fetched again (at most once per 10 s), and refused.
    await refusedMac(on, forRoom({ kid: "made-up" }), "invalid");
    assert.equal(jwks.fetches, before + 1);
  });

  test("expired, another audience, another issuer, another plan, a bad signature, an unknown key id: the Mac refused", async () => {
    const stranger = makeKey(jwks.keys[0].kid); // the same key id, another key
    const cases: [Shown, string][] = [
      [forRoom({ expIn: -1 }), "expired"],
      [forRoom({ claims: { aud: "kiko" } }), "invalid"],
      [forRoom({ claims: { iss: "https://example.com" } }), "invalid"],
      [forRoom({ claims: { plan: "none" } }), "invalid"],
      [forRoom({ signWith: stranger }), "invalid"],
      [forRoom({ kid: "no-such-key" }), "invalid"],
    ];
    for (const [pass, status] of cases) await refusedMac(on, pass, status);
  });

  test("the room: a pass for another room is invalid, one without a room too; for this room, valid", async () => {
    const elsewhere = await mac(on, forRoom());
    const stolen = forRoom()(elsewhere.room);
    for (const pass of [stolen, makePass(), makePass({ claims: { room: 42 } })]) await refusedMac(on, pass, "invalid");
    // The pass made for it works in its own room.
    elsewhere.c.send({ type: "pass", pass: stolen });
    assert.equal((await elsewhere.c.next("pass")).pass, "valid");
    await (await phone(on, elsewhere.room, elsewhere.credential)).next("joined");
    elsewhere.c.close();
  });

  test("a pass renewed on the open socket: a good one taken; a bad renewal keeps the good one, phones still join", async () => {
    const m = await mac(on, forRoom());
    m.c.send({ type: "pass", pass: forRoom({ claims: { plan: "trial" } })(m.room) });
    assert.equal((await m.c.next("pass")).pass, "valid");
    const p = await phone(on, m.room, m.credential);
    await p.next("joined");
    m.c.send({ type: "pass", pass: forRoom({ claims: { aud: "kiko" } })(m.room) });
    assert.equal((await m.c.next("pass")).pass, "invalid");
    const p2 = await phone(on, m.room, m.credential);
    await p2.next("joined");
    p.close();
    p2.close();
    m.c.close();
  });

  test("the pass running out mid-session cuts nobody off; the next phone to join is refused; renewed, phones join again", async () => {
    const m = await mac(on, forRoom({ expIn: 2 }));
    assert.equal(m.ready.pass, "valid");
    const p = await phone(on, m.room, m.credential);
    const channel = await joinedAndTalking(m, p);
    await new Promise((r) => setTimeout(r, 2_500));
    // Past exp: still talking both ways.
    p.send(new Uint8Array([4]));
    assert.deepEqual([...(await m.c.frame()).subarray(4)], [4]);
    m.c.send(onChannel(channel, new Uint8Array([5])));
    assert.deepEqual([...(await p.frame())], [5]);
    assert.equal(p.closeCode, null);
    await refusedForPlan(m, await phone(on, m.room, m.credential), "expired");
    m.c.send({ type: "pass", pass: forRoom()(m.room) });
    assert.equal((await m.c.next("pass")).pass, "valid");
    await (await phone(on, m.room, m.credential)).next("joined");
    p.close();
    m.c.close();
  });

  test("the pairing QR code's way in needs it too, and isn't spent by the refusal", async () => {
    const m = await mac(on, forRoom({ expIn: 2 }));
    const c = randomBytes(32);
    m.c.send({ type: "pairing", credential: sha256hex(c), ttl: 60 });
    await new Promise((r) => setTimeout(r, 2_500));
    const refused = await phone(on, m.room, c);
    assert.equal((await refused.next("error")).code, "plan_required");
    assert.deepEqual(await m.c.next("phone_refused"), { type: "phone_refused", code: "plan_required", pass: "expired", pairing: true });
    m.c.send({ type: "pass", pass: forRoom({ claims: { plan: "trial" } })(m.room) });
    assert.equal((await m.c.next("pass")).pass, "valid");
    const p = await phone(on, m.room, c);
    await p.next("joined");
    assert.equal((await m.c.next("open")).pairing, true);
    p.close();
    m.c.close();
  });
});

describe("requirePass on: a pass in the upgrade, and an account's rooms", () => {
  let tight: LocalRelay | undefined;
  let capped: LocalRelay | undefined;
  before(async () => {
    [tight, capped] = await Promise.all([
      // One waiting socket per address, one Mac waiting: a stranger at the Mac's own address fills both.
      startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: JSON.stringify({ requirePass: true, pendingPerIp: 1, macPending: 1, ...MANY_ROOMS }) }),
      startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: JSON.stringify({ requirePass: true, roomsPerAccount: 2, ...ONE_ADDRESS }) }),
    ]);
  });
  after(async () => {
    await Promise.all([tight?.dispose(), capped?.dispose()]);
  });

  test("a Mac with a good pass in its upgrade waits outside the budgets: strangers holding them (even from its own address) don't keep it out; without one it would be turned away", async () => {
    const key = ed25519Pair();
    const room = roomOf(key.public);
    const stranger = new Client(`${tight!.url}/v1/mac/${room}`);
    await stranger.next("challenge");
    // Without the header: the address's one waiting slot is the stranger's.
    await assert.rejects(new Client(`${tight!.url}/v1/mac/${room}`).opened());
    const m = await mac(tight!, forRoom(), key, forRoom());
    assert.equal(m.ready.pass, "valid");
    assert.equal(stranger.closeCode, null, "the stranger isn't let go for it either");
    stranger.close();
    m.c.close();
  });

  test("one waiting socket per account with a pass in the upgrade: a newer one replaces it (timeout)", async () => {
    const room = roomOf(ed25519Pair().public);
    const pass = forRoom()(room);
    const first = new Client(`${tight!.url}/v1/mac/${room}`, { "Kiko-Relay-Pass": pass });
    await first.next("challenge");
    const second = new Client(`${tight!.url}/v1/mac/${room}`, { "Kiko-Relay-Pass": pass });
    await second.next("challenge");
    assert.equal((await first.next("error")).code, "timeout");
    assert.equal(second.closeCode, null);
    second.close();
  });

  test("an account opens at most roomsPerAccount rooms a day: past it, the upgrade with its pass is refused (HTTP 429); a room it opened still opens; another account isn't touched", async () => {
    const acct = (sub: string) => forRoom({ claims: { sub } });
    const keys = [ed25519Pair(), ed25519Pair(), ed25519Pair()];
    const first = await mac(capped!, acct("acct_cap"), keys[0], acct("acct_cap"));
    first.c.close();
    (await mac(capped!, acct("acct_cap"), keys[1], acct("acct_cap"))).c.close();
    const third = roomOf(keys[2].public);
    await assert.rejects(new Client(`${capped!.url}/v1/mac/${third}`, { "Kiko-Relay-Pass": acct("acct_cap")(third) }).opened());
    (await mac(capped!, acct("acct_cap"), keys[0], acct("acct_cap"))).c.close();
    (await mac(capped!, acct("acct_other"), keys[2], acct("acct_other"))).c.close();
  });

  test("the pass only in auth (a Mac from before the header): past the cap, refused at sign-in (too_many_rooms, 4016)", async () => {
    const acct = forRoom({ claims: { sub: "acct_cap_auth" } });
    (await mac(capped!, acct)).c.close();
    (await mac(capped!, acct)).c.close();
    const { c, answer } = await signIn(capped!, acct);
    assert.deepEqual(answer, { type: "error", code: "too_many_rooms" });
    assert.equal(await c.closed(), 4016);
  });
});

describe("requirePass on, the JWKS unreachable (an outage)", () => {
  test("no JWKS ever fetched: a pass with good claims is unverified and the Mac refused (never taken on trust); an expired one is expired", async () => {
    await refusedMac(outage, forRoom(), "unverified");
    await refusedMac(outage, forRoom({ expIn: -1 }), "expired");
  });

  test("the keys last fetched, kept in KV: a fresh relay that can't reach the JWKS still checks passes with them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-relay-pass-"));
    try {
      // Up: the JWKS fetched, and kept.
      const up = await startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: REQUIRE }, { persist: dir });
      try {
        const m = await mac(up, forRoom());
        assert.equal(m.ready.pass, "valid");
        m.c.close();
      } finally {
        await up.dispose();
      }
      // The account server away, a new isolate (nothing in memory): the kept keys check it.
      const down = await startRelay({ PASS_JWKS_URL: "http://127.0.0.1:9/jwks", RELAY_LIMITS: REQUIRE }, { persist: dir });
      try {
        const m = await mac(down, forRoom());
        assert.equal(m.ready.pass, "valid");
        const p = await phone(down, m.room, m.credential);
        await joinedAndTalking(m, p);
        p.close();
        m.c.close();
        // Checked, not trusted: a forged signature is invalid; a key id the kept keys lack can't be checked (unverified), both refused.
        for (const [pass, status] of [
          [forRoom({ signWith: makeKey(jwks.keys[0].kid) }), "invalid"],
          [forRoom({ key: makeKey() }), "unverified"],
        ] as const)
          await refusedMac(down, pass, status);
      } finally {
        await down.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requirePass on, the revocation list (PASS_REVOKED, as the account service writes it)", () => {
  // Written before the relay starts (support.ts writeKv): the account `acct_banned`, the account
  // `acct_test` on one Mac's room only, and an entry past its `until` (KV removes those on its own).
  const dir = mkdtempSync(join(tmpdir(), "kiko-relay-revoked-"));
  const now = Math.floor(Date.now() / 1000);
  const at = now - 100;
  const signedOutMac = ed25519Pair();
  const entry = (until = at + 26 * 3600) => JSON.stringify({ at, until });
  let listed: LocalRelay | undefined;
  let listedOff: LocalRelay | undefined;

  before(async () => {
    await writeKv(dir, "PASS_REVOKED", {
      "sub:acct_banned": entry(),
      [`room:acct_test:${roomOf(signedOutMac.public)}`]: entry(),
      "sub:acct_lapsed": entry(now - 1),
    });
    listed = await startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: REQUIRE }, { persist: dir });
  });
  after(async () => {
    await listed?.dispose();
    await listedOff?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A pass issued before the entries (`iat` 200 s ago) or after them (now), for `sub`. */
  const issued = (when: "before" | "after", sub = "acct_test") => forRoom({ claims: { sub, iat: when === "before" ? now - 200 : Math.floor(Date.now() / 1000) } });

  test("an account on the list: its pass from before is refused at sign-in (the Mac hears revoked, as a phone_refused too for a Mac from before); one issued after works at once", async () => {
    const { c, answer } = await signIn(listed!, issued("before", "acct_banned"));
    assert.deepEqual(answer, { type: "error", code: "plan_required", pass: "revoked" });
    assert.deepEqual(c.texts.shift(), { type: "phone_refused", code: "plan_required", pass: "revoked" });
    assert.equal(await c.closed(), 4014);
    // Signed in again (or subscribed again): a pass issued after the entry.
    const m = await mac(listed!, issued("after", "acct_banned"));
    await (await phone(listed!, m.room, m.credential)).next("joined");
    m.c.close();
  });

  test("one Mac signed out: its room's pass from before is refused; the same account's other Macs are not", async () => {
    await refusedMac(listed!, issued("before"), "revoked", signedOutMac);
    const other = await mac(listed!, issued("before"));
    await (await phone(listed!, other.room, other.credential)).next("joined");
    other.c.close();
    // That Mac signed in again: a new pass works.
    const back = await mac(listed!, issued("after"), signedOutMac);
    await (await phone(listed!, back.room, back.credential)).next("joined");
    back.c.close();
  });

  test("an entry past its until counts for nothing; an account not on the list joins", async () => {
    for (const sub of ["acct_lapsed", "acct_someone"]) {
      const m = await mac(listed!, issued("before", sub));
      await (await phone(listed!, m.room, m.credential)).next("joined");
      m.c.close();
    }
  });

  test("requirePass off: the list isn't read, and the phone joins as before", async () => {
    await listed?.dispose();
    listed = undefined;
    listedOff = await startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: OFF }, { persist: dir });
    const m = await mac(listedOff, issued("before", "acct_banned"));
    await (await phone(listedOff, m.room, m.credential)).next("joined");
    m.c.close();
  });
});

describe("requirePass on: a revocation cuts the phones already in (L5)", () => {
  let cut: LocalRelay | undefined;
  before(async () => {
    // The list read again at most every 200 ms; the alarm comes at least every idleMs while a phone is in.
    cut = await startRelay({ PASS_JWKS_URL: jwksUrl, RELAY_LIMITS: JSON.stringify({ requirePass: true, revokedCacheMs: 200, idleMs: 1_500, ...ONE_ADDRESS, ...MANY_ROOMS }) });
  });
  after(async () => {
    await cut?.dispose();
  });

  test("written to the list while a phone talks: within the alarm's beat the phone goes (plan_required, 4014), the Mac hears revoked and stays; a new pass lets phones in again", async () => {
    const iat = Math.floor(Date.now() / 1000);
    const m = await mac(cut!, forRoom({ claims: { sub: "acct_cut", iat } }));
    const p = await phone(cut!, m.room, m.credential);
    const pinger = setInterval(() => {
      m.c.send("ping");
      if (p.closeCode === null) p.send("ping");
    }, 300);
    try {
      const channel = await joinedAndTalking(m, p);
      await cut!.kvPut!("PASS_REVOKED", "sub:acct_cut", JSON.stringify({ at: iat + 1, until: iat + 26 * 3600 }));
      assert.equal((await p.next("error", 5_000)).code, "plan_required");
      assert.equal(await p.closed(), 4014);
      assert.deepEqual(await m.c.next("phone_refused", 5_000), { type: "phone_refused", code: "plan_required", pass: "revoked" });
      assert.deepEqual(await m.c.next("closed"), { type: "closed", channel });
      assert.equal(m.c.closeCode, null);
      // A phone trying now: refused (revoked) until the Mac shows a pass issued after the entry.
      await refusedForPlan(m, await phone(cut!, m.room, m.credential), "revoked");
      m.c.send({ type: "pass", pass: forRoom({ claims: { sub: "acct_cut", iat: iat + 2 } })(m.room) });
      assert.equal((await m.c.next("pass")).pass, "valid");
      const again = await phone(cut!, m.room, m.credential);
      await again.next("joined");
      again.close();
    } finally {
      clearInterval(pinger);
      m.c.close();
    }
  });
});
