// Sessions: listed as their hooks say they start and end, one continued in a background process, tmux and
// the Kiko window, and which agent a new one starts in.

import assert from "node:assert/strict";
import {
  begin,
  caseLines,
  caseLog,
  caseSaid,
  DESK,
  findSession,
  ghostty,
  Phone,
  phoneServer,
  PROJECTS_ROOT,
  SCRATCH,
  spoke,
  startOpened,
  stop,
  T,
  talk,
  TERM,
  ui,
  until,
  wait,
  windowOpen,
} from "../driver.ts";

// A session started or ended, as Claude Code's SessionStart and SessionEnd hooks tell it (the hooks socket
// coalesces them: tests/unit/agents/claude-code/session-hooks.test.ts): listed now, not at the next look (4s).
export async function sessionEventCases() {
  const before = T.sessions;
  const FRESH = { ...TERM, sessionId: "fresh-1", name: "fresh", cwd: "/nonexistent/fresh", place: ghostty("ghostty-9") };
  const listed = (id: string) => ui.state.sessions.some((s: any) => s.sessionId === id);

  begin("session started: listed at once");
  T.sessions = [...before, FRESH];
  const startedAt = Date.now();
  T.hooks.onSessionsChanged();
  await until(() => listed("fresh-1"), 1000);
  const tookStart = Date.now() - startedAt;
  assert.ok(tookStart < 500, `listed ${tookStart}ms after`);
  console.log(`ok: listed ${tookStart}ms after`);

  begin("session ended: gone at once");
  T.sessions = before;
  const endedAt = Date.now();
  T.hooks.onSessionsChanged();
  await until(() => !listed("fresh-1"), 1000);
  const tookEnd = Date.now() - endedAt;
  assert.ok(tookEnd < 500, `gone ${tookEnd}ms after`);
  console.log(`ok: gone ${tookEnd}ms after`);

  // Claude Code's PermissionDenied hook: auto mode blocked a call, with no prompt (a session's
  // change, twice, with nothing said). Said about that session (the
  // phone shows it under it), plainly; a burst of them from one session said once. Its window is
  // Ghostty's, outside Kiko's tmux: no card (nothing could read its mode back), and it says why.
  begin("auto mode blocked a call: said about its session, once for a burst, with why it can't be allowed from here; logged");
  const block = (command: string) =>
    T.hooks.onBlocked({ sessionId: TERM.sessionId, cwd: TERM.cwd, tool: { name: "Bash", input: { command } }, reason: "[Production Deploy]", by: "auto", mode: "auto" });
  const blockedLines = () => caseLines().filter((l) => l.kind === "spoken" && /^Auto mode blocked /.test(l.text));
  block("wrangler deploy --env production");
  await until(() => blockedLines().length === 1, 2000, "said");
  assert.match(
    blockedLines()[0].text,
    /^Auto mode blocked .+ from running wrangler deploy --env production\. It isn't in Kiko's tmux, so I can't switch it out of auto mode: allow it in its window\.$/,
  );
  assert.equal(ui.state.permission, null, "no card");
  await until(() => caseSaid().some((x: any) => /^Auto mode blocked /.test(x.text)), 2000, "out loud");
  block("wrangler deploy --env production --force");
  await until(() => caseLog().filter((l) => l.event === "auto_mode_blocked").length === 2, 2000, "logged");
  assert.deepEqual(
    caseLog()
      .filter((l) => l.event === "auto_mode_blocked")
      .map((l) => [l.sessionId, l.tool, l.reason, l.said]),
    [
      [TERM.sessionId, "Bash", "[Production Deploy]", true],
      [TERM.sessionId, "Bash", "[Production Deploy]", false],
    ],
  );
  assert.equal(blockedLines().length, 1, "the second, moments later, shown but not said again");
  console.log("ok");
}

// Two new sessions in one folder were both listed, shown and said as the folder, so they looked like one
// session. Now the second is "atlas-agents 2" in the window's list
// (Claude's title, dimmed, is the classic look's: sessions.ts sessionDetail); its number names it by voice ("atlas agents two, …"); the plain
// name asks which; and the numbers are kept beside the settings (out/session-numbers.json).
export async function sameFolderCases() {
  const { Writable, PassThrough } = await import("node:stream");
  const React = (await import("react")).default;
  const { render } = await import("ink");
  const { WindowList } = await import("../../../src/ui/window-list.ts");
  const { sessionName } = await import("../../../src/core/sessions.ts");
  const { NUMBERS_FILE } = await import("../../../src/core/session-numbers.ts");
  const { inkDone, plain } = await import("../../support/ink.ts");
  const { readFileSync } = await import("node:fs");
  const before = T.sessions;
  const TWIN = { ...TERM, sessionId: "term-twin", name: "atlas-x", title: "Session colours", place: ghostty("ghostty-twin") };
  T.sessions = [DESK, TERM, TWIN];
  T.hooks.onSessionsChanged();
  await until(() => ui.state.sessions.some((s: any) => s.sessionId === "term-twin"), 1000);

  begin("two sessions in one folder: 'atlas-agents' and 'atlas-agents 2' in the window's list");
  assert.deepEqual(ui.state.sessions.filter((s: any) => s.cwd === TERM.cwd).map(sessionName), ["atlas-agents", "atlas-agents 2"]);
  /** The list drawn 60 × 24 in a look (undefined: the default), once Ink is through with it: its lines, plain. */
  const drawList = async (look?: "classic") => {
    let text = "";
    const stdout = Object.assign(new Writable({ write: (chunk, _enc, done) => ((text += chunk.toString()), done()) }), { columns: 60, rows: 24, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const s = { ...ui.state, sessionsLoaded: true, window: { shown: null, note: "", ...ui.state.window, look } };
    const app = render(React.createElement(WindowList, { s }), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, interactive: true });
    await inkDone(app);
    app.unmount();
    // The last frame: Ink's frames after the first erase the one before (from the top, or line by line up).
    return plain(text.split(/\u001b\[2J|\u001b\[1;1H\u001b\[J|(?:\u001b\[2K\u001b\[1A)*\u001b\[2K\u001b\[G/).at(-1) ?? text)
      .split("\n")
      .map((l) => l.trimEnd());
  };
  const lines = await drawList();
  const screen = lines.join("\n");
  // Kiko's own row on top: the brand's square in the icon column, "Kiko" in the names' (src/ui/wordmark.ts), the sessions under it as ever.
  const tops: string[] = [];
  for (const look of [undefined, "classic"] as const) {
    const these = look ? await drawList(look) : lines;
    const kiko = these[0];
    assert.match(kiko, /^ {1,2}0 {3}▪ {2}Kiko$/, these.join("\n"));
    const session = these.find((l) => /✻ {2}atlas-agents/.test(l))!;
    assert.equal(kiko.indexOf("Kiko"), session.indexOf("atlas-agents"), `${look ?? "default"}: Kiko's name in the names' column\n${these.join("\n")}`);
    assert.equal(kiko.indexOf("▪"), session.indexOf("✻"), `${look ?? "default"}: its square in the icon column`);
    // The capture: the top of the list, Kiko's row down to the second atlas-agents.
    const last = these.findLastIndex((l) => l.includes("atlas-agents"));
    tops.push(`${look ?? "default"}:`, ...these.slice(0, last + 1).map((l) => `    ${l}`));
  }
  const rows = lines.filter((l) => l.includes("atlas-agents"));
  assert.ok(
    rows.some((l) => /atlas-agents 2\b/.test(l)),
    screen,
  );
  assert.ok(
    rows.some((l) => /atlas-agents(?! 2)/.test(l)),
    screen,
  );
  assert.deepEqual(JSON.parse(readFileSync(NUMBERS_FILE, "utf8"))["term-twin"], { name: "atlas agents", number: 2 });
  console.log(`ok:\n${tops.map((l) => `  ${l}`).join("\n")}`);

  begin("by voice: 'atlas agents two, …' goes into the second only; 'atlas agents, …' asks which, and 'two' answers it");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [];
  await wait(1700);
  let typed = T.typed.length;
  await talk("Atlas agents two, run the tests.");
  await until(() => T.typed.length > typed, 3000, "typed");
  assert.deepEqual(
    T.typed.slice(typed).map((t: any) => [t.terminalId, t.text]),
    [["ghostty-twin", "Run the tests."]],
  );
  await wait(1700);
  typed = T.typed.length;
  await talk("Atlas agents, check the logs.");
  await until(() => spoke("Which one: atlas agents; or atlas agents 2, Session colours?"), 3000, "asked which");
  assert.equal(T.typed.length, typed, "nothing typed before the answer");
  await wait(300);
  await talk("Two.");
  await until(() => T.typed.length > typed, 3000, "typed after the answer");
  assert.deepEqual(
    T.typed.slice(typed).map((t: any) => [t.terminalId, t.text]),
    [["ghostty-twin", "Check the logs."]],
  );
  console.log("ok");
  await wait(1700);
  T.sessions = before;
  T.hooks.onSessionsChanged();
  await until(() => !ui.state.sessions.some((s: any) => s.sessionId === "term-twin"), 1000);
}

// Claude Code 2.1.312 moved the "Kiko" terminal session's turns into a background process (2026-10-28):
// from then on its hooks come from the process's ID, and typing still goes to the terminal's window. Listed
// as one session (src/agents/claude-code/sessions.ts continuations): the process's ID, the terminal's as an
// alias, the terminal's name and window. Here the move happens while the app runs.
export async function continuedCases() {
  const before = T.sessions;
  const LACY = { ...TERM, sessionId: "lacy-c", name: "Lacy", givenName: "Lacy", cwd: "/nonexistent/lacy", place: ghostty("ghostty-lacy-c") };
  const FRONT = { ...TERM, sessionId: "front-c", name: "Kiko", givenName: "Kiko", cwd: "/nonexistent/kiko", place: ghostty("ghostty-front-c") };
  const MOVED = { ...FRONT, sessionId: "engine-c", aliases: ["front-c"], status: "busy" };
  const toKiko = () => ({ audience: findSession(ui.state.sessions, "engine-c") ?? FRONT, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  // Given the app's name, it's listed and said as "Kiko project" (sessions.ts APP_NAMED).
  // As the macOS voice (the harness's) is given it: Kiko respelled "Keeko" (core/pronunciation.ts).
  const summary = () => caseSaid().some((x: any) => x.text === "summary for Keeko project");
  T.sessions = [LACY, FRONT];
  T.hooks.onSessionsChanged();
  await wait(2100); // windows and the session list cache run out

  begin("continued: before the move, a reply to the terminal session sets it as where words go");
  T.needs = [0.8];
  const first = stop(FRONT, "cli");
  T.hooks.onRequest(first);
  await windowOpen(FRONT);
  T.utterance = toKiko;
  await talk("yes go ahead");
  assert.equal(first.reply, "yes go ahead");
  assert.equal(ui.state.targetId, "front-c");
  console.log("ok");

  begin("continued: after the move, one Kiko row under the process's ID, and where words go follows it");
  T.sessions = [LACY, MOVED];
  T.hooks.onSessionsChanged();
  await until(() => ui.state.sessions.some((s: any) => s.sessionId === "engine-c"), 1000);
  assert.deepEqual(
    ui.state.sessions.map((s: any) => s.sessionId),
    ["lacy-c", "engine-c"],
  );
  assert.equal(ui.state.targetId, "engine-c", "the target, listed under its new ID");
  console.log("ok");

  begin("continued: a Stop from the process is announced as Kiko, and answered through its hook");
  T.needs = [0.8];
  const moved = stop(MOVED, "cli");
  T.hooks.onRequest(moved);
  await windowOpen(MOVED);
  assert.ok(summary(), "said as Kiko project");
  assert.equal(ui.state.waiting?.name, "Kiko project");
  await talk("sounds good, carry on");
  assert.equal(moved.reply, "sounds good, carry on");
  console.log("ok");

  begin("continued: words for it later are typed into the terminal's window");
  await wait(1700); // its reply window runs out
  const typed = T.typed.length;
  await talk("run the tests");
  await until(() => T.typed.length > typed);
  assert.deepEqual(T.typed.slice(typed), [{ terminalId: "ghostty-front-c", text: "run the tests" }]);
  console.log("ok");

  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  T.sessions = before;
  T.hooks.onSessionsChanged();
  await wait(2100);
}

// tmux (src/terminals/tmux/, a pretend one: stubs/terminals/tmux/). Every case above runs without it
// installed, as before. With it: words and Escape go into a session's pane (brought out of copy mode
// first), a pane that changed is refused out loud with why, and new sessions open in it.
export async function tmuxCases() {
  begin("tmux: words, Escape and new sessions go through Kiko's tmux");
  const setCan = (value: string) => ui.act({ type: "set", key: "voiceCan", value });
  const toApp = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  setCan("everything");
  const TMUXED = {
    ...TERM,
    sessionId: "tmux-1",
    name: "pixie",
    cwd: `${PROJECTS_ROOT}/pixie`,
    status: "idle",
    place: { via: "tmux", id: "%1", keys: true, pid: 4242 },
    mapping: "process",
  };
  const before = T.sessions;
  T.sessions = [DESK, TMUXED];
  // Its shell (4200) started Claude Code (4242), in front on the pane's terminal; you'd scrolled back.
  T.tmux = {
    panes: [{ id: "%1", pid: 4200, tty: "/dev/ttys042", inMode: true, session: "pixie", cwd: TMUXED.cwd }],
    procs: [
      { pid: 4200, ppid: 1, pgid: 4200, tpgid: 4242, stat: "Ss", tty: "ttys042" },
      { pid: 4242, ppid: 4200, pgid: 4242, tpgid: 4242, stat: "S+", tty: "ttys042" },
    ],
  };
  await wait(2100); // windows and the session list cache run out
  const toPixie = () => ({ audience: TMUXED, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  T.utterance = toPixie;
  await talk("run the tests");
  await until(() => (T.tmux.entered ?? []).length === 1);
  assert.equal(T.typed.at(-1).terminalId, "%1");
  assert.match(T.typed.at(-1).text, /run the tests/i);
  assert.ok(
    T.tmux.calls.some((a: string[]) => a.join(" ") === "copy-mode -q -t %1"),
    "out of copy mode first",
  );
  assert.equal(T.tmux.panes[0].inMode, false);

  T.utterance = toApp;
  T.route = () => [{ name: "stop_session", session: TMUXED }];
  await talk("stop pixie");
  assert.deepEqual(T.keys.at(-1), { terminalId: "%1", key: "Escape" });
  assert.ok(spoke("Interrupted pixie's current turn. Anything it started in the background keeps running."));

  // New sessions: in tmux, shown in a window; nothing through Ghostty.
  const start = (ask: object) => () => [{ name: "start_session", project: null, newProject: false, sessionName: "", prompt: "", ...ask }];
  T.route = start({ project: "tideline" });
  await talk("open a new session in tideline");
  const opened = T.opened.at(-1);
  assert.equal(opened.via, "tmux");
  assert.equal(opened.cwd, `${PROJECTS_ROOT}/tideline`);
  assert.equal(opened.session, "tideline");
  // Claude Code without TMUX (it can't reach Kiko's server), the shell after with it again
  // (unless its pane has been in the Kiko window: then it ends with Claude Code, index.ts afterProgram).
  assert.match(
    opened.command,
    /^KIKO_KEPT_TMUX="\$TMUX"; .*unset TMUX TMUX_PANE; claude --permission-mode acceptEdits; program_status=\$\?; export TMUX=.*; \[ -n .*'#\{@kiko-home\}'.* \] \|\| exec \S+ -l$/,
  );
  assert.deepEqual(T.tmux.shown, [{ cwd: `${PROJECTS_ROOT}/tideline`, session: "tideline" }]);
  assert.ok(spoke("Opening tideline."));
  assert.equal(
    caseLog()
      .filter((l) => l.event === "session_open")
      .at(-1).via,
    "tmux",
  );
  // Started, but no window came up: said, since you'd be looking for one.
  T.tmux.showFails = "osascript: no";
  await talk("open a new session in tideline");
  assert.ok(spoke("Opening tideline. I couldn't show its window: it's running in Kiko's tmux as tideline-2."));
  delete T.tmux.showFails;
  console.log("ok: typed into its pane after leaving copy mode, Escape, opened in tmux");

  begin("tmux: a pane that changed is never typed into, and you're told why");
  await wait(2100);
  const typed = T.typed.length;
  const keys = T.keys.length;
  T.tmux.procs = T.tmux.procs.filter((p: any) => p.pid !== 4242); // Claude Code quit; its shell is in front
  T.utterance = toPixie;
  await talk("and check the logs");
  assert.ok(spoke("I didn't type that into pixie: its process has ended."));
  T.utterance = toApp;
  T.route = () => [{ name: "stop_session", session: TMUXED }];
  await talk("stop pixie");
  assert.ok(spoke("I couldn't stop pixie: its process has ended."));
  assert.equal(T.typed.length, typed);
  assert.equal(T.keys.length, keys);
  console.log("ok");

  T.tmux = undefined;
  T.sessions = before;
  setCan("messages");
}

// The Kiko window (src/terminals/tmux/window.ts, src/ui/window-glue.ts) on a pretend tmux server
// (tests/support/fake-tmux.ts): the app keeps the window's bottom line to what it's doing, puts
// sessions' names on their borders, shows a session when asked (the list's Enter), and new
// sessions by voice open in the window rather than a window of their own. This app isn't the one
// in the window's list (no --window): the faked app runs outside it, with --plain.
export async function kikoWindowCases() {
  begin("the Kiko window: the bottom line, names, Enter shows, new sessions go into it");
  const { FakeTmux } = await import("../../support/fake-tmux.ts");
  const { openWindow, BAR, LABEL } = await import("../../../src/terminals/tmux/window.ts");
  const { WINDOW } = await import("../../../src/terminals/tmux/tmux.ts");
  const fake = new FakeTmux();
  await openWindow(fake.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
  fake.sessions.get(WINDOW)!.clients = 1; // a terminal shows it
  const pane = (await fake.run(["new-session", "-d", "-s", "pixie", "-c", `${PROJECTS_ROOT}/pixie`, "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
  const PIXIE = { ...TERM, sessionId: "win-1", name: "pixie", givenName: "Pixie API", cwd: `${PROJECTS_ROOT}/pixie`, place: { via: "tmux", id: pane, keys: true, pid: 4242 }, mapping: "process" };
  const before = T.sessions;
  T.sessions = [DESK, PIXIE];
  T.tmux = { fake, panes: [], procs: [] };
  ui.act({ type: "set", key: "voiceCan", value: "everything" });
  T.hooks.onSessionsChanged();
  const bar = () => (fake.sessions.get(WINDOW)?.opts[BAR] ?? "").replace(/#\[[^\]]*\]/g, "");
  await until(() => bar().includes("is ready"), 3000);
  assert.match(bar(), /hold right ⌥ to talk/);
  await until(() => fake.panes.get(pane)!.opts[LABEL] === "Pixie API", 1000);

  // What you say shows in it only while you say it: once you let go, it's gone (never left frozen there).
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [];
  await talk("what's pixie doing");
  await until(() => !ui.state.deciding && bar().includes("is ready"), 2000);
  assert.ok(!bar().includes("what's pixie doing"), bar());

  // The list's Enter (the action it sends): pixie's own pane moves into the window.
  ui.act({ type: "show", page: "session:win-1" });
  await until(() => fake.panesOf(WINDOW)[1] === pane, 1000);

  // A new session by voice: into the window, not a window of its own (one shows the window already).
  T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "", prompt: "" }];
  await talk("open a new session in tideline");
  await until(() => fake.panes.get(fake.panesOf(WINDOW)[1])?.cwd === `${PROJECTS_ROOT}/tideline`, 2000);
  assert.equal(fake.where(pane), "pixie", "pixie went home");
  assert.deepEqual(T.tmux.shown ?? [], [], "no window of its own");
  assert.equal(
    caseLog()
      .filter((l) => l.event === "terminal_window")
      .at(-1).via,
    WINDOW,
  );

  // The window's picker (n, then a project): a session starts there, in the window; nothing said
  // (it was clicked, not asked for by voice), and Voice can doesn't apply.
  const tideline = fake.panesOf(WINDOW)[1];
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  await until(() => caseSaid().some((x: any) => x.text.includes("Opening tideline")), 2000); // the voice one's line, said
  await wait(200);
  const spokenBefore = caseSaid().length;
  ui.act({ type: "start", pick: { project: `${PROJECTS_ROOT}/pixie` } });
  await until(() => fake.panesOf(WINDOW)[1] !== tideline && fake.panes.get(fake.panesOf(WINDOW)[1])?.cwd === `${PROJECTS_ROOT}/pixie`, 2000);
  assert.equal(
    caseLog()
      .filter((l) => l.event === "session_open")
      .at(-1).by,
    "window",
  );
  await wait(300);
  assert.equal(caseSaid().length, spokenBefore, "nothing said");
  // Picked from a list that's gone stale (that folder isn't a project now): nothing opens.
  const opened = caseLog().filter((l) => l.event === "session_open").length;
  ui.act({ type: "start", pick: { project: "/nowhere/at-all" } });
  await wait(200);
  assert.equal(caseLog().filter((l) => l.event === "session_open").length, opened);
  console.log("ok: bottom line, names, shown on Enter, new session in the window (by voice, and from the picker)");

  // The sessions opened here, still starting in their panes (each with its first process, as a real
  // pane has: tests/support/fake-tmux.ts), start; none ended meanwhile.
  assert.ok(!caseLog().some((l) => l.event === "session_never_started"), "none taken for closed");
  await startOpened();
  T.tmux = undefined;
  T.sessions = before;
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
}

// Which agent a new session starts in (src/core/agent-pick.ts), with Claude Code and Codex both
// connected (their hooks written by their own setups into this harness's homes: out/claude-home,
// out/codex-home): by voice never asked, the preselected one said aloud (last used, then the run's:
// `kiko codex` leaves its agent on the server, here T.tmux.global); from the window (as the
// window's app: its state has a window) the folder picked, then the picker, Codex preselected after
// `kiko codex`, Enter (the popup's answer, as the glue hands it on) starts it, Esc doesn't; a
// named one wins; with Codex disconnected again, Claude Code alone: no picker, the words as ever.
export async function harnessPickCases() {
  const { claudeCodeSetup } = await import("../../../src/agents/claude-code/setup.ts");
  const { codexSetup } = await import("../../../src/agents/codex/setup.ts");
  const { loadSettings, rememberLastAgent } = await import("../../../src/core/settings.ts");
  const TIDELINE = `${PROJECTS_ROOT}/tideline`;
  const before = T.sessions;
  const windowBefore = ui.state.window;
  const opened = () => T.opened.at(-1);
  const picked = () =>
    caseLog()
      .filter((l) => l.event === "harness_picked")
      .at(-1);
  const startHere = (agent = "") => (T.route = () => [{ name: "start_session", project: "tideline", newProject: false, sessionName: "", prompt: "", agent }]);
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.tmux = { panes: [], procs: [], paneIds: true, global: {} };
  ui.act({ type: "set", key: "voiceCan", value: "everything" });
  ui.act({ type: "set", key: "newSessionAgent", value: "last-used" });
  claudeCodeSetup.connect!();
  codexSetup.connect!();
  try {
    begin('New sessions: by voice, never asked; the last used starts, and which is said ("Starting a Codex session in tideline.")');
    rememberLastAgent("codex");
    startHere();
    let count = T.opened.length;
    await talk("start a session in tideline");
    await until(() => T.opened.length > count, 3000, "a session opened");
    assert.match(
      opened().command,
      /unset TMUX TMUX_PANE; codex -c check_for_update_on_startup=false (?:-c \S+ )?-a on-request -s workspace-write; program_status=\$\?; export TMUX=/,
      "Codex, the last used",
    );
    assert.equal(opened().cwd, TIDELINE);
    await until(() => spoke("Starting a Codex session in tideline."), 3000, "which agent said");
    assert.deepEqual([picked().agent, picked().how, picked().why, picked().offered], ["codex", "voice", "last used", ["claude-code", "codex"]]);
    // The last used Claude Code: Claude Code, named too (Codex could have been it).
    rememberLastAgent("claude-code");
    await wait(1700);
    count = T.opened.length;
    await talk("start a session in tideline");
    await until(() => T.opened.length > count, 3000, "another opened");
    assert.match(opened().command, /unset TMUX TMUX_PANE; claude --permission-mode acceptEdits; program_status=\$\?; export TMUX=/);
    await until(() => spoke("Starting a Claude Code session in tideline."), 3000, "Claude Code said");
    console.log("ok: the last used, said");

    begin("New sessions: `kiko codex` ran: voice and the window preselect Codex for the run, over the last used");
    T.tmux.global = { "@kiko-new-agent": "codex" };
    await wait(1700);
    count = T.opened.length;
    await talk("start a session in tideline");
    await until(() => T.opened.length > count, 3000, "opened");
    assert.match(opened().command, /; codex -c check_for_update_on_startup=false (?:-c \S+ )?-a on-request -s workspace-write; /);
    await until(() => spoke("Starting a Codex session in tideline."), 3000, "Codex said");
    assert.equal(picked().why, "run");
    // The window: the folder picked (c, then tideline), then the agent asked; nothing opens before the answer.
    rememberLastAgent("claude-code");
    ui.set({ window: { shown: null, note: "" } });
    await wait(300);
    const saidBefore = caseSaid().length;
    count = T.opened.length;
    ui.act({ type: "start", pick: { project: TIDELINE } });
    await until(() => Boolean(ui.state.window?.agentAsk), 3000, "the picker");
    const ask = ui.state.window!.agentAsk!;
    assert.equal(ask.folder, "tideline");
    // Each row with its harness's mark, as the list draws it (ui/marks.ts).
    assert.deepEqual(ask.rows, [
      { id: "claude-code", name: "Claude Code", mark: { glyph: "✻", color: "#D77757" } },
      { id: "codex", name: "Codex", mark: { glyph: "⌬", color: "#63A8F8" }, note: "this run" },
    ]);
    assert.equal(ask.selected, "codex", "Codex preselected");
    await wait(200);
    assert.equal(T.opened.length, count, "nothing opened yet");
    // Enter: the preselected one (the popup's answer, as the glue hands it on).
    ui.act({ type: "pickAgent", ask: ask.ask, agent: ask.selected });
    await until(() => T.opened.length > count, 3000, "opened from the picker");
    assert.match(opened().command, /; codex -c check_for_update_on_startup=false (?:-c \S+ )?-a on-request -s workspace-write; /);
    assert.equal(ui.state.window!.agentAsk, null, "the picker gone");
    assert.deepEqual([picked().agent, picked().how, picked().by], ["codex", "picker", "window"]);
    assert.equal(
      caseLog()
        .filter((l) => l.event === "session_open")
        .at(-1).by,
      "window",
    );
    assert.equal(loadSettings().lastNewSessionAgent, "codex", "the last used now");
    await wait(300);
    assert.equal(caseSaid().length, saidBefore, "nothing said: it was picked, not asked for by voice");
    // An answer to that ask again (a second Enter) does nothing.
    count = T.opened.length;
    ui.act({ type: "pickAgent", ask: ask.ask, agent: "claude-code" });
    await wait(200);
    assert.equal(T.opened.length, count);
    // Asked again, ↓ to Claude Code: that one. Then Esc: nothing.
    ui.act({ type: "start", pick: { project: TIDELINE } });
    await until(() => Boolean(ui.state.window?.agentAsk), 3000, "the picker again");
    ui.act({ type: "pickAgent", ask: ui.state.window!.agentAsk!.ask, agent: "claude-code" });
    await until(() => T.opened.length > count, 3000, "Claude Code from the picker");
    assert.match(opened().command, /; claude --permission-mode acceptEdits; /);
    count = T.opened.length;
    ui.act({ type: "start", pick: { project: TIDELINE } });
    await until(() => Boolean(ui.state.window?.agentAsk), 3000, "the picker once more");
    ui.act({ type: "pickAgent", ask: ui.state.window!.agentAsk!.ask, agent: null });
    await wait(300);
    assert.equal(T.opened.length, count, "Esc: nothing opened");
    assert.equal(ui.state.window!.agentAsk, null);
    assert.ok(caseLog().some((l) => l.event === "harness_picker_cancelled"));
    console.log("ok: preselected for the run; the picker starts what it picks, Esc nothing");

    begin('New sessions: a named agent wins over the run\'s ("start a Claude session in tideline")');
    ui.set({ window: windowBefore });
    await wait(1700);
    startHere("claude-code");
    count = T.opened.length;
    await talk("start a Claude session in tideline");
    await until(() => T.opened.length > count, 3000, "opened");
    assert.match(opened().command, /; claude --permission-mode acceptEdits; /);
    await until(() => spoke("Starting a Claude Code session in tideline."), 3000, "said");
    assert.equal(picked().how, "named");
    console.log("ok: named wins");

    begin("New sessions from the phone (its New session sheet): the picker's projects and agents; typed, said (written down, never routed) or none; why not, in the Mac's words");
    await wait(1700);
    T.tmux.global = {};
    rememberLastAgent("codex");
    const phoneEvents = (name: string) => caseLog().filter((l) => l.event === name);
    ui.act({ type: "set", key: "phone" as any, value: true });
    await until(() => phoneEvents("phone_on").length > 0, 3000, "the phone server on");
    phoneServer.port = phoneEvents("phone_on").at(-1).port;
    ui.act({ type: "settings" });
    await until(() => /^\d{6}/.test(String(ui.state.settings.find((r: any) => r.key === "phonePairing")?.value)), 3000, "a pairing code");
    const code = String(ui.state.settings.find((r: any) => r.key === "phonePairing")!.raw);
    ui.act({ type: "closeSettings" });
    const p = new Phone();
    await p.send({ type: "pair", code, device: "Sheet iPhone", appVersion: "0.2.0" });
    assert.equal((await p.next("welcome")).newSession, true, "this Mac starts sessions for the phone");
    const status = (requestId: string, from = 0) => p.next("new_session_status", (m) => m.requestId === requestId && m.stage !== "heard", from, 5000);
    // What the window's picker offers: its projects, where a new one goes, the agents its question asks about, the last used preselected.
    await p.send({ type: "get_new_session_options" });
    const options = await p.next("new_session_options");
    assert.ok(
      options.projects.some((x: any) => x.folder === TIDELINE && x.name === "tideline"),
      JSON.stringify(options.projects),
    );
    assert.ok(options.root.endsWith("/projects-root"), options.root);
    assert.deepEqual(options.harnesses.slice(0, 2), [
      { id: "claude-code", name: "Claude Code", canName: true },
      { id: "codex", name: "Codex", canName: true },
    ]);
    // T3 Code, open from the T3 cases' fake: offered after them, only in its own projects (as the window's question does).
    assert.ok(
      options.harnesses.slice(2).every((h: any) => h.id === "t3code" && Array.isArray(h.folders)),
      JSON.stringify(options.harnesses),
    );
    assert.deepEqual([options.selected, options.why], ["codex", "last used"]);

    // Typed: in the agent picked, the words on its command line, as the window's picker would; shown, not said.
    const phoneSaidBefore = caseSaid().length;
    count = T.opened.length;
    await p.send({ type: "new_session", requestId: "n1", folder: TIDELINE, harness: "claude-code", text: "Look at the readme." });
    const typed = await status("n1");
    assert.equal(typed.stage, "started", JSON.stringify(typed));
    assert.equal(T.opened.length, count + 1);
    assert.match(opened().command, /; claude --permission-mode acceptEdits 'Look at the readme\.'; /);
    assert.equal(opened().cwd, TIDELINE);
    assert.match(typed.sessionId, /^starting-/);
    // The sessions this case opened in tideline before are still starting there: this one is numbered after them (core/session-numbers.ts).
    assert.match(typed.name, /^tideline(?: \d+)?$/);
    assert.deepEqual([typed.text, typed.message], ["Look at the readme.", "Starting a Claude Code session in tideline."]);
    assert.deepEqual([picked().agent, picked().how, picked().by], ["claude-code", "picker", "phone"]);
    assert.equal(
      caseLog()
        .filter((l) => l.event === "session_open")
        .at(-1).by,
      "phone",
    );
    await p.next("sessions", (m) => m.sessions.some((s: any) => s.id === typed.sessionId), 0, 3000);
    await wait(300);
    assert.equal(caseSaid().length, phoneSaidBefore, "nothing said: it was picked on the phone");
    // Its prompt hook, as it takes the words in under its real ID: typed on the phone, so no note.
    assert.equal(T.hooks.dictated("started-n1", "Look at the readme."), false, "typed: not dictated");

    // Said: a dictated press holds the floor and is heard as any press, but its words are the new
    // session's first message, even ones that sound like a command: nothing routes them.
    let routed = false;
    T.route = () => ((routed = true), []);
    const utterance = T.utterance;
    T.utterance = () => ((routed = true), utterance());
    T.heard = "start a session in pixie and fix the login";
    count = T.opened.length;
    let from = p.got.length;
    await p.send({ type: "talk_start", talkId: "dict-1", dictate: true });
    await until(() => ui.state.listening, 2000, "the phone holding the floor");
    await p.send({ type: "talk_audio", data: Buffer.alloc(3200, 0x40).toString("base64") });
    // As the app does: new_session as the button goes up, then talk_end.
    await p.send({ type: "new_session", requestId: "n2", scratch: true, harness: "codex", talkId: "dict-1" });
    await p.send({ type: "talk_end" });
    const heard = await p.next("new_session_status", (m) => m.requestId === "n2" && m.stage === "heard", from, 5000);
    assert.equal(heard.text, "start a session in pixie and fix the login");
    const spoken = await status("n2", from);
    assert.equal(spoken.stage, "started", JSON.stringify(spoken));
    assert.equal(T.opened.length, count + 1, "one session, in the scratch folder: not one in pixie as well");
    assert.match(opened().command, /codex -c check_for_update_on_startup=false (?:-c \S+ )?-a on-request -s workspace-write 'start a session in pixie and fix the login'/);
    assert.ok(opened().cwd.startsWith(`${SCRATCH}/`), opened().cwd);
    assert.equal(spoken.text, "start a session in pixie and fix the login");
    assert.equal(routed, false, "never routed");
    assert.ok(!caseLines().some((l) => l.kind === "you" && l.text.includes("fix the login")), "not your words to Kiko");
    assert.equal(phoneEvents("phone_talk").at(-1).dictated, true);
    assert.equal(p.got.slice(from).filter((m) => m.type === "talk_status").length, 0, "no talk of its own");
    // Its first message was said, on its command line: its prompt hook, under the real ID no
    // listing has shown yet, is told so (app/starting.ts agentDictated), once.
    assert.equal(T.hooks.dictated("started-n2", "start a session in pixie and fix the login"), true, "said: dictated");
    assert.equal(T.hooks.dictated("started-n2", "start a session in pixie and fix the login"), false, "once");
    T.utterance = utterance;
    T.route = () => [];

    // None: just opened, in a new project made for it.
    count = T.opened.length;
    await p.send({ type: "new_session", requestId: "n3", newProject: "Comet", harness: "claude-code" });
    const bare = await status("n3");
    assert.equal(bare.stage, "started", JSON.stringify(bare));
    assert.equal(opened().cwd, `${PROJECTS_ROOT}/comet`);
    assert.match(opened().command, /; claude --permission-mode acceptEdits; /);
    assert.equal("text" in bare, false);
    assert.equal(bare.message, "Making comet in projects-root and starting a Claude Code session there.");

    // Why not, in the Mac's words, and nothing opens.
    count = T.opened.length;
    from = p.got.length;
    await p.send({ type: "new_session", requestId: "n4", folder: "/nowhere/at-all", harness: "claude-code" });
    await p.send({ type: "new_session", requestId: "n5", folder: TIDELINE, harness: "opencode" });
    await p.send({ type: "new_session", requestId: "n6", scratch: true, talkId: "never-pressed" });
    assert.deepEqual(
      [(await status("n4", from)).message, (await status("n5", from)).message, (await status("n6", from)).message],
      [
        "That folder isn't one of your projects any more.",
        "OpenCode isn't connected. Connect it in Kiko's settings, under Agents.",
        "Nothing of what you said reached the Mac. Say it again, or type it.",
      ],
    );
    assert.equal(T.opened.length, count);
    // Forgotten, so the cases after pair one of their own (a code shows at once only with no phone paired).
    const sheetPhone = (await p.next("paired")).phoneId;
    ui.act({ type: "settings" });
    ui.act({ type: "set", key: "phones" as any, value: `forget:${sheetPhone}` });
    ui.act({ type: "closeSettings" });
    await until(() => p.closed, 3000, "the forgotten phone let go");
    ui.act({ type: "set", key: "phone" as any, value: false });
    await until(() => phoneEvents("phone_off").length > 0, 3000, "the phone server off");
    console.log("ok: started from the phone: typed, said and bare; refused in words");

    begin("New sessions: Codex disconnected, Claude Code alone: no picker, no question, the words as they always were");
    codexSetup.disconnect!();
    // Installed still (its home is there), only not connected: not enabled, so not offered.
    assert.equal(codexSetup.status().state, "not connected");
    rememberLastAgent("codex");
    await wait(1700);
    startHere();
    count = T.opened.length;
    await talk("start a session in tideline");
    await until(() => T.opened.length > count, 3000, "opened");
    assert.match(opened().command, /; claude --permission-mode acceptEdits; /);
    await until(() => spoke("Opening tideline."), 3000, "said as ever");
    assert.deepEqual([picked().how, picked().offered], ["only", ["claude-code"]]);
    ui.set({ window: { shown: null, note: "" } });
    count = T.opened.length;
    ui.act({ type: "start", pick: { project: TIDELINE } });
    await until(() => T.opened.length > count, 3000, "opened from the window at once");
    assert.ok(!ui.state.window?.agentAsk, "no picker");
    assert.match(opened().command, /; claude --permission-mode acceptEdits; /);
    console.log("ok: one agent, nothing asked or said differently");
    ui.set({ window: windowBefore });
    // The sessions opened here (Codex's as Codex's) start, so later cases don't find them.
    await startOpened();
  } finally {
    claudeCodeSetup.disconnect!();
    codexSetup.disconnect!();
    ui.set({ window: windowBefore });
    T.tmux = undefined;
  }
  T.sessions = before;
  T.route = () => [];
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
}
