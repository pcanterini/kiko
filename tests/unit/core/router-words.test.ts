// The guard on the router's own words (src/core/router-words.ts, decide.ts routerWordsOr): a message
// it writes for a session is your words, turned direct at most, never more. The relay eval's failures
// (2026-11-07, 2026-11-16): "Give me a short answer." added, title words added, "The user asks …".
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { type Act, type DecideDeps, type DecideState, decide } from "../../../src/core/decide.ts";
import type { Action } from "../../../src/core/router.ts";
import { exactBits, routerWords } from "../../../src/core/router-words.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { makeWorld } from "../../support/fixtures.ts";

const check = (said: string, message: string, off: string[] = [], earlier: string[] = []) => routerWords({ message, said, off, earlier });

describe("routerWords: the router's message, as it may go", () => {
  test("a sentence of its own is left out", () => {
    assert.deepEqual(check("Ask Atlas what it thinks should be next.", "What do you think should be next? Give me a short recommendation.", ["Ask Atlas"]), {
      ok: true,
      text: "What do you think should be next?",
      cut: ["Give me a short recommendation."],
    });
    const r = check("Ask Bobby and Kikodev if either of them changed the SSH config.", "Did you change the SSH config? Let me know yes or no, and what changed if so.", ["Ask Bobby and Kikodev if"]);
    assert.ok(r.ok && r.text === "Did you change the SSH config?");
  });
  test("pronouns swapped and verbs turned around are the same words", () => {
    assert.ok(check("Tell Atlas to ask me before it deletes anything.", "Ask me before you delete anything.", ["Tell Atlas to"]).ok);
    assert.ok(check("Ask MintBox whether the notarization went through.", "Did the notarization go through?", ["Ask MintBox whether"]).ok);
    assert.ok(check("Ask Orbit how it plans to handle refunds.", "How do you plan to handle refunds?", ["Ask Orbit"]).ok);
  });
  test("a session named by what it is ('ask the new one') is the direction, not words to keep", () => {
    assert.deepEqual(check("what's the capital of Germany? ask the new one", "What is the capital of Germany?"), { ok: true, text: "What is the capital of Germany?", cut: [] });
    assert.ok(check("tell the other session to rerun the migration", "Rerun the migration.").ok);
    // Content said elsewhere still counts: "new" in the request itself.
    assert.equal(check("ask the new one to make a new branch", "Make a branch.").ok, false);
  });
  test("a sentence with a number or a 'not' you said is never the router's own, even for a part of your words", () => {
    const said = "Ask Atlas and Orbit what the timeout is, and tell Orbit to bump it to 45.";
    const part = routerWords({ message: "What is the timeout? Increase it to 45 seconds.", said, partial: true, names: ["atlas", "orbit"] });
    assert.ok(part.ok && part.text === "What is the timeout? Increase it to 45 seconds.");
    const neg = routerWords({ message: "What changed? Don't merge yet.", said: "Ask Atlas what changed and tell Orbit not to merge", partial: true, names: ["atlas", "orbit"] });
    assert.ok(neg.ok && neg.text === "What changed? Don't merge yet.");
    // Its own words still go: "Let me know yes or no."
    const own = routerWords({
      message: "Did you change the SSH config? Let me know yes or no.",
      said: "Ask Bobby and Kikodev if either of them changed the SSH config.",
      partial: true,
      names: ["bobby", "kikodev"],
    });
    assert.ok(own.ok && own.text === "Did you change the SSH config?");
  });
  test("words added inside a sentence: not as written", () => {
    const r = check("Ask Orbit how it plans to handle refunds.", "How do you plan to handle refunds for the billing webhooks?", ["Ask Orbit"]);
    assert.deepEqual(r, { ok: false, why: "adds words", added: ["billing", "webhooks"] });
    assert.equal(check("Ask the iOS one what the minimum version is.", "What's the minimum iOS version for the onboarding screens?", ["Ask the iOS one"]).ok, false);
    assert.equal(check("Ask Kikodev why my message for Bobby went to the quick check.", "The user asks why their message meant for Bobby went to the quick check.", ["Ask Kikodev"]).ok, false);
  });
  test("a number, path or command lost, a 'not' lost, or most of your words gone: not as written", () => {
    assert.equal(check("Ask Atlas to change the timeout in src/checkout/config.ts from 30 to 45 seconds.", "Change the checkout timeout from 30 to 45 seconds.").ok, false);
    assert.equal(check("Ask Atlas to look into it, but don't make any changes yet.", "Look into it and make the changes.").ok, false);
    assert.equal(check("Ask Juniper to fix the typo and merge it, and update the changelog and the screenshots.", "Fix the typo.").ok, false);
  });
  test("the sessions' names and the direction's words may go", () => {
    const said = "Ask Bobby and Kikodev if either of them changed the SSH config.";
    const message = "Did you change the SSH config? Let me know yes or no.";
    assert.equal(check(said, message).ok, false, "without the names: most of the words look lost");
    assert.deepEqual(routerWords({ message, said, names: ["bobby", "kiko", "dev", "kikodev"] }), { ok: true, text: "Did you change the SSH config?", cut: ["Let me know yes or no."] });
  });
  test("words for an earlier message it points to may come from it", () => {
    const said = "Forward that question to Atlas.";
    assert.ok(check(said, "What's the retry limit on webhooks?", [], ["you → orbit: What's the retry limit on webhooks?"]).ok);
    assert.equal(check(said, "What's the retry limit on webhooks? Keep it short.", [], ["you → orbit: What's the retry limit on webhooks?"]).ok, true);
  });
  test("exactBits: numbers, versions, paths, commands, identifiers", () => {
    assert.deepEqual(exactBits("Run git log --oneline -5 on main, set MAX_WORKERS to 8 in src/config.ts, v3.2.0, handleWebhook, the SSH key."), [
      "--oneline",
      "-5",
      "MAX_WORKERS",
      "8",
      "src/config.ts",
      "v3.2.0",
      "handleWebhook",
      "SSH",
    ]);
  });
});

// ── In decide() ────────────────────────────────────────────────────────────────────────────────
const W = makeWorld([
  { name: "atlas", title: "Checkout flow refactor", status: "idle", activeAgoS: 90 },
  { name: "harbor", title: "Staging deploy pipeline", status: "busy", activeAgoS: 30 },
  { name: "orbit", title: "Billing webhooks", status: "idle", activeAgoS: 1200 },
  { name: "Bobby", folder: "2026-01-20-internal", given: "Bobby", status: "idle", activeAgoS: 900 },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

async function run(text: string, router: (s: (name: string) => Session) => Action[], opts: Partial<DecideState> = {}) {
  const deps: DecideDeps = {
    utterance: async (): Promise<UtteranceDecision> => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1, appParts: 0.1, model: "test", costUsd: 0, ms: 1 }),
    approval: null,
    route: async () => ({ text: "", actions: router(S), claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }),
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  return decide(state, deps);
}
const typed = (acts: Act[]) => acts.flatMap((a) => (a.type === "send" ? [`send: ${a.text}`] : a.type === "ask" ? [`ask: ${a.message}`] : []));
const ask = (to: string, message: string) => (s: (name: string) => Session) => [{ name: "ask_session" as const, session: s(to), message }];

describe("decide(): the router's ask_session, checked", () => {
  test("its own sentence cut, the rest as it wrote it; logged", async () => {
    const d = await run("Ask Bobby what it needs from me to finish the backup setup.", ask("Bobby", "What do you need from me to finish the backup setup? Give me a short answer."));
    assert.deepEqual(typed(d.actions), ["ask: What do you need from me to finish the backup setup?"]);
    assert.deepEqual(
      d.guards?.map((g) => [g.rule, g.why, g.cut]),
      [["router_words", "cut", ["Give me a short answer."]]],
    );
  });
  test("words added: your own words go instead, the direction off", async () => {
    const d = await run("Ask Orbit how it plans to handle refunds.", ask("orbit", "How do you plan to handle refunds for the billing webhooks?"));
    assert.deepEqual(typed(d.actions), ["send: How do you plan to handle refunds?"]);
    assert.equal(d.guards?.[0].why, "adds words");
    const q = await run("Ask Orbit why handleWebhook throws on the invoice.paid event.", ask("orbit", "Why does the webhook handler throw on invoice.paid?"));
    assert.deepEqual(typed(q.actions), ["send: Why handleWebhook throws on the invoice.paid event?"]);
  });
  test("a reply to the waiting session: your words as said, never the router's", async () => {
    const waiting = { sessionId: S("harbor").sessionId, cwd: S("harbor").cwd };
    const d = await run("Yes, go ahead, but only on staging.", ask("harbor", "Go ahead with the staging deploy only."), { waiting });
    assert.deepEqual(typed(d.actions), ["send: Yes, go ahead, but only on staging."]);
    assert.equal(d.guards?.find((g) => g.rule === "router_words")?.why, "reply");
  });
  test("a correction with more: the ask is only that part, its own sentences cut", async () => {
    const lastSent = { sessionId: S("atlas").sessionId, folder: "atlas", text: "Is it deployed?" };
    const d = await run(
      "No, that's for Harbor, and also ask it whether the smoke tests passed.",
      (s) => [
        { name: "resend_to", session: s("harbor") },
        { name: "ask_session", session: s("harbor"), message: "Did the smoke tests pass? Give me a short answer." },
      ],
      { lastSent },
    );
    assert.deepEqual(typed(d.actions), ["ask: Did the smoke tests pass?"]);
  });
});
