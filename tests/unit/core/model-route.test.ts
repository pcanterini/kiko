// The one place model calls are pointed (src/core/model-route.ts): your own OpenRouter key wins; else
// the Kiko account's plan, through the trial proxy, with the access token and the call's type; else
// none. The proxy's answers turned into the plan's lines, each said once, and never a sign-out: a fake
// account server and a fake proxy, each on a port of its own on 127.0.0.1 (tests/support/), the
// session token in a store in memory. Nothing reaches the real servers, OpenRouter or the network.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { Account, SESSION_KEY } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { type Notice, planRunsAi } from "../../../src/core/account/plan-words.ts";
import { AccountAiError, ModelCalls, NoAiError, routeFor } from "../../../src/core/model-route.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { fakeAccountServer, fakeJwt, happyScript, memoryStore, planJson, SESSION_TOKEN, sessionAnswer } from "../../support/fake-account.ts";
import { decisionsAnswer, fakeProxy, proxyError, streamAnswer, toolsAnswer } from "../../support/fake-proxy.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const UA = "Kiko/0.4.0 (macOS 26.1)";

/** Signed in (the token in the store, account.json written by a check) with `plan`; a fake proxy; ModelCalls on both. */
async function setUp(o: { plan?: ReturnType<typeof planJson>; ownKey?: string } = {}) {
  const server = await fakeAccountServer({
    ...happyScript(),
    session: [sessionAnswer({ plan: o.plan ?? planJson() })],
    access: [{ json: { access_token: fakeJwt(1), token_type: "Bearer", expires_in: 600 } }, { json: { access_token: fakeJwt(2), token_type: "Bearer", expires_in: 600 } }],
  });
  const proxy = await fakeProxy();
  closers.push(server.close, proxy.close);
  const mem = memoryStore({ [SESSION_KEY]: SESSION_TOKEN });
  const file = join(mkdtempSync(join(tmpdir(), "route-")), "account.json");
  const account = new Account({ store: mem.store, client: accountClient(server.url), file });
  const checked = await account.check();
  assert.equal(checked.state, "signed-in");
  const notices: Notice[] = [];
  const calls = new ModelCalls({
    ownKey: () => o.ownKey,
    account: () => account,
    accountActive: () => {
      const v = account.view();
      return v.state === "signed-in" && !!v.plan && v.plan.name !== "none";
    },
    aiUrl: () => proxy.url,
    userAgent: () => UA,
  });
  calls.onNotice = (n) => void notices.push(n);
  const chat = (
    body: Record<string, unknown> = { model: "anthropic/claude-haiku-5.5", messages: [{ role: "user", content: "hi" }], max_tokens: 300, stream: true },
    call: "summary" | "routing" = "summary",
  ) => calls.post("chat", body, { call, what: "more" });
  return { server, proxy, mem, file, account, calls, notices, chat };
}

/** Still signed in, the token kept, the plan still known: nothing was wiped. */
function nothingWiped(t: { mem: ReturnType<typeof memoryStore>; file: string; account: Account }) {
  assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN, "the session token kept");
  assert.equal(t.account.view().state, "signed-in");
  assert.ok(!t.mem.ops.some((op) => op.startsWith("remove")), "nothing removed from the store");
  assert.doesNotMatch(readFileSync(t.file, "utf8"), /sess-test/);
}

describe("which way a call goes", () => {
  test("your own OpenRouter key wins, account or not; else the account's plan; else none", () => {
    const account = {} as Account;
    assert.deepEqual(routeFor({ ownKey: () => "sk-or-mine", account: () => account, accountActive: () => true }), { via: "key", key: "sk-or-mine" });
    assert.deepEqual(routeFor({ ownKey: () => undefined, account: () => account, accountActive: () => true }), { via: "account", account });
    assert.deepEqual(routeFor({ ownKey: () => "  ", account: () => account, accountActive: () => false }), { via: "none" });
    assert.deepEqual(routeFor({ ownKey: () => undefined, account: () => null, accountActive: () => true }), { via: "none" });
  });

  test("with your own key: straight to openrouter.ai with it, nothing to the proxy or the account server", async () => {
    const t = await setUp({ ownKey: "sk-or-v1-mine-0000" });
    const seen: { url: string; auth: string }[] = [];
    const calls = new ModelCalls({
      ownKey: () => "sk-or-v1-mine-0000",
      account: () => t.account,
      accountActive: () => true,
      fetch: async (url, init) => (
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "" }), new Response("{}", { headers: { "content-type": "application/json" } })
      ),
    });
    await calls.post("chat", { model: "x" }, { call: "summary" });
    await calls.post("decisions", { model: "typesafe/jev-1.14" }, { call: "classify" });
    assert.deepEqual(seen, [
      { url: "https://openrouter.ai/api/v1/chat/completions", auth: "Bearer sk-or-v1-mine-0000" },
      { url: "https://openrouter.ai/api/alpha/decisions", auth: "Bearer sk-or-v1-mine-0000" },
    ]);
    assert.equal(t.proxy.calls.length, 0);
    assert.equal(t.server.to("access").length, 0, "no access token asked for");
  });

  test("neither: the call fails as with no key", async () => {
    const calls = new ModelCalls({ ownKey: () => undefined, account: () => null, accountActive: () => false });
    await assert.rejects(calls.post("chat", {}, { call: "summary" }), (e: unknown) => e instanceof NoAiError && /AI is off/.test(e.message));
  });
});

describe("through the account", () => {
  test("to the proxy with the access token (never the session token), the call's type, what, and the User-Agent; the body as OpenRouter takes it", async () => {
    const t = await setUp();
    t.proxy.answer("chat", streamAnswer(["Lacy ", "finished."]));
    const res = await t.chat();
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Lacy /);
    t.proxy.answer("chat", toolsAnswer());
    assert.equal((await t.chat({ model: "deepseek/deepseek-v4.1-flash", stream: false }, "routing")).status, 200);
    assert.equal((await t.calls.post("decisions", { model: "typesafe/jev-1.14", state: {}, questions: {} }, { call: "classify", what: "utterance" })).status, 200);
    assert.deepEqual(
      t.proxy.calls.map((c) => [c.path, c.call, c.what, c.bearer, c.agent]),
      [
        ["/ai/chat/completions", "summary", "more", fakeJwt(1), UA],
        ["/ai/chat/completions", "routing", "more", fakeJwt(1), UA],
        ["/ai/decisions", "classify", "utterance", fakeJwt(1), UA],
      ],
    );
    assert.equal(t.proxy.calls[0].body.model, "anthropic/claude-haiku-5.5");
    assert.ok(!t.proxy.calls.some((c) => c.bearer === SESSION_TOKEN));
    // One access token, held in memory for all three.
    assert.equal(t.server.to("access").length, 1);
  });

  test("an access token turned down (invalid_token): a new one and once more; never a sign-out", async () => {
    const t = await setUp();
    t.proxy.answer("chat", proxyError(401, "invalid_token"), streamAnswer(["ok"]));
    const res = await t.chat();
    assert.equal(res.status, 200);
    assert.deepEqual(
      t.proxy.calls.map((c) => c.bearer),
      [fakeJwt(1), fakeJwt(2)],
    );
    assert.equal(t.server.to("access").length, 2);
    nothingWiped(t);
    assert.deepEqual(t.notices, []);
  });

  test("Pro past its month's allowance (pro_quota_used): the call fails with its line, said once a period, and the plan stops running the AI until it renews", async () => {
    const t = await setUp({ plan: planJson({ plan: "pro" }) });
    const resets = Date.UTC(2026, 11, 3, 12);
    t.proxy.answer("chat", proxyError(402, "pro_quota_used", { resets_at: new Date(resets).toISOString() }));
    await assert.rejects(t.chat(), (e: unknown) => e instanceof AccountAiError && e.code === "pro_quota_used");
    assert.equal(t.proxy.calls.length, 1, "no second try on another model: there's no fallback any more");
    assert.deepEqual(
      t.notices.map((n) => [n.key, n.spoken]),
      [[`pro_quota_used:${resets}`, "You've used this month's Kiko Pro allowance. It renews on 3 Dec; add your own OpenRouter key to keep going now."]],
    );
    assert.equal(t.notices[0].line, `You've used this month's Kiko Pro allowance. It renews on 3 Dec; add your own OpenRouter key to keep going now (${COMMAND} keys set openrouter).`);
    // Kept in account.json: used up until it renews, so the plan no longer runs the AI (no key: no route).
    const v = t.account.view();
    assert.equal(v.state === "signed-in" && v.plan?.quota?.usedShare, 1);
    assert.equal(v.state === "signed-in" && v.plan?.quota?.periodEnd, resets);
    assert.equal(planRunsAi(v.state === "signed-in" ? v.plan : null, resets - 60_000), false);
    assert.equal(planRunsAi(v.state === "signed-in" ? v.plan : null, resets + 60_000), true, "the month renewed");
    // Said once a period: a second refusal, even in another run (account.json's told), says nothing.
    await assert.rejects(t.chat(), AccountAiError);
    const again = new ModelCalls({ ownKey: () => undefined, account: () => t.account, accountActive: () => true, aiUrl: () => t.proxy.url, userAgent: () => UA });
    const said: Notice[] = [];
    again.onNotice = (n) => void said.push(n);
    await assert.rejects(again.post("chat", { model: "anthropic/claude-haiku-5.5", messages: [] }, { call: "summary" }), AccountAiError);
    assert.equal(t.notices.length, 1);
    assert.deepEqual(said, []);
    nothingWiped(t);
  });

  test("past Pro's allowance, the plan doesn't run the calls: your own key does if there is one, else none (no key, no plan)", async () => {
    const t = await setUp({ plan: planJson({ plan: "pro" }) });
    t.account.noteQuotaUsed(Date.now() + 5 * 86_400_000);
    const v = t.account.view();
    const active = () => v.state === "signed-in" && planRunsAi(v.plan);
    assert.equal(active(), false);
    assert.deepEqual(routeFor({ ownKey: () => undefined, account: () => t.account, accountActive: active }), { via: "none" });
    assert.deepEqual(routeFor({ ownKey: () => "sk-or-mine", account: () => t.account, accountActive: active }), { via: "key", key: "sk-or-mine" });
  });

  test("allowance_used, the old name, is a stop too: no fallback model asked for", async () => {
    const t = await setUp({ plan: planJson({ plan: "pro" }) });
    t.proxy.answer("chat", proxyError(402, "allowance_used", { fallback_model: "deepseek/deepseek-v4.1-flash" }));
    await assert.rejects(t.chat(), (e: unknown) => e instanceof AccountAiError && e.code === "allowance_used");
    assert.equal(t.proxy.calls.length, 1);
    assert.match(t.notices[0].spoken, /^You've used this month's Kiko Pro allowance\. It renews next month; add your own OpenRouter key/);
  });

  test("Pro bought since the access token was made: a refusal for the old plan (no_plan) gets a new token and one more try", async () => {
    const t = await setUp({ plan: planJson({ plan: "pro" }) });
    t.proxy.answer("chat", proxyError(403, "no_plan"), streamAnswer(["on pro"]));
    const res = await t.chat();
    assert.equal(res.status, 200);
    assert.deepEqual(
      t.proxy.calls.map((c) => c.bearer),
      [fakeJwt(1), fakeJwt(2)],
    );
    assert.deepEqual(t.notices, []);
  });

  describe("too many calls (429 rate_limited): not the plan's", () => {
    /** ModelCalls on the same account and proxy, its waits and log seen. */
    function limitedCalls(t: Awaited<ReturnType<typeof setUp>>, clock = { now: Date.now() }) {
      const waits: number[] = [];
      const logged: string[] = [];
      const calls = new ModelCalls({
        ownKey: () => undefined,
        account: () => t.account,
        accountActive: () => true,
        aiUrl: () => t.proxy.url,
        userAgent: () => UA,
        now: () => clock.now,
        sleep: async (ms) => void waits.push(ms),
        log: (event, data) => void logged.push(`${event} ${JSON.stringify(data)}`),
      });
      const notices: Notice[] = [];
      calls.onNotice = (n) => void notices.push(n);
      const chat = () => calls.post("chat", { model: "anthropic/claude-haiku-5.5", messages: [], stream: true }, { call: "summary" });
      return { calls, waits, logged, notices, chat };
    }
    const limited = (secs: number) => proxyError(429, "rate_limited", { retry_after: secs, limit: "account" }, { "retry-after": String(secs) });

    test("a short Retry-After waited out, and the call sent once more; nothing said about the plan", async () => {
      const t = await setUp();
      const c = limitedCalls(t);
      t.proxy.answer("chat", limited(2), streamAnswer(["ok"]));
      const res = await c.chat();
      assert.equal(res.status, 200);
      assert.deepEqual(c.waits, [2000]);
      assert.equal(t.proxy.calls.length, 2);
      assert.deepEqual(c.notices, []);
      nothingWiped(t);
    });

    test("a long Retry-After (the account's minute): no wait, the call fails quietly as any failed call", async () => {
      const t = await setUp();
      const c = limitedCalls(t);
      t.proxy.answer("chat", limited(40));
      const res = await c.chat();
      assert.equal(res.status, 429);
      assert.deepEqual([c.waits, t.proxy.calls.length, c.notices], [[], 1, []]);
    });

    test("only once more: limited again after the wait fails quietly", async () => {
      const t = await setUp();
      const c = limitedCalls(t);
      t.proxy.answer("chat", limited(1), limited(1));
      assert.equal((await c.chat()).status, 429);
      assert.equal(t.proxy.calls.length, 2);
    });

    test("when it keeps happening: logged, and one short line said once a run", async () => {
      const t = await setUp();
      const clock = { now: Date.now() };
      const c = limitedCalls(t, clock);
      t.proxy.answer("chat", limited(30));
      for (let i = 0; i < 5; i++) {
        await c.chat();
        clock.now += 10_000;
      }
      assert.deepEqual(
        c.notices.map((n) => [n.line, n.spoken]),
        [["Kiko's AI is busy for a moment; trying again shortly.", "Kiko's AI is busy for a moment; trying again shortly."]],
      );
      assert.ok(
        c.logged.some((l) => l.startsWith('proxy_rate_limited {"times":3,"limit":"account"}')),
        c.logged.join("\n"),
      );
      assert.doesNotMatch(c.notices[0].line, /trial|plan|Pro/);
      nothingWiped(t);
    });

    test("now and then (fewer than 3 in two minutes): never said", async () => {
      const t = await setUp();
      const clock = { now: Date.now() };
      const c = limitedCalls(t, clock);
      t.proxy.answer("chat", limited(30));
      for (let i = 0; i < 4; i++) {
        await c.chat();
        clock.now += 70_000;
      }
      assert.deepEqual([c.notices, c.logged], [[], []]);
    });
  });

  test("the trial ended: the call fails with its line, said once a run, and nothing is signed out or wiped", async () => {
    const t = await setUp();
    t.proxy.answer("chat", proxyError(402, "trial_ended", { ended_why: "time" }));
    await assert.rejects(t.chat(), (e: unknown) => e instanceof AccountAiError && e.code === "trial_ended");
    await assert.rejects(t.chat(), AccountAiError);
    assert.equal(t.notices.length, 1, "said once");
    assert.equal(t.notices[0].line, `Your free trial has ended: Kiko's AI calls are paused. To go on: ${COMMAND} keys set openrouter, your own key (free). Kiko Pro is coming.`);
    assert.equal(t.notices[0].spoken, "Your free trial has ended. Add your own OpenRouter key to keep going.");
    nothingWiped(t);
  });

  test("the plan's other refusals: their lines (today's share, with when it's back; trials paused; no plan; blocked)", async () => {
    const t = await setUp();
    const resets = new Date(Date.now() + 3 * 3_600_000);
    t.proxy.answer("chat", proxyError(402, "daily_cap", { resets_at: resets.toISOString() }), proxyError(503, "trials_paused"), proxyError(403, "no_plan"), proxyError(403, "blocked"));
    for (let i = 0; i < 4; i++) await assert.rejects(t.chat(), AccountAiError);
    const back = resets.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    assert.deepEqual(
      t.notices.map((n) => n.line),
      [
        `Today's share of your free trial is used up: Kiko's AI calls pause until it resets. It's back at ${back}. Or add your own key: ${COMMAND} keys set openrouter.`,
        `Free trials are busy today: use your own OpenRouter key (${COMMAND} keys set openrouter), or try again tomorrow.`,
        `Your Kiko account has no plan right now, so its AI calls are off. Use your own OpenRouter key: ${COMMAND} keys set openrouter.`,
        `This Kiko account can't use Kiko's AI. Your own OpenRouter key still works: ${COMMAND} keys set openrouter.`,
      ],
    );
    nothingWiped(t);
  });

  test("the proxy down, failing, or OpenRouter's own answer: no notice, nothing signed out or wiped; the answer as it came", async () => {
    const t = await setUp();
    t.proxy.answer("chat", proxyError(502, "upstream_error"));
    assert.equal((await t.chat()).status, 502);
    t.proxy.answer("chat", { status: 400, json: { error: { message: "Reasoning is mandatory" } } });
    assert.equal((await t.chat()).status, 400, "OpenRouter's own 400, for the caller's retry");
    t.proxy.answer("chat", "drop");
    await assert.rejects(t.chat());
    await t.proxy.close();
    await assert.rejects(t.chat());
    assert.deepEqual(t.notices, []);
    nothingWiped(t);
  });

  test("the account server down for a new access token: the call fails, still signed in, the token kept", async () => {
    const t = await setUp();
    await t.server.down();
    await assert.rejects(t.chat(), /no access token \(the account server couldn't be reached/);
    nothingWiped(t);
  });

  test("past 80% of the trial (x-kiko-quota-used): 'almost used up' said once a trial, even across runs", async () => {
    const t = await setUp();
    t.proxy.answer("chat", streamAnswer(["a"], { used: 0.5 }), streamAnswer(["b"], { used: 0.82 }), streamAnswer(["c"], { used: 0.9 }));
    for (let i = 0; i < 3; i++) await (await t.chat()).text();
    assert.deepEqual(
      t.notices.map((n) => [n.key, n.spoken]),
      [["almost_used", "Your trial is almost used up."]],
    );
    // A new run (another ModelCalls, the same account.json): not again.
    const again: Notice[] = [];
    const next = new ModelCalls({ ownKey: () => undefined, account: () => t.account, accountActive: () => true, aiUrl: () => t.proxy.url });
    next.onNotice = (n) => void again.push(n);
    t.proxy.answer("chat", streamAnswer(["d"], { used: 0.95 }));
    await (await next.post("chat", { model: "anthropic/claude-haiku-5.5" }, { call: "summary" })).text();
    assert.deepEqual(again, []);
  });

  test("the share used the proxy says is kept in account.json (only up, a point or more), so what's shown follows between checks", async () => {
    const t = await setUp({ plan: planJson({ daysLeft: 5, used: 0.1 }) });
    const share = () => {
      const v = t.account.view();
      return v.state === "signed-in" ? v.plan?.quota?.usedShare : undefined;
    };
    t.proxy.answer("chat", streamAnswer(["a"], { used: 0.25 }), streamAnswer(["b"], { used: 0.255 }), streamAnswer(["c"], { used: 0.2 }));
    await (await t.chat()).text();
    assert.equal(share(), 0.25);
    await (await t.chat()).text();
    assert.equal(share(), 0.25, "under a point more: not written");
    await (await t.chat()).text();
    assert.equal(share(), 0.25, "never back down (the rollups are behind)");
    // Another plan's header than the one on record: left alone.
    t.proxy.answer("chat", streamAnswer(["d"], { used: 0.6, plan: "pro" }));
    await (await t.chat()).text();
    assert.equal(share(), 0.25);
  });

  test("decisions through the proxy answer as the classifier reads them", async () => {
    const t = await setUp();
    t.proxy.answer("decisions", decisionsAnswer());
    const body = (await (await t.calls.post("decisions", { model: "typesafe/jev-1.14", state: {}, questions: {} }, { call: "classify" })).json()) as { answers: { who: { choice: string } } };
    assert.equal(body.answers.who.choice, "a");
  });
});

describe("no dollars once the plan ran a call (src/core/dollars.ts)", () => {
  test("a call through the account marks the run; one on your own key, or none, doesn't", async () => {
    const t = await setUp();
    let marked = 0;
    const planCall = () => void marked++;
    const ok = async () => new Response("{}", { headers: { "content-type": "application/json" } });
    const own = new ModelCalls({ ownKey: () => "sk-or-v1-mine-0000", account: () => t.account, accountActive: () => true, fetch: ok, planCall });
    await own.post("chat", { model: "x" }, { call: "summary" });
    const none = new ModelCalls({ ownKey: () => undefined, account: () => null, accountActive: () => false, planCall });
    await assert.rejects(none.post("chat", {}, { call: "summary" }));
    assert.equal(marked, 0, "your own key, or no route: not the plan");
    t.proxy.answer("chat", streamAnswer(["Lacy ", "finished."]));
    const plan = new ModelCalls({ ownKey: () => undefined, account: () => t.account, accountActive: () => true, aiUrl: () => t.proxy.url, userAgent: () => UA, planCall });
    await (await plan.post("chat", { model: "anthropic/claude-haiku-5.5", messages: [], stream: true }, { call: "summary" })).text();
    assert.equal(marked, 1, "through the plan: marked");
  });
});
