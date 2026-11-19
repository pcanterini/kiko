// The relay pass's keys (src/pass.ts), in plain Node (the module has no imports): the JWKS fetched and
// kept in the store (KV in production; a Map here) only when it changed, never replaced by an empty
// one; the kept keys checking passes in a fresh isolate (forgetKeys) while the JWKS can't be fetched;
// and with nothing ever kept, a pass with good claims unverified (refused). And the room claim.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { checkPass, forgetKeys, type KeyStore } from "../src/pass.ts";

type Key = { kid: string; priv: KeyObject; jwk: Record<string, unknown> };
function makeKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" } };
}

const ROOM = "ab".repeat(16);
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function makePass(key: Key, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: key.kid }));
  const payload = b64url(JSON.stringify({ iss: "https://account.kiko.sh", aud: "relay.kiko.sh", sub: "acct_test", plan: "pro", room: ROOM, iat: now, exp: now + 86400, ...claims }));
  return `${header}.${payload}.${b64url(edSign(null, Buffer.from(`${header}.${payload}`), key.priv))}`;
}

/** A store as KV is, counting its reads and writes. */
class Store implements KeyStore {
  data = new Map<string, string>();
  reads = 0;
  writes = 0;
  async get(key: string) {
    this.reads++;
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.writes++;
    this.data.set(key, value);
  }
}

const jwks = { keys: [] as Key[], up: true, fetches: 0 };
let server: Server;
let url = "";
const DOWN = "http://127.0.0.1:9/jwks";
const at = { room: ROOM, requireRoom: true };

before(async () => {
  server = createServer((_req, res) => {
    jwks.fetches++;
    if (!jwks.up) return void res.writeHead(503).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: jwks.keys.map((k) => k.jwk) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/jwks`;
});
after(() => server?.close());
beforeEach(() => {
  forgetKeys();
  jwks.keys = [makeKey("k1")];
  jwks.up = true;
  jwks.fetches = 0;
});

describe("the keys kept in the store", () => {
  test("fetched: kept; fetched again unchanged (a new isolate): read, not written again; a new key: written", async () => {
    const store = new Store();
    const env = { PASS_JWKS_URL: url, PASS_KEYS: store };
    assert.equal((await checkPass(env, makePass(jwks.keys[0]), at)).status, "valid");
    assert.equal(store.writes, 1);
    assert.deepEqual(JSON.parse(store.data.get("jwks")!), [{ kid: "k1", x: jwks.keys[0].jwk.x }]);
    forgetKeys();
    assert.equal((await checkPass(env, makePass(jwks.keys[0]), at)).status, "valid");
    assert.equal(store.writes, 1, "the same keys: not written again");
    // A key added (rotation): the unknown kid fetches the JWKS again, and the store follows.
    jwks.keys.push(makeKey("k2"));
    assert.equal((await checkPass(env, makePass(jwks.keys[1]), at)).status, "valid");
    assert.equal(store.writes, 2);
    assert.deepEqual(
      JSON.parse(store.data.get("jwks")!).map((k: { kid: string }) => k.kid),
      ["k1", "k2"],
    );
  });

  test("the JWKS away, a fresh isolate: the kept keys check passes (valid, a forgery invalid, an unknown kid unverified)", async () => {
    const store = new Store();
    await checkPass({ PASS_JWKS_URL: url, PASS_KEYS: store }, makePass(jwks.keys[0]), at);
    forgetKeys();
    jwks.up = false;
    const env = { PASS_JWKS_URL: url, PASS_KEYS: store };
    assert.equal((await checkPass(env, makePass(jwks.keys[0]), at)).status, "valid");
    assert.equal((await checkPass(env, makePass(makeKey("k1")), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(makeKey("k9")), at)).status, "unverified");
    // Not fetched again for each check while it's away (once per 10 s at most).
    assert.equal(jwks.fetches, 2);
  });

  test("nothing ever fetched or kept, the JWKS away: unverified, never valid", async () => {
    for (const env of [{ PASS_JWKS_URL: DOWN, PASS_KEYS: new Store() }, { PASS_JWKS_URL: DOWN }]) {
      forgetKeys();
      assert.deepEqual(await checkPass(env, makePass(jwks.keys[0]), at), { status: "unverified" });
    }
  });

  test("an empty JWKS never replaces the kept keys", async () => {
    const store = new Store();
    await checkPass({ PASS_JWKS_URL: url, PASS_KEYS: store }, makePass(jwks.keys[0]), at);
    const kept = store.data.get("jwks");
    forgetKeys();
    const k1 = jwks.keys[0];
    jwks.keys = [];
    assert.equal((await checkPass({ PASS_JWKS_URL: url, PASS_KEYS: store }, makePass(k1), at)).status, "invalid");
    assert.equal(store.data.get("jwks"), kept);
  });
});

describe("its life", () => {
  test("24 hours: valid; longer than 26 hours from its iat (a 7-day pass from before), or no iat, or one from the future: invalid", async () => {
    const env = { PASS_JWKS_URL: url };
    const key = jwks.keys[0];
    const now = Math.floor(Date.now() / 1000);
    const pass = makePass(key);
    const back = await checkPass(env, pass, at);
    assert.equal(back.status, "valid");
    assert.equal(back.status === "valid" && back.sub, "acct_test");
    assert.equal(back.status === "valid" && back.iat, now);
    assert.equal((await checkPass(env, makePass(key, { exp: now + 7 * 86400 }), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(key, { iat: now - 6 * 86400, exp: now + 86400 }), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(key, { iat: undefined }), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(key, { iat: now + 3600, exp: now + 7200 }), at)).status, "invalid");
    // RELAY_LIMITS' passMaxLifeMs sets another.
    assert.equal((await checkPass(env, makePass(key, { exp: now + 7 * 86400 }), { ...at, maxLifeMs: 8 * 86400_000 })).status, "valid");
  });
});

describe("the room claim", () => {
  test("this room: valid; another: invalid; none: invalid only when required", async () => {
    const env = { PASS_JWKS_URL: url };
    const key = jwks.keys[0];
    assert.equal((await checkPass(env, makePass(key), at)).status, "valid");
    assert.equal((await checkPass(env, makePass(key, { room: "cd".repeat(16) }), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(key, { room: undefined }), at)).status, "invalid");
    assert.equal((await checkPass(env, makePass(key, { room: undefined }), { room: ROOM, requireRoom: false })).status, "valid");
    assert.equal((await checkPass(env, makePass(key, { room: "cd".repeat(16) }), { room: ROOM, requireRoom: false })).status, "invalid");
  });
});
