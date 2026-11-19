// The relay pass's revocation list as a room reads it (src/revoked.ts), in plain Node (the module has no
// imports): both keys in one bulk get, a pass issued before an entry revoked and one after not, an
// entry past its `until` ignored, what was read kept for the cache's time and read again after, no
// namespace revoking nothing, and KV away failing closed ("unknown") after a short stale window.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RevokedList, revokedKeys, type RevokedStore } from "../src/revoked.ts";

const ROOM = "ab".repeat(16);

/** A store as KV's bulk get is, counting its reads (each a call, with its keys). */
class Store implements RevokedStore {
  data = new Map<string, string>();
  calls: string[][] = [];
  down = false;
  async get(keys: string[], _type: "text") {
    this.calls.push(keys);
    if (this.down) throw new Error("KV away");
    return new Map(keys.map((k) => [k, this.data.get(k) ?? null] as const));
  }
}

const T = 1_800_000_000; // a moment, in Unix seconds
const ms = (s: number) => s * 1000;
const entry = (at: number, until = at + 26 * 3600) => JSON.stringify({ at, until });

describe("the revocation list", () => {
  test("its keys: the account's, and the account's on the room", () => {
    assert.deepEqual(revokedKeys("acct_1", ROOM), ["sub:acct_1", `room:acct_1:${ROOM}`]);
  });

  test("an account's entry: a pass issued before it revoked, at or after it not; read in one bulk get of both keys", async () => {
    const store = new Store();
    store.data.set("sub:acct_1", entry(T));
    const list = new RevokedList(store, 60_000);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T + 10)), "revoked");
    assert.equal(await list.check("acct_1", ROOM, T, ms(T + 10)), "clear");
    assert.equal(await list.check("acct_1", ROOM, T + 5, ms(T + 10)), "clear");
    assert.deepEqual(store.calls, [["sub:acct_1", `room:acct_1:${ROOM}`]]);
    assert.equal(await new RevokedList(store, 60_000).check("acct_2", ROOM, T - 1, ms(T + 10)), "clear");
  });

  test("a room's entry: that room only", async () => {
    const store = new Store();
    store.data.set(`room:acct_1:${ROOM}`, entry(T));
    assert.equal(await new RevokedList(store, 60_000).check("acct_1", ROOM, T - 1, ms(T + 10)), "revoked");
    assert.equal(await new RevokedList(store, 60_000).check("acct_1", "cd".repeat(16), T - 1, ms(T + 10)), "clear");
  });

  test("kept for the cache's time (no read), then read again: a revocation written meanwhile shows within it", async () => {
    const store = new Store();
    const list = new RevokedList(store, 60_000);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T)), "clear");
    store.data.set("sub:acct_1", entry(T));
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T) + 59_000), "clear", "the read kept");
    assert.equal(store.calls.length, 1);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T) + 60_000), "revoked", "read again");
    assert.equal(store.calls.length, 2);
  });

  test("an entry expires: past its until it counts for nothing (every pass before it has run out by then)", async () => {
    const store = new Store();
    store.data.set("sub:acct_1", entry(T, T + 26 * 3600));
    const list = new RevokedList(store, 0);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T + 26 * 3600 - 1)), "revoked");
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T + 26 * 3600)), "clear");
  });

  test("KV away with nothing read before: unknown (the relay refuses the pass); a failed read isn't kept, so it's asked again at once", async () => {
    const store = new Store();
    store.data.set("sub:acct_1", entry(T));
    store.down = true;
    const list = new RevokedList(store, 60_000);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T)), "unknown");
    assert.equal(await list.check("acct_1", ROOM, T + 5, ms(T)), "unknown", "even a pass from after any entry: nothing is known");
    store.down = false;
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T) + 1), "revoked", "asked again at once");
  });

  test("KV away after a read: that read stands for staleMs, then unknown (fail closed after a bounded window)", async () => {
    const store = new Store();
    const list = new RevokedList(store, 60_000, 10 * 60_000);
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T)), "clear");
    store.down = true;
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T) + 9 * 60_000), "clear", "the read from 9 minutes ago");
    assert.equal(await list.check("acct_1", ROOM, T - 1, ms(T) + 10 * 60_000), "unknown", "10 minutes on: not known");
    // A read that said revoked stands the same way.
    const s2 = new Store();
    s2.data.set("sub:acct_1", entry(T));
    const l2 = new RevokedList(s2, 60_000, 10 * 60_000);
    assert.equal(await l2.check("acct_1", ROOM, T - 1, ms(T + 1)), "revoked");
    s2.down = true;
    assert.equal(await l2.check("acct_1", ROOM, T - 1, ms(T + 1) + 5 * 60_000), "revoked");
  });

  test("no namespace, or an entry that isn't one: nothing revoked", async () => {
    assert.equal(await new RevokedList(undefined, 60_000).check("acct_1", ROOM, T - 1, ms(T)), "clear");
    for (const bad of ["", "nope", "{}", JSON.stringify({ at: "x", until: T + 9 }), "[1]"]) {
      const s = new Store();
      s.data.set("sub:acct_1", bad);
      assert.equal(await new RevokedList(s, 60_000).check("acct_1", ROOM, T - 1, ms(T)), "clear", bad);
    }
  });
});
