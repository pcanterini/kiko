// Whether a process still runs. Imports nothing, so anything can use it (the hooks keep their own:
// hooks/codex-hook.mjs runs on its own).

/** Whether process `pid` still runs (signal 0: nothing is sent); one we may not signal (another user's) counts. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
