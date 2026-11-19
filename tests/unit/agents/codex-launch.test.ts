// The command lines of the Codex TUIs Kiko starts (src/agents/codex/launch.ts): its "An update is
// available" startup question always off, unless you set it; a folder Kiko made (a fresh scratch
// folder) trusted for that launch only, by its real path, as an inline table (a quoted dotted key
// doesn't work: Codex splits an override's key on every "."). Nothing here runs Codex.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { codexArgs, trustOverride, UPDATE_CHECK_KEY } from "../../../src/agents/codex/launch.ts";
import { codex } from "../../../src/agents/codex/index.ts";

const OFF = ["-c", "check_for_update_on_startup=false"];

describe("Codex's update question: off on every launch", () => {
  test("ours first, then what was asked for, untouched", () => {
    assert.equal(UPDATE_CHECK_KEY, "check_for_update_on_startup");
    assert.deepEqual(codexArgs([]), OFF);
    assert.deepEqual(codexArgs(["fix the login bug"]), [...OFF, "fix the login bug"]);
    assert.deepEqual(codexArgs(["resume", "--last"]), [...OFF, "resume", "--last"], "before a subcommand: Codex's root options");
    assert.deepEqual(codexArgs(["-m", "gpt-5.5", "-c", "model_reasoning_effort=high", "hi"]), [...OFF, "-m", "gpt-5.5", "-c", "model_reasoning_effort=high", "hi"]);
  });

  test("yours wins: any way you set it, ours is left out", () => {
    for (const yours of [
      ["-c", "check_for_update_on_startup=true"],
      ["--config", "check_for_update_on_startup=true"],
      ["-ccheck_for_update_on_startup=true"],
      ["--config=check_for_update_on_startup=true"],
      ["-c", " check_for_update_on_startup = true"],
      ["resume", "-c", "check_for_update_on_startup=true"],
    ]) {
      assert.deepEqual(codexArgs(yours), yours, yours.join(" "));
    }
  });

  test("words that only look like it don't count: a prompt, another key, after --", () => {
    assert.deepEqual(codexArgs(["check_for_update_on_startup=true"]), [...OFF, "check_for_update_on_startup=true"]);
    assert.deepEqual(codexArgs(["-c", "check_for_update_on_startup_x=true"]), [...OFF, "-c", "check_for_update_on_startup_x=true"]);
    assert.deepEqual(codexArgs(["--", "-c", "check_for_update_on_startup=true"]), [...OFF, "--", "-c", "check_for_update_on_startup=true"]);
    assert.deepEqual(codexArgs(["-C", "check_for_update_on_startup=true"]), [...OFF, "-C", "check_for_update_on_startup=true"], "-C is its folder");
  });
});

describe("a folder Kiko made: trusted for that launch", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiko-codex-launch-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("by its real path (macOS's temp folders are under /private), as an inline table", () => {
    const real = realpathSync(dir);
    assert.deepEqual(trustOverride(dir), ["-c", `projects={${JSON.stringify(real)}={trust_level="trusted"}}`]);
    assert.deepEqual(codexArgs(["hi"], { trusted: dir }), [...OFF, ...trustOverride(dir), "hi"]);
  });

  test("a path with quotes or backslashes stays one TOML string; one that can't be read is used as given", () => {
    assert.deepEqual(trustOverride('/nowhere/a "b"\\c'), ["-c", 'projects={"/nowhere/a \\"b\\"\\\\c"={trust_level="trusted"}}']);
    assert.deepEqual(trustOverride("/nowhere/x.y/z"), ["-c", 'projects={"/nowhere/x.y/z"={trust_level="trusted"}}'], "dots in the path are fine inside the table");
  });

  test("the adapter's start command: overrides, mode flags, prompt; trust only with madeFolder", () => {
    assert.deepEqual(codex.startCommand({ prompt: "", name: "" }), { program: "codex", args: OFF });
    assert.deepEqual(codex.startCommand({ prompt: "fix it", name: "docs", mode: "acceptEdits" }), {
      program: "codex",
      args: [...OFF, "-a", "on-request", "-s", "workspace-write", "fix it"],
    });
    assert.deepEqual(codex.startCommand({ prompt: "fix it", name: "", madeFolder: dir }), { program: "codex", args: [...OFF, ...trustOverride(dir), "fix it"] });
  });
});
