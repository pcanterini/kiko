// The Rex adapter against the real Rex server: a throwaway Rex session of its own (`rex new`, which
// Rex lists but doesn't show), running `cat -v` with bracketed paste asked for, so what was typed is
// read back off its screen. It's found by its process, typed into, keyed, read; then that session,
// and only it, is killed by its id. Nothing else is written to, keyed, focused or read beyond the
// listing every find makes (processes and titles). Only when asked (KIKO_REX_LIVE=1: it drives the
// Rex you have running), and skipped when Rex's server isn't running.
import "../../setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { rex } from "../../../src/terminals/rex/index.ts";
import { INSPECT, LIST, parseCreated, parseInspect, parseList, rexPath, rexRunning, runBlock, runRex, script } from "../../../src/terminals/rex/rex.ts";
import type { Findable, Place } from "../../../src/terminals/types.ts";
import { valueWaits } from "../../support/until.ts";

// The unit tests' setup points Rex at no socket; this one is the real server's.
delete process.env.KIKO_REX_SOCKET;
const ASKED = process.env.KIKO_REX_LIVE === "1";
const RUNNING = ASKED && rexRunning() && rexPath() !== null;

const until = valueWaits(5000, 50);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiko-rex-")));
let session = "";
let block = "";
let pid = 0;

const findable = (fields: Partial<Findable> = {}): Findable => ({ sessionId: "live", cwd: dir, kind: "interactive", desktop: false, titles: [], terminal: "rex", ...fields });
const screen = () => rex.screen!(block).then((s) => s ?? "");

describe("Rex, for real", { skip: !RUNNING && (ASKED ? "Rex's server isn't running" : "the real Rex only when asked: KIKO_REX_LIVE=1") }, () => {
  before(async () => {
    const out = await runRex(["new", `kiko-live-${process.pid}`, "-c", dir, "--shell=none", "--json", "--", "/bin/sh", "-c", "printf '\\033[?2004h'; exec cat -v"]);
    const created = JSON.parse(out) as { session_id?: string };
    session = created.session_id ?? "";
    block = parseCreated(out) ?? "";
    assert.match(session, /^session:/);
    assert.match(block, /^block:/);
    // Never the block or session this test runs in.
    assert.notEqual(block, process.env.REX_BLOCK);
    assert.notEqual(session, process.env.REX_SESSION);
    const ready = await until(
      () => script(INSPECT, { block }).then(parseInspect),
      (b) => b?.name === "cat" && b.paste,
      "cat in front, bracketed paste on",
    );
    pid = ready!.pid!;
  });

  after(async () => {
    if (session) await runRex(["kill", session]).catch(() => "");
  });

  test("found by its process, and by the block its hook would say; a process in no block isn't", async () => {
    const at: Place = { via: "rex", id: block, keys: true, pid };
    const found = await rex.find(Promise.resolve([findable({ pid }), findable({ sessionId: "nowhere", pid: 2 ** 22 + 7 })]));
    assert.deepEqual(found.get("live"), { place: at, mapping: "process" });
    assert.equal(found.has("nowhere"), false);
    const hinted = await rex.find(Promise.resolve([findable({ pid, pane: block })]));
    assert.deepEqual(hinted.get("live"), { place: at, mapping: "process" });
    // Two sessions said to be in it (one started inside the other): neither is typed into.
    const two = await rex.find(Promise.resolve([findable({ pid }), findable({ sessionId: "inner", pid, pane: block })]));
    assert.equal(two.get("live")?.mapping, "ambiguous");
  });

  test("found by its program and folder, where its process isn't known (Codex's way)", async () => {
    const found = await rex.find(Promise.resolve([findable({ pid: undefined, program: "cat", terminal: undefined })]));
    assert.deepEqual(found.get("live"), { place: { via: "rex", id: block, keys: true, pid }, mapping: "only" });
  });

  test("one line typed, then Enter: cat gets it", async () => {
    assert.deepEqual(await rex.type({ via: "rex", id: block, keys: true, pid }, "hello from kiko"), { sent: true });
    const shown = await until(screen, (s) => s.split("\n").filter((l) => l === "hello from kiko").length >= 2, "the line echoed, then cat's copy");
    assert.doesNotMatch(shown, /\^\[\[200~hello/, "one line isn't a bracketed paste");
  });

  test("several lines: one bracketed paste", async () => {
    assert.deepEqual(await rex.type({ via: "rex", id: block, keys: true, pid }, "first line\nsecond line"), { sent: true });
    await until(screen, (s) => s.includes("^[[200~first line") && s.includes("second line^[[201~"), "the paste, bracketed");
  });

  test("a session wanting a bracketed paste (Codex): one line as one too", async () => {
    assert.deepEqual(await rex.type({ via: "rex", id: block, keys: true, pid, bracketed: true }, "codex words"), { sent: true });
    await until(screen, (s) => s.includes("^[[200~codex words^[[201~"), "one line, bracketed");
  });

  test("keys: Escape and Shift+Tab as cat sees them; none when the process isn't the one in front", async () => {
    assert.deepEqual(await rex.key!({ via: "rex", id: block, keys: true, pid }, "escape"), { sent: true });
    assert.deepEqual(await rex.key!({ via: "rex", id: block, keys: true, pid }, "shift+tab"), { sent: true });
    assert.deepEqual(await rex.key!({ via: "rex", id: block, keys: true, pid }, "enter"), { sent: true });
    await until(screen, (s) => s.includes("^[^[[Z"), "Escape then Shift+Tab");
    const before = await screen();
    const moved = await rex.key!({ via: "rex", id: block, keys: true, pid: pid + 100_000 }, "escape");
    assert.deepEqual(moved, { sent: false, why: "it isn't running in that Rex pane any more" });
    const typed = await rex.type({ via: "rex", id: block, keys: true, pid: pid + 100_000 }, "never this");
    assert.equal(typed.sent, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await screen(), before, "nothing went in");
  });

  test("a block it opened: program, placeIn, press", async () => {
    assert.equal(await rex.program!(block), "running");
    assert.deepEqual(await rex.placeIn!(block), { via: "rex", id: block, keys: true, pid });
    assert.deepEqual(await rex.press!(block, "down"), { sent: true });
    await until(screen, (s) => s.includes("^[[B") || s.includes("^[OB"), "Down");
  });

  test("a new tab in its own session (`rex run`): its block, shell left after its command", async () => {
    const opened = await runBlock(session, dir, ["/bin/sh", "-c", "echo opened-here; exec /bin/sh"]);
    assert.match(opened, /^block:/);
    await until(
      () => rex.screen!(opened).then((s) => s ?? ""),
      (s) => s.includes("opened-here"),
      "its command's output",
    );
    assert.equal(
      await until(
        () => rex.program!(opened),
        (p) => p === "shell",
        "the shell after it",
      ),
      "shell",
    );
  });

  test("how long a find takes (one `rex do` for every block)", async (t) => {
    const blocks = parseList(await script(LIST)).length;
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await rex.find(Promise.resolve([findable({ pid })]));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[10];
    t.diagnostic(`find over ${blocks} blocks: median ${median.toFixed(1)} ms, fastest ${times[0].toFixed(1)} ms, slowest ${times[19].toFixed(1)} ms`);
    assert.ok(median < 500, `median ${median} ms`);
  });
});
