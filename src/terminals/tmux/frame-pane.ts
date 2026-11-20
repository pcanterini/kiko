// What the classic look's frame pane runs (./classic.ts, ./window.ts): the Kiko window's bottom
// line, its last, under the boxes (no header: the boxes start on the window's first line); or
// (`caption`) the caption's box, your words while you dictate. `node frame-pane.ts <tmux> [caption]`:
// only those on its command line; its environment is the tmux server's, as any pane's (tmux finds
// its server and this pane from $TMUX and $TMUX_PANE, which it sets), and it reads no settings and
// no .env (it imports only ./window.ts and ./classic.ts, which don't).
//
// The lines come from the app (src/ui/window-frame.ts), rendered there, over a socket in the app's
// private run folder whose path the app keeps on the server (FRAME_SOCKET): as often as the app
// sends them (the waveform, many times a second), never through tmux. Each one connects, says what
// it is and its size (and again when that changes), and paints what it's sent. No app: the bottom
// line says so, and it looks for one again every second; a window with no app yet says it's starting.
//
// The frame also keeps the boxes where they go: it's the window's one tiled pane, so it's resized
// with the window, and it puts the boxes back then (window.ts place); the end of a drag of a box's
// border signals it the same way (window.ts dragKeys; tmux keeps them side by side during one:
// splitHook). It keeps where the bottom line's menu words start on the
// window (MENU_AT), for a click there (window.ts clickKey). It never keeps the keyboard: given it
// (a right-click), it hands it back to the box that had it.
//
// It ends when its terminal goes (./pane-life.ts), its pane looked at every second: it looks for
// an app every second, so nothing else would end it.
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { FRAME_SOCKET, MENU_AT } from "./classic.ts";
import { tieToTerminal } from "./pane-life.ts";
import { place, ROLE } from "./window.ts";
import { COMMAND, NAME } from "../../core/name.ts";

const [tmuxPath = "tmux", mode] = process.argv.slice(2);
const role: "frame" | "caption" = mode === "caption" ? "caption" : "frame";
const pane = process.env.TMUX_PANE ?? "";
const out = process.stdout;
const ESC = "\x1b[";
const LOOK_AGAIN_MS = 1000;
const PLACE_AFTER_MS = 60; // a resize comes in bursts: placed once it settles

/** tmux on this pane's server (-u: UTF-8 whatever the locale, or list-panes reads back as nothing: tmux.ts tmuxFlags): its output, or "" when it refuses. */
const tmux = (args: string[]) => new Promise<string>((resolve) => execFile(tmuxPath, ["-u", ...args], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : String(stdout))));
/** As tmux, a refusal rejected (for window.ts, which reads it). */
const tmuxOrFail = (args: string[]) => new Promise<string>((resolve, reject) => execFile(tmuxPath, ["-u", ...args], { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

// What it shows: the frame's line, or the caption's words; and whether an app has sent any.
let bottom = "";
let words: string[] = [];
let heard = false;
let menuAt = -1;
let socket: Socket | null = null;

const size = () => ({ cols: out.columns || 80, rows: out.rows || 24 });
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;

function paint(clear = false) {
  const { rows } = size();
  // Synchronized (tmux holds the screen until it's whole), no wrapping (a line too long for a moment, as the window shrinks, is cut).
  let s = `${ESC}?2026h${ESC}?7l${clear ? `${ESC}2J` : ""}`;
  if (role === "caption") {
    for (let i = 0; i < rows; i++) s += `${ESC}${i + 1};1H${ESC}2K${words[i] !== undefined ? ` ${ESC}37m${words[i]}${RESET}` : ""}`;
  } else {
    const line = socket && heard ? bottom : heard ? ` ${DIM}● ${NAME} isn't running · run ${COMMAND} to start it here${RESET}` : ` ${DIM}${NAME} is starting…${RESET}`;
    s += `${ESC}${rows};1H${ESC}2K${line}${RESET}`;
  }
  out.write(`${s}${ESC}?2026l`);
}

/** Says what this is and its size to the app. */
const hello = () => socket?.write(`${JSON.stringify({ role, pane, ...size() })}\n`);

/** What the app sent: a frame's lines, or a caption's words. Anything else is passed over. */
function take(line: string) {
  let m: { bottom?: unknown; menuAt?: unknown; lines?: unknown };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (role === "caption" && Array.isArray(m.lines)) words = m.lines.filter((l): l is string => typeof l === "string").map(plain);
  else if (role === "frame" && typeof m.bottom === "string") {
    bottom = colours(m.bottom);
    const at = typeof m.menuAt === "number" ? m.menuAt : -1;
    if (at !== menuAt) {
      menuAt = at;
      void tmux(["set-option", "-w", "-t", pane, MENU_AT, String(at)]);
    }
  } else return;
  heard = true;
  paint();
}

/** Text with its colours and nothing else: the app's lines may carry SGR, never another escape (a cursor move would paint over the boxes). */
const colours = (s: string) => s.replace(/\x1b(?!\[[0-9;:]*m)[^a-zA-Z]*[a-zA-Z]?|[\u0000-\u001a\u001c-\u001f\u007f]/g, "");
/** Plain text: no escape sequences or control characters at all (the caption's words). */
const plain = (s: string) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|[\u0000-\u001f\u007f-\u009f]/g, "");

/** Finds the app (FRAME_SOCKET) and connects, unless connected; lost, it paints that and looks again later. */
async function connect() {
  if (socket) return;
  const path = (await tmux(["show-options", "-gqv", FRAME_SOCKET])).trim();
  if (!path || socket) return;
  const s = createConnection(path);
  socket = s;
  let rest = "";
  s.setEncoding("utf8");
  s.on("connect", hello);
  s.on("data", (data: string) => {
    const lines = (rest + data).split("\n");
    rest = lines.pop() ?? "";
    if (rest.length > 1 << 20) rest = "";
    for (const l of lines) if (l) take(l);
  });
  s.on("error", () => {});
  s.on("close", () => {
    if (socket !== s) return;
    socket = null;
    words = [];
    paint();
    // A caption is the app's words while you talk: with the app gone (it quit or crashed mid-word), it goes too.
    if (role === "caption" && heard) void gone();
  });
}

/** The caption's pane closed (this program with it). */
async function gone() {
  await tmux(["kill-pane", "-t", pane]);
  tie.end(false);
}
// A caption no app ever spoke to (it quit as the caption was made): gone too, after a moment.
if (role === "caption") setTimeout(() => void (heard ? undefined : gone()), 5000).unref();

let placing: NodeJS.Timeout | null = null;
function resized() {
  paint(true);
  hello();
  if (role !== "frame") return;
  if (placing) clearTimeout(placing);
  placing = setTimeout(() => {
    placing = null;
    void place(tmuxOrFail).catch(() => {});
  }, PLACE_AFTER_MS);
}

/** Given the keyboard (a right-click on it): back to the box that had it, else the list. */
async function handBack() {
  // The window's panes: ID, whether it's the active one, its role.
  const panes = async () =>
    (await tmux(["list-panes", "-t", pane, "-F", `#{pane_id} #{pane_active} #{${ROLE}}`]))
      .trim()
      .split("\n")
      .map((l) => l.split(" "));
  if ((await panes()).find(([id]) => id === pane)?.[1] !== "1") return; // moved on already
  await tmux(["last-pane", "-t", pane]);
  const now = await panes();
  const active = now.find(([, a]) => a === "1");
  const list = now.find(([, , r]) => r === "list")?.[0];
  if (list && (!active || active[2] === "frame" || active[2] === "caption")) await tmux(["select-pane", "-t", list]);
}

// Ended with its terminal; the screen put back on the way out while there's one.
const tie = tieToTerminal({ restore: `${ESC}?1006l${ESC}?1000l${ESC}?1004l${ESC}?7h${ESC}?25h${ESC}?1049l`, pane: { tmux: tmuxPath, id: pane } });
// The terminal: the alternate screen, no cursor, nothing typed echoed; focus reports (to hand the
// keyboard back) and mouse reports (so tmux passes a right-click or the wheel here rather than
// opening its own menu or copy mode over the bottom line).
out.write(`${ESC}?1049h${ESC}?25l${ESC}?1004h${ESC}?1000h${ESC}?1006h`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => {
  if (data.includes("\x1b[I")) void handBack();
});
out.on("resize", resized);
process.on("SIGWINCH", resized);
process.on("SIGINT", () => tie.end(true));

paint(true);
void connect();
setInterval(() => void connect(), LOOK_AGAIN_MS);
if (role === "frame") setTimeout(() => void place(tmuxOrFail).catch(() => {}), 300);
