// What keeps a fake build out (src/core/updates/verify.ts verifyRelease, trustOf, install's no-downgrade
// rule; src/core/release-files.ts; install.sh's copy of the requirement): who an update must be
// signed by, and that nothing at run time can loosen it in a release; never a version lower than
// or the same as the one running or installed; executables signed ad hoc, or as another file,
// refused by a release; a refused download leaving nothing behind and the header saying so, once
// per file; the signed executable's list of the files beside it. Last, a real signed and notarized
// build (KIKO_TEST_SIGNED_DIST, else /tmp/kiko-signed-dist) accepted, when there's one.
// All in throwaway folders: never the real ~/.local.
import "../../setup.ts";
import { styleOf } from "../../../src/ui/cli-style.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import { IDENTIFIER, TEAM } from "../../../src/core/name.ts";
import { checkBundle, checkFiles, listFiles, RELEASE } from "../../../src/core/release-files.ts";
import type { Release } from "../../../src/core/updates/feed.ts";
import { copyOf, currentVersion, DowngradeError, install, type Layout, layoutOf, switchTo, versionDir } from "../../../src/core/updates/layout.ts";
import { loadState, Updater, type UpdateView, updateWords, viewOf } from "../../../src/core/updates/updater.ts";
import { requirement, SignatureError, trustOf, type Verify, verifyRelease, verifySignatures } from "../../../src/core/updates/verify.ts";
import { updateCommand } from "../../../src/update-cli.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "cbv-"));
after(() => rmSync(root, { recursive: true, force: true }));
const PLATFORM = "darwin-arm64";
const mac = process.platform === "darwin" && existsSync("/usr/bin/codesign");
const unchecked: Verify = async () => {};

let n = 0;
const fresh = (name: string) => {
  const dir = join(root, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** An install of `v` (a shell script that says its version) in a fresh home. */
function installedHome(v: string): { l: Layout; dir: string; releases: string } {
  const h = fresh("home");
  const l = layoutOf(h);
  const dir = versionDir(l, v);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kiko"), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
  switchTo(l, v);
  const releases = join(h, "releases");
  mkdirSync(releases);
  return { l, dir, releases };
}

/** A release folder as release.sh lays it out (kiko, native/<helpers>, bin/tmux), each a copy of `exe` signed ad hoc as sh.kiko.<file> (`as` changes one's). */
function adHocFolder(dir: string, exe: string, as: Record<string, string> = {}) {
  mkdirSync(join(dir, "native"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const file of ["kiko", "native/presence", "native/mic", "bin/tmux"]) {
    copyFileSync(exe, join(dir, file));
    chmodSync(join(dir, file), 0o755);
    const name = file.split("/").pop()!;
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", as[file] ?? `${IDENTIFIER}.${name}`, join(dir, file)], { stdio: "ignore" });
  }
}

/** A tarball of `folder` as kiko-<v>/, with a feed for it in `releases`. */
function feedOf(releases: string, folder: string, v: string): { url: string; release: Release } {
  const work = fresh("tar");
  execFileSync("cp", ["-R", folder, join(work, `kiko-${v}`)]);
  const path = join(releases, `kiko-${v}-${PLATFORM}.tar.gz`);
  execFileSync("tar", ["-czf", path, "-C", work, `kiko-${v}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const release: Release = { version: v, assets: { [PLATFORM]: { url: pathToFileURL(path).href, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") } } };
  writeFileSync(join(releases, "latest.json"), JSON.stringify(release));
  return { url: pathToFileURL(join(releases, "latest.json")).href, release };
}

/** A tiny executable that prints `v` (needs cc: Xcode or its Command Line Tools); null without one. */
function printer(v: string): string | null {
  if (spawnSync("/bin/sh", ["-c", "command -v cc"]).status !== 0) return null;
  const out = join(fresh("cc"), "says");
  const made = spawnSync("cc", ["-x", "c", "-", "-o", out], { input: `#include <stdio.h>\nint main(void) { puts("${v}"); return 0; }\n` });
  return made.status === 0 ? out : null;
}

describe("who an update must be signed by", () => {
  test("a release build: our team, unless it was built ad hoc; nothing at run time changes that", () => {
    assert.deepEqual(trustOf(true, null, undefined), { team: TEAM });
    assert.deepEqual(trustOf(true, { adHoc: false }, undefined), { team: TEAM });
    for (const asked of ["off", "adhoc", "OFF"]) assert.deepEqual(trustOf(true, { adHoc: false }, asked), { team: TEAM }, asked);
    assert.deepEqual(trustOf(true, { adHoc: true }, undefined), { adHoc: true });
    assert.deepEqual(trustOf(true, { adHoc: true }, "off"), { adHoc: true }, "an ad hoc build still checks the identifiers and files");
  });
  test("a checkout: as strict as a release, unless KIKO_UPDATE_SIGNATURES says otherwise (its own source, the tests' fake installs)", () => {
    assert.deepEqual(trustOf(false, null, undefined), { team: TEAM });
    assert.deepEqual(trustOf(false, null, "yes"), { team: TEAM });
    assert.deepEqual(trustOf(false, null, "adhoc"), { adHoc: true });
    assert.deepEqual(trustOf(false, null, "off"), { off: true });
  });
  test("a checkout has nothing baked in", () => assert.equal(RELEASE, null));
  test("the requirement: Apple's anchor, a Developer ID Application certificate of our team, the file's identifier; ad hoc only the identifier", () => {
    assert.equal(
      requirement("mic", { team: "YU89X2P36Z" }),
      'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "YU89X2P36Z" and identifier "sh.kiko.mic"',
    );
    assert.equal(requirement("tmux", { adHoc: true }), 'identifier "sh.kiko.tmux"');
    assert.equal(TEAM, "YU89X2P36Z");
  });
  test("install.sh checks the same requirement, with the same team and identifier", () => {
    const script = readFileSync(join(REPO, "install.sh"), "utf8");
    assert.ok(script.includes(`\nTEAM=${TEAM}\n`), "TEAM");
    assert.ok(script.includes(`\nIDS=${IDENTIFIER}\n`), "IDS");
    const team = spawnSync("/bin/sh", ["-c", `TEAM=${TEAM}; IDS=${IDENTIFIER}; ${/requirement\(\) \{[\s\S]*?\n\}/.exec(script)![0]}; requirement mic`], { encoding: "utf8" });
    assert.equal(team.stdout, requirement("mic", { team: TEAM }));
    const adHoc = spawnSync("/bin/sh", ["-c", `KIKO_INSTALL_ADHOC=1; TEAM=${TEAM}; IDS=${IDENTIFIER}; ${/requirement\(\) \{[\s\S]*?\n\}/.exec(script)![0]}; requirement mic`], { encoding: "utf8" });
    assert.equal(adHoc.stdout, requirement("mic", { adHoc: true }));
  });
});

describe("only forward", () => {
  test("install: a version lower than or the same as the one running, or the one installed, is refused; nothing changes", async () => {
    const { l, releases } = installedHome("0.2.0");
    const offer = (v: string) => {
      const dir = fresh("rel");
      writeFileSync(join(dir, "kiko"), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
      return feedOf(releases, dir, v).release;
    };
    await assert.rejects(install(l, offer("0.1.9"), { running: "0.2.0", platform: PLATFORM, verify: unchecked }), DowngradeError);
    await assert.rejects(install(l, offer("0.2.0"), { running: "0.2.0", platform: PLATFORM, verify: unchecked }), DowngradeError);
    await assert.rejects(install(l, offer("0.2.0-beta.1"), { running: "0.1.0", platform: PLATFORM, verify: unchecked }), /isn't newer than 0\.2\.0/, "lower than the one installed");
    assert.equal(currentVersion(l), "0.2.0");
    assert.deepEqual(readdirSync(join(l.share, "versions")), ["0.2.0"]);
  });
  test("the app's updater: a feed with an older version installs nothing, quietly, and logs it", async () => {
    const { l, dir, releases } = installedHome("0.2.0");
    const old = fresh("rel");
    writeFileSync(join(old, "kiko"), "#!/bin/sh\necho 0.1.0\n", { mode: 0o755 });
    const f = feedOf(releases, old, "0.1.0");
    const events: string[] = [];
    const views: UpdateView[] = [];
    const updater = new Updater({
      copy: copyOf(dir, "", l),
      auto: () => true,
      changed: (v) => views.push(v),
      log: (e) => events.push(e),
      url: f.url,
      platform: PLATFORM,
      mode: "on",
      verify: unchecked,
    });
    assert.equal(await updater.check(true), "newest");
    assert.equal(currentVersion(l), "0.2.0");
    assert.ok(events.includes("update_downgrade_refused"));
    assert.equal(updateWords(views.at(-1)!), null, "nothing in the header");
  });
  test("kiko update: an older feed is not installed", async () => {
    const { l, dir, releases } = installedHome("0.2.0");
    const old = fresh("rel");
    writeFileSync(join(old, "kiko"), "#!/bin/sh\necho 0.1.0\n", { mode: 0o755 });
    const out: string[] = [];
    const code = await updateCommand([], {
      copy: copyOf(dir, "", l),
      url: feedOf(releases, old, "0.1.0").url,
      appRunning: async () => false,
      out: (s) => out.push(s),
      progress: null,
      platform: PLATFORM,
      verify: unchecked,
    });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /0\.2\.0 is the newest/);
    assert.equal(out.at(-1), "✓ Kiko 0.2.0 is the newest.");
    assert.equal(currentVersion(l), "0.2.0");
    // In colour (a terminal): the ✓ green, the version bold, the feed's address dim.
    const colored: string[] = [];
    await updateCommand([], {
      copy: copyOf(dir, "", l),
      url: feedOf(releases, old, "0.1.0").url,
      appRunning: async () => false,
      out: (s) => colored.push(s),
      progress: null,
      platform: PLATFORM,
      verify: unchecked,
      style: styleOf(true),
    });
    assert.match(colored[0], /^Looking for a new version \x1b\[2m\(.*\)\x1b\[22m…$/);
    assert.equal(colored.at(-1), "\x1b[32m✓\x1b[39m Kiko \x1b[1m0.2.0\x1b[22m is the newest.");
  });
});

describe("the signed executable's list of the files beside it", () => {
  function folder() {
    const dir = fresh("files");
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "kiko"), "the executable");
    writeFileSync(join(dir, "hooks", "lib.mjs"), "export {};\n");
    writeFileSync(join(dir, "LICENSE.md"), "FSL\n");
    return dir;
  }
  test("every file but the executable, by its path, with its SHA-256; the same folder checks out", () => {
    const dir = folder();
    const files = listFiles(dir);
    assert.deepEqual(Object.keys(files), ["LICENSE.md", "hooks/lib.mjs"]);
    assert.equal(files["hooks/lib.mjs"], createHash("sha256").update("export {};\n").digest("hex"));
    assert.equal(checkFiles(dir, files), null);
  });
  test("a file changed, one added, one missing, a link: each refused, saying which", () => {
    const dir = folder();
    const files = listFiles(dir);
    writeFileSync(join(dir, "hooks", "lib.mjs"), "steal();\n");
    assert.equal(checkFiles(dir, files), "hooks/lib.mjs isn't the file it was built with");
    writeFileSync(join(dir, "hooks", "lib.mjs"), "export {};\n");
    writeFileSync(join(dir, "hooks", "extra.mjs"), "");
    assert.equal(checkFiles(dir, files), "hooks/extra.mjs isn't one of the files it was built with");
    rmSync(join(dir, "hooks", "extra.mjs"));
    rmSync(join(dir, "LICENSE.md"));
    assert.equal(checkFiles(dir, files), "LICENSE.md is missing");
    symlinkSync("/etc/hosts", join(dir, "LICENSE.md"));
    assert.match(checkFiles(dir, files) ?? "", /LICENSE\.md is a link/);
  });
});

describe("the helper app in a release: checked as a whole, by its own signature", { skip: mac ? false : "needs macOS's codesign" }, () => {
  /** A minimal app bundle (/usr/bin/true as its executable) signed ad hoc as `id`. */
  function bundle(dir: string, id = `${IDENTIFIER}.helper`): string {
    const app = join(dir, "Kiko.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Kiko</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "Kiko"));
    copyFileSync("/usr/bin/true", join(app, "Contents", "Helpers", "mic"));
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", `${id}.mic`, join(app, "Contents", "Helpers", "mic")], { stdio: "ignore" });
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
    return app;
  }

  test("left out of the executable's list (its insides are its signature's to vouch for), and anything else still in it", () => {
    const dir = fresh("with-app");
    writeFileSync(join(dir, "kiko"), "the executable");
    writeFileSync(join(dir, "LICENSE.md"), "FSL\n");
    bundle(dir);
    assert.deepEqual(Object.keys(listFiles(dir, "Kiko.app")), ["LICENSE.md"]);
    const files = listFiles(dir, "Kiko.app");
    assert.equal(checkFiles(dir, files, "Kiko.app"), null);
    // Without being told it's the app, its files are files like any other: one more there is refused.
    assert.match(checkFiles(dir, files) ?? "", /^Kiko\.app\/Contents\/.* isn't one of the files it was built with$/);
  });

  test("its signature against the requirement baked in: passes; another id, a changed helper inside, or none: refused, saying which", () => {
    const dir = fresh("app-sig");
    bundle(dir);
    const ours = { path: "Kiko.app", requirement: `identifier "${IDENTIFIER}.helper"` };
    assert.equal(checkBundle(dir, ours), null);
    assert.match(checkBundle(dir, { ...ours, requirement: `identifier "${IDENTIFIER}.other"` }) ?? "", /^Kiko\.app isn't signed as it was built/);
    writeFileSync(join(dir, "Kiko.app", "Contents", "Helpers", "mic"), "steal();\n");
    assert.match(checkBundle(dir, ours) ?? "", /^Kiko\.app isn't signed as it was built/);
    rmSync(join(dir, "Kiko.app"), { recursive: true });
    assert.equal(checkBundle(dir, ours), "Kiko.app is missing");
  });

  test("updates check it as IDENTIFIER.helper, everything in it sealed: another id refused, naming it", async () => {
    const dir = fresh("app-update");
    adHocFolder(dir, "/usr/bin/true");
    bundle(dir);
    await verifySignatures(dir, { adHoc: true });
    rmSync(join(dir, "Kiko.app"), { recursive: true });
    bundle(dir, `${IDENTIFIER}.someone`);
    await assert.rejects(verifySignatures(dir, { adHoc: true }), (err: Error) => err instanceof SignatureError && /^Kiko\.app isn't signed by Kiko's developer/.test(err.message));
  });

  test("install.sh checks it as helper, with --deep", () => {
    const script = readFileSync(join(REPO, "install.sh"), "utf8");
    assert.match(script, /codesign --verify --deep --strict "-R=\$\(requirement helper\)" "\$app"/);
  });
});

describe("verifyRelease", { skip: mac ? false : "needs macOS's codesign" }, () => {
  test("a release refuses executables signed ad hoc, saying which", async () => {
    const dir = fresh("adhoc");
    adHocFolder(dir, "/usr/bin/true");
    await assert.rejects(verifyRelease(dir, "0.1.1", { team: TEAM }), (err: Error) => err instanceof SignatureError && /^kiko isn't signed by Kiko's developer/.test(err.message));
  });
  test("another identifier (one helper signed as some other program) is refused, even ad hoc", async () => {
    const dir = fresh("wrong-id");
    adHocFolder(dir, "/usr/bin/true", { "native/presence": `${IDENTIFIER}.kiko` });
    await assert.rejects(verifySignatures(dir, { adHoc: true }), (err: Error) => err instanceof SignatureError && /^native\/presence isn't signed/.test(err.message));
  });
  test("a link, a missing tmux, or a helper whose name could change the requirement: refused", async () => {
    const dir = fresh("odd");
    adHocFolder(dir, "/usr/bin/true");
    rmSync(join(dir, "bin", "tmux"));
    await assert.rejects(verifySignatures(dir, { adHoc: true }), /no bin\/tmux/);
    symlinkSync("/usr/bin/true", join(dir, "bin", "tmux"));
    await assert.rejects(verifySignatures(dir, { adHoc: true }), /bin\/tmux in the download isn't a plain file/);
    rmSync(join(dir, "bin", "tmux"));
    copyFileSync(join(dir, "native", "mic"), join(dir, "bin", "tmux"));
    writeFileSync(join(dir, "native", 'x" or identifier "y'), "");
    await assert.rejects(verifySignatures(dir, { adHoc: true }), /a file named/);
  });
  test("signed right, but its executable doesn't vouch for the version the feed says: refused (an old build relabelled)", async () => {
    const dir = fresh("relabelled");
    adHocFolder(dir, "/usr/bin/true");
    await assert.rejects(verifyRelease(dir, "0.1.1", { adHoc: true }), /its kiko is version \(none\), not 0\.1\.1/);
    const says = printer("0.1.0");
    if (!says) return; // no cc: the rest is install-live's and the e2e's, on real builds
    const other = fresh("relabelled");
    adHocFolder(other, says);
    await assert.rejects(verifyRelease(other, "0.1.1", { adHoc: true }), /its kiko is version 0\.1\.0, not 0\.1\.1/);
    await verifyRelease(other, "0.1.0", { adHoc: true });
  });

  test("an update signed ad hoc, offered to a release: refused, nothing kept, the header says so; the same file isn't fetched again", async () => {
    const { l, dir, releases } = installedHome("0.1.0");
    const built = fresh("adhoc");
    adHocFolder(built, "/usr/bin/true");
    const f = feedOf(releases, built, "0.1.1");
    let checked = 0;
    const strict: Verify = (folder, version) => (checked++, verifyRelease(folder, version, { team: TEAM }));
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const views: UpdateView[] = [];
    const updater = new Updater({
      copy: copyOf(dir, "", l),
      auto: () => true,
      changed: (v) => views.push(v),
      log: (e, fields) => events.push([e, fields]),
      url: f.url,
      platform: PLATFORM,
      mode: "on",
      verify: strict,
    });
    assert.equal(await updater.check(), "refused");
    assert.equal(currentVersion(l), "0.1.0");
    assert.deepEqual(readdirSync(join(l.share, "versions")), ["0.1.0"], "no folder of it, no unpack folder, no tarball");
    const rejected = events.find(([e]) => e === "update_rejected");
    assert.ok(rejected, JSON.stringify(events));
    assert.match(String(rejected[1]?.why), /kiko isn't signed by Kiko's developer/);
    assert.equal(updateWords(views.at(-1)!), "Update 0.1.1 refused: not signed by Kiko's developer");
    assert.deepEqual(loadState(l).refused, { version: "0.1.1", sha256: f.release.assets[PLATFORM].sha256 });
    // Again: not downloaded nor checked again.
    assert.equal(await updater.check(), "refused");
    assert.equal(checked, 1);
    assert.equal(events.filter(([e]) => e === "update_rejected").length, 1, "said once");
    // kiko update by hand tries it, and says why.
    const out: string[] = [];
    const code = await updateCommand([], { copy: copyOf(dir, "", l), url: f.url, appRunning: async () => false, out: (s) => out.push(s), progress: null, platform: PLATFORM, verify: strict });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /Kiko 0\.1\.1 was refused, as it isn't signed by Kiko's developer: kiko isn't signed by Kiko's developer .*Nothing was installed\./);
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(updateWords(viewOf(copyOf(dir, "", l), loadState(l), true)), "Update 0.1.1 refused: not signed by Kiko's developer");
  });
  test("one unpacked already that fails its check (kiko update after a rollback): taken out, not switched to", async () => {
    const { l, releases } = installedHome("0.1.0");
    const there = versionDir(l, "0.1.1");
    adHocFolder(there, "/usr/bin/true");
    const f = feedOf(releases, there, "0.1.1");
    await assert.rejects(install(l, f.release, { running: "0.1.0", platform: PLATFORM, verify: (d, v) => verifyRelease(d, v, { team: TEAM }) }), SignatureError);
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(existsSync(there), false);
  });
});

// The real thing: a release signed with the Developer ID and notarized (scripts/release.sh), when
// one is on this Mac. Skipped, saying so, without one.
const SIGNED = process.env.KIKO_TEST_SIGNED_DIST ?? "/tmp/kiko-signed-dist";
const signedTarball = existsSync(SIGNED) ? readdirSync(SIGNED).find((f) => f.endsWith(`-${process.arch === "arm64" ? "darwin-arm64" : "darwin-x64"}.tar.gz`)) : undefined;
const signedSkip = !mac ? "needs macOS's codesign" : !signedTarball ? `no signed build in ${SIGNED} (KIKO_TEST_SIGNED_DIST=<a pnpm release:build dist/>)` : false;

describe("a real signed build", { skip: signedSkip }, () => {
  const unpacked = () => {
    const dir = fresh("signed");
    execFileSync("tar", ["-xzf", join(SIGNED, signedTarball!), "-C", dir]);
    const [folder] = readdirSync(dir);
    return { folder: join(dir, folder), version: folder.replace(/^kiko-/, "") };
  };
  test("its executables meet the release's requirement; another team's doesn't", async () => {
    const { folder } = unpacked();
    await verifySignatures(folder, { team: TEAM });
    await assert.rejects(verifySignatures(folder, { team: "ABCDE12345" }), SignatureError);
  });
  test("its files and version vouched for by its executable; a hook changed in it is refused", async (t) => {
    const { folder, version } = unpacked();
    const answered = spawnSync(join(folder, "kiko"), ["_verify-files"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    if (answered.stdout.trim() !== version) {
      t.skip(`${SIGNED} was built before its executable listed its files (_verify-files): build one again to check this`);
      return;
    }
    await verifyRelease(folder, version, { team: TEAM });
    writeFileSync(join(folder, "hooks", "lib.mjs"), `${readFileSync(join(folder, "hooks", "lib.mjs"), "utf8")}\n// changed\n`);
    await assert.rejects(verifyRelease(folder, version, { team: TEAM }), /hooks\/lib\.mjs isn't the file it was built with/);
  });
});
