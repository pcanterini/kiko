// The Kiko window's layout (src/terminals/tmux/window.ts) on a pretend tmux (tests/support/
// fake-tmux.ts): made once (a second `kiko` only looks), sessions shown and switched by moving
// their own panes (never new ones), the one shown before back home, an ended session put away, a
// home that's gone made again, closing it with every session still running; and never an
// environment value on a tmux command line. The real tmux is in tests/live/terminals/window-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { envLaunch, WINDOW, type Launch } from "../../../src/terminals/tmux/tmux.ts";
import {
  BAR,
  closeSession,
  closeWindow,
  MENU,
  MENU_DATA,
  setBar,
  setLabel,
  createCommands,
  describe as layoutOf,
  DIED_HOOK,
  HOME,
  LABEL,
  latestClient,
  listWidth,
  openWindow,
  parseLayout,
  PLACEHOLDER,
  ROLE,
  selectKeys,
  show,
  tidy,
  VIEW,
  PLACE,
  setPlace,
  view as viewOf,
  VIEWER,
  VIEWER_INFO,
  viewerCommand,
  VIEWING,
  viewOptions,
} from "../../../src/terminals/tmux/window.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";

const APP = ["/bin/sh", "-c", "the app"];
const app = (): Launch => ({ argv: APP, discard: () => {} });

/** A window and two sessions, pixie and lacy, each in a tmux session of its own. */
async function setup() {
  const t = new FakeTmux();
  await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 });
  const pixie = (await t.run(["new-session", "-d", "-s", "pixie", "-c", "/code/pixie", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
  const lacy = (await t.run(["new-session", "-d", "-s", "lacy", "-c", "/code/lacy", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
  return { t, pixie, lacy, view: () => t.panesOf(WINDOW) };
}

describe("making the window", () => {
  test("one tmux run: the stage's placeholder, the app's list on its left (focused), the look, the bar, the hook, Ctrl+Space's menu", async () => {
    const t = new FakeTmux();
    assert.equal(await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 }), "created");
    const [list, stage] = t.panesOf(WINDOW);
    assert.deepEqual(t.panes.get(list)!.command, APP);
    assert.equal(t.panes.get(list)!.opts[ROLE], "list");
    assert.equal(t.panes.get(list)!.width, listWidth(120));
    assert.deepEqual(t.panes.get(stage)!.command.slice(0, 2), ["/bin/sh", PLACEHOLDER]);
    assert.equal(t.panes.get(stage)!.opts[ROLE], "placeholder");
    const w = t.windows.get(t.panes.get(list)!.window)!;
    assert.equal(w.active, list);
    assert.equal(w.opts[VIEW], "1");
    assert.equal(w.opts["remain-on-exit"], "on");
    assert.equal(t.sessions.get(WINDOW)!.opts.status, "on");
    assert.equal(t.sessions.get(WINDOW)!.opts[BAR], "Kiko Dev is starting…");
    assert.deepEqual(t.hooks[0], ["pane-died", DIED_HOOK]);
    // Ctrl+Space: the menu kept in the window's option, for the terminal that pressed it; elsewhere passed on. F1 (an older window's) gone.
    assert.deepEqual(t.bindings[0], ["if-shell", "-F", `#{${VIEW}}`, `run-shell -C '#{${MENU}}'`, "send-keys 'C-Space'"]);
    // The ☰ button: the same menu, from a click on its range of the bottom line; any other status click as tmux does it.
    assert.deepEqual(t.bindings[1], ["if-shell", "-F", `#{&&:#{${VIEW}},#{==:#{mouse_status_range},menu}}`, `run-shell -C '#{${MENU}}'`, "switch-client -t ="]);
    assert.deepEqual(t.bindings[2].slice(0, 3), ["if-shell", "-F", `#{${VIEW}}`]);
    assert.match(t.sessions.get(WINDOW)!.opts["status-format[0]"], /#\[range=user\|menu\][^\n]* ☰ Kiko Dev #\[norange/);
    // Which key it is, for the app and the placeholder; herdr's variables gone from the server.
    assert.equal(t.global["@kiko-key"], "C-Space");
    assert.equal(t.global["@kiko-key-name"], "⌃Space");
    assert.ok(
      t.calls.some((c) => c.join(" ").includes("set-environment -g -u HERDR_PANE_ID")),
      "HERDR_PANE_ID unset",
    );
    const made = t.calls.find((c) => c[0] === "new-session")!.join(" ");
    assert.ok(made.includes("bind-key -n C-Space") && made.includes("bind-key -n MouseDown1Status") && made.includes("bind-key -n MouseDragEnd1Border"), made);
    assert.deepEqual(t.unbound[0], ["-q", "-n", "F1"]);
    assert.deepEqual(FakeTmux.words(w.opts[MENU]).slice(0, 1), ["display-popup"]);
    assert.ok(JSON.parse(w.opts[MENU_DATA]).items[0].label.includes("Kiko Dev is starting…"));
    // The first call made it all (new-session … ; …): another client's commands can't come in between.
    assert.equal(t.calls.filter((c) => c[0] === "new-session").length, 1);
    assert.ok(t.calls.find((c) => c[0] === "new-session")!.includes("split-window"));
  });

  test("tmux not answering when the key is read: an error, never the default key bound over the one you set (B10)", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 }, { key: "C-\\", by: "setting" });
    assert.equal(t.global["@kiko-key"], "C-\\");
    // Opened again without a key (a session opened by voice), the key's option read timing out.
    const slow = (args: string[], input?: string) => (args[0] === "show-options" && args.includes("@kiko-key") ? Promise.reject(new Error("tmux didn't answer")) : t.run(args, input));
    await assert.rejects(openWindow(slow, app, "/code/kiko"), /didn't answer/);
    assert.equal(t.global["@kiko-key"], "C-\\", "the key as it was");
    assert.equal(t.global["@kiko-key-by"], "setting");
    // No server yet (the read before the window is made): no key set, so the default.
    const fresh = new FakeTmux();
    const none = (args: string[], input?: string) => (args[0] === "show-options" ? Promise.reject(new Error("no server running on /tmp/x")) : fresh.run(args, input));
    assert.equal(await openWindow(none, app, "/code/kiko", { width: 120, height: 40 }), "created");
    assert.equal(fresh.global["@kiko-key"], "C-Space");
  });

  test("`whole` (the splash coming): the list's pane zoomed to the whole window in the same run that makes it, before any terminal attaches; a window there already is left as it is", async () => {
    const t = new FakeTmux();
    assert.equal(await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 }, undefined, true), "created");
    const [list] = t.panesOf(WINDOW);
    const w = t.windows.get(t.panes.get(list)!.window)!;
    assert.equal(w.zoomed, true);
    assert.equal(w.active, list, "the list zoomed, not the stage");
    // One run: no moment where the window is there but not yet zoomed.
    const made = t.calls.filter((c) => c[0] === "new-session");
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].slice(-4), ["resize-pane", "-Z", "-t", `=${WINDOW}:`]);
    // Not asked: as ever. Asked of a window that's there: nothing zoomed (it may be on screen already).
    const plain = new FakeTmux();
    await openWindow(plain.run, app, "/code/kiko", { width: 120, height: 40 });
    assert.equal([...plain.windows.values()][0].zoomed, false);
    assert.equal(await openWindow(plain.run, app, "/code/kiko", { width: 120, height: 40 }, undefined, true), "open");
    assert.equal([...plain.windows.values()][0].zoomed, false);
    assert.ok(!plain.calls.some((c) => c.includes("resize-pane") && c.includes("-Z")));
  });

  test("a second `kiko` only looks: the same window, its bar kept, nothing started", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, app, "/code/kiko");
    await t.run(["set-option", "-t", `=${WINDOW}:`, BAR, "Kiko is ready"]);
    let launched = 0;
    assert.equal(await openWindow(t.run, () => (launched++, app()), "/code/kiko"), "open");
    assert.equal(launched, 0);
    assert.equal(t.panesOf(WINDOW).length, 2);
    assert.equal(t.sessions.get(WINDOW)!.opts[BAR], "Kiko is ready");
  });

  test("two at once: the one that loses (duplicate session) throws its launch away and uses the other's", async () => {
    const t = new FakeTmux();
    let discarded = 0;
    const racing = async (args: string[]) => {
      if (args[0] === "new-session" && !t.sessions.has(WINDOW)) {
        await t.run(createCommands(APP, "/code/kiko")); // the other `kiko`, a moment sooner
      }
      return t.run(args);
    };
    assert.equal(await openWindow(racing, () => ({ argv: APP, discard: () => void discarded++ }), "/code/kiko"), "open");
    assert.equal(discarded, 1);
    assert.equal(t.panesOf(WINDOW).length, 2);
  });

  test("its app ended (quit, or crashed): started again in the same pane", async () => {
    const { t, view } = await setup();
    const [list] = view();
    t.end(list);
    assert.equal(t.panes.get(list)!.dead, true);
    assert.equal(await openWindow(t.run, app, "/code/kiko"), "restarted");
    assert.equal(t.panes.get(list)!.dead, false);
    assert.equal(t.panes.get(list)!.starts, 2);
  });
});

describe("showing sessions", () => {
  test("shown: its own pane moves into the stage, focused; the placeholder keeps its place at home", async () => {
    const { t, pixie, view } = await setup();
    const placeholder = view()[1];
    assert.equal(await show(t.run, pixie), "shown");
    assert.deepEqual(view(), [view()[0], pixie]);
    assert.equal(t.where(placeholder), "pixie");
    assert.equal(t.panes.get(pixie)!.opts[HOME], t.windows.get(t.panes.get(placeholder)!.window)!.id);
    assert.equal(t.panes.get(pixie)!.opts[LABEL], "pixie");
    assert.equal(t.windows.get(t.panes.get(pixie)!.window)!.active, pixie);
    assert.equal(t.panes.get(placeholder)!.starts, 2, "restarted where it is now, to say so");
    assert.equal(await show(t.run, pixie), "already");
  });

  test("another: the one shown goes back to its own tmux session; only two panes ever move", async () => {
    const { t, pixie, lacy, view } = await setup();
    await show(t.run, pixie);
    await show(t.run, lacy);
    assert.equal(view()[1], lacy);
    assert.equal(t.where(pixie), "pixie");
    assert.equal(t.panesOf("pixie").length, 1);
    assert.equal(t.panes.get(t.panesOf("lacy")[0])!.opts[ROLE], "placeholder");
    await show(t.run, pixie);
    assert.equal(view()[1], pixie);
    assert.equal(t.where(lacy), "lacy");
    assert.equal(t.panes.size, 4, "list, placeholder, pixie, lacy: nothing made or lost");
  });

  test("the session shown ends: its home's placeholder comes back, and its tmux session goes", async () => {
    const { t, pixie, view } = await setup();
    await show(t.run, pixie);
    t.end(pixie); // what DIED_HOOK does in tmux, tidy does too (the hook is checked live)
    await tidy(t.run);
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "placeholder");
    assert.equal(t.sessions.has("pixie"), false);
    assert.equal(t.panes.has(pixie), false);
  });

  test("its home was closed meanwhile: made again (a tmux session of its name) when it has to go back", async () => {
    const { t, pixie, lacy, view } = await setup();
    await show(t.run, pixie);
    await t.run(["kill-session", "-t", "=pixie"]); // took the placeholder with it
    await t.run(["set-option", "-p", "-t", pixie, LABEL, "Pixie API"]);
    assert.equal(await show(t.run, lacy), "shown");
    assert.equal(view()[1], lacy);
    assert.equal(t.where(pixie), "Pixie-API");
  });

  test('a folder ending in ";" (tmux\'s command separator): its home made again there all the same', async () => {
    const { t, lacy, view } = await setup();
    const semi = (await t.run(["new-session", "-d", "-s", "semi", "-c", "/code/semi\\;", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    assert.equal(t.panes.get(semi)!.cwd, "/code/semi;");
    await show(t.run, semi);
    await t.run(["kill-session", "-t", "=semi"]);
    await setLabel(t.run, semi, "fix it;");
    assert.equal(t.panes.get(semi)!.opts[LABEL], "fix it;");
    assert.equal(await show(t.run, lacy), "shown");
    assert.equal(view()[1], lacy);
    const home = t.windows.get(t.panes.get(semi)!.window)!;
    assert.equal(t.panes.get(home.panes.find((p) => p !== semi) ?? semi)!.cwd, "/code/semi;");
  });

  test("two shows at once (two quick clicks): one after the other; every session in its own place, nothing ended", async () => {
    const { t, pixie, lacy, view } = await setup();
    const placeholder = view()[1];
    await Promise.all([show(t.run, pixie), show(t.run, lacy), show(t.run, pixie)]);
    assert.equal(view()[1], pixie, "the last asked for");
    assert.equal(t.where(lacy), "lacy", "lacy back in its own tmux session");
    assert.deepEqual(t.panesOf("lacy"), [lacy]);
    assert.deepEqual(t.panesOf("pixie"), [placeholder], "pixie's home holds only the placeholder");
    assert.equal(t.panes.get(placeholder)!.opts[ROLE], "placeholder");
    assert.ok(!t.panes.get(pixie)!.dead && !t.panes.get(lacy)!.dead);
    assert.equal(t.panes.size, 4, "nothing made or lost");
  });

  test("a show and a close at once: the other session is never killed", async () => {
    const { t, pixie, lacy } = await setup();
    await show(t.run, pixie);
    await Promise.all([show(t.run, lacy), closeSession(t.run, pixie), show(t.run, pixie)]);
    assert.equal(t.panes.has(pixie), false, "pixie closed");
    assert.ok(t.panes.has(lacy) && !t.panes.get(lacy)!.dead, "lacy runs on");
  });

  test("an ended session whose home holds a live session (a mix-up): that session is never respawned", async () => {
    const { t, pixie, lacy, view } = await setup();
    await show(t.run, pixie);
    // lacy ends up in pixie's home window, as a race once could leave it.
    const home = t.panes.get(pixie)!.opts[HOME];
    const placeholder = t.windows.get(home)!.panes[0];
    await t.run(["swap-pane", "-d", "-s", lacy, "-t", placeholder]);
    const starts = t.panes.get(lacy)!.starts;
    t.end(pixie);
    await tidy(t.run);
    assert.equal(t.panes.get(lacy)!.starts, starts, "lacy not restarted");
    assert.equal(t.panes.get(lacy)!.dead, false);
    assert.equal(t.panes.has(pixie), false, "the ended one closed");
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "placeholder", "a fresh placeholder in the stage");
  });

  test('a folder with "#" in its name (a format to tmux in -c): its home made again there all the same', async () => {
    const { t, lacy, view } = await setup();
    const hash = (await t.run(["new-session", "-d", "-s", "hash", "-c", "/code/C##Samples", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
    await show(t.run, hash);
    await t.run(["kill-session", "-t", "=hash"]);
    assert.equal(await show(t.run, lacy), "shown", "the fake refuses a lone # in -c");
    assert.equal(view()[1], lacy);
    const home = t.windows.get(t.panes.get(hash)!.window)!;
    assert.equal(t.panes.get(home.panes.find((p) => p !== hash) ?? hash)!.cwd, "/code/C#Samples");
  });

  test("nothing to show: the list itself, a pane gone, no window", async () => {
    const { t, view } = await setup();
    assert.equal(await show(t.run, view()[0]), "not a session");
    assert.equal(await show(t.run, "%99"), "gone");
    assert.equal(await show(new FakeTmux().run, "%1"), "no window");
  });

  test("an empty stage (its pane closed by hand) gets a placeholder again", async () => {
    const { t, view } = await setup();
    await t.run(["kill-pane", "-t", view()[1]]);
    assert.equal(view().length, 1);
    await tidy(t.run);
    assert.equal(view().length, 2);
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "placeholder");
  });
});

describe("selecting a viewer's text (selectKeys)", () => {
  /** Each binding of `key` in a run's words: what it runs, up to the next command. */
  const bound = (words: string[], key: string) =>
    words.flatMap((w, i) => (w === key && words[i - 1] === "-n" && words[i - 2] === "bind-key" ? [words.slice(i + 1, words.indexOf(";", i) < 0 ? undefined : words.indexOf(";", i))] : []));
  /** A command string's commands (" ; " between them, as commandString joins them), each as its words. */
  const commands = (line: string) => line.split(" ; ").map(FakeTmux.words);
  const TO_PROGRAM = `#{||:#{pane_in_mode},#{&&:#{mouse_any_flag},#{!=:#{${ROLE}},viewer}}}`;

  test("a drag, a double and a triple click: tmux's own, but a viewer's pane is taken as one that doesn't ask for the mouse; copied by copy-command", () => {
    const keys = selectKeys();
    assert.deepEqual(keys[0], ["set-option", "-s", "copy-command", "pbcopy"]);
    // The drag: tmux's MouseDrag1Pane (`send-keys -M` when the program wants the mouse, else copy mode), the role first.
    assert.deepEqual(keys[1], ["bind-key", "-n", "MouseDrag1Pane", "if-shell", "-F", "-t", "=", TO_PROGRAM, "send-keys -M", "copy-mode -M"]);
    for (const [at, key, select] of [
      [2, "DoubleClick1Pane", "select-word"],
      [3, "TripleClick1Pane", "select-line"],
    ] as const) {
      const k = keys[at];
      assert.deepEqual(k.slice(0, 8), ["bind-key", "-n", key, "if-shell", "-F", "-t", "=", TO_PROGRAM]);
      assert.deepEqual(commands(k[8]), [
        ["select-pane", "-t", "="],
        ["send-keys", "-M"],
      ]);
      assert.deepEqual(commands(k[9]), [
        ["select-pane", "-t", "="],
        ["copy-mode", "-H"],
        ["send-keys", "-X", select],
        ["run-shell", "-d", "0.3"],
        ["send-keys", "-X", "copy-pipe-and-cancel"],
      ]);
      assert.equal(k.length, 10);
    }
    assert.equal(keys.length, 4);
  });

  test("set as the window's made, in either look, and again when a window made by an older version opens", async () => {
    for (const classic of [false, true]) {
      const made = createCommands(APP, "/code/kiko", { width: 120, height: 40 }, undefined, classic);
      assert.deepEqual(bound(made, "MouseDrag1Pane"), [selectKeys()[1].slice(3)]);
      assert.equal(bound(made, "DoubleClick1Pane").length, 1);
      assert.equal(bound(made, "TripleClick1Pane").length, 1);
      assert.ok(made.join(" ").includes("set-option -s copy-command pbcopy"));
    }
    const t = new FakeTmux();
    await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 });
    const before = t.calls.length;
    t.global["copy-command"] = "";
    assert.equal(await openWindow(t.run, app, "/code/kiko"), "open");
    const again = t.calls.slice(before).flat();
    assert.deepEqual(bound(again, "MouseDrag1Pane"), [selectKeys()[1].slice(3)]);
    assert.equal(bound(again, "DoubleClick1Pane").length, 1);
    assert.equal(t.global["copy-command"], "pbcopy");
  });
});

describe("an outside session's conversation (a viewer)", () => {
  const notes = { id: "session:notes-id", path: "/home/.claude/projects/-code-notes/notes-id.jsonl", name: "notes", info: '{"name":"notes","status":"idle"}' };

  test("in the stage's spot: a viewer of its transcript (only the path on its command line), named, focused", async () => {
    const { t, view } = await setup();
    const spot = view()[1];
    assert.equal(await viewOf(t.run, notes), "shown");
    const p = t.panes.get(spot)!;
    assert.deepEqual(view(), [view()[0], spot], "the same pane: nothing made");
    assert.deepEqual(p.command, viewerCommand(notes.path));
    assert.deepEqual(p.command.slice(1), [VIEWER, p.command[2], notes.path]);
    assert.equal(p.opts[ROLE], "viewer");
    assert.equal(p.opts[VIEWING], "session:notes-id");
    assert.equal(p.opts[VIEWER_INFO], notes.info);
    assert.equal(p.opts[LABEL], "notes");
    assert.equal(t.windows.get(p.window)!.active, spot);
    const layout = await layoutOf(t.run);
    assert.equal(layout.view!.stage!.role, "viewer");
    assert.equal(layout.view!.stage!.viewing, "session:notes-id");
  });

  test("over a session shown: the session goes home first, its home's placeholder becomes the viewer", async () => {
    const { t, pixie, view } = await setup();
    await show(t.run, pixie);
    await viewOf(t.run, notes);
    assert.equal(t.where(pixie), "pixie");
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "viewer");
    assert.equal(t.panes.size, 4, "list, viewer, pixie, lacy: nothing made");
  });

  test("again: only its header; another outside session: the same pane, its transcript", async () => {
    const { t, view } = await setup();
    await viewOf(t.run, notes);
    const spot = view()[1];
    const starts = t.panes.get(spot)!.starts;
    assert.equal(await viewOf(t.run, { ...notes, info: '{"status":"working"}' }), "already");
    assert.equal(t.panes.get(spot)!.starts, starts, "not restarted");
    assert.equal(t.panes.get(spot)!.opts[VIEWER_INFO], '{"status":"working"}');
    await viewOf(t.run, { id: "session:job", path: "/p/job.jsonl", name: "job", info: "{}" });
    assert.equal(view()[1], spot);
    assert.equal(t.panes.get(spot)!.opts[VIEWING], "session:job");
    assert.equal(t.panes.get(spot)!.command.at(-1), "/p/job.jsonl");
  });

  test("a session shown after it: the viewer goes to that session's home as a placeholder again", async () => {
    const { t, pixie, view } = await setup();
    await viewOf(t.run, notes);
    const viewer = view()[1];
    assert.equal(await show(t.run, pixie), "shown");
    assert.equal(view()[1], pixie);
    assert.equal(t.where(viewer), "pixie");
    const p = t.panes.get(viewer)!;
    assert.equal(p.opts[ROLE], "placeholder");
    assert.equal(p.opts[VIEWING], undefined);
    assert.equal(p.opts[VIEWER_INFO], undefined);
    assert.deepEqual(p.command.slice(0, 2), ["/bin/sh", PLACEHOLDER]);
    assert.equal(t.panes.size, 4);
  });

  test('the tiled look\'s border: the name, and for an outside session where it runs, dimmed ("notes · in Ghostty"); a session of ours, its name alone', async () => {
    const { t, pixie, view } = await setup();
    const border = viewOptions(false)
      .find((o) => o[4] === "pane-border-format")!
      .at(-1)!;
    const drawn = async (pane: string) => (await t.run(["display", "-p", "-t", pane, border])).replace(/\n$/, "").replace(/#\[[^\]]*\]/g, "");
    await viewOf(t.run, { ...notes, place: "in Ghostty" });
    const spot = view()[1];
    assert.equal(t.panes.get(spot)!.opts[PLACE], "in Ghostty");
    assert.equal(await drawn(spot), "notes · in Ghostty");
    assert.match(await t.run(["display", "-p", "-t", spot, border]), /notes#\[nobold,dim\] · in Ghostty/);
    // Kept to where it runs by the app; none taken off.
    await setPlace(t.run, spot, "in the background");
    assert.equal(await drawn(spot), "notes · in the background");
    await setPlace(t.run, spot);
    assert.equal(await drawn(spot), "notes");
    await setPlace(t.run, spot, "in Ghostty");
    await show(t.run, pixie);
    assert.equal(await drawn(pixie), "pixie");
    assert.equal(t.panes.get(spot)!.opts[PLACE], undefined, "the placeholder it became keeps none");
  });

  test("a viewer that ended (it never should) is put right: a placeholder again", async () => {
    const { t, view } = await setup();
    await viewOf(t.run, notes);
    t.end(view()[1]);
    await tidy(t.run);
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "placeholder");
    assert.equal(t.panes.get(view()[1])!.dead, false);
  });

  test("no window: nothing; closing the window takes the viewer with it, sessions run on", async () => {
    assert.equal(await viewOf(new FakeTmux().run, notes), "no window");
    const { t, lacy } = await setup();
    await viewOf(t.run, notes);
    await closeWindow(t.run);
    assert.equal(t.sessions.has(WINDOW), false);
    assert.equal(t.where(lacy), "lacy");
  });
});

describe("closing it", () => {
  test("the session shown goes home first; the window's tmux session ends; every session runs on", async () => {
    const { t, pixie, lacy } = await setup();
    await show(t.run, pixie);
    await closeWindow(t.run);
    assert.equal(t.sessions.has(WINDOW), false);
    assert.equal(t.where(pixie), "pixie");
    assert.equal(t.where(lacy), "lacy");
    assert.equal((await layoutOf(t.run)).view, null);
  });
});

describe("closing a session", () => {
  test("shown: it goes home first (the placeholder back in the stage), then its own tmux session ends; never the window's", async () => {
    const { t, pixie, lacy, view } = await setup();
    await show(t.run, pixie);
    assert.equal(await closeSession(t.run, pixie), "closed");
    assert.equal(t.sessions.has("pixie"), false);
    assert.equal(t.panes.has(pixie), false);
    assert.equal(t.panes.get(view()[1])!.opts[ROLE], "placeholder");
    assert.equal(await closeSession(t.run, lacy), "closed", "one not shown: its session ends");
    assert.equal(t.sessions.has("lacy"), false);
    assert.equal(await closeSession(t.run, view()[0]), "not a session", "the list");
    assert.equal(await closeSession(t.run, "%99"), "gone");
    assert.equal(t.sessions.has(WINDOW), true);
  });
});

describe("the bottom line", () => {
  test("set over stdin, never on a command line: quotes, $, ;, #( and line breaks arrive as text", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, app, "/code/kiko");
    const said = "it's $HOME; rm x #(touch y) ~ \\ back\nnext line";
    await setBar(t.run, said);
    assert.equal(t.sessions.get(WINDOW)!.opts[BAR], "it's $HOME; rm x #(touch y) ~ \\ back next line");
    const call = t.inputs.at(-1)!;
    assert.deepEqual(call.args, ["source-file", "-"]);
    assert.equal(call.input.split("\n").filter(Boolean).length, 1, "one command, whatever was said");
    for (const argv of t.calls) assert.ok(!argv.join(" ").includes("HOME"), `the words on a command line: ${argv.join(" ")}`);
  });
});

describe("closing it, when the session can't go home", () => {
  test("its going home fails: the window stays open, the session in it still running, and why", async () => {
    const { t, pixie, view } = await setup();
    await show(t.run, pixie);
    const failing = async (args: string[], input?: string) => {
      if (args[0] === "swap-pane") throw new Error("swap-pane: no space for new pane");
      return t.run(args, input);
    };
    await assert.rejects(closeWindow(failing), /pixie couldn't go back to its own tmux session, so the window stays open: swap-pane: no space/);
    assert.equal(t.sessions.has(WINDOW), true);
    assert.equal(view()[1], pixie);
    assert.equal(t.panes.get(pixie)!.dead, false);
  });
  test("a home left holding only a placeholder is closed with the window", async () => {
    const { t, pixie, lacy } = await setup();
    await show(t.run, pixie);
    // A placeholder-only session (a home whose session went elsewhere and ended): nothing to come back to it.
    await t.run(["new-session", "-d", "-s", "orphan", "--", "/bin/sh", "placeholder"]);
    await t.run(["set-option", "-p", "-t", "=orphan:", ROLE, "placeholder"]);
    await closeWindow(t.run);
    assert.equal(t.sessions.has("orphan"), false);
    assert.equal(t.where(pixie), "pixie");
    assert.equal(t.where(lacy), "lacy");
  });
});

describe("the layout as read back", () => {
  test("lines of another shape (the adapter's format, say) aren't taken for the window", () => {
    assert.deepEqual(parseLayout("%1\t100\t/dev/ttys001\t0\t0\t1\tpixie\t/code"), { panes: [], view: null });
  });
  test("the list's width: a quarter of the window, 24 to 40 columns", () => {
    assert.deepEqual(
      [60, 120, 200].map((w) => listWidth(w)),
      [24, 30, 40],
    );
  });
  test("the list's width as you dragged it: kept, at least 16, at most half the window; read back from the window", () => {
    assert.deepEqual([listWidth(120, 50), listWidth(120, 10), listWidth(120, 90)], [50, 16, 60]);
    const line = ["W", "%1", "@1", WINDOW, "0", "list", "", "1", "0", "120", "50", "40", "1", "1", "Kiko", "", "50", "40", "", "/code"].join("\t");
    assert.equal(parseLayout(line).view?.listWidth, 50);
  });
});

describe("the environment never goes on a command line", () => {
  test("the app the window starts gets yours through a private file: no value in any tmux argv", async (t) => {
    // A made-up environment, never this process's own: a launch writes what it's given to a file.
    const secret = "sk-ant-this-is-not-a-real-key-4242";
    const env = { HOME: "/home/nobody", PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: secret, GITHUB_TOKEN: `${secret}-gh` };
    const launches: Launch[] = [];
    const launch = (cwd: string, program: string, args: string[]) => {
      const l = envLaunch(env, cwd, program, args);
      launches.push(l);
      return l;
    };
    t.after(() => launches.forEach((l) => l.discard()));
    const t2 = new FakeTmux();
    const app = () => launch("/code/kiko", process.execPath, ["start.ts", "--window"]);
    await openWindow(t2.run, app, "/code/kiko");
    const [list] = t2.panesOf(WINDOW);
    t2.end(list);
    await openWindow(t2.run, app, "/code/kiko"); // restarted: a second launch
    const pixie = (await t2.run(["new-session", "-d", "-s", "pixie", "-P", "-F", "#{pane_id}", "--", ...launch("/code/pixie", "/bin/claude", []).argv])).trim();
    await show(t2.run, pixie);
    await viewOf(t2.run, { id: "session:notes", path: "/p/notes.jsonl", name: "notes", info: "{}" }); // an outside one's viewer too
    await closeWindow(t2.run);
    assert.equal(launches.length, 3);
    for (const argv of t2.calls) for (const arg of argv) assert.ok(!arg.includes(secret), `a secret in: ${argv.join(" ")}`);
    for (const l of launches) {
      l.discard();
      assert.equal(existsSync(l.argv[5]!), false, "the file is gone once discarded");
    }
  });
});

describe("new sessions by voice, with the window open", () => {
  test("shown in the window, not a window of their own; one more terminal only when none shows the window", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, app, "/code/kiko");
    const opened: Array<{ cwd: string; session: string }> = [];
    const terminal = tmuxTerminal({
      tmux: t.run,
      ps: async () => [],
      show: async (cwd, session) => void opened.push({ cwd, session }),
      wait: async () => {},
      installed: () => true,
      shell: "/bin/zsh",
    });
    assert.equal(await terminal.open!("/code/tideline", { program: "claude", args: [] }), undefined);
    const stage = t.panesOf(WINDOW)[1];
    assert.equal(t.panes.get(stage)!.cwd, "/code/tideline");
    assert.equal(t.panes.get(stage)!.opts[LABEL], "tideline");
    assert.deepEqual(opened, [{ cwd: "/code/tideline", session: WINDOW }], "no terminal showed the window: one does now");
    t.sessions.get(WINDOW)!.clients = 1;
    await terminal.open!("/code/pixie", { program: "claude", args: [] });
    assert.equal(opened.length, 1, "the window is on screen already");
    assert.equal(t.panes.get(t.panesOf(WINDOW)[1])!.cwd, "/code/pixie");
  });
  test("without the window: a window of their own, as before", async () => {
    const t = new FakeTmux();
    const opened: Array<{ cwd: string; session: string }> = [];
    const terminal = tmuxTerminal({
      tmux: t.run,
      ps: async () => [],
      show: async (cwd, session) => void opened.push({ cwd, session }),
      wait: async () => {},
      installed: () => true,
      shell: "/bin/zsh",
    });
    await terminal.open!("/code/tideline", { program: "claude", args: [] });
    assert.deepEqual(opened, [{ cwd: "/code/tideline", session: "tideline" }]);
  });
});

describe("latestClient: the terminal for a menu the app shows itself", () => {
  // list-clients' answer: when each was created (or last used), in seconds, and its tty.
  const clients = (rows: [number, string][]) => async (args: string[]) => (args[0] === "list-clients" ? rows.map(([t, n]) => `${t}\t${n}\n`).join("") : "");
  const tmux = clients([
    [1_793_520_000, "/dev/ttys001"],
    [1_793_520_100, "/dev/ttys002"],
  ]);

  test("the one attached last (newest), or only one attached since a time (a key clash's question: its kiko's terminal)", async () => {
    assert.equal(await latestClient(tmux, true), "/dev/ttys002");
    // Asked at …100.5 s: the terminal attached in that second counts (tmux keeps it to the second).
    assert.equal(await latestClient(tmux, true, 1_793_520_100_500), "/dev/ttys002");
    // Asked after both were attached: none yet (the one that asked hasn't attached).
    assert.equal(await latestClient(tmux, true, 1_793_520_101_000), null);
  });
});
