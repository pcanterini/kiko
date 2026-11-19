// `kiko` run in a herdr pane, for real but with a stand-in herdr: a throwaway tmux ("term") stands
// in for herdr's pane, with what herdr sets there (HERDR_ENV, HERDR_PANE_ID, HERDR_TAB_ID,
// HERDR_WORKSPACE_ID, HERDR_SOCKET_PATH, TERM_PROGRAM=herdr; no TMUX), and `herdr` on PATH is a
// script that writes down how it was run. Kiko's tmux is another throwaway server. Both are
// killed afterwards whatever happens. Checked: none of herdr's variables reach Kiko's tmux, the
// app or a session (else herdr's own Claude Code hooks there report as the herdr pane: herdr issues
// #2134, #2135); herdr is asked once to pass right-clicks on, and when it can't, the app is left
// a note saying how; and herdr's prefix in its config.toml counts as a clash for the menu key.
import "../../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { CONFIG, cleanEnv, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import { describe as layoutOf, KEY_BY_OPTION, KEY_OPTION, NOTES_OPTION, type Note } from "../../../src/terminals/tmux/window.ts";
import { HERDR_VARS, RIGHT_CLICK_ARGS } from "../../../src/terminals/tmux/herdr.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const WIN = throwawayServer("hwin");
const TERM = throwawayServer("hterm");
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kiko-herdr-"));
const bin = join(dir, "bin");
const PATH = [bin, dirname(process.execPath), "/usr/bin", "/bin"];
const win = tmuxRunner(WIN, CONFIG, cleanEnv());
const term = tmuxRunner(TERM, CONFIG, { ...cleanEnv(), PATH: PATH.join(":") });

const until = valueWaits(8000, 60);
const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");
const option = async (name: string) => (await win(["show-options", "-gqv", name])).trim();

/** Each herdr variable, as `name=value` or `name=unset`: what a program shows of them, and nothing else of its environment. */
const HERDR_LINE = HERDR_VARS.map((v) => `${v}=\${${v}-unset}`).join(" ");
const NONE = HERDR_VARS.map((v) => `${v}=unset`).join(" ");

/** Runs bin/kiko in a new window of the stand-in herdr pane's tmux, without TMUX (herdr's panes have none). */
async function run(name: string, cwd: string, ...args: string[]) {
  await term(["new-window", "-d", "-t", "=herdr:", "-n", name, "-c", cwd, "--", "/bin/sh", "-c", 'env -u TMUX -u TMUX_PANE "$@"; echo "exit $?"; sleep 60', "sh", CLI, ...args]);
}

describe("kiko in a herdr pane (a stand-in herdr)", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(async () => {
    mkdirSync(bin);
    if (PATH.slice(1).some((d) => existsSync(join(d, "claude")))) throw new Error("a real claude sits next to node: not running these");
    // herdr: writes down its arguments and which pane it was told it's in; refuses once `refuse` exists (an older herdr).
    writeFileSync(join(bin, "herdr"), `#!/bin/sh\necho "$* PANE=\${HERDR_PANE_ID-unset}" >> '${dir}/herdr.log'\n[ -e '${dir}/refuse' ] && { echo "unknown command" >&2; exit 2; }\nexit 0\n`, {
      mode: 0o755,
    });
    writeFileSync(join(bin, "standin-app"), `#!/bin/sh\necho "${HERDR_LINE} TERM_PROGRAM=\${TERM_PROGRAM-unset}" >> '${dir}/app.env'\nexec cat > /dev/null\n`, { mode: 0o755 });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${HERDR_LINE} TERM_PROGRAM=\${TERM_PROGRAM-unset}" >> '${dir}/claude.env'\nexec cat > /dev/null\n`, { mode: 0o755 });
    // herdr's config: Ctrl+Space as its prefix (the menu key's default).
    writeFileSync(join(dir, "herdr.toml"), `[ui]\nright_click_passthrough_modifier = "alt"\n\n[keys]\n# mine\nprefix = "ctrl+space"\nsplit_right = "v"\n\n[other]\nprefix = "ctrl+q"\n`);
    mkdirSync(join(dir, "pixie"));
    await term([
      "new-session",
      "-d",
      "-s",
      "herdr",
      "-x",
      "120",
      "-y",
      "40",
      "-e",
      `PATH=${PATH.join(":")}`,
      "-e",
      `KIKO_TMUX_SERVER=${WIN}`,
      "-e",
      `KIKO_WINDOW_APP=${join(bin, "standin-app")}`,
      "-e",
      `KIKO_SOCKET=${join(dir, "no-app.sock")}`,
      "-e",
      `KIKO_SETTINGS=${join(dir, "no-settings.json")}`,
      "-e",
      `NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT || "child"}`,
      // What herdr sets in its panes (made-up values), and where its config is.
      "-e",
      "HERDR_ENV=1",
      "-e",
      "HERDR_PANE_ID=p_test_7",
      "-e",
      "HERDR_TAB_ID=t_test_3",
      "-e",
      "HERDR_WORKSPACE_ID=w_test_1",
      "-e",
      `HERDR_SOCKET_PATH=${join(dir, "herdr.sock")}`,
      "-e",
      "TERM_PROGRAM=herdr",
      "-e",
      `HERDR_CONFIG_PATH=${join(dir, "herdr.toml")}`,
      "--",
      "/bin/sh",
      "-c",
      "sleep 600",
    ]);
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("kiko claude: herdr asked to pass right-clicks on, once, for this pane; nothing of herdr's in the app, the session or the server", async () => {
    await run("pixie", join(dir, "pixie"), "claude");
    await until(
      () => read("claude.env"),
      (s) => s.length > 0,
      "the stand-in claude",
    );
    await until(
      () => read("app.env"),
      (s) => s.length > 0,
      "the stand-in app",
    );
    assert.equal(read("herdr.log"), `${RIGHT_CLICK_ARGS.join(" ")} PANE=p_test_7\n`, "herdr pane input --current --right-click pane, with herdr's own pane variables");
    // TERM_PROGRAM: tmux's own now, as in any tmux pane (never herdr's).
    assert.equal(read("claude.env"), `${NONE} TERM_PROGRAM=tmux\n`);
    assert.equal(read("app.env"), `${NONE} TERM_PROGRAM=tmux\n`);
    const serverEnv = await win(["show-environment", "-g"]);
    assert.ok(!/HERDR_/.test(serverEnv), "no HERDR_ variable in the server's global environment");
    // Every session's own environment too (what tmux gives a new pane there).
    const sessionEnv = await win(["show-environment", "-t", "=pixie"]).catch(() => "");
    assert.ok(!/^HERDR_/m.test(sessionEnv), "none in pixie's tmux session");
    assert.equal(await option(NOTES_OPTION).then((n) => (n ? JSON.parse(n).filter((x: { id: string }) => x.id === "herdr_right_click").length : 0)), 0, "nothing to tell about right-clicks");
  });

  test('herdr\'s prefix in its config.toml ([keys] prefix = "ctrl+space") is a clash: Ctrl+\\ this time, and a note for the app to warn and ask', async () => {
    assert.equal(await option(KEY_OPTION), "C-\\");
    assert.equal(await option(KEY_BY_OPTION), "clash");
    const notes = JSON.parse(await option(NOTES_OPTION));
    const clash = notes.find((n: { id: string }) => n.id.startsWith("key_clash"));
    assert.deepEqual(clash.log, { event: "key_clash", fields: { by: "herdr", key: "C-Space", fallback: "C-\\", asked: true } });
    assert.equal(clash.text, "Your herdr uses Ctrl+Space, so the menu key is Ctrl+\\ this time. Keep it, or pick your own?");
    assert.deepEqual(clash.ask, { by: "herdr", key: "C-Space", fallback: "C-\\" });
  });

  test("a herdr that can't pass right-clicks on: a note for the app, saying how", async () => {
    writeFileSync(join(dir, "refuse"), "");
    await run("again", dir);
    await until(
      async () => (await layoutOf(win)).view?.clients ?? 0,
      (c) => c >= 2,
      "a second view",
    );
    const notes = await until(
      async (): Promise<Note[]> => JSON.parse((await option(NOTES_OPTION)) || "[]"),
      (n) => n.some((x) => x.id === "herdr_right_click"),
      "the note",
    );
    const note = notes.find((n) => n.id === "herdr_right_click")!;
    assert.match(note.text, /herdr pane input --current --right-click pane/);
    assert.deepEqual(note.log, { event: "herdr_right_click", fields: { ok: false } });
    assert.equal(read("herdr.log").split("\n").filter(Boolean).length, 2, "asked once per kiko");
  });
});
