import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { begin, caseLines, caseLog, caseSaid, DESK, Phone, phoneServer, PROJECTS_ROOT, spoke, startOpened, T, talk, TERM, ui, until, wait, windowOpen } from "../driver.ts";

// Codex CLI (src/agents/codex/): a Codex session in Kiko's tmux, its hooks handed to the app as the
// one hooks socket hands them (its route, ../hook-routes.ts, with a stand-in connection that keeps
// what the hook would print from). Heard and replied to in its reply window by voice; its permission
// asked out loud and allowed by voice, then denied from the phone (which lists it as Codex's);
// typed into at any moment (always a bracketed paste); renamed and interrupted by voice (/rename,
// Escape); its questions said to wait in its window; and started from Kiko only when Codex is said
// ("start a Codex session"), renamed once it's listed (Codex has no flag for a name).
export async function codexCases() {
  const { hookRoute } = await import("../../../src/agents/hook-routes.ts");
  const route = hookRoute("codex")!;
  const ID = "019a3f2e-0000-7000-8000-00000000c0de";
  const CODEX = {
    ...TERM,
    sessionId: ID,
    name: "pixie",
    givenName: "",
    cwd: `${PROJECTS_ROOT}/pixie`,
    status: "idle",
    agent: "codex",
    place: { via: "tmux", id: "%7", keys: true, pid: 5252, bracketed: true },
    mapping: "process",
  };
  const listed = (): any => ui.state.sessions.find((s: any) => s.sessionId === ID);
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  /** A hook line from codex-hook.mjs, on a stand-in connection: what the app answered (`answer`), and whether it closed it. */
  const hook = (e: Record<string, unknown>) => {
    const conn: any = {
      answer: undefined as any,
      closed: false,
      onClose: () => {},
      on(ev: string, cb: () => void) {
        if (ev === "close") conn.onClose = cb;
      },
      end(line?: string) {
        conn.closed = true;
        if (line) conn.answer = JSON.parse(line);
      },
    };
    route({ agent: "codex", session_id: ID, cwd: CODEX.cwd, ...e }, conn);
    return conn;
  };
  const before = T.sessions;
  T.sessions = [DESK, CODEX];
  T.tmux = {
    panes: [{ id: "%7", pid: 5200, tty: "/dev/ttys052", inMode: false, session: "pixie", cwd: CODEX.cwd, command: "codex" }],
    procs: [
      { pid: 5200, ppid: 1, pgid: 5200, tpgid: 5252, stat: "Ss", tty: "ttys052" },
      { pid: 5252, ppid: 5200, pgid: 5252, tpgid: 5252, stat: "S+", tty: "ttys052" },
    ],
  };
  T.hooks.onSessionsChanged();
  await until(() => listed()?.place?.via === "tmux", 5000, "the Codex session listed");

  begin("Codex: a finished turn is heard, and a spoken reply in its window carries the turn on through its Stop hook");
  assert.equal(listed().agent, "codex");
  T.needs = [0.8];
  T.utterance = () => ({ audience: listed(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const stop = hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Fixed the login bug." });
  assert.equal(stop.closed, false, "held for the reply");
  await until(() => caseSaid().some((x: any) => x.text === "summary for pixie"), 5000, "the announcement");
  assert.equal(T.summaries.at(-1).claudeReply, "Fixed the login bug.");
  assert.deepEqual(T.summaries.at(-1).voice, { agent: "Codex", speaker: "Codex" }, "Codex says, not Claude");
  await windowOpen(CODEX);
  await talk("now add a test for it");
  await until(() => stop.closed, 3000, "the hook answered");
  assert.deepEqual(stop.answer, { reply: "now add a test for it" });
  assert.ok(events("hook_answer").some((l) => l.agent === "codex" && l.reply === "now add a test for it"));
  console.log("ok: read out, replied to through its hook");

  begin("Codex: its permission prompt is asked out loud and allowed by voice; the hook gets Codex's allow");
  await wait(1700);
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  let ask = hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } });
  await until(() => ui.state.permission?.sessionId === ID, 5000, "its card");
  assert.ok(
    caseLines().some((l) => l.kind === "permission" && l.text === "use Bash"),
    "its card on the Mac",
  );
  await until(() => ui.state.waiting?.sessionId === ID && ui.state.waiting?.until != null, 3000, "its window open");
  T.approval = () => ({ answer: "allow", confidence: 0.95 });
  await talk("yes");
  T.approval = undefined;
  await until(() => ask.closed, 3000, "the hook answered");
  assert.deepEqual(ask.answer, { decision: { behavior: "allow" } });
  console.log("ok: allowed by voice");

  begin("Codex: on the phone it's listed as Codex's, and its permission is denied from there");
  await wait(1700);
  ui.act({ type: "set", key: "phone" as any, value: true });
  await until(() => events("phone_on").length > 0, 3000, "the phone server on");
  phoneServer.port = events("phone_on").at(-1).port;
  ui.act({ type: "settings" });
  await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
  const code = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
  ui.act({ type: "closeSettings" });
  const phone = new Phone();
  await phone.send({ type: "pair", code, device: "Codex iPhone", appVersion: "0.1.0" });
  await phone.next("welcome");
  const row = (await phone.next("sessions", (m) => m.sessions.some((x: any) => x.id === ID))).sessions.find((x: any) => x.id === ID);
  assert.equal(row.agent, "Codex");
  assert.equal(row.name, "pixie");
  const mark = phone.got.length;
  ask = hook({ hook_event_name: "PermissionRequest", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: src/login.ts\n" } });
  const card = (await phone.next("permission_prompt", (m) => m.prompt?.sessionId === ID, mark, 5000)).prompt;
  assert.equal(card.what, "use Edit", "a patch is an edit of its file");
  await phone.send({ type: "permission", promptId: card.promptId, decision: "deny" });
  await until(() => ask.closed, 3000, "the hook answered");
  assert.equal(ask.answer.decision.behavior, "deny");
  assert.equal(typeof ask.answer.decision.message, "string");
  assert.equal(ask.answer.decision.updatedPermissions, undefined);
  phone.close();
  // Forgotten, as the cases after this one expect no paired phone (Phone on then opens pairing by itself).
  ui.act({ type: "set", key: "phones" as any, value: "forget:all" });
  ui.act({ type: "set", key: "phone" as any, value: false });
  await until(() => events("phone_off").length > 0, 3000, "the phone server off");
  console.log("ok: listed as Codex, denied from the phone");

  begin("Codex: words at any moment are typed into its pane as a bracketed paste; renamed and interrupted by voice");
  await wait(1700);
  ui.act({ type: "set", key: "voiceCan", value: "everything" });
  T.utterance = () => ({ audience: listed(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const entered = (T.tmux.entered ?? []).length;
  await talk("check the logs too");
  await until(() => (T.tmux.entered ?? []).length === entered + 1, 3000, "Enter after the words");
  assert.equal(T.typed.at(-1).terminalId, "%7");
  assert.match(T.typed.at(-1).text, /check the logs too/i);
  assert.ok(
    T.tmux.calls.some((a: string[]) => a[0] === "if-shell" && /paste-buffer -p /.test(a.at(-1) ?? "")),
    "one line, as a bracketed paste",
  );
  await wait(1700);
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "rename_session", session: listed(), newName: "Login fix" }];
  await talk("rename pixie to login fix");
  await until(() => T.typed.some((t: any) => t.terminalId === "%7" && t.text === "/rename Login fix"), 3000, "/rename typed");
  await until(() => spoke("Renamed pixie to Login fix."), 3000, "said");
  T.route = () => [{ name: "stop_session", session: listed() }];
  await talk("stop pixie");
  assert.deepEqual(T.keys.at(-1), { terminalId: "%7", key: "Escape" });
  assert.ok(spoke("Interrupted pixie's current turn. Anything it started in the background keeps running."));
  console.log("ok: bracketed paste and Enter, /rename, Escape");

  begin("Codex: its questions can't be answered from here: said once, to answer in its window");
  await wait(300);
  const asking = hook({ hook_event_name: "PreToolUse", tool_name: "request_user_input", tool_input: { questions: [] } });
  assert.equal(asking.closed, true, "told, not held");
  await until(() => spoke("pixie in Codex is asking you something in its window: answer it there."), 3000, "said");
  console.log("ok");

  begin("Codex: \"start a Codex session in tideline named docs\" opens codex in Kiko's tmux, and it's renamed once listed; without Codex said, Claude Code");
  await wait(1700);
  T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "docs", prompt: "", agent: "codex" }];
  T.tmux.paneIds = true;
  await talk("start a Codex session in tideline named docs");
  const opened = T.opened.at(-1);
  assert.equal(opened.via, "tmux");
  assert.equal(opened.cwd, `${PROJECTS_ROOT}/tideline`);
  assert.match(
    opened.command,
    /unset TMUX TMUX_PANE; codex -c check_for_update_on_startup=false (?:-c \S+ )?-a on-request -s workspace-write; program_status=\$\?; export TMUX=/,
    "codex, no name on its command line; Accept edits as Codex has it",
  );
  // Codex named (here not connected, so Claude Code alone could start one unnamed): which agent, said.
  assert.ok(spoke("Starting a Codex session in tideline."));
  assert.equal(
    caseLog()
      .filter((l) => l.event === "harness_picked")
      .at(-1).how,
    "named",
  );
  assert.equal(
    caseLog()
      .filter((l) => l.event === "session_open")
      .at(-1).agent,
    "codex",
  );
  // This one (the tmux cases' tideline sessions may still be starting too).
  const startingId = caseLog()
    .filter((l) => l.event === "session_open")
    .at(-1).startingId;
  const startingRow = () => ui.state.sessions.find((s: any) => s.sessionId === startingId);
  await until(() => startingRow()?.agent === "codex", 3000, "it listed as Codex's while it starts");
  // Codex lists it from its first prompt (typed in its window): found in its pane by its process.
  const pane = T.tmux.panes.at(-1);
  pane.command = "codex";
  T.tmux.procs.push({ pid: 6262, ppid: pane.pid, pgid: 6262, tpgid: 6262, stat: "S+", tty: "ttys900" });
  T.tmux.procs.push({ pid: pane.pid, ppid: 1, pgid: pane.pid, tpgid: 6262, stat: "Ss", tty: "ttys900" });
  const DOCS = { ...CODEX, sessionId: "019a-docs", cwd: `${PROJECTS_ROOT}/tideline`, name: "tideline", place: { via: "tmux", id: pane.id, keys: true, pid: 6262, bracketed: true } };
  T.sessions = [DESK, CODEX, DOCS];
  T.hooks.onSessionsChanged();
  await until(() => caseLog().some((l) => l.event === "session_ready" && l.sessionId === "019a-docs"), 5000, "it started (session_ready)");
  await until(() => T.typed.some((t: any) => t.terminalId === pane.id && t.text === "/rename docs"), 6000, "renamed once listed and idle");
  // The router said codex, but the words don't: Claude Code, the default.
  T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "", prompt: "", agent: "codex" }];
  await talk("open a new session in tideline");
  assert.match(T.opened.at(-1).command, /unset TMUX TMUX_PANE; claude --permission-mode acceptEdits; program_status=\$\?; export TMUX=/);
  assert.ok(spoke("Opening tideline."));
  console.log("ok: codex opened in tmux and named after; Claude Code unless Codex is said");

  begin("Codex: a pane running codex in Kiko's tmux that the app didn't open (kiko codex), whose hooks never fire: listed from its pane, typed into once ready; closed, it just leaves the list");
  await wait(1700);
  const lone = { id: "%77", pid: 7700, tty: "/dev/ttys077", inMode: false, session: "kiko", cwd: `${PROJECTS_ROOT}/clipkit`, command: "codex" };
  T.tmux.panes.push(lone);
  T.tmux.procs.push({ pid: 7700, ppid: 1, pgid: 7700, tpgid: 7701, stat: "Ss", tty: "ttys077" }, { pid: 7701, ppid: 7700, pgid: 7701, tpgid: 7701, stat: "S+", tty: "ttys077" });
  T.tmux.screens = { ...(T.tmux.screens ?? {}), "%77": "╭──╮\n│ >_ OpenAI Codex (v0.166.0) │\n╰──╯\n\n› Ask Codex to do anything\n" };
  T.hooks.onSessionsChanged();
  const loneRow = (): any => ui.state.sessions.find((s: any) => s.place?.via === "tmux" && s.place.id === "%77");
  await until(() => loneRow()?.agent === "codex", 5000, "listed from its pane, as Codex's");
  assert.equal(loneRow().name, "clipkit");
  assert.ok(caseLog().some((l) => l.event === "session_adopted" && l.pane === "%77" && l.agent === "codex"));
  await until(() => loneRow()?.status === "idle", 8000, "ready at its prompt (its window read)");
  assert.equal(ui.state.sessions.filter((s: any) => s.place?.id === "%77").length, 1, "listed once");
  T.utterance = () => ({ audience: loneRow(), audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  await talk("look at the readme");
  await until(() => T.typed.some((t: any) => t.terminalId === "%77" && t.text === "look at the readme"), 6000, "typed into its pane");
  // Its pane gone (Codex quit): out of the list, nothing said for one the app didn't open.
  const saidBefore = caseSaid().length;
  T.tmux.panes = T.tmux.panes.filter((x: any) => x !== lone);
  T.hooks.onSessionsChanged();
  await until(() => !loneRow(), 6000, "gone from the list");
  assert.ok(caseLog().some((l) => l.event === "session_never_started" && l.adopted));
  assert.ok(
    !caseSaid()
      .slice(saidBefore)
      .some((x: any) => /closed before it started/.test(x.text)),
    "nothing said",
  );
  console.log("ok: listed and reachable from its pane, hooks or not");

  begin("Codex: an outside Codex (0.166, its own terminal, no turn, no hooks) is listed from Codex's daemon; /rename in it shows here, a rename from here shows in it; quit, it leaves the list");
  await wait(300);
  // The fake Codex TUI (tests/support/fake-codex.mjs) through a link named codex, so pgrep and ps say codex, in a folder of its own.
  const node = `${process.cwd()}/node-as/codex`;
  if (!existsSync(node)) {
    mkdirSync(`${process.cwd()}/node-as`, { recursive: true });
    try {
      linkSync(process.execPath, node);
    } catch {
      symlinkSync(process.execPath, node);
    }
  }
  const cedarDir = `${PROJECTS_ROOT}/cedar`;
  mkdirSync(cedarDir, { recursive: true });
  const codexLog = `${process.cwd()}/codex-outside.log`;
  rmSync(codexLog, { force: true });
  const noted = () => (existsSync(codexLog) ? readFileSync(codexLog, "utf8").split("\n").filter(Boolean) : []);
  const fakeCodex = spawn(node, [new URL("../../support/fake-codex.mjs", import.meta.url).pathname], {
    cwd: cedarDir,
    env: { ...process.env, FAKE_CODEX_LOG: codexLog, FAKE_CODEX_HOOK: "" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  /** Typed in its own terminal as you would: a paste, then Enter a moment later (its TUI takes an Enter right after fast keys as a new line). */
  const typeInCodex = async (text: string) => {
    fakeCodex.stdin!.write(`\x1b[200~${text}\x1b[201~`);
    await wait(200);
    fakeCodex.stdin!.write("\r");
  };
  const cedar = (): any => ui.state.sessions.find((s: any) => s.agent === "codex" && s.cwd === cedarDir);
  try {
    await until(() => noted().includes("thread started"), 5000, "its thread opened in Codex's daemon");
    const threadId = noted()
      .find((l) => l.startsWith("session "))!
      .slice("session ".length);
    await until(() => Boolean(cedar()), 10_000, "listed with no turn, from Codex's daemon");
    assert.equal(cedar().sessionId, threadId);
    assert.equal(cedar().name, "cedar");
    assert.equal(cedar().status, "idle");
    assert.ok(!noted().some((l) => l.startsWith("submit ")), "no turn");
    // /rename typed in Codex: the list follows within a couple of seconds.
    await typeInCodex("/rename Cedar");
    await until(() => cedar()?.givenName === "Cedar", 3000, "renamed in Codex, shown here");
    // Renamed from the window's menu: through Codex's daemon, nothing typed anywhere; Codex shows it.
    const typedBefore = T.typed.length;
    ui.act({ type: "rename", sessionId: threadId, name: "Cedar docs" });
    await until(() => noted().includes("named Cedar docs"), 3000, "Codex told the new name");
    await until(() => cedar()?.givenName === "Cedar docs", 3000, "listed by it");
    assert.equal(T.typed.length, typedBefore, "nothing typed");
    assert.ok(caseLog().some((l) => l.event === "renamed" && l.sessionId === threadId && l.agent === "codex"));
    // Quit: it leaves the list at once (its TUI gone), not when the daemon lets its thread go.
    await typeInCodex("/exit");
    await until(() => !cedar(), 6000, "gone from the list");
    console.log("ok: listed from Codex's daemon with no turn; renamed both ways; gone as it quits");
  } finally {
    if (fakeCodex.exitCode === null) fakeCodex.kill();
  }

  await startOpened();
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [];
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  T.tmux = undefined;
  T.sessions = before;
  T.hooks.onSessionsChanged();
}
