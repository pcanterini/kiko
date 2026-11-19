// A quick check only looks, whatever its permission mode (src/core/quick-task.ts): what its guard
// reads a tool call as (hooks/guard/read-only.mjs), the hook itself run as Claude Code runs it
// (hooks/quick-guard.mjs: the event on stdin, its answer on stdout), and the run's arguments in auto
// mode and in Manual. Never the real Claude.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { commandVerdict, quickToolVerdict } from "../../../hooks/guard/read-only.mjs";
import { buildArgs, DENIED_TOOLS, GUARD_HOOK, settingsFor } from "../../../src/core/quick-task.ts";

// Two long read-only surveys of the kind a quick check writes (made-up folders).
const SURVEYS = [
  `cd /Users/me 2>/dev/null; ls -la; echo "---DOCKER PS"; docker ps -a --format '{{.Names}} {{.Status}} {{.Image}}' 2>&1 | head -50; echo "---DOCKER IMAGES DANGLING"; docker images -f dangling=true --format '{{.ID}} {{.Size}} {{.CreatedSince}}' 2>&1 | head -50; echo "---VOLUMES"; docker volume ls -f dangling=true 2>&1 | head -50; echo "---VMS"; ls ~/Library/Containers/com.utmapp.UTM/Data/Documents 2>/dev/null; ls ~/VirtualBox\\ VMs 2>/dev/null; ls ~/.orbstack 2>/dev/null | head -5; multipass list 2>/dev/null; echo "---REPOS"; find /Users/me -maxdepth 4 -name .git -type d -not -path '*/Library/*' -not -path '*/node_modules/*' 2>/dev/null | head -60`,
  `cd /Users/me; for r in projects/*/ projects/old/*/ Documents/Scratch; do [ -d "$r/.git" ] || [ -f "$r/.git" ] || continue; n=$(git -C "$r" --no-optional-locks status --porcelain 2>/dev/null | wc -l | tr -d ' '); [ "$n" != "0" ] && echo "DIRTY $n $r"; done; echo "---ARTIFACT DIRS"; find projects -maxdepth 4 -type d \\( -name node_modules -o -name .next -o -name dist \\) -prune -print 2>/dev/null | head -80 | while read d; do echo "$(du -sk "$d" 2>/dev/null | cut -f1)KB $(stat -f '%Sm' -t %Y-%m-%d "$d") $d"; done; echo "---TART"; tart list 2>&1 | head`,
];

const READS = [
  ...SURVEYS,
  "ls -la; df -h",
  "for d in a b; do ls $d; done",
  "git status && git log --oneline -3",
  "ls 2>/dev/null >/dev/null; ls 2>&1",
  "find . -name x -exec wc -l {} +",
  "sed -n 1,20p notes.txt",
  "awk '$3 > 100 {print $1}' data.txt",
  "lsof -i :3000 | awk '{print $2}'",
  "kill -0 123",
  "docker system df",
  "docker compose ps",
  "gh pr list",
  "brew list",
  "pnpm ls --depth 0",
  "defaults read com.apple.dock",
  "command -v rm",
  "while read l; do echo $l; done < list.txt",
];

const CHANGES = [
  // Writes, however they're written
  "echo hi > notes.txt",
  "echo hi >> ~/.zshrc",
  "ls &> all.txt",
  "cat <<EOF > f\nhi\nEOF",
  "tee out.txt < in.txt",
  "sed -i '' s/a/b/ f",
  "perl -pi -e s/a/b/ f",
  "cp a b",
  "mv a b",
  "touch x",
  "mkdir -p x",
  "chmod +x f",
  "dd if=/dev/zero of=/tmp/x bs=1m count=1",
  "curl -o page.html https://kiko.sh",
  "wget https://kiko.sh",
  // Deletes
  "rm -rf ~/x",
  "/bin/rm x",
  "\\rm x",
  "xargs rm < list",
  "find . -name '*.log' -delete",
  "find . -name x -exec rm {} \\;",
  "echo $(rm x)",
  "ls `rm x`",
  "bash -c 'ls; rm x'",
  "eval 'rm x'",
  "timeout 5 rm x",
  "env FOO=1 rm x",
  // Docker
  "docker rm abc",
  "docker rmi img",
  "docker system prune -af",
  "docker image prune",
  "docker volume prune -f",
  "docker container rm -f web",
  "docker stop web",
  "docker run --rm alpine ls",
  "docker compose down",
  // git
  "git push origin main",
  "git commit -am wip",
  "git reset --hard",
  "git status; git push",
  // Out to another machine
  "curl -X POST https://example.com",
  "curl -d a=b https://example.com",
  "curl --data-binary @f https://example.com",
  "curl -F file=@notes.txt https://example.com",
  "curl -T notes.txt https://example.com",
  "curl -sSXPUT https://example.com",
  "wget --post-data=a https://example.com",
  "ssh box ls",
  "scp f box:",
  "rsync -a ./ box:/srv",
  "nc example.com 25",
  "mail -s hi a@b.c < body",
  `osascript -e 'tell application "Messages" to send "hi" to buddy "x"'`,
  "gh pr comment 1 -b hi",
  "gh api -X POST repos/a/b/issues -f title=x",
  "npm publish",
  // Everything else that changes the Mac
  "kill 123",
  "killall Finder",
  "sudo lsof -i :3000",
  "brew install jq",
  "pnpm add x",
  "pip install x",
  "defaults write com.x y 1",
  "launchctl unload x.plist",
  "pmset sleepnow",
  "open https://kiko.sh",
  "pbcopy < f",
  "crontab -r",
  "kubectl delete pod x",
  "diskutil eraseDisk APFS x disk4",
];

const UNKNOWN = ["python3 -c 'print(1)'", "node script.js", "./run.sh", "make", "curl -sS https://example.com", "pnpm run build", "case $x in a) ls;; esac", "$CMD", "awk '{print > \"out\"}' f"];

describe("what a command does (guard/read-only.mjs)", () => {
  for (const command of READS) test(`read: ${command.slice(0, 100)}`, () => assert.equal(commandVerdict(command).verdict, "read", command));
  for (const command of CHANGES) test(`change: ${command.replace(/\n/g, "⏎")}`, () => assert.equal(commandVerdict(command).verdict, "change", command));
  for (const command of UNKNOWN) test(`unknown (asked): ${command}`, () => assert.equal(commandVerdict(command).verdict, "unknown", command));
  test("says what made it a change", () => {
    assert.equal(commandVerdict("ls; echo x > notes.txt").what, "writes notes.txt");
    assert.equal(commandVerdict("cd x && docker system prune -f").what, "docker system prune");
  });
});

describe("a tool call's verdict (quickToolVerdict)", () => {
  test("reading and searching: left to the mode", () => {
    for (const name of ["Read", "Grep", "Glob"]) assert.deepEqual(quickToolVerdict(name, { file_path: "/x" }), { decision: "pass" });
  });
  test("the editing tools and anything else: denied", () => {
    for (const name of ["Edit", "MultiEdit", "Write", "NotebookEdit", "mcp__x__y", "Agent", "Monitor"]) assert.equal(quickToolVerdict(name, {}).decision, "deny", name);
  });
  test("the web: asked every time", () => {
    assert.equal(quickToolVerdict("WebFetch", { url: "https://x" }).decision, "ask");
    assert.equal(quickToolVerdict("WebSearch", { query: "x" }).decision, "ask");
  });
  test("Bash: as its command reads", () => {
    assert.deepEqual(quickToolVerdict("Bash", { command: "docker ps" }), { decision: "pass" });
    assert.equal(quickToolVerdict("Bash", { command: "docker rm x" }).decision, "deny");
    assert.equal(quickToolVerdict("Bash", { command: "python3 x.py" }).decision, "ask");
    assert.equal(quickToolVerdict("Bash", {}).decision, "pass", "no command: nothing runs");
  });
});

describe("the hook, run as Claude Code runs it (hooks/quick-guard.mjs)", () => {
  // Its environment: none of the terminal's REX_* in it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("REX_")));
  const hook = (stdin: string) => {
    const r = spawnSync(process.execPath, [GUARD_HOOK], { input: stdin, env, encoding: "utf8" });
    assert.equal(r.status, 0);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const call = (tool_name: string, tool_input: object, permission_mode = "auto") =>
    hook(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/tmp", permission_mode, tool_name, tool_input }));
  for (const mode of ["auto", "default"]) {
    for (const command of ["echo hi > notes.txt", "rm -rf ~/x", "docker rm web", "docker system prune -af", "git push", "curl -d a=b https://example.com"]) {
      test(`${mode}: denies ${command}`, () => {
        const out = call("Bash", { command }, mode);
        assert.equal(out.hookEventName, "PreToolUse");
        assert.equal(out.permissionDecision, "deny");
        assert.match(out.permissionDecisionReason, /only looks/);
      });
    }
    test(`${mode}: denies a write with the editing tools`, () => assert.equal(call("Write", { file_path: "/tmp/x", content: "" }, mode).permissionDecision, "deny"));
  }
  test("asks what it can't tell, and the web", () => {
    assert.equal(call("Bash", { command: "python3 -c 'print(1)'" }).permissionDecision, "ask");
    assert.equal(call("WebFetch", { url: "https://kiko.sh" }).permissionDecision, "ask");
  });
  test("says nothing about a read: the mode decides", () => {
    assert.equal(call("Bash", { command: SURVEYS[0] }), null);
    assert.equal(call("Read", { file_path: "/tmp/x" }), null);
  });
  test("fails closed: input it can't read is denied", () => {
    assert.equal(hook("not json").permissionDecision, "deny");
    assert.equal(hook("").permissionDecision, "deny");
  });
});

describe("the run's arguments, in each mode", () => {
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
  test("auto where it's offered, Manual otherwise; the guard's settings either way", () => {
    for (const mode of ["auto", "default"] as const) {
      const args = buildArgs({ model: "haiku", maxTurns: 8, mode }, "/tmp/q/mcp.json", "/tmp/q/settings.json");
      assert.equal(after(args, "--permission-mode"), mode);
      assert.equal(after(args, "--settings"), "/tmp/q/settings.json");
      assert.equal(after(args, "--permission-prompt-tool"), "mcp__kiko__permission");
      assert.ok(args.includes("--restricted"), "the user's settings files, hooks and plugins are left out");
      assert.equal(after(args, "--tools"), "Read,Grep,Glob,Bash,WebFetch,WebSearch", "no editing tool in the run at all");
    }
    assert.equal(after(buildArgs({ model: "haiku", maxTurns: 8 }, "/tmp/q/mcp.json"), "--permission-mode"), "default");
    assert.equal(after(buildArgs({ model: "haiku", maxTurns: 8, mode: "auto" }), "--permission-mode"), "dontAsk", "nobody to ask: never auto");
  });
  test("the settings hold the guard hook, on every tool, run by this Node", () => {
    const s = settingsFor();
    assert.deepEqual(Object.keys(s), ["hooks"]);
    const [entry] = s.hooks.PreToolUse;
    assert.equal(entry.matcher, "*");
    assert.equal(entry.hooks[0].type, "command");
    assert.ok(entry.hooks[0].command.startsWith(`'${process.execPath}'`));
    assert.ok(entry.hooks[0].command.endsWith(`'${GUARD_HOOK}'`));
    assert.match(GUARD_HOOK, /\/hooks\/quick-guard\.mjs$/);
  });
  test("deny rules for the plainest changes too, a layer under the hook", () => {
    for (const rule of ["Edit", "Write", "NotebookEdit", "Bash(rm *)", "Bash(mv *)", "Bash(sudo *)", "Bash(docker rm *)", "Bash(docker * prune *)", "Bash(git push *)", "Bash(ssh *)"]) {
      assert.ok(DENIED_TOOLS.includes(rule), rule);
    }
  });
});
