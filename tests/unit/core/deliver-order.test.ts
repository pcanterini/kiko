// The deliver() decision order and the guards after the router, with the classifier and the router stubbed:
// which step decides, and what the code does with each model answer. Free and deterministic.
// Runs decide() from src/core/decide.ts, the function the app's deliver() calls.
import "../../setup.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, test } from "node:test";
import type { UtteranceDecision } from "../../../src/core/decisions.ts";
import type { Action } from "../../../src/core/router.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { listProjects, sessionFolders } from "../../../src/core/projects.ts";
import { CAST, makeWorld, type VoiceCan, type World } from "../../support/fixtures.ts";
import { outcomesOf, type Outcome } from "../../support/outcomes.ts";

const WORLD = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy, CAST.twoPlusTwo, CAST.pixie]);
const S = (name: string) => WORLD.byName.get(name)!;
/** The waiting session, as the app passes it. */
const waits = (name: string, permission?: string) => ({ sessionId: S(name).sessionId, cwd: S(name).cwd, ...(permission ? { permission } : {}) });

type Stub = {
  classifier?: Partial<Omit<UtteranceDecision, "audience">> & { audience?: string };
  router?: { actions?: (sessions: Map<string, Session>) => Action[]; text?: string; claimsAction?: boolean };
  classifierEnabled?: boolean;
  world?: World;
};

async function run(text: string, opts: Partial<DecideState> & Stub & { voiceCan?: VoiceCan } = {}) {
  const world = opts.world ?? WORLD;
  const calls = { classifier: 0, router: 0, approval: 0 };
  const classifierOn = opts.classifierEnabled ?? true;
  const deps: DecideDeps = {
    utterance: !classifierOn
      ? null
      : async () => {
          calls.classifier++;
          const j = opts.classifier ?? {};
          return {
            audience: j.audience && j.audience !== "app" ? world.byName.get(j.audience)! : "app",
            audienceConfidence: j.audienceConfidence ?? 0.9,
            intent: j.intent ?? "message",
            intentConfidence: j.intentConfidence ?? 0.95,
            appParts: j.appParts ?? 0.1,
            model: "test",
            costUsd: 0.0001,
            ms: 1,
          };
        },
    approval: !classifierOn
      ? null
      : async () => {
          calls.approval++;
          return { answer: "allow", confidence: 0.99, costUsd: 0.0001, ms: 1 };
        },
    route: async () => {
      calls.router++;
      const usage = { input_tokens: 0, output_tokens: 0 };
      const actions = opts.router?.actions?.(world.byName) ?? [];
      return { text: opts.router?.text ?? "", actions, claimsAction: opts.router?.claimsAction ?? false, usage, costUsd: 0.0003 };
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
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...opts,
  };
  const d = await decide(state, deps);
  return { ...d, layer: d.step, outcomes: outcomesOf(d, state), calls };
}

/** The one outcome, without its sessionId (checked by name here). */
const only = (outcomes: Outcome[]): Outcome => {
  assert.equal(outcomes.length, 1, JSON.stringify(outcomes));
  const { sessionId: _id, ...rest } = outcomes[0];
  return rest as Outcome;
};

describe("order of the layers", () => {
  test("a permission prompt takes the words first, even a closer", async () => {
    const d = await run("No, that's fine.", { waiting: waits("clipkit", "run: rm -rf dist") });
    assert.equal(d.layer, "permission");
    assert.deepEqual(only(d.outcomes), { action: "permission", answer: "allow" }); // the stub says allow
    assert.equal(d.calls.classifier, 0);
  });
  test("closers wrap up without the classifier", async () => {
    const d = await run("Cool, thanks.", { waiting: waits("clipkit") });
    assert.equal(d.layer, "closing");
    assert.equal(d.calls.classifier + d.calls.router, 0);
  });
  test("after the app asks a question, the router takes the answer, even a named session", async () => {
    const d = await run("Clipkit, the first one.", {
      appAsked: true,
      router: { actions: (s) => [{ name: "pass_on", session: s.get("clipkit")! }] },
    });
    assert.equal(d.layer, "app-question");
    assert.equal(d.calls.classifier, 0);
    assert.equal(d.calls.router, 1);
  });
  test("a session named up front skips the classifier, minus the name", async () => {
    const d = await run("Clipkit, cut a new dev build.");
    assert.equal(d.layer, "addressed");
    assert.deepEqual(only(d.outcomes), { action: "send", to: "clipkit", text: "Cut a new dev build.", via: "terminal" });
    assert.equal(d.calls.classifier, 0);
  });
  test("naming the waiting session goes through the classifier (its words are a reply)", async () => {
    const d = await run("Clipkit, yes do it.", { waiting: waits("clipkit"), classifier: { audience: "clipkit" } });
    assert.equal(d.layer, "classifier");
    assert.deepEqual(only(d.outcomes), { action: "send", to: "clipkit", text: "Yes do it.", via: "reply" });
  });
  test("the classifier sure about a session: sent there", async () => {
    const d = await run("Run the tests.", { classifier: { audience: "lacy-platform", audienceConfidence: 0.8 } });
    assert.equal(d.layer, "classifier");
    assert.equal((only(d.outcomes) as { to: string }).to, "lacy-platform");
    assert.equal(d.calls.router, 0);
  });
  test("the classifier unsure (below 0.75): the router decides", async () => {
    const d = await run("Run the tests.", {
      classifier: { audience: "lacy-platform", audienceConfidence: 0.68 },
      router: { actions: (s) => [{ name: "pass_on", session: s.get("clipkit")! }] },
    });
    assert.equal(d.layer, "router");
    assert.equal((only(d.outcomes) as { to: string }).to, "clipkit");
  });
  test("a session waiting: Jev's pick of another needs 0.9 (a bare 'Sounds good.')", async () => {
    const other = await run("Sounds good.", { waiting: waits("clipkit"), classifier: { audience: "claude-code-speech", audienceConfidence: 0.85 }, router: { text: "Okay." } });
    assert.equal(other.layer, "router");
    const sure = await run("Run the tests in claude code speech too.", { waiting: waits("clipkit"), classifier: { audience: "claude-code-speech", audienceConfidence: 0.93 } });
    assert.equal(sure.layer, "classifier");
    const same = await run("Sounds good.", { waiting: waits("clipkit"), classifier: { audience: "clipkit", audienceConfidence: 0.8 } });
    assert.equal(same.layer, "classifier", "the waiting one itself: the usual bar");
  });
  test("a session just spoke: the same for another one", async () => {
    const d = await run("Sounds good.", { justSpoke: { id: S("clipkit").sessionId, secondsAgo: 5 }, classifier: { audience: "lacy-platform", audienceConfidence: 0.8 } });
    assert.equal(d.layer, "router");
  });
  test("the classifier picks the app: the router decides", async () => {
    const d = await run("What sessions do I have?", { classifier: { audience: "app", audienceConfidence: 0.95 }, router: { text: "Five sessions." } });
    assert.equal(d.layer, "router");
    assert.deepEqual(only(d.outcomes), { action: "say", text: "Five sessions." });
  });
  test("the router claiming an action it didn't take: not said; the app says nothing was sent", async () => {
    const d = await run("Leave that one for later. Thanks.", {
      waiting: waits("claude-code-speech"),
      classifier: { audience: "claude-code-speech", audienceConfidence: 0.6 },
      router: { text: "Got it, I'll leave that branch alone.", claimsAction: true },
    });
    assert.deepEqual(only(d.outcomes), { action: "ask_user", text: "I didn't send that anywhere. Who's it for?" });
  });
  test("a claim that goes with its tool call is fine (the text isn't spoken anyway)", async () => {
    const d = await run("Ask clipkit what's next.", {
      classifier: { audienceConfidence: 0.3 },
      router: { text: "Asking clipkit.", claimsAction: true, actions: (s) => [{ name: "ask_session", session: s.get("clipkit")!, message: "What's next?" }] },
    });
    assert.equal(only(d.outcomes).action, "ask");
  });
  test("a question back from the router is ask_user", async () => {
    const d = await run("Commit it.", { classifier: { audienceConfidence: 0.4 }, router: { text: "Which one, clipkit or lacy platform?" } });
    assert.equal(only(d.outcomes).action, "ask_user");
  });
});

describe("the classifier's intents (at 0.7 or more)", () => {
  for (const intent of ["wrap_up", "undo", "repeat"] as const) {
    test(intent, async () => {
      const d = await run("whatever", { classifier: { intent, intentConfidence: 0.75 } });
      assert.equal(d.layer, "classifier-intent");
      assert.equal(only(d.outcomes).action, intent);
    });
  }
  test("an unsure intent is a message", async () => {
    const d = await run("No, I'll test it first.", { classifier: { audience: "claude-code-speech", intent: "wrap_up", intentConfidence: 0.33 } });
    assert.equal(d.layer, "classifier");
  });
  const lastSent = { sessionId: "id-claude-code-speech", folder: "claude-code-speech", text: "Tell it to bump the version number." };
  test("redirect naming the session: resend there", async () => {
    const d = await run("No, that was supposed to be to clipkit.", { lastSent, classifier: { intent: "redirect", audience: "app", audienceConfidence: 0.3 } });
    assert.equal(d.layer, "classifier-intent");
    assert.deepEqual(only(d.outcomes), { action: "resend", to: "clipkit", text: lastSent.text, via: "terminal" });
  });
  test("redirect, the classifier sure of another session: resend there", async () => {
    const d = await run("Wrong session.", { lastSent, classifier: { intent: "redirect", audience: "lacy-platform", audienceConfidence: 0.8 } });
    assert.deepEqual(only(d.outcomes), { action: "resend", to: "lacy-platform", text: lastSent.text, via: "terminal" });
  });
  test("redirect with no clear target: the router", async () => {
    const d = await run("That was for the other one.", {
      lastSent,
      classifier: { intent: "redirect", audience: "app", audienceConfidence: 0.5 },
      router: { actions: (s) => [{ name: "resend_to", session: s.get("clipkit")! }] },
    });
    assert.equal(d.layer, "router");
    assert.equal(only(d.outcomes).action, "resend");
  });
  test("redirect with nothing sent lately: treated as a message", async () => {
    const d = await run("That was for clipkit.", { classifier: { intent: "redirect", audience: "clipkit", audienceConfidence: 0.9 } });
    assert.equal(d.layer, "classifier");
  });
});

describe("without the classifier", () => {
  test("'repeat that' by phrase", async () => {
    const d = await run("Can you repeat that?", { classifierEnabled: false });
    assert.equal(d.layer, "repeat-fallback");
  });
  test("the waiting session gets the words", async () => {
    const d = await run("Yes, go ahead.", { classifierEnabled: false, waiting: waits("clipkit") });
    assert.equal(d.layer, "waiting-fallback");
    assert.deepEqual(only(d.outcomes), { action: "send", to: "clipkit", text: "Yes, go ahead.", via: "reply" });
  });
  test("nothing waiting: the router", async () => {
    const d = await run("Run the tests.", { classifierEnabled: false });
    assert.equal(d.layer, "router");
  });
});

describe("guards after the router", () => {
  const stop = (name: string) => (s: Map<string, Session>) => [{ name: "stop_session", session: s.get(name)! }] as Action[];
  test("a bare 'Stop.' never presses Escape", async () => {
    const d = await run("Stop.", { voiceCan: "everything", classifier: { audienceConfidence: 0.45 }, router: { actions: stop("claude-code-speech") } });
    assert.deepEqual(only(d.outcomes), { action: "stop_ignored", to: "claude-code-speech" });
  });
  test("stop for a session the words don't name, with several busy: asks which", async () => {
    const w = makeWorld([CAST.voice, { ...CAST.clipkit, status: "busy" }]);
    const d = await run("I can see a helper still running on it. So tell that one to stop the agent.", {
      world: w,
      sessions: w.sessions,
      notes: w.notes,
      voiceCan: "everything",
      classifierEnabled: false,
      router: { actions: (s) => [{ name: "stop_session", session: s.get("claude-code-speech")! }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "ask_user", text: "Stop which one? Say its name." });
  });
  test("stop for the only busy session goes through", async () => {
    const d = await run("Interrupt it.", { voiceCan: "everything", classifier: { audienceConfidence: 0.3 }, router: { actions: stop("claude-code-speech") } });
    assert.deepEqual(only(d.outcomes), { action: "stop", to: "claude-code-speech", via: "terminal" });
  });
  test("stop and rename for a T3 Code thread named: done (through T3, so reached), never 'it's in T3 Code' (T3 parity)", async () => {
    const w = makeWorld([CAST.voice, { name: "hello from t3", folder: "workbench", given: "hello from t3", t3: true, status: "busy" }]);
    const opts = { world: w, sessions: w.sessions, notes: w.notes, voiceCan: "everything" as const, classifierEnabled: false };
    const stopped = await run("Stop hello from T3.", { ...opts, router: { actions: stop("hello from t3") } });
    assert.deepEqual(only(stopped.outcomes), { action: "stop", to: "hello from t3", via: "terminal" });
    const renamed = await run("Rename hello from T3 to capitals.", { ...opts, router: { actions: (s) => [{ name: "rename_session", session: s.get("hello from t3")!, newName: "capitals" }] } });
    assert.deepEqual(only(renamed.outcomes), { action: "rename", to: "hello from t3", name: "capitals" });
  });
  test("stop at 'messages': refused", async () => {
    const d = await run("Stop clipkit.", { classifier: { audienceConfidence: 0.3 }, router: { actions: stop("clipkit") } });
    assert.deepEqual(only(d.outcomes), { action: "refused", what: "stop", to: "clipkit" });
  });
  const start = () => [{ name: "start_session", project: "claude code speech", newProject: false, sessionName: "", prompt: "Add a dark mode" }] as Action[];
  test("start_session where a session already is, not asked for: sent to that session", async () => {
    const d = await run("Can we add a dark mode?", { voiceCan: "everything", classifier: { audienceConfidence: 0.5 }, router: { actions: start } });
    assert.deepEqual(only(d.outcomes), { action: "send", to: "claude-code-speech", text: "Can we add a dark mode?", via: "terminal", from: "start_session", unsure: true });
  });
  test("start_session when asked for a new one: started", async () => {
    const d = await run("Open a new session in claude code speech.", { voiceCan: "everything", classifier: { audienceConfidence: 0.5 }, router: { actions: start } });
    assert.equal(only(d.outcomes).action, "start");
  });
  test("start_session at 'messages': refused", async () => {
    const d = await run("Open a new session in claude code speech.", { classifier: { audienceConfidence: 0.5 }, router: { actions: start } });
    assert.deepEqual(only(d.outcomes), { action: "refused", what: "start" });
  });

  // Where it opens (core/projects.ts): the app's projects, and the running sessions' folders.
  const opening = async (said: string, ask: Partial<Extract<Action, { name: "start_session" }>>, more: Partial<DecideState> = {}) => {
    const action = { name: "start_session", project: null, newProject: false, sessionName: "", prompt: "", ...ask } as Action;
    const projects = () => listProjects([...sessionFolders(WORLD.sessions), { cwd: "/Users/me/git/pixie", names: [], lastUsed: 0 }, { cwd: "/Users/me/git/tideline", names: [], lastUsed: 0 }]);
    const d = await run(said, { voiceCan: "everything", classifier: { audienceConfidence: 0.5 }, router: { actions: () => [action] }, projects, newProjectRoot: "/Users/me/git", ...more });
    return only(d.outcomes);
  };
  test("start_session in a known project: there, with nothing but what's asked beyond opening it", async () => {
    assert.deepEqual(await opening("Open a new session in Pixie.", { project: "Pixie" }), { action: "start", folder: "pixie", how: "exact", name: "", text: "" });
    assert.deepEqual(await opening("Open a session in pixie and fix the login bug.", { project: "pixie", prompt: "Fix the login bug." }), {
      action: "start",
      folder: "pixie",
      how: "exact",
      name: "",
      text: "Fix the login bug.",
    });
  });
  test("start_session in a name only close to one: the closest", async () => {
    assert.deepEqual(await opening("Open a new session in Pixy.", { project: "Pixy" }), { action: "start", folder: "pixie", how: "close", name: "", text: "" });
  });
  test("start_session in an unknown project, or none: a scratch folder, never the app's own", async () => {
    assert.deepEqual(await opening("Start a new session in Pixel.", { project: "Pixel" }), { action: "start", folder: "scratch", how: "scratch", name: "", text: "" });
    assert.deepEqual(await opening("Open a new session.", {}), { action: "start", folder: "scratch", how: "scratch", name: "", text: "" });
  });
  test("start_session in 'home' you didn't ask for: a scratch folder; asked for, or the app's offer of the home folder said yes to: home", async () => {
    assert.deepEqual(await opening("Open a new session and have it sketch a weather app.", { project: "home", prompt: "Sketch a weather app." }), {
      action: "start",
      folder: "scratch",
      how: "scratch",
      name: "",
      text: "Sketch a weather app.",
    });
    assert.equal((await opening("Open a new session in my home folder.", { project: "home" })).action, "start");
    assert.deepEqual(await opening("Open a new session in my home folder.", { project: "home" }), { action: "start", folder: homedir().split("/").pop()!, how: "home", name: "", text: "" });
    const offered = (line: string) => ({ appAsked: true, recent: [`app said: ${line}`] });
    assert.equal(((await opening("Yes, please.", { project: "home" }, offered("Want me to start a session in your home folder?"))) as { how?: string }).how, "home");
  });
  test("start_session in 'home' after the app offered the scratch folder: a scratch folder", async () => {
    // The router took "Sure." to the offer of a session for the brightness as a session in ~ (it said "home folder" then).
    const offer = "That would change something on your Mac, and a quick check can only look. Want me to start a session in the scratch folder to do it?";
    const d = await opening("Sure.", { project: "home", prompt: "Set the screen brightness to 50%." }, { appAsked: true, recent: [`app said: ${offer}`] });
    assert.deepEqual(d, { action: "start", folder: "scratch", how: "scratch", name: "", text: "Set the screen brightness to 50%." });
    // Any question of the app's but that one: the same.
    assert.equal(((await opening("Yes.", { project: "home" }, { appAsked: true })) as { how?: string }).how, "scratch");
  });
  test("start_session named, no project said: the project by that name, named", async () => {
    assert.deepEqual(await opening("Open a new session named Clipkit.", { sessionName: "Clipkit" }), { action: "start", folder: "clipkit", how: "named", name: "Clipkit", text: "" });
    assert.deepEqual(await opening("Open a new session named Migrations.", { sessionName: "Migrations" }), { action: "start", folder: "scratch", how: "scratch", name: "Migrations", text: "" });
  });
  test("start_session for a new project: in the projects root; with none, the app says so", async () => {
    assert.deepEqual(await opening("Make a new project called Pixel.", { project: "Pixel", newProject: true }), { action: "start", folder: "pixel", how: "new", name: "", text: "" });
    assert.deepEqual(await opening("Make a new project called Pixel.", { project: "Pixel", newProject: true }, { newProjectRoot: null }), {
      action: "say",
      text: "I don't know where your projects go. Set a projects root in Settings, under New sessions.",
    });
  });
  test("start_session with nothing named and nothing that asks for a session: asked first", async () => {
    assert.deepEqual(await opening("Can we add a dark mode?", { prompt: "Add a dark mode" }), { action: "ask_user", text: "Want me to open a new session for that?" });
    // The answer to the app's offer is a yes.
    assert.equal((await opening("Yes, please.", { prompt: "Add a dark mode" }, { appAsked: true })).action, "start");
  });
  test("rename at 'messages': refused; at 'everything': renamed", async () => {
    const rename = (s: Map<string, Session>) => [{ name: "rename_session", session: s.get("clipkit")!, newName: "snippy" }] as Action[];
    assert.equal(only((await run("Rename clipkit to snippy.", { classifier: { audienceConfidence: 0.3 }, router: { actions: rename } })).outcomes).action, "refused");
    assert.deepEqual(only((await run("Rename clipkit to snippy.", { voiceCan: "everything", classifier: { audienceConfidence: 0.3 }, router: { actions: rename } })).outcomes), {
      action: "rename",
      to: "clipkit",
      name: "snippy",
    });
  });
});

describe("'Voice can' and reach when sending", () => {
  test("replies: a reply to the waiting session goes", async () => {
    const d = await run("Yes.", { voiceCan: "replies", waiting: waits("clipkit"), classifier: { audience: "clipkit" } });
    assert.equal(only(d.outcomes).action, "send");
  });
  test("replies: anything else is refused", async () => {
    const d = await run("Run the tests.", { voiceCan: "replies", classifier: { audience: "lacy-platform" } });
    assert.deepEqual(only(d.outcomes), { action: "refused", what: "message", to: "lacy-platform" });
  });
  test("a desktop session isn't typed into: unreachable, like a terminal none finds", async () => {
    const d = await run("What about 30 plus 30?", { classifier: { audience: "2 plus 2" } });
    assert.equal((only(d.outcomes) as { via: string }).via, "unreachable");
  });
  test("a background session can't be typed into", async () => {
    const d = await run("Commit it.", { classifier: { audienceConfidence: 0.2 }, router: { actions: (s) => [{ name: "pass_on", session: s.get("pixie")! }] } });
    assert.equal((only(d.outcomes) as { via: string }).via, "unreachable");
  });
  test("ask_session is gated like a message", async () => {
    const d = await run("Ask clipkit what's next.", {
      voiceCan: "replies",
      classifier: { audienceConfidence: 0.3 },
      router: { actions: (s) => [{ name: "ask_session", session: s.get("clipkit")!, message: "What's next?" }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "refused", what: "message", to: "clipkit" });
  });
});

describe("repeats and corrections", () => {
  const yeah = { sessionId: "id-claude-code-speech", folder: "claude-code-speech", text: "Yeah." };
  test("'repeat the last clipkit message' repeats clipkit's, not the last thing said", async () => {
    const d = await run("So can you repeat the last clipkit message? I lost track of where we were.", {
      lastSent: yeah,
      classifier: { intent: "repeat", intentConfidence: 0.82, audience: "app", audienceConfidence: 0.3 },
    });
    assert.equal(d.layer, "classifier-intent");
    assert.deepEqual(only(d.outcomes), { action: "repeat", to: "clipkit" });
  });
  test("'repeat that' repeats the last thing said", async () => {
    const d = await run("Can you repeat that?", { classifier: { intent: "repeat", intentConfidence: 0.95 } });
    assert.deepEqual(only(d.outcomes), { action: "repeat" });
  });
  test("a correction right after a repeat redoes the repeat for the session named, never a resend", async () => {
    const d = await run("No, I meant the clip kit session, not the cloud code session.", {
      lastRepeat: true,
      classifier: { intent: "redirect", intentConfidence: 0.91, audience: "app", audienceConfidence: 0.32 },
      router: { actions: (s) => [{ name: "resend_to", session: s.get("clipkit")! }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "repeat", to: "clipkit" });
    assert.equal(d.calls.router, 0);
  });
  test("a bare 'Yeah.' is never resent to another session: the app asks instead", async () => {
    const d = await run("No, I said the clipkit session, not Claude code session.", {
      lastSent: yeah,
      classifier: { intent: "redirect", intentConfidence: 0.91, audience: "app", audienceConfidence: 0.32 },
    });
    const o = only(d.outcomes);
    assert.equal(o.action, "ask_user");
    assert.match((o as { text: string }).text, /didn't send it on/);
  });
  test("…nor through the router's resend_to", async () => {
    const d = await run("That was for clipkit.", {
      lastSent: yeah,
      classifier: { intent: "message", audience: "app", audienceConfidence: 0.3 },
      router: { actions: (s) => [{ name: "resend_to", session: s.get("clipkit")! }] },
    });
    assert.equal(only(d.outcomes).action, "ask_user");
  });
  test("a real message is still resent", async () => {
    const d = await run("No, that was for clipkit.", {
      lastSent: { ...yeah, text: "Cut a new dev build." },
      classifier: { intent: "redirect", intentConfidence: 0.9, audience: "app", audienceConfidence: 0.3 },
    });
    assert.deepEqual(only(d.outcomes), { action: "resend", to: "clipkit", text: "Cut a new dev build.", via: "terminal" });
  });
  test("resend_to with nothing to correct says so", async () => {
    const d = await run("That was for clipkit.", {
      classifier: { audience: "app", audienceConfidence: 0.3 },
      router: { actions: (s) => [{ name: "resend_to", session: s.get("clipkit")! }] },
    });
    assert.equal(only(d.outcomes).action, "say");
  });
});

describe('a name beats another session\'s title (claude-code-speech also titled "random")', () => {
  const w = makeWorld([CAST.voice, CAST.clipkit, CAST.random]);
  const opts = { world: w, sessions: w.sessions, notes: w.notes, voiceCan: "everything" as const, classifier: { audience: "app", audienceConfidence: 0.3 } };
  test("rename_session on the titled one goes to the one named random", async () => {
    const d = await run("Rename the random session to mountains.", {
      ...opts,
      router: { actions: (s) => [{ name: "rename_session", session: s.get("claude-code-speech")!, newName: "mountains" }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "rename", to: "random", name: "mountains" });
  });
  test("the new name doesn't count as naming a session", async () => {
    const d = await run("Rename clipkit to random.", {
      ...opts,
      router: { actions: (s) => [{ name: "rename_session", session: s.get("clipkit")!, newName: "random" }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "rename", to: "clipkit", name: "random" });
  });
  test("two sessions with that name: asks which", async () => {
    const two = makeWorld([
      { name: "voice-a", folder: "claude-code-speech", title: "in-app settings" },
      { name: "voice-b", folder: "claude-code-speech", title: "random" },
    ]);
    const d = await run("Rename the claude code speech session to tests.", {
      ...opts,
      world: two,
      sessions: two.sessions,
      notes: two.notes,
      router: { actions: (s) => [{ name: "rename_session", session: s.get("voice-b")!, newName: "tests" }] },
    });
    assert.equal(only(d.outcomes).action, "ask_user");
  });
  test("stop_session on the titled one isn't moved to the one named: it asks (a stop once moved to another session)", async () => {
    const d = await run("Stop the random session, it's looping.", { ...opts, router: { actions: (s) => [{ name: "stop_session", session: s.get("claude-code-speech")! }] } });
    assert.deepEqual(only(d.outcomes), { action: "ask_user", text: "Stop which one? Say its name." });
  });
  test("'Stop the random session.' alone: the code reads the name (the desktop one, which can't be stopped from here)", async () => {
    const d = await run("Stop the random session.", { ...opts, router: { actions: (s) => [{ name: "stop_session", session: s.get("claude-code-speech")! }] } });
    assert.deepEqual(only(d.outcomes), { action: "stop", to: "random", via: "unreachable" });
    assert.equal(d.calls.router, 0);
  });
});

describe("a session with a name of its own (/rename) is reached by it, its folder or its title", () => {
  const w = makeWorld([{ ...CAST.voice, name: "cloud speech", folder: "claude-code-speech", given: "cloud speech" }, CAST.clipkit, CAST.twoPlusTwo]);
  const opts = { world: w, sessions: w.sessions, notes: w.notes };
  for (const said of ["Tell cloud speech to run the tests.", "Claude code speech, run the tests."]) {
    test(JSON.stringify(said), async () => {
      const d = await run(said, opts);
      assert.equal(d.layer, "addressed");
      assert.deepEqual(only(d.outcomes), { action: "send", to: "cloud speech", text: "Run the tests.", via: "terminal" });
    });
  }
  test("asking which says the names the screen shows", async () => {
    const two = makeWorld([
      { name: "cloud speech", folder: "claude-code-speech", given: "cloud speech" },
      { name: "voice-b", folder: "claude-code-speech", title: "Capital of France" },
    ]);
    const d = await run("Rename the claude code speech session to tests.", {
      world: two,
      sessions: two.sessions,
      notes: two.notes,
      voiceCan: "everything",
      classifier: { audience: "app", audienceConfidence: 0.3 },
      router: { actions: (s) => [{ name: "rename_session", session: s.get("voice-b")!, newName: "tests" }] },
    });
    assert.deepEqual(only(d.outcomes), { action: "ask_user", text: "Rename which one? cloud speech or claude code speech, Capital of France?" });
  });
});
