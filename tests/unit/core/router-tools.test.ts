// The router (src/core/router.ts) without the network: fetch is stubbed, so these check what it offers
// the model for each "Voice can" level, what its prompt says, and how tool calls become actions.
import "../../setup.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { localNow, placeOf, Router } from "../../../src/core/router.ts";
import { sessionName } from "../../../src/core/sessions.ts";
import { CAST, makeWorld, type VoiceCan } from "../../support/fixtures.ts";

type Captured = { system: string; prompt: string; tools: string[]; folders: string[]; agent: string };
let captured: Captured[] = [];
let reply: Array<{ name: string; arguments: object }> = [];
const realFetch = globalThis.fetch;

before(() => {
  // The OpenRouter path is plain fetch; Haiku's goes through the SDK. Both offer the same tools.
  config.llm = "test/no-network";
  process.env.OPENROUTER_API_KEY = "unit-test-no-network";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const start = body.tools.find((t: any) => t.function.name === "start_session");
    captured.push({
      system: body.messages[0].content,
      prompt: body.messages[1].content,
      tools: body.tools.map((t: any) => t.function.name),
      folders: start?.function.parameters.properties.project.enum ?? [],
      agent: start?.function.parameters.properties.agent.description ?? "",
    });
    const completion = {
      choices: [{ message: { content: "", tool_calls: reply.map((r) => ({ function: { name: r.name, arguments: JSON.stringify(r.arguments) } })) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 },
    };
    return new Response(JSON.stringify(completion), { status: 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy, CAST.twoPlusTwo, CAST.pixie]);
const S = (name: string) => world.byName.get(name)!;

async function route(level: VoiceCan, calls: Array<{ name: string; arguments: object }> = [{ name: "say", arguments: { text: "ok" } }], extra: Partial<Parameters<Router["route"]>[0]> = {}) {
  captured = [];
  reply = calls;
  const result = await new Router().route(
    { sessions: world.sessions, notes: world.notes, waitingId: null, justSpoke: null, lastId: null, recent: [], text: "hello", voiceCan: level, ...extra },
    () => {},
  );
  assert.equal(captured.length, 1, "one model call");
  return { result: result!, sent: captured[0] };
}

const MANAGING = ["stop_session", "rename_session", "start_session"];

describe("tools offered per 'Voice can' level", () => {
  // Every level gets the tools and the same rules: the app refuses what the level doesn't allow, in
  // its own words (the setting's path and the offer to turn it on: core/voice-off.ts). The router
  // saying "Starting sessions is off in settings." named no setting (2026-11-02).
  for (const level of ["replies", "messages"] as const) {
    test(`${level}: start, stop and rename offered all the same; the prompt never says they're off`, async () => {
      const { sent } = await route(level);
      for (const tool of [...MANAGING, "say", "pass_on", "ask_session"]) assert.ok(sent.tools.includes(tool), `${tool} missing at ${level}`);
      assert.match(sent.system, /call start_session and say nothing/);
      assert.doesNotMatch(sent.system, /turned off in the app's settings|is off in settings/);
      assert.match(sent.system, /Never say yourself that something is off, turned off or not allowed in the settings/);
      assert.doesNotMatch(sent.prompt, /new_session_default_folder/);
    });
  }
  test("the instructions and tools are the same at messages and everything (one cached prefix)", async () => {
    const a = await route("messages");
    const b = await route("everything");
    assert.equal(a.sent.system, b.sent.system);
    assert.deepEqual(a.sent.tools, b.sent.tools);
  });
  test("everything: start, stop and rename too", async () => {
    const { sent } = await route("everything");
    for (const tool of [...MANAGING, "say", "pass_on", "ask_session"]) assert.ok(sent.tools.includes(tool), `${tool} missing`);
    assert.match(sent.system, /call stop_session/);
    assert.match(sent.system, /A bare "stop" is the user cutting you off/);
    // No folder of the app's own for new sessions: the app finds the project's.
    assert.doesNotMatch(sent.prompt, /new_session_default_folder/);
    assert.match(sent.system, /call start_session and say nothing/);
  });
  test("no session handles or folders in the tools: they're cached, the same whatever is running", async () => {
    const { sent } = await route("everything");
    assert.deepEqual(sent.folders, []);
    assert.match(sent.prompt, /s2: clipkit/);
  });
  test("replies: the prompt says words only reach a waiting session", async () => {
    const { sent } = await route("replies");
    assert.match(sent.system, /only reply to a session that's waiting for a reply/);
  });
  test("messages: background and desktop app sessions can't be sent to, and words for them still go to them", async () => {
    const { sent } = await route("messages");
    assert.match(sent.system, /Background and desktop app sessions can't be sent to, stopped or renamed; they only take a reply right after they speak/);
    assert.match(sent.system, /still call pass_on with the one they're for; the app tells the user it couldn't send them/);
    assert.doesNotMatch(sent.system, /Desktop app sessions take messages/);
  });
});

describe("the prompt", () => {
  test("has the user's local date and time, for 'what time is it?'", async () => {
    const { sent } = await route("messages");
    assert.match(sent.prompt, /<now>\w+day \d{1,2} \w+ \d{4}, \d{1,2}:\d{2} [ap]m, [\w/+-]+<\/now>/);
    assert.match(sent.system, /the time, the date or the day, answer with say from <now>/);
    assert.equal(localNow(new Date(2026, 9, 26, 17, 29)).replace(/, [^,]+$/, ""), "Monday 26 October 2026, 5:29 pm");
  });
  test("a renamed session: its name, then its folder and title", async () => {
    const w = makeWorld([{ name: "cloud speech", folder: "claude-code-speech", given: "cloud speech", title: "Voice app notes and settings" }]);
    captured = [];
    reply = [{ name: "say", arguments: { text: "ok" } }];
    await new Router().route({ sessions: w.sessions, notes: w.notes, waitingId: null, justSpoke: null, lastId: null, recent: [], text: "hi", voiceCan: "messages" }, () => {});
    assert.match(captured[0].prompt, /s1: cloud speech \(folder claude-code-speech, title "Voice app notes and settings"\) · idle/);
    assert.doesNotMatch(captured[0].prompt, /user gave|app gave|nameSetBy/);
  });
  test("lists sessions by spoken name with kind, and marks waiting / just spoke / dealt with last", async () => {
    const { sent } = await route("messages", undefined, {
      waitingId: S("clipkit").sessionId,
      justSpoke: null,
      lastId: S("claude-code-speech").sessionId,
    });
    assert.match(sent.prompt, /s1: claude-code-speech \(title "random"\) · busy · active \d+s ago · open in a terminal/);
    assert.match(sent.prompt, /s4: 2 plus 2 · idle · active 2h ago · desktop app/);
    assert.match(sent.prompt, /s5: pixie · blocked · active 1m ago · background/);
    assert.match(sent.prompt, /<waiting_for_reply>s2<\/waiting_for_reply>/);
    assert.match(sent.prompt, /<dealt_with_last>s1<\/dealt_with_last>/);
    assert.doesNotMatch(sent.prompt, /just_spoke_to_you/);
    assert.match(sent.prompt, /The user said: hello$/);
  });
  test("a T3 thread: in T3 Code, taking messages any time, with what it was last asked and said; a Claude Code session's line as before", async () => {
    const w = makeWorld([
      { name: "general", folder: "2026-01-14-general", given: "general", activeAgoS: 3480, asked: "What's the capital of France?", said: "The capital of Portugal is Lisbon." },
      { name: "hello from t3", folder: "workbench", given: "hello from t3", t3: true, activeAgoS: 960, asked: "What about Germany?", said: "The capital of Germany is Berlin." },
    ]);
    captured = [];
    reply = [{ name: "say", arguments: { text: "ok" } }];
    await new Router().route({ sessions: w.sessions, notes: w.notes, waitingId: null, justSpoke: null, lastId: null, recent: [], text: "What's active?", voiceCan: "messages" }, () => {});
    const prompt = captured[0].prompt;
    assert.match(
      prompt,
      /s1: general \(folder 2026-01-14-general\) · idle · active 58m ago · open in a terminal\n    last asked: What's the capital of France\?\n    last said: The capital of Portugal is Lisbon\.\n/,
    );
    assert.match(
      prompt,
      /s2: hello from t3 \(folder workbench\) · idle · active 16m ago · in T3 Code, takes messages any time; can be stopped and renamed\n    last asked: What about Germany\?\n    last said: The capital of Germany is Berlin\.\n/,
    );
    assert.equal(placeOf({ ...w.sessions[1], place: null }), "in T3 Code, not reachable now");
    assert.match(captured[0].system, /never by their folder when that differs/);
  });
  test("just spoke to you, when given", async () => {
    const { sent } = await route("messages", undefined, { justSpoke: { id: S("clipkit").sessionId, secondsAgo: 2 } });
    assert.match(sent.prompt, /<just_spoke_to_you>s2, 2s ago \(its reply window has closed\)<\/just_spoke_to_you>/);
  });
});

describe("tool calls → actions", () => {
  test("pass_on, ask_session and resend_to name sessions by handle", async () => {
    const { result } = await route("messages", [
      { name: "pass_on", arguments: { session: "s2" } },
      { name: "ask_session", arguments: { session: "s4", message: "What's 4 plus 4?" } },
      { name: "resend_to", arguments: { session: "s2" } },
    ]);
    assert.deepEqual(
      result.actions.map((a) => [a.name, "session" in a ? sessionName(a.session) : null]),
      [
        ["pass_on", "clipkit"],
        ["ask_session", "2 plus 2"],
        ["resend_to", "clipkit"],
      ],
    );
    assert.equal(result.costUsd, 0.0001);
  });
  // The router once offered a session in its own words in say ("… I can pass your question along to it
  // if you want."), no tool, and the yes after it was what got passed on. An offer is a tool call now, and a sure one isn't offered.
  test("offer_session: a session offered by handle, offered at every level, and the prompt forbids offering in words", async () => {
    for (const level of ["replies", "messages", "everything"] as const) {
      const { result, sent } = await route(level, [{ name: "offer_session", arguments: { session: "s2" } }]);
      assert.ok(sent.tools.includes("offer_session"), level);
      assert.deepEqual(
        result.actions.map((a) => [a.name, "session" in a ? sessionName(a.session) : null]),
        [["offer_session", "clipkit"]],
      );
      assert.match(sent.system, /Never offer it in words \("I can pass your question along to Bobby if you want", "want me to send it to Bobby\?"\)/);
      assert.match(sent.system, /call pass_on with it without asking first/);
      assert.match(sent.system, /Only when you can't tell whether the words are for you or for a session, or which of two sessions, call offer_session/);
      assert.match(sent.system, /What's yours stays yours: questions about the sessions, the time, the settings, and plain chat with you\./);
    }
    assert.deepEqual((await route("messages", [{ name: "offer_session", arguments: { session: "s9" } }])).result.actions, [], "an unknown handle is dropped");
  });
  test("an unknown handle is dropped", async () => {
    const { result } = await route("messages", [{ name: "pass_on", arguments: { session: "s9" } }]);
    assert.deepEqual(result.actions, []);
    for (const session of ["clipkit", "none", "", "s0"]) {
      assert.deepEqual((await route("messages", [{ name: "pass_on", arguments: { session } }])).result.actions, [], session);
    }
  });
  test("a handle written loosely still counts", async () => {
    const { result } = await route("messages", [{ name: "pass_on", arguments: { session: " S2" } }]);
    assert.deepEqual(
      result.actions.map((a) => "session" in a && sessionName(a.session)),
      ["clipkit"],
    );
  });
  test("say only: spoken text, no actions", async () => {
    const { result } = await route("messages", [{ name: "say", arguments: { text: "Which one, clipkit or lacy platform?" } }]);
    assert.deepEqual(result.actions, []);
    assert.equal(result.text, "Which one, clipkit or lacy platform?");
  });
  test("say's claims_action comes back as claimsAction", async () => {
    const { result, sent } = await route("messages", [{ name: "say", arguments: { text: "Got it, I'll leave it.", claims_action: true } }]);
    assert.equal(result.claimsAction, true);
    assert.match(sent.system, /say never sends, passes on, asks or does anything/);
    assert.equal((await route("messages", [{ name: "say", arguments: { text: "Five sessions.", claims_action: false } }])).result.claimsAction, false);
  });
  test("start_session: the project as said (a handle as its folder), its name and first message; the app finds the folder", async () => {
    const { result } = await route("everything", [
      { name: "start_session", arguments: { project: "Pixy", new_project: false, name: "", prompt: "Fix the login bug." } },
      { name: "start_session", arguments: { project: "", new_project: false, name: " Clipkit ", prompt: "" } },
      { name: "start_session", arguments: { project: "s2", new_project: false, name: "", prompt: "" } },
      { name: "start_session", arguments: { project: "Pixel", new_project: true, name: "", prompt: "" } },
      // A new project needs its name.
      { name: "start_session", arguments: { project: "", new_project: true, name: "", prompt: "hi" } },
    ]);
    assert.deepEqual(result.actions, [
      { name: "start_session", project: "Pixy", newProject: false, sessionName: "", prompt: "Fix the login bug." },
      { name: "start_session", project: null, newProject: false, sessionName: "Clipkit", prompt: "" },
      { name: "start_session", project: "clipkit", newProject: false, sessionName: "", prompt: "" },
      { name: "start_session", project: "Pixel", newProject: true, sessionName: "", prompt: "" },
      { name: "start_session", project: null, newProject: false, sessionName: "", prompt: "hi" },
    ]);
  });
  test("start_session's agent: one it starts in a terminal, or T3 Code, whose threads it starts there, so 'a session in T3 code' isn't taken as a project", async () => {
    const { result, sent } = await route("everything", [
      { name: "start_session", arguments: { project: "", new_project: false, name: "", prompt: "", agent: "t3code" } },
      { name: "start_session", arguments: { project: "pixie", new_project: false, name: "", prompt: "", agent: "codex" } },
      { name: "start_session", arguments: { project: "pixie", new_project: false, name: "", prompt: "", agent: "made-up" } },
    ]);
    assert.deepEqual(
      result.actions.map((a) => (a.name === "start_session" ? a.agent : a.name)),
      ["t3code", "codex", undefined],
    );
    assert.match(sent.agent, /"codex" for Codex/);
    assert.match(
      sent.agent,
      /"t3code" for T3 Code too: set it when they ask for one \("open a new session in T3 Code" → "t3code"\), also when they name another agent to run it \("a T3 Code thread on Codex" → "t3code"\), never as the project or the name; the app starts it in T3 Code itself/,
    );
    assert.match(sent.system, /"t3code" when they say T3 Code or T3, even with another agent named too, "a T3 thread on Codex": the app starts a thread in T3 Code/);
  });
  test("quick_task: a session's folder → its cwd; home or anything else → home", async () => {
    const { result } = await route("everything", [
      { name: "quick_task", arguments: { task: "git status?", folder: "clipkit" } },
      { name: "quick_task", arguments: { task: "disk space?", folder: "home" } },
      { name: "quick_task", arguments: { task: "disk space?", folder: "nowhere" } },
    ]);
    assert.deepEqual(
      result.actions.map((a) => (a.name === "quick_task" ? a.cwd : null)),
      [S("clipkit").cwd, homedir(), homedir()],
    );
  });
  test("rename_session keeps the name as said", async () => {
    const { result } = await route("everything", [{ name: "rename_session", arguments: { session: "s1", name: "claude speech" } }]);
    const a = result.actions[0];
    assert.equal(a.name, "rename_session");
    assert.equal(a.name === "rename_session" && a.newName, "claude speech");
  });
});
