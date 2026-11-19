// The Mac's end of the relay (src/remote/relay-client.ts) with a real phone server, against a
// stand-in relay in this process (tests/support/fake-relay.ts; the real Worker's tests are in
// relay/test/). A phone pairs on the home network and sets itself up for the relay (relay_pair),
// then comes through the tunnel: hello, welcome, a typed message and what became of it, a binary
// frame kept binary. And what's refused: a key the Mac doesn't know, another phone's token, pairing
// through the relay, a forgotten phone; and the Mac signing in again after the relay drops it. And
// pairing by the QR code from away: the code's way in registered with the room while it works, the
// qr opening on a pairing channel, pair and relay_pair on that one connection; a code used, closed
// or expired refused as such, a wrong secret let go, and a relay from before this sent nothing.
import "../../setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { qrIdOf, qrRelayCredentialOf } from "../../../src/remote/cpace.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { RelayClient } from "../../../src/remote/relay-client.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { credentialHash, prologueOf, RECORD, x25519Pair } from "../../../src/remote/tunnel.ts";
import { FakeRelay } from "../../support/fake-relay.ts";
import { RelayPhone } from "../../support/relay-phone.ts";
import { checkWaits } from "../../support/until.ts";

const typed: Array<{ text: string; phoneId: string }> = [];
let server: PhoneServer;
const hub: PhoneHub = {
  talkStart: () => null,
  talkAudio: () => {},
  talkEnd: () => {},
  type(text, _sessionId, phoneId, talkId) {
    typed.push({ text, phoneId });
    // What became of it goes back to the phone, as the app's would.
    if (talkId) setImmediate(() => server.talkStatus(phoneId, { talkId, stage: "answered" }));
    return null;
  },
  permission: () => null,
  answers: () => null,
  talking: () => false,
  playOnMac: () => {},
  catchUp: () => {},
  catchUpSummary: () => {},
  catchUpStop: () => false,
};

const relay = new FakeRelay();
const identity = newIdentity();
const pairing = new Pairing(join(process.cwd(), "phones-relay-client.json"));
let url = "";
let port = 0;
let client: RelayClient;

before(async () => {
  url = await relay.start();
  server = new PhoneServer({
    hub,
    pairing,
    port: 0,
    host: "127.0.0.1",
    opus: null,
    network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "Test-Mac.local" },
    relay: { url, room: identity.room, macKey: identity.static.public.toString("base64"), signingKey: identity.signing.public.toString("base64") },
  });
  port = await server.start();
  client = new RelayClient({ url, identity, pairing, server, retryMs: { min: 20, max: 100 }, handshakeMs: 500 });
  client.start();
  await until(() => client.status === "connected");
});

after(() => {
  client.stop();
  server.stop();
  relay.stop();
});

const until = checkWaits(5_000, 10);

/** A phone on the home network: pairs, then sets itself up for the relay. Its token, key and what relay_paired said. */
async function pairAtHome(device: string) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  await new Promise((r) => ws.once("open", r));
  const send = (m: Record<string, unknown>) => ws.send(JSON.stringify({ v: 1, ...m }));
  send({ type: "pair", code: pairing.open().code, device, appVersion: "0.1.0" });
  const paired = await until(() => got.find((m) => m.type === "paired"));
  const welcome = await until(() => got.find((m) => m.type === "welcome"));
  assert.equal(welcome.relay, true, "welcome says the relay is on");
  assert.ok(!paired.addresses.some((a: any) => a.kind === "relay"), "no relay entry before the phone is set up for it");
  const key = x25519Pair();
  send({ type: "relay_pair", key: key.public.toString("base64") });
  const rp = await until(() => got.find((m) => m.type === "relay_paired"));
  ws.close();
  return { token: paired.token as string, phoneId: paired.phoneId as string, key, rp };
}

const through = (p: { key: ReturnType<typeof x25519Pair>; rp: any }, key = p.key, o: { macKey?: Buffer; prologue?: Buffer } = {}) =>
  new RelayPhone({ url: p.rp.url, room: p.rp.room, credential: p.rp.credential, macKey: o.macKey ?? Buffer.from(p.rp.macKey, "base64"), key, prologue: o.prologue });

/** This test process's log lines for an event (tests/setup.ts puts the log in its own folder). */
function logged(event: string): any[] {
  const dir = process.env.KIKO_LOG_DIR!;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((l) => l.event === event);
}

test("relay_pair gives the phone the room, the Mac's keys and a credential; the room gets only its hash", async () => {
  const p = await pairAtHome("Phone A");
  assert.equal(p.rp.room, identity.room);
  assert.equal(p.rp.macKey, identity.static.public.toString("base64"));
  assert.equal(p.rp.signingKey, identity.signing.public.toString("base64"));
  assert.deepEqual(p.rp.addresses.at(-1), { kind: "relay", host: "127.0.0.1", port: relay.port, url, room: identity.room });
  await until(() => relay.credentials.length === 1);
  assert.ok(!relay.credentials.includes(p.rp.credential), "only the hash");
  assert.equal(pairing.list().find((x) => x.id === p.phoneId)?.relayKey, p.key.public.toString("base64"));
});

test("through the tunnel: hello, welcome (with the relay's entry), a typed message and its talk_status; a frame that isn't a record ends it", async () => {
  const p = await pairAtHome("Phone B");
  const phone = through(p);
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Phone B", appVersion: "0.1.0" });
  const welcome = await phone.next("welcome");
  assert.equal(welcome.phoneId, p.phoneId);
  assert.equal(welcome.addresses.at(-1).kind, "relay");
  await phone.next("missed");
  phone.send({ type: "type", text: "how is the build going", talkId: "t-1" });
  const status = await phone.next("talk_status");
  assert.deepEqual([status.talkId, status.stage], ["t-1", "answered"]);
  assert.deepEqual(typed.at(-1), { text: "how is the build going", phoneId: p.phoneId });
  // Bytes that aren't a sealed record: the relay passes them, the Mac can't open them, and lets the phone go.
  phone.ws.send(Buffer.from("not a record at all"));
  assert.equal(await phone.closed(), 1000);
});

test("a binary record goes in as a binary frame", async () => {
  const p = await pairAtHome("Phone C");
  const phone = through(p);
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Phone C", appVersion: "0.1.0" });
  await phone.next("welcome");
  // The server answers a binary frame from a connection that hasn't agreed on Opus as exactly that.
  phone.ws.send(phone.seal(RECORD.binary, Buffer.from([1, 1, 0, 1, 0xaa])));
  const error = await phone.next("error");
  assert.equal(error.code, "invalid");
  assert.match(error.message, /before agreeing on Opus/);
  phone.close();
});

test("refused: a phone key the Mac doesn't know; another phone's token; pairing or relay_pair through the relay", async () => {
  const p = await pairAtHome("Phone D");
  const other = await pairAtHome("Phone E");
  // The right credential, the wrong static key: the Mac can't place it, and lets it go.
  const stranger = through(p, x25519Pair());
  await stranger.open().catch(() => {});
  assert.equal(await stranger.closed(), 1000);

  const phone = through(p);
  await phone.open();
  phone.send({ type: "hello", token: other.token, device: "Phone D", appVersion: "0.1.0" });
  assert.equal((await phone.next("error")).code, "unauthorized");
  await phone.until(() => phone.closedBy);
  assert.equal(phone.closedBy?.code, 4001);

  const pairer = through(p);
  await pairer.open();
  pairer.send({ type: "pair", code: pairing.open().code, device: "Phone D", appVersion: "0.1.0" });
  assert.equal((await pairer.next("error")).code, "pairing_closed");
  pairing.close();

  // Nor relay_pair through the relay: a new credential would end the connection it came on.
  const again = through(p);
  await again.open();
  again.send({ type: "hello", token: p.token, device: "Phone D", appVersion: "0.1.0" });
  await again.next("welcome");
  again.send({ type: "relay_pair", key: x25519Pair().public.toString("base64") });
  assert.match((await again.next("error")).message, /at home/);
  again.close();
});

test("a refused handshake says why in the log, never a key: another Mac's key, another room, an unknown phone", async () => {
  const p = await pairAtHome("Phone H");
  const before = logged("relay_phone_refused").length;
  const refusals = () => logged("relay_phone_refused").slice(before);
  // Set up with another Mac's key (an older identity, or another flavour's).
  const otherMac = through(p, p.key, { macKey: x25519Pair().public });
  await otherMac.open().catch(() => {});
  assert.equal(await otherMac.closed(), 1000);
  // The handshake bound to another room (its prologue).
  const elsewhere = through(p, p.key, { prologue: prologueOf("f".repeat(32)) });
  await elsewhere.open().catch(() => {});
  assert.equal(await elsewhere.closed(), 1000);
  // A key no paired phone has.
  const stranger = through(p, x25519Pair());
  await stranger.open().catch(() => {});
  assert.equal(await stranger.closed(), 1000);
  await until(() => refusals().length >= 3);
  const said = refusals().map(({ why, step, phoneId }) => ({ why, step, phoneId }));
  assert.deepEqual(said, [
    { why: "handshake", step: "not_for_this_mac", phoneId: undefined },
    { why: "handshake", step: "not_for_this_mac", phoneId: undefined },
    { why: "unknown_key", step: undefined, phoneId: undefined },
  ]);
  const text = JSON.stringify(refusals());
  for (const secret of [p.key.public, identity.static.public, identity.signing.public]) assert.ok(!text.includes(secret.toString("base64")), "no key in the log");
});

test("a forgotten phone: its credential leaves the room and its tunnel closes", async () => {
  const p = await pairAtHome("Phone F");
  const phone = through(p);
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Phone F", appVersion: "0.1.0" });
  await phone.next("welcome");
  const hash = pairing.list().find((x) => x.id === p.phoneId)!.relayCredentialHash!;
  assert.ok(relay.credentials.includes(hash));
  server.forget(p.phoneId);
  await until(() => !relay.credentials.includes(hash));
  assert.ok((await phone.closed()) >= 1000);
});

test("the relay drops the Mac: it signs in again, and phones get through again", async () => {
  const p = await pairAtHome("Phone G");
  const before = relay.signIns;
  relay.dropMac();
  await until(() => relay.signIns > before && client.status === "connected");
  await until(() => relay.credentials.length > 0);
  const phone = through(p);
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Phone G", appVersion: "0.1.0" });
  assert.equal((await phone.next("welcome")).phoneId, p.phoneId);
  phone.close();
});

// 2026-11-13, with a real socket (the timings, on a clock of the test's own: relay-watchdog.test.ts):
// a relay that stops answering one socket's pings, as the socket made while a VPN came up did.
test("the relay stops answering pings: the Mac ends that socket itself and signs in again at once", async () => {
  const relay2 = new FakeRelay();
  const url2 = await relay2.start();
  const pairing2 = new Pairing(join(process.cwd(), "phones-relay-deaf.json"));
  // A failure would wait 5 s to dial again; no pong doesn't.
  const c = new RelayClient({ url: url2, identity: newIdentity(), pairing: pairing2, server: { adopt: () => {} }, retryMs: { min: 5_000, max: 5_000 }, pingMs: 60, pongMs: 60, network: false });
  c.start();
  try {
    await until(() => c.status === "connected");
    const first = relay2.mac;
    const drops = logged("relay_disconnected").length;
    relay2.deafTo = first;
    await until(() => relay2.signIns === 2 && c.status === "connected", 2_000);
    assert.notEqual(relay2.mac, first);
    assert.equal(logged("relay_disconnected").at(-1).why, "no pong");
    // The new socket's pings are answered: it's kept.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(relay2.signIns, 2);
    assert.equal(logged("relay_disconnected").length, drops + 1);
  } finally {
    c.stop();
    relay2.stop();
  }
});

test("relay_pair to a hub without the relay is refused, and welcome doesn't offer it", async () => {
  const plain = new PhoneServer({
    hub,
    pairing: new Pairing(join(process.cwd(), "phones-no-relay.json")),
    port: 0,
    host: "127.0.0.1",
    opus: null,
    network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "Test-Mac.local" },
  });
  const plainPort = await plain.start();
  try {
    const ws = new LocalPhone(`ws://127.0.0.1:${plainPort}`);
    const got: any[] = [];
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ v: 1, type: "pair", code: plain.pairing.open().code, device: "x", appVersion: "1" }));
    const welcome = await until(() => got.find((m) => m.type === "welcome"));
    assert.equal(welcome.relay, undefined);
    ws.send(JSON.stringify({ v: 1, type: "relay_pair", key: x25519Pair().public.toString("base64") }));
    assert.equal((await until(() => got.find((m) => m.type === "error"))).code, "invalid");
    ws.close();
  } finally {
    plain.stop();
  }
});

test("the tunnel's own records: the Mac's ping is answered with a pong; its close reaches the phone with the code", async () => {
  const relay2 = new FakeRelay();
  const url2 = await relay2.start();
  const id2 = newIdentity();
  const pairing2 = new Pairing(join(process.cwd(), "phones-relay-ping.json"));
  const adopted: Array<{ socket: any; phoneId: string | null }> = [];
  const c2 = new RelayClient({ url: url2, identity: id2, pairing: pairing2, server: { adopt: (socket, phoneId) => adopted.push({ socket, phoneId }) } });
  c2.start();
  try {
    await until(() => c2.status === "connected");
    const paired = pairing2.pair(pairing2.open().code, "Phone H");
    assert.ok(paired.ok);
    const key = x25519Pair();
    const credential = pairing2.setRelay(paired.phone.id, key.public.toString("base64"))!;
    await until(() => relay2.credentials.length === 1);
    const phone = new RelayPhone({ url: url2, room: id2.room, credential, macKey: id2.static.public, key });
    await phone.open();
    const { socket, phoneId } = await until(() => adopted[0]);
    assert.equal(phoneId, paired.phone.id);
    let pongs = 0;
    socket.on("pong", () => pongs++);
    socket.ping();
    await until(() => pongs === 1);
    assert.equal(phone.pings, 1);
    const closed: number[] = [];
    socket.on("close", (code: number) => closed.push(code));
    socket.close(4001, "unauthorized");
    await phone.until(() => phone.closedBy);
    assert.deepEqual(phone.closedBy, { code: 4001, reason: "unauthorized" });
    assert.deepEqual(closed, [4001], "closed once, with its code");
    assert.equal(socket.readyState, 3);
  } finally {
    c2.stop();
    relay2.stop();
  }
});

// ── Pairing by the QR code, from away ───────────────────────────────────────

const qrHash = (secret: Buffer) => credentialHash(qrRelayCredentialOf(secret));

/** A QR code shown, once the room has its way in. */
async function showQr() {
  const offer = pairing.openQr();
  await until(() => relay.pairing?.hash === qrHash(offer.secret) && relay.pairing.state === "open");
  return offer;
}

/** A phone away from home pairing by `secret` through the relay: joined, the qr opening, then pair. */
async function pairFromAway(secret: Buffer, device = "Away iPhone") {
  const phone = new RelayPhone({ url, room: identity.room, qr: { secret } });
  await phone.open();
  phone.send({ type: "pair", code: secret.toString("base64url"), device, appVersion: "0.1.0", key: phone.key.public.toString("base64") });
  return phone;
}

test("pairing by the QR code through the relay: its way in registered, pair on a pairing channel, then relay_pair on that same connection", async () => {
  const offer = await showQr();
  const said = relay.pairingSaid.at(-1);
  assert.ok(said.ttl > 290 && said.ttl <= 300, `the code's time left: ${said.ttl}`);
  assert.ok(!JSON.stringify(said).includes(qrRelayCredentialOf(offer.secret).toString("base64")), "only the credential's hash");
  const phone = await pairFromAway(offer.secret);
  assert.equal(relay.pairing?.state, "used", "one phone per registration");
  const paired = await phone.next("paired");
  const welcome = await phone.next("welcome");
  assert.equal(welcome.macKey, server.macKey.toString("base64"), "the Mac whose key the code shows");
  assert.equal(welcome.relay, true);
  assert.ok(!welcome.addresses.some((a: any) => a.kind === "relay"), "not set up for the relay yet");
  // The code is spent: the room hears it paired a phone, and the pairing screen would close.
  await until(() => relay.pairingSaid.at(-1)?.credential === null);
  assert.deepEqual(relay.pairingSaid.at(-1), { type: "pairing", credential: null, used: true });
  assert.equal(pairing.qrOpen(), null);
  const log = logged("phone_paired").at(-1);
  assert.deepEqual([log.how, log.via, log.phoneId], ["qr", "relay", paired.phoneId]);

  // Set up for the relay there and then: its new credential registered with the room doesn't end the connection it came on.
  phone.send({ type: "relay_pair", key: phone.key.public.toString("base64") });
  const rp = await phone.next("relay_paired");
  assert.equal(rp.room, identity.room);
  assert.equal(rp.addresses.at(-1).kind, "relay");
  await until(() => relay.credentials.includes(credentialHash(Buffer.from(rp.credential, "base64"))));
  phone.send({ type: "type", text: "paired from away", talkId: "away-1" });
  assert.equal((await phone.next("talk_status")).stage, "answered");
  assert.equal(phone.closeCode, null);
  phone.close();

  // From then on it comes through the relay as any paired phone: its credential, its keys, hello.
  const again = through({ key: phone.key, rp });
  await again.open();
  again.send({ type: "hello", token: paired.token, device: "Away iPhone", appVersion: "0.1.0" });
  assert.equal((await again.next("welcome")).phoneId, paired.phoneId);
  again.close();

  // Nothing of the code in the log: not the secret, its id, nor its credential or that one's hash.
  const all = readdirSync(process.env.KIKO_LOG_DIR!)
    .map((f) => readFileSync(join(process.env.KIKO_LOG_DIR!, f), "utf8"))
    .join("\n");
  for (const secret of [offer.secret.toString("base64url"), qrIdOf(offer.secret).toString("hex"), qrRelayCredentialOf(offer.secret).toString("base64"), qrHash(offer.secret)]) {
    assert.ok(!all.includes(secret), "nothing of the code logged");
  }
});

test("from away, a code used already, closed or one the Mac doesn't know is refused as such; a wrong secret is let go and the code opened again", async () => {
  // Used: a second phone with the same code hears so from the relay.
  const used = await showQr();
  const first = await pairFromAway(used.secret, "First iPhone");
  await first.next("welcome");
  first.close();
  const second = new RelayPhone({ url, room: identity.room, qr: { secret: used.secret } });
  await assert.rejects(second.open(), /qr_used/);
  assert.equal(await second.closed(), 4012);

  // Closed (Esc on the Mac): shut at the relay, and the phone hears it doesn't work any more.
  const closed = await showQr();
  pairing.closeQr();
  await until(() => relay.pairing?.state === "shut");
  assert.deepEqual(relay.pairingSaid.at(-1), { type: "pairing", credential: null });
  const late = new RelayPhone({ url, room: identity.room, qr: { secret: closed.secret } });
  await assert.rejects(late.open(), /qr_expired/);
  assert.equal(await late.closed(), 4013);

  // A code the Mac doesn't know (shown before it restarted): let in by the relay, refused by the Mac with the close.
  const unknown = randomBytes(16);
  relay.pairing = { hash: qrHash(unknown), until: Date.now() + 60_000, state: "open" };
  const stranger = new RelayPhone({ url, room: identity.room, qr: { secret: unknown } });
  await stranger.open().catch(() => {});
  assert.equal(await stranger.closed(), 4013);
  assert.deepEqual(stranger.relaySaid.at(-1), { type: "error", code: "qr_expired" });

  // A wrong secret for the code's id (the relay's view of it is all it could have): the first record
  // doesn't open, the channel goes with nothing said, and the code's way in opens again.
  const right = await showQr();
  const wrong = new RelayPhone({ url, room: identity.room, credential: qrRelayCredentialOf(right.secret).toString("base64"), qr: { secret: randomBytes(16), id: qrIdOf(right.secret) } });
  await wrong.open();
  wrong.send({ type: "pair", code: "x", device: "Wrong iPhone", appVersion: "0.1.0" });
  assert.equal(await wrong.closed(), 1000);
  assert.equal(logged("relay_phone_refused").at(-1).why, "bad_code");
  await until(() => relay.pairing?.state === "open");
  // A phone that joins and goes before pairing: opened again too.
  const gone = new RelayPhone({ url, room: identity.room, qr: { secret: right.secret } });
  await gone.open();
  gone.close();
  await until(() => relay.pairing?.state === "open");
  // And the phone with the code pairs.
  const ok = await pairFromAway(right.secret, "Right iPhone");
  assert.equal((await ok.next("welcome")).hubName, server.hubName);
  ok.close();
});

test("on a pairing channel only the qr opening, and only pair: the keys handshake, or hello, aren't taken there", async () => {
  // (Paired at home first: pairing either way closes the QR code shown.)
  const p = await pairAtHome("Phone Q");
  const offer = await showQr();
  // The keys handshake on the code's channel: let go (it's no paired phone's way in).
  const keysOnPairing = new RelayPhone({ url, room: identity.room, credential: qrRelayCredentialOf(offer.secret).toString("base64"), macKey: identity.static.public, key: p.key });
  await keysOnPairing.open().catch(() => {});
  assert.equal(await keysOnPairing.closed(), 1000);
  await until(() => relay.pairing?.state === "open");
  // hello with a paired phone's token, on the qr way: refused.
  const hello = new RelayPhone({ url, room: identity.room, qr: { secret: offer.secret } });
  await hello.open();
  hello.send({ type: "hello", token: p.token, device: "Phone Q", appVersion: "0.1.0" });
  assert.equal((await hello.next("error")).code, "unauthorized");
  pairing.closeQr();
});

test("a relay from before this (its ready says nothing of pairing) is sent no QR code's way in", async () => {
  const old = new FakeRelay({ oldRelay: true });
  const oldUrl = await old.start();
  const id = newIdentity();
  const pairingOld = new Pairing(join(process.cwd(), "phones-relay-old.json"));
  const c = new RelayClient({ url: oldUrl, identity: id, pairing: pairingOld, server: { adopt: () => {} } });
  c.start();
  try {
    await until(() => c.status === "connected");
    const offer = pairingOld.openQr();
    pairingOld.closeQr();
    pairingOld.openQr();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(old.pairingSaid, []);
    // A phone with the code: the relay doesn't know it.
    const phone = new RelayPhone({ url: oldUrl, room: id.room, qr: { secret: offer.secret } });
    await assert.rejects(phone.open(), /unauthorized/);
  } finally {
    c.stop();
    old.stop();
  }
});
