// The direction to a session taken off in code once it's known where the words go, and reported
// speech made direct where that's mechanical (src/core/direction.ts, src/core/direct-speech.ts).
// The relay eval's failures (tests/eval/relay/, 2026-11-16): "Ask MintBox, …" arrived whole.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imperative, keepsWords, statement, whQuestion, yesNoQuestion, youFor } from "../../../src/core/direct-speech.ts";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { type Act, type DecideDeps, type DecideState, decide } from "../../../src/core/decide.ts";
import { directionOff } from "../../../src/core/direction.ts";
import type { Action } from "../../../src/core/router.ts";
import { type Session, splitBySession } from "../../../src/core/sessions.ts";
import { removeParts } from "../../../src/core/trim.ts";
import { makeWorld } from "../../support/fixtures.ts";

const W = makeWorld([
  { name: "atlas", title: "Checkout flow refactor", status: "idle", activeAgoS: 90 },
  { name: "harbor", title: "Staging deploy pipeline", status: "busy", activeAgoS: 30 },
  { name: "juniper", title: "iOS onboarding screens", status: "idle", activeAgoS: 300 },
  { name: "orbit", title: "Billing webhooks", status: "idle", activeAgoS: 1200 },
  { name: "mintbox", title: "Mintbox developer certificate renewal", status: "idle", activeAgoS: 600 },
  { name: "kiko-dev", folder: "kiko", given: "kiko-dev", title: "Attach error in a new tab", status: "idle", activeAgoS: 120 },
  { name: "Bobby", folder: "2026-11-02-internal", given: "Bobby", status: "idle", activeAgoS: 900 },
  { name: "pixie", title: "Pixie landing page", status: "idle", activeAgoS: 1500 },
  { name: "tests", title: "Test runner", status: "idle", activeAgoS: 2000 },
]);
const S = (name: string) => W.byName.get(name.toLowerCase())!;
const off = (text: string, to: string) => directionOff(text, S(to))?.text ?? null;

describe("directionOff: a direction up front", () => {
  const cases: Array<[string, string, string]> = [
    ["Ask MintBox, what do I have to do to rotate the API key that's expiring?", "mintbox", "What do I have to do to rotate the API key that's expiring?"],
    ["Ask Atlas, why does the checkout test fail on the second step?", "atlas", "Why does the checkout test fail on the second step?"],
    ["To Harbor: pause the staging deploy until I say so.", "harbor", "Pause the staging deploy until I say so."],
    ["Hey Bobby, can you check if the nightly backup job finished?", "Bobby", "Can you check if the nightly backup job finished?"],
    ["Hey Juniper, run the onboarding screens on my iPhone 17 instead of the simulator.", "juniper", "Run the onboarding screens on my iPhone 17 instead of the simulator."],
    ["For Pixie, the hero image should be 1440 pixels wide, not 1200.", "pixie", "The hero image should be 1440 pixels wide, not 1200."],
    ["Okay Harbor, roll back the last deploy.", "harbor", "Roll back the last deploy."],
    ["Hey, uh, Kiko Dev, can we move the status dot to the right?", "kiko-dev", "Can we move the status dot to the right?"],
    ["Hey Kikodev, what do you think about a darker sidebar?", "kiko-dev", "What do you think about a darker sidebar?"],
    ["Ask Bobby, does the photo backup still run at 3 a.m.?", "Bobby", "Does the photo backup still run at 3 a.m.?"],
    ["To MintBox, uh, did the crash fix go out in the last release?", "mintbox", "Did the crash fix go out in the last release?"],
    ["This is for Kikodev. If you open the last test run, you'll see it.", "kiko-dev", "If you open the last test run, you'll see it."],
    ["Send this to Juniper: the App Store screenshots need the new tagline.", "juniper", "The App Store screenshots need the new tagline."],
    ["Hey uh Harbor um the uh staging uh thing is down again can you uh look", "harbor", "The uh staging uh thing is down again can you uh look"],
    ["Message for Harbor: the database migration finished, you can continue the deploy.", "harbor", "The database migration finished, you can continue the deploy."],
  ];
  for (const [said, to, want] of cases) test(said, () => assert.equal(off(said, to), want));
});

describe("directionOff: reported speech made direct", () => {
  const cases: Array<[string, string, string]> = [
    ["Tell Bobby to restart the server.", "Bobby", "Restart the server."],
    ["Tell Harbor not to push yet.", "harbor", "Don't push yet."],
    ["Tell Orbit to never retry a refund automatically.", "orbit", "Never retry a refund automatically."],
    ["Can you tell Bobby to restart the server?", "Bobby", "Restart the server?"],
    ["Uh, so, um, tell Harbor, like, to, uh, wait on the deploy, I guess, until, uh, I check the logs.", "harbor", "Wait on the deploy, I guess, until, uh, I check the logs."],
    ["Let Harbor know the DNS change is live.", "harbor", "The DNS change is live."],
    ["Tell Atlas it can merge once CI passes.", "atlas", "You can merge once CI passes."],
    ["Tell Harbor it shouldn't deploy on Fridays.", "harbor", "You shouldn't deploy on Fridays."],
    ["Tell Kikodev I tried the new layout and it looks fine.", "kiko-dev", "I tried the new layout and it looks fine."],
    ["Tell Rowan that I signed the build.".replace("Rowan", "Pixie"), "pixie", "I signed the build."],
    ["Tell Atlas no, don't use a modal, use a new page instead.", "atlas", "No, don't use a modal, use a new page instead."],
    ["Tell Kikodev don't tag it yet, just push the branch.", "kiko-dev", "Don't tag it yet, just push the branch."],
    ["Tell Atlas to ask me before it deletes anything.", "atlas", "Ask me before you delete anything."],
    ["Tell MintBox that Bobby will handle the SSH config, so it can skip that.", "mintbox", "Bobby will handle the SSH config, so you can skip that."],
    ["Tell Bobby that MintBox already fixed the cert.", "Bobby", "MintBox already fixed the cert."],
    ["Tell Harbor that it was a mistake, sorry.", "harbor", "It was a mistake, sorry."],
    ["Go ahead and tell the MintBox session to update the docs.", "mintbox", "Update the docs."],
    ["Tell the deploy session to wait.", "harbor", "Wait."],
    ["Tell it to commit.", "harbor", "Commit."],
    ["Tell that one to try again.", "pixie", "Try again."],
    ["Tell the other one to go ahead with the deploy.", "harbor", "Go ahead with the deploy."],
    ["Ask everyone to commit their work.", "atlas", "Commit your work."],
    ["Check with Pixie if the new logo is in the repo yet.", "pixie", "Is the new logo in the repo yet?"],
    ["Ask Rowan if the migration is still running.".replace("Rowan", "Atlas"), "atlas", "Is the migration still running?"],
    ["Ask Orbit how it plans to handle refunds.", "orbit", "How do you plan to handle refunds?"],
    ["Ask Bobby what it needs from me to finish the backup setup.", "Bobby", "What do you need from me to finish the backup setup?"],
    ["Ask Atlas what it thinks should be next.", "atlas", "What do you think should be next?"],
    ["Ask Orbit what happens when a webhook arrives twice.", "orbit", "What happens when a webhook arrives twice?"],
    ["Could you ask Juniper what the test coverage is now?", "juniper", "What is the test coverage now?"],
    ["Ask Orbit what the HTTP status is when the signature check fails, 400 or 401?", "orbit", "What is the HTTP status when the signature check fails, 400 or 401?"],
    ["Ask the other session what it's working on.", "juniper", "What are you working on?"],
    ["Ask both what they're doing.", "atlas", "What are you doing?"],
    ["Ask Orbit if it can tell Atlas's tests apart from its own in CI.", "orbit", "Can you tell Atlas's tests apart from your own in CI?"],
    [
      "Ask MintBox if it's possible to export the icons as SVG. Tell it to not start yet, just tell me if it's doable.",
      "mintbox",
      "Is it possible to export the icons as SVG? Don't start yet, just tell me if it's doable.",
    ],
    ["Ask MintBox about the cert.", "mintbox", "What about the cert?"],
    ["Ask Juniper which screens are done.", "juniper", "Which screens are done?"],
    ["Ask Pixie to tell me a short joke.", "pixie", "Tell me a short joke."],
    ["If it's done, tell Atlas to open a PR.", "atlas", "If it's done, open a PR."],
    ["Ask Atlas to change the timeout in src/checkout/config.ts from 30 to 45 seconds.", "atlas", "Change the timeout in src/checkout/config.ts from 30 to 45 seconds."],
    ["Ask Kikodev to run git log --oneline -5 on the main branch and read it to me.", "kiko-dev", "Run git log --oneline -5 on the main branch and read it to me."],
  ];
  for (const [said, to, want] of cases) test(said, () => assert.equal(off(said, to), want));
});

describe("directionOff: asides after the start", () => {
  const cases: Array<[string, string, string]> = [
    ["Can you check why the checkout total is off by a cent, this is for Atlas, I think it's rounding.", "atlas", "Can you check why the checkout total is off by a cent, I think it's rounding."],
    ["Pause the deploy for now, send that to Harbor.", "harbor", "Pause the deploy for now."],
    ["What's the retry limit on webhooks? For Orbit.", "orbit", "What's the retry limit on webhooks?"],
    ["Let's go with the smaller change. This is for Atlas.", "atlas", "Let's go with the smaller change."],
    ["Restart the dev server and, uh, this one's for Pixie, clear the cache first.", "pixie", "Restart the dev server and clear the cache first."],
    ["Look into why the fans spin up when recording videos, on MintBox.", "mintbox", "Look into why the fans spin up when recording videos."],
    ["Check the backup logs from last night, Bobby, and tell me if anything failed.", "Bobby", "Check the backup logs from last night, and tell me if anything failed."],
    ["Add a loading spinner to the pay button, uh, for the Atlas session, and disable it while it's loading.", "atlas", "Add a loading spinner to the pay button, and disable it while it's loading."],
    ["The build is failing on main. Harbor, that one's yours.", "harbor", "The build is failing on main. That one's yours."],
    ["Can you show me the diff, this is for Atlas by the way.", "atlas", "Can you show me the diff?"],
    ["Make the header sticky. To Pixie.", "pixie", "Make the header sticky."],
  ];
  for (const [said, to, want] of cases) test(said, () => assert.equal(off(said, to), want));
});

describe("directionOff: words that aren't a direction to that session stay whole", () => {
  const none: Array<[string, string]> = [
    ["Tell me why the build failed.", "harbor"],
    ["Tell me what you changed in the last commit.", "harbor"],
    ["Check with the API docs whether the endpoint supports pagination.", "orbit"],
    ["Ask me before you delete any files.", "atlas"],
    ["Okay, let's go with the second option.", "atlas"],
    ["Send that to staging when you're ready.", "harbor"],
    ["For the settings screen, it's only using part of the window.", "kiko-dev"],
    // Another session named, as content, to this one.
    ["Tell Bobby that MintBox already fixed the cert.", "mintbox"],
    ["Do it the way Atlas did the checkout, same pattern.", "juniper"],
    // A session named like an ordinary word: "tests" here is the tests, not the session.
    ["Run the tests again and tell me what failed.", "tests"],
    ["Tests are failing on main, can you look?", "tests"],
    ["Atlas, for example, did it that way.", "atlas"],
    // "it" mid-sentence with the session not named before: the work's "it", not a direction.
    ["When the agent is stuck, ask it to summarize its progress.", "atlas"],
    ["In onboarding, if the model fails, tell it to retry once.", "juniper"],
    // A place in the work named like the session: "in the tests", "for the tests".
    ["Add logging to the retry, in the tests.", "tests"],
    ["Write the fixtures first, for the tests, and then the cases.", "tests"],
  ];
  for (const [said, to] of none) test(said, () => assert.equal(off(said, to), null));
  test("a session named like a word, spoken to: its name goes", () => {
    assert.equal(off("Tests, run the suite again.", "tests"), "Run the suite again.");
  });
});

describe("directionOff: a name heard wrong, a list of names", () => {
  const offAll = (text: string, to: string) => {
    const r = directionOff(text, S(to), W.sessions);
    return (r?.indirect ? r.loose?.text : r?.text) ?? null;
  };
  test("after tell/ask or a greeting, a word close to its name is its name", () => {
    assert.equal(offAll("Tell Pixy to, uh, swap the hero image.", "pixie"), "Swap the hero image.");
    assert.equal(offAll("Hey Bobbie, can you, um, check the disk space?", "Bobby"), "Can you, um, check the disk space?");
  });
  test("…but not a word that isn't close, another session's name, nor the word alone", () => {
    assert.equal(offAll("Tell Pete to swap the hero image.", "pixie"), null);
    assert.equal(offAll("Tell Atlas to swap the hero image.", "pixie"), null);
    assert.equal(offAll("Pixy, swap the hero image.", "pixie"), null);
  });
  test("a list of names it's one of: the direction to all of them", () => {
    assert.equal(offAll("Ask Atlas and Orbit whether the refund flow uses the same endpoint.", "atlas"), "The refund flow uses the same endpoint?");
    assert.equal(offAll("Ask Atlas and Orbit whether the refund flow uses the same endpoint.", "pixie"), null);
  });
  test("a loose question keeps the rest of its sentence together", () => {
    assert.equal(offAll("Ask Kikodev why the reminder for Bobby went to the wrong list instead.", "kiko-dev"), "Why the reminder for Bobby went to the wrong list instead?");
    assert.equal(offAll("Ask MintBox whether the notarization went through. Then tell me.", "mintbox"), "The notarization went through? Then tell me.");
  });
});

describe("directionOff: not mechanical, left as said", () => {
  for (const said of ["Ask MintBox whether the notarization went through.", "Ask Orbit why handleWebhook throws on the invoice.paid event.", "Ask it if the tests pass."]) {
    test(said, () => {
      const to = said.includes("MintBox") ? "mintbox" : said.includes("Orbit") ? "orbit" : "atlas";
      const r = directionOff(said, S(to));
      assert.equal(r?.text, said);
      assert.equal(r?.indirect, true);
      assert.deepEqual(r?.dropped, []);
      assert.ok(r?.loose && r.loose.dropped.length);
    });
  }
});

describe("direct speech, piece by piece", () => {
  test("imperative", () => {
    assert.equal(imperative("restart the server."), "Restart the server.");
    assert.equal(imperative("push yet.", "not"), "Don't push yet.");
    assert.equal(imperative("not start yet."), "Don't start yet.");
  });
  test("statement: it → you only where it's the session", () => {
    assert.equal(statement("it can merge once CI passes."), "You can merge once CI passes.");
    assert.equal(statement("it was a mistake."), "It was a mistake.");
    assert.equal(statement("the build broke and it needs a fix."), "The build broke and it needs a fix.");
    assert.equal(statement("the deploy failed, so it can't go out today."), "The deploy failed, so you can't go out today.", "a modal after so: taken as the session (a known risk)");
  });
  test("youFor leaves a thing's it", () => {
    assert.equal(youFor("fix the build and push once it passes."), "fix the build and push once it passes.");
    assert.equal(youFor("merge it, if it works."), "merge it, if it works.");
    assert.equal(youFor("push the branch if it hasn't yet."), "push the branch if you haven't yet.");
    assert.equal(youFor("tell me when it's done."), "tell me when it's done.", "done may be the task's");
    assert.equal(youFor("so it's busy, wait."), "so you're busy, wait.");
    assert.equal(youFor("it's failing on main."), "it's failing on main.");
    assert.equal(youFor("it's not possible."), "it's not possible.");
    assert.equal(youFor("check if it's possible."), "check if it's possible.");
  });
  test("questions", () => {
    assert.equal(yesNoQuestion("the new logo is in the repo yet."), "Is the new logo in the repo yet?");
    assert.equal(yesNoQuestion("there is anything else left in the queue?"), "Is there anything else left in the queue?");
    assert.equal(yesNoQuestion("it has a test."), null);
    assert.equal(yesNoQuestion("the notarization went through."), null);
    assert.equal(whQuestion("what", "version we're on."), "What version are we on?");
    assert.equal(whQuestion("which", "events it retries."), "Which events do you retry?");
    assert.equal(whQuestion("why", "handleWebhook throws."), null);
  });
  test("keepsWords: words moved, never made up or lost", () => {
    assert.ok(keepsWords("Tell Harbor not to push yet.", "Don't push yet.", ["Tell Harbor to"]));
    assert.equal(keepsWords("Tell Harbor not to push yet.", "Push yet.", ["Tell Harbor to"]), false);
    assert.equal(keepsWords("Ask Atlas what's next.", "What's next? Give me a short answer.", ["Ask Atlas"]), false);
  });
});

// ── In decide(): the direction off once the session is known ───────────────────────────────────
type Stub = { classifier?: { audience: string; confidence: number }; router?: (s: (name: string) => Session) => Action[]; offline?: boolean };

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const seen = { router: 0 };
  const deps: DecideDeps = {
    utterance: async (): Promise<UtteranceDecision> => {
      const c = opts.classifier ?? { audience: "app", confidence: 0.3 };
      return { audience: c.audience === "app" ? "app" : S(c.audience), audienceConfidence: c.confidence, intent: "message", intentConfidence: 1, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
    },
    approval: null,
    route: async () => {
      seen.router++;
      return { text: "", actions: opts.router?.(S) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
    offline: opts.offline ? () => "offline" : null,
  };
  const { classifier: _c, router: _r, offline: _o, ...rest } = opts;
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
  return { d: await decide(state, deps), seen };
}
const typed = (acts: Act[]) => acts.flatMap((a) => (a.type === "send" ? [a.text] : a.type === "ask" ? [`ask: ${a.message}`] : []));

describe("decide(): the direction off once the session is known", () => {
  test("the classifier's pick: 'Ask MintBox, …' arrives without 'Ask MintBox,' (the case that started it)", async () => {
    const { d } = await run("Ask MintBox, what do I have to do to rotate the API key that's expiring?", { classifier: { audience: "mintbox", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), ["What do I have to do to rotate the API key that's expiring?"]);
    const send = d.actions[0];
    assert.ok(send.type === "send" && send.trimmed?.by === "phrase");
  });
  test("named up front: 'Tell Harbor not to push yet' → 'Don't push yet.'", async () => {
    const { d } = await run("Tell Harbor not to push yet.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), ["Don't push yet."]);
  });
  test("the router's pass_on gets the same", async () => {
    const { d } = await run("Let Harbor know the DNS change is live.", { classifier: { audience: "harbor", confidence: 0.4 }, router: (s) => [{ name: "pass_on", session: s("harbor") }] });
    assert.deepEqual(typed(d.actions), ["The DNS change is live."]);
  });
  test("a reply to the waiting session goes as said", async () => {
    const waiting = { sessionId: S("harbor").sessionId, cwd: S("harbor").cwd };
    const { d } = await run("Okay, tell it to go ahead.", { waiting, classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), ["Okay, tell it to go ahead."]);
  });
  test("not mechanical: the question as said, the direction off, no model asked", async () => {
    const { d, seen } = await run("Ask MintBox whether the notarization went through.", { classifier: { audience: "mintbox", confidence: 0.95 } });
    assert.equal(seen.router, 0);
    assert.deepEqual(typed(d.actions), ["The notarization went through?"]);
    const why = await run("Ask Orbit why handleWebhook throws on the invoice.paid event.", { classifier: { audience: "orbit", confidence: 0.95 } });
    assert.deepEqual(typed(why.d.actions), ["Why handleWebhook throws on the invoice.paid event?"]);
  });
  test("words for a session that aren't a direction to it stay whole", async () => {
    const { d } = await run("Tell me why the build failed.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), ["Tell me why the build failed."]);
  });
});

describe("removeParts: a short direction to the session goes (the 3-word rule)", () => {
  test("'Ask MintBox,' picked by the trim", () => {
    const said = "Ask MintBox, what do I need to do to rotate the key?";
    assert.equal(removeParts(said, ["Ask MintBox,"]), null, "without the session, as before");
    assert.equal(removeParts(said, ["Ask MintBox,"], S("mintbox"))?.text, "What do I need to do to rotate the key?");
    assert.equal(removeParts("To Kikodev, the sidebar is back.", ["To Kikodev,"], S("kiko-dev"))?.text, "The sidebar is back.");
  });
  test("not another session's name, nor a short part that isn't a direction", () => {
    assert.equal(removeParts("Ask MintBox, what do I need?", ["Ask MintBox,"], S("Bobby")), null);
    assert.equal(removeParts("Clipkit go ahead", ["go ahead"], S("mintbox")), null);
  });
});

// ── Two sessions in one sentence (sessions.ts splitBySession, decide.ts "split") ───────────────
const parted = (said: string) => {
  const r = splitBySession(W.sessions, said);
  return r && "parts" in r ? r.parts.map((p) => [W.sessions.find((x) => x === p.session)?.givenName || p.session.cwd.split("/").at(-1), p.text]) : r;
};

describe("two sessions in one sentence: each part to its session, its direction off", () => {
  test("one direction to several, made direct", () => {
    assert.deepEqual(parted("Tell Atlas and Harbor not to push yet."), [
      ["atlas", "Don't push yet."],
      ["harbor", "Don't push yet."],
    ]);
    assert.deepEqual(parted("Ask Atlas and Orbit what the timeout is."), [
      ["atlas", "What is the timeout?"],
      ["orbit", "What is the timeout?"],
    ]);
    assert.deepEqual(parted("Ask Atlas and Orbit if they're done."), [
      ["atlas", "Are you done?"],
      ["orbit", "Are you done?"],
    ]);
    assert.deepEqual(parted("Tell Atlas and Harbor that the review moved to Friday."), [
      ["atlas", "The review moved to Friday."],
      ["harbor", "The review moved to Friday."],
    ]);
  });
  test("not mechanical: not split here (the router writes it, its words checked)", () => {
    assert.equal(splitBySession(W.sessions, "Ask Bobby and Kikodev if either of them changed the SSH config."), null);
  });
  test("'Harbor: … Atlas: …' cuts as 'tell … and tell …' does", () => {
    assert.deepEqual(parted("Harbor: roll back the deploy. Atlas: hold the release."), [
      ["harbor", "Roll back the deploy."],
      ["atlas", "Hold the release."],
    ]);
  });
  test("decide: a part said another way gets its direction off too", async () => {
    const { d, seen } = await run("Tell Harbor to deploy and ask Atlas whether it's tagged.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.equal(d.step, "split");
    assert.equal(seen.router, 0);
    assert.deepEqual(typed(d.actions), ["Deploy.", "Is it tagged?"]);
    const q = await run("Tell Harbor to deploy and ask Pixie if the new logo is in the repo.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(q.d.actions), ["Deploy.", "Is the new logo in the repo?"]);
  });
  test("decide: a second name heard wrong ('Atlus'): asked which part is whose, nothing sent", async () => {
    const { d } = await run("Tell Harbor to deploy and tell Atlus to tag the release v3.2.0.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), []);
    const say = d.actions.find((a) => a.type === "say");
    assert.ok(say?.type === "say" && say.why === "split_unclear" && /harbor and atlas/i.test(say.text), JSON.stringify(say));
  });
  test("decide: a later direction to you, someone else or nobody like a session stays with the first", async () => {
    for (const said of ["Tell Harbor to deploy and tell me when it's done.", "Tell Harbor to deploy and ask Alex whether the DNS is ready."]) {
      const { d } = await run(said, { classifier: { audience: "harbor", confidence: 0.95 } });
      assert.equal(typed(d.actions).length, 1, said);
    }
  });
  test("decide: every word of each part kept; unclear parts still asked about, nothing sent", async () => {
    const { d } = await run("Tell Harbor to and tell Atlas to tag it.", { classifier: { audience: "harbor", confidence: 0.95 } });
    assert.deepEqual(typed(d.actions), []);
    assert.ok(d.actions.some((a) => a.type === "say" && a.why === "split_unclear"));
  });
});
