// A session's name heard as other words (src/core/heard-as.ts), and the correction after a cancel
// (src/core/timeline.ts latestSend, decide.ts resend_to). The case: "To Rowan, do we have
// anything …" came through as "Too rowing, do we have anything …", no name matched, and the router
// sent it to the Kiko project, whose recent talk was about backups. "No, cancel that." stopped it
// there. "That was too rowing, not to Kiko." then went to the router as resend_to the Kiko project
// (the one it went to), and the app said "Your last words didn't go to a session, so there's
// nothing to send on.": the cancel's own words had ended what a correction could be about.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type DecideDeps, type DecideState, type Sent } from "../../../src/core/decide.ts";
import { nameHeardAs, soundDistance, soundKey, soundsLikeIn } from "../../../src/core/heard-as.ts";
import type { Action, Router } from "../../../src/core/router.ts";
import { sessionName } from "../../../src/core/sessions.ts";
import { latestSend, type Entry } from "../../../src/core/timeline.ts";
import { makeWorld } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

// As the route prompt listed them.
const W = makeWorld([
  {
    name: "Bobby",
    folder: "2026-11-03-bobby",
    given: "Bobby",
    activeAgoS: 3180,
    asked: "! git -C ~/git/notes push origin main",
    said: "To change the menu, edit the list near the top of src/menu.ts.",
  },
  {
    name: "Rowan",
    folder: "rowan-platform",
    given: "Rowan",
    activeAgoS: 32,
    asked: "how's it going? is there a build to try?",
    said: "That build needs you to sign in once more.",
  },
  {
    name: "Kiko project",
    folder: "kiko",
    given: "Kiko project",
    activeAgoS: 1140,
    asked: "can the app show its version somewhere?",
    said: "Once you pick a layout, I can do the rest.",
  },
  { name: "mintbox", activeAgoS: 4, asked: "keep a copy so we can try again", said: "The icon export is still next." },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;

// More session names, for words that must not call them.
const MORE = makeWorld([
  { name: "atlas-agents" },
  { name: "clipkit" },
  { name: "lacy", folder: "lacy-platform", given: "Lacy" },
  { name: "claude-code-speech" },
  { name: "pixie" },
  { name: "harbor" },
]);
const ALL = [...W.sessions, ...MORE.sessions];
const heardName = (text: string, sessions = ALL) => {
  const h = nameHeardAs(sessions, text);
  return h ? sessionName(h.session) : null;
};

const SAID = "Too rowing, do we have a page that explains how the nightly backups are checked? A new user would struggle to know where to look and what the colours mean.";
const SENT = SAID.replace("Too rowing, d", "D");

describe("sounds like a name (soundKey, soundDistance)", () => {
  test("spelled as said: a soft c, vowels loose, double letters as one", () => {
    assert.equal(soundKey("Rowan"), soundKey("Rowen"));
    assert.equal(soundKey("Rowan"), soundKey("Rowann"));
    assert.equal(soundKey("Lacy"), soundKey("Lasey"));
    assert.equal(soundKey("Bobby"), soundKey("Bobbie"));
    assert.equal(soundKey("Phil"), soundKey("fill"));
  });
  test("close: one sound off a short name, as many syllables", () => {
    assert.equal(soundDistance("rowing", "Rowan"), 1);
    assert.equal(soundDistance("rowen", "Rowan"), 0);
    assert.equal(soundDistance("mintbots", "mintbox"), 1);
  });
  test("not close: a syllable short or more, another first sound, too far", () => {
    for (const [said, name] of [
      ["row", "Rowan"],
      ["roam", "Rowan"],
      ["rows", "Rowan"],
      ["bob", "Bobby"],
      ["lazy", "Rowan"],
      ["kicked", "Kiko project"],
      ["mint", "mintbox"],
    ]) {
      assert.equal(soundDistance(said, name), null, `${said} / ${name}`);
    }
  });
});

describe("a name heard as other words, up front (nameHeardAs)", () => {
  test("the incident's words: Rowan, and what was said for it cut", () => {
    const h = nameHeardAs(W.sessions, SAID)!;
    assert.equal(h.session, S("Rowan"));
    assert.equal(h.heard, "rowing");
    assert.equal(h.said, "Too rowing,");
    assert.equal(h.rest, SENT);
  });
  test("other spellings of 'to' and of the name, and tell or ask", () => {
    for (const said of [
      "To rowing, run the tests.",
      "Two rowen, check the build.",
      "Too rowing: check the logs please.",
      "Okay, too rowing. Check the logs please.",
      "Tell rowing to check the build.",
      "Ask, uh, rowing to look at the logs.",
      "To Ronan, run the tests now.",
      "Hey Ronan, run the tests now.",
    ]) {
      assert.equal(heardName(said), "Rowan", said);
    }
    assert.equal(heardName("To mint bots, add the export button."), "mintbox");
    assert.equal(heardName("To clip kid, run it."), "clipkit");
    assert.equal(heardName("Hey Bobbie, check the cert."), "Bobby");
  });
  test("ordinary sentences call nobody: no pause after the words, or words said every day", () => {
    for (const said of [
      "Two rowing machines broke.",
      "To test this, open the app.",
      "To test, open the app and click the button.",
      "Two tests failed, can you look?",
      "Two tests failed.",
      "Too bad, the tests failed again.",
      "Too busy, I'll check later.",
      "Too late, it already shipped.",
      "To be honest, it looks fine.",
      "To recap, we merged it.",
      "Two things, first fix the bug.",
      "Rowing, but too slow.",
      "To me, that looks right.",
      "Too rowing.",
      "Rowing, please, on the lake.",
      "Tell them to check the build.",
      "Ask it to run the tests.",
      "Bob, can you look?",
      "Mint it, then commit.",
      "Clip it, then commit.",
      "Atlas, the book, is on the shelf.",
      "Kicking off the build now, check it later.",
      "To clarify, the bobbin is broken.",
      "Lazy, I know, but ship it.",
    ]) {
      assert.equal(heardName(said), null, said);
    }
  });
  test("two sessions as close: no clear margin, nobody", () => {
    const twins = makeWorld([
      { name: "lacy", folder: "lacy-platform", given: "Lacy" },
      { name: "macy", folder: "macy-platform", given: "Macy" },
      { name: "lacey", folder: "lacey-app", given: "Lacey" },
    ]).sessions;
    assert.equal(nameHeardAs(twins, "To lazy, run the tests."), null);
  });
  test("nothing after it: nobody", () => {
    assert.equal(heardName("Too rowing, okay."), null);
  });
});

describe("a name heard as other words in a correction (soundsLikeIn)", () => {
  const notKiko = new Set([S("Kiko project").sessionId]);
  test("the incident's correction: Rowan, never the one after 'not to'", () => {
    assert.equal(soundsLikeIn(W.sessions, "That was too rowing, not to Kiko.", notKiko)?.session, S("Rowan"));
    assert.equal(soundsLikeIn(W.sessions, "No, that was for mint bots.", notKiko)?.session, S("mintbox"));
  });
  test("a name after 'not' is the wrong one, and words with no name call nobody", () => {
    for (const said of ["Not to Kiko, the other one.", "Wrong one.", "That wasn't for this session.", "No, not rowing.", "That was supposed to go to busy."]) {
      assert.equal(soundsLikeIn(W.sessions, said, notKiko), null, said);
    }
  });
});

describe("latestSend: a cancel stands aside for the send it took back", () => {
  const at = Date.now();
  const you = (text: string, more: Partial<Entry> = {}): Entry => ({ at, who: "you", sessionId: null, folder: null, text, ...more });
  const app = (text: string): Entry => ({ at, who: "app", sessionId: null, folder: null, text });
  const sent = (more: Partial<Entry> = {}) => you(SENT, { sessionId: "kiko", folder: "Kiko project", ...more });

  test("send, 'No, cancel that.' (undo), the app's line: the send is still what a correction means", () => {
    const entries = [you(SAID), sent({ undone: true }), you("No, cancel that.", { aside: "undo" }), app("Interrupted Kiko project's current turn.")];
    const last = latestSend(entries, 60_000, true);
    assert.equal(last?.text, SENT);
    assert.equal(last?.undone, true);
  });
  test("before the fix: a plain entry of yours in between ends it", () => {
    assert.equal(latestSend([sent(), you("No, cancel that."), app("Interrupted Kiko project's current turn.")], 60_000, true), undefined);
  });
  test("an undo stands aside only for a send it took back", () => {
    assert.equal(latestSend([sent(), you("No, cancel that.", { aside: "undo" })], 60_000, true), undefined);
  });
  test("a correction the app asked about stands aside too; new words after it don't", () => {
    const entries = [sent(), you("No, wrong one.", { aside: "asked" }), app("That already went to Kiko project. Which session was it for?")];
    assert.equal(latestSend(entries, 60_000, true)?.text, SENT);
    assert.equal(latestSend([...entries, you("What time is it?")], 60_000, true), undefined);
  });
  test("two cancels in a row: still the send", () => {
    const entries = [sent({ undone: true }), you("No, cancel that.", { aside: "undo" }), you("Cancel that.", { aside: "undo" })];
    assert.equal(latestSend(entries, 60_000, true)?.text, SENT);
  });
});

type Stub = { classifier?: Partial<Omit<UtteranceDecision, "audience">> & { audience?: string }; router?: (input: Parameters<Router["route"]>[0]) => Action[] };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const { classifier, router, ...state0 } = opts;
  const seen: { route: Parameters<Router["route"]>[0] | null; routes: number } = { route: null, routes: 0 };
  const deps: DecideDeps = {
    utterance: async () => {
      const j = classifier ?? {};
      return {
        audience: j.audience && j.audience !== "app" ? S(j.audience) : "app",
        audienceConfidence: j.audienceConfidence ?? 0.09,
        intent: j.intent ?? "message",
        intentConfidence: j.intentConfidence ?? 1,
        appParts: j.appParts ?? 0.09,
        model: "test",
        costUsd: 0,
        ms: 1,
      };
    },
    approval: null,
    route: async (input) => {
      seen.route = input;
      seen.routes++;
      return { text: "", actions: router?.(input) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: S("Rowan").sessionId,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...state0,
  };
  const d = await decide(state, deps);
  return { d, outcomes: outcomesOf(d, state).map(({ sessionId: _id, ...o }) => o), seen };
}

const to = (name: string) => (): Action[] => [{ name: "pass_on", session: S(name) }];

describe("step 1: 'Too rowing, do we have anything …'", () => {
  test("the router is told the name heard (<name_heard_as>), and its pass_on to Rowan goes without it, said and held", async () => {
    const { d, outcomes, seen } = await run(SAID, { classifier: { audience: "Bobby", audienceConfidence: 0.32 }, router: to("Rowan") });
    assert.equal(seen.route?.heardAs?.session, S("Rowan"));
    assert.equal(seen.route?.heardAs?.said, "rowing");
    assert.deepEqual(d.heardAs, { sessionId: S("Rowan").sessionId, heard: "rowing", said: "Too rowing,", rest: SENT });
    assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: SENT, via: "terminal", unsure: true }]);
  });
  test("a hint only: the router's pick stands, the words as said", async () => {
    const { outcomes } = await run(SAID, { router: to("Kiko project") });
    assert.deepEqual(outcomes, [{ action: "send", to: "Kiko project", text: SAID, via: "terminal", unsure: true }]);
  });
  test("the classifier at its bar for another session: the router weighs it, told of the name", async () => {
    const { seen, outcomes } = await run(SAID, { classifier: { audience: "Kiko project", audienceConfidence: 0.8 }, router: to("Rowan") });
    assert.equal(seen.routes, 1);
    assert.equal(outcomes[0].action === "send" && outcomes[0].to, "Rowan");
  });
  test("the classifier very sure of another one: as before, no router", async () => {
    const { seen, outcomes } = await run(SAID, { classifier: { audience: "Kiko project", audienceConfidence: 0.95 } });
    assert.equal(seen.routes, 0);
    assert.equal(outcomes[0].action === "send" && outcomes[0].to, "Kiko project");
  });
  test("the classifier sure of Rowan: sent there, the name heard cut", async () => {
    const { outcomes } = await run(SAID, { classifier: { audience: "Rowan", audienceConfidence: 0.8 } });
    assert.deepEqual(outcomes, [{ action: "send", to: "Rowan", text: SENT, via: "terminal" }]);
  });
  test("with Bobby waiting for a reply, the router's pick of Rowan for the name heard stands", async () => {
    const { outcomes } = await run(SAID, { waiting: { sessionId: S("Bobby").sessionId, cwd: S("Bobby").cwd }, router: to("Rowan") });
    assert.equal(outcomes[0].action === "send" && outcomes[0].to, "Rowan");
  });
  test("ordinary words: no hint", async () => {
    for (const said of ["Too bad, the tests failed again. Can you look?", "To test this, open the app.", "Two tests failed, can you look?", "Too rowing for me, honestly."]) {
      const { seen, d } = await run(said, { router: to("Rowan") });
      assert.equal(seen.route?.heardAs, undefined, said);
      assert.equal(d.heardAs, undefined, said);
    }
  });
  test("the router's ask_session to Rowan (relay, router-words.ts): never the name heard in what goes", async () => {
    // Kept in its message: not your words for Rowan, so your own go, the name heard cut.
    const kept = await run(SAID, { router: () => [{ name: "ask_session", session: S("Rowan"), message: SAID }] });
    assert.deepEqual(kept.outcomes, [{ action: "send", to: "Rowan", text: SENT, via: "terminal", unsure: true }]);
    // Left out: the router's message goes as written, nothing more cut from it.
    const left = await run(SAID, { router: () => [{ name: "ask_session", session: S("Rowan"), message: SENT }] });
    assert.equal(left.outcomes[0].action, "ask");
    assert.equal(left.outcomes[0].action === "ask" && left.outcomes[0].message, SENT);
  });
  test("the direction around a name heard wrong comes off as around the name (relay, direction.ts)", async () => {
    const said = "Ask, uh, Mint box, um, whether the crash is fixed in the dev build.";
    const { d, outcomes } = await run(said, { router: to("mintbox") });
    assert.equal(d.heardAs?.sessionId, S("mintbox").sessionId);
    assert.deepEqual(outcomes, [{ action: "send", to: "mintbox", text: "Is the crash fixed in the dev build?", via: "terminal" }]);
  });
  test("a name in words still wins, with no hint: 'To mintbox, …'", async () => {
    const { seen, outcomes } = await run("To mintbox, the voice test is next.", {});
    assert.equal(seen.routes, 0);
    assert.equal(outcomes[0].action === "send" && outcomes[0].to, "mintbox");
  });
});

// Your words that went to the Kiko project, and "No, cancel that." took back (deliver.ts undo).
const CANCELLED: Sent = { sessionId: S("Kiko project").sessionId, folder: "Kiko project", text: SAID, undone: true };
const AFTER_CANCEL = [`you → Kiko project: ${SAID}`, "you → app: No, cancel that.", "app said: Interrupted Kiko project's current turn. Anything it started in the background keeps running."];

describe("step 3: 'That was too rowing, not to Kiko.' after the cancel", () => {
  const CORRECTION = "That was too rowing, not to Kiko.";
  const opts = {
    lastSent: CANCELLED,
    recent: AFTER_CANCEL,
    lastId: S("Kiko project").sessionId,
    classifier: { audience: "Rowan", audienceConfidence: 0.57, intent: "redirect" as const, intentConfidence: 0.35 },
  };

  test("the router's resend_to the Kiko project (where it went): resent to Rowan instead, the name heard cut", async () => {
    const { d, outcomes } = await run(CORRECTION, { ...opts, router: () => [{ name: "resend_to", session: S("Kiko project") }] });
    assert.equal(d.correction, true);
    assert.deepEqual(outcomes, [{ action: "resend", to: "Rowan", text: SENT, via: "terminal", unsure: true }]);
  });
  test("the router's resend_to Rowan: the same", async () => {
    const { outcomes } = await run(CORRECTION, { ...opts, router: () => [{ name: "resend_to", session: S("Rowan") }] });
    assert.deepEqual(outcomes, [{ action: "resend", to: "Rowan", text: SENT, via: "terminal", unsure: true }]);
  });
  test("the classifier sure it's a correction: resent to Rowan in code", async () => {
    const { seen, outcomes } = await run(CORRECTION, { ...opts, classifier: { ...opts.classifier, intentConfidence: 0.9 } });
    assert.equal(seen.routes, 0);
    assert.deepEqual(outcomes, [{ action: "resend", to: "Rowan", text: SENT, via: "terminal" }]);
  });
  test("resend_to where it went, and the words name nobody else: the app asks which", async () => {
    const { outcomes } = await run("No, wrong one.", { ...opts, router: () => [{ name: "resend_to", session: S("Kiko project") }] });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "That went to Kiko project, and you cancelled it. Which session was it for?" }]);
  });
  test("resend_to where it went, the words naming another: there", async () => {
    const { outcomes } = await run("Not to Kiko, that was for Bobby.", { ...opts, router: () => [{ name: "resend_to", session: S("Kiko project") }] });
    assert.equal(outcomes[0].action === "resend" && outcomes[0].to, "Bobby");
  });
  test("its answer, 'Rowan.' or 'too rowing': resent there, read in code", async () => {
    const asked = [...AFTER_CANCEL, "you → app: No, wrong one.", "app said: That went to Kiko project, and you cancelled it. Which session was it for?"];
    for (const said of ["Rowan.", "Too rowing.", "The Rowan one, please."]) {
      const { seen, outcomes } = await run(said, { ...opts, recent: asked, appAsked: true });
      assert.equal(seen.routes, 0, said);
      assert.equal(outcomes[0].action === "resend" && outcomes[0].to, "Rowan", said);
    }
  });
  test("'Never mind.' to that question: nothing more is taken back", async () => {
    const asked = [...AFTER_CANCEL, "you → app: No, wrong one.", "app said: That went to Kiko project, and you cancelled it. Which session was it for?"];
    const { d } = await run("Never mind.", { ...opts, recent: asked, appAsked: true });
    assert.deepEqual(
      d.actions.map((a) => a.type),
      ["wrap_up"],
    );
  });
  test("never mind and the correction in one breath: resent there", async () => {
    const sent: Sent = { sessionId: S("Kiko project").sessionId, folder: "Kiko project", text: SAID };
    const { outcomes } = await run("Never mind, that was for Rowan.", {
      lastSent: sent,
      recent: [`you → Kiko project: ${SAID}`],
      classifier: { audience: "Rowan", audienceConfidence: 0.6, intent: "redirect", intentConfidence: 0.9 },
    });
    assert.deepEqual(outcomes, [{ action: "resend", to: "Rowan", text: SENT, via: "terminal" }]);
  });
});

describe("a correction back to where it went, with no cancel: still never as is", () => {
  const sent: Sent = { sessionId: S("mintbox").sessionId, folder: "mintbox", text: "Run the voice test." };
  test("words that name nobody else: asked", async () => {
    const { outcomes } = await run("No, that was supposed to go somewhere else.", { lastSent: sent, router: () => [{ name: "resend_to", session: S("mintbox") }] });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "That already went to mintbox. Which session was it for?" }]);
  });
  test("a session named after 'not' is never where it goes: asked", async () => {
    const { outcomes } = await run("No, not Bobby, the other one.", { lastSent: sent, router: () => [{ name: "resend_to", session: S("mintbox") }] });
    assert.deepEqual(outcomes, [{ action: "ask_user", text: "That already went to mintbox. Which session was it for?" }]);
  });
  test("words that name another session: there", async () => {
    const { outcomes } = await run("No, not mintbox, that was for Bobby.", { lastSent: sent, router: () => [{ name: "resend_to", session: S("mintbox") }] });
    assert.deepEqual(outcomes, [{ action: "resend", to: "Bobby", text: "Run the voice test.", via: "terminal" }]);
  });
});
