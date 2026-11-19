// The phone relay's address (core/config.ts relayUrlOf): the deployed relay by default, so a paired
// phone reaches the Mac away from home with nothing set; KIKO_RELAY_URL names another, or none.

import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayUrlOf } from "../../../src/core/config.ts";
import { RELAY_URL } from "../../../src/core/name.ts";

test("unset: the deployed relay; off, 0, none or empty: none; anything else as given", () => {
  assert.equal(RELAY_URL, "wss://relay.kiko.sh");
  assert.equal(relayUrlOf(undefined), RELAY_URL);
  for (const v of ["off", "OFF", "0", "none", "false", "no", "", "  "]) assert.equal(relayUrlOf(v), undefined, JSON.stringify(v));
  assert.equal(relayUrlOf(" ws://127.0.0.1:8787 "), "ws://127.0.0.1:8787");
});

test("the tests never use the real relay (tests/setup.ts)", () => {
  assert.equal(process.env.KIKO_RELAY_URL, "off");
});
