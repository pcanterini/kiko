// Session naming and matching (src/core/sessions.ts): addressedTo, mentionsSession, namesSession, sessionName,
// sessionDetail, and who gave a session its name (nameSetBy, src/core/renames.ts).
// Phrases are in the shape of real spoken requests unless marked otherwise.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dirname } from "node:path";
import { loadRenames, noteRename, RENAMES_FILE } from "../../../src/core/renames.ts";
import {
  addressedTo,
  appNamed,
  LeftTheList,
  mentionsSession,
  namedLikeApp,
  nameSetBy,
  namesSession,
  numberAsListed,
  sessionDetail,
  sessionLabel,
  sessionName,
  sessionsNamed,
  shorten,
  spoken,
  spokenWithTitle,
} from "../../../src/core/sessions.ts";
import { CAST, makeSession, makeWorld } from "../../support/fixtures.ts";

const world = makeWorld([CAST.voice, CAST.clipkit, CAST.lacy, CAST.twoPlusTwo, CAST.random, CAST.pixie]);
const S = (name: string) => world.byName.get(name)!;
const names = (sessions: { sessionId: string; cwd: string; title?: string }[]) => sessions.map(sessionName);

// A session in the kiko folder was listed as "Kiko", so
// "To Kiko, …" (said to the app) went into it. It's "Kiko project" now, everywhere it's shown.
describe("a session that would be called the app's name: 'Kiko project'", () => {
  const inFolder = makeSession({ name: "kiko", title: "Voice app notes and settings" });
  const given = makeSession({ name: "notes", folder: "notes", given: "Kiko" });
  test("in a folder called kiko, or given the name: shown, said and listed as 'Kiko project'", () => {
    assert.equal(appNamed(), "Kiko project");
    assert.equal(sessionName(inFolder), "Kiko project");
    assert.equal(sessionName(given), "Kiko project");
    assert.equal(spoken(sessionName(inFolder)), "Kiko project");
    assert.ok(namedLikeApp(inFolder) && namedLikeApp(given));
    assert.ok(!namedLikeApp(S("clipkit")) && !namedLikeApp(S("claude-code-speech")));
  });
  test("the screen's detail after it: the title (its own folder), or its folder when it was given the name", () => {
    assert.equal(sessionDetail(inFolder), "Voice app notes and settings");
    assert.equal(sessionDetail(given), "notes");
    assert.equal(spokenWithTitle(inFolder), "Kiko project, Voice app notes and settings");
  });
  test("the router's list keeps its folder, so it knows which project it is", () => {
    assert.equal(sessionLabel(inFolder), 'Kiko project (folder kiko, title "Voice app notes and settings")');
  });
  test("'the Kiko project' and 'the Kiko session' name it; mid-sentence 'Kiko' still does", () => {
    const sessions = [inFolder, S("clipkit")];
    for (const said of ["Tell the Kiko project to run the tests.", "Tell the Kiko session to run the tests.", "What's the status of the Kiko project?"]) {
      assert.deepEqual(names(sessionsNamed(sessions, said)), ["Kiko project"], said);
    }
    assert.deepEqual(names(sessionsNamed(sessions, "what's the status of kiko", true)), ["Kiko project"]);
    assert.deepEqual(names(addressedTo(sessions, "In the Kiko project, add a setting for the wake word.")?.sessions ?? []), ["Kiko project"]);
  });
  test("a name that only has the app's in it is its own: 'Kiko docs'", () => {
    assert.equal(sessionName(makeSession({ name: "docs", folder: "docs", given: "Kiko docs" })), "Kiko docs");
  });
});

describe("sessionName", () => {
  test("a terminal session is its folder", () => {
    assert.equal(sessionName(S("clipkit")), "clipkit");
    assert.equal(sessionName(S("claude-code-speech")), "claude-code-speech");
  });
  test("a desktop session in a scratch folder is its title", () => {
    assert.equal(sessionName(S("2 plus 2")), "2 plus 2");
    assert.match(S("2 plus 2").cwd, /Application Support\/Claude\/scratch-workspaces\//);
  });
  test("a desktop session in a real folder is still its folder", () => {
    const s = makeSession({ name: "claude-code-speech", desktop: true, folder: "claude-code-speech", title: "Desktop test" });
    assert.equal(sessionName(s), "claude-code-speech");
    assert.equal(sessionLabel(s), 'claude-code-speech (title "Desktop test")');
  });
  test("a scratch desktop session without a title falls back to its name, then the folder", () => {
    const s = { ...makeSession({ name: "x", desktop: true }), title: "", name: "scratch-2026-10-26-16dc10" };
    assert.equal(sessionName(s), "scratch-2026-10-26-16dc10");
  });
});

describe("addressedTo: a session named up front is routed on (sure)", () => {
  const cases: Array<[string, string, string]> = [
    // [said, session, what's left for Claude]
    ["Clipkit, cut a new dev build.", "clipkit", "Cut a new dev build."],
    ["Tell clipkit to stop the deploy.", "clipkit", "Stop the deploy."],
    // Trimmed by phrase and typed into clipkit.
    ["Go ahead and tell the ClipKit session to fix the issue.", "clipkit", "Fix the issue."],
    ["Pixie, check the logs", "pixie", "Check the logs"],
    // Speech-to-text hears "cloud code speech" for "claude code speech".
    ["Cloud code speech, run the tests.", "claude-code-speech", "Run the tests."],
    ["Send this to lacy platform: deploy the fix.", "lacy-platform", "Deploy the fix."],
    ["This is for clipkit. Bump the version.", "clipkit", "Bump the version."],
    // A desktop session by its title.
    ["2 plus 2, what about 30 plus 30?", "2 plus 2", "What about 30 plus 30?"],
  ];
  for (const [said, to, rest] of cases) {
    test(JSON.stringify(said), () => {
      const a = addressedTo(world.sessions, said);
      assert.ok(a, "should be addressed");
      assert.deepEqual(names(a.sessions), [to]);
      assert.equal(a.sure, true);
      assert.equal(a.rest, rest);
    });
  }
});

describe("addressedTo: softer mentions are only cut, never routed on (not sure)", () => {
  test("ending: 'This is for Claude code speech.'", () => {
    const a = addressedTo(world.sessions, "Let's go with the first plan. This is for Claude code speech.");
    assert.ok(a);
    assert.deepEqual(names(a.sessions), ["claude-code-speech"]);
    assert.equal(a.sure, false);
    assert.equal(a.rest, "Let's go with the first plan.");
  });
  test("'Uh, to cloud code speech. I meant that for another session…'", () => {
    const a = addressedTo(world.sessions, "Uh, to cloud code speech. I meant that for another session, sorry. It wasn't for this one.");
    assert.ok(a);
    assert.equal(a.sure, false);
  });
  test("a one-word name needs a colon or 'one' after 'for'", () => {
    assert.equal(addressedTo(world.sessions, "For pixie, check the logs"), null);
    const a = addressedTo(world.sessions, "for pixie: check the logs");
    assert.ok(a);
    assert.equal(a.sure, false);
  });
  test("'the other one' is cut but names no session", () => {
    const a = addressedTo(world.sessions, "Tell the other one to run the tests");
    assert.ok(a);
    assert.deepEqual(a.sessions, []);
    assert.equal(a.rest, "Run the tests");
  });
});

describe("addressedTo: not an address", () => {
  const none = [
    "Stop.",
    "Yeah, you can commit.",
    // A correction: names clipkit, but isn't an instruction for it.
    "No, that wasn't for cloud, code speech, that was meant to go to Clipkit.",
    "Clipkit", // nothing left to send
    "Clipkit, please.",
    "Check the logs for the pixie deploy", // mentions pixie mid-sentence
  ];
  for (const said of none) test(JSON.stringify(said), () => assert.equal(addressedTo(world.sessions, said)?.sure ?? false, false));
});

describe("addressedTo: 'in / on the X session, …'", () => {
  // The classifier and the router had to get these; now a phrase does.
  test("'In the Clipkit session, let's make a fresh build…' names clipkit up front", () => {
    const a = addressedTo(world.sessions, "In the Clipkit session, let's make a fresh build of the app.");
    assert.equal(a?.sure, true);
    assert.deepEqual(names(a!.sessions), ["clipkit"]);
    assert.equal(a!.rest, "Let's make a fresh build of the app.");
  });
  test("'On the atlas agent session, can we ask…' names atlas-agents up front (singular 'agent' too)", () => {
    const w = makeWorld([CAST.atlas, CAST.voice]);
    const a = addressedTo(w.sessions, "Uh, on the atlas agent session, can we ask what it would take?");
    assert.equal(a?.sure, true);
    assert.deepEqual(names(a!.sessions), ["atlas-agents"]);
  });
  test("needs 'session' (or one, instance…): 'in the settings, …' is about settings", () => {
    const w = makeWorld([CAST.clipkit, { name: "settings" }]);
    assert.equal(addressedTo(w.sessions, "In the settings, the voice list is too long.")?.sure ?? false, false);
  });
});

describe("addressedTo: the longest name wins", () => {
  test("'claude code speech' over a session called 'voice'", () => {
    const w = makeWorld([CAST.voice, { name: "voice" }]);
    const a = addressedTo(w.sessions, "Claude code speech, run the tests.");
    assert.ok(a);
    assert.deepEqual(names(a.sessions), ["claude-code-speech"]);
  });
  test("two sessions in one folder: the folder name names both, the title names one", () => {
    const w = makeWorld([
      { name: "voice-a", folder: "claude-code-speech", title: "in-app settings" },
      { name: "voice-b", folder: "claude-code-speech", title: "random" },
    ]);
    const both = addressedTo(w.sessions, "Claude code speech, run the tests.");
    assert.ok(both);
    assert.equal(both.sessions.length, 2, "ambiguous: deliver() only routes on exactly one");
    const one = addressedTo(w.sessions, "Tell the in-app settings, um, to try a smaller model instead.");
    assert.ok(one);
    assert.deepEqual(
      one.sessions.map((s) => s.title),
      ["in-app settings"],
    );
    assert.equal(one.sure, true);
    assert.equal(one.rest, "Try a smaller model instead.");
  });
});

describe('names beat titles (claude-code-speech also titled "random")', () => {
  test("addressedTo: 'the random session' is the desktop session called random", () => {
    const a = addressedTo(world.sessions, "Tell the random session to say hi.");
    assert.ok(a);
    assert.deepEqual(names(a.sessions), ["random"]);
    assert.equal(a.sure, true);
  });
  test("sessionsNamed: the name first, the title only when no name matches", () => {
    assert.deepEqual(names(sessionsNamed(world.sessions, "Rename the random session to mountains.")), ["random"]);
    const titledOnly = makeWorld([CAST.voice, CAST.clipkit]);
    assert.deepEqual(names(sessionsNamed(titledOnly.sessions, "Rename the random session to mountains.")), ["claude-code-speech"]);
  });
  test("sessionsNamed: two sessions with the same name is ambiguous", () => {
    const w = makeWorld([
      { name: "voice-a", folder: "claude-code-speech", title: "in-app settings" },
      { name: "voice-b", folder: "claude-code-speech", title: "random" },
    ]);
    assert.equal(sessionsNamed(w.sessions, "Stop the claude code speech session.").length, 2);
    assert.deepEqual(
      sessionsNamed(w.sessions, "Stop the in-app settings one.").map((s) => s.title),
      ["in-app settings"],
    );
  });
  test("sessionsNamed loose: a name anywhere, run together or apart", () => {
    assert.deepEqual(names(sessionsNamed(world.sessions, "So could you read the last clipkit message again?", true)), ["clipkit"]);
    assert.deepEqual(names(sessionsNamed(world.sessions, "Read the last clip kit message again.", true)), ["clipkit"]);
    assert.deepEqual(sessionsNamed(world.sessions, "So could you read the last clipkit message again?"), [], "strict: a one-word name mid-sentence isn't one");
    assert.deepEqual(sessionsNamed(world.sessions, "Can you repeat that?", true), []);
  });
});

describe("mentionsSession (the stop guard) and namesSession (the trim check)", () => {
  test("names the session to stop", () => {
    assert.ok(mentionsSession(S("clipkit"), "Stop clipkit, it's going the wrong way."));
    assert.ok(mentionsSession(S("clipkit"), "In the clipkit instance, an agent looks like it's still going. Please stop that build and the release."));
    assert.ok(mentionsSession(S("pixie"), "stop pixie"));
    assert.ok(mentionsSession(S("pixie"), "the pixie one"));
    assert.ok(mentionsSession(S("claude-code-speech"), "interrupt cloud code speech"));
  });
  test("a desktop session by its title", () => {
    assert.ok(mentionsSession(S("2 plus 2"), "In the 2 plus 2 session, can you ask what about 4 plus 4?"));
  });
  test("doesn't name it", () => {
    // Escape once went to claude-code-speech for these.
    assert.equal(mentionsSession(S("claude-code-speech"), "Looks like an agent's still going on it. So have that instance halt it."), false);
    assert.equal(mentionsSession(S("claude-code-speech"), "Stop."), false);
    // A one-word name mid-sentence isn't a mention: "check the logs" isn't about a "logs" session.
    assert.equal(mentionsSession(S("pixie"), "check the pixie logs"), false);
    assert.equal(mentionsSession(makeSession({ name: "logs" }), "check the logs"), false);
  });
  test("one-word folder after 'about' isn't a mention (a gap: 'I'm talking about ClipKit')", () => {
    assert.equal(mentionsSession(S("clipkit"), "Okay, I'm talking about ClipKit."), false);
  });
  test("namesSession: any session word counts", () => {
    assert.ok(namesSession(world.sessions, "for the shipping rates one")); // "one" + a word from a title
    assert.equal(namesSession(world.sessions, "for the in-app settings one"), false, "no session has 'settings' in its name");
    assert.ok(namesSession(world.sessions, "tell the other session to"));
    assert.ok(namesSession(world.sessions, "this is for clipkit"));
    assert.equal(namesSession(world.sessions, "for the settings, it's only using part of the screen"), false);
  });
  test("an 'uh' between the words doesn't hide the name", () => {
    // Haiku picked "Tell, uh, Lacy" but the check said it named no session.
    assert.ok(namesSession([makeSession({ ...CAST.lacy, given: "Lacy" })], "Tell, uh, Lacy"));
    assert.ok(mentionsSession(S("pixie"), "stop, um, pixie"));
    assert.ok(mentionsSession(S("pixie"), "the pixie, uh, one"));
  });
});

// A session renamed with /rename ("given") goes by that name; its folder and Claude's title still reach it.
describe("given names (/rename): what the screen shows and says", () => {
  const named = makeSession({ name: "cloud speech", folder: "claude-code-speech", given: "cloud speech", title: "Voice app notes and settings" });
  const unnamed = makeSession({ name: "voice-b", folder: "claude-code-speech", title: "Capital of France" });
  test("a named session is its name, with its folder dimmed after it", () => {
    assert.equal(sessionName(named), "cloud speech");
    assert.equal(sessionDetail(named), "claude-code-speech");
  });
  test("an unnamed one is its folder, with Claude's title for it dimmed after it, cut short", () => {
    assert.equal(sessionName(unnamed), "claude-code-speech");
    assert.equal(sessionDetail(unnamed), "Capital of France");
    assert.equal(sessionDetail(S("lacy-platform"), 25), "Shipping rates in secure…");
    assert.equal(sessionDetail(S("lacy-platform"), 24), "Shipping rates in…");
    assert.equal(sessionDetail(makeSession({ name: "plain" })), "", "no title: nothing after it");
  });
  test("two unnamed sessions in one folder differ by their numbers, and by their titles", () => {
    const [first, other] = numberAsListed([unnamed, makeSession({ name: "voice-c", folder: "claude-code-speech", title: "Session colours" })]);
    assert.deepEqual([sessionName(first), sessionName(other)], ["claude-code-speech", "claude-code-speech 2"]);
    assert.notEqual(sessionDetail(other), sessionDetail(first));
  });
  test("a desktop session in a scratch folder keeps its title as its name, with nothing after it", () => {
    assert.equal(sessionName(S("2 plus 2")), "2 plus 2");
    assert.equal(sessionDetail(S("2 plus 2")), "");
    const renamed = { ...S("2 plus 2"), givenName: "maths" };
    assert.equal(sessionName(renamed), "maths");
    assert.equal(sessionDetail(renamed), "");
  });
  test("a name that's only its folder again counts as no name", () => {
    const same = makeSession({ name: "clipkit", given: "ClipKit", title: "ClipKit export window jump" });
    assert.equal(sessionDetail(same), "ClipKit export window jump");
  });
  test("prompts get the name, folder and title; speech the name, with the title only to tell two apart", () => {
    assert.equal(sessionLabel(named), 'cloud speech (folder claude-code-speech, title "Voice app notes and settings")');
    assert.equal(sessionLabel(unnamed), 'claude-code-speech (title "Capital of France")');
    assert.equal(sessionLabel(S("2 plus 2")), "2 plus 2");
    assert.equal(spokenWithTitle(unnamed), "claude code speech, Capital of France");
    assert.equal(spoken(sessionName(named)), "cloud speech");
  });
  test("shorten cuts between words", () => {
    assert.equal(shorten("Shipping rates in secure checkout", 20), "Shipping rates in…");
    assert.equal(shorten("short", 20), "short");
  });
});

describe("given names: routing takes the name, the folder or the title", () => {
  const named = { name: "cloud speech", folder: "claude-code-speech", given: "cloud speech", title: "Voice app notes and settings" };
  const w = makeWorld([named, CAST.clipkit, CAST.twoPlusTwo]);
  const to = (said: string) => addressedTo(w.sessions, said);
  test("by its name, as speech-to-text hears it", () => {
    for (const said of ["Tell cloud speech to run the tests.", "Claude speech, run the tests.", "Cloud speech, run the tests."]) {
      const a = to(said);
      assert.deepEqual(a?.sessions.map(sessionName), ["cloud speech"], said);
      assert.equal(a?.sure, true, said);
      assert.equal(a?.rest, "Run the tests.");
    }
  });
  test("by its folder", () => {
    const a = to("Tell claude code speech to run the tests.");
    assert.deepEqual(a?.sessions.map(sessionName), ["cloud speech"]);
    assert.equal(a?.sure, true);
  });
  test("by Claude's title for it", () => {
    const a = to("Tell the voice app notes and settings session to commit.");
    assert.deepEqual(a?.sessions.map(sessionName), ["cloud speech"]);
  });
  test("mentionsSession and sessionsNamed: name, folder and title", () => {
    const s = w.byName.get("cloud speech")!;
    assert.ok(mentionsSession(s, "stop cloud speech"));
    assert.ok(mentionsSession(s, "interrupt claude code speech"));
    assert.ok(mentionsSession(s, "stop cloud speech", "name"));
    assert.ok(mentionsSession(s, "stop claude code speech", "name"), "its folder counts as a name");
    assert.equal(mentionsSession(s, "stop the voice app notes and settings session", "name"), false);
    assert.ok(mentionsSession(s, "stop the voice app notes and settings session", "title"));
    assert.deepEqual(sessionsNamed(w.sessions, "Rename cloud speech to tests.").map(sessionName), ["cloud speech"]);
    assert.deepEqual(sessionsNamed(w.sessions, "Repeat the last cloud speech message.", true).map(sessionName), ["cloud speech"]);
  });
  test("two sessions in one folder with names of their own: each by its name; the folder names both", () => {
    const two = makeWorld([
      { name: "cloud speech", folder: "claude-code-speech", given: "cloud speech", title: "Voice app notes and settings" },
      { name: "settings work", folder: "claude-code-speech", given: "settings work", title: "In-app settings screen" },
    ]);
    assert.deepEqual(addressedTo(two.sessions, "Settings work, use a subagent.")?.sessions.map(sessionName), ["settings work"]);
    assert.deepEqual(addressedTo(two.sessions, "Tell cloud speech to commit.")?.sessions.map(sessionName), ["cloud speech"]);
    assert.equal(addressedTo(two.sessions, "Claude code speech, commit.")?.sessions.length, 2, "ambiguous: asks which");
    assert.equal(sessionsNamed(two.sessions, "Stop the claude code speech session.").length, 2);
  });
  test("a session's name beats another's title; two sharing a name is ambiguous", () => {
    const renamed = { name: "random", folder: "claude-code-speech", given: "random" };
    const titled = { name: "clipkit", title: "random" };
    const a = makeWorld([renamed, titled]);
    assert.deepEqual(
      addressedTo(a.sessions, "Tell the random session to say hi.")?.sessions.map((s) => s.sessionId),
      ["id-random"],
    );
    assert.deepEqual(
      sessionsNamed(a.sessions, "Stop the random session.").map((s) => s.sessionId),
      ["id-random"],
    );
    const b = makeWorld([renamed, { ...CAST.random }]);
    assert.equal(addressedTo(b.sessions, "Tell the random session to say hi.")?.sessions.length, 2);
  });
});

describe("nameSetBy: who gave a session its name (internal)", () => {
  test("no given name: Claude's title and the folder", () => assert.equal(nameSetBy("id-x", "", {}), "claude"));
  test("the name the app gave it: the app's", () => {
    assert.equal(nameSetBy("id-x", "Migrations", { "id-x": { name: "migrations", at: 1 } }), "app");
  });
  test("any other name, or one the app gave another session: the user's", () => {
    assert.equal(nameSetBy("id-x", "cloud speech", { "id-x": { name: "migrations", at: 1 } }), "user");
    assert.equal(nameSetBy("id-x", "migrations", { "id-y": { name: "migrations", at: 1 } }), "user");
  });
  test("a session listed under a background process's ID: the app's rename under its terminal's ID counts", () => {
    assert.equal(nameSetBy(["engine", "front"], "Migrations", { front: { name: "migrations", at: 1 } }), "app");
    assert.equal(nameSetBy(["engine", "front"], "Migrations", { other: { name: "migrations", at: 1 } }), "user");
  });
  test("the app's renames are kept on disk, next to the settings", () => {
    noteRename("id-kept", "migrations", 5);
    noteRename("id-other", "tests", 6);
    assert.equal(dirname(RENAMES_FILE), dirname(process.env.KIKO_SETTINGS!));
    assert.deepEqual(loadRenames()["id-kept"], { name: "migrations", at: 5 });
    assert.equal(nameSetBy("id-kept", "migrations"), "app");
    noteRename("id-kept", "migrations two", 7);
    assert.equal(nameSetBy("id-kept", "migrations"), "user", "renamed again since: that name is the user's now");
  });
});

// A session whose process ended leaves `claude agents`: whatever said it needed you goes once it
// has been missing from two listings in a row (one alone may be a listing that failed: empty).
describe("LeftTheList: a session listed, then gone from the list", () => {
  const live = { sessionId: "live-check-tmp" };
  const other = { sessionId: "lacy" };
  test("listed, then missing from two listings in a row: it has ended; each listing counts once, however often it's looked at", () => {
    const left = new LeftTheList();
    assert.deepEqual(left.look([live, other], ["live-check-tmp"]), []);
    const once = [other];
    assert.deepEqual(left.look(once, ["live-check-tmp"]), [], "one listing without it: maybe a failed one");
    assert.deepEqual(left.look(once, ["live-check-tmp"]), [], "the same listing again isn't another");
    assert.deepEqual(left.look([other], ["live-check-tmp"]), ["live-check-tmp"]);
    assert.deepEqual(left.look([other], ["live-check-tmp"]), ["live-check-tmp"], "ended for as long as it's watched");
    assert.deepEqual(left.look([other], []), [], "not watched any more: forgotten");
    assert.deepEqual(left.look([other], ["live-check-tmp"]), []);
  });
  test("never listed (not seen yet), or back in the list between: not ended; listed under an alias counts as listed", () => {
    const left = new LeftTheList();
    assert.deepEqual(left.look([], ["new"]), []);
    assert.deepEqual(left.look([], ["new"]), [], "never seen: nothing to say it ended");
    left.look([live], ["live-check-tmp"]);
    left.look([], ["live-check-tmp"]);
    left.look([{ sessionId: "engine", aliases: ["live-check-tmp"] }], ["live-check-tmp"]);
    assert.deepEqual(left.look([], ["live-check-tmp"]), [], "back between: counting starts again");
    assert.deepEqual(left.look([], ["live-check-tmp"]), ["live-check-tmp"]);
  });
});
