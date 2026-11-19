// The command line's markers and styles (src/ui/cli-style.ts): colour only on a terminal, never
// with NO_COLOR, CLICOLOR=0 or TERM=dumb, forced on a pipe by CLICOLOR_FORCE (go-gh's rules); the
// markers there without colour too (as gh's are), and each style undone by its own code only.
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { colorOn, PLAIN, styleFor, styleOf } from "../../../src/ui/cli-style.ts";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("when there's colour", () => {
  test("a terminal: yes; a pipe, or a stream that doesn't say: no", () => {
    assert.equal(colorOn(tty, {}), true);
    assert.equal(colorOn(pipe, {}), false);
    assert.equal(colorOn({}, {}), false);
  });

  test("NO_COLOR (any value but empty), CLICOLOR=0 or TERM=dumb: none, even on a terminal", () => {
    assert.equal(colorOn(tty, { NO_COLOR: "1" }), false);
    assert.equal(colorOn(tty, { NO_COLOR: "yes" }), false);
    assert.equal(colorOn(tty, { NO_COLOR: "" }), true, "an empty NO_COLOR is as none (no-color.org)");
    assert.equal(colorOn(tty, { CLICOLOR: "0" }), false);
    assert.equal(colorOn(tty, { TERM: "dumb" }), false);
  });

  test("CLICOLOR_FORCE: colour on a pipe too, unless it's 0; NO_COLOR still wins", () => {
    assert.equal(colorOn(pipe, { CLICOLOR_FORCE: "1" }), true);
    assert.equal(colorOn(pipe, { CLICOLOR_FORCE: "0" }), false);
    assert.equal(colorOn(pipe, { CLICOLOR_FORCE: "1", NO_COLOR: "1" }), false);
  });
});

describe("the styles", () => {
  test("on a terminal: ✓ green, ! yellow, X red, bold and dim, each closed by its own code", () => {
    const s = styleFor(tty, {});
    assert.equal(s.color, true);
    assert.equal(s.ok("Signed out on this Mac."), "\x1b[32m✓\x1b[39m Signed out on this Mac.");
    assert.equal(s.warn("Look"), "\x1b[33m!\x1b[39m Look");
    assert.equal(s.error("kiko: no"), "\x1b[31mX\x1b[39m kiko: no");
    assert.equal(s.bold("WDJB-MJHT"), "\x1b[1mWDJB-MJHT\x1b[22m");
    assert.equal(s.dim("a hint"), "\x1b[2ma hint\x1b[22m");
    // A bold value inside a coloured span keeps the colour after it.
    assert.equal(s.red(`a ${s.bold("b")} c`), "\x1b[31ma \x1b[1mb\x1b[22m c\x1b[39m");
  });

  test("piped, or with NO_COLOR: plain text, the markers kept, not one escape", () => {
    for (const s of [styleFor(pipe, {}), styleFor(tty, { NO_COLOR: "1" }), PLAIN]) {
      assert.equal(s.color, false);
      const line = [s.ok("done"), s.warn("look"), s.error("failed"), s.bold("name"), s.dim("hint"), s.green("g"), s.yellow("y"), s.red("r"), s.question("Sure?")].join("|");
      assert.equal(line, "✓ done|! look|X failed|name|hint|g|y|r|Sure? [y/N] ");
      assert.doesNotMatch(line, /\x1b/);
    }
  });

  test("marked: a line made elsewhere has its marker coloured (✗ drawn as X); any other line left as it is", () => {
    const s = styleOf(true);
    assert.equal(s.marked("✓ OpenRouter key works"), "\x1b[32m✓\x1b[39m OpenRouter key works");
    assert.equal(s.marked("✗ OpenRouter turned the key down"), "\x1b[31mX\x1b[39m OpenRouter turned the key down");
    assert.equal(s.marked("! Look"), "\x1b[33m!\x1b[39m Look");
    assert.equal(s.marked("Nothing saved."), "Nothing saved.");
    assert.equal(s.marked("X-ray"), "X-ray");
    assert.equal(PLAIN.marked("✗ refused"), "X refused");
  });

  test("question: the question bold, the choices dim, a space to answer after", () => {
    assert.equal(styleOf(true).question("Sign out anyway?"), "\x1b[1mSign out anyway?\x1b[22m \x1b[2m[y/N]\x1b[22m ");
  });
});
