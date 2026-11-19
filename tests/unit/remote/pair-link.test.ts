// What the pairing QR code says (src/remote/pair-link.ts): the URL made and read back, field for
// field; every malformed one refused; the hosts it takes from the Mac's addresses; and how big the
// symbol gets for a real-looking Mac (the version the terminal has to fit).
import "../../setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encodeQr } from "../../../src/core/qr.ts";
import { IDENTIFIER } from "../../../src/core/name.ts";
import { hostsFor, PAIR_SCHEME, pairUrl, parsePairUrl, type PairLink } from "../../../src/remote/pair-link.ts";
import { relayVectors } from "../../../scripts/relay-vectors.ts";

const link = (more: Partial<PairLink> = {}): PairLink => ({
  name: "Kiko on Alex’s MacBook Pro",
  hosts: ["192.168.1.20", "100.101.102.103", "test-mac.tail1234.ts.net"],
  port: 7333,
  secret: randomBytes(16),
  macKey: randomBytes(32),
  ...more,
});

test("the scheme is the iPhone app's bundle identifier, from the app's identifier", () => {
  assert.equal(PAIR_SCHEME, `${IDENTIFIER}.ios`);
  assert.equal(PAIR_SCHEME, "sh.kiko.ios");
});

test("made and read back, field for field; with the relay too", () => {
  const plain = link();
  const url = pairUrl(plain);
  assert.match(url, /^sh\.kiko\.ios:\/\/pair\?v=1&n=/);
  assert.ok(!url.includes("+"), "spaces as %20: the phone's URL parser doesn't read + as a space");
  assert.deepEqual(parsePairUrl(url), plain);
  const relay = link({ relay: { url: "wss://relay.example.com", room: "0ecb437e7780b3663372341dd084db43" } });
  assert.deepEqual(parsePairUrl(pairUrl(relay)), relay);
});

test("the vectors' URL says what its link says", () => {
  const q = relayVectors().local.qr;
  const read = parsePairUrl(q.url)!;
  assert.equal(read.name, q.link.name);
  assert.deepEqual(read.hosts, q.link.hosts);
  assert.equal(read.port, q.link.port);
  assert.equal(read.secret.toString("hex"), q.secret);
  assert.equal(read.macKey.toString("base64"), q.link.macKey);
  assert.deepEqual(parsePairUrl(q.relayUrl)?.relay, q.link.relay);
  // The symbol is the encoder's, row for row.
  assert.deepEqual(
    encodeQr(q.url).modules.map((r) => r.map((m) => (m ? "1" : "0")).join("")),
    q.symbol.rows,
  );
});

test("anything else is refused", () => {
  const good = pairUrl(link());
  const bad = [
    "",
    "not a url",
    good.replace("sh.kiko.ios://", "https://"),
    good.replace("sh.kiko.ios://", "sh.other.ios://"),
    good.replace("://pair?", "://unpair?"),
    good.replace("v=1", "v=2"), // a later form: the app says to update
    good.replace(/&s=[^&]+/, "&s=AAAA"), // a short secret
    good.replace(/&s=([^&]+)/, "&s=$1A"), // not 16 bytes
    good.replace(/&k=[^&]+/, "&k=AAAA"), // a short key
    good.replace(/&p=\d+/, "&p=0"),
    good.replace(/&p=\d+/, "&p=70000"),
    good.replace(/&h=[^&]+/, "&h="),
    `${good}&r=wss%3A%2F%2Frelay.example.com`, // the relay without its room
    `${good}&m=0ecb437e7780b3663372341dd084db43`, // a room without the relay
    `${good}&r=https%3A%2F%2Frelay.example.com&m=0ecb437e7780b3663372341dd084db43`,
    `${good}&r=wss%3A%2F%2Frelay.example.com&m=not-a-room`,
  ];
  for (const url of bad) assert.equal(parsePairUrl(url), null, url);
  // A secret that isn't base64url's own spelling of 16 bytes (padding, the other alphabet).
  const s = Buffer.alloc(16, 0xfb);
  const url = pairUrl(link({ secret: s }));
  assert.ok(parsePairUrl(url));
  assert.equal(parsePairUrl(url.replace(s.toString("base64url"), `${s.toString("base64url")}==`)), null);
  assert.equal(parsePairUrl(url.replace(s.toString("base64url"), s.toString("base64").replace(/=+$/, ""))), null);
});

test("hosts: up to three home addresses, then Tailscale's address and name; no Bonjour name, no relay", () => {
  const port = 7333;
  const hosts = hostsFor([
    { kind: "home", host: "192.168.1.20", port },
    { kind: "home", host: "10.0.0.5", port },
    { kind: "home", host: "172.16.0.2", port },
    { kind: "home", host: "192.168.64.1", port },
    { kind: "bonjour", host: "mac.local", port },
    { kind: "tailscale", host: "100.101.102.103", port },
    { kind: "tailscale", host: "mac.tail1234.ts.net", port },
    { kind: "relay", host: "relay.example.com", port: 443, url: "wss://relay.example.com", room: "0".repeat(32) },
  ]);
  assert.deepEqual(hosts, ["192.168.1.20", "10.0.0.5", "172.16.0.2", "100.101.102.103", "mac.tail1234.ts.net"]);
});

test("its size: a real-looking Mac is version 8 or 9, with the relay 10 or 11 (the terminal fits 57 to 69 columns)", () => {
  const typical = encodeQr(pairUrl(link({ name: "Kiko Dev on Alexs-MacBook-Pro" })));
  assert.ok(typical.version <= 9, `version ${typical.version}`);
  const relayed = encodeQr(pairUrl(link({ name: "Kiko Dev on Alexs-MacBook-Pro", relay: { url: "wss://relay.kiko.sh", room: "0ecb437e7780b3663372341dd084db43" } })));
  assert.ok(relayed.version <= 11, `version ${relayed.version}`);
  // Every host the Mac could list, and a long name: still well inside what a terminal shows.
  const most = encodeQr(pairUrl(link({ name: "x".repeat(64), hosts: ["192.168.100.200", "10.200.200.200", "172.31.255.254", "100.101.102.103", "a-long-mac-name.tail1234abcd.ts.net"] })));
  assert.ok(most.version <= 12, `version ${most.version}`);
});
