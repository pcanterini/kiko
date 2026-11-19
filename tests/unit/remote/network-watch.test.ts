// The watch on the Mac's network (src/remote/network-watch.ts), 2026-11-13: a change in the
// interfaces is said once it has settled and once more a few seconds later, several in a row are
// one, and a poll that comes late is the Mac waking. The interfaces and the clock are the test's.
import "../../setup.ts";
import assert from "node:assert/strict";
import type { networkInterfaces } from "node:os";
import { test } from "node:test";
import { NetworkWatch, networkSignature, type NetworkWhy } from "../../../src/remote/network-watch.ts";
import { FakeClock } from "../../support/clock.ts";

type Interfaces = ReturnType<typeof networkInterfaces>;

const v4 = (address: string, internal = false) => ({ address, netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });
const HOME: Interfaces = { lo0: [v4("127.0.0.1", true)], en0: [v4("192.168.1.20")] };
const VPN_COMING: Interfaces = { ...HOME, utun4: [v4("169.254.10.1")] };
const VPN: Interfaces = { ...HOME, utun4: [v4("10.8.0.2")] };

function make(o: { skew?: () => number } = {}) {
  const clock = new FakeClock();
  clock.t = 1_000_000;
  const said: Array<{ why: NetworkWhy; at: number }> = [];
  const net = { now: HOME };
  // `skew`: the wall clock ahead of the timers, as after a sleep.
  const seen = { now: () => clock.t + (o.skew?.() ?? 0), setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) };
  const watch = new NetworkWatch((why) => said.push({ why, at: clock.t - 1_000_000 }), { clock: seen, interfaces: () => net.now });
  watch.start();
  return { clock, said, net, watch };
}

test("nothing changes: nothing is said", () => {
  const t = make();
  t.clock.advance(60_000);
  assert.deepEqual(t.said, []);
  t.watch.stop();
});

test("a change is said once it has stayed the same for 2.5 s, and once more 5 s later", () => {
  const t = make();
  t.clock.advance(500);
  t.net.now = VPN;
  t.clock.advance(1_500); // the poll at 2 s sees it
  t.clock.advance(2_499);
  assert.deepEqual(t.said, [], "not before it has settled");
  t.clock.advance(1);
  assert.deepEqual(t.said, [{ why: "network changed", at: 4_500 }]);
  t.clock.advance(5_000);
  assert.deepEqual(t.said, [
    { why: "network changed", at: 4_500 },
    { why: "network changed", at: 9_500 },
  ]);
  t.clock.advance(60_000);
  assert.equal(t.said.length, 2, "and no more");
  t.watch.stop();
});

test("a VPN coming up, the interfaces changing at one poll after another: said once, after the last change", () => {
  const t = make();
  t.net.now = VPN_COMING;
  t.clock.advance(2_000);
  t.net.now = HOME;
  t.clock.advance(2_000);
  t.net.now = VPN_COMING;
  t.clock.advance(2_000);
  t.net.now = VPN;
  t.clock.advance(2_000); // the last change, seen at 8 s
  assert.deepEqual(t.said, [], "nothing while it keeps changing");
  t.clock.advance(2_500);
  assert.deepEqual(t.said, [{ why: "network changed", at: 10_500 }]);
  t.clock.advance(5_000);
  assert.equal(t.said.length, 2);
  t.watch.stop();
});

test("a change during the wait for the second say starts over: settled, then once more", () => {
  const t = make();
  t.net.now = VPN_COMING;
  t.clock.advance(4_500); // seen at 2 s, said at 4.5 s
  assert.equal(t.said.length, 1);
  t.net.now = VPN;
  t.clock.advance(1_500); // seen at 6 s: the second say (due 9.5 s) is dropped for this change's own
  t.clock.advance(2_500);
  assert.deepEqual(
    t.said.map((s) => s.at),
    [4_500, 8_500],
  );
  t.clock.advance(5_000);
  assert.deepEqual(
    t.said.map((s) => s.at),
    [4_500, 8_500, 13_500],
  );
  t.watch.stop();
});

test("loopback and Apple's peer-to-peer Wi-Fi (awdl, llw) coming and going are no change", () => {
  const t = make();
  t.net.now = { ...HOME, awdl0: [v4("169.254.3.3")], llw0: [v4("169.254.4.4")], lo0: [v4("127.0.0.1", true), v4("127.0.0.2", true)] };
  t.clock.advance(20_000);
  assert.deepEqual(t.said, []);
  assert.equal(networkSignature(t.net.now), networkSignature(HOME));
  assert.notEqual(networkSignature(VPN), networkSignature(HOME));
  t.watch.stop();
});

test("a poll that comes 10 s late is the Mac waking: said as that, once settled and once more, whatever changed with it", () => {
  let skew = 0;
  const t = make({ skew: () => skew });
  t.clock.advance(4_000);
  skew = 3_600_000; // asleep for an hour: the next poll finds the wall clock that far on
  t.net.now = VPN;
  t.clock.advance(2_000);
  t.clock.advance(2_500);
  assert.deepEqual(t.said, [{ why: "wake", at: 8_500 }]);
  t.clock.advance(5_000);
  assert.deepEqual(
    t.said.map((s) => s.why),
    ["wake", "wake"],
  );
  t.clock.advance(60_000);
  assert.equal(t.said.length, 2, "one late poll, not every poll since");
  t.watch.stop();
});

test("interfaces that can't be read are no change; stopped, nothing is left running", () => {
  const t = make();
  t.net.now = VPN;
  const watch = new NetworkWatch(() => assert.fail("nothing to say"), {
    clock: t.clock,
    interfaces: () => {
      throw new Error("uv_interface_addresses returned Unknown system error 1");
    },
  });
  watch.start();
  t.clock.advance(1_000);
  watch.stop();
  t.watch.stop();
  assert.equal(t.clock.pending(), 0);
  t.clock.advance(60_000);
  assert.deepEqual(t.said, []);
});
