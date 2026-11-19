// The small helpers for what's shown and said (src/core/text.ts): a list of names as a sentence has
// it, and a path with the home folder as ~.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { andList, orList, shortPath } from "../../../src/core/text.ts";

test("a list of names, with 'and' or 'or' before the last", () => {
  assert.equal(andList([]), "");
  assert.equal(andList(["lacy"]), "lacy");
  assert.equal(andList(["lacy", "clipkit"]), "lacy and clipkit");
  assert.equal(andList(["lacy", "clipkit", "pixie"]), "lacy, clipkit and pixie");
  assert.equal(orList(["lacy", "clipkit", "pixie"]), "lacy, clipkit or pixie");
});

test("the home folder as ~: only the folder itself and what's in it", () => {
  assert.equal(shortPath("/Users/me", "/Users/me"), "~");
  assert.equal(shortPath("/Users/me/git/x", "/Users/me"), "~/git/x");
  assert.equal(shortPath("/Users/me2/x", "/Users/me"), "/Users/me2/x");
  assert.equal(shortPath("/elsewhere/Users/me/x", "/Users/me"), "/elsewhere/Users/me/x");
  assert.equal(shortPath("/Users/me/x", ""), "/Users/me/x");
});
