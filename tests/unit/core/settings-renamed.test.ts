// Settings saved under a name they had before (src/core/settings.ts renamedSettings): the Jev
// subsystem became the classifier on 2026-11-01, so a saved `jev` and `jevMinConfidence` are read as
// `classifier` and `classifierMinConfidence`, values kept, and the old names go the next time the
// settings are saved. Each case runs in its own process, on its own settings file.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renamedSettings } from "../../../src/core/settings.ts";

/** What loadSettings and config read from `saved`, and the file after rememberSettings(`patch`). */
function readBack(saved: Record<string, unknown>, patch: Record<string, unknown> = { sounds: false }) {
  const dir = mkdtempSync(join(tmpdir(), "kiko-renamed-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify(saved));
  const script =
    "const s = await import(process.env.SETTINGS_URL); const { config: c } = await import(process.env.CONFIG_URL);" +
    "const loaded = s.loadSettings(); s.rememberSettings(JSON.parse(process.env.PATCH));" +
    "console.log(JSON.stringify({ loaded, classifier: c.classifier, min: c.classifierMinConfidence }));";
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KIKO_)?(JEV|CLASSIFIER)_MIN_CONFIDENCE$/.test(k)));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    env: {
      ...clean,
      SETTINGS_URL: new URL("../../../src/core/settings.ts", import.meta.url).href,
      CONFIG_URL: new URL("../../../src/core/config.ts", import.meta.url).href,
      KIKO_SETTINGS: file,
      KIKO_ENV_FILE: "",
      OPENROUTER_API_KEY: "test-not-real",
      PATCH: JSON.stringify(patch),
    },
    encoding: "utf8",
  });
  return { ...JSON.parse(out), file: JSON.parse(readFileSync(file, "utf8")) };
}

describe("settings saved under their old names", () => {
  test("jev and jevMinConfidence are read as classifier and classifierMinConfidence", () => {
    assert.deepEqual(renamedSettings({ jev: false, jevMinConfidence: 0.85, sounds: true }), { classifier: false, classifierMinConfidence: 0.85, sounds: true });
  });

  test("a value under the new name wins over the old one", () => {
    assert.deepEqual(renamedSettings({ jev: false, classifier: true }), { classifier: true });
  });

  test("nothing to rename, nothing changed; not settings at all, none", () => {
    assert.deepEqual(renamedSettings({ sounds: false }), { sounds: false });
    assert.deepEqual(renamedSettings([] as unknown as Record<string, unknown>), {});
  });

  test("the app runs with the saved values, and the file has the new names once settings are saved", () => {
    const r = readBack({ jev: false, jevMinConfidence: 0.6, voiceCan: "everything" });
    assert.deepEqual(r.loaded, { classifier: false, classifierMinConfidence: 0.6, voiceCan: "everything" });
    assert.equal(r.classifier, false, "turned off before, still off");
    assert.equal(r.min, 0.6);
    assert.deepEqual(r.file, { classifier: false, classifierMinConfidence: 0.6, voiceCan: "everything", sounds: false });
  });

  test("on with a key when the old setting said nothing against it", () => {
    const r = readBack({ jev: true });
    assert.equal(r.classifier, true);
    assert.equal(r.min, 0.75);
  });
});
