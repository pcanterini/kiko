// Whether you're at the Mac when a line goes to an away phone (src/remote/at-mac.ts): input in the
// last 2 minutes and the screen unlocked and awake; not when the Mac can't tell. Read at most once
// in a moment, however many ask.
import "../../setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { AT_MAC_IDLE_MS, atMac, MacPresence } from "../../../src/remote/at-mac.ts";
import { parseHelper, parseIdle, parseLocked } from "../../../src/platform/macos/presence.ts";

test("at the Mac: recent input, unlocked, awake; anything else isn't", () => {
  assert.equal(AT_MAC_IDLE_MS, 120_000);
  assert.equal(atMac({ idleMs: 0, locked: false, asleep: false }), true);
  assert.equal(atMac({ idleMs: 119_000, locked: false, asleep: false }), true);
  assert.equal(atMac({ idleMs: 120_000, locked: false, asleep: false }), false, "idle 2 minutes: away");
  assert.equal(atMac({ idleMs: 1_000, locked: true, asleep: false }), false, "locked: away, however recent");
  assert.equal(atMac({ idleMs: 1_000, locked: false, asleep: true }), false, "asleep: away");
  assert.equal(atMac(null), false, "can't tell: notify, as before");
});

test("read once in a moment: calls meanwhile share it; a failed read is 'can't tell'", async () => {
  let now = 1_000;
  let reads = 0;
  let fail = false;
  const p = new MacPresence(
    async () => {
      reads++;
      if (fail) throw new Error("no helper");
      return { idleMs: 500, locked: false, asleep: false };
    },
    () => now,
  );
  assert.equal(p.latest(), null);
  const [a, b] = await Promise.all([p.check(), p.check()]);
  assert.equal(reads, 1);
  assert.deepEqual(a, b);
  assert.equal(a.atMac, true);
  now += 1_000;
  assert.equal(p.latest()?.atMac, true);
  await p.check();
  assert.equal(reads, 1, "still fresh");
  now += 1_000;
  assert.equal(p.latest(), null);
  fail = true;
  assert.deepEqual(await p.check(), { atMac: false, reading: null });
  assert.equal(reads, 2);
});

test("the Mac's readings: the helper's line, else ioreg's HIDIdleTime and the console's lock", () => {
  assert.deepEqual(parseHelper('{"idleMs":1234,"locked":false,"asleep":true}\n'), { idleMs: 1234, locked: false, asleep: true });
  assert.equal(parseHelper('{"idleMs":-1,"locked":false,"asleep":false}'), null, "no idle time: can't tell");
  assert.equal(parseHelper("not json"), null);
  assert.equal(parseHelper(null), null);
  assert.equal(parseIdle('  |   "HIDIdleTime" = 329037041\n'), 329);
  assert.equal(parseIdle("nothing"), null);
  assert.equal(parseLocked('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes})'), true);
  assert.equal(parseLocked('"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})'), false);
});
