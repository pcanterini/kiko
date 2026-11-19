// Ghostty is scripted only when a session may run there (src/terminals/ghostty/index.ts
// ghosttyNeeded), so someone who never uses Ghostty is never asked whether Kiko may control it;
// which terminal a session runs in, from what its hook says (src/core/terminal-apps.ts); and
// where Kiko's own window opens (src/terminals/tmux/show.ts windowApp): the setting, else the
// terminal `kiko` was started from, else Ghostty, else Terminal. Fakes only: no osascript, no pgrep.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { launchTerminal, sessionTerminal } from "../../../src/core/terminal-apps.ts";
import { ghosttyTerminal, type GhosttyDeps } from "../../../src/terminals/ghostty/index.ts";
import { showSession, windowApp, type ShowDeps, type WindowApp } from "../../../src/terminals/tmux/show.ts";
import type { Findable } from "../../../src/terminals/types.ts";

const session = (id: string, fields: Partial<Findable> = {}): Findable => ({
  sessionId: id,
  cwd: `/code/${id}`,
  kind: "interactive",
  desktop: false,
  titles: [id],
  ...fields,
});

/** A Ghostty adapter on fakes, counting what it asked of Ghostty. */
function fakeGhostty(o: { installed?: boolean; running?: boolean; kikoInGhostty?: boolean } = {}) {
  const calls = { list: 0, running: 0 };
  const d: GhosttyDeps = {
    list: async () => {
      calls.list++;
      return [
        { id: "w1", title: "✳ a", cwd: "/code/a" },
        { id: "w2", title: "✳ b", cwd: "/code/b" },
      ];
    },
    type: async () => {},
    key: async () => {},
    open: async () => {},
    installed: () => o.installed ?? true,
    running: async () => {
      calls.running++;
      return o.running ?? true;
    },
    kikoInGhostty: () => o.kikoInGhostty ?? false,
  };
  return { ghostty: ghosttyTerminal(d), calls };
}

describe("Ghostty, only when a session may be there", () => {
  test("every session known to be elsewhere (iTerm, Terminal, Kiko's tmux): Ghostty is never asked anything", async () => {
    const { ghostty, calls } = fakeGhostty({ kikoInGhostty: true });
    const found = await ghostty.find(Promise.resolve([session("a", { terminal: "iterm" }), session("b", { terminal: "kiko-tmux" }), session("c", { terminal: "terminal" })]));
    assert.equal(found.size, 0);
    assert.deepEqual(calls, { list: 0, running: 0 });
    // Again, and again: no polling of Ghostty for nothing.
    await ghostty.find(Promise.resolve([session("a", { terminal: "iterm" })]));
    assert.deepEqual(calls, { list: 0, running: 0 });
  });

  test("no sessions at all, or only the desktop app's and background ones: nothing asked", async () => {
    const { ghostty, calls } = fakeGhostty();
    await ghostty.find(Promise.resolve([]));
    await ghostty.find(Promise.resolve([session("a", { desktop: true }), session("b", { kind: "background" })]));
    assert.deepEqual(calls, { list: 0, running: 0 });
  });

  test("a session its hook says is in Ghostty: Ghostty listed, and its window found", async () => {
    const { ghostty, calls } = fakeGhostty({ running: false });
    const found = await ghostty.find(Promise.resolve([session("a", { terminal: "ghostty" }), session("b", { terminal: "iterm" })]));
    assert.equal(calls.list, 1);
    assert.equal(calls.running, 0, "known to be there: Ghostty runs");
    assert.equal(found.get("a")?.place?.id, "w1");
    // The iTerm one isn't matched to a Ghostty window, even one in its folder.
    assert.equal(found.has("b"), false);
  });

  test("a session whose terminal isn't known yet: listed only while Ghostty runs (never started by asking)", async () => {
    const off = fakeGhostty({ running: false });
    assert.equal((await off.ghostty.find(Promise.resolve([session("a")]))).size, 0);
    assert.deepEqual(off.calls, { list: 0, running: 1 });
    const on = fakeGhostty({ running: true });
    assert.equal((await on.ghostty.find(Promise.resolve([session("a")]))).get("a")?.place?.id, "w1");
    assert.equal(on.calls.list, 1);
  });

  test("Kiko's own window in Ghostty: an unknown session is looked for there without asking whether Ghostty runs", async () => {
    const { ghostty, calls } = fakeGhostty({ kikoInGhostty: true });
    await ghostty.find(Promise.resolve([session("a")]));
    assert.deepEqual(calls, { list: 1, running: 0 });
  });

  test("Ghostty not installed: never asked, whatever the sessions say", async () => {
    const { ghostty, calls } = fakeGhostty({ installed: false });
    assert.equal((await ghostty.find(Promise.resolve([session("a", { terminal: "ghostty" }), session("b")]))).size, 0);
    assert.deepEqual(calls, { list: 0, running: 0 });
  });
});

describe("which terminal a session runs in, as its hook says", () => {
  test("Kiko's own tmux, whatever app shows it", () => {
    assert.equal(sessionTerminal({ program: "tmux", bundle: "com.mitchellh.ghostty", kiko: true }), "kiko-tmux");
  });
  test("by bundle id first: a tmux of your own inside Ghostty is Ghostty's", () => {
    assert.equal(sessionTerminal({ program: "tmux", bundle: "com.mitchellh.ghostty" }), "ghostty");
    assert.equal(sessionTerminal({ program: "ghostty" }), "ghostty");
    assert.equal(sessionTerminal({ program: "iTerm.app", bundle: "com.googlecode.iterm2" }), "iterm");
    assert.equal(sessionTerminal({ program: "Apple_Terminal" }), "terminal");
  });
  test("a tmux in no app it says, and nothing at all", () => {
    assert.equal(sessionTerminal({ program: "tmux" }), "tmux");
    assert.equal(sessionTerminal({}), "other");
  });
  test("the terminal `kiko` was started from: its bundle id (which reaches the app), else TERM_PROGRAM", () => {
    assert.equal(launchTerminal({ __CFBundleIdentifier: "com.googlecode.iterm2" }), "iterm");
    assert.equal(launchTerminal({ TERM_PROGRAM: "Apple_Terminal" }), "terminal");
    assert.equal(launchTerminal({ GHOSTTY_RESOURCES_DIR: "/x" }), "ghostty");
    assert.equal(launchTerminal({ __CFBundleIdentifier: "com.microsoft.VSCode" }), "vscode");
    assert.equal(launchTerminal({}), null);
  });
});

describe("where Kiko's window opens", () => {
  const all = () => true;
  const no =
    (...missing: WindowApp[]) =>
    (app: WindowApp) =>
      !missing.includes(app);

  test("the terminal `kiko` was started from: iTerm, Terminal or Ghostty", () => {
    assert.deepEqual(windowApp({ launched: "iterm", installed: all }), { app: "iterm", why: "launched" });
    assert.deepEqual(windowApp({ launched: "terminal", installed: all }), { app: "terminal", why: "launched" });
    assert.deepEqual(windowApp({ launched: "ghostty", installed: all }), { app: "ghostty", why: "launched" });
  });

  test("the setting first, over the terminal it was started from", () => {
    assert.deepEqual(windowApp({ setting: "terminal", launched: "iterm", installed: all }), { app: "terminal", why: "setting" });
    assert.deepEqual(windowApp({ setting: "iTerm2", launched: "ghostty", installed: all }), { app: "iterm", why: "setting" });
    // One that isn't installed, or isn't one of these: as if unset.
    assert.deepEqual(windowApp({ setting: "iterm", launched: "terminal", installed: no("iterm") }), { app: "terminal", why: "launched" });
    assert.deepEqual(windowApp({ setting: "warp", launched: "iterm", installed: all }), { app: "iterm", why: "launched" });
  });

  test("started from elsewhere (VS Code, Warp, nothing known): Ghostty when installed, else Terminal, as before", () => {
    assert.deepEqual(windowApp({ launched: "vscode", installed: all }), { app: "ghostty", why: "default" });
    assert.deepEqual(windowApp({ launched: null, installed: no("ghostty") }), { app: "terminal", why: "default" });
    assert.deepEqual(windowApp({ launched: "iterm", installed: no("iterm", "ghostty") }), { app: "terminal", why: "default" });
  });

  /** showSession on fakes: the scripts it ran, and Ghostty windows it opened. */
  function shown(o: { setting?: string; launched: string | null; rexRunning?: boolean }) {
    const scripts: Array<{ script: string; args: string[] }> = [];
    const ghostty: string[] = [];
    const rex: string[] = [];
    const d: ShowDeps = {
      setting: () => o.setting,
      launched: () => o.launched,
      installed: (app) => app !== "rex" || o.rexRunning === true,
      ghostty: async (_cwd, command) => void ghostty.push(command),
      rex: async (_cwd, command) => void rex.push(command),
      script: async (script, args = []) => {
        scripts.push({ script, args });
        return "";
      },
    };
    return { d, scripts, ghostty, rex };
  }

  test("started from Rex, its server running: a new Rex tab attached, no AppleScript", async () => {
    const s = shown({ launched: "rex", rexRunning: true });
    await showSession("/code", "_kiko", "kiko-test", s.d);
    assert.equal(s.rex.length, 1);
    assert.match(s.rex[0], /attach/);
    assert.deepEqual(s.scripts, []);
    assert.deepEqual(s.ghostty, []);
  });

  test("the setting says Rex, but its server isn't running: as if unset (Ghostty, by default)", async () => {
    const s = shown({ setting: "rex", launched: null });
    await showSession("/code", "_kiko", "kiko-test", s.d);
    assert.deepEqual(s.rex, []);
    assert.equal(s.ghostty.length, 1);
  });

  test("opened in iTerm through the helper app's runner: a new window, tmux attached in it", async () => {
    const s = shown({ launched: "iterm" });
    await showSession("/code", "_kiko", "kiko-test", s.d);
    assert.equal(s.scripts.length, 1);
    assert.match(s.scripts[0].script, /tell application "iTerm"/);
    assert.match(s.scripts[0].args[0], /attach/);
    assert.deepEqual(s.ghostty, []);
  });

  test("the setting says Ghostty, started from Terminal: Ghostty's window, no Terminal script", async () => {
    const s = shown({ setting: "ghostty", launched: "terminal" });
    await showSession("/code", "_kiko", "kiko-test", s.d);
    assert.equal(s.ghostty.length, 1);
    assert.deepEqual(s.scripts, []);
  });

  test("started from Terminal: Terminal's `do script`", async () => {
    const s = shown({ launched: "terminal" });
    await showSession("/code", "_kiko", "kiko-test", s.d);
    assert.match(s.scripts[0].script, /tell application "Terminal"/);
  });
});
