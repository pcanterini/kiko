// The Mac's own relay client (src/remote/relay-client.ts) against the real Worker run locally with
// requirePass on (the default since 2026-11-19), as a Mac with Kiko Pro or the trial runs it: its
// pass in the upgrade's Kiko-Relay-Pass header and in auth, the first dial waiting for it
// (passFirstMs), signed in; and a Mac with no pass refused at sign-in, waiting for one (no dial every
// minute), then signing in the moment one comes. The pass is made here, against a JWKS server of
// this test's own. Hermetic as the hub's unit tests (tests/setup.ts).
import "../../tests/setup.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Pairing } from "../../src/remote/pairing.ts";
import { RelayClient } from "../../src/remote/relay-client.ts";
import { newIdentity } from "../../src/remote/relay-identity.ts";
import { ONE_ADDRESS, startRelay, type LocalRelay } from "./support.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const kid = "k-mac-pass";
let jwks: Server;
let relay: LocalRelay;

before(async () => {
  jwks = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA" }] })));
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  const addr = jwks.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  // requirePass not set: on, by default.
  relay = await startRelay({ PASS_JWKS_URL: `http://127.0.0.1:${port}/jwks`, RELAY_LIMITS: JSON.stringify(ONE_ADDRESS) });
});
after(async () => {
  await relay?.dispose();
  jwks?.close();
});

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** A pass as the account server makes it, for `room`. */
function passFor(room: string, sub = "acct_mac") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid }));
  const payload = b64url(JSON.stringify({ iss: "https://account.kiko.sh", aud: "relay.kiko.sh", sub, plan: "trial", room, iat: now, exp: now + 86_400 }));
  return `${header}.${payload}.${b64url(edSign(null, Buffer.from(`${header}.${payload}`), privateKey))}`;
}

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let n = 0;
function client(o: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const identity = newIdentity();
  const c = new RelayClient({
    url: relay.url,
    identity,
    pairing: new Pairing(join(process.cwd(), `phones-mac-pass-${n++}.json`)),
    server: { adopt: () => {} },
    retryMs: { min: 50, max: 200 },
    network: false,
    ...o,
  });
  return { c, room: identity.room };
}

test("a Mac with the plan: its pass in the upgrade and in auth, the first dial waiting for it; signed in with requirePass on", async () => {
  const { c, room } = client({ passFirstMs: 5_000 });
  try {
    c.start();
    assert.equal(c.status, "connecting");
    // The account's answer comes a moment later, as it does at start.
    setTimeout(() => c.setPass(passFor(room)), 100);
    await until(() => c.status === "connected");
  } finally {
    c.stop();
  }
});

test("a Mac with no pass: refused at sign-in and told (macRefused), not dialling again; a pass comes, signed in at once", async () => {
  const told: Array<string | null> = [];
  const { c, room } = client({ planRefused: (pass, o) => void (o?.macRefused && told.push(pass)) });
  try {
    c.start();
    await until(() => told.length === 1);
    assert.deepEqual(told, ["missing"]);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(c.status, "connecting", "waiting for a pass, not signed in");
    assert.equal(told.length, 1, "no dial again meanwhile (the retry's 50-200 ms would have)");
    c.setPass(passFor(room));
    await until(() => c.status === "connected");
  } finally {
    c.stop();
  }
});
