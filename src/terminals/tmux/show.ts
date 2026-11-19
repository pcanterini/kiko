// Showing a session of Kiko's tmux: a new window of the user's terminal app attached to it. Closing
// the window only detaches: the session runs on. Which app (windowApp): KIKO_WINDOW_TERMINAL when
// set (ghostty, iterm, terminal or rex), else the one `kiko` was started from when it's one of those,
// else Ghostty when it's installed (a window running `tmux attach`, nothing typed into a shell),
// else Terminal.app, which every Mac has. Each over AppleScript, run by the helper app
// (platform/macos/apple-events.ts): macOS asks whether Kiko may control it, once. Rex through its
// CLI instead (../rex/rex.ts rexWindow: a new tab), while its server runs.
import { appInstalled, launchTerminal } from "../../core/terminal-apps.ts";
import { envVar } from "../../core/name.ts";
import { log } from "../../core/log.ts";
import { runAppleScript, type ScriptRunner } from "../../platform/macos/apple-events.ts";
import { runWindow } from "../ghostty/ghostty.ts";
import { rexReady, rexWindow } from "../rex/rex.ts";
import { attachCommand, SERVER } from "./tmux.ts";

/** The terminal apps a window can be opened in. */
export type WindowApp = "ghostty" | "iterm" | "terminal" | "rex";
const WINDOW_APPS: readonly WindowApp[] = ["ghostty", "iterm", "terminal", "rex"];

/** The setting's words for each (KIKO_WINDOW_TERMINAL): its id, or the app's own name. */
function windowAppOf(said: string | undefined): WindowApp | null {
  const word = (said ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.app$/, "");
  if (word === "iterm2") return "iterm";
  if (word === "apple_terminal") return "terminal";
  return (WINDOW_APPS as readonly string[]).includes(word) ? (word as WindowApp) : null;
}

/**
 * Where a window opens: `setting` (KIKO_WINDOW_TERMINAL) when it names one that's installed, else
 * `launched` (the terminal `kiko` was started from: core/terminal-apps.ts launchTerminal) when it's
 * one of these and installed, else Ghostty when installed, else Terminal.
 */
export function windowApp(o: { setting?: string; launched: string | null; installed: (app: WindowApp) => boolean }): { app: WindowApp; why: string } {
  const set = windowAppOf(o.setting);
  if (set && o.installed(set)) return { app: set, why: "setting" };
  const launched = windowAppOf(o.launched ?? undefined);
  if (launched && o.installed(launched)) return { app: launched, why: "launched" };
  if (o.installed("ghostty")) return { app: "ghostty", why: "default" };
  return { app: "terminal", why: "default" };
}

// `do script` opens a new window with the user's shell running the command; `exec` puts tmux in the
// shell's place, so the window closes with it.
const TERMINAL_APP = `
on run argv
  tell application "Terminal"
    do script ("exec " & (item 1 of argv))
    activate
  end tell
end run`;

// The same in iTerm2: a new window with its default profile (the user's shell), the command typed
// in with `exec`, so the window closes with tmux.
const ITERM = `
on run argv
  tell application "iTerm"
    set w to (create window with default profile)
    tell current session of w to write text ("exec " & (item 1 of argv))
    activate
  end tell
end run`;

/** What showSession needs from the world: the tests' fakes replace them. */
export type ShowDeps = {
  setting(): string | undefined;
  launched(): string | null;
  installed(app: WindowApp): boolean;
  /** Ghostty's own way (ghostty.ts runWindow): a window running the command instead of a shell. */
  ghostty(cwd: string, command: string): Promise<void>;
  /** Rex's (../rex/rex.ts rexWindow): a new tab running the command instead of a shell. */
  rex(cwd: string, command: string): Promise<void>;
  script: ScriptRunner;
};

const real: ShowDeps = {
  setting: () => envVar("WINDOW_TERMINAL"),
  launched: () => launchTerminal(),
  // Rex: its server running (it has the tabs), not only its app installed.
  installed: (app) => (app === "rex" ? rexReady() : appInstalled(app)),
  ghostty: runWindow,
  rex: rexWindow,
  script: runAppleScript,
};

/** A new window, in the terminal windowApp picks, attached to `session` on `server`. */
export async function showSession(cwd: string, session: string, server = SERVER, d: ShowDeps = real) {
  const command = attachCommand(session, server);
  const { app, why } = windowApp({ setting: d.setting(), launched: d.launched(), installed: d.installed });
  if (app === "ghostty") {
    if (why !== "default") log("terminal_window_app", { app, why });
    return d.ghostty(cwd, command);
  }
  if (app === "rex") {
    log("terminal_window", { via: "rex", cwd, command, why });
    return d.rex(cwd, command);
  }
  log("terminal_window", { via: app === "iterm" ? "iterm" : "terminal-app", cwd, command, why });
  await d.script(app === "iterm" ? ITERM : TERMINAL_APP, [command]);
}
