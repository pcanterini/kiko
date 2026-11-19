// A session's screen on the phone (the chat), through a real server and a fake phone over ws: the
// hub says it takes the chat's messages (welcome chat), lists who answers in each session, its
// colour and what can be done to it, sends the live history with what it's doing, pages through
// earlier messages (history_before → history_page), offers Always where a prompt can be allowed for
// good and passes `always` on, hands Interrupt / Rename / Close to the app only where the session
// can (else says why: session_note), and reads a message again (hear) as it's said. Every message
// checked against the schema both ways. And a message's words as Hear it again says them.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import type { Session } from "../../../src/core/sessions.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { spokenMessage } from "../../../src/remote/chat.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { PhoneServer, type PhoneHub, type SessionAction } from "../../../src/remote/server.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inTmux = (name: string) => ({ via: "tmux", id: `%${name}`, keys: true, pid: 1 });
const session = (name: string, fields: Partial<Session> = {}) =>
  ({
    sessionId: name,
    cwd: `/code/${name}`,
    givenName: name,
    kind: "interactive",
    status: "idle",
    desktop: false,
    place: inTmux(name),
    mapping: "none",
    nameSetBy: "user",
    ...fields,
  }) as unknown as Session;

// Claude Code's transcripts for these sessions: the test's own folder (agents/claude-code/transcripts.ts).
const projects = join(process.cwd(), "chat-projects");
process.env.KIKO_CLAUDE_PROJECTS = projects;
const when = (i: number) => new Date(Date.UTC(2026, 9, 28, 14, 0, 0) + i * 1000).toISOString();
function transcript(name: string, lines: object[]) {
  const dir = join(projects, `/code/${name}`.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

describe("a session's screen, through a real server", () => {
  const actions: Array<{ sessionId: string; action: SessionAction; name: string | null }> = [];
  const heard: string[] = [];
  const decisions: string[] = [];
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: (_id, decision) => (decisions.push(decision), null),
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
    sessionAction(sessionId, action, name, phoneId) {
      actions.push({ sessionId, action, name });
      server.sessionNote(phoneId, sessionId, `did ${action}`);
      return null;
    },
    hear: (text) => void heard.push(text),
  };
  const pairing = new Pairing(join(process.cwd(), "phones-chat.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network });
  let ws: LocalPhone;
  const got: any[] = [];
  const send = (m: object) => {
    const message = { v: 1, ...m };
    assert.equal(invalid(message, "phone"), null, JSON.stringify(message));
    ws.send(JSON.stringify(message));
  };
  async function next(type: string, from = 0, ms = 2000) {
    const end = Date.now() + ms;
    for (;;) {
      const m = got.slice(from).find((x) => x.type === type);
      if (m) return m;
      if (Date.now() > end)
        throw new Error(
          `no ${type} in ${ms}ms: ${got
            .slice(from)
            .map((x) => x.type)
            .join(", ")}`,
        );
      await wait(10);
    }
  }

  before(async () => {
    transcript("lacy", [
      ...Array.from({ length: 100 }, (_, i) => ({ type: "user", timestamp: when(i), message: { role: "user", content: `ask ${i}` } })),
      { type: "assistant", timestamp: when(200), message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "pnpm build" } }] } },
    ]);
    ui.set({ sessions: [session("lacy", { status: "busy" }), session("pixie", { agent: "codex" } as Partial<Session>), session("away", { place: undefined } as Partial<Session>)] });
    const port = await server.start();
    ws = new LocalPhone(`ws://127.0.0.1:${port}`);
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
      got.push(m);
    });
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await next("sessions");
  });

  after(() => {
    ws.close();
    server.stop();
    ui.set({ sessions: [], permission: null });
  });

  test("welcome says chat; each session says who answers, in its agent's colour, and what can be done to it", async () => {
    assert.equal((await next("welcome")).chat, true);
    const listed = (await next("sessions")).sessions;
    const lacy = listed.find((x: any) => x.id === "lacy");
    assert.deepEqual([lacy.speaker, lacy.color], ["Claude", "#D77757"]);
    assert.deepEqual(lacy.can, { reply: true, interrupt: true, rename: true, close: true });
    const pixie = listed.find((x: any) => x.id === "pixie");
    assert.deepEqual([pixie.agent, pixie.speaker, pixie.color], ["Codex", "Codex", "#63A8F8"]);
    const away = listed.find((x: any) => x.id === "away");
    assert.equal(away.can.rename, false, "nothing reaches it: no rename");
  });

  test("what a session still runs in the background goes with it, apart from its status (idle, not working); none, nothing", async () => {
    const was = ui.state.sessions;
    const from = got.length;
    try {
      ui.set({ sessions: was.map((x) => (x.sessionId === "lacy" ? { ...x, status: "idle", background: { count: 3, quiet: 3, quietSince: 1793346455000.4 } } : x)) });
      const listed = (await next("sessions", from)).sessions;
      const lacy = listed.find((x: any) => x.id === "lacy");
      assert.equal(lacy.status, "idle");
      assert.deepEqual(lacy.background, { count: 3, quiet: 3, quietSince: 1793346455000 });
      assert.equal(listed.find((x: any) => x.id === "pixie").background, undefined);
      // How many of them are subagents, where it's known (never more than run).
      const from2 = got.length;
      ui.set({ sessions: was.map((x) => (x.sessionId === "lacy" ? { ...x, status: "idle", background: { count: 2, agents: 5 } } : x)) });
      const again = (await next("sessions", from2)).sessions;
      assert.deepEqual(again.find((x: any) => x.id === "lacy").background, { count: 2, agents: 2 });
    } finally {
      ui.set({ sessions: was });
    }
  });

  test("for the home screen: each session's mark and light colour, whether it's in Kiko, and what a working one is doing, followed only while a phone is in front", async () => {
    // The list as it comes, until one says what's wanted (the server sends it only when it changed).
    async function listed(want: (sessions: any[]) => boolean, from: number, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const m = got.slice(from).findLast((x) => x.type === "sessions");
        if (m && want(m.sessions)) return m.sessions;
        if (Date.now() > end) throw new Error(`no such sessions in ${ms}ms: ${JSON.stringify(m?.sessions)}`);
        await wait(10);
      }
    }
    const lacyOf = (all: any[]) => all.find((x) => x.id === "lacy");
    const all = await listed((x) => lacyOf(x)?.doing !== undefined, 0);
    const lacy = lacyOf(all);
    assert.deepEqual([lacy.mark, lacy.colorLight, lacy.inApp, lacy.doing], ["✻", "#C15F3C", true, "Running pnpm build"]);
    const pixie = all.find((x: any) => x.id === "pixie");
    assert.deepEqual([pixie.mark, pixie.colorLight, pixie.inApp, pixie.doing], ["⌬", "#1C64C8", true, undefined], "idle: nothing it's doing");
    assert.equal(all.find((x: any) => x.id === "away").inApp, false, "outside Kiko's tmux: external");
    // The phone goes away (locked): what the sessions do isn't followed; back, it is again.
    let from = got.length;
    send({ type: "presence", state: "away" });
    await listed((x) => lacyOf(x) && lacyOf(x).doing === undefined, from);
    from = got.length;
    send({ type: "presence", state: "back" });
    assert.equal(lacyOf(await listed((x) => lacyOf(x)?.doing !== undefined, from)).doing, "Running pnpm build");
  });

  test("watching: the live history, what it's doing now, and earlier messages a page at a time", async () => {
    const from = got.length;
    send({ type: "watch", sessionId: "lacy" });
    const live = await next("history", from);
    assert.equal(live.doing, "Running pnpm build");
    assert.equal(live.items.at(-1).steps[0].running, true);
    assert.equal(live.truncated, true);
    const oldest = live.items[0].at;
    send({ type: "history_before", sessionId: "lacy", before: oldest });
    const page = await next("history_page", from);
    assert.equal(page.before, oldest);
    assert.equal(page.items.length, 100 - live.items.length + 1, "every ask before the live view's first");
    assert.equal(page.items.at(-1).text, `ask ${100 - live.items.length}`);
    assert.equal(page.more, false);
    // One that isn't running any more: no_session.
    const gone = got.length;
    send({ type: "history_before", sessionId: "nope", before: oldest });
    assert.equal((await next("error", gone)).code, "no_session");
    send({ type: "watch", sessionId: null });
  });

  test("Always where the prompt can be allowed for good, and `always` handed to the app", async () => {
    const from = got.length;
    ui.set({ permission: { id: "p1", sessionId: "lacy", name: "lacy", what: "run pnpm test", risky: false, canAlways: true } });
    const asked = await next("permission_prompt", from);
    assert.equal(asked.prompt.canAlways, true);
    send({ type: "permission", promptId: "p1", decision: "always" });
    const end = Date.now() + 2000;
    while (!decisions.length && Date.now() < end) await wait(10);
    assert.deepEqual(decisions, ["always"]);
    const later = got.length;
    ui.set({ permission: { id: "p2", sessionId: "lacy", name: "lacy", what: "trust its folder ~/x", risky: false, folder: "~/x" } });
    assert.ok(!("canAlways" in (await next("permission_prompt", later)).prompt), "left out where it can't");
    ui.set({ permission: null });
  });

  // 2026-11-04: kiko-dev's prompt waited behind a reply being read out, never asked: the phone had "kiko-dev needs
  // you" and nothing to answer. Every prompt Kiko holds goes to the phone, each answerable, a long command in full.
  test("prompts held waiting their turn go too (queued), each answered by its id; the long command in full as detail", async () => {
    const from = got.length;
    const command = `cd /tmp/x && (xcrun simctl io booted recordVideo --force /tmp/x/v.mp4 & echo $! > /tmp/x/rec.pid)\nsleep 75\n${"x".repeat(500)}`;
    ui.set({
      permission: null,
      queuedPermissions: [
        { id: "q1", sessionId: "pixie", name: "pixie", what: "run: cd /tmp/x && (xcrun simctl io booted recordVideo …", risky: false, canAlways: true, detail: command },
        { id: "q2", sessionId: "lacy", name: "lacy", what: "edit app.ts", risky: true },
      ],
    });
    const told = await next("permission_prompt", from);
    assert.equal(told.prompt, null, "none asked now");
    assert.deepEqual(
      told.queued.map((q: any) => [q.promptId, q.sessionId, q.remainingMs]),
      [
        ["q1", "pixie", null],
        ["q2", "lacy", null],
      ],
      "both, in order, with no window yet",
    );
    assert.equal(told.queued[0].detail, command, "the command as written, its lines kept");
    assert.equal(told.queued[0].canAlways, true);
    assert.ok(!("detail" in told.queued[1]));
    const listed = (await next("sessions", from)).sessions;
    assert.equal(listed.find((x: any) => x.id === "pixie").status, "needs_you", "the session it blocks needs you");
    // One asked now, one still in line: the one asked is `prompt`, the other stays in `queued`.
    let later = got.length;
    ui.set({
      permission: { id: "q2", sessionId: "lacy", name: "lacy", what: "edit app.ts", risky: true },
      queuedPermissions: [{ id: "q1", sessionId: "pixie", name: "pixie", what: "run: cd /tmp/x", risky: false, detail: command }],
    });
    const both = await next("permission_prompt", later);
    assert.equal(both.prompt.promptId, "q2");
    assert.deepEqual(
      both.queued.map((q: any) => q.promptId),
      ["q1"],
    );
    // Answered from the phone by its id, as the one asked is.
    const before = decisions.length;
    send({ type: "permission", promptId: "q1", decision: "allow" });
    const end = Date.now() + 2000;
    while (decisions.length === before && Date.now() < end) await wait(10);
    assert.deepEqual(decisions.slice(before), ["allow"]);
    later = got.length;
    ui.set({ permission: null, queuedPermissions: [] });
    const gone = await next("permission_prompt", later);
    assert.equal(gone.prompt, null);
    assert.ok(!("queued" in gone), "left out when there are none");
  });

  test("Interrupt, Rename, Close: to the app where the session can, said back; where it can't, why, and nothing done", async () => {
    let from = got.length;
    send({ type: "session_action", sessionId: "lacy", action: "rename", name: "invoices" });
    assert.deepEqual(await next("session_note", from), { v: 1, type: "session_note", sessionId: "lacy", text: "did rename" });
    assert.deepEqual(actions.at(-1), { sessionId: "lacy", action: "rename", name: "invoices" });
    from = got.length;
    send({ type: "session_action", sessionId: "lacy", action: "interrupt" });
    await next("session_note", from);
    assert.deepEqual(actions.at(-1), { sessionId: "lacy", action: "interrupt", name: null });
    from = got.length;
    const before = actions.length;
    send({ type: "session_action", sessionId: "away", action: "rename", name: "x" });
    assert.equal((await next("session_note", from)).text, "I can't rename away from here.");
    from = got.length;
    send({ type: "session_action", sessionId: "lacy", action: "rename", name: "   " });
    assert.equal((await next("session_note", from)).text, "What should I call it?");
    assert.equal(actions.length, before, "neither reached the app");
    from = got.length;
    send({ type: "session_action", sessionId: "nope", action: "close" });
    assert.equal((await next("error", from)).code, "no_session");
  });

  test("Hear it again: the words handed to the app", async () => {
    send({ type: "hear", text: "**Done.** The tests pass.", sessionId: "lacy" });
    const end = Date.now() + 2000;
    while (!heard.length && Date.now() < end) await wait(10);
    assert.deepEqual(heard, ["**Done.** The tests pass."]);
  });
});

describe("a message as Hear it again says it", () => {
  test("Markdown's marks out, links as their words, each line a sentence", () => {
    assert.equal(
      spokenMessage("## Done\n\n**One test fails**: `invoices.test.ts` expects _created_at_.\n\n- fix it\n- [the docs](https://x.dev) say so"),
      "Done. One test fails: invoices.test.ts expects created_at. fix it. the docs say so.",
    );
  });

  test("code blocks and tables are said to be there, not read", () => {
    assert.equal(spokenMessage("Run this:\n\n```sh\npnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThat's it."), "Run this: (There's a code block here.) (There's a table here.) That's it.");
  });

  test("a long one is cut where a sentence ends; nothing left is nothing said", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} is here.`).join(" ");
    const said = spokenMessage(long);
    assert.ok(said.length < long.length);
    assert.ok(said.endsWith("is here. The rest is on the screen."));
    assert.equal(spokenMessage("---\n\n   "), "");
  });
});
