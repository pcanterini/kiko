// Closing a session gracefully (src/core/close.ts), without tmux: the order of its steps (Escape when
// it's mid-turn, then /exit, then a wait for it to end, then the tidy-up), the fall back to killing
// it (with why), how its end is noticed (its SessionEnd hook, its process, its pane's program), and
// what the window says after (src/ui/window-glue.ts closedNote). The real thing, with tmux and a fake
// Claude Code: tests/live/terminals/close-live.test.ts. A session outside Kiko's tmux, ended by its
// agent where it runs (endFromOutside): refused, ended and watched, or still running; for real with a
// fake Claude Code: tests/live/terminals/close-outside-live.test.ts.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { closeGracefully, closeSteps, endedSince, endFromOutside, endSteps, sessionEnded, type CloseSteps, type EndSteps, type Tidied } from "../../../src/core/close.ts";
import type { Place, Typed } from "../../../src/terminals/types.ts";
import { closedNote, endedNote } from "../../../src/ui/window-glue.ts";

const TIMES = { settleMs: 300, endMs: 2000, everyMs: 100 };
const SENT: Typed = { sent: true };

/** Fake steps on a fake clock: what was done, in order; `endsAfter` ms after /exit it has ended (null: never). */
function fake(over: Partial<CloseSteps> & { endsAfter?: number | null } = {}) {
  const done: string[] = [];
  let t = 0;
  let exitAt: number | null = null;
  const endsAfter = over.endsAfter === undefined ? 200 : over.endsAfter;
  const steps: CloseSteps = {
    sessionId: "lacy-id",
    busy: false,
    refuse: null,
    interrupt: async () => (done.push("escape"), SENT),
    exit: async () => (done.push("/exit"), (exitAt = t), SENT),
    ended: async () => (exitAt !== null && endsAfter !== null && t - exitAt >= endsAfter ? "hook" : null),
    tidy: async (): Promise<Tidied> => (done.push("tidy"), "closed"),
    wait: async (ms) => void (done.push(`wait ${ms}`), (t += ms)),
    now: () => t,
    ...over,
  };
  return { steps, done };
}

describe("closing a session", () => {
  test("idle: /exit, a wait for it to end, then tidied (its pane home, its tmux session closed)", async () => {
    const { steps, done } = fake();
    const closed = await closeGracefully(steps, TIMES);
    assert.deepEqual(done, ["/exit", "wait 100", "wait 100", "tidy"]);
    assert.deepEqual(closed, { how: "exit", interrupted: false, tidied: "closed", ms: 200 });
  });

  test("mid-turn: Escape first, a moment for it to stop, then /exit", async () => {
    const { steps, done } = fake({ busy: true, endsAfter: 0 });
    const closed = await closeGracefully(steps, TIMES);
    assert.deepEqual(done, ["escape", "wait 300", "/exit", "tidy"]);
    assert.equal(closed.how, "exit");
    assert.equal(closed.interrupted, true);
  });

  test("it doesn't end in time: killed, and why", async () => {
    const { steps, done } = fake({ endsAfter: null });
    const closed = await closeGracefully(steps, TIMES);
    assert.equal(closed.how, "killed");
    assert.match(closed.why!, /hadn't ended 2 seconds after \/exit/);
    assert.equal(done.at(-1), "tidy");
    assert.equal(closed.ms, 2000);
  });

  test("/exit not typed (the checks failed): nothing more typed, killed at once, and why", async () => {
    const { steps, done } = fake({ exit: async () => ({ sent: false, why: "something else is in front of it in its pane" }) });
    const closed = await closeGracefully(steps, TIMES);
    assert.deepEqual(done, ["tidy"]);
    assert.deepEqual([closed.how, closed.why], ["killed", "/exit didn't go in: something else is in front of it in its pane"]);
  });

  test("Escape not taken: no /exit into a turn still going; killed", async () => {
    const { steps, done } = fake({ busy: true, interrupt: async () => ({ sent: false, why: "its tmux pane has closed" }) });
    const closed = await closeGracefully(steps, TIMES);
    assert.deepEqual(done, ["tidy"]);
    assert.equal(closed.why, "Escape didn't go in: its tmux pane has closed");
  });

  test("refused (still starting, at its trust prompt): nothing typed at all; killed", async () => {
    const { steps, done } = fake({ refuse: "it's still starting", busy: true });
    const closed = await closeGracefully(steps, TIMES);
    assert.deepEqual(done, ["tidy"]);
    assert.deepEqual([closed.how, closed.why, closed.interrupted], ["killed", "it's still starting", false]);
  });
});

describe("its end, noticed", () => {
  const place: Place = { via: "tmux", id: "%7", keys: true, pid: 4242 };
  const typedInto: string[] = [];
  const terminal = (program: "running" | "shell" | "gone") => ({
    type: async (p: Place, text: string) => (typedInto.push(`${p.id}:${text}`), SENT),
    key: async (p: Place, key: string) => (typedInto.push(`${p.id}:<${key}>`), SENT),
    program: async () => program,
  });
  const via = (program: "running" | "shell" | "gone", alive = true) => ({
    terminal: terminal(program),
    interruptKey: "escape",
    exitCommand: "/exit",
    tidy: async () => "closed" as const,
    alive: () => alive,
  });

  test("through its own terminal only: Escape and /exit into its place, noted first as the app's own typing", async () => {
    typedInto.length = 0;
    const noted: string[] = [];
    const steps = closeSteps({ sessionId: "s1", ids: ["s1"], place, busy: true }, { ...via("running"), typing: (t) => noted.push(t) });
    await steps.interrupt();
    await steps.exit();
    assert.deepEqual(typedInto, ["%7:<escape>", "%7:/exit"]);
    assert.deepEqual(noted, ["/exit"]);
  });

  test("its SessionEnd hook (any of its IDs), after /exit; one from before doesn't count", async () => {
    sessionEnded("old-face", Date.now() - 10_000);
    const steps = closeSteps({ sessionId: "s2", ids: ["s2", "old-face"], place, busy: false }, via("running"));
    await steps.exit();
    assert.equal(await steps.ended(), null);
    sessionEnded("old-face");
    assert.equal(await steps.ended(), "hook");
    assert.equal(endedSince(["nobody"], 0), false);
  });

  test("its process gone, or its pane's program a shell (claude; exec $SHELL) or gone", async () => {
    assert.equal(await closeSteps({ sessionId: "s3", ids: ["s3"], place, busy: false }, via("running", false)).ended(), "process");
    assert.equal(await closeSteps({ sessionId: "s3", ids: ["s3"], place, busy: false }, via("shell")).ended(), "pane: shell");
    assert.equal(await closeSteps({ sessionId: "s3", ids: ["s3"], place, busy: false }, via("gone")).ended(), "pane: gone");
    assert.equal(await closeSteps({ sessionId: "s3", ids: ["s3"], place, busy: false }, via("running")).ended(), null);
  });

  test("a terminal that takes no keys: refused, never typed into", () => {
    const steps = closeSteps({ sessionId: "s4", ids: ["s4"], place, busy: false }, { ...via("running"), terminal: { type: terminal("running").type } });
    assert.equal(steps.refuse, "its terminal takes no keys");
  });
});

describe("what the window says after", () => {
  test("exited: closed, its conversation saved; killed: said so; gone already: said so", () => {
    assert.equal(closedNote("lacy", { how: "exit", tidied: "closed" }), "Closed lacy. Its conversation is saved.");
    assert.equal(closedNote("lacy", { how: "exit", tidied: "gone" }), "Closed lacy. Its conversation is saved.");
    assert.equal(closedNote("lacy", { how: "killed", why: "it hadn't ended", tidied: "closed" }), "Closed lacy. It didn't exit when asked, so I ended it.");
    assert.equal(closedNote("lacy", { how: "killed", tidied: "closed" }), "Closed lacy.");
    assert.equal(closedNote("lacy", { how: "killed", why: "x", tidied: "gone" }), "lacy had closed already.");
  });
});

describe("closing a session outside Kiko's tmux (its agent ends it where it runs)", () => {
  const OUT = { endMs: 1000, everyMs: 100 };
  /** Fake steps on a fake clock: `goneAfter` ms after it was ended, it has gone (null: never). */
  function outside(over: Partial<EndSteps> & { goneAfter?: number | null } = {}) {
    const done: string[] = [];
    let t = 0;
    let endedAt: number | null = null;
    const goneAfter = over.goneAfter === undefined ? 200 : over.goneAfter;
    const steps: EndSteps = {
      sessionId: "notes-id",
      refuse: null,
      end: async () => (done.push("end"), (endedAt = t), { sent: true, pids: [4242] }),
      ended: async (pids) => (done.push(`look ${pids.join(",")}`), endedAt !== null && goneAfter !== null && t - endedAt >= goneAfter ? "process" : null),
      wait: async (ms) => void (t += ms),
      now: () => t,
      ...over,
    };
    return { steps, done };
  }

  test("ended, then watched until it has gone (its processes, as `end` named them)", async () => {
    const { steps, done } = outside();
    const ended = await endFromOutside(steps, OUT);
    assert.deepEqual(ended, { how: "ended", ms: 200 });
    assert.deepEqual(done, ["end", "look 4242", "look 4242", "look 4242"]);
  });

  test("refused first (the desktop app's): nothing sent", async () => {
    const { steps, done } = outside({ refuse: "it runs in the Claude desktop app" });
    assert.deepEqual(await endFromOutside(steps, OUT), { how: "refused", why: "it runs in the Claude desktop app", ms: 0 });
    assert.deepEqual(done, []);
  });

  test("its agent's checks fail: nothing sent, and why; no wait", async () => {
    const done: string[] = [];
    const { steps } = outside({ end: async () => (done.push("end"), { sent: false, why: "its process ID belongs to another process now" }) });
    const ended = await endFromOutside(steps, OUT);
    assert.deepEqual([ended.how, ended.why], ["refused", "its process ID belongs to another process now"]);
    assert.deepEqual(done, ["end"]);
  });

  test("still running after the wait: said so, never ended harder", async () => {
    const { steps, done } = outside({ goneAfter: null });
    const ended = await endFromOutside(steps, OUT);
    assert.deepEqual([ended.how, ended.why, ended.ms], ["running", "it was still running 1 seconds after", 1000]);
    assert.equal(done.filter((d) => d === "end").length, 1, "ended once");
  });

  test("its end noticed: its SessionEnd hook (any of its IDs, after it was ended), its processes all gone, or a job with no process: stopped", async () => {
    sessionEnded("notes-face", Date.now() - 10_000);
    let alive = new Set([10, 11]);
    const steps = endSteps({ sessionId: "notes-id", ids: ["notes-id", "notes-face"], refuse: null }, { end: async () => ({ sent: true, pids: [10, 11] }), alive: (pid) => alive.has(pid) });
    assert.equal(await steps.ended([10, 11]), null, "a hook from before doesn't count");
    alive = new Set([11]);
    assert.equal(await steps.ended([10, 11]), null, "one still there");
    alive = new Set();
    assert.equal(await steps.ended([10, 11]), "process");
    alive = new Set([10]);
    sessionEnded("notes-face");
    assert.equal(await steps.ended([10]), "hook");
    assert.equal(await endSteps({ sessionId: "job", ids: ["job"], refuse: null }, { end: async () => ({ sent: true, pids: [] }) }).ended([]), "stopped");
  });

  test("what the window says after: closed (its conversation saved), still running, or not closed and why", () => {
    assert.equal(endedNote("notes", { how: "ended" }), "Closed notes. Its conversation is saved.");
    assert.equal(endedNote("notes", { how: "running", why: "it was still running 10 seconds after" }), "I asked notes to end, but it was still running 10 seconds after. Its terminal can close it.");
    assert.equal(endedNote("notes", { how: "refused", why: "it runs in the Claude desktop app" }), "I didn't close notes: it runs in the Claude desktop app.");
  });
});
