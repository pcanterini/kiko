// Where the summary eval reads its cases (tests/eval/summary-data.ts): the made-up sample in the
// repo by default, a folder passed as --data otherwise (the real cases, kept out of the repo).
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { readCases, SAMPLE_DIR, summaryData } from "../../eval/summary-data.ts";

describe("summary eval data", () => {
  test("no folder: the sample, which every step can read", () => {
    const data = summaryData();
    assert.equal(data.sample, true);
    assert.equal(data.casesFile, join(SAMPLE_DIR, "summary-cases.json"));
    const cases = readCases(data);
    assert.ok(cases.length >= 10 && cases.length <= 20, `${cases.length} cases`);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique");
    for (const c of cases) {
      assert.match(c.id, /^[0-9a-f]{12}$/);
      assert.ok(["claude", "codex", "agent"].includes(c.tag), c.tag);
      assert.ok(c.kinds?.length, `${c.id} is judged`);
      for (const m of c.mustKeep ?? []) assert.match(m, /^(failure|skipped|caveat|risk|needs_you): /, m);
    }
    assert.ok(cases.some((c) => c.topic) && cases.some((c) => c.offTopic), "some have topics for --more");
  });

  test("a folder: its files, a relative path as typed from where it runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-summary-data-"));
    const one = {
      id: "0123456789ab",
      at: "2026-01-01T00:00:00.000Z",
      name: "pixie",
      titled: false,
      nameSession: false,
      tag: "claude",
      context: [],
      asked: [],
      reply: "Done.",
      needsUser: null,
      spokenThen: "In pixie, done.",
      firstTokenMsThen: null,
    };
    writeFileSync(join(dir, "summary-cases.json"), JSON.stringify([one]));
    const data = summaryData(relative(process.cwd(), dir));
    assert.equal(data.sample, false);
    assert.equal(data.dir, dir);
    assert.equal(data.verdictsFile, join(dir, "summary-verdicts.json"));
    assert.deepEqual(readCases(data), [one]);
  });

  test("a folder without cases, or with a broken one, says so instead of running on none", () => {
    const empty = mkdtempSync(join(tmpdir(), "kiko-summary-data-"));
    assert.throws(() => readCases(summaryData(empty)), /No summary-cases\.json in .*--data/);
    const broken = join(empty, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "summary-cases.json"), JSON.stringify([{ id: "x", name: "pixie", tag: "claude", context: [], asked: [] }]));
    assert.throws(() => readCases(summaryData(broken)), /case x lacks reply, spokenThen/);
    writeFileSync(join(broken, "summary-cases.json"), "{}");
    assert.throws(() => readCases(summaryData(broken)), /not a list/);
  });
});
