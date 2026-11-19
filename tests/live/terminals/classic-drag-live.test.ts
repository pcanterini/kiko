// Dragging the border between the classic look's boxes (tmux 3.8 and later: src/terminals/tmux/
// classic.ts, window.ts dragKeys and splitHook), for real: `kiko` (bin/kiko) in a pane of a
// throwaway "outer" tmux standing in for your terminal, on another throwaway server
// (KIKO_TMUX_SERVER), never `-L kiko` nor the default one; both killed afterwards whatever
// happens. The mouse is your terminal's: SGR mouse reports typed into the outer pane (a press, the
// motion with the button held, the release), which the window's tmux client reads as a terminal's.
//
// On every step of a drag both boxes move together: the list's right border and the stage's left
// one side by side, the list from the left edge, the stage to the right one, on the screen (what
// the client draws) and in the layout; kept to the widths boxes() allows; where you let go kept
// (LIST_WIDTH), the frame then placing them exactly where the drag left them, and again as the
// window resizes. Skipped on an older tmux: window-live.test.ts has the tiled look.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { DRAGGING, LIST_WIDTH } from "../../../src/terminals/tmux/window.ts";
import { boxes, classicLook } from "../../../src/terminals/tmux/classic.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const WIN = throwawayServer("classicdrag");
const OUTER = throwawayServer("classicdragouter");
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const APP = fileURLToPath(new URL("../../support/window-app.ts", import.meta.url));
// Short: the frame's socket is made in it, and a Unix socket's path has to fit in 103 bytes.
const dir = mkdtempSync(join(tmpdir(), "cbdr-"));
const bin = join(dir, "bin");
const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"];
const win = tmuxRunner(WIN, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });
const outer = tmuxRunner(OUTER, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });
const CLASSIC = TMUX ? await classicLook(win) : false;
const COLS = 120;
const ROWS = 36;
const ROW = 12; // the row the drags go along (inside both boxes)

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(8000, 30);
/** What your terminal shows. */
const screen = () => outer(["capture-pane", "-p", "-t", "=outer:"]);

/** The mouse in your terminal (0-based cells): SGR reports typed into it. */
const sgr = (b: number, x: number, y: number, up = false) => outer(["send-keys", "-t", "=outer:", "-l", `\x1b[<${b};${x + 1};${y + 1}${up ? "m" : "M"}`]);
/** Where the mouse is with its button held; null when it isn't. */
let held: { x: number; y: number } | null = null;
function press(x: number, y = ROW) {
  held = { x, y };
  return sgr(0, x, y);
}
function moveTo(x: number, y = ROW) {
  held = { x, y };
  return sgr(32, x, y);
}
function release(x: number, y = ROW) {
  held = null;
  return sgr(0, x, y, true);
}

type Geo = { left: number; top: number; w: number; h: number };
/** The window's boxes as tmux has them (their insides: pane_left, pane_width…), and its options. */
async function geometry() {
  const out = await win(["list-panes", "-t", `=${WINDOW}:`, "-F", "#{@kiko-role}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}"]);
  const panes = out
    .trim()
    .split("\n")
    .map((l) => l.split("\t"));
  const geo = (p?: string[]): Geo | null => (p ? { left: Number(p[1]), top: Number(p[2]), w: Number(p[3]), h: Number(p[4]) } : null);
  const option = async (name: string) => (await win(["show-options", "-wqv", "-t", `=${WINDOW}:`, name])).trim();
  return {
    list: geo(panes.find((p) => p[0] === "list"))!,
    stage: geo(panes.find((p) => !["list", "frame", "caption"].includes(p[0])))!,
    dragged: Number(await option(LIST_WIDTH)) || 0,
    dragging: await option(DRAGGING),
  };
}
/** The list's box width (its border included). */
const listBox = (g: { list: Geo }) => g.list.w + 2;

/** Both boxes where the frame puts them for a list `listW` wide: side by side, the full width, the window's first line to the one above its last. */
function placed(g: { list: Geo; stage: Geo }, listW: number): boolean {
  const b = boxes(COLS, ROWS, listW);
  return (
    g.list.left === b.list.x + 1 &&
    g.list.top === b.list.y + 1 &&
    g.list.w === b.list.w - 2 &&
    g.list.h === b.list.h - 2 &&
    g.stage.left === b.stage.x + 1 &&
    g.stage.top === b.stage.y + 1 &&
    g.stage.w === b.stage.w - 2 &&
    g.stage.h === b.stage.h - 2
  );
}

/**
 * The boxes' top border on your terminal (its first row: no header): the list's and the stage's, one after the other, no gap
 * and neither over the other, the full width. `listW`: the list's box that wide.
 */
function sideBySide(s: string, listW?: number): boolean {
  const row = s.split("\n")[0] ?? "";
  const m = /^(┌── Sessions ─*┐)(┌── .*─┐)$/.exec(row);
  return Boolean(m) && [...row].length === COLS && (listW === undefined || [...m![1]].length === listW);
}

/**
 * How long a screen read may show anything but the two boxes side by side: none of what tmux draws
 * does, but the outer tmux takes in the window's client's output as it comes, so a read can land in
 * the middle of one redraw (the left of a row new, the rest still the last frame's). A gap or an
 * overlap that's drawn (the bug: until you let go) lasts. 1.5 s, not less: under load the reads (a new tmux
 * process every 60 ms) and the redraws both slow down, so a few half-drawn reads in a row can last past 400 ms.
 */
const PARTIAL_MS = 1500;

/**
 * The mouse moved to each of `xs` in turn, the button held: after each step every screen read, until
 * the list's box is `expect(x)` wide there, shows the two side by side (never a gap, never one over
 * the other: what you see while you drag; a read in the middle of a redraw excepted: PARTIAL_MS);
 * then the layout has both where the frame would put them for that width, the stage's left border
 * right after the list's right one.
 */
async function dragThrough(xs: number[], expect: (x: number) => number) {
  for (const x of xs) {
    await moveTo(x);
    const want = expect(x);
    let wrongSince = 0;
    await until(
      screen,
      (t) => {
        if (!sideBySide(t)) {
          wrongSince ||= Date.now();
          assert.ok(Date.now() - wrongSince < PARTIAL_MS, `the mouse at ${x}, on your terminal for ${PARTIAL_MS}ms:\n${t.split("\n").slice(0, 3).join("\n")}`);
          return false;
        }
        wrongSince = 0;
        return sideBySide(t, want);
      },
      `the screen with the list's box ${want} wide (the mouse at ${x})`,
      4000,
    );
    const g = await until(geometry, (v) => listBox(v) === want && v.stage.left === v.list.left + v.list.w + 2, `the layout at ${want}`, 2000);
    assert.ok(placed(g, want), `both boxes as the frame places them for ${want} (the mouse at ${x}): ${JSON.stringify(g)}`);
  }
}

/** boxes()' list for a drag to `w` columns: 18 to half the window. */
const clamp = (w: number, cols = COLS) => Math.max(18, Math.min(Math.floor(cols / 2), w));

describe("dragging the classic look's split, for real", {
  skip: (!TMUX && "tmux isn't installed") || (!CLASSIC && "this tmux has no floating panes (3.8 and later): window-live.test.ts has the tiled look"),
}, () => {
  before(async () => {
    mkdirSync(bin);
    if (PATH.slice(1).some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nexec cat > /dev/null\n`, { mode: 0o755 });
    writeFileSync(join(bin, "window-app"), `#!/bin/sh\nexec '${process.execPath}' --no-warnings '${APP}' '${dir}'\n`, { mode: 0o755 });
    mkdirSync(join(dir, "pixie"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: WIN, projects: [join(dir, "pixie")], claude: join(bin, "claude"), outside: false }));
    await win(["new-session", "-d", "-s", "pixie", "-c", join(dir, "pixie"), "-x", "100", "-y", "40", "--", join(bin, "claude")]);
    await outer([
      "new-session",
      "-d",
      "-s",
      "outer",
      "-x",
      String(COLS),
      "-y",
      String(ROWS),
      "-e",
      `PATH=${PATH.join(":")}`,
      "-e",
      `KIKO_TMUX_SERVER=${WIN}`,
      "-e",
      `KIKO_WINDOW_APP=${join(bin, "window-app")}`,
      "-e",
      `KIKO_SOCKET=${join(dir, "no-app.sock")}`,
      "-e",
      `KIKO_SETTINGS=${join(dir, "no-settings.json")}`,
      "-e",
      `NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT || "child"}`,
      "--",
      "/bin/sh",
      "-c",
      `'${CLI}'; sleep 600`,
    ]);
    await until(screen, (t) => /\$\d/.test(t.replace(/\n$/, "").split("\n").at(-1) ?? "") && sideBySide(t), "the window, ready");
    await until(geometry, (g) => placed(g, boxes(COLS, ROWS).list.w), "the boxes placed");
  });
  // A test that failed mid-drag lets go, so the next starts with the button up.
  afterEach(async () => {
    if (held) await release(held.x, held.y);
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the list's right border: the stage follows on every step, both side by side; let go, the width is kept and nothing moves", async () => {
    const start = listBox(await geometry());
    assert.equal(start, boxes(COLS, ROWS).list.w);
    // Its right border is the box's last column.
    await press(start - 1);
    const steps = [start, start + 2, start + 5, start + 11, start + 7, start - 4, start - 10, 30, 31, 33];
    await dragThrough(steps, (x) => clamp(x + 1));
    const during = await geometry();
    assert.equal(Number(during.dragging), start, "the drag noted as on, from the width it began at");
    await release(33);
    const g = await until(geometry, (v) => v.dragging === "" && v.dragged === 34, "the width kept, the drag over");
    assert.ok(placed(g, 34), JSON.stringify(g));
    // The frame (told as the drag ends) puts them where the drag left them: nothing moves.
    await wait(400);
    const later = await geometry();
    assert.ok(placed(later, 34), JSON.stringify(later));
    assert.ok(sideBySide(await screen(), 34));
  });

  test("the stage's left border: the list follows; past the narrowest (18) and back", async () => {
    const start = listBox(await geometry());
    // The stage's left border is the column after the list's box.
    await press(start);
    await dragThrough([start - 2, start - 8, 20, 18, 12, 5, 18, 22, 26], (x) => clamp(x));
    await release(26);
    const g = await until(geometry, (v) => v.dragging === "" && v.dragged === 26, "the width kept");
    await wait(400);
    assert.ok(placed(await geometry(), 26), JSON.stringify(g));
  });

  test("past half the window: the split stays at half, and letting go over the stage (not a border) still ends the drag and keeps it", async () => {
    const start = listBox(await geometry());
    await press(start - 1);
    await dragThrough([start + 4, 50, 58, 59], (x) => clamp(x + 1));
    // The mouse goes on into the stage; the split stays at half.
    await moveTo(80);
    await wait(150);
    const g = await geometry();
    assert.equal(listBox(g), COLS / 2);
    assert.ok(placed(g, COLS / 2), JSON.stringify(g));
    assert.ok(sideBySide(await screen(), COLS / 2));
    await release(80);
    await until(geometry, (v) => v.dragging === "" && v.dragged === COLS / 2, "the width kept at half");
    await wait(400);
    assert.ok(placed(await geometry(), COLS / 2));
  });

  test("the stage scrolled back (copy mode): letting go over it still ends the drag", async () => {
    const panes = (await win(["list-panes", "-t", `=${WINDOW}:`, "-F", "#{@kiko-role} #{pane_id}"]))
      .trim()
      .split("\n")
      .map((l) => l.split(" "));
    const stage = panes.find(([role]) => !["list", "frame", "caption"].includes(role))![1];
    await win(["copy-mode", "-t", stage]);
    const start = listBox(await geometry());
    await press(start - 1);
    await dragThrough([start - 6, start - 12], (x) => clamp(x + 1));
    await moveTo(start - 4);
    await release(start + 10);
    const want = listBox(await geometry());
    await until(geometry, (v) => v.dragging === "" && v.dragged === want, "the drag over, the width kept");
    await win(["send-keys", "-t", stage, "-X", "cancel"]).catch(() => "");
  });

  test("the width you dragged to holds as the window resizes (kept to half a narrower one), and comes back", async () => {
    await outer(["resize-window", "-t", "=outer:", "-x", "100", "-y", "30"]);
    const narrow = boxes(100, 30, COLS / 2);
    assert.equal(narrow.list.w, 50);
    await until(
      async () => {
        const out = await win(["list-panes", "-t", `=${WINDOW}:`, "-F", "#{@kiko-role}\t#{pane_left}\t#{pane_width}\t#{window_width}"]);
        return out
          .trim()
          .split("\n")
          .map((l) => l.split("\t"));
      },
      (rows) =>
        rows.some((r) => r[0] === "list" && Number(r[2]) + 2 === narrow.list.w && r[3] === "100") &&
        rows.some((r) => !["list", "frame", "caption"].includes(r[0]) && Number(r[1]) === narrow.stage.x + 1 && Number(r[2]) === narrow.stage.w - 2),
      "the boxes for 100 by 30",
    );
    // A drag there, then back to the full size: the width dragged to is kept.
    await press(narrow.list.w - 1);
    await moveTo(39);
    await until(geometry, (g) => listBox(g) === 40, "dragged to 40");
    await release(39);
    await until(geometry, (g) => g.dragged === 40 && g.dragging === "", "kept");
    await outer(["resize-window", "-t", "=outer:", "-x", String(COLS), "-y", String(ROWS)]);
    await until(geometry, (g) => placed(g, 40), "40 wide in the full-size window, the stage after it");
    assert.ok((await until(screen, (t) => sideBySide(t, 40), "the screen")).length > 0);
  });

  test("a drag along the list's bottom border changes nothing; the boxes stay where they go", async () => {
    const before = await geometry();
    const bottom = before.list.top + before.list.h; // the list's bottom border's row
    await press(10, bottom);
    for (const y of [bottom - 2, bottom - 5, bottom - 1]) {
      await moveTo(10, y);
      await wait(80);
      const g = await geometry();
      assert.ok(placed(g, listBox(before)), `the mouse at row ${y}: ${JSON.stringify(g)}`);
    }
    await release(10, bottom - 1);
    await until(geometry, (g) => g.dragging === "", "the drag over");
    await wait(300);
    const g = await geometry();
    assert.equal(g.dragged, before.dragged, "the width as it was");
    assert.ok(placed(g, listBox(before)));
  });
});
