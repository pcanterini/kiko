// Pocket installed once per flavour and shared by every copy (src/core/app-root.ts pocketPaths,
// src/core/pocket-tts.ts pickPocketVenv, requirementsMatch; src/core/pocket-prep.ts prepLock):
// where it lives for a checkout and for the release, a checkout's own pocket/.venv from before used
// until the shared one is ready, the venv set up again when a checkout's requirements.txt differs,
// an install that's there never set up or downloaded again, and two starts at once running setup
// once. Everything in temp folders with a made-up home; no real Pocket, uv or Python: setup.sh's
// uv is a stub that only writes down how it ran.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { pocketPaths } from "../../../src/core/app-root.ts";
import { pocketPrepState, prepLock, startPocketPrep } from "../../../src/core/pocket-prep.ts";
import { pickPocketVenv, pocketHfEnv, pocketInstalled, prepFile, requirementsMatch, requirementsStamp } from "../../../src/core/pocket-tts.ts";
import { checkWaits } from "../../support/until.ts";

const SETUP = fileURLToPath(new URL("../../../pocket/setup.sh", import.meta.url));
const PREP = new URL("../../../src/core/pocket-prep.ts", import.meta.url).href;
const skip = process.platform !== "darwin" ? "macOS only" : false;
const waitFor = checkWaits(10_000, 50);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "pocket-shared-")));

/** A venv as setup.sh leaves it: its python, and (`stamp`) the SHA-256 of the requirements it installed. */
function venvAt(venv: string, stamp?: string) {
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(join(venv, "bin", "python"), "");
  if (stamp !== undefined) writeFileSync(requirementsStamp(venv), `${stamp}\n`);
  return venv;
}

describe("where Pocket lives: once per flavour, outside any checkout", () => {
  const home = "/Users/someone";
  const none = {} as NodeJS.ProcessEnv;

  test("a checkout (Kiko Dev): ~/.local/share/kiko-dev/pocket-venv, its log in ~/.local/state/kiko-dev; its own pocket/.venv only as the old place", () => {
    const root = join(tempDir(), "code", "kiko");
    mkdirSync(root, { recursive: true });
    assert.deepEqual(pocketPaths(none, home, false, root), {
      home: "/Users/someone/.local/share/kiko-dev",
      shared: "/Users/someone/.local/share/kiko-dev/pocket-venv",
      legacy: [join(root, "pocket", ".venv")],
      log: "/Users/someone/.local/state/kiko-dev/pocket-server.log",
    });
  });

  test("the release: ~/.local/share/kiko/pocket-venv (where it always was), its log in ~/.local/state/kiko; never a checkout's", () => {
    assert.deepEqual(pocketPaths(none, home, true, "/Users/someone/.local/share/kiko/versions/0.3.15"), {
      home: "/Users/someone/.local/share/kiko",
      shared: "/Users/someone/.local/share/kiko/pocket-venv",
      legacy: [],
      log: "/Users/someone/.local/state/kiko/pocket-server.log",
    });
  });

  test("the two flavours never share a venv", () => {
    assert.notEqual(pocketPaths(none, home, false, "/x").shared, pocketPaths(none, home, true, "/x").shared);
  });

  test("KIKO_POCKET_VENV wins, for either; no old place looked at, the log beside it", () => {
    const env = { KIKO_POCKET_VENV: "/tmp/somewhere/.venv" } as NodeJS.ProcessEnv;
    for (const installed of [false, true]) {
      const paths = pocketPaths(env, home, installed, "/x");
      assert.equal(paths.shared, "/tmp/somewhere/.venv");
      assert.deepEqual(paths.legacy, []);
      assert.equal(paths.log, "/tmp/somewhere/pocket-server.log");
    }
  });

  test("a git worktree: its own pocket/.venv, then its main checkout's", () => {
    const dir = tempDir();
    const main = join(dir, "kiko");
    const tree = join(dir, "kiko-branch");
    mkdirSync(join(main, ".git", "worktrees", "kiko-branch"), { recursive: true });
    mkdirSync(tree);
    writeFileSync(join(tree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "kiko-branch")}\n`);
    assert.deepEqual(pocketPaths(none, home, false, tree).legacy, [join(tree, "pocket", ".venv"), join(main, "pocket", ".venv")]);
  });

  test("the unit tests' own: a venv that isn't there, never the Mac's", () => {
    assert.match(String(process.env.KIKO_POCKET_VENV), /\/no-pocket\/pocket-venv$/);
    assert.equal(pocketPaths().shared, process.env.KIKO_POCKET_VENV);
    assert.deepEqual(pocketPaths().legacy, []);
  });
});

describe("the venv this run speaks with", () => {
  const world = () => {
    const dir = tempDir();
    const requirements = join(dir, "requirements.txt");
    writeFileSync(requirements, "pocket-tts==4.0.1\n");
    return { dir, requirements, shared: join(dir, "share", "pocket-venv"), legacy: join(dir, "checkout", "pocket", ".venv"), main: join(dir, "main", "pocket", ".venv") };
  };

  test("the shared one when it's installed, even with an old one there", () => {
    const w = world();
    venvAt(w.shared, sha256("pocket-tts==4.0.1\n"));
    venvAt(w.legacy);
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.shared);
  });

  test("no shared one yet: a checkout's own pocket/.venv that's whole (the first), so a Mac with Pocket keeps it meanwhile", () => {
    const w = world();
    venvAt(w.main);
    assert.equal(pickPocketVenv(w.shared, [w.legacy, w.main], w.requirements), w.main, "the main checkout's, this one having none");
    venvAt(w.legacy);
    assert.equal(pickPocketVenv(w.shared, [w.legacy, w.main], w.requirements), w.legacy, "this checkout's first");
  });

  test("an old one that isn't whole (setup.sh stopped halfway, its Python gone) isn't used: the shared one, to be set up", () => {
    const w = world();
    venvAt(w.legacy);
    writeFileSync(join(w.legacy, ".installing"), "");
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.shared);
    rmSync(w.legacy, { recursive: true });
    mkdirSync(join(w.legacy, "bin"), { recursive: true });
    symlinkSync(join(w.dir, "python-that-was-removed"), join(w.legacy, "bin", "python"));
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.shared);
    assert.equal(pickPocketVenv(w.shared, [], w.requirements), w.shared, "nothing anywhere");
  });

  test("the shared one being set up by another copy, or set up for other requirements: an old whole one meanwhile", () => {
    const w = world();
    venvAt(w.shared, sha256("pocket-tts==3.9.0\n"));
    venvAt(w.legacy);
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.legacy, "other requirements");
    writeFileSync(requirementsStamp(w.shared), sha256("pocket-tts==4.0.1\n"));
    writeFileSync(prepFile(w.shared, "preparing"), String(process.pid));
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.legacy, "being prepared");
    rmSync(prepFile(w.shared, "preparing"));
    assert.equal(pickPocketVenv(w.shared, [w.legacy], w.requirements), w.shared);
  });
});

describe("requirements.txt: the shared venv set up again when a checkout's differ", () => {
  test("the stamp: no stamp counts (an older install); the same SHA-256 counts; another doesn't", () => {
    const dir = tempDir();
    const requirements = join(dir, "requirements.txt");
    writeFileSync(requirements, "pocket-tts==4.0.1\n");
    const venv = venvAt(join(dir, "venv"));
    assert.equal(requirementsMatch(venv, requirements), true, "no stamp");
    assert.equal(pocketInstalled(venv, requirements), true);
    writeFileSync(requirementsStamp(venv), `${sha256(readFileSync(requirements))}\n`);
    assert.equal(pocketInstalled(venv, requirements), true);
    writeFileSync(requirements, "pocket-tts==4.0.2\n");
    assert.equal(requirementsMatch(venv, requirements), false);
    assert.equal(pocketInstalled(venv, requirements), false, "not installed for this copy: set up again");
    assert.equal(requirementsMatch(venv, join(dir, "none.txt")), true, "a copy with no requirements.txt");
  });

  test("setup.sh writes the stamp; a checkout with other requirements runs it again on the same venv, and the stamp follows", { skip }, () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const pocket = join(dir, "pocket");
    mkdirSync(bin);
    mkdirSync(pocket);
    mkdirSync(join(dir, "home"));
    for (const tool of ["/usr/bin/dirname", "/usr/bin/touch", "/usr/bin/shasum", "/usr/bin/cut"]) symlinkSync(tool, join(bin, tool.split("/").pop()!));
    const log = join(dir, "ran.log");
    writeFileSync(join(bin, "uv"), `#!/bin/sh\necho "uv $*" >> '${log}'\nif [ "$1" = venv ]; then mkdir -p "$4/bin" && : > "$4/bin/python" && chmod 755 "$4/bin/python"; fi\nexit 0\n`);
    chmodSync(join(bin, "uv"), 0o755);
    writeFileSync(join(pocket, "setup.sh"), readFileSync(SETUP, "utf8"));
    const requirements = join(pocket, "requirements.txt");
    writeFileSync(requirements, "# a comment\npocket-tts==4.0.1  # pinned\n");
    const venv = join(dir, "share", "pocket-venv");
    const run = () => spawnSync("/bin/sh", [join(pocket, "setup.sh")], { env: { PATH: `${bin}:/bin`, HOME: join(dir, "home"), TMPDIR: dir, POCKET_VENV: venv }, encoding: "utf8" });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(requirementsStamp(venv), "utf8").trim(), sha256(readFileSync(requirements)));
    assert.equal(pocketInstalled(venv, requirements), true);

    // Another checkout's requirements: not installed for it, until setup.sh runs again (on the same venv).
    writeFileSync(requirements, "pocket-tts==4.1.0\nnumpy<3\n");
    assert.equal(pocketInstalled(venv, requirements), false);
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(lines, [`uv venv --python 3.12 ${venv}`, `uv pip install --python ${venv}/bin/python pocket-tts==4.0.1`, `uv pip install --python ${venv}/bin/python pocket-tts==4.1.0 numpy<3`], "the venv made once, the packages brought up to date");
    assert.equal(pocketInstalled(venv, requirements), true);
    assert.equal(existsSync(join(venv, ".installing")), false);
  });

  test("setup.sh with no requirements.txt beside it: stops, and says so", { skip }, () => {
    const dir = tempDir();
    mkdirSync(join(dir, "pocket"));
    writeFileSync(join(dir, "pocket", "setup.sh"), readFileSync(SETUP, "utf8"));
    const run = spawnSync("/bin/sh", [join(dir, "pocket", "setup.sh")], { env: { PATH: "/usr/bin:/bin", HOME: dir, POCKET_VENV: join(dir, "venv") }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Pocket TTS: there's no .*requirements\.txt/);
    assert.equal(existsSync(join(dir, "venv")), false);
  });
});

/** A Pocket model folder in `hub` as Hugging Face writes it: one blob named by its SHA-256, a snapshot's relative link to it. */
function modelIn(hub: string) {
  const name = "models--kyutai--pocket-tts";
  const data = "the voice's weights";
  const blob = sha256(data);
  mkdirSync(join(hub, name, "blobs"), { recursive: true });
  mkdirSync(join(hub, name, "snapshots", "rev1"), { recursive: true });
  writeFileSync(join(hub, name, "blobs", blob), data);
  symlinkSync(`../../blobs/${blob}`, join(hub, name, "snapshots", "rev1", "model.safetensors"));
  return { name, data };
}

describe("what's on the Mac already: never set up or downloaded again", () => {
  const scripts = (dir: string, body: string) => {
    const script = join(dir, "setup.sh");
    writeFileSync(script, body);
    return { script, serve: join(dir, "serve.py") };
  };

  test("the shared venv installed: its download is ready at once; setup.sh never runs", () => {
    const dir = tempDir();
    const venv = venvAt(join(dir, "share", "pocket-venv"));
    const ran = join(dir, "ran");
    assert.equal(startPocketPrep(venv, scripts(dir, `echo ran >> '${ran}'\n`), 1, []), "ready");
    assert.equal(pocketPrepState(venv), "ready");
    assert.equal(existsSync(ran), false);
  });

  test("an old checkout's venv in use, the shared one made: the model cloned from the old one's pocket-hf before setup.sh runs, the old one left as it was", async () => {
    const dir = tempDir();
    const checkout = join(dir, "checkout", "pocket");
    const legacy = venvAt(join(checkout, ".venv"));
    const legacyHub = join(checkout, "pocket-hf", "hub");
    const { name, data } = modelIn(legacyHub);
    const shared = join(dir, "share", "pocket-venv");
    assert.equal(pickPocketVenv(shared, [legacy]), legacy, "the old one speaks meanwhile");
    const seen = join(dir, "seen");
    const setup = scripts(dir, `cat "$HF_HUB_CACHE/${name}/snapshots/rev1/model.safetensors" > '${seen}'; exit 1\n`);
    const before = readdirSync(checkout).sort();
    assert.equal(startPocketPrep(shared, setup, 1, [legacyHub]), "started");
    await waitFor(() => pocketPrepState(shared) === "failed");
    assert.equal(readFileSync(seen, "utf8"), data, "the model there before setup.sh ran: nothing to download");
    assert.equal(pocketHfEnv(shared).HF_HUB_CACHE, join(dir, "share", "pocket-hf", "hub"));
    assert.equal(readFileSync(join(pocketHfEnv(shared).HF_HUB_CACHE, name, "snapshots", "rev1", "model.safetensors"), "utf8"), data);
    assert.deepEqual(readdirSync(checkout).sort(), before, "nothing written in the old checkout's pocket/");
    assert.equal(readFileSync(join(legacyHub, name, "snapshots", "rev1", "model.safetensors"), "utf8"), data);
  });
});

describe("two starts at once (two checkouts, or Kiko Dev and a test): setup.sh runs once", () => {
  test("four processes starting the same venv's download at the same moment: one started it, the others found it running", { skip }, async () => {
    const dir = tempDir();
    const venv = join(dir, "share", "pocket-venv");
    const ran = join(dir, "ran");
    const script = join(dir, "setup.sh");
    writeFileSync(script, `echo "$$" >> '${ran}'\nsleep 1\nexit 1\n`);
    const go = join(dir, "go");
    const code = `
      import { existsSync, writeFileSync } from "node:fs";
      const { startPocketPrep } = await import(${JSON.stringify(PREP)});
      writeFileSync(process.argv[1] + ".ready", "");
      while (!existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      console.log(startPocketPrep(${JSON.stringify(venv)}, { script: ${JSON.stringify(script)}, serve: "" }, 1, []));
    `;
    const kids = [0, 1, 2, 3].map((i) => {
      const marker = join(dir, `kid-${i}`);
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code, marker], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const done = new Promise<string>((resolve) => child.on("exit", () => resolve(out.trim() || `error: ${err}`)));
      return { marker, done };
    });
    await waitFor(() => kids.every((k) => existsSync(`${k.marker}.ready`)));
    writeFileSync(go, "");
    const said = await Promise.all(kids.map((k) => k.done));
    assert.deepEqual([...said].sort(), ["running", "running", "running", "started"], said.join(" | "));
    await waitFor(() => pocketPrepState(venv) === "failed");
    assert.equal(readFileSync(ran, "utf8").trim().split("\n").length, 1, "setup.sh ran once");
    assert.equal(existsSync(prepFile(venv, "lock")), false, "the lock let go");
  });

  test("the lock: held by a live process, a start waits, then leaves it to that one; one left by a process that's gone is taken over", () => {
    const dir = tempDir();
    const venv = join(dir, "pocket-venv");
    mkdirSync(dir, { recursive: true });
    // This process's own pid stands in for another live one's.
    writeFileSync(prepFile(venv, "lock"), `${process.pid}\n`);
    const started = Date.now();
    assert.equal(prepLock(venv, 100), null);
    assert.ok(Date.now() - started >= 100, "it waited");
    // A pid that's gone: taken over, and let go after.
    writeFileSync(prepFile(venv, "lock"), "999999\n");
    const unlock = prepLock(venv, 100);
    assert.ok(unlock);
    assert.equal(readFileSync(prepFile(venv, "lock"), "utf8").trim(), String(process.pid));
    unlock();
    assert.equal(existsSync(prepFile(venv, "lock")), false);
    // An empty one (its holder died before writing its pid): taken over too.
    writeFileSync(prepFile(venv, "lock"), "");
    const again = prepLock(venv, 100);
    assert.ok(again);
    again();
  });

  test("a start with a stale lock beside the venv (a process that died holding it): started all the same", async () => {
    const dir = tempDir();
    const venv = join(dir, "share", "pocket-venv");
    mkdirSync(dirname(venv), { recursive: true });
    writeFileSync(prepFile(venv, "lock"), "999999\n");
    const script = join(dir, "setup.sh");
    writeFileSync(script, "exit 1\n");
    assert.equal(startPocketPrep(venv, { script, serve: "" }, 1, []), "started");
    await waitFor(() => pocketPrepState(venv) === "failed");
    assert.equal(existsSync(prepFile(venv, "lock")), false);
  });
});
