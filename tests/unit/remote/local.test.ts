// The phone's connection on the home network, encrypted (src/remote/local.ts, cpace.ts): CPace
// against the CFRG draft's own vector; nothing sensitive on the wire (the code, the token, the
// messages); pairing with the code and its wrong-code count; a phone paired before (its token only)
// moving to keys without pairing again; keys after that, and a token alone no longer enough; a stale
// key, an unknown key, a forgotten phone; a replayed, altered or plain-text frame ending the tunnel;
// and an app from before, told in the clear to update. On 127.0.0.1, throwaway phones.json files.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { relayVectors } from "../../../scripts/relay-vectors.ts";
import { CPACE_CI, cpaceInitiate, cpaceRespond, generator, qrIdOf, sessionOf, tokenIdOf, tokenSecret } from "../../../src/remote/cpace.ts";
import { pairUrl, parsePairUrl } from "../../../src/remote/pair-link.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { initiate, LOCAL_OPEN, LOCAL_PROLOGUE, openRecord, RECORD, respond, sealRecord, x25519Pair } from "../../../src/remote/tunnel.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { checkWaits } from "../../support/until.ts";

const h = (s: string) => Buffer.from(s, "hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = checkWaits(5000, 5);
const logged = (event: string): any[] =>
  readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);

// ── CPace ────────────────────────────────────────────────────────────────────

test("CPace matches the CFRG draft's own vector (draft-irtf-cfrg-cpace-21, B.1: X25519, SHA-512)", () => {
  const prs = Buffer.from("Password");
  const ci = h("0b415f696e69746961746f720b425f726573706f6e646572");
  const sid = h("7e4b4791d6a8ef019b936c79fb7f2c57");
  assert.equal(generator(prs, ci, sid).toString("hex"), "d04bf6d41f6a289632a2e929fa29bebd51092512a7829fdde7d314b62f05a73f");
  const inputs = { prs, ci, sid, ada: Buffer.from("ADa"), adb: Buffer.from("ADb") };
  const a = cpaceInitiate({ ...inputs, scalar: h("21b4f4bd9e64ed355c3eb676a28ebedaf6d8f17bdc365995b319097153044080") });
  assert.equal(a.share.toString("hex"), "1d13c89278cdadd826f6d8d7f887701430f8380ddc17611cdd6dc989ce0c9f32");
  const b = cpaceRespond({ ...inputs, theirs: a.share, scalar: h("848b0779ff415f0af4ea14df9dd1d3c29ac41d836c7808896c4eba19c51ac40a") });
  assert.equal(b.share.toString("hex"), "248cccf6d5cdc3646f0ad593f9e6cef4e69d4945f8372e623512ecea32185623");
  const isk = "6e19b875f7a561d6b3ca3dbb9ef42ac55de3e717881018204b8922b4d5e53bb2aa82c300bea7b65d2b671da71922ddf6472301b79bc270adfa8bf413285f2263";
  assert.equal(b.isk.toString("hex"), isk);
  assert.equal(a.finish(b.share).toString("hex"), isk);
});

test("CPace: a different code gives a different key, so the phone's first record doesn't open", () => {
  const a = cpaceInitiate({ prs: Buffer.from("123456"), ci: CPACE_CI.code });
  const b = cpaceRespond({ prs: Buffer.from("123457"), ci: CPACE_CI.code, theirs: a.share });
  const phone = sessionOf(a.finish(b.share), "phone");
  const mac = sessionOf(b.isk, "mac");
  assert.throws(() => openRecord(mac.receive, sealRecord(phone.send, RECORD.text, Buffer.from("{}"))), /didn't open/);
  // The same code: it opens, each way.
  const c = cpaceRespond({ prs: Buffer.from("123456"), ci: CPACE_CI.code, theirs: a.share });
  const phone2 = sessionOf(a.finish(c.share), "phone");
  const mac2 = sessionOf(c.isk, "mac");
  assert.equal(openRecord(mac2.receive, sealRecord(phone2.send, RECORD.text, Buffer.from("hi"))).body.toString(), "hi");
  assert.equal(openRecord(phone2.receive, sealRecord(mac2.send, RECORD.text, Buffer.from("yo"))).body.toString(), "yo");
});

test("the local vectors open as the other side would (protocol/relay-vectors.json, local)", () => {
  const v = relayVectors();
  const l = v.local;
  // keys: Noise IK with the home network's prologue.
  const read = respond({ prologue: LOCAL_PROLOGUE, local: x25519Pair(h(v.keys.macStaticPrivate)), message: h(l.keys.message1).subarray(1), ephemeral: x25519Pair(h(v.keys.macEphemeralPrivate)) });
  assert.equal(read.remote.toString("hex"), v.keys.phoneStaticPublic);
  const { message, session } = read.answer();
  assert.equal(message.toString("hex"), l.keys.message2);
  assert.equal(openRecord(session.receive, h(l.keys.records[0].frame as string)).body.toString(), l.keys.records[0].text);
  // code, token and qr: the Mac's side from the phone's first frame.
  for (const way of ["code", "token", "qr"] as const) {
    const x = l[way];
    const first = h(x.firstFrame);
    assert.equal(first[0], LOCAL_OPEN[way]);
    const ada = way === "code" ? Buffer.alloc(0) : first.subarray(1, 17);
    const b = cpaceRespond({ prs: h(x.prs), ci: CPACE_CI[way], ada, theirs: first.subarray(1 + ada.length), scalar: h(x.macScalar) });
    assert.equal(b.share.toString("hex"), x.answer);
    assert.equal(b.isk.toString("hex"), x.isk);
    const mac = sessionOf(b.isk, "mac");
    assert.equal(openRecord(mac.receive, h(x.records[0].frame as string)).body.toString(), x.records[0].text);
  }
  assert.equal(l.token.tokenId, tokenIdOf(tokenSecret(l.token.token)).toString("hex"));
  assert.equal(l.qr.qrId, qrIdOf(h(l.qr.secret)).toString("hex"));
  assert.equal(h(l.qr.firstFrame).subarray(1, 17).toString("hex"), l.qr.qrId);
  // The phone's pair carries the secret as the code says it.
  assert.equal(JSON.parse(l.qr.records[0].text as string).code, parsePairUrl(l.qr.url)!.secret.toString("base64url"));
});

// ── The server ───────────────────────────────────────────────────────────────

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

async function setUp(name: string, o: { handshakeMs?: number; maxOpen?: { perAddress: number; total: number } } = {}) {
  const pairing = new Pairing(join(process.cwd(), `phones-local-${name}.json`));
  const identity = newIdentity();
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, opus: null, identity, handshakeMs: o.handshakeMs, maxOpen: o.maxOpen });
  const port = await server.start();
  return { server, pairing, identity, url: `ws://127.0.0.1:${port}` };
}

/** A phone (LocalPhone, or a plain socket): what it got, in the clear or opened, each checked against the schema; every raw frame both ways. */
function watch(ws: LocalPhone | WebSocket) {
  const got: any[] = [];
  const wire: Buffer[] = [];
  let closed: number | null = null;
  ws.on("message", (d: Buffer) => {
    const m = JSON.parse(String(d));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  ws.on("close", (code: number) => (closed = code));
  ws.on("error", () => {});
  const raw = ws instanceof LocalPhone ? ws.ws : ws;
  raw.on("message", (d: Buffer) => wire.push(Buffer.from(d)));
  const send = raw.send.bind(raw);
  (raw as any).send = (data: any, ...rest: any[]) => {
    wire.push(Buffer.from(data));
    return send(data, ...rest);
  };
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  return {
    got,
    wire,
    closed: () => closed,
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    next: (type: string) => until(() => got.find((m) => m.type === type)),
  };
}

test("pairing and everything after it: nothing of the code, the token or the messages crosses in the clear", async () => {
  const { server, pairing, identity, url } = await setUp("clear");
  try {
    const code = pairing.open().code;
    const phone = new LocalPhone(url);
    const p = watch(phone);
    await p.send({ type: "pair", code, device: "Secret Phone Name", appVersion: "0.3.0" });
    const paired = await p.next("paired");
    const welcome = await p.next("welcome");
    assert.equal(phone.way, "code");
    assert.equal(welcome.macKey, identity.static.public.toString("base64"), "welcome carries the Mac's key");
    assert.ok(pairing.list()[0].relayKey, "the Mac keeps the phone's key from pair");
    await p.send({ type: "type", text: "delete the production database" });
    await wait(50);
    const all = Buffer.concat(p.wire);
    for (const secret of [code, paired.token, "Secret Phone Name", "production database", "welcome", "paired", "hello"]) {
      assert.equal(all.includes(Buffer.from(secret)), false, `"${secret}" never on the wire`);
    }
    // A sealed record starts with "{" one time in 256 (it's random bytes): none parses as JSON, though.
    const json = (f: Buffer) => {
      try {
        JSON.parse(f.toString());
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(
      p.wire.every((f) => !json(f)),
      "no JSON frame at all",
    );
    phone.close();
  } finally {
    server.stop();
  }
});

test("a wrong code is refused in the clear and counted; five close pairing; closed pairing says so", async () => {
  const { server, pairing, url } = await setUp("wrong");
  try {
    const right = pairing.open().code;
    const wrong = right === "000000" ? "000001" : "000000";
    for (let i = 1; i <= 5; i++) {
      const p = watch(new LocalPhone(url));
      await p.send({ type: "pair", code: wrong, device: "x", appVersion: "1" });
      const err = await p.next("error");
      assert.equal(err.code, i < 5 ? "bad_code" : "too_many_attempts");
      await until(() => p.closed() !== null);
    }
    const after = watch(new LocalPhone(url));
    await after.send({ type: "pair", code: right, device: "x", appVersion: "1" });
    assert.equal((await after.next("error")).code, "too_many_attempts", "locked: even the right code");
    pairing.close();
    pairing.open(); // a new code clears it
    pairing.close();
    const closed = watch(new LocalPhone(url));
    await closed.send({ type: "pair", code: right, device: "x", appVersion: "1" });
    assert.equal((await closed.next("error")).code, "pairing_closed");
    assert.equal(pairing.list().length, 0);
  } finally {
    server.stop();
  }
});

test("a phone paired before (its token, no keys) moves to keys without pairing again; after that its token alone is turned away", async () => {
  const { server, pairing, identity, url } = await setUp("upgrade");
  try {
    // Paired as an older app did: a token, no key on either side.
    const old = pairing.pair(pairing.open().code, "Old Phone");
    assert.ok(old.ok);
    assert.equal(old.phone.relayKey, undefined);
    const key = x25519Pair();
    const first = new LocalPhone(url, { forget: true });
    const a = watch(first);
    await a.send({ type: "hello", token: old.token, device: "Old Phone", appVersion: "0.3.0" });
    const welcome = await a.next("welcome");
    assert.equal(first.way, "token");
    assert.equal(welcome.macKey, identity.static.public.toString("base64"));
    const kept = pairing.list()[0].relayKey;
    assert.ok(kept, "the key from hello is kept");
    assert.ok(Buffer.concat(a.wire).includes(Buffer.from(old.token)) === false, "the token never crosses");
    assert.equal(logged("phone_key").at(-1)?.from, "token");
    first.close();
    // Next time: keys (as the app keeps them from that welcome).
    const second = new LocalPhone(url);
    const b = watch(second);
    await b.send({ type: "hello", token: old.token, device: "Old Phone", appVersion: "0.3.0" });
    await b.next("welcome");
    assert.equal(second.way, "keys");
    second.close();
    // Its token alone (someone who saw it on the network before): turned away in the clear, nothing changes.
    const thief = watch(new LocalPhone(url, { forget: true }));
    await thief.send({ type: "hello", token: old.token, device: "Thief", appVersion: "0.3.0" });
    assert.equal((await thief.next("error")).code, "unknown_phone");
    assert.equal(pairing.list()[0].relayKey, kept, "its key stays");
    // Nor with a key of its own through keys: that phone has a key already.
    const thief2 = watch(new LocalPhone(url, { keys: { key, macKey: identity.static.public } }));
    await thief2.send({ type: "hello", token: old.token, device: "Thief", appVersion: "0.3.0" });
    assert.equal((await thief2.next("error")).code, "unauthorized", "inside the tunnel");
    assert.equal(pairing.list()[0].relayKey, kept);
  } finally {
    server.stop();
  }
});

test("keys: another Mac's key is stale (said in the clear); an unknown key with no token of a keyless phone, and a forgotten phone, are unauthorized inside the tunnel", async () => {
  const { server, pairing, identity, url } = await setUp("keys");
  try {
    const key = x25519Pair();
    const paired = pairing.pair(pairing.open().code, "Phone", key.public.toString("base64"));
    assert.ok(paired.ok);
    // Keys for another Mac (this one made its keys again): stale_key, before any tunnel.
    const stale = new LocalPhone(url, { keys: { key, macKey: newIdentity().static.public } });
    const s = watch(stale);
    await s.send({ type: "hello", token: paired.token, device: "Phone", appVersion: "1" });
    assert.equal((await s.next("error")).code, "stale_key");
    assert.equal(logged("phone_refused").at(-1).reason, "stale_key");
    // The right keys: in.
    const ok = new LocalPhone(url, { keys: { key, macKey: identity.static.public } });
    const o = watch(ok);
    await o.send({ type: "hello", token: paired.token, device: "Phone", appVersion: "1" });
    await o.next("welcome");
    assert.equal(logged("phone_connected").at(-1).tunnel, "keys");
    ok.close();
    // Its keys, another phone's token: unauthorized.
    const other = pairing.pair(pairing.open().code, "Other", x25519Pair().public.toString("base64"));
    assert.ok(other.ok);
    const mixed = watch(new LocalPhone(url, { keys: { key, macKey: identity.static.public } }));
    await mixed.send({ type: "hello", token: other.token, device: "Phone", appVersion: "1" });
    assert.equal((await mixed.next("error")).code, "unauthorized");
    // Forgotten on the Mac: the handshake still opens (only that phone holds the key), and it's told inside.
    server.forget(paired.phone.id);
    const gone = new LocalPhone(url, { keys: { key, macKey: identity.static.public } });
    const g = watch(gone);
    await g.send({ type: "hello", token: paired.token, device: "Phone", appVersion: "1" });
    assert.equal((await g.next("error")).code, "unauthorized");
    await until(() => gone.closedBy);
    assert.equal(gone.closedBy?.code, 4001);
  } finally {
    server.stop();
  }
});

test("a replayed record, an altered one, or a text frame once the tunnel is open: the tunnel ends", async () => {
  const { server, pairing, identity, url } = await setUp("tamper");
  try {
    const key = x25519Pair();
    const paired = pairing.pair(pairing.open().code, "Phone", key.public.toString("base64"));
    assert.ok(paired.ok);
    const open = async () => {
      const ws = new WebSocket(url);
      const frames: Buffer[] = [];
      ws.on("message", (d) => frames.push(Buffer.from(d as Buffer)));
      let closed = false;
      ws.on("close", () => (closed = true));
      await new Promise((r) => ws.once("open", r));
      const hs = initiate({ prologue: LOCAL_PROLOGUE, local: key, remote: identity.static.public });
      ws.send(Buffer.concat([Buffer.from([LOCAL_OPEN.keys]), hs.message]));
      await until(() => frames.length);
      const session = hs.finish(frames[0]);
      const hello = sealRecord(session.send, RECORD.text, Buffer.from(JSON.stringify({ v: 1, type: "hello", token: paired.token, device: "Phone", appVersion: "1" })));
      ws.send(hello);
      await until(() => frames.length > 1);
      assert.equal(JSON.parse(openRecord(session.receive, frames[1]).body.toString()).type, "welcome");
      return { ws, session, hello, closed: () => closed };
    };
    const replay = await open();
    replay.ws.send(replay.hello);
    await until(() => replay.closed());
    assert.ok(logged("phone_tunnel_broken").some((l) => l.why === "bad_record"));

    const altered = await open();
    const record = sealRecord(altered.session.send, RECORD.text, Buffer.from(JSON.stringify({ v: 1, type: "get_sessions" })));
    record[3] ^= 1;
    altered.ws.send(record);
    await until(() => altered.closed());

    const text = await open();
    text.ws.send(JSON.stringify({ v: 1, type: "get_sessions" }));
    await until(() => text.closed());
    assert.ok(logged("phone_tunnel_broken").some((l) => l.why === "text_frame"));
  } finally {
    server.stop();
  }
});

test("an app from before (hello or pair in the clear) is told to update, and nothing it sent is read", async () => {
  const { server, pairing, url } = await setUp("old-app");
  try {
    const paired = pairing.pair(pairing.open().code, "Phone");
    assert.ok(paired.ok);
    for (const first of [
      { type: "hello", token: paired.token, device: "Phone", appVersion: "0.2.2" },
      { type: "pair", code: pairing.open().code, device: "Phone", appVersion: "0.2.2" },
    ]) {
      const ws = new WebSocket(url);
      const p = watch(ws);
      await p.send(first);
      const err = await p.next("error");
      assert.equal(err.code, "version");
      assert.match(err.message, /Update Kiko on this iPhone/);
      await until(() => p.closed() !== null);
      assert.equal(p.closed(), 4001);
      assert.equal(logged("phone_refused").at(-1).reason, "unencrypted");
    }
    assert.equal(server.connected().length, 0);
    assert.equal(pairing.list().length, 1, "the code in the clear paired nothing");
  } finally {
    server.stop();
  }
});

test("a handshake that never comes, or a first byte this Mac doesn't know, lets the socket go", async () => {
  const { server, url } = await setUp("timeout", { handshakeMs: 100 });
  try {
    const idle = watch(new WebSocket(url));
    await until(() => idle.closed() !== null);
    const odd = new WebSocket(url);
    const o = watch(odd);
    await new Promise((r) => odd.once("open", r));
    odd.send(Buffer.from([9, 1, 2, 3]));
    assert.equal((await o.next("error")).code, "version");
  } finally {
    server.stop();
  }
});

test("past the most sockets open at once from one address, a new one is dropped at once; one closing makes room (B9)", async () => {
  const { server, url } = await setUp("max-open", { maxOpen: { perAddress: 2, total: 10 } });
  const sockets: WebSocket[] = [];
  const opened = () => {
    const ws = new WebSocket(url);
    sockets.push(ws);
    const w = watch(ws);
    return { ws, w, open: new Promise<boolean>((r) => (ws.once("open", () => r(true)), ws.once("error", () => r(false)))) };
  };
  try {
    const a = opened();
    const b = opened();
    assert.deepEqual(await Promise.all([a.open, b.open]), [true, true]);
    const c = opened();
    await c.open;
    await until(() => c.w.closed() !== null);
    assert.equal(a.w.closed(), null, "the first two stay");
    assert.equal(b.w.closed(), null);
    assert.equal(logged("phone_refused").filter((l) => l.reason === "too_many_open").length >= 1, true);
    a.ws.close();
    await until(() => a.w.closed() !== null);
    // The server sees it closed a moment after the phone does.
    await wait(50);
    const d = opened();
    assert.equal(await d.open, true);
    await wait(100);
    assert.equal(d.w.closed(), null, "room again");
  } finally {
    for (const ws of sockets) ws.terminate();
    server.stop();
  }
});

// ── The QR code ──────────────────────────────────────────────────────────────

/** A QR code shown by this server, as the phone reads it: the link, and a phone that opens with its secret. */
function showQr(server: PhoneServer, pairing: Pairing) {
  const offer = pairing.openQr();
  const url = pairUrl({ name: server.hubName, hosts: ["127.0.0.1"], port: server.port, secret: offer.secret, macKey: server.macKey });
  return { offer, url, link: parsePairUrl(url)! };
}

test("QR: the phone pairs with the code's secret, nothing typed; welcome's key is the one the code showed; nothing of it crosses in the clear", async () => {
  const { server, pairing, url } = await setUp("qr");
  try {
    pairing.open(); // the typed code beside it, as the pairing screen shows it
    const { link } = showQr(server, pairing);
    const phone = new LocalPhone(url, { qr: { secret: link.secret } });
    const p = watch(phone);
    await p.send({ type: "pair", code: link.secret.toString("base64url"), device: "Scanned Phone", appVersion: "0.4.0" });
    const paired = await p.next("paired");
    const welcome = await p.next("welcome");
    assert.equal(phone.way, "qr");
    // The phone's check that it reached this Mac, not an impostor at the address: the key it showed.
    assert.equal(welcome.macKey, link.macKey.toString("base64"));
    assert.equal(pairing.list()[0].name, "Scanned Phone");
    assert.ok(pairing.list()[0].relayKey, "the phone's key, from pair");
    const all = Buffer.concat(p.wire);
    for (const secret of [link.secret, Buffer.from(link.secret.toString("base64url")), Buffer.from(paired.token), Buffer.from("Scanned Phone")]) {
      assert.equal(all.includes(secret), false, "never on the wire");
    }
    // The id goes in the clear (it names the code), and says nothing of the secret.
    assert.ok(all.includes(qrIdOf(link.secret)));
    // One phone: the code is used up, and so is the typed code.
    assert.equal(pairing.qrOpen(), null);
    assert.equal(pairing.current(), null);
    assert.equal(logged("phone_paired").at(-1).how, "qr");
    const log = readdirSync("logs")
      .map((f) => readFileSync(join("logs", f), "utf8"))
      .join("");
    assert.ok(!log.includes(link.secret.toString("base64url")) && !log.includes(link.secret.toString("hex")), "the secret is never logged");
    assert.ok(!log.includes(qrIdOf(link.secret).toString("hex")), "nor its id");
    phone.close();
    // Next time it opens with its keys, to the key from the code.
    const again = new LocalPhone(url);
    const a = watch(again);
    await a.send({ type: "hello", token: paired.token, device: "Scanned Phone", appVersion: "0.4.0" });
    await a.next("welcome");
    assert.equal(again.way, "keys");
    again.close();
  } finally {
    server.stop();
  }
});

test("QR: used once, it's refused (qr_used) in the clear; expired, closed or another code shown since: qr_expired", async () => {
  let now = Date.now();
  const pairing = new Pairing(join(process.cwd(), "phones-local-qr-once.json"), () => now);
  const identity = newIdentity();
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, opus: null, identity });
  const url = `ws://127.0.0.1:${await server.start()}`;
  const pairWith = async (secret: Buffer) => {
    const p = watch(new LocalPhone(url, { qr: { secret } }));
    await p.send({ type: "pair", code: secret.toString("base64url"), device: "Phone", appVersion: "1" });
    return p;
  };
  try {
    const first = showQr(server, pairing);
    await (await pairWith(first.link.secret)).next("welcome");
    // Scanned again (a photo of it, or a second phone): it paired a phone already.
    const reused = await pairWith(first.link.secret);
    const used = await reused.next("error");
    assert.equal(used.code, "qr_used");
    assert.match(used.message, /paired a phone already/);
    await until(() => reused.closed() === 4001);
    assert.equal(reused.got.length, 1, "nothing but the refusal");
    // Five minutes on: expired.
    const late = showQr(server, pairing);
    now += 5 * 60_000;
    const expired = await pairWith(late.link.secret);
    assert.equal((await expired.next("error")).code, "qr_expired");
    // Its screen closed (Esc): it stops working at once.
    const closing = showQr(server, pairing);
    pairing.closeQr();
    assert.equal((await (await pairWith(closing.link.secret)).next("error")).code, "qr_expired");
    // A new one shown: the one before stops working.
    const older = showQr(server, pairing);
    const newer = showQr(server, pairing);
    assert.equal((await (await pairWith(older.link.secret)).next("error")).code, "qr_expired");
    // A code this Mac never showed (shown before it restarted, or made up).
    assert.equal((await (await pairWith(randomSecret())).next("error")).code, "qr_expired");
    assert.equal(pairing.list().length, 1, "only the first phone paired");
    // The newest still works.
    await (await pairWith(newer.link.secret)).next("welcome");
    assert.equal(pairing.list().length, 2);
    assert.ok(logged("phone_refused").some((l) => l.reason === "qr_used"));
  } finally {
    server.stop();
  }
});

const randomSecret = () => Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff));

test("QR: a secret that isn't the code's (its id, someone else's secret) is bad_code and doesn't close the typed code; the impostor's own code isn't this Mac's", async () => {
  const { server, pairing, url } = await setUp("qr-wrong");
  const impostor = await setUp("qr-impostor");
  try {
    const typed = pairing.open().code;
    const { link } = showQr(server, pairing);
    // The real code's id with another secret: the first record doesn't open.
    const forged = watch(new LocalPhone(url, { qr: { secret: randomSecret(), id: qrIdOf(link.secret) } }));
    await forged.send({ type: "pair", code: randomSecret().toString("base64url"), device: "x", appVersion: "1" });
    assert.equal((await forged.next("error")).code, "bad_code");
    assert.equal(logged("phone_refused").at(-1).reason, "qr_mismatch");
    // Not counted against the typed code, and the QR code still works.
    assert.equal(pairing.current()?.code, typed);
    assert.ok(pairing.qrOpen());
    // A Mac at another address (an impostor on the Wi-Fi) doesn't have this code: the phone's scan is refused there.
    const elsewhere = watch(new LocalPhone(impostor.url, { qr: { secret: link.secret } }));
    await elsewhere.send({ type: "pair", code: link.secret.toString("base64url"), device: "x", appVersion: "1" });
    assert.equal((await elsewhere.next("error")).code, "qr_expired");
    // And had it shown a code of its own to lure the phone, welcome's key wouldn't be the one this code shows.
    const lure = showQr(impostor.server, impostor.pairing);
    const lured = watch(new LocalPhone(impostor.url, { qr: { secret: lure.link.secret } }));
    await lured.send({ type: "pair", code: lure.link.secret.toString("base64url"), device: "x", appVersion: "1" });
    assert.notEqual((await lured.next("welcome")).macKey, link.macKey.toString("base64"), "the phone sees another Mac's key and drops it");
    // The real one still pairs.
    const right = watch(new LocalPhone(url, { qr: { secret: link.secret } }));
    await right.send({ type: "pair", code: link.secret.toString("base64url"), device: "Mine", appVersion: "1" });
    assert.equal((await right.next("welcome")).macKey, link.macKey.toString("base64"));
  } finally {
    server.stop();
    impostor.server.stop();
  }
});

test("QR: on a QR handshake, only pair with that code's secret: the 6-digit code, another secret, or hello is refused (and the secret on a code handshake)", async () => {
  const { server, pairing, url } = await setUp("qr-only-pair");
  try {
    const typed = pairing.open().code;
    const { link } = showQr(server, pairing);
    const withCode = watch(new LocalPhone(url, { qr: { secret: link.secret } }));
    await withCode.send({ type: "pair", code: typed, device: "x", appVersion: "1" });
    assert.equal((await withCode.next("error")).code, "bad_code");
    const otherSecret = watch(new LocalPhone(url, { qr: { secret: link.secret } }));
    await otherSecret.send({ type: "pair", code: "x".repeat(22), device: "x", appVersion: "1" });
    assert.equal((await otherSecret.next("error")).code, "bad_code");
    // hello on a QR handshake (a paired phone's token, say): only pair goes there. By hand: the qr opening, then a sealed hello.
    const paired = pairing.pair(typed, "Paired before");
    assert.ok(paired.ok);
    const fresh = showQr(server, pairing).link; // the code pairing above closed the one before
    const raw = new WebSocket(url);
    const frames: Buffer[] = [];
    raw.on("message", (d: Buffer) => frames.push(Buffer.from(d)));
    await new Promise((r) => raw.once("open", r));
    const id = qrIdOf(fresh.secret);
    const a = cpaceInitiate({ prs: fresh.secret, ci: CPACE_CI.qr, ada: id });
    raw.send(Buffer.concat([Buffer.from([LOCAL_OPEN.qr]), id, a.share]));
    await until(() => frames.length >= 1);
    const session = sessionOf(a.finish(frames[0]), "phone");
    raw.send(sealRecord(session.send, RECORD.text, Buffer.from(JSON.stringify({ v: 1, type: "hello", token: paired.token, device: "x", appVersion: "1" }))));
    await until(() => frames.length >= 2);
    const refusal = JSON.parse(openRecord(session.receive, frames[1]).body.toString());
    assert.deepEqual([refusal.type, refusal.code], ["error", "unauthorized"]);
    assert.equal(logged("phone_refused").at(-1).reason, "hello_on_pairing");
    raw.close();
    assert.equal(pairing.list().length, 1, "only the phone paired with the typed code");
    assert.ok(pairing.qrOpen(), "still works for the right phone");
    // A 6-digit code handshake can't pair with the QR's secret either.
    pairing.open();
    const crossed = watch(new LocalPhone(url));
    await crossed.send({ type: "pair", code: fresh.secret.toString("base64url"), device: "x", appVersion: "1" });
    assert.equal((await crossed.next("error")).code, "bad_code");
  } finally {
    server.stop();
  }
});
