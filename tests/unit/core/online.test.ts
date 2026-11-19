// Whether the Mac is offline, as the app's own traffic shows it (src/core/online.ts), 2026-11-12: the
// relay couldn't look up relay.kiko.sh for two minutes and
// the router waited 12s for each message before giving up.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HOLD_MS, networkCode, Online } from "../../../src/core/online.ts";
import { FakeClock } from "../../support/clock.ts";

// As Node's fetch and the ws package report them.
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code} api.anthropic.com`), { code }) });
const dns = new Error("getaddrinfo ENOTFOUND relay.kiko.sh");

function make() {
  const clock = new FakeClock();
  clock.t = 1_000_000;
  const o = new Online(clock);
  let backs = 0;
  o.onBack = () => backs++;
  return { clock, o, backs: () => backs };
}

describe("network errors", () => {
  test("their codes, from fetch's cause or the message", () => {
    assert.equal(networkCode(fetchFailed("ENOTFOUND")), "ENOTFOUND");
    assert.equal(networkCode(dns), "ENOTFOUND");
    assert.equal(networkCode(new Error("connect ENETUNREACH 1.2.3.4:443")), "ENETUNREACH");
    assert.equal(networkCode(new Error("Jev 503: busy")), null);
    assert.equal(networkCode(new Error("timeout")), null);
  });
});

describe("down", () => {
  test("the relay can't look its host up: down at once, until something gets through", () => {
    const { o, clock } = make();
    assert.equal(o.down(), null);
    o.relayDisconnected();
    assert.equal(o.down(), null, "a relay that only closed says nothing about the network");
    o.relayError(dns);
    assert.equal(o.down()?.why, "network");
    assert.match(o.down()!.detail, /relay: ENOTFOUND/);
    clock.advance(30_000);
    assert.ok(o.down());
    o.relayConnected();
    assert.equal(o.down(), null);
  });

  test("a model call's network error: down; any answer after it: up", () => {
    const { o } = make();
    o.callFailed("anthropic", fetchFailed("ENOTFOUND"));
    assert.match(o.down()!.detail, /anthropic: ENOTFOUND/);
    o.ok();
    assert.equal(o.down(), null);
  });

  test("a service's own error (a 503, a bad key) isn't the network", () => {
    const { o } = make();
    o.callFailed("openrouter", new Error("Jev 503: overloaded"));
    assert.equal(o.down(), null);
  });

  test("a timeout counts only with the relay down too (the log: relay closed, then the clean-up timed out)", () => {
    const { o } = make();
    o.callTimedOut("cleanup");
    assert.equal(o.down(), null, "a slow model alone isn't offline");
    o.relayConnected();
    o.relayDisconnected();
    o.callTimedOut("cleanup");
    assert.equal(o.down()?.why, "timeouts");
  });

  test("no relay to say: the router timing out twice with nothing through between is down; once isn't", () => {
    const { o, clock } = make();
    o.callTimedOut("router");
    assert.equal(o.down(), null);
    clock.advance(1000);
    o.ok();
    clock.advance(1000);
    o.callTimedOut("router");
    assert.equal(o.down(), null, "an answer came between");
    o.callTimedOut("cleanup");
    assert.equal(o.down(), null, "a slow clean-up isn't the router");
    clock.advance(1000);
    o.callTimedOut("router");
    assert.equal(o.down()?.why, "timeouts");
  });

  test("a sign lasts HOLD_MS: with nothing newer, the models are tried again", () => {
    const { o, clock } = make();
    o.callFailed("anthropic", fetchFailed("EAI_AGAIN"));
    clock.advance(HOLD_MS - 1);
    assert.ok(o.down());
    clock.advance(2);
    assert.equal(o.down(), null);
  });

  test("the relay's retries keep it fresh", () => {
    const { o, clock } = make();
    o.relayError(dns);
    clock.advance(HOLD_MS - 10_000);
    o.relayError(dns);
    clock.advance(HOLD_MS - 10_000);
    assert.ok(o.down());
  });

  test("turned off, the relay's being away says nothing", () => {
    const { o } = make();
    o.relayConnected();
    o.relayOff();
    o.relayDisconnected();
    o.callTimedOut("router");
    assert.equal(o.down(), null);
  });
});

describe("back", () => {
  test("once per outage, on the first thing that gets through", () => {
    const { o, backs } = make();
    o.ok();
    assert.equal(backs(), 0, "never down: no news");
    o.relayError(dns);
    o.relayError(dns);
    o.relayConnected();
    o.ok();
    assert.equal(backs(), 1);
    o.callFailed("anthropic", fetchFailed("ENOTFOUND"));
    o.ok();
    assert.equal(backs(), 2);
  });
});
