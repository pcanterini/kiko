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

  test("a model call's DNS error: its service down, said as offline; any answer after it: up", () => {
    const { o } = make();
    o.callFailed("anthropic", fetchFailed("ENOTFOUND"));
    assert.match(o.down("anthropic")!.detail, /anthropic: ENOTFOUND/);
    assert.equal(o.down("anthropic")!.service, undefined, "the Mac's own network, not one host");
    assert.equal(o.down(), null, "one call isn't the whole network");
    o.ok("openrouter");
    assert.equal(o.down("anthropic"), null, "something got through: names resolve again");
  });

  test("a service's own error (a 503, a bad key) isn't the network", () => {
    const { o } = make();
    o.callFailed("openrouter", new Error("Jev 503: overloaded"));
    assert.equal(o.down("openrouter"), null);
  });

  test("a timeout counts only with the relay down too (the log: relay closed, then the clean-up timed out)", () => {
    const { o } = make();
    o.callTimedOut("cleanup", "anthropic");
    assert.equal(o.down("anthropic"), null, "a slow model alone isn't offline");
    o.relayConnected();
    o.relayDisconnected();
    o.callTimedOut("cleanup", "anthropic");
    assert.equal(o.down("anthropic")?.why, "timeouts");
    assert.equal(o.down("anthropic")?.service, undefined, "with the relay down too: said as offline");
    o.relayConnected();
    assert.equal(o.down("anthropic"), null, "the relay back disproves it");
  });

  test("no relay to say: the router timing out twice with nothing through between is down; once isn't", () => {
    const { o, clock } = make();
    o.callTimedOut("router", "anthropic");
    assert.equal(o.down("anthropic"), null);
    clock.advance(1000);
    o.ok("anthropic");
    clock.advance(1000);
    o.callTimedOut("router", "anthropic");
    assert.equal(o.down("anthropic"), null, "an answer came between");
    o.callTimedOut("cleanup", "anthropic");
    assert.equal(o.down("anthropic"), null, "a slow clean-up isn't the router");
    clock.advance(1000);
    o.callTimedOut("router", "anthropic");
    assert.equal(o.down("anthropic")?.why, "timeouts");
    assert.equal(o.down("anthropic")?.service, "anthropic", "named: only that service");
  });

  test("a sign lasts HOLD_MS: with nothing newer, the models are tried again", () => {
    const { o, clock } = make();
    o.callFailed("anthropic", fetchFailed("EAI_AGAIN"));
    clock.advance(HOLD_MS - 1);
    assert.ok(o.down("anthropic"));
    clock.advance(2);
    assert.equal(o.down("anthropic"), null);
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
    o.callTimedOut("router", "anthropic");
    assert.equal(o.down("anthropic"), null);
  });
});

// 2026-11-20 (the owner's log): OpenRouter, for the optional classifier, timed out (ETIMEDOUT) while
// the Anthropic API answered; the app took itself as offline and never asked the router (Anthropic).
describe("one service down isn't the network", () => {
  test("OpenRouter's time out: OpenRouter down, named; Anthropic and the network not", () => {
    const { o } = make();
    o.relayConnected();
    o.callFailed("openrouter", fetchFailed("ETIMEDOUT"));
    assert.equal(o.down("anthropic"), null, "the router on Anthropic is still asked");
    assert.equal(o.down(), null);
    assert.equal(o.down("openrouter")?.service, "openrouter");
    assert.match(o.down("openrouter")!.detail, /openrouter: ETIMEDOUT/);
  });

  test("a host's own failure is cleared only by its own answer (or HOLD_MS), not another's", () => {
    const { o, clock, backs } = make();
    o.callFailed("openrouter", fetchFailed("ECONNREFUSED"));
    o.ok("anthropic");
    o.relayConnected();
    assert.ok(o.down("openrouter"), "Anthropic answering says nothing about OpenRouter");
    clock.advance(1000);
    o.ok("openrouter");
    assert.equal(o.down("openrouter"), null);
    assert.equal(backs(), 1);
  });

  test("the account's proxy is a service of its own", () => {
    const { o } = make();
    o.callFailed("kiko", fetchFailed("ETIMEDOUT"));
    assert.equal(o.down("kiko")?.service, "kiko");
    assert.equal(o.down("openrouter"), null);
  });

  test("the relay's own time out isn't the network; its DNS error is", () => {
    const { o } = make();
    o.relayError(new Error("connect ETIMEDOUT 1.2.3.4:443"));
    assert.equal(o.down("anthropic"), null);
    o.relayError(dns);
    assert.equal(o.down("anthropic")?.why, "network", "the network: every service with it");
    assert.equal(o.down("anthropic")?.service, undefined);
  });

  test("back names the service that came back", () => {
    const { clock } = make();
    const o = new Online(clock);
    const back: (string | undefined)[] = [];
    o.onBack = (s) => back.push(s);
    o.callFailed("openrouter", fetchFailed("ETIMEDOUT"));
    o.ok("anthropic");
    assert.deepEqual(back, [], "OpenRouter not back yet");
    o.ok("openrouter");
    assert.deepEqual(back, ["openrouter"]);
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
    o.ok("anthropic");
    assert.equal(backs(), 2);
  });
});
