// A hub for the iPhone app's own tests to reach through the real relay (the iPhone app's repo's
// scripts/relay-interop.sh starts it, runs RelayInteropTests on the Simulator, and stops it): the
// relay Worker run locally (support.ts), the hub's own phone server and relay client (src/remote/),
// and a stand-in for the rest of the hub, as in e2e.test.ts. So the app's Swift tunnel meets the
// TypeScript one end to end: it pairs at home, sets itself up for the relay, then through the relay
// only says hello, presses (its audio in Opus, binary records both ways), types, answers the hub's
// pings, and hears that its Mac went offline. Beside it, a second phone server of its own, with its
// own Mac key, shows a pairing QR code (its URL, as the code says it: pair-link.ts), for the app to
// pair by it with nothing typed and check the Mac's key it reached. And a third, "away": its code
// names only an address nobody answers on, and the relay, so the app pairs by it through the relay
// (protocol/README.md, "Pairing through the relay"); a fourth room's code was closed as it showed,
// for the app to hear it doesn't work any more. Not a test itself: it serves until SIGTERM (or
// SIGINT, or whatever started it going away), then disposes of everything.
//
// Hermetic as the hub's tests (tests/setup.ts): no Keychain, no real config, phones.json in a
// throwaway folder; on 127.0.0.1 only, nothing remote, nothing deployed. With KIKO_RELAY_TEST_URL
// (e.g. wss://relay.kiko.sh) the relay is that deployed one instead (support.ts relayForEndToEnd),
// with keys made fresh for the run; the rest stays here.
//   node relay/test/phone-interop.ts      (prints one JSON line once it's ready: the ports, the code)
import "../../tests/setup.ts";
import { join } from "node:path";
import { joinPackets, splitPackets } from "../../src/remote/opus.ts";
import { hostsFor, pairUrl } from "../../src/remote/pair-link.ts";
import { Pairing } from "../../src/remote/pairing.ts";
import { RelayClient } from "../../src/remote/relay-client.ts";
import { newIdentity } from "../../src/remote/relay-identity.ts";
import { PhoneServer, type PhoneHub } from "../../src/remote/server.ts";
import type { Opus, OpusStream } from "../../src/platform/types.ts";
import { relayForEndToEnd } from "./support.ts";

/**
 * A stand-in for Apple's Opus, so the binary frames are real but the codec isn't needed: each 20 ms
 * of PCM is one 4-byte packet and back (the phone's packets are whatever it sends: each one is 20 ms
 * of PCM here, so the bytes the hub gets say how many packets came through).
 */
const fakeOpus: Opus = {
  available: () => true,
  encoder(rate: number): OpusStream {
    const bytes = (rate / 50) * 2;
    let waiting = Buffer.alloc(0);
    let n = 0;
    const take = (all: boolean) => {
      const out: Buffer[] = [];
      if (all && waiting.length) waiting = Buffer.concat([waiting, Buffer.alloc(bytes - (waiting.length % bytes || bytes))]);
      while (waiting.length >= bytes) {
        out.push(Buffer.from([n++ & 0xff, 0x55, 0x55, 0x55]));
        waiting = waiting.subarray(bytes);
      }
      return Promise.resolve(out.length ? joinPackets(out) : Buffer.alloc(0));
    };
    return {
      push: (pcm) => {
        waiting = Buffer.concat([waiting, pcm]);
        return take(false);
      },
      flush: () => take(true),
      close: () => {},
    };
  },
  decoder(rate: number): OpusStream {
    const bytes = (rate / 50) * 2;
    return {
      push: (packets) => Promise.resolve(Buffer.alloc((splitPackets(packets) ?? []).length * bytes, 1)),
      flush: () => Promise.resolve(Buffer.alloc(0)),
      close: () => {},
    };
  },
};

let server: PhoneServer;
let client: RelayClient;
let press: { phoneId: string; talkId: string | null } | null = null;
let audio = 0;
let talking = false;
const hub: PhoneHub = {
  talkStart(_sessionId, phoneId, talkId) {
    talking = true;
    audio = 0;
    press = { phoneId, talkId: talkId ?? null };
    if (talkId) setImmediate(() => server.talkStatus(phoneId, { talkId, stage: "heard", text: "interop press" }));
    return null;
  },
  talkAudio: (pcm) => void (audio += pcm.length),
  talkEnd(cancel) {
    talking = false;
    const p = press;
    press = null;
    if (cancel || !p?.talkId) return;
    // What came through, in words the phone can check: every byte of the press's audio, decoded.
    // Then 200 ms of the Mac's voice to the phones that play it (in Opus, binary records down).
    setTimeout(() => {
      server.talkStatus(p.phoneId, { talkId: p.talkId!, stage: "delivered", text: `${audio} bytes` });
      server.audio(Buffer.alloc(24_000 * 2 * 0.2, 2));
    }, 50);
  },
  type(text, _sessionId, phoneId, talkId) {
    if (talkId) setImmediate(() => server.talkStatus(phoneId, { talkId, stage: "answered" }));
    // The phone's way to ask for the Mac to drop off the relay, so it can see what that looks like.
    if (text === "interop: go offline") setTimeout(() => client.stop(), 100);
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

const relay = await relayForEndToEnd();
const identity = newIdentity();
const pairing = new Pairing(join(process.cwd(), "phones-interop.json"));
server = new PhoneServer({
  hub,
  pairing,
  port: 0,
  host: "127.0.0.1",
  opus: fakeOpus,
  // Pinged every second through the tunnel: a phone that didn't answer would be let go mid-test.
  pingMs: 1_000,
  // The same keys as the relay client: the phone pins this Mac's key at pairing, at home, and its tunnel through the relay is to it too.
  identity,
  network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "Interop-Mac.local" },
  relay: { url: relay.url, room: identity.room, macKey: identity.static.public.toString("base64"), signingKey: identity.signing.public.toString("base64") },
});
const port = await server.start();
client = new RelayClient({ url: relay.url, identity, pairing, server, retryMs: { min: 50, max: 200 } });
client.start();
for (const deadline = Date.now() + 10_000; client.status !== "connected"; ) {
  if (Date.now() > deadline) throw new Error("the relay client didn't connect");
  await new Promise((r) => setTimeout(r, 10));
}

// The QR code's Mac: a phone server of its own (another Mac key, its own phones), with a QR code shown.
const qrIdentity = newIdentity();
const qrPairing = new Pairing(join(process.cwd(), "phones-interop-qr.json"));
const qrServer = new PhoneServer({
  hub,
  pairing: qrPairing,
  port: 0,
  host: "127.0.0.1",
  opus: null,
  identity: qrIdentity,
  network: { addresses: async () => [{ kind: "lan", address: "127.0.0.1", interface: "lo0" }], advertise: () => ({ stop() {} }), hostname: () => "Interop-QR-Mac.local" },
});
const qrPort = await qrServer.start();
const qrOffer = qrPairing.openQr();
const qrUrl = pairUrl({
  name: qrServer.hubName,
  hosts: hostsFor([{ kind: "home", host: "127.0.0.1", port: qrPort }]),
  port: qrPort,
  secret: qrOffer.secret,
  macKey: qrIdentity.static.public,
});

// Away: a Mac whose code is reachable only through the relay (127.0.0.1:1 answers nothing), with the relay on.
const awayIdentity = newIdentity();
const awayPairing = new Pairing(join(process.cwd(), "phones-interop-away.json"));
const relaySide = (id: typeof awayIdentity) => ({ url: relay.url, room: id.room, macKey: id.static.public.toString("base64"), signingKey: id.signing.public.toString("base64") });
const awayServer = new PhoneServer({
  hub,
  pairing: awayPairing,
  port: 0,
  host: "127.0.0.1",
  opus: null,
  pingMs: 1_000,
  identity: awayIdentity,
  network: { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "Interop-Away-Mac.local" },
  relay: relaySide(awayIdentity),
});
await awayServer.start();
const awayClient = new RelayClient({ url: relay.url, identity: awayIdentity, pairing: awayPairing, server: awayServer, retryMs: { min: 50, max: 200 } });
awayClient.start();
// And a room whose code closed as it showed: the relay says it doesn't work any more.
const closedIdentity = newIdentity();
const closedPairing = new Pairing(join(process.cwd(), "phones-interop-closed.json"));
const closedClient = new RelayClient({ url: relay.url, identity: closedIdentity, pairing: closedPairing, server: { adopt: (socket) => socket.close(1001) } });
closedClient.start();
for (const deadline = Date.now() + 10_000; awayClient.status !== "connected" || closedClient.status !== "connected"; ) {
  if (Date.now() > deadline) throw new Error("the away Macs' relay clients didn't connect");
  await new Promise((r) => setTimeout(r, 10));
}
if (!awayClient.takesPairing) throw new Error("this relay doesn't take pairing through it (one from before it: KIKO_RELAY_TEST_URL?)");
const awayLink = (id: typeof awayIdentity, secret: Buffer) =>
  pairUrl({ name: id === awayIdentity ? awayServer.hubName : "Kiko on Interop-Closed-Mac", hosts: ["127.0.0.1"], port: 1, secret, macKey: id.static.public, relay: { url: relay.url, room: id.room } });
const awayUrl = awayLink(awayIdentity, awayPairing.openQr().secret);
const closedUrl = awayLink(closedIdentity, closedPairing.openQr().secret);
await new Promise((r) => setTimeout(r, 100));
closedPairing.closeQr();

let done = false;
async function shutDown(code: number) {
  if (done) return;
  done = true;
  client.stop();
  server.stop();
  qrServer.stop();
  awayClient.stop();
  awayServer.stop();
  closedClient.stop();
  await relay.dispose();
  process.exit(code);
}
// tests/setup.ts (and wrangler) exit at once on a signal; here the relay's workerd is disposed of first.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.removeAllListeners(signal);
  process.once(signal, () => void shutDown(0));
}
// Never left behind: once whatever started it is gone (this process is orphaned), or after 15
// minutes whatever happens, it stops by itself.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) void shutDown(0);
}, 1_000).unref();
setTimeout(() => void shutDown(1), 15 * 60_000);

// The pairing code and the QR code are the harness's own (throwaway Pairings and keys): fine to print, and the phone needs them.
console.log(
  JSON.stringify({
    ready: true,
    hubPort: port,
    relay: relay.url,
    code: pairing.open().code,
    room: identity.room,
    qr: qrUrl,
    qrMacKey: qrIdentity.static.public.toString("base64"),
    qrAway: awayUrl,
    qrAwayMacKey: awayIdentity.static.public.toString("base64"),
    qrAwayClosed: closedUrl,
  }),
);
