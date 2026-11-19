// When each word of a sentence is said, estimated from its audio (src/core/word-timing.ts), for
// Pocket, which says nothing of its words. On made-up audio (bursts of tone for words, quiet between):
// the speech is found inside the silence Pocket puts around it, a long pause is tied to the full stop
// it follows, the words are given a little late rather than early, and odd input (no words, no
// audio, silence, NaN) gives sane numbers, never a throw. How close it gets on real Pocket audio is
// measured by scripts/perf/readalong-pocket.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { breakAfter, estimateWords, LAG_MS, levels, speechIn, syllables, tiePauses, weightOf } from "../../../src/core/word-timing.ts";

const RATE = 24000;

/** Audio of `parts`: [seconds, loud?] each; loud is a 180 Hz tone, quiet a faint hiss. */
function audio(parts: Array<[number, boolean]>): Int16Array {
  const out: number[] = [];
  let seed = 7;
  for (const [s, loud] of parts) {
    for (let i = 0; i < Math.round(s * RATE); i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out.push(loud ? Math.round(9000 * Math.sin((2 * Math.PI * 180 * out.length) / RATE)) : (seed % 5) - 2);
    }
  }
  return Int16Array.from(out);
}

const secs = (samples: number) => samples / RATE;

describe("a word's length and pauses", () => {
  test("syllables, roughly", () => {
    assert.equal(syllables("the"), 1);
    assert.equal(syllables("overlay"), 3);
    assert.equal(syllables("release"), 2, "a silent final e");
    assert.equal(syllables("S"), 1);
    assert.equal(syllables("42"), 2);
    assert.equal(syllables("—"), 0);
    assert.equal(syllables("déjà"), 2, "accents are letters");
  });

  test("a long word weighs more; a capital letter on its own is said as a syllable; punctuation weighs little", () => {
    assert.ok(weightOf("migration") > weightOf("the"));
    assert.ok(weightOf("S") > weightOf("a"));
    assert.ok(weightOf("—") > 0 && weightOf("—") < weightOf("a"));
    assert.ok(weightOf("🎉") > 0, "an emoji still takes a little");
  });

  test("where the text allows a pause", () => {
    assert.equal(breakAfter("done."), 2);
    assert.equal(breakAfter('"done?"'), 2);
    assert.equal(breakAfter("first,"), 1);
    assert.equal(breakAfter("—"), 1);
    assert.equal(breakAfter("word"), 0);
  });
});

describe("the speech in a sentence's audio", () => {
  test("found inside the silence around it, with the pauses in it", () => {
    const pcm = audio([
      [0.5, false],
      [0.4, true],
      [0.3, false],
      [0.6, true],
      [0.4, false],
    ]);
    const s = speechIn(levels(pcm, RATE))!;
    assert.ok(Math.abs(s.from - 50) <= 1 && Math.abs(s.to - 180) <= 1, `${s.from}-${s.to}`);
    assert.equal(s.gaps.length, 1);
    assert.ok(Math.abs(s.gaps[0].from - 90) <= 1 && Math.abs(s.gaps[0].to - 120) <= 1);
  });

  test("silence, or no audio: none", () => {
    assert.equal(speechIn(levels(audio([[1, false]]), RATE)), null);
    assert.equal(speechIn([]), null);
  });

  test("a pause goes to the full stop it's near, not to a word that runs on", () => {
    const words = ["Sure.", "Which", "session", "should", "I", "send", "it", "to?"];
    const tied = tiePauses(words, words.map(weightOf), [{ from: 30, to: 170 }], 0, 300);
    assert.deepEqual(
      tied.map((t) => words[t.word]),
      ["Sure."],
    );
    // A short stop mid-sentence, where there's no punctuation: left alone.
    assert.deepEqual(tiePauses(["running", "alongside", "it"], [3, 4, 1], [{ from: 50, to: 61 }], 0, 120), []);
  });
});

describe("the words' times", () => {
  test("each word in the speech, after the silence before it; never early by the lag; in order", () => {
    // "Sure." 0.4 s, a 1.4 s pause (Pocket's own after a short sentence), then four words in 1.2 s.
    const pcm = audio([
      [0.6, false],
      [0.4, true],
      [1.4, false],
      [1.2, true],
      [0.5, false],
    ]);
    const words = ["Sure.", "Which", "session", "is", "it?"];
    const est = estimateWords(words, pcm, RATE);
    assert.equal(est.length, words.length);
    const lag = LAG_MS / 1000;
    assert.ok(Math.abs(secs(est[0].start) - (0.6 + lag)) < 0.03, `Sure. at ${secs(est[0].start)}`);
    assert.ok(Math.abs(secs(est[1].start) - (2.4 + lag)) < 0.03, `Which at ${secs(est[1].start)}: after the pause`);
    for (let i = 1; i < est.length; i++) assert.ok(est[i].start >= est[i - 1].start);
    for (const w of est) assert.ok(w.end >= w.start && w.end <= pcm.length);
    // The last word is in the last stretch of speech, not the silence after it.
    assert.ok(secs(est[4].start) > 2.4 && secs(est[4].start) < 3.6);
  });

  test("without the audio used (plain): spread over all of it", () => {
    const pcm = audio([
      [0.5, false],
      [1, true],
      [0.5, false],
    ]);
    const est = estimateWords(["one", "two"], pcm, RATE, { mode: "plain", lagMs: 0 });
    assert.equal(est[0].start, 0);
    assert.ok(est[1].start > 0 && est[1].start < pcm.length);
  });

  test("odd input: no words, no audio, silence, a NaN lag, an emoji: sane numbers, no throw", () => {
    assert.deepEqual(estimateWords([], audio([[1, true]]), RATE), []);
    const none = estimateWords(["a", "b"], new Int16Array(0), RATE);
    assert.deepEqual(none, [
      { start: 0, end: 0 },
      { start: 0, end: 0 },
    ]);
    const quiet = estimateWords(["a", "b", "c"], audio([[1, false]]), RATE, { lagMs: Number.NaN });
    for (const w of quiet) assert.ok(Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end <= RATE);
    const emoji = estimateWords(
      ["Done", "🎉", "déjà", "vu."],
      audio([
        [0.2, false],
        [1, true],
      ]),
      RATE,
    );
    assert.equal(emoji.length, 4);
    for (const w of emoji) assert.ok(Number.isFinite(w.start));
  });
});
