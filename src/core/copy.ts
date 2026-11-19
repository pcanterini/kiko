// The one copy Kiko makes to the clipboard, and only when you pick it: Settings → Account's "Copy the
// code", while a sign-in's one-time code shows (the window takes the mouse, so the code can't be
// selected there). Nothing else in Kiko writes to the clipboard or reads it (a rule: never the
// clipboard): tests/unit/terminals/no-clipboard.test.ts allows this file's one line, and only
// app/settings/account.ts may use it.
import { spawn } from "node:child_process";

// macOS's own copy command; the text goes on its stdin, never in its command line.
const COPY_PROGRAM = "pbcopy";

/** What runs the copy: macOS's command by default, or a test's program (one that never reaches the clipboard). */
export type CopyDeps = { program?: string; args?: string[]; timeoutMs?: number };

/** `text` copied (given on stdin): true once it's there, false when it couldn't be. Never throws. */
export function copyText(text: string, deps: CopyDeps = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(deps.program ?? COPY_PROGRAM, deps.args ?? [], { stdio: ["pipe", "ignore", "ignore"], timeout: deps.timeoutMs ?? 5000 });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      // A program that exits before reading its input: the write's error is the close's to say.
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}
