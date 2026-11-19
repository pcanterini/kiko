/**
 * `kiko`: the Kiko window, and Claude Code started where Kiko can always type into it
 * (bin/kiko runs this). Its command line is read by ./cli-args.ts (`kiko --help`).
 *
 *   kiko                  the Kiko window, here: Kiko's list on the left, a Claude Code
 *                            session on the right, Kiko's state in the bottom line (all drawn by
 *                            Kiko's own tmux: src/terminals/tmux/window.ts). Starts the Kiko
 *                            app in it unless it's already running; a second `kiko` is one more
 *                            view of the same window. Closing the terminal leaves it all running.
 *   kiko claude [args…]   Claude Code in Kiko's tmux, in this folder, shown in the window (the
 *                            window opened here, Kiko started if need be). The args go to claude
 *                            as they are.
 *   kiko codex [args…]    Codex in Kiko's tmux, as `kiko claude` is Claude Code; `kiko
 *   kiko opencode [args…] opencode`, OpenCode. Each also preselects its agent for new sessions this
 *                            run (the window's picker, voice: core/agent-pick.ts) until the next
 *                            plain `kiko`, and is the last used
 *   kiko setup [--all]    first-run setup (./onboard.ts): your agents, one key, the microphone,
 *                            the talk key, Kiko's voice, what to try; the steps done already left
 *                            out (--all: every one). Enter on its last step opens the window
 *   kiko setup <agent>    Kiko's hooks added to an agent's file (claude: ~/.claude/settings.json;
 *                            codex: ~/.codex/hooks.json), or repaired, after asking; for OpenCode,
 *                            which has no hooks, Kiko's yes to listening to its background service
 *                            (only Kiko's settings change)
 *   kiko uninstall [agent] Kiko's hooks taken out of an agent's file (only Kiko's), or its
 *                            listening stopped (OpenCode), after asking
 *   kiko keys [set|remove <name>] the API keys and where each comes from (the environment, .env,
 *                            the Keychain), never shown; one entered (hidden), checked and kept in
 *                            the Keychain, or taken out of it (./keys-cli.ts)
 *   kiko login [--no-browser] / logout / account [billing|delete]  this Mac's Kiko account: signed in
 *                            with the device code flow, signed out, shown, or deleted (./account-cli.ts); while
 *                            accounts aren't open (core/env.ts accountsLive), a line saying so
 *   kiko upgrade [--no-browser]  Kiko Pro bought: a plan picked, Stripe's checkout opened, the
 *                            payment waited for (./upgrade-cli.ts); `kiko account billing` manages
 *                            it (whenever accounts are open). Only while Pro is on sale (core/env.ts proOnSale); else a line
 *   kiko update [--rollback] the newest version downloaded, checked and switched to now (it starts
 *                            the next time Kiko does), or back to the one before (./update-cli.ts)
 *   kiko attach [name]    the window showing that session (`kiko ls`); no name: the window
 *   kiko ls               the sessions in Kiko's tmux, and whether the window and Kiko run
 *   kiko trust-scratch    Claude Code in Kiko's scratch folder, in the window, to answer its
 *                            "trust this folder?" prompt there once: every scratch session after
 *                            that starts without asking. Nothing is written for you (Claude Code's
 *                            ~/.claude.json is only read: that one answer).
 *
 * Kiko always runs as its window, in its own tmux: with tmux not installed, every command that
 * needs it (the window, `claude`, `codex`, `opencode`, `attach`, `ls`, `trust-scratch`) stops and
 * says to install it. A run of an agent that prints and quits (`kiko claude -p`) needs no tmux.
 *
 * The Kiko key (`--key`, KIKO_KEY, the "Menu key" setting, else Ctrl+Space:
 * terminals/tmux/keys.ts) is bound as the window opens, after a look at what's around this
 * terminal that could take it first (terminals/tmux/clash.ts: your own tmux, run with this shell's
 * TMUX, which nothing Kiko starts gets; herdr; your terminal app, by TERM_PROGRAM alone; macOS):
 * one that does gets another key this run, and the app warns you and asks in the window whether
 * to keep that key from now on or set your own (not again once answered: the settings'
 * keyClashAnswers). Nothing here waits for the answer. Run in a herdr pane, herdr is asked to pass right-clicks on
 * (terminals/tmux/herdr.ts), and nothing of herdr's environment reaches Kiko's tmux.
 *
 * Plain `claude` works as it always did; Kiko just can't type into it at any moment, nor show it
 * in the window. Runs in any folder, so it puts nothing of .env in its environment and writes no logs
 * (the app it starts does that, in its own folder; `keys` only reads which keys the app's .env has).
 * In a checkout, the .env's KIKO_ values count as if your shell exported them (core/dev-env.ts,
 * imported first: KIKO_ACCOUNTS turns `login` on), never handed on to what it starts. It reads
 * the settings only for the scratch folder, the Kiko key, your answers about key
 * clashes and (for `keys`) the engines and model chosen, and writes them only to keep what
 * `setup` and `uninstall` mean for the first-run card (agentAnswers), and the agent `kiko codex`
 * started a session of (lastNewSessionAgent).
 */
// First: a checkout's .env's KIKO_ values, before anything reads one (core/dev-env.ts).
import "./core/dev-env.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { folderTrusted } from "./agents/claude-code/trust.ts";
import { cliArgv, INSTALLED, programArgv, STATE_DIR } from "./core/app-root.ts";
import { agentNamed, agentWords, connectOne, outcomeMessage, SETUPS, statusOf } from "./agents/setup.ts";
import type { AgentSetup } from "./agents/types.ts";
import { codexOneShot, opencodeOneShot, parseCli, styledUsage, version } from "./cli-args.ts";
import { codexArgs } from "./agents/codex/launch.ts";
import { COMMAND, ENV_PREFIX, envVar, INSTALL_LINE, NAME, OTHER, TITLE } from "./core/name.ts";
import { devFirstStart } from "./core/first-start.ts";
import { loadSettings, rememberAgents, rememberLastAgent, scratchFolderOf, settingsExist } from "./core/settings.ts";
import { onSetAside, setAsideLine } from "./core/json-file.ts";
import { appRunning, otherRunningWords, whoElseRuns } from "./core/running.ts";
import {
  cleanEnv,
  CONFIG,
  envLaunch,
  freeName,
  realServersRefused,
  SERVER,
  sessionNameFor,
  sweepLaunches,
  tmuxArg,
  tmuxFlags,
  tmuxFormatArg,
  tmuxEnv,
  tmuxPath,
  tmuxRunner,
  userTmux,
  whereInKiko,
  WINDOW,
  type Launch,
} from "./terminals/tmux/tmux.ts";
import { andList, plainText, shortPath } from "./core/text.ts";
import { boundKey, describe, LABEL, openWindow, setNewAgent, show, type Note, type Size, type WindowKey } from "./terminals/tmux/window.ts";
import { checkKey, clashId, clashNote, inHerdr, isClashAnswer, takers } from "./terminals/tmux/clash.ts";
import { rightClickHelp, rightClickToPane, withoutHerdr } from "./terminals/tmux/herdr.ts";
import { decideKey, keyWords, type KeyChoice } from "./terminals/tmux/keys.ts";
import { ATTACH_FAILED, attachInput, NO_TERMINAL } from "./terminals/tmux/attach.ts";
import { KEY_NAMES } from "./core/keys.ts";
import { withoutHeldKeys } from "./core/key-values.ts";
import { colorDepth, styleFor } from "./ui/cli-style.ts";
import { logoMark } from "./ui/logo.ts";
import { wholeFirst } from "./ui/splash.ts";

/** How this command's lines are styled (ui/cli-style.ts): colour on a terminal, markers either way. */
const out = styleFor(process.stdout);
const err = styleFor(process.stderr);

// A config file that couldn't be read, set aside rather than saved over (core/json-file.ts): said
// here, in the terminal; the app says it again in the window when this starts it.
onSetAside((s) => console.error(err.warn(`${COMMAND}: ${setAsideLine(s)}`)));

/** Where the app runs: the repo, or an installed copy's ~/.local/state/kiko/ (core/app-root.ts). */
const APP_ROOT = STATE_DIR;

// A tmux client attached here needs this terminal's TERM (and the like), but not the TMUX of a tmux
// this is run inside (tmux in tmux: ours has no prefix key, so the outer one's keys still work), nor
// herdr's variables (herdr.ts).
function attachEnv(): NodeJS.ProcessEnv {
  const { TMUX: _, TMUX_PANE: __, ...env } = process.env;
  return withoutHerdr(env);
}

/**
 * tmux on Kiko's server, for everything but attaching: with what a new terminal window has,
 * nothing more (cleanEnv), as the app runs it. One that starts the server gives it its environment,
 * and every session after would get it (voice-opened ones, placeholders), keys included. `kiko
 * claude`'s own session gets this shell's through a private file (envLaunch).
 */
const tmux = tmuxRunner(SERVER, CONFIG, cleanEnv());

let where: Promise<"pane" | "session" | null> | null = null;

/**
 * Where this runs, as far as Kiko's tmux goes (tmux.ts whereInKiko): "pane", "session" or
 * null, asked once. A TMUX this terminal got from where it was started, in no pane of Kiko's,
 * is outside: `kiko` attaches as from any terminal.
 */
const inKiko = () => (where ??= whereInKiko(tmux));

/** The Kiko key asked for, and what decided it (keys.ts): set once the command line is read. */
let chosen: KeyChoice = { key: "C-Space", by: "default" };
/** What you answered about key clashes before (the settings' keyClashAnswers, by clash.ts clashId): set once the settings are read. */
let clashAnswers: Record<string, unknown> = {};

/**
 * The key the window gets this run, and what to tell you once (window.ts Note): `chosen`, unless
 * what's around this terminal takes it first (clash.ts), then a fallback; and in herdr, its
 * right-clicks asked for. Run from inside Kiko's own tmux: nothing (the key stays as it is).
 */
async function windowKey(): Promise<WindowKey | undefined> {
  if (await inKiko()) return undefined;
  const notes: Note[] = [];
  let { key, by }: { key: string; by: string } = chosen;
  const clash = await checkKey(key, takers(process.env, userTmux())).catch(() => null);
  if (clash) {
    if (clash.fallback) [key, by] = [clash.fallback, "clash"];
    // Asked about unless you answered before; a key from --key or KIKO_KEY is only warned about (they win over settings).
    const answered = clashAnswers[clashId(clash)];
    const ask = chosen.by === "setting" || chosen.by === "default";
    const at = Date.now();
    notes.push(clashNote(clash, { answered: isClashAnswer(answered) ? answered : undefined, ask, run: `${process.pid}.${at}`, at }));
  }
  if (inHerdr(process.env) && (await rightClickToPane(process.env)) === "failed") {
    notes.push({ id: "herdr_right_click", text: rightClickHelp(), log: { event: "herdr_right_click", fields: { ok: false } } });
  }
  return { key, by, notes };
}

/**
 * Said, and nothing run, when there's no tmux for Kiko's server (tmux.ts tmuxPath): the window and
 * every session Kiko types into live in it. An installed copy ships its own: gone, the install is broken.
 */
const noTmux = () => fail(INSTALLED ? `${NAME}'s own tmux is missing from its folder: install ${NAME} again (${INSTALL_LINE})` : `${NAME} needs tmux, which isn't installed (brew install tmux)`);

/**
 * This terminal, attached to the window (or moved to it, run inside Kiko's tmux). tmux draws on
 * its client's stdin, which must be a terminal open for writing (./terminals/tmux/attach.ts: one
 * opened read-only, as install.sh gave setup, attached and drew nothing): else this terminal is
 * opened again for it, and with none at all, what to run is said instead.
 */
async function attachWindow(): Promise<number> {
  // A test's run with your own tmux servers in reach (tmux.ts tmuxRunner refuses the same).
  const refused = realServersRefused(process.env);
  if (refused) return fail(refused);
  // In one of Kiko's panes already: this terminal's tmux client moves to the window (TMUX says which client it is).
  if ((await inKiko()) === "pane") {
    const run = spawnSync(tmuxPath()!, [...tmuxFlags(SERVER, CONFIG), "switch-client", "-t", `=${WINDOW}`], { env: tmuxEnv(process.env), stdio: "inherit" });
    return run.status ?? 1;
  }
  const input = attachInput();
  if (!input) return fail(NO_TERMINAL);
  try {
    const run = spawnSync(tmuxPath()!, [...tmuxFlags(SERVER, CONFIG), "attach-session", "-t", `=${WINDOW}`], { env: tmuxEnv(attachEnv()), stdio: [input.stdin, "inherit", "inherit"] });
    if (run.status === 0) return 0;
    console.error(err.error(ATTACH_FAILED));
    return run.status ?? 1;
  } finally {
    input.close();
  }
}

/**
 * What the window's list runs: the Kiko app (start.ts --window, which waits instead while one
 * runs elsewhere), with this shell's environment through a private file, never on a command line.
 * KIKO_WINDOW_APP: a program to run instead, for the tests. Under the test runner
 * (NODE_TEST_CONTEXT) without one, refused: a test must never start the real app.
 */
function appLaunch(): Launch {
  mkdirSync(APP_ROOT, { recursive: true });
  const stand = envVar("WINDOW_APP");
  // Never a key Kiko found (setup read the Keychain's): the app reads them itself (core/key-values.ts).
  const env = withoutHeldKeys(process.env, KEY_NAMES);
  if (stand) return envLaunch(env, APP_ROOT, stand, []);
  if (process.env.NODE_TEST_CONTEXT) throw new Error(`run by a test (NODE_TEST_CONTEXT) with no ${ENV_PREFIX}WINDOW_APP: not starting the real ${NAME}`);
  const [node, ...start] = programArgv("start");
  return envLaunch(env, APP_ROOT, node, [...start, "--window"]);
}

/** This terminal's size, less the bottom line. */
function terminalSize(): Size | undefined {
  const { columns, rows } = process.stdout;
  return columns && rows ? { width: columns, height: Math.max(5, rows - 1) } : undefined;
}

/** Run by a session in the window (Claude Code's own shell, which has no TMUX): showing the window there would be the window inside itself. Says the key the window has. */
async function inSession(): Promise<number> {
  const key = (await boundKey(tmux).catch(() => null)) ?? chosen.key;
  return fail(`this runs inside a session of ${NAME}'s window already: ${keyWords(key)} there is the window's menu, or click ☰ ${TITLE} at the bottom`);
}

/** The other flavour running (the release beside Kiko Dev, or the other way round: core/running.ts): said, and 1; else null, and on. */
async function otherFirst(): Promise<number | null> {
  const other = await whoElseRuns();
  return other ? fail(otherRunningWords(other)) : null;
}

/**
 * The window (`resume`: false when setup just ran). Setup asked to be picked up (the terminal app
 * reopened for Input Monitoring: the setupResume setting) and this is a terminal of its own: that
 * first, here, so the talk key's helper is this terminal's.
 */
async function window(resume = true): Promise<number> {
  if (!tmuxPath()) return noTmux();
  const inside = await inKiko();
  if (inside === "session") return inSession();
  const other = await otherFirst();
  if (other !== null) return other;
  if (resume && !inside && process.stdin.isTTY && typeof loadSettings().setupResume === "string") {
    const ended = await (await import("./onboard.ts")).onboard({ inWindow: true });
    if (ended === "quit") return 130;
    // Left with no model key: what to do was said, and the app couldn't start.
    if (ended === "no-key") return 0;
  }
  // Made now, the list's pane is the whole window from the start when the splash (or setup) is
  // coming: the terminal never draws the two panes before it (ui/splash.ts wholeFirst).
  const size = terminalSize();
  const whole = size ? wholeFirst({ cols: size.width, rows: size.height, firstRun: !settingsExist(), off: envVar("SPLASH") }) : false;
  await openWindow(tmux, appLaunch, APP_ROOT, size, await windowKey(), whole);
  // Plain `kiko`: new sessions preselect as the setting says, not as a `kiko codex` before did.
  await setNewAgent(tmux, null);
  return attachWindow();
}

/**
 * A session of `program`'s agent started from here (`kiko codex`): new sessions preselect it for
 * this run (window.ts NEW_AGENT_OPTION, until the next plain `kiko`), and it's the last used
 * (core/agent-pick.ts). An agent the setups don't know: nothing.
 */
async function startedHere(program: string) {
  const id = agentNamed(program)?.id;
  if (!id) return;
  await setNewAgent(tmux, id);
  try {
    rememberLastAgent(id);
  } catch {
    // The settings couldn't be written: the run's preselection still holds.
  }
}

// Claude Code's flags for a run that prints and quits: nothing to attach to, so plain `claude`.
const ONE_SHOT = new Set(["-p", "--print", "-v", "--version", "-h", "--help"]);

async function sessionNames(): Promise<string[]> {
  return (await describe(tmux)).panes.map((p) => p.session);
}

/** `kiko claude`: Claude Code in Kiko's tmux (`agentHere`). */
const claude = (args: string[], cwd = process.cwd()) => agentHere({ program: "claude", name: "Claude Code", oneShot: args.some((a) => ONE_SHOT.has(a)) }, args, cwd);

/**
 * `kiko codex`: Codex in Kiko's tmux, as `kiko claude` is Claude Code (`agentHere`); its TUI with
 * its "update available" question off unless you set it (agents/codex/launch.ts). A run that prints
 * and quits as you typed it.
 */
const codex = (args: string[], cwd = process.cwd()) => {
  const oneShot = codexOneShot(args);
  return agentHere({ program: "codex", name: "Codex", oneShot }, oneShot ? args : codexArgs(args), cwd);
};

/** `kiko opencode`: OpenCode in Kiko's tmux, as `kiko claude` is Claude Code (`agentHere`). */
const opencode = (args: string[], cwd = process.cwd()) => agentHere({ program: "opencode", name: "OpenCode", oneShot: opencodeOneShot(args) }, args, cwd);

/**
 * A coding agent's TUI (`program`: claude, codex) in Kiko's tmux, in this folder, shown in the
 * window. Plain `program` here instead for a run that prints and quits (`oneShot`: it needs no
 * tmux), or when already inside Kiko's tmux.
 */
async function agentHere(its: { program: string; name: string; oneShot: boolean }, args: string[], cwd: string): Promise<number> {
  if (its.oneShot) return spawnSync(its.program, args, { stdio: "inherit", cwd }).status ?? 1;
  if (!tmuxPath()) return noTmux();
  if (await inKiko()) {
    // Already in Kiko's tmux (a shell in a pane, or a session's own program): reachable as it is.
    await startedHere(its.program);
    return spawnSync(its.program, args, { stdio: "inherit", cwd }).status ?? 1;
  }
  // The program this shell would run, by its full path: tmux runs it without a shell, and looks a
  // bare name up on the server's PATH (whoever started it), not this one.
  const program = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, its.program))
    .find((at) => existsSync(at));
  if (!program) return fail(`${its.program} isn't on your PATH`);
  const other = await otherFirst();
  if (other !== null) return other;
  await openWindow(tmux, appLaunch, APP_ROOT, terminalSize(), await windowKey());
  const name = freeName(sessionNameFor(cwd), await sessionNames());
  // Started the size of the window's session area, so the agent draws for it from the start.
  const stage = (await describe(tmux)).view?.stage;
  const size = stage ? ["-x", String(stage.width), "-y", String(stage.height)] : [];
  // The agent off the server (LEAVE_TMUX): nothing it runs can reach Kiko's tmux.
  const launch = envLaunch(process.env, cwd, program, args, true);
  let pane: string;
  try {
    pane = (await tmux(["new-session", "-d", "-s", name, "-c", tmuxFormatArg(cwd), ...size, "-P", "-F", "#{pane_id}", "--", ...launch.argv.map(tmuxArg)])).trim();
  } catch (err) {
    launch.discard();
    return fail(`tmux didn't start it: ${err instanceof Error ? err.message : String(err)}`);
  }
  await tmux(["set-option", "-p", "-t", pane, LABEL, name]).catch(() => "");
  const shown = await show(tmux, pane);
  if (shown === "gone") return fail(`${its.name} ended as soon as it started. Plain \`${its.program} ${args.join(" ")}\` here shows why.`);
  await startedHere(its.program);
  return attachWindow();
}

/**
 * Claude Code in the scratch folder itself, as `kiko claude` there, so you answer its trust
 * prompt once and every scratch session after starts without asking. Already trusted: said, nothing opened.
 */
async function trustScratch(): Promise<number> {
  const root = scratchFolderOf();
  const short = shortPath(root);
  if (folderTrusted(root) === true) {
    console.log(out.ok(`${NAME}'s scratch folder (${plainText(short)}) is trusted already: new scratch sessions won't ask.`));
    return 0;
  }
  mkdirSync(root, { recursive: true });
  console.log(
    `Claude Code asks once whether to trust ${out.bold(plainText(short))}. Pick ${out.bold('"Yes, I trust this folder"')} (the first option is "No, exit"), then /exit.\n` +
      out.dim("That's all: new scratch sessions won't ask after it."),
  );
  return claude([], root);
}

async function attach(name: string | undefined): Promise<number> {
  if (!tmuxPath()) return noTmux();
  if (!name) return window();
  if ((await inKiko()) === "session") return inSession();
  const layout = await describe(tmux);
  const sessions = layout.panes.filter((p) => !p.role && !p.dead);
  const pane = sessions.find((p) => p.name === name) ?? sessions.find((p) => p.session === name && !p.inView);
  if (!pane) return fail(`no session called ${name} in ${NAME}'s tmux (${COMMAND} ls lists them)`);
  await openWindow(tmux, appLaunch, APP_ROOT, terminalSize(), await windowKey());
  await show(tmux, pane.id);
  return attachWindow();
}

async function list(): Promise<number> {
  if (!tmuxPath()) return noTmux();
  const [layout, running] = await Promise.all([describe(tmux), appRunning()]);
  const view = layout.view;
  const windowLine = !view ? `not open (${COMMAND} opens it)` : view.clients ? `open in ${view.clients} terminal${view.clients > 1 ? "s" : ""}` : `running, no terminal shows it (${COMMAND} shows it)`;
  console.log(`${NAME} window: ${out.bold(windowLine)}`);
  console.log(`${NAME}: ${out.bold(running ? "running" : "not running")}`);
  const sessions = layout.panes.filter((p) => !p.role);
  if (!sessions.length) return (console.log(out.dim(`No sessions in ${NAME}'s tmux.`)), 0);
  console.log("");
  const home = homedir();
  for (const p of sessions) {
    const where = p.inView ? "shown in the window" : p.dead ? "ended" : "";
    // Names and folders as plain text: an escape sequence in one would reach this terminal.
    const folder = shortPath(p.cwd, home);
    // Padded first, then styled: the escape codes take no columns.
    console.log(`${out.bold(plainText(p.name || p.session).padEnd(24))} ${where.padEnd(20)} ${out.dim(plainText(folder))}`);
  }
  return 0;
}

/** y/N asked in this terminal; anything but y or yes is no. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(out.question(question), resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

type Plan = { command: string; events: string[]; repoint: number };

/**
 * `kiko setup [agent]`: Kiko's hooks added to an agent's file (agents/setup.ts, the same code
 * as the first-run card and settings → Agents), or repaired, after saying what changes and asking:
 * yours are kept, the file is backed up first. No agent: every one found. Codex then asks you to
 * trust them once, at its next start.
 */
async function setup(which: string | undefined): Promise<number> {
  const named = which === undefined ? undefined : agentNamed(which);
  if (which !== undefined && !named) return fail(`setup what? ${COMMAND} setup ${agentWords()} adds ${NAME}'s hooks to that agent; plain ${COMMAND} setup sets ${NAME} up`);
  // Kiko's one-line mark first, in a terminal (plain `kiko setup` has the whole logo: ui/onboarding.ts).
  if (process.stdout.isTTY) console.log(`${logoMark(colorDepth(process.stdout))}\n`);
  if (named && !named.connect) return (console.log(out.ok(`${named.name} needs nothing set up: ${NAME} connects to it by itself while it runs.`)), 0);
  const targets = named ? [named] : SETUPS.filter((s) => s.connect && s.installed());
  if (!targets.length) return fail(`no agent ${NAME} supports was found (${agentWords()} on your PATH)`);
  const todo: { setup: AgentSetup; plan: Plan }[] = [];
  for (const s of targets) {
    let plan: Plan;
    try {
      plan = s.plan?.() ?? { command: "", events: [], repoint: 0 };
    } catch (err) {
      return fail(`${s.file()} can't be read as JSON, so I'm leaving it alone (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!plan.events.length && !plan.repoint) {
      const health = statusOf(s);
      const broken = health.state === "needs repair" ? ` But: ${health.detail}.` : "";
      const already = s.linkWords ? `connected already (${s.linkWords})` : `${NAME}'s hooks are in ${plainText(s.file())} already`;
      const line = `${out.bold(s.name)}: ${already}.${broken || (s.stillQuiet ? ` ${s.stillQuiet}` : "")}`;
      console.log(broken ? out.warn(line) : out.ok(line));
      continue;
    }
    if (!s.installed()) console.log(out.warn(`${out.bold(s.name)} isn't on your PATH; the hooks go in anyway, for when it is.`));
    todo.push({ setup: s, plan });
  }
  if (!todo.length) return 0;
  for (const { setup: s, plan } of todo) {
    if (s.linkWords) {
      console.log(`${out.bold(s.name)}: connecting it means ${s.linkWords}; nothing of ${s.name}'s is changed (only ${NAME}'s settings).`);
      continue;
    }
    const adds = plan.events.length ? `adds ${NAME}'s hook (${plainText(plan.command)}) to ${plainText(s.file())} on: ${plan.events.join(", ")}` : "";
    const moves = plan.repoint ? `points ${NAME}'s ${plan.repoint} entr${plan.repoint === 1 ? "y" : "ies"} in ${plainText(s.file())} at ${plainText(plan.command)} (its folder moved)` : "";
    console.log(`${out.bold(s.name)}: this ${[moves, adds].filter(Boolean).join(", and ")}.`);
  }
  if (todo.some((t) => !t.setup.linkWords)) console.log(out.dim("Hooks already there stay as they are, and each file is backed up first."));
  for (const { setup: s } of todo) for (const line of s.beforeConnect ?? []) console.log(line);
  if (!process.stdin.isTTY) return fail(`run ${COMMAND} setup in a terminal: it asks before changing anything`);
  const question = todo.length > 1 || todo[0].setup.linkWords ? `Connect ${andList(todo.map((t) => t.setup.name))}?` : todo[0].plan.events.length ? "Add them?" : "Repair them?";
  if (!(await confirm(question))) return (console.log("Nothing changed."), 0);
  let failed = false;
  for (const { setup: s } of todo) {
    const o = connectOne(s);
    failed ||= o.did === "failed";
    // Connected here: the first-run card has nothing to remember about it.
    if (o.did !== "failed") rememberAgents({ [s.id]: null });
    console.log(o.did === "failed" ? out.error(plainText(outcomeMessage(o))) : out.ok(plainText(outcomeMessage(o))));
  }
  return failed ? 1 : 0;
}

/**
 * `kiko setup [--all]`: first-run setup (./onboard.ts, which loads .env and the Keychain's keys,
 * so it's imported only here), then the window when you say so on its last step. Left there with
 * no model key ("no-key"), no window: the app couldn't start, and what to do was said.
 */
async function onboarding(all: boolean): Promise<number> {
  // Input from a pipe, output to a terminal (a script's `… | kiko setup`): setup runs again as a
  // program of its own with that terminal for its input, read and written (attach.ts attachInput),
  // and this one only waits. Read here instead, a key would be lost to the window: Bun leaves a
  // read waiting on a terminal it opened itself, even once that's closed, and it takes the first
  // keys typed into the window after (2026-11-02, a pipe run in a pty of its own).
  if (!process.stdin.isTTY && process.stdout.isTTY) {
    const input = attachInput();
    if (input && input.stdin !== "inherit") {
      try {
        const [program, ...args] = cliArgv();
        return spawnSync(program, [...args, "setup", ...(all ? ["--all"] : [])], { stdio: [input.stdin, "inherit", "inherit"] }).status ?? 1;
      } finally {
        input.close();
      }
    }
  }
  const ended = await (await import("./onboard.ts")).onboard({ all });
  if (ended === "no-terminal") return fail(`run ${COMMAND} setup in a terminal: it asks you things`);
  if (ended === "quit") return 130;
  return ended === "open" ? window(false) : 0;
}

/**
 * `kiko uninstall [agent]`: Kiko's hooks taken out of an agent's file, only Kiko's entries,
 * after asking (the file backed up first); no agent: every one that has them. The first-run card
 * won't offer it again (settings → Agents connects it any time). Nothing else of Kiko's is removed,
 * except by an installed copy's plain `kiko uninstall`, which takes all of Kiko out (./uninstall.ts).
 */
async function uninstall(which: string | undefined): Promise<number> {
  if (which === undefined && INSTALLED) {
    if (!process.stdin.isTTY) return fail(`run ${COMMAND} uninstall in a terminal: it asks before changing anything`);
    const { realUninstallDeps, uninstallAll } = await import("./uninstall.ts");
    return uninstallAll(await realUninstallDeps(confirm));
  }
  const named = which === undefined ? undefined : agentNamed(which);
  if (which !== undefined && !named) return fail(`uninstall what? ${COMMAND} uninstall ${agentWords()} takes ${NAME}'s hooks out of that agent; plain ${COMMAND} uninstall, out of every one`);
  if (named && !named.disconnect) return (console.log(`${named.name} has nothing of ${NAME}'s to take out.`), 0);
  const targets = (named ? [named] : SETUPS.filter((s) => s.disconnect)).filter((s) => {
    const status = statusOf(s);
    if (status.unreadable) console.log(out.warn(`${out.bold(s.name)}: ${plainText(s.file())} can't be read as JSON, so I'm leaving it alone.`));
    return !status.unreadable && (status.state === "connected" || status.state === "needs repair");
  });
  if (!targets.length) return (console.log(`${named ? named.name : "No agent"} has none of ${NAME}'s hooks.`), 0);
  for (const s of targets)
    console.log(
      s.linkWords
        ? `${out.bold(s.name)}: this disconnects it: ${NAME} stops listening to it (only ${NAME}'s settings change).`
        : `${out.bold(s.name)}: this takes ${NAME}'s hooks out of ${plainText(s.file())}; yours stay as they are, and the file is backed up first.`,
    );
  if (!process.stdin.isTTY) return fail(`run ${COMMAND} uninstall in a terminal: it asks before changing anything`);
  if (!(await confirm(targets.every((s) => s.linkWords) ? `Disconnect ${andList(targets.map((s) => s.name))}?` : "Take them out?"))) return (console.log("Nothing changed."), 0);
  let failed = false;
  for (const s of targets) {
    try {
      const changed = s.disconnect!();
      // Taken out by you: the first-run card doesn't offer it again.
      rememberAgents({ [s.id]: "no" });
      console.log(
        out.ok(
          s.linkWords
            ? `Disconnected ${s.name}: ${NAME} no longer listens to it.`
            : `Disconnected ${s.name}: ${NAME}'s hooks are out of ${plainText(shortPath(changed.file))}${changed.backup ? ` (the old one is ${plainText(changed.backup)})` : ""}.`,
        ),
      );
    } catch (e) {
      failed = true;
      console.error(err.error(`${COMMAND}: ${s.name} wasn't changed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return failed ? 1 : 0;
}

function fail(why: string) {
  console.error(err.error(`${COMMAND}: ${why}`));
  return 1;
}

// Ctrl+C, Ctrl+\ are Claude Code's: this only waits for it.
for (const signal of ["SIGINT", "SIGQUIT"] as const) process.on(signal, () => {});

// Launch files left by a run tmux never started (envLaunch): each holds an environment, keys included.
sweepLaunches();

const run = (task: Promise<number>) =>
  task.then(
    (code) => (process.exitCode = code),
    (e) => (process.exitCode = fail(e instanceof Error ? e.message : String(e))),
  );

const parsed = parseCli(process.argv.slice(2));
switch (parsed.kind) {
  case "help":
    console.log(styledUsage(out));
    break;
  case "version":
    console.log(version());
    break;
  case "error":
    console.error(`${err.error(`${COMMAND}: ${parsed.message}`)}\n${err.dim(`Try ${COMMAND} --help for more.`)}`);
    process.exitCode = 2;
    break;
  case "run":
    // Kiko Dev's first start copies your settings and keys over (core/first-start.ts), before anything reads them.
    void devFirstStart()
      .then(
        (said) => void (said && console.log(said)),
        (e) => console.error(err.warn(`${COMMAND}: your settings weren't copied from ~/.config/${OTHER.configFolder}: ${e instanceof Error ? e.message : String(e)}`)),
      )
      .then(() => runCommand(parsed));
    break;
}

/** A command of the command line, run. */
function runCommand(parsed: Extract<ReturnType<typeof parseCli>, { kind: "run" }>) {
  // The key: --key > KIKO_KEY > the "Menu key" setting > Ctrl+Space (keys.ts).
  const settings = loadSettings();
  chosen = decideKey({ flag: parsed.key, env: envVar("KEY"), setting: settings.menuKey });
  for (const why of chosen.ignored ?? []) console.error(err.warn(`${COMMAND}: ${why}; not using it.`));
  const answers = settings.keyClashAnswers;
  clashAnswers = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const { command, args } = parsed;
  // A first run (no settings yet, e.g. a fresh install or a new clone): setup first, which ends by
  // opening the window, as install.sh's `kiko setup` does.
  if (command === undefined) void run(!settingsExist() && process.stdin.isTTY ? onboarding(false) : window());
  else if (command === "claude") void run(claude(args));
  else if (command === "codex") void run(codex(args));
  else if (command === "opencode") void run(opencode(args));
  else if (command === "setup" && (args[0] === undefined || args[0] === "--all")) void run(onboarding(args[0] === "--all"));
  else if (command === "setup") void run(setup(args[0]));
  else if (command === "uninstall") void run(uninstall(args[0]));
  else if (command === "keys") void run(import("./keys-cli.ts").then(async (k) => k.keysCommand(args, await k.realDeps())));
  else if (command === "login" || command === "logout" || command === "account") void run(import("./account-cli.ts").then(async (a) => a.accountCommand(command, args, await a.realDeps())));
  else if (command === "upgrade") void run(import("./upgrade-cli.ts").then(async (u) => u.upgradeCommand(args, await u.realUpgradeDeps())));
  else if (command === "update") void run(import("./update-cli.ts").then(async (u) => u.updateCommand(args, await u.realDeps())));
  else if (command === "attach") void run(attach(args[0]));
  else if (command === "ls") void run(list());
  else if (command === "trust-scratch") void run(trustScratch());
  else if (command === "_overlay-test") void run(import("./app/overlay.ts").then((o) => o.overlayTest()));
}
