// Quick tasks without `claude -p`: T.quick is the run in progress; T.quick.resolve(result) ends it.
// T.realQuick: the real run instead (src/core/quick-task.ts), with tests/support/fake-claude.mjs as
// `claude`, which asks through the real permission server (hooks/quick-permission.mjs): never Claude.
import { spawn } from "node:child_process";
import { runQuickTask as realRun, type Spawn } from "../../../../src/core/quick-task.ts";
export const allowedTools = () => ["Read", "Grep", "Glob", "Bash(df)", "Bash(df *)"];
export type Running = { result: Promise<any>; cancel: () => void; pause: () => () => void };
const FAKE_CLAUDE = new URL("../../../support/fake-claude.mjs", import.meta.url).pathname;
const fakeClaude = ((_cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => spawn(process.execPath, [FAKE_CLAUDE, ...args], options)) as Spawn;
export function runQuickTask(options: any) {
  const T = (globalThis as any).T;
  if (T.realQuick) {
    const real: any = realRun(options, fakeClaude);
    const run: any = { options, real: true, cancelled: false, result: real.result, pauses: 0 };
    run.cancel = () => ((run.cancelled = true), real.cancel());
    run.pause = () => (run.pauses++, real.pause());
    T.quick = run;
    T.quickRuns = [...(T.quickRuns ?? []), run];
    return run;
  }
  let resolve: (r: any) => void = () => {};
  const result = new Promise((r) => (resolve = r));
  const run: any = { options, cancelled: false, result, resolve: (r: any) => resolve(r), pauses: 0 };
  run.cancel = () => {
    run.cancelled = true;
    resolve({ outcome: "cancelled", text: "cancelled", durationMs: 1, costUsd: null, numTurns: null, denied: [], subtype: null });
  };
  run.pause = () => {
    run.pauses++;
    return () => {};
  };
  T.quick = run;
  T.quickRuns = [...(T.quickRuns ?? []), run];
  return run;
}
