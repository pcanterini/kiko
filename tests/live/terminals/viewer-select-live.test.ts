// Selecting text in the Kiko window's conversation views (src/terminals/tmux/window.ts
// selectKeys), for real: the window on a throwaway tmux server, attached from a pane of a second
// throwaway one standing in for your terminal, and the mouse typed into that pane as SGR reports (a
// press, the motion with the button held, the release), which the window's client reads as a
// terminal's. Both servers' sockets are in a temp folder made first (TMUX_TMPDIR), never your
// tmux's nor Kiko's; each is checked to be there before it's killed. What a selection copies goes
// to a pretend pbcopy first in the servers' PATH, which writes it to a file: never your clipboard.
//
// A drag over a viewer selects (copy mode, though the viewer asks for the mouse) and letting go
// copies it and leaves copy mode; a double click copies a word. Over a session whose program asks
// for the mouse, a drag is the program's, as before; over the list (it doesn't ask), copy mode as before.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, openWindow, show, view } from "../../../src/terminals/tmux/window.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
// In /tmp, short: the sockets are made in it, and a Unix socket's path has to fit in 103 bytes (the tests' own TMPDIR is too deep).
const dir = realpathSync(mkdtempSync("/tmp/kksel-"));
const sockets = join(dir, "t");
const bin = join(dir, "bin");
const copied = join(dir, "copied");
const got = join(dir, "got");
const run = randomBytes(4).toString("hex");
const WIN = `kiko-test-${run}-select`;
const OUTER = `kiko-test-${run}-selectouter`;
const PATH = [bin, dirname(process.execPath), ...(TMUX ? [dirname(TMUX)] : []), "/usr/bin", "/bin"].join(":");
const env = { ...cleanEnv(), PATH, TMUX_TMPDIR: sockets };
const win = tmuxRunner(WIN, CONFIG, env);
const outer = tmuxRunner(OUTER, CONFIG, env);
const COLS = 120;
const ROWS = 36;

const until = valueWaits(8000, 50);
const ts = (s: number) => new Date(Date.parse("2026-10-29T10:00:00Z") + s * 1000).toISOString();
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const transcript = join(dir, "notes-id.jsonl");

/** The mouse in your terminal (0-based cells): SGR reports typed into it. */
const sgr = (b: number, x: number, y: number, up = false) => outer(["send-keys", "-t", "=outer:", "-l", `\x1b[<${b};${x + 1};${y + 1}${up ? "m" : "M"}`]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pane's place in the window (its inside) and whether it's in a mode (copy mode). */
async function pane(id: string) {
  const [left, top, mode] = (await win(["display", "-p", "-t", id, "#{pane_left} #{pane_top} #{pane_in_mode}"])).trim().split(" ").map(Number);
  return { left, top, inMode: mode === 1 };
}

/** Where `text` is in pane `id` (its row and column, from what tmux shows of it). */
async function find(id: string, text: string) {
  const rows = (await win(["capture-pane", "-p", "-t", id])).split("\n");
  const row = rows.findIndex((r) => r.includes(text));
  assert.ok(row >= 0, `${text} in:\n${rows.join("\n")}`);
  return { row, col: [...rows[row].slice(0, rows[row].indexOf(text))].length };
}

/** What the pretend pbcopy got last, once it has. */
const copy = async () =>
  String(
    await until(
      () => (existsSync(copied) ? readFileSync(copied, "utf8") : null),
      (t) => t !== null,
      "a copy",
    ),
  );

/** Past tmux's double click time since the last click, so the next press is a single one. */
const CLICK_GAP_MS = 400;

/**
 * A drag in pane `id` along `row`, pressed at column `from`, let go at `to` (the selection stops
 * before the cell let go on, as copy mode's does): `during` runs with the button still held.
 */
async function drag(id: string, row: number, from: number, to: number, during?: () => Promise<void>) {
  await wait(CLICK_GAP_MS);
  const p = await pane(id);
  await sgr(0, p.left + from, p.top + row);
  for (let x = from + 1; x <= to; x++) await sgr(32, p.left + x, p.top + row);
  await during?.();
  await sgr(0, p.left + to, p.top + row, true);
}

/** `n` clicks in a row at a pane's `row` and `col`. */
async function clicks(id: string, row: number, col: number, n: number) {
  await wait(CLICK_GAP_MS);
  const p = await pane(id);
  for (let i = 0; i < n; i++) {
    await sgr(0, p.left + col, p.top + row);
    await sgr(0, p.left + col, p.top + row, true);
  }
}

/** Kills a throwaway server, after making sure its socket is the one in the temp folder. */
function kill(name: string) {
  const socket = join(sockets, `tmux-${process.getuid!()}`, name);
  if (!name.startsWith("kiko-test-") || !socket.startsWith(`${dir}/`) || !existsSync(socket)) return;
  try {
    execFileSync(TMUX!, ["-L", name, "kill-server"], { env: { PATH, TMUX_TMPDIR: sockets }, stdio: "ignore" });
  } catch {
    // gone already
  }
}

describe("selecting a conversation's text in the window, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  let viewer = "";

  before(async () => {
    mkdirSync(sockets, { mode: 0o700 });
    mkdirSync(bin);
    writeFileSync(join(bin, "pbcopy"), `#!/bin/sh\ncat > '${copied}.part' && mv '${copied}.part' '${copied}'\n`, { mode: 0o755 });
    writeFileSync(
      transcript,
      line({ type: "user", message: { role: "user", content: "fix the login bug" }, timestamp: ts(0) }) +
        line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done: the token check is fixed." }] }, timestamp: ts(5) }),
    );
    await openWindow(win, () => ({ argv: ["/bin/sh", "-c", "exec cat"], discard() {} }), dir, { width: COLS, height: ROWS });
    // The copy goes to the pretend pbcopy, or the test goes no further: never your clipboard.
    const which = (await win(["run-shell", "command -v pbcopy"])).trim();
    assert.equal(which, join(bin, "pbcopy"), "the pretend pbcopy first in the server's PATH");
    assert.equal((await win(["show-options", "-sv", "copy-command"])).trim(), "pbcopy");
    await outer(["new-session", "-d", "-s", "outer", "-x", String(COLS), "-y", String(ROWS), "--", "/bin/sh", "-c", `unset TMUX; exec '${TMUX}' -u -L '${WIN}' attach-session -t '=${WINDOW}'`]);
    await until(
      () => win(["list-clients", "-F", "#{client_name}"]),
      (t) => t.trim().length > 0,
      "your terminal attached",
    );
    assert.equal(
      await view(win, { id: "session:notes-id", path: transcript, name: "notes", info: JSON.stringify({ name: "notes", where: "ghostty", status: "idle", folder: dir, spoken: [] }) }),
      "shown",
    );
    viewer = (await until(
      async () => (await layoutOf(win)).view?.stage ?? null,
      (p) => p?.role === "viewer",
      "the viewer in the stage",
    ))!.id;
    await until(
      () => win(["capture-pane", "-p", "-t", viewer]),
      (t) => t.includes("fix the login bug"),
      "the conversation",
    );
    // The viewer asks for the mouse (the wheel): what made a drag its own before.
    await until(
      () => win(["display", "-p", "-t", viewer, "#{mouse_any_flag}"]),
      (t) => t.trim() === "1",
      "the viewer asking for the mouse",
    );
  });
  after(() => {
    kill(OUTER);
    kill(WIN);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a drag over the viewer selects, though it asks for the mouse; letting go copies it and leaves copy mode", async () => {
    rmSync(copied, { force: true });
    const at = await find(viewer, "fix the login bug");
    await drag(viewer, at.row, at.col, at.col + "fix the login bug".length, async () => {
      await until(async () => (await pane(viewer)).inMode, Boolean, "copy mode while the button's held");
    });
    assert.equal((await copy()).trim(), "fix the login bug");
    await until(
      async () => (await pane(viewer)).inMode,
      (m) => !m,
      "copy mode left",
    );
  });

  test("a double click on the viewer copies the word, a triple one the line", async () => {
    for (const [n, want] of [
      [2, "login"],
      [3, "fix the login bug"],
    ] as const) {
      rmSync(copied, { force: true });
      const at = await find(viewer, "login");
      await clicks(viewer, at.row, at.col + 2, n);
      assert.equal((await copy()).trim(), want);
      await until(
        async () => (await pane(viewer)).inMode,
        (m) => !m,
        "copy mode left",
      );
    }
  });

  test("the list (it doesn't ask for the mouse): a drag selects, as tmux does by default", async () => {
    const list = (await layoutOf(win)).view!.list!.id;
    await win(["send-keys", "-t", list, "-l", "hello from the list"]);
    await until(
      () => win(["capture-pane", "-p", "-t", list]),
      (t) => t.includes("hello from the list"),
      "the list's text",
    );
    rmSync(copied, { force: true });
    const at = await find(list, "hello");
    await drag(list, at.row, at.col, at.col + 5);
    assert.equal((await copy()).trim(), "hello");
  });

  test("a session whose program asks for the mouse: a drag is its own, as before, no copy mode", async () => {
    // Asks for the buttons and their motion (SGR), and writes down what it gets.
    const program = `printf '\\033[?1002h\\033[?1006h'; stty raw -echo; exec cat > '${got}'`;
    const session = (await win(["new-session", "-d", "-s", "pixie", "-c", dir, "-P", "-F", "#{pane_id}", "--", "/bin/sh", "-c", program])).trim();
    assert.equal(await show(win, session), "shown");
    await until(
      () => win(["display", "-p", "-t", session, "#{mouse_any_flag}"]),
      (t) => t.trim() === "1",
      "the session asking for the mouse",
    );
    rmSync(copied, { force: true });
    await drag(session, 3, 2, 8, async () => {
      await until(
        () => (existsSync(got) ? readFileSync(got, "utf8") : ""),
        (t) => t.includes("\x1b[<32;"),
        "the drag's motion, the program's",
      );
      assert.equal((await pane(session)).inMode, false);
    });
    await until(
      () => readFileSync(got, "utf8"),
      (t) => /\x1b\[<0;\d+;\d+m/.test(t),
      "the release, the program's",
    );
    assert.equal((await pane(session)).inMode, false);
    await wait(300);
    assert.equal(existsSync(copied), false, "nothing copied");
  });
});
