// Pairing phones (src/remote/pairing.ts): a 6-digit code while pairing is open, a long random token
// for the phone, only its hash kept on the Mac, unknown tokens refused, wrong codes counted, and
// forgetting phones; the pairing QR code (its secret, five minutes, one phone, closed with its screen).
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { qrIdOf, qrRelayCredentialOf } from "../../../src/remote/cpace.ts";
import { MAX_WRONG, PAIRING_MS, Pairing, QR_MS } from "../../../src/remote/pairing.ts";

let n = 0;
const fresh = (now = () => Date.now()) => {
  const file = join(process.cwd(), `phones-${n++}.json`);
  return { file, pairing: new Pairing(file, now) };
};

test("a 6-digit code while open; the right one gets a long token, and pairing closes", () => {
  const { pairing } = fresh();
  assert.equal(pairing.current(), null);
  assert.deepEqual(pairing.pair("123456", "Alex's iPhone"), { ok: false, code: "pairing_closed" });
  const { code } = pairing.open();
  assert.match(code, /^\d{6}$/);
  assert.equal(pairing.current()?.code, code);
  const r = pairing.pair(code, "Alex's iPhone");
  assert.ok(r.ok);
  assert.ok(r.token.length >= 40, "at least 256 bits");
  assert.equal(r.phone.name, "Alex's iPhone");
  assert.equal(pairing.current(), null, "one phone per code");
  assert.deepEqual(pairing.pair(code, "again"), { ok: false, code: "pairing_closed" });
});

test("tokens: the right one finds its phone, anything else nothing; the file holds only hashes", () => {
  const { file, pairing } = fresh();
  const { code } = pairing.open();
  const r = pairing.pair(code, "iPhone");
  assert.ok(r.ok);
  assert.equal(pairing.check(r.token)?.id, r.phone.id);
  assert.equal(pairing.check(`${r.token}x`), null);
  assert.equal(pairing.check("not-a-token-at-all-but-long-enough"), null);
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes(r.token), "the token itself isn't stored");
  assert.ok(!saved.includes(code), "nor the code");
  // A new start reads the paired phones back.
  assert.equal(new Pairing(file).check(r.token)?.id, r.phone.id);
});

test("wrong codes: refused, and a few in a row close pairing until it's opened again", () => {
  const { pairing } = fresh();
  const { code } = pairing.open();
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 1; i < MAX_WRONG; i++) assert.deepEqual(pairing.pair(wrong, "x"), { ok: false, code: "bad_code" });
  assert.deepEqual(pairing.pair(wrong, "x"), { ok: false, code: "too_many_attempts" });
  assert.deepEqual(pairing.pair(code, "x"), { ok: false, code: "too_many_attempts" }, "even the right code, now");
  assert.equal(pairing.current(), null);
  const again = pairing.open();
  assert.ok(pairing.pair(again.code, "x").ok);
});

test("a code runs out after PAIRING_MS", () => {
  let t = 1_000;
  const { pairing } = fresh(() => t);
  const { code, until } = pairing.open();
  assert.equal(until, 1_000 + PAIRING_MS);
  t = until;
  assert.equal(pairing.current(), null);
  assert.deepEqual(pairing.pair(code, "x"), { ok: false, code: "pairing_closed" });
});

test("forgetting one phone, then all: their tokens stop working", () => {
  const { file, pairing } = fresh();
  const tokens = ["a", "b", "c"].map((name) => {
    const r = pairing.pair(pairing.open().code, name);
    assert.ok(r.ok);
    return r;
  });
  assert.deepEqual(pairing.forget(tokens[0].phone.id), [tokens[0].phone.id]);
  assert.equal(pairing.check(tokens[0].token), null);
  assert.ok(pairing.check(tokens[1].token));
  assert.equal(pairing.forget("all").length, 2);
  assert.equal(pairing.check(tokens[2].token), null);
  assert.deepEqual(new Pairing(file).list(), []);
});

test("a phone's choices are kept: its name and whether it plays the audio", () => {
  const { file, pairing } = fresh();
  const r = pairing.pair(pairing.open().code, "old name");
  assert.ok(r.ok);
  pairing.update(r.phone.id, { name: "new name", playOnPhone: false });
  const back = new Pairing(file).list()[0];
  assert.deepEqual([back.name, back.playOnPhone], ["new name", false]);
});

// After a clean reinstall the phone was paired again, Play on phone came back
// off, and every reply played on the Mac while the phone was in front.
test("a newly paired phone plays what's said (Play on phone on), saved that way", () => {
  const { file, pairing } = fresh();
  const r = pairing.pair(pairing.open().code, "iPhone");
  assert.ok(r.ok);
  assert.equal(r.phone.playOnPhone, true);
  assert.equal(new Pairing(file).list()[0].playOnPhone, true);
});

// ── The QR code ──────────────────────────────────────────────────────────────

test("QR: a fresh 128-bit secret each time, named by its id; it works for 5 minutes, then it's expired", () => {
  let now = 1_000_000;
  const { pairing } = fresh(() => now);
  assert.equal(pairing.qrOpen(), null);
  const a = pairing.openQr();
  assert.equal(a.secret.length, 16);
  assert.deepEqual(a.id, qrIdOf(a.secret));
  assert.equal(a.until, now + QR_MS);
  assert.equal(QR_MS, 5 * 60_000);
  const b = pairing.openQr();
  assert.notDeepEqual(a.secret, b.secret);
  // The one before stopped working as the new one showed.
  assert.deepEqual(pairing.qrFor(a.id), { ok: false, code: "qr_expired" });
  assert.deepEqual(pairing.qrFor(b.id), { ok: true, secret: b.secret });
  now += QR_MS - 1;
  assert.ok(pairing.qrOpen());
  now += 1;
  assert.equal(pairing.qrOpen(), null);
  assert.deepEqual(pairing.qrFor(b.id), { ok: false, code: "qr_expired" });
  assert.deepEqual(pairing.pairQr(b.id, b.secret.toString("base64url"), "Late"), { ok: false, code: "qr_expired" });
  assert.equal(pairing.list().length, 0);
});

test("QR: one phone. The right secret pairs; the same code again is qr_used; the typed code closes with it", () => {
  const { file, pairing } = fresh();
  pairing.open();
  const { id, secret } = pairing.openQr();
  assert.deepEqual(pairing.pairQr(id, "x".repeat(22), "Wrong"), { ok: false, code: "bad_code" });
  assert.deepEqual(pairing.pairQr(id, secret.toString("base64"), "Padded"), { ok: false, code: "bad_code" }, "the URL's own spelling only");
  const r = pairing.pairQr(id, secret.toString("base64url"), "Scanned", Buffer.alloc(32, 7).toString("base64"));
  assert.ok(r.ok);
  assert.equal(r.phone.name, "Scanned");
  assert.equal(r.phone.relayKey, Buffer.alloc(32, 7).toString("base64"));
  assert.equal(pairing.current(), null, "the typed code closed: one phone per pairing");
  assert.deepEqual(pairing.qrFor(id), { ok: false, code: "qr_used" });
  assert.deepEqual(pairing.pairQr(id, secret.toString("base64url"), "Again"), { ok: false, code: "qr_used" });
  assert.equal(pairing.list().length, 1);
  // Nothing of it is written down.
  const saved = readFileSync(file, "utf8");
  assert.ok(!saved.includes(secret.toString("base64url")) && !saved.includes(secret.toString("hex")) && !saved.includes(id.toString("hex")));
});

test("QR: closed (its screen), it stops at once; a phone paired with the typed code closes it too; unknown ids are expired", () => {
  const { pairing } = fresh();
  const shown = pairing.openQr();
  pairing.closeQr();
  assert.equal(pairing.qrOpen(), null);
  assert.deepEqual(pairing.qrFor(shown.id), { ok: false, code: "qr_expired" });
  const again = pairing.openQr();
  const { code } = pairing.open();
  assert.ok(pairing.pair(code, "Typed").ok);
  assert.deepEqual(pairing.qrFor(again.id), { ok: false, code: "qr_expired" }, "one phone per pairing, either way");
  assert.deepEqual(pairing.qrFor(Buffer.alloc(16)), { ok: false, code: "qr_expired" });
  assert.deepEqual(pairing.qrFor(Buffer.alloc(3)), { ok: false, code: "qr_expired" }, "a short id is nothing, not a crash");
});

test("QR: wrong secrets aren't counted against the typed code", () => {
  const { pairing } = fresh();
  const { code } = pairing.open();
  const { id } = pairing.openQr();
  for (let i = 0; i < MAX_WRONG + 2; i++) assert.equal(pairing.pairQr(id, "y".repeat(22), "x").ok, false);
  assert.equal(pairing.codeFor().ok, true);
  assert.ok(pairing.pair(code, "Typed").ok);
});

test("QR from away: the code's relay credential (its hash) while it works, told as it opens, pairs or stops; used or not", () => {
  let now = 1_000_000;
  const { pairing } = fresh(() => now);
  let told = 0;
  pairing.onQrChange = () => told++;
  assert.equal(pairing.qrRelay(), null);
  const a = pairing.openQr();
  assert.ok(told >= 1);
  const hash = createHash("sha256").update(qrRelayCredentialOf(a.secret)).digest("hex");
  assert.deepEqual(pairing.qrRelay(), { hash, until: now + QR_MS });
  // Drawn from the secret, apart from its id: neither gives the other (or the secret) away.
  assert.equal(qrRelayCredentialOf(a.secret).length, 32);
  assert.notDeepEqual(qrRelayCredentialOf(a.secret).subarray(0, 16), qrIdOf(a.secret));
  // Paired: spent, used, told.
  const before = told;
  assert.ok(pairing.pairQr(a.id, a.secret.toString("base64url"), "Away").ok);
  assert.equal(told, before + 1);
  assert.equal(pairing.qrRelay(), null);
  assert.equal(pairing.qrUsed(hash), true);
  // Closed (Esc): told, not used. Expired: no longer offered.
  pairing.openQr();
  const bHash = pairing.qrRelay()!.hash;
  const atClose = told;
  pairing.closeQr();
  assert.equal(told, atClose + 1);
  assert.equal(pairing.qrUsed(bHash), false);
  pairing.closeQr();
  assert.equal(told, atClose + 1, "nothing to tell when nothing changed");
  pairing.openQr();
  now += QR_MS;
  assert.equal(pairing.qrRelay(), null);
});

test("a phone paired or forgotten: onPhonesChange hears how many there are now (the account tells its server); its trouble never stops pairing", () => {
  const { pairing } = fresh();
  const heard: number[] = [];
  pairing.onPhonesChange = (count) => void heard.push(count);
  const a = pairing.pair(pairing.open().code, "iPhone");
  const b = pairing.pair(pairing.open().code, "iPad");
  assert.ok(a.ok && b.ok);
  pairing.forget(a.phone.id);
  pairing.forget("nobody");
  pairing.forget("all");
  assert.deepEqual(heard, [1, 2, 1, 0]);
  pairing.onPhonesChange = () => {
    throw new Error("the account's own trouble");
  };
  assert.ok(pairing.pair(pairing.open().code, "iPhone").ok, "pairing goes on");
});
