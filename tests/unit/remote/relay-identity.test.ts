// The Mac's relay keys (src/remote/relay-identity.ts): made once and kept, the same room after, and
// none without a store. On a store in memory, and on a throwaway keychain through the real helper
// (as tests/unit/platform/macos/keychain.test.ts: `security create-keychain`, deleted after; never
// the login keychain). No key is printed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { KeyStore } from "../../../src/platform/types.ts";
import { keychainStore } from "../../../src/platform/macos/keychain.ts";
import { buildNative } from "../../../src/platform/macos/native.ts";
import { DEVICE_KEY_NAME, loadIdentity } from "../../../src/remote/relay-identity.ts";
import { roomOf } from "../../../src/remote/tunnel.ts";

function memoryStore(): KeyStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    where: "memory",
    get: (names) => Object.fromEntries(names.filter((n) => items.has(n)).map((n) => [n, items.get(n)!])),
    set: async (name, key) => void items.set(name, key),
    remove: async (name) => items.delete(name),
    list: async () => [...items.keys()],
  };
}

test("made the first time and kept: the same keys and room every time after", async () => {
  const store = memoryStore();
  const first = await loadIdentity(store);
  assert.ok(first);
  assert.equal(first.room, roomOf(first.signing.public));
  assert.match(store.items.get(DEVICE_KEY_NAME)!, /^kiko-device-v1:[A-Za-z0-9+/=]{44}:[A-Za-z0-9+/=]{44}$/);
  const again = await loadIdentity(store);
  assert.equal(again?.room, first.room);
  assert.ok(again?.static.public.equals(first.static.public));
});

test("no store (the Keychain off): no identity, so no relay; one it can't read is made again", async () => {
  assert.equal(await loadIdentity(null), null);
  const store = memoryStore();
  store.items.set(DEVICE_KEY_NAME, "garbage");
  const made = await loadIdentity(store);
  assert.ok(made);
  assert.notEqual(store.items.get(DEVICE_KEY_NAME), "garbage");
});

const can = process.platform === "darwin" && spawnSync("swiftc", ["--version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "rk-"));
const file = join(dir, "relay.keychain-db");

describe("in a throwaway keychain, through the keychain helper", { skip: !can && "needs macOS and swiftc" }, () => {
  let helper = "";
  before(() => {
    helper = buildNative("keychain", { into: join(dir, "bin"), sign: "-" });
    execFileSync("security", ["create-keychain", "-p", randomBytes(16).toString("hex"), file], { stdio: "ignore" });
  });
  after(() => {
    spawnSync("security", ["delete-keychain", file], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("kept under its own name, and read back the same", async () => {
    const store = keychainStore({ file, helper: () => helper, service: "sh.kiko.test.keys" });
    const made = await loadIdentity(store);
    assert.deepEqual(await store.list(), [DEVICE_KEY_NAME]);
    const read = await loadIdentity(keychainStore({ file, helper: () => helper, service: "sh.kiko.test.keys" }));
    assert.equal(read?.room, made?.room);
    assert.ok(read?.signing.seed.equals(made!.signing.seed));
  });
});
