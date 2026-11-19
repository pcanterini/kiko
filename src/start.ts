// `start.ts --window`: run by `kiko` in the Kiko window's list pane (src/terminals/tmux/window.ts),
// the only place the app runs (`pnpm start` is `kiko`). On the first run (no saved settings yet)
// first-run setup comes first (onboard.ts: `kiko setup`'s steps), then the app. Each runs in its own process because a few
// settings (voice engine, speech recognition, hotkey) are only read when the app loads: after
// changing one in the app's settings screen, the app exits with RESTART_EXIT and comes back here
// to start again. After Settings → Updates → Restart now it exits with UPDATE_EXIT, and this starts
// the version installed since in its place (core/updates/layout.ts relaunchCommand: the command that starts
// this program, from the new version's folder), which runs on in this pane; this one only waits for it.
//
// While the app runs elsewhere (one started some other way), it waits, says so, and starts once
// that one stops: never two apps. First-run setup gets the whole window. Quitting the app
// (q, Ctrl+C) closes the window; the sessions in it keep running.
//
// The window never just goes: with no model key (NO_KEY_EXIT) the key is asked for right here
// (onboard.ts --need-key), then the app starts; left for later, or the app stopping before it
// started with a reason (SAID_EXIT: another app, the lock), what was said stays, the list's pane
// the whole window, until a key is pressed (core/running.ts afterApp).
//
// On the window's cold start (the app's first start in it; never a restart, and `kiko` with the app
// running only attaches) the app opens with the splash instead (ui/splash.ts: Kiko's logo over the
// whole window while it loads, then the list): this zooms the list's pane to the whole window and
// paints the splash itself from then on, so the logo starts as the window opens, and starts the app
// with --splash=<its first frame's time>; the app takes the screen over from it as it's about to
// draw, frame for frame (ui/splash-handoff.ts). `kiko` made the window zoomed already when it saw the
// splash coming (ui/splash.ts wholeFirst), so no terminal draws the two panes first; when it isn't
// coming after all, this gives the list its own size back. Not with KIKO_SPLASH=off (the live tests), a window
// too small for the logo, a note to show (Kiko Dev's first start), or helpers to build first.
//
// Until the app is ready, the window says it's starting (ui/loading.ts): "Starting…" in the list's
// pane, drawn here before each start of the app, and the app's title and what it's doing in the
// session area (its placeholder: window.ts setStarting), here first, then the app's own steps. In a
// checkout this builds the helpers the app runs itself first, when they need it (a step of its own),
// so the app never stops to; the compiler's words go to the build log (platform/macos/native.ts),
// never this pane. A helper that won't build is left for the app to say, as it needs it.
// First: a checkout's .env's KIKO_ values, before anything reads one (core/dev-env.ts).
import "./core/dev-env.ts";
import { spawn, spawnSync } from "node:child_process";
import type { Duplex } from "node:stream";
import { INSTALLED, programArgv } from "./core/app-root.ts";
import { COMMAND, envVar, TITLE } from "./core/name.ts";
import { devFirstStart } from "./core/first-start.ts";
import { relaunchCommand, thisCopy } from "./core/updates/layout.ts";
import { version } from "./cli-args.ts";
import { afterApp, appRunning, CLOSE_HINT, NO_KEY_EXIT } from "./core/running.ts";
import { settingsExist } from "./core/settings.ts";
import { BROKERED, buildNative, helperNames, needsBuild } from "./platform/macos/native.ts";
import { CLASSIC, LOOK } from "./terminals/tmux/classic.ts";
import { insideServer, tmuxRunner } from "./terminals/tmux/tmux.ts";
import { closeWindow, setStarting, STARTED_ONLY, STEPS, zoom } from "./terminals/tmux/window.ts";
import { colorDepth } from "./ui/cli-style.ts";
import { beforeSaidKept, CURSOR_ON, startingScreen } from "./ui/loading.ts";
import { splashWanted } from "./ui/splash.ts";
import { answerHandoff, paintSplash, type Painter } from "./ui/splash-handoff.ts";

const appArgs = process.argv.slice(2);
// The list pane of the Kiko window: on Kiko's server, in a pane of its own.
const listPane = process.argv.includes("--window") && insideServer(process.env.TMUX) ? (process.env.TMUX_PANE ?? null) : null;
const tmux = tmuxRunner();

// Anywhere else (a terminal of its own): Kiko runs as its window, so `kiko` opens that.
if (!listPane) {
  console.error(`${TITLE} runs in its window: run ${COMMAND} (bin/${COMMAND}, or pnpm start) to open it.`);
  process.exit(1);
}

// Ctrl+C reaches the app too (same terminal); let it shut down and report, then exit with it.
process.on("SIGINT", () => {});

// Kiko Dev's first start, if `kiko` didn't see to it (core/first-start.ts): before the settings are
// looked at. What it says goes under "Starting…", the first time it's drawn.
const copied = await devFirstStart().catch(() => null);
let startNote = copied ?? "";

/** The window's starting state, said (a step) or taken back (null): never in the way if tmux won't. */
const starting = (step: Parameters<typeof setStarting>[1]) => setStarting(tmux, step).catch(() => {});

if (await appRunning()) {
  // Not starting after all: the session area says what it does with no app.
  await starting(null);
  if (startNote) console.log(startNote);
  startNote = "";
  console.log(`\n  ${TITLE} is already running in another terminal.\n`);
  console.log("  Only one can run: it's the one that hears you.");
  console.log("  Your sessions still show here; this list and the bottom line");
  console.log(`  need ${TITLE} running here.\n`);
  console.log(`  Quit it there, and ${TITLE} starts here.`);
  while (await appRunning()) await new Promise((r) => setTimeout(r, 1000));
}

/**
 * The list's pane made the whole window: setup gets all of it, and a line said there can be read
 * (the app makes it the list again when it starts). tmux hands the pane its new size a moment after
 * it zooms: waited for (up to a second), so what's drawn next isn't drawn at the list's width (the
 * release's own executable starts fast enough to beat it: e2e, 2026-11-01).
 */
async function whole(pane: string) {
  await zoom(tmux, pane, true).catch(() => {});
  const width = Number((await tmux(["display", "-p", "-t", pane, "#{pane_width}"]).catch(() => "")).trim());
  for (let i = 0; i < 20 && width && process.stdout.columns !== width; i++) await new Promise((r) => setTimeout(r, 50));
}

/** The next key pressed in this pane, any key (Ctrl+C too: raw), or at once with no terminal to read. */
function anyKey(): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}

/** What was just said stays on screen, the whole window, until a key is pressed; then the window closes. */
async function keepOpen(pane: string, status: number | null): Promise<never> {
  await whole(pane);
  process.stdout.write(`\n${CLOSE_HINT}\n`);
  await anyKey();
  await closeWindow(tmux).catch(() => {});
  process.exit(status ?? 1);
}

/**
 * The app found no model key: just the key asked for, the whole window (onboard.ts --need-key, which
 * says why itself, so the app's line is cleared first). True once there's one.
 */
async function askKey(pane: string): Promise<boolean> {
  await whole(pane);
  process.stdout.write("\x1b[H\x1b[2J");
  const [node, ...args] = programArgv("onboard");
  return spawnSync(node, [...args, "--in-window", "--need-key"], { stdio: "inherit" }).status === 0;
}

/** Exits with `status`, the window's starting state taken back first (the pane's last words stay). */
async function finish(status: number): Promise<never> {
  await starting(null);
  process.exit(status);
}

/**
 * The window says the app is starting: "Starting…" in the list's pane (in its look: the classic
 * one's box or the tiled one's pane), and in the session area, with no step yet.
 */
async function showStarting(pane: string) {
  const look = (await tmux(["display", "-p", "-t", pane, `#{${LOOK}}`]).catch(() => "")).trim() === CLASSIC ? "classic" : "tiled";
  process.stdout.write(startingScreen(look, startNote));
  startNote = "";
  await starting(STARTED_ONLY);
}

/** Whether the app starts with the splash (above, ui/splash.ts splashWanted): asked on the window's cold start only, its size as tmux says it (the pane is still the list's). */
async function splashFirst(pane: string): Promise<boolean> {
  const [cols, rows] = (await tmux(["display", "-p", "-t", pane, "#{window_width}\t#{window_height}"]).catch(() => "")).trim().split("\t").map(Number);
  return splashWanted({ cold: true, tty: Boolean(process.stdout.isTTY), cols, rows, note: Boolean(startNote), building: staleHelpers().length > 0, off: envVar("SPLASH") });
}

/**
 * The splash, painted here from now while the app loads (ui/splash-handoff.ts), the list's pane the
 * whole window for it; the session area says it's starting, for after.
 */
async function showSplash(pane: string): Promise<Painter> {
  await whole(pane);
  const painter = paintSplash(process.stdout, { depth: colorDepth(process.stdout) });
  await starting(STARTED_ONLY);
  return painter;
}

/**
 * The app run in this pane, to its end: its exit status (null: ended by a signal, or never
 * started). With the splash painted here (`painter`), the app takes the screen from it over its fd 3
 * (ui/splash-handoff.ts); one that ends without having taken it (a crash as it loads) leaves it
 * as it is, the painting stopped.
 */
function runApp(node: string, args: string[], painter: Painter | null): Promise<number | null> {
  return new Promise((resolve) => {
    const app = spawn(node, args, { stdio: painter ? ["inherit", "inherit", "inherit", "pipe"] : "inherit" });
    const handoff = painter ? (app.stdio[3] as Duplex) : null;
    if (painter && handoff) answerHandoff(handoff, painter);
    const ended = (status: number | null) => {
      painter?.stop(false);
      handoff?.destroy();
      resolve(status);
    };
    app.once("error", () => ended(null));
    app.once("exit", (code) => ended(code));
  });
}

/** In a checkout, the helpers the app runs as its own children (the rest are the helper app's: BROKERED) that are missing or out of date. */
const staleHelpers = () => (INSTALLED ? [] : helperNames().filter((name) => !BROKERED.has(name) && needsBuild(name)));

/**
 * The stale helpers (staleHelpers) built now, a step of their own. One that fails is left for the
 * app, which builds it again as it needs it and says so then; its compiler's words are in the
 * build log.
 */
async function buildHelpers() {
  const stale = staleHelpers();
  if (!stale.length) return;
  await starting(STEPS.build);
  for (const name of stale) {
    try {
      buildNative(name);
    } catch {
      // Said by the app, if it needs it.
    }
  }
}

let firstRun = !settingsExist();
// The app's first start in this window: a restart (a setting changed, an update) is never one.
let cold = true;
for (;;) {
  if (firstRun) {
    await whole(listPane);
    const [node, ...setupArgs] = programArgv("onboard");
    const setup = spawnSync(node, [...setupArgs, "--in-window"], { stdio: "inherit" });
    // Left with no model key: setup said what to do; it stays to be read.
    if (setup.status === NO_KEY_EXIT) await keepOpen(listPane, setup.status);
    if (setup.status !== 0 || !settingsExist()) await finish(setup.status ?? 1);
  }
  const splash = cold && (await splashFirst(listPane));
  // Made whole by `kiko` for a splash that isn't coming after all (ui/splash.ts wholeFirst), or by
  // setup: the list's own size again for "Starting…".
  if (cold && !splash) await zoom(tmux, listPane, false).catch(() => {});
  cold = false;
  const painter = splash ? await showSplash(listPane) : null;
  if (!splash) await showStarting(listPane);
  await buildHelpers();
  const [node, ...program] = programArgv("app");
  const status = await runApp(node, [...program, ...appArgs, ...(painter ? [`--splash=${painter.since}`] : [])], painter);
  const next = afterApp(status);
  // Starting again (a restart, an update's): it says so again then. Anything else: not starting.
  if (next !== "restart") await starting(null);
  if (next === "update") {
    const command = relaunchCommand(thisCopy(version()), programArgv("start"));
    if (command) {
      const [program, ...args] = command;
      const started = spawnSync(program, [...args, ...appArgs], { stdio: "inherit" });
      process.exit(started.status ?? 1);
    }
  }
  if (next === "ask-key") {
    process.stdout.write(CURSOR_ON);
    if (!(await askKey(listPane))) await keepOpen(listPane, status);
  } else if (next === "keep-open") {
    // What the app said stays; "Starting…" above it goes (none after the splash: the app's words
    // start on the top row of the screen it cleared for them).
    process.stdout.write(beforeSaidKept(!painter));
    await keepOpen(listPane, status);
  } else if (next !== "restart" && next !== "update") {
    // Quit in the window: the window goes with it (a crash leaves it, with what was printed).
    process.stdout.write(CURSOR_ON);
    if (next === "close") await closeWindow(tmux).catch(() => {});
    process.exit(status ?? 0);
  }
  firstRun = false;
}
