// What's heard and when: beeps and speech taking turns, mute, ducking, and hands-free.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { begin, caseLines, caseLog, casePlayed, caseSaid, DESK, ghostty, gone, info, logFile, mark, markHere, SOUNDS, spoke, stop, T, talk, TERM, ui, until, wait, windowOpen } from "../driver.ts";

// 15. Beeps and speech take turns (src/core/audio-queue.ts): a beep never plays over the voice or between its chunks,
//     and a speech asked for while one plays starts after it. The "sent" beep is only for sends nothing was said
//     about: after "Asking atlas agents." it was one sound too many, and it came out inside the line (typing ends
//     ~150ms after the line is asked for, as its first audio arrives). T.played has each beep's timing, T.said each line's.
export async function audioCases() {
  await wait(2100); // windows and the session list cache run out
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  ui.act({ type: "set", key: "holdUnsure", value: false });
  const sentBeeps = () => casePlayed().filter((p: any) => p.pcm === SOUNDS.sent);
  const listenBeep = () =>
    casePlayed()
      .filter((p: any) => p.pcm === SOUNDS.listening)
      .at(-1);
  const toTerm = () => (T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 }));
  const typedN = () => T.typed.length;

  begin("audio: 'Asking atlas agents.' with the typing alongside: no beep");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "ask_session", session: TERM, message: "How are the tests going?" }];
  T.typeMs = 150;
  await talk("ask atlas agents how the tests are going");
  assert.deepEqual(T.typed.at(-1), { terminalId: TERM.place.id, text: "How are the tests going?" });
  assert.ok(spoke("Asking atlas agents."));
  await wait(T.speakMs + 300);
  assert.equal(sentBeeps().length, 0, "the line said where it went");
  console.log("ok: said where, no beep");

  begin("audio: a silent send still beeps, after the press's own beep");
  toTerm(); // atlas agents is where replies go since the ask: nothing to say
  let n = typedN();
  await talk("and run the linter");
  assert.equal(T.typed.length, n + 1);
  assert.ok(!spoke("To atlas agents."));
  await until(() => sentBeeps().length === 1, 1000);
  assert.ok(sentBeeps()[0].at >= listenBeep().end, "not over the listening beep");
  console.log(`ok: beeped ${sentBeeps()[0].at - listenBeep().end}ms after the listening beep ended`);

  begin("audio: a 'sent' beep asked for while the app speaks plays after the line");
  T.speakMs = 400;
  n = typedN();
  let going = talk("and check the build");
  await until(() => T.typing > 0); // key up, the words being typed
  ui.act({ type: "repeat" }); // . in the window's list: the last line again, while the typing goes on
  await going;
  assert.equal(T.typed.length, n + 1);
  let line = caseSaid().at(-1);
  assert.ok(line.start >= listenBeep().end, `the line waited for the press's beep (${line.start - listenBeep().end}ms)`);
  assert.equal(sentBeeps().length, 0, "not while it's said");
  await until(() => sentBeeps().length === 1, 2000);
  assert.ok(sentBeeps()[0].at >= line.end, `beep ${sentBeeps()[0].at - line.end}ms after the line ended`);
  console.log(`ok: line ${line.start - mark}–${line.end - mark}ms, beep at ${sentBeeps()[0].at - mark}ms`);

  begin("audio: a press clears a beep still waiting for the line");
  n = typedN();
  going = talk("and the docs too");
  await until(() => T.typing > 0);
  ui.act({ type: "repeat" });
  await going;
  assert.equal(T.typed.length, n + 1); // the beep is asked for, behind the line
  line = caseSaid().at(-1);
  T.heard = "";
  T.hotkey.onDown();
  await wait(20);
  await T.hotkey.onUp();
  await until(() => line.end != null);
  assert.ok(line.end - line.start < 400, "the line was cut");
  await until(() => Date.now() > line.start + T.speakMs + 200); // past where it would have ended, and its beep played
  assert.equal(sentBeeps().length, 0, "the press dropped it");
  console.log("ok: cut, and no beep after");
  T.speakMs = 50;

  begin("audio: a held send's 'To atlas agents.', then it goes: no beep");
  ui.act({ type: "set", key: "holdUnsure", value: true });
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "pass_on", session: TERM }];
  const term = T.typed.length;
  await talk("tell it to add 9");
  await until(() => T.typed.length === term + 1);
  assert.ok(spoke("To atlas agents."));
  await wait(300);
  assert.equal(sentBeeps().length, 0);
  console.log("ok");

  T.typeMs = 0;
  T.route = () => [];
}

// Mute (m) with the macOS voice, which the harness runs (KIKO_TTS=say): `say` plays by itself and can't be turned down
// mid-line, so for it muting still cuts the line and nothing is said until unmuted; cues are silent; the header
// says "muted". The streamed voices' TV mute (nothing stops, it goes silent) is tests/unit/core/mute.test.ts.
export async function muteCases() {
  await wait(2100);
  const listenBeeps = () => casePlayed().filter((p: any) => p.pcm === SOUNDS.listening);

  begin("mute, the macOS voice: muting cuts the line, nothing is said or beeped while muted, unmuted it speaks");
  T.speakMs = 400;
  ui.act({ type: "repeat" });
  await until(() => Boolean(caseSaid().at(-1)?.start));
  const line = caseSaid().at(-1);
  ui.act({ type: "mute" });
  assert.equal(ui.state.muted, true);
  assert.ok(info("muted"), 'said on screen as "muted"');
  await until(() => line.end != null, 1000);
  assert.ok(line.end - line.start < 300, `cut on mute (${line.end - line.start}ms)`);
  const said = T.said.length;
  ui.act({ type: "repeat" });
  await wait(T.speakMs + 100);
  assert.equal(T.said.length, said, "nothing said while muted");
  T.heard = "";
  await talk("");
  await wait(200);
  assert.equal(listenBeeps().length, 0, "no cue while muted");
  ui.act({ type: "mute" });
  assert.equal(ui.state.muted, false);
  assert.ok(info("unmuted"));
  ui.act({ type: "repeat" });
  await until(() => T.said.length > said, 1000);
  await wait(T.speakMs + 100);
  T.speakMs = 50;
  console.log("ok: cut on mute, silent while muted, speaking again after");
}

// 17. Ducking (src/platform/macos/duck.ts) on a fake volume (stubs/platform/macos/duck.ts): down once the listening cue has been heard (lowered
//     first, the cue would be quieter too), back up as soon as recording is over, tail included (TAIL_MS is 0 here),
//     so what's said next is at full volume. A volume you changed meanwhile is yours. The real volume never moves.
export async function duckCases() {
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const events = (name: string) =>
    readFileSync(logFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === name);

  begin("duck: a crashed run's lowered volume was put back on start");
  const first = T.mac.runs[0];
  assert.deepEqual([first.op, first.args, first.out], ["raise", ["80", "16"], "restored"]);
  assert.ok(events("unduck").some((l) => l.leftover && l.restored && l.volume === 80));
  console.log("ok");

  begin("duck: down after the listening cue, back up when recording ends");
  await wait(100);
  T.mac.volume = 50;
  T.heard = "";
  let runs = T.mac.runs.length;
  T.hotkey.onDown();
  await until(() => T.mac.volume === 10, 1000);
  const cue = casePlayed().find((p: any) => p.pcm === SOUNDS.listening);
  const down = T.mac.runs[runs];
  assert.equal(down.op, "lower");
  assert.ok(down.started >= cue.end - 5, `lowered ${cue.end - down.started}ms before the cue ended`);
  assert.ok(down.started - cue.end < 60, `lowered ${down.started - cue.end}ms after the cue ended`);
  assert.deepEqual(state().ducked, { from: 50, to: 10 }, "the state file keeps it, for a crash");
  await wait(50);
  const up = Date.now();
  await T.hotkey.onUp();
  await until(() => T.mac.volume === 50, 1000);
  const raise = T.mac.runs.at(-1);
  assert.equal(raise.op, "raise");
  assert.ok(raise.started - up < 30, `put back ${raise.started - up}ms after key up`);
  await until(() => state().ducked === null, 1000);
  assert.ok(events("duck").some((l) => l.volume === 50 && l.ducked === 10 && l.level === 20));
  console.log(`ok: lowered ${down.started - cue.end}ms after the cue ended, put back ${raise.started - up}ms after key up`);

  begin("duck: you turned it up while talking: it stays where you put it");
  T.hotkey.onDown();
  await until(() => T.mac.volume === 10, 1000);
  T.mac.volume = 70;
  await T.hotkey.onUp();
  await until(() => T.mac.runs.at(-1).op === "raise", 1000);
  assert.equal(T.mac.runs.at(-1).out, "changed,70");
  assert.equal(T.mac.volume, 70);
  console.log("ok");

  begin("duck: off in settings: the volume isn't touched");
  ui.act({ type: "set", key: "duckMusic", value: false });
  runs = T.mac.runs.length;
  T.hotkey.onDown();
  await wait(300);
  await T.hotkey.onUp();
  await wait(100);
  assert.equal(T.mac.runs.length, runs);
  ui.act({ type: "set", key: "duckMusic", value: true });
  console.log("ok");
}

// Hands-free (src/core/hands-free.ts, src/core/wake.ts): a stub always-on transcript (T.listenStt) stands in for Apple's.
// run.sh makes the quiet that ends a request 200ms (KIKO_TEST_LISTEN_SILENCE_MS) and the wait after the name alone 500ms.
export async function handsFreeCases() {
  await wait(2100); // windows and the session list cache run out
  const LACY = { ...TERM, sessionId: "lacy-h", name: "lacy", cwd: "/nonexistent/lacy", place: ghostty("ghostty-lacy") };
  const before = T.sessions;
  T.sessions = [DESK, TERM, LACY];
  await wait(2100);
  const row = (key: string) => ui.state.settings.find((r: any) => r.key === key);
  const set = (key: string, value: unknown) => ui.act({ type: "set", key: key as any, value });
  const say = (text: string) => T.listenStt.onInterim(text);
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  const toApp = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });

  begin("hands-free: off by default; the setting turns it on at once, no restart");
  ui.act({ type: "settings" });
  assert.equal(ui.state.handsFree.on, false);
  assert.equal(row("listenMode")?.value, "Push-to-talk");
  assert.equal(row("replyWithoutName")?.value, "On");
  assert.equal(T.listenStt, undefined, "no always-on speech-to-text until it's turned on");
  set("listenMode", "hands-free");
  await until(() => ui.state.handsFree.on);
  assert.equal(row("listenMode")?.value, "Hands-free, say “Kiko”");
  assert.equal(row("listenMode")?.restart, false);
  assert.equal(ui.state.restartPending, false);
  assert.ok(T.micOpen, "the mic stays open");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).listenMode, "hands-free");
  assert.ok(caseLines().some((l) => l.text.startsWith('Listening for "Kiko"')));
  assert.ok(events("listen_mode").some((l) => l.on === true));
  ui.act({ type: "closeSettings" });
  console.log("ok");

  begin("hands-free: 'Kiko, ask Lacy if it deployed' is routed like push-to-talk words");
  let seen = "";
  T.utterance = (input: any) => ((seen = input.text), { audience: LACY, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  await talk("Kiko, ask Lacy if it deployed");
  const byKey = T.typed.at(-1);
  assert.equal(byKey.terminalId, "ghostty-lacy");
  markHere();
  seen = "";
  const typed = T.typed.length;
  T.listenFinal = "Kiko, ask Lacy if it deployed";
  say("Kiko, ask");
  assert.ok(ui.state.listening, "the floor is held, as by a key press");
  assert.equal(ui.state.handsFree.by, "name");
  await until(() => casePlayed().some((p: any) => p.pcm === SOUNDS.listening), 500);
  say("Kiko, ask Lacy if it deployed");
  assert.equal(ui.state.interim, "Kiko, ask Lacy if it deployed");
  await until(() => T.typed.length > typed, 2000);
  assert.deepEqual(T.typed.at(-1), byKey, "the same as with the key");
  assert.equal(seen, "Ask Lacy if it deployed", "the classifier saw the words without the name");
  assert.ok(caseLines().some((l) => l.kind === "you" && l.text === "Kiko, ask Lacy if it deployed"));
  assert.deepEqual(
    events("wake").map((l) => l.by),
    ["name"],
  );
  const req = events("wake_request")[0];
  assert.deepEqual([req.text, req.by, req.live], ["Kiko, ask Lacy if it deployed", "name", "Kiko, ask Lacy if it deployed"]);
  assert.ok(events("transcript").some((l) => l.via === "hands-free" && l.text === "Kiko, ask Lacy if it deployed"));
  await until(() => !ui.state.listening && ui.state.handsFree.by === null, 1000);
  console.log("ok");

  begin("hands-free: the final transcript wins over the live words, from the name on");
  T.listenFinal = "Okay, thanks. Kiku, ask Lacy if it shipped.";
  seen = "";
  say("Okay, thanks. Kiko, ask Lacy if it ship");
  await until(() => seen !== "", 2000);
  assert.equal(seen, "Ask Lacy if it shipped.");
  assert.ok(
    caseLines().some((l) => l.kind === "you" && l.text === "Kiko, ask Lacy if it shipped."),
    "fixed by the dictionary, without what came before",
  );
  await until(() => !ui.state.listening, 1000);
  console.log("ok");

  begin("hands-free: talk without the name is ignored, and only counted");
  let asked = 0;
  T.utterance = () => (asked++, toApp());
  const typedBefore = T.typed.length;
  const begins = T.listenBegins;
  say("Dinner's ready in five minutes, come down");
  assert.equal(ui.state.listening, false);
  await wait(1100); // a phrase without the name ends after 0.8s of quiet
  assert.equal(asked, 0);
  assert.equal(T.typed.length, typedBefore);
  assert.ok(!caseLines().some((l) => l.text.includes("Dinner")), "never shown");
  assert.ok(T.listenBegins > begins, "a fresh transcript for the next phrase");
  const ignored = events("listen_ignored");
  assert.equal(ignored.length, 1);
  assert.deepEqual(Object.keys(ignored[0]).sort(), ["count", "event", "ms", "t", "total"], "a count, nothing of what was said");
  assert.ok(!readFileSync(logFile(), "utf8").includes("Dinner"), "never logged");
  console.log("ok");

  begin("hands-free: the name alone waits for the request, then lets go");
  T.listenFinal = "Kiko.";
  say("Kiko.");
  assert.ok(ui.state.listening);
  await wait(300); // past the 200ms quiet: still waiting, for up to 500ms
  assert.ok(ui.state.listening, "still waiting for the request");
  await until(() => !ui.state.listening, 1000);
  assert.ok(caseLines().some((l) => l.text === '(heard "Kiko", then nothing)'));
  assert.equal(events("wake_dropped").length, 1);
  assert.equal(asked, 0);
  console.log("ok");

  begin("hands-free: the name, a pause, then the request");
  seen = "";
  T.utterance = (input: any) => ((seen = input.text), { audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  T.listenFinal = "Kiko. Tell atlas agents to run the tests.";
  say("Kiko.");
  await wait(300);
  say("Kiko. Tell atlas agents to run the tests.");
  await until(() => !ui.state.listening, 2000);
  await until(() => T.typed.at(-1)?.terminalId === "ghostty-1", 1000);
  assert.equal(events("wake_dropped").length, 0);
  console.log("ok");

  begin("hands-free: in a session's reply window, words without the name are its reply (no cue)");
  T.needs = [0.8];
  const a = stop(TERM, "cli");
  T.hooks.onRequest(a);
  await windowOpen(TERM);
  markHere();
  T.listenFinal = "Yes, go ahead and commit it.";
  say("Yes, go ahead");
  assert.equal(ui.state.handsFree.by, "reply");
  assert.ok(ui.state.listening);
  say("Yes, go ahead and commit it");
  await until(() => !a.open, 2000);
  assert.equal(a.reply, "Yes, go ahead and commit it.");
  assert.ok(!casePlayed().some((p: any) => p.pcm === SOUNDS.listening), "no listening cue for a reply");
  assert.deepEqual(
    events("wake").map((l) => l.by),
    ["reply"],
  );
  await until(() => !ui.state.listening, 1000);
  console.log("ok");

  begin("hands-free: 'Reply without saying Kiko' off: words without it are ignored in the window too");
  set("replyWithoutName", false);
  T.needs = [0.8];
  const b = stop(TERM, "cli");
  T.hooks.onRequest(b);
  await windowOpen(TERM);
  markHere();
  say("yes go ahead");
  assert.equal(ui.state.listening, false);
  await wait(1000);
  assert.ok(b.open, "not a reply");
  set("replyWithoutName", true);
  gone(b);
  await wait(50);
  console.log("ok");

  begin("hands-free: it doesn't hear the app while the app speaks");
  T.speakMs = 400;
  T.needs = [0.8];
  const c = stop(TERM, "cli");
  T.hooks.onRequest(c);
  await until(() => ui.state.speaking, 2000);
  const sent = T.listenSent ?? 0;
  T.mic(Buffer.alloc(3200, 0x40));
  T.mic(Buffer.alloc(3200, 0x40));
  assert.equal(T.listenSent ?? 0, sent, "dropped while it speaks");
  await until(() => !ui.state.speaking, 2000);
  T.mic(Buffer.alloc(3200));
  assert.equal(T.listenSent ?? 0, sent, "and a moment after");
  await wait(450);
  T.mic(Buffer.alloc(3200));
  assert.equal(T.listenSent, sent + 1, "then it listens again");
  T.speakMs = 50;
  gone(c);
  await wait(50);
  console.log("ok");

  // The name you call it (Settings → Its name, src/core/name.ts spokenName).
  begin("hands-free: a name of your own, set in settings, works at once; Kiko stops; the status line says it");
  const status = () => JSON.parse(readFileSync("state.json", "utf8"));
  ui.act({ type: "settings" });
  assert.equal(row("spokenName")?.value, "Kiko");
  set("spokenName", "jarvis");
  assert.equal(row("spokenName")?.value, "Jarvis");
  assert.equal(row("spokenName")?.restart, false);
  assert.equal(row("listenMode")?.value, "Hands-free, say “Jarvis”");
  assert.equal(row("replyWithoutName")?.label, "Reply without saying Jarvis");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).spokenName, "Jarvis");
  assert.ok(caseLines().some((l) => l.text === "(Say “Jarvis, …” to talk to it now.)"));
  ui.act({ type: "closeSettings" });
  await until(() => status().handsFree?.name === "Jarvis", 1000);
  seen = "";
  T.utterance = (input: any) => ((seen = input.text), { audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const typedHandsFree = T.typed.length;
  T.listenFinal = "Jarvis, did the build pass?";
  say("Jarvis, did the build pass?");
  assert.equal(ui.state.handsFree.by, "name");
  await until(() => T.typed.length > typedHandsFree, 2000);
  assert.equal(T.typed.at(-1).terminalId, "ghostty-1");
  assert.equal(seen, "Did the build pass?", "the classifier saw the words without the name");
  await until(() => !ui.state.listening, 1000);
  // With the key too.
  seen = "";
  const typedKey = T.typed.length;
  await talk("Jarvis, did the tests pass?");
  await until(() => T.typed.length > typedKey, 2000);
  assert.equal(seen, "Did the tests pass?");
  // "Kiko, …" is only words now: no wake, nothing sent (only counted).
  const typedIgnored = T.typed.length;
  const wakes = events("wake").length;
  say("Kiko, tell atlas agents to stop.");
  assert.equal(ui.state.listening, false);
  await wait(1100);
  assert.equal(events("wake").length, wakes);
  assert.equal(T.typed.length, typedIgnored);
  // Back to the default: not written, so it follows the default.
  set("spokenName", "Kiko");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).spokenName, undefined);
  assert.equal(row("listenMode")?.value, "Hands-free, say “Kiko”");
  await until(() => status().handsFree?.name === "Kiko", 1000);
  console.log("ok");

  begin("hands-free: the key still works, and the mic goes back to listening after");
  T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  await talk("tell atlas agents to commit");
  assert.equal(T.typed.at(-1).terminalId, "ghostty-1");
  assert.ok(T.micOpen, "still open");
  const n = T.listenSent ?? 0;
  T.mic(Buffer.alloc(3200));
  assert.equal(T.listenSent, n + 1, "its audio is hands-free's again");
  console.log("ok");

  begin("hands-free: the key takes over from words it was hearing");
  T.listenFinal = "Kiko, tell atlas";
  say("Kiko, tell atlas");
  assert.ok(ui.state.listening);
  T.heard = "tell atlas agents to push";
  T.hotkey.onDown();
  assert.equal(ui.state.handsFree.by, null);
  await wait(300); // past the quiet that would have ended hands-free's words
  assert.ok(ui.state.listening, "the key holds it now");
  await T.hotkey.onUp();
  assert.equal(events("wake_request").length, 0, "nothing from hands-free");
  assert.ok(events("transcript").some((l) => l.text === "tell atlas agents to push" && !l.via));
  console.log("ok");

  begin("hands-free: turned off, the mic closes and it's push-to-talk again");
  set("listenMode", "push-to-talk");
  await until(() => !ui.state.handsFree.on);
  assert.equal(T.micOpen, false);
  assert.ok(T.listenClosed);
  assert.equal(row("listenMode")?.value, "Push-to-talk");
  console.log("ok");

  begin("hands-free: without Apple speech it says so, and stays push-to-talk");
  T.listenFails = "speech helper exited (1): on-device speech transcription isn't available on this Mac";
  set("listenMode", "hands-free");
  await until(() => caseLines().some((l) => l.kind === "error"), 1000);
  assert.ok(caseLines().some((l) => l.kind === "error" && l.text.includes("Apple speech isn't available on this Mac, so it's push-to-talk only")));
  assert.equal(ui.state.handsFree.on, false);
  assert.equal(row("listenMode")?.value, "Push-to-talk (hands-free unavailable)");
  assert.ok(row("listenMode")?.note?.includes("isn't available on this Mac"));
  assert.equal(T.micOpen, false);
  T.listenFails = undefined;
  set("listenMode", "push-to-talk");
  await wait(50);
  T.sessions = before;
  T.utterance = toApp;
  console.log("ok");
}
