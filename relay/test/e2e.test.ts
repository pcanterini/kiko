// End to end: the hub's own phone server and relay client (src/remote/) with the real relay Worker
// run locally, and a fake phone speaking the encrypted tunnel (tests/support/relay-phone.ts). The
// phone pairs at home and sets itself up for the relay; then, through the relay only: hello,
// welcome, a press (talk_start, its audio, talk_end) and a typed message, each with what became of
// it, and the Mac's relay socket dropped and dialled again. And a phone away from home pairing by the
// QR code through the relay: pair and relay_pair on the one connection, then in as any phone; the
// code used, closed, and one the relay doesn't know. Proves the existing server works through
// the tunnel unchanged. Hermetic as the hub's unit tests (tests/setup.ts): no Keychain, no real
// config, a temporary folder for phones.json. With KIKO_RELAY_TEST_URL (e.g. wss://relay.kiko.sh)
// the same run goes through that deployed relay instead, with keys made fresh for it (support.ts).
import "../../tests/setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LocalPhone } from "../../tests/support/local-phone.ts";
import { Pairing } from "../../src/remote/pairing.ts";
import { RelayClient } from "../../src/remote/relay-client.ts";
import { newIdentity } from "../../src/remote/relay-identity.ts";
import { PhoneServer, type PhoneHub } from "../../src/remote/server.ts";
import { x25519Pair } from "../../src/remote/tunnel.ts";
import { RelayPhone } from "../../tests/support/relay-phone.ts";
import { relayForEndToEnd, type LocalRelay } from "./support.ts";

const did: string[] = [];
let audio = 0;
let server: PhoneServer;
let talking = false;
const hub: PhoneHub = {
  talkStart(_sessionId, phoneId, talkId) {
    did.push("talk_start");
    talking = true;
    if (talkId) setImmediate(() => server.talkStatus(phoneId, { talkId, stage: "heard", text: "run the tests" }));
    return null;
  },
  talkAudio: (pcm) => void (audio += pcm.length),
  talkEnd(cancel) {
    did.push(cancel ? "talk_cancel" : "talk_end");
    talking = false;
  },
  type(text, _sessionId, phoneId, talkId) {
    did.push(`type:${text}`);
    if (talkId) setImmediate(() => server.talkStatus(phoneId, { talkId, stage: "answered" }));
    return null;
  },
  permission: () => null,
  answers: () => null,
  talking: () => talking,
  playOnMac: () => {},
  catchUp: () => {},
  catchUpSummary: () => {},
  catchUpStop: () => false,
};

let relay: LocalRelay;
let client: RelayClient;
let port = 0;
const identity = newIdentity();
const pairing = new Pairing(join(process.cwd(), "phones-e2e.json"));

before(async () => {
  relay = await relayForEndToEnd();
  server = new PhoneServer({
    hub,
    pairing,
    port: 0,
    host: "127.0.0.1",
    opus: null,
    identity,
    network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "Test-Mac.local" },
    relay: { url: relay.url, room: identity.room, macKey: identity.static.public.toString("base64"), signingKey: identity.signing.public.toString("base64") },
  });
  port = await server.start();
  client = new RelayClient({ url: relay.url, identity, pairing, server, retryMs: { min: 50, max: 200 } });
  client.start();
  await until(() => client.status === "connected");
});

after(async () => {
  client?.stop();
  server?.stop();
  await relay?.dispose();
});

async function until<T>(check: () => T, ms = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** At home: pair with the code, then relay_pair. What the phone keeps. */
async function pairAtHome() {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ v: 1, type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" }));
  const paired = await until(() => got.find((m) => m.type === "paired"));
  assert.equal((await until(() => got.find((m) => m.type === "welcome"))).relay, true);
  const key = x25519Pair();
  ws.send(JSON.stringify({ v: 1, type: "relay_pair", key: key.public.toString("base64") }));
  const rp = await until(() => got.find((m) => m.type === "relay_paired"));
  ws.close();
  return { token: paired.token as string, phoneId: paired.phoneId as string, key, rp };
}

test("through the real relay: hello, welcome, a press and a typed message, each with its talk_status", async () => {
  const p = await pairAtHome();
  const relayEntry = p.rp.addresses.find((a: any) => a.kind === "relay");
  const u = new URL(relay.url);
  assert.deepEqual(relayEntry, { kind: "relay", host: u.hostname, port: Number(u.port) || 443, url: relay.url, room: identity.room });
  // Give the Mac a moment to register the new credential with its room.
  await new Promise((r) => setTimeout(r, 100));

  const phone = new RelayPhone({ url: relayEntry.url, room: relayEntry.room, credential: p.rp.credential, macKey: Buffer.from(p.rp.macKey, "base64"), key: p.key });
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Test iPhone", appVersion: "0.1.0" });
  const welcome = await phone.next("welcome");
  assert.equal(welcome.phoneId, p.phoneId);
  assert.equal(welcome.relay, true);
  await phone.next("missed");
  phone.send({ type: "presence", state: "back" });

  phone.send({ type: "talk_start", talkId: "press-1" });
  assert.equal((await phone.next("talk_status")).stage, "heard");
  const pcm = Buffer.alloc(3200, 1).toString("base64"); // 100 ms of 16 kHz PCM
  phone.send({ type: "talk_audio", data: pcm });
  phone.send({ type: "talk_audio", data: pcm });
  phone.send({ type: "talk_end" });
  await until(() => did.includes("talk_end"));
  assert.equal(audio, 6400, "every byte of the press's audio reached the hub");

  phone.send({ type: "type", text: "and then deploy", talkId: "typed-1" });
  const status = await phone.next("talk_status");
  assert.deepEqual([status.talkId, status.stage], ["typed-1", "answered"]);
  assert.deepEqual(did, ["talk_start", "talk_end", "type:and then deploy"]);
  assert.deepEqual(
    server.connected().map((x) => x.id),
    [p.phoneId],
  );
  phone.close();
  await until(() => server.connected().length === 0);
});

test("the Mac's socket to the relay drops: it dials again, signs in, and the phone gets through again", async () => {
  const p = await pairAtHome();
  await new Promise((r) => setTimeout(r, 100));
  const dial = () => new RelayPhone({ url: p.rp.url, room: p.rp.room, credential: p.rp.credential, macKey: Buffer.from(p.rp.macKey, "base64"), key: p.key });
  const phone = dial();
  await phone.open();
  phone.send({ type: "hello", token: p.token, device: "Test iPhone", appVersion: "0.1.0" });
  await phone.next("welcome");

  // The relay connection dies under the Mac (a network change, the relay restarting).
  (client as unknown as { ws: { terminate(): void } }).ws.terminate();
  assert.equal(await phone.closed(), 4002, "the phone hears its Mac went");
  await until(() => client.status === "connected");
  await new Promise((r) => setTimeout(r, 100));

  const again = dial();
  await again.open();
  again.send({ type: "hello", token: p.token, device: "Test iPhone", appVersion: "0.1.0" });
  assert.equal((await again.next("welcome")).phoneId, p.phoneId);
  again.close();
});

test("pairing by the QR code from away, through the relay: pair, relay_pair on that connection, then in as any phone; used, closed and unknown codes said", async (t) => {
  // A deployed relay from before this (KIKO_RELAY_TEST_URL) doesn't take it: nothing to test there until it's deployed.
  if (!client.takesPairing) return t.skip("this relay is from before pairing through it");
  const offer = pairing.openQr();
  await new Promise((r) => setTimeout(r, 200)); // the room has the code's way in
  const phone = new RelayPhone({ url: relay.url, room: identity.room, qr: { secret: offer.secret } });
  await phone.open();
  phone.send({ type: "pair", code: offer.secret.toString("base64url"), device: "Away iPhone", appVersion: "0.1.0", key: phone.key.public.toString("base64") });
  const paired = await phone.next("paired");
  const welcome = await phone.next("welcome");
  assert.equal(welcome.macKey, server.macKey.toString("base64"));
  assert.equal(welcome.relay, true);
  phone.send({ type: "relay_pair", key: phone.key.public.toString("base64") });
  const rp = await phone.next("relay_paired");
  assert.equal(rp.room, identity.room);
  await new Promise((r) => setTimeout(r, 200)); // its new credential registered: this connection stays
  phone.send({ type: "type", text: "paired from away", talkId: "away-1" });
  assert.deepEqual([(await phone.next("talk_status")).stage, phone.closeCode], ["answered", null]);
  phone.close();

  // Used: another phone with the same code.
  const second = new RelayPhone({ url: relay.url, room: identity.room, qr: { secret: offer.secret } });
  await assert.rejects(second.open(), /qr_used/);
  assert.equal(await second.closed(), 4012);
  // Closed on the Mac (Esc).
  const closed = pairing.openQr();
  await new Promise((r) => setTimeout(r, 100));
  pairing.closeQr();
  await new Promise((r) => setTimeout(r, 200));
  const late = new RelayPhone({ url: relay.url, room: identity.room, qr: { secret: closed.secret } });
  await assert.rejects(late.open(), /qr_expired/);
  assert.equal(await late.closed(), 4013);
  // A secret no code here has: the relay doesn't know its credential.
  const stranger = new RelayPhone({ url: relay.url, room: identity.room, qr: { secret: randomBytes(16) } });
  await assert.rejects(stranger.open(), /unauthorized/);

  // In again as any phone set up for the relay: its keys, its credential, hello.
  const again = new RelayPhone({ url: rp.url, room: rp.room, credential: rp.credential, macKey: Buffer.from(rp.macKey, "base64"), key: phone.key });
  await again.open();
  again.send({ type: "hello", token: paired.token, device: "Away iPhone", appVersion: "0.1.0" });
  assert.equal((await again.next("welcome")).phoneId, paired.phoneId);
  again.close();
});
