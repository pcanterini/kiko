// The dictionary (src/core/dictionary.ts): matching (whole words, any case, longest first, one pass),
// the built-in words (the app's names, common coding tools: nobody's own) and yours over them, your
// file (none for a new install, read when used, edited in place), the "dictionary" log event, the live words
// while you talk (fixLive, and hands-free's caption: fixed, never logged, compiled once), the speech
// hints built from it (src/core/stt-hints.ts), and the voice command: the router's tools (fetch
// stubbed) and decide()'s step and guards.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { config } from "../../../src/core/config.ts";
import { decide, spelledOut, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { addEntry, applyDictionary, builtIn, builtInEntries, DICTIONARY_FILE, fixHeard, fixLive, loadDictionary, removeEntry, TOOLS, type DictEntry } from "../../../src/core/dictionary.ts";
import { DOMAIN_HEARD, misheard, NAME } from "../../../src/core/name.ts";
import { MINE } from "../../support/dictionary.ts";
import { HandsFree } from "../../../src/core/hands-free.ts";
import { ui } from "../../../src/core/ui-store.ts";
import { platform } from "../../../src/platform/index.ts";
import type { LocalTranscriber, Mic } from "../../../src/platform/types.ts";
import { Router, type Action } from "../../../src/core/router.ts";
import { DICTIONARY_REQUEST, voiceAllows } from "../../../src/core/routing-rules.ts";
import { MAX_HINTS, speechHints } from "../../../src/core/stt-hints.ts";
import { addressedTo } from "../../../src/core/sessions.ts";
import { CAST, makeWorld, type VoiceCan } from "../../support/fixtures.ts";

const fix = (text: string, entries: DictEntry[] = MINE) => applyDictionary(text, entries).text;
const d = (pairs: Record<string, string>): DictEntry[] => Object.entries(pairs).map(([heard, write]) => ({ heard, write }));

describe("matching", () => {
  test("whole words only: never inside another word", () => {
    const g = d({ ghosty: "Ghostty", kit: "KIT" });
    assert.equal(fix("restart ghosty please", g), "restart Ghostty please");
    assert.equal(fix("unghosty ghostys ghosty2 kitten toolkit", g), "unghosty ghostys ghosty2 kitten toolkit");
    assert.equal(fix("ghosty's tab, (ghosty) and ghosty.", g), "Ghostty's tab, (Ghostty) and Ghostty.");
  });
  test("any case in, the spelling you gave out", () => {
    assert.equal(fix("Tell Clip Kit to fix it"), "Tell clipkit to fix it");
    assert.equal(fix("CLIP KID is done"), "clipkit is done");
    assert.equal(fix("ask Cloud Code"), "ask Claude Code");
  });
  test("a phrase said with a hyphen or extra spaces is the same phrase", () => {
    assert.equal(fix("the clip-kit session"), "the clipkit session");
    assert.equal(fix("the clip   kit session"), "the clipkit session");
  });
  test("longest first: the longer phrase wins where both start", () => {
    // A real mishearing: "Claude Code" heard as "Claude code code".
    assert.equal(fix("The Claude code code speech one, please."), "The Claude Code speech one, please.");
    assert.equal(fix("rename the code code speech instance"), "rename the Claude Code speech instance");
    const both = d({ cloud: "CLOUD", "cloud code": "Claude Code" });
    assert.equal(fix("cloud code on the cloud", both), "Claude Code on the CLOUD");
  });
  test("one pass: what an entry writes isn't fixed again by another", () => {
    assert.equal(fix("a then b", d({ a: "b", b: "c" })), "b then c");
  });
  test("what was replaced, as it was said", () => {
    assert.deepEqual(applyDictionary("Clip Kit and ghosty", MINE).replaced, [
      { heard: "Clip Kit", write: "clipkit" },
      { heard: "ghosty", write: "Ghostty" },
    ]);
    // Already right: nothing to note.
    assert.deepEqual(applyDictionary("Ghostty", d({ ghostty: "Ghostty" })).replaced, []);
  });
  test("an empty dictionary or text changes nothing", () => {
    assert.deepEqual(applyDictionary("clip kit", []), { text: "clip kit", replaced: [] });
    assert.deepEqual(applyDictionary("", MINE), { text: "", replaced: [] });
  });
  test("regex characters in an entry are literal", () => {
    assert.equal(fix("use node.js or nodeXjs", d({ "node.js": "Node.js" })), "use Node.js or nodeXjs");
  });
});

describe("built in: only phrases that can't mean anything else, nobody's own", () => {
  test("in force with no dictionary of yours (a new install's)", () => {
    assert.equal(fix("ask cloud code to check the T-Mux session", []), "ask Claude Code to check the tmux session");
    assert.equal(fix("restart ghostie, then open code", []), "restart Ghostty, then OpenCode");
    assert.equal(fix("the Kodak CLI and T three code", []), "the Codex CLI and T3 Code");
    assert.equal(fix("is it in cloud dot md or the J-Son file?", []), "is it in CLAUDE.md or the JSON file?");
    assert.equal(fix("using deep gram on mac OS and the i phone", []), "using Deepgram on macOS and the iPhone");
    assert.equal(fix("next js with type script, from git hub through p n p m", []), "Next.js with TypeScript, from GitHub through pnpm");
  });
  test("the user's mishearings, theirs and the built-in ones together", () => {
    assert.equal(fix("Uh, hold off on that uh, click kit change until Monday."), "Uh, hold off on that uh, clipkit change until Monday.");
    assert.equal(fix("Did the login fix go out on laced platform?"), "Did the login fix go out on Lacy platform?");
    assert.equal(fix("I think Gev should go first"), "I think Jev should go first");
    assert.equal(fix("not just ghosty?"), "not just Ghostty?");
    assert.equal(fix("Ask, uh, clot code speech"), "Ask, uh, Claude Code speech");
  });
  test("common words alone stay: cloud, lazy, code, speech, jab, open, next", () => {
    for (const said of [
      "Is that in the cloud?",
      "That looks lazy.",
      "Check the code.",
      "Let's skip the jab, uh, for now",
      "No, that's fine. It's just a cloud backup.",
      "Open the code and type the script.",
      "Next, JS files only.",
    ]) {
      assert.equal(fix(said), said);
    }
  });
  test("'Cloud Speech' stays: a session was once really called that, and it's a name you may search for", () => {
    assert.equal(fix("is there still a session called Cloud Speech"), "is there still a session called Cloud Speech");
  });
  test("no entry writes 'Claude' alone, and none listens for one common word", () => {
    const all = builtInEntries();
    assert.ok(!all.some((e) => e.write === "Claude"));
    // One word only when it can't mean anything else: the name's misspellings (Kiko's: "kiku"), the domain
    // as speech-to-text writes it ("kiko.sa"), the flavour said as one ("devkiko") and a few tools'.
    for (const e of all.filter((e) => !e.heard.includes(" ")))
      assert.ok(misheard(NAME).heard.includes(e.heard) || DOMAIN_HEARD.includes(e.heard) || /^dev\p{L}+$/u.test(e.heard) || ["ghosty", "ghostie", "kodex"].includes(e.heard), e.heard);
  });
  test("nothing of one person's: no project of theirs, nor the app's internal names", () => {
    const words = builtInEntries().flatMap((e) => [e.heard, e.write].map((w) => w.toLowerCase()));
    for (const own of ["clipkit", "clip kit", "lacy", "lazy", "jev", "gev", "pixie", "claude code speech"]) assert.ok(!words.some((w) => w.includes(own)), own);
  });
  test("each phrase once", () => {
    const keys = builtInEntries().map((e) => e.heard.toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
  });
  test("yours win over a built-in one for the same words (any case or spacing): one writing the words as heard keeps them", () => {
    assert.equal(fix("open code the file", d({ "open code": "open code" })), "open code the file");
    assert.equal(fix("the T-Mux pane", d({ "T  mux": "TMUX" })), "the TMUX pane");
    assert.equal(fix("ask cloud code", d({ ghosty: "Ghosty" })), "ask Claude Code", "the other built-in ones still apply");
    assert.deepEqual(builtIn("Open  Code"), { heard: "open code", write: "OpenCode" });
    assert.equal(builtIn("clip kit"), undefined);
    assert.ok(TOOLS.every((e) => builtIn(e.heard)));
  });
});

describe("the file", () => {
  const file = join(process.cwd(), "dict-test.json");
  test("lives next to the settings file", () => {
    assert.equal(DICTIONARY_FILE, join(process.cwd(), "dictionary.json"));
  });
  test("only yours: none until you add a word, and the built-in ones never written to it", () => {
    const fresh = join(process.cwd(), "dict-new.json");
    assert.deepEqual(loadDictionary(fresh), []);
    addEntry("snap deck", "SnapDeck", fresh);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { "snap deck": "SnapDeck" });
  });
  test("read when used: an edit by hand applies without a restart", () => {
    writeFileSync(file, JSON.stringify({ ghosty: "Ghostty" }));
    utimesSync(file, new Date(), new Date(Date.now() - 60_000));
    assert.deepEqual(loadDictionary(file), [{ heard: "ghosty", write: "Ghostty" }]);
    writeFileSync(file, JSON.stringify({ ghosty: "Ghostty", "clip kit": "clipkit" }));
    utimesSync(file, new Date(), new Date());
    assert.equal(loadDictionary(file).length, 2);
  });
  test("missing or broken: no fixes, no crash; unusable entries skipped", () => {
    assert.deepEqual(loadDictionary(join(process.cwd(), "nope.json")), []);
    writeFileSync(file, "{ not json");
    utimesSync(file, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(loadDictionary(file), []);
    writeFileSync(file, JSON.stringify({ "": "x", "...": "y", ok: "", n: 3, fine: "Fine" }));
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(loadDictionary(file), [{ heard: "fine", write: "Fine" }]);
  });
  test("add: new at the end; the same words (any case or spacing) change what it writes", () => {
    writeFileSync(file, JSON.stringify({ ghosty: "Ghosty" }));
    utimesSync(file, new Date(), new Date(Date.now() + 3000));
    assert.deepEqual(addEntry("clip kit", "clipkit", file), { before: undefined });
    assert.deepEqual(addEntry("Ghosty ", "Ghostty", file), { before: "Ghosty" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { Ghosty: "Ghostty", "clip kit": "clipkit" });
    assert.throws(() => addEntry("  ", "x", file));
  });
  test("remove: by what's heard, else by what it writes", () => {
    writeFileSync(file, JSON.stringify({ ghosty: "Ghostty", ghostie: "Ghostty", "clip kit": "clipkit" }));
    utimesSync(file, new Date(), new Date(Date.now() + 4000));
    assert.deepEqual(removeEntry("Clip-Kit", file), [{ heard: "clip kit", write: "clipkit" }]);
    assert.deepEqual(
      removeEntry("Ghostty", file).map((e) => e.heard),
      ["ghosty", "ghostie"],
    );
    assert.deepEqual(removeEntry("nothing", file), []);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
  });
});

describe("after speech-to-text (fixHeard) and the log", () => {
  const events = (name: string) => {
    const dir = "logs";
    const all = readdirSync(dir)
      .filter((f) => /^\d.*\.jsonl$/.test(f))
      .sort();
    if (!all.length) return []; // nothing logged yet
    return readFileSync(join(dir, all.at(-1)!), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === name);
  };
  test("fixed, with the words as heard kept next to them in the log", () => {
    const n = events("dictionary").length;
    const out = fixHeard("Tell clip kid to restart ghosty.", MINE);
    assert.equal(out.text, "Tell clipkit to restart Ghostty.");
    const e = events("dictionary").at(-1);
    assert.equal(events("dictionary").length, n + 1);
    assert.equal(e.heard, "Tell clip kid to restart ghosty.");
    assert.equal(e.text, "Tell clipkit to restart Ghostty.");
    assert.deepEqual(e.replaced, [
      { heard: "clip kid", write: "clipkit" },
      { heard: "ghosty", write: "Ghostty" },
    ]);
  });
  test("nothing to fix: nothing logged", () => {
    const n = events("dictionary").length;
    assert.equal(fixHeard("Run the tests.", MINE).text, "Run the tests.");
    assert.equal(events("dictionary").length, n);
  });
  test("a dictionary command is left as said, so the word being added survives", () => {
    const said = "Add to dictionary: ghosty means Ghostty.";
    assert.deepEqual(fixHeard(said, MINE), { text: said, replaced: [] });
  });
  test("routing: 'tell clip kit to …' names the clipkit session once fixed", () => {
    const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy]);
    const said = "Tell clip kit to cut a new version.";
    assert.equal(addressedTo(world.sessions, said), null, "as heard, no session is named");
    const named = addressedTo(world.sessions, fixHeard(said, MINE).text);
    assert.equal(named?.sure, true);
    assert.deepEqual(
      named?.sessions.map((s) => s.sessionId),
      [world.byName.get("clipkit")!.sessionId],
    );
    assert.equal(named?.rest, "Cut a new version.");
  });
  // The live words: what the caption, the bar, the TUI and the phone show while you talk (ui.heard,
  // as talk.ts listen() gives it a press's partials).
  test("live words: fixed as the final ones will be, the app's names too, in the store's interim", () => {
    ui.heard(fixLive("ask kiku to run the tests", []));
    assert.equal(ui.state.interim, "ask Kiko to run the tests");
    ui.heard(fixLive("tell clip kid to restart ghosty", MINE));
    assert.equal(ui.state.interim, "tell clipkit to restart Ghostty");
    ui.heard("");
  });
  test("live words: never logged, however many partials come", () => {
    const n = events("dictionary").length;
    for (const partial of ["ask", "ask kiku", "ask kiku to", "ask kiku to run the tests"]) fixLive(partial, MINE);
    assert.equal(events("dictionary").length, n);
  });
  test("live words: a dictionary command is left as said, as its final words will be", () => {
    const said = "Add to dictionary: ghosty means Ghostty";
    assert.equal(fixLive(said, MINE), said);
    assert.equal(fixLive(said, MINE), fixHeard(said, MINE).text);
  });
});

describe("partials several times a second: compiled once", () => {
  // Counts the patterns built (dictionary.ts patternFor's one `new RegExp`); literals don't count.
  function counting(run: () => void) {
    const Real = globalThis.RegExp;
    let built = 0;
    globalThis.RegExp = class extends Real {
      constructor(...args: ConstructorParameters<RegExpConstructor>) {
        super(...args);
        built++;
      }
    } as RegExpConstructor;
    try {
      run();
    } finally {
      globalThis.RegExp = Real;
    }
    return built;
  }
  test("the same entries: one pattern for every partial", () => {
    const entries = d({ ghosty: "Ghostty", "clip kit": "clipkit" });
    applyDictionary("warm up", entries);
    assert.equal(
      counting(() => {
        for (let i = 0; i < 50; i++) fixLive(`tell clip kit to restart ghosty ${i}`, entries);
      }),
      0,
    );
  });
  test("no dictionary file: still one pattern, not one per partial", () => {
    const missing = join(process.cwd(), "no-dictionary.json");
    assert.equal(loadDictionary(missing), loadDictionary(missing), "the same empty list each time");
    fixLive("warm up", loadDictionary(missing));
    assert.equal(
      counting(() => {
        for (let i = 0; i < 50; i++) fixLive(`ask kiku to run test ${i}`, loadDictionary(missing));
      }),
      0,
    );
  });
});

describe("hands-free's caption", () => {
  // Fakes only: no speech helper, no mic. Its transcriber's partials go straight to onInterim.
  test("the live words after the name, fixed, in the store's interim", async () => {
    const stt = {
      onInterim: () => {},
      onRestarted: () => {},
      connect: async () => {},
      begin: () => {},
      send: () => {},
      finish: async () => "",
      setHints: () => {},
      hinted: () => false,
      audioSeconds: () => 0,
      close: () => {},
    } as LocalTranscriber;
    const mic = { open: () => {}, close: () => {}, stop: () => {}, setDevice: () => {} } as unknown as Mic;
    const real = platform.speech;
    platform.speech = { create: () => stt };
    const heard: string[] = [];
    const hf = new HandsFree({
      mic,
      fix: (text) => applyDictionary(text, MINE).text,
      talking: () => false,
      replyWindow: () => false,
      holding: () => {},
      named: () => {},
      request: () => {},
      dropped: () => {},
      interim: (text) => {
        heard.push(text);
        ui.heard(text);
      },
      level: () => {},
      log: () => {},
    });
    try {
      assert.equal(await hf.start(), null);
      stt.onInterim("kiku, ask clip kit to run the tests");
      assert.equal(ui.state.interim, "Kiko, ask clipkit to run the tests");
      assert.ok(heard.length > 0 && heard.every((t) => !/kiku|clip kit/i.test(t)), "never shown as heard");
    } finally {
      hf.stop();
      platform.speech = real;
      ui.heard("");
    }
  });
});

describe("speech hints", () => {
  const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy, CAST.twoPlusTwo, CAST.pixie]);
  test("the name you call the app first, then your dictionary's targets (your spelling), the app's name and the agents, then session names and folders as words", () => {
    const hints = speechHints(world.sessions, d({ ghosty: "Ghostty", "clip kit": "clipkit", "lazy platform": "Lacy platform" }));
    assert.deepEqual(hints.slice(0, 8), ["Kiko", "Ghostty", "clipkit", "Lacy platform", "Claude Code", "Codex", "OpenCode", "T3 Code"]);
    assert.ok(hints.includes("claude code speech"));
    assert.ok(hints.includes("pixie"));
    // Each once, whatever its case or hyphens: "lacy-platform" is "Lacy platform" already.
    assert.equal(hints.filter((h) => h.toLowerCase() === "lacy platform").length, 1);
    assert.equal(hints.filter((h) => h.toLowerCase() === "clipkit").length, 1);
  });
  test("never 'Claude' alone (it would pull 'cloud' towards it), no IDs or long titles", () => {
    const hints = speechHints(world.sessions, MINE);
    assert.ok(!hints.some((h) => h.toLowerCase() === "claude"));
    assert.ok(!hints.some((h) => /\d{4,}/.test(h) || h.split(" ").length > 4));
  });
  test("with no dictionary of yours: the name and the agents only, none of the built-in fixes nor anyone's own words", () => {
    assert.deepEqual(speechHints([], []), ["Kiko", "Claude Code", "Codex", "OpenCode", "T3 Code"]);
  });
  test("capped", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ heard: `w${i}x`, write: `Word${"abcdefghij"[i % 10]}${"klmnopqrst"[Math.floor(i / 10)]}` }));
    assert.equal(speechHints(world.sessions, many).length, MAX_HINTS);
  });
});

describe("the voice command: DICTIONARY_REQUEST", () => {
  const each = (phrases: string[], want: boolean) => {
    for (const p of phrases) test(`${want ? "matches" : "doesn't match"} ${JSON.stringify(p)}`, () => assert.equal(DICTIONARY_REQUEST.test(p), want));
  };
  each(
    [
      "Add to dictionary: ghosty means Ghostty.",
      "add to the dictionary, ghosty should be Ghostty",
      "Uh, can you add clip kit to my dictionary as clipkit?",
      "Remove ghosty from the dictionary.",
      "Take lazy out of the dictionary",
      "Dictionary: gev means Jev",
      "Add a dictionary entry: jab is Jev",
      "Please put Lacy in the dictionary, spelled L-A-C-Y",
    ],
    true,
  );
  each(
    [
      "Tell clipkit to add a dictionary to the settings.",
      "Add a dictionary feature to the app.",
      "The dictionary feature has a bug.",
      "Can we look at how the dictionary works in claude code speech?",
      "In the clipkit session, add tests for the dictionary.",
      "What's in my dictionary?",
    ],
    false,
  );
  test("at 'everything' only, like the other changes", () => {
    assert.equal(voiceAllows("everything", "dictionary"), true);
    assert.equal(voiceAllows("messages", "dictionary"), false);
    assert.equal(voiceAllows("replies", "dictionary"), false);
  });
});

describe("the router's dictionary tools", () => {
  type Captured = { system: string; prompt: string; tools: string[] };
  let captured: Captured[] = [];
  let reply: Array<{ name: string; arguments: object }> = [];
  const realFetch = globalThis.fetch;
  before(() => {
    config.llm = "test/no-network";
    process.env.OPENROUTER_API_KEY = "unit-test-no-network";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      captured.push({ system: body.messages[0].content, prompt: body.messages[1].content, tools: body.tools.map((t: any) => t.function.name) });
      const completion = {
        choices: [{ message: { content: "", tool_calls: reply.map((r) => ({ function: { name: r.name, arguments: JSON.stringify(r.arguments) } })) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, cost: 0.0001 },
      };
      return new Response(JSON.stringify(completion), { status: 200 });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
    config.llm = "haiku";
  });
  const world = makeWorld([CAST.voice, CAST.clipkit]);
  async function route(level: VoiceCan, text: string, calls: Array<{ name: string; arguments: object }> = [], recent: string[] = []) {
    captured = [];
    reply = calls;
    const result = await new Router().route(
      { sessions: world.sessions, notes: world.notes, waitingId: null, justSpoke: null, lastId: null, recent, text, voiceCan: level, dictionary: d({ ghosty: "Ghostty" }) },
      () => {},
    );
    return { result: result!, sent: captured[0] };
  }
  const TOOLS = ["add_to_dictionary", "remove_from_dictionary"];
  test("offered at 'everything' when the words are about the dictionary, with it in the prompt", async () => {
    const { sent } = await route("everything", "Add to dictionary: clip kit means clipkit");
    for (const t of TOOLS) assert.ok(sent.tools.includes(t), t);
    assert.match(sent.prompt, /<dictionary>\nghosty → Ghostty\n<\/dictionary>/);
    assert.match(sent.system, /add_to_dictionary/);
  });
  test("not offered, and the prompt unchanged, for words that aren't about it", async () => {
    const { sent } = await route("everything", "Tell clipkit to run the tests");
    for (const t of TOOLS) assert.ok(!sent.tools.includes(t), t);
    assert.doesNotMatch(sent.prompt, /<dictionary>/);
    assert.doesNotMatch(sent.system, /dictionary/i);
  });
  test("offered for the answer to 'how is it spelled?' right after", async () => {
    const { sent } = await route("everything", "G-H-O-S-T-T-Y", [], ["you → app: Add to dictionary: ghosty means ghosty.", "app said: How is it spelled? Say the letters."]);
    assert.ok(sent.tools.includes("add_to_dictionary"));
  });
  test("below 'everything': offered all the same (the app refuses, with the setting's path and the offer); the instructions never say it's off", async () => {
    const { sent } = await route("messages", "Add to dictionary: ghosty means Ghostty");
    for (const t of TOOLS) assert.ok(sent.tools.includes(t), t);
    assert.doesNotMatch(sent.system, /is off in settings|turned off (for the voice )?in the app.s settings/i);
    assert.match(sent.system, /Never say yourself that something is off/);
  });
  test("tool calls become actions", async () => {
    const { result } = await route("everything", "add to dictionary: ghosty means Ghostty", [
      { name: "add_to_dictionary", arguments: { heard: " ghosty ", write: "Ghostty" } },
      { name: "remove_from_dictionary", arguments: { heard: "clip kit" } },
    ]);
    assert.deepEqual(result.actions, [
      { name: "add_to_dictionary", heard: "ghosty", write: "Ghostty" },
      { name: "remove_from_dictionary", heard: "clip kit" },
    ]);
  });
});

describe("decide(): the dictionary step and guards", () => {
  const world = makeWorld([CAST.voice, CAST.clipkit]);
  const decideWith = (voiceCan: VoiceCan, actions: Action[], text = "Add to dictionary: ghosty means Ghostty.") => {
    let routed = 0;
    let classifier = 0;
    const deps: DecideDeps = {
      utterance: async () => {
        classifier++;
        throw new Error("the classifier isn't asked");
      },
      approval: null,
      route: async () => {
        routed++;
        return { text: "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: world.sessions,
      notes: world.notes,
      recent: [],
      waiting: { sessionId: world.byName.get("clipkit")!.sessionId, cwd: world.byName.get("clipkit")!.cwd },
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan,
      classifierMinConfidence: 0.75,
    };
    return decide(state, deps).then((out) => ({ ...out, routed, classifier }));
  };
  const ADD: Action = { name: "add_to_dictionary", heard: "Ghosty", write: "Ghostty" };
  test("straight to the router, not the classifier, even with a session waiting for a reply", async () => {
    const out = await decideWith("everything", [ADD]);
    assert.equal(out.step, "dictionary");
    assert.equal(out.classifier, 0);
    assert.equal(out.routed, 1);
    assert.deepEqual(out.actions, [{ type: "dictionary", op: "add", heard: "ghosty", write: "Ghostty" }]);
  });
  test("remove", async () => {
    const out = await decideWith("everything", [{ name: "remove_from_dictionary", heard: "ghosty" }], "Remove ghosty from the dictionary.");
    assert.deepEqual(out.actions, [{ type: "dictionary", op: "remove", heard: "ghosty" }]);
  });
  test("below 'everything' (changed since the router was asked): refused", async () => {
    // Kept: a yes to "turn it on" adds it then.
    assert.deepEqual((await decideWith("messages", [ADD])).actions, [{ type: "refused", what: "dictionary", then: { type: "dictionary", op: "add", heard: "ghosty", write: "Ghostty" } }]);
  });
  test("the new word heard the old way ('ghosty means ghosty'): asks for the spelling", async () => {
    const out = await decideWith("everything", [{ name: "add_to_dictionary", heard: "ghosty", write: "Ghosty" }]);
    assert.deepEqual(out.actions, [{ type: "say", text: "How is it spelled? Say the letters.", why: "dictionary_same_word" }]);
  });
  test("words joined ('clip kit' → 'clipkit') are a change, not the same word", async () => {
    const out = await decideWith("everything", [{ name: "add_to_dictionary", heard: "clip kit", write: "clipkit" }]);
    assert.deepEqual(out.actions, [{ type: "dictionary", op: "add", heard: "clip kit", write: "clipkit" }]);
  });
  test("a spelled-out word is written as a word", async () => {
    const out = await decideWith("everything", [{ name: "add_to_dictionary", heard: "lazy", write: "L-A-C-Y" }]);
    assert.deepEqual(out.actions, [{ type: "dictionary", op: "add", heard: "lazy", write: "Lacy" }]);
    assert.equal(spelledOut("g h o s t t y."), "Ghostty");
    assert.equal(spelledOut("Ghostty"), "Ghostty");
    assert.equal(spelledOut("clip kit"), "clip kit");
  });
  test("other words still go through the classifier", async () => {
    const out = await decideWith("everything", [], "The dictionary feature has a bug.");
    assert.equal(out.classifier, 1);
    assert.notEqual(out.step, "dictionary");
  });
});

describe("decide(): two sessions in one folder, named by the folder", () => {
  // With the dictionary, "ask Claude Code speech to …" names the
  // folder of the renamed "cloud speech" (dealt with last) and an unnamed session listed by it.
  const world = makeWorld([
    { name: "cloud speech", folder: "claude-code-speech", given: "cloud speech", title: "Project notes" },
    { name: "capital of france", folder: "claude-code-speech", title: "Capital of France" },
    CAST.clipkit,
  ]);
  const S = (name: string) => world.byName.get(name)!;
  const decideWith = (text: string, actions: Action[], last = "cloud speech") =>
    decide(
      {
        text,
        sessions: world.sessions,
        notes: world.notes,
        recent: [],
        waiting: null,
        justSpoke: null,
        lastId: S(last).sessionId,
        appAsked: false,
        lastSent: null,
        lastRepeat: false,
        voiceCan: "messages",
        classifierMinConfidence: 0.75,
      },
      { utterance: null, approval: null, trim: null, route: async () => ({ text: "", actions, claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 }) },
    );
  const sessionOf = (a: { type: string; session?: { sessionId: string } }) => a.session?.sessionId;
  test("the folder alone: the one dealt with last, over the router's pick of the other", async () => {
    const ask = await decideWith("Let's ask Claude Code speech to check the latest logs.", [{ name: "ask_session", session: S("capital of france"), message: "Check the latest logs." }]);
    assert.equal(sessionOf(ask.actions[0] as any), S("cloud speech").sessionId);
    const pass = await decideWith("For Claude Code speech, the header should show the time.", [{ name: "pass_on", session: S("capital of france") }]);
    assert.equal(sessionOf(pass.actions[0] as any), S("cloud speech").sessionId);
  });
  test("named by what's its alone (its title): the router's pick stays", async () => {
    const d = await decideWith("Ask the Claude Code speech capital of France session what Spain's capital is.", [
      { name: "ask_session", session: S("capital of france"), message: "What's the capital of Spain?" },
    ]);
    assert.equal(sessionOf(d.actions[0] as any), S("capital of france").sessionId);
  });
  test("not naming the folder ('the other one'): the router's pick stays", async () => {
    const d = await decideWith("Ask the other one what it's doing.", [{ name: "ask_session", session: S("capital of france"), message: "What are you doing?" }]);
    assert.equal(sessionOf(d.actions[0] as any), S("capital of france").sessionId);
  });
  test("another folder: untouched", async () => {
    const d = await decideWith("Ask clipkit about Claude Code speech.", [{ name: "ask_session", session: S("clipkit"), message: "Status?" }]);
    assert.equal(sessionOf(d.actions[0] as any), S("clipkit").sessionId);
  });
});
