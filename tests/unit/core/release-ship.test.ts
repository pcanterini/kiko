// `pnpm ship` (scripts/ship/ship.ts) and its notarization status (scripts/ship/status.ts,
// scripts/signing/notarize.ts), without Apple, R2 or git: the flags, the order of the steps on each
// path (the fast one publishes before notarizing, the full one notarizes inside the build, before
// packing; a dry run skips whatever leaves the Mac), the runner on stand-in steps, the status file
// and how it's told, and notarizing on stand-ins for notarytool, the ticket check and Gatekeeper.
import "../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CHECKS, type CheckRun, checkResult, parseArgs, plan, releaseEnv, releaseTag, runChecks, runSteps, type StepName, safeLines, summary } from "../../../scripts/ship/ship.ts";
import { compareVersions, describeStatus, type NotaryStatus, readStatus, report, scanStatuses, writeStatus } from "../../../scripts/ship/status.ts";
import { type NotarizeDeps, notarize, signedFiles, unpackDist } from "../../../scripts/signing/notarize.ts";

const names = (steps: { name: StepName }[]) => steps.map((s) => s.name);
const before = (list: string[], a: string, b: string) => {
  assert.ok(list.includes(a) && list.includes(b), `${a} and ${b} in ${list.join(", ")}`);
  assert.ok(list.indexOf(a) < list.indexOf(b), `${a} before ${b} in ${list.join(", ")}`);
};

describe("pnpm ship's flags", () => {
  test("fast by default; --full, KIKO_RELEASE=full, --fast over the environment", () => {
    assert.equal(parseArgs([], {}).mode, "fast");
    assert.equal(parseArgs(["--full"], {}).mode, "full");
    assert.equal(parseArgs([], { KIKO_RELEASE: "full" }).mode, "full");
    assert.equal(parseArgs(["--fast"], { KIKO_RELEASE: "full" }).mode, "fast");
    assert.throws(() => parseArgs([], { KIKO_RELEASE: "slow" }), /fast or full/);
  });

  test("a version, a dry run, notes", () => {
    const o = parseArgs(["0.2.3", "--dry-run", "--notes", "a line"], {});
    assert.deepEqual([o.version, o.dryRun, o.notes, o.command], ["0.2.3", true, "a line", "ship"]);
    assert.equal(parseArgs(["v1.0.0"], {}).version, "1.0.0");
    assert.equal(parseArgs(["--notes=x y"], {}).notes, "x y");
    assert.equal(parseArgs([], { KIKO_RELEASE_NOTES: "from env" }).notes, "from env");
    assert.equal(parseArgs(["--", "0.3.0"], {}).version, "0.3.0");
  });

  test("refuses what it doesn't know", () => {
    assert.throws(() => parseArgs(["1.2"], {}), /x\.y\.z/);
    assert.throws(() => parseArgs(["0.2.3", "0.2.4"], {}), /one version/);
    assert.throws(() => parseArgs(["--publish"], {}), /unknown option/);
    assert.throws(() => parseArgs(["--notes"], {}), /needs a line/);
  });

  test("release:notarize [version]", () => {
    const o = parseArgs(["notarize", "0.2.3"], {});
    assert.deepEqual([o.command, o.version], ["notarize", "0.2.3"]);
  });
});

describe("the order of the steps", () => {
  test("fast: built and checked, main pushed, files before the feed, notarizing only after publishing", () => {
    const steps = plan({ mode: "fast", dryRun: false, version: "0.2.3" });
    const list = names(steps);
    assert.ok(steps.every((s) => !s.skip));
    for (const [a, b] of [
      ["preflight", "version"],
      ["version", "worktree"],
      ["worktree", "checks"],
      ["checks", "smoke"],
      ["smoke", "build"],
      ["build", "check"],
      ["check", "push"],
      ["push", "upload-assets"],
      ["upload-assets", "upload-feed"],
      ["upload-feed", "notarize"],
      ["upload-feed", "site"],
      ["site", "verify"],
    ])
      before(list, a, b);
    assert.match(steps.find((s) => s.name === "notarize")?.what ?? "", /background/);
    assert.doesNotMatch(steps.find((s) => s.name === "build")?.what ?? "", /notarize/);
    assert.equal(releaseEnv({ mode: "fast", dryRun: false }, { dist: "d", cache: "c", version: "0.2.3", notes: "n", base: "b" }).KIKO_NOTARIZE, "later");
  });

  test("full: notarized and Gatekeeper waited for inside the build, before anything's published; no background job", () => {
    const steps = plan({ mode: "full", dryRun: false });
    const list = names(steps);
    assert.ok(!list.includes("notarize"));
    assert.match(steps.find((s) => s.name === "build")?.what ?? "", /notarize, wait for Gatekeeper, pack/);
    before(list, "build", "upload-assets");
    before(list, "upload-assets", "upload-feed");
    const env = releaseEnv({ mode: "full", dryRun: false }, { dist: "d", cache: "c", version: "0.2.3", notes: "n", base: "b" });
    assert.equal(env.KIKO_NOTARIZE, "now");
    assert.equal(env.KIKO_RELEASE, "full");
  });

  test("a dry run: every local step runs; push, uploads, notarizing and the outside check are skipped", () => {
    for (const mode of ["fast", "full"] as const) {
      const steps = plan({ mode, dryRun: true });
      const skipped = steps.filter((s) => s.skip).map((s) => s.name);
      assert.deepEqual(skipped, mode === "fast" ? ["push", "upload-assets", "upload-feed", "notarize", "verify"] : ["push", "upload-assets", "upload-feed", "verify"]);
      for (const local of ["preflight", "notary-status", "version", "worktree", "checks", "smoke", "build", "check", "site"])
        assert.ok(names(steps).includes(local as StepName) && !skipped.includes(local as StepName), local);
      assert.match(steps.find((s) => s.name === "site")?.what ?? "", /nothing synced or deployed/);
      // Nothing is sent to Apple on a dry run, even on the full path.
      assert.equal(releaseEnv({ mode, dryRun: true }, { dist: "d", cache: "c", version: "1.0.0", notes: "n", base: "b" }).KIKO_NOTARIZE, "later");
    }
  });

  test("a version given is committed; a dry run commits nothing", () => {
    assert.match(plan({ mode: "fast", dryRun: false, version: "0.2.3" }).find((s) => s.name === "version")?.what ?? "", /committed/);
    assert.match(plan({ mode: "fast", dryRun: true, version: "0.2.3" }).find((s) => s.name === "version")?.what ?? "", /nothing committed/);
  });

  test("a release is tagged v<version> as it's pushed (A5); a dry run tags nothing", () => {
    assert.equal(releaseTag("0.3.2"), "v0.3.2");
    const push = (dryRun: boolean) => plan({ mode: "fast", dryRun, version: "0.3.2" }).find((s) => s.name === "push");
    assert.match(push(false)?.what ?? "", /tag the built commit v<version>.*push main and the tag/);
    assert.equal(push(true)?.skip, "dry run");
  });
});

describe("running the steps", () => {
  function clock() {
    let t = 0;
    return { now: () => t, tick: (ms: number) => (t += ms) };
  }

  test("in order, each timed; skipped ones aren't run", async () => {
    const ran: string[] = [];
    const time = clock();
    const steps = plan({ mode: "fast", dryRun: true });
    const impl = Object.fromEntries(
      names(steps).map((n) => [
        n,
        async () => {
          ran.push(n);
          time.tick(1000);
          return n === "build" ? "dist: x" : undefined;
        },
      ]),
    );
    const said: string[] = [];
    const out = await runSteps(steps, impl, { say: (l) => said.push(l), now: time.now });
    assert.equal(out.ok, true);
    assert.deepEqual(ran, ["preflight", "notary-status", "version", "worktree", "checks", "smoke", "build", "check", "site"]);
    assert.deepEqual(
      out.results.filter((r) => r.outcome === "done").map((r) => r.ms),
      ran.map(() => 1000),
    );
    assert.equal(out.results.find((r) => r.name === "upload-feed")?.outcome, "skipped");
    assert.ok(said.includes("  dist: x"));
    assert.match(summary("Shipped 0.2.3", out.results, 7000), /^Shipped 0\.2\.3 in 7\.0s\n {2}preflight/);
  });

  test("the first failure stops the rest: nothing is published after a failed build", async () => {
    const ran: string[] = [];
    const steps = plan({ mode: "fast", dryRun: false });
    const impl = Object.fromEntries(
      names(steps).map((n) => [
        n,
        async () => {
          ran.push(n);
          if (n === "build") throw new Error("release.sh stopped");
        },
      ]),
    );
    const out = await runSteps(steps, impl, { say: () => {}, now: () => 0 });
    assert.equal(out.ok, false);
    assert.equal(out.error?.message, "release.sh stopped");
    assert.deepEqual(ran, ["preflight", "notary-status", "version", "worktree", "checks", "smoke", "build"]);
    assert.equal(out.results.at(-1)?.outcome, "failed");
    assert.match(summary("Stopped at build", out.results, 1000), /build .* FAILED: release\.sh stopped/);
  });

  test("a failed upload of the files never gets to the feed or notarizing", async () => {
    const ran: string[] = [];
    const steps = plan({ mode: "fast", dryRun: false });
    const impl = Object.fromEntries(
      names(steps).map((n) => [
        n,
        async () => {
          ran.push(n);
          if (n === "upload-assets") throw new Error("R2 said no");
        },
      ]),
    );
    await runSteps(steps, impl, { say: () => {}, now: () => 0 });
    assert.equal(ran.at(-1), "upload-assets");
    assert.ok(!ran.includes("upload-feed") && !ran.includes("notarize"));
  });

  test("what wrangler says is shown without anything naming an account", () => {
    const text = "Uploaded my-site (4.14 sec)\nYou are logged in with an OAuth Token, associated with the email someone@example.com.\nAPI token: abc\nDeployed my-site triggers";
    assert.equal(safeLines(text), "Uploaded my-site (4.14 sec)\nDeployed my-site triggers");
  });
});

describe("the checks before building (the type check and the unit tests)", () => {
  // What node --test and tsc print, cut down.
  const passed = "✔ a test (1ms)\nℹ tests 4586\nℹ suites 737\nℹ pass 4585\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 63855\n";
  const failed = [
    "✖ saves whole (2ms)",
    "ℹ tests 3",
    "ℹ pass 2",
    "ℹ fail 1",
    "ℹ skipped 0",
    "",
    "✖ failing tests:",
    "",
    "test at ../../tests/unit/core/json-file.test.ts:12:3",
    "✖ saves whole (2.5ms)",
    "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    "      at TestContext.<anonymous> (file:///x/json-file.test.ts:14:10)",
  ].join("\n");
  const tscFailed = "src/core/settings.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n";

  /** Stands in for pnpm: what each check prints and exits with, and what was asked, where. */
  function stand(o: Partial<Record<"typecheck" | "test", { code: number; stdout: string }>>) {
    const asked: string[] = [];
    const exec: CheckRun = async (cmd, args, cwd) => {
      asked.push(`${cmd} ${args.join(" ")} in ${cwd}`);
      const r = o[args[0] as "typecheck" | "test"] ?? { code: 0, stdout: args[0] === "test" ? passed : "" };
      return { ...r, stderr: "" };
    };
    return { exec, asked };
  }

  test("the project's own commands, in the worktree", () => {
    assert.deepEqual(
      CHECKS.map((c) => `${c.cmd} ${c.args.join(" ")}`),
      ["pnpm typecheck", "pnpm test"],
    );
  });

  test("both pass: a line each with its time, nothing else", async () => {
    const { exec, asked } = stand({});
    let t = 0;
    const note = await runChecks("/wt", exec, () => (t += 500));
    assert.deepEqual(asked, ["pnpm typecheck in /wt", "pnpm test in /wt"]);
    assert.match(note, /^typecheck: passed \(\d+\.\ds\)\n {2}tests: 4585 of 4586 passed, 1 skipped \(\d+\.\ds\)$/);
  });

  test("a failing test stops it: which one and why, without its stack", async () => {
    const { exec } = stand({ test: { code: 1, stdout: failed } });
    await assert.rejects(runChecks("/wt", exec), (e: Error) => {
      assert.match(e.message, /^not building: the tests failed at HEAD/);
      assert.match(e.message, /typecheck: passed/);
      assert.match(e.message, /tests: FAILED, 2 of 3 passed, 1 failed/);
      assert.match(e.message, /✖ saves whole {2}\(tests\/unit\/core\/json-file\.test\.ts:12:3\)\n {6}AssertionError/);
      assert.doesNotMatch(e.message, /TestContext/);
      return true;
    });
  });

  test("a type error stops it, with tsc's line; a check that dies without a summary says its exit and last lines", async () => {
    const { exec } = stand({ typecheck: { code: 2, stdout: tscFailed }, test: { code: 1, stdout: "Error: Cannot find module 'x'\n" } });
    await assert.rejects(runChecks("/wt", exec), (e: Error) => {
      assert.match(e.message, /^not building: the type check and the tests failed/);
      assert.match(e.message, /typecheck: FAILED, 1 error/);
      assert.match(e.message, /settings\.ts\(12,3\): error TS2322/);
      assert.match(e.message, /tests: FAILED \(exit 1\)/);
      assert.match(e.message, /Cannot find module 'x'/);
      return true;
    });
    // Exit 0 with failures counted (or no summary at all) isn't a pass either.
    assert.equal(checkResult("tests", { code: 0, stdout: failed, stderr: "" }).ok, false);
    assert.equal(checkResult("tests", { code: 0, stdout: "", stderr: "" }).ok, false);
  });

  test("ship stops at the checks: nothing is built, pushed or published (a dry run too)", async () => {
    for (const dryRun of [false, true]) {
      const ran: string[] = [];
      const { exec } = stand({ test: { code: 1, stdout: failed } });
      const steps = plan({ mode: "fast", dryRun, version: "0.3.2" });
      const impl = Object.fromEntries(
        names(steps).map((n) => [
          n,
          async () => {
            ran.push(n);
            if (n === "checks") return runChecks("/wt", exec);
          },
        ]),
      );
      const out = await runSteps(steps, impl, { say: () => {}, now: () => 0 });
      assert.equal(out.ok, false);
      assert.deepEqual(ran, ["preflight", "notary-status", "version", "worktree", "checks"]);
      assert.match(summary("Stopped at checks", out.results, 1000), /checks .* FAILED: not building: the tests failed/);
    }
  });

  test("a real command that fails is a failure (a stand-in package, no pnpm, nothing built)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-checks-"));
    const exec: CheckRun = async (_cmd, args, cwd) => {
      const r = spawnSync(process.execPath, ["-e", args[0] === "test" ? "console.log('ℹ tests 1\\nℹ pass 0\\nℹ fail 1'); process.exit(1)" : ""], { cwd, encoding: "utf8" });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    };
    await assert.rejects(runChecks(dir, exec), /tests: FAILED, 0 of 1 passed, 1 failed/);
  });
});

describe("the notarization status file", () => {
  const base: NotaryStatus = { version: "0.2.3", mode: "fast", state: "notarizing", pid: 1, started: "2026-11-02T10:00:00Z", updated: "2026-11-02T10:00:00Z" };

  test("written whole and read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const file = join(dir, "notary.json");
    writeStatus(file, base);
    assert.deepEqual(readStatus(file), base);
    writeFileSync(file, "{ half");
    assert.equal(readStatus(file), undefined);
    assert.equal(readStatus(join(dir, "none.json")), undefined);
  });

  test("how each state is told", () => {
    const running = () => true;
    const dead = () => false;
    assert.equal(describeStatus({ ...base, state: "ok" }, running).level, "ok");
    assert.equal(describeStatus(base, running).level, "pending");
    assert.equal(describeStatus({ ...base, state: "gatekeeper" }, running).level, "pending");
    const stopped = describeStatus({ ...base, state: "checking" }, dead);
    assert.equal(stopped.level, "problem");
    assert.match(stopped.line, /STOPPED.*pnpm release:notarize 0\.2\.3/);
    const rejected = describeStatus({ ...base, state: "rejected", message: "Apple's notary service said: Invalid", log: "/d/notary-log.json" }, running);
    assert.equal(rejected.level, "problem");
    assert.match(rejected.line, /REJECTED.*Invalid.*stays published.*\/d\/notary-log\.json/);
    assert.match(describeStatus({ ...base, state: "failed", message: "Gatekeeper still refuses" }, running).line, /FAILED.*Gatekeeper still refuses.*release:notarize/);
  });

  test("every release under dist/, newest first; a rejection is loud", () => {
    const dist = mkdtempSync(join(tmpdir(), "dist-"));
    for (const [v, state] of [
      ["0.2.9", "ok"],
      ["0.2.10", "rejected"],
      ["0.2.8", "ok"],
    ] as const) {
      mkdirSync(join(dist, v));
      writeStatus(join(dist, v, "notary.json"), { ...base, version: v, state });
    }
    mkdirSync(join(dist, "dry-run"));
    const found = scanStatuses(dist);
    assert.deepEqual(
      found.map((s) => s.version),
      ["0.2.10", "0.2.9", "0.2.8"],
    );
    const { text, problems } = report(found, () => true);
    assert.equal(problems, 1);
    assert.match(text, /^!{78}\n!!! NOTARIZATION NEEDS A LOOK\n!!! 0\.2\.10: Apple REJECTED/);
    assert.equal(report([], () => true).problems, 0);
    assert.equal(scanStatuses(join(dist, "nothing")).length, 0);
  });

  test("versions compare as numbers", () => {
    assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
    assert.equal(compareVersions("0.2.2", "0.2.2"), 0);
    assert.equal(compareVersions("0.2.2", "1.0.0"), -1);
  });
});

describe("notarizing (stand-ins for Apple and Gatekeeper)", () => {
  function deps(o: { status?: string; tickets?: boolean; gatekeeper?: boolean; log?: boolean } = {}) {
    const calls: string[] = [];
    const statuses: NotaryStatus[] = [];
    const notes: string[] = [];
    let t = 0;
    const d: NotarizeDeps = {
      zip: () => calls.push("zip"),
      submit: () => {
        calls.push("submit");
        return { status: o.status ?? "Accepted", id: "sub-1" };
      },
      fetchLog: (_id, out) => {
        calls.push(`log ${out}`);
        return o.log ?? true;
      },
      tickets: () => {
        calls.push("tickets");
        return o.tickets ?? true;
      },
      gatekeeper: () => {
        calls.push("gatekeeper");
        return o.gatekeeper ?? true;
      },
      status: (s) => statuses.push({ ...s }),
      notify: (_title, message) => notes.push(message),
      say: () => {},
      now: () => new Date(Date.UTC(2026, 10, 2, 12, 0, t++)),
    };
    return { d, calls, statuses, notes };
  }
  const opts = { version: "0.2.3", mode: "fast" as const, root: "/r", work: "/w", logOut: "/dist/0.2.3/notary-log.json", notify: true };

  test("accepted: the ticket checked, then Gatekeeper; each step in the status; notified", async () => {
    const { d, calls, statuses, notes } = deps();
    const s = await notarize(opts, ["/r/arm64/kiko-0.2.3/kiko"], d);
    assert.equal(s.state, "ok");
    assert.deepEqual(calls, ["zip", "submit", "log /w/notary-log.json", "tickets", "gatekeeper"]);
    assert.deepEqual(
      statuses.map((x) => x.state),
      ["notarizing", "checking", "gatekeeper", "ok"],
    );
    assert.equal(statuses.at(-1)?.submission, "sub-1");
    assert.equal(statuses.at(-1)?.pid, undefined);
    assert.equal(statuses[0].pid, process.pid);
    assert.deepEqual(notes, ["Notarized; Gatekeeper accepts it."]);
  });

  test("rejected: Apple's log kept beside the release, nothing else asked, loudly notified", async () => {
    const { d, calls, statuses, notes } = deps({ status: "Invalid" });
    const s = await notarize(opts, ["/r/arm64/kiko-0.2.3/kiko"], d);
    assert.equal(s.state, "rejected");
    assert.equal(s.log, opts.logOut);
    assert.match(s.message ?? "", /Invalid/);
    assert.deepEqual(calls, ["zip", "submit", `log ${opts.logOut}`]);
    assert.equal(statuses.at(-1)?.state, "rejected");
    assert.match(notes[0], /REJECTED/);
  });

  test("no answer from Apple (offline, no profile) isn't a rejection: failed, to be tried again", async () => {
    const { d, calls } = deps({ status: "" });
    const s = await notarize(opts, [], d);
    assert.equal(s.state, "failed");
    assert.match(s.message ?? "", /couldn't submit/);
    assert.deepEqual(calls, ["zip", "submit"]);
  });

  test("a ticket not served, or Gatekeeper still refusing: failed", async () => {
    const tickets = deps({ tickets: false });
    assert.equal((await notarize(opts, [], tickets.d)).state, "failed");
    assert.ok(!tickets.calls.includes("gatekeeper"));
    const gate = deps({ gatekeeper: false });
    const s = await notarize(opts, [], gate.d);
    assert.equal(s.state, "failed");
    assert.match(s.message ?? "", /Gatekeeper/);
    assert.match(gate.notes[0], /failed/);
  });

  test("the signed files of a release: each chip's kiko, helpers, tmux and helper app", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    for (const arch of ["x64", "arm64"]) {
      mkdirSync(join(root, arch, "kiko-0.2.3", "native"), { recursive: true });
      mkdirSync(join(root, arch, "kiko-0.2.3", "bin"));
      mkdirSync(join(root, arch, "kiko-0.2.3", "Kiko.app", "Contents"), { recursive: true });
      for (const f of ["kiko", "native/presence", "native/keychain", "bin/tmux"]) writeFileSync(join(root, arch, "kiko-0.2.3", f), "");
    }
    assert.deepEqual(
      signedFiles(root, "0.2.3").map((f) => f.slice(root.length + 1)),
      [
        "arm64/kiko-0.2.3/kiko",
        "arm64/kiko-0.2.3/native/keychain",
        "arm64/kiko-0.2.3/native/presence",
        "arm64/kiko-0.2.3/bin/tmux",
        "arm64/kiko-0.2.3/Kiko.app",
        "x64/kiko-0.2.3/kiko",
        "x64/kiko-0.2.3/native/keychain",
        "x64/kiko-0.2.3/native/presence",
        "x64/kiko-0.2.3/bin/tmux",
        "x64/kiko-0.2.3/Kiko.app",
      ],
    );
  });

  test("a packed release unpacked from its latest.json, chip by chip (the fast path's background job)", () => {
    const dist = mkdtempSync(join(tmpdir(), "dist-"));
    const src = mkdtempSync(join(tmpdir(), "src-"));
    mkdirSync(join(src, "kiko-0.2.3", "native"), { recursive: true });
    writeFileSync(join(src, "kiko-0.2.3", "kiko"), "x");
    assert.equal(spawnSync("tar", ["-C", src, "-czf", join(dist, "kiko-0.2.3-darwin-arm64.tar.gz"), "kiko-0.2.3"]).status, 0);
    writeFileSync(join(dist, "latest.json"), JSON.stringify({ version: "0.2.3", assets: { "darwin-arm64": { url: "https://kiko.sh/releases/kiko-0.2.3-darwin-arm64.tar.gz", sha256: "" } } }));
    const root = join(mkdtempSync(join(tmpdir(), "un-")), "release");
    assert.deepEqual(unpackDist(dist, root), { version: "0.2.3" });
    assert.equal(spawnSync("cat", [join(root, "arm64", "kiko-0.2.3", "kiko")], { encoding: "utf8" }).stdout, "x");
  });
});
