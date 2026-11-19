// The Codex adapter's parts (src/agents/codex/): its hooks' events read and answered, its hook script's
// output exactly as Codex's schema takes it (hooks/codex-hook.mjs, against a socket of this test's),
// its rollouts read in both history modes and folded as Claude Code's transcripts are, the names
// given with /rename, its records kept to live processes, its hooks merged into a hooks.json of
// this test's (never ~/.codex), the screens that say it's ready for words, and "start a Codex
// session" picking it only when it's said (or set).
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { agentOf, mainAgent, starter, starters } from "../../../src/agents/index.ts";
import { atCodexPrompt, codex, daemon as codexDaemon, nameOf as codexNameOf } from "../../../src/agents/codex/index.ts";
import { CodexDaemon, statusOf, threadOf, type DaemonThread } from "../../../src/agents/codex/daemon.ts";
import { rolloutSource } from "../../../src/agents/codex/mirror.ts";
import { daemonPids, tuiFoldersOf } from "../../../src/agents/codex/processes.ts";
import { Mirrors } from "../../../src/agents/mirror.ts";
import { parseCwds, parsePidField } from "../../../src/agents/processes.ts";
import { CodexHeld, onHookLine, toolOf, type CodexEvent } from "../../../src/agents/codex/hooks.ts";
import { commandLine, lastCodexText, lastUserText, said, saidSince, transcriptLines, saidIn } from "../../../src/agents/codex/rollouts.ts";
import { describe as describeRecord, endProcess, listSessions, liveRecords, mergeLive, threadNames, type CodexRecord } from "../../../src/agents/codex/sessions.ts";
import { codexOriginator, forgetOrigins, originatorOf, otherApp } from "../../../src/agents/codex/origin.ts";
import type { AgentSession } from "../../../src/agents/types.ts";
import { CODEX_CHECKED, CODEX_HOOKS, codexHookSilence, installCodexHooks, missingEvents, readHooksFile, withCodexHooks } from "../../../src/agents/codex/setup.ts";
import { newerThan } from "../../../src/agents/version.ts";
import { byProgram } from "../../../src/terminals/tmux/index.ts";
import { codexOneShot } from "../../../src/cli-args.ts";
import { HistoryFolder } from "../../../src/core/history.ts";
import { namedAgent } from "../../../src/core/decide.ts";
import { byAgent, canDo } from "../../../src/core/can.ts";
import { placeOf } from "../../../src/core/router.ts";
import { closeOutsidePrompt, sessionActions } from "../../../src/ui/nav.ts";
import { ASKED_FOR_NEW } from "../../../src/core/routing-rules.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { StartingSessions } from "../../../src/core/starting.ts";
import { SLOW, valueWaits } from "../../support/until.ts";
import { VOICE_PROMPT } from "../../../hooks/lib.mjs";

const dir = mkdtempSync(join(tmpdir(), "cbc-"));
const line = (type: string, payload: object, timestamp = "2026-10-29T10:00:00Z") => JSON.stringify({ timestamp, type, payload });
const item = (it: object) => line("event_msg", { type: "item_completed", thread_id: "t", turn_id: "1", item: it });

/** A held event answered into `sent`, as the harness's stand-in does. */
class Held extends CodexHeld {
  sent: Array<Record<string, unknown>> = [];
  get open() {
    return this.sent.length === 0;
  }
  protected send(payload: Record<string, unknown>) {
    if (this.sent.length) return false;
    this.sent.push(payload);
    return true;
  }
}
const event = (e: Partial<CodexEvent>): CodexEvent => ({ agent: "codex", hook_event_name: "Stop", session_id: "s1", cwd: "/x/pixie", ...e });

describe("Codex's hook events, as core holds them", () => {
  test("a shell command is Bash with its command; a patch is an edit (or a write) of its first file", () => {
    assert.deepEqual(toolOf("Bash", { command: "npm test" }), { name: "Bash", input: { command: "npm test" } });
    const patch = "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch";
    assert.deepEqual(toolOf("apply_patch", { command: patch }), { name: "Edit", input: { file_path: "src/app.ts", patch } });
    assert.equal(toolOf("apply_patch", { command: "*** Begin Patch\n*** Add File: new.md\n+x" }).name, "Write");
    assert.deepEqual(toolOf("mcp__github__create_issue", { title: "x" }), { name: "mcp__github__create_issue", input: { title: "x" } });
  });

  test("a Stop: its text, carried on with a reply or let stop; a permission: allowed or denied this once, never 'always'", () => {
    const stop = new Held(event({ last_assistant_message: "Fixed it.", stop_hook_active: true }));
    assert.equal(stop.isPermission, false);
    assert.equal(stop.text, "Fixed it.");
    assert.equal(stop.continued, true);
    assert.equal(stop.tool, null);
    assert.equal(stop.answer("now the tests"), true);
    assert.deepEqual(stop.sent, [{ reply: "now the tests" }]);
    assert.equal(stop.answer("again"), false, "answered once");
    const let_ = new Held(event({}));
    let_.release();
    assert.deepEqual(let_.sent, [{ reply: null }]);

    const ask = new Held(event({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
    assert.equal(ask.isPermission, true);
    assert.equal(ask.canAllowAlways, false);
    assert.equal(ask.questions, null);
    assert.equal(ask.answerQuestions([]), false);
    ask.allow(true);
    assert.deepEqual(ask.sent, [{ decision: { behavior: "allow" } }], "no updatedPermissions: Codex fails a hook that sends them");
    const no = new Held(event({ hook_event_name: "PermissionRequest", tool_name: "Bash" }));
    no.deny("Not now.");
    assert.deepEqual(no.sent, [{ decision: { behavior: "deny", message: "Not now." } }]);
    const left = new Held(event({ hook_event_name: "PermissionRequest", tool_name: "Bash" }));
    left.release();
    assert.deepEqual(left.sent, [{ decision: null }], "left to Codex's own prompt");
  });

  test("lines from the hook: Stop and PermissionRequest held, the others told and the connection closed at once", () => {
    const got: string[] = [];
    const to = {
      held: (h: CodexHeld) => got.push(`held ${h.event.hook_event_name}`),
      started: () => got.push("started"),
      ended: () => got.push("ended"),
      prompted: (e: CodexEvent) => got.push(`prompted ${e.prompt}`),
      interrupted: () => got.push("interrupted"),
      asking: () => got.push("asking"),
    };
    const conn = () => {
      const c: any = {
        ended: false,
        wrote: undefined,
        end(line?: string) {
          c.ended = true;
          c.wrote = line;
        },
        on() {},
      };
      return c as Socket & { ended: boolean; wrote?: string };
    };
    for (const kind of ["SessionStart", "SessionEnd", "Interrupt", "PreToolUse"]) {
      const c = conn();
      onHookLine({ agent: "codex", hook_event_name: kind, session_id: "s1", cwd: "/x" }, c, to);
      assert.equal(c.ended, true, `${kind} closed`);
    }
    const p = conn();
    onHookLine({ agent: "codex", hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/x", prompt: "hi" }, p, to);
    // Answered as it's closed: whether the prompt is your dictated words the app typed in. Not, unless the app says so.
    assert.deepEqual([p.ended, p.wrote], [true, '{"voice":false}\n']);
    const spoken = conn();
    onHookLine({ agent: "codex", hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/x", prompt: "high term" }, spoken, {
      ...to,
      prompted: () => {},
      dictated: (e: CodexEvent) => e.session_id === "s1" && e.prompt === "high term",
    });
    assert.deepEqual([spoken.ended, spoken.wrote], [true, '{"voice":true}\n']);
    const h = conn();
    onHookLine({ agent: "codex", hook_event_name: "Stop", session_id: "s1", cwd: "/x" }, h, to);
    assert.equal(h.ended, false, "held open for the answer");
    const bad = conn();
    onHookLine({ agent: "codex", hook_event_name: "Stop", cwd: "/x" }, bad, to);
    assert.equal(bad.ended, true, "no session: let go");
    assert.deepEqual(got, ["started", "ended", "interrupted", "asking", "prompted hi", "held Stop"]);
  });
});

describe("its hook script (hooks/codex-hook.mjs), against a socket of this test's", () => {
  const HOOK = fileURLToPath(new URL("../../../hooks/codex-hook.mjs", import.meta.url));
  const socket = join(dir, "h.sock");
  const records = join(dir, "hook-records");
  let server: Server;
  const lines: any[] = [];
  let answer: (e: any) => string | null = () => null;
  // A told event's hook doesn't wait for the socket to read its line (it closes and goes): the line can
  // reach `lines` just after the hook has exited, so a check waits for it (on a busy machine, a while after).
  const until = valueWaits(10_000, 10);
  const last = (key: string) => () => lines.at(-1)?.[key];

  before(async () => {
    // As Kiko's (claude-code/hooks.ts HookServer): a told event's hook is gone once its line is out,
    // so only a held one is answered; and a write to a hook gone first (its line read late, under
    // load) is no error: its EPIPE is caught on the connection, and the line reader is closed (it
    // passes its input's errors on, and nothing here would catch them).
    server = createServer((conn) => {
      conn.on("error", () => {});
      const read = createInterface({ input: conn });
      read.once("line", (l) => {
        read.close();
        const e = JSON.parse(l);
        lines.push(e);
        // A prompt taken in isn't held, but its line is answered (whether it's your dictated words).
        const held = e.hook_event_name === "Stop" || e.hook_event_name === "PermissionRequest" || e.hook_event_name === "UserPromptSubmit" || e.guard;
        const a = held ? answer(e) : null;
        if (a === null) conn.end();
        else conn.end(`${a}\n`);
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
  });
  after(() => server.close());

  function run(input: object): Promise<{ out: string; code: number | null; ms: number }> {
    const at = Date.now();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], { env: { ...process.env, KIKO_SOCKET: socket, KIKO_CODEX_SESSIONS: records }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ out, code, ms: Date.now() - at }));
      child.stdin.end(JSON.stringify(input));
    });
  }
  /** How long Node takes to start and end a script doing nothing, now: what every hook pays before it does anything. */
  const bare = () => {
    const at = Date.now();
    return new Promise<number>((resolve) => spawn(process.execPath, ["-e", ""], { stdio: "ignore" }).on("close", () => resolve(Date.now() - at)));
  };
  const base = { session_id: "11111111-2222-3333-4444-555555555555", cwd: "/x/pixie", transcript_path: "/x/rollout.jsonl", model: "m", permission_mode: "default" };

  test("told events: marked as Codex's, gone at once, nothing printed; its record kept with what it's doing", async () => {
    const started = await run({ ...base, hook_event_name: "SessionStart", source: "startup" });
    assert.equal(started.out, "");
    assert.equal(started.code, 0);
    await until(last("hook_event_name"), (k) => k === "SessionStart", "SessionStart at the socket");
    const prompt = await run({ ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "fix it" });
    assert.equal(prompt.out, "");
    await until(last("hook_event_name"), (k) => k === "UserPromptSubmit", "UserPromptSubmit at the socket");
    assert.deepEqual(
      lines.slice(-2).map((l) => [l.agent, l.hook_event_name, l.prompt]),
      [
        ["codex", "SessionStart", undefined],
        ["codex", "UserPromptSubmit", "fix it"],
      ],
    );
    const files = readdirSync(records).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "one record for the session (no Codex above this test: kept by its session, no pid)");
    const r = JSON.parse(readFileSync(join(records, files[0]), "utf8"));
    assert.deepEqual([r.sessionId, r.cwd, r.transcriptPath, r.status, r.pid], [base.session_id, "/x/pixie", "/x/rollout.jsonl", "busy", undefined]);
  });

  test("a prompt the app says is your dictated words: one line of context for Codex, in its schema's shape; any other prompt, nothing", async () => {
    const prompt = { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "open it in high term" };
    answer = (e) => (e.hook_event_name === "UserPromptSubmit" ? JSON.stringify({ voice: true }) : null);
    // codex-rs/hooks/src/schema.rs UserPromptSubmitCommandOutputWire (unknown fields are refused); checked on 0.167.0.
    assert.deepEqual(JSON.parse((await run(prompt)).out), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "The user dictated this message by voice (speech-to-text, so expect small transcription errors)." },
    });
    answer = () => JSON.stringify({ voice: false });
    assert.equal((await run(prompt)).out, "", "typed by hand");
    answer = () => null;
    assert.equal((await run(prompt)).out, "", "an app that only closes");
  });

  test("PreToolUse: its questions (request_user_input) are told; an ordinary command, nothing at all (the safety gate passes it)", async () => {
    const before_ = lines.length;
    await run({ ...base, hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" });
    await run({ ...base, hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "request_user_input", tool_input: { questions: [] }, tool_use_id: "c2" });
    await until(last("tool_name"), (t) => t === "request_user_input", "its questions at the socket");
    // Once the later one's line is in, the ordinary command's would have been too: there's none.
    assert.deepEqual(
      lines.slice(before_).map((l) => l.tool_name),
      ["request_user_input"],
    );
  });

  test("a Stop answered with a reply prints Codex's block, and nothing else; no reply prints nothing", async () => {
    answer = (e) => (e.hook_event_name === "Stop" ? JSON.stringify({ reply: "now the docs" }) : null);
    const stop = await run({ ...base, hook_event_name: "Stop", turn_id: "t1", stop_hook_active: false, last_assistant_message: "Done." });
    assert.equal(lines.at(-1).last_assistant_message, "Done.");
    assert.deepEqual(JSON.parse(stop.out), { decision: "block", reason: "The user replied by voice (speech-to-text, so expect small transcription errors): now the docs" });
    answer = () => JSON.stringify({ reply: null });
    assert.equal((await run({ ...base, hook_event_name: "Stop", turn_id: "t2", stop_hook_active: false, last_assistant_message: "x" })).out, "");
    const r = JSON.parse(readFileSync(join(records, readdirSync(records).find((f) => f.endsWith(".json"))!), "utf8"));
    assert.equal(r.status, "idle");
  });

  test("a permission allowed or denied prints exactly Codex's PermissionRequest output; let go prints nothing", async () => {
    const ask = { ...base, hook_event_name: "PermissionRequest", turn_id: "t3", tool_name: "Bash", tool_input: { command: "npm run deploy", description: "x".repeat(3000) } };
    answer = () => JSON.stringify({ decision: { behavior: "allow" } });
    assert.deepEqual(JSON.parse((await run(ask)).out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.ok(lines.at(-1).tool_input.description.length < 2100, "long fields cut");
    answer = () => JSON.stringify({ decision: { behavior: "deny", message: "Not on a Friday." } });
    assert.deepEqual(JSON.parse((await run(ask)).out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Not on a Friday." } } });
    answer = () => JSON.stringify({ decision: null });
    assert.equal((await run(ask)).out, "");
  });

  test("SessionEnd removes its record; with Kiko not running, it exits 0 and prints nothing", async () => {
    await run({ ...base, hook_event_name: "SessionEnd", reason: "other" });
    assert.equal(readdirSync(records).filter((f) => f.endsWith(".json")).length, 0);
    const off = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [HOOK], { env: { ...process.env, KIKO_SOCKET: join(dir, "nobody.sock"), KIKO_CODEX_SESSIONS: records }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("close", (code) => resolve(`${code}:${out}`));
      child.stdin.end(JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "x" }));
    });
    assert.equal(off, "0:");
  });

  // A T3 Code thread on Codex ran these hooks too (originator "T3 Code" in
  // its rollout), and Kiko heard it as a Codex session of its own, "workbench".
  test("another app's session (its rollout's originator: T3 Code's): nothing sent, nothing kept, nothing printed, at once; a permission falls to that app", async () => {
    const t3 = join(dir, "rollout-t3.jsonl");
    writeFileSync(
      t3,
      `${line("session_meta", { id: "01f71e90", cwd: "/x/workbench", originator: "T3 Code", source: "vscode", cli_version: "0.153.0", base_instructions: { text: "x".repeat(30_000) } })}\n`,
    );
    const theirs = { ...base, session_id: "01f71e90-34d9-79f3-a61d-9a63382e1261", cwd: "/x/workbench", transcript_path: t3 };
    const sent = lines.length;
    rmSync(records, { recursive: true, force: true });
    answer = () => JSON.stringify({ decision: { behavior: "allow" } });
    for (const e of [
      { hook_event_name: "SessionStart", source: "resume" },
      { hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "say hello world" },
      { hook_event_name: "PermissionRequest", turn_id: "t1", tool_name: "Bash", tool_input: { command: "echo hello world" } },
      { hook_event_name: "Stop", turn_id: "t1", stop_hook_active: false, last_assistant_message: "hello world" },
      { hook_event_name: "SessionEnd", reason: "other" },
    ]) {
      const r = await run({ ...theirs, ...e });
      assert.deepEqual([r.out, r.code], ["", 0], `${e.hook_event_name}: nothing printed (no decision: T3 answers it), exit 0`);
      const node = await bare();
      assert.ok(r.ms - node < 700 * SLOW, `${e.hook_event_name}: gone at once (${r.ms}ms, Node alone ${node}ms)`);
    }
    assert.deepEqual(existsSync(records) ? readdirSync(records).filter((f) => f.endsWith(".json")) : [], [], "no record kept");
    // Codex's own TUI, older or newer, still is Kiko's.
    for (const originator of ["codex-tui", "codex_cli_rs"]) {
      const own = join(dir, `rollout-${originator}.jsonl`);
      writeFileSync(own, `${line("session_meta", { id: originator, cwd: "/x/pixie", originator, source: "cli" })}\n`);
      await run({ ...base, session_id: `own-${originator}`, transcript_path: own, hook_event_name: "SessionStart", source: "startup" });
      await until(last("session_id"), (id) => id === `own-${originator}`, `${originator}: told`);
    }
    // Once those are in, anything T3's had sent would be too: none of it reached Kiko.
    assert.deepEqual(
      lines.slice(sent).map((l) => l.session_id),
      ["own-codex-tui", "own-codex_cli_rs"],
      "nothing of T3's reached Kiko",
    );
    answer = () => null;
  });
});

describe("another app's Codex sessions (a T3 Code thread on Codex): none of the Codex adapter's", () => {
  const rollout = (name: string, originator: string | null) => {
    const path = join(dir, `rollout-app-${name}.jsonl`);
    writeFileSync(
      path,
      `${line("session_meta", { id: name, cwd: "/x/workbench", source: "vscode", ...(originator === null ? {} : { originator }) })}\n${line("event_msg", { type: "task_started", turn_id: "1" })}\n`,
    );
    return path;
  };

  test("Codex's own CLI's originators (its TUI, now and before) and none recorded are Codex's; an app's, exec's, or a lookalike aren't", () => {
    for (const own of ["codex-tui", "codex_cli_rs", "codex_tui", "", null, undefined]) assert.equal(codexOriginator(own), true, String(own));
    for (const app of ["T3 Code", "Codex Desktop", "codex_vscode", "codex_work_desktop", "codex_exec", "MyClient", "clinic"]) assert.equal(codexOriginator(app), false, app);
  });

  test("read from its rollout's first line only, however long; no rollout, or no whole first line yet, isn't known", () => {
    assert.equal(originatorOf(rollout("t3-read", "T3 Code")), "T3 Code");
    assert.equal(originatorOf(rollout("none-read", null)), null, "none recorded");
    const half = join(dir, "rollout-half.jsonl");
    writeFileSync(half, line("session_meta", { id: "h", originator: "T3 Code" }).slice(0, 40));
    assert.equal(originatorOf(half), undefined, "Codex still writing it");
    assert.equal(originatorOf(join(dir, "nowhere.jsonl")), undefined);
    assert.equal(originatorOf(undefined), undefined);
  });

  test("otherApp: the app's name for another app's session, null for Codex's own; not known yet, asked again until its rollout says", () => {
    forgetOrigins();
    assert.equal(otherApp("app-1", rollout("app-1", "T3 Code")), "T3 Code");
    assert.equal(otherApp("own-1", rollout("own-1", "codex-tui")), null);
    const late = join(dir, "rollout-late.jsonl");
    assert.equal(otherApp("late-1", late), null, "no rollout yet: Codex's, for now");
    writeFileSync(late, `${line("session_meta", { id: "late-1", originator: "T3 Code" })}\n`);
    assert.equal(otherApp("late-1", late), "T3 Code", "read again, now it's there");
  });

  test("its hook lines, Stop and PermissionRequest too, are let go at once, with no answer: nothing held, told or noted", () => {
    const got: string[] = [];
    const to = {
      held: (h: CodexHeld) => got.push(`held ${h.event.hook_event_name}`),
      started: () => got.push("started"),
      ended: () => got.push("ended"),
      prompted: () => got.push("prompted"),
      interrupted: () => got.push("interrupted"),
      asking: () => got.push("asking"),
    };
    const path = rollout("01f71e90-t3", "T3 Code");
    for (const kind of ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "Interrupt", "PreToolUse", "SessionEnd"]) {
      const c: any = {
        ended: false,
        line: undefined,
        end(l?: string) {
          c.ended = true;
          c.line = l;
        },
        on() {},
      };
      onHookLine(
        { agent: "codex", hook_event_name: kind, session_id: "01f71e90-t3", cwd: "/x/workbench", transcript_path: path, prompt: "say hello world", tool_name: "Bash", tool_input: { command: "ls" } },
        c,
        to,
      );
      assert.deepEqual([c.ended, c.line], [true, undefined], `${kind}: closed, no answer`);
    }
    assert.deepEqual(got, []);
    assert.equal(codex.owns!("01f71e90-t3"), false, "not one of Codex's sessions");
  });

  test("listed: a record left for one (from before its rollout could be read) isn't a session; Codex's own beside it is", async () => {
    const records = join(dir, "records-apps");
    mkdirSync(records, { recursive: true });
    mkdirSync(join(process.env.CODEX_HOME!, "thread-writer-locks"), { recursive: true });
    for (const [id, originator] of [
      ["rec-t3", "T3 Code"],
      ["rec-own", "codex-tui"],
    ] as const) {
      writeFileSync(join(records, `${id}.json`), JSON.stringify({ sessionId: id, cwd: "/x/workbench", transcriptPath: rollout(id, originator), status: "idle", at: 1 }));
      writeFileSync(join(process.env.CODEX_HOME!, "thread-writer-locks", `${id}.lock`), "");
    }
    assert.deepEqual(
      (await listSessions(records)).map((s) => s.sessionId),
      ["rec-own"],
    );
  });

  test("its daemon's threads: an app's (T3 Code's, Codex Desktop's) aren't sessions", () => {
    const t = { id: "019a", cwd: "/x/workbench", status: { type: "idle" }, source: "vscode", originator: "T3 Code" };
    assert.equal(threadOf(t), null);
    assert.equal(threadOf({ ...t, originator: "codex-tui" })?.id, "019a");
  });
});

describe("its rollouts", () => {
  const paginated = [
    line("session_meta", { id: "s1", session_id: "s1", cwd: "/x/pixie", history_mode: "paginated" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…" }] }),
    line("event_msg", { type: "task_started", turn_id: "1" }),
    item({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "fix the login bug", text_elements: [] }] }),
    // The line Kiko's hook adds beside a dictated prompt, as Codex 0.167.0 keeps it: a developer message after the prompt. Never shown.
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: VOICE_PROMPT }] }),
    item({ type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "npm test"], status: "failed", aggregated_output: "1 failing\n", exit_code: 1 }),
    item({
      type: "FileChange",
      id: "f1",
      changes: { "/x/pixie/src/login.ts": { type: "update", unified_diff: "--- a\n+++ b\n@@\n-old\n+new\n+more" }, "/x/pixie/NOTES.md": { type: "add", content: "a\nb" } },
      status: "completed",
    }),
    item({ type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "Fixed: the token wasn't refreshed." }], phase: "final_answer" }),
    line("event_msg", { type: "task_complete", turn_id: "1", last_agent_message: "Fixed: the token wasn't refreshed." }),
    item({
      type: "HookPrompt",
      id: "h1",
      content: [{ type: "text", text: '<hook_prompt hook_run_id="r">The user replied by voice (speech-to-text, so expect small transcription errors): and the tests</hook_prompt>' }],
    }),
    item({ type: "AgentMessage", id: "a2", content: [{ type: "Text", text: "Tests added." }], phase: "final_answer" }),
  ];
  const legacy = [
    line("event_msg", { type: "task_started", turn_id: "1" }),
    line("event_msg", { type: "user_message", message: "what's next?", local_images: [] }),
    line("event_msg", { type: "exec_command_end", call_id: "c", command: ["bash", "-lc", "git status"], aggregated_output: "clean", exit_code: 0 }),
    line("event_msg", { type: "patch_apply_end", call_id: "p", success: true, changes: { "/x/a.ts": { type: "update", unified_diff: "+x" } } }),
    line("event_msg", { type: "agent_message", message: "Ship it." }),
    line("event_msg", { type: "turn_aborted", turn_id: "2", reason: "interrupted" }),
  ];
  const path = join(dir, "rollout.jsonl");
  const old = join(dir, "rollout-legacy.jsonl");
  before(() => {
    writeFileSync(path, `${paginated.join("\n")}\n`);
    writeFileSync(old, `${legacy.join("\n")}\n`);
  });

  test("what was asked and said last, in either history mode (Codex's own context left out)", () => {
    assert.equal(lastUserText(path), "and the tests");
    assert.equal(lastCodexText(path), "Tests added.");
    assert.equal(lastUserText(old), "what's next?");
    assert.equal(lastCodexText(old), "Ship it.");
    assert.equal(lastUserText(join(dir, "none.jsonl")), "");
    assert.equal(said(JSON.parse(paginated[1])), null, "response_item lines aren't read");
    assert.equal(said(JSON.parse(paginated[4])), null, "nor the line beside a dictated prompt");
  });

  test("your words this turn: its prompt, then a reply through the Stop hook (the same turn)", () => {
    assert.deepEqual(saidSince(path), ["fix the login bug", "and the tests"]);
    assert.equal(saidSince(join(dir, "none.jsonl")), null);
  });

  test("as a Claude Code transcript, folded as core folds one: words, a failed command with its output, edits with their size", () => {
    const folder = new HistoryFolder();
    for (const l of transcriptLines(saidIn(readFileSync(path, "utf8")))) folder.add(JSON.parse(l));
    const items = folder.snapshot().items;
    assert.deepEqual(
      items.map((i) => i.kind),
      ["you", "steps", "claude", "you", "claude"],
    );
    const steps = items[1] as any;
    assert.deepEqual(
      steps.steps.map((s: any) => [s.tool, s.title, s.error]),
      [
        ["Bash", "npm test", true],
        ["Edit", "/x/pixie/src/login.ts", false],
        ["Write", "/x/pixie/NOTES.md", false],
      ],
    );
    assert.match(steps.steps[0].detail, /1 failing/);
    assert.equal(steps.steps[1].detail, "+2 −1");
    const fromOld = new HistoryFolder();
    for (const l of transcriptLines(saidIn(readFileSync(old, "utf8")))) fromOld.add(JSON.parse(l));
    assert.deepEqual(
      fromOld.snapshot().items.map((i) => i.kind),
      ["you", "steps", "claude"],
    );
  });

  test("its mirror: the rollout so far as a private transcript file, then what's added; none without a rollout", async () => {
    const mirrors = new Mirrors(
      () => join(dir, "mirrors"),
      (id) => rolloutSource(id === "none" ? undefined : join(dir, "growing.jsonl"), 20),
    );
    writeFileSync(join(dir, "growing.jsonl"), `${paginated.slice(0, 4).join("\n")}\n`);
    assert.equal(mirrors.path("none"), "");
    const file = mirrors.path("th/1");
    assert.equal(file, join(dir, "mirrors", "th_1.jsonl"));
    assert.equal(statSync(join(dir, "mirrors")).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const kinds = () =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).type);
    assert.deepEqual(kinds(), ["user"], "your words so far");
    appendFileSync(join(dir, "growing.jsonl"), `${paginated.slice(4).join("\n")}\n`);
    const added = ["user", ...transcriptLines(saidIn(paginated.slice(4).join("\n"))).map((l) => JSON.parse(l).type)];
    // Followed every 20 ms here: there once it's looked again.
    await valueWaits(5000, 20)(kinds, (k) => k.length === added.length, "what's added, mirrored");
    assert.deepEqual(kinds(), added);
    assert.equal(mirrors.path("th/1"), file, "the same file while it's kept");
    mirrors.stop();
  });

  test("a command as Codex records it is its command line", () => {
    assert.equal(commandLine(["/bin/zsh", "-lc", "npm test -- --watch"]), "npm test -- --watch");
    assert.equal(commandLine(["git", "status"]), "git status");
    assert.equal(commandLine("ls"), "ls");
  });

  test("names given with /rename: the newest line for each session wins; an empty name takes it back", () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const index = [
      { id: "a", thread_name: "First", updated_at: "1" },
      { id: "b", thread_name: "Other", updated_at: "2" },
      { id: "a", thread_name: "Login fix", updated_at: "3" },
      { id: "b", thread_name: "", updated_at: "4" },
    ];
    writeFileSync(join(home, "session_index.jsonl"), `${index.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const names = threadNames(home);
    assert.equal(names.get("a"), "Login fix");
    assert.equal(names.has("b"), false);
    assert.equal(threadNames(join(dir, "nowhere")).size, 0);
  });
});

describe("its sessions, from the hook's records", () => {
  const rec = (r: Partial<CodexRecord>): CodexRecord => ({ sessionId: "s", cwd: "/x/pixie", status: "idle", at: 1, ...r });

  test("listed while their process is the one that started when the record says; without a pid, while Codex holds its thread's lock", () => {
    const times = new Map([
      [10, "Thu Oct 29 10:00:00 2026"],
      [11, "Thu Oct 29 11:00:00 2026"],
    ]);
    const live = liveRecords(
      [
        rec({ sessionId: "a", pid: 10, procStart: "Thu Oct 29  10:00:00   2026" }),
        rec({ sessionId: "reused", pid: 11, procStart: "Wed Oct 28 09:00:00 2026" }),
        rec({ sessionId: "gone", pid: 12, procStart: "Thu Oct 29 10:00:00 2026" }),
        rec({ sessionId: "daemon" }),
        rec({ sessionId: "crashed" }),
      ],
      times,
      (id) => id === "daemon",
    );
    assert.deepEqual(
      live.map((r) => r.sessionId),
      ["a", "daemon"],
    );
  });

  test("one process, one session: after /new in Codex, the newest record for it", () => {
    const times = new Map([[10, "T"]]);
    const live = liveRecords([rec({ sessionId: "old", pid: 10, procStart: "T", at: 1 }), rec({ sessionId: "new", pid: 10, procStart: "T", at: 2 })], times, () => false);
    assert.deepEqual(
      live.map((r) => r.sessionId),
      ["new"],
    );
  });

  test("a record as a session: Codex's, named by its folder or its given name, found by its process and its ID", () => {
    const s = describeRecord(rec({ sessionId: "019a", pid: 10, procStart: "T", status: "blocked" }), "Login fix");
    assert.deepEqual([s.agent, s.name, s.givenName, s.status, s.pid, s.kind, s.desktop], ["codex", "pixie", "Login fix", "blocked", 10, "interactive", false]);
    assert.deepEqual(s.titles, ["Login fix", "019a"], "never its folder's name: Codex's default title, not enough to tell its window");
    assert.equal(describeRecord(rec({ status: "weird" }), "").status, "idle");
  });

  test("ended from outside only after its checks: an unknown process, another session's record, or not Codex is refused", async () => {
    const recs = join(dir, "end-records");
    mkdirSync(recs, { recursive: true });
    writeFileSync(join(recs, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s1", procStart: "T", cwd: "/x" }));
    const killed: number[] = [];
    const via = { dir: recs, ps: async (_: number, f: "comm" | "lstart"): Promise<string> => (f === "lstart" ? "T" : "/usr/local/bin/codex"), kill: (pid: number) => void killed.push(pid) };
    const end = (s: object, v = via) => endProcess({ sessionId: "s1", kind: "interactive", desktop: false, ...s } as any, v);
    assert.deepEqual(await end({}), { sent: false, why: "its process isn't known" });
    assert.deepEqual(await end({ pid: 4242, sessionId: "other" }), { sent: false, why: "its process runs another session now" });
    assert.deepEqual(await end({ pid: 4242 }, { ...via, ps: async (_: number, f: "comm" | "lstart") => (f === "lstart" ? "T" : "/bin/zsh") }), { sent: false, why: "its process isn't Codex (zsh)" });
    assert.deepEqual(killed, []);
    assert.deepEqual(await end({ pid: 4242 }), { sent: true, pids: [4242] });
    assert.deepEqual(killed, [4242]);
  });
});

describe("setting up its hooks (a hooks.json of this test's, never ~/.codex)", () => {
  test("added next to the hooks there, each event once; nothing of yours changed", () => {
    const yours = { hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me", timeout: 10 }] }] }, other: 1 };
    const merged = withCodexHooks(yours, "node /c/hooks/codex-hook.mjs");
    assert.deepEqual(merged.hooks!.Stop[0], yours.hooks.Stop[0], "yours first, as it was");
    assert.deepEqual(merged.hooks!.Stop[1], { hooks: [{ type: "command", command: "node /c/hooks/codex-hook.mjs", timeout: 300 }] });
    assert.deepEqual(merged.hooks!.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command: "node /c/hooks/codex-hook.mjs", timeout: 3600 }] }]);
    // Its questions, and the safety gate's shell commands and MCP tools (held up to 300 s while you're asked).
    assert.deepEqual(merged.hooks!.PreToolUse, [{ matcher: "request_user_input|Bash|mcp__.*", hooks: [{ type: "command", command: "node /c/hooks/codex-hook.mjs", timeout: 300 }] }]);
    assert.equal((merged as any).other, 1);
    assert.equal(yours.hooks.Stop.length, 1, "the file read is left as it was");
    assert.deepEqual(withCodexHooks(merged, "node /c/hooks/codex-hook.mjs"), merged, "twice is once");
    assert.deepEqual(missingEvents(merged), []);
    assert.deepEqual(missingEvents({}), Object.keys(CODEX_HOOKS));
    assert.ok(CODEX_HOOKS.SessionEnd.timeout <= 3 && CODEX_HOOKS.Interrupt.timeout <= 3, "Codex caps those at 3s");
  });

  test("installed: backed up first, written whole; again, nothing; a file that isn't JSON is left alone", () => {
    const home = join(dir, "codex-home-setup");
    mkdirSync(home, { recursive: true });
    const file = join(home, "hooks.json");
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    const done = installCodexHooks(file, new Date("2026-10-29T12:00:00Z"));
    assert.deepEqual(done.added, Object.keys(CODEX_HOOKS));
    assert.ok(done.backup && existsSync(done.backup));
    assert.equal(JSON.parse(readFileSync(done.backup!, "utf8")).hooks.SessionStart.length, 1);
    const now = readHooksFile(file);
    assert.equal(now.hooks!.SessionStart.length, 2);
    assert.equal(now.hooks!.SessionStart[0].hooks![0].command, "mine");
    assert.deepEqual(installCodexHooks(file), { path: file, added: [], backup: null });
    const broken = join(home, "broken.json");
    writeFileSync(broken, "{ not json");
    assert.throws(() => installCodexHooks(broken));
    assert.equal(readFileSync(broken, "utf8"), "{ not json");
    const fresh = installCodexHooks(join(home, "new", "hooks.json"));
    assert.equal(fresh.backup, null);
  });
});

describe("its screens: ready for words only at its empty composer, with nothing asked or running", () => {
  const composer = "╭──╮\n│ >_ OpenAI Codex (v0.153.0) │\n╰──╯\n\n› Ask Codex to do anything\n\n  gpt-5.2 medium · ~/git/pixie\n";
  test("ready", () => assert.equal(atCodexPrompt(composer), true));
  test("not while it works, nor at its trust, hooks, update, model or sign-in questions, nor an approval", () => {
    for (const asking of [
      "• Working (3s • esc to interrupt)\n\n› Ask Codex to do anything",
      "> You are in /x\n\n  Do you trust the contents of this directory? Working with untrusted\n\n› 1. Yes, continue\n  2. No, quit",
      "  Hooks need review\n  2 hooks are new or changed.\n\n› 1. Review hooks\n  2. Trust all and continue\n\n› Ask Codex to do anything",
      "  ✨ Update available! 0.0.0 -> 9.9.9\n› 1. Update now",
      "  Would you like to run the following command?\n\n› Ask Codex to do anything",
      "› fix the bug half typed",
      "",
    ]) {
      assert.equal(atCodexPrompt(asking), false, asking.slice(0, 40));
    }
  });
});

describe("starting one: Codex only when it's said, or set", () => {
  test("Claude Code stays the main agent; both start sessions, T3 Code's threads don't", () => {
    assert.equal(mainAgent.id, "claude-code");
    assert.deepEqual(
      starters().map((a) => a.id),
      ["claude-code", "codex", "opencode"],
    );
    assert.equal(starter("", null).id, "claude-code");
    assert.equal(starter("codex", null).id, "codex");
    assert.equal(starter("", "codex").id, "codex", "the setting");
    assert.equal(starter("claude-code", "codex").id, "claude-code", "naming one wins");
    assert.equal(starter("t3code", null).id, "claude-code", "T3's threads start in T3");
  });

  test("the router's 'codex' counts only when the words say Codex", () => {
    assert.equal(namedAgent("codex", "Start a Codex session in pixie."), "codex");
    assert.equal(namedAgent("codex", "open a new codecs session"), "codex");
    assert.equal(namedAgent("codex", "Start a session in pixie."), "");
    assert.equal(namedAgent("claude-code", "start a Claude session in pixie"), "claude-code");
    assert.equal(namedAgent("", "start a codex session"), "");
    assert.ok(ASKED_FOR_NEW.test("start a Codex session in pixie"));
    assert.ok(ASKED_FOR_NEW.test("open a new codex one"));
    assert.ok(ASKED_FOR_NEW.test("spin up another codex"));
  });

  test("kiko codex: its TUI, or plain codex for a run that prints and quits", () => {
    assert.equal(codexOneShot([]), false);
    assert.equal(codexOneShot(["fix the login bug"]), false);
    assert.equal(codexOneShot(["-m", "o3", "resume", "--last"]), false);
    assert.equal(codexOneShot(["-c", "model=o3", "exec", "hi"]), true);
    assert.equal(codexOneShot(["--version"]), true);
    assert.equal(codexOneShot(["login"]), true);
  });

  test("a session started in Codex is matched only to a Codex session in its folder", () => {
    const starting = new StartingSessions();
    const entry = starting.add({ cwd: "/x/pixie", name: "", via: "tmux", known: [], agent: "codex" });
    const s = (id: string, agent?: string) =>
      ({
        sessionId: id,
        name: "pixie",
        givenName: "",
        title: "",
        nameSetBy: "claude",
        cwd: "/x/pixie",
        kind: "interactive",
        status: "idle",
        lastActiveAt: 0,
        desktop: false,
        place: null,
        mapping: "none",
        ...(agent ? { agent } : {}),
      }) as Session;
    assert.deepEqual(starting.match([s("claude-1")]), [], "a Claude Code session there isn't it");
    assert.equal(starting.sessions()[0].agent, "codex", "listed as Codex's while it starts");
    const [m] = starting.match([s("codex-1", "codex")]);
    assert.equal(m.entry.id, entry.id);
  });

  test("one at its prompt waits for its first message, not for you", () => {
    let now = 0;
    const starting = new StartingSessions(() => now);
    const entry = starting.add({ cwd: "/x/pixie", name: "", via: "tmux", known: [], agent: "codex" });
    entry.atPrompt = true;
    now = 60_000;
    assert.deepEqual(starting.due(), []);
    assert.equal(starting.sessions()[0].status, "idle");
  });
});

describe("how core describes a Codex session", () => {
  const session = (over: Partial<Session> = {}): Session =>
    ({
      sessionId: "019a",
      name: "pixie",
      givenName: "",
      title: "",
      nameSetBy: "claude",
      cwd: "/x/pixie",
      kind: "interactive",
      status: "idle",
      lastActiveAt: 0,
      desktop: false,
      place: null,
      mapping: "none",
      agent: "codex",
      ...over,
    }) as Session;

  test("its own agent, by its listing", () => {
    assert.equal(agentOf(session()), codex);
    assert.equal(agentOf({ sessionId: "019a" }).id, "claude-code", "known only by an ID it hasn't seen: the main one");
  });

  test("its menus: all of it in Kiko's tmux; outside, Close when its process is known, Rename and Interrupt only where keys reach it for sure", () => {
    const inTmux = session({ place: { via: "tmux", id: "%1", keys: true, pid: 5 }, mapping: "process", pid: 5 });
    assert.deepEqual(canDo(inTmux), { reply: true, interrupt: true, rename: true, close: true });
    const labels = (s: Session) => sessionActions(s, () => ({}) as any).map((e: any) => [e.label, e.confirm]);
    assert.deepEqual(labels(inTmux).at(-1), ["Close this session…", "Close pixie? Codex ends there."]);
    const ghosttyTitled = session({ place: { via: "ghostty", id: "g", keys: true }, mapping: "title", pid: 5 });
    assert.deepEqual(canDo(ghosttyTitled), { reply: true, interrupt: true, rename: true, close: true });
    assert.equal(closeOutsidePrompt(ghosttyTitled), "Close pixie? Codex ends in its terminal.");
    const unsure = session({ place: null, mapping: "ambiguous", pid: 5 });
    assert.deepEqual(canDo(unsure), { reply: false, interrupt: false, rename: false, close: true });
    assert.deepEqual(canDo(session({ place: null, mapping: "ambiguous" })).close, false, "no process its hook found (Codex's daemon): no Close");
  });

  test("to the router: a Codex session, in a terminal, and what can't be done to it from here", () => {
    assert.equal(placeOf(session({ place: { via: "tmux", id: "%1", keys: true, pid: 5 }, mapping: "process" })), "a Codex session, open in a terminal");
    assert.equal(placeOf(session({ place: { via: "ghostty", id: "g", keys: true }, mapping: "ambiguous" as any })), "a Codex session, open in a terminal; can't be stopped or renamed from here");
    assert.equal(placeOf(session()), "a Codex session, terminal not found");
  });
});

describe("Codex 0.166: a session found in its pane without its process (its hooks run in Codex's daemon)", () => {
  const pane = (id: string, cwd: string, command = "codex", n = Number(id.slice(1))) => ({
    id,
    pid: 100 + n,
    tty: `/dev/ttys0${n}`,
    inMode: false,
    dead: false,
    paste: true,
    role: "",
    session: `s${n}`,
    command,
    cwd,
  });
  // Each pane: its shell (the pane's first process), and its TUI in front.
  const procs = (n: number) => [
    { pid: 100 + n, ppid: 1, pgid: 100 + n, tpgid: 200 + n, stat: "Ss", tty: `ttys0${n}` },
    { pid: 200 + n, ppid: 100 + n, pgid: 200 + n, tpgid: 200 + n, stat: "S+", tty: `ttys0${n}` },
  ];
  const s = (id: string, cwd: string, extra: object = {}) => ({ sessionId: id, cwd, kind: "interactive" as const, desktop: false, titles: [], program: "codex", ...extra });

  test("the only pane running codex in its folder, when it's the only such session there; the TUI in front is its place's process", () => {
    const found = byProgram([s("a", "/x/pixie")], [pane("%1", "/x/pixie"), pane("%2", "/x/other"), pane("%3", "/x/pixie", "zsh")], [...procs(1), ...procs(2), ...procs(3)]);
    assert.deepEqual(found.get("a"), { place: { via: "tmux", id: "%1", keys: true, pid: 201 }, mapping: "only" });
  });

  test("two in one folder: by the pane it was opened in (Findable.pane), else neither", () => {
    const panes = [pane("%1", "/x/pixie"), pane("%2", "/x/pixie")];
    const all = [...procs(1), ...procs(2)];
    assert.equal(byProgram([s("a", "/x/pixie")], panes, all).get("a")?.place, null);
    assert.equal(byProgram([s("a", "/x/pixie")], panes, all).get("a")?.mapping, "ambiguous");
    const hinted = byProgram([s("a", "/x/pixie", { pane: "%2" }), s("b", "/x/pixie")], panes, all);
    assert.equal(hinted.get("a")?.place?.id, "%2");
    assert.equal(hinted.get("a")?.mapping, "process");
    assert.equal(hinted.get("b")?.place?.id, "%1", "the other one, now the only pane left there");
  });

  test("a hint whose pane no longer runs codex isn't taken; nothing in front, no place", () => {
    assert.equal(byProgram([s("a", "/x/pixie", { pane: "%1" })], [pane("%1", "/x/pixie", "zsh")], procs(1)).get("a"), undefined);
    assert.equal(byProgram([s("a", "/x/pixie")], [pane("%1", "/x/pixie")], []).get("a"), undefined);
  });

  test("Codex says which panes are its TUI's (Agent.runsAs); Claude Code doesn't look", () => {
    assert.equal(codex.runsAs!("codex"), true);
    assert.equal(codex.runsAs!("zsh"), false);
    assert.equal(mainAgent.runsAs, undefined);
  });
});

describe("a session found starting in its pane (adopted), not opened by the app", () => {
  test("listed as starting from its pane; at its prompt it never goes stale, however long it waits", () => {
    let now = 0;
    const starting = new StartingSessions(() => now);
    const entry = starting.add({ cwd: "/x/pixie", name: "", via: "tmux", handle: "%4", known: [], agent: "codex", adopted: true });
    assert.equal(entry.adopted, true);
    assert.deepEqual(starting.sessions()[0].place, { via: "tmux", id: "%4", keys: false });
    entry.atPrompt = true;
    now = 2 * 60 * 60_000;
    assert.deepEqual(starting.stale(), []);
    entry.atPrompt = false;
    assert.equal(starting.stale().length, 1, "one never at its prompt is given up on");
  });
});

describe("Codex's hooks set up but never heard from (its setup's health)", () => {
  const home = join(dir, "codex-home-health");
  const records = join(dir, "records-health");
  const since = Date.parse("2026-10-30T06:15:00Z");
  const now = Date.parse("2026-10-30T06:20:00Z");
  const day = new Date(now);
  const folder = join(home, "sessions", String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  const rollout = (id: string, at: string, meta: object = {}) => {
    const path = join(folder, `rollout-x-${id}.jsonl`);
    writeFileSync(
      path,
      [
        line("session_meta", { id, cwd: "/x/clipkit", cli_version: "0.166.0", originator: "codex-tui", source: "vscode", ...meta }, at),
        line("event_msg", { type: "task_started", turn_id: "1" }, at),
      ].join("\n") + "\n",
    );
    utimesSync(path, new Date(now), new Date(now));
    return path;
  };
  before(() => {
    mkdirSync(folder, { recursive: true });
    mkdirSync(records, { recursive: true });
  });

  test("nothing set up: not its to say (setupProblem is)", () => {
    rollout("unheard-1", "2026-10-30T06:16:00Z");
    assert.equal(
      codexHookSilence(since, () => false, home, now, records),
      null,
    );
  });

  test("set up, a turn nothing told of: said, with what to check; heard, recorded, too fresh, from before, or a one-shot exec: fine", () => {
    installCodexHooks(join(home, "hooks.json"));
    const silent = codexHookSilence(since, () => false, home, now, records);
    assert.equal(silent?.sessionId, "unheard-1");
    assert.match(silent!.detail, /a Codex turn in clipkit ran, but none of its hooks reached Kiko/);
    assert.match(silent!.detail, /check \/hooks/);
    assert.equal(silent!.fields.cliVersion, "0.166.0");
    assert.equal(
      codexHookSilence(since, (id) => id === "unheard-1", home, now, records),
      null,
      "its hook told of it",
    );
    writeFileSync(join(records, "unheard-1.json"), JSON.stringify({ sessionId: "unheard-1", cwd: "/x/clipkit" }));
    assert.equal(
      codexHookSilence(since, () => false, home, now, records),
      null,
      "its hook ran (a record), with Kiko off",
    );
    rmSync(join(records, "unheard-1.json"));
    assert.equal(
      codexHookSilence(since, () => false, home, Date.parse("2026-10-30T06:16:05Z"), records),
      null,
      "its hooks still have time",
    );
    assert.equal(
      codexHookSilence(Date.parse("2026-10-30T06:17:00Z"), () => false, home, now, records),
      null,
      "a turn from before Kiko started",
    );
    rmSync(join(folder, "rollout-x-unheard-1.jsonl"));
    rollout("exec-1", "2026-10-30T06:16:00Z", { source: "exec", originator: "codex_exec" });
    assert.equal(
      codexHookSilence(since, () => false, home, now, records),
      null,
      "codex exec isn't a session Kiko lists",
    );
    // A T3 Code thread on Codex: its hooks run, and Kiko's leave it alone (hooks/codex-hook.mjs), so none is heard.
    rollout("t3-1", "2026-10-30T06:16:00Z", { source: "vscode", originator: "T3 Code", cli_version: "0.153.0" });
    assert.equal(
      codexHookSilence(since, () => false, home, now, records),
      null,
      "another app's session isn't Kiko's to hear",
    );
  });

  test("a Codex newer than the one Kiko was checked against says so", () => {
    rollout("newer-1", "2026-10-30T06:16:00Z", { cli_version: "0.170.2" });
    assert.match(codexHookSilence(since, () => false, home, now, records)!.detail, /this Codex is 0\.170\.2, newer than the 0\.166\.0 Kiko was checked against/);
    assert.equal(newerThan("0.166.0", "0.166.0"), false);
    assert.equal(newerThan("0.153.0", "0.166.0"), false);
    assert.equal(newerThan("1.0.0", "0.166.0"), true);
    assert.equal(CODEX_CHECKED.newest, "0.166.0");
  });
});

// ── Codex 0.166's shared app-server daemon (src/agents/codex/daemon.ts), against the fake's
// (tests/support/fake-codex.mjs startAppServer, run here in-process, with TuiLink as its TUIs) ──

describe("Codex's daemon: its threads as Kiko reads them", () => {
  test("a thread's status in Kiko's words: working, waiting on you in its window, or idle", () => {
    assert.equal(statusOf({ type: "idle" }), "idle");
    assert.equal(statusOf({ type: "active", activeFlags: [] }), "busy");
    assert.equal(statusOf({ type: "active", activeFlags: ["waitingOnApproval"] }), "blocked");
    assert.equal(statusOf({ type: "active", activeFlags: ["waitingOnUserInput"] }), "blocked");
    assert.equal(statusOf({ type: "systemError" }), "idle");
    assert.equal(statusOf(undefined), "idle");
  });

  test("a session in a terminal is a thread of Codex's TUI; a subagent's, a review's, an ephemeral one, an exec's or an app's isn't", () => {
    const t = {
      id: "019a",
      cwd: "/x/clipkit",
      name: " Nova ",
      status: { type: "idle" },
      ephemeral: false,
      parentThreadId: null,
      source: "vscode",
      originator: "codex-tui",
      path: "/h/rollout.jsonl",
      createdAt: 10,
      updatedAt: 20,
    };
    assert.deepEqual(threadOf(t, 5), { id: "019a", cwd: "/x/clipkit", name: "Nova", status: "idle", statusAt: 5, path: "/h/rollout.jsonl", createdAt: 10_000, updatedAt: 20_000 });
    assert.equal(threadOf({ ...t, originator: "codex_cli_rs", source: "cli" })?.id, "019a", "an older TUI's, resumed");
    assert.equal(threadOf({ ...t, originator: null })?.id, "019a", "no originator recorded");
    assert.equal(threadOf({ ...t, name: null })?.name, "");
    assert.equal(threadOf({ ...t, parentThreadId: "p" }), null);
    assert.equal(threadOf({ ...t, source: { subAgent: "review" } }), null);
    assert.equal(threadOf({ ...t, ephemeral: true }), null);
    assert.equal(threadOf({ ...t, source: "exec" }), null);
    assert.equal(threadOf({ ...t, source: "appServer" }), null);
    assert.equal(threadOf({ ...t, originator: "Codex Desktop" }), null);
    assert.equal(threadOf({ ...t, cwd: "" }), null);
  });

  test("which processes are Codex's TUI, and in which folder: never its daemon (its pid records, its package), never another program", () => {
    const home = mkdtempSync(join(tmpdir(), "cbd-"));
    mkdirSync(join(home, "app-server-daemon"), { recursive: true });
    writeFileSync(join(home, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid: 100, processStartTime: "x" }));
    writeFileSync(join(home, "app-server-daemon", "daemon-updater.pid"), JSON.stringify({ pid: 101 }));
    writeFileSync(join(home, "app-server-daemon", "junk.pid"), "not json");
    assert.deepEqual([...daemonPids(home)].sort(), [100, 101]);
    assert.equal(daemonPids(join(home, "nowhere")).size, 0);
    const comms = parsePidField(
      [
        "  100 /h/.codex/packages/app-server-daemon/releases/0.166.0/bin/codex",
        "  101 /h/.codex/packages/app-server-daemon/releases/0.166.0/bin/codex",
        "  102 /h/.codex/packages/app-server-daemon/current/bin/codex",
        "  200 /opt/node/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex",
        "  201 /opt/homebrew/bin/codex",
        "  202 /opt/homebrew/bin/codex",
        "  300 /bin/zsh",
      ].join("\n"),
    );
    assert.equal(comms.get(200), "/opt/node/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex");
    const cwds = parseCwds("p100\nfcwd\nn/x/clipkit\np102\nfcwd\nn/x/clipkit\np200\nfcwd\nn/x/clipkit\np201\nfcwd\nn/x/kiko\np202\nfcwd\nn/x/kiko\np300\nfcwd\nn/x/other\n");
    assert.equal(cwds.get(201), "/x/kiko");
    assert.deepEqual(
      [...tuiFoldersOf(comms, cwds, daemonPids(home))],
      [
        ["/x/clipkit", 1],
        ["/x/kiko", 2],
      ],
    );
    rmSync(home, { recursive: true, force: true });
  });
});

describe("Codex's sessions: its hook's records and its daemon's threads, each session once", () => {
  const rec = (r: Partial<CodexRecord>): CodexRecord => ({ sessionId: "s", cwd: "/x/pixie", status: "idle", at: 1, ...r });
  const thread = (t: Partial<DaemonThread>): DaemonThread => ({ id: "t", cwd: "/x/clipkit", name: "", status: "idle", statusAt: 50, path: null, createdAt: 1000, updatedAt: 2000, ...t });
  const names = new Map([["nova", "Nova"]]);
  const nameOf = (id: string) => names.get(id) ?? "";
  const ids = (l: AgentSession[]) => l.map((s) => s.sessionId).sort();

  test("no daemon to ask (before 0.166, or none open): the records, as before", () => {
    const times = new Map([[10, "T"]]);
    const l = mergeLive([rec({ sessionId: "a", pid: 10, procStart: "T" }), rec({ sessionId: "b" })], times, { threads: null, folders: null }, nameOf);
    // "b" has no pid and no lock in this test's home: as liveRecords keeps it.
    assert.deepEqual(ids(l), ["a"]);
  });

  test("open with no turn yet (no record): listed from its daemon, named as Codex names it, while a TUI runs in its folder", () => {
    const folders = new Map([["/x/clipkit", 1]]);
    const [s] = mergeLive([], new Map(), { threads: [thread({ id: "nova", status: "busy" })], folders }, nameOf);
    assert.deepEqual([s.sessionId, s.name, s.givenName, s.status, s.agent, s.program, s.pid, s.cwd], ["nova", "clipkit", "Nova", "busy", "codex", "codex", undefined, "/x/clipkit"]);
    assert.deepEqual(s.titles, ["Nova", "nova"]);
    assert.equal(mergeLive([], new Map(), { threads: [thread({ id: "nova" })], folders: new Map() }, nameOf).length, 0, "its TUI gone: not listed, though the daemon keeps it a while");
    assert.equal(mergeLive([], new Map(), { threads: [thread({ id: "nova" })], folders: null }, nameOf).length, 1, "the processes couldn't be looked at: loaded is enough");
  });

  test("in both (its hooks have run): one row, the record's process and rollout, the daemon's status unless the hook told one since, one name", () => {
    const folders = new Map([["/x/clipkit", 1]]);
    const r = rec({ sessionId: "nova", cwd: "/x/clipkit", status: "idle", at: 100 });
    const l = mergeLive([r], new Map(), { threads: [thread({ id: "nova", status: "busy", statusAt: 50, name: "stale" })], folders }, nameOf);
    assert.equal(l.length, 1);
    assert.equal(l[0].status, "idle", "the hook told it last (a turn held for you, which the daemon still calls working)");
    assert.equal(l[0].givenName, "Nova", "one name, from nameOf, whatever else either says");
    const later = mergeLive([r], new Map(), { threads: [thread({ id: "nova", status: "busy", statusAt: 200 })], folders }, nameOf);
    assert.equal(later[0].status, "busy", "the daemon told it last");
    assert.equal(later[0].lastActiveAt, 2000, "the newer of the two");
  });

  test("a record without a process (its hooks ran in the daemon) goes with its thread: its TUI quit, it leaves the list, lock or not", () => {
    const r = rec({ sessionId: "nova", cwd: "/x/clipkit" });
    assert.equal(mergeLive([r], new Map(), { threads: [thread({ id: "nova" })], folders: new Map() }, nameOf).length, 0);
    assert.equal(mergeLive([r], new Map(), { threads: [], folders: new Map() }, nameOf).length, 0, "not loaded: gone");
    const times = new Map([[10, "T"]]);
    const withPid = rec({ sessionId: "old", pid: 10, procStart: "T" });
    assert.deepEqual(ids(mergeLive([withPid], times, { threads: [], folders: new Map() }, nameOf)), ["old"], "one with its process (0.153, or its own app-server): by its process, as before");
  });
});

describe("Codex's daemon, connected (the fake's, in-process)", () => {
  const FAKE_URL: string = new URL("../../support/fake-codex.mjs", import.meta.url).href;
  let fake: any;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cbd-")));
  // Its reconnect waits RETRY_MS (2 s) between tries: on a busy machine, found again some while after that.
  const until = valueWaits(10_000, 20);
  const logged: Array<[string, Record<string, unknown>]> = [];
  const make = () => new CodexDaemon(() => ({ home, log: (e, d) => void logged.push([e, d]) }));

  before(async () => {
    fake = await import(FAKE_URL);
  });
  after(() => rmSync(home, { recursive: true, force: true }));

  test("no daemon running: nothing listed from it, nothing thrown; not started: nothing asked", async () => {
    const d = make();
    assert.equal(await d.loaded(), null, "not started");
    await d.start();
    assert.equal(d.connected, false);
    assert.equal(await d.loaded(), null);
    assert.deepEqual(await d.rename("x", "y"), { done: false, why: "Codex's app server isn't connected" });
    assert.deepEqual(logged.at(-1), ["codex_daemon", { ok: false, why: "not running" }]);
    d.stop();
  });

  test("a thread opened with no turn is listed; a /rename in Codex and one from Kiko each reach the other; its TUI gone, it's let go", async () => {
    const server = await fake.startAppServer(home, { unloadMs: 150 });
    const d = make();
    let changed = 0;
    d.onChanged = () => changed++;
    await d.start();
    assert.equal(d.connected, true);
    assert.deepEqual(await d.loaded(), []);

    // A TUI opens its thread: told at once (thread/started), listed with no turn.
    const tui = await new fake.TuiLink(home).open();
    const notes: Array<[string, any]> = [];
    tui.onNote = (method: string, params: any) => notes.push([method, params]);
    await tui.request("thread/start", { threadId: "019a-nova", cwd: "/x/clipkit", path: join(home, "rollout.jsonl") });
    await until(
      () => changed,
      (n) => n >= 1,
      "told it opened",
    );
    const [t] = (await d.loaded())!;
    assert.deepEqual([t.id, t.cwd, t.name, t.status, t.path], ["019a-nova", "/x/clipkit", "", "idle", join(home, "rollout.jsonl")]);
    assert.equal(d.has("019a-nova"), true);
    assert.equal(d.nameOf("019a-nova"), "");
    assert.equal(d.nameOf("unknown"), undefined, "not one of its threads: someone else's to name");

    // /rename in Codex (its TUI asks its daemon): told, named.
    const before = changed;
    await tui.request("thread/name/set", { threadId: "019a-nova", name: "Nova" });
    await until(
      () => d.nameOf("019a-nova"),
      (n) => n === "Nova",
      "the new name",
    );
    assert.ok(changed > before, "listed again");

    // Renamed from Kiko: Codex takes it, tells its TUI, writes its index.
    assert.deepEqual(await d.rename("019a-nova", "Docs pass"), { done: true });
    await until(
      () => notes,
      (n) => n.some(([m, p]) => m === "thread/name/updated" && p.threadName === "Docs pass"),
      "its TUI told",
    );
    assert.equal(threadNames(home).get("019a-nova"), "Docs pass", "session_index.jsonl, as Codex writes it");
    assert.deepEqual(await d.rename("019a-nova", "  "), { done: false, why: "Codex didn't take it (thread name must not be empty)" });

    // Working, and interrupted through it; nothing running: said so.
    await tui.request("fake/turn", { threadId: "019a-nova", turnId: "turn-1", running: true });
    await until(
      () => d.loaded(),
      (l) => l?.[0]?.status === "busy",
      "busy",
    );
    assert.deepEqual(await d.interrupt("019a-nova"), { done: true });
    await until(
      () => notes,
      (n) => n.some(([m, p]) => m === "fake/interrupt" && p.turnId === "turn-1"),
      "the turn interrupted",
    );
    await tui.request("fake/turn", { threadId: "019a-nova", turnId: "turn-1", running: false, interrupted: true });
    await until(
      () => d.loaded(),
      (l) => l?.[0]?.status === "idle",
      "idle",
    );
    assert.deepEqual(await d.interrupt("019a-nova"), { done: false, why: "it isn't running anything" });
    assert.ok(logged.some(([e, x]) => e === "codex_command" && x.method === "turn/interrupt" && x.ok === true));

    // Its TUI quits: let go a while later (thread/closed), and not listed from it.
    const was = changed;
    tui.close();
    await until(
      () => changed,
      (n) => n > was,
      "told it closed",
    );
    assert.deepEqual(await d.loaded(), []);
    assert.equal(d.has("019a-nova"), false);
    assert.ok(server.requests.includes("thread/loaded/list"), "asked which threads are open");
    assert.ok(!server.requests.some((m: string) => /resume|subscribe|turn\/start|steer/.test(m)), "never subscribed to a thread, never started a turn");
    d.stop();
    server.close();
  });

  test("its daemon restarts: nothing listed from it meanwhile, found again at the next listing, with its threads", async () => {
    let server = await fake.startAppServer(home, { unloadMs: 60_000 });
    const d = make();
    let changed = 0;
    d.onChanged = () => changed++;
    await d.start();
    const tui = await new fake.TuiLink(home).open();
    await tui.request("thread/start", { threadId: "019b", cwd: "/x/pixie" });
    await until(
      () => d.loaded(),
      (l) => l?.length === 1,
      "listed",
    );
    const was = changed;
    server.close();
    await until(
      () => changed,
      (n) => n > was,
      "told it went",
    );
    assert.equal(d.connected, false);
    assert.equal(await d.loaded(), null, "no daemon: the hooks' records alone");
    server = await fake.startAppServer(home, { unloadMs: 60_000 });
    const again = await new fake.TuiLink(home).open();
    await again.request("thread/start", { threadId: "019b", cwd: "/x/pixie" });
    assert.deepEqual(
      (await until(
        () => d.loaded(),
        (l) => l?.length === 1,
        "found again",
      ))!.map((t) => t.id),
      ["019b"],
    );
    again.close();
    d.stop();
    server.close();
  });

  test("Rename and Interrupt are Codex's own for a session its daemon has, wherever it runs, even in Kiko's tmux; typed for one it hasn't", async () => {
    const server = await fake.startAppServer(home, { unloadMs: 60_000 });
    const tui = await new fake.TuiLink(home).open();
    await tui.request("thread/start", { threadId: "019c", cwd: "/x/pixie" });
    const was = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    await codexDaemon.start();
    try {
      await until(
        () => codexDaemon.loaded(),
        (l) => Boolean(l?.some((t) => t.id === "019c")),
        "listed",
      );
      const session = (over: Partial<Session> = {}): Session =>
        ({
          sessionId: "019c",
          name: "pixie",
          givenName: "",
          title: "",
          nameSetBy: "claude",
          cwd: "/x/pixie",
          kind: "interactive",
          status: "idle",
          lastActiveAt: 0,
          desktop: false,
          place: null,
          mapping: "none",
          agent: "codex",
          ...over,
        }) as Session;
      // In Warp or iTerm (no place): renamed and interrupted all the same.
      assert.deepEqual(canDo(session()), { reply: false, interrupt: true, rename: true, close: false });
      assert.equal(byAgent(session(), "rename"), true);
      assert.equal(
        byAgent(session({ place: { via: "tmux", id: "%1", keys: true, pid: 5 }, mapping: "process" }), "rename"),
        true,
        "through its daemon even in Kiko's tmux: nothing typed over a draft",
      );
      assert.equal(byAgent(session({ sessionId: "not-open" }), "rename"), false, "one its daemon doesn't have: typed, where keys reach it");
      assert.deepEqual(canDo(session({ sessionId: "not-open" })), { reply: false, interrupt: false, rename: false, close: false });
      assert.equal(
        sessionActions(session(), () => ({}) as any).some((e: any) => e.label === "Interrupt"),
        true,
        'not "Interrupt (Escape)": no key',
      );
      assert.equal(codexNameOf("019c"), "");
      await tui.request("thread/name/set", { threadId: "019c", name: "Pixie docs" });
      await until(
        () => codexNameOf("019c"),
        (n) => n === "Pixie docs",
        "Codex's name, from its daemon",
      );
    } finally {
      codexDaemon.stop();
      if (was === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = was;
      tui.close();
      server.close();
    }
  });
});
