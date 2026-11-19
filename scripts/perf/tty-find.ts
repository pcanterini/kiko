// What the iTerm and Terminal adapters' find() costs on this Mac, apart from their AppleScript
// listing (src/terminals/tty/): the processes they look at, and osascript's own start. Sends nothing
// to iTerm or Terminal (never `tell application` either): their listing is timed by
// tests/live/terminals/iterm-terminal-live.test.ts. Reads only ttys, groups, states and executable
// names: never a process's arguments or environment.
//   node scripts/perf/tty-find.ts [runs=20]
import { execFile } from "node:child_process";
import { cwds, onTtys, runningCheck, ttysOf } from "../../src/terminals/tty/procs.ts";

const runs = Number(process.argv[2] ?? 20);

function ms(start: bigint) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function time(name: string, f: () => Promise<unknown>) {
  const all: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    await f();
    all.push(ms(start));
  }
  all.sort((a, b) => a - b);
  const median = all[Math.floor(all.length / 2)];
  console.log(`${name.padEnd(48)} median ${median.toFixed(1)} ms  (${all[0].toFixed(1)}–${all.at(-1)!.toFixed(1)})`);
}

// Some ttys and the processes on them, as a find would have them: every tty in use, at most 10.
const all = await new Promise<string>((resolve) => execFile("ps", ["-A", "-o", "pid=,tty="], (_e, out) => resolve(String(out))));
const rows = all
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((f) => /^ttys\d+$/.test(f[1] ?? ""));
const ttys = [...new Set(rows.map((r) => `/dev/${r[1]}`))].slice(0, 10);
const pids = rows.slice(0, 10).map((r) => Number(r[0]));
console.log(`${ttys.length} ttys, ${pids.length} pids, ${runs} runs each`);

await time("pgrep -xq (whether an app runs)", () => runningCheck("iTerm2", 0)());
await time(`ps -o pid=,tty= -p (${pids.length} sessions' ttys)`, () => ttysOf(pids));
await time(`ps -t (what runs on ${ttys.length} ttys)`, () => onTtys(ttys));
await time("lsof -a -d cwd (2 fronts' folders)", () => cwds(pids.slice(0, 2)));
await time("osascript, a script telling no app", () => new Promise((resolve) => execFile("osascript", ["-e", 'on run argv\nreturn ""\nend run'], resolve)));
