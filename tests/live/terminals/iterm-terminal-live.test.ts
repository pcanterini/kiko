// iTerm's and Terminal's adapters (src/terminals/iterm/, src/terminals/terminal-app/) against the
// real apps. Opt-in only, one app at a time or both: it opens windows of its own in them (and macOS
// asks once whether the terminal you run it from may control them):
//   KIKO_LIVE_ITERM=1 KIKO_LIVE_TERMINAL=1 node --test --test-concurrency=1 tests/live/terminals/iterm-terminal-live.test.ts
// Each app gets two new windows of the test's own, each running a recorder (a raw-mode program asking
// for bracketed paste, as Claude Code does, that writes down every byte it's sent). Then: found by its
// process's tty and by its program and folder; one line and several typed into the first window while
// the second is in front, and into nothing else; Escape (iTerm); its screen read; and, with Finder in
// front, typing again without the app coming forward. What Terminal's `do script` sends after the
// words is written down and checked: it's what sends them to Claude Code. Then both windows close.
// Nothing else of yours is typed into or closed: only the test's own sessions, by their ids or ttys.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { appInstalled } from "../../../src/core/terminal-apps.ts";
import type { ScriptRunner } from "../../../src/platform/macos/apple-events.ts";
import { ITERM, itermDeps } from "../../../src/terminals/iterm/index.ts";
import { TERMINAL_APP, terminalDeps } from "../../../src/terminals/terminal-app/index.ts";
import { ttyTerminal, type TtyApp, type TtyDeps } from "../../../src/terminals/tty/index.ts";
import type { Findable, Place, Terminal } from "../../../src/terminals/types.ts";
import { valueWaits } from "../../support/until.ts";

const until = valueWaits(10_000, 100);

// This test's own osascript (the unit tests refuse it; here you asked for it): the terminal you run it from is what macOS asks about.
const osascript: ScriptRunner = (script, args = [], timeoutMs = 60_000) =>
  new Promise((resolve, reject) =>
    execFile("osascript", ["-e", script, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(String(stdout)))),
  );

// A raw-mode program asking for bracketed paste, as Claude Code does: each read written down (latin1, JSON) in `out`.
const RECORDER = `
import { appendFileSync } from "node:fs";
const out = process.argv[2];
process.stdout.write("\\u001b[?2004hkiko recorder ready\\n");
process.stdin.setRawMode(true);
process.stdin.on("data", (d) => appendFileSync(out, JSON.stringify(d.toString("latin1")) + "\\n"));
setTimeout(() => { process.stdout.write("\\u001b[?2004l"); process.exit(0); }, 180000);
`;

const front = () => {
  const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  return execFileSync("lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" }).trim();
};

function live(app: TtyApp, deps: TtyDeps, wanted: boolean, close: (handle: string) => Promise<unknown>, bundle: string) {
  const skip =
    process.platform !== "darwin"
      ? "macOS only"
      : !wanted
        ? `opt-in: KIKO_LIVE_${app.id.toUpperCase()}=1 (it opens windows in ${app.name})`
        : !appInstalled(app.id)
          ? `${app.name} isn't installed`
          : false;

  describe(`${app.name}, for real`, { skip }, () => {
    const terminal: Terminal = ttyTerminal(app, deps);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `kiko-${app.id}-`)));
    const recorder = join(dir, "recorder.mjs");
    const windows: Array<{ handle: string; out: string; place?: Place }> = [];
    const reads = (out: string): string[] => {
      try {
        return readFileSync(out, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const findable = (fields: Partial<Findable>): Findable => ({ sessionId: "live", cwd: dir, kind: "interactive", desktop: false, titles: [], terminal: app.id, ...fields });

    before(async () => {
      writeFileSync(recorder, RECORDER);
      for (const n of [1, 2]) {
        const out = join(dir, `out-${n}.jsonl`);
        let handle = "";
        await terminal.open!(dir, { program: process.execPath, args: [recorder, out] }, (h) => (handle = h));
        const place = await until(
          () => terminal.placeIn!(handle),
          (p) => p !== null,
          `the recorder in front in window ${n}`,
        );
        await until(
          () => terminal.screen!(handle).then((s) => s ?? ""),
          (s) => s.includes("kiko recorder ready"),
          "the recorder ready",
        );
        windows.push({ handle, out, place: place! });
      }
    });

    after(async () => {
      for (const w of windows) await close(w.handle).catch(() => "");
    });

    test("found by its process's tty, and by its program and folder; a process on no tab of it isn't", async () => {
      const [a] = windows;
      const found = await terminal.find(Promise.resolve([findable({ pid: a.place!.pid }), findable({ sessionId: "nowhere", pid: process.pid })]));
      assert.deepEqual(found.get("live"), { place: a.place, mapping: "process" });
      assert.equal(found.has("nowhere"), false, "this test's own process isn't in that app");
      // By program: both windows run node in this folder, so it's not guessed; the one it was opened in, it is.
      const byProgram = await terminal.find(Promise.resolve([findable({ pid: undefined, program: "node", terminal: undefined })]));
      assert.equal(byProgram.get("live")?.mapping, "ambiguous");
      const hinted = await terminal.find(Promise.resolve([findable({ pid: undefined, program: "node", terminal: undefined, pane: a.handle })]));
      assert.deepEqual(hinted.get("live"), { place: a.place, mapping: "process" });
    });

    test("one line into the first window while the second is in front: it gets it, then Enter; the second nothing", async () => {
      const [a, b] = windows;
      assert.deepEqual(await terminal.type(a.place!, "hello from kiko"), { sent: true });
      const got = await until(
        () => reads(a.out).join(""),
        (s) => s.includes("hello from kiko") && /[\r\n]$/.test(s),
        "the words and Enter",
      );
      if (app.words === "then-enter") {
        assert.deepEqual(reads(a.out), ["hello from kiko", "\r"], "the words as typed, then Enter on its own");
      } else {
        // Terminal's `do script`: the words as one bracketed paste, then its own Return. A Return (\r) is
        // Enter to Claude Code and Codex; a line feed (\n) would be a new line in their prompt, not a send.
        assert.equal(got, "\u001b[200~hello from kiko\u001b[201~\r", `what Terminal sent: ${JSON.stringify(got)}`);
      }
      assert.deepEqual(reads(b.out), []);
    });

    test("several lines: one bracketed paste", async () => {
      const [a] = windows;
      const before = reads(a.out).length;
      assert.deepEqual(await terminal.type(a.place!, "first line\nsecond line"), { sent: true });
      const got = await until(
        () => reads(a.out).slice(before).join(""),
        (s) => s.includes("second line\u001b[201~") && /[\r\n]$/.test(s),
        "the paste and Enter",
      );
      assert.ok(got.startsWith("\u001b[200~first line\rsecond line\u001b[201~"), JSON.stringify(got));
    });

    test("with Finder in front: typed in all the same, and the app doesn't come forward", async () => {
      const [a] = windows;
      execFileSync("open", ["-a", "Finder"]);
      await until(front, (id) => id.includes("com.apple.finder"), "Finder in front");
      const before = reads(a.out).length;
      assert.deepEqual(await terminal.type(a.place!, "in the background"), { sent: true });
      await until(
        () => reads(a.out).slice(before).join(""),
        (s) => s.includes("in the background"),
        "the words",
      );
      assert.ok(!front().includes(bundle), `${app.name} came to the front`);
      assert.ok(front().includes("com.apple.finder"));
    });

    if (app.keys) {
      test("Escape: one ESC on its own", async () => {
        const [a] = windows;
        const before = reads(a.out).length;
        assert.deepEqual(await terminal.key!(a.place!, "escape"), { sent: true });
        await until(
          () => reads(a.out).slice(before),
          (r) => r.length === 1,
          "one read",
        );
        assert.deepEqual(reads(a.out).slice(before), ["\u001b"]);
      });
    }

    test("its process gone: refused, nothing typed", async () => {
      const gone: Place = { ...windows[1].place!, pid: 2 ** 22 + 11 };
      assert.deepEqual(await terminal.type(gone, "nope"), { sent: false, why: "its process has ended" });
      assert.deepEqual(reads(windows[1].out), []);
    });

    test("how long a find takes (both windows, by process)", async () => {
      const sessions = windows.map((w, i) => findable({ sessionId: `s${i}`, pid: w.place!.pid }));
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        const found = await terminal.find(Promise.resolve(sessions));
        times.push(performance.now() - start);
        assert.equal(found.get("s0")?.mapping, "process");
      }
      times.sort((x, y) => x - y);
      console.log(`${app.name} find(): median ${times[10].toFixed(1)} ms, fastest ${times[0].toFixed(1)}, slowest ${times[19].toFixed(1)} (direct osascript, not the helper app)`);
    });
  });
}

// Closing only the test's own: iTerm's session by its id, Terminal's window holding the tab with its tty.
const closeIterm = (id: string) =>
  osascript(
    `on run argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with k from 1 to (count of sessions of t)
          if (id of session k of t) is (item 1 of argv) then
            close (session k of t)
            return "closed"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run`,
    [id],
  );
const closeTerminal = (tty: string) =>
  osascript(
    `on run argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with k from 1 to (count of tabs of w)
          if (tty of tab k of w) is (item 1 of argv) then
            close w saving no
            return "closed"
          end if
        end repeat
      end try
    end repeat
  end tell
end run`,
    [tty],
  );

live(ITERM, itermDeps(osascript), process.env.KIKO_LIVE_ITERM === "1", closeIterm, "com.googlecode.iterm2");
live(TERMINAL_APP, terminalDeps(osascript), process.env.KIKO_LIVE_TERMINAL === "1", closeTerminal, "com.apple.Terminal");
