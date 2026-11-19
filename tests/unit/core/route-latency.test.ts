// The router's time limits (src/core/router.ts ROUTE_TIMING, src/core/hedge.ts) with a fake Anthropic
// API: fetch is stubbed and each request does what the test says (answers after a delay, hangs until
// cut off, fails with a status). A slow first request is hedged and the second's answer taken, once;
// when neither answers the route fails (and the app says your words weren't sent), not "pressed
// again"; and the log lines carry the timings, request ids and retries that two ~15s
// routes once didn't have.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { cleanUp } from "../../../src/core/cleanup.ts";
import { config } from "../../../src/core/config.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { HedgeError } from "../../../src/core/hedge.ts";
import { ROUTE_TIMING, Router } from "../../../src/core/router.ts";
import { sessionName } from "../../../src/core/sessions.ts";
import { CAST, makeWorld } from "../../support/fixtures.ts";

/** What one request to the fake API does: answer pass_on to `session` after `ms`, hang until cut off, or fail with `status`. */
type Plan = { ms?: number; session?: string; hang?: boolean; status?: number; ignoreAbort?: boolean };

const USAGE = { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 3900 };
const sse = (session: string) =>
  [
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE, output_tokens: 1 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "pass_on", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ session }) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: USAGE.output_tokens } },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");

let plans: Plan[] = [];
let requests = 0;
const realFetch = globalThis.fetch;
const aborted = () => new DOMException("This operation was aborted", "AbortError");

before(() => {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const n = ++requests;
    const plan = plans[n - 1] ?? plans.at(-1) ?? {};
    const body = JSON.parse(String(init?.body));
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) return reject(aborted());
      if (!plan.ignoreAbort) signal?.addEventListener("abort", () => reject(aborted()), { once: true });
      if (plan.hang) return;
      setTimeout(() => {
        const headers = { "request-id": `req_${n}` };
        if (plan.status) {
          const error = { type: "error", error: { type: plan.status === 529 ? "overloaded_error" : "invalid_request_error", message: `status ${plan.status}` } };
          return resolve(new Response(JSON.stringify(error), { status: plan.status, headers: { ...headers, "content-type": "application/json" } }));
        }
        if (!body.stream) {
          const message = {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "Fix the bug." }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: USAGE,
          };
          return resolve(new Response(JSON.stringify(message), { status: 200, headers: { ...headers, "content-type": "application/json" } }));
        }
        resolve(new Response(sse(plan.session ?? "s1"), { status: 200, headers: { ...headers, "content-type": "text/event-stream" } }));
      }, plan.ms ?? 5);
    });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  config.llm = "haiku";
  requests = 0;
});

const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy]);
// Short in the tests: the same rules, in milliseconds instead of seconds.
const FAST = { hedgeMs: 60, attemptMs: 300 };
const input = (extra: Partial<Parameters<Router["route"]>[0]> = {}) => ({
  sessions: world.sessions,
  notes: world.notes,
  waitingId: null,
  justSpoke: null,
  lastId: null,
  recent: [],
  text: "Tell lacy the build is green",
  voiceCan: "everything" as const,
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This test process's log lines of `event` (src/core/log.ts writes logs/ in its own folder), from `from` on. */
function logged(event: string, from = 0): Array<Record<string, any>> {
  return readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join("logs", f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === event)
    .slice(from);
}

describe("the router's time limits", () => {
  test("the timing chosen: a hedge after 4s, 8s for each request", () => {
    assert.deepEqual(ROUTE_TIMING, { hedgeMs: 4000, attemptMs: 8000 });
  });

  test("a quick answer: one request, no hedge; the log line has the request id, timings and stop reason", async () => {
    const from = logged("route").length;
    plans = [{ ms: 10, session: "s3" }];
    const heardAt = Date.now() - 250;
    const r = await new Router(FAST).route(input({ heardAt }), () => {});
    assert.deepEqual(
      r!.actions.map((a) => a.name === "pass_on" && sessionName(a.session)),
      ["lacy-platform"],
    );
    await sleep(FAST.hedgeMs + 20);
    assert.equal(requests, 1, "no hedge after an answer");
    const [line] = logged("route", from);
    assert.equal(line.requestId, "req_1");
    assert.equal(line.stop, "tool_use");
    assert.equal(line.retries, 0);
    assert.equal(line.tries, undefined, "the tries only when there was more than one");
    assert.ok(line.headersMs >= 5 && line.headersMs < 200, `headersMs ${line.headersMs}`);
    assert.ok(line.firstTokenMs >= line.headersMs, `firstTokenMs ${line.firstTokenMs}`);
    assert.ok(line.ms >= line.firstTokenMs, `ms ${line.ms}`);
    assert.ok(line.sinceHeardMs >= 250 && line.sinceHeardMs < 1000, `sinceHeardMs ${line.sinceHeardMs}`);
  });

  test("the first request stalls: the hedge answers, and its decision is the one taken", async () => {
    const from = logged("route").length;
    plans = [{ hang: true }, { ms: 10, session: "s2" }];
    const r = await new Router(FAST).route(input(), () => {});
    assert.deepEqual(
      r!.actions.map((a) => a.name === "pass_on" && sessionName(a.session)),
      ["clipkit"],
    );
    assert.equal(requests, 2);
    const [line] = logged("route", from);
    assert.equal(line.retries, 1);
    assert.equal(line.requestId, "req_2", "the request taken");
    assert.deepEqual(
      line.tries.map((t: any) => [t.n, t.how]),
      [
        [1, "lost"],
        [2, "won"],
      ],
    );
    assert.ok(line.tries[1].startMs >= FAST.hedgeMs - 5);
  });

  test("both answer, the first one late: one decision, one log line; the late answer is dropped", async () => {
    const from = logged("route").length;
    // The first ignores being cut off and answers anyway, for another session, after the hedge's.
    plans = [
      { ms: 150, session: "s3", ignoreAbort: true },
      { ms: 10, session: "s2" },
    ];
    const r = await new Router(FAST).route(input(), () => {});
    assert.deepEqual(
      r!.actions.map((a) => a.name === "pass_on" && sessionName(a.session)),
      ["clipkit"],
    );
    await sleep(200);
    assert.equal(logged("route", from).length, 1);
  });

  test("through decide(): the hedged route sends your words once, to the session the answer taken named", async () => {
    plans = [{ hang: true }, { ms: 10, session: "s2" }];
    const router = new Router(FAST);
    let routes = 0;
    const deps: DecideDeps = {
      utterance: null,
      approval: null,
      route: (i) => (routes++, router.route(i, () => {})),
      trim: null,
    };
    const state: DecideState = {
      text: "Tell it the build is green",
      sessions: world.sessions,
      notes: world.notes,
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan: "everything",
      classifierMinConfidence: 0.75,
    };
    const d = await decide(state, deps);
    await sleep(100);
    assert.equal(routes, 1);
    const sends = d.actions.filter((a) => a.type === "send");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].type === "send" && sessionName(sends[0].session), "clipkit");
  });

  test("an overloaded API (529): retried once by the router, not by the SDK", async () => {
    const from = logged("route").length;
    plans = [
      { ms: 5, status: 529 },
      { ms: 5, session: "s1" },
    ];
    const r = await new Router(FAST).route(input(), () => {});
    assert.equal(r!.actions.length, 1);
    assert.equal(requests, 2);
    const [line] = logged("route", from);
    assert.deepEqual(
      line.tries.map((t: any) => t.how),
      ["failed", "won"],
    );
    assert.ok(line.tries[1].startMs < FAST.hedgeMs, "retried at once, not at the hedge");
  });

  test("a bad request (400): no second try, and the route fails", async () => {
    plans = [{ ms: 5, status: 400 }];
    await assert.rejects(new Router(FAST).route(input(), () => {}));
    await sleep(FAST.hedgeMs + 20);
    assert.equal(requests, 1);
  });

  test("neither answers: the route fails (the app says your words weren't sent), logged with both tries", async () => {
    const from = logged("route_failed").length;
    plans = [{ hang: true }];
    const t0 = performance.now();
    const err = await new Router(FAST).route(input({ heardAt: Date.now() }), () => {}).catch((e) => e);
    const took = performance.now() - t0;
    // Not null: null means a new press cancelled it ("you pressed again before I'd decided").
    assert.ok(err instanceof HedgeError, String(err));
    assert.ok(took >= FAST.hedgeMs + FAST.attemptMs - 10 && took < 1000, `gave up after ${Math.round(took)}ms`);
    assert.equal(requests, 2);
    const [line] = logged("route_failed", from);
    assert.equal(line.text, "Tell lacy the build is green");
    assert.deepEqual(
      line.tries.map((t: any) => t.how),
      ["timeout", "timeout"],
    );
    assert.equal(typeof line.sinceHeardMs, "number");
    assert.equal(logged("route_failed", from).length, 1);
  });

  test("a new press cancels it: null, as before, and both requests are cut off", async () => {
    plans = [{ hang: true }];
    const router = new Router(FAST);
    const p = router.route(input(), () => {});
    await sleep(FAST.hedgeMs + 20);
    router.cancel();
    assert.equal(await p, null);
    assert.equal(requests, 2);
  });
});

describe("the other model calls' log lines", () => {
  test("clean-up: request id, the SDK's retries and the stop reason", async () => {
    const from = logged("cleanup").length;
    plans = [{ ms: 5 }];
    const c = await cleanUp("Uh, fix the the bug.");
    assert.equal(c.text, "Fix the bug.");
    const [line] = logged("cleanup", from);
    assert.equal(line.requestId, "req_1");
    assert.equal(line.retries, 0);
    assert.equal(line.stop, "end_turn");
    assert.equal(typeof line.ms, "number");
  });

  test("the SDK's own retries are counted (the clean-up keeps the SDK's default of two)", async () => {
    const from = logged("cleanup").length;
    // A 529 at once, then the answer: the SDK waits ~0.5s and tries again, inside the clean-up's 1.5s.
    plans = [{ ms: 1, status: 529 }, { ms: 5 }];
    const c = await cleanUp("Uh, fix the the bug.");
    assert.equal(c.text, "Fix the bug.");
    const [line] = logged("cleanup", from);
    assert.equal(line.retries, 1);
    assert.equal(line.requestId, "req_2");
  });
});
