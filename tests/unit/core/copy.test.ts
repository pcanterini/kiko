// core/copy.ts copyText, Settings → Account's Copy the code: the text given on stdin, never in the
// command line, and true only once the program took it. Never the real clipboard here: the program is
// the test's own (node, writing what it reads to a file of the test's).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { copyText } from "../../../src/core/copy.ts";

const dir = mkdtempSync(join(tmpdir(), "kiko-copy-"));

describe("copyText", () => {
  test("the text goes on stdin, exactly, and nothing of it in the command line", async () => {
    const out = join(dir, "copied.txt");
    const argv = join(dir, "argv.json");
    const script = `const fs=require("fs");fs.writeFileSync(${JSON.stringify(argv)},JSON.stringify(process.argv));fs.writeFileSync(${JSON.stringify(out)},fs.readFileSync(0))`;
    assert.equal(await copyText("ABCD-EFGH", { program: process.execPath, args: ["-e", script] }), true);
    assert.equal(readFileSync(out, "utf8"), "ABCD-EFGH");
    assert.ok(!readFileSync(argv, "utf8").includes("ABCD-EFGH"));
  });

  test("a program that fails, or isn't there: false, never a throw", async () => {
    assert.equal(await copyText("ABCD-EFGH", { program: process.execPath, args: ["-e", "process.exit(3)"] }), false);
    assert.equal(await copyText("ABCD-EFGH", { program: join(dir, "no-such-program") }), false);
  });

  test("a program that never ends: false once its time is up", async () => {
    assert.equal(await copyText("ABCD-EFGH", { program: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 200 }), false);
  });
});
