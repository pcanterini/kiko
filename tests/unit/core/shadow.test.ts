// Shadow testing (src/core/shadow.ts, scripts/shadow-report.ts), a developer's tool that is off unless
// KIKO_DEV_SHADOW=1 (nothing a user sees turns it on): the shadow decision model never changes,
// delays or breaks the deciding model's answer, whatever it does; its log line pairs with that
// model's; each kind of decision has its own deciding and shadow model (your words: d1-ultra,
// shadowed by Jev; finished turns: Jev, shadowed by d1-ultra); and the report pairs, compares and
// describes what the app did, by model name. fetch is stubbed: no network.
import "../../setup.ts";
import { holdKey } from "../../../src/core/key-values.ts";
// The classifier on your own OpenRouter key (core/model-route.ts: a call with no key and no plan fails before fetch).
holdKey("OPENROUTER_API_KEY", "sk-or-v1-test-only-0000");
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { CAST, makeWorld } from "../../support/fixtures.ts";

// The log goes to a folder of its own (read back below), set before log.ts loads.
const LOG_DIR = mkdtempSync(join(tmpdir(), "kiko-shadow-"));
process.env.KIKO_LOG_DIR = LOG_DIR;
const { config } = await import("../../../src/core/config.ts");
const { decideStop, decideUtterance } = await import("../../../src/core/decisions.ts");
const { shadowModelFor } = await import("../../../src/core/shadow.ts");
const R = await import("../../../scripts/shadow-report.ts");

const JEV = config.classifierModel;
const SHADOW = "liquid/d1-ultra";
const realFetch = globalThis.fetch;
const defaultUtteranceModel = config.utteranceModel;
afterEach(() => {
  globalThis.fetch = realFetch;
  config.utteranceModel = defaultUtteranceModel;
  config.shadowModel = "";
  config.utteranceShadowModel = "";
});

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const noul = (p: number) => ({ type: "noul", noul: p });
const choice = (c: string, confidence: number) => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
const STOP_ANSWERS = { needs_user: noul(0.8), worth_saying: noul(0.9) };
const primaryStop = () => ok({ model: `${JEV}-served`, answers: STOP_ANSWERS, usage: { cost: 0.00005 } });

type ShadowBehaviour = (init: RequestInit) => Promise<Response> | Response;
/**
 * fetch stubbed by model: the deciding model answers `primary`, the shadow model (`shadowModel`, d1-ultra
 * unless said) does `shadow`. Counts calls per model.
 */
function stub(primary: () => Response, shadow: ShadowBehaviour, shadowModel = SHADOW) {
  const calls: string[] = [];
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    calls.push(model);
    if (model === shadowModel) return shadow(init!);
    return Promise.resolve(primary());
  }) as typeof fetch;
  return calls;
}

function logLines(): any[] {
  const file = readdirSync(LOG_DIR).find((f) => f.endsWith(".jsonl"));
  if (!file) return [];
  return readFileSync(join(LOG_DIR, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
async function shadowLine(id: string) {
  for (let i = 0; i < 100; i++) {
    const line = logLines().find((e) => e.event === "shadow" && e.id === id);
    if (line) return line;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`no shadow line for ${id}`);
}
const lastClassify = () => logLines().findLast((e) => e.event === "classify");
const STOP_INPUT = { claudeReply: "Done: the tests pass. Want me to commit?", context: [] };
const sameAnswer = (d: { needsUser: number; worthSaying: number; costUsd: number }) => ({ needsUser: d.needsUser, worthSaying: d.worthSaying, costUsd: d.costUsd });

describe("shadow model beside the deciding one", () => {
  test("off: only the classifier is asked", async () => {
    const calls = stub(primaryStop, () => assert.fail("shadow asked"));
    await decideStop(STOP_INPUT);
    assert.deepEqual(calls, [JEV]);
  });

  test("on: the same request goes to both, and the shadow line pairs with the classifier's by id", async () => {
    config.shadowModel = SHADOW;
    let shadowBody: any;
    const calls = stub(primaryStop, (init) => {
      shadowBody = JSON.parse(String(init.body));
      return ok({ model: SHADOW, answers: { needs_user: noul(0.6), worth_saying: noul(0.2) }, usage: { cost: 0.000045 } });
    });
    const d = await decideStop(STOP_INPUT);
    assert.deepEqual(sameAnswer(d), { needsUser: 0.8, worthSaying: 0.9, costUsd: 0.00005 });
    assert.deepEqual(calls.sort(), [JEV, SHADOW].sort());
    const line = lastClassify();
    assert.equal(line.what, "stop");
    assert.equal(line.model, JEV);
    assert.equal(line.served, `${JEV}-served`);
    assert.match(line.id, /^[0-9a-f]{8}$/);
    assert.deepEqual(shadowBody.state, line.state);
    const s = await shadowLine(line.id);
    assert.equal(s.what, "stop");
    assert.equal(s.model, SHADOW);
    assert.deepEqual(s.answers, { needs_user: noul(0.6), worth_saying: noul(0.2) });
    assert.equal(s.costUsd, 0.000045);
    assert.equal(typeof s.ms, "number");
  });

  test("utterances: with d1-ultra deciding, Jev shadows, and the shadow line names the session behind each handle", async () => {
    config.utteranceModel = "liquid/d1-ultra";
    config.utteranceShadowModel = JEV;
    const world = makeWorld([CAST.voice, CAST.clipkit]);
    const answers = { audience: choice("s2", 0.9), intent: choice("message", 1), app_parts: noul(0.1), retracted: noul(0.02) };
    const shadowAnswers = { ...answers, audience: choice("s1", 0.6) };
    const calls = stub(
      () => ok({ model: `${config.utteranceModel}-20261015`, answers, usage: { cost: 0.00004 } }),
      () => ok({ model: JEV, answers: shadowAnswers, usage: { cost: 0.00006 } }),
      JEV,
    );
    const d = await decideUtterance({
      text: "Run the tests.",
      sessions: world.sessions.map((session) => ({ session, asked: "", said: "" })),
      waitingId: null,
      justSpoke: null,
      lastId: null,
      recent: [],
    });
    assert.equal(config.utteranceModel, "liquid/d1-ultra");
    assert.deepEqual(calls.sort(), [JEV, "liquid/d1-ultra"].sort());
    // Acted on: d1-ultra's pick, not the shadow's; it names itself as it answered.
    assert.equal(d.audience, world.byName.get("clipkit"));
    assert.equal(d.model, "liquid/d1-ultra-20261015");
    const primary = lastClassify();
    assert.equal(primary.model, "liquid/d1-ultra");
    const s = await shadowLine(primary.id);
    assert.equal(s.what, "utterance");
    assert.equal(s.model, JEV);
    assert.deepEqual(s.answers, shadowAnswers);
    assert.deepEqual(s.handles.s2, { name: "clipkit", id: world.byName.get("clipkit")!.sessionId });
  });

  test("each kind has its own shadow, never the deciding model itself", () => {
    config.shadowModel = SHADOW;
    config.utteranceShadowModel = JEV;
    assert.equal(shadowModelFor("utterance", "liquid/d1-ultra"), JEV);
    assert.equal(shadowModelFor("stop", JEV), SHADOW);
    // The classifier back on your words with the classifier as their shadow: no point asking it twice.
    assert.equal(shadowModelFor("utterance", JEV), "");
    config.utteranceShadowModel = "";
    assert.equal(shadowModelFor("utterance", "liquid/d1-ultra"), "");
    assert.equal(shadowModelFor("stop", JEV), SHADOW);
  });

  test("stop decisions stay on Jev with d1-ultra shadowing, while your words go to d1-ultra", async () => {
    config.shadowModel = SHADOW;
    config.utteranceShadowModel = JEV;
    const calls = stub(primaryStop, () => ok({ model: SHADOW, answers: STOP_ANSWERS, usage: { cost: 0 } }));
    await decideStop(STOP_INPUT);
    assert.deepEqual(calls.sort(), [JEV, SHADOW].sort());
    assert.equal(lastClassify().model, JEV);
    assert.equal((await shadowLine(lastClassify().id)).model, SHADOW);
  });

  const failures: Array<[string, ShadowBehaviour, RegExp]> = [
    ["an HTTP error", () => new Response("overloaded", { status: 503 }), /503: overloaded/],
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), /fetch failed/],
    [
      "a synchronous throw",
      () => {
        throw new Error("boom");
      },
      /boom/,
    ],
    ["a missing answer", () => ok({ model: SHADOW, answers: { needs_user: noul(0.5) } }), /didn't answer "worth_saying"/],
    ["a body that isn't JSON", () => new Response("<html>", { status: 200 }), /JSON/],
  ];
  for (const [what, behaviour, error] of failures) {
    test(`${what} from the shadow model leaves the classifier's answer as it is, and is logged`, async () => {
      stub(primaryStop, () => assert.fail("shadow asked"));
      const without = sameAnswer(await decideStop(STOP_INPUT));
      config.shadowModel = SHADOW;
      stub(primaryStop, behaviour);
      const withShadow = sameAnswer(await decideStop(STOP_INPUT));
      assert.deepEqual(withShadow, without);
      const s = await shadowLine(lastClassify().id);
      assert.match(s.error, error);
      assert.equal(s.answers, undefined);
    });
  }

  test("the classifier answers without waiting for a slow shadow model", async () => {
    config.shadowModel = SHADOW;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    stub(primaryStop, async () => {
      await slow;
      return ok({ model: SHADOW, answers: STOP_ANSWERS, usage: { cost: 0 } });
    });
    const d = await decideStop(STOP_INPUT);
    assert.equal(d.worthSaying, 0.9);
    const id = lastClassify().id;
    assert.equal(
      logLines().find((e) => e.event === "shadow" && e.id === id),
      undefined,
      "shadow logged before it answered",
    );
    release();
    assert.deepEqual((await shadowLine(id)).answers, STOP_ANSWERS);
  });

  test("when the classifier fails, it fails as before; the shadow still logs", async () => {
    config.shadowModel = SHADOW;
    stub(
      () => new Response("bad gateway", { status: 502 }),
      () => ok({ model: SHADOW, answers: STOP_ANSWERS, usage: { cost: 0 } }),
    );
    const before = logLines().length;
    await assert.rejects(decideStop(STOP_INPUT), /Jev 502: bad gateway/);
    for (
      let i = 0;
      i < 100 &&
      !logLines()
        .slice(before)
        .some((e) => e.event === "shadow");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const fresh = logLines().slice(before);
    assert.ok(fresh.some((e) => e.event === "shadow" && e.answers));
    assert.ok(!fresh.some((e) => e.event === "classify"));
  });
});

// ── Which model decides and which shadows, per kind (config.ts) ──────────────

/**
 * config.ts's decision models as a fresh process sees them with `env` (and no .env; no saved
 * settings unless `saved` is given). Shadowing is on only with the developer switch, KIKO_DEV_SHADOW=1.
 */
function modelsWith(env: Record<string, string>, saved?: Record<string, unknown>) {
  const script =
    "const { config: c } = await import(process.env.CONFIG_URL);" +
    "console.log(JSON.stringify({ classifier: c.classifierModel, utterance: c.utteranceModel, shadow: c.shadowModel, utteranceShadow: c.utteranceShadowModel }));";
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KIKO_)?(CLASSIFIER_MODEL|UTTERANCE_MODEL|SHADOW_MODEL|UTTERANCE_SHADOW_MODEL|DEV_SHADOW)$/.test(k)));
  const cwd = mkdtempSync(join(tmpdir(), "kiko-config-"));
  if (saved) writeFileSync(join(cwd, "settings.json"), JSON.stringify(saved));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: {
      ...clean,
      CONFIG_URL: new URL("../../../src/core/config.ts", import.meta.url).href,
      ...(saved && { KIKO_SETTINGS: join(cwd, "settings.json") }),
      ...env,
    },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

describe("classifier models per kind", () => {
  const JEV_ID = "typesafe/jev-1.14";
  const D1 = "liquid/d1-ultra";

  const DEV = { KIKO_DEV_SHADOW: "1" };

  test("by default Jev decides your words and finished turns, and nothing shadows them", () => {
    assert.deepEqual(modelsWith({}), { classifier: JEV_ID, utterance: JEV_ID, shadow: "", utteranceShadow: "" });
  });

  test("without the developer switch, shadowing stays off whatever KIKO_SHADOW_MODEL or saved settings say", () => {
    const off = { classifier: JEV_ID, utterance: JEV_ID, shadow: "", utteranceShadow: "" };
    assert.deepEqual(modelsWith({ KIKO_SHADOW_MODEL: D1, KIKO_UTTERANCE_SHADOW_MODEL: D1 }), off);
    assert.deepEqual(modelsWith({}, { shadowModel: D1, utteranceShadowModel: D1 }), off);
    assert.deepEqual(modelsWith({ KIKO_DEV_SHADOW: "0" }), off);
  });

  test("with the switch, both are shadowed by d1-ultra; saved settings still don't choose the shadow", () => {
    assert.deepEqual(modelsWith(DEV), { classifier: JEV_ID, utterance: JEV_ID, shadow: D1, utteranceShadow: D1 });
    assert.deepEqual(modelsWith(DEV, { shadowModel: "x/saved", utteranceShadowModel: "x/saved" }), {
      classifier: JEV_ID,
      utterance: JEV_ID,
      shadow: D1,
      utteranceShadow: D1,
    });
  });

  test("your words on d1-ultra: Jev shadows them", () => {
    assert.deepEqual(modelsWith({ ...DEV, KIKO_UTTERANCE_MODEL: D1 }), { classifier: JEV_ID, utterance: D1, shadow: D1, utteranceShadow: JEV_ID });
  });

  test("KIKO_SHADOW_MODEL=off turns all shadowing off; KIKO_UTTERANCE_SHADOW_MODEL=off only the one on your words", () => {
    for (const off of ["off", "", "none"]) {
      assert.deepEqual(modelsWith({ ...DEV, KIKO_SHADOW_MODEL: off }), { classifier: JEV_ID, utterance: JEV_ID, shadow: "", utteranceShadow: "" });
    }
    assert.deepEqual(modelsWith({ ...DEV, KIKO_UTTERANCE_SHADOW_MODEL: "off" }), { classifier: JEV_ID, utterance: JEV_ID, shadow: D1, utteranceShadow: "" });
  });

  test("each can be set on its own", () => {
    assert.deepEqual(modelsWith({ ...DEV, KIKO_UTTERANCE_MODEL: "x/a", KIKO_SHADOW_MODEL: "x/b", KIKO_UTTERANCE_SHADOW_MODEL: "x/c", KIKO_CLASSIFIER_MODEL: "x/d" }), {
      classifier: "x/d",
      utterance: "x/a",
      shadow: "x/b",
      utteranceShadow: "x/c",
    });
  });
});

// ── The report ──────────────────────────────────────────────────────────────

const ev = (event: string, data: Record<string, unknown> = {}) => ({ t: "2026-10-27T01:23:39.163Z", event, ...data });
const VOICE = "7c2e9a41-0000-0000-0000-000000000001";
const SNIP = "035529bc-0bc8-0d8e-0703-e61168667a6c";
const HANDLES = { s1: { name: "claude-code-speech", id: VOICE }, s2: { name: "clipkit", id: SNIP } };
// Your words as an older log has them ("jev" lines, before 2026-11-01); finished turns as a newer one ("classify"): the report reads both.
const words = (id: string, said: string, audience: [string, string], intent = "message") => [
  ev("transcript", { text: said }),
  ev("jev", {
    what: "utterance",
    id,
    model: "typesafe/jev-1.14",
    state: { user_said: said },
    answers: { audience: choice(audience[0], 0.8), intent: choice(intent, 1), app_parts: noul(0.1) },
    costUsd: 0.00006,
    ms: 300,
  }),
  ev("shadow", { what: "utterance", id, model: SHADOW, handles: HANDLES, answers: { audience: choice(audience[1], 0.9), intent: choice(intent, 1), app_parts: noul(0.2) }, costUsd: 0.00004, ms: 400 }),
];
const finished = (id: string, session: string, reply: string, classifier: [number, number], shadow: [number, number]) => [
  ev("hook_stop", { session_id: session, cwd: "/Users/me/git/clipkit", last_assistant_message: reply }),
  ev("classify", {
    what: "stop",
    id,
    model: "typesafe/jev-1.14",
    state: { claude_reply: reply },
    answers: { worth_saying: noul(classifier[0]), needs_user: noul(classifier[1]) },
    costUsd: 0.00005,
    ms: 250,
  }),
  ev("shadow", { what: "stop", id, model: SHADOW, answers: { worth_saying: noul(shadow[0]), needs_user: noul(shadow[1]) }, costUsd: 0.00005, ms: 500 }),
];

function sampleLog() {
  return [
    ev("start"),
    // Agree: both pick clipkit; the app replied to it.
    ...words("a1", "Yes, run them.", ["s2", "s2"]),
    ev("hook_answer", { kind: "Stop", sessionId: SNIP, reply: "Yes, run them." }),
    // Disagree on audience: the classifier picks the voice session, the shadow clipkit; the router typed it in.
    ...words("a2", "How many processes are running on my computer right now?", ["s1", "s2"]),
    ev("route_turn", { said: "", actions: 1 }),
    ev("ghostty_type", { terminalId: "T1", text: "How many processes?" }),
    // A turn read out: both say so.
    ...finished("b1", SNIP, "Tests pass. Want me to commit?", [0.9, 0.9], [0.8, 0.95]),
    ev("announce", { sessionId: SNIP, folder: "clipkit", windowMs: 15000 }),
    // A pleasantry: the classifier quiet, the shadow would read it out. Nothing announced.
    ...finished("b2", SNIP, "Sounds good!", [0.1, 0.1], [0.6, 0.2]),
    // The classifier answered, the shadow model failed; the classifier with no shadow line (shadow off); a shadow line with no classifier.
    ev("jev", { what: "stop", id: "c1", state: { claude_reply: "x" }, answers: {}, ms: 1 }),
    ev("shadow", { what: "stop", id: "c1", model: SHADOW, error: "503: overloaded", ms: 8000 }),
    ev("jev", { what: "stop", id: "c2", state: { claude_reply: "y" }, answers: {}, ms: 1 }),
    ev("shadow", { what: "stop", id: "c3", model: SHADOW, answers: STOP_ANSWERS, ms: 1 }),
    // Old lines without ids, and other decisions, are left out.
    ev("jev", { what: "stop", state: {}, answers: {} }),
    ev("jev", { what: "risk", id: "r1", answers: {} }),
  ];
}

describe("shadow report", () => {
  const file = R.parseLog(
    "a.jsonl",
    sampleLog()
      .map((e) => JSON.stringify(e))
      .join("\n") + "\nnot json\n",
  );

  test("pairs the deciding and shadow lines by id; counts failures and lone lines", () => {
    const { pairs, failed, primaryOnly, shadowOnly } = R.pairUp([file]);
    assert.deepEqual(
      pairs.map((p) => p.id),
      ["a1", "a2", "b1", "b2"],
    );
    assert.deepEqual(
      failed.map((f) => f.id),
      ["c1"],
    );
    assert.equal(primaryOnly, 1);
    assert.equal(shadowOnly, 1);
  });

  test("pairs only within a file", () => {
    const [primaryLines, shadowLines] = [sampleLog().filter((e) => e.event !== "shadow"), sampleLog().filter((e) => e.event === "shadow")];
    const { pairs } = R.pairUp([
      { name: "1", events: primaryLines },
      { name: "2", events: shadowLines },
    ]);
    assert.equal(pairs.length, 0);
  });

  test("agreement per question, at the app's thresholds", () => {
    const { rates, disagreements } = R.compare(R.pairUp([file]).pairs);
    const rate = (label: string) => rates.find((r) => r.label.startsWith(label))!;
    assert.deepEqual([rate("audience").agree, rate("audience").n], [1, 2]);
    assert.deepEqual([rate("intent").agree, rate("intent").n], [2, 2]);
    assert.deepEqual([rate("app parts").agree, rate("app parts").n], [2, 2]); // 0.1 and 0.2: both under 0.5
    assert.deepEqual([rate("worth saying").agree, rate("worth saying").n], [1, 2]); // 0.1 vs 0.6 across 0.3
    assert.deepEqual([rate("needs user").agree, rate("needs user").n], [2, 2]);
    assert.deepEqual([rate("read out").agree, rate("read out").n], [1, 2]);
    assert.deepEqual(
      disagreements.map((d) => d.pair.id),
      ["a2", "b2"],
    );
    assert.deepEqual(disagreements[0].diffs, [{ label: "audience", primary: "s1 claude-code-speech (0.80)", shadow: "s2 clipkit (0.90)" }]);
  });

  test("what the app did next", () => {
    const { pairs } = R.pairUp([file]);
    const did = Object.fromEntries(pairs.map((p) => [p.id, p.did]));
    assert.equal(did.a1, "replied to clipkit");
    assert.equal(did.a2, 'router (1 action) → typed "How many processes?" into a terminal');
    assert.equal(did.b1, "read out, 15s reply window");
    assert.equal(did.b2, "not read out");
  });

  test("latency and cost per model", () => {
    assert.equal(R.percentile([5, 1, 4, 2, 3], 50), 3);
    assert.equal(R.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
    const rows = R.costs(R.pairUp([file]).pairs);
    const shadowStop = rows.find((r) => r.side === "shadow" && r.what === "stop")!;
    assert.deepEqual([shadowStop.n, shadowStop.median, shadowStop.model], [2, 500, SHADOW]);
    // Dated names from the endpoint group with the plain one.
    assert.equal(R.modelOf({ event: "jev", t: "", model: "typesafe/jev-1.14-20261014" }), "typesafe/jev-1.14");
    assert.ok(Math.abs(shadowStop.totalUsd - 0.0001) < 1e-12);
  });

  test("the printed report has every part", () => {
    const text = R.report([file]);
    assert.match(text, /4 paired decisions \(2 utterances, 2 finished turns\)/);
    assert.match(text, /1 shadow call failed/);
    assert.match(text, /audience\s+50% {2}\(1\/2\)/);
    assert.match(text, /Disagreements \(2\)/);
    assert.match(text, /you said "How many processes are running on my computer right now\?"/);
    assert.match(text, /read out \(announce: results\): jev-1\.14 quiet · d1-ultra \(shadow\) read out/);
    assert.match(text, /your words: typesafe\/jev-1\.14 deciding, liquid\/d1-ultra shadowing \(2\)/);
    assert.match(text, /median {3}400ms/);
    assert.match(R.report([R.parseLog("empty.jsonl", "")]), /Nothing to compare yet/);
  });

  test("its thresholds are the ones the app acts on", () => {
    const app = readFileSync(join(import.meta.dirname, "../../../src/app/state.ts"), "utf8");
    assert.equal(Number(app.match(/const QUIET_WORTH = ([\d.]+)/)?.[1]), R.QUIET_WORTH);
    assert.equal(Number(app.match(/const QUIET_NEEDS_USER = ([\d.]+)/)?.[1]), R.QUIET_NEEDS_USER);
  });
});

describe("shadow report, d1-ultra deciding your words", () => {
  // Since the switch: your words decided by d1-ultra and shadowed by Jev, finished turns as before;
  // an older file has your words the other way round.
  const D1 = "liquid/d1-ultra";
  const JEV_ID = "typesafe/jev-1.14";
  const utter = (id: string, said: string, primary: [string, string, number], shadow: [string, string, number]) => [
    ev("transcript", { text: said }),
    ev("jev", {
      what: "utterance",
      id,
      model: primary[0],
      served: `${primary[0]}-20261015`,
      state: { user_said: said },
      answers: { audience: choice(primary[1], primary[2]), intent: choice("message", 1), app_parts: noul(0.1) },
      costUsd: 0.00004,
      ms: 480,
    }),
    ev("shadow", {
      what: "utterance",
      id,
      model: shadow[0],
      served: `${shadow[0]}-20261014`,
      handles: HANDLES,
      answers: { audience: choice(shadow[1], shadow[2]), intent: choice("message", 1), app_parts: noul(0.1) },
      costUsd: 0.00006,
      ms: 360,
    }),
  ];
  const now = R.parseLog(
    "new.jsonl",
    [
      ...utter("n1", "Stop clipkit.", [D1, "app", 0.85], [JEV_ID, "app", 0.47]),
      ...utter("n2", "Yeah, go ahead.", [D1, "s1", 0.9], [JEV_ID, "app", 0.52]),
      ev("hook_answer", { kind: "Stop", sessionId: VOICE, reply: "Yeah, go ahead." }),
      ...finished("n3", SNIP, "Tests pass. Want me to commit?", [0.9, 0.9], [0.8, 0.95]),
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  const before = R.parseLog(
    "old.jsonl",
    utter("o1", "Run the tests.", [JEV_ID, "s2", 0.9], [D1, "s2", 0.95])
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );

  test("pairs by id whichever model decided, and says which did, per kind", () => {
    const { pairs } = R.pairUp([before, now]);
    assert.deepEqual(
      pairs.map((p) => [p.id, R.modelOf(p.primary), R.modelOf(p.shadow)]),
      [
        ["o1", JEV_ID, D1],
        ["n1", D1, JEV_ID],
        ["n2", D1, JEV_ID],
        ["n3", "typesafe/jev-1.14", SHADOW],
      ],
    );
    assert.deepEqual(R.lineups(pairs), [
      { what: "utterance", primary: D1, shadow: JEV_ID, n: 2 },
      { what: "utterance", primary: JEV_ID, shadow: D1, n: 1 },
      { what: "stop", primary: "typesafe/jev-1.14", shadow: SHADOW, n: 1 },
    ]);
  });

  test("agreement and disagreements read the deciding model's answer as the one acted on", () => {
    const { rates, disagreements } = R.compare(R.pairUp([now]).pairs);
    const audience = rates.find((r) => r.label === "audience")!;
    assert.deepEqual([audience.agree, audience.n], [1, 2]);
    assert.deepEqual(
      disagreements.map((d) => d.pair.id),
      ["n2"],
    );
    assert.deepEqual(disagreements[0].diffs, [{ label: "audience", primary: "s1 claude-code-speech (0.90)", shadow: "app (0.52)" }]);
  });

  test("latency and cost per model and role, never lumped as Jev", () => {
    const rows = R.costs(R.pairUp([before, now]).pairs).filter((r) => r.what === "utterance");
    assert.deepEqual(
      rows.map((r) => [r.side, r.model, r.n, r.median]),
      [
        ["primary", D1, 2, 480],
        ["primary", JEV_ID, 1, 480],
        ["shadow", JEV_ID, 2, 360],
        ["shadow", D1, 1, 360],
      ],
    );
    assert.equal(rows[0].served, `${D1}-20261015`);
  });

  test("the printed report names the models", () => {
    const text = R.report([now]);
    assert.match(text, /your words: liquid\/d1-ultra deciding, typesafe\/jev-1\.14 shadowing \(2\)/);
    assert.match(text, /finished turns: typesafe\/jev-1\.14 deciding, liquid\/d1-ultra shadowing \(1\)/);
    assert.match(text, /audience: d1-ultra s1 claude-code-speech \(0\.90\) · jev-1\.14 \(shadow\) app \(0\.52\)/);
    assert.match(text, /d1-ultra, utterance +n {4}2 · median {3}480ms/);
    assert.match(text, /jev-1\.14 \(shadow\), utterance +n {4}2 · median {3}360ms/);
    assert.doesNotMatch(text, /\bJev\b/);
  });
});
