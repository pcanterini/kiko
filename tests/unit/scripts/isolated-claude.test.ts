// scripts/isolated-claude.sh: a real `claude` for a live check, kept out of the user's own (their Kiko,
// `claude agents`, ~/.claude/projects). Run here with a fake `claude` first on the PATH, which writes
// what it was given (the variables' names only) and leaves what a session leaves in its config folder
// (a transcript, a process record). Nothing real: the test's own temp folder (tests/setup.ts TMPDIR),
// and a made-up HOME where one is refused.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";

const SCRIPT = resolve(import.meta.dirname, "../../../scripts/isolated-claude.sh");

const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
// What it was given, then what a session leaves; `sleep` as its first argument: waits to be killed.
writeFileSync(
  join(bin, "claude"),
  `#!/bin/sh
out="$FAKE_OUT"
echo "dir=$CLAUDE_CONFIG_DIR" >"$out"
echo "leaked=$(env | sed -nE 's/^((KIKO|REX)_[A-Za-z0-9_]*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)=.*/\\1/p' | tr '\\n' ' ')" >>"$out"
echo "settings=$(cat "$CLAUDE_CONFIG_DIR/settings.json")" >>"$out"
echo "args=$*" >>"$out"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/-tmp-live-check-tmp" "$CLAUDE_CONFIG_DIR/sessions"
echo '{}' >"$CLAUDE_CONFIG_DIR/projects/-tmp-live-check-tmp/s.jsonl"
echo '{}' >"$CLAUDE_CONFIG_DIR/sessions/$$.json"
echo ready >>"$out"
[ "$1" = sleep ] && exec sleep 30
exit 3
`,
  { mode: 0o755 },
);

type Run = { code: number | null; out: Record<string, string> };

/** The script run with `env` added (a KIKO_, a REX_ variable and CLAUDECODE always, as an agent's shell has). */
function run(args: string[], env: Record<string, string> = {}, onReady?: (pid: number) => void): Promise<Run> {
  const out = join(mkdtempSync(join(tmpdir(), "out-")), "out.txt");
  const child = spawn(SCRIPT, args, {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_OUT: out, KIKO_SOCKET: "/nowhere.sock", REX_SOCKET: "/nowhere-rex.sock", CLAUDECODE: "1", ...env },
    stdio: "ignore",
    detached: true,
  });
  let poll: NodeJS.Timeout | undefined;
  if (onReady)
    poll = setInterval(() => {
      if (existsSync(out) && readFileSync(out, "utf8").includes("ready")) {
        clearInterval(poll);
        onReady(child.pid!);
      }
    }, 20);
  return new Promise((done) =>
    child.on("close", (code) => {
      clearInterval(poll);
      const text = existsSync(out) ? readFileSync(out, "utf8") : "";
      const kv = Object.fromEntries(text.split("\n").flatMap((l) => (l.includes("=") ? [[l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]] : [])));
      done({ code, out: kv });
    }),
  );
}

describe("scripts/isolated-claude.sh", () => {
  test("a config folder of its own under the temp folder, never ~/.claude; hooks off; nothing of an app's, Rex's or a parent Claude's passed on; all of it gone after, its exit status kept", async () => {
    const { code, out } = await run(["--permission-mode", "default"]);
    assert.equal(code, 3, "claude's own exit status");
    assert.ok(out.dir.startsWith(realpathSync(tmpdir())), out.dir);
    assert.ok(!out.dir.includes("/.claude"), "never a ~/.claude");
    assert.ok(out.dir.includes("kiko-claude."));
    assert.equal(out.leaked.trim(), "", "no KIKO_, REX_, CLAUDECODE");
    assert.deepEqual(JSON.parse(out.settings), { disableAllHooks: true });
    assert.equal(out.args, "--permission-mode default");
    assert.equal(existsSync(out.dir), false, "its temporary config folder removed: no transcript, no process record left");
  });

  test("KIKO_TEST_CLAUDE_HOME (logged in once): used and kept, its login and settings too; what the run left (projects, sessions) removed", async () => {
    const home = mkdtempSync(join(tmpdir(), "test-claude-home-"));
    writeFileSync(join(home, ".credentials.json"), "{}");
    writeFileSync(join(home, "settings.json"), '{ "disableAllHooks": true, "theme": "dark" }\n');
    const { code, out } = await run([], { KIKO_TEST_CLAUDE_HOME: home });
    assert.equal(code, 3);
    assert.equal(out.dir, realpathSync(home));
    assert.equal(out.leaked.trim(), "", "KIKO_TEST_CLAUDE_HOME itself isn't passed on either");
    assert.deepEqual(readdirSync(home).sort(), [".credentials.json", "settings.json"]);
    assert.equal(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).theme, "dark", "its own settings kept as they are");
  });

  test("its tmux server killed (HUP to the pane's processes): cleaned up all the same", async () => {
    let dir = "";
    const { code } = await run(["sleep"], {}, (pid) => {
      process.kill(-pid, "SIGHUP");
    }).then((r) => ((dir = r.out.dir), r));
    assert.ok(dir.includes("kiko-claude."), dir);
    assert.notEqual(code, 0);
    assert.equal(existsSync(dir), false);
  });

  test("refuses your own config (HOME, or ~/.claude and what's in it): claude never started", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, ".claude", "work"), { recursive: true });
    for (const own of [home, join(home, ".claude"), join(home, ".claude", "work")]) {
      const { code, out } = await run([], { HOME: home, KIKO_TEST_CLAUDE_HOME: own });
      assert.equal(code, 2, own);
      assert.equal(out.dir, undefined, "the fake claude didn't run");
    }
    assert.deepEqual(readdirSync(join(home, ".claude")), ["work"], "nothing written there");
  });
});
