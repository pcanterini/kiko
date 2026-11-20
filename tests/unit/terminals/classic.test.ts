// The Kiko window's classic look (src/terminals/tmux/classic.ts, window.ts) on a pretend tmux
// (tests/support/fake-tmux.ts) that says it's 3.8: the frame under two floating boxes, their titles
// and border colours following the keyboard, the boxes placed for the window's size, sessions still
// swapped into the stage's box, the caption made and gone, the voice glow's borderless band under
// it made, placed and gone (and none in a window too small); and on an older tmux the tiled look,
// unchanged. The real tmux is in tests/live/terminals/classic-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WINDOW, type Launch } from "../../../src/terminals/tmux/tmux.ts";
import {
  BAR,
  CLASSIC_TITLE,
  closeCaption,
  closeGlow,
  describe as layoutOf,
  DRAG_TABLE,
  DRAGGING,
  FRAME,
  LABEL,
  LIST_WIDTH,
  MARK,
  markFormat,
  openCaption,
  openGlow,
  openWindow,
  place,
  ROLE,
  show,
  sizeCaption,
  splitHook,
  tidy,
  PLACE,
  view as viewOf,
  VIEW,
} from "../../../src/terminals/tmux/window.ts";
import {
  boxes,
  captionBox,
  CAPTION_TITLE,
  classicLook,
  draggedFormat,
  FOCUS_BORDER,
  LOOK,
  parseVersion,
  placeCommands,
  placeFormat,
  REST_BORDER,
  TITLE,
  TITLE_REST,
  floats,
  GLOW_MIN_COLS,
  GLOW_MIN_ROWS,
  GLOW_TITLE,
  glowBox,
} from "../../../src/terminals/tmux/classic.ts";
import { GLOW_COLS } from "../../../src/ui/dither-glow.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";

const APP = ["/bin/sh", "-c", "the app"];
const app = (): Launch => ({ argv: APP, discard: () => {} });

/** A classic window (tmux 3.8) 160 by 45, and a session, pixie, in a tmux session of its own. */
async function setup(version = "tmux 3.8") {
  const t = new FakeTmux();
  t.version = version;
  await openWindow(t.run, app, "/code/kiko", { width: 160, height: 45 });
  const pixie = (await t.run(["new-session", "-d", "-s", "pixie", "-c", "/code/pixie", "-P", "-F", "#{pane_id}", "--", "claude"])).trim();
  return { t, pixie, view: async () => (await layoutOf(t.run)).view! };
}

/** A pane's box as the fake keeps it. */
const box = (t: FakeTmux, pane: string) => t.panes.get(pane)!.floating;
/** The title tmux would draw on `pane`'s border (CLASSIC_TITLE expanded for it), its styles kept. */
const title = (t: FakeTmux, pane: string) => t.run(["display", "-p", "-t", pane, CLASSIC_TITLE]).then((s) => s.replace(/\n$/, ""));

describe("which look", () => {
  test("tmux 3.8 and later float their panes; older ones, and an answer that isn't a version, don't", () => {
    assert.deepEqual(
      ["tmux 3.8", "tmux 3.8a", "tmux 3.10", "tmux 4.0", "tmux next-3.9"].map((v) => floats(parseVersion(v))),
      [true, true, true, true, true],
    );
    assert.deepEqual(
      ["tmux 3.7", "tmux 3.4", "tmux 2.9", "tmux master", ""].map((v) => floats(parseVersion(v))),
      [false, false, false, false, false],
    );
  });
  test("asked once for each tmux; KIKO_LOOK=tiled asks for the old look", async () => {
    const t = new FakeTmux();
    t.version = "tmux 3.8";
    assert.equal(await classicLook(t.run), true);
    assert.equal(await classicLook(t.run), true);
    assert.equal(t.calls.filter((c) => c[0] === "-V").length, 1);
    process.env.KIKO_LOOK = "tiled";
    try {
      assert.equal(await classicLook(new FakeTmux().run), false);
    } finally {
      delete process.env.KIKO_LOOK;
    }
  });
});

describe("the classic window", () => {
  test("made in one run: the frame under everything, the stage's placeholder and the list as boxes over it (the list focused), no status line", async () => {
    const { t, view } = await setup();
    const v = await view();
    assert.equal(v.look, "classic");
    const made = t.calls.filter((c) => c[0] === "new-session" && c.includes(WINDOW));
    assert.equal(made.length, 1);
    assert.ok(made[0].includes("new-pane"), "one run");
    // The frame: the window's one tiled pane, running ./frame-pane.ts and nothing else.
    assert.equal(v.frame?.role, "frame");
    assert.deepEqual(t.panes.get(v.frame!.id)!.command.slice(1, 2), [FRAME]);
    assert.equal(box(t, v.frame!.id), undefined);
    // The boxes: as the full screen sizes its panels (the list 30% of the width, 26 to 40), from the window's first line (no header) to the one above its last.
    const b = boxes(160, 45);
    assert.deepEqual(b, { list: { x: 0, y: 0, w: 40, h: 44 }, stage: { x: 40, y: 0, w: 120, h: 44 } });
    assert.deepEqual(box(t, v.list!.id), b.list);
    assert.deepEqual(box(t, v.stage!.id), b.stage);
    assert.deepEqual(t.panes.get(v.list!.id)!.command, APP);
    assert.equal(v.stage!.role, "placeholder");
    assert.equal(v.list!.active, true);
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    assert.equal(w.opts[VIEW], "1");
    assert.equal(w.opts[LOOK], "classic");
    assert.equal(w.opts["pane-border-status"], "top-floating");
    assert.equal(w.opts["pane-border-lines"], "single");
    assert.equal(t.sessions.get(WINDOW)!.opts.status, "off");
    // The window's clicks: the bottom line's menu words open the menu; the frame and the caption never take the keyboard.
    const words = made[0];
    const at = words.indexOf("MouseDown1Pane");
    assert.ok(at > 0 && words[at + 5].includes("#{@kiko-menu-at}") && words[at + 6] === "run-shell -C '#{@kiko-menu}'", JSON.stringify(words.slice(at, at + 8)));
    assert.ok(words[at + 7].endsWith('"select-pane -t = ; send-keys -M"'), words[at + 7]);
    // Its drags (the real tmux in tests/live/terminals/classic-drag-live.test.ts): a box's border still tmux's resize, the drag
    // noted first and the client put in a key table of ours for its end (over a border or a pane);
    // the boxes kept side by side as it goes by a pane-resized hook on the window.
    const binding = (from: number, key: string) => {
      const i = words.indexOf(key, from);
      return words.slice(i, words.indexOf(";", i) < 0 ? undefined : words.indexOf(";", i));
    };
    const drag = binding(0, "MouseDrag1Border");
    assert.deepEqual(words.slice(words.indexOf("MouseDrag1Border") - 2, words.indexOf("MouseDrag1Border")), ["bind-key", "-n"]);
    assert.deepEqual(drag.slice(0, 3), ["MouseDrag1Border", "if-shell", "-F"]);
    assert.ok(drag.at(-2)!.includes(`'${DRAGGING}'`) && drag.at(-2)!.includes(`'switch-client' '-T' '${DRAG_TABLE}'`) && drag.at(-2)!.endsWith("'resize-pane' '-M'"), String(drag.at(-2)));
    assert.equal(drag.at(-1), "resize-pane -M");
    const table = words.indexOf(DRAG_TABLE, words.indexOf("MouseDrag1Border") + 1);
    assert.deepEqual(words.slice(table - 2, table + 2), ["bind-key", "-T", DRAG_TABLE, "MouseDragEnd1Border"]);
    for (const key of ["MouseDragEnd1Border", "MouseDragEnd1Pane"]) assert.ok(binding(table, key).at(-1)!.includes(`'${LIST_WIDTH}'`), key);
    assert.ok(binding(0, "MouseDragEnd1Border").at(-1)!.includes(`'${LIST_WIDTH}'`));
    assert.equal(
      words.some((w, i) => w === "MouseDragEnd1Pane" && words[i - 1] === "-n"),
      false,
      "nothing of ours for a drag of another kind ending over a pane",
    );
    assert.deepEqual(
      t.hooks.find((h) => h[0] === "pane-resized"),
      ["pane-resized", splitHook()],
    );
  });

  test("`whole` (the splash coming): the list's box zoomed to the whole window in the run that makes it", async () => {
    const t = new FakeTmux();
    t.version = "tmux 3.8";
    await openWindow(t.run, app, "/code/kiko", { width: 160, height: 45 }, undefined, true);
    const view = (await layoutOf(t.run)).view!;
    assert.equal(view.look, "classic");
    assert.equal(view.zoomed, true);
    assert.equal(view.list?.active, true, "the list zoomed, not the stage");
    const made = t.calls.filter((c) => c[0] === "new-session");
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].slice(-4), ["resize-pane", "-Z", "-t", `=${WINDOW}:`]);
  });

  test("the drag's formats: the list's width kept as boxes() keeps a dragged one, both boxes placed as placeCommands places them", () => {
    assert.equal(
      draggedFormat("#{x}"),
      "#{?#{e|<:#{?#{e|>:#{x},#{e|/:#{window_width},2}},#{e|/:#{window_width},2},#{x}},18},18,#{?#{e|>:#{x},#{e|/:#{window_width},2}},#{e|/:#{window_width},2},#{x}}}",
    );
    const cmds = placeFormat("%1", "%2", "#{w}")
      .split(" ; ")
      .map((c) => c.split(" "));
    assert.deepEqual(
      cmds.map((c) => [c[0], c[2]]),
      placeCommands({ list: "%1", stage: "%2" }, 100, 30, 40).map((c) => [c[0], c[2]]),
    );
    // From the window's first line (no header), the whole height but the bottom line (as boxes(): 4 at least).
    assert.deepEqual(cmds[1], ["move-pane", "-t", "%1", "-X", "0", "-Y", "0"]);
    assert.deepEqual(cmds[2], ["move-pane", "-t", "%2", "-X", "#{w}", "-Y", "0"]);
    assert.equal(cmds[0][6], "#{?#{e|<:#{window_height},5},4,#{e|-:#{window_height},1}}");
    for (const rows of [3, 5, 30, 45]) assert.equal(boxes(100, rows).list.h, rows < 5 ? 4 : rows - 1, String(rows));
  });

  test("the boxes start on the window's first line and end on the one above its last, at every size", () => {
    for (const [cols, rows] of [
      [160, 45],
      [120, 40],
      [90, 30],
      [60, 20],
    ]) {
      const b = boxes(cols, rows);
      for (const box of [b.list, b.stage]) {
        assert.equal(box.y, 0, `${cols}x${rows}`);
        assert.equal(box.y + box.h, rows - 1, `${cols}x${rows}: the last line the frame's`);
      }
      assert.equal(b.list.w + b.stage.w, cols);
    }
  });

  test("the caption's box sits on the line just above the boxes' bottom edge, whatever its lines", () => {
    for (const [cols, rows] of [
      [160, 45],
      [100, 30],
      [60, 20],
    ]) {
      const edge = boxes(cols, rows).list.h - 1; // the boxes' bottom border's line
      for (const lines of [1, 2, 3]) {
        const c = captionBox(cols, rows, lines);
        assert.equal(c.y + c.h - 1, edge - 1, `${cols}x${rows}, ${lines} lines`);
        assert.equal(c.h, lines + 2);
      }
    }
    // A window too short for it: kept on the window, from its first line.
    assert.equal(captionBox(60, 5, 3).y, 0);
  });

  test("the border colours follow the keyboard: the box with it #4d5577, the other #44475a; its title light and bold, the other's dimmer", async () => {
    const { t, view } = await setup();
    const v = await view();
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    assert.equal(w.opts["pane-active-border-style"], `fg=${FOCUS_BORDER}`);
    assert.equal(w.opts["pane-border-style"], `fg=${REST_BORDER}`);
    assert.equal(FOCUS_BORDER, "#4d5577");
    assert.equal(REST_BORDER, "#44475a");
    // The list has the keyboard: its title light, the stage's dimmer (a new window's placeholder: "starting", until the app is ready).
    assert.equal(await title(t, v.list!.id), ` #[fg=${TITLE}#,bold]Sessions #[default]`.replace("#,", ","));
    assert.match(await title(t, v.stage!.id), new RegExp(`#\\[fg=${TITLE_REST},bold\\]starting`));
    // Tab to the stage: the other way round (tmux picks the style by the active pane).
    await t.run(["select-pane", "-t", v.stage!.id]);
    assert.match(await title(t, v.stage!.id), new RegExp(`#\\[fg=${TITLE},bold\\]starting`));
    assert.match(await title(t, v.list!.id), new RegExp(`#\\[fg=${TITLE_REST},bold\\]Sessions`));
  });

  test("a session shown: its own pane swapped into the stage's box, titled with its harness's mark and name", async () => {
    const { t, pixie, view } = await setup();
    const placeholder = (await view()).stage!.id;
    assert.equal(await show(t.run, pixie), "shown");
    const v = await view();
    assert.equal(v.stage!.id, pixie);
    assert.deepEqual(box(t, pixie), boxes(160, 45).stage, "the box is the stage's, the pane is the session's");
    assert.equal(t.where(placeholder), "pixie");
    await t.run(["set-option", "-p", "-t", pixie, MARK, markFormat({ glyph: "✻", color: "#D77757" })]);
    assert.match(await title(t, pixie), /#\[fg=#D77757\]✻ {2}#\[fg=#f8f8f2,bold\]pixie #\[default\]$/);
    // A mark's glyph is text, never a format; a colour tmux wouldn't read is left out.
    assert.equal(markFormat({ glyph: "#", color: "red;x" }), "##  ");
    assert.equal(markFormat(null), "");
  });

  test("an outside session's viewer: titled mark, name, and where it runs, dimmed (\"· in Ghostty\"); Kiko's page and a session of ours, the name alone", async () => {
    const { t, pixie, view } = await setup();
    assert.equal(await viewOf(t.run, { id: "session:notes", path: "/p/notes.jsonl", name: "notes", place: "in Ghostty", info: "{}" }), "shown");
    const stage = (await view()).stage!.id;
    assert.equal(t.panes.get(stage)!.opts[PLACE], "in Ghostty");
    await t.run(["set-option", "-p", "-t", stage, MARK, markFormat({ glyph: "✻", color: "#D77757" })]);
    assert.match(await title(t, stage), /#\[fg=#D77757\]✻ {2}#\[fg=#f8f8f2,bold\]notes#\[nobold,dim\] · in Ghostty #\[default\]$/);
    // Another place: the same pane, its place now.
    await viewOf(t.run, { id: "session:job", path: "/p/job.jsonl", name: "job", place: "in T3 Code", info: "{}" });
    assert.match(await title(t, stage), /job#\[nobold,dim\] · in T3 Code #\[default\]$/);
    // Kiko's page: none.
    await viewOf(t.run, { id: "page", path: "/p/page.jsonl", name: "Kiko", info: "{}", page: true });
    assert.equal(t.panes.get(stage)!.opts[PLACE], undefined);
    assert.match(await title(t, stage), /\]Kiko #\[default\]$/);
    // A session of Kiko's tmux shown after it: mark and name, no "in …"; the viewer, a placeholder at its home, keeps none.
    await viewOf(t.run, { id: "session:notes", path: "/p/notes.jsonl", name: "notes", place: "in Ghostty", info: "{}" });
    await show(t.run, pixie);
    assert.equal(t.panes.get(stage)!.opts[PLACE], undefined);
    assert.doesNotMatch(await title(t, pixie), /·/);
  });

  test("the boxes put back for the window's size (the frame does it as it resizes), the list as dragged; nothing while zoomed", async () => {
    const { t, view } = await setup();
    const v = await view();
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    [w.width, w.height] = [100, 30];
    await place(t.run);
    assert.deepEqual(box(t, v.list!.id), { x: 0, y: 0, w: 30, h: 29 });
    assert.deepEqual(box(t, v.stage!.id), { x: 30, y: 0, w: 70, h: 29 });
    w.opts["@kiko-list-width"] = "44";
    await place(t.run);
    assert.deepEqual(box(t, v.stage!.id), { x: 44, y: 0, w: 56, h: 29 });
    w.zoomed = true;
    w.width = 120;
    const before = t.calls.length;
    await place(t.run);
    assert.equal(t.calls.slice(before).filter((c) => c[0] === "resize-pane" || c[0] === "move-pane").length, 0);
  });

  test("an empty stage gets a placeholder in the stage's box; a frame that ended starts again", async () => {
    const { t, view } = await setup();
    const v = await view();
    await t.run(["kill-pane", "-t", v.stage!.id]);
    await tidy(t.run);
    const after = await view();
    assert.equal(after.stage?.role, "placeholder");
    assert.deepEqual(box(t, after.stage!.id), boxes(160, 45).stage);
    t.end(v.frame!.id);
    assert.equal((await view()).frame?.dead, true);
    await tidy(t.run);
    assert.equal((await view()).frame?.dead, false);
    assert.equal(t.panes.get(v.frame!.id)!.starts, 2);
  });
});

describe("the caption", () => {
  test("a box of its own over the bottom of the window, centred, two thirds wide, its border red; never the keyboard's; sized to its lines, then gone", async () => {
    const { t, view } = await setup();
    const id = (await openCaption(t.run, 1))!;
    const v = await view();
    assert.equal(v.caption?.id, id);
    assert.notEqual(v.stage?.id, id, "never taken for the stage");
    assert.equal(v.list!.active, true, "the keyboard stays where it was");
    assert.deepEqual(box(t, id), captionBox(160, 45, 1));
    assert.deepEqual(captionBox(160, 45, 1), { x: 26, y: 40, w: 107, h: 3 });
    const p = t.panes.get(id)!;
    assert.equal(p.title, CAPTION_TITLE);
    assert.equal(p.opts["pane-border-style"], "fg=red");
    assert.equal(p.opts["pane-active-border-style"], "fg=red");
    assert.deepEqual(p.command.slice(1, 2), [FRAME]);
    assert.equal(p.command.at(-1), "caption");
    assert.equal(await title(t, id), "", "no title");
    // The one there already, not a second.
    assert.equal(await openCaption(t.run, 2), id);
    await sizeCaption(t.run, id, { width: 160, height: 45 }, 3);
    assert.deepEqual(box(t, id), { x: 26, y: 38, w: 107, h: 5 });
    await closeCaption(t.run, id);
    assert.equal((await view()).caption, null);
    await closeCaption(t.run, id); // gone already: nothing
  });

  test("known for a caption from the moment it's made (its title), before its role is set", async () => {
    const { t, view } = await setup();
    const id = (await t.run(["new-pane", "-d", "-t", `=${WINDOW}:`, "-T", CAPTION_TITLE, "-x", "40", "-y", "3", "-P", "-F", "#{pane_id}", "--", "true"])).trim();
    const v = await view();
    assert.equal(v.caption?.id, id);
    assert.equal(v.stage?.role, "placeholder");
    assert.equal(t.panes.get(id)!.opts[ROLE], undefined);
  });
});

describe("the glow", () => {
  test("its band rests on the boxes' bottom edge, centred, at the glow's natural width; four lines, three in a short window; the caption over it", () => {
    for (const [cols, rows] of [
      [160, 45],
      [100, 30],
      [60, 20],
      [GLOW_MIN_COLS, GLOW_MIN_ROWS],
    ]) {
      const edge = boxes(cols, rows).list.h - 1; // the boxes' bottom border's line
      const g = glowBox(cols, rows)!;
      assert.equal(g.y + g.h - 1, edge - 1, `${cols}x${rows}: just above the bottom edge`);
      assert.equal(g.h, rows >= 24 ? 4 : 3);
      assert.equal(g.w, Math.min(GLOW_COLS, cols - 4));
      assert.ok(Math.abs(g.x - (cols - g.x - g.w)) <= 1, `${cols}x${rows}: centred`);
      for (const lines of [1, 3]) {
        const c = captionBox(cols, rows, lines, g.h);
        assert.equal(c.y + c.h - 1, g.y - 1, `${cols}x${rows}: the caption's bottom edge just over the glow`);
      }
    }
    assert.deepEqual(glowBox(160, 45), { x: 48, y: 39, w: 63, h: 4 });
    // A window too small for it: none.
    assert.equal(glowBox(160, GLOW_MIN_ROWS - 1), null);
    assert.equal(glowBox(GLOW_MIN_COLS - 1, 45), null);
    assert.equal(glowBox(30, 8), null);
  });

  test("a borderless box of its own, never the keyboard's, no title; the caption made over it; placed with the boxes; then gone", async () => {
    const { t, view } = await setup();
    const made = (await openGlow(t.run))!;
    assert.deepEqual(made.box, glowBox(160, 45));
    const v = await view();
    assert.equal(v.glow?.id, made.id);
    assert.notEqual(v.stage?.id, made.id, "never taken for the stage");
    assert.equal(v.list!.active, true, "the keyboard stays where it was");
    const call = t.calls.find((c) => c[0] === "new-pane" && c.includes(GLOW_TITLE))!;
    assert.equal(call[call.indexOf("-B") + 1], "none", "no border");
    assert.ok(call.includes("-d"));
    assert.deepEqual(box(t, made.id), made.box);
    const p = t.panes.get(made.id)!;
    assert.equal(p.opts[ROLE], "glow");
    assert.deepEqual(p.command.slice(1, 2), [FRAME]);
    assert.equal(p.command.at(-1), "glow");
    assert.equal(await title(t, made.id), "", "no title");
    // The one there already, not a second.
    assert.equal((await openGlow(t.run))!.id, made.id);
    // A caption made while it's up sits over it.
    const caption = (await openCaption(t.run, 1))!;
    assert.deepEqual(box(t, caption), captionBox(160, 45, 1, made.box.h));
    // The window resized: both where they go for its size.
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    [w.width, w.height] = [100, 30];
    await place(t.run);
    assert.deepEqual(box(t, made.id), glowBox(100, 30));
    assert.deepEqual(box(t, caption), captionBox(100, 30, 1, 4));
    await closeGlow(t.run, made.id);
    assert.equal((await view()).glow, null);
    await closeGlow(t.run, made.id); // gone already: nothing
    await closeCaption(t.run, caption);
  });

  test("known by its title from the moment it's made; one that ended is tidied away; none in a window too small or zoomed", async () => {
    const { t, view } = await setup();
    const id = (await t.run(["new-pane", "-d", "-t", `=${WINDOW}:`, "-B", "none", "-T", GLOW_TITLE, "-x", "40", "-y", "3", "-P", "-F", "#{pane_id}", "--", "true"])).trim();
    let v = await view();
    assert.equal(v.glow?.id, id);
    assert.equal(v.stage?.role, "placeholder");
    t.end(id);
    await tidy(t.run);
    assert.equal((await view()).glow, null);
    v = await view();
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    [w.width, w.height] = [80, GLOW_MIN_ROWS - 1];
    assert.equal(await openGlow(t.run), null);
    [w.width, w.height] = [160, 45];
    w.zoomed = true;
    assert.equal(await openGlow(t.run), null);
  });
});

describe("older tmux (no floating panes)", () => {
  test("the tiled look, unchanged: two panes side by side, the bottom line in the status line, no frame", async () => {
    const { t, view } = await setup("tmux 3.7");
    const v = await view();
    assert.equal(v.look, "tiled");
    assert.equal(v.frame, null);
    assert.equal(
      t.calls.some((c) => c.includes("new-pane")),
      false,
    );
    assert.equal(t.panesOf(WINDOW).length, 2);
    assert.equal(t.sessions.get(WINDOW)!.opts.status, "on");
    assert.equal(t.sessions.get(WINDOW)!.opts[BAR], "Kiko Dev is starting…");
    assert.equal(t.panes.get(v.list!.id)!.floating, undefined);
    const w = t.windows.get(t.panes.get(v.list!.id)!.window)!;
    assert.equal(w.opts["pane-border-status"], "top");
    assert.equal(w.opts[LOOK], undefined);
    assert.equal(
      t.calls.some((c) => c.includes("MouseDown1Pane")),
      false,
    );
    // Drags as before: tmux's own, the list's width noted as one ends on a border; no hook for them.
    assert.equal(
      t.calls.some((c) => c.includes("MouseDrag1Border") || c.includes("MouseDragEnd1Pane")),
      false,
    );
    assert.equal(
      t.hooks.some((h) => h[0] === "pane-resized"),
      false,
    );
    // A caption has nowhere to go, nor a glow.
    assert.equal(await openCaption(t.run, 1), null);
    assert.equal(await openGlow(t.run), null);
  });

  test("a tiled window, opened by a `kiko` whose tmux floats its panes: made over in the classic look, every pane and process as it was", async () => {
    const t = new FakeTmux();
    t.version = "tmux 3.7";
    await openWindow(t.run, app, "/code/kiko", { width: 160, height: 45 });
    const before = (await layoutOf(t.run)).view!;
    t.version = "tmux 3.8";
    // A new runner (a new `kiko`): asked again.
    const run = (args: string[], input?: string) => t.run(args, input);
    assert.equal(await openWindow(run, app, "/code/kiko"), "open");
    const v = (await layoutOf(t.run)).view!;
    assert.equal(v.look, "classic");
    assert.equal(v.list!.id, before.list!.id);
    assert.equal(v.stage!.id, before.stage!.id);
    assert.equal(t.panes.get(v.list!.id)!.starts, 1, "the app wasn't restarted");
    assert.ok(v.frame);
    assert.deepEqual(box(t, v.list!.id), boxes(160, 45).list);
    assert.deepEqual(box(t, v.stage!.id), boxes(160, 45).stage);
    assert.equal(v.list!.active, true, "the keyboard back where it was");
    assert.equal(t.sessions.get(WINDOW)!.opts.status, "off");
    assert.equal(t.panes.get(v.list!.id)!.opts[LABEL], "Kiko Dev");
  });
});
