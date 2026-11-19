// Claude Code's trust question answered for real, through tmux: a throwaway tmux server (`tmux -L
// kiko-test-<random>-trust`, never Kiko's), the tmux adapter's `open`, `screen` (capture-pane)
// and `press`, and a fake `claude` that draws a trust menu as Claude Code does ("❯ No, exit" picked
// first; Down and Up move ❯; Enter takes what's picked; Escape exits) and starts (runs the real
// SessionStart hook, hooks/claude-code-hook.mjs, to a socket of this test's) only if "Yes, I trust this
// folder" was taken. core/trust-prompt.ts reads the screen and answers: Enter only once ❯ is seen on
// "Yes". Skipped when tmux isn't installed. Everything it makes is removed afterwards.
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { answerTrust, readTrustPrompt, sameFolder, type TrustKeys } from "../../../src/core/trust-prompt.ts";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, processes, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = throwawayServer("trust");
assert.notEqual(SERVER, "kiko");
const HOOK = fileURLToPath(new URL("../../../hooks/claude-code-hook.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-trust-")));
const conf = join(dir, "tmux.conf");
const socket = join(dir, "hooks.sock");
const tmux = tmuxRunner(SERVER, conf, cleanEnv());
const terminal = tmuxTerminal({
  tmux,
  ps: processes,
  show: async () => {},
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  installed: () => true,
  shell: "/bin/sh",
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(5000, 25);

/**
 * The fake claude, in raw mode: draws the trust menu in its folder; Down/Up move ❯ (not with
 * `stuck`); Enter on "No, exit" or Escape exits; Enter on "Yes" starts it: the SessionStart hook
 * runs. Every key it reads is noted in `keys` (one JSON string a line).
 */
function fakeClaude() {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [mode, keys, id] = process.argv.slice(2);
let picked = "no";
let started = false;
function draw() {
  process.stdout.write("\\x1b[2J\\x1b[H" + [
    "─".repeat(40),
    " Accessing workspace:",
    "",
    " " + process.cwd(),
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " " + (picked === "no" ? "❯" : " ") + " No, exit",
    " " + (picked === "yes" ? "❯" : " ") + " Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\\r\\n"));
}
process.stdin.setRawMode(true);
process.stdin.resume();
draw();
process.stdin.on("data", (d) => {
  const s = String(d);
  appendFileSync(keys, JSON.stringify(s) + "\\n");
  if (started) return;
  if (/^\\x1b(\\[|O)[AB]$/.test(s)) {
    if (mode !== "stuck") picked = picked === "no" ? "yes" : "no";
    return draw();
  }
  if (s === "\\x1b") process.exit(0);
  if (s === "\\r" || s === "\\n") {
    if (picked !== "yes") process.exit(1);
    started = true;
    process.stdout.write("\\x1b[2J\\x1b[H ✻ Welcome to Claude Code!\\r\\n\\r\\n> ");
    const hook = spawn(process.execPath, [${JSON.stringify(HOOK)}], {
      env: { ...process.env, KIKO_SOCKET: ${JSON.stringify(socket)}, CLAUDE_CODE_ENTRYPOINT: "cli" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: process.cwd(), source: "startup" }));
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("Claude Code's trust question answered through tmux, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  let server: Server;
  const told: any[] = [];
  let claude = "";

  before(async () => {
    copyFileSync(CONFIG, conf);
    writeFileSync(conf, `${readFileSync(conf, "utf8")}\nset -g exit-empty on\n`);
    claude = fakeClaude();
    server = createServer((conn) =>
      conn.on("data", (chunk) =>
        told.push(
          ...String(chunk)
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        ),
      ),
    );
    await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  });
  after(() => {
    server?.close();
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A session opened in its folder with the fake claude in `mode`, at its trust question: its pane, and what it read. */
  async function opened(name: string, mode: "normal" | "stuck") {
    const cwd = join(dir, `2026-10-29-${name}`);
    mkdirSync(cwd);
    const keys = join(dir, `${name}.keys`);
    let handle = "";
    await terminal.open!(cwd, { program: claude, args: [mode, keys, `fake-${name}`] }, (h) => (handle = h));
    assert.match(handle, /^%\d+$/);
    const seen = await until(async () => readTrustPrompt((await terminal.screen!(handle)) ?? ""), Boolean);
    assert.ok(sameFolder(seen!.folder, cwd, process.env.HOME ?? ""), `${seen!.folder} is ${cwd}`);
    assert.equal(seen!.selected, "no", '"No, exit" picked at first');
    const io: TrustKeys = {
      screen: () => terminal.screen!(handle),
      running: async () => (await terminal.program!(handle)) === "running",
      press: (key) => terminal.press!(handle, key),
      wait: async (ms) => void (await wait(ms)),
    };
    const read = () =>
      existsSync(keys)
        ? readFileSync(keys, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as string)
        : [];
    return { cwd, handle, io, read };
  }

  test('allowed: Down, ❯ seen on "Yes", then Enter; it starts (SessionStart)', async () => {
    const dozer = await opened("dozer", "normal");
    assert.deepEqual(await answerTrust(dozer.io, true), { ok: true, how: "down+enter" });
    const start: any = await until(() => told.find((e) => e.session_id === "fake-dozer"), Boolean);
    assert.equal(start.hook_event_name, "SessionStart");
    assert.equal(realpathSync(start.cwd), dozer.cwd);
    assert.equal(dozer.read().length, 2, "two keys and nothing else");
    assert.match(dozer.read()[0], /^\x1b(\[|O)B$/);
    assert.equal(dozer.read()[1], "\r");
    assert.equal(await terminal.program!(dozer.handle), "running");
  });

  test("the selection doesn't move: no Enter, it doesn't start, the question left on its screen", async () => {
    const rex = await opened("rex", "stuck");
    const r = await answerTrust(rex.io, true);
    assert.equal(r.ok, false);
    assert.match(r.why!, /didn't press Enter/);
    await wait(300);
    assert.ok(!rex.read().includes("\r"), "Enter never pressed");
    assert.ok(!told.some((e) => e.session_id === "fake-rex"), "not started");
    assert.deepEqual(readTrustPrompt((await terminal.screen!(rex.handle))!), { folder: rex.cwd, selected: "no" });
  });

  test("denied: Escape, and it exits before it starts", async () => {
    const max = await opened("max", "normal");
    assert.deepEqual(await answerTrust(max.io, false), { ok: true, how: "escape" });
    await until(
      () => terminal.program!(max.handle),
      (state) => state === "shell",
    );
    assert.ok(!told.some((e) => e.session_id === "fake-max"));
    // Its program gone, nothing more is pressed there.
    assert.deepEqual(await terminal.press!(max.handle, "enter"), { sent: false, why: "its program has ended" });
  });
});
