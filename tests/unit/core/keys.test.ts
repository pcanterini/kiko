// The API keys (src/core/keys.ts): a key in the environment or .env wins over the Keychain, the
// missing ones are filled in from it at start, each key entered is checked with a cheap call to its
// provider before it's saved (fake HTTP here: nothing leaves the machine), only the keys the chosen
// options need are asked for, and settings → Keys' rows and options. Every key here is a fake one,
// and the store is a fake (never the Keychain); the log lines and what's said are checked for the
// key. (The real helper, on a throwaway keychain: tests/unit/platform/macos/keychain.test.ts.)
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  checkCall,
  checkKey,
  enterKey,
  fallbackLine,
  fillKeys,
  hasModelKey,
  keyForOption,
  keyNamed,
  keyRowsFor,
  keysShown,
  KeySettings,
  KEYS,
  keysInUse,
  masked,
  NEEDS_KEY,
  NO_KEY_TODO,
  NO_MODEL_KEY,
  pickEngines,
  reasonFrom,
  type KeyFetch,
  type KeySource,
} from "../../../src/core/keys.ts";
import { keyChoices, modelChoices, STT_ENGINES, TTS_ENGINES, withKeys } from "../../../src/core/settings-options.ts";
import { OPENROUTER_HAIKU, OPENROUTER_MODELS } from "../../../src/core/openrouter-llm.ts";
import { log } from "../../../src/core/log.ts";
import { pickKeyStore } from "../../../src/platform/keys.ts";
import { keyOf } from "../../../src/core/key-values.ts";
import type { KeyStore } from "../../../src/platform/types.ts";

const FAKE_OR = "sk-or-test-0000000000000000aaaa";
const FAKE_OR2 = "sk-or-test-1111111111111111bbbb";
const FAKE_ANT = "sk-ant-test-0000000000000000cccc";
const openrouter = KEYS.find((k) => k.id === "openrouter")!;

/** A store in memory, counting what it was asked. */
function fakeStore(start: Record<string, string> = {}, opts: { failGet?: string; failSet?: string } = {}) {
  const kept = { ...start };
  const asked: string[][] = [];
  const store: KeyStore & { kept: Record<string, string>; asked: string[][] } = {
    where: "the Keychain",
    kept,
    asked,
    get(names) {
      asked.push(names);
      if (opts.failGet) throw new Error(opts.failGet);
      return Object.fromEntries(names.filter((n) => kept[n]).map((n) => [n, kept[n]]));
    },
    async set(name, key) {
      if (opts.failSet) throw new Error(opts.failSet);
      kept[name] = key;
    },
    async remove(name) {
      const had = name in kept;
      delete kept[name];
      return had;
    },
    async list() {
      return Object.keys(kept).sort();
    },
  };
  return store;
}

type Call = { url: string; headers: Record<string, string> };
/** A fetch that answers `status` with `body`, noting what it was asked. */
function fakeFetch(status: number, body: unknown = {}) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}
const offline = async () => {
  throw new TypeError("fetch failed");
};

describe("where the keys come from", () => {
  test("the environment and .env win over the Keychain; missing ones are filled in from it", () => {
    const store = fakeStore({ OPENROUTER_API_KEY: FAKE_OR2, ANTHROPIC_API_KEY: FAKE_ANT, DEEPGRAM_API_KEY: "dg-test-0000" });
    // OpenRouter's from the shell, Cartesia's from .env (set when config.ts read it, not before).
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: FAKE_OR, CARTESIA_API_KEY: "sk_car_test_0000" };
    const held: Record<string, string> = {};
    const { sources, error } = fillKeys(env, new Set(["OPENROUTER_API_KEY"]), store, held);
    assert.equal(error, undefined);
    assert.equal(env.OPENROUTER_API_KEY, FAKE_OR, "the environment's key stays");
    // Found by Kiko (the Keychain's, .env's): held, never in the environment anything started inherits.
    assert.deepEqual(env, { OPENROUTER_API_KEY: FAKE_OR });
    assert.deepEqual(held, { CARTESIA_API_KEY: "sk_car_test_0000", ANTHROPIC_API_KEY: FAKE_ANT, DEEPGRAM_API_KEY: "dg-test-0000" });
    assert.deepEqual(keysInUse(env, held), { OPENROUTER_API_KEY: FAKE_OR, ANTHROPIC_API_KEY: FAKE_ANT, DEEPGRAM_API_KEY: "dg-test-0000", CARTESIA_API_KEY: "sk_car_test_0000" });
    assert.equal(keyOf("ANTHROPIC_API_KEY", env, held), FAKE_ANT);
    assert.deepEqual(sources, { OPENROUTER_API_KEY: "environment", CARTESIA_API_KEY: ".env", ANTHROPIC_API_KEY: "Keychain", DEEPGRAM_API_KEY: "Keychain" });
    // Only the missing ones were asked for: the environment's is never read from the Keychain.
    assert.deepEqual(store.asked, [["ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY"]]);
  });

  test("nothing missing, or no store: the Keychain isn't asked", () => {
    const store = fakeStore({ OPENROUTER_API_KEY: FAKE_OR2 });
    const env: NodeJS.ProcessEnv = Object.fromEntries(KEYS.map((k) => [k.env, `${k.id}-test-0000`]));
    fillKeys(env, new Set(), store, {});
    assert.deepEqual(store.asked, []);
    const bare: NodeJS.ProcessEnv = {};
    assert.deepEqual(fillKeys(bare, new Set(), null, {}), { sources: {} });
    assert.deepEqual(bare, {});
  });

  test("a Keychain that fails fills nothing, and says why without a key", () => {
    const env: NodeJS.ProcessEnv = {};
    const { sources, error } = fillKeys(env, new Set(), fakeStore({}, { failGet: "you said no to the prompt" }), {});
    assert.deepEqual(sources, {});
    assert.equal(error, "you said no to the prompt");
    assert.deepEqual(env, {});
  });

  test("the store: off under the test runner, off when asked, a keychain file when given", () => {
    assert.equal(pickKeyStore({ NODE_TEST_CONTEXT: "child" }, "darwin"), null, "never the login keychain from a test");
    assert.equal(pickKeyStore({ KIKO_KEYCHAIN: "off" }, "darwin"), null);
    assert.equal(pickKeyStore({}, "linux"), null);
    assert.equal(pickKeyStore({ KIKO_KEYCHAIN: "/tmp/x.keychain-db", NODE_TEST_CONTEXT: "child" }, "darwin")?.where, "the Keychain");
  });

  test("a key is shown by its last four characters only", () => {
    assert.equal(masked(FAKE_OR), "…aaaa");
    assert.equal(masked("short-key"), "…");
    assert.ok(!masked(FAKE_OR).includes(FAKE_OR.slice(0, -4)));
  });

  test("names: the id, the provider, or the variable", () => {
    assert.equal(keyNamed("openrouter")?.env, "OPENROUTER_API_KEY");
    assert.equal(keyNamed("OpenRouter")?.id, "openrouter");
    assert.equal(keyNamed("ANTHROPIC_API_KEY")?.id, "anthropic");
    assert.equal(keyNamed("nope"), undefined);
  });
});

describe("only the keys the chosen options need", () => {
  const none = new Set<string>();
  test("OpenRouter first, Anthropic always (optional); Deepgram and Cartesia only when chosen or set", () => {
    const ids = (c: { stt: string; tts: string; llm: string }, set = none) => keysShown(c, set).map((k) => k.id);
    assert.deepEqual(ids({ stt: "apple", tts: "pocket", llm: "haiku" }), ["openrouter", "anthropic"]);
    assert.deepEqual(ids({ stt: "deepgram", tts: "cartesia", llm: "haiku" }), ["openrouter", "anthropic", "deepgram", "cartesia"]);
    assert.deepEqual(ids({ stt: "apple", tts: "say", llm: "haiku" }, new Set(["CARTESIA_API_KEY"])), ["openrouter", "anthropic", "cartesia"]);
  });

  test("the wording is short and plain", () => {
    assert.equal(openrouter.what, "the one key: every model and the classifier");
    assert.equal(KEYS.find((k) => k.id === "anthropic")!.what, "optional: Haiku billed to Anthropic directly");
  });
});

describe("what runs, by the keys there are", () => {
  const all: NodeJS.ProcessEnv = Object.fromEntries(KEYS.map((k) => [k.env, `${k.id}-test-0000`]));
  const only = (...ids: string[]): NodeJS.ProcessEnv => Object.fromEntries(KEYS.filter((k) => ids.includes(k.id)).map((k) => [k.env, `${k.id}-test-0000`]));

  test("nothing chosen, every key: Cartesia, Deepgram and Haiku on Anthropic, as before (nothing to say)", () => {
    assert.deepEqual(pickEngines({}, all, true), { tts: "cartesia", stt: "deepgram", llm: "haiku", fallbacks: [] });
  });

  test("nothing chosen, only OpenRouter: the one-key setup (Pocket, Apple, Haiku through OpenRouter), nothing to say", () => {
    assert.deepEqual(pickEngines({}, only("openrouter"), true), { tts: "pocket", stt: "apple", llm: OPENROUTER_HAIKU, fallbacks: [] });
    // No key at all, but a Kiko account's plan running: OpenRouter's models through the account.
    assert.deepEqual(pickEngines({}, {}, true, true), { tts: "pocket", stt: "apple", llm: OPENROUTER_HAIKU, fallbacks: [] });
    assert.equal(pickEngines({}, {}, true, false).llm, null);
    assert.equal(pickEngines({ llm: "deepseek/deepseek-v4.1-flash" }, {}, true, true).llm, "deepseek/deepseek-v4.1-flash");
    assert.equal(OPENROUTER_HAIKU, "anthropic/claude-haiku-5.5");
    assert.ok(
      OPENROUTER_MODELS.some((m) => m.id === OPENROUTER_HAIKU),
      "one of the models offered",
    );
    // Pocket not installed (pocket/setup.sh never run): the macOS voice, which is always there.
    assert.equal(pickEngines({}, only("openrouter"), false).tts, "say");
    // Each paid key on its own brings its engine back.
    assert.deepEqual(pickEngines({}, only("openrouter", "cartesia"), true).tts, "cartesia");
    assert.deepEqual(pickEngines({}, only("anthropic"), true).llm, "haiku");
  });

  test("Pocket chosen but not installed in this copy (a new clone, the settings shared): the macOS voice, nothing to say for a key", () => {
    assert.deepEqual(pickEngines({ tts: "pocket" }, only("openrouter"), false), { tts: "say", stt: "apple", llm: OPENROUTER_HAIKU, fallbacks: [] });
    assert.equal(pickEngines({ tts: "pocket" }, only("openrouter"), true).tts, "pocket", "installed: Pocket");
    // Cartesia chosen with no key and no Pocket here: the macOS voice stands in, said as before.
    assert.deepEqual(pickEngines({ tts: "cartesia" }, only("openrouter"), false).fallbacks, [{ setting: "tts", chosen: "cartesia", using: "say", key: "cartesia" }]);
  });

  test("chosen with its key: runs as chosen", () => {
    assert.deepEqual(pickEngines({ tts: "say", stt: "apple", llm: "deepseek/deepseek-v4.1-flash" }, all, true), { tts: "say", stt: "apple", llm: "deepseek/deepseek-v4.1-flash", fallbacks: [] });
  });

  test("chosen without its key: a free one stands in, and it's said", () => {
    const picked = pickEngines({ tts: "cartesia", stt: "deepgram", llm: "haiku" }, only("openrouter"), true);
    assert.deepEqual(picked, {
      tts: "pocket",
      stt: "apple",
      llm: OPENROUTER_HAIKU,
      fallbacks: [
        { setting: "tts", chosen: "cartesia", using: "pocket", key: "cartesia" },
        { setting: "stt", chosen: "deepgram", using: "apple", key: "deepgram" },
        { setting: "llm", chosen: "haiku", using: OPENROUTER_HAIKU, key: "anthropic" },
      ],
    });
    assert.equal(
      fallbackLine(picked.fallbacks),
      "No Cartesia key, so the Pocket voice is speaking; no Deepgram key, so Apple's speech recognition is listening; no Anthropic key, so Claude Haiku runs through OpenRouter. Add them in Settings → Keys.",
    );
    assert.equal(fallbackLine(picked.fallbacks.slice(0, 1)), "No Cartesia key, so the Pocket voice is speaking. Add one in Settings → Keys.");
    assert.equal(fallbackLine(pickEngines({ tts: "cartesia" }, only("openrouter"), false).fallbacks), "No Cartesia key, so the macOS voice is speaking. Add one in Settings → Keys.");
  });

  test("the model: an OpenRouter one without its key → Haiku on Anthropic; Haiku through OpenRouter likewise", () => {
    const picked = pickEngines({ llm: "deepseek/deepseek-v4.1-flash" }, only("anthropic"), true);
    assert.equal(picked.llm, "haiku");
    assert.deepEqual(picked.fallbacks, [{ setting: "llm", chosen: "deepseek/deepseek-v4.1-flash", using: "haiku", key: "openrouter" }]);
    assert.equal(fallbackLine(picked.fallbacks), "No OpenRouter key, so Claude Haiku on Anthropic stands in for DeepSeek V4.1 Flash. Add one in Settings → Keys.");
    assert.equal(pickEngines({ llm: OPENROUTER_HAIKU }, only("anthropic"), true).llm, "haiku");
  });

  test("no model key at all: no model (the app stops and says how to add one), chosen or not", () => {
    assert.equal(pickEngines({}, {}, true).llm, null);
    assert.equal(pickEngines({ llm: "haiku" }, only("cartesia", "deepgram"), true).llm, null);
    assert.equal(pickEngines({ llm: OPENROUTER_HAIKU }, {}, true).llm, null);
    // Voice and speech still have their free ones.
    assert.deepEqual(pickEngines({}, {}, true).tts, "pocket");
  });

  test("which key each option needs", () => {
    assert.equal(keyForOption("tts", "cartesia")?.id, "cartesia");
    assert.equal(keyForOption("tts", "pocket"), null);
    assert.equal(keyForOption("stt", "deepgram")?.id, "deepgram");
    assert.equal(keyForOption("stt", "apple"), null);
    assert.equal(keyForOption("llm", "haiku")?.id, "anthropic");
    assert.equal(keyForOption("llm", OPENROUTER_HAIKU)?.id, "openrouter");
  });

  test("the settings' options: every one shown, those whose key is missing marked", () => {
    const marked = (c: { value: unknown; needsKey?: string }[]) => c.filter((x) => x.needsKey).map((x) => `${x.value}:${x.needsKey}`);
    assert.deepEqual(marked(withKeys("tts", TTS_ENGINES, {})), ["cartesia:cartesia"]);
    assert.deepEqual(marked(withKeys("tts", TTS_ENGINES, only("cartesia"))), []);
    assert.deepEqual(marked(withKeys("stt", STT_ENGINES, {})), ["deepgram:deepgram"]);
    // The model: every OpenRouter model listed even with no OpenRouter key, each marked; Haiku on Anthropic marked without its key.
    const models = modelChoices(only("anthropic"));
    assert.deepEqual(
      models.map((m) => m.value),
      ["haiku", ...OPENROUTER_MODELS.map((m) => m.id)],
    );
    assert.deepEqual(
      marked(models),
      OPENROUTER_MODELS.map((m) => `${m.id}:openrouter`),
    );
    assert.deepEqual(marked(modelChoices(only("openrouter"))), ["haiku:anthropic"]);
    assert.deepEqual(marked(modelChoices(all)), []);
  });
});

describe("checking a key before it's saved", () => {
  test("each provider's cheap call, with the key in its header (never the URL)", () => {
    const want: Record<string, [string, string, string]> = {
      openrouter: ["https://openrouter.ai/api/v1/key", "Authorization", `Bearer ${FAKE_OR}`],
      anthropic: ["https://api.anthropic.com/v1/models?limit=1", "x-api-key", FAKE_OR],
      deepgram: ["https://api.deepgram.com/v1/projects", "Authorization", `Token ${FAKE_OR}`],
      cartesia: ["https://api.cartesia.ai/voices?limit=1", "X-API-Key", FAKE_OR],
    };
    for (const k of KEYS) {
      const call = checkCall(k.id, FAKE_OR);
      const [url, header, value] = want[k.id];
      assert.equal(call.url, url);
      assert.equal(call.headers[header], value);
      assert.ok(!call.url.includes(FAKE_OR));
    }
    assert.equal(checkCall("anthropic", FAKE_OR).headers["anthropic-version"], "2023-06-01");
    assert.ok(checkCall("cartesia", FAKE_OR).headers["Cartesia-Version"]);
  });

  test("works: ✓", async () => {
    const { fetch, calls } = fakeFetch(200, { data: { label: "test" } });
    assert.deepEqual(await checkKey("openrouter", FAKE_OR, { fetch }), { result: "works", said: "✓ OpenRouter key works" });
    assert.equal(calls.length, 1);
  });

  test("turned down: the provider's reason, never the key", async () => {
    const or = await checkKey("openrouter", FAKE_OR, { fetch: fakeFetch(401, { error: { code: 401, message: "User not found." } }).fetch });
    assert.deepEqual(or, { result: "refused", said: "✗ OpenRouter turned the key down: User not found." });
    const ant = await checkKey("anthropic", FAKE_ANT, { fetch: fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }).fetch });
    assert.equal(ant.said, "✗ Anthropic turned the key down: invalid x-api-key");
    const dg = await checkKey("deepgram", "dg-test-0000", { fetch: fakeFetch(401, { err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }).fetch });
    assert.equal(dg.said, "✗ Deepgram turned the key down: Invalid credentials.");
    // A provider that repeats the key back: it's taken out.
    const echoed = await checkKey("cartesia", FAKE_OR, { fetch: fakeFetch(401, { message: `Invalid API key ${FAKE_OR}` }).fetch });
    assert.equal(echoed.result, "refused");
    assert.ok(!echoed.said.includes(FAKE_OR), echoed.said);
    assert.equal(reasonFrom(`bad key: ${FAKE_OR}`, FAKE_OR), "bad key: …");
  });

  test("couldn't check: offline, too slow, or the provider failing", async () => {
    const off = await checkKey("openrouter", FAKE_OR, { fetch: offline });
    assert.equal(off.result, "unchecked");
    assert.match(off.said, /^Couldn't reach OpenRouter to check the key/);
    // Waits only as long as it's told.
    const slow = (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const late = await checkKey("anthropic", FAKE_ANT, { fetch: slow, timeoutMs: 20 });
    assert.deepEqual(late, { result: "unchecked", said: "Couldn't reach Anthropic to check the key (it didn't answer in time)" });
    const down = await checkKey("openrouter", FAKE_OR, { fetch: fakeFetch(503, "upstream down").fetch });
    assert.deepEqual(down, { result: "unchecked", said: "Couldn't check the key: OpenRouter answered 503 (upstream down)" });
    // Deepgram: a key without the scope to list projects isn't turned down for it.
    assert.equal((await checkKey("deepgram", "dg-test-0000", { fetch: fakeFetch(403, { err_msg: "Insufficient permissions." }).fetch })).result, "unchecked");
  });

  test("entering one: saved only if it works, or if it couldn't be checked and you say so", async () => {
    const yes = async () => true;
    const no = async () => false;
    let store = fakeStore();
    const ok = await enterKey(openrouter, `  ${FAKE_OR}\n`, { store, anyway: no, fetch: fakeFetch(200).fetch });
    assert.deepEqual(ok, { saved: true, lines: ["✓ OpenRouter key works", "Saved in the Keychain."] });
    assert.equal(store.kept.OPENROUTER_API_KEY, FAKE_OR, "trimmed");

    store = fakeStore();
    const refused = await enterKey(openrouter, FAKE_OR, { store, anyway: yes, fetch: fakeFetch(401, { error: { message: "No auth credentials found" } }).fetch });
    assert.equal(refused.saved, false);
    assert.deepEqual(store.kept, {}, "a key turned down is never saved, whatever you'd say");

    const notAsked = await enterKey(openrouter, FAKE_OR, { store, anyway: no, fetch: offline });
    assert.equal(notAsked.saved, false);
    assert.deepEqual(store.kept, {});
    const anyway = await enterKey(openrouter, FAKE_OR, { store, anyway: yes, fetch: offline });
    assert.equal(anyway.saved, true);
    assert.equal(anyway.lines.at(-1), "Saved in the Keychain (unchecked).");

    const broken = await enterKey(openrouter, FAKE_OR, { store: fakeStore({}, { failSet: `couldn't write ${FAKE_OR}` }), anyway: no, fetch: fakeFetch(200).fetch });
    assert.equal(broken.saved, false);
    assert.ok(!broken.lines.join("\n").includes(FAKE_OR));
    assert.deepEqual((await enterKey(openrouter, "   ", { store, anyway: yes })).lines, ["No key entered; nothing saved."]);
    assert.match((await enterKey(openrouter, FAKE_OR, { store: null, anyway: yes })).lines[0], /put OPENROUTER_API_KEY in \.env/);
  });
});

describe("settings → Keys", () => {
  const chosen = { stt: "apple", tts: "say", llm: "haiku" };

  test("the rows: where each key comes from, its last four characters, and what's missing", () => {
    const rows = keyRowsFor({
      chosen,
      env: { OPENROUTER_API_KEY: FAKE_OR },
      sources: { OPENROUTER_API_KEY: ".env" },
      keychain: new Set(["OPENROUTER_API_KEY"]),
      unchecked: null,
      store: true,
    });
    assert.deepEqual(
      rows.map((r) => [r.key, r.label, r.value, r.note]),
      [
        ["key:openrouter", "OpenRouter", "…aaaa · .env", "The .env key wins over the Keychain's"],
        ["key:anthropic", "Anthropic", "Not set", "Needed: summaries use Haiku on Anthropic"],
      ],
    );
    assert.ok(!JSON.stringify(rows).includes(FAKE_OR), "no row carries a key");
    assert.deepEqual(JSON.parse(String(rows[0].raw)), { set: true, source: ".env", inKeychain: true, unchecked: false, store: true });
    // Deepgram's row comes with its engine.
    const withDeepgram = keyRowsFor({ chosen: { ...chosen, stt: "deepgram" }, env: {}, sources: {}, keychain: new Set(), unchecked: null, store: true });
    assert.deepEqual(
      withDeepgram.map((r) => r.key),
      ["key:openrouter", "key:anthropic", "key:deepgram"],
    );
  });

  test("the options: enter one (hidden), remove the Keychain's; or save an unchecked one anyway", () => {
    const row = { set: true, source: "Keychain" as KeySource, inKeychain: true, unchecked: false, store: true };
    assert.deepEqual(keyChoices("OpenRouter", row), {
      choices: [
        { value: "remove", label: "Remove from the Keychain" },
        { value: "keep", label: "Leave it" },
      ],
      apiKey: "OpenRouter",
    });
    assert.deepEqual(
      keyChoices("OpenRouter", { ...row, inKeychain: false }).choices.map((c) => c.value),
      ["keep"],
    );
    assert.deepEqual(
      keyChoices("OpenRouter", { ...row, unchecked: true }).choices.map((c) => c.value),
      ["save", "drop"],
    );
    assert.equal(keyChoices("OpenRouter", { ...row, store: false }).apiKey, undefined, "no Keychain: nothing to enter it in");
  });

  /** The Keys section with a fake store and fetch, the real log, and what it says kept. */
  function section(o: { env?: NodeJS.ProcessEnv; sources?: Record<string, KeySource>; fetch?: KeyFetch; store?: ReturnType<typeof fakeStore> } = {}) {
    const said: string[] = [];
    const used: string[] = [];
    let restarts = 0;
    const store = o.store ?? fakeStore();
    const env = o.env ?? {};
    const sources = o.sources ?? {};
    const keys = new KeySettings({
      env,
      sources,
      store,
      fetch: o.fetch,
      timeoutMs: 50,
      log,
      say: (line) => said.push(line),
      use: (info, key) => {
        used.push(info.id);
        env[info.env] = key;
        return info.id !== "openrouter";
      },
      restart: () => restarts++,
    });
    return { keys, said, used, store, env, sources, restarts: () => restarts };
  }

  test("a key entered that works: saved, used, said; a restart only for an engine that started with the old one", async () => {
    const s = section({ fetch: fakeFetch(200).fetch });
    await s.keys.enter("openrouter", FAKE_OR);
    assert.equal(s.store.kept.OPENROUTER_API_KEY, FAKE_OR);
    assert.deepEqual(s.used, ["openrouter"]);
    assert.equal(s.sources.OPENROUTER_API_KEY, "Keychain");
    assert.deepEqual(s.said, ["(checking the OpenRouter key…)", "(✓ OpenRouter key works: saved in the Keychain.)"]);
    assert.equal(s.restarts(), 0);
    await s.keys.enter("anthropic", FAKE_ANT);
    assert.equal(s.restarts(), 1);
  });

  test("entering one says whether it was saved (an option waiting on it is set only then)", async () => {
    assert.equal(await section({ fetch: fakeFetch(200).fetch }).keys.enter("cartesia", "sk_car_test_0000aaaa"), true);
    assert.equal(await section({ fetch: fakeFetch(401).fetch }).keys.enter("cartesia", "sk_car_test_0000aaaa"), false);
    assert.equal(await section({ fetch: offline }).keys.enter("cartesia", "sk_car_test_0000aaaa"), false, "unchecked: held for save it anyway");
    const said: string[] = [];
    const bare = new KeySettings({ env: {}, sources: {}, store: null, log, say: (line) => said.push(line), use: () => false, restart: () => {} });
    assert.equal(await bare.enter("cartesia", "sk_car_test_0000aaaa"), false);
    assert.deepEqual(said, ["(No Keychain here: put CARTESIA_API_KEY in .env instead.)"]);
  });

  test("one shadowed by .env: saved, not used, and said so", async () => {
    const s = section({ fetch: fakeFetch(200).fetch, env: { OPENROUTER_API_KEY: FAKE_OR2 }, sources: { OPENROUTER_API_KEY: ".env" } });
    await s.keys.enter("openrouter", FAKE_OR);
    assert.equal(s.store.kept.OPENROUTER_API_KEY, FAKE_OR);
    assert.deepEqual(s.used, []);
    assert.equal(s.env.OPENROUTER_API_KEY, FAKE_OR2);
    assert.equal(s.said.at(-1), "(✓ OpenRouter key works: saved in the Keychain. The .env one wins while it's there.)");
  });

  test("offline: held until you say save it anyway (or don't); settings closing lets it go", async () => {
    const s = section({ fetch: offline });
    await s.keys.enter("openrouter", FAKE_OR);
    assert.deepEqual(s.store.kept, {});
    assert.match(s.said.at(-1)!, /Save it anyway\? It's under Keys → OpenRouter/);
    assert.equal(s.keys.rows(chosen)[0].note, "Couldn't check the key you entered: save it anyway?");
    await s.keys.act("openrouter", "save");
    assert.equal(s.store.kept.OPENROUTER_API_KEY, FAKE_OR);
    assert.equal(s.said.at(-1), "(OpenRouter key unchecked: saved in the Keychain.)");

    const t = section({ fetch: offline });
    await t.keys.enter("openrouter", FAKE_OR);
    t.keys.forget();
    await t.keys.act("openrouter", "save");
    assert.deepEqual(t.store.kept, {}, "nothing held once settings closed");
  });

  test("refused: nothing saved; remove takes the Keychain's out", async () => {
    const s = section({ fetch: fakeFetch(401, { error: { message: "User not found." } }).fetch, store: fakeStore({ ANTHROPIC_API_KEY: FAKE_ANT }) });
    await s.keys.readNames();
    await s.keys.enter("openrouter", FAKE_OR);
    assert.equal(s.store.kept.OPENROUTER_API_KEY, undefined);
    assert.equal(s.said.at(-1), "(✗ OpenRouter turned the key down: User not found. Nothing saved.)");
    assert.ok(s.keys.keychain.has("ANTHROPIC_API_KEY"));
    await s.keys.act("anthropic", "remove");
    assert.deepEqual(s.store.kept, {});
    assert.ok(!s.keys.keychain.has("ANTHROPIC_API_KEY"));
    assert.equal(s.said.at(-1), "(Anthropic key removed from the Keychain.)");
  });

  test("no key is ever in the log or in what's said", async () => {
    const echo = (status: number) => async (url: string, init: { headers: Record<string, string> }) => ({
      status,
      ok: status === 200,
      text: async () => JSON.stringify({ error: { message: `bad key ${Object.values(init.headers).join(" ")}` } }),
    });
    for (const fetch of [fakeFetch(200).fetch, echo(401), echo(500), offline]) {
      const s = section({ fetch, store: fakeStore({}, {}) });
      await s.keys.enter("openrouter", FAKE_OR);
      await s.keys.act("openrouter", "save");
      await s.keys.act("openrouter", "remove");
      const failing = section({ fetch: fakeFetch(200).fetch, store: fakeStore({}, { failSet: `can't write ${FAKE_OR}` }) });
      await failing.keys.enter("openrouter", FAKE_OR);
      for (const line of [...s.said, ...failing.said]) assert.ok(!line.includes(FAKE_OR), line);
    }
    const logs = readdirSync("logs").filter((f) => f.endsWith(".jsonl"));
    const lines = logs.flatMap((f) => readFileSync(`logs/${f}`, "utf8").trim().split("\n"));
    const events = lines.map((l) => JSON.parse(l).event);
    assert.ok(events.includes("key_checked") && events.includes("key_saved") && events.includes("key_removed"), events.join(","));
    for (const line of lines) assert.ok(!line.includes(FAKE_OR) && !line.includes(FAKE_OR.slice(-12)), line);
  });
});

describe("is there a model key: one question, setup's and the app's", () => {
  test("OpenRouter's or Anthropic's, set and not blank", () => {
    assert.equal(hasModelKey({}), false);
    assert.equal(hasModelKey({ OPENROUTER_API_KEY: FAKE_OR }), true);
    assert.equal(hasModelKey({ ANTHROPIC_API_KEY: FAKE_ANT }), true);
    assert.equal(hasModelKey({ OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "  " }), false, "a blank one is none");
    assert.equal(hasModelKey({ DEEPGRAM_API_KEY: "dg", CARTESIA_API_KEY: "ca" }), false, "nor another provider's");
  });

  test("the app's model is there exactly when setup says there's a key (pickEngines: no model is null)", () => {
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { OPENROUTER_API_KEY: FAKE_OR },
      { ANTHROPIC_API_KEY: FAKE_ANT },
      { OPENROUTER_API_KEY: " " },
      { ANTHROPIC_API_KEY: "\n" },
      { OPENROUTER_API_KEY: FAKE_OR, ANTHROPIC_API_KEY: FAKE_ANT },
    ];
    for (const env of envs)
      for (const llm of [undefined, "haiku", OPENROUTER_HAIKU]) assert.equal(pickEngines({ llm }, env, false).llm !== null, hasModelKey(env), `${JSON.stringify(env)} llm=${llm}`);
  });

  test("a blank key in the environment doesn't hide the Keychain's", () => {
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "   " };
    const held: Record<string, string> = {};
    const { sources } = fillKeys(env, new Set(["OPENROUTER_API_KEY"]), fakeStore({ OPENROUTER_API_KEY: FAKE_OR }), held);
    assert.equal(sources.OPENROUTER_API_KEY, "Keychain");
    assert.equal(hasModelKey(keysInUse(env, held)), true);
    assert.equal(keyOf("OPENROUTER_API_KEY", env, held), FAKE_OR);
  });

  test("no model key: said exactly, by this flavour's command", () => {
    assert.equal(NEEDS_KEY, "Kiko needs an OpenRouter key to answer.");
    assert.equal(NO_KEY_TODO, "Run `kiko-dev keys set openrouter`, paste your key, then run `kiko-dev`.");
    assert.equal(NO_MODEL_KEY, `${NEEDS_KEY} ${NO_KEY_TODO}`);
  });
});
