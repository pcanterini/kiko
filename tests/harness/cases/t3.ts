import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { begin, caseLines, caseLog, caseSaid, fakeT3, info, logEntries, OFF_LINE, Phone, phoneServer, PROJECTS_ROOT, SCRATCH, spoke, T, talk, TERM, ui, until, wait } from "../driver.ts";

// T3 Code's threads (src/agents/t3code/), from the fake T3: listed, a completed run read out, your
// words sent to the thread as a new message, its permissions and questions asked and answered (by
// voice, the Mac's card and the phone) back to T3, stopped and renamed through T3 (by voice and the
// menus), and T3 updating past this Kiko's protocol.
export async function t3Cases() {
  const ID = "t3:t3-login";
  const listed = (): any => ui.state.sessions.find((s: any) => s.sessionId === ID);
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  await until(() => logEntries().some((l) => l.event === "t3_connect" && l.ok === true), 5000, "the app connected to the fake T3");

  begin("T3: a thread is listed");
  fakeT3.thread("t3-login", { projectId: "t3p", title: "Pixie login" });
  await until(
    listed,
    5000,
    () =>
      `the T3 thread in the list (fake: ${fakeT3.sockets} sockets, ${fakeT3.frames.filter((f) => f._tag === "Ack").length} acks; listed: ${ui.state.sessions.map((s: any) => s.sessionId).join(", ")})`,
  );
  assert.equal(listed().cwd, "/nonexistent/t3-pixie");
  assert.equal(listed().agent, "t3code");
  assert.equal(listed().place?.via, "t3code");
  console.log("ok:", listed().sessionId, "in", listed().cwd);

  begin("T3: a completed run is announced");
  T.needs = [0.8];
  fakeT3.startRun("t3-login", "fix the login");
  await until(() => listed()?.status === "busy", 3000, "the run seen");
  await fakeT3.completeRun("t3-login", "Fixed the login: the cookie had expired.");
  await until(() => caseSaid().some((x: any) => x.text === "summary for Pixie login"), 5000, "the announcement");
  assert.equal(T.summaries.at(-1).claudeReply, "Fixed the login: the cookie had expired.");
  // Claude or Codex underneath, which T3 doesn't say here: "it says", never "Claude says".
  assert.deepEqual(T.summaries.at(-1).voice, { agent: "T3 Code", speaker: "" });
  // Nothing holds it: no reply window once it's read out.
  await until(() => events("announce").some((l) => l.sessionId === ID), 3000, "the announce logged");
  await until(() => ui.state.waiting?.sessionId !== ID, 3000, "no reply window: it can't be held");
  await wait(300);
  assert.equal(events("announce").filter((l) => l.sessionId === ID).length, 1, "announced once");
  assert.notEqual(ui.state.waiting?.sessionId, ID);
  console.log("ok: read out, no window to hold");

  begin("T3: spoken words reach the thread via dispatch");
  await wait(300);
  T.utterance = () => ({ audience: listed(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const before = fakeT3.dispatched.length;
  await talk("now add a test for it");
  await until(() => fakeT3.dispatched.length > before, 3000, "the dispatch");
  const sent = fakeT3.dispatched.at(-1);
  assert.deepEqual([sent.type, sent.threadId, sent.text, sent.dispatchMode.type], ["message.dispatch", "t3-login", "now add a test for it", "start_immediately"]);
  await until(() => info("→ Pixie login (T3 Code)"), 2000, "the sent line");
  console.log("ok: message.dispatch to the thread");

  begin("T3: words from the phone to a thread: heard, routed, delivered, started as its run takes them in, replied as it completes; its conversation live");
  await wait(1700); // the last send's moment passes
  ui.act({ type: "set", key: "phone" as any, value: true });
  await until(() => events("phone_on").length > 0, 3000, "the phone server on");
  phoneServer.port = events("phone_on").at(-1).port;
  ui.act({ type: "settings" });
  await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
  const code = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
  ui.act({ type: "closeSettings" });
  const p = new Phone();
  await p.send({ type: "pair", code, device: "T3 iPhone", appVersion: "0.1.0" });
  await p.next("welcome");
  await p.next("sessions", (m) => m.sessions.some((x: any) => x.id === ID));
  let from = p.got.length;
  await p.send({ type: "watch", sessionId: ID });
  const opened = await p.next("history", (m) => m.sessionId === ID, from);
  // The thread's own messages, the one sent in the last case too (no run has taken it yet).
  assert.deepEqual(
    opened.items.slice(-3).map((i: any) => [i.kind, i.text]),
    [
      ["you", "fix the login"],
      ["claude", "Fixed the login: the cookie had expired."],
      ["you", "now add a test for it"],
    ],
  );
  assert.equal(opened.truncated, false);
  from = p.got.length;
  T.needs = [0.8];
  const dispatchedBefore = fakeT3.dispatched.length;
  await p.send({ type: "type", text: "What about Germany?", sessionId: ID, talkId: "t3-a" });
  const delivered = await p.next("talk_status", (m) => m.talkId === "t3-a" && m.stage === "delivered", from, 3000);
  assert.equal(fakeT3.dispatched.at(dispatchedBefore)?.text, "What about Germany?");
  assert.equal(delivered.queued, undefined, "idle: not queued");
  await wait(100);
  assert.equal(p.of("talk_status").filter((m) => m.talkId === "t3-a" && m.stage === "started").length, 0, "not started before its run takes it in");
  fakeT3.startRun("t3-login");
  await p.next("talk_status", (m) => m.talkId === "t3-a" && m.stage === "started", from, 3000);
  assert.ok(
    events("prompt_submitted").some((l) => l.sessionId === ID && l.agent === "t3code"),
    "told as UserPromptSubmit is",
  );
  await p.next("history", (m) => m.sessionId === ID && m.items.at(-1)?.text === "What about Germany?", from, 3000);
  await fakeT3.completeRun("t3-login", "The capital of Germany is Berlin.");
  await p.next("talk_status", (m) => m.talkId === "t3-a" && m.stage === "replied", from, 5000);
  const statuses = p.got.slice(from).filter((m) => m.type === "talk_status" && m.talkId === "t3-a");
  assert.deepEqual(
    statuses.map((m) => m.stage),
    ["heard", "routed", "delivered", "started", "replied"],
  );
  assert.deepEqual(
    statuses.slice(1).map((m) => m.sessionId),
    [ID, ID, ID, ID],
    "all on the T3 id",
  );
  await p.next("history", (m) => m.sessionId === ID && m.items.at(-1)?.text === "The capital of Germany is Berlin.", from, 3000);
  await until(() => events("announce").some((l) => l.sessionId === ID), 5000, "the reply read out");
  await p.send({ type: "watch", sessionId: null });
  p.close();
  ui.act({ type: "set", key: "phone" as any, value: false });
  await until(() => events("phone_off").length > 0, 3000, "the phone server off");
  console.log("ok: heard → routed → delivered → started → replied on", ID, "and the conversation followed it");

  begin("T3: a permission is asked like Claude Code's (said, its card on the Mac) and allowed by voice; the answer reaches T3 and its run goes on");
  await wait(300);
  const responded = (id: string) => fakeT3.dispatched.find((c) => c.type === "runtime-request.respond" && c.requestId === id);
  const asks = () => caseSaid().filter((x: any) => x.text.startsWith("Pixie login wants to")).length;
  fakeT3.startRun("t3-login", "run the tests");
  await until(() => listed()?.status === "busy", 3000, "the run seen");
  let req = fakeT3.askPermission("t3-login", { command: "npm test" });
  await until(() => caseSaid().some((x: any) => x.text === "Pixie login wants to Bash. Allow?"), 5000, "asked out loud");
  assert.equal(ui.state.permission?.sessionId, ID);
  assert.ok(
    caseLines().some((l) => l.kind === "permission" && l.text === "use Bash"),
    "its card on the Mac",
  );
  // Said, and its window open (a press while it's said is a barge-in, not its answer).
  const asking = () => until(() => ui.state.waiting?.sessionId === ID && ui.state.waiting?.until != null, 3000, "its window open");
  await asking();
  T.approval = () => ({ answer: "allow", confidence: 0.95 });
  await talk("yes");
  T.approval = undefined;
  await until(() => responded(req), 3000, "the answer sent to T3");
  assert.equal(responded(req).decision, "accept");
  assert.equal(responded(req).threadId, "t3-login");
  await until(() => listed()?.status === "busy", 3000, "its run goes on");
  assert.ok(events("t3_respond").some((l) => l.requestId === req && l.decision === "accept"));
  console.log("ok: asked, allowed by voice, accept sent to T3");

  begin("T3: from the Mac's card: allowed for the session (acceptForSession), then denied (decline, with why)");
  await wait(300);
  let n = asks();
  req = fakeT3.askPermission("t3-login", { file: "src/login.ts" });
  await until(() => asks() > n && ui.state.permission?.sessionId === ID, 5000, "the file change asked");
  assert.ok(caseSaid().some((x: any) => x.text === "Pixie login wants to Edit. Allow?"));
  ui.act({ type: "allow", always: true, id: ui.state.permission!.id });
  await until(() => responded(req), 3000, "allowed for the session");
  assert.equal(responded(req).decision, "acceptForSession");
  await wait(300);
  n = asks();
  req = fakeT3.askPermission("t3-login", { command: "rm -rf build" });
  await until(() => asks() > n && ui.state.permission?.sessionId === ID, 5000, "the command asked");
  ui.act({ type: "deny", id: ui.state.permission!.id });
  await until(() => responded(req), 3000, "denied");
  assert.deepEqual([responded(req).decision, responded(req).feedback], ["decline", 'The user said no by voice: "No."']);
  console.log("ok: acceptForSession and decline from the card");

  begin("T3: answered in T3 itself while Kiko asks: it stops asking, nothing sent from here");
  await wait(300);
  n = asks();
  req = fakeT3.askPermission("t3-login", { command: "npm run build" });
  await until(() => asks() > n, 5000, "asked");
  fakeT3.resolveInT3(req);
  await until(() => ui.state.permission?.sessionId !== ID, 3000, "the card gone");
  await wait(200);
  assert.equal(responded(req), undefined);
  console.log("ok: closed here once T3 said it was answered");

  begin("T3: Claude's questions in T3, asked by voice as AskUserQuestion's are; the answer goes back by its question's ID");
  await wait(300);
  req = fakeT3.askQuestions("t3-login", [
    {
      id: "Which database?",
      header: "Database",
      question: "Which database?",
      options: [
        { label: "Postgres", description: "relational", value: "pg" },
        { label: "SQLite", description: "a file" },
      ],
    },
  ]);
  await until(() => caseSaid().some((x: any) => /Which database\?/.test(x.text)), 5000, "asked out loud");
  await asking();
  await talk("the first one");
  await until(() => responded(req), 3000, "the answer sent to T3");
  assert.deepEqual(responded(req).answers, { "Which database?": "pg" });
  console.log("ok: answered by voice, by its ID, with the option's value");

  begin("T3: on the phone: its permission card, denied there; its questions answered there");
  await wait(1700);
  ui.act({ type: "set", key: "phone" as any, value: true });
  await until(() => events("phone_on").length > 0, 3000, "the phone server on");
  phoneServer.port = events("phone_on").at(-1).port;
  // The phone paired in the case before, back with its token.
  const phone = new Phone();
  await phone.send({ type: "hello", token: p.got.find((m) => m.type === "paired").token, device: "T3 iPhone", appVersion: "0.1.0" });
  await phone.next("welcome");
  let mark = phone.got.length;
  req = fakeT3.askPermission("t3-login", { command: "git push" });
  const card = (await phone.next("permission_prompt", (m) => m.prompt?.sessionId === ID, mark, 5000)).prompt;
  assert.equal(card.what, "use Bash");
  await phone.send({ type: "permission", promptId: card.promptId, decision: "deny" });
  await until(() => responded(req), 3000, "denied from the phone");
  assert.equal(responded(req).decision, "decline");
  await wait(300);
  mark = phone.got.length;
  req = fakeT3.askQuestions("t3-login", [
    {
      id: "q2",
      header: "Extras",
      question: "Which extras?",
      options: [
        { label: "Auth", description: "sign in", value: "auth" },
        { label: "Billing", description: "" },
      ],
      multiSelect: true,
    },
  ]);
  const quiz = (await phone.next("permission_prompt", (m) => m.prompt?.sessionId === ID && m.prompt.questions, mark, 5000)).prompt;
  assert.deepEqual(
    quiz.questions.map((q: any) => [q.header, q.question, q.options.map((o: any) => o.label), q.multiSelect]),
    [["Extras", "Which extras?", ["Auth", "Billing"], true]],
  );
  await phone.send({ type: "answers", promptId: quiz.promptId, answers: [{ labels: ["Auth", "Billing"] }] });
  await until(() => responded(req), 3000, "answered from the phone");
  assert.deepEqual(responded(req).answers, { q2: ["auth", "Billing"] });
  phone.close();
  ui.act({ type: "set", key: "phone" as any, value: false });
  await until(() => events("phone_off").length > 0, 3000, "the phone server off");
  console.log("ok: decline and answers from the phone");

  begin("T3: stop and rename by voice, and from the window's menus: through T3, no key typed; the new name in T3 and in the list");
  await wait(300);
  ui.act({ type: "set", key: "voiceCan", value: "everything" });
  const keys = T.keys.length;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "stop_session", session: listed() }];
  await talk("stop pixie login");
  await until(() => fakeT3.dispatched.some((c) => c.type === "run.interrupt" && c.threadId === "t3-login"), 3000, "interrupted through T3");
  await until(() => spoke("Interrupted Pixie login's current turn."), 3000, "said");
  await until(() => listed()?.status === "idle", 3000, "its run stopped");
  T.route = () => [{ name: "rename_session", session: listed(), newName: "Login cookies" }];
  await talk("rename pixie login to login cookies");
  await until(() => fakeT3.dispatched.some((c) => c.type === "thread.metadata.update" && c.title === "Login cookies"), 3000, "renamed in T3");
  await until(() => spoke("Renamed Pixie login to Login cookies."), 3000, "said");
  await until(() => listed()?.givenName === "Login cookies", 3000, "listed by its new name");
  // From the window's menus (Rename… and Interrupt): the same, shown rather than said.
  ui.act({ type: "rename", sessionId: ID, name: "Pixie login" });
  await until(() => listed()?.givenName === "Pixie login", 3000, "renamed back from the menu");
  fakeT3.startRun("t3-login", "again");
  await until(() => listed()?.status === "busy", 3000, "running again");
  ui.act({ type: "interrupt", sessionId: ID });
  await until(() => fakeT3.dispatched.filter((c) => c.type === "run.interrupt").length === 2, 3000, "interrupted from the menu");
  await until(() => listed()?.status === "idle", 3000, "stopped");
  assert.equal(T.keys.length, keys, "no key typed anywhere");
  assert.ok(!caseLines().some((l) => l.kind === "voice" && /in T3 Code, so I can't|rename it there/.test(l.text)), "never out of reach");
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  console.log("ok: run.interrupt and thread.metadata.update, by voice and from the menus");

  // 2026-10-30: a new T3 thread by voice, made on T3's server (orchestration.launchThread), never a terminal.
  begin('T3: "start a T3 thread in t3 pixie and fix the cookie bug": made in T3 with its first message, listed as T3\'s beside the thread there, said, and the one your next words go to');
  await wait(1700);
  ui.act({ type: "set", key: "voiceCan", value: "everything" });
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  {
    const opens = T.opened.length;
    const launches = fakeT3.launched.length;
    T.route = () => [{ name: "start_session", project: "t3-pixie", newProject: false, sessionName: "", prompt: "Fix the cookie bug.", agent: "t3code" }];
    await talk("start a T3 thread in t3 pixie and fix the cookie bug");
    await until(() => spoke("Started a T3 Code thread in t3 pixie."), 5000, "said");
    assert.equal(fakeT3.launched.length, launches + 1);
    const sent = fakeT3.launched.at(-1);
    assert.deepEqual(
      [sent.projectId, sent.title, sent.generateTitle, sent.initialMessage?.text, sent.modelSelection, sent.runtimeMode, sent.workspaceStrategy],
      ["t3p", "Fix the cookie bug.", true, "Fix the cookie bug.", { instanceId: "codex", model: "gpt-6-astra" }, "full-access", { type: "root" }],
    );
    const NEW = `t3:${sent.threadId}`;
    const row = (): any => ui.state.sessions.find((s: any) => s.sessionId === NEW);
    await until(() => row()?.agent === "t3code" && row()?.place?.via === "t3code", 3000, "listed as an outside session, T3's");
    assert.equal(row().cwd, "/nonexistent/t3-pixie");
    assert.ok(listed(), "the thread that was there still listed, as T3's");
    assert.equal(listed().place?.via, "t3code");
    assert.equal(T.opened.length, opens, "no terminal opened");
    assert.deepEqual(
      events("start_elsewhere")
        .map((l) => [l.agent, l.ready, l.folder, l.how, l.prompt])
        .at(-1),
      ["t3code", true, "/nonexistent/t3-pixie", "exact", true],
    );
    assert.ok(events("session_open").some((l) => l.sessionId === NEW && l.agent === "t3code"));
    // Your next words: it's the session you dealt with last, as one opened in a terminal is.
    let dealtWith: string | null = null;
    T.route = (input: any) => ((dealtWith = input.lastId), []);
    await wait(1700);
    await talk("and add a test for it too");
    assert.equal(dealtWith, NEW);

    begin('T3: a new thread with no message: an empty one, New thread; "on Claude": on T3\'s Claude');
    await wait(1700);
    T.route = () => [{ name: "start_session", project: "t3-pixie", newProject: false, sessionName: "", prompt: "", agent: "t3code" }];
    await talk("open a new T3 thread in t3 pixie on Claude");
    await until(() => fakeT3.launched.length === launches + 2, 5000, "made");
    const empty = fakeT3.launched.at(-1);
    assert.deepEqual([empty.title, empty.generateTitle, "initialMessage" in empty, empty.modelSelection.instanceId], ["New thread", false, false, "claudeAgent"]);
    await until(() => spoke("Started a T3 Code thread in t3 pixie."), 3000, "said");
    console.log("ok: launchThread, listed, said, the next words' session; empty, on Claude");

    begin("T3: a project T3 doesn't have, and T3 refusing: said why, nothing made, no terminal opened");
    await wait(1700);
    T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "", prompt: "", agent: "t3code" }];
    await talk("start a T3 thread in tideline");
    await until(() => spoke("tideline isn't a project in T3 Code yet. Add it in T3 Code first."), 3000, "not T3's project, said");
    assert.equal(fakeT3.launched.length, launches + 2, "nothing sent to T3");
    fakeT3.refuseLaunch = "Provider is disabled.";
    await wait(1700);
    T.route = () => [{ name: "start_session", project: "t3-pixie", newProject: false, sessionName: "", prompt: "", agent: "t3code" }];
    await talk("start a T3 thread in t3 pixie");
    await until(() => spoke("I couldn't start a T3 Code thread: T3 Code didn't take it (OrchestrationV2ThreadLaunchError: Provider is disabled.)."), 5000, "why, said");
    fakeT3.refuseLaunch = null;
    assert.ok(
      caseLog().some((l) => l.event === "t3_command" && l.type === "launchThread" && l.ok === false),
      "logged",
    );
    assert.equal(T.opened.length, opens, "never Claude Code instead");
    console.log("ok: said why, nothing else");

    begin("T3: the window's + new session in a T3 project offers T3 Code (connected) beside Claude Code; picked, a thread in T3, shown not said");
    const windowBefore = ui.state.window;
    ui.set({ window: { shown: null, note: "" } });
    await wait(300);
    const saidBefore = caseSaid().length;
    ui.act({ type: "start", pick: { project: "/nonexistent/t3-pixie" } });
    await until(() => Boolean(ui.state.window?.agentAsk), 3000, "the picker");
    const ask = ui.state.window!.agentAsk!;
    assert.deepEqual(
      ask.rows.map((r: any) => r.id),
      ["claude-code", "t3code"],
    );
    assert.equal(ask.selected, "claude-code", "Claude Code preselected, as ever");
    const n = fakeT3.launched.length;
    ui.act({ type: "pickAgent", ask: ask.ask, agent: "t3code" });
    await until(() => fakeT3.launched.length === n + 1, 3000, "made from the picker");
    assert.equal(fakeT3.launched.at(-1).projectId, "t3p");
    await until(() => caseLog().some((l) => l.event === "session_open" && l.agent === "t3code" && l.by === "window"), 3000, "opened from the window");
    assert.deepEqual(
      [
        caseLog()
          .filter((l) => l.event === "harness_picked")
          .at(-1).agent,
        caseLog()
          .filter((l) => l.event === "harness_picked")
          .at(-1).how,
      ],
      ["t3code", "picker"],
    );
    assert.equal(T.opened.length, opens);
    await wait(200);
    assert.equal(caseSaid().length, saidBefore, "nothing said");
    // A folder that isn't T3's: no picker (Claude Code alone), as before.
    ui.set({ window: windowBefore });
    console.log("ok: offered in a T3 project, made from the picker");
  }
  ui.act({ type: "set", key: "voiceCan", value: "messages" });

  // Words for T3 went to a T3 Code thread that runs on Codex, and
  // Codex's hooks fired for the same turn (session_meta originator "T3 Code"): Kiko listed a Codex
  // session "workbench", read "In workbench, Claude said hello world." out, then T3's own reply.
  begin("T3 on Codex: one chat, one announcement (T3's); Codex's hooks for its thread are let go unanswered, its permission left to T3, and no Codex session is listed");
  await wait(300);
  {
    const CODEX_ID = "01f71e90-34d9-79f3-a61d-9a63382e1261";
    const route = (await import("../../../src/agents/hook-routes.ts")).hookRoute("codex")!;
    const home = process.env.CODEX_HOME!;
    const day = `${home}/sessions/2026/10/30`;
    mkdirSync(day, { recursive: true });
    const rollout = `${day}/rollout-2026-10-30T17-48-38-${CODEX_ID}.jsonl`;
    const meta = { id: CODEX_ID, cwd: "/nonexistent/t3-pixie", originator: "T3 Code", source: "vscode", cli_version: "0.153.0" };
    writeFileSync(rollout, `${JSON.stringify({ timestamp: "2026-10-30T17:48:38.400Z", type: "session_meta", payload: meta })}\n`);
    // What listed it as a session of its own: a record its hook kept (before it could tell whose it was) and the thread's writer lock.
    const record = `${process.env.KIKO_CODEX_SESSIONS}/${CODEX_ID}.json`;
    mkdirSync(process.env.KIKO_CODEX_SESSIONS!, { recursive: true });
    writeFileSync(record, JSON.stringify({ sessionId: CODEX_ID, cwd: meta.cwd, transcriptPath: rollout, status: "busy", at: Date.now() }));
    mkdirSync(`${home}/thread-writer-locks`, { recursive: true });
    writeFileSync(`${home}/thread-writer-locks/${CODEX_ID}.lock`, "");
    /** A line from codex-hook.mjs for its thread, on a stand-in connection: what the app answered, and whether it closed it. */
    const hook = (e: Record<string, unknown>) => {
      const conn: any = {
        answer: undefined as any,
        closed: false,
        on() {},
        end(line?: string) {
          conn.closed = true;
          if (line) conn.answer = JSON.parse(line);
        },
      };
      route({ agent: "codex", session_id: CODEX_ID, cwd: meta.cwd, transcript_path: rollout, ...e }, conn);
      return conn;
    };
    const announced = () => events("announce").filter((l) => l.sessionId === ID).length;
    const n = announced();
    const summaries = T.summaries.length;
    T.needs = [0.8];
    fakeT3.startRun("t3-login", "say hello world");
    await until(() => listed()?.status === "busy", 3000, "the run seen");
    const conns = [
      hook({ hook_event_name: "SessionStart", source: "resume" }),
      hook({ hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "say hello world" }),
      hook({ hook_event_name: "PermissionRequest", turn_id: "t1", tool_name: "Bash", tool_input: { command: "echo hello world" } }),
      hook({ hook_event_name: "Stop", turn_id: "t1", stop_hook_active: false, last_assistant_message: "hello world" }),
    ];
    assert.deepEqual(
      conns.map((c) => [c.closed, c.answer]),
      Array(4).fill([true, undefined]),
      "each let go at once, with no answer: nothing held, no card",
    );
    assert.notEqual(ui.state.permission?.sessionId, CODEX_ID);
    // The real hook for it: nothing printed (so T3 answers its own prompt), nothing kept, gone at once.
    const kept = `${process.cwd()}/codex-sessions-t3`;
    const ran = spawnSync(process.execPath, [new URL("../../../hooks/codex-hook.mjs", import.meta.url).pathname], {
      input: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: CODEX_ID,
        cwd: meta.cwd,
        transcript_path: rollout,
        turn_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "echo hello world" },
      }),
      env: { ...process.env, KIKO_CODEX_SESSIONS: kept },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.deepEqual([ran.status, ran.stdout], [0, ""]);
    assert.equal(existsSync(kept), false, "no record kept");
    await fakeT3.completeRun("t3-login", "hello world");
    await until(() => announced() === n + 1, 5000, "T3's announcement");
    T.hooks.onSessionsChanged();
    await wait(500);
    assert.equal(announced(), n + 1, "announced once");
    assert.deepEqual(
      T.summaries.slice(summaries).map((s: any) => [s.name, s.claudeReply, s.voice.speaker]),
      [["Pixie login", "hello world", ""]],
      "one summary: T3's, saying it, not Claude",
    );
    assert.ok(!events("announce").some((l) => l.sessionId === CODEX_ID), "nothing announced for Codex's side");
    assert.ok(!ui.state.sessions.some((s: any) => s.sessionId === CODEX_ID || (s.agent === "codex" && s.cwd === meta.cwd)), "no phantom Codex row");
    for (const name of ["session_started", "prompt_submitted", "hook_permission", "hook_stop"]) assert.ok(!caseLog().some((l) => l.event === name && l.sessionId === CODEX_ID), `no ${name} for it`);
    assert.deepEqual(
      events("codex_other_app").map((l) => [l.sessionId, l.originator]),
      [[CODEX_ID, "T3 Code"]],
      "logged once",
    );
    rmSync(record, { force: true });
    rmSync(`${home}/thread-writer-locks/${CODEX_ID}.lock`, { force: true });
  }
  console.log("ok: announced once, by T3; Codex's hooks for its thread let go; no Codex row");

  // T3 Code in setup's list with the others; unticked, Kiko leaves it alone.
  begin("T3: settings → Agents turns it off (its connection closed, its threads off the list, a no kept) and on again (connected, listed)");
  {
    const answer = () => JSON.parse(readFileSync("settings-test.json", "utf8")).agentAnswers?.t3code;
    const row = (): any => ui.state.settings.find((r: any) => r.key === "agent:t3code");
    assert.ok(listed(), "listed while on");
    ui.act({ type: "set", key: "agent:t3code", value: "disconnect" });
    await until(() => !listed(), 3000, "its thread off the list");
    assert.equal(answer(), "no");
    await until(() => fakeT3.sockets === 0, 3000, "its connection closed");
    assert.equal(row()?.value, "Off");
    assert.ok(info("(T3 Code is off: Kiko leaves it alone; nothing of its own changed.)"));
    const connects = events("t3_connect").length;
    await wait(600);
    assert.equal(events("t3_connect").length, connects, "not connected again while off");
    assert.equal(fakeT3.sockets, 0);
    ui.act({ type: "set", key: "agent:t3code", value: "connect" });
    await until(() => listed(), 5000, "listed again");
    assert.equal(answer(), "yes");
    assert.ok(fakeT3.sockets > 0);
    await until(() => row()?.value === "Connected (by itself)", 3000, "its row: connected");
  }
  console.log("ok: off: closed, unlisted, remembered; on: connected and listed again");

  begin("T3: a mismatch is handled gracefully");
  const MISMATCH = "T3 Code updated in a way this Kiko doesn't know yet; voice control of T3 is off until Kiko updates.";
  fakeT3.protocol = 3;
  fakeT3.dropAll();
  await until(() => spoke(MISMATCH), 5000, "the mismatch said");
  await until(() => !listed(), 5000, "its threads off the list");
  assert.deepEqual(
    events("t3_connect")
      .map((l) => [l.protocol, l.ok, l.why])
      .at(-1),
    [3, false, "protocol"],
  );
  await wait(300);
  assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text === MISMATCH).length, 1, "said once");
  // Claude Code's sessions are as they were.
  assert.ok(ui.state.sessions.some((s: any) => s.sessionId === TERM.sessionId));
  console.log("ok: said once, T3 off, the rest as before");

  // T3 not open, a session asked of it starts in a terminal in its place, said.
  begin("T3 not open: a T3 session starts in a terminal instead, in the project named (else a scratch folder), in the agent named (else the default), said; starting off: refused as ever");
  await wait(1700);
  {
    const QUASAR = `${PROJECTS_ROOT}/quasar`;
    mkdirSync(QUASAR, { recursive: true });
    const opened = () => T.opened.at(-1);
    const fallbacks = () => events("start_elsewhere").filter((l) => l.ready === false);
    const launches = fakeT3.launched.length;
    ui.act({ type: "set", key: "voiceCan", value: "everything" });
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    let count = T.opened.length;
    T.route = () => [{ name: "start_session", project: "quasar", newProject: false, sessionName: "", prompt: "Look at the readme.", agent: "t3code" }];
    await talk("start a T3 thread in quasar and look at the readme");
    await until(() => T.opened.length > count, 5000, "a terminal session opened");
    assert.equal(opened().cwd, QUASAR);
    assert.match(opened().command, /\bclaude\b/);
    assert.match(opened().command, /Look at the readme\./, "its first message on its command line, as any start's");
    assert.ok(spoke("T3 Code isn't open, so I'm starting it in Claude Code."));
    await until(() => spoke("Opening quasar."), 3000, "where, said as any start's");
    assert.deepEqual([fallbacks().at(-1).agent, fallbacks().at(-1).fallback, fallbacks().at(-1).folder], ["t3code", "claude-code", QUASAR]);

    begin('T3 not open: no project named, a scratch folder; "on Codex", Codex');
    await wait(1700);
    count = T.opened.length;
    T.route = () => [{ name: "start_session", project: null, newProject: false, sessionName: "", prompt: "", agent: "t3code" }];
    await talk("open a new T3 session");
    await until(() => T.opened.length > count, 5000, "opened");
    assert.ok(opened().cwd.startsWith(SCRATCH), "a scratch folder");
    assert.ok(spoke("T3 Code isn't open, so I'm starting it in Claude Code."));
    await wait(1700);
    count = T.opened.length;
    T.route = () => [{ name: "start_session", project: "quasar", newProject: false, sessionName: "", prompt: "", agent: "t3code" }];
    await talk("start a T3 thread in quasar on Codex");
    await until(() => T.opened.length > count, 5000, "opened");
    assert.match(opened().command, /\bcodex\b/);
    assert.ok(spoke("T3 Code isn't open, so I'm starting it in Codex."));
    assert.deepEqual(
      [
        fallbacks().at(-1).fallback,
        caseLog()
          .filter((l) => l.event === "harness_picked")
          .at(-1).how,
      ],
      ["codex", "named"],
    );
    assert.equal(fakeT3.launched.length, launches, "nothing sent to T3");

    begin("T3 not open, starting sessions off: refused as any start is, nothing opened");
    await wait(1700);
    ui.act({ type: "set", key: "voiceCan", value: "messages" });
    count = T.opened.length;
    await talk("start a T3 thread in quasar");
    await until(() => spoke(OFF_LINE("Starting sessions")), 3000, "refused, with where to turn it on");
    await wait(300);
    assert.equal(T.opened.length, count);
    console.log("ok: Claude Code or Codex in its place, said; refused when starting is off");
  }
  await fakeT3.close();
}
