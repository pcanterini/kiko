// Hands-free (src/core/hands-free.ts) around the app's own words: the mic dropped while it speaks,
// and back DEAF_TAIL_MS after. Talk without the name going on as it starts to speak makes the window
// after it need the name (logged, and shown); in a quiet room a reply without the name still works.
// Fakes only: no speech helper, no mic; real time for the deaf tail (under a second a test).
import "../../setup.ts";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DEAF_TAIL_MS, HandsFree } from "../../../src/core/hands-free.ts";
import { platform } from "../../../src/platform/index.ts";
import type { LocalTranscriber, Mic } from "../../../src/platform/types.ts";
import { setSpokenName } from "../../../src/core/name.ts";
import { ONSET_MS } from "../../../src/core/wake.ts";

setSpokenName("Kiko");

const pcm = (amplitude: number) => {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 5) * amplitude), i * 2);
  return b;
};
const QUIET = pcm(0);
const VOICE = pcm(3000);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let real: typeof platform.speech;
let stt: LocalTranscriber;
beforeEach(() => {
  stt = {
    onInterim: () => {},
    onRestarted: () => {},
    connect: async () => {},
    begin: () => {},
    send: () => {},
    finish: async () => "",
    setHints: () => {},
    hinted: () => false,
    audioSeconds: () => 0,
    close: () => {},
  } as LocalTranscriber;
  real = platform.speech;
  platform.speech = { create: () => stt };
});
afterEach(() => {
  platform.speech = real;
});

async function handsFree(fix = (text: string) => text) {
  const mic = { open: () => {}, close: () => {}, stop: () => {}, setDevice: () => {} } as unknown as Mic;
  const o = {
    talking: false,
    window: false,
    changed: 0,
    held: [] as string[],
    log: [] as Array<[string, Record<string, unknown>]>,
    requests: [] as Array<{ text: string; by: string }>,
  };
  const hf = new HandsFree({
    mic,
    fix,
    talking: () => o.talking,
    replyWindow: () => o.window,
    asks: () => "yes-no",
    changed: () => o.changed++,
    holding: (by) => o.held.push(by),
    named: () => {},
    request: (text, heard) => o.requests.push({ text, by: heard.by }),
    dropped: () => {},
    interim: () => {},
    level: () => {},
    log: (event, fields) => o.log.push([event, fields]),
    timing: { endSilenceMs: 50 },
  });
  assert.equal(await hf.start(), null);
  for (let i = 0; i < 5; i++) hf.sink(QUIET); // the room's own noise, for the gate
  return { hf, o };
}

/** The app speaks: the mic dropped, then back DEAF_TAIL_MS after it stops, as its window opens. */
async function appSpeaks(hf: HandsFree, o: { talking: boolean; window: boolean }) {
  o.talking = true;
  hf.sink(VOICE); // its own voice: dropped
  o.talking = false;
  o.window = true;
  hf.sink(VOICE); // its echo, in the tail: dropped
  await wait(DEAF_TAIL_MS + 30);
}

describe("hands-free: someone else talking around the app's words", () => {
  test("a TV going on as the app starts to speak: the window needs the name, logged and shown", async () => {
    const { hf, o } = await handsFree();
    try {
      hf.sink(VOICE);
      stt.onInterim("and in other news tonight the weather");
      await appSpeaks(hf, o);
      hf.sink(QUIET);
      assert.equal(hf.replyNeedsName, true);
      assert.equal(o.changed, 1, "the status is written again");
      const logged = o.log.filter(([e]) => e === "reply_window_needs_name");
      assert.equal(logged.length, 1);
      assert.equal(logged[0][1].why, "during");
      assert.match(String(logged[0][1].because), /going on as the app started to speak/);
      stt.onInterim("Yes, go ahead.");
      assert.deepEqual(o.held, [], "not taken as a reply without the name");
      // The window closes: nothing to show any more.
      o.window = false;
      assert.equal(hf.replyNeedsName, false);
    } finally {
      hf.stop();
    }
  });

  test("a voice there the moment the mic comes back", async () => {
    const { hf, o } = await handsFree();
    try {
      await appSpeaks(hf, o);
      hf.sink(VOICE);
      assert.equal(hf.replyNeedsName, true);
      assert.equal(o.log.find(([e]) => e === "reply_window_needs_name")?.[1].why, "onset");
    } finally {
      hf.stop();
    }
  });

  test("a quiet room: 'yes' without the name is the reply", async () => {
    const { hf, o } = await handsFree();
    try {
      await appSpeaks(hf, o);
      hf.sink(QUIET);
      await wait(ONSET_MS + 50); // you take a moment to answer
      hf.sink(VOICE);
      stt.onInterim("Yes.");
      assert.equal(hf.replyNeedsName, false);
      assert.deepEqual(o.held, ["reply"]);
      assert.equal(o.log.filter(([e]) => e === "reply_window_needs_name").length, 0);
    } finally {
      hf.stop();
    }
  });

  test("'Hey Kiku, just testing.' in a reply window (the dictionary's kiku → Kiko): said to the app by name, not a reply", async () => {
    setSpokenName("Kiko");
    const { hf, o } = await handsFree((text) => text.replace(/\bkiku\b/gi, "Kiko"));
    try {
      o.window = true;
      stt.finish = async () => "Hey Kiku, just testing.";
      stt.onInterim("Hey");
      assert.deepEqual(o.held, [], "'Hey' alone is nothing yet");
      stt.onInterim("Hey Kiku");
      stt.onInterim("Hey Kiku, just testing.");
      assert.deepEqual(o.held, ["name"]);
      await wait(150);
      assert.equal(o.requests.length, 1);
      assert.equal(o.requests[0].by, "name");
      assert.match(o.requests[0].text, /^Hey (Kiku|Kiko), just testing\.$/);
    } finally {
      hf.stop();
      setSpokenName("Kiko");
    }
  });

  test("a reply's final words get the dictionary's fixes, as its live words did", async () => {
    const { hf, o } = await handsFree((text) => text.replace(/\bclip kit\b/gi, "clipkit"));
    try {
      o.window = true;
      stt.finish = async () => "Yes, and tell clip kit too.";
      stt.onInterim("Yes, and tell clip kit too.");
      assert.deepEqual(o.held, ["reply"]);
      await wait(150);
      assert.deepEqual(o.requests, [{ text: "Yes, and tell clipkit too.", by: "reply" }]);
    } finally {
      hf.stop();
    }
  });
});
