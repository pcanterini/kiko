// What's said when the app can't type into a session (core/reach.ts): `kiko claude` suggested
// for a terminal no adapter finds, only when tmux is installed; a refusal from tmux said as it is.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cantReach, didntType, windowClosedNote } from "../../../src/core/reach.ts";
import type { Session } from "../../../src/core/sessions.ts";

const session = (fields: Partial<Session> = {}) =>
  ({
    sessionId: "s1",
    name: "pixie",
    givenName: "",
    title: "",
    cwd: "/code/pixie",
    kind: "interactive",
    status: "idle",
    lastActiveAt: 0,
    desktop: false,
    nameSetBy: "claude",
    place: null,
    mapping: "none",
    ...fields,
  }) as Session;

describe("cantReach", () => {
  test("a terminal no adapter found: as before, plus how to start one it always can, when tmux is installed", () => {
    assert.equal(cantReach(session(), null, true, null), "Its reply window closed. Reply to pixie in its window.");
    assert.equal(cantReach(session(), null, false, "kiko claude"), "I can only reply to pixie right after it speaks. Reply to it in its window. Start it with kiko claude next time and I always can.");
    assert.equal(cantReach(session(), "stop it", false, "kiko claude"), "I can't reach pixie's terminal to stop it. Start it with kiko claude next time and I always can.");
  });
  test("background sessions, and stopping a desktop one: no tmux advice, it wouldn't help", () => {
    assert.equal(cantReach(session({ kind: "background" }), null, true, "kiko claude"), "pixie runs in the background, so I can only reply right after it speaks.");
    assert.equal(cantReach(session({ desktop: true }), "stop it", true, "kiko claude"), "pixie is in the desktop app, so I can't stop it from here.");
    assert.equal(cantReach(session({ desktop: true }), "rename it", true, "kiko claude"), "pixie is in the desktop app, so I can't rename it from here.");
  });
  test("words for a desktop session: never typed in, said word for word as for a terminal none finds (Warp, iTerm)", () => {
    for (const spoke of [true, false]) {
      for (const start of ["kiko claude", null]) {
        assert.equal(cantReach(session({ desktop: true }), null, spoke, start), cantReach(session(), null, spoke, start));
      }
    }
    assert.equal(cantReach(session({ desktop: true }), null, true, "kiko claude"), "Its reply window closed. Reply to pixie in its window. Start it with kiko claude next time and I always can.");
    assert.equal(
      cantReach(session({ desktop: true }), null, false, "kiko claude"),
      "I can only reply to pixie right after it speaks. Reply to it in its window. Start it with kiko claude next time and I always can.",
    );
  });
});

describe("windowClosedNote: a desktop session is no longer typed into after its window", () => {
  test("no 'hold the key to reply anyway' for it, as for a terminal none finds", () => {
    assert.equal(windowClosedNote("desktop"), "no reply; the session stopped. Reply to it in its window");
    assert.equal(windowClosedNote("desktop"), windowClosedNote("elsewhere"));
    assert.equal(windowClosedNote("terminal"), "no reply; the session stopped. Hold the key to reply anyway");
    assert.equal(windowClosedNote("background"), "no reply; the session stopped");
  });
});

// Lacy's terminal was on Claude Code's agents list (parked
// with ←), and the line said only that it couldn't tell which terminal it was.
describe("cantReach: its terminal shows Claude Code's agents list", () => {
  test("said what's in the way and what to do, never kiko claude (tmux wouldn't help)", () => {
    assert.equal(
      cantReach(session({ mapping: "agents", givenName: "Lacy" }), null, true, "kiko claude"),
      "I couldn't reach Lacy: its terminal is showing Claude Code's agents list, so I didn't type that in. Open Lacy there first.",
    );
    assert.equal(
      cantReach(session({ mapping: "agents" }), "stop it", true, "kiko claude"),
      "pixie's terminal is showing Claude Code's agents list, so I can't stop it from here. Open pixie there first.",
    );
  });
  test("several windows that could be it: said up front that it didn't reach it", () => {
    assert.equal(cantReach(session({ mapping: "ambiguous" }), null, true, null), "I couldn't reach pixie: I can't tell which terminal is pixie, so I didn't type that in.");
  });
});

describe("didntType: tmux found it but wouldn't type", () => {
  test("said with why", () => {
    assert.equal(didntType(session(), null, "its tmux pane has closed"), "I didn't type that into pixie: its tmux pane has closed.");
    assert.equal(didntType(session(), "stop it", "its process has ended"), "I couldn't stop pixie: its process has ended.");
  });
});
