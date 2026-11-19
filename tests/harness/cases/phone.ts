// The phone (src/remote/, Settings → Phone): a fake phone over a real WebSocket on 127.0.0.1 and a port the
// system picks (run.sh: KIKO_PHONE_HOST, KIKO_PHONE_PORT=0). No real interfaces or Bonjour
// (stubs/platform/macos/network.ts). Every message the hub sends is checked against protocol/schema.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  begin,
  caseLines,
  caseLog,
  casePlayed,
  caseSaid,
  CLAUDE,
  config,
  DESK,
  ghostty,
  HookRequest,
  info,
  logEntries,
  logFile,
  markHere,
  near,
  notSent,
  parsePairUrl,
  Phone,
  phoneServer,
  PROJECTS_ROOT,
  scanQr,
  sessionStatus,
  SOUNDS,
  spoke,
  startOpened,
  stop,
  T,
  talk,
  TERM,
  ui,
  until,
  wait,
} from "../driver.ts";

// The phone paired in phoneCases, for rejoin.
let pairedToken = "";

/**
 * The paired phone connected again (its connection replaced by another of its own), in front: as the app
 * does, it says `back` right after welcome, and that connection's presence is the phone's (phone_presence
 * back, on connect). Waits for the hub to log it, so a case goes on with the phone back, not a moment before.
 */
async function rejoin() {
  const before = logEntries().length;
  const again = new Phone();
  await again.send({ type: "hello", token: pairedToken, device: "Test iPhone", appVersion: "0.2.0" });
  await again.next("welcome");
  await until(
    () =>
      logEntries()
        .slice(before)
        .some((l) => l.event === "phone_presence" && l.state === "back" && l.on === "connect"),
    2000,
    "the phone to be back (it said so as it connected)",
  );
  return again;
}

export async function phoneCases() {
  const { HAND_OFF_LINE: HAND_OFF } = await import("../../../src/core/quick-ask.ts");
  const row = (key: string) => ui.state.settings.find((r: any) => r.key === key);
  const set = (key: string, value: unknown) => ui.act({ type: "set", key: key as any, value });
  const events = (name: string) => caseLog().filter((l) => l.event === name);
  let port = 0;

  await wait(2100); // windows and the session list cache run out

  begin("phone: off by default; on, it listens, advertises with Bonjour, and shows how to connect");
  ui.act({ type: "settings" });
  assert.equal(row("phone")?.value, "Off");
  assert.equal(row("phoneConnect")?.value, "Turn Phone on first");
  set("phone", true);
  await until(() => events("phone_on").length > 0);
  port = phoneServer.port = events("phone_on")[0].port;
  assert.ok(port > 0);
  await until(() => String(row("phoneConnect")?.value).includes("192.168.1.20"));
  assert.equal(row("phoneConnect")?.value, `192.168.1.20:${port} · Tailscale 100.101.102.103:${port}`);
  assert.deepEqual([T.advertised.type, T.advertised.port, T.advertised.txt], ["_kiko._tcp", port, { v: "1", host: "test-mac.local", port: String(port) }]);
  // Advertised once, under that type.
  assert.deepEqual(
    T.advertisedAll.map((a: any) => [a.type, a.port]),
    [["_kiko._tcp", port]],
  );
  assert.match(String(row("phonePairing")?.value), /^\d{6} \(until /, "no phone yet: a code at once");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).phone, true);
  console.log("ok");

  begin("phone: a wrong code is refused and closed; the right one pairs, and the token is never logged");
  const code = String(row("phonePairing")!.raw);
  const wrong = new Phone();
  await wrong.send({ type: "pair", code: code === "000000" ? "000001" : "000000", device: "Wrong phone", appVersion: "0.1.0" });
  assert.equal((await wrong.next("error")).code, "bad_code");
  await until(() => wrong.closed);
  assert.ok(events("phone_refused").some((l) => l.reason === "bad_code"));
  let p = new Phone();
  await p.send({ type: "pair", code, device: "Test iPhone", appVersion: "0.1.0" });
  const paired = await p.next("paired");
  pairedToken = paired.token;
  assert.ok(paired.token.length >= 40);
  const welcome = await p.next("welcome");
  assert.deepEqual([welcome.phoneId, welcome.playOnPhone, welcome.versions], [paired.phoneId, true, [1]]);
  // Every way to reach the Mac, so a phone paired at home finds it anywhere through Tailscale.
  const everywhere = [
    { kind: "home", host: "192.168.1.20", port },
    { kind: "bonjour", host: "test-mac.local", port },
    { kind: "tailscale", host: "100.101.102.103", port },
    { kind: "tailscale", host: "test-mac.tail1a2b3c.ts.net", port },
  ];
  assert.deepEqual(paired.addresses, everywhere);
  assert.deepEqual(welcome.addresses, everywhere);
  await p.next("sessions");
  await p.next("state");
  assert.equal((await p.next("permission_prompt")).prompt, null);
  assert.equal(events("phone_paired")[0]?.name, "Test iPhone");
  assert.ok(events("phone_connected").some((l) => l.phoneId === paired.phoneId));
  const logged = readFileSync(logFile(), "utf8");
  assert.ok(!logged.includes(paired.token), "no token in the log");
  assert.ok(!logged.includes(`"${code}"`), "nor the code");
  assert.ok(!readFileSync("phones.json", "utf8").includes(paired.token), "nor in phones.json");
  await until(() => row("phonePairing")?.value === "Closed");
  assert.equal(row("phones")?.value, "Test iPhone ●");
  console.log("ok");

  begin("phone: an unknown token is refused; the paired one gets back in");
  const stranger = new Phone();
  await stranger.send({ type: "hello", token: "x".repeat(43), device: "Stranger", appVersion: "0.1.0" });
  // Its token's handshake names no phone: turned away before the tunnel, in the clear (protocol/README.md, Encrypted at home).
  assert.equal((await stranger.next("error")).code, "unknown_phone");
  await until(() => stranger.closed);
  assert.ok(events("phone_refused").some((l) => l.reason === "unknown_token"));
  const early = new Phone();
  await early.send({ type: "get_sessions" });
  assert.equal((await early.next("error")).code, "unauthorized", "nothing before hello");
  await until(() => early.closed);
  // An app that says nothing of where it is: one that says replaces the phone's other connection (`p`, still in use).
  const again = new Phone(null);
  await again.send({ type: "hello", token: paired.token, device: "Test iPhone", appVersion: "0.1.0" });
  assert.equal((await again.next("welcome")).phoneId, paired.phoneId);
  again.close();
  console.log("ok");

  begin("phone: Pair a phone shows a QR code a camera reads; the phone pairs by it, the screen says so and closes; used, or closed with Esc, it's refused");
  set("phonePair", "open");
  await until(() => ui.state.pairQr?.phase === "showing", 2000, "the QR code");
  const qrShown = ui.state.pairQr as any;
  // As a camera reads it off the screen: the symbol, a light quiet zone round it.
  const qrScanned = scanQr(qrShown.qr.modules);
  const qrLink = parsePairUrl(qrScanned!)!;
  assert.ok(qrLink, `a pairing URL: ${qrScanned?.slice(0, 40)}`);
  assert.deepEqual([qrLink.port, qrLink.hosts], [port, ["192.168.1.20", "100.101.102.103", "test-mac.tail1a2b3c.ts.net"]]);
  // The typed code beneath it, for a phone without a camera: the one Settings shows.
  assert.equal(qrShown.code, String(row("phonePairing")!.raw));
  assert.match(qrShown.code, /^\d{6}$/);
  const qrScanner = new Phone("back", { secret: qrLink.secret });
  await qrScanner.send({ type: "pair", code: qrLink.secret.toString("base64url"), device: "Scanning iPhone", appVersion: "0.4.0" });
  const qrPaired = await qrScanner.next("paired");
  assert.equal(qrLink.name, qrPaired.hubName, "the Mac's name, as the phone will list it");
  // The phone's check that it reached this Mac: the key the code showed.
  assert.equal((await qrScanner.next("welcome")).macKey, qrLink.macKey.toString("base64"));
  await until(() => ui.state.pairQr?.phase === "paired", 2000, "✓ paired");
  assert.equal((ui.state.pairQr as any).phone, "Scanning iPhone");
  await until(() => ui.state.pairQr === null, 4000, "the pairing screen to close");
  assert.equal(row("phonePairing")?.value, "Closed", "one phone: the typed code closed with it");
  const qrReused = new Phone("back", { secret: qrLink.secret });
  await qrReused.send({ type: "pair", code: qrLink.secret.toString("base64url"), device: "Another iPhone", appVersion: "0.4.0" });
  assert.equal((await qrReused.next("error")).code, "qr_used");
  // Shown again, then closed with Esc: that one stops working at once.
  set("phonePair", "open");
  await until(() => ui.state.pairQr?.phase === "showing", 2000, "a new QR code");
  const qrSecond = parsePairUrl(scanQr((ui.state.pairQr as any).qr.modules)!)!;
  assert.notEqual(qrSecond.secret.toString("hex"), qrLink.secret.toString("hex"), "a new secret each time");
  set("phonePair", "close");
  assert.equal(ui.state.pairQr, null);
  const qrClosed = new Phone("back", { secret: qrSecond.secret });
  await qrClosed.send({ type: "pair", code: qrSecond.secret.toString("base64url"), device: "Another iPhone", appVersion: "0.4.0" });
  assert.equal((await qrClosed.next("error")).code, "qr_expired");
  // Never the secret (or the URL), in the log or phones.json.
  const qrLog = readFileSync(logFile(), "utf8");
  for (const secret of [qrLink.secret, qrSecond.secret]) {
    assert.ok(!qrLog.includes(secret.toString("base64url")) && !qrLog.includes(secret.toString("hex")), "no secret in the log");
    assert.ok(!readFileSync("phones.json", "utf8").includes(secret.toString("base64url")));
  }
  assert.ok(!qrLog.includes("sh.kiko.ios://"), "nor the URL");
  assert.deepEqual(
    events("phone_pairing_qr").map((l) => [l.open, l.why ?? null]),
    [
      [true, null],
      [false, "paired"],
      [true, null],
      [false, "closed"],
    ],
  );
  assert.equal(events("phone_paired").at(-1)?.how, "qr");
  // Back as the cases after expect: one phone paired, pairing closed.
  qrScanner.close();
  set("phones", `forget:${qrPaired.phoneId}`);
  set("phonePairing", "close");
  await until(() => row("phones")?.value === "Test iPhone ●");
  console.log("ok");

  begin("phone: the session list, with each one's status and latest line");
  // The app lists sessions every 4 seconds: the hands-free cases' extra one may still be listed.
  await until(() => !ui.state.sessions.some((s: any) => s.sessionId === "lacy-h"), 5000);
  let from = p.got.length;
  await p.send({ type: "get_sessions" });
  const list = (await p.next("sessions", () => true, from)).sessions;
  assert.deepEqual(
    list.map((s: any) => [s.id, s.name, s.status, s.desktop]),
    [
      ["desk-1", "2 plus 2", "idle", true],
      ["term-1", "atlas-agents", "idle", false],
    ],
  );
  // For the home screen's cards: Claude Code's mark and its light colour, both outside Kiko's
  // window (the desktop app's, a terminal's: EXTERNAL), and nothing being done by idle ones.
  assert.deepEqual(
    list.map((s: any) => [s.id, s.mark, s.colorLight, s.inApp, s.doing]),
    [
      ["desk-1", "✻", "#C15F3C", false, undefined],
      ["term-1", "✻", "#C15F3C", false, undefined],
    ],
  );
  await p.send({ type: "watch", sessionId: "nope" });
  assert.equal((await p.next("error", (m) => m.code === "no_session", from)).code, "no_session");
  await p.send({ type: "watch", sessionId: "term-1" });
  const history = await p.next("history", () => true, from);
  assert.deepEqual([history.sessionId, history.items], ["term-1", []], "no transcript here: empty");
  await p.send({ type: "watch", sessionId: null });
  console.log("ok");

  begin("phone: typed words are routed like spoken ones");
  const routeTo = (s: any) => () => ({ audience: s, audienceConfidence: 0.9, intent: "message", intentConfidence: 0.9 });
  T.utterance = routeTo(TERM);
  await p.send({ type: "type", text: "push the branch" });
  await until(() => T.typed.at(-1)?.text === "push the branch");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "push the branch" });
  assert.ok(caseLines().some((l) => l.kind === "you" && l.text === "push the branch"));
  assert.ok(info("→ typed into atlas-agents"), "as for spoken words");
  assert.deepEqual(
    events("phone_type").map((l) => [l.text, l.sessionId]),
    [["push the branch", null]],
  );
  await p.next("heard", (m) => m.final && m.text === "push the branch");
  console.log("ok");

  begin("phone: typed in a session's screen, words go to that session, whatever the classifier thinks");
  T.utterance = routeTo(TERM);
  const typedToTerm = T.typed.length;
  await p.send({ type: "type", text: "and 6 plus 6", sessionId: "desk-1" });
  // The desktop session's screen: there, not atlas agents, and not sent (nothing types into the desktop app).
  await until(() => notSent("desk-1").at(-1)?.text === "and 6 plus 6");
  assert.equal(T.typed.length, typedToTerm, "not typed into atlas agents");
  assert.equal(events("phone_type").at(-1)?.sessionId, "desk-1");
  await wait(1700); // the last send's moment passes
  console.log("ok");

  // What became of the phone's words (talk_status, src/remote/talk-status.ts): only for a talkId.
  const talkStatuses = (talkId: string, from: number) => p.got.slice(from).filter((m) => m.type === "talk_status" && m.talkId === talkId);

  begin("phone: typed words with a talkId: heard, routed, delivered, started as the session takes them in (UserPromptSubmit), then replied as its turn ends");
  T.utterance = routeTo(TERM);
  from = p.got.length;
  await p.send({ type: "type", text: "run the linter", sessionId: "term-1", talkId: "typed-a" });
  const typedDelivered = await p.next("talk_status", (m) => m.talkId === "typed-a" && m.stage === "delivered", from);
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "run the linter" });
  assert.deepEqual([typedDelivered.sessionId, typedDelivered.name, typedDelivered.text, typedDelivered.queued], ["term-1", "atlas-agents", "run the linter", undefined], "idle: not queued");
  // Another session's prompt, or other words: not these.
  T.hooks.onPromptSubmitted("desk-1", "run the linter");
  T.hooks.onPromptSubmitted("term-1", "something typed by hand");
  await wait(50);
  T.hooks.onPromptSubmitted("term-1", "run the linter");
  await p.next("talk_status", (m) => m.talkId === "typed-a" && m.stage === "started", from);
  assert.deepEqual(
    talkStatuses("typed-a", from).map((m) => m.stage),
    ["heard", "routed", "delivered", "started"],
  );
  assert.deepEqual(talkStatuses("typed-a", from)[1], { v: 1, type: "talk_status", talkId: "typed-a", stage: "routed", sessionId: "term-1", name: "atlas-agents" });
  assert.equal(talkStatuses("typed-a", from).filter((m) => m.stage === "started").length, 1);
  // Its turn ends (the Stop hook): replied, and the phone stops waiting.
  const typedTurn = stop(TERM, "cli");
  T.hooks.onRequest(typedTurn);
  await p.next("talk_status", (m) => m.talkId === "typed-a" && m.stage === "replied", from);
  assert.deepEqual(
    talkStatuses("typed-a", from).map((m) => m.stage),
    ["heard", "routed", "delivered", "started", "replied"],
  );
  assert.deepEqual(talkStatuses("typed-a", from).at(-1), { v: 1, type: "talk_status", talkId: "typed-a", stage: "replied", sessionId: "term-1", name: "atlas-agents" });
  await until(() => typedTurn.settledAt > 0, 8000);
  await wait(1700);
  console.log("ok");

  begin("phone: typed into a busy session: delivered, queued (it takes them once it finishes)");
  T.sessions = [DESK, { ...TERM, status: "busy" }];
  await wait(1100); // the session list cache runs out
  from = p.got.length;
  await p.send({ type: "type", text: "and fix the warnings", sessionId: "term-1", talkId: "typed-b" });
  const typedQueued = await p.next("talk_status", (m) => m.talkId === "typed-b" && m.stage === "delivered", from);
  assert.equal(typedQueued.queued, true);
  T.sessions = [DESK, TERM];
  await wait(1700);
  console.log("ok");

  begin("phone: typing refused (osascript): the talk fails with why, never left at sending");
  T.typeFails = "osascript: not allowed";
  from = p.got.length;
  await p.send({ type: "type", text: "open the logs", sessionId: "term-1", talkId: "typed-c" });
  const typedRefused = await p.next("talk_status", (m) => m.talkId === "typed-c" && m.stage === "failed", from);
  T.typeFails = undefined;
  assert.deepEqual([typedRefused.sessionId, typedRefused.detail], ["term-1", "Not sent to atlas-agents: osascript: not allowed"]);
  assert.deepEqual(
    talkStatuses("typed-c", from).map((m) => m.stage),
    ["heard", "routed", "failed"],
  );
  await wait(1700);
  console.log("ok");

  // Dictated words typed into a terminal used to arrive as a bare prompt ("high term" for iTerm, read as
  // written). Since 2026-11-14 the session's UserPromptSubmit hook asks the app whether the prompt is
  // words it just typed in for you, and tells Claude so beside the prompt. End to end: the real hook
  // script (hooks/claude-code-hook.mjs) on the real hooks socket (T.hooks.listen), the app's own match.
  begin("dictated words typed into a terminal: the session's hook tells Claude they were spoken, once; the same words by hand, and words typed on the phone, go in bare");
  await T.hooks.listen();
  const HOOK = new URL("../../../hooks/claude-code-hook.mjs", import.meta.url).pathname;
  /** What the hook prints for a prompt atlas-agents takes in (never spawnSync: the app answers it from this process). */
  const promptHook = (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli" }, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin!.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "term-1", cwd: TERM.cwd, permission_mode: "default", prompt }));
    });
  const NOTE = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "The user dictated this message by voice (speech-to-text, so expect small transcription errors)." } };
  T.utterance = routeTo(TERM);
  const spokenBefore = T.typed.length;
  await talk("open it in high term");
  await until(() => T.typed.length === spokenBefore + 1, 3000, "typed into atlas agents");
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "open it in high term" }, "nothing more is typed than your words");
  // Something typed by hand there meanwhile: bare.
  assert.equal(await promptHook("something typed by hand"), "");
  assert.equal(events("prompt_submitted").at(-1).voice, undefined);
  // The app's typing, as the terminal hands it on: the note, and logged.
  assert.deepEqual(JSON.parse(await promptHook("open it in high term\n")), NOTE);
  assert.deepEqual([events("prompt_submitted").at(-1).sessionId, events("prompt_submitted").at(-1).voice], ["term-1", true]);
  // The same words again, by hand: each typed message counts once.
  assert.equal(await promptHook("open it in high term"), "");
  assert.equal(events("prompt_submitted").at(-1).voice, undefined);
  await wait(1700); // the last send's moment passes
  // Typed on the phone's keyboard: the app types them in too, but nobody dictated them.
  from = p.got.length;
  await p.send({ type: "type", text: "and run the linter", sessionId: "term-1", talkId: "typed-kb" });
  await p.next("talk_status", (m) => m.talkId === "typed-kb" && m.stage === "delivered", from);
  assert.deepEqual(T.typed.at(-1), { terminalId: "ghostty-1", text: "and run the linter" });
  assert.equal(await promptHook("and run the linter"), "");
  assert.equal(events("prompt_submitted").at(-1).voice, undefined);
  // The hook's event reaches the app as ever: the phone's words have started; then its turn ends.
  await p.next("talk_status", (m) => m.talkId === "typed-kb" && m.stage === "started", from);
  T.hooks.unlisten();
  const dictatedTurn = stop(TERM, "cli");
  T.hooks.onRequest(dictatedTurn);
  await p.next("talk_status", (m) => m.talkId === "typed-kb" && m.stage === "replied", from);
  await until(() => dictatedTurn.settledAt > 0, 8000);
  await wait(1700);
  console.log("ok");

  begin("phone: words for Kiko itself: routed to it, then answered; a session that's gone fails at once");
  const savedRoute = T.route;
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.2, intent: "other", intentConfidence: 0.2 });
  T.route = () => [];
  T.routeText = "Two sessions are running.";
  from = p.got.length;
  await p.send({ type: "type", text: "what's running", talkId: "typed-d" });
  await p.next("talk_status", (m) => m.talkId === "typed-d" && m.stage === "answered", from);
  T.route = savedRoute;
  T.routeText = undefined;
  assert.deepEqual(
    talkStatuses("typed-d", from).map((m) => [m.stage, m.sessionId, m.name]),
    [
      ["heard", undefined, undefined],
      ["routed", null, null],
      ["answered", null, null],
    ],
  );
  await p.send({ type: "type", text: "hello?", sessionId: "gone-1", talkId: "typed-e" });
  const typedGone = await p.next("talk_status", (m) => m.talkId === "typed-e", from);
  assert.deepEqual([typedGone.stage, typedGone.detail], ["failed", "That session isn't running any more."]);
  // Without a talkId (an older app): none.
  const statusesBefore = p.of("talk_status").length;
  const typedBefore = T.typed.length;
  await p.send({ type: "type", text: "run the linter", sessionId: "term-1" });
  await until(() => T.typed.length > typedBefore);
  await wait(100);
  assert.equal(p.of("talk_status").length, statusesBefore);
  await wait(1700);
  console.log("ok");

  // Never silent: words the router did nothing with, or sent
  // to a session it made up, are said, logged and failed on the phone, never left as "answered".
  begin("phone: nothing done with the words, or a session that isn't there: said, logged, and the talk fails");
  {
    const savedRoute = T.route;
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.2, intent: "other", intentConfidence: 0.2 });
    T.route = () => [];
    from = p.got.length;
    await p.send({ type: "type", text: "hmm", talkId: "typed-n" });
    const nothing = await p.next("talk_status", (m) => m.talkId === "typed-n" && m.stage === "failed", from);
    assert.equal(nothing.detail, "Nothing done: I couldn't work out what to do with it");
    await until(() => spoke("I didn't do anything with that: I couldn't work out what to do with it."));
    assert.deepEqual(events("nothing_done").at(-1)?.text, "hmm");
    T.routeDropped = [{ tool: "ask_session", handle: "2026-10-29-dozer", message: "What is the capital of Italy?" }];
    from = p.got.length;
    await p.send({ type: "type", text: "Ask Dozer, what the capital of Italy is.", talkId: "typed-o" });
    const missing = await p.next("talk_status", (m) => m.talkId === "typed-o" && m.stage === "failed", from);
    assert.equal(missing.detail, "I don't see a session called dozer.");
    await until(() => spoke("I don't see a session called dozer."));
    assert.equal(events("nothing_done").length, 1, "said once, by decide(): no second line");
    assert.deepEqual(
      talkStatuses("typed-o", from).map((m) => m.stage),
      ["heard", "routed", "failed"],
    );
    T.route = savedRoute;
    T.routeDropped = undefined;
    await wait(1700);
  }
  console.log("ok");

  // The app's offer of a session (decide.ts offer_session) from the
  // phone as from the Mac: the words typed there are kept, and a yes typed there sends them, never the yes.
  begin("phone: an offer of a session: the words typed kept, a yes typed on the phone sends them there");
  {
    const savedRoute = T.route;
    const savedUtterance = T.utterance;
    const ASKED = "could the agents run the evals tonight";
    T.utterance = () => ({ audience: TERM, audienceConfidence: 0.6, intent: "message", intentConfidence: 1 });
    T.route = () => [{ name: "offer_session", session: TERM }];
    const typed = T.typed.length;
    from = p.got.length;
    await p.send({ type: "type", text: ASKED, talkId: "typed-offer" });
    await until(() => caseLines().some((l) => l.kind === "voice" && /^Want me to send that to atlas.agents\?$/i.test(l.text)));
    assert.equal(T.typed.length, typed, "nothing sent with the offer");
    assert.equal(events("question_pending").at(-1)?.offer, true);
    T.route = () => {
      throw new Error("no router: the yes is read in code");
    };
    T.utterance = () => {
      throw new Error("no classifier: the yes is read in code");
    };
    await p.send({ type: "type", text: "Yes, send it.", talkId: "typed-offer-yes" });
    const delivered = await p.next("talk_status", (m) => m.talkId === "typed-offer-yes" && m.stage === "delivered", from);
    assert.deepEqual(T.typed.slice(typed), [{ terminalId: "ghostty-1", text: ASKED }]);
    assert.equal(delivered.sessionId, "term-1");
    T.route = savedRoute;
    T.utterance = savedUtterance;
    await wait(1700);
  }
  console.log("ok");

  // The router with no answer (decide.ts routeFailed, 2026-11-12): the phone's talk fails with the line
  // the Mac says, where it once got "Something went wrong on the Mac", and the words are kept.
  begin("phone: the router can't answer: the phone's talk fails with the Mac's line, the words kept");
  {
    const savedRoute = T.route;
    const savedUtterance = T.utterance;
    const { keptWords } = await import("../../../src/app/state.ts");
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1 });
    T.route = () => {
      throw new Error("no answer: 2 tries, 8000ms each");
    };
    const typed = T.typed.length;
    from = p.got.length;
    await p.send({ type: "type", text: "could the agents rerun the evals", talkId: "typed-no-router" });
    const failed = await p.next("talk_status", (m) => m.talkId === "typed-no-router" && m.stage === "failed", from);
    assert.equal(failed.detail, "I couldn't work out where that goes. Trying again.");
    await until(() => caseLines().some((l) => l.kind === "voice" && l.text === failed.detail));
    assert.equal(T.typed.length, typed, "nothing sent");
    // Taken, so its retries don't reach the next cases.
    assert.deepEqual(
      keptWords.take().map((e) => e.text),
      ["could the agents rerun the evals"],
    );
    T.route = savedRoute;
    T.utterance = savedUtterance;
    await wait(1700);
  }
  console.log("ok");

  begin("phone: play on phone, then an announcement: its text, the voice's words to say (macOS voice), and its end");
  await p.send({ type: "play_on_phone", on: true });
  await until(() => events("phone_play").length > 0);
  from = p.got.length;
  T.needs = [0.8];
  const r = stop(DESK, "claude-desktop");
  T.hooks.onRequest(r);
  const said = await p.next("announcement", (m) => m.phase === "start" && m.kind === "session", from);
  assert.deepEqual([said.text, said.sessionId], ["summary for 2 plus 2", "desk-1"]);
  assert.equal((await p.next("speak", () => true, from)).text, "summary for 2 plus 2");
  await p.next("announcement", (m) => m.phase === "end", from);
  const waitingState = await p.next("state", (m) => m.waiting?.sessionId === "desk-1" && m.waiting.remainingMs !== null, from);
  assert.equal(waitingState.waiting.kind, "reply");
  const asListed = await p.next("sessions", (m) => m.sessions.some((s: any) => s.id === "desk-1" && s.status === "waiting"), from);
  assert.equal(asListed.sessions.find((s: any) => s.id === "desk-1").summary, "summary for 2 plus 2");
  await until(() => !r.open, 3000);
  console.log("ok");

  begin("phone: Play on this Mac off, from the phone: no cue or `say` on the Mac, the phone gets them, and the reply window waits for the speech");
  const { sayMs, PHONE_LAG_MS } = await import("../../../src/core/mac-output.ts");
  from = p.got.length;
  await p.send({ type: "play_on_mac", on: false });
  await until(() => events("mac_play").length > 0);
  assert.deepEqual(
    events("mac_play").map((l) => [l.on, l.by, l.phoneId]),
    [[false, "phone", paired.phoneId]],
  );
  assert.equal((await p.next("state", (m) => m.playOnMac === false, from)).playOnMac, false, "every phone sees it");
  assert.equal(ui.state.playOnMac, false);
  assert.equal(row("playOnMac"), undefined, "no row on the Mac's settings screen: only the phone switches it");
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).playOnMac, false, "saved like any setting");
  // A press on the Mac: its listening cue still plays on the Mac (it's for whoever pressed), and not on the phone.
  T.heard = "";
  T.hotkey.onDown();
  await until(() => casePlayed().some((x) => x.pcm === SOUNDS.listening));
  await T.hotkey.onUp();
  await until(() => !ui.state.listening);
  assert.equal(p.got.slice(from).filter((m) => m.type === "audio").length, 0);
  markHere();
  // An announcement: the phone gets the words to say, `say` isn't run, and the window opens once they'd have been said.
  T.needs = [0.8];
  const onPhone = stop(TERM, "cli");
  T.hooks.onRequest(onPhone);
  await p.next("speak", (m) => m.text === "summary for atlas-agents", from);
  const spokeAt = Date.now();
  await until(() => ui.state.speaking);
  await until(() => ui.state.waiting?.sessionId === TERM.sessionId && ui.state.waiting?.until != null, 4000);
  near(Date.now() - spokeAt, sayMs("summary for atlas-agents") + PHONE_LAG_MS, 150);
  assert.ok(
    caseLines().some((l) => l.kind === "spoken" && l.text === "summary for atlas-agents"),
    "on screen as always",
  );
  assert.deepEqual(caseSaid(), [], "no `say` on the Mac");
  assert.deepEqual(casePlayed(), [], "nor a cue");
  assert.equal(events("mac_stands_in").length, 0, "the phone plays it: the Mac stays quiet");
  assert.equal(ui.state.macPlays, false, "the header says silent on this Mac");
  await until(() => !onPhone.open, 3000);
  console.log("ok");

  begin("phone: no phone plays it (this Mac off, Play on phone off, or the app in the background): the Mac plays it instead, told once");
  from = p.got.length;
  await p.send({ type: "play_on_phone", on: false });
  await until(() => events("mac_stands_in").at(-1)?.on === true);
  await until(() => caseLines().some((l) => l.kind === "info" && l.text.startsWith("Play on this Mac is off, but no phone is playing")));
  assert.equal(ui.state.macPlays, true, "the Mac plays: the header doesn't say silent");
  // Still standing in as another phone comes and goes: not said again.
  const another = new Phone(null); // says nothing of where it is: it doesn't replace `p` (supersede)
  await another.send({ type: "hello", token: paired.token, device: "Second", appVersion: "0.1.0" });
  assert.equal((await another.next("welcome")).playOnMac, false);
  another.close();
  T.needs = [0.04];
  const heardOnMac = stop(DESK, "claude-desktop");
  T.hooks.onRequest(heardOnMac);
  await until(() => caseLines().some((l) => l.kind === "spoken" && l.text === "summary for 2 plus 2"));
  await until(() => !heardOnMac.open, 4000);
  assert.deepEqual(
    caseSaid().map((x) => x.text),
    ["summary for 2 plus 2"],
    "said on the Mac: no one else would hear it",
  );
  assert.equal(events("mac_stands_in").filter((e) => e.on).length, 1, "once, as it started");
  assert.equal(caseLines().filter((l) => l.kind === "error").length, 0);
  // The phone plays again: the Mac goes quiet, and says so.
  await p.send({ type: "play_on_phone", on: true });
  await until(() => events("mac_stands_in").at(-1)?.on === false);
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text === "A phone plays what's said again, so this Mac is quiet."));
  // Its app in the background (locked, or another app in front): it can't play, so the Mac does; back, the phone does.
  assert.equal(ui.state.macPlays, false);
  await p.send({ type: "presence", state: "away" });
  await until(() => events("mac_stands_in").at(-1)?.on === true);
  assert.equal(ui.state.macPlays, true, "a phone in the background: the Mac plays");
  await p.send({ type: "presence", state: "back" });
  await until(() => events("mac_stands_in").at(-1)?.on === false);
  assert.equal(ui.state.macPlays, false);
  console.log("ok");

  // Play on this Mac off, the phone locked with the app open;
  // Kiko restarted, and the app, still running in the background, reconnected. A new connection
  // counted as in front, so the Mac stayed quiet, the reply was heard nowhere, and nothing was kept
  // for the phone. Now the app says where it is right after welcome, and until it does the
  // connection doesn't count as playing.
  begin("phone: one that (re)connects locked or in the background: the Mac plays, it's kept for the phone; in front, the phone plays and gets it");
  await p.send({ type: "presence", state: "away" });
  await until(() => events("mac_stands_in").at(-1)?.on === true);
  const standIns = events("mac_stands_in").length;
  const presences = events("phone_presence").length;
  const locked = new Phone("away");
  await locked.send({ type: "hello", token: paired.token, device: "Locked", appVersion: "0.2.0" });
  await locked.next("welcome");
  assert.deepEqual((await locked.next("missed")).items, [], "nothing missed yet");
  await until(() => events("phone_presence").length > presences);
  assert.deepEqual(
    events("phone_presence")
      .slice(presences)
      .map((l) => [l.state, l.on]),
    [["away", "connect"]],
  );
  await wait(100);
  assert.equal(events("mac_stands_in").length, standIns, "the Mac never went quiet for it, not even for a moment");
  from = locked.got.length;
  const saidBefore = caseSaid().length;
  T.needs = [0.8];
  const whileLocked = stop(TERM, "cli");
  T.hooks.onRequest(whileLocked);
  await until(() => caseSaid().some((x, i) => i >= saidBefore && x.text === "summary for atlas-agents"));
  await until(() => !whileLocked.open, 3000);
  assert.deepEqual(
    locked.got.slice(from).filter((m) => m.type === "speak" || m.type === "audio"),
    [],
    "nothing to play sent to a phone that can't",
  );
  // Unlocked, the app in front: it plays from now on, the Mac goes quiet, and it gets what it missed.
  await locked.send({ type: "presence", state: "back" });
  await until(() => events("mac_stands_in").at(-1)?.on === false);
  const whatItMissed = (await locked.next("missed", (m) => m.items.length > 0, from)).items;
  assert.deepEqual(
    whatItMissed.map((x: any) => [x.kind, x.sessionId, x.text, x.settled?.how ?? null]),
    [["announcement", "term-1", "summary for atlas-agents", null]],
  );
  assert.deepEqual(events("phone_missed").at(-1), { ...events("phone_missed").at(-1), count: 1, on: "back" });
  T.needs = [0.04];
  const saidNow = caseSaid().length;
  const inFront = stop(DESK, "claude-desktop");
  T.hooks.onRequest(inFront);
  await locked.next("speak", (m) => m.text === "summary for 2 plus 2", from);
  await until(() => !inFront.open, 4000);
  assert.equal(caseSaid().length, saidNow, "not on the Mac: the phone plays it");
  await locked.send({ type: "seen", upTo: whatItMissed.at(-1).id });
  locked.close();
  await until(() => events("mac_stands_in").at(-1)?.on === true);
  // The same phone reconnecting while locked: that connection replaced `p` (phone_replaced). Back.
  assert.equal(events("phone_replaced").at(-1)?.presence, "away", "the connection it replaced, logged");
  p = await rejoin(); // back as it connects: no other word needed
  await until(() => events("mac_stands_in").at(-1)?.on === false);
  // Back on from the phone: every phone sees it, and it's saved.
  from = p.got.length;
  await p.send({ type: "play_on_mac", on: true });
  await until(() => events("mac_play").at(-1)?.on === true);
  assert.deepEqual([events("mac_play").at(-1)?.on, events("mac_play").at(-1)?.by], [true, "phone"]);
  await p.next("state", (m) => m.playOnMac === true, from);
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).playOnMac, true);
  assert.equal(ui.state.macPlays, true, "on again: not silent");
  await wait(300);
  console.log("ok");

  // No phone buzz while you're at the Mac (TODO, a release blocker): a line for a phone that's away
  // goes quietly (missed_line quiet) while the Mac had input lately and its screen is unlocked and
  // awake; away from it (or when it can't tell), it notifies as before.
  begin("phone: at the Mac, a line for a locked phone is quiet; away from the Mac, it notifies");
  {
    // The phone's other connection goes away too (the same phone: one in front would hear it).
    const wentAway = events("phone_presence").length;
    await p.send({ type: "presence", state: "away" });
    await until(
      () =>
        events("phone_presence")
          .slice(wentAway)
          .some((l) => l.state === "away"),
      2000,
      "the phone to be away",
    );
    const presences = events("phone_presence").length;
    const pocket = new Phone("away");
    await pocket.send({ type: "hello", token: paired.token, device: "Pocket", appVersion: "0.2.0" });
    await pocket.next("welcome");
    await until(() =>
      events("phone_presence")
        .slice(presences)
        .some((l) => l.state === "away" && l.on === "connect"),
    );
    T.atComputer = { idleMs: 4_000, locked: false, asleep: false };
    const reads = T.presenceReads ?? 0;
    const atMac = stop(TERM, "cli");
    T.needs = [0.8];
    T.hooks.onRequest(atMac);
    const quiet = await pocket.next("missed_line", (m) => m.item.text === "summary for atlas-agents", 0, 5000);
    assert.equal(quiet.quiet, true, "typing at the Mac: no notification");
    assert.ok((T.presenceReads ?? 0) > reads, "asked as it went");
    assert.equal(events("phone_missed_line").at(-1)?.atMac, true);
    await until(() => !atMac.open, 3000);
    await wait(1600); // past the reading kept a moment
    T.atComputer = { idleMs: 5 * 60_000, locked: false, asleep: false };
    const mark = pocket.got.length;
    T.needs = [0.8];
    const awayFromMac = stop(DESK, "claude-desktop");
    T.hooks.onRequest(awayFromMac);
    const loud = await pocket.next("missed_line", (m) => m.item.text === "summary for 2 plus 2", mark, 5000);
    assert.equal(loud.quiet, undefined, "idle 5 minutes: it notifies");
    await until(() => !awayFromMac.open, 4000);
    T.atComputer = null;
    pocket.close();
    // The pocket connection replaced `p` (the same phone). It comes back in front: a new connection that
    // says `back` as it connects is back (rejoin waits for it), with no second word on it.
    p = await rejoin();
    assert.equal(events("phone_presence").at(-1)?.state, "back", "the phone is back");
    // Read: not missed in the cases after.
    await p.send({ type: "seen", upTo: loud.item.id });
    await until(() => events("phone_seen").at(-1)?.upTo === loud.item.id);
  }
  console.log("ok");

  begin("phone: a press's cues play where the press was: the Mac's key never on the phone, the phone's never on the Mac");
  const audioSince = (n: number) => p.got.slice(n).filter((m) => m.type === "audio");
  from = p.got.length;
  T.heard = "";
  T.hotkey.onDown();
  await until(() => casePlayed().some((x) => x.pcm === SOUNDS.listening));
  await T.hotkey.onUp();
  await until(() => !ui.state.listening);
  await wait(100);
  assert.deepEqual(audioSince(from), [], "the phone plays what's said, not the Mac's press");
  // Words to atlas agents first (said "To atlas agents.": 2 plus 2 spoke last), so the ones below go
  // where you just were, with a "sent" beep and nothing said.
  const typedFirst = T.typed.length;
  await p.send({ type: "type", text: "and 7 plus 7", sessionId: "term-1" });
  await until(() => T.typed.length > typedFirst);
  await wait(300);
  // A press on the phone (typed in a session's screen): its "sent" cue goes to it, marked as a cue, and not to the Mac.
  markHere();
  from = p.got.length;
  const before = T.typed.length;
  await p.send({ type: "type", text: "and 8 plus 8", sessionId: "term-1" });
  await until(() => T.typed.length > before);
  const sentCue = await p.next("audio", (m) => m.cue === true, from);
  assert.equal(sentCue.data, SOUNDS.sent.toString("base64"));
  assert.ok(!casePlayed().some((x) => x.pcm === SOUNDS.sent), "not on the Mac");
  // With Play on phone off it still plays there: it's for whoever pressed.
  await p.send({ type: "play_on_phone", on: false });
  await until(() => events("phone_play").at(-1)?.on === false);
  from = p.got.length;
  const before2 = T.typed.length;
  await p.send({ type: "type", text: "and 9 plus 9", sessionId: "term-1" });
  await until(() => T.typed.length > before2);
  assert.equal((await p.next("audio", (m) => m.cue === true, from)).data, SOUNDS.sent.toString("base64"));
  await p.send({ type: "play_on_phone", on: true });
  await until(() => events("phone_play").at(-1)?.on === true);
  await wait(1700); // the last send's moment passes
  console.log("ok");

  begin("phone: talking holds the floor like the key; its words go through speech-to-text and routing");
  from = p.got.length;
  T.utterance = routeTo(TERM);
  T.heard = "tell atlas agents to deploy";
  await p.send({ type: "talk_start" });
  await until(() => ui.state.listening);
  assert.equal((await p.next("state", (m) => m.listening, from)).talker, "phone");
  await wait(100);
  assert.equal(p.got.slice(from).filter((m) => m.type === "audio").length, 0, "no listening blip: the phone's haptic says so");
  assert.ok(!casePlayed().some((x) => x.pcm === SOUNDS.listening), "nor on the Mac");
  await p.send({ type: "talk_audio", data: Buffer.alloc(3200, 0x40).toString("base64") });
  // The Mac's key meanwhile: the phone keeps the floor.
  T.hotkey.onDown();
  await T.hotkey.onUp();
  assert.ok(ui.state.listening, "still the phone's");
  const other = new Phone(null); // says nothing of where it is: it doesn't replace `p`, whose press this is
  await other.send({ type: "hello", token: paired.token, device: "Second", appVersion: "0.1.0" });
  await other.next("welcome");
  await other.send({ type: "talk_start" });
  assert.equal((await other.next("error")).code, "busy");
  other.close();
  await p.send({ type: "talk_end" });
  await until(() => /^deploy$/i.test(T.typed.at(-1)?.text ?? "")); // "tell atlas agents to" left out, as when spoken
  assert.deepEqual(
    events("phone_talk").map((l) => [l.text, l.cancelled]),
    [["tell atlas agents to deploy", false]],
  );
  const timed = events("phone_talk")[0];
  assert.ok(timed.firstAudioMs >= 0 && timed.heldMs >= timed.firstAudioMs, "how long the phone's mic took, and the press");
  assert.ok(events("transcript").some((l) => l.via === "phone" && l.text === "tell atlas agents to deploy"));
  await p.send({ type: "talk_audio", data: "" });
  assert.equal((await p.next("error", (m) => m.code === "not_talking", from)).code, "not_talking");
  await wait(1700);
  console.log("ok");

  begin("phone: talking in a session's screen goes to that session; a phone that goes away mid-word sends nothing");
  T.utterance = routeTo(TERM);
  T.heard = "what about 7 plus 7";
  await p.send({ type: "talk_start", sessionId: "desk-1" });
  await until(() => ui.state.listening);
  const n = T.typed.length;
  await p.send({ type: "talk_end" });
  await until(() => notSent("desk-1").at(-1)?.text === "what about 7 plus 7");
  assert.equal(T.typed.length, n, "not typed into atlas agents");
  const gone = new Phone(null); // says nothing of where it is: it doesn't replace `p`
  await gone.send({ type: "hello", token: paired.token, device: "Gone", appVersion: "0.1.0" });
  await gone.next("welcome");
  T.heard = "half a sentence";
  await gone.send({ type: "talk_start" });
  await until(() => ui.state.listening);
  const typed = T.typed.length;
  gone.ws.terminate();
  await until(() => !ui.state.listening && events("phone_talk").length === 2);
  assert.equal(events("phone_talk").at(-1).cancelled, true);
  assert.equal(events("phone_talk").at(-1).firstAudioMs, null, "no audio came");
  await wait(200);
  assert.equal(T.typed.length, typed, "nothing sent");
  await wait(1700);
  console.log("ok");

  // Two phone messages 10s apart to the Kiko session,
  // a background process with the terminal's ID as an alias (sessions.ts). The first was trimmed (its
  // routing words left out), and the second press came 0.2s before its decision did: it was dropped,
  // and nothing was logged after route_turn. Now both are typed, in order.
  begin("phone: two quick messages to the merged Kiko session, the first trimmed: both typed, in order");
  {
    const FRONT = { ...TERM, sessionId: "front-p", name: "Kiko", givenName: "Kiko", cwd: "/nonexistent/kiko", place: ghostty("ghostty-front-p") };
    const MERGED = { ...FRONT, sessionId: "engine-p", aliases: ["front-p"] };
    const listed = T.sessions;
    T.sessions = [DESK, TERM, MERGED];
    T.hooks.onSessionsChanged();
    await until(() => ui.state.sessions.some((s: any) => s.sessionId === "engine-p"), 1000);
    const FIRST = "One more test to Kiko, just checking the phone still works. The Mac showed two Kiko windows for a moment, but the phone looks fine from here.";
    const KEPT = "Just checking the phone still works. The Mac showed two Kiko windows for a moment, but the phone looks fine from here.";
    const SECOND = "Second message, sent right after the first, to see if both get through.";
    // As the classifier and the router read them that night: for the app, unsure; parts for the app (0.52); pass_on to Kiko.
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.28, intent: "message", intentConfidence: 0.6, appParts: 0.52 });
    T.route = () => [{ name: "pass_on", session: MERGED }];
    T.trim = (input: any) => (input.text === FIRST ? ["One more test to Kiko"] : []);
    T.routeDelayMs = 200;
    T.trimDelayMs = 300;
    const n = T.typed.length;
    const trims = T.trimming ?? 0;
    T.heard = FIRST;
    await p.send({ type: "talk_start" });
    await until(() => ui.state.listening);
    await p.send({ type: "talk_end" });
    // The second press, while the first is trimmed (its decision landed 0.25s later).
    await until(() => (T.trimming ?? 0) > trims);
    T.heard = SECOND;
    await p.send({ type: "talk_start" });
    await until(() => ui.state.listening);
    await until(() => events("send_held").length > 0, 2000);
    assert.equal(T.typed.length, n, "held while the second press is down");
    // Sure of Kiko (the words name it), held only because the second press came: its words settle it.
    const held = events("send_held")[0];
    assert.deepEqual([held.sessionId, held.text, held.why, held.waitingFor], ["engine-p", KEPT, "pressed while deciding", "your next words"]);
    await p.send({ type: "talk_end" });
    await until(() => T.typed.length >= n + 2, 5000);
    assert.deepEqual(T.typed.slice(n), [
      { terminalId: "ghostty-front-p", text: KEPT },
      { terminalId: "ghostty-front-p", text: SECOND },
    ]);
    assert.deepEqual(
      events("trimmed").map((l) => [l.kept, l.dropped]),
      [[KEPT, ["One more test to Kiko"]]],
    );
    assert.deepEqual(
      events("pressed_while_deciding").map((l) => [l.text, l.router, l.keyDown]),
      [[FIRST, true, true]],
    );
    assert.deepEqual(
      events("send_released").map((l) => [l.text, l.after]),
      [
        [KEPT, "your words"],
        [SECOND, "timer"],
      ],
    );
    assert.equal(events("send_dropped").length + events("send_failed").length, 0);
    T.routeDelayMs = 0;
    T.trimDelayMs = 0;
    T.trim = undefined;
    T.route = () => [];
    T.sessions = listed;
    T.hooks.onSessionsChanged();
    await until(() => !ui.state.sessions.some((s: any) => s.sessionId === "engine-p"), 1000);
    await wait(1700);
    console.log("ok");
  }

  // A phone press right after a Mac release, while the Mac's words are still turned into text (its 300ms tail,
  // then ~100ms of transcription): the phone's press restarted speech-to-text under the Mac's. Now the phone's
  // audio waits its turn, and both go, the Mac's first (src/core/press-stt.ts).
  begin("phone: a press right after a Mac release: the Mac's words first, then the phone's, nothing lost");
  {
    T.utterance = routeTo(TERM);
    process.env.KIKO_TEST_TAIL_MS = "300";
    T.sttDelayMs = 100;
    T.pressWords = ["check the build", "and the release notes"];
    const begun = (T.sttPresses ??= []).length;
    const n = T.typed.length;
    T.hotkey.onDown();
    T.mic(Buffer.alloc(3200, 0x40));
    await wait(20);
    const mac = T.hotkey.onUp();
    await wait(50); // the Mac press's tail
    await p.send({ type: "talk_start" });
    await until(() => ui.state.listening);
    await p.send({ type: "talk_audio", data: Buffer.alloc(3200, 0x40).toString("base64") });
    await p.send({ type: "talk_audio", data: Buffer.alloc(3200, 0x40).toString("base64") });
    await until(() => events("stt_press_waits").length > 0);
    await p.send({ type: "talk_end" });
    await mac;
    await until(() => T.typed.length >= n + 2, 5000);
    process.env.KIKO_TEST_TAIL_MS = "0";
    T.sttDelayMs = 0;
    assert.deepEqual(T.typed.slice(n), [
      { terminalId: "ghostty-1", text: "check the build" },
      { terminalId: "ghostty-1", text: "and the release notes" },
    ]);
    assert.deepEqual(
      T.sttPresses.slice(begun).map((x: any) => [x.words, x.chunks, x.cancelled]),
      [
        ["check the build", 1, false],
        ["and the release notes", 2, false],
      ],
    );
    assert.deepEqual(
      events("transcript").map((l) => [l.text, l.via ?? "key"]),
      [
        ["check the build", "key"],
        ["and the release notes", "phone"],
      ],
    );
    assert.equal(T.micOpen, false, "the Mac's mic closed after its tail: the phone's press doesn't use it");
    assert.equal(events("send_dropped").length + events("send_failed").length, 0);
    await wait(1700);
    console.log("ok");
  }

  begin("phone: a permission prompt shows on the phone; Allow settles it like the Mac's allow key");
  from = p.got.length;
  const ask = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "Bash", tool_input: {} });
  T.hooks.onRequest(ask);
  const shown = (await p.next("permission_prompt", (m) => m.prompt?.sessionId === "term-1", from)).prompt;
  assert.deepEqual([shown.name, shown.what, shown.risky], ["atlas-agents", "use Bash", false]);
  assert.equal((await p.next("sessions", (m) => m.sessions.some((s: any) => s.id === "term-1" && s.status === "needs_you"), from)).type, "sessions");
  await p.send({ type: "permission", promptId: "not-this-one", decision: "allow" });
  assert.equal((await p.next("error", (m) => m.code === "prompt_gone", from)).code, "prompt_gone");
  assert.ok(ask.open);
  await p.send({ type: "permission", promptId: shown.promptId, decision: "allow" });
  await until(() => !ask.open);
  assert.deepEqual(ask.reply, { behavior: "allow" });
  assert.ok(info("→ allowed"));
  assert.deepEqual(
    events("phone_permission").map((l) => [l.sessionId, l.decision]),
    [["term-1", "allow"]],
  );
  await p.next("permission_prompt", (m) => m.prompt === null, from);
  console.log("ok");

  begin("phone: the safety gate's card: risky from the start, allowed once, its kind said; Allow settles it");
  from = p.got.length;
  // The gate is off by default (guardCases turns it on in Settings); on for this case only.
  config.guard = true;
  await T.hooks.onGuard({
    agent: "claude-code",
    sessionId: TERM.sessionId,
    cwd: TERM.cwd,
    tool: { name: "Bash", input: { command: "wrangler deploy" } },
    hits: [{ kind: "posts", rule: "wrangler deploy", what: "deploy with Wrangler" }],
    unclear: [],
  });
  const gated = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "Bash", tool_input: { command: "wrangler deploy" } });
  T.hooks.onRequest(gated);
  const gatedCard = (await p.next("permission_prompt", (m) => m.prompt?.sessionId === "term-1" && m.prompt.risky, from)).prompt;
  assert.deepEqual([gatedCard.what, gatedCard.risky, gatedCard.canAlways], ["use Bash (Kiko asks first: posts)", true, undefined]);
  await p.send({ type: "permission", promptId: gatedCard.promptId, decision: "allow" });
  await until(() => !gated.open);
  assert.deepEqual(gated.reply, { behavior: "allow" });
  assert.ok(logEntries().some((l) => l.event === "guard_answer" && l.rule === "wrangler deploy" && l.answer === "allow" && l.by === "phone"));
  await p.next("permission_prompt", (m) => m.prompt === null, from);
  config.guard = false;
  console.log("ok");

  {
    // The quick task for real (stubs/core/quick-task.ts T.realQuick) with a fake `claude` (never
    // Claude) that wants `whois pebble.com` and asks through the real permission server
    // (hooks/quick-permission.mjs) on the real hooks socket (T.hooks.listen: out/voice.sock).
    const { homedir } = await import("node:os");
    // Which permission modes `claude` offers, faked (never this Mac's claude --help): none at first,
    // so the quick check runs in Manual and asks as before; auto further down.
    const { readHelpWith } = await import("../../../src/agents/claude-code/modes-offered.ts");
    readHelpWith(async () => "");
    const canBefore = JSON.parse(readFileSync("settings-test.json", "utf8")).voiceCan ?? "messages";
    ui.act({ type: "set", key: "voiceCan", value: "everything" });
    const route = T.route;
    const utterance = T.utterance;
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    const TASK = "Check whether pebble.com, pebble.dev and pebble.io are registered.";
    T.route = () => [{ name: "quick_task", task: TASK, cwd: homedir() }];
    T.realQuick = true;
    await T.hooks.listen();
    const voiced = (text: string) => caseLines().some((l) => l.kind === "voice" && l.text === text);
    const ASKED = "Kiko's quick check wants to run whois pebble.com. Allow?";
    const asked = () => caseLines().some((l) => l.text === ASKED);

    begin("phone: a quick task asks to run whois; allowed on the phone, its answer comes back");
    from = p.got.length;
    await talk("are pebble.com, .dev and .io available");
    assert.ok(voiced("Checking."));
    const card = (await p.next("permission_prompt", (m) => m.prompt?.sessionId === "kiko", from, 5000)).prompt;
    assert.deepEqual([card.name, card.what, card.risky], ["Kiko's quick check", "run whois pebble.com", false]);
    assert.ok(
      caseLines().some((l) => l.kind === "permission" && l.text === "run whois pebble.com"),
      "the card on the Mac",
    );
    // On the Mac's card, what it's for; on the phone, the name with checkFor apart.
    assert.equal(ui.state.permission?.name, `Kiko's quick check, for: ${TASK}`);
    assert.equal(card.checkFor, TASK);
    assert.ok(
      p.got.slice(from).some((m) => m.type === "state" && m.checking?.what === TASK),
      "the talk bar: Kiko is checking",
    );
    assert.equal(T.quick.pauses, 1, "the task's clock stopped while it asked");
    assert.notEqual(ui.state.targetId, "kiko", "never where your words go next");
    await until(asked, 900); // asked out loud in its own words, inside the harness's 1s window
    await p.send({ type: "permission", promptId: card.promptId, decision: "allow" });
    // Said with its domains read out (core/pronunciation.ts): "pebble dot com", "dot I O".
    await until(() => caseSaid().some((x: any) => x.text === "answer: pebble dot com is registered; pebble dot dev and pebble dot I O look free."), 5000);
    await p.next("permission_prompt", (m) => m.prompt === null, from);
    assert.deepEqual(
      events("quick_ask").map((l) => [l.tool, l.what, l.verdict]),
      [["Bash", "run whois pebble.com", "ask"]],
    );
    assert.deepEqual(
      events("phone_permission").map((l) => [l.sessionId, l.decision]),
      [["kiko", "allow"]],
    );
    const done = events("quick_task").at(-1);
    assert.deepEqual([done.outcome, done.denied], ["answered", []]);
    assert.ok(!voiced(HAND_OFF), "nothing to hand off");
    console.log(
      "ok:",
      caseLines()
        .map((l) => `${l.kind}: ${l.text}`)
        .join(" | "),
    );

    begin("phone: a quick task's request denied on the phone: it says what it couldn't check, and offers a session once; yes opens one");
    from = p.got.length;
    const PIXIE = `${PROJECTS_ROOT}/pixie`; // a project's folder: the session opens there
    T.route = () => [{ name: "quick_task", task: TASK, cwd: PIXIE }];
    await wait(300);
    await talk("is pebble.com taken");
    const again = (await p.next("permission_prompt", (m) => m.prompt?.sessionId === "kiko", from, 5000)).prompt;
    await until(asked, 900);
    await p.send({ type: "permission", promptId: again.promptId, decision: "deny" });
    await until(() => voiced(HAND_OFF), 5000);
    assert.ok(
      caseLines().some((l) => l.kind === "voice" && l.text.startsWith("answer: I couldn't check whether pebble.com is registered")),
      "its answer first",
    );
    assert.equal(caseLines().filter((l) => l.kind === "voice" && l.text === HAND_OFF).length, 1, "offered once");
    assert.deepEqual(events("quick_task").at(-1).denied, ["Bash: whois pebble.com"]);
    const opened = T.opened.length;
    const opens = events("session_open").length;
    T.route = () => {
      throw new Error("a yes to the offer doesn't need the router");
    };
    await talk("yes");
    // Opened, and kept as starting (its session_open: after the terminal opened it), so startOpened finds it.
    await until(() => events("session_open").length > opens, 5000, "the session to open (session_open)");
    assert.equal(T.opened.length, opened + 1);
    assert.deepEqual(T.opened.at(-1), { cwd: PIXIE, command: `${CLAUDE} '${TASK}'` });
    await startOpened();
    console.log("ok");

    begin("a quick task's request with the app's socket gone: denied at once, nobody asked");
    T.hooks.unlisten();
    from = p.got.length;
    T.route = () => [{ name: "quick_task", task: TASK, cwd: homedir() }];
    await wait(300);
    await talk("is pebble.io taken");
    await until(() => voiced(HAND_OFF), 5000);
    assert.equal(p.got.slice(from).filter((m) => m.type === "permission_prompt" && m.prompt).length, 0, "no card");
    assert.deepEqual(events("quick_task").at(-1).denied, ["Bash: whois pebble.com"]);
    console.log("ok");

    begin("a quick task in auto mode (claude offers it): a command that only looks runs without a card; its answer is kept as Kiko checked");
    await T.hooks.listen();
    readHelpWith(async () => '  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")\n');
    from = p.got.length;
    await wait(300);
    await talk("is pebble.dev taken");
    await until(() => caseSaid().some((x: any) => x.text === "answer: pebble dot com is registered; pebble dot dev and pebble dot I O look free."), 5000);
    assert.equal(events("quick_task_start").at(-1).mode, "auto");
    assert.equal(p.got.slice(from).filter((m) => m.type === "permission_prompt" && m.prompt).length, 0, "no card: nobody asked");
    // The phone's copy comes over its socket: it may land a moment after the answer is said.
    assert.ok(await p.next("announcement", (m) => m.checked === TASK, from).catch(() => null), "the answer carries what it checked");
    console.log("ok");
    readHelpWith();

    T.realQuick = false;
    T.route = route;
    T.utterance = utterance;
    ui.act({ type: "set", key: "voiceCan", value: canBefore });
    await wait(300);
  }

  // A session opened in Kiko's tmux, at Claude Code's trust question (its pane read with
  // capture-pane, core/trust-prompt.ts): asked as a permission card, here on the phone. Allow picks
  // "Yes, I trust this folder" in its pane: Down, seen picked, then Enter. Then it starts, and the
  // words held for it go in. Deny: Escape, it ends, and the held words weren't sent.
  begin('phone: a new session at Claude Code\'s trust question: its card on the phone; Allow picks "Yes" (Down, seen, Enter), it starts, held words go in');
  {
    const { homedir } = await import("node:os");
    set("voiceCan", "everything");
    const before = { sessions: T.sessions, utterance: T.utterance, route: T.route };
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "other", intentConfidence: 0.1 });
    const trustScreen = (folder: string, picked: "yes" | "no") =>
      [
        "─".repeat(60),
        " Accessing workspace:",
        "",
        ` ${folder}`,
        "",
        " Quick safety check: Is this a project you created or one you trust?",
        "",
        " Claude Code'll be able to read, edit, and execute files here.",
        "",
        ` ${picked === "no" ? "❯" : " "} No, exit`,
        ` ${picked === "yes" ? "❯" : " "} Yes, I trust this folder`,
        "",
        " Enter to confirm · Esc to cancel",
      ].join("\n");
    // Its pane: Down and Up move ❯, Enter takes what's picked (Yes: Claude Code's prompt; No: it exits), Escape exits.
    const at: Record<string, "yes" | "no"> = {};
    T.tmux = {
      panes: [],
      procs: [],
      paneIds: true,
      screens: {},
      onKey(pane: string, key: string) {
        const folder = T.tmux.panes.find((q: any) => q.id === pane).cwd;
        if (key === "Down" || key === "Up") at[pane] = at[pane] === "no" ? "yes" : "no";
        if ((key === "Enter" && at[pane] === "no") || key === "Escape") {
          T.tmux.panes = T.tmux.panes.filter((q: any) => q.id !== pane); // "No, exit": its window closes
          return;
        }
        T.tmux.screens[pane] = key === "Enter" ? " ✻ Welcome to Claude Code!\n\n> " : trustScreen(folder, at[pane]);
      },
    };
    const open = async (name: string) => {
      T.route = () => [{ name: "start_session", project: null, newProject: false, sessionName: name, prompt: "" }];
      await talk(`open a new session called ${name}`);
      const starting = () => ui.state.sessions.find((x: any) => x.givenName === name && x.sessionId.startsWith("starting-"));
      await until(() => Boolean(starting()));
      const pane = T.opened.at(-1).via === "tmux" && events("session_open").at(-1).pane;
      assert.match(pane, /^%\d+$/, "opened in tmux, its pane told");
      return { id: starting()!.sessionId, cwd: T.opened.at(-1).cwd, pane };
    };
    const dozer = await open("Dozer");
    // Words for it while it starts: held.
    T.route = (input: any) => [{ name: "ask_session", session: input.sessions.find((x: any) => x.givenName === "Dozer"), message: "What is the capital of Italy?" }];
    await talk("ask Dozer what the capital of Italy is");
    await until(() => events("held_for_start").length > 0);
    // Claude Code draws its trust question: asked as a card, the phone's too.
    from = p.got.length;
    at[dozer.pane] = "no";
    T.tmux.screens[dozer.pane] = trustScreen(dozer.cwd, "no");
    const card = (await p.next("permission_prompt", (m) => m.prompt?.folder, from, 4000)).prompt;
    const shownFolder = dozer.cwd.replace(homedir(), "~");
    assert.deepEqual([card.sessionId, card.name, card.what, card.folder, card.risky], [dozer.id, "Dozer", `trust its folder ${shownFolder}`, shownFolder, false]);
    assert.deepEqual(
      events("trust_prompt").map((l) => [l.startingId, l.folder, l.shown]),
      [[dozer.id, dozer.cwd, true]],
    );
    const folderName = dozer.cwd.split("/").at(-1);
    await until(() => caseSaid().some((x: any) => x.text === `Dozer wants to trust its folder, ${folderName}. Claude Code will be able to read, edit and run files there. Allow?`));
    assert.ok(
      caseLines().some((l) => l.text === `Dozer wants to trust its folder ${shownFolder}. Claude Code will be able to read, edit and run files there. Allow?`),
      "shown with its path",
    );
    assert.ok(!caseSaid().some((x: any) => x.text.includes("waiting for you in its window")), "not the old message");
    // Allowed from the phone: Down (❯ seen on Yes), then Enter, into its pane only.
    const keys = T.keys.length;
    await p.send({ type: "permission", promptId: card.promptId, decision: "allow" });
    await until(() => events("trust_answer").length > 0, 4000);
    assert.deepEqual(
      events("trust_answer").map((l) => [l.allow, l.how, l.ok]),
      [[true, "down+enter", true]],
    );
    assert.deepEqual(T.keys.slice(keys), [
      { terminalId: dozer.pane, key: "Down" },
      { terminalId: dozer.pane, key: "Enter" },
    ]);
    await p.next("permission_prompt", (m) => m.prompt === null, from);
    // It starts (SessionStart): matched by its folder, and the held words go in.
    const DOZER = { ...TERM, sessionId: "dozer-trusted", name: "Dozer", givenName: "Dozer", cwd: dozer.cwd, place: ghostty("ghostty-dozer-trusted") };
    T.sessions = [...T.sessions, DOZER];
    T.hooks.onSessionsChanged();
    await until(() => T.typed.some((t: any) => t.terminalId === "ghostty-dozer-trusted" && t.text === "What is the capital of Italy?"), 4000);
    assert.deepEqual(
      events("session_ready").map((l) => [l.startingId, l.sessionId, l.held]),
      [[dozer.id, "dozer-trusted", 1]],
    );
    T.sessions = T.sessions.filter((x: any) => x !== DOZER);

    // Denied from the phone: Escape; it ends; what was held for it isn't sent, and that's said.
    const typedBefore = T.typed.length;
    const rex = await open("Rex");
    T.route = (input: any) => [{ name: "ask_session", session: input.sessions.find((x: any) => x.givenName === "Rex"), message: "list the files" }];
    await talk("ask Rex to list the files");
    await until(() => events("held_for_start").length > 1);
    from = p.got.length;
    at[rex.pane] = "no";
    T.tmux.screens[rex.pane] = trustScreen(rex.cwd, "no");
    const rexCard = (await p.next("permission_prompt", (m) => m.prompt?.folder && m.prompt.sessionId === rex.id, from, 4000)).prompt;
    await p.send({ type: "permission", promptId: rexCard.promptId, decision: "deny" });
    await until(() => events("trust_answer").length > 1, 4000);
    assert.deepEqual(
      events("trust_answer")
        .slice(1)
        .map((l) => [l.allow, l.how, l.ok]),
      [[false, "escape", true]],
    );
    T.hooks.onSessionsChanged();
    await until(() => caseLines().some((l) => l.kind === "voice" && /^Rex closed without trusting its folder\. I didn't send what you said for it: "list the files"\.$/i.test(l.text)), 4000);
    assert.equal(events("session_never_started").at(-1).why, "you didn't trust its folder");
    assert.ok(!T.typed.slice(typedBefore).some((t: any) => /list the files/i.test(t.text)), "not typed anywhere");
    console.log("ok");

    // The trust card has no window: it stays up (the Mac's card, every phone's, an away phone's
    // notification) until it's settled, and once it is, anywhere, it's gone from all of them.
    const settledOf = (id: string) => events("trust_settled").filter((l) => l.startingId === id);
    /** Claude Code's question drawn in its pane, and its card on the phone (and the Mac). */
    const ask = async (who: { id: string; cwd: string; pane: string }, phones: any[]) => {
      const marks = phones.map((x) => x.got.length);
      at[who.pane] = "no";
      T.tmux.screens[who.pane] = trustScreen(who.cwd, "no");
      const cards = [];
      for (const [i, x] of phones.entries()) cards.push((await x.next("permission_prompt", (m: any) => m.prompt?.sessionId === who.id, marks[i], 5000)).prompt);
      assert.equal(ui.state.permission?.id, cards[0].promptId, "the Mac's card is the same one");
      return cards[0];
    };
    /** No card of it on this phone since `mark`, and none now. */
    const cleared = async (x: any, mark: number, promptId: string) => {
      await x.next("permission_prompt", (m: any) => m.prompt?.promptId !== promptId, mark, 5000);
      const last = x.got.filter((m: any) => m.type === "permission_prompt").at(-1);
      assert.notEqual(last.prompt?.promptId, promptId, "its card gone from the phone");
    };
    /** It starts (SessionStart: listed by its agent), then leaves the list, for the cases after. */
    const startIt = async (who: { id: string; cwd: string }, sessionId: string) => {
      const listed = { ...TERM, sessionId, name: sessionId, givenName: "", cwd: who.cwd, place: ghostty(`ghostty-${sessionId}`) };
      T.sessions = [...T.sessions, listed];
      T.hooks.onSessionsChanged();
      await until(() => events("session_ready").some((l) => l.startingId === who.id), 5000, `${sessionId} to start (session_ready)`);
      T.sessions = T.sessions.filter((x: any) => x !== listed);
      T.hooks.onSessionsChanged();
    };

    begin("phone: the trust card stays up past the permission window; answered on one phone, it's gone from the other phone, its notification, and the Mac");
    {
      // A second phone, paired, and away (locked): it gets the card too, and a notification of the question.
      set("phonePairing", "open");
      await until(() => /^\d{6}$/.test(String(row("phonePairing")?.raw)), 3000, "a pairing code");
      const second = new Phone("away");
      await second.send({ type: "pair", code: String(row("phonePairing")!.raw), device: "Second iPhone", appVersion: "0.1.0" });
      const secondId = (await second.next("paired")).phoneId;
      await until(() => events("phone_presence").some((l) => l.phoneId === secondId && l.state === "away"), 5000, "the second phone to be away");
      from = p.got.length;
      const tank = await open("Tank");
      const card = await ask(tank, [p, second]);
      const line = (await second.next("missed_line", (m) => m.item.kind === "permission" && m.item.sessionId === tank.id, 0, 5000)).item;
      // Its voice window (1s here) runs out: the card stays on the Mac and both phones, no seconds on it.
      await until(() => caseLines().some((l) => l.text === "(no answer yet; its card stays up until you answer it)"), 5000, "the trust question's voice window to run out");
      const markP = p.got.length;
      const markSecond = second.got.length;
      await wait(2500); // well past the window again
      assert.equal(ui.state.permission?.id, card.promptId, "the Mac's card still up");
      assert.equal(ui.state.permission?.folder, card.folder);
      assert.equal(ui.state.waiting, null, "not waiting for a bare yes any more");
      for (const [x, mark] of [
        [p, markP],
        [second, markSecond],
      ] as const) {
        assert.ok(!x.got.slice(mark).some((m: any) => m.type === "permission_prompt"), "the phones' cards unchanged");
      }
      assert.equal(card.remainingMs, null, "no countdown on it");
      assert.equal(sessionStatus(ui.state.sessions.find((x: any) => x.sessionId === tank.id)!, ui.state), "needs_you");
      assert.deepEqual([settledOf(tank.id), events("trust_answer").filter((l) => l.startingId === tank.id)], [[], []], "never answered for you");
      // Words for Tank meanwhile: held, and its question asked out loud again (the same card).
      const asked = () => caseSaid().filter((x: any) => x.text.startsWith("Tank wants to trust its folder")).length;
      assert.equal(asked(), 1);
      T.route = (input: any) => [{ name: "ask_session", session: input.sessions.find((x: any) => x.givenName === "Tank"), message: "list the files" }];
      await talk("ask Tank to list the files");
      await until(() => caseSaid().some((x: any) => x.text === "Tank is asking whether to trust its folder. I'll pass that on once it starts."), 5000, "the held words' line");
      await until(() => asked() === 2, 5000, "the trust question asked out loud again");
      assert.equal(ui.state.permission?.id, card.promptId, "the same card");
      // Allowed on this phone: its keys go in, and it's gone everywhere at once.
      const keys = T.keys.length;
      await p.send({ type: "permission", promptId: card.promptId, decision: "allow" });
      await until(() => settledOf(tank.id).length > 0, 5000, "trust_settled");
      assert.deepEqual(
        settledOf(tank.id).map((l) => [l.how, l.allow]),
        [["phone", true]],
      );
      await cleared(second, markSecond, card.promptId);
      await cleared(p, markP, card.promptId);
      assert.notEqual(ui.state.permission?.id, card.promptId, "gone from the Mac");
      const notified = await second.next("missed_settled", (m) => m.items.some((x: any) => x.id === line.id), markSecond, 5000);
      assert.equal(notified.items.find((x: any) => x.id === line.id).settled.how, "answered_on_phone", "its notification taken down");
      await until(() => events("trust_answer").some((l) => l.startingId === tank.id), 5000, "trust_answer");
      assert.deepEqual(T.keys.slice(keys), [
        { terminalId: tank.pane, key: "Down" },
        { terminalId: tank.pane, key: "Enter" },
      ]);
      // A late tap from the other phone: gone, nothing pressed.
      await second.send({ type: "permission", promptId: card.promptId, decision: "deny" });
      assert.equal((await second.next("error", (m) => m.code === "prompt_gone", markSecond)).code, "prompt_gone");
      await startIt(tank, "tank-started");
      assert.equal(settledOf(tank.id).length, 1, "settled once");
      second.close();
      set("phones", `forget:${secondId}`);
      set("phonePairing", "close");
    }
    console.log("ok");

    begin("the trust card answered in its own pane (keys typed there, not by Kiko): gone from the Mac and the phone");
    {
      from = p.got.length;
      const kit = await open("Kit");
      const card = await ask(kit, [p]);
      const mark = p.got.length;
      const keys = T.keys.length;
      // Typed in its pane: Down, Enter (the pretend Claude Code's menu, as a person would).
      T.tmux.onKey(kit.pane, "Down");
      T.tmux.onKey(kit.pane, "Enter");
      await until(() => settledOf(kit.id).length > 0, 8000, "trust_settled (the pane is looked at every 3s while the card is up)");
      assert.deepEqual(
        settledOf(kit.id).map((l) => [l.how, l.allow ?? null]),
        [["terminal", null]],
      );
      await cleared(p, mark, card.promptId);
      assert.equal(ui.state.permission?.id ?? null, null, "gone from the Mac");
      assert.equal(T.keys.length, keys, "Kiko pressed nothing");
      assert.ok(!events("trust_answer").some((l) => l.startingId === kit.id));
      await startIt(kit, "kit-started");
      assert.equal(settledOf(kit.id).length, 1, "SessionStart after: settled once");
    }
    console.log("ok");

    begin("the trust card goes once its session starts (SessionStart), or once its pane ends");
    {
      from = p.got.length;
      const ola = await open("Ola");
      const olaCard = await ask(ola, [p]);
      let mark = p.got.length;
      await startIt(ola, "ola-started");
      assert.deepEqual(
        settledOf(ola.id).map((l) => l.how),
        ["session_start"],
      );
      await cleared(p, mark, olaCard.promptId);

      const pip = await open("Pip");
      const pipCard = await ask(pip, [p]);
      mark = p.got.length;
      T.tmux.panes = T.tmux.panes.filter((q: any) => q.id !== pip.pane); // its window closed
      await until(() => settledOf(pip.id).length > 0, 8000, "trust_settled (its pane gone)");
      assert.deepEqual(
        settledOf(pip.id).map((l) => l.how),
        ["ended"],
      );
      await cleared(p, mark, pipCard.promptId);
      assert.equal(ui.state.permission?.id ?? null, null, "gone from the Mac");
      await until(() => caseLines().some((l) => l.kind === "voice" && l.text === "Pip closed before it started."), 5000, "Pip's end to be said");
    }

    T.tmux = undefined;
    Object.assign(T, before);
    set("voiceCan", "messages");
  }
  console.log("ok");

  begin("phone: Claude's questions show with their options; the phone's answers settle them, checked against them");
  from = p.got.length;
  const questions = [
    {
      question: "Install tmux tonight?",
      header: "Install tmux",
      options: [
        { label: "Yes (Recommended)", description: "brew" },
        { label: "No", description: "later" },
      ],
      multiSelect: false,
    },
    {
      question: "Which checks?",
      header: "Checks",
      options: [
        { label: "Typecheck", description: "" },
        { label: "Unit tests", description: "" },
      ],
      multiSelect: true,
    },
  ];
  const quiz = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "AskUserQuestion", tool_input: { questions } });
  T.hooks.onRequest(quiz);
  const card = (await p.next("permission_prompt", (m) => m.prompt?.questions, from)).prompt;
  assert.deepEqual(card.questions, questions);
  assert.equal(card.what, "ask 2 questions: Install tmux, Checks");
  await p.send({ type: "answers", promptId: card.promptId, answers: [{ labels: ["Maybe"] }, { labels: ["Typecheck"] }] });
  assert.equal((await p.next("error", (m) => m.code === "bad_answers", from)).code, "bad_answers");
  assert.ok(quiz.open);
  await p.send({ type: "answers", promptId: card.promptId, answers: [{ labels: [], text: "After the release" }, { labels: ["Unit tests", "Typecheck"] }] });
  await until(() => !quiz.open);
  assert.deepEqual(quiz.reply, { behavior: "allow" });
  assert.deepEqual(quiz.answers, { "Install tmux tonight?": "After the release", "Which checks?": "Typecheck, Unit tests" });
  assert.equal(events("phone_answers").length, 1);
  await p.next("permission_prompt", (m) => m.prompt === null, from);
  // An app that only knows Allow: its allow leaves them in the terminal, unanswered.
  from = p.got.length;
  const old = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "AskUserQuestion", tool_input: { questions } });
  T.hooks.onRequest(old);
  const oldCard = (await p.next("permission_prompt", (m) => m.prompt?.questions, from)).prompt;
  await p.send({ type: "permission", promptId: oldCard.promptId, decision: "allow" });
  await until(() => !old.open);
  assert.equal(old.reply, null);
  assert.equal(old.answers, undefined);
  console.log("ok");

  begin("phone: what's said while the phone is gone comes in `missed` as it's back; catch_up reads it in order, behind what's being said");
  p.close();
  await until(() => events("phone_disconnected").some((l) => l.phoneId === paired.phoneId));
  // Gone (locked, out of reach): two sessions finish and are read out on the Mac.
  T.needs = [0.8];
  const whileGone = stop(TERM, "cli");
  T.hooks.onRequest(whileGone);
  await until(() => caseSaid().some((x) => x.text === "summary for atlas-agents"));
  await until(() => !whileGone.open, 3000);
  T.needs = [0.8];
  const alsoGone = stop(DESK, "claude-desktop");
  T.hooks.onRequest(alsoGone);
  await until(() => caseSaid().some((x) => x.text === "summary for 2 plus 2"));
  await until(() => !alsoGone.open, 3000);
  // Back: right after welcome, what it missed, oldest first.
  p = new Phone();
  const backAt = events("phone_presence").length;
  await p.send({ type: "hello", token: paired.token, device: "Test iPhone", appVersion: "0.1.0" });
  await p.next("welcome");
  const missed = (await p.next("missed")).items;
  // It says it's in front right after welcome; only once the hub has that does it get what's said
  // (listeners: never one that hasn't said where it is). Before, a reading could start first.
  await until(
    () =>
      events("phone_presence")
        .slice(backAt)
        .some((l) => l.phoneId === paired.phoneId && l.state === "back"),
    5000,
    "the hub to have the phone in front (phone_presence)",
  );
  assert.deepEqual(
    missed.map((x: any) => [x.kind, x.sessionId, x.name, x.text]),
    [
      ["announcement", "term-1", "atlas-agents", "summary for atlas-agents"],
      ["announcement", "desk-1", "2 plus 2", "summary for 2 plus 2"],
    ],
  );
  assert.deepEqual(
    events("phone_missed").map((l) => [l.count, l.on]),
    [[2, "welcome"]],
  );
  // Catch me up while another session's turn is being read: it waits for it, then both in order.
  markHere();
  from = p.got.length;
  T.needs = [0.8];
  const live = stop(TERM, "cli");
  T.hooks.onRequest(live);
  await until(() => ui.state.speaking);
  await p.send({ type: "catch_up", ids: missed.map((x: any) => x.id) });
  await until(() => caseSaid().length === 3);
  const [heardLive, first, second] = caseSaid();
  assert.deepEqual([heardLive.text, first.text, second.text], ["summary for atlas-agents", "summary for atlas-agents", "summary for 2 plus 2"]);
  assert.ok(heardLive.end - heardLive.start >= T.speakMs - 10, "the reading wasn't cut");
  assert.ok(first.at >= heardLive.end && second.at >= first.end, "each after the one before");
  assert.deepEqual(
    events("phone_catch_up").map((l) => [l.phoneId, l.count]),
    [[paired.phoneId, 2]],
  );
  // The phone (Play on phone on) gets the words to say, in the same order: sent as each is said, so
  // they're on their way by now; the wait is for the socket.
  const speaks = () =>
    p.got
      .slice(from)
      .filter((m) => m.type === "speak")
      .map((m) => m.text);
  await until(
    () => speaks().length >= 3,
    5000,
    () => `3 speak messages (got ${JSON.stringify(speaks())})`,
  );
  assert.deepEqual(speaks(), ["summary for atlas-agents", "summary for atlas-agents", "summary for 2 plus 2"]);
  await until(() => !live.open, 3000);
  // Read, they aren't sent again; a press stops a catch-up like any speech. (Away for a moment: a
  // change counts once it has held 300ms.)
  await p.send({ type: "presence", state: "away" });
  await wait(450);
  await p.send({ type: "presence", state: "back" });
  assert.deepEqual((await p.next("missed", () => true, from)).items, []);
  markHere();
  T.speakMs = 300;
  await p.send({ type: "catch_up", ids: missed.map((x: any) => x.id) });
  await until(() => ui.state.speaking);
  T.heard = "";
  T.hotkey.onDown();
  await T.hotkey.onUp();
  await until(() => !ui.state.listening);
  await wait(400);
  T.speakMs = 50;
  assert.deepEqual(
    caseSaid().map((x) => x.text),
    ["summary for atlas-agents"],
    "the rest dropped",
  );
  await wait(1700);
  console.log("ok");

  begin("phone: a question allowed on the Mac while it's gone comes back settled; Catch me up says one summary without it; Stop cuts it");
  p.close();
  await until(() => events("phone_disconnected").some((l) => l.phoneId === paired.phoneId));
  // Gone: atlas-agents asks, and it's allowed at the Mac (its key); then both sessions finish.
  const askedGone = new HookRequest({ hook_event_name: "PermissionRequest", session_id: TERM.sessionId, cwd: TERM.cwd, tool_name: "Bash", tool_input: {} });
  T.hooks.onRequest(askedGone);
  await until(() => caseSaid().some((x) => x.text === "atlas-agents wants to Bash. Allow?"));
  ui.act({ type: "allow", always: false, id: ui.state.permission!.id });
  await until(() => !askedGone.open);
  assert.deepEqual(askedGone.reply, { behavior: "allow" });
  for (const [s, via, text] of [
    [TERM, "cli", "summary for atlas-agents"],
    [DESK, "claude-desktop", "summary for 2 plus 2"],
  ] as const) {
    T.needs = [0.8];
    const finished = stop(s, via);
    T.hooks.onRequest(finished);
    await until(() => caseSaid().some((x) => x.text === text));
    await until(() => !finished.open, 3000);
  }
  // Back: the question is there, marked answered on the Mac.
  p = new Phone();
  await p.send({ type: "hello", token: paired.token, device: "Test iPhone", appVersion: "0.1.0" });
  const awayItems = (await p.next("missed")).items;
  assert.deepEqual(
    awayItems.map((x: any) => [x.kind, x.text, x.settled?.how ?? null]),
    [
      ["permission", "atlas-agents wants to Bash. Allow?", "answered_on_mac"],
      ["announcement", "summary for atlas-agents", null],
      ["announcement", "summary for 2 plus 2", null],
    ],
  );
  // Catch me up: one summary of the two that still need you, said through the usual speech.
  markHere();
  from = p.got.length;
  T.speakMs = 1500;
  T.catchUps = [];
  await p.send({ type: "catch_up", ids: awayItems.map((x: any) => x.id), summary: true });
  await until(() => caseSaid().length === 1 && ui.state.speaking);
  assert.deepEqual(
    T.catchUps.map((u: any[]) => u.map((x) => [x.name, x.kind])),
    [
      [
        ["atlas agents", "announcement"],
        ["2 plus 2", "announcement"],
      ],
    ],
    "without the question",
  );
  assert.equal(caseSaid()[0].text, "While you were away: atlas agents, 2 plus 2.");
  assert.equal((await p.next("speak", () => true, from)).text, "While you were away: atlas agents, 2 plus 2.");
  assert.equal((await p.next("state", (m) => m.catchingUp === true, from)).catchingUp, true, "the phone shows Stop");
  const summed = events("phone_catch_up_summary");
  assert.deepEqual(
    summed.map((l) => [l.count, l.fallback, l.llmCost]),
    [[2, false, 0.0003]],
    "its cost logged",
  );
  assert.deepEqual(
    events("phone_catch_up").map((l) => [l.count, l.summary, l.settled]),
    [[2, true, 1]],
  );
  // Stop: cut, as a press would.
  await p.send({ type: "catch_up_stop" });
  await until(() => !ui.state.speaking);
  T.speakMs = 50;
  assert.ok(caseSaid()[0].end - caseSaid()[0].start < 1000, "cut");
  assert.deepEqual(
    events("phone_catch_up_stopped").map((l) => [l.phoneId, l.stopped]),
    [[paired.phoneId, true]],
  );
  await p.next("state", (m) => m.catchingUp === false, from);
  console.log("ok");

  begin("phone: forgotten, it's let go and its token stops working; Phone off stops listening and Bonjour");
  set("phones", `forget:${paired.phoneId}`);
  assert.equal((await p.next("error", (m) => m.code === "unauthorized")).code, "unauthorized");
  await until(() => p.closed);
  assert.equal(row("phones")?.value, "None");
  const after = new Phone();
  await after.send({ type: "hello", token: paired.token, device: "Test iPhone", appVersion: "0.1.0" });
  assert.equal((await after.next("error")).code, "unauthorized");
  set("phone", false);
  await until(() => events("phone_off").length > 0);
  assert.ok(T.advertisedAll.every((a: any) => a.stopped));
  assert.equal(row("phone")?.value, "Off");
  console.log("ok");

  begin("phone: Pair a phone with Phone off turns it on, then shows its QR code; closing settings closes it");
  assert.equal(row("phonePair")?.value, "QR code (turns Phone on)");
  const ons = events("phone_on").length;
  set("phonePair", "open");
  assert.equal((ui.state.pairQr as any)?.phase, "starting");
  await until(() => (ui.state.pairQr as any)?.phase === "showing", 3000, "the QR code once Phone is on");
  assert.equal(events("phone_on").length, ons + 1);
  assert.equal(row("phone")?.value.startsWith("On"), true);
  assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).phone, true, "on as its own row would turn it");
  ui.act({ type: "closeSettings" });
  assert.equal(ui.state.pairQr, null, "never left up behind the settings screen");
  assert.deepEqual(events("phone_pairing_qr").at(-1), { ...events("phone_pairing_qr").at(-1), open: false, why: "closed" });
  ui.act({ type: "settings" });
  set("phone", false);
  await until(() => row("phone")?.value === "Off");
  ui.act({ type: "closeSettings" });
  console.log("ok");

  begin("phone not live (KIKO_PHONE_LIVE=0, as the release has it): no Phone rows, nothing starts with phone saved on, the voice's ask gets one line; live again, as before");
  const { setPhone } = await import("../../../src/app/phone.ts");
  const { PHONE_NOT_OUT } = await import("../../../src/core/env.ts");
  const { PHONE_KEYS } = await import("../../../src/core/settings-options.ts");
  const savedFile = JSON.parse(readFileSync("settings-test.json", "utf8"));
  writeFileSync("settings-test.json", JSON.stringify({ ...savedFile, phone: true }, null, 2));
  const advertisedBefore = T.advertisedAll.length;
  const routeBefore = T.route;
  let routed = 0;
  T.route = (input: any) => (routed++, routeBefore(input));
  process.env.KIKO_PHONE_LIVE = "0";
  try {
    ui.act({ type: "settings" });
    assert.deepEqual(
      ui.state.settings.filter((r: any) => PHONE_KEYS.has(r.key)).map((r: any) => r.key),
      [],
      "no Phone section",
    );
    assert.ok(row("sounds"), "the other rows are there");
    await setPhone(true);
    set("phone", true);
    set("phonePair", "open");
    await wait(100);
    assert.equal(events("phone_on").length, 0, "the server never starts");
    assert.equal(T.advertisedAll.length, advertisedBefore, "nothing advertised with Bonjour");
    assert.ok(!ui.state.pairQr, "no QR code");
    assert.ok(
      caseLines().some((l) => l.text.includes(PHONE_NOT_OUT)),
      "the row's change refused, said",
    );
    assert.equal(JSON.parse(readFileSync("settings-test.json", "utf8")).phone, true, "the saved value kept");
    ui.act({ type: "closeSettings" });
    await talk("Kiko, pair my phone");
    await until(() => spoke(PHONE_NOT_OUT));
    assert.equal(routed, 0, "never routed");
    assert.equal(events("phone_not_live").length, 1);
  } finally {
    delete process.env.KIKO_PHONE_LIVE;
  }
  await wait(1700);
  markHere();
  await talk("Kiko, pair my phone");
  await until(() => caseLines().some((l) => l.kind === "voice"), 3000, "decided and answered, as before");
  assert.ok(!spoke(PHONE_NOT_OUT));
  assert.equal(events("phone_not_live").length, 0);
  T.route = routeBefore;
  writeFileSync("settings-test.json", JSON.stringify(savedFile, null, 2));
  await wait(1700);
  console.log("ok");
}
