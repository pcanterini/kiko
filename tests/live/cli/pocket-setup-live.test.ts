// Pocket's install on a Mac with nothing on it, for real (pocket/setup.sh): a home and Kiko folder
// of this test's own, a PATH with no uv and no Python (a few of macOS's tools, linked), so setup.sh
// fetches the pinned uv from GitHub (its real checksum checked against the pin), which fetches its
// own Python 3.12 and installs pocket-tts. Then: the venv imports pocket_tts, its Python is the one
// in Kiko's pocket-uv/, and nothing went to ~/.local/share/uv or ~/.cache/uv (the test's home).
// It doesn't start the server (the model is another 1 GB). Never the real ~/.local/share/kiko.
//
// Downloads a few hundred MB (uv, Python, torch), so the normal suite skips it:
// KIKO_POCKET_LIVE=1 runs it. A few minutes on a fast line.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const SETUP = fileURLToPath(new URL("../../../pocket/setup.sh", import.meta.url));
const TOOLS = ["/usr/bin/dirname", "/usr/bin/touch", "/usr/bin/uname", "/usr/bin/curl", "/usr/bin/shasum", "/usr/bin/tar", "/usr/bin/mktemp", "/usr/bin/cut", "/usr/sbin/sysctl"];
const skip = process.env.KIKO_POCKET_LIVE !== "1" ? "downloads a few hundred MB: KIKO_POCKET_LIVE=1 runs it" : process.platform !== "darwin" ? "macOS only" : false;

describe("pocket/setup.sh on a Mac with no uv and no Python", { skip }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pocket-live-")));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const share = join(home, ".local", "share", "kiko");
  const venv = join(share, "pocket-venv");
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("fetches the pinned uv, which fetches its Python, and installs pocket-tts, all in Kiko's folder", () => {
    mkdirSync(bin, { recursive: true });
    mkdirSync(share, { recursive: true });
    for (const tool of TOOLS) symlinkSync(tool, join(bin, tool.split("/").pop()!));
    const env = { PATH: `${bin}:/bin`, HOME: home, TMPDIR: dir, LANG: "en_US.UTF-8", POCKET_VENV: venv };
    assert.notEqual(spawnSync("/bin/sh", ["-c", "command -v uv || command -v python3"], { env }).status, 0, "no uv or Python on this PATH");

    const run = spawnSync("/bin/sh", [SETUP], { env, encoding: "utf8", timeout: 20 * 60_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /fetching uv 0\.13\.1/);
    assert.ok(existsSync(join(share, "pocket-uv", "bin", "uv")));
    assert.equal(existsSync(join(venv, ".installing")), false);

    const python = join(venv, "bin", "python");
    const where = spawnSync(python, ["-I", "-c", "import sys, pocket_tts; print(sys.base_prefix)"], { env, encoding: "utf8" });
    assert.equal(where.status, 0, where.stderr);
    assert.ok(realpathSync(where.stdout.trim()).startsWith(join(share, "pocket-uv", "python")), `its Python: ${where.stdout}`);
    assert.ok(existsSync(join(share, "pocket-uv", "cache")), "uv's cache in Kiko's folder");
    for (const shared of [join(home, ".local", "share", "uv"), join(home, ".cache", "uv"), join(home, "Library", "Caches", "pip")]) assert.equal(existsSync(shared), false, `nothing in ${shared}`);
  });
});
