// T3 Code's terminal adapter (src/terminals/t3code/): only T3's own threads, keyless; its words go
// through the T3 agent's connection (message.dispatch: tests/unit/agents/t3code.test.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findPlaces, terminals } from "../../../src/terminals/index.ts";
import { t3codeTerminal } from "../../../src/terminals/t3code/index.ts";

const T3_THREAD = { sessionId: "t3:th1", cwd: "/code/pixie", kind: "interactive" as const, desktop: false, titles: [], agent: "t3code" };
const CLAUDE = { sessionId: "claude-1", cwd: "/code/pixie", kind: "interactive" as const, desktop: false, titles: [] };

test("finds only T3's threads, keyless", async () => {
  const found = await t3codeTerminal.find(Promise.resolve([T3_THREAD, CLAUDE]));
  assert.deepEqual([...found.keys()], ["t3:th1"]);
  assert.deepEqual(found.get("t3:th1")!.place, { via: "t3code", id: "th1", keys: false });
});

test("asked first: a T3 thread is placed by it, whatever else is in its folder", async () => {
  assert.equal(terminals[0], t3codeTerminal);
  const placeOf = await findPlaces(Promise.resolve([T3_THREAD]), [t3codeTerminal]);
  assert.equal(placeOf("t3:th1").place?.via, "t3code");
});

test("not connected: said so, nothing sent", async () => {
  assert.deepEqual(await t3codeTerminal.type({ via: "t3code", id: "th1", keys: false }, "hi"), { sent: false, why: "T3 Code isn't connected" });
});
