// Which agent a new session starts in (src/core/agent-pick.ts, agents/index.ts offeredStarters):
// the preselection (the run's, then the setting: last used or pinned), a named agent winning, one
// agent able to start sessions meaning no picker and no change in what's said, the words when more
// than one can, the "New sessions in" setting's new value and how older values read, and the last
// used remembered (in this test's own settings file). The registry's real agents are connected only
// in this test's own homes (tests/setup.ts), never yours.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { agents, mainAgent, offeredStarters, starters } from "../../../src/agents/index.ts";
import { claudeCodeSetup } from "../../../src/agents/claude-code/setup.ts";
import { codexSetup } from "../../../src/agents/codex/setup.ts";
import { SETUPS } from "../../../src/agents/setup.ts";
import type { Agent, AgentSetup, SetupState } from "../../../src/agents/types.ts";
import { asksWhich, chooseUnasked, namesAgent, openingLine, placeWords, preselect, sessionKind, whyWords } from "../../../src/core/agent-pick.ts";
import { config } from "../../../src/core/config.ts";
import { newSessionChoices, NEW_SESSION_AGENTS } from "../../../src/core/settings-options.ts";
import { LAST_USED, loadSettings, newSessionSetting, rememberLastAgent, saveSettings, SETTINGS_FILE } from "../../../src/core/settings.ts";

const BOTH = ["claude-code", "codex"];

describe("the preselection", () => {
  test("only one offered: that one, whatever the run or the setting say", () => {
    assert.deepEqual(preselect(["claude-code"], { run: "codex", lastUsed: "codex", setting: "codex" }), { id: "claude-code", why: "only" });
  });
  test("the run's (kiko codex) first: over the last used and over one pinned", () => {
    assert.deepEqual(preselect(BOTH, { run: "codex", lastUsed: "claude-code", setting: LAST_USED }), { id: "codex", why: "run" });
    assert.deepEqual(preselect(BOTH, { run: "codex", lastUsed: "claude-code", setting: "claude-code" }), { id: "codex", why: "run" });
  });
  test("no run's: the last used, with the setting at last used", () => {
    assert.deepEqual(preselect(BOTH, { run: null, lastUsed: "codex", setting: LAST_USED }), { id: "codex", why: "last used" });
  });
  test("an agent pinned: that one, even when another was used last", () => {
    assert.deepEqual(preselect(BOTH, { lastUsed: "codex", setting: "claude-code" }), { id: "claude-code", why: "pinned" });
    assert.deepEqual(preselect(BOTH, { lastUsed: "claude-code", setting: "codex" }), { id: "codex", why: "pinned" });
  });
  test("what isn't offered now doesn't count: a run's or pinned agent disconnected, a last used gone; then the first (the main one)", () => {
    assert.deepEqual(preselect(BOTH, { run: "opencode", lastUsed: "codex", setting: LAST_USED }), { id: "codex", why: "last used" });
    assert.deepEqual(preselect(BOTH, { lastUsed: "codex", setting: "pi" }), { id: "codex", why: "last used" });
    assert.deepEqual(preselect(BOTH, { lastUsed: "pi", setting: LAST_USED }), { id: "claude-code", why: "first" });
    assert.deepEqual(preselect(BOTH, { setting: LAST_USED }), { id: "claude-code", why: "first" });
  });
  test("a third agent is one more row, nothing else (agent-neutral)", () => {
    assert.deepEqual(preselect([...BOTH, "opencode"], { lastUsed: "opencode", setting: LAST_USED }), { id: "opencode", why: "last used" });
    assert.equal(asksWhich([...BOTH, "opencode"]), true);
  });
  test("why, as the picker's row says it", () => {
    assert.deepEqual((["run", "last used", "pinned", "first", "only"] as const).map(whyWords), ["this run", "last used", "your setting", "", ""]);
  });
});

describe("choosing without asking (voice, the phone's words)", () => {
  const base = { startable: BOTH, offered: BOTH, run: null, lastUsed: "codex", setting: LAST_USED };
  test("a named agent wins over the preselection, even one not connected", () => {
    assert.equal(chooseUnasked({ ...base, named: "claude-code", by: "voice" }).id, "claude-code");
    assert.equal(chooseUnasked({ ...base, named: "claude-code", by: "voice" }).how, "named");
    assert.deepEqual(chooseUnasked({ ...base, offered: ["claude-code"], named: "codex", by: "voice" }), { id: "codex", how: "named", preselected: { id: "claude-code", why: "only" } });
  });
  test("a name that isn't an agent that starts sessions (T3 Code) is no name", () => {
    assert.deepEqual(chooseUnasked({ ...base, named: "t3code", by: "voice" }), { id: "codex", how: "voice", preselected: { id: "codex", why: "last used" } });
  });
  test("one agent able to start sessions: that one, how only: no picker", () => {
    const only = chooseUnasked({ ...base, offered: ["claude-code"], by: "window" });
    assert.deepEqual(only, { id: "claude-code", how: "only", preselected: { id: "claude-code", why: "only" } });
    assert.equal(asksWhich(["claude-code"]), false);
  });
  test("several, nothing named: the preselected one, never asked (voice), or the window's when it can't ask", () => {
    assert.deepEqual(chooseUnasked({ ...base, by: "voice" }), { id: "codex", how: "voice", preselected: { id: "codex", why: "last used" } });
    assert.equal(chooseUnasked({ ...base, run: "claude-code", by: "voice" }).id, "claude-code");
    assert.equal(chooseUnasked({ ...base, by: "window" }).how, "preselected");
  });
});

describe("what's said as it opens", () => {
  const project = { kind: "project" as const, cwd: "/code/clipkit", how: "exact" as const, name: "clipkit", said: "clipkit" };
  const close = { kind: "project" as const, cwd: "/code/clip-kit", how: "close" as const, name: "clip-kit", said: "clipkid" };
  const scratch = (said: string | null) => ({ kind: "scratch" as const, said });
  test("the agent named only when more than one can start sessions, or the one starting isn't among them", () => {
    assert.equal(namesAgent(["claude-code"], "claude-code"), false, "Claude Code alone: as ever");
    assert.equal(namesAgent(BOTH, "claude-code"), true, "Claude Code, when Codex could have been it");
    assert.equal(namesAgent(BOTH, "codex"), true);
    assert.equal(namesAgent(["claude-code"], "codex"), true, "named, not connected");
  });
  test("its kind of session, said", () => {
    assert.deepEqual(["Codex", "Claude Code", "OpenCode"].map(sessionKind), ["a Codex session", "a Claude Code session", "an OpenCode session"]);
  });
  test("one agent only: the words as they always were", () => {
    const line = (where: Parameters<typeof openingLine>[0], extra: { cwd?: string; name?: string; there?: boolean } = {}) =>
      openingLine(where, { cwd: extra.cwd ?? "/code/x", name: extra.name ?? "", there: extra.there ?? false, kind: null });
    assert.equal(line(project), "Opening clipkit.");
    assert.equal(line(close), "Opening clip kit, the closest to clipkid.");
    assert.equal(line({ kind: "home", cwd: "/Users/me" }), "Opening one in your home folder.");
    assert.equal(line({ kind: "new", cwd: "/code/rocket-ship", said: "rocket ship" }, { cwd: "/code/rocket-ship" }), "Making rocket ship in code and opening it.");
    assert.equal(line({ kind: "new", cwd: "/code/rocket-ship", said: "rocket ship" }, { cwd: "/code/rocket-ship", there: true }), "There's already a rocket ship in code, so I'm opening that.");
    assert.equal(line(scratch("zorbo")), "I don't know zorbo, so I'm opening it in a scratch folder.");
    assert.equal(line(scratch(null), { name: "docs" }), "Opening docs in a scratch folder.");
    assert.equal(line(scratch(null)), "Opening a new session in a scratch folder.");
  });
  test("more than one: which agent, said", () => {
    const kind = sessionKind("Codex");
    const line = (where: Parameters<typeof openingLine>[0], extra: { cwd?: string; name?: string; there?: boolean } = {}) =>
      openingLine(where, { cwd: extra.cwd ?? "/code/x", name: extra.name ?? "", there: extra.there ?? false, kind });
    assert.equal(line(project), "Starting a Codex session in clipkit.");
    assert.equal(openingLine(project, { cwd: "/code/clipkit", name: "", there: true, kind: sessionKind("Claude Code") }), "Starting a Claude Code session in clipkit.");
    assert.equal(line(close), "Starting a Codex session in clip kit, the closest to clipkid.");
    assert.equal(line({ kind: "home", cwd: "/Users/me" }), "Starting a Codex session in your home folder.");
    assert.equal(line({ kind: "new", cwd: "/code/rocket-ship", said: "rocket ship" }, { cwd: "/code/rocket-ship" }), "Making rocket ship in code and starting a Codex session there.");
    assert.equal(
      line({ kind: "new", cwd: "/code/rocket-ship", said: "rocket ship" }, { cwd: "/code/rocket-ship", there: true }),
      "There's already a rocket ship in code, so I'm starting a Codex session there.",
    );
    assert.equal(line(scratch("zorbo")), "I don't know zorbo, so I'm starting a Codex session in a scratch folder.");
    assert.equal(line(scratch(null), { name: "docs" }), "Starting a Codex session named docs in a scratch folder.");
    assert.equal(line(scratch(null)), "Starting a Codex session in a scratch folder.");
  });
  test("where it opens, as the picker says it", () => {
    assert.equal(placeWords(project), "clipkit");
    assert.equal(placeWords({ kind: "home", cwd: "/Users/me" }), "your home folder");
    assert.equal(placeWords({ kind: "new", cwd: "/code/rocket-ship", said: "rocket ship" }), "rocket-ship (new)");
    assert.equal(placeWords(scratch(null)), "a scratch folder");
  });
});

describe("the agents offered (agents/index.ts offeredStarters)", () => {
  /** A made-up agent that starts sessions, whose setup stands at `state`. */
  const fakeAgent = (id: string, state: SetupState | null, starts = true): Agent =>
    ({
      id,
      name: id,
      starts,
      ...(state ? { setup: { id, name: id, about: "", file: () => "", installed: () => state !== "not installed", status: () => ({ state, detail: "" }) } as AgentSetup } : {}),
    }) as unknown as Agent;
  test("each that starts sessions and is connected (or needs repair), in order; not connected, not installed or not starting: left out", () => {
    const among = [
      fakeAgent("a", "connected"),
      fakeAgent("b", "not connected"),
      fakeAgent("c", "needs repair"),
      fakeAgent("d", "not installed"),
      fakeAgent("e", "connected", false),
      fakeAgent("f", null),
    ];
    assert.deepEqual(
      offeredStarters(among).map((a) => a.id),
      ["a", "c", "f"],
    );
  });
  test("none connected: the main one alone", () => {
    assert.deepEqual(offeredStarters([fakeAgent("b", "not connected")]), [mainAgent]);
  });
  test("each agent's setup says whether it starts sessions as its adapter does", () => {
    for (const a of agents) assert.equal(Boolean(a.setup?.starts), starters().includes(a), a.id);
  });
  test("enabled means connected, not installed: Claude Code connected, Codex installed but not connected → Claude Code alone (no picker)", () => {
    try {
      mkdirSync(process.env.CODEX_HOME!, { recursive: true }); // Codex's folder there: installed
      claudeCodeSetup.connect!();
      assert.equal(codexSetup.status().state, "not connected");
      assert.equal(claudeCodeSetup.status().state, "connected");
      const offered = offeredStarters().map((a) => a.id);
      assert.deepEqual(offered, ["claude-code"]);
      assert.equal(asksWhich(offered), false, "no picker");
      assert.equal(chooseUnasked({ startable: BOTH, offered, lastUsed: "codex", setting: "codex", by: "window" }).id, "claude-code", "started straight in it, whatever the setting says");
    } finally {
      claudeCodeSetup.disconnect!();
    }
  });
  test("the real ones, in this test's own homes: Claude Code alone until Codex is connected too; then both, the main one first", () => {
    try {
      assert.deepEqual(
        offeredStarters().map((a) => a.id),
        ["claude-code"],
      );
      claudeCodeSetup.connect!();
      assert.deepEqual(
        offeredStarters().map((a) => a.id),
        ["claude-code"],
      );
      codexSetup.connect!();
      assert.deepEqual(
        offeredStarters().map((a) => a.id),
        ["claude-code", "codex"],
      );
      claudeCodeSetup.disconnect!();
      assert.deepEqual(
        offeredStarters().map((a) => a.id),
        ["codex"],
        "Codex alone connected: Codex alone",
      );
    } finally {
      claudeCodeSetup.disconnect!();
      codexSetup.disconnect!();
    }
  });
});

describe('the "New sessions in" setting', () => {
  test("unset, empty or said as words: last used (the default); an agent pinned before keeps working", () => {
    assert.deepEqual([undefined, null, "", "  ", "last-used", "Last used", "last_used", "LASTUSED"].map(newSessionSetting), Array(8).fill(LAST_USED));
    assert.equal(newSessionSetting("claude-code"), "claude-code");
    assert.equal(newSessionSetting("codex"), "codex");
    assert.equal(newSessionSetting(" codex "), "codex");
  });
  test("this run, with no settings and nothing in the environment: last used", { skip: process.env.KIKO_NEW_SESSION_AGENT !== undefined && "KIKO_NEW_SESSION_AGENT is set here" }, () => {
    assert.equal(config.newSessionAgent, LAST_USED);
  });
  test("its choices: last used first, then each agent that starts sessions (T3 Code doesn't); a new adapter is a new row", () => {
    assert.deepEqual(
      NEW_SESSION_AGENTS.map((c) => c.value),
      [LAST_USED, "claude-code", "codex", "opencode"],
    );
    assert.equal(NEW_SESSION_AGENTS[0].label, "Last used");
    const pi = { id: "pi", name: "Pi", starts: true, about: "", file: () => "", installed: () => true, status: () => ({ state: "connected" as const, detail: "" }) };
    assert.deepEqual(
      newSessionChoices([...SETUPS, pi]).map((c) => c.label),
      ["Last used", "Claude Code", "Codex", "OpenCode", "Pi"],
    );
  });
  test("the last used remembered with the rest of the settings, written only when it changes", () => {
    try {
      saveSettings({ voiceCan: "everything" });
      rememberLastAgent("codex");
      assert.deepEqual(loadSettings(), { voiceCan: "everything", lastNewSessionAgent: "codex" });
      // Written by hand, compactly: the same one again leaves the file as it is.
      writeFileSync(SETTINGS_FILE, `{"voiceCan":"everything","lastNewSessionAgent":"codex"}`);
      rememberLastAgent("codex");
      assert.equal(readFileSync(SETTINGS_FILE, "utf8"), `{"voiceCan":"everything","lastNewSessionAgent":"codex"}`, "nothing rewritten for the same one");
      rememberLastAgent("claude-code");
      assert.equal(loadSettings().lastNewSessionAgent, "claude-code");
    } finally {
      rmSync(SETTINGS_FILE, { force: true });
    }
  });
});
