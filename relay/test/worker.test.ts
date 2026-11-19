// The relay Worker itself (src/index.ts), run locally (support.ts): a Mac signing in to its room, a
// phone's credential accepted and refused, frames passed both ways behind their channels, several
// phones at once, a Mac that reconnects, the Mac letting a phone go and forgetting one, the
// pairing QR code's way in (one phone per registration, used, shut, expired, the Mac's own refusal,
// its cap). The relay pass: test/pass.test.ts.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { authMessage, ed25519Pair, ed25519Sign, roomOf, type Ed25519Pair } from "../../src/remote/tunnel.ts";
import { Client, NO_PASS, onChannel, sha256hex, startRelay, type LocalRelay } from "./support.ts";

let relay: LocalRelay;
before(async () => {
  relay = await startRelay({ RELAY_LIMITS: JSON.stringify(NO_PASS) });
});
after(async () => {
  await relay?.dispose();
});

/** A Mac's socket, signed in to its room (or refused: `sign` changes what it signs with). */
async function mac(key: Ed25519Pair, o: { sign?: (room: string, nonce: Buffer) => Buffer; room?: string } = {}) {
  const room = o.room ?? roomOf(key.public);
  const c = new Client(`${relay.url}/v1/mac/${room}`);
  const challenge = await c.next("challenge");
  const nonce = Buffer.from(challenge.nonce, "base64");
  assert.equal(nonce.length, 32);
  const sig = o.sign ? o.sign(room, nonce) : ed25519Sign(key.seed, authMessage(room, nonce));
  c.send({ type: "auth", key: key.public.toString("base64"), sig: sig.toString("base64") });
  return { c, room };
}

/** A Mac signed in, with these credentials registered (to its own room, unless given its key: one address may open only so many). */
async function readyMac(credentials: Buffer[] = [], key = ed25519Pair()) {
  const m = await mac(key);
  await m.c.next("ready");
  m.c.send({ type: "phones", credentials: credentials.map(sha256hex) });
  // The room has them once it answers a message after: a ping, answered by the room itself, comes back in order.
  await new Promise((r) => setTimeout(r, 50));
  return { ...m, key };
}

async function phone(room: string, credential: Buffer, extra: Record<string, unknown> = {}) {
  const c = new Client(`${relay.url}/v1/phone/${room}`);
  await c.opened();
  c.send({ type: "join", credential: credential.toString("base64"), ...extra });
  return c;
}

describe("a Mac signing in", () => {
  test("its signature over the room and the nonce opens its room: ready", async () => {
    const { c } = await mac(ed25519Pair());
    assert.deepEqual(
      await c.next("ready"),
      { type: "ready", pairing: true, pass: "missing", passRequired: false },
      "ready, it takes the pairing QR code's way in, and (no pass shown, none required) says so",
    );
    c.send("ping");
    assert.deepEqual(await c.next("pong"), { type: "pong" }, "pings are answered");
    c.close();
  });

  test("a bad signature, another Mac's room, or something else first: refused and closed", async () => {
    const key = ed25519Pair();
    const bad = await mac(key, { sign: () => randomBytes(64) });
    assert.equal((await bad.c.next("error")).code, "unauthorized");
    assert.equal(await bad.c.closed(), 4001);

    // A key whose room this isn't, signing correctly.
    const other = await mac(ed25519Pair(), { room: roomOf(key.public) });
    assert.equal((await other.c.next("error")).code, "unauthorized");
    assert.equal(await other.c.closed(), 4001);

    // A signature for another nonce (replayed from an earlier sign-in).
    const replay = await mac(key, { sign: (room) => ed25519Sign(key.seed, authMessage(room, randomBytes(32))) });
    assert.equal(await replay.c.closed(), 4001);

    const garbage = new Client(`${relay.url}/v1/mac/${roomOf(key.public)}`);
    await garbage.next("challenge");
    garbage.send("hello");
    assert.equal(await garbage.closed(), 4006);
  });

  test("not a room, not a WebSocket, not a path: refused before any room", async () => {
    const base = relay.url.replace(/^ws/, "http");
    assert.equal((await fetch(`${base}/v1/mac/nope`)).status, 400);
    assert.equal((await fetch(`${base}/v1/mac/${"a".repeat(32)}`)).status, 426);
    assert.equal((await fetch(`${base}/`)).status, 404);
  });
});

describe("phones", () => {
  test("a registered credential joins; the Mac is told its channel; frames go both ways, behind it", async () => {
    const credential = randomBytes(32);
    const m = await readyMac([credential]);
    const p = await phone(m.room, credential);
    assert.deepEqual(await p.next("joined"), { type: "joined" });
    const { channel } = await m.c.next("open");
    assert.ok(Number.isInteger(channel) && channel > 0);

    p.send(new Uint8Array([1, 2, 3]));
    const up = await m.c.frame();
    assert.deepEqual([...up], [...onChannel(channel, new Uint8Array([1, 2, 3]))]);

    m.c.send(onChannel(channel, new Uint8Array([9, 8, 7, 6])));
    assert.deepEqual([...(await p.frame())], [9, 8, 7, 6]);

    // Text from a joined phone is only ever its pings: nothing reaches the Mac.
    p.send("ping");
    assert.deepEqual(await p.next("pong"), { type: "pong" });
    p.close();
    assert.deepEqual(await m.c.next("closed"), { type: "closed", channel });
    m.c.close();
  });

  test("refused: a credential not registered, a malformed one, no join first, and no Mac in the room", async () => {
    const credential = randomBytes(32);
    const m = await readyMac([credential]);
    const stranger = await phone(m.room, randomBytes(32));
    assert.equal((await stranger.next("error")).code, "unauthorized");
    assert.equal(await stranger.closed(), 4001);

    const malformed = await phone(m.room, Buffer.alloc(0));
    assert.equal(await malformed.closed(), 4001);

    const rude = new Client(`${relay.url}/v1/phone/${m.room}`);
    await rude.opened();
    rude.send(new Uint8Array([1]));
    assert.equal(await rude.closed(), 4006);

    m.c.close();
    await new Promise((r) => setTimeout(r, 100));
    const early = await phone(m.room, credential);
    assert.equal((await early.next("error")).code, "mac_offline");
    assert.equal(await early.closed(), 4003);
  });

  test("several phones: each its own channel, each frame to the right one", async () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const m = await readyMac([a, b]);
    const pa = await phone(m.room, a);
    await pa.next("joined");
    const ca = (await m.c.next("open")).channel;
    const pb = await phone(m.room, b);
    await pb.next("joined");
    const cb = (await m.c.next("open")).channel;
    assert.notEqual(ca, cb);
    // The same credential twice (the phone reconnecting before its old socket went) is two channels.
    const pa2 = await phone(m.room, a);
    await pa2.next("joined");
    const ca2 = (await m.c.next("open")).channel;
    assert.ok(![ca, cb].includes(ca2));

    m.c.send(onChannel(cb, new Uint8Array([2])));
    m.c.send(onChannel(ca, new Uint8Array([1])));
    assert.deepEqual([...(await pb.frame())], [2]);
    assert.deepEqual([...(await pa.frame())], [1]);
    assert.equal(pa2.frames.length, 0);

    pb.send(new Uint8Array([5]));
    pa.send(new Uint8Array([4]));
    const got = [await m.c.frame(), await m.c.frame()].map((f) => [new DataView(f.buffer).getUint32(0), f[4]]);
    assert.deepEqual(
      new Map(got as [number, number][]),
      new Map([
        [cb, 5],
        [ca, 4],
      ]),
    );
    for (const c of [pa, pb, pa2, m.c]) c.close();
  });

  test("the Mac lets a phone go, and forgetting a phone (its credential dropped) closes it", async () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const m = await readyMac([a, b]);
    const pa = await phone(m.room, a);
    await pa.next("joined");
    const ca = (await m.c.next("open")).channel;
    const pb = await phone(m.room, b);
    await pb.next("joined");
    await m.c.next("open");

    m.c.send({ type: "close", channel: ca });
    assert.equal(await pa.closed(), 1000);

    m.c.send({ type: "phones", credentials: [sha256hex(a)] });
    assert.equal(await pb.closed(), 4001);
    const again = await phone(m.room, b);
    assert.equal(await again.closed(), 4001, "and it can't join again");
    m.c.close();
  });

  test("the Mac reconnects: the old socket is replaced, its phones are let go, and they join the new one", async () => {
    const credential = randomBytes(32);
    const first = await readyMac([credential]);
    const p = await phone(first.room, credential);
    await p.next("joined");
    await first.c.next("open");

    const second = await mac(first.key);
    await second.c.next("ready");
    assert.equal(await first.c.closed(), 4000, "the old one replaced");
    assert.equal(await p.closed(), 4002, "its phone told the Mac went");

    // The credentials stay with the room across the Mac's reconnect.
    const back = await phone(first.room, credential);
    await back.next("joined");
    const { channel } = await second.c.next("open");
    second.c.send(onChannel(channel, new Uint8Array([42])));
    assert.deepEqual([...(await back.frame())], [42]);

    // The Mac going takes its phones with it.
    second.c.close();
    assert.equal(await back.closed(), 4002);
  });
});

describe("the pairing QR code's way in", () => {
  /** The Mac opens it for the credential drawn from a code's secret (its hash only), for `ttl` seconds. */
  const open = (m: { c: Client }, credential: Buffer, ttl = 300) => m.c.send({ type: "pairing", credential: sha256hex(credential), ttl });
  const settle = () => new Promise((r) => setTimeout(r, 50));
  // One room for all of these (the relay lets one address open only so many new ones an hour), its Mac signing in again each time.
  const itsMac = ed25519Pair();
  const ready = (credentials: Buffer[] = []) => readyMac(credentials, itsMac);

  test("one phone per registration, on a channel marked pairing; the next hears it's used; opened again, another may", async () => {
    const credential = randomBytes(32);
    const m = await ready();
    open(m, credential);
    await settle();
    const p = await phone(m.room, credential);
    assert.deepEqual(await p.next("joined"), { type: "joined" });
    const opened = await m.c.next("open");
    assert.equal(opened.pairing, true);
    // Frames pass as for any phone.
    p.send(new Uint8Array([4, 1, 2]));
    assert.deepEqual([...(await m.c.frame())], [...onChannel(opened.channel, new Uint8Array([4, 1, 2]))]);
    // A second phone with the same code: spent.
    const second = await phone(m.room, credential);
    assert.equal((await second.next("error")).code, "qr_used");
    assert.equal(await second.closed(), 4012);
    // The Mac's own phones changing doesn't touch the phone in on the code (it's no credential of theirs).
    m.c.send({ type: "phones", credentials: [sha256hex(randomBytes(32))] });
    await settle();
    m.c.send(onChannel(opened.channel, new Uint8Array([7])));
    assert.deepEqual([...(await p.frame())], [7]);
    // That phone didn't pair (it went): the Mac opens the code again, and the next phone gets in.
    p.close();
    await m.c.next("closed");
    open(m, credential);
    await settle();
    const third = await phone(m.room, credential);
    await third.next("joined");
    assert.equal((await m.c.next("open")).pairing, true);
    third.close();
    m.c.close();
  });

  test("shut by the Mac: expired (closed), or used (it paired); a code it never opened is unauthorized; and a Mac's phones' credentials join as ever, unmarked", async () => {
    const credential = randomBytes(32);
    const own = randomBytes(32);
    const m = await ready([own]);
    open(m, credential);
    m.c.send({ type: "pairing", credential: null });
    await settle();
    const closed = await phone(m.room, credential);
    assert.equal((await closed.next("error")).code, "qr_expired");
    assert.equal(await closed.closed(), 4013);
    open(m, credential);
    m.c.send({ type: "pairing", credential: null, used: true });
    await settle();
    const used = await phone(m.room, credential);
    assert.equal((await used.next("error")).code, "qr_used");
    // Another code replaces it: the first is unknown now.
    open(m, randomBytes(32));
    await settle();
    const replaced = await phone(m.room, credential);
    assert.equal((await replaced.next("error")).code, "unauthorized");
    const mine = await phone(m.room, own);
    await mine.next("joined");
    assert.equal((await m.c.next("open")).pairing, undefined);
    mine.close();
    m.c.close();
  });

  test("it runs out (the ttl the Mac gave, never more than five minutes from its first registration); the Mac offline doesn't spend it", async () => {
    const credential = randomBytes(32);
    const m = await ready();
    open(m, credential, 1);
    await settle();
    // Its Mac gone: mac_offline, and the code isn't spent by it.
    const key = m.key;
    m.c.close();
    await settle();
    const early = await phone(m.room, credential);
    assert.equal((await early.next("error")).code, "mac_offline");
    const back = await mac(key);
    await back.c.next("ready");
    const p = await phone(back.room, credential);
    await p.next("joined");
    p.close();
    await back.c.next("closed");
    // Opened again for longer: it keeps the life it had (1 s), then runs out.
    open(back, credential, 300);
    await new Promise((r) => setTimeout(r, 1_100));
    const late = await phone(back.room, credential);
    assert.equal((await late.next("error")).code, "qr_expired");
    assert.equal(await late.closed(), 4013);
    back.c.close();
  });

  test("the Mac's close of a pairing channel can say why (qr_used, qr_expired); anything else is a plain close", async () => {
    const credential = randomBytes(32);
    const m = await ready();
    for (const code of ["qr_used", "qr_expired", "bad_code"]) {
      open(m, credential);
      await settle();
      const p = await phone(m.room, credential);
      await p.next("joined");
      const { channel } = await m.c.next("open");
      m.c.send({ type: "close", channel, code });
      if (code === "bad_code") assert.equal(await p.closed(), 1000);
      else {
        assert.equal((await p.next("error")).code, code);
        assert.equal(await p.closed(), code === "qr_used" ? 4012 : 4013);
      }
      await m.c.next("closed");
    }
    m.c.close();
  });

  test("a code lets five phones in over its life at most, however often it's opened again; a malformed registration is ignored", async () => {
    const credential = randomBytes(32);
    const m = await ready();
    for (let i = 0; i < 5; i++) {
      open(m, credential);
      await settle();
      const p = await phone(m.room, credential);
      await p.next("joined");
      await m.c.next("open");
      p.close();
      await m.c.next("closed");
    }
    open(m, credential);
    await settle();
    const sixth = await phone(m.room, credential);
    assert.equal((await sixth.next("error")).code, "qr_expired");
    // Not a hash, no ttl: nothing changes (and nothing is said back).
    const other = randomBytes(32);
    m.c.send({ type: "pairing", credential: "nope", ttl: 300 });
    m.c.send({ type: "pairing", credential: sha256hex(other) });
    await settle();
    const p = await phone(m.room, other);
    assert.equal((await p.next("error")).code, "unauthorized");
    assert.equal(m.c.texts.filter((t) => t.type === "error").length, 0);
    m.c.close();
  });
});
