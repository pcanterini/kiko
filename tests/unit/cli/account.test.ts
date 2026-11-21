// `kiko login`, `kiko logout` and `kiko account` (src/account-cli.ts): what each says, against a
// fake account server on a port of its own (tests/support/fake-account.ts) and a store in memory
// (never the Keychain); login as gh's device flow runs it: the code first, Enter (a fake one) opening the plain approval link where the code is typed (a fake
// `open`), gh's line with the link over SSH, without a terminal or with --no-browser; logout
// asking first with a phone paired; and, while accounts aren't open, one line and exit 0. No
// token is ever printed. Plain styles (no colour) unless a test gives colour.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { PassThrough } from "node:stream";
import { aiUse } from "../../../src/core/account/key-words.ts";
import { accountCommand, LOGIN_WAIT_LINE, waitForEnter, type AccountDeps } from "../../../src/account-cli.ts";
import { styleOf } from "../../../src/ui/cli-style.ts";
import { Account, NOT_OPEN_LINE, SESSION_KEY, SIGNED_OUT_LINE } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import { codeRefused, EMAIL, fakeAccountServer, happyScript, memoryStore, PENDING, planJson, proJson, SESSION_TOKEN, sessionAnswer, SIGNED_OUT, USER_CODE } from "../../support/fake-account.ts";
import { existsSync } from "node:fs";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function setUp(
  o: {
    live?: boolean;
    remote?: boolean;
    phones?: string[];
    tty?: boolean;
    answer?: boolean;
    answers?: boolean[];
    typed?: (string | null)[];
    opens?: boolean;
    signedIn?: boolean;
    enter?: boolean;
    color?: boolean;
  } = {},
) {
  const server = await fakeAccountServer(happyScript());
  servers.push(server);
  const mem = memoryStore();
  const file = join(mkdtempSync(join(tmpdir(), "acct-cli-")), "account.json");
  const account = new Account({
    store: mem.store,
    client: accountClient(server.url),
    file,
    sleep: async () => {},
  });
  if (o.signedIn) {
    assert.equal((await account.signIn({ onCode: () => {} })).ok, true);
    server.calls.length = 0;
  }
  const out: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const prompts: string[] = [];
  /** Everything in order: lines, the Enter prompt ("<prompt>⏎"), the browser opened ("open <url>"). */
  const seen: string[] = [];
  const deps: AccountDeps = {
    live: o.live ?? true,
    account,
    out: (line) => void (out.push(line), seen.push(line)),
    confirm: async (q) => (asked.push(q), seen.push(`${q} [y/N]`), o.answers?.length ? o.answers.shift()! : (o.answer ?? false)),
    // Each line typed in turn (null: the input ended); none left is the input ending.
    ask: async (q) => {
      const typed = o.typed?.length ? o.typed.shift()! : null;
      asked.push(q);
      seen.push(`${q}${typed ?? "⌃D"}`);
      return typed;
    },
    tty: o.tty ?? true,
    open: async (url) => (opened.push(url), seen.push(`open ${url}`), o.opens ?? true),
    waitForEnter: async (prompt) => (prompts.push(prompt), seen.push(`${prompt}⏎`), o.enter ?? true),
    remote: o.remote ?? false,
    phones: () => o.phones ?? [],
    ...(o.color ? { style: styleOf(true) } : {}),
  };
  const run = (command: "login" | "logout" | "account", args: string[] = []) => accountCommand(command, args, deps);
  return { server, mem, deps, file, out, opened, asked, prompts, seen, run, text: () => out.join("\n") };
}

describe("while accounts aren't open (KIKO_ACCOUNTS=0)", () => {
  test("login, logout and account say so in a line, and exit 0; nothing asked of the server", async () => {
    for (const command of ["login", "logout", "account"] as const) {
      const t = await setUp({ live: false });
      assert.equal(await t.run(command), 0);
      assert.deepEqual(t.out, [NOT_OPEN_LINE]);
      assert.equal(t.server.calls.length, 0);
    }
    assert.match(NOT_OPEN_LINE, /^Kiko accounts aren't open yet/);
  });

  test("the real command: with KIKO_ACCOUNTS=0 `kiko-dev login` says the line and exits 0 and the help doesn't list them; by default they're open", () => {
    const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
    const env = {
      HOME: mkdtempSync(join(tmpdir(), "acct-home-")), // never the real ~/.config
      TMPDIR: process.env.TMPDIR,
      PATH: process.env.PATH,
      KIKO_SETTINGS: join(process.cwd(), "cli-settings.json"),
      KIKO_ENV_FILE: "", // never the repo's .env
      KIKO_KEYCHAIN: "off",
      KIKO_ACCOUNT_URL: "http://127.0.0.1:1",
      KIKO_ACCOUNTS: "0",
      NODE_TEST_CONTEXT: "child",
    };
    for (const command of ["login", "logout", "account"]) {
      const r = spawnSync(process.execPath, [cli, command], { encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), NOT_OPEN_LINE);
    }
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
    assert.doesNotMatch(help.stdout, /login/);
    const { KIKO_ACCOUNTS: _off, ...byDefault } = env;
    const open = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: byDefault });
    assert.match(open.stdout, /^ {2}login {17}sign in to your Kiko account/m);
    assert.match(open.stdout, /^ {2}login --no-browser {4}print the link and the code instead/m);
    assert.match(open.stdout, /^ {2}logout {16}sign this Mac out \(asks first when a phone is paired\)/m);
    assert.match(open.stdout, /^ {2}account {15}who's signed in, and the plan/m);
  });
});

describe("kiko login", () => {
  const LINK = "https://account.kiko.sh/device";
  // The plan, asked once signed in: none on the fake server's account, and how to start the trial.
  // The terms signing in accepts, dim right under the code (core/terms.ts agreeLine).
  const AGREE = "By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).";
  const TRIAL = "  Plan: none. Kiko's AI can run on your own OpenRouter key (kiko-dev keys set openrouter), or the free trial: kiko-dev setup starts it.";

  test("as gh: the code first, Enter opens the plain link (the code typed there), then authentication complete and who", async () => {
    const t = await setUp();
    assert.equal(await t.run("login"), 0);
    assert.deepEqual(t.seen, [
      `! First copy your one-time code: ${USER_CODE}`,
      AGREE,
      `Press Enter to open ${LINK} in your browser... ⏎`,
      `open ${LINK}`,
      "✓ Authentication complete.",
      `✓ Signed in as ${EMAIL}`,
      TRIAL,
    ]);
    // Never the link with the code in it: the code is typed on the page (gh's anti-phishing step).
    assert.deepEqual(t.opened, [LINK]);
    assert.doesNotMatch(t.opened[0], /user_code/);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    assert.doesNotMatch(t.text(), /sess-test/);
  });

  test("the code typed on the page: nothing polled before Enter; pending until the code shown is typed there, then approved", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING, PENDING, happyScript().token[0]);
    let polledAtEnter = -1;
    let typed = "";
    t.deps.waitForEnter = async (prompt) => ((polledAtEnter = t.server.to("token").length), t.seen.push(`${prompt}⏎`), true);
    t.deps.open = async (url) => {
      // You read the code off the terminal and type it on the page the link opens.
      typed = /one-time code: (\S+)$/.exec(t.out[0])?.[1] ?? "";
      t.opened.push(url);
      return true;
    };
    assert.equal(await t.run("login"), 0);
    assert.equal(polledAtEnter, 0, "nothing polled while the Enter prompt waits (as gh)");
    assert.equal(typed, USER_CODE);
    assert.deepEqual(t.opened, ["https://account.kiko.sh/device"]);
    assert.equal(t.server.to("token").length, 3, "pending twice, then approved");
    assert.equal(t.out.at(-2), `✓ Signed in as ${EMAIL}`);
  });

  test("over SSH, with no terminal, or --no-browser: gh's line with the plain link, nothing waited for or opened", async () => {
    for (const o of [{ remote: true }, { tty: false }, { args: ["--no-browser"] }]) {
      const t = await setUp(o);
      assert.equal(await t.run("login", "args" in o ? o.args : []), 0);
      assert.deepEqual(t.opened, [], "no browser opened");
      assert.deepEqual(t.prompts, [], "no Enter waited for");
      assert.deepEqual(t.out, [
        `! First copy your one-time code: ${USER_CODE}`,
        AGREE,
        `Open this URL to continue in your web browser: ${LINK}`,
        "✓ Authentication complete.",
        `✓ Signed in as ${EMAIL}`,
        TRIAL,
      ]);
    }
  });

  test("the browser not opening: gh's words for it, and the sign-in still waited for", async () => {
    const t = await setUp({ opens: false });
    assert.equal(await t.run("login"), 0);
    assert.deepEqual(t.out.slice(2, 4), [`! Failed opening a web browser at ${LINK}`, "  Please try entering the URL in your browser manually"]);
    assert.match(t.text(), /Signed in as name@example\.com/);
  });

  test("Ctrl+C at the Enter prompt: nothing opened, the sign-in stopped, nothing kept", async () => {
    const t = await setUp();
    const stop = new AbortController();
    t.deps.signal = stop.signal;
    // Ctrl+C: the SIGINT realDeps listens for aborts the signal, and the prompt's wait ends unanswered.
    t.deps.waitForEnter = async () => (stop.abort(), false);
    assert.equal(await t.run("login"), 1);
    assert.deepEqual(t.opened, []);
    assert.equal(t.server.to("token").length, 0);
    assert.equal(t.out.at(-1), "Sign-in stopped. Nothing changed.");
    assert.deepEqual(t.mem.kept, {});
  });

  test("in colour: the ! yellow, the code bold, the ✓ green, the email bold, the plan's name bold", async () => {
    const t = await setUp({ color: true });
    assert.equal(await t.run("login"), 0);
    assert.equal(t.out[0], `\x1b[33m!\x1b[39m First copy your one-time code: \x1b[1m${USER_CODE}\x1b[22m`);
    assert.equal(t.out[1], `\x1b[2m${AGREE}\x1b[22m`, "the terms dim");
    assert.equal(t.prompts[0], `\x1b[1mPress Enter\x1b[22m to open ${LINK} in your browser... `);
    assert.equal(t.out[2], "\x1b[32m✓\x1b[39m Authentication complete.");
    assert.equal(t.out[3], `\x1b[32m✓\x1b[39m Signed in as \x1b[1m${EMAIL}\x1b[22m`);
    assert.equal(t.out[4], TRIAL.replace("Plan: none.", "Plan: \x1b[1mnone\x1b[22m."));
  });

  test("a phone paired already: the server told, so the session never expires while it is", async () => {
    const t = await setUp({ phones: ["Alex's iPhone"] });
    assert.equal(await t.run("login"), 0);
    assert.deepEqual(
      t.server.to("phone").map((c) => c.body),
      [{ paired: true }],
    );
    const none = await setUp();
    assert.equal(await none.run("login"), 0);
    assert.equal(none.server.to("phone").length, 0);
  });

  test("a phone paired and the server down after the approval: signed in all the same", async () => {
    const t = await setUp({ phones: ["Alex's iPhone"] });
    t.server.answer("phone", { status: 503, json: { error: "unavailable" } });
    assert.equal(await t.run("login"), 0);
    assert.match(t.text(), /Signed in as name@example\.com/);
  });

  test("in a terminal, keys while it waits (said once the browser is open): n a new code at once, printed with its page and nothing opened again", async () => {
    const t = await setUp();
    let listening = 0;
    // n pressed as soon as keys are read.
    t.deps.keys = (on) => (listening++, on("n"), () => void listening--);
    assert.equal(await t.run("login"), 0);
    assert.deepEqual(t.seen.slice(0, 8), [
      `! First copy your one-time code: ${USER_CODE}`,
      AGREE,
      `Press Enter to open ${LINK} in your browser... ⏎`,
      `open ${LINK}`,
      LOGIN_WAIT_LINE,
      `! Here's a new code. Your one-time code: ${USER_CODE}`,
      `  Type it at ${LINK}`,
      "✓ Authentication complete.",
    ]);
    assert.equal(t.server.to("code").length, 2, "a second code asked for");
    assert.deepEqual(t.opened, [LINK], "opened once");
    assert.equal(listening, 0, "keys no longer read once it's over");
  });

  test("Esc (or Ctrl+C, a key while it waits) stops it: said, exit 1, nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING);
    t.deps.keys = (on) => (setImmediate(() => on("esc")), () => {});
    assert.equal(await t.run("login"), 1);
    assert.equal(t.out.at(-1), "Sign-in stopped. Nothing changed.");
    assert.deepEqual(t.mem.kept, {});
  });

  test("a code that runs out while it waits: a new one, said, and the sign-in goes on", async () => {
    const t = await setUp();
    t.server.answer("token", PENDING, { status: 400, json: { error: "expired_token" } }, happyScript().token[0]);
    assert.equal(await t.run("login"), 0);
    assert.ok(t.out.includes(`! The code ran out; here's a new one. Your one-time code: ${USER_CODE}`));
    assert.ok(t.out.includes(`  Type it at ${LINK}`));
    assert.deepEqual(t.opened, [LINK]);
    assert.match(t.text(), /Signed in as name@example\.com/);
  });

  test("the server out of reach (for the code, then a poll): still trying, said once each time, and on once it's back", async () => {
    const t = await setUp();
    t.server.answer("code", "drop", "drop", happyScript().code[0]);
    t.server.answer("token", "drop", "drop", "drop", "drop", "drop", "drop", happyScript().token[0]);
    assert.equal(await t.run("login"), 0);
    assert.equal(t.out[0], `! Can't reach kiko.sh, still trying…`);
    assert.equal(t.out[1], "Reached kiko.sh again. Waiting for you to sign in…");
    assert.equal(t.out.filter((l) => l === `! Can't reach kiko.sh, still trying…`).length, 2, "once for the code, once for the polls");
    assert.match(t.text(), /Signed in as name@example\.com/);
    assert.equal(t.server.to("token").length, 7, "well past the old five misses");
  });

  test("denied: said, exit 1, nothing kept", async () => {
    const t = await setUp();
    t.server.answer("token", { status: 400, json: { error: "access_denied" } });
    assert.equal(await t.run("login"), 1);
    assert.equal(t.out.at(-1), "X The sign-in was denied in the browser. Nothing changed.");
    assert.deepEqual(t.mem.kept, {});
  });

  test("signed in already: said, nothing asked; an unknown option refused", async () => {
    const t = await setUp({ signedIn: true });
    assert.equal(await t.run("login"), 0);
    assert.deepEqual(t.out, [`! Signed in as ${EMAIL} already. kiko-dev logout signs out first.`]);
    assert.equal(t.server.to("code").length, 0);
    assert.equal(await t.run("login", ["--browser"]), 1);
    assert.equal(t.out.at(-1), "X kiko-dev: login takes only --no-browser (not --browser)");
    // gh's --clipboard isn't kiko's: refused like any other.
    for (const flag of ["--clipboard", "-c"]) {
      assert.equal(await t.run("login", [flag]), 1);
      assert.equal(t.out.at(-1), `X kiko-dev: login takes only --no-browser (not ${flag})`);
    }
  });
});

describe("kiko logout", () => {
  test("no phone paired: signed out at once, nothing asked", async () => {
    const t = await setUp({ signedIn: true });
    assert.equal(await t.run("logout"), 0);
    assert.deepEqual(t.asked, []);
    assert.deepEqual(t.out, ["✓ Signed out on this Mac."]);
    assert.equal(t.server.to("signOut")[0].bearer, SESSION_TOKEN);
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("a phone paired: warned first, and No keeps it signed in; Yes signs out", async () => {
    const t = await setUp({ signedIn: true, phones: ["Alex's iPhone"], answer: false });
    assert.equal(await t.run("logout"), 0);
    assert.deepEqual(t.out, ["! Alex's iPhone is paired with this Mac. Your phone will lose access away from home (at home it keeps working).", "Nothing changed: still signed in."]);
    assert.deepEqual(t.asked, ["Sign out anyway?"]);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
    assert.equal(t.server.to("signOut").length, 0);

    const y = await setUp({ signedIn: true, phones: ["Alex's iPhone", "iPad"], answer: true });
    assert.equal(await y.run("logout"), 0);
    assert.match(y.out[0], /^! Alex's iPhone and iPad are paired with this Mac\. Your phone will lose access away from home/);
    assert.equal(y.out.at(-1), "✓ Signed out on this Mac.");
    assert.equal(y.mem.kept[SESSION_KEY], undefined);
  });

  test("a phone paired and no terminal to ask in: refused, still signed in", async () => {
    const t = await setUp({ signedIn: true, phones: ["Alex's iPhone"], tty: false, answer: true });
    assert.equal(await t.run("logout"), 1);
    assert.equal(t.out.at(-1), "X kiko-dev: run kiko-dev logout in a terminal: it asks first");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("offline: signed out here, and where the session there ends", async () => {
    const t = await setUp({ signedIn: true });
    await t.server.down();
    assert.equal(await t.run("logout"), 0);
    assert.deepEqual(t.out, [
      "✓ Signed out on this Mac.",
      "! kiko.sh couldn't be reached, so its session there ends by itself, or sign it out now on the account page: https://account.kiko.sh/account",
    ]);
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("not signed in: said", async () => {
    const t = await setUp();
    assert.equal(await t.run("logout"), 0);
    assert.deepEqual(t.out, ["Not signed in on this Mac."]);
  });
});

describe("kiko account", () => {
  test("signed in: who, since when, the plan (none: your own key, or the trial), and how to sign out", async () => {
    const t = await setUp({ signedIn: true });
    assert.equal(await t.run("account"), 0);
    assert.match(t.out[0], /^✓ Signed in as name@example\.com on this Mac, since \d+ \w+ \d{4}\.$/);
    assert.equal(t.out[1], "  Plan: none. Kiko's AI can run on your own OpenRouter key (kiko-dev keys set openrouter), or the free trial: kiko-dev setup starts it.");
    assert.equal(t.out.at(-1), "kiko-dev logout signs out; kiko-dev account delete deletes the account.");
  });

  test("the trial: its days left and the share of its usage used, as a percentage", async () => {
    const t = await setUp({ signedIn: true });
    t.server.answer("session", sessionAnswer({ plan: planJson({ daysLeft: 4, used: 0.31 }) }));
    assert.equal(await t.run("account"), 0);
    assert.match(t.out[1], /^ {2}Plan: free trial · 4 days left \(until \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\) · 31% of its usage used\.$/);
    assert.doesNotMatch(t.text(), /\$|0\.62/, "a share, never dollars");
  });

  test("the trial's last day, ended by time or by its usage, and Pro's month", async () => {
    const t = await setUp({ signedIn: true });
    t.server.answer("session", sessionAnswer({ plan: planJson({ daysLeft: 1, used: 0.9 }) }));
    await t.run("account");
    assert.match(t.out[1], /Plan: free trial · 1 day left .* · 90% of its usage used\./);
    t.out.length = 0;
    t.server.answer("session", sessionAnswer({ plan: planJson({ ended: "time" }) }));
    await t.run("account");
    assert.match(
      t.out[1],
      /^ {2}Plan: none\. Your free trial ended on \d{1,2} \w{3} \(its 7 days ran out\)\. Go on with your own OpenRouter key \(kiko-dev keys set openrouter\), free forever with no account\.$/,
    );
    t.out.length = 0;
    t.server.answer("session", sessionAnswer({ plan: planJson({ ended: "cap" }) }));
    await t.run("account");
    assert.match(t.out[1], /Your free trial ended \(its usage was used up\)\./);
    t.out.length = 0;
    t.server.answer("session", sessionAnswer({ plan: planJson({ plan: "pro", used: 0.12 }) }));
    await t.run("account");
    assert.equal(t.out[1], "  Plan: Kiko Pro · 12% of this month used.");
  });

  test("the server down: the plan as last known, said it couldn't check", async () => {
    const t = await setUp({ signedIn: true });
    t.server.answer("session", sessionAnswer({ plan: planJson({ daysLeft: 5, used: 0.2 }) }));
    await t.run("account");
    t.out.length = 0;
    await t.server.down();
    await t.run("account");
    assert.match(t.out[1], /Plan: free trial · 5 days left .* · 20% of its usage used\./);
    assert.match(t.text(), /Couldn't reach kiko\.sh to check/);
  });

  test("more than one Mac signed in: said, with where they're listed", async () => {
    const t = await setUp({ signedIn: true });
    t.server.answer("session", sessionAnswer({ macs: 2 }));
    assert.equal(await t.run("account"), 0);
    assert.ok(t.out.includes("  2 Macs are signed in to this account: https://account.kiko.sh/account lists them."));
  });

  test("the server down: still signed in, and said it couldn't check", async () => {
    const t = await setUp({ signedIn: true });
    await t.server.down();
    assert.equal(await t.run("account"), 0);
    assert.match(t.out[0], /^✓ Signed in as name@example\.com/);
    assert.match(t.text(), /^! Couldn't reach kiko\.sh to check: .*Still signed in\.$/m);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("revoked on the server: signed out, with the one line; the next login works", async () => {
    const t = await setUp({ signedIn: true });
    t.server.answer("session", SIGNED_OUT);
    assert.equal(await t.run("account"), 0);
    assert.deepEqual(t.out, [`! ${SIGNED_OUT_LINE}`]);
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
    t.out.length = 0;
    assert.equal(await t.run("login"), 0);
    assert.match(t.text(), /Signed in as name@example\.com/);
  });

  test("not signed in: said, with what an account is for", async () => {
    const t = await setUp();
    assert.equal(await t.run("account"), 0);
    assert.match(t.out[0], /^Not signed in\. kiko-dev login signs in: an account is only for the free trial, and your own key needs none\.$/);
  });

  test("not signed in, with both keys and Haiku on Anthropic: which key does what, as Settings and the phone say it", async () => {
    const t = await setUp();
    t.deps.aiUse = (planRuns) => aiUse({ llm: "haiku", classifier: true, keys: ["anthropic", "openrouter"], planRuns });
    assert.equal(await t.run("account"), 0);
    assert.equal(t.out[1], "  Keys: Your own keys: Anthropic for routing and summaries, OpenRouter for quick checks.");
  });

  test("signed in, no plan, your OpenRouter key: plainly no plan, then the key (no advice to add one)", async () => {
    const t = await setUp({ signedIn: true });
    t.deps.aiUse = (planRuns) => aiUse({ llm: "anthropic/claude-haiku", classifier: true, keys: ["openrouter"], planRuns });
    assert.equal(await t.run("account"), 0);
    assert.equal(t.out[1], "  Plan: none.");
    assert.equal(t.out[2], "  Keys: Your own OpenRouter key.");
  });

  test("signed in, no plan and no key: the advice as before, and that the AI is off", async () => {
    const t = await setUp({ signedIn: true });
    t.deps.aiUse = (planRuns) => aiUse({ llm: null, classifier: true, keys: [], planRuns });
    assert.equal(await t.run("account"), 0);
    assert.match(t.out[1], /^ {2}Plan: none\. Kiko's AI can run on your own OpenRouter key/);
    assert.equal(t.out[2], "  Keys: None, so Kiko's AI is off.");
  });
});

describe("kiko account delete", () => {
  const WARNING = [
    `! This deletes your Kiko account, ${EMAIL}, and can't be undone:`,
    "  - the account, and the sign-in of every Mac on it: each is signed out",
    "  - its plan, its free trial and its usage records",
  ];

  test("as API.md's two steps: what goes said first and asked, a code from the email typed, deleted; the token and account.json gone", async () => {
    const t = await setUp({ signedIn: true, answer: true, typed: ["123 456"] });
    const file = t.file;
    assert.ok(existsSync(file));
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.deepEqual(t.seen, [
      ...WARNING,
      "  The free trial can't be claimed again with this email: one scrambled copy of it is kept, for that alone.",
      "  Your own keys and settings on this Mac stay, and Kiko works on your own OpenRouter key.",
      "Delete your Kiko account? [y/N]",
      `✓ Sent a 6-digit code to ${EMAIL}. It works for 5 minutes.`,
      "Code from the email: 123 456",
      "✓ Account deleted. Every Mac is signed out of it.",
      "  Kiko still works with your own OpenRouter key: kiko-dev keys set openrouter",
    ]);
    // The code asked for with the session token, then sent without its space, with it.
    assert.deepEqual(
      t.server.to("deleteCode").map((c) => c.bearer),
      [SESSION_TOKEN],
    );
    assert.deepEqual(
      t.server.to("delete").map((c) => [c.bearer, c.body]),
      [[SESSION_TOKEN, { code: "123456" }]],
    );
    assert.equal(t.mem.kept[SESSION_KEY], undefined, "the token out of the (fake) Keychain");
    assert.equal(existsSync(file), false, "account.json gone");
    assert.equal(t.deps.account.view().state, "signed-out");
    assert.doesNotMatch(t.text(), /sess-test/, "never printed");
  });

  test("a phone paired, and more than one Mac: both said in what goes", async () => {
    const t = await setUp({ signedIn: true, phones: ["Alex's iPhone"], answer: false });
    t.server.answer("session", sessionAnswer({ macs: 3 }));
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.ok(t.out.includes("  - the account, and the sign-in of every Mac on it (3 Macs): each is signed out"));
    assert.ok(t.out.includes("  - Alex's iPhone loses access away from home (at home it keeps working)"));
  });

  test("a paid Kiko Pro that renews: said it ends now with no refund, and to cancel instead to keep it; the confirm still follows", async () => {
    const t = await setUp({ signedIn: true, answer: false });
    t.deps.sale = true;
    t.server.answer("session", sessionAnswer({ plan: proJson({ renewsAt: Date.UTC(2026, 11, 3, 12) }) }));
    assert.equal(await t.run("account", ["delete"]), 0);
    const warn = "! Your Kiko Pro ends now, with no refund. To keep it until 3 Dec 2026, cancel instead: kiko-dev account billing.";
    const at = t.seen.indexOf(warn);
    assert.ok(at > 0, t.text());
    assert.equal(t.seen[at + 1], "Delete your Kiko account? [y/N]");
    assert.equal(t.out.at(-1), "Nothing changed: the account stays.");
    assert.equal(t.server.to("deleteCode").length, 0);

    // Not on sale: kiko account billing all the same (managing isn't buying).
    const u = await setUp({ signedIn: true, answer: false });
    u.server.answer("session", sessionAnswer({ plan: proJson({ interval: "year", renewsAt: Date.UTC(2027, 10, 4, 12) }) }));
    assert.equal(await u.run("account", ["delete"]), 0);
    assert.ok(u.out.includes("! Your Kiko Pro ends now, with no refund. To keep it until 4 Nov 2027, cancel instead: kiko-dev account billing."), u.text());
  });

  test("no Pro warning when there's nothing paid to keep: cancelled already, a payment failing, Pro given by hand, the trial", async () => {
    for (const plan of [
      proJson({ cancelAt: Date.UTC(2026, 11, 3, 12), renewsAt: null }),
      proJson({ failed: true, renewsAt: null, graceEndsAt: Date.now() + 86_400_000 }),
      planJson({ plan: "pro" }),
      planJson(),
    ]) {
      const t = await setUp({ signedIn: true, answer: false });
      t.deps.sale = true;
      t.server.answer("session", sessionAnswer({ plan }));
      assert.equal(await t.run("account", ["delete"]), 0);
      assert.doesNotMatch(t.text(), /no refund/);
      assert.ok(t.seen.includes("Delete your Kiko account? [y/N]"));
    }
  });

  test("No: nothing sent, nothing deleted, still signed in", async () => {
    const t = await setUp({ signedIn: true, answer: false });
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.equal(t.out.at(-1), "Nothing changed: the account stays.");
    assert.equal(t.server.to("deleteCode").length, 0);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("no terminal to ask in: what goes said, then refused, nothing sent", async () => {
    const t = await setUp({ signedIn: true, tty: false, answer: true });
    assert.equal(await t.run("account", ["delete"]), 1);
    assert.equal(t.out.at(-1), "X kiko-dev: run kiko-dev account delete in a terminal: it asks first");
    assert.equal(t.server.to("deleteCode").length, 0);
  });

  test("a wrong code: said, asked again; not 6 digits: said, never sent; nothing typed: nothing deleted", async () => {
    const t = await setUp({ signedIn: true, answer: true, typed: ["12345", "111111", "222222"] });
    t.server.answer("delete", codeRefused("invalid_code"), { json: { deleted: true } });
    assert.equal(await t.run("account", ["delete"]), 0);
    const after = t.seen.slice(t.seen.findIndex((l) => l.startsWith("Code from")));
    assert.deepEqual(after, [
      "Code from the email: 12345",
      "X The code is 6 digits.",
      "Code from the email: 111111",
      "X That code isn't right.",
      "Code from the email: 222222",
      "✓ Account deleted. Every Mac is signed out of it.",
      "  Kiko still works with your own OpenRouter key: kiko-dev keys set openrouter",
    ]);
    assert.equal(t.server.to("delete").length, 2);

    const u = await setUp({ signedIn: true, answer: true, typed: [""] });
    assert.equal(await u.run("account", ["delete"]), 0);
    assert.equal(u.out.at(-1), "Nothing changed: the account stays.");
    assert.equal(u.server.to("delete").length, 0);
    assert.equal(u.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("a code that ran out, or had too many tries: a new one sent when asked", async () => {
    const t = await setUp({ signedIn: true, answers: [true, true], typed: ["111111", "222222"] });
    t.server.answer("delete", codeRefused("expired_code"), { json: { deleted: true } });
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.ok(t.seen.includes("! That code ran out."));
    assert.ok(t.seen.includes("Send a new code? [y/N]"));
    assert.equal(t.server.to("deleteCode").length, 2);
    assert.match(t.out.at(-2)!, /Account deleted/);

    const u = await setUp({ signedIn: true, answers: [true, false], typed: ["111111"] });
    u.server.answer("delete", codeRefused("too_many_attempts"));
    assert.equal(await u.run("account", ["delete"]), 0);
    assert.ok(u.out.includes("! That code has had too many tries."));
    assert.equal(u.out.at(-1), "Nothing changed: the account stays.");
    assert.equal(u.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("too many codes asked for: when to try again, nothing deleted", async () => {
    const t = await setUp({ signedIn: true, answer: true });
    t.server.answer("deleteCode", { status: 429, json: { error: "rate_limited", error_description: "test" }, headers: { "retry-after": "600" } });
    assert.equal(await t.run("account", ["delete"]), 1);
    assert.equal(t.out.at(-1), "X kiko-dev: too many codes were asked for: try again in 10 minutes. Nothing changed.");
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("the server down, before or after the warning: nothing deleted, still signed in", async () => {
    const t = await setUp({ signedIn: true, answer: true });
    await t.server.down();
    assert.equal(await t.run("account", ["delete"]), 1);
    assert.match(t.out[0], /^X kiko-dev: couldn't reach kiko\.sh \(.*\)\. Nothing changed\.$/);
    assert.equal(t.mem.kept[SESSION_KEY], SESSION_TOKEN);

    const u = await setUp({ signedIn: true, answer: true, typed: ["123456"] });
    u.server.answer("delete", { status: 503, json: { error: "server_error" } });
    assert.equal(await u.run("account", ["delete"]), 1);
    assert.match(u.out.at(-1)!, /^X kiko-dev: couldn't reach kiko\.sh \(not deleted: .*\)\. Nothing changed\.$/);
    assert.equal(u.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("signed out on the server meanwhile: the one line, the token gone", async () => {
    const t = await setUp({ signedIn: true, answer: true });
    t.server.answer("deleteCode", SIGNED_OUT);
    assert.equal(await t.run("account", ["delete"]), 1);
    assert.equal(t.out.at(-1), `! ${SIGNED_OUT_LINE}`);
    assert.equal(t.mem.kept[SESSION_KEY], undefined);
  });

  test("not signed in: said, with the account page; something after delete: refused", async () => {
    const t = await setUp();
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.equal(t.out[0], "Not signed in on this Mac. kiko-dev login signs in first, or delete the account on its page: https://account.kiko.sh/account");
    assert.equal(t.server.calls.length, 0);
    assert.equal(await t.run("account", ["delete", "now"]), 1);
    assert.equal(t.out.at(-1), "X kiko-dev: account delete takes nothing after it (not now)");
  });

  test("accounts not open: the one line, nothing asked", async () => {
    const t = await setUp({ live: false, signedIn: true });
    assert.equal(await t.run("account", ["delete"]), 0);
    assert.deepEqual(t.out, [NOT_OPEN_LINE]);
    assert.equal(t.server.calls.length, 0);
  });
});

describe("in colour", () => {
  test("logout: the warning's ! yellow and the phone's name bold; account: ✓ green, the email and plan bold, the hint dim", async () => {
    const t = await setUp({ signedIn: true, phones: ["Alex's iPhone"], answer: true, color: true });
    assert.equal(await t.run("logout"), 0);
    assert.match(t.out[0], /^\x1b\[33m!\x1b\[39m \x1b\[1mAlex's iPhone\x1b\[22m is paired/);
    assert.equal(t.out.at(-1), "\x1b[32m✓\x1b[39m Signed out on this Mac.");

    const a = await setUp({ signedIn: true, color: true });
    assert.equal(await a.run("account"), 0);
    assert.match(a.out[0], /^\x1b\[32m✓\x1b\[39m Signed in as \x1b\[1mname@example\.com\x1b\[22m on this Mac/);
    assert.match(a.out[1], /^ {2}Plan: \x1b\[1mnone\x1b\[22m\./);
    assert.equal(a.out.at(-1), "\x1b[2mkiko-dev logout signs out; kiko-dev account delete deletes the account.\x1b[22m");
  });

  test("an error: the X red", async () => {
    const t = await setUp({ color: true });
    assert.equal(await t.run("account", ["now"]), 1);
    assert.equal(t.out[0], '\x1b[31mX\x1b[39m kiko-dev account doesn\'t have "now". Try: kiko-dev account, kiko-dev account billing, kiko-dev account delete');
  });
});

describe("the real Enter", () => {
  test("waitForEnter: the prompt written with no newline, true once a line comes in", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (c) => (written += c));
    const waiting = waitForEnter("Press Enter to open it... ", undefined, input, output);
    input.write("WDJB");
    input.write("\n");
    assert.equal(await waiting, true);
    assert.equal(written, "Press Enter to open it... ");
    assert.equal(input.listenerCount("data"), 0, "stops reading");
  });

  test("waitForEnter: Ctrl+C (the signal) ends it unanswered, its line ended; the input ending counts as Enter (gh's scanner)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (c) => (written += c));
    const stop = new AbortController();
    const waiting = waitForEnter("Press Enter... ", stop.signal, input, output);
    stop.abort();
    assert.equal(await waiting, false);
    assert.equal(written, "Press Enter... \n");
    const ended = new PassThrough();
    const eof = waitForEnter("Press Enter... ", undefined, ended, new PassThrough());
    ended.end();
    assert.equal(await eof, true);
  });
});
