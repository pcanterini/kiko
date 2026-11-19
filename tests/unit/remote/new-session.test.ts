// A new session from the phone (src/remote/new-session.ts): what new_session may ask (one place,
// typed or said, not both), and a dictated press's words kept until it asks for them, whichever
// comes first. Then through a real server (src/remote/server.ts) with a fake app: welcome offers it
// only when the app starts sessions; the picker's options, cut to the schema; started with typed
// words, with said ones (talk_start `dictate`: the app is told, nothing routed, the words told back
// as heard before started), and with none; why not in the Mac's words (a place that isn't one, the
// app saying no, the app failing); dictate without a talkId, or to a hub that doesn't start
// sessions, refused; a name given goes to the app, and each agent says whether it can be named
// (canName); a session that started from a starting-… id says so (startedAs), and a screen opened
// on it while it started follows it to its agent's history.
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { askOf, Dictations, type NewSessionAsk, type NewSessionOptions, type NewSessionOutcome } from "../../../src/remote/new-session.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { makeSession } from "../../support/fixtures.ts";
import { checkWaits } from "../../support/until.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("what new_session may ask", () => {
  test("one place: a project, a new project by name, or a scratch folder; a first message typed or said, or none", () => {
    assert.deepEqual(askOf({ folder: "/u/git/clipkit", harness: "codex", text: " Fix the tests. " }), {
      pick: { project: "/u/git/clipkit" },
      harness: "codex",
      text: "Fix the tests.",
      talkId: null,
      name: null,
    });
    assert.deepEqual(askOf({ newProject: " Pixel " }), { pick: { newProject: "Pixel" }, harness: null, text: null, talkId: null, name: null });
    assert.deepEqual(askOf({ scratch: true, talkId: "t1" }), { pick: { scratch: true }, harness: null, text: null, talkId: "t1", name: null });
    assert.deepEqual(askOf({ scratch: true, text: "   " }), { pick: { scratch: true }, harness: null, text: null, talkId: null, name: null }, "blank words: none");
  });

  test("a name: on one line, trimmed; a blank one is none", () => {
    assert.equal((askOf({ scratch: true, harness: "opencode", name: "  Greeting\n test " }) as NewSessionAsk).name, "Greeting test");
    assert.equal((askOf({ newProject: "Pixel", name: " \t" }) as NewSessionAsk).name, null);
  });

  test("none, two places, a blank name, or typed and said at once: why, in words for the phone", () => {
    assert.match((askOf({}) as any).invalid, /^Pick where it starts/);
    assert.match((askOf({ folder: "/u/git/a", scratch: true }) as any).invalid, /^Pick where it starts/);
    assert.match((askOf({ scratch: false }) as any).invalid, /^Pick where it starts/);
    assert.equal((askOf({ newProject: "  " }) as any).invalid, "Give the new project a name.");
    assert.equal((askOf({ scratch: true, text: "hi", talkId: "t" }) as any).invalid, "Type the first message or say it, not both.");
  });
});

describe("a dictated press's words", () => {
  test("asked for before the press ends: they come once it does; after: at once; taken once", async () => {
    const d = new Dictations();
    const early = d.begin("p1", "t1");
    const words = d.words("p1", "t1");
    assert.equal(d.has("p1", "t1"), false, "taken");
    early.end("Sketch a landing page.");
    early.end("something later"); // the first end counts
    assert.equal(await words, "Sketch a landing page.");
    const late = d.begin("p1", "t2");
    late.end("Fix the build.");
    assert.equal(await d.words("p1", "t2"), "Fix the build.");
    assert.equal(await d.words("p1", "t2"), null, "only once");
  });

  test("cancelled, another phone's, or never begun: null; a press that never ends is given up on", async () => {
    const d = new Dictations();
    d.begin("p1", "t1").end(null);
    assert.equal(await d.words("p1", "t1"), null);
    d.begin("p1", "t2").end("mine");
    assert.equal(await d.words("p2", "t2"), null, "another phone's id");
    assert.equal(await d.words("p1", "nope"), null);
    d.begin("p1", "t3");
    assert.equal(await d.words("p1", "t3", 20), null);
  });

  test("ones nobody asked for go after a while", () => {
    let clock = 0;
    const d = new Dictations(() => clock);
    d.begin("p1", "old").end("forgotten");
    clock += 6 * 60_000;
    d.begin("p1", "new");
    assert.equal(d.has("p1", "old"), false);
    assert.equal(d.has("p1", "new"), true);
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
    of: (type: string) => got.filter((m) => m.type === type),
    async send(m: Record<string, unknown>) {
      await opened;
      const message = { v: 1, ...m };
      assert.equal(invalid(message, "phone"), null, JSON.stringify(message));
      ws.send(JSON.stringify(message));
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const until = checkWaits(2000, 10);

const OPTIONS: NewSessionOptions = {
  projects: [
    { folder: "/u/git/clipkit", name: "clipkit", detail: "~/git" },
    { folder: "/u/git/pixie", name: "r".repeat(300), detail: "~/git" },
  ],
  root: "~/git",
  harnesses: [
    { id: "claude-code", name: "Claude Code", canName: true },
    { id: "codex", name: "Codex", canName: true },
    { id: "plain", name: "Plain", canName: false },
    { id: "t3code", name: "T3 Code", folders: ["/u/git/pixie"], canName: true },
  ],
  selected: "codex",
  why: "last used",
};

/** A fake app: it records what it's asked; a dictated press's words come with talkEnd (`said`). */
function fakeHub(o: { starts?: boolean } = {}) {
  const asked: Array<{ ask: NewSessionAsk; phoneId: string }> = [];
  const presses: Array<{ sessionId: string | null; talkId: string | null; dictate: boolean }> = [];
  const dictations = new Dictations();
  let pressing: { phoneId: string; end: (w: string | null) => void } | null = null;
  let talking = false;
  const state = { said: "", outcome: null as NewSessionOutcome | null, fails: null as Error | null };
  const hub: PhoneHub = {
    talkStart: (sessionId, phoneId, talkId, dictate) => {
      presses.push({ sessionId, talkId, dictate: Boolean(dictate) });
      if (dictate && talkId) pressing = { phoneId, ...dictations.begin(phoneId, talkId) };
      talking = true;
      return null;
    },
    talkAudio: () => {},
    talkEnd: (cancel) => {
      talking = false;
      pressing?.end(cancel ? null : state.said);
      pressing = null;
    },
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => talking,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
    ...(o.starts === false
      ? {}
      : {
          newSessionOptions: async () => OPTIONS,
          async newSession(ask, phoneId, heard) {
            asked.push({ ask, phoneId });
            if (state.fails) throw state.fails;
            let text = ask.text ?? "";
            if (ask.talkId) {
              const words = await dictations.words(phoneId, ask.talkId);
              if (!words) return { started: false, why: "I didn't hear anything." };
              heard(words);
              text = words;
            }
            // As the app does for an agent whose sessions can't be named (core/can.ts namedAtStart).
            if (ask.name && OPTIONS.harnesses.find((h) => h.id === ask.harness)?.canName === false) return { started: false, why: "Plain sessions can't be named from here." };
            return state.outcome ?? { started: true, sessionId: "starting-3fa1c2d4", name: ask.name ?? "clipkit", text, line: "Opening clipkit." };
          },
        }),
  };
  return { hub, asked, presses, state };
}

async function serve(hub: PhoneHub, file: string) {
  const pairing = new Pairing(join(process.cwd(), file));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceMs: 60_000, opus: null });
  const port = await server.start();
  const signIn = async () => {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "iPhone", appVersion: "0.2.0" });
    await until(() => p.got.some((m) => m.type === "welcome"));
    return { p, welcome: p.got.find((m) => m.type === "welcome") };
  };
  return { server, signIn };
}

describe("through the phone server", () => {
  test("welcome offers it; the options, cut to the schema; started with typed words, with said ones, and with none", async () => {
    const fake = fakeHub();
    const { server, signIn } = await serve(fake.hub, "phones-new-session.json");
    try {
      const { p, welcome } = await signIn();
      assert.equal(welcome.newSession, true, "this hub starts sessions for the phone");

      // What the window's picker offers, as the app gives it.
      await p.send({ type: "get_new_session_options" });
      await until(() => p.of("new_session_options").length === 1);
      const options = p.of("new_session_options")[0];
      assert.deepEqual(
        options.projects.map((x: any) => [x.folder, x.name.length, x.detail]),
        [
          ["/u/git/clipkit", 7, "~/git"],
          ["/u/git/pixie", 200, "~/git"],
        ],
        "a name cut to 200",
      );
      assert.deepEqual(options.harnesses, OPTIONS.harnesses);
      assert.deepEqual([options.root, options.selected, options.why], ["~/git", "codex", "last used"]);

      // Typed: the place, the agent and the words reach the app; started, with the session's id.
      await p.send({ type: "new_session", requestId: "r1", folder: "/u/git/clipkit", harness: "codex", text: "Fix the tests." });
      await until(() => p.of("new_session_status").length === 1);
      assert.deepEqual(fake.asked.at(-1)!.ask, { pick: { project: "/u/git/clipkit" }, harness: "codex", text: "Fix the tests.", talkId: null, name: null });
      assert.deepEqual(p.of("new_session_status")[0], {
        v: 1,
        type: "new_session_status",
        requestId: "r1",
        stage: "started",
        sessionId: "starting-3fa1c2d4",
        name: "clipkit",
        text: "Fix the tests.",
        message: "Opening clipkit.",
      });

      // None: just opened, no text.
      await p.send({ type: "new_session", requestId: "r2", newProject: "Pixel" });
      await until(() => p.of("new_session_status").length === 2);
      assert.deepEqual(fake.asked.at(-1)!.ask, { pick: { newProject: "Pixel" }, harness: null, text: null, talkId: null, name: null });
      assert.equal(p.of("new_session_status")[1].stage, "started");
      assert.equal("text" in p.of("new_session_status")[1], false);

      // Said: the press is a dictation (no session, nothing routed); new_session comes as the button
      // goes up, before talk_end; the words come back as heard, then it's started with them.
      fake.state.said = "Sketch a landing page for the bakery.";
      await p.send({ type: "talk_start", talkId: "press-1", dictate: true, sessionId: "s-ignored" });
      await p.send({ type: "talk_audio", data: Buffer.alloc(3200, 0x40).toString("base64") });
      await p.send({ type: "new_session", requestId: "r3", scratch: true, harness: "claude-code", talkId: "press-1" });
      await wait(50);
      assert.equal(p.of("new_session_status").length, 2, "nothing until the press is over");
      await p.send({ type: "talk_end" });
      await until(() => p.of("new_session_status").length === 4);
      assert.deepEqual(fake.presses.at(-1), { sessionId: null, talkId: "press-1", dictate: true });
      assert.deepEqual(
        p
          .of("new_session_status")
          .slice(2)
          .map((m: any) => [m.requestId, m.stage, m.text]),
        [
          ["r3", "heard", "Sketch a landing page for the bakery."],
          ["r3", "started", "Sketch a landing page for the bakery."],
        ],
      );

      // Cancelled (dragged off): new_session isn't sent by the app, but one that comes hears nothing.
      await p.send({ type: "talk_start", talkId: "press-2", dictate: true });
      await p.send({ type: "new_session", requestId: "r4", scratch: true, talkId: "press-2" });
      await p.send({ type: "talk_cancel" });
      await until(() => p.of("new_session_status").length === 5);
      assert.deepEqual([p.of("new_session_status")[4].stage, p.of("new_session_status")[4].message], ["failed", "I didn't hear anything."]);
      await p.close();
    } finally {
      server.stop();
    }
  });

  test("why not, in the Mac's words: a place that isn't one, the app saying no, the app failing; dictate without a talkId refused", async () => {
    const fake = fakeHub();
    const { server, signIn } = await serve(fake.hub, "phones-new-session-errors.json");
    try {
      const { p } = await signIn();
      const asked = fake.asked.length;
      await p.send({ type: "new_session", requestId: "e1", folder: "/u/git/a", scratch: true });
      await until(() => p.of("new_session_status").length === 1);
      assert.deepEqual([p.of("new_session_status")[0].stage, p.of("new_session_status")[0].message], ["failed", "Pick where it starts: one project, a new project or a scratch folder."]);
      assert.equal(fake.asked.length, asked, "the app isn't asked");

      fake.state.outcome = { started: false, why: "I can't open a new terminal on this computer." };
      await p.send({ type: "new_session", requestId: "e2", folder: "/u/git/clipkit" });
      await until(() => p.of("new_session_status").length === 2);
      assert.deepEqual(
        [p.of("new_session_status")[1].requestId, p.of("new_session_status")[1].stage, p.of("new_session_status")[1].message],
        ["e2", "failed", "I can't open a new terminal on this computer."],
      );

      fake.state.fails = new Error("tmux: no server running");
      await p.send({ type: "new_session", requestId: "e3", scratch: true });
      await until(() => p.of("new_session_status").length === 3);
      assert.equal(p.of("new_session_status")[2].message, "I couldn't start it: tmux: no server running");

      // A dictation needs its id: refused, and the floor isn't taken.
      const presses = fake.presses.length;
      await p.send({ type: "talk_start", dictate: true });
      await until(() => p.of("error").length === 1);
      assert.equal(p.of("error")[0].code, "invalid");
      assert.equal(fake.presses.length, presses);
      await p.close();
    } finally {
      server.stop();
    }
  });

  test("a name goes to the app with the rest; for an agent that can't be named, the app's no comes back", async () => {
    const fake = fakeHub();
    const { server, signIn } = await serve(fake.hub, "phones-new-session-named.json");
    try {
      const { p } = await signIn();
      await p.send({ type: "get_new_session_options" });
      await until(() => p.of("new_session_options").length === 1);
      assert.deepEqual(
        p.of("new_session_options")[0].harnesses.map((h: any) => [h.id, h.canName]),
        [
          ["claude-code", true],
          ["codex", true],
          ["plain", false],
          ["t3code", true],
        ],
      );
      await p.send({ type: "new_session", requestId: "n1", scratch: true, harness: "codex", text: "Hello world", name: "Greeting test" });
      await until(() => p.of("new_session_status").length === 1);
      assert.deepEqual(fake.asked.at(-1)!.ask, { pick: { scratch: true }, harness: "codex", text: "Hello world", talkId: null, name: "Greeting test" });
      assert.deepEqual([p.of("new_session_status")[0].stage, p.of("new_session_status")[0].name], ["started", "Greeting test"]);
      await p.send({ type: "new_session", requestId: "n2", scratch: true, harness: "plain", name: "Greeting test" });
      await until(() => p.of("new_session_status").length === 2);
      assert.deepEqual([p.of("new_session_status")[1].stage, p.of("new_session_status")[1].message], ["failed", "Plain sessions can't be named from here."]);
      await p.close();
    } finally {
      server.stop();
    }
  });

  test("an app that doesn't start sessions: welcome doesn't offer it, and asking anyway is refused", async () => {
    const fake = fakeHub({ starts: false });
    const { server, signIn } = await serve(fake.hub, "phones-new-session-none.json");
    try {
      const { p, welcome } = await signIn();
      assert.equal("newSession" in welcome, false);
      await p.send({ type: "get_new_session_options" });
      await p.send({ type: "new_session", requestId: "x", scratch: true });
      await p.send({ type: "talk_start", talkId: "t", dictate: true });
      await until(() => p.of("error").length === 3);
      assert.deepEqual(
        p.of("error").map((m: any) => m.code),
        ["invalid", "invalid", "invalid"],
      );
      assert.equal(p.of("new_session_status").length, 0);
      assert.equal(fake.presses.length, 0);
      await p.close();
    } finally {
      server.stop();
    }
  });

  test("a session that started from its starting-… id says so, for a phone that opened it then", async () => {
    const fake = fakeHub();
    const { server, signIn } = await serve(fake.hub, "phones-new-session-started.json");
    try {
      const { p } = await signIn();
      const started = { ...makeSession({ name: "clipkit" }), aliases: ["bg-process-1", "starting-3fa1c2d4"] };
      const other = makeSession({ name: "pixie" });
      ui.set({ sessions: [started, other] });
      await until(() => p.of("sessions").some((m: any) => m.sessions.length === 2));
      const listed = p.of("sessions").at(-1).sessions;
      assert.equal(listed.find((s: any) => s.id === started.sessionId).startedAs, "starting-3fa1c2d4");
      assert.equal("startedAs" in listed.find((s: any) => s.id === other.sessionId), false);
      ui.set({ sessions: [] });
      await p.close();
    } finally {
      server.stop();
    }
  });

  // An OpenCode session started from the sheet, its chat opened on its
  // starting-… id, and it showed a spinner for good: the watch went to the main agent's record of a
  // session that didn't exist, and never moved once OpenCode listed it. Whatever the agent.
  test("a screen opened on a session still starting shows it empty, then follows it to its agent's history once it's listed", async () => {
    const fake = fakeHub();
    const { server, signIn } = await serve(fake.hub, "phones-new-session-follow.json");
    const projects = join(process.cwd(), "follow-projects");
    process.env.KIKO_CLAUDE_PROJECTS = projects;
    try {
      const { p } = await signIn();
      const cwd = "/u/scratch/2026-02-03-sample-app";
      const starting = { ...makeSession({ name: "hello" }), sessionId: "starting-2f5aece8", cwd, status: "starting", place: null };
      ui.set({ sessions: [starting as any] });
      await until(() => p.of("sessions").some((m: any) => m.sessions.some((s: any) => s.id === "starting-2f5aece8")));
      await p.send({ type: "watch", sessionId: "starting-2f5aece8" });
      await until(() => p.of("history").length === 1);
      assert.deepEqual(p.of("history")[0], { v: 1, type: "history", sessionId: "starting-2f5aece8", items: [], truncated: false }, "nothing yet, and no spinner");

      // Listed by its agent, with the id it had as an alias: its record (here a transcript) is followed now, under the same id.
      const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 19, 24, s)).toISOString();
      const line = (kind: "user" | "assistant", text: string, s: number) =>
        `${JSON.stringify(kind === "user" ? { type: "user", timestamp: at(s), message: { role: "user", content: text } } : { type: "assistant", timestamp: at(s), message: { content: [{ type: "text", text }] } })}\n`;
      const dir = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const transcript = join(dir, "real-hello.jsonl");
      writeFileSync(transcript, line("user", "Hello world!", 6) + line("assistant", "Hello! What shall we build?", 7));
      ui.set({ sessions: [{ ...starting, sessionId: "real-hello", status: "idle", aliases: ["starting-2f5aece8"] } as any] });
      await until(() => p.of("history").length === 2);
      const followed = p.of("history")[1];
      assert.equal(followed.sessionId, "starting-2f5aece8", "under the id the phone asked for");
      assert.deepEqual(
        followed.items.map((i: any) => [i.kind, i.text]),
        [
          ["you", "Hello world!"],
          ["claude", "Hello! What shall we build?"],
        ],
      );

      // And live from there: a reply as it's written.
      appendFileSync(transcript, line("user", "What can you help me with?", 34) + line("assistant", "Code, docs, anything here.", 37));
      await until(() => p.of("history").some((h: any) => h.items.length === 4), 3000);
      assert.equal(p.of("history").at(-1).items.at(-1).text, "Code, docs, anything here.");
      ui.set({ sessions: [] });
      await p.close();
    } finally {
      server.stop();
      delete process.env.KIKO_CLAUDE_PROJECTS;
    }
  });
});
