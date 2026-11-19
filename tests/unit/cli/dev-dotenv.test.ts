// A checkout's .env for the command line (src/core/dev-env.ts): its KIKO_ values count as if the
// shell exported them in Kiko Dev (KIKO_ACCOUNTS=0 there turns `kiko-dev login`, `logout`,
// `account` and their help lines off; they're open by default), the shell's own winning; never put in the environment of
// what it starts; and the release (KIKO_FLAVOUR=release here) reads none. Every .env is a
// throwaway one of this test's (KIKO_ENV_FILE), never the repo's.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { NOT_OPEN_LINE } from "../../../src/core/account/account.ts";
import { kikoValues, loadDevEnv } from "../../../src/core/dev-env.ts";

const CLI = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const url = (path: string) => new URL(`../../../src/${path}`, import.meta.url).href;

/** A .env of its own, in a temp folder (a checkout's, as far as the app goes: KIKO_ENV_FILE). */
function dotenv(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "dotenv-")), ".env");
  writeFileSync(file, text);
  return file;
}

/** What `kiko-dev …` (or, with KIKO_FLAVOUR=release, `kiko …`) has in it: a bare environment, and `envFile`. */
function envFor(envFile: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: mkdtempSync(join(tmpdir(), "dotenv-home-")), // never the real ~/.config
    TMPDIR: process.env.TMPDIR,
    PATH: process.env.PATH,
    KIKO_SETTINGS: join(mkdtempSync(join(tmpdir(), "dotenv-settings-")), "settings.json"),
    KIKO_KEYCHAIN: "off",
    KIKO_ACCOUNT_URL: "http://127.0.0.1:1",
    KIKO_TMUX_SERVER: "kiko-test-dotenv-cli",
    KIKO_ENV_FILE: envFile,
    NODE_TEST_CONTEXT: "child",
    ...extra,
  };
}

const cli = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { encoding: "utf8", env, timeout: 30_000 });

const ACCOUNT_COMMANDS = ["login", "logout", "account"] as const;
/** Whether the account commands are open: each says more than the "not open yet" line, and the help lists them. */
function accountsOpen(env: NodeJS.ProcessEnv): boolean {
  const said = ACCOUNT_COMMANDS.map((command) => {
    const r = cli([command, ...(command === "login" ? ["--no-browser"] : [])], env);
    return r.stdout.trim();
  });
  const help = cli(["--help"], env).stdout;
  // The line's start: the release's names its own command (kiko, not kiko-dev).
  const notOpen = (line: string) => line.startsWith(NOT_OPEN_LINE.split(",")[0]!);
  const closed = said.every(notOpen) && !/^ {2}login /m.test(help);
  const open = !said.some(notOpen) && /^ {2}login {17}sign in to your Kiko account/m.test(help);
  assert.ok(open || closed, `the commands and the help disagree: ${JSON.stringify({ said, help })}`);
  return open;
}

describe("a checkout's .env, for the command line", () => {
  test("Kiko Dev: KIKO_ACCOUNTS=0 in .env closes login, logout, account and their help lines, as from the shell", () => {
    const file = dotenv("# accounts, for development\nKIKO_ACCOUNTS=0\n");
    assert.equal(accountsOpen(envFor(file)), false);
    assert.equal(accountsOpen(envFor(dotenv(""), { KIKO_ACCOUNTS: "0" })), false, "the same from the shell");
    assert.equal(accountsOpen(envFor(dotenv(""))), true, "neither: open, as released (name.ts ACCOUNTS_LIVE)");
  });

  test("the shell's value wins over .env's", () => {
    assert.equal(accountsOpen(envFor(dotenv("KIKO_ACCOUNTS=1\n"), { KIKO_ACCOUNTS: "0" })), false);
    assert.equal(accountsOpen(envFor(dotenv("KIKO_ACCOUNTS=0\n"), { KIKO_ACCOUNTS: "1" })), true);
  });

  test("the release ignores the same .env", () => {
    const file = dotenv("KIKO_ACCOUNTS=0\n");
    assert.equal(accountsOpen(envFor(file, { KIKO_FLAVOUR: "release" })), true);
    const script = "const r = await import(process.env.ROOT_URL); console.log(JSON.stringify(r.ENV_FILE));";
    const where = (flavour: Record<string, string>) =>
      JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...envFor(file, flavour), ROOT_URL: url("core/app-root.ts") }, encoding: "utf8" }));
    assert.equal(where({ KIKO_FLAVOUR: "release" }), null, "no .env at all for the release (core/config.ts reads none either)");
    assert.equal(where({}), file);
  });

  test("read as the shell's, never put in the environment (nothing started inherits it); FLAVOUR and ENV_FILE stay the environment's", () => {
    const file = dotenv("KIKO_ACCOUNTS=1\nKIKO_FLAVOUR=release\nKIKO_ENV_FILE=/elsewhere/.env\nKIKO_RELAY_URL=https://relay.example\nOPENROUTER_API_KEY=sk-or-test-not-a-key\n");
    const script = [
      "await import(process.env.DEV_ENV_URL);",
      "const { accountsLive } = await import(process.env.ENV_URL);",
      "const name = await import(process.env.NAME_URL);",
      "console.log(JSON.stringify({ live: accountsLive(), relay: name.envVar('RELAY_URL'), flavour: name.FLAVOUR, inEnv: Object.keys(process.env).filter((k) => /^KIKO_(ACCOUNTS|RELAY_URL)$|API_KEY/.test(k)), held: Object.keys(name.dotenvVars).sort() }));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...envFor(file), DEV_ENV_URL: url("core/dev-env.ts"), ENV_URL: url("core/env.ts"), NAME_URL: url("core/name.ts") },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), { live: true, relay: "https://relay.example", flavour: "dev", inEnv: [], held: ["KIKO_ACCOUNTS", "KIKO_RELAY_URL"] });
  });

  test("under the test runner, never the repo's .env: only one a test names", () => {
    const script = "const name = await import(process.env.NAME_URL); await import(process.env.DEV_ENV_URL); console.log(JSON.stringify(Object.keys(name.dotenvVars)));";
    const { KIKO_ENV_FILE: _, ...noFile } = envFor("");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...noFile, NAME_URL: url("core/name.ts"), DEV_ENV_URL: url("core/dev-env.ts") }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(out), []);
  });

  test("kikoValues and loadDevEnv: KIKO_ names only, none from no file", () => {
    assert.deepEqual(kikoValues("KIKO_ACCOUNTS=1\nKIKO_FLAVOUR=release\nOPENROUTER_API_KEY=x\nSTT=apple\n"), { KIKO_ACCOUNTS: "1" });
    const into: Record<string, string> = {};
    assert.deepEqual(loadDevEnv(null, into), []);
    assert.deepEqual(loadDevEnv(join(tmpdir(), "no-such-folder", ".env"), into), []);
    assert.deepEqual(loadDevEnv(dotenv("KIKO_SOUNDS=false\n"), into), ["KIKO_SOUNDS"]);
    assert.deepEqual(into, { KIKO_SOUNDS: "false" });
  });
});
