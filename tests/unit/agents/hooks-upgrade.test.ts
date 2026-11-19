// Kiko's own hooks brought up to date at the app's start (src/agents/setup.ts upgradeHooks): an
// agent connected already is given an event new to this Kiko (PermissionDenied, 2026-10-30), once,
// through the same connect as "Add the rest"; nothing for one not connected, one you said no to, one
// whose file isn't JSON or whose hook moved; an event you took out stays out (hooksKnown). Every file
// is this test's own (tests/setup.ts points KIKO_CLAUDE_SETTINGS, CODEX_HOME and KIKO_SETTINGS
// at its folder), never ~/.claude, ~/.codex or ~/.config/kiko.
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { claudeCodeSetup, claudeSettingsFile } from "../../../src/agents/claude-code/setup.ts";
import { HOOK_COMMAND, HOOK_MARKER, HOOK_MATCHERS, HOOK_TIMEOUTS } from "../../../src/agents/claude-code/settings.ts";
import { CODEX_HOOK_COMMAND, CODEX_HOOKS, codexSetup, hooksFile } from "../../../src/agents/codex/setup.ts";
import { withoutOurs, type HooksFile } from "../../../src/agents/hooks-file.ts";
import { connectOne, upgradedMessage, upgradeHooks, type Upgraded } from "../../../src/agents/setup.ts";
import type { AgentSetup } from "../../../src/agents/types.ts";
import { loadSettings, SETTINGS_FILE } from "../../../src/core/settings.ts";

const ALL = Object.keys(HOOK_TIMEOUTS);
const ours = (timeout: number, command = HOOK_COMMAND, matcher?: string) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] });
/** Claude Code's settings with our hook on `events` (each at its own timeout and matcher), and `rest` of yours. */
const withOurs = (events: string[], rest: Record<string, unknown> = {}, yours: Record<string, unknown[]> = {}) => {
  const hooks: Record<string, unknown[]> = { ...yours };
  for (const e of events) {
    const event = e as keyof typeof HOOK_TIMEOUTS;
    hooks[e] = [...(hooks[e] ?? []), ours(HOOK_TIMEOUTS[event], HOOK_COMMAND, HOOK_MATCHERS[event])];
  }
  return { ...rest, hooks } as HooksFile;
};
const file = () => claudeSettingsFile();
/** Claude Code's settings file written as `content` (an object as JSON, or text as it is). */
function write(content: unknown) {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}
const text = () => readFileSync(file(), "utf8");
const read = () => JSON.parse(text());
const backups = (path = file()) => readdirSync(dirname(path)).filter((f) => f.includes(".kiko-backup-"));
const known = () => loadSettings().hooksKnown;
/** Kiko's settings as `saved` (none: no file). */
const settings = (saved?: Record<string, unknown>) => (saved ? writeFileSync(SETTINGS_FILE, JSON.stringify(saved)) : rmSync(SETTINGS_FILE, { force: true }));
const only = (setup: AgentSetup) => [setup];

beforeEach(() => {
  rmSync(dirname(file()), { recursive: true, force: true });
  rmSync(dirname(hooksFile()), { recursive: true, force: true });
  settings();
});

describe("the start's upgrade: Kiko's own hooks, in an agent connected already", () => {
  test("the files are this process's own, never the real ones", () => {
    assert.ok(!file().startsWith(join(homedir(), ".claude")), file());
    assert.ok(!hooksFile().startsWith(join(homedir(), ".codex")), hooksFile());
    assert.ok(!SETTINGS_FILE.startsWith(join(homedir(), ".config")), SETTINGS_FILE);
  });

  test("connected before PermissionDenied and the safety gate: they're added once, next to yours, backed up, said once", () => {
    const yours = { matcher: "*", hooks: [{ type: "command", command: "notify-me", timeout: 10 }] };
    const audit = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] };
    const before = withOurs(
      ALL.filter((e) => e !== "PermissionDenied" && e !== "PreToolUse"),
      { model: "opus", statusLine: { type: "command", command: "ccstatusline" }, permissions: { allow: ["Bash(ls)"] } },
      { Stop: [yours], PreToolUse: [audit] },
    );
    write(before);
    const { upgraded, unsaved } = upgradeHooks(only(claudeCodeSetup));
    assert.equal(unsaved, undefined);
    assert.equal(upgraded.length, 1);
    assert.equal(upgraded[0].did, "added");
    // In the file's order: your PreToolUse hook was there first.
    assert.deepEqual(upgraded[0].events, ["PreToolUse", "PermissionDenied"]);
    assert.equal(upgradedMessage(upgraded), "Added Kiko's new Claude Code hooks (PreToolUse and PermissionDenied).");
    const after = read();
    assert.deepEqual(after.hooks.PermissionDenied, [ours(5)]);
    // Everything that isn't Kiko's, exactly as it was, in its order: settings, your hooks.
    assert.equal(JSON.stringify(withoutOurs(after, HOOK_MARKER)), JSON.stringify(withoutOurs(before, HOOK_MARKER)));
    assert.deepEqual(after.hooks.Stop, [yours, ours(300)]);
    assert.deepEqual(after.hooks.PreToolUse, [audit, ours(15, HOOK_COMMAND, "Bash|Monitor|mcp__.*")]);
    // The file as it was, next to it.
    assert.equal(backups().length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(file()), backups()[0]), "utf8")), before);
    assert.deepEqual(upgraded[0].changed?.backup, join(dirname(file()), backups()[0]));
    assert.deepEqual(known(), { "claude-code": ALL });
    // The next start: nothing new, nothing written, nothing said.
    const now = text();
    const again = upgradeHooks(only(claudeCodeSetup));
    assert.deepEqual(again.upgraded, []);
    assert.equal(upgradedMessage(again.upgraded), null);
    assert.equal(text(), now);
    assert.equal(backups().length, 1);
  });

  test("nothing missing: no write, no backup, nothing said; what it has kept as given", () => {
    write(withOurs(ALL));
    const now = text();
    const { upgraded } = upgradeHooks(only(claudeCodeSetup));
    assert.deepEqual(upgraded, []);
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
    assert.deepEqual(known(), { "claude-code": ALL });
  });

  test("not connected (no file, or only your hooks): untouched, nothing kept", () => {
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(existsSync(file()), false, "no file made");
    write({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } });
    const now = text();
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
    assert.equal(known(), undefined);
  });

  test("one you said no to (unticked on the card, or disconnected) is never touched", () => {
    write(withOurs(["Stop", "PermissionRequest"]));
    settings({ agentAnswers: { "claude-code": "no" } });
    const now = text();
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(text(), now);
    assert.equal(known(), undefined);
  });

  test("an optional event you took out isn't put back", () => {
    // Kept as given already (connected since): SessionStart and PermissionDenied taken out by hand.
    write(withOurs(["Stop", "PermissionRequest", "SessionEnd", "UserPromptSubmit"]));
    settings({ hooksKnown: { "claude-code": ALL } });
    const now = text();
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
  });

  test("no record yet: an event Kiko had before (SessionStart) missing stays out; only the new one goes in", () => {
    write(withOurs(["Stop", "PermissionRequest", "SessionEnd", "UserPromptSubmit"]));
    const { upgraded } = upgradeHooks(only(claudeCodeSetup));
    assert.deepEqual(
      upgraded.map((u) => [u.did, u.events]),
      [["added", ["PermissionDenied", "PreToolUse"]]],
    );
    assert.equal(read().hooks.SessionStart, undefined);
    assert.deepEqual(known(), { "claude-code": ALL });
    // Then PermissionDenied taken out by hand: kept out from now on.
    const taken = read();
    delete taken.hooks.PermissionDenied;
    write(taken);
    const now = text();
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(text(), now);
  });

  test("a file that isn't JSON: untouched, no backup, and why (for the log)", () => {
    write('{ "hooks": { "Stop": [ ');
    const now = text();
    const { upgraded } = upgradeHooks(only(claudeCodeSetup));
    assert.equal(upgraded.length, 1);
    assert.equal(upgraded[0].did, "skipped");
    assert.match(upgraded[0].why ?? "", /can't be read .*leaves it alone/);
    assert.equal(upgradedMessage(upgraded), null);
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
    assert.equal(known(), undefined);
  });

  test("its hook moved (needs repair): left to the card and settings → Agents, untouched", () => {
    write(withOurs(["Stop", "PermissionRequest"]));
    const moved = JSON.parse(text().replaceAll(HOOK_COMMAND, "node /nowhere/old-kiko/hooks/claude-code-hook.mjs"));
    write(moved);
    const now = text();
    const { upgraded } = upgradeHooks(only(claudeCodeSetup));
    assert.deepEqual(
      upgraded.map((u) => u.did),
      ["skipped"],
    );
    assert.match(upgraded[0].why ?? "", /needs repair/);
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
  });

  test("a file that can't be written: nothing changed, nothing kept (tried again next start)", { skip: process.getuid?.() === 0 }, () => {
    write(withOurs(ALL.filter((e) => e !== "PermissionDenied")));
    const now = text();
    chmodSync(dirname(file()), 0o555);
    try {
      const { upgraded } = upgradeHooks(only(claudeCodeSetup));
      assert.deepEqual(
        upgraded.map((u) => [u.did, u.events]),
        [["failed", ["PermissionDenied"]]],
      );
      assert.ok(upgraded[0].why);
      assert.equal(upgradedMessage(upgraded), null);
    } finally {
      chmodSync(dirname(file()), 0o755);
    }
    assert.equal(text(), now);
    assert.deepEqual(backups(), []);
    assert.equal(known(), undefined);
  });

  test("Codex: an event new to Kiko (here: Interrupt, as if added later) goes into its connected hooks.json", () => {
    const later = { ...codexSetup, hooksBefore: Object.keys(CODEX_HOOKS).filter((e) => e !== "Interrupt") };
    const hooks: Record<string, unknown[]> = {};
    for (const [event, { timeout, matcher }] of Object.entries(CODEX_HOOKS))
      if (event !== "Interrupt") hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout }] }];
    hooks.Stop = [{ hooks: [{ type: "command", command: "mine.sh" }] }, ...hooks.Stop];
    mkdirSync(dirname(hooksFile()), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks }));
    const { upgraded } = upgradeHooks([later]);
    assert.deepEqual(
      upgraded.map((u) => [u.did, u.events]),
      [["added", ["Interrupt"]]],
    );
    assert.equal(upgradedMessage(upgraded), "Added Kiko's new Codex hook (Interrupt).");
    const after = JSON.parse(readFileSync(hooksFile(), "utf8"));
    assert.deepEqual(after.hooks.Interrupt, [{ hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 3 }] }]);
    assert.deepEqual(after.hooks.Stop[0], { hooks: [{ type: "command", command: "mine.sh" }] });
    assert.equal(backups(hooksFile()).length, 1);
    // Today's Codex, connected whole: nothing to add.
    assert.deepEqual(upgradeHooks([codexSetup]).upgraded, []);
  });

  test("Codex connected before the safety gate: its PreToolUse entry gets the gate's matcher and timeout, once, yours untouched", () => {
    const hooks: Record<string, unknown[]> = {};
    for (const [event, { timeout, matcher }] of Object.entries(CODEX_HOOKS)) hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout }] }];
    // As connected until 2026-11-02: its questions only, 5 s; and a hook of yours sharing a group with it elsewhere.
    hooks.PreToolUse = [{ matcher: "request_user_input", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 5 }] }];
    const mine = { type: "command", command: "mine.sh" };
    hooks.Stop = [{ hooks: [mine] }, ...hooks.Stop];
    mkdirSync(dirname(hooksFile()), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks }));
    const { upgraded } = upgradeHooks([codexSetup]);
    assert.deepEqual(
      upgraded.map((u) => [u.did, u.events, u.changed?.refreshed]),
      [["added", [], ["PreToolUse"]]],
    );
    assert.equal(upgradedMessage(upgraded), "Updated Kiko's Codex hook (PreToolUse): Codex asks you to trust it again at its next start.");
    const after = JSON.parse(readFileSync(hooksFile(), "utf8"));
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "request_user_input|Bash|mcp__.*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 300 }] }]);
    assert.deepEqual(after.hooks.Stop[0], { hooks: [mine] });
    assert.equal(backups(hooksFile()).length, 1);
    // Once.
    assert.deepEqual(upgradeHooks([codexSetup]).upgraded, []);
  });

  test("Claude Code connected with an older Kiko's PermissionRequest timeout (120 s): raised to 3600 s at start, once, said; nothing else changed", () => {
    const yours = { matcher: "*", hooks: [{ type: "command", command: "notify-me", timeout: 10 }] };
    const before = withOurs(ALL, { model: "opus" }, { PermissionRequest: [yours] });
    (before.hooks as Record<string, unknown[]>).PermissionRequest = [yours, ours(120)];
    write(before);
    const { upgraded } = upgradeHooks(only(claudeCodeSetup));
    assert.deepEqual(
      upgraded.map((u) => [u.did, u.events, u.changed?.refreshed]),
      [["added", [], ["PermissionRequest"]]],
    );
    assert.equal(upgradedMessage(upgraded), "Updated Kiko's Claude Code hook (PermissionRequest).");
    const after = read();
    assert.equal(HOOK_TIMEOUTS.PermissionRequest, 3600);
    assert.deepEqual(after.hooks.PermissionRequest, [yours, ours(3600)], "yours untouched, ours raised in its place");
    assert.equal(JSON.stringify(withoutOurs(after, HOOK_MARKER)), JSON.stringify(withoutOurs(before, HOOK_MARKER)));
    assert.equal(backups().length, 1, "backed up first");
    // Once.
    const now = text();
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(text(), now);
  });

  test("Codex connected with an older Kiko's PermissionRequest timeout (120 s): raised to 3600 s at start, once", () => {
    const hooks: Record<string, unknown[]> = {};
    for (const [event, { timeout, matcher }] of Object.entries(CODEX_HOOKS)) hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout }] }];
    hooks.PermissionRequest = [{ matcher: "*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 120 }] }];
    mkdirSync(dirname(hooksFile()), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks }));
    const { upgraded } = upgradeHooks([codexSetup]);
    assert.deepEqual(
      upgraded.map((u) => [u.did, u.events, u.changed?.refreshed]),
      [["added", [], ["PermissionRequest"]]],
    );
    const after = JSON.parse(readFileSync(hooksFile(), "utf8"));
    assert.deepEqual(after.hooks.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 3600 }] }]);
    assert.deepEqual(upgradeHooks([codexSetup]).upgraded, []);
  });

  test("Codex: Kiko's handler in a group of yours moves to a group of its own, with the gate's matcher; yours keeps its own", () => {
    const hooks: Record<string, unknown[]> = {};
    for (const [event, { timeout, matcher }] of Object.entries(CODEX_HOOKS)) hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout }] }];
    const audit = { type: "command", command: "audit.sh" };
    hooks.PreToolUse = [{ matcher: "request_user_input", hooks: [audit, { type: "command", command: CODEX_HOOK_COMMAND, timeout: 5 }] }];
    mkdirSync(dirname(hooksFile()), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks }));
    upgradeHooks([codexSetup]);
    const after = JSON.parse(readFileSync(hooksFile(), "utf8"));
    assert.deepEqual(after.hooks.PreToolUse, [
      { matcher: "request_user_input", hooks: [audit] },
      { matcher: "request_user_input|Bash|mcp__.*", hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout: 300 }] },
    ]);
  });

  test("an agent with no hooks file of its own (OpenCode, T3 Code) isn't looked at", () => {
    let looked = 0;
    const linked = { ...codexSetup, id: "x", linkWords: "listens to it", hookEvents: () => (looked++, { all: ["Stop"], missing: ["Stop"], ours: true, gone: false }) };
    const none: AgentSetup = { ...codexSetup, id: "y", hookEvents: undefined };
    assert.deepEqual(upgradeHooks([linked, none]).upgraded, []);
    assert.equal(looked, 0);
  });

  test("connecting one whole keeps every event as given: one taken out after stays out", () => {
    const o = connectOne(claudeCodeSetup);
    assert.equal(o.did, "connected");
    assert.deepEqual(known(), { "claude-code": ALL });
    const taken = read();
    delete taken.hooks.PermissionDenied;
    write(taken);
    assert.deepEqual(upgradeHooks(only(claudeCodeSetup)).upgraded, []);
    assert.equal(read().hooks.PermissionDenied, undefined);
  });

  test("what's said: one agent, several events, several agents", () => {
    const u = (name: string, events: string[]): Upgraded => ({ id: name, name, did: "added", events });
    assert.equal(upgradedMessage([u("Claude Code", ["PermissionDenied", "Notification"])]), "Added Kiko's new Claude Code hooks (PermissionDenied and Notification).");
    assert.equal(
      upgradedMessage([u("Claude Code", ["PermissionDenied"]), u("Codex", ["Interrupt"])]),
      "Added Kiko's new Claude Code hook (PermissionDenied). Added Kiko's new Codex hook (Interrupt).",
    );
    assert.equal(upgradedMessage([{ id: "x", name: "X", did: "skipped", events: [], why: "needs repair" }]), null);
  });
});
