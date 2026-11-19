// Numbers as a voice should say them (pronunciation.ts respellToken asks for each word), written so
// it can't read a dot as a full stop. By ear (2026-11-12): Pocket read "0.3.1" as "0. 3. 1." with a
// sentence's pause, or as "0 3 1" with the dots dropped; "1.0" as "one. Oh."; "$0.50" as "zero
// dollars", the cents dropped; "$8.99" right only 5 times in 12 ("$8 a monthly 99"). The macOS voice read every version as "zero,
// three, one", but decimals and money right. So versions are said with "point" for both ("0.3.1"
// → "0 point 3 point 1"), and for Pocket also decimals ("1.5" → "1 point 5") and money ("$0.50" →
// "50 cents", "$8.99" → "8 dollars 99"). The digits stay digits: both voices read those right.
// What was tried and how each scored was measured with scripts/perf/pocket-said.ts.
//
// Only a whole word that is one of these, the punctuation around it already taken off: "0.3.1."
// keeps its full stop and still ends the sentence. Left as written, said right already or names:
// IPs ("10.0.0.1"), times ("6:15"), dates, whole numbers ("1,000", "-3"), percentages ("93%",
// "5.5%"), multiples ("3.5x"), and anything inside a longer word ("gpt-4.1", "node@20", "V4.1").

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// A whole number with or without thousands commas ("1,234").
const INT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)`;
// "0.3.1", "v0.19.1", "v1.2". Not "V8" or "V4.1" (names), nor "v2" (said right as it is).
const VERSION = /^v?\d+(?:\.\d+){2,}$/;
const V_NUMBER = /^v\d+(?:\.\d+)+$/;
const DECIMAL = new RegExp(`^([-−]?)(${INT})\\.(\\d+)$`);
const MONEY = new RegExp(`^([-−]?)\\$(${INT})(?:\\.(\\d{2}))?$`);

/** The words before a number that make it a version: "version 1.0", "build 0.3". */
const VERSION_WORDS = new Set(["version", "versions", "build", "builds", "release", "releases"]);

/** "0.3.1" → "0 point 3 point 1"; "v0.19.1" → "version 0 point 19 point 1". */
const version = (word: string) => {
  const said = word.replace(/^v/, "").split(".").join(" point ");
  return word.startsWith("v") ? `version ${said}` : said;
};

/** "52.5" → "52 point 5", "0.03" → "0 point 0 3": the digits after the point one by one. */
const decimal = (whole: string, decimals: string) => `${whole} point ${[...decimals].join(" ")}`;

const minus = (sign: string) => (sign ? "minus " : "");

/**
 * "$2" → "2 dollars", "$1" → "1 dollar", "$0.50" → "50 cents", "$8.99" → "8 dollars 99", "$12.03"
 * → "12 dollars and 3 cents" ("12 dollars 03" came back as "$12 or 3" half the time).
 */
function money(whole: string, cents: string | undefined): string {
  const dollars = `${whole} dollar${whole === "1" ? "" : "s"}`;
  if (cents === undefined || cents === "00") return dollars;
  const c = String(Number(cents));
  const centsSaid = `${c} cent${c === "1" ? "" : "s"}`;
  if (/^0+$/.test(whole.replace(/,/g, ""))) return centsSaid;
  return cents.startsWith("0") ? `${dollars} and ${centsSaid}` : `${dollars} ${cents}`;
}

/** Which numbers a voice gets written out: all of them, or only versions. */
export type NumberKinds = "all" | "versions";

/**
 * How `word` (no punctuation around it) is said, or undefined when it isn't a number to change.
 * `prev`: the word before, lowercased ("version 1.0" is a version, "1.0" alone a decimal).
 */
export function numberSaid(word: string, prev = "", kinds: NumberKinds = "all"): string | undefined {
  if (IPV4.test(word)) return undefined;
  if (VERSION.test(word) || V_NUMBER.test(word)) return version(word);
  if (kinds === "versions") return undefined;
  let m = MONEY.exec(word);
  if (m) return minus(m[1]) + money(m[2], m[3]);
  m = DECIMAL.exec(word);
  if (!m) return undefined;
  // "version 1.10": the parts as they are, as in "0.3.1".
  if (VERSION_WORDS.has(prev) && !m[1]) return `${m[2]} point ${m[3]}`;
  return minus(m[1]) + decimal(m[2], m[3]);
}
