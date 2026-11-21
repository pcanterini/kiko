// Settings → Account drawn for real with Ink (src/ui/settings.ts), at 80 columns (the pane opened
// on its own) and 120 (beside the list), once per plan state: its label and value rows
// (settings-options.ts accountFacts, plan-words.ts planFacts), wrapped lines kept under the value
// column, yellow only on the values that warn, and the actions with their hints in one column.
// account.json is never read here: each state is the AccountView it would give. Every wait is for the
// frame showing what's expected (tests/support/ink.ts), never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Writable } from "node:stream";
import type { AccountRow, AccountView } from "../../../src/core/account/account.ts";
import type { Plan, Trial } from "../../../src/core/account/client.ts";
import type { SettingRow } from "../../../src/core/ui-store.ts";
import { inkDone, keyboard, plain, untilFrame } from "../../support/ink.ts";

// Colours on, so what's yellow can be told (each test file runs in a process of its own); then the
// modules that draw, which read it as they load.
process.env.FORCE_COLOR = "1";
const React = (await import("react")).default;
const { render } = await import("ink");
const { Settings } = await import("../../../src/ui/settings.ts");
const { ui } = await import("../../../src/core/ui-store.ts");
const { accountChoices, accountFacts } = await import("../../../src/core/settings-options.ts");
const { aiUse } = await import("../../../src/core/account/key-words.ts");
type AiUse = import("../../../src/core/account/key-words.ts").AiUse;

/** Made-up setups: what Kiko's AI runs on (key-words.ts aiUse), by the keys set and the model picked. */
const OPENROUTER_ONLY = aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: ["openrouter"], planRuns: false });
const BOTH_ON_ANTHROPIC = aiUse({ llm: "haiku", classifier: true, keys: ["anthropic", "openrouter"], planRuns: false });
const ANTHROPIC_ONLY = (planRuns: boolean) => aiUse({ llm: "haiku", classifier: true, keys: ["anthropic"], planRuns });

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 20, 12);
const DEC_3 = Date.UTC(2026, 11, 3, 12);
const NOV_27 = Date.UTC(2026, 10, 27, 12);

const trialPlan = (daysLeft: number, used: number): Plan => ({
  name: "trial",
  startedAt: now - DAY,
  endsAt: now + daysLeft * DAY - 60_000,
  quota: { period: "plan", periodEnd: null, usedShare: used, dailyCap: true, dailyResetsAt: null, pastCap: "stop" },
});
const proPlan = (used: number, terms: Partial<NonNullable<Plan["pro"]>> = {}): Plan => ({
  name: "pro",
  startedAt: now - DAY,
  endsAt: now + 300 * DAY,
  quota: { period: "month", periodEnd: DEC_3, usedShare: used, dailyCap: false, dailyResetsAt: null, pastCap: "stop" },
  pro: { interval: "month", renewsAt: DEC_3, cancelAt: null, paymentFailed: null, weekShare: 0.12, pace: "on_track", ...terms },
});
const endedTrial = (why: "time" | "cap"): Trial => ({ startedAt: Date.UTC(2026, 10, 3), endsAt: Date.UTC(2026, 10, 10, 12), ended: true, endedWhy: why });
const NO_PLAN: Plan = { name: "none", startedAt: null, endsAt: null, quota: null };

const signedIn = (plan: Plan | null, trial: Trial | null = null): AccountView => ({ state: "signed-in", email: "name@example.com", since: now, checkedAt: now, plan, trial });

/** The rows around it, as the real screen has them: Agents above, Keys below. */
const NEIGHBOURS: SettingRow[] = [
  { key: "agent:claude-code", label: "Claude Code", value: "Connected", raw: "{}", restart: false },
  { key: "key:openrouter", label: "OpenRouter key", value: "Not set", raw: "{}", restart: false },
];

/** Settings → Account's row for `view`, as app/settings/account.ts accountRows makes it. */
function accountRow(view: AccountView, o: { use?: AiUse; phones?: number; confirming?: boolean } = {}): SettingRow {
  const signed = view.state === "signed-in";
  const pro = signed && view.plan?.name === "pro";
  const raw: AccountRow = { signedIn: signed, confirming: signed && Boolean(o.confirming), phones: o.phones ?? 0, ...(pro ? { billing: true } : {}) };
  const value = signed ? (view.email ?? "Signed in") : view.revoked ? "Signed out on kiko.sh" : "Not signed in";
  const facts = accountFacts(view, { use: o.use ?? null, confirming: raw.confirming, now });
  return { key: "account", label: "Kiko account", raw: JSON.stringify(raw), value, restart: false, facts };
}

/**
 * The account's pane as drawn `width` wide: its lines below its title (the list beside it and the
 * frame left out, trailing blanks gone), and the text drawn in yellow. At 80 the pane is opened (Enter).
 */
async function pane(row: SettingRow, width: 80 | 120): Promise<{ lines: string[]; yellow: string[] }> {
  let raw = "";
  const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (raw = chunk.toString()) : null, done()) }) as Writable & { columns: number; rows: number };
  out.columns = width;
  out.rows = 40;
  const stdin = keyboard();
  const act = ui.act;
  ui.act = () => {};
  const s = { ...ui.state, screen: "settings" as const, settings: [NEIGHBOURS[0], row, NEIGHBOURS[1]], settingsAt: "account" as const };
  const app = render(React.createElement(Settings, { s, width, height: 24 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
  // The pane's actions come a frame after it's drawn (choicesFor is async): its last one, and at 80
  // (opened with Enter) the cursor on the first.
  const last = accountChoices(JSON.parse(String(row.raw))).at(-1)!.label;
  try {
    await inkDone(app);
    if (width === 80) stdin.write("\r");
    await untilFrame(
      () => plain(raw),
      (f) => f.includes(last) && (width === 120 || (f.includes("Settings › ") && f.includes("▸"))),
      `the pane's actions, down to ${last}`,
    );
  } finally {
    app.unmount();
    ui.act = act;
  }
  const yellow = [...raw.matchAll(/\x1b\[33m((?:[^\x1b]|\x1b\[(?!39m)[0-9;]*m)*)\x1b\[39m/g)].map((m) => plain(m[1]));
  const framed = plain(raw)
    .split("\n")
    .filter((l) => l.startsWith("│"));
  // 120: the right-hand pane (after the list's column), from under "Kiko account"; 80: inside the frame, under its title, above the hints.
  const lines =
    width === 120
      ? framed
          .map((l) => l.split("│"))
          .filter((parts) => parts.length === 4)
          .map((parts) => parts[2].slice(2).trimEnd())
      : framed.slice(1, -1).map((l) => l.slice(2, -1).trimEnd());
  if (width === 120) assert.equal(lines.shift(), "Kiko account", "the pane's title");
  else assert.match(plain(raw), /Settings › Kiko account/);
  while (lines.length && !lines.at(-1)) lines.pop();
  return { lines, yellow };
}

/** The actions under the rows: the first one picked at 80 (the pane open), none at 120 (the list has the cursor). */
const actions = (width: 80 | 120, ...lines: string[]) => ["", ...lines.map((l, i) => `${width === 80 && i === 0 ? "▸ " : "  "}  ${l}`)];

/** At both widths: the rows, then the actions, and what's drawn yellow. */
async function check(row: SettingRow, want: { rows: string[]; actions: string[]; yellow?: string[] }) {
  for (const width of [80, 120] as const) {
    const got = await pane(row, width);
    assert.deepEqual(got.lines, [...want.rows, ...actions(width, ...want.actions)], `${width} columns`);
    assert.deepEqual(got.yellow, want.yellow ?? [], `yellow at ${width} columns`);
  }
}

/** As check, for rows that wrap differently at 80 and 120 columns: the rows at each. */
async function checkEach(row: SettingRow, want: { 80: string[]; 120: string[]; actions: string[] }) {
  for (const width of [80, 120] as const) {
    const got = await pane(row, width);
    assert.deepEqual(got.lines, [...want[width], ...actions(width, ...want.actions)], `${width} columns`);
  }
}

const SIGN_OUT = "Sign out on this Mac  other Macs stay signed in";
const SIGN_IN = "Sign in   in your browser, with a code";
const BILLING = "Manage billing        card, invoices, cancelling · opens your browser";

describe("Settings → Account, every plan state at 80 and 120 columns", () => {
  test("signed out: plainly, Sign in below it, and that your own keys need no account", async () => {
    await check(accountRow({ state: "signed-out", revoked: false }), {
      rows: ["  Not signed in.", "  Your own keys never need an account."],
      actions: [SIGN_IN, "Leave it"],
    });
  });

  test("signed out on the server: said in yellow, Sign in right there", async () => {
    await check(accountRow({ state: "signed-out", revoked: true }), {
      rows: ["  Signed out on kiko.sh.", "  Your own keys never need an account."],
      actions: [SIGN_IN, "Leave it"],
      yellow: ["Signed out on kiko.sh."],
    });
  });

  test("trial running: its days left, and the share used", async () => {
    await check(accountRow(signedIn(trialPlan(6, 0.03))), {
      rows: ["  Signed in  name@example.com", "  Plan       Free trial · 6 days left", "  Used       3% of the trial"],
      actions: ["Leave it", SIGN_OUT],
    });
  });

  test("trial near its end: in its last two days the days are yellow; past 80% the share is", async () => {
    await check(accountRow(signedIn(trialPlan(2, 0.1))), {
      rows: ["  Signed in  name@example.com", "  Plan       Free trial · 2 days left", "  Used       10% of the trial"],
      actions: ["Leave it", SIGN_OUT],
      yellow: ["Free trial · 2 days left"],
    });
    await check(accountRow(signedIn(trialPlan(5, 0.85))), {
      rows: ["  Signed in  name@example.com", "  Plan       Free trial · 5 days left", "  Used       85% of the trial"],
      actions: ["Leave it", SIGN_OUT],
      yellow: ["85% of the trial"],
    });
  });

  test("trial ended (its days, or its usage): when, and how to go on, the command on its own line", async () => {
    const goOn = ["             To go on, add your own OpenRouter key (free):", "             kiko-dev keys set openrouter"];
    await check(accountRow(signedIn(NO_PLAN, endedTrial("time"))), {
      rows: ["  Signed in  name@example.com", "  Plan       Trial ended on 10 Nov", ...goOn],
      actions: ["Leave it", SIGN_OUT],
    });
    await check(accountRow(signedIn(NO_PLAN, endedTrial("cap"))), {
      rows: ["  Signed in  name@example.com", "  Plan       Trial ended: its usage was used up", ...goOn],
      actions: ["Leave it", SIGN_OUT],
    });
  });

  test("Pro renewing: when, then this month's share with the weekly pace; Manage billing", async () => {
    await check(accountRow(signedIn(proPlan(0.31))), {
      rows: ["  Signed in   name@example.com", "  Plan        Kiko Pro (monthly) · renews 3 Dec", "  This month  31% used · this week 12%, on track"],
      actions: ["Leave it", BILLING, SIGN_OUT],
    });
  });

  test("Pro near its month's allowance: the month in yellow, the pace said", async () => {
    await check(accountRow(signedIn(proPlan(0.85, { pace: "fast", weekShare: 0.4 }))), {
      rows: ["  Signed in   name@example.com", "  Plan        Kiko Pro (monthly) · renews 3 Dec", "  This month  85% used · this week 40%, faster than usual"],
      actions: ["Leave it", BILLING, SIGN_OUT],
      yellow: ["85% used · this week 40%, faster than usual"],
    });
  });

  test("Pro cancelled: when it ends, in yellow", async () => {
    await check(accountRow(signedIn(proPlan(0.31, { cancelAt: DEC_3, renewsAt: null }))), {
      rows: ["  Signed in   name@example.com", "  Plan        Kiko Pro (monthly) · ends 3 Dec", "  This month  31% used · this week 12%, on track"],
      actions: ["Leave it", BILLING, SIGN_OUT],
      yellow: ["Kiko Pro (monthly) · ends 3 Dec"],
    });
  });

  test("a payment failed: in yellow, and to update the card before Pro stops", async () => {
    await check(accountRow(signedIn(proPlan(0.31, { paymentFailed: { graceEndsAt: NOV_27 } }))), {
      rows: [
        "  Signed in   name@example.com",
        "  Plan        Kiko Pro (monthly) · payment failed",
        "              Update your card in Manage billing before Pro stops on 27 Nov.",
        "  This month  31% used · this week 12%, on track",
      ],
      actions: ["Leave it", BILLING, SIGN_OUT],
      yellow: ["Kiko Pro (monthly) · payment failed"],
    });
  });

  test("Pro over its month's allowance: paused until it renews, in yellow; your own key meanwhile", async () => {
    await check(accountRow(signedIn(proPlan(1))), {
      rows: [
        "  Signed in   name@example.com",
        "  Plan        Kiko Pro (monthly) · renews 3 Dec",
        "  This month  100% used · paused until 3 Dec",
        "              Your own OpenRouter key keeps Kiko going meanwhile:",
        "              kiko-dev keys set openrouter",
      ],
      actions: ["Leave it", BILLING, SIGN_OUT],
      yellow: ["100% used · paused until 3 Dec"],
    });
  });

  test("your own key, no plan: the plan, and the key in its own row", async () => {
    await check(accountRow(signedIn(NO_PLAN), { use: OPENROUTER_ONLY }), {
      rows: ["  Signed in  name@example.com", "  Plan       No plan", "  Keys       Your own OpenRouter key"],
      actions: ["Leave it", SIGN_OUT],
    });
  });

  test("your own key with a trial: the trial, that it isn't used, and the key", async () => {
    const top = ["  Signed in  name@example.com", "  Plan       Free trial · 6 days left"];
    await checkEach(accountRow(signedIn(trialPlan(6, 0.03)), { use: OPENROUTER_ONLY }), {
      80: [...top, "             Your own OpenRouter key is in use, so the free trial isn't", "             being used.", "  Keys       Your own OpenRouter key"],
      120: [...top, "             Your own OpenRouter key is in use, so the free trial isn't being", "             used.", "  Keys       Your own OpenRouter key"],
      actions: ["Leave it", SIGN_OUT],
    });
  });

  test("your own key with Pro (cancelled; a phone paired): Pro still shown with its colour, why it isn't used, and no month's share", async () => {
    await check(accountRow(signedIn(proPlan(0.31, { cancelAt: DEC_3, renewsAt: null })), { use: OPENROUTER_ONLY, phones: 1 }), {
      rows: [
        "  Signed in  name@example.com",
        "  Plan       Kiko Pro (monthly) · ends 3 Dec",
        "             Your own OpenRouter key is in use, so Pro isn't being used.",
        "             To use Pro: kiko-dev keys remove openrouter",
        "  Keys       Your own OpenRouter key",
      ],
      actions: ["Leave it", BILLING, "Sign out on this Mac  asks first: a phone is paired"],
      yellow: ["Kiko Pro (monthly) · ends 3 Dec"],
    });
  });

  test("signed out with both keys, Haiku on Anthropic routing: which key does what", async () => {
    const top = ["  Not signed in.", "  Your own keys never need an account."];
    await checkEach(accountRow({ state: "signed-out", revoked: false }, { use: BOTH_ON_ANTHROPIC }), {
      80: [...top, "  Keys  Your own keys: Anthropic for routing and summaries, OpenRouter for", "        quick checks"],
      120: [...top, "  Keys  Your own keys: Anthropic for routing and summaries, OpenRouter for quick", "        checks"],
      actions: [SIGN_IN, "Leave it"],
    });
  });

  test("your Anthropic key with Pro: Pro runs the quick checks, its month shown, and how to use it for both", async () => {
    await check(accountRow(signedIn(proPlan(0.31)), { use: ANTHROPIC_ONLY(true) }), {
      rows: [
        "  Signed in   name@example.com",
        "  Plan        Kiko Pro (monthly) · renews 3 Dec",
        "              Pro runs the quick checks; your own Anthropic key runs routing",
        "              and summaries.",
        "              To use Pro for both: kiko-dev keys remove anthropic",
        "  This month  31% used · this week 12%, on track",
        "  Keys        Your own Anthropic key for routing and summaries; Kiko Pro for",
        "              quick checks",
      ],
      actions: ["Leave it", BILLING, SIGN_OUT],
    });
  });

  test("signing out with a phone paired asks first, saying briefly what it does (a line without a label wraps across the pane)", async () => {
    await check(accountRow(signedIn(proPlan(0.31)), { phones: 1, confirming: true }), {
      rows: ["  Signed in  name@example.com", "  Sign out on this Mac?", "  Other Macs stay signed in. Your phone loses access away from home; at home", "  it keeps working."],
      actions: ["Sign out anyway", "Stay signed in"],
      yellow: ["Sign out on this Mac?"],
    });
  });

  test("a value or line too long for the pane wraps under the value column, never back under the label; yellow stays on the value", async () => {
    const row: SettingRow = {
      ...accountRow(signedIn(proPlan(0.31))),
      facts: [
        { label: "Signed in", value: "name@example.com" },
        {
          label: "Plan",
          value: "Kiko Pro · payment failed · and a few more words to make this one too long for 80",
          warn: true,
          more: ["A dim line under it that is also far too long to fit in sixty columns."],
        },
      ],
    };
    const at80 = await pane(row, 80);
    assert.deepEqual(at80.lines.slice(0, 5), [
      "  Signed in  name@example.com",
      "  Plan       Kiko Pro · payment failed · and a few more words to make this",
      "             one too long for 80",
      "             A dim line under it that is also far too long to fit in sixty",
      "             columns.",
    ]);
    assert.deepEqual(at80.yellow, ["Kiko Pro · payment failed · and a few more words to make this", "one too long for 80"]);
    // Beside the list the pane is a few columns wider: the break moves, the column doesn't.
    const at120 = await pane(row, 120);
    assert.deepEqual(at120.lines.slice(0, 4), [
      "  Signed in  name@example.com",
      "  Plan       Kiko Pro · payment failed · and a few more words to make this one",
      "             too long for 80",
      "             A dim line under it that is also far too long to fit in sixty",
    ]);
  });

  test("while Kiko Pro is on sale the phone needs the plan, so the confirm says it stops until this Mac signs in again", () => {
    process.env.KIKO_ACCOUNTS = "1";
    process.env.KIKO_PRO = "1";
    try {
      assert.deepEqual(accountFacts(signedIn(proPlan(0.31)), { use: null, confirming: true, now })[1].more, ["Other Macs stay signed in. Your phone stops working until this Mac signs in again."]);
    } finally {
      delete process.env.KIKO_ACCOUNTS;
      delete process.env.KIKO_PRO;
    }
  });

  test("accounts off: no Account row, so no section drawn", async () => {
    let raw = "";
    const out = new Writable({ write: (chunk, _enc, done) => (chunk.toString().trim() ? (raw = chunk.toString()) : null, done()) }) as Writable & { columns: number; rows: number };
    out.columns = 120;
    out.rows = 40;
    // On the Keys row (the Agents row here is only a name: no options of its own to load).
    const s = { ...ui.state, screen: "settings" as const, settings: NEIGHBOURS, settingsAt: "key:openrouter" as const };
    const app = render(React.createElement(Settings, { s, width: 120, height: 24 }), { stdout: out as never, stdin: keyboard() as never, patchConsole: false, interactive: true });
    try {
      // Drawn through: the Keys row's option (its raw says no Keychain) loaded beside the list.
      await untilFrame(
        () => plain(raw),
        (f) => f.includes("No Keychain here"),
        "the key's options",
      );
    } finally {
      app.unmount();
    }
    assert.match(plain(raw), /AGENTS/);
    assert.doesNotMatch(plain(raw), /ACCOUNT|Kiko account/);
  });
});
