// What each agent says its sessions get (src/agents/support.ts, src/agents/<agent>/support.ts), kept
// honest: every agent declares every feature with a reason where it isn't a plain yes; each
// declaration that can be checked against its adapter is (an agent with `rename` can't say renaming
// isn't built, one without a PermissionDenied hook can't say auto mode's blocks are said); and
// SUPPORT.md is what `pnpm support` writes from them now.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { HookHeld, type HookEvent } from "../../../src/agents/claude-code/hooks.ts";
import { HOOK_TIMEOUTS } from "../../../src/agents/claude-code/settings.ts";
import { CodexHeld, type CodexEvent } from "../../../src/agents/codex/hooks.ts";
import { CODEX_HOOKS } from "../../../src/agents/codex/setup.ts";
import { agents, mainAgent } from "../../../src/agents/index.ts";
import { namedAtStart } from "../../../src/core/can.ts";
import { SUPPORT, SUPPORT_FILE, supportDoc } from "../../../src/agents/support-matrix.ts";
import { type Feature, FEATURES, type Status, STATUSES } from "../../../src/agents/support.ts";
import type { Agent, Held } from "../../../src/agents/types.ts";
import type { NewSessionMode } from "../../../src/core/permission-mode.ts";
import { asksOnScreen } from "../../../src/core/trust-prompt.ts";

const declared = (a: Agent) => {
  const found = SUPPORT.find((s) => s.id === a.id);
  assert.ok(found, `${a.name} has no declaration of what it supports: add src/agents/${a.id}/support.ts to SUPPORT (src/agents/support-matrix.ts)`);
  return found;
};

/** `a`'s declaration of `f` is one of `allowed`, since `because` (what its adapter shows). */
function must(a: Agent, f: Feature, allowed: readonly Status[], because: string) {
  const status = declared(a).features[f].status;
  assert.ok(allowed.includes(status), `${a.name} declares "${FEATURES[f].label}" as ${status}, but ${because}: it should be ${allowed.join(" or ")} (src/agents/${a.id}/support.ts)`);
}

const YES: Status[] = ["yes"];
/** Done, all of it or some. */
const DONE: Status[] = ["yes", "partial"];
/** Anything but a plain yes. */
const NOT_ALL: Status[] = ["partial", "tool-limit", "not-built", "n/a"];
/** Not done at all. */
const NONE: Status[] = ["tool-limit", "not-built", "n/a"];

describe("what each agent supports", () => {
  test("every agent declares every feature, in the order of `agents`, with a reason for each that isn't a plain yes", () => {
    assert.deepEqual(
      SUPPORT.map((s) => [s.id, s.name]),
      agents.map((a) => [a.id, a.name]),
      "SUPPORT (src/agents/support-matrix.ts) lists each agent of src/agents/index.ts, in its order, by its id and name",
    );
    for (const s of SUPPORT) {
      assert.deepEqual(Object.keys(s.features).sort(), Object.keys(FEATURES).sort(), `${s.name} declares exactly the features in src/agents/support.ts`);
      for (const [f, support] of Object.entries(s.features)) {
        assert.ok(STATUSES.includes(support.status), `${s.name}'s ${f}: ${support.status} isn't a status`);
        if (support.status !== "yes") assert.ok(support.why?.trim(), `${s.name}'s ${f} is ${support.status}: say why`);
      }
    }
  });

  test("SUPPORT.md is up to date with the declarations", () => {
    const written = existsSync(SUPPORT_FILE) ? readFileSync(SUPPORT_FILE, "utf8") : "";
    assert.ok(written === supportDoc(), "SUPPORT.md is out of date with src/agents/*/support.ts: run `pnpm support` and commit it");
  });

  test("in Kiko's tmux: words, Interrupt, Rename and Close as its adapter types them (none for one in its own app)", () => {
    for (const a of agents) {
      if (a.ownApp) {
        for (const f of ["wordsInTmux", "interruptInTmux", "renameInTmux", "closeInTmux"] as const) must(a, f, ["n/a"], "its sessions are in its own app (`ownApp`)");
        continue;
      }
      must(a, "wordsInTmux", YES, "its sessions run in a terminal, and tmux types into any of its panes");
      if (a.interruptKey || a.interrupt) must(a, "interruptInTmux", YES, "it has an `interruptKey` or `interrupt`");
      else must(a, "interruptInTmux", NONE, "it has no `interruptKey` and no `interrupt`");
      if (a.renameCommand("docs") || a.rename) must(a, "renameInTmux", YES, "it has a `renameCommand` or `rename`");
      else must(a, "renameInTmux", NONE, "it has no `renameCommand` and no `rename`");
      if (a.exitCommand) must(a, "closeInTmux", DONE, "it has an `exitCommand`");
      else must(a, "closeInTmux", NONE, "it has no `exitCommand`");
    }
  });

  test("outside it: what the agent does itself (Agent.interrupt, rename, end, message); keys reach only a Ghostty window found for sure", () => {
    for (const a of agents) {
      if (a.interrupt) must(a, "interruptOutside", DONE, "it has `interrupt`");
      else must(a, "interruptOutside", NOT_ALL, "it has no `interrupt`, so only keys (a Ghostty window found for sure) interrupt one outside Kiko's tmux");
      if (a.rename) must(a, "renameOutside", DONE, "it has `rename`");
      else must(a, "renameOutside", NOT_ALL, "it has no `rename`, so only keys (a Ghostty window found for sure) rename one outside Kiko's tmux");
      if (a.end) must(a, "closeOutside", DONE, "it has `end`");
      else must(a, "closeOutside", NONE, "it has no `end`");
      if (a.message || a.ownApp) must(a, "wordsOutside", DONE, "it takes words itself (`message`, or its own app's adapter)");
      else must(a, "wordsOutside", NOT_ALL, "it has no `message`, so words go in only where keys reach it");
    }
  });

  test("starting one: as its startCommand says (prompt, name, the permission mode), and only for one that `starts` or `launches`", () => {
    const modes: NewSessionMode[] = ["manual", "acceptEdits", "plan", "auto"];
    for (const a of agents) {
      if (!a.starts && a.launches) {
        // Started in its own app (T3 Code: its server makes the thread): no startCommand to read, so
        // its first message, name and mode are its declaration's to say.
        must(a, "start", DONE, "it `launches` sessions in its own app");
        continue;
      }
      if (!a.starts) {
        for (const f of ["start", "startPrompt", "startName", "startMode"] as const) must(a, f, NONE, "Kiko doesn't start its sessions (no `starts`, no `launches`)");
        must(a, "startHeldWords", ["n/a"], "Kiko doesn't start its sessions (no `starts`, no `launches`)");
        continue;
      }
      must(a, "start", YES, "it `starts`");
      must(a, "startHeldWords", YES, "it `starts`, and words for one starting are held for it");
      const args = (start: { prompt?: string; name?: string; mode?: NewSessionMode }) => a.startCommand({ prompt: "", name: "", ...start }).args;
      if (args({ prompt: "fix the tests" }).includes("fix the tests")) must(a, "startPrompt", YES, "its startCommand passes the prompt");
      else must(a, "startPrompt", NONE, "its startCommand doesn't pass the prompt");
      if (args({ name: "docs" }).includes("docs") || a.namesLater) must(a, "startName", YES, "its startCommand names it, or it's renamed once listed (`namesLater`)");
      else must(a, "startName", NONE, "its startCommand doesn't name it, and it isn't `namesLater`");
      const plain = JSON.stringify(args({ mode: "inherit" }));
      const mapped = modes.filter((mode) => JSON.stringify(args({ mode })) !== plain);
      if (mapped.length === modes.length) must(a, "startMode", YES, "its startCommand passes every mode");
      else if (mapped.length) must(a, "startMode", ["partial"], `its startCommand passes only ${mapped.join(", ")}`);
      else must(a, "startMode", NONE, "its startCommand passes no mode");
    }
  });

  test("what core does for the main agent's sessions alone (a turn that couldn't log in, its projects by name), and the trust card for the agents whose screens it reads", () => {
    // core/trust-prompt.ts asksOnScreen: whose trust questions are read off a pane (Claude Code's, Codex's).
    for (const a of agents) if (asksOnScreen(a.id)) must(a, "trustCard", YES, "core/trust-prompt.ts reads its trust questions");
    // app/starting.ts: loginWatched is `agentOf(session) === mainAgent`; agents/index.ts together: knownFolders is the main agent's.
    for (const a of agents) {
      for (const f of ["loginFailed", "knownFolders"] as const) {
        if (a === mainAgent) must(a, f, YES, "it's the main agent");
        else must(a, f, NOT_ALL, "core does it for the main agent's sessions only");
      }
    }
  });

  test("an agent heard through hooks: what its hooks are on", () => {
    const hooks: Record<string, string[]> = { "claude-code": Object.keys(HOOK_TIMEOUTS), codex: Object.keys(CODEX_HOOKS) };
    for (const a of agents) {
      const events = hooks[a.id];
      if (!events) continue;
      must(a, "heard", events.includes("Stop") ? YES : NOT_ALL, `its hooks are ${events.includes("Stop") ? "" : "not "}on Stop`);
      must(a, "permissions", events.includes("PermissionRequest") ? YES : NOT_ALL, `its hooks are ${events.includes("PermissionRequest") ? "" : "not "}on PermissionRequest`);
      must(a, "promptStarted", events.includes("UserPromptSubmit") ? YES : NOT_ALL, `its hooks are ${events.includes("UserPromptSubmit") ? "" : "not "}on UserPromptSubmit`);
      // The note beside a dictated prompt is that hook's output: without it, none.
      if (!events.includes("UserPromptSubmit")) must(a, "dictatedNote", NOT_ALL, "its hooks are not on UserPromptSubmit");
      must(a, "autoBlocks", events.includes("PermissionDenied") ? YES : NOT_ALL, `its hooks are ${events.includes("PermissionDenied") ? "" : "not "}on PermissionDenied`);
    }
  });

  test("an agent heard through hooks: what a prompt it holds can be answered with (always, its questions)", () => {
    class Claude extends HookHeld {
      get open() {
        return true;
      }
      protected send() {
        return true;
      }
    }
    class Codex extends CodexHeld {
      get open() {
        return true;
      }
      protected send() {
        return true;
      }
    }
    // A prompt that offers "always" (Claude Code's permission_suggestions), and the agent's questions.
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "localSettings" }];
    const questions = { questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] };
    const claude: HookEvent = { hook_event_name: "PermissionRequest", session_id: "s", cwd: "/x", tool_name: "Bash", tool_input: { command: "ls" }, permission_suggestions: suggestions };
    const codex: CodexEvent = { agent: "codex", hook_event_name: "PermissionRequest", session_id: "s", cwd: "/x", tool_name: "Bash", tool_input: { command: "ls" } };
    const held: Record<string, { always: Held; asking: Held }> = {
      "claude-code": { always: new Claude(claude), asking: new Claude({ ...claude, tool_name: "AskUserQuestion", tool_input: questions }) },
      codex: { always: new Codex({ ...codex, permission_suggestions: suggestions } as CodexEvent), asking: new Codex({ ...codex, tool_name: "request_user_input", tool_input: questions }) },
    };
    for (const a of agents) {
      const its = held[a.id];
      if (!its) continue;
      must(a, "allowAlways", its.always.canAllowAlways ? YES : NOT_ALL, `its held prompt ${its.always.canAllowAlways ? "can" : "can't"} be allowed always`);
      must(a, "questions", its.asking.questions ? YES : NOT_ALL, `its held prompt ${its.asking.questions ? "has" : "never has"} questions`);
    }
  });

  test("how it's heard, named and shown: a reply window, who spoke, its mark, its setup", () => {
    for (const a of agents) {
      must(a, "replyWindow", a.heldReplies > 0 ? DONE : NONE, `it takes ${a.heldReplies} replies through a held turn (\`heldReplies\`)`);
      must(a, "speaker", a.speaker ? YES : NOT_ALL, a.speaker ? `its \`speaker\` is "${a.speaker}"` : "it has no `speaker`");
      must(a, "mark", a.mark ? YES : NOT_ALL, a.mark ? "it has a `mark`" : "it has no `mark`");
      must(a, "setup", a.setup ? YES : NOT_ALL, a.setup ? "it has a `setup`" : "it has no `setup`");
      // agents/setup.ts upgradeHooks: only a setup with a hooks file of its own (its `hookEvents`, `connect`, no `linkWords`).
      const upgraded = Boolean(a.setup?.hookEvents && a.setup.connect && !a.setup.linkWords);
      must(a, "hooksCurrent", upgraded ? YES : ["n/a"], upgraded ? "the start's upgrade adds what its hooks file lacks" : "it has no hooks file the start's upgrade reaches");
    }
  });

  test("named as it starts (the phone's sheet offers a name: canName) exactly where it says it starts with a name", () => {
    for (const a of agents) {
      if (!a.starts && !a.launches) continue;
      if (namedAtStart(a)) must(a, "startName", YES, "the phone's sheet offers it a name (core/can.ts namedAtStart)");
      else must(a, "startName", NONE, "the phone's sheet offers it no name (core/can.ts namedAtStart)");
    }
    // One named only later, with no way to rename it (none of its own, nothing to type): no name, and the sheet says so.
    const base = agents.find((a) => a.namesLater)!;
    const unnamable = { ...base, rename: undefined, renameCommand: () => "" } as Agent;
    assert.equal(namedAtStart(unnamable), false);
    assert.equal(namedAtStart({ ...unnamable, renameCommand: (n: string) => `/rename ${n}` } as Agent), true, "typed once it's idle");
    assert.equal(namedAtStart({ ...unnamable, namesLater: undefined } as Agent), true, "its command names it");
  });
});
