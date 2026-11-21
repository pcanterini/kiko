// First-run setup's steps (src/ui/onboarding.ts) run for real on @clack/prompts, every one driven
// with fake deps through a fake terminal (keys written to its input, what's drawn read back): what
// each step says, what its keys do, that Esc skips one step only, and that a key typed is never drawn.
// Nothing here touches the Mac: no permission is asked, no mic or key helper runs, no voice speaks,
// no key reaches the Keychain (KIKO_KEYCHAIN is off: tests/setup.ts) or a provider.
import "../../setup.ts";
import assert from "node:assert/strict";
import { MULTISELECT_INSTRUCTIONS } from "@clack/prompts";
import { afterEach, describe, test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import type { CardRow } from "../../../src/agents/setup.ts";
import type { KeyCheck } from "../../../src/core/keys.ts";
import type { MicDevice } from "../../../src/core/mic-device.ts";
import type { StepId } from "../../../src/core/onboarding.ts";
import type { PrepNow } from "../../../src/core/pocket-prep.ts";
import type { PermissionId, Permissions } from "../../../src/platform/types.ts";
import { nameWarning } from "../../../src/core/wake.ts";
import { TERMS_DATE, termsNotice } from "../../../src/core/terms.ts";
import { checkWaits } from "../../support/until.ts";
import { runSetup, setupSignInLine, type MicHeard, type SetupDeps, type SetupEnd } from "../../../src/ui/onboarding.ts";
import { COMMAND } from "../../../src/core/name.ts";
import { ESCAPE_MS, live, type Key } from "../../../src/ui/live.ts";
import { TAGLINE } from "../../../src/ui/logo.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followCode, setupAccount, type CodeUi } from "../../../src/account-cli.ts";
import { Account, type NewCode, SESSION_KEY, type SignIn } from "../../../src/core/account/account.ts";
import { accountClient, type DeviceStart } from "../../../src/core/account/client.ts";
import { planRunsAi } from "../../../src/core/account/plan-words.ts";
import { billingRefused, EMAIL, fakeAccountServer, happyScript, memoryStore, planJson, proJson, SESSION_TOKEN, sessionAnswer, trialRefused, USER_CODE } from "../../support/fake-account.ts";

const FAKE_KEY = "sk-or-v1-fake0000test1111fake2222";
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long setup waits after an Esc to call it one (live.ts ESCAPE_MS, as Clack's escapeCodeTimeout). */
const ESC_TIMEOUT_MS = ESCAPE_MS;
/** After a key typed: a turn for the step to take it (the fakes answer at once). After an Esc: the terminal's wait for more, then that. */
const KEY_MS = 10;
const ESC_MS = ESC_TIMEOUT_MS + 20;
/** What's drawn, waited for: looked at every 10ms, for two seconds (KIKO_TEST_SLOW stretches it). */
const drawn = checkWaits(2000);
/** Drawn text without colours, the rail or line wraps: a sentence reads whole however it wrapped. */
const plain = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/[│┌└├╮╯─]/g, " ")
    .replace(/\s+/g, " ");

/** What a test's fakes were asked to do. */
type Calls = {
  requested: PermissionId[];
  opened: PermissionId[];
  done: string[];
  answered: (string[] | "later")[];
  checked: string[];
  saved: string[];
  said: string[];
  talkKeys: string[];
  names: string[];
  resume: (StepId | null)[];
  logged: string[];
  /** The mics picked (setup's mic step: the UIDs, "" for the system default). */
  mics: string[];
};

const MIC: MicDevice = { uid: "built-in", name: "MacBook Pro Microphone", isDefault: true };

function fakeDeps(
  over: Partial<SetupDeps> & {
    perms?: Partial<Permissions>;
    afterRequest?: Partial<Permissions>;
    check?: KeyCheck;
    rows?: CardRow[] | null;
    notInstalled?: string | null;
    /** What the agents' answer comes to (agents.answer), in place of the fake's own words. */
    agentsSaid?: string;
    /** Pocket's download as each look finds it, in turn (the last one kept); none by default: nothing to wait for. */
    voices?: PrepNow[];
    inputs?: MicDevice[][];
    listenFails?: string;
    /** Whether there's a model key as setup starts (one saved makes it true); true unless said. */
    hasKey?: boolean;
  } = {},
) {
  const calls: Calls = { requested: [], opened: [], done: [], answered: [], checked: [], saved: [], said: [], talkKeys: [], names: [], resume: [], logged: [], mics: [] };
  let perms: Permissions = { mic: "unknown", speech: "unknown", input: "unknown", ...over.perms };
  const inputs = [...(over.inputs ?? [[MIC]])];
  const listeners: (() => void)[] = [];
  const control = {
    press: () => listeners.forEach((l) => l()),
    capture: (_name: string) => {},
    level: (_l: number) => {},
    heard: (_t: string) => {},
    finishMic: (_r: MicHeard) => {},
    /** Input Monitoring turned on in System Settings: the next look sees it. */
    grant: (which: PermissionId) => (perms = { ...perms, [which]: "granted" }),
    micTests: 0,
    /** Pocket's download as the last look found it, and how many looks there were. */
    voice: null as PrepNow | null,
    voiceLooks: 0,
  };
  let hasKey = over.hasKey ?? true;
  let micPicked: { uid: string; name: string } | null = null;
  let label = "Right Option";
  let named = "Kiko";
  const deps: SetupDeps = {
    app: "Ghostty",
    missing: [],
    permissions: {
      initial: { ...perms },
      status: async () => perms,
      request: async (which) => {
        calls.requested.push(which);
        perms = { ...perms, ...over.afterRequest };
        return perms[which];
      },
      pane: (which) => `Privacy & Security → ${{ mic: "Microphone", speech: "Speech Recognition", input: "Input Monitoring" }[which]}`,
      open: (which) => void calls.opened.push(which),
    },
    agents: {
      rows: over.rows === undefined ? null : over.rows,
      notInstalled: over.notInstalled ?? null,
      answer: (connect) => {
        calls.answered.push(connect);
        if (over.agentsSaid !== undefined) return over.agentsSaid;
        return connect === "later" ? "Not now, then: settings → Agents connects them any time." : `Connected ${connect.join(", ")}.`;
      },
    },
    key: {
      has: () => hasKey,
      store: true,
      check: async (key) => {
        calls.checked.push(key);
        return over.check ?? { result: "works", said: "✓ OpenRouter key works" };
      },
      save: async (key) => {
        calls.saved.push(key);
        hasKey = true;
        return null;
      },
    },
    micPick: {
      current: () => micPicked,
      save: (uid, list) => {
        calls.mics.push(uid);
        micPicked = uid ? { uid, name: list.find((d) => d.uid === uid)?.name ?? uid } : null;
      },
    },
    micInputs: async () => (inputs.length > 1 ? inputs.shift()! : inputs[0]),
    micTest: (_ms, onLevel, onHeard) =>
      new Promise((resolve) => {
        control.micTests++;
        control.level = onLevel;
        control.heard = onHeard;
        control.finishMic = resolve;
      }),
    talkKey: {
      label: () => label,
      listen: (onDown, onFail) => {
        if (over.listenFails) {
          setTimeout(() => onFail(over.listenFails!), 5);
          return () => {};
        }
        listeners.push(onDown);
        return () => listeners.splice(listeners.indexOf(onDown), 1);
      },
      capture: () => new Promise((resolve) => (control.capture = resolve)),
      quiet: (name) => name === "right_command",
      labelOf: (name) => (name === "right_command" ? "Right Command" : "Key code 0"),
      save: (name) => {
        calls.talkKeys.push(name);
        label = name === "right_command" ? "Right Command" : "Key code 0";
      },
      menu: "Ctrl+Space",
    },
    name: {
      current: () => named,
      warning: nameWarning,
      save: (name) => {
        calls.names.push(name);
        named = name;
        return name;
      },
    },
    hello: {
      say: async (text) => void calls.said.push(text),
      voice: async () => {
        const voices = over.voices ?? [{ state: "none", fraction: 0, phase: "install" }];
        control.voiceLooks++;
        control.voice = voices.length > 1 ? voices.shift()! : voices[0];
        return control.voice;
      },
    },
    done: (step) => void calls.done.push(step),
    resume: { save: (step) => void calls.resume.push(step), command: "/Users/you/.local/bin/kiko setup" },
    tryLines: () => ["Ctrl+Space then c starts a session in one of your projects.", "Hold Right Option and say a session's name."],
    end: { label: "Open Kiko", later: "Run kiko when you're ready." },
    log: (event, fields) => void calls.logged.push(`${event} ${JSON.stringify(fields ?? {})}`),
    micMs: 50,
    pollMs: 20,
    ...over,
  };
  return { deps, calls, control };
}

/** Each setup a test started, to be ended after it. */
const running: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of running.splice(0)) await finish();
});

/** Setup run in a fake terminal: keys to press, and what's been drawn since the last look. */
function show(steps: StepId[], deps: SetupDeps) {
  let out = "";
  let seen = 0;
  const stdout = new Writable({ write: (chunk, _enc, done) => ((out += chunk.toString()), done()) }) as Writable & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = 100;
  stdout.rows = 40;
  stdout.isTTY = true;
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  // Its keys decoded by setup itself, an Esc one after ESC_TIMEOUT_MS (live.ts ESCAPE_MS): the
  // waits below are that long, so a setup back on readline's half second fails them.
  let end: SetupEnd | null = null;
  const ended = runSetup(steps, deps, { input: stdin, output: stdout }).then((e) => (end = e));
  // After the test: Esc on whatever's left, to the end, so nothing keeps running.
  running.push(async () => {
    for (let i = 0; i < 20 && end === null; i++) {
      stdin.write(ESC);
      await settle(ESC_MS);
    }
    stdin.destroy();
  });
  return {
    ended,
    end: () => end,
    /** The fake terminal's keys, as setup reads them. */
    input: stdin,
    /** Everything drawn so far, without colours. */
    all: () => plain(out),
    /** Everything drawn so far, as written (colours stripped, the rail kept). */
    raw: () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""),
    /** Waits (up to two seconds) until what's been drawn since the last look matches, then returns it. */
    until: async (re: RegExp) => {
      await drawn(
        () => re.test(plain(out.slice(seen))),
        () => `${re} in what was drawn:\n${plain(out.slice(seen))}`,
      );
      const s = plain(out.slice(seen));
      assert.match(s, re);
      seen = out.length;
      return s;
    },
    /** A key (or text) typed; Esc waits out readline's wait for a longer escape sequence. */
    press: async (key: string, times = 1) => {
      for (let i = 0; i < times; i++) {
        stdin.write(key);
        await settle(key === ESC ? ESC_MS : KEY_MS);
      }
    },
  };
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const CTRL_C = "\x03";

/** Ms from an Esc written to `input` to its `escape` keypress (setup decodes the stream's keys). */
function escTakes(input: PassThrough) {
  return new Promise<number>((resolve) => {
    const at = performance.now();
    const onKey = (_str: unknown, key: Key | undefined) => {
      if (key?.name !== "escape") return;
      input.off("keypress", onKey);
      resolve(performance.now() - at);
    };
    input.on("keypress", onKey);
    input.write(ESC);
  });
}

// Under readline's default an Esc waits half a second for more of a longer key: setup decoded the
// terminal's keys first, without a wait of its own, and Clack's 50 ms then went unused.
describe("Esc is Esc at once (live.ts ESCAPE_MS), not after half a second", () => {
  // Well under readline's 500 ms, with room for a busy machine.
  const QUICK_MS = 300;

  test("in setup's steps", async () => {
    const { deps } = fakeDeps({});
    const s = show(["name", "try"], deps);
    await s.until(/What do you want to call it\?/);
    const ms = await escTakes(s.input);
    assert.ok(ms >= ESCAPE_MS - 5 && ms < QUICK_MS, `Esc took ${Math.round(ms)} ms`);
    // And it skipped the step.
    await s.until(/What to try/);
  });

  test("in a live step's keys, read first", async () => {
    const input = new PassThrough();
    const output = new Writable({ write: (_chunk, _enc, done) => done() });
    const at = performance.now();
    let took = -1;
    const step = live({ input, output }, (_str, key) => {
      if (key.name === "escape" && took < 0) took = performance.now() - at;
    });
    input.write(ESC);
    await settle(QUICK_MS);
    step.end("skip", "Skipped");
    input.destroy();
    assert.ok(took >= 0 && took < QUICK_MS, `Esc took ${Math.round(took)} ms`);
  });
});

describe("the terms (clickwrap): said once per version before the first step, accepted by going on", () => {
  const AGREE = "By continuing, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).";

  test("never accepted: the line dim before the first step, kept once that step is behind", async () => {
    let accepted = 0;
    const { deps, calls } = fakeDeps({ terms: { line: termsNotice(undefined)!.line, accept: () => void accepted++ } });
    const s = show(["name", "try"], deps);
    const first = await s.until(/What do you want to call it\?/);
    assert.ok(first.includes(AGREE), first);
    // Right above the first step's question, after the heads-up.
    assert.ok(first.indexOf("By continuing") > first.indexOf("Heads up"));
    assert.ok(first.indexOf("By continuing") < first.indexOf("What do you want to call it?"));
    assert.equal(accepted, 0, "not before the step is answered");
    await s.press(ENTER);
    await s.until(/What to try/);
    assert.equal(accepted, 1, "going on past the first step accepts them");
    await s.press(ENTER);
    assert.equal(await s.ended, "open");
    assert.equal(accepted, 1, "once");
    assert.ok(calls.logged.some((l) => l.startsWith("setup_terms")));
  });

  test("the first step skipped (Esc) is still going on: accepted", async () => {
    let accepted = 0;
    const { deps } = fakeDeps({ terms: { line: AGREE, accept: () => void accepted++ } });
    const s = show(["name", "try"], deps);
    await s.until(/What do you want to call it\?/);
    await s.press(ESC);
    await s.until(/What to try/);
    assert.equal(accepted, 1);
  });

  test("Ctrl+C twice on the first step: setup stops, nothing accepted", async () => {
    let accepted = 0;
    // A live step (the voice's download waited for), where Ctrl+C twice stops setup within the step.
    const { deps } = fakeDeps({ terms: { line: AGREE, accept: () => void accepted++ }, voices: [{ state: "running", fraction: 0.4, phase: "install" }] });
    const s = show(["hello", "try"], deps);
    await s.until(/Getting Kiko's voice ready…/);
    await s.press(CTRL_C);
    await s.press(CTRL_C);
    assert.equal(await s.ended, "quit");
    assert.equal(accepted, 0);
  });

  test("only the last step (all set up, or the app's --need-key): the line said there, accepted on leaving it", async () => {
    let accepted = 0;
    const { deps } = fakeDeps({ terms: { line: AGREE, accept: () => void accepted++ } });
    const s = show(["try"], deps);
    const first = await s.until(/What to try/);
    assert.match(first, /By continuing, you agree to Kiko's Terms/);
    await s.press(ENTER);
    assert.equal(await s.ended, "open");
    assert.equal(accepted, 1);
  });

  test("changed since: the notice once (no question), accepted the same way", async () => {
    let accepted = 0;
    const notice = termsNotice({ version: "2026-01-01", at: "2026-01-02T00:00:00.000Z" })!;
    assert.equal(notice.kind, "changed");
    const { deps } = fakeDeps({ terms: { line: notice.line, accept: () => void accepted++ } });
    const s = show(["name", "try"], deps);
    const first = await s.until(/What do you want to call it\?/);
    assert.match(first, /Kiko's Terms changed on 4 Nov 2026: kiko\.sh\/terms/);
    assert.doesNotMatch(first, /By continuing/);
    await s.press(ENTER);
    await s.until(/What to try/);
    assert.equal(accepted, 1);
  });

  test("accepted already (this version): nothing said", async () => {
    assert.equal(termsNotice({ version: TERMS_DATE, at: "2026-11-04T10:00:00.000Z" }), null);
    const { deps } = fakeDeps({ terms: null });
    const s = show(["name", "try"], deps);
    const first = await s.until(/What do you want to call it\?/);
    assert.doesNotMatch(first, /Terms/);
  });
});

describe("first-run setup in Clack's steps", () => {
  test("one rail: the intro, each step's question, and the end", async () => {
    const { deps } = fakeDeps({ perms: { mic: "granted", input: "granted" } });
    const s = show(["name", "try"], deps);
    const first = await s.until(/What do you want to call it\?/);
    assert.match(first, /Kiko Dev setup/);
    assert.match(first, /Esc skips a step \(kiko-dev setup comes back to it\)/);
    // What Kiko is, said before anything is set up; the terms only when this version isn't accepted yet (below).
    assert.match(first, /AI makes mistakes/);
    assert.match(first, /responsible/);
    assert.doesNotMatch(first, /kiko\.sh\/terms/, "accepted already: no terms line");
    assert.match(s.raw(), /┌ {2}.*Kiko Dev setup/);
    assert.match(s.raw(), /◆ {2}What do you want to call it\?/);
    await s.press(ENTER);
    await s.until(/What to try/);
    assert.match(s.raw(), /◇ {2}What do you want to call it\?\n│ {2}Kiko/, "the step answered stays as a line");
    await s.press(ENTER);
    assert.equal(await s.ended, "open");
    assert.match(s.raw(), /└ {2}Open Kiko…/);
  });

  test("Kiko's logo and tagline once, above the title, as setup starts (header); a key pressed while it plays skips it and isn't kept for the first step; none without the header", async () => {
    const terms = termsNotice(undefined)!.line;
    const { deps } = fakeDeps({ perms: { mic: "granted", input: "granted" }, terms: { line: terms, accept: () => {} } });
    const s = show(["name", "try"], { ...deps, header: true });
    await s.press("z"); // while the logo plays
    await s.until(/What do you want to call it\?/);
    const all = s.all();
    assert.equal(all.split(TAGLINE).length - 1, 1, "the tagline whole once: its last frame");
    assert.ok(all.indexOf("██▓") < all.indexOf(TAGLINE) && all.indexOf(TAGLINE) < all.indexOf("Kiko Dev setup"), "the logo, its tagline, then the title");
    // The terms right under them: the first line of setup, before the heads-up.
    assert.ok(all.includes(`${TAGLINE} Kiko Dev setup ${terms}`), all);
    assert.ok(all.indexOf(terms) < all.indexOf("Heads up"));
    assert.equal(all.split(terms).length - 1, 1, "said once");
    assert.ok(s.raw().includes("\x1b[?25h") || !s.raw().includes("\x1b[?25l"), "the cursor shown again");
    await s.press(ENTER);
    await s.until(/What to try/);
    assert.match(s.raw(), /◇ {2}What do you want to call it\?\n│ {2}Kiko\n/, "the z skipped the logo; it isn't in the name");
    assert.equal(s.all().split(TAGLINE).length - 1, 1, "not again on the next step");
    await s.press(ENTER);
    assert.equal(await s.ended, "open");

    const { deps: plainDeps } = fakeDeps({ perms: { mic: "granted", input: "granted" } });
    const without = show(["name", "try"], plainDeps);
    await without.until(/What do you want to call it\?/);
    assert.ok(!without.all().includes(TAGLINE));
  });

  test("anything missing (no coding agent) is said first", async () => {
    const { deps } = fakeDeps({ missing: ["No coding agent found. Kiko talks to Claude Code, Codex or OpenCode."] });
    const s = show(["name", "try"], deps);
    const first = await s.until(/What do you want to call it/);
    assert.ok(first.indexOf("No coding agent found") < first.indexOf("What do you want to call it"));
    assert.match(s.raw(), /▲ {2}No coding agent found/);
  });

  describe("your agents", () => {
    const QUESTION = /Which coding agents should Kiko talk to\?/;
    const rows: CardRow[] = [
      { id: "claude-code", name: "Claude Code", state: "not connected", detail: "adds hooks to ~/.claude/settings.json", ask: true, ticked: true, hint: "adds hooks to ~/.claude/settings.json" },
      { id: "codex", name: "Codex CLI", state: "not connected", detail: "adds hooks to ~/.codex/hooks.json", ask: true, ticked: true, hint: "adds hooks to ~/.codex/hooks.json" },
      { id: "t3code", name: "T3 Code", state: "automatic", detail: "running: Kiko connects when it starts", ask: true, ticked: true, hint: "running: Kiko connects when it starts" },
    ];

    test("the agents it works with that aren't on this Mac: one line under the step; none when all are", async () => {
      const { deps } = fakeDeps({ rows, notInstalled: "Also works with: OpenCode (not installed here)." });
      const s = show(["agents", "try"], deps);
      const drawn = await s.until(QUESTION);
      assert.match(drawn, /Also works with: OpenCode \(not installed here\)\./);
      assert.equal(drawn.match(/Also works with/g)?.length, 1);
      const all = show(["agents", "try"], fakeDeps({ rows }).deps);
      assert.doesNotMatch(await all.until(QUESTION), /Also works with/);
    });

    test("every agent found a box, T3 Code too, ticked (no 'Also found' line); Space unticks; Enter answers with the ticked ones", async () => {
      const { deps, calls } = fakeDeps({ rows });
      const clacks = [...MULTISELECT_INSTRUCTIONS];
      const s = show(["agents", "try"], deps);
      const drawn = await s.until(QUESTION);
      // The keys in a line under the options, in place of Clack's own footer.
      assert.match(drawn, /T3 Code \([^)]*\) Pick at least one\. Space ticks, Enter goes on\./);
      assert.doesNotMatch(drawn, /to navigate/);
      assert.doesNotMatch(drawn, /Also found/);
      assert.doesNotMatch(drawn, /\([^()]*\(/, "no parentheses inside parentheses");
      assert.match(drawn, /backed up first/);
      assert.match(drawn, /◼ Claude Code \(adds hooks to ~\/\.claude\/settings\.json\)/);
      assert.match(drawn, /◼ Codex CLI \(adds hooks to ~\/\.codex\/hooks\.json\)/);
      assert.match(drawn, /◼ T3 Code \(running: Kiko connects when it starts\)/);
      await s.press(DOWN, 2);
      await s.press(" ");
      assert.match(await s.until(/◻ T3 Code/), /◻ T3 Code/);
      await s.press(ENTER);
      assert.match(await s.until(/Connected claude-code, codex\./), /Connected claude-code, codex\./);
      assert.deepEqual(calls.answered, [["claude-code", "codex"]], "T3 Code unticked: left out, so it's a no (agents/setup.ts answerCard)");
      assert.match(s.all(), /What to try/);
      assert.deepEqual(MULTISELECT_INSTRUCTIONS, clacks, "Clack's own footer is back for every other prompt");
    });

    test("T3 Code with nothing to add, and a connected agent: listed ticked, their hints in one level of parentheses", async () => {
      const listed: CardRow[] = [
        { id: "claude-code", name: "Claude Code", state: "connected", detail: "connected", ask: false, ticked: true, hint: "connected · signed in" },
        { id: "codex", name: "Codex CLI", state: "needs repair", detail: "", ask: false, ticked: false, hint: "needs repair: its hooks never fired (Codex 0.166.0)" },
        { id: "t3code", name: "T3 Code", state: "automatic", detail: "", ask: true, ticked: true, hint: "nothing to add: Kiko connects while it's running" },
      ];
      const { deps, calls } = fakeDeps({ rows: listed });
      const s = show(["agents", "try"], deps);
      const drawn = await s.until(QUESTION);
      assert.match(drawn, /◼ Claude Code \(connected · signed in\)/);
      assert.match(drawn, /◼ T3 Code \(nothing to add: Kiko connects while it's running\)/);
      assert.match(drawn, /Unticking a connected one disconnects it\./);
      // An unticked one's hint shows with the cursor on it (Clack's way).
      await s.press(DOWN);
      const onCodex = await s.until(/Codex CLI \(/);
      assert.match(onCodex, /Codex CLI \(needs repair: its hooks never fired: Codex 0\.166\.0\)/);
      assert.doesNotMatch(drawn + onCodex, /\([^()]*\(/, "no parentheses inside parentheses");
      await s.press(ENTER);
      await s.until(/What to try/);
      assert.deepEqual(calls.answered, [["claude-code", "t3code"]]);
    });

    test("nothing ticked: Enter doesn't go on (Clack asks for at least one); Esc still skips", async () => {
      const { deps, calls } = fakeDeps({ rows });
      const s = show(["agents", "name", "try"], deps);
      await s.until(QUESTION);
      for (let i = 0; i < 3; i++) {
        await s.press(" ");
        await s.press(DOWN);
      }
      await s.press(ENTER);
      assert.match(await s.until(/Please select at least one option/), /Please select at least one option/);
      assert.deepEqual(calls.answered, [], "not answered");
      await s.press(ESC);
      await s.until(/What do you want to call it/);
      assert.deepEqual(calls.answered, ["later"]);
      assert.doesNotMatch(plain(MULTISELECT_INSTRUCTIONS.join(" ")), /Pick at least one/, "skipped: Clack's own footer is back too");
    });

    test("the answer said short: what's connected in a line, what's left to do dim right under it", async () => {
      const said = "Connected Claude Code and Codex CLI.\nRestart Claude Code or Codex sessions that are already open; Codex asks once to trust its hooks.";
      const { deps } = fakeDeps({ rows, agentsSaid: said });
      const s = show(["agents", "try"], deps);
      await s.until(QUESTION);
      await s.press(ENTER);
      await s.until(/What to try/);
      assert.match(s.raw(), /◆ {2}Connected Claude Code and Codex CLI\.\n│ {2}Restart Claude Code or Codex sessions that are already open; Codex asks once to trust its hooks\.\n/);
    });

    test("Esc: later, remembered so it isn't asked again, and setup goes on", async () => {
      const { deps, calls } = fakeDeps({ rows });
      const s = show(["agents", "name", "try"], deps);
      await s.until(QUESTION);
      await s.press(ESC);
      const after = await s.until(/What do you want to call it/);
      assert.deepEqual(calls.answered, ["later"]);
      assert.match(after, /settings → Agents connects them any time/);
    });
  });

  describe("one key", () => {
    test("says where to get one; the key is checked, saved, and never drawn", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false });
      const s = show(["key", "try"], deps);
      const intro = await s.until(/Paste your OpenRouter key Get one at https:\/\/openrouter\.ai\/keys · it stays hidden/);
      assert.match(intro, /Kiko's summaries and replies run on OpenRouter: one key, a few dollars of credit \(about \$2–6 a month\)\./);
      assert.match(s.raw(), /https:\/\/openrouter\.ai\/keys/, "the link whole, for the terminal to make it one");
      await s.press(FAKE_KEY);
      assert.match(await s.until(/▪{10}/), /▪{10}/);
      await s.press(ENTER);
      assert.match(await s.until(/Looks good/), /Looks good: saved in the Keychain\./);
      assert.deepEqual(calls.checked, [FAKE_KEY]);
      assert.deepEqual(calls.saved, [FAKE_KEY]);
      assert.doesNotMatch(s.all(), /fake0000test/, "the key is never drawn");
      assert.match(s.all(), /What to try/);
    });

    test("a key turned down: OpenRouter's reason, nothing saved, paste another", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false, check: { result: "refused", said: "✗ OpenRouter turned the key down: User not found" } });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      const drawn = await s.until(/Paste another OpenRouter key/);
      assert.match(drawn, /OpenRouter turned the key down: User not found\. Nothing saved\./);
      assert.deepEqual(calls.saved, []);
      assert.doesNotMatch(s.all(), /fake0000test/);
      await s.press(ESC);
      assert.match(await s.until(/needs an OpenRouter key to answer/), /kiko-dev keys set openrouter adds one any time/);
    });

    test("couldn't be checked (offline): asked whether to save it anyway; n pastes another, y saves it", async () => {
      const unchecked: KeyCheck = { result: "unchecked", said: "Couldn't reach OpenRouter to check the key (offline?)" };
      const { deps, calls } = fakeDeps({ hasKey: false, check: unchecked });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      assert.match(await s.until(/Save it anyway\?/), /Couldn't reach OpenRouter to check the key \(offline\?\)/);
      await s.press("n");
      await s.until(/Paste another OpenRouter key/);
      assert.deepEqual(calls.saved, []);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      await s.until(/Save it anyway\?/);
      await s.press("y");
      assert.match(await s.until(/unchecked\)/), /Saved in the Keychain \(unchecked\)\./);
      assert.deepEqual(calls.saved, [FAKE_KEY]);
      assert.doesNotMatch(s.all(), /fake0000test/);
    });

    test("no Keychain (KIKO_KEYCHAIN off): says to use .env, nothing asked", async () => {
      const { deps } = fakeDeps();
      deps.key.store = false;
      const s = show(["key", "try"], deps);
      assert.match(await s.until(/What to try/), /No Keychain here \(KIKO_KEYCHAIN is off\): put OPENROUTER_API_KEY in \.env instead\./);
    });
  });

  describe("microphone", () => {
    test("never asked: Ask now asks macOS; granted, the test runs with its level and the words heard", async () => {
      const { deps, calls, control } = fakeDeps({ afterRequest: { mic: "granted" } });
      const s = show(["mic", "try"], deps);
      assert.match(await s.until(/Ask now/), /macOS asks whether Ghostty may use it/);
      await s.press(ENTER);
      assert.deepEqual(calls.requested, ["mic"]);
      await s.until(/Say something…/);
      control.level(0.9);
      assert.match(await s.until(/█/), /[▁▂▃▄▅▆▇█]{10}/);
      control.heard("hello");
      assert.match(await s.until(/heard: “hello”/), /esc skip/);
      control.finishMic({ peak: 0.8, heard: "hello there" });
      assert.match(await s.until(/The mic works/), /The mic works: it heard “hello there”\./);
      assert.deepEqual(calls.done, ["mic"]);
    });

    test("marked done before, but not allowed now (the helper app renamed): a line says so before the step, then it's asked as ever", async () => {
      const { deps, calls } = fakeDeps({ app: "Kiko Dev", ownApp: true, perms: { mic: "unknown" }, afterRequest: { mic: "granted" }, stale: ["mic"] });
      const s = show(["mic", "try"], deps);
      const drawn = await s.until(/Ask now/);
      assert.match(drawn, /The microphone was set up before, but macOS doesn't allow it for Kiko Dev now\. .*Microphone: macOS asks whether Kiko Dev may use it\./);
      await s.press(ENTER);
      assert.deepEqual(calls.requested, ["mic"]);
    });

    test("not marked stale: no such line", async () => {
      const { deps } = fakeDeps({ perms: { mic: "denied" } });
      const s = show(["mic", "try"], deps);
      assert.doesNotMatch(await s.until(/Open System Settings/), /was set up before/);
    });

    test("no microphone at all: said plainly before anything listens; Try again finds one plugged in", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { mic: "granted" }, inputs: [[], [], [MIC]] });
      const s = show(["mic", "talkKey", "try"], deps);
      const said = await s.until(/Try again/);
      assert.match(said, /This Mac has no microphone: plug one in \(AirPods work\), or skip and talk through the iPhone app\./);
      assert.equal(control.micTests, 0, "nothing listened");
      assert.doesNotMatch(said, /Say something|right mic|exited/);
      await s.press(ENTER); // Try again: still none
      await s.until(/Still no microphone\./);
      await s.press(ENTER); // Try again: there now
      await s.until(/Say something…/);
      assert.equal(control.micTests, 1);
      assert.deepEqual(calls.requested, []);
    });

    test("no microphone, skipped: the talk key is skipped too, and neither is marked done", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { mic: "granted", input: "granted" }, inputs: [[]] });
      const s = show(["mic", "talkKey", "name", "try"], deps);
      await s.until(/This Mac has no microphone/);
      await s.press(ESC);
      const after = await s.until(/What do you want to call it/);
      assert.match(after, /Skipped the microphone, and the talk key with it/);
      assert.doesNotMatch(after, /Input Monitoring/);
      assert.doesNotMatch(after, /Press Right Option/);
      assert.equal(control.micTests, 0);
      assert.deepEqual(calls.done, []);
    });

    test("the test finding no device (plugged out meanwhile): the same plain words, not 'is it the right mic'", async () => {
      const { deps, control } = fakeDeps({ perms: { mic: "granted" } });
      const s = show(["mic", "try"], deps);
      await s.until(/Say something…/);
      control.finishMic({ peak: 0, heard: "", noDevice: true });
      const said = await s.until(/This Mac has no microphone/);
      assert.doesNotMatch(said, /right mic/);
    });

    test("denied: exactly where to turn it on; Open System Settings, then Check again; Esc goes on", async () => {
      const { deps, calls } = fakeDeps({ perms: { mic: "denied" } });
      const s = show(["mic", "try"], deps);
      const drawn = await s.until(/Open System Settings/);
      assert.match(drawn, /The microphone is off for Ghostty\. Turn it on in System Settings → Privacy & Security → Microphone → Ghostty\./);
      await s.press(ENTER);
      assert.deepEqual(calls.opened, ["mic"]);
      await s.until(/Check again/);
      await s.press(ENTER); // the cursor is on Check again now
      assert.match(await s.until(/Still off/), /quit and reopen Ghostty, then run \/Users\/you\/\.local\/bin\/kiko setup/);
      await s.press(ESC);
      await s.until(/What to try/);
      assert.deepEqual(calls.done, []);
    });

    test("granted already: straight to the test; almost no sound says so, and isn't marked done", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { mic: "granted" } });
      const s = show(["mic", "try"], deps);
      await s.until(/Say something…/);
      control.finishMic({ peak: 0.05, heard: "" });
      assert.match(await s.until(/Try it again\?/), /Almost no sound came in: is it the right mic, and not muted\?/);
      assert.deepEqual(calls.done, []);
    });

    test("Esc while it listens skips the test", async () => {
      const { deps, calls } = fakeDeps({ perms: { mic: "granted" } });
      const s = show(["mic", "try"], deps);
      await s.until(/Say something…/);
      await s.press(ESC);
      assert.match(await s.until(/What to try/), /Mic test skipped/);
      assert.deepEqual(calls.done, []);
    });
  });

  describe("the talk key", () => {
    test("granted: press it once; another key can be picked, and is kept", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { input: "granted" } });
      const s = show(["talkKey", "try"], deps);
      assert.match(await s.until(/Press Right Option once\./), /Ctrl\+Space opens Kiko's menu in its window \(no permission needed\)\./);
      await s.press("c");
      await s.until(/Press the key you want to hold while talking…/);
      control.capture("right_command");
      await s.until(/Press Right Command once\./);
      assert.deepEqual(calls.talkKeys, ["right_command"]);
      control.press();
      assert.match(await s.until(/works/), /Right Command works\. Hold it to talk\./);
      assert.deepEqual(calls.done, ["talkKey"]);
      assert.deepEqual(calls.resume, [null]);
    });

    test("marked done before, but Input Monitoring is off now: a line says so before the step, then why it's needed", async () => {
      const { deps } = fakeDeps({ perms: { input: "denied" }, stale: ["talkKey"] });
      const s = show(["talkKey", "try"], deps);
      const drawn = await s.until(/Let Ghostty hear Right Option from any app\?/);
      assert.match(drawn, /The talk key was set up before, but macOS doesn't allow Input Monitoring for Ghostty now\. .*Hold Right Option to talk, from any app\./);
    });

    test("a key that types: kept, with a note", async () => {
      const { deps, control } = fakeDeps({ perms: { input: "granted" } });
      const s = show(["talkKey", "try"], deps);
      await s.until(/Press Right Option once/);
      await s.press("c");
      await s.until(/Press the key you want/);
      control.capture("keycode:0");
      assert.match(await s.until(/also types/), /Key code 0 also types into the app in front while you hold it/);
    });

    test("no Input Monitoring: says why; Turn it on asks macOS, opens the pane, and carries on by itself once it's on", async () => {
      const { deps, calls, control } = fakeDeps();
      const s = show(["talkKey", "try"], deps);
      const why = await s.until(/Let Ghostty hear Right Option from any app\?/);
      assert.match(why, /Hold Right Option to talk, from any app\. To notice that key while another app is in front, macOS needs Input Monitoring for Ghostty\./);
      assert.match(why, /Its prompt says Ghostty wants keystrokes from any app: Ghostty only watches Right Option, and never reads or keeps anything you type\./);
      assert.match(why, /Turn it on \(macOS asks, then System Settings opens: switch Ghostty on\)/);
      await s.press(ENTER);
      const waiting = await s.until(/Waiting for Input Monitoring/);
      assert.match(waiting, /turn on Ghostty in System Settings → Privacy & Security → Input Monitoring/);
      assert.doesNotMatch(waiting, /Quit & Reopen/, "the terminal's Quit & Reopen would end this setup: never offered as fine");
      assert.deepEqual(calls.requested, ["input"]);
      assert.deepEqual(calls.opened, ["input"]);
      await s.press("o");
      assert.deepEqual(calls.opened, ["input", "input"]);
      control.grant("input");
      assert.match(await s.until(/Press Right Option once/), /Input Monitoring is on\./);
      control.press();
      await s.until(/Right Option works/);
      assert.deepEqual(calls.done, ["talkKey"]);
      assert.ok(calls.logged.some((l) => l.startsWith("setup_input_monitoring") && l.includes('"how":"on"')));
    });

    test("still off after Enter: reopen the terminal app, the exact command; the next setup picks up here", async () => {
      const { deps, calls } = fakeDeps();
      const s = show(["talkKey", "name", "try"], deps);
      await s.until(/hear Right Option from any app/);
      await s.press(ENTER);
      await s.until(/Waiting for Input Monitoring/);
      await s.press(ENTER);
      const said = await s.until(/What do you want to call it/);
      assert.match(said, /Input Monitoring takes effect once Ghostty is reopened: quit it \(⌘Q\), open it again, and run: \/Users\/you\/\.local\/bin\/kiko setup Setup picks up at the talk key\./);
      assert.deepEqual(calls.resume, ["talkKey"]);
      assert.deepEqual(calls.done, []);
    });

    test("granted, but the key's helper can't listen yet: the same reopen, remembered", async () => {
      const { deps, calls } = fakeDeps({ perms: { input: "granted" }, listenFails: "hotkey helper exited (1)" });
      const s = show(["talkKey", "try"], deps);
      assert.match(await s.until(/once Ghostty is reopened/), /Kiko can't hear Right Option yet/);
      assert.deepEqual(calls.resume, ["talkKey"]);
      assert.ok(calls.logged.some((l) => l.includes("hotkey helper exited (1)")));
    });

    describe("the permissions are the helper app's (Kiko Dev): its name, and nothing to reopen", () => {
      /** Setup's deps with the helper app holding the permissions; `refreshed` counts its restarts. */
      function ownApp(over: Parameters<typeof fakeDeps>[0] = {}) {
        const f = fakeDeps({ app: "Kiko Dev", ownApp: true, ...over });
        const counts = { refreshed: 0 };
        f.deps.permissions.refresh = async () => {
          counts.refreshed++;
          return true;
        };
        return { ...f, counts };
      }

      test("once Input Monitoring is on, the helper app is restarted before the key is tried: no Quit & Reopen", async () => {
        const { deps, calls, control, counts } = ownApp();
        const s = show(["talkKey", "try"], deps);
        assert.match(await s.until(/Let Kiko Dev hear Right Option from any app\?/), /macOS needs Input Monitoring for Kiko Dev\. Its prompt says Kiko Dev wants keystrokes/);
        await s.press(ENTER);
        const waiting = await s.until(/Waiting for Input Monitoring/);
        assert.match(waiting, /turn on Kiko Dev in System Settings → Privacy & Security → Input Monitoring/);
        assert.match(waiting, /macOS may offer to Quit & Reopen Kiko Dev: either button is fine, Kiko carries on by itself\./);
        assert.equal(counts.refreshed, 0);
        control.grant("input");
        await s.until(/Press Right Option once/);
        assert.equal(counts.refreshed, 1);
        control.press();
        await s.until(/Right Option works/);
        assert.deepEqual(calls.done, ["talkKey"]);
        assert.ok(calls.logged.some((l) => l.includes('"how":"relaunched"')));
      });

      test("the key not heard at first: the app restarted once more and the key tried again", async () => {
        const { deps, calls, control, counts } = ownApp({ perms: { input: "granted" } });
        const listen = deps.talkKey.listen;
        let tries = 0;
        deps.talkKey.listen = (onDown, onFail) => {
          if (++tries === 1) {
            setTimeout(() => onFail("hotkey helper exited (1)"), 5);
            return () => {};
          }
          return listen(onDown, onFail);
        };
        const s = show(["talkKey", "try"], deps);
        await s.until(/Kiko can't hear Right Option yet/);
        await s.until(/Press Right Option once/);
        assert.equal(counts.refreshed, 1);
        control.press();
        await s.until(/Right Option works/);
        assert.deepEqual(calls.done, ["talkKey"]);
      });

      test("still off after Enter: where to turn it on for Kiko Dev, then setup again; no terminal to reopen", async () => {
        const { deps, calls, counts } = ownApp();
        const s = show(["talkKey", "name", "try"], deps);
        await s.until(/hear Right Option from any app/);
        await s.press(ENTER);
        await s.until(/Waiting for Input Monitoring/);
        await s.press(ENTER);
        const said = await s.until(/What do you want to call it/);
        assert.match(
          said,
          /Input Monitoring isn't on for Kiko Dev yet: turn it on in System Settings → Privacy & Security → Input Monitoring → Kiko Dev, then run: \/Users\/you\/\.local\/bin\/kiko setup Setup picks up at the talk key\. macOS may offer to Quit & Reopen Kiko Dev: either button is fine, Kiko carries on by itself\./,
        );
        assert.doesNotMatch(said, /reopen|⌘Q/);
        assert.equal(counts.refreshed, 1, "Enter restarted the app before looking");
        assert.deepEqual(calls.resume, ["talkKey"]);
      });

      test("the microphone off: Check again restarts the app and looks; nothing about reopening", async () => {
        const { deps, counts } = ownApp({ perms: { mic: "denied" } });
        const s = show(["mic", "try"], deps);
        assert.match(await s.until(/Open System Settings/), /The microphone is off for Kiko Dev\. Turn it on in System Settings → Privacy & Security → Microphone → Kiko Dev\./);
        await s.press(ENTER);
        await s.until(/Check again/);
        await s.press(ENTER);
        assert.match(await s.until(/Still off/), /Still off: turn on Kiko Dev in System Settings → Privacy & Security → Microphone → Kiko Dev\./);
        assert.equal(counts.refreshed, 1);
        await s.press(ESC);
        await s.until(/What to try/);
      });
    });

    test("Esc skips it, and a pending pick-up is cleared", async () => {
      const { deps, calls } = fakeDeps();
      const s = show(["talkKey", "try"], deps);
      await s.until(/hear Right Option from any app/);
      await s.press(DOWN);
      await s.until(/Skip \(kiko-dev setup comes back to it\)/);
      await s.press(ESC);
      assert.match(await s.until(/What to try/), /Skipped the talk key\. kiko-dev setup comes back to it\./);
      assert.deepEqual(calls.requested, []);
      assert.deepEqual(calls.resume, [null]);
    });
  });

  describe("its name", () => {
    test("asks what to call it, the name now as the default; what's typed is kept, and hello says it", async () => {
      const { deps, calls } = fakeDeps();
      const s = show(["name", "hello", "try"], deps);
      const drawn = await s.until(/What do you want to call it\?/);
      assert.match(drawn, /“Kiko, ask pixie if the tests pass”/);
      await s.press("Jarvis");
      await s.press(ENTER);
      await s.until(/Did you hear it/);
      assert.deepEqual(calls.names, ["Jarvis"]);
      assert.deepEqual(calls.done, ["name"]);
      assert.match(calls.said[0], /^Hi, I'm Jarvis\./);
    });

    test("a one-syllable or everyday word: a warning, and it's kept anyway", async () => {
      const { deps, calls } = fakeDeps();
      const s = show(["name", "try"], deps);
      await s.until(/What do you want to call it/);
      await s.press("Max");
      await s.press(ENTER);
      assert.match(await s.until(/Kept anyway/), /Short, common words wake it by accident; two syllables work best\./);
      assert.deepEqual(calls.names, ["Max"]);
    });

    test("Enter with nothing typed keeps the name it has; Esc skips, nothing kept", async () => {
      const kept = fakeDeps();
      const s = show(["name", "try"], kept.deps);
      await s.until(/What do you want to call it/);
      await s.press(ENTER);
      await s.until(/What to try/);
      assert.deepEqual(kept.calls.names, ["Kiko"]);
      const skipped = fakeDeps();
      const t = show(["name", "try"], skipped.deps);
      await t.until(/What do you want to call it/);
      await t.press("Jarvis");
      await t.press(ESC);
      assert.match(await t.until(/What to try/), /it stays Kiko/);
      assert.deepEqual(skipped.calls.names, []);
      assert.deepEqual(skipped.calls.done, []);
    });
  });

  test("its voice: says hello with the talk key in it, asks if you heard it; No says what to check; Yes marks it done", async () => {
    const { deps, calls } = fakeDeps();
    const s = show(["hello", "try"], deps);
    const drawn = await s.until(/Did you hear it\?/);
    assert.equal(calls.said.length, 1);
    assert.match(calls.said[0], /^Hi, I'm Kiko\. Hold Right Option and talk to me/);
    assert.doesNotMatch(drawn, /voice ready|Pocket|downloading/, "nothing to wait for: not a word about it");
    await s.press(DOWN, 2);
    await s.press(ENTER); // No
    assert.match(await s.until(/Play it again/), /Check the Mac's sound/);
    await s.press(ENTER); // Play it again
    await s.until(/Did you hear it\?/);
    assert.equal(calls.said.length, 2);
    await s.press(ENTER); // Yes
    await s.until(/What to try/);
    assert.deepEqual(calls.done, ["hello"]);
  });

  describe("its voice still downloading (Pocket)", () => {
    const running = (fraction: number, phase: PrepNow["phase"] = "install"): PrepNow => ({ state: "running", fraction, phase });

    test("waited for, how far along shown (installing, then the voice), then hello is said once it's ready", async () => {
      const { deps, calls, control } = fakeDeps({ voices: [running(0.12), running(0.12), running(0.5, "voice"), { state: "ready", fraction: 1, phase: "install" }] });
      // What the download was when hello was said.
      const saidWhen: (string | undefined)[] = [];
      deps.hello.say = async (text) => void (calls.said.push(text), saidWhen.push(control.voice?.state));
      const s = show(["hello", "try"], deps);
      const waiting = await s.until(/installing \(about 1 GB, once\)/);
      assert.match(waiting, /Getting Kiko's voice ready…/);
      assert.match(waiting, /▰▱▱▱▱▱▱▱▱▱ 12%/);
      assert.match(waiting, /esc use the Mac voice for now/);
      assert.match(await s.until(/downloading the voice/), /▰▰▰▰▰▱▱▱▱▱ 50%/);
      const ready = await s.until(/Did you hear it\?/);
      assert.match(ready, /Kiko's voice is ready\./);
      assert.deepEqual(saidWhen, ["ready"], "said once, after it was ready");
      assert.ok(
        calls.logged.some((l) => l.startsWith('setup_voice {"ended":"ready"')),
        calls.logged.join("\n"),
      );
      await s.press(ENTER); // Yes
      assert.doesNotMatch(await s.until(/What to try/), /downloaded/, "ready: nothing on the last step");
    });

    test("Esc: the Mac voice for now, said once; Play it again doesn't wait again; the last step says how far it got", async () => {
      const { deps, calls, control } = fakeDeps({ voices: [running(0.3)] });
      const s = show(["hello", "try"], deps);
      await s.until(/Getting Kiko's voice ready…/);
      assert.equal(calls.said.length, 0, "not said while it waits");
      await s.press(ESC);
      const after = await s.until(/Did you hear it\?/);
      assert.match(after, /The Mac voice for now: Kiko switches to its own once it's ready\./);
      assert.equal(calls.said.length, 1);
      assert.ok(
        calls.logged.some((l) => l.startsWith('setup_voice {"ended":"later","percent":30')),
        calls.logged.join("\n"),
      );
      const looks = control.voiceLooks;
      await s.press(DOWN);
      await s.press(ENTER); // Play it again
      await s.until(/Did you hear it\?/);
      assert.equal(calls.said.length, 2);
      assert.equal(control.voiceLooks, looks, "not looked at (nor waited for) again");
      await s.press(ENTER); // Yes
      assert.match(await s.until(/What to try/), /Kiko's voice is 30% downloaded: it takes over from the Mac voice by itself\./);
      assert.doesNotMatch(s.all().split("The Mac voice for now")[1], /Getting Kiko's voice ready/, "not waited for again");
    });

    test("it fails while waited for: one line, the Mac voice says hello, and why goes to the log", async () => {
      const { deps, calls } = fakeDeps({ voices: [running(0.2), { state: "failed", fraction: 0.2, phase: "install", why: "Pocket TTS: couldn't download uv (offline?)" }] });
      const s = show(["hello", "try"], deps);
      const drawn = await s.until(/Did you hear it\?/);
      assert.match(drawn, /Kiko's voice couldn't be set up: the Mac voice for now\./);
      assert.equal(calls.said.length, 1);
      assert.ok(
        calls.logged.some((l) => l.startsWith('setup_voice {"ended":"failed"') && l.includes("couldn't download uv (offline?)")),
        calls.logged.join("\n"),
      );
    });

    test("failed before the step: the one line, no wait", async () => {
      const { deps, calls } = fakeDeps({ voices: [{ state: "failed", fraction: 0, phase: "install", why: "no network" }] });
      const s = show(["hello", "try"], deps);
      const drawn = await s.until(/Did you hear it\?/);
      assert.match(drawn, /Kiko's voice couldn't be set up: the Mac voice for now\./);
      assert.doesNotMatch(drawn, /Getting Kiko's voice ready/);
      assert.equal(calls.said.length, 1);
    });

    test("ready already: no wait, no line", async () => {
      const { deps, calls } = fakeDeps({ voices: [{ state: "ready", fraction: 1, phase: "install" }] });
      const s = show(["hello", "try"], deps);
      const drawn = await s.until(/Did you hear it\?/);
      assert.doesNotMatch(drawn, /voice ready|voice is ready|Mac voice/);
      assert.equal(calls.said.length, 1);
    });

    test("Ctrl+C twice while it waits stops setup", async () => {
      const { deps, calls } = fakeDeps({ voices: [running(0.4)] });
      const s = show(["hello", "try"], deps);
      await s.until(/Getting Kiko's voice ready…/);
      await s.press(CTRL_C);
      await s.press(CTRL_C);
      assert.equal(await s.ended, "quit");
      assert.deepEqual(calls.done, []);
    });
  });

  test("what to try: the lines, then Enter opens the app (Esc: later)", async () => {
    const { deps } = fakeDeps();
    const s = show(["try"], deps);
    const drawn = await s.until(/Open Kiko now\?/);
    assert.match(drawn, /Everything's set up\. To see every step again: kiko-dev setup --all/);
    assert.match(drawn, /• Ctrl\+Space then c starts a session/);
    await s.press(ENTER);
    assert.equal(await s.ended, "open");
    const again = show(["try"], fakeDeps().deps);
    await again.until(/Open Kiko now\?/);
    await again.press(ESC);
    assert.equal(await again.ended, "later");
    assert.match(again.all(), /Run kiko when you're ready\./);
  });

  test("every step skipped with Esc, start to end: nothing asked, nothing marked done", async () => {
    const { deps, calls } = fakeDeps({ rows: [{ id: "codex", name: "Codex", state: "not connected", detail: "adds hooks", ask: true }] });
    const s = show(["agents", "key", "mic", "talkKey", "name", "hello", "try"], deps);
    for (const next of [/Paste your OpenRouter key/, /Ask now/, /hear Right Option from any app/, /What do you want to call it/, /Did you hear it/, /Open Kiko now/]) {
      await s.press(ESC);
      await s.until(next);
    }
    await s.press(ESC);
    assert.equal(await s.ended, "later");
    assert.deepEqual(calls.answered, ["later"]);
    assert.deepEqual(calls.requested, []);
    assert.deepEqual(calls.done, []);
    assert.deepEqual(calls.saved, []);
    assert.deepEqual(calls.names, []);
  });

  test("Ctrl+C skips a step like Esc; twice in a row stops setup, what was done kept", async () => {
    const { deps, calls } = fakeDeps();
    const s = show(["name", "hello", "try"], deps);
    await s.until(/What do you want to call it/);
    await s.press(CTRL_C);
    await s.until(/Did you hear it/);
    await s.press(CTRL_C);
    assert.equal(await s.ended, "quit");
    assert.match(s.all(), /Setup stopped\. What was done is kept/);
    assert.deepEqual(calls.names, []);
  });

  describe("the last step with no model key (the release test, 2026-11-01: setup ended on Open, the app found none)", () => {
    test("every step skipped, no key: the last step says the app needs one and asks for it; Esc says exactly what to do, nothing opens", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false });
      const s = show(["key", "name", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(ESC);
      assert.match(await s.until(/What do you want to call it/), /Skipped: no key yet/);
      await s.press(ESC);
      const asked = await s.until(/Paste your OpenRouter key Get one at https:\/\/openrouter\.ai\/keys · it stays hidden/);
      assert.match(asked, /Kiko needs an OpenRouter key to answer\./);
      assert.doesNotMatch(asked, /Open Kiko now|What to try/, "nothing to open without one");
      await s.press(ESC);
      assert.equal(await s.ended, "no-key");
      assert.match(s.all(), /Run `kiko-dev keys set openrouter`, paste your key, then run `kiko-dev`\./);
      assert.doesNotMatch(s.all(), /Open Kiko…/);
      assert.deepEqual(
        calls.logged.filter((l) => l.startsWith("setup_key")),
        ['setup_key {"at":"step","ended":"skipped","refused":0}', 'setup_key {"at":"end","ended":"skipped","refused":0}'],
      );
    });

    test("the key pasted on the last step: checked, saved, then what to try and Open", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false });
      const s = show(["try"], deps);
      await s.until(/needs an OpenRouter key to answer/);
      assert.doesNotMatch(s.all(), /Everything's set up/, "not with the key missing");
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      assert.match(await s.until(/Open Kiko now\?/), /Looks good: saved in the Keychain\..*What to try/);
      await s.press(ENTER);
      assert.equal(await s.ended, "open");
      assert.deepEqual(calls.saved, [FAKE_KEY]);
      assert.doesNotMatch(s.all(), /fake0000test/, "the key is never drawn");
      assert.ok(calls.logged.includes('setup_key {"at":"end","ended":"saved","refused":0}'));
      assert.ok(!calls.logged.some((l) => l.includes("fake0000")), "nor logged");
    });

    test("with a model key there: no ask, straight to what to try", async () => {
      const { deps } = fakeDeps({ hasKey: true });
      const s = show(["try"], deps);
      const drawn = await s.until(/Open Kiko now\?/);
      assert.doesNotMatch(drawn, /needs an OpenRouter key|Paste your OpenRouter key/);
    });

    test("the Keychain unreadable: said under the line, the key still asked for", async () => {
      const { deps } = fakeDeps({ hasKey: false });
      deps.key.unread = "the keychain helper failed (1)";
      const s = show(["try"], deps);
      assert.match(await s.until(/Paste your OpenRouter key/), /\(The Keychain couldn't be read: the keychain helper failed \(1\)\)/);
    });

    test("no Keychain: nothing to paste into, so what to do, and nothing opens", async () => {
      const { deps } = fakeDeps({ hasKey: false });
      deps.key.store = false;
      const s = show(["try"], deps);
      assert.equal(await s.ended, "no-key");
      assert.match(s.all(), /needs an OpenRouter key to answer\. No Keychain here/);
      assert.match(s.all(), /Run `kiko-dev keys set openrouter`/);
    });
  });

  describe("the key step's log (never the key)", () => {
    test("saved: logged as saved", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      await s.until(/Open Kiko now/);
      assert.deepEqual(
        calls.logged.filter((l) => l.startsWith("setup_key")),
        ['setup_key {"at":"step","ended":"saved","refused":0}'],
      );
    });

    test("one turned down, then Esc: skipped, with the one refused counted", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false, check: { result: "refused", said: "✗ OpenRouter turned the key down: User not found" } });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      await s.until(/Paste another OpenRouter key/);
      await s.press(ESC);
      await s.until(/needs an OpenRouter key to answer/);
      assert.ok(calls.logged.includes('setup_key {"at":"step","ended":"skipped","refused":1}'));
      assert.ok(!calls.logged.some((l) => l.includes("fake0000")));
    });

    test("saved unchecked (offline): logged so", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false, check: { result: "unchecked", said: "Couldn't reach OpenRouter to check the key (offline?)" } });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      await s.until(/Save it anyway\?/);
      await s.press("y");
      await s.until(/Open Kiko now/);
      assert.ok(calls.logged.includes('setup_key {"at":"step","ended":"saved-unchecked","refused":0}'));
    });

    test("couldn't be saved: logged as save-failed, and the last step asks again", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false });
      deps.key.save = async () => "the Keychain is locked";
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      assert.match(await s.until(/needs an OpenRouter key to answer/), /Couldn't save it in the Keychain: the Keychain is locked/);
      assert.ok(calls.logged.includes('setup_key {"at":"step","ended":"save-failed","refused":0}'));
    });

    test("a key there already (--all), Esc: kept", async () => {
      const { deps, calls } = fakeDeps({ hasKey: true });
      const s = show(["key", "try"], deps);
      await s.until(/Paste your OpenRouter key/);
      await s.press(ESC);
      assert.match(await s.until(/Open Kiko now/), /Kept the key you have\./);
      assert.ok(calls.logged.includes('setup_key {"at":"step","ended":"kept","refused":0}'));
    });

    test("no Keychain: logged as no-keychain", async () => {
      const { deps, calls } = fakeDeps({ hasKey: true });
      deps.key.store = false;
      const s = show(["key", "try"], deps);
      await s.until(/Open Kiko now/);
      assert.ok(calls.logged.includes('setup_key {"at":"step","ended":"no-keychain"}'));
    });
  });

  describe("picking the mic in the mic step", () => {
    const USB: MicDevice = { uid: "usb-1", name: "USB Mic", isDefault: false };

    test("more than one input: names the one it listens on; quiet, Use another mic picks one, saves it, and tests again on it", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { mic: "granted" }, inputs: [[MIC, USB]] });
      const s = show(["mic", "try"], deps);
      assert.match(await s.until(/Say something…/), /Listening on MacBook Pro Microphone/);
      control.finishMic({ peak: 0.01, heard: "" });
      const quiet = await s.until(/Use another mic/);
      assert.match(quiet, /Almost no sound came in: is it the right mic, and not muted\?/);
      assert.doesNotMatch(quiet, /Settings → Listening picks the mic/, "the choice is right there");
      assert.match(quiet, /Try again.*Use another mic.*Go on/);
      await s.press(DOWN);
      await s.press(ENTER);
      const list = await s.until(/Which mic\?/);
      assert.match(list, /System default \(MacBook Pro Microphone\).*MacBook Pro Microphone.*USB Mic/);
      await s.press(DOWN, 2);
      await s.press(ENTER);
      assert.match(await s.until(/Say something…/), /Listening on USB Mic/);
      assert.deepEqual(calls.mics, ["usb-1"]);
      assert.equal(control.micTests, 2);
      control.finishMic({ peak: 0.6, heard: "" });
      await s.until(/The mic hears you/);
      assert.deepEqual(calls.done, ["mic"]);
      assert.ok(calls.logged.includes('setup_mic {"picked":"USB Mic"}'));
    });

    test("Esc on the list keeps the mic there: back to the choices", async () => {
      const { deps, calls, control } = fakeDeps({ perms: { mic: "granted" }, inputs: [[MIC, USB]] });
      const s = show(["mic", "try"], deps);
      await s.until(/Say something…/);
      control.finishMic({ peak: 0.01, heard: "" });
      await s.until(/Use another mic/);
      await s.press(DOWN);
      await s.press(ENTER);
      await s.until(/Which mic\?/);
      await s.press(ESC);
      await s.until(/Try it again\?/);
      assert.deepEqual(calls.mics, []);
      assert.equal(control.micTests, 1);
    });

    test("one input: as before, no name, no other mic offered", async () => {
      const { deps, control } = fakeDeps({ perms: { mic: "granted" } });
      const s = show(["mic", "try"], deps);
      assert.doesNotMatch(await s.until(/Say something…/), /Listening on/);
      control.finishMic({ peak: 0.01, heard: "" });
      const quiet = await s.until(/Try it again\?/);
      assert.match(quiet, /\(Settings → Listening picks the mic\.\)/);
      assert.doesNotMatch(quiet, /Use another mic/);
    });
  });
});

// Setup's first choice while accounts are open (SetupDeps.account: src/core/env.ts accountsLive):
// the free trial, your own key, or an account you have. Without it (accounts not open), the key
// step is as it always was: the tests above.
describe("how to run it (accounts open)", () => {
  /** The approval page's plain link: the one opened (never the one with the code in it). */
  const LINK = "https://account.kiko.sh/device";
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  /** A real account on a fake server, its token kept in a store in memory: the browser "opens" (`opens`), or not; `remote`: over SSH; `script`: the server's answers. */
  async function realAccount(o: { opens?: boolean; phones?: number; remote?: boolean; sale?: boolean; script?: Partial<ReturnType<typeof happyScript>> } = {}) {
    const server = await fakeAccountServer({ ...happyScript(), ...o.script });
    closers.push(server.close);
    const mem = memoryStore();
    const account = new Account({ store: mem.store, client: accountClient(server.url), file: join(mkdtempSync(join(tmpdir(), "acct-setup-")), "account.json"), sleep: async () => {} });
    const opened: string[] = [];
    const deps = setupAccount(account, { open: async (url) => (opened.push(url), o.opens ?? true), remote: o.remote ?? false, phones: () => o.phones ?? 0, sale: o.sale });
    /** As setup's own key.has (onboard.ts accountRunsModels): a model key, or the account's plan running the AI. */
    const runsModels = () => {
      const v = account.view();
      return v.state === "signed-in" && planRunsAi(v.plan);
    };
    return { server, mem, account, deps, opened, runsModels };
  }

  /** An account that never answers until the test says (`approve`, `fail`), and isn't signed in; its code shown by kiko login's flow (followCode). */
  function heldAccount(o: { opens?: boolean; remote?: boolean } = {}) {
    let settle: (r: SignIn) => void = () => {};
    let aborted = false;
    let signedIn: string | null = null;
    const opened: string[] = [];
    // The last sign-in's screen and its new-code asker (the test plays Account.signIn's renewals), and how many were started.
    let shown: CodeUi | null = null;
    let asker: NewCode | undefined;
    let starts = 0;
    const start: DeviceStart = { deviceCode: "device-test", userCode: USER_CODE, verificationUri: LINK, verificationUriComplete: `${LINK}?user_code=${USER_CODE}`, interval: 5, expiresIn: 900 };
    const deps: NonNullable<SetupDeps["account"]> = {
      signedIn: () => signedIn,
      signIn: (ui, signal, newCode) =>
        new Promise((resolve) => {
          shown = ui;
          asker = newCode;
          starts++;
          settle = (r) => {
            if (r.ok) signedIn = r.email ?? "";
            resolve(r);
          };
          signal.addEventListener("abort", () => ((aborted = true), resolve({ ok: false, why: "cancelled", said: "Sign-in stopped. Nothing changed." })));
          setTimeout(() => void followCode(start, { browser: !o.remote, open: async (url) => (opened.push(url), o.opens ?? true) }, ui), 5);
        }),
      startTrial: async () => ({ ok: true, said: "Your free trial has started." }),
      // The server couldn't be asked: no plan known.
      plan: async () => null,
    };
    return {
      deps,
      opened,
      settle: (r: SignIn) => settle(r),
      aborted: () => aborted,
      signIn: (email: string) => (signedIn = email),
      ui: () => shown!,
      newCode: () => asker,
      starts: () => starts,
    };
  }

  test("the choice comes first: the trial picked, your own key always there", async () => {
    const { deps } = fakeDeps({ hasKey: false, account: heldAccount().deps });
    const s = show(["key", "try"], deps);
    const drawn = await s.until(/I have an account: sign in/);
    assert.match(drawn, /How do you want to run Kiko\? It needs an AI model for its summaries and routing\./);
    assert.match(s.raw(), /● Free trial: 7 days, no card \(needs a free account\)/);
    assert.match(s.raw(), /○ My own OpenRouter key: no account needed/);
    assert.match(s.raw(), /○ I have an account: sign in/);
    // Kiko Pro isn't on sale: nothing about it.
    assert.doesNotMatch(s.raw(), /Kiko Pro|\$8/);
  });

  test("my own key: today's key step, unchanged, and no account", async () => {
    const held = heldAccount();
    const { deps, calls } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(DOWN);
    await s.press(ENTER);
    const key = await s.until(/Paste your OpenRouter key Get one at https:\/\/openrouter\.ai\/keys/);
    assert.match(key, /Kiko's summaries and replies run on OpenRouter/);
    await s.press(FAKE_KEY);
    await s.press(ENTER);
    await s.until(/Looks good: saved in the Keychain\./);
    assert.deepEqual(calls.saved, [FAKE_KEY]);
    assert.equal(held.deps.signedIn(), null, "no account");
    assert.ok(calls.logged.includes('setup_account {"choice":"own"}'));
  });

  test("free trial: kiko login's flow inline (the code first, Enter opens the plain link), signed in, the token kept; the trial started, and no key asked", async () => {
    const a = await realAccount();
    const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
    deps.key.has = a.runsModels;
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    const code = await s.until(/Press Enter to open https:\/\/account\.kiko\.sh\/device in your browser\.\.\./);
    assert.match(code, /First copy your one-time code: ABCD-EFGH/);
    // The terms starting the trial accepts, by the code (core/terms.ts agreeLine).
    assert.match(code, /By starting the free trial, you agree to Kiko's Terms \(kiko\.sh\/terms\) and Privacy Policy \(kiko\.sh\/privacy\)\./);
    assert.deepEqual(a.opened, [], "nothing opened before Enter");
    assert.equal(a.server.to("token").length, 0, "nothing polled while Enter waits (as kiko login)");
    await s.press(ENTER);
    // On to the end with no key: the trial runs the AI, so nothing about a missing key.
    await s.until(/Open Kiko now/);
    const after = s.all();
    assert.match(after, /Kiko's AI calls go through Kiko, so you don't need a key\./);
    assert.match(after, /Signed in as name@example\.com/);
    assert.match(after, /Your free trial runs until \w{3} \d{1,2} \w{3}, \d{2}:\d{2}\./);
    assert.doesNotMatch(after, /arrives with the next/);
    assert.match(s.all(), /Free trial/);
    // Never the link with the code in it: the code is typed on the page (gh's anti-phishing step).
    assert.deepEqual(a.opened, [LINK]);
    assert.equal(a.mem.kept[SESSION_KEY], SESSION_TOKEN, "the session token in the (fake) Keychain");
    // The trial asked for with the session token, once; its plan kept in account.json.
    assert.deepEqual(
      a.server.to("trial").map((c) => c.bearer),
      [SESSION_TOKEN],
    );
    const view = a.account.view();
    assert.equal(view.state === "signed-in" && view.plan?.name, "trial");
    assert.doesNotMatch(s.all(), /sess-test/, "never drawn");
    assert.ok(calls.logged.includes('setup_account {"choice":"trial","ended":"signed-in"}'));
    assert.ok(calls.logged.includes('setup_trial {"ended":"started"}'));
    assert.ok(!calls.logged.some((l) => l.includes(EMAIL) || l.includes("sess-test")));
    assert.doesNotMatch(after, /needs an OpenRouter key|Paste your OpenRouter key/);
    assert.deepEqual(calls.saved, []);
  });

  // These sign in as over SSH (the link shown, no Enter waited for): the trial is what they're about.
  test("free trial refused (this email had one): said, and back to the choice without the trial, your own key first", async () => {
    const a = await realAccount({ remote: true, script: { trial: [trialRefused("trial_used")] } });
    const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
    deps.key.has = a.runsModels;
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/name@example\.com has already used its free trial\.[\s\S]*How do you want to run/);
    const back = s.all();
    assert.match(back, /Go on with your own OpenRouter key \(kiko(-dev)? keys set openrouter\), free forever with no account\./);
    const again = s.raw().slice(s.raw().lastIndexOf("How do you want to run"));
    assert.match(again, /● My own OpenRouter key: no account needed/);
    assert.doesNotMatch(again, /Free trial|I have an account/);
    assert.ok(calls.logged.includes('setup_trial {"ended":"trial_used"}'));
    await s.press(ENTER);
    await s.until(/Paste your OpenRouter key/);
    // Signed in all the same: the account stays, the key runs the AI.
    assert.equal(a.mem.kept[SESSION_KEY], SESSION_TOKEN);
  });

  test("free trial refused for a throwaway email, or too many from this network: their own lines", async () => {
    const a = await realAccount({ remote: true, script: { trial: [trialRefused("email_not_allowed", { reason: "disposable" })] } });
    const { deps } = fakeDeps({ hasKey: false, account: a.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/A free trial needs an email address that isn't a throwaway one\. Use your own OpenRouter key/);

    const b = await realAccount({ remote: true, script: { trial: [trialRefused("rate_limited", { retryAfter: 3600 })] } });
    const two = fakeDeps({ hasKey: false, account: b.deps });
    const s2 = show(["key", "try"], two.deps);
    await s2.until(/I have an account/);
    await s2.press(ENTER);
    await s2.until(/Too many free trials were started from this network today\. Try again tomorrow, or use your own OpenRouter key/);
  });

  test("a phone paired already: signed in, and the server told (best-effort)", async () => {
    const a = await realAccount({ phones: 1 });
    const { deps } = fakeDeps({ hasKey: true, account: a.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    await s.press(ENTER);
    await s.until(/Signed in as name@example\.com/);
    assert.deepEqual(
      a.server.to("phone").map((c) => c.body),
      [{ paired: true }],
    );
  });

  test("while it waits: the code first and Enter to open; once open, the code to type there", async () => {
    const held = heldAccount();
    const { deps } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    const code = await s.until(/Press Enter to open https:\/\/account\.kiko\.sh\/device in your browser\.\.\./);
    assert.match(code, /Free trial/);
    assert.match(code, /First copy your one-time code: ABCD-EFGH/);
    assert.match(code, /enter open · esc back/);
    assert.doesNotMatch(code, /esc cancel/, "Esc goes back to the choice: never said as cancelling");
    assert.deepEqual(held.opened, []);
    await s.press(ENTER);
    const waiting = await s.until(/Type it at https:\/\/account\.kiko\.sh\/device \(open in your browser\)\. Waiting for you to sign in…/);
    assert.match(waiting, /Your one-time code: ABCD-EFGH/);
    assert.match(waiting, /n new code · esc back/);
    assert.deepEqual(held.opened, [LINK]);
    held.settle({ ok: true, email: EMAIL });
    await s.until(/Signed in as name@example\.com/);
  });

  test("while it waits: n asks for a new code (not while Enter is waited for); a new code shown in place of the last, nothing opened again; the server out of reach said until it's back", async () => {
    const held = heldAccount();
    const { deps } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    // n at the Enter prompt: nothing (Enter opens first).
    await s.press("n");
    assert.equal(held.newCode()?.take(), false, "no new code asked for at the Enter prompt");
    await s.press(ENTER);
    await s.until(/Waiting for you to sign in…/);
    await s.press("n");
    assert.equal(held.newCode()?.take(), true, "n asks for a new code while it waits");
    // The new code (Account.signIn's patient renewal): in place of the last, on the same page.
    held.ui().renewed?.("WXYZ-2345", "asked");
    const asked = await s.until(/Here's a new code\.[\s\S]*Your one-time code: WXYZ-2345/);
    assert.match(asked, /Type it at https:\/\/account\.kiko\.sh\/device \(open in your browser\)\. Waiting for you to sign in…/);
    held.ui().renewed?.("JKLM-6789", "ran-out");
    await s.until(/The code ran out; here's a new one\.[\s\S]*Your one-time code: JKLM-6789/);
    assert.deepEqual(held.opened, [LINK], "the browser opened once, not again for each code");
    held.ui().reach?.(false);
    const offline = await s.until(/Can't reach kiko\.sh, still trying…/);
    assert.match(offline, /n new code · esc back/);
    held.ui().reach?.(true);
    await s.until(/JKLM-6789[\s\S]*Waiting for you to sign in…/);
    held.settle({ ok: true, email: EMAIL });
    await s.until(/Signed in as name@example\.com/);
  });

  test("each way a sign-in ends early, in setup's own words (never kiko login), back on the choice", async () => {
    const said = (r: Exclude<SignIn, { ok: true }>) => setupSignInLine(r);
    const base = { said: `Nothing changed: ${COMMAND} login starts again.` };
    for (const why of ["denied", "refused", "used"] as const) assert.equal(said({ ok: false, why, ...base }), "That code was used up or turned down. Pick again to get a new one.");
    assert.equal(said({ ok: false, why: "cancelled", ...base }), "Sign-in stopped. Pick again to get a new code.");
    assert.equal(said({ ok: false, why: "expired", ...base }), "The code ran out. Pick again to get a new one.");
    assert.equal(said({ ok: false, why: "timed-out", ...base }), "Stopped waiting after 30 minutes. Pick again to get a new code.");
    assert.equal(said({ ok: false, why: "timed-out", offline: true, ...base }), "Couldn't reach kiko.sh for 30 minutes. Pick again to try once more.");
    assert.equal(said({ ok: false, why: "unreachable", ...base }), "Couldn't reach kiko.sh. Pick again to try once more.");
    for (const why of ["denied", "refused", "used", "cancelled", "expired", "timed-out", "unreachable"] as const) assert.doesNotMatch(said({ ok: false, why, ...base }), /login/);

    // On screen: used up, then back on the choice; picking again asks for a new code.
    const held = heldAccount();
    const { deps } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    await s.press(ENTER);
    await s.until(/Waiting for you to sign in…/);
    held.settle({ ok: false, why: "used", said: `That code was used already, or isn't known. Nothing changed: ${COMMAND} login starts again.` });
    const back = await s.until(/How do you want to run Kiko\?/);
    assert.match(back, /That code was used up or turned down\. Pick again to get a new one\./);
    assert.doesNotMatch(s.all(), /kiko(-dev)? login/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    assert.equal(held.starts(), 2, "picking again starts a new sign-in");
  });

  test("the browser not opening: kiko login's words for it, and the sign-in still waited for", async () => {
    const held = heldAccount({ opens: false });
    const { deps } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    await s.press(ENTER);
    const failed = await s.until(/Please try entering the URL in your browser manually/);
    assert.match(failed, /First copy your one-time code: ABCD-EFGH/);
    assert.match(failed, /Failed opening a web browser at https:\/\/account\.kiko\.sh\/device/);
    held.settle({ ok: true, email: EMAIL });
    await s.until(/Signed in as name@example\.com/);
  });

  test("over SSH: kiko login's line with the plain link, no Enter waited for and nothing opened; signed in from another device", async () => {
    const a = await realAccount({ remote: true });
    const { deps } = fakeDeps({ hasKey: true, account: a.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    const after = await s.until(/Signed in as name@example\.com/);
    assert.match(s.all(), /First copy your one-time code: ABCD-EFGH/);
    assert.match(s.all(), /Open this URL to continue in your web browser: https:\/\/account\.kiko\.sh\/device/);
    assert.doesNotMatch(s.all(), /Press Enter to open|user_code/);
    assert.doesNotMatch(after, /user_code/);
    assert.deepEqual(a.opened, []);
  });

  test("I have an account, with no plan: the same sign-in, said for an account; with a key there, nothing more asked", async () => {
    const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ ended: "time" }) })] } });
    const { deps, calls } = fakeDeps({ hasKey: true, account: a.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(DOWN, 2);
    await s.press(ENTER);
    const code = await s.until(/Press Enter to open/);
    assert.match(code, /By signing in, you agree to Kiko's Terms \(kiko\.sh\/terms\) and Privacy Policy/);
    await s.press(ENTER);
    const after = await s.until(/Open Kiko now/);
    assert.match(after, /Sign in/);
    assert.match(after, /Signed in as name@example\.com/);
    assert.match(after, /No plan is running on this account, so Kiko runs on your own key\. It uses the one you have\./);
    assert.doesNotMatch(after, /Paste your OpenRouter key|arrives with the next/);
    assert.equal(a.server.to("trial").length, 0, "no trial started");
    assert.ok(calls.logged.includes('setup_account {"choice":"account","ended":"signed-in"}'));
  });

  test("I have an account, with its trial running: its line, and no key asked", async () => {
    const a = await realAccount({ remote: true, script: { session: [sessionAnswer({ plan: planJson({ daysLeft: 4, used: 0.31 }) })] } });
    const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
    deps.key.has = a.runsModels;
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(DOWN, 2);
    await s.press(ENTER);
    const after = await s.until(/Open Kiko now/);
    assert.match(after, /Plan: free trial · 4 days left \(until [^)]+\) · 31% of its usage used\./);
    assert.doesNotMatch(after, /Paste your OpenRouter key|needs an OpenRouter key/);
    assert.deepEqual(calls.saved, []);
  });

  test("denied, or Esc while it waits: said, and back to the choice (your own key still there)", async () => {
    const held = heldAccount();
    const { deps } = fakeDeps({ hasKey: false, account: held.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    await s.press(ENTER);
    await s.until(/Waiting for you to sign in…/);
    held.settle({ ok: false, why: "denied", said: "The sign-in was denied in the browser. Nothing changed." });
    const back = await s.until(/How do you want to run Kiko\?/);
    // Setup's own words for it (Account.signIn's line is kiko login's).
    assert.match(back, /That code was used up or turned down\. Pick again to get a new one\./);
    await s.press(ENTER);
    await s.until(/Waiting for you to sign in…|Press Enter to open/);
    await s.press(ESC);
    const again = await s.until(/How do you want to run Kiko\?/);
    assert.match(again, /Sign-in stopped\. Pick again to get a new code\./);
    assert.ok(held.aborted());
  });

  test("Esc at the Enter prompt: nothing opened, the sign-in stopped, back to the choice", async () => {
    const a = await realAccount();
    const { deps } = fakeDeps({ hasKey: false, account: a.deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ENTER);
    await s.until(/Press Enter to open/);
    await s.press(ESC);
    const back = await s.until(/How do you want to run Kiko\?/);
    assert.match(back, /Sign-in stopped\. Pick again to get a new code\./);
    assert.deepEqual(a.opened, []);
    assert.equal(a.mem.kept[SESSION_KEY], undefined, "nothing kept");
  });

  test("Esc on the choice: the step skipped, as the key step's Esc", async () => {
    const { deps, calls } = fakeDeps({ hasKey: false, account: heldAccount().deps });
    const s = show(["key", "try"], deps);
    await s.until(/I have an account/);
    await s.press(ESC);
    // Then the last step, with no key: the choice again (the app's start with none).
    assert.match(await s.until(/Kiko can't answer yet/), /Skipped: no key yet\. kiko-dev keys set openrouter adds one any time/);
    assert.ok(calls.logged.includes('setup_account {"choice":"skipped"}'));
  });

  test("signed in already (--all): no choice, said, then the key as ever", async () => {
    const held = heldAccount();
    held.signIn(EMAIL);
    const { deps } = fakeDeps({ hasKey: true, account: held.deps });
    const s = show(["key", "try"], deps);
    const drawn = await s.until(/Paste your OpenRouter key/);
    assert.match(drawn, /Signed in as name@example\.com\. kiko-dev logout signs out\./);
    assert.doesNotMatch(drawn, /How do you want to run/);
  });

  test("signed in already with no plan and never a trial: the trial offered without signing in again", async () => {
    const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ plan: "none" }) })] } });
    await a.account.signIn({ onCode: () => {} });
    const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
    deps.key.has = a.runsModels;
    const s = show(["key", "try"], deps);
    const drawn = await s.until(/My own OpenRouter key/);
    assert.match(drawn, /Signed in as name@example\.com\./);
    assert.match(s.raw(), /● Free trial: 7 days, no card(?! \()/);
    // No code to show (signed in already): the terms starting the trial accepts, under the question.
    assert.match(drawn.slice(drawn.lastIndexOf("How do you want to run")), /By starting the free trial, you agree to Kiko's Terms/);
    assert.doesNotMatch(drawn.slice(drawn.lastIndexOf("How do you want to run")), /I have an account/);
    await s.press(ENTER);
    await s.until(/Your free trial runs until/);
    assert.equal(a.server.to("code").length, 1, "no second sign-in");
    assert.ok(calls.logged.includes('setup_account {"choice":"trial","ended":"signed-in-already"}'));
  });

  test("signed in already with a plan running: its line, no choice and no key", async () => {
    const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ plan: "pro" }) })] } });
    await a.account.signIn({ onCode: () => {} });
    const { deps } = fakeDeps({ hasKey: false, account: a.deps });
    deps.key.has = a.runsModels;
    const s = show(["key", "try"], deps);
    const end = await s.until(/Open Kiko now/);
    assert.match(end, /Signed in as name@example\.com\. Plan: Kiko Pro · 0% of this month used\./);
    assert.doesNotMatch(end, /How do you want to run|Paste your OpenRouter key/);
  });

  test("accounts not open (no account): no choice, straight to the key", async () => {
    const { deps } = fakeDeps({ hasKey: false });
    const s = show(["key", "try"], deps);
    const drawn = await s.until(/Paste your OpenRouter key/);
    assert.doesNotMatch(drawn, /How do you want to run|Free trial/);
  });

  // The app found no key and no plan (start.ts → onboard --need-key: the last step alone).
  describe("the app's start with no key and no plan", () => {
    test("signed out: why, then the choice (the trial, your own key, signing in), not the key ask alone", async () => {
      const { deps } = fakeDeps({ hasKey: false, account: heldAccount().deps });
      const s = show(["try"], deps);
      const drawn = await s.until(/I have an account: sign in/);
      assert.match(drawn, /Kiko can't answer yet: it needs an AI model, and there's no key or plan to run one\./);
      assert.match(drawn, /How do you want to run Kiko\? It needs an AI model for its summaries and routing\./);
      assert.match(s.raw(), /● Free trial: 7 days, no card \(needs a free account\)/);
      assert.match(s.raw(), /○ My own OpenRouter key: no account needed/);
      assert.doesNotMatch(drawn, /needs an OpenRouter key to answer|Paste your OpenRouter key/);
    });

    test("the free trial picked: signed in, the trial started, then on to the app", async () => {
      const a = await realAccount({ remote: true });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      await s.until(/I have an account/);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now\?/);
      assert.match(end, /Your free trial runs until/);
      await s.press(ENTER);
      assert.equal(await s.ended, "open");
      assert.equal(a.server.to("trial").length, 1);
      assert.deepEqual(calls.saved, []);
    });

    test("your own key picked: the key asked for, saved, then on to the app", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false, account: heldAccount().deps });
      const s = show(["try"], deps);
      await s.until(/I have an account/);
      await s.press(DOWN);
      await s.press(ENTER);
      await s.until(/Paste your OpenRouter key/);
      await s.press(FAKE_KEY);
      await s.press(ENTER);
      await s.until(/Open Kiko now\?/);
      await s.press(ENTER);
      assert.equal(await s.ended, "open");
      assert.deepEqual(calls.saved, [FAKE_KEY]);
      assert.ok(calls.logged.includes('setup_account {"choice":"own","at":"end"}'));
    });

    test("Esc on the choice: exactly what to do, and nothing opens", async () => {
      const { deps, calls } = fakeDeps({ hasKey: false, account: heldAccount().deps });
      const s = show(["try"], deps);
      await s.until(/I have an account/);
      await s.press(ESC);
      assert.equal(await s.ended, "no-key");
      assert.match(s.all(), /Run `kiko-dev` again to choose, or `kiko-dev keys set openrouter` to add your own key\./);
      assert.doesNotMatch(s.all(), /Skipped: no key yet/, "said once, at the end");
      assert.ok(calls.logged.includes('setup_account {"choice":"skipped","at":"end"}'));
    });

    test("signed in, the trial ended: who and the plan's line, then your own key asked for at once (no trial, no sign-in)", async () => {
      const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ ended: "time" }) })] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      const drawn = await s.until(/Paste your OpenRouter key/);
      assert.match(drawn, /Kiko can't answer yet/);
      assert.match(drawn, /Signed in as name@example\.com\. Plan: none\. Your free trial ended on \d{1,2} \w{3} \(its 7 days ran out\)\./);
      assert.doesNotMatch(drawn, /How do you want to run|Free trial:|I have an account/);
      await s.press(ESC);
      assert.equal(await s.ended, "no-key");
      assert.match(s.all(), /Run `kiko-dev` again to choose/);
    });

    test("signed in, never a trial: the trial offered with no second sign-in, and no I have an account", async () => {
      const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ plan: "none" }) })] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      const drawn = await s.until(/My own OpenRouter key: no account needed/);
      assert.match(s.raw(), /● Free trial: 7 days, no card(?! \()/);
      assert.doesNotMatch(drawn.slice(drawn.lastIndexOf("How do you want to run")), /I have an account/);
      await s.press(ENTER);
      await s.until(/Open Kiko now\?/);
      assert.equal(a.server.to("code").length, 1, "no second sign-in");
    });

    test("signed in, a plan running after all (started from another Mac): straight on to the app", async () => {
      const a = await realAccount({ script: { session: [sessionAnswer({ plan: planJson({ daysLeft: 3 }) })] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      const end = await s.until(/Open Kiko now\?/);
      assert.match(end, /Plan: free trial · 3 days left/);
      assert.doesNotMatch(end, /How do you want to run|Paste your OpenRouter key/);
    });

    test("accounts not open: the key ask, as ever", async () => {
      const { deps } = fakeDeps({ hasKey: false });
      const s = show(["try"], deps);
      const drawn = await s.until(/Paste your OpenRouter key/);
      assert.match(drawn, /Kiko needs an OpenRouter key to answer\./);
      assert.doesNotMatch(drawn, /How do you want to run|can't answer yet/);
    });
  });
  describe("Kiko Pro, while it's on sale", () => {
    const NONE = sessionAnswer({ plan: planJson({ plan: "none" }) });
    const PRO = sessionAnswer({ plan: proJson() });

    test("the choice: the trial, Kiko Pro beside it, your own key and signing in", async () => {
      const a = await realAccount({ sale: true });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      const s = show(["key", "try"], deps);
      await s.until(/I have an account: sign in/);
      const raw = s.raw();
      assert.match(raw, /● Free trial: 7 days, no card \(needs a free account\)/);
      assert.match(raw, /○ Kiko Pro: \$8\.99 a month, Kiko's AI included/);
      assert.match(raw, /○ My own OpenRouter key: no account needed/);
      assert.ok(raw.lastIndexOf("Free trial:") < raw.lastIndexOf("Kiko Pro:") && raw.lastIndexOf("Kiko Pro:") < raw.lastIndexOf("My own OpenRouter key"), "in that order");
    });

    test("Kiko Pro picked: signed in (kiko login's flow), the plan asked, checkout's link (over SSH), the payment waited for, then Pro runs the AI and no key is asked", async () => {
      const a = await realAccount({ sale: true, remote: true, script: { session: [NONE, NONE, PRO] } });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(DOWN);
      await s.press(ENTER);
      const asked = await s.until(/Which Kiko Pro plan\?/);
      assert.match(asked, /Kiko's AI included · tax included/);
      assert.match(s.raw(), /● \$8\.99 a month/);
      assert.match(s.raw(), /○ \$89 a year \(about 2 months free\)/);
      await s.press(ENTER);
      await s.until(/Open Kiko now/);
      assert.match(s.all(), /Kiko Pro is on\. Renews 3 Dec\. Manage it any time: kiko-dev account billing/);
      assert.match(s.all(), /Open this link to pay, on any device: https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_kiko/);
      assert.doesNotMatch(s.all(), /Paste your OpenRouter key/);
      assert.deepEqual(
        a.server.to("checkout").map((c) => [c.bearer, c.body]),
        [[SESSION_TOKEN, { interval: "month" }]],
      );
      assert.ok(calls.logged.includes('setup_pro {"ended":"on"}'));
      assert.deepEqual(a.opened, [], "over SSH: nothing opened here");
    });

    test("the browser opened at checkout; Esc while it's waited for: back to the choice, your own key first", async () => {
      const a = await realAccount({ sale: true, script: { session: [NONE] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/Kiko Pro: \$8\.99 a month/);
      await s.press(DOWN);
      await s.press(ENTER);
      await s.until(/Which Kiko Pro plan\?/);
      await s.press(DOWN);
      await s.press(ENTER);
      await s.until(/Waiting for payment… Esc to stop waiting/);
      assert.match(s.all(), /Opening checkout in your browser… \(Enter if it didn't open\)/);
      assert.deepEqual(a.opened, ["https://checkout.stripe.com/c/pay/cs_test_kiko"]);
      assert.deepEqual(
        a.server.to("checkout").map((c) => c.body),
        [{ interval: "year" }],
      );
      await s.press(ESC);
      await s.until(/How do you want to run Kiko/);
      assert.match(s.all(), /Stopped waiting\. If you pay, Kiko picks it up: kiko-dev account shows the plan\./);
      assert.match(s.raw().slice(s.raw().lastIndexOf("How do you want to run")), /● My own OpenRouter key/);
    });

    test("not on sale on the server (billing_unavailable): said, and the choice again without Kiko Pro", async () => {
      const a = await realAccount({ sale: true, script: { session: [NONE], checkout: [billingRefused("billing_unavailable")] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      const s = show(["key", "try"], deps);
      await s.until(/Kiko Pro: \$8\.99 a month/);
      await s.press(DOWN);
      await s.press(ENTER);
      await s.until(/Which Kiko Pro plan\?/);
      await s.press(ENTER);
      await s.until(/How do you want to run Kiko/);
      assert.match(s.all(), /Kiko Pro isn't on sale yet\./);
      const after = s.raw().slice(s.raw().lastIndexOf("How do you want to run"));
      assert.doesNotMatch(after, /Kiko Pro:/);
      assert.match(after, /My own OpenRouter key/);
    });

    test("the trial-ended screen: Kiko Pro and your own key (your own key first), no trial, no sign-in", async () => {
      const a = await realAccount({ sale: true, script: { session: [sessionAnswer({ plan: planJson({ ended: "time" }) })] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      const drawn = await s.until(/My own OpenRouter key: no account needed/);
      assert.match(drawn, /Kiko can't answer yet/);
      const raw = s.raw().slice(s.raw().lastIndexOf("How do you want to run"));
      assert.match(raw, /○ Kiko Pro: \$8\.99 a month, Kiko's AI included/);
      assert.match(raw, /● My own OpenRouter key: no account needed/);
      assert.doesNotMatch(raw, /Free trial:|I have an account/);
      await s.press(ENTER);
      await s.until(/Paste your OpenRouter key/);
    });

    test("on Pro already, past its month's allowance: said, no Kiko Pro to buy, your own key offered as optional; Esc goes on to the app", async () => {
      const a = await realAccount({ sale: true, script: { session: [sessionAnswer({ plan: proJson({ used: 100 }) })] } });
      await a.account.signIn({ onCode: () => {} });
      await a.account.check();
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["try"], deps);
      const drawn = await s.until(/Paste your OpenRouter key/);
      assert.match(drawn, /Signed in as name@example\.com\. This month's Kiko Pro allowance is used; it renews on \d{1,2} \w{3}\./);
      assert.match(drawn, /It's optional: paste one, or Esc to go on without\./);
      assert.doesNotMatch(drawn, /How do you want to run|can't answer yet/);
      await s.press(ESC);
      await s.until(/Open Kiko now\?/);
      assert.match(s.all(), /No key added: Kiko Pro runs Kiko's AI again once it renews\./);
      await s.press(ENTER);
      assert.equal(await s.ended, "open");
      assert.equal(a.server.to("checkout").length, 0);
      assert.equal(a.server.to("trial").length, 0);
      assert.deepEqual(calls.saved, []);
    });
  });

  // A Pro account on a fresh install picked the free trial (2026-11-04): setup signed in, started a
  // trial the server refused, and asked for a key. The plan is asked first now, whatever's picked.
  describe("signed in: the account's plan first, whatever was picked", () => {
    /** Pro, with a trial used long ago. */
    const PRO_USED_TRIAL = sessionAnswer({ plan: { ...proJson(), trial: planJson({ ended: "time" }).trial } });

    test("Pro with a used trial, the free trial picked: Pro's line, no trial started and no key asked", async () => {
      const a = await realAccount({ remote: true, script: { session: [PRO_USED_TRIAL], trial: [trialRefused("trial_used")] } });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now/);
      assert.match(end, /Signed in as name@example\.com/);
      assert.match(end, /Plan: Kiko Pro \(monthly\) · renews 3 Dec · 31% of this month used\./);
      assert.doesNotMatch(s.all(), /Paste your OpenRouter key|already used its free trial|can't answer yet/);
      assert.equal(a.server.to("trial").length, 0, "no trial asked for");
      assert.deepEqual(calls.saved, []);
      assert.ok(calls.logged.includes('setup_plan {"plan":"pro"}'));
      assert.ok(!calls.logged.some((l) => l.startsWith("setup_trial")));
    });

    test("Pro, I have an account picked: Pro's line, no key asked", async () => {
      const a = await realAccount({ remote: true, script: { session: [PRO_USED_TRIAL] } });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(DOWN, 2);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now/);
      assert.match(end, /Plan: Kiko Pro \(monthly\) · renews 3 Dec/);
      assert.doesNotMatch(s.all(), /Paste your OpenRouter key|No plan is running/);
      assert.equal(a.server.to("trial").length, 0);
      assert.deepEqual(calls.saved, []);
    });

    test("Pro, Kiko Pro picked (on sale): Pro's line, no plan question and no checkout", async () => {
      const a = await realAccount({ sale: true, remote: true, script: { session: [PRO_USED_TRIAL] } });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(DOWN);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now/);
      assert.match(end, /Plan: Kiko Pro \(monthly\) · renews 3 Dec/);
      assert.doesNotMatch(s.all(), /Which Kiko Pro plan\?|Paste your OpenRouter key/);
      assert.equal(a.server.to("checkout").length, 0);
    });

    test("a trial running, the free trial picked: its line, no second trial and no key", async () => {
      const a = await realAccount({ remote: true, script: { session: [sessionAnswer({ plan: planJson({ daysLeft: 4, used: 0.31 }) })], trial: [trialRefused("trial_used")] } });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now/);
      assert.match(end, /Plan: free trial · 4 days left \(until [^)]+\) · 31% of its usage used\./);
      assert.doesNotMatch(s.all(), /Paste your OpenRouter key|already used its free trial/);
      assert.equal(a.server.to("trial").length, 0);
    });

    test("a used trial and no plan, the free trial picked: the trial asked for, refused and said, and only then your own key", async () => {
      const a = await realAccount({ remote: true, script: { session: [sessionAnswer({ plan: planJson({ ended: "time" }) })], trial: [trialRefused("trial_used")] } });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(ENTER);
      const back = await s.until(/name@example\.com has already used its free trial\.[\s\S]*How do you want to run/);
      assert.doesNotMatch(back, /Paste your OpenRouter key/, "no key asked before the refusal is said");
      assert.equal(a.server.to("trial").length, 1);
      assert.ok(calls.logged.includes('setup_trial {"ended":"trial_used"}'));
      assert.match(s.raw().slice(s.raw().lastIndexOf("How do you want to run")), /● My own OpenRouter key: no account needed/);
      await s.press(ENTER);
      await s.until(/Paste your OpenRouter key/);
    });

    test("Pro past its month's allowance, the free trial picked: said, your own key optional (Esc goes on), no trial and no can't-answer at the end", async () => {
      const a = await realAccount({ remote: true, script: { session: [sessionAnswer({ plan: { ...proJson({ used: 100 }), trial: planJson({ ended: "time" }).trial } })] } });
      const { deps, calls } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(ENTER);
      const asked = await s.until(/Paste your OpenRouter key/);
      assert.match(asked, /This month's Kiko Pro allowance is used; it renews on \d{1,2} \w{3}\./);
      assert.match(asked, /It's optional: paste one, or Esc to go on without\./);
      await s.press(ESC);
      await s.until(/Open Kiko now/);
      const all = s.all();
      assert.match(all, /No key added: Kiko Pro runs Kiko's AI again once it renews\./);
      assert.doesNotMatch(all, /can't answer yet|already used its free trial/);
      assert.equal(a.server.to("trial").length, 0);
      assert.ok(calls.logged.includes('setup_plan {"plan":"pro","paused":true}'));
      await s.press(ENTER);
      assert.equal(await s.ended, "open");
    });

    test("Pro past its month's allowance with a key of your own: said, and the key kept (nothing asked)", async () => {
      const a = await realAccount({ remote: true, script: { session: [sessionAnswer({ plan: proJson({ used: 100 }) })] } });
      const { deps, calls } = fakeDeps({ hasKey: true, account: a.deps });
      const s = show(["key", "try"], deps);
      await s.until(/I have an account/);
      await s.press(DOWN, 2);
      await s.press(ENTER);
      const end = await s.until(/Open Kiko now/);
      assert.match(end, /This month's Kiko Pro allowance is used/);
      assert.match(end, /Until then, Kiko uses your own key\./);
      assert.doesNotMatch(s.all(), /Paste your OpenRouter key/);
      assert.deepEqual(calls.saved, []);
    });

    test("signed in already, Pro past its month's allowance (--all): said under who, your own key optional", async () => {
      const a = await realAccount({ script: { session: [sessionAnswer({ plan: proJson({ used: 100 }) })] } });
      await a.account.signIn({ onCode: () => {} });
      const { deps } = fakeDeps({ hasKey: false, account: a.deps });
      deps.key.has = a.runsModels;
      const s = show(["key", "try"], deps);
      const asked = await s.until(/Paste your OpenRouter key/);
      assert.match(asked, /Signed in as name@example\.com\. This month's Kiko Pro allowance is used/);
      assert.doesNotMatch(asked, /How do you want to run|Kiko's summaries and replies run on OpenRouter/);
      await s.press(ESC);
      await s.until(/Open Kiko now/);
      assert.doesNotMatch(s.all(), /can't answer yet/);
    });
  });
});
