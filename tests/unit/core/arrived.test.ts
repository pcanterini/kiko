// Whether long words the app typed into a session came in whole (src/core/arrived.ts): the prompt
// the session took in, compared with them. Made-up words only.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ARRIVED_WITHIN_MS, Arrivals, WATCHED_CHARS } from "../../../src/core/arrived.ts";

/** About `n` characters of made-up words. */
const words = (n: number, tag = "w") => {
  let s = "";
  for (let i = 0; s.length < n; i++) s += `${tag}${i} lorem ipsum dolor `;
  return s.slice(0, n).trim();
};

function clock() {
  let t = 1_000_000;
  return { now: () => t, pass: (ms: number) => (t += ms) };
}

describe("Arrivals", () => {
  test("came in whole: nothing to say, and done with", () => {
    const a = new Arrivals();
    const text = words(1158);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], text), null);
    // Done with: the same words' end later is someone else's prompt, not a cut.
    assert.equal(a.took(["s1"], text.slice(-136)), null);
  });

  test("only its end came in (the 2026-11-21 cut: the last 136 of 1158): cut short, once", () => {
    const a = new Arrivals();
    const text = words(1158);
    a.typing("s1", text);
    const got = text.slice(1022);
    assert.deepEqual(a.took(["s1"], got), { text, typed: text.length, got: got.trim().length, at: "end" });
    assert.equal(a.took(["s1"], got), null);
  });

  test("only its start came in: cut short too", () => {
    const a = new Arrivals();
    const text = words(2000);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], text.slice(0, 1022))?.at, "start");
  });

  test("compared as a prompt is: Claude Code's paste lines and a terminal's whitespace don't count", () => {
    const a = new Arrivals();
    const text = words(1200);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], `\n\n<pasted_content id="ab12">\n${text.replace(/ /g, "  ")}\n</pasted_content id="ab12">\n`), null);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], `\n\n<pasted_content id="ab13">\n${text.slice(600)}\n</pasted_content id="ab13">\n`)?.at, "end");
  });

  test("under any of the session's IDs (one it had while it started)", () => {
    const a = new Arrivals();
    const text = words(1500);
    a.typing("starting-1", text);
    assert.equal(a.took(["s1", "starting-1"], text.slice(-200))?.at, "end");
  });

  test("short words aren't watched: no terminal cuts those", () => {
    const a = new Arrivals();
    const text = words(WATCHED_CHARS - 10);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], text.slice(-40)), null);
  });

  test("another prompt, another session's, or several queued words as one: not about them", () => {
    const a = new Arrivals();
    const text = words(1100);
    a.typing("s1", text);
    assert.equal(a.took(["s1"], "something else entirely"), null);
    assert.equal(a.took(["s2"], text.slice(-100)), null);
    assert.equal(a.took(["s1"], `${text} and more`), null);
    // Still waited for: its cut, later, is said.
    assert.equal(a.took(["s1"], text.slice(-100))?.at, "end");
  });

  test("waited for as long as queued dictation, then let go", () => {
    const c = clock();
    const a = new Arrivals(c.now);
    const text = words(1100);
    a.typing("s1", text);
    c.pass(ARRIVED_WITHIN_MS + 1);
    assert.equal(a.took(["s1"], text.slice(-100)), null);
  });
});
