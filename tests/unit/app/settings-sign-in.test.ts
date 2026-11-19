// Settings → Account's Sign in (src/app/settings/account.ts): `kiko login`'s device code flow
// (account-cli.ts followCode) in the pane, against a fake account server (tests/support/fake-account.ts)
// and a key store in memory: the code first, Open the browser (Enter) opening the page it's typed at
// (never the link with the code in it), the approval waited for, then "✓ Signed in as …" over the
// signed-in rows; Stop (Esc) and a denial changing nothing, and Stop once the approval is in signing
// in all the same; Copy the code copying exactly the code, the wait going on; accounts off, no row at
// all. No browser is opened (the opener is the test's own), nothing reaches the clipboard (the copier
// is the test's own too), and nothing reaches the Keychain or the real server. Every wait is for something to be so (a phase,
// a line said, a frame drawn), never a fixed time.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { Account } from "../../../src/core/account/account.ts";
import { accountClient } from "../../../src/core/account/client.ts";
import type { SettingRow } from "../../../src/core/ui-store.ts";
import { EMAIL, fakeAccountServer, happyScript, memoryStore, PENDING, SESSION_TOKEN, USER_CODE } from "../../support/fake-account.ts";
import { inkDone, keyboard, plain, untilFrame } from "../../support/ink.ts";
import { SLOW } from "../../support/until.ts";

process.env.FORCE_COLOR = "1";
const React = (await import("react")).default;
const { render } = await import("ink");
const { Settings } = await import("../../../src/ui/settings.ts");
const { ui } = await import("../../../src/core/ui-store.ts");
const { accountAction, accountRows, forgetAccountConfirm, setCopyText, setOpenUrl, useAccount } = await import("../../../src/app/settings/account.ts");
const { accountChoices, choicesFor } = await import("../../../src/core/settings-options.ts");

const PAGE = "https://account.kiko.sh/device";
/** The terms signing in accepts, by the code, as kiko login says them. */
const TERMS = "By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).";
const APPROVED = happyScript().token;

const server = await fakeAccountServer({ ...happyScript(), token: [PENDING] });
after(() => server.close());

let opened: string[] = [];
let copied: string[] = [];
let store: ReturnType<typeof memoryStore>;
let infos: string[] = [];
const info = ui.info;

beforeEach(() => {
  process.env.KIKO_ACCOUNTS = "1";
  opened = [];
  infos = [];
  setOpenUrl(async (url) => (opened.push(url), true));
  copied = [];
  setCopyText(async (text) => (copied.push(text), true));
  ui.info = (line: string) => void infos.push(line);
  server.answer("token", PENDING);
  store = memoryStore();
  useAccount(testAccount());
});

/** Polls a few milliseconds apart (the real wait is the server's interval), and Stop ends the wait at once. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, Math.min(ms, 15));
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
  });

/** An account on the fake server, with the test's store, a file of its own, and quick polls. */
const testAccount = () => new Account({ store: store.store, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "acct-")), "account.json"), sleep });

afterEach(() => {
  // Whatever the test left under way, stopped; then what it said let go.
  accountAction("stop");
  forgetAccountConfirm();
  forgetAccountConfirm();
  useAccount(undefined);
  ui.info = info;
  delete process.env.KIKO_ACCOUNTS;
});

const row = (): SettingRow => accountRows()[0];
const raw = () => JSON.parse(String(row().raw));
const values = () => accountChoices(raw()).map((c) => c.value);

async function until(what: () => boolean, label: string, ms = 5000) {
  const end = Date.now() + ms * SLOW;
  while (!what()) {
    if (Date.now() > end) assert.fail(`waited for ${label}: ${JSON.stringify(row().facts)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The account's pane at 80 columns (opened), as drawn: its lines under the title, trailing blanks gone. */
async function pane80(): Promise<string[]> {
  let last = "";
  const out = new Writable({ write: (chunk, _e, done) => (chunk.toString().trim() ? (last = plain(chunk.toString())) : null, done()) }) as Writable & {
    columns: number;
    rows: number;
  };
  out.columns = 80;
  out.rows = 30;
  const stdin = keyboard();
  const act = ui.act;
  ui.act = () => {};
  const s = { ...ui.state, screen: "settings" as const, settings: [row()], settingsAt: "account" as const };
  const app = render(React.createElement(Settings, { s, width: 80, height: 16 }), { stdout: out as never, stdin: stdin as never, patchConsole: false, interactive: true });
  try {
    await inkDone(app);
    // Enter opens the row's pane; its choices come a frame later (choicesFor is async): waited for, the cursor on the first.
    stdin.write("\r");
    await untilFrame(
      () => last,
      (f) => f.includes("Settings › ") && f.includes("▸"),
      "the pane opened, with its choices",
    );
  } finally {
    app.unmount();
    ui.act = act;
  }
  const lines = last
    .split("\n")
    .filter((l) => l.startsWith("│"))
    .slice(1, -1)
    .map((l) => l.slice(2, -1).trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

describe("Settings → Account → Sign in", () => {
  test("signed out: plainly, Sign in below it, your own keys dim; no `kiko login` line", async () => {
    assert.equal(row().value, "Not signed in");
    assert.deepEqual(row().facts, [{ value: "Not signed in.", more: ["Your own keys never need an account."] }]);
    assert.deepEqual(values(), ["signin", "keep"]);
    assert.deepEqual(await pane80(), ["  Not signed in.", "  Your own keys never need an account.", "", "▸   Sign in   in your browser, with a code", "    Leave it"]);
  });

  test("the code first; Enter opens the page it's typed at; the approval waited for; then signed in, the section refreshed", async () => {
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    assert.deepEqual(row().facts, [{ label: "Your code", value: USER_CODE, more: [`Enter opens ${PAGE}; type the code there.`, TERMS] }]);
    assert.deepEqual(values(), ["open", "copy", "stop"], "Open the browser first, so Enter opens it");
    assert.deepEqual(opened, [], "nothing opened before Enter");
    assert.equal(server.to("token").length, 0, "nothing polled before the browser");
    assert.deepEqual(await pane80(), [
      "  Your code  ABCD-EFGH",
      `             Enter opens ${PAGE}; type the code`,
      "             there.",
      "             By signing in, you agree to Kiko's Terms (kiko.sh/terms) and",
      "             Privacy Policy (kiko.sh/privacy).",
      "",
      "▸   Open the browser",
      "    Copy the code     to paste in the browser",
      "    Stop              nothing changes",
    ]);
    assert.equal((await choicesFor("account", { tts: "say", current: row().raw })).escape, "stop", "Esc stops it");

    accountAction("open");
    await until(() => raw().signing === "waiting", "the wait");
    assert.deepEqual(opened, [PAGE], "the plain page, never the link with the code in it");
    assert.deepEqual(row().facts, [{ label: "Your code", value: USER_CODE }, { value: "Waiting for you to approve in the browser… Esc to stop" }]);
    assert.deepEqual(values(), ["copy", "stop"]);
    await until(() => server.to("token").length > 1, "a few polls");

    server.answer("token", ...APPROVED);
    // Its end, as said: not the row's value, which account.json gives as soon as the approval is kept,
    // while the plan is still being asked for (and the pane still says it waits).
    await until(() => infos.includes(`(Signed in as ${EMAIL}.)`), "signed in");
    assert.equal(row().value, EMAIL);
    assert.deepEqual(row().facts?.slice(0, 2), [
      { value: `✓ Signed in as ${EMAIL}`, ok: true },
      { label: "Signed in", value: EMAIL },
    ]);
    assert.equal(raw().signing, undefined);
    assert.deepEqual(values(), ["keep", "signout"]);
    assert.ok(infos.includes(`(Signed in as ${EMAIL}.)`));
    assert.ok(store.kept["KIKO_ACCOUNT_SESSION"] ?? Object.values(store.kept).length, "the session kept in the store");
    // Settings closed: the ✓ line goes, the signed-in rows stay.
    forgetAccountConfirm();
    assert.deepEqual(row().facts?.[0], { label: "Signed in", value: EMAIL });
  });

  test("Stop (or Esc) while the code shows, or while waiting: nothing changes, Sign in offered again", async () => {
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    accountAction("stop");
    await until(() => raw().signing === undefined, "stopped");
    assert.deepEqual(opened, []);
    assert.deepEqual(row().facts, [{ value: "Not signed in.", more: ["Your own keys never need an account."] }]);
    assert.deepEqual(values(), ["signin", "keep"]);

    accountAction("signin");
    await until(() => raw().signing === "code", "the code again");
    accountAction("open");
    await until(() => raw().signing === "waiting", "the wait");
    accountAction("stop");
    await until(() => raw().signing === undefined, "stopped while waiting");
    assert.equal(row().value, "Not signed in");
    assert.ok(infos.includes("(Sign-in stopped. Nothing changed.)"));
  });

  test("Stop once the approval is in (the session being kept): signed in all the same, and said so, never 'Nothing changed'", async (t) => {
    // The store holds on to the session until the test lets it go: Stop lands in between.
    let keep: () => void = () => {};
    let keeping = false;
    const gate = new Promise<void>((resolve) => (keep = resolve));
    const set = store.store.set.bind(store.store);
    store.store.set = async (name, key) => ((keeping = true), await gate, set(name, key));
    t.after(keep);
    useAccount(testAccount());
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    server.answer("token", ...APPROVED);
    accountAction("open");
    await until(() => keeping, "the approval, being kept");
    accountAction("stop");
    assert.equal(raw().signing, "waiting", "past stopping: it goes on");
    keep();
    await until(() => infos.includes(`(Signed in as ${EMAIL}.)`), "signed in");
    assert.equal(row().value, EMAIL);
    assert.equal(store.kept.KIKO_ACCOUNT_SESSION, SESSION_TOKEN);
    assert.ok(!infos.some((l) => l.includes("Nothing changed")), "never 'Nothing changed' over a Mac signed in");
    assert.equal(server.to("signOut").length, 0, "the session not let go");
  });

  test("Copy the code: exactly the code copied, ✓ said under it, the sign-in still waiting; then the browser, and copied again", async () => {
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    assert.deepEqual(copied, [], "nothing copied before it's picked");
    accountAction("copy");
    await until(() => row().facts?.length === 2, "the ✓ line");
    assert.deepEqual(copied, [USER_CODE], "the code alone");
    assert.deepEqual(row().facts, [
      { label: "Your code", value: USER_CODE, more: [`Enter opens ${PAGE}; type the code there.`, TERMS] },
      { value: "✓ Code copied", ok: true },
    ]);
    assert.equal(raw().signing, "code", "still waiting for Open the browser");
    assert.deepEqual(values(), ["open", "copy", "stop"]);
    assert.deepEqual(opened, [], "copying opens nothing");

    accountAction("open");
    await until(() => raw().signing === "waiting", "the wait");
    assert.deepEqual(row().facts, [{ label: "Your code", value: USER_CODE }, { value: "✓ Code copied", ok: true }, { value: "Waiting for you to approve in the browser… Esc to stop" }]);
    accountAction("copy");
    await until(() => copied.length === 2, "copied again, while waiting");
    assert.deepEqual(copied, [USER_CODE, USER_CODE]);
    assert.equal(raw().signing, "waiting", "the wait goes on");
  });

  test("Copy the code that couldn't be (the copier failed, or threw): said plainly in yellow, never a crash, the sign-in going on", async () => {
    setCopyText(async () => false);
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    accountAction("copy");
    await until(() => row().facts?.length === 2, "the line");
    assert.deepEqual(row().facts?.[1], { value: "Couldn't copy the code: drag across it with Shift held (Option in iTerm2) to select it, or type it in.", warn: true });
    assert.equal(raw().signing, "code");
    // Picked again, through this time: the line says so.
    setCopyText(async () => true);
    accountAction("copy");
    await until(() => row().facts?.[1]?.ok === true, "copied");

    setCopyText(async () => {
      throw new Error("no clipboard here");
    });
    accountAction("open");
    await until(() => raw().signing === "waiting", "the wait");
    accountAction("copy");
    await until(() => row().facts?.[1]?.warn === true, "the line, while waiting");
    assert.deepEqual(row().facts?.[1], { value: "Couldn't copy the code: drag across it with Shift held (Option in iTerm2) to select it, or type it in.", warn: true });
    assert.equal(raw().signing, "waiting");
    // Stopped: no code, nothing to copy; the next sign-in starts with no copy line.
    accountAction("stop");
    await until(() => raw().signing === undefined, "stopped");
    assert.ok(!values().includes("copy"));
    accountAction("signin");
    await until(() => raw().signing === "code", "the code again");
    assert.equal(row().facts?.length, 1, "a new sign-in, no copy line");
  });

  test("denied in the browser: why, in yellow, over Not signed in; Sign in again", async () => {
    accountAction("signin");
    await until(() => raw().signing === "code", "the code");
    server.answer("token", { status: 400, json: { error: "access_denied" } });
    accountAction("open");
    await until(() => Boolean(row().facts?.[0].warn), "the denial");
    assert.deepEqual(row().facts, [
      { value: "The sign-in was denied in the browser. Nothing changed.", warn: true },
      { value: "Not signed in.", more: ["Your own keys never need an account."] },
    ]);
    assert.deepEqual(values(), ["signin", "keep"]);
  });

  test("signed out on the server: said in yellow, without `kiko login`: Sign in is right there", () => {
    const file = join(mkdtempSync(join(tmpdir(), "acct-")), "account.json");
    rmSync(file, { force: true });
    const a = new Account({ store: memoryStore().store, client: accountClient(server.url), file });
    useAccount(a);
    // As the account keeps it once the server said so.
    writeFileSync(file, JSON.stringify({ signedOut: { at: Date.now(), why: "revoked" } }));
    assert.equal(row().value, "Signed out on kiko.sh");
    assert.deepEqual(row().facts, [{ value: "Signed out on kiko.sh.", warn: true, more: ["Your own keys never need an account."] }]);
    assert.deepEqual(values(), ["signin", "keep"]);
  });

  test("accounts off (KIKO_ACCOUNTS=0): no row, nothing to sign in to", () => {
    process.env.KIKO_ACCOUNTS = "0";
    assert.deepEqual(accountRows(), []);
  });
});
