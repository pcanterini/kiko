// Settings: Voice can, your dictionary, how the voice says words, the microphone, Keep logs, and the account.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  begin,
  caseLines,
  caseLog,
  caseSaid,
  CLAUDE,
  DESK,
  ghostty,
  HISTORY_FOLDER,
  info,
  lines,
  logEntries,
  logFile,
  LOGS,
  markHere,
  NOT_WAITING,
  notSent,
  OFF_LINE,
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
  VOICE_CAN_SAID,
  wait,
  windowOpen,
} from "../driver.ts";

// 7. "Voice can": replies only, replies and messages, everything (the default since 2026-11-02).
export async function voiceCanCases() {
  const setCan = (value: string) => ui.act({ type: "set", key: "voiceCan", value });
  const saved = () => JSON.parse(readFileSync("settings-test.json", "utf8")).voiceCan;
  const toTerm = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const toDesk = () => ({ audience: DESK, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const toApp = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  const undoIt = () => ({ audience: "app", audienceConfidence: 0.3, intent: "undo", intentConfidence: 0.9 });
  // `refused`: words for the desktop session, not sent (nothing types into it).
  const counts = () => ({ typed: T.typed.length, refused: notSent("desk-1").length, keys: T.keys.length, opened: T.opened.length });
  const sendsSince = (c: any) => ({
    typed: T.typed.length - c.typed,
    refused: notSent("desk-1").length - c.refused,
    keys: T.keys.length - c.keys,
    opened: T.opened.length - c.opened,
  });
  const NONE = { typed: 0, refused: 0, keys: 0, opened: 0 };
  const announceAndWait = async (s: any, entry: string) => {
    T.needs = [0.8];
    const r = stop(s, entry);
    T.hooks.onRequest(r);
    await windowOpen(s);
    return r;
  };

  begin("default is everything");
  assert.ok(
    lines.some((l) => l.text.includes("Voice can: everything.")),
    "startup line names the level",
  );
  assert.equal(ui.state.settings.length ? ui.state.settings[0].key : "voiceCan", "voiceCan");
  await wait(1700); // the last window runs out

  // ── Replies only ──
  begin("replies only: a waiting session still gets your reply");
  setCan("replies");
  assert.equal(saved(), "replies");
  const row = ui.state.settings.find((r: any) => r.key === "voiceCan")!;
  assert.equal(row.value, "Replies only");
  T.utterance = toTerm;
  let c = counts();
  let b = await announceAndWait(TERM, "cli");
  await talk("yes go ahead");
  assert.equal(b.reply, "yes go ahead");
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok: hook reply went through, nothing typed");

  begin("replies only: ask_session to the waiting session goes through its hook");
  b = await announceAndWait(TERM, "cli");
  T.utterance = toApp;
  T.route = () => [{ name: "ask_session", session: TERM, message: "Give me a short status." }];
  await talk("ask it for a status");
  // A reply to the session waiting goes as you said it, never the router's own words (decide.ts routerWordsOr).
  assert.equal(b.reply, "ask it for a status");
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok");

  begin("replies only: nothing waiting, nothing typed");
  T.utterance = toTerm;
  c = counts();
  await talk("run the tests");
  assert.ok(spoke(NOT_WAITING()));
  T.utterance = toDesk;
  await talk("what about 8 plus 8");
  assert.deepEqual(sendsSince(c), NONE);
  assert.equal(caseLines().filter((l) => l.text === NOT_WAITING()).length, 2);
  assert.ok(info("(voice can: replies only)"));
  console.log(
    "ok: terminal and desktop both refused;",
    caseLines()
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("replies only: another session waiting: that one keeps waiting");
  const a = await announceAndWait(DESK, "claude-desktop");
  // Named: with another session waiting, words that don't name atlas agents would be the waiting one's reply.
  T.utterance = toTerm;
  await talk("run the tests in atlas agents");
  assert.ok(spoke(NOT_WAITING("atlas agents")));
  assert.ok(a.open, "the waiting one wasn't let go");
  T.utterance = toApp;
  T.route = () => [{ name: "pass_on", session: TERM }];
  await talk("for atlas agents, lint it");
  assert.equal(caseLines().filter((l) => l.text === NOT_WAITING("atlas agents")).length, 2);
  assert.ok(a.open);
  T.utterance = toDesk;
  await talk("now 9 plus 9");
  assert.equal(a.reply, "now 9 plus 9");
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok: refused by name, waiting one kept and then answered");

  begin("replies only: start, stop and rename are off, said with where to turn them on and the offer to");
  T.utterance = toApp;
  for (const [action, said, line] of [
    [{ name: "stop_session", session: TERM }, "stop atlas agents", OFF_LINE("Stopping sessions")],
    [{ name: "rename_session", session: TERM, newName: "migrations" }, "rename atlas agents to migrations", OFF_LINE("Renaming sessions")],
    [{ name: "start_session", project: "pixie", newProject: false, sessionName: "", prompt: "Look at the readme." }, "start a session in pixie to look at the readme", OFF_LINE("Starting sessions")],
  ] as const) {
    T.route = () => [action];
    await talk(said);
    assert.ok(spoke(line), line);
  }
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok");

  begin("replies only: never mind lets go, doesn't press Escape");
  b = await announceAndWait(TERM, "cli");
  T.utterance = toTerm;
  await talk("fix the flaky test");
  assert.equal(b.reply, "fix the flaky test");
  TERM.status = "busy";
  T.utterance = undoIt;
  await talk("wait, scratch that");
  assert.ok(spoke(`Stopping sessions by voice is off, so atlas agents will carry on with that. ${VOICE_CAN_SAID} Say turn it on, and I'll do it now.`));
  assert.deepEqual(sendsSince(c), NONE);
  TERM.status = "idle";
  console.log("ok");

  begin("replies only: the window closes without 'reply anyway'");
  T.needs = [0.8];
  const w = stop(TERM, "cli");
  T.hooks.onRequest(w);
  await until(() => !w.open, 3000);
  assert.ok(info("(no reply; the session stopped. Reply to it in its window)"));
  console.log("ok");

  // ── Replies and messages ──
  begin("messages: typing allowed, start/stop/rename off");
  setCan("messages");
  assert.equal(saved(), "messages");
  c = counts();
  T.utterance = toTerm;
  await talk("run the tests");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "run the tests" });
  T.utterance = toDesk;
  await talk("what about 10 plus 10");
  await until(() => notSent("desk-1").at(-1)?.text === "what about 10 plus 10");
  T.utterance = toApp;
  T.route = () => [{ name: "ask_session", session: DESK, message: "What's next?" }];
  await talk("ask 2 plus 2 what's next");
  await until(() => notSent("desk-1").at(-1)?.text === "What's next?");
  assert.deepEqual(sendsSince(c), { typed: 1, refused: 2, keys: 0, opened: 0 });
  c = counts();
  for (const [action, said, line] of [
    [{ name: "stop_session", session: TERM }, "stop atlas agents", OFF_LINE("Stopping sessions")],
    [{ name: "rename_session", session: TERM, newName: "migrations" }, "rename atlas agents to migrations", OFF_LINE("Renaming sessions")],
    [{ name: "start_session", project: "pixie", newProject: false, sessionName: "", prompt: "Look at the readme." }, "start a session in pixie to look at the readme", OFF_LINE("Starting sessions")],
  ] as const) {
    T.route = () => [action];
    await talk(said);
    assert.ok(spoke(line), line);
  }
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok");

  begin("messages: never mind doesn't press Escape");
  T.utterance = toTerm;
  await talk("refactor the parser");
  TERM.status = "busy";
  T.utterance = undoIt;
  c = counts();
  await talk("wait, scratch that");
  assert.ok(spoke(`Stopping sessions by voice is off, so atlas agents will carry on with that. ${VOICE_CAN_SAID} Say turn it on, and I'll do it now.`));
  assert.deepEqual(sendsSince(c), NONE);
  console.log("ok");

  begin("messages: a rename waiting for a busy session is dropped once renaming is off");
  setCan("everything");
  T.utterance = toApp;
  T.route = () => [{ name: "rename_session", session: TERM, newName: "migrations" }];
  await talk("call it migrations");
  assert.ok(spoke("atlas agents is busy, so I'll rename it to migrations when it finishes."));
  setCan("messages");
  TERM.status = "idle";
  c = counts();
  await wait(4500); // the session list refresh, which types pending renames
  assert.deepEqual(sendsSince(c), NONE);
  const dropped = readFileSync(logFile(), "utf8").includes('"event":"renames_dropped"');
  assert.ok(dropped);
  console.log("ok");

  // ── Lowered by hand, then turned on by voice (2026-11-02) ──
  begin("messages: a new session asked for: what's off, where (Settings → Control → Voice can), the offer; 'turn it on' sets Everything and starts it");
  setCan("messages");
  await wait(50);
  T.utterance = toApp;
  T.route = () => [{ name: "start_session", project: null, newProject: false, sessionName: "permission test", prompt: "", agent: "codex" }];
  c = counts();
  await talk("Open a new codex session and name it permission test.");
  assert.ok(spoke(OFF_LINE("Starting sessions")), "said what's off, where, and the offer");
  assert.ok(
    caseLines().some((l) => l.text === "(Starting sessions by voice: Settings → Control → Voice can → Everything turns it on. Say “turn it on” to allow it now.)"),
    "shown with the path",
  );
  assert.ok(caseLog().some((l) => l.event === "not_allowed" && l.action === "start" && l.carriesOut));
  assert.deepEqual(sendsSince(c), NONE);
  assert.equal(saved(), "messages");
  T.route = () => {
    throw new Error("the router isn't asked: the offer is the app's");
  };
  await talk("Turn it on.");
  await until(() => T.opened.length === c.opened + 1, 3000, "the session it stopped, started now");
  assert.equal(saved(), "everything", "saved as the settings screen saves it");
  assert.equal(ui.state.settings.find((r: any) => r.key === "voiceCan")?.value, "Everything");
  assert.ok(spoke("Done: your voice can do everything now."));
  assert.ok(caseLog().some((l) => l.event === "voice_can_raised" && l.from === "messages" && l.to === "everything" && l.carriesOut));
  assert.ok(caseLog().some((l) => l.event === "setting" && l.key === "voiceCan" && l.value === "everything"));
  assert.match(T.opened.at(-1).command, /\bcodex\b/);
  assert.equal(
    caseLog()
      .filter((l) => l.event === "session_open")
      .at(-1).name,
    "permission test",
  );
  await startOpened();
  console.log("ok: refused with the path, then turned on and started by voice");

  begin("messages: a stop asked for, the offer declined: nothing pressed, the level as it was");
  setCan("messages");
  await wait(50);
  T.route = () => [{ name: "stop_session", session: TERM }];
  c = counts();
  await talk("stop atlas agents");
  assert.ok(spoke(OFF_LINE("Stopping sessions")));
  T.route = () => {
    throw new Error("the router isn't asked");
  };
  await talk("No.");
  assert.deepEqual(sendsSince(c), NONE);
  assert.equal(saved(), "messages");
  console.log("ok");

  begin("messages: the router saying it's off itself: the app's line instead");
  T.route = () => [];
  T.routeText = "Starting sessions is off in settings.";
  await talk("open a new session in pixie");
  // Nothing kept to do once it's on (the router called no tool): "to allow it now", then "say it again".
  assert.ok(spoke(`Starting sessions by voice is off. ${VOICE_CAN_SAID} Say turn it on to allow it now.`));
  assert.ok(!spoke("Starting sessions is off in settings."));
  T.routeText = undefined;
  await talk("Yes.");
  assert.ok(spoke("Done: your voice can do everything now. Say it again."), "turned on; nothing kept to do, so: say it again");
  assert.equal(saved(), "everything");
  setCan("messages");
  console.log("ok");

  // ── Everything ──
  begin("everything: as before");
  setCan("everything");
  assert.equal(saved(), "everything");
  c = counts();
  T.utterance = toApp;
  T.route = () => [{ name: "stop_session", session: TERM }];
  await talk("stop atlas agents");
  assert.deepEqual(T.keys.at(-1), { terminalId: "ghostty-1", key: "escape" });
  assert.ok(spoke("Interrupted atlas agents's current turn. Anything it started in the background keeps running."));
  T.route = () => [{ name: "rename_session", session: TERM, newName: "migrations" }];
  await talk("call it migrations");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "/rename migrations" });
  T.route = () => [{ name: "start_session", project: null, newProject: false, sessionName: "", prompt: "Look at the readme." }];
  await talk("start a new session to look at the readme");
  assert.equal(T.opened.at(-1).command, `${CLAUDE} 'Look at the readme.'`);
  assert.ok(spoke("Opening a new session in a scratch folder."));
  T.utterance = toTerm;
  await talk("fix the build");
  TERM.status = "busy";
  T.utterance = undoIt;
  await talk("wait, scratch that");
  assert.equal(T.keys.at(-1).key, "escape");
  TERM.status = "idle";
  assert.deepEqual(sendsSince(c), { typed: 2, refused: 0, keys: 2, opened: 1 });
  console.log("ok: stop, rename, start and undo's Escape all work");

  // The extra-session bug: a request for a new session in Pixie
  // opened the app's own folder with the request typed in, which then opened Pixie. Now: one window,
  // in pixie (the projects root's), with nothing typed.
  begin("everything: a new session opens in its project, once, nothing typed");
  T.utterance = toApp;
  const start = (ask: object) => () => [{ name: "start_session", project: null, newProject: false, sessionName: "", prompt: "", ...ask }];
  const opens = () => caseLog().filter((l) => l.event === "session_open");
  c = counts();
  T.route = start({ project: "Pixie" });
  await talk("open a new session in Pixie");
  assert.deepEqual(sendsSince(c), { typed: 0, refused: 0, keys: 0, opened: 1 });
  assert.deepEqual(T.opened.at(-1), { cwd: `${PROJECTS_ROOT}/pixie`, command: CLAUDE });
  assert.ok(![...T.opened, ...T.typed].some((x: any) => /open a new session/i.test(x.command ?? x.text)), "the request isn't typed anywhere");
  assert.ok(spoke("Opening Pixie."));
  assert.deepEqual(
    opens().map((l) => [l.folder, l.how, l.said, l.name, l.prompt]),
    [[`${PROJECTS_ROOT}/pixie`, "exact", "Pixie", null, false]],
  );
  // Close, with a first message: still one window, the message on its command line.
  T.route = start({ project: "Pixy", prompt: "Fix the login bug." });
  await talk("open one in Pixy and fix the login bug");
  assert.deepEqual(T.opened.at(-1), { cwd: `${PROJECTS_ROOT}/pixie`, command: `${CLAUDE} 'Fix the login bug.'` });
  assert.ok(spoke("Opening pixie, the closest to Pixy."));
  // Named, from Claude Code's history (the fake ~/.claude/projects): the folder its sessions there were given that name in.
  T.route = start({ sessionName: "Clipkit" });
  await talk("open a new session named Clipkit");
  assert.deepEqual(T.opened.at(-1), { cwd: HISTORY_FOLDER, command: `${CLAUDE} '--name' 'Clipkit'` });
  assert.ok(spoke("Opening Clipkit."));
  assert.deepEqual(sendsSince(c), { typed: 0, refused: 0, keys: 0, opened: 3 });
  console.log("ok: pixie exactly, Pixy closely, Clipkit by its name in the history; one window each, nothing typed");

  // A request for a new session named for a project and more words came as
  // project "Kiko", name "Kiko trust test", the folder only in the prompt, and opened in ~/git/kiko.
  begin("everything: a new session named for a folder that's the project said and more opens in that folder");
  {
    mkdirSync(`${PROJECTS_ROOT}/pixie-trust-test`, { recursive: true });
    T.route = start({ project: "Pixie", sessionName: "Pixie trust test", prompt: "Work in the pixie-trust-test folder inside the projects folder, so the trust card can show up." });
    await talk("create a new session and, uh, Pixie, trust test");
    assert.equal(T.opened.at(-1).cwd, `${PROJECTS_ROOT}/pixie-trust-test`);
    assert.deepEqual(
      opens()
        .map((l) => [l.folder, l.how])
        .at(-1),
      [`${PROJECTS_ROOT}/pixie-trust-test`, "exact"],
    );
    // A session named after its work, with no folder by that name: the project said, as ever.
    T.route = start({ project: "Pixie", sessionName: "Pixie docs", prompt: "Write the docs." });
    await talk("open a session in Pixie called Pixie docs and write the docs");
    assert.equal(T.opened.at(-1).cwd, `${PROJECTS_ROOT}/pixie`);
    rmSync(`${PROJECTS_ROOT}/pixie-trust-test`, { recursive: true, force: true });
  }
  console.log("ok");

  begin("everything: an unknown project opens a fresh scratch folder");
  c = counts();
  T.route = start({ project: "Pixel" });
  await talk("open a new session in Pixel");
  const scratch = T.opened.at(-1);
  assert.match(scratch.cwd, new RegExp(`^${SCRATCH}/\\d{4}-\\d{2}-\\d{2}-pixel$`));
  assert.ok(existsSync(scratch.cwd), "made");
  assert.equal(scratch.command, CLAUDE);
  assert.ok(spoke("I don't know Pixel, so I'm opening it in a scratch folder."));
  // The same again: a folder of its own.
  await talk("open a new session in Pixel");
  assert.equal(T.opened.at(-1).cwd, `${scratch.cwd}-2`);
  // A new project: made in the projects root.
  T.route = start({ project: "Pixel", newProject: true });
  await talk("make a new project called Pixel");
  assert.deepEqual(T.opened.at(-1), { cwd: `${PROJECTS_ROOT}/pixel`, command: CLAUDE });
  assert.ok(existsSync(`${PROJECTS_ROOT}/pixel`));
  assert.ok(spoke("Making pixel in projects-root and opening it."));
  assert.deepEqual(sendsSince(c), { typed: 0, refused: 0, keys: 0, opened: 3 });
  assert.deepEqual(
    opens().map((l) => l.how),
    ["scratch", "scratch", "new"],
  );
  console.log("ok");

  // A new session waits at Claude Code's trust prompt before it starts:
  // listed as starting meanwhile, by the name it was given, its words held and
  // typed once it has started; past the wait it needs you, said once; one that ends first says what
  // became of the words held for it.
  begin("everything: a session still starting: listed, named in the conversation, its words held until it starts");
  {
    const starting = () => ui.state.sessions.find((s: any) => s.givenName === "Dozer" && s.sessionId.startsWith("starting-"));
    T.route = start({ sessionName: "Dozer" });
    await talk("open a new session called Dozer");
    const cwd = T.opened.at(-1).cwd;
    assert.match(cwd, new RegExp(`^${SCRATCH}/\\d{4}-\\d{2}-\\d{2}-dozer$`));
    await until(() => Boolean(starting()));
    assert.equal(starting()!.status, "starting");
    assert.equal(opens().at(-1).startingId, starting()!.sessionId);
    // The router is told its name, and that it's still starting.
    let seen: any = null;
    T.route = (input: any) => {
      seen = input;
      const dozer = input.sessions.find((s: any) => s.givenName === "Dozer");
      return [{ name: "ask_session", session: dozer, message: "What is the capital of Germany?" }];
    };
    const typed = T.typed.length;
    await talk("what's the capital of Germany? ask the new one");
    assert.ok(
      seen.recent.some((l: string) => l.includes("opened a session named Dozer in ")),
      seen.recent.join("\n"),
    );
    assert.ok(seen.sessions.some((s: any) => s.givenName === "Dozer" && s.status === "starting"));
    await until(() => caseLog().some((l) => l.event === "held_for_start"));
    await until(() => spoke("Dozer is still starting. I'll pass that on once it's ready."));
    assert.equal(T.typed.length, typed, "nothing typed while it starts");
    // It starts (its folder trusted): listed by its agent, matched by its folder, and the words go in.
    const DOZER = { ...TERM, sessionId: "dozer-1", name: "Dozer", givenName: "Dozer", cwd, place: ghostty("ghostty-dozer") };
    T.sessions = [...T.sessions, DOZER];
    T.hooks.onSessionsChanged();
    await until(() => caseLog().some((l) => l.event === "session_ready" && l.sessionId === "dozer-1"), 5000, "Dozer to start (session_ready)");
    await until(() => T.typed.some((t: any) => t.terminalId === "ghostty-dozer"), 5000, "Dozer's held words to be typed");
    assert.equal(T.typed.find((t: any) => t.terminalId === "ghostty-dozer").text, "What is the capital of Germany?");
    const ready = caseLog().find((l) => l.event === "session_ready");
    assert.deepEqual([ready.sessionId, ready.by, ready.held], ["dozer-1", "folder", 1]);
    await until(() => !starting());
    T.sessions = T.sessions.filter((s: any) => s !== DOZER);
  }
  console.log("ok");

  begin("everything: a session that hasn't started after the wait needs you, said once; words for it then say so, and go in once it starts");
  {
    process.env.KIKO_STARTING_WAIT_MS = "300";
    T.route = start({ sessionName: "Rex" });
    await talk("open a new session called Rex");
    const rex = () => ui.state.sessions.find((s: any) => s.givenName === "Rex" && s.sessionId.startsWith("starting-"));
    await until(() => Boolean(rex()));
    // Shown as needing you as it becomes so, not at the next look at the sessions (every 4 seconds):
    // the case was flaky (2026-10-29) while it waited for that look, which could come after its wait.
    await until(() => caseLog().some((l) => l.event === "session_needs_you" && l.name === "Rex"), 2000, "Rex past the wait (session_needs_you)");
    await until(() => rex()?.status === "blocked", 300, "Rex shown as needing you at once");
    await until(() => spoke("Rex is waiting for you in its window, probably asking whether to trust its folder."), 2000);
    assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text.startsWith("Rex is waiting")).length, 1, "said once");
    T.route = (input: any) => [{ name: "pass_on", session: input.sessions.find((s: any) => s.givenName === "Rex") }];
    await talk("Rex, list the files");
    await until(() => spoke("Rex is waiting for you in its window, probably asking whether to trust its folder. I'll pass that on once it starts."));
    process.env.KIKO_STARTING_WAIT_MS = "600000";
    const rexId = rex()!.sessionId;
    const REX = { ...TERM, sessionId: "rex-1", name: "Rex", givenName: "Rex", cwd: T.opened.at(-1).cwd, place: ghostty("ghostty-rex") };
    T.sessions = [...T.sessions, REX];
    T.hooks.onSessionsChanged();
    // It starts (session_ready), then what was held goes in a second later (READY_AFTER_MS).
    await until(() => caseLog().some((l) => l.event === "session_ready" && l.startingId === rexId), 5000, "Rex to start (session_ready)");
    await until(() => T.typed.some((t: any) => t.terminalId === "ghostty-rex" && /list the files/i.test(t.text)), 5000, "Rex's held words to be typed");
    await until(() => !rex(), 5000, "Rex to leave the list as starting");
    T.sessions = T.sessions.filter((s: any) => s !== REX);
  }
  console.log("ok");

  // Every new scratch folder asks Claude Code to trust it, unless the scratch folder itself is trusted.
  // Kiko reads only that answer from Claude Code's config (here a fixture), never writes it: it says
  // so once, and "trust the scratch folder" opens Claude Code there to answer once, then /exit.
  begin('everything: the scratch folder not trusted: said once; "trust the scratch folder" opens Claude Code there, then /exit, then what waited');
  {
    const claudeJson = (trusted: boolean) => writeFileSync("claude.json", JSON.stringify({ primaryApiKey: "not-read", projects: trusted ? { [SCRATCH]: { hasTrustDialogAccepted: true } } : {} }));
    claudeJson(false);
    // "… or press Control-Space then t." with the Kiko window, "… or run kiko trust-scratch." without.
    const HINT = 'New scratch sessions will each ask Claude Code to trust their folder. To trust Kiko\'s scratch area once, say "trust the scratch folder" or ';
    const hints = () => caseLines().filter((l) => l.kind === "voice" && l.text.startsWith(HINT));
    T.route = start({ sessionName: "Max" });
    await talk("open a new session called Max");
    await until(() => hints().length > 0);
    assert.equal(caseLog().filter((l) => l.event === "scratch_untrusted").length, 1);
    T.route = start({ sessionName: "Lux" });
    await talk("open a new session called Lux");
    await until(() => spoke("Opening Lux in a scratch folder."));
    assert.equal(hints().length, 1, "said once");
    // The trust step: decided in code, Claude Code opened in the scratch folder itself.
    const opened = T.opened.length;
    await talk("trust the scratch folder");
    await until(() => T.opened.length > opened);
    assert.deepEqual(T.opened.at(-1), { cwd: SCRATCH, command: "claude" });
    await until(() => caseLines().some((l) => l.kind === "voice" && l.text.startsWith("Opening Claude Code in Kiko's scratch folder.")));
    assert.ok(!ui.state.sessions.some((s: any) => s.cwd === SCRATCH), "not listed: it's not a session to work in");
    // A scratch session asked for meanwhile waits for it.
    T.route = start({ sessionName: "Pax" });
    await talk("open a new session called Pax");
    await until(() => spoke("I'll open it once the scratch folder is trusted: answer Claude Code's question in its window."));
    assert.equal(T.opened.length, opened + 1, "not opened yet");
    // "Yes, I trust this folder": Claude Code records it and starts.
    claudeJson(true);
    const TRUSTING = { ...TERM, sessionId: "trust-1", name: "scratch", cwd: SCRATCH, place: ghostty("ghostty-trust") };
    T.sessions = [...T.sessions, TRUSTING];
    T.hooks.onSessionsChanged();
    await until(() => T.typed.some((t: any) => t.terminalId === "ghostty-trust" && t.text === "/exit"), 4000);
    await until(() => spoke("Kiko's scratch folder is trusted now: new scratch sessions won't ask."));
    await until(() => T.opened.length > opened + 1);
    assert.match(T.opened.at(-1).cwd, /-pax$/);
    T.sessions = T.sessions.filter((s: any) => s !== TRUSTING);
    // Trusted now: asked again, it says so and opens nothing.
    await talk("trust the scratch folder");
    await until(() => spoke("Kiko's scratch folder is trusted already: new scratch sessions won't ask."));
    assert.equal(T.opened.length, opened + 2);
    rmSync("claude.json", { force: true });
  }
  console.log("ok");
  setCan("messages");
}

// 13. Your dictionary (dictionary.ts): none on start (the built-in words apply all the same), applied right after speech-to-text (before
//     the shortcuts, the classifier, the router and the clean-up), logged next to the words as heard; "add to
//     dictionary" by voice at "everything" only; the settings screen's edits; hand edits apply
//     without a restart; the speech hints follow it.
export async function dictionaryCases() {
  await wait(2100); // windows and the session list cache run out
  const SNIP = { ...TERM, sessionId: "snip-d", name: "clipkit", cwd: "/nonexistent/clipkit", place: ghostty("ghostty-snip") };
  const before = T.sessions;
  T.sessions = [DESK, TERM, SNIP];
  await wait(2100);
  const logged = (event: string) =>
    readFileSync(logFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === event);
  const file = () => JSON.parse(readFileSync("dictionary.json", "utf8"));
  const info = (text: string) => caseLines().some((l) => l.kind === "info" && l.text === text);
  const setCan = (value: string) => ui.act({ type: "set", key: "voiceCan", value });

  begin("dictionary: none written on start; the app's name and the agents go to speech-to-text as hints");
  assert.equal(existsSync("dictionary.json"), false, "a new install's dictionary is empty: no file");
  assert.ok(T.hints.includes("Claude Code") && T.hints.includes("Codex"), T.hints.join(", "));
  assert.ok(!T.hints.some((h: string) => ["claude", "jev", "ghostty"].includes(h.toLowerCase())), T.hints.join(", "));
  console.log("ok: hints", T.hints.join(", "));
  // A word of the user's own, written by hand: read at its next use.
  writeFileSync("dictionary.json", JSON.stringify({ "clip kit": "clipkit" }, null, 2));

  begin("dictionary: 'tell clip kit to …' fixed first, so it names clipkit (no classifier, no router)");
  let classifierAsked = 0;
  T.utterance = () => (classifierAsked++, { audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  T.route = () => {
    throw new Error("the router isn't asked");
  };
  await talk("Tell clip kit to run the tests.");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: "Run the tests." });
  assert.equal(classifierAsked, 0);
  assert.ok(
    caseLines().some((l) => l.kind === "you" && l.text === "Tell clipkit to run the tests."),
    "the conversation shows the fixed words",
  );
  assert.ok(info("(dictionary: clip kit → clipkit)"));
  assert.equal(logged("transcript").at(-1).text, "Tell clip kit to run the tests.", "the transcript as heard");
  const e = logged("dictionary").at(-1);
  assert.deepEqual([e.heard, e.text, e.replaced], ["Tell clip kit to run the tests.", "Tell clipkit to run the tests.", [{ heard: "clip kit", write: "clipkit" }]]);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("dictionary: the classifier and the clean-up get the fixed words");
  let classifierText = "";
  let cleanText = "";
  T.utterance = (input: any) => ((classifierText = input.text), { audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  T.clean = (t: string) => ((cleanText = t), t.replace(/\buh,?\s*/gi, ""));
  await talk("uh, restart ghosty when cloud code is done");
  assert.equal(classifierText, "uh, restart Ghostty when Claude Code is done");
  assert.equal(cleanText, "uh, restart Ghostty when Claude Code is done");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "restart Ghostty when Claude Code is done" });
  T.clean = undefined;
  console.log("ok");

  begin("dictionary: 'cloud' alone, and words with nothing to fix, are as said; nothing logged");
  const n = logged("dictionary").length;
  await talk("is the cloud build done");
  assert.equal(T.typed.at(-1).text, "is the cloud build done");
  assert.equal(logged("dictionary").length, n);
  console.log("ok");

  begin("dictionary: 'add to dictionary' by voice at everything: the words go to the router as said");
  setCan("everything");
  let routedText = "";
  T.utterance = () => {
    throw new Error("the classifier isn't asked");
  };
  T.route = (input: any) => ((routedText = input.text), [{ name: "add_to_dictionary", heard: "clip kit", write: "ClipKit" }]);
  await talk("Add to dictionary: clip kit means ClipKit.");
  assert.equal(routedText, "Add to dictionary: clip kit means ClipKit.", "not fixed: the word being added survives");
  assert.equal(file()["clip kit"], "ClipKit");
  assert.ok(
    spoke("Added: clip kit becomes ClipKit, C-L-I-P-K-I-T."),
    caseLines()
      .map((l) => l.text)
      .join(" | "),
  );
  assert.ok(T.hints.includes("ClipKit"), "hints follow");
  assert.deepEqual(logged("dictionary_edit").at(-1), { ...logged("dictionary_edit").at(-1), op: "add", heard: "clip kit", write: "ClipKit", before: "clipkit", by: "voice" });
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("dictionary: remove by voice");
  T.route = () => [{ name: "remove_from_dictionary", heard: "clip kit" }];
  await talk("Remove clip kit from the dictionary.");
  assert.equal(file()["clip kit"], undefined);
  assert.ok(spoke("Removed clip kit from the dictionary."));
  T.route = () => [{ name: "remove_from_dictionary", heard: "jab" }];
  await talk("Remove jab from the dictionary.");
  assert.ok(spoke("jab isn't in the dictionary."));
  // A built-in one: kept, and how to outdo it.
  T.route = () => [{ name: "remove_from_dictionary", heard: "ghosty" }];
  await talk("Remove ghosty from the dictionary.");
  assert.ok(spoke("ghosty is built in. To keep it as you say it, add it: ghosty means ghosty."));
  console.log("ok");

  begin("dictionary: below everything, the voice can't change it");
  setCan("messages");
  const was = JSON.stringify(file());
  T.route = () => [{ name: "add_to_dictionary", heard: "jab", write: "Jev" }];
  await talk("Add to dictionary: jab means Jev.");
  assert.ok(spoke(OFF_LINE("Changing the dictionary")));
  assert.equal(JSON.stringify(file()), was);
  console.log("ok");

  begin("dictionary: the settings screen lists, adds and removes");
  ui.act({ type: "settings" });
  const row = () => ui.state.settings.find((r: any) => r.key === "dictionary")!;
  const count = Object.keys(file()).length;
  const words = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;
  assert.equal(row().value, words(count));
  ui.act({ type: "dictionary", op: "add", heard: "gee pee tee", write: "GPT" });
  await until(() => file()["gee pee tee"] === "GPT");
  await until(() => row().value === words(count + 1));
  assert.equal(logged("dictionary_edit").at(-1).by, "settings");
  assert.equal(caseSaid().filter((x: any) => /^Added/.test(x.text)).length, 0, "the screen doesn't speak");
  ui.act({ type: "dictionary", op: "remove", heard: "gee pee tee" });
  await until(() => file()["gee pee tee"] === undefined);
  assert.equal(row().value, words(count));
  assert.equal(ui.state.settings.find((r: any) => r.key === "sttHints")!.value, "On");
  ui.act({ type: "set", key: "sttHints", value: false });
  assert.deepEqual(T.hints, [], "hints off: an empty list");
  ui.act({ type: "set", key: "sttHints", value: true });
  assert.ok(T.hints.length > 0);
  ui.act({ type: "closeSettings" });
  console.log("ok");

  begin("dictionary: an edit to the file by hand applies to the next words, no restart");
  writeFileSync("dictionary.json", JSON.stringify({ ...file(), "atlas agent": "atlas-agents" }, null, 2));
  T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  await talk("the atlas agent build is green");
  assert.equal(T.typed.at(-1).text, "the atlas-agents build is green");
  console.log("ok");

  T.sessions = before;
  T.route = () => [];
}

// 13b. How the voice says words (pronunciation.ts): respelled just before the voice (the macOS voice
//      here, KIKO_TTS=say), never on screen or in the log; "Kiko, say X as Y" and "Kiko, forget how
//      to say X" by voice, with no model asked; the settings screen's list.
export async function pronunciationCases() {
  await wait(2100); // windows and the session list cache run out
  const logged = (event: string) =>
    readFileSync(logFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === event);
  const file = () => JSON.parse(readFileSync("pronunciation.json", "utf8"));
  const heard = (text: string) => caseSaid().some((x: any) => x.text === text);
  const utterance = T.utterance;
  T.utterance = () => {
    throw new Error("the classifier isn't asked");
  };
  T.route = () => {
    throw new Error("the router isn't asked");
  };

  begin("pronunciation: 'Kiko, say nginx as engine-x' by voice, said the new way, shown as written");
  await talk("Kiko, say nginx as engine-x.");
  assert.deepEqual(file(), [{ word: "nginx", say: "engine-x", voices: ["macos"] }]);
  assert.ok(
    spoke("Okay, from now on it's nginx."),
    caseLines()
      .map((l) => l.text)
      .join(" | "),
  );
  await until(() => heard("Okay, from now on it's engine-x."));
  const added = logged("pronunciation_added").at(-1);
  assert.deepEqual([added.word, added.say, added.voice, added.by], ["nginx", "engine-x", "macos", "voice"]);
  assert.ok(!caseSaid().some((x: any) => x.text.includes("nginx")), "the voice never got the word as written");
  console.log(
    "ok:",
    caseSaid()
      .map((x: any) => x.text)
      .join(" | "),
  );

  begin("pronunciation: a new one for the voice in use; speech-to-text's 'T-Mux' is the tmux just said");
  await talk("Kiko, say tmux like tea mux.");
  await until(() => heard("Okay, from now on it's tea mux."));
  await talk("Kiko, forget how to say T-Mux.");
  assert.ok(
    spoke("Okay, back to tmux as it's written."),
    caseLines()
      .map((l) => l.text)
      .join(" | "),
  );
  await until(() => heard("Okay, back to tmux as it's written.")); // the built-in tee mux is off for this voice too
  assert.deepEqual(file().at(-1), { word: "tmux", disabled: true, voices: ["macos"] });
  assert.equal(logged("pronunciation_removed").at(-1).before, "tea mux");
  console.log(
    "ok:",
    caseSaid()
      .map((x: any) => x.text)
      .join(" | "),
  );

  begin("pronunciation: two words that aren't a word said lately: asked to spell it, nothing saved");
  const was = JSON.stringify(file());
  await talk("Kiko, say engine x as nginx.");
  assert.ok(caseLines().some((l) => l.kind === "voice" && l.text.startsWith("Which word? Spell it")));
  assert.equal(JSON.stringify(file()), was);
  assert.equal(logged("pronunciation_unclear").at(-1).heard, "engine x");
  console.log("ok");

  begin("pronunciation: without the name it's words like any others");
  let classifier = 0;
  T.utterance = () => (classifier++, { audience: TERM, audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95 });
  await talk("Say nginx as engine-x.");
  assert.equal(classifier, 1);
  assert.equal(JSON.stringify(file()), was);
  console.log("ok");

  begin("pronunciation: the settings screen counts, says one, takes yours out and turns built-in ones off");
  ui.act({ type: "settings" });
  const { DEFAULTS } = await import("../../../src/core/pronunciation.ts");
  const row = () => ui.state.settings.find((r: any) => r.key === "pronunciation")!;
  assert.equal(row().value, `2 yours · ${DEFAULTS.length} built in`);
  const zsh = DEFAULTS.findIndex((e: any) => e.word === "zsh");
  ui.act({ type: "pronunciation", op: "test", id: `built-in:${zsh}` });
  await until(() => heard("This is how I say Z shell."));
  assert.ok(spoke("This is how I say zsh."));
  ui.act({ type: "pronunciation", op: "remove", id: `built-in:${zsh}` });
  await until(() => row().value === `3 yours · ${DEFAULTS.length} built in`);
  assert.deepEqual(file().at(-1), { word: "zsh", disabled: true });
  ui.act({ type: "pronunciation", op: "remove", id: "yours:0" }); // nginx → engine-x for macOS: the built-in one is the same
  await until(() => row().value === `2 yours · ${DEFAULTS.length} built in`);
  ui.act({ type: "pronunciation", op: "add", word: "Vite", say: "veet!" });
  await until(() => file().some((e: any) => e.say === "veet!"));
  assert.equal(caseSaid().filter((x: any) => /veet|from now on/.test(x.text)).length, 0, "the screen doesn't speak an add");
  ui.act({ type: "closeSettings" });
  console.log("ok");

  rmSync("pronunciation.json", { force: true });
  T.utterance = utterance;
  T.route = () => [];
}

// The microphone (src/core/mic-device.ts, settings: Listening → Microphone): a stub helper (stubs/platform/macos/mic.ts) lists a
// USB Mic, the system default, and the built-in mic; T.setMicDevices plugs one in or out. run.sh makes the
// mic test 300ms (MIC_TEST_MS).
export async function micCases() {
  const { micHeader } = await import("../../../src/core/mic-device.ts");
  const { choicesFor } = await import("../../../src/core/settings-options.ts");
  const USB_MIC = { uid: "usb-mic", name: "USB Mic", isDefault: true };
  const BUILT_IN = { uid: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false };
  const row = (key: string) => ui.state.settings.find((r: any) => r.key === key);
  const set = (key: string, value: unknown, label?: string) => ui.act({ type: "set", key: key as any, value, label });
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  const saved = () => JSON.parse(readFileSync("settings-test.json", "utf8"));
  const header = () => micHeader(ui.state.mic);
  await wait(2100); // windows and the session list cache run out

  begin("mic: the system default by default, named in the header and the setting");
  ui.act({ type: "settings" });
  assert.deepEqual(header(), { text: "🎙 USB Mic", warn: false });
  assert.equal(row("mic")?.value, "System default (USB Mic)");
  assert.equal(row("mic")?.raw, "");
  assert.equal(row("mic")?.restart, false);
  const options = await choicesFor("mic", { tts: "say", current: "", micDevices: ui.state.micDevices, mic: ui.state.mic!.wanted });
  assert.deepEqual(
    options.choices.map((c) => c.label),
    ["System default (USB Mic)", "USB Mic", "MacBook Pro Microphone"],
  );
  const started = logEntries().find((l) => l.event === "mic");
  assert.deepEqual([started?.device, started?.uid, started?.devices], ["USB Mic", "usb-mic", 2]);
  await talk("");
  const opened = events("mic_started").at(-1);
  assert.deepEqual([opened?.device, opened?.uid, opened?.fallback], ["USB Mic", "usb-mic", undefined], "mic_started says which mic");
  console.log("ok");

  begin("mic: choosing one applies at once, no restart, and is saved by UID and name");
  set("mic", BUILT_IN.uid, BUILT_IN.name);
  assert.deepEqual(T.micChoice, { uid: BUILT_IN.uid, name: BUILT_IN.name }, "the helper is told");
  assert.deepEqual([saved().mic, saved().micName], [BUILT_IN.uid, BUILT_IN.name]);
  assert.equal(row("mic")?.value, "MacBook Pro Microphone");
  assert.equal(row("mic")?.raw, BUILT_IN.uid);
  assert.equal(ui.state.restartPending, false);
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false });
  await talk("");
  assert.equal(events("mic_started").at(-1)?.device, "MacBook Pro Microphone");
  assert.ok(events("setting").some((l) => l.key === "mic" && l.restart === false));
  console.log("ok");

  begin("mic: the chosen one unplugged: the system default stands in, said on screen, in the setting and the log");
  set("mic", USB_MIC.uid, USB_MIC.name);
  markHere();
  T.setMicDevices([{ ...BUILT_IN, isDefault: true }]);
  const note = "USB Mic isn't connected: using MacBook Pro Microphone, the system default, until it's back";
  assert.ok(
    caseLines().some((l) => l.kind === "error" && l.text === `[mic] ${note}`),
    "a clear note on screen",
  );
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone (USB Mic missing)", warn: true });
  assert.equal(row("mic")?.value, "USB Mic (not connected)");
  assert.equal(row("mic")?.note, note);
  assert.equal(row("micTest")?.note, note);
  const fell = events("mic_fallback");
  assert.equal(fell.length, 1);
  assert.deepEqual([fell[0].device, fell[0].uid, fell[0].fallback, fell[0].wanted, fell[0].wantedUid], ["MacBook Pro Microphone", BUILT_IN.uid, true, "USB Mic", USB_MIC.uid]);
  const away = await choicesFor("mic", { tts: "say", current: row("mic")!.raw, micDevices: ui.state.micDevices, mic: ui.state.mic!.wanted });
  assert.deepEqual(away.choices.at(-1), { value: USB_MIC.uid, label: "USB Mic", hint: "not connected" }, "still listed, to see it's the one picked");
  await talk("");
  const fallbackOpen = events("mic_started").at(-1);
  assert.deepEqual([fallbackOpen?.device, fallbackOpen?.fallback, fallbackOpen?.wanted], ["MacBook Pro Microphone", true, "USB Mic"]);
  T.setMicDevices([{ ...BUILT_IN, isDefault: true }]);
  assert.equal(events("mic_fallback").length, 1, "said once while it's away");
  console.log("ok");

  begin("mic: plugged back in (another USB port: a new UID), found by name and used again");
  T.setMicDevices([{ ...USB_MIC, uid: "usb-mic-port-2" }, BUILT_IN]);
  assert.ok(caseLines().some((l) => l.text === "USB Mic is back: using it again."));
  assert.equal(events("mic_back").length, 1);
  assert.deepEqual(header(), { text: "🎙 USB Mic", warn: false });
  assert.equal(row("mic")?.value, "USB Mic");
  assert.equal(row("mic")?.note, undefined);
  console.log("ok");

  begin("mic test: the mic opens a few seconds, shows its level and what was heard, then closes");
  T.setMicDevices([USB_MIC, BUILT_IN]);
  T.heard = "testing one two three";
  ui.act({ type: "micTest" });
  assert.equal(ui.state.micTest?.phase, "listening");
  assert.equal(ui.state.micTest?.device, "USB Mic");
  assert.ok(T.micOpen);
  T.mic(Buffer.alloc(3200, 0x40));
  assert.ok(ui.state.micTest!.level > 0.5, "the level shows");
  T.stt.onInterim("testing one");
  assert.equal(ui.state.micTest?.heard, "testing one", "live words");
  T.heard = "testing one two three";
  T.hotkey.onDown(); // the key waits meanwhile
  assert.equal(ui.state.listening, false);
  assert.ok(caseLines().some((l) => l.text === "(testing the mic: the key works again in a moment)"));
  await T.hotkey.onUp();
  await until(() => ui.state.micTest?.phase === "done", 2000);
  assert.equal(ui.state.micTest?.heard, "testing one two three");
  assert.ok(ui.state.micTest!.peak > 0.5);
  assert.equal(T.micOpen, false, "closed after");
  const done = events("mic_test").find((l) => l.phase === "done");
  assert.deepEqual([done?.device, done?.heard], ["USB Mic", "testing one two three"]);
  assert.equal(events("transcript").length, 0, "nothing acted on");
  await talk(""); // the key works again
  assert.ok(events("mic_started").length > 0);
  console.log("ok");

  begin("mic test: with hands-free on, it pauses, then listens again");
  set("listenMode", "hands-free");
  await until(() => ui.state.handsFree.on);
  T.heard = "";
  const sent = T.listenSent ?? 0;
  ui.act({ type: "micTest" });
  T.mic(Buffer.alloc(3200));
  assert.equal(T.listenSent ?? 0, sent, "the test's audio isn't hands-free's");
  await until(() => ui.state.micTest?.phase === "done", 2000);
  assert.ok(T.micOpen, "hands-free keeps it open");
  T.mic(Buffer.alloc(3200));
  assert.equal(T.listenSent, sent + 1, "and hears again");
  set("listenMode", "push-to-talk");
  await until(() => !ui.state.handsFree.on);
  set("mic", "");
  assert.equal(T.micChoice, null);
  assert.equal(saved().mic, undefined);
  ui.act({ type: "closeSettings" });
  console.log("ok");

  // AirPods. The default follows macOS, with nothing custom: the system default is macOS's default input, AirPods
  // included, and a Bluetooth mic in use is held open (native/macos/mic.swift held; the stub helper holds as it
  // does) so a press is heard at once. Taking them out is seamless, with no "missing" notice: their coming, going
  // or giving no link is logged, and nothing is shown or said.
  const { doing } = await import("../../../src/ui/bar.ts");
  const AIRPODS = { uid: "18-3F-70-00-00-01:input", name: "AirPods", isDefault: true, transport: "bluetooth" };
  const MAC = { ...BUILT_IN, transport: "built-in" };
  const USB_WIRED = { ...USB_MIC, isDefault: false, transport: "usb" };
  // The AirPods connected and macOS's default (as it makes them); listed with the default on the Mac's own mic
  // (out of your ears); and gone (in their case).
  const WITH_AIRPODS = [AIRPODS, USB_WIRED, MAC];
  const ON_MAC = [{ ...AIRPODS, isDefault: false }, USB_WIRED, { ...MAC, isDefault: true }];
  const NO_AIRPODS = [USB_WIRED, { ...MAC, isDefault: true }];
  const holds = () => events("mic_hold");
  /** Nothing shown or said about a mic since the case began (or markHere): no error line, no line or spoken words about one. */
  const quiet = (what: string) => {
    const about = /airpods|microphone|\bmic\b|missing|connected|no sound|is back/i;
    assert.deepEqual(
      caseLines()
        .filter((l) => l.kind === "error" || about.test(l.text))
        .map((l) => l.text),
      [],
      `${what}: nothing on screen`,
    );
    assert.deepEqual(
      caseSaid()
        .filter((x: any) => about.test(x.text))
        .map((x: any) => x.text),
      [],
      `${what}: nothing said`,
    );
  };

  begin("mic: AirPods the system default: used as macOS has them and held open, said in the setting and the log, nothing on screen");
  T.micLinkMs = 2100;
  T.setMicDevices(WITH_AIRPODS);
  ui.act({ type: "settings" });
  assert.equal(row("mic")?.value, "System default (AirPods, mic stays on)");
  assert.equal(row("mic")?.note, undefined);
  assert.deepEqual(header(), { text: "🎙 AirPods", warn: false });
  assert.equal(T.micHeld, AIRPODS.uid, "the helper holds the default's mic");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why, h.default, h.linkMs]),
    [
      [true, "AirPods", "connected", true, undefined],
      [true, "AirPods", "connected", true, 2100],
    ],
    "mic_hold on, as the system default, and how long its link took",
  );
  await talk("");
  const onPods = events("mic_started").at(-1);
  assert.deepEqual([onPods?.device, onPods?.held, onPods?.linkUp, onPods?.fallback, onPods?.msAfterKeyDown], ["AirPods", true, true, undefined, 1], "a press is on the AirPods, at once");
  assert.equal(events("mic_not_started").length, 0);
  assert.equal(events("mic_fallback").length, 0);
  quiet("the AirPods connecting");
  console.log("ok");

  begin("mic: the default AirPods go and come back, then leave your ears: Kiko follows macOS's default, nothing shown or said");
  T.setMicDevices(NO_AIRPODS);
  assert.equal(T.micHeld, null, "nothing held for a mic that's gone");
  assert.equal(row("mic")?.value, "System default (MacBook Pro Microphone)");
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false });
  T.hotkey.onDown();
  await wait(450);
  assert.equal(ui.state.micConnecting, null, "no waiting on anything");
  await T.hotkey.onUp();
  const onOwn = events("mic_started").at(-1);
  assert.deepEqual([onOwn?.device, onOwn?.fallback, onOwn?.held], ["MacBook Pro Microphone", undefined, undefined], "the next press is on the Mac's own mic");
  T.setMicDevices(WITH_AIRPODS);
  assert.equal(T.micHeld, AIRPODS.uid, "held again as they connect");
  assert.equal(row("mic")?.value, "System default (AirPods, mic stays on)");
  // Out of your ears: listed still, and macOS moves its default to the Mac's own mic.
  T.setMicDevices(ON_MAC);
  assert.equal(T.micHeld, null, "not held once it isn't the default");
  assert.equal(row("mic")?.value, "System default (MacBook Pro Microphone)");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why, h.default]),
    [
      [false, "AirPods", "disconnected", true],
      [true, "AirPods", "connected", true],
      [true, "AirPods", "connected", true],
      [false, "AirPods", "default changed", true],
    ],
    "all of it logged",
  );
  assert.equal(events("mic_fallback").length + events("mic_back").length, 0, "the system default never falls back");
  assert.equal(events("mic_not_started").length, 0);
  quiet("the default AirPods coming and going");
  console.log("ok");

  begin("mic: the default AirPods give no link (listed, the default still): the built-in mic stands in, quietly; back, held again");
  T.setMicDevices(WITH_AIRPODS);
  markHere();
  T.micHoldLost("silent");
  T.micNoLink();
  assert.equal(T.micHeld, null, "not held open for nothing");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why, h.default]),
    [[false, "AirPods", "no link", true]],
  );
  assert.equal(row("mic")?.value, "System default (MacBook Pro Microphone)", "the setting names the mic that's used");
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false });
  T.hotkey.onDown();
  await wait(450);
  assert.equal(ui.state.micConnecting, null, "no waiting on a link that isn't there");
  await T.hotkey.onUp();
  const stand = events("mic_started").at(-1);
  assert.deepEqual([stand?.device, stand?.fallback, stand?.noLink, stand?.held, stand?.msAfterKeyDown], ["MacBook Pro Microphone", undefined, true, undefined, 1], "heard at once on a mic that works");
  assert.equal(events("mic_not_started").length, 0);
  T.micBack(1900);
  assert.equal(T.micHeld, AIRPODS.uid);
  assert.equal(row("mic")?.value, "System default (AirPods, mic stays on)");
  await talk("");
  assert.deepEqual([events("mic_started").at(-1)?.device, events("mic_started").at(-1)?.held, events("mic_started").at(-1)?.noLink], ["AirPods", true, undefined]);
  quiet("the default AirPods giving no link, and back");
  console.log("ok");

  // A Bluetooth mic you chose is held open while it's connected (2026-11-13), the default or not. Its link takes a
  // couple of seconds to come up the first time (T.micLinkSlow: down until T.micLinkUp).
  begin("mic: AirPods chosen: held open from then on, said in the setting and the log");
  T.setMicDevices(ON_MAC);
  T.micLinkSlow = true;
  markHere();
  const listed = await choicesFor("mic", { tts: "say", current: "", micDevices: ui.state.micDevices, mic: ui.state.mic!.wanted });
  assert.deepEqual(
    listed.choices.map((c) => c.label),
    ["System default (MacBook Pro Microphone)", "AirPods (mic stays on: instant, call-quality sound)", "USB Mic", "MacBook Pro Microphone"],
    "each choice says what it does",
  );
  set("mic", AIRPODS.uid, listed.choices[1].label);
  assert.equal(T.micHeld, AIRPODS.uid, "the helper holds it");
  assert.deepEqual([saved().mic, saved().micName], [AIRPODS.uid, "AirPods"], "saved by its name, not the option's words");
  assert.equal(row("mic")?.value, "AirPods (mic stays on)");
  assert.deepEqual(header(), { text: "🎙 AirPods", warn: false });
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.uid, h.why, h.default, h.linkMs]),
    [[true, "AirPods", AIRPODS.uid, "chosen", undefined, undefined]],
    "mic_hold on, its link not up yet",
  );
  console.log("ok");

  begin("mic: a press before the held mic's link is up: 'connecting', then said with its name, and logged");
  T.heard = "";
  markHere();
  T.hotkey.onDown();
  await until(() => ui.state.micConnecting === "AirPods", 2000, "connecting to the AirPods shows");
  assert.ok(
    doing(ui.state).spans.some((s) => s.text === " connecting to AirPods…"),
    "the bottom line says it",
  );
  await wait(100);
  await T.hotkey.onUp();
  assert.equal(ui.state.micConnecting, null, "gone once the key is up");
  const line = "The AirPods mic didn't start in time. Hold the key a little longer.";
  await until(() => spoke(line), 2000, "it says so");
  assert.ok(!info("(nothing heard)"), "not an empty transcript and silence");
  const notStarted = events("mic_not_started");
  assert.equal(notStarted.length, 1);
  assert.equal(notStarted[0].device, "AirPods");
  assert.ok(notStarted[0].heldMs >= 400, `held ${notStarted[0].heldMs}ms`);
  assert.equal(events("mic_started").length, 0, "no sound, no mic_started");
  await until(() => caseSaid().length > 0);
  await wait(T.speakMs + 200);
  console.log("ok");

  begin("mic: the link comes up while the key is held: heard from then, nothing more said, and how long it took is logged");
  markHere();
  T.hotkey.onDown();
  await until(() => ui.state.micConnecting === "AirPods", 2000);
  T.micLinkUp(2054);
  assert.equal(ui.state.micConnecting, null, "connected: the level again");
  await T.hotkey.onUp();
  assert.ok(info("(nothing heard)"));
  assert.equal(events("mic_not_started").length, 0);
  const waited = events("mic_started").at(-1);
  assert.deepEqual([waited?.device, waited?.held, waited?.linkUp], ["AirPods", true, false], "mic_started: held, its link not up as the press began");
  assert.ok(waited?.msAfterKeyDown >= 400, `it waited for the link (${waited?.msAfterKeyDown} ms)`);
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.live, h.linkMs, h.outRate]),
    [[true, "AirPods", true, 2054, 24000]],
    "mic_hold says how long the link took to come up",
  );
  console.log("ok");

  begin("mic: held and its link up: a press is heard at once, press after press, never 'connecting'");
  markHere();
  for (let i = 0; i < 3; i++) {
    T.hotkey.onDown();
    assert.ok(T.micOpen);
    await wait(450); // past when 'connecting' would show
    assert.equal(ui.state.micConnecting, null, "never connecting");
    await T.hotkey.onUp();
  }
  const instant = events("mic_started");
  assert.deepEqual(
    instant.map((l) => [l.device, l.held, l.linkUp, l.msAfterKeyDown]),
    [1, 2, 3].map(() => ["AirPods", true, true, 1]),
    "mic_started each time: held, its link up, at once",
  );
  assert.equal(events("mic_not_started").length, 0);
  assert.equal(holds().length, 0, "the hold didn't begin again or end between presses");
  assert.equal(T.micHeld, AIRPODS.uid);
  console.log("ok");

  begin("mic: something changes under the hold (the headset left its call profile): logged with what changed");
  markHere();
  T.micHoldLost("output format", { from: 24000, to: 48000 });
  const lost = events("mic_hold_lost");
  assert.deepEqual(
    lost.map((l) => [l.device, l.uid, l.what, l.from, l.to, l.wasLive]),
    [["AirPods", AIRPODS.uid, "output format", 24000, 48000, true]],
  );
  console.log("ok");

  // Listed still, but giving no sound (out of your ears, or the iPhone took them): the helper gives up on the hold
  // after a few seconds, and from then a press takes the system default instead of waiting on a link that isn't there.
  // Before 2026-11-14 the window said "AirPods gave no sound (…)" and, back, "AirPods mic is back: using it again."
  begin("mic: the held AirPods stop giving sound though still listed: nothing shown or said, and a press isn't lost: the system default stands in; back, they're held again");
  markHere();
  T.micHoldLost("silent");
  T.micNoLink();
  assert.equal(T.micHeld, null, "not held open for nothing");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why]),
    [[false, "AirPods", "no link"]],
  );
  assert.deepEqual(
    events("mic_hold_lost").map((l) => [l.device, l.what, l.wasLive]),
    [["AirPods", "silent", true]],
  );
  assert.equal(row("mic")?.value, "AirPods when connected (MacBook Pro Microphone now)");
  assert.equal(row("mic")?.note, undefined);
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false }, "the header names the mic in use, with nothing 'missing'");
  for (let i = 0; i < 2; i++) {
    T.hotkey.onDown();
    await wait(450);
    assert.equal(ui.state.micConnecting, null, "no waiting on a link that isn't there");
    await T.hotkey.onUp();
  }
  assert.deepEqual(
    events("mic_started").map((l) => [l.device, l.fallback, l.wanted, l.noLink, l.held, l.msAfterKeyDown]),
    [1, 2].map(() => ["MacBook Pro Microphone", true, "AirPods", true, undefined, 1]),
    "each press heard at once, on the system default",
  );
  assert.equal(events("mic_not_started").length, 0);
  assert.deepEqual(
    events("mic_fallback").map((l) => [l.device, l.wanted, l.noLink]),
    [["MacBook Pro Microphone", "AirPods", true]],
    "logged, once",
  );
  T.micBack(1900);
  assert.equal(T.micHeld, AIRPODS.uid);
  assert.deepEqual(
    holds()
      .slice(1)
      .map((h) => [h.on, h.device, h.retry, h.linkMs]),
    [
      [true, "AirPods", true, undefined],
      [true, "AirPods", true, 1900],
    ],
  );
  assert.equal(events("mic_back").length, 1);
  assert.equal(row("mic")?.value, "AirPods (mic stays on)");
  await talk("");
  assert.deepEqual([events("mic_started").at(-1)?.device, events("mic_started").at(-1)?.held, events("mic_started").at(-1)?.noLink], ["AirPods", true, undefined]);
  quiet("the chosen AirPods giving no link, and back");
  console.log("ok");

  // 2026-11-14, the AirPods taken out: the window said "AirPods isn't connected: using MacBook Pro Microphone until
  // it's back", the header "(AirPods missing)" in yellow, the setting "AirPods (not connected)".
  begin("mic: the chosen AirPods go (back in their case): no notice, the hold ends and the next press works on the system default; back, they're held again, no notice");
  markHere();
  T.setMicDevices(NO_AIRPODS);
  assert.equal(T.micHeld, null, "nothing held for a mic that's gone");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why]),
    [[false, "AirPods", "disconnected"]],
  );
  assert.deepEqual(
    events("mic_fallback").map((l) => [l.device, l.fallback, l.wanted, l.wantedUid]),
    [["MacBook Pro Microphone", true, "AirPods", AIRPODS.uid]],
    "still logged",
  );
  assert.equal(row("mic")?.value, "AirPods when connected (MacBook Pro Microphone now)");
  assert.equal(row("mic")?.raw, AIRPODS.uid, "still the one picked");
  assert.deepEqual([row("mic")?.note, row("micTest")?.note], [undefined, undefined], "no note under the setting");
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false });
  const pods = await choicesFor("mic", { tts: "say", current: row("mic")!.raw, micDevices: ui.state.micDevices, mic: ui.state.mic!.wanted });
  assert.deepEqual(pods.choices.at(-1), { value: AIRPODS.uid, label: "AirPods", hint: "used when connected" }, "still listed, to see it's the one picked");
  T.hotkey.onDown();
  await wait(450);
  assert.equal(ui.state.micConnecting, null, "never 'connecting to AirPods…'");
  await T.hotkey.onUp();
  const stoodIn = events("mic_started").at(-1);
  assert.deepEqual([stoodIn?.device, stoodIn?.fallback, stoodIn?.wanted, stoodIn?.held], ["MacBook Pro Microphone", true, "AirPods", undefined], "the press isn't lost: the system default stands in");
  assert.equal(events("mic_not_started").length, 0);
  quiet("the chosen AirPods going");
  // Back on, and the Mac's default again.
  T.micLinkSlow = false;
  T.micLinkMs = 1800;
  T.setMicDevices(WITH_AIRPODS);
  assert.equal(events("mic_back").length, 1);
  assert.equal(T.micHeld, AIRPODS.uid, "held again as they connect");
  assert.deepEqual(
    holds()
      .slice(1)
      .map((h) => [h.on, h.device, h.why, h.default, h.linkMs]),
    [
      [true, "AirPods", "connected", undefined, undefined],
      [true, "AirPods", "connected", undefined, 1800],
    ],
  );
  assert.equal(row("mic")?.value, "AirPods (mic stays on)");
  await talk("");
  assert.deepEqual([events("mic_started").at(-1)?.device, events("mic_started").at(-1)?.held], ["AirPods", true]);
  quiet("the chosen AirPods coming back");
  console.log("ok");

  // Once, put away, the AirPods were gone, listed again 1.3 s later (held, their link "live" in
  // 30 ms), and gone again 236 ms after that. Then: "is back: using it again." and the notice a second time.
  begin("mic: the AirPods flap as they're put away (gone, back for a moment, gone): no hold left on, nothing shown, and a press under way goes on");
  markHere();
  T.setMicDevices(NO_AIRPODS);
  T.heard = "";
  T.hotkey.onDown();
  await wait(50);
  T.setMicDevices(WITH_AIRPODS);
  assert.equal(T.micHeld, AIRPODS.uid);
  await wait(30);
  T.setMicDevices(NO_AIRPODS);
  assert.equal(T.micHeld, null, "no hold left running");
  assert.ok(T.micOpen, "the press is still on");
  T.mic(Buffer.alloc(3200, 0x40));
  assert.ok(ui.state.level > 0.5, "and still heard");
  await wait(450);
  assert.equal(ui.state.micConnecting, null, "never 'connecting'");
  await T.hotkey.onUp();
  assert.ok(info("(nothing heard)"), "the press ended as any other (no words were given)");
  assert.equal(events("mic_not_started").length, 0);
  assert.deepEqual(
    events("mic_switched").map((l) => l.device),
    ["AirPods", "MacBook Pro Microphone"],
    "the press followed the device there and back",
  );
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why]),
    [
      [false, "AirPods", "disconnected"],
      [true, "AirPods", "connected"],
      [true, "AirPods", "connected"],
      [false, "AirPods", "disconnected"],
    ],
  );
  assert.deepEqual([events("mic_fallback").length, events("mic_back").length], [2, 1], "logged as it happened");
  assert.equal(row("mic")?.value, "AirPods when connected (MacBook Pro Microphone now)");
  await talk("");
  assert.deepEqual([events("mic_started").at(-1)?.device, events("mic_started").at(-1)?.held], ["MacBook Pro Microphone", undefined], "and the next press works");
  quiet("the flap");
  console.log("ok");

  // What a start with the AirPods chosen and in their case is to the app: the saved choice, and a device list
  // without them (refreshMic, as the helper lists its devices). And what a press then says while its mic is slow:
  // the mic it's really opening, never the AirPods.
  begin("mic: the chosen AirPods away from the start: no notice, and a press works on the system default with no AirPods wording");
  set("mic", "");
  markHere();
  set("mic", AIRPODS.uid, "AirPods");
  assert.deepEqual(
    events("mic_fallback").map((l) => [l.device, l.wanted]),
    [["MacBook Pro Microphone", "AirPods"]],
    "logged",
  );
  assert.equal(row("mic")?.value, "AirPods when connected (MacBook Pro Microphone now)");
  assert.deepEqual(header(), { text: "🎙 MacBook Pro Microphone", warn: false });
  assert.equal(T.micHeld, null);
  await talk("");
  assert.deepEqual([events("mic_started").at(-1)?.device, events("mic_started").at(-1)?.fallback], ["MacBook Pro Microphone", true], "a press works");
  quiet("the chosen AirPods away from the start");
  T.micSlow = true;
  T.hotkey.onDown();
  await until(() => ui.state.micConnecting === "MacBook Pro Microphone", 2000, "a slow start names the mic that's opening");
  T.micStart();
  assert.equal(ui.state.micConnecting, null);
  await T.hotkey.onUp();
  T.hotkey.onDown();
  await wait(450);
  await T.hotkey.onUp();
  T.micSlow = false;
  await until(() => spoke("The MacBook Pro Microphone didn't start in time. Hold the key a little longer."), 2000, "one that never starts is said by its own name");
  assert.deepEqual(
    [...caseLines().map((l) => l.text), ...caseSaid().map((x: any) => x.text)].filter((t) => /airpods/i.test(t)),
    [],
    "no AirPods wording anywhere",
  );
  await until(() => caseSaid().length > 0);
  await wait(T.speakMs + 200);
  console.log("ok");

  begin("mic: back to the system default with the AirPods the default: still held; the Mac's own mic chosen: the hold ends; a mic that isn't Bluetooth is never held");
  T.setMicDevices(WITH_AIRPODS);
  assert.equal(T.micHeld, AIRPODS.uid);
  markHere();
  set("mic", "");
  assert.equal(T.micHeld, AIRPODS.uid, "the system default is the AirPods: the same hold goes on");
  assert.equal(holds().length, 0, "nothing ended or begun");
  assert.equal(row("mic")?.value, "System default (AirPods, mic stays on)");
  // Full-quality sound on the AirPods: the Mac's own mic, picked.
  set("mic", MAC.uid, MAC.name);
  assert.equal(T.micHeld, null, "never left held for a mic that isn't the one in use");
  assert.deepEqual(
    holds().map((h) => [h.on, h.device, h.why]),
    [[false, "AirPods", "another mic chosen"]],
  );
  assert.equal(row("mic")?.value, "MacBook Pro Microphone");
  await talk("");
  const own = events("mic_started").at(-1);
  assert.deepEqual([own?.device, own?.held, own?.fallback], ["MacBook Pro Microphone", undefined, undefined]);
  set("mic", USB_WIRED.uid, USB_WIRED.name);
  assert.equal(T.micHeld, null);
  assert.equal(holds().length, 1, "no hold for a USB mic");
  quiet("choosing between them");
  T.micLinkMs = undefined;
  T.setMicDevices([USB_MIC, BUILT_IN]);
  set("mic", "");
  ui.act({ type: "closeSettings" });
  console.log("ok");
}

// Settings → Logs → Keep logs (core/log-retention.ts), in this run's own log folder (run.sh: out/logs,
// never the repo's logs/). The Finder button isn't pressed here: it would open a real Finder window.
export async function logsCases() {
  const { utimesSync } = await import("node:fs");
  const row = (key: string) => ui.state.settings.find((r: any) => r.key === key);
  const set = (key: string, value: unknown) => ui.act({ type: "set", key: key as any, value });
  const saved = () => JSON.parse(readFileSync("settings-test.json", "utf8"));
  const DAY = 24 * 60 * 60 * 1000;
  /** A file in this run's log folder, last written `daysAgo` days ago. */
  const old = (name: string, daysAgo: number, text = "x") => {
    writeFileSync(`${LOGS}/${name}`, text);
    const at = new Date(Date.now() - daysAgo * DAY);
    utimesSync(`${LOGS}/${name}`, at, at);
  };
  const runLog = logFile().split("/").at(-1)!;

  begin("logs: Keep logs shows how long and how much; 7 days prunes the older run logs at once, and only those");
  ui.act({ type: "settings" });
  // A checkout (Kiko Dev): forever unless set.
  assert.match(row("keepLogs")?.value ?? "", /^Forever · \d/);
  assert.equal(row("keepLogs")?.raw, 0);
  assert.equal(row("keepLogs")?.restart, false);
  const stale = "2026-01-02T03-04-05-678Z.jsonl";
  old(stale, 10, "0123456789");
  old("notes.txt", 400);
  old("2026-01-01.jsonl", 400);
  // This run's own file, made old: kept all the same.
  utimesSync(`${LOGS}/${runLog}`, new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));
  set("keepLogs", 7);
  assert.equal(saved().keepLogs, 7);
  assert.equal(existsSync(`${LOGS}/${stale}`), false, "the old run log went");
  assert.ok(existsSync(`${LOGS}/notes.txt`) && existsSync(`${LOGS}/2026-01-01.jsonl`), "nothing else is touched");
  assert.ok(existsSync(`${LOGS}/${runLog}`), "never this run's");
  const pruned = caseLog().filter((l) => l.event === "logs_pruned");
  assert.equal(pruned.length, 1);
  assert.deepEqual(Object.keys(pruned[0]).sort(), ["bytes", "count", "event", "ms", "t"]);
  assert.equal(pruned[0].count, 1);
  assert.equal(pruned[0].bytes, 10);
  assert.match(row("keepLogs")?.value ?? "", /^7 days · \d/);
  // Forever again: nothing more goes.
  old("2026-01-03T03-04-05-678Z.jsonl", 100);
  set("keepLogs", 0);
  assert.equal(saved().keepLogs, 0);
  assert.ok(existsSync(`${LOGS}/2026-01-03T03-04-05-678Z.jsonl`));
  ui.act({ type: "closeSettings" });
  console.log("ok");
}

// Settings' filter (`/`, src/ui/settings.ts filterSettings) over the app's own settings, as the screen lists
// them: the keys are typed in the unit tests (tests/unit/ui/settings-filter.test.ts); here, that the
// real rows (their names, values, sections) are found, and a section with no match is left out.
export async function settingsFilterCases() {
  const { filterSettings } = await import("../../../src/ui/settings.ts");
  const found = (query: string) => filterSettings(ui.state.settings, query).map((g) => [g.title, g.rows.map((r) => r.key)] as const);

  begin("settings filter: the app's settings, by name, value and section; nothing matching says nothing");
  ui.act({ type: "settings" });
  const all = filterSettings(ui.state.settings, null);
  assert.equal(all.flatMap((g) => g.rows).length, ui.state.settings.length, "no filter: every setting");
  // By a name: Keep logs, under its section.
  assert.ok(found("keep logs").some(([title, keys]) => title === "Logs" && keys.includes("keepLogs")));
  assert.ok(!found("keep logs").some(([title]) => title === "Voice"), "a section with no match is left out");
  // By a section's name: all of it.
  const phone = all.find((g) => g.title === "Phone")!;
  assert.deepEqual(
    found("phone").find(([title]) => title === "Phone")?.[1],
    phone.rows.map((r) => r.key),
  );
  // By a value: the talk key's, as shown.
  const hotkey = ui.state.settings.find((r: any) => r.key === "hotkey")!;
  assert.ok(
    found(hotkey.value).some(([, keys]) => keys.includes("hotkey")),
    `found by "${hotkey.value}"`,
  );
  assert.deepEqual(found("qqqzzzxxx"), []);
  ui.act({ type: "closeSettings" });
  console.log("ok:", JSON.stringify(found("dictionary")));
}

// Settings → Account (src/app/settings/account.ts): no row while accounts aren't open (KIKO_ACCOUNTS=0);
// open (as released, or KIKO_ACCOUNTS=1, read at each use), who's signed in from account.json, its pane's label and value
// rows (accountFacts), found by the filter (by the plan too), Sign out with a phone paired asking
// first and saying what it does, and Sign out taking it out. No Keychain here (KIKO_KEYCHAIN=off) and no server (KIKO_ACCOUNT_URL is a
// port nothing listens on): nothing to tell, so nothing is sent.
export async function accountCases() {
  const { filterSettings } = await import("../../../src/ui/settings.ts");
  const row = () => ui.state.settings.find((r: any) => r.key === "account");

  begin("account: hidden while accounts aren't open; open, who's signed in, found by /, Sign out (asking first with a phone); the plan's rows and the trial's item");
  process.env.KIKO_ACCOUNTS = "0";
  ui.act({ type: "settings" });
  assert.equal(row(), undefined, "no Account row while accounts aren't open");
  assert.ok(!filterSettings(ui.state.settings, null).some((g) => g.title === "Account"));
  ui.act({ type: "closeSettings" });
  process.env.KIKO_ACCOUNTS = "1";
  try {
    ui.act({ type: "settings" });
    assert.equal(row()?.label, "Kiko account");
    assert.equal(row()?.value, "Not signed in");
    assert.deepEqual(row()?.facts, [{ value: "Not signed in.", more: ["Your own keys never need an account."] }]);
    assert.equal(row()?.note, undefined, "no line of its own: the pane's rows say it");
    ui.act({ type: "closeSettings" });
    writeFileSync("account.json", JSON.stringify({ email: "name@example.com", since: Date.now() }));
    ui.act({ type: "settings" });
    assert.equal(row()?.value, "name@example.com");
    assert.deepEqual(row()?.facts, [{ label: "Signed in", value: "name@example.com" }], "nothing on record of a plan yet: no Plan row");
    assert.deepEqual(
      filterSettings(ui.state.settings, "account")
        .find((g) => g.title === "Account")
        ?.rows.map((r) => r.key),
      ["account"],
    );
    assert.ok(
      filterSettings(ui.state.settings, "name@example").some((g) => g.title === "Account"),
      "by who's signed in",
    );
    // A phone paired: Sign out asks first, the pane saying what it does; Stay signed in leaves it.
    const { pairing } = await import("../../../src/app/state.ts");
    const { accountChoices } = await import("../../../src/core/settings-options.ts");
    const list = pairing.list;
    pairing.list = () => [{ id: "phone-1", name: "Test iPhone" }] as ReturnType<typeof list>;
    try {
      // Opened again, so the row knows of the phone.
      ui.act({ type: "closeSettings" });
      ui.act({ type: "settings" });
      assert.equal(accountChoices(JSON.parse(row()!.raw as string)).find((c) => c.value === "signout")?.hint, "asks first: a phone is paired");
      ui.act({ type: "set", key: "account", value: "signout" });
      await until(() => row()?.facts?.length === 2 && row()?.facts?.[1].value === "Sign out on this Mac?");
      assert.ok(info("(Sign out on this Mac? Other Macs stay signed in. Your phone loses access away from home; at home it keeps working. Sign out anyway, under Account.)"));
      assert.deepEqual(row()?.facts?.[1], { value: "Sign out on this Mac?", warn: true, more: ["Other Macs stay signed in. Your phone loses access away from home; at home it keeps working."] });
      assert.deepEqual(
        accountChoices(JSON.parse(row()!.raw as string)).map((c) => [c.value, c.label]),
        [
          ["signout", "Sign out anyway"],
          ["keep", "Stay signed in"],
        ],
      );
      ui.act({ type: "set", key: "account", value: "keep" });
      await until(() => row()?.facts?.length === 1);
      assert.ok(existsSync("account.json"), "still signed in");
    } finally {
      pairing.list = list;
    }
    ui.act({ type: "closeSettings" });
    ui.act({ type: "settings" });
    assert.equal(accountChoices(JSON.parse(row()!.raw as string)).find((c) => c.value === "signout")?.hint, "other Macs stay signed in");
    ui.act({ type: "set", key: "account", value: "signout" });
    await until(() => row()?.value === "Not signed in");
    assert.equal(existsSync("account.json"), false);
    assert.ok(info("(Signed out on this Mac.)"));
    ui.act({ type: "closeSettings" });

    // The plan (as kiko account says it, in fewer words): its rows in the pane, and the trial's short item on the window's line.
    const { refreshPlan } = await import("../../../src/app/settings/account.ts");
    const { appAccount } = await import("../../../src/core/account/app-account.ts");
    const DAY = 86_400_000;
    const trial = (daysLeft: number, used: number) => ({
      email: "name@example.com",
      since: Date.now(),
      plan: {
        name: "trial",
        startedAt: Date.now() - DAY,
        endsAt: Date.now() + daysLeft * DAY - 60_000,
        quota: { period: "plan", periodEnd: null, usedShare: used, dailyCap: true, dailyResetsAt: null, pastCap: "stop" },
      },
      trial: { startedAt: Date.now() - DAY, endsAt: Date.now() + daysLeft * DAY - 60_000, ended: false, endedWhy: null },
    });
    writeFileSync("account.json", JSON.stringify(trial(6, 0.03)));
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts, [
      { label: "Signed in", value: "name@example.com" },
      { label: "Plan", value: "Free trial · 6 days left", warn: false },
      { label: "Used", value: "3% of the trial", warn: false },
    ]);
    assert.ok(
      filterSettings(ui.state.settings, "free trial").some((g) => g.title === "Account"),
      "by its plan",
    );
    ui.act({ type: "closeSettings" });
    refreshPlan(appAccount());
    assert.deepEqual(ui.state.plan, { text: "trial · 6d left", warn: false });
    writeFileSync("account.json", JSON.stringify(trial(2, 0.1)));
    refreshPlan(appAccount());
    assert.deepEqual(ui.state.plan, { text: "trial · 2d left", warn: true }, "yellow in its last two days");
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[1], { label: "Plan", value: "Free trial · 2 days left", warn: true }, "and in Settings, on the days");
    ui.act({ type: "closeSettings" });
    // A key of your own: it runs the AI, said plainly, and no item on the window's line.
    process.env.OPENROUTER_API_KEY = "sk-or-test-not-real";
    try {
      ui.act({ type: "settings" });
      assert.deepEqual(row()?.facts?.[1], { label: "Plan", value: "Using your own OpenRouter key", more: ["The free trial isn't used while a key is set."] });
      ui.act({ type: "closeSettings" });
      refreshPlan(appAccount());
      assert.equal(ui.state.plan, null);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
    const ended = {
      ...trial(0, 0.4),
      plan: { name: "none", startedAt: null, endsAt: null, quota: null },
      trial: { startedAt: Date.UTC(2026, 10, 3), endsAt: Date.UTC(2026, 10, 10, 12), ended: true, endedWhy: "time" },
    };
    writeFileSync("account.json", JSON.stringify(ended));
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[1], { label: "Plan", value: "Trial ended on 10 Nov", more: ["To go on, add your own OpenRouter key (free):", "kiko-dev keys set openrouter"] });
    ui.act({ type: "closeSettings" });
    refreshPlan(appAccount());
    assert.equal(ui.state.plan, null);
    rmSync("account.json", { force: true });
    refreshPlan(appAccount());
  } finally {
    delete process.env.KIKO_ACCOUNTS;
    rmSync("account.json", { force: true });
  }
  console.log("ok");
  await proCases();
  await signInCases();
}

// Settings → Account → Sign in (src/app/settings/account.ts): `kiko login`'s device code flow in
// the pane, through the app's own settings actions, against a fake account server
// (tests/support/fake-account.ts) and a key store in memory (the app's account swapped for the
// case's: useAccount). No browser (the opener is the case's own), no clipboard (Copy the code's
// copier is the case's own too), no Keychain, no real server.
async function signInCases() {
  const row = () => ui.state.settings.find((r: any) => r.key === "account");
  const raw = () => JSON.parse(String(row()?.raw ?? "{}"));
  begin("account: Sign in from Settings: the code, Copy the code, Enter opens the page, the approval waited for, ✓ signed in; Esc stops one");
  const { useAccount, setCopyText, setOpenUrl, refreshPlan } = await import("../../../src/app/settings/account.ts");
  const { Account } = await import("../../../src/core/account/account.ts");
  const { accountClient } = await import("../../../src/core/account/client.ts");
  const { choicesFor } = await import("../../../src/core/settings-options.ts");
  const { agreeLine } = await import("../../../src/core/terms.ts");
  const { fakeAccountServer, happyScript, memoryStore, PENDING, EMAIL, USER_CODE } = await import("../../support/fake-account.ts");
  const server = await fakeAccountServer({ ...happyScript(), token: [PENDING] });
  const opened: string[] = [];
  setOpenUrl(async (url) => (opened.push(url), true));
  const copied: string[] = [];
  setCopyText(async (text) => (copied.push(text), true));
  const fast = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const t = setTimeout(resolve, Math.min(ms, 20));
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
    });
  const file = "account-sign-in.json";
  rmSync(file, { force: true });
  useAccount(new Account({ store: memoryStore().store, client: accountClient(server.url), file, sleep: fast }));
  process.env.KIKO_ACCOUNTS = "1";
  try {
    ui.act({ type: "settings" });
    assert.equal(row()?.value, "Not signed in");
    assert.deepEqual(
      (await choicesFor("account", { tts: "say", current: row()?.raw })).choices.map((c) => c.value),
      ["signin", "keep"],
    );
    // Picked, then Esc while its code shows: stopped, nothing opened, nothing changed.
    ui.act({ type: "set", key: "account", value: "signin" });
    await until(() => raw().signing === "code");
    assert.equal((await choicesFor("account", { tts: "say", current: row()?.raw })).escape, "stop");
    ui.act({ type: "set", key: "account", value: "stop" });
    await until(() => raw().signing === undefined);
    assert.deepEqual(opened, []);
    assert.equal(row()?.value, "Not signed in");

    // Again, through: the code, Open the browser (Enter), the wait, then approved.
    ui.act({ type: "set", key: "account", value: "signin" });
    await until(() => raw().signing === "code");
    assert.deepEqual(row()?.facts?.[0], { label: "Your code", value: USER_CODE, more: ["Enter opens https://account.kiko.sh/device; type the code there.", agreeLine("signing in")] });
    // Copy the code, between Open the browser and Stop: exactly the code, ✓ under it, still waiting.
    assert.deepEqual(
      (await choicesFor("account", { tts: "say", current: row()?.raw })).choices.map((c) => c.value),
      ["open", "copy", "stop"],
    );
    ui.act({ type: "set", key: "account", value: "copy" });
    await until(() => row()?.facts?.[1]?.ok === true);
    assert.deepEqual(copied, [USER_CODE]);
    assert.deepEqual(row()?.facts?.[1], { value: "✓ Code copied", ok: true });
    assert.equal(raw().signing, "code");
    ui.act({ type: "set", key: "account", value: "open" });
    await until(() => raw().signing === "waiting");
    assert.deepEqual(opened, ["https://account.kiko.sh/device"]);
    assert.deepEqual(row()?.facts?.[2], { value: "Waiting for you to approve in the browser… Esc to stop" });
    server.answer("token", ...happyScript().token);
    await until(() => row()?.value === EMAIL);
    assert.deepEqual(row()?.facts?.slice(0, 2), [
      { value: `✓ Signed in as ${EMAIL}`, ok: true },
      { label: "Signed in", value: EMAIL },
    ]);
    assert.ok(info(`(Signed in as ${EMAIL}.)`));
    assert.ok(caseLog().some((l) => l.event === "settings_sign_in"));
    // Closed and opened again: the signed-in rows, without the ✓ line.
    ui.act({ type: "closeSettings" });
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[0], { label: "Signed in", value: EMAIL });
    ui.act({ type: "closeSettings" });
  } finally {
    delete process.env.KIKO_ACCOUNTS;
    useAccount(undefined);
    rmSync(file, { force: true });
    refreshPlan();
    await server.close();
  }
  console.log("ok");
}

// Kiko Pro (src/app/settings/account.ts, src/app/upgrade.ts): its Plan and This month rows (with
// the weekly pace) in the Account pane, "pro · 85% used" on the window's line only near the cap,
// Manage billing with Pro (on sale or not: managing isn't buying), and "upgrade to Kiko Pro" by
// voice only while Pro is on sale (KIKO_PRO=1, read at each use). No Keychain here, so no session
// token: the billing calls end at "not signed in" before any server, and no browser is opened (the
// opener is the case's own).
async function proCases() {
  const row = () => ui.state.settings.find((r: any) => r.key === "account");
  begin("Kiko Pro: Settings' rows and pace, the window's item near the cap, Manage billing with Pro, 'upgrade' only while it's on sale");
  const { refreshPlan, setOpenUrl } = await import("../../../src/app/settings/account.ts");
  const { appAccount } = await import("../../../src/core/account/app-account.ts");
  const { accountChoices } = await import("../../../src/core/settings-options.ts");
  const opened: string[] = [];
  setOpenUrl(async (url) => (opened.push(url), true));
  const DAY = 86_400_000;
  const renews = Date.UTC(2026, 11, 3, 12);
  const pro = (used: number, terms: Record<string, unknown> = {}) => ({
    email: "name@example.com",
    since: Date.now(),
    plan: {
      name: "pro",
      startedAt: Date.now() - DAY,
      endsAt: Date.now() + 300 * DAY,
      quota: { period: "month", periodEnd: Date.now() + 10 * DAY, usedShare: used, dailyCap: false, dailyResetsAt: null, pastCap: "stop" },
      pro: { interval: "month", renewsAt: renews, cancelAt: null, paymentFailed: null, weekShare: 0.12, pace: "on_track", ...terms },
    },
    trial: null,
  });
  process.env.KIKO_ACCOUNTS = "1";
  try {
    writeFileSync("account.json", JSON.stringify(pro(0.31)));
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.slice(1), [
      { label: "Plan", value: "Kiko Pro · renews 3 Dec", warn: false },
      { label: "This month", value: "31% used · this week 12%, on track", warn: false },
    ]);
    // Not on sale: Manage billing all the same (managing isn't buying: whenever accounts are on, since 2026-11-04).
    assert.deepEqual(
      accountChoices(JSON.parse(row()!.raw as string)).map((c) => c.value),
      ["keep", "billing", "signout"],
    );
    ui.act({ type: "closeSettings" });
    refreshPlan(appAccount());
    assert.equal(ui.state.plan, null, "under 80%: nothing on the window's line");
    writeFileSync("account.json", JSON.stringify(pro(0.85, { pace: "fast", weekShare: 0.4 })));
    refreshPlan(appAccount());
    assert.deepEqual(ui.state.plan, { text: "pro · 85% used", warn: true });
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[2], { label: "This month", value: "85% used · this week 40%, faster than usual", warn: true });
    ui.act({ type: "closeSettings" });
    writeFileSync("account.json", JSON.stringify(pro(0.31, { cancelAt: renews, renewsAt: null })));
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[1], { label: "Plan", value: "Kiko Pro · ends 3 Dec", warn: true }, "cancelled: yellow, on the plan");
    ui.act({ type: "closeSettings" });
    writeFileSync("account.json", JSON.stringify(pro(0.31, { paymentFailed: { graceEndsAt: Date.UTC(2026, 10, 27, 12) } })));
    ui.act({ type: "settings" });
    assert.deepEqual(row()?.facts?.[1], { label: "Plan", value: "Kiko Pro · payment failed", warn: true, more: ["Update your card in Manage billing before Pro stops on 27 Nov."] });
    ui.act({ type: "closeSettings" });
    // "Upgrade to Kiko Pro" while Pro isn't on sale: never a checkout.
    await talk("upgrade to kiko pro");
    await wait(300);
    assert.ok(!caseLog().some((l) => l.event === "upgrade_checkout"), "no checkout while Pro isn't on sale");

    // On sale: Manage billing is there too; picked, the billing page asked for (not signed in here: no Keychain).
    process.env.KIKO_PRO = "1";
    writeFileSync("account.json", JSON.stringify(pro(0.31)));
    ui.act({ type: "settings" });
    assert.deepEqual(
      accountChoices(JSON.parse(row()!.raw as string)).map((c) => c.value),
      ["keep", "billing", "signout"],
    );
    ui.act({ type: "set", key: "account", value: "billing" });
    await until(() => info("(Not signed in on this Mac: kiko-dev login signs in first.)"));
    assert.deepEqual(opened, [], "nothing opened without a billing page");
    ui.act({ type: "closeSettings" });
    // On Pro already, "upgrade to Kiko Pro" says where it's managed.
    await talk("upgrade to kiko pro");
    await until(() => spoke("You have Kiko Pro already. Manage it with kiko-dev account billing."));
    // No plan: it opens the checkout, as said (and here, with no Keychain, says why it can't).
    writeFileSync("account.json", JSON.stringify({ ...pro(0), plan: { name: "none", startedAt: null, endsAt: null, quota: null } }));
    await talk("upgrade to kiko pro");
    await until(() => spoke("Opening checkout in your browser."));
    await until(() => spoke("Not signed in on this Mac: kiko-dev login signs in first."));
    assert.deepEqual(opened, []);
  } finally {
    delete process.env.KIKO_ACCOUNTS;
    process.env.KIKO_PRO = "0";
    rmSync("account.json", { force: true });
    refreshPlan(appAccount());
  }
  console.log("ok");
}
