// T3 Code's access for Kiko: a short-lived bearer token minted by T3's own CLI (`t3 auth session
// issue`, which reads ~/.t3 itself: no pairing, nothing for you to approve), with only the scopes it
// needs: orchestration:read (subscribeShell, subscribeThread) and orchestration:operate
// (dispatchCommand: your words to a thread, a request answered, a run stopped, a thread renamed or
// archived; T3 checks the scope per method). Renewed before it runs out, revoked when Kiko quits.
//
// The token is a secret: it's kept in memory only, in a Secret that never prints, logs or turns into
// JSON as itself, and it's never on a command line (the CLI prints it; nothing passes it in). The CLI
// runs with a clean environment (cleanEnv below): none of the app's keys reach it. Its output is
// never logged, and an error from it says only how it ended.
import { execFile, spawn } from "node:child_process";
import { Secret } from "../secret.ts";
import { NAME } from "../../core/name.ts";

/** The scopes Kiko asks for (T3's contracts/src/auth.ts): read the shell and threads, dispatch a message. */
const SCOPES = ["orchestration:read", "orchestration:operate"] as const;
/** How long a token lives. */
export const TTL = "15m";
const TTL_MS = 15 * 60_000;

/** A token T3 issued: its session's ID (not a secret: what revokes it), the token, when it runs out (ms epoch). */
export type Issued = { sessionId: string; token: Secret; expiresAt: number };

/** What mints and revokes tokens: T3's CLI (cliMinter), or a test's. */
export interface Minter {
  issue(): Promise<Issued>;
  /** Revokes a token's session; quietly, and without waiting: Kiko may be quitting. */
  revoke(sessionId: string): void;
}

// What the CLI gets of the app's environment: what a new terminal window would have, nothing more
// (like the tmux adapter's cleanEnv). The app's own has its keys from .env and KIKO_* settings.
const PASSED = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG"]);

export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (PASSED.has(k) || k.startsWith("LC_"))));
}

/** The CLI's `issue --json` output (cliAuthFormat.ts formatIssuedSession): only what's used is read. */
export function parseIssued(stdout: string, now = Date.now()): Issued {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("T3's CLI didn't answer in JSON");
  }
  const token = typeof parsed?.token === "string" ? parsed.token : "";
  const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : "";
  if (!token || !sessionId) throw new Error("T3's CLI gave no token");
  const at = Date.parse(parsed.expiresAt ?? "");
  return { sessionId, token: new Secret(token), expiresAt: Number.isFinite(at) ? at : now + TTL_MS };
}

/** T3's CLI (~/.t3/bin/t3) mints and revokes. */
export function cliMinter(cli: string, timeoutMs = 20_000): Minter {
  const env = cleanEnv();
  return {
    issue() {
      const args = ["auth", "session", "issue", ...SCOPES.flatMap((s) => ["--scope", s]), "--ttl", TTL, "--label", NAME, "--json"];
      return new Promise((resolve, reject) => {
        execFile(cli, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
          // Never err.message: it quotes the command's output, which may hold the token.
          if (err) return reject(new Error(`T3's CLI failed (${err.code === "ENOENT" ? "not installed" : err.killed ? "timed out" : `exit ${err.code ?? "?"}`})`));
          try {
            resolve(parseIssued(stdout));
          } catch (e) {
            reject(e);
          }
        });
      });
    },
    revoke(sessionId) {
      try {
        // Detached: it finishes after Kiko has quit.
        const child = spawn(cli, ["auth", "session", "revoke", sessionId], { env, stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
      } catch {}
    },
  };
}
