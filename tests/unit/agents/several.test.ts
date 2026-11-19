// Several agents at once (src/agents/index.ts `together`): every agent's sessions listed together,
// what's about one session going to the agent it belongs to, the rest to the main one (Claude Code),
// and every agent's events reaching the callbacks core sets on the whole.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentOf, agents, mainAgent, together } from "../../../src/agents/index.ts";
import type { Agent, AgentSession, Held } from "../../../src/agents/types.ts";

function fake(id: string, sessions: AgentSession[] | Error, owns?: (sessionId: string) => boolean): Agent & { started: number; stopped: number } {
  const a = {
    id,
    name: id.toUpperCase(),
    started: 0,
    stopped: 0,
    owns,
    onNotice: () => {},
    onHeld: () => {},
    onSessionsChanged: () => {},
    onPromptSubmitted: () => {},
    onSessionEnded: () => {},
    async start() {
      a.started++;
      if (id === "broken") throw new Error("no server");
    },
    stop() {
      a.stopped++;
    },
    list: async () => {
      if (sessions instanceof Error) throw sessions;
      return sessions;
    },
    names: () => ({ givenName: `${id} name`, title: "" }),
    lastAsked: () => `${id} asked`,
    lastSaid: () => `${id} said`,
    watchHistory: () => ({ stop() {} }),
    historyFile: () => (id === "main" ? "/main.jsonl" : ""),
    madeUpFolder: (cwd: string) => id === "other" && cwd === "/made-up",
    heldReplies: id === "main" ? 7 : 0,
    interruptKey: "escape",
    renameCommand: (name: string) => (id === "main" ? `/rename ${name}` : ""),
    exitCommand: id === "main" ? "/exit" : "",
    startCommand: () => ({ program: id, args: [] }),
    knownFolders: () => [{ cwd: `/${id}`, names: [], lastUsed: 0 }],
  };
  return a;
}

const session = (sessionId: string): AgentSession => ({
  sessionId,
  name: sessionId,
  givenName: "",
  title: "",
  cwd: "/x",
  kind: "interactive",
  status: "idle",
  lastActiveAt: 0,
  desktop: false,
  titles: [],
});

describe("several agents together", () => {
  test("lists every agent's sessions, the others' marked with their agent", async () => {
    const main = fake("main", [session("m1")]);
    const other = fake("other", [session("o:1")], (id) => id.startsWith("o:"));
    const all = together(main, [main, other]);
    const listed = await all.list();
    assert.deepEqual(
      listed.map((s) => [s.sessionId, s.agent]),
      [
        ["m1", undefined],
        ["o:1", "other"],
      ],
    );
  });

  test("another agent failing to list leaves the main one's list; the main one's failing is the listing's", async () => {
    const fine = fake("main", [session("m1")]);
    const all = together(fine, [fine, fake("other", new Error("down"))]);
    assert.deepEqual(
      (await all.list()).map((s) => s.sessionId),
      ["m1"],
    );
    const failing = fake("main", new Error("claude agents failed"));
    await assert.rejects(together(failing, [failing, fake("other", [])]).list(), /claude agents failed/);
  });

  test("what's about one session goes to its own agent; the rest is the main one's", () => {
    const main = fake("main", []);
    const other = fake("other", [], (id) => id.startsWith("o:"));
    const all = together(main, [main, other]);
    assert.equal(all.lastSaid({ sessionId: "o:1", cwd: "/x" }), "other said");
    assert.equal(all.lastSaid({ sessionId: "m1", cwd: "/x" }), "main said");
    assert.equal(all.historyFile({ sessionId: "o:1", cwd: "/x" }), "");
    assert.equal(all.names({ sessionId: "o:1", cwd: "/x" }).givenName, "other name");
    assert.equal(all.madeUpFolder("/made-up"), true);
    assert.equal(all.heldReplies, 7);
    assert.equal(all.exitCommand, "/exit");
    assert.equal(all.renameCommand("x"), "/rename x");
    assert.deepEqual(
      all.knownFolders().map((f) => f.cwd),
      ["/main"],
    );
  });

  test("every agent's events reach the callbacks set on the whole", () => {
    const main = fake("main", []);
    const other = fake("other", [], (id) => id.startsWith("o:"));
    const all = together(main, [main, other]);
    const heard: string[] = [];
    all.onHeld = (held) => heard.push(`held ${held.sessionId}`);
    all.onNotice = (line) => heard.push(`notice ${line}`);
    all.onSessionsChanged = () => heard.push("changed");
    other.onHeld({ sessionId: "o:1" } as Held);
    other.onNotice("updated");
    main.onSessionsChanged();
    assert.deepEqual(heard, ["held o:1", "notice updated", "changed"]);
  });

  test("the main agent's start failing is the app's; another's isn't", async () => {
    const main = fake("main", []);
    const broken = fake("broken", []);
    const all = together(main, [main, broken]);
    await all.start();
    assert.equal(broken.started, 1);
    all.stop();
    assert.equal(main.stopped + broken.stopped, 2);
  });

  test("agentOf: a session with no agent of its own is the main agent's", () => {
    assert.equal(agentOf({ sessionId: "some-claude-session" }), mainAgent);
    assert.equal(agentOf({ sessionId: "x", agent: "nobody-knows-it" }), mainAgent);
  });

  // "In T3, Claude said hello world." was once said for a T3 Code thread on Codex.
  test("who speaks in each agent's sessions, as their summaries say it: Claude, Codex, OpenCode; T3 Code's can't tell (it)", () => {
    assert.deepEqual(Object.fromEntries(agents.map((a) => [a.id, a.speaker ?? null])), { "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", t3code: null });
  });
});
