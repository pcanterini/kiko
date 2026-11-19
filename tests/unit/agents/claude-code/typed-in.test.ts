// Prompts queued in a session's transcript while its Stop hook is held (src/agents/claude-code/typed-in.ts):
// only what someone typed counts, not the notices Claude Code queues itself.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessNotice, watchQueued } from "../../../../src/agents/claude-code/typed-in.ts";

const enqueue = (content: string) => `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), content })}\n`;

describe("watchQueued", () => {
  // 2026-11-06: a subagent's hand-back, queued as <agent-message from="…">, was taken for the user
  // typing at the terminal, and cut the summary being read out (typed_in → stopTalking → audio_stop).
  test("reports what was typed or pasted, not Claude Code's own notices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-typed-in-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: "before the watch" } })}\n`);
    const seen: string[] = [];
    let on = true;
    try {
      watchQueued(
        path,
        () => on,
        (content) => seen.push(content),
        20,
      );
      appendFileSync(
        path,
        enqueue('<agent-message from="a1">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.') +
          enqueue("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>") +
          enqueue("[Cross-session delivery notice] Your message to another session was held by that session.") +
          enqueue('<cross-session-message from="uds:/tmp/x.sock" from-name="other">\nhi</cross-session-message>') +
          enqueue('<pasted_content id="1">\nsome logs\n</pasted_content>') +
          enqueue("hello"),
      );
      const deadline = Date.now() + 2000;
      while (seen.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 60)); // nothing more comes after them
      assert.deepEqual(seen, ['<pasted_content id="1">\nsome logs\n</pasted_content>', "hello"]);
    } finally {
      on = false;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("harnessNotice", () => {
  test("Claude Code's own queued notices", () => {
    assert.ok(harnessNotice('<agent-message from="ac337134dd7f60e4f">\n[Subagent hand-back] …'));
    assert.ok(harnessNotice("<agent-message>\nreport"));
    assert.ok(harnessNotice("  <task-notification>\n…"));
    assert.ok(harnessNotice("[Cross-session idle notice] it is idle now"));
    assert.ok(harnessNotice('<cross-session-message from="uds:/tmp/x.sock">\nhi'));
    assert.ok(harnessNotice("Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete."));
  });

  test("what someone typed or pasted", () => {
    for (const typed of ['<pasted_content id="1">\nlogs', "[Image #1] what's this?", "hello", "/compact", "<agent-messages are odd", "Your claude.ai usage limit has reset. Shall we go on?"]) {
      assert.equal(harnessNotice(typed), false, typed);
    }
  });
});
