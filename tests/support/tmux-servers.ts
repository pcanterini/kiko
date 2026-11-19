// Throwaway tmux servers for the live tests: `tmux -L kiko-test-<random>-<label>`, never
// Kiko's (`-L kiko`) nor the default one. Each one named here is killed (and its socket file
// removed) when the test process exits, whatever happens: an `after` that never ran, Ctrl+C
// (tests/setup.ts turns signals into an exit), a test that threw.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmuxPath } from "../../src/terminals/tmux/tmux.ts";

const RUN = randomBytes(4).toString("hex");
const started = new Set<string>();

/** A server name of this run's own, killed at exit. */
export function throwawayServer(label: string): string {
  const name = `kiko-test-${RUN}-${label}`;
  if (!name.startsWith("kiko-test-") || name === "kiko") throw new Error(`not a throwaway server: ${name}`);
  started.add(name);
  return name;
}

/** Kills every server this run named (they may be gone already) and removes their socket files. */
export function killServers() {
  const tmux = tmuxPath();
  for (const name of started) {
    if (tmux) {
      try {
        execFileSync(tmux, ["-L", name, "kill-server"], { stdio: "ignore" });
      } catch {
        // gone already
      }
    }
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, name), { force: true });
  }
}

process.on("exit", killServers);
