// The app's state file for the status line (src/app/status.ts writeState), which lives in /tmp:
// written through a temp file of a name of its own, made new,
// so a link left at the old fixed temp name (/tmp/kiko.state.json.tmp) to a file of yours is never
// written through; the file is yours only (0600). Here in this test's own folder (KIKO_STATE).
import "../../setup.ts";
import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STATE = join(process.cwd(), "state.json");
process.env.KIKO_STATE = STATE;
const { writeState } = await import("../../../src/app/status.ts");

test("a link at the old temp name is never written through; the state file is a plain file, 0600", () => {
  const victim = join(process.cwd(), "victim.txt");
  writeFileSync(victim, "mine\n");
  symlinkSync(victim, `${STATE}.tmp`);
  writeState();
  assert.equal(readFileSync(victim, "utf8"), "mine\n");
  assert.ok(lstatSync(STATE).isFile(), "not the link");
  assert.equal(statSync(STATE).mode & 0o777, 0o600);
  assert.equal(typeof JSON.parse(readFileSync(STATE, "utf8")).updatedAt, "number");
  // No temp file of its own left behind.
  assert.deepEqual(
    readdirSync(process.cwd()).filter((f) => f.startsWith("state.json.") && f !== "state.json.tmp"),
    [],
  );
});
