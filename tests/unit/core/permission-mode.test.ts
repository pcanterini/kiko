// The permission mode a session Kiko opens starts in, and each session's mode now (src/core/
// permission-mode.ts). Every session Kiko opened used to start as plain `claude`, so in your
// default, which can be auto; auto mode then blocked a session's change with no prompt (nothing on the
// card or the phone), a spoken go-ahead was blocked again, and only switching to accept edits by hand
// brought a normal prompt that a yes answered. Now: the "Permission mode" setting (Accept edits by
// default) on each agent's command line as it honestly can; the mode its hooks say kept as the
// session's, shown in the list when it isn't the usual one and sent to the phone; and a block said.
import "../../setup.ts";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, test } from "node:test";
import { join } from "node:path";
import React from "react";
import { render } from "ink";
import { inkDone } from "../../support/ink.ts";
import { LocalPhone } from "../../support/local-phone.ts";
import { claudeCode } from "../../../src/agents/claude-code/index.ts";
import { forgetMode, noteMode } from "../../../src/agents/claude-code/modes.ts";
import { continued, describe as describeListed } from "../../../src/agents/claude-code/sessions.ts";
import { codex } from "../../../src/agents/codex/index.ts";
import { codexModeOf, threadOf } from "../../../src/agents/codex/daemon.ts";
import { describeThread, mergeLive } from "../../../src/agents/codex/sessions.ts";
import { opencode } from "../../../src/agents/opencode/index.ts";
import { t3code } from "../../../src/agents/t3code/index.ts";
import { config } from "../../../src/core/config.ts";
import { blockedLine, DEFAULT_NEW_SESSION_MODE, expectedMode, modeTag, newSessionModeSetting, permissionModeOf, type NewSessionMode } from "../../../src/core/permission-mode.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { loadSettings, saveSettings } from "../../../src/core/settings.ts";
import { choicesFor, NEW_SESSION_MODES, SETTING_ABOUT, SETTING_FACTS, SETTING_GROUPS } from "../../../src/core/settings-options.ts";
import { ui, type UiState } from "../../../src/core/ui-store.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { WindowList } from "../../../src/ui/window-list.ts";

const ALL: NewSessionMode[] = ["manual", "acceptEdits", "plan", "auto", "inherit"];

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const session = (name: string, fields: Partial<Session> = {}) =>
  ({
    sessionId: name,
    cwd: `/code/${name}`,
    givenName: name,
    kind: "interactive",
    status: "idle",
    desktop: false,
    place: { via: "tmux", id: `%${name}`, keys: true, pid: 1 },
    mapping: "none",
    nameSetBy: "user",
    ...fields,
  }) as unknown as Session;

describe("the setting", () => {
  test("Accept edits unless set; a value it doesn't know (bypass among them) is Accept edits too", () => {
    assert.equal(DEFAULT_NEW_SESSION_MODE, "acceptEdits");
    assert.equal(config.newSessionMode, "acceptEdits", "no settings file, no KIKO_NEW_SESSION_MODE: the default");
    assert.equal(config.newSessionModeChosen, false, "left at the default, not chosen: scratch sessions may start in auto");
    for (const value of ALL) assert.equal(newSessionModeSetting(value), value);
    for (const raw of [undefined, "", "bypassPermissions", "dontAsk", "nonsense", 3]) assert.equal(newSessionModeSetting(raw), "acceptEdits", String(raw));
    assert.equal(newSessionModeSetting(" plan "), "plan");
  });

  test("its choices, in plain words, under New sessions, never bypass; kept in the settings file as picked", async () => {
    assert.deepEqual(
      NEW_SESSION_MODES.map((c) => [c.value, c.label]),
      [
        ["manual", "Ask me"],
        ["acceptEdits", "Accept edits"],
        ["plan", "Plan"],
        ["auto", "Auto"],
        ["inherit", "Your Claude Code default"],
      ],
    );
    assert.ok(
      NEW_SESSION_MODES.every((c) => c.hint),
      "each with a hint",
    );
    assert.match(NEW_SESSION_MODES[1].hint!, /the default/);
    assert.deepEqual((await choicesFor("newSessionMode", { tts: "say", current: "acceptEdits" })).choices, NEW_SESSION_MODES);
    assert.ok(SETTING_GROUPS.find((g) => g.title === "New sessions")!.keys.includes("newSessionMode"));
    assert.match(SETTING_ABOUT.newSessionMode, /Sessions you start yourself aren't touched/);
    assert.deepEqual(
      SETTING_FACTS.newSessionMode.map((f) => f.label),
      ["Scratch", "Codex", "OpenCode"],
      "scratch sessions' auto, and what the other agents get, as rows",
    );
    assert.ok(!JSON.stringify(NEW_SESSION_MODES).includes("bypass"));
    // Kept with the rest of the settings, and read back the same way.
    saveSettings({ ...loadSettings(), newSessionMode: "plan" });
    assert.equal(newSessionModeSetting(loadSettings().newSessionMode), "plan");
    saveSettings({ ...loadSettings(), newSessionMode: undefined });
  });
});

describe("the start command, per agent and per setting", () => {
  const start = (agent: typeof claudeCode, mode: NewSessionMode | undefined, prompt = "fix the login bug", name = "docs") => agent.startCommand({ prompt, name, ...(mode ? { mode } : {}) });

  test("Claude Code: --permission-mode before --name and the prompt; Ask me as default (2.1.314 takes it); your own default, no flag", () => {
    const flags: Record<NewSessionMode, string[]> = {
      manual: ["--permission-mode", "default"],
      acceptEdits: ["--permission-mode", "acceptEdits"],
      plan: ["--permission-mode", "plan"],
      auto: ["--permission-mode", "auto"],
      inherit: [],
    };
    for (const mode of ALL) {
      assert.deepEqual(start(claudeCode, mode), { program: "claude", args: [...flags[mode], "--name", "docs", "fix the login bug"] }, mode);
      assert.deepEqual(start(claudeCode, mode, "", ""), { program: "claude", args: flags[mode] }, `${mode}, no name or prompt`);
    }
    // No mode at all (the scratch folder's trust step, which is /exit-ed at once): as before.
    assert.deepEqual(start(claudeCode, undefined), { program: "claude", args: ["--name", "docs", "fix the login bug"] });
  });

  test("Codex: its nearest (Ask me read-only, Accept edits workspace-write, Auto its reviewer); Plan and your default, nothing", () => {
    const flags: Record<NewSessionMode, string[]> = {
      manual: ["-a", "on-request", "-s", "read-only"],
      acceptEdits: ["-a", "on-request", "-s", "workspace-write"],
      plan: [],
      auto: ["--approve-for-me"],
      inherit: [],
    };
    // After Kiko's own -c (its update screen off: agents/codex/launch.ts).
    const off = ["-c", "check_for_update_on_startup=false"];
    for (const mode of ALL) assert.deepEqual(start(codex, mode), { program: "codex", args: [...off, ...flags[mode], "fix the login bug"] }, mode);
    assert.deepEqual(start(codex, "acceptEdits", ""), { program: "codex", args: [...off, ...flags.acceptEdits] });
  });

  test("OpenCode: no flag for any of them, so none passed", () => {
    for (const mode of ALL) assert.deepEqual(start(opencode, mode), { program: "opencode", args: ["--prompt", "fix the login bug"] }, mode);
  });

  test("T3 Code starts nothing from here, whatever the setting", () => {
    assert.ok(!t3code.starts);
  });
});

describe("each session's mode", () => {
  test("a hook's permission_mode: one of Claude Code's six (Manual's new name as default); anything else, nothing", () => {
    for (const m of ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) assert.equal(permissionModeOf(m), m);
    assert.equal(permissionModeOf("manual"), "default");
    for (const raw of [undefined, null, "", "Plan", "yolo", 1]) assert.equal(permissionModeOf(raw), null);
  });

  test("from the hook to the session listed: kept by its ID (./modes.ts), in what's listed; a continued session takes its process's", () => {
    forgetMode("m-9");
    const listed = { sessionId: "m-9", name: "lacy", cwd: "/nowhere/lacy", kind: "interactive", status: "idle" };
    assert.equal(describeListed(listed, null).mode, undefined, "no hook yet: not known");
    assert.equal(noteMode("m-9", "auto"), true);
    assert.equal(noteMode("m-9", "auto"), false, "the same again: no change");
    assert.equal(describeListed(listed, null).mode, "auto");
    const front = describeListed({ ...listed, sessionId: "front-1" }, null);
    assert.equal(continued(describeListed(listed, null), front).mode, "auto", "the job's hooks are the session's now");
    forgetMode("m-9");
    assert.equal(continued(describeListed(listed, null), { ...front, mode: "plan" }).mode, "plan", "the terminal's, while the job's isn't known");
  });

  test("Codex: its thread's settings (thread/settings/updated) as the nearest of Claude Code's modes; listed with the session", () => {
    const settings = (patch: object) => ({ approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" }, collaborationMode: { mode: "default" }, ...patch });
    assert.equal(codexModeOf(settings({})), "acceptEdits");
    assert.equal(codexModeOf(settings({ sandboxPolicy: { type: "readOnly", networkAccess: false } })), "default");
    assert.equal(codexModeOf(settings({ approvalPolicy: "untrusted" })), "default");
    assert.equal(codexModeOf(settings({ collaborationMode: { mode: "plan" } })), "plan");
    assert.equal(codexModeOf(settings({ approvalsReviewer: "auto_review" })), "auto");
    assert.equal(codexModeOf(settings({ approvalPolicy: "never" })), "dontAsk");
    assert.equal(codexModeOf(settings({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } })), "bypassPermissions");
    assert.equal(codexModeOf(settings({ sandboxPolicy: { type: "dangerFullAccess" } })), null, "full access that still asks: not guessed");
    assert.equal(codexModeOf(undefined), null);
    const t = threadOf({ id: "th-1", cwd: "/nowhere/pixie", originator: "codex-tui", status: { type: "idle" } })!;
    assert.equal(describeThread(t, "").mode, undefined);
    assert.equal(describeThread({ ...t, mode: "plan" }, "").mode, "plan");
    const merged = mergeLive([{ sessionId: "th-1", cwd: "/nowhere/pixie", status: "idle", at: 1 }], new Map(), { threads: [{ ...t, mode: "auto" }], folders: null }, () => "");
    assert.equal(merged[0].mode, "auto");
  });
});

describe("the list's tag", () => {
  test("only for a mode other than the one sessions start in, or one not known; short words", () => {
    assert.equal(expectedMode("acceptEdits"), "acceptEdits");
    assert.equal(expectedMode("manual"), "default");
    assert.equal(expectedMode("inherit"), "default", "your own default taken as Claude Code's own");
    assert.equal(modeTag("acceptEdits", "acceptEdits"), "");
    assert.equal(modeTag(undefined, "acceptEdits"), "");
    assert.deepEqual(
      ["default", "plan", "auto", "dontAsk", "bypassPermissions"].map((m) => modeTag(m, "acceptEdits")),
      ["ask", "plan", "auto", "don't ask", "bypass"],
    );
    assert.equal(modeTag("plan", "plan"), "");
    assert.equal(modeTag("acceptEdits", "plan"), "edits");
    assert.equal(modeTag("auto", "inherit"), "auto", "auto as your default: each one says so");
  });

  async function drawn(s: UiState, columns = 40, rows = 14) {
    let text = "";
    const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns, rows, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const app = render(React.createElement(WindowList, { s }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, interactive: true });
    // Drawn through, its effects' frame too (tests/support/ink.ts), never a fixed time.
    await inkDone(app);
    app.unmount();
    return (text.split("\u001b[2J").at(-1) ?? text).split("\n").map(plain);
  }

  test("drawn dim before the state; names still start in one column; the usual mode and an unknown one say nothing", async () => {
    const s: UiState = {
      ...ui.state,
      sessionsLoaded: true,
      window: { shown: null, note: "" },
      sessions: [session("lacy", { mode: "auto" }), session("pixie", { mode: "acceptEdits" }), session("clipkit"), session("grove", { mode: "plan" })],
    };
    const rows = await drawn(s);
    const row = (name: string) => rows.find((r) => r.includes(` ${name}`))!;
    assert.match(row("lacy"), /lacy +auto ● idle\s*$/);
    assert.match(row("grove"), /grove +plan ● idle\s*$/);
    assert.match(row("pixie"), /pixie +● idle\s*$/);
    assert.match(row("clipkit"), /clipkit +● idle\s*$/);
    const at = ["lacy", "pixie", "clipkit", "grove"].map((n) => row(n).indexOf(n));
    assert.equal(new Set(at).size, 1, `names in one column: ${at}`);
    // The setting at Plan: plan says nothing now, Accept edits does.
    const planned = await drawn({ ...s, newSessionMode: "plan" });
    assert.match(planned.find((r) => r.includes(" grove"))!, /grove +● idle\s*$/);
    assert.match(planned.find((r) => r.includes(" pixie"))!, /pixie +edits ● idle\s*$/);
  });
});

describe("the phone's sessions", () => {
  test("permissionMode, once known: valid against the schema (optional: version 1 stays); missing while unknown", async () => {
    const hub: PhoneHub = {
      talkStart: () => null,
      talkAudio: () => {},
      talkEnd: () => {},
      type: () => null,
      permission: () => null,
      answers: () => null,
      talking: () => false,
      playOnMac: () => {},
      catchUp: () => {},
      catchUpSummary: () => {},
      catchUpStop: () => false,
    };
    const pairing = new Pairing(join(process.cwd(), "phones-modes.json"));
    const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
    const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network });
    const port = await server.start();
    const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
    const got: any[] = [];
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
      got.push(m);
    });
    try {
      ui.set({ sessions: [session("lacy", { mode: "auto" }), session("pixie")] });
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({ v: 1, type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" }));
      const end = Date.now() + 2000;
      while (!got.some((m) => m.type === "sessions") && Date.now() < end) await wait(10);
      const listed = got.find((m) => m.type === "sessions").sessions;
      assert.equal(listed.find((x: any) => x.id === "lacy").permissionMode, "auto");
      assert.ok(!("permissionMode" in listed.find((x: any) => x.id === "pixie")), "not known: left out");
      // Changed (Shift+Tab, then its next hook): sent again.
      const from = got.length;
      ui.set({ sessions: [session("lacy", { mode: "acceptEdits" }), session("pixie")] });
      while (!got.slice(from).some((m) => m.type === "sessions") && Date.now() < end + 2000) await wait(10);
      assert.equal(
        got
          .slice(from)
          .find((m) => m.type === "sessions")
          .sessions.find((x: any) => x.id === "lacy").permissionMode,
        "acceptEdits",
      );
      assert.notEqual(
        invalid({ v: 1, type: "sessions", sessions: [{ id: "a", name: "a", folder: "/a", status: "idle", lastActivity: null, summary: "", desktop: false, permissionMode: "yolo" }] }),
        null,
        "a mode it doesn't know is refused",
      );
    } finally {
      ws.close();
      server.stop();
      ui.set({ sessions: [] });
    }
  });
});

describe("a block said", () => {
  const bash = (command: string) => ({ name: "Bash", input: { command } });

  test("what was blocked, plainly, naming the session; never offering to switch modes", () => {
    assert.equal(blockedLine("Lacy", { tool: bash("wrangler deploy --env production"), reason: "[Production Deploy]" }), "Auto mode blocked Lacy from running wrangler deploy --env production.");
    assert.equal(blockedLine("Lacy", { tool: { name: "Edit", input: { file_path: "/x/wrangler.toml" } }, reason: "" }), "Auto mode blocked Lacy from editing wrangler.toml.");
    assert.equal(blockedLine("Lacy", { tool: { name: "Write", input: { file_path: "/x/.env.production" } }, reason: "" }), "Auto mode blocked Lacy from writing .env.production.");
    assert.equal(
      blockedLine("Lacy", { tool: { name: "WebFetch", input: { url: "https://api.cloudflare.com/client/v4/zones" } }, reason: "" }),
      "Auto mode blocked Lacy from fetching api.cloudflare.com.",
    );
    assert.equal(blockedLine("Lacy", { tool: { name: "mcp__cloudflare__dns_update", input: {} }, reason: "" }), "Auto mode blocked Lacy from using dns_update from cloudflare.");
    assert.equal(blockedLine("Lacy", { tool: { name: "Bash", input: undefined }, reason: "" }), "Auto mode blocked Lacy from running a command.");
    assert.equal(
      blockedLine("Lacy", { tool: bash("curl x"), reason: "Auto mode could not evaluate this action and is blocking it for safety." }),
      "Auto mode blocked Lacy from running curl x. It couldn't check it, so it blocked it to be safe.",
    );
    for (const line of [blockedLine("Lacy", { tool: bash("ls"), reason: "" })]) assert.doesNotMatch(line, /switch|mode\?|want me/i);
  });

  test("a long or odd command is never read out: what it's for, else a command (it's said, and drawn)", () => {
    const line = blockedLine("Lacy", { tool: bash(`echo \u001b[31mred\u0007 ${"x".repeat(200)}`), reason: "" });
    assert.doesNotMatch(line, /[\u0000-\u001f]/);
    assert.equal(line, "Auto mode blocked Lacy from running a command.");
    const piped = { name: "Bash", input: { command: "cd /x/y && npx wrangler deploy | tee out.log", description: "Deploy the worker to production." } };
    assert.equal(blockedLine("Lacy", { tool: piped, reason: "" }), "Auto mode blocked Lacy from running a command to deploy the worker to production.");
  });
});
