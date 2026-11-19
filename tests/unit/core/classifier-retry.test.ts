// The classifier (src/core/classifier.ts) tries once more when the connection drops before an answer ("fetch failed"),
// and not on an HTTP error. fetch is stubbed: no network.
import "../../setup.ts";
import { holdKey } from "../../../src/core/key-values.ts";
// The classifier on your own OpenRouter key (core/model-route.ts: a call with no key and no plan fails before fetch).
holdKey("OPENROUTER_API_KEY", "sk-or-v1-test-only-0000");
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

process.env.KIKO_LOG_DIR = mkdtempSync(join(tmpdir(), "kiko-classifier-retry-"));
const { config } = await import("../../../src/core/config.ts");
const { decideStop } = await import("../../../src/core/decisions.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ANSWERS = { needs_user: { type: "noul", noul: 0.2 }, worth_saying: { type: "noul", noul: 0.9 } };
const ok = () => new Response(JSON.stringify({ model: config.classifierModel, answers: ANSWERS, usage: { cost: 0.00005 } }), { status: 200 });
const dropped = () => new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
const INPUT = { claudeReply: "Done: the tests pass.", context: [] };

/** fetch stubbed to give `replies` in turn; counts the calls. */
function stub(...replies: Array<() => Response | Error>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(calls++, replies.length - 1)]();
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return () => calls;
}

test("a dropped connection is tried once more and answers", async () => {
  const calls = stub(dropped, ok);
  const verdict = await decideStop(INPUT);
  assert.equal(calls(), 2);
  assert.ok(verdict.worthSaying > 0.8);
});

test("dropped twice fails, naming the cause", async () => {
  const calls = stub(dropped, dropped);
  await assert.rejects(decideStop(INPUT), /fetch failed \(UND_ERR_SOCKET\)/);
  assert.equal(calls(), 2);
});

test("an HTTP error isn't retried", async () => {
  const calls = stub(() => new Response("busy", { status: 503 }), ok);
  await assert.rejects(decideStop(INPUT), /Jev 503/);
  assert.equal(calls(), 1);
});
