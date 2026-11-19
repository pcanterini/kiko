// Claude's questions (AskUserQuestion) answered through the PermissionRequest hook: what the app
// sends the hook (src/agents/claude-code/hooks.ts answerQuestions), and what the hook script prints
// for Claude Code (hooks/claude-code-hook.mjs): allow, with updatedInput the tool's own input, whole, plus
// `answers`. Claude Code (2.1.312, checked in its code and hooks docs) ignores an allow without
// updatedInput for this tool and asks in the terminal, so that stays the way to leave it there.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { HookHeld, type HookEvent } from "../../../../src/agents/claude-code/hooks.ts";

const HOOK = new URL("../../../../hooks/claude-code-hook.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "kiko-ask-hook-"));

const QUESTIONS = [
  {
    question: "Can I install tmux with Homebrew tonight?",
    header: "Install tmux",
    options: [
      { label: "Yes, install it (Recommended)", description: "brew install tmux" },
      { label: "No, I'll install it", description: "in the morning" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks should run before each merge?",
    header: "Checks",
    options: [
      { label: "Typecheck", description: "x".repeat(2500) }, // past the hook's 2000-character cut for what the app sees
      { label: "Unit tests", description: "" },
      { label: "Build, then test", description: "" },
    ],
    multiSelect: true,
  },
];
const EVENT: HookEvent = {
  hook_event_name: "PermissionRequest",
  session_id: "s-1",
  cwd: "/x",
  tool_name: "AskUserQuestion",
  tool_input: { questions: QUESTIONS },
};

/** A held request that keeps what it would send the hook. */
class Kept extends HookHeld {
  sent: Record<string, unknown> | null = null;
  get open() {
    return this.sent === null;
  }
  protected send(payload: Record<string, unknown>) {
    if (this.sent) return false;
    this.sent = payload;
    return true;
  }
}

describe("what the app sends the hook", () => {
  test("allow, with each question's text → its answer: a label as it is, several joined, your own words", () => {
    const held = new Kept(EVENT);
    assert.equal(held.questions?.length, 2);
    assert.ok(
      held.answerQuestions([
        { labels: ["Yes, install it (Recommended)"], text: "" },
        { labels: ["Typecheck", "Build, then test"], text: "" },
      ]),
    );
    assert.deepEqual(held.sent, {
      decision: { behavior: "allow" },
      answers: {
        "Can I install tmux with Homebrew tonight?": "Yes, install it (Recommended)",
        "Which checks should run before each merge?": 'Typecheck, "Build, then test"',
      },
    });
  });

  test("any other prompt has no questions, and can't be answered that way", () => {
    const held = new Kept({ ...EVENT, tool_name: "Bash", tool_input: { command: "ls", questions: QUESTIONS } });
    assert.equal(held.questions, null);
    assert.equal(held.answerQuestions([]), false);
    assert.equal(held.sent, null);
  });

  test("questions it can't read: none, so the app leaves them to the terminal", () => {
    assert.equal(new Kept({ ...EVENT, tool_input: { questions: "?" } }).questions, null);
  });
});

describe("what the hook script prints for Claude Code", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  /** An app that reads the event and answers with `answer`; what it got. */
  function app(name: string, answer: object) {
    const path = join(dir, `${name}.sock`);
    const got: any[] = [];
    const server = createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk;
        if (!buf.includes("\n")) return;
        got.push(JSON.parse(buf.split("\n")[0]));
        conn.end(`${JSON.stringify(answer)}\n`);
      });
    });
    servers.push(server);
    return new Promise<{ path: string; got: any[] }>((resolve) => server.listen(path, () => resolve({ path, got })));
  }

  function runHook(input: object, socket: string) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^KIKO_/.test(k)) env[k] = v;
    return new Promise<{ stdout: string; code: number }>((resolve) => {
      const child = execFile(process.execPath, [HOOK], { env: { ...env, CLAUDE_CODE_ENTRYPOINT: "cli", KIKO_SOCKET: socket }, timeout: 10_000 }, (err, stdout) =>
        resolve({ stdout, code: err ? Number(err.code ?? 1) : 0 }),
      );
      child.stdin!.end(JSON.stringify(input));
    });
  }

  const answers = { "Can I install tmux with Homebrew tonight?": "No, I'll install it", "Which checks should run before each merge?": "Unit tests" };

  test("answers: allow, with the tool's input given back whole (not as cut for the app) plus them", async () => {
    const { path, got } = await app("answers", { decision: { behavior: "allow" }, answers });
    const { stdout, code } = await runHook(EVENT, path);
    assert.equal(code, 0);
    assert.equal(got[0].tool_input.questions[1].options[0].description.length, 2500, "an array isn't cut on the way to the app");
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { questions: QUESTIONS, answers } },
      },
    });
  });

  test("let go (no answer): nothing printed, so Claude Code asks in the terminal", async () => {
    const { path } = await app("release", { decision: null });
    const { stdout, code } = await runHook(EVENT, path);
    assert.deepEqual([stdout, code], ["", 0]);
  });

  test("declined: deny as before, answers or not", async () => {
    const { path } = await app("deny", { decision: { behavior: "deny", message: "The user said no by voice" }, answers });
    const { stdout } = await runHook(EVENT, path);
    assert.deepEqual(JSON.parse(stdout).hookSpecificOutput.decision, { behavior: "deny", message: "The user said no by voice" });
  });

  test("any other tool's allow is unchanged", async () => {
    const { path } = await app("bash", { decision: { behavior: "allow" } });
    const { stdout } = await runHook({ ...EVENT, tool_name: "Bash", tool_input: { command: "ls" } }, path);
    assert.deepEqual(JSON.parse(stdout).hookSpecificOutput.decision, { behavior: "allow" });
  });
});
