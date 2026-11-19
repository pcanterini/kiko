// The speaker's helper started again (src/platform/macos/speaker.ts), with stand-in helpers (a Node script that says "ready", or exits first), so no sound device
// and no Swift: a helper that can't be started fails its start, never an uncaught error; one that
// died is started again a few times, a longer wait each (startAgain), then said once and left; and
// with no helper at all, the backstop still gives the idle a write is owed, so the floor goes on.
// The real helper's own behaviour is player.test.ts's.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { after, test } from "node:test";
import { Speaker } from "../../../../src/platform/macos/speaker.ts";
import { checkWaits } from "../../../support/until.ts";

const until = checkWaits(5000, 10);

// "ready": says so, and keeps going until its stdin ends; "never-ready": exits at once.
const STAND_IN = `
if (process.env.STAND_IN === "never-ready") process.exit(3);
console.log("ready");
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
`;
const started: ChildProcess[] = [];
after(() => started.forEach((p) => p.kill()));
/** Each start of the helper gets the next of `modes` (the last one for the rest). */
function standIns(modes: string[]) {
  let n = 0;
  const spawns = () => {
    const mode = modes[Math.min(n++, modes.length - 1)];
    const proc = spawn(process.execPath, ["-e", STAND_IN], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, STAND_IN: mode } });
    started.push(proc);
    return proc;
  };
  return { spawns, count: () => n };
}

const logged = (event: string) =>
  readdirSync("logs")
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(`logs/${f}`, "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === event);

/** console.error's lines while `f` runs. */
async function quiet<T>(f: (errors: string[]) => Promise<T>) {
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    return await f(errors);
  } finally {
    console.error = realError;
  }
}

test("a helper that can't be started: its start fails, never an uncaught error", async () => {
  const thrown: unknown[] = [];
  const onThrow = (err: unknown) => thrown.push(err);
  process.on("uncaughtException", onThrow);
  try {
    const s = new Speaker({ spawn: () => spawn("/nonexistent/kiko-player", [], { stdio: ["pipe", "pipe", "ignore"] }) });
    await assert.rejects(s.start(), /ENOENT/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(thrown, []);
    s.shutdown();
  } finally {
    process.off("uncaughtException", onThrow);
  }
});

test("died, then every start fails: tried a few times, said once; a write after still gets its idle", async () => {
  const helpers = standIns(["ready", "never-ready"]);
  const s = new Speaker({ spawn: helpers.spawns, againMs: [10, 20, 40], backstopMs: 50 });
  let idles = 0;
  s.onIdle = () => idles++;
  await s.start();
  await quiet(async (errors) => {
    (s as any).proc.kill("SIGKILL");
    await until(() => logged("speaker_restart_failed").length === 1, "given up on");
    assert.equal(helpers.count(), 4, "the first, then three tries");
    assert.equal(logged("speaker_restart_failed")[0].tries, 3);
    assert.ok(
      errors.some((e) => /didn't come back/.test(e)),
      errors.join("\n"),
    );
  });
  // No helper now: the write's idle comes from the backstop all the same.
  s.write(Buffer.alloc(480));
  await until(() => idles === 1, "the idle owed");
  s.shutdown();
});

test("died, and the next start works: started again, logged, and what was written meanwhile goes to it", async () => {
  const helpers = standIns(["ready", "never-ready", "ready"]);
  const s = new Speaker({ spawn: helpers.spawns, againMs: [10, 20, 40] });
  await s.start();
  await quiet(async () => {
    const first = (s as any).proc as ChildProcess;
    first.kill("SIGKILL");
    await until(() => (s as any).restarting !== null, "seen dead");
    s.write(Buffer.alloc(480));
    await until(() => logged("speaker_restarted").length === 1, "back");
  });
  assert.equal(logged("speaker_restarted")[0].tries, 2);
  assert.equal((s as any).restarting, null, "what waited went to the new helper");
  assert.notEqual((s as any).proc, null);
  s.shutdown();
});
