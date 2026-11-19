// When a press counts as one before the announcement being made was heard (src/core/routing-rules.ts heardBy, used
// by floor.ts deferUnheard): before any sound, or in its first 1.5s of sound. Once, 0.4s into Clipkit's
// announcement you answered Claude speech, and the words went to Clipkit.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { heardBy, UNHEARD_FOR_MS } from "../../../src/core/routing-rules.ts";

const SOUND = 1_000_000;

test("no sound yet: not heard", () => {
  assert.equal(heardBy(null, SOUND + 5000, false), false);
  assert.equal(heardBy(null, SOUND + 5000, true), false);
});

test("a press 0.4s into its sound: not heard (put back)", () => {
  assert.equal(heardBy(SOUND, SOUND + 400, true), false);
});

test("a press 2s into its sound: heard (a reply to it)", () => {
  assert.equal(heardBy(SOUND, SOUND + 2000, true), true);
});

test("the grace is about 1.5s", () => {
  assert.equal(UNHEARD_FOR_MS, 1500);
  assert.equal(heardBy(SOUND, SOUND + 1499, true), false);
  assert.equal(heardBy(SOUND, SOUND + 1500, true), true);
});

test("a short one that's already over is heard, however soon you press", () => {
  assert.equal(heardBy(SOUND, SOUND + 900, false), true);
});

test("a shorter grace (the faked-app harness)", () => {
  assert.equal(heardBy(SOUND, SOUND + 40, true, 150), false);
  assert.equal(heardBy(SOUND, SOUND + 200, true, 150), true);
});
