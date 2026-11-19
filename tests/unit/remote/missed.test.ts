// What a phone missed (src/remote/missed.ts): the log on its own (per phone, oldest first, read
// with seen, capped, kept in a file across restarts), and through a real server on 127.0.0.1 with a
// fake phone: a line said while the phone is gone or away comes in `missed` as it's back, `seen`
// clears it, and `catch_up` hands the lines to the app to say, in order.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { catchUpLine, MAX_MISSED, MissedLog, wire, type Missed } from "../../../src/remote/missed.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import type { AtComputer } from "../../../src/platform/types.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";
import { makeSession } from "../../support/fixtures.ts";

const said = (text: string, sessionId: string | null = "s1", name: string | null = "atlas-agents") => ({ sessionId, name, kind: "announcement" as const, text });

test("kept for the phones that weren't there, oldest first; one that was there gets nothing", () => {
  let clock = 1_000;
  const log = new MissedLog(null, () => clock);
  assert.equal(log.add(said("first"), []), null, "every phone heard it");
  log.add(said("one"), ["p1"]);
  clock += 10;
  log.add(said("two", "s2", "clipkit"), ["p1", "p2"]);
  assert.deepEqual(
    log.unread("p1").map((x) => x.text),
    ["one", "two"],
  );
  assert.deepEqual(
    log.unread("p2").map((x) => [x.text, x.sessionId, x.name, x.kind, x.at]),
    [["two", "s2", "clipkit", "announcement", 1_010]],
  );
  assert.deepEqual(log.unread("p3"), []);
});

test("ids go up even within one millisecond, and seen clears up to one", () => {
  const log = new MissedLog(null, () => 5_000);
  const a = log.add(said("a"), ["p1"])!;
  const b = log.add(said("b"), ["p1"])!;
  const c = log.add(said("c"), ["p1"])!;
  assert.deepEqual([a.id, b.id, c.id], [5_000, 5_001, 5_002]);
  log.seen("p1", b.id);
  assert.deepEqual(
    log.unread("p1").map((x) => x.text),
    ["c"],
  );
  log.seen("p1", a.id); // an older seen changes nothing
  assert.deepEqual(
    log.unread("p1").map((x) => x.text),
    ["c"],
  );
  // Read ones can still be read aloud by id (catch_up from a list already opened); without ids, the unread ones.
  assert.deepEqual(
    log.find("p1", [a.id, c.id]).map((x) => x.text),
    ["a", "c"],
  );
  assert.deepEqual(
    log.find("p1").map((x) => x.text),
    ["c"],
  );
});

test("the same line said again for the same session is kept once", () => {
  let clock = 1;
  const log = new MissedLog(null, () => clock++);
  log.add({ ...said("Clipkit wants to run npm publish. Allow?"), kind: "permission" }, ["p1"]);
  log.add({ ...said("Clipkit wants to run npm publish. Allow?"), kind: "permission" }, ["p1"]);
  log.add(said("Clipkit wants to run npm publish. Allow?", "s2"), ["p1"]);
  assert.equal(log.unread("p1").length, 2);
});

test("capped at the newest 50: the oldest go first", () => {
  let clock = 1;
  const log = new MissedLog(null, () => clock++);
  for (let i = 0; i < MAX_MISSED + 7; i++) log.add(said(`line ${i}`), ["p1"]);
  const left = log.unread("p1");
  assert.equal(left.length, MAX_MISSED);
  assert.equal(left[0].text, "line 7");
  assert.equal(left.at(-1)!.text, `line ${MAX_MISSED + 6}`);
});

test("kept in a file across a restart; forgotten phones' records go", () => {
  const file = join(process.cwd(), "missed-restart.json");
  let clock = 10;
  const before = new MissedLog(file, () => clock++);
  before.add(said("while you were out"), ["p1", "p2"]);
  before.add(said("and this"), ["p1"]);
  before.seen("p1", before.unread("p1")[0].id);
  assert.ok(existsSync(file));
  const after = new MissedLog(file, () => 0); // the clock went back: ids still go up
  assert.deepEqual(
    after.unread("p1").map((x) => x.text),
    ["and this"],
  );
  assert.ok(after.add(said("later"), ["p1"])!.id > after.unread("p1")[0].id);
  after.keep(["p1"]);
  assert.deepEqual(after.unread("p2"), []);
  assert.ok(!readFileSync(file, "utf8").includes('"p2"'));
});

test("settled: a session's newer update supersedes its older one and closes its question; per phone, kept across a restart", () => {
  const file = join(process.cwd(), "missed-settled.json");
  let clock = 100;
  const log = new MissedLog(file, () => clock++);
  const told: Array<[string, number[], string]> = [];
  log.onSettled = (phoneId, items) => void told.push([phoneId, items.map((x) => x.id), items[0].settled!.how]);
  const ask = log.add({ ...said("Atlas agents wants to run the tests. Allow?"), kind: "permission", promptId: "prompt-1" }, ["p1", "p2"])!;
  const first = log.add(said("Atlas agents finished."), ["p1"])!;
  assert.deepEqual(told, [["p1", [ask.id], "closed"]], "the turn it held up finished: the question is over, for the phone that has the update");
  const other = log.add(said("Lacy is done.", "s2", "lacy"), ["p1"])!;
  const second = log.add(said("Atlas agents pushed."), ["p1"])!;
  assert.deepEqual(told.at(-1), ["p1", [first.id], "superseded"]);
  assert.deepEqual(
    log.unread("p1").map((x) => [x.text, x.settled?.how ?? null]),
    [
      ["Atlas agents wants to run the tests. Allow?", "closed"],
      ["Atlas agents finished.", "superseded"],
      ["Lacy is done.", null],
      ["Atlas agents pushed.", null],
    ],
  );
  assert.equal(log.unread("p2")[0].settled, undefined, "p2's copy is its own: it never got the update");
  // The question answered (by its prompt), on every phone that has it; words to lacy reply to its update.
  log.settlePrompt("prompt-1", ["s1"], "answered_on_mac");
  assert.equal(log.unread("p2")[0].settled?.how, "answered_on_mac");
  assert.equal(log.unread("p1")[0].settled?.how, "closed", "settled once: the first reason stays");
  assert.deepEqual(
    log.settleSession(["s2"], ["announcement"], "replied").map((x) => x.id),
    [other.id],
  );
  assert.deepEqual(log.settleSession(["s2"], ["announcement"], "replied"), [], "nothing left to settle");
  // The same update said again (a repeat) settles nothing: it's the one already kept.
  log.add(said("Atlas agents pushed."), ["p1"]);
  assert.equal(log.unread("p1").at(-1)!.settled, undefined);
  assert.deepEqual(
    log.open().map((x) => x.id),
    [second.id],
  );
  assert.deepEqual(
    log.settled("p1").map((x) => x.id),
    [ask.id, first.id, other.id],
  );
  // Kept as it was; the hub's own fields aren't sent.
  const after = new MissedLog(file, () => 0);
  assert.deepEqual(
    after.unread("p1").map((x) => x.settled?.how ?? null),
    ["closed", "superseded", "replied", null],
  );
  assert.equal(after.unread("p1")[0].promptId, "prompt-1");
  assert.deepEqual(Object.keys(wire(after.unread("p1")[0])).sort(), ["at", "id", "kind", "name", "sessionId", "settled", "text"]);
  assert.equal(invalid({ v: 1, type: "missed", items: after.unread("p1").map(wire) }, "hub"), null);
});

test("read aloud with the session's name first when the line doesn't say it", () => {
  const item = { id: 1, at: 1, sessionId: "s1", kind: "announcement" as const };
  assert.equal(catchUpLine({ ...item, name: "atlas-agents", text: "Done, and the tests pass." }), "atlas agents: Done, and the tests pass.");
  assert.equal(catchUpLine({ ...item, name: "atlas-agents", text: "Atlas agents is done." }), "Atlas agents is done.");
  assert.equal(catchUpLine({ ...item, name: "clipkit", text: "Clipkit wants to run npm publish. Allow?" }), "Clipkit wants to run npm publish. Allow?");
  assert.equal(catchUpLine({ ...item, sessionId: null, name: null, kind: "answer", text: "The build passed." }), "The build passed.");
});

// ── Through the server ──────────────────────────────────────────────────

/** A phone: every message it gets, checked against the schema. */
function phone(port: number) {
  const ws = new LocalPhone(`ws://127.0.0.1:${port}`);
  const got: any[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    assert.equal(invalid(m, "hub"), null, JSON.stringify(m));
    got.push(m);
    for (const w of waiting.splice(0)) w();
  });
  const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  return {
    async send(m: Record<string, unknown>) {
      await opened;
      ws.send(JSON.stringify({ v: 1, ...m }));
    },
    async next(type: string): Promise<any> {
      for (;;) {
        const i = got.findIndex((m) => m.type === type);
        if (i >= 0) return got.splice(i, 1)[0];
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
    /** How many of this type it got and hasn't taken with next. */
    count(type: string) {
      return got.filter((m) => m.type === type).length;
    },
    async close() {
      ws.close();
      await closed;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
// The servers here take a change of where the phone is at once (presenceSettleMs 0); the short wait
// before one counts is presence.test.ts's.

test("gone, then back: missed after welcome, oldest first; seen clears it; catch_up hands the lines over in order", async () => {
  const caughtUp: Array<{ lines: string[]; phoneId: string }> = [];
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: (lines, phoneId) => void caughtUp.push({ lines, phoneId }),
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(process.cwd(), "phones-missed.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0 });
  const port = await server.start();
  try {
    const first = phone(port);
    await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    const { token, phoneId } = await first.next("paired");
    await first.next("welcome");
    assert.deepEqual((await first.next("missed")).items, [], "nothing yet");
    // Heard live: not missed.
    ui.spoken("Heard this one live.", { name: "atlas-agents", sessionId: "s1" });
    await first.close();
    await settle();

    // Gone: what's said is kept for it.
    ui.spoken("Atlas agents finished; the tests pass.", { name: "atlas-agents", sessionId: "s1" });
    ui.info("not something Kiko said");
    ui.session({ name: "clipkit", sessionId: "s2" }, "what a session said, raw: not Kiko speaking");
    ui.spoken("Done, and pushed.", { name: "clipkit", sessionId: "s2" });
    ui.voice("The build on main passed.");

    const back = phone(port);
    await back.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    await back.next("welcome");
    const missed = (await back.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => [x.kind, x.sessionId, x.name, x.text]),
      [
        ["announcement", "s1", "atlas-agents", "Atlas agents finished; the tests pass."],
        ["announcement", "s2", "clipkit", "Done, and pushed."],
        ["answer", null, null, "The build on main passed."],
      ],
    );
    assert.ok(missed[0].id < missed[1].id && missed[1].id < missed[2].id);

    // Read aloud, in order; the hub names the session where the line doesn't.
    await back.send({ type: "catch_up", ids: missed.map((x: any) => x.id) });
    await settle();
    assert.deepEqual(caughtUp, [{ lines: ["Atlas agents finished; the tests pass.", "clipkit: Done, and pushed.", "The build on main passed."], phoneId }]);

    // Away (the app in the background) while still connected: kept too; back sends it.
    await back.send({ type: "seen", upTo: missed.at(-1).id });
    await back.send({ type: "presence", state: "away" });
    await settle();
    // A question while that session's prompt is being asked is a permission line.
    ui.set({ permission: { id: "prompt-1", sessionId: "s2", name: "clipkit", what: "run npm publish", risky: false } });
    ui.spoken("Clipkit wants to run npm publish. Allow?", { name: "clipkit", sessionId: "s2" });
    ui.set({ permission: null });
    await back.send({ type: "presence", state: "back" });
    const again = (await back.next("missed")).items;
    assert.deepEqual(
      again.map((x: any) => [x.kind, x.text]),
      [["permission", "Clipkit wants to run npm publish. Allow?"]],
      "only what came since it was read",
    );

    // catch_up with no ids: the unread ones, then they're read.
    await back.send({ type: "catch_up" });
    await settle();
    assert.deepEqual(caughtUp.at(-1)!.lines, ["Clipkit wants to run npm publish. Allow?"]);
    assert.deepEqual(server.missed.unread(phoneId), []);
    await back.close();
  } finally {
    server.stop();
  }
});

test("settled through the server: a question answered on the Mac, a newer update, words sent, a session unblocked; Catch me up sums up only what's left; Stop", async () => {
  const summaries: Array<{ items: Missed[]; phoneId: string }> = [];
  const read: string[][] = [];
  let stops = 0;
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: (lines) => void read.push(lines),
    catchUpSummary: (items, phoneId) => void summaries.push({ items, phoneId }),
    catchUpStop: () => ++stops === 1,
  };
  const file = join(process.cwd(), "missed-server-settled.json");
  const pairing = new Pairing(join(process.cwd(), "phones-settled.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, missedFile: file, presenceSettleMs: 0 });
  const port = await server.start();
  try {
    const first = phone(port);
    await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    const { token, phoneId } = await first.next("paired");
    await first.next("missed");
    await first.close();
    await settle();

    // Gone: a question asked, then allowed on the Mac (its keys); then updates from two sessions,
    // atlas-agents twice.
    ui.set({ permission: { id: "prompt-7", sessionId: "s2", name: "clipkit", what: "run npm publish", risky: false } });
    ui.spoken("Clipkit wants to run npm publish. Allow?", { name: "clipkit", sessionId: "s2" });
    server.promptSettled("prompt-7", "s2", "answered_on_mac");
    ui.set({ permission: null });
    ui.spoken("Atlas agents finished the refactor.", { name: "atlas-agents", sessionId: "s1" });
    ui.spoken("Lacy is done. Want it to push?", { name: "lacy", sessionId: "s3" });
    ui.spoken("Atlas agents pushed it too.", { name: "atlas-agents", sessionId: "s1" });

    const back = phone(port);
    await back.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    const missed = (await back.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => [x.text, x.settled?.how ?? null]),
      [
        ["Clipkit wants to run npm publish. Allow?", "answered_on_mac"],
        ["Atlas agents finished the refactor.", "superseded"],
        ["Lacy is done. Want it to push?", null],
        ["Atlas agents pushed it too.", null],
      ],
    );
    assert.ok(
      missed.every((x: any) => !("promptId" in x) && !("asked" in x)),
      "the hub's own fields stay on the hub",
    );

    // Catch me up: one summary, of what still needs you only.
    await back.send({ type: "catch_up", ids: missed.map((x: any) => x.id), summary: true });
    await settle();
    assert.deepEqual(
      summaries.map((s) => [s.phoneId, s.items.map((x) => x.text)]),
      [[phoneId, ["Lacy is done. Want it to push?", "Atlas agents pushed it too."]]],
    );
    assert.deepEqual(read, []);

    // Words go to lacy (from anywhere): replied, and the phone, connected, hears of it.
    server.sessionReplied("s3");
    const told = await back.next("missed_settled");
    assert.deepEqual(
      told.items.map((x: any) => [x.id, x.settled.how]),
      [[missed[2].id, "replied"]],
    );
    // Played one by one, as named (a line's play button, Read all): settled or not.
    await back.send({ type: "catch_up", ids: [missed[0].id, missed[3].id] });
    await settle();
    assert.deepEqual(read, [["Clipkit wants to run npm publish. Allow?", "Atlas agents pushed it too."]]);

    // Stop: the hub's catch-up stops.
    await back.send({ type: "catch_up_stop" });
    await back.send({ type: "catch_up_stop" });
    await settle();
    assert.equal(stops, 2);

    // Away, a question the hub let go of waits in its terminal (the session listed blocked); once it
    // isn't blocked any more, it was answered there, at the Mac.
    await back.send({ type: "presence", state: "away" });
    await settle();
    const blocked = { ...makeSession({ name: "grove", status: "blocked" }), cwd: "/nowhere/grove" };
    ui.set({ sessions: [blocked], permission: { id: "prompt-8", sessionId: blocked.sessionId, name: "grove", what: "delete the build folder", risky: true } });
    ui.spoken("Grove wants to delete the build folder. Allow?", { name: "grove", sessionId: blocked.sessionId });
    await settle();
    ui.set({ permission: null }); // let go: its window ran out
    await settle();
    assert.ok(
      server.missed.open().some((x) => x.sessionId === blocked.sessionId),
      "still waiting in its terminal",
    );
    ui.set({ sessions: [{ ...blocked, status: "idle" }] });
    const unblocked = await back.next("missed_settled");
    assert.equal(unblocked.items[0].settled.how, "answered_on_mac");
    await back.send({ type: "presence", state: "back" });
    const again = (await back.next("missed")).items;
    assert.deepEqual(
      again.map((x: any) => [x.text, x.settled?.how]),
      [["Grove wants to delete the build folder. Allow?", "answered_on_mac"]],
    );
    // A summary of nothing left: no call.
    await back.send({ type: "catch_up", summary: true });
    await settle();
    assert.equal(summaries.length, 1);
    await back.close();
  } finally {
    server.stop();
    ui.set({ sessions: [], permission: null });
  }
  // Kept in missed.json as it was settled.
  const kept = new MissedLog(file);
  assert.deepEqual(
    kept.settled(pairing.list()[0].id).map((x) => x.settled!.how),
    ["answered_on_mac", "superseded", "replied", "answered_on_mac"],
  );
});

test("a trust card stays up while another prompt is shown: what a phone missed of it isn't settled by that, nor by time; settled, it is", async () => {
  const up = new Set(["trust-1"]);
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    promptUp: (id) => up.has(id),
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const file = join(process.cwd(), "missed-server-trust.json");
  const pairing = new Pairing(join(process.cwd(), "phones-trust.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, missedFile: file, presenceSettleMs: 0 });
  const port = await server.start();
  try {
    const first = phone(port);
    await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    const { token } = await first.next("paired");
    await first.next("missed");
    await first.close();
    await settle();

    // Gone: Dozer (still starting) asks to trust its folder; then grove's prompt is shown over it,
    // and let go. Dozer's card is still up.
    ui.set({ sessions: [], sessionsLoaded: true, permission: { id: "trust-1", sessionId: "starting-1", name: "Dozer", what: "trust its folder ~/x", risky: false, folder: "~/x" } });
    ui.spoken("Dozer wants to trust its folder ~/x. Claude Code will be able to read, edit and run files there. Allow?", { name: "Dozer", sessionId: "starting-1" });
    await settle();
    ui.set({ permission: { id: "prompt-9", sessionId: "s9", name: "grove", what: "run npm publish", risky: false } });
    ui.spoken("Grove wants to run npm publish. Allow?", { name: "grove", sessionId: "s9" });
    await settle();
    ui.set({ permission: null });
    await settle();

    // Back long after (past the hub's 15s for a prompt let go of): grove's was dealt with in its
    // terminal (closed); Dozer's is still up, so it still needs the phone.
    mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
    const back = phone(port);
    await back.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    const missed = (await back.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => [x.sessionId, x.settled?.how ?? null]),
      [
        ["starting-1", null],
        ["s9", "closed"],
      ],
    );
    // Settled (answered on another phone): the phone hears of it, and its notification goes with it.
    assert.equal((await back.next("missed_settled")).items[0].id, missed[1].id, "grove's, as it settled on the way back");
    up.delete("trust-1");
    server.promptSettled("trust-1", "starting-1", "answered_on_phone");
    const told = await back.next("missed_settled");
    assert.deepEqual(
      told.items.map((x: any) => [x.id, x.settled.how]),
      [[missed[0].id, "answered_on_phone"]],
    );
    await back.close();
  } finally {
    mock.timers.reset();
    server.stop();
    ui.set({ sessions: [], permission: null });
  }
});

test("connected but away: each line kept for it comes at once as missed_line (for a notification), and again in missed as it's back; in front, none", async () => {
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(process.cwd(), "phones-missed-line.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0 });
  const port = await server.start();
  try {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await p.next("paired");
    await p.next("welcome");
    await p.next("missed");
    await p.send({ type: "presence", state: "back" });
    await settle();
    ui.spoken("Heard live.", { name: "lacy", sessionId: "s1" });
    await settle();
    assert.equal(p.count("missed_line"), 0, "in front: it heard it");

    await p.send({ type: "presence", state: "away" });
    await settle();
    ui.spoken("Lacy finished the migration and the tests pass.", { name: "lacy", sessionId: "s1" });
    const line = (await p.next("missed_line")).item;
    assert.deepEqual([line.kind, line.sessionId, line.name, line.text], ["announcement", "s1", "lacy", "Lacy finished the migration and the tests pass."]);
    assert.deepEqual(Object.keys(line).sort(), ["at", "id", "kind", "name", "sessionId", "text"], "as missed sends it: none of the hub's own fields");
    // Said again: the one already kept, not told twice.
    ui.spoken("Lacy finished the migration and the tests pass.", { name: "lacy", sessionId: "s1" });
    ui.voice("The build on main passed.");
    const answer = (await p.next("missed_line")).item;
    assert.deepEqual([answer.kind, answer.sessionId, answer.text], ["answer", null, "The build on main passed."]);
    await settle();
    assert.equal(p.count("missed_line"), 0);

    // Back: the same lines come in missed, as before.
    await p.send({ type: "presence", state: "back" });
    const missed = (await p.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => x.id),
      [line.id, answer.id],
    );
    await p.close();
  } finally {
    server.stop();
  }
});

// No phone buzz while you're at the Mac (a release blocker): a line or a question for an away
// phone goes quietly while the Mac had input in the last 2 minutes and its screen is unlocked and
// awake; otherwise it notifies as before.
test("at the Mac: what goes to an away phone is quiet (missed_line, permission_prompt); idle, locked or asleep, it isn't", async () => {
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  let reading: AtComputer | null = { idleMs: 5_000, locked: false, asleep: false };
  let reads = 0;
  const atComputer = async () => {
    reads++;
    return reading;
  };
  const pairing = new Pairing(join(process.cwd(), "phones-at-mac.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0, atComputer });
  const port = await server.start();
  const fresh = () => new Promise((resolve) => setTimeout(resolve, 1600)); // past the reading kept for a question and its line
  try {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await p.next("paired");
    await p.next("missed");
    assert.equal((await p.next("permission_prompt")).prompt, null, "none asked as it connects");
    await p.send({ type: "presence", state: "away" });
    await settle();

    // Typing at the Mac a moment ago: quiet.
    ui.spoken("Lacy finished the migration.", { name: "lacy", sessionId: "s1" });
    const quiet = await p.next("missed_line");
    assert.equal(quiet.quiet, true);
    assert.equal(quiet.item.text, "Lacy finished the migration.");
    // A question, and its line: quiet too, from one reading.
    const before = reads;
    ui.set({ permission: { id: "pp1", sessionId: "s1", name: "lacy", what: "run pnpm db:migrate", risky: false } });
    const asked = await p.next("permission_prompt");
    assert.deepEqual([asked.prompt?.promptId, asked.quiet], ["pp1", true]);
    ui.spoken("Lacy wants to run pnpm db:migrate. Allow?", { name: "lacy", sessionId: "s1" });
    assert.equal((await p.next("missed_line")).quiet, true);
    assert.equal(reads - before, 0, "the reading from a moment ago");
    ui.set({ permission: null });
    assert.equal((await p.next("permission_prompt")).quiet, undefined, "the prompt gone: nothing to be quiet about");

    // Idle for 3 minutes, locked, asleep, or no telling: it notifies.
    for (const r of [{ idleMs: 3 * 60_000, locked: false, asleep: false }, { idleMs: 1_000, locked: true, asleep: false }, { idleMs: 1_000, locked: false, asleep: true }, null]) {
      await fresh();
      reading = r;
      ui.spoken(`Clipkit is done (${JSON.stringify(r)}).`, { name: "clipkit", sessionId: `s-${reads}` });
      const loud = await p.next("missed_line");
      assert.equal(loud.quiet, undefined, JSON.stringify(r));
    }
    // A question while away from the Mac: not quiet.
    ui.set({ permission: { id: "pp2", sessionId: "s1", name: "lacy", what: "run pnpm build", risky: false } });
    const loudPrompt = await p.next("permission_prompt");
    assert.deepEqual([loudPrompt.prompt?.promptId, loudPrompt.quiet], ["pp2", undefined]);

    // In front: a prompt is never quiet (the app posts nothing in front anyway), and it isn't asked.
    await p.send({ type: "presence", state: "back" });
    await p.next("missed");
    const asks = reads;
    ui.set({ permission: { id: "pp3", sessionId: "s1", name: "lacy", what: "run pnpm lint", risky: false } });
    const front = await p.next("permission_prompt");
    assert.deepEqual([front.prompt?.promptId, front.quiet], ["pp3", undefined]);
    assert.equal(reads, asks);
    await p.close();
  } finally {
    server.stop();
    ui.set({ permission: null });
  }
});

test("a prompt that stood after its window and was let go unanswered: its question becomes a note with nothing to press, waiting in its terminal, until the session moves on", async () => {
  const up = new Set(["stood-1"]);
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    promptUp: (id) => up.has(id),
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const file = join(process.cwd(), "missed-server-stood.json");
  const pairing = new Pairing(join(process.cwd(), "phones-stood.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, missedFile: file, presenceSettleMs: 0 });
  const port = await server.start();
  const lacy = { ...makeSession({ name: "lacy", status: "busy" }), cwd: "/nowhere/lacy" };
  try {
    const first = phone(port);
    await first.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    const { token } = await first.next("paired");
    await first.next("missed");
    await first.close();
    await settle();

    // Gone (the phone left on the desk): Lacy asks; nobody answers; it stands, its card up.
    ui.set({ sessions: [lacy], sessionsLoaded: true, permission: { id: "stood-1", sessionId: lacy.sessionId, name: "lacy", what: "run: npm test", risky: false } });
    ui.spoken("Lacy wants to run the tests. Allow?", { name: "lacy", sessionId: lacy.sessionId });
    await settle();
    // Back at the Mac: let go to its terminal, which shows it now (listed blocked).
    up.delete("stood-1");
    ui.set({ permission: null, sessions: [{ ...lacy, status: "blocked" }] });
    server.promptLetGo("stood-1", lacy.sessionId, "lacy", "lacy asked to run: npm test — waiting in its terminal");
    await settle();

    // Back on the phone long after: the question superseded by the note, which still needs you.
    mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
    const back = phone(port);
    await back.send({ type: "hello", token, device: "Test iPhone", appVersion: "0.1.0" });
    const missed = (await back.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => [x.kind, x.text, x.settled?.how ?? null]),
      [
        ["permission", "Lacy wants to run the tests. Allow?", "superseded"],
        ["permission", "lacy asked to run: npm test — waiting in its terminal", null],
      ],
    );
    assert.ok(
      missed.every((x: any) => !("promptId" in x)),
      "nothing to answer it by",
    );
    // Answered in its terminal: no longer blocked, the note settles.
    ui.set({ sessions: [{ ...lacy, status: "busy" }] });
    const told = await back.next("missed_settled");
    assert.deepEqual(
      told.items.map((x: any) => [x.id, x.settled.how]),
      [[missed[1].id, "answered_on_mac"]],
    );
    await back.close();
  } finally {
    mock.timers.reset();
    server.stop();
    ui.set({ sessions: [], permission: null });
  }
});

// 2026-11-05: an agent's throwaway `claude` (live-check-tmp) was listed "waiting" (a dialog up: needs
// you), then killed. A session whose process ended has nothing to answer: once it has left the list
// (two listings without it), the phone's sessions don't have it, and the question it missed is closed.
test("a session listed blocked, then gone (its process ended): out of the phone's sessions, no needs-you, its missed question closed", async () => {
  const hub: PhoneHub = {
    talkStart: () => null,
    talkAudio: () => {},
    talkEnd: () => {},
    type: () => null,
    permission: () => null,
    answers: () => null,
    talking: () => false,
    playOnMac: () => {},
    catchUp: () => {},
    catchUpSummary: () => {},
    catchUpStop: () => false,
  };
  const pairing = new Pairing(join(process.cwd(), "phones-ended.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0 });
  const port = await server.start();
  const live = { ...makeSession({ name: "live-check-tmp", status: "blocked" }), cwd: "/nowhere/live-check-tmp" };
  const lacy = { ...makeSession({ name: "lacy", status: "idle" }), cwd: "/nowhere/lacy" };
  try {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await p.next("paired");
    await p.next("missed");
    await p.send({ type: "presence", state: "away" });
    await settle();
    /** The sessions as the phone was last told them. */
    const told = async () => {
      let last = await p.next("sessions");
      while (p.count("sessions")) last = await p.next("sessions");
      return last.sessions.map((x: any) => [x.name, x.status]);
    };

    ui.set({ sessions: [live, lacy], sessionsLoaded: true, permission: { id: "prompt-live", sessionId: live.sessionId, name: "live-check-tmp", what: "run: ls", risky: false } });
    ui.spoken("Live check tmp wants to run ls. Allow?", { name: "live-check-tmp", sessionId: live.sessionId });
    const line = (await p.next("missed_line")).item;
    assert.equal(line.kind, "permission");
    await settle();
    assert.deepEqual(await told(), [
      ["live-check-tmp", "needs_you"],
      ["lacy", "idle"],
    ]);
    // Its window ran out: let go to its own window, where its dialog is (still listed blocked).
    ui.set({ permission: null });
    await settle();
    // Killed: `claude agents` doesn't list it any more. One listing alone could be one that failed.
    ui.set({ sessions: [lacy] });
    await settle();
    assert.equal(p.count("missed_settled"), 0);
    ui.set({ sessions: [{ ...lacy }] });
    const settled = await p.next("missed_settled");
    assert.deepEqual(
      settled.items.map((x: any) => [x.id, x.settled.how]),
      [[line.id, "closed"]],
    );
    assert.deepEqual(await told(), [["lacy", "idle"]]);
    assert.ok(!server.missed.open().some((x) => x.sessionId === live.sessionId), "nothing of it left open");
    await p.close();
  } finally {
    server.stop();
    ui.set({ sessions: [], permission: null });
  }
});
