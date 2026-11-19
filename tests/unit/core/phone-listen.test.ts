// Hands-free from a phone (src/core/phone-listen.ts): each phone's own listener, the Mac's hands-free
// (hands-free.ts, wake.ts Listener) on the audio that phone sends while someone talks. On a fake
// clock, with a fake speech-to-text and made-up audio: the name wakes it and the quiet after the
// words ends them, as on the Mac; phrases without the name are only counted (never what was said);
// a reply in a session's window needs no name in a quiet room, the moments the app stopped and the
// mic came back watched between the phone's sparse chunks; nothing is heard while the app talks or
// the floor is someone else's; one listener per phone; the phone told how it is.
import "../../setup.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { DEAF_TAIL_MS, PHONE_PLAYING_MAX_MS, WATCH_MS } from "../../../src/core/hands-free.ts";
import { PhoneListeners, type PhoneListenState } from "../../../src/core/phone-listen.ts";
import { setSpokenName } from "../../../src/core/name.ts";
import { END_SILENCE_MS, ONSET_MS } from "../../../src/core/wake.ts";
import type { LocalTranscriber } from "../../../src/platform/types.ts";
import { FakeClock } from "../../support/clock.ts";

setSpokenName("Kiko");

/** A stand-in for Apple's speech-to-text: what it was sent, and words when the test says. */
class FakeStt implements LocalTranscriber {
  onInterim: (text: string) => void = () => {};
  onRestarted: () => void = () => {};
  sent = 0;
  begun = 0;
  closed = false;
  final = "";
  async connect() {}
  begin() {
    this.begun++;
    this.final = "";
  }
  send(chunk: Buffer) {
    this.sent += chunk.length;
  }
  async finish() {
    return this.final;
  }
  setHints() {}
  hinted() {
    return false;
  }
  audioSeconds() {
    return this.sent / 32000;
  }
  close() {
    this.closed = true;
  }
  /** Words as it hears them so far (the final transcript too). */
  says(text: string) {
    this.final = text;
    this.onInterim(text);
  }
}

/** 100 ms of 16 kHz PCM: someone talking (loud), or the room (quiet). */
const voice = () => tone(8000);
const room = () => tone(30);
function tone(amp: number) {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2);
  return b;
}

type World = ReturnType<typeof makeWorld>;

function makeWorld(o: { holding?: boolean } = {}) {
  const clock = new FakeClock();
  const stts: FakeStt[] = [];
  const states: Array<[string, PhoneListenState]> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const events: string[] = [];
  const requests: Array<{ phoneId: string; text: string; by: string }> = [];
  const w = {
    clock,
    stts,
    states,
    logs,
    events,
    requests,
    talking: false,
    floorFree: o.holding ?? true,
    window: false,
    asks: null as "yes-no" | "choice" | null,
  };
  const listeners = new PhoneListeners({
    fix: (t) => t,
    talking: () => w.talking,
    replyWindow: () => w.window,
    asks: () => w.asks,
    holding: (phoneId, _l, by) => {
      events.push(`holding ${phoneId} ${by}${w.floorFree ? "" : " (busy)"}`);
      return w.floorFree;
    },
    named: (phoneId) => void events.push(`named ${phoneId}`),
    request: (phoneId, _l, text, heard) => void requests.push({ phoneId, text, by: heard.by }),
    dropped: (phoneId) => void events.push(`dropped ${phoneId}`),
    interim: () => {},
    level: () => {},
    state: (phoneId, s) => void states.push([phoneId, s]),
    log: (event, fields) => void logs.push([event, fields]),
    transcriber: () => {
      const s = new FakeStt();
      stts.push(s);
      return s;
    },
    clock,
  });
  return Object.assign(w, { listeners });
}

/** Lets the final transcript's promise settle. */
const settle = () => new Promise((r) => setImmediate(r));

/**
 * Someone talking near the phone, as its gate sends it: the moment before the voice (its pre-roll,
 * the room: at once, as the phone sends it), then `ms` of voice in 100 ms chunks, time moving on.
 */
function send(w: World, phoneId: string, ms: number) {
  for (let i = 0; i < 4; i++) w.listeners.audio(phoneId, room());
  for (let t = 0; t < ms; t += 100) {
    w.listeners.audio(phoneId, voice());
    w.clock.advance(100);
  }
}

describe("a phone's hands-free", () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });

  test("on: its own speech-to-text, the phone told, logged; audio before it is dropped", async () => {
    w.listeners.audio("p1", voice());
    assert.equal(w.stts.length, 0);
    assert.equal(await w.listeners.on("p1"), null);
    assert.equal(w.stts.length, 1);
    assert.deepEqual(w.states, [["p1", { on: true, by: null }]]);
    assert.deepEqual(w.logs.at(-1), ["phone_hands_free", { phoneId: "p1", on: true }]);
    send(w, "p1", 200);
    assert.equal(w.stts[0].sent, 6 * 3200, "what the phone sent goes to its speech-to-text");
  });

  test("the name wakes it; the quiet after the words ends them, as on the Mac", async () => {
    await w.listeners.on("p1");
    const stt = w.stts[0];
    send(w, "p1", 300);
    stt.says("Kiko, ask pixie if it deployed");
    assert.deepEqual(w.events, ["holding p1 name", "named p1"]);
    assert.deepEqual(w.states.at(-1), ["p1", { on: true, by: "name" }], "the phone shows it's woken");
    assert.deepEqual(w.logs.at(-1), ["phone_wake", { phoneId: "p1", by: "name" }]);
    send(w, "p1", 500);
    // Nothing more from the phone (its gate is closed): the Mac's own timers end it.
    w.clock.advance(END_SILENCE_MS + 100);
    await settle();
    assert.deepEqual(w.requests, [{ phoneId: "p1", text: "Kiko, ask pixie if it deployed", by: "name" }]);
    w.listeners.done("p1", "talk-1");
    assert.deepEqual(w.states.at(-1), ["p1", { on: true, by: null, talkId: "talk-1" }]);
  });

  test("the name, then nothing: let go after the wait", async () => {
    await w.listeners.on("p1");
    send(w, "p1", 300);
    w.stts[0].says("Kiko.");
    w.clock.advance(6000);
    assert.deepEqual(w.events, ["holding p1 name", "named p1", "dropped p1"]);
    assert.deepEqual(w.states.at(-1), ["p1", { on: true, by: null }]);
    assert.deepEqual(w.requests, []);
  });

  test("talk without the name is only counted: never what was said", async () => {
    await w.listeners.on("p1");
    send(w, "p1", 400);
    w.stts[0].says("did you see the game last night");
    w.clock.advance(3000);
    send(w, "p1", 300);
    w.stts[0].says("no I missed it");
    w.clock.advance(3000);
    assert.deepEqual(w.events, []);
    w.listeners.off("p1");
    const ignored = w.logs.find(([e]) => e === "phone_listen_ignored");
    assert.ok(ignored, "counted");
    assert.equal(ignored[1].count, 2);
    assert.ok(!JSON.stringify(w.logs).includes("game"), "nothing said is logged");
    assert.deepEqual(w.logs.at(-1), ["phone_hands_free", { phoneId: "p1", on: false, why: "phone", audioChunks: 15, ignored: 2 }]);
    assert.deepEqual(w.states.at(-1), ["p1", { on: false, by: null }]);
    assert.equal(w.stts[0].closed, true);
  });

  test("deaf while the app talks: nothing reaches speech-to-text, then DEAF_TAIL_MS after", async () => {
    await w.listeners.on("p1");
    w.talking = true;
    send(w, "p1", 300);
    assert.equal(w.stts[0].sent, 0);
    assert.ok(w.stts[0].begun >= 2, "the transcript started afresh");
    w.talking = false;
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0, "the tail");
    w.clock.advance(DEAF_TAIL_MS);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });

  test("a reply in a session's window needs no name, the room quiet: the mic's return watched between the phone's chunks", async () => {
    await w.listeners.on("p1");
    // The app speaks for a second (the phone sends nothing meanwhile: it plays it), then the window opens.
    w.talking = true;
    w.clock.advance(1000);
    w.talking = false;
    w.window = true;
    w.asks = "yes-no";
    // You answer two seconds later: the first the Mac hears from the phone since the app spoke.
    w.clock.advance(2000);
    send(w, "p1", 300);
    w.stts[0].says("Yes, go ahead");
    assert.deepEqual(w.events, ["holding p1 reply"]);
    assert.deepEqual(w.states.at(-1), ["p1", { on: true, by: "reply" }]);
    w.clock.advance(END_SILENCE_MS + 200);
    await settle();
    assert.deepEqual(w.requests, [{ phoneId: "p1", text: "Yes, go ahead", by: "reply" }]);
  });

  test("a voice already there as the mic came back: that window needs the name, as on the Mac", async () => {
    await w.listeners.on("p1");
    w.talking = true;
    w.clock.advance(1000);
    w.talking = false;
    w.window = true;
    // Back DEAF_TAIL_MS after the app stopped (seen by the watch, no audio needed), and a voice at once.
    w.clock.advance(DEAF_TAIL_MS + WATCH_MS);
    assert.ok(ONSET_MS > WATCH_MS);
    send(w, "p1", 300);
    w.stts[0].says("so anyway the thing is");
    w.clock.advance(3000);
    assert.deepEqual(w.events, [], "not taken as the reply");
    assert.ok(w.logs.some(([e, f]) => e === "phone_reply_window_needs_name" && f.why === "onset"));
  });

  test("the floor someone else's (the Mac's key, another listener): it isn't taken, and what it heard goes", async () => {
    w.floorFree = false;
    await w.listeners.on("p1");
    send(w, "p1", 300);
    w.stts[0].says("Kiko, what's up");
    await settle();
    assert.deepEqual(w.events, ["holding p1 name (busy)"]);
    assert.ok(!w.states.some(([, s]) => s.by), "the phone never shows it woken");
    w.clock.advance(4000);
    await settle();
    assert.deepEqual(w.requests, []);
  });

  test("one listener per phone, each phone its own; dropAll tells a woken phone it isn't now", async () => {
    await w.listeners.on("p1");
    await w.listeners.on("p1");
    await w.listeners.on("p2");
    assert.equal(w.stts.length, 2, "on again (a phone that reconnected) keeps the one it has");
    assert.equal(w.listeners.all().length, 2);
    send(w, "p2", 300);
    w.stts[1].says("Kiko, stop pixie");
    assert.deepEqual(w.states.at(-1), ["p2", { on: true, by: "name" }]);
    const l2 = w.listeners.all().find((x) => x.phoneId === "p2")!.listener;
    assert.equal(w.listeners.phoneOf(l2), "p2");
    w.listeners.dropAll(null); // the Mac's key went down
    assert.deepEqual(w.states.at(-1), ["p2", { on: true, by: null }]);
    w.clock.advance(5000);
    await settle();
    assert.deepEqual(w.requests, [], "what it was taking is gone, with no callback");
  });

  test("off while woken: the floor it held goes; the phone gone: no one to tell", async () => {
    await w.listeners.on("p1");
    send(w, "p1", 300);
    w.stts[0].says("Kiko, deploy it");
    w.listeners.off("p1", "away");
    assert.deepEqual(w.events, ["holding p1 name", "named p1", "dropped p1"]);
    assert.deepEqual(w.states.at(-1), ["p1", { on: false, by: null }]);
    await w.listeners.on("p2");
    const told = w.states.length;
    w.listeners.stopAll();
    assert.equal(w.states.length, told, "a phone that's gone isn't told");
    assert.ok(w.stts.every((s) => s.closed));
    w.listeners.audio("p2", voice());
    assert.equal(w.stts[1].sent, 0, "audio after it's off is dropped");
  });

  test("its speech-to-text can't start: the phone told why, nothing left running", async () => {
    const broken = new PhoneListeners({
      fix: (t) => t,
      talking: () => false,
      replyWindow: () => false,
      holding: () => true,
      named: () => {},
      request: () => {},
      dropped: () => {},
      interim: () => {},
      level: () => {},
      state: (phoneId, s) => void w.states.push([phoneId, s]),
      log: (event, fields) => void w.logs.push([event, fields]),
      transcriber: () => Object.assign(new FakeStt(), { connect: async () => Promise.reject(new Error("needs macOS 26")) }),
      clock: w.clock,
    });
    assert.equal(await broken.on("p1"), "needs macOS 26");
    assert.deepEqual(w.states.at(-1), ["p1", { on: false, by: null, error: "needs macOS 26" }]);
    assert.equal(broken.all().length, 0);
    assert.equal(broken.listening("p1"), false);
  });
});

/**
 * The phone says when it plays the app's voice and when its mic is back (hands_free_playing): its
 * listener's deaf window, and the moment the reply window's quiet room is judged from, are the
 * phone's own, not a guess from when the Mac stopped sending. Times are from when the app stops
 * talking on the Mac (`talking` false: its own guess of the phone's end, PHONE_LAG_MS included).
 */
describe("a phone's hands-free, its deaf window the phone's own playback", () => {
  let w: World;
  beforeEach(() => {
    w = makeWorld();
  });

  /** The app speaks for `ms` (the phone starts playing it 300 ms in), then stops; a session's window opens. */
  function speaks(ms = 3000, o: { phonePlays?: boolean } = {}) {
    w.talking = true;
    w.clock.advance(300);
    if (o.phonePlays ?? true) w.listeners.playing("p1", true);
    w.clock.advance(ms - 300);
    w.talking = false;
    w.window = true;
    w.asks = "yes-no";
  }

  const needsName = () => w.logs.filter(([e]) => e === "phone_reply_window_needs_name").map(([, f]) => f);

  async function replies(text: string) {
    send(w, "p1", 600);
    w.stts[0].says(text);
    w.clock.advance(END_SILENCE_MS + 200);
    await settle();
  }

  test("the phone silent about its playback: a reply 150 ms after the Mac's guess needs the name (the Mac's timing, unchanged)", async () => {
    await w.listeners.on("p1");
    speaks(3000, { phonePlays: false });
    // The phone finished playing ~100 ms before the Mac's guess, and its mic was back 300 ms later;
    // you answered ~350 ms after that, and the Mac, deaf until DEAF_TAIL_MS after its guess, heard
    // your voice as already there.
    w.clock.advance(DEAF_TAIL_MS + 150);
    await replies("Yes, go ahead with that");
    assert.deepEqual(w.requests, []);
    assert.equal(needsName().length, 1);
    assert.equal(needsName()[0].why, "onset");
    assert.ok((needsName()[0].ms as number) <= ONSET_MS);
    assert.equal(needsName()[0].back, undefined, "the Mac's own timing");
  });

  test("the same, the phone saying when its mic is back: the reply is taken", async () => {
    await w.listeners.on("p1");
    speaks(3000);
    // Its playback over 100 ms before the Mac's guess, its mic back 300 ms after that.
    w.clock.advance(200);
    w.listeners.playing("p1", false);
    w.clock.advance(DEAF_TAIL_MS + 150 - 200);
    await replies("Yes, go ahead with that");
    assert.deepEqual(needsName(), []);
    assert.deepEqual(w.requests, [{ phoneId: "p1", text: "Yes, go ahead with that", by: "reply" }]);
  });

  for (const lag of [300, 600]) {
    test(`the phone's playback over ${lag} ms after the Mac's: deaf until its mic is back, and you answering a second after it stopped are taken`, async () => {
      await w.listeners.on("p1");
      speaks(3000);
      // Still playing on the phone after the Mac's own tail: whatever comes now isn't heard.
      w.clock.advance(DEAF_TAIL_MS + WATCH_MS);
      w.listeners.audio("p1", voice());
      assert.equal(w.stts[0].sent, 0, "deaf while the phone still plays");
      w.clock.advance(lag + 300 - DEAF_TAIL_MS - WATCH_MS);
      w.listeners.playing("p1", false);
      w.clock.advance(1000 - 300);
      await replies("Yes, ship it");
      assert.deepEqual(needsName(), []);
      assert.deepEqual(w.requests, [{ phoneId: "p1", text: "Yes, ship it", by: "reply" }]);
    });

    test(`a TV talking through the app's words, the phone's playback over ${lag} ms after the Mac's: there as the phone's mic comes back, so the window needs the name`, async () => {
      await w.listeners.on("p1");
      // The room as the phone sent it before (a pre-roll): the Mac's gate knows its noise.
      for (let i = 0; i < 4; i++) w.listeners.audio("p1", room());
      speaks(3000);
      w.clock.advance(lag + 300);
      w.listeners.playing("p1", false);
      // The phone's gate opens on it at once (its pre-roll: only what came after its mic was back).
      w.clock.advance(40);
      for (let t = 0; t < 600; t += 100) {
        w.listeners.audio("p1", voice());
        w.clock.advance(100);
      }
      w.stts[0].says("and in other news tonight the markets");
      w.clock.advance(3000);
      await settle();
      assert.deepEqual(w.requests, []);
      assert.deepEqual(w.events, [], "not taken as the reply");
      assert.equal(needsName().length, 1);
      assert.deepEqual({ ...needsName()[0], ms: undefined }, { phoneId: "p1", why: "onset", ms: undefined, because: "a voice already there as the mic came back", back: "phone" });
      assert.ok((needsName()[0].ms as number) <= ONSET_MS);
      assert.ok(w.logs.some(([e, f]) => e === "phone_reply_window_ignored" && f.why === "needs the name"));
    });
  }

  test("a TV talking before the app spoke still makes the window need the name", async () => {
    await w.listeners.on("p1");
    send(w, "p1", 1500);
    w.stts[0].says("and in other news tonight");
    w.clock.advance(3000); // ignored: talk without the name
    speaks(3000);
    w.clock.advance(400);
    w.listeners.playing("p1", false);
    w.clock.advance(1500);
    await replies("yes do it");
    assert.deepEqual(w.requests, []);
    assert.equal(needsName()[0]?.why, "before");
  });

  test("its playback over (and its mic back) while the Mac still guesses it plays: back as the app stops, no tail of the Mac's", async () => {
    await w.listeners.on("p1");
    w.talking = true;
    w.clock.advance(300);
    w.listeners.playing("p1", true);
    w.clock.advance(2000);
    w.listeners.playing("p1", false);
    w.clock.advance(200);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0, "deaf while the app talks");
    w.talking = false;
    w.clock.advance(WATCH_MS);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200, "heard at once, not DEAF_TAIL_MS later");
  });

  test("a phone that never says its mic is back is heard again PHONE_PLAYING_MAX_MS after the app stopped", async () => {
    await w.listeners.on("p1");
    speaks(3000);
    w.clock.advance(PHONE_PLAYING_MAX_MS - 100);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0);
    w.clock.advance(100 + WATCH_MS);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });

  test("the phone playing on its own after the app stopped (a late cue): deaf until its mic is back", async () => {
    await w.listeners.on("p1");
    w.clock.advance(1000);
    w.listeners.playing("p1", true);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0);
    w.clock.advance(500);
    w.listeners.playing("p1", false);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });

  test("a stretch the phone didn't play (the Mac's speaker only): the Mac's tail, as before", async () => {
    await w.listeners.on("p1");
    // It played the last one, and said its mic was back.
    speaks(2000);
    w.clock.advance(400);
    w.listeners.playing("p1", false);
    w.clock.advance(2000);
    // This one it doesn't play.
    w.window = false;
    speaks(1000, { phonePlays: false });
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0, "the tail");
    w.clock.advance(DEAF_TAIL_MS + WATCH_MS);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });

  test("a phone that connected again starts afresh: not deaf on a word from before", async () => {
    await w.listeners.on("p1");
    w.listeners.playing("p1", true);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 0);
    await w.listeners.on("p1");
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });

  test("woken, the phone's playing (its cue) changes nothing: everything it sends is heard", async () => {
    await w.listeners.on("p1");
    send(w, "p1", 300);
    w.stts[0].says("Kiko, ask pixie");
    const before = w.stts[0].sent;
    w.listeners.playing("p1", true);
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, before + 3200);
  });

  test("ignored once its listener is off", async () => {
    w.listeners.playing("p1", true);
    await w.listeners.on("p1");
    w.listeners.audio("p1", voice());
    assert.equal(w.stts[0].sent, 3200);
  });
});
