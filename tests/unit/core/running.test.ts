// One Kiko app at a time (src/core/running.ts): the lock the app takes first thing, and what
// counts as an app running. A lock from an app that's gone is taken over; one from an app still
// starting (alive, not on the socket yet) isn't.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { afterApp, answers, CLOSE_HINT, lockPath as defaultLock, NO_KEY_EXIT, RESTART_EXIT, SAID_EXIT, startedAt, takeLock, UPDATE_EXIT } from "../../../src/core/running.ts";

const dir = mkdtempSync(join(tmpdir(), "kiko-running-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const RUNNING = fileURLToPath(new URL("../../../src/core/running.ts", import.meta.url));

/**
 * A separate app starting: takes the lock, says whether it got it, and holds it until let go (`release()`): until all
 * of a round have said, however long the slowest takes to start on a busy machine (a fixed hold let the winner exit
 * first there, and a late one took its lock over as left by an app that's gone).
 */
function starter(path: string): { said: Promise<string>; release(): Promise<void> } {
  const script = `import { takeLock } from ${JSON.stringify(RUNNING)}; const l = await takeLock(${JSON.stringify(join(dir, "none.sock"))}, ${JSON.stringify(path)}); console.log("release" in l ? "got" : "held"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
  const proc = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { env: { PATH: process.env.PATH, HOME: dir }, stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const said = new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.trim());
    });
    proc.once("exit", (code) => reject(new Error(`a starter exited (${code}) before saying: ${JSON.stringify(out)}`)));
  });
  return {
    said,
    release: () => {
      proc.stdin!.end();
      return exited;
    },
  };
}
let n = 0;
const lockPath = () => join(dir, `lock-${n++}`);

describe("the app's lock", () => {
  test("taken when free, with this pid and when it started; released", async () => {
    const path = lockPath();
    const lock = await takeLock(join(dir, "none.sock"), path);
    assert.ok("release" in lock);
    const started = await startedAt(process.pid);
    assert.match(started ?? "", /^\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/);
    assert.equal(readFileSync(path, "utf8"), `${process.pid}\n${started}\n`);
    lock.release();
    assert.ok("release" in (await takeLock(join(dir, "none.sock"), path)));
  });
  test("a lock with no start time (ps couldn't say) from an app still starting (alive, written just now): not taken", async () => {
    const path = lockPath();
    writeFileSync(path, String(process.ppid)); // a live process that isn't this one
    assert.deepEqual(await takeLock(join(dir, "none.sock"), path), { heldBy: process.ppid });
  });
  test("left by an app that's gone: taken over", async () => {
    const path = lockPath();
    writeFileSync(path, "999999"); // no such process
    assert.ok("release" in (await takeLock(join(dir, "none.sock"), path)));
  });
  test("held by the same process, however old and whatever the socket says (an app slow to answer is still the one app): not taken", async () => {
    const path = lockPath();
    writeFileSync(path, `${process.ppid}\n${await startedAt(process.ppid)}\n`);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    assert.deepEqual(await takeLock(join(dir, "none.sock"), path), { heldBy: process.ppid });
  });
  test("its pid alive but started at another time (the pid reused since): taken over, even written just now", async () => {
    const path = lockPath();
    writeFileSync(path, `${process.ppid}\nThu Jan  1 00:00:00 1970\n`);
    assert.ok("release" in (await takeLock(join(dir, "none.sock"), path)));
  });
  test("a lock with no start time: its pid lives on in something else, it's old, nothing on the socket: taken over", async () => {
    const path = lockPath();
    writeFileSync(path, String(process.ppid));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    assert.ok("release" in (await takeLock(join(dir, "none.sock"), path)));
  });
});

describe("a lock is never seen half written (the takeover race, 2026-10-29)", () => {
  test("made whole in one step: no file of its own left beside it", async () => {
    const path = join(dir, "whole", "app.lock");
    const lock = await takeLock(join(dir, "none.sock"), path);
    assert.ok("release" in lock);
    assert.deepEqual(readdirSync(join(dir, "whole")), ["app.lock"]);
    assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid}\n.+\n$`));
    lock.release();
  });
  test("one left empty long ago (an app that crashed making it): taken over", async () => {
    const path = lockPath();
    writeFileSync(path, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, old, old);
    assert.ok("release" in (await takeLock(join(dir, "none.sock"), path)));
  });
});

describe("where the lock is", () => {
  test("in a folder only you can open, never /tmp; next to a socket set by KIKO_SOCKET", async (t) => {
    const was = { HOME: process.env.HOME, SOCKET: process.env.KIKO_SOCKET };
    t.after(() => {
      process.env.HOME = was.HOME;
      if (was.SOCKET === undefined) delete process.env.KIKO_SOCKET;
      else process.env.KIKO_SOCKET = was.SOCKET;
    });
    process.env.HOME = join(dir, "home");
    delete process.env.KIKO_SOCKET;
    const path = defaultLock();
    assert.equal(path, join(dir, "home", ".config", "kiko-dev", "run", "app.lock"), "Kiko Dev's, in a checkout");
    const lock = await takeLock(join(dir, "none.sock"), path);
    assert.ok("release" in lock);
    assert.equal(statSync(join(dir, "home", ".config", "kiko-dev", "run")).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    lock.release();
    process.env.KIKO_SOCKET = join(dir, "test.sock");
    assert.equal(defaultLock(), join(dir, "test.sock.lock"));
  });
});

describe("several apps starting at once after a crash", () => {
  test("a lock left by an app that's gone: exactly one of them takes it over", async () => {
    for (let round = 0; round < 5; round++) {
      const path = lockPath();
      writeFileSync(path, "999999"); // the crashed app's
      const starters = Array.from({ length: 5 }, () => starter(path));
      const got = await Promise.all(starters.map((s) => s.said)).finally(() => Promise.all(starters.map((s) => s.release())));
      assert.deepEqual(got.filter((g) => g === "got").length, 1, `round ${round}: ${got.join(", ")}`);
    }
  });
});

describe("an app answering on the socket", () => {
  test("something listening answers; a file left behind or nothing doesn't", async () => {
    const path = join(dir, "s.sock");
    assert.equal(await answers(path), false);
    const server = createServer((c) => c.end());
    await new Promise<void>((r) => server.listen(path, r));
    assert.equal(await answers(path), true);
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(await answers(path), false);
  });
});

describe("what start.ts does once the app ended (afterApp)", () => {
  test("no model key: the key asked for in the window, never a window that just closes", () => {
    assert.equal(afterApp(NO_KEY_EXIT), "ask-key");
  });
  test("stopped before starting with a reason (another app, the lock): kept open on it until a key", () => {
    assert.equal(afterApp(SAID_EXIT), "keep-open");
    assert.equal(CLOSE_HINT, "Press Enter to close.");
  });
  test("restart, update, quit, crash: as before", () => {
    assert.equal(afterApp(RESTART_EXIT), "restart");
    assert.equal(afterApp(UPDATE_EXIT), "update");
    assert.equal(afterApp(0), "close");
    assert.equal(afterApp(1), "leave");
    assert.equal(afterApp(null), "leave");
  });
  test("the codes are their own", () => {
    assert.equal(new Set([NO_KEY_EXIT, SAID_EXIT, RESTART_EXIT, UPDATE_EXIT, 0, 1, 130]).size, 7);
  });
});
