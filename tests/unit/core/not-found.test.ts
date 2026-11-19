// Never silent (src/core/router.ts, src/core/decide.ts): a router call for a session handle it wasn't
// given comes back as dropped, with the handle, and decide() says what it couldn't find; one for a
// session still starting, named by its folder or name, goes to it. A question for Dozer once went to "2026-10-29-dozer",
// a session still at Claude Code's trust prompt, and nothing was said.
import "../../setup.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { decide, handleName, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { Router, type Action, type Dropped } from "../../../src/core/router.ts";
import { STARTING, type Session } from "../../../src/core/sessions.ts";
import { CAST, HOME, makeWorld } from "../../support/fixtures.ts";

const world = makeWorld([CAST.voice, CAST.clipkit]);

// Dozer, as the app lists a session it opened that hasn't started yet (core/starting.ts).
const DOZER: Session = {
  sessionId: "starting-dozer",
  name: "Dozer",
  givenName: "Dozer",
  title: "",
  nameSetBy: "app",
  cwd: `${HOME}/Kiko/scratch/2026-10-29-dozer`,
  kind: "interactive",
  status: STARTING,
  lastActiveAt: 0,
  desktop: false,
  place: null,
  mapping: "none",
};

const ASK = "Ask Dozer, what the capital of Germany is.";

async function run(router: { actions?: Action[]; dropped?: Dropped[]; text?: string; claimsAction?: boolean }, sessions: Session[] = world.sessions) {
  const deps: DecideDeps = {
    utterance: null,
    approval: null,
    route: async () => ({
      text: router.text ?? "",
      actions: router.actions ?? [],
      claimsAction: router.claimsAction ?? false,
      dropped: router.dropped ?? [],
      usage: { input_tokens: 0, output_tokens: 0 },
      costUsd: 0,
    }),
    trim: null,
  };
  const state: DecideState = {
    text: ASK,
    sessions,
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
  };
  return decide(state, deps);
}

const DROPPED: Dropped = { tool: "ask_session", handle: "2026-10-29-dozer", message: "What is the capital of Germany?" };

describe("a session the router made up", () => {
  test("Dozer not listed: said, by the name in its folder", async () => {
    const d = await run({ dropped: [DROPPED] });
    assert.deepEqual(d.actions, [{ type: "say", text: "I don't see a session called dozer.", why: "unknown_session" }]);
  });

  test("Dozer still starting, named by its folder: the ask goes to it (held by the app until it's ready)", async () => {
    const d = await run({ dropped: [DROPPED] }, [...world.sessions, DOZER]);
    assert.equal(d.actions.length, 1);
    const ask = d.actions[0] as { type: string; session: Session; message: string };
    assert.equal(ask.type, "ask");
    assert.equal(ask.session.sessionId, DOZER.sessionId);
    assert.equal(ask.message, DROPPED.message);
  });

  test("Dozer still starting, asked to stop: said it's still starting", async () => {
    const d = await run({ dropped: [{ tool: "stop_session", handle: "Dozer" }] }, [...world.sessions, DOZER]);
    assert.deepEqual(d.actions, [{ type: "say", text: "Dozer is still starting.", why: "session_starting" }]);
  });

  test("a found session's call still goes, and the one not found is said first", async () => {
    const clipkit = world.byName.get("clipkit")!;
    const d = await run({ actions: [{ name: "ask_session", session: clipkit, message: "Dozer, what is the capital of Germany?" }], dropped: [DROPPED] });
    assert.deepEqual(
      d.actions.map((a) => a.type),
      ["say", "ask"],
    );
    assert.equal((d.actions[0] as { text: string }).text, "I don't see a session called dozer.");
  });

  test("the router's own words are said after what wasn't found", async () => {
    const d = await run({ dropped: [{ tool: "pass_on", handle: "rex" }], text: "Which one did you mean?" });
    assert.deepEqual(
      d.actions.map((a) => (a as { text: string }).text),
      ["I don't see a session called rex.", "Which one did you mean?"],
    );
  });

  test("an empty decision stays empty here: the app's backstop says it (app.ts nothingDone)", async () => {
    const d = await run({});
    assert.deepEqual(d.actions, []);
    assert.equal(d.step, "router");
    assert.equal(d.question, undefined);
  });

  test("handle names: a scratch folder's date dropped; a made-up handle like s7 has none", () => {
    assert.equal(handleName("2026-10-29-dozer"), "dozer");
    assert.equal(handleName("atlas-agents"), "atlas agents");
    assert.equal(handleName("s7"), "");
    assert.equal(handleName(""), "");
  });
});

describe("the router returns what it dropped", () => {
  let reply: Array<{ name: string; arguments: object }> = [];
  const realFetch = globalThis.fetch;
  before(() => {
    config.llm = "test/no-network";
    process.env.OPENROUTER_API_KEY = "unit-test-no-network";
    globalThis.fetch = (async () => {
      const completion = {
        choices: [{ message: { content: "", tool_calls: reply.map((r) => ({ function: { name: r.name, arguments: JSON.stringify(r.arguments) } })) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
      return new Response(JSON.stringify(completion), { status: 200 });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  test("ask_session for a handle not in <sessions>: dropped, with the handle and message", async () => {
    reply = [
      { name: "ask_session", arguments: { session: "2026-10-29-dozer", message: "What is the capital of Germany?" } },
      { name: "pass_on", arguments: { session: "s2" } },
    ];
    const result = await new Router().route({ sessions: world.sessions, notes: world.notes, waitingId: null, justSpoke: null, lastId: null, recent: [], text: ASK, voiceCan: "everything" }, () => {});
    assert.equal(result!.actions.length, 1, "s2 is a real handle");
    assert.equal(result!.actions[0].name, "pass_on");
    assert.deepEqual(result!.dropped, [{ tool: "ask_session", handle: "2026-10-29-dozer", message: "What is the capital of Germany?" }]);
  });
});
