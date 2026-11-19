// The release and Kiko Dev side by side on one Mac (src/core/name.ts FLAVOUR):
// which one a copy is, the names each has of its own, the hook scripts and status line following the
// copy they're in, each one's hook entries told apart by their root (so each upgradeHooks, connect
// and disconnect leaves the other's alone), Kiko Dev's first start copying your settings over,
// and neither starting while the other runs. Every file is this test's own: temporary HOMEs, never
// ~/.config, ~/.claude, ~/.codex or the Keychain (keychain.test.ts copies keys in a throwaway one).
import "../../setup.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { HOOK_COMMAND, HOOK_TIMEOUTS, HOOKS_BEFORE_UPGRADES } from "../../../src/agents/claude-code/settings.ts";
import { CODEX_HOOKS, codexStatusOf, connectCodex, disconnectCodex } from "../../../src/agents/codex/setup.ts";
import { APP_ROOT, hookFlavour, SHARE_DIR } from "../../../src/core/app-root.ts";
import { FIRST_START_MARK, firstStart, firstStartWords } from "../../../src/core/first-start.ts";
import { COMMAND, DEV, FLAVOUR, flavourNames, flavourOf, OTHER, OWN, SOCKET_PATH, STATE_PATH, TITLE } from "../../../src/core/name.ts";
import { otherRunning, otherRunningWords, startedAt } from "../../../src/core/running.ts";
import { SERVER } from "../../../src/terminals/tmux/tmux.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `fl-${name}-`));
const RELEASE = flavourNames("release");
const DEV_NAMES = flavourNames("dev");

describe("which one this is, and its names", () => {
  test("KIKO_FLAVOUR (release or dev) wins; else an installed copy is the release, a checkout Kiko Dev", () => {
    assert.equal(flavourOf(undefined, true), "release");
    assert.equal(flavourOf(undefined, false), "dev");
    assert.equal(flavourOf("release", false), "release");
    assert.equal(flavourOf(" Dev ", true), "dev");
    assert.equal(flavourOf("staging", false), "dev", "anything else: as it is");
  });

  test("the release keeps every real name; Kiko Dev has its own of each", () => {
    assert.deepEqual(RELEASE, {
      flavour: "release",
      title: "Kiko",
      slug: "kiko",
      command: "kiko",
      socket: "/tmp/kiko.sock",
      state: "/tmp/kiko.state.json",
      configFolder: "kiko",
      tmuxServer: "kiko",
      keychainService: "sh.kiko.keys",
      phonePort: 7333,
      helperApp: "Kiko",
      helperAppId: "sh.kiko.helper",
    });
    assert.equal(DEV_NAMES.title, "Kiko Dev");
    // The helper app: its own name and bundle id, so the two never share a macOS permission.
    assert.deepEqual([DEV_NAMES.helperApp, DEV_NAMES.helperAppId], ["Kiko Dev", "sh.kiko.dev.helper"]);
    assert.equal(DEV_NAMES.command, "kiko-dev");
    for (const key of Object.keys(RELEASE) as (keyof typeof RELEASE)[]) assert.notEqual(DEV_NAMES[key], RELEASE[key], `${key} is Kiko Dev's own`);
  });

  test("this checkout runs as Kiko Dev: its socket, state file, tmux server, command and title", () => {
    assert.equal(FLAVOUR, "dev");
    assert.ok(DEV);
    assert.deepEqual([SOCKET_PATH, STATE_PATH, SERVER, COMMAND, TITLE], ["/tmp/kiko-dev.sock", "/tmp/kiko-dev.state.json", "kiko-dev", "kiko-dev", "Kiko Dev"]);
    assert.deepEqual([OWN, OTHER], [DEV_NAMES, RELEASE]);
    assert.ok(existsSync(join(REPO, "bin", "kiko-dev")));
  });
});

describe("the hook scripts follow the copy they're in", () => {
  /** What hooks/lib.mjs says, from `lib`: its flavour, its socket, its config folder. */
  const libSays = (lib: string, env: NodeJS.ProcessEnv = {}) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(lib)}); console.log(JSON.stringify([m.FLAVOUR, m.socketPaths()[0], m.CONFIG_DIR]))`], {
        env: { PATH: process.env.PATH, HOME: "/home/someone", ...env },
        encoding: "utf8",
      }),
    );

  test("in a checkout (src/ beside hooks/): Kiko Dev's socket and config folder", () => {
    assert.deepEqual(libSays(join(REPO, "hooks", "lib.mjs")), ["dev", DEV_NAMES.socket, "/home/someone/.config/kiko-dev"]);
  });

  test("in an installed copy (no src/): the release's", () => {
    const copy = tmp("install");
    cpSync(join(REPO, "hooks"), join(copy, "hooks"), { recursive: true });
    assert.deepEqual(libSays(join(copy, "hooks", "lib.mjs")), ["release", RELEASE.socket, "/home/someone/.config/kiko"]);
  });

  test("never the session's KIKO_FLAVOUR (both copies' hooks run on every event: each must reach only its own app); KIKO_SOCKET still wins", () => {
    assert.equal(libSays(join(REPO, "hooks", "lib.mjs"), { KIKO_FLAVOUR: "release" })[1], DEV_NAMES.socket);
    assert.equal(libSays(join(REPO, "hooks", "lib.mjs"), { KIKO_SOCKET: "/tmp/x.sock" })[1], "/tmp/x.sock");
  });

  test("its app not running: the hook is gone at once, printing nothing", () => {
    const copy = tmp("quiet");
    cpSync(join(REPO, "hooks"), join(copy, "hooks"), { recursive: true });
    const started = Date.now();
    const run = spawnSync(process.execPath, [join(copy, "hooks", "claude-code-hook.mjs")], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "/x", last_assistant_message: "done" }),
      env: { PATH: process.env.PATH, HOME: copy, KIKO_SOCKET: join(copy, "nobody.sock") },
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
    assert.ok(Date.now() - started < 3000);
  });
});

describe("each one's hook entries, told apart by their root", () => {
  const share = "/Users/someone/.local/share/kiko";
  const script = "hooks/claude-code-hook.mjs";

  test("this copy's own root: this flavour's; a release's install, or its executable's `hook`: the release's; any other checkout: Kiko Dev's", () => {
    assert.equal(hookFlavour(join(APP_ROOT, script), HOOK_COMMAND, share), "dev");
    assert.equal(hookFlavour(`/elsewhere/kiko/${script}`, `node /elsewhere/kiko/${script}`, share), "dev");
    assert.equal(hookFlavour(`${share}/current/${script}`, `${share}/current/kiko hook ${share}/current/${script}`, share), "release");
    assert.equal(hookFlavour(`${share}/versions/0.1.0/${script}`, `node ${share}/versions/0.1.0/${script}`, share), "release");
    assert.equal(hookFlavour(`/opt/cb/${script}`, `/opt/cb/kiko hook /opt/cb/${script}`, share), "release", "a release run from elsewhere");
    assert.equal(hookFlavour(`/a b/${script}`, `'/a b/kiko' hook '/a b/${script}'`, share), "release");
  });

  /** A temporary HOME with Claude Code's settings holding the release's entries and another checkout's, on the events from before the upgrades (no PermissionDenied). */
  function sideBySide(options: { devGone?: boolean } = {}) {
    const home = tmp("home");
    const releaseRoot = join(home, ".local", "share", "kiko", "current");
    const checkout = join(home, "git", "other-checkout");
    for (const root of [releaseRoot, ...(options.devGone ? [] : [checkout])]) {
      mkdirSync(join(root, "hooks"), { recursive: true });
      writeFileSync(join(root, script), "");
    }
    const release = `${releaseRoot}/kiko hook ${releaseRoot}/${script}`;
    const dev = `node ${checkout}/${script}`;
    const hooks: Record<string, unknown[]> = {};
    for (const event of HOOKS_BEFORE_UPGRADES) {
      const timeout = HOOK_TIMEOUTS[event];
      hooks[event] = [{ hooks: [{ type: "command", command: release, timeout }] }, { hooks: [{ type: "command", command: dev, timeout }] }];
    }
    const settings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ statusLine: { type: "command", command: "mine" }, hooks }, null, 2));
    return { home, settings, release, dev };
  }

  /** The start's upgrade (agents/setup.ts upgradeHooks) and Claude Code's status, as `flavour` would run them in a process of its own, on that HOME. */
  function upgradeAs(flavour: "release" | "dev", s: ReturnType<typeof sideBySide>) {
    const code = `
      const { upgradeHooks } = await import(${JSON.stringify(join(REPO, "src/agents/setup.ts"))});
      const { claudeCodeSetup } = await import(${JSON.stringify(join(REPO, "src/agents/claude-code/setup.ts"))});
      const { upgraded } = upgradeHooks([claudeCodeSetup], {});
      console.log(JSON.stringify({ upgraded, status: claudeCodeSetup.status() }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: {
        PATH: process.env.PATH,
        HOME: s.home,
        KIKO_FLAVOUR: flavour,
        KIKO_CLAUDE_SETTINGS: s.settings,
        KIKO_SETTINGS: join(s.home, `kiko-${flavour}-settings.json`),
        KIKO_KEYCHAIN: "off",
        KIKO_ENV_FILE: "",
        KIKO_LOG_DIR: join(s.home, "logs"),
      },
      encoding: "utf8",
    });
    return { ...JSON.parse(out), file: JSON.parse(readFileSync(s.settings, "utf8")) };
  }
  const commands = (file: { hooks: Record<string, { hooks: { command: string }[] }[]> }, event: string) => (file.hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));

  test("Kiko Dev's upgrade gives its own entries the new event, and leaves the release's alone", () => {
    const s = sideBySide();
    const { upgraded, status, file } = upgradeAs("dev", s);
    assert.deepEqual(
      upgraded.map((u: { did: string; events: string[] }) => [u.did, u.events]),
      [["added", ["PermissionDenied", "PreToolUse"]]],
    );
    assert.equal(status.state, "connected");
    assert.deepEqual(commands(file, "PermissionDenied"), [`node ${join(REPO, script)}`], "one entry: Kiko Dev's (this checkout's)");
    for (const event of HOOKS_BEFORE_UPGRADES) assert.deepEqual(commands(file, event), [s.release, s.dev], `${event}: both, as they were`);
    assert.deepEqual(file.statusLine, { type: "command", command: "mine" });
  });

  test("the release's upgrade does the same for its own, and leaves Kiko Dev's alone", () => {
    const s = sideBySide();
    const { upgraded, status, file } = upgradeAs("release", s);
    assert.deepEqual(
      upgraded.map((u: { did: string; events: string[] }) => [u.did, u.events]),
      [["added", ["PermissionDenied", "PreToolUse"]]],
    );
    assert.equal(status.state, "connected");
    assert.equal(commands(file, "PermissionDenied").length, 1);
    for (const event of HOOKS_BEFORE_UPGRADES) assert.deepEqual(commands(file, event), [s.release, s.dev], `${event}: both, as they were`);
  });

  test("a checkout that's gone: Kiko Dev's to repair; the release never points it at itself", () => {
    const s = sideBySide({ devGone: true });
    const release = upgradeAs("release", s);
    for (const event of HOOKS_BEFORE_UPGRADES) assert.deepEqual(commands(release.file, event), [s.release, s.dev], `${event}: the gone one left as it was`);
    const dev = upgradeAs("dev", sideBySide({ devGone: true }));
    assert.equal(dev.status.state, "needs repair");
    assert.deepEqual(
      dev.upgraded.map((u: { did: string }) => u.did),
      ["skipped"],
    );
  });

  test("Codex's hooks.json: connecting and disconnecting this one leaves the release's entries where they are", () => {
    const dir = tmp("codex");
    const path = join(dir, "hooks.json");
    const releaseRoot = `${SHARE_DIR}/current`;
    const release = `${releaseRoot}/kiko hook ${releaseRoot}/hooks/codex-hook.mjs`;
    const hooks = Object.fromEntries(
      Object.entries(CODEX_HOOKS).map(([event, h]) => [event, [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: release, timeout: h.timeout }] }]]),
    );
    writeFileSync(path, JSON.stringify({ hooks }));
    assert.equal(codexStatusOf(JSON.parse(readFileSync(path, "utf8")), path).state, "not connected", "the release's aren't this one's");
    const connected = connectCodex(path);
    assert.deepEqual(connected.events, Object.keys(CODEX_HOOKS));
    const both = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(codexStatusOf(both, path).state, "connected");
    for (const event of Object.keys(CODEX_HOOKS)) assert.equal(both.hooks[event].length, 2, `${event}: the release's and this one's`);
    disconnectCodex(path);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { hooks });
  });
});

// The release installed on a Mac beside Kiko Dev, whose hooks were already in ~/.claude/settings.json. Each flavour,
// in a process of its own on a HOME holding only the other one's entries (Claude Code's and Codex's,
// on every event): setup's agents step and the app's first-run card (the same rows: agents/setup.ts
// cardRows) offer both as not connected; yes adds this one's entries after the other's; `kiko
// uninstall` lists both, and takes out only this one's: each file is as it was before.
describe("the other flavour's hooks already there: setup offers, adds its own beside them; uninstall takes out only its own", () => {
  const claudeScript = "hooks/claude-code-hook.mjs";
  const codexScript = "hooks/codex-hook.mjs";

  /** A HOME whose agents' files hold only `other`'s entries: the release's by its install (`current`), Kiko Dev's from another checkout. */
  function homeWith(other: "release" | "dev") {
    const home = tmp(`only-${other}`);
    const root = other === "release" ? join(home, ".local", "share", "kiko", "current") : join(home, "git", "kiko");
    mkdirSync(join(root, "hooks"), { recursive: true });
    for (const script of [claudeScript, codexScript]) writeFileSync(join(root, script), "");
    const command = (script: string) => (other === "release" ? `${root}/kiko hook ${root}/${script}` : `node ${root}/${script}`);
    const claude = {
      hooks: Object.fromEntries(Object.entries(HOOK_TIMEOUTS).map(([event, timeout]) => [event, [{ hooks: [{ type: "command", command: command(claudeScript), timeout }] }]])),
    };
    const codex = {
      hooks: Object.fromEntries(
        Object.entries(CODEX_HOOKS).map(([event, h]) => [event, [{ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: command(codexScript), timeout: h.timeout }] }]]),
      ),
    };
    const settings = join(home, ".claude", "settings.json");
    const codexHome = join(home, ".codex");
    mkdirSync(dirname(settings), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(settings, JSON.stringify(claude, null, 2));
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(codex, null, 2));
    return { home, settings, codexHooks: join(codexHome, "hooks.json"), codexHome, claude, codex, claudeCommand: command(claudeScript), codexCommand: command(codexScript) };
  }

  /** As `flavour`, on that HOME: the card's rows, uninstall's list, both connected (the card's yes), the rows and list again, then uninstall's disconnects. */
  function runAs(flavour: "release" | "dev", h: ReturnType<typeof homeWith>) {
    const code = `
      const { answerCard, cardRows, statusOf, SETUPS } = await import(${JSON.stringify(join(REPO, "src/agents/setup.ts"))});
      const { hookedSetups } = await import(${JSON.stringify(join(REPO, "src/uninstall.ts"))});
      const { HOOK_COMMAND } = await import(${JSON.stringify(join(REPO, "src/agents/claude-code/settings.ts"))});
      const { CODEX_HOOK_COMMAND } = await import(${JSON.stringify(join(REPO, "src/agents/codex/setup.ts"))});
      const fs = await import("node:fs");
      const hooked = ["claude-code", "codex"];
      const rows = () => (cardRows({}) ?? []).filter((r) => hooked.includes(r.id)).map((r) => [r.id, r.state, r.ask]);
      const listed = () => hookedSetups().map((s) => s.id);
      const before = { rows: rows(), listed: listed() };
      const { outcomes } = answerCard({ offered: hooked, connect: hooked, later: false });
      const files = () => ({ claude: JSON.parse(fs.readFileSync(${JSON.stringify(h.settings)}, "utf8")), codex: JSON.parse(fs.readFileSync(${JSON.stringify(h.codexHooks)}, "utf8")) });
      const connected = { states: SETUPS.filter((s) => hooked.includes(s.id)).map((s) => [s.id, statusOf(s).state]), listed: listed(), files: files() };
      for (const s of hookedSetups()) s.disconnect();
      console.log(JSON.stringify({ before, outcomes: outcomes.map((o) => [o.id, o.did]), connected, after: { listed: listed(), files: files() }, own: { claude: HOOK_COMMAND, codex: CODEX_HOOK_COMMAND } }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: h.home,
        KIKO_FLAVOUR: flavour,
        KIKO_CLAUDE_SETTINGS: h.settings,
        CODEX_HOME: h.codexHome,
        KIKO_CODEX_SESSIONS: join(h.home, "codex-sessions"),
        KIKO_T3_HOME: join(h.home, "no-t3"),
        KIKO_OPENCODE_SERVICE: join(h.home, "no-opencode", "service.json"),
        KIKO_OPENCODE_STATE: join(h.home, "no-opencode"),
        KIKO_SETTINGS: join(h.home, `kiko-${flavour}-settings.json`),
        KIKO_KEYCHAIN: "off",
        KIKO_ENV_FILE: "",
        KIKO_LOG_DIR: join(h.home, "logs"),
      },
      encoding: "utf8",
    });
    return JSON.parse(out);
  }
  const commands = (file: { hooks: Record<string, { hooks: { command: string }[] }[]> }, event: string) => (file.hooks[event] ?? []).flatMap((g) => g.hooks.map((x) => x.command));

  for (const [flavour, other] of [
    ["release", "dev"],
    ["dev", "release"],
  ] as const) {
    test(`${flavour === "release" ? "the release" : "Kiko Dev"}, with only ${other === "release" ? "the release's" : "Kiko Dev's"} entries there`, () => {
      const h = homeWith(other);
      const r = runAs(flavour, h);
      assert.deepEqual(
        r.before.rows,
        [
          ["claude-code", "not connected", true],
          ["codex", "not connected", true],
        ],
        "offered in setup's agents step and the first-run card: the other's entries aren't this one's",
      );
      assert.deepEqual(r.before.listed, [], "uninstall lists none of the other's");
      assert.deepEqual(r.outcomes, [
        ["claude-code", "connected"],
        ["codex", "connected"],
      ]);
      assert.deepEqual(r.connected.states, [
        ["claude-code", "connected"],
        ["codex", "connected"],
      ]);
      assert.notEqual(r.own.claude, h.claudeCommand);
      for (const event of Object.keys(HOOK_TIMEOUTS))
        assert.deepEqual(commands(r.connected.files.claude, event), [h.claudeCommand, r.own.claude], `Claude Code's ${event}: the other's, then this one's`);
      for (const event of Object.keys(CODEX_HOOKS)) assert.deepEqual(commands(r.connected.files.codex, event), [h.codexCommand, r.own.codex], `Codex's ${event}: the other's, then this one's`);
      assert.deepEqual(r.connected.listed, ["claude-code", "codex"], "uninstall lists this one's");
      assert.deepEqual(r.after.files, { claude: h.claude, codex: h.codex }, "uninstall took out this one's only: each file as it was");
      assert.deepEqual(r.after.listed, []);
    });
  }
});

describe("Kiko Dev's first start: your settings copied over, once", () => {
  /** A HOME with the settings a checkout had before (~/.config/kiko), a running app's lock among them. */
  function before() {
    const home = tmp("first");
    const old = join(home, ".config", "kiko");
    mkdirSync(join(old, "run"), { recursive: true });
    mkdirSync(join(old, "codex-sessions"), { recursive: true });
    for (const [name, text] of Object.entries({
      "settings.json": '{"spokenName":"Jarvis"}',
      "dictionary.json": "{}",
      "phones.json": "[]",
      "renames.json": "{}",
      "codex-sessions/1.json": "{}",
      "run/app.lock": "123\n",
    }))
      writeFileSync(join(old, name), text);
    return { home, old, dev: join(home, ".config", "kiko-dev") };
  }

  test("everything but run/ copied, the original left as it was, the keys from the release's service; then a mark, and never again", async () => {
    const { home, old, dev } = before();
    const asked: string[] = [];
    const done = await firstStart({ home, keys: { copyFrom: async (service) => (asked.push(service), ["OPENROUTER_API_KEY"]) } });
    assert.deepEqual(done?.copied.sort(), ["codex-sessions", "dictionary.json", "phones.json", "renames.json", "settings.json"]);
    assert.deepEqual(asked, ["sh.kiko.keys"]);
    assert.equal(readFileSync(join(dev, "settings.json"), "utf8"), '{"spokenName":"Jarvis"}');
    assert.ok(!existsSync(join(dev, "run")), "no lock of another app's");
    assert.ok(existsSync(join(old, "settings.json")) && existsSync(join(old, "run", "app.lock")), "the original stays");
    assert.ok(existsSync(join(dev, FIRST_START_MARK)));
    assert.match(firstStartWords(done, RELEASE, DEV_NAMES) ?? "", /Kiko Dev: your settings are copied from ~\/\.config\/kiko to ~\/\.config\/kiko-dev[\s\S]*OPENROUTER_API_KEY/);
    writeFileSync(join(old, "settings.json"), "{}");
    assert.equal(await firstStart({ home, keys: { copyFrom: async () => assert.fail("not again") } }), null);
    assert.equal(readFileSync(join(dev, "settings.json"), "utf8"), '{"spokenName":"Jarvis"}');
  });

  test("the account isn't carried over: account.json stays behind, and its session token comes out of Kiko Dev's keys", async () => {
    const { home, old, dev } = before();
    writeFileSync(join(old, "account.json"), '{"email":"name@example.com","since":1}');
    const removed: string[] = [];
    const done = await firstStart({ home, keys: { copyFrom: async () => ["OPENROUTER_API_KEY", "KIKO_ACCOUNT_SESSION"], remove: async (name) => (removed.push(name), true) } });
    assert.ok(!existsSync(join(dev, "account.json")));
    assert.deepEqual(done?.keys, ["OPENROUTER_API_KEY"]);
    assert.deepEqual(removed, ["KIKO_ACCOUNT_SESSION"]);
  });

  test("what Kiko Dev's own hook made first (Codex's records) is kept, and merged with the copied ones", async () => {
    const { home, dev } = before();
    mkdirSync(join(dev, "codex-sessions"), { recursive: true });
    writeFileSync(join(dev, "codex-sessions", "2.json"), '{"dev":true}');
    writeFileSync(join(dev, "codex-sessions", "1.json"), '{"newer":true}');
    await firstStart({ home, keys: null });
    assert.deepEqual(readdirSync(join(dev, "codex-sessions")).sort(), ["1.json", "2.json"]);
    assert.equal(readFileSync(join(dev, "codex-sessions", "1.json"), "utf8"), '{"newer":true}', "its own kept");
  });

  test("a dev folder with settings of its own: nothing copied; nothing to copy: only the mark", async () => {
    const { home, dev } = before();
    mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, "settings.json"), "{}");
    assert.equal(await firstStart({ home, keys: null }), null);
    assert.ok(!existsSync(join(dev, "dictionary.json")));
    const empty = tmp("empty");
    assert.deepEqual(await firstStart({ home: empty, keys: null }), { copied: [], keys: [] });
    assert.ok(existsSync(join(empty, ".config", "kiko-dev", FIRST_START_MARK)));
  });

  test("the keys couldn't be copied: said, with how to add one; the settings still are", async () => {
    const { home } = before();
    const done = await firstStart({
      home,
      keys: {
        copyFrom: async () => {
          throw new Error("you said no");
        },
      },
    });
    assert.equal(done?.keysError, "you said no");
    assert.match(firstStartWords(done, RELEASE, DEV_NAMES) ?? "", /weren't copied \(you said no\); kiko-dev keys set <name>/);
  });
});

describe("only one at a time: the other flavour running", () => {
  const home = tmp("other");
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  after(() => sleeper.kill());
  /** The other one's lock in `home`, held by `pid` (started when it did). */
  async function lock(names: typeof RELEASE, pid: number) {
    const dir = join(home, ".config", names.configFolder, "run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.lock"), `${pid}\n${(await startedAt(pid)) ?? ""}\n`);
  }

  test("its lock held by a live app, or something answering on its socket: running; a lock left by one that's gone: not", async () => {
    const quiet = { ...RELEASE, socket: join(home, "release.sock") };
    assert.equal(await otherRunning(quiet, home), false, "nothing there");
    await lock(RELEASE, sleeper.pid!);
    assert.equal(await otherRunning(quiet, home), true);
    writeFileSync(join(home, ".config", "kiko", "run", "app.lock"), "999999\nMon Jan  1 00:00:00 2024\n");
    assert.equal(await otherRunning(quiet, home), false, "stale");
    const server = createServer().listen(quiet.socket);
    await new Promise((r) => server.once("listening", r));
    assert.equal(await otherRunning(quiet, home), true, "its socket answers");
    server.close();
  });

  test("says which one, plainly", () => {
    assert.match(otherRunningWords(RELEASE), /^Kiko \(the release\) is running; quit it first/);
    assert.match(otherRunningWords(DEV_NAMES), /^Kiko Dev \(the checkout\) is running; quit it first/);
  });

  test("`kiko-dev` refuses while the release runs, and the release (KIKO_FLAVOUR) while Kiko Dev does: nothing started", async () => {
    // Everything in a HOME of its own, which exists before tmux is ever asked (a TMUX_TMPDIR that
    // doesn't exist sends tmux to /tmp, where your servers are); the other one's lock there settles
    // it, so neither /tmp's real sockets nor any tmux server is reached.
    const cli = (flavour: string, h: string) => {
      assert.ok(existsSync(h));
      const run = spawnSync(process.execPath, [join(REPO, "src", "cli.ts")], {
        env: {
          PATH: process.env.PATH,
          HOME: h,
          TERM: "xterm-256color",
          KIKO_FLAVOUR: flavour,
          KIKO_KEYCHAIN: "off",
          KIKO_ENV_FILE: "",
          KIKO_TMUX_SERVER: `fl-${process.pid}`,
          TMUX_TMPDIR: h,
          KIKO_WINDOW_APP: "/usr/bin/false",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ok(!existsSync(join(h, `tmux-${process.getuid!()}`, `fl-${process.pid}`)), "no tmux server started");
      return run;
    };
    const devHome = tmp("cli-dev");
    mkdirSync(join(devHome, ".config", "kiko", "run"), { recursive: true });
    writeFileSync(join(devHome, ".config", "kiko", "run", "app.lock"), `${sleeper.pid}\n${(await startedAt(sleeper.pid!)) ?? ""}\n`);
    const refused = cli("dev", devHome);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /^X kiko-dev: Kiko \(the release\) is running; quit it first/);
    const releaseHome = tmp("cli-release");
    mkdirSync(join(releaseHome, ".config", "kiko-dev", "run"), { recursive: true });
    writeFileSync(join(releaseHome, ".config", "kiko-dev", "run", "app.lock"), `${sleeper.pid}\n${(await startedAt(sleeper.pid!)) ?? ""}\n`);
    const other = cli("release", releaseHome);
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, /^X kiko: Kiko Dev \(the checkout\) is running; quit it first/);
  });
});
