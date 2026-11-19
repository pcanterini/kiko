// The Kiko window while the app starts (src/terminals/tmux/window.ts setStarting, STARTING): a new
// window says so from the first (both looks), each step is said in the session area and taken back
// once the app is ready, the placeholder's border named for it; the placeholder script draws it, and
// draws again on the SIGWINCH tmux sends; the app's side (src/ui/window-glue.ts starting) takes it
// back only after Kiko's page has taken the placeholder's place; the list's pane's own screen
// (src/ui/loading.ts). All on a pretend tmux, or (the script) a stand-in for one: never a real server.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { ui } from "../../../src/core/ui-store.ts";
import { WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { createCommands, LABEL, openWindow, PLACEHOLDER, ROLE, setStarting, STARTED_ONLY, STARTING, STEPS, VIEWING } from "../../../src/terminals/tmux/window.ts";
import { LIST_INDENT, startingGone, startingScreen } from "../../../src/ui/loading.ts";
import { PAGE_ID } from "../../../src/ui/nav.ts";
import { startWindow } from "../../../src/ui/window-glue.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";
import { valueWaits } from "../../support/until.ts";

const until = valueWaits(3000, 20);
const app = () => ({ argv: ["app"], discard() {} });
const dir = mkdtempSync(join(tmpdir(), "kiko-starting-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A new window on a pretend tmux: its list and its stage (the placeholder), and the view's options. */
async function window() {
  const t = new FakeTmux();
  await openWindow(t.run, app, "/code/kiko", { width: 120, height: 40 });
  const [list, stage] = t.panesOf(WINDOW);
  return { t, list, stage, opts: () => t.windows.get(t.panes.get(list)!.window)!.opts };
}

describe("the window says it's starting", () => {
  test('from the first: a new window\'s placeholder is named "starting" and the view says so (no step yet), in both looks', async () => {
    const { t, stage, opts } = await window();
    assert.equal(opts()[STARTING], STARTED_ONLY);
    assert.equal(t.panes.get(stage)!.opts[ROLE], "placeholder");
    assert.equal(t.panes.get(stage)!.opts[LABEL], "starting");
    // The placeholder is told the app's title, to say it.
    assert.equal(t.panes.get(stage)!.command.at(-1), "Kiko Dev");
    // The classic look's: the same, in its one run.
    const classic = createCommands(["app"], "/code/kiko", { width: 160, height: 45 }, undefined, true).join(" ");
    assert.ok(classic.includes(`set-option -w -t =${WINDOW}: ${STARTING} ${STARTED_ONLY}`), classic);
    assert.ok(classic.includes(`${LABEL} starting`), classic);
  });

  test("each step said, then taken back: the option, the placeholder's border, and tmux asked to signal it to draw again (nothing signalled here)", async () => {
    const { t, stage, opts } = await window();
    await setStarting(t.run, STEPS.voice);
    assert.equal(opts()[STARTING], "Starting the voice");
    assert.equal(t.panes.get(stage)!.opts[LABEL], "starting");
    const shell = t.shells.at(-1)!;
    assert.deepEqual(shell.slice(0, 4), ["run-shell", "-b", "-t", stage]);
    assert.match(shell[4], /^kill -WINCH #\{pane_pid\}/, "tmux fills in the pane's own process");
    // One run: the option and the signal together.
    assert.ok(t.calls.at(-1)!.includes(STARTING) && t.calls.at(-1)!.includes("run-shell"), t.calls.at(-1)!.join(" "));

    await setStarting(t.run, null);
    assert.equal(opts()[STARTING], undefined);
    assert.equal(t.panes.get(stage)!.opts[LABEL], "no session");
    assert.equal(t.shells.length, 2);
  });

  test("only placeholders are signalled: the list (the app) and a viewer never", async () => {
    const { t, list, stage } = await window();
    await t.run(["set-option", "-p", "-t", stage, ROLE, "viewer"]);
    await setStarting(t.run, STEPS.sessions);
    assert.equal(t.shells.length, 0);
    assert.notEqual(t.panes.get(list)!.opts[LABEL], "starting");
  });

  test("the app's side: a step said at once; ready, it's taken back only once Kiko's page has taken the placeholder's place", async () => {
    const { t, list, stage, opts } = await window();
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" }, sessions: [] });
    const glue = startWindow(t.run, list, "/run/page.jsonl");
    try {
      await glue.starting(STEPS.agents);
      assert.equal(opts()[STARTING], "Connecting to sessions");
      await glue.starting(null);
      await until(
        () => t.panes.get(stage)!.opts[VIEWING],
        (v) => v === PAGE_ID,
        "Kiko's page in the stage",
      );
      assert.equal(opts()[STARTING], undefined, "not starting any more");
      // The pane was the page's viewer by the time the option went: no placeholder left to say "No session shown here".
      assert.equal(t.panes.get(stage)!.opts[ROLE], "viewer");
      assert.notEqual(t.panes.get(stage)!.opts[LABEL], "no session");
    } finally {
      await glue.stop();
      ui.set(before);
    }
  });
});

// The stand-in tmux: answers `display -p -t <pane> '#{@kiko-<name>}'` from files in $KIKO_TEST_STATE, and nothing else.
const fakeTmux = join(dir, "tmux");
writeFileSync(fakeTmux, `#!/bin/sh\nfor last; do :; done\nname=\${last#\\#\\{@kiko-}\nname=\${name%\\}}\ncat "$KIKO_TEST_STATE/$name" 2>/dev/null\n`, { mode: 0o755 });

/**
 * The placeholder's script on the stand-in, its options (`values`, starting with a step) in a
 * state folder of its own (`set` changes them), what it draws in `bytes()`; `redraw` signals it as
 * tmux would. `stop` (in a finally) kills it and all it started and lets go of its output, so
 * nothing is left to keep the run from ending: on macOS a child being started just as its group
 * is killed can miss the signal (a sleep left so once held the pipe, and the whole run, for a day).
 */
function placeholder(values: Record<string, string> = {}, env: Record<string, string> = {}) {
  const state = mkdtempSync(join(dir, "state-"));
  const set = (next: Record<string, string | null>) => {
    for (const [name, value] of Object.entries(next)) {
      const file = join(state, name);
      if (value === null) rmSync(file, { force: true });
      else writeFileSync(file, `${value}\n`);
    }
  };
  set({ view: "1", starting: STEPS.build, ...values });
  // Its own process group, so the sleep it waits on goes with it.
  const sh = spawn("/bin/sh", [PLACEHOLDER, fakeTmux, "@kiko", "Kiko Dev"], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
    env: { PATH: process.env.PATH, TMUX_PANE: "%1", KIKO_TEST_STATE: state, ...env },
  });
  const exited = new Promise<void>((done) => sh.once("exit", () => done()));
  const chunks: Buffer[] = [];
  sh.stdout.on("data", (d: Buffer) => chunks.push(d));
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-sh.pid!, signal);
      return true;
    } catch {
      return false; // none left (or it never started)
    }
  };
  return {
    set,
    bytes: () => Buffer.concat(chunks),
    redraw: () => process.kill(sh.pid!, "SIGWINCH"),
    /** The script's own shell, killed alone (what it started stays). */
    killShell: () => process.kill(sh.pid!, "SIGKILL"),
    /** Whether its output has ended, within `ms`. */
    ended: (ms: number) => Promise.race([new Promise<boolean>((done) => sh.stdout.once("close", () => done(true))), wait(ms, false)]),
    async stop() {
      // The group again until it's empty (a second at most), its output let go of, then its end (a second at most).
      for (let end = Date.now() + 1000; group("SIGKILL") && Date.now() < end; ) await wait(10);
      sh.stdout.destroy();
      if (sh.exitCode === null && sh.signalCode === null) await Promise.race([exited, wait(1000)]);
    },
  };
}

describe("the placeholder's script, with a stand-in tmux", () => {
  test("starting: the title is starting, the step dim under it; no step yet: the title only; ready: what it always says; each drawn again on SIGWINCH", async () => {
    const p = placeholder({ "key-name": "⌃Space" });
    const out = () => p.bytes().toString("utf8");
    /** The last screen drawn (each draw clears first), without its colours. */
    const screen = () => (out().split("\x1b[2J").at(-1) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    try {
      // Each wait is for the whole screen: one being drawn is a part of it.
      await until(screen, (s) => s === "\n  Kiko Dev is starting…\n  Building the helpers…\n", "the starting screen, its step");
      assert.ok(out().includes("\x1b[2mBuilding the helpers…\x1b[0m"), "the step dim");
      const draws = () => out().split("\x1b[2J").length;
      const drawn = draws();

      p.set({ starting: STARTED_ONLY });
      p.redraw();
      await until(screen, (s) => draws() > drawn && s === "\n  Kiko Dev is starting…\n", "drawn again: no step yet");

      p.set({ starting: null });
      p.redraw();
      const ready = await until(screen, (s) => s.includes("⌃Space: the Kiko menu"), "drawn again: ready");
      assert.ok(ready.includes("No session shown here.") && !ready.includes("starting"), ready);
    } finally {
      await p.stop();
    }
  });

  test("what it waits on holds none of its output: its shell gone (what it started left behind), the output ends", async () => {
    const p = placeholder();
    try {
      await until(
        () => p.bytes().toString("utf8"),
        (s) => s.includes("Building the helpers…"),
        "the first draw",
      );
      p.killShell();
      assert.equal(await p.ended(2000), true, "the output ended (a sleep holding it kept the whole unit run from ending)");
    } finally {
      await p.stop();
    }
  });
});

describe('the placeholder\'s script, in any locale (the step line once came out as two "?")', () => {
  // macOS's /bin/sh (bash 3.2) in a UTF-8 locale took the first byte of "…" for part of a
  // variable's name: "$starting…" printed only 0x80 0xA6.
  const LOCALES: Record<string, Record<string, string>> = {
    "no locale": {},
    "LANG UTF-8": { LANG: "en_US.UTF-8" },
    "LC_ALL UTF-8": { LC_ALL: "en_US.UTF-8" },
    "LC_CTYPE UTF-8": { LC_CTYPE: "UTF-8" },
  };
  const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

  for (const [name, locale] of Object.entries(LOCALES)) {
    test(`${name}: every step, no step and ready (both looks) drawn as valid UTF-8, no U+FFFD, no "?"`, async () => {
      const p = placeholder({}, locale);
      const screen = () => plain(p.bytes().toString("utf8").split("\x1b[2J").at(-1) ?? "");
      const draw = async (values: Record<string, string | null>, done: (s: string) => boolean, what: string) => {
        p.set(values);
        p.redraw();
        return until(screen, done, what);
      };
      try {
        await until(screen, (s) => s === `\n  Kiko Dev is starting…\n  ${STEPS.build}…\n`, STEPS.build);
        for (const step of Object.values(STEPS)) await draw({ starting: step }, (s) => s === `\n  Kiko Dev is starting…\n  ${step}…\n`, step);
        await draw({ starting: STARTED_ONLY }, (s) => s === "\n  Kiko Dev is starting…\n", "no step yet");
        const ready = await draw({ starting: null }, (s) => s.includes("⌃Space: the Kiko menu") && s.endsWith("☰ Kiko at the bottom.\n"), "ready, tiled");
        assert.ok(ready.includes("or ↑ ↓ and Enter.") && ready.includes("“open a new session in …”."), ready);
        await draw({ look: "classic" }, (s) => s.includes("or click “⌃Space menu” at the bottom right."), "ready, classic");

        const all = p.bytes();
        // fatal: throws on any byte sequence that isn't UTF-8 (the 0x80 0xA6 left of a "…").
        const text = new TextDecoder("utf-8", { fatal: true }).decode(all);
        assert.ok(!text.includes("\uFFFD"), "no replacement character");
        assert.ok(!plain(text).includes("?"), "no question mark outside escape sequences");
      } finally {
        await p.stop();
      }
    });
  }

  test('no shell code anywhere puts non-ASCII text right after a bare $name (bash 3.2 reads it as part of the name: "${name}…")', () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = execFileSync("git", ["ls-files", "src", "bin", "scripts", "hooks"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(sh|ts|mjs|js)$/.test(f) || f.startsWith("bin/"));
    const bad = files.flatMap((f) =>
      readFileSync(join(root, f), "utf8")
        .split("\n")
        .flatMap((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(bad, []);
  });
});

describe("the list's pane while the app starts (loading.ts)", () => {
  const plain = (s: string) => s.replace(/\x1b(\[[0-9;?]*[A-Za-z]|[78])/g, "");
  test('cleared, "Starting…" dim on the first row in the list\'s indent, the cursor hidden and left below it', () => {
    for (const look of ["tiled", "classic"] as const) {
      const s = startingScreen(look);
      assert.ok(s.startsWith("\x1b[?25l\x1b[H\x1b[2J"), "cursor hidden, cleared, from the top");
      assert.ok(s.includes(`${" ".repeat(LIST_INDENT[look])}\x1b[2mStarting…\x1b[0m`), look);
      assert.equal(plain(s), `${" ".repeat(LIST_INDENT[look])}Starting…\r\n\r\n`);
    }
  });
  test("a note (Kiko Dev's first start) under it, dim, a blank line between", () => {
    const s = plain(startingScreen("tiled", "Kiko Dev: your settings are copied\nKiko Dev: your keys too"));
    assert.equal(s, "  Starting…\r\n\r\n  Kiko Dev: your settings are copied\r\n  Kiko Dev: your keys too\r\n\r\n");
  });
  test("taken back: the first row cleared where the cursor stays, the cursor shown again", () => {
    assert.equal(startingGone, "\x1b7\x1b[1;1H\x1b[2K\x1b8\x1b[?25h");
  });
});
