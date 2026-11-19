// The hooks socket takes only lines the app understands:
// a line that isn't a JSON object, or is one of the wrong shape (an event without a name, a field
// of the wrong type, a future agent's changed payload), is let go and logged, never thrown, so it
// can't take the app down. The server goes on taking real events after each.
// The socket is this test's own (KIKO_SOCKET), never /tmp/kiko*.sock.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "kiko-payloads-"));
const SOCKET = join(dir, "app.sock");

/** Sends `line` and resolves with what came back once the app closed the connection. */
function send(line: string) {
  return new Promise<string>((resolve, reject) => {
    let got = "";
    const socket = connect(SOCKET, () => socket.write(`${line}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (c) => (got += c));
    socket.on("close", () => resolve(got));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(`(still open) ${got}`);
    }, 3000).unref();
  });
}

describe("the hooks socket and lines of the wrong shape", () => {
  let server: any;
  const requests: any[] = [];
  const thrown: unknown[] = [];
  const onThrow = (err: unknown) => thrown.push(err);

  before(async () => {
    process.env.KIKO_SOCKET = SOCKET;
    process.on("uncaughtException", onThrow);
    const hooks = await import("../../../../src/agents/claude-code/hooks.ts");
    server = new hooks.HookServer();
    server.onRequest = (r: any) => {
      requests.push(r);
      r.answer(null);
    };
    await server.start();
  });
  after(() => {
    process.off("uncaughtException", onThrow);
    server.stop();
  });

  const BAD = [
    "null",
    "[]",
    "42",
    '"Stop"',
    "{}",
    '{"hook_event_name":5}',
    '{"hook_event_name":"Stop"}',
    '{"hook_event_name":"Stop","session_id":null,"cwd":null}',
    '{"hook_event_name":"Stop","session_id":"s1","cwd":"/x","last_assistant_message":{"not":"text"}}',
    '{"hook_event_name":"PermissionRequest","session_id":"s1","cwd":"/x","tool_name":7,"tool_input":"rm"}',
    '{"hook_event_name":"PermissionRequest","session_id":{},"cwd":[]}',
    '{"hook_event_name":"SessionStart","session_id":{},"cwd":3}',
    '{"hook_event_name":"SessionEnd","session_id":[]}',
    '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":null}',
    '{"hook_event_name":"PermissionDenied","session_id":"s1","cwd":"/x","tool_input":null}',
    '{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"/x","guard":null}',
    '{"hook_event_name":"PreToolUse","session_id":"s1","cwd":"/x","guard":{"hits":"x","unclear":5}}',
    '{"hook_event_name":"Stop","session_id":"s1","cwd":"/x","permission_mode":{},"terminal":"ghostty"}',
    '{"agent":"codex","hook_event_name":null}',
    '{"agent":"codex","hook_event_name":"Stop","session_id":{}}',
    '{"agent":"opencode"}',
  ];

  for (const line of BAD) {
    test(`let go, nothing thrown: ${line}`, async () => {
      thrown.length = 0;
      const before_ = requests.length;
      const got = await send(line);
      assert.deepEqual(thrown, []);
      assert.ok(!got.startsWith("(still open)"), `held: ${got}`);
      assert.equal(requests.length, before_, "never handed to the app as a prompt or a stop");
    });
  }

  test("and the server still takes a real event after them", async () => {
    const before_ = requests.length;
    thrown.length = 0;
    await send(JSON.stringify({ hook_event_name: "Stop", session_id: "s-real", cwd: dir, transcript_path: join(dir, "t.jsonl"), last_assistant_message: "Done." }));
    assert.deepEqual(thrown, []);
    assert.equal(requests.length, before_ + 1);
  });
});
