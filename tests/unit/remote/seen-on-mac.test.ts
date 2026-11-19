// Seen on the Mac (src/remote/seen-on-mac.ts): a line kept for a phone that wasn't there, but that
// you took in at the Mac, is settled `seen_on_mac`. Said out loud there with input in the last 90 s
// and the screen unlocked and awake: at once. Only shown (or said while you'd been idle longer):
// once you use Kiko on the Mac within 2 minutes. Locked, asleep, or no telling: never. First the
// rule on a fake clock, then through a real server on 127.0.0.1 with a fake phone and a fake reading.
import "../../setup.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LocalPhone } from "../../support/local-phone.ts";
import { ui } from "../../../src/core/ui-store.ts";
import type { AtComputer } from "../../../src/platform/types.ts";
import type { Missed } from "../../../src/remote/missed.ts";
import { Pairing } from "../../../src/remote/pairing.ts";
import { invalid } from "../../../src/remote/schema.ts";
import { heardAtMac, SEEN_AFTER_MS, SEEN_IDLE_MS, SeenOnMac, shownOnMac, USED_INPUT_MS, usedAtMac } from "../../../src/remote/seen-on-mac.ts";
import { PhoneServer, type PhoneHub } from "../../../src/remote/server.ts";

const at = (idleMs: number, more: Partial<AtComputer> = {}): AtComputer => ({ idleMs, locked: false, asleep: false, ...more });

function rule() {
  let now = 1_000_000;
  const seen: Array<[number[], string]> = [];
  const s = new SeenOnMac({ seen: (ids, why) => void seen.push([ids, why]), now: () => now });
  return {
    s,
    seen,
    tick: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

test("the thresholds: heard with input in the last 90 s; shown while unlocked and awake; a use from elsewhere needs input in the last 15 s", () => {
  assert.equal(SEEN_IDLE_MS, 90_000);
  assert.equal(SEEN_AFTER_MS, 120_000);
  assert.equal(USED_INPUT_MS, 15_000);
  assert.equal(heardAtMac(at(90_000)), true);
  assert.equal(heardAtMac(at(90_001)), false, "idle longer: only shown");
  assert.equal(heardAtMac(at(0, { locked: true })), false);
  assert.equal(heardAtMac(at(0, { asleep: true })), false);
  assert.equal(heardAtMac(null), false, "can't tell: not seen");
  assert.equal(shownOnMac(at(60 * 60_000)), true, "idle an hour, but on screen");
  assert.equal(shownOnMac(at(0, { locked: true })), false);
  assert.equal(shownOnMac(at(0, { asleep: true })), false);
  assert.equal(shownOnMac(null), false);
  assert.equal(usedAtMac(at(15_000)), true);
  assert.equal(usedAtMac(at(15_001)), false);
  assert.equal(usedAtMac(at(0, { locked: true })), false);
});

test("said out loud while you were at the Mac: seen at once; not out loud, or idle longer: only once you use Kiko there", () => {
  const r = rule();
  assert.equal(r.s.said(1, r.now, true, at(5_000)), true);
  assert.deepEqual(r.seen, [[[1], "heard"]]);
  // Only shown (Play on this Mac off, a phone playing it): waits for a use.
  assert.equal(r.s.said(2, r.now, false, at(5_000)), false);
  // Out loud, but you'd been idle 2 minutes: waits too.
  assert.equal(r.s.said(3, r.now, true, at(120_000)), false);
  assert.deepEqual(r.s.waiting, [2, 3]);
  r.tick(60_000);
  r.s.used("key");
  assert.deepEqual(r.seen.slice(1), [[[2, 3], "key"]]);
  assert.deepEqual(r.s.waiting, []);
  // Used again: nothing more to see.
  r.s.used("window");
  assert.equal(r.seen.length, 2);
});

test("locked, asleep, or no telling: never seen, used or not", () => {
  const r = rule();
  assert.equal(r.s.said(1, r.now, true, at(1_000, { locked: true })), false);
  assert.equal(r.s.said(2, r.now, true, at(1_000, { asleep: true })), false);
  assert.equal(r.s.said(3, r.now, true, null), false);
  assert.deepEqual(r.s.waiting, []);
  r.tick(10_000);
  r.s.used("key");
  assert.deepEqual(r.seen, []);
});

test("a use counts for what was shown in the 2 minutes before it, never after", () => {
  const r = rule();
  r.s.said(1, r.now, false, at(5_000));
  r.tick(SEEN_AFTER_MS + 1);
  r.s.said(2, r.now, false, at(5_000));
  r.tick(30_000);
  r.s.used("typed");
  assert.deepEqual(r.seen, [[[2], "typed"]], "the first was over 2 minutes before");
  // A use first, then a line: not seen by that use (it came after); the next use sees it.
  r.tick(1_000);
  r.s.said(3, r.now, false, at(5_000));
  assert.deepEqual(r.s.waiting, [3]);
  r.tick(SEEN_AFTER_MS + 1);
  r.s.used("key");
  assert.equal(r.seen.length, 1, "used over 2 minutes after: not seen");
});

test("a use while the reading for a line was on its way still counts", () => {
  const r = rule();
  const said = r.now;
  r.tick(200);
  r.s.used("key"); // the press, before the line's reading came back
  r.tick(100);
  assert.equal(r.s.said(7, said, false, at(500)), true);
  assert.deepEqual(r.seen, [[[7], "key"]]);
  // A use before the line was said doesn't.
  r.tick(10_000);
  r.s.used("window");
  assert.equal(r.s.said(8, r.now + 1, false, at(500)), false);
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
const fresh = () => new Promise((resolve) => setTimeout(resolve, 1600)); // past the reading kept for a moment (at-mac.ts)

test("through the server: heard at the Mac goes to an away phone settled; shown, seen once the Mac is used; locked, never; Catch me up leaves the seen ones out", async () => {
  const summaries: Missed[][] = [];
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
    catchUpSummary: (items) => void summaries.push(items),
    catchUpStop: () => false,
  };
  let reading: AtComputer | null = at(5_000);
  let aloud = true;
  const pairing = new Pairing(join(process.cwd(), "phones-seen-on-mac.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0, atComputer: async () => reading, macHears: () => aloud });
  const port = await server.start();
  try {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await p.next("paired");
    await p.next("missed");
    await p.send({ type: "presence", state: "away" });
    await settle();

    // Said out loud, typing at the Mac a moment ago: it reaches the phone settled, so no notification.
    ui.spoken("Lacy finished the migration.", { name: "lacy", sessionId: "s1" });
    const heard = await p.next("missed_line");
    assert.deepEqual([heard.item.text, heard.item.settled?.how, heard.quiet], ["Lacy finished the migration.", "seen_on_mac", true]);
    assert.equal((await p.next("missed_settled")).items[0].settled.how, "seen_on_mac");

    // Only shown (the Mac didn't say it out loud): unread until Kiko is used on the Mac.
    aloud = false;
    ui.spoken("Clipkit pushed the fix.", { name: "clipkit", sessionId: "s2" });
    const shown = await p.next("missed_line");
    assert.equal(shown.item.settled, undefined);
    await settle();
    assert.equal(p.count("missed_settled"), 0);
    server.macUsed("key");
    const used = await p.next("missed_settled");
    assert.deepEqual(
      used.items.map((x: any) => [x.id, x.settled.how]),
      [[shown.item.id, "seen_on_mac"]],
    );

    // Locked as it was said: the talk key after doesn't make it seen.
    await fresh();
    reading = at(1_000, { locked: true });
    aloud = true;
    ui.spoken("Grove is waiting for you.", { name: "grove", sessionId: "s3" });
    const locked = await p.next("missed_line");
    assert.equal(locked.item.settled, undefined);
    await settle();
    server.macUsed("key");
    await settle();
    assert.equal(p.count("missed_settled"), 0, "locked: stays unread");

    // Idle a minute as it was shown: a prompt a session took in counts only with input at the Mac just then.
    await fresh();
    reading = at(60_000);
    aloud = false;
    ui.spoken("Dozer is done.", { name: "dozer", sessionId: "s4" });
    const idle = await p.next("missed_line");
    server.macUsed("prompt");
    await settle();
    assert.equal(p.count("missed_settled"), 0, "no input just then: it may have come from elsewhere");
    await fresh();
    reading = at(2_000);
    server.macUsed("prompt");
    const typed = await p.next("missed_settled");
    assert.deepEqual(
      typed.items.map((x: any) => [x.id, x.settled.how]),
      [[idle.item.id, "seen_on_mac"]],
    );

    // Back: the list has them all, the seen ones marked; Catch me up sums up only the one locked out.
    await p.send({ type: "presence", state: "back" });
    const missed = (await p.next("missed")).items;
    assert.deepEqual(
      missed.map((x: any) => [x.text, x.settled?.how ?? null]),
      [
        ["Lacy finished the migration.", "seen_on_mac"],
        ["Clipkit pushed the fix.", "seen_on_mac"],
        ["Grove is waiting for you.", null],
        ["Dozer is done.", "seen_on_mac"],
      ],
    );
    await p.send({ type: "catch_up", ids: missed.map((x: any) => x.id), summary: true });
    await settle();
    assert.deepEqual(
      summaries.map((s) => s.map((x) => x.text)),
      [["Grove is waiting for you."]],
    );
    // Still settled the usual ways: a reply to grove settles it as replied.
    server.sessionReplied("s3");
    assert.deepEqual(
      (await p.next("missed_settled")).items.map((x: any) => x.settled.how),
      ["replied"],
    );
    await p.close();
  } finally {
    server.stop();
  }
});

test("without a way to tell (no presence), nothing is seen on the Mac", async () => {
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
  const pairing = new Pairing(join(process.cwd(), "phones-seen-none.json"));
  const network = { addresses: async () => [], advertise: () => ({ stop() {} }), hostname: () => "mac.local" };
  const server = new PhoneServer({ hub, pairing, port: 0, host: "127.0.0.1", network, presenceSettleMs: 0, macHears: () => true });
  const port = await server.start();
  try {
    const p = phone(port);
    await p.send({ type: "pair", code: pairing.open().code, device: "Test iPhone", appVersion: "0.1.0" });
    await p.next("paired");
    await p.next("missed");
    await p.send({ type: "presence", state: "away" });
    await settle();
    ui.spoken("Lacy finished.", { name: "lacy", sessionId: "s1" });
    assert.equal((await p.next("missed_line")).item.settled, undefined);
    server.macUsed("key");
    await settle();
    assert.equal(p.count("missed_settled"), 0);
    await p.close();
  } finally {
    server.stop();
  }
});
