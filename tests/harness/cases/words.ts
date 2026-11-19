// Where your words go: to the one that just spoke, "no, that was for X", Deciding…, quick tasks, clean-up,
// unsure sends held, "Kiko, …", the app's which-session question, and a press while the last words are
// still dealt with.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  begin,
  caseLines,
  caseLog,
  caseSaid,
  CLAUDE,
  DESK,
  ghostty,
  held,
  logFile,
  NOT_WAITING,
  notSent,
  OFF_LINE,
  saidFor,
  SCRATCH,
  spoke,
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

// 8. Clipkit asks something, its window closes, and the answer comes a
//    moment later; then "no, that was for clipkit" when one went to the wrong session.
export async function justSpokeCases() {
  const CCV = { ...TERM, sessionId: "ccv-1", name: "ccv", cwd: "/nonexistent/claude-code-speech", place: ghostty("ghostty-ccv") };
  const SNIP = { ...TERM, sessionId: "snip-1", name: "snip", cwd: "/nonexistent/clipkit", place: ghostty("ghostty-snip") };
  const before = T.sessions;
  T.sessions = [DESK, TERM, CCV, SNIP];
  await wait(2100); // the session list cache, and the last window, run out
  const ANSWER = "Tell it to make a fresh test build so I can try it here. I would also like to be given a command with the full path to that build so I can open it.";
  // What's typed: the direction to the session ("Tell it to") off (src/core/direction.ts).
  const TYPED = ANSWER.replace(/^Tell it to make/, "Make");
  const CORRECTION = "No, that wasn't a cloud, cold speech one, that was supposed to be to Clipkit.";
  const SENT_LINE = "Sent it to clipkit instead. claude code speech already got it too.";
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id);
  const announceAndClose = async (s: any) => {
    T.needs = [0.76];
    const r = stop(s, "cli");
    T.hooks.onRequest(r);
    await until(() => caseSaid().some((x: any) => x.text === `summary for ${s.cwd.split("/").pop()}`));
    await until(() => !r.open, 3000); // no reply: the window closes
    assert.equal(r.reply, null);
    await wait(100); // ~1s, scaled: you press the key a moment late
    return r;
  };

  begin("answer just after the window closed: the classifier hears it's for the session that just spoke");
  // Before it: you'd been talking to claude-code-speech.
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk("Yeah, those changes sound right to me.");
  await announceAndClose(SNIP);
  let seen: any = null;
  T.utterance = (input: any) => {
    seen = input;
    return { audience: input.justSpoke?.id === SNIP.sessionId ? SNIP : CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  let snipTyped = typedInto(SNIP).length;
  await talk(ANSWER);
  assert.equal(seen.waitingId, null, "the window had closed");
  assert.equal(seen.justSpoke?.id, SNIP.sessionId);
  assert.ok(seen.justSpoke.secondsAgo <= 2, `${seen.justSpoke.secondsAgo}s ago`);
  assert.ok(seen.recent.includes("app said (about clipkit): summary for clipkit"), seen.recent.join("\n"));
  assert.equal(typedInto(SNIP).length, snipTyped + 1);
  assert.equal(typedInto(SNIP).at(-1).text, TYPED);
  assert.ok(!spoke("To clipkit."), "no 'To clipkit.': it's the one you just heard");
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("after that, nothing just spoke");
  T.utterance = (input: any) => {
    seen = input;
    return { audience: SNIP, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  await talk("and run the tests too");
  assert.equal(seen.justSpoke, null);
  console.log("ok");

  begin("answer just after the window closed: the classifier unsure, the router gets just_spoke");
  await announceAndClose(SNIP);
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.68, intent: "message", intentConfidence: 1 });
  T.route = (input: any) => {
    seen = input;
    return [{ name: "pass_on", session: input.justSpoke?.id === SNIP.sessionId ? SNIP : CCV }];
  };
  snipTyped = typedInto(SNIP).length;
  await talk(ANSWER);
  assert.equal(seen.justSpoke?.id, SNIP.sessionId);
  assert.equal(seen.waitingId, null);
  assert.ok(seen.recent.includes("app said (about clipkit): summary for clipkit"));
  assert.equal(typedInto(SNIP).length, snipTyped + 1);
  console.log("ok");

  begin("another announcement since: not the one that just spoke");
  await announceAndClose(SNIP);
  T.needs = [0.76];
  const other = stop(TERM, "cli");
  T.hooks.onRequest(other);
  await until(() => saidFor(TERM));
  await until(() => !other.open, 3000);
  T.utterance = (input: any) => {
    seen = input;
    return { audience: TERM, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 };
  };
  await talk("sure, go ahead");
  assert.equal(seen.justSpoke?.id, TERM.sessionId);
  console.log("ok");

  begin("correction: the classifier hears a redirect; the last message goes to the session named");
  await wait(100);
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk(ANSWER); // the wrong one
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-ccv", text: TYPED });
  const ccvTyped = typedInto(CCV).length;
  snipTyped = typedInto(SNIP).length;
  let routed = false;
  T.route = () => ((routed = true), []);
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.38, intent: "redirect", intentConfidence: 0.9 });
  await talk(CORRECTION);
  assert.ok(!routed, "no router call needed: the words name clipkit");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: TYPED });
  assert.equal(typedInto(SNIP).length, snipTyped + 1);
  assert.equal(typedInto(CCV).length, ccvTyped, "nothing more typed into claude-code-speech");
  assert.ok(spoke(SENT_LINE));
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("correction through the router: resend_to");
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk(ANSWER);
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.26, intent: "message", intentConfidence: 0.6 });
  T.route = (input: any) => {
    seen = input;
    return [{ name: "resend_to", session: SNIP }];
  };
  await talk(CORRECTION);
  assert.ok(seen.recent.some((l: string) => l.startsWith("you → claude-code-speech: Make a fresh")));
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: TYPED });
  assert.ok(spoke(SENT_LINE));
  console.log("ok");

  begin("correction naming nobody, the classifier unsure where: the router decides");
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk(ANSWER);
  routed = false;
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.5, intent: "redirect", intentConfidence: 0.9 });
  T.route = () => ((routed = true), [{ name: "resend_to", session: SNIP }]);
  await talk("no, wrong one, that was for the other session");
  assert.ok(routed);
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: TYPED });
  console.log("ok");

  begin("correction to where it already went");
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.9, intent: "redirect", intentConfidence: 0.9 });
  T.route = () => [{ name: "resend_to", session: SNIP }];
  const n = T.typed.length;
  await talk("no, that was supposed to go to clipkit");
  assert.ok(spoke("That already went to clipkit. Which session was it for?"));
  assert.equal(T.typed.length, n);
  T.route = () => [];
  await talk("Never mind."); // answers the question, so the next words aren't taken as its answer
  console.log("ok");

  begin("replies only: the correction isn't typed in either");
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk(ANSWER);
  ui.act({ type: "set", key: "voiceCan", value: "replies" });
  const m = T.typed.length;
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.38, intent: "redirect", intentConfidence: 0.9 });
  await talk(CORRECTION);
  assert.equal(T.typed.length, m);
  assert.ok(spoke(NOT_WAITING()));
  assert.ok(!spoke(SENT_LINE));
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  console.log("ok");

  begin("repeat clipkit's message, and a correction after types nothing");
  // clipkit was read out earlier, claude-code-speech since, and you said "Yeah." to claude-code-speech.
  await announceAndClose(SNIP);
  await announceAndClose(CCV);
  T.utterance = () => ({ audience: CCV, audienceConfidence: 1, intent: "message", intentConfidence: 0.94 });
  await talk("Yeah.");
  assert.equal(T.typed.at(-1).text, "Yeah.");
  const typedBefore = T.typed.length;
  let said = T.said.length;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "repeat", intentConfidence: 0.82 });
  await talk("Can you say the last clipkit message again? I lost track of where we were.");
  await until(() => T.said.length > said);
  assert.equal(T.said.at(-1).text, "summary for clipkit", "clipkit's summary, not the last thing said");
  said = T.said.length;
  routed = false;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.32, intent: "redirect", intentConfidence: 0.91 });
  T.route = () => ((routed = true), [{ name: "resend_to", session: SNIP }]);
  await talk("No, I meant the clip kit session, not that one.");
  await until(() => T.said.length > said);
  assert.equal(T.typed.length, typedBefore, "nothing typed into any session");
  assert.equal(T.said.at(-1).text, "summary for clipkit", "the repeat, redone for the session named");
  // And when the router is asked anyway, its resend_to can't send the old "Yeah." on.
  said = T.said.length;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.32, intent: "message", intentConfidence: 0.9 });
  await talk("That was for clipkit.");
  assert.ok(routed);
  assert.equal(T.typed.length, typedBefore, "still nothing typed");
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin('"more" after a summary: a longer summary of that same reply, said by the app, nothing typed in; "more about" a part of it');
  {
    // clipkit was read out last, its window closed: "more" is about it, whatever the classifier hears.
    await announceAndClose(SNIP);
    const typed = T.typed.length;
    const mores = (T.mores ?? []).length;
    T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95 });
    let n = T.said.length;
    await talk("Tell me more.");
    await until(() => T.said.length > n, 3000, "the longer summary");
    assert.equal(T.said.at(-1).text, "more of clipkit");
    const of = T.mores.at(-1);
    assert.equal(T.mores.length, mores + 1);
    assert.equal(of.claudeReply, `reply from ${SNIP.sessionId}`, "the same reply");
    assert.equal(of.heard, "summary for clipkit", "and the summary heard of it");
    assert.equal(of.topic, null);
    assert.equal(T.typed.length, typed, "nothing typed into any session");
    // While a turn waits for your reply, "more about" a part of it is still the app's, and the turn still waits.
    T.needs = [0.76];
    const r = stop(SNIP, "cli");
    T.hooks.onRequest(r);
    await until(() => caseSaid().filter((x: any) => x.text === "summary for clipkit").length >= 2, 3000, "announced again");
    n = T.said.length;
    await talk("What did it say about the failing tests?");
    await until(() => T.said.length > n, 3000, "more about the tests");
    assert.equal(T.said.at(-1).text, "more of clipkit: the failing tests");
    assert.equal(T.typed.length, typed, "still nothing typed");
    assert.equal(r.reply, undefined, "not given as its reply");
    const fb = caseLog().filter((l) => l.event === "summary_feedback");
    assert.deepEqual(
      fb.map((l) => [l.kind, l.said, l.summary, l.went]),
      [
        ["more", "Tell me more.", "summary for clipkit", ["more"]],
        ["more_about", "What did it say about the failing tests?", "summary for clipkit", ["more"]],
      ],
    );
    assert.ok(
      fb.every((l) => /^[0-9a-f]{12}$/.test(l.replyId)),
      "the reply's id, as the summary eval's",
    );
    assert.equal(caseLog().filter((l) => l.event === "more" && l.text).length, 2);
    // A question back about it, sent to the session as always, is logged as feedback too.
    await talk("Why did they fail?");
    await until(() => r.reply !== undefined && r.reply !== null, 3000, "the reply");
    assert.equal(r.reply, "Why did they fail?");
    const back = caseLog()
      .filter((l) => l.event === "summary_feedback")
      .at(-1);
    assert.deepEqual([back.kind, back.said, back.went], ["follow_up", "Why did they fail?", ["send"]]);
    await until(() => !r.open, 3000);
  }
  console.log("ok");

  const redirects = readFileSync(logFile(), "utf8")
    .split("\n")
    .filter((l) => l.includes('"event":"redirect"'));
  console.log("redirect logs:", redirects.length);
  T.sessions = before;
}

// 8b. "No, that was for X" stops the wrong session(s) still on your words; stops by name never land
//     on another session.
export async function redirectStopCases() {
  const CCV = { ...TERM, sessionId: "ccv-2", name: "ccv", cwd: "/nonexistent/claude-code-speech", place: ghostty("ghostty-ccv") };
  const SNIP = { ...TERM, sessionId: "snip-2", name: "snip", cwd: "/nonexistent/clipkit", place: ghostty("ghostty-snip") };
  // Named as in the log: /rename Lacy.
  const LACY = { ...TERM, sessionId: "lacy-2", name: "lacy", givenName: "Lacy", cwd: "/nonexistent/lacy-platform", place: ghostty("ghostty-lacy") };
  const before = T.sessions;
  T.sessions = [DESK, CCV, SNIP, LACY];
  const setCan = (value: string) => ui.act({ type: "set", key: "voiceCan", value });
  const escapesIn = (s: any, since: number) => T.keys.slice(since).filter((k: any) => k.terminalId === s.place.id && k.key === "escape").length;
  const toCcv = () => ({ audience: CCV, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  const redirectTo = (s: any) => () => ({ audience: s, audienceConfidence: 0.9, intent: "redirect", intentConfidence: 0.95 });
  const MISROUTED = "Make a fresh test build so I can try it here.";
  const CORRECTION = "No, that was supposed to go to clipkit.";
  const statuses = (status: string) => [CCV, SNIP, LACY].forEach((s) => (s.status = status));
  await wait(2100); // the session list cache, and the last window, run out
  setCan("everything");

  begin("redirect: the wrong session is still on it: stopped, and the words go to the right one");
  T.utterance = toCcv;
  await talk(MISROUTED);
  CCV.status = "busy";
  let keys = T.keys.length;
  const typedBefore = T.typed.length;
  T.utterance = redirectTo(SNIP);
  await talk(CORRECTION);
  assert.equal(escapesIn(CCV, keys), 1);
  assert.equal(T.keys.length - keys, 1, "no other key pressed");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: MISROUTED });
  assert.ok(
    spoke("Stopped claude code speech and sent it to clipkit."),
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );
  assert.deepEqual(T.typed.slice(typedBefore), [{ terminalId: "ghostty-snip", text: MISROUTED }], "nothing typed into the wrong one");
  statuses("idle");
  console.log("ok");

  begin("redirect: the wrong session already finished: nothing stopped");
  T.utterance = toCcv;
  await talk(MISROUTED);
  keys = T.keys.length;
  T.utterance = redirectTo(SNIP);
  await talk(CORRECTION);
  assert.equal(T.keys.length, keys);
  assert.ok(spoke("Sent it to clipkit instead. claude code speech already got it too."));
  console.log("ok");

  begin("redirect: it finished that turn and is busy with something newer: left alone");
  T.utterance = toCcv;
  await talk(MISROUTED);
  T.needs = [0.1];
  const r = stop(CCV, "cli");
  T.hooks.onRequest(r);
  await until(() => caseSaid().some((x: any) => x.text === "summary for claude-code-speech"));
  // No transcript to read: your words for it this turn are what the app sent it (each time in these cases).
  const asked: string[] = T.summaries.at(-1).asked;
  assert.ok(asked.length > 0 && asked.every((t) => t === MISROUTED), asked.join(" | "));
  // A Claude Code session's summary: "Claude says", as always.
  assert.deepEqual(T.summaries.at(-1).voice, { agent: "Claude Code", speaker: "Claude" });
  await until(() => !r.open, 3000);
  CCV.status = "busy";
  keys = T.keys.length;
  T.utterance = redirectTo(SNIP);
  await talk(CORRECTION);
  assert.equal(T.keys.length, keys, "no Escape: it's on something else now");
  assert.ok(spoke("Sent it to clipkit instead. claude code speech already got it too."));
  statuses("idle");
  console.log("ok");

  begin("redirect: still on it, but stopping is off in settings: it carries on, and you hear so");
  setCan("messages");
  T.utterance = toCcv;
  await talk(MISROUTED);
  CCV.status = "busy";
  keys = T.keys.length;
  T.utterance = redirectTo(SNIP);
  await talk(CORRECTION);
  assert.equal(T.keys.length, keys);
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-snip", text: MISROUTED });
  assert.ok(spoke(`Sent it to clipkit instead. claude code speech got it too, and will carry on with it. Stopping sessions by voice is off. ${VOICE_CAN_SAID}`));
  statuses("idle");
  setCan("everything");
  console.log("ok");

  begin("cancelled, then 'that was clip kid, not to …': sent to clipkit, nothing stopped twice");
  T.utterance = toCcv;
  await talk(MISROUTED);
  CCV.status = "busy";
  keys = T.keys.length;
  T.utterance = () => ({ audience: CCV, audienceConfidence: 0.6, intent: "undo", intentConfidence: 0.97 });
  await talk("No, cancel that.");
  assert.equal(escapesIn(CCV, keys), 1);
  // As logged: the classifier unsure, and the router's resend_to back to where it went. The words
  // sound like clipkit ("clip kid"), and "not to claude code speech" names the wrong one.
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.57, intent: "redirect", intentConfidence: 0.35 });
  T.route = () => [{ name: "resend_to", session: CCV }];
  const typedNow = T.typed.length;
  await talk("That was clip kid, not to claude code speech.");
  assert.equal(escapesIn(CCV, keys), 1, "not stopped again");
  assert.deepEqual(T.typed.slice(typedNow), [{ terminalId: "ghostty-snip", text: MISROUTED }]);
  assert.ok(
    spoke("Sent it to clipkit instead."),
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );
  assert.ok(!spoke("Your last words didn't go to a session, so there's nothing to send on."));
  T.route = () => [];
  statuses("idle");
  console.log("ok");

  begin("redirect after the router asked all three: the right one has it; the others still on it are stopped");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  const ASKED = "What was the decision on mixing numbers and text?";
  T.route = () => [CCV, SNIP, LACY].map((s) => ({ name: "ask_session", session: s, message: ASKED }));
  let typed = T.typed.length;
  await talk("Ask all of them what the decision on mixing numbers and text was.");
  assert.equal(T.typed.length - typed, 3, "'all of them': every one asked");
  statuses("busy");
  keys = T.keys.length;
  typed = T.typed.length;
  T.route = () => [];
  T.utterance = redirectTo(CCV);
  await talk("No, wait, that was just for claude code speech.");
  assert.equal(escapesIn(SNIP, keys), 1);
  assert.equal(escapesIn(LACY, keys), 1);
  assert.equal(escapesIn(CCV, keys), 0);
  assert.equal(T.typed.length, typed, "nothing sent again: claude code speech has it");
  assert.ok(
    spoke("claude code speech already has it; stopped Lacy and clipkit."),
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );
  statuses("idle");
  console.log("ok");

  begin("the router asks all three unasked: only one gets it");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  T.route = () => [LACY, CCV, SNIP].map((s) => ({ name: "ask_session", session: s, message: ASKED }));
  typed = T.typed.length;
  await talk("What was the decision on mixing numbers and text?");
  assert.ok(T.typed.length - typed <= 1, `typed into ${T.typed.length - typed}`);
  assert.ok(readFileSync(logFile(), "utf8").includes('"rule":"one_target"'));
  T.route = () => [];
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );

  begin("'Stop Casey, and stop Clipkit': Escape once in clipkit, never twice; Lacy asked about");
  statuses("busy");
  await wait(100);
  keys = T.keys.length;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  T.route = () => [
    { name: "stop_session", session: SNIP },
    { name: "stop_session", session: LACY },
  ];
  await talk("Stop Casey, uh, Casey, and stop Clipkit.");
  assert.equal(escapesIn(SNIP, keys), 1);
  assert.equal(T.keys.length - keys, 1, "one Escape, in clipkit only");
  assert.ok(
    spoke("Stop Lacy?"),
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );
  let routed = false;
  T.route = () => ((routed = true), []);
  await talk("Yeah, do it.");
  assert.ok(!routed, "the yes answers the app's question in code");
  assert.equal(escapesIn(LACY, keys), 1);
  assert.equal(T.keys.length - keys, 2);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind === "voice")
      .map((l) => l.text)
      .join(" | "),
  );

  begin("'Stop lazy.', then no: nothing stopped");
  keys = T.keys.length;
  T.route = () => [{ name: "stop_session", session: LACY }];
  await talk("Stop lazy.");
  assert.ok(spoke("Stop Lacy?"));
  await talk("No.");
  assert.equal(T.keys.length, keys);
  console.log("ok");

  begin("'Stop which one?' answered with letters: L-A-C-Y");
  keys = T.keys.length;
  T.route = () => [{ name: "stop_session", session: CCV }];
  await talk("Stop that one.");
  assert.ok(spoke("Stop which one? Say its name."));
  routed = false;
  T.route = () => ((routed = true), []);
  await talk("L-A-C-Y.");
  assert.ok(!routed);
  assert.equal(escapesIn(LACY, keys), 1);
  assert.equal(T.keys.length - keys, 1);
  statuses("idle");
  console.log("ok");

  setCan("messages");
  T.route = () => [];
  T.sessions = before;
}

// 9. "Deciding…": the status line and the caption while the app works out where your words go.
export async function decidingCases() {
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const toTerm = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  begin("deciding: quick words land as before; sent shows, no caption after key up");
  await wait(2500); // anything from the last section has settled
  T.utterance = toTerm;
  await talk("run the tests");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "run the tests" });
  assert.equal(state().deciding, null);
  assert.equal(state().sent.name, "atlas-agents");
  assert.ok(Date.now() - state().sent.at < 500);
  assert.ok(ui.state.routed!.tookMs < 500, "too quick for the caption to stay");
  console.log(`ok: sent ${JSON.stringify(state().sent.name)}, deciding took ${ui.state.routed!.tookMs}ms`);

  begin("deciding: the router takes 0.8s");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "pass_on", session: TERM }];
  T.routeDelayMs = 800;
  const going = talk("and the linter");
  await until(() => Boolean(ui.state.deciding));
  assert.equal(ui.state.deciding!.text, "and the linter");
  assert.equal(typeof state().deciding.startedAt, "number");
  await going;
  T.routeDelayMs = 0;
  assert.equal(state().deciding, null);
  assert.equal(ui.state.deciding, null);
  assert.equal(ui.state.routed!.to, "atlas-agents");
  assert.equal(ui.state.routed!.text, "and the linter");
  assert.ok(ui.state.routed!.tookMs >= 800, `took ${ui.state.routed!.tookMs}ms`);
  await wait(2100);
  assert.equal(ui.state.routed, null, "the caption's 'where it went' clears");
  console.log("ok: deciding while the router thought, then where it went, cleared after");

  begin("deciding: an answer from the app sends nothing");
  T.route = () => [];
  const sentBefore = state().sent.at;
  await talk("what time is it");
  assert.equal(state().sent.at, sentBefore);
  assert.equal(state().deciding, null);
  console.log("ok");
}

// 10. Quick tasks: a read-only `claude -p` run (stubbed), answered when it's done.
export async function quickTaskCases() {
  const { homedir } = await import("node:os");
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const setCan = (value: string) => ui.act({ type: "set", key: "voiceCan", value });
  const spoke = (text: string) => caseLines().some((l) => l.kind === "voice" && l.text === text);
  const said = (text: string) => caseSaid().some((x: any) => x.text === text);
  const ANSWER = { outcome: "answered", text: "311 GB free of 1.8 TB.", durationMs: 3900, costUsd: 0.0017, numTurns: 2, denied: [], subtype: "success" };
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "quick_task", task: "How much free disk space is there?", cwd: homedir() }];

  begin("quick task: off below 'everything'");
  setCan("messages");
  T.quick = null;
  await talk("how much disk space do I have");
  assert.equal(T.quick, null, "nothing run");
  assert.ok(spoke(OFF_LINE("Checking your computer")));
  console.log("ok");

  setCan("everything");
  begin("quick task: checking, then the answer");
  await talk("how much disk space do I have");
  const run = T.quick;
  assert.equal(run.options.task, "How much free disk space is there?");
  assert.equal(run.options.cwd, homedir());
  assert.equal(run.options.model, "haiku");
  assert.equal(run.options.timeoutMs, 60000);
  assert.equal(run.options.maxTurns, 8);
  assert.ok(spoke("Checking."));
  assert.equal(typeof state().checking.startedAt, "number");
  assert.ok(ui.state.checking);
  assert.equal(ui.state.routed!.to, "a quick check");
  // You talk meanwhile: it isn't held up, and the answer waits until you're done.
  T.utterance = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  T.heard = "check the logs";
  T.hotkey.onDown();
  run.resolve(ANSWER);
  await wait(300);
  assert.ok(!said("answer: 311 GB free of 1.8 TB."), "not while you talk");
  await T.hotkey.onUp();
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "check the logs" });
  await until(() => said("answer: 311 GB free of 1.8 TB."));
  assert.equal(state().checking, null);
  assert.ok(caseLines().some((l) => l.kind === "task" && l.text.startsWith("answered in 3.90s · $0.0017 · 2 turns")));
  const logged = readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "quick_task")
    .at(-1);
  assert.equal(logged.outcome, "answered");
  assert.equal(logged.costUsd, 0.0017);
  assert.equal(logged.cwd, homedir());
  assert.ok(Array.isArray(logged.allowedTools));
  console.log(
    "ok:",
    caseLines()
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("quick task: one at a time; 'stop' cancels it");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  await talk("is anything running on port 3000");
  const second = T.quick;
  await talk("and what's my battery at");
  assert.equal(T.quick, second, "no second run");
  assert.ok(spoke("I'm still checking the last thing. Say cancel to stop it."));
  T.route = () => {
    throw new Error("the router isn't asked for a cancel");
  };
  await talk("stop");
  assert.ok(second.cancelled);
  assert.ok(spoke("Stopped checking."));
  assert.equal(state().checking, null);
  await wait(200);
  console.log("ok");

  begin("quick task: asked to change something: the offer, without a run");
  T.route = () => [{ name: "quick_task", task: "Delete old screenshots from the Desktop.", cwd: homedir() }];
  const runs = T.quickRuns.length;
  await talk("clear the old screenshots off my desktop");
  const OFFER = "That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?";
  assert.ok(spoke(OFFER));
  assert.equal(T.quickRuns.length, runs, "no run");
  console.log("ok");

  begin("quick task: the run finds it needs changes, offers a session");
  T.route = () => [{ name: "quick_task", task: "Which screenshots on the Desktop are older than a week?", cwd: homedir() }];
  await talk("my desktop is full of old screenshots");
  assert.equal(T.quickRuns.length, runs + 1);
  T.quick.resolve({ ...ANSWER, outcome: "needs_changes", text: "Deleting files on the Desktop." });
  await until(() => spoke(OFFER));
  console.log("ok");

  // A question about the Mac's own settings, for no project, was offered "a session in your home folder",
  // "Sure." opened one in ~, and its first reply was Claude Code's "Not logged in · Please run /login",
  // which nothing said (no Stop hook for it).
  begin(
    "quick task: 'change the computer volume to 10%': offered in the scratch folder, with why; 'Sure.' opens one there with it; its first reply 'Not logged in': said, sent again once; again: said, and 'try again' sends it",
  );
  {
    const TASK = "Set the computer volume to 10%.";
    T.route = () => [{ name: "quick_task", task: TASK, cwd: homedir() }];
    const before = T.quickRuns.length;
    await talk("Could you turn the computer volume down to 10%?");
    await until(() => spoke(OFFER));
    assert.equal(T.quickRuns.length, before, "no run");
    T.route = () => assert.fail("a yes to the offer is read in code");
    const opened = T.opened.length;
    await talk("Sure.");
    await until(() => T.opened.length > opened, 3000, "a session to open");
    const cwd = T.opened.at(-1).cwd;
    assert.match(cwd, new RegExp(`^${SCRATCH}/\\d{4}-\\d{2}-\\d{2}-`), "a scratch folder, not ~");
    assert.equal(T.opened.at(-1).command, `${CLAUDE} '${TASK}'`);
    assert.ok(spoke("Opening a new session in a scratch folder."));
    // It starts (matched by its folder); its transcript's first reply is the error Claude Code writes.
    process.env.KIKO_LOGIN_RETRY_MS = "1200";
    const file = `claude-projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/vol-1.jsonl`;
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    const entry = (e: object) => `${JSON.stringify(e)}\n`;
    const asked = (uuid: string) => entry({ type: "user", uuid, message: { role: "user", content: TASK } });
    const NOT_LOGGED_IN = entry({
      type: "assistant",
      isApiErrorMessage: true,
      error: "authentication_failed",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    });
    writeFileSync(file, asked("p1") + NOT_LOGGED_IN);
    const VOL = { ...TERM, sessionId: "vol-1", name: "volume", cwd, place: ghostty("ghostty-vol") };
    const typed = () => T.typed.filter((t: any) => t.terminalId === "ghostty-vol");
    T.sessions = [...T.sessions, VOL];
    T.hooks.onSessionsChanged();
    await until(() => caseLog().some((l) => l.event === "login_failed" && l.sessionId === "vol-1" && !l.again), 5000, "the failure read from its transcript");
    // Called by its folder without the date, as while it started.
    await until(
      () => caseLines().some((l) => l.kind === "voice" && /^set computer volume 10 couldn't log in to Claude, so it hasn't started on that\. I'll send it again (now|in \d+ seconds)\.$/.test(l.text)),
      3000,
      "the failure said",
    );
    // Sent again once (after KIKO_LOGIN_RETRY_MS from its opening), through its terminal.
    await until(() => typed().length === 1, 5000, "its first message typed in again");
    assert.equal(typed()[0].text, TASK);
    assert.ok(caseLog().some((l) => l.event === "login_retry" && l.sessionId === "vol-1" && l.typed));
    // Not logged in again: said, with "try again" for its words; never sent again by itself.
    const { appendFileSync: append } = await import("node:fs");
    append(file, asked("p2") + NOT_LOGGED_IN);
    const AGAIN = "set computer volume 10 still couldn't log in to Claude, so your words didn't go through. Run /login in its window, then say try again.";
    await until(() => spoke(AGAIN), 5000, "the second failure said");
    await wait(1500);
    assert.equal(typed().length, 1, "not sent a third time by itself");
    T.route = () => assert.fail("'try again' is read in code");
    await talk("try again");
    await until(() => typed().length === 2, 3000, "'try again' to send it");
    assert.equal(typed()[1].text, TASK);
    T.sessions = T.sessions.filter((s: any) => s !== VOL);
    T.route = () => [];
    delete process.env.KIKO_LOGIN_RETRY_MS;
  }
  console.log("ok");

  begin("quick task: too slow");
  T.route = () => [{ name: "quick_task", task: "How big is the Downloads folder?", cwd: homedir() }];
  await talk("how big is my downloads folder");
  T.quick.resolve({ ...ANSWER, outcome: "timeout", text: "no answer within 60s" });
  await until(() => spoke("That took too long, so I stopped checking."));
  console.log("ok");
  setCan("messages");
}

// 10. "Clean up my messages": what goes to a session is cleaned up (here: "uh" left out), the
//     setting turns it off, and a correction resends what was sent.
export async function cleanupCases() {
  await wait(2100); // windows and the session list cache run out
  T.clean = (t: string) => {
    const out = t.replace(/\b(uh|um),?\s*/gi, "");
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  const toTerm = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const toDesk = () => ({ audience: DESK, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });
  const info = (text: string) => caseLines().some((l) => l.kind === "info" && l.text.startsWith(text));

  begin("clean-up: typed into a terminal, cleaned");
  T.utterance = toTerm;
  await talk("uh, run the um linter");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "Run the linter" });
  assert.ok(
    caseLines().some((l) => l.kind === "you" && l.text === "uh, run the um linter"),
    "the conversation shows what you said",
  );
  assert.ok(
    info('(cleaned up: left out "uh", "um"'),
    caseLines()
      .map((l) => l.text)
      .join(" | "),
  );
  const logged = readFileSync(logFile(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "cleaned")
    .at(-1);
  assert.deepEqual([logged.said, logged.sent], ["uh, run the um linter", "Run the linter"]);
  console.log(
    "ok:",
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | "),
  );

  begin("clean-up: a correction resends what was sent");
  T.utterance = () => ({ audience: DESK, audienceConfidence: 0.9, intent: "redirect", intentConfidence: 0.9 });
  await talk("no, uh, that was for the other one");
  // The desktop session: resent, cleaned, and not typed in (nothing types into it), which is said.
  await until(() => notSent("desk-1").at(-1)?.text === "Run the linter");
  console.log("ok");

  begin("clean-up: words for the desktop app, cleaned, and what wasn't sent is the cleaned words");
  await wait(300);
  T.utterance = toDesk;
  await talk("um, what about 9 plus 9");
  await until(() => notSent("desk-1").at(-1)?.text === "What about 9 plus 9");
  console.log("ok");

  begin("clean-up: a reply through the held hook, cleaned");
  await wait(2100);
  T.utterance = toTerm;
  T.needs = [0.8];
  const b = held(TERM);
  T.hooks.onRequest(b);
  await windowOpen(TERM);
  await talk("uh, yes, go ahead");
  assert.equal(b.reply, "Yes, go ahead");
  console.log("ok");

  begin("clean-up: off in settings, your words as said");
  await wait(300);
  ui.act({ type: "set", key: "cleanUp", value: false });
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).cleanUp, false);
  assert.equal(ui.state.settings.find((r: any) => r.key === "cleanUp")?.value, "Off");
  const calls = T.cleanCalls;
  T.utterance = toTerm;
  await talk("uh, run the tests");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "uh, run the tests" });
  assert.equal(T.cleanCalls, calls, "not asked");
  ui.act({ type: "set", key: "cleanUp", value: true });
  T.clean = undefined;
  console.log("ok");
}

// 14. Hold unsure sends: when the router picked the session (not your words, not the one waiting,
//     not the classifier at its bar), the app says "To <session>." and holds the send HOLD_MS (100ms here) once
//     that's heard. A press meanwhile keeps it until your words are dealt with.
export async function holdCases() {
  await wait(2100); // windows and the session list cache run out
  const LACY = { ...TERM, sessionId: "lacy-h", name: "lacy", cwd: "/nonexistent/lacy", place: ghostty("ghostty-lacy-h") };
  const SNIP = { ...TERM, sessionId: "snip-h", name: "snip", cwd: "/nonexistent/clipkit", place: ghostty("ghostty-snip-h") };
  const OTHER = { ...TERM, sessionId: "other-h", name: "other", cwd: "/nonexistent/other-thing", place: ghostty("ghostty-other-h") };
  const before = T.sessions;
  T.sessions = [DESK, LACY, SNIP, OTHER];
  await wait(2100);
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  const state = () => JSON.parse(readFileSync("state.json", "utf8"));
  const logged = (event: string) => caseLog().filter((l) => l.event === event);
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id).map((t: any) => t.text);
  const unsureToLacy = () => {
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    T.route = () => [{ name: "pass_on", session: LACY }];
  };
  /** Starts words the router sends to lacy, unsure, and resolves once they're held (not their key up). */
  const heldToLacy = async (text: string) => {
    unsureToLacy();
    const first = talk(text);
    await until(() => Boolean(ui.state.holding));
    return { first }; // not the promise itself: awaiting this would wait for it
  };
  const shown = () =>
    caseLines()
      .filter((l) => l.kind !== "timing")
      .map((l) => `${l.kind}: ${l.text}`)
      .join(" | ");

  begin("hold: unsure → 'To lacy.', held, then sent");
  unsureToLacy();
  let lacyN = typedInto(LACY).length;
  const going = talk("run the tests");
  await until(() => Boolean(ui.state.holding));
  assert.deepEqual([ui.state.holding!.to, ui.state.holding!.sessionId, ui.state.holding!.text], ["lacy", LACY.sessionId, "run the tests"]);
  assert.equal(state().holding.name, "lacy", "the status line shows it");
  await until(() => spoke("To lacy."));
  assert.equal(typedInto(LACY).length, lacyN, "not typed while held");
  await going;
  assert.deepEqual(typedInto(LACY).slice(lacyN), ["run the tests"]);
  assert.equal(ui.state.holding, null);
  assert.equal(state().holding, null);
  assert.equal(ui.state.routed!.to, "lacy");
  assert.equal(ui.state.routed!.text, "run the tests");
  assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text === "To lacy.").length, 1, "said once, not again as it's typed");
  const held = logged("send_held").at(-1);
  const released = logged("send_released").at(-1);
  assert.deepEqual([held.sessionId, held.text, held.why, held.kind], [LACY.sessionId, "run the tests", "router pass_on", "send"]);
  assert.equal(released.after, "timer");
  assert.ok(released.heldMs >= 100 + T.speakMs, `held ${released.heldMs}ms`);
  console.log(`ok: held ${released.heldMs}ms;`, shown());

  begin("hold: a correction while held: only clipkit gets it, lacy never does");
  lacyN = typedInto(LACY).length;
  let snipN = typedInto(SNIP).length;
  const keys = T.keys.length;
  let { first } = await heldToLacy("cut a new build");
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.5, intent: "redirect", intentConfidence: 0.9 });
  T.route = () => {
    throw new Error("no router: the words name clipkit");
  };
  await talk("no, that's for clipkit");
  await first;
  assert.deepEqual(typedInto(SNIP).slice(snipN), ["cut a new build"]);
  assert.equal(typedInto(LACY).length, lacyN, "nothing typed into lacy");
  assert.equal(T.keys.length, keys, "nothing to stop");
  assert.ok(spoke("To clipkit instead."), shown());
  const redirected = logged("send_redirected").at(-1);
  assert.deepEqual([redirected.sessionId, redirected.toSessionId, redirected.text], [LACY.sessionId, SNIP.sessionId, "cut a new build"]);
  assert.equal(logged("send_released").length, 0);
  console.log("ok:", shown());

  begin("hold: 'cancel' while held: nothing sent");
  lacyN = typedInto(LACY).length;
  const typedN = T.typed.length;
  ({ first } = await heldToLacy("delete the old branch"));
  T.utterance = () => {
    throw new Error("no classifier: 'cancel' is read in code");
  };
  await talk("Cancel.");
  await first;
  assert.equal(T.typed.length, typedN, "nothing typed anywhere");
  assert.ok(spoke("Okay, not sent."), shown());
  assert.equal(logged("send_cancelled").at(-1).by, "you");
  assert.equal(ui.state.holding, null);
  console.log("ok:", shown());

  begin("hold: other words while held: the held send goes first, then them");
  const before2 = T.typed.length;
  ({ first } = await heldToLacy("run the linter"));
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk("and check the clipkit build");
  await first;
  assert.deepEqual(T.typed.slice(before2), [
    { terminalId: LACY.place.id, text: "run the linter" },
    { terminalId: SNIP.place.id, text: "and check the clipkit build" },
  ]);
  assert.equal(logged("send_released").at(-1).after, "your words");
  console.log("ok:", shown());

  begin("hold: a press with nothing said: it goes once you let go");
  ({ first } = await heldToLacy("bump the version"));
  lacyN = typedInto(LACY).length;
  await talk("");
  await first;
  assert.deepEqual(typedInto(LACY).slice(lacyN), ["bump the version"]);
  console.log("ok");

  begin("hold: 'wrong one', then where: it goes there; unanswered, it doesn't go");
  lacyN = typedInto(LACY).length;
  snipN = typedInto(SNIP).length;
  ({ first } = await heldToLacy("write the changelog"));
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "redirect", intentConfidence: 0.9 });
  T.route = () => [];
  await talk("no, wrong one");
  assert.equal(typedInto(LACY).length, lacyN, "still held after 'wrong one'");
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.9, intent: "redirect", intentConfidence: 0.9 });
  await talk("the clipkit one");
  await first;
  assert.deepEqual(typedInto(SNIP).slice(snipN), ["write the changelog"]);
  assert.equal(typedInto(LACY).length, lacyN);
  ({ first } = await heldToLacy("update the docs"));
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "redirect", intentConfidence: 0.9 });
  T.route = () => [];
  const typedM = T.typed.length;
  await talk("no, wrong one");
  await first; // HOLD_ANSWER_MS (1s here) passes
  assert.equal(T.typed.length, typedM, "nothing typed");
  assert.equal(logged("send_cancelled").at(-1).by, "unanswered");
  assert.ok(spoke("I didn't send it to lacy."), shown());
  console.log("ok:", shown());

  begin("hold: a session that finishes while a send is held is announced after it");
  T.needs = [0.8];
  ({ first } = await heldToLacy("restart the server"));
  const r = stop(OTHER, "cli");
  T.hooks.onRequest(r);
  await wait(60);
  assert.ok(!caseSaid().some((x: any) => x.text === "summary for other-thing"), "not while held");
  await first;
  await until(() => caseSaid().some((x: any) => x.text === "summary for other-thing"));
  const sentAt = Date.parse(logged("send_released").at(-1).t);
  const announcedAt = caseSaid().find((x: any) => x.text === "summary for other-thing").at;
  assert.ok(announcedAt >= sentAt, `announced ${announcedAt - sentAt}ms after the send went`);
  await until(() => !r.open, 3000);
  console.log("ok");

  begin("hold: sure sends aren't held (the classifier at its bar, words that name it)");
  const heldN = logged("send_held").length;
  T.utterance = () => ({ audience: LACY, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  await talk("run the tests");
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  T.route = () => [{ name: "pass_on", session: SNIP }];
  await talk("tell clipkit to run the tests");
  assert.equal(logged("send_held").length, heldN);
  assert.ok(!caseLines().some((l) => l.text.startsWith("(holding:")));
  console.log("ok");

  begin("hold: off in settings: no hold, as before");
  ui.act({ type: "set", key: "holdUnsure", value: false });
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).holdUnsure, false);
  assert.equal(ui.state.settings.find((x: any) => x.key === "holdUnsure")!.value, "Off");
  unsureToLacy();
  lacyN = typedInto(LACY).length;
  const off = logged("send_held").length;
  await talk("run the tests once more");
  assert.deepEqual(typedInto(LACY).slice(lacyN), ["run the tests once more"]);
  assert.equal(logged("send_held").length, off);
  assert.ok(spoke("To lacy."), "the usual line when it goes somewhere else");
  ui.act({ type: "set", key: "holdUnsure", value: true });
  console.log("ok");

  T.sessions = before;
  T.route = () => [];
}

// "Kiko, …" up front is said to the app (src/core/wake.ts): the name is taken off and the rest routed as usual.
export async function nameCases() {
  await wait(2100); // windows and the session list cache run out
  const toTerm = () => ({ audience: TERM, audienceConfidence: 0.9, intent: "other", intentConfidence: 0.1 });

  begin("name: 'Kiko, …' with the key: the classifier and the session get the words without the name");
  let seen = "";
  T.utterance = (input: any) => ((seen = input.text), toTerm());
  await talk("Kiko, ask atlas agents if it deployed");
  assert.equal(seen, "Ask atlas agents if it deployed");
  // Typed with the direction off, the question as said (src/core/direction.ts: not mechanical to turn around).
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "It deployed?" });
  assert.ok(
    caseLines().some((l) => l.kind === "you" && l.text === "Kiko, ask atlas agents if it deployed"),
    "the conversation shows what you said",
  );
  assert.ok(caseLog().some((l) => l.event === "name_up_front" && l.text === "Ask atlas agents if it deployed"));
  console.log("ok");

  begin("name: only the name is nothing said");
  const typed = T.typed.length;
  let asked = 0;
  T.utterance = () => (asked++, toTerm());
  await talk("Kiko.");
  assert.equal(T.typed.length, typed);
  assert.equal(asked, 0);
  assert.ok(caseLines().some((l) => l.text === '(only "Kiko.": nothing sent)'));
  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  console.log("ok");
}

// The app's "which session?" question (decide.ts answerQuestion), end to end. A short test message got
// "Which session should it go to, Lacy or Kiko?", and the answer naming one (misheard) was typed into
// Kiko. Now the words asked about go there, read in code, and the answer never does.
export async function questionCases() {
  const LACY = { ...TERM, sessionId: "lacy-q", name: "lacy", cwd: "/nonexistent/lacy", place: ghostty("ghostty-lacy-q") };
  const KIKO = { ...TERM, sessionId: "kiko-q", name: "kiko", cwd: "/nonexistent/kiko", place: ghostty("ghostty-kiko-q") };
  const before = T.sessions;
  T.sessions = [LACY, KIKO];
  await wait(2100); // windows and the session list cache run out
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  const LINE = "I can't tell who that's for. It sounds like a phone check. Which session should it go to, Lacy or Kiko?";
  const ORIGINAL = "A quick test sent from the phone on my way to the.";
  const logged = (event: string) => caseLog().filter((l) => l.event === event);
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id).map((t: any) => t.text);
  const ask = async () => {
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
    T.clean = (t: string) => t.replace("test, um, sent", "test sent");
    T.route = () => [];
    T.routeText = LINE;
    await talk("A quick test, um, sent from the phone on my way to the.");
    await until(() => spoke(LINE));
    T.routeText = undefined;
    T.route = () => {
      throw new Error("no router: the answer is read in code");
    };
    T.utterance = () => {
      throw new Error("no classifier: the answer is read in code");
    };
  };

  begin("question: 'It should go to, uh, Kiku.' sends the words asked about to Kiko, never the answer");
  const typed = T.typed.length;
  await ask();
  assert.equal(T.typed.length, typed, "nothing sent with the question");
  // A session in the kiko folder is listed as "Kiko project" (sessions.ts APP_NAMED), said why once a run.
  assert.deepEqual(
    logged("question_pending").map((l) => [l.text, l.offered]),
    [[ORIGINAL, ["lacy", "Kiko project"]]],
  );
  assert.equal(caseLines().filter((l) => /shown as "Kiko project"/.test(l.text)).length, 1, "why it's called that: one line");
  await talk("It should go to, uh, Kiku.");
  await until(() => typedInto(KIKO).length > 0);
  const sent = T.typed.slice(typed);
  assert.deepEqual(sent, [{ terminalId: KIKO.place.id, text: ORIGINAL }]);
  assert.ok(sent.some((t: any) => /quick test/.test(t.text)));
  assert.ok(!T.typed.some((t: any) => /should go to/i.test(t.text)), "the answer is never typed");
  assert.ok(spoke("To Kiko project."), "said where it went");
  // "Kiku" is the name once the dictionary has written it Kiko.
  assert.deepEqual(
    logged("question_answered").map((l) => [l.sessionId, l.how, l.text]),
    [[KIKO.sessionId, "name", ORIGINAL]],
  );
  console.log("ok");

  begin("question: 'Kiko.' alone is a pick, not only the app's name");
  await wait(1700);
  const n = typedInto(KIKO).length;
  await ask();
  await talk("Kiko.");
  await until(() => typedInto(KIKO).length > n);
  assert.deepEqual(typedInto(KIKO).slice(n), [ORIGINAL]);
  assert.equal(logged("question_answered").at(-1).how, "name");
  console.log("ok");

  begin("question: 'Never mind.' drops them, and says so");
  await wait(1700);
  const m = T.typed.length;
  await ask();
  await talk("Never mind.");
  await until(() => spoke("Okay, not sent."));
  await wait(200);
  assert.equal(T.typed.length, m, "nothing typed");
  assert.deepEqual(
    logged("question_cancelled").map((l) => l.text),
    [ORIGINAL],
  );
  console.log("ok");

  // Moving on from the question used to drop the words it asked about, logged (question_dropped) and never
  // said. Now they're kept, the app says once that they weren't sent, after its answer to the new words,
  // and a plain pick still sends them.
  const NOT_SENT = 'I didn\'t send "A quick test sent from the…" anywhere.';
  begin("question: moving on keeps the words asked about, says once they weren't sent, and a pick still sends them");
  await wait(1700);
  let k = T.typed.length;
  await ask();
  T.utterance = () => ({ audience: LACY, audienceConfidence: 0.95, intent: "message", intentConfidence: 1 });
  T.route = () => [{ name: "pass_on", session: LACY }];
  await talk("Check the build.");
  await until(() => spoke(NOT_SENT));
  assert.deepEqual(T.typed.slice(k), [{ terminalId: LACY.place.id, text: "Check the build." }], "the new words went; the ones asked about didn't");
  const voice = caseLines()
    .filter((l) => l.kind === "voice")
    .map((l) => l.text);
  assert.equal(voice.at(-1), NOT_SENT, "after the answer to the new words");
  assert.equal(voice.filter((t) => t === NOT_SENT).length, 1);
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text.startsWith('(not sent anywhere yet: "A quick test sent from the phone on my way to the."; you moved on')));
  assert.deepEqual(
    logged("question_kept").map((l) => [l.text, l.why]),
    [[ORIGINAL, "moved on"]],
  );
  assert.equal(logged("question_dropped").length, 0);
  // More new words: said once only, and still kept.
  T.utterance = () => ({ audience: LACY, audienceConfidence: 0.95, intent: "message", intentConfidence: 1 });
  await talk("And the linter.");
  await wait(100);
  assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text === NOT_SENT).length, 1, "said once");
  // A plain pick, read in code: the words asked about go there.
  T.route = () => {
    throw new Error("no router: the pick is read in code");
  };
  T.utterance = () => {
    throw new Error("no classifier: the pick is read in code");
  };
  k = typedInto(KIKO).length;
  await talk("Kiko.");
  await until(() => typedInto(KIKO).length > k);
  assert.deepEqual(typedInto(KIKO).slice(k), [ORIGINAL]);
  assert.deepEqual(
    logged("question_answered").map((l) => [l.sessionId, l.how]),
    [[KIKO.sessionId, "name"]],
  );
  console.log("ok");

  // New words the app asks "which session?" about too: it keeps only one, so the words before go, said
  // first, so that the new question is the last thing you hear.
  begin("question: a new question about other words: the words before weren't sent, said before it");
  await wait(1700);
  k = T.typed.length;
  await ask();
  const SECOND = "Which session should the checklist go to, Lacy or Kiko?";
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  T.route = () => [];
  T.routeText = SECOND;
  await talk("Run the release checklist and post the results somewhere.");
  await until(() => spoke(SECOND));
  T.routeText = undefined;
  const said = caseLines()
    .filter((l) => l.kind === "voice")
    .map((l) => l.text);
  assert.deepEqual(said.slice(-2), [NOT_SENT, SECOND]);
  assert.deepEqual(
    logged("question_dropped").map((l) => [l.text, l.why]),
    [[ORIGINAL, "replaced"]],
  );
  assert.equal(logged("question_pending").at(-1).text, "Run the release checklist and post the results somewhere.");
  assert.equal(T.typed.length, k);
  await talk("Never mind.");
  await until(() => spoke("Okay, not sent."));
  console.log("ok");

  // Nobody answered: after QUESTION_MS (600ms here) it runs out, and the app says so, once.
  begin("question: unanswered, it runs out and the app says the words weren't sent");
  await wait(1700);
  process.env.KIKO_TEST_QUESTION_MS = "600";
  k = T.typed.length;
  await ask();
  await until(() => spoke(NOT_SENT), 2000);
  delete process.env.KIKO_TEST_QUESTION_MS;
  assert.equal(T.typed.length, k, "nothing typed");
  assert.deepEqual(
    logged("question_dropped").map((l) => [l.text, l.why, l.told]),
    [[ORIGINAL, "expired", false]],
  );
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text === '(not sent anywhere: "A quick test sent from the phone on my way to the."; the question ran out)'));
  console.log("ok");

  // Moved on from, then run out: it was said already, so only shown and logged.
  begin("question: moved on from, then run out: shown and logged, not said again");
  await wait(1700);
  process.env.KIKO_TEST_QUESTION_MS = "600";
  await ask();
  T.utterance = () => ({ audience: LACY, audienceConfidence: 0.95, intent: "message", intentConfidence: 1 });
  T.route = () => [{ name: "pass_on", session: LACY }];
  await talk("Check the build.");
  await until(() => logged("question_dropped").length > 0, 2000);
  delete process.env.KIKO_TEST_QUESTION_MS;
  assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text === NOT_SENT).length, 1, "said once, as you moved on");
  assert.deepEqual(
    logged("question_dropped").map((l) => [l.why, l.told]),
    [["expired", true]],
  );
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text.startsWith('(not sent anywhere: "A quick test sent from the phone on my way to the."; the question ran out')));
  console.log("ok");

  T.clean = undefined;
  T.route = () => [];
  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  T.sessions = before;
  await wait(2100);
}

// The app offering a session (router.ts offer_session, decide.ts answerQuestion), end to end. The router
// once offered in its own words, with no tool call, to pass a question along to the session working on
// it, and the yes ("Yes, pass it to Bobby.") was typed into Bobby by itself. Now the offer keeps the words, a yes sends them, a no or words that move on drop it,
// and unanswered it runs out like any question the app asks.
export async function offerCases() {
  const BOBBY = { ...TERM, sessionId: "bobby-o", name: "Bobby", givenName: "Bobby", cwd: "/nonexistent/2026-01-20-internal", place: ghostty("ghostty-bobby-o") };
  const SNIP = { ...TERM, sessionId: "snip-o", name: "mintbox", cwd: "/nonexistent/mintbox", place: ghostty("ghostty-snip-o") };
  const before = T.sessions;
  T.sessions = [SNIP, BOBBY];
  await wait(2100); // windows and the session list cache run out
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  const ASKED =
    "Could you, um, set up a, uh, photo backup on my home server that, uh, runs every night? Uh, but only over the home Wi-Fi, not the phone's data? Don't change anything yet, just answer. We're only talking about it.";
  const LINE = "Want me to send that to Bobby?";
  const FREE_TEXT = "That one's for your sessions, not me. Bobby is the one on your home server, so I can pass your question along to it if you want.";
  const logged = (event: string) => caseLog().filter((l) => l.event === event);
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id).map((t: any) => t.text);
  /** The question, offered to Bobby (offer_session, or `says`: the router's own words); the next words are read in code. */
  const offer = async (says?: string) => {
    T.utterance = () => ({ audience: BOBBY, audienceConfidence: 0.69, intent: "message", intentConfidence: 1 });
    T.route = () => (says ? [] : [{ name: "offer_session", session: BOBBY }]);
    T.routeText = says;
    await talk(ASKED);
    await until(() => spoke(says ?? LINE));
    T.routeText = undefined;
    T.route = () => {
      throw new Error("no router: the answer is read in code");
    };
    T.utterance = () => {
      throw new Error("no classifier: the answer is read in code");
    };
  };

  begin("offer: 'Yes, pass it to Bobby.' sends the question offered to Bobby, never the yes");
  let k = T.typed.length;
  await offer();
  assert.equal(T.typed.length, k, "nothing sent with the offer");
  assert.deepEqual(
    logged("question_pending").map((l) => [l.text, l.offered, l.line, l.offer]),
    [[ASKED, ["Bobby"], LINE, true]],
  );
  // The window's list (looked at every 4s) without Bobby yet, as it was in about half the runs: where it
  // went is still said by the name just offered, never by its folder ("To 2026 11 05 internal.").
  ui.set({ sessions: before });
  await talk("Yes, pass it to Bobby.");
  await until(() => typedInto(BOBBY).length > 0);
  assert.deepEqual(T.typed.slice(k), [{ terminalId: BOBBY.place.id, text: ASKED }]);
  assert.ok(!T.typed.some((t: any) => /pass it to Bobby/i.test(t.text)), "the yes is never typed");
  assert.ok(spoke("To Bobby."), "said where it went");
  assert.deepEqual(
    logged("question_answered").map((l) => [l.sessionId, l.how, l.text]),
    [[BOBBY.sessionId, "yes", ASKED]],
  );
  console.log("ok");

  begin("offer: the router's offer in its own words is kept all the same: the yes sends the question");
  await wait(1700);
  k = typedInto(BOBBY).length;
  await offer(FREE_TEXT);
  assert.equal(logged("question_pending").at(-1)?.offer, true);
  await talk("Yes, pass it to Bobby.");
  await until(() => typedInto(BOBBY).length > k);
  assert.deepEqual(typedInto(BOBBY).slice(k), [ASKED]);
  console.log("ok");

  begin("offer: 'No.' drops it, and says so");
  await wait(1700);
  k = T.typed.length;
  await offer();
  await talk("No.");
  await until(() => spoke("Okay, not sent."));
  await wait(200);
  assert.equal(T.typed.length, k, "nothing typed");
  assert.deepEqual(
    logged("question_cancelled").map((l) => l.text),
    [ASKED],
  );
  console.log("ok");

  begin("offer: unrelated words drop it and go where they would have; nothing said about the offer");
  await wait(1700);
  k = T.typed.length;
  await offer();
  T.utterance = () => ({ audience: SNIP, audienceConfidence: 0.95, intent: "message", intentConfidence: 1 });
  T.route = () => [{ name: "pass_on", session: SNIP }];
  await talk("Tell mintbox to install tmux.");
  await until(() => T.typed.length > k);
  await wait(300);
  assert.deepEqual(T.typed.slice(k), [{ terminalId: SNIP.place.id, text: "Install tmux." }], "the new words went; the question offered didn't");
  assert.deepEqual(
    logged("question_dropped").map((l) => [l.text, l.why, l.offer]),
    [[ASKED, "moved on", true]],
  );
  assert.equal(logged("question_kept").length, 0, "not kept for a later pick");
  assert.ok(!caseLines().some((l) => l.kind === "voice" && /^I didn't send/.test(l.text)), "an offer moved on from isn't said");
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text.startsWith('(not sent anywhere: "Could you, um, set up') && l.text.endsWith("you moved on from the offer)")));
  // And a yes now is only words: nothing offered is left to send.
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  T.route = () => [];
  T.routeText = "Okay.";
  const bobby = typedInto(BOBBY).length;
  await talk("Yes, pass it to Bobby.");
  await until(() => spoke("Okay."));
  T.routeText = undefined;
  assert.equal(typedInto(BOBBY).length, bobby);
  console.log("ok");

  begin("offer: unanswered, it runs out like any question: dropped, and said once");
  await wait(1700);
  process.env.KIKO_TEST_QUESTION_MS = "600";
  k = T.typed.length;
  await offer();
  await until(() => logged("question_dropped").length > 0, 2000);
  delete process.env.KIKO_TEST_QUESTION_MS;
  await until(() => spoke('I didn\'t send "Could you, um, set up a…" anywhere.'), 2000);
  assert.equal(T.typed.length, k, "nothing typed");
  assert.deepEqual(
    logged("question_dropped").map((l) => [l.text, l.why]),
    [[ASKED, "expired"]],
  );
  // Gone: a yes now sends nothing offered.
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 0.9 });
  T.route = () => [];
  T.routeText = "Okay.";
  await talk("Yes.");
  await until(() => spoke("Okay."));
  T.routeText = undefined;
  assert.equal(T.typed.length, k, "still nothing typed");
  console.log("ok");

  T.route = () => [];
  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  T.sessions = before;
  await wait(2100);
}

// A press while the words before are still dealt with (a press while the router thought once dropped
// the words it decided on, with nothing in the log). Your words are
// decided in the order you said them (src/core/in-line.ts), and a send waits for the newer words, held: they
// cancel or redirect it, or it goes first. A send that fails is logged and said. The phone's own replay of
// that case is in phoneCases.
export async function pressedAgainCases() {
  const PIXIE = { ...TERM, sessionId: "pixie-pa", name: "pixie", cwd: "/nonexistent/pixie", place: ghostty("ghostty-pixie-pa") };
  const before = T.sessions;
  T.sessions = [DESK, TERM, PIXIE];
  await wait(2100); // windows and the session list cache run out
  const logged = (event: string) => caseLog().filter((l) => l.event === event);
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id).map((t: any) => t.text);
  const sure = () => ({ audience: PIXIE, audienceConfidence: 0.9, intent: "message", intentConfidence: 1 });
  const unsure = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
  /** Key down and up with `text`; the promise is the key up's (it resolves once its words are dealt with). */
  const press = async (text: string) => {
    T.heard = text;
    T.hotkey.onDown();
    await wait(20);
    return { up: T.hotkey.onUp() };
  };

  begin("pressed again: a press and let go while the router thinks: the first words go first, then the second");
  T.utterance = (input: any) => (/linter/.test(input.text) ? sure() : unsure());
  T.route = () => [{ name: "pass_on", session: PIXIE }];
  T.routeDelayMs = 400;
  let n = typedInto(PIXIE).length;
  const a = await press("run the tests");
  await wait(100); // the router thinks
  const b = await press("and the linter");
  await Promise.all([a.up, b.up]);
  await until(() => typedInto(PIXIE).length >= n + 2);
  T.routeDelayMs = 0;
  assert.deepEqual(typedInto(PIXIE).slice(n), ["run the tests", "and the linter"]);
  assert.deepEqual(
    logged("pressed_while_deciding").map((l) => [l.text, l.router]),
    [["run the tests", true]],
  );
  assert.deepEqual(
    logged("send_released").map((l) => [l.text, l.after]),
    [["run the tests", "your words"]],
  );
  assert.equal(logged("send_dropped").length, 0);
  console.log("ok");

  begin("pressed again: 'cancel' said while the words before were decided: they're not sent, and it says so");
  await wait(300);
  T.utterance = sure;
  T.utteranceDelayMs = 300;
  n = T.typed.length;
  const c = await press("deploy to production");
  await wait(100); // the classifier reads it
  T.heard = "Cancel.";
  T.hotkey.onDown();
  await until(() => logged("send_held").length > 0, 1000);
  T.utteranceDelayMs = 0;
  assert.equal(logged("send_held")[0].why, "pressed while deciding", "a sure send, held for the words after it");
  assert.equal(logged("send_held")[0].waitingFor, "your next words");
  assert.ok(!spoke("To pixie."), "not said over the press");
  await T.hotkey.onUp();
  await c.up;
  assert.equal(T.typed.length, n, "nothing typed");
  assert.ok(spoke("Okay, not sent."));
  assert.equal(logged("send_cancelled").at(-1).by, "you");
  console.log("ok");

  begin("pressed again while the words were turned into text: they still go, once the new press is let go");
  await wait(300);
  T.utterance = sure;
  T.sttDelayMs = 150;
  n = typedInto(PIXIE).length;
  const d = await press("bump the version");
  await wait(50);
  T.heard = "";
  T.hotkey.onDown();
  await until(() => logged("pressed_while_hearing").length > 0, 1000);
  T.sttDelayMs = 0;
  await until(() => logged("send_held").length > 0, 1000);
  assert.equal(typedInto(PIXIE).length, n, "held while the key is down");
  await T.hotkey.onUp(); // nothing said
  await d.up;
  assert.deepEqual(typedInto(PIXIE).slice(n), ["bump the version"]);
  assert.deepEqual(
    logged("pressed_while_hearing").map((l) => l.text),
    ["bump the version"],
  );
  console.log("ok");

  begin("pressed again: typing that fails is logged and said, never silent");
  await wait(300);
  T.utterance = sure;
  T.typeFails = "osascript: not allowed";
  n = T.typed.length;
  await (await press("open the logs")).up;
  T.typeFails = undefined;
  assert.equal(T.typed.length, n);
  assert.deepEqual(
    logged("send_failed").map((l) => [l.sessionId, l.text, l.why]),
    [[PIXIE.sessionId, "open the logs", "osascript: not allowed"]],
  );
  assert.ok(spoke("I couldn't send that to pixie."));
  console.log("ok");

  // Pressed again within the key's tail (300ms here, as in the app): the first press's end closed the mic
  // under the second press, and restarted speech-to-text under it (the stub, like Apple's helper, cancels a
  // press begun over another): the first press's words were lost, the second's cut. Each press has its own
  // now (src/core/press-stt.ts): the second's audio waits for the first's words, then goes, in order.
  begin("pressed again within the key's tail: the first press's words, then the second's, its recording not cut");
  await wait(300);
  T.utterance = sure;
  process.env.KIKO_TEST_TAIL_MS = "300";
  T.pressWords = ["run the tests", "and the linter"];
  const begun = (T.sttPresses ??= []).length;
  n = typedInto(PIXIE).length;
  const chunk = () => T.mic(Buffer.alloc(3200, 0x40));
  T.hotkey.onDown();
  chunk();
  await wait(20);
  const first = T.hotkey.onUp();
  await wait(100); // within the tail
  T.hotkey.onDown();
  chunk();
  await wait(350); // the first press's tail is over: its words are turned into text
  assert.equal(T.micOpen, true, "the second press is still recording");
  chunk();
  await T.hotkey.onUp();
  await first;
  await until(() => typedInto(PIXIE).length >= n + 2);
  process.env.KIKO_TEST_TAIL_MS = "0";
  assert.deepEqual(typedInto(PIXIE).slice(n), ["run the tests", "and the linter"]);
  assert.deepEqual(
    T.sttPresses.slice(begun).map((x: any) => [x.words, x.chunks, x.cancelled]),
    [
      ["run the tests", 1, false],
      ["and the linter", 2, false],
    ],
  );
  assert.deepEqual(
    logged("transcript").map((l) => l.text),
    ["run the tests", "and the linter"],
  );
  assert.equal(logged("stt_press_waits").length, 1);
  assert.equal(logged("send_dropped").length + logged("send_failed").length, 0);
  assert.equal(T.micOpen, false, "closed once the second press is over");
  console.log("ok");

  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  T.route = () => [];
  T.sessions = before;
  T.hooks.onSessionsChanged();
  await until(() => !ui.state.sessions.some((s: any) => s.sessionId === PIXIE.sessionId), 1000);
  await wait(2100);
}
