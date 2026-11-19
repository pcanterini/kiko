// RELAY_LIMITS, parsed (src/limits.ts): a whole setting, one with only some keys (the defaults
// filling in), and ones that aren't valid, in part or at all (the defaults holding). Plain Node: the
// module has no imports. The numbers here are made up for the test.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULTS, LIMITS, PROTOCOL, limitsOf, parseLimits } from "../src/limits.ts";

const whole = {
  pending: 7,
  macPending: 3,
  pendingPerIp: 5,
  ipRate: { perSecond: 2, burst: 6 },
  phoneRate: { perSecond: 3, burst: 9 },
  macRate: { perSecond: 30, burst: 90 },
  windowMs: 120_000,
  windowBytes: 5_000_000,
  dayMs: 3_600_000,
  dayBytes: 50_000_000,
  roomsPerIpHour: 4,
  ipsTracked: 500,
  roomsPerAccount: 3,
  roomsPerAccountMs: 3_600_000,
  requirePass: false,
  passMaxLifeMs: 7_200_000,
  revokedCacheMs: 5_000,
  revokedStaleMs: 60_000,
};

describe("RELAY_LIMITS", () => {
  test("unset or empty: the defaults, protocol and abuse limits both", () => {
    for (const raw of [undefined, "", "  "]) {
      const { limits, ignored } = parseLimits(raw);
      assert.deepEqual(limits, { ...PROTOCOL, ...DEFAULTS });
      assert.deepEqual(ignored, []);
    }
  });

  test("every abuse limit set: each taken, the protocol's untouched", () => {
    const { limits, ignored } = parseLimits(JSON.stringify(whole));
    assert.deepEqual(limits, { ...PROTOCOL, ...whole });
    assert.deepEqual(ignored, []);
  });

  test("some keys: those taken, the rest the defaults (and half a rate keeps the other half's default)", () => {
    const { limits, ignored } = parseLimits(JSON.stringify({ pending: 3, dayBytes: 1024, macRate: { burst: 40 } }));
    assert.deepEqual(ignored, []);
    assert.equal(limits.pending, 3);
    assert.equal(limits.dayBytes, 1024);
    assert.deepEqual(limits.macRate, { perSecond: DEFAULTS.macRate.perSecond, burst: 40 });
    assert.deepEqual(limits.phoneRate, DEFAULTS.phoneRate);
    assert.equal(limits.windowBytes, DEFAULTS.windowBytes);
    assert.equal(limits.idleMs, PROTOCOL.idleMs);
  });

  test("requirePass: ON by default (unset, empty, or not JSON at all: fails closed); true or false taken; anything else keeps it on, named", () => {
    for (const raw of [undefined, "", "{not json", "[]"]) assert.equal(parseLimits(raw).limits.requirePass, true, String(raw));
    assert.equal(parseLimits(JSON.stringify({ pending: 4 })).limits.requirePass, true, "a setting without the key");
    assert.equal(parseLimits(JSON.stringify({ requirePass: true })).limits.requirePass, true);
    assert.equal(parseLimits(JSON.stringify({ requirePass: false })).limits.requirePass, false, "off only when set so");
    for (const v of ["false", 0, null, {}]) {
      const { limits, ignored } = parseLimits(JSON.stringify({ requirePass: v, pending: 4 }));
      assert.equal(limits.requirePass, true);
      assert.equal(limits.pending, 4);
      assert.deepEqual(ignored, ["requirePass"]);
    }
  });

  test("tests may shorten the protocol's timings too", () => {
    const { limits } = parseLimits(JSON.stringify({ signInMs: 1_000, idleMs: 1_500 }));
    assert.equal(limits.signInMs, 1_000);
    assert.equal(limits.idleMs, 1_500);
  });

  test("an invalid value: that key keeps its default, the valid ones are taken, and the key (not its value) is named", () => {
    const { limits, ignored } = parseLimits(
      JSON.stringify({
        pending: 0,
        roomsPerIpHour: 2.5,
        windowBytes: -1,
        dayMs: "a day",
        ipsTracked: null,
        phoneRate: { perSecond: 0, burst: 10 },
        macRate: [1, 2],
        ipRate: { burst: 0 },
        roomsPerAccount: -2,
        windowMs: 60_000,
      }),
    );
    assert.deepEqual(ignored.sort(), ["dayMs", "ipRate", "ipsTracked", "macRate", "pending", "phoneRate", "roomsPerAccount", "roomsPerIpHour", "windowBytes"]);
    assert.deepEqual(limits, { ...LIMITS, windowMs: 60_000 });
  });

  test("unknown keys are ignored, quietly", () => {
    const { limits, ignored } = parseLimits(JSON.stringify({ somethingNew: 5, pending: 4 }));
    assert.deepEqual(ignored, []);
    assert.equal(limits.pending, 4);
    assert.equal("somethingNew" in limits, false);
  });

  test("not a JSON object at all: every default", () => {
    for (const raw of ["{not json", "[1,2]", "42", "null", '"pending"']) {
      const { limits, ignored } = parseLimits(raw);
      assert.deepEqual(limits, LIMITS, raw);
      assert.deepEqual(ignored, ["RELAY_LIMITS"], raw);
    }
  });

  test("parsed once per isolate, and the defaults never changed by it", () => {
    const env = { RELAY_LIMITS: JSON.stringify(whole) };
    const a = limitsOf(env);
    assert.equal(limitsOf(env), a, "the same object: not parsed again");
    a.phoneRate.burst = 1;
    assert.equal(DEFAULTS.phoneRate.burst, LIMITS.phoneRate.burst);
    assert.notEqual(LIMITS.phoneRate.burst, 1);
    assert.deepEqual(limitsOf({}), LIMITS, "another setting: parsed afresh");
  });
});
