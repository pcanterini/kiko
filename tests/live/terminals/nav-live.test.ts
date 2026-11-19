// Getting around the Kiko window, for real: the window on a throwaway tmux server (`-L
// kiko-test-<random>-nav`, never `-L kiko` nor the default one), its list running a stand-in
// app with the real list, input, glue, page and viewer (tests/support/window-app.ts), and a second
// throwaway tmux standing in for your terminal (attached to the window, so keys and clicks typed
// into it reach the window as yours would: Ctrl+Space, numbers, SGR mouse reports). What it shows is
// read back with `capture-pane -p`. Both servers are killed afterwards whatever happens. The window
// has the look tmux gives it: the classic one on tmux 3.8 and later (boxes from the first line, one line under
// them: src/terminals/tmux/classic.ts), the tiled one before.
//
// Nothing real starts: no Kiko app (no voice, models, socket or settings), and `claude` is a
// stand-in script on a PATH with no real one (`cat`, so it waits).
import "../../setup.ts";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { TITLE } from "../../../src/core/name.ts";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, LIST_WIDTH, openWindow, PAGE_ID } from "../../../src/terminals/tmux/window.ts";
import { classicLook } from "../../../src/terminals/tmux/classic.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const WIN = throwawayServer("nav");
const OUTER = throwawayServer("navouter");
const APP = fileURLToPath(new URL("../../support/window-app.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kiko-nav-"));
const bin = join(dir, "bin");
const PWN = join(dir, "pwned");
const win = tmuxRunner(WIN, CONFIG, { ...cleanEnv(), PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":") });
const outer = tmuxRunner(OUTER, CONFIG, cleanEnv());
/** Whether this tmux gives the window the classic look (3.8 and later). */
const CLASSIC = await classicLook(win);
const COLS = 120;
const ROWS = 40;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(8000, 60);
const screen = () => outer(["capture-pane", "-p", "-t", "=outer:"]);
const layout = () => layoutOf(win);
const stage = async () => (await layout()).view?.stage ?? null;
const acts = () =>
  existsSync(join(dir, "acts.log"))
    ? readFileSync(join(dir, "acts.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const said = (c: object) => appendFileSync(join(dir, "control.jsonl"), `${JSON.stringify(c)}\n`);
/** What the list's stdin got, chunk by chunk (the stand-in app keeps it: tests/support/window-app.ts). */
const raw = (): string[] =>
  existsSync(join(dir, "raw.log"))
    ? readFileSync(join(dir, "raw.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
/**
 * A key typed into your terminal (tmux key names: C-Space, Up…). Escape as the byte a terminal
 * sends for it: the outer tmux would send it as CSI 27 u (extended keys), which a terminal doesn't.
 */
const typeKeys = (...keys: string[]) => (keys.length === 1 && keys[0] === "Escape" ? outer(["send-keys", "-t", "=outer:", "-H", "1b"]) : outer(["send-keys", "-t", "=outer:", ...keys]));
/** A menu's popup on your terminal: its hint line (the whole menu's and a search's). */
const MENU_HINT = "↑↓ move · ⏎ pick · Esc";
/**
 * As typeKeys; Ctrl+Space (to open the menu) only once the last menu's popup is gone. A pick moves
 * the keyboard before the popup's program ends and tmux closes it, and the Kiko key typed into
 * a popup still open closes that one instead (menu.ts `again`): under load that gap is long enough
 * for the next Ctrl+Space to land there, and no menu opens.
 */
async function key(...keys: string[]) {
  if (keys[0] === "C-Space") await until(screen, (t) => !t.includes(MENU_HINT), "the last menu closed");
  return typeKeys(...keys);
}
/** A click (or right-click) at column `x`, row `y` of your terminal (1-based), as the terminal reports it: press, release. */
const click = (x: number, y: number, button = 0) => outer(["send-keys", "-t", "=outer:", "-H", ...[...Buffer.from(`\x1b[<${button};${x};${y}M\x1b[<${button};${x};${y}m`)].map((b) => b.toString(16))]);
/** The row of your terminal (1-based) whose list part (its left `width` columns) says `label`. */
async function rowOf(label: string, width = 30): Promise<number> {
  const rows = (await screen()).split("\n");
  const i = rows.findIndex((r) => r.slice(0, width).includes(label));
  assert.ok(i >= 0, `${label} in the list:\n${rows.join("\n")}`);
  return i + 1;
}
const snapshot = (what: string, text: string) => console.log(`\n── capture-pane -p: ${what} ──\n${text.replace(/\s+$/, "")}\n──`);

describe("getting around the Kiko window, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(async () => {
    mkdirSync(bin);
    if (["/usr/bin", "/bin", dirname(process.execPath)].some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'FAKE CLAUDE in %s\\n' "\${PWD##*/}"\nexec cat > /dev/null\n`, { mode: 0o755 });
    for (const p of ["pixie", "lacy"]) mkdirSync(join(dir, p));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ server: WIN, projects: [join(dir, "pixie"), join(dir, "lacy")], claude: join(bin, "claude"), outside: true }));
    // A session already running (pixie), and one whose name (as Kiko knows it: its border's) is made to look like tmux's formats.
    await win(["new-session", "-d", "-s", "pixie", "-c", join(dir, "pixie"), "-x", "90", "-y", "39", "--", join(bin, "claude")]);
    await openWindow(win, () => ({ argv: [process.execPath, "--no-warnings", APP, dir], discard() {} }), dir, { width: COLS, height: ROWS });
    const evil = (await win(["new-session", "-d", "-s", "evil", "-c", join(dir, "lacy"), "-P", "-F", "#{pane_id}", "--", "/bin/sh", "-c", "exec cat"])).trim();
    await win(["set-option", "-p", "-t", evil, "@kiko-name", `x#(touch ${PWN})#[fg=red]`]);
    // Your terminal: a pane of the outer tmux running a tmux client attached to the window.
    await outer([
      "new-session",
      "-d",
      "-s",
      "outer",
      "-x",
      String(COLS),
      "-y",
      String(ROWS + 1),
      "--",
      "/bin/sh",
      "-c",
      `env -u TMUX '${TMUX}' -u -L ${WIN} -f '${CONFIG}' attach -t =${WINDOW}; sleep 600`,
    ]);
    await until(acts, (a) => a.some((x) => x.started), "the stand-in app").catch(async (err) => {
      const list = (await layout()).view?.list?.id ?? `=${WINDOW}:`;
      throw new Error(`${err.message}\nits pane:\n${await win(["capture-pane", "-p", "-t", list]).catch(String)}`);
    });
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("opens on Kiko's page; the list: Kiko 0, the sessions numbered, the outside one under EXTERNAL, a new one", async () => {
    const s = await until(screen, (t) => t.includes("what you said, what Kiko said, where your words went") && t.includes("notes") && t.includes("+  new session"), "the page and the list");
    assert.equal((await stage())?.viewing, PAGE_ID);
    // The page's header: one line under the title (which names Kiko), no state while it's ready, then the rule.
    const top = s.split("\n");
    const at = top.findIndex((l) => l.includes("what you said, what Kiko said"));
    assert.ok(!s.includes("your conversation with Kiko") && !top[at].includes("ready"), top[at]);
    assert.match(top[at - 1], CLASSIC ? /┌── Kiko ─/ : /Kiko/);
    assert.match(top[at + 1], /────/);
    snapshot("the top of the stage: Kiko's page", top.slice(0, at + 3).join("\n"));
    const hint = "c new";
    for (const part of ["0   ▪  Kiko", "1   ✻  pixie", "2   ✻  x#(touch", "── EXTERNAL", "3   ✻  notes", "+  new session (c)", hint]) assert.ok(s.includes(part), `${part} in:\n${s}`);
    if (CLASSIC) {
      // No header: the boxes on the first line. The line under them: Kiko's state, no logo, no talk hint; the list's keys at the right.
      const lines = (await until(screen, (t) => /\. repeat · m mute · ⌃Space menu\s*$/.test(t), "the line")).replace(/\n$/, "").split("\n");
      const last = lines.at(-1)!;
      assert.match(lines[0], /^┌── Sessions ─+┐┌── /);
      assert.match(last, /^ ready( · \d+ working)? {2,}\S/, "ready on the left");
      assert.ok(!last.includes("to talk"), last);
      for (const part of ["┌── Sessions ", "┌── Kiko ", "│ 1   ✻  pixie", "│     ● idle"]) assert.ok(s.includes(part), `${part} in:\n${s}`);
    } else assert.match(s.trimEnd().split("\n").at(-1)!, /Kiko is ready.*hold right ⌥ to talk · ⌃Space menu/);
  });

  test("Kiko's page follows: what you said and what Kiko said, as they happen, with the time", async () => {
    said({ you: "tell pixie to run the tests" });
    said({ info: "→ typed into pixie" });
    said({ spoken: "Pixie's on it." });
    const s = await until(screen, (t) => t.includes("Pixie's on it."), "the page");
    for (const part of ["› You · ", "tell pixie to run the tests", "→ typed into pixie", "♪ Kiko · ", "── Kiko started"]) assert.ok(s.includes(part), `${part} in:\n${s}`);
    snapshot("the window: the list and Kiko's page", s);
  });

  test("Ctrl+Space: the menu (the pages by number, the commands with their keys, how to use it); the page shown highlighted; a number goes there at once", async () => {
    // Tab's words: where it goes from the side that has the keyboard.
    const tabWords = (await layout()).view!.list!.active ? "Go to the session →" : "Go to the list ←";
    await key("C-Space");
    const s = await until(screen, (t) => t.includes("Previous session") && t.includes("Quit Kiko…"), "the menu");
    for (const part of [
      "▸ Kiko",
      "pixie",
      "notes (outside)",
      tabWords,
      "Next session",
      "Previous session",
      "Last session",
      "New session…",
      "Settings",
      "Hide window (keeps listening)",
      "/ search · ↑↓ move · ⏎ pick · Esc closes",
      "talk: hold right ⌥",
      "Quit Kiko…",
    ]) {
      assert.ok(s.includes(part), `${part} in:\n${s}`);
    }
    assert.ok(!s.includes("Switch list ⇄ session"), "the side was known");
    // Tab right under the pages: before the commands (and the session's group, when there is one).
    const rowOf = (words: string) => s.split("\n").findIndex((l) => l.includes(words));
    assert.ok(rowOf("notes (outside)") < rowOf(tabWords) && rowOf(tabWords) < rowOf("Next session"), s);
    for (const [label, k] of [
      ["Next session", "n"],
      ["Previous session", "p"],
      ["Last session", "l"],
      ["New session…", "c"],
      ["Settings", "s"],
      ["Hide window (keeps listening)", "d"],
    ]) {
      assert.match(s, new RegExp(`${label.replace(/[()…]/g, ".")} +${k} `), `${label}'s key`);
    }
    // Kiko's page shown: no session's actions in it (left out, not greyed).
    assert.ok(!s.includes("Close this session…") && !s.includes("Interrupt (Escape)"), s);
    // The page shown (Kiko's) highlighted to start with: reversed. Only the terminal's palette:
    // no fixed (256-colour or RGB) background anywhere in the popup, tmux's grey included.
    const styled = (await outer(["capture-pane", "-p", "-e", "-t", "=outer:"])).split("\n");
    assert.ok(
      styled.find((l) => l.includes("▸ Kiko") && /\x1b\[[0-9;]*\b7m/.test(l)),
      "Kiko's line highlighted",
    );
    const popup = styled.filter((l) => /(Previous session|Next session|Quit Kiko…|▸ Kiko +0|↑↓ move)/.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
    assert.ok(popup.length >= 4, styled.join("\n"));
    for (const l of popup) assert.ok(!/\x1b\[[0-9;]*\b48;[25];/.test(l), `a fixed background in the menu: ${JSON.stringify(l)}`);
    snapshot("the Ctrl+Space menu", s);
    await key("1");
    const pixie = await until(stage, (p) => p?.session === WINDOW && !p.role && p.cwd.endsWith("/pixie"), "pixie shown");
    assert.equal(pixie!.active, true, "the keyboard there");
    await until(screen, (t) => t.includes("FAKE CLAUDE in pixie") && !t.includes("Previous session"), "pixie on screen, the menu gone");
  });

  test("from inside the session: Ctrl+Space 0 the page; ↓ ↑ only move the highlight, Enter or Space picks; n p next and previous, l the last; Escape closes", async () => {
    const menu = async () => {
      await key("C-Space");
      await until(screen, (t) => t.includes("Previous session"), "the menu");
    };
    const isPixie = (p: Awaited<ReturnType<typeof stage>>) => !p?.role && p?.cwd.endsWith("/pixie") === true;
    await menu();
    await key("0");
    await until(stage, (p) => p?.viewing === PAGE_ID, "Kiko's page");
    // ↓ moves the highlight from the page shown (Kiko's) to pixie; nothing happens until Enter.
    await menu();
    await key("Down");
    await wait(300);
    assert.equal((await stage())?.viewing, PAGE_ID, "↓ alone shows nothing");
    assert.ok(await until(screen, (t) => t.includes("Previous session"), "the menu still open"));
    await key("Enter");
    await until(stage, isPixie, "↓ Enter: the next, pixie");
    // ↑ from pixie (highlighted, the one shown), then Space: Kiko's page.
    await menu();
    await key("Up");
    await key("Space");
    await until(stage, (p) => p?.viewing === PAGE_ID, "↑ Space: back up, the page");
    // n and p at once, round the ends; l the one shown before.
    await menu();
    await key("n");
    await until(stage, isPixie, "n: the next, pixie");
    await menu();
    await key("p");
    await until(stage, (p) => p?.viewing === PAGE_ID, "p: the previous, the page");
    await menu();
    await key("p");
    await until(stage, (p) => p?.viewing === "session:notes-id", "p from the first: round to the last, notes");
    await menu();
    await key("l");
    await until(stage, (p) => p?.viewing === PAGE_ID, "l: the one before, the page");
    await menu();
    await key("l");
    await until(stage, (p) => p?.viewing === "session:notes-id", "l again: flips back");
    await menu();
    await key("1");
    await until(stage, isPixie, "a number: at once");
    await menu();
    await key("Escape");
    await until(screen, (t) => !t.includes("Previous session"), "closed");
    const steps = acts()
      .filter((a) => a.action === "step" || a.action === "last")
      .map((a) => a.action);
    assert.deepEqual(steps.slice(-5), ["step", "step", "step", "last", "last"]);
  });

  test("Ctrl+Space / searches: a search line, the list narrowed as you type (no letter acting), Enter shows the page found; Escape clears it, then closes", async () => {
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    assert.ok((await screen()).includes("/ search · ↑↓ move · ⏎ pick · Esc closes"), "the hint says how");
    // n would be Next session, o and t Trust: here they're the search's.
    await key("/", "n", "o", "t");
    const s = await until(screen, (t) => t.includes("/ not▏") && !t.includes("Previous session"), "the search");
    snapshot('the Ctrl+Space menu, searching for "not"', s);
    assert.ok(s.includes("notes (outside)") && s.includes("↑↓ move · ⏎ pick · Esc clears"), s);
    // Escape: the whole menu again; typed again, then Enter: the page found.
    await key("Escape");
    await until(screen, (t) => t.includes("Previous session") && !t.includes("/ not▏"), "the whole menu again");
    await key("/", "n", "o", "t");
    await until(screen, (t) => t.includes("/ not▏"), "the search again");
    await key("Enter");
    await until(stage, (p) => p?.viewing === "session:notes-id", "notes' page shown");
    await until(screen, (t) => !t.includes("/ not▏"), "the menu gone");
    // Escape twice: cleared, then closed.
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    // Nothing a name or folder here can hold: a temporary folder's random letters (in the session
    // names) can hold three q's, in order, which the search matches.
    await key("/", "%", "%", "%");
    await until(screen, (t) => t.includes("nothing matches"), "nothing matches");
    await key("Escape");
    await until(screen, (t) => t.includes("Previous session"), "the whole menu again");
    await key("Escape");
    await until(screen, (t) => !t.includes("Previous session"), "closed");
  });

  test("Ctrl+Space with a session shown: its actions under its name (r, i, x); ↓ reaches them; i interrupts at once, x asks first; an outside one's page has those it can do there", async () => {
    const isPixie = (p: Awaited<ReturnType<typeof stage>>) => !p?.role && p?.cwd.endsWith("/pixie") === true;
    const menu = async () => {
      await key("C-Space");
      return until(screen, (t) => t.includes("Previous session"), "the menu");
    };
    await menu();
    await key("1");
    await until(stage, isPixie, "pixie shown");
    const s = await menu();
    snapshot("the Ctrl+Space menu, pixie shown", s);
    assert.match(s, /─ pixie ─/, "headed with its name");
    for (const [label, k] of [
      ["Rename…", "r"],
      ["Interrupt \\(Escape\\)", "i"],
      ["Close this session…", "x"],
    ])
      assert.match(s, new RegExp(`${label} +${k} `), `${label}'s key`);
    // i: asked of the app at once (no question).
    await key("i");
    await until(acts, (a) => a.some((x) => x.action === "interrupt" && x.sessionId === "pixie"), "interrupt asked for pixie");
    await until(screen, (t) => !t.includes("Previous session"), "the menu closed");
    // x: the question first; n: nothing.
    await menu();
    await key("x");
    await until(screen, (t) => t.includes("Close pixie? Claude Code ends there."), "the question");
    await key("n");
    await until(screen, (t) => t.includes("Close this session…"), "back to the menu");
    // The highlight moves over them: on Close (picked, then not), ↑ ↑ is Rename….
    await key("Up");
    await key("Up");
    const styled = (await outer(["capture-pane", "-p", "-e", "-t", "=outer:"])).split("\n");
    assert.ok(
      styled.some((l) => l.includes("Rename…") && /\x1b\[[0-9;]*\b7m/.test(l)),
      `↑ reaches Rename…\n${styled.join("\n")}`,
    );
    await key("Escape");
    await until(screen, (t) => !t.includes("Previous session"), "closed");
    assert.ok(!acts().some((a) => a.action === "close"), "nothing closed");
    // An outside session's conversation: what can be done to it there (a Ghostty window found by its
    // title: rename and interrupt; its process not known: no Close), and the menu key twice not to it.
    await menu();
    await key("3");
    await until(stage, (p) => p?.viewing === "session:notes-id", "notes viewed");
    const out = await menu();
    assert.ok(out.includes("Rename…") && out.includes("Interrupt (Escape)") && !out.includes("Close this session…"), out);
    assert.ok(!out.includes(" again: "), out);
    await key("1");
    await until(stage, isPixie, "pixie again");
  });

  test("Tab, both ways: plain Tab in the list moves the keyboard to the session; Ctrl+Space Tab back from the session, and from the list to it; over Kiko's page too", async () => {
    const focused = async () => {
      const v = (await layout()).view!;
      return v.list!.active ? "list" : v.stage!.active ? "stage" : "none";
    };
    for (const shown of ["1", "0"]) {
      await key("C-Space");
      await until(screen, (t) => t.includes("Previous session"), "the menu");
      await key(shown);
      await until(focused, (f) => f === "stage", `page ${shown} shown, focused`);
      // From the session (or the page): Ctrl+Space Tab, the list. Tab itself stays the session's.
      await key("C-Space");
      await until(screen, (t) => t.includes("Previous session") && t.includes("Go to the list ←"), "the menu, Tab to the list");
      await key("Tab");
      await until(focused, (f) => f === "list", `Ctrl+Space Tab to the list (over ${shown})`);
      // From the list: plain Tab, the session side.
      await key("Tab");
      await until(focused, (f) => f === "stage", `Tab in the list to the session side (over ${shown})`);
      // And Ctrl+Space Tab from the list too.
      await key("C-Space");
      await until(screen, (t) => t.includes("Previous session") && t.includes("Go to the list ←"), "the menu, Tab to the list");
      await key("Tab");
      await until(focused, (f) => f === "list", "back to the list");
      await key("C-Space");
      await until(screen, (t) => t.includes("Previous session") && t.includes("Go to the session →"), "the menu, Tab to the session");
      await key("Tab");
      await until(focused, (f) => f === "stage", "Ctrl+Space Tab from the list to the session side");
    }
    assert.ok(
      acts().some((a) => a.action === "focusStage"),
      "the list's Tab asked for it",
    );
  });

  test("a session's name never runs as a tmux format in the menu, the list or the bar", async () => {
    const name = `x#(touch ${PWN})#[fg=red]`;
    await key("C-Space");
    const s = await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("Escape");
    await until(screen, (t) => !t.includes("Previous session"), "the menu closed");
    // In the menu and the list as itself (cut to fit), never as a style or a command.
    assert.ok(s.split("\n").filter((l) => l.includes(name.slice(0, 12))).length >= 2, s);
    said({ permission: { id: "p0", sessionId: "evil", name, what: "run #(touch it)", risky: false } });
    await until(
      () => outer(["capture-pane", "-p", "-t", "=outer:"]),
      (t) => t.includes("⚠ x#(touch"),
      "its name on a card",
    );
    said({ permission: null });
    await until(screen, (t) => !t.includes("⚠ x#(touch"), "the card gone");
    // Its right-click menu: the name on the popup's border, as text.
    await click(6, await rowOf("x#(touch"), 2);
    const menu = await until(screen, (t) => t.includes("Rename…"), "its menu").catch((err) => {
      const logs = join(dir, "logs");
      const failed = existsSync(logs)
        ? readdirSync(logs).flatMap((f) =>
            readFileSync(join(logs, f), "utf8")
              .split("\n")
              .filter((l) => l.includes("window_failed")),
          )
        : [];
      throw new Error(`${err.message}\n${failed.join("\n")}\nacts: ${JSON.stringify(acts().slice(-6))}`);
    });
    assert.ok(menu.includes("─ x#(touch"), menu);
    await key("Escape");
    await until(screen, (t) => !t.includes("Rename…"), "closed");
    await wait(300);
    assert.equal(existsSync(PWN), false, "#( ran nothing");
  });

  test("clicks: an outside session's row shows its conversation, a session's row shows it, Kiko's row the page, the keyboard staying in the list; + new session the picker", async () => {
    await until(screen, (t) => !t.includes("Previous session") && !t.includes("⚠ x#("), "nothing open over the list");
    const listActive = async () => (await layout()).view!.list!.active;
    await click(5, await rowOf("notes"));
    const notes = await until(stage, (p) => p?.viewing === "session:notes-id", "the outside one's viewer");
    assert.equal(notes!.active, false, "the keyboard not there");
    assert.equal(await listActive(), true, "the keyboard in the list");
    const viewed = await until(
      screen,
      (t) => t.includes("Read-only · talk to it by voice") && t.includes("notes · in Ghostty") && t.includes("○ idle"),
      "its viewer on screen, titled with where it runs",
    );
    // Its title: the mark, the name, where it runs; under it the folder with the state on its right, then the rule; no name line.
    const top = viewed.split("\n");
    const at = top.findIndex((l) => l.includes("notes · in Ghostty"));
    assert.match(top[at], CLASSIC ? /┌── ✻  notes · in Ghostty ─/ : /notes · in Ghostty/);
    assert.match(top[at + 1], /\/.* {2,}○ idle/, "its folder (cut to fit), the state on its right");
    assert.match(top[at + 2], /────/);
    assert.ok(!viewed.includes("notes  in Ghostty"), "the old name line gone");
    snapshot("the top of the stage: an outside session", top.slice(0, at + 3).join("\n"));
    await click(5, await rowOf("pixie"));
    const pixie = await until(stage, (p) => !p?.role && p?.cwd.endsWith("/pixie") === true, "pixie");
    assert.equal(pixie!.active, false);
    assert.equal(await listActive(), true);
    await click(5, await rowOf("    Kiko"));
    await until(stage, (p) => p?.viewing === PAGE_ID, "the page");
    await click(5, await rowOf("+  new session"));
    await until(screen, (t) => t.includes("NEW SESSION IN"), "the picker");
    await key("Escape");
    await until(screen, (t) => !t.includes("NEW SESSION IN"), "the picker closed");
    const shown = acts()
      .filter((a) => a.action === "show")
      .map((a) => [a.page, a.focus ?? true]);
    assert.deepEqual(shown.slice(-3), [
      ["session:notes-id", false],
      ["session:pixie", false],
      [PAGE_ID, false],
    ]);
  });

  test("picking in the list previews: a number, ↓ ↑ (↓ held too), n p, each page shown with the keyboard staying in the list; Enter or → goes in; Ctrl+Space and a number still goes there", async () => {
    await until(screen, (t) => !t.includes("Previous session") && !t.includes("NEW SESSION IN"), "nothing open over the list");
    const focused = async () => {
      const v = (await layout()).view!;
      return v.list!.active ? "list" : v.stage!.active ? "stage" : "none";
    };
    const isPixie = (p: Awaited<ReturnType<typeof stage>>) => !p?.role && p?.cwd.endsWith("/pixie") === true;
    // The keyboard in the list: a click on Kiko's row (a preview: it stays there).
    await click(5, await rowOf("    Kiko"));
    await until(stage, (p) => p?.viewing === PAGE_ID, "the page");
    await until(focused, (f) => f === "list", "the list focused");
    await key("1");
    await until(stage, isPixie, "1: pixie shown");
    assert.equal(await focused(), "list", "1: the keyboard still in the list");
    // 3 (notes, outside: its viewer), then 1 again: the list keeps the keys.
    await key("3");
    await until(stage, (p) => p?.viewing === "session:notes-id", "3: notes' viewer");
    await key("1");
    await until(stage, isPixie, "1 again: pixie");
    assert.equal(await focused(), "list");
    // n p: the next and the previous, previewed too.
    await key("n");
    await until(stage, (p) => !p?.role && p?.cwd.endsWith("/lacy") === true, "n: the next");
    await key("p");
    await until(stage, isPixie, "p: pixie");
    assert.equal(await focused(), "list", "n p: the keyboard still in the list");
    // ↓ from pixie: the next (the evil-named one), ↑ back; ↓ held (many at once): it ends where the highlight does, and soon.
    await key("Down");
    await until(stage, (p) => !p?.role && p?.cwd.endsWith("/lacy") === true, "↓: the next (the evil-named one, in lacy's folder) shown");
    await key("Up");
    await until(stage, isPixie, "↑: pixie again");
    const before = acts().length;
    const held = Date.now();
    await key("-N", "6", "Down"); // pixie → evil → + new session (nothing) → notes → Kiko → pixie → evil
    const isEvil = (p: Awaited<ReturnType<typeof stage>>) => !p?.role && p?.cwd.endsWith("/lacy") === true;
    await until(stage, isEvil, "↓ held six times: the evil-named one, round the end", 4000);
    assert.ok(Date.now() - held < 4000, "kept up");
    await wait(400);
    assert.ok(isEvil(await stage()), "nothing stale shown after it");
    const previews = acts()
      .slice(before)
      .filter((a) => a.action === "show");
    assert.deepEqual(
      previews.map((a) => a.focus),
      [false, false, false, false, false],
      JSON.stringify(previews),
    );
    assert.equal(await focused(), "list");
    // Enter: into the one highlighted; Ctrl+Space Tab back; → the same.
    await key("Enter");
    await until(focused, (f) => f === "stage", "Enter: the keyboard in the session");
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session") && t.includes("Go to the list ←"), "the menu");
    await key("Tab");
    await until(focused, (f) => f === "list", "back to the list");
    await key("Up");
    await key("Right");
    await until(
      async () => (isPixie(await stage()) ? await focused() : "not yet"),
      (f) => f === "stage",
      "↑ →: pixie, the keyboard there",
    );
    // From the menu: a pick goes there (the keyboard with it).
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("0");
    await until(
      async () => ((await stage())?.viewing === PAGE_ID ? await focused() : "not yet"),
      (f) => f === "stage",
      "Ctrl+Space 0: the page, focused",
    );
  });

  test("the ☰ Kiko button at the bottom line's right end (classic look: the line's menu words): a click opens the same menu; a click elsewhere on the line does nothing", async () => {
    await until(screen, (t) => !t.includes("Previous session"), "no menu open");
    const rows = (await screen()).split("\n");
    const y = rows.length - [...rows].reverse().findIndex((r) => r.trim()); // the last row with anything on it: the bottom line
    const line = rows[y - 1];
    const x = CLASSIC ? line.lastIndexOf("⌃Space menu") + 1 : [...line].findIndex((ch) => ch === "☰") + 1;
    assert.ok(x > COLS / 2, `the button at the right end: ${JSON.stringify(line)}`);
    // ☰ and this flavour's name (a checkout's: Kiko Dev).
    assert.match(line, CLASSIC ? /⌃Space menu\s*$/ : new RegExp(`☰ ${TITLE}\\s*$`));
    const active = async () => (await layout()).view!;
    const before = await active();
    // Elsewhere on the line: nothing (in the classic look, the keyboard stays where it was too: the frame never takes it).
    await click(3, y);
    await wait(400);
    assert.ok(!(await screen()).includes("Previous session"), "no menu from the line's left end");
    if (CLASSIC) {
      assert.equal((await active()).frame?.active, false, "the frame never has the keyboard");
      assert.equal((await active()).list?.active, before.list?.active);
      // Nor its middle.
      await click(Math.floor(COLS / 2), y);
      await wait(300);
      assert.equal((await active()).frame?.active, false);
    }
    await click(x + 2, y);
    const s = await until(screen, (t) => t.includes("Previous session") && t.includes("Quit Kiko…"), "the menu, from the button");
    snapshot("the menu opened by the ☰ button", s);
    await key("Escape");
    await until(screen, (t) => !t.includes("Previous session"), "the menu closed");
  });

  test("right-click on a session: its menu (show, rename, interrupt, close; outside, those it can do there) where it was clicked", async () => {
    const y = await rowOf("pixie");
    await click(6, y, 2);
    const s = await until(screen, (t) => t.includes("Rename…") && t.includes("Interrupt (Escape)") && t.includes("Close this session…"), "its menu");
    snapshot("a session's right-click menu", s);
    const top = s.split("\n").findIndex((l) => l.includes("Show"));
    assert.ok(top >= y - 1 && top <= y + 2, `just below the row (${y}): ${top}`);
    assert.ok(/Show +⏎/.test(s), "Show is Enter");
    await key("Enter");
    await until(stage, (p) => !p?.role && p?.cwd.endsWith("/pixie") === true, "shown from its menu");
    await click(6, await rowOf("notes"), 2);
    const out = await until(screen, (t) => t.includes("╭─ notes") && t.includes("Interrupt (Escape)"), "an outside one's menu");
    assert.ok(out.includes("Rename…") && !out.includes("Close this session…") && !out.includes("outside: read-only here"), out);
    await key("Escape");
    await until(screen, (t) => !t.includes("╭─ notes"), "the menu closed");
  });

  test("r in the list renames the highlighted session (as its right-click Rename…), nothing on Kiko's row; . repeats", async () => {
    const focused = async () => ((await layout()).view!.list!.active ? "list" : "elsewhere");
    await until(screen, (t) => !t.includes("Previous session") && !t.includes("outside: read-only here"), "nothing open over the list");
    // The highlight on Kiko's row and the keyboard in the list: a click there (a preview).
    await click(5, await rowOf("    Kiko"));
    await until(stage, (p) => p?.viewing === PAGE_ID, "the page");
    await until(focused, (f) => f === "list", "the list focused");
    const before = acts().length;
    await key("r");
    await wait(300);
    assert.deepEqual(acts().slice(before), [], "r on Kiko's row: nothing");
    assert.ok(!(await screen()).includes("RENAME"));
    await key("Down");
    await key("r");
    const s = await until(screen, (t) => t.includes("RENAME pixie") && t.includes("› pixie"), "pixie's name to edit");
    snapshot("r in the list: renaming", s);
    // ↓ previewed pixie on its way.
    assert.deepEqual(
      acts()
        .slice(before)
        .map((a) => [a.action, a.sessionId ?? a.page]),
      [
        ["show", "session:pixie"],
        ["renaming", "pixie"],
      ],
    );
    await key("Escape");
    await until(screen, (t) => !t.includes("RENAME pixie"), "renaming cancelled");
    await key(".");
    await until(acts, (a) => a.at(-1)?.action === "repeat", ". repeats");
    assert.deepEqual(
      acts()
        .slice(before)
        .map((a) => [a.action, a.sessionId ?? a.page ?? null]),
      [
        ["show", "session:pixie"],
        ["renaming", "pixie"],
        ["renaming", null],
        ["repeat", null],
      ],
    );
  });

  test("one tap of m or ., one act: your terminal reporting each key let go (the kitty keyboard protocol: ESC [ 109 ; 1 : 3 u), tmux passing that on to the list, sets nothing off", async () => {
    await until(
      async () => (await layout()).view!.list!.active,
      (a) => a,
      "the list focused",
    );
    const before = acts().length;
    const read = raw().length;
    const typedRaw = (bytes: string) => outer(["send-keys", "-t", "=outer:", "-H", ...[...Buffer.from(bytes)].map((b) => b.toString(16))]);
    await key("m");
    await typedRaw("\x1b[109;1:3u");
    await key(".");
    await typedRaw("\x1b[46;1:3u");
    await until(
      () => raw().slice(read).join(""),
      (r) => r.includes("\x1b[46;1:3u"),
      "the releases at the list, as sent",
    );
    await wait(300);
    assert.deepEqual(
      acts()
        .slice(before)
        .map((a) => a.action),
      ["mute", "repeat"],
    );
  });

  test("c (Ctrl+Space c): the project picker, a new project and a scratch folder on top; typing narrows it, Enter starts claude there, shown and focused", async () => {
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("c");
    const s = await until(screen, (t) => t.includes("NEW SESSION IN") && t.includes("scratch folder"), "the picker");
    snapshot("the project picker", s);
    const rows = s.split("\n").map((l) => l.slice(0, 30));
    const at = (label: string) => rows.findIndex((l) => l.includes(label));
    assert.ok(at("+ new project") < at("◌ scratch folder") && at("◌ scratch folder") < at("pixie") && at("pixie") < at("lacy"), s);
    assert.equal((await layout()).view?.list?.active, true, "the keyboard in the list");
    await key("-l", "lac");
    await until(
      screen,
      (t) =>
        !t
          .slice(0, 2000)
          .split("\n")
          .some((l) => l.slice(0, 30).includes("pixie ")),
      "narrowed",
    );
    await key("Enter");
    const lacy = await until(stage, (p) => !p?.role && p?.cwd.endsWith("/lacy") === true, "a session in lacy, shown");
    assert.equal(lacy!.active, true);
    await until(screen, (t) => t.includes("FAKE CLAUDE in lacy"), "the fake claude in it");
    assert.deepEqual(
      acts()
        .filter((a) => a.action === "start")
        .at(-1)?.pick,
      { project: join(dir, "lacy") },
    );
  });

  test("a permission held by Kiko: a card at the bottom of the list; y from the list answers it; a click on n deny another", async () => {
    said({ permission: { id: "p1", sessionId: "pixie", name: "pixie", what: "run pnpm test", risky: false } });
    const s = await until(screen, (t) => t.includes("wants to run pnpm test") && t.includes("y allow"), "the card");
    snapshot("a permission card", s);
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("Tab");
    await until(
      async () => (await layout()).view?.list?.active,
      (a) => a === true,
      "the list focused",
    );
    await key("y");
    await until(acts, (a) => a.some((x) => x.action === "allow"), "allowed");
    await until(screen, (t) => !t.includes("wants to run pnpm test"), "the card gone");
    said({ permission: { id: "p2", sessionId: "pixie", name: "pixie", what: "delete the build folder", risky: true } });
    await until(screen, (t) => t.includes("n deny"), "another card");
    const rows = (await screen()).split("\n");
    const y = rows.findIndex((r) => r.slice(0, 30).includes("n deny"));
    await click(rows[y].indexOf("n deny") + 2, y + 1);
    await until(acts, (a) => a.some((x) => x.action === "deny"), "denied by a click");
    // n in the list with a card up: deny, and nothing else (not the next session).
    said({ permission: { id: "p3", sessionId: "pixie", name: "pixie", what: "run make", risky: false } });
    await until(screen, (t) => t.includes("wants to run make"), "a third card");
    const before = acts().length;
    await key("n");
    await until(acts, (a) => a.length > before, "n acted");
    await wait(200);
    assert.deepEqual(
      acts()
        .slice(before)
        .map((a) => a.action),
      ["deny"],
    );
    assert.ok(!(await screen()).includes("+ new session (n)"));
  });

  test("the list's width as you drag it, kept when the window resizes", async () => {
    const view = (await layout()).view!;
    // The column between the panes (1-based: the list's width + 1); in the classic look the list
    // box's right edge (its width with both borders, 1-based), and the stage's box follows it.
    const border = view.list!.width + (CLASSIC ? 2 : 1);
    const box = (v: typeof view | null) => (v?.list?.width ?? 0) + (CLASSIC ? 2 : 0);
    await outer([
      "send-keys",
      "-t",
      "=outer:",
      "-H",
      ...[...Buffer.from(`\x1b[<0;${border};10M\x1b[<32;${border + 6};10M\x1b[<32;${border + 12};10M\x1b[<0;${border + 12};10m`)].map((b) => b.toString(16)),
    ]);
    const dragged = await until(
      async () => (await layout()).view,
      (v) => (v?.listWidth ?? 0) > box(view),
      "the width kept",
    );
    assert.equal(box(dragged), dragged!.listWidth);
    if (CLASSIC) {
      // The stage's box beside it again, no gap, no overlap.
      const left = Number((await win(["display", "-p", "-t", dragged!.stage!.id, "#{pane_left}"])).trim());
      await until(
        async () => Number((await win(["display", "-p", "-t", (await layout()).view!.stage!.id, "#{pane_left}"])).trim()),
        (l) => l === dragged!.listWidth + 1,
        `the stage beside the list (it was at ${left})`,
      );
    }
    await outer(["resize-window", "-t", "=outer:", "-x", "140", "-y", String(ROWS + 1)]);
    await until(
      async () => (await layout()).view,
      (v) => v?.width === 140 && box(v) === dragged!.listWidth,
      "still the dragged width after a resize",
    );
    assert.ok((await win(["show-options", "-w", "-v", "-t", `=${WINDOW}:`, LIST_WIDTH])).trim().length > 0);
  });

  test("d hides the window (the window and the app go on); q asks, then quits", async () => {
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("d");
    await until(
      async () => (await layout()).view?.clients,
      (n) => n === 0,
      "this terminal detached",
    );
    assert.ok(!acts().some((a) => a.action === "quit"), "the app goes on");
    assert.ok((await layout()).view?.list && !(await layout()).view!.list!.dead);
    // Back again, then Quit.
    await outer(["respawn-pane", "-k", "-t", "=outer:", "--", "/bin/sh", "-c", `env -u TMUX '${TMUX}' -u -L ${WIN} -f '${CONFIG}' attach -t =${WINDOW}; sleep 600`]);
    await until(
      async () => (await layout()).view?.clients,
      (n) => n === 1,
      "attached again",
    );
    await key("C-Space");
    await until(screen, (t) => t.includes("Previous session"), "the menu");
    await key("q");
    await until(screen, (t) => t.includes("Press q again to quit"), "its hint first");
    await key("y");
    await until(acts, (a) => a.some((x) => x.action === "quit"), "quit");
    await until(
      async () => (await layout()).view?.list?.dead,
      (d) => d === true,
      "the app ended",
    );
  });
});
