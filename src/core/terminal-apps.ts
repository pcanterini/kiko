// Which terminal app something runs in, from its environment: a session's (its hook passes on
// TERM_PROGRAM, macOS's __CFBundleIdentifier and whether it's in Kiko's own tmux:
// hooks/lib.mjs terminalEnv), or the app's own (the terminal `kiko` was started from). Ghostty is
// scripted only when a session runs there (terminals/ghostty/index.ts), and Kiko's window opens in the
// terminal it was started from (terminals/tmux/show.ts).
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** What a session's hook says of its terminal (hooks/lib.mjs terminalEnv): `rex`, the Rex block it runs in. */
export type TerminalEnv = { program?: string; bundle?: string; kiko?: boolean; rex?: string };

/** A terminal app Kiko knows. */
export type TerminalApp = {
  /** Its bundle id: the frontmost app while one of its windows is in front. */
  bundle: string;
  /** Its TERM_PROGRAM. */
  program?: string;
  /** Its folder name (scriptable: Kiko's window can be opened in it, ./tmux/show.ts). */
  app?: string;
  // How Kiko's own window is told to be in it (the Mac overlay hides then: app/overlay.ts, and the
  // helper app's native/macos/app/host.swift), where the defaults don't do. The defaults: Kiko's app
  // has __CFBundleIdentifier (macOS sets it for whatever an app starts, and Kiko's tmux passes it
  // on; TERM_PROGRAM and the terminal's own variables it doesn't: tmux/tmux.ts withoutTerminal), and
  // the app responsible for Kiko's tmux client is this one.
  /** A variable its terminals set that reaches Kiko's app through its tmux, for one that sets no __CFBundleIdentifier (Rex: REX_SESSION). */
  envMark?: string;
  /**
   * Bundle ids of background apps of its own that run its terminals: the app responsible for a
   * process in one of them, never the frontmost (Rex's server, whose terminals the Rex app shows).
   */
  servers?: string[];
  /**
   * Whether Kiko's window is on screen in it (the overlay's "visible" rule: drawn in the tab
   * shown, whichever pane of it has the focus), asked of the terminal itself (the Mac overlay,
   * app/overlay.ts), for one that can say it without Apple Events (Rex: its CLI; its focus events
   * don't tell Kiko's tmux as you change tabs inside it). Given Kiko's tmux client pids; null when
   * it can't tell (Kiko's client isn't in it, say): tmux's focus flag goes then (the "focused" rule).
   */
  focus?: (hostPids: readonly number[]) => Promise<{ kikoFocused: boolean | null; why: string }>;
};

/** The terminal apps by id. */
export const APPS: Record<string, TerminalApp> = {
  ghostty: { bundle: "com.mitchellh.ghostty", program: "ghostty", app: "Ghostty.app" },
  iterm: { bundle: "com.googlecode.iterm2", program: "iTerm.app", app: "iTerm.app" },
  terminal: { bundle: "com.apple.Terminal", program: "Apple_Terminal", app: "Terminal.app" },
  warp: { bundle: "dev.warp.Warp-Stable", program: "WarpTerminal" },
  wezterm: { bundle: "com.github.wez.wezterm", program: "WezTerm" },
  kitty: { bundle: "net.kovidgoyal.kitty" },
  vscode: { bundle: "com.microsoft.VSCode", program: "vscode" },
  // Rex for Mac (in beta as "Rex Beta.app"): its terminals are its server's ("Rex Server.app", a
  // background app of its own, responsible for them), which sets TERM_PROGRAM, REX_SESSION and no
  // bundle id; reached through its CLI (terminals/rex/), not AppleScript. Whether Kiko's block is
  // drawn in the tab it shows is its own to say (terminals/rex/focus.ts, loaded only when asked).
  rex: {
    bundle: "com.superlogical.rex",
    program: "rex",
    app: "Rex Beta.app",
    envMark: "REX_SESSION",
    servers: ["com.superlogical.rex.server"],
    focus: (hostPids) => import("../terminals/rex/focus.ts").then((m) => m.rexFocus(hostPids)),
  },
};

/** The app with this bundle id, or whose server it is (TerminalApp.servers). */
const byBundle = (bundle: string | undefined) => Object.keys(APPS).find((id) => bundle && (APPS[id].bundle === bundle || APPS[id].servers?.includes(bundle))) ?? null;
const byProgram = (program: string | undefined) => Object.keys(APPS).find((id) => program && APPS[id].program === program) ?? null;
const byMark = (env: NodeJS.ProcessEnv) => Object.keys(APPS).find((id) => APPS[id].envMark && env[APPS[id].envMark!]) ?? null;

/**
 * The terminal a session runs in, as its hook said: "kiko-tmux" (Kiko's own tmux, reached through
 * it whatever app shows it), an id of APPS ("ghostty", "iterm", "terminal"…), "tmux" (a tmux of
 * your own, in no app it says), or "other".
 * The bundle id goes first: inside your own tmux TERM_PROGRAM is tmux's, while the bundle id is
 * still the app around it (a tmux in Ghostty is Ghostty's to show).
 */
export function sessionTerminal(t: TerminalEnv): string {
  if (t.kiko) return "kiko-tmux";
  return byBundle(t.bundle) ?? byProgram(t.program) ?? (t.program === "tmux" ? "tmux" : "other");
}

/** The terminal app this process was started from (its environment): an id of APPS, or null. */
export function launchTerminal(env: NodeJS.ProcessEnv = process.env): string | null {
  return byBundle(env.__CFBundleIdentifier) ?? byProgram(env.TERM_PROGRAM) ?? (env.GHOSTTY_RESOURCES_DIR ? "ghostty" : null);
}

/**
 * The terminal app Kiko's own window is in, by bundle id, from Kiko's app's environment (it runs
 * in Kiko's tmux: TERM_PROGRAM is tmux's there): its __CFBundleIdentifier (a server's taken for its
 * app; one of an app Kiko doesn't know, as it is), else what TERM_PROGRAM or a TerminalApp.envMark
 * says; and which said it (for the log: a variable's name, never its value). Null when none says.
 * It's what that environment said when the app started: a window shown in another terminal since is
 * found by the app responsible for its tmux client (and `servers`).
 */
export function windowApp(env: NodeJS.ProcessEnv = process.env): { bundle: string; by: string } | null {
  const bundle = env.__CFBundleIdentifier;
  if (bundle) return { bundle: APPS[byBundle(bundle) ?? ""]?.bundle ?? bundle, by: "__CFBundleIdentifier" };
  const program = byProgram(env.TERM_PROGRAM);
  if (program) return { bundle: APPS[program].bundle, by: "TERM_PROGRAM" };
  const marked = byMark(env);
  if (marked) return { bundle: APPS[marked].bundle, by: APPS[marked].envMark! };
  return env.GHOSTTY_RESOURCES_DIR ? { bundle: APPS.ghostty.bundle, by: "GHOSTTY_RESOURCES_DIR" } : null;
}

/** Each terminal app's servers (TerminalApp.servers), by bundle id: the app's own bundle id. */
export function serverApps(): Record<string, string> {
  return Object.fromEntries(Object.values(APPS).flatMap((a) => (a.servers ?? []).map((s) => [s, a.bundle])));
}

/** Whether terminal app `id` is installed: in /Applications or ~/Applications (Terminal, always: it's macOS's). */
export function appInstalled(id: string, home = homedir()): boolean {
  if (id === "terminal") return true;
  const app = APPS[id]?.app;
  return !!app && ["/Applications", `${home}/Applications`].some((dir) => existsSync(`${dir}/${app}`));
}
