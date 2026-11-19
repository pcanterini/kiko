// The network going while an update is fetched (a VPN switched on mid-download, 0.3.5 → 0.3.6:
// frozen at 88%, then Bun's raw "ECONNRESET: The socket connection was closed unexpectedly"): a
// download with no bytes for the stall limit is given up on and tried again, one cut off is resumed
// with a Range request when the server takes them (else fetched again from the start), a server
// that ignores the Range is read from the start, the sha256 is right either way; after the last try
// the words are plain and nothing is kept or switched; a checksum mismatch, a 404 or a refusal for
// the invite isn't tried again; the feed is tried again too. Against a local HTTP server on
// 127.0.0.1 standing in for kiko.sh, in a throwaway HOME: no network, never the real ~/.local.
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { ChecksumError, cutOff, download, fetchRelease, HttpError, type NetTiming, NetworkError } from "../../../src/core/updates/feed.ts";
import { InviteError } from "../../../src/core/updates/invite.ts";
import { copyOf, currentVersion, type Layout, layoutOf, switchTo, versionDir } from "../../../src/core/updates/layout.ts";
import { loadState, Updater } from "../../../src/core/updates/updater.ts";
import type { Verify } from "../../../src/core/updates/verify.ts";
import { updateCommand } from "../../../src/update-cli.ts";

const PLATFORM = "darwin-arm64";
const TOKEN = "Abc123_-xyzXYZ789abcDEFg";
const root = mkdtempSync(join(tmpdir(), "cbn-"));
after(() => rmSync(root, { recursive: true, force: true }));
/** Short waits and a short stall limit: the same logic, in milliseconds. */
const FAST: NetTiming = { downloadWaits: [10, 10, 10], feedWaits: [10, 10], stallMs: 300 };
const unchecked: Verify = async () => {};

// ── A stand-in for kiko.sh ───────────────────────────────────────────────────

/**
 * What the server does with the next request for the file: send it all; send `at` bytes and then
 * hang (stall) or close the connection (reset); answer with a status; the whole file to a Range
 * (ignoreRange, still saying it takes them); or a 206 that starts somewhere else than asked (oddRange).
 */
type Plan =
  | { kind: "full" }
  | { kind: "ignoreRange" }
  | { kind: "stall"; at: number }
  | { kind: "reset"; at: number }
  | { kind: "status"; status: number; headers?: Record<string, string> }
  | { kind: "oddRange" };

type Seen = { path: string; headers: IncomingHttpHeaders };
type Site = {
  url: string;
  seen: Seen[];
  /** Whether it takes byte ranges (says Accept-Ranges: bytes, answers a Range with 206). */
  ranges: boolean;
  plans: Plan[];
  feedPlans: Plan[];
  body: Buffer;
  sha256: string;
  close: () => Promise<void>;
};

let site: Site;

async function startSite(): Promise<Site> {
  const s = { seen: [] as Seen[], ranges: false, plans: [] as Plan[], feedPlans: [] as Plan[], body: Buffer.alloc(0), sha256: "" } as Site;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    s.seen.push({ path, headers: req.headers });
    if (path === "/releases/latest.json") {
      const plan = s.feedPlans.shift() ?? { kind: "full" };
      if (plan.kind === "reset") return void req.socket.destroy();
      if (plan.kind === "status") return void (res.writeHead(plan.status, plan.headers), res.end());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.1.1", assets: { [PLATFORM]: { url: `${s.url}/releases/kiko-0.1.1-${PLATFORM}.tar.gz`, sha256: s.sha256 } } }));
      return;
    }
    if (!path.endsWith(".tar.gz")) return void (res.writeHead(404), res.end());
    const plan = s.plans.shift() ?? { kind: "full" };
    if (plan.kind === "status") return void (res.writeHead(plan.status, plan.headers), res.end());
    const total = s.body.length;
    const asked = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ""));
    let start = 0;
    const headers: Record<string, string> = { "content-type": "application/gzip", etag: '"abc"' };
    if (s.ranges) headers["accept-ranges"] = "bytes";
    let status = 200;
    if (plan.kind === "oddRange" && asked) {
      status = 206;
      headers["content-range"] = `bytes 0-${total - 1}/${total}`;
    } else if (s.ranges && asked && plan.kind !== "ignoreRange") {
      start = Number(asked[1]);
      status = 206;
      headers["content-range"] = `bytes ${start}-${total - 1}/${total}`;
    }
    const slice = plan.kind === "oddRange" ? s.body : s.body.subarray(start);
    headers["content-length"] = String(slice.length);
    res.writeHead(status, headers);
    if (plan.kind === "full" || plan.kind === "oddRange" || plan.kind === "ignoreRange") return void res.end(slice);
    // The first `at` bytes of what's left, then nothing more (stall) or a closed connection (reset).
    res.write(slice.subarray(0, Math.max(0, plan.at - start)));
    if (plan.kind === "reset") setTimeout(() => req.socket.destroy(), 30);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return s;
}

before(async () => {
  site = await startSite();
});
after(() => site.close());
/** A release's tarball, kiko-0.1.1/kiko and 256 KB that doesn't compress (so a cut halfway is mid-body). */
function tarball(): Buffer {
  const work = mkdtempSync(join(root, "tar-"));
  const folder = join(work, "kiko-0.1.1");
  mkdirSync(folder);
  writeFileSync(join(folder, "kiko"), "#!/bin/sh\necho 0.1.1\n");
  chmodSync(join(folder, "kiko"), 0o755);
  writeFileSync(join(folder, "blob"), randomBytes(256 * 1024));
  const path = join(work, "t.tar.gz");
  execFileSync("tar", ["-czf", path, "-C", work, "kiko-0.1.1"]);
  const bytes = readFileSync(path);
  rmSync(work, { recursive: true, force: true });
  return bytes;
}

beforeEach(() => {
  site.seen = [];
  site.plans = [];
  site.feedPlans = [];
  site.ranges = false;
  site.body = tarball();
  site.sha256 = createHash("sha256").update(site.body).digest("hex");
});

let n = 0;
const fresh = () => join(root, `dl-${n++}`, "kiko.tar.gz");
const asset = () => ({ url: `${site.url}/releases/kiko-0.1.1-${PLATFORM}.tar.gz`, sha256: site.sha256 });
const downloads = () => site.seen.filter((r) => r.path.endsWith(".tar.gz"));
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const HALF = 128 * 1024;

describe("the download, when the network goes", () => {
  test("a stall mid-body: given up on after the stall limit, tried again, finished, the sha256 right", async () => {
    site.plans = [{ kind: "stall", at: HALF }];
    const to = fresh();
    const started = Date.now();
    await download(asset(), to, undefined, undefined, undefined, FAST);
    assert.equal(sha(to), site.sha256);
    assert.equal(downloads().length, 2);
    assert.ok(Date.now() - started >= 300, "waited the stall limit before giving up on it");
  });

  test("a reset mid-body, the server taking ranges: resumed with Range (206), the sha256 right, the progress never back to 0", async () => {
    site.ranges = true;
    site.plans = [{ kind: "reset", at: HALF }];
    const to = fresh();
    const progress: number[] = [];
    const auth = { origin: site.url, headers: { "Kiko-Install-Token": TOKEN } };
    await download(asset(), to, (done) => progress.push(done), undefined, auth, FAST);
    assert.equal(sha(to), site.sha256);
    const [first, second] = downloads();
    assert.equal(downloads().length, 2);
    assert.equal(first.headers.range, undefined);
    assert.match(String(second.headers.range), /^bytes=(\d+)-$/);
    const from = Number(/^bytes=(\d+)-$/.exec(String(second.headers.range))![1]);
    assert.ok(from > 0 && from <= HALF, `resumed from ${from}`);
    assert.equal(second.headers["if-range"], '"abc"', "If-Range: a file changed meanwhile comes whole");
    assert.equal(second.headers["kiko-install-token"], TOKEN, "the invite's headers on the try again too");
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], "progress only goes up");
    assert.equal(progress.at(-1), site.body.length);
  });

  test("a server that ignores the Range (200): read again from the start, the sha256 right", async () => {
    site.ranges = true;
    site.plans = [{ kind: "reset", at: HALF }, { kind: "ignoreRange" }];
    const to = fresh();
    const progress: number[] = [];
    await download(asset(), to, (done) => progress.push(done), undefined, undefined, FAST);
    assert.equal(sha(to), site.sha256);
    assert.equal(downloads().length, 2);
    assert.ok(downloads()[1].headers.range, "it asked for the rest");
    assert.equal(progress.at(-1), site.body.length, "counted from the start again, not on top of the first try");
  });

  test("a 206 that doesn't start where it stopped: fetched again from the start, without a Range", async () => {
    site.ranges = true;
    site.plans = [{ kind: "reset", at: HALF }, { kind: "oddRange" }];
    const to = fresh();
    await download(asset(), to, undefined, undefined, undefined, FAST);
    assert.equal(sha(to), site.sha256);
    assert.equal(downloads().length, 3);
    assert.ok(downloads()[1].headers.range);
    assert.equal(downloads()[2].headers.range, undefined);
  });

  test("kiko.sh as it is (no Accept-Ranges): a reset is fetched again from the start, never with a Range", async () => {
    site.plans = [{ kind: "reset", at: HALF }];
    const to = fresh();
    await download(asset(), to, undefined, undefined, undefined, FAST);
    assert.equal(sha(to), site.sha256);
    assert.deepEqual(
      downloads().map((r) => r.headers.range),
      [undefined, undefined],
    );
  });

  test("a 503 is tried again; a 404 and a refusal for the invite aren't", async () => {
    site.plans = [{ kind: "status", status: 503 }];
    const ok = fresh();
    await download(asset(), ok, undefined, undefined, undefined, FAST);
    assert.equal(sha(ok), site.sha256);
    assert.equal(downloads().length, 2);

    site.seen = [];
    site.plans = [{ kind: "status", status: 404 }];
    const missing = fresh();
    await assert.rejects(download(asset(), missing, undefined, undefined, undefined, FAST), (e) => e instanceof HttpError && e.status === 404 && !(e instanceof NetworkError));
    assert.equal(downloads().length, 1);
    assert.equal(existsSync(missing), false);

    site.seen = [];
    site.plans = [{ kind: "status", status: 403, headers: { "kiko-install-error": "revoked" } }];
    await assert.rejects(download(asset(), fresh(), undefined, undefined, undefined, FAST), (e) => e instanceof InviteError && e.code === "revoked");
    assert.equal(downloads().length, 1);
  });

  test("a checksum mismatch isn't tried again: ChecksumError, nothing kept", async () => {
    const to = fresh();
    await assert.rejects(download({ ...asset(), sha256: "e".repeat(64) }, to, undefined, undefined, undefined, FAST), ChecksumError);
    assert.equal(downloads().length, 1);
    assert.equal(existsSync(to), false);
  });

  test("cut off four times: NetworkError in plain words, the raw error and the tries for the log, nothing kept, no token in it", async () => {
    site.plans = [1, 2, 3, 4].map(() => ({ kind: "reset", at: HALF }) as Plan);
    const to = fresh();
    const auth = { origin: site.url, headers: { "Kiko-Install-Token": TOKEN } };
    const err = await download(asset(), to, undefined, undefined, auth, FAST).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof NetworkError, String(err));
    assert.equal(err.message, cutOff());
    assert.match(err.message, /^The download was cut off: the network changed or dropped\. Nothing was installed; run kiko(-dev)? update to try again\.$/);
    assert.equal(err.tries, 4);
    assert.ok(err.detail.length > 0);
    assert.ok(!err.detail.includes(TOKEN));
    assert.equal(downloads().length, 4);
    assert.equal(existsSync(to), false);
  });
});

describe("the feed, when the network goes", () => {
  test("cut off twice, then read: tried again (2 more), the release read", async () => {
    site.feedPlans = [
      { kind: "reset", at: 0 },
      { kind: "status", status: 502 },
    ];
    const release = await fetchRelease(`${site.url}/releases/latest.json`, "0.1.0", undefined, undefined, FAST);
    assert.equal(release.version, "0.1.1");
    assert.equal(site.seen.length, 3);
  });
  test("never reached: NetworkError in plain words after 3 tries; a 404 isn't tried again", async () => {
    site.feedPlans = [1, 2, 3].map(() => ({ kind: "reset", at: 0 }) as Plan);
    const err = await fetchRelease(`${site.url}/releases/latest.json`, "0.1.0", undefined, undefined, FAST).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof NetworkError, String(err));
    assert.equal(err.tries, 3);
    assert.match(err.message, /^127\.0\.0\.1:\d+ couldn't be reached: the network changed or dropped\. Nothing was installed; run kiko(-dev)? update to try again\.$/);
    site.seen = [];
    site.feedPlans = [{ kind: "status", status: 404 }];
    await assert.rejects(fetchRelease(`${site.url}/releases/latest.json`, "0.1.0", undefined, undefined, FAST), (e) => e instanceof HttpError && e.status === 404);
    assert.equal(site.seen.length, 1);
  });
});

// ── kiko update and the app's updater ───────────────────────────────────────

let h = 0;
function installedHome(): { l: Layout; dir: string } {
  const home = join(root, `home-${h++}`);
  mkdirSync(home, { recursive: true });
  const l = layoutOf(home);
  const dir = versionDir(l, "0.1.0");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kiko"), "#!/bin/sh\necho 0.1.0\n");
  chmodSync(join(dir, "kiko"), 0o755);
  switchTo(l, "0.1.0");
  return { l, dir };
}

describe("what you see when it's cut off for good", () => {
  test("kiko update: the plain line, the raw error only in the log, nothing installed or left over", async () => {
    site.plans = [1, 2, 3, 4].map(() => ({ kind: "reset", at: HALF }) as Plan);
    const { l, dir } = installedHome();
    const out: string[] = [];
    const logged: { event: string; fields: Record<string, unknown> }[] = [];
    const code = await updateCommand([], {
      copy: copyOf(dir, "", l),
      url: `${site.url}/releases/latest.json`,
      appRunning: async () => false,
      out: (line) => out.push(line),
      progress: null,
      platform: PLATFORM,
      verify: unchecked,
      net: FAST,
      log: (event, fields) => void logged.push({ event, fields }),
    });
    assert.equal(code, 1);
    const said = out.join("\n");
    assert.match(said, /X The download was cut off: the network changed or dropped\. Nothing was installed; run kiko(-dev)? update to try again\./);
    assert.doesNotMatch(said, /ECONNRESET|terminated|socket|verbose/i, "the raw error isn't said");
    assert.equal(currentVersion(l), "0.1.0", "nothing switched");
    assert.deepEqual(readdirSync(join(l.share, "versions")), ["0.1.0"], "nothing left beside the versions");
    assert.equal(loadState(l).failed?.why, cutOff());
    const failed = logged.find((e) => e.event === "update_failed");
    assert.ok(failed, "logged");
    assert.equal(failed.fields.tries, 4);
    assert.equal(typeof failed.fields.why, "string");
    assert.notEqual(failed.fields.why, cutOff(), "the log has the error itself");
  });

  test("kiko update with the feed unreachable: the plain line", async () => {
    site.feedPlans = [1, 2, 3].map(() => ({ kind: "reset", at: 0 }) as Plan);
    const { l, dir } = installedHome();
    const out: string[] = [];
    const logged: string[] = [];
    const code = await updateCommand([], {
      copy: copyOf(dir, "", l),
      url: `${site.url}/releases/latest.json`,
      appRunning: async () => false,
      out: (line) => out.push(line),
      progress: null,
      platform: PLATFORM,
      verify: unchecked,
      net: FAST,
      log: (event) => void logged.push(event),
    });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /X 127\.0\.0\.1:\d+ couldn't be reached: the network changed or dropped\. Nothing was installed; run kiko(-dev)? update to try again\./);
    assert.deepEqual(logged, ["update_check_failed"]);
  });

  test("the app's updater: failed, Settings has the plain line, the log the error and the tries", async () => {
    site.plans = [1, 2, 3, 4].map(() => ({ kind: "reset", at: HALF }) as Plan);
    const { l, dir } = installedHome();
    const events: { event: string; fields?: Record<string, unknown> }[] = [];
    const updater = new Updater({
      copy: copyOf(dir, "", l),
      auto: () => true,
      changed: () => {},
      log: (event, fields) => events.push({ event, fields }),
      url: `${site.url}/releases/latest.json`,
      platform: PLATFORM,
      mode: "on",
      verify: unchecked,
      net: FAST,
    });
    assert.equal(await updater.check(), "failed");
    assert.equal(currentVersion(l), "0.1.0");
    assert.equal(updater.view().failed, cutOff());
    const failed = events.find((e) => e.event === "update_failed");
    assert.equal(failed?.fields?.tries, 4);
    assert.notEqual(failed?.fields?.why, cutOff());
    // Then the network's back: the next look installs it.
    site.plans = [];
    assert.equal(await updater.check(), "installed");
    assert.equal(currentVersion(l), "0.1.1");
  });
});
