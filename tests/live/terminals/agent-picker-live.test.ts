// Which agent a new session starts in, asked in a real popup as the Kiko window shows it
// (src/ui/window-glue.ts → window.ts showQuestion → the menus' popup program, src/terminals/tmux/menu-popup.ts),
// on two throwaway tmux servers, never `-L kiko` nor the default one, killed afterwards whatever
// happens (the agents card's live test does the same: agents-card-live.test.ts):
//
//   a terminal ("term")  →  attached to the window's server ("win"): `_kiko`, whose one pane
//   stands in for the app's list (it writes down every byte it gets, the asks the picker sends)
//
// Keys are typed into the terminal's pane, so they reach the popup as yours would. What the picker
// sends the list is read back the way the app reads it (src/ui/input.ts take), then as the glue
// reads a "pickAgent" ask (agent-picker.ts agentAnswer). No agent is started.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentAsk } from "../../../src/core/ui-store.ts";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { askApp, latestClient, showQuestion } from "../../../src/terminals/tmux/window.ts";
import { agentAnswer, agentPicker } from "../../../src/ui/agent-picker.ts";
import { take } from "../../../src/ui/input.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const TOKEN = "t0k3n";
const ASK: AgentAsk = {
  ask: "c0ffee01",
  folder: "clipkit",
  rows: [
    { id: "claude-code", name: "Claude Code" },
    { id: "codex", name: "Codex", note: "this run" },
  ],
  selected: "codex",
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(10_000, 60);

describe("the agent picker in the window's popup", { skip: !TMUX && "tmux isn't installed" }, () => {
  const WIN = throwawayServer("hpwin");
  const TERM = throwawayServer("hpterm");
  const dir = mkdtempSync(join(tmpdir(), "kiko-agent-picker-"));
  const asksFile = join(dir, "asks");
  const win = tmuxRunner(WIN, CONFIG, cleanEnv());
  const term = tmuxRunner(TERM, CONFIG, cleanEnv());
  const screen = () => term(["capture-pane", "-p", "-t", "=term:"]);
  const key = (...keys: string[]) => term(["send-keys", "-t", "=term:", ...keys]);
  /** What the list got so far, as the app reads it. */
  const asks = () => take(existsSync(asksFile) ? readFileSync(asksFile, "latin1") : "", TOKEN).asks;
  let list = "";
  let client = "";

  /** The list's stand-in again, with nothing got yet. */
  const freshList = async () => {
    rmSync(asksFile, { force: true });
    await win(["respawn-pane", "-k", "-t", list, "--", "/bin/sh", "-c", `stty raw -echo; exec cat > '${asksFile}'`]);
  };

  before(async () => {
    await win(["new-session", "-d", "-s", WINDOW, "-x", "100", "-y", "30", "--", "/bin/sh", "-c", `stty raw -echo; exec cat > '${asksFile}'`]);
    list = (await win(["display", "-p", "-t", `=${WINDOW}:`, "#{pane_id}"])).trim();
    await term(["new-session", "-d", "-s", "term", "-x", "100", "-y", "31", "--", "/bin/sh", "-c", `env -u TMUX '${TMUX}' -u -L ${WIN} -f '${CONFIG}' attach -t =${WINDOW}; sleep 600`]);
    client = (await until(
      () => latestClient(win),
      (c) => Boolean(c),
      "the terminal attached",
    )) as string;
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  // Not waited on, as the app doesn't: tmux answers once the popup has closed.
  const show = () =>
    void showQuestion(
      win,
      agentPicker(ASK, (verb, arg) => askApp(list, TOKEN, verb, arg)),
      client,
    ).catch(() => {});
  const answer = async () => agentAnswer((await until(asks, (a) => a.some((x) => x.verb === "pickAgent"), "the answer at the list")).find((x) => x.verb === "pickAgent")!.arg);

  test("shown over the window: where it opens, both agents, why Codex is chosen, the hints", async () => {
    show();
    const s = await until(screen, (t) => t.includes("New session in clipkit") && t.includes("Esc cancels"), "the picker");
    assert.match(s, /Claude Code/);
    assert.match(s, /Codex\s+this run/);
    assert.match(s, /Enter starts · ↑↓ picks · Esc cancels/);
  });

  test("Enter alone: Codex, the preselected one; the popup goes", async () => {
    await key("Enter");
    await until(screen, (t) => !t.includes("Esc cancels"), "the picker gone");
    assert.deepEqual(await answer(), { ask: "c0ffee01", agent: "codex" });
  });

  test("shown again, ↑ then Enter: Claude Code", async () => {
    await freshList();
    show();
    await until(screen, (t) => t.includes("Esc cancels"), "the picker again");
    await key("Up");
    await wait(100);
    await key("Enter");
    await until(screen, (t) => !t.includes("Esc cancels"), "the picker gone");
    assert.deepEqual(await answer(), { ask: "c0ffee01", agent: "claude-code" });
  });

  test("shown again, Escape: let go, no agent", async () => {
    await freshList();
    show();
    await until(screen, (t) => t.includes("Esc cancels"), "the picker again");
    await key("Escape");
    await until(screen, (t) => !t.includes("Esc cancels"), "the picker gone");
    assert.deepEqual(await answer(), { ask: "c0ffee01", agent: null });
  });
});
