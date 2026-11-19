// Finding where a session can be typed into (src/terminals/): Ghostty's match by folder and title
// (moved from core/sessions.ts as it was), the desktop app's sessions (none reaches them), and the
// first adapter that reaches a session winning.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchWindow } from "../../../src/terminals/ghostty/index.ts";
import { findPlaces, terminals } from "../../../src/terminals/index.ts";
import { readFileSync } from "node:fs";
import { CONFIG, TITLE_MARK, TITLE_MARKS } from "../../../src/terminals/tmux/tmux.ts";
import type { Findable, Found, Terminal } from "../../../src/terminals/types.ts";

const session = (fields: Partial<Findable> = {}): Findable => ({
  sessionId: "s1",
  cwd: "/code/clipkit",
  kind: "interactive",
  desktop: false,
  titles: ["Upload bug"],
  ...fields,
});
const at = (id: string) => ({ via: "ghostty", id, keys: true });

describe("Ghostty: a session's window", () => {
  test("by title in its folder, past Claude Code's status glyph", () => {
    const windows = [
      { id: "w1", title: "✳ Upload bug", cwd: "/code/clipkit" },
      { id: "w2", title: "⠋ Other thing", cwd: "/code/clipkit" },
    ];
    assert.deepEqual(matchWindow(session(), windows, 2), { place: at("w1"), mapping: "title" });
  });
  test("the same title in another folder doesn't count", () => {
    const windows = [{ id: "w1", title: "✳ Upload bug", cwd: "/code/other" }];
    assert.deepEqual(matchWindow(session(), windows, 1), { place: null, mapping: "none" });
  });
  test("the only Claude-looking window, when it's the only session in its folder", () => {
    const windows = [
      { id: "w1", title: "✳ Something else", cwd: "/code/clipkit" },
      { id: "w2", title: "zsh", cwd: "/code/clipkit" },
    ];
    assert.deepEqual(matchWindow(session(), windows, 1), { place: at("w1"), mapping: "only" });
  });
  test("two sessions in the folder and no title to tell them apart: ambiguous", () => {
    const windows = [{ id: "w1", title: "✳ Something else", cwd: "/code/clipkit" }];
    assert.deepEqual(matchWindow(session(), windows, 2), { place: null, mapping: "ambiguous" });
  });
  test("never a window showing Kiko's tmux, though it carries a session's title (typing there goes to the active pane)", () => {
    // An outside session alone in its folder (plain claude in VS Code), the Kiko window opened there showing another session.
    const kiko = [{ id: "w1", title: `${TITLE_MARK}✳ Something else`, cwd: "/code/clipkit" }];
    assert.deepEqual(matchWindow(session(), kiko, 1), { place: null, mapping: "none" });
    // Either flavour's ("Kiko · ", "Kiko Dev · "): the other one's tmux may still be shown in a window.
    for (const mark of TITLE_MARKS) assert.deepEqual(matchWindow(session(), [{ id: "w1", title: `${mark}✳ Upload bug`, cwd: "/code/clipkit" }], 1), { place: null, mapping: "none" });
    // tmux.conf titles every terminal showing Kiko's tmux so (the release's mark; the window sets its own: window.ts).
    assert.ok(readFileSync(CONFIG, "utf8").includes(`set -g set-titles-string "${TITLE_MARKS[0]}#{pane_title}"`));
  });
  test("two windows with its title: ambiguous", () => {
    const windows = [
      { id: "w1", title: "✳ Upload bug", cwd: "/code/clipkit" },
      { id: "w2", title: "◐ Upload bug", cwd: "/code/clipkit" },
    ];
    assert.deepEqual(matchWindow(session(), windows, 2), { place: null, mapping: "ambiguous" });
  });
  test("a title as words: case and punctuation aside", () => {
    const windows = [{ id: "w1", title: "✳ cloud-speech", cwd: "/code/clipkit" }];
    assert.deepEqual(matchWindow(session({ titles: ["Cloud Speech"] }), windows, 2), { place: at("w1"), mapping: "title" });
  });
});

// The Kiko project and Lacy had each just
// been parked with ← (Claude Code moved their turns into a background job), which leaves the
// terminal on Claude Code's agents list, titled "claude agents" or "1 awaiting input · claude
// agents": no name, no status glyph. Both were refused as "ambiguous"; once each was opened there
// again (its title back to "◑ Lacy"), typing worked.
describe("Ghostty: a window showing Claude Code's agents list is never typed into", () => {
  const LACY = session({ cwd: "/code/lacy-platform", titles: ["Lacy"] });
  test("the parked session's terminal on the agents list: 'agents', nothing to type into", () => {
    for (const title of ["1 awaiting input · claude agents", "claude agents", "3 awaiting input · claude agents"]) {
      const windows = [{ id: "826D", title, cwd: "/code/lacy-platform" }];
      assert.deepEqual(matchWindow(LACY, windows, 1), { place: null, mapping: "agents" }, title);
    }
  });
  test("opened there again, titled with its name: by title", () => {
    const windows = [{ id: "826D", title: "◑ Lacy", cwd: "/code/lacy-platform" }];
    assert.deepEqual(matchWindow(LACY, windows, 1), { place: at("826D"), mapping: "title" });
  });
  test("a shell beside it changes nothing", () => {
    const windows = [
      { id: "826D", title: "1 awaiting input · claude agents", cwd: "/code/lacy-platform" },
      { id: "5C6C", title: "me@mac:~/code/lacy-platform", cwd: "/code/lacy-platform" },
    ];
    assert.deepEqual(matchWindow(LACY, windows, 1), { place: null, mapping: "agents" });
  });
  test("the agents list beside another Claude-looking window: no guess at the 'only' one (it may be another's)", () => {
    const windows = [
      { id: "826D", title: "claude agents", cwd: "/code/lacy-platform" },
      { id: "9A9A", title: "✳ Claude Code", cwd: "/code/lacy-platform" },
    ];
    assert.deepEqual(matchWindow(LACY, windows, 1), { place: null, mapping: "ambiguous" });
  });
  test("its own title still wins over an agents list elsewhere in the folder", () => {
    const windows = [
      { id: "826D", title: "claude agents", cwd: "/code/lacy-platform" },
      { id: "9A9A", title: "✳ Lacy", cwd: "/code/lacy-platform" },
    ];
    assert.deepEqual(matchWindow(LACY, windows, 2), { place: at("9A9A"), mapping: "title" });
  });
  test("a session can't be called 'claude agents' by accident: only Claude Code's own wording", () => {
    const windows = [{ id: "w1", title: "✳ claude agents rework", cwd: "/code/lacy-platform" }];
    assert.deepEqual(matchWindow(LACY, windows, 1), { place: at("w1"), mapping: "only" });
  });
});

describe("the desktop app: no adapter types into it (that took the clipboard)", () => {
  test("no adapter is the desktop app's", () => {
    assert.deepEqual(
      terminals.map((t) => t.id).filter((id) => /desktop/.test(id)),
      [],
    );
  });
});

describe("findPlaces: the first adapter that reaches a session", () => {
  const fake = (id: string, found: Record<string, Found>): Terminal => ({
    id,
    label: null,
    find: async (sessions) => {
      await sessions;
      return new Map(Object.entries(found));
    },
    type: async () => ({ sent: true }),
  });
  const listed = Promise.resolve([session({ sessionId: "a" }), session({ sessionId: "b" }), session({ sessionId: "c" })]);

  test("in order; a later one only for sessions the earlier ones couldn't reach", async () => {
    const first = fake("first", { a: { place: { via: "first", id: "1", keys: true }, mapping: "title" }, b: { place: null, mapping: "none" } });
    const second = fake("second", { a: { place: { via: "second", id: "2", keys: true }, mapping: "title" }, b: { place: { via: "second", id: "3", keys: true }, mapping: "only" } });
    const placeOf = await findPlaces(listed, [first, second]);
    assert.equal(placeOf("a").place?.via, "first");
    assert.deepEqual(placeOf("b"), { place: { via: "second", id: "3", keys: true }, mapping: "only" });
  });
  test("none reaches it: nowhere, or ambiguous if any saw several windows that could be it", async () => {
    const first = fake("first", { a: { place: null, mapping: "ambiguous" } });
    const second = fake("second", { a: { place: null, mapping: "none" } });
    const placeOf = await findPlaces(listed, [first, second]);
    assert.deepEqual(placeOf("a"), { place: null, mapping: "ambiguous" });
    assert.deepEqual(placeOf("c"), { place: null, mapping: "none" });
  });
  test("an earlier adapter's ambiguous stands: a later one's guess never overrides it", async () => {
    const first = fake("first", { a: { place: null, mapping: "ambiguous" } });
    const second = fake("second", { a: { place: { via: "second", id: "w1", keys: true }, mapping: "only" } });
    const placeOf = await findPlaces(listed, [first, second]);
    assert.deepEqual(placeOf("a"), { place: null, mapping: "ambiguous" });
  });
  test("agents (its window shows Claude Code's agents list) says more than another's none, and stands", async () => {
    const tmux = fake("tmux", { a: { place: null, mapping: "none" }, b: { place: null, mapping: "agents" } });
    const ghostty = fake("ghostty", { a: { place: null, mapping: "agents" }, b: { place: { via: "ghostty", id: "w1", keys: true }, mapping: "only" } });
    const placeOf = await findPlaces(listed, [tmux, ghostty]);
    assert.deepEqual(placeOf("a"), { place: null, mapping: "agents" });
    assert.deepEqual(placeOf("b"), { place: null, mapping: "agents" });
  });
});
