// The watch on the relay's socket (src/remote/relay-client.ts), 2026-11-13: a VPN turned on left the
// Mac "connected" for 75 s on a socket nothing got through, the phone unable to reach it. A ping every 10 s whose
// pong must come within 5; a ping at once as the network changes, its pong within 3; a dead socket
// dialled again at once, repeated failures with the growing wait as before. Time is the test's
// (FakeClock) and so is the socket (FakeWire): nothing here opens a real one.
import "../../setup.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import type { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pairing } from "../../../src/remote/pairing.ts";
import { RelayClient, type RelayWire } from "../../../src/remote/relay-client.ts";
import { newIdentity } from "../../../src/remote/relay-identity.ts";
import { FakeClock } from "../../support/clock.ts";

/** The relay's end of a socket: signs the Mac in when told to, and answers its pings unless `answers` is off (half-open). */
class FakeWire extends EventEmitter {
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;
  answers = true;
  /** How long a pong takes. */
  latency = 20;
  private clock: FakeClock;

  constructor(clock: FakeClock) {
    super();
    this.clock = clock;
  }

  send(data: string | Buffer) {
    if (typeof data !== "string") return;
    this.sent.push(data);
    if (data === "ping") {
      if (this.answers) this.clock.setTimeout(() => this.say("pong"), this.latency);
    } else if (JSON.parse(data).type === "auth") this.say(JSON.stringify({ type: "ready", pairing: true }));
  }

  private say(text: string) {
    this.emit("message", Buffer.from(text), false);
  }

  /** The relay takes the connection: its challenge, which the client signs, and ready. */
  accept() {
    this.readyState = 1;
    this.say(JSON.stringify({ type: "challenge", nonce: randomBytes(32).toString("base64") }));
  }

  /** The connection fails, as a dial to a relay that's down does. */
  fail() {
    this.readyState = 3;
    this.emit("error", new Error("socket hang up"));
    this.emit("close", 1006, Buffer.alloc(0));
  }

  close() {
    this.readyState = 3;
  }

  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }

  get pings() {
    return this.sent.filter((s) => s === "ping").length;
  }
}

/** This test process's log lines for an event (tests/setup.ts puts the log in its own folder), without their times. */
function logged(event: string): any[] {
  const dir = process.env.KIKO_LOG_DIR!;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((l) => l.event === event)
    .map(({ t: _t, ms: _ms, event: _event, ...rest }) => rest);
}

const identity = newIdentity();
let n = 0;

type Options = ConstructorParameters<typeof RelayClient>[0];

/** A client on a clock and sockets of the test's own, started; `connected`: its first socket signed in too. */
function make(o: Partial<Options> = {}, connected = true) {
  const clock = new FakeClock();
  clock.t = 1_000_000;
  const wires: FakeWire[] = [];
  const client = new RelayClient({
    url: "ws://relay.test",
    identity,
    pairing: new Pairing(join(process.cwd(), `phones-watchdog-${n++}.json`)),
    server: { adopt: () => {} },
    clock,
    connect: () => {
      const wire = new FakeWire(clock);
      wires.push(wire);
      return wire as unknown as RelayWire;
    },
    network: false,
    ...o,
  });
  client.start();
  if (connected) wires[0].accept();
  const mark = { checked: logged("relay_checked").length, disconnected: logged("relay_disconnected").length };
  return {
    clock,
    wires,
    client,
    /** What this test logged, since it began. */
    checked: () => logged("relay_checked").slice(mark.checked),
    disconnected: () => logged("relay_disconnected").slice(mark.disconnected),
  };
}

test("a healthy link is left alone: a ping every 10 s, each answered, the one socket kept", () => {
  const t = make();
  assert.equal(t.client.status, "connected");
  t.clock.advance(60_000);
  assert.equal(t.wires.length, 1);
  assert.equal(t.wires[0].pings, 6);
  assert.equal(t.wires[0].terminated, false);
  assert.equal(t.client.status, "connected");
  assert.deepEqual(t.disconnected(), []);
  assert.deepEqual(t.checked(), [], "the regular pings aren't logged");
  t.client.stop();
});

test("a pong that hasn't come 5 s after its ping: the socket is terminated and dialled again at once (15 s at worst, not 50)", () => {
  const t = make();
  t.wires[0].answers = false; // half-open from the moment it connected, as the log's
  t.clock.advance(10_000);
  assert.equal(t.wires[0].pings, 1);
  t.clock.advance(4_999);
  assert.equal(t.wires[0].terminated, false, "the pong has its 5 s");
  assert.equal(t.client.status, "connected");
  t.clock.advance(1);
  assert.equal(t.wires[0].terminated, true);
  assert.equal(t.wires.length, 2, "dialled again in the same instant: no wait");
  assert.equal(t.client.status, "connecting");
  t.wires[1].accept();
  assert.equal(t.client.status, "connected");
  assert.deepEqual(t.disconnected(), [{ code: 1006, reason: "", why: "no pong", connectedMs: 15_000 }]);
  // The new socket is watched as the first was.
  t.clock.advance(30_000);
  assert.equal(t.wires[1].pings, 3);
  assert.equal(t.wires.length, 2);
  t.client.stop();
});

test("a pong 4.9 s late is still a pong", () => {
  const t = make();
  t.wires[0].latency = 4_900;
  t.clock.advance(40_000);
  assert.equal(t.wires.length, 1);
  assert.equal(t.client.status, "connected");
  t.client.stop();
});

test("the network changes under a dead link: pinged at once, and replaced within 3 s", () => {
  const t = make();
  t.clock.advance(12_000);
  t.wires[0].answers = false;
  t.client.check("network changed");
  assert.equal(t.wires[0].pings, 2, "the regular ping at 10 s, and the check's now");
  t.clock.advance(2_999);
  assert.equal(t.wires.length, 1);
  t.clock.advance(1);
  assert.equal(t.wires[0].terminated, true);
  assert.equal(t.wires.length, 2, "dialled again at once");
  t.wires[1].accept();
  assert.equal(t.client.status, "connected");
  assert.deepEqual(t.checked(), [{ why: "network changed", result: "no pong", waitedMs: 3_000 }]);
  assert.deepEqual(t.disconnected(), [{ code: 1006, reason: "", why: "network changed", connectedMs: 15_000 }]);
  t.client.stop();
});

test("the network changes under a healthy link: one ping, its pong logged, the socket kept and its regular pings as before", () => {
  const t = make();
  t.clock.advance(3_000);
  t.client.check("wake");
  t.clock.advance(20);
  assert.deepEqual(t.checked(), [{ why: "wake", result: "pong", pongMs: 20 }]);
  t.clock.advance(60_000);
  assert.equal(t.wires.length, 1);
  assert.equal(t.wires[0].pings, 1 + 6);
  assert.deepEqual(t.disconnected(), []);
  t.client.stop();
});

test("several changes in a row are one check: a check waiting for its pong takes the next as its own", () => {
  const t = make();
  t.wires[0].latency = 1_000;
  t.client.check("network changed");
  t.clock.advance(300);
  t.client.check("network changed");
  t.client.check("wake");
  assert.equal(t.wires[0].pings, 1);
  t.clock.advance(700);
  assert.deepEqual(t.checked(), [{ why: "network changed", result: "pong", pongMs: 1_000 }]);
  // Answered, the next change is checked afresh.
  t.client.check("network changed");
  assert.equal(t.wires[0].pings, 2);
  t.client.stop();
});

test("a check's pong is its own: a regular ping's pong, sent before the network changed, doesn't pass it", () => {
  const t = make();
  t.wires[0].latency = 2_500;
  t.clock.advance(10_000); // the regular ping, its pong on the way
  t.clock.advance(1_000);
  t.wires[0].answers = false; // the network changes: nothing more gets through
  t.client.check("network changed");
  t.clock.advance(1_500); // the regular ping's pong arrives
  assert.equal(t.wires.length, 1);
  t.clock.advance(1_500);
  assert.equal(t.wires[0].terminated, true, "the check's own pong never came");
  assert.equal(t.wires.length, 2);
  t.client.stop();
});

test("frames still waiting to go (a reply's audio on a slow uplink): the ping is behind them, so its pong has 25 s in all; a queue that never empties is still a dead socket", () => {
  const t = make();
  t.wires[0].latency = 12_000; // the ping leaves late: its pong comes 12 s after it was sent
  t.wires[0].bufferedAmount = 900_000;
  t.clock.advance(10_000 + 11_999);
  assert.equal(t.wires.length, 1, "kept while the queue is still going out");
  t.wires[0].bufferedAmount = 0;
  t.clock.advance(1);
  assert.equal(t.client.status, "connected");
  assert.deepEqual(t.disconnected(), []);
  // The same queue on a socket nothing leaves: dropped 25 s after its ping, not kept for ever.
  t.wires[0].answers = false;
  t.wires[0].bufferedAmount = 900_000;
  t.clock.advance(8_000); // the next regular ping, at 30 s
  assert.equal(t.wires[0].pings, 2);
  t.clock.advance(24_999);
  assert.equal(t.wires.length, 1);
  t.clock.advance(1);
  assert.equal(t.wires[0].terminated, true);
  assert.equal(t.wires.length, 2);
  assert.deepEqual(
    t.disconnected().map((d) => d.why),
    ["no pong"],
  );
  t.client.stop();
});

const v4 = (address: string) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` });

test("a VPN comes up (the log's): the interfaces change for a few seconds, the socket goes half-open; checked once they settle, replaced, and checked once more", () => {
  const net: { now: ReturnType<typeof networkInterfaces> } = { now: { en0: [v4("192.168.1.20")] } };
  const t = make({ network: { interfaces: () => net.now } });
  t.clock.advance(1_000);
  // The VPN's interface appears, then gets its address; the socket made before is dead from here.
  net.now = { ...net.now, utun4: [v4("169.254.10.1")] };
  t.wires[0].answers = false;
  t.clock.advance(2_000);
  net.now = { ...net.now, utun4: [v4("10.8.0.2")] };
  t.clock.advance(1_000); // seen at 4 s; settled at 6.5 s
  assert.equal(t.wires[0].pings, 0, "not checked while it's still changing");
  t.clock.advance(2_500);
  assert.equal(t.wires[0].pings, 1, "one check for the two changes");
  t.clock.advance(3_000);
  assert.equal(t.wires[0].terminated, true);
  assert.equal(t.wires.length, 2, "replaced 9.5 s after the VPN began, 5.5 s after the last change was seen");
  t.wires[1].accept();
  // Once more, 5 s after the first check: the new socket answers.
  t.clock.advance(2_000 + 20);
  assert.equal(t.wires[1].pings, 1);
  assert.deepEqual(t.checked(), [
    { why: "network changed", result: "no pong", waitedMs: 3_000 },
    { why: "network changed", result: "pong", pongMs: 20 },
  ]);
  assert.equal(t.wires.length, 2);
  assert.equal(t.client.status, "connected");
  t.client.stop();
  assert.equal(t.clock.pending(), 0, "stopped: no timer left, the network's watch included");
});

test("repeated failures still wait longer each time: only the first dial after a dead link is at once", () => {
  const t = make({ retryMs: { min: 1_000, max: 60_000 } });
  t.wires[0].answers = false;
  t.clock.advance(15_000);
  assert.equal(t.wires.length, 2, "no pong: dialled at once");
  // The relay can't be reached: each dial fails, and the next waits 1 s, 2 s, 4 s (give or take a fifth).
  for (const [i, wait] of [1_000, 2_000, 4_000].entries()) {
    t.wires[1 + i].fail();
    t.clock.advance(wait * 0.8 - 1);
    assert.equal(t.wires.length, 2 + i, `no dial before ${wait * 0.8} ms`);
    t.clock.advance(wait * 0.4 + 1);
    assert.equal(t.wires.length, 3 + i, `dialled by ${wait * 1.2} ms`);
  }
  // Signed in again, the count starts over.
  t.wires[4].accept();
  t.wires[4].fail();
  t.clock.advance(1_200);
  assert.equal(t.wires.length, 6);
  assert.deepEqual(
    t.disconnected().map((d) => d.why),
    ["no pong", "1006", "1006", "1006", "1006"],
  );
  t.client.stop();
});

test("waiting to dial again as the network changes: dialled now; more changes while it dials bring no second dial", () => {
  const t = make({ retryMs: { min: 30_000, max: 60_000 } });
  t.wires[0].fail();
  t.clock.advance(5_000);
  assert.equal(t.wires.length, 1, "waiting its 30 s");
  t.client.check("network changed");
  assert.equal(t.wires.length, 2, "dialled at once");
  t.client.check("network changed");
  t.clock.advance(2_999);
  t.client.check("wake");
  assert.equal(t.wires.length, 2, "a dial under 3 s old is left to it");
  assert.equal(t.wires[1].terminated, false);
  t.wires[1].accept();
  assert.equal(t.client.status, "connected");
  assert.deepEqual(t.checked(), [
    { why: "network changed", result: "dialled" },
    { why: "network changed", result: "dialling", dialMs: 0 },
    { why: "wake", result: "dialling", dialMs: 2_999 },
  ]);
  t.clock.advance(60_000);
  assert.equal(t.wires.length, 2, "the wait it was in is gone: no late dial");
  t.client.stop();
});

test("a dial in the air for 3 s as the network changes is made again; one that never signs in is given up after 15 s and waits like any failure", () => {
  const t = make({ retryMs: { min: 1_000, max: 60_000 } }, false);
  t.clock.advance(3_000);
  t.client.check("network changed");
  assert.equal(t.wires[0].terminated, true);
  assert.equal(t.wires.length, 2, "dialled again at once");
  assert.deepEqual(t.checked(), [{ why: "network changed", result: "dial stuck", dialMs: 3_000 }]);
  // No more changes: this one hangs.
  t.clock.advance(14_999);
  assert.equal(t.wires[1].terminated, false);
  t.clock.advance(1);
  assert.equal(t.wires[1].terminated, true);
  assert.equal(t.wires.length, 2, "not at once: a failure waits");
  t.clock.advance(1_200);
  assert.equal(t.wires.length, 3);
  assert.deepEqual(
    t.disconnected().map((d) => d.why),
    ["network changed", "dial timed out"],
  );
  t.client.stop();
});

test("stopped: nothing is checked, dialled or left running", () => {
  const t = make();
  t.clock.advance(10_000); // a ping waiting for its pong
  t.client.stop();
  assert.equal(t.clock.pending() <= 1, true, "only the fake relay's own pong may be left");
  t.client.check("network changed");
  t.clock.advance(120_000);
  assert.equal(t.wires.length, 1);
  assert.equal(t.wires[0].pings, 1);
});
