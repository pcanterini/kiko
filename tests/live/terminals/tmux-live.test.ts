// The tmux adapter against a real tmux: a throwaway server of its own (`tmux -L kiko-test-<random>`,
// with Kiko's config copied to a temp file), never Kiko's (`-L kiko`) nor the default one,
// killed afterwards whatever happens. Its panes run `cat` into a file, so what was typed is read back
// exactly: it must arrive whole, and only in the pane it was meant for. No windows are shown (`show`
// is a stand-in). Skipped when tmux isn't installed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { FORMAT, parsePanes, pasteCheck, tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, NO_ANSWER, processes, tmuxArg, tmuxFormatArg, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import type { Place } from "../../../src/terminals/types.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = throwawayServer("adapter");
// For `kiko claude`: the server it's run in (as if the user's own tmux), and the one it starts.
const OUTER = throwawayServer("outer");
const CLI_SERVER = throwawayServer("cli");
assert.notEqual(SERVER, "kiko");
const CLI = fileURLToPath(new URL("../../../bin/kiko", import.meta.url));
const CLI_TS = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kiko-tmux-"));
const conf = join(dir, "tmux.conf");
const tmux = tmuxRunner(SERVER, conf, cleanEnv());
const shown: Array<{ cwd: string; session: string }> = [];
const terminal = tmuxTerminal({
  tmux,
  ps: processes,
  show: async (cwd, session) => void shown.push({ cwd, session }),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  installed: () => true,
  shell: "/bin/sh",
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = valueWaits(3000, 25);
const out = (name: string) => join(dir, `${name}.out`);
const read = (name: string) => (existsSync(out(name)) ? readFileSync(out(name), "utf8") : "");
const pane = async (session: string) => (await tmux(["list-panes", "-t", `=${session}`, "-F", "#{pane_id} #{pane_pid} #{bracket_paste_flag}"])).trim().split(" ");

/**
 * A session whose pane runs `sh`, which runs `cat` into a file (so cat is the pane's child, as
 * Claude Code is its shell's). `paste`: it asks for bracketed paste first, as Claude Code does.
 * Its place, found by cat's process like a Claude Code session's.
 */
async function start(name: string, paste = false): Promise<Place> {
  const script = `${paste ? "printf '\\033[?2004h'; " : ""}cat > '${out(name)}'; :`;
  await tmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "30", "--", "/bin/sh", "-c", script]);
  const [, pid] = await pane(name);
  const cat = await until(processes, (ps) => ps.some((p) => p.ppid === Number(pid)));
  const catPid = cat.find((p) => p.ppid === Number(pid))!.pid;
  if (paste)
    await until(
      () => pane(name),
      ([, , flag]) => flag === "1",
    );
  const found = await terminal.find(Promise.resolve([{ sessionId: name, cwd: dir, kind: "interactive" as const, desktop: false, titles: [], pid: catPid }]));
  const place = found.get(name)?.place;
  assert.ok(place, `${name} found by its process`);
  return place;
}

describe("tmux, for real", { skip: !TMUX && "tmux isn't installed" }, () => {
  before(() => {
    copyFileSync(CONFIG, conf);
    writeFileSync(conf, `${readFileSync(conf, "utf8")}\nset -g exit-empty on\n`);
  });
  after(() => {
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  test("Kiko's config loads cleanly: no prefix key, no status bar, Escape at once", async () => {
    await tmux(["new-session", "-d", "-s", "config", "--", "/bin/sh", "-c", "sleep 30"]);
    assert.equal((await tmux(["show", "-gv", "prefix"])).trim(), "None");
    assert.equal((await tmux(["show", "-gv", "status"])).trim(), "off");
    assert.equal((await tmux(["show", "-sv", "escape-time"])).trim(), "0");
    assert.equal((await tmux(["show", "-gv", "mouse"])).trim(), "on");
    await tmux(["kill-session", "-t", "=config"]);
  });

  test("no UTF-8 locale (an app started by launchd: no LANG): the panes still read back, tabs and names whole (-u)", async () => {
    // Only what launchd gives: no LANG, no LC_*. Without -u, tmux wrote tabs and "é" as "_".
    // TMUX_TMPDIR kept when the run sets one (throwaway servers' sockets in a folder of their own): it's where the server is, not a locale.
    const tmuxTmp = process.env.TMUX_TMPDIR ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR } : {};
    const bare = tmuxRunner(SERVER, conf, { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, USER: process.env.USER, ...tmuxTmp });
    // The test before ended the server's last session, and this config ends an empty server: it may be exiting just now.
    for (let i = 0; ; i++) {
      try {
        await tmux(["new-session", "-d", "-s", "café", "--", "/bin/sh", "-c", "sleep 30"]);
        break;
      } catch (err) {
        if (i >= 5 || !/exited unexpectedly|no server|error connecting/i.test(String(err))) throw err;
        await wait(100);
      }
    }
    const got = parsePanes(await bare(["list-panes", "-a", "-F", FORMAT]));
    assert.ok(
      got.some((p) => p.session === "café"),
      JSON.stringify(got),
    );
    const raw = await bare(["list-panes", "-t", "=café", "-F", "#{session_name}\t#{pane_id}"]);
    assert.match(raw, /^café\t%\d+\n$/);
    await tmux(["kill-session", "-t", "=café"]);
  });

  test("a command tmux doesn't answer (wait-for, standing in for a hung server): killed after the time given, rejected with why", async () => {
    const quick = tmuxRunner(SERVER, conf, cleanEnv(), 300);
    await tmux(["new-session", "-d", "-s", "hang", "--", "/bin/sh", "-c", "sleep 30"]);
    const started = Date.now();
    await assert.rejects(quick(["wait-for", "kiko-never"]), { message: NO_ANSWER });
    assert.ok(Date.now() - started < 2000);
    await tmux(["kill-session", "-t", "=hang"]);
  });

  test("words go exactly, and only, into the session's own pane", async () => {
    const a = await start("alpha");
    const b = await start("beta");
    assert.notEqual(a.id, b.id);
    const text = `-n "quoted" 'single' $HOME \\ back; echo nope #{pane_id} #(echo no) ünïcødé;`;
    assert.deepEqual(await terminal.type(a, text), { sent: true });
    await until(
      () => read("alpha"),
      (s) => s.endsWith("\n"),
    );
    assert.equal(read("alpha"), `${text}\n`);
    assert.equal(read("beta"), "", "nothing in the other pane");
    assert.deepEqual(await terminal.type(b, "for beta"), { sent: true });
    await until(
      () => read("beta"),
      (s) => s.endsWith("\n"),
    );
    assert.equal(read("beta"), "for beta\n");
    assert.equal(read("alpha"), `${text}\n`, "and nothing more in the first");
  });

  test("several lines: one bracketed paste, then Enter", async () => {
    const p = await start("gamma", true);
    assert.deepEqual(await terminal.type(p, "line one\nline two"), { sent: true });
    const got = await until(
      () => read("gamma"),
      (s) => s.includes("\u001b[201~") && s.endsWith("\n"),
    );
    // The terminal turns the paste's line breaks (CR) and the Enter into new lines for cat.
    assert.equal(got, "\u001b[200~line one\nline two\u001b[201~\n");
  });

  // A session parked with ←: the same process in the same pane, titled as Claude Code's agents list.
  // Here a pane that titles itself so after its first line, then reads what comes into a file.
  test("a pane titled as Claude Code's agents list: not found, refused, and tmux's own check holds a paste back", async () => {
    const name = "parked";
    const title = "1 awaiting input · claude agents";
    await tmux(["new-session", "-d", "-s", name, "-x", "120", "-y", "30", "--", "/bin/sh", "-c", `read x; printf '\\033]2;${title}\\007'; cat > '${out(name)}'; :`]);
    const [id, pid] = await pane(name);
    const sh = await until(processes, (ps) => ps.some((p) => p.pid === Number(pid)));
    const place = (
      await terminal.find(Promise.resolve([{ sessionId: name, cwd: dir, kind: "interactive" as const, desktop: false, titles: [], pid: sh.find((p) => p.pid === Number(pid))!.pid }]))
    ).get(name)?.place;
    assert.ok(place, "found by its process while it's a session");
    const check = async () => (await tmux(["display", "-p", "-t", id, pasteCheck(parsePanes(await tmux(["list-panes", "-a", "-F", FORMAT])).find((p) => p.id === id)!, false)])).trim();
    assert.equal(await check(), "1", "tmux's check passes while the title is the session's");
    await tmux(["send-keys", "-t", id, "Enter"]);
    await until(
      () => tmux(["display", "-p", "-t", id, "#{pane_title}"]),
      (t) => t.trim() === title,
    );
    assert.equal(await check(), "0", "and fails once it's the agents list");
    const found = await terminal.find(Promise.resolve([{ sessionId: name, cwd: dir, kind: "interactive" as const, desktop: false, titles: [], pid: Number(pid) }]));
    assert.deepEqual(found.get(name), { place: null, mapping: "agents" });
    assert.deepEqual(await terminal.type(place, "hello"), { sent: false, why: "its pane is showing Claude Code's agents list" });
    await wait(300);
    assert.equal(read(name), "", "nothing typed in");
    await tmux(["kill-session", "-t", `=${name}`]);
  });

  // A pane that asks for bracketed paste, then turns it off after one line (Claude Code quitting,
  // a shell come to the front), then reads what comes into a file.
  async function quitter(name: string) {
    await tmux(["new-session", "-d", "-s", name, "--", "/bin/sh", "-c", `printf '\\033[?2004h'; read x; printf '\\033[?2004l'; cat > '${out(name)}'; :`]);
    const [id, pid] = await pane(name);
    await until(
      () => pane(name),
      ([, , flag]) => flag === "1",
    );
    const quit = async () => {
      await tmux(["send-keys", "-t", id, "Enter"]);
      await until(
        () => pane(name),
        ([, , flag]) => flag === "0",
      );
    };
    return { id, pid: Number(pid), quit };
  }

  test("tmux's own check: bracketed paste off by the time it pastes, nothing goes in", async () => {
    const { id, pid, quit } = await quitter("zeta");
    await quit();
    await tmux(["load-buffer", "-b", "kiko-0000beef", "-"], "make clean\nmake");
    await tmux(["if-shell", "-F", "-t", id, `#{&&:#{bracket_paste_flag},#{==:#{pane_pid},${pid}}}`, `paste-buffer -p -d -b kiko-0000beef -t ${id}`]);
    assert.equal(await tmux(["delete-buffer", "-b", "kiko-0000beef"]), "", "the buffer still there: nothing pasted");
    await wait(300);
    assert.equal(read("zeta"), "");
  });

  test("type(): the pane changes just as it pastes: refused, nothing in it, no Enter, no buffer left", async () => {
    const { id, pid, quit } = await quitter("eta");
    // The race made certain: the program quits right before tmux is asked to paste.
    const racing = tmuxTerminal({
      tmux: async (args, input) => {
        if (args[0] === "if-shell") await quit();
        return tmux(args, input);
      },
      ps: processes,
      show: async () => {},
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      installed: () => true,
      shell: "/bin/sh",
    });
    // The pane's first process is sh itself (read is sh's own): its place is sh's.
    const typed = await racing.type({ via: "tmux", id, keys: true, pid }, "make clean\nmake");
    assert.deepEqual(typed, { sent: false, why: "its pane changed just as I typed, so nothing went in" });
    await wait(300);
    assert.equal(read("eta"), "");
    assert.equal((await tmux(["list-buffers", "-F", "#{buffer_name}"])).trim(), "", "no buffer left");
  });

  test("type(): a voice-opened pane (claude; exec $SHELL) whose Claude Code quits just as it pastes: the first process is the same, but tmux sees another program in front; nothing goes in", async () => {
    // As a voice-opened session's pane runs it: an interactive shell, the program a job of its own
    // (here a stand-in that becomes sleep), then the shell replaced by what follows (cat, into a file).
    const standin = join(dir, "standin-claude");
    writeFileSync(standin, "#!/bin/sh\nexec /bin/sleep 600\n", { mode: 0o755 });
    await tmux(["new-session", "-d", "-s", "theta", "-x", "80", "-y", "20", "--", "/bin/zsh", "-f", "-i", "-c", `'${standin}'; exec /bin/cat > '${out("theta")}'`]);
    const [id, first] = await pane("theta");
    const current = () => tmux(["display", "-p", "-t", id, "#{pane_current_command}"]).then((s) => s.trim());
    assert.equal(await until(current, (c) => c === "sleep"), "sleep", "the stand-in in front, as tmux reports it");
    const sleeper = (await processes()).find((p) => p.ppid === Number(first))!;
    const racing = tmuxTerminal({
      tmux: async (args, input) => {
        if (args[0] === "if-shell") {
          process.kill(sleeper.pid);
          await until(current, (c) => c === "cat");
        }
        return tmux(args, input);
      },
      ps: processes,
      show: async () => {},
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      installed: () => true,
      shell: "/bin/sh",
    });
    const typed = await racing.type({ via: "tmux", id, keys: true, pid: sleeper.pid }, "must not land");
    assert.deepEqual(typed, { sent: false, why: "its pane changed just as I typed, so nothing went in" });
    assert.equal((await pane("theta"))[1], first, "the first process the same (the pid check alone would have pasted)");
    await wait(300);
    assert.equal(read("theta"), "");
    await tmux(["kill-session", "-t", "=theta"]);
  });

  test("scrolled back (copy mode): brought out of it, then typed in", async () => {
    const p = await start("delta");
    await tmux(["copy-mode", "-t", p.id]);
    assert.equal((await tmux(["display", "-p", "-t", p.id, "#{pane_in_mode}"])).trim(), "1");
    assert.deepEqual(await terminal.type(p, "after scrolling"), { sent: true });
    await until(
      () => read("delta"),
      (s) => s.endsWith("\n"),
    );
    assert.equal(read("delta"), "after scrolling\n");
    assert.equal((await tmux(["display", "-p", "-t", p.id, "#{pane_in_mode}"])).trim(), "0");
  });

  test("the pane's program replaced since it was found: refused, nothing typed into the new one", async () => {
    const p = await start("epsilon");
    await tmux(["respawn-pane", "-k", "-t", p.id, "--", "/bin/sh", "-c", `cat > '${out("epsilon-new")}'; :`]);
    await until(processes, (ps) => !ps.some((x) => x.pid === p.pid));
    const typed = await terminal.type(p, "must not land");
    assert.equal(typed.sent, false);
    await wait(300);
    assert.equal(read("epsilon-new"), "");
  });

  test("a process in none of its panes isn't found (this test's own, say)", async () => {
    const found = await terminal.find(Promise.resolve([{ sessionId: "me", cwd: dir, kind: "interactive" as const, desktop: false, titles: [], pid: process.pid }]));
    assert.equal(found.size, 0);
  });

  test('open: a folder and words ending in ";" reach the session as they are', async () => {
    const folder = join(dir, "semi;");
    mkdirSync(folder);
    const args = join(dir, "semi.args");
    await terminal.open!(folder, { program: "/bin/sh", args: ["-c", `printf '%s\\n' "$(pwd -P)" "$@" > '${args}'`, "sh", "fix x;", ";"] });
    shown.length = 0;
    const got = await until(
      () => (existsSync(args) ? readFileSync(args, "utf8") : ""),
      (s) => s.split("\n").length >= 4,
    );
    assert.equal(got, `${realpathSync(folder)}\nfix x;\n;\n`);
  });

  test('open: a folder with "#" in its name (tmux reads a start folder as a format): started there, nothing run', async () => {
    const folder = join(dir, "C#Samples #(touch pwned)");
    mkdirSync(folder);
    const where = join(dir, "hash.pwd");
    await terminal.open!(folder, { program: "/bin/sh", args: ["-c", `pwd -P > '${where}'`] });
    shown.length = 0;
    const got = await until(
      () => (existsSync(where) ? readFileSync(where, "utf8") : ""),
      (s) => s.endsWith("\n"),
    );
    assert.equal(got, `${realpathSync(folder)}\n`);
    assert.equal(existsSync(join(dir, "pwned")), false);
  });

  test("open: the command runs without TMUX (nothing it runs reaches Kiko's server); the shell left after gets it back", async () => {
    const folder = join(dir, "notmux");
    mkdirSync(folder);
    const report = join(dir, "notmux.env");
    await terminal.open!(folder, { program: "/bin/sh", args: ["-c", `printf '%s|%s|%s\\n' "\${TMUX-unset}" "\${TMUX_PANE-unset}" "\${KIKO_KEPT_TMUX%%,*}" > '${report}'`] });
    shown.length = 0;
    const got = await until(
      () => (existsSync(report) ? readFileSync(report, "utf8") : ""),
      (s) => s.endsWith("\n"),
    );
    const socket = (await tmux(["display", "-p", "#{socket_path}"])).trim();
    assert.equal(got, `unset|unset|${socket}\n`);
    // The shell left in the pane (the test's login shell is /bin/sh): TMUX and TMUX_PANE as tmux set them.
    const pane = (await tmux(["list-panes", "-t", "=notmux", "-F", "#{pane_id}"])).trim();
    await tmux(["send-keys", "-t", pane, "-l", `printf '%s|%s\\n' "\${TMUX%%,*}" "$TMUX_PANE" > '${report}.after'`]);
    await tmux(["send-keys", "-t", pane, "Enter"]);
    const after = await until(
      () => (existsSync(`${report}.after`) ? readFileSync(`${report}.after`, "utf8") : ""),
      (s) => s.endsWith("\n"),
    );
    assert.equal(after, `${socket}|${pane}\n`);
  });

  test("open: a session of its own in the folder, running the command, shown", async () => {
    const note = await terminal.open!(dir, { program: "cat", args: [] });
    assert.equal(note, undefined);
    const name = dir
      .split("/")
      .pop()!
      .replace(/[^A-Za-z0-9_-]+/g, "-");
    assert.deepEqual(shown, [{ cwd: dir, session: name }]);
    const sessions = (await tmux(["list-sessions", "-F", "#{session_name}\t#{pane_current_path}"])).split("\n");
    assert.ok(
      sessions.some((line) => line.startsWith(`${name}\t`)),
      sessions.join(", "),
    );
  });

  test("kiko under the test runner with no stand-in app: refuses to start the real one", () => {
    // tmux can't make its socket here (TMUX_TMPDIR: no such folder), so even were the refusal
    // missing, nothing would start: it would fail on tmux instead, and this would say so.
    const run = spawnSync(process.execPath, [CLI_TS], {
      env: {
        ...cleanEnv(),
        TMUX_TMPDIR: join(dir, "no-such-folder"),
        KIKO_TMUX_SERVER: throwawayServer("refuse"),
        KIKO_SOCKET: join(dir, "no-app.sock"),
        KIKO_SETTINGS: join(dir, "no-settings.json"),
        NODE_TEST_CONTEXT: "child",
      },
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /NODE_TEST_CONTEXT.*not starting the real Kiko/);
  });

  test("kiko run by a session's own program (no TMUX, KIKO_KEPT_TMUX says where): refuses to show the window inside itself", () => {
    const server = throwawayServer("insession");
    for (const args of [[], ["attach", "pixie"]]) {
      const run = spawnSync(process.execPath, [CLI_TS, ...args], {
        env: {
          ...cleanEnv(),
          KIKO_TMUX_SERVER: server,
          KIKO_KEPT_TMUX: `/private/tmp/tmux-501/${server},1,0`,
          KIKO_SOCKET: join(dir, "no-app.sock"),
          KIKO_SETTINGS: join(dir, "no-settings.json"),
          NODE_TEST_CONTEXT: "child",
        },
        encoding: "utf8",
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /inside a session of Kiko's window already/);
    }
  });

  // `kiko claude` needs a terminal to attach to: it's run in a pane of a second throwaway server
  // (as if in the user's own tmux), and starts a third. Its PATH has a stand-in `claude` that writes
  // down what it got, and no real one anywhere: the real Claude Code must never start here.
  test("kiko claude: claude in a tmux session named for the folder, args and environment passed", async (t) => {
    // A ";" at the end: tmux would take it for the end of a command; "#S": a format, to tmux, in a start folder.
    const project = join(dir, "my C#Samples.v2;");
    const fakeBin = join(dir, "bin");
    const report = join(dir, "claude.report");
    const path = [fakeBin, dirname(process.execPath), "/usr/bin", "/bin"];
    if (path.slice(1).some((d) => existsSync(join(d, "claude")))) return t.skip("a real claude sits next to node");
    mkdirSync(project);
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, "claude"),
      `#!/bin/sh\n{ for a in "$@"; do echo "arg:$a"; done; echo "pwd:$(pwd)"; echo "TERM:$TERM"; echo "TMUX:\${TMUX-unset}"; echo "KIKO_KEPT_TMUX:\${KIKO_KEPT_TMUX%%,*}"; echo "MYVAR:$MYVAR"; echo "GHOSTTY:\${GHOSTTY_RESOURCES_DIR:-none}"; } > '${report}'\nsleep 3\n`,
      { mode: 0o755 },
    );
    const outer = tmuxRunner(OUTER, conf, { ...cleanEnv(), PATH: path.join(":") });
    await outer([
      "new-session",
      "-d",
      "-x",
      "100",
      "-y",
      "30",
      "-c",
      tmuxFormatArg(project),
      "-e",
      `PATH=${path.join(":")}`,
      "-e",
      `KIKO_TMUX_SERVER=${CLI_SERVER}`,
      "-e",
      "MYVAR=hello",
      "-e",
      "GHOSTTY_RESOURCES_DIR=/nope",
      // The Kiko window it opens runs a stand-in, never the app (window-live.test.ts has the window).
      "-e",
      "KIKO_WINDOW_APP=/bin/cat",
      "-e",
      `KIKO_SOCKET=${join(dir, "no-app.sock")}`,
      "-e",
      `KIKO_SETTINGS=${join(dir, "no-settings.json")}`,
      // And should that not be set: under the test runner, kiko refuses to start the real app.
      "-e",
      `NODE_TEST_CONTEXT=${process.env.NODE_TEST_CONTEXT || "child"}`,
      ...["--", "/bin/sh", "-c", '"$@"; echo "exit $?"; sleep 5', "sh", CLI, "claude", "--name", "Bug hunt", "it's a prompt", "fix x;", "--model", "opus", ";"].map(tmuxArg),
    ]);
    const got = await until(
      () => (existsSync(report) ? readFileSync(report, "utf8") : ""),
      (s) => s.includes("GHOSTTY:"),
      "the claude stand-in's report",
      8000,
    ).catch(async (err) => {
      // What the outer pane showed: kiko's own complaint, if any.
      throw new Error(`${err.message}\n${await outer(["capture-pane", "-p"]).catch((e) => String(e))}`);
    });
    const socket = (await tmuxRunner(CLI_SERVER, conf)(["display", "-p", "#{socket_path}"])).trim();
    assert.equal(
      got,
      [
        "arg:--name",
        "arg:Bug hunt",
        "arg:it's a prompt",
        "arg:fix x;",
        "arg:--model",
        "arg:opus",
        "arg:;",
        `pwd:${realpathSync(project)}`,
        "TERM:tmux-256color",
        // Claude Code off Kiko's server (nothing it runs can reach it), what TMUX said kept for kiko run there.
        "TMUX:unset",
        `KIKO_KEPT_TMUX:${socket}`,
        "MYVAR:hello",
        "GHOSTTY:none",
        "",
      ].join("\n"),
    );
    const names = (await tmuxRunner(CLI_SERVER, conf)(["list-sessions", "-F", "#{session_name}"])).split("\n");
    assert.deepEqual(names.filter(Boolean).sort(), ["_kiko", "my-C-Samples-v2"]);
  });
});
