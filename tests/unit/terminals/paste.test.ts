// The one rule for when words go into a terminal as a bracketed paste (src/terminals/paste.ts):
// several lines always; long words (over 512 bytes, inside the 1022 a program reads at once) and a
// paste-wanting program's (Codex's) one line only where the program asks for bracketed paste.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { asPaste, isLong, LONG_BYTES, TTY_READ_BYTES } from "../../../src/terminals/paste.ts";

describe("asPaste", () => {
  test("long words: by bytes, not characters, and well inside one read", () => {
    assert.ok(LONG_BYTES < TTY_READ_BYTES);
    assert.equal(isLong("a".repeat(LONG_BYTES)), false);
    assert.equal(isLong("a".repeat(LONG_BYTES + 1)), true);
    // 171 characters of three bytes each: 513 bytes.
    assert.equal(isLong("語".repeat(171)), true);
    assert.equal(isLong("語".repeat(170)), false);
  });

  test("one line: typed when short, pasted when long, if the program asks for a paste", () => {
    const long = "x".repeat(1100);
    assert.equal(asPaste("fix the upload bug", { asks: true }), false);
    assert.equal(asPaste(long, { asks: true }), true);
    assert.equal(asPaste(long, { asks: false }), false);
  });

  test("a program that wants every message pasted (Codex): one short line too, if it asks", () => {
    assert.equal(asPaste("hello", { asks: true, always: true }), true);
    assert.equal(asPaste("hello", { asks: false, always: true }), false);
  });

  test("several lines: always one paste", () => {
    assert.equal(asPaste("first\nsecond", { asks: true }), true);
    assert.equal(asPaste("first\nsecond", { asks: false }), true);
  });
});
