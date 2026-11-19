// The first-run card in a real popup, as the Kiko window shows it (src/ui/window-glue.ts → window.ts
// showQuestion → the menus' popup program, src/terminals/tmux/menu-popup.ts), on two throwaway tmux
// servers, never `-L kiko` nor the default one, killed afterwards whatever happens:
//
//   a terminal ("term")  →  attached to the window's server ("win"): `_kiko`, whose one pane
//   stands in for the app's list (it writes down every byte it gets, the asks the card sends)
//
// Keys are typed into the terminal's pane, so they reach the popup as yours would. What the card
// sends the list is read back the way the app reads it (src/ui/input.ts take) and turned into the
// answer the app carries out (agents-card.ts cardAnswer). Nothing is connected: no agent's file is
// read or written here.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CardRow } from "../../../src/agents/setup.ts";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner, WINDOW } from "../../../src/terminals/tmux/tmux.ts";
import { askApp, latestClient, showQuestion } from "../../../src/terminals/tmux/window.ts";
import { agentsCard, cardAnswer } from "../../../src/ui/agents-card.ts";
import { take } from "../../../src/ui/input.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const TOKEN = "t0k3n";
const ROWS: CardRow[] = [
  { id: "claude-code", name: "Claude Code", state: "not connected", detail: "adds hooks to ~/.claude/settings.json", ask: true },
  { id: "codex", name: "Codex", state: "not connected", detail: "adds hooks to ~/.codex/hooks.json", ask: true },
  { id: "t3code", name: "T3 Code", state: "automatic", detail: "not running (connects by itself when it is)", ask: false },
];

const until = valueWaits(10_000, 60);

describe("the agents card in the window's popup", { skip: !TMUX && "tmux isn't installed" }, () => {
  const WIN = throwawayServer("agwin");
  const TERM = throwawayServer("agterm");
  const dir = mkdtempSync(join(tmpdir(), "kiko-agents-card-"));
  const asksFile = join(dir, "asks");
  const win = tmuxRunner(WIN, CONFIG, cleanEnv());
  const term = tmuxRunner(TERM, CONFIG, cleanEnv());
  const screen = () => term(["capture-pane", "-p", "-t", "=term:"]);
  const key = (...keys: string[]) => term(["send-keys", "-t", "=term:", ...keys]);
  /** What the list got so far, as the app reads it. */
  const asks = () => take(existsSync(asksFile) ? readFileSync(asksFile, "latin1") : "", TOKEN).asks;
  let list = "";
  let client = "";

  before(async () => {
    // The list's stand-in: every byte as it comes (raw, so ESC and the rest aren't the terminal's).
    await win(["new-session", "-d", "-s", WINDOW, "-x", "100", "-y", "30", "--", "/bin/sh", "-c", `stty raw -echo; exec cat > '${asksFile}'`]);
    list = (await win(["display", "-p", "-t", `=${WINDOW}:`, "#{pane_id}"])).trim();
    await term(["new-session", "-d", "-s", "term", "-x", "100", "-y", "31", "--", "/bin/sh", "-c", `env -u TMUX '${TMUX}' -u -L ${WIN} -f '${CONFIG}' attach -t =${WINDOW}; sleep 600`]);
    client = (await until(
      () => latestClient(win, true),
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
      agentsCard(ROWS, (verb, arg) => askApp(list, TOKEN, verb, arg)),
      client,
    ).catch(() => {});

  test("shown over the window: everything found ticked, T3 Code not a box, the hints", async () => {
    show();
    const s = await until(screen, (t) => t.includes("[x] Claude Code") && t.includes("Esc later"), "the card");
    assert.match(s, /Which coding agents should Kiko talk to\?/);
    assert.match(s, /\[x\] Codex\s+adds hooks to ~\/\.codex\/hooks\.json/);
    assert.match(s, /·\s+T3 Code\s+not running/);
    assert.ok(!/\[.\] T3 Code/.test(s), "T3 Code can't be ticked");
  });

  test("Space unticks Claude Code, Enter: Codex alone is connected, and the popup goes", async () => {
    await key("Space");
    await until(screen, (t) => t.includes("[ ] Claude Code"), "Claude Code unticked");
    await key("Enter");
    await until(screen, (t) => !t.includes("Esc later"), "the card gone");
    const got = await until(asks, (a) => a.some((x) => x.verb === "agents"), "the answer at the list");
    assert.deepEqual(got, [
      { verb: "agentOn", arg: "codex" },
      { verb: "agents", arg: "connect" },
    ]);
    assert.deepEqual(cardAnswer(got, ROWS), { offered: ["claude-code", "codex"], connect: ["codex"], later: false });
  });

  test("shown again, Escape is later: nothing ticked is sent", async () => {
    rmSync(asksFile, { force: true });
    await win(["respawn-pane", "-k", "-t", list, "--", "/bin/sh", "-c", `stty raw -echo; exec cat > '${asksFile}'`]);
    show();
    await until(screen, (t) => t.includes("[x] Claude Code"), "the card again");
    await key("Escape");
    await until(screen, (t) => !t.includes("Esc later"), "the card gone");
    const got = await until(asks, (a) => a.length > 0, "the answer at the list");
    assert.deepEqual(got, [{ verb: "agents", arg: "later" }]);
    assert.equal(cardAnswer(got, ROWS).later, true);
  });
});
