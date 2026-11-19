// Closing a session gracefully, for real (src/core/close.ts through the tmux adapter and the window's
// closeSession): a throwaway tmux server (`tmux -L kiko-test-<random>-close`, never Kiko's nor
// the default one) with the Kiko window open in it (its app a stand-in that only sleeps), and
// sessions opened as voice-opened ones are (the adapter's `open`: `claude`, then the login shell
// unless the pane has been in the window, where it ends with claude: index.ts afterProgram; shown
// in the window). `claude` is a fake: it takes keys raw and writes what it got to a file; on /exit
// it runs the real SessionEnd hook (hooks/claude-code-hook.mjs, to a socket of this test's) and quits, or
// ignores /exit ("ignore"), or, mid-turn ("busy"), only takes /exit after Escape, or quits without
// the hook ("quiet"). Skipped when tmux isn't installed. Everything it makes is removed afterwards.
import "../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { alive } from "../../../src/core/alive.ts";
import { closeGracefully, closeSteps, sessionEnded } from "../../../src/core/close.ts";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, processes, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { closeSession, describe as layoutOf, openWindow } from "../../../src/terminals/tmux/window.ts";
import type { Place } from "../../../src/terminals/types.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = throwawayServer("close");
assert.notEqual(SERVER, "kiko");
const HOOK = fileURLToPath(new URL("../../../hooks/claude-code-hook.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-close-")));
const socket = join(dir, "hooks.sock");
const tmux = tmuxRunner(SERVER, CONFIG, cleanEnv());
const terminal = tmuxTerminal({
  tmux,
  ps: processes,
  show: async () => {},
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  installed: () => true,
  shell: "/bin/sh",
});
// Shorter than the app's (CLOSE_TIMES), so the fall back doesn't take 5 seconds here.
const TIMES = { settleMs: 400, endMs: 2500, everyMs: 50 };

const until = valueWaits(6000, 25);

/** The fake claude: see the top. Its file gets "pid N", then "<ESC>", "line:<text>", "queued:<text>", "exit". */
function fakeClaude() {
  const path = join(dir, "claude");
  writeFileSync(
    path,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const [mode, file, sessionId] = process.argv.slice(2);
const note = (line) => appendFileSync(file, line + "\\n");
note("pid " + process.pid);
process.stdout.write(mode === "busy" ? "FAKE CLAUDE working…\\n" : "FAKE CLAUDE ready\\n");
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let line = "";
let interrupted = false;
function quit(hook) {
  note("exit");
  if (!hook) return process.exit(0);
  const h = spawn(process.execPath, [${JSON.stringify(HOOK)}], { env: { ...process.env, KIKO_SOCKET: ${JSON.stringify(socket)} }, stdio: ["pipe", "ignore", "ignore"] });
  h.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: process.cwd(), reason: "prompt_input_exit" }));
  h.on("exit", () => process.exit(0));
}
process.stdin.on("data", (data) => {
  for (const ch of data) {
    if (ch === "\\x1b") {
      note("<ESC>");
      interrupted = true;
    } else if (ch === "\\r" || ch === "\\n") {
      const got = line;
      line = "";
      if (mode === "busy" && !interrupted) { note("queued:" + got); continue; }
      note("line:" + got);
      if (got === "/exit" && mode !== "ignore") quit(mode !== "quiet");
    } else line += ch;
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const sessionsNow = async () => (await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "")).split("\n").filter(Boolean);

describe("closing a session gracefully, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  let server: Server;
  const told: any[] = [];
  let claude = "";

  before(async () => {
    claude = fakeClaude();
    server = createServer((conn) =>
      conn.on("data", (chunk) => {
        for (const event of String(chunk)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))) {
          told.push(event);
          // What the app's hook server does with it (agent.onSessionEnded).
          if (event.hook_event_name === "SessionEnd") sessionEnded(event.session_id);
        }
      }),
    );
    await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
    await openWindow(tmux, () => ({ argv: ["/bin/sh", "-c", "exec sleep 600"], discard() {} }), dir, { width: 120, height: 40 });
  });
  after(() => {
    server?.close();
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A session opened as a voice-opened one is (shown in the window), found by its process: its place, pid, tmux session and file. */
  async function open(name: string, mode: "exit" | "ignore" | "busy" | "quiet") {
    const cwd = join(dir, name);
    mkdirSync(cwd);
    const file = join(dir, `${name}.log`);
    let pane = "";
    await terminal.open!(cwd, { program: claude, args: [mode, file, `${name}-id`] }, (h) => (pane = h));
    assert.match(pane, /^%\d+$/);
    const pid = Number(
      (
        await until(
          () => lines(file),
          (l) => l.some((x) => x.startsWith("pid ")),
          `${name} started`,
        )
      )
        .find((x) => x.startsWith("pid "))!
        .slice(4),
    );
    await until(
      () => terminal.program!(pane),
      (p) => p === "running",
      `${name} in front`,
    );
    const found = await terminal.find(Promise.resolve([{ sessionId: `${name}-id`, cwd, kind: "interactive" as const, desktop: false, titles: [], pid }]));
    const place = found.get(`${name}-id`)?.place;
    assert.equal(place?.id, pane, `${name} found in its pane by its process`);
    // Its own tmux session (named for its folder), wherever its pane is (in the window, shown: the window's).
    const session = name;
    assert.ok((await sessionsNow()).includes(session), `${name}'s own tmux session`);
    return { place: place!, pid, file, session };
  }

  const close = (sessionId: string, place: Place, busy = false) =>
    closeGracefully(closeSteps({ sessionId, ids: [sessionId], place, busy }, { terminal, interruptKey: "escape", exitCommand: "/exit", tidy: () => closeSession(tmux, place.id) }), TIMES);

  test("it exits on /exit: its SessionEnd hook heard, then its pane and its tmux session gone (ended with claude, or closed after), never closed twice; the window's stage a placeholder again", async () => {
    const lacy = await open("lacy", "exit");
    const stage = (await layoutOf(tmux)).view?.stage;
    assert.equal(stage?.id, lacy.place.id, "shown in the window");
    const closed = await close("lacy-id", lacy.place);
    assert.equal(closed.how, "exit", JSON.stringify(closed));
    // Shown in the window, its pane ends with claude (DIED_HOOK takes it out): closeSession finds it
    // gone, or closes what's left if it looks first; never an error, nothing killed twice.
    assert.ok(closed.tidied === "gone" || closed.tidied === "closed", JSON.stringify(closed));
    assert.equal(closed.interrupted, false);
    assert.ok(closed.ms < TIMES.endMs, `ended by itself: ${closed.ms} ms`);
    assert.deepEqual(lines(lacy.file).slice(1), ["line:/exit", "exit"], "only /exit typed, once");
    assert.ok(
      told.some((e) => e.hook_event_name === "SessionEnd" && e.session_id === "lacy-id"),
      "its SessionEnd hook ran",
    );
    assert.ok(!(await sessionsNow()).includes(lacy.session), "its tmux session closed");
    assert.equal(alive(lacy.pid), false);
    const after = await layoutOf(tmux);
    assert.ok(!after.panes.some((p) => p.id === lacy.place.id), "its pane gone");
    assert.equal(after.view?.stage?.role, "placeholder", "the stage's placeholder back");
  });

  test("no SessionEnd hook: its pane's program (the shell again) says it ended", async () => {
    const quiet = await open("quiet", "quiet");
    const closed = await close("quiet-id", quiet.place);
    assert.equal(closed.how, "exit", JSON.stringify(closed));
    assert.deepEqual(lines(quiet.file).slice(1), ["line:/exit", "exit"]);
    assert.ok(!told.some((e) => e.session_id === "quiet-id"));
    assert.ok(!(await sessionsNow()).includes(quiet.session));
  });

  test("it ignores /exit: after the wait, killed (its tmux session, and Claude Code with it), and why", async () => {
    const stubborn = await open("stubborn", "ignore");
    const closed = await close("stubborn-id", stubborn.place);
    assert.equal(closed.how, "killed");
    assert.match(closed.why!, /hadn't ended/);
    assert.ok(closed.ms >= TIMES.endMs);
    assert.deepEqual(lines(stubborn.file).slice(1), ["line:/exit"], "/exit typed, and nothing after it");
    assert.ok(!(await sessionsNow()).includes(stubborn.session), "its tmux session closed");
    await until(
      () => alive(stubborn.pid),
      (a) => !a,
      "its process ended with it",
    );
  });

  test("mid-turn: Escape first, then /exit (which it takes only after Escape)", async () => {
    const busy = await open("busy", "busy");
    const closed = await close("busy-id", busy.place, true);
    assert.equal(closed.how, "exit", JSON.stringify(closed));
    assert.equal(closed.interrupted, true);
    assert.deepEqual(lines(busy.file).slice(1), ["<ESC>", "line:/exit", "exit"]);
    assert.ok(!(await sessionsNow()).includes(busy.session));
  });

  test("its check fails (the process isn't the one in that pane): /exit typed nowhere, its own tmux session killed, the other one untouched", async () => {
    const mine = await open("mine", "exit");
    const other = await open("other", "exit");
    // Its place with the other session's process: the adapter's check refuses, so nothing is typed anywhere.
    const closed = await close("mine-id", { ...mine.place, pid: other.pid });
    assert.equal(closed.how, "killed");
    assert.match(closed.why!, /^\/exit didn't go in: /);
    assert.deepEqual(lines(mine.file).slice(1), [], "nothing typed into it");
    assert.deepEqual(lines(other.file).slice(1), [], "nothing typed into the other");
    const now = await sessionsNow();
    assert.ok(!now.includes(mine.session), "its own tmux session closed");
    assert.ok(now.includes(other.session), "the other's still there");
    assert.equal(alive(other.pid), true);
    assert.equal(await terminal.program!(other.place.id), "running");
  });
});
