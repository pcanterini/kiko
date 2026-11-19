// Cleaning up your words (src/core/cleanup.ts): the check that sends them as said whenever the model's
// tidy version isn't only your words minus fillers, the call itself with the network stubbed, and
// which of decide()'s paths send cleaned words (and that the clean-up starts before the classifier answers).
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { checkCleanup, cleanUp, cutFromCleaned, leftOut, type Cleanup } from "../../../src/core/cleanup.ts";
import { config } from "../../../src/core/config.ts";
import { decide, type Act, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { ON_OFF, SETTING_ABOUT, SETTING_GROUPS, choicesFor } from "../../../src/core/settings-options.ts";
import { CAST, makeWorld } from "../../support/fixtures.ts";

// A request as said, filler and a false start included, and the cleaned version that was approved.
const SAID = "Yeah, skip the renaming, uh, Changes, just check the error messages that I, uh, they just mentioned.";
const TIDY = "Yeah, skip the renaming changes. Just check the error messages they just mentioned.";

describe("checkCleanup: only your words, minus fillers", () => {
  test("fillers, a false start and punctuation: fine", () => {
    assert.equal(checkCleanup(SAID, TIDY), null);
    assert.equal(checkCleanup("Uh, I just checked, uh, Lacy. He works.", "I just checked Lacy. He works."), null);
    assert.equal(checkCleanup("it's it's a new colour scheme", "It's a new colour scheme."), null);
  });
  test("words run together by speech-to-text may be joined", () => {
    assert.equal(checkCleanup("Uh, tell clip kit to deploy", "Tell clipkit to deploy"), null);
  });
  test("a word added or reworded: as said", () => {
    assert.equal(checkCleanup("instead of, uh, running on every push", "instead of running it on every push"), "words changed");
    assert.equal(checkCleanup("if all it's doing, it's calling a script", "if all it's doing is calling a script"), "words changed");
    // A likely mishearing is still what was said: a question about "folders called Cloud Notes".
    assert.equal(checkCleanup("Check if there's any folders called Cloud Notes", "Check if there's any folders called Claude Notes"), "words changed");
  });
  test("reordered, translated or answered: as said", () => {
    assert.equal(checkCleanup("Run the tests, uh, then commit.", "Commit, then run the tests."), "words changed");
    assert.equal(checkCleanup("Uh, run the tests please.", "Ejecuta las pruebas, por favor."), "words changed");
    assert.equal(checkCleanup("Uh, what time is it?", "It's 6:23 pm."), "words changed");
  });
  test("much shorter, longer or empty: as said", () => {
    assert.equal(checkCleanup("Uh, look at the build logs and the test logs and tell me what failed.", "Tell me what failed."), "too much left out");
    assert.equal(checkCleanup("Run the tests.", "Run the tests. Run the tests."), "longer");
    assert.equal(checkCleanup("Uh, run the tests.", ""), "empty");
    assert.equal(checkCleanup("Uh, run the tests.", "..."), "empty");
  });
  test("a negation or a number dropped: as said", () => {
    assert.equal(checkCleanup("Uh, don't, uh, merge it into main yet.", "Merge it into main yet."), "dropped a negation or number");
    assert.equal(checkCleanup("Bump it to version 4, uh, today.", "Bump it to version, today."), "dropped a negation or number");
  });
});

describe("cutFromCleaned: the same parts cut from the cleaned words", () => {
  test("a phrase naming the session", () => {
    assert.equal(cutFromCleaned("Clipkit, cut a new dev build.", ["Clipkit,"], "Cut a, uh, new dev build."), "Cut a new dev build.");
  });
  test("a part the trim dropped, with the fillers inside it already gone", () => {
    const cleaned = "For the login page one. Let's actually rebase all the open branches onto main.";
    const kept = "Uh, let's uh, actually rebase all the open branches onto main.";
    assert.equal(cutFromCleaned(cleaned, ["Ah, for the login page one"], kept), "Let's actually rebase all the open branches onto main.");
  });
  test("a part the clean-up changed: null (the words go trimmed but as said)", () => {
    assert.equal(cutFromCleaned("For ClipKit, deploy it.", ["for clip kit"], "Deploy it."), null);
  });
});

test("leftOut lists the words the clean-up left out", () => {
  assert.deepEqual(leftOut(SAID, TIDY), ["uh", "that", "I", "uh"]);
});

describe("cleanUp: the call, with the network stubbed", () => {
  let reply: () => Promise<string> = async () => "";
  let calls = 0;
  const realFetch = globalThis.fetch;
  const realLlm = config.llm;
  before(() => {
    config.llm = "test/no-network"; // the OpenRouter path: plain fetch
    process.env.OPENROUTER_API_KEY = "unit-test-no-network";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const signal = init?.signal ?? undefined;
      const text = await Promise.race([reply(), new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      const chunks = [{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 500, completion_tokens: 40, cost: 0.00007 } }];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
    config.llm = realLlm;
    delete process.env.OPENROUTER_API_KEY;
  });

  test("a good answer is sent", async () => {
    reply = async () => TIDY;
    const c = await cleanUp(SAID);
    assert.deepEqual({ text: c.text, cleaned: c.cleaned, costUsd: c.costUsd }, { text: TIDY, cleaned: true, costUsd: 0.00007 });
  });
  test("quotes or a label around it are taken off", async () => {
    reply = async () => `Tidied: "${TIDY}"`;
    assert.equal((await cleanUp(SAID)).text, TIDY);
  });
  test("a suspicious answer: your words as said, and why", async () => {
    reply = async () => "Sure! Here's the cleaned version of your message about the status updates.";
    const c = await cleanUp(SAID);
    assert.deepEqual({ text: c.text, cleaned: c.cleaned, why: c.why }, { text: SAID, cleaned: false, why: "words changed" });
  });
  test("an error: your words as said", async () => {
    reply = async () => {
      throw new Error("503");
    };
    const c = await cleanUp(SAID);
    assert.equal(c.text, SAID);
    assert.equal(c.cleaned, false);
  });
  test("too slow (1.5s): your words as said", async () => {
    reply = () => new Promise(() => {});
    const c = await cleanUp(SAID);
    assert.deepEqual({ text: c.text, why: c.why }, { text: SAID, why: "timeout" });
    assert.ok(c.ms >= 1400 && c.ms < 2000, `${c.ms}ms`);
  });
  test("words with no filler and nothing said twice skip the call", async () => {
    calls = 0;
    for (const t of ["Yeah.", "No, that's fine.", "Go ahead and tell the ClipKit session to update the docs.", "I would like a dark mode."]) {
      assert.equal((await cleanUp(t)).text, t);
    }
    assert.equal(calls, 0);
    reply = async () => "Yeah.";
    assert.equal((await cleanUp("Uh, yeah.")).text, "Yeah.");
    reply = async () => "It's a new colour scheme.";
    assert.equal((await cleanUp("it's it's a new colour scheme")).text, "It's a new colour scheme.");
    reply = async () => "A banner that reads, back in five.";
    assert.equal((await cleanUp("A banner that reads, like, back in five.")).text, "A banner that reads, back in five.");
    assert.equal(calls, 3);
  });
});

describe("the setting", () => {
  test("on by default, an on/off row in Listening with its about text", async () => {
    assert.equal(config.cleanUp, true);
    assert.ok(SETTING_GROUPS.find((g) => g.title === "Listening")?.keys.includes("cleanUp"));
    assert.match(SETTING_ABOUT.cleanUp, /uh/);
    const { choices } = await choicesFor("cleanUp", { tts: "say", current: true });
    assert.deepEqual(choices, ON_OFF);
  });
});

// ── Which paths send cleaned words ────────────────────────────────────────────────────────

const WORLD = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy]);
const S = (name: string) => WORLD.byName.get(name)!;

type Opts = Partial<DecideState> & {
  classifier?: Partial<Omit<UtteranceDecision, "audience">> & { audience?: string };
  router?: (s: Map<string, Session>) => Action[];
  clean?: ((text: string) => Promise<Cleanup>) | null;
  trimmed?: { text: string; dropped: string[] };
};

/** decide() with the classifier, the router and the trim stubbed; the clean-up turns "uh, " into nothing. */
async function run(text: string, o: Opts = {}) {
  const order: string[] = [];
  const tidy = (t: string) => {
    const out = t.replace(/\b(uh|um),?\s*/gi, "");
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  const deps: DecideDeps = {
    utterance: async () => {
      order.push("classifier asked");
      await new Promise((r) => setTimeout(r, 20));
      order.push("classifier answered");
      const j = o.classifier ?? {};
      return {
        audience: j.audience && j.audience !== "app" ? S(j.audience) : "app",
        audienceConfidence: j.audienceConfidence ?? 0.9,
        intent: j.intent ?? "message",
        intentConfidence: j.intentConfidence ?? 0.95,
        appParts: j.appParts ?? 0.1,
        model: "test",
        costUsd: 0,
        ms: 20,
      };
    },
    approval: async () => ({ answer: "allow", confidence: 0.99, costUsd: 0, ms: 1 }),
    route: async () => ({ text: "", actions: o.router?.(WORLD.byName) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
    trim: o.trimmed ? async () => ({ ...o.trimmed!, costUsd: 0, ms: 1 }) : null,
    clean:
      o.clean === undefined
        ? async (t) => {
            order.push("clean asked");
            const out = tidy(t);
            return { text: out, cleaned: out !== t, costUsd: 0, ms: 5 };
          }
        : o.clean,
  };
  const state: DecideState = {
    text,
    sessions: WORLD.sessions,
    notes: WORLD.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...o,
  };
  const d = await decide(state, deps);
  return { d, order, act: d.actions[0] as Act };
}
const sent = (a: Act) => (a.type === "send" ? a.text : a.type === "ask" ? a.message : a.type === "start" ? a.prompt : `(${a.type})`);

describe("decide(): cleaned words go to sessions, nothing else changes", () => {
  test("starts before the classifier answers, not after", async () => {
    const { order } = await run("Uh, run the tests.", { classifier: { audience: "clipkit" } });
    assert.deepEqual(order.slice(0, 2), ["clean asked", "classifier asked"]);
  });
  test("the classifier's pick: cleaned, with what would have gone", async () => {
    const { act } = await run("Uh, run the tests.", { classifier: { audience: "clipkit" } });
    assert.equal(act.type, "send");
    assert.equal(sent(act), "Run the tests.");
    assert.deepEqual(act.type === "send" && act.cleaned, { said: "Uh, run the tests.", ms: 5 });
  });
  test("a reply to the waiting session: cleaned", async () => {
    const waiting = { sessionId: S("clipkit").sessionId, cwd: S("clipkit").cwd };
    const { act } = await run("Uh, yes do it.", { waiting, classifier: { audience: "clipkit" } });
    assert.equal(sent(act), "Yes do it.");
    // Without the classifier, the waiting one gets it: cleaned too.
    const off = await run("Uh, yes do it.", { waiting, classifier: { audienceConfidence: 0.1 }, router: (s) => [{ name: "pass_on", session: s.get("clipkit")! }] });
    assert.equal(sent(off.act), "Yes do it.");
  });
  test("the router's pass_on: cleaned", async () => {
    const { act } = await run("Uh, ask it to deploy.", { classifier: { audienceConfidence: 0.3 }, router: (s) => [{ name: "pass_on", session: s.get("clipkit")! }] });
    // "ask it to" is the direction to it, off (direction.ts).
    assert.equal(sent(act), "Deploy.");
  });
  test("a session named up front: cleaned, minus the name", async () => {
    const { act, order } = await run("Clipkit, uh, cut a new dev build.");
    assert.equal(sent(act), "Cut a new dev build.");
    assert.deepEqual(order, ["clean asked"]);
  });
  test("a part the trim cut as meant for the app: cut from the cleaned words too", async () => {
    const { act } = await run("Ah, for the clipkit one. Uh, run the tests.", {
      classifier: { audience: "clipkit", appParts: 0.9 },
      trimmed: { text: "Uh, run the tests.", dropped: ["Ah, for the clipkit one"] },
    });
    assert.equal(sent(act), "Run the tests.");
  });
  test("the setting off (no clean-up): your words as said", async () => {
    const { act } = await run("Uh, run the tests.", { classifier: { audience: "clipkit" }, clean: null });
    assert.equal(sent(act), "Uh, run the tests.");
    assert.equal(act.type === "send" && act.cleaned, undefined);
  });
  test("a clean-up that fails: your words as said", async () => {
    const { act } = await run("Uh, run the tests.", { classifier: { audience: "clipkit" }, clean: async () => Promise.reject(new Error("boom")) });
    assert.equal(sent(act), "Uh, run the tests.");
  });
  test("not what the router writes, nor renames, nor permission answers", async () => {
    const ask = await run("Uh, ask clipkit what's next.", {
      classifier: { audienceConfidence: 0.3 },
      router: (s) => [{ name: "ask_session", session: s.get("clipkit")!, message: "Uh, what's next?" }],
    });
    assert.equal(sent(ask.act), "Uh, what's next?");
    const start = await run("Uh, start a session in pixie to, uh, fix it.", {
      classifier: { audienceConfidence: 0.3 },
      router: () => [{ name: "start_session", project: "pixie", newProject: false, sessionName: "", prompt: "uh, fix it" }],
    });
    assert.equal(sent(start.act), "uh, fix it");
    const rename = await run("Uh, rename clipkit to, uh, kit.", {
      classifier: { audienceConfidence: 0.3 },
      router: (s) => [{ name: "rename_session", session: s.get("clipkit")!, newName: "uh kit" }],
    });
    assert.deepEqual(rename.act, { type: "rename", session: S("clipkit"), name: "uh kit" });
    const permission = await run("Uh, yes.", { waiting: { sessionId: S("clipkit").sessionId, cwd: S("clipkit").cwd, permission: "run: ls" } });
    assert.equal(permission.act.type, "permission");
    assert.deepEqual(permission.order, [], "no clean-up asked for a permission answer");
  });
  test("a resend sends what was sent before, as it was", async () => {
    const lastSent = { sessionId: S("clipkit").sessionId, folder: "clipkit", text: "Run the tests." };
    const { act } = await run("No, uh, that was for lacy platform.", { lastSent, classifier: { intent: "redirect", intentConfidence: 0.9, audience: "lacy-platform" } });
    assert.equal(act.type, "resend");
    assert.equal(act.type === "resend" && act.last.text, "Run the tests.");
  });
});
