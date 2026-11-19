// The config and state files written whole or not at all, and a broken one set aside rather than
// read as empty and saved over (src/core/json-file.ts): the
// write itself, a write failing partway, a crash mid-write, a file that doesn't parse (the settings
// and the phones' too), one that can't be moved, and how each is told. Temp folders only.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { onSetAside, readJsonFile, resetSetAside, type SetAside, setAsideLine, setAsideSince, writeFileAtomic, writeJsonAtomic } from "../../../src/core/json-file.ts";
import { loadSettings, rememberSettings, SETTINGS_FILE } from "../../../src/core/settings.ts";
import { Pairing } from "../../../src/remote/pairing.ts";

const folder = () => mkdtempSync(join(tmpdir(), "json-file-"));
/** What's set aside from now, as told. */
function told() {
  const all: SetAside[] = [];
  onSetAside((s) => all.push(s));
  return all;
}
const asides = (dir: string) => readdirSync(dir).filter((n) => n.includes(".corrupt-"));

afterEach(() => resetSetAside());

describe("an atomic write", () => {
  test("the whole file, nothing else left in the folder; the old file's mode kept, or the one given", () => {
    const dir = folder();
    const file = join(dir, "settings.json");
    writeJsonAtomic(file, { voice: "a" });
    assert.equal(readFileSync(file, "utf8"), '{\n  "voice": "a"\n}\n');
    chmodSync(file, 0o600);
    writeJsonAtomic(file, { voice: "b" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeJsonAtomic(join(dir, "phones.json"), { phones: [] }, { mode: 0o600, compact: true });
    assert.equal(readFileSync(join(dir, "phones.json"), "utf8"), '{"phones":[]}\n');
    assert.equal(statSync(join(dir, "phones.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ["phones.json", "settings.json"]);
    // Its folder made when there's none.
    writeJsonAtomic(join(dir, "new", "dictionary.json"), {});
    assert.ok(existsSync(join(dir, "new", "dictionary.json")));
  });

  test("a write that fails partway leaves the old file as it was, and no temp file", () => {
    const dir = folder();
    const file = join(dir, "settings.json");
    const before = '{\n  "talkKey": "right-option",\n  "voice": "Kiko"\n}\n';
    writeFileSync(file, before);
    const next = JSON.stringify({ talkKey: "f5", voice: "other", terms: "2026-11-01" });
    assert.throws(
      () =>
        writeFileAtomic(file, next, {
          write: (fd, text) => {
            writeSync(fd, text.slice(0, 10)); // half of it on disk, then the disk is full
            throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
          },
        }),
      /ENOSPC/,
    );
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["settings.json"]);
  });

  test("a crash mid-write (the process gone halfway) leaves the old file as it was", () => {
    const dir = folder();
    const file = join(dir, "settings.json");
    writeFileSync(file, '{ "voice": "Kiko" }\n');
    const script = join(dir, "crash.mjs");
    const url = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "src", "core", "json-file.ts")).href;
    writeFileSync(
      script,
      `import { writeSync } from "node:fs";\nimport { writeFileAtomic } from ${JSON.stringify(url)};\n` +
        `writeFileAtomic(${JSON.stringify(file)}, '{ "voice": "other", "more": 1 }', { write: (fd, t) => { writeSync(fd, t.slice(0, 8)); process.exit(9); } });\n`,
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 9, r.stderr);
    assert.equal(readFileSync(file, "utf8"), '{ "voice": "Kiko" }\n');
    assert.deepEqual(readJsonFile(file), { voice: "Kiko" });
  });
});

describe("a file that can't be read", () => {
  test("none: undefined, nothing told", () => {
    const all = told();
    assert.equal(readJsonFile(join(folder(), "none.json")), undefined);
    assert.deepEqual(all, []);
  });

  test("broken JSON is set aside whole, not wiped; told once; the next write starts a new file beside it", () => {
    const dir = folder();
    const file = join(dir, "settings.json");
    const broken = '{\n  "talkKey": "right-option",\n  "voi';
    writeFileSync(file, broken);
    const all = told();
    assert.equal(readJsonFile(file), undefined);
    assert.ok(!existsSync(file));
    const [aside] = asides(dir);
    assert.match(aside, /^settings\.json\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    assert.equal(readFileSync(join(dir, aside), "utf8"), broken);
    assert.deepEqual(all, [{ file, aside: join(dir, aside), why: "it isn't valid JSON" }]);
    assert.equal(setAsideLine(all[0]), `settings.json couldn't be read (it isn't valid JSON), so it was moved to ${aside} and the defaults are used.`);
    writeJsonAtomic(file, { voice: "new" });
    assert.equal(readFileSync(join(dir, aside), "utf8"), broken);
    assert.deepEqual(readJsonFile(file), { voice: "new" });
    assert.equal(all.length, 1);
  });

  test("empty, or not what it should hold (an array for an object, null): set aside too", () => {
    const dir = folder();
    for (const [name, text, why] of [
      ["a.json", "", "it's empty"],
      ["b.json", "[1, 2]", "it doesn't hold what it should"],
      ["c.json", "null", "it doesn't hold what it should"],
    ]) {
      writeFileSync(join(dir, name), text);
      const all = told();
      assert.equal(readJsonFile(join(dir, name)), undefined);
      assert.equal(all[0]?.why, why);
    }
    writeFileSync(join(dir, "d.json"), "[1]");
    assert.deepEqual(readJsonFile(join(dir, "d.json"), Array.isArray), [1]);
    assert.equal(asides(dir).length, 3);
  });

  test("told when someone listens: those from before it listened as well", () => {
    const dir = folder();
    writeFileSync(join(dir, "x.json"), "{");
    readJsonFile(join(dir, "x.json"));
    const all = told();
    assert.equal(all.length, 1);
    assert.equal(all[0].file, join(dir, "x.json"));
  });

  test("a write over one never read here sets it aside first", () => {
    const dir = folder();
    const file = join(dir, "renames.json");
    writeFileSync(file, "{ trunc");
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(readJsonFile(file), { a: 1 });
    assert.equal(readFileSync(join(dir, asides(dir)[0]), "utf8"), "{ trunc");
  });

  test("one that can't be moved is left as it is and never written over; told once", () => {
    const dir = folder();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    const file = join(locked, "settings.json");
    writeFileSync(file, "{ broken");
    chmodSync(locked, 0o500); // no renaming in it
    try {
      const all = told();
      assert.equal(readJsonFile(file), undefined);
      assert.equal(readJsonFile(file), undefined);
      assert.equal(all.length, 1);
      assert.equal(all[0].aside, null);
      assert.match(setAsideLine(all[0]), /^settings\.json couldn't be read \(it isn't valid JSON, and it couldn't be moved: .*\), so it's left as it is, not saved over/);
      assert.throws(() => writeJsonAtomic(file, { voice: "x" }), /isn't written over/);
      assert.equal(readFileSync(file, "utf8"), "{ broken");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("the ones set aside lately, found by their names (another process's)", () => {
    const dir = folder();
    writeFileSync(join(dir, "settings.json.corrupt-2026-11-12T10-00-00-000Z"), "{");
    writeFileSync(join(dir, "phones.json.corrupt-2026-11-12T09-00-00-000Z"), "{");
    writeFileSync(join(dir, "settings.json"), "{}");
    const found = setAsideSince(dir, Date.parse("2026-11-12T09:30:00Z"));
    assert.deepEqual(found, [{ file: join(dir, "settings.json"), aside: join(dir, "settings.json.corrupt-2026-11-12T10-00-00-000Z"), why: "" }]);
    assert.equal(setAsideLine(found[0]), "settings.json couldn't be read, so it was moved to settings.json.corrupt-2026-11-12T10-00-00-000Z and the defaults are used.");
    assert.deepEqual(setAsideSince(join(dir, "none"), 0), []);
  });
});

describe("the settings and the phones", () => {
  test("settings.json cut short: the defaults, the file set aside, and the next remember starts a new one", () => {
    // This test process's own settings file (tests/setup.ts KIKO_SETTINGS), never ~/.config/kiko*.
    assert.ok(SETTINGS_FILE.startsWith(process.cwd()), SETTINGS_FILE);
    const dir = join(SETTINGS_FILE, "..");
    const broken = '{\n  "hotkey": "right-option",\n  "termsAccepted": { "version": "2026-1';
    writeFileSync(SETTINGS_FILE, broken);
    try {
      const all = told();
      assert.deepEqual(loadSettings(), {});
      assert.equal(all.length, 1);
      rememberSettings({ sounds: false });
      assert.deepEqual(loadSettings(), { sounds: false });
      const aside = asides(dir).find((n) => n.startsWith(`${basename(SETTINGS_FILE)}.corrupt-`));
      assert.ok(aside);
      assert.equal(readFileSync(join(dir, aside), "utf8"), broken);
      rmSync(join(dir, aside));
    } finally {
      rmSync(SETTINGS_FILE, { force: true });
    }
  });

  test("phones.json that doesn't parse: no phones, and it's kept aside rather than replaced", () => {
    const dir = folder();
    const file = join(dir, "phones.json");
    writeFileSync(file, '{"phones":[{"id":"a","tokenHash":"');
    const pairing = new Pairing(file);
    assert.deepEqual(pairing.list(), []);
    assert.equal(asides(dir).length, 1);
    assert.equal(readFileSync(join(dir, asides(dir)[0]), "utf8"), '{"phones":[{"id":"a","tokenHash":"');
  });
});
