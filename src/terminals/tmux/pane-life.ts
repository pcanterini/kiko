// How a program in a pane or popup of the Kiko window ends when its terminal goes: the viewer
// (./viewer-pane.ts), the frame and the caption (./frame-pane.ts), a menu's popup (./menu-popup.ts).
// Their timers and sockets would keep them going with nothing left to show anything to, so each
// one ends by whichever sign comes first:
// - SIGHUP (its pane closed, its server gone), its input ending, closing or failing (EOF, EIO), a
//   write to its terminal failing (EIO, EPIPE): nothing is written to the terminal on the way out;
// - its parent gone (tmux's server: it's left to launchd), looked at every second;
// - for a pane's program, tmux saying GONE_AFTER times running that its pane or its server isn't
//   there, or that the pane runs another program now (respawned while this one lived on).
// SIGTERM ends it too, the terminal's screen put back first. Without these, viewers were found
// running by the dozen under launchd, each with its terminal held, long after their panes.
// Imports nothing that loads .env, reads settings or writes logs: the pane programs use it.
import { execFile } from "node:child_process";

/** What tmux says when a pane or its server isn't there any more. */
const PANE_GONE = /no server running|error connecting to|no such pane|can't find pane/;
/** Looks in a row that find its pane gone before it ends (one could be tmux busy, or mid-respawn). */
const GONE_AFTER = 3;
/** How often the parent and the pane are looked at. */
export const LOOK_EVERY_MS = 1000;

/**
 * One look at its pane (`display-message -p '#{pane_pid}'`, perhaps followed in the same run of tmux
 * by `show-options` of an option, as the viewer reads its VIEWER_INFO): `gone` when tmux says the
 * pane or its server isn't there, or the pane runs another program now (its pid none of `own`);
 * `info`, what followed the pid, if anything.
 */
export function paneLook(stdout: string, stderr: string, own: number[]): { gone: boolean; info: string | null } {
  const [first = "", ...rest] = stdout.replace(/\n$/, "").split("\n");
  const pid = /^\d+$/.test(first.trim()) ? Number(first) : null;
  const gone = PANE_GONE.test(stderr) || (pid !== null && !own.includes(pid));
  return { gone, info: pid !== null && rest.length ? rest.join("\n") : null };
}

type Tie = {
  /** Ends this process; the terminal's screen put back first only while it's `there`. */
  end: (there: boolean) => void;
  /** What one look at its pane found (paneLook's `gone`): GONE_AFTER gone in a row end it. */
  looked: (gone: boolean) => void;
  /** What its pane may run: this process, or its parent as it started (a shell between tmux and it). */
  own: number[];
};

/**
 * Ties this process to its terminal (see above). `restore`: what puts the terminal back as it was.
 * `pane`: tmux and the pane to look at every second (`display-message`), for a program that doesn't
 * look itself (the viewer does, and says what it found with `looked`); none for a popup, which
 * has no pane of its own.
 */
export function tieToTerminal(o: { restore: string; pane?: { tmux: string; id: string } }): Tie {
  const out = process.stdout;
  const parent = process.ppid;
  const own = [process.pid, parent];
  let ended = false;
  let missed = 0;
  const restore = () => {
    try {
      out.write(o.restore);
    } catch {
      // the terminal is gone
    }
  };
  const end = (there: boolean) => {
    if (ended) return;
    ended = true;
    if (there) restore();
    process.exit(0);
  };
  const looked = (gone: boolean) => {
    missed = gone ? missed + 1 : 0;
    if (missed >= GONE_AFTER) end(false);
  };
  for (const event of ["end", "close", "error"] as const) process.stdin.on(event, () => end(false));
  out.on("error", () => end(false));
  process.on("SIGHUP", () => end(false));
  process.on("SIGTERM", () => end(true));
  process.on("exit", () => {
    if (!ended) restore();
  });
  const pane = o.pane?.id ? o.pane : null;
  // Never what keeps it going: a popup with nothing else to do ends as before.
  setInterval(() => {
    if (process.ppid !== parent || parent === 1) return end(false);
    if (!pane) return;
    execFile(pane.tmux, ["-u", "display-message", "-p", "-t", pane.id, "#{pane_pid}"], { timeout: 2000 }, (_err, stdout, stderr) => looked(paneLook(String(stdout), String(stderr), own).gone));
  }, LOOK_EVERY_MS).unref();
  return { end, looked, own };
}
