// install.sh's first check, before anything is downloaded: a coding agent Kiko talks to, found
// the way setup finds it (Claude Code, Codex, OpenCode on the PATH or in ~/.opencode/bin, T3 Code in
// ~/.t3 or KIKO_T3_HOME). With none, it says so, naming all four; with any one, nothing. Run
// for real up to there, with no terminal (a session of its own) and a feed that isn't there, so
// it stops right after with "couldn't fetch": nothing is downloaded or installed. A throwaway HOME.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "cbia-"));
after(() => rmSync(root, { recursive: true, force: true }));
const NONE = "Kiko talks to Claude Code, Codex, OpenCode or T3 Code, and none is installed.";

let n = 0;
/** install.sh in a fresh HOME, `put` there first (paths under HOME made executable), and `more` in its environment. */
function run(put: string[] = [], more: Record<string, string> = {}): Promise<{ status: number | null; out: string; home: string }> {
  const home = join(root, `home-${n++}`);
  const bin = join(home, "agents");
  mkdirSync(bin, { recursive: true });
  for (const rel of put) {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env = { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, KIKO_RELEASES_URL: `file://${join(root, "no-feed")}`, KIKO_NO_SETUP: "1", ...more };
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [join(REPO, "install.sh")], { env, cwd: home, detached: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (status) => resolve({ status, out, home }));
    child.stdin.end();
  });
}

describe("install.sh: a coding agent first", { skip: process.platform !== "darwin" ? "macOS only" : false }, () => {
  test("none: says so, naming all four, and how to get one; asks nothing without a terminal", async () => {
    const r = await run();
    assert.ok(r.out.includes(NONE), r.out);
    assert.match(r.out, /get one later, for example:/);
    assert.ok(!r.out.includes("[Y/n]"));
    assert.match(r.out, /couldn't fetch/, "then on to the download, which isn't there");
    assert.notEqual(r.status, 0);
  });
  for (const [what, put, more] of [
    ["Claude Code on the PATH", ["agents/claude"], {}],
    ["Claude Code in ~/.claude/local", [".claude/local/claude"], {}],
    ["Codex on the PATH", ["agents/codex"], {}],
    ["OpenCode on the PATH", ["agents/opencode"], {}],
    ["OpenCode in its installer's ~/.opencode/bin", [".opencode/bin/opencode"], {}],
    ["T3 Code in ~/.t3", [".t3/bin/t3"], {}],
    ["T3 Code in KIKO_T3_HOME", ["elsewhere/t3/bin/t3"], { home: "elsewhere/t3" }],
  ] as const)
    test(`${what}: found, nothing said`, async () => {
      const home = join(root, `home-${n}`);
      const r = await run([...put], "home" in more ? { KIKO_T3_HOME: join(home, more.home) } : {});
      assert.ok(!r.out.includes("none is installed"), r.out);
      assert.match(r.out, /couldn't fetch/);
    });
});
