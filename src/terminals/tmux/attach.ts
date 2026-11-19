// The terminal a tmux client attached by `kiko` gets (src/cli.ts attachWindow). tmux draws its
// client on the client's stdin: the client hands that descriptor to the server, which reads keys
// from it and writes the window to it. So it must be a terminal, open for writing too.
//
// 2026-11-02: `curl -fsSL https://kiko.sh | sh` ran `kiko setup <"$term"` (install.sh: its own
// input is the script), a terminal opened read-only. Setup read its keys fine; then "Open Kiko"
// attached tmux to it, the server's every write failed, and the terminal sat on setup's last screen
// while the app ran unseen (the client attached, "focused", drawing nowhere). Now such a stdin is
// swapped for this terminal opened again, by its own name, for both; with no terminal at all,
// nothing is attached and `kiko` says what to run.
import { closeSync, openSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isatty } from "node:tty";
import { COMMAND, NAME } from "../../core/name.ts";

/** What a tmux client's stdin is: this one's ("inherit"), or a descriptor opened for it; `close()` once it's done. */
type AttachInput = { stdin: "inherit" | number; close(): void };

export type AttachDeps = {
  /** Whether descriptor `fd` is a terminal. */
  isTty(fd: number): boolean;
  /** Whether descriptor `fd` takes writes (a write of nothing: EBADF when it's open read-only). */
  writable(fd: number): boolean;
  /** This process's terminal by its own name ("/dev/ttys003"), or null when it has none. */
  device(): string | null;
  /** `path` opened for reading and writing: its descriptor. Throws when it can't be. */
  open(path: string): number;
  close(fd: number): void;
};

/** A terminal's device from `ps -o tty=` ("ttys003" → /dev/ttys003); null for none ("??"). Not /dev/tty: Bun reads no keys from it (macOS's kqueue can't watch it). */
export const deviceOf = (psTty: string): string | null => (/^tty[\w.]+$/.test(psTty.trim()) ? `/dev/${psTty.trim()}` : null);

export const realAttachDeps: AttachDeps = {
  isTty: (fd) => isatty(fd),
  writable(fd) {
    try {
      writeSync(fd, Buffer.alloc(0));
      return true;
    } catch {
      return false;
    }
  },
  device() {
    try {
      return deviceOf(execFileSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return null;
    }
  },
  open: (path) => openSync(path, "r+"),
  close: (fd) => closeSync(fd),
};

/**
 * The stdin for a tmux client attached here: this one when it's a terminal open for writing too;
 * else this process's terminal, opened again for both (stdin read-only, as install.sh gave it, or
 * a pipe with the output still a terminal); null when there's no terminal to show the window in.
 */
export function attachInput(d: AttachDeps = realAttachDeps): AttachInput | null {
  if (d.isTty(0) && d.writable(0)) return { stdin: "inherit", close: () => {} };
  const device = d.device();
  if (!device) return null;
  let fd: number;
  try {
    fd = d.open(device);
  } catch {
    return null;
  }
  if (!d.isTty(fd)) {
    d.close(fd);
    return null;
  }
  return { stdin: fd, close: () => d.close(fd) };
}

/** Said when the window can't be shown here: the app runs on; what to run to see it. */
export const NO_TERMINAL = `${NAME} is running, but there's no terminal here to show its window in. Run ${COMMAND} in a terminal to see it.`;

/** Said after tmux couldn't attach (what it said is above): what to run to try again. */
export const ATTACH_FAILED = `${NAME}'s window couldn't be shown here. Run ${COMMAND} to open it.`;
