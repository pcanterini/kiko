// A line's words as the phone's read-along gets them (src/core/voice-marks.ts): the words on screen
// matched to what the voice said of them through the respellings (nginx said "engine-x", kiko.sh
// "kiko dot S H"), Cartesia's exact timestamps (a batch that starts over from 0 too), Pocket's
// sentences (their audio exactly, the words estimated within it, each sentence from its own start),
// the macOS voice's places in the text the phone says, and what doesn't fit (a number read out, an
// emoji, accents): skipped or matched, never thrown off.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { respellWords, respoken, type Pronunciation } from "../../../src/core/pronunciation.ts";
import type { Speech } from "../../../src/core/speech-lock.ts";
import { type LineMarks, lettersOf, VoiceLine } from "../../../src/core/voice-marks.ts";

const RATE = 24000;
const USER: Pronunciation[] = [{ word: "nginx", say: "engine-x" }];

/** A line fed `text` the way openSpeech feeds it (respelled for Cartesia, with USER), and what it sent. */
function line(text: string, voice: "cartesia" | "pocket" | "macos" = "cartesia") {
  const sent: LineMarks[] = [];
  const l = new VoiceLine((m) => sent.push(m), { id: 7 });
  const said: string[] = [];
  const speech: Speech = { push: (t) => said.push(t), end: () => {}, cancel: () => {}, chars: () => 0 };
  const s = respoken(speech, voice, USER, l.wrote);
  // Pushed in pieces, a word cut between two of them, as a model streams it.
  const cut = Math.floor(text.length / 2) + 1;
  s.push(text.slice(0, cut));
  s.push(text.slice(cut));
  s.end();
  return { l, sent, said: said.join("") };
}

const all = (sent: LineMarks[]) => sent.flatMap((m) => m.words);

describe("the words as written and as said", () => {
  test("respellWords gives each word as written and said, and where it is in the text said", () => {
    const r = respellWords("Restarted  nginx on kiko.sh.", "cartesia", USER);
    assert.equal(r.said, "Restarted  engine-x on kiko dot S H.");
    assert.deepEqual(
      r.words.map((w) => [w.written, w.said, r.said.slice(w.at, w.at + w.said.length)]),
      [
        ["Restarted", "Restarted", "Restarted"],
        ["nginx", "engine-x", "engine-x"],
        ["on", "on", "on"],
        ["kiko.sh.", "kiko dot S H.", "kiko dot S H."],
      ],
    );
  });

  test("letters compared without case, accents or punctuation", () => {
    assert.equal(lettersOf("Déjà-vu,"), "dejavu");
    assert.equal(lettersOf("🎉"), "");
  });
});

describe("Cartesia: exact, through the respellings", () => {
  test("each word on screen gets the time of what the voice said for it", async () => {
    const { l, sent, said } = line("Restarted nginx on kiko.sh.");
    assert.equal(said, "Restarted engine-x on kiko dot S H.");
    l.timestamps(["Restarted", "engine-x", "on", "kiko", "dot", "S", "H."], [0.06, 0.59, 1.18, 1.42, 1.8, 2.1, 2.4], [0.57, 1.16, 1.4, 1.78, 2.05, 2.35, 2.9]);
    l.flush();
    assert.deepEqual(all(sent), [
      { i: 0, text: "Restarted", start: 1440, end: 13680 },
      { i: 1, text: "nginx", start: 14160, end: 27840 },
      { i: 2, text: "on", start: 28320, end: 33600 },
      { i: 3, text: "kiko.sh.", start: 34080, end: 69600 },
    ]);
    assert.ok(sent.every((m) => m.exact && m.line === 7));
  });

  test("its words cut differently from ours (engine-x as two) still land on the word on screen", () => {
    const { l, sent } = line("Restarted nginx now");
    l.timestamps(["Restarted", "engine", "x", "now"], [0, 0.5, 0.9, 1.2], [0.45, 0.85, 1.1, 1.5]);
    l.flush();
    assert.deepEqual(
      all(sent).map((w) => [w.text, w.start, w.end]),
      [
        ["Restarted", 0, 10800],
        ["nginx", 12000, 26400],
        ["now", 28800, 36000],
      ],
    );
  });

  test("timestamps in batches, one starting over from 0: carried on from the last", () => {
    const { l, sent } = line("one two three four");
    l.timestamps(["one", "two"], [0.1, 0.5], [0.4, 0.9]);
    l.timestamps(["three", "four"], [0, 0.4], [0.3, 0.7]);
    l.flush();
    const starts = all(sent).map((w) => w.start! / RATE);
    assert.deepEqual(starts, [0.1, 0.5, 0.9, 1.3]);
  });

  test("a word said differently (a number read out) is skipped; the ones after it still match", () => {
    const { l, sent } = line("It took 42 seconds.");
    l.timestamps(["It", "took", "forty-two", "seconds."], [0, 0.2, 0.5, 1.1], [0.15, 0.45, 1.0, 1.6]);
    l.flush();
    assert.deepEqual(
      all(sent).map((w) => w.i),
      [0, 1, 3],
    );
  });

  test("accents and an emoji: the accented words match, the emoji has no time", () => {
    const { l, sent } = line("Café 🎉 déjà vu");
    l.timestamps(["Cafe", "deja", "vu"], [0, 0.5, 0.9], [0.4, 0.8, 1.2]);
    l.flush();
    assert.deepEqual(
      all(sent).map((w) => [w.i, w.text]),
      [
        [0, "Café"],
        [2, "déjà"],
        [3, "vu"],
      ],
    );
  });

  test("junk from the voice (NaN, missing ends, not arrays) is dropped, never thrown", () => {
    const { l, sent } = line("one two");
    l.timestamps(["one", "two"], [Number.NaN, 0.5], [] as number[]);
    l.timestamps(null as unknown as string[], [], []);
    l.flush();
    assert.deepEqual(all(sent), [{ i: 1, text: "two", start: 12000, end: 12000 }]);
  });
});

describe("Pocket: each sentence's audio exactly, its words estimated", () => {
  test("the second sentence's words come after the first sentence's audio, never before", () => {
    const { l, sent } = line("Sure thing. The tests pass now.", "pocket");
    const tone = (s: number) => {
      const b = Buffer.alloc(Math.round(s * RATE) * 2);
      for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / RATE)), i * 2);
      return b;
    };
    const quiet = (s: number) => Buffer.alloc(Math.round(s * RATE) * 2);
    l.sentence("Sure thing.");
    assert.deepEqual(l.audio(quiet(0.4)), { line: 7, at: 0 });
    l.audio(tone(0.6));
    l.audio(quiet(0.2));
    l.sentence("The tests pass now."); // ends the first
    const at = l.audio(quiet(0.3));
    assert.equal(at.at, Math.round(1.2 * RATE));
    l.audio(tone(1));
    l.sentenceDone();
    l.flush();
    const words = all(sent);
    assert.deepEqual(
      words.map((w) => w.text),
      ["Sure", "thing.", "The", "tests", "pass", "now."],
    );
    assert.ok(sent.every((m) => !m.exact));
    // "Sure" not before its sound (0.4 s); "The" not before the second sentence's sound (1.5 s).
    assert.ok(words[0].start! >= 0.4 * RATE);
    assert.ok(words[2].start! >= 1.5 * RATE, `The at ${words[2].start! / RATE}`);
    for (let k = 1; k < words.length; k++) assert.ok(words[k].start! >= words[k - 1].start!);
  });

  test("a number said as several words (said-numbers.ts) is still the one word on screen", () => {
    const { l, sent, said } = line("Shipping 0.3.2 costs $0.50 now.", "pocket");
    assert.equal(said, "Shipping 0 point 3 point 2 costs 50 cents now.");
    const tone = Buffer.alloc(RATE * 2 * 2);
    for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / RATE)), i * 2);
    l.sentence(said);
    l.audio(tone);
    l.sentenceDone();
    l.flush();
    const words = all(sent);
    assert.deepEqual(
      words.map((w) => [w.i, w.text]),
      [
        [0, "Shipping"],
        [1, "0.3.2"],
        [2, "costs"],
        [3, "$0.50"],
        [4, "now."],
      ],
    );
    for (let k = 1; k < words.length; k++) assert.ok(words[k].start! > words[k - 1].start!);
  });

  test("a sentence with no audio, or with no words: nothing thrown", () => {
    const { l, sent } = line("Hello there.", "pocket");
    l.sentence("Hello there.");
    l.sentenceDone();
    l.sentence("   ");
    l.audio(Buffer.alloc(3)); // an odd byte
    l.sentenceDone();
    l.flush();
    for (const w of all(sent)) assert.ok(Number.isFinite(w.start));
  });
});

describe("the macOS voice: the places of the words in what the phone says", () => {
  test("each written word, with where its respelling is in the text said", () => {
    const { l, said } = line("Restarted nginx on kiko.sh.", "macos");
    const s = l.saidWords();
    assert.equal(s.line, 7);
    assert.deepEqual(
      s.words.map((w) => [w.text, said.slice(w.from, w.to)]),
      [
        ["Restarted", "Restarted"],
        ["nginx", "engine-x"],
        ["on", "on"],
        ["kiko.sh.", "Keeko dot S H."], // the macOS voice's own respelling of the name
      ],
    );
  });

  test("UTF-16 offsets, as the phone's NSRange counts them: past an emoji", () => {
    const { l, said } = line("Done 🎉 now", "macos");
    const w = l.saidWords().words[2];
    assert.equal(said.slice(w.from, w.to), "now");
    assert.equal(w.from, 8, "the emoji is two UTF-16 units");
  });
});

test("audio's place in the line: samples from its start", () => {
  const l = new VoiceLine(() => {}, { id: 3 });
  assert.deepEqual(l.audio(Buffer.alloc(480)), { line: 3, at: 0 });
  assert.deepEqual(l.audio(Buffer.alloc(100)), { line: 3, at: 240 });
  assert.deepEqual(l.audio(Buffer.alloc(0)), { line: 3, at: 290 });
});

test("lines are numbered from a random start, each its own", () => {
  const a = new VoiceLine(() => {});
  const b = new VoiceLine(() => {});
  assert.ok(a.id >= 1 && b.id !== a.id);
});

// The Mac overlay's read-along (spoken-lines.ts heard()): the words on screen said by a sample of the line's sound.
test("saidBy: the written words up to the last one begun by a sample, through the respellings and a word never placed", () => {
  const { l } = line("Restarted nginx on 42 hosts.");
  assert.deepEqual(l.saidBy(0), []);
  // "42" said as "forty two": never matched, so never placed; the words around it are.
  l.timestamps(["Restarted", "engine-x", "on", "forty", "two", "hosts."], [0.1, 0.6, 1.2, 1.4, 1.7, 2.0], [0.5, 1.1, 1.35, 1.65, 1.95, 2.5]);
  assert.deepEqual(l.saidBy(0.05 * RATE), []);
  assert.deepEqual(l.saidBy(0.2 * RATE), ["Restarted"]);
  assert.deepEqual(l.saidBy(0.7 * RATE), ["Restarted", "nginx"], "the word as written, not as said");
  assert.deepEqual(l.saidBy(1.9 * RATE), ["Restarted", "nginx", "on"]);
  assert.deepEqual(l.saidBy(2.1 * RATE), ["Restarted", "nginx", "on", "42", "hosts."], "a word never placed is in once one after it is");
  assert.deepEqual(l.saidBy(99 * RATE), ["Restarted", "nginx", "on", "42", "hosts."]);
});
