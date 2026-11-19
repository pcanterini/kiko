// The address the per-address limits count (src/address.ts), in plain Node: IPv4 as it is, IPv6 by
// its /64 however it's written, an IPv4-mapped IPv6 address as its IPv4 one, nothing as "unknown".
import assert from "node:assert/strict";
import { test } from "node:test";
import { addressOf } from "../src/address.ts";

test("IPv4 as it is; IPv6 by its /64, written short or long; IPv4-mapped as IPv4; none unknown", () => {
  assert.equal(addressOf("203.0.113.5"), "203.0.113.5");
  assert.equal(addressOf("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(addressOf("2001:0DB8:0001:0002:ffff:0:0:9"), "2001:db8:1:2::/64");
  assert.equal(addressOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressOf("::1"), "0:0:0:0::/64");
  assert.notEqual(addressOf("2001:db8:1:3::1"), addressOf("2001:db8:1:2::1"));
  assert.equal(addressOf("::ffff:198.51.100.7"), "198.51.100.7");
  assert.equal(addressOf(null), "unknown");
  assert.equal(addressOf(" "), "unknown");
});
