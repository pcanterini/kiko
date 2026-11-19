// Scratch sessions in auto (src/core/permission-mode.ts startModeFor, src/agents/claude-code/
// modes-offered.ts). The user's scratch session ran in Accept edits and asked six times about
// harmless read-only commands (2026-11-05), so a scratch session starts in auto where the installed
// Claude Code offers it (its `claude --help` choices, read once a run), while the setting is left at
// its default. Without auto (an older Claude Code, a help that can't be read) it starts as before;
// sessions in real project folders, a chosen setting, and other agents are untouched. `claude --help`
// is always a fake here: no real `claude` is ever run.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { claudeCode } from "../../../../src/agents/claude-code/index.ts";
import { modesInHelp, readHelpWith } from "../../../../src/agents/claude-code/modes-offered.ts";
import { codex } from "../../../../src/agents/codex/index.ts";
import { newSessionModeChosen, startModeFor, type NewSessionMode } from "../../../../src/core/permission-mode.ts";

// 2.1.318's --help, as Commander prints it (the line cut short around it).
const HELP_WITH_AUTO = `Usage: claude [options] [command] [prompt]

Options:
  --name <name>                                     Name this session
  --permission-mode <mode>                          Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --model <model>                                   Model for the current session (choices: "sonnet", "opus")
  -h, --help                                        Display help for command
`;

// The same, wrapped at 80 columns as Commander does for a narrow terminal.
const HELP_WRAPPED = `Options:
  --permission-mode <mode>  Permission mode to use for the session
                            (choices: "acceptEdits", "auto",
                            "bypassPermissions", "manual", "dontAsk",
                            "plan")
  -h, --help                Display help for command
`;

// An older Claude Code, before auto: its choices list has no "auto".
const HELP_WITHOUT_AUTO = `Options:
  --permission-mode <mode>  Permission mode to use for the session (choices: "acceptEdits", "bypassPermissions", "default", "plan")
  --model <model>           Model (choices: "auto", "sonnet")
`;

/** A fake `claude --help` that counts how often it's read. */
function fakeHelp(text: string | Error) {
  const read = { count: 0 };
  readHelpWith(async () => {
    read.count++;
    if (text instanceof Error) throw text;
    return text;
  });
  return read;
}

afterEach(() => readHelpWith());

describe("--permission-mode's choices in claude --help", () => {
  test("on one line, or wrapped over several", () => {
    const all = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
    assert.deepEqual(modesInHelp(HELP_WITH_AUTO), all);
    assert.deepEqual(modesInHelp(HELP_WRAPPED), all);
  });

  test("never another option's choices; none listed, or no such option: null", () => {
    assert.deepEqual(modesInHelp(HELP_WITHOUT_AUTO), ["acceptEdits", "bypassPermissions", "default", "plan"], "--model's auto isn't --permission-mode's");
    assert.equal(modesInHelp('  --permission-mode <mode>  Permission mode to use\n  --model <model>  Model (choices: "auto")\n'), null);
    assert.equal(modesInHelp("Usage: claude [options]\n  -h, --help  Display help\n"), null);
  });

  test("Claude Code says whether it takes a mode, its help read once a run", async () => {
    const read = fakeHelp(HELP_WITH_AUTO);
    assert.equal(await claudeCode.offersMode!("auto"), true);
    assert.equal(await claudeCode.offersMode!("plan"), true);
    assert.equal(read.count, 1, "read once, then kept");
  });

  test("without auto, or a help that can't be read (not installed, timed out): not offered, nothing thrown", async () => {
    fakeHelp(HELP_WITHOUT_AUTO);
    assert.equal(await claudeCode.offersMode!("auto"), false);
    const failed = fakeHelp(new Error("spawn claude ENOENT"));
    assert.equal(await claudeCode.offersMode!("auto"), false);
    assert.equal(await claudeCode.offersMode!("auto"), false);
    assert.equal(failed.count, 1, "a failed read is kept too: not tried at every start");
  });
});

describe("the mode a new session starts in", () => {
  // What startSession does: the mode, then the agent's command line with it.
  const startFor = async (agent: typeof claudeCode, scratch: boolean, setting: NewSessionMode = "acceptEdits", chosen = false) => {
    const start = await startModeFor({ scratch, setting, chosen, offersMode: agent.offersMode?.bind(agent) });
    return { ...start, command: agent.startCommand({ prompt: "check the disk", name: "Bobby", mode: start.mode }) };
  };

  test("a scratch session in Claude Code that offers auto: --permission-mode auto", async () => {
    fakeHelp(HELP_WITH_AUTO);
    const start = await startFor(claudeCode, true);
    assert.deepEqual(start.command, { program: "claude", args: ["--permission-mode", "auto", "--name", "Bobby", "check the disk"] });
    assert.equal(start.autoUnavailable, undefined);
  });

  test("a scratch session in Claude Code without auto: the setting's mode, as before, and said to be unavailable (logged)", async () => {
    fakeHelp(HELP_WITHOUT_AUTO);
    const start = await startFor(claudeCode, true);
    assert.deepEqual(start.command, { program: "claude", args: ["--permission-mode", "acceptEdits", "--name", "Bobby", "check the disk"] });
    assert.equal(start.autoUnavailable, true);
    fakeHelp(new Error("timed out"));
    assert.deepEqual((await startFor(claudeCode, true, "acceptEdits")).command.args.slice(0, 2), ["--permission-mode", "acceptEdits"]);
  });

  test("a session in a real project folder: unchanged, and claude --help never read", async () => {
    const read = fakeHelp(HELP_WITH_AUTO);
    for (const setting of ["acceptEdits", "manual", "plan", "inherit"] as const) {
      const start = await startFor(claudeCode, false, setting);
      assert.equal(start.mode, setting);
      assert.deepEqual(start.command, claudeCode.startCommand({ prompt: "check the disk", name: "Bobby", mode: setting }));
    }
    assert.equal(read.count, 0);
  });

  test("a setting you chose (saved or KIKO_NEW_SESSION_MODE) wins in scratch folders too", async () => {
    const read = fakeHelp(HELP_WITH_AUTO);
    for (const setting of ["acceptEdits", "manual", "plan", "inherit"] as const) assert.equal((await startFor(claudeCode, true, setting, true)).mode, setting);
    assert.equal(read.count, 0);
    assert.equal(newSessionModeChosen("plan"), true);
    assert.equal(newSessionModeChosen(" acceptEdits "), true, "the default, chosen, is still chosen");
    assert.equal(newSessionModeChosen(undefined), false);
    assert.equal(newSessionModeChosen("bypassPermissions"), false, "not one of its values: left at the default");
  });

  test("Codex in a scratch folder: as before (it can't say whether it offers a mode, so it's never asked)", async () => {
    fakeHelp(HELP_WITH_AUTO);
    assert.equal(codex.offersMode, undefined);
    const start = await startFor(codex, true);
    assert.equal(start.mode, "acceptEdits");
    assert.equal(start.autoUnavailable, undefined);
    assert.deepEqual(start.command, codex.startCommand({ prompt: "check the disk", name: "Bobby", mode: "acceptEdits" }));
  });
});
