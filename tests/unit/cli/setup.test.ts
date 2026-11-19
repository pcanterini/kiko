// `kiko setup [agent]` (plain `kiko setup` is first-run setup: tests/unit/ui/onboarding.test.ts) and `kiko uninstall [agent]` (src/cli.ts): what they say before asking,
// that they never change anything without a terminal to ask in, and the agents they know, from the
// registry (src/agents/setup.ts). Claude Code's settings and Codex's home are this test's own
// (KIKO_CLAUDE_SETTINGS, CODEX_HOME), `claude` and `codex` on PATH are stand-ins that do nothing,
// and the y/N itself isn't typed here (the installers are tested in tests/unit/agents/hooks-install.test.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, test } from "node:test";
import { connectClaude } from "../../../src/agents/claude-code/setup.ts";

const CLI_TS = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kiko-setup-cli-"));
const bin = join(dir, "bin");
const claudeSettings = join(dir, "claude", "settings.json");
const codexHome = join(dir, "codex");
const settings = join(dir, "kiko-settings.json");
mkdirSync(bin);
for (const program of ["claude", "codex"]) writeFileSync(join(bin, program), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

function kiko(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI_TS, ...args], {
    encoding: "utf8",
    input: "y\n", // never read: no terminal, so nothing is asked
    env: {
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      KIKO_SETTINGS: settings,
      KIKO_CLAUDE_SETTINGS: claudeSettings,
      CODEX_HOME: codexHome,
      KIKO_T3_HOME: join(dir, "t3"),
      KIKO_ENV_FILE: "", // never the repo's .env
      KIKO_TMUX_SERVER: "kiko-test-setup-cli",
      NODE_TEST_CONTEXT: "child",
      ...extraEnv,
    },
  });
}

describe("kiko setup and uninstall", () => {
  beforeEach(() => {
    for (const f of [dirname(claudeSettings), codexHome, settings]) rmSync(f, { recursive: true, force: true });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("setup claude: says what it adds and where, then refuses without a terminal to ask in; nothing written", () => {
    const run = kiko(["setup", "claude"]);
    assert.equal(run.status, 1);
    assert.match(
      run.stdout,
      /^Claude Code: this adds Kiko's hook \(node .*claude-code-hook\.mjs\) to .*claude\/settings\.json on: Stop, PermissionRequest, SessionStart, SessionEnd, UserPromptSubmit, PermissionDenied, PreToolUse\./m,
    );
    assert.match(run.stdout, /Hooks already there stay as they are, and each file is backed up first\./);
    assert.match(run.stdout, /status line isn't added: it wraps your own statusLine command\. To use it, set it by hand \(.*statusline\/kiko-status\.mjs says how\)\./);
    assert.doesNotMatch(run.stdout, /README/, "no section a user's README doesn't have");
    // Said with the command of this copy: a checkout's, Kiko Dev's (src/core/name.ts COMMAND).
    assert.match(run.stderr, /run kiko-dev setup in a terminal: it asks before changing anything/);
    assert.equal(existsSync(claudeSettings), false);
  });

  test("setup (no agent): first-run setup, which needs a terminal; nothing written", () => {
    const run = kiko(["setup"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /run kiko-dev setup in a terminal: it asks you things/);
    assert.equal(existsSync(claudeSettings), false);
    assert.equal(existsSync(join(codexHome, "hooks.json")), false);
    assert.equal(existsSync(settings), false);
  });

  test("connected already: said, nothing asked", () => {
    connectClaude(claudeSettings);
    const run = kiko(["setup", "claude"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Claude Code: Kiko's hooks are in .*settings\.json already\./);
  });

  test("a settings file that isn't JSON: left alone", () => {
    mkdirSync(dirname(claudeSettings), { recursive: true });
    writeFileSync(claudeSettings, "{ nope");
    const run = kiko(["setup", "claude"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /can't be read as JSON, so I'm leaving it alone/);
    assert.equal(readFileSync(claudeSettings, "utf8"), "{ nope");
  });

  test("uninstall claude: says what it takes out, refuses without a terminal; the file as it was", () => {
    connectClaude(claudeSettings);
    const before = readFileSync(claudeSettings, "utf8");
    const run = kiko(["uninstall", "claude"]);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /Claude Code: this takes Kiko's hooks out of .*settings\.json; yours stay as they are/);
    assert.equal(readFileSync(claudeSettings, "utf8"), before);
    assert.match(kiko(["uninstall", "codex"]).stdout, /Codex has none of Kiko's hooks\./);
  });

  test("the agents it knows come from the registry", () => {
    assert.match(kiko(["setup", "vim"]).stderr, /setup what\? kiko-dev setup claude, codex or opencode/);
    assert.match(kiko(["uninstall", "vim"]).stderr, /uninstall what\? kiko-dev uninstall claude, codex or opencode/);
    const t3 = kiko(["setup", "t3code"]);
    assert.equal(t3.status, 0);
    assert.match(t3.stdout, /T3 Code needs nothing set up/);
    assert.match(kiko(["--help"]).stdout, /setup <agent>\s+connect an agent/);
    assert.match(kiko(["--help"]).stdout, /setup \[--all\]\s+set Kiko up/);
  });
});

describe("the command line's markers and colour (ui/cli-style.ts)", () => {
  test("piped: an error marked X and the hint after it, plain text with no escape codes; the help plain", () => {
    const run = kiko(["setup", "vim"]);
    assert.match(run.stderr, /^X kiko-dev: setup what\? /);
    assert.doesNotMatch(run.stderr + kiko(["--help"]).stdout, /\x1b/);
    const usage = kiko(["frobnicate"]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^X kiko-dev: .*\nTry kiko-dev --help for more\.\n$/);
    assert.match(kiko(["setup", "t3code"]).stdout, /^✓ T3 Code needs nothing set up/);
  });

  test("CLICOLOR_FORCE: colour on a pipe (the X red, the hint dim, the help's headings bold); NO_COLOR still wins", () => {
    const forced = kiko(["frobnicate"], { CLICOLOR_FORCE: "1" });
    assert.match(forced.stderr, /^\x1b\[31mX\x1b\[39m kiko-dev: /);
    assert.match(forced.stderr, /\x1b\[2mTry kiko-dev --help for more\.\x1b\[22m/);
    const help = kiko(["--help"], { CLICOLOR_FORCE: "1" }).stdout;
    assert.match(help, /^\x1b\[1mUsage:\x1b\[22m kiko-dev/);
    assert.match(help, /^\x1b\[1mCommands:\x1b\[22m$/m);
    assert.doesNotMatch(kiko(["frobnicate"], { CLICOLOR_FORCE: "1", NO_COLOR: "1" }).stderr, /\x1b/);
  });
});
