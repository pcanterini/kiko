// A hook gone before Kiko writes to it (src/agents/hook-conn.ts), on a socket of this test's (never
// Kiko's own): a told hook exits as soon as its line is out, a held one is timed out or killed, and
// under load Kiko reads the line only after that. Its write then fails (EPIPE): caught and logged
// (`hook_gone`), never thrown; and a held answer to a hook already gone writes nothing and lets it go.
// codex.test.ts's hook-script server failed the suite this way (2 of 3 full runs, 2026-11-04).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { HookRequest, type HookEvent } from "../../../src/agents/claude-code/hooks.ts";
import { CodexRequest, type CodexEvent } from "../../../src/agents/codex/hooks.ts";
import { endHook, hookGone, watchHookConn, writeHook } from "../../../src/agents/hook-conn.ts";
import { LOG_DIR } from "../../../src/core/app-root.ts";
import { LOG_FILE } from "../../../src/core/log.ts";
import { checkWaits } from "../../support/until.ts";

const dir = mkdtempSync(join(tmpdir(), "kiko-hook-conn-"));
const until = checkWaits(3000);
const logged = (event: string) =>
  (existsSync(join(LOG_DIR, LOG_FILE)) ? readFileSync(join(LOG_DIR, LOG_FILE), "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);

// A hook of this test's, in a process of its own (as Codex's and Claude Code's are): it sends its
// line, closes, marks `flag` that it has, and exits without waiting for an answer.
const HOOK = `const s = require("node:net").connect(process.argv[1], () => s.end(process.argv[3] + "\\n", () => { s.destroy(); require("node:fs").writeFileSync(process.argv[2], ""); process.exit(0); }));`;

describe("a hook gone before Kiko writes to it", () => {
  const socket = join(dir, "h.sock");
  let server: Server;
  // What the server does with each connection's line: set by each test.
  let onLine: (conn: Socket, line: string) => void = () => {};

  before(async () => {
    server = createServer((conn) => {
      watchHookConn(conn, { test: true });
      const read = createInterface({ input: conn });
      read.once("line", (line) => {
        read.close();
        onLine(conn, line);
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
  });
  after(() => server.close());

  function hook(line: object, flag: string) {
    return new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["-e", HOOK, socket, flag, JSON.stringify(line)], { stdio: "ignore" });
      child.on("exit", resolve);
    });
  }

  test("its line read only after it closed (Kiko busy): the write's EPIPE is caught and logged as hook_gone, nothing thrown", async () => {
    const flag = join(dir, "gone-1");
    let wrote: boolean | undefined;
    let closed = false;
    onLine = (conn) => {
      // Busy, as under load: the hook closes and exits while this turn runs, before its end is read.
      const end = Date.now() + 5000;
      while (!existsSync(flag) && Date.now() < end);
      wrote = endHook(conn, `${JSON.stringify({ reply: "now the docs" })}\n`);
      conn.on("close", () => (closed = true));
    };
    const before_ = logged("hook_gone").length;
    assert.equal(await hook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "/x" }, flag), 0);
    await until(() => closed, "the connection closed");
    assert.equal(existsSync(flag), true, "the hook had gone before the write");
    assert.equal(wrote, true, "the write was tried: nothing yet said the hook had gone");
    const gone = logged("hook_gone").slice(before_);
    assert.equal(gone.length, 1, "logged once");
    assert.ok(["EPIPE", "ECONNRESET"].includes(gone[0].code), gone[0].code);
    assert.equal(gone[0].test, true, "with what it was about");
    assert.equal(logged("hook_socket_error").length, 0);
  });

  for (const [name, held] of [
    ["Claude Code's", (e: object, conn: Socket) => new HookRequest(e as HookEvent, conn)],
    ["Codex's", (e: object, conn: Socket) => new CodexRequest({ agent: "codex", ...e } as CodexEvent, conn)],
  ] as const) {
    test(`${name} held Stop, its hook gone before the answer: nothing written, answer() false, let go once (onClosed)`, async () => {
      const flag = join(dir, `gone-${name.replace(/\W/g, "")}`);
      let request: HookRequest | CodexRequest | undefined;
      let closings = 0;
      onLine = (conn, line) => {
        request = held(JSON.parse(line), conn);
        request.onClosed = () => closings++;
      };
      await hook({ hook_event_name: "Stop", session_id: "s2", cwd: "/x", last_assistant_message: "Done." }, flag);
      await until(() => closings > 0, "let go");
      assert.equal(request?.open, false);
      assert.equal(request?.answer("now the docs"), false, "nothing to answer");
      assert.equal(closings, 1);
    });

    test(`${name} held on a connection already closed (its hook gave up while Kiko decided): let go at once, answer() false`, async () => {
      const ours = await new Promise<Socket>((resolve) => {
        onLine = (conn) => resolve(conn);
        const c = connect(socket, () => c.end(`${JSON.stringify({ hook_event_name: "PermissionRequest" })}\n`));
      });
      await new Promise<void>((r) => (ours.destroyed ? r() : ours.once("close", () => r())));
      const request = held({ hook_event_name: "PermissionRequest", session_id: "s3", cwd: "/x", tool_name: "Bash" }, ours);
      let closings = 0;
      request.onClosed = () => closings++;
      await until(() => closings > 0, "let go");
      assert.equal(request.open, false);
      assert.equal(request.allow(false), false);
      assert.equal(closings, 1);
    });
  }

  test("a connection closed: hookGone, and endHook and writeHook write nothing (false), nothing thrown", async () => {
    const ours = await new Promise<Socket>((resolve) => {
      onLine = (conn) => resolve(conn);
      const c = connect(socket, () => c.end("{}\n"));
    });
    assert.equal(writeHook(ours, "first\n"), true, "still open: written");
    ours.destroy();
    assert.equal(hookGone(ours), true);
    assert.equal(writeHook(ours, "later\n"), false);
    assert.equal(endHook(ours, "later\n"), false);
    assert.equal(endHook(ours), false);
  });
});
