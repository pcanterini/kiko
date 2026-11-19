// Words for Kiko are never passed on (src/core/routing-rules.ts appWordsOff, saidToAppParts;
// decide.ts toAppLeftOut, routerWordsOr, decide's last check). The relay eval's failures
// (2026-11-16): "…, Kiko, don't change the colours" arrived with "Kiko,", the router folded "Kiko,
// read me just the summary" into its message ("Give me a short summary").
import "../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { type Act, type DecideDeps, type DecideState, decide } from "../../../src/core/decide.ts";
import { setSpokenName } from "../../../src/core/name.ts";
import type { Action } from "../../../src/core/router.ts";
import { appWordsOff, saidToAppParts } from "../../../src/core/routing-rules.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { makeWorld } from "../../support/fixtures.ts";

beforeEach(() => setSpokenName("Kiko"));
afterEach(() => setSpokenName(null));

describe("appWordsOff: what's plainly the app's, cut in code", () => {
  const cases: Array<[string, string | null]> = [
    ["Tell Atlas to run the tests, and Kiko, slow down when you read the results.", "Tell Atlas to run the tests."],
    ["Ask Juniper which screens are done. Kiko, read me just the summary.", "Ask Juniper which screens are done."],
    ["Tell Pixie to make the button bigger, Kiko, you don't need to read back the reply.", "Tell Pixie to make the button bigger."],
    ["Tell Atlas to run the migration, and Kiko, don't read the whole log out loud.", "Tell Atlas to run the migration."],
    // A "not" about something else: only the name goes, the instruction stays the session's.
    ["Tell Pixie to make the button bigger, Kiko, don't change the colours.", "Tell Pixie to make the button bigger, don't change the colours."],
    ["Ask Orbit to fix the retry. Kiko, never push to main.", "Ask Orbit to fix the retry. Never push to main."],
    ["Fix the header, and Kiko, don't touch the footer.", "Fix the header, and don't touch the footer."],
    // Left for the trim: not about the app's behaviour, no "not".
    ["Ask Orbit, hold on Kiko, let me think, which events it retries.", null],
    // Kiko as the work, not said to it.
    ["The Kiko overlay doesn't show the latest text.", null],
    ["Make Kiko's bars wider.", null],
  ];
  for (const [said, want] of cases) test(said, () => assert.equal(appWordsOff(said)?.text ?? null, want));
  test("saidToAppParts: from the openers to the end of the sentence", () => {
    assert.deepEqual(saidToAppParts("Ask Atlas for the diff, and Kiko, speak a bit faster."), ["and Kiko, speak a bit faster"]);
    assert.deepEqual(saidToAppParts("Ask Juniper which screens are done. Kiko, read me just the summary."), ["Kiko, read me just the summary"]);
  });
});

const W = makeWorld([
  { name: "atlas", title: "Checkout flow refactor", status: "idle", activeAgoS: 90 },
  { name: "juniper", title: "iOS onboarding screens", status: "idle", activeAgoS: 300 },
  { name: "pixie", title: "Pixie landing page", status: "idle", activeAgoS: 1500 },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, opts: { classifier?: { audience: string; confidence: number }; router?: (s: (n: string) => Session) => Action[]; says?: string; waiting?: string } = {}) {
  const seen = { router: 0, routed: [] as string[] };
  const deps: DecideDeps = {
    utterance: async (): Promise<UtteranceDecision> => {
      const c = opts.classifier ?? { audience: "app", confidence: 0.3 };
      return { audience: c.audience === "app" ? "app" : S(c.audience), audienceConfidence: c.confidence, intent: "message", intentConfidence: 1, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async (input) => {
      seen.router++;
      seen.routed.push(input.text);
      return { text: opts.says ?? "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: opts.waiting ? { sessionId: S(opts.waiting).sessionId, cwd: S(opts.waiting).cwd } : null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
  };
  return { d: await decide(state, deps), seen };
}
const typed = (acts: Act[]) => acts.flatMap((a) => (a.type === "send" ? [`send: ${a.text}`] : a.type === "ask" ? [`ask: ${a.message}`] : a.type === "say" ? [`say: ${a.text}`] : []));

describe("decide(): words for Kiko stay with the app", () => {
  test("cut in code, no model: the name and its part; a 'don't' for the session kept", async () => {
    const a = await run("Tell Pixie to make the button bigger, Kiko, don't change the colours.", { classifier: { audience: "pixie", confidence: 0.95 } });
    assert.deepEqual(typed(a.d.actions), ["send: Make the button bigger, don't change the colours."]);
    const b = await run("Tell Atlas to run the tests, and Kiko, slow down when you read the results.", { classifier: { audience: "atlas", confidence: 0.95 } });
    assert.deepEqual(typed(b.d.actions), ["send: Run the tests."]);
  });
  test("the router's message may not carry them: 'Kiko, read me just the summary' isn't 'Give me a short summary'", async () => {
    const said = "Ask Juniper which screens are done. Kiko, read me just the summary.";
    const r = await run(said, { router: (s) => [{ name: "ask_session", session: s("juniper"), message: "Which screens are done? Read me just the summary." }] });
    assert.deepEqual(typed(r.d.actions), ["ask: Which screens are done?"]);
    const folded = await run(said, { router: (s) => [{ name: "ask_session", session: s("juniper"), message: "Which screens are done, in just a summary?" }] });
    assert.deepEqual(typed(folded.d.actions), ["send: Which screens are done?"]);
  });
  test("nothing left for the session: nothing sent, the router answers it as the app's", async () => {
    const { d, seen } = await run("And, uh, Kiko, slow down when you read the results.", { classifier: { audience: "atlas", confidence: 0.95 }, says: "Okay." });
    assert.deepEqual(typed(d.actions), ["say: Okay."]);
    assert.equal(seen.router, 1);
    assert.ok(d.guards?.some((g) => g.rule === "app_words"));
  });
  test("a plain 'Okay.' to a session is its own: sent, the reply to the one waiting or typed (the app wasn't spoken to)", async () => {
    for (const said of ["Okay.", "Okay, please.", "Then."]) {
      const r = await run(said, { classifier: { audience: "atlas", confidence: 0.95 }, waiting: "atlas" });
      assert.deepEqual(typed(r.d.actions), [`send: ${said}`], said);
      assert.equal(r.seen.router, 0);
      assert.ok(!r.d.guards?.some((g) => g.rule === "app_words"));
    }
    const named = await run("Atlas, okay.", { classifier: { audience: "atlas", confidence: 0.95 } });
    assert.deepEqual(typed(named.d.actions), ["send: Okay."]);
  });
});
