// What's read out and the reply window after it: windows given way, cut and kept, held finished turns,
// an announcement put back by a press before its first sound, the window's countdown, and what a summary
// is told you said.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  announced,
  AT_ONCE_MS,
  begin,
  caseLines,
  caseLog,
  caseSaid,
  clipboardRuns,
  cue,
  DESK,
  enqueue,
  ghostty,
  gone,
  held,
  HookRequest,
  info,
  lines,
  logFile,
  markHere,
  near,
  notSent,
  saidFor,
  spoke,
  startOpened,
  stop,
  T,
  talk,
  TERM,
  TRANSCRIPT,
  ui,
  until,
  wait,
  windowOpen,
  windowStart,
} from "../driver.ts";

// The first cases (0–6): a fresh install's defaults; a replay of two finished turns close together and the
// reply windows after a reading (fyi turns giving way, an asking turn's, not while you talk, a permission's
// never cut); routing after the window (the desktop app's session, one on the agents list); held finished
// turns; and what the log has of them.
export async function announceCases() {
  // 0. A fresh install (after a clean reinstall, a request for a new Codex session once got "Starting
  //    sessions is off in settings."): no settings file (removed above), so
  //    every setting at its default, and Voice can's is Everything. The user's words start the session.
  {
    begin("fresh install: Voice can is Everything, and 'open a new codex session and name it permission test' starts it");
    assert.ok(!existsSync("settings-test.json") || JSON.parse(readFileSync("settings-test.json", "utf8")).voiceCan === undefined, "nothing saved");
    assert.ok(
      lines.some((l) => l.text.includes("Voice can: everything.")),
      "the startup line names the level",
    );
    assert.equal(ui.state.settings.find((r: any) => r.key === "voiceCan")?.value, "Everything");
    const [utterance, route] = [T.utterance, T.route];
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    T.route = () => [{ name: "start_session", project: null, newProject: false, sessionName: "permission test", prompt: "", agent: "codex" }];
    const opened = T.opened.length;
    await talk("Open a new codex session and name it permission test.");
    await until(() => T.opened.length === opened + 1, 3000, "a terminal opened for it");
    assert.match(T.opened.at(-1).command, /\bcodex\b/, "in Codex");
    const open = caseLog().find((l) => l.event === "session_open");
    assert.deepEqual([open?.agent, open?.name], ["codex", "permission test"]);
    assert.ok(!caseLog().some((l) => l.event === "not_allowed"), "nothing refused");
    assert.ok(!caseLines().some((l) => /off in settings|by voice is off/i.test(l.text)), "nothing said is off");
    // Codex isn't connected here (no hooks in out/codex-home): it starts, and it's said that Kiko won't hear it.
    await until(
      () =>
        caseLines().some((l) => l.kind === "voice" && /^Codex isn't connected to .+ yet, so I won't hear when it finishes or asks something\. In Settings, under Agents, connect it\.$/.test(l.text)),
      3000,
      "said it isn't connected",
    );
    await startOpened();
    [T.utterance, T.route] = [utterance, route];
    console.log("ok: started at the default, nothing refused");
  }

  // 1. Two finished turns close together, scaled: desktop "2 plus 2" says 5+5=10 (needs you 0.04), claude-code-speech
  //    finishes 12s later. Desktop now gets the fyi window, so it's gone well before; the next is announced at once.
  {
    begin("incident replay");
    T.needs = [0.04, 0.59];
    const a = stop(DESK, "claude-desktop");
    T.hooks.onRequest(a);
    await until(() => saidFor(DESK));
    await wait(1200);
    const b = stop(TERM, "cli");
    const bAt = Date.now();
    T.hooks.onRequest(b);
    await until(() => saidFor(TERM));
    near(a.settledAt - windowStart(DESK), 600);
    assert.equal(a.reply, null);
    // A desktop session isn't typed into after its window: no "hold the key to reply anyway".
    assert.ok(caseLines().some((l) => l.text === "(no reply; the session stopped. Reply to it in its window)"));
    assert.ok(saidFor(TERM).at - bAt < 60, `announced ${saidFor(TERM).at - bAt}ms after it came in`);
    console.log(`ok: desktop window ${a.settledAt - windowStart(DESK)}ms (was 45s); next announced ${saidFor(TERM).at - bAt}ms after it came in`);
    gone(b);
    await wait(50);
  }

  // 1b. Same, but the second finishes 3s in (during the fyi window): the first gives way at once.
  {
    begin("fyi turn gives way");
    T.needs = [0.04, 0.59];
    const a = stop(DESK, "claude-desktop");
    T.hooks.onRequest(a);
    await until(() => saidFor(DESK));
    await wait(T.speakMs + 300);
    const b = stop(TERM, "cli");
    const bAt = Date.now();
    T.hooks.onRequest(b);
    await until(() => saidFor(TERM));
    assert.ok(a.settledAt - bAt < AT_ONCE_MS, `released ${a.settledAt - bAt}ms after the next came in`);
    assert.ok(caseLines().some((l) => l.text === "(no reply; the session stopped. Reply to it in its window)"));
    console.log(`ok: released ${a.settledAt - bAt}ms after the next came in, announced ${saidFor(TERM).at - bAt}ms after`);
    gone(b);
    await wait(50);
  }

  // 2. A turn that asked you something keeps the short window, counted from its own start.
  {
    begin("asking turn keeps the fyi window");
    T.needs = [0.8, 0.5];
    const a = stop(TERM, "cli");
    T.hooks.onRequest(a);
    await until(() => saidFor(TERM));
    await wait(T.speakMs + 300);
    T.hooks.onRequest(stop(DESK, "claude-desktop"));
    await until(() => a.settledAt > 0);
    near(a.settledAt - windowStart(TERM), 600);
    await until(() => saidFor(DESK));
    console.log(`ok: asking turn released ${a.settledAt - windowStart(TERM)}ms into its 1500ms window`);
    // A later arrival (past the fyi length): released at once.
    T.needs = [0.8];
    markHere();
    await wait(700); // the desktop one's window runs out first
    const c = stop(TERM, "cli");
    T.hooks.onRequest(c);
    await until(() => saidFor(TERM));
    await wait(T.speakMs + 900);
    const d = stop(DESK, "claude-desktop");
    const dAt = Date.now();
    T.hooks.onRequest(d);
    await until(() => c.settledAt > 0);
    assert.ok(c.settledAt - dAt < AT_ONCE_MS, `released ${c.settledAt - dAt}ms after`);
    console.log(`ok: past the fyi length, released ${c.settledAt - dAt}ms after the next came in`);
    gone(d);
    await wait(50);
  }

  // 3. Not while you hold the key; on key up the window restarts, capped at the fyi length.
  {
    begin("not while talking");
    T.needs = [0.8, 0.5];
    const a = stop(TERM, "cli");
    T.hooks.onRequest(a);
    await windowOpen(TERM);
    T.heard = "";
    T.hotkey.onDown();
    await wait(50);
    T.hooks.onRequest(stop(DESK, "claude-desktop"));
    await wait(800); // past where the cap would have ended it
    assert.ok(a.open, "still waiting while the key is held");
    const upAt = Date.now();
    await T.hotkey.onUp(); // "(nothing heard)"
    await until(() => a.settledAt > 0);
    near(a.settledAt - upAt, 600);
    console.log(`ok: kept while held; released ${a.settledAt - upAt}ms after key up`);
    await until(() => saidFor(DESK));
    await wait(T.speakMs + 1500); // its window runs out
  }

  // 3b. A turn that only reported something, with another already in line when its reading ends (it came in
  //     while it was read out), gives way GIVE_WAY_MS after (2s, 200ms here), not the fyi window.
  {
    begin("fyi turn with one in line gives way soon after its reading");
    T.needs = [0.04, 0.8];
    T.speakMs = 300;
    const a = stop(DESK, "claude-desktop");
    T.hooks.onRequest(a);
    await until(() => saidFor(DESK));
    const b = stop(TERM, "cli");
    T.hooks.onRequest(b); // while it's being read out
    await until(() => a.settledAt > 0);
    const end = saidFor(DESK).end;
    T.speakMs = 50;
    near(a.settledAt - end, 200);
    assert.equal(a.reply, null);
    await until(() => saidFor(TERM));
    console.log(`ok: released ${a.settledAt - end}ms after its reading ended (fyi window 600ms)`);
    gone(b);
    await wait(50);
  }

  // 3c. Your words dealt with while a turn waits: with nothing in line its window starts over, as before. With
  //     another in line it gives way once the app's answer is heard, and words a moment late still reach it.
  {
    begin("answered with one in line: moves on");
    const logged = (event: string) =>
      readFileSync(logFile(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === event);
    T.needs = [0.8, 0.8];
    const a = stop(TERM, "cli");
    T.hooks.onRequest(a);
    await windowOpen(TERM);
    await talk("what time is it");
    await wait(300);
    assert.ok(a.open, "nothing in line: the window started over");
    // The press's timings in the log (the window no longer shows them): from where, how long, what it cost.
    const done = caseLog().find((l) => l.event === "press_done");
    assert.ok(done && done.from === "key up" && Number.isInteger(done.ms) && done.ms >= 0 && typeof done.sttCost === "number" && typeof done.totalCost === "number", JSON.stringify(done));
    const b = stop(DESK, "claude-desktop");
    T.hooks.onRequest(b); // it asked you something: the fyi window, from its restart
    await wait(20);
    assert.ok(a.open);
    T.routeText = "Got it.";
    T.classifierDelayMs = 200; // the next announcement makes no sound for a moment
    const upAt = Date.now();
    await talk("sounds good");
    await until(() => a.settledAt > 0, 1000);
    const ack = T.said.find((x: any) => x.at >= upAt && x.text === "Got it.");
    assert.ok(ack, "the app answered");
    assert.ok(a.settledAt >= ack.end, "after the answer was heard");
    assert.ok(a.settledAt - ack.end < AT_ONCE_MS, `released ${a.settledAt - ack.end}ms after the answer`);
    assert.equal(a.reply, null);
    assert.ok(logged("window_cut").some((l) => l.sessionId === TERM.sessionId && l.answered && l.leftMs === 0));
    // Words for it a moment later, before the next one is heard: it just spoke.
    let seen: any = null;
    T.utterance = (input: any) => {
      seen = input;
      return { audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 };
    };
    T.routeText = undefined;
    await talk("and push it too");
    assert.equal(seen.waitingId, null);
    assert.equal(seen.justSpoke?.id, TERM.sessionId);
    assert.equal(seen.justSpoke.secondsAgo, 0);
    T.classifierDelayMs = 0;
    T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
    await until(() => saidFor(DESK));
    console.log(`ok: released ${a.settledAt - ack.end}ms after "Got it." was heard; next words saw it just spoke`);
    gone(b);
    await wait(50);
  }

  // 4. A permission prompt's window is never cut.
  {
    begin("permission window untouched");
    await wait(1600);
    const p = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "Bash", tool_input: {} });
    T.hooks.onRequest(p);
    await until(() => caseSaid().some((x: any) => x.text.includes("Allow?")));
    const pAt = Date.now();
    T.needs = [0.04];
    const b = stop(DESK, "claude-desktop");
    T.hooks.onRequest(b);
    await wait(400);
    assert.ok(p.open, "permission prompt still open");
    await until(() => !p.open, 2000);
    near(p.settledAt - pAt, 1000 + T.speakMs, 120);
    console.log(`ok: permission kept its ${p.settledAt - pAt}ms window`);
    await until(() => saidFor(DESK));
    await until(() => !b.open);
  }

  // 5. Routing after the window.
  {
    begin("desktop session after its window: the classifier picks it; not typed, and it says so as for Warp or iTerm");
    await wait(100);
    const cues = cue();
    const ran = T.ran.length;
    const typed = T.typed.length;
    const keys = T.keys.length;
    T.utterance = () => ({ audience: DESK, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    await talk("what about 3 plus 3");
    // The same words as for a session in a terminal Kiko can't find: it spoke before, so its window
    // closed. (tmux isn't ready here, so no "Start it with kiko claude": tests/unit/core/reach.test.ts.)
    await until(
      () => spoke("Its reply window closed. Reply to 2 plus 2 in its window."),
      3000,
      () =>
        caseLines()
          .map((l) => `${l.kind}: ${l.text}`)
          .join(" | "),
    );
    assert.ok(info("(not sent to 2 plus 2: nothing can type into it now)"));
    assert.equal(notSent("desk-1").at(-1)?.text, "what about 3 plus 3", "what wasn't sent is logged");
    assert.equal(T.typed.length, typed, "nothing typed");
    assert.equal(T.keys.length, keys, "no keys");
    await wait(300);
    assert.equal(cue(), cues, "no 'sent' beep");
    console.log(
      "ok: not sent, said;",
      caseLines()
        .map((l) => `${l.kind}: ${l.text}`)
        .join(" | "),
    );

    begin("busy desktop session: the same, nothing queued");
    DESK.status = "busy";
    await talk("and 4 plus 4");
    await until(() => notSent("desk-1").at(-1)?.text === "and 4 plus 4");
    assert.equal(T.typed.length, typed);
    DESK.status = "idle";
    console.log("ok");

    begin("terminal unchanged");
    T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    await talk("run the tests");
    assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "run the tests" });
    assert.ok(spoke("To atlas agents.") && info("→ typed into atlas-agents"));
    console.log("ok: typed into Ghostty");

    begin("router pass_on and ask_session to the desktop session: not sent, said");
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    T.route = (input: any) => {
      assert.ok(input.sessions.some((s: any) => s.sessionId === "desk-1"));
      return [{ name: "pass_on", session: DESK }];
    };
    const typed2 = T.typed.length;
    await talk("tell it to add 5");
    // The direction to the session ("tell it to") is taken off before it goes (src/core/direction.ts), as it would
    // be for a terminal: what wasn't sent is what would have been typed.
    await until(() => notSent("desk-1").at(-1)?.text === "Add 5");
    assert.ok(spoke("Its reply window closed. Reply to 2 plus 2 in its window."));
    T.route = () => [{ name: "ask_session", session: DESK, message: "What's next? Give me a short status." }];
    await talk("ask the other one what's next");
    // The router's own words ("Give me a short status.", not said) are cut (src/core/router-words.ts).
    await until(() => notSent("desk-1").at(-1)?.text === "What's next?");
    assert.equal(T.typed.length, typed2);
    console.log("ok: pass_on and ask_session aren't typed into the desktop app");

    begin("stop and rename stay out of reach");
    ui.act({ type: "set", key: "voiceCan", value: "everything" }); // the default, but cases above may have changed it
    T.route = () => [{ name: "stop_session", session: DESK }];
    await talk("stop the 2 plus 2 one");
    assert.ok(spoke("2 plus 2 is in the desktop app, so I can't stop it from here."));
    T.route = () => [{ name: "rename_session", session: DESK, newName: "sums" }];
    await talk("call it sums");
    await until(() => spoke("2 plus 2 is in the desktop app, so I can't rename it from here."));
    assert.equal(T.typed.length, typed2);
    ui.act({ type: "set", key: "voiceCan", value: "messages" });
    console.log("ok: stop and rename say they can't");

    begin("within its window a desktop session still replies through the hook");
    T.utterance = () => ({ audience: DESK, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    T.needs = [0.8];
    const a = stop(DESK, "claude-desktop");
    T.hooks.onRequest(a);
    await windowOpen(DESK);
    const refused = notSent("desk-1").length;
    await talk("now 7 plus 7");
    assert.equal(a.reply, "now 7 plus 7");
    assert.equal(notSent("desk-1").length, refused);
    assert.equal(T.typed.length, typed2);
    console.log("ok: hook reply");

    begin("no clipboard: nothing above ran a clipboard command, nor any osascript for the desktop app");
    assert.ok(T.ran.length >= ran);
    assert.deepEqual(clipboardRuns(), []);
    assert.deepEqual(
      T.ran.slice(ran).filter((r: any) => ["pbcopy", "pbpaste", "osascript", "open"].includes(r.program)),
      [],
    );
    console.log("ok:", T.ran.length - ran, "programs run, none for the clipboard");
  }

  // 5b. A session whose terminal shows Claude Code's agents list (parked with ←: src/terminals/ghostty
  // matchWindow "agents", and tmux's pane title the same way). Words for such a session weren't typed in,
  // the line said only "I can't tell which terminal is Lacy", and they had to be said again in full.
  {
    begin("terminal on the agents list: listed again, not typed, said why with 'try again'; 'try again' sends the same words once it's open");
    const LACY = {
      sessionId: "lacy-1",
      name: "Lacy",
      givenName: "Lacy",
      title: "",
      kind: "interactive",
      status: "waiting",
      lastActiveAt: 0,
      cwd: "/nonexistent/lacy-platform",
      place: null as any,
      mapping: "agents",
      desktop: false,
    };
    T.sessions = [...T.sessions, LACY];
    const typed = T.typed.length;
    T.utterance = () => ({ audience: LACY, audienceConfidence: 0.95, intent: "other", intentConfidence: 0.1 });
    await talk("what's next on that project");
    const line = "I couldn't reach Lacy: its terminal is showing Claude Code's agents list, so I didn't type that in. Open Lacy there first. Say try again to send it.";
    await until(
      () => spoke(line),
      3000,
      () =>
        caseLines()
          .map((l) => `${l.kind}: ${l.text}`)
          .join(" | "),
    );
    assert.equal(T.typed.length, typed, "nothing typed into the agents list");
    assert.ok(
      caseLog().some((l) => l.event === "type_relisted" && l.sessionId === "lacy-1" && l.mapping === "agents"),
      "listed once more before giving up",
    );
    const failed = notSent("lacy-1").at(-1);
    assert.equal(failed?.text, "what's next on that project");
    assert.equal(failed?.said, line, "what was said is logged with it");
    // Opened there again: its title is its name, and "try again" sends the words kept.
    // Words that didn't reach it are never taken as delivered (timeline Entry.notSent): the models see
    // them as not sent, and they aren't what Lacy was last asked.
    let seen: any = null;
    T.utterance = (input: any) => {
      seen = input;
      return { audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 };
    };
    T.route = () => [];
    await talk("hmm, hold on");
    const about = seen.recent.filter((l: string) => l.endsWith(": what's next on that project"));
    assert.ok(about.length === 1 && / \(not sent\): /.test(about[0]), seen.recent.join("\n"));
    assert.notEqual(seen.sessions.find((i: any) => i.session.sessionId === "lacy-1")?.asked, "what's next on that project");
    Object.assign(LACY, { place: ghostty("ghostty-lacy"), mapping: "title" });
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    T.route = () => assert.fail("'try again' is read in code");
    await talk("try again");
    await until(() => T.typed.length > typed);
    assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-lacy", text: "what's next on that project" });
    T.sessions = T.sessions.filter((s: any) => s !== LACY);
    T.route = () => [];
    console.log(
      "ok:",
      caseLines()
        .map((l) => `${l.kind}: ${l.text}`)
        .join(" | "),
    );
  }

  // 6. Held finished turns: words for one go through its hook; typing into one lets it go.
  writeFileSync(TRANSCRIPT, `{"type":"user","message":"hi"}\n${enqueue("typed long before the hold")}`);
  {
    // You pressed to ask a second question, the
    // session finished its answer to your first while you talked, and your words went to it. Its answer was
    // dropped, never read out. Now it's read out first, then your words reach it through its hook.
    begin("words for a session whose turn is queued: its answer read out first, then your words through its hook");
    await wait(1700); // the last window runs out
    T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    T.needs = [0.88];
    const typed = T.typed.length;
    const b = held(TERM);
    T.heard = "make sure we type into the right window";
    T.hotkey.onDown();
    await wait(20);
    T.hooks.onRequest(b); // finishes while you talk: queued, not announced
    await wait(20);
    assert.ok(b.open);
    await T.hotkey.onUp();
    assert.ok(b.open, "not before its answer is read out");
    assert.ok(info("(→ atlas-agents once its answer is read out)"));
    await until(() => !b.open, 2000);
    assert.deepEqual(
      caseSaid().map((x: any) => x.text),
      ["To atlas agents.", "summary for atlas-agents"],
      "where your words go, said as before; then its answer",
    );
    assert.equal(b.reply, "make sure we type into the right window");
    const reading = saidFor(TERM);
    assert.ok(reading, "its answer was read out");
    assert.ok(reading.end && b.settledAt >= reading.end, "your words went once it had been heard");
    assert.ok(b.settledAt - reading.end < 100, `${b.settledAt - reading.end}ms after its reading`);
    assert.equal(T.typed.length, typed, "nothing typed");
    assert.ok(info("→ atlas-agents"));
    assert.ok(!caseLines().some((l) => l.text.startsWith("(no reply")), "no window opened for it");
    const ah = caseLog().find((l) => l.event === "answered_held");
    assert.deepEqual([ah?.readFirst, ah?.hookOpen], [true, true]);
    assert.ok(caseLog().some((l) => l.event === "held_reply" && l.text === "make sure we type into the right window"));
    console.log(
      `ok: read out, then the words ${b.settledAt - reading.end}ms after;`,
      caseLines()
        .filter((l) => l.kind !== "timing")
        .map((l) => `${l.kind}: ${l.text}`)
        .join(" | "),
    );

    begin("queued behind another session's window: the waiting one let go (heard), the queued one read out, then your words");
    await wait(100);
    T.needs = [0.8, 0.88];
    const a = stop(DESK, "claude-desktop");
    T.hooks.onRequest(a);
    await windowOpen(DESK);
    const c = held(TERM);
    T.hooks.onRequest(c); // waits behind 2 plus 2's window
    await wait(20);
    assert.ok(a.open && c.open && !announced(TERM));
    T.heard = "and check the other window too";
    await talk(T.heard);
    assert.equal(a.reply, null, "the waiting one let go");
    assert.ok(c.open);
    await until(() => !c.open, 2000);
    assert.equal(c.reply, "and check the other window too");
    assert.ok(announced(TERM) && c.settledAt >= saidFor(TERM).end);
    assert.equal(T.typed.length, typed);
    console.log("ok: waiting one released, queued one read out, then answered through its hook");

    begin("two in line, words for the second: the first read out (and its window) first, then the second, then your words");
    await wait(100);
    T.needs = [0.8, 0.88];
    const d1 = stop(DESK, "claude-desktop");
    const t2 = held(TERM);
    T.heard = "ship it";
    T.hotkey.onDown();
    await wait(20);
    T.hooks.onRequest(d1);
    T.hooks.onRequest(t2);
    await wait(20);
    await T.hotkey.onUp();
    await until(() => !t2.open, 4000);
    assert.equal(t2.reply, "ship it");
    assert.equal(d1.reply, null, "the first got no reply: its window ran out");
    const first = saidFor(DESK);
    const second = saidFor(TERM);
    assert.ok(first && second, "both read out");
    assert.ok(first.at < second.at, "in their order in line");
    assert.ok(d1.settledAt <= second.at, "the first let go before the second was read");
    assert.ok(t2.settledAt >= second.end, "your words after the second was heard");
    console.log(
      `ok: ${caseSaid()
        .map((x: any) => x.text)
        .join(" → ")} → words`,
    );

    begin("its hook went away while queued: still read out, then your words typed in");
    await wait(100);
    T.needs = [0.88];
    const g = held(TERM);
    const before = T.typed.length;
    T.heard = "and tag the release";
    T.hotkey.onDown();
    await wait(20);
    T.hooks.onRequest(g);
    await wait(20);
    gone(g); // its hook timed out while it waited in line
    await T.hotkey.onUp();
    await until(() => T.typed.length > before, 3000);
    assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "and tag the release" });
    assert.ok(announced(TERM), "its answer was read out");
    assert.ok(caseLog().some((l) => l.event === "hook_closed_unheard" && l.queued));
    assert.ok(info("→ typed into atlas-agents"));
    console.log(
      "ok:",
      caseLines()
        .filter((l) => l.kind !== "timing")
        .map((l) => `${l.kind}: ${l.text}`)
        .join(" | "),
    );
  }
  {
    begin("window open: still through the hook");
    T.needs = [0.8];
    const b = held(TERM);
    T.hooks.onRequest(b);
    await windowOpen(TERM);
    const typed = T.typed.length;
    await talk("go ahead");
    assert.equal(b.reply, "go ahead");
    assert.equal(T.typed.length, typed);
    console.log("ok: hook reply");
    await wait(100);
  }
  {
    begin("typed in the terminal while its window is open");
    T.needs = [0.8];
    const b = held(TERM);
    T.hooks.onRequest(b);
    await windowOpen(TERM);
    assert.ok(b.open);
    const line = enqueue("I typed this myself");
    appendFileSync(TRANSCRIPT, line.slice(0, 40)); // written in two goes
    await wait(30);
    appendFileSync(TRANSCRIPT, line.slice(40));
    const at = Date.now();
    await until(() => !b.open, 1000);
    assert.equal(b.reply, null);
    assert.ok(b.settledAt - at <= 520, `released ${b.settledAt - at}ms after`);
    assert.ok(info("(you typed in atlas-agents; let it go)"));
    console.log(`ok: released ${b.settledAt - at}ms after the queued prompt was written`);
  }
  {
    begin("typed in the terminal while queued (behind a permission prompt)");
    await wait(100);
    const p = new HookRequest({ hook_event_name: "PermissionRequest", session_id: DESK.sessionId, cwd: DESK.cwd, tool_name: "Bash", tool_input: {} });
    T.hooks.onRequest(p);
    await until(() => caseSaid().some((x: any) => x.text.includes("Allow?")));
    const b = held(TERM);
    T.hooks.onRequest(b);
    await wait(50);
    assert.ok(b.open && p.open);
    appendFileSync(TRANSCRIPT, enqueue("typed while it was queued"));
    const at = Date.now();
    await until(() => !b.open, 1000);
    assert.equal(b.reply, null);
    assert.ok(b.settledAt - at <= 520, `released ${b.settledAt - at}ms after`);
    assert.ok(p.open, "permission prompt untouched");
    await until(() => !p.open, 2000);
    await wait(200);
    assert.ok(!announced(TERM), "never announced");
    console.log(`ok: released ${b.settledAt - at}ms after, unannounced; permission kept its window`);
  }
  {
    begin("the app's own typing doesn't count");
    await wait(100);
    T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    await talk("run the linter");
    assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "run the linter" });
    T.needs = [0.8];
    const b = held(TERM);
    T.hooks.onRequest(b);
    appendFileSync(TRANSCRIPT, enqueue("run  the linter")); // its record lands after the hold began
    await until(() => saidFor(TERM));
    await wait(T.speakMs + 600);
    assert.ok(b.open, "still held: that was the app's typing");
    appendFileSync(TRANSCRIPT, enqueue("run the linter")); // the same words again: now they're yours
    await until(() => !b.open, 1000);
    assert.equal(b.reply, null);
    console.log("ok: own typing ignored once; a later prompt released it");
  }
  {
    // A long dictation reaches Claude Code as a paste, and its queued prompt comes back between two
    // lines of Claude Code's own (core/dictated.ts unpasted): still the app's typing.
    begin("the app's own long dictation, queued as a paste, doesn't count");
    await wait(100);
    T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
    const long = "check the build\nthen the tests";
    await talk(long);
    assert.equal(T.typed.at(-1)?.terminalId, "ghostty-1");
    T.needs = [0.8];
    const b = held(TERM);
    T.hooks.onRequest(b);
    const pasted = (id: string) => enqueue(`\n\n<pasted_content id="${id}">\n${T.typed.at(-1).text}\n</pasted_content id="${id}">\n`);
    appendFileSync(TRANSCRIPT, pasted("ec41"));
    await until(() => saidFor(TERM));
    await wait(T.speakMs + 600);
    assert.ok(b.open, "still held: that was the app's typing, wrapped");
    appendFileSync(TRANSCRIPT, pasted("ec42")); // the same paste again: now it's yours
    await until(() => !b.open, 1000);
    assert.equal(b.reply, null);
    console.log("ok: own long dictation ignored, wrapped in Claude Code's paste lines; the same pasted again released it");
  }

  const log = readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(
    "\nwindow_cut logs:",
    log
      .filter((l) => l.event === "window_cut")
      .map((l) => `${l.sessionId} needs ${l.needsUser} left ${l.leftMs}ms`)
      .join("; "),
  );
  console.log(
    "answered_held:",
    log
      .filter((l) => l.event === "answered_held")
      .map((l) => `${l.sessionId}: ${l.text}`)
      .join("; "),
  );
  console.log(
    "typed_in:",
    log
      .filter((l) => l.event === "typed_in")
      .map((l) => `${l.sessionId} announced ${l.announced}: ${l.text}`)
      .join("; "),
  );
  assert.equal(log.filter((l) => l.event === "answered_held").length, 4);
  assert.equal(log.filter((l) => l.event === "typed_in").length, 4);
  console.log(
    "announce windows:",
    log
      .filter((l) => l.event === "announce")
      .map((l) => `${l.folder}:${l.reach}:${l.windowMs}`)
      .join(" "),
  );
}

// 16. The waiting session's window in the UI and the state file: "speaking" / "listening" and no seconds while the
//     app speaks or you talk, then a countdown from when the speech ended that doesn't start over. Before, `until`
//     was now + the window on every update while speaking, so the panel read "waiting 6s" throughout.
export async function windowCases() {
  await wait(2100);
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const phase = () => [ui.state.waiting?.phase, ui.state.waiting?.until];

  begin("window: held while it's said, then counts down from the end without starting over");
  T.needs = [0.8];
  T.speakMs = 300;
  const r = stop(TERM, "cli");
  T.hooks.onRequest(r);
  await until(() => Boolean(saidFor(TERM)?.start));
  await wait(50);
  assert.deepEqual(phase(), ["speaking", null]);
  assert.deepEqual([state().waiting.phase, state().waiting.until], ["speaking", null]);
  await until(() => ui.state.waiting?.until != null, 1000);
  const end = saidFor(TERM).end;
  const deadline = ui.state.waiting!.until!;
  near(deadline - end, 1500, 40);
  await wait(200);
  assert.deepEqual(phase(), ["waiting", deadline], "the same deadline: no starting over");
  assert.equal(state().waiting.until, deadline);

  T.heard = "";
  T.hotkey.onDown();
  await until(() => phase()[0] === "listening");
  assert.deepEqual(phase(), ["listening", null]);
  await T.hotkey.onUp();
  await until(() => ui.state.waiting?.until != null, 1000);
  assert.equal(ui.state.waiting!.phase, "waiting");
  await until(() => !r.open, 3000);
  T.speakMs = 50;
  console.log(`ok: window ${deadline - end}ms from the end of the speech`);

  begin("key up: speech to text fails; the mic level and the live words clear all the same");
  T.hotkey.onDown();
  T.mic(Buffer.alloc(3200, 0x40)); // loud
  T.stt.onInterim("run the");
  assert.ok(ui.state.level > 0.5, `level ${ui.state.level}`);
  assert.equal(ui.state.interim, "run the");
  T.sttFails = new Error("stt down");
  await T.hotkey.onUp();
  T.sttFails = null;
  assert.ok(caseLines().some((l) => l.text === "(couldn't hear that: stt down)"));
  assert.deepEqual([ui.state.level, ui.state.interim], [0, ""]);
  console.log("ok");
}

// 12. A stop came in, you pressed 0.2s later,
//     before any sound, and said nothing. The announcement was dropped and the hook let go when the
//     window ran out. Now a press before the first sound puts it back; after it, it's a barge-in.
export async function deferredCases() {
  await wait(2100); // windows and the session list cache run out
  const NEW = { ...TERM, sessionId: "def-1", name: "def", cwd: "/nonexistent/deferred-thing", place: ghostty("ghostty-def") };
  const before = T.sessions;
  T.sessions = [DESK, TERM, NEW];
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const logged = (event: string) =>
    readFileSync(logFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === event);
  const said = () => caseSaid().filter((x: any) => x.text === "summary for deferred-thing");
  const asked = () => caseSaid().filter((x: any) => x.text.includes("Allow?"));
  const shownLines = (kind: string, text: string) => lines.filter((l) => l.kind === kind && l.text === text).length;
  const stopOf = (text: string) => new HookRequest({ ...stop(NEW, "cli").event, last_assistant_message: text });
  const typedInto = () => T.typed.filter((t: any) => t.terminalId === "ghostty-def").length;
  const toApp = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.utterance = toApp;
  T.route = () => [];

  begin("pressed before the first sound, nothing said: it plays on key up");
  T.needs = [0.88, 0.88];
  T.classifierDelayMs = 200; // the classifier answered 0.34s in; you pressed at 0.2s
  const deferred = logged("announce_deferred").length;
  const summaries = (T.summaries ?? []).length;
  const a = stopOf("A: the no question fix is in");
  T.hooks.onRequest(a);
  await wait(50);
  assert.equal(said().length, 0, "no sound yet");
  assert.equal(state().waiting?.sessionId, NEW.sessionId);
  T.heard = "";
  T.hotkey.onDown();
  await wait(20);
  assert.equal(state().waiting, null, "put back in the queue: nothing waiting for your reply");
  await wait(300); // the classifier answers meanwhile: that announcement stays dropped
  assert.equal(said().length, 0, "not while you hold the key");
  assert.ok(a.open, "still held");
  const upAt = Date.now();
  await T.hotkey.onUp();
  assert.ok(info("(nothing heard)"));
  await until(() => said().length > 0, 1000);
  const afterUp = said()[0].at - upAt;
  assert.ok(afterUp < 400, `played ${afterUp}ms after key up`);
  assert.equal(state().waiting?.sessionId, NEW.sessionId, "waiting for your reply once it's heard");
  const d = logged("announce_deferred");
  assert.equal(d.length, deferred + 1);
  assert.equal(d.at(-1).sessionId, NEW.sessionId);
  assert.equal(d.at(-1).kind, "stop");
  assert.equal(shownLines("session", "A: the no question fix is in"), 1, "the reply shown once");
  const [first, again] = T.summaries.slice(summaries);
  assert.equal(T.summaries.length, summaries + 2);
  assert.ok(first.nameSession && again.nameSession, "named again: nothing was heard the first time");
  assert.deepEqual(again.context, first.context, "the same context, not its own reply");
  await until(() => !a.open, 3000); // no reply: the window runs out after it was heard
  assert.equal(a.reply, null);
  assert.equal(said().length, 1);
  assert.equal(logged("announce").filter((l) => l.sessionId === NEW.sessionId).length, 1, "one announce log, the one heard");
  console.log(
    `ok: deferred ${d.at(-1).afterMs}ms in, played ${afterUp}ms after key up;`,
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("pressed once it's making a sound: a barge-in, cut as before");
  T.classifierDelayMs = 0;
  T.needs = [0.88];
  T.speakMs = 300;
  const b = stopOf("B: done with the parser");
  T.hooks.onRequest(b);
  await until(() => said().length > 0);
  await wait(200); // sound started 5ms after: past its first moments (UNHEARD_MS, 150ms here)
  T.heard = "";
  T.hotkey.onDown();
  await wait(20);
  await T.hotkey.onUp();
  await wait(400);
  T.speakMs = 50;
  assert.equal(said().length, 1, "not made again");
  assert.equal(logged("announce_deferred").length, deferred + 1, "nothing deferred");
  assert.ok(b.open, "still waiting: the window starts over on key up, as before");
  await until(() => !b.open, 3000);
  assert.equal(b.reply, null);
  console.log("ok");

  // Claude speech's window closed, Clipkit's announcement
  // started, and 0.4s into it you answered Claude speech. Clipkit counted as waiting, so the words went to it.
  // Now a press in its first 1.5s of sound (150ms here) puts it back like one before any sound.
  const announceAfterAnother = async (text: string) => {
    T.needs = [0.8, 0.88];
    T.speakMs = 300;
    const prev = stop(TERM, "cli");
    T.hooks.onRequest(prev);
    await until(() => saidFor(TERM));
    const r = stopOf(text);
    T.hooks.onRequest(r); // in line behind it
    await until(() => !prev.open, 3000); // no reply: its window closes, and this one is announced
    await until(() => Boolean(said()[0]?.start), 1000);
    return { prev, r };
  };
  const toWhoSpoke = (input: any) => {
    seen = input;
    return { audience: input.justSpoke?.id === TERM.sessionId ? TERM : NEW, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  let seen: any = null;

  begin("pressed 0.4s into the next announcement: put back, cut, and the words go to the one before");
  T.utterance = toWhoSpoke;
  const deferredBefore = logged("announce_deferred").length;
  const termTyped = T.typed.filter((t: any) => t.terminalId === TERM.place.id).length;
  const { prev: p1, r: ee } = await announceAfterAnother("E: the restart isn't needed");
  await wait(40);
  const cutAt = Date.now();
  await talk("Yeah, let's skip the restart.");
  const cut = said()[0];
  assert.ok(cut.end - cut.start < 150, `cut ${cut.end - cut.start}ms in`);
  assert.ok(cut.end - cutAt < AT_ONCE_MS, `cut by the press: ${cut.end - cutAt}ms after it`);
  const dd = logged("announce_deferred");
  assert.equal(dd.length, deferredBefore + 1);
  assert.equal(dd.at(-1).sessionId, NEW.sessionId);
  assert.equal(dd.at(-1).reason, "press");
  assert.ok(dd.at(-1).afterSoundMs >= 30 && dd.at(-1).afterSoundMs < 150, `${dd.at(-1).afterSoundMs}ms into its sound`);
  assert.equal(seen.waitingId, null, "not waiting: you hadn't heard it");
  assert.equal(seen.justSpoke?.id, TERM.sessionId, "the one before it just spoke");
  assert.equal(p1.reply, null);
  const termNow = T.typed.filter((t: any) => t.terminalId === TERM.place.id);
  assert.equal(termNow.length, termTyped + 1);
  assert.equal(termNow.at(-1).text, "Yeah, let's skip the restart.");
  assert.ok(ee.open, "still held, not answered");
  await until(() => said().length === 2, 1000); // made again once your words are dealt with
  await until(() => !ee.open, 3000);
  assert.equal(ee.reply, null);
  T.speakMs = 50;
  console.log(`ok: put back ${dd.at(-1).afterSoundMs}ms into its sound; words typed into atlas-agents; made again after`);

  begin("pressed 2s into the announcement: a barge-in, the words answer it");
  await wait(2100); // the session list cache runs out
  markHere();
  const deferredNow = logged("announce_deferred").length;
  const { r: ff } = await announceAfterAnother("F: want me to restart it?");
  await wait(200);
  T.utterance = (input: any) => {
    seen = input;
    return { audience: NEW, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  await talk("yes restart it");
  assert.equal(logged("announce_deferred").length, deferredNow, "nothing put back");
  assert.equal(seen.waitingId, NEW.sessionId);
  assert.equal(ff.reply, "yes restart it");
  assert.equal(said().length, 1, "not made again");
  T.speakMs = 50;
  T.utterance = toApp;
  console.log("ok");

  begin("pressed before the first sound, then words for that session: read out first, then its reply, through the hook");
  T.classifierDelayMs = 200;
  T.needs = [0.88, 0.88];
  const c = stopOf("C: shall I commit?");
  T.hooks.onRequest(c);
  await wait(50);
  T.utterance = (input: any) => {
    seen = input;
    return { audience: NEW, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  const typed = typedInto();
  const held = logged("answered_held").length;
  await talk("yes commit it");
  assert.equal(seen.waitingId, null, "unheard: queued, not waiting");
  assert.ok(c.open, "not before it's read out");
  await until(() => !c.open, 2000);
  assert.equal(c.reply, "yes commit it");
  assert.equal(said().length, 1, "read out once, before your words");
  assert.ok(c.settledAt >= said()[0].end);
  assert.equal(typedInto(), typed, "nothing typed");
  assert.equal(logged("answered_held").length, held + 1);
  assert.equal(logged("answered_held").at(-1).readFirst, true);
  T.utterance = (input: any) => ((seen = input), toApp());
  await talk("what time is it");
  // In the timeline once, as heard (its summary), ahead of your words.
  const recentLines = seen.recent as string[];
  const mine = recentLines.indexOf("you → deferred-thing: yes commit it");
  assert.equal(recentLines[mine - 1], "app said (about deferred-thing): summary for deferred-thing", recentLines.join("\n"));
  assert.equal(recentLines.slice(recentLines.indexOf("you → deferred-thing: yes restart it") + 1).filter((l) => l.includes("deferred-thing): ")).length, 1, recentLines.join("\n"));
  assert.equal(shownLines("session", "C: shall I commit?"), 1);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("pressed before the first sound, words for another session: sent, then it's announced");
  T.needs = [0.88];
  const e = stopOf("E: tests pass");
  T.hooks.onRequest(e);
  await wait(50);
  T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk("what about 11 plus 11");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "what about 11 plus 11" });
  assert.equal(said().length, 0, "not before your words are dealt with");
  await until(() => said().length > 0, 2000);
  assert.ok(e.open);
  gone(e);
  await wait(50);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("a permission prompt pressed over before it made a sound: your words aren't its answer; asked after");
  await wait(100);
  const p = new HookRequest({ hook_event_name: "PermissionRequest", session_id: NEW.sessionId, cwd: NEW.cwd, tool_name: "Bash", tool_input: {} });
  T.hooks.onRequest(p);
  await wait(50);
  assert.equal(asked().length, 0);
  assert.equal(state().waiting?.kind, "permission");
  const n = T.typed.length;
  await talk("and 12 plus 12");
  assert.equal(T.typed.length, n + 1, "went where it was meant");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "and 12 plus 12" });
  assert.ok(p.open);
  await until(() => asked().length > 0, 2000);
  assert.equal(caseLines().filter((l) => l.kind === "permission" && l.text === "use Bash").length, 1, "shown once");
  assert.equal(logged("announce_deferred").at(-1).kind, "permission");
  await until(() => !p.open, 3000);
  assert.equal(p.reply, null, "no answer: it waits in the terminal");
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("a permission prompt comes in before the finished turn made a sound: asked first, the turn after");
  T.classifierDelayMs = 200;
  T.needs = [0.88];
  const deferredN = logged("announce_deferred").length;
  const summariesN = T.summaries.length;
  const f = stopOf("F: lint is clean");
  T.hooks.onRequest(f);
  await wait(50); // the classifier still thinking, no sound
  const q = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "Bash", tool_input: {} });
  T.hooks.onRequest(q);
  assert.ok(f.open, "not let go");
  const fd = logged("announce_deferred");
  assert.equal(fd.length, deferredN + 1);
  assert.deepEqual([fd.at(-1).sessionId, fd.at(-1).kind, fd.at(-1).reason], [NEW.sessionId, "stop", "permission"]);
  await until(() => asked().length > 0, 2000);
  assert.equal(said().length, 0, "the question first");
  assert.equal(state().waiting?.kind, "permission");
  await until(() => !q.open, 3000); // no answer: it waits in the terminal
  await until(() => said().length > 0, 2000);
  // In the same millisecond, often: the prompt is let go, then drain() announces the turn at once.
  assert.ok(said()[0].at >= q.settledAt, `the finished turn after (${said()[0].at - q.settledAt}ms)`);
  assert.ok(f.open);
  assert.equal(state().waiting?.sessionId, NEW.sessionId);
  assert.equal(ui.state.targetId, NEW.sessionId, "replies go to it now");
  assert.ok(!info("(a permission prompt came in)"));
  assert.equal(shownLines("session", "F: lint is clean"), 1, "the reply shown once");
  assert.equal(caseLines().filter((l) => l.text.startsWith("Classifier: worth saying")).length, 1, "the classifier asked once, its line once");
  assert.equal(T.summaries.length, summariesN + 2);
  assert.equal(T.summaries.at(-1).nameSession, true, "named: the question was another session's");
  await until(() => !f.open, 3000);
  assert.equal(f.reply, null);
  assert.equal(said().length, 1);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin('"skip that" over an announcement before you heard it: not made, its session let go; the next is announced');
  T.classifierDelayMs = 200;
  T.needs = [0.88, 0.8];
  let classifierAsked = false;
  T.utterance = () => ((classifierAsked = true), toApp());
  const k = stopOf("K: refactored the parser");
  T.hooks.onRequest(k);
  const nextUp = stop(TERM, "cli");
  T.hooks.onRequest(nextUp); // in line behind it
  await wait(50); // no sound yet
  await talk("Skip that.");
  assert.equal(k.reply, null, "let go, no reply");
  assert.ok(!classifierAsked, "no models");
  assert.ok(info("(skipped deferred-thing)"));
  const dropped = logged("announce_dropped").at(-1);
  assert.deepEqual([dropped.sessionId, dropped.reason], [NEW.sessionId, "skipped"]);
  assert.equal(logged("skip").at(-1).skipped, true);
  await until(() => Boolean(saidFor(TERM)), 2000);
  await wait(300);
  assert.equal(said().length, 0, "never made");
  gone(nextUp);
  T.classifierDelayMs = 0;
  T.utterance = toApp;
  await wait(100);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin('"skip that" with nothing you haven\'t heard: words like any others');
  T.utterance = (input: any) => ((seen = input), toApp());
  seen = null;
  await talk("Skip that.");
  assert.ok(seen, "decided as usual");
  assert.ok(!caseLog().some((l) => l.event === "skip"));
  console.log("ok");

  begin("pressed after the summary showed, before its first sound: shown once, the same words");
  T.classifierDelayMs = 0;
  T.needs = [0.88];
  T.soundDelayMs = 200;
  const summariesG = T.summaries.length;
  const g = stopOf("G: migrations ran");
  T.hooks.onRequest(g);
  await until(() => said().length > 0);
  await wait(30); // shown, no sound yet
  assert.ok(caseLines().some((l) => l.kind === "spoken" && l.text === "summary for deferred-thing"));
  T.heard = "";
  T.hotkey.onDown();
  await wait(20);
  T.soundDelayMs = 5;
  await T.hotkey.onUp();
  await until(() => said().length > 1, 1000);
  assert.equal(logged("announce_deferred").at(-1).reason, "press");
  assert.equal(caseLines().filter((l) => l.kind === "spoken").length, 1, "the summary shown once");
  assert.equal(caseLines().filter((l) => l.text.startsWith("Classifier: worth saying")).length, 1);
  assert.equal(T.summaries.length, summariesG + 1, "not summarized again");
  assert.equal(said()[1].text, "summary for deferred-thing");
  assert.equal(
    logged("announce")
      .filter((l) => l.sessionId === NEW.sessionId)
      .at(-1).llmCost,
    0,
  );
  await until(() => !g.open, 3000);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  T.classifierDelayMs = 0;
  T.sessions = before;
}

// What a finished turn's summary is told you said to the session during the turn.
export async function askedCases() {
  // A request for a joke, sent to Kiko while it was busy, was
  // answered at the top of a long status reply, and the summary left the joke out. The summary now gets your
  // words to the session during the turn, from its transcript: a message taken in mid-turn (a queued command)
  // too, which the app may never have seen (typed by hand). An earlier turn's words aren't this turn's.
  begin("a finished turn's summary gets your words to it during the turn, mid-turn ones too");
  await wait(1700); // the last window runs out
  const path = `${process.cwd()}/joke-transcript.jsonl`;
  const entries = [
    { type: "user", message: { role: "user", content: "An earlier turn's ask." } },
    { type: "system", subtype: "stop_hook_summary" },
    { type: "system", subtype: "turn_duration" },
    { type: "user", message: { role: "user", content: "Merge the word-loss fix." } },
    { type: "attachment", attachment: { type: "queued_command", prompt: "Tell me a short joke." } },
  ];
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  T.needs = [0.1];
  const summaries = (T.summaries ?? []).length;
  const r = new HookRequest({ ...stop(TERM, "cli").event, transcript_path: path });
  T.hooks.onRequest(r);
  await until(() => (T.summaries ?? []).length > summaries);
  assert.deepEqual(T.summaries.at(-1).asked, ["Merge the word-loss fix.", "Tell me a short joke."]);
  await until(() => !r.open, 3000);
  console.log("ok");
}
