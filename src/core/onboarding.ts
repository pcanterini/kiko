// First-run setup (`kiko setup`, and the first start with nothing set up: start.ts): which steps
// to show, and their words. One thing per step, each skippable, the ones done already left out:
//
//   agents    the coding agents found, connected after a yes (agents/setup.ts, the first-run card's code)
//   key       one OpenRouter key, checked on the spot and kept in the Keychain; left out with a model key.
//             While accounts are open (core/env.ts accountsLive), it first asks how to run Kiko: the
//             free trial, your own key (no account), or an account you have; left out signed in too
//   mic       is there one at all (no: said plainly, and the talk key skipped too), macOS's
//             microphone prompt, then "say something" with a level bar
//   talkKey   the talk key pressed once (Input Monitoring first, when it's missing: waited for as it's
//             turned on, or, when the terminal app must be reopened, the next setup picks up here), or another picked
//   name      what you call it (the spokenName setting), the default typed in already
//   hello     it says hello in its voice, by that name: the speaker works. Pocket, still downloading,
//             is waited for (how far along shown; Esc: the Mac voice for now)
//   try       what to try first, in four lines, then the app; with no model key yet, the key asked
//             for first (the app can't answer without one), or how to add it later, and no app
//
// The steps on screen are ui/onboarding.ts; what they do is ../onboard.ts. Nothing here touches the Mac.
import type { CardRow } from "../agents/setup.ts";
import type { Permission } from "../platform/types.ts";
import { shellWord } from "./shell.ts";
import { phoneLive } from "./env.ts";
import { COMMAND, NAME, PRO_PRICE, spokenName } from "./name.ts";
import type { PrepState } from "./pocket-prep.ts";

export type StepId = "agents" | "key" | "mic" | "talkKey" | "name" | "hello" | "try";

/** The steps that can be marked done (setupDone in the settings); `agents` and `key` are known by what's there. */
export const DONE_STEPS = ["mic", "talkKey", "name", "hello"] as const;
export type DoneStep = (typeof DONE_STEPS)[number];

/** What decides which steps show. */
export type SetupFacts = {
  /** The agents card's rows (agents/setup.ts cardRows): null when there's no agent to offer. */
  agents: CardRow[] | null;
  /** An OpenRouter or Anthropic key is there (environment, .env or the Keychain). */
  modelKey: boolean;
  /** Signed in to a Kiko account (accounts open: core/account/): the key step's choice is made already. */
  signedIn?: boolean;
  mic: Permission;
  /** Input Monitoring, for the talk key. */
  input: Permission;
  /** The steps finished before (setupDone). */
  done: readonly string[];
  /** Where the last setup asked to pick up (setupResume: the talk key, once the terminal app is reopened). */
  resume?: StepId | null;
};

const ORDER: readonly StepId[] = ["agents", "key", "mic", "talkKey", "name", "hello", "try"];

/**
 * The steps to show, in order. Left out: agents with none to offer, the key with a model key there
 * (or signed in to an account: the last step still asks for a key while the account's AI isn't there),
 * the mic and the talk key once done with their permission granted, the name once kept, hello once heard. `all` (`kiko
 * setup --all`): every step, done or not (agents still only with one found). The last is always `try`.
 * `resume` (not with `all`): that step first, then only the ones after it.
 */
export function stepsFor(f: SetupFacts, all = false): StepId[] {
  const steps: StepId[] = [];
  if (f.agents) steps.push("agents");
  if (all || (!f.modelKey && !f.signedIn)) steps.push("key");
  if (all || f.mic !== "granted" || !f.done.includes("mic")) steps.push("mic");
  if (all || f.input !== "granted" || !f.done.includes("talkKey")) steps.push("talkKey");
  if (all || !f.done.includes("name")) steps.push("name");
  if (all || !f.done.includes("hello")) steps.push("hello");
  steps.push("try");
  if (all || !f.resume || f.resume === "try" || !ORDER.includes(f.resume)) return steps;
  const from = ORDER.indexOf(f.resume);
  return [f.resume, ...steps.filter((s) => ORDER.indexOf(s) > from)];
}

/**
 * Why setup is short, in a line: the steps of these left out because they're set up already
 * (`left`). Null when none was left out (setup --all, a first install).
 */
export function carriedLine(left: { agents: boolean; key: boolean; account?: boolean; talkKey: boolean }): string | null {
  const names = [left.agents && "agents", left.key && "key", left.account && "account", left.talkKey && "talk key"].filter((n): n is string => Boolean(n));
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const many = names.length > 1 || names[0] === "agents";
  return `Your ${list} ${many ? "are" : "is"} set up already.`;
}

/** setupDone with `step` added. */
export const withDone = (done: unknown, step: DoneStep): string[] => [...new Set([...(Array.isArray(done) ? done.filter((d) => typeof d === "string") : []), step])];

/**
 * The steps marked done whose macOS permission is missing now (the helper app renamed, so its
 * grants are another app's; `tccutil reset`; turned off in System Settings): the mic without the
 * microphone, the talk key without Input Monitoring. stepsFor asks them again; setup takes them out
 * of setupDone, so it says what's so. The name and hello have no permission behind them: never here.
 */
export function staleDone(f: Pick<SetupFacts, "mic" | "input" | "done">): DoneStep[] {
  const stale: DoneStep[] = [];
  if (f.done.includes("mic") && f.mic !== "granted") stale.push("mic");
  if (f.done.includes("talkKey") && f.input !== "granted") stale.push("talkKey");
  return stale;
}

/** setupDone without `steps`. */
export const withoutDone = (done: unknown, steps: readonly DoneStep[]): string[] =>
  (Array.isArray(done) ? done.filter((d): d is string => typeof d === "string") : []).filter((d) => !steps.includes(d as DoneStep));

/**
 * What a setup does as it starts: its steps (stepsFor); the ones of them asked again because their
 * permission is gone (`stale`: a line before each, staleLine); and setupDone without those, to keep
 * (null: nothing to change). `done` is setupDone as the settings have it (anything). `all` (`kiko
 * setup --all`): every step, as ever, setupDone left alone.
 */
export function setupPlan(f: Omit<SetupFacts, "done"> & { done: unknown }, all = false): { steps: StepId[]; stale: DoneStep[]; setupDone: string[] | null } {
  const done = Array.isArray(f.done) ? f.done.filter((d): d is string => typeof d === "string") : [];
  const steps = stepsFor({ ...f, done }, all);
  const gone = all ? [] : staleDone({ mic: f.mic, input: f.input, done });
  return { steps, stale: gone.filter((s) => steps.includes(s)), setupDone: gone.length ? withoutDone(done, gone) : null };
}

/** Said before a step asked again because its permission is gone (staleDone). `app`: whose permission it is ("Kiko Dev"). */
export const staleLine = (step: DoneStep, app: string) =>
  step === "mic" ? `The microphone was set up before, but macOS doesn't allow it for ${app} now.` : `The talk key was set up before, but macOS doesn't allow Input Monitoring for ${app} now.`;

// ── The terminal app the permissions go to ─────────────────────────────────

/** Terminal apps by their bundle id (macOS's __CFBundleIdentifier for what an app starts). */
const BY_BUNDLE: Record<string, string> = {
  "com.mitchellh.ghostty": "Ghostty",
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "dev.warp.Warp-Stable": "Warp",
  "dev.warp.Warp": "Warp",
  "net.kovidgoyal.kitty": "kitty",
  "org.alacritty": "Alacritty",
  "io.alacritty": "Alacritty",
  "com.github.wez.wezterm": "WezTerm",
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "dev.zed.Zed": "Zed",
};

/** Terminal apps by TERM_PROGRAM (tmux's own "tmux" says nothing about the app around it). */
const BY_TERM_PROGRAM: Record<string, string> = {
  ghostty: "Ghostty",
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  WarpTerminal: "Warp",
  WezTerm: "WezTerm",
  vscode: "Visual Studio Code",
};

/**
 * The terminal app Kiko runs in, by name, for "turn it on for Ghostty": macOS asks for and keeps
 * every permission for that app. Its bundle id first (it passes through Kiko's tmux), then
 * TERM_PROGRAM; null when neither says.
 */
export function terminalApp(env: NodeJS.ProcessEnv = process.env): string | null {
  const bundle = env.__CFBundleIdentifier;
  if (bundle && BY_BUNDLE[bundle]) return BY_BUNDLE[bundle];
  const program = env.TERM_PROGRAM;
  if (program && BY_TERM_PROGRAM[program]) return BY_TERM_PROGRAM[program];
  if (env.GHOSTTY_RESOURCES_DIR) return "Ghostty";
  if (env.LC_TERMINAL === "iTerm2") return "iTerm";
  return null;
}

/**
 * The terminal to read keys from when the input is a pipe (`curl … | sh` runs `kiko setup`), by
 * its own name, from `ps -o tty=` ("ttys003"): /dev/ttys003. Not /dev/tty: the installed copy is
 * Bun, which reads no keys from it (macOS's kqueue can't watch /dev/tty). Null with no terminal ("??").
 */
export const terminalDevice = (psTty: string): string | null => (/^tty[\w.]+$/.test(psTty.trim()) ? `/dev/${psTty.trim()}` : null);

/** "System Settings → Privacy & Security → Microphone → Ghostty" (`pane`: "Privacy & Security → Microphone"). */
export const whereToTurnOn = (pane: string, app: string | null) => `System Settings → ${pane} → ${app ?? "your terminal app"}`;

/**
 * Said wherever Input Monitoring is to be turned on for the helper app (`app`: its name, "Kiko Dev"):
 * System Settings then offers to "Quit & Reopen" it, and either button is fine (helper-app.ts: the
 * helpers come back by themselves; Later: `kiko` restarts the app itself).
 */
export const quitAndReopenLine = (app: string) => `macOS may offer to Quit & Reopen ${app}: either button is fine, ${NAME} carries on by itself.`;

// ── The words ──────────────────────────────────────────────────────────────

/** Said when the Mac has no input device at all (a Mac mini over screen share): before anything listens. */
export const NO_MIC = `This Mac has no microphone: plug one in (AirPods work), or skip${phoneLive() ? " and talk through the iPhone app" : " for now"}.`;

/**
 * What's missing that Kiko needs, said as setup starts (not after its last step): no coding agent
 * on this Mac (`found`: the agents found, by name). A line each; none when nothing's missing.
 */
export function missingLines(found: readonly string[]): string[] {
  if (found.length) return [];
  return [
    `No coding agent found. ${NAME} talks to Claude Code, Codex or OpenCode: install one, then run ${COMMAND} setup claude (or codex, opencode).\n` +
      "  Claude Code:  curl -fsSL https://claude.ai/install.sh | bash\n" +
      "  Codex:        brew install codex",
  ];
}

/**
 * Setup's command by its full path, for "quit and reopen the terminal, then run this" (the new
 * terminal may not have ~/.local/bin on its PATH yet): the link on the PATH when an installed copy
 * has one, else the executable; a checkout's bin/kiko-dev (Kiko Dev's command: core/name.ts).
 */
export function setupCommand(o: { installed: boolean; binLink: string | null; executable: string; appRoot: string }): string {
  const program = o.installed ? (o.binLink ?? o.executable) : `${o.appRoot.replace(/\/$/, "")}/bin/${COMMAND}`;
  return `${shellWord(program)} setup`;
}

/** Where to get an OpenRouter key: in full (https://), so the terminal makes it a link. */
export const KEY_URL = "https://openrouter.ai/keys";

/**
 * The key step's first question while accounts are open: the trial first, and your own key always
 * there, with no account.
 */
export const HOW_TO_RUN = {
  question: `How do you want to run ${NAME}?`,
  why: "It needs an AI model for its summaries and routing.",
  trial: "Free trial: 7 days, no card (needs a free account)",
  /** The trial, signed in already: no account to make. */
  trialSignedIn: "Free trial: 7 days, no card",
  own: "My own OpenRouter key: no account needed",
  account: "I have an account: sign in",
  /** Kiko Pro, while it's on sale (core/env.ts proOnSale): bought in the browser (upgrade-cli.ts). */
  pro: `${NAME} Pro: ${PRO_PRICE.month}, ${NAME}'s AI included`,
};

/**
 * Said once signed in with no plan running on the account (the trial ended, or never started): Kiko
 * runs on a key of your own. `hasKey`: there's one already.
 */
export const ACCOUNT_NO_PLAN = {
  // With a key already (OpenRouter's or Anthropic's: keys.ts hasModel), not named: either runs it.
  signedIn: (hasKey: boolean) =>
    hasKey
      ? `No plan is running on this account, so ${NAME} runs on your own key. It uses the one you have.`
      : `No plan is running on this account, so ${NAME} runs on your own OpenRouter key. Paste one, or Esc to skip.`,
  /** Under the last step's "needs a key", signed in. */
  end: "(You're signed in, but no plan is running on the account: the free trial ended, or never started.)",
};

/** What the key is for, and what it costs, in a line. */
export const KEY_INTRO = `${NAME}'s summaries and replies run on OpenRouter: one key, a few dollars of credit (about $2–6 a month).`;

/** A voice the hello can be said in. */
export type Voice = "say" | "pocket" | "cartesia";

/**
 * The voice setup's hello is said in, looked at each time it's said (Play it again too): the one
 * chosen (Pocket, Cartesia); with nothing chosen (`tts` the macOS voice, `chosen` false: startPocket's
 * conditions), Pocket once its download is `ready` (the voice step waits for it, unless Esc), else
 * the macOS voice.
 */
export function helloVoice(tts: Voice, chosen: boolean, pocket: PrepState): Voice {
  if (tts !== "say") return tts;
  return !chosen && pocket === "ready" ? "pocket" : "say";
}

/** How far along Pocket's download is, as setup shows it: "▰▰▰▱▱▱▱▱▱▱  38%" (`fraction` 0 to 1). */
export function voiceBar(fraction: number, width = 10): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.floor(f * width);
  return `${"▰".repeat(full)}${"▱".repeat(width - full)}  ${Math.floor(f * 100)}%`;
}

/** The voice step's words while it waits for Pocket, and after. */
export const VOICE_WORDS = {
  waiting: `Getting ${NAME}'s voice ready…`,
  install: "installing (about 1 GB, once)",
  voice: "downloading the voice",
  hint: "esc use the Mac voice for now",
  ready: `${NAME}'s voice is ready.`,
  later: `The Mac voice for now: ${NAME} switches to its own once it's ready.`,
  failed: `${NAME}'s voice couldn't be set up: the Mac voice for now.`,
  /** On the last step, with it still downloading (`fraction` 0 to 1). */
  stillGoing: (fraction: number) => `${NAME}'s voice is ${Math.floor(Math.min(0.99, Math.max(0, fraction)) * 100)}% downloaded: it takes over from the Mac voice by itself.`,
};

/**
 * What it says first, by the name you call it (`name`): the speaker works, and what it's for. `key`:
 * the talk key, as said ("Right Option").
 */
export const helloText = (key: string, name = spokenName()) => `Hi, I'm ${name}. Hold ${key} and talk to me: I pass what you say to your coding sessions, and tell you when they need you.`;

/**
 * What to try first: four short lines. Starting a session by voice only when voice can
 * (voiceCan "everything"); else from the menu. `talk`: the talk key ("Right Option"); `menu`: the
 * menu key ("Ctrl+Space").
 */
export function tryLines(o: { talk: string; menu: string; voiceCan: string }): string[] {
  return [
    o.voiceCan === "everything" ? `Hold ${o.talk} and say “start a session in” and a project's name.` : `${o.menu} then c starts a session in one of your projects.`,
    `Hold ${o.talk} and say a session's name, then what to tell it: “api, run the tests”.`,
    `When a session finishes or needs you, ${spokenName()} says so: answer out loud the same way.`,
    `${o.menu} opens the menu; s there is settings. ${COMMAND} setup runs this again.`,
  ];
}
