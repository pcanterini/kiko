// Two sessions in one folder, both called by it, used to show, sound and route as the same name.
// Now the first keeps the plain name and the next is numbered
// (src/core/session-numbers.ts, sessions.ts numberSessions): "atlas agents 2", and in the app's own
// folder (called the app's name) "Kiko project 2". The number sticks for the session's life, is kept
// across a restart, and a number said reaches that session only, speech-to-text's "to" and "too"
// for "two" included (src/core/decide.ts, the start: sessions.ts asNumbered).
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import { decide, type DecideDeps, type DecideState, type Question } from "../../../src/core/decide.ts";
import type { Action } from "../../../src/core/router.ts";
import { NUMBERS_FILE, reloadNumbers } from "../../../src/core/session-numbers.ts";
import {
  addressedTo,
  asNumbered,
  mentionsSession,
  numberSessions,
  sessionDetail,
  sessionLabel,
  sessionName,
  sessionNumber,
  sessionsNamed,
  spokenWithTitle,
  type Session,
} from "../../../src/core/sessions.ts";
import { makeSession, makeWorld, type SessionSpec, type World } from "../../support/fixtures.ts";
import { outcomesOf } from "../../support/outcomes.ts";

// Sessions as the agent lists them, before the app numbers them: no numbers of their own.
const listed = (specs: SessionSpec[]) => specs.map((spec) => makeSession(spec));
const names = (sessions: Session[]) => sessions.map(sessionName);
let clock = Date.now();
/** No numbers yet: none kept, none in memory. */
const fresh = () => {
  rmSync(NUMBERS_FILE, { force: true });
  reloadNumbers();
};
/** The app's listing (app/starting.ts getSessions), a while after the last one. */
const list = (sessions: Session[], afterMs = 2000) => numberSessions(sessions, (clock += afterMs));

describe("numbers: the first in a folder keeps its name, the next ones opened there get 2, 3", () => {
  test("two, then three, in one folder; a session alone in its folder has no number", () => {
    fresh();
    const first = listed([{ name: "a1", folder: "atlas-agents", title: "Shipping rates" }, { name: "clipkit" }]);
    assert.deepEqual(names(list(first)), ["atlas-agents", "clipkit"]);
    const second = listed([{ name: "a2", folder: "atlas-agents" }])[0];
    const two = list([...first, second]);
    assert.deepEqual(names(two), ["atlas-agents", "clipkit", "atlas-agents 2"]);
    const third = listed([{ name: "a3", folder: "atlas-agents", title: "Billing page" }])[0];
    const three = list([...first, second, third]);
    assert.deepEqual(names(three), ["atlas-agents", "clipkit", "atlas-agents 2", "atlas-agents 3"]);
    assert.deepEqual(
      three.map((s) => s.number),
      [1, undefined, 2, 3],
      "the plain one is marked 1 while others there are numbered",
    );
  });

  test("the number shows everywhere the name does: the list, the dimmed title, speech, the models' prompts", () => {
    const w = makeWorld([
      { name: "a1", folder: "atlas-agents", title: "Shipping rates" },
      { name: "a2", folder: "atlas-agents", title: "Session colours" },
    ]);
    const [plain, second] = w.sessions;
    assert.equal(sessionName(second), "atlas-agents 2");
    assert.equal(sessionDetail(second), "Session colours", "Claude's title still dimmed after it");
    assert.equal(spokenWithTitle(second), "atlas agents 2, Session colours");
    assert.equal(sessionLabel(second), 'atlas-agents 2 (folder atlas-agents, title "Session colours")');
    assert.equal(sessionLabel(plain), 'atlas-agents (title "Shipping rates")');
    assert.equal(sessionNumber(plain), 0);
    assert.equal(sessionNumber(second), 2);
  });

  test("in the app's own folder (called the app's name): 'Kiko project', 'Kiko project 2'", () => {
    const w = makeWorld([
      { name: "k1", folder: "kiko", title: "Idea file" },
      { name: "k2", folder: "kiko", title: "Session colours" },
    ]);
    assert.deepEqual(names(w.sessions), ["Kiko project", "Kiko project 2"]);
    assert.equal(spokenWithTitle(w.sessions[1]), "Kiko project 2, Session colours");
  });

  test("a session with its own name (from /rename, yours or the app's) is never numbered", () => {
    fresh();
    const sessions = listed([
      { name: "a1", folder: "atlas-agents" },
      { name: "billing", folder: "atlas-agents", given: "billing" },
      { name: "a3", folder: "atlas-agents" },
    ]);
    assert.deepEqual(names(list(sessions)), ["atlas-agents", "billing", "atlas-agents 2"]);
    // Two with the same name of their own stay as they are.
    const same = listed([
      { name: "x1", folder: "lacy-platform", given: "Lacy" },
      { name: "x2", folder: "notes", given: "Lacy" },
    ]);
    assert.deepEqual(names(list(same)), ["Lacy", "Lacy"]);
    assert.ok(list(same).every((s) => s.number === undefined));
  });

  test("a desktop session in a made-up folder goes by its title: no number", () => {
    fresh();
    const sessions = listed([
      { name: "2 plus 2", desktop: true },
      { name: "random", desktop: true },
    ]);
    assert.deepEqual(names(list(sessions)), ["2 plus 2", "random"]);
  });
});

describe("numbers stick: for the session's life, and across a restart", () => {
  const specs: SessionSpec[] = [
    { name: "a1", folder: "atlas-agents" },
    { name: "a2", folder: "atlas-agents" },
  ];
  test("'atlas-agents 2' keeps its number after 'atlas-agents' closes; a number isn't reused while its session is open", () => {
    fresh();
    const [a1, a2] = listed(specs);
    assert.deepEqual(names(list([a1, a2])), ["atlas-agents", "atlas-agents 2"]);
    // The first one closes: the second is still "atlas-agents 2", alone or not.
    assert.deepEqual(names(list([a2], 70_000)), ["atlas-agents 2"]);
    // A new one there takes the lowest number no open session holds: the plain name, never 2.
    const [a4] = listed([{ name: "a4", folder: "atlas-agents" }]);
    assert.deepEqual(names(list([a2, a4])), ["atlas-agents 2", "atlas-agents"]);
    const [a5] = listed([{ name: "a5", folder: "atlas-agents" }]);
    assert.deepEqual(names(list([a2, a4, a5])), ["atlas-agents 2", "atlas-agents", "atlas-agents 3"]);
  });

  test("closed, and a new one opened there at once (claude quit and started again): the new one is plain, not '2'", () => {
    fresh();
    const [a1] = listed(specs);
    list([a1]);
    const [again] = listed([{ name: "again", folder: "atlas-agents" }]);
    assert.deepEqual(names(list([again])), ["atlas-agents"]);
  });

  test("one listing that misses a session (its agent's list failing once): it comes back with its number", () => {
    fresh();
    const [a1, a2] = listed(specs);
    list([a1, a2]);
    list([a1]);
    const [a3] = listed([{ name: "a3", folder: "atlas-agents" }]);
    assert.deepEqual(names(list([a1, a2, a3])), ["atlas-agents", "atlas-agents 2", "atlas-agents 3"]);
  });

  test("kept next to the settings by session ID: a restart (the sessions still running) keeps every number, whatever the order", () => {
    fresh();
    const [a1, a2] = listed(specs);
    list([a1, a2]);
    assert.equal(dirname(NUMBERS_FILE), dirname(process.env.KIKO_SETTINGS!), "beside the settings (the tests' own folder)");
    assert.deepEqual(JSON.parse(readFileSync(NUMBERS_FILE, "utf8")), { "id-a1": { name: "atlas agents", number: 1 }, "id-a2": { name: "atlas agents", number: 2 } });
    reloadNumbers();
    assert.deepEqual(names(list([a2, a1])), ["atlas-agents 2", "atlas-agents"]);
    // Known only by its ID and folder (a hook, a line of the timeline): its number too.
    assert.equal(sessionName({ sessionId: a2.sessionId, cwd: a2.cwd, givenName: "" }), "atlas-agents 2");
  });

  test("closed sessions are let go of: after a restart, one no longer listed frees its number", () => {
    fresh();
    const [a1, a2] = listed(specs);
    list([a1, a2]);
    reloadNumbers();
    // After a restart each counts as listed then; one still not listed a minute on has closed.
    list([a2]);
    list([a2], 70_000);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(NUMBERS_FILE, "utf8"))), ["id-a2"]);
    assert.ok(existsSync(NUMBERS_FILE));
  });

  test("a session the app opened keeps the number it had while starting", () => {
    fresh();
    const [a1] = listed(specs);
    const starting = { ...makeSession({ name: "a2", folder: "atlas-agents" }), sessionId: "starting-7" };
    assert.deepEqual(names(list([a1, starting])), ["atlas-agents", "atlas-agents 2"]);
    // Started: listed by its own ID, the one it had as an alias (core/starting.ts withAliases).
    const started = { ...makeSession({ name: "a2", folder: "atlas-agents" }), aliases: ["starting-7"] };
    assert.deepEqual(names(list([a1, started])), ["atlas-agents", "atlas-agents 2"]);
    // And after a restart, with no alias any more.
    reloadNumbers();
    assert.deepEqual(names(list([a1, { ...started, aliases: [] }])), ["atlas-agents", "atlas-agents 2"]);
  });

  test("renamed, it goes by its new name with no number, and its number is free again", () => {
    fresh();
    const [a1, a2] = listed(specs);
    list([a1, a2]);
    const renamed = { ...a2, givenName: "billing", name: "billing" };
    assert.deepEqual(names(list([a1, renamed])), ["atlas-agents", "billing"]);
    assert.equal(list([a1, renamed])[0].number, undefined, "alone with its name again: no number to tell it apart");
    const [a3] = listed([{ name: "a3", folder: "atlas-agents" }]);
    assert.deepEqual(names(list([a1, renamed, a3])), ["atlas-agents", "billing", "atlas-agents 2"]);
  });
});

describe("asNumbered: a number said after a numbered name, as that session's name", () => {
  const w = makeWorld([
    { name: "k1", folder: "kiko", title: "Idea file" },
    { name: "k2", folder: "kiko", title: "Session colours" },
    { name: "a1", folder: "atlas-agents" },
    { name: "a2", folder: "atlas-agents" },
    { name: "clipkit" },
  ]);
  const cases: Array<[string, string]> = [
    ["Kiko two, run the tests.", "Kiko project 2, run the tests."],
    ["Kiko 2, run the tests.", "Kiko project 2, run the tests."],
    ["Tell kiko two to run the tests.", "Tell Kiko project 2 to run the tests."],
    ["To kiko number two, run the tests.", "To Kiko project 2, run the tests."],
    ["Kiko #2, run the tests.", "Kiko project 2, run the tests."],
    ["Kiko to, run the tests.", "Kiko project 2, run the tests."],
    ["Kiko too, run the tests.", "Kiko project 2, run the tests."],
    ["Tell kiko too to run the tests.", "Tell Kiko project 2 to run the tests."],
    ["The Kiko project two session", "The Kiko project 2 session"],
    ["Atlas agents two, check the logs.", "Atlas agents 2, check the logs."],
    ["Atlas agents to: check the logs.", "Atlas agents 2: check the logs."],
    ["Atlas agents too.", "Atlas agents 2."],
  ];
  for (const [said, as] of cases) test(JSON.stringify(said), () => assert.equal(asNumbered(said, w.sessions), as));

  const kept = [
    // "to" as the word: what to tell it, where to send it, who it's for.
    "Tell kiko to run the tests.",
    "Tell atlas agents to run the tests.",
    "Kiko, to atlas agents: run the tests.",
    "Kiko to follow project, check the logs.",
    "Kiko, to the tests.",
    "Tell atlas agents to, uh, check the logs.",
    "Send this to atlas agents too.",
    // "2" for "to", before another session's name.
    "Kiko 2 clipkit, check the logs.",
    // A number none of them has; "one" ("the kiko one"); "1st" ("Kiko, 1st commit it").
    "Atlas agents three, check the logs.",
    "Tell the atlas agents one to commit.",
    "Kiko 1st commit the changes.",
    // A name that isn't numbered.
    "Clipkit two, check the logs.",
  ];
  for (const said of kept) test(`${JSON.stringify(said)}: as said`, () => assert.equal(asNumbered(said, w.sessions), said));
});

describe("names: a number names that session only; the plain name names them all; titles still work", () => {
  const w = makeWorld([
    { name: "a1", folder: "atlas-agents", title: "Shipping rates" },
    { name: "a2", folder: "atlas-agents", title: "Session colours" },
    { name: "a3", folder: "atlas-agents", title: "Billing page" },
  ]);
  const [a1, a2, a3] = w.sessions;
  test("addressedTo", () => {
    assert.deepEqual(names(addressedTo(w.sessions, "Atlas agents 2, run the tests.")!.sessions), ["atlas-agents 2"]);
    assert.deepEqual(names(addressedTo(w.sessions, "Tell atlas agents 3 to run the tests.")!.sessions), ["atlas-agents 3"]);
    assert.equal(addressedTo(w.sessions, "Atlas agents, run the tests.")!.sessions.length, 3);
    assert.deepEqual(names(addressedTo(w.sessions, "Tell the session colours one to commit.")!.sessions), ["atlas-agents 2"], "by title");
  });
  test("mentionsSession and sessionsNamed", () => {
    assert.ok(mentionsSession(a2, "stop atlas agents 2"));
    assert.ok(!mentionsSession(a1, "stop atlas agents 2"));
    assert.ok(!mentionsSession(a3, "stop atlas agents 2"));
    assert.ok(mentionsSession(a2, "tell atlas agents 2 to commit", "own"), "its number is its alone");
    assert.ok(!mentionsSession(a2, "tell atlas agents to commit", "own"));
    assert.deepEqual(names(sessionsNamed(w.sessions, "Stop atlas agents 2.")), ["atlas-agents 2"]);
    assert.deepEqual(names(sessionsNamed(w.sessions, "repeat the last atlas agents 2 message", true)), ["atlas-agents 2"]);
    assert.equal(sessionsNamed(w.sessions, "Stop the atlas agents session.").length, 3);
    assert.deepEqual(names(sessionsNamed(w.sessions, "atlas agents 4", true)), [], "a number none has names none of them");
  });
  test("in the app's folder: 'kiko 2' and 'Kiko project 2' name the second, never the plain one", () => {
    const k = makeWorld([
      { name: "k1", folder: "kiko" },
      { name: "k2", folder: "kiko" },
    ]);
    for (const said of ["Tell the Kiko project 2 to commit.", "tell kiko 2 to commit"]) assert.deepEqual(names(sessionsNamed(k.sessions, said)), ["Kiko project 2"], said);
    assert.equal(sessionsNamed(k.sessions, "Tell the Kiko project to commit.").length, 2);
  });
});

// ── Routing: decide, as the app runs it ───────────────────────────────────

type Stub = { router?: (s: (name: string) => Session) => Action[]; says?: string; audience?: string; confidence?: number; world?: World };

const WORLD = makeWorld([
  { name: "k1", folder: "kiko", title: "Idea file", status: "idle", asked: "Write the idea file." },
  { name: "k2", folder: "kiko", title: "Session colours", status: "busy", asked: "Make the session colours unique." },
  { name: "k3", folder: "kiko", title: "Dictionary tests", status: "idle" },
  { name: "a1", folder: "atlas-agents", title: "Shipping rates", status: "idle" },
  { name: "a2", folder: "atlas-agents", title: "Billing page", status: "idle" },
  { name: "clipkit", title: "ClipKit export window jump", status: "idle" },
]);

async function run(text: string, opts: Partial<DecideState> & Stub = {}) {
  const world = opts.world ?? WORLD;
  const calls = { classifier: 0, router: 0 };
  const get = (name: string) => world.byName.get(name.toLowerCase())!;
  const deps: DecideDeps = {
    utterance: async (): Promise<UtteranceDecision> => {
      calls.classifier++;
      return {
        audience: opts.audience ? get(opts.audience) : "app",
        audienceConfidence: opts.confidence ?? 0.3,
        intent: "message",
        intentConfidence: 0.95,
        appParts: 0.1,
        model: "test",
        costUsd: 0,
        ms: 1,
      };
    },
    approval: null,
    route: async () => {
      calls.router++;
      return { text: opts.says ?? "", actions: opts.router?.(get) ?? [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
    },
    trim: null,
  };
  const state: DecideState = {
    text,
    sessions: world.sessions,
    notes: world.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "everything",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  const d = await decide(state, deps);
  return { ...d, outcomes: outcomesOf(d, state), calls };
}

/** Where words went: [action, to (as shown), the words]. */
const went = (d: Awaited<ReturnType<typeof run>>) =>
  d.outcomes.flatMap((o) => (o.action === "send" ? [[o.to, o.text]] : o.action === "ask" ? [[o.to, o.message]] : o.action === "stop" || o.action === "rename" ? [[o.action, o.to]] : []));

describe("routing by number: only that session, never the plain one or another number", () => {
  const second = [
    "Kiko two, run the tests.",
    "Kiko 2, run the tests.",
    "Kiko-2, run the tests.",
    "Tell kiko two to run the tests.",
    "Tell kiko 2 to run the tests.",
    "To kiko number two, run the tests.",
    "Kiko to, run the tests.",
    "Kiko too, run the tests.",
    "Kiko #2, run the tests.",
    "Tell the Kiko project 2 to run the tests.",
    "Hey Kiko, tell kiko two to run the tests.",
  ];
  for (const said of second) {
    test(`${JSON.stringify(said)}: Kiko project 2`, async () => {
      const d = await run(said);
      assert.equal(d.step, "addressed");
      assert.deepEqual(went(d), [["Kiko project 2", "Run the tests."]]);
      assert.equal(d.toApp, said.startsWith("Hey Kiko") ? true : undefined, "the number after 'Kiko' makes it the session, not the app");
    });
  }
  test("'Kiko three, …': the third, not the second", async () => {
    assert.deepEqual(went(await run("Kiko three, check the logs.")), [["Kiko project 3", "Check the logs."]]);
  });
  test("a folder not called the app's: 'atlas agents two', 'atlas agents to:'", async () => {
    assert.deepEqual(went(await run("Atlas agents two, check the logs.")), [["atlas-agents 2", "Check the logs."]]);
    assert.deepEqual(went(await run("Atlas agents to: check the logs.")), [["atlas-agents 2", "Check the logs."]]);
  });
  test("'Tell kiko to run the tests': a direction to the sessions called Kiko, all three of them, so asked which", async () => {
    const d = await run("Tell kiko to run the tests.");
    assert.equal(d.toApp, undefined);
    assert.equal(d.step, "which-numbered");
    assert.deepEqual(d.question?.kind === "asked" && d.question.question.offered, ["id-k1", "id-k2", "id-k3"]);
    assert.equal(d.calls.router, 0);
  });
  test("'Kiko, to clipkit: …' still goes to clipkit", async () => {
    assert.deepEqual(went(await run("Kiko, to clipkit: check the logs.")), [["clipkit", "Check the logs."]]);
  });
  test("by Claude's title, as before", async () => {
    assert.deepEqual(went(await run("Tell the session colours one to commit.")), [["Kiko project 2", "Commit."]]);
  });
});

describe("the plain name with several open: the app asks which, and the answer picks", () => {
  const line = "Which one: Kiko project, Idea file; Kiko project 2, Session colours; or Kiko project 3, Dictionary tests?";
  test("'Kiko project, …': asked, no guess, no model; each by its number and title", async () => {
    const d = await run("Tell the Kiko project to commit the changes.");
    assert.equal(d.step, "which-numbered");
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: line }]);
    assert.deepEqual(d.question, { kind: "asked", question: { text: "Commit the changes.", offered: ["id-k1", "id-k2", "id-k3"], line } });
    assert.deepEqual([d.calls.classifier, d.calls.router], [0, 0]);
  });
  test("'Atlas agents, to the tests.': the plain name, so asked, never atlas-agents 2", async () => {
    const d = await run("Atlas agents, to the tests.");
    assert.equal(d.step, "which-numbered");
    assert.match(d.outcomes[0].action === "ask_user" ? d.outcomes[0].text : "", /^Which one: atlas agents, Shipping rates; or atlas agents 2, Billing page\?$/);
  });
  test("the plain name mid-sentence, the router picking one: asked which all the same, never its guess", async () => {
    const d = await run("Can the Kiko project check the logs for my last message?", { router: (s) => [{ name: "pass_on", session: s("k1") }] });
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: line }]);
    assert.deepEqual(d.question?.kind, "asked");
  });
  test("…but by its number or title mid-sentence, the router's pick goes", async () => {
    const d = await run("Can the Kiko project 2 check the logs for my last message?", { router: (s) => [{ name: "pass_on", session: s("k2") }] });
    assert.deepEqual(went(d), [["Kiko project 2", "Can the Kiko project 2 check the logs for my last message?"]]);
    const t = await run("Can the session colours one check the logs?", { router: (s) => [{ name: "ask_session", session: s("k2"), message: "Check the logs." }] });
    assert.deepEqual(went(t), [["Kiko project 2", "Check the logs."]]);
  });
  test("one of them waiting for your reply: it's that one's, as before", async () => {
    const k2 = WORLD.byName.get("k2")!;
    const d = await run("Kiko project, yes, go ahead.", { waiting: { sessionId: k2.sessionId, cwd: k2.cwd }, audience: "k2", confidence: 0.9 });
    assert.notEqual(d.step, "which-numbered");
    assert.deepEqual(went(d)[0]?.[0], "Kiko project 2");
  });

  const question: Question = { text: "Commit the changes.", offered: ["id-k1", "id-k2", "id-k3"], line };
  const answers: Array<[string, string]> = [
    ["Two.", "Kiko project 2"],
    ["2", "Kiko project 2"],
    ["Number two.", "Kiko project 2"],
    ["The second one.", "Kiko project 2"],
    ["Kiko project 2.", "Kiko project 2"],
    ["Kiko two.", "Kiko project 2"],
    ["Kiko too.", "Kiko project 2"],
    ["Uh, the Kiko project 2, please.", "Kiko project 2"],
    ["Three.", "Kiko project 3"],
    ["The last one.", "Kiko project 3"],
    ["The first one.", "Kiko project"],
    ["Kiko project.", "Kiko project"],
  ];
  for (const [said, to] of answers) {
    test(`answered ${JSON.stringify(said)}: ${to}`, async () => {
      const d = await run(said, { question, appAsked: true, recent: [`app said: ${line}`] });
      assert.equal(d.step, "question");
      assert.deepEqual(went(d), [[to, "Commit the changes."]]);
    });
  }
});

describe("titles still pick, through the router as before", () => {
  test("answered 'The session colours one.': the router's pass_on sends the words asked about", async () => {
    const line = "Which one: Kiko project, Idea file; Kiko project 2, Session colours; or Kiko project 3, Dictionary tests?";
    const question: Question = { text: "Commit the changes.", offered: ["id-k1", "id-k2", "id-k3"], line };
    const d = await run("The session colours one.", { question, appAsked: true, recent: [`app said: ${line}`], router: (s) => [{ name: "pass_on", session: s("k2") }] });
    assert.deepEqual(went(d), [["Kiko project 2", "Commit the changes."]]);
  });
});

describe("stop and rename by number", () => {
  test("'Stop atlas agents 2.' stops that one only; 'Stop atlas agents.' asks which", async () => {
    assert.deepEqual(went(await run("Stop atlas agents 2.")), [["stop", "atlas-agents 2"]]);
    assert.deepEqual(went(await run("Stop atlas agents two.")), [["stop", "atlas-agents 2"]]);
    const d = await run("Stop atlas agents.");
    assert.deepEqual(d.outcomes, [{ action: "ask_user", text: "Stop which one? Say its name." }]);
  });
  test("'Rename kiko 2 to billing' renames that one session, even when the router picks another there", async () => {
    for (const said of ["Rename kiko 2 to billing.", "Rename kiko two to billing.", "Rename the Kiko project 2 to billing."]) {
      const d = await run(said, { router: (s) => [{ name: "rename_session", session: s("k1"), newName: "billing" }] });
      assert.deepEqual(d.outcomes, [{ action: "rename", to: "Kiko project 2", name: "billing", sessionId: "id-k2" }], said);
    }
  });
  test("'Rename kiko project to billing' with three there: which one?", async () => {
    const d = await run("Rename the Kiko project to billing.", { router: (s) => [{ name: "rename_session", session: s("k1"), newName: "billing" }] });
    assert.equal(d.outcomes[0].action, "ask_user");
  });
  test("once renamed, it has its own name and no number", () => {
    fresh();
    const [k1, k2] = listed([
      { name: "k1", folder: "kiko" },
      { name: "k2", folder: "kiko" },
    ]);
    assert.deepEqual(names(list([k1, k2])), ["Kiko project", "Kiko project 2"]);
    assert.deepEqual(names(list([k1, { ...k2, givenName: "billing", name: "billing" }])), ["Kiko project", "billing"]);
  });
});
