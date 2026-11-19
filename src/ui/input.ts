// What the app in the Kiko window's list reads before Ink does: the asks the window's menus send
// it (src/terminals/tmux/window.ts askApp: ESC _ kiko;<token>;<verb>;<arg> ESC \), and the mouse
// (SGR reports: once the list asks for them, tmux passes a click on it to the app, after moving
// the keyboard there), and focus reports (ESC [ I and ESC [ O, as tmux gives the keyboard to the
// list's pane or takes it away: the classic look's list draws its cursor row by them), and a key's
// release (the kitty keyboard protocol's, ESC [ 109 ; 1 : 3 u for m let go: a terminal told to
// report key events sends one after each press, and tmux passes it on to the pane untouched; Ink
// gives it to useInput as the key again, so one tap of m muted and unmuted). Everything
// else goes on to Ink as typed, a key held down's repeats too. An ask without this run's token (a
// paste, a program printing one) is dropped, as is any other APC string: none of it reaches Ink,
// none of it acts.
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { log } from "../core/log.ts";
import { SLUG } from "../core/name.ts";

/** This run's own: in every ask the app's menus send it, and nowhere else. */
export const TOKEN = randomBytes(8).toString("hex");

/** Mouse reports on (button presses and releases, the wheel; SGR's form), and focus reports; and off again. */
export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h\x1b[?1004h";
export const MOUSE_OFF = "\x1b[?1004l\x1b[?1006l\x1b[?1000l";

export type Ask = { verb: string; arg: string };
type Button = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "other";
/** A click or the wheel, at column `x` and row `y` of the pane (1-based, as the terminal counts). */
export type Pointer = { x: number; y: number; button: Button; press: boolean };

/** `focus`: the pane's focus reports, in order (true: it has the keyboard now). `released`: how many keys' releases were dropped. */
export type Taken = { keys: string; asks: Ask[]; pointers: Pointer[]; focus: boolean[]; released: number; rest: string };

const APC = "\x1b_";
const ST = "\x1b\\";
const MAX_APC = 512; // longer, and it's no ask of ours: dropped
const SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
// A key let go, in the kitty keyboard protocol: CSI code[:shifted[:base]] ; modifiers:3 [; text] u,
// or the arrows' and the like's CSI number ; modifiers:3 letter-or-~ (event type 3: 1 is a press, 2 a repeat).
const RELEASE = /^\x1b\[[\d:]*;\d*:3(?:;[\d:]*)?[u~A-Za-z]/;
const SGR_START = /^\x1b(?:\[(?:<[\d;]*|[\d:;]*))?$/; // a report or a key cut off at the chunk's end
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

function button(code: number): Button {
  if (code & 64) return (code & 3) === 0 ? "wheelUp" : (code & 3) === 1 ? "wheelDown" : "other";
  if (code & 32) return "other"; // motion
  return (["left", "middle", "right", "other"] as const)[code & 3];
}

/**
 * Splits what the terminal sent: asks carrying `token`, mouse and focus reports out, keys' releases
 * dropped, the rest (`keys`) for Ink as it came. `rest`: an ask or report cut off at the end, to go in front of the next chunk.
 */
export function take(data: string, token: string): Taken {
  const out: Taken = { keys: "", asks: [], pointers: [], focus: [], released: 0, rest: "" };
  let i = 0;
  while (i < data.length) {
    const esc = data.indexOf("\x1b", i);
    if (esc < 0) {
      out.keys += data.slice(i);
      break;
    }
    out.keys += data.slice(i, esc);
    i = esc;
    const left = data.slice(i);
    if (left.startsWith(APC)) {
      const end = left.indexOf(ST);
      if (end < 0) {
        if (left.length < MAX_APC) out.rest = left;
        else i += left.length; // no end in sight: none of ours
        if (out.rest) break;
        continue;
      }
      const body = left.slice(2, end).split(";");
      if (body.length === 4 && body[0] === SLUG && body[1] === token && body[2]) out.asks.push({ verb: body[2], arg: body[3] });
      i += end + ST.length;
      continue;
    }
    if (left.startsWith(FOCUS_IN) || left.startsWith(FOCUS_OUT)) {
      out.focus.push(left.startsWith(FOCUS_IN));
      i += FOCUS_IN.length;
      continue;
    }
    const m = SGR.exec(left);
    if (m) {
      out.pointers.push({ x: Number(m[2]), y: Number(m[3]), button: button(Number(m[1])), press: m[4] === "M" });
      i += m[0].length;
      continue;
    }
    const released = RELEASE.exec(left);
    if (released) {
      out.released++;
      i += released[0].length; // the press acted already
      continue;
    }
    if (SGR_START.test(left) || APC.startsWith(left)) {
      out.rest = left;
      break;
    }
    // Any other escape sequence (a key): Ink's.
    out.keys += "\x1b";
    i++;
  }
  return out;
}

/** What the list's input carries besides keys: "ask" (Ask), "pointer" (Pointer), "focus" (true: the keyboard is the list's now). */
export const windowEvents = new EventEmitter();

type TtyIn = NodeJS.ReadStream;
type InkInput = PassThrough & { isTTY: boolean; setRawMode(on: boolean): InkInput; ref(): InkInput; unref(): InkInput };

/** How long a cut-off sequence waits for its end before it goes to Ink as typed (a lone Escape). */
const REST_MS = 40;

/**
 * The stream Ink reads instead of `stdin` (a terminal): what `take` leaves of it. Raw mode and the
 * like go through to the terminal. Asks and pointers are emitted on `events`.
 */
export function inkInput(stdin: TtyIn = process.stdin, token = TOKEN, events = windowEvents): InkInput {
  const stream = new PassThrough() as InkInput;
  stream.isTTY = true;
  stream.setRawMode = (on: boolean) => {
    stdin.setRawMode?.(on);
    return stream;
  };
  stream.ref = () => (stdin.ref(), stream);
  stream.unref = () => (stdin.unref(), stream);
  let rest = "";
  let releasesSeen = false;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (rest) stream.write(rest);
    rest = "";
  };
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const got = take(rest + chunk, token);
    rest = got.rest;
    if (got.keys) stream.write(got.keys);
    // Once a run, in the log: the terminal reports keys let go (never which).
    if (got.released && !releasesSeen) {
      releasesSeen = true;
      log("key_releases_dropped");
    }
    for (const a of got.asks) events.emit("ask", a);
    for (const p of got.pointers) events.emit("pointer", p);
    for (const f of got.focus) events.emit("focus", f);
    if (rest) timer = setTimeout(flush, REST_MS);
  });
  stdin.on("end", () => stream.end());
  return stream;
}
