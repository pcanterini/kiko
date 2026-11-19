// What became of the phone's words (src/remote/talk-status.ts, talk_status): the stages in order,
// held then delivered, the ways it fails, Kiko answering itself, started (Claude Code's
// UserPromptSubmit, or the turn's end), and the handling's talk found however deep it runs. Then
// through a real server (src/remote/server.ts): the talkId reaches the app, a press or typed message
// turned down there fails at once, statuses go only to the phone they're for, and come again as it
// reconnects.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type ErrorCode, type PhoneHub } from "../../../src/remote/server.ts";
import { REPLIED_WITHIN_MS, STARTED_WITHIN_MS, Talks, type TalkStatus } from "../../../src/remote/talk-status.ts";
import { heldOf } from "../../../src/agents/t3code/index.ts";
import { checkWaits } from "../../support/until.ts";

const LACY = { sessionId: "s-lacy", name: "lacy" };
const CLIPKIT = { sessionId: "s-clipkit", name: "clipkit" };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Talks whose statuses are kept, each checked against the schema as the hub would send it. */
function setUp(now = () => Date.now()) {
  const sent: Array<{ phoneId: string } & TalkStatus> = [];
  const talks = new Talks((phoneId, status) => {
    assert.equal(invalid({ v: 1, type: "talk_status", ...status }, "hub"), null, JSON.stringify(status));
    sent.push({ phoneId, ...status });
  }, now);
  const stages = (talkId?: string) => sent.filter((s) => !talkId || s.talkId === talkId).map((s) => s.stage);
  return { talks, sent, stages };
}

describe("a talk's stages", () => {
  test("typed into a busy session: heard, routed, delivered (queued), then started as it takes the words in", async () => {
    const { talks, sent, stages } = setUp();
    const talk = talks.begin("t1", "phone-1")!;
    talk.heard("Tell Lacy to commit.");
    await talks.run(talk, async () => {
      await wait(1);
      talks.routed(LACY);
      await wait(1);
      talks.delivered(LACY, "Commit.", { queued: true });
    });
    talk.finish("Not sent");
    assert.deepEqual(stages(), ["heard", "routed", "delivered"], "delivered: finish leaves it");
    assert.deepEqual(sent[0], { phoneId: "phone-1", talkId: "t1", stage: "heard", text: "Tell Lacy to commit." });
    assert.deepEqual(sent[1], { phoneId: "phone-1", talkId: "t1", stage: "routed", sessionId: "s-lacy", name: "lacy" });
    assert.deepEqual(sent[2], { phoneId: "phone-1", talkId: "t1", stage: "delivered", sessionId: "s-lacy", name: "lacy", text: "Commit.", queued: true });
    // Another session taking a prompt in, or Lacy taking other words: not this one.
    talks.promptSubmitted(["s-clipkit"], "Commit.");
    talks.promptSubmitted(["s-lacy"], "Run the tests.");
    assert.deepEqual(stages(), ["heard", "routed", "delivered"]);
    // Lacy finished and took it in, with another message queued meanwhile (one prompt, two lines).
    talks.promptSubmitted(["s-other-id", "s-lacy"], "Commit.\n\nAnd push.");
    assert.deepEqual(stages(), ["heard", "routed", "delivered", "started"]);
    assert.deepEqual(sent[3], { phoneId: "phone-1", talkId: "t1", stage: "started", sessionId: "s-lacy", name: "lacy" });
    talks.promptSubmitted(["s-lacy"], "Commit.");
    talk.failed("late");
    talk.routed(CLIPKIT);
    talk.answered();
    assert.equal(sent.length, 4, "started: only replied can follow");
    // Another session's turn ending isn't its reply; Lacy's is.
    talks.turnEnded(["s-clipkit"], () => []);
    assert.equal(sent.length, 4);
    talks.turnEnded(["s-lacy"], () => []);
    assert.deepEqual(stages(), ["heard", "routed", "delivered", "started", "replied"]);
    assert.deepEqual(sent[4], { phoneId: "phone-1", talkId: "t1", stage: "replied", sessionId: "s-lacy", name: "lacy" });
    talks.turnEnded(["s-lacy"], () => []);
    talk.failed("late");
    assert.equal(sent.length, 5, "replied ends it");
  });

  test("held (a send held a moment, or waiting for a finished turn to be read out), then delivered as its reply: started at once", async () => {
    const { talks, sent, stages } = setUp();
    const talk = talks.begin("t2", "phone-1")!;
    talk.heard();
    let later: (() => void) | null = null;
    await talks.run(talk, async () => {
      talks.routed(LACY);
      const waiting = talks.held(LACY, "Waiting for lacy's answer to be read out");
      // What delivers them later runs from somewhere else (the floor, once it's been read out).
      later = () => talks.run(waiting, () => talks.delivered(LACY, "Yes, commit.", { started: true }));
    });
    talk.finish("Not sent");
    assert.deepEqual(stages(), ["heard", "routed", "held"], "held: still to go, finish leaves it");
    assert.equal(sent[2].detail, "Waiting for lacy's answer to be read out");
    assert.deepEqual(talks.current(), [], "outside its handling, no talk");
    setTimeout(() => later!(), 5);
    await wait(20);
    assert.deepEqual(stages(), ["heard", "routed", "held", "delivered", "started"]);
    assert.equal(sent[3].queued, undefined);
    // The turn it was given as the reply to ended before; the next one is its reply.
    talks.turnEnded(["s-lacy"], () => null);
    assert.deepEqual(stages(), ["heard", "routed", "held", "delivered", "started", "replied"]);
  });

  test("nothing to send: routed to Kiko itself, then answered as its handling ends", () => {
    const { talks, sent, stages } = setUp();
    const talk = talks.begin("t3", "phone-1")!;
    talk.heard("What time is it?");
    talks.run(talk, () => talks.routed(null));
    talk.finish("Not sent");
    assert.deepEqual(stages(), ["heard", "routed", "answered"]);
    assert.deepEqual([sent[1].sessionId, sent[1].name, sent[2].sessionId], [null, null, null]);
  });

  test("never swallowed: routed and never delivered fails; a refusal says why; nothing heard says so", () => {
    const { talks, sent, stages } = setUp();
    // Voice can't type into sessions, say: the send stopped quietly before typing.
    const a = talks.begin("a", "p")!;
    a.heard("Commit.");
    talks.run(a, () => talks.routed(LACY));
    a.finish("Not sent");
    assert.deepEqual(stages("a"), ["heard", "routed", "failed"]);
    assert.deepEqual([sent.at(-1)!.detail, sent.at(-1)!.sessionId], ["Not sent", "s-lacy"]);
    // tmux refused to type it.
    const b = talks.begin("b", "p")!;
    talks.run(b, () => {
      talks.routed(LACY);
      talks.failed("Not sent: its pane changed");
    });
    b.finish("Not sent");
    assert.deepEqual(stages("b"), ["routed", "failed"]);
    assert.equal(sent.at(-1)!.detail, "Not sent: its pane changed");
    // Nothing heard at all.
    const c = talks.begin("c", "p")!;
    c.finish("Nothing heard");
    assert.deepEqual(stages("c"), ["failed"]);
    assert.equal(sent.at(-1)!.sessionId, undefined, "no session to name");
  });

  test("several sessions asked: routed to each in turn; one delivered stands even if another fails", () => {
    const { talks, stages } = setUp();
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => {
      talks.routed(LACY);
      talks.routed(LACY);
      talks.routed(CLIPKIT);
      talks.delivered(CLIPKIT, "Status?");
      talks.failed("Not sent to lacy");
      talks.routed(LACY);
      talks.held(LACY, "x");
    });
    assert.deepEqual(stages(), ["routed", "routed", "delivered"]);
  });

  test("stages only move forward, and only once delivered can it start", () => {
    const { talks, stages } = setUp();
    const talk = talks.begin("t", "p")!;
    talk.started();
    talk.routed(LACY);
    talk.heard("late words");
    talk.answered();
    talk.routed(LACY);
    talk.failed("x");
    assert.deepEqual(stages(), ["routed", "answered"]);
  });

  test("no talkId (an older app): no talk, nothing told, and its handling is no one's", async () => {
    const { talks, sent } = setUp();
    assert.equal(talks.begin(null, "p"), null);
    assert.equal(talks.begin(undefined, "p"), null);
    await talks.run(null, async () => {
      talks.routed(LACY);
      talks.delivered(LACY, "x");
    });
    assert.equal(sent.length, 0);
  });

  test("a talk's handling inside another's (null): neither is told", () => {
    const { talks, sent } = setUp();
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => talks.run(null, () => talks.routed(LACY)));
    assert.equal(sent.length, 0);
  });
});

describe("started, from the turn's end", () => {
  test("words typed while it was busy and taken in mid-turn: started when the turn ends with them among its words", () => {
    const { talks, stages } = setUp();
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => talks.delivered(LACY, "Also   add a test.", { queued: true }));
    let reads = 0;
    talks.turnEnded(["s-clipkit"], () => (reads++, ["Also add a test."]));
    assert.equal(reads, 0, "the transcript isn't read for a session nothing waits on");
    talks.turnEnded(["s-lacy"], () => (reads++, ["Fix the bug."]));
    assert.deepEqual(stages(), ["delivered"], "not among its words: still waiting (it comes after)");
    talks.turnEnded(["s-lacy"], () => (reads++, ["Fix the bug.", "Also add a test."]));
    assert.deepEqual(stages(), ["delivered", "started", "replied"], "the turn that took it in has replied to it");
    assert.equal(reads, 2);
  });

  test("delivered but never started: no reply is told, however many turns end", () => {
    const { talks, stages } = setUp();
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => talks.delivered(LACY, "Commit.", { queued: true }));
    talks.turnEnded(["s-lacy"], () => ["Something else."]);
    talks.turnEnded(["s-lacy"], () => ["Something else."]);
    assert.deepEqual(stages(), ["delivered"]);
    talks.promptSubmitted(["s-lacy"], "Commit.");
    talks.turnEnded(["s-lacy"], () => ["Commit."]);
    assert.deepEqual(stages(), ["delivered", "started", "replied"]);
  });

  test("a started talk whose turn never ends is forgotten after a while: no late reply", () => {
    let clock = 1_000_000;
    const { talks, stages } = setUp(() => clock);
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => talks.delivered(LACY, "Commit.", { started: true }));
    clock += REPLIED_WITHIN_MS + 1;
    talks.turnEnded(["s-lacy"], () => null);
    assert.deepEqual(stages(), ["delivered", "started"]);
  });

  test("the log's own words for the phone's first try: heard, routed, delivered (queued), started, then replied at the Stop, each valid on the wire", () => {
    // A press from the home screen, routed to the session named Kiko.
    const { talks, sent } = setUp();
    const KIKO = { sessionId: "b5d81f3a-2e7c-4a19-8d64-0f3b7e9c2a58", name: "Kiko" };
    const talk = talks.begin("7D01886A-3506-4D90-A31E-0595E2A9C3F0", "p-e199c9fd")!;
    const words = "Trying the fresh build I just reopened, checking that the new dot comes up in the phone app as I talk. We'll see how it does.";
    talk.heard(words);
    talks.run(talk, () => {
      talks.routed(KIKO);
      talks.delivered(KIKO, words, { queued: true });
    });
    talk.finish("Not sent");
    talks.promptSubmitted([KIKO.sessionId], words);
    talks.turnEnded([KIKO.sessionId], () => [words]);
    assert.deepEqual(
      sent.map((s) => [s.stage, s.sessionId ?? null, s.name ?? null]),
      [
        ["heard", null, null],
        ["routed", KIKO.sessionId, "Kiko"],
        ["delivered", KIKO.sessionId, "Kiko"],
        ["started", KIKO.sessionId, "Kiko"],
        ["replied", KIKO.sessionId, "Kiko"],
      ],
    );
  });

  test("to a T3 thread: started as its run takes the words in, replied as the run completes, on the T3 id", () => {
    // It stuck at delivered: T3's run start wasn't told, and its finished run had no words of its own.
    const T3 = { sessionId: "t3:th1", name: "hello from t3" };
    const thread = {
      id: "th1",
      projectId: "p1",
      title: "hello from t3",
      worktreePath: null,
      latestRunId: "r2",
      status: "completed",
      pendingRuntimeRequest: null,
      updatedAt: "",
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
    };
    const { talks, sent } = setUp();
    const talk = talks.begin("3276CDE3-3B0C-4E07-A465-4EB2CC211BE3", "p-e199c9fd")!;
    talk.heard("Tell hello from T3. What about Germany?");
    talks.run(talk, () => {
      talks.routed(T3);
      talks.delivered(T3, "What about Germany?");
    });
    talk.finish("Not sent");
    // The run starts with it (t3code's onPromptSubmitted), then completes (onHeld: turnEnded with its words).
    talks.promptSubmitted([T3.sessionId], "What about Germany?");
    const held = heldOf({ thread, said: "The capital of Germany is Berlin.", asked: "What about Germany?", turn: ["What about Germany?"] }, "/code");
    talks.turnEnded([held.sessionId], () => held.saidThisTurn());
    assert.deepEqual(
      sent.map((s) => [s.stage, s.sessionId ?? null, s.name ?? null]),
      [
        ["heard", null, null],
        ["routed", T3.sessionId, T3.name],
        ["delivered", T3.sessionId, T3.name],
        ["started", T3.sessionId, T3.name],
        ["replied", T3.sessionId, T3.name],
      ],
    );

    // A run too quick for its start to be seen: its end has the words, so it's started and replied then.
    const quick = setUp();
    const fast = quick.talks.begin("t2", "p")!;
    quick.talks.run(fast, () => quick.talks.delivered(T3, "And Spain?"));
    const done = heldOf({ thread, said: "Madrid.", asked: "And Spain?" }, "/code");
    assert.deepEqual(done.saidThisTurn(), ["And Spain?"], "no run's words known: what it asked");
    quick.talks.turnEnded([done.sessionId], () => done.saidThisTurn());
    assert.deepEqual(
      quick.sent.map((s) => [s.stage, s.sessionId]),
      [
        ["delivered", T3.sessionId],
        ["started", T3.sessionId],
        ["replied", T3.sessionId],
      ],
    );
  });

  test("one that never starts is forgotten after a while; still delivered", () => {
    let clock = 1_000_000;
    const { talks, stages } = setUp(() => clock);
    const talk = talks.begin("t", "p")!;
    talks.run(talk, () => talks.delivered(LACY, "Commit."));
    clock += STARTED_WITHIN_MS + 1;
    let read = false;
    talks.turnEnded(["s-lacy"], () => ((read = true), ["Commit."]));
    assert.equal(read, false);
    talks.promptSubmitted(["s-lacy"], "Commit.");
    assert.deepEqual(stages(), ["delivered"]);
  });
});

// ── Through a real server ───────────────────────────────────────────────────

function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    got,
    statuses: () => got.filter((m) => m.type === "talk_status"),
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const until = checkWaits(2000, 10);

describe("through the phone server", () => {
  test("talkId reaches the app; turned down, the talk fails at once with the error's words; statuses go to that phone only, and again as it reconnects", async () => {
    const calls: Array<[string, string | null]> = [];
    let refuse: ErrorCode | null = null;
    let talking = false;
    const hub: PhoneHub = {
      talkStart: (_s, _p, talkId) => (calls.push(["talk_start", talkId]), refuse ?? ((talking = true), null)),
      talkAudio: () => {},
      talkEnd: () => void (talking = false),
      type: (_t, _s, _p, talkId) => (calls.push(["type", talkId]), refuse),
      permission: () => null,
      answers: () => null,
      talking: () => talking,
      playOnMac: () => {},
      catchUp: () => {},
      catchUpSummary: () => {},
      catchUpStop: () => false,
    };
    const pairing = new Pairing(join(process.cwd(), "phones-talk-status.json"));
    const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
    const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000 });
    const port = await server.start();
    try {
      const signIn = async (device: string) => {
        const p = phone(port);
        await p.send({ type: "pair", code: pairing.open().code, device, appVersion: "0.2.0" });
        await until(() => p.got.some((m) => m.type === "welcome"));
        return { p, paired: p.got.find((m) => m.type === "paired"), welcome: p.got.find((m) => m.type === "welcome") };
      };
      const a = await signIn("Phone A");
      const b = await signIn("Phone B");
      assert.equal(a.welcome.talkStatus, true, "welcome says this hub answers talkIds");

      // The id goes to the app with the press and the typed words; none from an older app.
      await a.p.send({ type: "talk_start", talkId: "press-1" });
      await until(() => calls.length === 1);
      await a.p.send({ type: "type", text: "Commit.", talkId: "typed-1" });
      await a.p.send({ type: "type", text: "Commit." });
      await until(() => calls.length === 3);
      assert.deepEqual(calls, [
        ["talk_start", "press-1"],
        ["type", "typed-1"],
        ["type", null],
      ]);

      // From the app: only to the phone it's for.
      server.talkStatus(a.paired.phoneId, { talkId: "press-1", stage: "routed", sessionId: "s-lacy", name: "lacy" });
      server.talkStatus(a.paired.phoneId, { talkId: "press-1", stage: "delivered", sessionId: "s-lacy", name: "lacy", text: "Commit.", queued: true });
      await until(() => a.p.statuses().length === 2);
      assert.deepEqual(
        a.p.statuses().map((m) => [m.talkId, m.stage, m.queued]),
        [
          ["press-1", "routed", undefined],
          ["press-1", "delivered", true],
        ],
      );

      // Phone A still talking: busy, and phone B's press fails at once, with the same words.
      await b.p.send({ type: "talk_start", talkId: "press-b" });
      await until(() => b.p.statuses().length === 1);
      const busy = b.p.got.find((m) => m.type === "error");
      assert.equal(busy.code, "busy");
      assert.deepEqual([b.p.statuses()[0].stage, b.p.statuses()[0].detail], ["failed", busy.message]);
      await a.p.send({ type: "talk_end" });

      // The session gone: the press and the typed words fail; without a talkId only the error.
      refuse = "no_session";
      await a.p.send({ type: "talk_start", sessionId: "s-gone", talkId: "press-2" });
      await a.p.send({ type: "type", text: "Hello?", sessionId: "s-gone", talkId: "typed-2" });
      await a.p.send({ type: "type", text: "Hello?", sessionId: "s-gone" });
      await until(() => a.p.got.filter((m) => m.type === "error").length === 3);
      assert.deepEqual(
        a.p
          .statuses()
          .slice(2)
          .map((m) => [m.talkId, m.stage, m.detail]),
        [
          ["press-2", "failed", "That session isn't running any more."],
          ["typed-2", "failed", "That session isn't running any more."],
        ],
      );
      assert.equal(b.p.statuses().length, 1, "none of phone A's went to phone B");

      // Reconnected: each recent talk's latest, once.
      await a.p.close();
      const again = phone(port);
      await again.send({ type: "hello", token: a.paired.token, device: "Phone A", appVersion: "0.2.0" });
      await until(() => again.statuses().length === 3);
      await wait(50);
      assert.deepEqual(
        again.statuses().map((m) => [m.talkId, m.stage]),
        [
          ["press-1", "delivered"],
          ["press-2", "failed"],
          ["typed-2", "failed"],
        ],
      );
      await again.close();
      await b.p.close();
    } finally {
      server.stop();
    }
  });
});
