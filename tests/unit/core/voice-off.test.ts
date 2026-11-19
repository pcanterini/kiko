// Better defaults: after a clean install, a request for a new Codex session got "Starting sessions
// is off in settings.", and the setting (Settings → Control
// → Voice can) wasn't where the user looked. Voice can is Everything by default now, and whatever it
// stops is said with the setting's path and an offer to turn it on, which a yes carries out.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { decide, gate, type Act, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { SETTING_ABOUT, VOICE_CAN } from "../../../src/core/settings-options.ts";
import { offFromWords, SAYS_OFF_IN_SETTINGS, TURN_ON, turnOnSay, VOICE_CAN_PATH, voiceOffLine, voiceOffShown } from "../../../src/core/voice-off.ts";
import { asksYou } from "../../../src/core/routing-rules.ts";
import { makeWorld, CAST } from "../../support/fixtures.ts";

describe("the default", () => {
  /** config.voiceCan in its own process, on its own settings file (none: a fresh install). Never the real one. */
  function voiceCanWith(saved: Record<string, unknown> | null, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "kiko-voice-can-"));
    try {
      const file = join(dir, "settings.json");
      if (saved) writeFileSync(file, JSON.stringify(saved));
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KIKO_)?VOICE_CAN$/.test(k)));
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", "const c = await import(process.env.CONFIG_URL); console.log(c.config.voiceCan);"], {
        cwd: dir,
        env: { ...clean, CONFIG_URL: new URL("../../../src/core/config.ts", import.meta.url).href, KIKO_SETTINGS: file, KIKO_ENV_FILE: "", ...env },
        encoding: "utf8",
      });
      return out.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a fresh install (no settings file, or none saved): Everything", () => {
    assert.equal(voiceCanWith(null), "everything");
    assert.equal(voiceCanWith({ sounds: false }), "everything");
  });

  test("a value you saved stays yours; KIKO_VOICE_CAN still wins", () => {
    assert.equal(voiceCanWith({ voiceCan: "messages" }), "messages");
    assert.equal(voiceCanWith({ voiceCan: "replies" }), "replies");
    assert.equal(voiceCanWith({ voiceCan: "everything" }, { KIKO_VOICE_CAN: "messages" }), "messages");
  });

  test("the settings screen says Everything is the default, and the gate", () => {
    assert.match(SETTING_ABOUT.voiceCan, /Everything is the default/);
    assert.doesNotMatch(SETTING_ABOUT.voiceCan, /Replies and messages is the default/);
    assert.match(SETTING_ABOUT.voiceCan, /safety gate/);
    assert.deepEqual(
      VOICE_CAN.map((c) => c.value),
      ["replies", "messages", "everything"],
    );
  });
});

describe("what's said when Voice can stops something", () => {
  test("names what's off, the exact path, and offers to turn it on (not a question: what you say next is decided as usual)", () => {
    const line = voiceOffLine("start");
    assert.equal(line, "Starting sessions by voice is off. In Settings, under Control, Voice can: Everything turns it on. Say turn it on, and I'll do it now.");
    for (const what of ["start", "stop", "rename", "check", "dictionary", "message", "trust"] as const) {
      const said = voiceOffLine(what);
      assert.match(said, /In Settings, under Control, Voice can: Everything turns it on\./, what);
      assert.ok(said.endsWith(turnOnSay(what)), what);
      // A question would have the app read your next words as its answer (decide.ts appAsked).
      assert.ok(!asksYou(said), what);
      assert.doesNotMatch(said, /→/, `${what}: the voice reads no arrows`);
      assert.doesNotMatch(said, /off in settings/i, what);
    }
  });

  test("the offer: what comes of it", () => {
    assert.equal(turnOnSay("start"), "Say turn it on, and I'll do it now.");
    assert.equal(turnOnSay("message"), "Say turn it on, and I'll send it.");
    assert.equal(turnOnSay("trust"), "Say turn it on, and I'll answer it.");
    assert.equal(turnOnSay("start", false), "Say turn it on to allow it now.");
    assert.match(voiceOffLine("check", { carries: false }), /Say turn it on to allow it now\.$/);
  });

  test("a message at Replies only: whose, when another one waits; else that nothing does", () => {
    assert.match(voiceOffLine("message", { name: "atlas agents" }), /^atlas agents isn't waiting for a reply, and your voice can only answer a session that's waiting\. /);
    assert.match(voiceOffLine("message"), /^Nothing's waiting for a reply right now, and your voice can only answer/);
  });

  test("a first sentence of the caller's own keeps the path and the offer", () => {
    assert.equal(
      voiceOffLine("stop", { off: "Stopping sessions by voice is off, so Lacy will carry on with that." }),
      "Stopping sessions by voice is off, so Lacy will carry on with that. In Settings, under Control, Voice can: Everything turns it on. Say turn it on, and I'll do it now.",
    );
  });

  test("shown: the path with arrows, and what to say", () => {
    assert.equal(voiceOffShown("start"), `(Starting sessions by voice: ${VOICE_CAN_PATH} → Everything turns it on. Say “turn it on” to allow it now.)`);
    assert.equal(VOICE_CAN_PATH, "Settings → Control → Voice can");
  });

  test("'turn it on' and the like answer the offer; other words don't", () => {
    for (const said of ["Turn it on.", "Yes, turn it on.", "yeah turn that on", "Enable it.", "Allow it.", "Switch it on.", "Okay, set it to everything.", "Turn on everything."]) {
      assert.ok(TURN_ON.test(said), said);
    }
    for (const said of ["Turn on the lights in pixie.", "tell pixie to enable caching", "No.", "What's that?"]) assert.ok(!TURN_ON.test(said), said);
  });

  test("the router's own 'off in settings' lines are caught; other lines aren't", () => {
    for (const said of [
      "Starting sessions is off in settings.",
      "That's turned off in the app's settings.",
      "Checking your computer is off in settings.",
      "Renaming sessions are disabled in your settings.",
    ]) {
      assert.ok(SAYS_OFF_IN_SETTINGS.test(said), said);
    }
    for (const said of ["Clipkit is busy.", "It's 5 pm.", "The settings screen is open in pixie."]) assert.ok(!SAYS_OFF_IN_SETTINGS.test(said), said);
  });

  test("what such a line was about, from your words", () => {
    assert.equal(offFromWords("Open a new codex session and name it permission test."), "start");
    assert.equal(offFromWords("Stop clipkit."), "stop");
    assert.equal(offFromWords("Rename this session to migrations."), "rename");
    assert.equal(offFromWords("Add ghosty to the dictionary."), "dictionary");
    assert.equal(offFromWords("How much disk space do I have?"), "check");
  });
});

describe("decide: refused with what was asked kept, and the answer to the offer", () => {
  const world = makeWorld([CAST.voice, CAST.clipkit]);
  const clipkit = world.byName.get("clipkit")!;
  const base = (over: Partial<DecideState>): DecideState => ({
    text: "",
    sessions: world.sessions,
    notes: world.notes,
    recent: [],
    waiting: null,
    justSpoke: null,
    lastId: null,
    appAsked: false,
    lastSent: null,
    lastRepeat: false,
    voiceCan: "messages",
    classifierMinConfidence: 0.75,
    ...over,
  });
  const deps = (route: DecideDeps["route"] = async () => null): DecideDeps => ({ utterance: null, approval: null, route, trim: null });
  const routerSays = (text: string, actions: unknown[] = []): DecideDeps["route"] =>
    (async () => ({ actions, text, costUsd: 0, usage: { input_tokens: 0, output_tokens: 0 }, claimsAction: false })) as unknown as DecideDeps["route"];

  test("gate: allowed as is at Everything; below it, refused with the act kept", () => {
    const stop: Act = { type: "stop", session: clipkit };
    assert.deepEqual(gate({ voiceCan: "everything" }, stop), stop);
    assert.deepEqual(gate({ voiceCan: "messages" }, stop), { type: "refused", what: "stop", session: clipkit, then: stop });
    const say: Act = { type: "say", text: "hi" };
    assert.deepEqual(gate({ voiceCan: "replies" }, say), say);
  });

  test("the user's words at Replies and messages: the codex session is refused, kept to start once it's on", async () => {
    const said = "Open a new codex session and name it permission test.";
    const d = await decide(base({ text: said }), deps(routerSays("", [{ name: "start_session", project: null, newProject: false, sessionName: "permission test", prompt: "", agent: "codex" }])));
    assert.equal(d.actions.length, 1);
    const [a] = d.actions as Array<Act & { type: "refused" }>;
    assert.equal(a.type, "refused");
    assert.equal(a.what, "start");
    assert.deepEqual([a.then?.type, (a.then as any)?.name, (a.then as any)?.agent], ["start", "permission test", "codex"]);
  });

  test("the same words at Everything (the default): started", async () => {
    const d = await decide(
      base({ text: "Open a new codex session and name it permission test.", voiceCan: "everything" }),
      deps(routerSays("", [{ name: "start_session", project: null, newProject: false, sessionName: "permission test", prompt: "", agent: "codex" }])),
    );
    assert.deepEqual(
      d.actions.map((a) => [a.type, (a as any).name, (a as any).agent]),
      [["start", "permission test", "codex"]],
    );
  });

  test("the router saying it's off itself: the app's line instead (refused, nothing kept: 'say it again')", async () => {
    const d = await decide(base({ text: "Open a new session in pixie." }), deps(routerSays("Starting sessions is off in settings.")));
    assert.deepEqual(d.actions, [{ type: "refused", what: "start" }]);
    // At Everything nothing is off: its words, as they are (never seen, but never rewritten either).
    const e = await decide(base({ text: "What's up?", voiceCan: "everything" }), deps(routerSays("Clipkit is busy.")));
    assert.deepEqual(e.actions, [{ type: "say", text: "Clipkit is busy." }]);
  });

  const offered = (text: string, over: Partial<DecideState> = {}) => decide(base({ text, voiceOffer: true, recent: [`app said: ${voiceOffLine("start")}`], ...over }), deps(routerSays("")));

  test("yes, or 'turn it on', right after the offer: voice_on", async () => {
    for (const said of ["Yes.", "Yeah, do it.", "Turn it on.", "Sure, turn it on.", "Allow it."]) {
      const d = await offered(said);
      assert.deepEqual([d.step, d.actions], ["voice-on", [{ type: "voice_on" }]], said);
    }
  });

  test("no: nothing turned on", async () => {
    const d = await offered("No.");
    assert.ok(!d.actions.some((a) => a.type === "voice_on"));
  });

  test("a yes that takes itself back turns nothing on", async () => {
    const d = await offered("Yes. Actually, never mind.");
    assert.ok(!d.actions.some((a) => a.type === "voice_on"));
  });

  test("a session waiting for a reply: a plain yes is its reply; only 'turn it on' takes the offer", async () => {
    const waiting = { sessionId: clipkit.sessionId, cwd: clipkit.cwd };
    const yes = await decide(base({ text: "Yes.", voiceOffer: true, waiting }), deps());
    assert.ok(!yes.actions.some((a) => a.type === "voice_on"));
    const on = await decide(base({ text: "Turn it on.", voiceOffer: true, waiting }), deps());
    assert.deepEqual(on.actions, [{ type: "voice_on" }]);
  });

  test("no offer standing: 'turn it on' is words like any others", async () => {
    let routed = 0;
    const route = (async () => {
      routed++;
      return { actions: [], text: "ok", costUsd: 0, usage: { input_tokens: 0, output_tokens: 0 }, claimsAction: false };
    }) as unknown as DecideDeps["route"];
    const d = await decide(base({ text: "Turn it on.", appAsked: true, voiceOffer: false }), deps(route));
    assert.ok(!d.actions.some((a) => a.type === "voice_on"));
    assert.equal(routed, 1);
  });
});
