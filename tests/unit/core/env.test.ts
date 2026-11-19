// The app's environment variables (src/core/env.ts): every setting is KIKO_<NAME>; the names they had
// before 2026-11-01 (an older .env's TTS=…, JEV_*) are no longer read; and the .env and logs/ are
// the repo's wherever the app runs from (src/core/app-root.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { appEnv, appEnvName, SETTING_ENV, settingEnv, settingEnvName } from "../../../src/core/env.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const touched = [
  "KIKO_HOTKEY",
  "HOTKEY",
  "KIKO_TEST_HOLD_MS",
  "HOLD_MS",
  "KIKO_POCKET_VOICE",
  "POCKET_TTS_VOICE",
  "MIC",
  "KIKO_CLASSIFIER_MIN_CONFIDENCE",
  "KIKO_JEV_MIN_CONFIDENCE",
  "JEV_MIN_CONFIDENCE",
  "KIKO_CLASSIFIER_MODEL",
  "KIKO_JEV_MODEL",
  "JEV_MODEL",
];
const before = Object.fromEntries(touched.map((name) => [name, process.env[name]]));

describe("KIKO_ names only", () => {
  afterEach(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("a setting's KIKO_ name sets it", () => {
    for (const name of touched) delete process.env[name];
    assert.equal(settingEnv("hotkey"), undefined);
    process.env.KIKO_HOTKEY = "f13";
    assert.equal(settingEnv("hotkey"), "f13");
    assert.equal(settingEnvName("hotkey"), "KIKO_HOTKEY");
  });

  test("the names from before set nothing: bare ones, the harness's old timings, Pocket's other name, JEV_*", () => {
    for (const name of touched) delete process.env[name];
    process.env.HOTKEY = "fn";
    process.env.MIC = "Studio";
    process.env.HOLD_MS = "100";
    process.env.POCKET_TTS_VOICE = "alba";
    process.env.JEV_MIN_CONFIDENCE = "0.6";
    process.env.KIKO_JEV_MIN_CONFIDENCE = "0.7";
    process.env.JEV_MODEL = "x/bare";
    process.env.KIKO_JEV_MODEL = "x/old";
    assert.equal(settingEnv("hotkey"), undefined);
    assert.equal(settingEnvName("hotkey"), undefined);
    assert.equal(settingEnv("mic"), undefined);
    assert.equal(appEnv("TEST_HOLD_MS"), undefined);
    assert.equal(appEnvName("POCKET_VOICE"), undefined);
    assert.equal(settingEnv("classifierMinConfidence"), undefined);
    assert.equal(appEnv("CLASSIFIER_MODEL"), undefined);
    process.env.KIKO_TEST_HOLD_MS = "100";
    assert.equal(appEnv("TEST_HOLD_MS"), "100");
    process.env.KIKO_CLASSIFIER_MIN_CONFIDENCE = "0.85";
    assert.equal(settingEnvName("classifierMinConfidence"), "KIKO_CLASSIFIER_MIN_CONFIDENCE");
    assert.equal(settingEnv("classifierMinConfidence"), "0.85");
  });

  test("the table names each setting once, as its KIKO_ name", () => {
    const names = Object.values(SETTING_ENV).map((s) => s.env);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.doesNotMatch(name, /^KIKO_/);
  });
});

describe(".env and logs/: the repo's, wherever it runs from", () => {
  const where = (env: Record<string, string>) => {
    const cwd = mkdtempSync(join(tmpdir(), "kiko-env-"));
    const script = "const r = await import(process.env.ROOT_URL); console.log(JSON.stringify({ env: r.ENV_FILE, logs: r.LOG_DIR }));";
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^KIKO_(ENV_FILE|LOG_DIR)$/.test(k)));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd,
      env: { ...clean, ROOT_URL: new URL("../../../src/core/app-root.ts", import.meta.url).href, ...env },
      encoding: "utf8",
    });
    return JSON.parse(out) as { env: string | null; logs: string };
  };

  test("by default", () => {
    assert.deepEqual(where({}), { env: join(ROOT, ".env"), logs: join(ROOT, "logs") });
  });

  test("KIKO_ENV_FILE names another, or none; KIKO_LOG_DIR another folder", () => {
    assert.equal(where({ KIKO_ENV_FILE: "/x/.env" }).env, "/x/.env");
    assert.equal(where({ KIKO_ENV_FILE: "" }).env, null);
    assert.equal(where({ KIKO_LOG_DIR: "/x/logs" }).logs, "/x/logs");
  });

  test("config.ts loads it; an older .env's bare names choose nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiko-env-"));
    writeFileSync(join(dir, ".env"), "KIKO_SOUNDS=false\nPTT_MODE=tap\n");
    const script = "const { config: c } = await import(process.env.CONFIG_URL); console.log(JSON.stringify({ sounds: c.sounds, ptt: c.pttMode }));";
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KIKO_)?(SOUNDS|PTT_MODE|ENV_FILE)$/.test(k)));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      env: { ...clean, CONFIG_URL: new URL("../../../src/core/config.ts", import.meta.url).href, KIKO_ENV_FILE: join(dir, ".env") },
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), { sounds: false, ptt: "hold" });
  });
});
