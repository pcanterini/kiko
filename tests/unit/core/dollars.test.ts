// No dollar amounts on the subscription (src/core/dollars.ts, decided 2026-11-05): on your own keys
// the window's line, the full screen's header, the timing and info lines, the quick check's line and
// the summary at quit carry what Kiko cost, as ever; on the trial or Kiko Pro (Kiko's AI through the
// account's proxy), none of them does. The phone's `state` is in tests/unit/remote/presence.test.ts.
// The account is this test's own account.json (KIKO_SETTINGS' folder), never the real one; no Keychain.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

process.env.KIKO_STATE = join(process.cwd(), "state.json");
const { ACCOUNT_FILE } = await import("../../../src/core/account/account.ts");
const { costShown, dollarsFrom, dollarsShown, notePlanCall, showsDollars, usdShown } = await import("../../../src/core/dollars.ts");
const { pressDoneLine, quickCostNote, replyTimingLine, routeCostLine } = await import("../../../src/core/cost-lines.ts");
const { heldKeys } = await import("../../../src/core/key-values.ts");
const { sessionSummary, totals } = await import("../../../src/core/log.ts");
const { ui } = await import("../../../src/core/ui-store.ts");
const { aboutText, frameLines } = await import("../../../src/ui/classic.ts");
const { writeState } = await import("../../../src/app/status.ts");

const OWN = { ownKey: () => true, plan: () => false };
const PLAN = { ownKey: () => false, plan: () => true };
const DAY = 86_400_000;

afterEach(() => {
  dollarsFrom();
  delete process.env.KIKO_ACCOUNTS;
  delete process.env.OPENROUTER_API_KEY;
  delete heldKeys.OPENROUTER_API_KEY;
  rmSync(ACCOUNT_FILE, { force: true });
  ui.set({ cost: null });
});

describe("the rule", () => {
  test("dollars only when nothing this run is, or was, paid by the subscription", () => {
    assert.equal(dollarsShown({ ownKey: true, plan: false, planUsed: false }), true, "your own key");
    assert.equal(dollarsShown({ ownKey: true, plan: true, planUsed: false }), true, "your own key with Pro: your key runs the AI");
    assert.equal(dollarsShown({ ownKey: false, plan: false, planUsed: false }), true, "neither: nothing paid by a plan");
    assert.equal(dollarsShown({ ownKey: false, plan: true, planUsed: false }), false, "the trial or Pro, no key of yours");
    assert.equal(dollarsShown({ ownKey: true, plan: false, planUsed: true }), false, "a key added after the plan ran calls this run");
  });

  test("a call through the plan hides them for the rest of the run, a key of your own or not", () => {
    dollarsFrom(OWN);
    assert.equal(showsDollars(), true);
    notePlanCall();
    assert.equal(showsDollars(), false);
    assert.equal(usdShown(0.5), null);
    assert.equal(costShown(0.5), null);
  });
});

describe("the mode, from the key and account.json as the app reads them", () => {
  function onPlan(name: "trial" | "pro", endsAt: number | null) {
    process.env.KIKO_ACCOUNTS = "1";
    mkdirSync(dirname(ACCOUNT_FILE), { recursive: true });
    const plan = { name, startedAt: Date.now() - DAY, endsAt, quota: null };
    writeFileSync(ACCOUNT_FILE, JSON.stringify({ since: Date.now() - DAY, email: null, plan, trial: null }));
  }

  test("the trial with no key of yours: none; with your own OpenRouter key: shown", () => {
    onPlan("trial", Date.now() + 6 * DAY);
    assert.equal(showsDollars(), false);
    heldKeys.OPENROUTER_API_KEY = "sk-or-v1-test-0000";
    assert.equal(showsDollars(), true);
  });

  test("Kiko Pro with no key of yours: none", () => {
    onPlan("pro", null);
    assert.equal(showsDollars(), false);
  });

  test("the trial ended, no key: nothing is paid by the plan, shown; signed out, or accounts off: shown", () => {
    onPlan("trial", Date.now() - DAY);
    assert.equal(showsDollars(), true);
    rmSync(ACCOUNT_FILE, { force: true });
    assert.equal(showsDollars(), true);
    process.env.KIKO_ACCOUNTS = "0";
    assert.equal(showsDollars(), true);
  });
});

describe("each surface", () => {
  const usage = { input_tokens: 1200, output_tokens: 40 };

  test("the window's line and the full screen's header: $ on your own keys, none on the subscription", async () => {
    dollarsFrom(OWN);
    writeState();
    assert.equal(ui.state.cost, 0, "the app's own total, as a number");
    const state = (cost: number | null) => ({ ...ui.state, about: { voice: "george (Pocket)", model: "Haiku", hotkey: "right_option", pttMode: "hold", classifier: false }, macPlays: true, cost });
    assert.equal(aboutText(state(0.012) as never), "george (Pocket) · Haiku · $0.012");
    assert.match(frameLines(state(0.012) as never, 160, {}).bottom, /\$0\.012/);
    dollarsFrom(PLAN);
    writeState();
    assert.equal(ui.state.cost, null, "nothing to show, not 0");
    assert.equal(aboutText(state(null) as never), "george (Pocket) · Haiku");
    assert.doesNotMatch(frameLines(state(null) as never, 160, {}).bottom, /\$/);
  });

  test("the routing model's line", () => {
    dollarsFrom(OWN);
    assert.equal(routeCostLine("Haiku", 0.0012, usage), "Haiku: $0.0012 (1200→40 tok)");
    dollarsFrom(PLAN);
    assert.equal(routeCostLine("Haiku", 0.0012, usage), "Haiku: 1200→40 tok");
  });

  test("a press's timing line", () => {
    dollarsFrom(OWN);
    assert.equal(pressDoneLine("key up → done 1.20s", 0.001, 0.0123), "key up → done 1.20s · $0.0010 · total $0.012");
    dollarsFrom(PLAN);
    assert.equal(pressDoneLine("key up → done 1.20s", 0.001, 0.0123), "key up → done 1.20s");
  });

  test("a reply's timing line", () => {
    const head = "first token 0.40s · first sound 0.90s";
    dollarsFrom(OWN);
    assert.equal(replyTimingLine(head, 0.0021, "Haiku", usage, 0.0123), `${head} · $0.0021 (Haiku 1200→40 tok) · total $0.012`);
    dollarsFrom(PLAN);
    assert.equal(replyTimingLine(head, 0.0021, "Haiku", usage, 0.0123), `${head} · (Haiku 1200→40 tok)`);
  });

  test("the quick check's line", () => {
    dollarsFrom(OWN);
    assert.equal(quickCostNote(0.0312), " · $0.031");
    assert.equal(quickCostNote(null), "");
    dollarsFrom(PLAN);
    assert.equal(quickCostNote(0.0312), "");
  });

  test("the summary at quit", () => {
    totals.turns = 3;
    totals.llm = 0.02;
    assert.match(sessionSummary(true), /^session: 3 turns · LLM \$0\.020 .* total \$0\.020$/);
    assert.equal(sessionSummary(false), "session: 3 turns");
    totals.turns = 0;
    totals.llm = 0;
  });
});
