// What the Mac's output didn't play (src/core/unplayed.ts). On 2026-10-29 the Mac's output was AirPods that were with
// the iPhone: Lacy's reply went to a device that took no sound, and Kiko sat in "speaking" for three minutes. Now
// the player gives up on it; what was cut is said on screen, stays to be repeated, and is said again once sound is
// back: once, in order, not when you had it repeated already, and not when it's old. The queue and the player are
// driven by hand, in the order the app sees them (speaker.ts onStalled, then the idle; onBack later).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AudioQueue } from "../../../src/core/audio-queue.ts";
import { MAX_AGE_MS, notice, Unplayed, type Said } from "../../../src/core/unplayed.ts";
import { FakeClock } from "../../support/clock.ts";

const reply = (name: string, text = `${name} says hi.`): Said => ({ sessionId: `${name}-id`, name, kind: "reply", text });
const line = (text: string): Said => ({ sessionId: null, name: null, kind: "line", text });

describe("the notice", () => {
  test("one session's reply: where, whose, and how to hear it", () => {
    assert.equal(notice("AirPods", [reply("Lacy")]), "Couldn't play on AirPods, so Lacy's reply wasn't heard. Say 'repeat that' to hear it.");
  });

  test("a permission question, and the app's own line", () => {
    assert.equal(notice("AirPods", [{ ...reply("Pixie"), kind: "question" }]), "Couldn't play on AirPods, so Pixie's question wasn't heard. Say 'repeat that' to hear it.");
    assert.equal(notice("Desk Speakers", [line("I didn't send it.")]), "Couldn't play on Desk Speakers, so what I said wasn't heard. Say 'repeat that' to hear it.");
  });

  test("several: each named, and how to hear one", () => {
    assert.equal(
      notice("AirPods", [reply("Lacy"), reply("Pixie"), line("Sent.")]),
      "Couldn't play on AirPods, so Lacy's reply, Pixie's reply and what I said weren't heard. Say 'repeat' and a session's name to hear one.",
    );
  });

  test("the device not known (the backstop), or nothing it knows of being said", () => {
    assert.equal(notice(null, [reply("Lacy")]), "Couldn't play the sound, so Lacy's reply wasn't heard. Say 'repeat that' to hear it.");
    assert.equal(notice("AirPods", []), "Couldn't play on AirPods, so what I was saying wasn't heard.");
  });
});

describe("what's owed, and said again once sound is back", () => {
  test("in the order it was said, once each", () => {
    const clock = new FakeClock();
    const u = new Unplayed(clock);
    const lacy = reply("Lacy");
    const pixie = reply("Pixie");
    u.stalled("AirPods", [lacy]);
    clock.advance(6000);
    u.stalled("AirPods", [pixie]);
    assert.equal(u.size, 2);
    assert.deepEqual(u.back(), [lacy, pixie]);
    assert.deepEqual(u.back(), [], "nothing left");
    // Said again and stalled again: kept for "repeat that", not said again by itself (no loop).
    u.stalled("AirPods", [lacy]);
    assert.deepEqual(u.back(), []);
  });

  test("its words filled in after the stall (the summary was still coming) are what's said", () => {
    const u = new Unplayed(new FakeClock());
    const lacy = reply("Lacy", "");
    u.stalled("AirPods", [lacy]);
    lacy.text = "In Lacy, the tooltips are live.";
    assert.deepEqual(
      u.back().map((s) => s.text),
      ["In Lacy, the tooltips are live."],
    );
  });

  test("not one with no words (its summary failed), one you had repeated meanwhile, nor a permission question", () => {
    const u = new Unplayed(new FakeClock());
    u.stalled("AirPods", [reply("Lacy", ""), reply("Pixie", "In Pixie, done."), { ...reply("Tideline"), kind: "question" }]);
    u.repeated("In Pixie, done.");
    assert.deepEqual(u.back(), []);
  });

  test("not one older than MAX_AGE_MS: out of nowhere by then", () => {
    const clock = new FakeClock();
    const u = new Unplayed(clock);
    const old = reply("Lacy");
    u.stalled("AirPods", [old]);
    clock.advance(MAX_AGE_MS + 1);
    const fresh = reply("Pixie");
    u.stalled("AirPods", [fresh]);
    assert.deepEqual(u.back(), [fresh]);
  });

  test("the same one cut twice before sound is back is owed once", () => {
    const u = new Unplayed(new FakeClock());
    const lacy = reply("Lacy");
    u.stalled("AirPods", [lacy]);
    u.stalled("AirPods", [lacy]);
    assert.equal(u.size, 1);
  });
});

describe("through the queue, as app.ts wires it", () => {
  test("a reply the output took none of: speaking ends, it's named on screen, and said again when sound is back", () => {
    const written: string[] = [];
    const events: string[] = [];
    const q = new AudioQueue<Said>((b) => written.push(b.toString("latin1").replace(/\0+$/, "")));
    q.onPlaying = () => events.push("playing");
    q.onIdle = () => events.push("idle");
    const u = new Unplayed(new FakeClock());
    const lacy = reply("Lacy", "");
    const s = q.speech(lacy);
    s.audio(Buffer.concat([Buffer.from("lacy"), Buffer.alloc(2400 * 2 - 4)]));
    q.playing(); // said at once by the player, sound or not
    s.end();
    lacy.text = "In Lacy, the tooltips are live.";
    // 5 s on, nothing came out: the player says "stalled", then "idle".
    const shown = u.stalled("AirPods", q.stalled(100));
    q.idle();
    assert.equal(shown, "Couldn't play on AirPods, so Lacy's reply wasn't heard. Say 'repeat that' to hear it.");
    assert.deepEqual(events, ["playing", "idle"], "speaking is over: the floor goes on");
    assert.equal(q.busy(), false);
    assert.deepEqual(u.back(), [lacy]);
  });
});
