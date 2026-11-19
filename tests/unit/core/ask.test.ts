// Claude's multiple-choice questions (src/core/ask.ts): reading them from AskUserQuestion's input,
// how they're said, your words matched to an option in code, the model's pick checked against the
// options, the answers in Claude Code's form, the phone's answers checked, and the walk through them
// one at a time, on the floor's permission window (a fake clock, as tests/unit/core/floor.test.ts).
import "../../setup.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answersFor, Asking, askWhat, checkAnswers, fromModel, matchAnswer, readQuestions, spokenQuestion, type AskQuestion, type Match } from "../../../src/core/ask.ts";
import { decide, type DecideDeps, type DecideState } from "../../../src/core/decide.ts";
import { Floor, type Waiter } from "../../../src/core/floor.ts";
import { FakeClock } from "../../support/clock.ts";
import { makeWorld } from "../../support/fixtures.ts";

// Questions as Claude Code sent them.
const INPUT = {
  questions: [
    {
      question: "tmux isn't installed on this Mac (`tmux` not found). Can I install it with Homebrew (`brew install tmux`) tonight?",
      header: "Install tmux",
      options: [
        { label: "Yes, install it (Recommended)", description: "I run `brew install tmux`." },
        { label: "No, I'll install it", description: "You install it in the morning." },
      ],
      multiSelect: false,
    },
    {
      question: "How should sessions you start yourself get into Kiko's tmux, so Kiko can type into them?",
      header: "Your sessions",
      options: [
        { label: "`kiko claude` command (Recommended)", description: "A small command." },
        { label: "Wrap `claude` itself", description: "A shell alias." },
        { label: "Only Kiko's own sessions", description: "Decide the rest later." },
      ],
      multiSelect: false,
    },
    {
      question: "Overnight, how far should I go without you?",
      header: "Overnight",
      options: [
        { label: "Build, merge to main (Recommended)", description: "Merge each piece." },
        { label: "Build on a branch only", description: "Main stays as it is." },
      ],
      multiSelect: false,
    },
  ],
};
const QS = readQuestions(INPUT)!;
const CHECKS: AskQuestion = {
  question: "Which checks should run before each merge?",
  header: "Checks",
  options: [
    { label: "Typecheck", description: "" },
    { label: "Unit tests", description: "" },
    { label: "App tests", description: "" },
  ],
  multiSelect: true,
};
const pick = (...picks: number[]): Match => ({ kind: "pick", picks });

describe("reading them", () => {
  test("AskUserQuestion's input: each question, its header, options and multiSelect", () => {
    assert.equal(QS.length, 3);
    assert.deepEqual(
      QS[1].options.map((o) => o.label),
      ["`kiko claude` command (Recommended)", "Wrap `claude` itself", "Only Kiko's own sessions"],
    );
    assert.equal(QS[0].multiSelect, false);
    assert.equal(askWhat(QS), "ask 3 questions: Install tmux, Your sessions, Overnight");
  });

  test("ones that can't be answered by their text aren't read: none, no text, a label missing, the same question twice", () => {
    assert.equal(readQuestions({}), null);
    assert.equal(readQuestions({ questions: [] }), null);
    assert.equal(readQuestions({ questions: [{ header: "x", options: [] }] }), null);
    assert.equal(readQuestions({ questions: [{ question: "Which?", options: [{ description: "no label" }] }] }), null);
    assert.equal(readQuestions({ questions: [INPUT.questions[0], INPUT.questions[0]] }), null);
  });
});

describe("saying them", () => {
  test("one at a time: who asks and how many, the question, the options numbered, recommended said once, no code marks", () => {
    const asking = new Asking(QS);
    assert.equal(
      asking.start("Kiko"),
      "Kiko has 3 questions. First, tmux isn't installed on this Mac (tmux not found). Can I install it with Homebrew (brew install tmux) tonight? One: Yes, install it, recommended. Two: No, I'll install it.",
    );
    assert.equal(
      spokenQuestion(QS[1], 1, 3),
      "Next, Your sessions: How should sessions you start yourself get into Kiko's tmux, so Kiko can type into them? One: kiko claude command, recommended. Two: Wrap claude itself. Three: Only Kiko's own sessions.",
    );
    // The header the question already says isn't said twice.
    assert.equal(spokenQuestion(QS[2], 2, 3), "Last one, Overnight, how far should I go without you? One: Build, merge to main, recommended. Two: Build on a branch only.");
  });

  test("one question: no count; several to pick: said so", () => {
    assert.equal(new Asking([CHECKS]).start("It"), "It asks. Which checks should run before each merge? Pick any. One: Typecheck. Two: Unit tests. Three: App tests.");
    assert.equal(new Asking([QS[1]]).start("Kiko"), `Kiko asks. ${spokenQuestion(QS[1], 0, 1)}`);
    assert.match(spokenQuestion(QS[1], 0, 1), /^Your sessions: How should/);
  });
});

describe("your words, matched in code", () => {
  const cases: Array<[string, number, Match]> = [
    ["Yes, install it.", 0, pick(0)],
    ["the first one", 0, pick(0)],
    ["Number two.", 0, pick(1)],
    ["Two.", 1, pick(1)],
    ["Option to", 1, pick(1)],
    ["The last one.", 1, pick(2)],
    ["Go with the recommended one.", 1, pick(0)],
    ["Yes.", 0, pick(0)],
    ["No.", 0, pick(1)],
    ["No, I'll install it myself.", 0, pick(1)],
    ["The kiko claude command.", 1, pick(0)],
    ["Wrap claude.", 1, pick(1)],
    ["Only Kiko's.", 1, pick(2)],
    ["Build on a branch.", 2, pick(1)],
    ["I'll answer it at the Mac.", 0, { kind: "mac" }],
    ["Skip.", 0, { kind: "mac" }],
    ["Let me answer that on the computer", 1, { kind: "mac" }],
    ["Repeat that.", 0, { kind: "repeat" }],
    ["What were the options?", 1, { kind: "repeat" }],
    // Code can't tell: the model's turn.
    ["Not the first one.", 0, { kind: "unclear" }],
    ["Claude.", 1, { kind: "unclear" }],
    ["Yes.", 1, { kind: "unclear" }],
    ["Um.", 0, { kind: "unclear" }],
    ["Let's use Postgres instead.", 0, { kind: "unclear" }],
  ];
  for (const [text, q, want] of cases) {
    test(`${JSON.stringify(text)} to "${QS[q].header}"`, () => assert.deepEqual(matchAnswer(QS[q], text), want));
  }

  test("several where it takes several: numbers, labels, both or all", () => {
    assert.deepEqual(matchAnswer(CHECKS, "One and three."), pick(0, 2));
    assert.deepEqual(matchAnswer(CHECKS, "Typecheck and unit tests"), pick(0, 1));
    assert.deepEqual(matchAnswer(CHECKS, "All of them."), pick(0, 1, 2));
    assert.deepEqual(matchAnswer(CHECKS, "Unit tests."), pick(1));
  });

  test("two options where it takes one: unclear", () => {
    assert.deepEqual(matchAnswer(QS[1], "One and three."), { kind: "unclear" });
  });

  test("a question with no options: your words are the answer", () => {
    const open: AskQuestion = { question: "What should the new project be called?", header: "Name", options: [], multiSelect: false };
    assert.deepEqual(matchAnswer(open, "Call it Pixel."), { kind: "other", text: "Call it Pixel." });
    assert.deepEqual(matchAnswer(open, "Yes."), { kind: "unclear" });
  });
});

describe("the model's pick, checked against the options", () => {
  test("a number in range is that option; out of range, or two where it takes one, is unclear", () => {
    assert.deepEqual(fromModel(QS[1], "2", "the alias one"), pick(1));
    assert.deepEqual(fromModel(QS[1], "2.\n", "the alias one"), pick(1));
    assert.deepEqual(fromModel(QS[1], "4", "x"), { kind: "unclear" });
    assert.deepEqual(fromModel(QS[1], "0", "x"), { kind: "unclear" });
    assert.deepEqual(fromModel(QS[1], "1, 2", "x"), { kind: "unclear" });
    assert.deepEqual(fromModel(CHECKS, "3, 1", "app tests and typecheck"), pick(0, 2));
  });

  test("OTHER takes your words as said, only when they can be an answer", () => {
    assert.deepEqual(fromModel(QS[0], "OTHER", "Use the one already in /opt"), { kind: "other", text: "Use the one already in /opt" });
    assert.deepEqual(fromModel(QS[0], "OTHER", "Yeah, okay."), { kind: "unclear" });
  });

  test("MAC, REPEAT; anything else is unclear", () => {
    assert.deepEqual(fromModel(QS[0], "MAC", "later"), { kind: "mac" });
    assert.deepEqual(fromModel(QS[0], "repeat", "what"), { kind: "repeat" });
    assert.deepEqual(fromModel(QS[0], "I think they meant yes", "hmm"), { kind: "unclear" });
    assert.deepEqual(fromModel(QS[0], "", "hmm"), { kind: "unclear" });
  });
});

describe("the answers", () => {
  test('in Claude Code\'s form: question → label as it is; several joined with ", ", one holding ", " then quoted; your own words as said', () => {
    const qs = [
      ...QS.slice(0, 2),
      CHECKS,
      {
        ...CHECKS,
        question: "Which ones?",
        options: [
          { label: "Build, merge", description: "" },
          { label: "Wait", description: "" },
        ],
      },
    ];
    assert.deepEqual(
      answersFor(qs, [
        { labels: ["Yes, install it (Recommended)"], text: "" },
        { labels: [], text: "Use a launch agent instead" },
        { labels: ["Typecheck", "App tests"], text: "" },
        { labels: ["Build, merge", "Wait"], text: "" },
      ]),
      {
        [QS[0].question]: "Yes, install it (Recommended)",
        [QS[1].question]: "Use a launch agent instead",
        [CHECKS.question]: "Typecheck, App tests",
        "Which ones?": '"Build, merge", Wait',
      },
    );
  });

  test("the phone's, checked: one per question, the options' own labels, one at most where it takes one, something for each", () => {
    const qs = [QS[0], CHECKS];
    assert.deepEqual(checkAnswers(qs, [{ labels: ["No, I'll install it"] }, { labels: ["App tests", "Typecheck"] }]), [
      { labels: ["No, I'll install it"], text: "" },
      { labels: ["Typecheck", "App tests"], text: "" }, // in the options' order
    ]);
    assert.deepEqual(checkAnswers(qs, [{ labels: [], text: " Later tonight " }, { labels: ["Unit tests"] }]), [
      { labels: [], text: "Later tonight" },
      { labels: ["Unit tests"], text: "" },
    ]);
    assert.equal(checkAnswers(qs, [{ labels: ["Maybe"] }, { labels: ["Unit tests"] }]), null, "not an option");
    assert.equal(checkAnswers(qs, [{ labels: QS[0].options.map((o) => o.label) }, { labels: ["Unit tests"] }]), null, "two where it takes one");
    assert.equal(checkAnswers(qs, [{ labels: [] }, { labels: ["Unit tests"] }]), null, "nothing for one");
    assert.equal(checkAnswers(qs, [{ labels: ["No, I'll install it"] }]), null, "one missing");
  });
});

describe("the walk through them", () => {
  test("each answer confirmed with the next question; after the last, all the answers", () => {
    const a = new Asking(QS);
    assert.equal(a.take(pick(0)).say.split(" Next, ")[0], "Got it: Yes, install it.");
    const second = a.take({ kind: "other", text: "Use a launch agent" });
    assert.match(second.say, /^Got it: Use a launch agent\. Last one, Overnight/);
    const last = a.take(pick(1));
    assert.equal(last.say, "Got it: Build on a branch only.");
    assert.deepEqual(last.done, [
      { labels: ["Yes, install it (Recommended)"], text: "" },
      { labels: [], text: "Use a launch agent" },
      { labels: ["Build on a branch only"], text: "" },
    ]);
  });

  test("words it can't place: asked again once, with the options; twice, left at the Mac. Asking again doesn't count", () => {
    const a = new Asking(QS);
    const again = a.take({ kind: "unclear" });
    assert.equal(again.say, "Sorry, which one? Say a number, or your own answer. One: Yes, install it, recommended. Two: No, I'll install it.");
    assert.equal(again.leave, undefined);
    assert.equal(a.take({ kind: "repeat" }).leave, undefined);
    const left = a.take({ kind: "unclear" });
    assert.equal(left.leave, "not understood twice");
    assert.equal(left.done, undefined);
  });

  test("an answer after one it couldn't place starts the count again", () => {
    const a = new Asking(QS);
    a.take({ kind: "unclear" });
    a.take(pick(0));
    assert.equal(a.take({ kind: "unclear" }).leave, undefined);
  });

  test('"I\'ll answer at the Mac": left there', () => {
    const step = new Asking(QS).take({ kind: "mac" });
    assert.deepEqual([step.say, step.leave], ["OK, it's waiting at the Mac.", "left at the Mac"]);
  });
});

describe("decide(), with the questions waiting", () => {
  const W = makeWorld([{ name: "Kiko", folder: "kiko", given: "Kiko", title: "Voice app", status: "blocked", asked: "Plan tonight" }]);
  const S = W.sessions[0];
  async function run(text: string) {
    let models = 0;
    const deps: DecideDeps = {
      utterance: async () => {
        models++;
        return { audience: S, audienceConfidence: 0.95, intent: "message", intentConfidence: 0.95, appParts: 0, model: "test", costUsd: 0, ms: 1 };
      },
      approval: async () => {
        models++;
        return { answer: "allow", confidence: 1, costUsd: 0, ms: 1 };
      },
      route: async () => {
        models++;
        return { text: "", actions: [], claimsAction: false, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0 };
      },
      trim: null,
    };
    const state: DecideState = {
      text,
      sessions: W.sessions,
      notes: W.notes,
      recent: [],
      waiting: { sessionId: S.sessionId, cwd: S.cwd, permission: askWhat(QS), questions: true },
      justSpoke: null,
      lastId: null,
      appAsked: false,
      lastSent: null,
      lastRepeat: false,
      voiceCan: "messages",
      classifierMinConfidence: 0.75,
    };
    return { ...(await decide(state, deps)), models };
  }

  test("your words are the answer to the one being asked, with no yes-or-no read and no routing", async () => {
    for (const said of ["Yes, install it.", "Skip that.", "Repeat that."]) {
      const d = await run(said);
      assert.equal(d.step, "answer", said);
      assert.deepEqual(d.actions, [{ type: "answer", text: said }]);
      assert.equal(d.models, 0);
    }
  });

  test('"Kiko, …" up front: the rest is the answer', async () => {
    const d = await run("Kiko, the second one.");
    assert.deepEqual(d.actions, [{ type: "answer", text: "The second one." }]);
  });
});

// The prompt on the floor, as app.ts asks it: its window (1s here) after each question is said, an
// answer starting it over with the next, the last answer settling it, and running out leaving it in
// the terminal with nothing answered.
describe("on the floor's permission window", () => {
  class Prompt implements Waiter {
    readonly sessionId = "s";
    readonly isPermission = true;
    released = false;
    answered: unknown = null;
    get open() {
      return !this.released && !this.answered;
    }
    release() {
      if (!this.open) return false;
      this.released = true;
      return true;
    }
  }
  function setup() {
    const clock = new FakeClock();
    const said: string[] = [];
    const prompt = new Prompt();
    const asking = new Asking(QS.slice(0, 2));
    const floor: Floor<Prompt> = new Floor<Prompt>({
      windows: () => ({ reply: 1500, fyi: 600, permission: 1000 }),
      quietNeedsUser: 0.5,
      giveWayMs: 200,
      unheardMs: 150,
      audio: { busy: () => false, quiet: () => Promise.resolve() },
      whyClosed: () => "no answer; the questions are waiting in the terminal",
      make: (p) => {
        floor.announcing(p, () => {});
        say(asking.start("Kiko"));
      },
      cut: () => {},
      stopTalking: () => {},
      info: () => {},
      log: () => {},
      changed: () => {},
      clock,
    });
    /** Said: it makes a sound, and 50ms later it's over. */
    function say(text: string) {
      said.push(text);
      floor.playing();
      clock.advance(50);
      floor.idle();
    }
    /** Your words, dealt with as app.ts answerQuestion does. */
    const answer = (text: string) => {
      floor.keyDown();
      return floor.keyUp(async () => {
        const step = asking.take(matchAnswer(asking.current, text));
        say(step.say);
        if (step.done) {
          floor.drop(prompt);
          prompt.answered = step.done;
        } else if (step.leave) floor.release(prompt, step.leave);
        return true;
      });
    };
    return { clock, floor, prompt, said, answer };
  }

  test("each question gets the whole window; the last answer settles it", async () => {
    const f = setup();
    f.floor.add(f.prompt);
    assert.match(f.said[0], /^Kiko has 2 questions\./);
    f.clock.advance(900);
    await f.answer("the first one");
    assert.match(f.said[1], /^Got it: Yes, install it\. Last one, Your sessions/);
    f.clock.advance(900);
    assert.ok(f.prompt.open, "the window started over with the second question");
    await f.answer("wrap claude");
    assert.equal(f.said[2], "Got it: Wrap claude itself.");
    assert.deepEqual(f.prompt.answered, [
      { labels: ["Yes, install it (Recommended)"], text: "" },
      { labels: ["Wrap `claude` itself"], text: "" },
    ]);
    assert.equal(f.floor.current, null);
    assert.equal(f.clock.pending(), 0);
  });

  test("running out on a question leaves them all in the terminal, the answers so far not sent", async () => {
    const f = setup();
    f.floor.add(f.prompt);
    await f.answer("number two");
    f.clock.advance(999);
    assert.ok(f.prompt.open);
    f.clock.advance(1);
    assert.equal(f.prompt.released, true);
    assert.equal(f.prompt.answered, null);
  });

  test('"I\'ll answer at the Mac" lets it go at once', async () => {
    const f = setup();
    f.floor.add(f.prompt);
    await f.answer("I'll do it at the Mac");
    assert.equal(f.prompt.released, true);
    assert.equal(f.said.at(-1), "OK, it's waiting at the Mac.");
    assert.equal(f.floor.current, null);
  });
});
