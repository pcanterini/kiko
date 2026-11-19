// The name you call the app (src/core/name.ts spokenName, the spokenName setting).
// Kiko unless you pick another ("Kiku", "Giko", "Gico" written Kiko anywhere); a name of your
// own ("Jarvis") has no misheard spellings. Whatever it is, it works the moment it's set: the wake
// word (wake.ts), the dictionary, the speech hints, a session named like it, what the router and the rules look for,
// and the setting read at start and kept when changed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { applyDictionary } from "../../../src/core/dictionary.ts";
import { MINE } from "../../support/dictionary.ts";
import { SETTING_ENV } from "../../../src/core/env.ts";
import { cleanSpokenName, misheard, NAME, setSpokenName, SPOKEN_DEFAULT, spokenName } from "../../../src/core/name.ts";
import { aboutVoiceApp, asksTrustScratch } from "../../../src/core/routing-rules.ts";
import { addressedTo, appNamed, namedLikeApp, nameWords, sessionName } from "../../../src/core/sessions.ts";
import { speechHints } from "../../../src/core/stt-hints.ts";
import { END_SILENCE_MS, leadingName, Listener, MAX_PHRASE_MS, nameWarning, type By } from "../../../src/core/wake.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeSession, makeWorld } from "../../support/fixtures.ts";
import { recordedName } from "../../eval/recorded-name.ts";

afterEach(() => setSpokenName(undefined));

const to = (text: string) => leadingName(text);
const notAddressed = (said: string) => assert.deepEqual(to(said), { addressed: false, rest: said }, said);

/** A hands-free listener on a fake clock: what it did with `said`. */
function hear(said: string) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const ended: Array<{ text: string; by: By }> = [];
  const l = new Listener({
    replyWindow: () => false,
    holding: (by) => calls.push(`holding ${by}`),
    named: () => calls.push("named"),
    ended: (h) => (calls.push(`ended ${h.by}`), ended.push({ text: h.text, by: h.by })),
    dropped: (by) => calls.push(`dropped ${by}`),
    ignored: () => calls.push("ignored"),
    clock,
  });
  l.heard(said);
  clock.advance(MAX_PHRASE_MS + END_SILENCE_MS);
  return { calls, ended };
}

describe("the default: Kiko", () => {
  test("Kiko unless set; the product's name is its own constant", () => {
    assert.equal(SPOKEN_DEFAULT, "Kiko");
    assert.equal(spokenName(), "Kiko");
    assert.equal(NAME, "Kiko");
    assert.equal(SETTING_ENV.spokenName.env, "SPOKEN_NAME");
  });
  test("its spellings wake it: 'Kiku', 'Giko', 'Gico'", () => {
    assert.deepEqual(to("Kiko, ask Lacy if it deployed"), { addressed: true, rest: "Ask Lacy if it deployed" });
    assert.deepEqual(to("Hey Kiko, what's everyone doing?"), { addressed: true, rest: "What's everyone doing?" });
    assert.deepEqual(to("Kiku, ask Lacy if it deployed"), { addressed: true, rest: "Ask Lacy if it deployed" });
    assert.deepEqual(to("giko: stop Lacy."), { addressed: true, rest: "Stop Lacy." });
    assert.deepEqual(to("Gico, what's up?"), { addressed: true, rest: "What's up?" });
    assert.deepEqual(misheard("Kiko"), { heard: ["kiku", "keeko", "kico", "chiko", "giko", "gico"], atStart: [] });
    notAddressed("Hey Keiko, how are you?");
    assert.deepEqual(hear("Kiku, ask Lacy.").calls.slice(0, 2), ["holding name", "named"]);
  });
  test("'Kiku' is written Kiko anywhere, not only up front, whatever the name you call it; a session named like it is 'Kiko project'", () => {
    assert.equal(applyDictionary("The kiku app's settings screen is broken.", MINE).text, "The Kiko app's settings screen is broken.");
    assert.equal(applyDictionary("tell Giko and Lacy", []).text, "tell Kiko and Lacy");
    setSpokenName("Jarvis");
    assert.equal(applyDictionary("the kiku window", []).text, "the Kiko window", "the product's name's spellings too");
    setSpokenName(undefined);
    assert.equal(appNamed(), "Kiko project");
    assert.equal(sessionName(makeSession({ name: "kiko" })), "Kiko project");
  });
});

describe("a name of your own", () => {
  test("works the moment it's set, and Kiko stops", () => {
    assert.deepEqual(to("Jarvis, ask Lacy."), { addressed: false, rest: "Jarvis, ask Lacy." });
    setSpokenName("Jarvis");
    assert.deepEqual(to("Jarvis, ask Lacy."), { addressed: true, rest: "Ask Lacy." });
    assert.deepEqual(to("Hey Jarvis what's everyone doing"), { addressed: true, rest: "What's everyone doing" });
    notAddressed("Kiko, ask Lacy.");
    notAddressed("Kiku, ask Lacy.");
    assert.deepEqual(hear("Jarvis, ask Lacy.").calls.slice(0, 2), ["holding name", "named"]);
    setSpokenName("Friday");
    notAddressed("Jarvis, ask Lacy.");
    assert.deepEqual(to("Friday, ask Lacy."), { addressed: true, rest: "Ask Lacy." });
  });

  test("no misheard spellings, and nothing is matched by an empty one", () => {
    setSpokenName("Jarvis");
    assert.deepEqual(misheard("Jarvis"), { heard: [], atStart: [] });
    notAddressed("Ask Lacy if it deployed.");
    notAddressed(", ask Lacy.");
  });

  test("two words: said apart or run together", () => {
    setSpokenName("Hey Jarvis");
    assert.deepEqual(to("Hey Jarvis, ask Lacy."), { addressed: true, rest: "Ask Lacy." });
    assert.deepEqual(to("hey-jarvis: ask Lacy."), { addressed: true, rest: "Ask Lacy." });
  });

  test("a session named like it is told apart; one named Kiko is just its name", () => {
    setSpokenName("Jarvis");
    const jarvis = makeSession({ name: "jarvis" });
    const kiko = makeSession({ name: "kiko" });
    assert.equal(appNamed(), "Jarvis project");
    assert.equal(sessionName(jarvis), "Jarvis project");
    assert.ok(namedLikeApp(jarvis) && !namedLikeApp(kiko));
    assert.equal(sessionName(kiko), "kiko");
  });

  test("the session on the app's code answers to it, as to the product's name", () => {
    setSpokenName("Jarvis");
    const w = makeWorld([{ name: "claude-code-speech" }, { name: "clipkit" }]);
    const own = w.byName.get("claude-code-speech")!;
    assert.ok(nameWords(own).includes("jarvis"));
    assert.ok(nameWords(own).includes("kiko"));
    assert.deepEqual(addressedTo(w.sessions, "Tell the Jarvis session to run the tests.")?.sessions.map(sessionName), ["claude-code-speech"]);
  });

  test("speech-to-text is told to expect it first; the product's name too", () => {
    setSpokenName("Jarvis");
    const hints = speechHints([], [{ heard: "ghosty", write: "Ghostty" }]);
    assert.deepEqual(hints.slice(0, 3), ["Jarvis", "Ghostty", "Kiko"]);
  });

  test("'trust Jarvis's scratch folder', 'the Jarvis app': the app, by either name", () => {
    setSpokenName("Jarvis");
    for (const said of ["Trust Jarvis's scratch folder.", "trust Kiko's scratch area", "Trust the scratch folder."]) assert.ok(asksTrustScratch(said), said);
    assert.ok(!asksTrustScratch("trust Lacy's scratch folder"));
    assert.ok(aboutVoiceApp("The Jarvis app's settings are cut off."));
    assert.ok(aboutVoiceApp("the kiku screen"));
    assert.ok(!aboutVoiceApp("Jarvisville is a town."));
  });
});

describe("the name as typed", () => {
  test("cleaned up: spaces, punctuation, a capital when it's all lower case", () => {
    assert.equal(cleanSpokenName("  jarvis! "), "Jarvis");
    assert.equal(cleanSpokenName("hey   jarvis"), "Hey Jarvis");
    assert.equal(cleanSpokenName("McFly"), "McFly");
    assert.equal(cleanSpokenName("mister-jarvis"), "Mister-jarvis");
    assert.equal(cleanSpokenName("R2-D2"), "R2-D2");
    assert.equal(cleanSpokenName("one two three four"), "One Two Three");
    assert.equal(cleanSpokenName("?!"), "");
    assert.equal(cleanSpokenName(42), "");
  });
  test("nothing usable is the default", () => {
    assert.equal(setSpokenName("  "), "Kiko");
    assert.equal(setSpokenName(undefined), "Kiko");
    assert.equal(setSpokenName("jarvis"), "Jarvis");
  });
  test("a warning, never a refusal, for one syllable or an everyday word", () => {
    for (const name of ["Max", "Bob", "Mike", "Computer", "Hello", "Okay", "Buddy"]) assert.ok(nameWarning(name)?.startsWith("Short, common words wake it by accident"), name);
    for (const name of ["Kiko", "Jarvis", "Friday", "Hey Max", "Pebble"]) assert.equal(nameWarning(name), null, name);
  });
});

describe("the setting", () => {
  /** In its own process, on its own settings file: the name config.ts set at start, then after rememberSpokenName(`keep`). */
  function readBack(saved: Record<string, unknown>, env: Record<string, string> = {}, keep?: string) {
    const dir = mkdtempSync(join(tmpdir(), "kiko-spoken-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify(saved));
    const script =
      "const n = await import(process.env.NAME_URL); const s = await import(process.env.SETTINGS_URL); await import(process.env.CONFIG_URL);" +
      "const atStart = n.spokenName(); if (process.env.KEEP) s.rememberSpokenName(process.env.KEEP);" +
      "console.log(JSON.stringify({ atStart, now: n.spokenName() }));";
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KIKO_)?SPOKEN_NAME$/.test(k)));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      env: {
        ...clean,
        NAME_URL: new URL("../../../src/core/name.ts", import.meta.url).href,
        SETTINGS_URL: new URL("../../../src/core/settings.ts", import.meta.url).href,
        CONFIG_URL: new URL("../../../src/core/config.ts", import.meta.url).href,
        KIKO_SETTINGS: file,
        KIKO_ENV_FILE: "",
        KEEP: keep ?? "",
        ...env,
      },
      encoding: "utf8",
    });
    return { ...JSON.parse(out), file: JSON.parse(readFileSync(file, "utf8")) };
  }

  test("read at start: the saved one, else the default; KIKO_SPOKEN_NAME wins", () => {
    assert.equal(readBack({}).atStart, "Kiko");
    assert.equal(readBack({ spokenName: "Pebble" }).atStart, "Pebble");
    assert.equal(readBack({ spokenName: "Pebble" }, { KIKO_SPOKEN_NAME: "Jarvis" }).atStart, "Jarvis");
  });

  test("kept with the rest, in use at once; the default isn't written", () => {
    const set = readBack({ sounds: false }, {}, "jarvis");
    assert.equal(set.now, "Jarvis");
    assert.deepEqual(set.file, { sounds: false, spokenName: "Jarvis" });
    const back = readBack({ sounds: false, spokenName: "Jarvis" }, {}, "Kiko");
    assert.equal(back.now, "Kiko");
    assert.deepEqual(back.file, { sounds: false });
  });

  test("with KIKO_SPOKEN_NAME set, it's kept for later but this run keeps the variable's", () => {
    const r = readBack({}, { KIKO_SPOKEN_NAME: "Friday" }, "Jarvis");
    assert.equal(r.now, "Friday");
    assert.deepEqual(r.file, { spokenName: "Jarvis" });
  });
});

describe("the routing eval's words follow the name (tests/eval/recorded-name.ts)", () => {
  test("the default: as written", () => {
    assert.equal(recordedName("Kiko, ask Lacy if it deployed.", "Kiko"), "Kiko, ask Lacy if it deployed.");
  });
  test("another name: Kiko and its spellings become it, a folder named for it a folder named for the new one", () => {
    const r = (s: string) => recordedName(s, "Jarvis");
    assert.equal(r("Kiko, ask Lacy if it deployed."), "Jarvis, ask Lacy if it deployed.");
    assert.equal(r("Chiko, tell clipkit to commit the fix."), "Jarvis, tell clipkit to commit the fix.");
    assert.equal(r("Like, cool, what's the status of Kiku?"), "Like, cool, what's the status of Jarvis?");
    assert.equal(r("Tell the Kiko session to fix the bug."), "Tell the Jarvis session to fix the bug.");
    assert.equal(r("Kiko's status bar never says speaking."), "Jarvis's status bar never says speaking.");
    assert.equal(r("in the kiko folder"), "in the jarvis folder");
  });
  test("mapped words wake it under the new name as they do under Kiko", () => {
    setSpokenName("Jarvis");
    for (const said of ["Kiko, ask Lacy if it deployed.", "Kiku, yes, commit it."]) {
      assert.equal(to(recordedName(said, "Jarvis")).addressed, true, said);
    }
    for (const said of ["Tell the Kiko session to fix the bug.", "Kiko's status bar never says speaking."]) {
      assert.equal(to(recordedName(said, "Jarvis")).addressed, false, said);
    }
  });
});
