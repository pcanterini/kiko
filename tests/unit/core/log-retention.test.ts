// How long Kiko keeps its logs (src/core/log-retention.ts, Settings → Logs → Keep logs). Local logs
// hold transcripts and replies, so Settings says where they are and how long they're kept.
// Pruning deletes only run logs (<start time>.jsonl, plain files) in the logs folder, last written
// longer ago than the window; never this run's file, latest.jsonl or its target, a link, or
// anything else. Every folder here is a throwaway one under the test's own temp folder
// (tests/setup.ts): the real logs are never looked at.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keepLogsDefault, keepLogsOf, keepLogsWords, LOG_NAME, logsSize, pruneLogs, sizeWords, startLogPruning, type Pruned } from "../../../src/core/log-retention.ts";
import { choicesFor, keepLogsChoices, SETTING_ABOUT, SETTING_GROUPS } from "../../../src/core/settings-options.ts";
import { LOG_FILE } from "../../../src/core/log.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");

/** A log's name as log.ts makes it, for a run started `daysAgo` days before NOW (and a few ms, so names differ). */
const logName = (daysAgo: number, ms = 0) => `${new Date(NOW - daysAgo * DAY - ms).toISOString().replace(/[:.]/g, "-")}.jsonl`;

/** A throwaway folder, never the real logs. */
const freshDir = () => mkdtempSync(join(tmpdir(), "logs-"));

/** A file in `dir` with `bytes` of content, last written `daysAgo` days before NOW. */
function put(dir: string, name: string, daysAgo: number, bytes = 10) {
  const path = join(dir, name);
  writeFileSync(path, "x".repeat(bytes));
  const at = new Date(NOW - daysAgo * DAY);
  utimesSync(path, at, at);
  return path;
}

describe("log retention: pruning", () => {
  test("deletes run logs last written longer ago than the window, and says how many and their bytes", () => {
    const dir = freshDir();
    put(dir, logName(1), 1, 100);
    put(dir, logName(29), 29, 100);
    put(dir, logName(31), 31, 200);
    put(dir, logName(100), 100, 300);
    const pruned = pruneLogs({ dir, days: 30, now: NOW });
    assert.deepEqual(pruned, { count: 2, bytes: 500 });
    assert.deepEqual(readdirSync(dir).sort(), [logName(29), logName(1)].sort());
  });

  test("each window: 7, 30 and 90 days", () => {
    for (const [days, left] of [
      [7, 1],
      [30, 2],
      [90, 3],
    ] as const) {
      const dir = freshDir();
      for (const age of [3, 20, 60, 120]) put(dir, logName(age), age);
      assert.equal(pruneLogs({ dir, days, now: NOW }).count, 4 - left, `${days} days`);
      assert.equal(readdirSync(dir).length, left, `${days} days`);
    }
  });

  test("Forever deletes nothing", () => {
    const dir = freshDir();
    put(dir, logName(400), 400);
    put(dir, logName(5000), 5000);
    assert.deepEqual(pruneLogs({ dir, days: 0, now: NOW }), { count: 0, bytes: 0 });
    assert.equal(readdirSync(dir).length, 2);
  });

  test("by when a file was last written, not when its run started: a run still going keeps its file", () => {
    const dir = freshDir();
    // Started 60 days ago, written to yesterday.
    put(dir, logName(60), 1);
    assert.equal(pruneLogs({ dir, days: 30, now: NOW }).count, 0);
    assert.ok(existsSync(join(dir, logName(60))));
  });

  test("never this run's file, however old", () => {
    const dir = freshDir();
    const mine = logName(200);
    put(dir, mine, 200);
    put(dir, logName(201), 201);
    assert.equal(pruneLogs({ dir, days: 7, keep: [mine], now: NOW }).count, 1);
    assert.deepEqual(readdirSync(dir), [mine]);
  });

  test("never latest.jsonl, nor the file it points at", () => {
    const dir = freshDir();
    const target = logName(50);
    put(dir, target, 50);
    put(dir, logName(51), 51);
    symlinkSync(target, join(dir, "latest.jsonl"));
    assert.equal(pruneLogs({ dir, days: 30, now: NOW }).count, 1);
    assert.deepEqual(readdirSync(dir).sort(), [target, "latest.jsonl"].sort());
    assert.ok(lstatSync(join(dir, "latest.jsonl")).isSymbolicLink());
  });

  test("a latest.jsonl pointing out of the folder spares nothing in it and touches nothing outside", () => {
    const outside = freshDir();
    const dir = freshDir();
    const name = logName(40);
    const far = put(outside, name, 40);
    put(dir, name, 40);
    symlinkSync(far, join(dir, "latest.jsonl"));
    assert.equal(pruneLogs({ dir, days: 30, now: NOW }).count, 1);
    assert.ok(existsSync(far), "the file outside is left");
    assert.deepEqual(readdirSync(dir), ["latest.jsonl"]);
  });

  test("links are never followed nor deleted, even with a log's name", () => {
    const outside = freshDir();
    const far = put(outside, logName(100), 100, 50);
    const farDir = join(outside, "a-folder");
    mkdirSync(farDir);
    put(farDir, logName(100), 100);
    const dir = freshDir();
    symlinkSync(far, join(dir, logName(90)));
    symlinkSync(farDir, join(dir, logName(91)));
    // A dangling one.
    symlinkSync(join(outside, "gone.jsonl"), join(dir, logName(92)));
    assert.deepEqual(pruneLogs({ dir, days: 7, now: NOW }), { count: 0, bytes: 0 });
    assert.equal(readdirSync(dir).length, 3);
    assert.ok(existsSync(far));
    assert.equal(readdirSync(farDir).length, 1);
    assert.equal(readdirSync(outside).length, 2);
  });

  test("anything not named as a run's log is left, however old: other files, other names, folders", () => {
    const dir = freshDir();
    const foreign = ["notes.txt", "pocket-server.log", "missed.json", "2026-01-01.jsonl", `x${logName(100)}`, `${logName(100)}.bak`, logName(100).replace(".jsonl", ".json"), "latest.jsonl"];
    for (const name of foreign) put(dir, name, 100);
    // A folder with a log's name, and a log inside a folder: neither is a run log in this folder.
    mkdirSync(join(dir, logName(120)));
    const sub = join(dir, "old");
    mkdirSync(sub);
    put(sub, logName(130), 130);
    assert.deepEqual(pruneLogs({ dir, days: 7, now: NOW }), { count: 0, bytes: 0 });
    assert.equal(readdirSync(dir).length, foreign.length + 2);
    assert.equal(readdirSync(sub).length, 1);
  });

  test("the name pattern is exactly log.ts's", () => {
    assert.match(LOG_FILE, LOG_NAME);
    assert.match("2026-10-26T07-54-16-764Z.jsonl", LOG_NAME);
    assert.doesNotMatch("latest.jsonl", LOG_NAME);
    assert.doesNotMatch("../2026-10-26T07-54-16-764Z.jsonl", LOG_NAME);
  });

  test("a missing folder, or a file where the folder should be, is nothing to do", () => {
    const parent = freshDir();
    assert.deepEqual(pruneLogs({ dir: join(parent, "no-such-logs"), days: 7, now: NOW }), { count: 0, bytes: 0 });
    assert.deepEqual(logsSize(join(parent, "no-such-logs")), { files: 0, bytes: 0 });
    const file = put(parent, "logs", 100);
    assert.deepEqual(pruneLogs({ dir: file, days: 7, now: NOW }), { count: 0, bytes: 0 });
    assert.ok(existsSync(file));
    assert.equal(existsSync(join(parent, "no-such-logs")), false, "not made either");
  });

  test("the folder's size counts its run logs only", () => {
    const dir = freshDir();
    put(dir, logName(1), 1, 1000);
    put(dir, logName(2), 2, 24);
    put(dir, "notes.txt", 1, 5000);
    symlinkSync(logName(1), join(dir, "latest.jsonl"));
    assert.deepEqual(logsSize(dir), { files: 2, bytes: 1024 });
    assert.equal(sizeWords(logsSize(dir).bytes), "1 KB");
  });
});

describe("log retention: while the app runs", () => {
  test("prunes at start, logs the count and bytes only, and again when asked (a setting changed)", () => {
    const dir = freshDir();
    const mine = logName(0);
    put(dir, mine, 400);
    put(dir, logName(10), 10, 7);
    put(dir, logName(40), 40, 11);
    let days: 7 | 30 | 90 | 0 = 30;
    const said: Pruned[] = [];
    const pruner = startLogPruning({ dir, days: () => days, keep: () => [mine], logPruned: (p) => said.push(p), everyMs: 60_000 });
    try {
      assert.deepEqual(said, [{ count: 1, bytes: 11 }]);
      assert.deepEqual(Object.keys(said[0]!).sort(), ["bytes", "count"]);
      // Nothing more to prune: nothing logged.
      pruner.now();
      assert.equal(said.length, 1);
      days = 7;
      assert.deepEqual(pruner.now(), { count: 1, bytes: 7 });
      assert.deepEqual(readdirSync(dir), [mine]);
    } finally {
      pruner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a folder that's gone never throws", () => {
    const said: Pruned[] = [];
    const pruner = startLogPruning({ dir: join(freshDir(), "gone"), days: () => 7, keep: () => [], logPruned: (p) => said.push(p) });
    pruner.stop();
    assert.deepEqual(said, []);
  });
});

describe("log retention: the setting", () => {
  test("7 days, 30 days, 90 days, Forever; then the folder, in Finder", () => {
    const choices = keepLogsChoices(false, { files: 3, bytes: 5 * 1024 * 1024 }, "/tmp/kiko-logs");
    assert.deepEqual(
      choices.map((c) => c.label),
      ["7 days", "30 days", "90 days", "Forever", "Open the folder in Finder"],
    );
    assert.deepEqual(
      choices.map((c) => c.value),
      [7, 30, 90, 0, "open"],
    );
    assert.equal(choices.find((c) => c.value === 30)?.hint, "the default");
    assert.equal(choices.at(-1)?.hint, "/tmp/kiko-logs · 5.0 MB");
  });

  test("the default: 30 days for a release, forever in a development checkout", () => {
    assert.equal(keepLogsDefault(false), 30);
    assert.equal(keepLogsDefault(true), 0);
    assert.equal(keepLogsChoices(true, { files: 0, bytes: 0 }, "/x").find((c) => c.value === 0)?.hint, "the default");
  });

  test("a saved value: one of the four, else the default", () => {
    for (const v of [7, 30, 90, 0] as const) assert.equal(keepLogsOf(v, 30), v);
    for (const v of [undefined, null, 14, "30", -1, "forever"]) assert.equal(keepLogsOf(v, 30), 30);
    assert.equal(keepLogsWords(0), "Forever");
    assert.equal(keepLogsWords(90), "90 days");
  });

  test("its row is under Logs, says where they are, and the screen gets its options", async () => {
    assert.deepEqual(SETTING_GROUPS.find((g) => g.title === "Logs")?.keys, ["keepLogs"]);
    assert.match(SETTING_ABOUT.keepLogs, /deleted at start and once a day/);
    assert.match(SETTING_ABOUT.keepLogs, /read one before sharing it/);
    const set = await choicesFor("keepLogs", { tts: "say", current: 30 });
    assert.deepEqual(
      set.choices.map((c) => c.value),
      [7, 30, 90, 0, "open"],
    );
  });

  test("sizes read plainly", () => {
    assert.equal(sizeWords(0), "0 bytes");
    assert.equal(sizeWords(1), "1 byte");
    assert.equal(sizeWords(2048), "2 KB");
    assert.equal(sizeWords(21 * 1024 * 1024), "21 MB");
    assert.equal(sizeWords(3 * 1024 * 1024 * 1024), "3.0 GB");
  });
});
