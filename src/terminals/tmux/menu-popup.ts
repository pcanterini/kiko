// What a Kiko window menu's popup runs (./window.ts menuPopup): `node menu-popup.ts <tmux> <option>`,
// only those on its command line. It reads the menu the app left in the window's <option> (JSON:
// src/ui/menu-view.ts MenuData), draws it, and on a key or a click runs the picked item's tmux
// commands (ask the app, move the keyboard, detach a terminal), each as its own argv: no shell, no
// tmux parser, no formats. Then it ends, and tmux closes the popup. Imports only the drawing and
// tmux names, nothing that loads .env, reads settings or writes logs; tmux finds its server from
// $TMUX, which it sets in a popup (and a command run from here without a target terminal goes to
// the one the popup is on: the one used last). It ends with its terminal (./pane-life.ts), as the
// panes' programs do; a popup has no pane of its own to look at.
import { execFile } from "node:child_process";
import { forFocus, MenuView, type MenuData, type Picked } from "../../ui/menu-view.ts";
import { WINDOW } from "./tmux.ts";
import { tieToTerminal } from "./pane-life.ts";
import { ROLE } from "./window.ts";

const [tmux, option] = process.argv.slice(2);
const out = process.stdout;
const run = (args: string[]) => new Promise<string>((resolve) => execFile(tmux, ["-u", ...args], { timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout)));

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** One key: an escape sequence (CSI, SS3) whole, Alt with a key (Escape first: the Kiko key may be one), a lone Escape, or one character. */
const KEYS = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[^[O\x1b]|[\s\S]/gu;

/** A `twice` hint's time (Quit's "Press q again to quit"): when it runs out, the menu drawn again. */
let lapsing: ReturnType<typeof setTimeout> | undefined;

function draw(view: MenuView) {
  const lines = view.frame(out.columns || 30, out.rows || 10);
  out.write(`\x1b[?2026h\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J\x1b[?2026l`);
  clearTimeout(lapsing);
  const until = view.againUntil;
  if (until !== null) lapsing = setTimeout(() => (view.lapse(), draw(view)), Math.max(0, until - Date.now()) + 5);
}

async function act(picked: Picked) {
  if (picked.kind === "none") return false;
  if (picked.kind === "run") for (const command of picked.commands) await run(command);
  return true;
}

async function main() {
  // tmux sets TMUX in a popup (its server's socket): without it, this would reach some other server.
  if (!process.env.TMUX) return;
  let menu: MenuData;
  try {
    menu = JSON.parse(await run(["show-options", "-w", "-v", "-t", `=${WINDOW}:`, option]));
  } catch {
    return;
  }
  // Words that depend on where the keyboard is (Tab's "Go to the session →" or "Go to the list ←"):
  // the window's active pane, asked now, as it opens (a popup doesn't move it). Not known: as they are.
  if (menu.items.some((i) => i !== "-" && i.byFocus)) {
    // Its ID too: a session's pane has no role, so "" alone would be that or no answer.
    const [pane, role] = (await run(["display", "-p", "-t", `=${WINDOW}:`, `#{pane_id} #{${ROLE}}`])).trim().split(" ");
    menu = forFocus(menu, !pane?.startsWith("%") ? null : role === "list");
  }
  const view = new MenuView(menu);
  // No cursor, the mouse's buttons (SGR), and nothing typed echoed.
  out.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  draw(view);
  let busy = false;
  process.stdin.on("data", async (data: string) => {
    if (busy) return;
    // Clicks first (a press picks; its release does nothing), then a key.
    const clicks = [...data.matchAll(SGR_MOUSE)];
    const rest = data.replace(SGR_MOUSE, "");
    const picks = clicks.filter((m) => m[4] === "M" && (Number(m[1]) & ~0x1c) === 0).map((m) => view.click(Number(m[2]), Number(m[3])));
    // Keys typed quickly arrive together ("2" right after the Kiko key, ↓ then Enter): one at a time, an escape sequence whole.
    for (const [k] of rest.matchAll(KEYS)) picks.push(view.key(k));
    for (const picked of picks) {
      busy = true;
      if (await act(picked)) process.exit(0);
      busy = false;
    }
    draw(view);
  });
  out.on("resize", () => draw(view));
}

for (const signal of ["SIGINT", "SIGQUIT", "SIGTSTP"] as const) process.on(signal, () => {});
tieToTerminal({ restore: "\x1b[?1006l\x1b[?1000l\x1b[?25h" });
void main();
