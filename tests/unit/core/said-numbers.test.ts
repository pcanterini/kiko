// Numbers as the voices say them (src/core/said-numbers.ts, through pronunciation.ts respell):
// versions (Pocket and the macOS voice), decimals and money (Pocket) written so a dot is never read
// as a full stop, and what looks like one but isn't (IPs, times, "1,000", "e.g.", "it.Then", names
// like "gpt-4.1") or is said right already ("93%", "3.5x") left alone. The spellings were picked
// by ear (scripts/perf/pocket-said.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ENGINES, type Pronunciation, respell, respeller, respellWords } from "../../../src/core/pronunciation.ts";
import { numberSaid } from "../../../src/core/said-numbers.ts";

const none: Pronunciation[] = [];
const pocket = (text: string) => respell(text, "pocket", none);

describe("numberSaid", () => {
  test("versions: two dots or more, or a v before one", () => {
    assert.equal(numberSaid("0.3.1"), "0 point 3 point 1");
    assert.equal(numberSaid("0.4.13"), "0 point 4 point 13");
    assert.equal(numberSaid("2.1.312"), "2 point 1 point 312");
    assert.equal(numberSaid("v0.19.1"), "version 0 point 19 point 1");
    assert.equal(numberSaid("v1.2"), "version 1 point 2");
  });
  test("one dot after 'version', 'build' or 'release': a version, not a decimal", () => {
    assert.equal(numberSaid("1.10", "version"), "1 point 10");
    assert.equal(numberSaid("2.0", "build"), "2 point 0");
    assert.equal(numberSaid("1.10"), "1 point 1 0");
  });
  test("decimals: the digits after the point one by one", () => {
    assert.equal(numberSaid("1.5"), "1 point 5");
    assert.equal(numberSaid("0.03"), "0 point 0 3");
    assert.equal(numberSaid("52.5"), "52 point 5");
    assert.equal(numberSaid("3.14"), "3 point 1 4");
    assert.equal(numberSaid("1,234.5"), "1,234 point 5");
  });
  test("negative numbers: 'minus' before a decimal or money; a whole one left alone", () => {
    assert.equal(numberSaid("-1.5"), "minus 1 point 5");
    assert.equal(numberSaid("−0.25"), "minus 0 point 2 5");
    assert.equal(numberSaid("-$5"), "minus 5 dollars");
    assert.equal(numberSaid("-3"), undefined);
    assert.equal(numberSaid("-1.2.3"), undefined);
  });
  test("money: dollars, and cents", () => {
    assert.equal(numberSaid("$2"), "2 dollars");
    assert.equal(numberSaid("$1"), "1 dollar");
    assert.equal(numberSaid("$25"), "25 dollars");
    assert.equal(numberSaid("$1,000"), "1,000 dollars");
    assert.equal(numberSaid("$0.50"), "50 cents");
    assert.equal(numberSaid("$0.01"), "1 cent");
    assert.equal(numberSaid("$8.99"), "8 dollars 99");
    assert.equal(numberSaid("$24.99"), "24 dollars 99");
    assert.equal(numberSaid("$12.03"), "12 dollars and 3 cents");
    assert.equal(numberSaid("$1.01"), "1 dollar and 1 cent");
    assert.equal(numberSaid("$5.00"), "5 dollars");
    // Not money: no digits, a third decimal, a range.
    assert.equal(numberSaid("$"), undefined);
    assert.equal(numberSaid("$HOME"), undefined);
    assert.equal(numberSaid("$0.005"), undefined);
    assert.equal(numberSaid("$5-10"), undefined);
  });
  test("versions only (the macOS voice): decimals and money as written", () => {
    assert.equal(numberSaid("0.3.1", "", "versions"), "0 point 3 point 1");
    assert.equal(numberSaid("v0.19.1", "", "versions"), "version 0 point 19 point 1");
    for (const w of ["1.5", "$0.50", "$8"]) assert.equal(numberSaid(w, "", "versions"), undefined, w);
    assert.equal(numberSaid("1.0", "version", "versions"), undefined);
  });
  test("left alone: whole numbers, percentages, multiples, thousands, IPs, times, dates, names (all said right as written)", () => {
    for (const w of [
      "3",
      "93%",
      "5.5%",
      "3.5x",
      "2x",
      "1,000",
      "2,888",
      "10.0.0.1",
      "192.168.1.20",
      "127.0.0.1",
      "6:15",
      "10:30",
      "12:30:00",
      "2026-11-12",
      "V8",
      "V4.1",
      "v2",
      "K3.1",
      "gpt-4.1",
      "e.g",
      "it.Then",
      "1.",
      ".5",
      "1..2",
      "0.3.",
      "Ph.D",
    ]) {
      assert.equal(numberSaid(w), undefined, w);
    }
  });
});

describe("numbers in what Pocket says", () => {
  test("lines of the kind a summary says", () => {
    assert.equal(pocket("some people still have the older 2.4.1 build"), "some people still have the older 2 point 4 point 1 build");
    assert.equal(pocket("what's left is shipping 2.4.2, which the next step waits on."), "what's left is shipping 2 point 4 point 2, which the next step waits on.");
    assert.equal(pocket("a monthly fee of $0.75, the free period ending after 14 days or $3 of use"), "a monthly fee of 75 cents, the free period ending after 14 days or 3 dollars of use");
    assert.equal(pocket("a team budget of $40, about $6 a day"), "a team budget of 40 dollars, about 6 dollars a day");
  });
  test("a number at the end of a sentence keeps its full stop, and the next sentence still starts", () => {
    assert.equal(pocket("Production is on build 0.3.1. Next is 0.3.2?"), "Production is on build 0 point 3 point 1. Next is 0 point 3 point 2?");
    assert.equal(pocket("It costs $8.99."), "It costs 8 dollars 99.");
    assert.equal(pocket("(v0.19.1)"), "(version 0 point 19 point 1)");
    assert.equal(pocket('"1.5",'), '"1 point 5",');
  });
  test("'version 2.1' is a version across a streamed cut; after a sentence's end it's a decimal", () => {
    const r = respeller("pocket", none);
    assert.equal(r.push("ship version ") + r.push("1.10 now. ") + r.push("1.10 is ") + r.end(), "ship version 1 point 10 now. 1 point 1 0 is ");
  });
  test("left alone in a line, for every voice", () => {
    const left = ["10.0.0.1", "127.0.0.1:8787", "at 6:15 tonight", "1,000 lines", "e.g. this", "I pushed it.Then it was done.", "gpt-4.1 and sonnet-4.5", "node@20", "the V8 engine", "2026-11-12"];
    for (const t of left) for (const v of ENGINES) assert.equal(respell(t, v, none), t.includes(":8787") ? "127.0.0.1 port 8787" : t, `${v}: ${t}`);
  });
  test("the macOS voice gets versions only, Cartesia none", () => {
    assert.equal(respell("Ship 0.3.1 for $0.50, 1.5 times, v0.19.1.", "macos", none), "Ship 0 point 3 point 1 for $0.50, 1.5 times, version 0 point 19 point 1.");
    assert.equal(respell("Ship 0.3.1 for $0.50, 1.5 times, v0.19.1.", "cartesia", none), "Ship 0.3.1 for $0.50, 1.5 times, v0.19.1.");
  });
  test("an entry of yours for one wins", () => {
    assert.equal(respell("$5 a month", "pocket", [{ word: "$5", say: "five bucks" }]), "five bucks a month");
  });
  test("the read-along: each written number is one word said as several", () => {
    const { said, words } = respellWords("Shipping 0.3.2 for $0.50.", "pocket", none);
    assert.equal(said, "Shipping 0 point 3 point 2 for 50 cents.");
    assert.deepEqual(
      words.map((w) => [w.written, w.said, said.slice(w.at, w.at + w.said.length)]),
      [
        ["Shipping", "Shipping", "Shipping"],
        ["0.3.2", "0 point 3 point 2", "0 point 3 point 2"],
        ["for", "for", "for"],
        ["$0.50.", "50 cents.", "50 cents."],
      ],
    );
  });
});
