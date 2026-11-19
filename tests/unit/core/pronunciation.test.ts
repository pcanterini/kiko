// How the voice says words (src/core/pronunciation.ts): matching (whole words, any case, the
// punctuation and endings around them), domains, emails, URLs and file names said as they're read
// out (and what looks like one but isn't: versions, decimals, IPs, "e.g.", "it.Then"), the voices each
// entry is for, your list over the built-in one (and turning one off), text that streams in, the
// word "say T-Mux as …" means, and the voice command: its phrasings (routing-rules.ts) and
// decide()'s step. The file is in the unit tests' throwaway folder (tests/setup.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import {
  addPronunciation,
  DEFAULTS,
  DOMAIN_ENDINGS,
  disableDefault,
  ENGINES,
  engineOf,
  FILE_ENDINGS,
  forgetPronunciation,
  keyOf,
  loadPronunciations,
  PRONUNCIATION_FILE,
  removePronunciation,
  respell,
  respeller,
  respoken,
  sayingOf,
  wordFrom,
  type Pronunciation,
} from "../../../src/core/pronunciation.ts";
import { pronunciationRequest } from "../../../src/core/routing-rules.ts";
import { sayingChoices } from "../../../src/core/settings-options.ts";
import type { Speech } from "../../../src/core/speech-lock.ts";
import { makeWorld } from "../../support/fixtures.ts";

const none: Pronunciation[] = [];
const pocket = (text: string, user = none) => respell(text, "pocket", user);

describe("matching", () => {
  test("whole words, any case", () => {
    assert.equal(pocket("Restart tmux and TMUX and Tmux."), "Restart tee mux and tee mux and tee mux.");
    assert.equal(pocket("tmuxed tmuxy mytmux nginx2"), "tmuxed tmuxy mytmux nginx2");
  });
  test("punctuation and brackets around a word stay as they were", () => {
    assert.equal(pocket("tmux, (nginx) “JSON” [sudo]: regex; tmux! tmux? 'YAML'"), "tee mux, (engine-x) “jay-son” [soo-doo]: rej-ex; tee mux! tee mux? 'yammel'");
    assert.equal(pocket("Use Next.js."), "Use next J S.");
    assert.equal(pocket("…tmux…"), "…tee mux…");
  });
  test("plurals and possessives", () => {
    assert.equal(pocket("nginx's config, the APIs, two PRs, the CLI’s flags"), "engine-x's config, the A-P-I's, two P R's, the C L I's flags");
    assert.equal(pocket("regexes and enums"), "rej-exes and ee-nums");
    // Two letters at least before the ending: "is" and "as" aren't "I" and "A" with an "s".
    assert.equal(pocket("It is as it was."), "It is as it was.");
  });
  test("parts of a word joined by a hyphen or a slash", () => {
    assert.equal(pocket("a tmux-based setup, CI/CD, JSON-like"), "a tee mux-based setup, C I/C D, jay-son-like");
  });
  test("paths to folders, other schemes, scoped packages and file names with endings not in the tables are left as written", () => {
    const left = ["~/git/tmux", "/usr/local/bin/tmux", "ftp://nginx.org/tmux", "ssh://tmux.dev", "@types/node", "C:\\tmux", "tmux.weird", "notes.docx"];
    for (const t of left) assert.equal(pocket(`see ${t} now`), `see ${t} now`, t);
    // A path to a file whose ending is in the tables is said as just the file's name.
    assert.equal(pocket("see src/core/tmux.ts now"), "see tee mux dot T S now");
    assert.equal(pocket("see ./tmux.conf now"), "see tee mux dot conf now");
  });
  test("words inside URLs, emails and file names are respelled as words", () => {
    assert.equal(pocket("see https://nginx.org/tmux, www.tmux.dev, me@nginx.com and tmux.conf"), "see engine-x dot org slash tee mux, tee mux dot dev, me at engine-x dot com and tee mux dot conf");
  });
  test("a file name or extension said on its own", () => {
    assert.equal(pocket("Edit CLAUDE.md and the .ts files."), "Edit Claude dot M D and the dot T S files.");
  });
  test("one pass: what a respelling says is never respelled again", () => {
    const user: Pronunciation[] = [
      { word: "foo", say: "bar" },
      { word: "bar", say: "baz" },
    ];
    assert.equal(pocket("foo bar", user), "bar baz");
  });
  test("spaces and line breaks are kept", () => {
    assert.equal(pocket("  tmux\n\tnginx  "), "  tee mux\n\tengine-x  ");
    assert.equal(pocket(""), "");
  });
  test("quick enough for every line", () => {
    const line = "In Kiko, Claude says the tmux and nginx configs in ~/git/x are fixed and the API tests pass. ";
    const text = line.repeat(500); // ~50 KB, far more than any summary
    const start = performance.now();
    respell(text, "pocket", none);
    assert.ok(performance.now() - start < 250, `${performance.now() - start}ms`);
  });
});

describe("the voices each entry is for", () => {
  test("Pocket's ones change nothing for Cartesia", () => {
    assert.equal(respell("JSON and sudo", "cartesia", none), "JSON and sudo");
    assert.equal(respell("JSON and sudo", "pocket", none), "jay-son and soo-doo");
  });
  test("one without voices is for all of them", () => {
    for (const v of ["pocket", "cartesia", "macos"] as const) assert.equal(respell("nginx", v, none), "engine-x", v);
  });
  test("Pocket and macOS, not Cartesia", () => {
    assert.equal(respell("tmux", "macos", none), "tee mux");
    assert.equal(respell("tmux", "cartesia", none), "tmux");
  });
  test("config.tts names: say is the macOS voice", () => {
    assert.equal(engineOf("say"), "macos");
    assert.equal(engineOf("pocket"), "pocket");
    assert.equal(engineOf("cartesia"), "cartesia");
  });
  test("a built-in one for a voice wins over one for all voices", () => {
    // Scoped entries are applied after the all-voices ones; check the order holds for yours too.
    const user: Pronunciation[] = [
      { word: "widget", say: "all-widget" },
      { word: "widget", say: "pocket-widget", voices: ["pocket"] },
    ];
    assert.equal(respell("widget", "pocket", user), "pocket-widget");
    assert.equal(respell("widget", "cartesia", user), "all-widget");
  });
});

describe("the built-in list", () => {
  test("about a hundred, one word each, no word twice for the same voices", () => {
    assert.ok(DEFAULTS.length >= 90 && DEFAULTS.length <= 140, String(DEFAULTS.length));
    const seen = new Set<string>();
    for (const e of DEFAULTS) {
      assert.ok(!/\s/.test(e.word) && e.say?.trim(), e.word);
      const k = `${keyOf(e.word)}|${e.voices ?? "all"}`;
      assert.ok(!seen.has(k), `twice: ${e.word}`);
      seen.add(k);
    }
  });
  test("mostly Pocket's", () => {
    const pocketOnly = DEFAULTS.filter((e) => e.voices && !e.voices.includes("cartesia")).length;
    assert.ok(pocketOnly / DEFAULTS.length > 0.8);
  });
});

describe("your list", () => {
  const file = join(process.cwd(), "pronunciation-test.json");
  beforeEach(() => rmSync(file, { force: true }));

  test("saved next to the settings file", () => {
    assert.equal(PRONUNCIATION_FILE, join(process.cwd(), "pronunciation.json"));
  });
  test("none, a missing file, a broken one: the built-in list only", () => {
    assert.deepEqual(loadPronunciations(file), []);
    writeFileSync(file, "[{ half");
    assert.deepEqual(loadPronunciations(file), []);
  });
  test("entries that can't be used are skipped; unknown voices dropped", () => {
    writeFileSync(
      file,
      JSON.stringify([
        { word: "tmux", say: "tea mux", voices: ["pocket", "alexa"] },
        { word: "two words", say: "x" },
        { word: "nosay" },
        { word: "gone", say: "x", voices: ["alexa"] },
        "nonsense",
        { word: "nginx", disabled: true },
      ]),
    );
    assert.deepEqual(loadPronunciations(file), [
      { word: "tmux", say: "tea mux", voices: ["pocket"] },
      { word: "nginx", disabled: true },
    ]);
  });
  test("yours win over the built-in one", () => {
    const user: Pronunciation[] = [{ word: "tmux", say: "tea mux", voices: ["pocket"] }];
    assert.equal(pocket("tmux", user), "tea mux");
    assert.equal(respell("tmux", "macos", user), "tee mux", "the built-in one still for the other voice");
    // Yours for all voices still beats a built-in one for a voice.
    assert.equal(pocket("tmux", [{ word: "tmux", say: "tmux please" }]), "tmux please");
  });
  test("turned off: said as written, plurals too", () => {
    const user: Pronunciation[] = [{ word: "nginx", disabled: true }];
    assert.equal(pocket("nginx and nginx's", user), "nginx and nginx's");
    assert.equal(respell("nginx", "cartesia", [{ word: "nginx", disabled: true, voices: ["pocket"] }]), "engine-x");
  });
  test("added for a voice, replacing yours for it; what it was before", () => {
    assert.deepEqual(addPronunciation("nginx", "en-jinx", "pocket", file), { before: "engine-x" });
    assert.deepEqual(addPronunciation("NGINX", "engine x", "pocket", file), { before: "en-jinx" });
    assert.deepEqual(loadPronunciations(file), [{ word: "NGINX", say: "engine x", voices: ["pocket"] }]);
    assert.equal(sayingOf("nginx", "pocket", loadPronunciations(file)), "engine x");
    assert.equal(sayingOf("nginx", "cartesia", loadPronunciations(file)), "engine-x");
  });
  test("an entry for several voices keeps the others", () => {
    writeFileSync(file, JSON.stringify([{ word: "widget", say: "wid-jet", voices: ["pocket", "macos"] }]));
    addPronunciation("widget", "widge-it", "pocket", file);
    assert.deepEqual(loadPronunciations(file), [
      { word: "widget", say: "wid-jet", voices: ["macos"] },
      { word: "widget", say: "widge-it", voices: ["pocket"] },
    ]);
  });
  test("one word only", () => {
    assert.throws(() => addPronunciation("engine x", "nginx", "pocket", file));
    assert.throws(() => addPronunciation("nginx", " ", "pocket", file));
  });
  test("forget: yours for that voice out, the built-in one turned off for it, so it's said as written", () => {
    addPronunciation("nginx", "en-jinx", "pocket", file);
    assert.deepEqual(forgetPronunciation("nginx", "pocket", file), { before: "en-jinx" });
    assert.deepEqual(loadPronunciations(file), [{ word: "nginx", disabled: true, voices: ["pocket"] }]);
    assert.equal(pocket("nginx", loadPronunciations(file)), "nginx");
    assert.equal(respell("nginx", "cartesia", loadPronunciations(file)), "engine-x", "other voices keep it");
    // Already as written: nothing changes.
    assert.deepEqual(forgetPronunciation("nginx", "pocket", file), {});
    assert.deepEqual(forgetPronunciation("hello", "pocket", file), {});
  });
  test("forget a word of yours with no built-in one: just taken out", () => {
    addPronunciation("snapkit", "snap kit", "cartesia", file);
    forgetPronunciation("snapkit", "cartesia", file);
    assert.deepEqual(loadPronunciations(file), []);
  });
  test("forget one of yours for all voices: kept for the others", () => {
    writeFileSync(file, JSON.stringify([{ word: "widget", say: "wid-jet" }]));
    forgetPronunciation("widget", "pocket", file);
    assert.deepEqual(loadPronunciations(file), [{ word: "widget", say: "wid-jet", voices: ["cartesia", "macos"] }]);
  });
  test("the settings screen: remove yours, turn a built-in one off, and back on", () => {
    const at = DEFAULTS.findIndex((e) => e.word === "JSON");
    assert.equal(disableDefault(at, file)?.word, "JSON");
    disableDefault(at, file); // twice is once
    assert.deepEqual(loadPronunciations(file), [{ word: "JSON", disabled: true, voices: ["pocket"] }]);
    assert.equal(pocket("JSON", loadPronunciations(file)), "JSON");
    assert.equal(removePronunciation(0, file)?.word, "JSON");
    assert.equal(pocket("JSON", loadPronunciations(file)), "jay-son");
    assert.equal(removePronunciation(5, file), null);
  });
  test("an edit to the file by hand applies to the next line, no restart", () => {
    writeFileSync(file, JSON.stringify([{ word: "Vite", say: "vight" }]));
    assert.equal(pocket("Vite", loadPronunciations(file)), "vight");
    writeFileSync(file, JSON.stringify([{ word: "Vite", say: "veet!" }, { word: "x" }]));
    // mtime may not move within the same millisecond on every file system: force a reread.
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal(pocket("Vite", loadPronunciations(file)), "veet!");
    assert.ok(readFileSync(file, "utf8").includes("veet!"));
  });
  test("the settings list: yours first, then the built-in ones, saying which of those yours replace", () => {
    const user: Pronunciation[] = [
      { word: "tmux", say: "tea mux", voices: ["pocket"] },
      { word: "nginx", disabled: true },
    ];
    const choices = sayingChoices(user);
    assert.deepEqual(choices.slice(0, 2), [
      { value: "yours:0", label: "tmux → tea mux", hint: "Pocket · yours" },
      { value: "yours:1", label: "nginx: as written", hint: "all voices · yours" },
    ]);
    assert.equal(choices.length, 2 + DEFAULTS.length);
    const tmux = choices.find((c) => c.label === "tmux → tee mux")!;
    assert.equal(tmux.hint, "Pocket, macOS voice · built in · yours instead");
    assert.equal(choices.find((c) => c.label === "JSON → jay-son")!.hint, "Pocket · built in");
  });
});

describe('"live": the word before decides (2026-10-29)', () => {
  test("the adjective rhymes with five", () => {
    assert.equal(pocket("The website is live."), "The website is lyve.");
    assert.equal(pocket("It went live on prod, with live reload."), "It went lyve on prod, with lyve reload.");
    assert.equal(pocket("Live reload is on."), "lyve reload is on.");
  });
  test("after a pronoun, 'to' or a helping verb it's the verb, as written", () => {
    assert.equal(pocket("Where do you live?"), "Where do you live?");
    assert.equal(pocket("We can live with that, but I'd rather not have to live with it."), "We can live with that, but I'd rather not have to live with it.");
  });
  test("a sentence's end doesn't carry over: 'to. Live' is the adjective", () => {
    assert.equal(pocket("It's what I wanted to. Live tests pass."), "It's what I wanted to. lyve tests pass.");
  });
  test("lives, lived and living are left alone", () => {
    assert.equal(pocket("The config lives in src; it lived there, living happily."), "The config lives in src; it lived there, living happily.");
  });
  test("only for Pocket", () => {
    assert.equal(respell("The site is live.", "cartesia", none), "The site is live.");
  });
  test("streamed: the word before is known across pieces", () => {
    for (const text of ["We can live with it, and it's live now.", "Where you live"]) {
      for (const size of [1, 3, 7]) {
        const r = respeller("pocket", none);
        const out = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => r.push(text.slice(i * size, (i + 1) * size))).join("") + r.end();
        assert.equal(out, respell(text, "pocket", none), `${text} in pieces of ${size}`);
      }
    }
  });
});

describe("text that streams in", () => {
  const pieces = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
  const TEXT = "In Kiko, the tmux and nginx configs (JSON) are fixed; the APIs pass.";

  test("a word cut between pieces is respelled whole, whatever the cut", () => {
    for (const size of [1, 2, 3, 5, 8, 100]) {
      const r = respeller("pocket", none);
      const out =
        pieces(TEXT, size)
          .map((p) => r.push(p))
          .join("") + r.end();
      assert.equal(out, respell(TEXT, "pocket", none), `pieces of ${size}`);
    }
  });
  test("held only until the space after it", () => {
    const r = respeller("pocket", none);
    assert.equal(r.push("Restart tm"), "Restart ");
    assert.equal(r.push("ux"), "");
    assert.equal(r.push(" now"), "tee mux ");
    assert.equal(r.end(), "now");
  });
  test("a speech gets the respelled words; nothing empty is pushed; end goes after the rest", () => {
    const got: string[] = [];
    let ended = false;
    const speech: Speech = { push: (t) => got.push(t), end: () => (ended = true), cancel: () => {}, chars: () => got.join("").length };
    const s = respoken(speech, "pocket", none);
    s.push("Use tm");
    s.push("ux");
    assert.deepEqual(got, ["Use "]);
    s.end();
    assert.deepEqual(got, ["Use ", "tee mux"]);
    assert.ok(ended);
    assert.equal(s.chars(), "Use tee mux".length, "Cartesia bills what it was sent");
  });
  test("what's pushed isn't changed for anyone else: the caller's text is the same", () => {
    const shown = "Restart tmux.";
    const speech: Speech = { push: () => {}, end: () => {}, cancel: () => {}, chars: () => 0 };
    const s = respoken(speech, "pocket", none);
    s.push(shown);
    s.end();
    assert.equal(shown, "Restart tmux.");
  });
});

describe('the word in "say X as Y"', () => {
  test("as heard, when it's one word", () => {
    assert.equal(wordFrom("nginx"), "nginx");
    assert.equal(wordFrom('"nginx".'), "nginx");
  });
  test("speech-to-text's spelling of it, matched to how it was written lately", () => {
    assert.equal(wordFrom("T-Mux", ["Done.", "Restart tmux, then check."]), "tmux");
    assert.equal(wordFrom("Clip kit", ["The clipkit tests pass."]), "clipkit");
    assert.equal(wordFrom("Next JS", ["It's on Next.js 16."]), "Next.js");
  });
  test("newest first", () => {
    assert.equal(wordFrom("tmux", ["TMUX is up", "tmux is up"]), "TMUX");
  });
  test("not from inside a path", () => {
    assert.equal(wordFrom("T-Mux", ["see ~/tmux/ok"]), "T-Mux");
  });
  test("letters said one by one make a word", () => {
    assert.equal(wordFrom("T M U X"), "tmux");
    assert.equal(wordFrom("t. m. u. x."), "tmux");
  });
  test("two words that aren't a word written lately: unknown, the app asks", () => {
    assert.equal(wordFrom("engine x", ["Restart nginx."]), null);
    assert.equal(wordFrom(""), null);
  });
});

describe("the voice command", () => {
  const ADDS: Array<[string, string, string]> = [
    ["Say nginx as engine-x.", "nginx", "engine-x"],
    ["say tmux like tee mux", "tmux", "tee mux"],
    ["Pronounce Vite as veet, please.", "Vite", "veet"],
    ['From now on, say "Vite" as "veet".', "Vite", "veet"],
    ["Can you say T M U X as tee mux?", "T M U X", "tee mux"],
    ["Okay, say kubectl like cube cuddle from now on.", "kubectl", "cube cuddle"],
    ["Say nginx as in engine x.", "nginx", "engine x"],
    ["Pronounce Lacy like lay-see.", "Lacy", "lay-see"],
  ];
  for (const [said, word, say] of ADDS) {
    test(`${JSON.stringify(said)}: add`, () => assert.deepEqual(pronunciationRequest(said), { op: "add", word, say }));
  }
  const FORGETS: Array<[string, string]> = [
    ["Forget how to say nginx.", "nginx"],
    ["forget how you pronounce tmux", "tmux"],
    ["Stop respelling JSON.", "JSON"],
    ["Forget the pronunciation of Vite", "Vite"],
  ];
  for (const [said, word] of FORGETS) {
    test(`${JSON.stringify(said)}: forget`, () => assert.deepEqual(pronunciationRequest(said), { op: "forget", word }));
  }
  const NOT = [
    "Say it like you mean it.",
    "Say that again.",
    "Say hello to Lacy.",
    "Ask Lacy to say hi as a joke.",
    "Tell clipkit to say the build failed as a warning, and fix it.",
    "Forget it.",
    "What did you say?",
  ];
  for (const said of NOT) {
    test(`${JSON.stringify(said)}: not a pronunciation`, () => assert.equal(pronunciationRequest(said), null));
  }
});

describe("decide(): only said to the app by name, no models", () => {
  const W = makeWorld([
    { name: "Kiko", folder: "kiko", given: "Kiko", title: "Voice app", status: "idle", asked: "Is there a time limit?" },
    { name: "Lacy", folder: "lacy-platform", given: "Lacy", title: "Shipping rates", status: "idle", asked: "Is anything still in progress?" },
  ]);
  async function run(text: string, opts: Partial<DecideState> = {}) {
    const calls = { classifier: 0, router: 0 };
    const deps: DecideDeps = {
      utterance: async () => {
        calls.classifier++;
        return { audience: W.sessions[1], audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95, appParts: 0.1, model: "test", costUsd: 0, ms: 1 };
      },
      approval: async () => ({ answer: "unclear", confidence: 0.2, model: "test", costUsd: 0, ms: 1 }),
      route: async () => {
        calls.router++;
        return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: W.sessions,
      notes: W.notes,
      recent: [],
      waiting: null,
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan: "replies",
      classifierMinConfidence: 0.75,
      ...opts,
    };
    return { ...(await decide(state, deps)), calls };
  }

  test('"Kiko, say nginx as engine-x": added, at any Voice can level', async () => {
    const d = await run("Kiko, say nginx as engine-x.");
    assert.equal(d.step, "pronounce");
    assert.deepEqual(d.actions, [{ type: "pronounce", op: "add", word: "nginx", say: "engine-x" }]);
    assert.deepEqual(d.calls, { classifier: 0, router: 0 });
  });
  test('"Hey Kiko, forget how to say tmux"', async () => {
    const d = await run("Hey Kiko, forget how to say tmux.");
    assert.deepEqual(d.actions, [{ type: "pronounce", op: "forget", word: "tmux" }]);
  });
  test("with a permission prompt waiting, it's still the app's", async () => {
    const waiting = { sessionId: W.sessions[1].sessionId, cwd: W.sessions[1].cwd, permission: "run the tests" };
    const d = await run("Kiko, pronounce Vite as veet.", { waiting });
    assert.equal(d.step, "pronounce");
  });
  test("without the name: words like any others", async () => {
    const d = await run("Say nginx as engine-x.", { voiceCan: "messages" });
    assert.notEqual(d.step, "pronounce");
    assert.ok(!d.actions.some((a) => a.type === "pronounce"));
  });
  test("by name but not a pronunciation: on as before", async () => {
    const d = await run("Kiko, say that again.", { voiceCan: "messages" });
    assert.notEqual(d.step, "pronounce");
  });
});

test("a file name whose ending is in the list is said as its name and the ending, and a path as just the file", () => {
  assert.equal(pocket("Updated FUTURE.md and LAUNCH.md."), "Updated future dot M D and launch dot M D.");
  assert.equal(pocket("see API.md"), "see A-P-I dot M D");
  assert.equal(pocket("edited ios/README.md and src/core/pronunciation.ts"), "edited read me dot M D and pronunciation dot T S");
  // Paths to folders stay as written; every voice says file names, with its own respellings.
  assert.equal(pocket("notes.txt, https://x.com/a.md, ~/git/pixie, /usr/bin"), "notes dot T X T, x dot com slash a dot M D, ~/git/pixie, /usr/bin");
  assert.equal(respell("FUTURE.md in ios/README.md", "cartesia", none), "future dot M D in readme dot M D");
});

describe("domains, emails, URLs and file names: said as they're read out, for every voice", () => {
  // The macOS voice's "Keeko" turned off, so one expectation fits all three voices.
  const plain: Pronunciation[] = [{ word: "Kiko", disabled: true, voices: ["macos"] }];
  const all = (text: string, user = plain) => ENGINES.map((v) => respell(text, v, user));
  const same = (text: string, said: string) => assert.deepEqual(all(text), [said, said, said], text);

  test("a domain: each part, 'dot', the ending as a word or spelled", () => {
    same("kiko.sh", "kiko dot S H");
    same("wil.co", "wil dot co");
    same("bit.ly", "bit dot L Y");
    same("bbc.co.uk", "bbc dot co dot U K");
  });
  test("each part is respelled for the voice, like any word", () => {
    assert.deepEqual(all("github.com"), ["git hub dot com", "github dot com", "github dot com"]);
    // Pocket's own ".ai" ("A I" it says as "uh, I").
    assert.deepEqual(all("claude.ai"), ["clawed dot AI", "claude dot A I", "claude dot A I"]);
    assert.deepEqual(all("vercel.app"), ["ver-sell dot app", "vercel dot app", "ver-sell dot app"]);
    assert.deepEqual(all("chat.jev.io"), ["chat dot jehv dot I O", "chat dot jev dot I O", "chat dot jev dot I O"]);
    // Acronyms written lowercase are spelled for every voice: lowercase, the voice can't tell.
    // Pocket's own "A-P-I" and ".ai" (a bare "A" it reads as the word "a").
    assert.deepEqual(all("api.openrouter.ai"), ["A-P-I dot openrouter dot AI", "A P I dot openrouter dot A I", "A P I dot openrouter dot A I"]);
    same("npmjs.com", "N P M J S dot com");
  });
  test("the app's own name and site: Kiko as written for Pocket, 'Keeko' for the macOS voice (some say 'KYE-koh')", () => {
    assert.deepEqual(all("Kiko is on kiko.sh", none), ["Kiko is on kiko dot S H", "Kiko is on kiko dot S H", "Keeko is on Keeko dot S H"]);
  });
  test("from the logs (2026-10-26 … 11-01)", () => {
    assert.equal(pocket("the page is live at kiko.dev."), "the page is lyve at kiko dot dev.");
    assert.equal(pocket("pebble.com, pebble.dev and pebble.app"), "pebble dot com, pebble dot dev and pebble dot app");
    assert.equal(pocket("Buying all three, .com, .dev and .app"), "Buying all three, dot com, dot dev and dot app");
    assert.equal(pocket("forty to fifty for .io, and"), "forty to fifty for dot I O, and");
    assert.equal(pocket("wilco.fm or wil.co"), "wilco dot F M or wil dot co");
    assert.equal(pocket("iTerm2, Warp, Terminal.app and Alacritty"), "iTerm2, Warp, Terminal dot app and Alacritty");
  });
  test("the endings table: words where they're said as words, letters where they're spelled", () => {
    assert.equal(DOMAIN_ENDINGS.com, "com");
    assert.equal(DOMAIN_ENDINGS.io, "I O");
    assert.equal(DOMAIN_ENDINGS.sh, "S H");
    for (const word of ["to", "is", "it", "in", "at", "no", "do", "be", "my", "am"]) assert.ok(!(word in DOMAIN_ENDINGS), word);
    for (const e of Object.keys(FILE_ENDINGS)) assert.ok(e.length >= 2, e);
  });
  test("an email: 'at', and the dots in the name", () => {
    same("support@kiko.sh", "support at kiko dot S H");
    same("first.last@example.com", "first dot last at example dot com");
    same("first_last+tag@corp.internal", "first underscore last plus tag at corp dot internal");
    assert.equal(pocket("Mail you@example.io."), "Mail you at example dot I O.");
  });
  test("a URL: no https:// or www., a short path kept, a long one, a query and a hash dropped", () => {
    same("https://kiko.sh", "kiko dot S H");
    same("https://www.kiko.sh/", "kiko dot S H");
    same("kiko.sh/releases", "kiko dot S H slash releases");
    same("https://kiko.sh/releases?tab=mac#latest", "kiko dot S H slash releases");
    same("developer.apple.com/account", "developer dot apple dot com slash account");
    same("https://kiko.sh/docs/install.sh", "kiko dot S H slash docs slash install dot S H");
    assert.deepEqual(all("https://github.com/example/app/pull/12"), ["git hub dot com", "github dot com", "github dot com"]);
    // An ID in the path counts as long: nobody reads one out.
    same("https://kiko.sh/d/a8f3c91e2b", "kiko dot S H");
    same("http://example.internal/a", "example dot internal slash a");
  });
  test("a local address: 'port'", () => {
    assert.deepEqual(all("localhost:3000"), ["local host port 3000", "localhost port 3000", "localhost port 3000"]);
    assert.equal(pocket("http://localhost:5173/api"), "local host port 5173 slash A-P-I");
    same("127.0.0.1:8787", "127.0.0.1 port 8787");
  });
  test("a file name: its name, 'dot', the ending as the voice says it", () => {
    same("install.sh", "install dot S H");
    same("app.ts", "app dot T S");
    assert.deepEqual(all("README.md"), ["read me dot M D", "readme dot M D", "read me dot M D"]);
    assert.deepEqual(all("package.json"), ["package dot jay-son", "package dot JSON", "package dot JSON"]);
    assert.deepEqual(all("ci.yml"), ["C I dot yammel", "C I dot YAML", "C I dot yammel"]);
    assert.deepEqual(all("vite.config.ts"), ["veet dot config dot T S", "veet dot config dot T S", "veet dot config dot T S"]);
    same("IMG_0012.JPG", "IMG 0012 dot J P G");
    same("my-notes.txt", "my-notes dot T X T");
    // A library's name with .js, like the built-in Next.js.
    assert.deepEqual(all("Vue.js"), ["view J S", "view J S", "view J S"]);
  });
  test("a path to a file: just the file's name (the folders are noise to the ear; the screen has them)", () => {
    same("src/core/name.ts", "name dot T S");
    same("app/speech.ts", "speech dot T S");
    same("~/git/kiko", "~/git/kiko");
  });
  test("punctuation, quotes and a possessive around one", () => {
    same("(kiko.sh)", "(kiko dot S H)");
    same('"support@kiko.sh",', '"support at kiko dot S H",');
    same("kiko.sh's site", "kiko dot S H's site");
  });
  test("an entry for the whole thing wins: built-in or yours", () => {
    assert.equal(pocket("CLAUDE.md and Next.js"), "Claude dot M D and next J S");
    assert.equal(pocket("kiko.sh", [{ word: "kiko.sh", say: "the site" }]), "the site");
    // Yours for an ending, or for a word in a domain.
    assert.equal(pocket("x.sh", [{ word: ".sh", say: "dot shell" }]), "x dot shell");
    assert.equal(pocket("kiko.sh", [{ word: "kiko", say: "kee-ko" }]), "kee-ko dot S H");
  });
  test("versions, decimals and money: not domains; said with 'point' (said-numbers.ts) by Pocket, versions by the macOS voice too", () => {
    // As written, as Pocket says it, as the macOS voice says it (Cartesia: as written).
    const numbers: Array<[string, string, string]> = [
      ["2.1.3", "2 point 1 point 3", "2 point 1 point 3"],
      ["v0.1.0", "version 0 point 1 point 0", "version 0 point 1 point 0"],
      ["v0.19.0", "version 0 point 19 point 0", "version 0 point 19 point 0"],
      ["Version 2.1.312 is out.", "Version 2 point 1 point 312 is out.", "Version 2 point 1 point 312 is out."],
      ["3.14", "3 point 1 4", "3.14"],
      ["$12.03 a year", "12 dollars and 3 cents a year", "$12.03 a year"],
    ];
    for (const [t, byPocket, byMac] of numbers) {
      assert.equal(pocket(t), byPocket, t);
      assert.equal(respell(t, "macos", plain), byMac, `macos: ${t}`);
      assert.equal(respell(t, "cartesia", plain), t, `cartesia: ${t}`);
    }
  });
  test("left alone: times, IPs, abbreviations, a missing space", () => {
    const left = [
      "10:30",
      "12:30:00",
      "3:2",
      "10.0.0.1",
      "192.168.1.20",
      "e.g.",
      "i.e.",
      "etc.",
      "a.m.",
      "p.m.",
      "U.S.",
      "Ph.D.",
      "Mr. Smith",
      "I pushed it.Then it was done.",
      "That's it.So we ship.",
      "node@20",
      "@types/node",
      "git@github.com:example/app.git",
      "gpt-4.1",
      "sonnet-4.5",
      "ASP.NET",
    ];
    for (const t of left) same(t, t);
  });
  test("one pass: what's already said as words stays", () => {
    same("kiko dot S H", "kiko dot S H");
    same("support at kiko dot S H", "support at kiko dot S H");
  });
  test("streamed: a domain cut between pieces is said whole", () => {
    const text = "It's live at kiko.sh/releases, mail support@kiko.sh or see README.md.";
    for (const size of [1, 2, 4, 9]) {
      const r = respeller("pocket", none);
      const out = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => r.push(text.slice(i * size, (i + 1) * size))).join("") + r.end();
      assert.equal(out, "It's lyve at kiko dot S H slash releases, mail support at kiko dot S H or see read me dot M D.", `pieces of ${size}`);
    }
  });
});

test("a bare letter A: Pocket reads it as the word 'a', so 'AI' is left as written and letters that start with A are joined (by ear, 2026-11-12)", () => {
  assert.equal(pocket("The AI answered. AI's reply, the AIs"), "The AI answered. AI's reply, the AIs");
  assert.equal(pocket("The API on AWS"), "The A-P-I on A-W-S");
  assert.equal(pocket("OpenAI and claude.ai"), "open A I and clawed dot AI");
  for (const v of ["cartesia", "macos"] as const) assert.equal(respell("The AI, the API on AWS", v, none), "The AI, the API on AWS");
});
