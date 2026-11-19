// The Kiko window's pane and popup programs end when their terminal goes (src/terminals/tmux/pane-life.ts):
// the viewer (viewer-pane.ts) by whichever sign comes first (SIGHUP, its input ending, its output's
// reader gone, its parent gone: left to launchd, as tmux's server going leaves it), and when tmux
// says its pane is gone or runs another program; the frame (frame-pane.ts) and a menu's popup
// (menu-popup.ts) the same way; and paneLook, what one look at a pane through tmux says. The real
// programs run on pipes, never in tmux: their tmux is /usr/bin/false, or a fake one (a shell script
// in this test's folder that says what it's told to), and no TMUX names a real server.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { paneLook } from "../../../src/terminals/tmux/pane-life.ts";
import { checkWaits } from "../../support/until.ts";

const program = (file: string) => fileURLToPath(new URL(`../../../src/terminals/tmux/${file}`, import.meta.url));
const VIEWER = program("viewer-pane.ts");
const dir = mkdtempSync(join(tmpdir(), "viewer-pane-"));
const line = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: new Date().toISOString() })}\n`;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TMUX" && k !== "TMUX_PANE"));
const started: number[] = [];
after(() => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ended, as it should have
    }
  }
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = checkWaits(6000, 50);
/** A transcript of its own, with a line in it. */
function transcript(name: string) {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, line("fix the login bug"));
  return path;
}
/** The viewer on pipes, its output collected; resolves once it has drawn. */
async function viewer(name: string) {
  const path = transcript(name);
  const child = spawn(process.execPath, [VIEWER, "/usr/bin/false", path], { env, stdio: ["pipe", "pipe", "ignore"] });
  started.push(child.pid!);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  await until(() => out.includes("fix the login bug"), "its first frame");
  return { child, path, exited, out: () => out };
}
const ended = (exited: Promise<number | null>, ms = 6000) => Promise.race([exited, wait(ms).then(() => "still running" as const)]);

/**
 * A fake tmux: whatever it's asked, it says what `say` last set. "self": its caller's pid as the
 * pane's (its parent: a program runs tmux with no shell between) and "{}" as an option's value;
 * "other": another program's pid; "gone": tmux's words for a server that isn't there; "menu": a menu.
 */
function fakeTmux(name: string) {
  const path = join(dir, `tmux-${name}`);
  writeFileSync(
    path,
    `#!/bin/sh
case "$(cat "$0.say")" in
  self) echo "$PPID"; echo '{}' ;;
  other) echo 99999 ;;
  gone) echo "no server running on /tmp/fake-${name}" >&2; exit 1 ;;
  menu) echo '{"title":"Menu","items":[]}' ;;
esac
`,
  );
  chmodSync(path, 0o755);
  const say = (what: "self" | "other" | "gone" | "menu") => writeFileSync(`${path}.say`, what);
  return { path, say };
}
/** A program run as in a pane of a fake tmux (TMUX_PANE %1; TMUX names no server), its output collected. */
function inFakePane(args: string[], extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, { env: { ...env, TMUX: join(dir, "no-server,1,0"), TMUX_PANE: "%1", ...extra }, stdio: ["pipe", "pipe", "ignore"] });
  started.push(child.pid!);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, exited, out: () => out };
}

describe("the viewer ends when its terminal goes", () => {
  test("SIGHUP (its pane closed, its server gone): it ends, writing nothing more to the terminal that hung up", async () => {
    const { child, exited, out } = await viewer("hup");
    const before = out().length;
    child.kill("SIGHUP");
    assert.equal(await ended(exited), 0);
    assert.equal(out().length, before, "nothing written after the hangup");
  });

  test("its input ends: it ends", async () => {
    const { child, exited } = await viewer("eof");
    child.stdin!.end();
    assert.equal(await ended(exited), 0);
  });

  test("its output's reader gone: the next frame's write fails, and it ends", async () => {
    const { child, path, exited } = await viewer("epipe");
    child.stdout!.destroy();
    appendFileSync(path, line("and the signup one")); // a new frame to write
    assert.equal(await ended(exited), 0);
  });

  test("its parent gone (left to launchd), its input still open and no SIGHUP: it ends by itself", async () => {
    // A shell starts it in the background, says its pid on fd 3, and exits once told (its input
    // ends): the viewer is left to launchd. The viewer's input is a FIFO it opens to read and
    // write, so it never ends; its output, this test's pipe, stays open.
    const path = transcript("orphan");
    const fifo = join(dir, "orphan-input");
    execFileSync("mkfifo", [fifo]);
    const shell = spawn("/bin/sh", ["-c", '"$@" 0<>"$FIFO" 3>&- & echo $! >&3; read _', "sh", process.execPath, VIEWER, "/usr/bin/false", path], {
      env: { ...env, FIFO: fifo },
      stdio: ["pipe", "pipe", "ignore", "pipe"],
    });
    let said = "";
    let out = "";
    (shell.stdio[3] as NodeJS.ReadableStream).on("data", (d) => (said += d));
    shell.stdout!.on("data", (d) => (out += d));
    await until(() => /^\d+\n/.test(said) && out.includes("fix the login bug"), "it to start and draw");
    const pid = Number(said.trim());
    started.push(pid);
    shell.stdin!.end();
    await new Promise((r) => shell.on("exit", r));
    await wait(300);
    assert.ok(alive(pid), "running on, left to launchd");
    await until(() => !alive(pid), "the orphaned viewer to end");
  });
});

describe("its self-check: tmux asked every second (a fake tmux)", () => {
  test("the viewer: its pane running it, it runs on; tmux's server gone, it ends after three looks", async () => {
    const tmux = fakeTmux("viewer-gone");
    tmux.say("self");
    const v = inFakePane([VIEWER, tmux.path, transcript("fake-gone")]);
    await until(() => v.out().includes("fix the login bug"), "its first frame");
    assert.equal(await ended(v.exited, 3500), "still running");
    tmux.say("gone");
    assert.equal(await ended(v.exited, 6000), 0);
  });

  test("the viewer: its pane respawned with another program, it ends", async () => {
    const tmux = fakeTmux("viewer-other");
    tmux.say("other");
    const v = inFakePane([VIEWER, tmux.path, transcript("fake-other")]);
    assert.equal(await ended(v.exited, 6000), 0);
  });

  test("the frame: the same, its pane looked at every second", async () => {
    const tmux = fakeTmux("frame");
    tmux.say("self");
    const f = inFakePane([program("frame-pane.ts"), tmux.path]);
    assert.equal(await ended(f.exited, 3500), "still running");
    tmux.say("gone");
    assert.equal(await ended(f.exited, 6000), 0);
  });
});

describe("the frame and a menu's popup end with their terminal too", () => {
  test("the frame: SIGHUP, writing nothing more; its input's end", async () => {
    const tmux = fakeTmux("frame-hup");
    tmux.say("self");
    const f = inFakePane([program("frame-pane.ts"), tmux.path]);
    await until(() => f.out().length > 0, "its first paint");
    await wait(300);
    const before = f.out().length;
    f.child.kill("SIGHUP");
    assert.equal(await ended(f.exited), 0);
    assert.equal(f.out().length, before, "nothing written after the hangup");
    const g = inFakePane([program("frame-pane.ts"), tmux.path]);
    await until(() => g.out().length > 0, "its first paint");
    g.child.stdin!.end();
    assert.equal(await ended(g.exited), 0);
  });

  test("a menu's popup: its input's end, SIGHUP", async () => {
    const tmux = fakeTmux("menu");
    tmux.say("menu");
    const m = inFakePane([program("menu-popup.ts"), tmux.path, "@menu"]);
    await until(() => m.out().length > 0, "the menu drawn");
    m.child.stdin!.end();
    assert.equal(await ended(m.exited), 0);
    const n = inFakePane([program("menu-popup.ts"), tmux.path, "@menu"]);
    await until(() => n.out().length > 0, "the menu drawn");
    n.child.kill("SIGHUP");
    assert.equal(await ended(n.exited), 0);
  });
});

describe("one look at its pane (paneLook)", () => {
  const own = [4242, 100];

  test("its pane, still running it: not gone, the info as sent", () => {
    assert.deepEqual(paneLook('4242\n{"name":"notes"}\n', "", own), { gone: false, info: '{"name":"notes"}' });
    assert.deepEqual(paneLook("100\n{}\n", "", own), { gone: false, info: "{}" }, "a shell between tmux and it");
  });

  test("no info set yet: not gone, no info", () => {
    assert.deepEqual(paneLook("4242\n", "invalid option: @kiko-viewer-info\n", own), { gone: false, info: null });
  });

  test("the pane running another program now (respawned): gone", () => {
    assert.equal(paneLook("5151\n{}\n", "", own).gone, true);
  });

  test("its pane or its server not there: gone", () => {
    for (const err of ["no server running on /tmp/tmux-501/kiko\n", "error connecting to /tmp/tmux-501/kiko (No such file or directory)\n", "no such pane: %7\n", "can't find pane: %7\n"]) {
      assert.deepEqual(paneLook("", err, own), { gone: true, info: null }, err);
    }
    assert.equal(paneLook("\n", "no such pane: %7\n", own).gone, true);
  });

  test("tmux slow or failing otherwise (killed on its timeout, nothing said): not gone", () => {
    assert.deepEqual(paneLook("", "", own), { gone: false, info: null });
    assert.deepEqual(paneLook("", "server exited unexpectedly\n", own), { gone: false, info: null });
  });
});
