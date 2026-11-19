// What "working" means for a Claude Code session: in a turn (src/agents/claude-code/turns.ts), from
// its hooks first, `claude agents --json` only where they haven't spoken, and its transcript for
// what the hooks don't say; and what it still runs in the background shown apart, from its job's
// state.json and its tasks' output (background.ts). The case behind it: "Kiko project", a
// background job, listed busy / working for hours while it sat at its prompt, because three
// leftover background shells of a subagent kept the job in flight.
// Everything is read from fixtures: tests/setup.ts points the transcripts, ~/.claude/jobs and the
// tasks' folder at this process's own.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { backgroundOf, forgetBackground, jobBackground, QUIET_MS, sessionBackground, tasksDir, transcriptTasks } from "../../../../src/agents/claude-code/background.ts";
import { HookHeld, type HookEvent } from "../../../../src/agents/claude-code/hooks.ts";
import { continued, describe as describeListed, startedAt, statusOf } from "../../../../src/agents/claude-code/sessions.ts";
import { transcriptPath, transcriptTurn, turnEnded } from "../../../../src/agents/claude-code/transcripts.ts";
import { forgetTurns, inTurn, noteHook, OPEN_GRACE_MS, turnOf, turnResumed } from "../../../../src/agents/claude-code/turns.ts";
import type { AgentSession } from "../../../../src/agents/types.ts";
import { backgroundNote } from "../../../../src/core/ui-store.ts";

const HOUR = 3600_000;
const line = (entry: object) => JSON.stringify(entry);
const prompt = (text: string) => line({ type: "user", message: { role: "user", content: text } });
const said = (text: string, stop_reason = "end_turn") => line({ type: "assistant", message: { role: "assistant", stop_reason, content: [{ type: "text", text }] } });
const toolCall = () => line({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
const toolResult = () => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
const turnDuration = () => line({ type: "system", subtype: "turn_duration", durationMs: 1200 });
// Claude Code's own bookkeeping after a turn: says nothing either way.
const bookkeeping = [
  line({ type: "system", subtype: "stop_hook_summary" }),
  line({ type: "last-prompt", lastPrompt: "x" }),
  line({ type: "cost-state", totalCostUSD: 1 }),
  line({ type: "queue-operation", operation: "enqueue", content: "<task-notification>…" }),
];
const notification = () =>
  line({ type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>\n<task-id>bbersg62l</task-id>\n<status>completed</status>" } });

describe("turnEnded: whether a transcript's tail ends a turn", () => {
  test("the assistant's final message, or the turn's own turn_duration line after it, ends one; Claude Code's bookkeeping after it doesn't change that", () => {
    assert.equal(turnEnded([prompt("fix it"), said("Fixed.")].join("\n")), true);
    assert.equal(turnEnded([prompt("fix it"), said("Fixed."), turnDuration(), ...bookkeeping].join("\n")), true);
  });
  test("a prompt, a tool call or its result, a text block mid-turn, a background task's notification: a turn goes on", () => {
    assert.equal(turnEnded([said("Done."), prompt("and the tests?")].join("\n")), false);
    assert.equal(turnEnded([prompt("fix it"), toolCall()].join("\n")), false);
    assert.equal(turnEnded([prompt("fix it"), toolCall(), toolResult(), ...bookkeeping].join("\n")), false);
    assert.equal(turnEnded([prompt("fix it"), said("Let me look.", null as never)].join("\n")), false);
    assert.equal(turnEnded([said("Done."), turnDuration(), notification()].join("\n")), false);
  });
  test("interrupted with Esc (no Stop hook comes) ends it; a command run at its prompt, or a meta line, says nothing", () => {
    assert.equal(turnEnded([prompt("fix it"), toolCall(), prompt("[Request interrupted by user for tool use]")].join("\n")), true);
    const login = [
      line({ type: "user", isMeta: true, message: { content: "<local-command-caveat>…" } }),
      prompt("<command-name>/login</command-name>"),
      prompt("<local-command-stdout>Login successful</local-command-stdout>"),
    ];
    assert.equal(turnEnded([said("Done."), ...login].join("\n")), true);
    assert.equal(turnEnded([prompt("fix it"), toolCall(), ...login].join("\n")), false);
  });
  test("nothing that says, or a first line cut in half by the tail read: null", () => {
    assert.equal(turnEnded(bookkeeping.join("\n")), null);
    assert.equal(turnEnded(""), null);
    assert.equal(turnEnded(`e":"half a line"}\n${bookkeeping[1]}`), null);
  });
});

describe("inTurn: the hooks first, then `claude agents`, with the transcript", () => {
  const T = 1_000_000;
  test("Stop ended the turn: not in one, however busy `claude agents` says it is (the left-over background shells)", () => {
    assert.equal(inTurn({ open: false, at: T }, { at: T - 10, ended: true }, true, T + 8 * 3600_000), false);
    assert.equal(inTurn({ open: false, at: T }, null, true, T + 1), false);
  });
  test("…unless the transcript, written since, is in a turn again: a background task's notification starts one with no UserPromptSubmit", () => {
    assert.equal(inTurn({ open: false, at: T }, { at: T + 500, ended: false }, true, T + 600), true);
    assert.equal(inTurn({ open: false, at: T }, { at: T + 500, ended: true }, true, T + 600), false, "the Stop's own lines after it");
    assert.equal(inTurn({ open: false, at: T }, { at: T - 500, ended: false }, true, T + 600), false, "written before the Stop: the turn it ended");
  });
  test("a turn the hooks opened: in it, even while `claude agents` doesn't say busy yet", () => {
    assert.equal(inTurn({ open: true, at: T }, { at: T - 10, ended: true }, false, T + 1000), true);
    assert.equal(inTurn({ open: true, at: T }, null, null, T + 1000), true);
  });
  test("…until its transcript, written since, ends it (interrupted: no Stop), or `claude agents` says idle well after it opened", () => {
    assert.equal(inTurn({ open: true, at: T }, { at: T + 5000, ended: true }, true, T + 6000), false);
    assert.equal(inTurn({ open: true, at: T }, { at: T + 5000, ended: false }, false, T + OPEN_GRACE_MS - 1), true);
    assert.equal(inTurn({ open: true, at: T }, { at: T + 5000, ended: false }, false, T + OPEN_GRACE_MS + 1), false);
  });
  test("no hook this run (Kiko restarted mid-turn; a session found late): `claude agents`' word, except a busy one whose last turn ended", () => {
    assert.equal(inTurn(undefined, { at: T, ended: true }, true, T + 1000), false);
    assert.equal(inTurn(undefined, { at: T, ended: false }, true, T + 1000), null);
    assert.equal(inTurn(undefined, { at: T, ended: null }, true, T + 1000), null);
    assert.equal(inTurn(undefined, { at: T, ended: false }, false, T + 1000), null);
    assert.equal(inTurn(undefined, null, true, T + 1000), null);
  });
});

describe("noteHook: each hook as it bears on the turn", () => {
  beforeEach(() => forgetTurns());
  test("UserPromptSubmit opens a turn, Stop ends it; a permission prompt or a blocked tool call means one is open; whether it changed", () => {
    assert.equal(noteHook("UserPromptSubmit", "s1", undefined, 10), true);
    assert.deepEqual(turnOf("s1"), { open: true, at: 10 });
    assert.equal(noteHook("PermissionRequest", "s1", undefined, 20), false, "still open: nothing to draw again");
    assert.deepEqual(turnOf("s1"), { open: true, at: 20 });
    assert.equal(noteHook("Stop", "s1", undefined, 30), true);
    assert.deepEqual(turnOf("s1"), { open: false, at: 30 });
    assert.equal(noteHook("PermissionDenied", "s1", undefined, 40), true);
    assert.equal(turnOf("s1")!.open, true);
  });
  test("a session starting has no turn yet, but compaction comes mid-turn too; SessionEnd forgets it; other events and bad IDs are nothing", () => {
    noteHook("UserPromptSubmit", "s2", undefined, 10);
    assert.equal(noteHook("SessionStart", "s2", "compact", 20), false);
    assert.equal(turnOf("s2")!.open, true);
    assert.equal(noteHook("SessionStart", "s2", "resume", 30), true);
    assert.equal(turnOf("s2")!.open, false);
    noteHook("SessionEnd", "s2");
    assert.equal(turnOf("s2"), undefined);
    assert.equal(noteHook("Notification", "s3"), false);
    assert.equal(noteHook("Stop", 42), false);
    assert.equal(turnOf("s3"), undefined);
  });
  test("a held Stop answered with your reply carries the turn on (no UserPromptSubmit comes); let go, or a permission answered, it doesn't", () => {
    class Held extends HookHeld {
      open = true;
      protected send() {
        return true;
      }
    }
    const stop = (id: string) => ({ hook_event_name: "Stop", session_id: id, cwd: "/x" }) as HookEvent;
    noteHook("Stop", "r1");
    new Held(stop("r1")).answer("and the tests too");
    assert.equal(turnOf("r1")!.open, true);
    noteHook("Stop", "r2");
    new Held(stop("r2")).answer(null);
    new Held(stop("r2")).answer("   ");
    assert.equal(turnOf("r2")!.open, false);
    turnResumed("r3");
    assert.equal(turnOf("r3")!.open, true);
  });
});

describe("statusOf with the turn: busy or not is the turn's; a dialog and a question keep theirs", () => {
  test("in a turn: busy; not: idle, or waiting for a job stopped on a question; a dialog in its window needs you either way", () => {
    assert.equal(statusOf({ status: "busy", state: "working" }, false), "idle");
    assert.equal(statusOf({ status: "idle" }, true), "busy");
    assert.equal(statusOf({ status: "busy", state: "blocked" }, false), "waiting");
    assert.equal(statusOf({ status: "waiting" }, true), "blocked");
    assert.equal(statusOf({ state: "working" }, false), "idle");
    // Not known: `claude agents`' word, as before.
    assert.equal(statusOf({ status: "busy", state: "working" }, null), "busy");
    assert.equal(statusOf({ status: "busy", state: "blocked" }), "busy");
  });
});

/** A session's transcript in the fixture projects (tests/setup.ts), written `agoMs` ago. */
function transcript(cwd: string, sessionId: string, lines: string[], agoMs = 0) {
  const path = transcriptPath(cwd, sessionId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  const at = new Date(Date.now() - agoMs);
  utimesSync(path, at, at);
  return path;
}

/** A background job's state.json in the fixture jobs folder. */
function jobState(job: string, state: object) {
  const dir = join(process.env.KIKO_CLAUDE_JOBS!, job);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
}

/** A task's output file, last written `agoMs` ago. */
function output(cwd: string, sessionId: string, id: string, agoMs: number) {
  const dir = tasksDir(cwd, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.output`);
  writeFileSync(path, "waiting\n");
  const at = new Date(Date.now() - agoMs);
  utimesSync(path, at, at);
  return path;
}

describe("describe: the listed session's status and background work", () => {
  beforeEach(() => forgetTurns());
  // "Kiko project" as `claude agents --json` listed it: busy / working, a background job.
  const project = (sessionId: string, job: string) => ({ pid: 4242, id: job, sessionId, name: "Kiko project", cwd: "/Users/me/git/kiko", kind: "background", status: "busy", state: "working" });

  test("the Stop it heard beats `claude agents`' busy: idle, with its three left-over shells shown apart, quiet for hours", () => {
    const id = "e9a4c7d2-0000-4000-8000-000000000001";
    const a = project(id, "e9a4c7d2");
    transcript(a.cwd, id, [prompt("add a line"), toolCall(), toolResult(), said("I've added the line."), turnDuration()], 8 * HOUR);
    const started = Date.now() - 9 * HOUR;
    jobState("e9a4c7d2", {
      state: "working",
      inFlight: { tasks: 3, queued: 0, kinds: ["local_bash"] },
      fan: [
        { id: "a3115a78d573e9342", kind: "agent", label: "Build the small fixes batch", startedAt: started - HOUR, doneAt: started },
        { id: "bbersg62l", kind: "shell", label: "until grep -q …", startedAt: started },
        { id: "bwo5llp54", kind: "shell", label: "until grep -q …", startedAt: started + 1000 },
        { id: "bo9enkubs", kind: "shell", label: "until ! pgrep -f …", startedAt: started + 2000 },
      ],
    });
    for (const task of ["bbersg62l", "bwo5llp54", "bo9enkubs"]) output(a.cwd, id, task, 8 * HOUR);
    noteHook("UserPromptSubmit", id, undefined, Date.now() - 9 * HOUR);
    noteHook("Stop", id, undefined, Date.now() - 8 * HOUR);
    const s = describeListed(a, null);
    assert.equal(s.status, "idle");
    assert.equal(s.jobId, "e9a4c7d2");
    assert.equal(s.background?.count, 3);
    assert.equal(s.background?.quiet, 3);
    assert.ok(Math.abs(s.background!.quietSince! - (Date.now() - 8 * HOUR)) < 5000, String(s.background?.quietSince));
    assert.match(backgroundNote(s), /^3 in background \(quiet 8h\)$/);
  });

  test("with no hook heard (Kiko restarted since): its transcript's ended turn says idle; one mid-tool-call stays busy, as `claude agents` says", () => {
    const idle = "e9a4c7d2-0000-4000-8000-000000000002";
    transcript("/Users/me/git/kiko", idle, [prompt("add a line"), said("Done."), turnDuration(), ...bookkeeping], 3 * 60_000);
    assert.equal(describeListed(project(idle, "aaaa0002"), null).status, "idle");
    const busy = "e9a4c7d2-0000-4000-8000-000000000003";
    transcript("/Users/me/git/kiko", busy, [prompt("run the build"), toolCall()], 5 * 60_000);
    assert.equal(describeListed(project(busy, "aaaa0003"), null).status, "busy");
    // Nothing on disk at all: `claude agents`' word.
    assert.equal(describeListed(project("e9a4c7d2-0000-4000-8000-000000000004", "aaaa0004"), null).status, "busy");
  });

  test("a turn the hooks opened is busy even as `claude agents` still says idle; a background task's notification after the Stop is a turn too", () => {
    const id = "e9a4c7d2-0000-4000-8000-000000000005";
    const cwd = "/Users/me/git/kiko";
    transcript(cwd, id, [said("Done."), turnDuration()], 60_000);
    noteHook("UserPromptSubmit", id);
    assert.equal(describeListed({ ...project(id, "aaaa0005"), status: "idle", state: "done" }, null).status, "busy");
    noteHook("Stop", id, undefined, Date.now() - 30_000);
    transcript(cwd, id, [said("Done."), turnDuration(), notification()], 0);
    assert.equal(describeListed(project(id, "aaaa0005"), null).status, "busy");
    transcript(cwd, id, [said("Done."), turnDuration(), notification(), said("The tests passed.")], 0);
    assert.equal(describeListed(project(id, "aaaa0005"), null).status, "idle");
  });

  test("an idle terminal session runs nothing in the background (its process says so); one moved into a job shows the job's", () => {
    const id = "e9a4c7d2-0000-4000-8000-000000000006";
    const terminal = describeListed({ pid: 77, sessionId: id, name: "pixie", cwd: "/Users/me/git/pixie", kind: "interactive", status: "idle" }, null);
    assert.equal(terminal.background, undefined);
    const job: AgentSession = { ...terminal, sessionId: "job-session", kind: "background", jobId: "cafe0001", status: "idle", background: { count: 2 } };
    assert.deepEqual(continued(job, terminal).background, { count: 2 });
    assert.equal(continued({ ...job, background: undefined }, terminal).background, undefined);
  });
});

describe("backgroundOf: what a job's state.json says still runs, and which of it is quiet", () => {
  const NOW = 10_000_000_000;
  test("inFlight.tasks is how many; the newest of its fan entries not done are those, each quiet once nothing's been written for 10 minutes", () => {
    const state = {
      inFlight: { tasks: 2 },
      fan: [
        { id: "old", kind: "shell", startedAt: NOW - 50 * 60_000 },
        { id: "agent", kind: "agent", startedAt: NOW - 40 * 60_000 },
        { id: "shell", kind: "shell", startedAt: NOW - 30 * 60_000 },
        { id: "done", kind: "agent", startedAt: NOW - 20 * 60_000, doneAt: NOW - 60_000 },
      ],
    };
    // The subagent's transcript written a minute ago; the shell's output not since it started.
    const written: Record<string, number> = { agent: NOW - 60_000, shell: 0, old: NOW - 1000 };
    assert.deepEqual(
      backgroundOf(state, (id) => written[id] ?? 0, NOW),
      { count: 2, agents: 1, quiet: 1, quietSince: NOW - 30 * 60_000 },
    );
    // All of it busy: no flag.
    assert.deepEqual(
      backgroundOf(state, () => NOW - 1000, NOW),
      { count: 2, agents: 1 },
    );
    // Just under the line isn't quiet yet.
    assert.deepEqual(
      backgroundOf({ inFlight: { tasks: 1 }, fan: [{ id: "x", startedAt: NOW - QUIET_MS + 1000 }] }, () => 0, NOW),
      { count: 1, agents: 0 },
    );
  });
  test("nothing in flight, no state, or a state it can't read: undefined; no inFlight: its fan entries not done", () => {
    assert.equal(
      backgroundOf({ inFlight: { tasks: 0 }, fan: [{ id: "x", startedAt: NOW }] }, () => 0, NOW),
      undefined,
    );
    assert.equal(
      backgroundOf(null, () => 0, NOW),
      undefined,
    );
    assert.equal(
      backgroundOf("nonsense", () => 0, NOW),
      undefined,
    );
    assert.deepEqual(
      backgroundOf(
        {
          fan: [
            { id: "x", startedAt: NOW - 1000 },
            { id: "y", startedAt: NOW, doneAt: NOW },
          ],
        },
        () => 0,
        NOW,
      ),
      { count: 1, agents: 0 },
    );
    // More in flight than its fan names (a monitor, say): counted, but only what it names can be quiet.
    assert.deepEqual(
      backgroundOf({ inFlight: { tasks: 3 }, fan: [{ id: "x", startedAt: NOW - HOUR }] }, () => 0, NOW),
      { count: 3, agents: 0, quiet: 1, quietSince: NOW - HOUR },
    );
  });
  test("jobBackground reads the job's file and its tasks' output; a subagent's output is a link to its transcript, followed", () => {
    const cwd = "/Users/me/git/clipkit";
    const session = "5e551011-0000-4000-8000-000000000001";
    jobState("beef0001", {
      inFlight: { tasks: 2 },
      fan: [
        { id: "a1", kind: "agent", startedAt: Date.now() - HOUR },
        { id: "b1", kind: "shell", startedAt: Date.now() - HOUR },
      ],
    });
    const agentTranscript = transcript(cwd, "agent-a1", [toolCall()], 30_000);
    mkdirSync(tasksDir(cwd, session), { recursive: true });
    symlinkSync(agentTranscript, join(tasksDir(cwd, session), "a1.output"));
    output(cwd, session, "b1", 2 * HOUR);
    const bg = jobBackground("beef0001", cwd, session)!;
    assert.equal(bg.count, 2);
    assert.equal(bg.quiet, 1, "the shell, not the subagent still writing");
    assert.equal(jobBackground("nope0001", cwd, session), undefined);
    assert.equal(jobBackground("../escape", cwd, session), undefined);
  });
});

// A terminal session's background tasks, from its transcript: started by their tool's result,
// ended by Claude Code's notice. The case behind it: a session in Rex listed "idle" on the phone
// while three subagents it started were still working; only opening it showed them.
const isoAgo = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const started = (id: string, agoMs: number, toolUseResult: object) =>
  line({ type: "user", timestamp: isoAgo(agoMs), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `started ${id}` }] }, toolUseResult });
const bgShell = (id: string, agoMs = 0) => started(id, agoMs, { stdout: "", stderr: "", interrupted: false, backgroundTaskId: id });
const bgAgent = (id: string, agoMs = 0) => started(id, agoMs, { status: "async_launched", agentId: id, description: "Look into it", prompt: "…", outputFile: `/somewhere/${id}.output` });
const bgMonitor = (id: string, agoMs = 0) => started(id, agoMs, { taskId: id, timeoutMs: 300_000, persistent: false });
const notice = (ids: string[], status?: string, summary = "done") =>
  `<task-notification>\n${ids.map((id) => `<task-id>${id}</task-id>`).join("\n")}\n<tool-use-id>toolu_x</tool-use-id>${status === undefined ? "" : `\n<status>${status}</status>`}\n<summary>${summary}</summary>\n</task-notification>`;
const delivered = (body: string) => line({ type: "user", origin: { kind: "task-notification" }, message: { role: "user", content: body } });
const queued = (body: string) => line({ type: "queue-operation", operation: "enqueue", content: body });

describe("transcriptTasks: a terminal session's background tasks, from its transcript", () => {
  beforeEach(() => forgetBackground());
  const cwd = "/Users/me/git/rexy";

  test("a shell, a monitor and a subagent start; each ends with a notice naming it with a final status, queued or delivered", () => {
    const id = "7e570001-0000-4000-8000-000000000001";
    const path = transcript(cwd, id, [prompt("look into it"), bgShell("bshell001", 5000), bgMonitor("bmon00001", 4000), bgAgent("a1b2c3d4e5f600001", 3000), said("Started.")]);
    assert.deepEqual(
      transcriptTasks(path).map((t) => [t.id, t.agent]),
      [
        ["bshell001", false],
        ["bmon00001", false],
        ["a1b2c3d4e5f600001", true],
      ],
    );
    const t = transcriptTasks(path)[0];
    assert.ok(Math.abs(t.startedAt - (Date.now() - 5000)) < 2000, "its start is its result's time");
    // A check-in about one still going, and an agent waiting on you: not over.
    appendFileSync(path, `${queued(notice(["bshell001"], undefined, 'Background command "x" is still running'))}\n${queued(notice(["a1b2c3d4e5f600001"], "blocked"))}\n`);
    assert.equal(transcriptTasks(path).length, 3);
    // The shell's end queued mid-turn; the agent's delivered as a message.
    appendFileSync(path, `${queued(notice(["bshell001"], "completed"))}\n${delivered(notice(["a1b2c3d4e5f600001"], "completed"))}\n`);
    assert.deepEqual(
      transcriptTasks(path).map((t) => t.id),
      ["bmon00001"],
    );
    appendFileSync(path, `${delivered(notice(["bmon00001"], "killed"))}\n`);
    assert.deepEqual(transcriptTasks(path), []);
  });

  test("read on from where it was, a line cut in half waits for its end; a file that shrank is read again; not there: none", () => {
    const id = "7e570001-0000-4000-8000-000000000002";
    const path = transcript(cwd, id, [prompt("go"), bgAgent("a0000000000000001")]);
    assert.equal(transcriptTasks(path).length, 1);
    const half = bgAgent("a0000000000000002");
    appendFileSync(path, half.slice(0, 40));
    assert.equal(transcriptTasks(path).length, 1, "half a line: nothing yet");
    appendFileSync(path, `${half.slice(40)}\n`);
    assert.equal(transcriptTasks(path).length, 2, "the rest of it: started");
    transcript(cwd, id, [prompt("go"), bgShell("b00000001")]);
    assert.deepEqual(
      transcriptTasks(path).map((t) => t.id),
      ["b00000001"],
    );
    assert.deepEqual(transcriptTasks(join(process.cwd(), "nowhere.jsonl")), []);
  });

  test("tasks a previous process left, in one notice; an agent that now reports elsewhere; others are left alone", () => {
    const id = "7e570001-0000-4000-8000-000000000003";
    const path = transcript(cwd, id, [bgShell("b00000011"), bgShell("b00000012"), bgAgent("a0000000000000013"), bgShell("b00000014")]);
    appendFileSync(path, `${delivered(notice(["b00000011", "b00000012", "__orphan_summary__:2"], "failed"))}\n`);
    appendFileSync(path, `${delivered(notice(["a0000000000000013"], undefined, 'Agent "x" was resumed by another agent and now reports to it; its completion will not be delivered here.'))}\n`);
    // Words that only look like one (a test file read out in a tool result) end only what they name.
    appendFileSync(path, `${line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: notice(["bbersg62l"], "completed") }] } })}\n`);
    assert.deepEqual(
      transcriptTasks(path).map((t) => t.id),
      ["b00000014"],
    );
  });

  test("not a background task: a call that finished in the foreground, a subagent that ran to the end, a cloud agent", () => {
    const id = "7e570001-0000-4000-8000-000000000004";
    const path = transcript(cwd, id, [
      started("fg", 0, { stdout: "ok", stderr: "", interrupted: false }),
      started("sync", 0, { status: "completed", agentId: "a0000000000000021", content: [] }),
      started("cloud", 0, { status: "remote_launched", taskId: "r1", sessionUrl: "https://example.invalid", description: "x", prompt: "x", outputFile: "x" }),
    ]);
    assert.deepEqual(transcriptTasks(path), []);
  });
});

describe("sessionBackground: what a terminal session still runs, while its process says it may", () => {
  beforeEach(() => forgetBackground());
  const cwd = "/Users/me/git/rexy";

  test("how many, how many are subagents, which have been quiet; its process idle: none, and what it started before then never again", () => {
    const id = "7e570002-0000-4000-8000-000000000001";
    const path = transcript(cwd, id, [bgAgent("a1000000000000001", HOUR), bgAgent("a1000000000000002", 60_000), bgShell("b10000003", 2 * HOUR)]);
    // The first agent's transcript written a minute ago; the shell's output not for an hour and a half.
    output(cwd, id, "a1000000000000001", 60_000);
    output(cwd, id, "b10000003", 90 * 60_000);
    const bg = sessionBackground(path, cwd, id, { busy: true })!;
    assert.equal(bg.count, 3);
    assert.equal(bg.agents, 2);
    assert.equal(bg.quiet, 1, "the shell");
    assert.ok(Math.abs(bg.quietSince! - (Date.now() - 90 * 60_000)) < 5000);
    // Its process has nothing running: none, whatever the transcript says (an end never written).
    assert.equal(sessionBackground(path, cwd, id, { busy: false }), undefined);
    assert.equal(sessionBackground(path, cwd, id, { busy: true }), undefined, "busy again (a new turn): the old ones stay over");
    // One it starts now counts.
    appendFileSync(path, `${bgAgent("a1000000000000004")}\n`);
    assert.deepEqual(sessionBackground(path, cwd, id, { busy: true }), { count: 1, agents: 1 });
  });

  test("one started just before its process was seen idle (a listing a little behind) still counts; one before its process started doesn't", () => {
    const id = "7e570002-0000-4000-8000-000000000002";
    const path = transcript(cwd, id, [bgShell("b20000001", 3 * HOUR), bgAgent("a2000000000000002", 5000)]);
    assert.equal(sessionBackground(path, cwd, id, { busy: false }), undefined);
    assert.deepEqual(sessionBackground(path, cwd, id, { busy: true }), { count: 1, agents: 1 });
    forgetBackground();
    assert.deepEqual(sessionBackground(path, cwd, id, { busy: true, since: Date.now() - HOUR }), { count: 1, agents: 1 }, "the shell was a previous process's");
  });

  test("describe: a terminal session at its prompt with three subagents working is idle, with them apart; listed idle, none", () => {
    forgetTurns();
    const id = "7e570002-0000-4000-8000-000000000003";
    const a = { pid: 88, sessionId: id, name: "rexy", cwd, kind: "interactive", status: "busy" };
    transcript(cwd, id, [
      prompt("look into the three bugs"),
      bgAgent("a3000000000000001", 60_000),
      bgAgent("a3000000000000002", 60_000),
      bgAgent("a3000000000000003", 60_000),
      said("Three agents are on it."),
      turnDuration(),
    ]);
    for (const task of ["a3000000000000001", "a3000000000000002", "a3000000000000003"]) output(cwd, id, task, 5000);
    noteHook("UserPromptSubmit", id, undefined, Date.now() - 2 * 60_000);
    noteHook("Stop", id, undefined, Date.now() - 50_000);
    const s = describeListed(a, null);
    assert.equal(s.status, "idle");
    assert.deepEqual(s.background, { count: 3, agents: 3 });
    assert.equal(describeListed({ ...a, status: "idle" }, null).background, undefined);
  });

  test("startedAt: its process's start from its record, in UTC; 0 when it doesn't say", () => {
    assert.equal(startedAt({ procStart: "Thu Nov  5 16:03:00 2026" }), Date.UTC(2026, 10, 5, 16, 3, 0));
    assert.equal(startedAt({}), 0);
    assert.equal(startedAt(null), 0);
    assert.equal(startedAt({ procStart: "soon" }), 0);
  });
});

describe("backgroundNote: said quietly, never as working", () => {
  const NOW = 50 * 3600_000;
  test("how many; how long the quiet ones have been, all of them or some; short for the narrow list", () => {
    assert.equal(backgroundNote({}), "");
    assert.equal(backgroundNote({ background: { count: 0 } }), "");
    assert.equal(backgroundNote({ background: { count: 2 } }, false, NOW), "2 in background");
    assert.equal(backgroundNote({ background: { count: 3, quiet: 3, quietSince: NOW - 8 * 3600_000 - 59_000 } }, false, NOW), "3 in background (quiet 8h)");
    assert.equal(backgroundNote({ background: { count: 3, quiet: 1, quietSince: NOW - 25 * 60_000 } }, false, NOW), "3 in background (1 quiet 25m)");
    assert.equal(backgroundNote({ background: { count: 1, quiet: 1, quietSince: NOW - 3 * 86_400_000 } }, false, NOW), "1 in background (quiet 3d)");
    assert.equal(backgroundNote({ background: { count: 2, quiet: 2, quietSince: NOW - 3600_000 } }, true, NOW), "2 bg (quiet 1h)");
  });
});

test("transcriptTurn: read again only when the file changed", () => {
  const path = transcript("/Users/me/git/cache", "c0ffee00-0000-4000-8000-000000000001", [prompt("go"), toolCall()], 10_000);
  assert.equal(transcriptTurn(path).ended, false);
  transcript("/Users/me/git/cache", "c0ffee00-0000-4000-8000-000000000001", [prompt("go"), toolCall(), toolResult(), said("Done.")], 0);
  const now = transcriptTurn(path);
  assert.equal(now.ended, true);
  assert.ok(Date.now() - now.at < 5000);
  assert.deepEqual(transcriptTurn("/nowhere/at/all.jsonl"), { at: 0, ended: null });
});
