import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { begin, caseLines, caseLog, caseSaid, Phone, phoneServer, PROJECTS_ROOT, SCRATCH, startOpened, T, talk, ui, until, wait, windowOpen } from "../driver.ts";

// OpenCode (src/agents/opencode/): the real adapter against a fake background service (tests/support/
// fake-opencode.ts, its file in out/opencode-state, as OpenCode 2's service writes its own) and a
// fake TUI (tests/support/fake-opencode-tui.mjs, a process named opencode in a terminal of its own,
// through `script`), never the real OpenCode. Connected from settings → Agents (only Kiko's
// settings change); an outside session listed as soon as it has one; its turn read out and replied
// to; a permission answered from the card, by voice and from the phone, its questions by voice;
// renamed both ways, interrupted, words at any moment and Close, all through its service (Close:
// SIGHUP to its TUI); started in Kiko's tmux ("start an OpenCode session"), and the window's
// picker offering it; a TUI quitting (off the list and the phone's at once, the phone's words for it
// not sent) and the next one there (only its own session listed, of two with one title);
// disconnected, nothing of it listed.
export async function opencodeCases() {
  const { FakeOpenCode } = await import("../../support/fake-opencode.ts");
  const { claudeCodeSetup } = await import("../../../src/agents/claude-code/setup.ts");
  const { loadSettings } = await import("../../../src/core/settings.ts");
  const fake = await new FakeOpenCode().start(`${process.cwd()}/opencode-state/service.json`);
  const node = `${process.cwd()}/node-as/opencode`;
  if (!existsSync(node)) {
    mkdirSync(`${process.cwd()}/node-as`, { recursive: true });
    try {
      linkSync(process.execPath, node);
    } catch {
      symlinkSync(process.execPath, node);
    }
  }
  const novaDir = `${PROJECTS_ROOT}/nova`;
  mkdirSync(novaDir, { recursive: true });
  const tuiLog = `${process.cwd()}/opencode-tui.log`;
  rmSync(tuiLog, { force: true });
  const noted = () => (existsSync(tuiLog) ? readFileSync(tuiLog, "utf8").split("\n").filter(Boolean) : []);
  const nova = (): any => ui.state.sessions.find((s: any) => s.agent === "opencode" && s.cwd === novaDir);
  const sent = (path: RegExp) => fake.calls.filter((c) => path.test(c.path));
  const saidLine = (text: string) => caseLines().some((l) => l.kind === "voice" && l.text === text);
  const before = T.sessions;
  const windowBefore = ui.state.window;
  let tui: ReturnType<typeof spawn> | null = null;
  const tuis: ReturnType<typeof spawn>[] = [];
  try {
    begin("OpenCode: connected from settings → Agents (nothing of OpenCode's written), its background service listened to");
    ui.act({ type: "set", key: "agent:opencode" as any, value: "connect" });
    await until(() => fake.listeners > 0, 8000, "Kiko listening to OpenCode's service");
    assert.ok(
      caseLines().some((l) => l.text.includes("Connected OpenCode: Kiko listens to OpenCode's background service.")),
      "said what it did",
    );
    assert.deepEqual(loadSettings().linkedAgents, ["opencode"]);
    // Logged once its event stream answers, a moment after the fake counts the request as a listener.
    await until(() => caseLog().some((l) => l.event === "opencode_service" && l.ok === true), 3000, "its service logged as connected");
    console.log("ok: connected, listening");

    begin("OpenCode: an outside TUI (in its own terminal) is listed as soon as it has a session, by its title, reachable through the service");
    tui = spawn("script", ["-q", "/dev/null", node, new URL("../../support/fake-opencode-tui.mjs", import.meta.url).pathname], {
      cwd: novaDir,
      env: { ...process.env, FAKE_OPENCODE_LOG: tuiLog },
      // Not a pipe: script needs a terminal or a file there (a pipe is a socket to it).
      stdio: ["ignore", "ignore", "ignore"],
    });
    await until(() => noted().some((l) => l.startsWith("started ")), 5000, "its TUI running");
    const tuiPid = Number(
      noted()
        .find((l) => l.startsWith("started "))!
        .slice("started ".length),
    );
    // Its first message makes the session (OpenCode makes none before).
    const ses = fake.addSession({ cwd: novaDir, title: "Nova login" });
    await until(() => Boolean(nova()), 8000, "listed from OpenCode's service");
    assert.equal(nova().sessionId, ses.id);
    assert.equal(nova().givenName, "Nova login");
    assert.equal(nova().place?.via, "agent", "words go through its service");
    assert.equal(nova().pid, tuiPid, "its TUI, the one in front in its folder");
    assert.equal(nova().status, "idle");
    console.log("ok: listed at once, as the session it shows");

    begin("OpenCode: a finished turn is read out, and a reply in its window goes to it as a new message");
    T.needs = [0.8];
    T.utterance = () => ({ audience: nova(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    fake.turn(ses.id, "fix the login bug", "Fixed the login bug.");
    await until(() => caseSaid().some((x: any) => x.text === "summary for Nova login"), 5000, "the announcement");
    assert.equal(T.summaries.at(-1).claudeReply, "Fixed the login bug.");
    await windowOpen(nova());
    await talk("now add a test for it");
    await until(() => sent(/\/prompt$/).some((c) => c.body?.text === "now add a test for it"), 3000, "the reply sent as a message");
    await until(() => caseLog().some((l) => l.event === "prompt_submitted" && l.agent === "opencode"), 3000, "told it took it in");
    console.log("ok: read out, replied to through its service");

    begin("OpenCode: a permission is asked out loud and allowed by voice; one from the Mac's card, always; one denied from the phone");
    await wait(1700);
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    let p = fake.askPermission(ses.id, { resources: ["npm test"] });
    await until(() => ui.state.permission?.sessionId === ses.id, 5000, "its card");
    assert.ok(
      caseLines().some((l) => l.kind === "permission" && l.text === "use Bash"),
      "a shell command, as Claude Code's Bash",
    );
    await until(() => nova()?.status === "blocked", 3000, "needs you");
    await until(() => ui.state.waiting?.sessionId === ses.id && ui.state.waiting?.until != null, 3000, "its window open");
    T.approval = () => ({ answer: "allow", confidence: 0.95 });
    await talk("yes");
    T.approval = undefined;
    await until(() => sent(new RegExp(`/permission/${p.id}/reply$`)).length === 1, 3000, "answered");
    assert.deepEqual(sent(new RegExp(`/permission/${p.id}/reply$`))[0].body, { decision: "once" });
    await until(() => nova()?.status !== "blocked", 3000, "no longer needs you");
    await wait(1700);
    p = fake.askPermission(ses.id, { resources: ["npm run lint"], save: ["npm run lint *"] });
    await until(() => ui.state.permission?.sessionId === ses.id, 5000, "its card again");
    ui.act({ type: "allow", always: true, id: ui.state.permission!.id });
    await until(() => sent(new RegExp(`/permission/${p.id}/reply$`)).length === 1, 3000, "answered from the card");
    assert.deepEqual(sent(new RegExp(`/permission/${p.id}/reply$`))[0].body, { decision: "always" });
    await wait(1700);
    ui.act({ type: "set", key: "phone" as any, value: true });
    await until(() => caseLog().some((l) => l.event === "phone_on"), 3000, "the phone server on");
    phoneServer.port = caseLog()
      .filter((l) => l.event === "phone_on")
      .at(-1).port;
    // A phone an earlier case paired keeps pairing closed: opened for this one.
    ui.act({ type: "set", key: "phonePairing" as any, value: "open" });
    ui.act({ type: "settings" });
    await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
    const code = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
    ui.act({ type: "closeSettings" });
    const phone = new Phone();
    await phone.send({ type: "pair", code, device: "OpenCode iPhone", appVersion: "0.1.0" });
    await phone.next("welcome");
    const row = (await phone.next("sessions", (m) => m.sessions.some((x: any) => x.id === ses.id))).sessions.find((x: any) => x.id === ses.id);
    assert.equal(row.agent, "OpenCode");
    const mark = phone.got.length;
    p = fake.askPermission(ses.id, { action: "edit", resources: ["src/login.ts"], save: [] });
    const card = (await phone.next("permission_prompt", (m) => m.prompt?.sessionId === ses.id, mark, 5000)).prompt;
    assert.equal(card.what, "use Edit");
    await phone.send({ type: "permission", promptId: card.promptId, decision: "deny" });
    await until(() => sent(new RegExp(`/permission/${p.id}/reply$`)).length === 1, 3000, "denied from the phone");
    assert.equal(sent(new RegExp(`/permission/${p.id}/reply$`))[0].body.decision, "reject");
    phone.close();
    ui.act({ type: "set", key: "phones" as any, value: "forget:all" });
    ui.act({ type: "set", key: "phone" as any, value: false });
    await until(() => caseLog().some((l) => l.event === "phone_off"), 3000, "the phone server off");
    console.log("ok: once by voice, always from the card, rejected from the phone");

    begin("OpenCode: one answered in its own TUI first closes here; its questions are asked by voice and answered back");
    await wait(1700);
    p = fake.askPermission(ses.id, { resources: ["ls"] });
    await until(() => ui.state.permission?.sessionId === ses.id, 5000, "its card");
    fake.answerInTui(p.id);
    await until(() => ui.state.permission?.sessionId !== ses.id, 3000, "the card gone");
    await wait(1700);
    const form = fake.askQuestions(ses.id, [{ header: "Database", question: "Which database should I use?", options: ["Postgres", "SQLite"] }]);
    await until(() => caseSaid().some((x: any) => /Which database should I use\?/.test(x.text)), 5000, "the question asked");
    await until(() => ui.state.waiting?.sessionId === ses.id && ui.state.waiting?.until != null, 4000, "its window open");
    T.askModel = () => "2";
    await talk("sqlite");
    T.askModel = undefined;
    await until(() => sent(new RegExp(`/form/${form.id}/reply$`)).length === 1, 5000, "answered back");
    assert.deepEqual(sent(new RegExp(`/form/${form.id}/reply$`))[0].body, { answer: { q0: "SQLite" } });
    console.log("ok");

    // A deny rule of yours stops a call with no prompt: told only as the call failing (permission.rejected,
    // no permission.asked for it). Said about the session, with why it isn't offered; never a card.
    begin("OpenCode: a call your deny rules stopped is said, never offered");
    await wait(1700);
    fake.emit("session.tool.input.started", { sessionID: ses.id, assistantMessageID: "msg_9", id: "call_9", name: "shell" });
    fake.emit("session.tool.called", { sessionID: ses.id, assistantMessageID: "msg_9", id: "call_9", input: { command: "rm -rf build" }, executed: false });
    fake.emit("session.tool.failed", { sessionID: ses.id, assistantMessageID: "msg_9", id: "call_9", error: { type: "permission.rejected", message: "Permission denied: shell" }, executed: false });
    const ruleLine = "Your OpenCode permissions blocked Nova login from running rm -rf build. That's your own setting, so I can't allow it from here.";
    await until(() => caseLines().some((l) => l.kind === "spoken" && l.text === ruleLine), 5000, "said");
    assert.equal(ui.state.permission, null, "no card");
    assert.deepEqual(
      caseLog()
        .filter((l) => l.event === "auto_mode_blocked")
        .map((l) => [l.sessionId, l.by, l.offered]),
      [[ses.id, "rule", false]],
    );
    console.log("ok");

    begin("OpenCode: words at any moment go to it as a message; renamed and interrupted by voice and from the menus, through its service; a rename in its TUI shows here");
    await wait(1700);
    ui.act({ type: "set", key: "voiceCan", value: "everything" });
    T.utterance = () => ({ audience: nova(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    await talk("check the logs too");
    await until(() => sent(/\/prompt$/).some((c) => /check the logs too/i.test(c.body?.text ?? "")), 3000, "sent as a message");
    await wait(1700);
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    const keys = T.keys.length;
    const typed = T.typed.length;
    T.route = () => [{ name: "rename_session", session: nova(), newName: "Nova auth" }];
    await talk("rename nova login to nova auth");
    await until(() => fake.sessions.get(ses.id)!.title === "Nova auth", 3000, "renamed in OpenCode");
    await until(() => saidLine("Renamed Nova login to Nova auth."), 3000, "said");
    await until(() => nova()?.givenName === "Nova auth", 3000, "listed by its new name");
    fake.busy.add(ses.id);
    fake.emit("session.status", { sessionID: ses.id, status: { type: "busy" } });
    await until(() => nova()?.status === "busy", 3000, "working");
    T.route = () => [{ name: "stop_session", session: nova() }];
    await talk("stop nova auth");
    await until(() => sent(/\/interrupt$/).length === 1, 3000, "interrupted through its service");
    await until(() => nova()?.status === "idle", 3000, "stopped");
    ui.act({ type: "rename", sessionId: ses.id, name: "Nova" });
    await until(() => fake.sessions.get(ses.id)!.title === "Nova", 3000, "renamed from the menu");
    fake.renameInTui(ses.id, "Nova in TUI");
    await until(() => nova()?.givenName === "Nova in TUI", 3000, "a rename in its TUI shown here");
    assert.equal(T.keys.length, keys, "no key typed");
    assert.equal(T.typed.length, typed, "nothing typed into a terminal");
    console.log("ok: a message, renames both ways, interrupt, all through its service");

    begin("OpenCode: \"start an OpenCode session in tideline\" opens opencode in Kiko's tmux; the window's picker lists it; renamed once listed");
    await wait(1700);
    T.tmux = { panes: [], procs: [], paneIds: true, global: {} };
    claudeCodeSetup.connect!();
    T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "", prompt: "fix the docs", agent: "opencode" }];
    let count = T.opened.length;
    await talk("start an OpenCode session in tideline to fix the docs");
    await until(() => T.opened.length > count, 3000, "a session opened");
    assert.match(T.opened.at(-1).command, /unset TMUX TMUX_PANE; opencode --prompt 'fix the docs'; program_status=\$\?; export TMUX=/);
    await until(() => saidLine("Starting an OpenCode session in tideline."), 3000, "which agent said");
    assert.equal(
      caseLog()
        .filter((l) => l.event === "session_open")
        .at(-1).agent,
      "opencode",
    );
    // The window: Claude Code and OpenCode connected, so it asks which.
    ui.set({ window: { shown: null, note: "" } });
    await wait(300);
    count = T.opened.length;
    ui.act({ type: "start", pick: { project: `${PROJECTS_ROOT}/tideline` } });
    await until(() => Boolean(ui.state.window?.agentAsk), 3000, "the picker");
    const ask = ui.state.window!.agentAsk!;
    assert.deepEqual(
      ask.rows.map((r: any) => r.id),
      ["claude-code", "opencode"],
    );
    ui.act({ type: "pickAgent", ask: ask.ask, agent: "opencode" });
    await until(() => T.opened.length > count, 3000, "opened from the picker");
    assert.match(T.opened.at(-1).command, /; opencode; /);
    ui.set({ window: windowBefore });
    await startOpened();
    claudeCodeSetup.disconnect!();
    T.tmux = undefined;
    console.log("ok: opencode in tmux, by voice and from the picker");

    begin("OpenCode: Close quits its TUI (SIGHUP, after checking it's still that process), and it leaves the list");
    await wait(300);
    const { opencode } = await import("../../../src/agents/opencode/index.ts");
    const done = await opencode.end!({ sessionId: ses.id, kind: "interactive", desktop: false, pid: tuiPid });
    assert.deepEqual(done, { sent: true, pids: [tuiPid] });
    await until(() => noted().includes("sighup"), 3000, "its TUI told");
    opencode.onSessionsChanged();
    await until(() => !nova(), 8000, "gone from the list");
    console.log("ok: closed, gone");

    // "Greeting" in an OpenCode TUI in Ghostty, that TUI quit, and
    // words for it from the phone went to it through the service anyway (a turn nobody
    // saw), while the TUI opened next made a second "Greeting".
    begin(
      'OpenCode: a TUI that quits takes its session off the list, on the Mac and the phone, at once; words for it aren\'t sent; a new TUI there lists only the session it makes, of two titled "Greeting"',
    );
    await wait(1700);
    const lacyDir = `${PROJECTS_ROOT}/lacy-platform`;
    mkdirSync(lacyDir, { recursive: true });
    const startTui = async (cwd: string) => {
      const had = noted().filter((l) => l.startsWith("started ")).length;
      const proc = spawn("script", ["-q", "/dev/null", node, new URL("../../support/fake-opencode-tui.mjs", import.meta.url).pathname], {
        cwd,
        env: { ...process.env, FAKE_OPENCODE_LOG: tuiLog },
        stdio: ["ignore", "ignore", "ignore"],
      });
      tuis.push(proc);
      await until(() => noted().filter((l) => l.startsWith("started ")).length > had, 5000, "its TUI running");
      return Number(
        noted()
          .filter((l) => l.startsWith("started "))
          .at(-1)!
          .slice("started ".length),
      );
    };
    const listedAs = (id: string): any => ui.state.sessions.find((s: any) => s.sessionId === id);
    const firstPid = await startTui(lacyDir);
    const greeting = fake.addSession({ cwd: lacyDir, title: "Greeting" });
    await until(() => Boolean(listedAs(greeting.id)), 8000, "Greeting listed");
    assert.equal(listedAs(greeting.id).pid, firstPid);
    ui.act({ type: "set", key: "phone" as any, value: true });
    await until(() => caseLog().filter((l) => l.event === "phone_on").length > 0, 3000, "the phone server on");
    phoneServer.port = caseLog()
      .filter((l) => l.event === "phone_on")
      .at(-1).port;
    ui.act({ type: "set", key: "phonePairing" as any, value: "open" });
    ui.act({ type: "settings" });
    await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
    const pairCode = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
    ui.act({ type: "closeSettings" });
    const iphone = new Phone();
    await iphone.send({ type: "pair", code: pairCode, device: "OpenCode iPhone", appVersion: "0.1.0" });
    await iphone.next("welcome");
    await iphone.next("sessions", (m) => m.sessions.some((x: any) => x.id === greeting.id && x.name === "Greeting"));
    // Quit in its terminal. The phone's words, routed to it a moment after (before any look): not sent.
    const stale = listedAs(greeting.id);
    const seen = iphone.got.length;
    process.kill(firstPid, "SIGTERM");
    await until(() => noted().includes("sigterm"), 3000, "its TUI quit");
    T.utterance = () => ({ audience: stale, audienceConfidence: 0.9, intent: "message", intentConfidence: 0.9 });
    await iphone.send({ type: "type", text: "Hello, again.", talkId: "oc-quit" });
    const failed = await iphone.next("talk_status", (m) => m.talkId === "oc-quit" && m.stage === "failed", seen, 5000);
    assert.ok(!iphone.got.slice(seen).some((m) => m.type === "talk_status" && m.talkId === "oc-quit" && m.stage === "delivered"), `never delivered (${failed.detail})`);
    assert.equal(sent(/\/prompt$/).filter((c) => c.body?.text === "Hello, again.").length, 0, "no turn started in it");
    // Off the Mac's list and the phone's within a second or two (its process watched), not at the next 4s look.
    await until(() => !listedAs(greeting.id), 3000, "off the Mac's list");
    await iphone.next("sessions", (m) => !m.sessions.some((x: any) => x.id === greeting.id), seen, 3000);
    // A turn the service ran in it anyway (another client's) isn't read out.
    const announced = caseSaid().length;
    fake.turn(greeting.id, "hi", "Hello!");
    await until(() => caseLog().some((l) => l.event === "opencode_turn_unheard" && l.sessionId === greeting.id), 3000, "not heard");
    assert.equal(caseSaid().length, announced, "nothing read out");
    // Its last use was minutes before the next TUI opened.
    Object.assign(fake.sessions.get(greeting.id)!, { created: Date.now() - 600_000, updated: Date.now() - 300_000 });
    // A new TUI there shows its old tab again (OpenCode keeps tabs from one run to the next); nothing typed yet: nothing listed.
    const tabsFile = `${process.cwd()}/opencode-state/latest/tui/tabs.json`;
    mkdirSync(`${process.cwd()}/opencode-state/latest/tui`, { recursive: true });
    const tabsOf = (...ids: string[]) => JSON.stringify({ global: { tabs: [], unread: {} }, cwd: { [lacyDir]: { tabs: ids.map((sessionID) => ({ sessionID, title: "Greeting" })), unread: {} } } });
    writeFileSync(tabsFile, tabsOf(greeting.id));
    const secondPid = await startTui(lacyDir);
    opencode.onSessionsChanged();
    await wait(1200);
    assert.ok(!listedAs(greeting.id), "its old tab alone doesn't make it open");
    // Its first message makes another, which OpenCode titles "Greeting" too: only that one is listed.
    const again = fake.addSession({ cwd: lacyDir, title: "Greeting" });
    writeFileSync(tabsFile, tabsOf(greeting.id, again.id));
    await until(() => Boolean(listedAs(again.id)), 8000, "the new Greeting listed");
    assert.equal(listedAs(again.id).pid, secondPid);
    assert.ok(!listedAs(greeting.id));
    assert.deepEqual(
      ui.state.sessions.filter((s: any) => s.agent === "opencode" && s.givenName === "Greeting").map((s: any) => s.sessionId),
      [again.id],
      "one Greeting",
    );
    const onPhone = await iphone.next("sessions", (m) => m.sessions.some((x: any) => x.id === again.id), seen, 3000);
    assert.deepEqual(
      onPhone.sessions.filter((x: any) => x.name === "Greeting").map((x: any) => x.id),
      [again.id],
    );
    // The phone's words for "Greeting" go to the open one.
    T.utterance = () => ({ audience: listedAs(again.id), audienceConfidence: 0.9, intent: "message", intentConfidence: 0.9 });
    await iphone.send({ type: "type", text: "Hello from the phone.", talkId: "oc-open" });
    await iphone.next("talk_status", (m) => m.talkId === "oc-open" && m.stage === "delivered", seen, 5000);
    assert.deepEqual(
      sent(/\/prompt$/)
        .filter((c) => c.body?.text === "Hello from the phone.")
        .map((c) => c.path),
      [`/api/session/${again.id}/prompt`],
    );
    process.kill(secondPid, "SIGTERM");
    await until(() => !listedAs(again.id), 3000, "off the list once it quits");
    iphone.close();
    ui.act({ type: "set", key: "phones" as any, value: "forget:all" });
    ui.act({ type: "set", key: "phone" as any, value: false });
    await until(() => caseLog().filter((l) => l.event === "phone_off").length > 0, 3000, "the phone server off");
    rmSync(tabsFile, { force: true });
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    console.log("ok: quit, off the list and the phone, not sent; the new one listed, one Greeting");

    // An OpenCode session started from the phone's sheet with a first
    // message; its chat, opened on its starting-… id, showed a spinner for good, and the reply to the
    // next message never came, while the Mac showed both. And the sheet's name for it.
    begin(
      "OpenCode: started from the phone's sheet with a name; its chat follows it from starting to listed (your message and its reply, then the next reply live); named through its service once listed, with Voice can at messages",
    );
    await wait(1700);
    T.tmux = { panes: [], procs: [], paneIds: true, global: {} };
    claudeCodeSetup.connect!();
    ui.act({ type: "set", key: "voiceCan", value: "messages" });
    ui.act({ type: "set", key: "phone" as any, value: true });
    await until(() => caseLog().filter((l) => l.event === "phone_on").length > 0, 3000, "the phone server on");
    phoneServer.port = caseLog()
      .filter((l) => l.event === "phone_on")
      .at(-1).port;
    ui.act({ type: "set", key: "phonePairing" as any, value: "open" });
    ui.act({ type: "settings" });
    await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
    const sheetCode = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
    ui.act({ type: "closeSettings" });
    const sheet = new Phone();
    await sheet.send({ type: "pair", code: sheetCode, device: "OpenCode iPhone", appVersion: "0.2.0" });
    await sheet.next("welcome");
    await sheet.send({ type: "get_new_session_options" });
    const sheetOptions = await sheet.next("new_session_options");
    assert.deepEqual(
      sheetOptions.harnesses.map((h: any) => [h.id, h.canName]),
      sheetOptions.harnesses.map((h: any) => [h.id, true]),
      "every agent here can be named as it starts",
    );
    assert.ok(sheetOptions.harnesses.some((h: any) => h.id === "opencode"));
    const openedBefore = T.opened.length;
    await sheet.send({ type: "new_session", requestId: "oc-named", scratch: true, harness: "opencode", text: "Hello world!", name: "Greeting test" });
    const begun = await sheet.next("new_session_status", (m) => m.requestId === "oc-named" && m.stage !== "heard", 0, 5000);
    assert.equal(begun.stage, "started", JSON.stringify(begun));
    assert.match(begun.sessionId, /^starting-/);
    assert.equal(begun.name, "Greeting test");
    assert.equal(T.opened.length, openedBefore + 1);
    assert.match(T.opened.at(-1).command, /opencode --prompt 'Hello world!'/, "no flag names it: renamed once listed");
    const helloDir = T.opened.at(-1).cwd;
    assert.ok(helloDir.startsWith(`${SCRATCH}/`), helloDir);
    // Its chat, open while it starts: empty, not a spinner.
    await sheet.send({ type: "watch", sessionId: begun.sessionId });
    const empty = await sheet.next("history", (m) => m.sessionId === begun.sessionId, 0, 3000);
    assert.deepEqual(empty.items, []);
    // OpenCode makes the session at its first message, and answers.
    await startTui(helloDir);
    const hello = fake.addSession({ cwd: helloDir });
    fake.turn(hello.id, "Hello world!", "Hello! What shall we build?");
    await until(() => caseLog().some((l) => l.event === "session_ready" && l.startingId === begun.sessionId && l.sessionId === hello.id), 8000, "matched to the one started");
    const followed = await sheet.next("history", (m) => m.sessionId === begun.sessionId && m.items.length === 2, 0, 5000);
    assert.deepEqual(
      followed.items.map((i: any) => [i.kind, i.text]),
      [
        ["you", "Hello world!"],
        ["claude", "Hello! What shall we build?"],
      ],
    );
    assert.ok(
      caseLog().some((l) => l.event === "phone_watch" && l.sessionId === begun.sessionId && l.listedAs === hello.id && l.agent === "opencode"),
      "watched through OpenCode now",
    );
    // Named through its service (no key typed), though Voice can is at messages: the phone asked, not voice.
    await until(() => fake.sessions.get(hello.id)!.title === "Greeting test", 8000, "named in OpenCode");
    assert.ok(!caseLog().some((l) => l.event === "renames_dropped"));
    await sheet.next("sessions", (m) => m.sessions.some((x: any) => x.id === hello.id && x.name === "Greeting test" && x.startedAs === begun.sessionId), 0, 5000);
    // The next reply, live on the open chat.
    fake.turn(hello.id, "What can you help me with?", "Pretty much anything code-related.");
    const live = await sheet.next("history", (m) => m.sessionId === begun.sessionId && m.items.length === 4, 0, 5000);
    assert.deepEqual(live.items.at(-1), { kind: "claude", text: "Pretty much anything code-related.", at: live.items.at(-1).at });
    // The chat opened on its own id (the phone moves there once it's listed): the same.
    const ownMark = sheet.got.length;
    await sheet.send({ type: "watch", sessionId: hello.id });
    const own = await sheet.next("history", (m) => m.sessionId === hello.id && m.items.length === 4, ownMark, 5000);
    assert.equal(own.items[0].text, "Hello world!");
    sheet.close();
    ui.act({ type: "set", key: "phones" as any, value: "forget:all" });
    ui.act({ type: "set", key: "phone" as any, value: false });
    await until(() => caseLog().filter((l) => l.event === "phone_off").length > 0, 3000, "the phone server off");
    claudeCodeSetup.disconnect!();
    T.tmux = undefined;
    console.log("ok: named from the sheet, its chat followed it, the reply live");

    begin("OpenCode: disconnected from settings → Agents: not listened to, nothing of it listed");
    ui.act({ type: "set", key: "agent:opencode" as any, value: "disconnect" });
    assert.ok(caseLines().some((l) => l.text.includes("Disconnected OpenCode: Kiko no longer listens to it")));
    assert.equal(loadSettings().linkedAgents, undefined);
    T.hooks.onSessionsChanged();
    await until(() => fake.listeners === 0, 5000, "its stream closed");
    console.log("ok");
  } finally {
    if (tui && tui.exitCode === null) tui.kill();
    for (const t of tuis) if (t.exitCode === null) t.kill();
    ui.act({ type: "set", key: "voiceCan", value: "messages" });
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    T.route = () => [];
    T.sessions = before;
    await fake.stop();
  }
}
