// Updates (src/core/updates/, src/update-cli.ts): the feed read, once a day, a download whose
// sha256 isn't the feed's refused, the links switched atomically, rollback, old versions pruned,
// the app's updater (background install, automatic updates off, offline), what the header says,
// and the relaunch after Restart now. All in a throwaway HOME with file:// feeds: nothing reaches
// the network or the real ~/.local. Last, `kiko update` run for real against a fake install.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, test } from "node:test";
import { ChecksumError, compareVersions, DAY_MS, fetchRelease, parseRelease, type Release, RETRY_MS } from "../../../src/core/updates/feed.ts";
import {
  BusyError,
  copyOf,
  currentVersion,
  install,
  installedAs,
  type Layout,
  layoutOf,
  previousVersion,
  prune,
  relaunchCommand,
  rollback,
  switchTo,
  versionDir,
  versionsInstalled,
  withLock,
} from "../../../src/core/updates/layout.ts";
import { due, loadState, saveState, Updater, updatesMode, type UpdateView, updateWords, viewOf } from "../../../src/core/updates/updater.ts";
import type { Verify } from "../../../src/core/updates/verify.ts";
import { updateCommand } from "../../../src/update-cli.ts";
import { parseCli, USAGE, version } from "../../../src/cli-args.ts";
import React from "react";
import { Box, renderToString } from "ink";
import { ui, type UiState } from "../../../src/core/ui-store.ts";
import { SETTING_ABOUT, SETTING_GROUPS, updateChoices } from "../../../src/core/settings-options.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { barText } from "../../../src/ui/bar.ts";
import { frameLines, headerRight } from "../../../src/ui/classic.ts";

const root = mkdtempSync(join(tmpdir(), "cbu-"));
after(() => rmSync(root, { recursive: true, force: true }));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PLATFORM = "darwin-arm64";

let n = 0;
/** A fresh home folder, its layout, and a folder for releases. */
function home(): { home: string; l: Layout; releases: string } {
  const h = join(root, `home-${n++}`);
  mkdirSync(h, { recursive: true });
  const releases = join(h, "releases");
  mkdirSync(releases);
  return { home: h, l: layoutOf(h), releases };
}

/** A release's tarball as the packaging makes it: kiko-<version>/kiko, which prints its version. */
function tarball(dir: string, v: string, o: { exe?: boolean; folder?: string } = {}): { path: string; sha256: string } {
  const work = mkdtempSync(join(root, "tar-"));
  const folder = join(work, o.folder ?? `kiko-${v}`);
  mkdirSync(folder);
  writeFileSync(join(folder, "kiko"), `#!/bin/sh\necho ${v}\n`);
  chmodSync(join(folder, "kiko"), o.exe === false ? 0o644 : 0o755);
  writeFileSync(join(folder, "README"), "a helper beside it\n");
  const path = join(dir, `kiko-${v}-${PLATFORM}.tar.gz`);
  execFileSync("tar", ["-czf", path, "-C", work, o.folder ?? `kiko-${v}`]);
  rmSync(work, { recursive: true, force: true });
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

/** A feed offering `v`, its latest.json in `dir`; returns its URL (the folder, as KIKO_RELEASES_URL) and the release. */
function feed(dir: string, v: string, o: { sha256?: string; notes?: string; exe?: boolean; folder?: string } = {}): { url: string; base: string; release: Release } {
  const t = tarball(dir, v, o);
  const release: Release = { version: v, date: "2026-11-01", notes: o.notes ?? `Kiko ${v}: better.`, assets: { [PLATFORM]: { url: pathToFileURL(t.path).href, sha256: o.sha256 ?? t.sha256 } } };
  writeFileSync(join(dir, "latest.json"), JSON.stringify(release));
  return { url: pathToFileURL(join(dir, "latest.json")).href, base: pathToFileURL(dir).href, release };
}

/** An install as the install script leaves it: `v` unpacked, current and ~/.local/bin/kiko pointing at it. */
function installed(l: Layout, v: string) {
  const dir = versionDir(l, v);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kiko"), `#!/bin/sh\necho ${v}\n`);
  chmodSync(join(dir, "kiko"), 0o755);
  switchTo(l, v);
  return dir;
}

const runs = (path: string) => execFileSync(path, { encoding: "utf8" }).trim();
/** The fake versions here are shell scripts, unsigned: their signatures go unchecked (verifyRelease has its own tests). */
const unchecked: Verify = async () => {};

describe("the feed", () => {
  test("read: version, date, notes and each Mac's asset; sha256 lower-cased", () => {
    const r = parseRelease({ version: "0.1.1", date: "2026-11-01", notes: "Faster.", assets: { "darwin-arm64": { url: "https://kiko.sh/releases/x.tar.gz", sha256: "A".repeat(64) } } });
    assert.deepEqual(r, { version: "0.1.1", date: "2026-11-01", notes: "Faster.", assets: { "darwin-arm64": { url: "https://kiko.sh/releases/x.tar.gz", sha256: "a".repeat(64) } } });
  });
  test("not one: no version, a version that could be a path, no assets", () => {
    for (const raw of [null, [], {}, { version: "1.2" }, { version: "../../evil", assets: {} }, { version: "1.2.3/x", assets: {} }, { version: "0.1.1" }, { version: "0.1.1", assets: [] }]) {
      assert.equal(parseRelease(raw), null, JSON.stringify(raw));
    }
  });
  test("an asset without a sha256, or over plain http, is left out", () => {
    const r = parseRelease({
      version: "0.1.1",
      assets: { a: { url: "http://kiko.sh/x", sha256: "a".repeat(64) }, b: { url: "https://kiko.sh/x", sha256: "short" }, c: { url: "file:///tmp/x", sha256: "b".repeat(64) } },
    });
    assert.deepEqual(Object.keys(r!.assets), ["c"]);
  });
  test("notes come as one plain line: no escape sequences, cut when long", () => {
    const r = parseRelease({ version: "0.1.1", notes: "Line one\n\x1b[31mred\x1b[0m\tdone", assets: {} });
    assert.equal(r!.notes, "Line one [31mred [0m done");
    assert.ok(parseRelease({ version: "0.1.1", notes: "x".repeat(1000), assets: {} })!.notes!.length <= 400);
  });
  test("versions compared as numbers, a pre-release before its release", () => {
    assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
    assert.ok(compareVersions("0.2.0", "0.10.0") < 0);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.ok(compareVersions("1.0.0-beta.2", "1.0.0") < 0);
    assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  });
  test("read from a file:// URL; one that isn't a feed throws", async () => {
    const { releases } = home();
    const f = feed(releases, "0.1.1");
    assert.equal((await fetchRelease(f.url)).version, "0.1.1");
    writeFileSync(join(releases, "bad.json"), "<html>");
    await assert.rejects(fetchRelease(pathToFileURL(join(releases, "bad.json")).href), /isn't JSON/);
    await assert.rejects(fetchRelease(pathToFileURL(join(releases, "none.json")).href));
  });
  test("KIKO_UPDATES: off and force; anything else on", () => {
    assert.equal(updatesMode("off"), "off");
    assert.equal(updatesMode("0"), "off");
    assert.equal(updatesMode("force"), "force");
    assert.equal(updatesMode(undefined), "on");
    assert.equal(updatesMode("yes"), "on");
  });
});

describe("once a day", () => {
  const now = Date.UTC(2026, 10, 1, 12);
  test("never looked: due", () => assert.equal(due({}, now), true));
  test("looked an hour ago: not due; a day ago: due", () => {
    assert.equal(due({ checkedAt: now - 3600_000 }, now), false);
    assert.equal(due({ checkedAt: now - DAY_MS }, now), true);
  });
  test("a look that failed (offline) waits an hour, quietly, even when a day has gone by", () => {
    assert.equal(due({ checkedAt: now - 2 * DAY_MS, failedAt: now - 60_000 }, now), false);
    assert.equal(due({ checkedAt: now - 2 * DAY_MS, failedAt: now - RETRY_MS }, now), true);
  });
  test("a clock set back: looked again rather than never", () => assert.equal(due({ checkedAt: now + DAY_MS }, now), true));
});

describe("installing", () => {
  test("downloaded, checked, unpacked beside the old one, switched to; the old one kept as previous", async () => {
    const { l, releases } = home();
    installed(l, "0.1.0");
    const f = feed(releases, "0.1.1");
    const seen: number[] = [];
    await install(l, f.release, { platform: PLATFORM, verify: unchecked, progress: (done) => seen.push(done) });
    assert.equal(currentVersion(l), "0.1.1");
    assert.equal(previousVersion(l), "0.1.0");
    assert.deepEqual(versionsInstalled(l), ["0.1.0", "0.1.1"]);
    assert.equal(runs(l.bin), "0.1.1", "~/.local/bin/kiko starts the new one");
    assert.ok(existsSync(join(versionDir(l, "0.1.1"), "README")), "what's beside the executable came too");
    assert.ok(seen.length > 0, "progress said");
    // Nothing left over beside them: no temp links, no unpack folders, no tarball.
    assert.deepEqual(readdirSync(l.share).sort(), ["current", "previous", "versions"]);
    assert.deepEqual(readdirSync(join(l.share, "versions")).sort(), ["0.1.0", "0.1.1"]);
  });
  test("a download whose sha256 isn't the feed's: refused, nothing kept, still on the old one", async () => {
    const { l, releases } = home();
    installed(l, "0.1.0");
    const f = feed(releases, "0.1.1", { sha256: "0".repeat(64) });
    await assert.rejects(install(l, f.release, { platform: PLATFORM, verify: unchecked }), ChecksumError);
    assert.equal(currentVersion(l), "0.1.0");
    assert.deepEqual(readdirSync(join(l.share, "versions")), ["0.1.0"]);
    assert.equal(runs(l.bin), "0.1.0");
  });
  test("a tarball without kiko-<version>/kiko, or with it not executable: refused", async () => {
    const { l, releases } = home();
    installed(l, "0.1.0");
    await assert.rejects(install(l, feed(releases, "0.1.1", { folder: "something-else" }).release, { platform: PLATFORM, verify: unchecked }), /has no kiko-0\.1\.1\/kiko/);
    await assert.rejects(install(l, feed(releases, "0.1.2", { exe: false }).release, { platform: PLATFORM, verify: unchecked }), /isn't executable/);
    assert.equal(currentVersion(l), "0.1.0");
    assert.deepEqual(readdirSync(join(l.share, "versions")), ["0.1.0"]);
  });
  test("no asset for this Mac: says so, changes nothing", async () => {
    const { l, releases } = home();
    installed(l, "0.1.0");
    await assert.rejects(install(l, feed(releases, "0.1.1").release, { platform: "darwin-x64" }), /no download for this Mac \(darwin-x64\)/);
    assert.equal(currentVersion(l), "0.1.0");
  });
  test("the links are switched by a rename: always a link, never a moment without one", () => {
    const { l } = home();
    installed(l, "0.1.0");
    installed(l, "0.1.1");
    for (let i = 0; i < 20; i++) {
      switchTo(l, i % 2 ? "0.1.1" : "0.1.0");
      assert.ok(lstatSync(join(l.share, "current")).isSymbolicLink());
    }
    assert.equal(readlinkSync(join(l.share, "current")), join("versions", "0.1.1"));
    assert.equal(readlinkSync(l.bin), join(l.share, "current", "kiko"));
    assert.ok(!readdirSync(l.share).some((f) => f.includes(".new-")), "no temp links left");
    assert.throws(() => switchTo(l, "9.9.9"), /isn't unpacked/);
  });
  test("a kiko of your own in ~/.local/bin (a file, or a link elsewhere) is left as it is", () => {
    const { l } = home();
    mkdirSync(join(l.bin, ".."), { recursive: true });
    writeFileSync(l.bin, "#!/bin/sh\necho mine\n");
    installed(l, "0.1.0");
    assert.equal(readFileSync(l.bin, "utf8"), "#!/bin/sh\necho mine\n");
    rmSync(l.bin);
    symlinkSync("/usr/bin/true", l.bin);
    installed(l, "0.1.1");
    assert.equal(readlinkSync(l.bin), "/usr/bin/true");
  });
  test("one install at a time: a second one while the first holds the lock is refused; a lock left by a process that's gone is taken over", async () => {
    const { l } = home();
    let inner: unknown = null;
    await withLock(l, async () => {
      inner = await withLock(l, async () => "ran").catch((err) => err);
    });
    assert.ok(inner instanceof BusyError);
    // Left by a pid that isn't running.
    mkdirSync(join(l.share, ".update-lock"));
    writeFileSync(join(l.share, ".update-lock", "pid"), "999999");
    assert.equal(await withLock(l, async () => "ran"), "ran");
    assert.ok(!existsSync(join(l.share, ".update-lock")));
  });
});

describe("rollback and pruning", () => {
  test("rollback: current and previous change places; again goes forward", () => {
    const { l } = home();
    installed(l, "0.1.0");
    installed(l, "0.1.1");
    assert.deepEqual(rollback(l), { from: "0.1.1", to: "0.1.0" });
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(runs(l.bin), "0.1.0");
    assert.deepEqual(rollback(l), { from: "0.1.0", to: "0.1.1" });
    assert.equal(runs(l.bin), "0.1.1");
  });
  test("no previous link (only ever the install script): the newest older one; none at all: says so", () => {
    const { l } = home();
    installed(l, "0.1.0");
    assert.throws(() => rollback(l), /no version before 0\.1\.0/);
    installed(l, "0.0.9");
    installed(l, "0.1.1");
    rmSync(join(l.share, "previous"));
    assert.equal(previousVersion(l), "0.1.0");
  });
  test("pruned: all but current, previous and the one running", () => {
    const { l } = home();
    for (const v of ["0.1.0", "0.1.1", "0.1.2", "0.1.3"]) installed(l, v);
    assert.deepEqual(prune(l, ["0.1.0"]), ["0.1.1"]);
    assert.deepEqual(versionsInstalled(l), ["0.1.0", "0.1.2", "0.1.3"]);
  });
  test("an install prunes too, never the one running", async () => {
    const { l, releases } = home();
    installed(l, "0.1.0");
    installed(l, "0.1.1");
    await install(l, feed(releases, "0.1.2").release, { platform: PLATFORM, verify: unchecked, running: "0.1.0" });
    assert.deepEqual(versionsInstalled(l), ["0.1.0", "0.1.1", "0.1.2"]);
    await install(l, feed(releases, "0.1.3").release, { platform: PLATFORM, verify: unchecked, running: "0.1.2" });
    assert.deepEqual(versionsInstalled(l), ["0.1.2", "0.1.3"]);
  });
});

describe("this copy", () => {
  test("a version folder is an installed copy, by its real path; the repo isn't", () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    assert.equal(installedAs(dir, l), "0.1.0");
    assert.equal(installedAs(join(l.share, "current"), l), "0.1.0", "through current, too");
    assert.equal(installedAs(REPO, l), null);
    assert.deepEqual(copyOf(dir, "ignored", l), { root: dir, version: "0.1.0", layout: l, installed: true });
    assert.equal(copyOf(REPO, "0.0.1", l).installed, false);
  });
  test("what's shown: ready (installed, newer), available (not installed), a rollback's older one", () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    const copy = copyOf(dir, "", l);
    assert.deepEqual(viewOf(copy, {}, true), { running: "0.1.0", installed: true, auto: true });
    assert.equal(updateWords(viewOf(copy, {}, true)), null);
    saveState(l, { checkedAt: 1, latest: { version: "0.1.1", notes: "Faster." } });
    const available = viewOf(copy, loadState(l), false);
    assert.deepEqual(available.available, { version: "0.1.1", notes: "Faster." });
    assert.equal(updateWords(available), `Update 0.1.1 available · ${COMMAND} update`);
    installed(l, "0.1.1");
    const ready = viewOf(copy, loadState(l), true);
    assert.deepEqual(ready.ready, { version: "0.1.1", notes: "Faster." });
    assert.equal(ready.available, undefined);
    assert.equal(updateWords(ready), "Update 0.1.1 ready · restart to use it");
    // Running 0.1.1, rolled back to 0.1.0.
    const newer = copyOf(versionDir(l, "0.1.1"), "", l);
    switchTo(l, "0.1.0");
    assert.equal(updateWords(viewOf(newer, {}, true)), "Kiko 0.1.0 starts next time");
  });
});

describe("the app's updater", () => {
  /** An updater for an install of 0.1.0 in a fresh home, with its feed offering `offer`. */
  function setup(offer: string, o: { auto?: boolean; sha256?: string; verify?: Verify } = {}) {
    const { l, releases } = home();
    const dir = installed(l, "0.1.0");
    const f = feed(releases, offer, { sha256: o.sha256 });
    const views: UpdateView[] = [];
    const events: string[] = [];
    let auto = o.auto ?? true;
    const updater = new Updater({
      copy: copyOf(dir, "", l),
      auto: () => auto,
      changed: (v) => views.push(v),
      log: (event) => events.push(event),
      url: f.url,
      platform: PLATFORM,
      mode: "on",
      verify: o.verify ?? unchecked,
    });
    return { l, updater, views, events, f, setAuto: (on: boolean) => (auto = on), releases };
  }

  test("automatic updates on: the newer one is installed in the background and becomes ready", async () => {
    const { l, updater, views, events } = setup("0.1.1");
    assert.equal(await updater.check(), "installed");
    assert.equal(currentVersion(l), "0.1.1");
    assert.deepEqual(views.at(-1)!.ready, { version: "0.1.1", notes: "Kiko 0.1.1: better." });
    assert.ok(events.includes("update_installed"));
    assert.ok(loadState(l).checkedAt);
  });
  test("off: it only says one's available; asked to (Install it now), it installs", async () => {
    const { l, updater, views } = setup("0.1.1", { auto: false });
    assert.equal(await updater.check(), "available");
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(views.at(-1)!.available?.version, "0.1.1");
    assert.equal(await updater.check(true), "installed");
    assert.equal(currentVersion(l), "0.1.1");
  });
  test("a bad download: not installed, said in Settings (failed), the old one still current", async () => {
    const { l, updater, views } = setup("0.1.1", { sha256: "f".repeat(64) });
    assert.equal(await updater.check(), "failed");
    assert.equal(currentVersion(l), "0.1.0");
    assert.match(views.at(-1)!.failed ?? "", /isn't the one the release lists/);
  });
  test("offline: nothing said, tried again in an hour, not before", async () => {
    const { l, updater, views, events, releases } = setup("0.1.1");
    rmSync(join(releases, "latest.json"));
    let fetched = 0;
    const realFetch = globalThis.fetch;
    assert.equal(await updater.check(), "offline");
    assert.ok(loadState(l).failedAt);
    assert.equal(loadState(l).checkedAt, undefined);
    assert.ok(events.includes("update_check_failed"));
    assert.ok(views.every((v) => !v.available && !v.ready));
    // start(): not due within the hour.
    globalThis.fetch = (async () => (fetched++, new Response("{}"))) as typeof fetch;
    updater.start();
    await new Promise((r) => setTimeout(r, 50));
    updater.stop();
    globalThis.fetch = realFetch;
    assert.equal(fetched, 0);
  });
  test("looked today already: start() doesn't look again", async () => {
    const { l, updater } = setup("0.1.1");
    saveState(l, { checkedAt: Date.now() - 3600_000, latest: { version: "0.1.0" } });
    updater.start();
    await new Promise((r) => setTimeout(r, 100));
    updater.stop();
    assert.equal(currentVersion(l), "0.1.0", "nothing installed: it didn't look");
  });
  test("a version you rolled back from isn't installed again by itself, nor in the header; Settings still offers it", async () => {
    const { l, updater, views } = setup("0.1.1");
    saveState(l, { skip: "0.1.1" });
    assert.equal(await updater.check(), "available");
    assert.equal(currentVersion(l), "0.1.0");
    assert.deepEqual(views.at(-1)!.available, { version: "0.1.1", notes: "Kiko 0.1.1: better.", skipped: true });
    assert.equal(updateWords(views.at(-1)!), null);
    assert.equal(updateChoices(views.at(-1)!)[0].value, "install");
  });
  test("nothing newer: the newest", async () => {
    const { updater } = setup("0.1.0");
    assert.equal(await updater.check(), "newest");
  });
  test("a development checkout never looks by itself; with force it looks and only says", async () => {
    const { l, releases } = home();
    const f = feed(releases, "0.1.1");
    const views: UpdateView[] = [];
    const dev = (mode: "on" | "force") => new Updater({ copy: copyOf(REPO, "0.1.0", l), auto: () => true, changed: (v) => views.push(v), log: () => {}, url: f.url, mode });
    assert.equal(dev("on").active, false);
    const forced = dev("force");
    assert.equal(forced.active, true);
    assert.equal(await forced.check(), "available");
    assert.equal(views.at(-1)!.available?.version, "0.1.1");
    assert.ok(!existsSync(join(l.share, "versions", "0.1.1")), "nothing installed");
  });
});

describe("Restart now", () => {
  test("the same command, from the new version's folder", () => {
    const { l } = home();
    const old = installed(l, "0.1.0");
    installed(l, "0.1.1");
    const copy = copyOf(old, "", l);
    const real = realpathSync(old);
    const next = versionDir(l, "0.1.1");
    // The one executable, as an installed copy runs its programs (kiko _run start), by its real path or not.
    assert.deepEqual(relaunchCommand(copy, [join(real, "kiko"), "_run", "start"]), [join(next, "kiko"), "_run", "start"]);
    assert.deepEqual(relaunchCommand(copy, [join(old, "kiko"), "_run", "start"]), [join(next, "kiko"), "_run", "start"]);
    // Node and a script inside the version: the script moves, Node doesn't.
    assert.deepEqual(relaunchCommand(copy, ["/usr/local/bin/node", join(real, "src/start.ts")]), ["/usr/local/bin/node", join(next, "src/start.ts")]);
  });
  test("nothing newer installed, or a development copy: null (start.ts restarts this one)", () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    assert.equal(relaunchCommand(copyOf(dir, "", l), ["/node", "x"]), null);
    assert.equal(relaunchCommand(copyOf(REPO, "0.1.0", l), ["/node", "x"]), null);
  });
});

describe("kiko update", () => {
  function deps(copy: ReturnType<typeof copyOf>, url: string, running = false) {
    const out: string[] = [];
    return { out, d: { copy, url, appRunning: async () => running, out: (line: string) => out.push(line), progress: null, platform: PLATFORM, verify: unchecked } };
  }
  test("a development copy: says git pull, changes nothing", async () => {
    const { l, releases } = home();
    const { out, d } = deps(copyOf(REPO, "0.1.0", l), feed(releases, "0.1.1").url);
    assert.equal(await updateCommand([], d), 1);
    assert.match(out.join("\n"), /development copy.*git pull/);
  });
  test("installs the newest and says how to start it: restart the running app", async () => {
    const { l, releases } = home();
    const dir = installed(l, "0.1.0");
    const { out, d } = deps(copyOf(dir, "", l), feed(releases, "0.1.1", { notes: "Snappier." }).url, true);
    assert.equal(await updateCommand([], d), 0);
    const said = out.join("\n");
    assert.match(said, /Kiko 0\.1\.1 is installed/);
    assert.match(said, /What's new: Snappier\./);
    assert.match(said, /Restart Kiko to use 0\.1\.1: Settings → Updates → Restart now, or quit it \(q\) and run kiko-dev\. Your sessions keep running\./);
    assert.equal(currentVersion(l), "0.1.1");
    // Again: installed already.
    const again = deps(copyOf(dir, "", l), d.url, false);
    assert.equal(await updateCommand([], again.d), 0);
    assert.match(again.out.join("\n"), /0\.1\.1 is installed already \(0\.1\.0 is running\)[\s\S]*next time you run kiko-dev/);
  });
  test("--rollback: back to the one before, which automatic updates then leave alone", async () => {
    const { l } = home();
    installed(l, "0.1.0");
    const dir = installed(l, "0.1.1");
    const { out, d } = deps(copyOf(dir, "", l), "file:///none");
    assert.equal(await updateCommand(["--rollback"], d), 0);
    assert.match(out.join("\n"), /Back to Kiko 0\.1\.0 \(0\.1\.1 is kept/);
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(loadState(l).skip, "0.1.1");
  });
  test("a bad argument, an unreachable feed, a bad download: said, exit not 0", async () => {
    const { l, releases } = home();
    const dir = installed(l, "0.1.0");
    assert.equal(await updateCommand(["--now"], deps(copyOf(dir, "", l), "file:///none").d), 2);
    const offline = deps(copyOf(dir, "", l), pathToFileURL(join(releases, "none.json")).href);
    assert.equal(await updateCommand([], offline.d), 1);
    assert.match(offline.out.join("\n"), /couldn't read the release feed/);
    const bad = deps(copyOf(dir, "", l), feed(releases, "0.1.1", { sha256: "e".repeat(64) }).url);
    assert.equal(await updateCommand([], bad.d), 1);
    assert.match(bad.out.join("\n"), /0\.1\.1 wasn't installed: the download isn't the one the release lists/);
    assert.equal(currentVersion(l), "0.1.0");
  });
});

describe("kiko update, run for real against a fake install", () => {
  // The real CLI (node src/cli.ts), told it runs from versions/<this version> of a throwaway HOME's
  // install (KIKO_APP_ROOT); the feed a file:// one; no app on its socket.
  test("update, then --rollback, then update again; ~/.local/bin/kiko follows", () => {
    const { home: h, l, releases } = home();
    const running = version();
    const dir = installed(l, running);
    const next = `${running.split("-")[0].split(".").slice(0, 2).join(".")}.${Number(running.split("-")[0].split(".")[2]) + 1}`;
    feed(releases, next, { notes: "Live test." });
    const env = {
      PATH: process.env.PATH,
      HOME: h,
      TMPDIR: process.env.TMPDIR,
      KIKO_APP_ROOT: dir,
      KIKO_RELEASES_URL: pathToFileURL(releases).href,
      KIKO_SOCKET: join(h, "no-app.sock"),
      KIKO_SETTINGS: join(h, "settings.json"),
      KIKO_ENV_FILE: "", // never the repo's .env
      KIKO_KEYCHAIN: "off",
      // A checkout's own escape (core/updates/verify.ts trustOf): these fake versions aren't signed at all.
      KIKO_UPDATE_SIGNATURES: "off",
    };
    const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", join(REPO, "src/cli.ts"), ...args], { env, encoding: "utf8" });
    // The real platform's asset: the feed lists only darwin-arm64.
    if (`${process.platform}-${process.arch}` !== PLATFORM) return;
    const up = cli("update");
    assert.equal(up.status, 0, up.stdout + up.stderr);
    assert.match(up.stdout, new RegExp(`Kiko ${next.replace(/\./g, "\\.")} is installed`));
    assert.match(up.stdout, /It starts the next time you run kiko-dev\./);
    assert.equal(runs(join(h, ".local/bin/kiko")), next);
    const back = cli("update", "--rollback");
    assert.equal(back.status, 0, back.stdout + back.stderr);
    assert.equal(runs(join(h, ".local/bin/kiko")), running);
    assert.equal(cli("update").status, 0);
    assert.equal(runs(join(h, ".local/bin/kiko")), next);
    assert.equal(loadState(l).skip, undefined, "asked for by hand: no longer skipped");
  });
});

describe("what you see", () => {
  const state = (patch: Partial<UiState>): UiState =>
    ({ ...ui.state, about: { voice: "george (Pocket)", model: "Haiku", hotkey: "right_option", pttMode: "hold", classifier: true }, cost: 0, ...patch }) as UiState;
  const plain = (s: string) => s.replace(/\u001b\[[0-9;:]*m/g, "");
  const ready = "Update 0.1.1 ready · restart to use it";

  test("the window's line: the update between what it's set to and the keys; none, nothing", () => {
    assert.match(plain(frameLines(state({ update: ready }), 200).bottom), /Haiku · \$0\.000 · Update 0\.1\.1 ready · restart to use it · /);
    assert.doesNotMatch(plain(frameLines(state({}), 200).bottom), /Update/);
  });
  test("the full screen's header keeps it whole; the tiled look's line has it last, in cyan", () => {
    const header = plain(renderToString(React.createElement(Box, { width: 200 }, ...headerRight(state({ update: ready }))), { columns: 200 }));
    assert.match(header, /Update 0\.1\.1 ready · restart to use it/);
    assert.match(barText(state({ update: ready })), /#\[fg=cyan\]Update 0\.1\.1 ready · restart to use it#\[default\]/);
  });
  test("Settings → Updates: restart into a ready one, install an available one, look again; a development copy has nothing to do", () => {
    const base = { running: "0.1.0", installed: true, auto: true };
    assert.deepEqual(
      updateChoices({ ...base, ready: { version: "0.1.1" } }).map((c) => c.value),
      ["restart", "keep"],
    );
    assert.equal(updateChoices({ ...base, ready: { version: "0.1.1" } })[0].label, "Restart now to use 0.1.1");
    assert.deepEqual(
      updateChoices({ ...base, auto: false, available: { version: "0.1.1" } }).map((c) => c.value),
      ["install", "check", "keep"],
    );
    assert.deepEqual(
      updateChoices(base).map((c) => c.value),
      ["check", "keep"],
    );
    assert.deepEqual(
      updateChoices({ ...base, installed: false, available: { version: "0.1.1" } }).map((c) => c.value),
      ["keep"],
    );
    assert.ok(SETTING_GROUPS.find((g) => g.title === "Updates")?.keys.includes("autoUpdate"));
    assert.match(SETTING_ABOUT.autoUpdate, /KIKO_UPDATES=off/);
  });
  test("kiko --help lists update and --rollback", () => {
    assert.ok(USAGE.includes("update --rollback"));
    assert.ok(USAGE.includes("THIRD_PARTY_NOTICES.md"), "says where the third-party notices are");
    assert.deepEqual(parseCli(["update", "--rollback"]), { kind: "run", command: "update", args: ["--rollback"] });
  });
});
