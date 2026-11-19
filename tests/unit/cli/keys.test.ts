// `kiko keys` (src/keys-cli.ts): the list (set or not, where from, the last four characters
// only), `set` (asked for hidden, checked, then saved) and `remove` (after asking). A fake store, a
// fake .env and fake HTTP: never the Keychain, the repo's .env or the network, and every key fake.
// What it prints is checked for the keys.
import "../../setup.ts";
import { styleOf } from "../../../src/ui/cli-style.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseCli } from "../../../src/cli-args.ts";
import type { KeyFetch } from "../../../src/core/keys.ts";
import { keysCommand, type KeysDeps } from "../../../src/keys-cli.ts";
import type { KeyStore } from "../../../src/platform/types.ts";
import type { AccountView } from "../../../src/core/account/account.ts";
import type { Plan, Trial } from "../../../src/core/account/client.ts";

const FAKE_OR = "sk-or-test-0000000000000000aaaa";
const FAKE_ENV = "sk-or-test-2222222222222222eeee";
const FAKE_ANT = "sk-ant-test-0000000000000000cccc";

function fakeStore(start: Record<string, string> = {}) {
  const kept = { ...start };
  const store: KeyStore & { kept: Record<string, string> } = {
    where: "the Keychain",
    kept,
    get: (names) => Object.fromEntries(names.filter((n) => kept[n]).map((n) => [n, kept[n]])),
    set: async (name, key) => void (kept[name] = key),
    remove: async (name) => {
      const had = name in kept;
      delete kept[name];
      return had;
    },
    list: async () => Object.keys(kept).sort(),
  };
  return store;
}

const answering =
  (status: number, body: unknown = {}): KeyFetch =>
  async () => ({ status, ok: status === 200, text: async () => JSON.stringify(body) });

function run(args: string[], o: Partial<KeysDeps> & { typed?: string | null; yes?: boolean } = {}) {
  const out: string[] = [];
  const asked: string[] = [];
  const deps: KeysDeps = {
    env: {},
    dotenv: {},
    store: fakeStore(),
    chosen: { stt: "apple", tts: "say", llm: "haiku" },
    out: (line) => out.push(line),
    askKey: async (q) => (asked.push(q), o.typed === undefined ? FAKE_OR : o.typed),
    confirm: async (q) => (asked.push(q), o.yes ?? false),
    fetch: answering(200),
    ...o,
  };
  return keysCommand(args, deps).then((code) => ({ code, out, asked, text: out.join("\n") }));
}

describe("kiko keys", () => {
  test("the command line: keys, keys set <name>, keys remove <name>", () => {
    assert.deepEqual(parseCli(["keys"]), { kind: "run", command: "keys", args: [] });
    assert.deepEqual(parseCli(["keys", "set", "openrouter"]), { kind: "run", command: "keys", args: ["set", "openrouter"] });
    assert.equal(parseCli(["keys", "set", "openrouter", FAKE_OR]).kind, "error", "a key is never taken as an argument");
  });

  test("the list: where each comes from, the last four characters only, what's needed", async () => {
    const store = fakeStore({ OPENROUTER_API_KEY: FAKE_OR, ANTHROPIC_API_KEY: FAKE_ANT });
    const { code, text, out } = await run([], { store, env: { ANTHROPIC_API_KEY: FAKE_ENV }, chosen: { stt: "deepgram", tts: "say", llm: "haiku" } });
    assert.equal(code, 0);
    assert.match(out[0], /^openrouter\s+…aaaa · Keychain\s+the one key: every model and the classifier$/);
    assert.match(out[1], /^anthropic\s+…eeee · environment\s+optional: Haiku billed to Anthropic directly$/);
    assert.match(out[2], /also in the Keychain; the environment one wins/);
    assert.match(out[3], /^deepgram\s+not set\s+speech-to-text with Deepgram \(needed: speech-to-text is Deepgram\)$/);
    assert.match(out[4], /^cartesia\s+not set/);
    for (const key of [FAKE_OR, FAKE_ENV, FAKE_ANT]) assert.ok(!text.includes(key.slice(0, -4)), "never more than the last four characters");
  });

  test("the list reads .env's keys as .env's", async () => {
    const { out } = await run(["list"], { dotenv: { OPENROUTER_API_KEY: FAKE_ENV } });
    assert.match(out[0], /…eeee · \.env/);
  });

  test("set: asked for hidden, checked, then saved; a key in .env is said to win", async () => {
    const store = fakeStore();
    const r = await run(["set", "openrouter"], { store, dotenv: { OPENROUTER_API_KEY: FAKE_ENV } });
    assert.equal(r.code, 0);
    assert.equal(store.kept.OPENROUTER_API_KEY, FAKE_OR);
    assert.deepEqual(r.out, [
      "OpenRouter: the one key: every model and the classifier.",
      "✓ OpenRouter key works",
      "✓ Saved in the Keychain.",
      "! Your .env has OPENROUTER_API_KEY too: that one wins until you take it out.",
    ]);
    assert.ok(!r.text.includes(FAKE_OR));
  });

  test("set: turned down, nothing saved; offline asks whether to save anyway", async () => {
    const store = fakeStore();
    const refused = await run(["set", "anthropic"], { store, fetch: answering(401, { error: { message: "invalid x-api-key" } }) });
    assert.equal(refused.code, 1);
    assert.deepEqual(store.kept, {});
    assert.match(refused.text, /X Anthropic turned the key down: invalid x-api-key\nNothing saved\./);

    const off: KeyFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const no = await run(["set", "openrouter"], { store, fetch: off, yes: false });
    assert.equal(no.code, 1);
    assert.deepEqual(no.asked.at(-1), "Save it anyway?");
    assert.deepEqual(store.kept, {});
    const yes = await run(["set", "openrouter"], { store, fetch: off, yes: true });
    assert.equal(yes.code, 0);
    assert.equal(store.kept.OPENROUTER_API_KEY, FAKE_OR);
    assert.match(yes.text, /Saved in the Keychain \(unchecked\)\./);
  });

  test("set without a terminal or a key piped in, or without a Keychain: nothing saved", async () => {
    assert.match((await run(["set", "openrouter"], { typed: null })).text, /no key given/);
    assert.match((await run(["set", "openrouter"], { store: null })).text, /put OPENROUTER_API_KEY in \.env instead/);
  });

  test("remove: after asking; and a key name it doesn't know", async () => {
    const store = fakeStore({ DEEPGRAM_API_KEY: "dg-test-00000000000000000000" });
    const kept = await run(["remove", "deepgram"], { store, yes: false });
    assert.equal(kept.out.at(-1), "Nothing changed.");
    assert.ok(store.kept.DEEPGRAM_API_KEY);
    const gone = await run(["remove", "deepgram"], { store, yes: true });
    assert.equal(gone.out.at(-1), "✓ Removed the Deepgram key from the Keychain.");
    assert.deepEqual(store.kept, {});
    const none = await run(["remove", "deepgram"], { store, yes: true });
    assert.equal(none.out.at(-1), "The Keychain had no Deepgram key.");
    const unknown = await run(["set", "openai"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.text, /no key called openai: openrouter, anthropic, deepgram, cartesia/);
  });
});

describe("kiko keys, in colour", () => {
  test("the list keeps its columns: each padded before it's styled; the id bold, not set dim, what's needed yellow, the hint dim", async () => {
    const plain = await run([], { chosen: { stt: "deepgram", tts: "say", llm: "haiku" } });
    const color = await run([], { chosen: { stt: "deepgram", tts: "say", llm: "haiku" }, style: styleOf(true) });
    const strip = (line: string) => line.replace(/\x1b\[\d+m/g, "");
    assert.deepEqual(color.out.map(strip), plain.out, "the same text and columns once the codes are taken out");
    const deepgram = color.out.find((l) => strip(l).startsWith("deepgram"))!;
    assert.match(deepgram, /^\x1b\[1mdeepgram {3}\x1b\[22m \x1b\[2mnot set {15}\x1b\[22m .* \x1b\[33m\(needed: speech-to-text is Deepgram\)\x1b\[39m$/);
    assert.match(color.out.at(-1)!, /^\x1b\[2mkiko-dev keys set <name> enters one/);
  });

  test("set: the check's ✓ green, Saved a ✓, a refusal's ✗ drawn as a red X", async () => {
    const ok = await run(["set", "openrouter"], { style: styleOf(true) });
    assert.deepEqual(ok.out.slice(1, 3), ["\x1b[32m✓\x1b[39m OpenRouter key works", "\x1b[32m✓\x1b[39m Saved in the Keychain."]);
    const refused = await run(["set", "anthropic"], { style: styleOf(true), fetch: answering(401, { error: { message: "nope" } }) });
    assert.equal(refused.out[1], "\x1b[31mX\x1b[39m Anthropic turned the key down: nope");
  });
});

describe("kiko keys and the Kiko account (accounts open)", () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const DAY = 86_400_000;
  const trialPlan = (daysLeft: number, used: number) => ({
    name: "trial" as const,
    startedAt: now - DAY,
    endsAt: now + daysLeft * DAY - 60_000,
    quota: { period: "plan" as const, periodEnd: null, usedShare: used, dailyCap: true, dailyResetsAt: null, pastCap: "stop" as const },
  });
  const signedIn = (plan: Plan | null, trial: Trial | null = null): AccountView => ({
    state: "signed-in",
    email: "name@example.com",
    since: now - DAY,
    checkedAt: now,
    plan,
    trial,
  });

  test("signed in, a trial running: the account's line after the keys, and OpenRouter not said to be needed", async () => {
    const { code, out } = await run([], { account: signedIn(trialPlan(4, 0.31)), now: () => now, chosen: { stt: "apple", tts: "say", llm: "openai/gpt-5.4-nano" } });
    assert.equal(code, 0);
    assert.match(out[0], /^openrouter\s+not set\s+the one key: every model and the classifier$/, "no (needed: …): the trial runs it");
    assert.ok(out.includes("Kiko account: name@example.com · free trial, 4 days left, 31% used (runs the AI: no OpenRouter key needed)"), out.join("\n"));
    assert.match(out.at(-1)!, /keys set <name> enters one/);
  });

  test("signed in with a key of your own: the key wins, said; the trial ended; no plan; Pro", async () => {
    const store = fakeStore({ OPENROUTER_API_KEY: FAKE_OR });
    const a = await run([], { store, account: signedIn(trialPlan(2, 0.5)), now: () => now });
    assert.ok(a.out.includes("Kiko account: name@example.com · free trial, 2 days left, 50% used (your OpenRouter key wins while it's set)"));
    const ended = await run([], { account: signedIn(null, { startedAt: now - 8 * DAY, endsAt: now - DAY, ended: true, endedWhy: "time" }), now: () => now, chosen: { llm: "openai/gpt-5.4-nano" } });
    assert.ok(ended.out.includes("Kiko account: name@example.com · free trial ended"));
    assert.match(ended.out[0], /\(needed: the model is on OpenRouter\)/, "no plan running: the key is needed again");
    const none = await run([], { account: signedIn(null), now: () => now });
    assert.ok(none.out.includes("Kiko account: name@example.com · no plan"));
    const pro = { ...trialPlan(30, 0.12), name: "pro" as const };
    const p = await run([], { account: signedIn(pro), now: () => now });
    assert.ok(p.out.includes("Kiko account: name@example.com · Kiko Pro, 12% of this month used (runs the AI: no OpenRouter key needed)"));
  });

  test("Pro paid for with a key of your own: Pro still shown, and under it why its allowance isn't used (the trial's words unchanged)", async () => {
    const store = fakeStore({ OPENROUTER_API_KEY: FAKE_OR });
    const paid = {
      ...trialPlan(30, 0.12),
      name: "pro" as const,
      pro: { interval: "month" as const, renewsAt: Date.UTC(2026, 11, 3, 12), cancelAt: null, paymentFailed: null, weekShare: 0.1, pace: null },
    };
    const p = await run([], { store, account: signedIn(paid), now: () => now });
    const at = p.out.indexOf("Kiko account: name@example.com · Kiko Pro, renews 3 Dec");
    assert.ok(at >= 0, p.out.join("\n"));
    assert.equal(p.out[at + 1], `${"".padEnd(11)} Your own OpenRouter key is in use, so Pro isn't being used. To use Pro: kiko-dev keys remove openrouter`);
  });

  test("in colour: the label bold, the aside dim", async () => {
    const { out } = await run([], { account: signedIn(trialPlan(4, 0.31)), now: () => now, style: styleOf(true) });
    assert.ok(out.includes("\x1b[1mKiko account:\x1b[22m name@example.com · free trial, 4 days left, 31% used\x1b[2m (runs the AI: no OpenRouter key needed)\x1b[22m"));
  });

  test("not signed in, or accounts not open: no account line; signed out by the server: said, dim", async () => {
    for (const account of [null, undefined, { state: "signed-out", revoked: false } as AccountView]) {
      const { out } = await run([], { account });
      assert.ok(!out.some((l) => /Kiko account/.test(l)));
    }
    const { out } = await run([], { account: { state: "signed-out", revoked: true } });
    assert.ok(out.includes("Kiko account: signed out on its server (kiko-dev login signs in again)"));
  });
});
