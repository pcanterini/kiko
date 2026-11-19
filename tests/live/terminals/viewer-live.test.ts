// An outside session's conversation in the Kiko window, against a real tmux: the window made on
// a throwaway server (`-L kiko-test-<random>`, never `-L kiko` nor the default one, killed
// afterwards whatever happens), a made-up transcript in a temp folder, and the real viewer
// (src/terminals/tmux/viewer-pane.ts) in the stage. What it draws is read back with `capture-pane -p`:
// the header, the conversation, new lines as the transcript grows, the header kept to what the app
// says, scrolling back without being pulled down, and a session shown after it putting it away.
// Nothing real starts: the window's list runs `cat`, the session shown is `cat`.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, openWindow, setViewerInfo, show, view } from "../../../src/terminals/tmux/window.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = `kiko-test-${randomBytes(4).toString("hex")}`;
const dir = mkdtempSync(join(tmpdir(), "kiko-viewer-"));
const transcript = join(dir, "notes-id.jsonl");
const win = tmuxRunner(SERVER, CONFIG, cleanEnv());

const until = valueWaits(8000, 50);
const stage = async () => (await layoutOf(win)).view?.stage ?? null;
let viewer = "";
const screen = () => win(["capture-pane", "-p", "-t", viewer]);

const ts = (s: number) => new Date(Date.parse("2026-10-29T10:00:00Z") + s * 1000).toISOString();
const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const user = (text: string, s: number) => line({ type: "user", message: { role: "user", content: text }, timestamp: ts(s) });
const assistant = (content: object[], s: number) => line({ type: "assistant", message: { role: "assistant", content }, timestamp: ts(s) });
const INFO = { name: "notes", where: "ghostty", status: "working", folder: "/Users/someone/git/notes", spoken: [] };

describe("an outside session's conversation in the window, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(async () => {
    writeFileSync(
      transcript,
      user("fix the login bug", 0) +
        assistant(
          [
            { type: "text", text: "Sure — I'll **look** at `auth.ts` first." },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } },
          ],
          5,
        ) +
        line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 passed" }] }, timestamp: ts(9) }) +
        assistant([{ type: "text", text: "## Done\n- fixed the **token** check\n- the tests pass" }], 12),
    );
    await openWindow(win, () => ({ argv: ["/bin/sh", "-c", "exec cat"], discard() {} }), dir, { width: 120, height: 40 });
  });
  after(() => {
    try {
      execFileSync(TMUX!, ["-L", SERVER, "kill-server"], { stdio: "ignore" });
    } catch {
      // gone already
    }
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, SERVER), { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("shown: the header, the conversation readable (no ** or backticks), the footer; only the transcript on its command line", async () => {
    assert.equal(await view(win, { id: "session:notes-id", path: transcript, name: "notes", place: "in Ghostty", info: JSON.stringify(INFO) }), "shown");
    viewer = (await until(stage, (p) => p?.role === "viewer", "the viewer in the stage"))!.id;
    const s = await until(screen, (t) => t.includes("the tests pass") && t.includes("● working"), "the conversation");
    // The header's first line: the folder · last active, the state on its right; the name and where it runs are on the border.
    assert.match(s.split("\n")[0], /^ ~\/git\/notes · last active .+ {2,}● working ?$/);
    assert.match(s.split("\n")[1], /^─+$/);
    assert.ok(!s.includes("notes  in Ghostty"), s);
    const border = await win(["display", "-p", "-t", viewer, "#{E:pane-border-format}"]);
    assert.match(border.replace(/#\[[^\]]*\]/g, ""), /notes · in Ghostty/);
    for (const text of [
      "~/git/notes · last active",
      "› You",
      "fix the login bug",
      "● Claude",
      "Sure — I'll look at auth.ts first.",
      "⋯ ran 1 command",
      "Done",
      "• fixed the token check",
      "Read-only · talk to it by voice · its own window is in Ghostty",
      "⌃Space menu",
    ]) {
      assert.ok(s.includes(text), `${text} in:\n${s}`);
    }
    assert.ok(!s.includes("**") && !s.includes("`"), s);
    const started = await win(["display", "-p", "-t", viewer, "#{pane_start_command}"]);
    assert.ok(started.includes(transcript) && started.includes("viewer-pane.ts"), started);
    assert.ok(!/=/.test(started.replace(transcript, "")), `nothing like an environment value: ${started}`);
    console.log(`\n── capture-pane -p of the viewer ──\n${s.replace(/\s+$/, "")}\n──`);
  });

  test("following: a new message comes in at the bottom", async () => {
    appendFileSync(transcript, user("and the signup page?", 60) + assistant([{ type: "text", text: "On it." }], 65));
    await until(screen, (t) => t.includes("and the signup page?") && t.includes("On it."), "the new messages");
  });

  test("the header kept to what the app says (# and quotes as they are); ended, still readable", async () => {
    await setViewerInfo(
      win,
      viewer,
      JSON.stringify({ ...INFO, folder: `/Users/someone/git/notes #2 "beta"`, status: "waiting", spoken: [{ at: Date.parse(ts(70)), text: "Notes is on the signup page." }] }),
    );
    await until(screen, (t) => t.includes(`~/git/notes #2 "beta"`) && t.includes("◆ waits for you") && t.includes("Notes is on the signup page."), "the new header");
    await setViewerInfo(win, viewer, JSON.stringify({ status: "ended" }));
    const s = await until(screen, (t) => t.includes("■ ended"), "ended");
    assert.ok(s.includes("the session ended") && s.includes("On it."), s);
  });

  test("scrolled back: a new message doesn't pull the view down; End goes back", async () => {
    // More than a screen of it, so there's somewhere to scroll.
    appendFileSync(transcript, Array.from({ length: 20 }, (_, i) => user(`question ${i}`, 70 + i)).join(""));
    await until(screen, (t) => t.includes("question 19"), "a screenful more");
    await win(["select-pane", "-t", viewer]);
    for (let i = 0; i < 3; i++) await win(["send-keys", "-t", viewer, "Up"]);
    await until(screen, (t) => t.includes("scrolled back"), "scrolled back");
    appendFileSync(transcript, assistant([{ type: "text", text: "Signup fixed too." }], 90));
    const s = await until(screen, (t) => t.includes("↓ 1 new message"), "the new-message note");
    assert.ok(!s.includes("Signup fixed too."), s);
    await win(["send-keys", "-t", viewer, "End"]);
    await until(screen, (t) => t.includes("Signup fixed too.") && !t.includes("new message"), "back at the bottom");
  });

  test("a session shown after it: the viewer goes, a placeholder in that session's home", async () => {
    const session = (await win(["new-session", "-d", "-s", "pixie", "-c", dir, "-P", "-F", "#{pane_id}", "--", "/bin/sh", "-c", "exec cat"])).trim();
    assert.equal(await show(win, session), "shown");
    assert.equal((await stage())?.id, session);
    const home = (await layoutOf(win)).panes.find((p) => p.id === viewer)!;
    assert.equal(home.session, "pixie");
    assert.equal(home.role, "placeholder");
    const cmd = await win(["display", "-p", "-t", viewer, "#{pane_start_command}"]);
    assert.ok(cmd.includes("placeholder.sh"), cmd);
  });
});

test("the viewer imports nothing that loads .env, reads settings or writes logs", () => {
  const root = fileURLToPath(new URL("../../../src/", import.meta.url));
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(root, "terminals/tmux/viewer-pane.ts"));
  const files = [...seen].map((f) => f.slice(root.length)).sort();
  assert.deepEqual(files, [
    "core/app-root.ts",
    "core/history.ts",
    "core/name.ts",
    "core/shell.ts",
    "core/text.ts",
    "terminals/tmux/classic.ts",
    "terminals/tmux/herdr.ts",
    "terminals/tmux/keys.ts",
    "terminals/tmux/pane-life.ts",
    "terminals/tmux/tmux.ts",
    "terminals/tmux/viewer-pane.ts",
    "terminals/tmux/window.ts",
    "ui/menu-view.ts",
    "ui/viewer.ts",
  ]);
});

test("the classic look's frame imports nothing that loads .env, reads settings or writes logs", () => {
  const root = fileURLToPath(new URL("../../../src/", import.meta.url));
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) walk(join(dirname(file), m[1]));
  };
  walk(join(root, "terminals/tmux/frame-pane.ts"));
  const files = [...seen].map((f) => f.slice(root.length)).sort();
  assert.deepEqual(files, [
    "core/app-root.ts",
    "core/name.ts",
    "core/shell.ts",
    "core/text.ts",
    "terminals/tmux/classic.ts",
    "terminals/tmux/frame-pane.ts",
    "terminals/tmux/herdr.ts",
    "terminals/tmux/keys.ts",
    "terminals/tmux/pane-life.ts",
    "terminals/tmux/tmux.ts",
    "terminals/tmux/window.ts",
    "ui/menu-view.ts",
  ]);
});
