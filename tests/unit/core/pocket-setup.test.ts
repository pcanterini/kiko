// pocket/setup.sh's choice of what installs Pocket, on a Mac with nothing in particular: a uv on the
// PATH first, then the uv it fetched before, then a Python 3.10+, else it fetches the pinned uv (its
// SHA-256 checked first: a wrong one, or a failed download, runs nothing and says why, and the
// background download, src/core/pocket-prep.ts, is "failed"). No network: uv, python3 and pip are
// stubs that only write down how they were run, and "the download" is a file:// URL
// (KIKO_UV_URL). Each run has a PATH of its own (a few of macOS's tools, linked) with no real uv
// or Python on it, and a home and Kiko folder in a temp folder of its own. Also: Pocket's model
// in a Hugging Face folder of its own (src/core/pocket-tts.ts pocketHfEnv; adopting one another
// install has: pocket-adopt.test.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { pocketPrepState, startPocketPrep } from "../../../src/core/pocket-prep.ts";
import { pocketHfEnv, prepFile } from "../../../src/core/pocket-tts.ts";

const SETUP = fileURLToPath(new URL("../../../pocket/setup.sh", import.meta.url));
const REQUIREMENTS = fileURLToPath(new URL("../../../pocket/requirements.txt", import.meta.url));
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64";
const TOOLS = ["/usr/bin/dirname", "/usr/bin/touch", "/usr/bin/uname", "/usr/bin/curl", "/usr/bin/shasum", "/usr/bin/tar", "/usr/bin/mktemp", "/usr/bin/cut", "/usr/sbin/sysctl"];
const skip = process.platform !== "darwin" ? "macOS only" : false;

/** A stub that writes `name`, its arguments and uv's folders into `log`, and makes the venv's python when asked to make a venv. */
const stub = (name: string, log: string, more = "") => `#!/bin/sh\necho "${name} $* | $UV_PYTHON_INSTALL_DIR | $UV_CACHE_DIR | $UV_PYTHON_PREFERENCE" >> '${log}'\n${more}exit 0\n`;
const UV_VENV = 'if [ "$1" = venv ]; then mkdir -p "$4/bin" && : > "$4/bin/python"; fi\n';

function writeExe(path: string, text: string) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A world of its own: setup.sh copied in (pin: its uv pins set to another checksum), a PATH of only `bin` and /bin. */
function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pocket-setup-")));
  const bin = join(dir, "bin");
  const pocket = join(dir, "pocket");
  const share = join(dir, "share");
  mkdirSync(bin);
  mkdirSync(pocket);
  mkdirSync(join(dir, "home"));
  for (const tool of TOOLS) if (existsSync(tool)) symlinkSync(tool, join(bin, tool.split("/").pop()!));
  writeFileSync(join(pocket, "setup.sh"), readFileSync(SETUP, "utf8"));
  writeFileSync(join(pocket, "requirements.txt"), readFileSync(REQUIREMENTS, "utf8"));
  const pin = (sha: string) =>
    writeFileSync(
      join(pocket, "setup.sh"),
      readFileSync(SETUP, "utf8").replace(/^UV_SHA256_(aarch64|x86_64)=\w+$/gm, (_, arch) => `UV_SHA256_${arch}=${sha}`),
    );
  const log = join(dir, "ran.log");
  const venv = join(share, "pocket-venv");
  const env = (url = `file://${dir}/nothing-here.tar.gz`) => ({ PATH: `${bin}:/bin`, HOME: join(dir, "home"), TMPDIR: dir, POCKET_VENV: venv, KIKO_UV_URL: url });
  const run = (url?: string) => spawnSync("/bin/sh", [join(pocket, "setup.sh")], { env: env(url), encoding: "utf8", cwd: dir });
  const ran = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { dir, bin, pocket, share, log, venv, env, run, ran, pin };
}

/** A uv release archive as uv's are (uv-<arch>-apple-darwin/uv), its uv a stub: the file and its SHA-256. */
function uvArchive(dir: string, log: string): { file: string; sha: string } {
  const work = join(dir, "release");
  mkdirSync(join(work, `uv-${ARCH}-apple-darwin`), { recursive: true });
  writeExe(join(work, `uv-${ARCH}-apple-darwin`, "uv"), stub("own-uv", log, UV_VENV));
  const file = join(dir, `uv-${ARCH}-apple-darwin.tar.gz`);
  execFileSync("tar", ["-C", work, "-czf", file, `uv-${ARCH}-apple-darwin`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return { file, sha: execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(" ")[0] };
}

describe("pocket/setup.sh: what installs Pocket", { skip }, () => {
  test("a uv on the PATH: used, with its Python and cache kept in Kiko's pocket-uv/; nothing fetched", () => {
    const w = world();
    writeExe(join(w.bin, "uv"), stub("path-uv", w.log, UV_VENV));
    writeExe(join(w.bin, "python3"), stub("python3", w.log));
    const run = w.run();
    assert.equal(run.status, 0, run.stderr);
    const uvHome = join(w.share, "pocket-uv");
    assert.equal(
      w.ran(),
      `path-uv venv --python 3.12 ${w.venv} | ${uvHome}/python | ${uvHome}/cache | only-managed\n` +
        `path-uv pip install --python ${w.venv}/bin/python pocket-tts==4.0.1 | ${uvHome}/python | ${uvHome}/cache | only-managed\n`,
    );
    assert.equal(existsSync(join(uvHome, "bin", "uv")), false, "no uv of its own");
    assert.equal(existsSync(join(w.venv, ".installing")), false, "finished");
    assert.match(run.stdout, /Pocket TTS installed in .*: pocket-tts==4\.0\.1$/m);
  });

  test("no uv, a Python 3.10+: a venv of it and pip (no download cache kept); nothing fetched", () => {
    const w = world();
    const pip = `#!/bin/sh\necho "pip $*" >> '${w.log}'\n`;
    writeExe(
      join(w.bin, "python3"),
      `#!/bin/sh\necho "python3 $*" >> '${w.log}'\nif [ "$1" = -m ]; then mkdir -p "$3/bin" && : > "$3/bin/python" && printf '%s' '${pip}' > "$3/bin/pip" && chmod 755 "$3/bin/pip"; fi\n`,
    );
    const run = w.run();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(w.ran(), `python3 -c import sys; sys.exit(sys.version_info < (3, 10))\npython3 -m venv ${w.venv}\npip install --no-cache-dir pocket-tts==4.0.1\n`);
    assert.equal(existsSync(join(w.share, "pocket-uv")), false);
  });

  test("a Python older than 3.10 doesn't count", () => {
    const w = world();
    writeExe(join(w.bin, "python3"), `#!/bin/sh\necho "python3 $*" >> '${w.log}'\nexit 1\n`);
    const run = w.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /couldn't download uv/, "it went on to fetch uv");
  });

  test("neither: the pinned uv fetched, checked and unpacked into pocket-uv/, then it makes the venv; the next run uses it without fetching", () => {
    const w = world();
    const { file, sha } = uvArchive(w.dir, w.log);
    // Pinned to this archive's checksum, as the real pins are the real uv's.
    w.pin(sha);
    const run = w.run(`file://${file}`);
    assert.equal(run.status, 0, run.stderr);
    const uvHome = join(w.share, "pocket-uv");
    const own = join(uvHome, "bin", "uv");
    assert.equal(readFileSync(own, "utf8"), readFileSync(join(w.dir, "release", `uv-${ARCH}-apple-darwin`, "uv"), "utf8"), "the archive's uv, in place");
    assert.match(run.stdout, new RegExp(`fetching uv 0\\.13\\.1 \\(${ARCH}\\) from file://`));
    assert.equal(
      w.ran(),
      `own-uv venv --python 3.12 ${w.venv} | ${uvHome}/python | ${uvHome}/cache | only-managed\n` +
        `own-uv pip install --python ${w.venv}/bin/python pocket-tts==4.0.1 | ${uvHome}/python | ${uvHome}/cache | only-managed\n`,
    );
    assert.deepEqual(readdirSync(uvHome), ["bin"], "only uv itself (the stub made no Python or cache)");
    assert.deepEqual(
      readdirSync(w.share).filter((n) => n.startsWith("pocket-uv-download")),
      [],
      "the download's folder is gone",
    );
    const again = w.run();
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /fetching uv/);
    assert.match(w.ran().split("\n").at(-2) ?? "", /^own-uv pip install/);
  });

  test("a uv on the PATH wins over Kiko's own", () => {
    const w = world();
    mkdirSync(join(w.share, "pocket-uv", "bin"), { recursive: true });
    writeExe(join(w.share, "pocket-uv", "bin", "uv"), stub("own-uv", w.log, UV_VENV));
    writeExe(join(w.bin, "uv"), stub("path-uv", w.log, UV_VENV));
    assert.equal(w.run().status, 0);
    assert.doesNotMatch(w.ran(), /own-uv/);
  });

  test("a checksum that doesn't match the pin: refused, nothing unpacked or run, and it says why", () => {
    const w = world();
    const { file, sha } = uvArchive(w.dir, w.log);
    const run = w.run(`file://${file}`);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, new RegExp(`the uv download's checksum is wrong \\(expected [0-9a-f]{64}, got ${sha}\\): it was deleted, not run`));
    assert.equal(w.ran(), "", "the downloaded uv never ran");
    assert.equal(existsSync(join(w.share, "pocket-uv")), false);
    assert.equal(existsSync(w.venv), false);
    assert.deepEqual(
      readdirSync(w.share).filter((n) => n.startsWith("pocket-uv-download")),
      [],
    );
  });

  test("a download that fails: stopped, and it says so", () => {
    const w = world();
    const run = w.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Pocket TTS: couldn't download uv from file:\/\/.*nothing-here\.tar\.gz/);
    assert.equal(existsSync(w.venv), false);
  });

  test("first-run setup's background download, with a uv whose checksum is wrong: failed, and its log says why", async () => {
    const w = world();
    const { file } = uvArchive(w.dir, w.log);
    // startPocketPrep runs setup.sh with this process's environment: this world's, for the moment it starts it.
    const theirs = w.env(`file://${file}`);
    const saved = Object.fromEntries(Object.keys(theirs).map((k) => [k, process.env[k]]));
    Object.assign(process.env, theirs);
    try {
      mkdirSync(w.share, { recursive: true });
      assert.equal(startPocketPrep(w.venv, { script: join(w.pocket, "setup.sh"), serve: join(w.pocket, "serve.py") }, 1), "started");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    for (let i = 0; i < 200 && pocketPrepState(w.venv) !== "failed"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pocketPrepState(w.venv), "failed");
    assert.match(readFileSync(prepFile(w.venv, "log"), "utf8"), /the uv download's checksum is wrong/);
    assert.equal(w.ran(), "");
  });
});

describe("Pocket's model: in a Hugging Face folder of its own", () => {
  test("its server's HF_HOME (and hub, xet) are pocket-hf/ beside the venv, whatever HF_* is set", () => {
    assert.deepEqual(pocketHfEnv("/s/pocket-venv"), { HF_HOME: "/s/pocket-hf", HF_HUB_CACHE: "/s/pocket-hf/hub", HF_XET_CACHE: "/s/pocket-hf/xet" });
  });
});
