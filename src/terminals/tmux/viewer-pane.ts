// What a viewer pane runs (./window.ts `view`): an outside session's conversation, read-only and
// live, in the Kiko window's session area; or (`page`) Kiko's own page, its conversation with
// you, from the file the app keeps it in (core/page.ts). `node viewer-pane.ts <tmux> <file> [page]`:
// only those on its command line; its environment is the tmux server's, as any pane's, and it reads no settings
// and no .env (it imports only core/history.ts, the drawing in src/ui/viewer.ts, and ./window.ts's
// names, none of which do).
//
// The conversation: core/history.ts's watcher on the transcript, which reads its end once, then
// only what's added (never the whole file again), and keeps going whatever happens to the session:
// an ended one stays readable. The header (name, where, state, folder) and what Kiko said about
// it come from the app, which keeps them in this pane's VIEWER_INFO option; read every second, so
// the viewer needs nothing from the app to start and carries on if the app stops. tmux finds its
// server and this pane from $TMUX and $TMUX_PANE, which it sets.
//
// Keys and the wheel scroll (↑ ↓ PgUp PgDn Home End, the wheel through tmux: it passes mouse events
// to a program that asks for them); everything else typed here is ignored, Ctrl+C included. A drag
// never reaches it, nor a double or triple click as one: tmux selects the text and copies it, as
// in a pane whose program doesn't ask for the mouse (./window.ts selectKeys, by this pane's role).
//
// It ends when its terminal goes (./pane-life.ts): the look at its pane is the one that reads the
// info, its pane's pid asked first in the same run of tmux.
import { execFile } from "node:child_process";
import { HistoryWatcher, JsonlWatcher } from "../../core/history.ts";
import { ConversationView, inputs, PageFolder, parseInfo } from "../../ui/viewer.ts";
import { LOOK_EVERY_MS, paneLook, tieToTerminal } from "./pane-life.ts";
import { VIEWER_INFO } from "./window.ts";

const [tmux, path, mode] = process.argv.slice(2);
const page = mode === "page";
const pane = process.env.TMUX_PANE ?? "";
const out = process.stdout;
const CLOCK_EVERY_MS = 30_000; // "last active 3 min ago"

const view = new ConversationView(Date.now, page ? "page" : "session");
let lastInfo = "";
let drawing: NodeJS.Immediate | null = null;

function draw() {
  drawing = null;
  const lines = view.frame(out.columns || 80, out.rows || 24);
  // Synchronized (?2026): the terminal shows the frame whole, never half drawn.
  out.write(`\x1b[?2026h\x1b[H${lines.map((l) => `${l}\x1b[K`).join("\r\n")}\x1b[J\x1b[?2026l`);
}
const redraw = () => void (drawing ??= setImmediate(draw));

/** Every second: its pane still there (else it ends, as `tie` decides), and the info the app keeps on the pane. */
function look() {
  if (!pane) return;
  // Its pane's program first (still this one?), then the info; tmux runs both, in order.
  const args = ["-u", "display-message", "-p", "-t", pane, "#{pane_pid}", ";", "show-options", "-p", "-v", "-t", pane, VIEWER_INFO];
  execFile(tmux, args, { timeout: 2000 }, (_err, stdout, stderr) => {
    const { gone, info: text } = paneLook(String(stdout), String(stderr), tie.own);
    tie.looked(gone);
    if (text === null || text === lastInfo) return;
    lastInfo = text;
    const info = parseInfo(text);
    if (info) {
      view.setInfo(info);
      redraw();
    }
  });
}

// Ended with its terminal; the screen put back on the way out while there's one (./pane-life.ts).
const tie = tieToTerminal({ restore: "\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l" });
// The alternate screen (nothing left behind), no cursor, the mouse's buttons and wheel (SGR).
out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data: string) => {
  const got = inputs(data);
  for (const i of got) view.input(i);
  if (got.length) redraw();
});
out.on("resize", redraw);
for (const signal of ["SIGINT", "SIGQUIT", "SIGTSTP"] as const) process.on(signal, () => {});

look();
setInterval(look, LOOK_EVERY_MS);
setInterval(redraw, CLOCK_EVERY_MS);
if (page) {
  new JsonlWatcher(
    path,
    () => new PageFolder(),
    (kept) => {
      view.setPage(kept);
      redraw();
    },
  );
} else {
  new HistoryWatcher(path, (history) => {
    view.setHistory(history);
    redraw();
  });
}
redraw();
