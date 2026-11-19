// Three ways words reached the wrong session, or the right one with the wrong words, found by the
// relay eval (tests/eval/relay/, baseline 2026-11-07):
//
// 1. Two sessions in one sentence: "Tell Harbor to deploy and tell Atlas to tag the release v3.2.0."
//    all went to Harbor, Atlas's part included (sessions.ts splitBySession, decide.ts "split").
// 2. Words said to the app by name went on to the session: "…, and Kiko, slow down when you read the
//    results", "Thanks Kiko." (routing-rules.ts namesSaidToApp, trim.ts removeParts, decide.ts send).
// 3. Questions to the app about a session were typed into it: "Hey Kiko, what's the status for
//    MintBox?", "Is Harbor still deploying?" (sessions.ts askedAbout, decide.ts "about", the router's
//    <asks_you_about>).
import "../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type Act, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { setSpokenName } from "../../../src/core/name.ts";
import type { Action } from "../../../src/core/router.ts";
import { aboutAppBehaviour, appLeftOff, namesSaidToApp, startsSaidToApp } from "../../../src/core/routing-rules.ts";
import { addressedTo, askedAbout, type Session, splitBySession } from "../../../src/core/sessions.ts";
import { isTrimOf, removeParts, type Trim, withNameSaid } from "../../../src/core/trim.ts";
import { tokens } from "../../../src/core/words.ts";
import { makeWorld } from "../../support/fixtures.ts";

// The relay eval's sessions: neutral ones, and the user's own.
const W = makeWorld([
  { name: "atlas", title: "Checkout flow refactor", status: "idle", activeAgoS: 90, said: "I split the checkout form into three steps." },
  { name: "harbor", title: "Staging deploy pipeline", status: "busy", activeAgoS: 30, said: "The staging deploy is running." },
  { name: "juniper", title: "iOS onboarding screens", status: "idle", activeAgoS: 300, said: "The onboarding screens are done. Want me to test them on a device?" },
  { name: "orbit", title: "Billing webhooks", status: "idle", activeAgoS: 1200 },
  { name: "mintbox", title: "Mintbox developer certificate renewal", status: "idle", activeAgoS: 600, said: "I've pushed main to origin." },
  { name: "kiko-dev", folder: "kiko", given: "kiko-dev", title: "Attach error in a new tab", status: "idle", activeAgoS: 120 },
  { name: "Bobby", folder: "2026-01-20-internal", given: "Bobby", status: "idle", activeAgoS: 900 },
  { name: "pixie", title: "Pixie landing page", status: "idle", activeAgoS: 1500 },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const nameOf = (id: string) => [...W.byName].find(([, x]) => x.sessionId === id)?.[0];

/** Each part as [session, text]. */
const parts = (said: string, first: Session | null = null) => {
  const r = splitBySession(W.sessions, said, first);
  return r && "parts" in r ? r.parts.map((p) => [nameOf(p.session.sessionId), p.text]) : r;
};

/** Whether `kept` is words of `said`, in order: deletion only. */
const deletionOf = (said: string, kept: string) => {
  const from = tokens(said).map((t) => t.word);
  let i = 0;
  for (const w of tokens(kept).map((t) => t.word)) {
    while (i < from.length && from[i] !== w) i++;
    if (i++ === from.length) return false;
  }
  return true;
};

type Stub = {
  classifier?: { audience: string; confidence: number };
  router?: (s: (name: string) => Session) => Action[];
  routerSays?: string;
  /** The trim model's picks for the words it's given; none: it picks nothing. */
  trim?: (text: string) => string[];
};

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen = { classifier: 0, router: 0, about: [] as string[][], trims: [] as string[] };
  const deps: DecideDeps = {
    utterance: async (): Promise<UtteranceDecision> => {
      seen.classifier++;
      const c = opts.classifier ?? { audience: "app", confidence: 0.3 };
      return {
        audience: c.audience === "app" ? "app" : S(c.audience),
        audienceConfidence: c.confidence,
        intent: "message",
        intentConfidence: 1,
        appParts: 0.1,
        model: "test",
        costUsd: 0,
        ms: 1,
      };
    },
    approval: null,
    route: async (input) => {
      seen.router++;
      seen.about.push((input.about ?? []).map((x) => nameOf(x.sessionId)!));
      const actions = opts.router?.(S) ?? [];
      return { text: opts.routerSays ?? "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    // As trimForClaude checks the model's picks, with the picks given.
    trim: async ({ text: t }): Promise<Trim> => {
      seen.trims.push(t);
      const picks = (opts.trim?.(t) ?? []).map((p) => withNameSaid(t, p)).filter(startsSaidToApp);
      const cut = picks.length ? removeParts(t, picks) : null;
      return cut && isTrimOf(t, cut.text) ? { ...cut, costUsd: 0, ms: 1 } : { text: t, dropped: [], costUsd: 0, ms: 1 };
    },
  };
  const { classifier: _c, router: _r, routerSays: _s, trim: _t, ...rest } = opts;
  const state: DecideState = {
    text,
    sessions: W.sessions,
    notes: W.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...rest,
  };
  const d = await decide(state, deps);
  return { d, seen };
}

/** Each send as [to, text]. */
const sent = (actions: Act[]) => actions.flatMap((a) => (a.type === "send" ? [[nameOf(a.session.sessionId), a.text]] : []));

describe("1. two sessions in one sentence: each gets its own part, cut from what was said", () => {
  test("'tell X to … and tell Y to …', 'tell X to … and Y to …', a new sentence to Y: one part each", () => {
    assert.deepEqual(parts("Tell Harbor to deploy and tell Atlas to tag the release v3.2.0."), [
      ["harbor", "Deploy."],
      ["atlas", "Tag the release v3.2.0."],
    ]);
    assert.deepEqual(parts("Tell Mintbox to add the export button and Pixie to update the screenshots."), [
      ["mintbox", "Add the export button."],
      ["pixie", "Update the screenshots."],
    ]);
    assert.deepEqual(parts("Tell Harbor to roll back. Atlas, hold the release."), [
      ["harbor", "Roll back."],
      ["atlas", "Hold the release."],
    ]);
    assert.deepEqual(parts("Tell Kikodev to restart and, uh, tell Bobby to check the backups, then ask Juniper whether the screens are done."), [
      ["kiko-dev", "Restart."],
      ["bobby", "Check the backups."],
      ["juniper", "Ask Juniper whether the screens are done."],
    ]);
  });

  test("one direction to several by name: each gets the rest", () => {
    assert.deepEqual(parts("Tell Atlas and Harbor to pull main."), [
      ["atlas", "Pull main."],
      ["harbor", "Pull main."],
    ]);
  });

  test("a part said another way goes as it would alone ('Ask Atlas whether …' isn't rewritten)", () => {
    assert.deepEqual(parts("Ask Atlas whether the tests pass and tell Harbor to deploy."), [
      ["atlas", "Ask Atlas whether the tests pass."],
      ["harbor", "Deploy."],
    ]);
  });

  test("every part is a deletion of what was said", () => {
    for (const said of [
      "Tell Harbor to deploy and tell Atlas to tag the release v3.2.0.",
      "Tell Mintbox to add the export button and Pixie to update the screenshots.",
      "Tell Harbor to roll back. Atlas, hold the release.",
    ]) {
      const r = splitBySession(W.sessions, said);
      assert.ok(r && "parts" in r);
      for (const p of r.parts) assert.ok(deletionOf(said, p.text), `${p.text} from ${said}`);
    }
  });

  test("one session's words that only mention another aren't split", () => {
    for (const said of [
      "Tell Bobby that MintBox already fixed the cert.",
      "Tell Harbor to deploy what Atlas just merged.",
      "Tell Juniper that Orbit changed the webhook format, so the app needs updating.",
      "Tell Orbit to send the webhook to the staging URL, not to Harbor's preview.",
      "Tell Atlas to compare Juniper and Orbit to see which is faster.",
      "Ask Bobby and Kikodev if either of them changed the SSH config.",
      "Tell Atlas to run the tests, and Kiko, slow down when you read the results.",
      "Do it the way Atlas did the checkout, same pattern.",
      "Keep it. And for Atlas's tests, leave them as they are.",
      "Tell Juniper to use the same pattern. Atlas, for example, did it that way.",
    ]) {
      assert.equal(splitBySession(W.sessions, said), null, said);
    }
  });

  test("a first part that names no session: the waiting one's reply; with none waiting, unclear", () => {
    assert.deepEqual(parts("Merge it, and tell Harbor to deploy. Then tell Atlas to tag it.", S("juniper")), [
      ["juniper", "Merge it."],
      ["harbor", "Deploy."],
      ["atlas", "Tag it."],
    ]);
    const r = splitBySession(W.sessions, "Merge it, and tell Harbor to deploy. Then tell Atlas to tag it.");
    assert.ok(r && "unclear" in r);
    assert.deepEqual(r.unclear.map((x) => nameOf(x.sessionId)).sort(), ["atlas", "harbor"]);
  });

  test("a part with nothing in it: unclear", () => {
    const r = splitBySession(W.sessions, "Tell Harbor to and tell Atlas to tag it.");
    assert.ok(r && "unclear" in r);
  });

  test("decide: each part sent to its session as a send of its own, no model asked", async () => {
    const { d, seen } = await run("Tell Harbor to deploy and tell Atlas to tag the release v3.2.0.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.equal(d.step, "split");
    assert.deepEqual(sent(d.actions), [
      ["harbor", "Deploy."],
      ["atlas", "Tag the release v3.2.0."],
    ]);
    assert.ok(d.actions.every((a) => a.type === "send" && !a.unsure && a.trimmed?.by === "phrase"));
    assert.equal(seen.classifier, 0);
    assert.equal(seen.router, 0);
  });

  test("decide: the waiting session's part is its reply, the other's typed in", async () => {
    const { d } = await run("Yes, and tell Harbor to deploy.", { waiting: { sessionId: S("juniper").sessionId, cwd: S("juniper").cwd } });
    assert.deepEqual(sent(d.actions), [
      ["juniper", "Yes."],
      ["harbor", "Deploy."],
    ]);
  });

  test("decide: words that don't cut cleanly go nowhere, and the app asks for each one's part", async () => {
    const { d, seen } = await run("Tell Harbor to and tell Atlas to tag it.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.equal(d.step, "split");
    assert.deepEqual(sent(d.actions), []);
    const say = d.actions[0];
    assert.ok(say.type === "say" && say.why === "split_unclear" && /harbor and atlas/i.test(say.text), JSON.stringify(say));
    assert.equal(seen.router, 0);
  });

  test("decide: one session's words that mention another go to it, whole", async () => {
    const { d } = await run("Tell Bobby that MintBox already fixed the cert.");
    assert.equal(d.step, "addressed");
    assert.deepEqual(sent(d.actions), [["bobby", "MintBox already fixed the cert."]]);
  });
});

describe("2. words said to the app by its name aren't passed on", () => {
  afterEach(() => setSpokenName("Kiko"));

  test("the name said to it: after a pause or 'and', 'thanks', 'hold on', or at the end", () => {
    for (const said of [
      "Run the tests, and Kiko, slow down when you read the results.",
      "Run the tests and Kiko, slow down when you read the results.",
      "Roll back. Thanks Kiko.",
      "Make the button bigger, Kiko, you don't need to read back the reply.",
      "Which screens are done? Kiko, read me just the summary.",
      "Ask Orbit, hold on Kiko, let me think, which events it retries.",
      "Check the overlay, Kiko.",
    ]) {
      assert.equal(namesSaidToApp(said).length, 1, said);
    }
  });

  test("the name as what the work is about isn't said to it", () => {
    for (const said of [
      "The Kiko overlay doesn't show the latest text.",
      "Make Kiko's bars wider.",
      "Restart Kiko, then check the logs.",
      "Kiko-dev, check the logs.",
      "Fix the crash in Kiko.",
      "I restarted Kiko and it still shows the old text.",
    ]) {
      assert.deepEqual(namesSaidToApp(said), [], said);
    }
    assert.equal(startsSaidToApp("the Kiko overlay"), false);
    assert.equal(startsSaidToApp("make Kiko's bars wider"), false);
  });

  test("the name is the setting's, not a fixed word", () => {
    setSpokenName("Jarvis");
    assert.equal(namesSaidToApp("Roll back. Thanks Jarvis.").length, 1);
    assert.equal(namesSaidToApp("The Jarvis overlay is broken.").length, 0);
    assert.ok(startsSaidToApp("and Jarvis, slow down"));
  });

  test("removeParts: a part said to the app may be short, and hold a negation that ends its sentence", () => {
    assert.deepEqual(removeParts("Roll back. Thanks Kiko.", ["Thanks Kiko."])?.text, "Roll back.");
    assert.deepEqual(removeParts("Make the button bigger, Kiko, you don't need to read back the reply.", ["Kiko, you don't need to read back the reply"])?.text, "Make the button bigger");
    // Picked from the name on: the "and" before it goes too.
    assert.deepEqual(removeParts("Run the tests, and Kiko, slow down when you read the results.", ["Kiko, slow down when you read the results"])?.text, "Run the tests");
    // A negation that goes on past the part stays: only the name goes.
    assert.equal(removeParts("Kiko, don't deploy, just build it.", ["Kiko, don't deploy"])?.text, "Don't deploy, just build it.");
    // The negation rule is as it was for anything else.
    assert.equal(removeParts("Don't run it, for the clipkit one", ["Don't run it"]), null);
  });

  test("withNameSaid: a part picked right after the name gets the name with it", () => {
    const said = "Make the button bigger, Kiko, you don't need to read back the reply.";
    assert.equal(withNameSaid(said, "you don't need to read back the reply"), "Kiko, you don't need to read back the reply");
    assert.equal(withNameSaid(said, "make the button bigger"), "make the button bigger");
  });

  test("decide: after 'Tell Atlas to', the part said to the app is cut too (in code since 2026-11-16: appWordsOff)", async () => {
    const { d, seen } = await run("Tell Atlas to run the tests, and Kiko, slow down when you read the results.", {
      trim: () => ["and Kiko, slow down when you read the results"],
    });
    assert.deepEqual(sent(d.actions), [["atlas", "Run the tests."]]);
    assert.deepEqual(seen.trims, []);
    const send = d.actions[0];
    assert.ok(send.type === "send" && send.trimmed?.dropped.includes("Tell Atlas to"));
  });

  test("appLeftOff: a thanks or the name at the very end, cut in code", () => {
    assert.deepEqual(appLeftOff("Roll back. Thanks Kiko."), { text: "Roll back.", dropped: "Thanks Kiko." });
    assert.deepEqual(appLeftOff("Run the tests, thank you Kiko!"), { text: "Run the tests.", dropped: "thank you Kiko!" });
    assert.deepEqual(appLeftOff("Check the overlay, Kiko."), { text: "Check the overlay.", dropped: "Kiko." });
    for (const said of ["Make it look like Kiko.", "Thanks Kiko.", "Rename it to Kiko.", "Ship it. Thanks Kikodev."]) assert.equal(appLeftOff(said), null, said);
  });

  test("decide: 'Thanks Kiko.' at the end goes even when the trim finds nothing", async () => {
    const { d, seen } = await run("Tell Harbor to roll back. Thanks Kiko.");
    assert.deepEqual(sent(d.actions), [["harbor", "Roll back."]]);
    assert.deepEqual(seen.trims, []);
  });

  test("decide: 'Thanks Kiko.' and 'Kiko, you don't need to read back the reply' aren't sent", async () => {
    assert.deepEqual(sent((await run("Tell Harbor to roll back. Thanks Kiko.", { trim: () => ["Thanks Kiko."] })).d.actions), [["harbor", "Roll back."]]);
    const dont = await run("Tell Pixie to make the button bigger, Kiko, you don't need to read back the reply.", { trim: () => ["Kiko, you don't need to read back the reply"] });
    assert.deepEqual(sent(dont.d.actions), [["pixie", "Make the button bigger."]]);
  });

  test("decide: Kiko as content stays, and the trim isn't even asked", async () => {
    const { d, seen } = await run("Tell kiko-dev that the Kiko overlay doesn't show the latest text.", { trim: () => ["the Kiko overlay"] });
    assert.deepEqual(sent(d.actions), [["kiko-dev", "The Kiko overlay doesn't show the latest text."]]);
    assert.deepEqual(seen.trims, []);
    const bars = await run("Tell kiko-dev to make Kiko's bars wider.", { trim: () => ["make Kiko's bars wider"] });
    assert.deepEqual(sent(bars.d.actions), [["kiko-dev", "Make Kiko's bars wider."]]);
  });

  test("decide: a model pick of content after the name is refused", async () => {
    // Said to the app, then work for kiko-dev: a pick that isn't said to the app isn't cut.
    const { d } = await run("Tell kiko-dev to restart Kiko, then check the logs.", { trim: () => ["restart Kiko"] });
    assert.deepEqual(sent(d.actions), [["kiko-dev", "Restart Kiko, then check the logs."]]);
  });
});

describe("2b. a 'don't' said after the app's name: dropped only when it's about the app itself", () => {
  test("aboutAppBehaviour: reading out, voice, speed, listening, waiting; not the session's work", () => {
    for (const part of [
      "Kiko, you don't need to read back the reply",
      "Kiko, don't read the whole log out loud",
      "Kiko, don't speak so fast",
      "Kiko, don't wait for it",
      "Kiko, don't listen to that",
    ]) {
      assert.ok(aboutAppBehaviour(part), part);
    }
    for (const part of ["Kiko, don't change the colours", "Kiko, don't push yet", "Kiko, never touch the config", "Kiko, don't delete the branch"]) {
      assert.equal(aboutAppBehaviour(part), false, part);
    }
  });

  test("removeParts: a 'don't' about something else stays in the message; only the name goes", () => {
    assert.equal(removeParts("Make the button bigger, Kiko, don't change the colours.", ["Kiko, don't change the colours"])?.text, "Make the button bigger, don't change the colours.");
    assert.equal(removeParts("Push the branch. Kiko, don't merge it yet.", ["Kiko, don't merge it yet."])?.text, "Push the branch. Don't merge it yet.");
    // About the app itself, to the end of its sentence: the whole part goes.
    assert.equal(removeParts("Run the migration, and Kiko, don't read the whole log out loud.", ["and Kiko, don't read the whole log out loud"])?.text, "Run the migration");
  });

  test("decide: Pixie keeps 'don't change the colours'", async () => {
    const { d } = await run("Tell Pixie to make the button bigger, Kiko, don't change the colours.", { trim: () => ["Kiko, don't change the colours"] });
    assert.deepEqual(sent(d.actions), [["pixie", "Make the button bigger, don't change the colours."]]);
  });

  test("decide: 'don't read it out loud' to the app is left out", async () => {
    const { d } = await run("Tell Atlas to run the migration, and Kiko, don't read the whole log out loud.", { trim: () => ["and Kiko, don't read the whole log out loud"] });
    assert.deepEqual(sent(d.actions), [["atlas", "Run the migration."]]);
  });
});

describe("a hyphen inside a session's name isn't a pause after part of it", () => {
  test("addressedTo: 'tell kiko-dev the overlay …' isn't 'tell kiko', pause, 'dev the overlay …'", () => {
    const a = addressedTo(W.sessions, "Tell kiko-dev the overlay came back.");
    assert.ok(!a || !/^dev\b/i.test(a.rest), JSON.stringify(a));
    assert.equal(addressedTo(W.sessions, "Tell kiko-dev, the overlay came back.")?.rest, "The overlay came back.");
    assert.equal(addressedTo(W.sessions, "Tell kiko-dev that the overlay came back.")?.rest, "The overlay came back.");
    // A hyphen standing apart is still a pause.
    assert.equal(addressedTo(W.sessions, "Atlas - check the build.")?.rest, "Check the build.");
    assert.equal(addressedTo(W.sessions, "Atlas -- check the build.")?.rest, "Check the build.");
  });

  test("decide: the words reach kiko-dev with nothing of its name cut into them", async () => {
    const { d } = await run("Tell kiko-dev the overlay came back.", { classifier: { audience: "kiko-dev", confidence: 0.95 } });
    assert.equal(sent(d.actions)[0]?.[0], "kiko-dev");
    assert.ok(!/^dev\b/i.test(String(sent(d.actions)[0]?.[1])), JSON.stringify(sent(d.actions)));
  });
});

describe("3. questions to the app about a session are answered, not sent there", () => {
  test("askedAbout: third-person questions about a named session", () => {
    const about = (said: string) => askedAbout(W.sessions, said).map((x) => nameOf(x.sessionId));
    assert.deepEqual(about("Is Harbor still deploying?"), ["harbor"]);
    assert.deepEqual(about("What's the status for MintBox?"), ["mintbox"]);
    assert.deepEqual(about("What was the finding on MintBox? What did it tell me the issue was?"), ["mintbox"]);
    assert.deepEqual(about("What did MintBox say the issue was?"), ["mintbox"]);
    assert.deepEqual(about("Has Atlas finished?"), ["atlas"]);
    assert.deepEqual(about("Is Harbor's deploy done?"), ["harbor"]);
    assert.deepEqual(about("How's Juniper doing?"), ["juniper"]);
  });

  test("askedAbout: not a question said to the session, a request, or a question about its product", () => {
    for (const said of [
      "Bobby, are you still deploying?",
      "MintBox, what was the issue?",
      "Can MintBox check the logs?",
      "Ask Harbor if it's done.",
      "Is MintBox crashing on launch?",
      "Did the build pass?",
    ]) {
      assert.deepEqual(askedAbout(W.sessions, said), [], said);
    }
  });

  test("decide: 'Is Harbor still deploying?' goes to the router as a question about Harbor, not to Harbor", async () => {
    const { d, seen } = await run("Is Harbor still deploying?", {
      classifier: { audience: "harbor", confidence: 0.95 },
      routerSays: "Yes, Harbor's staging deploy is still running.",
    });
    assert.equal(d.step, "about");
    assert.deepEqual(seen.about, [["harbor"]]);
    assert.equal(seen.classifier, 0);
    assert.deepEqual(sent(d.actions), []);
    assert.deepEqual(d.actions, [{ type: "say", text: "Yes, Harbor's staging deploy is still running." }]);
  });

  test("decide: 'Hey Kiko, what's the status for MintBox?' is the app's to answer", async () => {
    const { d, seen } = await run("Hey Kiko, what's the status for MintBox?", { classifier: { audience: "mintbox", confidence: 0.95 }, routerSays: "MintBox pushed main to origin." });
    assert.equal(d.step, "about");
    assert.deepEqual(seen.about, [["mintbox"]]);
    assert.deepEqual(sent(d.actions), []);
  });

  test("decide: a question with the app's name up front about a session, in any words", async () => {
    const { d, seen } = await run("Kiko, does MintBox know about the cert?", { routerSays: "I don't know. Want me to ask MintBox?" });
    assert.equal(d.step, "about");
    assert.deepEqual(seen.about, [["mintbox"]]);
    // The offer in words is kept as one: a yes sends the question there.
    assert.equal(d.question?.kind, "asked");
    assert.ok(d.question?.kind === "asked" && d.question.question.offer && d.question.question.text === "Does MintBox know about the cert?");
  });

  test("decide: the router's pass_on for it becomes the offer to ask, never a send", async () => {
    const { d } = await run("Is Harbor still deploying?", { router: (s) => [{ name: "pass_on", session: s("harbor") }] });
    assert.deepEqual(sent(d.actions), []);
    assert.deepEqual(d.actions, [{ type: "say", text: "Want me to ask harbor?", why: "offer_session" }]);
    assert.ok(d.question?.kind === "asked" && d.question.question.offer);
    assert.deepEqual(
      d.guards?.map((g) => g.rule),
      ["asked_about"],
    );
  });

  test("decide: a question said to the session goes there", async () => {
    for (const [said, to, text] of [
      ["Bobby, are you still deploying?", "bobby", "Are you still deploying?"],
      ["MintBox, what was the issue?", "mintbox", "What was the issue?"],
    ]) {
      const { d, seen } = await run(said);
      assert.equal(d.step, "addressed", said);
      assert.deepEqual(sent(d.actions), [[to, text]]);
      assert.equal(seen.router, 0);
    }
  });

  test("decide: replies to the waiting session stay its replies, as said", async () => {
    const waiting = { sessionId: S("harbor").sessionId, cwd: S("harbor").cwd };
    for (const said of ["Go ahead, but only on staging.", "Is it safe to deploy now?", "Harbor, no. Wait until I'm back."]) {
      const { d } = await run(said, { waiting, classifier: { audience: "harbor", confidence: 0.95 } });
      assert.notEqual(d.step, "about", said);
      assert.equal(sent(d.actions)[0]?.[0], "harbor", said);
    }
  });

  test("decide: 'Kiko, can MintBox check the logs?' asks for work: not a question about it", async () => {
    const { d } = await run("Kiko, can MintBox check the logs?", { classifier: { audience: "mintbox", confidence: 0.95 } });
    assert.equal(d.step, "classifier");
    assert.deepEqual(sent(d.actions), [["mintbox", "Can MintBox check the logs?"]]);
  });
});
