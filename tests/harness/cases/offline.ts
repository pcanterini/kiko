// When the router can't answer, end to end (src/core/decide.ts routeFailed, core/kept.ts, core/online.ts,
// app/deliver.ts retryKept), 2026-11-12. Once, the Mac's internet dropped for
// two minutes (the relay: "getaddrinfo ENOTFOUND relay.kiko.sh"); two messages for Rowan each waited 12s
// for the router and were lost with "Something went wrong, and I didn't send that." Now the words are
// kept ("I'm offline. I'll send that when I'm back."), routed again by the router once the network is
// back, in the order said and once each; late ones are asked about first; the retries stop after a
// while ("Say send it to try again."), and a name sends kept words at once. No session is ever guessed.
import assert from "node:assert/strict";
import { begin, caseLines, caseLog, ghostty, spoke, stop, T, talk, TERM, ui, until, wait } from "../driver.ts";

const { online } = await import("../../../src/core/online.ts");

const DNS = new Error("getaddrinfo ENOTFOUND relay.kiko.sh");
const TIMED_OUT = "no answer: 2 tries, 8000ms each";
const FIRST = "Yes, this version is a lot better than what's live right now. Let's go with it. Merge these changes into the main branch, and then deploy it to production when you're done.";
const SECOND = "There's more to polish later, but this is ready to go out now.";
const OFFLINE_LINE = "I'm offline. I'll send that when I'm back.";
const NO_ANTHROPIC_LINE = "Can't reach Anthropic: I'll send that when it's back.";
// As Node's fetch reports a connect that timed out (2026-11-20: OpenRouter's, for the classifier).
const connectTimedOut = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" }) });
const FAILED_LINE = "I couldn't work out where that goes. Trying again.";

export async function offlineCases() {
  const ROWAN = { ...TERM, sessionId: "rowan-o", name: "Rowan", givenName: "Rowan", cwd: "/nonexistent/rowan-platform", place: ghostty("ghostty-rowan-o") };
  const PIXEL = { ...TERM, sessionId: "pixel-o", name: "pixel", cwd: "/nonexistent/pixel", place: ghostty("ghostty-pixel-o") };
  const before = T.sessions;
  T.sessions = [ROWAN, PIXEL];
  await wait(2100); // windows and the session list cache run out
  // Listed now, not at the app's next look (every 4 seconds): "Sent to Rowan." names it from the list,
  // and where that look falls depends on how long the cases before took.
  T.hooks.onSessionsChanged();
  await until(() => ui.state.sessions.some((s: any) => s.sessionId === ROWAN.sessionId), 3000, "Rowan listed");
  ui.act({ type: "set", key: "voiceCan", value: "messages" });
  const logged = (event: string) => caseLog().filter((l) => l.event === event);
  const typedInto = (s: any) => T.typed.filter((t: any) => t.terminalId === s.place.id).map((t: any) => t.text);
  const said = (text: string) => caseLines().filter((l) => l.kind === "voice" && l.text === text).length;
  const noModels = () => {
    T.route = () => {
      throw new Error("no router: read in code");
    };
    T.utterance = () => {
      throw new Error("no classifier: read in code");
    };
  };
  /** The router, back: it picks Rowan, and counts what it was asked. */
  const routedTo = (s: any, asked: string[] = []) => {
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1 });
    T.route = (input: any) => (asked.push(input.text), [{ name: "pass_on", session: s }]);
    return asked;
  };
  /** A session's turn read out, its reply window left to close. */
  const announced = async (s: any) => {
    const n = logged("announce").filter((l) => l.sessionId === s.sessionId).length;
    T.needs = [0.76];
    const r = stop(s, "cli");
    T.hooks.onRequest(r);
    await until(() => logged("announce").filter((l) => l.sessionId === s.sessionId).length > n);
    await until(() => !r.open, 3000);
  };
  /** You talk to `s`, the classifier sure of it, and it's typed in. */
  const spokeTo = async (s: any, text: string) => {
    T.utterance = () => ({ audience: s, audienceConfidence: 0.95, intent: "message", intentConfidence: 1 });
    const k = typedInto(s).length;
    await talk(text);
    await until(() => typedInto(s).length > k);
  };
  /** Back online, and nothing kept or retrying left over for the next case. */
  const backAndClear = async () => {
    online.relayConnected();
    online.ok("anthropic");
    online.ok("openrouter");
    await wait(300);
  };
  // As the log had it: the relay was connected, then went.
  online.relayConnected();

  begin("offline again: the router times out as the relay finds DNS gone: kept, said once; back online, the router's pick gets it, once");
  await spokeTo(ROWAN, "Nice, the new chart looks right on the dashboard, but the legend still covers it on small screens.");
  await announced(ROWAN);
  online.relayDisconnected();
  T.utterance = () => {
    throw new Error("The operation was aborted due to timeout");
  };
  // The relay's retry fails on DNS while the router waits, then the router gives up.
  T.route = () => {
    online.relayError(DNS);
    throw new Error(TIMED_OUT);
  };
  let k = typedInto(ROWAN).length;
  await talk(FIRST);
  await until(() => spoke(OFFLINE_LINE));
  assert.equal(typedInto(ROWAN).length, k, "nothing sent: no session guessed");
  assert.equal(logged("question_pending").length, 0, "nothing offered");
  assert.ok(!caseLines().some((l) => /Something went wrong/.test(l.text)), "not the old line");
  assert.deepEqual(
    logged("route_fallback").map((l) => [l.why, l.skipped, l.kept]),
    [["offline", false, true]],
  );
  assert.equal(logged("words_kept").at(-1)?.text, FIRST);
  assert.ok(
    caseLines().some((l) => l.kind === "info" && l.text.startsWith('(kept, not sent: "Yes, this version')),
    "shown on Kiko's page",
  );
  // The relay back: the router asked at once, and its pick gets the words.
  const asked = routedTo(ROWAN);
  online.relayConnected();
  await until(() => typedInto(ROWAN).length > k);
  await until(() => spoke("Sent to Rowan."));
  await wait(400);
  assert.deepEqual(asked, [FIRST], "routed by the router");
  assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST], "typed once");
  assert.equal(said(OFFLINE_LINE), 1, "said once");
  console.log("ok");

  begin("retrying: new words named for Rowan while two wait: the two go first, in the order said, then the new ones; none twice");
  await wait(1700);
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1 });
  T.route = () => {
    throw new Error("anthropic 500: overloaded");
  };
  k = typedInto(ROWAN).length;
  await talk(FIRST);
  await until(() => said(FAILED_LINE) === 1);
  await talk(SECOND);
  await until(() => said(FAILED_LINE) === 2);
  // The router answers again, before the first retry (2s) comes due; then "Rowan, …" (no router).
  routedTo(ROWAN);
  await talk("Rowan, also run the tests.");
  await until(() => typedInto(ROWAN).length >= k + 3);
  await wait(2500); // past the retry's time: nothing goes again
  assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST, SECOND, "Also run the tests."]);
  console.log("ok");

  begin("offline, the retries run out: 'I couldn't send that. Say send it to try again.'; the name sends it");
  process.env.KIKO_TEST_KEPT_STEPS_MS = "50";
  online.relayError(DNS);
  T.route = () => {
    throw new Error("no router: known offline");
  };
  k = typedInto(ROWAN).length;
  await talk(SECOND);
  await until(() => spoke(OFFLINE_LINE));
  await until(() => spoke("I couldn't send that. Say send it to try again."), 3000);
  delete process.env.KIKO_TEST_KEPT_STEPS_MS;
  assert.ok(logged("kept_retry").filter((l) => l.skipped).length >= 7, "each retry known offline, not waited for");
  assert.equal(typedInto(ROWAN).length, k);
  noModels();
  await talk("Rowan.");
  await until(() => typedInto(ROWAN).length > k);
  await wait(200);
  assert.deepEqual(typedInto(ROWAN).slice(k), [SECOND]);
  await backAndClear();
  assert.ok(!caseLines().some((l) => l.kind === "voice" && l.text.startsWith("I'm back online")), "nothing kept: no news");
  console.log("ok");

  begin("a retry long after the words were said: 'Still send …' asked first; yes sends them once");
  process.env.KIKO_TEST_STALE_MS = "300";
  T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1 });
  T.route = () => {
    throw new Error("anthropic 500: overloaded");
  };
  k = typedInto(ROWAN).length;
  await talk(FIRST);
  await until(() => spoke(FAILED_LINE));
  routedTo(ROWAN);
  const STILL = 'Still send "Yes, this version is a lot…" to Rowan?';
  await until(() => spoke(STILL), 4000); // the first retry, at 2s
  delete process.env.KIKO_TEST_STALE_MS;
  assert.equal(typedInto(ROWAN).length, k, "asked, not sent");
  noModels();
  await talk("Yes.");
  await until(() => typedInto(ROWAN).length > k);
  await wait(300);
  assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST]);
  await talk("Send it.");
  await until(() => spoke("There's nothing waiting to send.") || caseLines().some((l) => /nothing done/.test(l.text)));
  assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST], "never twice");
  console.log("ok");

  begin("kept words run out unsent after their time: shown, not said");
  process.env.KIKO_TEST_KEPT_MS = "400";
  process.env.KIKO_TEST_KEPT_STEPS_MS = "50";
  online.relayError(DNS);
  k = typedInto(ROWAN).length;
  await talk(SECOND);
  await until(() => spoke(OFFLINE_LINE));
  await until(() => logged("kept_expired").length > 0, 2000);
  delete process.env.KIKO_TEST_KEPT_MS;
  delete process.env.KIKO_TEST_KEPT_STEPS_MS;
  assert.ok(caseLines().some((l) => l.kind === "info" && l.text.startsWith("(no longer kept, not sent:")));
  assert.ok(!caseLines().some((l) => l.kind === "voice" && /no longer kept/.test(l.text)), "shown, not said");
  assert.equal(typedInto(ROWAN).length, k);
  await backAndClear();
  console.log("ok");

  begin("the classifier's OpenRouter times out, the router's Anthropic answers: sent, never 'offline'; next words skip only the classifier");
  {
    const asked = routedTo(ROWAN);
    let classified = 0;
    T.utterance = () => {
      classified++;
      // As core/model-route.ts notes it, then the classifier's own error.
      online.callFailed("openrouter", connectTimedOut());
      throw new Error("fetch failed (ETIMEDOUT)");
    };
    k = typedInto(ROWAN).length;
    await talk(FIRST);
    await until(() => typedInto(ROWAN).length > k);
    await talk(SECOND);
    await until(() => typedInto(ROWAN).length > k + 1);
    await wait(200);
    assert.deepEqual(asked, [FIRST, SECOND], "the router asked both times");
    assert.equal(classified, 1, "OpenRouter known down: the classifier skipped the second time");
    assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST, SECOND]);
    assert.equal(logged("route_fallback").length, 0, "not offline");
    assert.ok(!caseLines().some((l) => l.kind === "voice" && /offline|Can't reach/.test(l.text)), "nothing said about it");
    assert.ok(
      caseLines().some((l) => /OpenRouter isn't answering; routing without it\./.test(l.text)),
      "shown: which service, and that it routes anyway",
    );
    await backAndClear();
  }
  console.log("ok");

  begin("kept while Anthropic can't be reached, routed again once it's back with the conversation as it was: not to the session read out since");
  {
    process.env.KIKO_TEST_KEPT_STEPS_MS = "60000"; // no retry by itself: only Anthropic back sends it
    await announced(ROWAN); // the words answer Rowan, just read out
    T.utterance = () => ({ audience: "app", audienceConfidence: 0.3, intent: "message", intentConfidence: 1 });
    let firstRecent: string[] = [];
    T.route = (input: any) => {
      firstRecent = input.recent;
      online.callFailed("anthropic", connectTimedOut());
      throw new Error("Connection error.");
    };
    k = typedInto(ROWAN).length;
    const kp = typedInto(PIXEL).length;
    await talk(FIRST);
    await until(() => spoke(NO_ANTHROPIC_LINE));
    // Meanwhile pixel's turn is read out.
    await announced(PIXEL);
    // A router that goes by what it's told: the session waiting, else the one just read out.
    const inputs: any[] = [];
    T.route = (input: any) => {
      inputs.push(input);
      const id = input.waitingId ?? input.justSpoke?.id;
      return [{ name: "pass_on", session: input.sessions.find((x: any) => x.sessionId === id) }];
    };
    online.ok("anthropic");
    await until(() => typedInto(ROWAN).length > k, 3000, "sent to Rowan");
    await until(() => spoke("Sent to Rowan."));
    delete process.env.KIKO_TEST_KEPT_STEPS_MS;
    assert.deepEqual(typedInto(ROWAN).slice(k), [FIRST]);
    assert.equal(typedInto(PIXEL).length, kp, "not pixel, read out since");
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].justSpoke?.id, ROWAN.sessionId, "the one just read out when they were said");
    assert.deepEqual(inputs[0].recent, firstRecent, "the conversation as it was: nothing from after them");
    assert.equal(said(NO_ANTHROPIC_LINE), 1);
    await backAndClear();
  }
  console.log("ok");

  T.route = () => [];
  T.utterance = () => ({ audience: "app", audienceConfidence: 0, intent: "other", intentConfidence: 0 });
  online.relayOff();
  T.sessions = before;
  await wait(2100);
}
