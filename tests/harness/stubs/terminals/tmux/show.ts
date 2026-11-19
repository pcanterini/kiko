// No windows on the screen from the harness: a session shown is kept in T.tmux.shown. T.tmux.showFails: it fails with that.
export async function showSession(cwd: string, session: string) {
  const x = (globalThis as any).T.tmux;
  if (x.showFails) throw new Error(x.showFails);
  (x.shown ??= []).push({ cwd, session });
}
