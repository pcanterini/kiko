// Long words into a terminal, for real: each adapter that writes to one (Rex and tmux; iTerm,
// Terminal and Ghostty only through their apps' own windows, which a test would put on your screen),
// against a throwaway server of its own, a program in raw mode there logging every read it gets,
// exactly. 2026-11-21: a 1158-character dictation typed into Claude Code in Rex came in as its last
// 136 characters. A program reads its terminal 1022 bytes at a time (so 1158 came as 1022 and 136),
// and Claude Code 2.1.327 kept only the second read of words typed; as one bracketed paste it kept
// all of them (src/terminals/paste.ts). Here: 1100, 2000 and 5000 characters arrive whole, as one
// bracketed paste whatever reads they come in, then Enter on its own; and a short line typed.
//
// Rex: a server of this test's own (`rex server run` on a socket in the test's temp folder, no saved
// sessions, an empty config), which KIKO_REX_SOCKET points every rex command at; killed by its own
// process at the end. Your Rex is never reached (REX_SERVER and the rest dropped). tmux: a throwaway
// server (tests/support/tmux-servers.ts), its socket in the test's temp folder. Each skipped when
// its program isn't installed.
import "../../setup.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Place, Terminal } from "../../../src/terminals/types.ts";
import { valueWaits } from "../../support/until.ts";

const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR!, "lp-")));
const until = valueWaits(5000, 25);

/** A program that asks for bracketed paste, goes raw, and logs every read as it came (its length, its bytes). */
const LOGGER = join(dir, "reads.mjs");
writeFileSync(
  LOGGER,
  `import { appendFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?2004hready\\r\\n");
process.stdin.on("data", (b) => appendFileSync(process.argv[2], JSON.stringify(b.toString("latin1")) + "\\n"));
`,
);
const reads = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string)
    : [];

/** About `n` characters of made-up words, ending in a mark. */
const words = (n: number) => {
  let s = "";
  for (let i = 0; s.length < n; i++) s += `w${i} lorem ipsum dolor `;
  return `${s.slice(0, n - 1)}Z`;
};

/** What a program got for `text` typed in and sent: everything it read, which must be the words as one paste, then Enter. */
async function typeAndRead(terminal: Terminal, place: Place, file: string, text: string): Promise<string> {
  writeFileSync(file, "");
  assert.deepEqual(await terminal.type(place, text), { sent: true });
  return (await until(
    () => Promise.resolve(reads(file).join("")),
    (got) => got.endsWith("\r"),
    "the words and Enter",
  ))!;
}

function checks(name: string, start: () => Promise<{ terminal: Terminal; place: Place; file: string }>) {
  let t: { terminal: Terminal; place: Place; file: string };
  before(async () => {
    t = await start();
  });
  for (const n of [1100, 2000, 5000]) {
    test(`${name}: ${n} characters on one line arrive whole, as one bracketed paste, then Enter`, async () => {
      const text = words(n);
      const got = await typeAndRead(t.terminal, t.place, t.file, text);
      assert.equal(got, `\u001b[200~${text}\u001b[201~\r`);
      // In pieces of at most 1022 bytes, as the terminal hands them over: why it's pasted.
      assert.ok(reads(t.file).length >= 2, "more than one read");
    });
  }
  test(`${name}: a short line is typed, not pasted`, async () => {
    const got = await typeAndRead(t.terminal, t.place, t.file, "fix the upload bug");
    assert.equal(got, "fix the upload bug\r");
  });
}

// ── Rex ──

const { rexPath } = await import("../../../src/terminals/rex/rex.ts");
const REX = rexPath();

describe("long words into Rex, a throwaway server's block", { skip: !REX && "rex isn't installed" }, () => {
  let server: ChildProcess | null = null;
  const socket = join(dir, "rex.sock");
  const file = join(dir, "rex.reads");
  after(() => {
    server?.kill("SIGTERM");
  });
  checks("Rex", async () => {
    assert.ok(socket.startsWith(dir), "the test's own socket");
    writeFileSync(join(dir, "init.lua"), "");
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("REX_")) delete env[name];
    server = spawn(REX!, ["server", "run", "--listen", socket, "--state-dir", join(dir, "rex-state"), "--restore=false", "--config", join(dir, "init.lua")], { env, stdio: "ignore" });
    process.env.KIKO_REX_SOCKET = socket;
    const { parseCreated, rexRunning, runRex, script, INSPECT, parseInspect } = await import("../../../src/terminals/rex/rex.ts");
    const { rex } = await import("../../../src/terminals/rex/index.ts");
    await until(
      () => Promise.resolve(rexRunning(socket)),
      (up) => up,
      "the throwaway Rex server",
    );
    // Its only session: nothing of yours is on it.
    assert.match(await runRex(["ls", "--json"]), /"sessions": \[\]/);
    const block = parseCreated(await runRex(["new", "long-paste", "-c", dir, "--shell=none", "--json", "--", process.execPath, LOGGER, file]))!;
    const ready = await until(
      () => script(INSPECT, { block }).then(parseInspect),
      (b) => Boolean(b?.paste && b.pid),
      "the logger in front, bracketed paste on",
    );
    return { terminal: rex, place: { via: "rex", id: block, keys: true, pid: ready!.pid! }, file };
  });
});

// ── tmux ──

const { processes, tmuxPath, tmuxRunner, cleanEnv } = await import("../../../src/terminals/tmux/tmux.ts");
const { tmuxTerminal } = await import("../../../src/terminals/tmux/index.ts");
const { killServers, throwawayServer } = await import("../../support/tmux-servers.ts");

describe("long words into tmux, a throwaway server's pane", { skip: !tmuxPath() && "tmux isn't installed" }, () => {
  const SERVER = throwawayServer("long-paste");
  const file = join(dir, "tmux.reads");
  after(() => killServers());
  checks("tmux", async () => {
    assert.ok(process.env.TMUX_TMPDIR?.startsWith(process.env.TMPDIR!), "its socket in the test's own folder");
    const tmux = tmuxRunner(SERVER, "/dev/null", cleanEnv());
    const terminal = tmuxTerminal({ tmux, ps: processes, show: async () => {}, wait: (ms) => new Promise((r) => setTimeout(r, ms)), installed: () => true, shell: "/bin/sh" });
    await tmux(["new-session", "-d", "-s", "lp", "-x", "120", "-y", "30", "--", process.execPath, LOGGER, file]);
    const [, pid] = (
      await until(
        () => tmux(["list-panes", "-t", "=lp", "-F", "#{pane_id} #{pane_pid} #{bracket_paste_flag}"]),
        (out) => out.trim().endsWith(" 1"),
        "the logger asking for bracketed paste",
      )
    )!
      .trim()
      .split(" ");
    const found = await terminal.find(Promise.resolve([{ sessionId: "lp", cwd: dir, kind: "interactive" as const, desktop: false, titles: [], pid: Number(pid) }]));
    const place = found.get("lp")?.place;
    assert.ok(place, "found by its process");
    return { terminal, place, file };
  });
});
