// One command for a release, from a version bump to a release people can install (RELEASING.md):
//   pnpm ship [version] [--full] [--dry-run] [--notes "what's new, in a line"]
//   pnpm release:status                  how each release's notarization ended (scripts/ship/status.ts)
//   pnpm release:notarize [version]      notarize a published release again, by hand
//
// The fast path (the default before the public launch): build both chips at once, sign, check, pack,
// push main, upload to R2 (the tarballs and their .sha256 first, latest.json last), sync and deploy
// the site only if install.sh changed, verify from outside, and notarize with Apple in the
// background after publishing: `curl | sh` and `kiko update` never quarantine what they download,
// so Gatekeeper's notarization check never runs on that path, and a bare executable's ticket lives
// on Apple's servers (it can't be stapled), so the files are byte for byte the same either way. How
// it ended is in dist/<version>/notary.json; a rejection is printed loudly by the next `pnpm ship`
// and by `pnpm release:status`, with a macOS notification when it happens. It never undoes a publish.
//
// The full path (--full, or KIKO_RELEASE=full; for after the launch): notarize and wait for
// Gatekeeper before packing, then publish, as releases were before.
//
// --dry-run: everything local (the checks, a clean worktree, build, sign, verify, pack, with the real
// identity) into dist/dry-run/<version>/; no commit, push, upload, deploy or notarization.
//
// It stops on a tree that isn't clean, a branch that isn't main, main behind origin, a version that
// isn't newer than the live feed's, or a site checkout that isn't on its branch and clean. It builds
// from a clean worktree at HEAD (removed after), with tmux's build cache shared from the main
// checkout's .cache/, and only once the type check and the unit tests pass there (`checks`, a dry
// run too: nothing skips them) and this chip's executable, built ad hoc into a temp folder, runs
// headless under Bun as it ships (`smoke`, scripts/ship/smoke.ts: the tests run on Node). It prints no credentials: wrangler and notarytool use what they're logged in with, and only
// their result lines are shown.
//
//   KIKO_RELEASE          fast (default) or full
//   KIKO_RELEASE_NOTES    latest.json's line (or --notes)
//   KIKO_RELEASES_URL     where the releases are served: https://kiko.sh/releases
//   KIKO_SITE             the site's checkout (scripts/sync-site.sh finds it otherwise); KIKO_SITE_BRANCH: main
//   KIKO_R2_BUCKET        kiko-releases
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NAME, RELEASES_URL, SLUG } from "../../src/core/name.ts";
import { INSTALL_ID_HEADER, installId, readToken, TOKEN_HEADER } from "../../src/core/updates/invite.ts";
import { layoutOf } from "../../src/core/updates/layout.ts";
import { compareVersions, describeStatus, loud, type NotaryStatus, readStatus, STATUS_FILE, scanStatuses, writeStatus } from "./status.ts";

export type Mode = "fast" | "full";
export type Options = { version?: string; mode: Mode; dryRun: boolean; notes?: string; help: boolean; command: "ship" | "notarize" };

export const USAGE = `pnpm ship [version] [--full] [--dry-run] [--notes "what's new, in a line"]
  version     bumps package.json to it and commits ("package.json: <version>"); without one, package.json's
  --full      notarize and wait for Gatekeeper before publishing (KIKO_RELEASE=full): after the public launch
  --fast      the default: publish, then notarize in the background
  --dry-run   the type check and tests, build, sign, verify and pack only (dist/dry-run/<version>/): no commit, push, upload, deploy or notarizing
  --notes     latest.json's notes (KIKO_RELEASE_NOTES); "Kiko <version>" without
pnpm release:status               how each release's notarization ended
pnpm release:notarize [version]   notarize a published release again (dist/<version>/)`;

const VERSION = /^\d+\.\d+\.\d+$/;

/** The command line and KIKO_RELEASE, as options. Throws on anything it doesn't know. */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Options {
  const fromEnv = env.KIKO_RELEASE || "fast";
  if (fromEnv !== "fast" && fromEnv !== "full") throw new Error(`KIKO_RELEASE is fast or full, not ${fromEnv}`);
  const o: Options = { mode: fromEnv, dryRun: false, help: false, command: "ship", notes: env.KIKO_RELEASE_NOTES || undefined };
  const args = [...argv];
  if (args[0] === "notarize") {
    o.command = "notarize";
    args.shift();
  }
  while (args.length) {
    const a = args.shift() as string;
    if (a === "--") continue;
    if (a === "--full") o.mode = "full";
    else if (a === "--fast") o.mode = "fast";
    else if (a === "--dry-run" || a === "-n") o.dryRun = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--notes") {
      const notes = args.shift();
      if (!notes) throw new Error("--notes needs a line");
      o.notes = notes;
    } else if (a.startsWith("--notes=")) o.notes = a.slice("--notes=".length);
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (o.version) throw new Error(`one version, not ${o.version} and ${a}`);
    else {
      const v = a.replace(/^v/, "");
      if (!VERSION.test(v)) throw new Error(`a version is x.y.z, not ${a}`);
      o.version = v;
    }
  }
  return o;
}

export type StepName = "preflight" | "notary-status" | "version" | "worktree" | "checks" | "smoke" | "build" | "check" | "push" | "upload-assets" | "upload-feed" | "notarize" | "site" | "verify";
export type PlannedStep = { name: StepName; what: string; skip?: string };

/**
 * The steps, in order. Fast: publish, then notarize in the background. Full: notarize and wait for
 * Gatekeeper inside the build, before packing, then publish. A dry run keeps every local step and
 * skips (but lists) what would leave this Mac.
 */
export function plan(o: Pick<Options, "mode" | "dryRun" | "version">): PlannedStep[] {
  const dry = o.dryRun ? "dry run" : undefined;
  const steps: PlannedStep[] = [
    { name: "preflight", what: "main, a clean tree, up to date with origin; the version newer than the live feed's; the site's checkout; wrangler logged in" },
    { name: "notary-status", what: "how earlier releases' notarization ended (dist/*/notary.json)" },
    {
      name: "version",
      what: o.dryRun ? "the version, built as it (KIKO_VERSION), nothing committed" : o.version ? `package.json → ${o.version}, committed` : "package.json's version",
    },
    { name: "worktree", what: "a clean worktree at HEAD, its dependencies installed" },
    { name: "checks", what: "the type check and the unit tests, in that worktree (pnpm typecheck, pnpm test)" },
    { name: "smoke", what: "this chip's executable built ad hoc into a temp folder and run headless, under Bun as it ships (pnpm smoke:binary)" },
    {
      name: "build",
      what:
        o.mode === "full" && !o.dryRun
          ? "both chips at once: build, sign, check, notarize, wait for Gatekeeper, pack"
          : "both chips at once: build, sign, check (the update requirement, identifiers, _verify-files, relay vectors, notices), pack",
    },
    { name: "check", what: "the tarballs against their .sha256 and latest.json" },
    { name: "push", what: "tag the built commit v<version> (its notes as the message), push main and the tag", skip: dry },
    { name: "upload-assets", what: "the tarballs and their .sha256 to R2", skip: dry },
    { name: "upload-feed", what: "latest.json to R2, last", skip: dry },
  ];
  if (o.mode === "fast") steps.push({ name: "notarize", what: "Apple's notarization and the Gatekeeper gate, in the background (dist/<version>/notary.json)", skip: dry });
  steps.push(
    { name: "site", what: o.dryRun ? "whether install.sh changed (nothing synced or deployed)" : "install.sh to the site, committed, pushed and deployed, only if it changed" },
    { name: "verify", what: "from outside: latest.json's version, the checksums, install.sh served", skip: dry },
  );
  return steps;
}

/** A release's git tag: v and its version (v0.3.0, the tags before ship made them). */
export const releaseTag = (version: string) => `v${version}`;

/** What release.sh is run with: when to notarize follows the path (a dry run never sends anything to Apple). */
export function releaseEnv(o: Pick<Options, "mode" | "dryRun">, c: { dist: string; cache: string; version: string; notes: string; base: string }): Record<string, string> {
  return {
    KIKO_DIST: c.dist,
    KIKO_BUILD_CACHE: c.cache,
    KIKO_VERSION: c.version,
    KIKO_RELEASE_NOTES: c.notes,
    KIKO_RELEASES_URL: c.base,
    KIKO_NOTARIZE: o.mode === "full" && !o.dryRun ? "now" : "later",
    KIKO_RELEASE: o.mode,
  };
}

export type StepResult = { name: StepName; ms: number; outcome: "done" | "skipped" | "failed"; note?: string };
export type StepImpl = () => Promise<string | undefined | void>;

/** Runs the steps in order, timing each; the first that throws stops the rest. Skipped ones are listed, not run. */
export async function runSteps(
  steps: PlannedStep[],
  impl: Partial<Record<StepName, StepImpl>>,
  io: { say: (line: string) => void; now: () => number },
): Promise<{ results: StepResult[]; ok: boolean; error?: Error }> {
  const results: StepResult[] = [];
  for (const step of steps) {
    if (step.skip) {
      results.push({ name: step.name, ms: 0, outcome: "skipped", note: step.skip });
      io.say(`· ${step.name}: skipped (${step.skip}): ${step.what}`);
      continue;
    }
    const run = impl[step.name];
    if (!run) throw new Error(`ship: no step ${step.name}`);
    io.say(`▸ ${step.name}: ${step.what}`);
    const start = io.now();
    try {
      const note = (await run()) || undefined;
      results.push({ name: step.name, ms: io.now() - start, outcome: "done", note });
      if (note) io.say(`  ${note}`);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      results.push({ name: step.name, ms: io.now() - start, outcome: "failed", note: error.message });
      return { results, ok: false, error };
    }
  }
  return { results, ok: true };
}

export function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** The summary: each step's time and outcome, the total. */
export function summary(head: string, results: StepResult[], totalMs: number): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const rows = results.map((r) => {
    const time = r.outcome === "skipped" ? "—" : seconds(r.ms);
    const mark = r.outcome === "failed" ? "FAILED" : r.outcome === "skipped" ? "skipped" : "";
    const note = (r.note ?? "").split("\n")[0];
    return `  ${r.name.padEnd(width)}  ${time.padStart(7)}  ${mark}${mark && note ? ": " : ""}${note}`.trimEnd();
  });
  return [`${head} in ${seconds(totalMs)}`, ...rows].join("\n");
}

// ——— The checks before building ———

/**
 * What a release must pass before it's built, in its clean worktree: the commands the project checks
 * itself with (package.json's scripts). There's no way to skip them: a red tree would reach every
 * install through `kiko update`.
 */
export const CHECKS = [
  { name: "typecheck", cmd: "pnpm", args: ["typecheck"] },
  { name: "tests", cmd: "pnpm", args: ["test"] },
] as const;

export type CheckName = (typeof CHECKS)[number]["name"];
export type CheckRun = (cmd: string, args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How many of a list to show, and the line saying how many more there were. */
function firstOf(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `… and ${lines.length - max} more`] : lines;
}

/**
 * A check's result as one line (its time added by `runChecks`), and when it failed, what failed:
 * tsc's errors; the test runner's failing tests (where, which, and the first line of why), never
 * their stacks. Anything else that failed: the last lines it printed.
 */
export function checkResult(name: CheckName, r: { code: number; stdout: string; stderr: string }): { ok: boolean; line: string; detail: string[] } {
  const text = `${r.stdout}\n${r.stderr}`;
  if (name === "typecheck") {
    const errors = text.split("\n").filter((l) => /error TS\d+:/.test(l));
    if (r.code === 0) return { ok: true, line: "typecheck: passed", detail: [] };
    return {
      ok: false,
      line: `typecheck: FAILED${errors.length ? `, ${errors.length} error${errors.length > 1 ? "s" : ""}` : ` (exit ${r.code})`}`,
      detail: errors.length ? firstOf(errors, 20) : tail(text),
    };
  }
  // node --test's summary: "ℹ tests 4586", "ℹ pass 4585", "ℹ fail 0", "ℹ skipped 1".
  const count = (what: string) => Number(new RegExp(`^ℹ ${what} (\\d+)`, "m").exec(text)?.[1] ?? Number.NaN);
  const [tests, pass, fail, skipped] = ["tests", "pass", "fail", "skipped"].map(count);
  const counted = !Number.isNaN(tests);
  const counts = counted ? `${pass} of ${tests} passed${fail ? `, ${fail} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}` : "";
  if (r.code === 0 && counted && !fail) return { ok: true, line: `tests: ${counts}`, detail: [] };
  // After "✖ failing tests:", each failure is "test at <file:line>", "✖ <name> (<ms>)", then why.
  const failing = text.split("\n✖ failing tests:")[1];
  const detail: string[] = [];
  if (failing) {
    const lines = failing.split("\n");
    lines.forEach((l, i) => {
      if (!l.startsWith("test at ")) return;
      const why = lines[i + 2]?.trim();
      detail.push(`${lines[i + 1]?.replace(/ \([\d.]+m?s\)$/, "")}  (${l.slice("test at ".length).replace(/^(\.\.\/)+/, "")})${why ? `\n      ${why}` : ""}`);
    });
  }
  return { ok: false, line: `tests: FAILED${counts ? `, ${counts}` : ` (exit ${r.code})`}`, detail: detail.length ? firstOf(detail, 20) : tail(text) };
}

const tail = (text: string, max = 15) =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .slice(-max);

/** The smoke of the built executable (scripts/ship/smoke.ts): about 15 s with tmux's build cached, a minute or two without. */
const SMOKE_TIMEOUT_MS = 10 * 60_000;

/** As long as CI gave them (ci.yml's timeout); a run takes about a minute. */
const CHECKS_TIMEOUT_MS = 15 * 60_000;

/**
 * The checks, at once, in `cwd` (ship's clean worktree): a line each, with its time. Throws with
 * those lines and what failed when either fails, so nothing is built.
 */
export async function runChecks(cwd: string, exec: CheckRun = (cmd, args, at) => run(cmd, [...args], { cwd: at, timeoutMs: CHECKS_TIMEOUT_MS }), now = () => Date.now()): Promise<string> {
  const results = await Promise.all(
    CHECKS.map(async (c) => {
      const start = now();
      const result = checkResult(c.name, await exec(c.cmd, c.args, cwd));
      return { ...result, ms: now() - start };
    }),
  );
  const lines = results.map((r) => `${r.line} (${seconds(r.ms)})`);
  if (results.every((r) => r.ok)) return lines.join("\n  ");
  const failed = results.filter((r) => !r.ok);
  throw new Error(
    [
      `not building: ${failed.map((r) => (r.line.startsWith("tests") ? "the tests" : "the type check")).join(" and ")} failed at HEAD (fix, commit, ship again)`,
      ...lines.map((l) => `  ${l}`),
      ...failed.flatMap((r) => r.detail.map((d) => `    ${d}`)),
    ].join("\n"),
  );
}

// ——— The real steps ———

type Run = { code: number; stdout: string; stderr: string };

/** A command, its output kept (never shown unless asked): for git, wrangler, curl, dig. */
function run(cmd: string, args: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : undefined;
    child.on("error", (e) => {
      stderr += e.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Lines that are safe to show from a tool that may print an account (wrangler): none naming one. */
export function safeLines(text: string, max = 12): string {
  return text
    .split("\n")
    .filter((l) => l.trim() && !/token|e-?mail|@|account|password|secret|key/i.test(l))
    .slice(-max)
    .join("\n");
}

async function must(cmd: string, args: string[], what: string, o: Parameters<typeof run>[2] = {}): Promise<string> {
  const r = await run(cmd, args, o);
  if (r.code !== 0) throw new Error(`${what}: ${safeLines(`${r.stderr}\n${r.stdout}`, 6) || `exit ${r.code}`}`);
  return r.stdout.trim();
}

/** Streams a long command's output, indented (release.sh). */
function stream(cmd: string, args: string[], o: { cwd: string; env: Record<string, string> }): Promise<number> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["ignore", "pipe", "pipe"] });
    const indent = (out: NodeJS.WriteStream) => {
      let rest = "";
      return (d: Buffer) => {
        const lines = (rest + d.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) out.write(`  │ ${l}\n`);
      };
    };
    child.stdout?.on("data", indent(process.stdout));
    child.stderr?.on("data", indent(process.stderr));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

type Asset = { arch: string; file: string; sha: string; url: string };

type Ctx = {
  repo: string;
  o: Options;
  version: string;
  notes: string;
  base: string;
  dist: string;
  bucket: string;
  siteBranch: string;
  site?: string;
  worktree?: string;
  liveVersion?: string;
  assets: Asset[];
  resolve?: string[];
  warnings: string[];
  notaryPid?: number;
  /** curl's arguments for the release feed's own files: this Mac's invite headers, from a file (none: []). */
  auth?: { args: string[]; dir?: string };
};

/** curl as from outside: the host looked up at 1.1.1.1, not this Mac's resolver or cache. */
async function outsideArgs(c: Ctx): Promise<string[]> {
  if (c.resolve) return c.resolve;
  const name = new URL(c.base).hostname;
  const r = await run("dig", ["@1.1.1.1", "+short", "+time=3", "+tries=1", name, "A"], { timeoutMs: 10_000 });
  const ip = r.stdout.split("\n").find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()));
  c.resolve = ip ? ["--resolve", `${name}:443:${ip.trim()}`] : [];
  return c.resolve;
}

/**
 * With the invite gate on (the site's RELEASES.md), kiko.sh/releases/* needs an invite's token: this
 * Mac's own (install.sh or `kiko update --token` kept it, core/updates/invite.ts), sent from a header
 * file (curl -H @file, readable by you only) so it's never on a command line. None kept: nothing sent.
 */
function releaseAuthArgs(c: Ctx): string[] {
  if (c.auth) return c.auth.args;
  const l = layoutOf();
  const token = readToken(l);
  const id = token ? installId(l, false) : null;
  if (!token || !id) return (c.auth = { args: [] }).args;
  const dir = mkdtempSync(join(tmpdir(), `${SLUG}-ship-auth-`));
  const file = join(dir, "headers");
  writeFileSync(file, `${TOKEN_HEADER}: ${token}\n${INSTALL_ID_HEADER}: ${id}\n`, { mode: 0o600 });
  c.auth = { args: ["-H", `@${file}`], dir };
  return c.auth.args;
}

async function curl(c: Ctx, url: string, extra: string[] = []): Promise<Run> {
  const auth = url.startsWith(`${c.base}/`) ? releaseAuthArgs(c) : [];
  return run("curl", ["-fsS", "--max-time", "120", ...(await outsideArgs(c)), ...auth, ...extra, url]);
}

function findSite(): string | undefined {
  const set = process.env.KIKO_SITE;
  if (set) return set;
  const site = join(homedir(), "git", `${SLUG}-site`);
  return existsSync(join(site, "public")) ? site : undefined;
}

function pkgVersion(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
}

function realSteps(c: Ctx): Record<StepName, StepImpl> {
  const git = (args: string[], what: string, cwd = c.repo) => must("git", ["-C", cwd, ...args], what);
  const wrangler = (args: string[], what: string) => must("pnpm", ["exec", "wrangler", ...args], what, { cwd: c.site as string });
  const lock = async (cwd: string) => {
    const at = await git(["rev-parse", "--git-path", "index.lock"], "git", cwd);
    if (existsSync(at.startsWith("/") ? at : join(cwd, at))) throw new Error(`${cwd}: .git/index.lock exists (another git command running, or one that crashed): nothing done`);
  };
  const siteProblems = async (): Promise<string[]> => {
    if (!c.site) return [`no site checkout (~/git/${SLUG}-site; KIKO_SITE)`];
    const problems: string[] = [];
    const branch = (await run("git", ["-C", c.site, "symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (branch !== c.siteBranch) problems.push(`the site's checkout (${c.site}) is on ${branch || "no branch"}, not ${c.siteBranch}`);
    const dirty = (await run("git", ["-C", c.site, "status", "--porcelain"])).stdout.split("\n").filter((l) => l.trim() && !/^\?\? node_modules\/?$/.test(l));
    if (dirty.length) problems.push(`the site's checkout isn't clean:\n    ${dirty.slice(0, 8).join("\n    ")}`);
    return problems;
  };

  // tmux's build cache from the main checkout (this one's, or the one this worktree belongs to):
  // a fresh worktree would otherwise build tmux from source for both chips (about 1.5 minutes).
  const buildCache = async () => join(dirname(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], "git rev-parse")), ".cache");

  return {
    async preflight() {
      const problems: string[] = [];
      // A dry run says what a real one would stop on, and goes on (it can try a branch).
      const say = (p: string) => (c.o.dryRun ? c.warnings.push(p) : problems.push(p));
      const branch = (await run("git", ["-C", c.repo, "symbolic-ref", "--short", "HEAD"])).stdout.trim();
      if (branch !== "main") say(`on ${branch || "a detached HEAD"}, not main`);
      await lock(c.repo);
      const dirty = (await git(["status", "--porcelain"], "git status")).split("\n").filter(Boolean);
      if (dirty.length) say(`the tree isn't clean (commit or stash first):\n    ${dirty.slice(0, 10).join("\n    ")}`);
      const pkg = pkgVersion(c.repo);
      if (c.o.version && compareVersions(c.o.version, pkg) < 0) problems.push(`${c.o.version} is older than package.json's ${pkg}`);

      // At once: origin, the live feed, wrangler's login.
      const [fetched, feed, login] = await Promise.all([
        run("git", ["-C", c.repo, "fetch", "-q", "origin", "main"], { timeoutMs: 60_000 }),
        curl(c, `${c.base}/latest.json`),
        c.o.dryRun || !c.site ? Promise.resolve(undefined) : run("pnpm", ["exec", "wrangler", "whoami"], { cwd: c.site, timeoutMs: 60_000 }),
      ]);
      if (fetched.code !== 0) say("couldn't fetch origin main (offline?)");
      else {
        const behind = Number((await git(["rev-list", "--count", "HEAD..origin/main"], "git rev-list")).trim());
        if (behind) say(`${branch || "HEAD"} is ${behind} commit${behind > 1 ? "s" : ""} behind origin/main: pull first`);
      }
      if (feed.code === 0) {
        try {
          c.liveVersion = (JSON.parse(feed.stdout) as { version: string }).version;
        } catch {
          say(`${c.base}/latest.json isn't JSON`);
        }
      } else if (feed.stderr.includes("404")) c.liveVersion = undefined;
      else say(`couldn't read ${c.base}/latest.json: ${safeLines(feed.stderr, 2)}`);
      if (c.liveVersion && compareVersions(c.version, c.liveVersion) <= 0)
        say(`${c.version} isn't newer than the live feed's ${c.liveVersion}${c.version === c.liveVersion ? " (already published)" : ""}: give a newer version`);
      for (const p of await siteProblems()) say(p);
      if (login && !/You are logged in/i.test(login.stdout)) problems.push("wrangler isn't logged in (in the site's checkout: pnpm exec wrangler login)");
      if (problems.length) throw new Error(`not shipping:\n  - ${problems.join("\n  - ")}`);
      const notes = [`${c.version}${c.liveVersion ? ` (live: ${c.liveVersion})` : ""}, ${c.o.mode} path${c.o.dryRun ? ", dry run" : ""}`];
      for (const w of c.warnings) notes.push(`warning: ${w}`);
      return notes.join("\n  ");
    },

    async "notary-status"() {
      const problems = scanStatuses(join(c.repo, "dist"))
        .map((s) => describeStatus(s))
        .filter((v) => v.level !== "ok");
      const loudOnes = problems.filter((v) => v.level === "problem").map((v) => v.line);
      if (loudOnes.length) console.log(loud(loudOnes));
      const pending = problems.filter((v) => v.level === "pending").map((v) => v.line);
      return [loudOnes.length ? `${loudOnes.length} to look at (above); shipping anyway` : "nothing to look at", ...pending].join("\n  ");
    },

    async version() {
      const pkg = pkgVersion(c.repo);
      if (c.version === pkg) return `${c.version} (package.json's)`;
      if (c.o.dryRun) return `${c.version}, built as it (package.json says ${pkg}; nothing committed)`;
      await lock(c.repo);
      const file = join(c.repo, "package.json");
      const text = readFileSync(file, "utf8");
      const next = text.replace(/("version":\s*")[^"]+(")/, `$1${c.version}$2`);
      if (next === text) throw new Error("couldn't find package.json's version");
      writeFileSync(file, next);
      await git(["commit", "-q", "-m", `package.json: ${c.version}`, "--", "package.json"], "git commit");
      return `package.json: ${pkg} → ${c.version}, committed (${(await git(["rev-parse", "--short", "HEAD"], "git")).trim()})`;
    },

    async worktree() {
      const dir = mkdtempSync(join(tmpdir(), `${SLUG}-ship-${c.version}-`));
      await git(["worktree", "add", "-q", "--detach", dir, "HEAD"], "git worktree add");
      c.worktree = dir;
      await must("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--silent"], "pnpm install", { cwd: dir, env: { CI: "1" } });
      return `${dir} at ${(await git(["rev-parse", "--short", "HEAD"], "git", dir)).trim()}`;
    },

    async checks() {
      return runChecks(c.worktree as string);
    },

    async smoke() {
      const r = await run("pnpm", ["-s", "smoke:binary"], { cwd: c.worktree, env: { KIKO_BUILD_CACHE: await buildCache(), KIKO_VERSION: c.version }, timeoutMs: SMOKE_TIMEOUT_MS });
      const said = `${r.stdout}\n${r.stderr}`.split("\n").filter((l) => /^ {2}(ok|FAILED|│) |^smoke: /.test(l));
      if (r.code !== 0)
        throw new Error(
          [`not building: the executable built for this Mac failed its smoke (pnpm smoke:binary; exit ${r.code})`, ...(said.length ? said : tail(`${r.stdout}\n${r.stderr}`))].join("\n  "),
        );
      return said.at(-1)?.replace(/^smoke: /, "") ?? "passed";
    },

    async build() {
      rmSync(c.dist, { recursive: true, force: true });
      mkdirSync(c.dist, { recursive: true });
      const env = releaseEnv(c.o, { dist: c.dist, cache: await buildCache(), version: c.version, notes: c.notes, base: c.base });
      const code = await stream("sh", ["scripts/release.sh"], { cwd: c.worktree as string, env });
      // (The full path's notarizing, inside release.sh, wrote dist/<version>/notary.json as it went, mode full.)
      if (code !== 0) throw new Error(`release.sh stopped (exit ${code}; above)`);
      return `dist: ${c.dist}`;
    },

    async check() {
      const feed = JSON.parse(readFileSync(join(c.dist, "latest.json"), "utf8")) as { version: string; assets: Record<string, { url: string; sha256: string }> };
      if (feed.version !== c.version) throw new Error(`latest.json says ${feed.version}, not ${c.version}`);
      const assets = await Promise.all(
        Object.entries(feed.assets).map(async ([key, a]) => {
          const file = basename(a.url);
          if (a.url !== `${c.base}/${file}`) throw new Error(`latest.json's ${key} is at ${a.url}, not under ${c.base}`);
          const sha = await sha256(join(c.dist, file));
          const listed = readFileSync(join(c.dist, `${file}.sha256`), "utf8").split(/\s+/)[0];
          if (sha !== a.sha256 || sha !== listed) throw new Error(`${file}: its SHA-256 ${sha} isn't latest.json's (${a.sha256}) and its .sha256's (${listed})`);
          return { arch: key.replace(/^darwin-/, ""), file, sha, url: a.url };
        }),
      );
      if (!assets.some((a) => a.arch === "arm64") || !assets.some((a) => a.arch === "x64")) c.warnings.push(`only ${assets.map((a) => a.arch).join(", ")} built`);
      c.assets = assets;
      return assets.map((a) => `${a.file} ${a.sha.slice(0, 12)}…`).join(", ");
    },

    async push() {
      // The release, findable later: the commit it was built from (the worktree's), tagged with its
      // notes. One already there (a ship run again after a failed upload) is kept as it is.
      const tag = releaseTag(c.version);
      const built = (await git(["rev-parse", "HEAD"], "git rev-parse", c.worktree)).trim();
      const tagged = (await run("git", ["-C", c.repo, "rev-parse", "-q", "--verify", `refs/tags/${tag}`])).code === 0;
      if (!tagged) await git(["tag", "-a", tag, "-m", c.notes, built], "git tag");
      const ahead = Number((await git(["rev-list", "--count", "origin/main..main"], "git rev-list")).trim());
      await git(["push", "-q", "origin", "main", `refs/tags/${tag}`], `git push origin main ${tag}`);
      return `${tagged ? `${tag} there already` : `tagged ${tag} (${built.slice(0, 8)})`}; ${ahead ? `pushed ${ahead} commit${ahead > 1 ? "s" : ""}` : "main was already on origin"}`;
    },

    async "upload-assets"() {
      const put = (name: string, type: string) =>
        wrangler(
          ["r2", "object", "put", `${c.bucket}/${name}`, "--file", join(c.dist, name), "--content-type", type, "--cache-control", "public, max-age=31536000, immutable", "--remote"],
          `uploading ${name}`,
        );
      await Promise.all(c.assets.flatMap((a) => [put(a.file, "application/gzip"), put(`${a.file}.sha256`, "text/plain; charset=utf-8")]));
      return `${c.assets.length * 2} files to ${c.bucket}`;
    },

    async "upload-feed"() {
      await wrangler(
        ["r2", "object", "put", `${c.bucket}/latest.json`, "--file", join(c.dist, "latest.json"), "--content-type", "application/json", "--cache-control", "no-cache", "--remote"],
        "uploading latest.json",
      );
      return `latest.json (${c.version}) to ${c.bucket}: published`;
    },

    async notarize() {
      const output = join(c.dist, "notary.log");
      const fd = openSync(output, "a");
      const child = spawn(process.execPath, [join(c.repo, "scripts", "signing", "notarize.ts"), "--dist", c.dist, "--mode", "fast", "--notify", "--output", output], {
        cwd: c.repo,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      closeSync(fd);
      child.unref();
      c.notaryPid = child.pid;
      const now = new Date().toISOString();
      // Written now too, so a status asked for at once finds it (the job writes over it as it goes).
      if (!readStatus(join(c.dist, STATUS_FILE)))
        writeStatus(join(c.dist, STATUS_FILE), { version: c.version, mode: "fast", state: "notarizing", pid: child.pid, started: now, updated: now, log: output });
      return `started (pid ${child.pid}); its output: ${output}`;
    },

    async site() {
      const mine = readFileSync(join(c.worktree as string, "install.sh"), "utf8");
      const siteFile = c.site ? join(c.site, "public", "install.sh") : "";
      const inSite = siteFile && existsSync(siteFile) ? readFileSync(siteFile, "utf8") : "";
      const live = await curl(c, `${new URL(c.base).origin}/install.sh`);
      const liveSame = live.code === 0 && live.stdout === mine;
      const siteSame = inSite === mine;
      if (siteSame && liveSame) return "install.sh unchanged: the site isn't touched";
      if (c.o.dryRun) return `install.sh changed: would ${siteSame ? "" : `copy it to ${siteFile}, commit and push ${c.siteBranch}, then `}deploy the site`;
      const site = c.site as string;
      const done: string[] = [];
      if (!siteSame) {
        await lock(site);
        writeFileSync(siteFile, mine);
        const sha = (await git(["rev-parse", "--short", "HEAD"], "git", c.worktree)).trim();
        await git(["add", "public/install.sh"], "git add", site);
        await git(["commit", "-q", "-m", `install.sh from ${NAME} ${c.version} (${sha})`], "git commit", site);
        done.push("copied and committed");
      }
      const ahead = Number((await run("git", ["-C", site, "rev-list", "--count", `origin/${c.siteBranch}..${c.siteBranch}`])).stdout.trim() || "0");
      if (ahead) {
        await git(["push", "-q", "origin", c.siteBranch], `git push origin ${c.siteBranch}`, site);
        done.push(`pushed ${c.siteBranch}`);
      }
      if (!liveSame) {
        const out = await wrangler(["deploy"], "wrangler deploy");
        const id = /Current Version ID:\s*(\S+)/.exec(out)?.[1];
        done.push(`deployed${id ? ` (version ${id})` : ""}`);
      }
      return `install.sh changed: ${done.join(", ")}`;
    },

    async verify() {
      const feed = await curl(c, `${c.base}/latest.json`);
      if (feed.code !== 0) throw new Error(`couldn't read ${c.base}/latest.json from outside`);
      const live = JSON.parse(feed.stdout) as { version: string; assets: Record<string, { sha256: string }> };
      if (live.version !== c.version) throw new Error(`${c.base}/latest.json says ${live.version}, not ${c.version}`);
      const tmp = mkdtempSync(join(tmpdir(), `${SLUG}-verify-`));
      try {
        await Promise.all(
          c.assets.map(async (a) => {
            if (live.assets[`darwin-${a.arch}`]?.sha256 !== a.sha) throw new Error(`the live feed's ${a.arch} SHA-256 isn't the one built`);
            const got = await curl(c, a.url, ["-o", join(tmp, a.file)]);
            if (got.code !== 0) throw new Error(`couldn't download ${a.url}`);
            if ((await sha256(join(tmp, a.file))) !== a.sha) throw new Error(`${a.url} isn't the file built`);
            const listed = await curl(c, `${a.url}.sha256`);
            if (listed.stdout.split(/\s+/)[0] !== a.sha) throw new Error(`${a.url}.sha256 isn't the one built`);
          }),
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      const mine = readFileSync(join(c.worktree as string, "install.sh"), "utf8");
      const origin = new URL(c.base).origin;
      const [root, named] = await Promise.all([curl(c, `${origin}/`), curl(c, `${origin}/install.sh`)]);
      if (root.stdout !== mine || named.stdout !== mine)
        throw new Error(`${origin} doesn't serve this install.sh (/: ${root.stdout === mine ? "same" : "different"}, /install.sh: ${named.stdout === mine ? "same" : "different"})`);
      return `latest.json ${live.version}; ${c.assets.map((a) => a.arch).join(", ")}: feed == .sha256 == download; install.sh served at / and /install.sh`;
    },
  };
}

async function cleanup(c: Ctx): Promise<void> {
  if (c.auth?.dir) rmSync(c.auth.dir, { recursive: true, force: true });
  if (!c.worktree) return;
  const r = await run("git", ["-C", c.repo, "worktree", "remove", "--force", c.worktree]);
  if (r.code !== 0) console.error(`ship: couldn't remove the worktree ${c.worktree}: ${safeLines(r.stderr, 3)}`);
}

async function notarizeAgain(repo: string, version: string | undefined): Promise<number> {
  const v = version ?? scanStatuses(join(repo, "dist"))[0]?.version;
  if (!v) {
    console.error("release:notarize: which version? (no dist/<version>/notary.json here)");
    return 2;
  }
  const dist = join(repo, "dist", v);
  if (!existsSync(join(dist, "latest.json"))) {
    console.error(`release:notarize: no ${dist}/latest.json: nothing packed for ${v} here`);
    return 1;
  }
  return await new Promise((resolve) => {
    spawn(process.execPath, [join(repo, "scripts", "signing", "notarize.ts"), "--dist", dist, "--mode", "fast"], { cwd: repo, stdio: "inherit" }).on("close", (code) => resolve(code ?? 1));
  });
}

async function main(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`ship: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const repo = join(import.meta.dirname, "..", "..");
  if (o.command === "notarize") return notarizeAgain(repo, o.version);

  const version = o.version ?? pkgVersion(repo);
  const base = (process.env.KIKO_RELEASES_URL || RELEASES_URL).replace(/\/$/, "");
  const c: Ctx = {
    repo,
    o,
    version,
    notes: o.notes ?? `${NAME} ${version}`,
    base,
    dist: o.dryRun ? join(repo, "dist", "dry-run", version) : join(repo, "dist", version),
    bucket: process.env.KIKO_R2_BUCKET || "kiko-releases",
    siteBranch: process.env.KIKO_SITE_BRANCH || "main",
    site: findSite(),
    assets: [],
    warnings: [],
  };
  const start = Date.now();
  console.log(`pnpm ship ${version}: the ${o.mode} path${o.dryRun ? ", dry run (nothing leaves this Mac)" : ""}`);
  let outcome: Awaited<ReturnType<typeof runSteps>>;
  try {
    outcome = await runSteps(plan({ ...o, version: o.version }), realSteps(c), { say: (l) => console.log(l), now: () => Date.now() });
  } finally {
    await cleanup(c);
  }
  const head = outcome.ok ? `Shipped ${version}${o.dryRun ? " (dry run: nothing published)" : ""}` : `Stopped at ${outcome.results.at(-1)?.name}`;
  console.log(`\n${summary(head, outcome.results, Date.now() - start)}`);
  if (!outcome.ok) {
    console.error(`\nship: ${outcome.error?.message}`);
    const published = outcome.results.some((r) => r.name === "upload-feed" && r.outcome === "done");
    if (published) console.error(`(${version} is published: what's left can be done by hand, RELEASING.md)`);
    return 1;
  }
  if (c.warnings.length) console.log(`Warnings:\n  ${c.warnings.join("\n  ")}`);
  if (!o.dryRun && o.mode === "fast") console.log(`Notarization: in the background (pid ${c.notaryPid}); a notification when it ends; pnpm release:status`);
  if (!o.dryRun && o.mode === "full") {
    const s = readStatus(join(c.dist, STATUS_FILE));
    console.log(`Notarization: ${s ? describeStatus(s as NotaryStatus).line : "done before packing"}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
