// Closing a session outside Kiko's tmux, for real (src/core/close.ts endFromOutside with Claude
// Code's endProcess, src/agents/claude-code/sessions.ts): real `ps` and real signals, only ever to
// processes this test starts, with process records in a folder of its own (never ~/.claude/sessions).
// `claude` is a fake: a link named `claude` to Node (so `ps -o comm=` says claude, as for the real
// one) running a script that writes its own record (its procStart from `ps`, as Claude Code's), and
// on SIGTERM runs the real SessionEnd hook (hooks/claude-code-hook.mjs, to a socket of this test's),
// deletes its record and exits 143, as Claude Code does; or takes a while over its hook ("slow"), or
// ignores SIGTERM ("ignore"). Everything it makes is removed afterwards, and any fake left is ended.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { endProcess, reach, type Reach } from "../../../src/agents/claude-code/sessions.ts";
import type { Endable } from "../../../src/agents/types.ts";
import { alive } from "../../../src/core/alive.ts";
import { endFromOutside, endSteps, sessionEnded } from "../../../src/core/close.ts";
import { valueWaits } from "../../support/until.ts";

const HOOK = fileURLToPath(new URL("../../../hooks/claude-code-hook.mjs", import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-co-")));
const records = join(dir, "sessions");
const socket = join(dir, "hooks.sock");
// Shorter than the app's (END_TIMES), so "still running" doesn't take 10 seconds here.
const TIMES = { endMs: 3000, everyMs: 50 };
// Real `ps` and signals, in this test's folder of records; `claude stop` never run.
const via: Reach = { ...reach, dir: records, stop: async () => ({ ok: false, why: "not in this test" }) };

const until = valueWaits(6000, 25);

const SCRIPT = `
const { appendFileSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { execFileSync, spawn } = require("node:child_process");
const [mode, records, sessionId, file] = process.argv.slice(2);
const note = (line) => appendFileSync(file, line + "\\n");
const record = records + "/" + process.pid + ".json";
const procStart = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).toString().replace(/\\s+/g, " ").trim();
mkdirSync(records, { recursive: true });
writeFileSync(record, JSON.stringify({ pid: process.pid, sessionId, cwd: process.cwd(), kind: "interactive", entrypoint: "cli", procStart, status: "idle" }));
note("pid " + process.pid);
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  note("SIGTERM");
  if (mode === "ignore") return;
  setTimeout(() => {
    const h = spawn(process.execPath, [${JSON.stringify(HOOK)}], { env: { ...process.env, KIKO_SOCKET: ${JSON.stringify(socket)} }, stdio: ["pipe", "ignore", "ignore"] });
    h.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: process.cwd(), reason: "other" }));
    h.on("exit", () => {
      rmSync(record, { force: true });
      note("exit");
      process.exit(143);
    });
  }, mode === "slow" ? 1200 : 0);
});
`;

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

describe("closing a session outside Kiko's tmux, for real (fake Claude Code processes of this test's own)", () => {
  let server: Server;
  const told: any[] = [];
  const started: ChildProcess[] = [];
  let claude = "";
  let script = "";

  before(async () => {
    script = join(dir, "fake-claude.cjs");
    writeFileSync(script, SCRIPT);
    claude = join(dir, "claude");
    symlinkSync(process.execPath, claude);
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
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, () => resolve()));
  });
  after(() => {
    // Only the fakes this test started, and only if they're still there.
    for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake session: started as `claude` (or as `node`, `asNode`), its record written; its pid and file. */
  async function open(name: string, mode: "exit" | "slow" | "ignore", asNode = false) {
    const file = join(dir, `${name}.log`);
    const child = spawn(asNode ? process.execPath : claude, [script, mode, records, `${name}-id`, file], { cwd: dir, stdio: "ignore" });
    started.push(child);
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
    assert.equal(pid, child.pid);
    assert.ok(existsSync(join(records, `${pid}.json`)), `${name}'s record`);
    const session: Endable = { sessionId: `${name}-id`, kind: "interactive", desktop: false, pid };
    return { pid, file, session, child };
  }

  const close = (session: Endable) =>
    endFromOutside(endSteps({ sessionId: session.sessionId, ids: [session.sessionId, ...(session.aliases ?? [])], refuse: null }, { end: () => endProcess(session, via) }), TIMES);

  test("idle: SIGTERM after its checks; its SessionEnd hook heard, its record deleted, its process gone (status 143)", async () => {
    const notes = await open("notes", "exit");
    const exited = new Promise<number | null>((r) => notes.child.on("exit", (code) => r(code)));
    const ended = await close(notes.session);
    assert.equal(ended.how, "ended", JSON.stringify(ended));
    assert.ok(ended.ms < TIMES.endMs, `${ended.ms} ms`);
    assert.ok(
      told.some((e) => e.hook_event_name === "SessionEnd" && e.session_id === "notes-id"),
      "its SessionEnd hook ran",
    );
    assert.equal(await exited, 143);
    assert.deepEqual(lines(notes.file).slice(1), ["SIGTERM", "exit"], "one SIGTERM");
    assert.equal(existsSync(join(records, `${notes.pid}.json`)), false, "its record gone: the list drops it");
    assert.equal(alive(notes.pid), false);
  });

  test("its SessionEnd hook takes a while: the hook counts as its end, and its process goes after", async () => {
    const slow = await open("slow", "slow");
    const ended = await close(slow.session);
    assert.equal(ended.how, "ended", JSON.stringify(ended));
    assert.ok(ended.ms >= 1000, `waited for it: ${ended.ms} ms`);
    await until(
      () => alive(slow.pid),
      (a) => !a,
      "slow gone",
    );
  });

  test("it doesn't go: still running after the wait, said so, and never signalled again or killed", async () => {
    const stubborn = await open("stubborn", "ignore");
    const ended = await close(stubborn.session);
    assert.deepEqual([ended.how, ended.why], ["running", "it was still running 3 seconds after"]);
    assert.equal(alive(stubborn.pid), true);
    assert.deepEqual(lines(stubborn.file).slice(1), ["SIGTERM"], "one SIGTERM, nothing after it");
  });

  test("its checks fail: nothing sent, it runs on (another session's record, a later start time, not Claude Code)", async () => {
    const other = await open("other", "exit");
    // The listed session's pid, but the record says another session runs there now.
    const wrongId = await close({ ...other.session, sessionId: "someone-else" });
    assert.deepEqual([wrongId.how, wrongId.why], ["refused", "its process runs another session now"]);
    // The record says the process started at another time: its pid taken again.
    const path = join(records, `${other.pid}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, procStart: "Thu Jan 1 00:00:00 1970" }));
    const reused = await close(other.session);
    assert.deepEqual([reused.how, reused.why], ["refused", "its process ID belongs to another process now"]);
    writeFileSync(path, JSON.stringify(record));
    // Its program isn't Claude Code: started as node.
    const node = await open("node", "exit", true);
    const notClaude = await close(node.session);
    assert.equal(notClaude.how, "refused");
    assert.match(notClaude.why!, /^its process isn't Claude Code/);
    for (const it of [other, node]) {
      assert.deepEqual(lines(it.file).slice(1), [], "no signal reached it");
      assert.equal(alive(it.pid), true);
    }
    // The checks all right again: it ends.
    assert.equal((await close(other.session)).how, "ended");
  });
});
