// A tool call in full (src/core/decisions.ts toolDetail), for the phone's request sheet: the card shows the short
// "wants to …" (describeTool, a command cut to 300 characters on one line); the sheet shows the command as written.
// 2026-11-04: kiko-dev's multi-line simctl recordVideo command came to the phone cut, with no way to read the rest.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DETAIL_MAX, describeTool, toolDetail } from "../../../src/core/decisions.ts";

test("a command as written, its lines kept, where the card's line is cut", () => {
  const command = `cd /tmp/kiko && (xcrun simctl io booted recordVideo --force /tmp/kiko/v.mp4 & echo $! > /tmp/kiko/rec.pid)\nsleep 75\n${"t.sh ".repeat(100)}`;
  assert.ok(describeTool("Bash", { command }).length < 320, "the card's: short, one line");
  assert.equal(toolDetail("Bash", { command }), command.trim());
});

test("control characters are spaces (line breaks and tabs stay), CRLF is a line break, and it's cut to its most", () => {
  assert.equal(toolDetail("Bash", { command: "echo \u001b[31mred\r\nnext\tcol‮" }), "echo  [31mred\nnext\tcol");
  const long = toolDetail("Bash", { command: "a".repeat(DETAIL_MAX + 50) })!;
  assert.equal(long.length, DETAIL_MAX);
  assert.ok(long.endsWith("…"));
});

test("a file's or a page's whole path; nothing for a tool with nothing more to say, or an empty one", () => {
  assert.equal(toolDetail("Edit", { file_path: "/Users/me/git/kiko/src/app/status.ts" }), "/Users/me/git/kiko/src/app/status.ts");
  assert.equal(toolDetail("WebFetch", { url: "https://kiko.sh/docs" }), "https://kiko.sh/docs");
  assert.equal(toolDetail("WebSearch", { query: "x" }), null);
  assert.equal(toolDetail("mcp__github__create_issue", { title: "x" }), null);
  assert.equal(toolDetail("Bash", { command: "   " }), null);
  assert.equal(toolDetail(), null);
});
