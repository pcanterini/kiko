// The order held hook requests wait in (src/core/hook-queue.ts): permission prompts ahead of finished
// turns, and an announcement a press cut before it made a sound put back first of its kind
// (before, it was lost).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { enqueue } from "../../../src/core/hook-queue.ts";

type R = { name: string; isPermission: boolean };
const stop = (name: string): R => ({ name, isPermission: false });
const ask = (name: string): R => ({ name, isPermission: true });
const names = (q: R[]) => q.map((r) => r.name);

describe("enqueue: as requests come in", () => {
  test("finished turns wait in the order they came", () => {
    const q: R[] = [];
    enqueue(q, stop("a"));
    enqueue(q, stop("b"));
    assert.deepEqual(names(q), ["a", "b"]);
  });
  test("a permission prompt goes ahead of finished turns, behind other prompts", () => {
    const q = [ask("p1"), stop("a"), stop("b")];
    enqueue(q, ask("p2"));
    assert.deepEqual(names(q), ["p1", "p2", "a", "b"]);
  });
  test("a permission prompt into a queue of only prompts, or an empty one, goes last", () => {
    const q = [ask("p1")];
    enqueue(q, ask("p2"));
    assert.deepEqual(names(q), ["p1", "p2"]);
    const empty: R[] = [];
    enqueue(empty, ask("p"));
    assert.deepEqual(names(empty), ["p"]);
  });
});

describe("enqueue front: put back by a press before it made a sound", () => {
  test("a finished turn goes next: ahead of other finished turns", () => {
    const q = [stop("a"), stop("b")];
    enqueue(q, stop("cut"), true);
    assert.deepEqual(names(q), ["cut", "a", "b"]);
  });
  test("but behind permission prompts, which block their session", () => {
    const q = [ask("p"), stop("a")];
    enqueue(q, stop("cut"), true);
    assert.deepEqual(names(q), ["p", "cut", "a"]);
  });
  test("a permission prompt goes first of all", () => {
    const q = [ask("p"), stop("a")];
    enqueue(q, ask("cut"), true);
    assert.deepEqual(names(q), ["cut", "p", "a"]);
  });
  test("into an empty queue", () => {
    const q: R[] = [];
    enqueue(q, stop("cut"), true);
    assert.deepEqual(names(q), ["cut"]);
  });
});
