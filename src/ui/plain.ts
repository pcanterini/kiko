// Plain scrolling text instead of the window's list: the app with --plain, which only the faked-app harness (tests/harness) runs.
import { flat } from "../core/text.ts";
import { ui, type Line } from "../core/ui-store.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function format(line: Line) {
  switch (line.kind) {
    case "you":
      return `you:    ${line.text}`;
    case "session":
      return `\n${line.name}: ${dim(flat(line.text, 160))}`;
    case "permission":
      return `\n${line.name}: ${yellow(`wants to ${line.text}`)}`;
    case "spoken":
      return `claude: ${line.text}`;
    case "voice":
      return `voice:  ${line.text}`;
    case "task":
      return yellow(`check:  ${line.text}`);
    case "info":
      return dim(`        ${line.text}`);
    case "error":
      return red(line.text);
  }
}

const clearLine = () => process.stdout.write("\r\x1b[2K");

export function startPlain() {
  let listening = false;
  ui.on("line", (line: Line) => {
    if (listening) clearLine();
    console.log(format(line));
  });
  ui.on("timing", (text: string) => console.log(dim(`        ⏱ ${text}`)));
  ui.on("change", (state) => {
    if (state.listening && !listening) process.stdout.write("\n🎙  listening…");
    if (!state.listening && listening) clearLine();
    listening = state.listening;
  });
  ui.on("interim", (text: string) => {
    if (!listening) return;
    clearLine();
    // One line only: wrapped text can't be cleared in place, so long dictation would pile up
    // copies of itself. Show the end of what you're saying.
    const room = (process.stdout.columns || 80) - 5; // "🎙  " takes 4 columns
    const shown = text.length > room ? `…${text.slice(-(room - 1))}` : text;
    process.stdout.write(`🎙  ${shown || "listening…"}`);
  });
}
