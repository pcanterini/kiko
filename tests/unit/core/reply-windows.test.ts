// The reply windows' defaults (src/core/config.ts) and the lengths the settings offer (src/core/settings-options.ts).
// How a window is cut when another session is in line is in the faked-app harness (pnpm test:app).
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { durations, FYI_WINDOWS, REPLY_WINDOWS } from "../../../src/core/settings-options.ts";

test("defaults: 10s to reply, 4s when Claude was only reporting", () => {
  assert.equal(config.replyWindowMs, 10000);
  assert.equal(config.fyiReplyWindowMs, 4000);
});

test("the defaults are among the lengths offered", () => {
  assert.ok(REPLY_WINDOWS.includes(config.replyWindowMs));
  assert.ok(FYI_WINDOWS.includes(config.fyiReplyWindowMs));
  assert.deepEqual(FYI_WINDOWS, [3000, 4000, 6000, 10000]);
});

test("an old saved length is still offered, in order", () => {
  assert.deepEqual(
    durations(REPLY_WINDOWS, 12000).map((c) => c.value),
    [10000, 12000, 15000, 20000, 30000],
  );
  assert.deepEqual(
    durations(FYI_WINDOWS, 6000).map((c) => c.value),
    FYI_WINDOWS,
  );
});
