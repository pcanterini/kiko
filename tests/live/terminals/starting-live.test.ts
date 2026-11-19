// A session the app opens that waits at Claude Code's trust prompt before it starts, for real: a
// throwaway tmux server (`tmux -L kiko-test-<random>-starting`, never Kiko's), the tmux
// adapter's `open` (its pane told as it opens) and `program`, and a fake `claude` that shows a trust
// prompt and runs the real SessionStart hook (hooks/claude-code-hook.mjs) only once it's "answered" (a gate
// file appears), to a socket of this test's. Until then it's listed as starting (core/starting.ts)
// and can't be typed into; once the hook says it started, it's matched to its pane by the pid the
// hook sent, and words go in. One that quits at the prompt ("No, exit") has ended. Skipped when tmux
// isn't installed. Everything it makes is removed afterwards.
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import type { Session } from "../../../src/core/sessions.ts";
import { StartingSessions } from "../../../src/core/starting.ts";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, processes, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = throwawayServer("starting");
assert.notEqual(SERVER, "kiko");
const HOOK = fileURLToPath(new URL("../../../hooks/claude-code-hook.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-starting-")));
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
 * The fake claude: shows a trust prompt; once `gate` exists (the user said yes), runs the SessionStart
 * hook as Claude Code does and takes input, every line going into `typed`; "/exit" ends it. With
 * `exit-now` as its gate, it quits at the prompt after a moment ("No, exit"). Everything it reads
 * before starting goes into `early`.
 */
function fakeClaude() {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!${process.execPath}
const { appendFileSync, existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [gate, typed, early] = process.argv.slice(2);
process.stdout.write("Accessing workspace:\\n\\n ❯ 1. Yes, I trust this folder\\n   2. No, exit\\n");
let started = false;
process.stdin.on("data", (d) => {
  appendFileSync(started ? typed : early, d);
  if (started && String(d).includes("/exit")) process.exit(0);
});
if (gate === "exit-now") setTimeout(() => process.exit(0), 600);
const check = setInterval(() => {
  if (gate === "exit-now" || !existsSync(gate)) return;
  clearInterval(check);
  started = true;
  const hook = spawn(process.execPath, [${JSON.stringify(HOOK)}], {
    env: { ...process.env, KIKO_SOCKET: ${JSON.stringify(socket)}, CLAUDE_CODE_ENTRYPOINT: "cli" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  hook.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "fake-dozer", cwd: process.cwd(), source: "startup" }));
}, 50);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe("a session at Claude Code's trust prompt, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
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

  test("starting until its SessionStart, never typed into; then matched to its pane, and words go in", async () => {
    const cwd = join(dir, "2026-10-29-dozer");
    mkdirSync(cwd);
    const gate = join(dir, "dozer.gate");
    const typed = join(dir, "dozer.typed");
    const early = join(dir, "dozer.early");
    let handle = "";
    await terminal.open!(cwd, { program: claude, args: [gate, typed, early] }, (h) => (handle = h));
    assert.match(handle, /^%\d+$/, "its pane, told as it opened");

    const starting = new StartingSessions();
    const entry = starting.add({ cwd, name: "Dozer", via: "tmux", handle, known: [] });
    await until(
      () => terminal.program!(handle),
      (state) => state === "running",
    );
    assert.equal(starting.ended(entry, "running"), false);

    // Listed as starting, its pane its place: typing there is refused (no process to check), so
    // nothing reaches the trust prompt.
    const [dozer] = starting.sessions();
    assert.equal(dozer.status, "starting");
    const refused = await terminal.type(dozer.place!, "What is the capital of Germany?");
    assert.equal(refused.sent, false);
    await wait(300);
    assert.equal(told.length, 0, "no SessionStart while it waits");
    assert.equal(existsSync(early) ? readFileSync(early, "utf8") : "", "", "nothing typed at the trust prompt");
    assert.deepEqual(starting.match([]), []);

    // "Yes, I trust this folder": Claude Code starts and runs SessionStart.
    writeFileSync(gate, "");
    const start: any = await until(() => told.find((e) => e.hook_event_name === "SessionStart"), Boolean);
    assert.equal(start.session_id, "fake-dozer");
    assert.equal(realpathSync(start.cwd), cwd);
    assert.ok(Number.isInteger(start.pid), "the hook says which process ran it");

    // Listed by its agent now (pid from the hook, as its record would give it): found in its pane, and matched by it.
    const found = await terminal.find(Promise.resolve([{ sessionId: "fake-dozer", cwd, kind: "interactive" as const, desktop: false, titles: [], pid: start.pid }]));
    const place = found.get("fake-dozer")?.place;
    assert.equal(place?.id, handle);
    const real: Session = {
      sessionId: "fake-dozer",
      name: "Dozer",
      givenName: "Dozer",
      title: "",
      nameSetBy: "user",
      cwd,
      kind: "interactive",
      status: "idle",
      lastActiveAt: 1,
      desktop: false,
      place: place!,
      mapping: "process",
    };
    const matched = starting.match([real]);
    assert.deepEqual(
      matched.map((m) => [m.entry.id, m.session.sessionId, m.by]),
      [[entry.id, "fake-dozer", "pane"]],
    );

    // The held words go in now.
    const sent = await terminal.type(place!, "What is the capital of Germany?");
    assert.equal(sent.sent, true);
    await until(
      () => (existsSync(typed) ? readFileSync(typed, "utf8") : ""),
      (t) => t.includes("What is the capital of Germany?"),
    );

    // It quits: the shell is in front again.
    await terminal.type(place!, "/exit");
    await until(
      () => terminal.program!(handle),
      (state) => state === "shell",
    );
  });

  test('"No, exit" at the trust prompt: ended before it started; its pane closed: gone', async () => {
    const cwd = join(dir, "2026-10-29-rex");
    mkdirSync(cwd);
    let handle = "";
    await terminal.open!(cwd, { program: claude, args: ["exit-now", join(dir, "rex.typed"), join(dir, "rex.early")] }, (h) => (handle = h));
    const starting = new StartingSessions();
    const entry = starting.add({ cwd, name: "Rex", via: "tmux", handle, known: [] });
    await until(
      () => terminal.program!(handle),
      (state) => state === "running",
    );
    assert.equal(starting.ended(entry, "running"), false);
    const state = await until(
      () => terminal.program!(handle),
      (s) => s === "shell",
    );
    assert.equal(starting.ended(entry, state), true);
    const session = (await tmux(["display-message", "-p", "-t", handle, "#{session_name}"])).trim();
    await tmux(["kill-session", "-t", `=${session}`]);
    assert.equal(await terminal.program!(handle), "gone");
  });
});
