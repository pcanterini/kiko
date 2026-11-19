// The pieces the app starts together once the agents are up (app.ts: the mic, the speaker, speech to
// text, Cartesia, Pocket): one that fails to start is logged and said once, with what to do, and the
// rest start all the same, so a missing or broken part never stops the app. Speech to text, Cartesia
// and Pocket say their own (app/state.ts connectStt, connectCartesia, connectPocket: each catches and
// falls back); the mic and the speaker are said here.
//
// Fatal on purpose, and thrown on as before: a Swift helper that won't build in a checkout
// (platform/macos/native.ts HelperBuildError). Every helper is built the same way (the hotkey, the
// player, the mic), so none would work either; app.ts says it as one line naming swiftc's log and stops.

/** A piece to start: its name (for the log), its start, and what's said when it fails. */
export type Part = { name: string; start: () => Promise<unknown> | unknown; failed: (why: string) => void };

export type PartsDeps = {
  log(event: string, fields?: Record<string, unknown>): void;
  /** An error that stops the app as before (HelperBuildError). */
  fatal(err: unknown): boolean;
};

/** Starts them all together: what didn't start (their names, in order). A fatal error rejects, as one did before. */
export async function startParts(parts: Part[], d: PartsDeps): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    parts.map(async (p) => {
      try {
        await p.start();
      } catch (err) {
        if (d.fatal(err)) throw err;
        const why = err instanceof Error ? err.message : String(err);
        d.log("error", { where: `${p.name}_start`, message: why });
        failed.push(p.name);
        p.failed(why);
      }
    }),
  );
  return parts.map((p) => p.name).filter((n) => failed.includes(n));
}
