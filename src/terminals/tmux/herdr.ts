// `kiko` run inside herdr (a terminal workspace manager for coding agents: HERDR_ENV=1,
// TERM_PROGRAM=herdr in its panes). Two things to see to:
//
// - **Its variables stay outside.** herdr marks each of its panes with HERDR_ENV, HERDR_PANE_ID,
//   HERDR_TAB_ID, HERDR_WORKSPACE_ID and HERDR_SOCKET_PATH, and herdr's own Claude Code hooks report
//   to the pane they name. Carried into Kiko's tmux, every session there would report against
//   the herdr pane `kiko` ran in (herdr issues #2134 and #2135). So none of HERDR_* reaches
//   Kiko's tmux server, the app, or a session (tmux.ts cleanEnv and withoutTerminal), and
//   `kiko` unsets them in the server's global environment too (HERDR_VARS, window.ts).
// - **Right-clicks.** herdr takes the right mouse button for itself by default; the Kiko window
//   uses it for a session's menu. `herdr pane input --current --right-click pane` gives this pane's
//   right-clicks to the program in it, and `kiko` runs it once as it starts there; a herdr
//   without it is told about once (rightClickHelp).
// Imports nothing that loads .env, reads settings or writes logs: the CLI uses it.
import { execFile } from "node:child_process";
import { NAME } from "../../core/name.ts";

/** Runs a program: its output, or null when it failed (not there, an error, too slow). Never a shell. */
export type Run = (program: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string | null>;
const runProgram: Run = (program, args, env) => new Promise((resolve) => execFile(program, args, { env: env ?? process.env, timeout: 3000 }, (err, out) => resolve(err ? null : String(out))));

/** The variables herdr sets in its panes, by name; any other HERDR_* is left out the same way (withoutTerminal). */
export const HERDR_VARS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"] as const;

/** Whether a variable is herdr's. */
export const isHerdrVar = (name: string) => name.startsWith("HERDR_");

/** `env` without herdr's variables. */
export const withoutHerdr = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !isHerdrVar(k)));

/** What `kiko` runs in herdr so right-clicks reach the window. */
export const RIGHT_CLICK_ARGS = ["pane", "input", "--current", "--right-click", "pane"];

/** How to get right-clicks through by hand, said once when herdr wouldn't do it. */
export const rightClickHelp = () =>
  `herdr keeps right-clicks for itself here, so ${NAME}'s right-click menus won't open. Update herdr and run herdr pane input --current --right-click pane, or hold herdr's passthrough key (ui.right_click_passthrough_modifier) as you right-click.`;

/**
 * Asks herdr (on PATH, with this shell's environment, which says which pane this is) to pass this
 * pane's right-clicks to the program in it: "ok", or "failed" (herdr refused, isn't on PATH, or is
 * too old to have it).
 */
export async function rightClickToPane(env: NodeJS.ProcessEnv, exec: Run = runProgram): Promise<"ok" | "failed"> {
  const out = await exec("herdr", RIGHT_CLICK_ARGS, env);
  return out === null ? "failed" : "ok";
}
