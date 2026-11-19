// The invite's token (src/core/updates/invite.ts; the site's RELEASES.md, "Invites and the gate"):
// kept beside the install (mode 600), sent by the updater and `kiko update` with every request for
// the feed and the download, only to the feed's own origin; a refusal from kiko.sh said plainly;
// `kiko update --token`; and install.sh sending the same headers and keeping the same files. Against
// a throwaway HOME and a local HTTP server standing in for kiko.sh: no network, never the real
// ~/.local, nothing of the user's environment passed on (no KIKO_* or REX_*).
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchRelease } from "../../../src/core/updates/feed.ts";
import { headersFor, InviteError, installId, installIdFile, inviteError, readToken, releaseAuth, saveToken, tokenFile, tokenFrom } from "../../../src/core/updates/invite.ts";
import { copyOf, currentVersion, type Layout, layoutOf, switchTo, versionDir } from "../../../src/core/updates/layout.ts";
import { loadState, Updater, updateWords, viewOf } from "../../../src/core/updates/updater.ts";
import type { Verify } from "../../../src/core/updates/verify.ts";
import { updateChoices } from "../../../src/core/settings-options.ts";
import { updateCommand } from "../../../src/update-cli.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const PLATFORM = "darwin-arm64";
const TOKEN = "Abc123_-xyzXYZ789abcDEFg";
const root = mkdtempSync(join(tmpdir(), "cbi-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function home(): { home: string; l: Layout } {
  const h = join(root, `home-${n++}`);
  mkdirSync(h, { recursive: true });
  return { home: h, l: layoutOf(h) };
}

function installed(l: Layout, v: string) {
  const dir = versionDir(l, v);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "kiko"), `#!/bin/sh\necho ${v}\n`);
  chmodSync(join(dir, "kiko"), 0o755);
  switchTo(l, v);
  return dir;
}

const unchecked: Verify = async () => {};
const mode = (file: string) => statSync(file).mode & 0o777;

// ── A stand-in for kiko.sh ───────────────────────────────────────────────────

type Seen = { path: string; headers: IncomingHttpHeaders };
type Site = { url: string; seen: Seen[]; refuse: string | null; refuseDownload: string | null; release: (v: string, o?: { assetBase?: string; sha256?: string }) => void; close: () => Promise<void> };

function tarball(v: string): Buffer {
  const work = mkdtempSync(join(root, "tar-"));
  const folder = join(work, `kiko-${v}`);
  mkdirSync(folder);
  writeFileSync(join(folder, "kiko"), `#!/bin/sh\necho ${v}\n`);
  chmodSync(join(folder, "kiko"), 0o755);
  const path = join(work, "t.tar.gz");
  execFileSync("tar", ["-czf", path, "-C", work, `kiko-${v}`]);
  const bytes = readFileSync(path);
  rmSync(work, { recursive: true, force: true });
  return bytes;
}

async function site(): Promise<Site> {
  const files = new Map<string, { body: Buffer | string; type: string }>();
  const s: Partial<Site> = { seen: [], refuse: null, refuseDownload: null };
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    s.seen!.push({ path, headers: req.headers });
    const isDownload = path.endsWith(".tar.gz");
    const code = isDownload ? (s.refuseDownload ?? s.refuse) : s.refuse;
    if (code) {
      res.writeHead(code === "missing" ? 401 : 403, { "content-type": "text/plain; charset=utf-8", "kiko-install-error": code });
      res.end(`kiko.sh's own words for ${code}\n`);
      return;
    }
    const f = files.get(path);
    if (!f) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": f.type });
    res.end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.url = url;
  s.release = (v, o = {}) => {
    const bytes = tarball(v);
    const name = `kiko-${v}-${PLATFORM}.tar.gz`;
    files.set(`/releases/${name}`, { body: bytes, type: "application/gzip" });
    const sha = o.sha256 ?? createHash("sha256").update(bytes).digest("hex");
    files.set("/releases/latest.json", { body: JSON.stringify({ version: v, assets: { [PLATFORM]: { url: `${o.assetBase ?? `${url}/releases`}/${name}`, sha256: sha } } }), type: "application/json" });
  };
  s.close = () => new Promise<void>((r) => server.close(() => r()));
  return s as Site;
}

let kiko: Site;
let elsewhere: Site;
before(async () => {
  kiko = await site();
  elsewhere = await site();
});
after(async () => {
  await kiko.close();
  await elsewhere.close();
});
beforeEach(() => {
  kiko.seen.length = 0;
  elsewhere.seen.length = 0;
  kiko.refuse = null;
  kiko.refuseDownload = null;
});

const feedUrl = () => `${kiko.url}/releases/latest.json`;

// ── The files ────────────────────────────────────────────────────────────────

describe("the token and the install id, kept beside the install", () => {
  test("the token: kept readable by you only, read back; something that isn't one isn't kept", () => {
    const { l } = home();
    assert.equal(readToken(l), null);
    saveToken(l, TOKEN);
    assert.equal(readToken(l), TOKEN);
    assert.equal(mode(tokenFile(l)), 0o600);
    assert.equal(readFileSync(tokenFile(l), "utf8"), `${TOKEN}\n`);
    assert.throws(() => saveToken(l, "no good; rm -rf /"));
    writeFileSync(tokenFile(l), "not a token at all!\n");
    assert.equal(readToken(l), null);
  });

  test("the install id: made once, kept (600), the same after; not made when asked not to", () => {
    const { l } = home();
    assert.equal(installId(l, false), null);
    const id = installId(l);
    assert.match(id ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(installId(l), id);
    assert.equal(installId(l, false), id);
    assert.equal(mode(installIdFile(l)), 0o600);
    assert.equal(installIdFile(l), join(l.share, "install-id"));
    assert.equal(tokenFile(l), join(l.share, "install-token"));
  });

  test("the token is taken from the token, the link or the whole command", () => {
    assert.equal(tokenFrom(TOKEN), TOKEN);
    assert.equal(tokenFrom(`  https://kiko.sh/i/${TOKEN}  `), TOKEN);
    assert.equal(tokenFrom(`https://kiko.sh/i/${TOKEN}/`), TOKEN);
    assert.equal(tokenFrom(`curl -fsSL https://kiko.sh/i/${TOKEN} | sh`), TOKEN);
    assert.equal(tokenFrom("kiko.sh"), null);
    assert.equal(tokenFrom("short"), null);
    assert.equal(tokenFrom(`https://kiko.sh/i/${TOKEN}$(reboot)`), null);
  });

  test("install.sh keeps the same files and sends the same headers (they're one contract)", () => {
    const script = readFileSync(join(REPO, "install.sh"), "utf8");
    assert.ok(script.includes('TOKEN_FILE="$SHARE/install-token"\n'));
    assert.ok(script.includes('ID_FILE="$SHARE/install-id"\n'));
    assert.ok(script.includes("Kiko-Install-Token: %s\\nKiko-Install-Id: %s\\n"));
    assert.ok(script.includes("Kiko-Client: install"));
    // The line kiko.sh/i/<token> fills in, exactly once (the site's src/invites.ts TOKEN_LINE).
    assert.equal(script.split("INVITE=${KIKO_INSTALL_TOKEN:-}").length, 2);
  });
});

describe("what's sent, and where", () => {
  test("no token: only the client's name and version; with one: the token and this Mac's install id too", () => {
    const { l } = home();
    assert.deepEqual(releaseAuth(l, feedUrl(), "0.3.2").headers, { "Kiko-Client": "app/0.3.2" });
    assert.equal(existsSync(installIdFile(l)), false, "no id made without a token");
    saveToken(l, TOKEN);
    const auth = releaseAuth(l, feedUrl(), "0.3.2");
    assert.deepEqual(auth.headers, { "Kiko-Client": "app/0.3.2", "Kiko-Install-Token": TOKEN, "Kiko-Install-Id": installId(l, false) });
    assert.equal(auth.origin, kiko.url);
  });

  test("only to the feed's own origin: never to a file the feed names elsewhere, nor a file:// one", () => {
    const { l } = home();
    saveToken(l, TOKEN);
    const auth = releaseAuth(l, feedUrl(), "0.3.2");
    assert.equal(headersFor(auth, `${kiko.url}/releases/kiko-0.3.2-darwin-arm64.tar.gz`)["Kiko-Install-Token"], TOKEN);
    assert.deepEqual(headersFor(auth, `${elsewhere.url}/kiko.tar.gz`), {});
    assert.deepEqual(headersFor(auth, "https://example.com/kiko.tar.gz"), {});
    assert.deepEqual(headersFor(releaseAuth(l, "file:///tmp/latest.json", "0.3.2"), "file:///tmp/kiko.tar.gz"), {});
    assert.deepEqual(headersFor(undefined, feedUrl()), {});
  });

  test("a refusal is an InviteError in our words, by kiko.sh's code; other failures aren't", () => {
    const r = (code: string) => new Response("x", { status: 403, headers: { "Kiko-Install-Error": code } });
    assert.equal(inviteError(r("revoked"))?.message, "This install link was turned off. Ask for a new invite: support@kiko.sh");
    assert.equal(inviteError(r("limit"))?.code, "limit");
    assert.match(inviteError(r("missing"))?.message ?? "", /update --token <token>/);
    assert.equal(inviteError(r("unavailable")), null);
    assert.equal(inviteError(r("something new")), null);
    assert.equal(inviteError(new Response("x", { status: 500 })), null);
  });
});

describe("the updater sends them", () => {
  function setup(o: { token?: boolean; assetBase?: string } = {}) {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    if (o.token !== false) saveToken(l, TOKEN);
    kiko.release("0.1.1", { assetBase: o.assetBase });
    const events: string[] = [];
    const updater = new Updater({ copy: copyOf(dir, "", l), auto: () => true, changed: () => {}, log: (e) => events.push(e), url: feedUrl(), platform: PLATFORM, mode: "on", verify: unchecked });
    return { l, dir, updater, events };
  }

  test("with the feed and the download: the token, the install id, app/<version>", async () => {
    const { l, updater } = setup();
    assert.equal(await updater.check(), "installed");
    assert.equal(currentVersion(l), "0.1.1");
    const id = installId(l, false);
    assert.deepEqual(
      kiko.seen.map((s) => [s.path, s.headers["kiko-install-token"], s.headers["kiko-install-id"], s.headers["kiko-client"]]),
      [
        ["/releases/latest.json", TOKEN, id, "app/0.1.0"],
        [`/releases/kiko-0.1.1-${PLATFORM}.tar.gz`, TOKEN, id, "app/0.1.0"],
      ],
    );
  });

  test("a download the feed names on another origin gets no token", async () => {
    // The feed points its tarball at another server, which has nothing: the download fails there, tokenless.
    const { updater } = setup({ assetBase: `${elsewhere.url}/releases` });
    await updater.check();
    assert.equal(kiko.seen[0].headers["kiko-install-token"], TOKEN);
    assert.equal(elsewhere.seen.length, 1);
    assert.equal(elsewhere.seen[0].headers["kiko-install-token"], undefined);
    assert.equal(elsewhere.seen[0].headers["kiko-install-id"], undefined);
  });

  test("no token kept: none sent, the install id not made", async () => {
    const { l, updater } = setup({ token: false });
    assert.equal(await updater.check(), "installed");
    assert.equal(kiko.seen[0].headers["kiko-install-token"], undefined);
    assert.equal(kiko.seen[0].headers["kiko-client"], "app/0.1.0");
    assert.equal(existsSync(installIdFile(l)), false);
  });

  test("a revoked link: updates stop, said plainly in the header and Settings; looked at again tomorrow; a look that gets through clears it", async () => {
    const { l, dir, updater, events } = setup();
    kiko.refuse = "revoked";
    assert.equal(await updater.check(), "link");
    assert.equal(currentVersion(l), "0.1.0");
    assert.ok(events.includes("update_link_refused"));
    const state = loadState(l);
    assert.equal(state.link?.code, "revoked");
    assert.ok(state.checkedAt, "not tried again within the hour, nor the day");
    const view = viewOf(copyOf(dir, "", l), state, true);
    assert.equal(updateWords(view), "Updates stopped: this install link was turned off");
    const choices = updateChoices(view);
    assert.equal(choices[0].value, "check");
    assert.equal(choices[0].hint, "This install link was turned off. Ask for a new invite: support@kiko.sh");
    kiko.refuse = null;
    assert.equal(await updater.check(), "installed");
    assert.equal(loadState(l).link, undefined);
  });

  test("a download refused for the invite (its Macs used up meanwhile): link, not a failed install", async () => {
    const { l, updater } = setup();
    kiko.refuseDownload = "limit";
    assert.equal(await updater.check(), "link");
    assert.equal(loadState(l).link?.code, "limit");
    assert.equal(loadState(l).failed, undefined);
  });

  test("fetchRelease throws the InviteError itself", async () => {
    kiko.refuse = "missing";
    await assert.rejects(fetchRelease(feedUrl(), "0.1.0"), (e) => e instanceof InviteError && e.code === "missing");
  });
});

describe("kiko update", () => {
  function deps(dirOrRepo: string, l: Layout) {
    const out: string[] = [];
    return {
      out,
      d: { copy: copyOf(dirOrRepo, "0.1.0", l), url: feedUrl(), appRunning: async () => false, out: (line: string) => out.push(line), progress: null, platform: PLATFORM, verify: unchecked },
    };
  }

  test("sends the token, and says a revoked link plainly (exit 1)", async () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    saveToken(l, TOKEN);
    kiko.release("0.1.1");
    kiko.refuse = "revoked";
    const { out, d } = deps(dir, l);
    assert.equal(await updateCommand([], d), 1);
    // The error's mark (X, plain), then the words, with no "couldn't read the release feed" before them.
    assert.equal(out.at(-1), "X This install link was turned off. Ask for a new invite: support@kiko.sh");
    assert.equal(kiko.seen[0].headers["kiko-install-token"], TOKEN);
    assert.equal(loadState(l).link?.code, "revoked");
  });

  test("--token <the link>: kept (600), the refusal cleared, and this update sends it", async () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    kiko.release("0.1.1");
    const { out, d } = deps(dir, l);
    assert.equal(await updateCommand(["--token", `https://kiko.sh/i/${TOKEN}`], d), 0);
    assert.equal(readToken(l), TOKEN);
    assert.equal(mode(tokenFile(l)), 0o600);
    assert.match(out[0], /Kept your install token in .*install-token \(readable by you only\)/);
    assert.equal(currentVersion(l), "0.1.1");
    assert.ok(kiko.seen.every((s) => s.headers["kiko-install-token"] === TOKEN));
  });

  test("--token=<the whole command> works too; something that isn't a token: exit 2, nothing kept", async () => {
    const { l } = home();
    const dir = installed(l, "0.1.0");
    kiko.release("0.1.0");
    assert.equal(await updateCommand([`--token=curl -fsSL https://kiko.sh/i/${TOKEN} | sh`], deps(dir, l).d), 0);
    assert.equal(readToken(l), TOKEN);
    const other = home();
    const bad = deps(installed(other.l, "0.1.0"), other.l);
    assert.equal(await updateCommand(["--token", "nope"], bad.d), 2);
    assert.match(bad.out.join("\n"), /isn't an install token/);
    assert.equal(await updateCommand(["--token"], bad.d), 2);
    assert.equal(readToken(other.l), null);
  });

  test("--token on a development copy: kept for the installed one, and said", async () => {
    const { l } = home();
    const { out, d } = deps(REPO, l);
    assert.equal(await updateCommand(["--token", TOKEN], d), 0);
    assert.equal(readToken(l), TOKEN);
    assert.match(out.join("\n"), /development copy, so it doesn't update itself/);
    assert.equal(kiko.seen.length, 0);
  });
});

// ── install.sh ───────────────────────────────────────────────────────────────

/** install.sh as curl | sh runs it, in a throwaway HOME, with nothing of this process's environment. */
function runInstall(h: string, script: string, extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  // A coding agent "installed", so the script doesn't stop to offer one.
  mkdirSync(join(h, ".local", "bin"), { recursive: true });
  writeFileSync(join(h, ".local", "bin", "claude"), "#!/bin/sh\n");
  chmodSync(join(h, ".local", "bin", "claude"), 0o755);
  const env = { HOME: h, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", TMPDIR: process.env.TMPDIR ?? "/tmp", KIKO_RELEASES_URL: `${kiko.url}/releases`, KIKO_NO_SETUP: "1", ...extra };
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-s"], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(script);
  });
}

describe("install.sh", () => {
  const SCRIPT = readFileSync(join(REPO, "install.sh"), "utf8");
  /** The script as kiko.sh/i/<token> answers it. */
  const linked = (token: string) => SCRIPT.replace("INVITE=${KIKO_INSTALL_TOKEN:-}", `INVITE=${token}`);

  test("from an install link: sends the token, a new install id and its name with the feed and the download; keeps both (600)", async () => {
    const { home: h, l } = home();
    // A checksum the download won't match: the script stops right after downloading, before anything is installed.
    kiko.release("0.3.2", { sha256: "0".repeat(64) });
    const ran = await runInstall(h, linked(TOKEN));
    assert.equal(ran.code, 1);
    assert.match(ran.err, /checksum is wrong/);
    const id = readFileSync(installIdFile(l), "utf8").trim();
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(readToken(l), TOKEN);
    assert.equal(mode(installIdFile(l)), 0o600);
    assert.equal(mode(tokenFile(l)), 0o600);
    assert.deepEqual(
      kiko.seen.map((s) => [s.path, s.headers["kiko-install-token"], s.headers["kiko-install-id"], s.headers["kiko-client"]]),
      [
        ["/releases/latest.json", TOKEN, id, "install"],
        ["/releases/kiko-0.3.2-darwin-arm64.tar.gz", TOKEN, id, "install"],
      ],
    );
    // Run again (the bare script): the kept token and the same install id.
    kiko.seen.length = 0;
    await runInstall(h, SCRIPT);
    assert.equal(kiko.seen[0].headers["kiko-install-token"], TOKEN);
    assert.equal(kiko.seen[0].headers["kiko-install-id"], id);
  });

  test("cut short in transit (curl | sh runs what came): nothing runs, nothing is fetched or kept (B10)", async () => {
    const { home: h, l } = home();
    kiko.release("0.3.2", { sha256: "0".repeat(64) });
    kiko.seen.length = 0;
    // Everything up to the checksum check: the feed's fetch and the download included.
    const cut = linked(TOKEN).slice(0, SCRIPT.indexOf("checksum is wrong"));
    const ran = await runInstall(h, cut);
    assert.notEqual(ran.code, 0);
    assert.equal(ran.out, "");
    assert.deepEqual(kiko.seen, []);
    assert.equal(readToken(l), null);
  });

  test("refused: kiko.sh's own words, exit 1, the token not kept", async () => {
    const { home: h, l } = home();
    kiko.release("0.3.2");
    kiko.refuse = "revoked";
    const ran = await runInstall(h, linked(TOKEN));
    assert.equal(ran.code, 1);
    assert.equal(ran.err.trim(), "kiko install: kiko.sh's own words for revoked");
    assert.equal(readToken(l), null);
    assert.equal(kiko.seen.length, 1);
  });

  test("without a token: none sent (the bare script, as before the invites)", async () => {
    const { home: h, l } = home();
    kiko.release("0.3.2", { sha256: "0".repeat(64) });
    await runInstall(h, SCRIPT);
    assert.equal(kiko.seen[0].headers["kiko-install-token"], undefined);
    assert.equal(kiko.seen[0].headers["kiko-install-id"], undefined);
    assert.equal(kiko.seen[0].headers["kiko-client"], "install");
    assert.equal(existsSync(installIdFile(l)), false);
  });

  test("KIKO_INSTALL_TOKEN works too; a token with odd characters stops it before anything is fetched", async () => {
    const { home: h, l } = home();
    kiko.release("0.3.2", { sha256: "0".repeat(64) });
    await runInstall(h, SCRIPT, { KIKO_INSTALL_TOKEN: TOKEN });
    assert.equal(kiko.seen[0].headers["kiko-install-token"], TOKEN);
    assert.equal(readToken(l), TOKEN);
    kiko.seen.length = 0;
    const odd = await runInstall(home().home, SCRIPT, { KIKO_INSTALL_TOKEN: "abc$(touch x)defghijklmnop" });
    assert.equal(odd.code, 1);
    assert.match(odd.err, /isn't one/);
    assert.equal(kiko.seen.length, 0);
  });

  test("the token never goes on a command line: the script sends it from a header file", () => {
    assert.ok(!/-H "Kiko-Install-Token/.test(SCRIPT));
    assert.ok(SCRIPT.includes('-H "@$headers"'));
  });
});
