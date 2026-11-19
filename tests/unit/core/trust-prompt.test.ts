// Claude Code's trust question read off a pane's screen (src/core/trust-prompt.ts readTrustPrompt),
// from screens as capture-pane gives them (tests/support/screens/trust/), and answered safely (answerTrust): the
// first option is "No, exit", so Enter goes in only once ❯ is seen on "Yes, I trust this folder".
import "../../setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Floor, type Waiter } from "../../../src/core/floor.ts";
import { shortPath } from "../../../src/core/text.ts";
import { FakeClock } from "../../support/clock.ts";
import {
  answerTrust,
  isTrust,
  readTrustPrompt,
  sameFolder,
  TRUST_TOOL,
  TrustCards,
  TrustQuestion,
  type TrustSettled,
  trustLine,
  trustPollMs,
  trustWhat,
  type TrustKeys,
} from "../../../src/core/trust-prompt.ts";

const screen = (name: string) => readFileSync(new URL(`../../support/screens/trust/${name}.txt`, import.meta.url), "utf8");
const DOZER = "/Users/me/Kiko/scratch/2026-10-29-dozer";
/** Claude Code's folder question as read: "No, exit" drawn first. */
const claudeQ = (folder: string, selected: "yes" | "no" | null) => ({
  kind: "folder",
  folder,
  options: ["no", "yes"],
  at: selected === null ? null : selected === "no" ? 0 : 1,
  selected,
});

describe("reading the trust question off a screen", () => {
  test('the question, its folder, and "No, exit" picked (as it first shows)', () => {
    assert.deepEqual(readTrustPrompt(screen("trust")), claudeQ(DOZER, "no"));
  });

  test('with ❯ on "Yes, I trust this folder"', () => {
    assert.deepEqual(readTrustPrompt(screen("trust-yes")), claudeQ(DOZER, "yes"));
  });

  test("in a frame, the folder shown with ~", () => {
    assert.deepEqual(readTrustPrompt(screen("trust-framed")), claudeQ("~/Kiko/scratch/2026-10-29-dozer", "no"));
  });

  test("a long folder wrapped over two lines is read whole", () => {
    assert.deepEqual(readTrustPrompt(screen("trust-wrapped")), claudeQ("/Users/me/Kiko/scratch/2026-10-29-a-rather-long-folder-name-for-dozer", "yes"));
  });

  test("numbered options (an older or other menu) are read too", () => {
    const numbered = screen("trust").replace(" ❯ No, exit", " ❯ 1. No, exit").replace("   Yes, I trust", "   2. Yes, I trust");
    assert.deepEqual(readTrustPrompt(numbered), claudeQ(DOZER, "no"));
  });

  test("partial draws are not the question: no options yet, one option, no folder", () => {
    assert.equal(readTrustPrompt(screen("partial-top")), null);
    assert.equal(readTrustPrompt(screen("partial-one-option")), null);
    assert.equal(readTrustPrompt(screen("partial-no-folder")), null);
    assert.equal(readTrustPrompt(""), null);
  });

  test("other screens are not it: a folder with settings of its own, the bypass warning, Claude Code's prompt, a shell", () => {
    assert.equal(readTrustPrompt(screen("settings")), null, "its No doesn't exit: left to the window");
    assert.equal(readTrustPrompt(screen("bypass")), null);
    assert.equal(readTrustPrompt(screen("claude-prompt")), null);
    assert.equal(readTrustPrompt(screen("shell")), null);
  });

  test("no marker, or on both: which is picked can't be told", () => {
    const none = screen("trust").replace(" ❯ No, exit", "   No, exit");
    assert.deepEqual(readTrustPrompt(none), claudeQ(DOZER, null));
    const both = screen("trust").replace("   Yes, I trust", " ❯ Yes, I trust");
    assert.deepEqual(readTrustPrompt(both), claudeQ(DOZER, null));
  });

  test("the folder shown is the session's (with ~, or a trailing slash)", () => {
    assert.ok(sameFolder(DOZER, DOZER, "/Users/me"));
    assert.ok(sameFolder("~/Kiko/scratch/2026-10-29-dozer", DOZER, "/Users/me"));
    assert.ok(sameFolder(`${DOZER}/`, DOZER, "/Users/me"));
    assert.ok(!sameFolder("/Users/me/Kiko/scratch/2026-10-29-rex", DOZER, "/Users/me"));
  });

  test("looked at every 500ms for 15 seconds, then every 3; every 3 while its card is up", () => {
    assert.equal(trustPollMs(0), 500);
    assert.equal(trustPollMs(14_999), 500);
    assert.equal(trustPollMs(15_000), 3_000);
    assert.equal(trustPollMs(0, true), 3_000);
    assert.equal(trustPollMs(60 * 60_000, true), 3_000, "for as long as it's up");
  });

  test("worded as a folder-trust question, not a tool's", () => {
    assert.equal(shortPath(DOZER, "/Users/me"), "~/Kiko/scratch/2026-10-29-dozer");
    assert.equal(shortPath("/elsewhere/x", "/Users/me"), "/elsewhere/x");
    assert.equal(trustWhat({ kind: "folder", folder: DOZER, agentName: "Claude Code" }, "/Users/me"), "trust its folder ~/Kiko/scratch/2026-10-29-dozer");
    assert.equal(
      trustLine("Dozer", { kind: "folder", folder: DOZER, agentName: "Claude Code" }, "/Users/me", { spoken: false, byVoice: true }),
      "Dozer wants to trust its folder ~/Kiko/scratch/2026-10-29-dozer. Claude Code will be able to read, edit and run files there. Allow?",
    );
    assert.equal(
      trustLine("Dozer", { kind: "folder", folder: DOZER, agentName: "Claude Code" }, "/Users/me", { spoken: true, byVoice: false }),
      "Dozer wants to trust its folder, 2026-10-29-dozer. Claude Code will be able to read, edit and run files there. Answer on its card or on your phone.",
    );
  });
});

describe("the trust question held like a permission prompt", () => {
  test("allow and deny hand the answer over once; release presses nothing; close tells onClosed once", () => {
    const answers: boolean[] = [];
    const q = new TrustQuestion("starting-1234abcd", DOZER, DOZER, (allow) => answers.push(allow));
    assert.ok(isTrust(q));
    assert.ok(!isTrust({ isPermission: true }));
    assert.deepEqual([q.isPermission, q.canAllowAlways, q.questions, q.tool], [true, false, null, { name: TRUST_TOOL, input: { folder: DOZER } }]);
    assert.equal(q.open, true);
    assert.equal(q.allow(), true);
    assert.equal(q.open, false);
    assert.equal(q.answered, true);
    assert.equal(q.deny(), false, "answered once");
    assert.deepEqual(answers, [true]);

    // The floor lets go of it (its voice window ran out): nothing pressed, and it's still asking.
    const let_go = new TrustQuestion("starting-1", DOZER, DOZER, (allow) => answers.push(allow));
    assert.equal(let_go.release(), true);
    assert.equal(let_go.open, true, "still up");
    assert.equal(let_go.answered, null);
    assert.deepEqual(answers, [true], "nothing pressed");
    assert.equal(let_go.allow(), true, "and answerable after");

    let closed = 0;
    const away = new TrustQuestion("starting-2", DOZER, DOZER, () => assert.fail("not answered"));
    away.onClosed = () => closed++;
    away.close();
    away.close();
    assert.equal(closed, 1);
    assert.equal(away.allow(), false);
  });
});

describe("a trust card's life: up until it's settled, settled once, from anywhere", () => {
  const cards = () => {
    const settled: Array<[string, TrustSettled]> = [];
    const answered: Array<[string, boolean]> = [];
    const all = new TrustCards((q, how) => settled.push([q.sessionId, how]));
    const ask = (id: string) => {
      const q = new TrustQuestion(id, DOZER, DOZER, (allow) => answered.push([id, allow]));
      let closed = 0;
      q.onClosed = () => closed++;
      assert.equal(all.add(q), true);
      return { q, closed: () => closed };
    };
    return { all, settled, answered, ask };
  };

  test("asked: up, oldest first, one per session; nothing takes it down but settling (no window)", () => {
    const { all, ask, settled } = cards();
    const dozer = ask("starting-dozer");
    const rex = ask("starting-rex");
    assert.equal(all.add(new TrustQuestion("starting-dozer", DOZER, DOZER, () => {})), false, "one up per session");
    assert.deepEqual(
      all.up().map((q) => q.sessionId),
      ["starting-dozer", "starting-rex"],
    );
    assert.equal(all.get("starting-dozer"), dozer.q);
    // The floor's voice window running out (release) leaves it up.
    dozer.q.release();
    assert.equal(all.get("starting-dozer"), dozer.q);
    assert.equal(dozer.q.open, true);
    assert.deepEqual(settled, []);
    assert.equal(rex.closed(), 0);
  });

  for (const [how, allow] of [
    ["card", true],
    ["voice", false],
    ["phone", true],
  ] as const) {
    test(`answered here (${how}): its answer handed over, taken down, told once`, () => {
      const { all, ask, settled, answered } = cards();
      const { q, closed } = ask("starting-dozer");
      assert.equal(all.settle("starting-dozer", how, allow), true);
      assert.deepEqual(answered, [["starting-dozer", allow]]);
      assert.deepEqual(settled, [["starting-dozer", how]]);
      assert.deepEqual([q.open, q.answered, q.settledHow, closed()], [false, allow, how, 0]);
      assert.equal(all.get("starting-dozer"), undefined);
      assert.deepEqual(all.up(), []);
      // A second phone (or the Mac) answering after: nothing to answer, nothing pressed or told again.
      assert.equal(all.settle("starting-dozer", "phone", !allow), false);
      assert.deepEqual(answered, [["starting-dozer", allow]]);
      assert.deepEqual(settled, [["starting-dozer", how]]);
    });
  }

  for (const how of ["terminal", "session_start", "ended"] as const) {
    test(`gone by itself (${how}): closed, nothing pressed, taken down, told once`, () => {
      const { all, ask, settled, answered } = cards();
      const { q, closed } = ask("starting-dozer");
      const rex = ask("starting-rex");
      assert.equal(all.settle("starting-dozer", how), true);
      assert.deepEqual(answered, []);
      assert.deepEqual(settled, [["starting-dozer", how]]);
      assert.deepEqual([q.open, q.answered, q.settledHow, closed()], [false, null, how, 1]);
      assert.deepEqual(all.up(), [rex.q], "the others stay up");
      // SessionStart after it was answered in its window: already down.
      assert.equal(all.settle("starting-dozer", "session_start"), false);
      assert.equal(closed(), 1);
      assert.equal(q.allow(), false, "a late tap does nothing");
      assert.deepEqual(answered, []);
    });
  }

  test("settling a session with no card up does nothing", () => {
    const { all, settled } = cards();
    assert.equal(all.settle("starting-none", "ended"), false);
    assert.deepEqual(settled, []);
  });

  test("asked again after it was settled (an answer that didn't take): a new card", () => {
    const { all, ask, settled } = cards();
    ask("starting-dozer");
    all.settle("starting-dozer", "card", true);
    const again = ask("starting-dozer");
    assert.equal(all.get("starting-dozer"), again.q);
    assert.equal(again.q.open, true);
    assert.deepEqual(settled, [["starting-dozer", "card"]]);
  });
});

describe("no window for a trust card: still up long after the permission window", () => {
  test("the floor asks it for its 20s and moves on; the card stays up 25s later, nothing pressed; another prompt still goes after its window", () => {
    const clock = new FakeClock();
    const made: Waiter[] = [];
    const info: string[] = [];
    const floor = new Floor<Waiter & { release(): boolean }>({
      windows: () => ({ reply: 8_000, fyi: 3_000, permission: 20_000 }),
      quietNeedsUser: 0.5,
      giveWayMs: 2_000,
      unheardMs: 150,
      audio: { busy: () => false, quiet: () => Promise.resolve() },
      whyClosed: (request) => (isTrust(request) ? "no answer yet; its card stays up" : "no answer"),
      make: (request) => void made.push(request),
      cut: () => {},
      stopTalking: () => {},
      info: (text) => void info.push(text),
      log: () => {},
      changed: () => {},
      clock,
    });
    const settled: TrustSettled[] = [];
    const cards = new TrustCards((_, how) => settled.push(how));
    const answers: boolean[] = [];
    const dozer = new TrustQuestion("starting-dozer", DOZER, DOZER, (allow) => answers.push(allow));
    cards.add(dozer);
    floor.add(dozer);
    assert.equal(floor.current, dozer);
    floor.startReplyTimer(); // asked out loud: its voice window counts
    clock.advance(25_000);
    assert.equal(floor.current, null, "the floor moved on: a bare yes isn't taken as its answer now");
    assert.deepEqual(info, ["(no answer yet; its card stays up)"]);
    assert.equal(dozer.open, true, "still asking");
    assert.deepEqual(cards.up(), [dozer], "its card still up");
    assert.deepEqual([answers, settled], [[], []], "never answered for you");
    // Another prompt keeps its window: let go after 20s, its card gone.
    let gone = false;
    const other = { sessionId: "s1", isPermission: true, open: true, release: () => ((gone = true), true) };
    floor.add(other);
    floor.startReplyTimer();
    clock.advance(20_001);
    assert.equal(gone, true);
    assert.deepEqual(cards.up(), [dozer], "the trust card through all that");
    // Then answered on a phone: down, its answer handed over.
    cards.settle("starting-dozer", "phone", true);
    assert.deepEqual([answers, settled, cards.up()], [[true], ["phone"], []]);
  });
});

/**
 * A pretend pane at the trust question: Down and Up move ❯ (when `moves`), Enter takes the option
 * picked (Yes: the question goes; No: the pane's program ends), Escape ends it (when `escapes`).
 */
function pane(o: { moves?: boolean; escapes?: boolean; start?: "yes" | "no" | null } = {}) {
  let picked: "yes" | "no" | null = o.start === undefined ? "no" : o.start;
  let state: "asking" | "started" | "exited" = "asking";
  const pressed: string[] = [];
  const draw = () => {
    if (state === "started") return " ✻ Welcome to Claude Code!\n\n> ";
    if (state === "exited") return "me@mac 2026-10-29-dozer % ";
    return screen("trust")
      .replace(" ❯ No, exit", picked === "no" ? " ❯ No, exit" : "   No, exit")
      .replace("   Yes, I trust this folder", picked === "yes" ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder");
  };
  const io: TrustKeys = {
    screen: async () => draw(),
    press: async (key) => {
      pressed.push(key);
      if (state !== "asking") return { sent: true };
      if ((key === "down" || key === "up") && o.moves !== false) picked = picked === "no" ? "yes" : "no";
      if (key === "enter") state = picked === "yes" ? "started" : picked === "no" ? "exited" : state;
      if (key === "escape" && o.escapes !== false) state = "exited";
      return { sent: true };
    },
    wait: async () => {},
  };
  return { io, pressed, state: () => state };
}

describe("answering the trust question", () => {
  test('allow: Down to "Yes", seen there, then Enter; the session starts', async () => {
    const p = pane();
    assert.deepEqual(await answerTrust(p.io, true), { ok: true, how: "down+enter" });
    assert.deepEqual(p.pressed, ["down", "enter"]);
    assert.equal(p.state(), "started");
  });

  test('allow with "Yes" picked already: Enter only, never a Down that would wrap round to "No"', async () => {
    const p = pane({ start: "yes" });
    assert.deepEqual(await answerTrust(p.io, true), { ok: true, how: "enter" });
    assert.deepEqual(p.pressed, ["enter"]);
  });

  test('allow: the selection didn\'t move to "Yes": no Enter, the question left on its screen', async () => {
    const p = pane({ moves: false });
    const r = await answerTrust(p.io, true);
    assert.equal(r.ok, false);
    assert.equal(r.how, "down");
    assert.match(r.why!, /didn't press Enter/);
    assert.ok(!p.pressed.includes("enter"));
    assert.equal(p.state(), "asking");
  });

  test("allow: can't tell which is picked: nothing pressed at all", async () => {
    const p = pane({ start: null });
    const r = await answerTrust(p.io, true);
    assert.deepEqual([r.ok, r.how], [false, "none"]);
    assert.deepEqual(p.pressed, []);
  });

  test("allow: the question isn't there: nothing pressed", async () => {
    const io: TrustKeys = { screen: async () => "me@mac % ", press: async () => assert.fail("nothing pressed"), wait: async () => {} };
    const r = await answerTrust(io, true);
    assert.equal(r.ok, false);
    assert.match(r.why!, /isn't on its screen/);
  });

  test("allow: a key that tmux refused: no Enter", async () => {
    const p = pane();
    const pressed: string[] = [];
    const io: TrustKeys = { ...p.io, press: async (key) => (pressed.push(key), { sent: false, why: "its program has ended" }) };
    const r = await answerTrust(io, true);
    assert.equal(r.ok, false);
    assert.deepEqual(pressed, ["down"]);
  });

  test("deny: Escape, and it exits", async () => {
    const p = pane();
    assert.deepEqual(await answerTrust(p.io, false), { ok: true, how: "escape" });
    assert.equal(p.state(), "exited");
  });

  test("deny: Escape, and it exits leaving its last screen behind: done, nothing more pressed", async () => {
    const p = pane();
    const io: TrustKeys = { ...p.io, screen: async () => screen("trust"), running: async () => p.state() === "asking" };
    assert.deepEqual(await answerTrust(io, false), { ok: true, how: "escape" });
    assert.deepEqual(p.pressed, ["escape"]);
  });

  test('deny where Escape doesn\'t do it: "No, exit" picked (Up from "Yes"), seen, then Enter', async () => {
    const p = pane({ escapes: false, start: "yes" });
    assert.deepEqual(await answerTrust(p.io, false), { ok: true, how: "escape+up+enter" });
    assert.equal(p.state(), "exited");
  });

  test('deny: neither Escape nor Up does anything: no Enter on "Yes"', async () => {
    const p = pane({ escapes: false, moves: false, start: "yes" });
    const r = await answerTrust(p.io, false);
    assert.equal(r.ok, false);
    assert.ok(!p.pressed.includes("enter"));
    assert.equal(p.state(), "asking");
  });
});
