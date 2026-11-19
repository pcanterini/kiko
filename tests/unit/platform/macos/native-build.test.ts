// Building a helper in a checkout (src/platform/macos/native.ts buildNative): what the compiler says
// (macOS 27's deprecation warnings once filled the window's list while the player was built) goes to
// the build log, never the terminal it runs in; a build that fails is one line naming that log. Run in
// a process of its own, its stdout and stderr read whole, with a stand-in for swiftc: nothing real is built.
import "../../../setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "kiko-native-build-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const native = pathToFileURL(join(import.meta.dirname, "../../../../src/platform/macos/native.ts")).href;

/** A stand-in swiftc: says what swiftc says on macOS 27 (a warning, with its source line), makes `-o`'s file, and exits with `status`. */
function compiler(name: string, status: number) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
echo "/x/native/macos/player.swift:334:12: warning: 'play()' was deprecated in macOS 27.0 [#DeprecatedDeclaration]" >&2
echo "    player.play()" >&2
echo "compiling…"
while [ $# -gt 0 ]; do [ "$1" = -o ] && { shift; : > "$1"; }; shift; done
exit ${status}
`,
    { mode: 0o755 },
  );
  return path;
}

/** buildNative("presence") into a folder of its own with `swiftc`, in a process of its own: what it printed, and what it returned or threw. */
function build(swiftc: string, logs: string) {
  const into = mkdtempSync(join(dir, "bin-"));
  const script = `
    const { buildNative, HelperBuildError } = await import(${JSON.stringify(native)});
    try {
      const path = buildNative("presence", { into: ${JSON.stringify(into)}, compiler: ${JSON.stringify(swiftc)} });
      process.stdout.write("RESULT " + JSON.stringify({ path }));
    } catch (err) {
      process.stdout.write("RESULT " + JSON.stringify({ error: err.message, clean: err instanceof HelperBuildError }));
    }`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, KIKO_LOG_DIR: logs } });
  const [said, result] = run.stdout.split("RESULT ");
  return { said, stderr: run.stderr, result: JSON.parse(result ?? "{}") as { path?: string; error?: string; clean?: boolean }, into };
}

test('built: nothing on its stdout or stderr (no "Building…" line, no warnings); every word of the compiler\'s in the build log', () => {
  const logs = join(dir, "logs-ok");
  const { said, stderr, result, into } = build(compiler("swiftc-ok", 0), logs);
  assert.equal(said, "", "nothing on stdout but the result");
  assert.equal(stderr, "");
  assert.equal(result.path, join(into, "presence"));
  assert.ok(existsSync(result.path!));
  const log = readFileSync(join(logs, "native-build.log"), "utf8");
  assert.match(log, /presence: built in \d+ ms/);
  assert.ok(log.includes("warning: 'play()' was deprecated in macOS 27.0") && log.includes("compiling…"), log);
});

test("a build that fails: one line, naming the log (from ~ when it's under it), and still nothing of the compiler's on the terminal", () => {
  const logs = join(dir, "logs-failed");
  const { said, stderr, result } = build(compiler("swiftc-bad", 1), logs);
  assert.equal(said, "");
  assert.equal(stderr, "");
  assert.equal(result.clean, true, "a HelperBuildError: said as it is, no stack");
  assert.ok(!result.error!.includes("\n"), "one line");
  assert.match(result.error!, /^couldn't build the presence helper \(what .*swiftc-bad said is in .*native-build\.log\)$/);
  const log = readFileSync(join(logs, "native-build.log"), "utf8");
  assert.match(log, /presence: failed \(exit 1\)/);
  assert.ok(log.includes("warning: 'play()' was deprecated"), log);
});

test("no compiler at all: says what to install, in one line", () => {
  const { said, stderr, result } = build(join(dir, "no-such-swiftc"), join(dir, "logs-none"));
  assert.equal(said + stderr, "");
  assert.equal(result.clean, true);
  assert.match(result.error!, /^couldn't build the presence helper: .*no-such-swiftc isn't installed \(it comes with Xcode or its Command Line Tools\)$/);
});
