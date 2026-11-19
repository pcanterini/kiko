// Connecting an agent's hooks, for real files (src/agents/claude-code/setup.ts, src/agents/codex/
// setup.ts, src/agents/hooks-file.ts): Kiko's entries merged into Claude Code's settings.json next
// to yours, a statusLine left alone, a file that isn't JSON refused and left as it was, a backup
// first, disconnect taking out only Kiko's, and a repair when the hook's folder moved. Every file
// is in this test's own folder (tests/setup.ts points KIKO_CLAUDE_SETTINGS and CODEX_HOME there),
// never ~/.claude or ~/.codex; a write to those is refused under the test runner.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { claudeCodeSetup, claudeSettingsFile, claudeStatusOf, connectClaude, connectedSettings, disconnectClaude } from "../../../src/agents/claude-code/setup.ts";
import { HOOK_COMMAND, staleEvents, type ClaudeSettings } from "../../../src/agents/claude-code/settings.ts";
import { CODEX_HOOK_COMMAND, CODEX_HOOKS, codexStatusOf, connectCodex, disconnectCodex, hooksFile, withCodexHooks } from "../../../src/agents/codex/setup.ts";
import { goneScripts, refuseRealFile, scriptOf, withoutOurs, writeWithBackup } from "../../../src/agents/hooks-file.ts";

const dir = mkdtempSync(join(tmpdir(), "kiko-hooks-"));
let n = 0;
/** A settings file of this test's own, with `content` (an object as JSON, or text as it is); none when undefined. */
function file(content?: unknown): string {
  const d = join(dir, `case-${++n}`);
  mkdirSync(d, { recursive: true });
  const path = join(d, "settings.json");
  if (content !== undefined) writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const backups = (path: string) => readdirSync(join(path, "..")).filter((f) => f.includes(".kiko-backup-"));
const ours = (timeout: number, command = HOOK_COMMAND) => ({ hooks: [{ type: "command", command, timeout }] });
/** The safety gate's entry (PreToolUse): shell commands and MCP tools only. */
const gate = (command = HOOK_COMMAND) => ({ matcher: "Bash|Monitor|mcp__.*", hooks: [{ type: "command", command, timeout: 15 }] });
const WHEN = new Date("2026-10-30T09:00:00Z");
const ALL = ["Stop", "PermissionRequest", "SessionStart", "SessionEnd", "UserPromptSubmit", "PermissionDenied", "PreToolUse"];

describe("Claude Code: connecting merges Kiko's hooks into settings.json", () => {
  test("the tests' settings file is this process's own, never ~/.claude/settings.json", () => {
    assert.ok(!claudeSettingsFile().startsWith(join(homedir(), ".claude")), claudeSettingsFile());
    assert.equal(claudeSettingsFile(), process.env.KIKO_CLAUDE_SETTINGS);
  });

  test("no file yet: all seven events, nothing backed up", () => {
    const path = file();
    const done = connectClaude(path, WHEN);
    assert.deepEqual(done.events, ALL);
    assert.equal(done.backup, null);
    assert.deepEqual(read(path).hooks, {
      Stop: [ours(300)],
      PermissionRequest: [ours(3600)],
      SessionStart: [ours(5)],
      SessionEnd: [ours(5)],
      UserPromptSubmit: [ours(5)],
      PermissionDenied: [ours(5)],
      PreToolUse: [gate()],
    });
  });

  test("no hooks yet, other settings there: the hooks added, the rest as it was", () => {
    const path = file({ model: "opus", permissions: { allow: ["Bash(ls)"] } });
    connectClaude(path, WHEN);
    const now = read(path);
    assert.equal(now.model, "opus");
    assert.deepEqual(now.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(Object.keys(now.hooks), ALL);
  });

  test("your hooks on the same events: kept first, in their places; ours after them", () => {
    const yours = { matcher: "*", hooks: [{ type: "command", command: "notify-me", timeout: 10 }] };
    const audit = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] };
    const path = file({ hooks: { Stop: [yours], PreToolUse: [audit], SessionStart: [yours] } });
    const done = connectClaude(path, WHEN);
    assert.deepEqual([...done.events].sort(), [...ALL].sort());
    const hooks = read(path).hooks;
    assert.deepEqual(hooks.Stop, [yours, ours(300)]);
    assert.deepEqual(hooks.SessionStart, [yours, ours(5)]);
    assert.deepEqual(hooks.PreToolUse, [audit, gate()], "yours first, the safety gate's after it");
  });

  test("a statusLine of yours is never touched (Kiko's status line isn't added)", () => {
    const statusLine = { type: "command", command: "npx -y ccstatusline@latest", padding: 0 };
    const path = file({ statusLine });
    connectClaude(path, WHEN);
    assert.deepEqual(read(path).statusLine, statusLine);
    disconnectClaude(path, WHEN);
    assert.deepEqual(read(path).statusLine, statusLine);
    // None there: none added.
    const bare = file({});
    connectClaude(bare, WHEN);
    assert.equal(read(bare).statusLine, undefined);
  });

  test("a file that isn't JSON (or isn't an object) is refused: nothing written, no backup", () => {
    for (const text of ["{ not json", "[1, 2]", "null"]) {
      const path = file(text);
      assert.throws(() => connectClaude(path, WHEN));
      assert.throws(() => disconnectClaude(path, WHEN));
      assert.equal(readFileSync(path, "utf8"), text, "left as it was");
      assert.deepEqual(backups(path), []);
    }
    // Its status says so, and the setup offers nothing for it.
    const before = process.env.KIKO_CLAUDE_SETTINGS;
    process.env.KIKO_CLAUDE_SETTINGS = file("{ broken");
    try {
      const status = claudeCodeSetup.status();
      assert.equal(status.state, "needs repair");
      assert.equal(status.unreadable, true);
    } finally {
      process.env.KIKO_CLAUDE_SETTINGS = before;
    }
  });

  test("backed up first: the file as it was, next to it", () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] }, theme: "dark" };
    const path = file(original);
    const done = connectClaude(path, WHEN);
    assert.equal(done.backup, `${path}.kiko-backup-2026-10-30T09-00-00-000Z`);
    assert.deepEqual(read(done.backup!), original);
    assert.deepEqual(backups(path).length, 1);
  });

  test("connected already: nothing written, no backup", () => {
    const path = file();
    connectClaude(path, WHEN);
    const again = connectClaude(path, new Date("2026-10-30T10:00:00Z"));
    assert.deepEqual(again, { file: path, events: [], backup: null });
    assert.deepEqual(backups(path), []);
  });

  test("disconnect takes out only Kiko's entries: yours stay, an event left empty goes", () => {
    const yours = { hooks: [{ type: "command", command: "notify-me" }] };
    const mixed = {
      matcher: "*",
      hooks: [
        { type: "command", command: "mine.sh" },
        { type: "command", command: HOOK_COMMAND, timeout: 5 },
      ],
    };
    const path = file({ model: "opus", hooks: { Stop: [yours, ours(300)], SessionStart: [mixed], PermissionRequest: [ours(120)], PreToolUse: [yours] } });
    const done = disconnectClaude(path, WHEN);
    assert.deepEqual(done.events.sort(), ["PermissionRequest", "SessionStart", "Stop"]);
    assert.ok(done.backup && existsSync(done.backup));
    const now = read(path);
    assert.equal(now.model, "opus");
    assert.deepEqual(now.hooks, { Stop: [yours], SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "mine.sh" }] }], PreToolUse: [yours] });
    // None of ours left: nothing to do, nothing written.
    assert.deepEqual(disconnectClaude(path, WHEN), { file: path, events: [], backup: null });
  });

  test("connect then disconnect gives back the file as it was (when it had hooks of its own)", () => {
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] }, env: { A: "1" } };
    const path = file(original);
    connectClaude(path, WHEN);
    disconnectClaude(path, WHEN);
    assert.deepEqual(read(path), original);
    // With none of its own: the hooks key goes too.
    const bare = file({ model: "x" });
    connectClaude(bare, WHEN);
    disconnectClaude(bare, WHEN);
    assert.deepEqual(read(bare), { model: "x" });
  });

  test("a stale path (the repo moved): needs repair; connect points ours at this hook, in place, and adds the missing", () => {
    const old = "node /nowhere/old-kiko/hooks/claude-code-hook.mjs";
    const yours = { hooks: [{ type: "command", command: "notify-me" }] };
    const settings: ClaudeSettings = { hooks: { Stop: [yours, ours(300, old)], PermissionRequest: [ours(120, old)] } };
    const status = claudeStatusOf(settings, "~/.claude/settings.json");
    assert.equal(status.state, "needs repair");
    assert.match(status.detail, /\/nowhere\/old-kiko\/hooks\/claude-code-hook\.mjs, which is gone/);
    const path = file(settings);
    const done = connectClaude(path, WHEN);
    assert.equal(done.repointed, 2);
    assert.deepEqual(done.events, ["SessionStart", "SessionEnd", "UserPromptSubmit", "PermissionDenied", "PreToolUse"]);
    const hooks = read(path).hooks;
    assert.deepEqual(hooks.Stop, [yours, ours(300)], "yours first, ours pointed here in its place, its timeout kept");
    assert.deepEqual(hooks.PermissionRequest, [ours(3600)], "an older Kiko's 120 s raised: a prompt may stand for up to an hour");
    assert.deepEqual(done.refreshed, ["PermissionRequest"]);
    assert.equal(claudeStatusOf(read(path), "x").state, "connected");
  });

  test("another checkout that's still there counts as connected (not repaired, not moved)", () => {
    const elsewhere = join(dir, "other-checkout", "hooks", "claude-code-hook.mjs");
    mkdirSync(join(elsewhere, ".."), { recursive: true });
    writeFileSync(elsewhere, "");
    const settings: ClaudeSettings = {
      hooks: Object.fromEntries(ALL.map((e) => [e, [e === "PreToolUse" ? gate(`node ${elsewhere}`) : ours(e === "PermissionRequest" ? 3600 : 5, `node ${elsewhere}`)]])),
    };
    assert.equal(claudeStatusOf(settings, "x").state, "connected");
    assert.deepEqual(connectedSettings(settings).next, settings);
  });

  test("an older Kiko's PermissionRequest timeout (120 s) is raised to this one's, in place; a longer one, and other events', are yours", () => {
    const yours = { matcher: "*", hooks: [{ type: "command", command: "notify-me", timeout: 10 }] };
    const mixed = {
      hooks: [
        { type: "command", command: "mine.sh", timeout: 30 },
        { type: "command", command: HOOK_COMMAND, timeout: 120 },
      ],
    };
    const settings: ClaudeSettings = { hooks: { ...Object.fromEntries(ALL.map((e) => [e, [e === "PreToolUse" ? gate() : ours(e === "Stop" ? 60 : 5)]])), PermissionRequest: [yours, mixed] } };
    assert.deepEqual(staleEvents(settings), ["PermissionRequest"], "Stop's 60 s, set by hand, isn't stale");
    assert.equal(claudeStatusOf(settings, "x").state, "connected", "still connected: only its timeout is old");
    const path = file(settings);
    const done = connectClaude(path, WHEN);
    assert.deepEqual([done.events, done.refreshed], [[], ["PermissionRequest"]]);
    assert.ok(done.backup && existsSync(done.backup), "backed up first");
    const hooks = read(path).hooks;
    assert.deepEqual(
      hooks.PermissionRequest,
      [
        yours,
        {
          hooks: [
            { type: "command", command: "mine.sh", timeout: 30 },
            { type: "command", command: HOOK_COMMAND, timeout: 3600 },
          ],
        },
      ],
      "yours untouched, ours raised in its place",
    );
    assert.deepEqual(hooks.Stop, [ours(60)]);
    // Up to date now: nothing written again.
    assert.deepEqual(connectClaude(path, WHEN), { file: path, events: [], backup: null });
    // One set longer by hand stays.
    assert.deepEqual(staleEvents({ hooks: { PermissionRequest: [ours(7200)] } }), []);
  });

  test("Stop or PermissionRequest missing: needs repair; only optional ones missing: connected, with what Connect adds", () => {
    assert.deepEqual(claudeStatusOf({ hooks: { Stop: [ours(300)] } }, "x"), { state: "needs repair", detail: "PermissionRequest isn't on" });
    const partly = claudeStatusOf({ hooks: { Stop: [ours(300)], PermissionRequest: [ours(120)] } }, "~/.claude/settings.json");
    assert.equal(partly.state, "connected");
    assert.equal(partly.partial, "SessionStart, SessionEnd, UserPromptSubmit, PermissionDenied, PreToolUse not on (optional)");
    // Connected before PermissionDenied was added (2026-10-30): connected, with Add the rest for it.
    const before = claudeStatusOf({ hooks: Object.fromEntries(ALL.filter((e) => e !== "PermissionDenied").map((e) => [e, [ours(5)]])) }, "x");
    assert.deepEqual([before.state, before.partial], ["connected", "PermissionDenied not on (optional)"]);
    assert.deepEqual(claudeStatusOf({ hooks: {} }, "~/.claude/settings.json"), { state: "not connected", detail: "adds hooks to ~/.claude/settings.json" });
  });
});

describe("Codex: the same, through its own installer", () => {
  const codexFile = (content?: unknown) => {
    const path = join(dir, `codex-${++n}`, "hooks.json");
    mkdirSync(join(path, ".."), { recursive: true });
    if (content !== undefined) writeFileSync(path, JSON.stringify(content));
    return path;
  };

  test("its hooks file is this process's own CODEX_HOME's, never ~/.codex", () => {
    assert.ok(!hooksFile().startsWith(join(homedir(), ".codex")), hooksFile());
  });

  test("not connected, connected, partly (needs repair), a script gone (needs repair)", () => {
    assert.equal(codexStatusOf({}, "~/.codex/hooks.json").state, "not connected");
    const full = withCodexHooks({});
    assert.equal(codexStatusOf(full, "x").state, "connected");
    const partial = { hooks: { Stop: full.hooks!.Stop } };
    assert.equal(codexStatusOf(partial, "x").state, "needs repair");
    const moved = withCodexHooks({}, "node /nowhere/old/hooks/codex-hook.mjs");
    assert.match(codexStatusOf(moved, "x").detail, /which is gone/);
  });

  test("connect is installCodexHooks (each event, backup first); a repair points the moved entries here", () => {
    const path = codexFile({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
    const done = connectCodex(path, WHEN);
    assert.deepEqual(done.events, Object.keys(CODEX_HOOKS));
    assert.ok(done.backup);
    const moved = codexFile(withCodexHooks({}, "node /nowhere/old/hooks/codex-hook.mjs"));
    const fixed = connectCodex(moved, WHEN);
    assert.equal(fixed.repointed, Object.keys(CODEX_HOOKS).length);
    assert.equal(codexStatusOf(read(moved), "x").state, "connected");
    assert.ok(JSON.stringify(read(moved)).includes(JSON.stringify(CODEX_HOOK_COMMAND).slice(1, -1)));
  });

  test("disconnect takes out only Kiko's", () => {
    const mine = { hooks: [{ type: "command", command: "mine" }] };
    const path = codexFile(withCodexHooks({ hooks: { Stop: [mine] }, other: 1 } as never));
    const done = disconnectCodex(path, WHEN);
    assert.deepEqual(done.events.sort(), Object.keys(CODEX_HOOKS).sort());
    assert.deepEqual(read(path), { hooks: { Stop: [mine] }, other: 1 });
  });
});

describe("the hook files' helpers", () => {
  test("the script a command runs, quoted or not", () => {
    assert.equal(scriptOf("node /a/b/claude-code-hook.mjs", "claude-code-hook.mjs"), "/a/b/claude-code-hook.mjs");
    assert.equal(scriptOf("node '/a b/codex-hook.mjs'", "codex-hook.mjs"), "/a b/codex-hook.mjs");
    assert.equal(scriptOf(`node "/x y/claude-code-hook.mjs" --flag`, "claude-code-hook.mjs"), "/x y/claude-code-hook.mjs");
    assert.equal(scriptOf("echo hi", "claude-code-hook.mjs"), null);
  });
  test("only full paths count as gone", () => {
    const f = { hooks: { Stop: [{ hooks: [{ command: "node hooks/claude-code-hook.mjs" }, { command: "node /gone/claude-code-hook.mjs" }] }] } };
    assert.deepEqual(
      goneScripts(f, "claude-code-hook.mjs", () => false),
      ["/gone/claude-code-hook.mjs"],
    );
  });
  test("an event of yours that's empty stays empty; one emptied by taking ours out goes", () => {
    assert.deepEqual(withoutOurs({ hooks: { Stop: [], End: [{ hooks: [{ command: "x/claude-code-hook.mjs" }] }] } }, "claude-code-hook.mjs"), { hooks: { Stop: [] } });
  });
  test("under the test runner, the real ~/.claude, ~/.codex and ~/.config/kiko are never written", () => {
    assert.ok(process.env.NODE_TEST_CONTEXT, "run by the test runner");
    for (const path of [join(homedir(), ".claude", "settings.json"), join(homedir(), ".codex", "hooks.json"), join(homedir(), ".config", "kiko", "settings.json")]) {
      assert.throws(() => refuseRealFile(path), /not writing the real/);
      assert.throws(() => writeWithBackup(path, {}), /not writing the real/);
    }
    assert.doesNotThrow(() => refuseRealFile(join(dir, "fine.json")));
  });
});
