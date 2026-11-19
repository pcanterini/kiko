// A Codex session end to end, for real but never the real Codex: a fake Codex TUI (tests/support/
// fake-codex.mjs, through a hard link named `codex` to Node, so ps and tmux say codex) in a throwaway
// tmux server of this test's own, running the real hook (hooks/codex-hook.mjs) to a hooks socket of
// this test's own (the real HookServer, with the Codex adapter's route), with its records, its home
// ($CODEX_HOME) and its rollouts in a temp folder. What's checked: it's listed from its first prompt
// with its process, found in its pane by it, heard and held (its Stop, carried on with a reply),
// its permission allowed and denied through the hook, typed into (as a bracketed paste, which its TUI
// needs), renamed with /rename, interrupted with Escape, closed with /exit, and closed from outside
// with a checked SIGTERM (0.153, whose hooks find its process); as 0.166 (the fake's default), whose
// hooks run in its daemon, it's listed with no process and found in its pane by its program and
// folder; one whose hooks never fire is still found by its pane (Terminal.agentPanes); and a session
// opened without a prompt shows its composer ready (or its trust question, 0.153's or 0.166's, not
// ready) and takes its first message through Terminal.placeIn. Signals go only
// to processes this test started. Skipped when tmux isn't installed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, describe, test } from "node:test";
import type { Held } from "../../../src/agents/types.ts";
import { tmuxTerminal } from "../../../src/terminals/tmux/index.ts";
import { CONFIG, cleanEnv, processes, tmuxPath, tmuxRunner } from "../../../src/terminals/tmux/tmux.ts";
import type { Place } from "../../../src/terminals/types.ts";
import { killServers, throwawayServer } from "../../support/tmux-servers.ts";
import { valueWaits } from "../../support/until.ts";

const TMUX = tmuxPath();
const SERVER = throwawayServer("codex");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cbx-")));
const home = join(dir, "codex-home");
const records = join(dir, "records");
const socket = join(dir, "h.sock");
const log = join(dir, "codex.log");
const project = join(dir, "pixie");
const bin = join(dir, "bin");
const FAKE = fileURLToPath(new URL("../../support/fake-codex.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../../../hooks/codex-hook.mjs", import.meta.url));
// Before the adapter loads: its socket, records and home are this test's.
process.env.KIKO_SOCKET = socket;
process.env.KIKO_CODEX_SESSIONS = records;
process.env.CODEX_HOME = home;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitFor = valueWaits(8000, 30);
/** What `get` gives once `ok` passes on it, never null here: this file only waits for things to be there. */
const until = async <T>(get: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms?: number) => (await waitFor(get, ok, what, ms)) as NonNullable<T>;
const noted = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe("a Codex session, for real (a fake Codex TUI, the real hook, a throwaway tmux)", { skip: !TMUX && "tmux isn't installed" }, () => {
  let tmux: ReturnType<typeof tmuxRunner>;
  let terminal: ReturnType<typeof tmuxTerminal>;
  let codex: typeof import("../../../src/agents/codex/index.ts").codex;
  let daemon: typeof import("../../../src/agents/codex/index.ts").daemon;
  let sessions: typeof import("../../../src/agents/codex/sessions.ts");
  let server: InstanceType<typeof import("../../../src/agents/claude-code/hooks.ts").HookServer>;
  const held: Held[] = [];
  const told: string[] = [];

  before(async () => {
    mkdirSync(project, { recursive: true });
    mkdirSync(bin, { recursive: true });
    // `codex` on the sessions' PATH: a shell script that becomes the link (so the process is "codex"), running the fake.
    const node = join(dir, "node-as", "codex");
    mkdirSync(join(dir, "node-as"), { recursive: true });
    // A hard link where it can be (tmux names a pane's program by its file: a symlink's would be "node", the real Codex's is "codex").
    try {
      linkSync(process.execPath, node);
    } catch {
      symlinkSync(process.execPath, node);
    }
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(node)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
    const conf = join(dir, "tmux.conf");
    copyFileSync(CONFIG, conf);
    writeFileSync(conf, `${readFileSync(conf, "utf8")}\nset -g exit-empty on\n`);
    tmux = tmuxRunner(SERVER, conf, {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      KIKO_SOCKET: socket,
      KIKO_CODEX_SESSIONS: records,
      CODEX_HOME: home,
      FAKE_CODEX_HOOK: `node ${JSON.stringify(HOOK)}`,
      FAKE_CODEX_LOG: log,
      // Its daemon lets a thread go this long after its TUI quits (Codex: 60s), so one case's threads are gone by the next.
      FAKE_CODEX_UNLOAD_MS: "3000",
    });
    terminal = tmuxTerminal({ tmux, ps: processes, show: async () => {}, wait, installed: () => true, shell: "/bin/sh" });
    ({ codex, daemon } = await import("../../../src/agents/codex/index.ts"));
    sessions = await import("../../../src/agents/codex/sessions.ts");
    const { HookServer } = await import("../../../src/agents/claude-code/hooks.ts");
    server = new HookServer();
    codex.onHeld = (h) => held.push(h);
    codex.onPromptSubmitted = (id, prompt) => told.push(`prompt ${id} ${prompt}`);
    codex.onSessionEnded = (id) => told.push(`ended ${id}`);
    codex.onNotice = (line) => told.push(`notice ${line}`);
    await server.start();
  });
  // Each case starts clean: whatever a failed one left running ends with its server.
  afterEach(async () => {
    await tmux(["kill-server"]).catch(() => "");
    rmSync(records, { recursive: true, force: true });
    rmSync(log, { force: true });
    held.length = 0;
  });
  after(() => {
    server?.stop();
    killServers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Codex opened by the tmux adapter, as Kiko opens a session: its pane. */
  async function open(args: string[], env: Record<string, string> = {}, folder = project): Promise<string> {
    let pane = "";
    // The server up first (a session that only waits), so the case's variables can be set on it for the next session.
    await tmux(["new-session", "-d", "-s", "keep", "--", "/bin/sh", "-c", "sleep 600"]).catch(() => "");
    for (const [k, v] of Object.entries(env)) await tmux(["set-environment", "-g", k, v]);
    await terminal.open!(folder, { program: "codex", args }, (h) => (pane = h));
    for (const k of Object.keys(env)) await tmux(["set-environment", "-gu", k]).catch(() => "");
    assert.match(pane, /^%\d+$/);
    return pane;
  }
  const listed = () => sessions.listSessions(records);
  const placeOf = async (sessionId: string): Promise<Place> => {
    const list = await listed();
    const found = await terminal.find(Promise.resolve(list));
    const place = found.get(sessionId)?.place;
    assert.ok(place, `${sessionId} found in its pane by its process`);
    return place;
  };

  test("0.153: listed from its first prompt, with its process, found in its pane; heard, and carried on with a reply", async () => {
    await open(["fix the login bug"], { FAKE_CODEX_VERSION: "0.153.0" });
    const [s] = await until(listed, (l) => l.length === 1, "it to be listed");
    const pid = Number(
      noted()
        .find((l) => l.startsWith("pid "))!
        .slice(4),
    );
    assert.equal(s.pid, pid, "the fake Codex's own process, found above its hook");
    assert.equal(s.agent, "codex");
    assert.equal(s.name, "pixie");
    assert.equal(s.cwd, project);
    await until(
      () => told,
      (t) => t.includes(`prompt ${s.sessionId} fix the login bug`),
      "its UserPromptSubmit told",
    );
    const place = await placeOf(s.sessionId);
    assert.equal(place.via, "tmux");
    // Its Stop, held: what it said, and its prompt from its rollout.
    const stop = await until(() => held.find((h) => !h.isPermission && h.open), Boolean, "its Stop to be held");
    assert.equal(stop.text, "Done: fix the login bug");
    assert.equal(stop.lastAsked(), "fix the login bug");
    assert.deepEqual(stop.saidThisTurn(), ["fix the login bug"]);
    assert.equal(stop.answer("and the tests too"), true);
    await until(noted, (l) => l.some((x) => x.startsWith("stop block ") && x.endsWith("and the tests too")), "the turn carried on with the reply");
    const again = await until(() => held.find((h) => h !== stop && !h.isPermission && h.open), Boolean, "the next Stop");
    assert.equal(again.continued, true, "stop_hook_active");
    assert.deepEqual(again.saidThisTurn(), ["fix the login bug", "and the tests too"], "the reply is in the same turn");
    assert.equal(codex.lastSaid(s), "Done: and the tests too");
    again.release();
    await until(noted, (l) => l.includes("stop done"), "it to stop");
    assert.equal((await listed())[0].status, "idle");

    // Typed into at any moment: a bracketed paste, then Enter, which its TUI sends.
    const typed = await terminal.type({ ...place, bracketed: true }, "now the docs");
    assert.deepEqual(typed, { sent: true });
    await until(noted, (l) => l.includes("submit now the docs"), "its next prompt");
    assert.ok(!noted().includes("enter as newline"));
    const third = await until(() => held.find((h) => h.open && h.text === "Done: now the docs"), Boolean, "its Stop");
    third.release();

    // Renamed with /rename: the name it's listed by.
    assert.deepEqual(await terminal.type({ ...place, bracketed: true }, "/rename Login fix"), { sent: true });
    await until(
      async () => (await listed())[0]?.givenName,
      (n) => n === "Login fix",
      "its new name",
    );
    assert.equal(codex.names(s).givenName, "Login fix");

    // The phone's history: its rollout as a transcript, folded as Claude Code's is.
    let latest: any = { items: [] };
    const watching = codex.watchHistory(s, (h) => (latest = h));
    const history = await until(
      () => latest,
      (h) => h.items.length >= 4,
      "its history",
    );
    watching.stop();
    assert.deepEqual(
      history.items.slice(0, 4).map((i: any) => [i.kind, i.text]),
      [
        ["you", "fix the login bug"],
        ["claude", "Done: fix the login bug"],
        ["you", "and the tests too"],
        ["claude", "Done: and the tests too"],
      ],
    );

    // Interrupted with Escape mid-turn.
    assert.deepEqual(await terminal.type({ ...place, bracketed: true }, "a long one, slowly"), { sent: true });
    await until(
      async () => (await listed())[0]?.status,
      (st) => st === "busy",
      "it to be busy",
    );
    assert.deepEqual(await terminal.key!(place, codex.interruptKey), { sent: true });
    await until(noted, (l) => l.includes("interrupted"), "the turn interrupted");
    await until(
      async () => (await listed())[0]?.status,
      (st) => st === "idle",
      "it idle after the Interrupt hook",
    );

    // Closed with /exit (in Kiko's tmux): SessionEnd told, its record gone, no longer listed.
    assert.deepEqual(await terminal.type({ ...place, bracketed: true }, codex.exitCommand), { sent: true });
    await until(
      () => told,
      (t) => t.includes(`ended ${s.sessionId}`),
      "its SessionEnd",
    );
    await until(listed, (l) => l.length === 0, "it to leave the list");
  });

  test("its permission prompt held, allowed and denied through the hook", async () => {
    await open(["deploy"], { FAKE_CODEX_ASK: "npm run deploy", FAKE_CODEX_WORK_MS: "50" });
    const ask = await until(() => held.find((h) => h.isPermission && h.open), Boolean, "its PermissionRequest");
    assert.deepEqual(ask.tool, { name: "Bash", input: { command: "npm run deploy" } });
    assert.equal(ask.canAllowAlways, false, "Codex's hooks have no 'always'");
    assert.equal(ask.questions, null);
    assert.equal(ask.allow(false), true);
    await until(noted, (l) => l.includes("permission allow"), "it allowed");
    const stop = await until(() => held.find((h) => !h.isPermission && h.open && h.text === "Done: deploy"), Boolean, "its Stop");
    stop.answer("deploy again");
    // A reply carries the turn on without asking again (FAKE_CODEX_ASK is for prompts only); a new prompt asks.
    const next = await until(() => held.find((h) => !h.isPermission && h.open && h.text === "Done: deploy again"), Boolean, "the carried-on Stop");
    next.release();
    const [s] = await until(listed, (l) => l.length === 1, "it listed");
    const place = await placeOf(s.sessionId);
    await terminal.type({ ...place, bracketed: true }, "deploy to prod");
    const second = await until(() => held.find((h) => h.isPermission && h.open), Boolean, "its next PermissionRequest");
    assert.equal(second.deny("Not on a Friday."), true);
    await until(noted, (l) => l.includes("permission deny Not on a Friday."), "it denied, with why");
    const last = await until(() => held.find((h) => !h.isPermission && h.open && h.text === "Done: deploy to prod"), Boolean, "its Stop");
    last.release();
    await terminal.type({ ...place, bracketed: true }, "/exit");
    await until(listed, (l) => l.length === 0, "it to end");
  });

  test("closed from outside its tmux (0.153, which knows its process): a SIGTERM after the checks; it's gone, with no SessionEnd", async () => {
    await open(["look around"], { FAKE_CODEX_VERSION: "0.153.0" });
    const [s] = await until(listed, (l) => l.length === 1, "it listed");
    const stop = await until(() => held.find((h) => h.open && h.sessionId === s.sessionId), Boolean, "its Stop");
    stop.release();
    // Its record says another process started then: refused, nothing sent.
    const refused = await sessions.endProcess(s, { ...sessions.reach, dir: records, ps: async (pid, field) => (field === "lstart" ? "Thu Jan  1 00:00:00 1970" : sessions.reach.ps(pid, field)) });
    assert.deepEqual(refused, { sent: false, why: "its process ID belongs to another process now" });
    assert.ok(!noted().includes("SIGTERM"));
    const ended = await sessions.endProcess(s, { ...sessions.reach, dir: records });
    assert.deepEqual(ended, { sent: true, pids: [s.pid] });
    await until(noted, (l) => l.includes("SIGTERM"), "the SIGTERM");
    await until(listed, (l) => l.length === 0, "it to leave the list (its process gone)");
    assert.ok(!told.includes(`ended ${s.sessionId}`), "no SessionEnd: Codex has no handler for SIGTERM");
  });

  test("0.166: its hooks run in its daemon, so it's listed with no process; found in its pane by its program and folder, heard, typed into", async () => {
    const pane = await open(["fix the login bug"]);
    const [s] = await until(listed, (l) => l.length === 1, "it to be listed");
    assert.equal(s.pid, undefined, "no terminal above its hooks: no process for the hook to find");
    assert.equal(s.program, "codex");
    assert.equal(s.cwd, project);
    const found = (await terminal.find(Promise.resolve(await listed()))).get(s.sessionId);
    assert.equal(found?.place?.id, pane, "the only pane in its folder running codex");
    assert.equal(found?.mapping, "only");
    // Two Codex panes in one folder: by the pane it was opened in (Findable.pane), else none.
    const other = await open([]);
    await until(
      () => terminal.screen!(other),
      (sc) => Boolean(sc?.includes("Ask Codex to do anything")),
      "the other's composer",
    );
    const both = await terminal.find(Promise.resolve(await listed()));
    assert.equal(both.get(s.sessionId)?.place, null, "can't tell which pane");
    const hinted = await terminal.find(Promise.resolve((await listed()).map((x) => ({ ...x, pane }))));
    assert.equal(hinted.get(s.sessionId)?.place?.id, pane, "its own pane, by the hint");
    await tmux(["kill-pane", "-t", other]).catch(() => "");
    const stop = await until(() => held.find((h) => !h.isPermission && h.open), Boolean, "its Stop to be held");
    assert.equal(stop.text, "Done: fix the login bug");
    stop.release();
    await until(noted, (l) => l.includes("stop done"), "it to stop");
    const place = found!.place!;
    assert.deepEqual(await terminal.type({ ...place, bracketed: true }, "now the docs"), { sent: true });
    await until(noted, (l) => l.includes("submit now the docs"), "its next prompt");
    (await until(() => held.find((h) => h.open && h.text === "Done: now the docs"), Boolean, "its Stop")).release();
    assert.deepEqual(await terminal.type({ ...place, bracketed: true }, codex.exitCommand), { sent: true });
    await until(
      () => told,
      (t) => t.includes(`ended ${s.sessionId}`),
      "its SessionEnd, from the daemon",
    );
  });

  test("hooks that never fire (not set up, or not trusted): Codex's own list stays empty, but its pane runs codex for Kiko to list it from", async () => {
    const pane = await open(["hello"], { FAKE_CODEX_HOOK: "" });
    await until(noted, (l) => l.includes("stop done"), "its turn");
    assert.ok(!noted().some((l) => l.startsWith("hook ")), "no hook ran");
    assert.equal((await listed()).length, 0, "no hook, no record: nothing listed by Codex's records");
    const panes = await terminal.agentPanes!((command) => codex.runsAs!(command));
    assert.deepEqual(
      panes.map((p) => [p.handle, p.cwd]),
      [[pane, project]],
      "found by what runs in it",
    );
    assert.ok(await terminal.placeIn!(pane), "and reachable by its pane");
  });

  test("opened without a prompt: its composer shows it ready (its trust question doesn't), and its first message goes in by its pane", async () => {
    for (const [version, says] of [
      ["0.166.0", "Trust this folder?"],
      ["0.153.0", "Do you trust the contents"],
    ]) {
      const asking = await open([], { FAKE_CODEX_TRUST: "1", FAKE_CODEX_VERSION: version });
      const trustScreen = await until(
        () => terminal.screen!(asking),
        (sc) => Boolean(sc?.includes(says)),
        `its trust question (${version})`,
      );
      assert.equal(codex.readyOnScreen!(trustScreen!), false, "nothing is typed into its trust question");
      await tmux(["kill-pane", "-t", asking]).catch(() => "");
    }

    const pane = await open([]);
    const screen = await until(
      () => terminal.screen!(pane),
      (sc) => Boolean(sc?.includes("Ask Codex to do anything")),
      "its composer",
    );
    assert.equal(codex.readyOnScreen!(screen!), true);
    assert.equal((await listed()).length, 0, "no session before its first message (Codex makes one then)");
    const place = await terminal.placeIn!(pane);
    assert.ok(place?.pid, "its program in front of its pane");
    assert.deepEqual(await terminal.type({ ...place!, bracketed: true }, "hello there"), { sent: true });
    const [s] = await until(listed, (l) => l.length === 1, "it listed from that message");
    assert.equal((await placeOf(s.sessionId)).id, pane, "the same pane");
    const stop = await until(() => held.find((h) => h.open && h.sessionId === s.sessionId), Boolean, "its Stop");
    assert.equal(stop.text, "Done: hello there");
    stop.release();
    await terminal.type({ ...place!, bracketed: true }, "/exit");
    await until(listed, (l) => l.length === 0, "it to end");
  });

  test("0.166: listed from Codex's daemon as soon as it's open, no turn needed; renamed both ways, interrupted through it, gone as it quits", async () => {
    await codex.start();
    // A folder of its own: threads of the cases before, in pixie, may still be loaded in its daemon for a moment.
    const cedar = join(dir, "cedar");
    mkdirSync(cedar, { recursive: true });
    const mine = async () => (await codex.list()).filter((x) => x.cwd === cedar);
    try {
      const pane = await open([], {}, cedar);
      await until(
        () => terminal.screen!(pane),
        (sc) => Boolean(sc?.includes("Ask Codex to do anything")),
        "its composer",
      );
      await until(noted, (l) => l.includes("thread started"), "its thread opened in its daemon");
      assert.equal((await listed()).length, 0, "nothing from the hook's records: no turn, no hook yet");
      const [s] = await until(
        () => mine(),
        (l) => l.length === 1,
        "listed from its daemon",
      );
      assert.equal(
        s.sessionId,
        noted()
          .find((l) => l.startsWith("session "))!
          .slice("session ".length),
        "its thread's ID, as its hooks will say it",
      );
      assert.equal(s.cwd, cedar);
      assert.equal(s.status, "idle");
      assert.equal(s.pid, undefined);
      assert.equal(s.program, "codex");
      const found = (await terminal.find(Promise.resolve([s]))).get(s.sessionId);
      assert.equal(found?.place?.id, pane, "found in its pane by its program and folder");
      const place = found!.place!;
      assert.deepEqual(codex.can!(s), { close: false, rename: true, interrupt: true });

      // Renamed from Kiko through its daemon: nothing typed; Codex is told, and it's listed by it.
      assert.deepEqual(await codex.rename!(s, "Docs pass"), { done: true });
      await until(noted, (l) => l.includes("named Docs pass"), "Codex told its new name");
      assert.equal((await mine())[0].givenName, "Docs pass");
      assert.ok(!noted().some((l) => l.startsWith("submit ")), "nothing typed into it");

      // /rename in Codex: told at once (listed again), and listed by it.
      let changed = 0;
      codex.onSessionsChanged = () => changed++;
      assert.deepEqual(await terminal.type({ ...place, bracketed: true }, "/rename Login fix"), { sent: true });
      await until(
        () => changed,
        (n) => n > 0,
        "told of the rename",
      );
      assert.equal((await mine())[0].givenName, "Login fix");
      assert.equal(codex.names(s).givenName, "Login fix");

      // A turn: its hooks keep a record too, and it's still one session; interrupted through its daemon.
      assert.deepEqual(await terminal.type({ ...place, bracketed: true }, "a long one, slowly"), { sent: true });
      await until(listed, (l) => l.length === 1, "its hook's record");
      const busy = await until(
        () => mine(),
        (l) => l[0]?.status === "busy",
        "it busy",
      );
      assert.equal(busy.length, 1, "one row for its record and its thread");
      assert.deepEqual(await codex.interrupt!(s), { done: true });
      await until(noted, (l) => l.includes("interrupted"), "its turn interrupted");
      await until(
        () => mine(),
        (l) => l[0]?.status === "idle",
        "it idle",
      );
      assert.deepEqual(await codex.interrupt!(s), { done: false, why: "it isn't running anything" });

      // Quit: gone from the list at once, though its daemon keeps the thread a while.
      assert.deepEqual(await terminal.type({ ...place, bracketed: true }, codex.exitCommand), { sent: true });
      await until(
        () => mine(),
        (l) => l.length === 0,
        "it to leave the list",
      );
      assert.ok(
        (await daemon.loaded())?.some((t) => t.id === s.sessionId),
        "still loaded in Codex's daemon, which lets it go later",
      );
    } finally {
      codex.onSessionsChanged = () => {};
      codex.stop();
    }
  });
});
