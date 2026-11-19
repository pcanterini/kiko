// The release's executable, built and run before a release is:
//   pnpm smoke:binary            (`pnpm ship` runs it after the type check and the tests, before building)
// The tests run on Node; what ships is Bun's --compile of a minified bundle, which has broken where
// Node didn't (0.2.0's tunnel on Bun's node:crypto; a minifier TDZ crash, 2026-11-01: scripts/bundle.ts).
// So: scripts/release.sh itself, for this Mac's chip only, signed ad hoc ("-": no identity, nothing
// sent to Apple), into a temp folder; its tarball unpacked as install.sh would; then the executable
// run with commands that start and exit on their own: --version, --help, an unknown command,
// _verify-files (its folder against the list baked in, the helper app's signature too), `keys`,
// `setup claude` (it stops at asking: no terminal), and through `kiko hook` the scripts the agents
// run with it (the voice hooks with no app to reach, the quick checks' gate, the status line).
// Each must exit as expected, say what it should and nothing on stderr it shouldn't.
//
// Never the app, the mic, a terminal or tmux: each run has a home, TMPDIR, TMUX_TMPDIR, tmux server
// name, socket, state and settings file of its own in the temp folder, no Keychain, accounts off,
// a proxy that goes nowhere, and stdin from a pipe; nothing of this shell's environment. Afterwards
// no tmux socket may be in its TMUX_TMPDIR. Building may fetch tmux's sources once, when its cache
// (KIKO_BUILD_CACHE, as release.sh) has none, as the real build would. About 15 s with tmux cached.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLUG } from "../../src/core/name.ts";

export type Run = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };

export type SmokeCheck = {
  name: string;
  args: string[];
  /** What it's given on stdin (always a pipe, never a terminal). */
  stdin?: string;
  code: number;
  /** What stdout must be (trimmed), or match. */
  stdout?: string | RegExp;
  /** What stderr must match; unset, it must be empty. */
  stderr?: RegExp;
};

/** In the unpacked release's folder (`dir`), as an installed copy has it; `version` the build's. */
export function smokeChecks(dir: string, version: string): SmokeCheck[] {
  const hook = (script: string) => ["hook", join(dir, script)];
  const event = (e: Record<string, unknown>) => JSON.stringify({ session_id: "smoke", cwd: dir, transcript_path: join(dir, "none.jsonl"), ...e });
  return [
    { name: "--version", args: ["--version"], code: 0, stdout: version },
    { name: "--help", args: ["--help"], code: 0, stdout: new RegExp(`^Usage: ${SLUG} `) },
    { name: "an unknown command", args: ["no-such-command"], code: 2, stderr: /unknown command no-such-command/ },
    { name: "_verify-files", args: ["_verify-files"], code: 0, stdout: version },
    { name: "keys", args: ["keys"], code: 0, stdout: /^openrouter +not set/m },
    { name: "setup claude (no terminal: stops at asking)", args: ["setup", "claude"], code: 1, stdout: /settings\.json/, stderr: /in a terminal/ },
    {
      name: "the quick checks' gate: rm denied",
      args: hook("hooks/quick-guard.mjs"),
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }),
      code: 0,
      stdout: /"permissionDecision":"deny"/,
    },
    { name: "the quick checks' gate: ls passes", args: hook("hooks/quick-guard.mjs"), stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), code: 0, stdout: "" },
    { name: "Claude Code's hook, Stop, no app", args: hook("hooks/claude-code-hook.mjs"), stdin: event({ hook_event_name: "Stop" }), code: 0, stdout: "" },
    {
      name: "Claude Code's hook, PreToolUse, no app",
      args: hook("hooks/claude-code-hook.mjs"),
      stdin: event({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } }),
      code: 0,
      stdout: "",
    },
    { name: "Codex's hook, Stop, no app", args: hook("hooks/codex-hook.mjs"), stdin: event({ hook_event_name: "Stop" }), code: 0, stdout: "" },
    { name: "the status line, wrapping a command", args: [...hook(`statusline/${SLUG}-status.mjs`), "--", "/bin/echo", "their line"], stdin: event({}), code: 0, stdout: "their line" },
  ];
}

/** What's wrong with a run, or null. */
export function judge(check: SmokeCheck, r: Run): string | null {
  if (r.timedOut) return `didn't exit within ${Math.round(r.ms / 1000)}s`;
  const problems: string[] = [];
  if (r.code !== check.code) problems.push(`exit ${r.code}, not ${check.code}`);
  const out = r.stdout.trim();
  if (typeof check.stdout === "string" ? out !== check.stdout : check.stdout && !check.stdout.test(out)) problems.push(`stdout: ${JSON.stringify(out.slice(0, 300))}`);
  const err = r.stderr.trim();
  if (check.stderr ? !check.stderr.test(err) : err) problems.push(`stderr: ${JSON.stringify(err.slice(0, 300))}`);
  return problems.length ? problems.join("; ") : null;
}

/**
 * Everything a run sees: its own folders under `root`, never this shell's (no keys, no TMUX, no
 * HOME): the app's socket, state, settings and tmux server its own; no Keychain; accounts off;
 * network through a proxy that refuses (port 9 on this Mac).
 */
export function sandboxEnv(root: string): Record<string, string> {
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  const nowhere = "http://127.0.0.1:9";
  const prefix = SLUG.toUpperCase();
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USER: "smoke",
    LANG: "en_US.UTF-8",
    TMPDIR: tmp,
    TMUX_TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    HTTP_PROXY: nowhere,
    HTTPS_PROXY: nowhere,
    ALL_PROXY: nowhere,
    http_proxy: nowhere,
    https_proxy: nowhere,
    [`${prefix}_KEYCHAIN`]: "off",
    [`${prefix}_ACCOUNTS`]: "0",
    [`${prefix}_TMUX_SERVER`]: `${SLUG}-smoke`,
    [`${prefix}_SOCKET`]: join(tmp, "app.sock"),
    [`${prefix}_STATE`]: join(tmp, "state.json"),
    [`${prefix}_SETTINGS`]: join(home, ".config", SLUG, "settings.json"),
  };
}

function runOnce(bin: string, check: SmokeCheck, env: Record<string, string>, cwd: string, timeoutMs = 20_000): Promise<Run> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(bin, check.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.stdin.end(check.stdin ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => (stderr += e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - start, timedOut });
    });
  });
}

const arch = () => (process.arch === "x64" ? "x64" : "arm64");

async function main(): Promise<number> {
  const repo = join(import.meta.dirname, "..", "..");
  const version = process.env.KIKO_VERSION || (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
  const root = mkdtempSync(join(tmpdir(), `${SLUG}-smoke-`));
  const keep = process.argv.includes("--keep");
  const start = Date.now();
  let ok = false;
  try {
    // The release's own build, this chip, ad hoc: no identity of yours, no notary profile, nothing uploaded.
    const dist = join(root, "dist");
    const built = spawnSync("sh", ["scripts/release.sh"], {
      cwd: repo,
      env: { ...process.env, KIKO_SIGN_IDENTITY: "-", KIKO_NOTARY_PROFILE: "off", KIKO_ARCHS: arch(), KIKO_DIST: dist, KIKO_VERSION: version },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (built.status !== 0) {
      const tail = `${built.stdout ?? ""}\n${built.stderr ?? ""}`
        .split("\n")
        .filter((l) => l.trim())
        .slice(-20);
      console.error(`smoke: release.sh failed (exit ${built.status}; kept: ${root}):\n  │ ${tail.join("\n  │ ")}`);
      return 1;
    }
    const buildMs = Date.now() - start;
    const install = join(root, "install");
    mkdirSync(install);
    const tarball = join(dist, `${SLUG}-${version}-darwin-${arch()}.tar.gz`);
    const unpacked = spawnSync("tar", ["-xzf", tarball, "-C", install], { encoding: "utf8" });
    if (unpacked.status !== 0) {
      console.error(`smoke: couldn't unpack ${tarball}: ${unpacked.stderr}`);
      return 1;
    }
    const dir = join(install, `${SLUG}-${version}`);
    const bin = join(dir, SLUG);
    const env = sandboxEnv(root);
    for (const d of [env.HOME, env.TMPDIR, join(root, "work")]) mkdirSync(d, { recursive: true });
    const failed: string[] = [];
    const lines: string[] = [];
    for (const check of smokeChecks(dir, version)) {
      const r = await runOnce(bin, check, env, join(root, "work"));
      const wrong = judge(check, r);
      lines.push(`${wrong ? "FAILED" : "ok"}  ${check.name} (${r.ms} ms)${wrong ? `: ${wrong}` : ""}`);
      if (wrong) failed.push(check.name);
    }
    // No tmux was started: its sockets would be in TMUX_TMPDIR (tmux-<uid>/).
    const tmuxDirs = existsSync(env.TMUX_TMPDIR) ? readdirSync(env.TMUX_TMPDIR).filter((n) => n.startsWith("tmux-")) : [];
    if (tmuxDirs.length) {
      lines.push(`FAILED  no tmux started: ${tmuxDirs.join(", ")} in its TMUX_TMPDIR`);
      failed.push("no tmux");
    }
    console.log(lines.map((l) => `  ${l}`).join("\n"));
    const total = ((Date.now() - start) / 1000).toFixed(1);
    if (failed.length) {
      console.error(`smoke: ${failed.length} of the built ${arch()} executable's runs failed (${total}s; kept: ${root})`);
      return 1;
    }
    ok = true;
    console.log(`smoke: the built ${arch()} executable (${version}) ran ${lines.length} checks headless: all passed (build ${(buildMs / 1000).toFixed(1)}s, ${total}s in all)`);
    return 0;
  } finally {
    // Kept when something failed, to look at (it holds nothing of yours).
    if (ok && !keep) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
