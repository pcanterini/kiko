// The one-line install, for real (install.sh, scripts/release.sh, src/main.ts, src/uninstall.ts): a
// release built into a folder of this test's own (this Mac's chip only), served from file:// URLs
// (no server), installed into a home folder of this test's own (never the real ~/.local, ~/.config,
// ~/.claude, ~/.zshrc), with a PATH a fresh Mac has (no tmux, no Node, no Homebrew), then run:
// install.sh with no coding agent (no terminal: it says how to get one) and again in a terminal of
// its own (`script`), answering yes to Claude Code's installer (a stand-in); the PATH line it puts in
// ~/.zshrc, once; the installed `kiko` (Bun's executable, no Node); its own tmux running Kiko's
// server (`kiko claude` in a terminal of its own); a hook through it, a second version beside the
// first, a checksum that's wrong, and `kiko uninstall` answered in a terminal of its own, the PATH
// line taken out; and that the executable reads nothing from the folder it's started in. And what
// install.sh refuses, installing nothing: a build of ours relabelled as a newer one, a hook changed
// in it, a helper signed by someone else or as another program, and an ad hoc build without
// KIKO_INSTALL_ADHOC (which this test's own ad hoc build needs; a signed KIKO_TEST_DIST
// installs without it, the way a real release does). Pocket's
// download, started by install.sh, runs a stand-in setup.sh (KIKO_POCKET_SETUP): nothing
// downloads. Needs bun and swiftc: skipped without them (an older Bun than 1.3.3 fails:
// scripts/release.sh says so). A few seconds of building first (a minute or two more the first time,
// building tmux: cached in .cache/). Never the Keychain (KIKO_KEYCHAIN=off), never the running
// app's socket, never your tmux servers (TMUX_TMPDIR). Built signed ad hoc (nothing sent to Apple);
// KIKO_TEST_DIST=<folder> tries a release built before instead, e.g. a signed and notarized one
// (`KIKO_DIST=<folder> KIKO_RELEASES_URL=file://<folder> pnpm release:build`: its URLs there).
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as absolute } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { flavourNames, IDENTIFIER } from "../../../src/core/name.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** The release's helper app, beside kiko in its folder (scripts/build-helper-app.sh). */
const APP = `${flavourNames("release").helperApp}.app`;
const VERSION: string = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const has = (program: string) => spawnSync("/bin/sh", ["-c", `command -v ${program}`]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only" : !has("bun") ? "needs bun" : !has("swiftc") ? "needs swiftc" : false;

const dir = realpathSync(mkdtempSync(join(tmpdir(), "inst-")));
// Where every tmux server here lives (TMUX_TMPDIR), made now: tmux skips a TMUX_TMPDIR that isn't
// there and uses /tmp, where your own `-L kiko` is (a run before this was made killed it).
const servers = join(dir, "t");
mkdirSync(servers);
/** A release built before (KIKO_TEST_DIST), never written to; else this test's own. */
const PREBUILT = process.env.KIKO_TEST_DIST;
const dist = PREBUILT ? absolute(PREBUILT) : join(dir, "dist");
const home = join(dir, "home");
const share = join(home, ".local", "share", "kiko");
const bin = join(home, ".local", "bin", "kiko");
const zshrc = join(home, ".zshrc");
/** A fresh Mac's PATH: no tmux, no Node, no Homebrew, no coding agent. */
const FRESH_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** A stand-in Claude Code, for `kiko claude`: says its TERM and what terminfo makes of it, then echoes. */
const agents = join(dir, "agents");
/**
 * Pocket's setup.sh, a stand-in (KIKO_POCKET_SETUP): writes down the venv it was given and fails,
 * so nothing downloads (the real one fetches about 1 GB).
 */
const fakePocketSetup = join(dir, "pocket-setup.sh");
const pocketRan = join(dir, "pocket-setup-ran");
writeFileSync(fakePocketSetup, `#!/bin/sh\necho "$POCKET_VENV" >> '${pocketRan}'\necho "stand-in: no download in a test"\nexit 1\n`, { mode: 0o755 });
/** What install.sh adds to ~/.zshrc (src/uninstall.ts PATH_MARK). */
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH" # added by the Kiko installer (kiko uninstall removes this line)';
/** Yours, there before: no newline at its end. */
const YOURS = "alias ll='ls -l'";

/** Whether the release tried is signed ad hoc (this test's own build), not with the Developer ID: install.sh then needs KIKO_INSTALL_ADHOC. */
let adHoc = true;

/** The environment an installed copy runs in here: this test's home, zsh, no Keychain, sockets and tmux servers of its own. */
const env = (more: Record<string, string> = {}) => ({
  ...(adHoc ? { KIKO_INSTALL_ADHOC: "1" } : {}),
  PATH: FRESH_PATH,
  HOME: home,
  SHELL: "/bin/zsh",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  TMUX_TMPDIR: servers,
  LANG: "en_US.UTF-8",
  KIKO_HELPER_APP: "off", // never the real helper app (its permissions are the user's)
  KIKO_SPLASH: "off", // the app at once, not after the logo (ui/splash.ts)
  KIKO_KEYCHAIN: "off",
  KIKO_SOCKET: join(dir, "app.sock"),
  KIKO_STATE: join(dir, "state.json"),
  KIKO_POCKET_SETUP: fakePocketSetup,
  ...more,
});

/**
 * `program` with no terminal at all (a session of its own: nothing it asks can reach the terminal
 * the tests run in), its output once it's done.
 */
function alone(program: string, args: string[], more: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: env(more), cwd: dir, detached: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

/** install.sh from `feed` (a folder with latest.json), with no terminal: it asks nothing and never runs setup. */
const install = (feed: string) => alone("/bin/sh", [join(REPO, "install.sh")], { KIKO_RELEASES_URL: `file://${feed}`, KIKO_NO_SETUP: "1" });
const kiko = (...args: string[]) => spawnSync(bin, args, { env: env(), encoding: "utf8", cwd: dir });
/** The installed copy's own tmux, by the `current` link, on Kiko's server (this test's: TMUX_TMPDIR). */
const ownTmux = (...args: string[]) => {
  if (!existsSync(servers)) throw new Error(`no ${servers}: tmux would use your own server in /tmp`);
  return spawnSync(join(share, "current", "bin", "tmux"), ["-L", "kiko", ...args], { env: env(), encoding: "utf8" });
};
/** Whether Kiko's server here is this test's own (its socket in `servers`), checked before anything ends it. */
const ownServer = () => ownTmux("display-message", "-p", "#{socket_path}").stdout.trim().startsWith(`${servers}/`);
/** How many times install.sh's PATH line is in ~/.zshrc. */
const pathLines = () =>
  readFileSync(zshrc, "utf8")
    .split("\n")
    .filter((l) => l === PATH_LINE).length;

/** `command` (sh) in a terminal of its own (`script`), answering each `question` with its answer as it's asked; done once `done` is said. */
function inTerminal(command: string, more: Record<string, string>, answers: [question: string, answer: string][], done: RegExp): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    // script needs a terminal or a real pipe on its input, not Node's socket: cat makes the pipe.
    const child = spawn("/bin/sh", ["-c", 'cat | script -q /dev/null /bin/sh -c "$0"', command], { env: env(more), cwd: dir, detached: true });
    let out = "";
    let asked = 0;
    const timer = setTimeout(() => (child.kill(), reject(new Error(`${command} hung; said: ${out}`))), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      while (asked < answers.length && out.includes(answers[asked][0])) child.stdin.write(`${answers[asked++][1]}\n`);
      // Done: the end of input lets script (and cat) end too.
      if (done.test(out)) child.stdin.end();
    });
    child.on("exit", (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

/** `kiko hook <script>` with `input`, run without blocking (the test's socket server answers meanwhile). */
function hook(script: string, input: string): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["hook", script], { env: env(), cwd: dir });
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("exit", (code) => resolve({ code, err }));
    child.stdin.end(input);
  });
}

let repacks = 0;
/**
 * The release in `dist` repacked as `version` (its folder renamed; the executable still says the
 * real one, so install.sh refuses it unless it's the real one), in a feed folder of its own;
 * `tamper` changes the folder first.
 */
function repack(version: string, opts: { badSha?: boolean; tamper?: (folder: string) => void } = {}): string {
  const feed = join(dir, `feed-${version}-${repacks++}`);
  const work = join(feed, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("tar", ["-xzf", join(dist, `kiko-${VERSION}-darwin-${ARCH}.tar.gz`), "-C", work]);
  execFileSync("mv", [join(work, `kiko-${VERSION}`), join(work, `kiko-${version}`)]);
  opts.tamper?.(join(work, `kiko-${version}`));
  const file = `kiko-${version}-darwin-${ARCH}.tar.gz`;
  execFileSync("tar", ["-C", work, "-czf", join(feed, file), `kiko-${version}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const sha = opts.badSha ? "0".repeat(64) : execFileSync("shasum", ["-a", "256", join(feed, file)], { encoding: "utf8" }).split(" ")[0];
  // A relative url: install.sh takes it from the feed's folder.
  writeFileSync(join(feed, "latest.json"), JSON.stringify({ version, date: "2026-11-01", notes: "test", assets: { [`darwin-${ARCH}`]: { url: file, sha256: sha } } }));
  return feed;
}

/** A release of `version` built here into a feed folder of its own, signed ad hoc, this Mac's chip only (seconds: tmux is cached by the first build). */
function buildVersion(version: string): string {
  const feed = join(dir, `built-${version}`);
  const built = spawnSync("/bin/sh", [join(REPO, "scripts", "release.sh")], {
    env: { ...process.env, KIKO_SIGN_IDENTITY: "-", KIKO_VERSION: version, KIKO_ARCHS: ARCH, KIKO_DIST: feed, KIKO_RELEASES_URL: `file://${feed}`, KIKO_RELEASE_NOTES: "test" },
    encoding: "utf8",
  });
  assert.equal(built.status, 0, built.stderr);
  return feed;
}

/** `kiko uninstall` in a terminal of its own, answering each [y/N] question in turn as it's asked. */
function uninstall(answers: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    // script needs a terminal or a real pipe on its input, not Node's socket: cat makes the pipe.
    const child = spawn("/bin/sh", ["-c", 'cat | script -q /dev/null "$0" uninstall', bin], { env: env(), cwd: dir });
    let out = "";
    let asked = 0;
    const timer = setTimeout(() => (child.kill(), reject(new Error(`uninstall hung; said: ${out}`))), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const questions = out.split("[y/N]").length - 1;
      while (asked < questions) child.stdin.write(`${answers[asked++] ?? "n"}\n`);
      // Done: the end of input lets script (and cat) end too.
      if (/is uninstalled|Nothing changed/.test(out)) child.stdin.end();
    });
    child.on("exit", (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

describe("install.sh, the installed kiko and kiko uninstall", { skip }, () => {
  before(() => {
    if (!PREBUILT) {
      const built = spawnSync("/bin/sh", [join(REPO, "scripts", "release.sh")], {
        env: { ...process.env, KIKO_SIGN_IDENTITY: "-", KIKO_ARCHS: ARCH, KIKO_DIST: dist, KIKO_RELEASES_URL: `file://${dist}`, KIKO_RELEASE_NOTES: "test" },
        encoding: "utf8",
      });
      assert.equal(built.status, 0, built.stderr);
    }
    mkdirSync(join(dir, "unpacked"));
    execFileSync("tar", ["-xzf", join(dist, `kiko-${VERSION}-darwin-${ARCH}.tar.gz`), "-C", join(dir, "unpacked")]);
    const signed = spawnSync("codesign", ["-dvv", join(dir, "unpacked", `kiko-${VERSION}`, "kiko")], { encoding: "utf8" }).stderr;
    adHoc = !signed.includes("Authority=Developer ID Application:");
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the release: latest.json as the contract has it, and a checksum that matches", () => {
    const feed = JSON.parse(readFileSync(join(dist, "latest.json"), "utf8"));
    assert.equal(feed.version, VERSION);
    if (!PREBUILT) assert.equal(feed.notes, "test");
    const asset = feed.assets[`darwin-${ARCH}`];
    assert.equal(asset.url, `file://${dist}/kiko-${VERSION}-darwin-${ARCH}.tar.gz`);
    assert.equal(asset.sha256, execFileSync("shasum", ["-a", "256", join(dist, `kiko-${VERSION}-darwin-${ARCH}.tar.gz`)], { encoding: "utf8" }).split(" ")[0]);
    const listed = execFileSync("tar", ["-tzf", join(dist, `kiko-${VERSION}-darwin-${ARCH}.tar.gz`)], { encoding: "utf8" });
    for (const file of [
      "kiko",
      "native/presence",
      "native/keychain",
      `${APP}/Contents/Info.plist`,
      `${APP}/Contents/MacOS/${flavourNames("release").helperApp}`,
      `${APP}/Contents/Helpers/mic`,
      `${APP}/Contents/Helpers/hotkey`,
      `${APP}/Contents/Helpers/speech`,
      `${APP}/Contents/Helpers/permissions`,
      `${APP}/Contents/Resources/AppIcon.icns`,
      "hooks/claude-code-hook.mjs",
      "hooks/lib.mjs",
      "hooks/guard.mjs",
      "hooks/guard/parse.mjs",
      "statusline/kiko-status.mjs",
      "pocket/setup.sh",
      "tmux/tmux.conf",
      "bin/tmux",
      "terminfo/74/tmux-256color",
      "LICENSE.md",
      "THIRD_PARTY_NOTICES.md",
    ])
      assert.ok(listed.includes(`kiko-${VERSION}/${file}\n`), file);
    // The helpers that need a permission are only in the helper app.
    for (const helper of ["mic", "hotkey", "speech", "permissions"]) assert.ok(!listed.includes(`kiko-${VERSION}/native/${helper}\n`), `native/${helper}`);
  });

  test("every executable in it is signed as sh.kiko.<file> with the hardened runtime; kiko with Bun's JIT allowed, the mic helpers with the mic; a Developer ID one is notarized", () => {
    const root = join(dir, "unpacked", `kiko-${VERSION}`);
    const files = ["kiko", "bin/tmux", ...readdirSync(join(root, "native")).map((name) => `native/${name}`)];
    assert.ok(files.includes("native/keychain") && files.includes("native/presence"), files.join(" "));
    // The helper app: the bundle as sh.kiko.helper, everything in it sealed (--deep), each helper in it as sh.kiko.helper.<helper>.
    const app = join(root, APP);
    const deep = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
    assert.equal(deep.status, 0, `${APP}: ${deep.stderr}`);
    const appSaid = spawnSync("codesign", ["-dvv", app], { encoding: "utf8" }).stderr;
    assert.match(appSaid, new RegExp(`^Identifier=${IDENTIFIER.replaceAll(".", "\\.")}\\.helper$`, "m"));
    assert.match(appSaid, /^CodeDirectory .*flags=0x\w+\([^)]*runtime[^)]*\)/m, `${APP}: the hardened runtime`);
    for (const helper of ["mic", "hotkey", "speech", "permissions"]) {
      const said = spawnSync("codesign", ["-dvv", join(app, "Contents", "Helpers", helper)], { encoding: "utf8" }).stderr;
      assert.match(said, new RegExp(`^Identifier=${IDENTIFIER.replaceAll(".", "\\.")}\\.helper\\.${helper}$`, "m"), helper);
      assert.match(said, /^CodeDirectory .*flags=0x\w+\([^)]*runtime[^)]*\)/m, `${helper}: the hardened runtime`);
    }
    let developerId = 0;
    for (const file of files) {
      const path = join(root, file);
      const verified = spawnSync("codesign", ["--verify", "--strict", path], { encoding: "utf8" });
      assert.equal(verified.status, 0, `${file}: ${verified.stderr}`);
      const said = spawnSync("codesign", ["-dvv", path], { encoding: "utf8" }).stderr;
      assert.match(said, new RegExp(`^Identifier=${IDENTIFIER.replaceAll(".", "\\.")}\\.${file.split("/").pop()}$`, "m"), file);
      assert.match(said, /^CodeDirectory .*flags=0x\w+\([^)]*runtime[^)]*\)/m, `${file}: the hardened runtime`);
      if (said.includes("Authority=Developer ID Application:")) developerId++;
    }
    // A release's (KIKO_TEST_DIST): every file signed with the identity, a ticket for each that
    // Gatekeeper finds online (it can't be stapled to a bare executable), and this Mac's Gatekeeper
    // accepting a quarantined copy of each, assessed, never started (scripts/signing/gatekeeper.ts).
    if (developerId) {
      assert.equal(developerId, files.length, "all signed with the Developer ID identity, or none");
      assert.match(appSaid, /^Authority=Developer ID Application:/m, `${APP}: the Developer ID identity`);
      const notarized = spawnSync("node", [join(REPO, "scripts", "signing", "notarized.ts"), ...files.map((f) => join(root, f)), app], { encoding: "utf8", timeout: 180_000 });
      assert.equal(notarized.status, 0, notarized.stderr);
      const gatekeeper = spawnSync("node", [join(REPO, "scripts", "signing", "gatekeeper.ts"), ...files.map((f) => join(root, f)), app], {
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env, KIKO_GATEKEEPER_TIMEOUT: "120" },
      });
      assert.equal(gatekeeper.status, 0, gatekeeper.stderr);
    }
    const entitled = (file: string) => spawnSync("codesign", ["-d", "--entitlements", "-", "--xml", join(root, file)], { encoding: "utf8" }).stdout;
    assert.match(entitled("kiko"), /<key>com\.apple\.security\.cs\.allow-jit<\/key>/);
    for (const file of [APP, `${APP}/Contents/Helpers/mic`, `${APP}/Contents/Helpers/permissions`]) assert.match(entitled(file), /<key>com\.apple\.security\.device\.audio-input<\/key>/, file);
    // The bundle sends Apple Events as itself (Ghostty, iTerm, Terminal: helper-app.entitlements).
    assert.match(entitled(APP), /<key>com\.apple\.security\.automation\.apple-events<\/key>/);
    assert.doesNotMatch(entitled("native/keychain"), /com\.apple\.security/);
  });

  test("the executable's code has no parameter whose default reads itself (Bun's --compile renaming minified names into one: a TDZ error at run time)", () => {
    const code = readFileSync(join(dir, "unpacked", `kiko-${VERSION}`, "kiko")).toString("latin1");
    const selfDefault = /\(\s*([A-Za-z_$][\w$]*) = \1\s*[,)]/.exec(code);
    assert.equal(selfDefault?.[0] ?? null, null);
  });

  test("the executable reads nothing from the folder it's started in: a bunfig.toml there is ignored (built with --no-compile-autoload-bunfig, and -dotenv beside it)", () => {
    // Bun's executables read a .env and a bunfig.toml from where they're started unless built not
    // to: the installed copy would take a project's keys. Seen through bunfig.toml's preload (this
    // test never makes a .env; scripts/release.sh passes both flags together).
    const project = join(dir, "project");
    mkdirSync(project);
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["./preload.js"]\n');
    writeFileSync(join(project, "preload.js"), 'console.log("PROJECT BUNFIG PRELOADED");\n');
    const run = spawnSync(join(dir, "unpacked", `kiko-${VERSION}`, "kiko"), ["--version"], { env: env(), encoding: "utf8", cwd: project });
    assert.equal(run.stdout.trim(), VERSION, run.stderr);
    assert.ok(!`${run.stdout}${run.stderr}`.includes("PRELOADED"));
    const script = readFileSync(join(REPO, "scripts", "release.sh"), "utf8");
    assert.match(script, /bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig /);
  });

  test("no coding agent and no terminal to ask in: says how to get one before downloading; installs into versions/<version>, links current and ~/.local/bin/kiko, and puts ~/.local/bin on the PATH in ~/.zshrc", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(zshrc, YOURS);
    const run = await install(dist);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!run.stdout.includes("[Y/n]"), "nothing asked with no terminal");
    const said = run.stdout.indexOf("Kiko talks to Claude Code, Codex, OpenCode or T3 Code, and none is installed.");
    assert.ok(said >= 0 && said < run.stdout.indexOf("Downloading"), run.stdout);
    assert.match(run.stdout, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
    assert.equal(readlinkSync(join(share, "current")), `versions/${VERSION}`);
    assert.equal(readlinkSync(bin), join(share, "current", "kiko"));
    assert.match(run.stdout, /Added ~\/\.local\/bin to your PATH in ~\/\.zshrc\./);
    assert.equal(readFileSync(zshrc, "utf8"), `${YOURS}\n${PATH_LINE}\n`);
    assert.match(run.stdout, /Next: .*\/\.local\/bin\/kiko setup/);
    assert.match(run.stdout.trim().split("\n").at(-1)!, /Open a new terminal \(or run: exec \$SHELL\) to use kiko\./);
  });

  test("install.sh starts Pocket's download in the background once the files are in place (a stand-in setup.sh: nothing downloads), writing no settings", async () => {
    const venv = join(share, "pocket-venv");
    for (let i = 0; i < 100 && !(existsSync(pocketRan) && readFileSync(join(share, "pocket-prep.status"), "utf8").trim() === "failed"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(readFileSync(pocketRan, "utf8").split("\n")[0], venv, "setup.sh given the installed copy's venv");
    assert.match(readFileSync(join(share, "pocket-prep.log"), "utf8"), /stand-in: no download in a test/);
    assert.equal(readFileSync(join(share, "pocket-prep.status"), "utf8").trim(), "failed", "the stand-in fails: setup would try again");
    assert.equal(existsSync(join(home, ".config", "kiko", "settings.json")), false, "no settings: the first start still runs setup");
    const logs = join(home, ".local", "state", "kiko", "logs");
    const logged = existsSync(logs)
      ? readdirSync(logs)
          .map((f) => readFileSync(join(logs, f), "utf8"))
          .join("")
      : "";
    assert.match(logged, /"event":"pocket_prep","did":"started","by":"install"/);
  });

  test("asked in a terminal, yes installs Claude Code with its own installer; the PATH line isn't added again", async () => {
    // Claude Code's installer, a stand-in: puts a `claude` in ~/.local/bin, as the real one does.
    const installer = join(dir, "claude-install.sh");
    writeFileSync(
      installer,
      `#!/bin/bash\nmkdir -p "$HOME/.local/bin"\nprintf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/claude"\nchmod +x "$HOME/.local/bin/claude"\necho "STAND-IN INSTALLER RAN"\n`,
    );
    const { code, out } = await inTerminal(
      `sh ${join(REPO, "install.sh")}`,
      { KIKO_RELEASES_URL: `file://${dist}`, KIKO_NO_SETUP: "1", KIKO_CLAUDE_INSTALLER: `file://${installer}` },
      [["Install Claude Code now? [Y/n]", ""]],
      /Open a new terminal/,
    );
    assert.equal(code, 0, out);
    assert.match(out, /STAND-IN INSTALLER RAN/);
    assert.match(out, /Claude Code is installed\./);
    assert.ok(existsSync(join(home, ".local", "bin", "claude")));
    assert.ok(!out.includes("Added ~/.local/bin"), out);
    assert.equal(pathLines(), 1);
  });

  // The way it's really run: `curl … | sh` in a terminal, setup at the end. 2026-11-01: setup ended
  // before its first step, silently (exit 0), because importing pocket-start.ts ran it: in Bun's
  // executable every module's import.meta.filename is argv[1] (tests/unit/cli/entry-guards.test.ts).
  test("curl … | sh in a terminal: installed, then setup opens (Ctrl+C twice stops it) and the script goes on to the end; without a terminal, the same to Next", async () => {
    // A Claude Code (as the test before installs): nothing asked before the download.
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    if (!existsSync(join(home, ".local", "bin", "claude"))) writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const piped = `curl -fsSL file://${join(REPO, "install.sh")} | sh; echo "INSTALL-EXIT $?"`;
    const feed = { KIKO_RELEASES_URL: `file://${dist}` };
    const { code, out } = await inTerminal(piped, feed, [["Kiko setup", "\x03\x03"]], /INSTALL-EXIT \d+/);
    assert.equal(code, 0, out);
    assert.match(out, /Installed Kiko[\s\S]*Kiko setup/, "setup drew its first screen");
    assert.match(out, /Setup stopped\. What was done is kept/, out);
    assert.match(out, /Setup didn't finish: run .*kiko setup any time\.[\s\S]*Open a new terminal[\s\S]*INSTALL-EXIT 0/, out);
    const alonePiped = await alone("/bin/sh", ["-c", piped], { ...feed, KIKO_NO_SETUP: "1" });
    assert.equal(alonePiped.status, 0, alonePiped.stderr);
    assert.match(alonePiped.stdout, /Installed Kiko[\s\S]*Next: .*kiko setup[\s\S]*Open a new terminal[\s\S]*INSTALL-EXIT 0/, alonePiped.stdout);
  });

  test("the installed kiko runs with no Node: --version, keys, and a helper beside it", () => {
    assert.equal(kiko("--version").stdout.trim(), VERSION);
    const keys = kiko("keys");
    assert.equal(keys.status, 0, keys.stderr);
    assert.match(keys.stdout, /openrouter\s+not set/);
    const presence = spawnSync(join(share, "current", "native", "presence"), { encoding: "utf8" });
    assert.equal(presence.status, 0);
    assert.ok("idleMs" in JSON.parse(presence.stdout));
  });

  test("its own tmux: shipped beside it, the one Kiko's server (-L kiko) runs, with tmux-256color found in its panes; no tmux on the PATH", async () => {
    const tmux = join(share, "current", "bin", "tmux");
    accessSync(tmux, constants.X_OK);
    assert.equal(spawnSync("/bin/sh", ["-c", "command -v tmux"], { env: env() }).status, 1, "no tmux on this PATH");
    assert.match(spawnSync(tmux, ["-V"], { encoding: "utf8" }).stdout, /^tmux 3\.\d+/);
    assert.ok(existsSync(join(share, "current", "terminfo", "74", "tmux-256color")));
    // The third-party notices: tmux's libraries, Bun's licence and the bundled packages' (scripts/notices/notices.ts).
    const notices = readFileSync(join(share, "current", "THIRD_PARTY_NOTICES.md"), "utf8");
    assert.match(notices, /==== libevent /);
    assert.match(notices, /\n## Bun\n[\s\S]*JavaScriptCore/);
    for (const name of ["ink", "react", "@clack/prompts", "@noble/ciphers"]) assert.match(notices, new RegExp(`\\n### ${name} \\d`), name);
    // `kiko claude` in a project, in a terminal of its own: the window opens (its app a stand-in) with the session in it.
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "claude"), `#!/bin/sh\nprintf 'STAND-IN CLAUDE TERM=%s colors=%s\\n' "$TERM" "$(tput colors 2>&1)"\nexec cat\n`, { mode: 0o755 });
    mkdirSync(join(dir, "proj"), { recursive: true });
    const child = spawn("/bin/sh", ["-c", `cat | script -q /dev/null '${bin}' claude`], {
      env: env({ PATH: `${agents}:${FRESH_PATH}`, KIKO_WINDOW_APP: "/bin/cat" }),
      cwd: join(dir, "proj"),
      detached: true,
    });
    let said = "";
    child.stdout.on("data", (d: Buffer) => (said += d.toString()));
    try {
      let screens = "";
      for (let i = 0; i < 150 && !screens.includes("STAND-IN CLAUDE"); i++) {
        await new Promise((r) => setTimeout(r, 100));
        const panes = ownTmux("list-panes", "-a", "-F", "#{pane_id}").stdout.split("\n").filter(Boolean);
        screens = panes.map((p) => ownTmux("capture-pane", "-p", "-t", p).stdout).join("\n");
      }
      assert.match(screens, /STAND-IN CLAUDE TERM=tmux-256color colors=256/, `the panes:\n${screens}\nkiko said:\n${said}`);
      assert.ok(ownServer(), "Kiko's server here is this test's own");
      // The server's own executable (ps's command name only, never arguments): the bundled tmux.
      const pid = ownTmux("display-message", "-p", "#{pid}").stdout.trim();
      const comm = execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" }).trim();
      assert.equal(realpathSync(comm), realpathSync(tmux));
      assert.match(ownTmux("show-environment", "-g", "TERMINFO_DIRS").stdout, /current\/terminfo/);
    } finally {
      if (ownServer()) ownTmux("kill-server");
      child.stdin.end();
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // gone already
      }
    }
  });

  test("a hook runs through the installed kiko and reaches the app's socket", async () => {
    const got: string[] = [];
    const server = createServer((c) => c.on("data", (d) => got.push(d.toString())).on("end", () => c.end()));
    await new Promise<void>((r) => server.listen(join(dir, "app.sock"), r));
    try {
      const id = "install-test-hook";
      const ran = await hook(join(share, "current", "hooks", "claude-code-hook.mjs"), JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: dir }));
      assert.equal(ran.code, 0, ran.err);
      assert.ok(got.join("").includes(id));
    } finally {
      server.close();
    }
  });

  test("a wrong checksum installs nothing", async () => {
    const run = await install(repack("9.9.9", { badSha: true }));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /checksum is wrong/);
    assert.equal(existsSync(join(share, "versions", "9.9.9")), false);
    assert.equal(readlinkSync(join(share, "current")), `versions/${VERSION}`);
  });

  /** install.sh refused the feed in `feed`: said why, installed nothing, current still this release. */
  async function refused(feed: string, why: RegExp, more: Record<string, string> = {}) {
    const run = await alone("/bin/sh", [join(REPO, "install.sh")], { KIKO_RELEASES_URL: `file://${feed}`, KIKO_NO_SETUP: "1", ...more });
    assert.notEqual(run.status, 0, run.stdout);
    assert.match(run.stderr, /the download isn't signed by Kiko's developer \(/);
    assert.match(run.stderr, why);
    assert.match(run.stderr, /nothing was installed/);
    assert.equal(existsSync(join(share, "versions", "9.9.9")), false);
    assert.equal(readlinkSync(join(share, "current")), `versions/${VERSION}`);
  }
  /**
   * The helper presence re-signed ad hoc, as `identifier`, without the hardened runtime (so it's
   * never the very bytes an ad hoc build signed it into).
   */
  const resign = (identifier: string) => (folder: string) => execFileSync("codesign", ["--force", "--sign", "-", "--identifier", identifier, join(folder, "native", "presence")], { stdio: "ignore" });

  test("refused, installing nothing: a build of ours relabelled as a newer version (its kiko says which it is)", async () => {
    await refused(repack("9.9.9"), new RegExp(`its kiko is version ${VERSION.replaceAll(".", "\\.")}, not 9\\.9\\.9`));
  });
  test("refused: a hook changed in it (the signed kiko's list of its files)", async () => {
    const tamper = (folder: string) => writeFileSync(join(folder, "hooks", "lib.mjs"), `${readFileSync(join(folder, "hooks", "lib.mjs"), "utf8")}\n// changed\n`);
    await refused(repack("9.9.9", { tamper }), /its files aren't the ones it was built with: hooks\/lib\.mjs isn't the file it was built with/);
  });
  test("refused: a helper in the helper app swapped for another signed one (the bundle's seal)", async () => {
    const tamper = (folder: string) => copyFileSync(join(folder, "native", "presence"), join(folder, APP, "Contents", "Helpers", "mic"));
    await refused(repack("9.9.9", { tamper }), new RegExp(`\\(${APP.replace(".", "\\.")}\\)`));
  });
  test("refused: a helper signed as another program, or by someone else (ad hoc, over a Developer ID release)", async () => {
    await refused(repack("9.9.9", { tamper: resign("sh.kiko.kiko") }), /\(native\/presence\)/);
    // As itself: a Developer ID release refuses its signature; an ad hoc one its changed bytes (its list of files).
    await refused(repack("9.9.9", { tamper: resign("sh.kiko.presence") }), adHoc ? /native\/presence isn't the file it was built with/ : /\(native\/presence\)/);
  });

  let next: string;
  test("refused: a build signed ad hoc, without KIKO_INSTALL_ADHOC (as from a real release)", async () => {
    next = buildVersion("9.9.9");
    await refused(next, /\(kiko\)/, { KIKO_INSTALL_ADHOC: "" });
  });

  test("a new version goes beside the old one; the one after that keeps only it and the one before", async () => {
    // Built here, signed ad hoc: taken with KIKO_INSTALL_ADHOC (over a signed release too).
    const more = { KIKO_RELEASES_URL: `file://${next}`, KIKO_NO_SETUP: "1", KIKO_INSTALL_ADHOC: "1" };
    const first = await alone("/bin/sh", [join(REPO, "install.sh")], more);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readlinkSync(join(share, "current")), "versions/9.9.9");
    assert.equal(readlinkSync(join(share, "previous")), `versions/${VERSION}`);
    assert.ok(existsSync(join(share, "versions", VERSION, "kiko")));
    const third = await alone("/bin/sh", [join(REPO, "install.sh")], { ...more, KIKO_RELEASES_URL: `file://${buildVersion("9.9.10")}` });
    assert.equal(third.status, 0, third.stderr);
    assert.deepEqual(
      execFileSync("ls", [join(share, "versions")], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .sort(),
      ["9.9.10", "9.9.9"],
    );
    assert.equal(kiko("--version").status, 0);
    assert.equal(pathLines(), 1, "the PATH line still once");
  });

  test("kiko uninstall takes it all out, hooks, the PATH line and Pocket's uv, Python and model included, and asks before the logs; your uv and shared model stay", async () => {
    // Claude Code's settings with a hook of the user's and Kiko's (as `kiko setup` writes it).
    const ours = `${join(share, "current", "kiko")} hook ${join(share, "current", "hooks", "claude-code-hook.mjs")}`;
    mkdirSync(join(home, ".claude"), { recursive: true });
    const theirs = { type: "command", command: "echo mine" };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [theirs] }, { hooks: [{ type: "command", command: ours, timeout: 300 }] }] } }));
    mkdirSync(join(home, ".config", "kiko"), { recursive: true });
    writeFileSync(join(home, ".config", "kiko", "settings.json"), "{}");
    mkdirSync(join(home, ".local", "state", "kiko", "logs"), { recursive: true });
    // Pocket as setup.sh and its first start leave it: its venv, the uv it fetched (with uv's Python
    // and cache), its model; all Kiko's.
    for (const path of ["pocket-venv/bin/python", "pocket-uv/bin/uv", "pocket-uv/python/cpython-3.12/bin/python3", "pocket-uv/cache/x", "pocket-hf/hub/models--kyutai--pocket-tts/x"]) {
      mkdirSync(join(share, path, ".."), { recursive: true });
      writeFileSync(join(share, path), "");
    }
    // Yours: a uv on the PATH beside kiko's link, uv's own Python, and Pocket's model from an
    // older install in the Hugging Face cache other apps share. None of it is Kiko's to take.
    const yours = [
      join(home, ".local", "bin", "uv"),
      join(home, ".local", "share", "uv", "python", "cpython-3.12", "bin", "python3"),
      join(home, ".cache", "huggingface", "hub", "models--kyutai--pocket-tts", "x"),
    ];
    for (const path of yours) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }

    const { code, out } = await uninstall(["y", "n"]);
    assert.equal(code, 0, out);
    assert.match(out, /~\/\.local\/share\/kiko \(with the Pocket voice's Python, uv and model\)/);
    assert.match(out, /Pocket's voice model in ~\/\.cache\/huggingface\/hub \(Hugging Face's cache, shared with other apps; an older install or another app put it there\)/);
    for (const path of yours) assert.ok(existsSync(path), `${path} is yours: left`);
    assert.match(out, /Delete the logs too/);
    assert.equal(existsSync(share), false);
    assert.equal(existsSync(bin), false);
    assert.equal(existsSync(join(home, ".config", "kiko")), false);
    assert.equal(existsSync(join(home, ".local", "state", "kiko")), true, "the logs stay when you say no");
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")), { hooks: { Stop: [{ hooks: [theirs] }] } });
    assert.match(out, /the PATH line it added to ~\/\.zshrc/);
    assert.equal(readFileSync(zshrc, "utf8"), `${YOURS}\n`, "only the PATH line went");
  });
});
