// The menu key (src/terminals/tmux/keys.ts): which keys it can be, how they're written, shown
// and said, what a program reads for one, and which one this run uses (flag > KIKO_KEY > the
// setting > Ctrl+Space). And the look around the window for something that takes it first
// (src/terminals/tmux/clash.ts): your tmux (a stand-in for it), herdr's config.toml, and macOS's
// input source shortcuts (from fixtures: what `defaults` prints), and the key taken instead.
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  checkKey,
  clashMessage,
  herdrConfigPath,
  herdrPrefix,
  herdrTaker,
  hotkeyIs,
  inHerdr,
  inputHotkeys,
  inputSourceCount,
  macTaker,
  parsePlist,
  tmuxTaker,
  type Run,
  type Taker,
} from "../../../src/terminals/tmux/clash.ts";
import { decideKey, DEFAULT_KEY, FALLBACKS, keySequences, keySpoken, keySymbol, keyWords, normalizeKey, parseKey } from "../../../src/terminals/tmux/keys.ts";
import { isHerdrVar, rightClickToPane, RIGHT_CLICK_ARGS, withoutHerdr } from "../../../src/terminals/tmux/herdr.ts";
import { cleanEnv, sessionEnv, withoutTerminal } from "../../../src/terminals/tmux/tmux.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("the menu key: which keys, written how", () => {
  test("read whichever way it's written, as tmux names it", () => {
    for (const [written, key] of [
      ["C-Space", "C-Space"],
      ["Ctrl+Space", "C-Space"],
      ["ctrl-space", "C-Space"],
      ["control+space", "C-Space"],
      ["⌃Space", "C-Space"],
      ["^Space", "C-Space"],
      ["C-@", "C-Space"],
      ["C-\\", "C-\\"],
      ["Ctrl+\\", "C-\\"],
      ["ctrl+backslash", "C-\\"],
      ["Ctrl+]", "C-]"],
      ["C-^", "C-^"],
      ["C-_", "C-_"],
      ["C-G", "C-g"],
      ["ctrl+g", "C-g"],
      ["M-k", "M-k"],
      ["Alt+K", "M-k"],
      ["Option+k", "M-k"],
      ["⌥k", "M-k"],
      ["M-Space", "M-Space"],
      ["C-M-a", "C-M-a"],
      ["F12", "F12"],
      ["f1", "F1"],
      ["S-F5", "S-F5"],
      ["C-F12", "C-F12"],
      [" C-Space ", "C-Space"],
    ])
      assert.deepEqual(parseKey(written), { key }, written);
  });
  test("refused, with why: a key alone, the terminal's own, keys a terminal can't send", () => {
    const why = (text: string) => ("error" in parseKey(text) ? (parseKey(text) as { error: string }).error : "");
    assert.match(why("a"), /needs Ctrl or Alt/);
    assert.match(why("Space"), /needs Ctrl or Alt/);
    assert.match(why("C-c"), /Ctrl\+C is the terminal's own \(interrupt\)/);
    for (const own of ["C-d", "C-h", "C-i", "C-j", "C-m", "C-z"]) assert.match(why(own), /terminal's own/, own);
    assert.match(why("C-1"), /don't send Ctrl\+1/);
    assert.match(why("S-a"), /needs Ctrl or Alt/);
    assert.match(why("C-S-a"), /Shift goes only with an F key/);
    assert.match(why("C-M-c"), /only a letter/);
    assert.match(why(""), /isn't a key/);
    assert.match(why("Hyper+x"), /isn't a key/);
  });
  test("shown the Mac's way, written in a sentence, said out loud", () => {
    assert.deepEqual([keySymbol("C-Space"), keyWords("C-Space"), keySpoken("C-Space")], ["⌃Space", "Ctrl+Space", "Control-Space"]);
    assert.deepEqual([keySymbol("C-\\"), keyWords("C-\\"), keySpoken("C-\\")], ["⌃\\", "Ctrl+\\", "Control-Backslash"]);
    assert.deepEqual([keySymbol("C-]"), keyWords("C-]"), keySpoken("C-]")], ["⌃]", "Ctrl+]", "Control-Right Bracket"]);
    assert.deepEqual([keySymbol("M-k"), keyWords("M-k"), keySpoken("M-k")], ["⌥K", "Alt+K", "Option-K"]);
    assert.deepEqual([keySymbol("F12"), keyWords("F12"), keySpoken("F12")], ["F12", "F12", "F12"]);
  });
  test("what a program reads for it: its plain form, and CSI u (tmux's extended keys)", () => {
    assert.deepEqual(keySequences("C-Space"), ["\x00", "\x1b[32;5u"]);
    assert.deepEqual(keySequences("C-\\"), ["\x1c", "\x1b[92;5u"]);
    assert.deepEqual(keySequences("C-]"), ["\x1d", "\x1b[93;5u"]);
    assert.deepEqual(keySequences("C-g"), ["\x07", "\x1b[103;5u"]);
    assert.deepEqual(keySequences("M-k"), ["\x1bk", "\x1b[107;3u"]);
    assert.deepEqual(keySequences("F12"), ["\x1b[24~"]);
    assert.deepEqual(keySequences("F1"), ["\x1bOP", "\x1b[1P"]);
    assert.deepEqual(keySequences("S-F5"), ["\x1b[15;2~"]);
  });
  test("normalizeKey compares any key (herdr's and tmux's names), whether Kiko takes it or not", () => {
    assert.equal(normalizeKey("ctrl+b"), "C-b");
    assert.equal(normalizeKey("C-c"), "C-c");
    assert.equal(normalizeKey("ctrl+space"), "C-Space");
    assert.equal(normalizeKey("None"), null);
  });
  test("the fallbacks are keys Kiko takes, Ctrl+\\ first", () => {
    assert.equal(FALLBACKS[0], "C-\\");
    for (const k of FALLBACKS) assert.deepEqual(parseKey(k), { key: k });
  });
});

describe("which key this run: --key > KIKO_KEY > the setting > Ctrl+Space", () => {
  test("each in turn", () => {
    assert.deepEqual(decideKey({}), { key: DEFAULT_KEY, by: "default" });
    assert.deepEqual(decideKey({ setting: "C-]" }), { key: "C-]", by: "setting" });
    assert.deepEqual(decideKey({ env: "ctrl+\\", setting: "C-]" }), { key: "C-\\", by: "env" });
    assert.deepEqual(decideKey({ flag: "F12", env: "C-\\", setting: "C-]" }), { key: "F12", by: "flag" });
  });
  test("empty is unset; one Kiko can't use is passed over, with why", () => {
    assert.deepEqual(decideKey({ env: "", setting: "  " }), { key: DEFAULT_KEY, by: "default" });
    const d = decideKey({ env: "C-c", setting: "C-]" });
    assert.equal(d.key, "C-]");
    assert.equal(d.by, "setting");
    assert.deepEqual(d.ignored, ["KIKO_KEY: C-c can't be the menu key: Ctrl+C is the terminal's own (interrupt)"]);
    const bad = decideKey({ setting: 42 });
    assert.deepEqual(bad, { key: DEFAULT_KEY, by: "default" }, "not a string: no say");
  });
});

/** A stand-in for programs: answers by program and arguments; anything else fails. Records what ran, and with which env. */
function fakeRun(answers: Record<string, string | null>) {
  const ran: Array<{ program: string; args: string[]; tmux?: string }> = [];
  const run: Run = async (program, args, env) => {
    ran.push({ program, args, ...(env?.TMUX ? { tmux: env.TMUX } : {}) });
    const answer = answers[`${program} ${args.join(" ")}`];
    return answer === undefined ? null : answer;
  };
  return { run, ran };
}

describe("your own tmux", () => {
  const TMUX_ENV = { TMUX: "/private/tmp/tmux-501/default,1234,0" };
  test("its prefix: asked of that server (TMUX as it is), Ctrl+Space taken", async () => {
    const { run, ran } = fakeRun({ "tmux show-options -gv prefix": "C-Space\n", "tmux show-options -gv prefix2": "None\n" });
    const t = tmuxTaker(TMUX_ENV, "tmux", run)!;
    assert.equal(await t.takes("C-Space"), true);
    assert.equal(await t.takes("C-\\"), false);
    assert.ok(
      ran.every((r) => r.tmux === TMUX_ENV.TMUX),
      "run with your TMUX",
    );
    assert.equal(ran.filter((r) => r.args[0] === "show-options").length, 2, "the prefixes asked once");
  });
  test("prefix2, and C-@ (the same key as Ctrl+Space)", async () => {
    const two = tmuxTaker(TMUX_ENV, "tmux", fakeRun({ "tmux show-options -gv prefix": "C-b\n", "tmux show-options -gv prefix2": "C-@\n" }).run)!;
    assert.equal(await two.takes("C-Space"), true);
    assert.equal(await two.takes("C-b"), true);
  });
  test("a root-table binding (list-keys -T root <key> prints it; an unbound key prints nothing, exit 1)", async () => {
    const { run, ran } = fakeRun({ "tmux show-options -gv prefix": "C-b\n", "tmux show-options -gv prefix2": "None\n", "tmux list-keys -T root C-\\": "bind-key -T root C-\\\\ display x\n" });
    const t = tmuxTaker(TMUX_ENV, "tmux", run)!;
    assert.equal(await t.takes("C-Space"), false);
    assert.equal(await t.takes("C-\\"), true);
    assert.deepEqual(
      ran.filter((r) => r.args[0] === "list-keys").map((r) => r.args.at(-1)),
      ["C-Space", "C-@", "C-\\"],
    );
  });
  test("none outside tmux, nor inside Kiko's own", () => {
    assert.equal(tmuxTaker({}, "tmux"), null);
    assert.equal(tmuxTaker({ TMUX: "/private/tmp/tmux-501/kiko-dev,1234,0" }, "tmux"), null);
  });
});

describe("herdr", () => {
  test("in a herdr pane: HERDR_ENV=1 or TERM_PROGRAM=herdr", () => {
    assert.equal(inHerdr({ HERDR_ENV: "1" }), true);
    assert.equal(inHerdr({ TERM_PROGRAM: "herdr" }), true);
    assert.equal(inHerdr({ TERM_PROGRAM: "ghostty" }), false);
  });
  test("its config: HERDR_CONFIG_PATH, else XDG_CONFIG_HOME's, else ~/.config's", () => {
    assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: "/x/h.toml", HOME: "/Users/me" }), "/x/h.toml");
    assert.equal(herdrConfigPath({ XDG_CONFIG_HOME: "/cfg", HOME: "/Users/me" }), "/cfg/herdr/config.toml");
    assert.equal(herdrConfigPath({ HOME: "/Users/me" }), "/Users/me/.config/herdr/config.toml");
  });
  test("the [keys] prefix: only that table, comments and other tables' prefixes left out", () => {
    assert.equal(herdrPrefix(`[keys]\nprefix = "ctrl+space"\n`), "ctrl+space");
    assert.equal(herdrPrefix(`[ui]\nprefix = "x"\n[keys] # mine\n# prefix = "ctrl+a"\nsplit = "v"\nprefix='ctrl+q' # comment\n[more]\nprefix = "ctrl+z"\n`), "ctrl+q");
    assert.equal(herdrPrefix(`[keys]\nsplit = "v"\n[other]\nprefix = "ctrl+a"\n`), null);
    assert.equal(herdrPrefix(""), null);
  });
  test("takes its prefix (ctrl+b when its config says none, or there's no config)", async () => {
    const env = { HERDR_ENV: "1", HERDR_CONFIG_PATH: "/h.toml" };
    const space = herdrTaker(env, () => `[keys]\nprefix = "ctrl+space"\n`)!;
    assert.equal(await space.takes("C-Space"), true);
    assert.equal(await space.takes("C-\\"), false);
    const none = herdrTaker(env, () => null)!;
    assert.equal(await none.takes("C-b"), true);
    assert.equal(await none.takes("C-Space"), false);
    assert.equal(
      herdrTaker({}, () => ""),
      null,
      "not in herdr: nothing",
    );
  });
  test("its variables stay out of Kiko's tmux, the app and its sessions", () => {
    const env = {
      HOME: "/Users/me",
      PATH: "/bin",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "p1",
      HERDR_TAB_ID: "t1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_SOCKET_PATH: "/s",
      HERDR_ANYTHING: "x",
      TERM_PROGRAM: "herdr",
    };
    for (const out of [cleanEnv(env), withoutTerminal(env), withoutHerdr(env)]) assert.ok(!Object.keys(out).some(isHerdrVar), JSON.stringify(Object.keys(out)));
    assert.ok(!/HERDR_|TERM_PROGRAM/.test(sessionEnv(env, "/tmp")), "not in a launch file either");
  });
  test("right-clicks: herdr pane input --current --right-click pane, with this pane's environment; ok, or failed", async () => {
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "p1" };
    const ok = fakeRun({ [`herdr ${RIGHT_CLICK_ARGS.join(" ")}`]: "" });
    assert.equal(await rightClickToPane(env, ok.run), "ok");
    assert.deepEqual(ok.ran, [{ program: "herdr", args: ["pane", "input", "--current", "--right-click", "pane"] }]);
    assert.equal(await rightClickToPane(env, fakeRun({}).run), "failed");
  });
});

describe("macOS's input source shortcuts", () => {
  test("a property list read: the shortcuts table, 60 and 61 with their keys", () => {
    const all = parsePlist(fixture("symbolichotkeys-on.plist")) as { AppleSymbolicHotKeys: Record<string, { enabled: boolean }> };
    assert.deepEqual(Object.keys(all.AppleSymbolicHotKeys), ["32", "60", "61", "64"]);
    assert.deepEqual(inputHotkeys(fixture("symbolichotkeys-on.plist")), [
      { id: 60, enabled: true, char: 32, keyCode: 49, mask: 262144 },
      { id: 61, enabled: false, char: 32, keyCode: 49, mask: 786432 },
    ]);
  });
  test("missing from the file: macOS's defaults (on, ⌃Space and ⌃⌥Space); no file at all the same", () => {
    const moved = inputHotkeys(fixture("symbolichotkeys-moved.plist"));
    assert.deepEqual(moved[0], { id: 60, enabled: true, char: 92, keyCode: 42, mask: 262144 });
    assert.deepEqual(moved[1], { id: 61, enabled: true, char: 32, keyCode: 49, mask: 0xc0000 });
    assert.deepEqual(
      inputHotkeys(null).map((h) => h.enabled),
      [true, true],
    );
  });
  test("which key a shortcut is: the modifiers exactly, then the character (Space by its key code)", () => {
    const [prev, next] = inputHotkeys(fixture("symbolichotkeys-on.plist"));
    assert.equal(hotkeyIs(prev, "C-Space"), true);
    assert.equal(hotkeyIs(next, "C-Space"), false, "⌃⌥Space isn't ⌃Space");
    assert.equal(hotkeyIs(next, "C-M-Space"), true);
    assert.equal(hotkeyIs(inputHotkeys(fixture("symbolichotkeys-moved.plist"))[0], "C-\\"), true);
  });
  test("input sources counted: layouts, input modes, methods without modes; not the emoji picker", () => {
    assert.equal(inputSourceCount(fixture("input-sources-one.txt")), 1);
    assert.equal(inputSourceCount(fixture("input-sources-two.txt")), 2);
    assert.equal(inputSourceCount(null), 0);
  });
  const mac = (hotkeys: string, sources: string) =>
    macTaker(
      { KIKO_DEFAULTS: "/fake/defaults" },
      fakeRun({ "/fake/defaults export com.apple.symbolichotkeys -": fixture(hotkeys), "/fake/defaults read com.apple.HIToolbox AppleEnabledInputSources": fixture(sources) }).run,
      "darwin",
    )!;
  test("a clash only when the shortcut is on and there's more than one input source", async () => {
    assert.equal(await mac("symbolichotkeys-on.plist", "input-sources-two.txt").takes("C-Space"), true);
    assert.equal(await mac("symbolichotkeys-on.plist", "input-sources-one.txt").takes("C-Space"), false, "one input source: nothing to switch");
    assert.equal(await mac("symbolichotkeys-off.plist", "input-sources-two.txt").takes("C-Space"), false, "turned off");
    assert.equal(await mac("symbolichotkeys-on.plist", "input-sources-two.txt").takes("C-\\"), false);
  });
  test("only on the Mac, and never the Mac's own settings under the test runner without a stand-in", () => {
    assert.equal(macTaker({ KIKO_DEFAULTS: "/fake" }, fakeRun({}).run, "linux"), null);
    assert.equal(macTaker({ NODE_TEST_CONTEXT: "child" }, fakeRun({}).run, "darwin"), null);
  });
});

describe("a clash, and the key used instead", () => {
  const taking = (by: Taker["by"], ...keys: string[]): Taker => ({ by, takes: async (k) => keys.includes(k) });
  test("none: nothing to do", async () => {
    assert.equal(await checkKey("C-Space", [taking("tmux", "C-b")]), null);
    assert.equal(await checkKey("C-Space", []), null);
  });
  test("the first that takes it says why; the first fallback none of them takes is used", async () => {
    assert.deepEqual(await checkKey("C-Space", [taking("tmux", "C-Space"), taking("macos", "C-Space")]), { by: "tmux", key: "C-Space", fallback: "C-\\" });
    assert.deepEqual(await checkKey("C-Space", [taking("herdr", "C-Space", "C-\\")]), { by: "herdr", key: "C-Space", fallback: "C-]" });
    assert.deepEqual(await checkKey("C-\\", [taking("tmux", "C-\\")]), { by: "tmux", key: "C-\\", fallback: "C-]" }, "never itself");
    assert.deepEqual(await checkKey("C-Space", [taking("tmux", "C-Space", ...FALLBACKS)]), { by: "tmux", key: "C-Space", fallback: null });
  });
  test("one that fails to answer takes nothing", async () => {
    assert.equal(await checkKey("C-Space", [{ by: "tmux", takes: async () => Promise.reject(new Error("gone")) }]), null);
  });
  test("what's said: shown with the keys as written, said with them as spoken", () => {
    assert.deepEqual(clashMessage({ by: "tmux", key: "C-Space", fallback: "C-\\" }), {
      text: "Your tmux uses Ctrl+Space, so the menu key is Ctrl+\\ this time. Change it in settings.",
      spoken: "Your tmux uses Control-Space, so the menu key is Control-Backslash this time. Change it in settings.",
    });
    assert.equal(
      clashMessage({ by: "macos", key: "C-Space", fallback: "C-\\" }).text,
      "Your Mac uses Ctrl+Space to switch input sources, so the menu key is Ctrl+\\ this time. Change it in settings.",
    );
    assert.equal(clashMessage({ by: "herdr", key: "C-Space", fallback: "C-]" }).text, "Your herdr uses Ctrl+Space, so the menu key is Ctrl+] this time. Change it in settings.");
    assert.match(clashMessage({ by: "tmux", key: "C-Space", fallback: null }).text, /Click ☰ Kiko Dev in the bottom line/);
  });
});
