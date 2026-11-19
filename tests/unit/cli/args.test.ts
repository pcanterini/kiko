// `kiko`'s command line (src/cli-args.ts): options only before the command, read strictly, the
// GNU/POSIX way; an unknown one is a usage error with what was probably meant; everything after
// `claude` goes to Claude Code untouched.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { closest, parseCli, USAGE, version } from "../../../src/cli-args.ts";
import { COMMAND } from "../../../src/core/name.ts";

const run = (command: string | undefined, args: string[] = []) => ({ kind: "run", command, args });

describe("kiko's options", () => {
  test("none: the window", () => {
    assert.deepEqual(parseCli([]), run(undefined));
  });
  test("--no-tmux and --tmux are gone: Kiko always runs as its window, in its tmux", () => {
    assert.deepEqual(parseCli(["--no-tmux"]), { kind: "error", message: "unknown option --no-tmux" });
    assert.deepEqual(parseCli(["--tmux"]), { kind: "error", message: "unknown option --tmux" });
    assert.ok(!/--(no-)?tmux|KIKO_TMUX|Use tmux/.test(USAGE), "not in the usage");
  });
  test("-h and --help: the usage; -V and --version: package.json's version", () => {
    for (const a of [["-h"], ["--help"], ["help"], ["--key", "F12", "-h"], ["-h", "ls"]]) assert.deepEqual(parseCli(a), { kind: "help" }, a.join(" "));
    for (const a of [["-V"], ["--version"], ["--key", "F12", "--version"]]) assert.deepEqual(parseCli(a), { kind: "version" }, a.join(" "));
    assert.deepEqual(parseCli(["-hV"]), { kind: "help" }, "short options cluster");
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    assert.equal(version(), pkg.version);
  });
  test("the usage lists every command and option", () => {
    for (const word of ["claude [args…]", "attach [name]", "ls", "trust-scratch", "--key <key>", "-h, --help", "-V, --version"]) assert.ok(USAGE.includes(word), word);
  });
  test("an unknown option: an error, with what was probably meant", () => {
    assert.deepEqual(parseCli(["--hlep"]), { kind: "error", message: "unknown option --hlep. Did you mean --help?" });
    assert.deepEqual(parseCli(["--verison"]), { kind: "error", message: "unknown option --verison. Did you mean --version?" });
    assert.deepEqual(parseCli(["--settings"]), { kind: "error", message: "unknown option --settings" }, "nothing close: no guess");
    assert.deepEqual(parseCli(["-x"]), { kind: "error", message: "unknown option -x" });
    assert.deepEqual(parseCli(["-hx"]), { kind: "error", message: "unknown option -x" }, "one of a cluster");
    // parseArgs would take these as the other way round of a flag; none is one.
    assert.deepEqual(parseCli(["--no-help"]), { kind: "error", message: "unknown option --no-help. Did you mean --help?" });
  });
  test("--key <key> (or --key=<key>): the menu key, as tmux names it; the last one wins; it doesn't end the options", () => {
    assert.deepEqual(parseCli(["--key", "C-\\"]), { ...run(undefined), key: "C-\\" });
    assert.deepEqual(parseCli(["--key=Ctrl+]"]), { ...run(undefined), key: "C-]" });
    assert.deepEqual(parseCli(["--key", "ctrl+space", "claude", "-p"]), { ...run("claude", ["-p"]), key: "C-Space" });
    assert.deepEqual(parseCli(["--key", "C-]", "--key", "F12", "ls"]), { ...run("ls"), key: "F12" });
    assert.ok(!("key" in (parseCli([]) as object)), "none given: nothing");
  });
  test("--key: one Kiko can't use, or none after it, is a usage error saying why", () => {
    assert.deepEqual(parseCli(["--key", "C-c"]), { kind: "error", message: "--key: C-c can't be the menu key: Ctrl+C is the terminal's own (interrupt)" });
    assert.deepEqual(parseCli(["--key", "q"]), { kind: "error", message: "--key: q can't be the menu key: it needs Ctrl or Alt (Option), or an F key: a key alone would be taken from your typing" });
    assert.deepEqual(parseCli(["--key"]), { kind: "error", message: "--key needs a key after it (C-Space, C-\\, C-], F12…)" });
    assert.deepEqual(parseCli(["--ky", "C-]"]), { kind: "error", message: "unknown option --ky. Did you mean --key?" });
  });
  test("the usage tells of --key and KIKO_KEY, and which wins", () => {
    for (const word of ["--key <key>", "KIKO_KEY=<key>", "--key wins over KIKO_KEY", "Menu key"]) assert.ok(USAGE.includes(word), word);
  });
  test("a flag given a value: an error", () => {
    assert.deepEqual(parseCli(["--version=yes"]), { kind: "error", message: "option --version doesn't take a value" });
    assert.deepEqual(parseCli(["--help=1"]), { kind: "error", message: "option --help doesn't take a value" });
  });
});

describe("commands", () => {
  test("options before the command; the command and its arguments after", () => {
    assert.deepEqual(parseCli(["--key", "F12", "claude"]), { ...run("claude"), key: "F12" });
    assert.deepEqual(parseCli(["ls"]), run("ls"));
    assert.deepEqual(parseCli(["--key", "F12", "attach", "pixie"]), { ...run("attach", ["pixie"]), key: "F12" });
    assert.deepEqual(parseCli(["trust-scratch"]), run("trust-scratch"));
    assert.deepEqual(parseCli(["--", "ls"]), run("ls"), "-- ends the options");
  });
  test("Kiko Dev's own _overlay-test runs, but isn't offered for a typo nor in the help", () => {
    assert.deepEqual(parseCli(["_overlay-test"]), run("_overlay-test"));
    const typo = parseCli(["overlay-test"]);
    assert.equal(typo.kind, "error");
    assert.ok(!("message" in typo && typo.message.includes("_overlay")));
    assert.ok(!USAGE.includes("_overlay"));
  });
  test("claude's own flags go to it untouched, kiko's look-alikes too", () => {
    assert.deepEqual(parseCli(["claude", "--resume", "x", "-p"]), run("claude", ["--resume", "x", "-p"]));
    assert.deepEqual(parseCli(["--key", "F12", "claude", "--resume", "x", "-p"]), { ...run("claude", ["--resume", "x", "-p"]), key: "F12" });
    assert.deepEqual(parseCli(["claude", "--key", "--help", "-V", "--whatever=1", "--"]), run("claude", ["--key", "--help", "-V", "--whatever=1", "--"]));
  });
  test("options after a command aren't kiko's: a command that takes none says where they go", () => {
    assert.deepEqual(parseCli(["ls", "--help"]), { kind: "error", message: `ls takes no arguments (options go before the command: ${COMMAND} [options] ls)` });
    assert.deepEqual(parseCli(["attach", "pixie", "lacy"]), { kind: "error", message: `attach takes at most 1 argument (options go before the command: ${COMMAND} [options] attach)` });
  });
  test("an unknown command: an error, with what was probably meant", () => {
    assert.deepEqual(parseCli(["claud"]), { kind: "error", message: "unknown command claud. Did you mean claude?" });
    assert.deepEqual(parseCli(["trust"]), { kind: "error", message: "unknown command trust" });
  });
  test("what counts as close", () => {
    assert.equal(closest("--vresion", ["--help", "--version"]), "--version");
    assert.equal(closest("sl", ["ls", "claude"]), "ls", "two letters swapped is one edit");
    assert.equal(closest("--colour", ["--help", "--version"]), null);
  });
});
