// The helpers' stderr (src/platform/macos/native.ts helperStderrTo): the terminal as always, or, while
// first-run setup draws its own screen, a line at a time to the log instead (a helper's
// "[mic] error: no usable input device" once broke setup's screen). A plain `sh` stands in for a helper.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { helperErr, helperStderr, helperStderrTo } from "../../../../src/platform/macos/native.ts";

test("a helper's stderr: inherited by default; with a sink set, each line goes there, and back to the terminal once unset", async () => {
  assert.equal(helperErr(), "inherit");
  const lines: string[] = [];
  helperStderrTo((helper, line) => lines.push(`${helper}: ${line}`));
  try {
    assert.equal(helperErr(), "pipe");
    const proc = spawn("/bin/sh", ["-c", "echo 'error: no usable input device' >&2; echo second >&2"], { stdio: ["ignore", "ignore", helperErr()] });
    helperStderr("mic", proc);
    await new Promise((r) => proc.on("close", r));
    assert.deepEqual(lines, ["mic: error: no usable input device", "mic: second"]);
  } finally {
    helperStderrTo(null);
  }
  assert.equal(helperErr(), "inherit");
});
