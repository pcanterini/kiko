// A step that changes while you watch, in @clack/prompts' look (first-run setup: ui/onboarding.ts):
// the mic's level as you talk, "press the talk key now", waiting for a permission. Clack's own
// spinner can't be used there: it reads process.stdin whatever terminal setup reads (`curl … | sh`
// has the script on it) and ends the process on Esc. This draws on the same left rail, redrawn in
// place, and reads keys from the terminal setup was given:
//
//   │
//   ◒  Say something…  ▁▂▅▇▆▃▁
//   │  heard: “hello there”
//   │  esc skip
//   └
//
// then, once it ends, one line that stays (◇ done, ▲ a warning, ■ skipped), as Clack's prompts leave theirs.
import { emitKeypressEvents, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { S_BAR, S_BAR_END, S_STEP_CANCEL, S_STEP_ERROR, S_STEP_SUBMIT, unicode } from "@clack/prompts";

/** Where setup draws and reads keys: the terminal (or a test's streams). */
export type Io = { input: Readable; output: Writable };

/** A key as readline gives it: Esc is `escape`, Ctrl+C `c` with `ctrl`. */
export type Key = { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string };

const FRAMES = unicode ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"];
const FRAME_MS = 120;

type TtyIn = Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => void };

/**
 * How long an Esc waits for the rest of a longer key (an arrow's `\x1b[B`) before it's Esc: Clack's
 * own readline waits 50 ms. The first to decode a stream's keys decides for every reader after it,
 * Clack's prompts included, and Node's default is half a second: setup called it first without one,
 * so Esc took 500 ms to skip a step.
 */
export const ESCAPE_MS = 50;

/** `input`'s keys decoded into `keypress` events (once a stream; later calls keep the first's wait), an Esc after ESCAPE_MS. */
export function decodeKeys(input: Readable) {
  emitKeypressEvents(input, { escapeCodeTimeout: ESCAPE_MS } as unknown as Interface);
}

/**
 * Raw keys from `input` to `onKey` until the returned function is called (then paused; left raw, so
 * keys typed before the next step are neither echoed nor lost: setup turns raw mode off as it ends).
 */
function readKeys(input: Readable, onKey: (str: string | undefined, key: Key) => void): () => void {
  const tty = input as TtyIn;
  decodeKeys(input);
  if (tty.isTTY) tty.setRawMode?.(true);
  const listener = (str: string | undefined, key: Key | undefined) => onKey(str, key ?? {});
  input.on("keypress", listener);
  input.resume();
  return () => {
    input.off("keypress", listener);
    input.pause();
  };
}

/** `text` in lines of at most `width` characters, broken between words where it can. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      for (let w = word; ; ) {
        const next = line ? `${line} ${w}` : w;
        if (next.length <= width) {
          line = next;
          break;
        }
        if (line) {
          out.push(line);
          line = "";
          continue;
        }
        // One word longer than the line: cut.
        out.push(w.slice(0, width));
        w = w.slice(width);
        if (!w) break;
      }
    }
    out.push(line);
  }
  return out;
}

type LiveEnd = "done" | "warn" | "skip";

export type Live = {
  /** What it shows now: its line, the lines under it, and its keys (dim, at the bottom). */
  show(title: string, lines?: string[], hint?: string): void;
  /** Ends it: the step's line as it stays (◇ done, ▲ a warning, ■ skipped), with any lines under it. */
  end(how: LiveEnd, title: string, lines?: string[]): void;
};

/**
 * A live step on the rail, its symbol spinning while it lasts. `onKey`: the keys pressed meanwhile
 * (none read without it, so Ctrl+C then stops the process as usual).
 */
export function live(io: Io, onKey?: (str: string | undefined, key: Key) => void): Live {
  const { output } = io;
  const columns = () => Math.max(20, ((output as Writable & { columns?: number }).columns ?? 80) - 1);
  let rows = 0;
  let frame = 0;
  let now: { title: string; lines: string[]; hint: string } = { title: "", lines: [], hint: "" };
  let ended = false;
  const bar = styleText("gray", S_BAR);
  const cyanBar = styleText("cyan", S_BAR);
  const erase = () => {
    if (rows) output.write(`\x1b[${rows}A\r\x1b[J`);
    rows = 0;
  };
  const block = (symbol: string, rail: string, title: string, lines: string[]) => {
    const width = columns() - 3;
    const out = [bar];
    wrap(title, width).forEach((l, i) => out.push(`${i ? rail : symbol}  ${l}`));
    for (const line of lines) for (const l of wrap(line, width)) out.push(`${rail}  ${l}`);
    return out;
  };
  const draw = () => {
    if (ended) return;
    erase();
    const out = block(styleText("magenta", FRAMES[frame % FRAMES.length]), cyanBar, now.title, now.lines);
    if (now.hint) out.push(`${cyanBar}  ${styleText("dim", now.hint)}`);
    out.push(styleText("cyan", S_BAR_END));
    output.write(`${out.join("\n")}\n`);
    rows = out.length;
  };
  output.write("\x1b[?25l");
  const timer = setInterval(() => {
    frame++;
    draw();
  }, FRAME_MS);
  const stopKeys = onKey ? readKeys(io.input, onKey) : () => {};
  return {
    show(title, lines = [], hint = "") {
      now = { title, lines, hint };
      draw();
    },
    end(how, title, lines = []) {
      if (ended) return;
      clearInterval(timer);
      stopKeys();
      erase();
      ended = true;
      const symbol = how === "done" ? styleText("green", S_STEP_SUBMIT) : how === "warn" ? styleText("yellow", S_STEP_ERROR) : styleText("red", S_STEP_CANCEL);
      output.write(`${block(symbol, bar, title, lines).join("\n")}\n\x1b[?25h`);
    },
  };
}
