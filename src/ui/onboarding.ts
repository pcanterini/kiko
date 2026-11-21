// First-run setup's steps on screen (core/onboarding.ts picks them; ../onboard.ts runs them), under
// Kiko's logo (./logo.ts: its effects played once as setup starts, a key skipping them), in
// @clack/prompts' look: one rail down the left, each step's question (◆) answered into a line that
// stays (◇), so install.sh's output and setup read as one flow. The live parts (the mic's level, the
// talk key pressed, a permission waited for) are ./live.ts on the same rail. Esc (or Ctrl+C) on a
// step skips that step only, and says how to come back to it; Ctrl+C twice in a row stops setup.
// What each step does goes through `SetupDeps`, so the tests drive it all with fakes. A key typed
// is never drawn: Clack's password prompt masks it.
//
//   ┌  Kiko setup
//   │
//   ◇  Which coding agents should Kiko talk to?
//   │  Claude Code, Codex CLI
//   │
//   ◆  Connected Claude Code and Codex CLI.
//   │  Restart Claude Code or Codex sessions that are already open; Codex asks once to trust its hooks.
//   │
//   ◆  Paste your OpenRouter key
//   │  Get one at https://openrouter.ai/keys · it stays hidden
//   │  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪_
//   └
//
// While accounts are open (core/env.ts accountsLive: `deps.account` set), the key step starts with
// how to run it: the free trial (an account), your own OpenRouter key (no account: the key step as
// it was), or signing in to an account you have. The trial and signing in run `kiko login`'s
// device code flow (account-cli.ts followCode, as `gh auth login --web`) in a live step: the
// one-time code first, then Enter opens the page's plain link, where you type it. While it waits,
// n gets a new code at once and Esc goes back to the choice; a code that runs out is replaced and
// the server's outages are waited out (up to 30 minutes). A sign-in that didn't go lands back on the
// choice in setup's own words ("Pick again to get a new one"), never `kiko login`'s.
// Signed in, whatever was picked, the account's plan comes first (planCovers): Pro or a trial running
// says its line and needs no key (a Pro account picking the trial starts none); Pro past its month's
// allowance says so, with your own key offered as optional. With no plan, the trial then starts on
// the server, and Kiko's AI runs on it with no key. One the server won't start (this email had one,
// a throwaway email…) is said, and your own key is next. The last step
// with no key and no plan (the app's start: start.ts runs it alone) offers the same choice
// (chooseModel), not the key ask alone. While Kiko Pro is on sale (`account.upgrade` set), the
// choice also offers it ("Kiko Pro: $8.99 a month, Kiko's AI included"), the trial ended or not:
// picked, it signs in if need be, asks monthly or yearly, and runs `kiko upgrade`'s checkout
// (upgrade-cli.ts followCheckout) in a live step. Your own key is always there beside it.
import * as p from "@clack/prompts";
import { styleText } from "node:util";
import type { CardRow } from "../agents/setup.ts";
import { codeWords, renewedLine, UNREACHABLE_LINE, type CodeUi } from "../account-cli.ts";
import { PRO_CHOICES, UPGRADE_WORDS, type CheckoutEnd, type CheckoutUi } from "../upgrade-cli.ts";
import { NewCode, SIGN_IN_FOR_MS, type SignIn } from "../core/account/account.ts";
import { NEEDS_KEY, NO_KEY_TODO, type KeyCheck } from "../core/keys.ts";
import { micChoices, resolveMic, type MicChoice, type MicDevice } from "../core/mic-device.ts";
import {
  ACCOUNT_NO_PLAN,
  helloText,
  HOW_TO_RUN,
  KEY_INTRO,
  KEY_URL,
  NO_MIC,
  quitAndReopenLine,
  staleLine,
  VOICE_WORDS,
  voiceBar,
  whereToTurnOn,
  type DoneStep,
  type StepId,
} from "../core/onboarding.ts";
import type { PrepNow } from "../core/pocket-prep.ts";
import { agreeLine, PRO_AGREE } from "../core/terms.ts";
import { phoneLive } from "../core/env.ts";
import { COMMAND, DOMAIN, ENV_PREFIX, NAME, TITLE } from "../core/name.ts";
import type { Permission, PermissionId, Permissions } from "../platform/types.ts";
import { bars, pushLevel, METER_LENGTH } from "./meter.ts";
import { colorDepth } from "./cli-style.ts";
import { printLogo } from "./logo.ts";
import { decodeKeys, live, wrap, type Io, type Key, type Live } from "./live.ts";
import { QUIT_AGAIN_MS } from "./quit-again.ts";

/** The account's plan as setup asks it (SetupDeps.account.plan). */
export type AccountPlan = { active: boolean; line: string; hadTrial: boolean; pro?: boolean; paused?: string };

/** What a mic test heard: its loudest level (0–1) and the words; `noDevice`: there was nothing to listen with. */
export type MicHeard = { peak: number; heard: string; noDevice?: boolean };

/** What the steps do, the app's (../onboard.ts) or a test's. */
export type SetupDeps = {
  /**
   * Who the permissions go to, by name: the helper app ("Kiko Dev", `ownApp`), else the terminal app
   * ("Ghostty"), null when it can't be told.
   */
  app: string | null;
  /** The permissions are the helper app's (platform/macos/helper-app.ts): nothing to reopen, it's restarted itself (permissions.refresh). */
  ownApp?: boolean;
  /** What's missing that Kiko needs (no coding agent): said first, a line each. */
  missing: string[];
  permissions: {
    /** Where each stood as setup began. */
    initial: Permissions;
    status(): Promise<Permissions>;
    request(which: PermissionId): Promise<Permission>;
    /** "Privacy & Security → Microphone". */
    pane(which: PermissionId): string;
    open(which: PermissionId): void;
    /** The helper app started again, so a permission just turned on takes effect (Input Monitoring); false when it's the terminal's. */
    refresh?(): Promise<boolean>;
  };
  agents: {
    /** Every agent found (agents/setup.ts cardRows), each listed as a box; null when there's none to offer. */
    rows: CardRow[] | null;
    /** The agents Kiko works with that aren't on this Mac, in a line (agents/setup.ts notInstalledLine); null when all are. */
    notInstalled?: string | null;
    /** The card answered: the ids ticked, or later (Esc). What came of it in a line, then (after a newline) what's left to do, if anything. */
    answer(connect: string[] | "later"): string;
  };
  key: {
    /** Whether there's a model key now (core/keys.ts hasModelKey: the app asks the same), one just saved included. */
    has(): boolean;
    /** Whether there's a Keychain to keep it in (no: KIKO_KEYCHAIN is off). */
    store: boolean;
    /** Why the Keychain couldn't be read as setup started (its keys missing then), or null. */
    unread?: string | null;
    check(key: string): Promise<KeyCheck>;
    /** Kept in the Keychain: null, or why it couldn't be (never with the key in it). */
    save(key: string): Promise<string | null>;
  };
  /**
   * This Mac's Kiko account (core/account/): set only while accounts are open (core/env.ts
   * accountsLive) and there's a Keychain to keep a sign-in in. The key step then asks how to run
   * Kiko first; without it, the key step is as it always was.
   */
  account?: {
    /** Who's signed in now (account.json): the email, "" when it isn't known yet; null when nobody is. */
    signedIn(): string | null;
    /**
     * The device code flow (core/account/account.ts signIn), shown through `ui` as `kiko login`
     * shows it (account-cli.ts followCode): the code, then Enter waited for and the plain link
     * opened, or (over SSH) the link to open on any device. `signal` cancels the wait; `newCode`
     * (`n`) gets a fresh code at once. Patient (Account.signIn): the next code goes to `ui.renewed`,
     * the server out of reach and back to `ui.reach`.
     */
    signIn(ui: CodeUi, signal: AbortSignal, newCode?: NewCode): Promise<SignIn>;
    /** Starts the free trial, signed in (the server's checks): `said`, the line either way. */
    startTrial(): Promise<{ ok: boolean; said: string; code?: string }>;
    /**
     * The plan, asked of the server now: whether one runs Kiko's AI (`active`), its line, and
     * whether the account ever had a trial. `paused`: Pro past its month's allowance (not active,
     * yet no key needed: it renews), said in a line. Null when the server couldn't be asked.
     */
    plan(): Promise<AccountPlan | null>;
    /**
     * Kiko Pro's checkout, signed in (upgrade-cli.ts followCheckout): the page opened (or its link,
     * over SSH), then the payment waited for until Pro is on, Esc (`signal`) or 15 minutes. Set only
     * while Pro is on sale (core/env.ts proOnSale): without it, setup offers no Pro.
     */
    upgrade?(interval: "month" | "year", ui: CheckoutUi, signal: AbortSignal): Promise<CheckoutEnd>;
  };
  /** The Mac's input devices (asks nothing, opens nothing); null when that couldn't be told. */
  micInputs(): Promise<MicDevice[] | null>;
  /** The mic open for `ms`: each level as it comes, the words as they're heard. */
  micTest(ms: number, onLevel: (level: number) => void, onHeard: (text: string) => void): Promise<MicHeard>;
  /** The mic chosen (the mic and micName settings; null: the system default), and another kept as Settings → Listening keeps it. */
  micPick: { current(): MicChoice; save(uid: string, inputs: MicDevice[]): void };
  talkKey: {
    /** The key now, as said and shown ("Right Option"). */
    label(): string;
    /** Listens for a press of the key now: `onDown` each time; `onFail` when it can't (no Input Monitoring). Stops with what it returns. */
    listen(onDown: () => void, onFail: (why: string) => void): () => void;
    /** The next key pressed anywhere: its name ("right_command", "keycode:<n>"). */
    capture(): Promise<string>;
    /** Whether a key name is one that types nothing (modifiers, F13–F19). */
    quiet(name: string): boolean;
    labelOf(name: string): string;
    /** The key kept as the talk key. */
    save(name: string): void;
    /** The menu key, as shown ("Ctrl+Space"). */
    menu: string;
  };
  name: {
    /** What you call it now: the default until one is kept (name.ts spokenName). */
    current(): string;
    /** Why a name may wake it by accident, or null (wake.ts nameWarning): said, never refused. */
    warning(name: string): string | null;
    /** Kept as what you call it (the spokenName setting), at once; returns it as kept. */
    save(name: string): string;
  };
  hello: {
    /** Says hello in the voice that will speak (Pocket once it's downloaded, a replay too); resolves once it's done. */
    say(text: string): Promise<void>;
    /**
     * Pocket's download (core/pocket-prep.ts prepWatcher), looked at again and again while the step
     * waits for it: running (how far along: never back), ready, failed (why, for the log); "none"
     * when it isn't the voice that will speak.
     */
    voice(): Promise<PrepNow>;
  };
  /** A step finished: kept, so `kiko setup` leaves it out next time. */
  done(step: DoneStep): void;
  /**
   * Where the next `kiko setup` (or `kiko`) starts: the talk key when the terminal app must be
   * reopened first; null once that's behind. `command`: setup's command, by its full path.
   */
  resume: { save(step: StepId | null): void; command: string };
  /** What to try first (core/onboarding.ts tryLines). */
  tryLines(): string[];
  /** The last step's choice: "Open Kiko" (Enter), and what's said for later (Esc): "Run kiko when you're ready." */
  end: { label: string; later: string };
  /** For the log: what happened that the screen doesn't keep (Input Monitoring's wait). */
  log(event: string, fields?: Record<string, unknown>): void;
  /**
   * Kiko's Terms, when this version wasn't accepted here yet (core/terms.ts termsNotice): `line`,
   * said dim before the first step (AGREE_LINE, or changedLine for terms changed since), and
   * `accept`, called once that step is behind (answered or skipped: going on is accepting them;
   * Ctrl+C twice before isn't). None: accepted already, nothing said.
   */
  terms?: { line: string; accept(): void } | null;
  /**
   * Why steps were left out, in a line said under the title (core/onboarding.ts carriedLine: "Your
   * agents, key and talk key are set up already."), so a short setup doesn't look broken; null for none.
   */
  carried?: string | null;
  /**
   * The steps marked done before that are asked again because their macOS permission is gone now
   * (core/onboarding.ts staleDone): a line before each says so (staleLine).
   */
  stale?: readonly DoneStep[];
  /**
   * Kiko's logo and tagline first, above the title (logoHeader): `kiko setup`'s and the first run's;
   * not when the key is asked alone (--need-key), nor in the tests that don't ask for it.
   */
  header?: boolean;
  /** How long the mic test listens. */
  micMs?: number;
  /** How often a permission being turned on is checked. */
  pollMs?: number;
};

/** The app's start with no key and no plan (chooseModel): why it can't answer, and (Esc) what to do. */
const NO_MODEL_YET = `${NAME} can't answer yet: it needs an AI model, and there's no key or plan to run one.`;
const NO_MODEL_TODO = `Run \`${COMMAND}\` again to choose, or \`${COMMAND} keys set openrouter\` to add your own key.`;

/** Said when there's no Keychain to keep a key in. */
const NO_KEYCHAIN = `No Keychain here (${ENV_PREFIX}KEYCHAIN is off): put OPENROUTER_API_KEY in .env instead.`;

/** Ctrl+C twice in a row: setup stops (what was done is kept). */
class Quit extends Error {}

/**
 * How setup ended: "open" (Enter on the last step: on to the window), "later" (Esc there), "no-key"
 * (left on the last step with no model key: nothing to open), or "quit" (Ctrl+C twice).
 */
export type SetupEnd = "open" | "later" | "no-key" | "quit";

const dim = (s: string) => styleText("dim", s);

/**
 * Clack's multiselect with our own dim line under the options, where its key footer goes ("↑/↓ to
 * navigate • Space: select • Enter: confirm"): Clack has no footer option, but draws its exported
 * MULTISELECT_INSTRUCTIONS there each time, so their words are swapped in for this prompt and put
 * back once it's answered (or skipped), and every other prompt keeps Clack's own. Put back from a
 * copy taken at load, so two of these at once (only the tests run two) can't leave ours behind.
 */
async function multiselectWithFooter<T>(opts: p.MultiSelectOptions<T>, footer: string): Promise<T[] | symbol> {
  p.MULTISELECT_INSTRUCTIONS.splice(0, Infinity, dim(footer));
  try {
    return await p.multiselect({ ...opts, showInstructions: true });
  } finally {
    p.MULTISELECT_INSTRUCTIONS.splice(0, Infinity, ...CLACK_FOOTER);
  }
}
const CLACK_FOOTER = [...p.MULTISELECT_INSTRUCTIONS];

/** What a setup's steps share, made once as it starts (startRun): how they ask and say, kept to its Ctrl+C. */
type Run = {
  /** Clack's streams, for a prompt or a line. */
  ui: { input: Io["input"]; output: Io["output"] };
  /** Who the permissions go to (SetupDeps.app), or "your terminal app". */
  app: string;
  /** A prompt's answer, or null when it was skipped (Esc). */
  ask: <T>(answer: Promise<T>) => Promise<Exclude<T, symbol> | null>;
  /** Clack's log lines don't wrap: wrapped here to the terminal's width, so the rail stays whole. */
  fit: (text: string, style?: (s: string) => string) => string;
  say: Record<"note" | "aside" | "info" | "ok" | "warn" | "under" | "skipped", (text: string) => void>;
  /** A live step's keys: Esc or Ctrl+C `skip`s it (Ctrl+C twice stops setup: watchCtrlC sees it too); the rest to `other`. */
  liveKeys: (skip: () => void, other?: (str: string | undefined, key: Key) => void) => (str: string | undefined, key: Key) => void;
  /** Ctrl+C twice: setup stops here (Quit). */
  quitIfAsked: () => void;
  /** Set when there's no microphone: the talk key's test is skipped too. */
  noMic: boolean;
  /**
   * Set once the account's plan was found to cover Kiko (planCovers): running its AI, or Pro past its
   * month's allowance (said, your own key offered as optional). The last step then asks for no key.
   */
  covered: boolean;
};

/** Each step but the last (what to try: wrapUp), its own function; each one's question answered or skipped. */
const STEPS: Record<Exclude<StepId, "try">, (deps: SetupDeps, io: Io, run: Run) => Promise<void>> = {
  agents: agentsStep,
  key: keyStep,
  mic: micStep,
  talkKey: talkKeyStep,
  name: nameStep,
  hello: voiceStep,
};

/**
 * The whole setup: the steps in order, each one's question answered or skipped. Resolves with how
 * it ended; what each step finished is kept as it goes (deps.done, the settings, the Keychain).
 */
export async function runSetup(steps: StepId[], deps: SetupDeps, io: Io): Promise<SetupEnd> {
  const { run, stop } = startRun(deps, io);
  const { ui, say } = run;
  try {
    if (deps.header) await logoHeader(io);
    p.intro(styleText(["bgCyan", "black"], ` ${TITLE} setup `), ui);
    // The terms, once per version (TERMS.md "Accepting these terms"): under the logo and its tagline
    // when it's drawn, the first line of setup; else right before the first step. Going on past that
    // step is accepting them, so it's kept once the step is behind.
    const terms = deps.terms ?? null;
    if (terms && deps.header) say.aside(terms.line);
    for (const line of deps.missing) say.warn(line);
    if (deps.carried) say.aside(deps.carried);
    if (steps.length > 1) {
      say.aside(`Heads up: ${NAME} acts on what it hears, and AI makes mistakes. Check what your agents do before you approve it; you're responsible for what they run.`);
      say.aside(`Esc skips a step (${COMMAND} setup comes back to it). Ctrl+C twice stops.`);
    }
    if (terms && !deps.header) say.aside(terms.line);
    const accepted = () => {
      if (!terms) return;
      terms.accept();
      deps.log("setup_terms", { accepted: true });
    };
    for (const [i, step] of steps.entries()) {
      if (step === "try") {
        const end = await wrapUp(deps, io, run, steps.length === 1);
        if (i === 0) accepted();
        return end;
      }
      if (deps.stale?.includes(step as DoneStep)) say.aside(staleLine(step as DoneStep, run.app));
      await STEPS[step](deps, io, run);
      run.quitIfAsked();
      if (i === 0) accepted();
    }
    return "later";
  } catch (err) {
    if (!(err instanceof Quit)) throw err;
    p.cancel(`Setup stopped. What was done is kept: ${COMMAND} setup goes on from there.`, ui);
    return "quit";
  } finally {
    stop();
  }
}

/**
 * Kiko's logo with its tagline, once, where setup starts (the steps go on under it): its effects
 * played where the output is a terminal, a key pressed skipping them (that key is for the logo, not
 * kept for the first step); still elsewhere. Colour as cli-style.ts says (NO_COLOR: the shapes).
 * Too narrow a terminal for it: none.
 */
async function logoHeader(io: Io) {
  const output = io.output as Io["output"] & { isTTY?: boolean; columns?: number };
  let skip = () => {};
  const skipped = new Promise<void>((resolve) => (skip = resolve));
  const animate = Boolean(output.isTTY);
  if (animate) {
    io.input.on("keypress", skip);
    io.input.resume();
  }
  try {
    output.write("\n");
    await printLogo(output, { columns: output.columns ?? 80, depth: colorDepth(output), animate, indent: 2, skipped });
  } finally {
    if (animate) {
      io.input.off("keypress", skip);
      io.input.pause();
    }
  }
}

/** The run's shared handles (Run), and `stop` for when it's over: Ctrl+C no longer watched, the terminal out of raw mode. */
function startRun(deps: SetupDeps, io: Io): { run: Run; stop: () => void } {
  const { output } = io;
  const ui = { input: io.input, output };
  // Ctrl+C cancels a prompt as Esc does (Clack can't tell them apart): watched here, twice within QUIT_AGAIN_MS (2 s) stops.
  let lastCtrlC = 0;
  let quit = false;
  const watchCtrlC = (_s: string | undefined, key: Key) => {
    if (!(key.ctrl && key.name === "c")) return;
    if (Date.now() - lastCtrlC < QUIT_AGAIN_MS) quit = true;
    lastCtrlC = Date.now();
  };
  // Before Clack's prompts, so this decides how long an Esc waits: as long as theirs (live.ts ESCAPE_MS).
  decodeKeys(io.input);
  io.input.on("keypress", watchCtrlC);
  io.input.pause();
  // Raw from start to end, between steps too (Clack turns it off after each prompt): a key pressed
  // while the next step gets ready is kept for it, not echoed, and Ctrl+C skips rather than kills.
  const tty = io.input as Io["input"] & { isTTY?: boolean; setRawMode?: (on: boolean) => void };
  const raw = (on: boolean) => tty.isTTY && tty.setRawMode?.(on);
  raw(true);
  const ask = async <T>(answer: Promise<T>): Promise<Exclude<T, symbol> | null> => {
    const v = await answer;
    raw(true);
    if (quit) throw new Quit();
    return p.isCancel(v) ? null : (v as Exclude<T, symbol>);
  };
  const fit = (text: string, style: (s: string) => string = (s) => s) =>
    wrap(text, Math.max(20, ((output as { columns?: number }).columns ?? 80) - 4))
      .map(style)
      .join("\n");
  const say = {
    note: (text: string) => p.log.message(fit(text), ui),
    /** A line of less weight: dim. */
    aside: (text: string) => p.log.message(fit(text, dim), ui),
    info: (text: string) => p.log.info(fit(text), ui),
    ok: (text: string) => p.log.success(fit(text), ui),
    warn: (text: string) => p.log.warn(fit(text), ui),
    /** A line dim, right under the one before. */
    under: (text: string) => p.log.message(fit(text, dim), { ...ui, spacing: 0 }),
    /** A skipped step: how to come back to it, dim (right under it: a skipped prompt ends with the rail already). */
    skipped: (text: string) => p.log.message(fit(text, dim), { ...ui, spacing: 0 }),
  };
  const liveKeys =
    (skip: () => void, other: (str: string | undefined, key: Key) => void = () => {}) =>
    (str: string | undefined, key: Key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) skip();
      else other(str, key);
    };
  const quitIfAsked = () => {
    if (quit) throw new Quit();
  };
  const run: Run = { ui, app: deps.app ?? "your terminal app", ask, fit, say, liveKeys, quitIfAsked, noMic: false, covered: false };
  return {
    run,
    stop() {
      io.input.off("keypress", watchCtrlC);
      raw(false);
    },
  };
}

// ── Your agents ────────────────────────────────────────────────────────
async function agentsStep(deps: SetupDeps, _io: Io, run: Run) {
  const { ui, ask, say } = run;
  // Every agent found, each a box (connected ones ticked: unticking one disconnects it); the ones
  // supported but not on this Mac in a line above.
  const rows = deps.agents.rows ?? [];
  if (deps.agents.notInstalled) say.note(deps.agents.notInstalled);
  say.aside(`Each agent's file is backed up first; your own hooks stay.${rows.some((r) => r.state === "connected") ? " Unticking a connected one disconnects it." : ""}`);
  const picked = await ask(
    // The keys said under the options, in place of Clack's own key footer.
    multiselectWithFooter(
      {
        ...ui,
        message: `Which coding agents should ${NAME} talk to?`,
        // Clack puts the hint in parentheses: none inside it ("fired (Codex 0.166.0)" → "fired: Codex 0.166.0").
        options: rows.map((r) => ({ value: r.id, label: r.name, hint: (r.hint ?? r.detail).replace(/\s*\(([^()]*)\)/g, ": $1") })),
        initialValues: rows.filter((r) => r.ticked ?? r.ask).map((r) => r.id),
        // Enter with none ticked is refused with Clack's own words (it can't be given others); Esc skips.
        required: true,
      },
      "Pick at least one. Space ticks, Enter goes on.",
    ),
  );
  // What changed in a line; what's left to do (restart open sessions, trust the hooks) dim under it.
  const [said, ...todo] = deps.agents.answer(picked ?? "later").split("\n");
  if (picked === null) say.skipped(said);
  else if (/wasn't (dis)?connected/.test(said)) say.warn(said);
  else say.ok(said || "Nothing changed.");
  if (todo.length) say.under(todo.join(" "));
}

// ── One key ────────────────────────────────────────────────────────────
/** How a key ask ended, for the log (never the key): saved, saved unchecked, skipped, kept the one there, couldn't be saved, or no Keychain. */
type KeyEnded = "saved" | "saved-unchecked" | "skipped" | "kept" | "save-failed" | "no-keychain";

/**
 * The key pasted, checked with OpenRouter and kept in the Keychain; another asked for while
 * OpenRouter turns one down. `skip`: what Esc says (the end's ask says it itself: null). Logged
 * as setup_key (`at`: the step, or the end), with how many were turned down.
 */
async function pasteKey(deps: SetupDeps, io: Io, run: Run, at: "step" | "end", skip: string | null): Promise<KeyEnded> {
  const { ui, ask, say } = run;
  let refused = 0;
  const ended = (how: KeyEnded) => (deps.log("setup_key", { at, ended: how, refused }), how);
  for (let again = false; ; again = true) {
    const typed = await ask(
      p.password({
        ...ui,
        // Where to get one right under the question, in full so the terminal makes it a link.
        message: `${again ? "Paste another OpenRouter key" : "Paste your OpenRouter key"}\n${dim(`Get one at ${KEY_URL} · it stays hidden`)}`,
        validate: (v) => (v?.trim() ? undefined : at === "end" ? "Paste it, or Esc to add it later." : "Paste it, or Esc to skip."),
      }),
    );
    if (typed === null) {
      if (skip) say.skipped(skip);
      return ended(deps.key.has() ? "kept" : "skipped");
    }
    // Only what a key is made of (no spaces, line ends or escapes from the paste).
    const k = typed.replace(/[^\x21-\x7e]/g, "");
    const checking = live(io);
    checking.show("Checking it with OpenRouter…");
    const check = await deps.key.check(k);
    if (check.result === "refused") {
      refused++;
      checking.end("warn", `${check.said.replace(/^✗ /, "")}. Nothing saved.`);
      continue;
    }
    if (check.result === "unchecked") {
      checking.end("warn", check.said.replace(/^✗ /, ""));
      const anyway = await ask(p.confirm({ ...ui, message: "Save it anyway?", active: "Save it", inactive: "Paste another", initialValue: true }));
      if (anyway === null) {
        if (skip) say.skipped(skip);
        return ended(deps.key.has() ? "kept" : "skipped");
      }
      if (!anyway) continue;
      const why = await deps.key.save(k);
      if (why) say.warn(`Couldn't save it in the Keychain: ${why}`);
      else say.ok("Saved in the Keychain (unchecked).");
      return ended(why ? "save-failed" : "saved-unchecked");
    }
    checking.show("Saving it in the Keychain…");
    const why = await deps.key.save(k);
    if (why) checking.end("warn", `Couldn't save it in the Keychain: ${why}`);
    else checking.end("done", "Looks good: saved in the Keychain.");
    return ended(why ? "save-failed" : "saved");
  }
}

/** Esc on the key step (or its choice): what's said. */
const keySkipped = (deps: SetupDeps) => (deps.key.has() ? "Kept the key you have." : `Skipped: no key yet. ${COMMAND} keys set openrouter adds one any time, or ${COMMAND} setup asks again.`);

/**
 * The device code flow in a live step, in `kiko login`'s words (account-cli.ts codeWords):
 *
 *   ◒  Free trial
 *   │  First copy your one-time code: WDJB-MJHT
 *   │  Press Enter to open https://account.kiko.sh/device in your browser...
 *   │  By starting the free trial, you agree to Kiko's Terms (kiko.sh/terms) and Privacy Policy (kiko.sh/privacy).
 *   │  enter open · esc back
 *
 * then, once it's open, the code to type there while it waits:
 *
 *   ◒  Free trial
 *   │  Your one-time code: WDJB-MJHT
 *   │  Type it at https://account.kiko.sh/device (open in your browser). Waiting for you to sign in…
 *   │  By starting the free trial, …
 *   │  n new code · esc back
 *
 * Over SSH, the link to open on any device in place of the Enter. n gets a new code at once (once
 * the code is out and waited for); a code that runs out is replaced ("The code ran out; here's a
 * new one."), shown in place of the last with nothing opened again (it's the same page); the server
 * out of reach says "Can't reach kiko.sh, still trying…" until it's back. Esc goes back to the
 * choice (nothing opens). Ends with the step's line, in setup's words (setupSignInLine).
 */
async function signInLive(account: NonNullable<SetupDeps["account"]>, io: Io, run: Run, title: string, trial = false): Promise<SignIn> {
  const stop = new AbortController();
  const newCode = new NewCode();
  /** Enter, while it's waited for. */
  let entered: (() => void) | null = null;
  /**
   * What's shown: asking for the code, Enter waited for, waiting with the page opened (or it
   * couldn't be: "failed"), or over SSH the link; the code and its page; the line said with a
   * renewed code; and whether the server can't be reached now.
   */
  const at: { phase: "asking" | "enter" | "opened" | "failed" | "link"; code: string; url: string; notice: string | null; offline: boolean } = {
    phase: "asking",
    code: "",
    url: "",
    notice: null,
    offline: false,
  };
  // n: a new code once one is out and waited for, or (none yet, the server out of reach) asked again now. Not while Enter is waited for.
  const nWorks = () => at.phase === "opened" || at.phase === "failed" || at.phase === "link" || (at.phase === "asking" && at.offline);
  const step = live(
    io,
    run.liveKeys(
      () => stop.abort(),
      (str, key) => {
        if (key.name === "return" || key.name === "enter") entered?.();
        else if ((key.name === "n" || str === "n" || str === "N") && nWorks()) newCode.ask();
      },
    ),
  );
  const say = codeWords();
  // Signing in (for the trial: starting it) accepts the terms: said by the code, where it's done.
  const agree = dim(agreeLine(trial ? "starting the free trial" : "signing in"));
  const render = () => {
    const notice = at.notice ? [at.notice] : [];
    const offline = at.offline ? [UNREACHABLE_LINE] : [];
    if (at.phase === "asking") return step.show(title, at.offline ? [UNREACHABLE_LINE] : [`Asking ${DOMAIN} for a sign-in code…`], at.offline ? "n try now · esc back" : "esc back");
    if (at.phase === "enter") return step.show(title, [say.code(at.code), say.enter(at.url), agree], "enter open · esc back");
    const waiting = "n new code · esc back";
    if (at.phase === "opened")
      return step.show(
        title,
        [...notice, `Your one-time code: ${at.code}`, `Type it at ${at.url} (open in your browser). ${at.offline ? UNREACHABLE_LINE : "Waiting for you to sign in…"}`, agree],
        waiting,
      );
    if (at.phase === "failed") return step.show(title, [...notice, say.code(at.code), ...say.failed(at.url), ...offline, agree], waiting);
    step.show(title, [...notice, say.code(at.code), say.link(at.url), ...offline, agree], waiting);
  };
  render();
  const ui: CodeUi = {
    code(userCode) {
      at.code = userCode;
      step.show(title, [say.code(userCode), agree], "esc back");
    },
    link(url) {
      Object.assign(at, { phase: "link", url });
      render();
    },
    enter: (url) =>
      new Promise<boolean>((resolve) => {
        if (stop.signal.aborted) return resolve(false);
        Object.assign(at, { phase: "enter", url });
        render();
        const done = (ok: boolean) => {
          entered = null;
          stop.signal.removeEventListener("abort", onAbort);
          resolve(ok);
        };
        const onAbort = () => done(false);
        entered = () => done(true);
        stop.signal.addEventListener("abort", onAbort, { once: true });
      }),
    opened(url, ok) {
      Object.assign(at, { phase: ok ? "opened" : "failed", url });
      render();
    },
    renewed(userCode, why) {
      Object.assign(at, { code: userCode, notice: renewedLine(why) });
      render();
    },
    reach(reached) {
      at.offline = !reached;
      render();
    },
  };
  const r = await account.signIn(ui, stop.signal, newCode);
  if (r.ok) step.end("done", r.email ? `Signed in as ${r.email}` : "Signed in");
  else step.end(r.why === "cancelled" ? "skip" : "warn", setupSignInLine(r));
  return r;
}

/**
 * How a sign-in in setup that didn't go is said, as it lands back on the choice: setup's own words,
 * never `kiko login`'s (Account.signIn's `said` is theirs), picking again getting a new code.
 */
export function setupSignInLine(r: Exclude<SignIn, { ok: true }>): string {
  const minutes = SIGN_IN_FOR_MS / 60_000;
  switch (r.why) {
    case "cancelled":
      return "Sign-in stopped. Pick again to get a new code.";
    case "denied":
    case "refused":
    case "used":
      return "That code was used up or turned down. Pick again to get a new one.";
    case "expired":
      return "The code ran out. Pick again to get a new one.";
    case "timed-out":
      return r.offline ? `Couldn't reach ${DOMAIN} for ${minutes} minutes. Pick again to try once more.` : `Stopped waiting after ${minutes} minutes. Pick again to get a new code.`;
    case "unreachable":
      return `Couldn't reach ${DOMAIN}. Pick again to try once more.`;
    // The Keychain's own lines: nothing about `kiko login` in them.
    case "no-keychain":
    case "save-failed":
      return r.said;
  }
}

/**
 * The account's plan, asked once signed in, before anything else is done with the choice: a plan
 * running the AI (Pro, a trial) is said in its line and the step is done, with no trial started and
 * no key asked; Pro past its month's allowance is said, and your own key offered under it, optional
 * (Esc: on without one). True for either (run.covered set); false with no plan, or the server not
 * reached: the choice goes on as picked.
 */
async function planCovers(deps: SetupDeps, io: Io, run: Run, plan: AccountPlan | null, at: "step" | "end", signed = ""): Promise<boolean> {
  const { say } = run;
  const head = signed ? `${signed} ` : "";
  if (plan?.active) {
    say.aside(`${head}${plan.line}`);
    deps.log("setup_plan", { plan: plan.pro ? "pro" : "trial", ...(at === "end" ? { at } : {}) });
    run.covered = true;
    return true;
  }
  if (!plan?.paused) return false;
  deps.log("setup_plan", { plan: "pro", paused: true, ...(at === "end" ? { at } : {}) });
  run.covered = true;
  say.warn(`${head}${plan.paused}`);
  if (deps.key.has()) {
    say.under(PRO_PAUSED.hasKey);
    return true;
  }
  say.under(PRO_PAUSED.offer);
  if (!deps.key.store) return true;
  await pasteKey(deps, io, run, at, PRO_PAUSED.skipped);
  return true;
}

/** Pro past its month's allowance (planCovers): your own key, offered as optional. */
const PRO_PAUSED = {
  offer: `Until then, your own OpenRouter key can run ${NAME}'s AI. It's optional: paste one, or Esc to go on without.`,
  // A key already (OpenRouter's or Anthropic's: keys.ts hasModel), not named: either runs it.
  hasKey: `Until then, ${NAME} uses your own key.`,
  skipped: `No key added: ${NAME} Pro runs ${NAME}'s AI again once it renews. ${COMMAND} keys set openrouter adds one any time.`,
};

/**
 * How to run Kiko (HOW_TO_RUN), asked first while accounts are open: "own" (on to the key, as
 * ever), "signed-in" (the trial started, or an account signed in: its plan runs the AI, else the key
 * is asked), or null (Esc: skipped, said). Once signed in, whatever was picked, the account's plan
 * comes first (planCovers): one that covers Kiko ends the step there, so a Pro account picking the
 * trial is never sent to the trial or the key. A sign-in that didn't work comes back to the choice;
 * so does a trial the server wouldn't start (said why), without the trial. `signedIn`: signed in
 * already (no plan running): the trial without signing in, and no "I have an account".
 */
async function howToRun(deps: SetupDeps, io: Io, run: Run, signedIn = false, o: { trial?: boolean; pro?: boolean; message?: string; at?: "step" | "end" } = {}): Promise<"own" | "signed-in" | null> {
  const { ui, ask, say } = run;
  const account = deps.account!;
  const at = o.at ?? "step";
  // No trial to offer (the account had one): the choice opens on your own key.
  let trialRefused = o.trial === false;
  // Kiko Pro, while it's on sale (and the account isn't on it already).
  let pro = Boolean(account.upgrade) && o.pro !== false;
  for (let picked = trialRefused ? "own" : "trial"; ; ) {
    const options = [
      ...(trialRefused ? [] : [{ value: "trial", label: signedIn ? HOW_TO_RUN.trialSignedIn : HOW_TO_RUN.trial }]),
      ...(pro ? [{ value: "pro", label: HOW_TO_RUN.pro }] : []),
      { value: "own", label: HOW_TO_RUN.own },
      ...(signedIn ? [] : [{ value: "account", label: HOW_TO_RUN.account }]),
    ];
    const how: string | null = await ask(
      p.select<string>({
        ...ui,
        // Signed in already, picking the trial starts it right here: the terms said under the question.
        message: `${o.message ?? `${HOW_TO_RUN.question}\n${dim(HOW_TO_RUN.why)}`}${signedIn && !trialRefused ? `\n${dim(agreeLine("starting the free trial"))}` : ""}`,
        options,
        initialValue: options.some((o) => o.value === picked) ? picked : options[0].value,
      }),
    );
    if (how === null) {
      deps.log("setup_account", { choice: "skipped", ...(at === "end" ? { at } : {}) });
      // At the end, what to do is said under it (needKey).
      if (at === "step") say.skipped(keySkipped(deps));
      return null;
    }
    if (how === "own") {
      deps.log("setup_account", { choice: "own", ...(at === "end" ? { at } : {}) });
      return "own";
    }
    picked = how;
    if (!signedIn) {
      const r = await signInLive(account, io, run, how === "trial" ? "Free trial" : how === "pro" ? `${NAME} Pro` : "Sign in", how === "trial");
      run.quitIfAsked();
      deps.log("setup_account", { choice: how, ended: r.ok ? "signed-in" : r.why });
      if (!r.ok) continue;
      signedIn = true;
    } else deps.log("setup_account", { choice: how, ended: "signed-in-already" });
    // The account's plan first, whatever was picked: Pro (or a trial running) needs no trial and no key.
    const plan = await account.plan();
    if (await planCovers(deps, io, run, plan, at)) return "signed-in";
    if (how === "trial") {
      // The trial itself (the server's checks: one per mailbox, no throwaway email…).
      const t = await account.startTrial();
      deps.log("setup_trial", { ended: t.ok ? "started" : (t.code ?? "failed") });
      if (t.ok) {
        say.aside(t.said);
        return "signed-in";
      }
      // On a plan after all (the server said so, though the plan wasn't known a moment ago): its line, no key.
      if (t.code === "has_plan" && (await planCovers(deps, io, run, await account.plan(), at))) return "signed-in";
      // Not started: why, and back to the choice, signed in, without the trial (your own key first).
      say.warn(t.said);
      trialRefused = true;
      picked = "own";
      continue;
    }
    if (how === "pro") {
      const ended = await buyPro(deps, io, run, plan);
      if (ended === "on") return "signed-in";
      // Not on sale after all (the server isn't set up for it): the choice without it.
      if (ended === "unavailable") pro = false;
      // Stopped (Esc), or it didn't go: back to the choice, your own key first.
      picked = "own";
      continue;
    }
    // An account you have, with no plan (planCovers above): your own key runs the AI.
    say.aside(ACCOUNT_NO_PLAN.signedIn(deps.key.has()));
    if (!deps.key.has()) await pasteKey(deps, io, run, at, at === "step" ? keySkipped(deps) : null);
    return "signed-in";
  }
}

/**
 * Kiko Pro, picked in the choice (signed in by now): monthly or yearly, then `kiko upgrade`'s
 * checkout in a live step:
 *
 *   ◒  Kiko Pro
 *   │  Opening checkout in your browser… (Enter if it didn't open)
 *   │  Waiting for payment… Esc to stop waiting (you can still pay; Kiko picks it up)
 *   │  enter open again · esc stop waiting
 *
 * ending "◇ Kiko Pro is on. Renews 3 Dec. Manage it any time: kiko account billing". Over SSH, the
 * link to open on any device in place of the browser. "on": Pro runs the AI now; "unavailable":
 * not on sale on the server; "stopped": Esc (on the plan's question or the wait), or it didn't go.
 */
async function buyPro(deps: SetupDeps, io: Io, run: Run, plan: AccountPlan | null): Promise<"on" | "unavailable" | "stopped"> {
  const { ui, ask, say } = run;
  const account = deps.account!;
  // On Pro already (bought on another Mac, say), as just asked (howToRun): nothing to buy.
  if (plan?.pro) {
    say.aside(plan.line);
    return "on";
  }
  const picked = await ask(proPlanPrompt(ui));
  run.quitIfAsked();
  if (picked === null) return "stopped";
  const title = `${NAME} Pro`;
  const stop = new AbortController();
  /** Enter, while the payment is waited for. */
  let pressed: ((key: "enter" | "esc") => void) | null = null;
  const step = live(
    io,
    run.liveKeys(
      () => (pressed ? pressed("esc") : stop.abort()),
      (_str, key) => {
        if (key.name === "return" || key.name === "enter") pressed?.("enter");
      },
    ),
  );
  let lines: string[] = [];
  step.show(title, [`Asking ${DOMAIN} for a checkout…`], "esc cancel");
  const end = await account.upgrade!(
    picked,
    {
      opened(url, ok, again) {
        if (again && ok) return;
        lines = ok ? [UPGRADE_WORDS.opening] : [UPGRADE_WORDS.failed(url)];
        step.show(title, lines, "esc cancel");
      },
      link(url) {
        lines = [UPGRADE_WORDS.link(url)];
        step.show(title, lines, "esc cancel");
      },
      waiting: () => step.show(title, [...lines, UPGRADE_WORDS.waiting], "enter open again · esc stop waiting"),
      keys(on) {
        pressed = on;
        return () => {
          pressed = null;
        };
      },
    },
    stop.signal,
  );
  deps.log("setup_pro", { ended: end.ok ? "on" : end.why });
  if (end.ok) {
    step.end("done", UPGRADE_WORDS.on(end.plan));
    return "on";
  }
  if (end.why === "already-pro") {
    step.end("done", end.said);
    return "on";
  }
  if (end.why === "stopped") step.end("skip", end.said);
  else step.end("warn", end.said);
  return end.why === "billing-unavailable" ? "unavailable" : "stopped";
}

/** Kiko Pro's plan question, in setup's look (Clack's select, monthly first): setup's choice and `kiko upgrade` both ask it. */
function proPlanPrompt(ui: { input: Io["input"]; output: Io["output"] }) {
  return p.select<"month" | "year">({
    ...ui,
    // Picking a plan opens its checkout: subscribing accepts the terms, Kiko Pro's included.
    message: `${UPGRADE_WORDS.question}\n${dim(UPGRADE_WORDS.under)}\n${dim(PRO_AGREE)}`,
    options: PRO_CHOICES.map((c) => ({ value: c.interval, label: c.label })),
    initialValue: "month",
  });
}

/**
 * `kiko upgrade`'s plan question, outside setup, as setup asks it (proPlanPrompt):
 *
 *   ◆  Which Kiko Pro plan?
 *   │  Kiko's AI included · tax included
 *   │  ● $8.99 a month
 *   │  ○ $89 a year (about 2 months free)
 *   └
 *
 * Esc (or Ctrl+C, as in setup: Clack can't tell them apart) is none, said dim right under it as a
 * skipped step is, with how to come back to it. Its keys decoded as setup decodes them (live.ts
 * decodeKeys), so an Esc takes as long as there. The terminal's raw mode is Clack's, off once answered.
 */
export async function askProPlan(io: Io): Promise<"month" | "year" | null> {
  decodeKeys(io.input);
  const ui = { input: io.input, output: io.output };
  const v = await proPlanPrompt(ui);
  if (!p.isCancel(v)) return v;
  p.log.message(dim(`Nothing changed: ${COMMAND} upgrade asks again.`), { ...ui, spacing: 0 });
  return null;
}

async function keyStep(deps: SetupDeps, io: Io, run: Run) {
  const { say } = run;
  if (deps.account && deps.key.store) {
    const who = deps.account.signedIn();
    if (who === null) {
      if ((await howToRun(deps, io, run)) !== "own") return;
    } else {
      const signed = `Signed in${who ? ` as ${who}` : ""}.`;
      const plan = await deps.account.plan();
      // Its plan runs the AI (or is Pro past its month's allowance: your own key optional): no key needed.
      if (await planCovers(deps, io, run, plan, "step", signed)) return;
      // No plan: the trial offered if the account never had one, and Kiko Pro while it's on sale,
      // without signing in again.
      const trial = plan ? !plan.hadTrial && !plan.pro : false;
      if (plan && (trial || (deps.account.upgrade && !plan.pro))) {
        say.aside(`${signed} ${COMMAND} logout signs out.`);
        if ((await howToRun(deps, io, run, true, { trial, pro: !plan.pro })) !== "own") return;
      } else say.aside(`${signed} ${COMMAND} logout signs out.`);
    }
  }
  say.info(KEY_INTRO);
  if (!deps.key.store) {
    deps.log("setup_key", { at: "step", ended: "no-keychain" });
    return say.warn(NO_KEYCHAIN);
  }
  // Shown with a key there only by --all: Esc keeps it.
  await pasteKey(deps, io, run, "step", keySkipped(deps));
}

/**
 * The last step with no model key yet: the app can't answer without one, so it's asked for right
 * there (the key step's ask), or Esc says exactly how to add it later. True once there's one.
 */
async function needKey(deps: SetupDeps, io: Io, run: Run): Promise<boolean> {
  const { say } = run;
  if (deps.account && deps.key.store) return chooseModel(deps, io, run);
  say.warn(NEEDS_KEY);
  // Signed in, with no plan running: said, so the ask isn't a surprise.
  if (deps.account?.signedIn() != null) say.under(ACCOUNT_NO_PLAN.end);
  // A key kept there may be what's missing: said, so pasting it again isn't a mystery.
  if (deps.key.unread) say.under(`(The Keychain couldn't be read: ${deps.key.unread})`);
  if (!deps.key.store) {
    deps.log("setup_key", { at: "end", ended: "no-keychain" });
    say.under(NO_KEYCHAIN);
  } else if (["saved", "saved-unchecked"].includes(await pasteKey(deps, io, run, "end", null)) && deps.key.has()) return true;
  // The ask was skipped (Esc) or the key not saved: the rail's line is there already.
  io.output.write(`${styleText("gray", p.S_BAR_END)}  ${NO_KEY_TODO}\n\n`);
  return false;
}

/**
 * needKey while accounts are open: no key and no plan running (signed out, or the trial ended), so
 * the app can't answer. The choice, as setup's first one (howToRun), in place of the key ask alone:
 *
 *   ▲  Kiko can't answer yet: it needs an AI model, and there's no key or plan to run one.
 *   ◆  How do you want to run Kiko?
 *   │  ● Free trial: 7 days, no card (needs a free account)
 *   │  ○ Kiko Pro: $8.99 a month, Kiko's AI included      (while Pro is on sale)
 *   │  ○ My own OpenRouter key: no account needed
 *   │  ○ I have an account: sign in
 *
 * The trial ended (signed in): Kiko Pro and your own key, your own key first; with Pro not on sale,
 * straight to the key.
 * Signed in: the plan asked first (planCovers): one running the AI after all, or Pro past its
 * month's allowance (said, your own key optional), goes on to the app with nothing more asked. Else
 * who, and the plan's line (the trial ended, say), with no "I have an account"; the trial only while
 * the account never had one. True once something runs the AI (a key saved, a trial started, a plan
 * found); Esc says exactly what to do.
 */
async function chooseModel(deps: SetupDeps, io: Io, run: Run): Promise<boolean> {
  const { say } = run;
  const account = deps.account!;
  const who = account.signedIn();
  let trial = true;
  // Kiko Pro while it's on sale, unless the account is on it already.
  let pro = Boolean(account.upgrade);
  const signed = who !== null ? `Signed in${who ? ` as ${who}` : ""}.` : "";
  const plan = who !== null ? await account.plan() : null;
  // The plan first: one running after all (started from another Mac, or account.json was behind)
  // goes on to the app; Pro past its month's allowance is said, your own key optional, and on too.
  if (who !== null && (await planCovers(deps, io, run, plan, "end", signed))) return true;
  say.warn(NO_MODEL_YET);
  if (who !== null) {
    say.under(`${signed}${plan ? ` ${plan.line}` : ""}`);
    // The server not reached: the trial offered all the same (it says if this email had one).
    trial = !plan?.hadTrial && !plan?.pro;
    if (plan?.pro) pro = false;
  }
  // Signed in, the trial had and no Pro to offer: your own key is all that's left, so it's asked for straight away.
  const how = who !== null && !trial && !pro ? "own" : await howToRun(deps, io, run, who !== null, { trial, pro, at: "end" });
  run.quitIfAsked();
  if (how === "own" && ["saved", "saved-unchecked"].includes(await pasteKey(deps, io, run, "end", null))) return deps.key.has();
  if (how === "signed-in" && (deps.key.has() || run.covered)) return true;
  io.output.write(`${styleText("gray", p.S_BAR_END)}  ${NO_MODEL_TODO}\n\n`);
  return false;
}

// ── Microphone ─────────────────────────────────────────────────────────
/** What a skipped mic test says. */
const MIC_LATER = `${NAME} listens only while you hold the talk key. ${COMMAND} setup comes back to the microphone.`;

/** No input device: say so plainly; Try again (one plugged in) or skip. True once there's one. */
async function waitForMic(deps: SetupDeps, run: Run): Promise<boolean> {
  const { ui, ask, say } = run;
  for (let tries = 0; ; tries++) {
    say.warn(tries ? "Still no microphone." : NO_MIC);
    const choice = await ask(
      p.select({
        ...ui,
        message: "Microphone:",
        options: [
          { value: "again", label: "Try again", hint: "once one's plugged in" },
          { value: "skip", label: "Skip", hint: phoneLive() ? "talk through the iPhone app" : "set it up later" },
        ],
      }),
    );
    if (choice !== "again") {
      run.noMic = true;
      say.skipped(`Skipped the microphone, and the talk key with it. ${COMMAND} setup comes back to both once one's plugged in.`);
      return false;
    }
    const inputs = await deps.micInputs();
    if (inputs === null || inputs.length) return true;
  }
}

/** The mic permission, asked or turned on: true once granted. */
async function micAllowed(deps: SetupDeps, io: Io, run: Run): Promise<boolean> {
  const { ui, ask, say, app } = run;
  let perm = deps.permissions.initial.mic;
  if (perm === "unknown") {
    const go = await ask(
      p.select({
        ...ui,
        message: `Microphone: macOS asks whether ${app} may use it.`,
        options: [
          { value: "ask", label: "Ask now", hint: "choose Allow" },
          { value: "skip", label: "Skip" },
        ],
      }),
    );
    if (go !== "ask") return false;
    const waiting = live(io);
    waiting.show("Waiting for your answer to macOS… (its dialog may be behind this window)");
    perm = await deps.permissions.request("mic");
    if (perm === "granted") waiting.end("done", "The microphone is allowed.");
    else waiting.end("warn", "Not allowed.");
  }
  if (perm === "granted") return true;
  say.warn(`The microphone is off for ${app}. Turn it on in ${whereToTurnOn(deps.permissions.pane("mic"), deps.app)}.`);
  for (let looked = false; perm !== "granted"; ) {
    const choice = await ask(
      p.select({
        ...ui,
        message: "Then:",
        options: [
          { value: "open", label: "Open System Settings" },
          { value: "check", label: "Check again" },
          { value: "skip", label: "Skip" },
        ],
        initialValue: looked ? "check" : "open",
      }),
    );
    if (choice === null || choice === "skip") return false;
    looked = true;
    if (choice === "open") {
      deps.permissions.open("mic");
      continue;
    }
    if (deps.ownApp) await deps.permissions.refresh?.();
    perm = (await deps.permissions.status()).mic;
    if (perm !== "granted")
      say.warn(
        deps.ownApp
          ? `Still off: turn on ${app} in ${whereToTurnOn(deps.permissions.pane("mic"), deps.app)}.`
          : `Still off. If it's on in System Settings, quit and reopen ${app}, then run ${deps.resume.command}.`,
      );
  }
  return true;
}

/**
 * "Say something…" with the level moving, for micMs. `using`: the mic it listens on, by name, said
 * under it when the Mac has more than one (null: one, or it can't be told).
 */
function listenOnce(deps: SetupDeps, io: Io, run: Run, using: string | null): Promise<MicHeard | null> {
  return new Promise((resolve) => {
    let levels: number[] = Array(METER_LENGTH).fill(0);
    let heard = "";
    let over = false;
    const show = () => step.show(`Say something…  ${styleText("red", bars(levels))}`, [...(using ? [`Listening on ${using}`] : []), ...(heard ? [`heard: “${heard}”`] : [])], "esc skip");
    const step: Live = live(
      io,
      run.liveKeys(() => {
        if (over) return;
        over = true;
        step.end("skip", "Mic test skipped.");
        resolve(null);
      }),
    );
    show();
    void deps
      .micTest(
        deps.micMs ?? 5000,
        (level) => {
          levels = pushLevel(levels, level);
          if (!over) show();
        },
        (text) => {
          heard = text;
          if (!over) show();
        },
      )
      .then(
        (result) => {
          if (over) return;
          over = true;
          const words = result.heard || heard;
          if (result.noDevice) step.end("warn", "No microphone to listen with.");
          else if (words) step.end("done", `The mic works: it heard “${words}”.`);
          else if (result.peak >= 0.2) step.end("done", "The mic hears you.");
          // With another mic to pick, the choice is right under it: no pointer to Settings.
          else step.end("warn", `Almost no sound came in: is it the right mic, and not muted?${using ? "" : " (Settings → Listening picks the mic.)"}`);
          resolve({ ...result, heard: words });
        },
        () => {
          if (over) return;
          over = true;
          step.end("warn", "The mic didn't start.");
          resolve({ peak: 0, heard: "" });
        },
      );
  });
}

/**
 * Another mic, from the Mac's inputs as Settings → Listening lists them (the system default first),
 * kept as it keeps it. Esc keeps the one there. True once one is picked.
 */
async function pickMic(deps: SetupDeps, run: Run, inputs: MicDevice[]): Promise<boolean> {
  const { ui, ask } = run;
  const current = deps.micPick.current();
  const picked = await ask(p.select({ ...ui, message: "Which mic?", options: micChoices(inputs, current), initialValue: current?.uid ?? "" }));
  if (picked === null) return false;
  deps.micPick.save(picked, inputs);
  deps.log("setup_mic", { picked: picked ? (inputs.find((d) => d.uid === picked)?.name ?? picked) : "system default" });
  return true;
}

async function micStep(deps: SetupDeps, io: Io, run: Run) {
  const { ui, ask, say } = run;
  let inputs = await deps.micInputs();
  if (inputs && !inputs.length && !(await waitForMic(deps, run))) return;
  if (!(await micAllowed(deps, io, run))) return say.skipped(MIC_LATER);
  for (;;) {
    // None when setup looked (one plugged in since: waitForMic): looked at again, to name it.
    if (!inputs?.length) inputs = await deps.micInputs();
    // More than one input: the one it listens on, named (the one chosen, else the system default).
    const many = inputs && inputs.length > 1 ? inputs : null;
    const using = many ? (resolveMic(deps.micPick.current(), many).device?.name ?? null) : null;
    const r = await listenOnce(deps, io, run, using);
    run.quitIfAsked();
    if (!r) return say.skipped(MIC_LATER);
    if (r.noDevice) {
      if (!(await waitForMic(deps, run))) return;
      inputs = null;
      continue;
    }
    if (r.peak >= 0.2 || r.heard) return deps.done("mic");
    for (;;) {
      const again = await ask(
        p.select({
          ...ui,
          message: "Try it again?",
          options: [{ value: "again", label: "Try again" }, ...(many ? [{ value: "other", label: "Use another mic" }] : []), { value: "on", label: "Go on" }],
        }),
      );
      if (again !== "other") {
        if (again !== "again") return;
        break;
      }
      // The inputs as they are now (one plugged in meanwhile), then the test again on the one picked.
      inputs = (await deps.micInputs()) ?? many;
      if (await pickMic(deps, run, inputs?.length ? inputs : many!)) break;
    }
  }
}

// ── The talk key ───────────────────────────────────────────────────────
const menuLine = (deps: SetupDeps) => `${deps.talkKey.menu} opens ${NAME}'s menu in its window (no permission needed).`;

/**
 * The terminal app must be reopened (the helper app is restarted by itself instead: then Input
 * Monitoring is still off for it): said with the exact command, and the next setup starts here.
 */
function reopenFirst(deps: SetupDeps, run: Run, why: string) {
  const { say, app } = run;
  deps.resume.save("talkKey");
  deps.log("setup_input_monitoring", { how: deps.ownApp ? "still off" : "reopen", why });
  if (deps.ownApp)
    say.warn(
      `Input Monitoring isn't on for ${app} yet: turn it on in ${whereToTurnOn(deps.permissions.pane("input"), deps.app)}, then run:\n  ${deps.resume.command}\nSetup picks up at the talk key. ${quitAndReopenLine(app)}`,
    );
  else say.warn(`Input Monitoring takes effect once ${app} is reopened: quit it (⌘Q), open it again, and run:\n  ${deps.resume.command}\nSetup picks up at the talk key.`);
}

/** The helper app started again, so Input Monitoring just turned on lets the talk key in (no "Quit & Reopen"). */
async function refreshForInput(deps: SetupDeps) {
  if (!deps.ownApp || !deps.permissions.refresh) return;
  const ok = await deps.permissions.refresh().catch(() => false);
  deps.log("setup_input_monitoring", { how: "relaunched", ok });
}

/** Waits for Input Monitoring to be turned on (a fresh look each time): "on", "reopen" (Enter, still off), or null (skipped). */
function waitForInput(deps: SetupDeps, io: Io, run: Run): Promise<"on" | "reopen" | null> {
  const { app } = run;
  const started = Date.now();
  return new Promise((resolve) => {
    let over = false;
    let looking = false;
    const finish = (how: "on" | "reopen" | null) => {
      if (over) return;
      over = true;
      clearInterval(poll);
      if (how === "on") step.end("done", "Input Monitoring is on.");
      else if (how === "reopen") step.end("warn", `Input Monitoring is still off for ${app}.`);
      else step.end("skip", "Input Monitoring skipped.");
      if (how === "on") deps.log("setup_input_monitoring", { how: "on", waitedMs: Date.now() - started });
      resolve(how);
    };
    const look = async () => {
      if (looking || over) return;
      looking = true;
      const now = await deps.permissions.status();
      looking = false;
      if (now.input === "granted") finish("on");
    };
    const step: Live = live(
      io,
      run.liveKeys(
        () => finish(null),
        (str, key) => {
          if (str === "o") deps.permissions.open("input");
          else if (key.name === "return")
            void (deps.ownApp ? refreshForInput(deps) : Promise.resolve()).then(() => deps.permissions.status()).then((now) => finish(now.input === "granted" ? "on" : "reopen"));
        },
      ),
    );
    step.show(
      `Waiting for Input Monitoring: turn on ${app} in System Settings → ${deps.permissions.pane("input")}.`,
      [...(deps.ownApp ? [quitAndReopenLine(app)] : []), "Turned it on and still waiting? Press Enter."],
      "o open System Settings · enter it's on · esc skip",
    );
    const poll = setInterval(() => void look(), deps.pollMs ?? 1000);
  });
}

/** Press the key once (c picks another): "pressed", "failed" (the helper can't listen: why), or null (skipped). */
function pressOnce(deps: SetupDeps, io: Io, run: Run): Promise<{ how: "pressed" } | { how: "failed"; why: string } | null> {
  return new Promise((resolve) => {
    let over = false;
    let capturing = false;
    let note = "";
    let stopListening = () => {};
    const finish = (r: { how: "pressed" } | { how: "failed"; why: string } | null) => {
      if (over) return;
      over = true;
      stopListening();
      const label = deps.talkKey.label();
      if (r?.how === "pressed") step.end("done", `${label} works. Hold it to talk.`, note ? [note] : []);
      else if (r?.how === "failed") step.end("warn", `${NAME} can't hear ${label} yet.`);
      else step.end("skip", "Talk key skipped.");
      resolve(r);
    };
    const listen = () => {
      stopListening = deps.talkKey.listen(
        () => finish({ how: "pressed" }),
        (why) => finish({ how: "failed", why }),
      );
      step.show(`Press ${deps.talkKey.label()} once.`, [...(note ? [note] : []), menuLine(deps)], "c pick another key · esc skip");
    };
    const step: Live = live(
      io,
      run.liveKeys(
        () => finish(null),
        (str) => {
          if (str !== "c" || capturing) return;
          capturing = true;
          stopListening();
          stopListening = () => {};
          note = "";
          step.show("Press the key you want to hold while talking…", [], "esc skip");
          void deps.talkKey.capture().then(
            (name) => {
              capturing = false;
              if (over) return;
              deps.talkKey.save(name);
              if (!deps.talkKey.quiet(name)) note = `${deps.talkKey.labelOf(name)} also types into the app in front while you hold it: c picks another.`;
              listen();
            },
            () => {
              capturing = false;
              if (!over) listen();
            },
          );
        },
      ),
    );
    listen();
  });
}

async function talkKeyStep(deps: SetupDeps, io: Io, run: Run) {
  const { ui, ask, say, app } = run;
  // No microphone: skipped with it (said there).
  if (run.noMic) return;
  const later = `Skipped the talk key. ${COMMAND} setup comes back to it.`;
  let input = deps.permissions.initial.input;
  if (input !== "granted") {
    const key = deps.talkKey.label();
    say.note(
      `Hold ${key} to talk, from any app. To notice that key while another app is in front, macOS needs Input Monitoring for ${app}. Its prompt says ${app} wants keystrokes from any app: ${app} only watches ${key}, and never reads or keeps anything you type.`,
    );
    p.log.message(run.fit(menuLine(deps), dim), { ...ui, spacing: 0 });
    const go = await ask(
      p.select({
        ...ui,
        message: `Let ${app} hear ${key} from any app?`,
        options: [
          { value: "on", label: "Turn it on", hint: `macOS asks, then System Settings opens: switch ${app} on` },
          { value: "skip", label: "Skip", hint: `${COMMAND} setup comes back to it` },
        ],
      }),
    );
    if (go !== "on") {
      deps.resume.save(null);
      return say.skipped(later);
    }
    // macOS's prompt (it puts the app in the list); asked before, it shows nothing: the pane then.
    input = await deps.permissions.request("input");
    if (input !== "granted") {
      deps.permissions.open("input");
      const on = await waitForInput(deps, io, run);
      run.quitIfAsked();
      if (on === null) {
        deps.resume.save(null);
        return say.skipped(later);
      }
      if (on === "reopen") return reopenFirst(deps, run, "still off after Enter");
      await refreshForInput(deps);
    }
  }
  let r = await pressOnce(deps, io, run);
  run.quitIfAsked();
  // Its tap not let in yet: the helper app started again once, and the key tried again.
  if (r?.how === "failed" && deps.ownApp && deps.permissions.refresh) {
    deps.log("setup_input_monitoring", { how: "retry", why: r.why });
    await refreshForInput(deps);
    r = await pressOnce(deps, io, run);
    run.quitIfAsked();
  }
  if (r === null) {
    deps.resume.save(null);
    return say.skipped(later);
  }
  if (r.how === "failed") return reopenFirst(deps, run, r.why);
  deps.resume.save(null);
  deps.done("talkKey");
}

// ── Its name ───────────────────────────────────────────────────────────
async function nameStep(deps: SetupDeps, _io: Io, run: Run) {
  const { ui, ask, say } = run;
  const current = deps.name.current();
  say.aside(`What you call it hands-free: “${current}, ask pixie if the tests pass”.`);
  const typed = await ask(p.text({ ...ui, message: "What do you want to call it?", placeholder: current, defaultValue: current }));
  if (typed === null) return say.skipped(`Skipped: it stays ${current}. Settings → Listening changes it any time.`);
  const kept = deps.name.save(typed.trim() || current);
  deps.done("name");
  const warning = deps.name.warning(kept);
  if (warning) say.warn(`${warning} Kept anyway: Settings → Listening changes it any time.`);
}

// ── Its voice ──────────────────────────────────────────────────────────
/**
 * Pocket still downloading: waited for, how far along shown, so the hello is in the voice that
 * will speak. Esc: the Mac voice for now (Pocket goes on; the app switches once it's there).
 * Failed: one line, the Mac voice, why in the log.
 */
async function waitForVoice(deps: SetupDeps, io: Io, run: Run) {
  const { say } = run;
  const first = await deps.hello.voice();
  const started = Date.now();
  const logEnd = (ended: "ready" | "later" | "failed", now: PrepNow) =>
    deps.log("setup_voice", { ended, percent: Math.floor(now.fraction * 100), waitedMs: Date.now() - started, ...(ended === "failed" ? { why: now.why ?? "" } : {}) });
  if (first.state === "failed") {
    logEnd("failed", first);
    return say.warn(VOICE_WORDS.failed);
  }
  if (first.state !== "running") return;
  await new Promise<void>((resolve) => {
    let over = false;
    let last = first;
    const finish = (ended: "ready" | "later" | "failed", now: PrepNow) => {
      if (over) return;
      over = true;
      if (ended === "ready") step.end("done", VOICE_WORDS.ready);
      else if (ended === "later") step.end("skip", VOICE_WORDS.later);
      else step.end("warn", VOICE_WORDS.failed);
      logEnd(ended, now);
      resolve();
    };
    const step: Live = live(
      io,
      run.liveKeys(() => finish("later", last)),
    );
    const draw = (now: PrepNow) => step.show(VOICE_WORDS.waiting, [`${voiceBar(now.fraction)}  ${now.phase === "voice" ? VOICE_WORDS.voice : VOICE_WORDS.install}`], VOICE_WORDS.hint);
    draw(first);
    const look = async () => {
      if (over) return;
      const now = await deps.hello.voice();
      if (over) return;
      last = now;
      if (now.state === "running") {
        draw(now);
        setTimeout(() => void look(), deps.pollMs ?? 1000);
      } else finish(now.state === "ready" ? "ready" : "failed", now);
    };
    setTimeout(() => void look(), deps.pollMs ?? 1000);
  });
}

async function voiceStep(deps: SetupDeps, io: Io, run: Run) {
  const { ui, ask, say } = run;
  // Waited for once: a replay after Esc doesn't wait again (it's Pocket if it's ready by then).
  await waitForVoice(deps, io, run);
  run.quitIfAsked();
  for (;;) {
    const text = helloText(deps.talkKey.label(), deps.name.current());
    await new Promise<void>((resolve) => {
      let over = false;
      const step: Live = live(
        io,
        run.liveKeys(() => {
          if (over) return;
          over = true;
          step.end("skip", "Hello skipped.");
          resolve();
        }),
      );
      step.show(`${deps.name.current()} is saying hello…`, [], "esc skip");
      const said = () => {
        if (over) return;
        over = true;
        step.end("done", `${deps.name.current()} said hello.`);
        resolve();
      };
      void deps.hello.say(text).then(said, said);
    });
    run.quitIfAsked();
    const heard = await ask(
      p.select({
        ...ui,
        message: "Did you hear it?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "again", label: "Play it again" },
          { value: "no", label: "No" },
        ],
      }),
    );
    if (heard === null) return say.skipped(`Skipped. ${COMMAND} setup says hello again.`);
    if (heard === "yes") return deps.done("hello");
    if (heard === "no") {
      say.warn("Check the Mac's sound: the volume, and the output in Control Centre → Sound.");
      const again = await ask(
        p.select({
          ...ui,
          message: "Then:",
          options: [
            { value: "again", label: "Play it again" },
            { value: "on", label: "Go on" },
          ],
        }),
      );
      if (again !== "again") return;
    }
  }
}

// ── What to try ────────────────────────────────────────────────────────
/** The wrap-up: a model key if there's none yet, what to try, and the app opened now or later. `alone`: the only step this time. */
async function wrapUp(deps: SetupDeps, io: Io, run: Run, alone: boolean): Promise<SetupEnd> {
  const { ui, ask, say } = run;
  // No model key (the key step skipped, or not saved): nothing to open, unless it's pasted now.
  // A plan found to cover it (run.covered: Pro past its allowance, your own key offered already) asks nothing more.
  if (!deps.key.has() && !run.covered) {
    if (!(await needKey(deps, io, run))) return "no-key";
  } else if (alone) say.aside(`Everything's set up. To see every step again: ${COMMAND} setup --all`);
  // Pocket still downloading (Esc on the voice step, or no voice step this time): how far, in a line.
  const voice = await deps.hello.voice();
  if (voice.state === "running") say.aside(VOICE_WORDS.stillGoing(voice.fraction));
  p.note(
    deps
      .tryLines()
      .map((t) => `• ${t}`)
      .join("\n"),
    "What to try",
    ui,
  );
  const go = await ask(p.confirm({ ...ui, message: `${deps.end.label} now?`, active: deps.end.label, inactive: "Later", initialValue: true }));
  if (go) {
    p.outro(`${deps.end.label}…`, ui);
    return "open";
  }
  // Skipped (Esc): the prompt left the rail's line already.
  if (go === null) io.output.write(`${styleText("gray", p.S_BAR_END)}  ${deps.end.later}\n\n`);
  else p.outro(deps.end.later, ui);
  return "later";
}
