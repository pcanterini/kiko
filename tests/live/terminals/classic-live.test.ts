// The Kiko window's classic look (tmux 3.8 and later: src/terminals/tmux/classic.ts), for real:
// `kiko` (bin/kiko) run in a pane of a throwaway "outer" tmux standing in for your terminal,
// its list running a stand-in app with the real list, input, glue and frame drawing (tests/support/
// window-app.ts), on another throwaway server (KIKO_TMUX_SERVER), never `-L kiko` nor the
// default one; both killed afterwards whatever happens. What it shows is read back with
// `capture-pane` on the outer pane, with its colours (-e) where they're what's checked.
//
// The window's one line, its last, from the app through the frame's socket (no header: the boxes on the first line); the boxes' borders and titles
// following the keyboard; the caption while words come, and gone after; the boxes put back as the
// window resizes and as settings give it back; the frame saying so when the app is gone. Skipped on
// an older tmux: window-live.test.ts has the tiled look.
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, zoom } from "../../../src/terminals/tmux/window.ts";
import { boxes, classicLook } from "../../../src/terminals/tmux/classic.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const WIN = throwawayServer("classic");
const OUTER = throwawayServer("classicouter");
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const APP = fileURLToPath(new URL("../../support/window-app.ts", import.meta.url));
// Short: the frame's socket is made in it, and a Unix socket's path has to fit in 103 bytes.
const dir = mkdtempSync(join(tmpdir(), "cbcl-"));
const bin = join(dir, "bin");
const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"];
const win = tmuxRunner(WIN, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });
const outer = tmuxRunner(OUTER, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });
const CLASSIC = TMUX ? await classicLook(win) : false;
const COLS = 160;
const ROWS = 45;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(8000, 60);
/** What your terminal shows; `colours`: with its escape sequences (capture-pane -e). */
const screen = (colours = false) => outer(["capture-pane", "-p", ...(colours ? ["-e"] : []), "-t", "=outer:"]);
const layout = () => layoutOf(win);
const acts = () =>
  existsSync(join(dir, "acts.log"))
    ? readFileSync(join(dir, "acts.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const said = (c: object) => appendFileSync(join(dir, "control.jsonl"), `${JSON.stringify(c)}\n`);
const key = (...keys: string[]) => outer(["send-keys", "-t", "=outer:", ...keys]);
/** Your terminal's rows, as capture-pane gives them (each ends with a newline). */
const rowsOf = (t: string) => t.replace(/\n$/, "").split("\n");
/** Its last row: the window's one line (the classic look has no header). */
const bottomOf = (t: string) => rowsOf(t).at(-1) ?? "";
/** The line's state when ready, and what it's set to after it. */
const READY = /^ ready( · \d+ working)? {2,}(\S.* · )?\$\d/;
const snapshot = (what: string, text: string) => console.log(`\n── capture-pane -p: ${what} ──\n${text.replace(/\s+$/, "")}\n──`);
/** An RGB colour as a terminal's SGR has it (38;2;r;g;b): the borders' and the cursor row's. */
const sgr = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";");
/** The colour (foreground, 24-bit) a box's top-left corner is drawn in, on your terminal's first row: the list's at column 1, the stage's after the list. */
async function corners(): Promise<{ list: string; stage: string }> {
  const row = (await screen(true)).split("\n")[0];
  const found = [...row.matchAll(/\x1b\[38;2;([\d;]+)m┌/g)].map((m) => m[1]);
  return { list: found[0] ?? "", stage: found[1] ?? "" };
}

describe("the classic look, for real", { skip: (!TMUX && "tmux isn't installed") || (!CLASSIC && "this tmux has no floating panes (3.8 and later): window-live.test.ts has the tiled look") }, () => {
  before(async () => {
    mkdirSync(bin);
    if (PATH.slice(1).some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nexec cat > /dev/null\n`, { mode: 0o755 });
    // The window's app: the stand-in with the real list, glue and drawing (its folder: the config and what the test says happens).
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
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("kiko: the frame under two boxes, Sessions and Kiko's page, from the first line; one line under them: the state, what it's set to, the keys; no status line", async () => {
    const s = await until(screen, (t) => READY.test(bottomOf(t)) && t.includes("┌── Kiko ") && bottomOf(t).includes("m mute · ⌃Space menu"), "the boxes, the line under them");
    snapshot("ready", s);
    const lines = rowsOf(s);
    assert.equal(lines.length, ROWS);
    // No header: the boxes' top borders on the first line, their bottom ones on the line above the last.
    assert.match(lines[0], /^┌── Sessions ─+┐┌── Kiko ─+┐$/);
    assert.match(lines[ROWS - 2], /^└─+┘└─+┘$/);
    // The line: ready (and how many work) on the left, the middle's words, the keys at the right.
    const line = lines[ROWS - 1];
    assert.match(line, /^ ready( · \d+ working)? {2,}(\S.* · )?\$\d\.\d{3} · \. repeat · m mute · ⌃Space menu$/);
    assert.ok(!line.includes("is ready") && !line.includes("⏱"), line);
    assert.ok(!line.includes("to talk") && !line.includes("🎙 Kiko"), line);
    // The list's keys, Enter's first where they fit with it (the dots alone here).
    assert.ok(s.includes("│ 0   ▪  Kiko") && s.includes("│ 1   ✻  pixie") && s.includes("│ ⏎ open · c new · ⇥ session "), s);
    const view = (await layout()).view!;
    assert.equal(view.look, "classic");
    assert.equal((await win(["show-options", "-v", "-t", `=${WINDOW}:`, "status"])).trim(), "off");
    // As the full screen sizes its panels: the list 30% of the width (26 to 40 columns).
    assert.equal(view.list!.width + 2, boxes(COLS, ROWS).list.w);
    assert.ok(acts().some((a) => a.started));
  });

  test("the borders follow the keyboard: the box with it #4d5577, the other #44475a; the list's cursor row lighter while it has it", async () => {
    await until(corners, (c) => c.list === sgr("#4d5577") && c.stage === sgr("#44475a"), "the list's box focused");
    // Kiko's row, found by its text without the colours: its blank mark slot and its name are drawn in different styles.
    const row = (t: string) => t.split("\n").find((l) => /│ 0\b.*\bKiko\b/.test(l.replace(/\x1b\[[0-9;]*m/g, ""))) ?? "";
    await until(
      () => screen(true),
      (t) => row(t).includes(`48;2;${sgr("#3b4270")}m`),
      "the cursor row, focused",
    );
    await key("Tab");
    await until(corners, (c) => c.list === sgr("#44475a") && c.stage === sgr("#4d5577"), "the stage's box focused");
    await until(
      () => screen(true),
      (t) => row(t).includes(`48;2;${sgr("#2d2f3b")}m`),
      "the cursor row, not focused",
    );
    // The line's keys follow it too: in the stage, only the menu's (the one key that works there).
    const staged = await until(screen, (t) => !bottomOf(t).includes("repeat"), "the stage's keys");
    assert.match(bottomOf(staged), /\$\d\.\d{3} · ⌃Space menu$/);
    snapshot("the stage has the keyboard: the line", bottomOf(staged));
    // Back (Ctrl+Space Tab, from the stage).
    await key("C-Space");
    await until(
      () => screen(),
      (t) => t.includes("Go to the list ←"),
      "the menu",
    );
    await key("Tab");
    await until(corners, (c) => c.list === sgr("#4d5577"), "the list's box focused again");
    await until(screen, (t) => bottomOf(t).endsWith(". repeat · m mute · ⌃Space menu"), "the list's keys again");
  });

  test("listening: the badge and the waveform on the line; the caption once words come (its last three lines, red, never the keyboard's, just above the boxes' bottom edge), gone when you let go", async () => {
    said({ set: { listening: true, interim: "", level: 0.4 } });
    await until(screen, (t) => bottomOf(t).includes("● LISTENING"), "the badge");
    await wait(300);
    assert.equal((await layout()).view!.caption, null, "no caption before words come");
    assert.match(bottomOf(await screen()), /^ {2}● LISTENING {2}[▁▂▃▄▅▆▇█]{10} {2,}.*⌃Space menu$/);
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    said({ set: { interim: words, level: 0.9 } });
    const s = await until(screen, (t) => t.includes("word59 "), "the caption");
    snapshot("listening, with a caption", s);
    const view = (await layout()).view!;
    assert.ok(view.caption, "a box of its own");
    assert.equal(view.caption!.height, 3, "three lines");
    assert.equal(view.list!.active, true, "the keyboard stays in the list");
    assert.ok(!/word\d/.test(bottomOf(s)), "the line has no words");
    assert.match(bottomOf(s), /^ {2}● LISTENING /);
    assert.ok(!s.includes("word0 "), "only the last three lines");
    const rows = rowsOf(s);
    const box = rows.flatMap((l, i) => (/word\d/.test(l) ? [i] : []));
    assert.equal(box.length, 3);
    // Just above the boxes' bottom edge (on the line above the last): its own bottom border on the line above that.
    assert.deepEqual(box, [ROWS - 6, ROWS - 5, ROWS - 4]);
    assert.match(rows[ROWS - 3], /└─+┘/);
    assert.match(rows[ROWS - 2], /^└─+┘└─+┘$/);
    // Its border red.
    assert.ok(
      (await screen(true)).split("\n").some((l) => /\x1b\[31m┌─/.test(l)),
      "a red border",
    );
    said({ set: { listening: false, interim: "" } });
    await until(
      async () => (await layout()).view!.caption,
      (c) => c === null,
      "the caption gone",
    );
    await until(screen, (t) => !t.includes("word59") && READY.test(bottomOf(t)), "ready again");
  });

  test("resized: the boxes put back side by side for the new size, from the first line, the line under them at its width", async () => {
    await outer(["resize-window", "-t", "=outer:", "-x", "100", "-y", "30"]);
    const b = boxes(100, 30);
    await until(layout, (l) => l.view?.width === 100 && l.view.list!.width + 2 === b.list.w && l.view.stage!.height === b.stage.h - 2, "the boxes for 100 by 30");
    const s = await until(screen, (t) => rowsOf(t).length === 30 && /⌃Space menu$/.test(bottomOf(t)), "the line at the new width");
    snapshot("100 by 30", s);
    assert.match(rowsOf(s)[0], /^┌── Sessions ─+┐┌── Kiko ─+┐$/);
    assert.equal(rowsOf(s)[0].length, 100);
    assert.match(rowsOf(s)[28], /^└─+┘└─+┘$/);
    await outer(["resize-window", "-t", "=outer:", "-x", String(COLS), "-y", String(ROWS)]);
    await until(layout, (l) => l.view?.width === COLS && l.view.list!.width + 2 === boxes(COLS, ROWS).list.w, "back");
  });

  test("settings zoom the list over everything; Ctrl+Space Tab there: back to the boxes, the keyboard in the stage", async () => {
    const list = (await layout()).view!.list!.id;
    await zoom(win, list, true);
    await until(layout, (l) => l.view?.zoomed === true, "zoomed");
    await key("C-Space");
    await until(screen, (t) => t.includes("Go to the session →"), "the menu");
    await key("Tab");
    const v = await until(
      async () => (await layout()).view!,
      (x) => !x.zoomed && x.stage?.active === true,
      "unzoomed, the stage focused",
    );
    assert.equal(v.list!.width + 2, boxes(COLS, ROWS).list.w);
    await key("C-Space");
    await until(screen, (t) => t.includes("Go to the list ←"), "the menu");
    await key("Tab");
    await until(layout, (l) => l.view?.list?.active === true, "the list again");
  });

  // The command is this flavour's: kiko-dev, as the tests run from a checkout (src/core/name.ts).
  test("the app gone: the line says Kiko isn't running", async () => {
    await key("Q");
    await until(screen, (t) => t.includes("Press q again to quit"), "asked");
    await key("y");
    await until(acts, (a) => a.some((x) => x.action === "quit"), "quit");
    await until(screen, (t) => bottomOf(t).includes(`Kiko isn't running · run ${COMMAND} to start it here`), "said on the line");
  });
});
