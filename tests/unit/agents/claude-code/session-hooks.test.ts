// A session starting or ending (Claude Code's SessionStart and SessionEnd hooks), taking a prompt
// in (UserPromptSubmit), or having a tool call blocked by auto mode (PermissionDenied): the hook
// script tells the app and is gone at once (hooks/claude-code-hook.mjs), printing nothing (but for a
// prompt the app says is your dictated words it typed in: one line of context for Claude, and only
// then; the app is given a second to say so); the app lists
// its sessions again, once for several together, hears the prompt, or is told of the block
// (src/agents/claude-code/hooks.ts), and our settings.json entries go in next to another tool's
// (src/agents/claude-code/settings.ts). Every event's permission_mode is passed on and kept as the
// session's (src/agents/claude-code/modes.ts), and whether it's in a turn (turns.ts): a session is
// listed again as its turn opens or ends.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { HOOK_COMMAND, withOurHooks, type ClaudeSettings } from "../../../../src/agents/claude-code/settings.ts";
import { forgetMode, modeOf } from "../../../../src/agents/claude-code/modes.ts";
import { forgetTerminal, terminalOf } from "../../../../src/agents/claude-code/terminals.ts";
import { turnOf } from "../../../../src/agents/claude-code/turns.ts";
import { Dictated } from "../../../../src/core/dictated.ts";
import { TELL_MS, VOICE_PROMPT } from "../../../../hooks/lib.mjs";
import { checkWaits, SLOW } from "../../../support/until.ts";

const HOOK = new URL("../../../../hooks/claude-code-hook.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "kiko-session-hooks-"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Waits on what a hook process sent: Node can take seconds to start on a busy machine, and the app may read a line
// only after the hook is seen gone.
const waitFor = checkWaits(15_000, 10);

/** How long Node takes to start and end a script doing nothing, now: what every hook pays before it does anything. */
function bare() {
  const start = Date.now();
  return new Promise<number>((resolve) => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }).on("close", () => resolve(Date.now() - start)));
}
/** A hook that took `ms` was gone at once, not waiting on the app: within a moment of Node's own start just now. */
async function atOnce(ms: number, what = "") {
  const node = await bare();
  assert.ok(ms - node < 700 * SLOW, `took ${ms}ms, Node alone ${node}ms${what}`);
}

/** The environment without any of the app's own variables. */
function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  // Nor the terminal this test runs in: each test says its own (hooks/lib.mjs terminalEnv).
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(KIKO_|TERM_PROGRAM$|__CFBundleIdentifier$|REX_)/.test(k)) env[k] = v;
  return { ...env, CLAUDE_CODE_ENTRYPOINT: "cli", ...extra };
}

/** Runs the hook with `input` on stdin and the app at `socket`: what it printed, its exit code, and how long it took. */
function runHook(input: object, socket: string, env: Record<string, string> = {}) {
  const start = Date.now();
  return new Promise<{ stdout: string; code: number; ms: number }>((resolve) => {
    const child = execFile(process.execPath, [HOOK], { env: cleanEnv({ KIKO_SOCKET: socket, ...env }), timeout: 30_000 * SLOW }, (err, stdout) =>
      resolve({ stdout, code: err ? Number(err.code ?? 1) : 0, ms: Date.now() - start }),
    );
    child.stdin!.end(JSON.stringify(input));
  });
}

const START = {
  hook_event_name: "SessionStart",
  session_id: "s-1",
  cwd: "/x",
  transcript_path: "/x/s-1.jsonl",
  source: "startup",
  model: "claude-opus-5-5",
};

// PermissionDenied as Claude Code 2.1.314 sends it (code.claude.com/docs/en/hooks, "PermissionDenied input").
const DENIED = {
  hook_event_name: "PermissionDenied",
  session_id: "s-1",
  cwd: "/x",
  transcript_path: "/x/s-1.jsonl",
  permission_mode: "auto",
  tool_name: "Bash",
  tool_input: { command: "wrangler deploy --env production", description: "Deploy the Cloudflare worker" },
  tool_use_id: "toolu_01ABC",
  reason: "[Production Deploy]",
};

describe("the hook script on SessionStart and SessionEnd", () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));
  /** An app at `path` that reads each line and never answers or closes. */
  function silentApp(path: string) {
    const got: any[] = [];
    const server = createServer((conn) =>
      conn.on("data", (chunk) =>
        got.push(
          ...String(chunk)
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        ),
      ),
    );
    servers.push(server);
    return new Promise<{ got: any[] }>((resolve) => server.listen(path, () => resolve({ got })));
  }

  test("no app: exits 0 at once, printing nothing", async () => {
    const { stdout, code, ms } = await runHook(START, join(dir, "missing.sock"));
    assert.deepEqual([stdout, code], ["", 0]);
    await atOnce(ms);
  });

  test("a socket left over from a crash: exits 0 at once, printing nothing", async () => {
    const stale = join(dir, "stale.sock");
    writeFileSync(stale, "");
    const { stdout, code, ms } = await runHook(START, stale);
    assert.deepEqual([stdout, code], ["", 0]);
    await atOnce(ms);
  });

  test("the app running: one event with only what it needs, not waited for, nothing printed", async () => {
    const path = join(dir, "app.sock");
    const app = await silentApp(path);
    const { stdout, code, ms } = await runHook(START, path);
    assert.deepEqual([stdout, code], ["", 0]);
    await atOnce(ms, ", though the app never answered");
    await waitFor(() => app.got.length === 1);
    // pid: the hook's parent, Claude Code (here, this test), to trace a session ID to its process.
    assert.deepEqual(app.got, [{ hook_event_name: "SessionStart", session_id: "s-1", cwd: "/x", transcript_path: "/x/s-1.jsonl", source: "startup", pid: process.pid, terminal: {} }]);

    const end = await runHook({ ...START, hook_event_name: "SessionEnd", source: undefined, reason: "prompt_input_exit" }, path);
    assert.deepEqual([end.stdout, end.code], ["", 0]);
    await waitFor(() => app.got.length === 2);
    assert.deepEqual(app.got.at(-1), { hook_event_name: "SessionEnd", session_id: "s-1", cwd: "/x", transcript_path: "/x/s-1.jsonl", reason: "prompt_input_exit" });
  });

  /** An app at `path` that answers each line with `answer(event)` and closes; null: closes without a word (an app from before 2026-11-14). */
  function answeringApp(path: string, answer: (event: any) => object | null) {
    const got: any[] = [];
    const server = createServer((conn) =>
      conn.once("data", (chunk) => {
        const event = JSON.parse(String(chunk).split("\n")[0]);
        got.push(event);
        const a = answer(event);
        if (a === null) conn.end();
        else conn.end(`${JSON.stringify(a)}\n`);
      }),
    );
    servers.push(server);
    return new Promise<{ got: any[] }>((resolve) => server.listen(path, () => resolve({ got })));
  }
  const PROMPT = { hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "/x", transcript_path: "/x/s-1.jsonl", permission_mode: "default", prompt: "Open it in high term." };

  test("UserPromptSubmit, a prompt the app says is your dictated words: one line of context for Claude, in Claude Code's shape, and nothing of the prompt", async () => {
    const path = join(dir, "voice.sock");
    const app = await answeringApp(path, () => ({ voice: true }));
    const { stdout, code, ms } = await runHook(PROMPT, path);
    assert.equal(code, 0);
    // code.claude.com/docs/en/hooks, "UserPromptSubmit decision control"; checked on 2.1.325.
    assert.deepEqual(JSON.parse(stdout), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "The user dictated this message by voice (speech-to-text, so expect small transcription errors)." },
    });
    assert.equal(JSON.parse(stdout).hookSpecificOutput.additionalContext, VOICE_PROMPT);
    await atOnce(ms, ": answered at once");
    assert.equal(app.got.length, 1);
  });

  test("UserPromptSubmit, any other prompt (typed by hand), or an app that only closes: nothing printed, at once", async () => {
    const path = join(dir, "by-hand.sock");
    await answeringApp(path, () => ({ voice: false }));
    const byHand = await runHook(PROMPT, path);
    assert.deepEqual([byHand.stdout, byHand.code], ["", 0]);
    await atOnce(byHand.ms);
    const older = join(dir, "older.sock");
    await answeringApp(older, () => null);
    const closed = await runHook(PROMPT, older);
    assert.deepEqual([closed.stdout, closed.code], ["", 0]);
    await atOnce(closed.ms);
    // Only the app's own yes counts: anything else it might say isn't one.
    const odd = join(dir, "odd.sock");
    await answeringApp(odd, () => ({ voice: "true", reply: "hello" }));
    assert.equal((await runHook(PROMPT, odd)).stdout, "");
  });

  test("UserPromptSubmit, the app not answering: the prompt goes in without the note, within the second the hook gives it", async () => {
    const path = join(dir, "no-answer.sock");
    const app = await silentApp(path);
    const node = await bare();
    const { stdout, code, ms } = await runHook(PROMPT, path);
    assert.deepEqual([stdout, code], ["", 0]);
    assert.ok(ms >= TELL_MS - 50, `gave the app its second: ${ms}ms`);
    assert.ok(ms - node < TELL_MS + 700 * SLOW, `took ${ms}ms, Node alone ${node}ms: never held past its deadline`);
    assert.equal(app.got.length, 1);
  });

  test("UserPromptSubmit: the prompt told, cut to 8000 characters; nothing printed (it would go into Claude's context)", async () => {
    const path = join(dir, "prompt.sock");
    const app = await answeringApp(path, () => ({ voice: false }));
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "/x", transcript_path: "/x/s-1.jsonl", permission_mode: "default", prompt: "Run the tests." };
    const { stdout, code, ms } = await runHook(prompt, path);
    assert.deepEqual([stdout, code], ["", 0]);
    await atOnce(ms);
    await waitFor(() => app.got.length === 1);
    assert.deepEqual(app.got, [
      { hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "/x", transcript_path: "/x/s-1.jsonl", permission_mode: "default", prompt: "Run the tests.", terminal: {} },
    ]);
    await runHook({ ...prompt, prompt: "x".repeat(9000) }, path);
    await waitFor(() => app.got.length === 2);
    assert.equal(app.got.at(-1)?.prompt.length, 8000);
  });

  test("PermissionDenied: the blocked call and why told, its long fields cut; not waited for, nothing printed (a retry is never asked for)", async () => {
    const path = join(dir, "denied.sock");
    const app = await silentApp(path);
    const { stdout, code, ms } = await runHook(DENIED, path);
    assert.deepEqual([stdout, code], ["", 0]);
    await atOnce(ms, ", though the app never answered");
    await waitFor(() => app.got.length === 1);
    assert.deepEqual(app.got, [
      {
        hook_event_name: "PermissionDenied",
        session_id: "s-1",
        cwd: "/x",
        transcript_path: "/x/s-1.jsonl",
        permission_mode: "auto",
        tool_name: "Bash",
        tool_input: DENIED.tool_input,
        tool_use_id: "toolu_01ABC",
        reason: "[Production Deploy]",
      },
    ]);
    await runHook({ ...DENIED, tool_input: { command: "x".repeat(3000) } }, path);
    await waitFor(() => app.got.length === 2);
    assert.equal(app.got.at(-1)?.tool_input.command.length, 2001, "cut to 2000 and …");
  });

  test("Stop: the event carries the hook's parent process (Claude Code's) as pid", async () => {
    const path = join(dir, "stop.sock");
    const got: any[] = [];
    // An app that takes the line and lets the session stop (closes without a reply).
    const server = createServer((conn) =>
      conn.on("data", (chunk) => {
        got.push(
          ...String(chunk)
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l)),
        );
        conn.end();
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));
    const { stdout, code } = await runHook({ hook_event_name: "Stop", session_id: "s-1", cwd: "/x", permission_mode: "plan", stop_hook_active: false, last_assistant_message: "Done." }, path);
    assert.deepEqual([stdout, code], ["", 0]);
    assert.equal(got[0]?.hook_event_name, "Stop");
    assert.equal(got[0]?.pid, process.pid);
    assert.equal(got[0]?.permission_mode, "plan", "its mode passed on");
  });

  test("the terminal it runs in: TERM_PROGRAM, the bundle id, whether it's Kiko's tmux, and its Rex block, passed on (only those)", async () => {
    const path = join(dir, "terminal.sock");
    const app = await silentApp(path);
    await runHook(START, path, { TERM_PROGRAM: "ghostty", __CFBundleIdentifier: "com.mitchellh.ghostty", GHOSTTY_RESOURCES_DIR: "/x" });
    await runHook(START, path, { TERM_PROGRAM: "tmux", KIKO_KEPT_TMUX: "/tmp/tmux-501/kiko,1,0" });
    // Rex: its block too (REX_BLOCK), only when it's a block id; never its session or anything else of Rex's.
    await runHook(START, path, { TERM_PROGRAM: "rex", REX_BLOCK: "block:01a1ae00-e4c4-7864-9b47-fab3c6caa635", REX_SESSION: "session:01a1ae00-b1c7-7cec-9baf-9cb5300d11b4" });
    await runHook(START, path, { TERM_PROGRAM: "rex", REX_BLOCK: "block:../../etc" });
    await waitFor(() => app.got.length === 4);
    assert.deepEqual(
      app.got.map((e) => e.terminal),
      [{ program: "ghostty", bundle: "com.mitchellh.ghostty" }, { program: "tmux", kiko: true }, { program: "rex", rex: "block:01a1ae00-e4c4-7864-9b47-fab3c6caa635" }, { program: "rex" }],
    );
  });

  test("a headless run: nothing sent", async () => {
    const path = join(dir, "headless.sock");
    const app = await silentApp(path);
    const { ms } = await runHook(START, path, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" });
    await atOnce(ms);
    // Then one that isn't headless: once its line is in, anything the headless one had sent would be too.
    await runHook({ ...START, session_id: "s-after" }, path);
    await waitFor(() => app.got.length > 0);
    assert.deepEqual(
      app.got.map((e) => e.session_id),
      ["s-after"],
    );
  });
});

describe("the app hears a session start or end (HookServer)", () => {
  const socket = join(dir, "server.sock");
  let server: any;
  let changed: number[] = [];
  let requests: any[] = [];
  let prompts: Array<[string, string]> = [];
  let blocks: any[] = [];
  let SETTLE = 0;

  before(async () => {
    process.env.KIKO_SOCKET = socket;
    const hooks = await import("../../../../src/agents/claude-code/hooks.ts");
    SETTLE = hooks.SESSIONS_SETTLE_MS;
    server = new hooks.HookServer();
    server.onSessionsChanged = () => changed.push(Date.now());
    server.onRequest = (r: any) => requests.push(r);
    server.onPromptSubmitted = (id: string, prompt: string) => prompts.push([id, prompt]);
    server.onBlocked = (b: any) => blocks.push(b);
    await server.start();
  });
  after(() => server.stop());

  /**
   * Sends one line as a hook would, and says when the app closed the connection (null: still open after `ms`, held).
   * The app closes a line it doesn't hold as soon as it's read it, so a busy machine only makes that later.
   */
  function sendLine(event: object, ms = 5000 * SLOW) {
    return new Promise<number | null>((resolve) => {
      const start = Date.now();
      const conn = connect(socket, () => conn.write(`${JSON.stringify(event)}\n`));
      conn.on("data", () => {});
      conn.on("close", () => resolve(Date.now() - start));
      setTimeout(() => {
        resolve(null);
        conn.destroy();
      }, ms).unref();
    });
  }
  const logged = () => {
    const file = readdirSync("logs")
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .at(-1)!;
    return readFileSync(join("logs", file), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  };

  test("closes the connection at once, logs it, and lists sessions again shortly after", async () => {
    changed = [];
    const sent = Date.now();
    const closedIn = await sendLine({ hook_event_name: "SessionStart", session_id: "s-1", cwd: "/x", source: "startup", pid: 93333 });
    assert.ok(closedIn !== null && closedIn < 1000 * SLOW, `closed after ${closedIn}ms`);
    await wait(SETTLE + 100);
    assert.equal(changed.length, 1);
    assert.ok(changed[0] - sent >= SETTLE - 5 && changed[0] - sent < SETTLE + 300 * SLOW, `${changed[0] - sent}ms`);
    assert.equal(requests.length, 0, "not held");
    const last = logged()
      .filter((l) => l.event === "session_started")
      .at(-1);
    assert.deepEqual([last.sessionId, last.cwd, last.source, last.pid], ["s-1", "/x", "startup", 93333]);
  });

  test("a Stop's pid is logged with it (hook_stop)", async () => {
    requests = [];
    void sendLine({ hook_event_name: "Stop", session_id: "948e8710", cwd: "/x", entrypoint: "cli", pid: 94001, last_assistant_message: "Done." });
    await waitFor(() => requests.length === 1, "held");
    requests[0].answer(null);
    const last = logged()
      .filter((l) => l.event === "hook_stop")
      .at(-1);
    assert.deepEqual([last.session_id, last.pid], ["948e8710", 94001]);
    requests = [];
  });

  test("a session another Claude started (in a job's scratch folder): let go at once, never held; logged once", async () => {
    requests = [];
    const cwd = join(homedir(), ".claude/jobs/e9a4c7d2/tmp/probe");
    const stop = { hook_event_name: "Stop", session_id: "probe-0f", cwd, entrypoint: "cli", pid: 95001, last_assistant_message: "Hi." };
    const closedIn = await sendLine(stop);
    assert.ok(closedIn !== null && closedIn < 1000 * SLOW, `closed after ${closedIn}ms`);
    await sendLine({ ...stop, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    assert.equal(requests.length, 0, "not held");
    const lines = logged();
    assert.deepEqual(
      lines.filter((l) => l.event === "session_hidden" && l.sessionId === "probe-0f").map((l) => [l.reason, l.cwd]),
      [["agent-scratch", cwd]],
    );
    assert.equal(lines.filter((l) => l.session_id === "probe-0f").length, 0, "no hook_stop or hook_permission");
  });

  test("several together (/clear ends one and starts the next): listed once; later ones again", async () => {
    changed = [];
    await Promise.all([
      sendLine({ hook_event_name: "SessionEnd", session_id: "s-1", cwd: "/x", reason: "clear" }),
      sendLine({ hook_event_name: "SessionStart", session_id: "s-2", cwd: "/x", source: "clear" }),
      sendLine({ hook_event_name: "SessionStart", session_id: "s-3", cwd: "/y", source: "startup" }),
    ]);
    await wait(SETTLE + 100);
    assert.equal(changed.length, 1);
    await sendLine({ hook_event_name: "SessionEnd", session_id: "s-3", cwd: "/y", reason: "prompt_input_exit" });
    await wait(SETTLE + 100);
    assert.equal(changed.length, 2);
    const ended = logged().filter((l) => l.event === "session_ended");
    assert.deepEqual(ended.map((l) => [l.sessionId, l.reason]).slice(-2), [
      ["s-1", "clear"],
      ["s-3", "prompt_input_exit"],
    ]);
  });

  test("the real hook script, end to end", async () => {
    changed = [];
    const { stdout, code } = await runHook(START, socket);
    assert.deepEqual([stdout, code], ["", 0]);
    // The hook may be seen gone before the app has read its line: listed SETTLE after that.
    await waitFor(() => changed.length === 1, "listed again");
  });

  test("a prompt taken in: closed at once, told with the session and its words, not held; listed again as its turn opens (working), not for one already open", async () => {
    changed = [];
    prompts = [];
    const closedIn = await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "/x", prompt: "Commit it." });
    assert.ok(closedIn !== null && closedIn < 1000 * SLOW, `closed after ${closedIn}ms`);
    await wait(SETTLE + 50);
    assert.deepEqual(prompts, [["s-1", "Commit it."]]);
    assert.deepEqual([requests.length, changed.length], [0, 1]);
    assert.equal(turnOf("s-1")?.open, true);
    const last = logged()
      .filter((l) => l.event === "prompt_submitted")
      .at(-1);
    assert.deepEqual([last.sessionId, last.chars, last.prompt], ["s-1", 10, undefined], "the words aren't logged");
    // Another while it's in that turn (typed while it works): nothing to draw again.
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: "/x", prompt: "And push." });
    await wait(SETTLE + 50);
    assert.equal(changed.length, 1);
  });

  /** Sends one line as a hook would, and gives what the app wrote back before it closed the connection. */
  function askLine(event: object) {
    return new Promise<string>((resolve) => {
      let answer = "";
      const conn = connect(socket, () => conn.write(`${JSON.stringify(event)}\n`));
      conn.setEncoding("utf8");
      conn.on("data", (chunk) => (answer += chunk));
      conn.on("close", () => resolve(answer));
    });
  }
  const lastPrompt = () =>
    logged()
      .filter((l) => l.event === "prompt_submitted")
      .at(-1);

  test("a prompt taken in is answered with whether it's your dictated words the app typed in: yes once, logged with voice; one typed by hand, no", async () => {
    prompts = [];
    const dictated = new Dictated();
    const asked: Array<[string, string]> = [];
    server.dictated = (id: string, prompt: string) => {
      asked.push([id, prompt]);
      return dictated.take([id], prompt);
    };
    try {
      // Nothing typed by the app: a prompt typed by hand.
      assert.equal(await askLine({ hook_event_name: "UserPromptSubmit", session_id: "v-1", cwd: "/x", prompt: "Use the airport microphone." }), '{"voice":false}\n');
      assert.equal(lastPrompt().voice, undefined);
      // The app types it in; the terminal sends it with a line break of its own.
      dictated.note("v-1", "Use the airport microphone.");
      assert.equal(await askLine({ hook_event_name: "UserPromptSubmit", session_id: "v-1", cwd: "/x", prompt: "Use the airport microphone.\n" }), '{"voice":true}\n');
      assert.deepEqual([lastPrompt().sessionId, lastPrompt().chars, lastPrompt().voice], ["v-1", 28, true]);
      // The same words again, typed by hand right after: not the app's.
      assert.equal(await askLine({ hook_event_name: "UserPromptSubmit", session_id: "v-1", cwd: "/x", prompt: "Use the airport microphone." }), '{"voice":false}\n');
      assert.equal(lastPrompt().voice, undefined);
      assert.equal(asked.length, 3);
      await waitFor(() => prompts.length === 3, "each told as taken in, as ever");
    } finally {
      server.dictated = () => false;
    }
  });

  test("the real hook script and the app, end to end: the note for the app's typing, once; none for the same words by hand", async () => {
    const dictated = new Dictated();
    server.dictated = (id: string, prompt: string) => dictated.take([id], prompt);
    try {
      const prompt = { hook_event_name: "UserPromptSubmit", session_id: "v-2", cwd: "/x", transcript_path: "/x/v-2.jsonl", permission_mode: "default", prompt: "Half of the month." };
      dictated.note("v-2", "Half of the month.");
      const first = await runHook(prompt, socket);
      assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: VOICE_PROMPT } });
      const again = await runHook(prompt, socket);
      assert.deepEqual([again.stdout, again.code], ["", 0]);
    } finally {
      server.dictated = () => false;
    }
  });

  test("auto mode blocked a call (PermissionDenied): closed at once, told with the session, the tool, why and its mode; logged; not held", async () => {
    blocks = [];
    requests = [];
    const closedIn = await sendLine(DENIED);
    assert.ok(closedIn !== null && closedIn < 1000 * SLOW, `closed after ${closedIn}ms`);
    await waitFor(() => blocks.length > 0, "told of the block");
    // Its mode with it: only one in auto mode is offered to be allowed anyway (core/block-override.ts).
    assert.deepEqual(blocks, [{ sessionId: "s-1", cwd: "/x", tool: { name: "Bash", input: DENIED.tool_input }, reason: "[Production Deploy]", by: "auto", mode: "auto" }]);
    assert.equal(requests.length, 0, "not held");
    const last = logged()
      .filter((l) => l.event === "hook_permission_denied")
      .at(-1);
    assert.deepEqual([last.sessionId, last.tool, last.reason, last.mode], ["s-1", "Bash", "[Production Deploy]", "auto"]);
  });

  test("a block in a session another Claude started: logged, never told", async () => {
    blocks = [];
    const cwd = join(homedir(), ".claude/jobs/e9a4c7d2/tmp/probe");
    await sendLine({ ...DENIED, session_id: "probe-1a", cwd });
    // Logged as it's read, before it would have been told.
    await waitFor(
      () =>
        logged()
          .filter((l) => l.event === "hook_permission_denied")
          .at(-1)?.hidden === "agent-scratch",
      "logged as hidden",
    );
    assert.deepEqual(blocks, []);
  });

  test("each event's permission_mode kept as the session's: a new one lists the sessions again (its tag), the same one doesn't; SessionEnd forgets it", async () => {
    forgetMode("m-1");
    changed = [];
    requests = [];
    void sendLine({ hook_event_name: "Stop", session_id: "m-1", cwd: "/x", permission_mode: "plan", last_assistant_message: "A plan." });
    // A Stop is held, so nothing says when it's been read: listed again SETTLE after that.
    await waitFor(() => changed.length > 0, "listed again for its new mode");
    assert.equal(modeOf("m-1"), "plan");
    await waitFor(() => requests.length === 1, "the Stop held");
    requests.splice(0).forEach((r) => r.answer(null));
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "m-1", cwd: "/x", permission_mode: "plan", prompt: "Go." });
    await wait(SETTLE + 50);
    assert.equal(changed.length, 2, "its turn opened (not its mode)");
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "m-1", cwd: "/x", permission_mode: "plan", prompt: "Go." });
    await wait(SETTLE + 50);
    assert.equal(changed.length, 2, "the same mode, in the same turn: nothing to draw again");
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "m-1", cwd: "/x", permission_mode: "acceptEdits", prompt: "Go on." });
    await wait(SETTLE + 50);
    assert.equal(modeOf("m-1"), "acceptEdits", "Shift+Tab in its window: the next event says so");
    assert.equal(changed.length, 3);
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "m-1", cwd: "/x", permission_mode: "something-new", prompt: "Hm." });
    assert.equal(modeOf("m-1"), "acceptEdits", "a mode it doesn't know isn't kept");
    assert.equal(
      logged()
        .filter((l) => l.event === "permission_mode" && l.sessionId === "m-1")
        .map((l) => l.mode)
        .join(),
      "plan,acceptEdits",
    );
    await sendLine({ hook_event_name: "SessionEnd", session_id: "m-1", cwd: "/x", permission_mode: "acceptEdits", reason: "prompt_input_exit" });
    assert.equal(modeOf("m-1"), undefined);
    await wait(SETTLE + 100); // its listing again, before the next test counts
  });

  test("each event's terminal kept as the session's (Ghostty is scripted only for sessions there): a new one lists the sessions again; SessionEnd forgets it", async () => {
    forgetTerminal("t-1");
    changed = [];
    await sendLine({ hook_event_name: "SessionStart", session_id: "t-1", cwd: "/x", source: "startup", terminal: { program: "iTerm.app", bundle: "com.googlecode.iterm2" } });
    await wait(SETTLE + 50);
    assert.equal(terminalOf("t-1"), "iterm");
    const listed = changed.length;
    assert.ok(listed >= 1);
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "t-1", cwd: "/x", prompt: "Go.", terminal: { program: "iTerm.app", bundle: "com.googlecode.iterm2" } });
    assert.equal(terminalOf("t-1"), "iterm");
    // An old hook (no field) leaves it as it was.
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "t-1", cwd: "/x", prompt: "Go on." });
    assert.equal(terminalOf("t-1"), "iterm");
    await sendLine({ hook_event_name: "UserPromptSubmit", session_id: "t-1", cwd: "/x", prompt: "Go on.", terminal: { program: "tmux", kiko: true } });
    assert.equal(terminalOf("t-1"), "kiko-tmux");
    await sendLine({ hook_event_name: "SessionEnd", session_id: "t-1", cwd: "/x", reason: "prompt_input_exit" });
    assert.equal(terminalOf("t-1"), undefined);
    await wait(SETTLE + 100);
  });

  test("an event it doesn't know is let go, not taken for a finished turn", async () => {
    changed = [];
    const closedIn = await sendLine({ hook_event_name: "Notification", session_id: "s-1", cwd: "/x" });
    assert.ok(closedIn !== null, "closed");
    await wait(SETTLE + 50);
    assert.deepEqual([requests.length, changed.length], [0, 0]);
    assert.equal(
      logged()
        .filter((l) => l.event === "hook_unknown")
        .at(-1)?.kind,
      "Notification",
    );
  });

  test("a Stop is still held, its connection open for the answer", async () => {
    const closedIn = await sendLine({ hook_event_name: "Stop", session_id: "s-1", cwd: "/x", last_assistant_message: "done" }, 150);
    assert.equal(closedIn, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].text, "done");
  });
});

describe("our settings.json entries (withOurHooks)", () => {
  const HERDR = { matcher: "*", hooks: [{ type: "command", command: "bash '/Users/me/.claude/hooks/herdr-agent-state.sh' session", timeout: 10 }] };
  const ours = (timeout: number) => ({ hooks: [{ type: "command", command: HOOK_COMMAND, timeout }] });
  const GATE = { matcher: "Bash|Monitor|mcp__.*", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 15 }] };

  test("the command is the hook in this repo, by absolute path", () => {
    assert.equal(HOOK_COMMAND, `node ${HOOK}`);
  });

  test("added next to another tool's SessionStart hook, after it; nothing else changed", () => {
    const settings: ClaudeSettings = {
      model: "opus",
      hooks: {
        SessionStart: [HERDR],
        Stop: [ours(300)],
        PermissionRequest: [ours(120)],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] }],
      },
    };
    const copy = structuredClone(settings);
    const next = withOurHooks(settings);
    assert.deepEqual(settings, copy, "the one given is left as it was");
    assert.equal(next.model, "opus");
    assert.deepEqual(next.hooks!.SessionStart, [HERDR, ours(5)]);
    assert.deepEqual(next.hooks!.SessionEnd, [ours(5)]);
    assert.deepEqual(next.hooks!.Stop, [ours(300)]);
    assert.deepEqual(next.hooks!.PermissionRequest, [ours(120)]);
    // The safety gate's goes after yours, for shell commands and MCP tools only.
    assert.deepEqual(next.hooks!.PreToolUse, [...settings.hooks!.PreToolUse!, GATE]);
  });

  test("ours already there (by any path, any timeout): left as it is; running it twice adds nothing", () => {
    const old = { hooks: [{ type: "command", command: "node /Users/me/git/claude-code-speech/hooks/claude-code-hook.mjs", timeout: 600 }] };
    const once = withOurHooks({ hooks: { Stop: [old], SessionStart: [HERDR] } });
    assert.deepEqual(once.hooks!.Stop, [old]);
    assert.deepEqual(withOurHooks(once), once);
  });

  test("no hooks at all: all seven, the safety gate's only for shell commands and MCP tools", () => {
    assert.deepEqual(withOurHooks({}).hooks, {
      Stop: [ours(300)],
      PermissionRequest: [ours(3600)],
      SessionStart: [ours(5)],
      SessionEnd: [ours(5)],
      UserPromptSubmit: [ours(5)],
      PermissionDenied: [ours(5)],
      PreToolUse: [GATE],
    });
  });
});
