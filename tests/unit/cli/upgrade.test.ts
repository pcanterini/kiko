// `kiko upgrade` and `kiko account billing` (src/upgrade-cli.ts): what each says, against a fake
// account server on a port of its own (tests/support/fake-account.ts) and a store in memory (never
// the Keychain); the plan picked with a fake prompt, the browser a fake `open`, Enter and Esc fake
// keys. Kiko Pro on sale only where a test says (`sale`); off, nothing about buying is there. No
// token is printed, nothing goes to the clipboard. Plain styles (no colour).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { accountCommand } from "../../../src/account-cli.ts";
import { Account } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { aiUse } from "../../../src/core/account/key-words.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { upgradeCommand, type UpgradeDeps } from "../../../src/upgrade-cli.ts";
import { billingPage, billingRefused, EMAIL, fakeAccountServer, happyScript, memoryStore, planJson, proJson, sessionAnswer, USER_CODE } from "../../support/fake-account.ts";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const CHECKOUT = "https://checkout.stripe.com/c/pay/cs_test_kiko";
const PORTAL = "https://billing.stripe.com/p/session/test_kiko";
const NONE = sessionAnswer({ plan: planJson({ plan: "none" }) });
const PRO = sessionAnswer({ plan: proJson() });

async function setUp(
  o: {
    sale?: boolean;
    signedIn?: boolean;
    /** GET /session's answers once signed in, in turn (the last kept). */
    sessions?: ReturnType<typeof sessionAnswer>[];
    /** The plan picked (its index), or null: Esc. */
    pick?: number | null;
    /** A clock of the test's own, each wait moving it on (a wait that runs out takes no time); the real one otherwise. */
    fakeClock?: boolean;
    /** Keys pressed once the payment is waited for. */
    press?: ("enter" | "esc")[];
    remote?: boolean;
    tty?: boolean;
    opens?: boolean;
  } = {},
) {
  const server = await fakeAccountServer(happyScript());
  servers.push(server);
  const mem = memoryStore();
  const file = join(mkdtempSync(join(tmpdir(), "upgrade-")), "account.json");
  let clock = 0;
  const account = new Account({
    store: mem.store,
    client: accountClient(server.url),
    file,
    ...(o.fakeClock ? { now: () => Date.UTC(2026, 10, 20, 12) + clock, sleep: async (ms: number) => void (clock += ms) } : { sleep: async () => {} }),
  });
  if (o.signedIn) {
    assert.equal((await account.signIn({ onCode: () => {} })).ok, true);
    server.calls.length = 0;
  }
  if (o.sessions) server.answer("session", ...o.sessions);
  const out: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const deps: UpgradeDeps = {
    live: true,
    sale: o.sale ?? true,
    account,
    out: (line) => void out.push(line),
    confirm: async () => false,
    ask: async () => null,
    tty: o.tty ?? true,
    open: async (url) => (opened.push(url), out.push(`open ${url}`), o.opens ?? true),
    waitForEnter: async (prompt) => (out.push(`${prompt}⏎`), true),
    remote: o.remote ?? false,
    phones: () => [],
    choosePlan: async () => {
      asked.push("plan");
      const i = o.pick === undefined ? 0 : o.pick;
      return i === null ? null : (["month", "year"] as const)[i];
    },
    keys: (on) => {
      const presses = [...(o.press ?? [])];
      let live = true;
      const next = () => {
        const key = presses.shift();
        if (!key || !live) return;
        on(key);
        setImmediate(next);
      };
      setImmediate(next);
      return () => {
        live = false;
      };
    },
  };
  return {
    server,
    mem,
    deps,
    out,
    opened,
    asked,
    run: (args: string[] = []) => upgradeCommand(args, deps),
    billing: (args: string[] = []) => accountCommand("account", ["billing", ...args], deps),
    text: () => out.join("\n"),
  };
}

describe("kiko upgrade", () => {
  test("signed in, no plan: the choice, checkout opened, the payment waited for (every 3 s), then Pro is on", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE, NONE, NONE, PRO] });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.asked, ["plan"]);
    assert.deepEqual(t.out, [
      `open ${CHECKOUT}`,
      "Opening checkout in your browser… (Enter if it didn't open)",
      "Waiting for payment… Esc to stop waiting (you can still pay; Kiko picks it up)",
      `✓ Kiko Pro is on. Renews 3 Dec. Manage it any time: ${COMMAND} account billing`,
    ]);
    assert.deepEqual(
      t.server.to("checkout").map((c) => c.body),
      [{ interval: "month" }],
    );
    assert.ok(t.server.to("session").length >= 3, "polled until Pro");
    assert.doesNotMatch(t.text(), /sess-test/);
  });

  test("the yearly plan picked: checkout for a year", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE, PRO], pick: 1 });
    assert.equal(await t.run(), 0);
    assert.deepEqual(
      t.server.to("checkout").map((c) => c.body),
      [{ interval: "year" }],
    );
  });

  test("not signed in: kiko login's flow first (the code, Enter, the plain link), then the checkout", async () => {
    const t = await setUp({ sessions: [NONE, NONE, PRO] });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.out.slice(0, 7), [
      "Kiko Pro is on your Kiko account: signing in first.",
      `! First copy your one-time code: ${USER_CODE}`,
      "By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).",
      "Press Enter to open https://account.kiko.sh/device in your browser... ⏎",
      "open https://account.kiko.sh/device",
      // A terminal: kiko login's keys while it waits (n, Esc).
      "Waiting for you to sign in. Press n for a new code, Esc to stop.",
      `✓ Signed in as ${EMAIL}`,
    ]);
    assert.equal(t.out.at(-1), `✓ Kiko Pro is on. Renews 3 Dec. Manage it any time: ${COMMAND} account billing`);
    assert.equal(t.server.to("checkout").length, 1);
  });

  test("already Pro: pointed to kiko account billing; nothing asked or opened", async () => {
    const t = await setUp({ signedIn: true, sessions: [PRO] });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.out, [`! You have Kiko Pro already. Manage it: ${COMMAND} account billing`]);
    assert.deepEqual([t.asked, t.opened, t.server.to("checkout").length], [[], [], 0]);
  });

  test("the server says already_pro (bought on another Mac meanwhile, or a payment failing): the billing page opened instead", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE] });
    t.server.answer("checkout", billingRefused("already_pro"));
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.opened, [PORTAL]);
    assert.equal(t.out.at(-1), "! You have Kiko Pro already: opened your billing page in the browser.");
    assert.equal(t.server.to("portal").length, 1);
    // Over SSH: its link.
    const ssh = await setUp({ signedIn: true, sessions: [NONE], remote: true });
    ssh.server.answer("checkout", billingRefused("already_pro"));
    assert.equal(await ssh.run(), 0);
    assert.equal(ssh.out.at(-1), `! You have Kiko Pro already. Manage it here: ${PORTAL}`);
  });

  test("Esc while waiting: stops waiting, and says the payment still counts", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE], press: ["esc"] });
    assert.equal(await t.run(), 0);
    assert.equal(t.out.at(-1), `Stopped waiting. If you pay, Kiko picks it up: ${COMMAND} account shows the plan.`);
  });

  test("Enter while waiting opens the checkout again", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE], press: ["enter", "esc"] });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.opened, [CHECKOUT, CHECKOUT]);
  });

  test("billing_unavailable: Kiko Pro isn't on sale yet", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE] });
    t.server.answer("checkout", billingRefused("billing_unavailable"));
    assert.equal(await t.run(), 1);
    assert.equal(t.out.at(-1), "! Kiko Pro isn't on sale yet.");
    assert.deepEqual(t.opened, []);
  });

  test("Esc on the plan's question: nothing more said (the prompt says it), no checkout", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE], pick: null });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.out, []);
    assert.equal(t.server.to("checkout").length, 0);
  });

  test("over SSH or --no-browser: the link printed to open on any device, nothing opened", async () => {
    for (const o of [
      { remote: true, args: [] },
      { remote: false, args: ["--no-browser"] },
    ]) {
      const t = await setUp({ signedIn: true, sessions: [NONE, PRO], remote: o.remote });
      assert.equal(await t.run(o.args), 0);
      assert.deepEqual(t.opened, []);
      assert.ok(t.out.includes(`Open this link to pay, on any device: ${CHECKOUT}`), t.text());
    }
  });

  test("a browser that won't open: the link said, still waited for", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE, PRO], opens: false });
    assert.equal(await t.run(), 0);
    assert.ok(t.out.includes(`! Couldn't open a browser. Open this link to pay: ${CHECKOUT}`), t.text());
    assert.match(t.out.at(-1)!, /^✓ Kiko Pro is on\./);
  });

  test("no terminal: it asks first, so it says to run it in one", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE], tty: false });
    assert.equal(await t.run(), 1);
    assert.equal(t.out.at(-1), `X ${COMMAND}: run ${COMMAND} upgrade in a terminal: it asks which plan first`);
  });

  test("not on sale (PRO_ON_SALE off): one line, nothing asked of the server", async () => {
    const t = await setUp({ sale: false, signedIn: true });
    assert.equal(await t.run(), 0);
    assert.deepEqual(t.out, ["Kiko Pro isn't on sale yet."]);
    assert.equal(t.server.calls.length, 0);
  });
});

describe("kiko account billing", () => {
  const CANCELLED = sessionAnswer({ plan: proJson({ cancelAt: Date.UTC(2026, 11, 3, 12), renewsAt: null }) });
  const YEARLY = sessionAnswer({ plan: proJson({ interval: "year", renewsAt: Date.UTC(2027, 10, 3, 12) }) });

  test("opens Stripe's billing page in the browser; not on Pro, nothing to wait for", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE] });
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.opened, [PORTAL]);
    assert.deepEqual(t.out, [`open ${PORTAL}`, "✓ Opened your billing page in the browser: the card, invoices and cancelling are there."]);
  });

  test("over SSH: the link printed", async () => {
    const t = await setUp({ signedIn: true, remote: true, sessions: [NONE] });
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.out, [`Open this link to manage billing, on any device: ${PORTAL}`]);
  });

  test("on Pro: the change waited for (every 3 s, against the plan as the page opened), then said: cancelled", async () => {
    const t = await setUp({ signedIn: true, sessions: [PRO, PRO, PRO, CANCELLED] });
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.out, [
      `open ${PORTAL}`,
      "✓ Opened your billing page in the browser: the card, invoices and cancelling are there.",
      "Waiting for changes… Esc to stop waiting",
      `✓ Kiko Pro is cancelled. It stays on until 3 Dec. Changed your mind? ${COMMAND} account billing`,
    ]);
    assert.equal(t.server.to("session").length, 4, "once as it opened, then polled until the change");
  });

  test("resumed: Kiko Pro renews again", async () => {
    const t = await setUp({ signedIn: true, sessions: [CANCELLED, CANCELLED, PRO] });
    assert.equal(await t.billing(), 0);
    assert.equal(t.out.at(-1), "✓ Kiko Pro renews again on 3 Dec.");
  });

  test("switched to yearly: Kiko Pro is now yearly, with its renewal's year", async () => {
    const t = await setUp({ signedIn: true, sessions: [PRO, YEARLY] });
    assert.equal(await t.billing(), 0);
    assert.equal(t.out.at(-1), "✓ Kiko Pro is now yearly. Renews 3 Nov 2027.");
  });

  test("the card updated only (no plan change): Esc stops quietly; 15 minutes too", async () => {
    const t = await setUp({ signedIn: true, sessions: [PRO], press: ["esc"] });
    assert.equal(await t.billing(), 0);
    assert.equal(t.out.at(-1), "Nothing changed on your plan.");
    const late = await setUp({ signedIn: true, sessions: [PRO], fakeClock: true });
    assert.equal(await late.billing(), 0);
    assert.equal(late.out.at(-1), "Nothing changed on your plan.");
    assert.ok(late.server.to("session").length >= 15 * 20, "every 3 s for 15 minutes");
  });

  test("no terminal (piped): the link, nothing waited for", async () => {
    const t = await setUp({ signedIn: true, tty: false, sessions: [PRO] });
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.out, [`Open this link to manage billing, on any device: ${PORTAL}`]);
  });

  test("nothing billed (no_billing): said, and how to get Pro only while it's on sale; Pro given by hand: no billing to manage", async () => {
    const t = await setUp({ signedIn: true, sessions: [NONE] });
    t.server.answer("portal", billingRefused("no_billing"));
    assert.equal(await t.billing(), 0);
    assert.equal(t.out.at(-1), `! Nothing is billed on this account yet: ${COMMAND} upgrade starts Kiko Pro.`);
    const off = await setUp({ sale: false, signedIn: true, sessions: [NONE] });
    off.server.answer("portal", billingRefused("no_billing"));
    assert.equal(await off.billing(), 0);
    assert.deepEqual(off.out, ["! Nothing is billed on this account, so there's no billing to manage."]);
    const comp = await setUp({ signedIn: true, sessions: [sessionAnswer({ plan: planJson({ plan: "pro" }) })] });
    comp.server.answer("portal", billingRefused("no_billing"));
    assert.equal(await comp.billing(), 0);
    assert.equal(comp.out.at(-1), "! Your Kiko Pro wasn't bought with a card here, so there's no billing to manage.");
  });

  test("not signed in: kiko login first; the server never asked", async () => {
    const t = await setUp();
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.out, [`Not signed in. ${COMMAND} login signs in first.`]);
    assert.equal(t.server.to("portal").length, 0);
  });

  test("PRO_ON_SALE off, accounts on: billing works all the same (managing isn't buying), and the wait too", async () => {
    const t = await setUp({ sale: false, signedIn: true, sessions: [PRO, CANCELLED] });
    assert.equal(await t.billing(), 0);
    assert.deepEqual(t.opened, [PORTAL]);
    assert.equal(t.server.to("portal").length, 1);
    assert.equal(t.out.at(-1), `✓ Kiko Pro is cancelled. It stays on until 3 Dec. Changed your mind? ${COMMAND} account billing`);
  });

  test("an unknown word after kiko account: what it has, in plain words", async () => {
    for (const sale of [true, false]) {
      const t = await setUp({ sale, signedIn: true });
      assert.equal(await accountCommand("account", ["foo"], t.deps), 1);
      assert.deepEqual(t.out, [`X ${COMMAND} account doesn't have "foo". Try: ${COMMAND} account, ${COMMAND} account billing, ${COMMAND} account delete`]);
      assert.equal(t.server.calls.length, 0);
    }
  });

  test("kiko account points to billing with Pro, on sale or not; to upgrade only on sale; the portal link is https only", async () => {
    for (const sale of [true, false]) {
      const t = await setUp({ sale, signedIn: true, sessions: [sessionAnswer({ plan: proJson() })] });
      assert.equal(await accountCommand("account", [], t.deps), 0);
      assert.match(t.text(), /^ {2}Plan: Kiko Pro \(monthly\) · renews 3 Dec · 31% of this month used\.$/m);
      assert.match(t.text(), /^ {2}12% this week · on track\.$/m);
      assert.match(t.out.at(-1)!, new RegExp(`${COMMAND} account billing manages Kiko Pro\\.$`));
    }
    const none = await setUp({ sale: false, signedIn: true, sessions: [NONE] });
    assert.equal(await accountCommand("account", [], none.deps), 0);
    assert.doesNotMatch(none.text(), /upgrade|billing/);
    const on = await setUp({ signedIn: true, sessions: [NONE] });
    assert.equal(await accountCommand("account", [], on.deps), 0);
    assert.match(on.out.at(-1)!, new RegExp(`${COMMAND} upgrade gets Kiko Pro\\.$`));
    const t = await setUp({ signedIn: true, sessions: [NONE] });
    t.server.answer("portal", billingPage("http://not-https.example/"));
    assert.equal(await t.billing(), 1);
    assert.deepEqual(t.opened, []);
  });

  test("kiko account with your own key and Pro paid for: Pro still shown, and why its allowance isn't used", async () => {
    const t = await setUp({ signedIn: true, sessions: [sessionAnswer({ plan: proJson() })] });
    t.deps.aiUse = (planRuns) => aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: ["openrouter"], planRuns });
    assert.equal(await accountCommand("account", [], t.deps), 0);
    assert.match(t.text(), /^ {2}Plan: Kiko Pro \(monthly\) · renews 3 Dec\.$/m);
    assert.match(t.text(), new RegExp(`^ {2}Your own OpenRouter key is in use, so Pro isn't being used\\. To use Pro: ${COMMAND} keys remove openrouter\\.$`, "m"));
    assert.match(t.text(), /^ {2}Keys: Your own OpenRouter key\.$/m);
  });

  test("kiko account with your Anthropic key routing and Pro paid for: Pro's month shown, and that Pro runs the quick checks", async () => {
    const t = await setUp({ signedIn: true, sessions: [sessionAnswer({ plan: proJson() })] });
    t.deps.aiUse = (planRuns) => aiUse({ llm: "haiku", classifier: true, keys: ["anthropic"], planRuns });
    assert.equal(await accountCommand("account", [], t.deps), 0);
    assert.match(t.text(), /^ {2}Plan: Kiko Pro \(monthly\) · renews 3 Dec · 31% of this month used\.$/m);
    assert.match(
      t.text(),
      new RegExp(`^ {2}12% this week · on track\\. Pro runs the quick checks; your own Anthropic key runs routing and summaries\\. To use Pro for both: ${COMMAND} keys remove anthropic\\.$`, "m"),
    );
    assert.match(t.text(), /^ {2}Keys: Your own Anthropic key for routing and summaries; Kiko Pro for quick checks\.$/m);
  });
});

describe("the help", () => {
  const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
  const env = {
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH,
    KIKO_SETTINGS: join(process.cwd(), "cli-settings.json"),
    KIKO_ENV_FILE: "", // never the repo's .env
    KIKO_KEYCHAIN: "off",
    KIKO_PRO: "0", // Pro off unless a test turns it on (the release has it on)
    KIKO_ACCOUNT_URL: "http://127.0.0.1:1",
    KIKO_ACCOUNTS: "1",
    NODE_TEST_CONTEXT: "child",
  };

  test("kiko help lists account billing whenever accounts are on, upgrade only while Pro is on sale; kiko upgrade off says so and exits 0", () => {
    const off = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
    assert.doesNotMatch(off.stdout, /upgrade/);
    assert.match(off.stdout, /^ {2}account billing {7}manage Kiko Pro \(card, invoices, cancelling\) in your browser$/m);
    const noAccounts = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: { ...env, KIKO_ACCOUNTS: "0" } });
    assert.doesNotMatch(noAccounts.stdout, /upgrade|billing/);
    const up = spawnSync(process.execPath, [cli, "upgrade"], { encoding: "utf8", env });
    assert.equal(up.status, 0, up.stderr);
    assert.equal(up.stdout.trim(), "Kiko Pro isn't on sale yet.");
    const on = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: { ...env, KIKO_PRO: "1" } });
    assert.match(on.stdout, /^ {2}upgrade {15}get Kiko Pro, Kiko's AI included: \$8\.99 a month or$/m);
    assert.match(on.stdout, /^ {24}\$89 a year \(tax included\); opens checkout in your browser$/m);
    assert.doesNotMatch(on.stdout, /plus tax/);
    assert.match(on.stdout, /^ {2}account billing {7}manage Kiko Pro \(card, invoices, cancelling\) in your browser$/m);
  });
});
