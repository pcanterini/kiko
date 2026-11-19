// Which agent a new session starts in, asked in the window (src/ui/agent-picker.ts): the popup's
// menu as the menus' program draws it and takes keys (src/ui/menu-view.ts), the preselected row
// chosen as it opens so Enter alone starts it, ↑ ↓ moving, Esc letting it go; its asks read back;
// and the window glue (src/ui/window-glue.ts) on a pretend tmux showing it when the app puts one in the
// state, turning its answer into the app's "pickAgent" action, and reading the run's agent.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ui, type AgentAsk } from "../../../src/core/ui-store.ts";
import { WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { NEW_AGENT_OPTION, openWindow, QUESTION_DATA, setNewAgent } from "../../../src/terminals/tmux/window.ts";
import { agentAnswer, agentPicker } from "../../../src/ui/agent-picker.ts";
import { windowEvents } from "../../../src/ui/input.ts";
import { MenuView } from "../../../src/ui/menu-view.ts";
import { startWindow } from "../../../src/ui/window-glue.ts";
import { FakeTmux } from "../../support/fake-tmux.ts";

const ASK: AgentAsk = {
  ask: "a1b2c3d4",
  folder: "clipkit",
  rows: [
    { id: "claude-code", name: "Claude Code" },
    { id: "codex", name: "Codex", note: "this run" },
  ],
  selected: "codex",
};
const asker = (verb: string, arg: string) => ["ask", verb, arg];
const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the agent picker", () => {
  test("drawn: where it opens, a row per agent (why the chosen one is), the hints; the preselected row chosen", () => {
    const view = new MenuView(agentPicker(ASK, asker));
    const lines = view.frame(44, 7).map(plain);
    assert.match(lines[0], /^ New session in clipkit/);
    assert.match(lines[2], /^ Claude Code\s*$/);
    assert.match(lines[3], /^ Codex\s+this run/);
    assert.match(lines[5], /Enter starts · ↑↓ picks · Esc cancels/);
    assert.equal(view.at, 3, "Codex chosen as it opens");
    assert.match(view.frame(44, 7)[3], /\x1b\[7/, "drawn highlighted");
  });
  test("Enter alone starts the preselected one", () => {
    const view = new MenuView(agentPicker(ASK, asker));
    assert.deepEqual(view.key("\r"), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:codex"]] });
  });
  test("↑ (or ↓, round the ends) picks the other; Enter starts it", () => {
    const up = new MenuView(agentPicker(ASK, asker));
    up.key("\x1b[A");
    assert.deepEqual(up.key("\r"), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:claude-code"]] });
    const down = new MenuView(agentPicker(ASK, asker));
    down.key("\x1b[B");
    assert.deepEqual(down.key("\r"), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:claude-code"]] });
  });
  test("Esc (or Ctrl+C) lets it go: the ask with no agent", () => {
    assert.deepEqual(new MenuView(agentPicker(ASK, asker)).key("\x1b"), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:"]] });
    assert.deepEqual(new MenuView(agentPicker(ASK, asker)).key("\x03"), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:"]] });
  });
  test("a third agent is one more row; a click picks its line", () => {
    const three = { ...ASK, rows: [...ASK.rows, { id: "opencode", name: "OpenCode" }], selected: "claude-code" };
    const view = new MenuView(agentPicker(three, asker));
    assert.equal(view.at, 2);
    assert.deepEqual(view.click(1, 5), { kind: "run", commands: [["ask", "pickAgent", "a1b2c3d4:opencode"]] });
  });
  test("its asks read back: the ask and the agent, or none (let go); anything else isn't one", () => {
    assert.deepEqual(agentAnswer("a1b2c3d4:codex"), { ask: "a1b2c3d4", agent: "codex" });
    assert.deepEqual(agentAnswer("a1b2c3d4:"), { ask: "a1b2c3d4", agent: null });
    assert.equal(agentAnswer("codex"), null);
    assert.equal(agentAnswer(""), null);
  });
});

describe("the agent picker in the window (the glue, on a pretend tmux)", () => {
  test("put in the state: a popup on the terminal used last; its answer the app's pickAgent action; the run's agent read", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    t.clients.set(WINDOW, ["/dev/ttys009"]);
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" } });
    const glue = startWindow(t.run, list);
    const acts: unknown[] = [];
    const took = (a: { type: string }) => void (a.type === "pickAgent" && acts.push(a));
    ui.on("action", took);
    try {
      const popups = t.menus.length;
      ui.set({ window: { ...ui.state.window!, agentAsk: ASK } });
      await wait(50);
      assert.equal(t.menus.length, popups + 1, "shown once");
      const shown = t.menus.at(-1)!;
      assert.equal(shown[0], "display-popup");
      assert.equal(shown[shown.indexOf("-c") + 1], "/dev/ttys009");
      const menu = JSON.parse(t.windows.get(t.panes.get(list)!.window)!.opts[QUESTION_DATA]);
      assert.equal(menu.items[0].label, "New session in clipkit");
      assert.equal(menu.selected, 3);
      // Its answers ask this app (its pane).
      assert.equal(menu.items[3].run[0][2], list);
      // The same ask again (the state changing for something else): not shown twice.
      ui.set({ window: { ...ui.state.window!, note: "something" } });
      await wait(30);
      assert.equal(t.menus.length, popups + 1);
      // Picked (as the popup asks, through the list's input): the app's action, with the ask.
      windowEvents.emit("ask", { verb: "pickAgent", arg: "a1b2c3d4:codex" });
      windowEvents.emit("ask", { verb: "pickAgent", arg: "a1b2c3d4:" });
      windowEvents.emit("ask", { verb: "pickAgent", arg: "nonsense" });
      assert.deepEqual(acts, [
        { type: "pickAgent", ask: "a1b2c3d4", agent: "codex" },
        { type: "pickAgent", ask: "a1b2c3d4", agent: null },
      ]);
      // The run's agent: what `kiko codex` left on the server, until a plain `kiko` takes it out.
      assert.equal(await glue.runAgent(), null);
      await setNewAgent(t.run, "codex");
      assert.equal(t.global[NEW_AGENT_OPTION], "codex");
      assert.equal(await glue.runAgent(), "codex");
      await setNewAgent(t.run, null);
      assert.equal(await glue.runAgent(), null);
    } finally {
      ui.off("action", took);
      await glue.stop();
      ui.set({ ...before });
    }
  });
  test("no terminal shows the window: not shown, let go, and said why", async () => {
    const t = new FakeTmux();
    await openWindow(t.run, () => ({ argv: ["app"], discard() {} }), "/code/kiko");
    const [list] = t.panesOf(WINDOW);
    const before = ui.state;
    ui.set({ window: { shown: null, note: "" } });
    const glue = startWindow(t.run, list);
    const acts: unknown[] = [];
    const took = (a: { type: string }) => void (a.type === "pickAgent" && acts.push(a));
    ui.on("action", took);
    try {
      const popups = t.menus.length;
      ui.set({ window: { ...ui.state.window!, agentAsk: { ...ASK, ask: "e5f6" } } });
      await wait(50);
      assert.equal(t.menus.length, popups);
      assert.deepEqual(acts, [{ type: "pickAgent", ask: "e5f6", agent: null }]);
      assert.match(ui.state.window!.note, /couldn't ask which agent/);
    } finally {
      ui.off("action", took);
      await glue.stop();
      ui.set({ ...before });
    }
  });
});
