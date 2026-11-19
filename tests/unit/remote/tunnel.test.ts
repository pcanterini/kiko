// The relay's tunnel (src/remote/tunnel.ts): Noise IK checked against the Noise community's own test
// vector (cacophony's Noise_IK_25519_ChaChaPoly_SHA256), our vectors (protocol/relay-vectors.json)
// made again from their inputs, the handshake both ways, and what must fail: an altered, replayed
// or reordered record, a phone with the wrong Mac's key, a Mac that isn't the one paired with, a
// low-order key; the Mac's sign-in signature and the room it names. ChaCha20-Poly1305 (@noble/ciphers)
// against RFC 8439 and node:crypto's own, and the vectors under Bun, which the release runs on.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RELAY_EXAMPLES, relayValues, relayVectors } from "../../../scripts/relay-vectors.ts";
import {
  authMessage,
  closeBody,
  closeOf,
  dh,
  ed25519Pair,
  ed25519Sign,
  ed25519Verify,
  initiate,
  open,
  openRecord,
  prologueOf,
  RECORD,
  respond,
  roomOf,
  seal,
  sealRecord,
  selfCheck,
  TunnelError,
  x25519Pair,
} from "../../../src/remote/tunnel.ts";

const h = (x: string) => Buffer.from(x, "hex");

test("Noise IK matches cacophony's test vector for Noise_IK_25519_ChaChaPoly_SHA256", () => {
  // From github.com/haskell-cryptography/cacophony, vectors/cacophony.txt.
  const prologue = h("4a6f686e2047616c74");
  const mac = x25519Pair(h("4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893"));
  assert.equal(mac.public.toString("hex"), "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62");
  const phone = initiate({
    prologue,
    local: x25519Pair(h("e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1")),
    remote: mac.public,
    ephemeral: x25519Pair(h("893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a")),
    payload: h("4c756477696720766f6e204d69736573"),
  });
  assert.equal(
    phone.message.toString("hex"),
    "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7",
  );
  const read = respond({ prologue, local: mac, message: phone.message, ephemeral: x25519Pair(h("bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b")) });
  assert.equal(read.payload.toString(), "Ludwig von Mises");
  const answer = read.answer(h("4d757272617920526f746862617264"));
  assert.equal(answer.message.toString("hex"), "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5");
  const session = phone.finish(answer.message);
  assert.equal(session.payload.toString(), "Murray Rothbard");
  assert.equal(session.hash.toString("hex"), "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7");
  assert.equal(session.send.seal(h("462e20412e20486179656b")).toString("hex"), "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8");
  assert.equal(answer.session.send.seal(h("4361726c204d656e676572")).toString("hex"), "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667");
  assert.equal(answer.session.receive.open(h("050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8")).toString(), "F. A. Hayek");
});

test("protocol/relay-vectors.json is made again, byte for byte, from its inputs", () => {
  const file = JSON.parse(readFileSync(new URL("../../../protocol/relay-vectors.json", import.meta.url), "utf8"));
  assert.deepEqual(relayVectors(), file);
});

test("the example messages carry the vectors' room, keys and credential (scripts/relay-vectors.ts writes both)", () => {
  const want = relayValues();
  for (const name of RELAY_EXAMPLES) {
    const m = JSON.parse(readFileSync(new URL(`../../../protocol/examples/${name}`, import.meta.url), "utf8"));
    const relay = m.addresses.find((a: { kind: string }) => a.kind === "relay");
    if (m.type === "relay_paired" || name.includes("relay")) assert.equal(relay.room, want.room, `${name}: the relay address's room`);
    if (m.type === "welcome") assert.equal(m.macKey, want.macKey, `${name}: the Mac's key`);
    if (m.type === "relay_paired") assert.deepEqual([m.room, m.macKey, m.signingKey, m.credential], [want.room, want.macKey, want.signingKey, want.credential], name);
  }
});

test("the vectors open as the other side would: each record with the other side's key, in order", () => {
  const v = relayVectors();
  const macStatic = x25519Pair(h(v.keys.macStaticPrivate));
  const read = respond({ prologue: prologueOf(v.keys.room), local: macStatic, message: h(v.handshake.message1).subarray(1), ephemeral: x25519Pair(h(v.keys.macEphemeralPrivate)) });
  assert.equal(read.remote.toString("hex"), v.keys.phoneStaticPublic, "the Mac learns the phone's static key");
  const { session: mac } = read.answer();
  const phone = initiate({
    prologue: prologueOf(v.keys.room),
    local: x25519Pair(h(v.keys.phoneStaticPrivate)),
    remote: macStatic.public,
    ephemeral: x25519Pair(h(v.keys.phoneEphemeralPrivate)),
  }).finish(h(v.handshake.message2));
  for (const r of v.records) {
    const opened = openRecord(r.from === "phone" ? mac.receive : phone.receive, h(r.frame));
    assert.equal(opened.type, r.recordType);
    assert.equal(Buffer.concat([Buffer.from([opened.type]), opened.body]).toString("hex"), r.plaintext);
  }
  assert.ok(ed25519Verify(h(v.keys.macSigningPublic), h(v.macSignIn.signed), h(v.macSignIn.signature)));
  assert.equal(roomOf(h(v.keys.macSigningPublic)), v.keys.room);
});

/** A phone and a Mac, paired: their keys, and a fresh tunnel between them. */
function pairUp(room = "0123456789abcdef0123456789abcdef") {
  const mac = x25519Pair();
  const phone = x25519Pair();
  const open = () => {
    const hs = initiate({ prologue: prologueOf(room), local: phone, remote: mac.public });
    const read = respond({ prologue: prologueOf(room), local: mac, message: hs.message });
    const { message, session } = read.answer();
    return { phone: hs.finish(message), mac: session, remote: read.remote };
  };
  return { mac, phone, room, open };
}

test("the handshake both ways: the Mac learns the phone's key; text, binary, ping, pong and close go each way", () => {
  const p = pairUp();
  const t = p.open();
  assert.ok(t.remote.equals(p.phone.public));
  assert.ok(t.phone.hash.equals(t.mac.hash), "the same handshake hash on both sides");
  const json = JSON.stringify({ v: 1, type: "type", text: "hello" });
  assert.equal(openRecord(t.mac.receive, sealRecord(t.phone.send, RECORD.text, Buffer.from(json))).body.toString(), json);
  const opus = Buffer.from([1, 2, 0, 1, 0xaa]);
  const back = openRecord(t.phone.receive, sealRecord(t.mac.send, RECORD.binary, opus));
  assert.equal(back.type, RECORD.binary);
  assert.ok(back.body.equals(opus));
  assert.equal(openRecord(t.phone.receive, sealRecord(t.mac.send, RECORD.ping)).type, RECORD.ping);
  assert.equal(openRecord(t.mac.receive, sealRecord(t.phone.send, RECORD.pong)).type, RECORD.pong);
  const closed = openRecord(t.phone.receive, sealRecord(t.mac.send, RECORD.close, closeBody(4001, "unauthorized")));
  assert.deepEqual(closeOf(closed.body), { code: 4001, reason: "unauthorized" });
  // Each connection's keys are its own: a second tunnel between the same two shares nothing with the first.
  const again = p.open();
  assert.ok(!again.phone.send.key.equals(t.phone.send.key));
  assert.ok(!again.phone.hash.equals(t.phone.hash));
});

test("an altered record, a replayed one, one out of order, or one from the other direction doesn't open", () => {
  const t = pairUp().open();
  const first = sealRecord(t.phone.send, RECORD.text, Buffer.from("one"));
  const second = sealRecord(t.phone.send, RECORD.text, Buffer.from("two"));
  const third = sealRecord(t.phone.send, RECORD.text, Buffer.from("three"));
  // Out of order: the second where the first is expected.
  assert.throws(
    () => openRecord(t.mac.receive, second),
    (e: unknown) => e instanceof TunnelError && e.code === "bad_record",
  );
  assert.equal(openRecord(t.mac.receive, first).body.toString(), "one");
  // Replayed: the first again.
  assert.throws(() => openRecord(t.mac.receive, first), /didn't open/);
  // Altered: one bit of the ciphertext, then of the tag.
  const flipped = Buffer.from(second);
  flipped[3] ^= 1;
  assert.throws(() => openRecord(t.mac.receive, flipped), /didn't open/);
  const tag = Buffer.from(second);
  tag[tag.length - 1] ^= 0x80;
  assert.throws(() => openRecord(t.mac.receive, tag), /didn't open/);
  assert.equal(openRecord(t.mac.receive, second).body.toString(), "two", "a bad record doesn't move the counter");
  // The phone's own record, read back by the phone (the wrong direction's key).
  assert.throws(() => openRecord(t.phone.receive, third), /didn't open/);
  assert.throws(() => openRecord(t.mac.receive, Buffer.alloc(10)), /shorter than its tag/);
});

test("the wrong keys fail the handshake: a phone with another Mac's key, a Mac not the one paired, another room", () => {
  const p = pairUp();
  const stranger = x25519Pair();
  // The phone dials with a key that isn't this Mac's: the Mac can't read its first message.
  const wrong = initiate({ prologue: prologueOf(p.room), local: p.phone, remote: stranger.public });
  const step = (s: string) => (e: unknown) => e instanceof TunnelError && e.code === "bad_handshake" && e.step === s;
  assert.throws(() => respond({ prologue: prologueOf(p.room), local: p.mac, message: wrong.message }), step("not_for_this_mac"));
  // Someone holding only the Mac's public key answers as the Mac: the phone refuses the answer.
  const hs = initiate({ prologue: prologueOf(p.room), local: p.phone, remote: p.mac.public });
  const impostor = Buffer.concat([x25519Pair().public, Buffer.alloc(16)]);
  assert.throws(() => hs.finish(impostor), /not the Mac paired with/);
  // The same keys for another room (prologue): refused.
  const elsewhere = initiate({ prologue: prologueOf("ffffffffffffffffffffffffffffffff"), local: p.phone, remote: p.mac.public });
  assert.throws(() => respond({ prologue: prologueOf(p.room), local: p.mac, message: elsewhere.message }), step("not_for_this_mac"));
  // A first message cut short, or altered (its static key, or the payload after it).
  assert.throws(() => respond({ prologue: prologueOf(p.room), local: p.mac, message: hs.message.subarray(0, 60) }), step("short"));
  const altered = Buffer.from(hs.message);
  altered[40] ^= 1;
  assert.throws(() => respond({ prologue: prologueOf(p.room), local: p.mac, message: altered }), step("not_for_this_mac"));
  const payload = Buffer.from(hs.message);
  payload[90] ^= 1;
  assert.throws(() => respond({ prologue: prologueOf(p.room), local: p.mac, message: payload }), step("payload"));
});

test("a low-order public key is refused (an all-zero shared secret)", () => {
  assert.throws(() => dh(x25519Pair().private, Buffer.alloc(32)), /low-order/);
  const hs = initiate({ prologue: prologueOf("0".repeat(32)), local: x25519Pair(), remote: x25519Pair().public });
  const lowOrder = Buffer.concat([Buffer.alloc(32), hs.message.subarray(32)]);
  assert.throws(
    () => respond({ prologue: prologueOf("0".repeat(32)), local: x25519Pair(), message: lowOrder }),
    (e: unknown) => e instanceof TunnelError && e.step === "ephemeral",
  );
});

test("ChaCha20-Poly1305 matches node:crypto's (itself checked against RFC 8439 2.8.2), and refuses a changed tag or AD", () => {
  const nodeSeal = (key: Buffer, nonce: Buffer, ad: Buffer, text: Buffer) => {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: text.length });
    return Buffer.concat([c.update(text), c.final(), c.getAuthTag()]);
  };
  const key = h("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  const ad = h("50515253c0c1c2c3c4c5c6c7");
  const text = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  assert.equal(nodeSeal(key, h("070000004041424344454647"), ad, text).subarray(-16).toString("hex"), "1ae10b594f09e26a7e902ecbd0600691", "node:crypto is RFC 8439's");
  // Ours against node:crypto's (Node has it; Bun doesn't), on random keys, counters, AD and lengths.
  for (let i = 0; i < 200; i++) {
    const k = randomBytes(32);
    const n = randomBytes(8).readBigUInt64LE();
    const a = randomBytes(i % 40);
    const p = randomBytes(i * 7);
    const theirs = nodeSeal(k, Buffer.concat([Buffer.alloc(4), counterLE(n)]), a, p);
    assert.ok(seal(k, n, a, p).equals(theirs));
    assert.ok(open(k, n, a, theirs).equals(p));
  }
  const out = seal(key, 7n, ad, text);
  assert.equal(open(key, 7n, ad, out).toString(), text.toString());
  const tagged = Buffer.from(out);
  tagged[tagged.length - 1] ^= 1;
  const badRecord = (e: unknown) => e instanceof TunnelError && e.code === "bad_record";
  assert.throws(() => open(key, 7n, ad, tagged), badRecord);
  assert.throws(() => open(key, 7n, Buffer.from("other"), out), badRecord);
  assert.throws(() => open(key, 8n, ad, out), badRecord);
});

function counterLE(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

test("selfCheck: this runtime runs a whole handshake and a record each way", () => {
  assert.equal(selfCheck(), null);
});

test("under Bun too, which the release is built with: the vectors byte for byte (skipped without bun)", (t) => {
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status !== 0) return t.skip("no bun on PATH");
  const script = fileURLToPath(new URL("../../../scripts/relay-vectors.ts", import.meta.url));
  const run = spawnSync("bun", [script, "--check"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, `bun ${bun.stdout.trim()}: ${run.stdout}${run.stderr}`);
});

test("the Mac's sign-in: its signature over the context, room and nonce; another key's, or another nonce, fails", () => {
  const signing = ed25519Pair();
  const room = roomOf(signing.public);
  assert.match(room, /^[0-9a-f]{32}$/);
  const nonce = Buffer.alloc(32, 7);
  const sig = ed25519Sign(signing.seed, authMessage(room, nonce));
  assert.ok(ed25519Verify(signing.public, authMessage(room, nonce), sig));
  assert.ok(!ed25519Verify(signing.public, authMessage(room, Buffer.alloc(32, 8)), sig));
  assert.ok(!ed25519Verify(ed25519Pair().public, authMessage(room, nonce), sig));
  assert.deepEqual(ed25519Pair(signing.seed), signing, "the same pair from its seed");
});
