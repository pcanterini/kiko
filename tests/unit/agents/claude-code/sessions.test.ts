// Claude Code's running sessions (src/agents/claude-code/sessions.ts): ones `claude agents` leaves out, and
// a terminal session whose turns moved into a background process (2.1.312, seen 2026-10-28), listed as one;
// and ending one from outside its terminal (endProcess), with its checks, on fake processes and records.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { claudeCode } from "../../../../src/agents/claude-code/index.ts";
import {
  agentScratch,
  claudeAgents,
  claudeProcess,
  claudeProgram,
  continuations,
  continued,
  endProcess,
  hiddenWhy,
  processes,
  resumedFrom,
  startedInClaude,
  statusOf,
  withUnlisted,
  type Reach,
} from "../../../../src/agents/claude-code/sessions.ts";
import { t3code } from "../../../../src/agents/t3code/index.ts";
import type { AgentSession, Endable } from "../../../../src/agents/types.ts";
import { appNamed, findSession, idsOf, listedId, nameSetBy, sessionName, type Session } from "../../../../src/core/sessions.ts";
import { sessionStatus } from "../../../../src/core/ui-store.ts";
import { Timeline } from "../../../../src/core/timeline.ts";

const listed = [
  { pid: 71107, sessionId: "lacy", name: "Lacy", cwd: "/git/lacy-platform", kind: "interactive", status: "idle" },
  { pid: 67301, sessionId: "job", name: "Kiko", cwd: "/git/kiko", kind: "bg", status: "busy" },
];

test("a running terminal session `claude agents` left out is added from its process record", () => {
  const all = withUnlisted(listed, [{ pid: 50691, sessionId: "kiko", name: "Kiko", cwd: "/git/kiko", kind: "interactive", status: "idle" }]);
  assert.deepEqual(
    all.map((a) => [a.sessionId, a.kind]),
    [
      ["lacy", "interactive"],
      ["job", "bg"],
      ["kiko", "interactive"],
    ],
  );
});

test("records already listed, background jobs and incomplete records aren't added", () => {
  const all = withUnlisted(listed, [
    { pid: 71107, sessionId: "lacy", name: "Lacy", cwd: "/git/lacy-platform", kind: "interactive" },
    { pid: 66803, sessionId: "other-job", name: "x", cwd: "/git/kiko", kind: "bg" },
    { pid: 1, sessionId: "no-folder", kind: "interactive" },
  ]);
  assert.equal(all.length, 2);
});

test("a record without a name goes by its folder", () => {
  const [added] = withUnlisted([], [{ pid: 5, sessionId: "s", cwd: "/git/clipkit", kind: "interactive" }]);
  assert.equal(added.name, "clipkit");
});

// A Mac with the "Kiko" terminal (pid 50691, 7c2e9a41…, "idle" since the move, parked
// job b5d81f3a) and the background process running its turns (pid 67301, b5d81f3a…, "busy"). `claude agents`
// lists only the background one; its kind is "background" there, "bg" in its record.
const FRONT_ID = "7c2e9a41-5d3b-4f86-b0e7-1a9c4d2e8f63";
const ENGINE_ID = "b5d81f3a-2e7c-4a19-8d64-0f3b7e9c2a58";
const ENGINE_CMD =
  `/Users/me/.local/share/claude/versions/2.1.312 --session-id ${ENGINE_ID} --fork-session ` +
  `--resume /Users/me/.claude/projects/-Users-me-git-claude-code-speech/${FRONT_ID}.jsonl --allowed-tools mcp__computer-use__zoom`;
const LACY = { pid: 71107, sessionId: "d1dd158b", name: "Lacy", cwd: "/git/lacy-platform", kind: "interactive", status: "waiting" };
const ENGINE = { pid: 67301, id: "b5d81f3a", sessionId: ENGINE_ID, name: "Kiko", cwd: "/git/kiko", kind: "background", status: "busy" };
const FRONT = { pid: 50691, sessionId: FRONT_ID, name: "Kiko", nameSource: "user", cwd: "/git/kiko", kind: "interactive", entrypoint: "cli", status: "idle", parkedJobId: "b5d81f3a" };
const ENGINE_RECORD = { pid: 67301, sessionId: ENGINE_ID, name: "Kiko", cwd: "/git/kiko", kind: "bg", entrypoint: "cli", status: "busy", jobId: "b5d81f3a" };
const LACY_RECORD = { ...LACY, entrypoint: "cli" };

/** `ps` as a table of command lines by pid, counting the calls. */
function ps(commands: Record<number, string>) {
  const calls: number[] = [];
  const command = async (pid: number) => {
    calls.push(pid);
    return commands[pid] ?? "";
  };
  return { command, calls };
}

describe("continuations: a background process running a terminal session's turns", () => {
  test("the incident: b5d81f3a continues 7c2e9a41; its parked job says so, so `ps` isn't asked", async () => {
    const { command, calls } = ps({ 67301: ENGINE_CMD, 71107: `claude --resume d1dd158b --dangerously-skip-permissions` });
    const links = await continuations([LACY, ENGINE], [LACY_RECORD, FRONT, ENGINE_RECORD], command);
    assert.deepEqual(
      [...links].map(([id, front]) => [id, front.sessionId]),
      [[ENGINE_ID, FRONT_ID]],
    );
    assert.deepEqual(calls, [], "linked by parkedJobId: no command line read");
  });

  test("without a parked job, by its command line: `ps` asked once, and only for it", async () => {
    const { command, calls } = ps({ 67301: ENGINE_CMD, 71107: `claude --resume d1dd158b --dangerously-skip-permissions` });
    const links = await continuations([LACY, ENGINE], [LACY_RECORD, { ...FRONT, parkedJobId: undefined }, ENGINE_RECORD], command);
    assert.deepEqual(
      [...links].map(([id, front]) => [id, front.sessionId]),
      [[ENGINE_ID, FRONT_ID]],
    );
    assert.deepEqual(calls, [67301], "the interactive session's command line isn't read");
  });

  // A session, "general" (pid 93333, 63fdf5a3, tmux pane %2) parked into job 948e8710 before
  // its first turn, so the job started fresh: no --resume. It showed twice: "general" under SESSIONS, never
  // updating, and "2026-10-14-general (background)" under EXTERNAL.
  test("parked before its first turn: the job's command line has no --resume, and its parked job still links it", async () => {
    const generalId = "63fdf5a3-0000-4000-8000-000000000001";
    const jobId = "948e8710-194a-42fe-813b-fbdbe32dad86";
    const general = {
      pid: 93333,
      sessionId: generalId,
      name: "general",
      nameSource: "user",
      cwd: "/scratch/2026-10-14-general",
      kind: "interactive",
      entrypoint: "cli",
      status: "idle",
      parkedJobId: "948e8710",
    };
    const job = { pid: 94001, id: "948e8710", sessionId: jobId, name: "2026-10-14-general", cwd: "/scratch/2026-10-14-general", kind: "background", status: "busy" };
    const jobRecord = { pid: 94001, sessionId: jobId, cwd: "/scratch/2026-10-14-general", kind: "bg", entrypoint: "cli", status: "busy", jobId: "948e8710" };
    const { command, calls } = ps({ 94001: `/Users/me/.local/share/claude/versions/2.1.312 --session-id ${jobId}` });
    const links = await continuations([job], [general, jobRecord], command);
    assert.equal(links.get(jobId)?.sessionId, generalId);
    assert.deepEqual(calls, []);
    // Listed once: the job's ID (its Stop hooks come from it), general's name and kind, and its pid (the pane's).
    const front = links.get(jobId)!;
    const one = continued(
      { sessionId: jobId, name: job.name, givenName: "", title: "", cwd: job.cwd, kind: "background", status: "busy", lastActiveAt: 2, desktop: false, titles: [] },
      {
        sessionId: generalId,
        name: "general",
        givenName: "general",
        title: "",
        cwd: front.cwd as string,
        kind: "interactive",
        status: "idle",
        lastActiveAt: 1,
        desktop: false,
        titles: ["general"],
        pid: front.pid,
      },
    );
    assert.deepEqual([one.sessionId, one.aliases, one.givenName, one.kind, one.status, one.pid], [jobId, [generalId], "general", "interactive", "busy", 93333]);
    assert.deepEqual(
      withUnlisted([job], [general, jobRecord], new Set([generalId])).map((a) => a.sessionId),
      [jobId],
      "general's own row is hidden",
    );
    // Un-parked: Claude Code clears parkedJobId, and with no --resume to go by, the link goes.
    assert.equal((await continuations([job], [{ ...general, parkedJobId: undefined }, jobRecord], command)).size, 0);
    // Parked into another job: not this one.
    assert.equal((await continuations([job], [{ ...general, parkedJobId: "11111111" }, jobRecord], command)).size, 0);
  });

  test("its front is hidden: not added back from its record, and not kept if `claude agents` lists it", async () => {
    const { command } = ps({ 67301: ENGINE_CMD });
    const records = [LACY_RECORD, FRONT, ENGINE_RECORD];
    const fronts = new Set([...(await continuations([LACY, ENGINE], records, command)).values()].map((f) => f.sessionId as string));
    assert.deepEqual(
      withUnlisted([LACY, ENGINE], records, fronts).map((a) => a.sessionId),
      ["d1dd158b", ENGINE_ID],
    );
    // Without the link, a586afd's behaviour: the front is added back.
    assert.deepEqual(
      withUnlisted([LACY, ENGINE], records).map((a) => a.sessionId),
      ["d1dd158b", ENGINE_ID, FRONT_ID],
    );
  });

  test("resumed by ID, not by transcript path, and without a parked job: still linked", async () => {
    const { command } = ps({ 67301: `claude --session-id ${ENGINE_ID} --fork-session --resume ${FRONT_ID}` });
    const links = await continuations([ENGINE], [{ ...FRONT, parkedJobId: undefined }, ENGINE_RECORD], command);
    assert.equal(links.get(ENGINE_ID)?.sessionId, FRONT_ID);
  });

  test("no link when it resumes another session, or one that isn't alive, or one in another folder", async () => {
    const other = ps({ 67301: ENGINE_CMD.replace(FRONT_ID, "99999999-0000-0000-0000-000000000000") });
    assert.equal((await continuations([ENGINE], [{ ...FRONT, parkedJobId: undefined }, ENGINE_RECORD], other.command)).size, 0);
    // Its parked job names this one: that's the link, whatever the command line resumes.
    assert.equal((await continuations([ENGINE], [FRONT, ENGINE_RECORD], other.command)).size, 1);
    // Not alive: liveRecords leaves out a record whose process is gone, so it isn't among the records.
    const { command } = ps({ 67301: ENGINE_CMD });
    assert.equal((await continuations([ENGINE], [ENGINE_RECORD], command)).size, 0);
    assert.equal((await continuations([ENGINE], [{ ...FRONT, cwd: "/git/elsewhere" }, ENGINE_RECORD], command)).size, 0);
    // A headless run isn't anyone's terminal.
    assert.equal((await continuations([ENGINE], [{ ...FRONT, entrypoint: "sdk-cli" }, ENGINE_RECORD], command)).size, 0);
  });

  test("no `ps` without a live terminal session in its folder, and none for interactive sessions", async () => {
    const { command, calls } = ps({ 67301: ENGINE_CMD });
    assert.equal((await continuations([LACY, ENGINE], [LACY_RECORD, ENGINE_RECORD], command)).size, 0);
    assert.deepEqual(calls, []);
  });

  test("a forked job of a running session isn't it: the front's parked job picks which one is", async () => {
    const forkId = "77777777-1111-2222-3333-444444444444";
    const fork = { pid: 70001, id: "77777777", sessionId: forkId, name: "Kiko", cwd: "/git/kiko", kind: "background", status: "busy" };
    const { command } = ps({ 67301: ENGINE_CMD, 70001: ENGINE_CMD.replaceAll(ENGINE_ID, forkId) });
    const links = await continuations([ENGINE, fork], [FRONT, ENGINE_RECORD], command);
    assert.deepEqual([...links.keys()], [ENGINE_ID]);
    // A forked job alone, while the front's parked job is another: not linked.
    assert.equal((await continuations([fork], [FRONT], command)).size, 0);
    // Two claiming it with no parked job to tell them apart: neither.
    assert.equal((await continuations([ENGINE, fork], [{ ...FRONT, parkedJobId: undefined }], command)).size, 0);
  });
});

describe("statusOf: `claude agents --json`'s status and state in the agent's words", () => {
  test("a process's own: busy, idle; a dialog open in its window (waiting) is blocked: it needs you", () => {
    assert.equal(statusOf({ status: "busy" }), "busy");
    assert.equal(statusOf({ status: "idle" }), "idle");
    assert.equal(statusOf({ status: "waiting" }), "blocked");
    assert.equal(statusOf(LACY), "blocked");
  });
  test("a background job stopped on a question of its own (state blocked, its process idle or gone): waiting, not blocked", () => {
    // A background session asking "What would you like to work on?" was red "needs you".
    assert.equal(statusOf({ state: "blocked" }), "waiting");
    assert.equal(statusOf({ status: "idle", state: "blocked" }), "waiting");
    // A dialog in its process is still a dialog, a turn running still running.
    assert.equal(statusOf({ status: "waiting", state: "blocked" }), "blocked");
    assert.equal(statusOf({ status: "busy", state: "blocked" }), "busy");
  });
  test("a job with no process left goes by its state", () => {
    assert.equal(statusOf({ state: "working" }), "busy");
    assert.equal(statusOf({ state: "done" }), "done");
    assert.equal(statusOf({}), "unknown");
  });
  test("to the window, the bar and the phone: blocked needs you (red), waiting waits for you (yellow)", () => {
    const s = (status: string) => ({ sessionId: "x", status }) as Session;
    const none = { permission: null, waiting: null };
    assert.equal(sessionStatus(s(statusOf({ status: "idle", state: "blocked" })), none), "waiting");
    assert.equal(sessionStatus(s(statusOf({ status: "waiting" })), none), "needs_you");
    assert.equal(sessionStatus(s(statusOf({ state: "working" })), none), "working");
    assert.equal(sessionStatus(s("idle"), { permission: { id: "p", sessionId: "x", name: "x", what: "run ls", risky: false }, waiting: null }), "needs_you");
    // A prompt Kiko holds in line (not asked yet): it needs you all the same.
    const queued = { permission: null, waiting: null, queuedPermissions: [{ id: "q", sessionId: "x", name: "x", what: "run ls", risky: false }] };
    assert.equal(sessionStatus(s("busy"), queued), "needs_you");
    assert.equal(sessionStatus({ sessionId: "y", status: "busy" } as Session, queued), "working", "only the session it blocks");
  });
});

test("resumedFrom: the session a command line resumes", () => {
  assert.equal(resumedFrom(ENGINE_CMD), FRONT_ID);
  assert.equal(resumedFrom(`claude --resume ${FRONT_ID} --dangerously-skip-permissions`), FRONT_ID);
  assert.equal(resumedFrom(`claude --resume=${FRONT_ID}`), FRONT_ID);
  assert.equal(resumedFrom("claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/c.claim.sock"), "");
  assert.equal(resumedFrom(""), "");
});

describe("continued: the merged session", () => {
  const session = (over: Partial<AgentSession>): AgentSession => ({
    sessionId: "x",
    name: "",
    givenName: "",
    title: "",
    cwd: "/git/kiko",
    kind: "interactive",
    status: "idle",
    lastActiveAt: 0,
    desktop: false,
    titles: [],
    ...over,
  });
  const engine = session({ sessionId: ENGINE_ID, name: "Kiko", kind: "background", status: "busy", lastActiveAt: 200, title: "Fork title", titles: ["Fork title"] });
  const front = session({ sessionId: FRONT_ID, name: "Kiko", givenName: "Kiko", title: "Voice hub", status: "idle", lastActiveAt: 100, titles: ["Kiko", "Voice hub"] });
  const merged = continued(engine, front);

  test("the background process's ID, status and activity; the terminal's names and kind; its ID an alias", () => {
    assert.deepEqual(
      [merged.sessionId, merged.aliases, merged.kind, merged.status, merged.lastActiveAt, merged.givenName, merged.title, merged.cwd],
      [ENGINE_ID, [FRONT_ID], "interactive", "busy", 200, "Kiko", "Voice hub", "/git/kiko"],
    );
  });

  test("its window is found by the terminal's titles, and the process's", () => {
    assert.deepEqual(merged.titles, ["Kiko", "Voice hub", "Fork title"]);
  });

  test("either ID finds it; the timeline's entries under either are its", () => {
    const lacy = session({ sessionId: "d1dd158b", name: "Lacy" });
    const sessions = [lacy, merged];
    assert.equal(findSession(sessions, ENGINE_ID), merged);
    assert.equal(findSession(sessions, FRONT_ID), merged);
    assert.equal(findSession(sessions, "d1dd158b"), lacy);
    assert.equal(findSession(sessions, "gone"), undefined);
    assert.equal(findSession(sessions, null), undefined);
    assert.equal(listedId(sessions, FRONT_ID), ENGINE_ID);
    assert.equal(listedId(sessions, "gone"), "gone");
    const timeline = new Timeline();
    timeline.add({ who: "you", sessionId: FRONT_ID, folder: "Kiko", text: "before the move" });
    timeline.add({ who: "claude", sessionId: ENGINE_ID, folder: "Kiko", text: "after it" });
    timeline.add({ who: "you", sessionId: "d1dd158b", folder: "Lacy", text: "not this one" });
    assert.equal(timeline.last("you", idsOf(merged))?.text, "before the move");
    assert.deepEqual(
      timeline.recent(10, idsOf(merged)).map((e) => e.text),
      ["before the move", "after it"],
    );
    assert.equal(timeline.last("you", ENGINE_ID), undefined, "one ID alone is still only that one");
  });

  test("renamed since it moved: the process's given name, the newer (a /rename typed into its window goes to the process)", () => {
    // "/rename Yo Lacy" typed into the Ghostty tab; the job's record took
    // "Yo Lacy", the terminal's kept "Lacy", and the list kept showing "Lacy".
    const job = session({ ...engine, givenName: "Yo Lacy", titles: ["Yo Lacy", "Fork title"] });
    const tab = session({ ...front, givenName: "Lacy", titles: ["Lacy", "Voice hub"] });
    const renamed = continued(job, tab);
    assert.equal(renamed.givenName, "Yo Lacy");
    assert.equal(sessionName(renamed), "Yo Lacy");
    assert.equal(nameSetBy(idsOf(renamed), renamed.givenName, { [ENGINE_ID]: { name: "Yo Lacy", at: 1 } }), "app", "the app's rename, noted under the listed ID");
    assert.deepEqual(renamed.titles, ["Lacy", "Voice hub", "Yo Lacy", "Fork title"], "its window is still found by either name");
    assert.equal(sessionName(continued(session({ ...engine, givenName: "Kiko" }), tab)), appNamed(), "renamed like the app: still told apart");
    assert.equal(continued(session({ ...engine, givenName: "" }), tab).givenName, "Lacy", "no name of its own: the terminal's");
  });

  test("the job it continues is kept, for Close: `claude stop` it, and the terminal's process too", () => {
    assert.equal(continued({ ...engine, jobId: "b5d81f3a" }, front).jobId, "b5d81f3a");
    assert.equal(merged.jobId, undefined);
    assert.equal(merged.pid, undefined);
    assert.equal(continued(engine, { ...front, pid: 50691 }).pid, 50691, "the terminal's process: the one signalled");
  });
});

describe("endProcess: a session outside Kiko's tmux ended from outside its terminal, checked first", () => {
  const STARTED = "Fri Oct 30 02:22:47 2026";
  const dir = mkdtempSync(join(tmpdir(), "kiko-sessions-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const record = (pid: number, over: Record<string, unknown> = {}) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: "notes", cwd: "/git/notes", kind: "interactive", entrypoint: "cli", procStart: STARTED, ...over }));
  /** Fake `ps`, `claude stop` and signals: what each process is, and what was sent. */
  function reach(over: { lstart?: string; comm?: string; kill?: (pid: number, signal: string) => void; stop?: Reach["stop"] } = {}) {
    const sent: string[] = [];
    const via: Reach = {
      dir,
      // `ps` pads a day under 10 with a second space; the record has one.
      ps: async (_pid, field) => (field === "lstart" ? (over.lstart ?? "Fri Oct 30 02:22:47  2026 ") : (over.comm ?? "claude")),
      stop: async (job) => (sent.push(`stop ${job}`), over.stop ? over.stop(job) : { ok: true }),
      kill: (pid, signal) => (sent.push(`${signal} ${pid}`), over.kill?.(pid, signal)),
    };
    return { via, sent };
  }
  const notes: Endable = { sessionId: "notes", kind: "interactive", desktop: false, pid: 7001 };

  test("a terminal session, its checks all right: SIGTERM to its process, which is then watched", async () => {
    record(7001);
    const { via, sent } = reach();
    assert.deepEqual(await endProcess(notes, via), { sent: true, pids: [7001] });
    assert.deepEqual(sent, ["SIGTERM 7001"]);
  });

  test("its record names another session (the pid is another Claude now), or is gone: nothing sent", async () => {
    record(7002, { sessionId: "someone-else" });
    const a = reach();
    assert.deepEqual(await endProcess({ ...notes, pid: 7002 }, a.via), { sent: false, why: "its process runs another session now" });
    const b = reach();
    assert.deepEqual(await endProcess({ ...notes, pid: 7999 }, b.via), { sent: false, why: "its process record is gone" });
    assert.deepEqual([...a.sent, ...b.sent], []);
  });

  test("its record's procStart isn't its process's start (the pid taken again by another process): nothing sent", async () => {
    record(7003);
    const { via, sent } = reach({ lstart: "Sat Oct 31 09:00:00 2026" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7003 }, via), { sent: false, why: "its process ID belongs to another process now" });
    record(7004, { procStart: undefined });
    assert.equal((await endProcess({ ...notes, pid: 7004 }, via)).sent, false, "no procStart: no telling");
    const gone = reach({ lstart: "" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7003 }, gone.via), { sent: false, why: "its process has ended" });
    assert.deepEqual([...sent, ...gone.sent], []);
  });

  test("the desktop app's or a headless run's (by its record, or as listed): nothing sent", async () => {
    record(7005, { entrypoint: "claude-desktop" });
    record(7006, { entrypoint: "sdk-ts" });
    record(7007, { entrypoint: "local-agent" });
    const { via, sent } = reach();
    assert.deepEqual(await endProcess({ ...notes, pid: 7005 }, via), { sent: false, why: "it runs in the Claude desktop app" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7006 }, via), { sent: false, why: "it's a headless run" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7007 }, via), { sent: false, why: "it runs in the Claude desktop app" });
    assert.deepEqual(await endProcess({ ...notes, desktop: true }, via), { sent: false, why: "it runs in the Claude desktop app" });
    assert.deepEqual(sent, []);
  });

  test("the process isn't Claude Code (`ps -o comm=`): nothing sent; `claude` anywhere, or a background job's versioned binary, is", async () => {
    record(7008);
    const { via, sent } = reach({ comm: "/bin/zsh" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7008 }, via), { sent: false, why: "its process isn't Claude Code (zsh)" });
    assert.deepEqual(sent, []);
    assert.equal(claudeProgram("claude"), true);
    assert.equal(claudeProgram("/Users/p/.local/bin/claude"), true);
    assert.equal(claudeProgram("/Users/p/.local/share/claude/versions/2.1.314"), true);
    assert.equal(claudeProgram("/Users/p/.local/share/claude/versions/2.1.314/node"), false);
    assert.equal(claudeProgram("node"), false);
    assert.equal(claudeProgram("claude-helper"), false);
  });

  test("not allowed to signal it (EPERM): refused; gone the moment after its checks (ESRCH): ended all the same", async () => {
    record(7009);
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    assert.deepEqual(await endProcess({ ...notes, pid: 7009 }, reach({ kill: err("EPERM") }).via), { sent: false, why: "I'm not allowed to signal its process" });
    assert.deepEqual(await endProcess({ ...notes, pid: 7009 }, reach({ kill: err("ESRCH") }).via), { sent: true, pids: [7009] });
  });

  test("no process known: refused", async () => {
    const { via, sent } = reach();
    assert.deepEqual(await endProcess({ ...notes, pid: undefined }, via), { sent: false, why: "its process isn't known" });
    assert.deepEqual(sent, []);
  });

  test("a background job: `claude stop <job>`, never a signal; its process checked first and watched; its job not known, or not stopped: refused", async () => {
    record(7010, { sessionId: "job-session", kind: "bg", jobId: "b5d81f3a" });
    const job: Endable = { sessionId: "job-session", kind: "background", desktop: false, pid: 7010, jobId: "b5d81f3a" };
    const ok = reach({ comm: "/Users/p/.local/share/claude/versions/2.1.314" });
    assert.deepEqual(await endProcess(job, ok.via), { sent: true, pids: [7010] });
    assert.deepEqual(ok.sent, ["stop b5d81f3a"]);
    // A job with no process left: stopped, nothing to watch.
    const bare = reach();
    assert.deepEqual(await endProcess({ ...job, pid: undefined }, bare.via), { sent: true, pids: [] });
    assert.deepEqual(bare.sent, ["stop b5d81f3a"]);
    const none = reach();
    assert.deepEqual(await endProcess({ ...job, jobId: undefined }, none.via), { sent: false, why: "its background job isn't known" });
    const refused = reach({ stop: async () => ({ ok: false, why: "No job matching b5d81f3a" }) });
    assert.deepEqual(await endProcess(job, refused.via), { sent: false, why: "claude stop didn't take it: No job matching b5d81f3a" });
    const wrong = reach({ comm: "/bin/zsh" });
    assert.equal((await endProcess(job, wrong.via)).sent, false);
    assert.deepEqual([...none.sent, ...wrong.sent], []);
  });

  test("a terminal session parked into a job (continued: the job's ID, the terminal's alias and process): the job stopped, the terminal's process signalled", async () => {
    record(7011, { sessionId: "front", parkedJobId: "b5d81f3a" });
    const merged: Endable = { sessionId: "engine", aliases: ["front"], kind: "interactive", desktop: false, pid: 7011, jobId: "b5d81f3a" };
    const { via, sent } = reach();
    assert.deepEqual(await endProcess(merged, via), { sent: true, pids: [7011] });
    assert.deepEqual(sent, ["stop b5d81f3a", "SIGTERM 7011"]);
    // `claude stop` refuses: the terminal isn't signalled either.
    const refused = reach({ stop: async () => ({ ok: false, why: "it failed" }) });
    assert.equal((await endProcess(merged, refused.via)).sent, false);
    assert.deepEqual(refused.sent, ["stop b5d81f3a"]);
  });

  test("parked into a job the listing didn't show (only its record names it): stopped if it's there, and the terminal signalled either way", async () => {
    record(7012, { parkedJobId: "9f00aa11" });
    const { via, sent } = reach({ stop: async () => ({ ok: false, why: "No job matching 9f00aa11" }) });
    assert.deepEqual(await endProcess({ ...notes, pid: 7012 }, via), { sent: true, pids: [7012] });
    assert.deepEqual(sent, ["stop 9f00aa11", "SIGTERM 7012"]);
  });

  test("Claude Code's adapter ends its sessions this way (Agent.end); T3 Code's archives its threads instead (its own Close words)", () => {
    assert.equal(typeof claudeCode.end, "function");
    assert.equal(typeof t3code.end, "function", "T3 Code threads: archived");
    assert.equal(claudeCode.ending, undefined, "Claude Code's Close reads as before");
  });
});

// Only the sessions you started, never ones an agent started. An agent ran
// three throwaway interactive `claude`s ("probe-0f"…) in a private tmux server, in its job's scratch
// folder, and they were listed as outside sessions.
describe("hiddenWhy: sessions another Claude started are left out", () => {
  const HOME = "/Users/me";
  const PROBE = { cwd: "/Users/me/.claude/jobs/e9a4c7d2/tmp/probe", kind: "interactive", pid: 81001, entrypoint: "cli" };
  const never = () => false;

  test("the incident: a session in a job's scratch folder, whatever its kind or ancestry", () => {
    assert.equal(hiddenWhy(PROBE, never, HOME), "agent-scratch");
    assert.equal(hiddenWhy({ ...PROBE, kind: "bg" }, never, HOME), "agent-scratch");
    assert.equal(hiddenWhy({ ...PROBE, cwd: "/Users/me/.claude/jobs/e9a4c7d2/tmp" }, never, HOME), "agent-scratch");
  });

  test("the scratch folder is only ~/.claude/jobs/<id>/tmp and below", () => {
    assert.ok(agentScratch("/Users/me/.claude/jobs/e9a4c7d2/tmp/probe/deeper", HOME));
    assert.ok(agentScratch("/Users/me/.claude/jobs/e9a4c7d2/tmp", "/Users/me/"));
    for (const cwd of [
      "/Users/me/git/kiko",
      "/Users/me/.claude/jobs/e9a4c7d2",
      "/Users/me/.claude/jobs/e9a4c7d2/tmpfiles",
      "/Users/me/.claude/jobs/e9a4c7d2/work/tmp",
      "/Users/other/.claude/jobs/e9a4c7d2/tmp",
      "/Users/me/git/app/.claude/jobs/x/tmp",
    ])
      assert.equal(agentScratch(cwd, HOME), false, cwd);
  });

  test("an interactive session started inside a Claude is left out; yours, background jobs and desktop ones aren't asked", () => {
    const asked: number[] = [];
    const inside = (pid: number) => (asked.push(pid), true);
    const yours = { cwd: "/Users/me/git/lacy-platform", kind: "interactive", pid: 25659, entrypoint: "cli" };
    assert.equal(hiddenWhy(yours, inside, HOME), "started-by-claude");
    assert.equal(hiddenWhy(yours, never, HOME), null);
    // The user's own background job ("Kiko", the one this was built in) is its supervisor's child.
    assert.equal(hiddenWhy({ ...yours, kind: "background" }, inside, HOME), null);
    assert.equal(hiddenWhy({ ...yours, entrypoint: "claude-desktop" }, inside, HOME), null);
    assert.equal(hiddenWhy({ cwd: yours.cwd, kind: "interactive" }, inside, HOME), null, "no process: nothing to ask");
    assert.deepEqual(asked, [25659]);
  });
});

// A Mac's processes (executables only, as `ps -o comm=` gives them): two terminal
// sessions in Ghostty, a background job "Kiko" (its supervisor started from the kiko
// terminal session) and its spare; and what an agent's Bash tool would start, and a session in a
// tmux server (launchd its parent).
const PS = `
    1     0 /sbin/launchd
22832     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
22833 22832 /usr/bin/login
22839 22833 -/bin/zsh
25659 22839 claude
22834 22832 /usr/bin/login
22838 22834 -/bin/zsh
70208 22838 claude
70919 70208 /Users/me/.local/bin/claude
70935 70919 /Users/me/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude
70954 70935 /Users/me/.local/share/claude/versions/2.1.314
70925 70919 claude bg-pty-host
70928 70925 claude bg-spare
75032 70954 /bin/zsh
75040 75032 /Users/me/.local/bin/claude
76001 70208 /bin/zsh
76002 76001 /usr/bin/env
76003 76002 claude
80000     1 tmux
81001 80000 /Users/me/.local/share/claude/versions/2.1.314
`;

describe("startedInClaude: from a program a Claude Code process runs", () => {
  const procs = processes(PS);

  test("ps read: parent and executable by pid, titles with spaces kept", () => {
    assert.deepEqual(procs.get(70928), { ppid: 70925, comm: "claude bg-spare" });
    assert.deepEqual(procs.get(22839), { ppid: 22833, comm: "-/bin/zsh" });
    assert.equal(procs.size, 20);
  });

  test("Claude Code's executables: the launcher, the app bundle's, a version's, titled ones; not others", () => {
    for (const comm of ["claude", "/Users/me/.local/bin/claude", "claude bg-spare", "/Users/me/.local/share/claude/versions/2.1.314"]) assert.ok(claudeProcess(comm), comm);
    for (const comm of ["/Applications/Claude.app/Contents/MacOS/Claude", "claude-code-helper", "/bin/zsh", "node", "/opt/2.1.314"]) assert.equal(claudeProcess(comm), false, comm);
  });

  test("sessions in a terminal app or a tmux server weren't", () => {
    for (const pid of [25659, 70208, 81001]) assert.equal(startedInClaude(pid, procs), false, String(pid));
  });

  test("a background job under its supervisor wasn't: the Claude Code processes right above it are its own", () => {
    assert.equal(startedInClaude(70954, procs), false);
    assert.equal(startedInClaude(70928, procs), false);
  });

  test("`claude` run by an agent's Bash tool was, through a shell or several programs", () => {
    assert.equal(startedInClaude(75040, procs), true, "under the background job's shell");
    assert.equal(startedInClaude(76003, procs), true, "under a terminal session's shell, through env");
  });

  test("an unknown pid, or a gap in the table: not, rather than a guess", () => {
    assert.equal(startedInClaude(99999, procs), false);
    assert.equal(startedInClaude(76003, processes("76003 76002 claude\n76002 76001 /usr/bin/env\n")), false);
  });
});

describe("claude agents --json (claudeAgents)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  /** `claude` on the PATH, for `run`, as a script. */
  async function withClaude<T>(script: string, run: () => Promise<T>): Promise<T> {
    writeFileSync(join(dir, "claude"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, "claude"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    try {
      return await run();
    } finally {
      process.env.PATH = path;
    }
  }

  test("read as it answers", async () => {
    const listed = await withClaude(`echo '[{"sessionId":"s1","name":"pixie","cwd":"/r","kind":"interactive"}]'`, () => claudeAgents());
    assert.deepEqual(listed, [{ sessionId: "s1", name: "pixie", cwd: "/r", kind: "interactive" }]);
  });

  test("one that never answers (waiting on its input) is stopped and throws, rather than holding up the list for good", async () => {
    const started = Date.now();
    await withClaude("exec cat", () => assert.rejects(claudeAgents(300)));
    assert.ok(Date.now() - started < 5000, `${Date.now() - started}ms`);
  });
});
