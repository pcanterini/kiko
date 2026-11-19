// Codex's questions at start read off a pane's screen (src/core/trust-prompt.ts readTrustPrompt,
// agent "codex"), from screens as Codex 0.166.0 draws them (tests/support/screens/trust/codex-*:
// codex-rs/tui onboarding/trust_directory.rs and startup_hooks_review.rs, and a real "Hooks need
// review" screen from a session Kiko started), and answered safely (answerTrust): the marker moved
// one option at a time, seen on the option wanted before Enter, never Escape, never "Review hooks".
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  answerTrust,
  asksOnScreen,
  isTrust,
  readTrustPrompt,
  sameFolder,
  TRUST_HOOKS_TOOL,
  TRUST_TOOL,
  trustLine,
  trustMeans,
  TrustQuestion,
  trustWhat,
  type TrustKeys,
} from "../../../src/core/trust-prompt.ts";

const screen = (name: string) => readFileSync(new URL(`../../support/screens/trust/${name}.txt`, import.meta.url), "utf8");
const PIXIE = "/Users/me/git/pixie";
const HOME = "/Users/me";

/** A screen with Codex's › on option `n` (1-based) instead. */
const pickedOn = (text: string, n: number) =>
  text
    .split("\n")
    .map((l) => {
      const m = l.match(/^[› ] (\d)\. /);
      return m ? `${Number(m[1]) === n ? "›" : " "}${l.slice(1)}` : l;
    })
    .join("\n");

describe("reading Codex's folder question", () => {
  test('its folder, and "Trust and continue" picked (as it first shows)', () => {
    assert.deepEqual(readTrustPrompt(screen("codex-folder"), "codex"), { kind: "folder", folder: PIXIE, options: ["yes", "no"], at: 0, selected: "yes" });
  });

  test('with › on "Quit"', () => {
    assert.deepEqual(readTrustPrompt(pickedOn(screen("codex-folder"), 2), "codex")?.selected, "no");
  });

  test("in a Git project's subfolder: it trusts the repository root, and shows the session's folder apart", () => {
    const seen = readTrustPrompt(screen("codex-folder-git-subfolder"), "codex");
    assert.deepEqual([seen?.folder, seen?.cwd, seen?.selected], [PIXIE, `${PIXIE}/web`, "yes"]);
  });

  test("on a small screen: the path cut short in the middle, no blank lines", () => {
    const seen = readTrustPrompt(screen("codex-folder-narrow"), "codex");
    assert.equal(seen?.folder, "/Users/me/…/2026-11-05-a-rather-long-one");
    assert.ok(sameFolder(seen!.folder, "/Users/me/Kiko/scratch/2026-11-05-a-rather-long-one", HOME));
    assert.ok(!sameFolder(seen!.folder, "/Users/me/Kiko/scratch/2026-11-05-another", HOME));
  });

  test("its other versions are left to its window: opened restricted, and partial draws", () => {
    assert.equal(readTrustPrompt(screen("codex-folder-restricted"), "codex"), null);
    const noOptions = screen("codex-folder").split("› 1.")[0];
    assert.equal(readTrustPrompt(noOptions, "codex"), null);
    const oneOption = screen("codex-folder").replace("  2. Quit\n", "");
    assert.equal(readTrustPrompt(oneOption, "codex"), null);
    const noFolder = screen("codex-folder").replace(`  ${PIXIE}\n`, "");
    assert.equal(readTrustPrompt(noFolder, "codex"), null);
    const keepDir = screen("codex-folder").replace("2. Quit", "2. Keep current directory");
    assert.equal(readTrustPrompt(keepDir, "codex"), null, "a cancel that isn't Quit");
  });

  test("no marker, or two: which is picked can't be told", () => {
    assert.equal(readTrustPrompt(pickedOn(screen("codex-folder"), 9), "codex")?.at, null);
    assert.equal(readTrustPrompt(screen("codex-folder").replace("  2. Quit", "› 2. Quit"), "codex")?.at, null);
  });

  test("each agent's own screens only: Claude Code's isn't Codex's, nor the other way round", () => {
    assert.equal(readTrustPrompt(screen("trust"), "codex"), null);
    assert.equal(readTrustPrompt(screen("codex-folder")), null);
    assert.equal(readTrustPrompt(screen("codex-hooks")), null);
    assert.equal(readTrustPrompt(screen("codex-folder"), "opencode"), null);
    assert.deepEqual([asksOnScreen(), asksOnScreen("claude-code"), asksOnScreen("codex"), asksOnScreen("opencode"), asksOnScreen("t3code")], [true, true, true, false, false]);
  });
});

describe("reading Codex's hooks question", () => {
  test('the real screen: 10 hooks, its three options, "Review hooks" picked', () => {
    assert.deepEqual(readTrustPrompt(screen("codex-hooks"), "codex"), { kind: "hooks", folder: "", hooks: 10, options: ["other", "yes", "no"], at: 0, selected: "other" });
  });

  test("narrow: its last option wrapped over two lines", () => {
    const seen = readTrustPrompt(screen("codex-hooks-narrow"), "codex");
    assert.deepEqual([seen?.hooks, seen?.options, seen?.at], [2, ["other", "yes", "no"], 0]);
    assert.equal(readTrustPrompt(pickedOn(screen("codex-hooks-narrow"), 3), "codex")?.selected, "no");
  });

  test("one hook", () => {
    assert.equal(readTrustPrompt(screen("codex-hooks").replace("10 hooks are", "1 hook is"), "codex")?.hooks, 1);
  });

  test('while it writes their trust ("Trusting hooks..."): answered, not asking', () => {
    assert.equal(readTrustPrompt(screen("codex-hooks-trusting"), "codex"), null);
  });

  test("its composer behind it isn't an option, and a partial draw isn't the question", () => {
    assert.equal(readTrustPrompt(`${screen("codex-hooks")}\n› Ask Codex to do anything\n`, "codex")?.hooks, 10);
    assert.equal(readTrustPrompt(screen("codex-hooks").replace("10 hooks are new or changed.", ""), "codex"), null);
    assert.equal(readTrustPrompt(screen("codex-hooks").replace("  2. Trust all and continue\n", ""), "codex"), null);
  });
});

describe("Codex's questions as cards", () => {
  test("its folder: worded as Codex's, its tool a folder's", () => {
    const q = new TrustQuestion("starting-1", PIXIE, PIXIE, () => {}, { agent: "codex" });
    assert.ok(isTrust(q));
    assert.deepEqual([q.kind, q.agentName, q.tool], ["folder", "Codex", { name: TRUST_TOOL, input: { folder: PIXIE } }]);
    assert.equal(trustWhat(q, HOME), "trust its folder ~/git/pixie");
    assert.equal(trustLine("Pixie", q, HOME, { spoken: true, byVoice: true }), "Pixie wants to trust its folder, pixie. Codex will be able to read, edit and run files there. Allow?");
  });

  test("its hooks: what trusting all of them means, and that not trusting leaves the session unheard", () => {
    const q = new TrustQuestion("starting-1", PIXIE, PIXIE, () => {}, { agent: "codex", kind: "hooks", hooks: 10 });
    assert.deepEqual([q.kind, q.hooks, q.canAllowAlways, q.tool], ["hooks", 10, false, { name: TRUST_HOOKS_TOOL, input: { hooks: 10 } }]);
    assert.equal(trustWhat(q, HOME), "trust its hooks (10 new or changed)");
    const means = trustMeans(q);
    assert.match(means, /all of them run, yours too, outside Codex's sandbox/);
    assert.match(means, /Kiko won't hear this session/);
    assert.match(means, /review them one by one, open the session/);
    assert.equal(trustLine("Juniper", q, HOME, { spoken: true, byVoice: false }), `Juniper wants you to trust its hooks: 10 are new or changed. ${means} Answer on its card or on your phone.`);
  });
});

/**
 * A pretend Codex pane at one of its questions: Down and Up move › one option (stopping at the
 * ends, as its pickers do), Enter takes the option picked: `takes` says what then shows (null: its
 * program ended). Escape is recorded: Kiko never presses it here.
 */
function codexPane(base: string, o: { start?: number; moves?: boolean; takes: (n: number) => string | null }) {
  const count = base.split("\n").filter((l) => /^[› ] \d\. /.test(l)).length;
  let at = o.start ?? 1;
  let after: string | null | undefined;
  const pressed: string[] = [];
  const io: TrustKeys = {
    screen: async () => (after === undefined ? pickedOn(base, at) : after),
    running: async () => after !== null,
    press: async (key) => {
      pressed.push(key);
      if (after !== undefined) return { sent: true };
      if (key === "down" && o.moves !== false) at = Math.min(count, at + 1);
      if (key === "up" && o.moves !== false) at = Math.max(1, at - 1);
      if (key === "enter") after = o.takes(at);
      return { sent: true };
    },
    wait: async () => {},
  };
  return { io, pressed, took: () => after };
}

const COMPOSER = "› Ask Codex to do anything\n";

describe("answering Codex's folder question", () => {
  const folder = (start = 1, moves = true) => codexPane(screen("codex-folder"), { start, moves, takes: (n) => (n === 1 ? COMPOSER : null) });

  test('trust: "Trust and continue" picked already (as it shows), so Enter only', async () => {
    const p = folder();
    assert.deepEqual(await answerTrust(p.io, true, { agent: "codex" }), { ok: true, how: "enter" });
    assert.equal(p.took(), COMPOSER);
  });

  test('trust from "Quit": Up, seen on "Trust and continue", then Enter', async () => {
    const p = folder(2);
    assert.deepEqual(await answerTrust(p.io, true, { agent: "codex" }), { ok: true, how: "up+enter" });
    assert.equal(p.took(), COMPOSER);
  });

  test('don\'t trust: Down to "Quit", seen, then Enter (no Escape); Codex quits', async () => {
    const p = folder();
    assert.deepEqual(await answerTrust(p.io, false, { agent: "codex" }), { ok: true, how: "down+enter" });
    assert.equal(p.took(), null);
    assert.ok(!p.pressed.includes("escape"));
  });

  test("the marker doesn't move: no Enter", async () => {
    const p = folder(1, false);
    const r = await answerTrust(p.io, false, { agent: "codex" });
    assert.deepEqual([r.ok, r.how], [false, "down"]);
    assert.match(r.why!, /didn't press Enter/);
    assert.equal(p.took(), undefined, "still asking");
  });

  test("its hooks question showing next isn't this one still asking: answered", async () => {
    const p = codexPane(screen("codex-folder"), { takes: () => screen("codex-hooks") });
    assert.deepEqual(await answerTrust(p.io, true, { agent: "codex", kind: "folder" }), { ok: true, how: "enter" });
  });
});

describe("answering Codex's hooks question (never Review hooks, never Escape)", () => {
  const takes = (n: number) => (n === 1 ? "  Hooks\n  (its hooks browser)\n" : n === 2 ? `${screen("codex-hooks-trusting")}` : COMPOSER);
  const hooks = (start = 1, moves = true) => codexPane(screen("codex-hooks"), { start, moves, takes });
  const which = { agent: "codex", kind: "hooks" as const };

  test('trust: Down from "Review hooks" to "Trust all and continue", seen, then Enter', async () => {
    const p = hooks();
    assert.deepEqual(await answerTrust(p.io, true, which), { ok: true, how: "down+enter" });
    assert.equal(p.took(), screen("codex-hooks-trusting"));
  });

  test('don\'t trust: Down twice, one at a time, to "Continue without trusting", then Enter', async () => {
    const p = hooks();
    assert.deepEqual(await answerTrust(p.io, false, which), { ok: true, how: "down+down+enter" });
    assert.equal(p.took(), COMPOSER);
    assert.ok(!p.pressed.includes("escape"));
  });

  test('trust with "Continue without trusting" picked: Up once', async () => {
    const p = hooks(3);
    assert.deepEqual(await answerTrust(p.io, true, which), { ok: true, how: "up+enter" });
  });

  test("the marker doesn't move: no Enter, so Review hooks is never taken", async () => {
    const p = hooks(1, false);
    const r = await answerTrust(p.io, true, which);
    assert.deepEqual([r.ok, r.how], [false, "down"]);
    assert.equal(p.took(), undefined);
  });

  test("can't tell which is picked: nothing pressed", async () => {
    const p = codexPane(screen("codex-hooks").replace("› 1.", "  1."), { start: 9, takes });
    const r = await answerTrust(p.io, true, which);
    assert.deepEqual([r.ok, r.how], [false, "none"]);
    assert.deepEqual(p.pressed, []);
  });

  test("the folder question on its screen isn't the hooks one: nothing pressed", async () => {
    const io: TrustKeys = { screen: async () => screen("codex-folder"), press: async () => assert.fail("nothing pressed"), wait: async () => {} };
    const r = await answerTrust(io, true, which);
    assert.match(r.why!, /isn't on its screen/);
  });
});
