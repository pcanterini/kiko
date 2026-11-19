// Kiko's Terms where you start using it (core/terms.ts): the words, said the same everywhere; the
// version setup keeps as accepted, which is TERMS.md's effective date; what's said for each record.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { APP_ROOT } from "../../../src/core/app-root.ts";
import { acceptedNow, acceptedOf, AGREE_LINE, agreeLine, changedLine, PRO_AGREE, TERMS_DATE, termsNotice } from "../../../src/core/terms.ts";

describe("the terms' words and version", () => {
  test("one sentence, the action changing: continuing, signing in, starting the trial", () => {
    assert.equal(AGREE_LINE, "By continuing, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).");
    assert.equal(agreeLine("signing in"), "By signing in, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).");
    assert.equal(PRO_AGREE, "By subscribing, you agree to the Terms, including Kiko Pro's: kiko.sh/terms");
    assert.equal(changedLine("2026-11-04"), "Kiko's Terms changed on 4 Nov 2026: kiko.sh/terms");
  });

  test("the version is TERMS.md's effective date, and TERMS.md says how they're accepted", () => {
    const md = readFileSync(join(APP_ROOT, "TERMS.md"), "utf8");
    const m = /\*Effective (\w+ \d{1,2}, \d{4})\./.exec(md);
    assert.ok(m, "TERMS.md has its effective date");
    const [month, day, year] = m[1].replace(",", "").split(" ");
    const iso = new Date(`${month} ${day}, ${year} 12:00 UTC`).toISOString().slice(0, 10);
    assert.equal(TERMS_DATE, iso, "change TERMS_DATE with the effective date, so setup says they changed");
    assert.match(md, /^## Accepting these terms$/m);
    for (const how of ["sign in", "free trial", "Kiko Pro", "pair the iPhone app"]) assert.match(md.split("## Accepting these terms")[1].split("\n## ")[0], new RegExp(how, "i"));
  });
});

describe("what's said for what was accepted", () => {
  test("never: the line; an older version: changed, once; this one: nothing", () => {
    assert.deepEqual(termsNotice(undefined), { kind: "new", line: AGREE_LINE });
    assert.deepEqual(termsNotice("yes"), { kind: "new", line: AGREE_LINE }, "not a record");
    assert.deepEqual(termsNotice({ version: "2026-01-01", at: "2026-01-01T09:00:00.000Z" }, "2026-12-01"), { kind: "changed", line: "Kiko's Terms changed on 1 Dec 2026: kiko.sh/terms" });
    assert.equal(termsNotice({ version: TERMS_DATE, at: "2026-11-04T09:00:00.000Z" }), null);
  });

  test("the record kept: this version and when", () => {
    const at = new Date("2026-11-04T15:30:00.000Z");
    assert.deepEqual(acceptedNow(at), { version: TERMS_DATE, at: "2026-11-04T15:30:00.000Z" });
    assert.deepEqual(acceptedOf(acceptedNow(at)), acceptedNow(at));
    assert.equal(acceptedOf({ version: 1 }), null);
  });
});
