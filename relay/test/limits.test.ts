// The relay's limits (src/limits.ts; protocol/README.md, "Relay": limits), each with the
// Worker run locally (support.ts): a frame too big (the default's edge, a whole tunnel record passing),
// text too big before signing in, too many messages too fast, a room over its byte budget (its 10
// minutes and its day), sockets that never sign in, each role's own budget of waiting sockets (the
// oldest let go, so strangers can't keep the Mac out), the per-address limits in a room, half-open
// sockets, and too many new rooms from one address (counted in shared state). Most run on a relay of
// their own with smaller numbers (RELAY_LIMITS, set as a plain var), so they're quick; the rest on the
// code's defaults. Never production's numbers: those live only in its secret. requirePass is off here
// (NO_PASS) but where a test says otherwise: the pass is test/pass.test.ts's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, test } from "node:test";
import { authMessage, ed25519Pair, ed25519Sign, roomOf } from "../../src/remote/tunnel.ts";
import { Client, NO_PASS, onChannel, sha256hex, startRelay, type LocalRelay } from "./support.ts";

const relays: LocalRelay[] = [];
after(async () => {
  await Promise.all(relays.map((r) => r.dispose()));
});

/** A relay of its own, with these limits in place of the defaults (and requirePass off, generous per-address limits, unless they say). */
async function relayWith(limits: Record<string, unknown> = {}) {
  const r = await startRelay({ RELAY_LIMITS: JSON.stringify({ ...NO_PASS, ...limits }) });
  relays.push(r);
  return r.url;
}

/** A socket from the address `ip` (CF-Connecting-IP, which a local relay takes as the client sends it). */
const from = (url: string, ip: string) => new Client(url, { "CF-Connecting-IP": ip });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Mac signed in to a room of its own, with these credentials registered. */
async function readyMac(url: string, credentials: Buffer[] = []) {
  const key = ed25519Pair();
  const room = roomOf(key.public);
  const c = new Client(`${url}/v1/mac/${room}`);
  const { nonce } = await c.next("challenge");
  c.send({ type: "auth", key: key.public.toString("base64"), sig: ed25519Sign(key.seed, authMessage(room, Buffer.from(nonce, "base64"))).toString("base64") });
  await c.next("ready");
  c.send({ type: "phones", credentials: credentials.map(sha256hex) });
  await wait(50);
  return { c, room, key };
}

/** A phone joined to the room: its socket and its channel, as the Mac was told. */
async function joined(url: string, mac: { c: Client; room: string }, credential: Buffer) {
  const p = new Client(`${url}/v1/phone/${mac.room}`);
  await p.opened();
  p.send({ type: "join", credential: credential.toString("base64") });
  await p.next("joined");
  const { channel } = await mac.c.next("open");
  return { p, channel };
}

describe("RELAY_LIMITS on the Worker", () => {
  test("not valid JSON, or none at all: the relay runs on its defaults, which fail closed (a Mac with no pass is refused: plan_required, 4014)", async () => {
    for (const vars of [{ RELAY_LIMITS: "{not json" }, {}] as Record<string, string>[]) {
      const r = await startRelay(vars);
      relays.push(r);
      const key = ed25519Pair();
      const room = roomOf(key.public);
      const c = new Client(`${r.url}/v1/mac/${room}`);
      const { nonce } = await c.next("challenge");
      c.send({ type: "auth", key: key.public.toString("base64"), sig: ed25519Sign(key.seed, authMessage(room, Buffer.from(nonce, "base64"))).toString("base64") });
      assert.deepEqual(await c.next("error"), { type: "error", code: "plan_required", pass: "missing" });
      assert.equal(await c.closed(), 4014);
    }
  });

  test("requirePass turned off explicitly: a Mac with no pass signs in, a phone joins, a frame passes", async () => {
    const url = await relayWith({ requirePass: false });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p } = await joined(url, m, credential);
    p.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...(await m.c.frame())], [0, 0, 0, 1, 1, 2, 3]);
    p.close();
    m.c.close();
  });
});

describe("message size (the defaults)", () => {
  test("a whole tunnel record (1 MiB of plaintext, its type byte and tag) passes both ways; anything bigger closes the socket: too_big, 4008", async () => {
    const url = await relayWith();
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p, channel } = await joined(url, m, credential);
    const record = randomBytes(1024 * 1024 + 17);
    p.send(record);
    const up = await m.c.frame(10_000);
    assert.equal(up.length, 4 + record.length);
    m.c.send(onChannel(channel, record));
    assert.equal((await p.frame(10_000)).length, record.length);

    p.send(randomBytes(1024 * 1024 + 2048));
    assert.equal((await p.next("error")).code, "too_big");
    assert.equal(await p.closed(), 4008);
    assert.deepEqual(await m.c.next("closed"), { type: "closed", channel });
    m.c.close();
  });

  test("before signing in only small text: a big first message is too_big, never looked at", async () => {
    const url = await relayWith();
    const key = ed25519Pair();
    const c = new Client(`${url}/v1/mac/${roomOf(key.public)}`);
    await c.next("challenge");
    c.send(JSON.stringify({ type: "auth", key: "x".repeat(20_000), sig: "" }));
    assert.equal(await c.closed(), 4008);

    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const p = new Client(`${url}/v1/phone/${m.room}`);
    await p.opened();
    p.send(randomBytes(64 * 1024));
    assert.equal(await p.closed(), 4008);
    m.c.close();
  });
});

describe("rate: messages per second per socket, with a burst", () => {
  test("a phone within its burst gets every frame through; one past it is closed: rate_limited, 4009", async () => {
    const url = await relayWith({ phoneRate: { perSecond: 5, burst: 10 } });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    // The join was the bucket's first message.
    const { p, channel } = await joined(url, m, credential);
    for (let i = 0; i < 8; i++) p.send(new Uint8Array([i]));
    for (let i = 0; i < 8; i++) assert.equal((await m.c.frame())[4], i);
    // Refilled at 5 a second: a second's wait is five more.
    await wait(1_000);
    for (let i = 0; i < 5; i++) p.send(new Uint8Array([i]));
    for (let i = 0; i < 5; i++) await m.c.frame();

    for (let i = 0; i < 30; i++) p.send(new Uint8Array([i]));
    assert.equal(await p.closed(), 4009);
    assert.equal(p.texts.find((x) => x.type === "error")?.code, "rate_limited");
    assert.deepEqual(await m.c.next("closed"), { type: "closed", channel });
    assert.ok(m.c.frames.length < 30, "not all of them passed");
    m.c.close();
  });

  test("the Mac's bucket is its own (bigger: it speaks to every phone), and past it the Mac is closed too", async () => {
    const url = await relayWith({ phoneRate: { perSecond: 1, burst: 2 }, macRate: { perSecond: 5, burst: 20 } });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p, channel } = await joined(url, m, credential);
    for (let i = 0; i < 15; i++) m.c.send(onChannel(channel, new Uint8Array([i])));
    for (let i = 0; i < 15; i++) assert.equal((await p.frame())[0], i);
    for (let i = 0; i < 40; i++) m.c.send(onChannel(channel, new Uint8Array([i])));
    assert.equal(await m.c.closed(), 4009);
    assert.equal(await p.closed(), 4002, "and its phone goes with it");
  });
});

describe("a room's byte budget", () => {
  test("over its window's bytes: the phone is closed (over_quota, 4010, with retryIn), the Mac told and kept, joins refused until the window's over", async () => {
    const url = await relayWith({ windowBytes: 64 * 1024, windowMs: 3_000 });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p } = await joined(url, m, credential);
    const chunk = randomBytes(10 * 1024);
    for (let i = 0; i < 8; i++) p.send(chunk);
    const err = await p.next("error");
    assert.equal(err.code, "over_quota");
    assert.ok(err.retryIn >= 1 && err.retryIn <= 3, `retryIn ${err.retryIn}`);
    assert.equal(await p.closed(), 4010);
    assert.equal(m.c.frames.length, 6, "the six that fit passed, both ways counted together");
    const told = await m.c.next("error");
    assert.equal(told.code, "over_quota");
    assert.equal(m.c.closeCode, null, "the Mac stays signed in");

    const refused = new Client(`${url}/v1/phone/${m.room}`);
    await refused.opened();
    refused.send({ type: "join", credential: credential.toString("base64") });
    assert.equal((await refused.next("error")).code, "over_quota");
    assert.equal(await refused.closed(), 4010);

    await wait(err.retryIn * 1000 + 200);
    m.c.frames.length = 0;
    const again = await joined(url, m, credential);
    again.p.send(new Uint8Array([7]));
    assert.equal((await m.c.frame())[4], 7);
    again.p.close();
    m.c.close();
  });

  test("over its day's bytes: the same, with retryIn the rest of the day", async () => {
    const url = await relayWith({ dayBytes: 32 * 1024 });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p, channel } = await joined(url, m, credential);
    for (let i = 0; i < 5; i++) m.c.send(onChannel(channel, randomBytes(8 * 1024)));
    const err = await p.next("error");
    assert.equal(err.code, "over_quota");
    assert.ok(err.retryIn > 23 * 3600 && err.retryIn <= 24 * 3600, `retryIn ${err.retryIn}`);
    assert.equal(await p.closed(), 4010);
    assert.equal(p.frames.length, 3);
    assert.equal((await m.c.next("error")).code, "over_quota");
    m.c.close();
  });
});

describe("signing in", () => {
  test("nothing from a socket that hasn't signed in or joined is passed along: its first wrong message closes it", async () => {
    const url = await relayWith();
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const { p } = await joined(url, m, credential);

    // A second Mac's socket for the same room, not signed in, trying to send a phone a frame.
    const impostor = new Client(`${url}/v1/mac/${m.room}`);
    await impostor.next("challenge");
    impostor.send(onChannel(1, new Uint8Array([6, 6, 6])));
    assert.equal(await impostor.closed(), 4006);
    // A phone that hasn't joined, trying to reach the Mac.
    const stranger = new Client(`${url}/v1/phone/${m.room}`);
    await stranger.opened();
    stranger.send(new Uint8Array([6, 6, 6]));
    assert.equal(await stranger.closed(), 4006);
    await wait(100);
    assert.equal(p.frames.length, 0);
    assert.equal(m.c.frames.length, 0);
    p.close();
    m.c.close();
  });

  test("one that says nothing is closed after signInMs (timeout, 4005); then there's room again", async () => {
    const url = await relayWith({ signInMs: 1_000 });
    const room = roomOf(ed25519Pair().public);
    const quiet = [0, 1, 2].map(() => new Client(`${url}/v1/phone/${room}`));
    await Promise.all(quiet.map((c) => c.opened()));
    // Each pings once (answered by the runtime, so the room still hears nothing from it). A socket that
    // never sent a byte gets the error and the close frame all the same, but locally workerd never
    // finishes its closing handshake, so Node's close event wouldn't come. On Cloudflare it does, ~10 s
    // after the close frame (checked against the deployed relay, then fala-relay at relay.fala.sh, now kiko-relay, 2026-11-01: error at 10 s, 4005 at 20 s).
    for (const c of quiet) c.send("ping");
    for (const c of quiet) assert.equal(await c.closed(3_000), 4005);
    const next = new Client(`${url}/v1/phone/${room}`);
    await next.opened();
    next.close();
  });
});

describe("waiting sockets: each role's own budget, and per address (M8: a room id is in the QR code)", () => {
  /** Opened and pinged (so a close sent to it comes back locally: see the timeout test). */
  async function waitingOne(c: Client) {
    await c.opened();
    c.send("ping");
    await c.next("pong");
    return c;
  }

  test("phones over `pending`: the oldest waiting phone goes (timeout, 4005) for the new one, never refused", async () => {
    const url = await relayWith({ pending: 3 });
    const room = roomOf(ed25519Pair().public);
    const quiet: Client[] = [];
    for (let i = 0; i < 3; i++) quiet.push(await waitingOne(new Client(`${url}/v1/phone/${room}`)));
    const fourth = await waitingOne(new Client(`${url}/v1/phone/${room}`));
    assert.equal(await quiet[0].closed(3_000), 4005, "the oldest let go at once, long before signInMs");
    assert.equal(quiet[1].closeCode, null);
    assert.equal(fourth.closeCode, null);
    for (const c of [...quiet, fourth]) c.close();
  });

  test("strangers holding every phone slot and more never keep the Mac out: it signs in, and its phones still join", async () => {
    const url = await relayWith({ pending: 3 });
    const key = ed25519Pair();
    const room = roomOf(key.public);
    const strangers: Client[] = [];
    for (let i = 0; i < 6; i++) strangers.push(await waitingOne(from(`${url}/v1/phone/${room}`, `198.51.100.${i + 1}`)));
    const c = new Client(`${url}/v1/mac/${room}`);
    const { nonce } = await c.next("challenge");
    c.send({ type: "auth", key: key.public.toString("base64"), sig: ed25519Sign(key.seed, authMessage(room, Buffer.from(nonce, "base64"))).toString("base64") });
    await c.next("ready");
    const credential = randomBytes(32);
    c.send({ type: "phones", credentials: [sha256hex(credential)] });
    await wait(50);
    // The Mac's real phone, arriving while the strangers still wait: in.
    const { p } = await joined(url, { c, room }, credential);
    p.close();
    c.close();
    for (const s of strangers) s.close();
  });

  test("Macs' waiting sockets have their own budget (`macPending`): over it, the oldest goes; phones waiting don't count against it", async () => {
    const url = await relayWith({ pending: 2, macPending: 2 });
    const room = roomOf(ed25519Pair().public);
    const phones = [await waitingOne(new Client(`${url}/v1/phone/${room}`)), await waitingOne(new Client(`${url}/v1/phone/${room}`))];
    const macs: Client[] = [];
    for (let i = 0; i < 2; i++) {
      const c = new Client(`${url}/v1/mac/${room}`);
      await c.next("challenge");
      macs.push(c);
    }
    const third = new Client(`${url}/v1/mac/${room}`);
    await third.next("challenge");
    assert.equal((await macs[0].next("error")).code, "timeout");
    assert.equal(macs[1].closeCode, null);
    assert.equal(phones[0].closeCode, null, "no phone let go for a Mac");
    for (const c of [...phones, ...macs, third]) c.close();
  });

  test("one address holds at most `pendingPerIp` waiting sockets in a room (HTTP 429 after); another address, or another room, isn't touched; IPv6 counts by its /64", async () => {
    const url = await relayWith({ pendingPerIp: 2 });
    const room = roomOf(ed25519Pair().public);
    const held = [await waitingOne(from(`${url}/v1/phone/${room}`, "203.0.113.5")), await waitingOne(from(`${url}/v1/mac/${room}`, "203.0.113.5"))];
    await assert.rejects(from(`${url}/v1/phone/${room}`, "203.0.113.5").opened(), "a third, any role");
    const other = await waitingOne(from(`${url}/v1/phone/${room}`, "203.0.113.6"));
    const elsewhere = await waitingOne(from(`${url}/v1/phone/${roomOf(ed25519Pair().public)}`, "203.0.113.5"));
    const v6 = [await waitingOne(from(`${url}/v1/phone/${room}`, "2001:db8:1:2::1")), await waitingOne(from(`${url}/v1/phone/${room}`, "2001:db8:1:2:ffff::9"))];
    await assert.rejects(from(`${url}/v1/phone/${room}`, "2001:db8:1:2:0:0:0:abcd").opened(), "the same /64");
    const v6other = await waitingOne(from(`${url}/v1/phone/${room}`, "2001:db8:1:3::1"));
    for (const c of [...held, other, elsewhere, ...v6, v6other]) c.close();
  });

  test("one address opens new sockets to a room at `ipRate` (HTTP 429 past its burst); another address isn't touched", async () => {
    const url = await relayWith({ ipRate: { perSecond: 0.2, burst: 3 } });
    const room = roomOf(ed25519Pair().public);
    for (let i = 0; i < 3; i++) {
      const c = from(`${url}/v1/phone/${room}`, "203.0.113.7");
      await c.opened();
      c.close();
    }
    await assert.rejects(from(`${url}/v1/phone/${room}`, "203.0.113.7").opened());
    const other = from(`${url}/v1/phone/${room}`, "203.0.113.8");
    await other.opened();
    other.close();
  });

  test("half-open: a Mac with no sign of life for idleMs is let go when a phone comes (idle, 4011), and the phone told mac_offline", async () => {
    const url = await relayWith({ idleMs: 1_500 });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    await wait(1_800);
    const p = new Client(`${url}/v1/phone/${m.room}`);
    await p.opened();
    p.send({ type: "join", credential: credential.toString("base64") });
    assert.equal((await p.next("error")).code, "mac_offline");
    assert.equal(await m.c.closed(), 4011);
  });

  test("a Mac that pings stays; a joined phone that goes quiet is let go by the alarm (idle, 4011), and the Mac told", async () => {
    const url = await relayWith({ idleMs: 1_500 });
    const credential = randomBytes(32);
    const m = await readyMac(url, [credential]);
    const pinger = setInterval(() => m.c.send("ping"), 300);
    try {
      const { p, channel } = await joined(url, m, credential);
      assert.equal(await p.closed(5_000), 4011);
      assert.deepEqual(await m.c.next("closed"), { type: "closed", channel });
      assert.equal(m.c.closeCode, null, "the Mac, answered by the runtime's pong, is alive");
      // And a phone that keeps talking stays past idleMs.
      const live = await joined(url, m, credential);
      for (let i = 0; i < 6; i++) {
        live.p.send(new Uint8Array([i]));
        await wait(400);
      }
      assert.equal(live.p.closeCode, null);
      live.p.close();
    } finally {
      clearInterval(pinger);
      m.c.close();
    }
  });
});

describe("new rooms per address", () => {
  test("past roomsPerIpHour new rooms as a Mac from one address: HTTP 429; a room it already opened still opens; another address isn't touched", async () => {
    const url = await relayWith({ roomsPerIpHour: 3 });
    const macs = [];
    for (let i = 0; i < 3; i++) macs.push(await readyMac(url));
    const fourth = new Client(`${url}/v1/mac/${roomOf(ed25519Pair().public)}`);
    await assert.rejects(fourth.opened());
    // The first Mac reconnecting: its own room.
    const back = new Client(`${url}/v1/mac/${macs[0].room}`);
    await back.next("challenge");
    back.close();
    const elsewhere = from(`${url}/v1/mac/${roomOf(ed25519Pair().public)}`, "192.0.2.44");
    await elsewhere.next("challenge");
    elsewhere.close();
    for (const m of macs) m.c.close();
  });

  test("counted in shared state, not only an isolate's memory: with the isolate's map forgetting at once (ipsTracked 1), the address is still held to it", async () => {
    const url = await relayWith({ roomsPerIpHour: 2, ipsTracked: 1 });
    const open = async (ip: string) => {
      const c = from(`${url}/v1/mac/${roomOf(ed25519Pair().public)}`, ip);
      await c.next("challenge");
      c.close();
    };
    // Each other address pushes this one out of the isolate's map.
    await open("192.0.2.1");
    await open("192.0.2.2");
    await open("192.0.2.1");
    await open("192.0.2.2");
    await assert.rejects(from(`${url}/v1/mac/${roomOf(ed25519Pair().public)}`, "192.0.2.1").opened());
  });
});
